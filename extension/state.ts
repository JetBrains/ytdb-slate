/**
 * Slate state: thread/episode records, session-scoped persistence.
 *
 * Persistence model (ExecPlan D9): every mutation appends a full snapshot as a
 * custom session entry ("slate-state") via pi.appendEntry. On session_start the
 * store rebuilds from the LAST such entry on the current branch, so state
 * follows pi's session tree across restart/resume/fork. Thread session files
 * and episode files live on disk under <config dir>/slate/ and are validated
 * on restore.
 */

import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
// TYPE-ONLY: the effort vocabulary is defined once, in the profile table
// (model-profiles.ts, digest §V), and is identical to pi's own ThinkingLevel
// union. The import is erased at load time. State restoration therefore keeps
// no runtime dependency on model-profiles.ts (see the model-spec note below).
import type { ThinkingLevel } from "./model-profiles.ts";
import type { ObservationRecord } from "./observations.ts";
import { sanitizeForNotify } from "./notify.ts";
import { isSafeThreadId, isSlateArtifactReference } from "./artifact-names.ts";
import { createWritingReminderRuntime, type WritingReminderRuntime } from "./writing-reminder.ts";

/**
 * ADDITIVE TOLERANCE (the persistence model has no migration hook): the
 * snapshot below is UNVERSIONED, so a record restored from an older session
 * file simply lacks whatever fields were added since. Every field added to
 * ThreadRecord/EpisodeRecord is therefore OPTIONAL and its ABSENCE must read as
 * "unknown" — never as a default value that would be wrong. The routing fields
 * are the current example: an absent `baseModel` means "this thread predates
 * per-action routing", which the dispatch path answers by falling back to the
 * pre-router `model` field and then to the host default, not by inventing a base.
 */
export const THREAD_TYPES = ["researcher", "reviewer", "adversarial", "implementer", "general"] as const;
export type ThreadType = (typeof THREAD_TYPES)[number];

/** Intent-only labels for explaining the closed thread-type vocabulary. */
export const THREAD_TYPE_GLOSSES = {
	researcher: "investigates",
	reviewer: "judges work",
	adversarial: "seeks counterexamples",
	implementer: "makes the change",
	general: "is anything else",
} as const satisfies Record<ThreadType, string>;

export function isThreadType(value: unknown): value is ThreadType {
	return typeof value === "string" && (THREAD_TYPES as readonly string[]).includes(value);
}

/** Return the generated ordinal only for the exact canonical thread-id grammar. */
function canonicalThreadOrdinal(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^t([1-9]\d*)$/.exec(value);
	if (match === null) return undefined;
	const ordinal = Number(match[1]);
	return Number.isSafeInteger(ordinal) && ordinal >= 1 && value === `t${ordinal}` ? ordinal : undefined;
}

/** Generated thread ids are exactly t followed by one canonical positive safe integer. */
export function isCanonicalThreadId(value: unknown): value is string {
	return canonicalThreadOrdinal(value) !== undefined;
}

/** Render a primary thread id without allowing legacy punctuation to forge surrounding structure. */
export function renderThreadId(value: unknown): string | undefined {
	if (!isSafeThreadId(value)) return undefined;
	return isCanonicalThreadId(value) ? value : JSON.stringify(value);
}

/** One readable lineage phrase for every user-facing surface. */
export function restartLineageText(source: unknown, successor: unknown): string | undefined {
	return isCanonicalThreadId(source) && isCanonicalThreadId(successor)
		? `source ${source} -> successor ${successor}`
		: undefined;
}

/** Validate the conditionally required tool argument at its runtime boundary. */
export function parseThreadType(value: unknown, required: boolean): ThreadType | undefined {
	const allowed = THREAD_TYPES.join(", ");
	if (value === undefined) {
		if (required) throw new Error(`A type is required when creating a thread. Allowed values: ${allowed}.`);
		return undefined;
	}
	if (!isThreadType(value)) throw new Error(`Invalid thread type. Allowed values: ${allowed}.`);
	return value;
}

function resolveThreadType(value: unknown): ThreadType {
	return isThreadType(value) ? value : "general";
}

/** Resolve a display value without consuming the once-only warning for an adopted record. */
export function displayThreadType(value: unknown): ThreadType {
	return resolveThreadType(value);
}

const reportedUnknownThreadTypes = new WeakSet<ThreadRecord>();

/**
 * Resolve the persisted value at the point where thread behaviour needs it.
 * Old records remain absent. An unknown string also behaves as `general`, but
 * produces one visible report for that adopted record rather than one per use.
 */
export function effectiveThreadType(thread: ThreadRecord, report: (message: string) => void): ThreadType {
	const storedType = thread.type;
	const type = resolveThreadType(storedType);
	if (storedType !== undefined && !isThreadType(storedType) && !reportedUnknownThreadTypes.has(thread)) {
		reportedUnknownThreadTypes.add(thread);
		report(`slate: thread ${thread.id} has unrecognised type ${sanitizeForNotify(storedType, 80)}. Slate is treating it as general.`);
	}
	return type;
}

/** Compact display marker shared by every thread surface; includes its own separator. */
export function threadTypeMarker(type: ThreadType): string {
	return type === "general" ? "" : ` type=${type}`;
}

export interface ThreadRecord {
	id: string; // "t1", "t2", ...
	name: string;
	sessionFile: string; // absolute path to worker .jsonl ("" until first dispatch completes session creation)
	status: "idle" | "running";
	/** Immutable thread type. Absent means an older thread; resolve it with effectiveThreadType. */
	type?: ThreadType;
	/** Source thread replaced by this automatic restart. Absent means no restart lineage. */
	restartOf?: string;
	/** One-based depth in an automatic-restart lineage. Valid only with restartOf. */
	restartGeneration?: number;
	/** Successor that replaced this thread. Absent means this thread was not superseded. */
	supersededBy?: string;
	/**
	 * PRE-ROUTER pin: "provider/id" passed as `model` when the thread was created
	 * WITH THE ROUTER OFF. It names what a NEW worker session opens on and never
	 * instructs a live one to switch. With the router ON a `model` argument routes
	 * ONE action and is deliberately NOT recorded here; see `baseModel`.
	 */
	model?: string;
	/**
	 * The thread's DEFAULT plan model, canonical "provider/id" — the target when a
	 * dispatch omits `model`. Written ONLY while the router is on (with the router off
	 * nothing is seeded or persisted), and always one of the effective candidates:
	 * a base that is absent or has fallen off the list is re-seeded on the next
	 * dispatch (route.ts's THE ONE RULE). DISTINCT from whatever a single action was
	 * routed to: a routed action never becomes the thread's base. A live failover may
	 * temporarily override it without changing this record. Absent = unknown.
	 */
	baseModel?: string;
	/**
	 * The thread's DEFAULT effort level, derived for `baseModel` and valid only for
	 * it: a dispatch whose model differs re-derives the level for the model it
	 * routes to. Absent = unknown ⇒ the worker session's own opening level.
	 *
	 * The type is a claim about what slate WROTE, not a guarantee about what it reads
	 * back: this record is restored from an unversioned, hand-editable snapshot, so the
	 * reader (route.ts) re-validates the value against pi's vocabulary and treats
	 * anything else as absent — the same discipline the model fields get from the
	 * spec helpers below (BG21).
	 */
	baseEffort?: ThinkingLevel;
	/** Stable OpenAI prompt-cache routing shard. Absent means caching predates this field. */
	cacheKeyShard?: number;
	/** Effective built-in worker tool allowlist. Absent means an older thread whose tools are unknown. */
	tools?: string[];
	/** True when the live session grew beyond its newest durable episode evidence. */
	choiceEvidenceStale?: true;
	episodeIds: string[];
	episodeSeq: number; // monotonic per-thread episode counter
	createdAt: number;
	updatedAt: number;
}

