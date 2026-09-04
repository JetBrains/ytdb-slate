/**
 * Slate state: thread/episode records, session-scoped persistence.
 *
 * PERSISTENCE MODEL (Track 14). The records live in ONE external namespace, a
 * directory outside the project directory. Startup asks the runtime authority
 * check for a storage report (runtime-authority.ts) and the store follows it: a
 * valid locator note on the active Pi branch restores every record from the
 * namespace it names, no locator note prepares a namespace without creating a
 * directory, and unsafe evidence leaves the store REFUSING every save. The Pi
 * conversation holds the locator note and no record copy.
 *
 * `commit()` is the one production save. It uses the three-step contract:
 * revalidate the selected namespace, fill the private draft of one mutation
 * permit, then save that permit. The first accepted change creates the namespace
 * and then writes one locator note.
 *
 */

import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// TYPE-ONLY: the effort vocabulary is defined once, in the profile table
// (model-profiles.ts, digest §V), and is identical to pi's own ThinkingLevel
// union. The import is erased at load time. State restoration therefore keeps
// no runtime dependency on model-profiles.ts (see the model-spec note below).
import type { ThinkingLevel } from "./model-profiles.ts";
import type { ObservationRecord } from "./observations.ts";
import { sanitizeForNotify } from "./notify.ts";
import {
	isSafeThreadId,
	isSlateArtifactReference,
	slateArtifactReference,
	slateEpisodeId,
} from "./artifact-names.ts";
import { resolveResearchLogPath } from "./research-log.ts";
import { createWritingReminderRuntime, type WritingReminderRuntime } from "./writing-reminder.ts";
import {
	resolveContainedFile,
	type CorpusProject,
} from "./corpus.ts";
import { drawSlateMint, isSlateSessionName } from "./session-names.ts";
import {
	isOwnerSessionDigest,
	isSlateSessionId,
} from "./session-identity.ts";
export { OWNER_SESSION_DIGEST_PATTERN, SLATE_SESSION_ID_PATTERN } from "./session-identity.ts";

/**
 * ADDITIVE TOLERANCE (the persistence model has no migration hook): stored
 * records are unversioned, so a record read from an older external namespace
 * simply lacks whatever fields were added since. Every field added to
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
	status: "queued" | "running" | "successful" | "failed" | "cancelled";
	/** Immutable thread type. */
	type: ThreadType;
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
	 * back: this record is read from unversioned, hand-editable storage, so the
	 * reader (route.ts) re-validates the value against pi's vocabulary and treats
	 * anything else as absent — the same discipline the model fields get from the
	 * spec helpers below (BG21).
	 */
	baseEffort?: ThinkingLevel;
	/** Stable OpenAI prompt-cache routing shard. Absent means caching predates this field. */
	cacheKeyShard?: number;
	/** Effective built-in worker tool allowlist. Absent means an older thread whose tools are unknown. */
	tools?: string[];
	/** The action's only episode. Absent only before work starts or after an unbilled abort. */
	episodeId?: string;
	/** Failure or cancellation reason. */
	outcomeReason?: string;
	createdAt: number;
	updatedAt: number;
}

