/**
 * Route planning: WHICH model and WHICH effort level one dispatched action runs
 * on, and the seven dispatch-time guards that decide whether it may run at all.
 *
 * PURE, INJECTED — the same discipline worker-extensions.ts and model-router.ts
 * follow, and for the same reason: the guards are the safety core of action-level
 * routing, and a guard that silently stops guarding still "works". Nothing here
 * reads a live pi session, pi's settings, the model registry or the clock. Every
 * environment fact arrives as a parameter: the compaction predicate and the
 * reserve-token count (pi's), the candidate list (the session's frozen router
 * resolution), the profile/ladder lookup, the thread's current context size, the
 * allow-unmeasured-effort setting, and whether this call is the in-dispatch
 * FAILOVER switch. So the whole guard set is exercisable against fabricated
 * in-memory inputs by verification/resolver-checks.mjs, which cannot load
 * threads.ts at all (it transitively imports @earendil-works/pi-ai, a peer
 * dependency this repo does not install).
 *
 * A REJECTION IS A RETURN VALUE, never a throw: the caller decides what one
 * means. In threads.ts an EARLY rejection is a tool error raised before any state
 * mutation, and an APPLY-TIME rejection aborts the dispatch without recording an
 * episode; in FAILOVER mode a rejection means "do not switch", not an error.
 *
 * THE ONE RULE, in BOTH dimensions, stated once. With the router ON:
 *
 *   MODEL — a thread's base model is ALWAYS a listed candidate, so the only way an
 *   action can run on an unlisted model is to name one explicitly, and that is
 *   rejected. A base that is ABSENT or has fallen OFF the list is RE-SEEDED to what
 *   a new thread would get (with a warning, persisted by the caller), never
 *   refused: the fall-through path must always have a valid destination, or
 *   configuring a list would strand every thread that predates it.
 *
 *   EFFORT — the level the planner resolves is ALWAYS one that belongs to the model
 *   it routes to: either the caller named it, in which case it is judged against THAT
 *   model's own ladder, or it is derived from that model (its lowest MEASURED level).
 *   A level derived for one model is never carried onto another, and a level
 *   STORED for this one is only replayed while today's table still reads it as `ok` —
 *   a cached derivation must not outlive the evidence it was derived from. `effort`
 *   therefore reports one and only one thing, and `effortJudgedFor` names the model
 *   the judgement was about — they always describe the same pair.
 *
 * Both halves used to hold only for the model. The effort half is why an explicit
 * `model` no longer inherits the thread's base level: that level was derived for a
 * DIFFERENT model, and applying it produced evidence-gap warnings — or, with
 * allowUnmeasuredEffort:false, outright rejections — for a level nobody requested.
 *
 * WITH THE ROUTER OFF ITS PLANNER-OWNED MECHANISMS ARE INERT. There is no list,
 * window guard, billing notice, seeded or persisted base, or tracker input. The
 * plan target is the `model` ARGUMENT (honoured per action) or else the thread's
 * PRE-ROUTER PIN; the pin only opens a NEW worker session and never instructs a
 * live one to switch (`openOnly`). A later switch decision KEEPS a held failover
 * fallback rather than applying an open-only target (decideModelSwitch). The raw
 * argument still passes through byte-for-byte, so a malformed spec produces pi's
 * own error rather than a router opinion.
 *
 * A FAILURE TO READ EVIDENCE IS NOT EVIDENCE OF A PROBLEM. Every injected data
 * source may be missing, throwing or malformed — a profile lookup, a ladder
 * lookup, a candidate entry, the compaction predicate, a window figure. In every
 * case the affected guard goes INERT (it does not fire) rather than refusing:
 * refusing on a read failure turns a data defect into an outage, and the guards
 * exist to prevent dispatches that are KNOWN to be wrong, not ones that could not
 * be checked. The exception is deliberate and narrow: a POSITIVE fact that is
 * still readable still counts — an `apiRejectedLevels` entry refuses the level
 * even when that model's ladder is unreadable.
 *
 * The guards, in the order they run — the order is load-bearing:
 *
 *   0. pi's effort VOCABULARY: an `effort` argument outside off/minimal/low/
 *      medium/high/xhigh/max is rejected before anything else looks at it — and so
 *      is one that is not a STRING at all, since reading a malformed argument as
 *      absent would quietly run the action at the thread's base level instead.
 *   1. LIST MEMBERSHIP (router ON only): a resolved model outside the effective
 *      candidate list is rejected, naming the list. With the router OFF this guard
 *      does not enforce a list; the raw model argument continues to pi unchanged.
 *      A THREAD'S BASE is exempt by REPAIR, not by exception — see THE ONE RULE
 *      above: absent or off-list, it is re-seeded, so only an EXPLICIT off-list
 *      model is ever refused.
 *   5. CONTEXT WINDOW: never a hard block, and it runs BEFORE the effort guards so
 *      that every effort judgement is about the model the planner routes to. The
 *      REGISTRY window (which is what a RouterCandidate carries; a profile's own
 *      figure is documentation only) reduced by pi's compaction reserve, judged by
 *      pi's OWN predicate. A model that cannot hold the thread's context is
 *      replaced by the widest candidate — only when that one is STRICTLY wider,
 *      since an equally narrow substitute buys nothing and only moves the action —
 *      with a warning; if nothing wider exists, the action still runs and says so.
 *      Skipped entirely when the context size is not knowable yet.
 *   4. API-REJECTED LEVEL, checked before the ladder because such a level IS on
 *      the model's pi ladder: the provider refuses it outright, so dispatching it
 *      is a guaranteed failure rather than an evidence gap, and
 *      allowUnmeasuredEffort does not cover it.
 *   2. LADDER VALIDITY, per model — never a union over models. pi CLAMPS an
 *      unsupported level silently, so without this guard the orchestrator would
 *      believe an action ran at a level the model never offered. It fires ONLY on a
 *      KNOWN ladder: an empty one means the data could not be read, not that the
 *      model offers nothing (see A FAILURE TO READ EVIDENCE above).
 *   3. EVIDENCE GAP: advisory. A ladder-valid level with no traced capability
 *      measurement is dispatchable with a warning, and refused only when the
 *      project set allowUnmeasuredEffort to false. It is never CHOSEN by default —
 *      a derived effort is always a measured level, so only an EXPLICIT `effort`
 *      can reach this guard.
 *   6. LONG-CONTEXT BILLING: a cost cliff, not a capacity limit. Warned once per
 *      thread and model — the caller owns that memory (warnedLongContext in,
 *      longContextWarned out), so this function keeps no state.
 *   7. FAILOVER CARVE-OUT (`failoverSwitch: true`): guards 1–4 are bypassed
 *      entirely and the window check becomes NON-SUBSTITUTING — it warns and
 *      proceeds. The router must never veto a failover; the one thing failover may
 *      not do is select the model that just failed.
 *
 * The EFFORT VERDICT ITSELF is not re-implemented here: model-router.ts's
 * checkEffort answers it, on both router states. With the router OFF this module
 * synthesises a one-candidate resolution from the injected profile lookup and
 * hands it to that same predicate, so the ladder answer stays per model and there
 * is exactly one implementation of "measured / gap / off-ladder / API-rejected".
 */

import type { ThinkingLevel } from "./model-profiles.ts";
import {
	checkEffort,
	coveringPriceRow,
	isValidPrice,
	routerProfileText,
	sanitizeRouterWarning,
	ROUTER_OFF,
	type EffortCheck,
	type ModelRouterResolution,
	type RouterCandidate,
	type RouterProfileSource,
} from "./model-router.ts";
import { sanitizeForNotify } from "./notify.ts";

