/**
 * Pure model and effort planning for one worker action.
 *
 * The planner enforces the configured model list and effort capability rules.
 * Context-size substitution and long-context billing notices are not part of
 * action routing.
 */

import type { ThinkingLevel } from "./model-profiles.ts";
import {
	checkEffort,
	ROUTER_OFF,
	type EffortCheck,
	type ModelRouterResolution,
	type RouterProfileSource,
} from "./model-router.ts";
import { sanitizeForNotify } from "./notify.ts";
import { THINKING_LEVELS as STATE_THINKING_LEVELS } from "./state.ts";

/** Pi's thinking-level vocabulary, in display order for rejection messages. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = STATE_THINKING_LEVELS;

/** Thread identity retained for planner call compatibility. */
export interface RouteThread {
	id: string;
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
	/**
	 * Profile + ladder lookup, consulted ONLY when the router is off (a candidate
	 * already carries both). Absent ⇒ no ladder data ⇒ no basis to refuse an effort
	 * level, which is the pre-router behaviour: pi clamps it.
	 */
	profiles?: RouterProfileSource;
	/** Require the public dispatch's explicit model and effort arguments. */
	requireExplicit?: boolean;
	/** true = this call is the in-dispatch failover switch (guard 7). */
	failoverSwitch?: boolean;
	/** In failover mode: the model that just failed, which the mapping may never resolve to. */
	failoverFrom?: string;
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
	const verdict = planRoute({ ...input, requestedModel: undefined, requestedEffort: undefined, requireExplicit: false });
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
	if (!resolution || typeof resolution !== "object") return ROUTER_OFF;
	if (typeof resolution.fault === "string" && resolution.fault !== "") return resolution;
	if (resolution.on !== true) return ROUTER_OFF;
	if (!Array.isArray(resolution.candidates) || resolution.candidates.length === 0) return ROUTER_OFF;
	return resolution;
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
 * The model/effort verdict for ONE pair — model-router's predicate on both paths,
 * never a second implementation of the ladder rules.
 *
 * A listed model uses the session's frozen resolution. An off-list failover target,
 * or any model while the router is off, uses a SYNTHESISED one-candidate resolution
 * built from the injected profile lookup. The ladder answer therefore stays PER
 * MODEL instead of degenerating into a union over models. A model the lookup does
 * not profile yields an OFF resolution, which makes checkEffort inert (verdict
 * "ok") — the pre-router behaviour, where pi's own clamp decides.
 */
function checkEffortFor(input: RoutePlanInput, resolution: ModelRouterResolution, spec: string, effort: ThinkingLevel): EffortCheck {
	if (resolution.on && isListed(resolution, spec)) return checkEffort(resolution, spec, effort);
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
		warnings: [],
	} as unknown as ModelRouterResolution;
	return checkEffort(synthetic, spec, effort);
}

/**
 * GUARD 7 — the failover carve-out. Guards 1–4 do not run: a model that just
 * failed is worse than an unlisted one that works, so the router may never veto a
 * failover. The failover target must differ from the model that failed.
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
	const requestedEffort = typeof input.requestedEffort === "string" && THINKING_LEVELS.includes(input.requestedEffort as ThinkingLevel)
		? input.requestedEffort as ThinkingLevel
		: undefined;
	if (requestedEffort !== undefined && checkEffortFor(input, resolution, target, requestedEffort).apiRejected) {
		return {
			kind: "reject",
			reason: `slate: effort "${requestedEffort}" is rejected outright by the provider for failover model ${sanitizeForNotify(target, 80)}.`,
			warnings,
		};
	}
	return { kind: "proceed", model: target, effort: requestedEffort, effortUnmeasured: false, warnings };
}

/**
 * Plan ONE dispatch: resolve the (model, effort) pair and run the guards.
 *
 * Called twice per dispatch by threads.ts. The early pass rejects invalid inputs
 * before thread creation. The apply-time pass catches registry or credential
 * changes before billed work.
 */
