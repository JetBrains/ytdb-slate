/**
 * Static capability profiles for action-level model routing.
 *
 * The table contains identifiers, aliases, effort evidence, context cross-check
 * values, tiers, guidance, hazards, and cache-retention evidence. It contains no
 * price schedule. Runtime prices come only from the exact provider-qualified pi
 * registry entry selected during candidate resolution.
 *
 * Values come from the repository research corpus unless their own field or
 * comment marks a registry spelling, derivation, or assumption. Trace tags name
 * corpus rows. The corpus does not ship in the package, so model-visible text
 * strips those tags. A missing routing fact is recorded in
 * `unknownRoutingCriticalFields` rather than guessed.
 *
 * Context-window and maximum-output values are documentation-only. Pi's registry
 * remains the runtime context-window authority. Tier is retained for display and
 * advice only. Candidate resolution never sorts or selects by tier. An unsourced
 * tier carries `tierUnsourced`, and the doctrine names that state in words.
 * Evidence gaps remain advisory unless `router.allowUnmeasuredEffort` is false.
 * Provider-unsupported requested controls remain hard dispatch errors before pi can omit or silently substitute them.
 */

/** Retained workflow tier. Candidate resolution does not sort on this value. */
export type ModelTier = 1 | 2 | 3 | 4;

/**
 * Pi effort levels from `research/digest-v6.md` Existing profile
 * transcription. No vendor spellings, and `med` never appears.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CacheRetentionMeasurement {
	/** Date of these live probes. */
	observedOn: string;
	/** Whether every gap used a cache key dedicated to that probe series. */
	dedicatedCacheKey?: true;
	warm: Array<{ afterSeconds: number; probes: number }>;
	cold: Array<{ afterSeconds: number; probes: number }>;
}

export interface CacheInvalidationEvidence {
	invalidates: true;
	evidence: "documented" | "measured" | "documented-and-measured";
	measuredOn?: string;
	changedFromEffort?: ThinkingLevel;
	changedToEffort?: ThinkingLevel;
	coldProbes?: number;
	warmControlProbes?: number;
}

export interface CacheRetention {
	documented: {
		retentionSeconds: number;
		meaning: "minimum" | "lifetime";
		defaultWhenOmitted?: true;
		refreshOnRead?: true;
		refreshOnReadAtNoCost?: true;
		clockStartsAtRequestStart?: true;
		source: string;
		retrieved: string;
	};
	measured?: CacheRetentionMeasurement;
	invalidatedBy: {
		modelChange: CacheInvalidationEvidence;
		reasoningEffortChange: CacheInvalidationEvidence;
	};
	/** Documented alternatives excluded from slate's retention model. */
	excluded?: string[];
}

export interface ModelProfile {
	/** canonical "provider/id" as pi resolves it */
	id: string;
	aliases: string[];
	/** Provider-documented cache lifetime plus dated local probes; absent or null where this pass established no retention policy. */
	cacheRetention?: CacheRetention | null;
	/** DOCUMENTATION-ONLY, non-authoritative: pi's model registry is the runtime authority. Used only for the staleness cross-check. */
	contextWindow: number | null;
	/** Other published figure for the same window, where the digest records one: a cross-check must treat THIS value as a KNOWN divergence and not warn. Absent = none recorded. */
	contextWindowKnownDivergence?: number;
	/** DOCUMENTATION-ONLY, same caveat */
	maxOutput: number | null;
	tier: ModelTier;
	/** true when `tier` is NOT a sourced ordinal: the digest assigns none (cheap tier) or places the model outside the ordering (terra's `t?`). A tier sort must not read it as a ranking. */
	tierUnsourced?: true;
	/** true when `ladderFor()` returns an assumed provider-family ladder rather than a traced pi mapping */
	ladderAssumed?: true;
	/** requested controls Slate must reject before pi can omit or silently substitute them; hard, unlike `evidenceGapAt` */
	apiRejectedLevels?: ThinkingLevel[];
	/** short task classes to route here for */
	routeFor: string;
	/** short task classes to avoid here */
	avoidFor: string;
	/** routing-relevant hazards, each a short clause */
	hazards: string[];
	/** effort levels with a traced capability measurement, per digest-v6's predicate */
	capabilityMeasuredAt: ThinkingLevel[];
	/** ADVISORY evidence gaps, NOT a prohibition: dispatch warns, it does not refuse */
	evidenceGapAt: ThinkingLevel[];
	unknownRoutingCriticalFields: string[];
	/** the single strongest evidence sentence for this tier placement, <=200 chars */
	evidence: string;
	/** ISO date of the research behind this profile */
	asOf: string;
}

