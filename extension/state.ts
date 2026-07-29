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

export interface ThreadRecord {
	id: string; // "t1", "t2", ...
	name: string;
	sessionFile: string; // absolute path to worker .jsonl ("" until first dispatch completes session creation)
	status: "idle" | "running";
	model?: string; // "provider/id" when overridden at creation
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
 * Whitespace, control characters and INVISIBLE/BIDI formatting characters are
 * REJECTED rather than trimmed (BG2). Such a spec resolves nowhere in pi's
 * registry, yet renders in a warning as a byte-identical twin of the valid name
 * once the display sanitizer strips the offending character — a zero-width space
 * or a right-to-left override is worse still, since it survives sanitization and
 * displays as nothing at all. Rejecting them lets the caller say what is
 * actually wrong (describeSpecDefect), and the remaining confusable case —
 * legitimate-looking non-ASCII homoglyphs, which cannot simply be rejected
 * because an exotic provider id may be genuinely non-ASCII — is handled at
 * DISPLAY time by describeConfusables.
 */

/**
 * Characters that are never part of a real model spec and are invisible or
 * direction-changing when displayed: C0/C1 controls, soft hyphen, Arabic letter
 * mark, Mongolian vowel separator, zero-width space/joiners, LRM/RLM, the bidi
 * embedding/override/isolate controls, word joiner and invisible operators,
 * interlinear annotation marks, and the BOM.
 */
const INVISIBLE_SPEC_CHARS =
	/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/;

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
 * characters (BG2's remaining confusable class). A Cyrillic "а" in an otherwise
 * valid spec renders exactly like the Latin one, so a warning about it would
 * otherwise look like a warning about the model the user meant. Returns
 * undefined for a pure printable-ASCII spec, which is the normal case.
 */
export function describeConfusables(value: string): string | undefined {
	// Printable-ASCII complement. Neither this nor INVISIBLE_SPEC_CHARS carries the
	// /g flag, because codePointList calls .test() per character and a sticky/global
	// regex would keep lastIndex between those calls and skip matches.
	const nonAscii = /[^\u0020-\u007e]/;
	if (!nonAscii.test(value)) return undefined;
	return `contains non-ASCII characters: ${codePointList(value, nonAscii)}`;
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
		for (const t of latest.threads ?? []) {
			if (t.sessionFile && !existsSync(t.sessionFile)) {
				dropped.push(`thread ${t.id} (${t.name}): missing ${t.sessionFile}`);
				continue;
			}
			this.threads.set(t.id, { ...t, status: "idle" });
		}
		for (const e of latest.episodes ?? []) {
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
			ctx.ui.notify(`slate: dropped stale records:\n${dropped.join("\n")}`, "warning");
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
