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
 *    never be rejected by the list guard.
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
 *  - EVIDENCE GAPS ARE ADVISORY. `checkEffort` reports a ladder-valid level with
 *    no capability evidence as `evidence-gap`; it is the caller (the dispatch
 *    path, Track 02, gated by `router.allowUnmeasuredEffort`, default true) that
 *    decides what to do with that. This module never refuses anything.
 *
 *  - EVERY WARNING AT MOST ONCE PER SESSION (D58), sanitized through the shared
 *    sanitizeForNotify before display, exactly like the other sanitizers: config
 *    values and profile fields are user-editable text that reaches ctx.ui.notify.
 *    Warnings are BOTH pushed to the sink and collected on the result.
 *
 *  - FROZEN AT FIRST USE: createModelRouterResolver memoizes the first
 *    resolution for the session, the way createWorkerExtensionResolver does — a
 *    dispatch guard and a doctrine section built from two different resolutions
 *    of the same session would be a bug, and repeated consultation must not
 *    re-emit warnings.
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
import type { RouterConfig } from "./state.ts";

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
	tier: ModelTier;
	inUsdPerMTok: number | undefined; // current effective input price (undefined = no covering price row)
	outUsdPerMTok: number | undefined; // current effective output price
	contextWindow: number | undefined; // REGISTRY value — never the profile's (D55)
	ladder: readonly ThinkingLevel[]; // ladderFor(profile), captured at resolution so checkEffort needs no injection
	hasFailover: boolean; // present as a key in the configured modelFailover map
}

/** The resolution: the router's whole answer for a session. */
export interface ModelRouterResolution {
	on: boolean; // false = router off; candidates is then empty and nothing is gated
	candidates: readonly RouterCandidate[]; // tier asc, then effective input price asc, then spec
	cheapest: string | undefined; // cheapest candidate's spec — a new thread's default base model (D48)
	warnings: readonly string[]; // every warning emitted for this resolution, in order
}

