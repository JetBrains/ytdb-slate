/**
 * ThreadManager: dispatch lifecycle (ExecPlan M1).
 *
 * One dispatch = one bounded action on one thread:
 *   resolve/create thread → EARLY route validation → per-thread FIFO queue →
 *   global semaphore → open/reuse worker session → APPLY-TIME route
 *   re-validation + model/effort switch → inject context episodes → prompt →
 *   compress the new messages into an episode (ok or FAILED) → update store.
 *
 * Parallelism happens ACROSS threads (pi runs sibling tool calls
 * concurrently); a single thread is a serial work stream (D9).
 *
 * PER-ACTION ROUTING (model-router D4/D48/D53). `model` and `effort` are
 * per-DISPATCH, honoured on a continuation exactly as on a creation — before
 * this, `model` was accepted only when a thread was created and silently ignored
 * on every later dispatch. The rules the dispatch path implements:
 *
 *  - RESOLUTION: the effective model is the explicit argument, else the thread's
 *    base model; the effective effort is the explicit argument, else the thread's
 *    base effort. The GUARDS ALWAYS VALIDATE THE RESOLVED PAIR, never only the
 *    explicit arguments — an omitted argument must not escape validation.
 *
 *  - A THREAD'S BASE is not an action's route. With the router ON the base model
 *    is the resolver's cheapest preferred candidate, which is always a LISTED
 *    model, so a later dispatch that omits `model` can never be rejected by the
 *    list guard (model-router D48); the base effort seeds to the LOWEST MEASURED
 *    level for that model, never to the user's global thinking-level default. A
 *    model passed to the creating dispatch routes THAT action only.
 *
 *  - ROUTER OFF = PRE-ROUTER BEHAVIOUR, exactly. No list guard, no window guard,
 *    no billing warning, no seeded effort: the base model is the orchestrator's
 *    own base model (via the injected tracker, which excludes failover
 *    fallbacks), falling back to a creation-time `model` pin and then to the
 *    host's current model, which is what worker.ts did before. The one addition
 *    is that an explicitly passed `effort` is still validated against the target
 *    model's ladder — that argument did not exist before, so there is no
 *    behaviour to preserve, and pi would otherwise silently CLAMP a level the
 *    model does not offer.
 *
 *  - VALIDATION HAPPENS TWICE. Early, in dispatch(), before any state mutation
 *    or session work, so a bad pick is a TOOL ERROR rather than a billed failed
 *    episode; and again at apply time, once the worker session exists and the
 *    thread's context size is knowable, where it also warns and may substitute.
 *    An apply-time rejection ABORTS the dispatch without recording an episode and
 *    without invoking the compressor (DispatchAbort below) — the only path in
 *    this module that does not end in an episode.
 *
 *  - FAILOVER IS CARVED OUT (guard 7): the in-dispatch failover switch bypasses
 *    the list and effort guards entirely and keeps only a non-substituting window
 *    warning. The router must never veto a failover.
 */

import { readFileSync } from "node:fs";
import {
	DEFAULT_COMPACTION_SETTINGS,
	getAgentDir,
	SettingsManager,
	shouldCompact,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
// TYPE-ONLY, and deliberately so: the orchestrator's base-model tracker is
// created and wired in by index.ts; this module only reads it through the
// injected instance (and never calls expectOwnSwitch — a WORKER session's model
// switch is not an orchestrator switch, so it must not be announced as one).
import type { BaseModelTracker } from "./base-model.ts";
import { compressEpisode } from "./episodes.ts";
import { isAuthFailure, isFailoverCandidate, resolveMappedModel } from "./failover.ts";
import type { ThinkingLevel } from "./model-profiles.ts";
import {
	checkEffort,
	resolveModelRouter,
	ROUTER_OFF,
	type EffortCheck,
	type ModelRouterResolution,
	type RouterCandidate,
} from "./model-router.ts";
import { sanitizeForNotify } from "./notify.ts";
import { isModelSpec, type EpisodeRecord, type SlateConfig, type SlateStore, type ThreadRecord } from "./state.ts";
import { openWorkerSession, resolveModel, type WorkerSession } from "./worker.ts";
import { EMPTY_WORKER_EXTENSION_SET, type WorkerExtensionSet } from "./worker-extensions.ts";

/**
 * pi's thinking-level vocabulary, ASCENDING — the same union as
 * model-profiles.ts's ThinkingLevel and pi's own. Order is load-bearing twice:
 * it decides which measured level is the "lowest" when seeding a thread's base
 * effort, and it is the list a rejected `effort` argument is explained against.
 * Ascending order is taken from HERE rather than from a profile's ladder so the
 * answer does not depend on the table's authoring order.
 */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface DispatchOptions {
	threadId?: string;
	name?: string;
	task: string;
	contextEpisodeIds?: string[];
	model?: string; // "provider/id" for THIS action (see the header): the thread's base model when omitted
	effort?: string; // pi thinking level for THIS action; validated against the target model's ladder
	tools?: string[];
}

/** What one dispatch resolved to, plus everything the caller must report about it. */
interface RoutePlan {
	model?: string; // effective "provider/id"; undefined = leave the session on its own model (router off, nothing resolvable)
	effort?: ThinkingLevel; // effective level; undefined = leave pi's own thinking level alone
	effortUnmeasured: boolean; // that level is ladder-valid but has NO capability measurement
	baseModel?: string; // the base a NEW thread must persist
	baseEffort?: ThinkingLevel; // the base effort a NEW thread must persist
	warnings: string[]; // advisory notices for the orchestrator, in order
}

/**
 * An apply-time rejection: the world moved between the early validation and the
 * dispatch. Thrown ONLY from the pre-prompt phase, and caught separately from
 * every other failure so the dispatch ends WITHOUT an episode and WITHOUT a
 * compressor call — nothing was billed, so nothing should be recorded as work.
 */
class DispatchAbort extends Error {}

export interface UsageStats {
	turns: number;
	input: number;
	output: number;
	cost: number;
	contextTokens: number;
}

export interface DispatchProgress {
	threadId: string;
	threadName: string;
	lines: string[];
	usage: UsageStats;
	done: boolean;
	status?: "ok" | "failed";
}

export interface DispatchResult {
	episodeText: string;
	episode: EpisodeRecord;
	thread: ThreadRecord;
	usage: UsageStats;
	/** Routing notices for THIS action (evidence gaps, window substitutions, billing cliffs). */
	warnings: readonly string[];
}

/** Loose shape of an assistant message as seen in session.messages / message_end. */
interface WorkerAssistantMsg {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
	content?: Array<{ type: string; text?: string }>;
}

/**
 * Final assistant message of THIS action (AF3): backward scan, because the
 * last array element can be a toolResult (e.g. after a tool abort), and pi's
 * internal retry strips recovered errored attempts from session.messages
 * entirely — so the last assistant message is the authoritative outcome.
 */
function lastAssistantMessage(messages: unknown[]): WorkerAssistantMsg | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as WorkerAssistantMsg;
		if (m.role === "assistant") return m;
	}
	return undefined;
}