export interface EpisodeUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface EpisodeRecord {
	id: string; // "t1.e2"
	threadId: string;
	task: string;
	status: "ok" | "failed";
	file: string; // absolute path to episode .md
	/** "provider/id" the action ACTUALLY ran on (post-failover). Absent = unknown. */
	model?: string;
	/** Effort level the action ACTUALLY ran at (post-clamp). Absent = unknown. */
	effort?: ThinkingLevel;
	/** Set only when that effort level has NO capability measurement in the profile data. */
	effortUnmeasured?: true;
	/** Exact final-message capture facts. Absent on episodes written before this field existed. */
	observations?: ObservationRecord;
	/** Worker input tokens. Absent means the provider did not report this quantity. */
	input?: number;
	/** Worker output tokens. Absent means the provider did not report this quantity. */
	output?: number;
	/** Worker prompt-cache read tokens. Absent means the provider did not report this quantity. */
	cacheRead?: number;
	/** Worker prompt-cache write tokens. Absent means the provider did not report this quantity. */
	cacheWrite?: number;
	/** Final reported worker context tokens. Absent means the provider did not report a finite count. */
	contextTokens?: number;
	/** Reported worker-call cost in USD. Absent means no worker call reported cost. */
	workerCostUsd?: number;
	/** Usage billed by episode compression. Each absent quantity was not reported. */
	compressorUsage?: EpisodeUsage;
	/** Reported compression-call cost in USD. Absent means no compression call reported cost. */
	compressorCostUsd?: number;
	/** Usage billed by platform context compaction during this dispatch. */
	compactionUsage?: EpisodeUsage;
	/** Reported compaction-call cost in USD. Absent means no compaction call reported cost. */
	compactionCostUsd?: number;
	createdAt: number;
}

export interface SlateSnapshot {
	threads: ThreadRecord[];
	episodes: EpisodeRecord[];
	/** Highest allocated generated thread ordinal. Absent snapshots derive it from records. */
	threadSeq?: number;
	/** Stable identity of this slate session lineage. Absent means a legacy lineage. */
	slateSessionId?: string;
	/** Pi session that currently owns slateSessionId. Re-stamped only by explicit handoff adoption. */
	ownerPiSessionId?: string;
	orchestratorMode: boolean;
	paused: boolean;
	workerCostUsd: number;
	carriedCostUsd: number; // orchestrator spend banked from ancestor sessions at handoff
}

export const SLATE_SESSION_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface SanitizedSnapshotIdentity {
	snapshotPresent: boolean;
	slateSessionIdPresent: boolean;
	ownerPiSessionIdPresent: boolean;
	slateSessionId?: string;
	ownerPiSessionId?: string;
}

export interface SlateSessionIdentityResolution {
	slateSessionId?: string;
	ownerPiSessionId?: string;
	minted: boolean;
	report?: string;
}

/** Mint a sortable, filename-safe slate session identity. */
export function mintSlateSessionId(now = new Date()): string {
	const timestamp = `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
	return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

/** Validate the two optional identity fields at the snapshot adoption boundary. */
export function sanitizeSnapshotIdentity(
	raw: SlateSnapshot | undefined,
	repairs: string[],
): SanitizedSnapshotIdentity {
	if (raw === undefined) {
		return { snapshotPresent: false, slateSessionIdPresent: false, ownerPiSessionIdPresent: false };
	}
	const slateSessionIdPresent = raw.slateSessionId !== undefined;
	const ownerPiSessionIdPresent = raw.ownerPiSessionId !== undefined;
	const slateSessionId =
		typeof raw.slateSessionId === "string" && SLATE_SESSION_ID_PATTERN.test(raw.slateSessionId)
			? raw.slateSessionId
			: undefined;
	const ownerPiSessionId =
		typeof raw.ownerPiSessionId === "string" && PI_SESSION_ID_PATTERN.test(raw.ownerPiSessionId)
			? raw.ownerPiSessionId
			: undefined;
	if (slateSessionIdPresent && slateSessionId === undefined) {
		repairs.push(`snapshot: ignoring slateSessionId (${typeof raw.slateSessionId === "object" ? "object" : typeof raw.slateSessionId})`);
	}
	if (ownerPiSessionIdPresent && ownerPiSessionId === undefined) {
		repairs.push(`snapshot: ignoring ownerPiSessionId (${typeof raw.ownerPiSessionId === "object" ? "object" : typeof raw.ownerPiSessionId})`);
	}
	return {
		snapshotPresent: true,
		slateSessionIdPresent,
		ownerPiSessionIdPresent,
		...(slateSessionId !== undefined ? { slateSessionId } : {}),
		...(ownerPiSessionId !== undefined ? { ownerPiSessionId } : {}),
	};
}

/** Apply the restore, legacy, ownership and malformed-value identity rules without I/O. */
export function resolveSlateSessionIdentity(
	restored: SanitizedSnapshotIdentity,
	currentPiSessionId: string,
	mint: () => string = mintSlateSessionId,
): SlateSessionIdentityResolution {
	if (!restored.snapshotPresent) {
		return { slateSessionId: mint(), ownerPiSessionId: currentPiSessionId, minted: true };
	}
	if (!restored.slateSessionIdPresent) return { minted: false };
	if (restored.slateSessionId === undefined) {
		return {
			slateSessionId: mint(),
			ownerPiSessionId: currentPiSessionId,
			minted: true,
			report: "slate: the restored snapshot has a malformed slateSessionId. Slate minted a fresh session identity.",
		};
	}
	if (restored.ownerPiSessionId === currentPiSessionId) {
		return {
			slateSessionId: restored.slateSessionId,
			ownerPiSessionId: currentPiSessionId,
			minted: false,
		};
	}
	const ownerReason = !restored.ownerPiSessionIdPresent
		? "no ownerPiSessionId"
		: restored.ownerPiSessionId === undefined
			? "a malformed ownerPiSessionId"
			: "a different ownerPiSessionId";
	return {
		slateSessionId: mint(),
		ownerPiSessionId: currentPiSessionId,
		minted: true,
		report: `slate: the restored session identity has ${ownerReason}. Slate minted a fresh session identity.`,
	};
}

/**
 * Canonical "provider/id" model-spec parsing — the ONE definition (CQ2).
 *
 * The pattern (validate, then split on the FIRST slash) had grown four
 * near-identical copies: failover.ts's local `isModelSpec`, and the inline
 * `indexOf("/")` splits in episodes.ts, worker.ts and the model router. All four
 * now call these helpers. It lives here because state.ts is where the config
 * vocabulary that uses it is defined (`episodeModel`, `modelFailover`,
 * `router.models`, the contextBudget override `match`), and because state.ts
 * imports nothing from those modules, so no call site can create an import cycle
 * by adopting it.
 *
 * ONE definition matters more than the duplication it removes: while failover.ts
 * kept its own laxer copy, two live predicates DISAGREED about the same config
 * string — the router rejected a spec with an embedded newline that failover
 * happily stored in its map and then failed to resolve, silently.
 *
 * The FIRST slash splits, deliberately: proxy providers legitimately carry a
 * slash inside the model id ("openrouter/anthropic/claude-..."), so provider is
 * everything before the first slash and id is all the rest.
 *
 * Whitespace, control characters and every ZERO-WIDTH or DIRECTION-CHANGING
 * character are REJECTED rather than trimmed (BG2). Such a spec resolves nowhere
 * in pi's registry, yet renders in a warning as a byte-identical twin of the
 * valid name once the display sanitizer strips the offending character — a
 * zero-width space, a variation selector or a right-to-left override is worse
 * still, since it survives sanitization and displays as nothing at all.
 * Rejecting them lets the caller say what is actually wrong
 * (describeSpecDefect). What is left after that is the VISIBLE confusable case —
 * a homoglyph such as Cyrillic "а" for Latin "a" — which cannot be rejected,
 * because an exotic provider id may be genuinely non-ASCII, so it is ANNOTATED
 * at display time instead (describeConfusables).
 */

/**
 * Characters that are never part of a real model spec because they occupy no
 * visible width, or change the direction of what follows.
 *
 * The two Unicode categories carry most of it — `Cc` (C0/C1 controls) and `Cf`
 * (format: soft hyphen, Arabic letter mark, Mongolian vowel separator,
 * zero-width space/joiners, LRM/RLM, the bidi embedding/override/isolate
 * controls, word joiner and invisible operators, interlinear annotation marks,
 * the tag characters, and the BOM) — plus `Cs` (a lone surrogate is broken text,
 * never an identifier).
 *
 * Three invisible classes are NOT in those categories and must be listed
 * explicitly (the residual BG2 finding): VARIATION SELECTORS (`Mn`: U+FE00–FE0F
 * and U+E0100–E01EF) and HANGUL FILLERS (`Lo`, and therefore "letters" as far as
 * any category test is concerned: U+115F, U+1160, U+3164, U+FFA0). Unicode
 * property escapes need the `u` flag; every use below tests one code point at a
 * time, which is why `codePointList` iterates with for…of rather than by index.
 */
const INVISIBLE_SPEC_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\u115f\u1160\u3164\ufe00-\ufe0f\uffa0]|[\u{e0100}-\u{e01ef}]/u;

/** "U+XXXX" list of the first few characters of `value` that match `pattern`, de-duplicated. */
function codePointList(value: string, pattern: RegExp, max = 3): string {
	const seen: string[] = [];
	for (const ch of value) {
		if (!pattern.test(ch)) continue;
		const point = `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
		if (!seen.includes(point)) seen.push(point);
		if (seen.length > max) return `${seen.slice(0, max).join(", ")}, …`;
	}
	return seen.join(", ");
}

