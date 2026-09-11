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
 * Provider-rejected effort levels remain hard dispatch errors.
 */

/** Retained workflow tier. Candidate resolution does not sort on this value. */
export type ModelTier = 1 | 2 | 3 | 4;

/** pi's effort ladder (digest §V). No vendor spellings, and `med` never appears. */
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
	/** true when `ladderFor()` returns an ASSUMED provider-family ladder rather than a traced one [§E.7] */
	ladderAssumed?: true;
	/** levels the PROVIDER rejects outright (hard, unlike `evidenceGapAt`); absent = none traced */
	apiRejectedLevels?: ThinkingLevel[];
	/** short task classes to route here for */
	routeFor: string;
	/** short task classes to avoid here */
	avoidFor: string;
	/** routing-relevant hazards, each a short clause */
	hazards: string[];
	/** effort levels with a traced capability measurement, per digest-v5 §M's predicate */
	capabilityMeasuredAt: ThinkingLevel[];
	/** ADVISORY evidence gaps, NOT a prohibition: dispatch warns, it does not refuse */
	evidenceGapAt: ThinkingLevel[];
	unknownRoutingCriticalFields: string[];
	/** the single strongest evidence sentence for this tier placement, <=200 chars */
	evidence: string;
	/** ISO date of the research behind this profile */
	asOf: string;
}

/** Date of the research behind every profile below (`research/digest-v5.md`). */
export const PROFILES_AS_OF = "2026-07-29";

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
		retrieved: "2026-08-06",
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
} satisfies CacheRetention;

