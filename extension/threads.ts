/**
 * Coordinates one new thread for each accepted action.
 *
 * Validation runs before thread creation. The global semaphore limits parallel
 * actions. Each action opens one worker session. In-action failover can re-prompt
 * that session once. Terminal work creates at most one episode.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
// TYPE-ONLY, and deliberately so: the orchestrator's base-model tracker is
// created and wired in by index.ts; this module only reads it through the
// injected instance (and never calls expectOwnSwitch — a WORKER session's model
// switch is not an orchestrator switch, so it must not be announced as one).
import type { BaseModelTracker } from "./base-model.ts";
import { compressEpisode, EpisodePersistenceError, writeFailedEpisode } from "./episodes.ts";
import { isAuthFailure, isFailoverCandidate, resolveMappedModel } from "./failover.ts";
import type { ThinkingLevel } from "./model-profiles.ts";
import { captureObservation, durableObservation, shouldWarnFindingsGrammar, type ObservationCapture, type ObservationRecord } from "./observations.ts";
import { slateEpisodeId } from "./slate-files.ts";
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
	DEFAULT_CACHE_KEY_SHARDS,
	effectiveThreadType,
	isModelSpec,
	parseThreadType,
	resolveEpisodeFile,
	splitModelSpec,
	type EpisodeRecord,
	type EpisodeUsage,
	type SlateConfig,
	type SlateStore,
	type ThreadRecord,
	type ThreadType,
} from "./state.ts";
import { DEFAULT_WORKER_TOOLS, isJudgementThreadType, openWorkerSession, resolveModel, type WorkerSession } from "./worker.ts";
import { EMPTY_WORKER_EXTENSION_SET, type WorkerExtensionSet } from "./worker-extensions.ts";

export function workerPromptCacheKey(cwd: string, shard: number): string {
	// Sixteen hex characters provide a short stable project namespace without
	// sending a path or username. The worst key is 32 characters:
	// "slate-worker-" (13) + digest (16) + "-" (1) + shard 63 (2).
	const project = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return `slate-worker-${project}-${shard}`;
}

export const MAX_CONTEXT_EPISODES = 32;

/** Validate and deduplicate episode references while preserving first position. */
export function normalizeContextEpisodeIds(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
		throw new Error(`context must be a list of up to ${MAX_CONTEXT_EPISODES} episode ids.`);
	}
	if (value.length > MAX_CONTEXT_EPISODES) {
		throw new Error(`context accepts at most ${MAX_CONTEXT_EPISODES} episode ids.`);
	}
	return [...new Set(value)];
}

export interface DispatchOptions {
	/** Removed public field. Kept only so direct callers receive the migration error. */
	threadId?: unknown;
	name?: string;
	type?: ThreadType;
	task: string;
	contextEpisodeIds?: unknown;
	/** Removed public field. Kept only so direct callers receive the migration error. */
	freshContext?: unknown;
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
	/** Routing notices for this action. */
	warnings: readonly string[];
}

/** Loose shape of an assistant message as seen in session.messages / message_end. */
interface WorkerAssistantMsg {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	content?: Array<{ type: string; text?: string }>;
}

/** Preserve the final assistant message's text parts in their emitted order. */
function assistantMessageText(message: WorkerAssistantMsg): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
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

/** Remove Slate's injected user prompt by its exact role and text identity. */
export function messagesForCompression(messages: unknown[], injectedPrompt?: string): unknown[] {
	if (injectedPrompt === undefined) return messages;
	const textOf = (message: unknown): string | undefined => {
		const candidate = message as { role?: unknown; content?: unknown } | null;
		if (candidate?.role !== "user") return undefined;
		if (typeof candidate.content === "string") return candidate.content;
		if (!Array.isArray(candidate.content)) return undefined;
		return candidate.content
			.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
	};
	let removed = false;
	return messages.filter((message) => {
		if (removed || textOf(message) !== injectedPrompt) return true;
		removed = true;
		return false;
	});
}