export function isModelSpec(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (/\s/.test(value) || INVISIBLE_SPEC_CHARS.test(value)) return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

/** Split a validated spec into provider + id (first slash wins); undefined when it is not a spec. */
export function splitModelSpec(value: unknown): { provider: string; id: string } | undefined {
	if (!isModelSpec(value)) return undefined;
	const slash = value.indexOf("/");
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/**
 * Why `value` is not a canonical spec, as a clause that survives display
 * sanitization (BG2). The RENDERING of an invisible or padded spec is identical
 * to a valid name, so the reason has to carry the information — and for the
 * invisible classes it names the offending code points, which are plain ASCII.
 */
export function describeSpecDefect(value: unknown): string {
	if (typeof value !== "string") return `expected a string, got ${typeof value}`;
	if (value === "") return "it is empty";
	if (INVISIBLE_SPEC_CHARS.test(value)) {
		return `it contains invisible or control characters (${codePointList(value, INVISIBLE_SPEC_CHARS)}) — they display as nothing, so this is not the name it looks like`;
	}
	if (/^\s|\s$/.test(value)) return "it has leading or trailing whitespace (invisible here, but pi's registry has no such model)";
	if (/\s/.test(value)) return "it contains whitespace";
	if (!value.includes("/")) return 'it has no "/" separating provider from model id';
	if (value.startsWith("/")) return 'it has an empty provider before the "/"';
	if (value.endsWith("/")) return 'it has an empty model id after the "/"';
	return "it is not of the form provider/id";
}

/**
 * Display-time note for a spec that PASSES validation but contains non-ASCII
 * characters (BG2's remaining case: VISIBLE confusables, not invisible ones —
 * those are rejected outright above). A Cyrillic "а" in an otherwise valid spec
 * renders exactly like the Latin one, so a warning about it would otherwise look
 * like a warning about the model the user meant. The note is deliberately about
 * non-ASCII in general rather than a curated homoglyph table: any non-ASCII
 * character in a spec is worth pointing at, and enumerating confusables is a
 * losing game. Returns undefined for a pure printable-ASCII spec, the normal case.
 */
export function describeConfusables(value: string): string | undefined {
	// Printable-ASCII complement. Neither this nor INVISIBLE_SPEC_CHARS carries the
	// /g flag, because codePointList calls .test() per character and a sticky/global
	// regex would keep lastIndex between those calls and skip matches.
	const nonAscii = /[^\u0020-\u007e]/;
	if (!nonAscii.test(value)) return undefined;
	return `contains non-ASCII characters: ${codePointList(value, nonAscii)}`;
}

/**
 * Validate an optional single-spec config key — today `episodeModel` (RG20).
 *
 * Every other config key is checked eagerly at session_start; this one was not,
 * so a value the spec rules reject — a stray trailing newline, a zero-width
 * character pasted from a web page — made the episode compressor fall back to
 * its built-in default with NO diagnostic at all. The configured model simply
 * never ran, and the only visible symptom was a compression bill on a model the
 * user did not choose.
 *
 * THE FALLBACK IS UNCHANGED BY THIS SANITIZER: an unusable value still yields
 * undefined, and the consumer (episodes.ts's resolveCompressorModel) handles that
 * exactly as it handles an absent one. Only the diagnostic is new.
 *
 * What that consumer's chain IS, since a reader here is entitled to know what an
 * ignored value costs: the newest AVAILABLE Anthropic Sonnet, then — as a last
 * resort — the ORCHESTRATOR's base model (base-model.ts), each rung auth-checked,
 * and then the uncompressed fallback. It is NEVER the model the action itself was
 * routed to: a cheaply-routed action must not get a cheaply-compressed episode
 * (the compressor pin, D5 — see episodes.ts's module header for the reasoning).
 *
 * It lives HERE rather than in episodes.ts, which owns the feature, for two
 * reasons: the whole question it answers is the spec vocabulary defined in this
 * module (it holds no episode logic beyond one clause of prose), and episodes.ts
 * cannot be loaded by the pure verification harness — it imports
 * `@earendil-works/pi-ai`, a peer dependency that is not installed in this repo
 * — so a sanitizer placed there would be unverifiable by the only automated net
 * that covers this class of silent failure.
 *
 * Validation is shape-only on purpose: whether the registry knows the model is a
 * resolve-time question with its own fallback chain, and re-answering it here
 * would duplicate that logic against a registry that may not be refreshed yet.
 */
export function sanitizeModelSpecKey(key: string, raw: unknown, warn: (msg: string) => void, fallback: string): string | undefined {
	if (raw === undefined) return undefined; // absent ⇒ the built-in default, silently
	if (!isModelSpec(raw)) {
		let shown: string | undefined;
		try {
			shown = JSON.stringify(raw);
		} catch {
			shown = undefined; // cyclic / too deep to stringify
		}
		warn(`slate: ignoring ${key} ${sanitizeForNotify(shown ?? String(raw))} — ${describeSpecDefect(raw)}; ${fallback}`);
		return undefined;
	}
	return raw;
}

/** RG20: `episodeModel`, with the compressor's own fallback named in the warning. */
export function sanitizeEpisodeModel(raw: unknown, warn: (msg: string) => void): string | undefined {
	return sanitizeModelSpecKey("episodeModel", raw, warn, "compressing with the built-in default model instead");
}

export const DEFAULT_CACHE_KEY_SHARDS = 2;
export const MAX_CACHE_KEY_SHARDS = 64;

const THREAD_CHOICE_KEYS = ["report", "act"];

/** Validate the raw thread-choice config and apply independent safe defaults. */
export function sanitizeThreadChoiceConfig(raw: unknown, warn: (msg: string) => void): Required<ThreadChoiceConfig> {
	const defaults: Required<ThreadChoiceConfig> = { report: true, act: false };
	if (raw === undefined) return defaults;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warn('slate: ignoring threadChoice — expected an object like { "report": true, "act": false }');
		return defaults;
	}
	const value = raw as { report?: unknown; act?: unknown };
	let keys: string[];
	try {
		keys = Object.keys(value);
	} catch {
		warn("slate: ignoring threadChoice because its keys could not be read. Slate uses the defaults.");
		return defaults;
	}
	const unknownKeys = keys.filter((key) => !THREAD_CHOICE_KEYS.includes(key));
	if (unknownKeys.length > 0) {
		warn(
			`slate: ignoring unknown threadChoice key(s): ${sanitizeForNotify(unknownKeys.join(", "))} (known: ${THREAD_CHOICE_KEYS.map(
				(key) => `"${key}"`,
			).join(", ")})`,
		);
	}
	const booleanValue = (key: keyof typeof value, fallback: boolean): boolean => {
		let candidate: unknown;
		try {
			candidate = value[key];
		} catch {
			warn(`slate: ignoring threadChoice.${key} because its value could not be read (defaulting to ${fallback})`);
			return fallback;
		}
		if (candidate === undefined) return fallback;
		if (typeof candidate === "boolean") return candidate;
		warn(`slate: ignoring threadChoice.${key} — expected true or false (defaulting to ${fallback})`);
		return fallback;
	};
	return {
		report: booleanValue("report", defaults.report),
		act: booleanValue("act", defaults.act),
	};
}

/** Validate the explicit prompt-cache-key feature switch. */
export function sanitizeCacheKeyEnabled(raw: unknown, warn: (msg: string) => void): boolean {
	if (raw === undefined) return true;
	if (typeof raw === "boolean") return raw;
	warn(`slate: ignoring cacheKeyEnabled ${sanitizeForNotify(String(raw))} — expected a boolean. Using true.`);
	return true;
}

/** Validate the number of stable OpenAI prompt-cache routing shards. */
export function sanitizeCacheKeyShards(raw: unknown, warn: (msg: string) => void): number {
	if (raw === undefined) return DEFAULT_CACHE_KEY_SHARDS;
	if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_CACHE_KEY_SHARDS) return raw;
	warn(
		`slate: ignoring cacheKeyShards ${sanitizeForNotify(String(raw))} — expected an integer from 1 to ${MAX_CACHE_KEY_SHARDS}. Using ${DEFAULT_CACHE_KEY_SHARDS}.`,
	);
	return DEFAULT_CACHE_KEY_SHARDS;
}