/**
 * pi's thinking-level vocabulary, ASCENDING — the same union as
 * model-profiles.ts's ThinkingLevel and pi's own. The order is load-bearing
 * twice: it decides which measured level is the "lowest" when seeding a thread's
 * base effort, and it is the list a rejected `effort` argument is explained
 * against. Ascending order is taken from HERE rather than from a profile's ladder
 * so the answer never depends on the table's authoring order.
 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The slice of a thread record this module reads — state.ts's ThreadRecord
 * satisfies it structurally, so callers pass one directly and checks fabricate an
 * object literal. `model` is the PRE-ROUTER pin and is read only as the fallback
 * base of a thread restored from a snapshot written before `baseModel` existed.
 */
export interface RouteThread {
	id: string;
	baseModel?: string;
	baseEffort?: ThinkingLevel;
	model?: string;
}

/** Everything one planning decision depends on. Only `resolution` is required. */
export interface RoutePlanInput {
	/** The thread this action runs on; undefined = a thread that does not exist yet. */
	thread?: RouteThread;
	/** The dispatch's `model` argument, raw and unvalidated. */
	requestedModel?: string;
	/** The dispatch's `effort` argument, raw and unvalidated. */
	requestedEffort?: string;
	/** The session's FROZEN router resolution. An off resolution supplies no router candidates. */
	resolution: ModelRouterResolution;
	/** router.allowUnmeasuredEffort. Default TRUE: only an explicit false refuses an evidence gap. */
	allowUnmeasuredEffort?: boolean;
	/**
	 * "provider/id" the worker session opens on when nothing is resolved (the host's
	 * current model). Read ONLY to name the model the effort guards judge in that
	 * case; it never becomes a thread's base, because with the router OFF this module
	 * seeds nothing and with the router ON the base is always a candidate.
	 */
	hostModel?: string;
	/** pi's accounting of the thread's context size; undefined = not knowable ⇒ the window guard is skipped. */
	contextTokens?: number;
	/**
	 * pi's OWN compaction predicate, already bound to pi's compaction settings:
	 * "would this many tokens trigger compaction on a window this size?". Absent =
	 * no way to judge capacity ⇒ the window guard is skipped rather than guessed.
	 */
	wouldCompact?: (contextTokens: number, contextWindow: number) => boolean;
	/** pi's compaction reserve, for the warning TEXT only — the decision is wouldCompact's. */
	reserveTokens?: number;
	/**
	 * Profile + ladder lookup, consulted ONLY when the router is off (a candidate
	 * already carries both). Absent ⇒ no ladder data ⇒ no basis to refuse an effort
	 * level, which is the pre-router behaviour: pi clamps it.
	 */
	profiles?: RouterProfileSource;
	/** Models this THREAD has already had a long-context billing notice for (guard 6's memory). */
	warnedLongContext?: readonly string[];
	/** true = this call is the in-dispatch failover switch (guard 7). */
	failoverSwitch?: boolean;
	/** In failover mode: the model that just failed, which the mapping may never resolve to. */
	failoverFrom?: string;
	/** In failover mode: the target's REGISTRY context window (a failover target need not be a candidate). */
	contextWindow?: number;
	/** Optional UTC date override for fabricated dispatch-time price checks. */
	currentDate?: () => string;
}

/** The action may run, on exactly this model and level. */
export interface RoutePlanProceed {
	kind: "proceed";
	/** Effective "provider/id"; undefined = leave the session on its own model (nothing resolvable). */
	model?: string;
	/**
	 * Effective level; undefined = the caller must restore the session's OWN baseline
	 * (the level it opened on), never leave a previous action's level in place.
	 */
	effort?: ThinkingLevel;
	/** The effective level is ladder-valid but has NO capability measurement. */
	effortUnmeasured: boolean;
	/**
	 * The spec the EFFORT guards judged `effort` against — the effective model when
	 * there is one, else `hostModel` (the model the worker session will open on).
	 * Always the model the level belongs to, so a consumer attributing the level, or
	 * the unmeasured marker, has the pair the judgement was actually about; with the
	 * router OFF `model` is deliberately absent and this is the only name available.
	 * Absent only when no level was resolved at all.
	 */
	effortJudgedFor?: string;
	/**
	 * true = `model` is the model a NEW worker session OPENS on and NOTHING MORE: a
	 * live session must not be switched to it. That is the pre-router meaning of a
	 * thread's `model` pin (router OFF), where switching a reused session would undo a
	 * failover and could strand a thread whose pinned model lost its credentials.
	 */
	openOnly?: true;
	/**
	 * The base model to PERSIST: for a new thread, its base; for an existing one
	 * whose stored base was not routable, the RE-SEEDED base (see
	 * `baseReseededFrom`). Never an action's route.
	 */
	baseModel?: string;
	/** The base effort to persist, alongside `baseModel` (re-derived when the base is re-seeded). */
	baseEffort?: ThinkingLevel;
	/**
	 * true when an EXISTING thread's base was not a listed candidate — absent, or
	 * fallen off the list — and was therefore seeded to one. The caller MUST persist
	 * `baseModel`/`baseEffort` onto the thread record when this is set, so the seed
	 * (and its warning) happens once instead of on every dispatch.
	 */
	baseReseeded?: true;
	/** The spec the seed REPLACED, when there was one; absent when the thread had no base. */
	baseReseededFrom?: string;
	/** Set when the window guard replaced the resolved model: the spec it replaced. */
	substitutedFrom?: string;
	/** Set when this plan emitted the long-context notice for that spec — the caller records it. */
	longContextWarned?: string;
	/** Advisory notices for the orchestrator, in order. */
	warnings: readonly string[];
}

/**
 * THE BASELINE a live worker session's later actions fall back to, on BOTH axes: the
 * model pi opened it on and the level pi clamped it to at that moment.
 *
 * BRANDED (TQ7), and that brand is the reason this type exists at all. Both flagship
 * defects of this track are one mistake — the baseline read from the wrong place at the
 * wrong TIME. BG22 took it after the per-action model had been applied; BG18 fell back
 * to the session's CURRENT level instead of its opening one. Both survived a fix round
 * with every check green, because the wrong expression is a live reading and a live
 * reading has the same primitive type as the right value. Making the baseline a branded
 * OBJECT that only `captureSessionBaseline` can produce takes that away:
 * `baseline: this.sessionEffort(session)` and `baseline: currentSpec` stop being
 * type-correct edits at the decision sites.
 *
 * The brand is type-only and erased at run time, so a harness still fabricates one as a
 * plain `{ model, effort }` object — every read of it below is defensive for that reason.
 */
declare const SESSION_BASELINE_BRAND: unique symbol;
export interface SessionBaseline {
	readonly [SESSION_BASELINE_BRAND]: true;
	/** "provider/id" the session was opened on; absent when pi reported none. */
	readonly model?: string;
	/** The level pi clamped the session to at open time; absent when it reported none. */
	readonly effort?: ThinkingLevel;
}

/** The baseline of a session that is not open yet: no revert target on either axis. */
export const NO_SESSION_BASELINE = {} as SessionBaseline;

/**
 * The session's own state at the moment it was opened, read off the SESSION OBJECT
 * (TQ7). The parameter is the session itself and not a record the caller assembles, so
 * there is no argument-shaped input a caller can substitute for it; the level is
 * validated against pi's vocabulary and the model taken byte-for-byte (RG1).
 *
 * WHEN it is called still matters, and no type can enforce that: it must be called once,
 * immediately after the open and before any per-action switch. That residual is why the
 * only caller is the opening helper itself, which is the only place a session exists in
 * that state.
 */