const ANTHROPIC_CACHE_RETENTION = {
	documented: {
		retentionSeconds: 300,
		meaning: "lifetime",
		refreshOnRead: true,
		refreshOnReadAtNoCost: true,
		clockStartsAtRequestStart: true,
		source: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
		retrieved: "2026-08-06",
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
	excluded: ["Paid one-hour retention is not modelled because its write price is 2× the base input rate."],
} satisfies CacheRetention;

const PROFILES: ModelProfile[] = [
	{
		// t1 — the cheap end of the routed six. [Artifact A, Artifact B row 1]
		id: "openai/gpt-5.6-luna",
		aliases: [], // none published [O2]
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
		contextWindow: 1050000, // doc-only [O2]
		contextWindowKnownDivergence: 1000000, // AA normalises GPT-5.6 to 1,000,000 [GM10] — a registry reporting THIS figure is a KNOWN divergence, not a stale profile
		maxOutput: 128000, // doc-only [O2]
		tier: 1,
		routeFor: "bulk mechanical edits, tests @medium",
		avoidFor: "deep ≥256K retrieval, novel reasoning; interactive actions @max",
		hazards: [
			"LATENCY: TTFT 118.469 s at max — worst of the six despite the fastest streaming (196.646 tok/s) [G1f]. Never dispatch interactive actions to luna at max",
			"CONTEXT: MRCR v2 8-needle 41.3% at both 256K+ bands [O3] — a large window it cannot use for deep retrieval. A CAPABILITY limit, distinct from the 272,000-token BILLING threshold [O2]",
			"no novel-reasoning headroom: ARC-AGI-3 0.18%, FrontierMath T4 v2 58.5% [O3]",
			"REWARD HACKING, UNDETERMINED [RI36]: luna shows the highest displayed reward_hacks value of the routed models (-0.9% vs -0.7% / -0.2% / -0.0%) [G1d], but the trial denominator is unpublished, so significance cannot be settled — no pairwise difference reaches p<0.05 for n≤445 while luna-vs-fable-5 does for n≥890 [arb]. Do not rank models on this field; do not treat it as null either",
			"BILLING: above 272,000 input tokens, input-side cost ×2 and output ×1.5 [O2]. A cost event, not a capacity limit",
		],
		capabilityMeasuredAt: ["medium", "max"], // SWE-rebench 43.6% [G1a, O4.3]; Vals Index 69.878% + SWE-bench 93.000% + Vals TB 79.026% + tbench 75.7% + AA Index 51.2359 [G2#7, G3, G1d, G1e]
		evidenceGapAt: ["off", "low", "high", "xhigh"], // off: the only datum is a COST figure, 0.71 cents/prompt [O6], excluded by §M. low/high/xhigh: no capability result in any source [G1e, O4.2]
		unknownRoutingCriticalFields: [
			"LiveCodeBench — genuinely not submitted, so single-shot codegen has no luna evidence at all [GM1]",
			"reward_hacks DENOMINATOR — the trial count behind tbench.ai's percentages appears in NO source, so every hack comparison is UNDETERMINED, not null [G1d, arb, RI36]",
			"AA-Briefcase Elo [G1e]",
			"LMArena Elo — registry entry only, no ranked row [G2#10]",
		],
		evidence:
			"SWE-rebench 43.6% at $0.11/problem @medium [G1a]; MRCR 8-needle 41.3% at 256K+ [O3]; highest displayed reward_hacks but denominator unknown [G1d, RI36].",
		asOf: "2026-07-29",
	},
	{
		// t2, non-preferred. [Artifact A, Artifact B row 2]
		id: "anthropic/claude-sonnet-5",
		// The digest's two aliases are the Bedrock and Google Cloud SURFACE ids
		// [A1]; both are dropped — neither is a pi provider/id form, and both bill
		// +10% regional uplift this module does not carry [A2]. See the header.
		aliases: [],
		cacheRetention: {
			...ANTHROPIC_CACHE_RETENTION,
			measured: {
				observedOn: "2026-08-06",
				warm: [
					{ afterSeconds: 120, probes: 2 },
					{ afterSeconds: 300, probes: 2 },
				],
				cold: [{ afterSeconds: 480, probes: 2 }],
			},
		},
		contextWindow: 1000000, // doc-only [A2]
		maxOutput: 128000, // doc-only; 300,000 via batch beta [A2]
		tier: 2,
		apiRejectedLevels: ["off"], // manual thinking control returns HTTP 400 [A2]; the level stays on the ladder per §V — see the header
		routeFor: "use @high when its measured strengths fit",
		avoidFor: "work sol can take; effort below high, where nothing is measured",
		hazards: [
			"DOMINATED BY sol ON THE MEASURABLE AXES [RI37]: SWE-rebench 62.3% at $0.85/problem vs 56.8% at $1.43 (z=2.67) [G1a] and Vals Index 73.118% at $7.4571/test vs 68.608% at $9.0124 (z=3.63) [G2#7]; on the third axis, AA Index, sol at medium is 3.75× cheaper ($0.4066 vs $1.5254) at a 0.24-point difference AA publishes no CI for, so quality there is INDETERMINATE [G1e]",
			"REAL COST CAN EXCEED OPUS-5 [RI22]: only at matched max effort is sonnet-5 24.8% cheaper per AA task ($1.5254 vs $2.0277); at iso-quality with effort free to vary, opus-5 @medium scores higher AND costs 59% less ($0.6184) [G1e, arb], and on Vals Index sonnet-5 is dearer per test than opus-5 ($9.0124 vs $8.5384, not effort-matched) [G2#7, GM5]",
			"TOKEN INFLATION: ~30% more tokens for identical text, applying to ALL Claude 4.7+ models [GM9] — a Claude-vs-GPT factor, not a sonnet-vs-opus one",
			"NO CHEAP-EFFORT EVIDENCE: no capability result at off, minimal, low or medium [G1e, A4a]. An evidence gap, not a demonstrated weakness — warn, never refuse, but never recommend those levels either [RI35]",
			"ADAPTIVE THINKING: manual thinking control returns HTTP 400, and so do non-default sampling params [A2 — a digest `constraints` entry, not one of its hazard rows]. The `off` level is therefore in `apiRejectedLevels`, a hard rejection rather than an evidence gap",
			"own system card flags the training run as unhealthy in its second half; worst over-refusal of the three Claudes (0.59% ±0.05 API) [A5]",
		],
		capabilityMeasuredAt: ["high", "xhigh", "max"], // SWE-rebench 56.8% + tbench 74.6% [G1a, A4b, G1d]; vendor TB2.1 80.4% [G1d]; Vals Index 68.608% + SWE-bench 79.600% + AA Index 53.3500 [G2#7, GM3, G1e]
		evidenceGapAt: ["off", "minimal", "low", "medium"], // off also returns HTTP 400 for manual control [A2]; low's only datum is a TURN RATIO (~6× more turns at max than low) [A4a], excluded by §M
		unknownRoutingCriticalFields: [
			"capability at off / minimal / low / medium — four of seven ladder levels, including the two the cheap-tier story would need [G1e, A4a]",
			"TTFT at max; output tokens per Index task; time per Index task — AA 20-row truncation [G1f, G1e]",
		],
		evidence:
			"56.8% at $1.43 @high [G1a]; sol wins 2 of 3 cost-per-work axes outright, 3rd indeterminate [G1a, G2#7, G1e]; nothing measured below high [G1e].",
		asOf: "2026-07-29",
	},
	{
		// `t?` in Artifact B — OUTSIDE the t1<t2<t3<t4 ordering (RI39); encoded as
		// tier 2 because ModelTier has no unranked member, and flagged
		// `tierUnsourced` so no consumer reads it as a ranking. See the header.
		id: "openai/gpt-5.6-terra",
		aliases: [], // [O1, O2]
		cacheRetention: { ...OPENAI_GPT_5_6_CACHE_RETENTION },
		contextWindow: 1050000, // doc-only [O2]
		contextWindowKnownDivergence: 1000000, // AA normalises GPT-5.6 to 1,000,000 [GM10]
		maxOutput: 128000, // doc-only [O2]
		tier: 2,
		tierUnsourced: true, // the digest places terra at `t?`, outside the ordering [RI39]
		routeFor: "configured-only; use only for a directly justified action",
		avoidFor: "everything by default; single-shot codegen goes cheaper elsewhere",
		hazards: [
			"NO DEFENSIBLE ROUTING NICHE [RI24]: its one significant edge (Vals LiveCodeBench 85.930% vs sol, z=2.23) is NS against gpt-5.4-nano 84.009% (z=1.32) — a model outside the routed six at $0.20/$1.25 — and loses significantly on the same board to opus-5 (z=2.27) and fable-5 (z=2.84) [G1b, G3, arb]. Retained because an operator may configure it deliberately",
			"NO contamination-resistant coding evidence exists at all: terra is absent from SWE-rebench's 117-row registry, proven never submitted [G1a]",
			"AA's own routing finding, which corroborates the exclusion independently of the significance tests: a luna or sol effort level always dominates terra on the intelligence/cost frontier [O4.1 — a digest `caveats` entry on sol, not one of terra's hazard rows]",
			"LONG-TASK COLLAPSE: 33.3% on the >4 h band of Vals SWE-bench Verified [GM4]",
			"BILLING: above 272,000 input tokens, input-side cost ×2 and output ×1.5 [O2]",
			"TIER: the digest places terra at `t?`, outside the ordinal tier ordering [RI39]; the tier field says 2 only because the type has no unranked member — `tierUnsourced` prevents a sourced-tier claim",
		],
		capabilityMeasuredAt: ["xhigh", "max"], // Vals Index 65.135% + Vals LCB 85.930% + Vals TB 73.408% + AA Index 51.6046 [G2#7, G1b, G1d, G1e]; tbench 78.4% + AA Index 54.9529 [G1d, G1e]
		evidenceGapAt: ["off", "low", "medium", "high"], // medium: LMArena carries gpt-5.6-terra-medium with NO ranked row — registry presence is not a measurement [G2#10]; high: AA publishes terra at max/xhigh only, Vals used xhigh [G1e, O4.2]
		unknownRoutingCriticalFields: [
			"SWE-rebench resolve rate — no value can exist, terra is absent from the 117-row registry, so the only contamination-resistant axis is blank for this model [G1a]",
			"AA Coding Agent Index — 77.4 (vendor, [O3]) vs 77 (independent, [O4.1]) for the same metric, unadjudicated",
			"LMArena Elo — registry entry only, no ranked row [G2#10]",
			"TTFT at max [G1f]",
			"AA-Briefcase Elo [G1e]",
		],
		evidence:
			"Sole edge Vals LCB 85.930% is SIG vs sol but NS vs gpt-5.4-nano and loses SIG to opus-5 and fable-5 [G1b, G3, arb]; no SWE-rebench row [G1a].",
		asOf: "2026-07-29",
	},
	{
		// t3. [Artifact A, Artifact B row 4]
		id: "openai/gpt-5.6-sol",
		// The digest's one alias is the bare `gpt-5.6` [O1, O2]; it is carried in
		// provider-qualified form FIRST so it survives a canonical provider/id
		// gate, with the digest's own bare spelling kept beside it. No dated
		// snapshot ids are published.
		aliases: ["openai/gpt-5.6", "gpt-5.6"],
		cacheRetention: {
			...OPENAI_GPT_5_6_CACHE_RETENTION,
			measured: {
				observedOn: "2026-08-06",
				dedicatedCacheKey: true,
				warm: [
					{ afterSeconds: 571, probes: 5 },
					{ afterSeconds: 1500, probes: 3 },
				],
				cold: [],
			},
		},
		contextWindow: 1050000, // doc-only [O2]
		contextWindowKnownDivergence: 1000000, // AA normalises GPT-5.6 to 1,000,000 [GM10]
		maxOutput: 128000, // doc-only [O2]
		tier: 3,
		routeFor: "agentic coding @medium; deep retrieval @medium",
		avoidFor: "any high/xhigh/max dispatch whose output nobody verifies",
		hazards: [
			"REWARD HACKING: METR reports a detected cheating rate 'higher than any public model we have evaluated on our ReAct agent harness' — SUPERLATIVE published, RATE UNKNOWN [O4.5]. Its 50%-time-horizon swings 11.3 h (cheats=failures) → >270 h (cheats=successes) → 71 h (discarded) by scoring convention [O4.5]",
			"sol is absent from tbench.ai, so it has no reward_hacks figure at all — absence of a hack measurement is not evidence of safety [G1d]",
			"AUTONOMY: vendor-admitted increase in severity-3 unauthorized actions vs GPT-5.5 at high effort [O3]",
			"ROUTING GATE: every high/xhigh/max dispatch needs output verification budgeted, not just tokens [O4.5, O3]",
			"BILLING: above 272,000 input tokens, input-side cost ×2 and output ×1.5 [O2]. A cost event, not a capacity limit",
			"INDEPENDENCE: AA was a paid pre-release evaluation partner for this launch and METR's report was NDA'd and reviewed by OpenAI comms/legal — independent harness, non-independent relationship [O7 — a digest `caveats` entry, not one of its hazard rows]",
			"EVIDENCE CAVEAT: both SWE-bench variants are vendor-discredited by the party that gains from discrediting them [O5, O7 — a digest `caveats` entry, not one of its hazard rows]",
		],
		capabilityMeasuredAt: ["medium", "high", "xhigh", "max"], // SWE-rebench 62.3% + AA Index 53.5888 [G1a, O4.3, G1e]; AA Index 55.8665, a composite index admitted by the widened predicate [G1e, RI35]; AA TB2.1 89.513% + AA Index 57.6538 + LMArena 1485 [G1d, G1e, G2#10]; Vals SWE-bench 96.20% + Vals Index 73.118% + AA Index 58.8898 [O4.2, G2#7, G1e]
		evidenceGapAt: ["off", "low"], // off: the corpus's only effort-off datum is luna's COST figure [O6]; low: AA publishes Index rows at max/xhigh/high/medium only [G1e, O4.2]
		unknownRoutingCriticalFields: [
			"METR cheating RATE — only a qualitative superlative is published, so the magnitude of the top hazard is UNKNOWN [O4.5]",
			"TTFT at max — AA's TTFT chart is a fixed 20-row list and sol-max falls outside it [G1f]",
			"per-benchmark Vals compute_effort on every sol row — model-level claim only [O4.2, GM5]",
			"GDPval-AA v2 Elo — 1747.8 [O3] vs 1736 [A3], unadjudicated",
			"ARC-AGI-1 / -2 — NO DATA [O5] vs 97.5/92.5 [A3], unadjudicated",
		],
		evidence:
			"62.3% SWE-rebench at $0.85/problem @medium [G1a]; top MRCR of the three variants that publish it [O3, RI30]; verify all high/xhigh/max output [O4.5].",
		asOf: "2026-07-29",
	},
	{
		// t3. [Artifact A, Artifact B row 5]
		id: "anthropic/claude-opus-5",
		aliases: [], // the digest's Bedrock/Google Cloud surface ids are dropped [A1] — see the header
		cacheRetention: { ...ANTHROPIC_CACHE_RETENTION },
		contextWindow: 1000000, // doc-only [A2]
		maxOutput: 128000, // doc-only; 300,000 via batch [A2]
		tier: 3,
		routeFor: "architecture, hard debug, 1M-token episodes @high",
		avoidFor: "@max, where a small quality gain costs a lot; route high or xhigh",
		hazards: [
			"EFFORT COST CLIFF: max buys +1.83 AA Index points for +92% cost per task vs high ($2.0277 vs $1.0571) [G1e, arb]. Route high or xhigh",
			"SAFEGUARD FALLBACK applies to opus-5 too: its Vals Terminal-Bench 2.1 84.644% is high-effort AND fallback-inclusive — use 81.27% (fallbacks counted as failures) for automation planning [GM5, A4c]",
			"HALLUCINATION: 50% non-hallucination rate vs sonnet-5's 63% [A4a]",
			"NO official terminal-bench submission and NO reward_hacks figure [G1d] — absence of a hack measurement is not evidence of safety",
			"CHEAP LEVELS ARE MEASURED HERE, unusually: low (AA-Briefcase Elo 1223) and medium (AA Index 56.2806 at $0.6184/task) both carry capability results [A4a, G1e] — at medium it beats sonnet-5 at max on both quality and cost [arb, RI22]",
			"thinking cannot be disabled at xhigh/max [A2 — a digest ladder note, not one of its hazard rows]",
		],
		capabilityMeasuredAt: ["low", "medium", "high", "xhigh", "max"], // Elo 1223 [A4a, RI19]; AA Index 56.2806 + Elo 1470.21 [G1e]; SWE-rebench 63.4% + Vals TB 84.644% + ARC-AGI-3 30.16% + AA Index 58.8642 + LMArena 1493±8 [G1a, A4b, GM5, A4d, G1e, G2#10, RI34]; AA Index 60.0682 + AA TB2.1 88.015% [G1e, G1d]; AA Index 60.6919 + LMArena 1495±12 + ARC-AGI-1/-2 97.5/90.4 [G1e, G2#10, A4d]
		evidenceGapAt: ["off", "minimal"], // no capability result at either level in any source [G1e]
		unknownRoutingCriticalFields: [
			"per-benchmark Vals compute_effort on Index / SWE-bench / LiveCodeBench / GPQA — null in the payload, so four of its headline numbers have UNKNOWN effort [GM5]",
			"AA-Briefcase CIs at every opus-5 effort level — published for sol, sonnet-5 and fable-5 only [G1e]",
			"official Terminal-Bench 2.1 and its reward_hacks figure — genuinely not submitted [G1d]",
			"AA cost per task at xhigh — not published, not derivable [G1e]",
			"Epoch ECI — ~159 secondhand, conflicts with a circulating 162.1 [A4d, A6]",
		],
		evidence:
			"63.4% @high [G1a]; ARC-verified ARC-AGI-3 30.16% @high [A4d]; measured down to low (Elo 1223) [A4a]; @medium beats sonnet-5@max on cost and quality [G1e].",
		asOf: "2026-07-29",
	},
	{
		// t4, non-preferred. [Artifact A, Artifact B row 6]
		id: "anthropic/claude-fable-5",
		aliases: [], // safeguarded twin of claude-mythos-5; the digest's Bedrock/Google Cloud surface ids are dropped [A1] — see the header
		cacheRetention: { ...ANTHROPIC_CACHE_RETENTION },
		contextWindow: 1000000, // doc-only [A2]
		maxOutput: 128000, // doc-only; 300,000 via batch [A2]
		tier: 4,
		routeFor: "use only after opus-5 measurably fails",
		avoidFor: "ZDR-obligated actions (REFUSE); anything opus-5 already clears",
		hazards: [
			"NO ZERO-DATA-RETENTION: mandatory 30-day retention on first- AND third-party surfaces, Covered Model status [A2, A5]. HARD COMPLIANCE BLOCKER — a ZDR-obligated action must be REFUSED here at every effort level",
			"SAFEGUARD-FALLBACK CONTAMINATION: falls back to Opus 4.8 server-side — vendor claims <5% of sessions, AA measured ~8% of Index tasks and 9% of HLE/AA-Omniscience tasks [A5]. Anthropic stars the worst-affected rows (HLE, Terminal-Bench 2.1, BioMysteryBench, ExploitBench, HealthBench Professional) [A5]; an unknown slice of fable-5's published wins are Opus 4.8's",
			"NO SIGNIFICANT EDGE over opus-5 anywhere in the traced set: SWE-rebench z=0.56, Vals Index z=0.22, LiveCodeBench z=0.58, LMArena z=0.97 — all NS, at 2× the input price [arb]",
			"refusals return HTTP 200 with stop_reason refusal, not an error [A5] — a caller checking only HTTP status will treat a refusal as success",
			"its own vendor tier verdict: justify per task, never as a default [A7 — a digest `caveats` entry, not one of its hazard rows]; three of its four claimed edges over opus-5 are non-significant [arb via §H, NOT [A7], which only lists the four claimed edges]",
		],
		capabilityMeasuredAt: ["high", "xhigh", "max"], // SWE-rebench 64.5% + tbench Terminus-2 80.4% [G1a, A4b, G1d]; tbench Claude Code 83.8% [G1d]; Vals Index 75.145% + Vals LCB 89.778% + AA Index 59.8606 [G2#7, G1b, G1e]
		evidenceGapAt: ["minimal", "low", "medium"], // no capability result at any of the three in any source [G1e]
		unknownRoutingCriticalFields: [
			"share of published wins attributable to the Opus-4.8 fallback — unquantified beyond the 8-9% task rate, so every fable-5 headline number has UNKNOWN contamination [A5]",
			"ARC-AGI any version — arcprize.org 404s, vendor table shows a dash [A4d, A6]",
			"TTFT; cost to run the whole AA Index — AA 20-row truncation [G1f, G1e]",
			"capability at minimal / low / medium [G1e]",
		],
		evidence:
			"No significant edge over opus-5 anywhere (z=0.56/0.22/0.58/0.97) at 2x input price [arb]; no ZDR [A2]; fallback taints ~8-9% of its evals [A5].",
		asOf: "2026-07-29",
	},
	// ── §E cheap tier: OUT OF SCOPE for routing, profiled only so a user who
	// names one of them gets data instead of a spurious "unknown model"
	// warning. §E.7: never route here without an explicit scope change. The
	// digest assigns these three NO tier (the 1 below is a cost class, flagged
	// `tierUnsourced`) and no effort labels, so nothing satisfies the §M
	// predicate; their ladders are ASSUMED provider-family shapes, flagged
	// `ladderAssumed`. See the module header for both derivations.
	{
		// CANONICAL id is the UNDATED spec, because that is the only one pi's
		// registry carries [registry]; [G3] names this model by its dated snapshot
		// id, which is kept as an alias so the corpus spelling still resolves but
		// is never presented as a dispatch target. See the ID CHOICE header note.
		id: "openai/gpt-5.4-nano",
		aliases: ["openai/gpt-5.4-nano-2026-03-17", "gpt-5.4-nano-2026-03-17", "gpt-5.4-nano"], // (a) research-traced dated id [G3], then (b) bare lookup spellings
		cacheRetention: null,
		contextWindow: null, // no capacity row in the corpus for this model [G3]
		maxOutput: null, // [G3]
		tier: 1,
		tierUnsourced: true, // the digest assigns no tier; 1 is a COST class read off the price [G3]
		ladderAssumed: true, // pi ladder unverified in this pass [§E.7]
		routeFor: "single-shot codegen at trivial cost, on an explicit scope change only",
		avoidFor: "agentic / multi-step coding; unmeasured escalation out of this tier",
		hazards: [
			"OUT OF SCOPE: do not route here without an explicit scope change [§E.7]",
			"NO contamination-resistant coding evidence: not one of the three cheap-tier models appears on SWE-rebench, so escalation out of this tier must be measured [G3, §E.5]",
			"pi effort LADDER UNVERIFIED in this pass [§E.7] — the ladder this module reports for it is the ASSUMED OpenAI family shape, not a traced fact (`ladderAssumed`)",
			"NO EFFORT-LABELLED capability result: §E.8 states only that it has results at no more than one level, and no §E figure carries an effort label, so the §M predicate admits none [derived from §E.8 + §M] — treat its effort behaviour as an evidence gap, advisory only",
			"beats claude-haiku-4-5 on 4 of 5 Vals benchmarks, not all five — Haiku wins Terminal-Bench 2.1, 43.820% vs 41.573% [G3, arb]",
		],
		capabilityMeasuredAt: [], // DERIVED, not stated: no §E figure carries an effort label, so the §M predicate admits no level [derived from §E.8 + §M]
		evidenceGapAt: ["off", "low", "medium", "high", "xhigh", "max"], // the whole ASSUMED ladder; advisory, never a refusal
		unknownRoutingCriticalFields: [
			"effort level behind every published figure — no source labels one for this model [G3]",
			"pi effort ladder — unverified in this pass [§E.7]",
			"contextWindow / maxOutput — no capacity row in the corpus [G3]",
			"cache retention — this pass established a policy only for the GPT-5.6 family and Anthropic models",
			"SWE-rebench resolve rate — does not appear on the board at all [G3]",
		],
		evidence:
			"Vals LiveCodeBench 84.009% ±1.044 at $0.0025/test — above sol's 82.604% and NS vs terra's 85.930% (z=1.32) at a twelfth of terra's input price [G3, arb, RI24].",
		asOf: "2026-07-29",
	},
	{
		// CANONICAL id is the UNDATED spec, as for nano above: pi's registry
		// carries only that spelling [registry], while [G3] names the model by its
		// dated snapshot id, kept below as an alias.
		id: "openai/gpt-5.4-mini",
		aliases: ["openai/gpt-5.4-mini-2026-03-17", "gpt-5.4-mini-2026-03-17", "gpt-5.4-mini"], // (a) research-traced dated id [G3], then (b) bare lookup spellings
		cacheRetention: null,
		contextWindow: null, // no capacity row in the corpus [G3]
		maxOutput: null, // [G3]
		tier: 1,
		tierUnsourced: true, // the digest assigns no tier; 1 is a COST class read off the price [G3]
		ladderAssumed: true, // pi ladder unverified in this pass [§E.7]
		routeFor: "cheap broad tasks, on an explicit scope change only",
		avoidFor: "coding that needs contamination-resistant evidence; unmeasured escalation",
		hazards: [
			"OUT OF SCOPE: do not route here without an explicit scope change [§E.7]",
			"NO contamination-resistant coding evidence: does not appear on SWE-rebench, so escalation out of this tier must be measured [G3, §E.5]",
			"pi effort LADDER UNVERIFIED in this pass [§E.7] — the ladder this module reports for it is the ASSUMED OpenAI family shape, not a traced fact (`ladderAssumed`)",
			"NO EFFORT-LABELLED capability result: §E.8 states only that it has results at no more than one level, and no §E figure carries an effort label, so the §M predicate admits none [derived from §E.8 + §M] — an evidence gap, advisory only",
		],
		capabilityMeasuredAt: [], // DERIVED, not stated: no §E figure carries an effort label [derived from §E.8 + §M]
		evidenceGapAt: ["off", "low", "medium", "high", "xhigh", "max"], // the whole ASSUMED ladder; advisory
		unknownRoutingCriticalFields: [
			"effort level behind every published figure — no source labels one for this model [G3]",
			"pi effort ladder — unverified in this pass [§E.7]",
			"contextWindow / maxOutput — no capacity row in the corpus [G3]",
			"cache retention — this pass established a policy only for the GPT-5.6 family and Anthropic models",
			"SWE-rebench resolve rate — does not appear on the board at all [G3]",
		],
		evidence:
			"Vals Index 52.425% ±2.054 (#23/40) at $0.6597/test = 75.0% of luna's 69.878% at 60.6% of luna's cost per test [G3, arb].",
		asOf: "2026-07-29",
	},
	{
		id: "anthropic/claude-haiku-4-5",
		// The dated PINNED-SNAPSHOT id from the same [G3] model row:
		// "`claude-haiku-4-5` (`claude-haiku-4-5-20251001`)". Provider-qualified
		// first so it survives a canonical provider/id form gate, bare spelling
		// beside it. Unusually, BOTH spellings are real registry ids here
		// [registry] — unlike the two cheap-tier OpenAI models, whose dated ids are
		// aliases the registry does not carry (their canonical ids are the undated
		// specs). Anthropic's 5-generation ids are dateless pinned snapshots [A1],
		// so only this pre-4.6 model has a dated form at all; the routed six
		// publish none [O1 "no dated snapshot IDs", A1].
		aliases: ["anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"],
		cacheRetention: { ...ANTHROPIC_CACHE_RETENTION },
		contextWindow: 200000, // doc-only, like every window here [G3, registry]
		maxOutput: 64000, // doc-only [G3]
		tier: 1,
		tierUnsourced: true, // the digest assigns no tier; 1 is a COST class read off the price [G3]
		ladderAssumed: true, // pi ladder unverified in this pass [§E.7]
		routeFor: "cheap bulk work, on an explicit scope change only",
		avoidFor: "threads that must not compact; unmeasured escalation out of this tier",
		hazards: [
			"OUT OF SCOPE: do not route here without an explicit scope change [§E.7]",
			"NO contamination-resistant coding evidence: does not appear on SWE-rebench, so escalation out of this tier must be measured [G3, §E.5]",
			"200K context / 64K output, documentation-only [G3, registry] — the only model in the digest under 1M [§E.3], so a long thread routed to it can compact. No comparison is made with gpt-5.4-nano/-mini, whose windows are UNKNOWN",
			"pi effort LADDER UNVERIFIED in this pass [§E.7] — the ladder this module reports for it is the ASSUMED Anthropic family shape, not a traced fact (`ladderAssumed`)",
			"NO EFFORT-LABELLED capability result: §E.8 states only that it has results at no more than one level, and no §E figure carries an effort label, so the §M predicate admits none [derived from §E.8 + §M] — an evidence gap, advisory only",
		],
		capabilityMeasuredAt: [], // DERIVED, not stated: no §E figure carries an effort label [derived from §E.8 + §M]
		evidenceGapAt: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], // the whole ASSUMED ladder; advisory
		unknownRoutingCriticalFields: [
			"effort level behind every published figure — no source labels one for this model [G3]",
			"pi effort ladder — unverified in this pass [§E.7]",
			"SWE-rebench resolve rate — does not appear on the board at all [G3]",
		],
		evidence:
			"Vals SWE-bench Verified 66.600% ±2.111 (#60/75) at $0.3662/test; AA-LCR 70.33%; wins Terminal-Bench 2.1 vs nano, 43.820% vs 41.573% [G3, arb].",
		asOf: "2026-07-29",
	},
];