/**
 * ADOPTION-BOUNDARY VALIDATION (BG26). A snapshot is JSON on disk: unversioned,
 * hand-editable, and written by whatever slate version wrote it. The record types
 * above describe what slate WRITES; they guarantee nothing about what it reads back,
 * and until this existed a single wrong-typed field crashed a dispatch rather than
 * degrading — a non-string `baseModel` reached a warning builder as
 * `s.replace is not a function`, and the exception escaped out of the `thread` tool.
 * A non-numeric `updatedAt` had the same shape one layer up (`new Date(x).toISOString()`
 * throws on NaN, in the threads listing).
 *
 * The rule is the one BG21 established for the stored effort level, applied to every
 * field: a value of the wrong TYPE reads as absent (or, where the record cannot exist
 * without it, drops the record), and the caller is told. Deliberately a TYPE check and
 * not a content check for the model fields: a padded or otherwise malformed spec is
 * still handed to pi, whose own error names the defect (CQ13/RG1) — repairing it here
 * would hide it, and dropping it would change what a restarted thread runs on.
 */
function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}
function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function counter(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function tokenQuantity(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}
function moneyAmount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Resolve a regular episode file only when its real path stays inside slate's episode directory. */
export function resolveEpisodeFile(cwd: string, value: unknown): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	try {
		const expectedRoot = join(realpathSync(cwd), CONFIG_DIR_NAME, "slate", "episodes");
		const root = realpathSync(expectedRoot);
		if (root !== expectedRoot || !statSync(root).isDirectory()) return undefined;
		const file = realpathSync(value);
		if (!statSync(file).isFile()) return undefined;
		const inside = relative(root, file);
		if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
			return undefined;
		}
		return file;
	} catch {
		return undefined;
	}
}

/** Validate the complete observation record, including its exact canonical reference. */
function observationRecord(value: unknown, episodeId: string): ObservationRecord | undefined {
	// Keep this as a strict tagged union. Extra keys and array-shaped objects are rejected.
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const o = value as Record<string, unknown>;
	const exactKeys = (expected: string[]) => {
		const keys = Object.keys(o);
		return keys.length === expected.length && keys.every((key) => expected.includes(key));
	};
	const grammar = o.grammar === "present" || o.grammar === "absent" || o.grammar === "malformed" ? o.grammar : undefined;
	if (o.stored === true) {
		const path = isSlateArtifactReference(o.path, "observations", episodeId) ? o.path : undefined;
		const bytes = typeof o.bytes === "number" && Number.isSafeInteger(o.bytes) && o.bytes >= 0 ? o.bytes : undefined;
		if (!exactKeys(["stored", "path", "bytes", "truncated", "grammar"]) || path === undefined || bytes === undefined || typeof o.truncated !== "boolean" || grammar === undefined) return undefined;
		return { stored: true, path, bytes, truncated: o.truncated, grammar };
	}
	if (o.stored === false) {
		if (!exactKeys(["stored", "reason", "grammar"]) || grammar === undefined) return undefined;
		if ((o.reason === "no-final-message" || o.reason === "no-final-text") && grammar === "absent") {
			return { stored: false, reason: o.reason, grammar };
		}
		if (o.reason === "write-failed") return { stored: false, reason: o.reason, grammar };
	}
	return undefined;
}

