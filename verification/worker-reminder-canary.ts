import { writeFileSync } from "node:fs";
import {
	type AssistantMessage,
	type TranscriptContext,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = "slate-worker-reminder-test-api";
const PROVIDER = "slate-worker-reminder-fake";
const MODEL = "worker-reminder-model";
const EVIDENCE = process.env.SLATE_WORKER_REMINDER_EVIDENCE;
const PROJECT = process.env.SLATE_WORKER_REMINDER_PROJECT;
const WORKER_TASK = "WORKER_REMINDER_CANARY_ACTION_51c824";
const PROFILE = process.env.SLATE_WORKER_REMINDER_PROFILE ?? "normal";
const THRESHOLD = PROFILE === "threshold" || PROFILE === "handler" || PROFILE.startsWith("compact-");
const LENGTH_CADENCE = PROFILE === "length-cadence";
const OVERFLOW = PROFILE === "overflow" || PROFILE === "overflow-disabled" || PROFILE === "length" || LENGTH_CADENCE;
const INPUT_BUDGET = 3000;
const OVERFLOW_ERROR = "context_length_exceeded: canary request exceeds 3000 test tokens";
const QUEUED_GUIDANCE = "CANARY_EARLIER_GUIDANCE_51c824";
const HANDLER_GUIDANCE = "CANARY_COMPACTION_FOLLOW_UP_51c824";
const WORKER_SUCCESS = "WORKER_REMINDER_CONTINUATION_OK_51c824" + (THRESHOLD ? "\n" + "Saved final answer. ".repeat(36).trimEnd() : "");
const HANDLER_SUCCESS = WORKER_SUCCESS + "\nExact handler follow-up answer.";
const HOST_SUCCESS = "WORKER_REMINDER_DISPATCH_OK_51c824";
const REMINDER_TYPE = "slate-worker-reminder";
const REMINDER_TEXT =
	"Reminder: ALL INDEPENDENT TOOL CALLS MUST be issued SIMULTANEOUSLY in ONE TURN. Use separate turns only when results depend on each other or conflict. When codemode is available, use it to run independent tool calls together, chain dependent calls, or filter large output while keeping large intermediate data in script variables.";
function compressedEpisode(texts: string[]) {
	const markers = [PROFILE === "overflow-disabled" && !texts.some(text => text.includes(WORKER_SUCCESS))
		? OVERFLOW_ERROR : "WORKER_REMINDER_CONTINUATION_OK_51c824", "ALPHA_CANARY_RESULT", "BETA_CANARY_RESULT"];
	const findings = markers.flatMap(marker => {
		const input = texts.find(text => text.includes(marker));
		if (input === undefined) return [];
		const position = input.indexOf(marker);
		return ["- " + input.slice(position, position + marker.length)];
	}).join("\n");
	return `## Intent
Complete the deterministic worker reminder canary action.

## Actions Taken
- Read both independent canary fixtures in one tool-bearing turn.

## Key Findings
${findings}

## Artifacts Changed
None.

## Open Issues
None.`;
}

const evidence: { calls: Array<{ kind: string; ordinal: number; provider: string; model: string; context: ReturnType<typeof snapshot> }>; registrations: { host: number; runtime: number }; expected: Record<string, string> } = { calls: [], registrations: { host: 0, runtime: 0 }, expected: { API, PROVIDER, MODEL, WORKER_TASK, WORKER_SUCCESS, HOST_SUCCESS, REMINDER_TYPE, REMINDER_TEXT } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map((part) => part.text).join("\n");
}

function message(
	model: Model<any>,
	content: AssistantMessage["content"],
	stopReason: Exclude<AssistantMessage["stopReason"], "pending">,
	input = 100,
	output = 1,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
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
		const reason = output.stopReason;
		if (reason === "pending") throw new Error("Expected a completed response");
		if (reason === "error" || reason === "aborted") stream.push({ type: "error", reason, error: output });
		else stream.push({ type: "done", reason, message: output });
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
				bytes: Buffer.byteLength(JSON.stringify(item)),
			};
		}),
	};
}

function classify(context: TranscriptContext) {
	if (getCurrentSystemPrompt(context.messages)?.startsWith("You are a context summarization assistant.")) return "summary";
	const texts = context.messages.map((item) => textOf(item?.content));
	const tools = getCurrentTools(context.messages).map((tool) => tool.name);
	if (texts.some((text) => text.includes("You are compressing one completed action of a worker thread"))) return "compressor";
	if (tools.includes("thread")) return "orchestrator";
	if (texts.some((text) => text.includes(WORKER_TASK) || text === HANDLER_GUIDANCE || text.startsWith(REMINDER_TEXT) ||
		(OVERFLOW && text.startsWith("The conversation history before this point was compacted") && text.includes("WORKER_HISTORY_SUMMARY_51c824")))) return "worker";
	return "unknown";
}

