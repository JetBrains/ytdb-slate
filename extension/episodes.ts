/**
 * Episode compression (ExecPlan D5, D6, D8).
 *
 * An episode is the compressed, structured record of ONE completed thread
 * action. It is produced by a single LLM call over the messages generated
 * during that action, stored at <config dir>/slate/episodes/<id>.md, and returned to
 * the orchestrator as the tool result — it IS the synchronization mechanism.
 *
 * COMPRESSOR MODEL RESOLUTION (D5), in this order — and NEVER the model the
 * action itself was routed to:
 *   1. the configured `episodeModel`;
 *   2. the newest available Anthropic Sonnet — the built-in default;
 *   3. the ORCHESTRATOR's base model (base-model.ts), as a LAST resort;
 *   4. nothing usable ⇒ the uncompressed fallback (raw final worker output).
 * Each rung additionally has to be USABLE (authed) — see resolveCompressorModel.
 *
 * Why the action's own model is excluded (per-action routing, D4/D53): an action
 * may legitimately be routed to a cheap, small or non-reasoning model, and the
 * episode is read by EVERY later consumer of that thread — the orchestrator, the
 * next action's prompt, a handoff brief. Compressing with whatever the action
 * happened to run on would let one cheap route degrade the durable record, which
 * is the opposite of what the episode is for. The compressor is therefore a
 * fixed, deliberately chosen model; what the action ran on is recorded in the
 * episode HEADER instead (see compressEpisode).
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
// TYPE-ONLY (erased at load time): the effort vocabulary is defined once, in the
// profile table (the CQ2 rule), so recording an effort level here adds no runtime
// dependency on it.
import type { ThinkingLevel } from "./model-profiles.ts";
import { isModelSpec, splitModelSpec } from "./state.ts";

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

/**
 * Is this model actually USABLE for a compression call?
 *
 * Deliberately the SAME test attemptCompression applies below (`auth.ok` AND an
 * explicit `apiKey`, the CQ4 rule): a rung that passes here therefore cannot
 * fail the attempt on auth, and a rung that does not — a model configured with
 * no credentials, or one authed only through env/headers — FALLS THROUGH to the
 * next rung instead of spending the episode on a guaranteed-failed call and
 * landing in the uncompressed fallback. Never throws: an unusable answer and a
 * throwing registry are the same thing to a caller that just wants the next rung.
 */
async function compressorUsable(ctx: ExtensionContext, model: CompressorModel): Promise<boolean> {
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		return auth.ok === true && typeof auth.apiKey === "string" && auth.apiKey !== "";
	} catch {
		return false;
	}
}

/**
 * THE compressor pin (D5). The order is stated in the module header and repeated
 * here as executable comments, because the ONE thing this function must never do
 * is compress with the model the ACTION was routed to.
 */
async function resolveCompressorModel(
	ctx: ExtensionContext,
	configured: string | undefined,
	orchestratorBaseModel: string | undefined,
): Promise<CompressorModel | undefined> {
	// RUNG 1 — the configured `episodeModel`: an explicit choice outranks every
	// default. Shared spec parsing (CQ2); a malformed value falls through to rung 2,
	// and sanitizeEpisodeModel reports it at session_start (RG20), so the
	// fall-through is not silent.
	const spec = splitModelSpec(configured);
	if (spec) {
		const m = ctx.modelRegistry.find(spec.provider, spec.id);
		if (m && (await compressorUsable(ctx, m))) return m;
	}
	// RUNG 2 — the BUILT-IN DEFAULT, previously implicit: the newest available
	// Anthropic Sonnet. Documented rather than merely coded, because it is a
	// judgement call the rest of the pin depends on: summarising a long transcript
	// into a fixed schema is exactly a mid-tier model's job, Sonnet's context window
	// swallows the 300k-char transcript cap below, and pinning ONE family keeps
	// episode quality stable across actions routed all over the ladder. "Newest" is
	// a descending id sort — Anthropic's ids carry their generation, so the highest
	// id is the latest snapshot; it is a heuristic over registry data, which is why
	// an explicit `episodeModel` (rung 1) exists. Every candidate is auth-checked in
	// order, so an unusable newest Sonnet yields to an older usable one.
	// This rung may coincide with the action's own model — that is FINE and not the
	// hazard the pin guards against: it is chosen for its own properties, not
	// because an action ran on it.
	try {
		const available = await ctx.modelRegistry.getAvailable();
		const sonnets = available
			.filter((m: { provider: string; id: string }) => m.provider === "anthropic" && m.id.includes("sonnet"))
			.sort((a: { id: string }, b: { id: string }) => b.id.localeCompare(a.id));
		for (const sonnet of sonnets) {
			if (await compressorUsable(ctx, sonnet)) return sonnet;
		}
	} catch {
		/* fall through */
	}
	// RUNG 3 — LAST RESORT: the ORCHESTRATOR's base model (base-model.ts), i.e. the
	// model the orchestrator would be running had slate never failed over. It is the
	// one model in play that is neither a per-action route nor a failover fallback,
	// so it is the closest thing to a deliberate choice left once rungs 1 and 2 are
	// gone (an Anthropic-less setup, or one whose Sonnet credentials went away).
	// Absent = unknown (no tracker, or a session with no resolvable model), which
	// simply means this rung does not apply.
	const base = splitModelSpec(orchestratorBaseModel);
	if (base) {
		const m = ctx.modelRegistry.find(base.provider, base.id);
		if (m && (await compressorUsable(ctx, m))) return m;
	}
	// The ACTION's own model is deliberately NOT a rung here (module header).
	return undefined;
}

