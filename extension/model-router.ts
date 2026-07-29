/**
 * Model router: resolving WHICH models an action may be dispatched to, and at
 * which effort levels.
 *
 * The router is OFF by default and OFF-behaviour is the pre-router behaviour:
 * with no `router.models` configured nothing here changes a dispatch. When a
 * project DOES list models, this module maps that list plus pi's model registry
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
 *    markers (DF4): non-preferred candidates, and candidates whose tier is not a
 *    sourced ordinal, sort after their comparable preferred/sourced siblings, so a
 *    consumer that walks the list rather than reading `cheapest` cannot meet an
 *    evidentially-thin model first just because it is cheap.
 *
 *  - THE REGISTRY IS THE AUTHORITY for capacity. A profile's `contextWindow` is
 *    documentation-only; W1 (D55) cross-checks it against the registry and warns
 *    on divergence, naming both numbers and the profile's asOf date, and the
 *    candidate always carries the REGISTRY value. `longContextThreshold` /
 *    `longContextMultipliers` are BILLING facts and are deliberately NOT applied
 *    to the ordering price — they describe what happens above a token threshold,
 *    not the base rate a router compares models on.
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
 *  - EVERY WARNING AT MOST ONCE PER SESSION (D58), sanitized through the shared
 *    sanitizeForNotify before display, exactly like the other sanitizers: config
 *    values and profile fields are user-editable text that reaches ctx.ui.notify.
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
	const pick = (pool: PriceRow[]) => pool.reduce((best, r) => (from(r) > from(best) ? r : best), pool[0]);
	if (applicable.length > 0) return pick(applicable);
	const past = rows.filter((r) => from(r) <= day);
	return past.length > 0 ? pick(past) : rows[0];
}

/** The known `router` keys — anything else is a typo worth surfacing (CQ1). */
const ROUTER_KEYS = ["models", "allowUnmeasuredEffort"];

/**
 * Validate the raw `router` config value (D4/D53). undefined → the defaults
 * ({ models: [], allowUnmeasuredEffort: true }) silently: the router is off by
 * default. A wrong-shape value warns once and falls back to those defaults;
 * individually invalid `models` entries are dropped with a per-entry warning,
 * and an unknown key is reported the way sanitizeContextBudget reports one
 * (CQ1 — a typo'd `"model"` must not look like an empty list).
 * `allowUnmeasuredEffort` defaults to TRUE — an evidence gap is advisory.
 */
export function sanitizeRouterConfig(raw: unknown, warn: (msg: string) => void): Required<RouterConfig> {
	const defaults: Required<RouterConfig> = { models: [], allowUnmeasuredEffort: true };
	if (raw === undefined) return defaults;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warn('slate: ignoring router — expected an object like { "models": ["provider/id"], "allowUnmeasuredEffort": true }');
		return defaults;
	}
	const value = raw as { models?: unknown; allowUnmeasuredEffort?: unknown };

	const unknownKeys = Object.keys(value).filter((k) => !ROUTER_KEYS.includes(k));
	if (unknownKeys.length > 0) {
		warn(
			`slate: ignoring unknown router key(s): ${sanitizeForNotify(unknownKeys.join(", "))} (known: ${ROUTER_KEYS.map(
				(k) => `"${k}"`,
			).join(", ")})`,
		);
	}

	const models: string[] = [];
	if (value.models !== undefined) {
		if (!Array.isArray(value.models)) {
			warn('slate: router.models must be an array of "provider/id" strings — ignoring it (the router stays off)');
		} else {
			for (const entry of value.models) {
				if (!isModelSpec(entry)) {
					warn(`slate: ignoring router.models entry ${quoted(entry)} — ${describeSpecDefect(entry)}`);
					continue;
				}
				models.push(entry);
			}
		}
	}

	let allowUnmeasuredEffort = true;
	if (value.allowUnmeasuredEffort !== undefined) {
		if (typeof value.allowUnmeasuredEffort !== "boolean") {
			warn(
				`slate: ignoring router.allowUnmeasuredEffort ${quoted(value.allowUnmeasuredEffort)} — expected true or false (defaulting to true)`,
			);
		} else {
			allowUnmeasuredEffort = value.allowUnmeasuredEffort;
		}
	}

	return { models, allowUnmeasuredEffort };
}