export function captureSessionBaseline(session: {
	model?: { provider?: unknown; id?: unknown };
	thinkingLevel?: unknown;
}): SessionBaseline {
	const model =
		typeof session?.model?.provider === "string" && typeof session?.model?.id === "string"
			? argModel(`${session.model.provider}/${session.model.id}`)
			: undefined;
	const effort = storedLevel(session?.thinkingLevel);
	return {
		...(model !== undefined ? { model } : {}),
		...(effort !== undefined ? { effort } : {}),
	} as SessionBaseline;
}

/**
 * Inputs of the MODEL-SWITCH decision — what to do with a live worker session once
 * the plan is settled. Every field is a plain value the caller reads off its own
 * state, so the decision is checkable without a ThreadManager (that opacity is why
 * BG22 survived a fix round with no automated net).
 */
export interface ModelSwitchInput {
	/** `RoutePlanProceed.model`: the model the plan resolved for THIS action. */
	planned?: string;
	/** `RoutePlanProceed.openOnly`: `planned` chooses what a NEW session opens on, nothing more. */
	openOnly?: boolean;
	/** "provider/id" the live session is on right now. */
	current?: string;
	/**
	 * What the session was OPENED on — the revert target of a model-less action (BG22).
	 * A captured baseline, never a live reading: see SessionBaseline (TQ7).
	 */
	baseline?: SessionBaseline;
	/** true while a FAILOVER holds the session: the revert stands down (BG16). */
	failoverHeld?: boolean;
}

/**
 * The decision. `source` matters to the caller beyond bookkeeping: a switch the PLAN
 * asked for is the action's own routing and a failure to perform it must fail the
 * action, while a REVERT is slate's housekeeping and a failure to perform it must not
 * (BG24).
 */
export type ModelSwitchDecision =
	| { kind: "switch"; spec: string; source: "plan" | "revert" }
	| { kind: "keep"; reason: "no-baseline" | "failover-held" | "already-current" };

/**
 * WHICH MODEL a live worker session must be on for this action — the whole rule, in
 * one pure function.
 *
 *   1. A model the PLAN says to apply: an explicit `model` argument, or (router ON)
 *      the thread's base. `openOnly` excludes the one case that is not an instruction
 *      to move a live session — the router-OFF `model` pin, which only ever chose what
 *      a NEW session opens on. Switching a reused session onto it would undo a
 *      failover and could strand a thread whose pin lost its credentials (BG16).
 *   2. Failing that, the model the session was OPENED on. This is the REVERT, and it
 *      is what makes `model` per-ACTION: without it one explicit route governs every
 *      later action on the thread, because a dispatch that omits `model` resolves to a
 *      pin (open-only) or to nothing and so has nothing to switch back to (BG22). It
 *      is the model-axis twin of restoring the session's opening thinking level.
 *   3. The revert stands down while a FAILOVER holds the session: that switch was
 *      slate rescuing a failing model, not a route this side chose, and undoing it on
 *      the next action is precisely BG16. A plan-driven switch still supersedes it —
 *      the session then genuinely runs the routed model, and the caller drops the
 *      marker.
 *
 * The BASELINE the caller passes must be what a MODEL-LESS plan resolves to, not what
 * a routed open happened to use — otherwise an explicit per-action model becomes the
 * thread's permanent default the moment that action is the one that opens the session,
 * which is BG22 on the opening path.
 *
 * Every spec here is read BYTE-FOR-BYTE (RG1): only a non-string or the empty string
 * reads as absent, exactly as planRoute reads the `model` argument. A padded or
 * whitespace-only spec is therefore carried through to pi's own resolver, whose error
 * names the defect — this function never repairs a spec and never silently drops one.
 */
export function decideModelSwitch(input: ModelSwitchInput): ModelSwitchDecision {
	// RG1: `argModel`, not `specArg` — the SAME reader planRoute uses for the `model`
	// argument, so a spec is read identically at both ends of a dispatch. Trimming here
	// silently repaired a padded spec into a successful switch (CQ13 promises pi's own
	// error instead) and turned a whitespace-only one into "absent", which quietly ran
	// the action on the revert target. One rule for model specs, wherever they are read.
	const planned = argModel(input.planned);
	// `?.`: the brand is erased at run time, so a fabricated input may omit the object.
	const baseline = argModel(input.baseline?.model);
	const current = argModel(input.current);
	let target: string;
	let source: "plan" | "revert";
	if (planned !== undefined && input.openOnly !== true) {
		target = planned;
		source = "plan";
	} else if (baseline === undefined) {
		return { kind: "keep", reason: "no-baseline" };
	} else if (input.failoverHeld === true) {
		return { kind: "keep", reason: "failover-held" };
	} else {
		target = baseline;
		source = "revert";
	}
	if (target === current) return { kind: "keep", reason: "already-current" };
	return { kind: "switch", spec: target, source };
}

/**
 * Inputs of the EFFORT-SWITCH decision — the twin of ModelSwitchInput, and named to
 * match it field for field so the two axes read as one rule (invariant I1).
 */
export interface EffortSwitchInput {
	/** `RoutePlanProceed.effort`: the level the plan resolved for THIS action. */
	planned?: ThinkingLevel;
	/** The level the live session is on right now. */
	current?: ThinkingLevel;
	/**
	 * The level the session was OPENED on — where a level-less action returns to (BG18).
	 * The same captured baseline object the model axis reads (TQ7), so neither axis can
	 * be handed a live reading in its place.
	 */
	baseline?: SessionBaseline;
}

/**
 * The decision, shaped like ModelSwitchDecision, with ONE deliberate asymmetry: there
 * is no `failoverHeld` input and no fatality boundary, because the two things that
 * force them on the model axis are absent here.
 *
 *  · NO FAILOVER STAND-DOWN. Reverting the MODEL after a failover would undo the
 *    rescue (BG16). A level is re-clamped by pi for whichever model is current, so
 *    restoring the session's opening level cannot undo anything — and NOT restoring it
 *    is BG18, a previous action's level silently governing this one. The model axis
 *    stands down; the effort axis must not.
 *  · NO `source`-DRIVEN FATALITY. pi's `setModel` THROWS on a missing key, which is why
 *    the model axis has to distinguish a caller-requested switch (fatal) from a revert
 *    (a warning) — BG24. `setThinkingLevel` never throws: it CLAMPS to what the model
 *    supports. So there is nothing for a fatality boundary to decide, and `source` is
 *    reported for diagnostics and checks only.
 */
export type EffortSwitchDecision =
	| { kind: "switch"; level: ThinkingLevel; source: "plan" | "revert" }
	| { kind: "keep"; reason: "no-baseline" | "already-current" };

/**
 * WHICH LEVEL a live worker session must be on for this action — the effort axis's
 * whole rule, in one pure function, mirroring decideModelSwitch:
 *
 *   1. the level the PLAN resolved (an explicit `effort`, the thread's stored default
 *      once re-validated, or one derived for the model the planner routes to);
 *   2. failing that, the level the session was OPENED on — pi's clamped settings
 *      default. This is the RESTORE, and it is what makes `effort` per-ACTION: without
 *      it a level set by one action silently governs the next (BG18).
 *
 * Every level is validated against pi's vocabulary on the way in (the BG21 rule), so a
 * value that is not a level reads as absent rather than being handed to pi.
 */
export function decideEffortSwitch(input: EffortSwitchInput): EffortSwitchDecision {
	const planned = storedLevel(input.planned);
	const baseline = storedLevel(input.baseline?.effort);
	const current = storedLevel(input.current);
	let target: ThinkingLevel;
	let source: "plan" | "revert";
	if (planned !== undefined) {
		target = planned;
		source = "plan";
	} else if (baseline === undefined) {
		return { kind: "keep", reason: "no-baseline" };
	} else {
		target = baseline;
		source = "revert";
	}
	if (target === current) return { kind: "keep", reason: "already-current" };
	return { kind: "switch", level: target, source };
}