/** Retry nudge for the in-action failover prompt. */
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
	private semaphore: Semaphore;
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

	/** The live model after an in-action failover. Disposal removes the marker. */
	liveFailoverModel(threadId: string): string | undefined {
		return this.live.has(threadId) ? this.failoverLive.get(threadId) : undefined;
	}

	async dispatch(
		opts: DispatchOptions,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		if (this.store.paused) {
			throw new Error("Slate is paused for handoff. New actions are rejected until handoff completes.");
		}
		if (opts.threadId !== undefined) {
			throw new Error('The "thread" field was removed. Create a new thread and pass earlier episode ids through "context".');
		}
		if (opts.freshContext !== undefined) {
			throw new Error('The "freshContext" field was removed. Pass earlier episode ids through "context".');
		}
		if (typeof opts.task !== "string" || opts.task.trim() === "") {
			throw new Error("task must be a non-empty string.");
		}
		const type = parseThreadType(opts.type, true)!
		const contextEpisodeIds = normalizeContextEpisodeIds(opts.contextEpisodeIds);
		const accepted: DispatchOptions = { ...opts, type, contextEpisodeIds };
		const prompt = this.buildPrompt(accepted, ctx.cwd);
		const early = planRoute(this.routeInputs(ctx, undefined, accepted));
		if (early.kind === "reject") throw new Error(early.reason);
		this.validateRequestedModel(ctx, accepted.model);
		const thread = this.createThread(accepted, early);
		return this.runDispatch(thread, accepted, prompt, ctx, signal, onProgress);
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
	private validateRequestedModel(ctx: ExtensionContext, spec: string | undefined): void {
		if (spec === undefined) return;
		const parts = splitModelSpec(spec);
		if (!parts) throw new Error(`Requested model "${sanitizeForNotify(spec, 80)}" is not a valid provider/id spec.`);
		try {
			const model = ctx.modelRegistry.find(parts.provider, parts.id);
			if (!model || ctx.modelRegistry.hasConfiguredAuth(model) !== true) {
				throw new Error("unavailable or has no configured credentials");
			}
		} catch (error) {
			throw new Error(`Requested model "${sanitizeForNotify(spec, 80)}" could not be validated: ${sanitizeForNotify(error instanceof Error ? error.message : String(error), 160)}.`);
		}
	}

	private createThread(opts: DispatchOptions, plan: RoutePlanProceed): ThreadRecord {
		const id = this.store.claimNextThreadId();
		const type = parseThreadType(opts.type, true)!
		const ordinal = Number(id.slice(1));
		const cacheKeyShard = this.config.cacheKeyEnabled === false
			? undefined
			: (ordinal - 1) % (this.config.cacheKeyShards ?? DEFAULT_CACHE_KEY_SHARDS);
		const configuredTools = opts.tools ?? this.config.workerTools;
		const tools = [...new Set(configuredTools && configuredTools.length > 0 ? configuredTools : DEFAULT_WORKER_TOOLS)];
		const now = Date.now();
		const record: ThreadRecord = {
			id,
			name: opts.name?.trim() || id,
			status: "queued",
			type,
			...(this.routerResolution().on ? {} : { model: opts.model }),
			...(plan.baseModel ? { baseModel: plan.baseModel } : {}),
			...(plan.baseEffort ? { baseEffort: plan.baseEffort } : {}),
			...(cacheKeyShard === undefined ? {} : { cacheKeyShard }),
			tools,
			createdAt: now,
			updatedAt: now,
		};
		this.store.threads.set(id, record);
		try {
			this.store.save();
		} catch (error) {
			this.store.threads.delete(id);
			throw error;
		}
		return record;
	}

	private buildPrompt(opts: DispatchOptions, cwd: string): string {
		const contextIds = normalizeContextEpisodeIds(opts.contextEpisodeIds);
		if (contextIds.length === 0) return opts.task;
		const parts: string[] = ["## Context from prior episodes (loaded by Slate)", ""];
		for (const id of contextIds) {
			const episode = this.store.episodes.get(id);
			if (!episode) throw new Error(`Unknown context episode "${sanitizeForNotify(id, 80)}". Known episodes: ${[...this.store.episodes.keys()].join(", ") || "none"}.`);
			const file = resolveEpisodeFile(cwd, episode.file);
			if (file === undefined) throw new Error(`Episode "${sanitizeForNotify(id, 80)}" is not a safe readable Slate episode file.`);
			parts.push(readFileSync(file, "utf8").trim(), "");
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
	 * the shared OFF resolution. That answer supplies no candidates, so candidate-dependent paths cannot walk an unreadable shape. The SHAPE check
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
		_session?: WorkerSession,
		failover?: { target: string; from: string; contextWindow?: number },
	): RoutePlanInput {
		return {
			thread,
			requestedModel: failover ? failover.target : opts.model,
			requestedEffort: failover ? undefined : opts.effort,
			resolution: this.routerResolution(),
			allowUnmeasuredEffort: this.config.router?.allowUnmeasuredEffort,
			hostModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			profiles: this.routerOffProfiles(ctx),
			failoverSwitch: failover !== undefined,
			failoverFrom: failover?.from,
		};
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
			// credentials. A housekeeping revert therefore warns and keeps the current model.
			// A PLAN-driven
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
	 * The new session receives the frozen worker-extension set for this orchestrator session.
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
			sessionFile: undefined,
			model: args.open.model,
			tools: args.tools,
			promptDocs: this.config.workerPromptDocs,
			extensionPaths: this.resolveExtensions().paths,
			writingCheck: this.config.writing?.check === true,
			reviewerCharter: isJudgementThreadType(type),
			promptCacheKey:
				this.config.cacheKeyEnabled === false || args.thread.cacheKeyShard === undefined
					? undefined
					: workerPromptCacheKey(args.ctx.cwd, args.thread.cacheKeyShard),
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

	private cancelBeforeStart(thread: ThreadRecord): never {
		this.store.threads.delete(thread.id);
		try {
			this.store.save();
		} catch {
			/* the in-memory removal remains authoritative */
		}
		throw new Error(`Thread ${thread.id} was cancelled before the action started. No thread or episode was recorded.`);
	}

	private async runDispatch(
		thread: ThreadRecord,
		opts: DispatchOptions,
		prompt: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		const episodeId = slateEpisodeId(thread.id)!;
		if (signal?.aborted) this.cancelBeforeStart(thread);
		await this.semaphore.acquire();
		try {
			if (signal?.aborted) this.cancelBeforeStart(thread);
			return await this.runDispatchInner(thread, opts, prompt, episodeId, ctx, signal, onProgress);
		} finally {
			this.semaphore.release();
		}
	}

	private async runDispatchInner(
		thread: ThreadRecord,
		opts: DispatchOptions,
		prompt: string,
		episodeId: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		const usage: UsageStats = { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 };
		let workerCostUsd: number | undefined;
		let reportedContextTokens: number | undefined;
		const episodeUsage: Partial<Pick<EpisodeRecord, "input" | "output" | "cacheRead" | "cacheWrite">> = {};
		const addEpisodeUsage = (field: keyof typeof episodeUsage, value: number | undefined) => {
			if (value === undefined) return;
			episodeUsage[field] = (episodeUsage[field] ?? 0) + value;
		};
		const compactionUsage: EpisodeUsage = {};
		let compactionCostUsd: number | undefined;
		const seenCompactionEvents = new WeakSet<object>();
		const addCompactionUsage = (reported: (EpisodeUsage & { cost?: { total?: number } }) | undefined) => {
			if (reported === undefined) return;
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				const value = reported[field];
				if (value !== undefined) compactionUsage[field] = (compactionUsage[field] ?? 0) + value;
			}
			const cost = reported.cost?.total;
			if (cost !== undefined) compactionCostUsd = (compactionCostUsd ?? 0) + cost;
		};
		const lines: string[] = [];
		const emit = (done: boolean, status?: "ok" | "failed") =>
			onProgress?.({ threadId: thread.id, threadName: thread.name, lines, usage, done, status });

		let session: WorkerSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let onAbort: (() => void) | undefined;
		let messagesBefore = 0;
		let workerCallStarted = false;
		let workerProducedResponse = false;
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

		thread.status = "running";
		thread.updatedAt = Date.now();
		try {
			this.store.save();
		} catch (error) {
			this.store.threads.delete(thread.id);
			try { this.store.save(); } catch { /* the in-memory rollback remains authoritative */ }
			throw new Error(
				`Slate could not start thread ${thread.id}: ${sanitizeForNotify(error instanceof Error ? error.message : String(error), 200)}. ` +
					"Nothing ran and no episode was recorded.",
			);
		}

		try {
			emit(false);
			const open = planSessionOpen(this.routeInputs(ctx, thread, opts));
			let baseline = NO_SESSION_BASELINE;
			({ session, baseline } = await this.openWorkerFor({
				thread,
				ctx,
				open,
				tools: thread.tools,
				report: routeWarn,
			}));

			// Apply-time validation catches registry changes before the first prompt.
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
			// actually be delivered.
			await this.applyRoute(session, plan, thread, ctx, signal, routeWarn, baseline);
			for (const message of applied.warnings) routeWarn(message);
			// Same division of labour for a SEEDED base: the planner decided it (purely),
			// this side writes it down — after the apply, for the same reason as above.
			this.persistReseededBase(thread, applied);

			if (applied.warnings.length > 0) emit(false);

			messagesBefore = session.messages.length;

			unsubscribe = session.subscribe((event: { type: string; [k: string]: unknown }) => {
				if (event.type === "message_update") {
					const message = (event as unknown as { message?: WorkerAssistantMsg }).message;
					if (message?.role === "assistant" && assistantMessageText(message).trim() !== "") workerProducedResponse = true;
				} else if (event.type === "tool_execution_start") {
					lines.push(`→ ${(event as unknown as { toolName: string }).toolName}`);
					emit(false);
				} else if (event.type === "compaction_end") {
					if (seenCompactionEvents.has(event)) return;
					seenCompactionEvents.add(event);
					const result = (event as unknown as {
						result?: { usage?: EpisodeUsage & { cost?: { total?: number } } };
					}).result;
					addCompactionUsage(result?.usage);
				} else if (event.type === "message_end") {
					// This event-local signal survives host compaction and retry rewrites of
					// session.messages. It therefore remains valid at episode selection time.
					const msg = (event as unknown as { message: WorkerAssistantMsg }).message;
					if (msg.role !== "assistant") return;
					if (assistantMessageText(msg).trim() !== "") workerProducedResponse = true;
					usage.turns++;
					usage.input += msg.usage?.input ?? 0;
					usage.output += msg.usage?.output ?? 0;
					addEpisodeUsage("input", msg.usage?.input);
					addEpisodeUsage("output", msg.usage?.output);
					addEpisodeUsage("cacheRead", msg.usage?.cacheRead);
					addEpisodeUsage("cacheWrite", msg.usage?.cacheWrite);
					const reportedCost = msg.usage?.cost?.total;
					if (reportedCost !== undefined) {
						workerCostUsd = (workerCostUsd ?? 0) + reportedCost;
						usage.cost += reportedCost;
					}
					const contextTokens = msg.usage?.totalTokens;
					if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && Number.isInteger(contextTokens) && contextTokens >= 0) {
						reportedContextTokens = contextTokens;
						usage.contextTokens = contextTokens;
					}
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
				const promptRun = session.prompt(prompt);
				// COMMIT POINT: prompt execution has started. A caller may no longer
				// roll this dispatch back or repeat its action on another thread.
				workerCallStarted = true;
				await promptRun;
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
						// Record the mapped model for this live action. Disposal removes the marker.
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
			// Apply-time rejection occurs before the worker call. Remove the accepted
			// placeholder so an unbilled abort leaves neither a thread nor an episode.
			this.store.threads.delete(thread.id);
			try {
				this.store.save();
			} catch {
				/* the in-memory removal remains authoritative */
			} finally {
				try { session?.dispose(); } catch { /* terminal cleanup continues */ }
				this.live.delete(thread.id);
				this.liveBaselines.delete(thread.id);
				this.failoverLive.delete(thread.id);
			}
			throw new Error(aborted.message);
		}

		const cancelledAfterStart = workerCallStarted &&
			(signal?.aborted === true || (session !== undefined && this.live.get(thread.id) !== session));
		if (cancelledAfterStart) {
			const reason = signal?.aborted === true ? "cancelled by the caller" : "cancelled during session teardown";
			thread.status = "cancelled";
			thread.outcomeReason = reason;
			thread.updatedAt = Date.now();
			try {
				this.store.save();
			} catch {
				/* retain the terminal cancellation in memory */
			} finally {
				try { session?.dispose(); } catch { /* terminal cleanup continues */ }
				this.live.delete(thread.id);
				this.liveBaselines.delete(thread.id);
				this.failoverLive.delete(thread.id);
			}
			throw new Error(`Thread ${thread.id} was ${reason}. No episode was recorded.`);
		}

		const actionMessages = session ? session.messages.slice(messagesBefore) : [];
		const compressionMessages = messagesForCompression(
			actionMessages,
			normalizeContextEpisodeIds(opts.contextEpisodeIds).length > 0 ? prompt : undefined,
		);

		// Derive the model once before either fixed failure writing or compression.
		const ranModel = session?.model
			? { provider: session.model.provider, id: session.model.id }
			: splitModelSpec(plan?.model);
		const actualModel = ranModel ? `${ranModel.provider}/${ranModel.id}` : undefined;
		const actualEffort = this.sessionEffort(session) ?? plan?.effort;

		// An event-local response flag and recorded billing survive host rewrites of
		// session.messages. Either selects compression even when the rewritten slice
		// no longer contains an assistant message. A reported zero cost still proves
		// that a call produced billing evidence.
		const actionHasBillingEvidence =
			workerCostUsd !== undefined ||
			compactionCostUsd !== undefined ||
			Object.values(compactionUsage).some((quantity) => quantity > 0);
		if (status === "failed" && !workerProducedResponse && !actionHasBillingEvidence) {
			const reason = diagnostics ?? "the worker action failed";
			const totalActionCost = usage.cost + (compactionCostUsd ?? 0);
			let failed: ReturnType<typeof writeFailedEpisode>;
			try {
				failed = writeFailedEpisode({
					ctx, episodeId, threadId: thread.id, threadName: thread.name, task: opts.task,
					diagnostics: reason, workerModel: ranModel, workerCostUsd: totalActionCost,
				});
			} catch (error) {
				const storageCause = error instanceof EpisodePersistenceError ? error.originalError : error;
				const storageDetail = sanitizeForNotify(storageCause instanceof Error ? storageCause.message : String(storageCause), 200);
				const storageReason = `failure episode persistence failed: ${storageDetail}`;
				thread.status = "failed";
				thread.outcomeReason = `${reason}; ${storageReason}`;
				thread.updatedAt = Date.now();
				this.store.workerCostUsd += totalActionCost;
				try { this.store.save(); } catch { /* retain the terminal outcome in memory */ }
				try { emit(true, "failed"); } catch { /* preserve the persistence failure */ }
				try { session?.dispose(); } catch { /* terminal cleanup continues */ }
				this.live.delete(thread.id);
				this.liveBaselines.delete(thread.id);
				this.failoverLive.delete(thread.id);
				throw new Error(`Thread ${thread.id} failed: ${sanitizeForNotify(reason, 200)}. Slate could not store episode ${episodeId}: ${storageDetail}.`);
			}
			const episode: EpisodeRecord = {
				id: episodeId, threadId: thread.id, task: opts.task, status: "failed", file: failed.file,
				...(actualModel ? { model: actualModel } : {}), ...episodeUsage,
				...(reportedContextTokens !== undefined ? { contextTokens: reportedContextTokens } : {}),
				...(workerCostUsd !== undefined ? { workerCostUsd } : {}),
				...(Object.keys(compactionUsage).length > 0 ? { compactionUsage } : {}),
				...(compactionCostUsd !== undefined ? { compactionCostUsd } : {}), createdAt: Date.now(),
			};
			this.store.episodes.set(episodeId, episode);
			thread.episodeId = episodeId;
			thread.status = "failed";
			thread.outcomeReason = reason;
			thread.updatedAt = Date.now();
			this.store.workerCostUsd += totalActionCost;
			let saveError: unknown;
			try { this.store.save(); } catch (error) { saveError = error; }
			try { session?.dispose(); } catch { /* terminal cleanup continues */ }
			this.live.delete(thread.id);
			this.liveBaselines.delete(thread.id);
			this.failoverLive.delete(thread.id);
			if (saveError !== undefined) {
				try { emit(true, "failed"); } catch { /* preserve the persistence error */ }
				throw new Error(`Slate stored episode ${episodeId}, but could not save its thread record: ${sanitizeForNotify(saveError instanceof Error ? saveError.message : String(saveError), 200)}.`);
			}
			try { emit(true, "failed"); } catch { /* preserve the failed result */ }
			return { episodeText: failed.text, episode, thread, usage, warnings };
		}
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


		// Capture before compression so an episode-write failure does not itself
		// remove the exact output. The returned union is the single source for the
		// path, byte count, truncation fact and structural grammar result.
		//
		// BG6: this feature must NEVER fail a dispatch and never fail an episode, so
		// EVERY step of it sits inside one guard — reading the final message,
		// extracting its text, the capture, both warnings and the progress emit.
		// The guard used to cover only the two fs calls inside captureObservation, so
		// a throw from any other step escaped, left the thread stuck "running" and
		// lost the episode the action had already paid for. The fallback below is the
		// answer to a throw: it is the same not-stored fact a failed write records,
		// because both mean there is no file to point at.
		let observation: ObservationCapture | ObservationRecord = {
			stored: false,
			reason: "write-failed",
			grammar: "absent",
			zeroFindings: false,
		};
		try {
			const finalMessage = lastAssistantMessage(actionMessages);
			observation = captureObservation(ctx.cwd, episodeId, finalMessage ? assistantMessageText(finalMessage) : undefined);
			const warningsBeforeObservation = warnings.length;
			if (!observation.stored && observation.reason === "write-failed" && "warning" in observation) routeWarn(observation.warning);
			const judgementType = isJudgementThreadType(thread.type);
			// SE1: the id can come from a restored snapshot, so every observation
			// warning uses the shared notification sanitizer.
			const safeEpisodeId = sanitizeForNotify(episodeId, 80);
			if (judgementType && !observation.stored && observation.reason === "no-final-message") {
				routeWarn(
					`slate: episode ${safeEpisodeId} produced no final response, so no compact findings row is available.`,
				);
			} else if (judgementType && !observation.stored && observation.reason === "no-final-text") {
				routeWarn(
					`slate: episode ${safeEpisodeId}'s final response contained no text blocks, so no compact findings row is available.`,
				);
			} else if (shouldWarnFindingsGrammar(
				status,
				judgementType,
				observation.grammar,
				"zeroFindings" in observation && observation.zeroFindings,
			)) {
				const responseScope = observation.stored ? "stored final response" : "final response";
				if (observation.grammar === "absent") {
					routeWarn(
						`slate: episode ${safeEpisodeId}'s ${responseScope} has no pipe-delimited findings row. Use exactly five fields for each finding, or end with the exact line No findings.`,
					);
				} else {
					routeWarn(
						`slate: episode ${safeEpisodeId}'s ${responseScope} has a malformed findings row. Use exactly five pipe-delimited fields for each finding.`,
					);
				}
			}
			if (warnings.length > warningsBeforeObservation) emit(false);
		} catch (error) {
			// Reporting is BEST EFFORT on purpose: the throw may have come from the
			// progress channel itself, and the dispatch must survive a broken one.
			// Whatever `observation` holds by now is kept — a capture that succeeded
			// before a later step threw keeps its real facts.
			try {
				routeWarn(
					`slate: could not record observations for episode ${sanitizeForNotify(episodeId, 80)} — ` +
						sanitizeForNotify(error instanceof Error ? error.message : String(error)),
				);
			} catch {
				/* nothing about an observation may end a dispatch */
			}
		}
		const durableObservations = durableObservation(observation);

		let compressed: Awaited<ReturnType<typeof compressEpisode>>;
		try {
			compressed = await compressEpisode({
				ctx,
				episodeId,
				threadId: thread.id,
				threadName: thread.name,
				task: opts.task,
				status,
				diagnostics,
				messages: compressionMessages as unknown[],
				observations: durableObservations,
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
		} catch (error) {
			// The live session has grown, but no episode will publish its new cache and
			// prefix evidence. The next choice must not reuse the older measurements.
			// Compression includes the episode-file write. If that write fails, the
			// earlier observation normally becomes an unreferenced orphan. It remains
			// until the user removes it. Persist every cost and recoverable session fact.
			//
			// A later session can reuse the id after snapshot repair drops a thread,
			// snapshot repair rebuilds a stale episode counter, or the process exits
			// before this increment is saved. A storing dispatch at that id overwrites
			// the orphan through writeFreshFile's unlink-and-recreate path. Known accepted
			// limitation: a non-storing dispatch (no-final-message, no-final-text or
			// write-failed) leaves stale prose while its episode header says "not stored".
			//
			// Never add failure-time rollback or orphan sweeping. Measurements on ext4
			// showed that inode reuse after unlink makes dev-plus-ino and strengthened
			// timestamp identities delete a later live file. writeFreshFile replaces the
			// canonical name only while storing the new artifact. Detached cleanup cannot
			// prove ownership and must not delete that name.
			this.store.workerCostUsd +=
				usage.cost +
				(error instanceof EpisodePersistenceError ? (error.costUsd ?? 0) : 0) +
				(compactionCostUsd ?? 0);
			const actionFailure = diagnostics ?? "the worker action failed";
			const storageCause = error instanceof EpisodePersistenceError ? error.originalError : undefined;
			const storageDetail = storageCause === undefined
				? undefined
				: sanitizeForNotify(storageCause instanceof Error ? storageCause.message : String(storageCause), 200);
			thread.status = "failed";
			thread.outcomeReason = status === "failed" && storageDetail !== undefined
				? `${actionFailure}; failure episode persistence failed: ${storageDetail}`
				: error instanceof Error ? error.message : String(error);
			thread.updatedAt = Date.now();
			try {
				this.store.save();
			} catch {
				/* report the original terminal failure through the stable tool boundary */
			} finally {
				try { session?.dispose(); } catch { /* terminal cleanup continues */ }
				this.live.delete(thread.id);
				this.liveBaselines.delete(thread.id);
				this.failoverLive.delete(thread.id);
			}
			const safeEpisodeId = sanitizeForNotify(episodeId, 80);
			lines.push(`✗ slate could not store episode ${safeEpisodeId}.`);
			try {
				emit(true, "failed");
			} catch {
				/* a broken progress channel must not replace the tool error */
			}
			if (status === "failed" && storageDetail !== undefined) {
				throw new Error(`Thread ${thread.id} failed: ${sanitizeForNotify(actionFailure, 200)}. Slate could not store episode ${safeEpisodeId}: ${storageDetail}.`);
			}
			throw new Error(`slate could not store episode ${safeEpisodeId}.`);
		}

		const episode: EpisodeRecord = {
			id: episodeId,
			threadId: thread.id,
			task: opts.task,
			status,
			file: compressed.file,
			...(actualModel ? { model: actualModel } : {}),
			...(actualEffort ? { effort: actualEffort } : {}),
			...(actualEffortUnmeasured ? { effortUnmeasured: true as const } : {}),
			observations: durableObservations,
			...episodeUsage,
			...(reportedContextTokens !== undefined ? { contextTokens: reportedContextTokens } : {}),
			...(workerCostUsd !== undefined ? { workerCostUsd } : {}),
			...(compressed.compressorUsage ? { compressorUsage: compressed.compressorUsage } : {}),
			...(compressed.costUsd !== undefined ? { compressorCostUsd: compressed.costUsd } : {}),
			...(Object.keys(compactionUsage).length > 0 ? { compactionUsage } : {}),
			...(compactionCostUsd !== undefined ? { compactionCostUsd } : {}),
			createdAt: Date.now(),
		};
		this.store.episodes.set(episodeId, episode);
		thread.episodeId = episodeId;
		thread.status = status === "failed" ? "failed" : "successful";
		if (status === "failed") thread.outcomeReason = diagnostics ?? "the worker action failed";
		thread.updatedAt = Date.now();
		// Accumulate session-wide worker spend, including compression and compaction,
		// BEFORE save so it persists with the snapshot.
		this.store.workerCostUsd += usage.cost + (compressed.costUsd ?? 0) + (compactionCostUsd ?? 0);
		let saveError: unknown;
		try {
			this.store.save();
		} catch (error) {
			saveError = error;
		} finally {
			try { session?.dispose(); } catch { /* terminal cleanup continues */ }
			this.live.delete(thread.id);
			this.liveBaselines.delete(thread.id);
			this.failoverLive.delete(thread.id);
		}
		if (saveError !== undefined) {
			try { emit(true, "failed"); } catch { /* preserve the persistence error */ }
			throw new Error(`Slate stored episode ${episodeId}, but could not save its thread record: ${sanitizeForNotify(saveError instanceof Error ? saveError.message : String(saveError), 200)}.`);
		}

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