/**
 * Static routing profiles in Artifact B row order — ascending tier, with
 * terra's unranked `t?` retained — followed by the
 * out-of-scope §E cheap tier.
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

// The three ladder shapes of digest §V. pi's `off`/`minimal` are dispatch
// levels the providers accept beyond the five Anthropic documents; no source
// measures either for any model.
// NO minimal [contract, O2]
const OPENAI_GPT_5_LADDER: readonly ThinkingLevel[] = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"] as const);
// all seven [contract, A2]
const ANTHROPIC_FULL_LADDER: readonly ThinkingLevel[] = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
// NO off — thinking always on [contract, A2]
const ANTHROPIC_THINKING_ALWAYS_ON_LADDER: readonly ThinkingLevel[] = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"] as const);

/**
 * Per-id ladders rather than a prefix rule: fable-5 breaks its family's shape
 * (no `off`), and the cheap tier's ladders are UNVERIFIED assumptions [§E.7],
 * so each entry is stated explicitly and traceably instead of derived.
 *
 * A MAP, not an object literal (review finding CQ6): an object lookup keyed by
 * a caller-supplied id answers for `Object.prototype` property names too, so an
 * id of "constructor" or "toString" would have returned a FUNCTION where a
 * ladder belongs — the accessor's contract broken by the table's own prototype.
 * Map.get answers only for keys actually inserted.
 */