/**
 * A model that CAME OUT of the session-open derivation. Branded for the same reason as
 * SessionBaseline (TQ7): `open.model ?? opts.model` — one line outside the helper, and
 * the exact edit that shipped BG22 on the opening path — is then no longer a way to
 * build a SessionOpenDecision, and the opening helper takes nothing else it could open
 * on.
 */
declare const OPEN_MODEL_BRAND: unique symbol;
export type OpenModel = string & { readonly [OPEN_MODEL_BRAND]: true };

/** What a NEW worker session must be opened with, and what went wrong deciding it. */
export interface SessionOpenDecision {
	/** The model to hand the opener; undefined = none, so pi uses the host session's model. */
	readonly model?: OpenModel;
	/**
	 * Set ONLY when the model-less plan rejected — which is unreachable today (see
	 * planSessionOpen) and which the caller must therefore REPORT rather than absorb:
	 * the session would open on the host model and the thread's base or pin would be
	 * lost for the session's lifetime, which is BG25's symptom.
	 */
	readonly unplanned?: string;
}

/**
 * WHAT A NEW WORKER SESSION OPENS ON — a MODEL-LESS resolution of the same inputs, and
 * never the action's own arguments.
 *
 * The stripping happens HERE, inside the pure module, and that placement is the point.
 * A session opened on this action's `model` makes that argument the baseline every
 * later action reverts to, i.e. the thread's permanent default — BG22 on the opening
 * path, which shipped once already. While the rule lived as wiring in the caller it
 * could only be pinned by a regex over that caller's source, and a regex cannot see a
 * `?? opts.model` bolted onto the result: the defect would read as green. As a function
 * of its inputs it is executable — hand it a `requestedModel`/`requestedEffort` and the
 * answer must still be the thread's base or pin.
 *
 * `requestedEffort` is stripped as well (BG25), which is what makes a rejection
 * unreachable: every reject path in planRoute needs one of the two arguments this
 * removes, a `failoverSwitch` only the failover call site sets, or a base the seed rule
 * has already made routable.
 */
export function planSessionOpen(input: RoutePlanInput): SessionOpenDecision {
	const verdict = planRoute({ ...input, requestedModel: undefined, requestedEffort: undefined });
	if (verdict.kind === "reject") return { unplanned: verdict.reason };
	return { model: verdict.model as OpenModel | undefined };
}

/** The action may NOT run as asked. `reason` is user-facing and self-explanatory. */
export interface RoutePlanReject {
	kind: "reject";
	reason: string;
	warnings: readonly string[];
}

export type RoutePlanVerdict = RoutePlanProceed | RoutePlanReject;

/**
 * Normalise whatever the session's router resolver handed back.
 *
 * A malformed or half-built resolution falls back to the shared ROUTER_OFF value
 * because candidate-dependent planner paths below walk `candidates` directly.
 * (checkEffort tolerates a junk resolution on its own, CQ5.) Shared with threads.ts
 * so the shape check has ONE definition.
 */
export function usableResolution(value: unknown): ModelRouterResolution {
	const resolution = value as ModelRouterResolution | undefined;
	if (!resolution || typeof resolution !== "object" || resolution.on !== true) return ROUTER_OFF;
	if (!Array.isArray(resolution.candidates) || resolution.candidates.length === 0) return ROUTER_OFF;
	return resolution;
}

/** A finite number, or undefined — profile and registry fields are `null` where untraced. */
function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * An INTERNAL spec (the host model, a failover target): trimmed, and empty or
 * non-string reads as absent. These arrive from pi's registry, already canonical.
 */