/**
 * EXHAUSTIVENESS WITNESSES for the two sanitizers below (CQ22).
 *
 * Adoption is an ALLOWLIST: a field the sanitizer does not name is dropped on restore.
 * That is the right default for hostile input, but it means adding an optional field to
 * ThreadRecord or EpisodeRecord and forgetting the sanitizer costs the field silently on
 * every session restart — no crash, no warning, and a required field would be caught by
 * the return type while an optional one would not.
 *
 * These maps close that: `satisfies Record<keyof Required<T>, true>` fails to compile
 * both ways — a MISSING key (the new field nobody adopted) and an EXTRA one (a field
 * that was removed from the record). The value is deliberately `true` and nothing more;
 * the map is a checklist for the compiler, not a schema, and each sanitizer must still
 * decide what its fields mean. Keep the keys in record order so the diff reads as a
 * checklist too.
 *
 * EXPORTED so a checker can walk them: hand a sanitizer a record with every field valid
 * and every key here must come back, which is the same claim from the outside and needs
 * no type checker at all.
 */
export const ADOPTED_THREAD_FIELDS = {
	id: true,
	name: true,
	sessionFile: true,
	status: true,
	type: true,
	restartOf: true,
	restartGeneration: true,
	supersededBy: true,
	model: true,
	baseModel: true,
	baseEffort: true,
	cacheKeyShard: true,
	tools: true,
	choiceEvidenceStale: true,
	episodeIds: true,
	episodeSeq: true,
	createdAt: true,
	updatedAt: true,
} satisfies Record<keyof Required<ThreadRecord>, true>;

export const ADOPTED_EPISODE_FIELDS = {
	id: true,
	threadId: true,
	task: true,
	status: true,
	file: true,
	model: true,
	effort: true,
	effortUnmeasured: true,
	observations: true,
	input: true,
	output: true,
	cacheRead: true,
	cacheWrite: true,
	contextTokens: true,
	workerCostUsd: true,
	compressorUsage: true,
	compressorCostUsd: true,
	compactionUsage: true,
	compactionCostUsd: true,
	createdAt: true,
} satisfies Record<keyof Required<EpisodeRecord>, true>;

/**
 * The RUNTIME half, and the reason the witnesses are values and not pure types: this
 * repo has no compile step (pi loads TypeScript through jiti, which strips types without
 * checking them), so a `satisfies` failure is a red squiggle in an editor and nothing
 * more. Worse, the obvious way to silence that squiggle — adding the key to the map —
 * fixes the checklist without teaching the sanitizer anything, and the field is dropped
 * as silently as before.
 *
 * So the checklist is also enforced against what the sanitizer actually BUILT: a field
 * the snapshot carries, that adoption claims to know, that the built record lacks, and
 * that was not deliberately refused (those are already reported by name) is a slate bug,
 * and it says so. Cheap — one pass over ten keys per record — and it fires on the first
 * restore after the omission rather than whenever the missing data is next needed.
 *
 * Exported for the same reason as the checklists: a checker can drive it with a record
 * that is deliberately missing a handled field, which is the one situation this codebase
 * cannot produce on purpose.
 */
export function noteUnadoptedFields(
	kind: "thread" | "episode",
	id: string,
	raw: Record<string, unknown>,
	built: object,
	refused: Set<string>,
	repairs: string[],
): void {
	const known = Object.keys(kind === "thread" ? ADOPTED_THREAD_FIELDS : ADOPTED_EPISODE_FIELDS);
	const adopted = new Set(Object.keys(built));
	for (const field of known) {
		if (raw[field] === undefined || adopted.has(field) || refused.has(field)) continue;
		repairs.push(`${kind} ${id}: field ${field} is in the snapshot but adoption does not handle it (slate bug) — its value is lost`);
	}
	// Deliberately NOT reported: a key this version knows nothing about. That is a
	// snapshot from a different slate version, nothing of this version's is at risk, and
	// on a downgrade the notice would fire for every field of every record.
}

/**
 * One adopted thread record, or undefined when it cannot be addressed at all (no id).
 * `repairs` collects a human-readable note per dropped field so a corrupted snapshot is
 * VISIBLE rather than silently reshaped.
 */
export function sanitizeThreadRecord(raw: unknown, repairs: string[]): ThreadRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const t = raw as Record<string, unknown>;
	const id = str(t.id);
	if (id === undefined || id === "") return undefined; // unaddressable: nothing can refer to it
	if (!isSafeThreadId(id)) {
		repairs.push(`thread ${sanitizeForNotify(id, 80)}: invalid id cannot form a canonical episode filename — remove or rename this record`);
		return undefined;
	}
	const refused = new Set<string>();
	const note = (field: string, value: unknown) => {
		refused.add(field);
		repairs.push(`thread ${id}: ignoring ${field} (${typeof value === "object" ? "object" : typeof value})`);
	};
	const keep = <T>(field: string, value: unknown, parsed: T | undefined): T | undefined => {
		if (value !== undefined && parsed === undefined) note(field, value);
		return parsed;
	};
	const episodeIds = Array.isArray(t.episodeIds) ? t.episodeIds.filter((e): e is string => typeof e === "string") : [];
	if (t.episodeIds !== undefined && !Array.isArray(t.episodeIds)) note("episodeIds", t.episodeIds);
	const tools = keep("tools", t.tools, stringList(t.tools));
	const lineageId = (field: "restartOf" | "supersededBy"): string | undefined => {
		const value = t[field];
		return keep(field, value, isCanonicalThreadId(value) && value !== id ? value : undefined);
	};
	let restartOf = lineageId("restartOf");
	let restartGeneration = keep(
		"restartGeneration",
		t.restartGeneration,
		typeof t.restartGeneration === "number" && Number.isSafeInteger(t.restartGeneration) && t.restartGeneration >= 1
			? t.restartGeneration
			: undefined,
	);
	if ((restartOf === undefined) !== (restartGeneration === undefined)) {
		if (restartOf !== undefined) refused.add("restartOf");
		if (restartGeneration !== undefined) refused.add("restartGeneration");
		repairs.push(`thread ${id}: ignoring incomplete restart lineage (restartOf and restartGeneration must appear together)`);
		restartOf = undefined;
		restartGeneration = undefined;
	}
	const supersededBy = lineageId("supersededBy");
	const now = Date.now();
	const built: ThreadRecord = {
		id,
		name: keep("name", t.name, str(t.name)) ?? id,
		sessionFile: keep("sessionFile", t.sessionFile, str(t.sessionFile)) ?? "",
		status: "idle",
		// Vocabulary is resolved only at the point of use. Adoption follows the
		// model/base-effort precedent and rejects only a non-string value.
		...(keep("type", t.type, str(t.type)) !== undefined ? { type: str(t.type) as ThreadType } : {}),
		...(restartOf !== undefined && restartGeneration !== undefined ? { restartOf, restartGeneration } : {}),
		...(supersededBy !== undefined ? { supersededBy } : {}),
		...(keep("model", t.model, str(t.model)) !== undefined ? { model: str(t.model) } : {}),
		...(keep("baseModel", t.baseModel, str(t.baseModel)) !== undefined ? { baseModel: str(t.baseModel) } : {}),
		// The LEVEL's vocabulary is re-checked by the reader (route.ts's storedLevel, BG21);
		// this boundary only refuses a value that is not a string at all, so the vocabulary
		// stays defined in exactly one place.
		...(keep("baseEffort", t.baseEffort, str(t.baseEffort)) !== undefined ? { baseEffort: str(t.baseEffort) as ThinkingLevel } : {}),
		...(keep(
			"cacheKeyShard",
			t.cacheKeyShard,
			typeof t.cacheKeyShard === "number" &&
				Number.isInteger(t.cacheKeyShard) &&
				t.cacheKeyShard >= 0 &&
				t.cacheKeyShard < MAX_CACHE_KEY_SHARDS
				? t.cacheKeyShard
				: undefined,
		) !== undefined
			? { cacheKeyShard: t.cacheKeyShard as number }
			: {}),
		...(tools !== undefined ? { tools } : {}),
		...(keep("choiceEvidenceStale", t.choiceEvidenceStale, t.choiceEvidenceStale === true ? (true as const) : undefined) !== undefined
			? { choiceEvidenceStale: true as const }
			: {}),
		episodeIds,
		episodeSeq: keep("episodeSeq", t.episodeSeq, counter(t.episodeSeq)) ?? episodeIds.length,
		createdAt: keep("createdAt", t.createdAt, num(t.createdAt)) ?? now,
		updatedAt: keep("updatedAt", t.updatedAt, num(t.updatedAt)) ?? now,
	};
	noteUnadoptedFields("thread", id, t, built, refused, repairs); // CQ22
	return built;
}