/** Sort key for a tier: a malformed/absent tier sorts LAST instead of poisoning the comparator with NaN (CQ5). */
function tierOf(profile: ModelProfile): number {
	return finite(profile.tier) ?? Number.POSITIVE_INFINITY;
}

/**
 * Resolve the routable candidate set.
 *
 * An empty model list returns ROUTER_OFF WITHOUT touching the registry or the
 * profile table — the fast path, since the router is off by default and that
 * path must stay behaviourally identical to the pre-router extension. Every
 * warning is emitted at most once per condition (D58), sanitized, through
 * `warn` (default no-op) and collected on the result.
 *
 * Hostile/raw input is handled here rather than assumed away: `models` may be
 * anything (a non-array is treated as empty), entries may be of any type, and
 * the injected registry and profile source may throw. sanitizeRouterConfig
 * normally runs first, but this function is also called directly — by the
 * checks, and by any future caller that builds a list itself (BG4).
 */
export function resolveModelRouter(input: ModelRouterInput, warn: (msg: string) => void = () => {}): ModelRouterResolution {
	const models = Array.isArray(input.models) ? input.models : [];
	if (models.length === 0) return ROUTER_OFF;

	const profiles = input.profiles ?? SHIPPED_PROFILE_SOURCE;
	const failover = input.failover ?? {};
	const today = isIsoDate(input.today) ? input.today : utcToday();

	// D58: one warning per condition per resolution. The key, not the text, is
	// what identifies a condition, so a reworded message cannot start repeating.
	// BG3: the sink is called inside a try/catch — a throwing UI must not abort a
	// resolution (and, through the memo below, must not un-cache it either).
	const emitted = new Set<string>();
	const warnings: string[] = [];
	const once = (key: string, message: string) => {
		if (emitted.has(key)) return;
		emitted.add(key);
		warnings.push(message);
		try {
			warn(message);
		} catch {
			/* a broken warn sink costs the notice, never the resolution (BG3) */
		}
	};

	const candidates: RouterCandidate[] = [];
	const seenSpecs = new Set<string>();
	const claimedProfiles = new Map<string, string>(); // profile id → the spec that claimed it (BG6)
	for (const raw of models) {
		if (!isModelSpec(raw)) {
			once(
				conditionKey("malformed", raw),
				`slate: model router: ignoring ${quoted(raw)} — ${describeSpecDefect(raw)}, so it is not a canonical "provider/id" model spec`,
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
				`slate: model router: ${label} has no benchmark data in slate's model profiles — excluding it from routing`,
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
				`slate: model router: ${label} is the same profiled model as ${sanitizeForNotify(claimedBy)} ` +
					`(both resolve to ${sanitizeForNotify(profileId)}) — keeping the first and dropping this one`,
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
				`slate: model router: ${label} is not in pi's model registry — dropping it (routing there could only produce billed failures)`,
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
				`slate: model router: ${label} has no usable credentials configured in pi — dropping it (routing there could only produce billed failures)`,
			);
			continue;
		}

		const row = effectivePriceRow(profile, today);
		const inUsdPerMTok = row ? finite(row.inUsdPerMTok) : undefined;
		const outUsdPerMTok = row ? finite(row.outUsdPerMTok) : undefined;
		if (inUsdPerMTok === undefined) {
			once(
				conditionKey("price", raw),
				`slate: model router: ${label} has no usable input price for ${today} in its profile — ` +
					"keeping it, ordered last; its cost cannot be compared",
			);
		}

		// W1 staleness canary (D55): the registry is the authority; a divergence
		// says the PROFILE is stale, and the candidate keeps the registry number.
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
			once(
				conditionKey("w1", raw),
				`slate: model router: profile context window for ${label} (${profileWindow} tokens, asOf ` +
					`${quoted(profile.asOf ?? "unknown")}) diverges from pi's model registry (${registryWindow} tokens) — ` +
					"the registry wins; the profile is stale",
			);
		}

		// W3 unknown-data warning (D57): routable, but the decision is provisional.
		const unknownFields = Array.isArray(profile.unknownRoutingCriticalFields)
			? profile.unknownRoutingCriticalFields.filter((f) => typeof f === "string" && f !== "")
			: [];
		if (unknownFields.length > 0) {
			once(
				conditionKey("w3", raw),
				`slate: model router: ${label} has unknown routing-critical data — ` +
					`${unknownFields.map((f) => sanitizeForNotify(f, 80)).join("; ")} — routing decisions for it are provisional`,
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
			once(
				conditionKey("ladder", raw),
				`slate: model router: ${label} has no usable effort ladder in its profile — ` +
					"keeping it, but every explicit effort level for it will read as off-ladder",
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
	if (candidates.length === 0) {
		once(
			"all-dropped",
			`slate: model router: routing is disabled — none of the ${models.length} configured router.models ` +
				"entries survived validation (see the warnings above)",
		);
		return frozenResolution(false, [], undefined, false, warnings);
	}

	// CQ3: ONE aggregate line for failover coverage. Per-candidate notices here
	// scaled with the list length (a nine-model list produced nine of them), and
	// the actionable fact is the set, not each member.
	const uncovered = candidates.filter((c) => !c.hasFailover).map((c) => sanitizeForNotify(c.spec, 60));
	if (uncovered.length > 0) {
		once(
			"failover-coverage",
			`slate: model router: no modelFailover entry for ${uncovered.join(", ")} — ` +
				"a model failure while routed there has no failover coverage",
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
	// Scanned over the ALREADY-ORDERED list with a strict <, so a price tie
	// resolves to the lower tier and then the earlier spec, and an all-unpriced
	// list still yields a defined base model. If nothing is preferred, D48 still
	// needs a base model (a dispatch that omits a model must never be rejected by
	// the list guard), so the cheapest overall is taken — loudly.
	const preferred = candidates.filter((c) => c.nonPreferred === null);
	const pool = preferred.length > 0 ? preferred : candidates;
	let cheapest = pool[0];
	for (const c of pool) if (price(c) < price(cheapest)) cheapest = c;
	const cheapestNonPreferred = cheapest.nonPreferred !== null;
	if (cheapestNonPreferred) {
		once(
			"nonpreferred-base",
			`slate: model router: every configured model is marked non-preferred, so ${sanitizeForNotify(cheapest.spec, 60)} ` +
				`is the default base model anyway — ${sanitizeForNotify(cheapest.nonPreferred ?? "", 120)}`,
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
 * With the router OFF every pair is `ok`: the list guard is inert exactly as it
 * was before the router existed. An omitted/empty effort is also `ok` — the
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
 * failing is not a reason to keep re-running it every turn, and OFF is the
 * pre-router behaviour, so dispatch keeps working. There is deliberately NO
 * second message-level dedup layer — it made the real dedup untestable (CQ4)
 * while adding nothing the memo does not already guarantee.
 *
 * CQ7: what is frozen includes the registry and auth SNAPSHOT. A key added to
 * pi mid-session does not revive a model dropped as unauthenticated until the
 * next session_start.
 */
export function createModelRouterResolver(
	getInput: () => ModelRouterInput,
	warn: (msg: string) => void = () => {},
): () => ModelRouterResolution {
	let cached: ModelRouterResolution | undefined;
	return () => {
		if (cached === undefined) {
			try {
				cached = resolveModelRouter(getInput(), warn);
			} catch (error) {
				const message = `slate: model router: routing is disabled — resolution failed: ${sanitizeForNotify(
					error instanceof Error ? error.message : String(error),
				)}`;
				try {
					warn(message);
				} catch {
					/* see BG3 above */
				}
				cached = frozenResolution(false, [], undefined, false, [message]);
			}
		}
		return cached;
	};
}