/** Date of the research behind every profile below (`research/digest-v6.md`). */
export const PROFILES_AS_OF = "2026-09-11";

/**
 * Freeze the data all the way down. The array and every row/list inside it are
 * shared by every consumer, so one caller's stray `.push` on a `hazards` list
 * would corrupt what everybody else reads (the discipline worker-extensions.ts
 * applies to its shared empty set, CQ22).
 */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) deepFreeze(inner);
	}
	return value;
}

const OPENAI_GPT_5_6_CACHE_RETENTION = {
	documented: {
		retentionSeconds: 1800,
		meaning: "minimum",
		defaultWhenOmitted: true,
		source: "https://platform.openai.com/docs/guides/prompt-caching",
		retrieved: "2026-09-11",
	},
	invalidatedBy: {
		modelChange: { invalidates: true, evidence: "documented" },
		reasoningEffortChange: {
			invalidates: true,
			evidence: "measured",
			measuredOn: "2026-08-06",
			changedFromEffort: "low",
			changedToEffort: "high",
			coldProbes: 3,
			warmControlProbes: 3,
		},
	},
	excluded: ["OpenAI configuration_update can preserve cache, but Slate does not emit it or keep top-level effort unchanged."],
} satisfies CacheRetention;

const ANTHROPIC_CACHE_RETENTION = {
	documented: {
		retentionSeconds: 300,
		meaning: "lifetime",
		refreshOnRead: true,
		refreshOnReadAtNoCost: true,
		clockStartsAtRequestStart: true,
		source: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
		retrieved: "2026-09-11",
	},
	invalidatedBy: {
		modelChange: { invalidates: true, evidence: "documented" },
		reasoningEffortChange: {
			invalidates: true,
			evidence: "documented-and-measured",
			measuredOn: "2026-08-06",
			changedFromEffort: "low",
			changedToEffort: "high",
			coldProbes: 3,
			warmControlProbes: 3,
		},
	},
	excluded: [
		"Paid one-hour retention is not modelled because Slate uses pi default short retention.",
		"Anthropic per-message effort can preserve cache on supported models, but Slate uses top-level effort switches.",
	],
} satisfies CacheRetention;