/**
 * One adopted episode record, or undefined when it cannot be addressed or filed. Same
 * discipline as the thread record above: a wrong-typed field is refused BY NAME (so the
 * repair is visible, and so the CQ22 coverage check can tell a deliberate refusal from
 * an unhandled field), and the record type's own checklist is enforced at the end.
 */
export function sanitizeEpisodeRecord(raw: unknown, repairs: string[]): EpisodeRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const e = raw as Record<string, unknown>;
	const id = str(e.id);
	const threadId = str(e.threadId);
	const file = str(e.file);
	if (id === undefined || id === "" || threadId === undefined || file === undefined) return undefined;
	const refused = new Set<string>();
	const keep = <T>(field: string, value: unknown, parsed: T | undefined): T | undefined => {
		if (value !== undefined && parsed === undefined) {
			refused.add(field);
			repairs.push(`episode ${id}: ignoring ${field} (${typeof value === "object" ? "object" : typeof value})`);
		}
		return parsed;
	};
	const observations = keep("observations", e.observations, observationRecord(e.observations, id));
	const nestedUsage = (name: "compressorUsage" | "compactionUsage", value: unknown): EpisodeUsage | undefined => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const raw = value as Record<string, unknown>;
		const usage: EpisodeUsage = {};
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const parsed = tokenQuantity(raw[field]);
			if (raw[field] !== undefined && parsed === undefined) {
				repairs.push(`episode ${id}: ignoring ${name}.${field} (${typeof raw[field]})`);
			} else if (parsed !== undefined) {
				usage[field] = parsed;
			}
		}
		return usage;
	};
	const compressorUsage = keep("compressorUsage", e.compressorUsage, nestedUsage("compressorUsage", e.compressorUsage));
	const compactionUsage = keep("compactionUsage", e.compactionUsage, nestedUsage("compactionUsage", e.compactionUsage));
	const built: EpisodeRecord = {
		id,
		threadId,
		task: keep("task", e.task, str(e.task)) ?? "",
		// A status that is neither of the two words reads as "ok": the record exists, so
		// something ran, and inventing a failure would be worse than ignoring the value.
		status: keep("status", e.status, e.status === "failed" || e.status === "ok" ? e.status : undefined) ?? "ok",
		file,
		...(keep("model", e.model, str(e.model)) !== undefined ? { model: str(e.model) } : {}),
		...(keep("effort", e.effort, str(e.effort)) !== undefined ? { effort: str(e.effort) as ThinkingLevel } : {}),
		...(keep("effortUnmeasured", e.effortUnmeasured, e.effortUnmeasured === true ? (true as const) : undefined) !== undefined
			? { effortUnmeasured: true as const }
			: {}),
		...(observations !== undefined ? { observations } : {}),
		...(keep("input", e.input, tokenQuantity(e.input)) !== undefined ? { input: tokenQuantity(e.input) } : {}),
		...(keep("output", e.output, tokenQuantity(e.output)) !== undefined ? { output: tokenQuantity(e.output) } : {}),
		...(keep("cacheRead", e.cacheRead, tokenQuantity(e.cacheRead)) !== undefined ? { cacheRead: tokenQuantity(e.cacheRead) } : {}),
		...(keep("cacheWrite", e.cacheWrite, tokenQuantity(e.cacheWrite)) !== undefined ? { cacheWrite: tokenQuantity(e.cacheWrite) } : {}),
		...(keep("contextTokens", e.contextTokens, tokenQuantity(e.contextTokens)) !== undefined
			? { contextTokens: tokenQuantity(e.contextTokens) }
			: {}),
		...(keep("workerCostUsd", e.workerCostUsd, moneyAmount(e.workerCostUsd)) !== undefined
			? { workerCostUsd: moneyAmount(e.workerCostUsd) }
			: {}),
		...(compressorUsage !== undefined ? { compressorUsage } : {}),
		...(keep("compressorCostUsd", e.compressorCostUsd, moneyAmount(e.compressorCostUsd)) !== undefined
			? { compressorCostUsd: moneyAmount(e.compressorCostUsd) }
			: {}),
		...(compactionUsage !== undefined ? { compactionUsage } : {}),
		...(keep("compactionCostUsd", e.compactionCostUsd, moneyAmount(e.compactionCostUsd)) !== undefined
			? { compactionCostUsd: moneyAmount(e.compactionCostUsd) }
			: {}),
		createdAt: keep("createdAt", e.createdAt, num(e.createdAt)) ?? Date.now(),
	};
	noteUnadoptedFields("episode", id, e, built, refused, repairs); // CQ22
	return built;
}

/** One contextBudget override. `match` is a regex tested ANCHORED (^(?:match)$) against "provider/id". */
export interface ContextBudgetOverride {
	match: string;
	tokens: number;
}

export interface ContextBudgetObject {
	tokens?: number; // absolute token budget for models not caught by an override
	overrides?: ContextBudgetOverride[]; // first matching entry wins
}

/**
 * Action-level model router (D4/D53). `models` is the CLOSED list of models the
 * router may route an action to, in canonical "provider/id" form; empty or
 * absent means the router is OFF, so no candidate list or router-owned base,
 * window, billing or substitution mechanism applies. Per-action arguments and
 * pre-existing failover remain outside that feature-off statement.
 * `allowUnmeasuredEffort` (default TRUE) decides what the dispatch path does
 * with an effort level that is ladder-valid but has no capability evidence —
 * an evidence gap is advisory, not a prohibition. `showWarnings` (default
 * FALSE) reveals the router's MODEL DATA NOTES — the warnings a user cannot stop
 * by changing this file or their pi credentials. A configuration fault is always
 * shown, whatever this key says. Validated by sanitizeRouterConfig in
 * model-router.ts.
 */
