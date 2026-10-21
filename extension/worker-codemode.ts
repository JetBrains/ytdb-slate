import { open } from "node:fs/promises";
import { createCodemodeExtension, type ToolDefinition, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { SLATE_TOOL_NAMES } from "./worker-extensions.ts";

export const WORKER_CODEMODE_COMPONENT_NAME = "slate-worker-codemode";
const OWNED_SOURCE = `<inline:${WORKER_CODEMODE_COMPONENT_NAME}>`;

export const CODEMODE_LIMIT_TEXT = "Script error:\nScript sandbox failed: Codemode worker limit reached (2 workers are still running or shutting down). Retry after they exit.\n\nNo tool calls were made.";
export const CODEMODE_WAIT_TEXT = "The codemode script limit is reached. Call the tools without codemode. Issue independent tool calls together in one turn.";
type Execute = ToolDefinition<any, any>["execute"];
type Result = Awaited<ReturnType<Execute>>;

export async function readFullError(path: string): Promise<string | undefined> {
	const handle = await open(path, "r");
	try {
		const size = (await handle.stat()).size;
		if (size > 512) return undefined;
		const buffer = Buffer.alloc(512);
		const { bytesRead } = await handle.read(buffer, 0, 512, 0);
		if (bytesRead !== size || (await handle.stat()).size !== size) return undefined;
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally { await handle.close(); }
}

export interface CodemodeQueueClock {
	now(): number;
	schedule(callback: () => void, ms: number): () => void;
	readFullError(path: string): Promise<string | undefined>;
}
const realClock: CodemodeQueueClock = {
	now: () => performance.now(),
	schedule(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
	readFullError,
};

/** Two wrapper reservations per loaded module. Pi owns the actual worker limit. */
export function createCodemodeQueue(clock: CodemodeQueueClock = realClock) {
	type Entry = { grant(): void };
	const waiting: Entry[] = [];
	let held = 0;
	const error = (text: string): Result => ({ isError: true, content: [{ type: "text", text }], details: { calls: [] } });
	function drain() {
		while (held < 2 && waiting.length > 0) {
			const entry = waiting.shift()!;
			entry.grant();
		}
	}
	return {
		async run(execute: Execute, args: Parameters<Execute>, closeSignal?: AbortSignal): Promise<Result> {
			const signals = [args[2], closeSignal].filter((signal): signal is AbortSignal => signal !== undefined);
			const stopped = () => signals.some(signal => signal.aborted);
			if (stopped()) return error("Operation aborted");
			const deadline = clock.now() + 60_000;
			let reserved = false;
			let wake: (() => void) | undefined;
			let cancelTimer: (() => void) | undefined;
			let phase: "queue" | "running" | "wait" = "queue";
			let resolveGrant!: () => void;
			const granted = new Promise<void>(resolve => { resolveGrant = resolve; });
			const release = () => {
				if (!reserved) return;
				reserved = false;
				held--;
				drain();
			};
			const entry: Entry = { grant() {
				if (!stopped() && clock.now() < deadline) { reserved = true; held++; }
				resolveGrant();
			} };
			const stopWait = () => {
				if (phase === "running") return;
				const index = waiting.indexOf(entry);
				if (index >= 0) waiting.splice(index, 1);
				cancelTimer?.();
				release();
				resolveGrant();
				wake?.();
			};
			for (const signal of signals) signal.addEventListener("abort", stopWait);
			waiting.push(entry);
			cancelTimer = clock.schedule(stopWait, 60_000);
			drain();
			try {
				await granted;
				cancelTimer();
				while (true) {
					if (stopped()) return error("Operation aborted");
					if (!reserved || clock.now() >= deadline) return error(CODEMODE_WAIT_TEXT);
					phase = "running";
					const result = await execute(...args);
					const details = result.details as { calls?: unknown; fullOutputPath?: unknown } | undefined;
					const last = result.content.at(-1);
					if (result.isError !== true || !Array.isArray(details?.calls) || details.calls.length !== 0 || last?.type !== "text") return result;
					let text: string | undefined = last.text;
					if (text.startsWith("Warning: truncated output")) {
						if (typeof details.fullOutputPath !== "string") return result;
						try { text = await clock.readFullError(details.fullOutputPath); }
						catch { return result; }
					}
					if (text !== CODEMODE_LIMIT_TEXT) return result;
					if (stopped()) return error("Operation aborted");
					if (clock.now() >= deadline) return error(CODEMODE_WAIT_TEXT);
					phase = "wait";
					await new Promise<void>(resolve => {
						wake = resolve;
						const remaining = deadline - clock.now();
						// A deadline timer ends waiting even if timer rounding fires it early.
						cancelTimer = clock.schedule(remaining <= 250 ? stopWait : resolve, Math.min(250, remaining));
					});
					cancelTimer();
					wake = undefined;
				}
			} finally {
				cancelTimer?.();
				for (const signal of signals) signal.removeEventListener("abort", stopWait);
				const index = waiting.indexOf(entry);
				if (index >= 0) waiting.splice(index, 1);
				release();
			}
		},
	};
}
const scriptQueue = createCodemodeQueue();

/** Internal worker component. It uses Pi's executor and public tool hooks. */
export function createWorkerCodemodeComponent(warn: (message: string) => void, closeSignal?: AbortSignal): ExtensionFactory {
	return (pi) => {
		createCodemodeExtension({ mode: "on", models: false })({ ...pi,
			registerTool(tool) {
				const execute = tool.execute;
				pi.registerTool({ ...tool, execute: (...args) => scriptQueue.run(execute, args, closeSignal) });
			},
		});
		pi.on("tool_call", (event) => {
			const nested = event.parentToolCallId !== undefined || event.toolCallId.startsWith("/");
			if (event.toolName === "codemode") {
				if (nested) return { block: true, reason: "Slate blocks nested codemode calls. Call tools from the current script." };
				const source = pi.getAllTools().find((tool) => tool.name === "codemode")?.sourceInfo.path;
				if (source !== OWNED_SOURCE) {
					const reason = "Slate blocked codemode because its registered tool is not owned by the worker component.";
					warn(`slate: ${reason}`);
					return { block: true, reason };
				}
			}
			if (!nested) return;
			if (SLATE_TOOL_NAMES.includes(event.toolName)) {
				return { block: true, reason: `Slate scripts cannot call the Slate tool "${event.toolName}".` };
			}
			if (!pi.getActiveTools().includes(event.toolName)) {
				return { block: true, reason: `Slate scripts cannot call inactive tool "${event.toolName}".` };
			}
			return undefined;
		});
	};
}
