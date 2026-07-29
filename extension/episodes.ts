/**
 * Episode compression (ExecPlan D5, D6, D8).
 *
 * An episode is the compressed, structured record of ONE completed thread
 * action. It is produced by a single LLM call over the messages generated
 * during that action, stored at <config dir>/slate/episodes/<id>.md, and returned to
 * the orchestrator as the tool result — it IS the synchronization mechanism.
 *
 * Compressor model resolution (D5): config episodeModel → newest available
 * Anthropic Sonnet → the worker's own model.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	CONFIG_DIR_NAME,
	convertToLlm,
	serializeConversation,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isFailoverCandidate, resolveMappedModel } from "./failover.ts";
import { splitModelSpec } from "./state.ts";

type CompressorModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

const MAX_TRANSCRIPT_CHARS = 300_000;
const COMPRESSOR_MAX_TOKENS = 4096;

const EPISODE_SECTIONS = [
	"## Intent",
	"## Actions Taken",
	"## Key Findings",
	"## Artifacts Changed",
	"## Open Issues",
	"## Handoff Notes",
];

function compressorPrompt(task: string, transcript: string): string {
	return `You are compressing one completed action of a worker thread into an episode:
a durable, structured record another agent will rely on WITHOUT seeing the
raw transcript. Retain decisions, discoveries, exact identifiers (paths,
symbols, commands, versions, error messages) and outcomes. Drop tactical
noise (retries, scrolling, dead ends — unless a dead end is itself a finding).
Note: the transcript covers only THIS action; the thread may legitimately use
context from its earlier actions that you cannot see — do not flag that as
fabrication.
Target 300-800 words. Output ONLY markdown with EXACTLY these sections:

${EPISODE_SECTIONS.join("\n")}

The action's task was:
${task}

Transcript:
${transcript}`;
}

async function resolveCompressorModel(
	ctx: ExtensionContext,
	configured: string | undefined,
	workerModel: { provider: string; id: string } | undefined,
) {
	// Shared spec parsing (CQ2). A malformed episodeModel falls through to the
	// Sonnet default below — sanitizeEpisodeModel above reports it at session_start
	// (RG20), so the fall-through here is no longer silent.
	const spec = splitModelSpec(configured);
	if (spec) {
		const m = ctx.modelRegistry.find(spec.provider, spec.id);
		if (m) return m;
	}
	try {
		const available = await ctx.modelRegistry.getAvailable();
		const sonnets = available
			.filter((m: { provider: string; id: string }) => m.provider === "anthropic" && m.id.includes("sonnet"))
			.sort((a: { id: string }, b: { id: string }) => b.id.localeCompare(a.id));
		if (sonnets.length > 0) return sonnets[0];
	} catch {
		/* fall through */
	}
	if (workerModel) return ctx.modelRegistry.find(workerModel.provider, workerModel.id) ?? undefined;
	return undefined;
}

export interface CompressEpisodeOptions {
	ctx: ExtensionContext;
	episodeId: string;
	threadId: string;
	threadName: string;
	task: string;
	status: "ok" | "failed";
	diagnostics?: string; // failure diagnostics (D6)
	messages: unknown[]; // AgentMessages produced during this action
	workerModel?: { provider: string; id: string };
	configuredModel?: string;
	modelFailover?: Record<string, string>; // "provider/id" → "provider/id" retry map (single hop, one retry)
	signal?: AbortSignal;
}

export interface CompressedEpisode {
	text: string; // full episode markdown (header + body) as returned to the orchestrator
	file: string;
	compressor: string; // model used, or "(uncompressed fallback)"
	costUsd: number; // USD cost of the compression LLM call (0 on fallback)
}

type CompressionAttempt =
	| { kind: "ok"; body: string; costUsd: number }
	| { kind: "failed"; costUsd: number; retriable: boolean }
	| { kind: "aborted"; costUsd: number };

/**
 * ONE compression attempt on ONE model. Failure classification (AF7/AF11):
 * - stopReason "error" → failed; treated as failed even when partial text came
 *   back (a half-written episode is worse than the uncompressed fallback);
 *   retriable unless it is a context overflow — a mapped model cannot shrink
 *   the prompt (isFailoverCandidate).
 * - stopReason "aborted" (or a throw with the signal already aborted) →
 *   aborted; NEVER retried — cancellation must not spend a mapped attempt.
 * - missing auth or a thrown preflight error → failed & retriable (state-based
 *   classification, AF10: the mapped model may be authed when this one isn't).
 * - empty text on a clean stop → failed, not retriable (nothing suggests the
 *   mapped model would answer differently).
 */
