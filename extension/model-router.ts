/**
 * Resolve the configured closed model list and the effort evidence for each
 * surviving candidate.
 *
 * Resolution validates model specifications, profile presence, exact pi registry
 * entries, configured authentication, aliases, effort ladders, context-window
 * cross-checks, and failover coverage. Survivors keep configured order. Tier and
 * registry rates never rank, filter, or select a candidate. Registry input and
 * output base rates are captured independently. Invalid or absent components stay
 * undefined so doctrine renders `unknown`, while a valid zero remains zero.
 *
 * Resolution is pure and injected for checks. The session wrapper memoizes its
 * first result. Configuration faults stay visible. Model-data notes follow the
 * existing display option. The dispatch planner owns membership and effort guards.
 */

import {
	findProfile as shippedFindProfile,
	ladderFor as shippedLadderFor,
	type ModelProfile,
	type ModelTier,
	type ThinkingLevel,
} from "./model-profiles.ts";
import { sanitizeForNotify } from "./notify.ts";
import { describeConfusables, describeSpecDefect, isModelSpec, splitModelSpec, type RouterConfig } from "./state.ts";

/**
 * The slice of pi's ModelRegistry this module needs. `ctx.modelRegistry`
 * satisfies it structurally, so callers pass it directly and checks pass a
 * fabricated object. Auth is the SYNCHRONOUS configured-auth check on purpose:
 * resolution is synchronous and memoized, and the deeper live check
 * (getApiKeyAndHeaders) is async. A configured-but-invalid key therefore
 * survives resolution — that failure belongs to the dispatch path and its
 * failover, not to the router's list.
 */
export interface RouterRegistryCost {
	input: number | undefined;
	output: number | undefined;
	cacheRead: number | undefined;
	cacheWrite: number | undefined;
}

export interface RouterRegistryModel {
	contextWindow?: number;
	cost?: Partial<Record<keyof RouterRegistryCost, number>>;
}
export interface RouterRegistry {
	find(provider: string, id: string): RouterRegistryModel | undefined;
	hasConfiguredAuth(model: RouterRegistryModel): boolean;
}

/** The profile-table access this module needs, injected so checks can fabricate one. */
export interface RouterProfileSource {
	findProfile(spec: string): ModelProfile | undefined;
	ladderFor(profile: ModelProfile): readonly ThinkingLevel[];
}

/** The shipped table (model-profiles.ts) — the default of the injected source. */
export const SHIPPED_PROFILE_SOURCE: RouterProfileSource = {
	findProfile: shippedFindProfile,
	ladderFor: shippedLadderFor,
};

/**
 * What KIND of problem a router warning reports. There are exactly two.
 *
 * THE TEST, and it has two parts. A warning is a `configuration-fault` when
 * EITHER part holds:
 *   (a) slate ignored or dropped part of the user's configuration, or
 *   (b) the user can stop the warning by ADDING something to their own project
 *       config or pi credentials, such as a model, credential or failover entry.
 *       This differs from only removing the model named by the warning.
 * Otherwise it is a `model-data-note`.
 *
 * BOTH parts are load-bearing. The single-part "can the user stop it" question
 * does not partition the classes: removing a dropped `router.models` entry can
 * silence its warning, but removal is not the ADD remedy in part (b). Part (a)
 * catches every silently ignored or dropped config value first.
 *
 * A `model-data-note` reports the shipped research table itself, such as a figure
 * that has no traced source or two context-window sources that disagree. No project config and no credential closes that gap, so these are
 * hidden unless `router.showWarnings` is true.
 */
export type RouterWarningClass = "configuration-fault" | "model-data-note";

/**
 * The warn sink, widened to carry the class alongside the message.
 *
 * A one-parameter `(message: string) => void` stays assignable to this type, so
 * every existing caller keeps compiling AND keeps receiving every warning. Only
 * a sink that WANTS to filter reads the second argument.
 */
export type RouterWarnSink = (message: string, warningClass: RouterWarningClass) => void;

/**
 * Per-field cap for profile-sourced warning text. BOTH bounds matter:
 *  - the longest entry in the shipped table measures 177 characters today (the
 *    design text quoted 167, measured before the last profile refresh), so 180
 *    keeps every real entry whole instead of cutting it mid-word;
 *  - the hostile fixture in verification/resolver-checks.mjs asserts that no
 *    warning carries a 200-character run, so the cap must stay BELOW 200.
 * That leaves a narrow band, and 180 sits in it. The 80-character cap this
 * replaces truncated most real entries.
 */
const PROFILE_FIELD_MAX = 180;

/**
 * Cap for one WHOLE assembled warning. A profile may carry any number of
 * fields, so a per-field cap alone does not bound the message. 799 is chosen
 * against the same hostile check: sanitizeForNotify appends an ellipsis, so the
 * displayed string stays at or below the 800 characters that check allows, and
 * the longest real message stays whole.
 */