/** Continuation nudge for the post-failover re-prompt (same live session, context intact). */
const FAILOVER_NUDGE =
	"The previous attempt was interrupted by a model API failure. The conversation context is intact " +
	"and partial changes may exist — verify the current state, then complete the original action.";

class Semaphore {
	private waiters: Array<() => void> = [];
	private active = 0;
	constructor(private limit: number) {}
	async acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		// Wait for a slot transferred directly by release(); do NOT increment
		// here — the releasing side keeps `active` unchanged when handing over.
		await new Promise<void>((r) => this.waiters.push(r));
	}
	release(): void {
		const next = this.waiters.shift();
		if (next) {
			// Transfer the slot to the next waiter without decrementing:
			// the slot never becomes observable as free.
			next();
		} else {
			this.active--;
		}
	}
}

export class ThreadManager {
	private live = new Map<string, WorkerSession>();
	/** threadId → "provider/id" a LIVE session was switched to by model failover (AF12). */
	private failoverLive = new Map<string, string>();
	private queues = new Map<string, Promise<unknown>>();
	private semaphore: Semaphore;
	/** "threadId|spec" pairs already warned about crossing a long-context billing threshold (guard 6). */
	private longContextWarned = new Set<string>();
	/**
	 * Router-OFF ladder answers, per spec: a throwaway single-model resolution so
	 * the effort guards use the ONE ladder predicate (model-router's checkEffort)
	 * on both paths instead of a second implementation. Cached because a dispatch
	 * validates twice and a session runs many dispatches.
	 */
	private offRouterLadders = new Map<string, ModelRouterResolution>();
	/** pi's compaction settings, read once (a lock-protected disk read) — see compactionSettings(). */
	private cachedCompaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };

	constructor(
		private store: SlateStore,
		private config: SlateConfig,
		// This session's frozen worker-extension resolver (AD41), bound BY VALUE at
		// construction (CN20) so a manager orphaned by a session swap keeps its own
		// session's set instead of resolving against a later one's. Read lazily per
		// new worker. Defaults to the empty-set function so existing construction
		// sites and test harnesses keep working with the feature off.
		private resolveExtensions: () => WorkerExtensionSet = () => EMPTY_WORKER_EXTENSION_SET,
		// This session's MEMOIZED model-router resolution (model-router.ts's
		// createModelRouterResolver), bound by value for the same reason as the
		// resolver above: a manager orphaned by a session swap must keep answering
		// with its own session's frozen candidate list. Defaults to the OFF
		// resolution, which is byte-for-byte the pre-router dispatch path.
		private resolveRouter: () => ModelRouterResolution = () => ROUTER_OFF,
		// The orchestrator's base model, EXCLUDING failover fallbacks (base-model.ts).
		// Consulted only when the router is off, to seed a new thread's base model.
		// undefined (the default) = no tracker ⇒ fall back to the pre-router
		// behaviour, where the worker opens on the host session's current model.
		private baseModelTracker?: BaseModelTracker,
	) {
		this.semaphore = new Semaphore(config.maxConcurrent ?? 4); // default rationale: docs/design-principles.md §5 repo-local note
	}

	getConfig(): SlateConfig {
		return this.config;
	}

	/**
	 * The "provider/id" a thread's LIVE session runs after a model failover,
	 * undefined when none happened or the session has since been disposed.
	 * Failover is deliberately NOT persisted to ThreadRecord (neither the
	 * pre-router `model` pin nor `baseModel`). A reopen normally reverts to the
	 * dispatch's resolved model because worker.ts is passed one explicitly, which
	 * overrides the session file — EXCEPT when the dispatch resolved to no model
	 * at all (router off, no tracker, no pin, and a model-less host session): the
	 * SDK then restores the session file's last model_change, which can be the
	 * mapped model (CQ3).
	 *
	 * The marker is also DROPPED, not just on disposal, when a later dispatch
	 * routes the same live session somewhere explicitly (see applyRoute): after
	 * that switch the session no longer runs a failover model, so reporting one
	 * would be a lie.
	 */
	liveFailoverModel(threadId: string): string | undefined {
		return this.live.has(threadId) ? this.failoverLive.get(threadId) : undefined;
	}

	async dispatch(
		opts: DispatchOptions,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		// Pause blocks only NEW dispatches — in-flight ones already hold their
		// queue slot and are allowed to finish (their episodes still get written).
		if (this.store.paused) {
			throw new Error(
				"Slate is paused for handoff: the context budget was exceeded and new dispatches are rejected. " +
					"Reply to the user with a handoff brief (overall goal, per-thread state with episode ids, immediate next actions) " +
					"and ask them to run /slate handoff [focus] to continue in a fresh session.",
			);
		}
		// EARLY route validation (see the header): the RESOLVED model/effort pair is
		// validated here, before any state mutation and before any session work, so a
		// bad pick is a tool error the orchestrator can correct — not a billed failed
		// episode. Reject-only: no warnings and no window substitution, both of which
		// belong to the apply-time plan that runs with the thread's real context size.
		// Ordering inside this method matters: the unknown-thread error above comes
		// first (it explains itself better than a routing complaint would), the
		// routing guards next, and only then is a new thread created.
		const existing = opts.threadId ? this.requireThread(opts.threadId) : undefined;
		const liveSession = existing ? this.live.get(existing.id) : undefined;
		const early = this.planRoute({ thread: existing, opts, ctx, contextTokens: this.contextTokens(liveSession) });
		const thread = existing ?? this.createThread(opts, early);

		// Per-thread FIFO: chain onto the previous dispatch for this thread.
		const prev = this.queues.get(thread.id) ?? Promise.resolve();
		const run = prev
			.catch(() => undefined) // a failed predecessor must not poison the queue
			.then(() => this.runDispatch(thread, opts, ctx, signal, onProgress));
		this.queues.set(thread.id, run);
		return run;
	}

	private requireThread(threadId: string): ThreadRecord {
		const existing = this.store.threads.get(threadId);
		if (!existing) {
			const known = [...this.store.threads.keys()].join(", ") || "none";
			throw new Error(`Unknown thread "${threadId}". Known threads: ${known}. Omit "thread" to create a new one.`);
		}
		return existing;
	}

	/**
	 * Create and persist a new thread record. The FIRST state mutation of a
	 * dispatch, and deliberately after the early route validation: a rejected
	 * pick must not leave an empty thread behind.
	 *
	 * `model` (the pre-router pin) is recorded ONLY when the router is off, which
	 * is exactly what it meant before per-action routing existed. With the router
	 * on, the creating dispatch's `model` argument routes that one action, and the
	 * thread's own default is `baseModel` — recording the routed model as a pin
	 * would make one action's route the thread's permanent base.
	 */
	private createThread(opts: DispatchOptions, plan: RoutePlan): ThreadRecord {
		const id = this.store.nextThreadId();
		const record: ThreadRecord = {
			id,
			name: opts.name?.trim() || id,
			sessionFile: "",
			status: "idle",
			...(this.routerResolution().on ? {} : { model: opts.model }),
			...(plan.baseModel ? { baseModel: plan.baseModel } : {}),
			...(plan.baseEffort ? { baseEffort: plan.baseEffort } : {}),
			episodeIds: [],
			episodeSeq: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.store.threads.set(id, record);
		this.store.save();
		return record;
	}

	private buildPrompt(opts: DispatchOptions): string {
		const contextIds = opts.contextEpisodeIds ?? [];
		if (contextIds.length === 0) return opts.task;
		const parts: string[] = ["## Context from prior episodes (injected by the orchestrator)", ""];
		for (const id of contextIds) {
			const episode = this.store.episodes.get(id);
			if (!episode) throw new Error(`Unknown episode "${id}". Known: ${[...this.store.episodes.keys()].join(", ") || "none"}`);
			parts.push(readFileSync(episode.file, "utf8").trim(), "");
		}
		parts.push("## Action", "", opts.task);
		return parts.join("\n");
	}

	// ---------------------------------------------------------------- routing --

	/**
	 * This session's frozen router resolution, defensively.
	 *
	 * A THROWING resolver, or one that hands back a malformed object, must leave
	 * the dispatch path exactly as it is with the router off rather than break a
	 * dispatch: OFF is the pre-router behaviour, so it is always a safe answer.
	 * `candidates` is checked for being a non-empty array because the guards below
	 * walk it directly (checkEffort tolerates a junk resolution on its own, CQ5).
	 */
	private routerResolution(): ModelRouterResolution {
		try {
			const resolution = this.resolveRouter();
			if (!resolution || typeof resolution !== "object" || resolution.on !== true) return ROUTER_OFF;
			if (!Array.isArray(resolution.candidates) || resolution.candidates.length === 0) return ROUTER_OFF;
			return resolution;
		} catch {
			return ROUTER_OFF;
		}
	}

	/** The routable candidate for a spec, undefined when the router is off or the spec is unlisted. */
	private candidateFor(resolution: ModelRouterResolution, spec: string | undefined): RouterCandidate | undefined {
		if (!spec || !resolution.on) return undefined;
		return resolution.candidates.find((c) => c?.spec === spec);
	}

	/**
	 * The model/effort verdict for ONE pair — model-router's predicate on both
	 * paths, never a second implementation of the ladder rules.
	 *
	 * With the router ON that is the session's frozen resolution. With the router
	 * OFF the same predicate is fed a THROWAWAY single-model resolution, so the
	 * ladder answer stays PER MODEL (the whole point of guard 2) instead of
	 * degenerating into a vocabulary check against a union of every model's
	 * levels. Its warnings are dropped on purpose: with the router off, a model
	 * that is unprofiled, unknown to the registry or unauthenticated is not news —
	 * the throwaway resolution is then OFF, checkEffort is inert, and the level
	 * passes to pi, which clamps it exactly as it did before this feature.
	 */
	private checkEffortFor(
		resolution: ModelRouterResolution,
		spec: string,
		effort: ThinkingLevel,
		ctx: ExtensionContext,
	): EffortCheck {
		if (resolution.on) return checkEffort(resolution, spec, effort);
		let single = this.offRouterLadders.get(spec);
		if (!single) {
			try {
				single = resolveModelRouter({ registry: ctx.modelRegistry, models: [spec] }, () => {});
			} catch {
				single = ROUTER_OFF;
			}
			this.offRouterLadders.set(spec, single);
		}
		return checkEffort(single, spec, effort);
	}

	/**
	 * The LOWEST level on a listed model's ladder that carries a traced capability
	 * measurement — the seed for a new thread's base effort.
	 *
	 * `verdict === "ok"` is exactly "on the ladder, measured, and not rejected by
	 * the provider", so an unmeasured level can never be chosen by default and an
	 * API-rejected one can never be seeded. undefined when the model has no
	 * measured level at all: absence reads as unknown, and pi's own default applies
	 * — guessing a level from an evidence gap is precisely what the profile data
	 * forbids.
	 */
	private lowestMeasuredEffort(resolution: ModelRouterResolution, spec: string | undefined): ThinkingLevel | undefined {
		if (!resolution.on || !spec) return undefined; // OFF: checkEffort is inert and would answer "ok" for every level
		for (const level of THINKING_LEVELS) {
			if (checkEffort(resolution, spec, level).verdict === "ok") return level;
		}
		return undefined;
	}

	/** An `effort` argument as a level, or undefined when absent; throws on anything outside pi's vocabulary. */
	private parseEffort(raw: unknown): ThinkingLevel | undefined {
		if (raw === undefined || raw === null) return undefined;
		const value = typeof raw === "string" ? raw.trim() : "";
		if (value === "") return undefined; // an empty string is an omitted argument, not a level
		if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
			throw new Error(
				`slate: effort "${sanitizeForNotify(String(raw), 40)}" is not one of pi's thinking levels ` +
					`(${THINKING_LEVELS.join(", ")}).`,
			);
		}
		return value as ThinkingLevel;
	}

	/**
	 * pi's own accounting of a live worker session's context size, or undefined
	 * when it is not knowable before dispatch — no live session (a fresh or
	 * resumed thread, before the session is opened), no model, or a post-compaction
	 * gap where pi itself reports the token count as unknown. undefined means the
	 * window guard is SKIPPED, never that the context is small.
	 */
	private contextTokens(session: WorkerSession | undefined): number | undefined {
		if (!session) return undefined;
		try {
			const tokens = session.getContextUsage()?.tokens;
			return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
		} catch {
			return undefined; // a stale/disposed session tells us nothing about context
		}
	}

	/**
	 * pi's compaction settings, read ONCE and cached: the read is a lock-protected
	 * disk read and this feeds a per-dispatch check. READ-ONLY, and it must stay
	 * that way — a setter call on this throwaway instance would write straight into
	 * the user's GLOBAL settings unmediated (the same rule handoff.ts states).
	 */
	private compactionSettings(ctx: ExtensionContext): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		if (!this.cachedCompaction) {
			try {
				this.cachedCompaction = SettingsManager.create(ctx.cwd, getAgentDir(), {
					projectTrusted: ctx.isProjectTrusted(),
				}).getCompactionSettings();
			} catch {
				this.cachedCompaction = DEFAULT_COMPACTION_SETTINGS;
			}
		}
		return this.cachedCompaction;
	}

	/**
	 * Would `tokens` of context still fit a `window`-token model? pi's OWN
	 * predicate answers (shouldCompact = tokens > window − reserveTokens), so the
	 * guard cannot drift from pi's compaction point, and the reserve is the user's
	 * configured one.
	 *
	 * `enabled` is FORCED TRUE against the user's setting on purpose: disabling
	 * auto-compaction does not make an over-window dispatch safe, it turns the
	 * compaction into an overflow error instead — and shouldCompact answers `false`
	 * for every input when compaction is disabled, which would silently delete this
	 * guard for those users.
	 */
	private fitsWindow(tokens: number, window: number, ctx: ExtensionContext): boolean {
		return !shouldCompact(tokens, window, { ...this.compactionSettings(ctx), enabled: true });
	}

	/**
	 * Resolve WHICH model and effort ONE dispatch runs on, and enforce the
	 * dispatch-side guards. Called TWICE per dispatch (see the module header):
	 *
	 *  - EARLY (`warn` omitted): reject-only, before any state mutation or session
	 *    work. Emits no warning and never substitutes, so the two calls cannot
	 *    double-report and the once-per-thread billing notice is not consumed by a
	 *    call whose warnings nobody would see.
	 *  - APPLY TIME (`warn` given, `contextTokens` known): the authoritative plan.
	 *
	 * A rejection is a THROW; the caller decides what it means (a tool error early,
	 * a non-billed abort at apply time). Guard order is fixed and load-bearing:
	 * vocabulary → list membership → effort (API-rejected, ladder, evidence gap) →
	 * context window (may substitute the model, which re-runs the effort guards in
	 * non-throwing mode) → long-context billing on the FINAL model.
	 */
	private planRoute(args: {
		thread?: ThreadRecord; // undefined = a thread that does not exist yet
		opts: DispatchOptions;
		ctx: ExtensionContext;
		contextTokens?: number; // undefined = not knowable yet ⇒ the window guard is skipped
		warn?: (msg: string) => void;
	}): RoutePlan {
		const { thread, opts, ctx } = args;
		const resolution = this.routerResolution();
		const warnings: string[] = [];
		const collecting = args.warn !== undefined;
		const warn = (message: string) => {
			if (!collecting) return;
			warnings.push(message);
			try {
				args.warn?.(message);
			} catch {
				/* a broken sink costs the notice, never the dispatch */
			}
		};

		const explicit = typeof opts.model === "string" && opts.model.trim() !== "" ? opts.model.trim() : undefined;

		// ---- the THREAD's defaults (never an action's route)
		let baseModel: string | undefined;
		let baseEffort: ThinkingLevel | undefined;
		if (thread) {
			// ?? thread.model: a thread created before per-action routing existed (the
			// snapshot is unversioned, so absence means "unknown", and the pre-router
			// pin is the best available answer).
			baseModel = thread.baseModel ?? thread.model;
			baseEffort = thread.baseEffort;
		} else if (resolution.on) {
			// model-router D48: the cheapest PREFERRED candidate, so the base is always
			// a listed model and a later dispatch that omits `model` can never be
			// rejected by guard 1. An explicit model on THIS dispatch routes this action
			// only — it is deliberately not the base.
			baseModel = resolution.cheapest;
			baseEffort = this.lowestMeasuredEffort(resolution, baseModel);
		} else {
			// Router OFF: a creation-time model is the thread's pin (pre-router
			// behaviour), otherwise the orchestrator's own base model — which EXCLUDES
			// failover fallbacks, so a worker does not inherit a temporary fallback as
			// its permanent default. Failing both, nothing: worker.ts then opens on the
			// host session's current model, exactly as before. The tracker's value is
			// re-validated as a spec here because it crosses a module boundary.
			let tracked: string | undefined;
			try {
				tracked = this.baseModelTracker?.current();
			} catch {
				tracked = undefined; // a broken tracker falls back, it does not fail a dispatch
			}
			baseModel = explicit ?? (isModelSpec(tracked) ? tracked : undefined);
			// baseEffort stays UNKNOWN: seeding it with the router off would change what
			// a worker runs at, and it must never come from the user's global default.
		}

		// ---- the RESOLVED pair for THIS action
		let model = explicit ?? baseModel;
		let effort = this.parseEffort(opts.effort) ?? baseEffort; // GUARD: pi's vocabulary (throws)

		// GUARD 1 — list membership. Router ON only; with the router off the `model`
		// argument behaves exactly as it did before the router existed. Validated on
		// the RESOLVED model, but only an explicit one can trip it: the base is always
		// a listed candidate by construction (D48).
		if (resolution.on && model !== undefined && !resolution.candidates.some((c) => c?.spec === model)) {
			const list = resolution.candidates.map((c) => c.spec).join(", ");
			throw new Error(
				`slate: model "${sanitizeForNotify(model, 80)}" is not routable — the router's effective model list is: ${list}. ` +
					`Pass one of those as "model"${baseModel ? `, or omit it to use ${thread ? `thread ${thread.id}'s` : "the new thread's"} base model (${baseModel})` : ""}.`,
			);
		}

		// The model the effort guards answer for: the resolved model when there is
		// one, else the model the worker session will actually open on (the host's
		// current model). An omitted `model` must not let an effort level escape
		// validation.
		const hostSpec = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		let effortUnmeasured = false;

		/**
		 * GUARDS 2–4 on one (model, effort) pair. `soft` is used after a window
		 * substitution: the context guard must never hard-block a dispatch, so a level
		 * that is invalid on the SUBSTITUTED model is dropped with a warning (pi's own
		 * default then applies) instead of rejecting the action.
		 */
		const guardEffort = (spec: string | undefined, soft: boolean): void => {
			if (effort === undefined || spec === undefined) return;
			const level = effort;
			const check = this.checkEffortFor(resolution, spec, level, ctx);
			const ladder = check.ladder.length > 0 ? check.ladder.join(", ") : "(none recorded)";
			const reject = (message: string) => {
				if (!soft) throw new Error(message);
				effort = undefined;
				effortUnmeasured = false;
				warn(`${message} Dropping the effort level for this action; pi's own default applies.`);
			};
			// GUARD 4 — API-rejected level: a guaranteed provider failure, not an
			// evidence gap, so it is refused outright and is NOT covered by
			// allowUnmeasuredEffort. Checked before the ladder because such a level IS on
			// pi's ladder for the model (model-profiles § apiRejectedLevels).
			if (check.apiRejected) {
				reject(
					`slate: effort "${level}" is rejected outright by the provider for ${sanitizeForNotify(spec, 80)} — ` +
						`dispatching it would be a guaranteed API failure, not an evidence gap. That model's ladder: ${ladder}.`,
				);
				return;
			}
			// GUARD 2 — ladder validity, PER MODEL. pi would silently CLAMP an
			// unsupported level, so without this the orchestrator would believe it ran an
			// action at a level the model never offered.
			if (check.verdict === "off-ladder") {
				reject(
					`slate: effort "${level}" is not on ${sanitizeForNotify(spec, 80)}'s effort ladder (${ladder}).`,
				);
				return;
			}
			// GUARD 3 — evidence gap: ADVISORY by default (an unmeasured level is
			// dispatchable, it is just not a traced capability), and refused only when the
			// project set router.allowUnmeasuredEffort to false. Never chosen by default:
			// a seeded base effort is always a measured level (lowestMeasuredEffort).
			if (check.verdict === "evidence-gap") {
				if (this.config.router?.allowUnmeasuredEffort === false) {
					reject(
						`slate: effort "${level}" on ${sanitizeForNotify(spec, 80)} has no capability measurement in slate's ` +
							`model profiles, and router.allowUnmeasuredEffort is false. That model's ladder: ${ladder}.`,
					);
					return;
				}
				effortUnmeasured = true;
				warn(
					`slate: effort "${level}" on ${sanitizeForNotify(spec, 80)} has NO capability measurement in slate's model ` +
						`profiles${check.listedGap ? "" : " (and the profile does not even list it as a gap)"} — dispatching anyway, ` +
						"but treat the result as unevidenced for this level.",
				);
				return;
			}
			// "ok" — and "not-listed", which reaches here only for a model the guards
			// cannot judge (a legacy thread with no base, dispatched while the router is
			// on, whose host model is not a candidate). No ladder data means no basis to
			// refuse: the level goes to pi, which clamps it.
			effortUnmeasured = false;
		};

		guardEffort(model ?? hostSpec, false);

		// GUARD 5 — CONTEXT WINDOW. Never a hard block, and router ON only: with the
		// router off there is no candidate list to fall back to, and the pre-router
		// behaviour is no check at all. The window compared against is the REGISTRY's
		// (RouterCandidate.contextWindow IS the registry value — a profile's own figure
		// is documentation only, model-router D55), reduced by pi's compaction reserve
		// through pi's own predicate. An unknown window is not a failure: no basis to
		// refuse, so it passes.
		const tokens = args.contextTokens;
		if (resolution.on && model !== undefined && tokens !== undefined) {
			const holds = (candidate: RouterCandidate | undefined): boolean =>
				typeof candidate?.contextWindow !== "number" ? true : this.fitsWindow(tokens, candidate.contextWindow, ctx);
			if (!holds(this.candidateFor(resolution, model))) {
				const reserve = this.compactionSettings(ctx).reserveTokens;
				const where = thread ? `thread ${thread.id}'s` : "this thread's";
				const prefix =
					`slate: ${where} context (~${tokens.toLocaleString("en-US")} tokens) does not fit ` +
					`${sanitizeForNotify(model, 80)}'s context window minus pi's ${reserve.toLocaleString("en-US")}-token ` +
					"compaction reserve";
				const widest = resolution.candidates.reduce<RouterCandidate | undefined>(
					(best, c) =>
						typeof c?.contextWindow !== "number"
							? best
							: best === undefined || c.contextWindow > (best.contextWindow ?? 0)
								? c
								: best,
					undefined,
				);
				if (widest && widest.spec !== model) {
					warn(
						holds(widest)
							? `${prefix} — routing this action to the widest listed model instead: ${widest.spec} ` +
								`(${(widest.contextWindow ?? 0).toLocaleString("en-US")} tokens).`
							: `${prefix}, and NO listed model can hold it — routing to the widest one anyway ` +
								`(${widest.spec}, ${(widest.contextWindow ?? 0).toLocaleString("en-US")} tokens); pi will compact this thread.`,
					);
					model = widest.spec;
					// Ladders are PER MODEL, so the substituted model gets its own effort
					// check — in soft mode: a context size must not turn into a rejection.
					guardEffort(model, true);
				} else {
					warn(`${prefix}, and no listed model is wider — dispatching anyway; pi will compact this thread.`);
				}
			}
		}

		// GUARD 6 — LONG-CONTEXT BILLING. A cost cliff, never a capacity limit
		// (model-profiles §W): above the threshold the price multipliers apply. Warned
		// ONCE per thread and model, on the FINAL model, so a long thread does not
		// repeat it every action — and only when warnings are collected, so the early
		// reject-only pass cannot consume the once-per-pair notice.
		const finalCandidate = this.candidateFor(resolution, model);
		if (collecting && finalCandidate && tokens !== undefined && thread) {
			const threshold = finalCandidate.profile?.longContextThreshold;
			const key = `${thread.id}|${finalCandidate.spec}`;
			if (typeof threshold === "number" && Number.isFinite(threshold) && tokens >= threshold && !this.longContextWarned.has(key)) {
				this.longContextWarned.add(key);
				const multipliers = finalCandidate.profile?.longContextMultipliers;
				const inMult = typeof multipliers?.in === "number" ? multipliers.in : undefined;
				const outMult = typeof multipliers?.out === "number" ? multipliers.out : undefined;
				const rates =
					inMult !== undefined || outMult !== undefined
						? `input bills ×${inMult ?? "?"} and output ×${outMult ?? "?"}`
						: "the provider's long-context multipliers apply (slate's profile records no figure for them)";
				warn(
					`slate: ${thread.id}'s context (~${tokens.toLocaleString("en-US")} tokens) is above ` +
						`${sanitizeForNotify(finalCandidate.spec, 80)}'s long-context billing threshold ` +
						`(${threshold.toLocaleString("en-US")} tokens) — above it ${rates}. A cost event, not a capacity limit.`,
				);
			}
		}

		return { model, effort, effortUnmeasured, baseModel, baseEffort, warnings };
	}

	/**
	 * Put the resolved model/effort onto the worker session — the LAST unbilled
	 * step of a dispatch, and the one that makes a non-billed abort reachable.
	 *
	 * Every failure here is a DispatchAbort: a model that no longer resolves,
	 * credentials that went away since the early check, a live session that refuses
	 * the switch. None of them has spent anything, so none of them should leave an
	 * episode behind. It runs BEFORE the first prompt() and before the message
	 * subscriber's baseline, so an aborted dispatch adds nothing to the thread.
	 */
	private async applyRoute(
		session: WorkerSession,
		plan: RoutePlan,
		thread: ThreadRecord,
		ctx: ExtensionContext,
	): Promise<void> {
		const currentSpec = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		if (plan.model !== undefined && plan.model !== currentSpec) {
			let target: ReturnType<typeof resolveModel>;
			try {
				target = resolveModel(ctx, plan.model);
			} catch (error) {
				throw new DispatchAbort(
					`slate: aborting the dispatch to thread ${thread.id} — ${sanitizeForNotify(
						error instanceof Error ? error.message : String(error),
						200,
					)}. Nothing ran and no episode was recorded.`,
				);
			}
			try {
				await session.setModel(target);
			} catch (error) {
				throw new DispatchAbort(
					`slate: aborting the dispatch to thread ${thread.id} — switching its worker session to ` +
						`${sanitizeForNotify(plan.model, 80)} failed: ${sanitizeForNotify(
							error instanceof Error ? error.message : String(error),
							200,
						)}. Nothing ran and no episode was recorded.`,
				);
			}
			// An explicit route supersedes a failover marker: after this switch the live
			// session no longer runs the mapped model (see liveFailoverModel).
			this.failoverLive.delete(thread.id);
		}
		// AFTER the model switch, which re-derives the thinking level internally.
		// undefined = leave pi's own level alone (what every dispatch did before this
		// feature); pi clamps a level the model cannot do, which is why guard 2 exists.
		if (plan.effort !== undefined) {
			try {
				session.setThinkingLevel(plan.effort);
			} catch (error) {
				throw new DispatchAbort(
					`slate: aborting the dispatch to thread ${thread.id} — setting effort "${plan.effort}" failed: ` +
						`${sanitizeForNotify(error instanceof Error ? error.message : String(error), 200)}. ` +
						"Nothing ran and no episode was recorded.",
				);
			}
		}
	}

	/** The level a session is ACTUALLY on (post-clamp), when it is one pi/slate both know. */
	private sessionEffort(session: WorkerSession | undefined): ThinkingLevel | undefined {
		try {
			const level = session?.thinkingLevel as ThinkingLevel | undefined;
			return level !== undefined && THINKING_LEVELS.includes(level) ? level : undefined;
		} catch {
			return undefined;
		}
	}

	private async runDispatch(
		thread: ThreadRecord,
		opts: DispatchOptions,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		const prompt = this.buildPrompt(opts); // may throw on unknown episode ids (before any state change)
		await this.semaphore.acquire();
		try {
			return await this.runDispatchInner(thread, opts, prompt, ctx, signal, onProgress);
		} finally {
			this.semaphore.release();
		}
	}

	private async runDispatchInner(
		thread: ThreadRecord,
		opts: DispatchOptions,
		prompt: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		const usage: UsageStats = { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 };
		const lines: string[] = [];
		const emit = (done: boolean, status?: "ok" | "failed") =>
			onProgress?.({ threadId: thread.id, threadName: thread.name, lines, usage, done, status });

		let session: WorkerSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let onAbort: (() => void) | undefined;
		let messagesBefore = 0;
		let status: "ok" | "failed" = "ok";
		let diagnostics: string | undefined;
		/** The authoritative route for this action (apply-time plan); undefined if we never got that far. */
		let plan: RoutePlan | undefined;
		/** Set ONLY by an apply-time rejection: end the dispatch with no episode and no compression. */
		let aborted: DispatchAbort | undefined;
		const warnings: string[] = [];
		// Routing notices go to BOTH channels: the progress lines (so they are visible
		// while the action runs) and the tool result (so the ORCHESTRATOR reads them —
		// a cost cliff or an evidence gap is its decision to make, not the user's).
		const routeWarn = (message: string) => {
			warnings.push(message);
			lines.push(`⚠ ${message}`);
		};

		// AF3: status/diagnostics derive from the FINAL assistant message of this
		// action after prompt() settles — not from a sticky message_end flag. This
		// fixes a latent bug: pi retries transient provider errors internally and
		// strips the recovered errored attempts from session.messages, so an
		// errored message_end mid-run does NOT mean the action failed. Thrown
		// prompt() exceptions and orchestrator aborts still mean failed.
		const deriveOutcome = (thrown?: { error: unknown }) => {
			const final = lastAssistantMessage(session ? session.messages.slice(messagesBefore) : []);
			if (signal?.aborted) {
				return { status: "failed" as const, diagnostics: "aborted by orchestrator", final };
			}
			if (thrown) {
				const msg = thrown.error instanceof Error ? thrown.error.message : String(thrown.error);
				return { status: "failed" as const, diagnostics: msg, final };
			}
			if (!final) {
				return { status: "failed" as const, diagnostics: "worker produced no assistant message", final };
			}
			if (final.stopReason === "error" || final.stopReason === "aborted") {
				return {
					status: "failed" as const,
					diagnostics: final.errorMessage ?? `worker stopReason: ${final.stopReason}`,
					final,
				};
			}
			return { status: "ok" as const, diagnostics: undefined, final };
		};

		try {
			thread.status = "running";
			thread.updatedAt = Date.now();
			this.store.save();
			emit(false);

			session = this.live.get(thread.id);
			if (!session) {
				// The model a NEW session OPENS on is this action's resolved model — not
				// the thread's pin, which is only one of the inputs to it. Reject-only
				// (no `warn`): the authoritative plan runs below, once the session's
				// restored history makes the thread's context size knowable. Passing the
				// model explicitly also keeps overriding whatever model_change the session
				// file ends with (CQ3).
				const opening = this.planRoute({ thread, opts, ctx });
				// A NEW session gets the CURRENT frozen worker-extension set. A LIVE
				// cached session (reused when present) keeps whatever set it was opened
				// with — which is precisely why the resolution is frozen per session
				// (AD41): every worker in this session then shares one extension set.
				session = await openWorkerSession({
					ctx,
					sessionFile: thread.sessionFile || undefined,
					model: opening.model,
					tools: opts.tools ?? this.config.workerTools,
					promptDocs: this.config.workerPromptDocs,
					extensionPaths: this.resolveExtensions().paths,
				});
				this.live.set(thread.id, session);
				// A freshly opened session starts on its configured model — drop any
				// stale failover marker (possible if a previous live session was
				// disposed mid-dispatch after its marker was set).
				this.failoverLive.delete(thread.id);
				if (!thread.sessionFile && session.sessionFile) {
					thread.sessionFile = session.sessionFile;
					this.store.save();
				}
			}

			// APPLY-TIME validation + switch. Still unbilled: the session exists but has
			// not been prompted, so a rejection here costs nothing and must therefore
			// record nothing. This is the second of the two validations (module header),
			// and the first one that can see the thread's real context size — for a
			// RESUMED thread the early pass had no live session at all, and for a queued
			// one a predecessor action has since grown the context.
			try {
				plan = this.planRoute({
					thread,
					opts,
					ctx,
					contextTokens: this.contextTokens(session),
					warn: routeWarn,
				});
			} catch (error) {
				// The world moved between the early validation and now (the router list is
				// frozen per session, so this is a registry/credential/effort change).
				throw new DispatchAbort(
					`slate: aborting the dispatch to thread ${thread.id} before any billed work — ` +
						`${error instanceof Error ? error.message : String(error)} No episode was recorded.`,
				);
			}
			await this.applyRoute(session, plan, thread, ctx);
			if (plan.warnings.length > 0) emit(false);

			messagesBefore = session.messages.length;

			unsubscribe = session.subscribe((event: { type: string; [k: string]: unknown }) => {
				if (event.type === "tool_execution_start") {
					lines.push(`→ ${(event as unknown as { toolName: string }).toolName}`);
					emit(false);
				} else if (event.type === "message_end") {
					// Usage accumulation + progress lines ONLY — outcome is derived
					// after prompt() settles (see deriveOutcome above, AF3).
					const msg = (event as unknown as { message: WorkerAssistantMsg }).message;
					if (msg.role !== "assistant") return;
					usage.turns++;
					usage.input += msg.usage?.input ?? 0;
					usage.output += msg.usage?.output ?? 0;
					usage.cost += msg.usage?.cost?.total ?? 0;
					usage.contextTokens = msg.usage?.totalTokens ?? usage.contextTokens;
					const text = (msg.content ?? [])
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join(" ")
						.trim();
					if (text) lines.push(text.length > 120 ? `${text.slice(0, 120)}...` : text);
					emit(false);
				}
			});

			if (signal?.aborted) throw new Error("aborted before worker start");
			onAbort = () => void session?.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			// Attempt 1.
			let thrown: { error: unknown } | undefined;
			try {
				await session.prompt(prompt);
			} catch (error) {
				thrown = { error };
			}
			let outcome = deriveOutcome(thrown);
			({ status, diagnostics } = outcome);

			// Model failover — single hop, at most ONCE per dispatch: when the
			// attempt failed with a model-API error (never an abort or a context
			// overflow — see failover.ts) or prompt() threw AND the current model
			// now fails its auth check (state-based classification, AF10), switch
			// the LIVE session to the mapped model and re-prompt once. Usage keeps
			// accumulating through the same subscriber, and messagesBefore is
			// unchanged (same session), so the episode covers both attempts.
			const current = session.model;
			if (status === "failed" && !signal?.aborted && current) {
				// CN1/BG1 + CN2: every await below is a window in which the dispatch
				// can be aborted or this manager disposed. The abort listener cannot
				// cover it — session.abort() no-ops on an idle session — and a
				// DISPOSED worker session does not throw on setModel/prompt (workers
				// load no extensions, so the SDK's assertActive guard never fires on
				// this path). Re-check both hazards before each side effect; an abort
				// or disposal anywhere in the window means NO retry.
				const retryBlocked = () => signal?.aborted === true || this.live.get(thread.id) !== session;
				const candidate =
					isFailoverCandidate(outcome.final, current.contextWindow) ||
					(thrown !== undefined && (await isAuthFailure(ctx, current)));
				const resolvedMapping = candidate
					? await resolveMappedModel(ctx, this.config.modelFailover ?? {}, current.provider, current.id)
					: undefined;
				// GUARD 7 — THE FAILOVER CARVE-OUT (model-router). Failover BYPASSES the
				// router entirely: neither the list guard nor the effort guards run here,
				// and the mapped model is never required to be a routing candidate — a
				// model that just failed is worse than an unlisted one that works, so the
				// router must never veto a failover. Exactly two things are kept:
				//  · failover must never select the model that JUST FAILED. The config
				//    sanitizer already drops a self-mapping, so this restates the invariant
				//    for a manager handed a raw config — and for the case the sanitizer
				//    cannot see: per-action routing means `current` may no longer be the
				//    model the map was keyed on.
				//  · a NON-SUBSTITUTING window check: it warns, it never picks a different
				//    model, because substituting here would be the router vetoing failover
				//    by another name.
				const currentSpec = `${current.provider}/${current.id}`;
				const mapped =
					resolvedMapping && `${resolvedMapping.provider}/${resolvedMapping.id}` !== currentSpec ? resolvedMapping : undefined;
				if (mapped && this.routerResolution().on) {
					const failoverTokens = this.contextTokens(session);
					const window = mapped.contextWindow;
					if (failoverTokens !== undefined && typeof window === "number" && !this.fitsWindow(failoverTokens, window, ctx)) {
						routeWarn(
							`slate: the failover target ${mapped.provider}/${mapped.id} cannot hold thread ${thread.id}'s context ` +
								`(~${failoverTokens.toLocaleString("en-US")} tokens vs a ${window.toLocaleString("en-US")}-token window) — ` +
								"failing over anyway; pi will compact. Failover is never vetoed on window size.",
						);
					}
				}
				if (mapped && !retryBlocked()) {
					lines.push(`⚠ failover ${current.provider}/${current.id} ⇒ ${mapped.provider}/${mapped.id}`);
					emit(false);
					let switched = false;
					try {
						await session.setModel(mapped); // can throw on a failed live auth check
						switched = true;
					} catch {
						/* keep the original failure */
					}
					if (switched) {
						// The live session now runs the mapped model — sticky until the session
						// is disposed or a later dispatch routes it somewhere explicitly (the
						// thread record keeps its own base either way); record it for the
						// threads listing (AF12).
						this.failoverLive.set(thread.id, `${mapped.provider}/${mapped.id}`);
					}
					// Re-check after the setModel await. If the signal has NOT fired,
					// the once-listener is still armed, so a retry that does start
					// remains abortable (a fire in the microtask gap between this check
					// and prompt() startup is the residual race inherent to
					// AbortSignal listeners).
					if (switched && !retryBlocked()) {
						thrown = undefined;
						try {
							await session.prompt(FAILOVER_NUDGE);
						} catch (error) {
							thrown = { error };
						}
						outcome = deriveOutcome(thrown);
						({ status, diagnostics } = outcome);
						// CQ2: an aborted retry is an abort, not a failover failure.
						if (status === "failed" && !signal?.aborted) {
							diagnostics = `${diagnostics} (failover to ${mapped.provider}/${mapped.id} also failed)`;
						}
					}
				}
				// CQ2: an abort that landed anywhere in this failover window surfaces
				// as an abort (deriveOutcome checks the signal first) — never as the
				// stale attempt-1 error or a "failover also failed". Disposal without
				// abort keeps the attempt-1 outcome.
				if (signal?.aborted) ({ status, diagnostics } = deriveOutcome(thrown));
			}
		} catch (error) {
			// The ONE non-billed exit (module header). Everything else in this method —
			// including a session that could not be opened — keeps its historical
			// behaviour of becoming a FAILED episode, because by then the action was
			// attempted; a DispatchAbort is raised only from the pre-prompt routing
			// phase, where nothing has been spent, so it must not manufacture work.
			if (error instanceof DispatchAbort) aborted = error;
			else {
				status = "failed";
				diagnostics = error instanceof Error ? error.message : String(error);
			}
		} finally {
			unsubscribe?.();
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}

		if (aborted) {
			// No episode, no compressor call, no cost accounting. The thread goes back
			// to idle and is saved so it cannot be left stuck in "running", and NO final
			// progress event is emitted: the orchestrator sees a TOOL ERROR carrying
			// this message, not a finished action with an episode id.
			thread.status = "idle";
			thread.updatedAt = Date.now();
			this.store.save();
			throw new Error(aborted.message);
		}

		const actionMessages = session ? session.messages.slice(messagesBefore) : [];

		const episodeId = `${thread.id}.e${++thread.episodeSeq}`;
		const compressed = await compressEpisode({
			ctx,
			episodeId,
			threadId: thread.id,
			threadName: thread.name,
			task: opts.task,
			status,
			diagnostics,
			messages: actionMessages as unknown[],
			workerModel: session?.model ? { provider: session.model.provider, id: session.model.id } : undefined,
			configuredModel: this.config.episodeModel,
			modelFailover: this.config.modelFailover,
			signal: signal?.aborted ? undefined : signal,
		});

		// What the action ACTUALLY ran on: the live session's own model and level, so
		// a failover switch and pi's effort clamp are both reflected rather than the
		// intent recorded as if it had held. Falls back to the plan when there is no
		// session to ask (absence then means unknown, per the record's contract).
		const actualModel = session?.model ? `${session.model.provider}/${session.model.id}` : plan?.model;
		const actualEffort = this.sessionEffort(session) ?? plan?.effort;
		const episode: EpisodeRecord = {
			id: episodeId,
			threadId: thread.id,
			task: opts.task,
			status,
			file: compressed.file,
			...(actualModel ? { model: actualModel } : {}),
			...(actualEffort ? { effort: actualEffort } : {}),
			// The marker describes the level that was ASKED for: if pi clamped it to
			// something else, the evidence gap does not describe what actually ran.
			...(plan?.effortUnmeasured && actualEffort !== undefined && actualEffort === plan.effort
				? { effortUnmeasured: true as const }
				: {}),
			createdAt: Date.now(),
		};
		this.store.episodes.set(episodeId, episode);
		thread.episodeIds.push(episodeId);
		thread.status = "idle";
		thread.updatedAt = Date.now();
		// Accumulate session-wide worker spend (worker turns + episode compressor)
		// BEFORE save so it persists with the snapshot.
		this.store.workerCostUsd += usage.cost + compressed.costUsd;
		this.store.save();

		emit(true, status);

		return { episodeText: compressed.text, episode, thread, usage, warnings };
	}

	disposeAll(): void {
		for (const session of this.live.values()) {
			try {
				session.dispose();
			} catch {
				/* ignore */
			}
		}
		this.live.clear();
		this.failoverLive.clear(); // markers describe live sessions only (see liveFailoverModel)
	}
}