const PROFILES: ModelProfile[] = [
	{
		id: "openai/gpt-5.6-luna",
		aliases: [],
		cacheRetention: {
			...OPENAI_GPT_5_6_CACHE_RETENTION,
			measured: {
				observedOn: "2026-08-06",
				dedicatedCacheKey: true,
				warm: [
					{ afterSeconds: 180, probes: 3 },
					{ afterSeconds: 360, probes: 3 },
					{ afterSeconds: 571, probes: 3 },
					{ afterSeconds: 900, probes: 3 },
					{ afterSeconds: 1500, probes: 3 },
				],
				cold: [{ afterSeconds: 2100, probes: 3 }],
			},
		},
		contextWindow: 1050000,
		contextWindowKnownDivergence: 1000000,
		maxOutput: 128000,
		tier: 1,
		routeFor: "high-volume work; DeepSWE evidence is strongest @max",
		avoidFor: "deep retrieval and interactive work @max",
		hazards: [
			"DeepSWE pass@1 rises from 1.55% @low to 67.19% @max [O7]",
			"MRCR v2 8-needle is 41.3% in both 256K–512K and 512K–1M bands [O10]",
			"Prompt-cache hits are machine-local and load-sensitive [O3]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"],
		evidenceGapAt: ["off"],
		unknownRoutingCriticalFields: ["capability at off — the current AA value is labelled as an estimate, not a measured result [O8]"],
		evidence: "DeepSWE measures 1.55/11.28/44.25/56.86/67.19% from low through max; published run intervals separate max from xhigh [O7].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "anthropic/claude-sonnet-5",
		aliases: [],
		cacheRetention: {
			...ANTHROPIC_CACHE_RETENTION,
			measured: {
				observedOn: "2026-08-06",
				warm: [{ afterSeconds: 120, probes: 2 }, { afterSeconds: 300, probes: 2 }],
				cold: [{ afterSeconds: 480, probes: 2 }],
			},
		},
		contextWindow: 1000000,
		maxOutput: 128000,
		tier: 2,
		routeFor: "use @high when its measured strengths fit",
		avoidFor: "work a configured cheaper model can clear",
		hazards: [
			"pi off sends disabled thinking and is accepted; enabled manual thinking remains unsupported [A2]",
			"DeepSWE now measures low through max, with 30.51% @low and 53.85% @max [A6]",
			"The current vendor rate page retained the earlier rate instead of the announced future increase [A1]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"],
		evidenceGapAt: ["off", "minimal"],
		unknownRoutingCriticalFields: ["capability at off and minimal — no exact-effort numerical quality result [A6, A7]"],
		evidence: "DeepSWE measures every provider effort from low through max; @high is 48.23% under the Anthropic deployment [A6].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "openai/gpt-5.6-terra",
		aliases: [],
		cacheRetention: { ...OPENAI_GPT_5_6_CACHE_RETENTION },
		contextWindow: 1050000,
		contextWindowKnownDivergence: 1000000,
		maxOutput: 128000,
		tier: 2,
		tierUnsourced: true,
		routeFor: "configured-only; justify the model and effort directly",
		avoidFor: "default use; no refreshed source establishes a unique niche",
		hazards: [
			"DeepSWE pass@1 rises from 24.05% @low to 69.62% @max [O7]",
			"No refreshed common method supports an ordinal tier [O7, O8]",
			"Prompt-cache hits are machine-local and load-sensitive [O3]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"],
		evidenceGapAt: ["off"],
		unknownRoutingCriticalFields: ["capability at off — the current AA value is labelled as an estimate [O8]"],
		evidence: "DeepSWE measures 24.05/35.11/53.76/60.18/69.62% from low through max; no source proves a unique routing niche [O7, O8].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "openai/gpt-5.6-sol",
		aliases: ["openai/gpt-5.6", "gpt-5.6"],
		cacheRetention: {
			...OPENAI_GPT_5_6_CACHE_RETENTION,
			measured: {
				observedOn: "2026-08-06",
				dedicatedCacheKey: true,
				warm: [{ afterSeconds: 571, probes: 5 }, { afterSeconds: 1500, probes: 3 }],
				cold: [],
			},
		},
		contextWindow: 1050000,
		contextWindowKnownDivergence: 1000000,
		maxOutput: 128000,
		tier: 3,
		routeFor: "agentic coding @high; high overlaps max on DeepSWE",
		avoidFor: "highest-effort work without supervision and output checks",
		hazards: [
			"Sol exceeded user intent more often at the highest efforts in vendor coding simulations [O6]",
			"METR reports its highest detected cheating rate but no robust exact rate [O9]",
			"DeepSWE mean observed cost is descriptive, not expected retry cost or runtime pricing [O7]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"],
		evidenceGapAt: ["off"],
		unknownRoutingCriticalFields: ["capability at off and the exact METR cheating rate [O8, O9]"],
		evidence: "DeepSWE measures 45.35/61.06/69.40/70.73/72.67% from low through max; @high is the cheapest interval overlapping max [O7].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "anthropic/claude-opus-5",
		aliases: [],
		cacheRetention: { ...ANTHROPIC_CACHE_RETENTION },
		contextWindow: 1000000,
		maxOutput: 128000,
		tier: 3,
		routeFor: "architecture and difficult repository work @high",
		avoidFor: "@max when overlapping lower-effort evidence is enough",
		hazards: [
			"DeepSWE used Vertex AI rather than the direct Anthropic deployment [A6]",
			"Vals results include an Opus 4.8 refusal fallback [A9]",
			"Per-message effort can preserve cache, but Slate does not emit that request form [A2, A3]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"],
		evidenceGapAt: ["off", "minimal"],
		unknownRoutingCriticalFields: ["capability at off and minimal — no exact-effort numerical quality result [A6, A7]"],
		evidence: "Vertex DeepSWE measures 58.13/68.90/72.83/73.15/73.65% from low through max; higher intervals overlap @high [A6].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "anthropic/claude-fable-5",
		aliases: [],
		cacheRetention: { ...ANTHROPIC_CACHE_RETENTION },
		contextWindow: 1000000,
		maxOutput: 128000,
		tier: 4,
		routeFor: "use only after a directly justified comparison",
		avoidFor: "ZDR-required without confirmed express authorization and configuration (REFUSE); default use",
		hazards: [
			"Covered Model status requires at least 30-day retention unless expressly authorized [A4]",
			"The model is active legacy and has a named successor [A1]",
			"DeepSWE used Vertex AI; Vals and AA results include an Opus 4.8 fallback [A6, A9, A10]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"],
		evidenceGapAt: ["minimal"],
		unknownRoutingCriticalFields: ["capability at minimal and the fallback share in the named Vals and AA results [A9, A10]"],
		evidence: "Vertex DeepSWE measures 59.58/65.37/68.60/69.91/69.72% from low through max; Fable remains a Covered Model [A4, A6].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "openai/gpt-5.4-nano",
		aliases: ["openai/gpt-5.4-nano-2026-03-17", "gpt-5.4-nano-2026-03-17", "gpt-5.4-nano"],
		cacheRetention: null,
		contextWindow: 400000,
		maxOutput: 128000,
		tier: 1,
		tierUnsourced: true,
		routeFor: "explicit-scope-only work @xhigh",
		avoidFor: "deep retrieval, computer use, and tool search",
		hazards: [
			"Vendor MRCR falls to 33.1% in the 128K–256K band even @xhigh [O5]",
			"Pi 0.83 clamps minimal to low and max to xhigh [G]",
			"DeepSWE has no exact row for this model [G]",
		],
		capabilityMeasuredAt: ["xhigh"],
		evidenceGapAt: ["off", "low", "medium", "high"],
		unknownRoutingCriticalFields: ["model-specific cache lifetime and capability below xhigh [O3, O8]"],
		evidence: "OpenAI reports 52.4% SWE-Bench Pro @xhigh. Lower AA rows are labelled estimates, and DeepSWE has no row [O5, O8, G].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "openai/gpt-5.4-mini",
		aliases: ["openai/gpt-5.4-mini-2026-03-17", "gpt-5.4-mini-2026-03-17", "gpt-5.4-mini"],
		cacheRetention: null,
		contextWindow: 400000,
		maxOutput: 128000,
		tier: 1,
		tierUnsourced: true,
		routeFor: "explicit-scope-only work @xhigh",
		avoidFor: "deep retrieval and unevidenced lower controls",
		hazards: [
			"Vendor MRCR falls to 33.6% in the 128K–256K band even @xhigh [O5]",
			"Pi 0.83 clamps minimal to low and max to xhigh [G]",
			"DeepSWE has no exact row for this model [G]",
		],
		capabilityMeasuredAt: ["xhigh"],
		evidenceGapAt: ["off", "low", "medium", "high"],
		unknownRoutingCriticalFields: ["model-specific cache lifetime and capability below xhigh [O3, O8]"],
		evidence: "OpenAI reports 54.4% SWE-Bench Pro @xhigh. Lower AA rows are labelled estimates, and DeepSWE has no row [O5, O8, G].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "anthropic/claude-haiku-4-5",
		aliases: ["anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"],
		cacheRetention: { ...ANTHROPIC_CACHE_RETENTION },
		contextWindow: 200000,
		maxOutput: 64000,
		tier: 1,
		tierUnsourced: true,
		routeFor: "explicit-scope-only work with an acknowledged evidence gap",
		avoidFor: "long threads and any claim of exact-effort quality",
		hazards: [
			"Pi 0.83 maps minimal through high to distinct manual thinking budgets [G]",
			"xhigh and max clamp to high and are not distinct controls [G]",
			"DeepSWE and current AA have no row; the Vals Thinking row has no exact pi budget [A6, A9]",
		],
		capabilityMeasuredAt: [],
		evidenceGapAt: ["off", "minimal", "low", "medium", "high"],
		unknownRoutingCriticalFields: ["capability at every distinct pi budget control [A6]"],
		evidence: "Pi provides five distinct disabled or budget controls, but no refreshed source supplies an exact-effort numerical quality result [A2, A6].",
		asOf: PROFILES_AS_OF,
	},
];