const ROUTER_MESSAGE_MAX = 799;

/** Apply the router's whole-message control stripping and length bound. */
export function sanitizeRouterWarning(message: string): string {
	return sanitizeForNotify(message, ROUTER_MESSAGE_MAX);
}

/**
 * Separator between field entries: U+00B7 MIDDLE DOT.
 *
 * A newline is a control byte, and the hostile check bans one in any warning.
 * U+00B7 was verified to survive sanitizeForNotify unchanged, and the
 * confusable annotation (describeConfusables) never sees it, because that note
 * is applied to a model SPEC and never to an assembled message.
 */
const FIELD_SEPARATOR = " · ";

/**
 * Display form of PROFILE-SOURCED text.
 *
 * The shipped table carries bracketed source tags ([G1e], [RI36], [arb]) that
 * name unpublished research artifacts. They mean nothing to a reader of a
 * warning, so they are removed here, the whitespace the removal leaves behind is
 * collapsed, and a separator left dangling at the end is trimmed.
 *
 * USE THIS ONLY FOR PROFILE TEXT. An echoed USER value must keep its brackets:
 * a user who wrote a nested array into `router.models` has to see those brackets
 * to recognise the value the warning is talking about.
 */
export function routerProfileText(text: string, max = PROFILE_FIELD_MAX): string {
	// Bound BEFORE scanning for tags. This keeps an unclosed bracket run from
	// consuming session-start time, and the cap remains below the hostile 200-char
	// fixture while clearing every real shipped entry.
	const wasTruncated = text.length > max;
	const bounded = text.slice(0, max);
	const collapsed = bounded
		// A citation can act as the subject after punctuation. Restore a neutral
		// subject before removing it: "; [G3] gives" becomes "; the source gives".
		.replace(/([;:,.])\s*\[[^\]]*\]\s+(?=[A-Za-z])/g, "$1 the source ")
		.replace(/\[[^\]]*\]/g, "") // the source tags themselves
		.replace(/\u00b7/g, " ") // profile text cannot forge the field-list separator
		.replace(/\s+/g, " ") // the hole each removal leaves
		.replace(/,\s*\)/g, ")") // "(vendor, [G3])" would otherwise read "(vendor, )"
		.replace(/\(\s*\)/g, "") // a parenthesis that held nothing but a tag
		.replace(/\s+([,;:.)])/g, "$1") // "1736 , unadjudicated" would otherwise keep the gap
		.replace(/\s+/g, " ")
		.replace(/[\s,;:—–-]+$/, "") // a separator the last removal left dangling
		.trim();
	if (!wasTruncated) return sanitizeForNotify(collapsed, max);
	// Preserve an explicit truncation mark even when slicing made the cleaned text
	// exactly max characters. Remove the sanitizer's own mark before adding one,
	// so the visible result has one mark and remains within the same cap.
	const cleaned = sanitizeForNotify(collapsed, max - 1);
	return `${cleaned.endsWith("…") ? cleaned.slice(0, -1) : cleaned}…`;
}

/** One routable model: what survived validation, plus everything a caller needs to explain it. */
export interface RouterCandidate {
	spec: string; // canonical "provider/id"
	provider: string;
	id: string;
	profile: ModelProfile;
	tier: ModelTier; // the profile's declared tier, verbatim (see tierOf for the sort key)
	registryCost: Readonly<RouterRegistryCost>;
	contextWindow: number | undefined; // REGISTRY value — never the profile's (D55)
	ladder: readonly ThinkingLevel[]; // ladderFor(profile), validated, captured so checkEffort needs no injection
	hasFailover: boolean; // present as a key in the configured modelFailover map
	tierUnsourced: boolean; // the profile's tier is NOT a sourced ordinal (cost class only) — do not render it as a ranking
	ladderAssumed: boolean; // the ladder is an assumed provider-family shape, not a traced fact
}

/** The resolution: the router's whole answer for a session. */
export interface ModelRouterResolution {
	on: boolean; // false = router off; candidates is empty, but `fault` may still block dispatch
	candidates: readonly RouterCandidate[]; // surviving configured order
	warnings: readonly string[]; // every warning emitted for this resolution, in order
	/** Dispatch-blocking all-dropped configuration fault. Kept on the off resolution. */
	fault?: string;
}

/** The off state with no warnings — the default, shared and deep-frozen (CQ22). */
export const ROUTER_OFF: ModelRouterResolution = Object.freeze({
	on: false,
	candidates: Object.freeze([]),
	warnings: Object.freeze([]),
}) as unknown as ModelRouterResolution;

