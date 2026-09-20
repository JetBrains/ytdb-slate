/**
 * Episode compression (ExecPlan D5, D6, D8).
 *
 * An episode is the structured record of ONE completed thread action.
 * Actions with a worker response use one large language model call when a compressor is available.
 * Failed actions without a worker response use a short fixed structure without compression.
 * Episodes are stored at <config dir>/slate/episodes/<id>.md and returned to the orchestrator.
 *
 * Compressor candidates come only from the active logical policy. The original
 * action admission fixes the remembered start and provider order. Pi retries one
 * physical route. Slate moves only forward after proved exhaustion. It never
 * wraps to an earlier compressor entry or adds a hidden fallback. Any terminal,
 * cancelled, unknown, or exhausted compression keeps bounded completed output.
 *
 * THE HEADER IS PROMPT TEXT, not a parsed record: it is returned to the
 * orchestrator and re-enters later worker prompts verbatim (threads.ts's
 * buildPrompt), so its reader is a reasoning model. Every interpolated value
 * therefore goes through ONE sanitizer (headerField) that collapses whitespace,
 * strips control characters and the field delimiter, and bounds the length — so no
 * task text, thread name, model id or provider error message can forge a header
 * line or a same-line field (SE1/SE2/SE3, CQ44).
 */

import { isRetryableAssistantError, retryAssistantCall, type AssistantMessage, type ProviderHeaders } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
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
import { CompressorRetryEvidence, executeRecovery, type CompressorRetryPolicy } from "./logical-model-adapters.ts";
import type { LogicalRuntime } from "./logical-model-runtime.ts";
import type { RecoveryAdmission, RecoveryCandidate } from "./logical-model-recovery.ts";
import type { LogicalModelEffort as ThinkingLevel } from "./logical-model-definitions.ts";
import { sanitizeForNotify } from "./notify.ts";
import type { ObservationRecord } from "./observations.ts";
// SE2: the episode file carries the SAME unsafe write pattern the observation
// capture was found with — a predictable filename under the same tree, written
// with recursive mkdir and writeFileSync — so both kinds now go through one safe
// writer rather than shipping a new guard beside a known identical hole.
import { writeSlateArtifact } from "./slate-files.ts";
import { renderThreadId, type EpisodeUsage } from "./state.ts";

type CompressorModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

const MAX_TRANSCRIPT_CHARS = 300_000;
const COMPLETED_FACT_MAX_CHARS = 8_000;
const COMPLETED_FACT_OMISSION_MARKER = "[older completed facts omitted or truncated, or completed fact content omitted]";
const COMPRESSOR_MAX_TOKENS = 4096;

export interface CompletedFact {
	readonly kind: "assistant" | "tool";
	readonly text: string;
	readonly label: string;
}

export interface FrozenCompletedFacts {
	readonly facts: readonly CompletedFact[];
	readonly text: string;
	readonly hasFacts: boolean;
	readonly omitted: boolean;
}

export interface CompletedFactRecorder {
	/** Record bounded finalized assistant content and return its bounded text view. */
	addAssistant(content: unknown, stopReason: string | undefined): string;
	addTool(toolName: string, result: unknown, isError: boolean): void;
	freeze(): FrozenCompletedFacts;
}

interface BoundedText {
	readonly text: string;
	readonly hasText: boolean;
	readonly hasNonWhitespace: boolean;
	readonly omitted: boolean;
}

/**
 * Read the newest text suffix without first joining the complete input. Text
 * blocks are still scanned for the assistant nonblank rule, but at most the
 * requested number of characters are copied.
 */