async function attemptCompression(
	ctx: ExtensionContext,
	model: CompressorModel,
	promptText: string,
	signal: AbortSignal | undefined,
): Promise<CompressionAttempt> {
	let costUsd = 0;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return { kind: "failed", costUsd, retriable: true };
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: promptText }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				maxTokens: COMPRESSOR_MAX_TOKENS,
				signal,
			},
		);
		costUsd = response.usage?.cost?.total ?? 0;
		if (response.stopReason === "aborted") return { kind: "aborted", costUsd };
		if (response.stopReason === "error") {
			return { kind: "failed", costUsd, retriable: isFailoverCandidate(response, model.contextWindow) };
		}
		const text = response.content
			.filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join("\n")
			.trim();
		if (!text) return { kind: "failed", costUsd, retriable: false };
		return { kind: "ok", body: text, costUsd };
	} catch {
		if (signal?.aborted) return { kind: "aborted", costUsd };
		return { kind: "failed", costUsd, retriable: true };
	}
}

function lastAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: Array<{ type: string; text?: string }> };
		if (m.role === "assistant" && Array.isArray(m.content)) {
			const text = m.content
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "(no output)";
}

export async function compressEpisode(opts: CompressEpisodeOptions): Promise<CompressedEpisode> {
	const { ctx } = opts;
	const dir = join(ctx.cwd, CONFIG_DIR_NAME, "slate", "episodes");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${opts.episodeId}.md`);

	let body: string | undefined;
	let compressor = "(uncompressed fallback)";
	let costUsd = 0;

	try {
		const model = await resolveCompressorModel(ctx, opts.configuredModel, opts.workerModel);
		if (model) {
			let transcript = serializeConversation(convertToLlm(opts.messages as never));
			if (transcript.length > MAX_TRANSCRIPT_CHARS) {
				transcript = `[transcript head truncated]\n...${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
			}
			if (opts.diagnostics) {
				transcript += `\n\n[dispatch diagnostics: ${opts.diagnostics}]`;
			}
			const promptText = compressorPrompt(opts.task, transcript);

			const first = await attemptCompression(ctx, model, promptText, opts.signal);
			// Cost ACCUMULATES across attempts — a failed first attempt may still bill.
			costUsd += first.costUsd;
			if (first.kind === "ok") {
				body = first.body;
				compressor = `${model.provider}/${model.id}`;
			} else if (first.kind === "failed" && first.retriable && !opts.signal?.aborted) {
				// Model failover — single hop, at most ONCE: retry iff the mapped
				// model resolves, is authed, and differs from the attempt-1 model.
				const mapped = await resolveMappedModel(ctx, opts.modelFailover ?? {}, model.provider, model.id);
				// CQ4: resolveMappedModel keeps the looser auth.ok semantics shared
				// with the setModel-based sites, but attemptCompression additionally
				// requires an explicit apiKey — pre-check it so an env/header-auth
				// mapped model does not buy a guaranteed-futile retry.
				const mappedAuth = mapped ? await ctx.modelRegistry.getApiKeyAndHeaders(mapped) : undefined;
				if (
					mapped &&
					mappedAuth?.ok &&
					mappedAuth.apiKey &&
					(mapped.provider !== model.provider || mapped.id !== model.id)
				) {
					const second = await attemptCompression(ctx, mapped, promptText, opts.signal);
					costUsd += second.costUsd;
					if (second.kind === "ok") {
						body = second.body;
						// The header's compressor line shows whichever model actually
						// produced the episode — that is where failover stays visible.
						compressor = `${mapped.provider}/${mapped.id}`;
					}
				}
			}
		}
	} catch {
		/* fall back below */
	}

	if (!body) {
		body = [
			"## Intent",
			opts.task,
			"",
			"## Key Findings",
			"(episode compression unavailable — raw final worker output follows)",
			"",
			lastAssistantText(opts.messages).slice(0, 8000),
			...(opts.diagnostics ? ["", "## Open Issues", opts.diagnostics] : []),
		].join("\n");
	}

	const statusLabel = opts.status === "ok" ? "OK" : "FAILED";
	const header = [
		`# Episode ${opts.episodeId} — thread ${opts.threadId} (${opts.threadName}) — STATUS: ${statusLabel}`,
		"",
		`> task: ${opts.task.replace(/\s+/g, " ").slice(0, 200)}`,
		`> date: ${new Date().toISOString()} | compressor: ${compressor}`,
		...(opts.status === "failed" && opts.diagnostics ? [`> failure: ${opts.diagnostics.slice(0, 300)}`] : []),
		"",
		"",
	].join("\n");

	const text = `${header}${body}\n`;
	writeFileSync(file, text, "utf8");
	return { text, file, compressor, costUsd };
}
