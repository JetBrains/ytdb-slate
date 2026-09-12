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
	/** reviewed routing evidence and task guidance shown in the live table */
	routeFor: string;
	/** reviewed cautions and refusal conditions shown in the live table */
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

const OPENAI_GPT_6_ASTRA_CACHE_RETENTION = {
	documented: {
		retentionSeconds: 1800,
		meaning: "minimum",
		defaultWhenOmitted: true,
		refreshOnRead: true,
		refreshOnReadAtNoCost: true,
		source: "https://developers.openai.com/api/docs/guides/prompt-caching",
		retrieved: "2026-09-11",
	},
	invalidatedBy: {
		modelChange: { invalidates: true, evidence: "documented" },
		reasoningEffortChange: { invalidates: true, evidence: "documented" },
	},
	excluded: ["OpenAI configuration_update can preserve a prefix, but Slate does not emit it."],
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
		routeFor: "Use for agentic repository coding at @max. DeepSWE v1.1 reports 67.19% scored-attempt pass rate. The dated mean benchmark cost is $0.61 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. Vendor guidance supports well-specified changes with explicit tests. Vals Code Migration reports 36.1% mean hidden-test pass rate across migrations. This result does not measure architecture or design quality. ARC-AGI-3 Standard reports 0.18% at @max under the RHAE method. This near-zero result is evidence against routing novel interactive reasoning for benchmark-shaped work.",
		avoidFor: "For DeepSWE-shaped repository coding, avoid lower efforts. The interval rule in the guide selected @max from the measured series. The mean DeepSWE duration was 1,123 seconds per complete benchmark task. It includes the benchmark harness, tools, host, and provider load. It is not response latency and does not establish ordinary interactive speed. Capabilities not listed are unknown, not prohibited.",
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
		routeFor: "Use for agentic repository coding at @high. DeepSWE v1.1 reports 48.23% scored-attempt pass rate. The dated mean benchmark cost is $7.43 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. Terminal-Bench 2.1 reports 74.53% task pass rate at @high over three runs in the Vals deployment. Every task needs all tests to pass. Vals Code Migration reports 36.3% mean hidden-test pass rate across migrations. ARC-AGI-3 has no verified result. Missing evidence is not zero or a routing prohibition.",
		avoidFor: "Do not raise coding effort to @xhigh or @max only to claim better quality. Their published DeepSWE 95% intervals overlap the @high interval. Under the exact rule, no clearly better nonoverlapping interval is shown. Overlap does not prove equal performance. This advice applies only to DeepSWE-shaped coding.",
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
		routeFor: "Use for agentic repository coding at @max. DeepSWE v1.1 reports 69.62% scored-attempt pass rate. The dated mean benchmark cost is $3.96 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. OpenAI MRCR v2 reports 89.6% mean approximate text-match credit in the 256K–512K token band and 72.5% in the 512K–1M token band. The source reports its best tested effort but does not identify that effort. Vals Code Migration reports 40.4% mean hidden-test pass rate across migrations. ARC-AGI-3 Standard reports 0.80% at @max under the RHAE method. This near-zero result is evidence against routing novel interactive reasoning for benchmark-shaped work. This is a nonpreferred route. Do not pick it by default. If a task uses it, state the work-specific reason in the task text under the existing doctrine rule. Do not add a tool argument or report field.",
		avoidFor: "For coding, lower efforts are not the selected setting under the interval rule. This coding rule does not establish the best effort for another task type. MRCR context bands do not establish active route capacity or uniform retrieval quality across every size in either band. Check the active Pi registry for current route capacity. Capabilities not listed are unknown, not prohibited.",
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
		routeFor: "Use for agentic repository coding at @high. DeepSWE v1.1 reports 69.40% scored-attempt pass rate. The dated mean benchmark cost is $2.66 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. OpenAI MRCR v2 reports 91.5% mean approximate text-match credit in the 256K–512K token band and 73.8% in the 512K–1M token band. The source reports its best tested effort but does not identify that effort. Vendor Terminal-Bench 2.1 reports 88.8% task pass rate. Vals Code Migration reports 47.2% mean hidden-test pass rate across migrations. ARC-AGI-3 Standard reports 7.78% at @max under the RHAE method. The low score and effort mismatch make it weak evidence for novel interactive reasoning.",
		avoidFor: "Do not raise coding effort to @xhigh or @max only to claim better quality. Their published DeepSWE 95% intervals overlap the @high interval. Under the exact rule, no clearly better nonoverlapping interval is shown. The interactive result uses @max under its own harness. It does not support the proposed @high coding setting or establish ordinary worker performance. MRCR does not establish active route capacity. Check the active Pi registry for current route capacity. Capabilities not listed are unknown, not prohibited.",
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
		routeFor: "Use for agentic repository coding at @high. DeepSWE v1.1 reports 72.83% scored-attempt pass rate. The dated mean benchmark cost is $6.08 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. Vals Code Migration reports 53.3% mean hidden-test pass rate across migrations with server-side fallback permitted. The fallback-assisted share is unknown. ARC-AGI-3 Standard reports 30.16% at @high under the RHAE method. OSWorld 2.0 reports 70.57% first-attempt success over five runs in a live 1080p Ubuntu environment with a 500-action limit. Keep that source unit and setup. This supports computer-interface work only within the stated setup.",
		avoidFor: "Do not raise coding effort to @xhigh or @max only to claim better quality. Their published DeepSWE 95% intervals overlap the @high interval. Under the exact rule, no clearly better nonoverlapping interval is shown. Use caution for factual recall at @max. AA-Omniscience reported a 50% hallucination rate on 2026-07-24. The dated source does not state its denominator. Do not impute the current denominator to that historical result.",
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
		id: "anthropic/claude-fable-5-1",
		aliases: [],
		cacheRetention: null,
		contextWindow: 1000000,
		maxOutput: 128000,
		tier: 4,
		tierUnsourced: true,
		apiRejectedLevels: ["off"],
		routeFor: "This row has no established agentic-coding effort. DeepSWE v1.1 has no result, interval, benchmark cost, or duration for this row. Provisional use is allowed with an explicit valid measured effort where policy requires one, normal result verification, and no claim of coding optimality or DeepSWE price. Vals Code Migration reports 57.10% mean hidden-test pass rate at @max with server-side fallback enabled. The fallback-assisted share is unknown. OSWorld 2.0 reports 77.9% partial score and 41.7% strict score on the August 2026 release. AA-LCR v1.1 reports 85% at @medium, 84% at @high, 83% at @xhigh, and 85% at @max on completed prompts averaging about 99K tokens. Fallback contribution is unknown. ARC-AGI-3 has no verified result. Missing evidence is not zero.",
		avoidFor: "Do not claim an evidence-based coding effort or DeepSWE cost. Do not treat @max on Code Migration or the AA-LCR effort labels as a general recommendation. AA-Omniscience at @max reports 67.2% accuracy, a 93.4% attempt rate, and a 72.6% hallucination rate among questions not answered correctly. Preserve that exact denominator label. Zero Data Retention work without account-owner confirmation of express model-specific authorization and the required provider and account configuration under the governing agreement (REFUSE). Use the project's established authorization record. A general agreement, model availability, or successful request does not provide automatic approval.",
		hazards: [
			"Covered Model status requires at least 30-day retention unless expressly authorized [A4]",
			"DeepSWE has no Fable 5.1 result, cost, interval, or duration [A6]",
			"Vals and Artificial Analysis results include server-side fallback [A9, A10]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"],
		evidenceGapAt: ["minimal"],
		unknownRoutingCriticalFields: [
			"capability at minimal and the fallback share in named Vals and Artificial Analysis results [A9, A10]",
			"model-specific cache retention and invalidation under Slate top-level effort switches [A3]",
		],
		evidence: "AA-LCR v1.1 and AutomationBench-AA measure low through max with fallback enabled; DeepSWE has no Fable 5.1 row [A6, A10].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "google-vertex/gemini-3.8-flash",
		aliases: ["google/gemini-3.8-flash", "opencode/gemini-3.8-flash", "openrouter/google/gemini-3.8-flash"],
		cacheRetention: null,
		contextWindow: 1048576,
		maxOutput: 65536,
		tier: 2,
		tierUnsourced: true,
		apiRejectedLevels: ["off", "minimal"],
		routeFor: "Use for agentic repository coding at @medium. DeepSWE v1.1 reports 71.02% scored-attempt pass rate. The dated mean benchmark cost is $1.97 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. Terminal-Bench 2.1 reports 90.8% task pass rate in Google Vertex documentation and 89.4% in the Google DeepMind model card. Neither source states a tested effort. The difference is unresolved, so preserve both figures. AutomationBench-AA v1.0.6 reports a 61% score at @medium across 657 simulated software-as-a-service workflows after tools were available. The headline score penalizes guardrail violations. Its exact penalty formula is unpublished. AA-LCR v1.1 reports 84% at @medium on prompts averaging about 99K tokens. Vals Code Migration reports 25.9% mean hidden-test pass rate across migrations. ARC-AGI-3 has no verified result. Missing evidence is not zero.",
		avoidFor: "Do not raise coding effort to @high only to claim better quality. The tested DeepSWE @high interval overlaps the @medium interval. Under the exact rule, no clearly better nonoverlapping interval is shown. AA-LCR does not establish retrieval quality for substantially larger contexts or a precise boundary near 100K. The benchmark publications do not establish deployment support, discovery, or selection of an unknown tool. Check the active deployment and tool configuration separately. Vertex measurements do not establish cache, privacy, adapter, or measured-effort behavior on alias routes.",
		hazards: [
			"Artificial Analysis uses mixed component methods, not one composite harness [G]",
			"DeepSWE measurements use Vertex AI and do not establish alias-route capability [G]",
			"Alias routes do not share cache, privacy, wire-format, or rate contracts [G]",
		],
		capabilityMeasuredAt: ["low", "medium", "high"],
		evidenceGapAt: [],
		unknownRoutingCriticalFields: [
			"provider-specific implicit cache behavior across approved routes [G]",
			"provider-specific privacy handling across approved routes [G]",
		],
		evidence: "Artificial Analysis v4.3 measures 34/40/41 from low through high; DeepSWE Vertex AI measures medium and high [G].",
		asOf: PROFILES_AS_OF,
	},
	{
		id: "openai/gpt-6-astra",
		aliases: [],
		cacheRetention: { ...OPENAI_GPT_6_ASTRA_CACHE_RETENTION },
		contextWindow: 1050000,
		contextWindowKnownDivergence: 272000,
		maxOutput: 128000,
		tier: 4,
		tierUnsourced: true,
		apiRejectedLevels: ["off", "minimal"],
		routeFor: "Use for agentic repository coding at @medium. DeepSWE v1.1 reports 72.79% scored-attempt pass rate. The dated mean benchmark cost is $4.38 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. OpenAI MRCR v2 reports 100% mean approximate text-match credit in the 256K–512K token band and 96.3% in the 512K–1M token band. The source reports its best tested effort but does not identify that effort. OSWorld 2.0 reports 72.6% partial score. AutomationBench-AA reports a 68% score at @max. The @max label records that tested capability setting, not the coding recommendation. Vals Code Migration reports 67.5% mean hidden-test pass rate across migrations. ARC-AGI-3 Standard reports 62.71% at @max through the ordinary ARC interface. A separate Provider Adapter evaluation reports 99.95% at @high through a special provider-specific integration. The adapter preserves provider state and compaction. Keep the two evaluations separate. The adapter is not a normal Slate route.",
		avoidFor: "Do not raise coding effort to @high, @xhigh, or @max only to claim better quality. Their published DeepSWE 95% intervals overlap the @medium interval. Under the exact rule, no clearly better nonoverlapping interval is shown. The computer and tool scores retain their measured setup and effort. Neither interactive result came from the Slate worker harness. Keep the Provider Adapter result separate from ordinary dispatch. MRCR does not establish active route capacity. Check the active Pi registry for current route capacity.",
		hazards: [
			"Formal rollout completion is unknown [G]",
			"Max is not always best in the measured results [G]",
			"Prompt-cache hits are machine-local [G]",
			"Zero Data Retention depends on eligibility, approval, and configuration [G]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"],
		evidenceGapAt: [],
		unknownRoutingCriticalFields: ["formal rollout completion across accounts, regions, quotas, and future catalogue states [G]"],
		evidence: "Artificial Analysis v4.3 measures 46/50/51/53/53 from low through max; DeepSWE measures all five controls [G].",
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
		routeFor: "Use for many separate, independent, short tasks when each result can be checked directly. Bulk describes the number of independent tasks. It does not mean one long action with repeated planning and adaptation. Vendor guidance describes high-volume work and a fastest-model use case with checkable outputs. No project benchmark establishes a preferred effort. Terminal-Bench 2.1 reports 43.8% task pass rate. Vals Code Migration reports 10.1% mean hidden-test pass rate across migrations on a separately labelled Thinking deployment. That label does not map to a verified Pi effort. ARC-AGI-3 has no verified result. Missing evidence is not zero.",
		avoidFor: "Avoid one long action that depends on repeated autonomous planning, tool use, feedback, and adaptation. No numeric turn, token, or duration threshold is supported. Split suitable bulk work into independent short tasks. Do not make an exact-effort quality claim because no project effort was measured. A supported explicit effort may be chosen with judgment, but this row provides no evidence-based coding default. No DeepSWE result or comparable DeepSWE cost exists. A context-window snapshot does not establish permanent route capacity or retrieval quality. Check the active Pi registry for current route capacity.",
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

const GEMINI_ALIAS_ROUTE_FOR = "No capability or effort measurement is established for this alias route. Use only an explicit valid effort with normal result verification. The canonical Vertex results do not establish coding quality, cost, duration, tool use, retrieval, or interactive capability on this route.";
const GEMINI_ALIAS_AVOID_FOR = "Do not transfer the canonical Vertex recommendation, benchmark scores, effort choice, or dated benchmark cost to this alias. Cache, privacy, adapter, wire-format, rate, deployment, and tool contracts can differ by provider route. Check the exact active deployment, registry rate, credentials, tool configuration, account eligibility, and privacy configuration. Vertex evidence does not establish alias-route behavior.";

function aliasView(profile: ModelProfile, alias: string): ModelProfile {
	if (profile.id !== "google-vertex/gemini-3.8-flash") return profile;
	return deepFreeze({
		...profile,
		routeFor: GEMINI_ALIAS_ROUTE_FOR,
		avoidFor: GEMINI_ALIAS_AVOID_FOR,
		capabilityMeasuredAt: [],
		evidenceGapAt: ["low", "medium", "high"],
		unknownRoutingCriticalFields: [
			...profile.unknownRoutingCriticalFields,
			`capability and effort behavior on exact alias route ${alias} [G]`,
		],
	});
}

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
				if (aliasKey && !bySpec.has(aliasKey)) bySpec.set(aliasKey, aliasView(profile, alias));
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
const GEMINI_3_8_FLASH_LADDER: readonly ThinkingLevel[] = Object.freeze(["low", "medium", "high"] as const);
const OPENAI_GPT_6_ASTRA_LADDER: readonly ThinkingLevel[] = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);
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
	["anthropic/claude-fable-5-1", ANTHROPIC_THINKING_ALWAYS_ON_LADDER],
	["google-vertex/gemini-3.8-flash", GEMINI_3_8_FLASH_LADDER],
	["openai/gpt-6-astra", OPENAI_GPT_6_ASTRA_LADDER],
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
