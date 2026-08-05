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
 *  - RESOLUTION: the planner's model is the explicit argument, else the thread's
 *    base model. Its effort is the explicit argument, else the thread's base effort
 *    WHEN THE BASE MODEL IS THE ROUTE TARGET, else a level derived for that target —
 *    a level never travels between planner targets (route.ts's THE ONE RULE, effort
 *    half). The GUARDS ALWAYS VALIDATE THE RESOLVED PAIR,
 *    never only the explicit arguments — an omitted argument must not escape
 *    validation.
 *
 *  - A THREAD'S BASE is not an action's route. With the router ON the base model
 *    is the resolver's cheapest preferred candidate, which is always a LISTED
 *    model, so a later dispatch that omits `model` can never be rejected by the
 *    list guard (model-router D48); the base effort seeds to the LOWEST MEASURED
 *    level for that model, never to the user's global thinking-level default. A
 *    model passed to the creating dispatch routes THAT action only. A base that is
 *    NOT a listed candidate — absent (a thread older than the config) or dropped by
 *    a list change — is SEEDED by the planner on its next dispatch and written back
 *    here (persistReseededBase), so the invariant holds for threads the config
 *    outlived instead of leaving them undispatchable or silently unrouted. Stated
 *    once, in route.ts's header: with the router ON a thread's base is ALWAYS a
 *    listed candidate.
 *
 *  - ROUTER OFF MAKES ROUTER-OWNED MECHANISMS INERT. No list guard, window guard,
 *    billing notice, seeded or persisted base, or consultation of the
 *    orchestrator's tracked model: a model-less plan targets the thread's
 *    creation-time PIN — which only opens a NEW worker session (`openOnly`) — and
 *    nothing at all when there is no pin, so a NEW session opens on the host's
 *    current model (worker.ts) and a reused one is reverted to the model it opened
 *    on — outside cases M1, M3 and M7 of the doc named below (BG16, BG24).
 *    The `model` and `effort` arguments still apply per action: an explicit
 *    `effort` is validated against the plan target's ladder whenever that ladder is
 *    readable, and a level set by one action is put back to the session's opening
 *    level by the next. The MODEL an explicit argument routes to is reverted the same
 *    way (BG22), outside those same cases; the failover hold predates the router, and
 *    an OFF plan does not undo it. docs/model-routing.md's "Known cases where the
 *    model or level differs" collects the ones known to bite, this file's included.
 *    It does not claim to be exhaustive, and this code is the authority.
 *
 *    An earlier iteration seeded the base from the tracker here and persisted it.
 *    That undid failovers on reused sessions, could strand a thread once its
 *    tracked model lost credentials, and stopped a restarted thread following the
 *    host's model. The tracker survives only as the episode compressor's
 *    last-resort rung.
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
 *
 *  - WHAT RAN IS REPORTED, never what was asked for. The model and level the LIVE
 *    session ended on — after pi's clamp, after a window substitution, after a
 *    failover — go into both the episode RECORD and the episode HEADER, and the
 *    evidence-gap marker rides along only when that exact pair is the one the
 *    guards judged. The compressor is handed the ORCHESTRATOR's base model as its
 *    last-resort rung and never the action's own model (the compressor pin, D5 —
 *    see episodes.ts).
 *
 * WHERE THE DECISION LIVES. The planning itself — the resolution rules and all
 * seven guards, with their wording — is route.ts, a PURE function: it takes the
 * frozen router resolution, the profile lookup, pi's compaction predicate and
 * reserve, the thread's context size and the raw arguments, and returns a
 * proceed/reject verdict. This module keeps only what is inherently impure:
 * reading the live session (its model, level and context size), assembling those
 * inputs, APPLYING the switch, and turning a rejection into either a tool error or
 * a non-billed abort. The split exists so the guards have permanent automated
 * coverage: verification/resolver-checks.mjs cannot load THIS module at all (it
 * transitively imports @earendil-works/pi-ai, an uninstalled peer dependency), but
 * it can load route.ts.
 */

import { existsSync, readFileSync } from "node:fs";
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
import { ROUTER_OFF, SHIPPED_PROFILE_SOURCE, type ModelRouterResolution, type RouterProfileSource } from "./model-router.ts";
import { sanitizeForNotify } from "./notify.ts";
import {
	captureSessionBaseline,
	decideEffortSwitch,
	decideModelSwitch,
	NO_SESSION_BASELINE,
	planRoute,
	planSessionOpen,
	THINKING_LEVELS,
	usableResolution,
	type RoutePlanInput,
	type RoutePlanProceed,
	type SessionBaseline,
	type SessionOpenDecision,
} from "./route.ts";
import {
	effectiveThreadType,
	isModelSpec,
	isThreadType,
	parseThreadType,
	splitModelSpec,
	type EpisodeRecord,
	type SlateConfig,
	type SlateStore,
	type ThreadRecord,
	type ThreadType,
} from "./state.ts";
import { openWorkerSession, resolveModel, type WorkerSession } from "./worker.ts";
import { EMPTY_WORKER_EXTENSION_SET, type WorkerExtensionSet } from "./worker-extensions.ts";

