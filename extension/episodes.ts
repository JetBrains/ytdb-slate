/**
 * Episode compression (ExecPlan D5, D6, D8).
 *
 * An episode is the compressed, structured record of ONE completed thread
 * action. It is produced by a single LLM call over the messages generated
 * during that action, stored at <config dir>/slate/episodes/<id>.md, and returned to
 * the orchestrator as the tool result — it IS the synchronization mechanism.
 *
 * COMPRESSOR MODEL RESOLUTION (D5), in this order:
 *   1. the configured `episodeModel`;
 *   2. the newest available Anthropic Sonnet — the built-in default;
 *   3. the ORCHESTRATOR's base model (base-model.ts), as a LAST resort;
 *   4. nothing usable ⇒ the uncompressed fallback (raw final worker output).
 * Each rung additionally has to be USABLE — see resolveUsableAuth, the ONE
 * usability rule, shared with the attempt itself.
 *
 * NO RUNG DERIVES FROM THE ACTION'S ROUTE (CQ48 states this precisely: rung 2 or
 * 3 may COINCIDE with the model an action ran on, and that is fine — what cannot
 * happen is a rung being chosen BECAUSE the action ran there). Why that matters
 * with per-action routing (D4/D53): an action may legitimately be routed to a
 * cheap, small or non-reasoning model, and the episode is read by EVERY later
 * consumer of that thread — the orchestrator, the next action's prompt, a handoff
 * brief. Compressing with whatever the action happened to run on would let one
 * cheap route degrade the durable record, which is the opposite of what the
 * episode is for. The compressor is therefore a fixed, deliberately chosen model;
 * what the action ran on is recorded in the episode HEADER instead.
 *
 * THE HEADER IS PROMPT TEXT, not a parsed record: it is returned to the
 * orchestrator and re-enters later worker prompts verbatim (threads.ts's
 * buildPrompt), so its reader is a reasoning model. Every interpolated value
 * therefore goes through ONE sanitizer (headerField) that collapses whitespace,
 * strips control characters and the field delimiter, and bounds the length — so no
 * task text, thread name, model id or provider error message can forge a header
 * line or a same-line field (SE1/SE2/SE3, CQ44).
 */

import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
// modelSpecOf is the ONE canonicalisation of a pi Model-like value into
// "provider/id" (CQ43): it validates that provider and id are STRINGS before
// joining them, which a local `${m.provider}/${m.id}` does not — a non-string
// would stringify into something that renders like a model name.
import { modelSpecOf } from "./base-model.ts";
import { isFailoverCandidate, resolveMappedModel } from "./failover.ts";
// TYPE-ONLY (erased at load time): the effort vocabulary is defined once, in the
// profile table (the CQ2 rule), so recording an effort level here adds no runtime
// dependency on it.
import type { ThinkingLevel } from "./model-profiles.ts";
import { sanitizeForNotify } from "./notify.ts";
import type { ObservationCapture } from "./observations.ts";
// SE2: the episode file carries the SAME unsafe write pattern the observation
// capture was found with — a predictable filename under the same tree, written
// with recursive mkdir and writeFileSync — so both kinds now go through one safe
// writer rather than shipping a new guard beside a known identical hole.
import { writeSlateArtifact } from "./slate-files.ts";
import { splitModelSpec } from "./state.ts";

type CompressorModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

const MAX_TRANSCRIPT_CHARS = 300_000;
const COMPRESSOR_MAX_TOKENS = 4096;

/**
 * Per-field cap for the episode header (CQ44). The header is read on every
 * episode read, so an unbounded field is both a cost and a forgery surface; 200
 * matches what the `task:` field has always used.
 */
const HEADER_FIELD_MAX = 200;

/**
 * ONE sanitizer for EVERY value interpolated into the episode header — the class
 * fix behind SE1, SE2, SE3 and CQ44, rather than three instance fixes.
 *
 * The header's structure is lines starting with "> " whose fields are separated by
 * " | ", and its reader is an LLM (module header). So a value must not be able to
 * introduce a LINE (any whitespace run, newlines included, collapses to one
 * space — exactly what the `task:` field already did), a FIELD (the "|" delimiter
 * is dropped), a control/ANSI sequence, or an unbounded wall of text. Empty after
 * sanitising reads as absent, so a caller can omit the field instead of printing
 * a label with nothing after it.
 */
