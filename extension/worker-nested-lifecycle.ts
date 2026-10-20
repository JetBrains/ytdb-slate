import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { sanitizeForNotify } from "./notify.ts";

export const NESTED_SETTLEMENT_WARNING_MS = 5000;
export const NESTED_SETTLEMENT_WARNING_PREFIX = "slate: nested tool call has not reported its end — ";
export const WORKER_NESTED_CLOSED_REASON = "Slate worker tool admission is closed.";

/** Own nested admission and terminal evidence for one worker session. */
export function createWorkerNestedLifecycle(warn: (message: string) => void, warningMs = NESTED_SETTLEMENT_WARNING_MS) {
	let open = true;
	const calls = new Map<string, { unadmitted: number; admitted: number; name: string }>();
	let pending = 0;
	let resolveJoin: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const extension: ExtensionFactory = (pi) => {
		pi.on("tool_execution_start", (event) => {
			if (typeof event.parentToolCallId !== "string") return;
			const entry = calls.get(event.toolCallId);
			if (entry) entry.unadmitted++;
			else calls.set(event.toolCallId, { unadmitted: 1, admitted: 0, name: event.toolName });
		});
		pi.on("tool_call", (event) => {
			if (!open) return { block: true, reason: WORKER_NESTED_CLOSED_REASON };
			const entry = calls.get(event.toolCallId);
			if (entry && entry.unadmitted > 0) {
				entry.unadmitted--;
				entry.admitted++;
				pending++;
			}
			return undefined;
		});
		pi.on("tool_execution_end", (event) => {
			if (typeof event.parentToolCallId !== "string") return;
			const entry = calls.get(event.toolCallId);
			if (!entry) return;
			if (entry.unadmitted > 0) entry.unadmitted--;
			else if (entry.admitted > 0) { entry.admitted--; pending--; }
			if (entry.unadmitted + entry.admitted === 0) calls.delete(event.toolCallId);
			if (pending === 0) resolveJoin?.();
		});
	};
	return {
		extension,
		close() { open = false; },
		startWarning() {
			timer = setTimeout(() => {
				if (pending === 0) return;
				const names = [...calls].filter(([, entry]) => entry.admitted > 0).map(([id, entry]) =>
					`identifier "${sanitizeForNotify(id)}", tool "${sanitizeForNotify(entry.name)}", count ${entry.admitted}`);
				warn(`${NESTED_SETTLEMENT_WARNING_PREFIX}${names.join(" | ")}. Settlement is still waiting.`);
			}, warningMs);
		},
		join(): Promise<void> {
			return pending === 0 ? Promise.resolve() : new Promise(resolve => { resolveJoin = resolve; });
		},
		clearWarning() { clearTimeout(timer); },
	};
}