/**
 * The header's `ran:` segment: the model and effort level the action ACTUALLY
 * ran on, plus the unmeasured-effort marker — or undefined when the model is
 * unknown, which the header then omits entirely (absence reads as "unknown",
 * the ThreadRecord/EpisodeRecord contract, never as a default that would be
 * wrong).
 *
 * Both values are guarded before they enter the header: this text lands in a
 * file the orchestrator reads as structure, so a spec carrying whitespace,
 * control or invisible characters (the shared predicate rejects all three) or a
 * level that is not a bare word would be able to forge a header line. A rejected
 * value reads as unknown rather than being repaired.
 */
function describeActionRun(
	model: { provider: string; id: string } | undefined,
	effort: ThinkingLevel | undefined,
	unmeasured: boolean | undefined,
): string | undefined {
	if (!model) return undefined;
	const spec = `${model.provider}/${model.id}`;
	if (!isModelSpec(spec)) return undefined;
	// A bare lower-case word, which every level in pi's vocabulary is. Checked
	// structurally rather than against a copy of that vocabulary: the caller already
	// validated the level, and a fourth copy of the union is exactly the duplication
	// CQ2 removed.
	const level = typeof effort === "string" && /^[a-z]{1,12}$/.test(effort) ? effort : undefined;
	if (!level) return spec; // no level ⇒ nothing for the marker to qualify either
	// The marker qualifies the LEVEL ("this level has no capability measurement in
	// the profile data"), so it is only shown next to one.
	return `${spec} @ ${level}${unmeasured ? " (unmeasured level)" : ""}`;
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
	/**
	 * The model the action ACTUALLY ran on — the live worker session's own model,
	 * so a failover switch is reflected. Recorded in the episode HEADER and NEVER
	 * used to pick the compressor (module header).
	 */
	workerModel?: { provider: string; id: string };
	/** The effort level the action ACTUALLY ran at (post-clamp). Header only. Absent = unknown. */
	workerEffort?: ThinkingLevel;
	/** True when that level has NO capability measurement in the profile data (header marker only). */
	workerEffortUnmeasured?: boolean;
	configuredModel?: string;
	/**
	 * The ORCHESTRATOR's base model as "provider/id" (base-model.ts's tracker —
	 * `current()`), used as the compressor's LAST resort. Absent = unknown, which
	 * only means that rung does not apply.
	 */
	orchestratorBaseModel?: string;
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
		const model = await resolveCompressorModel(ctx, opts.configuredModel, opts.orchestratorBaseModel);
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
	// What the ACTION ran on, on the existing date/compressor line rather than a new
	// one: the header is paid for on every episode read (by the orchestrator AND by
	// every later action that cites the episode), so this costs ~40 characters and no
	// extra line. It answers the question a routed action makes unavoidable — a poor
	// episode is attributable to the model and level it was produced on, and an
	// action that ran at a level with no capability evidence says so, instead of
	// reading as a mysteriously weak result. The `compressor:` field beside it keeps
	// its own meaning untouched: that one is the model that wrote the episode BODY
	// (post-failover), a different fact from the model the action ran on.
	const ranOn = describeActionRun(opts.workerModel, opts.workerEffort, opts.workerEffortUnmeasured);
	const header = [
		`# Episode ${opts.episodeId} — thread ${opts.threadId} (${opts.threadName}) — STATUS: ${statusLabel}`,
		"",
		`> task: ${opts.task.replace(/\s+/g, " ").slice(0, 200)}`,
		`> date: ${new Date().toISOString()}${ranOn ? ` | ran: ${ranOn}` : ""} | compressor: ${compressor}`,
		...(opts.status === "failed" && opts.diagnostics ? [`> failure: ${opts.diagnostics.slice(0, 300)}`] : []),
		"",
		"",
	].join("\n");

	const text = `${header}${body}\n`;
	writeFileSync(file, text, "utf8");
	return { text, file, compressor, costUsd };
}