export function planRoute(input: RoutePlanInput): RoutePlanVerdict {
	const rawResolution = input.resolution;
	const resolution = usableResolution(rawResolution);
	const warnings: string[] = [];
	if (typeof rawResolution?.fault === "string" && rawResolution.fault !== "") {
		return { kind: "reject", reason: rawResolution.fault, warnings };
	}
	if (input.requireExplicit === true && (typeof input.requestedModel !== "string" || input.requestedModel.trim() === "")) {
		return { kind: "reject", reason: 'slate: every dispatch requires a non-empty "model" provider/id string.', warnings };
	}
	if (input.requireExplicit === true && (typeof input.requestedEffort !== "string" || input.requestedEffort.trim() === "")) {
		return { kind: "reject", reason: `slate: every dispatch requires "effort" (${THINKING_LEVELS.join(", ")}).`, warnings };
	}
	const model = argModel(input.requestedModel);
	if (input.failoverSwitch === true) return planFailoverSwitch(input, resolution, model);

	let effort: ThinkingLevel | undefined;
	if (input.requestedEffort !== undefined && input.requestedEffort !== null) {
		if (typeof input.requestedEffort !== "string") {
			return { kind: "reject", reason: `slate: effort must be one of pi's thinking levels as a string (${THINKING_LEVELS.join(", ")}) — got ${typeof input.requestedEffort} ${shown(input.requestedEffort)}.`, warnings };
		}
		const raw = input.requestedEffort.trim();
		if (raw !== "") {
			if (!THINKING_LEVELS.includes(raw as ThinkingLevel)) {
				return { kind: "reject", reason: `slate: effort "${sanitizeForNotify(input.requestedEffort, 40)}" is not one of pi's thinking levels (${THINKING_LEVELS.join(", ")}).`, warnings };
			}
			effort = raw as ThinkingLevel;
		}
	}
	if (resolution.on && model !== undefined && !isListed(resolution, model)) {
		return { kind: "reject", reason: `slate: model "${sanitizeForNotify(model, 80)}" is not routable — the router's effective model list is: ${candidateSpecs(resolution).join(", ")}. Pass one of those values as the required "model" argument.`, warnings };
	}
	const judgedModel = model ?? specArg(input.hostModel);
	let effortUnmeasured = false;
	if (effort !== undefined && judgedModel !== undefined) {
		const check = checkEffortFor(input, resolution, judgedModel, effort);
		const ladderKnown = Array.isArray(check.ladder) && check.ladder.length > 0;
		const ladder = ladderKnown ? check.ladder.join(", ") : "(none recorded)";
		if (check.apiRejected) return { kind: "reject", reason: `slate: effort "${effort}" is rejected outright by the provider for ${sanitizeForNotify(judgedModel, 80)} — dispatching it would be a guaranteed API failure, not an evidence gap. That model's ladder: ${ladder}.`, warnings };
		if (ladderKnown && check.verdict === "off-ladder") return { kind: "reject", reason: `slate: effort "${effort}" is not on ${sanitizeForNotify(judgedModel, 80)}'s effort ladder (${ladder}).`, warnings };
		if (check.verdict === "evidence-gap") {
			if (input.allowUnmeasuredEffort === false) return { kind: "reject", reason: `slate: effort "${effort}" on ${sanitizeForNotify(judgedModel, 80)} has no capability measurement in slate's model profiles, and router.allowUnmeasuredEffort is false. That model's ladder: ${ladder}.`, warnings };
			effortUnmeasured = true;
			warnings.push(`slate: effort "${effort}" on ${sanitizeForNotify(judgedModel, 80)} has NO capability measurement in slate's model profiles${check.listedGap ? "" : " (and the profile does not even list it as a gap)"} — dispatching anyway, but treat the result as unevidenced for this level.`);
		}
	}
	return {
		kind: "proceed",
		...(model !== undefined ? { model } : {}),
		...(effort !== undefined ? { effort } : {}),
		effortUnmeasured,
		...(effort !== undefined && judgedModel !== undefined ? { effortJudgedFor: judgedModel } : {}),
		warnings,
	};
}