function specArg(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * The dispatch's `model` ARGUMENT, byte-for-byte.
 *
 * Deliberately NOT trimmed (CQ13): with the router off this value reaches pi's own
 * resolveModel, which rejects a padded spec with a precise "it has leading or
 * trailing whitespace" error — quietly repairing it here would both change that
 * pre-existing behaviour and make the router accept a spec pi's registry does not
 * have. Only a non-string or the empty string reads as ABSENT, which is exactly how
 * the pre-router code read it (`opts.model ? … : ctx.model`).
 */
function argModel(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The candidate specs, defensively (CQ15): a malformed entry carries no `spec`, and
 * an unguarded `.map((c) => c.spec)` on it throws a TypeError from inside a guard —
 * turning a data defect into a crashed dispatch, the exact inversion this module
 * refuses everywhere else. Used for every message that names the list.
 */
function candidateSpecs(resolution: ModelRouterResolution): string[] {
	const list = Array.isArray(resolution.candidates) ? resolution.candidates : [];
	return list.map((c) => c?.spec).filter((spec): spec is string => typeof spec === "string" && spec !== "");
}

/**
 * Display form of a rejected argument value. JSON.stringify returns the VALUE
 * undefined for undefined/functions and THROWS on a cyclic or deeply nested
 * value, so both fall back to a plain description; the result is sanitized like
 * every other string that reaches a UI or a persisted episode.
 */
function shown(value: unknown): string {
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
	return sanitizeForNotify(text, 40);
}

/**
 * A level read back from a THREAD RECORD, validated against pi's vocabulary; anything
 * else (a junk string, a number, an object) reads as absent (BG21). The record's own
 * type says `ThinkingLevel`, but the value arrives from an unversioned snapshot on
 * disk, so the type is a claim about the writer, not the reader.
 */
function storedLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

/** Is this spec one of the effective candidates? */
function isListed(resolution: ModelRouterResolution, spec: string): boolean {
	return candidateSpecs(resolution).includes(spec);
}

/**
 * The base model a thread gets when it needs one: the resolver's cheapest
 * PREFERRED candidate (model-router D48). The first usable candidate spec is a
 * defensive floor for a fabricated resolution that carries candidates but no
 * `cheapest`; undefined only when NO entry carries a spec at all, which the caller
 * treats as "there is no list to enforce".
 */
function defaultBase(resolution: ModelRouterResolution): string | undefined {
	const cheapest = specArg(resolution.cheapest);
	return cheapest !== undefined && isListed(resolution, cheapest) ? cheapest : candidateSpecs(resolution)[0];
}

/** The routable candidate for a spec, undefined when the router is off or the spec is unlisted. */
function candidateFor(resolution: ModelRouterResolution, spec: string | undefined): RouterCandidate | undefined {
	if (!spec || !resolution.on) return undefined;
	return resolution.candidates.find((c) => c?.spec === spec);
}

/**
 * The model/effort verdict for ONE pair — model-router's predicate on both paths,
 * never a second implementation of the ladder rules.
 *
 * With the router ON that is the session's frozen resolution. With the router OFF
 * the same predicate is fed a SYNTHESISED one-candidate resolution built from the
 * injected profile lookup, so the ladder answer stays PER MODEL instead of
 * degenerating into a union over models. A model the lookup does not profile
 * yields an OFF resolution, which makes checkEffort inert (verdict "ok") — the
 * pre-router behaviour, where pi's own clamp decides.
 */
function checkEffortFor(input: RoutePlanInput, resolution: ModelRouterResolution, spec: string, effort: ThinkingLevel): EffortCheck {
	if (resolution.on) return checkEffort(resolution, spec, effort);
	const profiles = input.profiles;
	if (!profiles) return checkEffort(ROUTER_OFF, spec, effort);
	let profile: ReturnType<RouterProfileSource["findProfile"]>;
	try {
		profile = profiles.findProfile(spec);
	} catch {
		profile = undefined; // a throwing lookup is a missing profile, not a crash
	}
	if (!profile || typeof profile !== "object") return checkEffort(ROUTER_OFF, spec, effort);
	let ladderRaw: unknown;
	try {
		ladderRaw = profiles.ladderFor(profile);
	} catch {
		ladderRaw = undefined;
	}
	// Filtered to pi's vocabulary and de-duplicated, exactly as resolveModelRouter
	// does it: a per-id lookup table can hand back a foreign value, and an
	// unvalidated ladder would make every effort check nonsense (CQ6).
	//
	// An EMPTY result here — the lookup threw, handed back a non-array, or listed
	// only foreign levels — is "unknown", and the caller treats it as such: guard 2
	// does not fire on an empty ladder (see guardEffort's `ladderKnown`). Do not
	// "repair" that by substituting a default ladder: inventing levels a model may not
	// have is the mirror image of refusing ones it does.
	const ladder = Array.isArray(ladderRaw)
		? [...new Set(ladderRaw.filter((l): l is ThinkingLevel => THINKING_LEVELS.includes(l as ThinkingLevel)))]
		: [];
	const synthetic = {
		on: true,
		candidates: [{ spec, profile, ladder }],
		cheapest: spec,
		cheapestNonPreferred: false,
		warnings: [],
	} as unknown as ModelRouterResolution;
	return checkEffort(synthetic, spec, effort);
}

/**
 * The LOWEST level on a listed model's ladder that carries a traced capability
 * measurement — the seed for a new thread's base effort.
 *
 * `verdict === "ok"` is exactly "on the ladder, measured, and not rejected by the
 * provider", so an unmeasured level can never be chosen by default and an
 * API-rejected one can never be seeded. undefined when the model has no measured
 * level at all: absence reads as unknown and pi's own default applies — guessing a
 * level from an evidence gap is exactly what the profile data forbids.
 */
export function lowestMeasuredEffort(resolution: ModelRouterResolution, spec: string | undefined): ThinkingLevel | undefined {
	// Router OFF: checkEffort is inert and would answer "ok" for every level, so
	// there is nothing to seed from.
	if (!resolution?.on || !spec) return undefined;
	for (const level of THINKING_LEVELS) {
		if (checkEffort(resolution, spec, level).verdict === "ok") return level;
	}
	return undefined;
}

/** Whether `tokens` still fit a `window`-token model, per pi's own predicate. No predicate ⇒ no basis to refuse. */
function holdsWindow(input: RoutePlanInput, tokens: number, window: number | undefined): boolean {
	if (window === undefined || !input.wouldCompact) return true;
	try {
		return input.wouldCompact(tokens, window) !== true;
	} catch {
		return true; // a throwing predicate cannot condemn a dispatch
	}
}

/** "thread t1's" / "this thread's" — the thread may not exist yet when planning. */
function whose(thread: RouteThread | undefined): string {
	return thread ? `thread ${thread.id}'s` : "this thread's";
}

function count(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

/** One part per million ignores arithmetic noise while preserving every material catalogue difference. */
export const REGISTRY_PRICE_RELATIVE_TOLERANCE = 1e-6;

function priceDiffers(shipped: number, registry: number): boolean {
	const scale = Math.max(Math.abs(shipped), Math.abs(registry));
	return scale > 0 && Math.abs(shipped - registry) > REGISTRY_PRICE_RELATIVE_TOLERANCE * scale;
}

interface PriceDifference {
	field: "input" | "output" | "cache read" | "cache write";
	shipped: number;
	registry: number;
}

function roughDifference({ field, shipped, registry }: PriceDifference): string {
	const lower = Math.min(shipped, registry);
	const higher = Math.max(shipped, registry);
	const ratio = lower === 0 ? Number.POSITIVE_INFINITY : higher / lower;
	const magnitude = ratio >= 10 ? "at least tenfold" : ratio >= 2 ? "twofold to tenfold" : "less than twofold";
	return `Registry ${field} is ${registry > shipped ? "higher" : "lower"} by ${magnitude}`;
}

/** Build one advisory warning from fresh dispatch-time evidence, or stay silent when evidence is incomplete. */
function priceDivergenceWarning(
	input: RoutePlanInput,
	resolution: ModelRouterResolution,
	spec: string,
): string | undefined {
	try {
		const candidate = candidateFor(resolution, spec);
		const readRegistry = resolution.registryCostFor;
		const readDate = input.currentDate ?? resolution.currentDate;
		if (!candidate || typeof readRegistry !== "function" || typeof readDate !== "function") return undefined;
		const today = readDate();
		const row = coveringPriceRow(candidate.profile, today);
		const registry = readRegistry(spec);
		if (!row || !registry) return undefined;

		const differences: PriceDifference[] = [];
		if (
			isValidPrice(row.inUsdPerMTok) &&
			isValidPrice(registry.input) &&
			priceDiffers(row.inUsdPerMTok, registry.input)
		) {
			differences.push({ field: "input", shipped: row.inUsdPerMTok, registry: registry.input });
		}
		if (
			isValidPrice(row.outUsdPerMTok) &&
			isValidPrice(registry.output) &&
			priceDiffers(row.outUsdPerMTok, registry.output)
		) {
			differences.push({ field: "output", shipped: row.outUsdPerMTok, registry: registry.output });
		}
		if (
			isValidPrice(row.cachedInUsdPerMTok) &&
			isValidPrice(registry.cacheRead) &&
			priceDiffers(row.cachedInUsdPerMTok, registry.cacheRead)
		) {
			differences.push({ field: "cache read", shipped: row.cachedInUsdPerMTok, registry: registry.cacheRead });
		}
		const shippedCacheWrite = row.cacheWriteUsdPerMTok ?? row.cacheWrite5mUsdPerMTok;
		if (
			isValidPrice(shippedCacheWrite) &&
			isValidPrice(registry.cacheWrite) &&
			priceDiffers(shippedCacheWrite, registry.cacheWrite)
		) {
			differences.push({ field: "cache write", shipped: shippedCacheWrite, registry: registry.cacheWrite });
		}
		if (differences.length === 0) return undefined;
		const label = sanitizeForNotify(spec, 80);
		const exactWarning =
			`slate: model router: exact live registry pricing for ${label} differs from the shipped profile row for ${today}. ` +
			`Profile asOf ${routerProfileText(String(candidate.profile.asOf ?? "unknown"), 20)}. ` +
			`${differences.map((difference) => `${difference.field.replace(/^./, (initial) => initial.toUpperCase())}: shipped $${difference.shipped} and registry $${difference.registry} per million tokens.`).join(" ")} ` +
			"Candidate ordering still uses shipped prices.";
		try {
			resolution.warnOnce?.(
				"registry-price-divergence",
				{ spec, today, differences },
				exactWarning,
				"model-data-note",
			);
		} catch {
			/* a router warning must never block dispatch */
		}
		return sanitizeRouterWarning(
			`slate: model router: live registry pricing for ${label} differs materially from the shipped profile row for ${today}. ` +
				`${differences.map(roughDifference).join(". ")}. Candidate ordering still uses shipped prices. Dispatching anyway. ` +
				"Exact rates are omitted from this model-visible warning.",
		);
	} catch {
		return undefined;
	}
}

/**
 * GUARD 7 — the failover carve-out. Guards 1–4 do not run: a model that just
 * failed is worse than an unlisted one that works, so the router may never veto a
 * failover. What remains is the one rule failover itself must obey (never the
 * model that just failed) and a NON-SUBSTITUTING window check that warns and
 * proceeds — substituting here would be the router vetoing failover by another
 * name. Gated on the router being ON, so a router-OFF failover gets no window
 * warning at all: that is the pre-router behaviour of THIS branch, not of the
 * dispatch path, where a router-OFF action's own `model` still moves a session.
 */
function planFailoverSwitch(input: RoutePlanInput, resolution: ModelRouterResolution, target: string | undefined): RoutePlanVerdict {
	const warnings: string[] = [];
	if (target === undefined) {
		return { kind: "reject", reason: "slate: no failover target was resolved.", warnings };
	}
	if (input.failoverFrom !== undefined && target === input.failoverFrom) {
		return {
			kind: "reject",
			reason:
				`slate: the failover mapping for ${sanitizeForNotify(target, 80)} resolves to the model that just failed — ` +
				"not switching.",
			warnings,
		};
	}
	const tokens = finite(input.contextTokens);
	const window = finite(input.contextWindow);
	if (resolution.on && tokens !== undefined && window !== undefined && !holdsWindow(input, tokens, window)) {
		warnings.push(
			`slate: the failover target ${target} cannot hold ${whose(input.thread)} context ` +
				`(~${count(tokens)} tokens vs a ${count(window)}-token window) — ` +
				"failing over anyway; pi will compact. Failover is never vetoed on window size.",
		);
	}
	const priceWarning = priceDivergenceWarning(input, resolution, target);
	if (priceWarning) warnings.push(priceWarning);
	return { kind: "proceed", model: target, effortUnmeasured: false, warnings };
}

/**
 * Plan ONE dispatch: resolve the (model, effort) pair and run the guards.
 *
 * Called TWICE per dispatch by threads.ts — early, before any state mutation, and
 * again at apply time once the thread's context size is knowable. The two calls
 * differ ONLY in their inputs (`contextTokens`) and in what the caller does with
 * the result: the early caller uses the resolved model and discards the warnings,
 * so it can neither double-report nor consume guard 6's once-per-pair notice.
 */
export function planRoute(input: RoutePlanInput): RoutePlanVerdict {
	const resolution = usableResolution(input.resolution);
	const thread = input.thread;
	const explicit = argModel(input.requestedModel);
	const warnings: string[] = [];
	const warn = (message: string) => {
		warnings.push(message);
	};

	if (input.failoverSwitch === true) return planFailoverSwitch(input, resolution, explicit);
	// GUARD 0 — pi's effort vocabulary. The argument is RAW: it comes from a tool
	// call, so its TYPE is not guaranteed either.
	let requestedEffort: ThinkingLevel | undefined;
	if (input.requestedEffort !== undefined && input.requestedEffort !== null) {
		// A NON-STRING is a rejection, not an absent argument. Reading it as absent
		// would silently fall through to the thread's base effort, i.e. quietly run the
		// action at a DIFFERENT level than the caller asked for — the same class of
		// silent substitution every other guard here exists to prevent. (undefined and
		// null stay "absent": that is how an omitted optional argument arrives.)
		if (typeof input.requestedEffort !== "string") {
			return {
				kind: "reject",
				reason:
					`slate: effort must be one of pi's thinking levels as a string (${THINKING_LEVELS.join(", ")}) — ` +
					`got ${typeof input.requestedEffort} ${shown(input.requestedEffort)}.`,
				warnings,
			};
		}
		const raw = input.requestedEffort.trim();
		// An empty (or all-whitespace) string IS an omitted argument: that is how a
		// cleared optional field arrives, and it names no level to run at.
		if (raw !== "") {
			if (!THINKING_LEVELS.includes(raw as ThinkingLevel)) {
				return {
					kind: "reject",
					reason:
						`slate: effort "${sanitizeForNotify(String(input.requestedEffort), 40)}" is not one of pi's thinking levels ` +
						`(${THINKING_LEVELS.join(", ")}).`,
					warnings,
				};
			}
			requestedEffort = raw as ThinkingLevel;
		}
	}

	// ---- the THREAD's defaults (never an action's route)
	let baseModel: string | undefined;
	let baseEffort: ThinkingLevel | undefined;
	let baseReseeded = false;
	let baseReseededFrom: string | undefined;
	/** Router OFF only: the thread's pre-router `model` pin, which OPENS a session and never switches one. */
	let pin: string | undefined;
	if (!resolution.on) {
		// ROUTER OFF — this planner seeds no base and applies no candidate-dependent
		// guard. The pre-router code passed ONE thing to the worker opener — the thread's
		// `model` pin, undefined for most threads — and never used that pin to move a
		// live session. This branch preserves that open-only planning rule:
		//
		//  · nothing is SEEDED and nothing is PERSISTED: `baseModel`/`baseEffort` stay
		//    undefined, so the caller writes no base onto the record. An earlier version
		//    seeded the ORCHESTRATOR's tracked model here and persisted it, which three
		//    ways made things worse than before the feature existed: a reused session was
		//    switched back off its failover model, a thread whose tracked model lost its
		//    credentials could never dispatch again (the switch throws, and the abort is
		//    permanent), and a restarted thread stopped following the host's model.
		//  · an existing thread's pin is `openOnly`: the model a NEW session opens with,
		//    never a reason to move a live one. (A new thread's pin IS this dispatch's
		//    explicit argument, so it needs no separate treatment.)
		//
		// An EXPLICIT `model` argument is the one addition, and it is per-action: it does
		// switch the live session, because the caller asked for this action to run there.
		pin = argModel(thread?.model); // same BG26 reader as the base above
	} else if (thread) {
		// ?? thread.model: a thread created before per-action routing existed (the
		// snapshot is unversioned, so absence means "unknown", and the pre-router pin
		// is the best available answer).
		// Read through `argModel`, not raw (BG26): these fields come from the same
		// unversioned snapshot as the stored level, and a wrong-typed one used to reach
		// the warning builder below as `s.replace is not a function` — an exception out of
		// a guard, from a module whose whole discipline is that unreadable data degrades.
		// state.ts validates them on adoption too; this is the reader's half, and it is
		// what makes the value safe however it got into the record. Byte-for-byte (RG1):
		// only a non-string or the empty string reads as absent.
		baseModel = argModel(thread.baseModel) ?? argModel(thread.model);
		// A STORED level is disk JSON, not a typed value: the snapshot is unversioned and
		// hand-editable, and TypeScript's `ThinkingLevel` on the record is a claim about
		// what slate wrote, not a guarantee about what it reads back. So it is re-validated
		// against pi's vocabulary HERE, at the boundary it crosses (BG21) — exactly as the
		// model fields are re-validated as specs. Anything else reads as ABSENT, which the
		// branches below answer by deriving this model's own level.
		//
		// The downstream guards are NOT a substitute for this: guard 2 refuses an off-ladder
		// level only when the ladder is KNOWN, and a ladder that could not be read is inert
		// by design (the read-failure rule above), so a junk level on an unreadable ladder
		// would otherwise sail through to pi and be silently CLAMPED — the orchestrator then
		// believing the action ran at a level that never existed.
		baseEffort = storedLevel(thread.baseEffort);
		// SEED OR RE-SEED a base that is not a listed candidate — THE ONE RULE (module
		// header). Two shapes reach this, and they are the SAME hole:
		//
		//  · an OFF-LIST base is a dead end. Every dispatch that omits `model` resolves
		//    to it and guard 1 then rejects the one call shape that has nothing to
		//    correct — the thread becomes undispatchable, and the rejection's own
		//    remediation clause ends up naming the model it just refused.
		//  · NO base at all is the same escape, quieter and therefore worse: the action
		//    runs on whatever the worker session opens on (the host's model), outside the
		//    closed list, so the cost bound the list expresses is silently not applied.
		//    Nothing rejects, nothing warns, and the router looks like it is working.
		//
		// Both are ordinary states, not corruption: a thread created before
		// `router.models` was configured has the orchestrator's model, a pre-router pin,
		// or nothing at all; and a config change can drop a model an existing thread was
		// based on. So the base is SEEDED, not refused, with exactly what a new thread
		// would get (D48's cheapest preferred candidate) — and the effort is derived with
		// it, because ladders are per model and any stored level may not exist on the new
		// one. The caller persists it (`baseReseeded`), so this costs one warning per
		// thread rather than one per dispatch. An EXPLICIT off-list model is untouched:
		// it still gets guard 1's rejection below, now with an actionable remediation
		// clause.
		if (resolution.on && (baseModel === undefined || !isListed(resolution, baseModel))) {
			const seeded = defaultBase(resolution);
			if (seeded !== undefined) {
				baseReseeded = true;
				baseReseededFrom = baseModel; // undefined when the thread had no base to replace
				baseModel = seeded;
				baseEffort = lowestMeasuredEffort(resolution, seeded);
				const list = candidateSpecs(resolution).join(", ");
				const level = baseEffort ? ` @${baseEffort}` : "";
				warn(
					baseReseededFrom === undefined
						? `slate: thread ${thread.id} has no base model — it predates the router's model list ` +
								`(${list}), so actions that omit "model" would have run outside it. Seeding the thread's ` +
								`base to ${seeded}${level}; pass "model" explicitly to route an action elsewhere.`
						: `slate: thread ${thread.id}'s base model ${sanitizeForNotify(baseReseededFrom, 80)} is not in the ` +
								`router's effective model list (${list}) — it was set before this list applied, or the list ` +
								`changed since. Re-seeding the thread's base to ${seeded}${level} so actions that omit "model" ` +
								'keep working; pass "model" explicitly to route this action elsewhere.',
				);
			} else {
				// A resolution that is ON but carries no usable spec (only malformed
				// candidates) offers nothing to seed FROM — so the base is dropped instead of
				// kept, and the dispatch falls through to the host model. Enforcing a list
				// that could not be read is the read-failure mistake again, and stranding the
				// thread on an unroutable base would be the worse half of it.
				baseModel = undefined;
				// ...and with no base there is no base LEVEL either: a level stored for a model
				// that is no longer the base must not be applied to whatever runs instead
				// (THE ONE RULE, effort half).
				baseEffort = undefined;
			}
		}
	} else {
		// model-router D48: the cheapest PREFERRED candidate, so the base is always a
		// listed model and a later dispatch that omits `model` can never be rejected
		// by guard 1. An explicit model on THIS dispatch routes this action only — it
		// is deliberately not the base.
		baseModel = defaultBase(resolution);
		baseEffort = lowestMeasuredEffort(resolution, baseModel);
	}

	// ---- the RESOLVED pair for THIS action
	// With the router OFF and no argument, the resolved model is the thread's pin —
	// open-only, per the branch above. `pin` is empty on every router-ON path, where
	// the base IS the fall-through and a live session is switched to it.
	let model = explicit ?? baseModel ?? pin;
	const openOnly = model !== undefined && model === pin && explicit === undefined;

	// GUARD 1 — list membership. Router ON only; with the router off this guard does
	// not inspect or reject the raw `model` argument. Validated on the RESOLVED model,
	// but only an EXPLICIT one can trip it: a new thread's base is a
	// listed candidate by construction (D48), and an existing thread's was re-seeded
	// above if it was not — which is what keeps a dispatch that omitted `model` from
	// ever landing here.
	if (resolution.on && model !== undefined && !isListed(resolution, model)) {
		const list = candidateSpecs(resolution).join(", ");
		return {
			kind: "reject",
			reason:
				`slate: model "${sanitizeForNotify(model, 80)}" is not routable — the router's effective model list is: ${list}. ` +
				`Pass one of those as "model"${baseModel ? `, or omit it to use ${thread ? `thread ${thread.id}'s` : "the new thread's"} base model (${baseModel})` : ""}.`,
			warnings,
		};
	}

	// GUARD 5 — CONTEXT WINDOW, and it runs BEFORE the effort guards on purpose: the
	// model the planner routes this action to must be settled before any level is judged
	// against it, or the judgement is about a model that will be substituted away. Never a
	// hard block, and router ON only: with the router off there is no candidate list
	// to fall back to, and the pre-router behaviour is no check at all.
	let substitutedFrom: string | undefined;
	const tokens = finite(input.contextTokens);
	if (resolution.on && model !== undefined && tokens !== undefined) {
		const windowOf = (candidate: RouterCandidate | undefined) => finite(candidate?.contextWindow);
		const holds = (candidate: RouterCandidate | undefined): boolean => holdsWindow(input, tokens, windowOf(candidate));
		const current = candidateFor(resolution, model);
		if (!holds(current)) {
			const reserve = finite(input.reserveTokens) ?? 0;
			const prefix =
				`slate: ${whose(thread)} context (~${count(tokens)} tokens) does not fit ` +
				`${sanitizeForNotify(model, 80)}'s context window minus pi's ${count(reserve)}-token ` +
				"compaction reserve";
			const widest = resolution.candidates.reduce<RouterCandidate | undefined>(
				(best, c) =>
					typeof c?.spec !== "string" || windowOf(c) === undefined
						? best
						: best === undefined || (c.contextWindow ?? 0) > (best.contextWindow ?? 0)
							? c
							: best,
				undefined,
			);
			// STRICTLY wider, or not at all (BG19): moving the action to a candidate no
			// wider than the one that already does not fit buys nothing — it would compact
			// just the same, on a different model, for a different price. An UNKNOWN current
			// window cannot be compared, so it is not a basis for moving either.
			const currentWindow = windowOf(current);
			const widestWindow = windowOf(widest);
			const strictlyWider =
				widest !== undefined &&
				widest.spec !== model &&
				widestWindow !== undefined &&
				(currentWindow === undefined || widestWindow > currentWindow);
			if (strictlyWider && widest) {
				warn(
					holds(widest)
						? `${prefix} — routing this action to the widest listed model instead: ${widest.spec} ` +
								`(${count(widestWindow ?? 0)} tokens).`
						: `${prefix}, and NO listed model can hold it — routing to the widest one anyway ` +
								`(${widest.spec}, ${count(widestWindow ?? 0)} tokens); pi will compact this thread.`,
				);
				substitutedFrom = model;
				model = widest.spec;
			} else {
				warn(`${prefix}, and no listed model is wider — dispatching anyway; pi will compact this thread.`);
			}
		}
	}

	// ---- the EFFORT, for the model the planner routes to (THE ONE RULE, effort half)
	//
	// The routed model is final inside planRoute (guard 1 accepted it, guard 5 may have
	// moved it), so the level can be settled against THAT model and nothing else:
	//
	//  · an EXPLICIT `effort` is judged against it, hard — the caller named a level and
	//    is entitled to be told it does not exist there rather than silently clamped;
	//  · a level INHERITED from the thread's base applies only while the base model is
	//    the routed model. The moment they differ — an explicit `model`, or a window
	//    substitution — the inherited level is DROPPED and re-derived for the routed
	//    model (its lowest MEASURED level, or nothing when it has none). Carrying it over
	//    was BG14: an action explicitly routed to another model inherited a budget
	//    derived for the base, and was warned about — or, with allowUnmeasuredEffort
	//    false, REJECTED — for a level nobody had asked for.
	//
	// A derived level is measured by construction, so it can only pass the guards; only
	// an explicit one can be rejected by them.
	const judgedModel = model ?? specArg(input.hostModel);
	let effort: ThinkingLevel | undefined;
	let effortExplicit = false;
	if (requestedEffort !== undefined) {
		effort = requestedEffort;
		effortExplicit = true;
	} else if (baseEffort !== undefined && judgedModel !== undefined && judgedModel === baseModel) {
		// The stored level, but only while it is STILL a level this model is measured at.
		//
		// A base effort is a cached derivation, and the table it was derived from ships
		// with slate: a profile refresh can move a level onto an evidence gap, off the
		// ladder, or onto the provider's hard-rejection list between the dispatch that
		// stored it and the one that replays it. Replaying it unchecked is BG14's failure
		// mode surviving in the same-model branch — a level NOBODY REQUESTED earning a
		// warning, or (with allowUnmeasuredEffort false, or off-ladder, or API-rejected) a
		// hard rejection of a dispatch that named no effort at all. So the stored pair is
		// re-checked against TODAY's table and, if it no longer reads `ok`, this model's
		// level is derived afresh exactly as it was the first time.
		//
		// SILENTLY, and that is the point: the orchestrator did not ask for this level, so
		// a stale cache is slate's problem to correct, not news to report. An EXPLICIT
		// effort still warns and still rejects — that one the caller did ask for.
		//
		// ONE model for both halves. `judgedModel === baseModel` is the branch's own
		// condition, so binding it once here makes that equality a CHECKED precondition
		// rather than something two lines happen to agree about: judging against one model
		// while deriving from another would answer a question nobody asked, and the next
		// edit to either line would not notice.
		const storedFor = judgedModel;
		const stored = checkEffortFor(input, resolution, storedFor, baseEffort);
		effort = stored.verdict === "ok" ? baseEffort : lowestMeasuredEffort(resolution, storedFor);
	} else if (resolution.on && model !== undefined) {
		// Either the model differs from the one the stored level was derived for, or there
		// is no stored level: derive this model's own lowest measured level. Deriving in
		// the second case too is what keeps the router's dispatches off the user's GLOBAL
		// thinking-level default — the same reason a new thread's base effort is seeded
		// rather than inherited (D48). undefined when the model has no measured level at
		// all, which the caller answers with the session's own opening level.
		effort = lowestMeasuredEffort(resolution, model);
	}

	let effortUnmeasured = false;
	let rejection: string | undefined;

	/**
	 * GUARDS 4, 2 and 3 on the settled (model, effort) pair. `soft` — used when the
	 * pair only became invalid because guard 5 MOVED the model — drops the level with a
	 * warning instead of rejecting, because a context size must never hard-block a
	 * dispatch. It is reachable only for an EXPLICIT level: an inherited one is
	 * re-derived for the substituted model above, and a derived one always passes.
	 */
	const guardEffort = (spec: string | undefined, soft: boolean): void => {
		if (effort === undefined || spec === undefined || rejection !== undefined) return;
		const level = effort;
		const check = checkEffortFor(input, resolution, spec, level);
		// Is there a LADDER to judge against at all? An empty one is not "this model
		// offers no levels" — it is every way the data can be unavailable: a profile
		// lookup that declined or threw, a ladder lookup that threw or returned a
		// non-array, a ladder whose entries are all outside pi's vocabulary, a malformed
		// candidate, or a spec the list does not carry. Guard 2 must not fire on any of
		// them (module header: a failure to READ evidence is not evidence of a problem);
		// previously it did, so one broken data source turned every explicit effort
		// level into a hard dispatch rejection.
		const ladderKnown = Array.isArray(check.ladder) && check.ladder.length > 0;
		const ladder = ladderKnown ? check.ladder.join(", ") : "(none recorded)";
		const reject = (message: string) => {
			if (!soft) {
				rejection = message;
				return;
			}
			effort = undefined;
			effortUnmeasured = false;
			warn(`${message} Dropping the effort level for this action; pi's own default applies.`);
		};
		// GUARD 4 — API-rejected level: a guaranteed provider failure, not an evidence
		// gap, so it is refused outright and is NOT covered by allowUnmeasuredEffort.
		// Checked before the ladder because such a level IS on pi's ladder for the
		// model (model-profiles § apiRejectedLevels).
		if (check.apiRejected) {
			reject(
				`slate: effort "${level}" is rejected outright by the provider for ${sanitizeForNotify(spec, 80)} — ` +
					`dispatching it would be a guaranteed API failure, not an evidence gap. That model's ladder: ${ladder}.`,
			);
			return;
		}
		// GUARD 2 — ladder validity, PER MODEL. pi would silently CLAMP an unsupported
		// level, so without this the orchestrator would believe it ran an action at a
		// level the model never offered. Fires only on a KNOWN ladder — see above.
		if (ladderKnown && check.verdict === "off-ladder") {
			reject(`slate: effort "${level}" is not on ${sanitizeForNotify(spec, 80)}'s effort ladder (${ladder}).`);
			return;
		}
		// GUARD 3 — evidence gap: ADVISORY by default (an unmeasured level is
		// dispatchable, it is just not a traced capability), and refused only when the
		// project set router.allowUnmeasuredEffort to false. Never chosen by default: a
		// derived effort is always a measured level (lowestMeasuredEffort).
		if (check.verdict === "evidence-gap") {
			if (input.allowUnmeasuredEffort === false) {
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
		// Everything else PASSES, silently:
		//  · "ok" — a measured level on a known ladder, the normal case;
		//  · any verdict reached with NO ladder data (see `ladderKnown` above). The level
		//    goes to pi, which clamps it. It is deliberately NOT reported as an evidence
		//    gap either: "this level is on the ladder but unmeasured" is itself a claim
		//    about a ladder nobody could read, and the router does not invent evidence in
		//    either direction. The one fact that still bites here is a provider's hard
		//    rejection, which guard 4 above already applied.
		effortUnmeasured = false;
	};

	// SOFT only when guard 5 moved the model AND the level came from the caller: that
	// is the one combination where a rejection would be caused by the context size.
	guardEffort(judgedModel, effortExplicit && substitutedFrom !== undefined);
	if (rejection !== undefined) return { kind: "reject", reason: rejection, warnings };

	const finalCandidate = candidateFor(resolution, model);
	if (finalCandidate) {
		const priceWarning = priceDivergenceWarning(input, resolution, finalCandidate.spec);
		if (priceWarning) warn(priceWarning);
	}

	// GUARD 6 — LONG-CONTEXT BILLING. A cost cliff, never a capacity limit
	// (model-profiles §W): above the threshold the price multipliers apply. Emitted
	// at most once per thread and model, on the FINAL model — the memory is the
	// caller's (warnedLongContext in, longContextWarned out) so this stays pure.
	let longContextWarned: string | undefined;
	if (finalCandidate && tokens !== undefined && thread) {
		const threshold = finite(finalCandidate.profile?.longContextThreshold);
		// Array.isArray, not `?? []`: this input is fabricated by checks and assembled
		// by a caller, and a non-array would throw on .includes inside a guard.
		const already = Array.isArray(input.warnedLongContext) ? input.warnedLongContext : [];
		if (threshold !== undefined && tokens >= threshold && !already.includes(finalCandidate.spec)) {
			longContextWarned = finalCandidate.spec;
			const multipliers = finalCandidate.profile?.longContextMultipliers;
			const inMult = finite(multipliers?.in);
			const outMult = finite(multipliers?.out);
			const rates =
				inMult !== undefined || outMult !== undefined
					? `input bills ×${inMult ?? "?"} and output ×${outMult ?? "?"}`
					: "the provider's long-context multipliers apply (slate's profile records no figure for them)";
			warn(
				`slate: ${thread.id}'s context (~${count(tokens)} tokens) is above ` +
					`${sanitizeForNotify(finalCandidate.spec, 80)}'s long-context billing threshold ` +
					`(${count(threshold)} tokens) — above it ${rates}. A cost event, not a capacity limit.`,
			);
		}
	}

	return {
		kind: "proceed",
		model,
		effort,
		effortUnmeasured,
		...(effort !== undefined && judgedModel !== undefined ? { effortJudgedFor: judgedModel } : {}),
		...(openOnly ? { openOnly: true as const } : {}),
		baseModel,
		baseEffort,
		...(baseReseeded ? { baseReseeded: true as const } : {}),
		baseReseededFrom,
		substitutedFrom,
		longContextWarned,
		warnings,
	};
}