/** Inputs of one resolution. Only `registry` and `models` are required. */
export interface ModelRouterInput {
	registry: RouterRegistry;
	models: readonly unknown[]; // raw router.models entries (empty = router off)
	failover?: Record<string, string>; // sanitized modelFailover map, for the coverage warning
	profiles?: RouterProfileSource; // default: the shipped table
}

/**
 * Verdict of the dispatch-side effort check (consumed by Track 02):
 *   ok           — listed model, ladder-valid level, with a traced capability
 *                  measurement at that level
 *   not-listed   — the model is not in the effective list (or was dropped)
 *   off-ladder   — the model is listed but does not offer that effort level
 *   evidence-gap — ladder-valid, but NO traced capability result at that level
 *                  (ADVISORY — an evidence gap is a marker, never a prohibition;
 *                  the caller decides)
 *
 * BG9: the verdict is derived from `capabilityMeasuredAt` ALONE, so it cannot
 * silently assume `capabilityMeasuredAt ∪ evidenceGapAt` covers the ladder. A
 * ladder level in NEITHER list is a gap by the digest's own predicate ("measured
 * iff at least one traced source reports a result at that level"), and reporting
 * it as `evidence-gap` is the conservative reading; the earlier
 * `evidenceGapAt`-driven version reported such a level as `ok` — an unfounded
 * capability claim produced by a table typo.
 */
export type EffortVerdict = "ok" | "not-listed" | "off-ladder" | "evidence-gap";

export interface EffortCheck {
	verdict: EffortVerdict;
	spec: string;
	effort: string;
	ladder: readonly ThinkingLevel[]; // [] when not-listed
	measured: boolean; // the level appears in the profile's capabilityMeasuredAt
	listedGap: boolean; // the level appears in the profile's evidenceGapAt (false = an UNLISTED gap, i.e. a table hole)
	apiRejected: boolean; // the requested control is provider-unsupported and must be rejected before pi transforms it
}

/**
 * Optional profile fields, read through one loose accessor.
 *
 * The profile table grows fields as the research is refreshed (cache prices, a
 * known-divergence figure, unsourced-tier and assumed-ladder markers, hard API
 * rejections). Reading them via this view keeps the router tolerant in both
 * directions: a field that is not there yet is simply undefined, and a field
 * that is later renamed or dropped cannot turn into a stale type reference.
 */
interface OptionalProfileFields {
	contextWindowKnownDivergence?: unknown;
	tierUnsourced?: unknown;
	ladderAssumed?: unknown;
	apiRejectedLevels?: unknown;
}
function optional(profile: ModelProfile): OptionalProfileFields {
	return profile as unknown as OptionalProfileFields;
}