export interface RouterConfig {
	models?: string[];
	allowUnmeasuredEffort?: boolean;
	showWarnings?: boolean;
}

/** Reporting and automatic action for the thread-choice verdict. */
export interface ThreadChoiceConfig {
	report?: boolean;
	act?: boolean;
}

/** Optional raw workflow publishing and follow-up issue controls. */
export interface WorkflowConfig {
	draftPRs?: boolean;
	followUpIssues?: boolean;
}

/** Sanitized workflow shape. draftPRs stays unvalidated until issue 164 resolves it. */
export interface SanitizedWorkflowConfig {
	draftPRs?: unknown;
	followUpIssues: boolean;
}

/** Display a rejected workflow value without letting serialization abort session startup. */
function quotedWorkflowValue(value: unknown): string {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		text = undefined;
	}
	if (text === undefined) {
		try {
			text = String(value);
		} catch {
			text = `[unprintable ${typeof value}]`;
		}
	}
	return sanitizeForNotify(text);
}

/** Validate the follow-up issue switch while preserving an own draft publishing value. */
export function sanitizeWorkflowConfig(raw: unknown, warn: (msg: string) => void): SanitizedWorkflowConfig {
	if (raw === undefined) return { followUpIssues: false };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { followUpIssues: false };
	const value = raw as { draftPRs?: unknown; followUpIssues?: unknown };
	const hasOwn = (key: "draftPRs" | "followUpIssues") => Object.prototype.hasOwnProperty.call(value, key);
	const draftPRs = hasOwn("draftPRs") ? { draftPRs: value.draftPRs } : {};
	const candidate = hasOwn("followUpIssues") ? value.followUpIssues : undefined;
	if (candidate === undefined) return { ...draftPRs, followUpIssues: false };
	if (typeof candidate === "boolean") return { ...draftPRs, followUpIssues: candidate };
	warn(
		`slate: ignoring workflow.followUpIssues ${quotedWorkflowValue(candidate)}. Expected true or false. Slate uses false.`,
	);
	return { ...draftPRs, followUpIssues: false };
}

/** Optional writing checks and context-cadenced reminders. */
export interface WritingConfig {
	check?: boolean;
	remind?: boolean;
	remindPercent?: number;
}

export interface SlateConfig {
	episodeModel?: string; // "provider/id" for the episode compressor (D5)
	workerTools?: string[];
	workerExtensions?: string[]; // regex patterns selecting which of the HOST session's pi extensions worker threads may load (default [] = none); see worker-extensions.ts
	cacheKeyEnabled?: boolean; // set false to disable prompt cache keys entirely (default true)
	cacheKeyShards?: number; // stable OpenAI prompt-cache routing shard count while enabled (default 2; sanitized to 1..64)
	maxConcurrent?: number; // global cap on concurrently running worker actions (default 4; must be ≥ 1 — unenforced, ≤ 0 silently hangs all dispatches; rationale: docs/design-principles.md §5 repo-local note)
	pauseThresholdPercent?: number; // DEPRECATED: legacy percent-based auto-pause (default 40); applies only when set AND contextBudget is absent or entirely invalid (invalid sanitizes to absent — a partially invalid object stays budget mode)
	contextBudget?: number | ContextBudgetObject; // absolute orchestrator token budget; bare number = { tokens: N }; {} opts into built-in defaults (256k, 400k for anthropic/*) — see handoff.ts
	orchestratorModeDefault?: boolean; // seed orchestrator mode ON for fresh interactive sessions (unsaved until first real mutation)
	orchestratorPromptDocs?: string[]; // role-guideline docs appended to the orchestrator prompt (cwd-relative paths, default none)
	workerPromptDocs?: string[]; // role-guideline docs appended to worker system prompts (cwd-relative paths, default none)
	workflow?: WorkflowConfig | SanitizedWorkflowConfig; // raw or session-sanitized workflow controls (both default false)
	modelFailover?: Record<string, string>; // model→model failover map ("provider/id" → "provider/id"); empty/absent = feature off
	preserveGlobalModelDefault?: boolean; // restore the user's GLOBAL pi model defaults (defaultProvider/defaultModel/defaultThinkingLevel) after a slate-initiated model switch — failover and handoff adoption (default true; only an explicit false disables it) — see model-default.ts
	doctrineExtraPath?: string; // cwd-relative markdown appended to the orchestrator doctrine (project-doctrine section)
	reviewPerspectivesPath?: string; // cwd-relative markdown with additional project-specific review perspectives
	router?: RouterConfig; // action-level model router: the closed model list + the evidence-gap policy (default: off) — see model-router.ts
	threadChoice?: ThreadChoiceConfig; // verdict reporting defaults on; automatic action defaults off
	writing?: WritingConfig; // writing guidance for orchestrator output (default: off) — see writing.ts
}

export class SlateStore {
	threads = new Map<string, ThreadRecord>();
	episodes = new Map<string, EpisodeRecord>();
	private threadSeq = 0;
	private restoredIdentity = sanitizeSnapshotIdentity(undefined, []);
	slateSessionId: string | undefined;
	ownerPiSessionId: string | undefined;
	orchestratorMode = false;
	/** When true (context budget exceeded) ThreadManager rejects NEW dispatches. */
	paused = false;
	/**
	 * Cumulative USD spend of worker threads this session. Includes the episode
	 * compressor's LLM calls, so the "workers" figure shown in the widget covers
	 * compression spend too.
	 */
	workerCostUsd = 0;
	/** Orchestrator spend inherited from ancestor sessions across handoffs. */
	carriedCostUsd = 0;
	/** Session-instance reminder state. It is never part of a snapshot. */
	readonly writingReminder: WritingReminderRuntime = createWritingReminderRuntime();
	/** Invoked after every save/restore; used by mode.ts to refresh the widget. */
	onDidChange?: () => void;

	private pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	nextThreadId(): string {
		let max = this.threadSeq;
		for (const id of this.threads.keys()) {
			const ordinal = canonicalThreadOrdinal(id);
			if (ordinal !== undefined) max = Math.max(max, ordinal);
		}
		return `t${max + 1}`;
	}

	claimNextThreadId(): string {
		const id = this.nextThreadId();
		this.threadSeq = Number(id.slice(1));
		return id;
	}

	resolveSessionIdentity(
		currentPiSessionId: string,
		report: (message: string) => void,
		mint: () => string = mintSlateSessionId,
	): boolean {
		// Public fields may have been re-stamped by explicit handoff adoption.
		const restored: SanitizedSnapshotIdentity = {
			...this.restoredIdentity,
			...(this.slateSessionId !== undefined ? { slateSessionIdPresent: true, slateSessionId: this.slateSessionId } : {}),
			...(this.ownerPiSessionId !== undefined
				? { ownerPiSessionIdPresent: true, ownerPiSessionId: this.ownerPiSessionId }
				: {}),
		};
		const resolved = resolveSlateSessionIdentity(restored, currentPiSessionId, mint);
		this.slateSessionId = resolved.slateSessionId;
		this.ownerPiSessionId = resolved.ownerPiSessionId;
		this.restoredIdentity = {
			snapshotPresent: true,
			slateSessionIdPresent: resolved.slateSessionId !== undefined,
			ownerPiSessionIdPresent: resolved.ownerPiSessionId !== undefined,
			...(resolved.slateSessionId !== undefined ? { slateSessionId: resolved.slateSessionId } : {}),
			...(resolved.ownerPiSessionId !== undefined ? { ownerPiSessionId: resolved.ownerPiSessionId } : {}),
		};
		if (resolved.report !== undefined) report(resolved.report);
		return resolved.minted;
	}