export interface DispatchOptions {
	threadId?: string;
	name?: string;
	type?: ThreadType;
	task: string;
	contextEpisodeIds?: string[];
	model?: string; // "provider/id" for THIS action (see the header): the thread's base model when omitted
	effort?: string; // pi thinking level for THIS action; validated against the target model's ladder
	tools?: string[];
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
	private limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
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
	/**
	 * threadId → models this thread has already had a long-context billing notice
	 * for. Guard 6's memory lives HERE and not in the planner: route.ts is pure, so
	 * it reports what it just warned about and this side records it.
	 */
	private longContextWarned = new Map<string, Set<string>>();
	/**
	 * threadId → what a LIVE worker session was OPENED on, both axes in one captured
	 * value: pi's clamped settings default for that session's model, and the model pi
	 * resolved for the model-less open plan. An action whose plan resolves no level runs
	 * at the opening level rather than inheriting the previous action's (BG18), and an
	 * action that names no model reverts the session to the opening model rather than
	 * letting one routed action govern the thread (BG22). Session-scoped, like `live`.
	 *
	 * ONE map of one branded value, written in exactly one place — the opening helper —
	 * and read by exactly one expression, the argument passed into applyRoute (TQ7).
	 * Both defects above were "the baseline came from somewhere else, later"; keeping the
	 * pair together and captured atomically is what leaves nowhere else for it to come
	 * from.
	 */
	private liveBaselines = new Map<string, SessionBaseline>();
	/** pi's compaction settings, read once (a lock-protected disk read) — see compactionSettings(). */
	private cachedCompaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	/** Session-owned persisted thread and episode state. */
	private store: SlateStore;
	/** This manager's immutable session configuration. */
	private config: SlateConfig;
	/** Frozen worker-extension resolver, bound by value to this session (AD41/CN20). */
	private resolveExtensions: () => WorkerExtensionSet;
	/** Memoized router resolver, bound by value to this session. */
	private resolveRouter: () => ModelRouterResolution;
	/** Orchestrator base model used only by the episode compressor's last-resort rung. */
	private baseModelTracker?: BaseModelTracker;