/** pi's effort ladder, as a validation set for whatever the profile table hands back (CQ6). */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Defensive read of a numeric profile/registry field: a finite number, or undefined. */
function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The single validity rule for every price this router reads or compares. */
export function isValidPrice(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type RegistryCostField = "input" | "output" | "cacheRead" | "cacheWrite";

/** Read one registry cost without trusting the model or its nested properties. */
function registryCost(model: RouterRegistryModel, field: RegistryCostField): number | undefined {
	try {
		const value = model.cost?.[field];
		return isValidPrice(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function registryCosts(model: RouterRegistryModel): Readonly<RouterRegistryCost> {
	return Object.freeze({
		input: registryCost(model, "input"),
		output: registryCost(model, "output"),
		cacheRead: registryCost(model, "cacheRead"),
		cacheWrite: registryCost(model, "cacheWrite"),
	});
}

/** Defensive membership test over a profile's effort-level list (a malformed table may hold a non-array). */
function listHas(list: unknown, level: string): boolean {
	return Array.isArray(list) && list.includes(level);
}

/** A list the compiler knows has a first element, so reading `[0]` needs no assertion. */
type NonEmptyArray<T> = [T, ...T[]];

/**
 * `length > 0`, as a TYPE GUARD. The same runtime predicate as the comparison it
 * replaces at each call site — it exists only so the non-emptiness the caller has
 * ALREADY established is visible to the compiler at the `[0]` that depends on it.
 * The alternative under noUncheckedIndexedAccess would be to assert the undefined
 * away, or to grow a fallback branch for a case that cannot happen; both hide the
 * invariant instead of stating it.
 */
function isNonEmpty<T>(list: T[]): list is NonEmptyArray<T> {
	return list.length > 0;
}

/**
 * Display form of a rejected value. JSON.stringify returns `undefined` (the
 * value, not a string) for undefined and functions, and THROWS on a cyclic or
 * deeply nested value — a RangeError there would take down session_start, where
 * the sanitizer runs (BG7). Both fall back to a plain description.
 */
function quoted(value: unknown): string {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		text = undefined; // cyclic / too deeply nested to stringify
	}
	if (text === undefined) {
		try {
			text = String(value);
		} catch {
			text = `[unprintable ${typeof value}]`; // a throwing toString/Symbol.toPrimitive
		}
	}
	return sanitizeForNotify(text);
}

/**
 * Display form of a VALID spec inside a warning: sanitized and length-capped
 * like every other user string, plus a confusable note when it carries non-ASCII
 * characters (BG2). A Cyrillic homoglyph passes validation — an exotic provider
 * id may legitimately be non-ASCII — so a warning about "openai/gpt-5.6-lunа"
 * must not read as a warning about the model the user meant.
 */
function specLabel(spec: string): string {
	const note = describeConfusables(spec);
	const label = sanitizeForNotify(spec);
	return note === undefined ? label : `${label} (${note})`;
}

/** Dedup key for a per-value condition: type-tagged, so 7 and "7" cannot collide (BG5). */
function conditionKey(condition: string, value: unknown): string {
	return `${condition}:${typeof value}:${(() => {
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return "[unstringifiable]";
		}
	})()}`;
}

/** The known `router` keys — anything else is a typo worth surfacing (CQ1). */
const ROUTER_KEYS = ["models", "allowUnmeasuredEffort", "showWarnings"];

/**
 * Validate the raw `router` config value (D4/D53). undefined → the defaults
 * ({ models: [], allowUnmeasuredEffort: true }) silently: the router is off by
 * default. A wrong-shape value warns once and falls back to those defaults;
 * individually invalid `models` entries are dropped with a per-entry warning,
 * and an unknown key is reported the way sanitizeContextBudget reports one
 * (CQ1 — a typo'd `"model"` must not look like an empty list).
 * `allowUnmeasuredEffort` defaults to TRUE — an evidence gap is advisory.
 * `showWarnings` defaults to FALSE — model data notes are hidden until asked for.
 *
 * EVERY warning here is a configuration fault by the class test: each one names
 * a value slate read from the project config and then ignored.
 */
export function sanitizeRouterConfig(raw: unknown, warn: RouterWarnSink): Required<RouterConfig> {
	const defaults: Required<RouterConfig> = { models: [], allowUnmeasuredEffort: true, showWarnings: false };
	const fault = (message: string) => warn(sanitizeForNotify(message, ROUTER_MESSAGE_MAX), "configuration-fault");
	if (raw === undefined) return defaults;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		fault('slate: ignoring the router config. It must be an object like { "models": ["provider/id"], "allowUnmeasuredEffort": true }.');
		return defaults;
	}
	const value = raw as { models?: unknown; allowUnmeasuredEffort?: unknown; showWarnings?: unknown };

	let unknownKeys: string[];
	try {
		unknownKeys = Object.keys(value).filter((k) => !ROUTER_KEYS.includes(k));
	} catch {
		fault("slate: ignoring the router config because its keys could not be read. Slate uses the router defaults.");
		return defaults;
	}
	if (unknownKeys.length > 0) {
		fault(
			`slate: ignoring unknown router key(s): ${sanitizeForNotify(unknownKeys.join(", "))}. The known router keys are ${ROUTER_KEYS.map(
				(k) => `"${k}"`,
			).join(", ")}.`,
		);
	}

	const read = (key: keyof typeof value): { readable: boolean; value: unknown } => {
		try {
			return { readable: true, value: value[key] };
		} catch {
			fault(`slate: ignoring router.${key} because its value could not be read. Slate uses the default.`);
			return { readable: false, value: undefined };
		}
	};

	const rawModels = read("models");
	const models: string[] = [];
	if (rawModels.readable && rawModels.value !== undefined) {
		if (!Array.isArray(rawModels.value)) {
			fault('slate: router.models must be an array of "provider/id" strings. Slate ignores the value, so the router stays off.');
		} else {
			for (const entry of rawModels.value) {
				if (!isModelSpec(entry)) {
					// quoted() echoes a USER value, so its brackets stay: a nested array has
					// to be recognisable in the warning that rejects it.
					fault(`slate: ignoring the router.models entry ${quoted(entry)}. Reason: ${describeSpecDefect(entry)}.`);
					continue;
				}
				models.push(entry);
			}
		}
	}

	let allowUnmeasuredEffort = true;
	const rawAllowUnmeasuredEffort = read("allowUnmeasuredEffort");
	if (rawAllowUnmeasuredEffort.readable && rawAllowUnmeasuredEffort.value !== undefined) {
		if (typeof rawAllowUnmeasuredEffort.value !== "boolean") {
			fault(
				`slate: ignoring router.allowUnmeasuredEffort ${quoted(rawAllowUnmeasuredEffort.value)}. Expected true or false. Slate uses true.`,
			);
		} else {
			allowUnmeasuredEffort = rawAllowUnmeasuredEffort.value;
		}
	}

	// Same shape as allowUnmeasuredEffort above: a non-boolean value is reported
	// and the default stands. Reporting it is itself a configuration fault, so a
	// typo here can never hide behind the very option it fails to set.
	let showWarnings = false;
	const rawShowWarnings = read("showWarnings");
	if (rawShowWarnings.readable && rawShowWarnings.value !== undefined) {
		if (typeof rawShowWarnings.value !== "boolean") {
			fault(`slate: ignoring router.showWarnings ${quoted(rawShowWarnings.value)}. Expected true or false. Slate uses false.`);
		} else {
			showWarnings = rawShowWarnings.value;
		}
	}

	return { models, allowUnmeasuredEffort, showWarnings };
}

/**
 * Resolve the routable candidate set.
 *
 * An empty model list returns ROUTER_OFF WITHOUT touching the registry or the
 * profile table — the fast path, since the router is off by default and there
 * are no candidates to resolve. Every warning is emitted at most once per
 * condition (D58), sanitized, through
 * `warn` (default no-op) and collected on the result.
 *
 * Hostile/raw input is handled here rather than assumed away: `models` may be
 * anything (a non-array is treated as empty), entries may be of any type, and
 * the injected registry and profile source may throw. sanitizeRouterConfig
 * normally runs first, but this function is also called directly — by the
 * checks, and by any future caller that builds a list itself (BG4).
 */
export function resolveModelRouter(input: ModelRouterInput, warn: RouterWarnSink = () => {}): ModelRouterResolution {
	const models = Array.isArray(input.models) ? input.models : [];
	if (models.length === 0) return ROUTER_OFF;

	const profiles = input.profiles ?? SHIPPED_PROFILE_SOURCE;
	const failover = input.failover ?? {};

	// D58: one warning per condition per resolution. The key, not the text, is
	// what identifies a condition, so a reworded message cannot start repeating.
	// BG3: the sink is called inside a try/catch — a throwing UI must not abort a
	// resolution (and, through the memo below, must not un-cache it either).
	//
	// The CLASS is the third parameter, and it DEFAULTS to "configuration-fault".
	// A future warning added here without a class is therefore visible rather than
	// silently hidden: forgetting the class costs noise, never a lost report.
	const emitted = new Set<string>();
	const warnings: string[] = [];
	const emitOnce = (key: string, message: string, warningClass: RouterWarningClass): string | undefined => {
		if (emitted.has(key)) return undefined;
		emitted.add(key);
		const text = sanitizeRouterWarning(message);
		try {
			warn(text, warningClass);
		} catch {
			/* a broken warn sink costs the notice, never the resolution (BG3) */
		}
		return text;
	};
	const once = (key: string, message: string, warningClass: RouterWarningClass = "configuration-fault") => {
		const text = emitOnce(key, message, warningClass);
		if (text !== undefined) warnings.push(text);
	};

	const candidates: RouterCandidate[] = [];
	type DropClass = "fault" | "warn";
	const drops: Array<{ entry: string; reason: string; class: DropClass }> = [];
	const dropped = (raw: unknown, reason: string, dropClass: DropClass) => {
		drops.push({ entry: quoted(raw), reason: sanitizeForNotify(reason, 180), class: dropClass });
	};
	const seenSpecs = new Set<string>();
	const claimedProfiles = new Map<string, string>(); // profile id → the spec that claimed it (BG6)
	for (const raw of models) {
		if (!isModelSpec(raw)) {
			dropped(raw, describeSpecDefect(raw), "fault");
			once(
				conditionKey("malformed", raw),
				// quoted() echoes a USER value: brackets and all, so the entry stays recognisable.
				`slate: model router: ignoring the router.models entry ${quoted(raw)}. It is not a canonical "provider/id" ` +
					`model spec. Reason: ${describeSpecDefect(raw)}.`,
			);
			continue;
		}
		if (seenSpecs.has(raw)) {
			dropped(raw, "exact specification duplicates an earlier entry", "warn");
			continue;
		}
		seenSpecs.add(raw);
		const label = specLabel(raw);

		let profile: ModelProfile | undefined;
		try {
			profile = profiles.findProfile(raw);
		} catch {
			profile = undefined; // a throwing profile source is a missing profile, not a crash (CQ5)
		}
		if (!profile || typeof profile !== "object") {
			dropped(raw, "missing shipped model profile", "fault");
			once(
				conditionKey("unprofiled", raw),
				`slate: model router: ${label} has no entry in slate's model profile table. Slate has no benchmark data for it, ` +
					"so slate drops it from routing. Remove it from router.models, or list a profiled model instead.",
			);
			continue;
		}

		// BG6: two different specs can resolve to the SAME profile (an alias, or a
		// case variant — findProfile is alias-aware and case-insensitive). Routing
		// would then carry two candidates for one model and duplicate its ladder.
		const profileId = typeof profile.id === "string" ? profile.id : label;
		const claimedBy = claimedProfiles.get(profileId);
		if (claimedBy !== undefined) {
			dropped(raw, `profile alias duplicates ${claimedBy}`, "fault");
			once(
				conditionKey("alias-duplicate", raw),
				`slate: model router: ${label} and ${sanitizeForNotify(claimedBy)} name the same profiled model. ` +
					`Both resolve to the model profile ${sanitizeForNotify(profileId)}. Slate keeps the first entry and drops ${label}.`,
			);
			continue;
		}
		// Claim profile identity before registry and credential checks. Alias
		// duplication is a configuration fault even when both spellings later drop.
		claimedProfiles.set(profileId, raw);

		const parts = splitModelSpec(raw);
		if (!parts) continue; // unreachable: isModelSpec passed above
		const { provider, id } = parts;
		let model: RouterRegistryModel | undefined;
		try {
			model = input.registry.find(provider, id);
		} catch {
			model = undefined; // a throwing registry is a missing model, not a crash
		}
		if (!model || typeof model !== "object") {
			dropped(raw, "model is unknown to pi's registry", "warn");
			once(
				conditionKey("unknown", raw),
				`slate: model router: ${label} is not in pi's model registry. Slate drops it from routing. ` +
					"A dispatch to a model pi does not know could only produce a billed failure. " +
					"Add the model to pi's model registry, or remove it from router.models.",
			);
			continue;
		}
		let authed = false;
		try {
			authed = input.registry.hasConfiguredAuth(model) === true;
		} catch {
			authed = false; // cannot even resolve credentials ⇒ not routable
		}
		if (!authed) {
			dropped(raw, "model has no usable pi credentials", "warn");
			once(
				conditionKey("noauth", raw),
				`slate: model router: ${label} has no usable credentials configured in pi. Slate drops it from routing. ` +
					"A dispatch to a model without credentials could only produce a billed failure. Add credentials in pi to route to it.",
			);
			continue;
		}


		// W1 context-window canary (D55). It REPORTS a divergence; it does not
		// diagnose one. The earlier wording closed with "the registry wins; the
		// profile is stale", which is a conclusion this module cannot reach: it sees
		// two numbers and no provenance for either side. Routing does use the
		// registry figure — that is a fact about this code, stated as such — but which
		// figure is CORRECT stays open, because on a stock pi install the registry is
		// the side that looks wrong (see the billing hint below).
		//
		// Both absence guards are load-bearing: the shipped table leaves
		// contextWindow null where no capacity figure could be traced, and a
		// fabricated/older registry entry may carry none either — neither absence is
		// a divergence. A registry value equal to the profile's recorded
		// KNOWN-divergence figure is not one either: the table documents that second
		// published number precisely so a cross-check stays quiet about it.
		const registryWindow = finite(model.contextWindow);
		const resolvedRegistryCosts = registryCosts(model);
		const profileWindow = finite(profile.contextWindow ?? undefined);
		const knownDivergence = finite(optional(profile).contextWindowKnownDivergence);
		if (
			registryWindow !== undefined &&
			profileWindow !== undefined &&
			registryWindow !== profileWindow &&
			registryWindow !== knownDivergence
		) {
			once(
				conditionKey("w1", raw),
				// WC5: "profile" and "profile asOf", never "research" — the asOf is whatever
				// the LOADED profile carries, and deferred issue 001 (`router.profilesPath`,
				// user-supplied profiles through this same path) would make a "research"
				// attribution false. WHOEVER IMPLEMENTS ISSUE 001: if a profile can come
				// from the user, this line must name WHICH source it read — the sentence
				// contrasts two sources, and mislabelling one of them is the whole defect
				// this wording was rewritten to avoid.
				`slate: model router: the context window for ${label} differs between two sources. The model profile records ` +
					`${profileWindow} tokens, and that profile was recorded as of ${routerProfileText(quoted(profile.asOf ?? "unknown"))}. ` +
					`The pi model registry reports ${registryWindow} tokens. Routing uses the registry figure. ` +
					"Slate does not establish here which source is correct.",
				"model-data-note",
			);
		}

		// W3 unknown-data warning (D57): routable, but the decision is provisional.
		const unknownFields = Array.isArray(profile.unknownRoutingCriticalFields)
			? profile.unknownRoutingCriticalFields.filter((f) => typeof f === "string" && f !== "")
			: [];
		const renderedUnknownFields = unknownFields.map((field) => routerProfileText(field)).filter((field) => field !== "");
		if (renderedUnknownFields.length > 0) {
			// The CLASS explanation, once per session and only when a W3 warning fires at
			// all. It is emitted BEFORE the first per-model line, so a reader meets the
			// meaning of the class before the first instance of it (BG27's aggregation
			// argument, applied to an explanation rather than to a set of models).
			once(
				"w3-explainer",
				"slate: model router: slate advises model choices from a research table shipped inside slate. Some figures in that " +
					"table have no traced source. Slate records the absence instead of a guess. Routing still works. " +
					"Guidance for such a model rests on less evidence. You cannot close this gap from your configuration.",
				"model-data-note",
			);
			const factNoun = renderedUnknownFields.length === 1 ? "fact" : "facts";
			once(
				conditionKey("w3", raw),
				`slate: model router: ${label} has ${renderedUnknownFields.length} model ${factNoun} that slate could not trace to a ` +
					`source: ${renderedUnknownFields.join(FIELD_SEPARATOR)}. Routing to this model still works.`,
				"model-data-note",
			);
		}

		// CQ6: whatever the profile table hands back is filtered to pi's own ladder
		// vocabulary. A per-id lookup table can return a foreign value (a
		// prototype key such as "constructor" resolves to a function, not a list),
		// and an unvalidated ladder would make every effort check nonsense.
		let ladderRaw: unknown;
		try {
			ladderRaw = profiles.ladderFor(profile);
		} catch {
			ladderRaw = undefined;
		}
		// Filtered to pi's vocabulary AND de-duplicated: a repeated level would
		// otherwise reach a consumer rendering the ladder for the model to read.
		const ladder = Array.isArray(ladderRaw)
			? [...new Set(ladderRaw.filter((l): l is ThinkingLevel => THINKING_LEVELS.includes(l as string)))]
			: [];
		if (ladder.length === 0) {
			// The earlier text claimed that every explicit effort level would read as
			// off-ladder. That was wrong: guard 2 in route.ts fires only on a KNOWN ladder
			// (`ladderKnown`), so an unreadable ladder makes it stand down and the level goes
			// to pi, which clamps it. Guard 4 keeps its carve-out either way.
			once(
				conditionKey("ladder", raw),
				`slate: model router: ${label} has no usable effort ladder in its model profile. Slate keeps the model. ` +
					"Slate cannot check an explicit effort level against a ladder it could not read. Such a level passes " +
					"through to pi, which clamps it to a level the model supports. A level the provider rejects outright " +
					"is still refused.",
				"model-data-note",
			);
		}

		const hasFailover = Object.prototype.hasOwnProperty.call(failover, raw) && isModelSpec(failover[raw]);
		candidates.push({
			spec: raw,
			provider,
			id,
			profile,
			tier: profile.tier,
			registryCost: resolvedRegistryCosts,
			contextWindow: registryWindow,
			ladder: Object.freeze(ladder),
			hasFailover,
			tierUnsourced: optional(profile).tierUnsourced === true,
			ladderAssumed: optional(profile).ladderAssumed === true,
		});
	}

	// Nothing survived ⇒ the router turns OFF with ONE summary warning. Half a
	// list is a routing policy; no list is not, and silently routing to whatever
	// the session happened to start on would hide the real problem above.
	if (!isNonEmpty(candidates)) {
		const detail = drops.map((drop) => `${drop.entry} [${drop.class}]: ${drop.reason}`).join("; ");
		const hasFault = drops.some((drop) => drop.class === "fault");
		const summary = `slate: model router: routing is disabled. None of the ${models.length} configured router.models entries survived validation. ${detail}`;
		once("all-dropped", summary);
		return frozenResolution(false, [], warnings, hasFault ? summary : undefined);
	}

	// Preserve the configured order. Validation and de-duplication remove entries,
	// but tier and registry rates never reorder survivors.
	const uncovered = candidates.filter((c) => !c.hasFailover).map((c) => sanitizeForNotify(c.spec, 60));
	if (uncovered.length > 0) {
		once(
			"failover-coverage",
			`slate: model router: these routable models have no modelFailover entry: ${uncovered.join(", ")}. ` +
				"A model failure during an action routed to one of them has no failover coverage. " +
				"Add a modelFailover entry for each of them to cover that case.",
		);
	}
	return frozenResolution(true, candidates, warnings);

}

/** Build the frozen result object — one place, so every return path is shaped and frozen identically. */
function frozenResolution(
	on: boolean,
	candidates: RouterCandidate[],
	warnings: string[],
	fault?: string,
): ModelRouterResolution {
	return Object.freeze({
		on,
		candidates: Object.freeze([...candidates]),
		warnings: Object.freeze([...warnings]),
		...(fault ? { fault } : {}),
	}) as unknown as ModelRouterResolution;
}

/**
 * The dispatch-side model/effort predicate (consumed by Track 02).
 *
 * Reports the pair's standing against a resolution: not in the effective list,
 * off the model's ladder, ladder-valid but an evidence gap, or ok. It NEVER
 * decides anything — `router.allowUnmeasuredEffort` and the refusal wording
 * live in the dispatch path.
 *
 * With the router OFF this predicate reports `ok` for every pair, having no
 * candidate list to judge against — a statement about THIS function only, since
 * route.ts feeds it a SYNTHESISED one-candidate resolution built from its
 * injected profile source, so a router-OFF explicit level can still be refused.
 * An omitted/empty effort is also `ok` — the
 * ladder question only arises for a level the caller actually asked for.
 * `listedGap` distinguishes an authored evidence gap from one the table never
 * mentioned (see EffortVerdict/BG9); both are advisory.
 */
export function checkEffort(resolution: ModelRouterResolution, spec: string, effort?: string): EffortCheck {
	const base: EffortCheck = {
		verdict: "ok",
		spec,
		effort: effort ?? "",
		ladder: [],
		measured: false,
		listedGap: false,
		apiRejected: false,
	};
	if (!resolution?.on) return base;
	// CQ5: a fabricated or partially-built resolution (`{ on: true }`) must not
	// crash the dispatch path that consults this predicate.
	const list = Array.isArray(resolution.candidates) ? resolution.candidates : [];
	const candidate = list.find((c) => c?.spec === spec);
	if (!candidate) return { ...base, verdict: "not-listed" };
	const ladder = Array.isArray(candidate.ladder) ? candidate.ladder : [];
	if (effort === undefined || effort === "") return { ...base, ladder };
	// Same reasoning as the two guards above: the profile is present on every
	// candidate this module builds, and absent on a fabricated one (CQ5).
	const profile = (candidate.profile ?? {}) as ModelProfile;
	const measured = listHas(profile.capabilityMeasuredAt, effort);
	const listedGap = listHas(profile.evidenceGapAt, effort);
	// A provider-unsupported requested control is unusable, whatever the ladder says.
	// The table keeps the control on the ladder because pi's vocabulary is fixed,
	// then records the unsupported request separately. Slate rejects it before pi
	// can omit the control or silently substitute another value.
	const apiRejected = listHas(optional(profile).apiRejectedLevels, effort);
	if (apiRejected || !listHas(ladder, effort)) {
		return { verdict: "off-ladder", spec, effort, ladder, measured, listedGap, apiRejected };
	}
	// BG9: measured is the ONLY source of an `ok`. A level that is neither
	// measured nor listed as a gap is an unlisted gap, not a capability claim.
	return { verdict: measured ? "ok" : "evidence-gap", spec, effort, ladder, measured, listedGap, apiRejected };
}

/**
 * Wrap resolveModelRouter so it runs at most ONCE per session, like
 * createWorkerExtensionResolver: the first call resolves and caches, every
 * later call returns that same frozen resolution — which is also what makes the
 * D58 "at most once per session" warning guarantee hold under repeated
 * consultation. `getInput` is read lazily at first use (after session_start, so
 * a provider registered by another extension during session_start is visible).
 *
 * The memo holds unconditionally (BG3). Warnings already go through a
 * try/catch, and a throw from `getInput` or from anything else in resolution is
 * caught here and cached as an OFF resolution carrying one warning: the router
 * failing is not a reason to keep re-running it every turn, and an empty
 * candidate result is safe for candidate-dependent guards. There is deliberately
 * NO second message-level dedup layer — it made the real dedup untestable (CQ4)
 * while adding nothing the memo does not already guarantee.
 *
 * CQ7: what is frozen includes the candidate and auth SNAPSHOT. A key added to
 * pi mid-session does not revive a model dropped as unauthenticated until the
 * next session_start. The dispatch price callback remains live by design.
 */
export function createModelRouterResolver(
	getInput: () => ModelRouterInput,
	warn: RouterWarnSink = () => {},
): () => ModelRouterResolution {
	let cached: ModelRouterResolution | undefined;
	return () => {
		if (cached === undefined) {
			try {
				cached = resolveModelRouter(getInput(), warn);
			} catch (error) {
				// A configuration fault by the class test: the user's own model list, config or
				// credentials are the most likely input to a failed resolution, and a silent
				// router that routes nothing is the worst outcome to hide.
				const message = sanitizeForNotify(
					`slate: model router: routing is disabled. The router could not resolve its model list. The error was: ${sanitizeForNotify(
						error instanceof Error ? error.message : String(error),
					)}`,
					ROUTER_MESSAGE_MAX,
				);
				try {
					warn(message, "configuration-fault");
				} catch {
					/* see BG3 above */
				}
				cached = frozenResolution(false, [], [message]);
			}
		}
		return cached;
	};
}