function copyThreadRecord(record: ThreadRecord): ThreadRecord {
	return {
		id: record.id,
		name: record.name,
		status: record.status,
		type: record.type,
		...(record.model !== undefined ? { model: record.model } : {}),
		...(record.baseModel !== undefined ? { baseModel: record.baseModel } : {}),
		...(record.baseEffort !== undefined ? { baseEffort: record.baseEffort } : {}),
		...(record.cacheKeyShard !== undefined ? { cacheKeyShard: record.cacheKeyShard } : {}),
		...(record.tools !== undefined ? { tools: record.tools } : {}),
		...(record.episodeId !== undefined ? { episodeId: record.episodeId } : {}),
		...(record.outcomeReason !== undefined ? { outcomeReason: record.outcomeReason } : {}),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
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

export interface SlateSessionParent {
	identity: string;
	name: string;
}

function identityFromBytes(now: Date, bytes: Uint8Array): string {
	const timestamp = `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
	return `${timestamp}-${Buffer.from(bytes).toString("hex")}`;
}

/** Mint a sortable identity and first name candidate from one twelve-byte draw. */
export function mintSlateSession(now = new Date()): { identity: string; nameBytes: Buffer } {
	const drawn = drawSlateMint(12);
	return { identity: identityFromBytes(now, drawn.identityBytes), nameBytes: drawn.nameBytes };
}

export function mintSlateSessionId(now = new Date()): string {
	return mintSlateSession(now).identity;
}

/**
 * Bind ownership to both pi's identifier and its resolved session-file path.
 * The identifier is hashed first, so NUL cannot occur in either joined value.
 * Moving a session file changes this digest and mints a fresh identity on resume.
 * That loss of continuity is fail-safe because ownership can no longer be proved.
 */
export function createOwnerSessionDigest(piSessionId: string, sessionFile: string | undefined): string {
	const idDigest = createHash("sha256").update(piSessionId).digest("hex");
	const resolvedSessionFile = sessionFile === undefined ? "" : resolve(sessionFile);
	return createHash("sha256").update(idDigest).update("\0").update(resolvedSessionFile).digest("hex");
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
 * ADOPTION-BOUNDARY VALIDATION (BG26). External records are JSON on disk: unversioned,
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
function tokenQuantity(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}
function moneyAmount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Resolve a regular followed file within the corpus project or legacy flat layout. */
export function resolveEpisodeFile(cwd: string, value: unknown, projectDirectory?: string): string | undefined {
	return resolveContainedFile(cwd, value, projectDirectory);
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
	status: true,
	type: true,
	model: true,
	baseModel: true,
	baseEffort: true,
	cacheKeyShard: true,
	tools: true,
	episodeId: true,
	outcomeReason: true,
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
 * the stored record carries, that adoption claims to know, that the built record lacks, and
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
		repairs.push(`${kind} ${id}: field ${field} is in storage but adoption does not handle it (slate bug) — its value is lost`);
	}
	// Deliberately NOT reported: a key this version knows nothing about. That is a
	// record from a different Slate version, nothing of this version's is at risk, and
	// on a downgrade the notice would fire for every field of every record.
}

/**
 * One adopted thread record, or undefined when it cannot be addressed at all (no id).
 * `repairs` collects a human-readable note per dropped field so a corrupted stored record is
 * VISIBLE rather than silently reshaped.
 */
export interface ThreadRecordSanitizeOptions {
	/**
	 * Keep a `queued` or `running` status instead of normalizing it to `failed`.
	 *
	 * A LIVE action is legitimately queued or running, and external storage must be
	 * able to hold it: Slate saves a worker thread BEFORE it starts the worker
	 * session, so the strict external decoder (decodeCanonicalRuntime) would
	 * otherwise refuse every dispatch. "Unfinished means failed" is a RESTORE rule
	 * and not a storage rule, so the state store applies it when it adopts a
	 * namespace at startup and not here.
	 */
	readonly preserveUnfinished?: boolean;
}

export function sanitizeThreadRecord(
	raw: unknown,
	repairs: string[],
	options: ThreadRecordSanitizeOptions = {},
): ThreadRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const t = raw as Record<string, unknown>;
	const id = str(t.id);
	if (id === undefined || !isCanonicalThreadId(id)) {
		repairs.push("thread record: invalid id");
		return undefined;
	}
	const name = str(t.name);
	const type = isThreadType(t.type) ? t.type : undefined;
	const status = typeof t.status === "string" && (["queued", "running", "successful", "failed", "cancelled"] as const).includes(t.status as ThreadRecord["status"])
		? t.status as ThreadRecord["status"]
		: undefined;
	if (name === undefined || type === undefined || status === undefined) {
		const field = name === undefined ? "name" : type === undefined ? "type" : "status";
		repairs.push(`thread ${id}: invalid ${field}`);
		return undefined;
	}
	const refused = new Set<string>();
	const keep = <T>(field: string, value: unknown, parsed: T | undefined): T | undefined => {
		if (value !== undefined && parsed === undefined) {
			refused.add(field);
			repairs.push(`thread ${id}: ignoring ${field} (${typeof value === "object" ? "object" : typeof value})`);
		}
		return parsed;
	};
	const tools = keep("tools", t.tools, stringList(t.tools));
	const parsedEpisodeId = keep("episodeId", t.episodeId, str(t.episodeId));
	const episodeId = parsedEpisodeId === undefined || parsedEpisodeId === slateEpisodeId(id) ? parsedEpisodeId : undefined;
	if (parsedEpisodeId !== undefined && episodeId === undefined) {
		refused.add("episodeId");
		repairs.push(`thread ${id}: ignoring episodeId because it is not ${id}.e1`);
	}
	let outcomeReason = keep("outcomeReason", t.outcomeReason, str(t.outcomeReason));
	let adoptedStatus = status;
	if ((status === "running" || status === "queued") && options.preserveUnfinished !== true) {
		adoptedStatus = "failed";
		outcomeReason = "the session ended before the action finished";
		repairs.push(`thread ${id}: normalized unfinished ${status} action to failed`);
	} else if (status === "successful" && episodeId === undefined) {
		adoptedStatus = "failed";
		outcomeReason = "the stored successful action has no valid episode id";
		repairs.push(`thread ${id}: normalized successful action without a valid episode id to failed`);
	}
	const now = Date.now();
	const model = keep("model", t.model, str(t.model));
	const baseModel = keep("baseModel", t.baseModel, str(t.baseModel));
	const baseEffort = keep("baseEffort", t.baseEffort, str(t.baseEffort)) as ThinkingLevel | undefined;
	const cacheKeyShard = keep("cacheKeyShard", t.cacheKeyShard, typeof t.cacheKeyShard === "number" && Number.isInteger(t.cacheKeyShard) && t.cacheKeyShard >= 0 && t.cacheKeyShard < MAX_CACHE_KEY_SHARDS
		? t.cacheKeyShard : undefined);
	const built = copyThreadRecord({
		id,
		name,
		status: adoptedStatus,
		type,
		model,
		baseModel,
		baseEffort,
		cacheKeyShard,
		tools,
		episodeId,
		outcomeReason,
		createdAt: keep("createdAt", t.createdAt, num(t.createdAt)) ?? now,
		updatedAt: keep("updatedAt", t.updatedAt, num(t.updatedAt)) ?? now,
	});
	noteUnadoptedFields("thread", id, t, built, refused, repairs);
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
	if (!isCanonicalThreadId(threadId) || id !== slateEpisodeId(threadId)) {
		repairs.push(`episode ${id || "record"}: id must be the thread's canonical .e1 id`);
		return undefined;
	}
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

/** Complete new-policy runtime state after strict external decoding. */
export interface CanonicalRuntimeState {
	threads: ThreadRecord[];
	episodes: EpisodeRecord[];
	threadSeq: number;
	slateSessionParentChain: SlateSessionParent[];
	orchestratorMode: boolean;
	paused: boolean;
	workerCostUsd: number;
	carriedCostUsd: number;
}

/** External facts and binding expectations needed to decode one runtime payload. */
export type CanonicalRuntimeArtifactKind = "episode" | "observation";

export interface CanonicalRuntimeDecodeOptions {
	runtime: unknown;
	externalIdentity: unknown;
	expectedIdentity: string;
	namespaceName: string;
	namespaceDirectory: string;
	/** Caller-supplied existence, containment, regular-file, and link check. */
	artifactPathAllowed: (kind: CanonicalRuntimeArtifactKind, absolutePath: string) => boolean;
}

export class CanonicalRuntimeDecodeError extends Error {
	constructor(message: string) {
		super(`slate refused canonical runtime state: ${message}`);
		this.name = "CanonicalRuntimeDecodeError";
	}
}

const CANONICAL_RUNTIME_KEYS = [
	"threads",
	"episodes",
	"threadSeq",
	"slateSessionParentChain",
	"orchestratorMode",
	"paused",
	"workerCostUsd",
	"carriedCostUsd",
] as const;
const CANONICAL_THREAD_REQUIRED = ["id", "name", "status", "type", "createdAt", "updatedAt"] as const;
const CANONICAL_EPISODE_REQUIRED = ["id", "threadId", "task", "status", "file", "createdAt"] as const;

function canonicalRuntimeRefuse(message: string): never {
	throw new CanonicalRuntimeDecodeError(message);
}

function exactCanonicalKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	required: readonly string[] = allowed,
): boolean {
	const keys = Object.keys(value);
	return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function canonicalObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INVALID_CANONICAL_DATA = Symbol("invalid-canonical-data");

/** Detach persisted plain data before strict schema validation. */
function copyCanonicalData(value: unknown): unknown | typeof INVALID_CANONICAL_DATA {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? INVALID_CANONICAL_DATA : JSON.parse(text);
	} catch {
		return INVALID_CANONICAL_DATA;
	}
}

function canonicalArtifactAllowed(
	options: CanonicalRuntimeDecodeOptions,
	kind: CanonicalRuntimeArtifactKind,
	absolutePath: string,
): boolean {
	try {
		return options.artifactPathAllowed(kind, absolutePath) === true;
	} catch {
		return false;
	}
}

function decodeCanonicalThread(raw: unknown, index: number): ThreadRecord {
	if (!canonicalObject(raw)) canonicalRuntimeRefuse(`thread ${index} is not an object`);
	if (!exactCanonicalKeys(raw, Object.keys(ADOPTED_THREAD_FIELDS), CANONICAL_THREAD_REQUIRED)) {
		canonicalRuntimeRefuse(`thread ${index} has missing or unknown fields`);
	}
	const repairs: string[] = [];
	// A queued or running action is legitimate external state (see
	// ThreadRecordSanitizeOptions), so this decode keeps it and the state store
	// normalizes it when it adopts the namespace.
	const decoded = sanitizeThreadRecord(raw, repairs, { preserveUnfinished: true });
	const normalized = decoded === undefined ? INVALID_CANONICAL_DATA : copyCanonicalData(decoded);
	if (decoded === undefined || repairs.length > 0 || !isDeepStrictEqual(normalized, raw)) {
		canonicalRuntimeRefuse(`thread ${String(raw.id ?? index)} requires sanitizer repair${repairs.length > 0 ? `: ${repairs.join("; ")}` : ""}`);
	}
	return decoded;
}

function decodeCanonicalEpisode(raw: unknown, index: number): EpisodeRecord {
	if (!canonicalObject(raw)) canonicalRuntimeRefuse(`episode ${index} is not an object`);
	if (!exactCanonicalKeys(raw, Object.keys(ADOPTED_EPISODE_FIELDS), CANONICAL_EPISODE_REQUIRED)) {
		canonicalRuntimeRefuse(`episode ${index} has missing or unknown fields`);
	}
	const repairs: string[] = [];
	const decoded = sanitizeEpisodeRecord(raw, repairs);
	const normalized = decoded === undefined ? INVALID_CANONICAL_DATA : copyCanonicalData(decoded);
	if (decoded === undefined || repairs.length > 0 || !isDeepStrictEqual(normalized, raw)) {
		canonicalRuntimeRefuse(`episode ${String(raw.id ?? index)} requires sanitizer repair${repairs.length > 0 ? `: ${repairs.join("; ")}` : ""}`);
	}
	return raw as unknown as EpisodeRecord;
}

/**
 * Strictly decode new-policy external state without repairing it or consulting Pi.
 *
 * Lexical checks bind each artifact to this namespace. The injected physical check
 * requires every declared artifact to exist as an accepted, unlinked regular file.
 */
export function decodeCanonicalRuntime(options: CanonicalRuntimeDecodeOptions): CanonicalRuntimeState {
	if (!isSlateSessionId(options.expectedIdentity) || options.externalIdentity !== options.expectedIdentity) {
		canonicalRuntimeRefuse("external identity does not match the selected binding");
	}
	const namespaceDirectory = options.namespaceDirectory;
	if (!isSlateSessionName(options.namespaceName) || !isAbsolute(namespaceDirectory)
		|| resolve(namespaceDirectory) !== namespaceDirectory || basename(namespaceDirectory) !== options.namespaceName) {
		canonicalRuntimeRefuse("namespace location is invalid");
	}
	const snapshot = copyCanonicalData(options.runtime);
	if (snapshot === INVALID_CANONICAL_DATA) canonicalRuntimeRefuse("runtime is not plain JSON data");
	if (!canonicalObject(snapshot)) canonicalRuntimeRefuse("runtime root is not an object");
	const raw = snapshot;
	if (!exactCanonicalKeys(raw, CANONICAL_RUNTIME_KEYS)) {
		canonicalRuntimeRefuse("runtime root has missing or unknown fields");
	}
	if (!Array.isArray(raw.threads) || !Array.isArray(raw.episodes)) {
		canonicalRuntimeRefuse("thread and episode collections must be arrays");
	}
	if (!Number.isSafeInteger(raw.threadSeq) || (raw.threadSeq as number) < 0) {
		canonicalRuntimeRefuse("threadSeq is not a non-negative safe integer");
	}
	if (typeof raw.orchestratorMode !== "boolean" || typeof raw.paused !== "boolean") {
		canonicalRuntimeRefuse("mode fields are not booleans");
	}
	if (moneyAmount(raw.workerCostUsd) === undefined || moneyAmount(raw.carriedCostUsd) === undefined) {
		canonicalRuntimeRefuse("cost fields are not non-negative finite numbers");
	}
	if (!Array.isArray(raw.slateSessionParentChain)) canonicalRuntimeRefuse("parent chain is not an array");
	const parents: SlateSessionParent[] = [];
	const parentIdentities = new Set<string>();
	for (const [index, parent] of raw.slateSessionParentChain.entries()) {
		if (!canonicalObject(parent) || !exactCanonicalKeys(parent, ["identity", "name"])
			|| !isSlateSessionId(parent.identity) || !isSlateSessionName(parent.name)) {
			canonicalRuntimeRefuse(`parent ${index} is malformed`);
		}
		if (parent.identity === options.expectedIdentity || parentIdentities.has(parent.identity)) {
			canonicalRuntimeRefuse("parent chain repeats the current or an earlier identity");
		}
		parentIdentities.add(parent.identity);
		parents.push({ identity: parent.identity, name: parent.name });
	}

	const threads = raw.threads.map(decodeCanonicalThread);
	const episodes = raw.episodes.map(decodeCanonicalEpisode);
	const threadById = new Map<string, ThreadRecord>();
	for (const thread of threads) {
		if (threadById.has(thread.id)) canonicalRuntimeRefuse(`duplicate thread identifier ${thread.id}`);
		threadById.set(thread.id, thread);
	}
	const episodeById = new Map<string, EpisodeRecord>();
	for (const episode of episodes) {
		if (episodeById.has(episode.id)) canonicalRuntimeRefuse(`duplicate episode identifier ${episode.id}`);
		episodeById.set(episode.id, episode);
	}

	let maxThreadOrdinal = 0;
	for (const thread of threads) {
		const ordinal = canonicalThreadOrdinal(thread.id);
		if (ordinal !== undefined) maxThreadOrdinal = Math.max(maxThreadOrdinal, ordinal);
		if (thread.episodeId !== undefined) {
			const episode = episodeById.get(thread.episodeId);
			if (episode === undefined || episode.threadId !== thread.id) {
				canonicalRuntimeRefuse(`thread ${thread.id} has a broken episode reference ${thread.episodeId}`);
			}
		}
	}
	if ((raw.threadSeq as number) < maxThreadOrdinal) canonicalRuntimeRefuse("threadSeq is stale");

	for (const episode of episodes) {
		const thread = threadById.get(episode.threadId);
		if (thread?.episodeId !== episode.id) {
			canonicalRuntimeRefuse(`episode ${episode.id} is not listed by its thread`);
		}
		const expectedFile = join(namespaceDirectory, "episodes", `${episode.id}.md`);
		if (episode.file !== expectedFile || !canonicalArtifactAllowed(options, "episode", episode.file)) {
			canonicalRuntimeRefuse(`episode ${episode.id} has an unsafe file reference`);
		}
		if (episode.observations?.stored === true) {
			const expectedReference = slateArtifactReference(options.namespaceName, "observations", episode.id);
			const observationFile = join(namespaceDirectory, "observations", `${episode.id}.md`);
			if (episode.observations.path !== expectedReference
				|| !isSlateArtifactReference(episode.observations.path, "observations", episode.id)
				|| !canonicalArtifactAllowed(options, "observation", observationFile)) {
				canonicalRuntimeRefuse(`episode ${episode.id} has an unsafe observation reference`);
			}
		}
	}

	return {
		threads,
		episodes,
		threadSeq: raw.threadSeq as number,
		slateSessionParentChain: parents,
		orchestratorMode: raw.orchestratorMode as boolean,
		paused: raw.paused as boolean,
		workerCostUsd: raw.workerCostUsd as number,
		carriedCostUsd: raw.carriedCostUsd as number,
	};
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

/** Writing configuration. Ignored writing keys remain accepted for compatibility. */
export interface WritingConfig {
	check?: boolean;
	remind?: boolean;
	remindPercent?: number;
}

export interface RuntimeAuthorityBinding {
	readonly policy: "durable-session-v1";
	readonly identity: string;
	readonly name: string;
}

export type RuntimeAuthoritySelection =
	| { readonly kind: "fresh" }
	| { readonly kind: "durable"; readonly binding: RuntimeAuthorityBinding }
	| { readonly kind: "refused"; readonly reason: string; readonly message: string };

export interface RuntimeAuthorityContext {
	/** Stable identity of the selected Pi session and transcript branch. */
	readonly key: string;
	readonly cwd: string;
	readonly sessionDigest: string;
	readonly project: CorpusProject;
	readonly report?: (message: string) => void;
}

export interface RuntimeAuthorityExternalRecord {
	readonly directory: string;
	readonly metadata: {
		readonly policy: "durable-session-v1";
		readonly identity: string;
		readonly name: string;
		readonly currentDirectory: string;
		readonly projectKey: string;
		readonly projectDigest: string;
	};
	readonly state: {
		/** Informational write sequence only. */
		readonly generation: number;
		readonly status: "active" | "delivered" | "abandoned";
		readonly terminalAt?: string;
		/** Provenance only. This digest grants no write access. */
		readonly lastWriterSessionDigest: string;
		readonly runtime: CanonicalRuntimeState;
	};
}

export interface RuntimeAuthorityBackend {
	mint(): { identity: string; name: string };
	create(options: {
		context: RuntimeAuthorityContext;
		identity: string;
		name: string;
		runtime: CanonicalRuntimeState;
	}): RuntimeAuthorityExternalRecord;
	read(options: {
		context: RuntimeAuthorityContext;
		binding: RuntimeAuthorityBinding;
	}): RuntimeAuthorityExternalRecord;
	update(options: {
		context: RuntimeAuthorityContext;
		binding: RuntimeAuthorityBinding;
		runtime: CanonicalRuntimeState;
	}): RuntimeAuthorityExternalRecord;
	writeBinding(binding: RuntimeAuthorityBinding): void;
	isCommitUncertain(error: unknown): boolean;
}

export type RuntimeAuthorityState =
	| { readonly kind: "fresh"; readonly contextKey: string }
	| { readonly kind: "durable"; readonly contextKey: string; readonly binding: RuntimeAuthorityBinding; readonly generation: number }
	| { readonly kind: "unavailable"; readonly contextKey?: string; readonly message: string };

export interface RuntimeMutationPermit {
	/** Isolated candidate state. It is not visible until save accepts this exact permit. */
	readonly runtime: CanonicalRuntimeState;
}

export type RuntimeSaveResult =
	| { readonly kind: "committed"; readonly binding: RuntimeAuthorityBinding }
	| { readonly kind: "partial"; readonly binding: RuntimeAuthorityBinding; readonly message: string }
	/**
	 * THE SAVE MAY OR MAY NOT BE DURABLE. A failure after publication — a directory
	 * synchronization that failed after the rename — leaves the visible file correct
	 * and its durability unproven, so a reread of that file proves nothing about the
	 * next power loss. Accepted risk 9 of the Track 14 design requires this outcome
	 * to stay visible, so it never collapses into an ordinary success (CN1503).
	 */
	| { readonly kind: "uncertain"; readonly binding: RuntimeAuthorityBinding; readonly message: string };

interface RuntimeMutationPermitState {
	readonly epoch: number;
	readonly revision: number;
	readonly contextKey: string;
	readonly baseline: CanonicalRuntimeState;
	readonly authorityKind: "fresh" | "durable";
}

function cloneCanonicalRuntime(runtime: CanonicalRuntimeState): CanonicalRuntimeState {
	return structuredClone(runtime);
}

/**
 * Overwrite one record IN PLACE, so its object identity survives a save.
 *
 * A caller holds a thread record across the whole dispatch and mutates it as the
 * action progresses. An accepted save reinstalls the stored records, and a
 * replacement object would detach that live reference: every later change would
 * then land outside the store, the thread would stay queued, and its episode
 * reference would fail validation (BG1501/CN1501). This keeps the object and
 * replaces its content instead, so no caller needs a rule about holding a record
 * (design non-goal 17).
 */
function adoptRecordInPlace<T extends object>(existing: T, next: T): T {
	const target = existing as Record<string, unknown>;
	const source = next as Record<string, unknown>;
	for (const key of Object.keys(target)) {
		if (!Object.hasOwn(source, key)) delete target[key];
	}
	Object.assign(target, source);
	return existing;
}

/**
 * Copy one runtime state into an existing draft object, field by field.
 *
 * The draft a mutation permit carries is the only value save() reads, and the
 * permit is opaque to its holder. commit() therefore fills the draft the store
 * already handed out instead of replacing it: a replacement object would not be
 * the permit's own draft, and the permit lookup would refuse it.
 */
function assignCanonicalRuntime(target: CanonicalRuntimeState, source: CanonicalRuntimeState): void {
	target.threads = source.threads;
	target.episodes = source.episodes;
	target.threadSeq = source.threadSeq;
	target.slateSessionParentChain = source.slateSessionParentChain;
	target.orchestratorMode = source.orchestratorMode;
	target.paused = source.paused;
	target.workerCostUsd = source.workerCostUsd;
	target.carriedCostUsd = source.carriedCostUsd;
}

function malformedAuthority(message: string): never {
	throw new Error(`slate refused malformed runtime authority ${message}`);
}

function copyRuntimeAuthorityBinding(value: unknown): RuntimeAuthorityBinding {
	const copy = copyCanonicalData(value);
	if (copy === INVALID_CANONICAL_DATA || !canonicalObject(copy)
		|| !exactCanonicalKeys(copy, ["policy", "identity", "name"])) {
		malformedAuthority("binding");
	}
	if (copy.policy !== "durable-session-v1" || !isSlateSessionId(copy.identity)
		|| !isSlateSessionName(copy.name)) {
		malformedAuthority("binding");
	}
	return { policy: "durable-session-v1", identity: copy.identity, name: copy.name };
}

function copyRuntimeAuthoritySelection(value: unknown): RuntimeAuthoritySelection {
	const copy = copyCanonicalData(value);
	if (copy === INVALID_CANONICAL_DATA || !canonicalObject(copy) || typeof copy.kind !== "string") {
		malformedAuthority("selection");
	}
	if (copy.kind === "fresh" && exactCanonicalKeys(copy, ["kind"])) return { kind: "fresh" };
	if (copy.kind === "durable" && exactCanonicalKeys(copy, ["kind", "binding"])) {
		return { kind: "durable", binding: copyRuntimeAuthorityBinding(copy.binding) };
	}
	if (copy.kind === "refused" && exactCanonicalKeys(copy, ["kind", "reason", "message"])
		&& typeof copy.reason === "string" && typeof copy.message === "string") {
		return { kind: "refused", reason: copy.reason, message: copy.message };
	}
	return malformedAuthority("selection");
}

function copyRuntimeAuthorityContext(value: unknown): RuntimeAuthorityContext {
	if (!canonicalObject(value)
		|| !exactCanonicalKeys(value, ["key", "cwd", "sessionDigest", "project", "report"], ["key", "cwd", "sessionDigest", "project"])
		|| typeof value.key !== "string" || value.key === ""
		|| typeof value.cwd !== "string" || value.cwd === ""
		|| !isOwnerSessionDigest(value.sessionDigest)
		|| !canonicalObject(value.project)
		|| (value.report !== undefined && typeof value.report !== "function")) {
		malformedAuthority("context");
	}
	const rawProject = value.project;
	if (!exactCanonicalKeys(rawProject, ["root", "key", "label", "digest", "directory", "matchingDirectories"])
		|| typeof rawProject.root !== "string" || typeof rawProject.key !== "string"
		|| typeof rawProject.label !== "string" || typeof rawProject.digest !== "string"
		|| typeof rawProject.directory !== "string" || !Array.isArray(rawProject.matchingDirectories)
		|| rawProject.matchingDirectories.some((item) => typeof item !== "string")) {
		malformedAuthority("context project");
	}
	return {
		key: value.key,
		cwd: value.cwd,
		sessionDigest: value.sessionDigest,
		project: {
			root: rawProject.root,
			key: rawProject.key,
			label: rawProject.label,
			digest: rawProject.digest,
			directory: rawProject.directory,
			matchingDirectories: [...rawProject.matchingDirectories] as string[],
		},
		...(value.report !== undefined ? { report: value.report as (message: string) => void } : {}),
	};
}

function sameRuntimeAuthorityContext(left: RuntimeAuthorityContext, right: RuntimeAuthorityContext): boolean {
	return left.key === right.key && left.cwd === right.cwd
		&& left.sessionDigest === right.sessionDigest
		&& left.report === right.report
		&& left.project.root === right.project.root
		&& left.project.key === right.project.key
		&& left.project.label === right.project.label
		&& left.project.digest === right.project.digest
		&& left.project.directory === right.project.directory
		&& isDeepStrictEqual(left.project.matchingDirectories, right.project.matchingDirectories);
}

function copyMintedAuthority(value: unknown): { identity: string; name: string } {
	const copy = copyCanonicalData(value);
	if (copy === INVALID_CANONICAL_DATA || !canonicalObject(copy)
		|| !exactCanonicalKeys(copy, ["identity", "name"])
		|| !isSlateSessionId(copy.identity) || !isSlateSessionName(copy.name)) {
		malformedAuthority("mint result");
	}
	return { identity: copy.identity, name: copy.name };
}

function copyRuntimeAuthorityExternalRecord(value: unknown): RuntimeAuthorityExternalRecord {
	const copy = copyCanonicalData(value);
	if (copy === INVALID_CANONICAL_DATA || !canonicalObject(copy)
		|| !exactCanonicalKeys(copy, ["directory", "metadata", "state"])
		|| typeof copy.directory !== "string" || !canonicalObject(copy.metadata) || !canonicalObject(copy.state)) {
		malformedAuthority("external record");
	}
	const metadataAllowed = [
		"policy", "identity", "name", "createdAt", "currentDirectory", "projectKey", "projectDigest", "creatorSessionDigest",
	];
	const metadataRequired = ["policy", "identity", "name", "currentDirectory", "projectKey", "projectDigest"];
	if (!exactCanonicalKeys(copy.metadata, metadataAllowed, metadataRequired)
		|| copy.metadata.policy !== "durable-session-v1"
		|| typeof copy.metadata.identity !== "string" || typeof copy.metadata.name !== "string"
		|| typeof copy.metadata.currentDirectory !== "string" || typeof copy.metadata.projectKey !== "string"
		|| typeof copy.metadata.projectDigest !== "string"
		|| (copy.metadata.createdAt !== undefined && typeof copy.metadata.createdAt !== "string")
		|| (copy.metadata.creatorSessionDigest !== undefined && !isOwnerSessionDigest(copy.metadata.creatorSessionDigest))) {
		malformedAuthority("external record metadata");
	}
	const stateAllowed = ["generation", "status", "terminalAt", "lastWriterSessionDigest", "runtime"];
	const stateRequired = ["generation", "status", "lastWriterSessionDigest", "runtime"];
	if (!exactCanonicalKeys(copy.state, stateAllowed, stateRequired)
		|| !Number.isSafeInteger(copy.state.generation) || (copy.state.generation as number) < 0
		|| (copy.state.status !== "active" && copy.state.status !== "delivered" && copy.state.status !== "abandoned")
		|| !isOwnerSessionDigest(copy.state.lastWriterSessionDigest)
		|| (copy.state.status === "active" && copy.state.terminalAt !== undefined)
		|| (copy.state.status !== "active" && typeof copy.state.terminalAt !== "string")) {
		malformedAuthority("external record state");
	}
	return {
		directory: copy.directory,
		metadata: {
			policy: "durable-session-v1",
			identity: copy.metadata.identity,
			name: copy.metadata.name,
			currentDirectory: copy.metadata.currentDirectory,
			projectKey: copy.metadata.projectKey,
			projectDigest: copy.metadata.projectDigest,
		},
		state: {
			generation: copy.state.generation as number,
			status: copy.state.status,
			...(copy.state.terminalAt !== undefined ? { terminalAt: copy.state.terminalAt as string } : {}),
			lastWriterSessionDigest: copy.state.lastWriterSessionDigest,
			runtime: copy.state.runtime as CanonicalRuntimeState,
		},
	};
}

function copyMutationCandidate(
	permit: RuntimeMutationPermit,
	binding: RuntimeAuthorityBinding,
	context: RuntimeAuthorityContext,
): CanonicalRuntimeState {
	return decodeCanonicalRuntime({
		runtime: permit.runtime,
		externalIdentity: binding.identity,
		expectedIdentity: binding.identity,
		namespaceName: binding.name,
		namespaceDirectory: join(context.project.directory, binding.name),
		artifactPathAllowed: () => true,
	});
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
	corpusName?: string; // optional readable corpus-project label; the digest remains authoritative
	writing?: WritingConfig; // always-active writing guidance and configurable reminder cadence — see writing.ts
}

export class SlateStore {
	threads = new Map<string, ThreadRecord>();
	episodes = new Map<string, EpisodeRecord>();
	private threadSeq = 0;
	slateSessionId: string | undefined;
	slateSessionName: string | undefined;
	ownerSessionDigest: string | undefined;
	slateSessionParentChain: SlateSessionParent[] = [];
	corpusProject: CorpusProject | undefined;
	private runtimeAuthority: RuntimeAuthorityState = {
		kind: "unavailable",
		message: "slate storage has not been selected for this Pi session",
	};
	private runtimeAuthorityContext: RuntimeAuthorityContext | undefined;
	private runtimeAuthoritySourceContext: RuntimeAuthorityContext | undefined;
	private runtimeAuthorityBackend: RuntimeAuthorityBackend | undefined;
	private runtimeAuthorityEpoch = 0;
	private runtimeAuthorityRevision = 0;
	private runtimeTransactionActive = false;
	private readonly runtimeMutationPermits = new WeakMap<RuntimeMutationPermit, RuntimeMutationPermitState>();
	/**
	 * The record objects of the CURRENT selection, by id. They keep the identity of a
	 * record that a caller holds across a save (see adoptRecordInPlace). A new
	 * selection forgets them, so no record object crosses two selected namespaces.
	 */
	private readonly threadIdentities = new Map<string, ThreadRecord>();
	private readonly episodeIdentities = new Map<string, EpisodeRecord>();
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
	/** Session-instance reminder state. It is never part of canonical storage. */
	readonly writingReminder: WritingReminderRuntime = createWritingReminderRuntime();
	/** Invoked after every accepted save or adopted read; mode.ts refreshes the widget. */
	onDidChange?: () => void;

	constructor(_pi: ExtensionAPI) {}

	nextThreadId(): string {
		let max = this.threadSeq;
		for (const id of this.threads.keys()) {
			const ordinal = canonicalThreadOrdinal(id);
			if (ordinal !== undefined) max = Math.max(max, ordinal);
		}
		return `t${max + 1}`;
	}

	claimNextThreadId(): string {
		if (this.runtimeTransactionActive) throw new Error("slate refused a nested runtime transaction");
		const id = this.nextThreadId();
		this.threadSeq = Number(id.slice(1));
		return id;
	}

	artifactSessionName(): string | undefined {
		if (this.slateSessionName === undefined) throw new Error("slate session namespace is unavailable");
		return this.slateSessionName;
	}

	/**
	 * The exact research log path, or undefined while no session directory exists.
	 *
	 * Every session directory holds one research log, so the answer is the exact
	 * path whenever this Slate session owns a session directory (Track 15 goal 1).
	 */
	researchLogPath(): string | undefined {
		const name = this.slateSessionName;
		const directory = this.corpusProject?.directory;
		if (name === undefined || directory === undefined) return undefined;
		return resolveResearchLogPath(directory, name);
	}

	private runtimeMemorySnapshot(): CanonicalRuntimeState {
		return cloneCanonicalRuntime({
			threads: [...this.threads.values()].map(copyThreadRecord),
			episodes: [...this.episodes.values()],
			threadSeq: this.threadSeq,
			slateSessionParentChain: this.slateSessionParentChain,
			orchestratorMode: this.orchestratorMode,
			paused: this.paused,
			workerCostUsd: this.workerCostUsd,
			carriedCostUsd: this.carriedCostUsd,
		});
	}

	private canonicalRuntimeSnapshot(): CanonicalRuntimeState {
		return this.runtimeMemorySnapshot();
	}

	/** Remember every visible record object before the view is replaced. */
	private rememberRecordIdentities(): void {
		for (const [id, thread] of this.threads) this.threadIdentities.set(id, thread);
		for (const [id, episode] of this.episodes) this.episodeIdentities.set(id, episode);
	}

	/** Drop every remembered record object. One selection owns its own records only. */
	private forgetRecordIdentities(): void {
		this.threadIdentities.clear();
		this.episodeIdentities.clear();
	}

	/** Keep identity only for records that the installed runtime still contains. */
	private pruneRecordIdentities(): void {
		for (const id of this.threadIdentities.keys()) {
			if (!this.threads.has(id)) this.threadIdentities.delete(id);
		}
		for (const id of this.episodeIdentities.keys()) {
			if (!this.episodes.has(id)) this.episodeIdentities.delete(id);
		}
	}

	private keepThreadIdentity(next: ThreadRecord): ThreadRecord {
		const existing = this.threadIdentities.get(next.id);
		const kept = existing === undefined ? next : adoptRecordInPlace(existing, next);
		this.threadIdentities.set(next.id, kept);
		return kept;
	}

	private keepEpisodeIdentity(next: EpisodeRecord): EpisodeRecord {
		const existing = this.episodeIdentities.get(next.id);
		const kept = existing === undefined ? next : adoptRecordInPlace(existing, next);
		this.episodeIdentities.set(next.id, kept);
		return kept;
	}

	private installCanonicalRuntime(
		runtime: CanonicalRuntimeState,
		options: { retainAbsentIdentities?: boolean } = {},
	): void {
		const isolated = cloneCanonicalRuntime(runtime);
		// The clone is this store's own data. Reusing the record objects the view already
		// holds therefore keeps the isolation and the caller's reference at once.
		this.rememberRecordIdentities();
		this.threads = new Map(isolated.threads.map((thread) => [thread.id, this.keepThreadIdentity(thread)]));
		this.episodes = new Map(isolated.episodes.map((episode) => [episode.id, this.keepEpisodeIdentity(episode)]));
		if (options.retainAbsentIdentities !== true) this.pruneRecordIdentities();
		this.threadSeq = isolated.threadSeq;
		this.slateSessionParentChain = isolated.slateSessionParentChain;
		this.orchestratorMode = isolated.orchestratorMode;
		this.paused = isolated.paused;
		this.workerCostUsd = isolated.workerCostUsd;
		this.carriedCostUsd = isolated.carriedCostUsd;
	}

	private clearCanonicalRuntime(retainRecordIdentities = false): void {
		this.installCanonicalRuntime({
			threads: [],
			episodes: [],
			threadSeq: 0,
			slateSessionParentChain: [],
			orchestratorMode: false,
			paused: false,
			workerCostUsd: 0,
			carriedCostUsd: 0,
		}, { retainAbsentIdentities: retainRecordIdentities });
		this.slateSessionId = undefined;
		this.slateSessionName = undefined;
		this.ownerSessionDigest = undefined;
	}

	private authorityContextMatches(context: RuntimeAuthorityContext): boolean {
		const active = this.runtimeAuthorityContext;
		if (context !== this.runtimeAuthoritySourceContext || active === undefined) return false;
		const copied = copyRuntimeAuthorityContext(context);
		return sameRuntimeAuthorityContext(active, copied);
	}

	private validateAuthorityRecord(
		record: RuntimeAuthorityExternalRecord,
		binding: RuntimeAuthorityBinding,
		context: RuntimeAuthorityContext,
	): RuntimeAuthorityExternalRecord {
		if (record.metadata.identity !== binding.identity || record.metadata.name !== binding.name) {
			throw new Error("slate refused external state with a mismatched durable-session identity");
		}
		if (record.metadata.projectKey !== context.project.key
			|| record.metadata.projectDigest !== context.project.digest
			|| record.metadata.currentDirectory !== context.cwd
			|| record.directory !== join(context.project.directory, binding.name)) {
			throw new Error("slate refused external authority for a different project or current directory");
		}
		const runtime = decodeCanonicalRuntime({
			runtime: record.state.runtime,
			externalIdentity: record.metadata.identity,
			expectedIdentity: binding.identity,
			namespaceName: binding.name,
			namespaceDirectory: record.directory,
			artifactPathAllowed: () => true,
		});
		return {
			...record,
			metadata: { ...record.metadata },
			state: { ...record.state, runtime },
		};
	}

	private bindingFor(record: RuntimeAuthorityExternalRecord): RuntimeAuthorityBinding {
		return {
			policy: "durable-session-v1",
			identity: record.metadata.identity,
			name: record.metadata.name,
		};
	}

	private installAuthorityRecord(
		record: RuntimeAuthorityExternalRecord,
		binding: RuntimeAuthorityBinding,
		context: RuntimeAuthorityContext,
	): RuntimeAuthorityBinding {
		const validated = this.validateAuthorityRecord(record, binding, context);
		this.installCanonicalRuntime(validated.state.runtime);
		this.slateSessionId = binding.identity;
		this.slateSessionName = binding.name;
		this.ownerSessionDigest = context.sessionDigest;
		const currentBinding = this.bindingFor(validated);
		this.runtimeAuthority = {
			kind: "durable",
			contextKey: context.key,
			binding: currentBinding,
			generation: validated.state.generation,
		};
		this.runtimeAuthorityRevision += 1;
		return currentBinding;
	}

	/**
	 * Apply the RESTORE rule to records this session has just adopted: an action
	 * that was still queued or running when its Pi session ended cannot be resumed,
	 * so it reads as failed.
	 *
	 * It runs at the two adoption moments only — the startup restore and the handoff
	 * adoption — and never after a save. A live dispatch legitimately holds a queued
	 * or running action, and normalizing after its own save would mark the running
	 * action of this very session as failed. The change is in memory: the next
	 * accepted save stores it.
	 */
	private normalizeAdoptedRuntime(context: RuntimeAuthorityContext): void {
		const normalized: string[] = [];
		for (const thread of this.threads.values()) {
			if (thread.status !== "queued" && thread.status !== "running") continue;
			thread.status = "failed";
			thread.outcomeReason = "the session ended before the action finished";
			normalized.push(thread.id);
		}
		if (normalized.length === 0) return;
		this.reportSafely(
			context,
			`slate: ${normalized.join(", ")} did not finish before its previous Pi session ended. Slate reads ${normalized.length === 1 ? "it" : "them"} as failed.`,
		);
	}

	private reportSafely(context: RuntimeAuthorityContext | undefined, message: string): void {
		try {
			context?.report?.(message);
		} catch {
			/* Reporting is advisory and cannot change an authority outcome. */
		}
	}

	private notifyDidChange(context = this.runtimeAuthorityContext): void {
		try {
			this.onDidChange?.();
		} catch (error) {
			this.reportSafely(context, `slate changed authoritative state, but its local display refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private selectionIsActive(
		epoch: number,
		context: RuntimeAuthorityContext,
		backend: RuntimeAuthorityBackend,
	): boolean {
		return epoch === this.runtimeAuthorityEpoch && context === this.runtimeAuthorityContext
			&& backend === this.runtimeAuthorityBackend;
	}

	private mutationIsActive(
		state: RuntimeMutationPermitState,
		context: RuntimeAuthorityContext,
		backend: RuntimeAuthorityBackend,
	): boolean {
		return this.selectionIsActive(state.epoch, context, backend)
			&& state.revision === this.runtimeAuthorityRevision
			&& state.authorityKind === this.runtimeAuthority.kind;
	}

	private requireActiveMutation(
		state: RuntimeMutationPermitState,
		context: RuntimeAuthorityContext,
		backend: RuntimeAuthorityBackend,
	): void {
		if (!this.mutationIsActive(state, context, backend)) {
			throw new Error("slate refused a mutation completed for an old Pi context");
		}
	}

	private makeUnavailable(message: string): void {
		const contextKey = this.runtimeAuthorityContext?.key;
		this.clearCanonicalRuntime();
		this.runtimeAuthority = { kind: "unavailable", ...(contextKey !== undefined ? { contextKey } : {}), message };
		this.runtimeAuthorityRevision += 1;
		this.reportSafely(this.runtimeAuthorityContext, message);
		this.notifyDidChange();
	}

	private selectRuntimeAuthority(
		selection: RuntimeAuthoritySelection,
		sourceContext: RuntimeAuthorityContext,
		selectedContext: RuntimeAuthorityContext,
		backend: RuntimeAuthorityBackend,
	): void {
		this.runtimeAuthorityEpoch += 1;
		this.runtimeAuthorityRevision += 1;
		this.runtimeAuthoritySourceContext = sourceContext;
		this.runtimeAuthorityContext = selectedContext;
		this.runtimeAuthorityBackend = backend;
		this.corpusProject = selectedContext.project;
		// External storage is the only artifact location under a selected authority.
		// artifactSessionName() refuses while the namespace name is unavailable.
		this.clearCanonicalRuntime();
		// A new selection keeps NO record object of the previous one, so a stale holder
		// cannot reach the records of the namespace this session selects now.
		this.forgetRecordIdentities();
		if (selection.kind === "refused") {
			this.makeUnavailable(selection.message);
			return;
		}
		if (selection.kind === "fresh") {
			// PREPARATION ONLY. The identity and the namespace directory are minted by
			// the first accepted mutation, so a start that changes nothing creates no
			// directory (Track 14 goal 2). It therefore owns no research log path yet
			// either, because Slate creates that file with the session directory.
			this.runtimeAuthority = { kind: "fresh", contextKey: selectedContext.key };
			this.notifyDidChange(selectedContext);
			return;
		}
		const selectedEpoch = this.runtimeAuthorityEpoch;
		const selectedRevision = this.runtimeAuthorityRevision;
		try {
			const record = copyRuntimeAuthorityExternalRecord(
				backend.read({ context: selectedContext, binding: selection.binding }),
			);
			if (!this.selectionIsActive(selectedEpoch, selectedContext, backend)
				|| selectedRevision !== this.runtimeAuthorityRevision) {
				throw new Error("slate refused external authority loaded for an old Pi context");
			}
			this.installAuthorityRecord(record, selection.binding, selectedContext);
			this.normalizeAdoptedRuntime(selectedContext);
			this.notifyDidChange(selectedContext);
		} catch (error) {
			if (!this.selectionIsActive(selectedEpoch, selectedContext, backend)) throw error;
			this.makeUnavailable(`slate could not establish current external authority: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Select one authority policy. Production lifecycle wiring remains deferred. */
	configureRuntimeAuthority(
		selection: RuntimeAuthoritySelection,
		context: RuntimeAuthorityContext,
		backend: RuntimeAuthorityBackend,
	): void {
		if (this.runtimeTransactionActive) throw new Error("slate refused a nested runtime transaction");
		this.runtimeTransactionActive = true;
		try {
			const copied = {
				selection: copyRuntimeAuthoritySelection(selection),
				context: copyRuntimeAuthorityContext(context),
			};
			this.selectRuntimeAuthority(copied.selection, context, copied.context, backend);
		} finally {
			this.runtimeTransactionActive = false;
		}
	}

	/**
	 * Enter the refusing state, with no selected storage and no records.
	 *
	 * Startup calls this BEFORE it reads any evidence, so a Pi session that cannot
	 * finish its storage report — a missing corpus project, a throw inside the
	 * report — refuses every later save instead of falling back to another storage
	 * path (Track 14 goals 1 and 5). It keeps no context and no backend, so a
	 * later mutation attempt reports this message and nothing else.
	 */
	refuseRuntimeAuthority(message: string): void {
		if (this.runtimeTransactionActive) throw new Error("slate refused a nested runtime transaction");
		this.runtimeTransactionActive = true;
		try {
			this.runtimeAuthorityEpoch += 1;
			this.runtimeAuthoritySourceContext = undefined;
			this.runtimeAuthorityContext = undefined;
			this.runtimeAuthorityBackend = undefined;
			this.clearCanonicalRuntime();
			this.forgetRecordIdentities();
			this.runtimeAuthority = { kind: "unavailable", message };
			this.runtimeAuthorityRevision += 1;
			this.notifyDidChange(undefined);
		} finally {
			this.runtimeTransactionActive = false;
		}
	}

	/**
	 * Adopt one already existing external namespace as this session's authority.
	 *
	 * The validating read happens FIRST and its result is the record set this
	 * session keeps: a caller supplies no records at all (Track 14 goals 10 and
	 * 12). A refused read therefore changes no durable record and leaves the
	 * prepared fresh selection in place, so the user can correct the name and run
	 * the command again. Only a session that has selected no storage of its own
	 * may adopt. A session that already saved records into one namespace would
	 * abandon those records by adopting another, and this rule claims no exclusive
	 * access to either namespace: the storage layer performs no ownership check.
	 */
	adoptExternalAuthority(binding: RuntimeAuthorityBinding): RuntimeAuthorityBinding {
		if (this.runtimeTransactionActive) throw new Error("slate refused a nested runtime transaction");
		this.runtimeTransactionActive = true;
		try {
			const context = this.runtimeAuthorityContext;
			const backend = this.runtimeAuthorityBackend;
			if (this.runtimeAuthority.kind === "unavailable") throw new Error(this.runtimeAuthority.message);
			if (context === undefined || backend === undefined) throw new Error("slate runtime authority is not configured");
			if (this.runtimeAuthority.kind !== "fresh") {
				throw new Error("slate refused an external adoption for a session that already selected durable storage");
			}
			const selected = copyRuntimeAuthorityBinding(binding);
			const epoch = this.runtimeAuthorityEpoch;
			const revision = this.runtimeAuthorityRevision;
			const record = copyRuntimeAuthorityExternalRecord(backend.read({ context, binding: selected }));
			if (!this.selectionIsActive(epoch, context, backend) || revision !== this.runtimeAuthorityRevision) {
				throw new Error("slate refused external authority loaded for an old Pi context");
			}
			// Validation precedes every state change, so a refusal leaves this session
			// exactly as it was.
			const validated = this.validateAuthorityRecord(record, selected, context);
			// The adopted namespace is a different one, so its records are new objects.
			this.forgetRecordIdentities();
			const current = this.installAuthorityRecord(validated, selected, context);
			this.normalizeAdoptedRuntime(context);
			this.notifyDidChange(context);
			return current;
		} finally {
			this.runtimeTransactionActive = false;
		}
	}

	authorityState(): RuntimeAuthorityState {
		return structuredClone(this.runtimeAuthority);
	}

	private prepareRuntimeMutation(sourceContext: RuntimeAuthorityContext): RuntimeMutationPermit {
		if (!this.authorityContextMatches(sourceContext)) throw new Error("slate refused a mutation from a stale or foreign Pi context");
		const backend = this.runtimeAuthorityBackend;
		const context = this.runtimeAuthorityContext;
		if (backend === undefined || context === undefined) throw new Error("slate runtime authority is not configured");
		let baseline: CanonicalRuntimeState;
		let authorityKind: "fresh" | "durable";
		if (this.runtimeAuthority.kind === "fresh") {
			baseline = this.canonicalRuntimeSnapshot();
			authorityKind = "fresh";
		} else if (this.runtimeAuthority.kind === "durable") {
			let record: RuntimeAuthorityExternalRecord;
			let binding: RuntimeAuthorityBinding;
			const selectedEpoch = this.runtimeAuthorityEpoch;
			const selectedRevision = this.runtimeAuthorityRevision;
			const selectedBinding = this.runtimeAuthority.binding;
			try {
				record = copyRuntimeAuthorityExternalRecord(backend.read({ context, binding: selectedBinding }));
				if (!this.selectionIsActive(selectedEpoch, context, backend)
					|| selectedRevision !== this.runtimeAuthorityRevision || this.runtimeAuthority.kind !== "durable") {
					throw new Error("slate refused external authority loaded for an old Pi context");
				}
				binding = this.installAuthorityRecord(record, selectedBinding, context);
			} catch (error) {
				if (!this.selectionIsActive(selectedEpoch, context, backend)) throw error;
				this.makeUnavailable(`slate could not revalidate current external authority: ${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}
			const installedRevision = this.runtimeAuthorityRevision;
			this.notifyDidChange(context);
			if (!this.selectionIsActive(selectedEpoch, context, backend)
				|| this.runtimeAuthorityRevision !== installedRevision
				|| this.runtimeAuthority.kind !== "durable" || this.runtimeAuthority.binding !== binding) {
				throw new Error("slate refused mutation preparation completed for an old Pi context");
			}
			baseline = cloneCanonicalRuntime(record.state.runtime);
			authorityKind = "durable";
		} else {
			throw new Error(this.runtimeAuthority.message);
		}
		const permit: RuntimeMutationPermit = { runtime: cloneCanonicalRuntime(baseline) };
		this.runtimeMutationPermits.set(permit, {
			epoch: this.runtimeAuthorityEpoch,
			revision: this.runtimeAuthorityRevision,
			contextKey: context.key,
			baseline,
			authorityKind,
		});
		return permit;
	}

	/** Revalidate authority and return one context-bound, isolated mutation draft. */
	prepareMutation(context: RuntimeAuthorityContext): RuntimeMutationPermit {
		if (this.runtimeTransactionActive) throw new Error("slate refused a nested runtime transaction");
		this.runtimeTransactionActive = true;
		try {
			return this.prepareRuntimeMutation(context);
		} finally {
			this.runtimeTransactionActive = false;
		}
	}

	private authorizePermit(permit: RuntimeMutationPermit): RuntimeMutationPermitState {
		const state = this.runtimeMutationPermits.get(permit);
		if (state === undefined) throw new Error("slate refused a foreign mutation permit");
		this.runtimeMutationPermits.delete(permit);
		if (state.epoch !== this.runtimeAuthorityEpoch || state.revision !== this.runtimeAuthorityRevision
			|| state.contextKey !== this.runtimeAuthorityContext?.key
			|| state.authorityKind !== this.runtimeAuthority.kind) {
			throw new Error("slate refused a stale mutation permit");
		}
		return state;
	}

	private reconcilePossibleExternalCommit(
		relationship: RuntimeAuthorityBinding,
		context: RuntimeAuthorityContext,
		backend: RuntimeAuthorityBackend,
		epoch: number,
		operation: "creation" | "update",
	): void {
		if (!this.selectionIsActive(epoch, context, backend)) return;
		this.clearCanonicalRuntime(true);
		try {
			const current = copyRuntimeAuthorityExternalRecord(backend.read({ context, binding: relationship }));
			if (!this.selectionIsActive(epoch, context, backend)) return;
			this.installAuthorityRecord(current, relationship, context);
			this.notifyDidChange(context);
		} catch (error) {
			if (!this.selectionIsActive(epoch, context, backend)) return;
			this.makeUnavailable(`slate could not reconcile external authority after ${operation}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private finishExternalCommit(
		record: RuntimeAuthorityExternalRecord,
		relationship: RuntimeAuthorityBinding,
		context: RuntimeAuthorityContext,
		backend: RuntimeAuthorityBackend,
		epoch: number,
		operation: "creation" | "update",
	): RuntimeSaveResult {
		let binding: RuntimeAuthorityBinding;
		try {
			binding = this.installAuthorityRecord(record, relationship, context);
		} catch (error) {
			this.reconcilePossibleExternalCommit(relationship, context, backend, epoch, operation);
			throw error;
		}
		const installedRevision = this.runtimeAuthorityRevision;
		const requireInstalledAuthority = (): void => {
			if (!this.selectionIsActive(epoch, context, backend)
				|| this.runtimeAuthorityRevision !== installedRevision
				|| this.runtimeAuthority.kind !== "durable" || this.runtimeAuthority.binding !== binding) {
				throw new Error("slate refused advisory binding work completed for an old Pi context");
			}
		};
		try {
			backend.writeBinding(binding);
			requireInstalledAuthority();
		} catch (error) {
			try {
				requireInstalledAuthority();
			} catch (integrityError) {
				this.reconcilePossibleExternalCommit(relationship, context, backend, epoch, operation);
				throw integrityError;
			}
			const message = `slate committed external state, but could not persist its advisory Pi binding: ${error instanceof Error ? error.message : String(error)}`;
			this.reportSafely(context, message);
			this.notifyDidChange(context);
			return { kind: "partial", binding, message };
		}
		this.notifyDidChange(context);
		return { kind: "committed", binding };
	}

	/**
	 * Report one reconciled but UNPROVEN save as uncertain (CN1503).
	 *
	 * The reread above proves what the visible file holds NOW. It cannot prove that
	 * the directory entry survives a power loss, which is exactly what the failure
	 * after publication left unproven. The design requires the uncertainty to reach
	 * the user (accepted risk 9), so this never returns an ordinary success.
	 */
	private reportUncertainCommit(
		settled: RuntimeSaveResult,
		context: RuntimeAuthorityContext,
		operation: "creation" | "update",
		error: unknown,
	): RuntimeSaveResult {
		const detail = error instanceof Error ? error.message : String(error);
		const message = `slate could not confirm that its external ${operation} is durable: ${detail}. `
			+ "The records are visible now, and a later failure of this computer can still lose them."
			+ (settled.kind === "partial" ? ` Slate also reported: ${settled.message}` : "");
		this.reportSafely(context, message);
		return { kind: "uncertain", binding: settled.binding, message };
	}

	private saveRuntimeMutation(permit: RuntimeMutationPermit): RuntimeSaveResult {
		const permitState = this.authorizePermit(permit);
		const backend = this.runtimeAuthorityBackend;
		const context = this.runtimeAuthorityContext;
		if (backend === undefined || context === undefined) throw new Error("slate runtime authority is not configured");
		let pendingRecovery: { relationship: RuntimeAuthorityBinding; operation: "creation" | "update" } | undefined;
		try {
			if (permitState.authorityKind === "fresh") {
				const minted = copyMintedAuthority(backend.mint());
				this.requireActiveMutation(permitState, context, backend);
				const relationship: RuntimeAuthorityBinding = {
					policy: "durable-session-v1",
					identity: minted.identity,
					name: minted.name,
				};
				const candidate = copyMutationCandidate(permit, relationship, context);
				this.requireActiveMutation(permitState, context, backend);
				let creationReturned = false;
				try {
					this.clearCanonicalRuntime(true);
					pendingRecovery = { relationship, operation: "creation" };
					const returned = backend.create({ context, identity: minted.identity, name: minted.name, runtime: candidate });
					creationReturned = true;
					const record = copyRuntimeAuthorityExternalRecord(returned);
					this.requireActiveMutation(permitState, context, backend);
					pendingRecovery = undefined;
					return this.finishExternalCommit(record, relationship, context, backend, permitState.epoch, "creation");
				} catch (error) {
					if (!this.mutationIsActive(permitState, context, backend)) throw error;
					const uncertain = backend.isCommitUncertain(error);
					this.requireActiveMutation(permitState, context, backend);
					if (uncertain) {
						try {
							const reconciled = copyRuntimeAuthorityExternalRecord(
								backend.read({ context, binding: relationship }),
							);
							this.requireActiveMutation(permitState, context, backend);
							pendingRecovery = undefined;
							return this.reportUncertainCommit(
								this.finishExternalCommit(reconciled, relationship, context, backend, permitState.epoch, "creation"),
								context,
								"creation",
								error,
							);
						} catch (reconcileError) {
							if (!this.mutationIsActive(permitState, context, backend)) throw error;
							this.makeUnavailable(`slate could not validate an uncertain external creation: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`);
							pendingRecovery = undefined;
							throw error;
						}
					} else if (creationReturned) {
						this.makeUnavailable("slate could not validate the externally created authority");
					} else {
						this.installCanonicalRuntime(permitState.baseline);
					}
					pendingRecovery = undefined;
					throw error;
				}
			}
			if (this.runtimeAuthority.kind !== "durable") {
				this.installCanonicalRuntime(permitState.baseline);
				throw new Error("slate refused a mutation whose durable session changed");
			}
			const relationship = this.runtimeAuthority.binding;
			const candidate = copyMutationCandidate(permit, relationship, context);
			this.requireActiveMutation(permitState, context, backend);
			try {
				this.clearCanonicalRuntime(true);
				pendingRecovery = { relationship, operation: "update" };
				const record = copyRuntimeAuthorityExternalRecord(backend.update({
					context,
					binding: relationship,
					runtime: candidate,
				}));
				this.requireActiveMutation(permitState, context, backend);
				pendingRecovery = undefined;
				return this.finishExternalCommit(record, relationship, context, backend, permitState.epoch, "update");
			} catch (error) {
				if (!this.mutationIsActive(permitState, context, backend)) throw error;
				const uncertain = backend.isCommitUncertain(error);
				this.requireActiveMutation(permitState, context, backend);
				if (uncertain) {
					try {
						const reconciled = copyRuntimeAuthorityExternalRecord(
							backend.read({ context, binding: relationship }),
						);
						this.requireActiveMutation(permitState, context, backend);
						pendingRecovery = undefined;
						return this.reportUncertainCommit(
							this.finishExternalCommit(reconciled, relationship, context, backend, permitState.epoch, "update"),
							context,
							"update",
							error,
						);
					} catch (reconcileError) {
						if (!this.mutationIsActive(permitState, context, backend)) throw error;
						this.makeUnavailable(`slate could not validate an uncertain external update: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`);
						pendingRecovery = undefined;
						throw error;
					}
				} else {
					this.requireActiveMutation(permitState, context, backend);
					try {
						const current = copyRuntimeAuthorityExternalRecord(
							backend.read({ context, binding: relationship }),
						);
						this.requireActiveMutation(permitState, context, backend);
						this.installAuthorityRecord(current, relationship, context);
						this.notifyDidChange(context);
						pendingRecovery = undefined;
					} catch (restoreError) {
						if (!this.mutationIsActive(permitState, context, backend)) throw error;
						this.makeUnavailable(`slate could not restore state after an external mutation failure: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
						pendingRecovery = undefined;
					}
				}
				throw error;
			}
		} catch (error) {
			if (pendingRecovery !== undefined) {
				this.reconcilePossibleExternalCommit(
					pendingRecovery.relationship,
					context,
					backend,
					permitState.epoch,
					pendingRecovery.operation,
				);
			}
			throw error;
		}
	}

	save(permit?: RuntimeMutationPermit): RuntimeSaveResult {
		if (this.runtimeTransactionActive) throw new Error("slate refused a nested runtime transaction");
		if (permit === undefined) {
			if (this.runtimeAuthority.kind === "unavailable") throw new Error(this.runtimeAuthority.message);
			throw new Error("slate requires an authorized mutation permit");
		}
		this.runtimeTransactionActive = true;
		try {
			return this.saveRuntimeMutation(permit);
		} finally {
			this.runtimeTransactionActive = false;
		}
	}

	/**
	 * THE ONE PRODUCTION SAVE. It saves the current in-memory records through the
	 * three-step contract: revalidate the selected storage, fill the private draft
	 * of one mutation permit, then save that permit.
	 *
	 * WHY THE STORE HOLDS THE PERMIT and no caller ever sees it: a dispatch, a mode
	 * change and an automatic pause each mutate the records in memory and then ask
	 * for a save, so the proposed change IS the in-memory state. The candidate is
	 * therefore copied BEFORE the revalidating read, because that read
	 * reinstalls the durable records and would otherwise discard the caller's
	 * change. A rejected save leaves the durable records untouched and the in-memory
	 * records equal to them again, and it THROWS so its caller reports the refusal.
	 *
	 * A refusing session throws the refusal message itself (Track 14 goal 5).
	 */
	commit(): RuntimeSaveResult {
		if (this.runtimeTransactionActive) throw new Error("slate refused a nested runtime transaction");
		if (this.runtimeAuthority.kind === "unavailable") throw new Error(this.runtimeAuthority.message);
		const sourceContext = this.runtimeAuthoritySourceContext;
		if (sourceContext === undefined) throw new Error("slate runtime authority is not configured");
		this.runtimeTransactionActive = true;
		try {
			const candidate = this.runtimeMemorySnapshot();
			const permit = this.prepareRuntimeMutation(sourceContext);
			assignCanonicalRuntime(permit.runtime, candidate);
			return this.saveRuntimeMutation(permit);
		} finally {
			this.runtimeTransactionActive = false;
		}
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