function boundedTextSuffix(value: unknown, maxChars: number, nonTextIsOmitted: boolean): BoundedText {
	const limit = Math.max(0, maxChars);
	if (typeof value === "string") {
		const start = Math.max(0, value.length - limit);
		return {
			text: limit === 0 ? "" : value.slice(start),
			hasText: true,
			hasNonWhitespace: /\S/u.test(value),
			omitted: start > 0,
		};
	}
	if (!Array.isArray(value)) {
		return {
			text: "",
			hasText: false,
			hasNonWhitespace: false,
			omitted: nonTextIsOmitted && value !== undefined && value !== null,
		};
	}

	let remaining = limit;
	let hasText = false;
	let hasNonWhitespace = false;
	let omitted = false;
	let newerTextExists = false;
	const suffixParts: string[] = [];
	for (let index = value.length - 1; index >= 0; index--) {
		const item = value[index];
		const part = typeof item === "object" && item !== null
			? item as { type?: unknown; text?: unknown }
			: undefined;
		if (part?.type !== "text" || typeof part.text !== "string") {
			if (nonTextIsOmitted) omitted = true;
			continue;
		}
		hasText = true;
		if (!hasNonWhitespace && /\S/u.test(part.text)) hasNonWhitespace = true;
		if (newerTextExists) {
			if (remaining > 0) {
				suffixParts.unshift("\n");
				remaining--;
			} else {
				omitted = true;
			}
		}
		if (part.text.length > remaining) omitted = true;
		if (remaining > 0 && part.text.length > 0) {
			const start = Math.max(0, part.text.length - remaining);
			const suffix = part.text.slice(start);
			suffixParts.unshift(suffix);
			remaining -= suffix.length;
		}
		newerTextExists = true;
	}
	return { text: suffixParts.join(""), hasText, hasNonWhitespace, omitted };
}

/** A bounded text view for compatibility consumers outside the stable recorder. */
export function boundedCompletedText(value: unknown, maxChars = COMPLETED_FACT_MAX_CHARS): string {
	return boundedTextSuffix(value, maxChars, false).text;
}

interface BoundedFactCandidate {
	readonly fact: CompletedFact;
	readonly truncated: boolean;
	readonly sourceText: string;
}

function boundedFact(
	kind: CompletedFact["kind"],
	label: string,
	content: unknown,
	requireNonblank: boolean,
	nonTextIsOmitted: boolean,
): BoundedFactCandidate | undefined {
	const maxLabelChars = COMPLETED_FACT_MAX_CHARS - 3;
	const boundedLabel = label.slice(0, maxLabelChars);
	const prefix = `[${boundedLabel}]\n`;
	const room = Math.max(0, COMPLETED_FACT_MAX_CHARS - prefix.length);
	const bounded = boundedTextSuffix(content, room, nonTextIsOmitted);
	if (requireNonblank && !bounded.hasNonWhitespace) return undefined;
	return {
		fact: Object.freeze({ kind, label: boundedLabel, text: `${prefix}${bounded.text}` }),
		truncated: label.length > boundedLabel.length || bounded.omitted,
		sourceText: bounded.text,
	};
}

function toolResultContent(result: unknown): unknown {
	if (typeof result === "object" && result !== null) {
		return (result as { content?: unknown }).content;
	}
	return result;
}

/**
 * Keep only the newest bounded completed facts. The recorder never retains a
 * full tool result or a lifetime history outside the existing transcript cap.
 */
export function createCompletedFactRecorder(): CompletedFactRecorder {
	let facts: CompletedFact[] = [];
	let chars = 0;
	let omitted = false;
	let frozen: FrozenCompletedFacts | undefined;
	const add = (candidate: { fact: CompletedFact; truncated: boolean } | undefined) => {
		if (candidate === undefined || frozen !== undefined) return;
		omitted ||= candidate.truncated;
		chars += candidate.fact.text.length + (facts.length > 0 ? 2 : 0);
		facts.push(candidate.fact);
		while (chars > MAX_TRANSCRIPT_CHARS && facts.length > 1) {
			const removed = facts.shift();
			if (removed !== undefined) chars -= removed.text.length + 2;
			omitted = true;
		}
		if (chars > MAX_TRANSCRIPT_CHARS) {
			const only = facts[0]!;
			facts = [Object.freeze({ ...only, text: only.text.slice(-MAX_TRANSCRIPT_CHARS) })];
			chars = facts[0]!.text.length;
			omitted = true;
		}
	};
	return {
		addAssistant(content, stopReason) {
			const candidate = boundedFact("assistant", `final assistant text, stop reason=${stopReason ?? "unknown"}`, content, true, false);
			add(candidate);
			return candidate?.sourceText ?? "";
		},
		addTool(toolName, result, isError) {
			add(boundedFact(
				"tool",
				`completed tool result: ${toolName}${isError ? " (error)" : ""}`,
				toolResultContent(result),
				false,
				true,
			));
		},
		freeze() {
			if (frozen !== undefined) return frozen;
			const retained = Object.freeze([...facts]);
			let text = retained.map((fact) => fact.text).join("\n\n");
			if (omitted) {
				const marker = `${COMPLETED_FACT_OMISSION_MARKER}\n\n`;
				while (text.length + marker.length > MAX_TRANSCRIPT_CHARS && facts.length > 1) {
					facts.shift();
					text = facts.map((fact) => fact.text).join("\n\n");
				}
				text = `${marker}${text.slice(-(MAX_TRANSCRIPT_CHARS - marker.length))}`;
			}
			frozen = Object.freeze({ facts: Object.freeze([...facts]), text, hasFacts: facts.length > 0, omitted });
			return frozen;
		},
	};
}

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
Note: the transcript covers only THIS action. Referenced earlier episodes may
inform the action, but Slate excludes their injected text from this transcript.
Do not treat that missing source text as fabrication.
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
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

