export const LOGICAL_MODEL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type LogicalModelEffort = (typeof LOGICAL_MODEL_EFFORTS)[number];

export type LogicalFieldSource = {
	publisher: "DeepSWE/DataCurve";
	retrieved: "2026-09-11";
	sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json";
	basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence";
} | {
	publisher: "Slate project";
	decided: "2026-11-12";
	basis: "Project judgment proportionally scaled on 2026-11-12 without a benchmark source for this rating"
		| "Project judgment proportionally scaled on 2026-11-12 from earlier judgments informed by DeepSWE v1.1 and reviewed supporting evidence";
};

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

const LOGICAL_MODEL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** One provider-free logical model name accepted by policy and durable history. */
export function isLogicalModelName(value: unknown): value is string {
	return typeof value === "string" && LOGICAL_MODEL_NAME.test(value);
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) deepFreeze(inner);
	}
	return value;
}

const SONNET_OPUS_CAUTION = "May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements.";
const SOL_CAUTION = "When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action. Do not run a dependency install that the project rules forbid. Ask first.";
const LUNA_CAUTION = "May treat supplied repair context as permission to implement despite explicit task limits. Restrict write access for record-only work and verify the changed files.";
const FLASH_CAUTION = "Do not use as a reviewer. It relies too much on passing tests and exact-size assertions. Verify source citations and distinguish proposed behavior from existing behavior.";

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

function source(projectRatings = false): LogicalModelSource {
	const ratingSource: LogicalFieldSource = {
		publisher: "Slate project", decided: "2026-11-12",
		basis: projectRatings
			? "Project judgment proportionally scaled on 2026-11-12 without a benchmark source for this rating"
			: "Project judgment proportionally scaled on 2026-11-12 from earlier judgments informed by DeepSWE v1.1 and reviewed supporting evidence",
	};
	return { capabilityRating: ratingSource, costRating: ratingSource, guidelines: fieldSource() };
}

const SHIPPED_DEFINITIONS: LogicalModelDefinition[] = [
	{
		model: "luna-6", capabilityRating: 35, effort: "max", costRating: 2,
		preferredProvider: "openai", providers: providers("openai", "gpt-6-luna"),
		guidelines: ["auxiliary tasks only, such as file location, check-result collection, or routine text management such as modifying research logs", "never primary research, implementation, design, or review", "consumer-contract work only when auxiliary"],
		cautions: [LUNA_CAUTION, "Do not use Luna to handle complex texts.", "May shorten long file paths in tool calls. Give the full path and require a read-back of the edited lines.", "May undo its own checked writes before it ends. Check the final file state after every record task.", "For an append, anchor one single-block edit on the exact current last line, then read back the tail.", "May report state outside the task scope incorrectly. Verify such a claim before acting on it."], source: source(),
	},
	{
		model: "claude-sonnet-5.5", capabilityRating: 35, effort: "high", costRating: 25,
		preferredProvider: "anthropic", providers: providers("anthropic", "claude-sonnet-5-5"),
		guidelines: [], cautions: [SONNET_OPUS_CAUTION], source: source(true),
	},
	{
		model: "sol-6.1", capabilityRating: 66, effort: "high", costRating: 9,
		preferredProvider: "openai", providers: providers("openai", "gpt-6.1-sol"),
		guidelines: ["default thread choice"], cautions: [SOL_CAUTION, "Broad searches can return text from excluded private paths. State path limits in the task and use path-limited commands.", "For cross-runtime process and networking fixes, verify exit, slot ownership and silent output on every supported runtime before closing the repair.", "When shortening text to fit a size budget, may drop or weaken duties. Require a duty-by-duty comparison of the text before and after the cut."], source: source(true),
	},
	{
		model: "gemini-3.8-flash", capabilityRating: 43, effort: "medium", costRating: 14,
		preferredProvider: "google-vertex", providers: providers("google-vertex", "gemini-3.8-flash"),
		guidelines: ["default thread choice", "generally prefer over Luna when available", "a more specific active guideline overrides this general Flash preference"],
		cautions: [FLASH_CAUTION], source: source(),
	},
	{
		model: "claude-opus-5.5", capabilityRating: 70, effort: "high", costRating: 30,
		preferredProvider: "anthropic", providers: providers("anthropic", "claude-opus-5-5"),
		guidelines: ["Reviewer for each proved DESIGN-TRIGGERING focus area, in adversarial design review and in implementation area review.", "Do not select Opus 5.5 as the default implementer."], cautions: [SONNET_OPUS_CAUTION], source: source(),
	},
	{
		model: "gpt-6-astra", capabilityRating: 67, effort: "medium", costRating: 28,
		preferredProvider: "openai", providers: providers("openai", "gpt-6-astra"),
		guidelines: ["Do not select Astra as the default implementer.", "Prefer Sol 6.1 over Astra."],
		cautions: [], source: source(),
	},
	{
		model: "fable-5-2", capabilityRating: 84, effort: "high", costRating: 75,
		preferredProvider: "anthropic", providers: providers("anthropic", "claude-fable-5-2"),
		guidelines: ["Do not select Fable 5.2 for routine work.", "If a lower-capability model repeatedly fails at implementation, first ask Fable 5.2 to investigate and provide detailed repair instructions. Let the implementer try those instructions. Use Fable 5.2 as the implementer only if that guided attempt also fails. Treat that use as an exception. Select another suitable model for later implementation work. Existing approval requirements and repair limits still apply."], cautions: [], source: source(true),
	},
];

export const SHIPPED_LOGICAL_MODELS: readonly LogicalModelDefinition[] = deepFreeze(SHIPPED_DEFINITIONS);

export const SHIPPED_COMPRESSOR_MODELS: readonly LogicalCompressorEntry[] = deepFreeze([
	{ model: "claude-sonnet-5.5", effort: "medium" },
]);

export const LOGICAL_MODEL_SOURCE_NOTES = deepFreeze({
	ratings: "The project set every shipped rating on 2026-11-12 by proportional scaling of its earlier project judgments. Fable 5.2 ratings are project judgments with no benchmark source. Earlier Sol 6.1 and Sonnet 5.5 judgments had no new benchmark evidence. DeepSWE v1.1 by DataCurve and reviewed supporting evidence informed the other earlier judgments",
	guidance: "Project-authored advisory guidance informed by DeepSWE v1.1 focus analysis and approved project inference",
	source: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
	retrieved: "2026-09-11",
	limits: "Ratings are not percentages, measurements, price ratios, quality guarantees, realized costs, or billing forecasts",
});