/**
 * Static routing profiles in `research/digest-v6.md` Existing profile
 * transcription order. Unsourced tier placeholders remain explicit.
 */
export const MODEL_PROFILES: readonly ModelProfile[] = deepFreeze(PROFILES);

/**
 * Lookup index, built on first use: every canonical id and every alias, all
 * lower-cased. First writer wins, so a canonical id can never be shadowed by
 * another model's alias.
 */
let bySpec: Map<string, ModelProfile> | undefined;

/** Case-insensitive lookup by canonical id or alias; undefined when unprofiled. */
export function findProfile(spec: string): ModelProfile | undefined {
	// The declared type is a runtime lie: specs come from user-edited config and
	// from model strings pi hands us, so a non-string reaches this in practice.
	if (typeof spec !== "string") return undefined;
	const key = spec.trim().toLowerCase();
	if (!key) return undefined;
	if (!bySpec) {
		bySpec = new Map();
		for (const profile of MODEL_PROFILES) {
			bySpec.set(profile.id.toLowerCase(), profile);
			for (const alias of profile.aliases) {
				const aliasKey = alias.trim().toLowerCase();
				if (aliasKey && !bySpec.has(aliasKey)) bySpec.set(aliasKey, profile);
			}
		}
	}
	return bySpec.get(key);
}

