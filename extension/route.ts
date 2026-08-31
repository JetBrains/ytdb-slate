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
	/**
	 * Profile + ladder lookup, consulted ONLY when the router is off (a candidate
	 * already carries both). Absent ⇒ no ladder data ⇒ no basis to refuse an effort
	 * level, which is the pre-router behaviour: pi clamps it.
	 */
	profiles?: RouterProfileSource;
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

/** Return the lowest measured effort for a listed model. */
export function lowestMeasuredEffort(resolution: ModelRouterResolution, spec: string | undefined): ThinkingLevel | undefined {
	if (!resolution?.on || !spec) return undefined;
	for (const level of THINKING_LEVELS) {
		if (checkEffort(resolution, spec, level).verdict === "ok") return level;
	}
	return undefined;
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
	const priceWarning = priceDivergenceWarning(input, resolution, target);
	if (priceWarning) warnings.push(priceWarning);
	return { kind: "proceed", model: target, effortUnmeasured: false, warnings };
}

/**
 * Plan ONE dispatch: resolve the (model, effort) pair and run the guards.
 *
 * Called twice per dispatch by threads.ts. The early pass rejects invalid inputs
 * before thread creation. The apply-time pass catches registry or credential
 * changes before billed work.
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


	// ---- the EFFORT, for the model the planner routes to (THE ONE RULE, effort half)
	//
	// The routed model is final after list validation. Settle effort against that model:
	//
	//  · an EXPLICIT `effort` is judged against it, hard — the caller named a level and
	//    is entitled to be told it does not exist there rather than silently clamped;
	//  · a level INHERITED from the thread's base applies only while the base model is
	//    the routed model. An explicit different model receives its own derived level.
	//    Carrying the old level over
	//    was BG14: an action explicitly routed to another model inherited a budget
	//    derived for the base, and was warned about — or, with allowUnmeasuredEffort
	//    false, REJECTED — for a level nobody had asked for.
	//
	// A derived level is measured by construction, so it can only pass the guards; only
	// an explicit one can be rejected by them.
	const judgedModel = model ?? specArg(input.hostModel);
	let effort: ThinkingLevel | undefined;
	if (requestedEffort !== undefined) {
		effort = requestedEffort;
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

	/** Apply provider rejection, ladder validity, and evidence-gap policy. */
	const guardEffort = (spec: string | undefined): void => {
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
			rejection = message;
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

	guardEffort(judgedModel);
	if (rejection !== undefined) return { kind: "reject", reason: rejection, warnings };

	const finalCandidate = candidateFor(resolution, model);
	if (finalCandidate) {
		const priceWarning = priceDivergenceWarning(input, resolution, finalCandidate.spec);
		if (priceWarning) warn(priceWarning);
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
		warnings,
	};
}
