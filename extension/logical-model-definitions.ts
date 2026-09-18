export const LOGICAL_MODEL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type LogicalModelEffort = (typeof LOGICAL_MODEL_EFFORTS)[number];

export interface LogicalFieldSource {
	publisher: "DeepSWE/DataCurve";
	retrieved: "2026-09-11";
	sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json";
	basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence";
}

export interface LogicalModelSource {
	capabilityRating?: Readonly<LogicalFieldSource>;
	costRating?: Readonly<LogicalFieldSource>;
	guidelines?: Readonly<LogicalFieldSource>;
}

export interface LogicalModelDefinition {
	model: string;
	capabilityRating: number;
	effort: LogicalModelEffort;
	costRating: number;
	preferredProvider: string;
	providers: Readonly<Record<string, string>>;
	guidelines: readonly string[];
	cautions: readonly string[];
	source?: Readonly<LogicalModelSource>;
}

export interface LogicalCompressorEntry {
	model: string;
	effort: LogicalModelEffort;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) deepFreeze(inner);
	}
	return value;
}

const SONNET_OPUS_CAUTION = "May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements.";
const SOL_CAUTION = "When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action.";

function providers(provider: string, model: string): Record<string, string> {
	const result = Object.create(null) as Record<string, string>;
	result[provider] = model;
	return result;
}

function fieldSource(): LogicalFieldSource {
	return {
		publisher: "DeepSWE/DataCurve",
		retrieved: "2026-09-11",
		sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
		basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence",
	};
}

function source(): LogicalModelSource {
	return { capabilityRating: fieldSource(), costRating: fieldSource(), guidelines: fieldSource() };
}

const SHIPPED_DEFINITIONS: LogicalModelDefinition[] = [
	{
		model: "gpt-5.6-luna", capabilityRating: 45, effort: "max", costRating: 10,
		preferredProvider: "openai", providers: providers("openai", "gpt-5.6-luna"),
		guidelines: ["consumer-contract work"], cautions: [], source: source(),
	},
	{
		model: "claude-sonnet-5", capabilityRating: 40, effort: "high", costRating: 90,
		preferredProvider: "anthropic", providers: providers("anthropic", "claude-sonnet-5"),
		guidelines: [], cautions: [SONNET_OPUS_CAUTION], source: source(),
	},
	{
		model: "gpt-5.6-terra", capabilityRating: 50, effort: "max", costRating: 55,
		preferredProvider: "openai", providers: providers("openai", "gpt-5.6-terra"),
		guidelines: [], cautions: [], source: source(),
	},
	{
		model: "gpt-5.6-sol", capabilityRating: 58, effort: "high", costRating: 40,
		preferredProvider: "openai", providers: providers("openai", "gpt-5.6-sol"),
		guidelines: [], cautions: [SOL_CAUTION], source: source(),
	},
	{
		model: "gemini-3.8-flash", capabilityRating: 55, effort: "medium", costRating: 30,
		preferredProvider: "google-vertex", providers: providers("google-vertex", "gemini-3.8-flash"),
		guidelines: ["concurrency work", "data-loss work", "performance work"], cautions: [], source: source(),
	},
	{
		model: "claude-opus-5", capabilityRating: 72, effort: "high", costRating: 80,
		preferredProvider: "anthropic", providers: providers("anthropic", "claude-opus-5"),
		guidelines: ["concurrency work", "data-loss work", "performance work"], cautions: [SONNET_OPUS_CAUTION], source: source(),
	},
	{
		model: "gpt-6-astra", capabilityRating: 86, effort: "medium", costRating: 60,
		preferredProvider: "openai", providers: providers("openai", "gpt-6-astra"),
		guidelines: ["security work", "performance work"], cautions: [], source: source(),
	},
];

export const SHIPPED_LOGICAL_MODELS: readonly LogicalModelDefinition[] = deepFreeze(SHIPPED_DEFINITIONS);

export const SHIPPED_COMPRESSOR_MODELS: readonly LogicalCompressorEntry[] = deepFreeze([
	{ model: "claude-sonnet-5", effort: "medium" },
]);

export const LOGICAL_MODEL_SOURCE_NOTES = deepFreeze({
	ratings: "Fixed project judgments informed by DeepSWE v1.1 by DataCurve and reviewed supporting evidence",
	guidance: "Project-authored advisory guidance informed by DeepSWE v1.1 focus analysis and approved project inference",
	source: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
	retrieved: "2026-09-11",
	limits: "Ratings are not percentages, measurements, price ratios, quality guarantees, realized costs, or billing forecasts",
});
