/**
 * Model router: resolving WHICH models an action may be dispatched to, and at
 * which effort levels.
 *
 * The router is OFF by default: with no `router.models` configured this resolver
 * returns no candidates and emits no router warning. When a project DOES list
 * models, this module maps that list plus pi's model registry
 * plus the benchmark profiles in model-profiles.ts onto a small, ordered set of
 * routable candidates — and the warnings that make the gaps in that data
 * visible instead of silent.
 *
 * The mechanism, and the decisions it implements:
 *
 *  - PURE, INJECTED (mirrors worker-extensions.ts): every dependency arrives as
 *    a parameter — the registry slice (`find` + `hasConfiguredAuth`), the
 *    profile table (`findProfile` + `ladderFor`), the failover map, today's
 *    date, and the `warn` sink. Nothing is read from a live pi session here, so
 *    the whole pipeline is exercisable against fabricated in-memory inputs
 *    (verification/resolver-checks.mjs). The shipped profile table is only the
 *    DEFAULT of the injected `profiles` parameter.
 *
 *  - EXCLUSION IS THE POINT (D53). A configured model is dropped, with a
 *    warning naming it, when it has no profile (no benchmark data ⇒ no basis for
 *    a routing decision), when its spec is not canonical "provider/id", when
 *    pi's registry does not know it, or when pi has no credentials configured
 *    for it — routing to an unauthenticated or unknown model would produce
 *    billed failures, not work. If EVERY entry is dropped the router turns OFF
 *    with one summary warning rather than half-working.
 *
 *  - ORDER is tier ascending, then current effective input price ascending
 *    (then spec, for determinism). The CHEAPEST candidate is exposed separately
 *    because it is the default base model of a new thread (D48): a thread's base
 *    model must itself be a listed model, so a dispatch that omits a model can
 *    never be rejected by the list guard. That pick SKIPS profiles carrying a
 *    `nonPreferred` reason — the table states that marker as absolute ("never a
 *    default pick, whatever the tier says"), and the base model is the most
 *    default pick there is (BG1). If every candidate is non-preferred the
 *    cheapest one is still chosen — D48 needs *a* base model — and that fallback
 *    is warned about and flagged on the result. The ORDERED LIST honours the same
 *    markers (DF4), and does so ABSOLUTELY rather than within a tier: EVERY
 *    preferred candidate precedes every non-preferred one whatever their tiers or
 *    prices, and within one preference class every sourced-tier candidate precedes
 *    every unsourced-tier one — so a consumer that walks the list rather than
 *    reading `cheapest` cannot meet an evidentially-thin model first just because
 *    it is cheap. Tier and price only order candidates that are equal on both
 *    markers.
 *
 *  - THE REGISTRY IS THE AUTHORITY for what routing USES. A profile's
 *    `contextWindow` is documentation-only; W1 (D55) cross-checks it against the
 *    registry and warns on divergence, naming both numbers and the profile's asOf
 *    date, and the candidate always carries the REGISTRY value. The warning
 *    REPORTS the divergence and does not diagnose it: authority over the value
 *    routing uses is not evidence about which figure is factually right, and a
 *    stock pi install has a registry entry that looks like a billing row restated
 *    as a capacity — so when the registry's window equals that model's own
 *    long-context threshold, the per-model line says so and points at ONE further
 *    warning that names the pattern (RI32) and every model it applies to, instead
 *    of blaming either side or repeating the explanation per model (BG27).
 *    `longContextThreshold` / `longContextMultipliers` are BILLING facts and are
 *    deliberately NOT applied to the ordering price — they describe what happens
 *    above a token threshold, not the base rate a router compares models on.
 *
 *  - W3 (D57): a candidate with `unknownRoutingCriticalFields` is routable but
 *    warned about once, naming the fields — the routing decision for it is
 *    provisional.
 *
 *  - THE PROFILE TABLE GROWS. Only the fields this module actually needs are
 *    read, so a research refresh that adds columns cannot break resolution, and
 *    the OPTIONAL ones are read through the `optional()` view rather than the
 *    declared type. Three of them carry obligations the router honours:
 *    `contextWindowKnownDivergence` (a registry reporting that second published
 *    figure is NOT a stale profile, so W1 stays quiet), `apiRejectedLevels` (a
 *    level the provider rejects outright reports as off-ladder, since dispatching
 *    it would be a guaranteed HTTP 400), and `tierUnsourced`/`ladderAssumed`,
 *    which ride onto the candidate so a consumer never presents an unsourced
 *    tier position or an assumed ladder as a traced fact.
 *
 *  - EVIDENCE GAPS ARE ADVISORY. `checkEffort` reports a level with no traced
 *    capability measurement as `evidence-gap`; it is the caller (the dispatch
 *    path, Track 02, gated by `router.allowUnmeasuredEffort`, default true) that
 *    decides what to do with that. This module never refuses anything.
 *
 *  - EVERY WARNING CARRIES A CLASS (see RouterWarningClass): a CONFIGURATION
 *    FAULT the user can act on, or a MODEL DATA NOTE about shipped research the
 *    user cannot change. This module never hides anything: it tags each warning
 *    and sends every one of them to the sink it was handed. The extension entry
 *    point (index.ts) is what filters notes when `router.showWarnings` is off,
 *    and what reports how many it hid.
 *
 *  - EVERY WARNING AT MOST ONCE PER SESSION (D58), sanitized through the shared
 *    sanitizeForNotify before display, exactly like the other sanitizers: config
 *    values and profile fields are user-editable text that reaches ctx.ui.notify.
 *    Each assembled message is capped as a WHOLE (ROUTER_MESSAGE_MAX), so the
 *    control-byte guard covers the finished string and not only its parts.
 *    Warnings are BOTH pushed to the sink and collected on the result, and the
 *    sink is called defensively — a throwing UI must not cost a resolution
 *    (BG3). Per-candidate notices that would otherwise scale with the list
 *    length (failover coverage) are AGGREGATED into one line (CQ3).
 *
 *  - FROZEN AT FIRST USE: createModelRouterResolver memoizes the first
 *    resolution for the session, the way createWorkerExtensionResolver does — a
 *    dispatch guard and a doctrine section built from two different resolutions
 *    of the same session would be a bug, and repeated consultation must not
 *    re-emit warnings. The registry and auth reads are therefore a SNAPSHOT:
 *    credentials or providers added later in the session are not picked up until
 *    the next session_start (CQ7), which is the same freeze the worker-extension
 *    resolver deliberately takes.
 */