function persist() {
	if (!EVIDENCE) throw new Error("SLATE_WORKER_REMINDER_EVIDENCE is required");
	writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
}

function fakeStream(model: Model<any>, context: TranscriptContext, _options?: SimpleStreamOptions) {
	const kind = classify(context);
	const prior = evidence.calls.filter((call) => call.kind === kind).length;
	const texts = context.messages.map(item => textOf(item.content));
	evidence.calls.push({ kind, ordinal: prior + 1, provider: model.provider, model: model.id, context: snapshot(context) });
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
	// Approximate tokens from the actual provider messages, not the run label.
	const tokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);
	const reply = (content: AssistantMessage["content"], stop: "toolUse" | "stop", normalInput: number) =>
		completedStream(message(model, content, stop, THRESHOLD ? tokens(context.messages) : normalInput, THRESHOLD ? tokens(content) : 1));
	if (kind === "summary") {
		if (PROFILE === "compact-fail") {
			return completedStream({ ...message(model, [], "error", 0, 0), errorMessage: "Canary summary refused." });
		}
		return reply([{ type: "text", text: "WORKER_HISTORY_SUMMARY_51c824" }], "stop", 100);
	}
	if (kind === "worker" && prior === 0) {
		return reply([
			{ type: "toolCall", id: "worker-read-alpha", name: "read", arguments: { path: `${PROJECT}/alpha.txt` } },
			{ type: "toolCall", id: "worker-read-beta", name: "read", arguments: { path: `${PROJECT}/beta.txt` } },
		], "toolUse", 200);
	}
	if (kind === "worker" && prior === 1) {
		return reply([
			{ type: "toolCall", id: "worker-read-again", name: "read", arguments: { path: `${PROJECT}/alpha.txt` } },
		], "toolUse", 210);
	}
	if (kind === "worker" && LENGTH_CADENCE) {
		if (prior === 2) {
			return completedStream(message(model, [{ type: "text", text: "CANARY_TRUNCATED_51c824" }], "length", tokens(context.messages), 3));
		}
		if (prior === 3 || prior === 4) {
			return reply([{ type: "toolCall", id: `worker-read-round-${prior + 1}`, name: "read", arguments: { path: `${PROJECT}/alpha.txt` } }], "toolUse", 220);
		}
		if (prior === 5) return reply([{ type: "text", text: WORKER_SUCCESS }], "stop", 220);
	}
	if (kind === "worker" && PROFILE === "default" && prior >= 2 && prior <= 5) {
		if (prior === 5) return reply([{ type: "text", text: WORKER_SUCCESS }], "stop", 220);
		return reply([{ type: "toolCall", id: `worker-read-round-${prior + 1}`, name: "read", arguments: { path: `${PROJECT}/alpha.txt` } }], "toolUse", 220);
	}
	if (kind === "worker" && prior >= 2 && OVERFLOW && !LENGTH_CADENCE) {
		const input = tokens(context.messages);
		if (input > INPUT_BUDGET) {
			if (PROFILE === "length") {
				return completedStream(message(model, [{ type: "text", text: "CANARY_TRUNCATED_51c824" }], "length", input, 3));
			}
			return completedStream({ ...message(model, [], "error", input, 0), errorMessage: OVERFLOW_ERROR });
		}
		return reply([{ type: "text", text: WORKER_SUCCESS }], "stop", input);
	}
	if (kind === "worker" && prior === 2 && PROFILE === "model" && texts.some(text => text.startsWith(REMINDER_TEXT + "\n\n"))) {
		return reply([{ type: "toolCall", id: "worker-read-extra", name: "read", arguments: { path: `${PROJECT}/beta.txt` } }], "toolUse", 220);
	}
	if (kind === "worker" && prior === 3 && PROFILE === "handler" && texts.includes(HANDLER_GUIDANCE)) {
		return reply([{ type: "text", text: HANDLER_SUCCESS }], "stop", 200);
	}
	if (kind === "worker" && ((prior === 3 && PROFILE === "model") ||
		(prior === 3 && PROFILE === "steer-one" && texts.includes(QUEUED_GUIDANCE)))) {
		return reply([{ type: "text", text: WORKER_SUCCESS }], "stop", 200);
	}
	if (kind === "worker" && prior === 2) {
		return reply([{ type: "text", text: WORKER_SUCCESS }], "stop", 220);
	}
	if (kind === "compressor" && prior === 0) {
		return completedStream(message(model, [{ type: "text", text: compressedEpisode(texts) }], "stop", 300));
	}
	if (kind === "orchestrator" && prior === 1) {
		return completedStream(message(model, [{ type: "text", text: HOST_SUCCESS }], "stop", 400));
	}
	return completedStream(message(model, [{ type: "text", text: `UNEXPECTED_${kind.toUpperCase()}_CALL_${prior + 1}` }], "stop", 500));
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