/**
 * THE usability rule (BG42), and the ONLY place it is expressed: the registry's
 * own verdict, `auth.ok === true`.
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
 * Registry lookup that cannot take compression down (CQ41). `find` reaches a Pi
 * runtime this module does not own. A throw becomes an unknown route outcome.
 */
function findModel(ctx: ExtensionContext, spec: { provider: string; id: string }): CompressorModel | undefined {
	try {
		return ctx.modelRegistry.find(spec.provider, spec.id) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * The header's `ran:` segment: the latest physical pair accepted for local Pi
 * handoff, plus the unmeasured-effort marker — or undefined, which the header
 * omits entirely. Absence means Slate has no accepted pair to display. The value
 * is local handoff attribution and never remote execution or billing proof.
 *
 * WHAT `ran:` CLAIMS, exactly (CQ47): the latest physical pair accepted at the
 * worker's local Pi request boundary. A mid-action recovery acceptance replaces
 * an earlier pair. A blocked or pending request does not. The episode keeps one
 * final pair rather than a per-request ledger. When the action produced no
 * assistant message, `anyOutput: false` keeps the prose header absent even if the
 * structured episode records a locally accepted request.
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
	messages: unknown[]; // AgentMessages produced during this action, used for observation compatibility
	/** Stable bounded facts captured before mutable Pi history can be rewritten. */
	completedFacts?: FrozenCompletedFacts;
	/** Durable final-message facts. Transient capture fields are not rendered. */
	observations: ObservationRecord;
	/**
	 * Latest physical model accepted for local Pi handoff. A failover request can
	 * replace it only after crossing the same request boundary. Header only.
	 */
	workerModel?: { provider: string; id: string };
	/** Post-clamp effort of the latest accepted local Pi handoff. Header only. */
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
	/** Bounded completed text captured before host rewrites can remove the message. */
	completedText?: string;
	/** The one parent-session runtime shared with dispatch. */
	logicalRuntime: Readonly<LogicalRuntime>;
	/** The action admission captured before worker execution. */
	admission: RecoveryAdmission;
	/** Pi's effective retry settings captured read-only at session start. */
	retryPolicy?: CompressorRetryPolicy;
	signal?: AbortSignal;
}

export interface CompressedEpisode {
	text: string; // full episode markdown (header + body) as returned to the orchestrator
	file: string;
	compressor: string; // model used, or "(uncompressed fallback)"
	/** Sum of reported compression-call costs. Absent means no attempt reported cost. */
	costUsd?: number;
	compressorUsage?: EpisodeUsage;
}

/**
 * Final episode persistence failed after this much compressor spend was incurred.
 * The dispatch layer adds this charge beside its independent worker and compaction charges.
 */
export class EpisodePersistenceError extends Error {
	readonly costUsd: number | undefined;
	readonly originalError: unknown;

	constructor(costUsd: number | undefined, originalError: unknown) {
		super("slate episode persistence failed");
		this.name = "EpisodePersistenceError";
		this.costUsd = costUsd;
		this.originalError = originalError;
	}
}

function reportedUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): EpisodeUsage | undefined {
	if (usage === undefined) return undefined;
	const reported: EpisodeUsage = {
		...(usage.input !== undefined ? { input: usage.input } : {}),
		...(usage.output !== undefined ? { output: usage.output } : {}),
		...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
		...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
	};
	return Object.keys(reported).length > 0 ? reported : undefined;
}

function addReportedUsage(total: EpisodeUsage, usage: EpisodeUsage | undefined): void {
	if (usage === undefined) return;
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = usage[field];
		if (value !== undefined) total[field] = (total[field] ?? 0) + value;
	}
}

