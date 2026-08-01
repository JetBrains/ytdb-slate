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

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// TYPE-ONLY: the effort vocabulary is defined once, in the profile table
// (model-profiles.ts, digest §V), and is identical to pi's own ThinkingLevel
// union. The import is erased at load time, so it adds no runtime dependency to
// this module — state.ts stays the leaf of the graph (see the model-spec note
// below on why that matters).
import type { ThinkingLevel } from "./model-profiles.ts";
import { sanitizeForNotify } from "./notify.ts";

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
export interface ThreadRecord {
	id: string; // "t1", "t2", ...
	name: string;
	sessionFile: string; // absolute path to worker .jsonl ("" until first dispatch completes session creation)
	status: "idle" | "running";
	/**
	 * PRE-ROUTER pin: "provider/id" passed as `model` when the thread was created
	 * WITH THE ROUTER OFF. It keeps exactly its pre-router meaning — the model a NEW
	 * worker session for this thread OPENS on, never a reason to switch a live one —
	 * so with the router off this feature stays invisible. With the router ON a
	 * `model` argument routes ONE action and is deliberately NOT recorded here; see
	 * `baseModel`.
	 */
	model?: string;
	/**
	 * The thread's DEFAULT model, canonical "provider/id" — what a dispatch that
	 * omits `model` runs on. Written ONLY while the router is on (with the router off
	 * nothing is seeded or persisted), and always one of the effective candidates:
	 * a base that is absent or has fallen off the list is re-seeded on the next
	 * dispatch (route.ts's THE ONE RULE). DISTINCT from whatever a single action was
	 * routed to: a routed action never becomes the thread's base. Absent = unknown.
	 */
	baseModel?: string;
	/**
	 * The thread's DEFAULT effort level, derived for `baseModel` and valid only for
	 * it: a dispatch whose model differs re-derives the level for the model that
	 * actually runs. Absent = unknown ⇒ the worker session's own opening level.
	 *
	 * The type is a claim about what slate WROTE, not a guarantee about what it reads
	 * back: this record is restored from an unversioned, hand-editable snapshot, so the
	 * reader (route.ts) re-validates the value against pi's vocabulary and treats
	 * anything else as absent — the same discipline the model fields get from the
	 * spec helpers below (BG21).
	 */
	baseEffort?: ThinkingLevel;
	episodeIds: string[];
	episodeSeq: number; // monotonic per-thread episode counter
	createdAt: number;
	updatedAt: number;
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
	createdAt: number;
}

export interface SlateSnapshot {
	threads: ThreadRecord[];
	episodes: EpisodeRecord[];
	orchestratorMode: boolean;
	paused: boolean;
	workerCostUsd: number;
	carriedCostUsd: number; // orchestrator spend banked from ancestor sessions at handoff
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
function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
	const note = (field: string, value: unknown) =>
		repairs.push(`thread ${id}: ignoring ${field} (${typeof value === "object" ? "object" : typeof value})`);
	const keep = <T>(field: string, value: unknown, parsed: T | undefined): T | undefined => {
		if (value !== undefined && parsed === undefined) note(field, value);
		return parsed;
	};
	const episodeIds = Array.isArray(t.episodeIds) ? t.episodeIds.filter((e): e is string => typeof e === "string") : [];
	if (t.episodeIds !== undefined && !Array.isArray(t.episodeIds)) note("episodeIds", t.episodeIds);
	const now = Date.now();
	return {
		id,
		name: keep("name", t.name, str(t.name)) ?? id,
		sessionFile: keep("sessionFile", t.sessionFile, str(t.sessionFile)) ?? "",
		status: "idle",
		...(keep("model", t.model, str(t.model)) !== undefined ? { model: str(t.model) } : {}),
		...(keep("baseModel", t.baseModel, str(t.baseModel)) !== undefined ? { baseModel: str(t.baseModel) } : {}),
		// The LEVEL's vocabulary is re-checked by the reader (route.ts's storedLevel, BG21);
		// this boundary only refuses a value that is not a string at all, so the vocabulary
		// stays defined in exactly one place.
		...(keep("baseEffort", t.baseEffort, str(t.baseEffort)) !== undefined ? { baseEffort: str(t.baseEffort) as ThinkingLevel } : {}),
		episodeIds,
		episodeSeq: keep("episodeSeq", t.episodeSeq, num(t.episodeSeq)) ?? episodeIds.length,
		createdAt: keep("createdAt", t.createdAt, num(t.createdAt)) ?? now,
		updatedAt: keep("updatedAt", t.updatedAt, num(t.updatedAt)) ?? now,
	};
}