	snapshot(): SlateSnapshot {
		return {
			threads: [...this.threads.values()].map((t) => ({ ...t, status: "idle" as const })),
			episodes: [...this.episodes.values()],
			threadSeq: this.threadSeq,
			...(this.slateSessionId !== undefined ? { slateSessionId: this.slateSessionId } : {}),
			...(this.ownerPiSessionId !== undefined ? { ownerPiSessionId: this.ownerPiSessionId } : {}),
			orchestratorMode: this.orchestratorMode,
			paused: this.paused,
			workerCostUsd: this.workerCostUsd,
			carriedCostUsd: this.carriedCostUsd,
		};
	}

	save(): void {
		this.pi.appendEntry("slate-state", this.snapshot() as unknown as Record<string, unknown>);
		this.onDidChange?.();
	}

	/** Rebuild from the last slate-state entry on the current branch. */
	restore(ctx: ExtensionContext): void {
		let latest: SlateSnapshot | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const e = entry as { type: string; customType?: string; data?: unknown };
			if (e.type === "custom" && e.customType === "slate-state" && e.data) {
				latest = e.data as SlateSnapshot;
			}
		}
		this.adoptSnapshot(latest, ctx);
		// Cost counters are NOT branch-scoped like the records above: money never
		// un-spends, and dispatches on now-abandoned branches were still billed.
		// Take the MAX over ALL slate-state entries (both counters are monotonic
		// within a session file) so a branch switch cannot roll them back.
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as {
				type: string;
				customType?: string;
				data?: { workerCostUsd?: number; carriedCostUsd?: number };
			};
			if (e.type !== "custom" || e.customType !== "slate-state") continue;
			this.workerCostUsd = Math.max(this.workerCostUsd, e.data?.workerCostUsd ?? 0);
			this.carriedCostUsd = Math.max(this.carriedCostUsd, e.data?.carriedCostUsd ?? 0);
		}
	}

	/**
	 * Replace all state with a snapshot (undefined clears), dropping records
	 * whose files vanished. Shared by restore() and the cross-session handoff
	 * adoption in handoff.ts.
	 */
	adoptSnapshot(latest: SlateSnapshot | undefined, ctx: ExtensionContext): void {
		this.threads.clear();
		this.episodes.clear();
		this.threadSeq = 0;
		this.restoredIdentity = sanitizeSnapshotIdentity(undefined, []);
		this.slateSessionId = undefined;
		this.ownerPiSessionId = undefined;
		this.orchestratorMode = false;
		this.paused = false;
		this.workerCostUsd = 0;
		this.carriedCostUsd = 0;
		if (!latest) return;

		this.orchestratorMode = latest.orchestratorMode ?? false;
		this.paused = latest.paused ?? false;
		// ?? 0: old snapshots lack the cost fields.
		this.workerCostUsd = latest.workerCostUsd ?? 0;
		this.carriedCostUsd = latest.carriedCostUsd ?? 0;
		this.threadSeq = counter(latest.threadSeq) ?? 0;
		const dropped: string[] = [];
		this.restoredIdentity = sanitizeSnapshotIdentity(latest, dropped);
		this.slateSessionId = this.restoredIdentity.slateSessionId;
		this.ownerPiSessionId = this.restoredIdentity.ownerPiSessionId;
		// EVERY record is validated field by field on the way in (BG26) — see
		// sanitizeThreadRecord. Nothing downstream re-checks these types, so a snapshot
		// that has been hand-edited, truncated or written by another version must be made
		// safe HERE; the alternative was an exception thrown out of the `thread` tool from
		// inside a warning message.
		const threadList = Array.isArray(latest.threads) ? latest.threads : [];
		for (const raw of threadList) {
			const repairsBefore = dropped.length;
			const t = sanitizeThreadRecord(raw, dropped);
			if (t === undefined) {
				if (dropped.length === repairsBefore) {
					dropped.push(`thread record without a usable id: ${typeof raw === "object" ? "ignored" : typeof raw}`);
				}
				continue;
			}
			if (t.sessionFile && !existsSync(t.sessionFile)) {
				dropped.push(`thread ${t.id} (${t.name}): missing ${t.sessionFile}`);
				continue;
			}
			this.threads.set(t.id, t);
			// Old snapshots have no persisted counter. Derive its floor from every
			// surviving generated id before any new thread can claim an ordinal.
			const ordinal = canonicalThreadOrdinal(t.id);
			if (ordinal !== undefined) this.threadSeq = Math.max(this.threadSeq, ordinal);
		}
		// A dangling successor would permanently reject the source thread. Repair it
		// only after every surviving thread is known, since this is a cross-record rule.
		for (const thread of this.threads.values()) {
			if (thread.supersededBy !== undefined && !this.threads.has(thread.supersededBy)) {
				dropped.push(`thread ${thread.id}: ignoring supersededBy ${thread.supersededBy} because that successor is absent`);
				delete thread.supersededBy;
			}
		}
		const episodeList = Array.isArray(latest.episodes) ? latest.episodes : [];
		for (const raw of episodeList) {
			const e = sanitizeEpisodeRecord(raw, dropped);
			if (e === undefined) {
				dropped.push(`episode record without a usable id, thread id or file: ${typeof raw === "object" ? "ignored" : typeof raw}`);
				continue;
			}
			const safeFile = resolveEpisodeFile(ctx.cwd, e.file);
			if (safeFile === undefined) {
				dropped.push(`episode ${e.id}: file is missing, non-regular, or outside slate's episode directory`);
				continue;
			}
			if (!this.threads.has(e.threadId)) continue;
			e.file = safeFile;
			this.episodes.set(e.id, e);
		}
		// Prune episode ids that did not survive.
		for (const t of this.threads.values()) {
			t.episodeIds = t.episodeIds.filter((id) => this.episodes.has(id));
		}
		if (dropped.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`slate: dropped or repaired stale records:\n${dropped.join("\n")}`, "warning");
		}
		this.onDidChange?.();
	}
}

/**
 * Orchestrator spend recorded in the session file: billed LINEAGE spend —
 * summed over ALL entries including abandoned branches (forked/cloned sessions
 * thus inherit parent-file spend as their own). EXCLUDES pi-internal LLM calls
 * stored as non-message entries (compaction, branch summarization).
 * Shared by the widget (mode.ts) and handoff carry (handoff.ts).
 */
export function orchestratorCostUsd(ctx: ExtensionContext): number {
	let cost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		// Loose cast + optional chaining: tolerate malformed/legacy entries.
		const e = entry as { type: string; message?: { role?: string; usage?: { cost?: { total?: number } } } };
		if (e.type === "message" && e.message?.role === "assistant") {
			cost += e.message.usage?.cost?.total ?? 0;
		}
	}
	return cost;
}