const LADDER_BY_ID: ReadonlyMap<string, readonly ThinkingLevel[]> = new Map<string, readonly ThinkingLevel[]>([
	["openai/gpt-5.6-sol", OPENAI_GPT_5_LADDER],
	["openai/gpt-5.6-terra", OPENAI_GPT_5_LADDER],
	["openai/gpt-5.6-luna", OPENAI_GPT_5_LADDER],
	["anthropic/claude-sonnet-5", ANTHROPIC_FULL_LADDER],
	["anthropic/claude-opus-5", ANTHROPIC_FULL_LADDER],
	["anthropic/claude-fable-5", ANTHROPIC_THINKING_ALWAYS_ON_LADDER],
	// The three below are ASSUMED family shapes, unverified [§E.7]; their
	// profiles carry `ladderAssumed: true` so a consumer can tell them apart
	// from a traced ladder without re-deriving it here.
	["openai/gpt-5.4-nano", OPENAI_GPT_5_LADDER],
	["openai/gpt-5.4-mini", OPENAI_GPT_5_LADDER],
	["anthropic/claude-haiku-4-5", ANTHROPIC_FULL_LADDER],
]);

/**
 * The pi thinking-level ladder a model actually supports (digest §V). Every
 * profiled id has an entry; an unprofiled ModelProfile handed in from outside
 * falls back to the widest ladder, which warns-but-dispatches rather than
 * blocking a level the model may well accept.
 *
 * The answer is TRACED unless the profile sets `ladderAssumed`, in which case
 * it is this module's provider-family assumption [§E.7]. A level on the ladder
 * may still be rejected by the provider — see `apiRejectedLevels`.
 *
 * ALWAYS a frozen array of ThinkingLevel, for every possible `id` — including
 * prototype property names such as "constructor" or "__proto__", which the
 * previous object-literal table answered with a function or an object (CQ6).
 */
export function ladderFor(profile: ModelProfile): readonly ThinkingLevel[] {
	return LADDER_BY_ID.get(profile.id) ?? ANTHROPIC_FULL_LADDER;
}