/** The off state with no warnings — the default, shared and deep-frozen (CQ22). */
export const ROUTER_OFF: ModelRouterResolution = Object.freeze({
	on: false,
	candidates: Object.freeze([]),
	cheapest: undefined,
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
 *   ok           — listed model, ladder-valid level, capability evidence exists
 *   not-listed   — the model is not in the effective list (or was dropped)
 *   off-ladder   — the model is listed but does not offer that effort level
 *   evidence-gap — ladder-valid, but no traced capability result at that level
 *                  (ADVISORY — the profile's evidenceGapAt is a marker, never a
 *                  prohibition; the caller decides)
 */
export type EffortVerdict = "ok" | "not-listed" | "off-ladder" | "evidence-gap";

export interface EffortCheck {
	verdict: EffortVerdict;
	spec: string;
	effort: string;
	ladder: readonly ThinkingLevel[]; // [] when not-listed
	measured: boolean; // the level appears in the profile's capabilityMeasuredAt
}

/** "provider/id": one slash at index > 0 with a non-empty id after it (failover.ts's rule). */
function isModelSpec(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

/** Today as "YYYY-MM-DD" (UTC) — only used as the default of the injected date. */
function utcToday(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Defensive read of a numeric profile/registry field: a finite number, or undefined. */
function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Display form of a rejected config value. JSON.stringify returns `undefined`
 * (the value, not the string) for undefined and functions, which would make
 * sanitizeForNotify throw — so fall back to String().
 */
function quoted(value: unknown): string {
	return sanitizeForNotify(JSON.stringify(value) ?? String(value));
}

/** Defensive membership test over a profile's effort-level list (a malformed table may hold a non-array). */
function listHas(list: unknown, level: string): boolean {
	return Array.isArray(list) && list.includes(level);
}

/**
 * The price row in force on `today`.
 *
 * A row applies when `from` is null/absent or ≤ today AND `until` is
 * null/absent or ≥ today. Among applicable rows the one with the greatest
 * `from` wins (the most recently effective schedule); ties — including the
 * common all-null case — resolve to the FIRST such row in authoring order, so
 * the table's own ordering decides and the result is stable. With no applicable
 * row at all the most recent PAST row is used as the best available figure, and
 * failing that the first row; an empty/garbage schedule yields undefined, which
 * the ordering treats as "unknown, sort last" and warns about.
 */
export function effectivePriceRow(profile: ModelProfile, today: string): PriceRow | undefined {
	const rows = Array.isArray(profile.price) ? profile.price.filter((r): r is PriceRow => !!r && typeof r === "object") : [];
	if (rows.length === 0) return undefined;
	const from = (r: PriceRow) => (typeof r.from === "string" ? r.from : "");
	const applicable = rows.filter((r) => {
		const lo = typeof r.from === "string" ? r.from : null;
		const hi = typeof r.until === "string" ? r.until : null;
		return (lo === null || lo <= today) && (hi === null || hi >= today);
	});
	const pick = (pool: PriceRow[]) => pool.reduce((best, r) => (from(r) > from(best) ? r : best), pool[0]);
	if (applicable.length > 0) return pick(applicable);
	const past = rows.filter((r) => from(r) <= today);
	return past.length > 0 ? pick(past) : rows[0];
}

/**
 * Validate the raw `router` config value (D4/D53). undefined → the defaults
 * ({ models: [], allowUnmeasuredEffort: true }) silently: the router is off by
 * default. A wrong-shape value warns once and falls back to those defaults;
 * individually invalid `models` entries are dropped with a per-entry warning.
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

	const models: string[] = [];
	if (value.models !== undefined) {
		if (!Array.isArray(value.models)) {
			warn('slate: router.models must be an array of "provider/id" strings — ignoring it (the router stays off)');
		} else {
			for (const entry of value.models) {
				if (!isModelSpec(entry)) {
					warn(`slate: ignoring router.models entry ${quoted(entry)} — expected a "provider/id" model spec`);
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

/**
 * Resolve the routable candidate set.
 *
 * An empty model list returns ROUTER_OFF WITHOUT touching the registry or the
 * profile table — the fast path, since the router is off by default and that
 * path must stay behaviourally identical to the pre-router extension. Every
 * warning is emitted at most once per condition (D58), sanitized, through
 * `warn` (default no-op) and collected on the result.
 */
export function resolveModelRouter(input: ModelRouterInput, warn: (msg: string) => void = () => {}): ModelRouterResolution {
	const models = input.models ?? [];
	if (models.length === 0) return ROUTER_OFF;

	const profiles = input.profiles ?? SHIPPED_PROFILE_SOURCE;
	const failover = input.failover ?? {};
	const today = input.today ?? utcToday();

	// D58: one warning per condition per resolution. The key, not the text, is
	// what identifies a condition, so a reworded message cannot start repeating.
	const emitted = new Set<string>();
	const warnings: string[] = [];
	const once = (key: string, message: string) => {
		if (emitted.has(key)) return;
		emitted.add(key);
		warnings.push(message);
		warn(message);
	};

	const candidates: RouterCandidate[] = [];
	const seenSpecs = new Set<string>();
	for (const raw of models) {
		// Malformed specs are already dropped by sanitizeRouterConfig; re-checked
		// here because this function is also called with raw/fabricated input.
		if (!isModelSpec(raw)) {
			once(
				`malformed:${String(raw)}`,
				`slate: model router: ${quoted(raw)} is not a canonical "provider/id" model spec — dropping it`,
			);
			continue;
		}
		if (seenSpecs.has(raw)) continue; // duplicate listing — first wins, silently
		seenSpecs.add(raw);
		const label = sanitizeForNotify(raw);

		const profile = profiles.findProfile(raw);
		if (!profile) {
			once(
				`unprofiled:${raw}`,
				`slate: model router: ${label} has no benchmark data in slate's model profiles — excluding it from routing`,
			);
			continue;
		}

		const slash = raw.indexOf("/");
		const provider = raw.slice(0, slash);
		const id = raw.slice(slash + 1);
		let model: RouterRegistryModel | undefined;
		try {
			model = input.registry.find(provider, id);
		} catch {
			model = undefined; // a throwing registry is a missing model, not a crash
		}
		if (!model) {
			once(
				`unknown:${raw}`,
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
				`noauth:${raw}`,
				`slate: model router: ${label} has no usable credentials configured in pi — dropping it (routing there could only produce billed failures)`,
			);
			continue;
		}

		const row = effectivePriceRow(profile, today);
		const inUsdPerMTok = row ? finite(row.inUsdPerMTok) : undefined;
		const outUsdPerMTok = row ? finite(row.outUsdPerMTok) : undefined;
		if (inUsdPerMTok === undefined) {
			once(
				`price:${raw}`,
				`slate: model router: ${label} has no usable input price for ${sanitizeForNotify(today)} in its profile — ` +
					"keeping it, ordered last; its cost cannot be compared",
			);
		}

		// W1 staleness canary (D55): the registry is the authority; a divergence
		// says the PROFILE is stale, and the candidate keeps the registry number.
		const registryWindow = finite(model.contextWindow);
		const profileWindow = finite(profile.contextWindow ?? undefined);
		if (registryWindow !== undefined && profileWindow !== undefined && registryWindow !== profileWindow) {
			once(
				`w1:${raw}`,
				`slate: model router: profile context window for ${label} (${profileWindow} tokens, asOf ` +
					`${sanitizeForNotify(String(profile.asOf ?? "unknown"))}) diverges from pi's model registry (${registryWindow} tokens) — ` +
					"the registry wins; the profile is stale",
			);
		}

		// W3 unknown-data warning (D57): routable, but the decision is provisional.
		const unknownFields = Array.isArray(profile.unknownRoutingCriticalFields)
			? profile.unknownRoutingCriticalFields.filter((f) => typeof f === "string" && f !== "")
			: [];
		if (unknownFields.length > 0) {
			once(
				`w3:${raw}`,
				`slate: model router: ${label} has unknown routing-critical data — ` +
					`${unknownFields.map((f) => sanitizeForNotify(f, 80)).join("; ")} — routing decisions for it are provisional`,
			);
		}

		const hasFailover = Object.prototype.hasOwnProperty.call(failover, raw) && isModelSpec(failover[raw]);
		if (!hasFailover) {
			once(
				`failover:${raw}`,
				`slate: model router: ${label} has no modelFailover entry — a model failure while routed there has no failover coverage`,
			);
		}

		const ladder = profiles.ladderFor(profile);
		candidates.push({
			spec: raw,
			provider,
			id,
			profile,
			tier: profile.tier,
			inUsdPerMTok,
			outUsdPerMTok,
			contextWindow: registryWindow,
			ladder: Array.isArray(ladder) ? Object.freeze([...ladder]) : Object.freeze([]),
			hasFailover,
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
		return Object.freeze({
			on: false,
			candidates: Object.freeze([]),
			cheapest: undefined,
			warnings: Object.freeze([...warnings]),
		}) as unknown as ModelRouterResolution;
	}

	// Order: tier asc, then current effective input price asc, then spec — the
	// last key only so the order is total and reproducible.
	const price = (c: RouterCandidate) => c.inUsdPerMTok ?? Number.POSITIVE_INFINITY;
	candidates.sort((a, b) => a.tier - b.tier || price(a) - price(b) || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));

	// D48: the cheapest candidate is a new thread's default base model. Scanned
	// over the ALREADY-ORDERED list with a strict <, so a price tie resolves to
	// the lower tier and then the earlier spec, and an all-unpriced list still
	// yields a defined base model.
	let cheapest = candidates[0];
	for (const c of candidates) if (price(c) < price(cheapest)) cheapest = c;

	return Object.freeze({
		on: true,
		candidates: Object.freeze([...candidates]),
		cheapest: cheapest.spec,
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
 */
export function checkEffort(
	resolution: ModelRouterResolution,
	spec: string,
	effort?: string,
): EffortCheck {
	const base: EffortCheck = { verdict: "ok", spec, effort: effort ?? "", ladder: [], measured: false };
	if (!resolution.on) return base;
	const candidate = resolution.candidates.find((c) => c.spec === spec);
	if (!candidate) return { ...base, verdict: "not-listed" };
	const ladder = candidate.ladder;
	if (effort === undefined || effort === "") return { ...base, ladder };
	const measured = listHas(candidate.profile.capabilityMeasuredAt, effort);
	if (!listHas(ladder, effort)) return { verdict: "off-ladder", spec, effort, ladder, measured };
	const gap = listHas(candidate.profile.evidenceGapAt, effort);
	return { verdict: gap ? "evidence-gap" : "ok", spec, effort, ladder, measured };
}

/**
 * Wrap resolveModelRouter so it runs at most ONCE per session, like
 * createWorkerExtensionResolver: the first call resolves and caches, every
 * later call returns that same frozen resolution — which is also what makes the
 * D58 "at most once per session" warning guarantee hold under repeated
 * consultation. `getInput` is read lazily at first use (after session_start, so
 * a provider registered by another extension during session_start is visible),
 * and the extra message-level dedup below covers a caller that resolves a
 * second time with its own input.
 */
export function createModelRouterResolver(
	getInput: () => ModelRouterInput,
	warn: (msg: string) => void = () => {},
): () => ModelRouterResolution {
	let cached: ModelRouterResolution | undefined;
	const said = new Set<string>();
	const once = (msg: string) => {
		if (said.has(msg)) return;
		said.add(msg);
		warn(msg);
	};
	return () => {
		if (cached === undefined) cached = resolveModelRouter(getInput(), once);
		return cached;
	};
}
