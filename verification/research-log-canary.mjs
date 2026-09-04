/**
 * Track 15 — integrated research log canary.
 *
 * It registers one deterministic offline provider. Every provider call records
 * the system prompt it received, so the harness can prove that the orchestrator
 * doctrine AND a real worker system prompt carry the exact research log path of
 * this Slate session.
 *
 * On the dispatch turn the provider answers with one `thread` tool call, so
 * Slate opens a real worker session. That worker's own provider call is recorded
 * like every other call, which is how the harness sees the worker prompt.
 *
 * The provider performs no network operation. It answers one fixed text
 * otherwise, so each session finishes at once.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const EVIDENCE = process.env.SLATE_RESEARCH_LOG_EVIDENCE;
const COMPLETION = process.env.SLATE_RESEARCH_LOG_COMPLETION;
const LOG_MARKER = process.env.SLATE_RESEARCH_LOG_MARKER;
const ANSWER = "SLATE_RESEARCH_LOG_CANARY_ANSWER_4b91ad";
/** The harness sends this text on the turn that must dispatch a worker. */
const DISPATCH_REQUEST = "SLATE_RESEARCH_LOG_DISPATCH_REQUEST";
/** The first words of slate's worker preamble, which no orchestrator prompt has. */
const WORKER_MARKER = "You are a worker thread executing ONE bounded action";

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

function message(model, content) {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1000,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1001,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((part) => part?.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function completedStream(output) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...output, stopReason: "pending" } });
		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end();
	});
	return stream;
}

export default function researchLogCanary(pi) {
	// Slate's worker-extension resolver takes its candidates from the registered
	// TOOLS of each load unit, so this extension must register one tool to be
	// selectable by `workerExtensions`. A worker loads this unit, and the load
	// registers the offline provider inside the worker session too.
	pi.registerTool({
		name: "research_log_canary",
		label: "Research log integration canary",
		description: "Report that the research log integration canary is loaded.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "RESEARCH_LOG_CANARY_LOADED" }], details: { canary: true } };
		},
	});

	let calls = 0;
	let dispatched = false;
	let sessionMeta = {};

	pi.on("session_start", (_event, ctx) => {
		sessionMeta = { trusted: ctx.isProjectTrusted(), cwd: ctx.cwd };
	});

	pi.registerProvider("slate-research-log-fake", {
		name: "Slate research log offline canary",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "offline-canary-key",
		api: "openai-completions",
		models: [{
			id: "research-log-model",
			name: "Research log model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 1_024,
		}],
		streamSimple(model, context) {
			calls += 1;
			const systemPrompt = typeof context.systemPrompt === "string" ? context.systemPrompt : "";
			const userText = context.messages.filter((item) => item?.role === "user").map((item) => textOf(item.content));
			const toolResults = context.messages.filter((item) => item?.role === "toolResult");
			const worker = systemPrompt.includes(WORKER_MARKER);
			// One JSON record per provider call, orchestrator and worker alike. The
			// harness separates them by the `worker` flag.
			appendFileSync(EVIDENCE, `${JSON.stringify({
				...sessionMeta,
				calls,
				worker,
				pid: process.pid,
				systemPrompt,
				userText,
				toolResults: toolResults.map((item) => ({ toolName: item.toolName, isError: item.isError, text: textOf(item.content) })),
			})}\n`);
			if (worker && !toolResults.some((item) => item.toolName === "write")) {
				const path = /<<([^<>]+\/research-log\.md)>>/u.exec(systemPrompt)?.[1];
				if (typeof path !== "string" || typeof LOG_MARKER !== "string") {
					return completedStream(message(model, [{ type: "text", text: "CANARY_PATH_OR_MARKER_MISSING" }]));
				}
				return completedStream(message(model, [{
					type: "toolCall",
					id: "research-log-write-1",
					name: "write",
					arguments: { path, content: LOG_MARKER },
				}]));
			}
			if (worker) {
				return completedStream(message(model, [{ type: "text", text: `WORKER_COMPLETED_${LOG_MARKER}` }]));
			}
			// One dispatch per parent session. A later parent call carrying the thread
			// result proves that the worker, its write, and episode persistence completed.
			if (!dispatched && userText.at(-1)?.includes(DISPATCH_REQUEST)) {
				dispatched = true;
				return completedStream(message(model, [{
					type: "toolCall",
					id: "research-log-dispatch-1",
					name: "thread",
					arguments: {
						name: "log",
						type: "general",
						task: "Use the exact research log path from your system prompt. Write the unique canary marker there, then report completion.",
					},
				}]));
			}
			if (dispatched && toolResults.some((item) => item.toolName === "thread")) {
				writeFileSync(COMPLETION, JSON.stringify({ marker: LOG_MARKER, threadResult: true }), { flag: "wx" });
			}
			return completedStream(message(model, [{ type: "text", text: ANSWER }]));
		},
	});
}
