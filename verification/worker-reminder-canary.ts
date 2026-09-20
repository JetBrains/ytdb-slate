import { writeFileSync } from "node:fs";
import {
	type AssistantMessage,
	type TranscriptContext,
	getCurrentTools,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = "slate-worker-reminder-test-api";
const PROVIDER = "slate-worker-reminder-fake";
const MODEL = "worker-reminder-model";
const EVIDENCE = process.env.SLATE_WORKER_REMINDER_EVIDENCE;
const PROJECT = process.env.SLATE_WORKER_REMINDER_PROJECT;
const WORKER_TASK = "WORKER_REMINDER_CANARY_ACTION_51c824";
const WORKER_SUCCESS = "WORKER_REMINDER_CONTINUATION_OK_51c824";
const HOST_SUCCESS = "WORKER_REMINDER_DISPATCH_OK_51c824";
const REMINDER_TYPE = "slate-worker-reminder";
const REMINDER_TEXT =
	"Reminder: ALL INDEPENDENT TOOL CALLS MUST be issued SIMULTANEOUSLY in ONE TURN. Use separate turns only when results depend on each other or conflict.";
const COMPRESSED_EPISODE = `## Intent
Complete the deterministic worker reminder canary action.

## Actions Taken
- Read both independent canary fixtures in one tool-bearing turn.

## Key Findings
- The worker reminder continuation completed.

## Artifacts Changed
None.

## Open Issues
None.`;

const evidence: { calls: Array<{ kind: string; ordinal: number; context: ReturnType<typeof snapshot> }>; registrations: { host: number; runtime: number; legacy: number }; expected: Record<string, string> } = { calls: [], registrations: { host: 0, runtime: 0, legacy: 0 }, expected: { API, PROVIDER, MODEL, WORKER_TASK, WORKER_SUCCESS, HOST_SUCCESS, REMINDER_TYPE, REMINDER_TEXT, COMPRESSED_EPISODE } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map((part) => part.text).join("\n");
}

function message(
	model: Model<any>,
	content: AssistantMessage["content"],
	stopReason: Exclude<AssistantMessage["stopReason"], "pending" | "error" | "aborted">,
	input = 100,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function completedStream(output: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...output, stopReason: "pending" } });
		stream.push({
			type: "done",
			reason: output.stopReason as Exclude<AssistantMessage["stopReason"], "pending" | "error" | "aborted">,
			message: output,
		});
		stream.end();
	});
	return stream;
}

function snapshot(context: TranscriptContext) {
	return {
		tools: getCurrentTools(context.messages).map((tool) => tool.name),
		messages: context.messages.map((item) => {
			const value = item as unknown as Record<string, unknown>;
			return {
				role: value.role,
				customType: value.customType,
				content: textOf(value.content),
				toolName: value.toolName,
				toolCallId: value.toolCallId,
				display: value.display,
			};
		}),
	};
}

function classify(context: TranscriptContext) {
	const texts = context.messages.map((item) => textOf(item?.content));
	const tools = getCurrentTools(context.messages).map((tool) => tool.name);
	if (texts.some((text) => text.includes("You are compressing one completed action of a worker thread"))) return "compressor";
	if (tools.includes("thread")) return "orchestrator";
	if (texts.some((text) => text.includes(WORKER_TASK))) return "worker";
	return "unknown";
}

function persist() {
	if (!EVIDENCE) throw new Error("SLATE_WORKER_REMINDER_EVIDENCE is required");
	writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
}

function fakeStream(model: Model<any>, context: TranscriptContext, _options?: SimpleStreamOptions) {
	const kind = classify(context);
	const prior = evidence.calls.filter((call) => call.kind === kind).length;
	evidence.calls.push({ kind, ordinal: prior + 1, context: snapshot(context) });
	persist();

	if (kind === "orchestrator" && prior === 0) {
		return completedStream(message(model, [{
			type: "toolCall",
			id: "worker-reminder-thread-call",
			name: "thread",
			arguments: {
				name: "worker-reminder-canary",
				type: "general",
				task: WORKER_TASK,
				model: "worker-reminder-canary",
				reason: "exercise the worker reminder path",
				tools: ["read"],
			},
		}], "toolUse"));
	}
	if (kind === "worker" && prior === 0) {
		return completedStream(message(model, [
			{ type: "toolCall", id: "worker-read-alpha", name: "read", arguments: { path: `${PROJECT}/alpha.txt` } },
			{ type: "toolCall", id: "worker-read-beta", name: "read", arguments: { path: `${PROJECT}/beta.txt` } },
		], "toolUse", 200));
	}
	if (kind === "worker" && prior === 1) {
		// The worker uses its own native ModelRuntime registration. Register the
		// legacy API only after that path completed, just before episode compression.
		// This keeps the native and legacy counterfactuals independent.
		if (evidence.registrations.legacy === 0) registerLegacyApi();
		return completedStream(message(model, [{ type: "text", text: WORKER_SUCCESS }], "stop", 220));
	}
	if (kind === "compressor" && prior === 0) {
		return completedStream(message(model, [{ type: "text", text: COMPRESSED_EPISODE }], "stop", 300));
	}
	if (kind === "orchestrator" && prior === 1) {
		return completedStream(message(model, [{ type: "text", text: HOST_SUCCESS }], "stop", 400));
	}
	return completedStream(message(model, [{ type: "text", text: `UNEXPECTED_${kind.toUpperCase()}_CALL_${prior + 1}` }], "stop", 500));
}

function registerLegacyApi() {
	registerApiProvider({ api: API, stream: fakeStream, streamSimple: fakeStream }, "slate-worker-reminder-canary");
	evidence.registrations.legacy += 1;
	persist();
}

const originalCreate = ModelRuntime.create;
const wrappedCreate = async function (...args: Parameters<typeof ModelRuntime.create>): Promise<ModelRuntime> {
	const runtime = await originalCreate.apply(ModelRuntime, args);
	runtime.registerProvider(PROVIDER, { api: API, streamSimple: fakeStream });
	evidence.registrations.runtime += 1;
	persist();
	return runtime;
};
let factoryOwned = true;
ModelRuntime.create = wrappedCreate;

export default function workerReminderCanary(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, { api: API, streamSimple: fakeStream });
	evidence.registrations.host += 1;
	persist();
	pi.on("session_shutdown", () => {
		if (factoryOwned && ModelRuntime.create === wrappedCreate) ModelRuntime.create = originalCreate;
		factoryOwned = false;
	});
}