function headerField(value: unknown, max = HEADER_FIELD_MAX): string | undefined {
	if (typeof value !== "string") return undefined;
	// Order matters: collapse whitespace FIRST (so a newline becomes a word gap
	// rather than joining two words), then strip the delimiter, then hand the rest to
	// the shared display sanitizer, which removes control/ANSI bytes and caps length.
	const collapsed = value.replace(/\s+/g, " ").replace(/\|/g, "").trim();
	const clean = sanitizeForNotify(collapsed, max).trim();
	return clean === "" ? undefined : clean;
}

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

/** What a compression call needs to run: whatever the registry resolved, nothing added. */
interface UsableAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/**
 * THE usability rule (BG42), and the ONLY place it is expressed: the registry's
 * own verdict, `auth.ok === true`. Both the rung filter and the attempt call this
 * one function and use exactly what it returns, so they cannot drift apart again.
 *
 * It used to additionally demand a non-empty `apiKey`, and that was wrong: an API
 * key is not what makes a model runnable.
 *   · pi's own required-auth path accepts a key OR an auth header
 *     (agent-session's `_getRequiredRequestAuth`: `result.auth.apiKey ||
 *     result.auth.headers`), and pi-ai's Anthropic module accepts an
 *     `authorization` / `x-api-key` / `cf-aig-authorization` header instead of a
 *     key (`assertRequestAuth`).
 *   · Whole provider families need NEITHER: amazon-bedrock authenticates through
 *     the AWS credential chain (`AWS_PROFILE`, an ECS/IRSA role, IMDS — none of
 *     which is an apiKey), google-vertex through Application Default Credentials,
 *     and a local/compat provider with no `authHeader` resolves as
 *     `{ ok: true }` with neither key nor headers. For those users the old test
 *     rejected EVERY rung, so every episode fell back to uncompressed — silently,
 *     forever.
 * Anything the registry says is NOT ok stays rejected, which is the case that
 * actually matters: it is the registry, not this module, that knows whether a
 * provider is configured. A model that is `ok` but broken fails at the attempt and
 * is reported and retried there — an honest billed failure beats a silent skip.
 *
 * Never throws: an unusable answer and a throwing registry are the same thing to a
 * caller that just wants the next rung.
 */
async function resolveUsableAuth(ctx: ExtensionContext, model: CompressorModel): Promise<UsableAuth | undefined> {
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth?.ok !== true) return undefined;
		return { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
	} catch {
		return undefined;
	}
}

/**
 * Registry lookup that cannot take the compression down (CQ41). `find` reaches a
 * pi runtime this module does not own; a throw there must fall through to the next
 * rung, exactly as an unknown model does.
 */
function findModel(ctx: ExtensionContext, spec: { provider: string; id: string }): CompressorModel | undefined {
	try {
		return ctx.modelRegistry.find(spec.provider, spec.id) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Report a compressor-selection problem ONCE per process, through the host channel
 * (CQ40).
 *
 * The silent fall-through this closes is the exact bug RG20 was written to
 * eliminate one layer up: `episodeModel` is validated at session_start, so a
 * WELL-FORMED value gets past that check and then — if the registry does not know
 * it, or its provider is not configured — was dropped here with no diagnostic at
 * all. The only visible symptom was a compression bill on a model the user did not
 * choose, or no compression at all.
 *
 * `once` is per condition per PROCESS, not per episode: a session compresses many
 * episodes and the answer cannot change between them without a config change, so
 * repeating it would be noise. Never throws — ctx.hasUI/ctx.ui throw on a stale
 * context (model-default.ts documents the same hazard), and a diagnostic must not
 * turn a written episode into a failed dispatch.
 */
const reported = new Set<string>();
function reportOnce(ctx: ExtensionContext, key: string, message: string): void {
	if (reported.has(key)) return;
	reported.add(key);
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.warn(message);
	} catch {
		/* stale extension context — no diagnostic is worth failing an episode over */
	}
}

/**
 * Compare two model ids NEWEST-FIRST, comparing version components NUMERICALLY
 * (BG40).
 *
 * A plain string sort is wrong for versioned ids the moment a component reaches
 * two digits: "claude-sonnet-4-9" sorts ABOVE "claude-sonnet-4-10", so the newest
 * Sonnet rung would silently start choosing an older model. This repo already fixed
 * the same hazard class once, in the profile table's date handling.
 *
 * The rule: split each id into runs of digits and runs of non-digits, then compare
 * pairwise — digit runs as numbers, everything else as text. A longer id whose
 * prefix matches (a dated snapshot such as "...-4-5-20250929" against "...-4-5")
 * sorts as the more specific, hence newer, of the two; either choice is the same
 * generation, and the ordering only has to be total and stable.
 */
function compareModelIdsNewestFirst(a: string, b: string): number {
	const chunks = (id: string) => id.match(/\d+|\D+/g) ?? [];
	const left = chunks(a);
	const right = chunks(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i];
		const y = right[i];
		if (x === undefined) return 1; // b is more specific ⇒ newer ⇒ first
		if (y === undefined) return -1;
		const nx = /^\d+$/.test(x) ? Number(x) : undefined;
		const ny = /^\d+$/.test(y) ? Number(y) : undefined;
		if (nx !== undefined && ny !== undefined) {
			if (nx !== ny) return ny - nx; // DESCENDING: higher number first
			continue;
		}
		if (x !== y) return y.localeCompare(x); // descending text
	}
	return 0;
}