/** One adopted episode record, or undefined when it cannot be addressed or filed. */
export function sanitizeEpisodeRecord(raw: unknown, repairs: string[]): EpisodeRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const e = raw as Record<string, unknown>;
	const id = str(e.id);
	const threadId = str(e.threadId);
	const file = str(e.file);
	if (id === undefined || id === "" || threadId === undefined || file === undefined) return undefined;
	return {
		id,
		threadId,
		task: str(e.task) ?? "",
		status: e.status === "failed" ? "failed" : "ok",
		file,
		...(str(e.model) !== undefined ? { model: str(e.model) } : {}),
		...(str(e.effort) !== undefined ? { effort: str(e.effort) as ThinkingLevel } : {}),
		...(e.effortUnmeasured === true ? { effortUnmeasured: true as const } : {}),
		createdAt: num(e.createdAt) ?? Date.now(),
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
 * absent means the router is OFF and dispatch behaves exactly as it did before
 * the router existed. `allowUnmeasuredEffort` (default TRUE) decides what the
 * dispatch path does with an effort level that is ladder-valid but has no
 * capability evidence — an evidence gap is advisory, not a prohibition.
 * Validated by sanitizeRouterConfig in model-router.ts.
 */
export interface RouterConfig {
	models?: string[];
	allowUnmeasuredEffort?: boolean;
}

export interface SlateConfig {
	episodeModel?: string; // "provider/id" for the episode compressor (D5)
	workerTools?: string[];
	workerExtensions?: string[]; // regex patterns selecting which of the HOST session's pi extensions worker threads may load (default [] = none); see worker-extensions.ts
	maxConcurrent?: number; // global cap on concurrently running worker actions (default 4; must be ≥ 1 — unenforced, ≤ 0 silently hangs all dispatches; rationale: docs/design-principles.md §5 repo-local note)
	pauseThresholdPercent?: number; // DEPRECATED: legacy percent-based auto-pause (default 40); applies only when set AND contextBudget is absent or entirely invalid (invalid sanitizes to absent — a partially invalid object stays budget mode)
	contextBudget?: number | ContextBudgetObject; // absolute orchestrator token budget; bare number = { tokens: N }; {} opts into built-in defaults (256k, 400k for anthropic/*) — see handoff.ts
	orchestratorModeDefault?: boolean; // seed orchestrator mode ON for fresh interactive sessions (unsaved until first real mutation)
	orchestratorPromptDocs?: string[]; // role-guideline docs appended to the orchestrator prompt (cwd-relative paths, default none)
	workerPromptDocs?: string[]; // role-guideline docs appended to worker system prompts (cwd-relative paths, default none)
	workflow?: { draftPRs?: boolean }; // draftPRs: umbrella draft PRs are part of the pre-implementation gates (default false)
	modelFailover?: Record<string, string>; // model→model failover map ("provider/id" → "provider/id"); empty/absent = feature off
	preserveGlobalModelDefault?: boolean; // restore the user's GLOBAL pi model defaults (defaultProvider/defaultModel/defaultThinkingLevel) after a slate-initiated model switch — failover and handoff adoption (default true; only an explicit false disables it) — see model-default.ts
	doctrineExtraPath?: string; // cwd-relative markdown appended to the orchestrator doctrine (project-doctrine section)
	reviewPerspectivesPath?: string; // cwd-relative markdown with additional project-specific review perspectives
	router?: RouterConfig; // action-level model router: the closed model list + the evidence-gap policy (default: off) — see model-router.ts
}

export class SlateStore {
	threads = new Map<string, ThreadRecord>();
	episodes = new Map<string, EpisodeRecord>();
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
	/** Invoked after every save/restore; used by mode.ts to refresh the widget. */
	onDidChange?: () => void;

	constructor(private pi: ExtensionAPI) {}

	nextThreadId(): string {
		let max = 0;
		for (const id of this.threads.keys()) {
			const m = /^t(\d+)$/.exec(id);
			if (m) max = Math.max(max, Number(m[1]));
		}
		return `t${max + 1}`;
	}

	snapshot(): SlateSnapshot {
		return {
			threads: [...this.threads.values()].map((t) => ({ ...t, status: "idle" as const })),
			episodes: [...this.episodes.values()],
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
		const dropped: string[] = [];
		// EVERY record is validated field by field on the way in (BG26) — see
		// sanitizeThreadRecord. Nothing downstream re-checks these types, so a snapshot
		// that has been hand-edited, truncated or written by another version must be made
		// safe HERE; the alternative was an exception thrown out of the `thread` tool from
		// inside a warning message.
		const threadList = Array.isArray(latest.threads) ? latest.threads : [];
		for (const raw of threadList) {
			const t = sanitizeThreadRecord(raw, dropped);
			if (t === undefined) {
				dropped.push(`thread record without a usable id: ${typeof raw === "object" ? "ignored" : typeof raw}`);
				continue;
			}
			if (t.sessionFile && !existsSync(t.sessionFile)) {
				dropped.push(`thread ${t.id} (${t.name}): missing ${t.sessionFile}`);
				continue;
			}
			this.threads.set(t.id, t);
		}
		const episodeList = Array.isArray(latest.episodes) ? latest.episodes : [];
		for (const raw of episodeList) {
			const e = sanitizeEpisodeRecord(raw, dropped);
			if (e === undefined) {
				dropped.push(`episode record without a usable id, thread id or file: ${typeof raw === "object" ? "ignored" : typeof raw}`);
				continue;
			}
			if (!existsSync(e.file)) {
				dropped.push(`episode ${e.id}: missing ${e.file}`);
				continue;
			}
			if (!this.threads.has(e.threadId)) continue;
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