	constructor(
		store: SlateStore,
		config: SlateConfig,
		// This session's frozen worker-extension resolver (AD41), bound BY VALUE at
		// construction (CN20) so a manager orphaned by a session swap keeps its own
		// session's set instead of resolving against a later one's. Read lazily per
		// new worker. Defaults to the empty-set function so existing construction
		// sites and test harnesses keep working with the feature off.
		resolveExtensions: () => WorkerExtensionSet = () => EMPTY_WORKER_EXTENSION_SET,
		// This session's MEMOIZED model-router resolution (model-router.ts's
		// createModelRouterResolver), bound by value for the same reason as the
		// resolver above: a manager orphaned by a session swap must keep answering
		// with its own session's frozen candidate list. Defaults to the shared OFF
		// resolution, which supplies no candidates or router-owned base.
		resolveRouter: () => ModelRouterResolution = () => ROUTER_OFF,
		// The orchestrator's base model, EXCLUDING failover fallbacks (base-model.ts).
		// Consulted only for the episode compressor's last-resort model rung; route
		// planning never seeds a worker-thread base from this tracker.
		baseModelTracker?: BaseModelTracker,
	) {
		this.store = store;
		this.config = config;
		this.resolveExtensions = resolveExtensions;
		this.resolveRouter = resolveRouter;
		this.baseModelTracker = baseModelTracker;
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
	 * The marker is also DROPPED, not just on disposal, whenever a dispatch's own
	 * ROUTING moves the session (see applyRoute) — an explicit `model` argument, and
	 * with the router ON the thread's base, which a dispatch that omits `model`
	 * resolves to. It is not limited to an "explicit" reroute, and it must not be:
	 * this marker describes the model the live session is ACTUALLY on, so anything
	 * that moves the session off the mapped model has to clear it or the report
	 * becomes a lie. The one switch that never clears it is the REVERT (BG22), which
	 * cannot run while the marker is held — that is exactly how a failover survives
	 * the next action.
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
		// Tool schemas are descriptive rather than an enforcement boundary. Keep
		// this argument guard beside the model/effort guards below, as well as in
		// tools.ts, so direct callers cannot persist an unusable type.
		const requestedType = parseThreadType(opts.type, existing === undefined);
		const liveSession = existing ? this.live.get(existing.id) : undefined;
		const early = planRoute(this.routeInputs(ctx, existing, opts, liveSession));
		// Reject-only here: a rejection is a TOOL ERROR the orchestrator can correct,
		// raised before the thread record exists. The plan's WARNINGS are deliberately
		// dropped — the apply-time plan re-derives them with the thread's real context
		// size, and reporting them twice (or consuming guard 6's once-per-pair notice
		// before anyone could see it) would both be wrong.
		if (early.kind === "reject") throw new Error(early.reason);
		if (existing) this.setExistingThreadType(existing, requestedType);
		const thread = existing ?? this.createThread({ ...opts, type: requestedType }, early);

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
	 * Apply a continuation's optional type after early route validation. A
	 * matching value is the same silent no-op as a repeated `name`. A legacy
	 * absent or unrecognised value may be corrected once, but not while its worker is live because
	 * that session opened without the type's future charter and tool envelope.
	 */
	private setExistingThreadType(thread: ThreadRecord, requested: ThreadType | undefined): void {
		if (requested === undefined || thread.type === requested) return;
		if (isThreadType(thread.type)) {
			throw new Error(`Thread ${thread.id} has immutable type "${thread.type}"; it cannot be changed to "${requested}".`);
		}
		if (this.live.has(thread.id)) {
			throw new Error(
				`Thread ${thread.id} has a live worker session, so its type cannot be set safely. ` +
					"Dispose or restart the Slate session, then set the type before continuing the thread.",
			);
		}
		thread.type = requested;
		thread.updatedAt = Date.now();
		this.store.save();
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
	private createThread(opts: DispatchOptions, plan: RoutePlanProceed): ThreadRecord {
		const id = this.store.nextThreadId();
		const type = parseThreadType(opts.type, true);
		const record: ThreadRecord = {
			id,
			name: opts.name?.trim() || id,
			sessionFile: "",
			status: "idle",
			type,
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
	//
	// The DECISION is route.ts's (pure). What lives here is the part that cannot be
	// pure: reading this session's frozen resolver, pi's settings and the live
	// worker session, and assembling them into the planner's inputs.

	/**
	 * This session's frozen router resolution, defensively.
	 *
	 * A THROWING resolver, or one that hands back a malformed object, falls back to
	 * the shared OFF resolution. That answer supplies no candidates, so list, window,
	 * billing and substitution paths cannot walk an unreadable shape. The SHAPE check
	 * itself is route.ts's usableResolution, so the planner and this module cannot
	 * disagree about what a usable resolution is.
	 */
	private routerResolution(): ModelRouterResolution {
		try {
			return usableResolution(this.resolveRouter());
		} catch {
			return ROUTER_OFF;
		}
	}

	/**
	 * The orchestrator's base model, EXCLUDING slate's own failover fallbacks, so a
	 * worker never inherits a temporary fallback as its permanent default. Validated
	 * as a spec HERE, at the boundary it crosses, and tolerant of a broken tracker:
	 * a fallback is a routing decision, never a reason to fail a dispatch.
	 */
	private trackedBaseModel(): string | undefined {
		let tracked: string | undefined;
		try {
			tracked = this.baseModelTracker?.current();
		} catch {
			tracked = undefined;
		}
		return isModelSpec(tracked) ? tracked : undefined;
	}

	/**
	 * The profile lookup the ROUTER-OFF ladder answer uses.
	 *
	 * COMPOSED rather than passed straight through, so the answer stays identical to
	 * the pre-extraction one: that path resolved a throwaway one-model router list,
	 * which dropped a model that was unprofiled, unknown to pi's registry, or
	 * unauthenticated. A spec this session cannot actually serve therefore reports NO
	 * profile here — the effort guards then have no basis to refuse and pi's own
	 * clamp decides, exactly as before. Keeping the registry read in this closure is
	 * also what keeps route.ts free of it.
	 */
	private routerOffProfiles(ctx: ExtensionContext): RouterProfileSource {
		return {
			findProfile: (spec) => (this.registryCanServe(ctx, spec) ? SHIPPED_PROFILE_SOURCE.findProfile(spec) : undefined),
			ladderFor: (profile) => SHIPPED_PROFILE_SOURCE.ladderFor(profile),
		};
	}

	/** Whether pi's registry knows a spec AND has credentials configured for it. */
	private registryCanServe(ctx: ExtensionContext, spec: string): boolean {
		const parts = splitModelSpec(spec);
		if (!parts) return false;
		try {
			const model = ctx.modelRegistry.find(parts.provider, parts.id);
			return !!model && ctx.modelRegistry.hasConfiguredAuth(model) === true;
		} catch {
			return false; // cannot even resolve credentials ⇒ treat as unusable
		}
	}

	/**
	 * pi's own accounting of a live worker session's context size, or undefined when
	 * it is not knowable before dispatch — no live session (a fresh or resumed
	 * thread, before the session is opened), no model, or a post-compaction gap
	 * where pi itself reports the token count as unknown. undefined means the window
	 * guard is SKIPPED, never that the context is small.
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
	 * Assemble the PURE planner's inputs from this session's impure surroundings.
	 *
	 * `failover` switches it into guard 7's carve-out mode: the target replaces the
	 * requested model, no effort is requested, and the planner bypasses the list and
	 * effort guards. A failover target need not be a routing candidate, so its
	 * window is passed explicitly — there is no candidate to read it from.
	 */
	private routeInputs(
		ctx: ExtensionContext,
		thread: ThreadRecord | undefined,
		opts: DispatchOptions,
		session: WorkerSession | undefined,
		failover?: { target: string; from: string; contextWindow?: number },
	): RoutePlanInput {
		const resolution = this.routerResolution();
		// CQ17: the window guard is router-ON only, so with the router OFF pi's compaction
		// settings are NOT READ and no predicate is built. The router-OFF path must add no
		// router-owned SIDE EFFECT, not merely no router-owned decision: the read is a
		// lock-protected disk read, and performing it for a guard that cannot fire is the
		// kind of side effect that rule exists to forbid. (Memoized per manager, so this
		// was never a cost question.) Per-action argument and effort paths are unaffected
		// by it. The router-ON path is untouched, including the
		// `enabled: true` forcing below, which is load-bearing.
		const settings = resolution.on ? this.compactionSettings(ctx) : undefined;
		return {
			thread,
			requestedModel: failover ? failover.target : opts.model,
			requestedEffort: failover ? undefined : opts.effort,
			resolution,
			allowUnmeasuredEffort: this.config.router?.allowUnmeasuredEffort,
			// The orchestrator's tracked base model is deliberately NOT an input: with the
			// router OFF nothing is seeded from it (BG16 — seeding and persisting it undid
			// failovers, stranded threads whose tracked model lost credentials, and stopped
			// restarted threads following the host), and with the router ON the base is
			// always a candidate. It survives for the EPISODE COMPRESSOR's last-resort rung
			// only (trackedBaseModel, passed to compressEpisode).
			hostModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			contextTokens: this.contextTokens(session),
			// pi's OWN compaction predicate, bound to pi's compaction settings, so the
			// window guard cannot drift from pi's compaction point. `enabled` is FORCED
			// TRUE against the user's setting on purpose: disabling auto-compaction does
			// not make an over-window dispatch safe, it turns the compaction into an
			// overflow error instead — and shouldCompact answers `false` for every input
			// when compaction is disabled, which would silently delete guard 5 for those
			// users. Absent with the router off (CQ17), where guard 5 never runs.
			wouldCompact:
				settings === undefined ? undefined : (tokens, window) => shouldCompact(tokens, window, { ...settings, enabled: true }),
			reserveTokens: settings?.reserveTokens,
			profiles: this.routerOffProfiles(ctx),
			warnedLongContext: thread ? [...(this.longContextWarned.get(thread.id) ?? [])] : [],
			failoverSwitch: failover !== undefined,
			failoverFrom: failover?.from,
			contextWindow: failover?.contextWindow,
		};
	}

	/** Record that a thread has had the long-context billing notice for a model (guard 6's memory). */
	private noteLongContext(threadId: string, spec: string): void {
		const seen = this.longContextWarned.get(threadId) ?? new Set<string>();
		seen.add(spec);
		this.longContextWarned.set(threadId, seen);
	}

	/**
	 * Persist a base the planner had to SEED because the thread's own was not a
	 * listed candidate — off-list, or absent altogether (route.ts, THE ONE RULE).
	 * Without this the seed would be recomputed — and re-warned — on every dispatch,
	 * and the record would keep pointing outside the list (or nowhere).
	 *
	 * `baseEffort` is DELETED when the seeded base has no measured level: leaving the
	 * previous model's level behind would attach it to a model whose ladder was never
	 * consulted (absence reads as unknown, the record's contract).
	 */
	private persistReseededBase(thread: ThreadRecord, plan: RoutePlanProceed): void {
		if (plan.baseReseeded !== true || plan.baseModel === undefined) return;
		thread.baseModel = plan.baseModel;
		if (plan.baseEffort !== undefined) thread.baseEffort = plan.baseEffort;
		else delete thread.baseEffort;
		// The PRE-ROUTER pin (`model`) is deliberately LEFT ALONE: it is a historical
		// record of what the thread was created with, and `baseModel` — which is what
		// route.ts reads first — now supersedes it, so it can no longer strand anything.
		thread.updatedAt = Date.now();
		this.store.save();
	}

	/**
	 * Put the resolved model/effort onto the worker session — the LAST unbilled
	 * step of a dispatch, and the one that makes a non-billed abort reachable.
	 *
	 * WHAT A FAILURE MEANS depends on who asked for the switch (BG24), and the two
	 * answers are deliberate:
	 *  · a PLAN-driven switch — the caller's `model` argument, or the router's base —
	 *    that pi refuses, or whose spec no longer resolves, is a DispatchAbort: nothing
	 *    has been spent, so nothing is recorded, and the action does not run on a model
	 *    neither the caller nor the router chose;
	 *  · a REVERT — slate returning the session to the model it opened on, which nobody
	 *    requested — only WARNS and leaves the session where it is, because housekeeping
	 *    must not kill an action (pi's setModel THROWS on a missing key, unlike
	 *    setThinkingLevel, which merely clamps).
	 * Setting the thinking level, and an abort or disposal caught in the windows around
	 * the switch, are DispatchAborts for the same reason as the first case. This all runs
	 * BEFORE the first prompt() and before the message subscriber's baseline, so an
	 * aborted dispatch adds nothing to the thread.
	 */
	private async applyRoute(
		session: WorkerSession,
		plan: RoutePlanProceed,
		thread: ThreadRecord,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		warn: (message: string) => void,
		/**
		 * What the session was OPENED on — a PARAMETER, not a lookup (TQ7). Both switch
		 * decisions below need a baseline, and the failure mode of both is reading it live
		 * instead: this method runs at apply time, when the session's own state is no
		 * longer the opening state. Taking it as an argument means the value was captured
		 * before this method could exist, and the brand means a live reading cannot be
		 * passed in its place.
		 */
		baseline: SessionBaseline,
	): Promise<void> {
		// CN2: the switch below AWAITS, and every await is a window in which the dispatch
		// can be aborted or this manager disposed — exactly the hazard the failover phase
		// re-checks for (CN1/BG1/CN2 there). A disposed worker session does not throw on
		// setModel (workers load no extensions, so the SDK's assertActive guard never
		// fires), and an aborted dispatch that proceeds here still reaches the compressor
		// and BILLS one. So the same predicate is checked before and after the await, and
		// a hit aborts unbilled rather than becoming a failed episode.
		const blocked = (): string | undefined => {
			if (signal?.aborted === true) return "aborted by the orchestrator";
			if (this.live.get(thread.id) !== session) return "its worker session was disposed";
			return undefined;
		};
		const abortIfBlocked = () => {
			const why = blocked();
			if (why === undefined) return;
			throw new DispatchAbort(
				`slate: aborting the dispatch to thread ${thread.id} before any billed work — ${why}. ` +
					"No episode was recorded.",
			);
		};
		abortIfBlocked();
		// WHICH MODEL this action starts on is decided by route.ts's pure `decideModelSwitch`
		// (the plan's model, else the session's opening model as a REVERT, standing down
		// while a failover holds it). Everything it needs is passed explicitly, so the
		// decision — the part with the interesting cases — is checkable without a
		// ThreadManager; what stays here is the part that cannot be pure: resolving the
		// spec, awaiting the switch, and deciding what a failure means.
		const decision = decideModelSwitch({
			planned: plan.model,
			openOnly: plan.openOnly,
			current: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
			baseline,
			failoverHeld: this.failoverLive.get(thread.id) !== undefined,
		});
		if (decision.kind === "switch") {
			// BG24: what a FAILED switch means depends on WHO asked for it. pi's setModel
			// THROWS on a missing key (unlike setThinkingLevel, which only clamps), so a
			// revert — slate housekeeping the caller never requested — could abort a whole
			// dispatch just because the model the session opened on has since lost its
			// credentials. That is the auth-failover chain: the open model dies, an action
			// is routed elsewhere, and the next action's revert then kills the dispatch. A
			// revert therefore WARNS and leaves the session where it is; a PLAN-driven
			// switch stays fatal, because running the action on a model neither the caller
			// nor the router chose would break the routing contract itself.
			const fatal = decision.source === "plan";
			const giveUp = (what: string, error: unknown): void => {
				const detail = sanitizeForNotify(error instanceof Error ? error.message : String(error), 200);
				if (fatal) {
					throw new DispatchAbort(
						`slate: aborting the dispatch to thread ${thread.id} — ${what}: ${detail}. ` +
							"Nothing ran and no episode was recorded.",
					);
				}
				warn(
					`slate: could not return thread ${thread.id}'s worker session to the model it opened on ` +
						`(${sanitizeForNotify(decision.spec, 80)}) — ${detail}. This action runs on ` +
						`${sanitizeForNotify(session.model ? `${session.model.provider}/${session.model.id}` : "the session's current model", 80)} instead.`,
				);
			};
			let target: ReturnType<typeof resolveModel> | undefined;
			try {
				target = resolveModel(ctx, decision.spec);
			} catch (error) {
				// Same split: a plan target that no longer resolves aborts, a revert target
				// that no longer resolves is a warning (giveUp returns, and `target` stays
				// undefined, so nothing is switched).
				giveUp(`the model ${sanitizeForNotify(decision.spec, 80)} could not be resolved`, error);
			}
			if (target !== undefined) {
				try {
					await session.setModel(target);
					// A PLAN-driven switch supersedes a failover marker: the session no longer runs
					// the mapped model, so reporting one would be a lie (see liveFailoverModel). A
					// revert cannot reach here while a marker is held, so this only ever clears a
					// marker the plan's own route replaced.
					this.failoverLive.delete(thread.id);
				} catch (error) {
					giveUp(`switching its worker session to ${sanitizeForNotify(decision.spec, 80)} failed`, error);
				}
				// CN2 again: the await above is the window, so re-check AFTER it. The switch
				// already happened — the session is left on the new model, which costs nothing —
				// but no prompt follows and no episode is recorded.
				abortIfBlocked();
			}
		}
		// AFTER the model switch, which re-derives the thinking level internally.
		//
		// WHICH LEVEL, decided by route.ts's pure `decideEffortSwitch` — the model axis's
		// twin, and the executable form of invariant I1's effort half: the plan's level,
		// else the level the session OPENED on, so no action inherits the previous
		// action's (BG18). The asymmetries with the model axis are documented there: no
		// failover stand-down (a level cannot undo a rescue) and no fatality boundary
		// (setThinkingLevel clamps, it does not throw). The try/catch below is belt and
		// braces for that last claim, not a path pi is known to take.
		const effort = decideEffortSwitch({
			planned: plan.effort,
			current: this.sessionEffort(session),
			baseline,
		});
		if (effort.kind === "switch") {
			try {
				session.setThinkingLevel(effort.level);
			} catch (error) {
				throw new DispatchAbort(
					`slate: aborting the dispatch to thread ${thread.id} — setting effort "${effort.level}" failed: ` +
						`${sanitizeForNotify(error instanceof Error ? error.message : String(error), 200)}. ` +
						"Nothing ran and no episode was recorded.",
				);
			}
		}
	}

	/**
	 * OPEN a worker session for a thread and capture what it opened on.
	 *
	 * A separate method for one structural reason (TQ7): the dispatch's own `opts` is not
	 * in scope here. `?? opts.model` on the open model is the edit that shipped BG22 on
	 * the opening path and it re-inserts fully green, so the remedy is to put the opening
	 * where that expression cannot be written — the only model in scope is the one the
	 * pure derivation produced, and it is branded, so a hand-built decision is not a way
	 * round either. The baseline is captured HERE, in the same breath as the open and
	 * before any per-action switch, which is the property applyRoute now takes on trust
	 * from its parameter.
	 *
	 * A NEW session gets the CURRENT frozen worker-extension set. A LIVE cached session
	 * (reused when present) keeps whatever set it was opened with — which is precisely
	 * why the resolution is frozen per session (AD41): every worker in this session then
	 * shares one extension set.
	 */
	private async openWorkerFor(args: {
		thread: ThreadRecord;
		ctx: ExtensionContext;
		open: SessionOpenDecision;
		tools: string[] | undefined;
		report: (message: string) => void;
	}): Promise<{ session: WorkerSession; baseline: SessionBaseline }> {
		const type = effectiveThreadType(args.thread, args.report);
		const session = await openWorkerSession({
			ctx: args.ctx,
			sessionFile: args.thread.sessionFile || undefined,
			model: args.open.model,
			tools: args.tools,
			promptDocs: this.config.workerPromptDocs,
			extensionPaths: this.resolveExtensions().paths,
			writingCheck: this.config.writing?.check === true,
			reviewerCharter: type === "reviewer" || type === "adversarial",
		});
		this.live.set(args.thread.id, session);
		// A freshly opened session starts on its configured model — drop any stale
		// failover marker (possible if a previous live session was disposed mid-dispatch
		// after its marker was set).
		this.failoverLive.delete(args.thread.id);
		// THE BASELINE both axes fall back to, taken from the SESSION: the model pi
		// resolved for the model-less plan and the level it clamped to (BG18, BG22).
		const baseline = captureSessionBaseline(session);
		this.liveBaselines.set(args.thread.id, baseline);
		return { session, baseline };
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
		let plan: RoutePlanProceed | undefined;
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
			// The baseline of a REUSED session is the one captured when it was opened; the
			// open below replaces it for a new one. Read once, here, and passed down — see
			// applyRoute's `baseline` parameter (TQ7).
			let baseline = this.liveBaselines.get(thread.id) ?? NO_SESSION_BASELINE;
			if (!session) {
				// The model a NEW session OPENS on is what a MODEL-LESS dispatch would resolve
				// to — the thread's base or pin, or nothing — and NEVER this action's `model`
				// argument. That argument is per-ACTION: applyRoute applies it as a switch on
				// top, exactly as the per-action thinking level is applied on top of the level
				// the session opens at. Opening ON the routed model instead made the baseline
				// captured at the open equal to it, so an explicit model became the thread's
				// permanent default the moment its action was the one that opened the session
				// — BG22 on the opening path, the asymmetry that made the effort axis right
				// and the model axis wrong. Passing a model explicitly also keeps overriding
				// whatever model_change the session file ends with (CQ3).
				//
				// WHAT TO OPEN ON is route.ts's `planSessionOpen`: a MODEL-LESS resolution of
				// this dispatch's own inputs. It strips both arguments INSIDE the pure module
				// (BG22 on the opening path, BG25's unreachable rejection), so the rule is a
				// function of its inputs rather than a shape in this file — hand it the full
				// inputs and it must still answer with the thread's base or pin. Its answer is
				// then handed WHOLE to openWorkerFor, which cannot see this action's `opts` —
				// `?? opts.model` is the edit that shipped BG22, so the remedy is a scope in
				// which it does not compile rather than a rule this file must remember.
				const open = planSessionOpen(this.routeInputs(ctx, thread, opts, undefined));
				// BG25's tripwire: unreachable today (planSessionOpen enumerates why), and if a
				// future guard makes it reachable the session opens on the host model and the
				// thread's base or pin is lost for the session's lifetime. It must not be
				// silent a second time.
				if (open.unplanned !== undefined) {
					routeWarn(
						`slate: could not plan thread ${thread.id}'s default model ` +
							`(${sanitizeForNotify(open.unplanned, 160)}) — opening its worker session on the host's model instead, ` +
							"so an omitted `model` will resolve there until the session is disposed. This action's own routing is unaffected.",
					);
				}

				({ session, baseline } = await this.openWorkerFor({
					thread,
					ctx,
					open,
					tools: opts.tools ?? this.config.workerTools,
					report: routeWarn,
				}));
				// CQ18: the session FILE is deliberately not persisted yet. pi flushes a
				// session file only once it holds an assistant message, so this path can name
				// a file that does not exist — and a snapshot carrying one makes the next
				// restore drop the whole thread as stale (adoptSnapshot). It is recorded after
				// the action instead, when its existence is knowable.
			}

			// APPLY-TIME validation + switch. Still unbilled: the session exists but has
			// not been prompted, so a rejection here costs nothing and must therefore
			// record nothing. This is the second of the two validations (module header),
			// and the first one that can see the thread's real context size — for a
			// RESUMED thread the early pass had no live session at all, and for a queued
			// one a predecessor action has since grown the context.
			const applied = planRoute(this.routeInputs(ctx, thread, opts, session));
			if (applied.kind === "reject") {
				// The world moved between the early validation and now (the router list is
				// frozen per session, so this is a registry/credential/effort change).
				throw new DispatchAbort(
					`slate: aborting the dispatch to thread ${thread.id} before any billed work — ` +
						`${applied.reason} No episode was recorded.`,
				);
			}
			plan = applied;
			// APPLY FIRST, then record what was decided. Everything above this line can
			// still abort the dispatch unbilled, and an abort discards the warnings — so
			// nothing that MARKS a notice as delivered may run before the notice can
			// actually be delivered (BG17: the long-context memory was being consumed by a
			// dispatch that then aborted, silencing the warning for the rest of the
			// session). Past applyRoute the dispatch always ends in an episode and a result.
			await this.applyRoute(session, plan, thread, ctx, signal, routeWarn, baseline);
			for (const message of applied.warnings) routeWarn(message);
			// Guard 6's memory is this side's (route.ts is pure): record the pair the plan
			// just warned about, so the next action on it stays quiet.
			if (applied.longContextWarned !== undefined) this.noteLongContext(thread.id, applied.longContextWarned);
			// Same division of labour for a SEEDED base: the planner decided it (purely),
			// this side writes it down — after the apply, for the same reason as above.
			this.persistReseededBase(thread, applied);
			if (applied.warnings.length > 0) emit(false);

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
				// GUARD 7 — THE FAILOVER CARVE-OUT, planned by route.ts in failover mode:
				// the list and effort guards do not run, the mapped model is never required
				// to be a routing candidate (a model that just failed is worse than an
				// unlisted one that works), and the window check only WARNS — substituting
				// here would be the router vetoing failover by another name.
				//
				// A REJECT verdict here means "do not switch", never an error: the one rule
				// failover must obey is that a mapping may not resolve to the model that just
				// failed, and the pre-router response to that was a silent skip — so it stays
				// one. (The config sanitizer already drops a self-mapping; per-action routing
				// adds the case it cannot see, where `current` is no longer the model the map
				// was keyed on.)
				const failoverPlan = resolvedMapping
					? planRoute(
							this.routeInputs(ctx, thread, opts, session, {
								target: `${resolvedMapping.provider}/${resolvedMapping.id}`,
								from: `${current.provider}/${current.id}`,
								contextWindow: resolvedMapping.contextWindow,
							}),
						)
					: undefined;
				for (const message of failoverPlan?.warnings ?? []) routeWarn(message);
				const mapped = failoverPlan?.kind === "proceed" ? resolvedMapping : undefined;
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

		// WHAT THE ACTION ACTUALLY RAN ON — derived ONCE, and BEFORE the compressor
		// call, because two consumers must not disagree about it: the episode HEADER
		// (episodes.ts's `ran:` segment, the orchestrator's only window into what it
		// paid for) and the episode RECORD (the threads listing reads it back). It is
		// read from the LIVE SESSION, never from the request: pi CLAMPS a thinking level
		// the model cannot do, the window guard may have SUBSTITUTED the model, and a
		// mid-action failover switches it again — all three must be reported as they
		// happened. The plan is only a fallback for the model, for a session that never
		// resolved one; absence then reads as unknown, per the record's contract.
		const ranModel = session?.model
			? { provider: session.model.provider, id: session.model.id }
			: splitModelSpec(plan?.model);
		const actualModel = ranModel ? `${ranModel.provider}/${ranModel.id}` : undefined;
		const actualEffort = this.sessionEffort(session) ?? plan?.effort;
		// The unmeasured marker is a claim about the profile data for ONE (model, level)
		// pair — the pair the guards judged. It survives to the episode only if BOTH
		// halves of that pair are what actually ran, and the two halves are checked by the
		// side that can see them:
		//
		//  · THE LEVEL, here: pi CLAMPS a level the model cannot do, and only this side
		//    knows the level the plan asked for, so a clamp drops the marker rather than
		//    attaching a gap claim to a level nobody judged.
		//  · THE MODEL, in episodes.ts: `workerEffortJudgedFor` carries the planner's
		//    `effortJudgedFor` through verbatim, so the module that PRINTS the pair also
		//    verifies it against the model it is printing, instead of trusting a boolean it
		//    cannot check. That is also what keeps the marker on the router-OFF path, where
		//    the guards judge the HOST model and the plan carries no model of its own.
		//
		// The RECORD's own field has no judged-spec column, so it keeps the fully collapsed
		// answer (both halves) below.
		const effortIsAsPlanned = plan?.effortUnmeasured === true && actualEffort !== undefined && actualEffort === plan.effort;
		const actualEffortUnmeasured = effortIsAsPlanned && actualModel !== undefined && actualModel === plan?.effortJudgedFor;

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
			// Header only, all four (episodes.ts never picks the compressor from them —
			// that is the whole point of the compressor pin). `workerEffortUnmeasured` is the
			// LEVEL-checked flag and `workerEffortJudgedFor` is the spec it is a claim about,
			// so the header verifies the model half itself (see the derivation above).
			workerModel: ranModel,
			workerEffort: actualEffort,
			workerEffortUnmeasured: effortIsAsPlanned,
			workerEffortJudgedFor: plan?.effortJudgedFor,
			configuredModel: this.config.episodeModel,
			// The compressor's LAST-RESORT rung: the ORCHESTRATOR's base model from the
			// tracker (failover fallbacks excluded, spec-validated). Route planning no
			// longer consumes this tracker. Without it the compressor pin's bottom rung
			// could never fire, and a project with no episodeModel and no usable Sonnet
			// would drop straight to the uncompressed fallback.
			orchestratorBaseModel: this.trackedBaseModel(),
			modelFailover: this.config.modelFailover,
			signal: signal?.aborted ? undefined : signal,
		});

		const episode: EpisodeRecord = {
			id: episodeId,
			threadId: thread.id,
			task: opts.task,
			status,
			file: compressed.file,
			...(actualModel ? { model: actualModel } : {}),
			...(actualEffort ? { effort: actualEffort } : {}),
			...(actualEffortUnmeasured ? { effortUnmeasured: true as const } : {}),
			createdAt: Date.now(),
		};
		// CQ18: the worker session file exists only once pi has flushed it (it holds an
		// assistant message by now, if the action produced one). Recording the path only
		// when the file is really there keeps the next restore from dropping this thread as
		// stale; an action that never got that far simply leaves the thread without a
		// session file, which is what a fresh thread looks like anyway.
		if (!thread.sessionFile && session?.sessionFile && existsSync(session.sessionFile)) {
			thread.sessionFile = session.sessionFile;
		}
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
		this.liveBaselines.clear(); // baselines describe live sessions only (see applyRoute)
	}
}