/**
 * THE compressor pin (D5). The order is stated in the module header and repeated
 * here as executable comments, because the ONE thing this function must never do
 * is derive a rung from the model the ACTION was routed to.
 *
 * Returns the model AND the auth that was resolved for it, so the attempt runs on
 * exactly what the rung was accepted for — one resolution, one verdict.
 */
async function resolveCompressorModel(
	ctx: ExtensionContext,
	configured: string | undefined,
	orchestratorBaseModel: string | undefined,
): Promise<{ model: CompressorModel; auth: UsableAuth } | undefined> {
	// RUNG 1 — the configured `episodeModel`: an explicit choice outranks every
	// default. Shared spec parsing (CQ2); a malformed value falls through to rung 2,
	// and sanitizeEpisodeModel reports it at session_start (RG20).
	// A WELL-FORMED value that cannot be used is reported HERE (CQ40): it passed the
	// session_start check, so this is the only place that can say so, and staying
	// silent would re-create exactly the bug RG20 closed one layer up.
	const spec = splitModelSpec(configured);
	if (spec) {
		const model = findModel(ctx, spec);
		if (!model) {
			reportOnce(
				ctx,
				`unknown:${configured}`,
				`slate: the configured episodeModel ${sanitizeForNotify(String(configured), 80)} is not in pi's model registry — ` +
					"compressing episodes with the built-in default model instead",
			);
		} else {
			const auth = await resolveUsableAuth(ctx, model);
			if (auth) return { model, auth };
			reportOnce(
				ctx,
				`auth:${configured}`,
				`slate: the configured episodeModel ${sanitizeForNotify(String(configured), 80)} has no usable credentials ` +
					`(pi reports provider "${sanitizeForNotify(model.provider, 40)}" as not configured) — compressing episodes with ` +
					"the built-in default model instead",
			);
		}
	}
	// RUNG 2 — the BUILT-IN DEFAULT, previously implicit: the newest available
	// Anthropic Sonnet. Documented rather than merely coded, because it is a
	// judgement call the rest of the pin depends on: summarising a long transcript
	// into a fixed schema is exactly a mid-tier model's job, Sonnet's context window
	// swallows the 300k-char transcript cap below, and pinning ONE family keeps
	// episode quality stable across actions routed all over the ladder. "Newest" is
	// decided by comparing version components NUMERICALLY (compareModelIdsNewestFirst,
	// BG40) rather than by string order; it is still a heuristic over registry data,
	// which is why an explicit `episodeModel` (rung 1) exists.
	// The loop walks candidates in that order and takes the first USABLE one. Auth
	// resolves per PROVIDER (the registry's own `hasConfiguredAuth(model.provider)`
	// and `getAuth(model)` are provider-keyed), so in practice every Anthropic
	// candidate shares one verdict and the loop's second iteration is unreachable
	// today (CQ42 — the old comment claimed otherwise). It is kept because it costs
	// nothing, it is what makes the rung correct if pi ever resolves auth per model,
	// and it also skips a candidate whose own resolution throws.
	try {
		const available = await ctx.modelRegistry.getAvailable();
		const sonnets = available
			.filter((m: { provider: string; id: string }) => m.provider === "anthropic" && m.id.includes("sonnet"))
			.sort((a: { id: string }, b: { id: string }) => compareModelIdsNewestFirst(a.id, b.id));
		for (const sonnet of sonnets) {
			const auth = await resolveUsableAuth(ctx, sonnet);
			if (auth) return { model: sonnet, auth };
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
		const model = findModel(ctx, base);
		if (model) {
			const auth = await resolveUsableAuth(ctx, model);
			if (auth) return { model, auth };
		}
	}
	// The ACTION's own model is deliberately NOT a rung here (module header).
	return undefined;
}

/**
 * The header's `ran:` segment: the model and effort level the action ACTUALLY ran
 * on, plus the unmeasured-effort marker — or undefined, which the header then
 * omits entirely (absence reads as "unknown", the ThreadRecord/EpisodeRecord
 * contract, never as a default that would be wrong).
 *
 * WHAT `ran:` CLAIMS, exactly (CQ47): the model the worker session ENDED the
 * action on. A mid-action model failover means an earlier turn ran elsewhere and
 * this names the model that finished; there is no second field, because the caller
 * reads one live session, not a per-turn history. And when the action produced no
 * assistant message at all, nothing ran on anything — the caller passes
 * `anyOutput: false` and the segment is omitted rather than asserting a model an
 * action never reached.
 *
 * The spec is canonicalised by the SHARED helper (modelSpecOf, CQ43), which also
 * rejects whitespace and invisible characters; the level must be a bare word. A
 * rejected value reads as unknown rather than being repaired. The result still
 * passes through headerField at the interpolation site, so this function is about
 * MEANING and that one is about STRUCTURE.
 */
function describeActionRun(opts: {
	model: { provider: string; id: string } | undefined;
	effort: ThinkingLevel | undefined;
	unmeasured: boolean | undefined;
	/** The spec the effort guards actually judged, when the caller knows it (BG41). */
	judgedFor?: string;
	/** false = the action produced no assistant message, so nothing ran (CQ47). */
	anyOutput: boolean;
}): string | undefined {
	if (!opts.anyOutput) return undefined;
	const spec = modelSpecOf(opts.model);
	if (spec === undefined) return undefined;
	// A bare lower-case word, which every level in pi's vocabulary is. Checked
	// structurally rather than against a copy of that vocabulary: the caller already
	// validated the level, and a fourth copy of the union is exactly the duplication
	// CQ2 removed.
	const level = typeof opts.effort === "string" && /^[a-z]{1,12}$/.test(opts.effort) ? opts.effort : undefined;
	if (!level) return spec; // no level ⇒ nothing for the marker to qualify either
	// The marker is a claim about the profile data for ONE (model, level) pair — the
	// pair the effort guards judged. When the caller names that spec (`judgedFor`), the
	// marker is attached only if it IS the model that ran; a caller that cannot name
	// it is trusted, which is the pre-existing contract.
	const appliesToThisModel = opts.judgedFor === undefined || opts.judgedFor === spec;
	const unmeasured = opts.unmeasured === true && appliesToThisModel;
	return `${spec} @ ${level}${unmeasured ? " (unmeasured level)" : ""}`;
}

/** Did this action produce any assistant message at all? (CQ47's `ran:` precondition.) */
function hasAssistantMessage(messages: unknown[]): boolean {
	return messages.some((m) => (m as { role?: unknown } | null)?.role === "assistant");
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
	/** Exact final-message capture facts. The transient write warning is not rendered. */
	observations: ObservationCapture;
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
	/**
	 * The spec the dispatch's EFFORT GUARDS judged the level against — route.ts's
	 * `effortJudgedFor` on the plan verdict, passed straight through (BG41).
	 *
	 * The marker above describes ONE (model, level) pair, so it must not be attached
	 * to a different model. That comparison used to be made against the model the
	 * dispatch ROUTED to, which is `undefined` whenever the guards judged the HOST
	 * model instead (an omitted `model` on a thread with no base) — so the marker was
	 * silently lost for the most common dispatch shape in a router-off project. The
	 * planner now names the judged spec explicitly and threads.ts collapses the boolean
	 * against THAT; passing the same spec here lets this module verify the pair it is
	 * about to print rather than trusting a boolean it cannot check. Absent = the
	 * caller's boolean is trusted, which is the older contract.
	 */
	workerEffortJudgedFor?: string;
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

/** Final episode persistence failed after this much compressor spend was incurred. */
export class EpisodePersistenceError extends Error {
	readonly costUsd: number;
	readonly originalError: unknown;

	constructor(costUsd: number, originalError: unknown) {
		super("slate episode persistence failed");
		this.name = "EpisodePersistenceError";
		this.costUsd = costUsd;
		this.originalError = originalError;
	}
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
		// THE SAME rule and the SAME resolution the rung filter used (BG42): one
		// function, so "usable enough to select" and "usable enough to call" cannot
		// diverge. `apiKey` may legitimately be absent — pi-ai's provider modules accept
		// an auth header instead, or authenticate from the environment (bedrock, vertex).
		const auth = await resolveUsableAuth(ctx, model);
		if (!auth) return { kind: "failed", costUsd, retriable: true };
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
				...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
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
	const m = [...messages].reverse().find((message) => (message as { role?: unknown } | null)?.role === "assistant") as
		| { content?: Array<{ type: string; text?: string }> }
		| undefined;
	if (!Array.isArray(m?.content)) return "(no output)";
	const text = m.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();
	return text || "(no output)";
}

export async function compressEpisode(opts: CompressEpisodeOptions): Promise<CompressedEpisode> {
	const { ctx } = opts;

	let body: string | undefined;
	let compressor = "(uncompressed fallback)";
	let costUsd = 0;

	try {
		const selected = await resolveCompressorModel(ctx, opts.configuredModel, opts.orchestratorBaseModel);
		const model = selected?.model;
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
				// CQ4, now trivially satisfied: resolveMappedModel and this module apply the
				// SAME usability rule (auth.ok), so the pre-check is the same question the
				// attempt will ask — it exists only to avoid spending a retry slot on a model
				// whose provider is not configured at all.
				const mappedAuth = mapped ? await resolveUsableAuth(ctx, mapped) : undefined;
				if (mapped && mappedAuth && (mapped.provider !== model.provider || mapped.id !== model.id)) {
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
	const ranOn = describeActionRun({
		model: opts.workerModel,
		effort: opts.workerEffort,
		unmeasured: opts.workerEffortUnmeasured,
		judgedFor: opts.workerEffortJudgedFor,
		anyOutput: hasAssistantMessage(opts.messages),
	});
	// EVERY interpolated value goes through headerField (module header): ids and the
	// thread name from state, the task and the diagnostics from a provider or a tool
	// call, the compressor and `ran:` specs from the registry. None of them can
	// introduce a line, a field or an unbounded run of text. The date is generated
	// here and the status label is one of two literals, so both are already safe.
	const episodeId = headerField(opts.episodeId, 80) ?? "(unknown)";
	const threadId = headerField(opts.threadId, 80) ?? "(unknown)";
	const threadName = headerField(opts.threadName, 80);
	const task = headerField(opts.task) ?? "(no task recorded)";
	const failure = opts.status === "failed" ? headerField(opts.diagnostics, 300) : undefined;
	const observations = opts.observations.stored
		? `stored | path: ${headerField(opts.observations.path, 240) ?? "(unknown)"} | bytes: ${opts.observations.bytes} | truncated: ${opts.observations.truncated ? "yes" : "no"} | grammar: ${opts.observations.grammar}`
		: `not stored | reason: ${opts.observations.reason} | grammar: ${opts.observations.grammar}`;
	const header = [
		`# Episode ${episodeId} — thread ${threadId}${threadName ? ` (${threadName})` : ""} — STATUS: ${statusLabel}`,
		"",
		`> task: ${task}`,
		`> observations: ${observations}`,
		`> date: ${new Date().toISOString()}${ranOn ? ` | ran: ${headerField(ranOn, 120)}` : ""} | compressor: ${headerField(compressor, 120) ?? "(unknown)"}`,
		...(failure ? [`> failure: ${failure}`] : []),
		"",
		"",
	].join("\n");

	const text = `${header}${body}\n`;
	// The directory is now created HERE rather than before the compression call.
	// Nothing reads it in between, and the write itself keeps its historical
	// failure policy: a refusal or an fs error throws out of this function.
	try {
		const written = writeSlateArtifact({ cwd: ctx.cwd, kind: "episodes", id: opts.episodeId, content: text });
		return { text, file: written.absolutePath, compressor, costUsd };
	} catch (error) {
		throw new EpisodePersistenceError(costUsd, error);
	}
}