function addReportedCost(total: number | undefined, cost: number | undefined): number | undefined {
	return cost === undefined ? total : (total ?? 0) + cost;
}

/** Run one physical candidate through Pi-owned retry and raw evidence capture. */
async function attemptCompression(
	ctx: ExtensionContext,
	candidate: RecoveryCandidate,
	promptText: string,
	policy: CompressorRetryPolicy | undefined,
	signal: AbortSignal | undefined,
	onMeasured: (response: unknown) => void,
) {
	const model = findModel(ctx, { provider: candidate.provider, id: candidate.model });
	if (!model) return { kind: "unknown" as const, reason: "The validated compressor route disappeared from Pi's registry." };
	const auth = await resolveUsableAuth(ctx, model);
	if (!auth) return { kind: "unknown" as const, reason: "The validated compressor credentials disappeared before execution." };
	const evidence = new CompressorRetryEvidence();
	let final: unknown;
	let threw = false;
	try {
		final = await retryAssistantCall(
			async () => {
				const response = await completeSimple(model, {
					messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
				}, {
					...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }), headers: auth.headers, env: auth.env,
					maxTokens: COMPRESSOR_MAX_TOKENS, ...(candidate.effort === "off" ? {} : { reasoning: candidate.effort }), signal,
				});
				onMeasured(response);
				return evidence.response(response);
			},
			policy,
			signal,
			evidence.callbacks,
		);
	} catch {
		threw = true;
	}
	let retryable = false;
	try {
		retryable = typeof final === "object" && final !== null && isRetryableAssistantError(final as AssistantMessage);
	} catch {
		retryable = false;
	}
	return evidence.classify({ final, policy, actualEffort: candidate.effort, aborted: signal?.aborted === true, threw, retryable });
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

export interface FailedEpisodeOptions {
	ctx: Pick<ExtensionContext, "cwd">;
	episodeId: string;
	threadId: string;
	threadName: string;
	task: string;
	diagnostics: string;
	workerModel?: { provider: string; id: string };
	workerCostUsd: number;
}

/** Write the fixed episode for a failed action that produced no worker response. */
export function writeFailedEpisode(opts: FailedEpisodeOptions): CompressedEpisode {
	const episodeId = headerField(opts.episodeId, 80) ?? "(unknown)";
	const threadId = headerField(renderThreadId(opts.threadId), 80) ?? "(unknown)";
	const threadName = headerField(opts.threadName, 80) ?? "(unknown)";
	const task = headerField(opts.task) ?? "(no task recorded)";
	const failure = headerField(opts.diagnostics, 300) ?? "the worker action failed";
	const model = opts.workerModel
		? headerField(`${opts.workerModel.provider}/${opts.workerModel.id}`, 120) ?? "(unknown)"
		: "(unknown)";
	const cost = Number.isFinite(opts.workerCostUsd) && opts.workerCostUsd >= 0
		? opts.workerCostUsd.toFixed(6)
		: "0.000000";
	const text = [
		`# Episode ${episodeId} — thread ${threadId} (${threadName}) — STATUS: FAILED`,
		"",
		`> task: ${task}`,
		"> status: FAILED",
		`> error: ${failure}`,
		`> model: ${model}`,
		`> cost: USD ${cost}`,
		"",
		"## Failure",
		"The action failed before the worker produced a response.",
		"",
	].join("\n");
	try {
		const written = writeSlateArtifact({ cwd: opts.ctx.cwd, kind: "episodes", id: opts.episodeId, content: text });
		return { text, file: written.absolutePath, compressor: "(fixed failed-action episode)" };
	} catch (error) {
		throw new EpisodePersistenceError(undefined, error);
	}
}