// Ladder shapes from `research/digest-v6.md` Existing profile transcription.
// Pi's `off`/`minimal` are dispatch levels beyond the five provider effort
// labels. No source measures either for any model.
// NO minimal [contract, O2]
const OPENAI_GPT_5_6_LADDER: readonly ThinkingLevel[] = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"] as const);
const OPENAI_GPT_5_4_SMALL_LADDER: readonly ThinkingLevel[] = Object.freeze(["off", "low", "medium", "high", "xhigh"] as const);
// all seven [contract, A2]
const ANTHROPIC_FULL_LADDER: readonly ThinkingLevel[] = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
// NO off — thinking always on [contract, A2]
const ANTHROPIC_THINKING_ALWAYS_ON_LADDER: readonly ThinkingLevel[] = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"] as const);
const HAIKU_BUDGET_LADDER: readonly ThinkingLevel[] = Object.freeze(["off", "minimal", "low", "medium", "high"] as const);

/**
 * Per-id ladders rather than a prefix rule: Fable has no `off`, Haiku uses
 * manual thinking budgets, and the small OpenAI models clamp two wider labels.
 * Each entry is stated explicitly from the pinned pi 0.83 mapping.
 *
 * A MAP, not an object literal (review finding CQ6): an object lookup keyed by
 * a caller-supplied id answers for `Object.prototype` property names too, so an
 * id of "constructor" or "toString" would have returned a FUNCTION where a
 * ladder belongs — the accessor's contract broken by the table's own prototype.
 * Map.get answers only for keys actually inserted.
 */
const LADDER_BY_ID: ReadonlyMap<string, readonly ThinkingLevel[]> = new Map<string, readonly ThinkingLevel[]>([
	["openai/gpt-5.6-sol", OPENAI_GPT_5_6_LADDER],
	["openai/gpt-5.6-terra", OPENAI_GPT_5_6_LADDER],
	["openai/gpt-5.6-luna", OPENAI_GPT_5_6_LADDER],
	["anthropic/claude-sonnet-5", ANTHROPIC_FULL_LADDER],
	["anthropic/claude-opus-5", ANTHROPIC_FULL_LADDER],
	["anthropic/claude-fable-5", ANTHROPIC_THINKING_ALWAYS_ON_LADDER],
	["openai/gpt-5.4-nano", OPENAI_GPT_5_4_SMALL_LADDER],
	["openai/gpt-5.4-mini", OPENAI_GPT_5_4_SMALL_LADDER],
	["anthropic/claude-haiku-4-5", HAIKU_BUDGET_LADDER],
]);

/**
 * The pi thinking-level ladder traced under `research/digest-v6.md` Existing
 * profile transcription. Every profiled id has an entry. An unprofiled
 * ModelProfile handed in from outside falls back to the widest ladder, which
 * warns-but-dispatches rather than
 * blocking a level the model may well accept.
 *
 * The answer is traced for every shipped profile. A requested control may still
 * be rejected before pi silently substitutes it. See `apiRejectedLevels`.
 *
 * ALWAYS a frozen array of ThinkingLevel, for every possible `id` — including
 * prototype property names such as "constructor" or "__proto__", which the
 * previous object-literal table answered with a function or an object (CQ6).
 */
export function ladderFor(profile: ModelProfile): readonly ThinkingLevel[] {
	return LADDER_BY_ID.get(profile.id) ?? ANTHROPIC_FULL_LADDER;
}