import {
	findProfile as shippedFindProfile,
	ladderFor as shippedLadderFor,
	type ModelProfile,
	type ModelTier,
	type PriceRow,
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
export interface RouterRegistryModel {
	contextWindow?: number;
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
 * A `model-data-note` reports the shipped research table itself: a figure that
 * has no traced source, two sources that disagree, a price row that does not
 * cover today. No project config and no credential closes that gap, so these are
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
 * Per-field cap for PROFILE-SOURCED text (the unknown-field entries and the
 * non-preferred reason). BOTH bounds matter:
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
function profileText(text: string, max = PROFILE_FIELD_MAX): string {
	// Bound BEFORE scanning for tags. This keeps an unclosed bracket run from
	// consuming session-start time, and the cap remains below the hostile 200-char
	// fixture while clearing every real shipped entry.
	const wasTruncated = text.length > max;
	const bounded = text.slice(0, max);
	const collapsed = bounded
		// A citation can act as the subject after punctuation. Restore a neutral
		// subject before removing it: "; [G3] gives" becomes "; the source gives".
		.replace(/(^|[;:,.])\s*\[[^\]]*\]\s+(?=[A-Za-z])/g, "$1 the source ")
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
	inUsdPerMTok: number | undefined; // current effective input price (undefined = no covering price row)
	outUsdPerMTok: number | undefined; // current effective output price
	contextWindow: number | undefined; // REGISTRY value — never the profile's (D55)
	ladder: readonly ThinkingLevel[]; // ladderFor(profile), validated, captured so checkEffort needs no injection
	hasFailover: boolean; // present as a key in the configured modelFailover map
	nonPreferred: string | null; // the profile's absolute "never a default pick" reason, or null
	tierUnsourced: boolean; // the profile's tier is NOT a sourced ordinal (cost class only) — do not render it as a ranking
	ladderAssumed: boolean; // the ladder is an assumed provider-family shape, not a traced fact
}

/** The resolution: the router's whole answer for a session. */
export interface ModelRouterResolution {
	on: boolean; // false = router off; candidates is then empty and nothing is gated
	candidates: readonly RouterCandidate[]; // tier asc, then effective input price asc, then spec
	cheapest: string | undefined; // default base model (D48): cheapest PREFERRED candidate
	cheapestNonPreferred: boolean; // true = every candidate is non-preferred, so `cheapest` had to break that rule
	warnings: readonly string[]; // every warning emitted for this resolution, in order
}

/** The off state with no warnings — the default, shared and deep-frozen (CQ22). */
export const ROUTER_OFF: ModelRouterResolution = Object.freeze({
	on: false,
	candidates: Object.freeze([]),
	cheapest: undefined,
	cheapestNonPreferred: false,
	warnings: Object.freeze([]),
}) as unknown as ModelRouterResolution;

/** Inputs of one resolution. Only `registry` and `models` are required. */
export interface ModelRouterInput {
	registry: RouterRegistry;
	models: readonly string[]; // sanitized router.models (empty = router off)
	failover?: Record<string, string>; // sanitized modelFailover map, for the coverage warning
	profiles?: RouterProfileSource; // default: the shipped table
	today?: string; // "YYYY-MM-DD" used for price-row selection (default: today, UTC)
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
	apiRejected: boolean; // the PROVIDER rejects this level outright (a hard 400, not an evidence gap)
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

/** Today as "YYYY-MM-DD" (UTC) — only used as the default of the injected date. */
function utcToday(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * An ISO calendar date, exactly "YYYY-MM-DD" (BG8). The date comparisons below
 * are plain string `<=`, which is chronological ONLY for this fixed-width form —
 * so anything else ("2026-9-1", a timestamp, a Date) is treated as an absent
 * bound rather than compared and silently mis-ordered.
 */
function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Defensive read of a numeric profile/registry field: a finite number, or undefined. */
function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

/**
 * The price row in force on `today`.
 *
 * A row applies when `from` is absent/invalid or ≤ today AND `until` is
 * absent/invalid or ≥ today. Among applicable rows the one with the greatest
 * `from` wins (the most recently effective schedule); ties — including the
 * common all-null case — resolve to the FIRST such row in authoring order, so
 * the table's own ordering decides and the result is stable. With no applicable
 * row at all (an expired schedule, or one that starts in the future) the most
 * recent PAST row is used as the best available figure, and failing that the
 * first row; an empty/garbage schedule yields undefined, which the ordering
 * treats as "unknown, sort last" and warns about.
 *
 * Only `from`/`until`/`inUsdPerMTok`/`outUsdPerMTok` are read, so optional
 * additions to PriceRow (cache-read/-write rates and the like) are ignored here
 * rather than breaking selection.
 */
export function effectivePriceRow(profile: ModelProfile, today: string): PriceRow | undefined {
	const raw = (profile as { price?: unknown }).price;
	const rows = Array.isArray(raw) ? (raw.filter((r) => !!r && typeof r === "object") as PriceRow[]) : [];
	if (rows.length === 0) return undefined;
	const day = isIsoDate(today) ? today : utcToday();
	const from = (r: PriceRow) => (isIsoDate(r.from) ? r.from : "");
	const applicable = rows.filter((r) => {
		const lo = isIsoDate(r.from) ? r.from : null;
		const hi = isIsoDate(r.until) ? r.until : null;
		return (lo === null || lo <= day) && (hi === null || hi >= day);
	});
	const pick = (pool: NonEmptyArray<PriceRow>) => pool.reduce((best, r) => (from(r) > from(best) ? r : best), pool[0]);
	if (isNonEmpty(applicable)) return pick(applicable);
	const past = rows.filter((r) => from(r) <= day);
	return isNonEmpty(past) ? pick(past) : rows[0];
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

/** Sort key for a tier: a malformed/absent tier sorts LAST instead of poisoning the comparator with NaN (CQ5). */
function tierOf(profile: ModelProfile): number {
	return finite(profile.tier) ?? Number.POSITIVE_INFINITY;
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
	const today = isIsoDate(input.today) ? input.today : utcToday();

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
	const once = (key: string, message: string, warningClass: RouterWarningClass = "configuration-fault") => {
		if (emitted.has(key)) return;
		emitted.add(key);
		// The whole assembled message is capped here, so the control-byte strip and the
		// length bound apply to the finished string and not only to its interpolations.
		const text = sanitizeForNotify(message, ROUTER_MESSAGE_MAX);
		warnings.push(text);
		try {
			warn(text, warningClass);
		} catch {
			/* a broken warn sink costs the notice, never the resolution (BG3) */
		}
	};

	const candidates: RouterCandidate[] = [];
	const seenSpecs = new Set<string>();
	/** Specs whose registry window equals their own long-context billing threshold (BG27, explained once below). */
	const billingPatternSpecs: string[] = [];
	const claimedProfiles = new Map<string, string>(); // profile id → the spec that claimed it (BG6)
	for (const raw of models) {
		if (!isModelSpec(raw)) {
			once(
				conditionKey("malformed", raw),
				// quoted() echoes a USER value: brackets and all, so the entry stays recognisable.
				`slate: model router: ignoring the router.models entry ${quoted(raw)}. It is not a canonical "provider/id" ` +
					`model spec. Reason: ${describeSpecDefect(raw)}.`,
			);
			continue;
		}
		if (seenSpecs.has(raw)) continue; // duplicate listing — first wins, silently
		seenSpecs.add(raw);
		const label = specLabel(raw);

		let profile: ModelProfile | undefined;
		try {
			profile = profiles.findProfile(raw);
		} catch {
			profile = undefined; // a throwing profile source is a missing profile, not a crash (CQ5)
		}
		if (!profile || typeof profile !== "object") {
			once(
				conditionKey("unprofiled", raw),
				`slate: model router: ${label} has no entry in slate's model profile table. Slate has no benchmark data for it, ` +
					"so slate drops it from routing. Remove it from router.models, or list a profiled model instead.",
			);
			continue;
		}

		// BG6: two different specs can resolve to the SAME profile (an alias, or a
		// case variant — findProfile is alias-aware and case-insensitive). Routing
		// would then carry two candidates for one model, each with its own price
		// row and ladder, and the cheapest-pick would compare a model with itself.
		const profileId = typeof profile.id === "string" ? profile.id : label;
		const claimedBy = claimedProfiles.get(profileId);
		if (claimedBy !== undefined) {
			once(
				conditionKey("alias-duplicate", raw),
				`slate: model router: ${label} and ${sanitizeForNotify(claimedBy)} name the same profiled model. ` +
					`Both resolve to the model profile ${sanitizeForNotify(profileId)}. Slate keeps the first entry and drops ${label}.`,
			);
			continue;
		}

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
			once(
				conditionKey("noauth", raw),
				`slate: model router: ${label} has no usable credentials configured in pi. Slate drops it from routing. ` +
					"A dispatch to a model without credentials could only produce a billed failure. Add credentials in pi to route to it.",
			);
			continue;
		}

		const row = effectivePriceRow(profile, today);
		const inUsdPerMTok = row ? finite(row.inUsdPerMTok) : undefined;
		const outUsdPerMTok = row ? finite(row.outUsdPerMTok) : undefined;
		if (inUsdPerMTok === undefined) {
			once(
				conditionKey("price", raw),
				`slate: model router: ${label} has no usable input price for ${today} in its model profile. ` +
					"Slate keeps the model and orders it last. Slate cannot compare its cost with the other models.",
				"model-data-note",
			);
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
		const profileWindow = finite(profile.contextWindow ?? undefined);
		const knownDivergence = finite(optional(profile).contextWindowKnownDivergence);
		if (
			registryWindow !== undefined &&
			profileWindow !== undefined &&
			registryWindow !== profileWindow &&
			registryWindow !== knownDivergence
		) {
			// DIAGNOSTIC COINCIDENCE (WC6 — hedged to what the arithmetic supports): a
			// reported window identical to that model's own long-context BILLING
			// threshold reads as a billing figure rather than a capacity, because a
			// window equal to its own threshold would leave the long-context price tier
			// unreachable. That is the shape RI32 named (a figure appearing in a source
			// only inside a pricing row is a billing figure and must not be restated as
			// a capacity) — suggestive, not proof, so the warning points at it and lets
			// the reader judge. The threshold is read from the profile the candidate
			// already carries: no number and no model id is written into this module.
			//
			// BG27: the per-model line keeps only the per-model FACTS plus a pointer.
			// The ~270-character pattern explanation is the same text for every affected
			// model, and on a stock pi install three profiles trip it at once, so it is
			// emitted ONCE after the loop (below) — naming every affected model there, so
			// nothing loses its attribution.
			const billingThreshold = finite(profile.longContextThreshold ?? undefined);
			const matchesBillingThreshold = billingThreshold !== undefined && registryWindow === billingThreshold;
			if (matchesBillingThreshold) billingPatternSpecs.push(sanitizeForNotify(raw, 60));
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
					`${profileWindow} tokens, and that profile was recorded as of ${profileText(quoted(profile.asOf ?? "unknown"))}. ` +
					`The pi model registry reports ${registryWindow} tokens. Routing uses the registry figure. ` +
					"Slate does not establish here which source is correct." +
					`${matchesBillingThreshold ? " That registry figure is also this model's long-context billing threshold. A separate note below names that pattern." : ""}`,
				"model-data-note",
			);
		}

		// W3 unknown-data warning (D57): routable, but the decision is provisional.
		const unknownFields = Array.isArray(profile.unknownRoutingCriticalFields)
			? profile.unknownRoutingCriticalFields.filter((f) => typeof f === "string" && f !== "")
			: [];
		const renderedUnknownFields = unknownFields.map((field) => profileText(field)).filter((field) => field !== "");
		if (renderedUnknownFields.length > 0) {
			// The CLASS explanation, once per session and only when a W3 warning fires at
			// all. It is emitted BEFORE the first per-model line, so a reader meets the
			// meaning of the class before the first instance of it (BG27's aggregation
			// argument, applied to an explanation rather than to a set of models).
			once(
				"w3-explainer",
				"slate: model router: slate picks models from a research table shipped inside slate. Some figures in that " +
					"table have no traced source. Slate records the absence instead of a guess. Routing still works. " +
					"The ranking of such a model rests on less evidence. You cannot close this gap from your configuration.",
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
		claimedProfiles.set(profileId, raw);
		candidates.push({
			spec: raw,
			provider,
			id,
			profile,
			tier: profile.tier,
			inUsdPerMTok,
			outUsdPerMTok,
			contextWindow: registryWindow,
			ladder: Object.freeze(ladder),
			hasFailover,
			nonPreferred: typeof profile.nonPreferred === "string" && profile.nonPreferred !== "" ? profile.nonPreferred : null,
			tierUnsourced: optional(profile).tierUnsourced === true,
			ladderAssumed: optional(profile).ladderAssumed === true,
		});
	}

	// Nothing survived ⇒ the router turns OFF with ONE summary warning. Half a
	// list is a routing policy; no list is not, and silently routing to whatever
	// the session happened to start on would hide the real problem above.
	if (!isNonEmpty(candidates)) {
		once(
			"all-dropped",
			`slate: model router: routing is disabled. None of the ${models.length} configured router.models entries ` +
				"survived validation. The warnings above name each dropped entry and the reason for it.",
		);
		return frozenResolution(false, [], undefined, false, warnings);
	}

	// BG27: the RI32 pattern explanation, ONCE, naming every model whose per-model
	// line pointed here. Same reasoning as the failover aggregate below: the
	// explanation is identical for every affected model, so repeating it verbatim
	// per model (three times on a stock pi install) is noise, while the SET of
	// affected models is the part a reader needs.
	if (billingPatternSpecs.length > 0) {
		once(
			"w1-billing-pattern",
			"slate: model router: for these models the pi model registry reports a context window equal to the model's own " +
				`long-context billing threshold: ${billingPatternSpecs.join(", ")}. A window equal to its own threshold would ` +
				"leave the long-context price tier unreachable. That shape suggests a billing figure restated as a capacity " +
				"figure. Slate reports the pattern and does not decide which figure is right.",
			"model-data-note",
		);
	}

	// CQ3: ONE aggregate line for failover coverage. Per-candidate notices here
	// scaled with the list length (a nine-model list produced nine of them), and
	// the actionable fact is the set, not each member.
	const uncovered = candidates.filter((c) => !c.hasFailover).map((c) => sanitizeForNotify(c.spec, 60));
	if (uncovered.length > 0) {
		once(
			"failover-coverage",
			`slate: model router: these routable models have no modelFailover entry: ${uncovered.join(", ")}. ` +
				"A model failure during an action routed to one of them has no failover coverage. " +
				"Add a modelFailover entry for each of them to cover that case.",
		);
	}

	// ORDER (DF4). Five keys, in this order:
	//   1. preference   — a profile carrying a `nonPreferred` reason sorts after
	//                     every preferred candidate. The marker is absolute, and a
	//                     consumer reading the ORDERED LIST (not just `cheapest`)
	//                     must not meet an evidentially-thin model first just
	//                     because it is cheap.
	//   2. tier sourcing — a `tierUnsourced` tier is a COST class read off the
	//                     price, not a ranking, so within one preference class the
	//                     candidates whose tier IS sourced come first; the flag also
	//                     rides on the candidate so a consumer can say so.
	//   3. tier asc, 4. current effective input price asc,
	//   5. spec — only so the order is total and reproducible.
	const price = (c: RouterCandidate) => c.inUsdPerMTok ?? Number.POSITIVE_INFINITY;
	const preferenceRank = (c: RouterCandidate) => (c.nonPreferred === null ? 0 : 1);
	const sourcingRank = (c: RouterCandidate) => (c.tierUnsourced ? 1 : 0);
	candidates.sort(
		(a, b) =>
			preferenceRank(a) - preferenceRank(b) ||
			sourcingRank(a) - sourcingRank(b) ||
			tierOf(a.profile) - tierOf(b.profile) ||
			price(a) - price(b) ||
			(a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0),
	);

	// D48 + BG1: the default base model is the cheapest PREFERRED candidate.
	// Scanned over the ALREADY-SORTED pool with a strict <, so the sort's own keys
	// break a price tie: the earlier of the tied candidates wins, which after the
	// sort above means sourced tier first, then lower tier, then earlier spec. An
	// all-unpriced pool still yields a defined base model (every price compares
	// equal, so the first stands). If nothing is preferred, D48 still needs a base
	// model (a dispatch that omits a model must never be rejected by the list
	// guard), so the cheapest overall is taken — loudly.
	const preferred = candidates.filter((c) => c.nonPreferred === null);
	// Non-empty either way, and the compiler can see it: `preferred` is tested right
	// here, and `candidates` was narrowed by the all-dropped early return above.
	const pool = isNonEmpty(preferred) ? preferred : candidates;
	let cheapest = pool[0];
	for (const c of pool) if (price(c) < price(cheapest)) cheapest = c;
	const cheapestNonPreferred = cheapest.nonPreferred !== null;
	if (cheapestNonPreferred) {
		// Always visible (a configuration fault by part (b) of the class test: adding
		// one preferred model to router.models stops it), so the text is
		// project-authored and the interpolated reason is stripped of its source tags.
		once(
			"nonpreferred-base",
			"slate: model router: slate's model profiles mark every configured model as one it must never pick by " +
				`itself. Slate still needs a default base model, so ${sanitizeForNotify(cheapest.spec, 60)} is the base ` +
				`model for new threads. The recorded reason for that mark is: ${profileText(cheapest.nonPreferred ?? "")}. ` +
				"Add a model without that mark to router.models to change the base model.",
		);
	}

	return frozenResolution(true, candidates, cheapest.spec, cheapestNonPreferred, warnings);
}

/** Build the frozen result object — one place, so every return path is shaped and frozen identically. */
function frozenResolution(
	on: boolean,
	candidates: RouterCandidate[],
	cheapest: string | undefined,
	cheapestNonPreferred: boolean,
	warnings: string[],
): ModelRouterResolution {
	return Object.freeze({
		on,
		candidates: Object.freeze([...candidates]),
		cheapest,
		cheapestNonPreferred,
		warnings: Object.freeze([...warnings]),
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
	// A level the PROVIDER rejects outright is unusable, whatever the ladder says
	// (the table keeps such a level ON the ladder — pi's vocabulary is fixed — and
	// records the hard rejection separately). Reporting it as off-ladder is the
	// only answer that does not send the dispatch into a guaranteed HTTP 400.
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
 * CQ7: what is frozen includes the registry and auth SNAPSHOT. A key added to
 * pi mid-session does not revive a model dropped as unauthenticated until the
 * next session_start.
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
				cached = frozenResolution(false, [], undefined, false, [message]);
			}
		}
		return cached;
	};
}