export async function compressEpisode(opts: CompressEpisodeOptions): Promise<CompressedEpisode> {
	const { ctx } = opts;

	let body: string | undefined;
	let compressor = "(uncompressed fallback)";
	let costUsd: number | undefined;
	const compressorUsage: EpisodeUsage = {};
	let boundedCompleted = opts.completedFacts?.text;
	if (boundedCompleted === undefined) {
		boundedCompleted = opts.completedText;
		if (boundedCompleted === undefined) {
			try {
				boundedCompleted = lastAssistantText(opts.messages);
			} catch {
				boundedCompleted = "(completed output could not be prepared)";
			}
		}
		boundedCompleted = boundedCompleted.slice(0, COMPLETED_FACT_MAX_CHARS);
	}
	let failureNotice = "Compression failed. The bounded completed result was retained.";
	const measured = (response: unknown) => {
		const usage = (response as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } | null)?.usage;
		costUsd = addReportedCost(costUsd, usage?.cost?.total);
		addReportedUsage(compressorUsage, reportedUsage(usage));
	};
	try {
		let transcript = opts.completedFacts?.text;
		if (transcript === undefined) {
			transcript = serializeConversation(convertToLlm(opts.messages as never));
			if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = `[transcript head truncated]\n...${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
		}
		if (opts.diagnostics) transcript += `\n\n[dispatch diagnostics: ${opts.diagnostics}]`;
		const promptText = compressorPrompt(opts.task, transcript);
		const recovery = await executeRecovery({
			candidates: opts.logicalRuntime.planCompressor(opts.admission.snapshot),
			retainedToolResults: [],
			validateSwitch: (candidate) => opts.logicalRuntime.validateRoute(ctx, candidate),
			attempt: ({ candidate }) => attemptCompression(ctx, candidate, promptText, opts.retryPolicy, opts.signal, measured),
		});
		if (recovery.kind === "success") {
			body = recovery.value;
			compressor = `${recovery.candidate.provider}/${recovery.candidate.model}`;
			opts.logicalRuntime.publishProvider(opts.admission, recovery.candidate.logicalModel, recovery.candidate.provider);
			if (recovery.candidate.compressorIndex !== undefined) opts.logicalRuntime.publishCompressor(opts.admission, recovery.candidate.compressorIndex);
		} else if (recovery.kind === "cancelled") {
			failureNotice = "Compression was cancelled. The bounded completed result was retained.";
		} else if (recovery.kind === "unknown" || recovery.kind === "terminal-fault") {
			failureNotice = `${recovery.reason} The bounded completed result was retained.`;
		}
	} catch (error) {
		failureNotice = `Compression failed: ${sanitizeForNotify(error instanceof Error ? error.message : String(error), 200)}. The bounded completed result was retained.`;
	}

	if (!body) {
		body = [
			"## Intent", opts.task, "", "## Key Findings",
			`(${failureNotice} Raw final worker output follows.)`, "", boundedCompleted,
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
	let anyOutput = opts.completedFacts?.hasFacts ?? (opts.completedText === undefined ? undefined : opts.completedText.trim() !== "");
	if (anyOutput === undefined) {
		try {
			anyOutput = hasAssistantMessage(opts.messages);
		} catch {
			anyOutput = false;
		}
	}
	const ranOn = describeActionRun({
		model: opts.workerModel,
		effort: opts.workerEffort,
		unmeasured: opts.workerEffortUnmeasured,
		judgedFor: opts.workerEffortJudgedFor,
		anyOutput,
	});
	// EVERY interpolated value goes through headerField (module header): ids and the
	// thread name from state, the task and the diagnostics from a provider or a tool
	// call, the compressor and `ran:` specs from the registry. None of them can
	// introduce a line, a field or an unbounded run of text. The date is generated
	// here and the status label is one of two literals, so both are already safe.
	const episodeId = headerField(opts.episodeId, 80) ?? "(unknown)";
	const threadId = headerField(renderThreadId(opts.threadId), 80) ?? "(unknown)";
	const threadName = headerField(opts.threadName, 80) ?? "(unknown)";
	const task = headerField(opts.task) ?? "(no task recorded)";
	const failure = opts.status === "failed" ? headerField(opts.diagnostics, 300) : undefined;
	const observations = opts.observations.stored
		? `stored | path: ${headerField(opts.observations.path, 240) ?? "(unknown)"} | bytes: ${opts.observations.bytes} | truncated: ${opts.observations.truncated ? "yes" : "no"} | grammar: ${opts.observations.grammar}`
		: `not stored | reason: ${opts.observations.reason} | grammar: ${opts.observations.grammar}`;
	const header = [
		`# Episode ${episodeId} — thread ${threadId} (${threadName}) — STATUS: ${statusLabel}`,
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
		return {
			text,
			file: written.absolutePath,
			compressor,
			...(costUsd !== undefined ? { costUsd } : {}),
			...(Object.keys(compressorUsage).length > 0 ? { compressorUsage } : {}),
		};
	} catch (error) {
		throw new EpisodePersistenceError(costUsd, error);
	}
}
