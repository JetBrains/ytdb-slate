import type { LogicalModelDefinition } from "./logical-model-definitions.ts";
import type { LogicalModelPolicy, LogicalPolicyResolution } from "./logical-model-resolver.ts";

export const ROUTER_PROMPT_MAX_PORTABLE_CHARACTERS = 19_400;
export const ROUTER_PROMPT_MAX_LINES = 105;

export const ROUTER_PROMPT_INSTRUCTIONS = [
	"Select a logical model for the current action. Use action fit, relevant area guidance, behavioral cautions, capability evidence, and a lower supported cost rating. A higher capability rating or higher cost rating is not enough by itself. Reassess after each episode. Change models only when there is a concrete reason and an expected benefit. Keep quality redispatch separate from transient recovery. Guidance and cautions direct selection, but Slate does not enforce them at runtime. Shipped preferences are not rigid rankings and do not guarantee quality. Apply a more specific active guideline when it states an exception to a general preference. A reference to another model describes a conditional preference and does not require selecting an excluded model. Trusted project definitions can replace shipped guidance, and custom model definitions remain supported. Guidance and cautions create no runtime eligibility or rejection rules.",
	"Capability and cost ratings are fixed project judgments expressed as integers from 1 through 100. Higher capability means stronger expected capability. Higher cost means greater expected expense. Ratings stay fixed when membership changes. Ties are valid, and ratings form no fixed groups. They are not percentages, measurements, ratios, statistical claims, realized costs, or billing forecasts. A small gap has no claimed statistical significance, and the endpoints have no fixed absolute meaning.",
] as const;

const GUIDANCE_MEANING = "Guidance and cautions direct selection, but Slate does not enforce them at runtime. Shipped preferences are not rigid rankings and do not guarantee quality. Apply a more specific active guideline when it states an exception to a general preference. A reference to another model describes a conditional preference and does not require selecting an excluded model. Trusted project definitions can replace shipped guidance, and custom model definitions remain supported. Guidance and cautions create no runtime eligibility or rejection rules.";
const RATING_MEANING = "Rating meaning: capability and cost ratings are fixed project judgments expressed as integers from 1 through 100. Higher capability means stronger expected capability. Higher cost means greater expected expense. Ratings stay fixed when membership changes. Ties are valid, and ratings form no fixed groups.";
const RATING_LIMITS = "Rating limits: ratings are not percentages, measurements, ratios, statistical claims, realized costs, or billing forecasts. A small gap has no claimed statistical significance, and the endpoints have no fixed absolute meaning.";

export interface RouterPromptRender {
	text?: string;
	portableCharacters: number;
	lines: number;
	error?: string;
	responsibleField?: string;
}
export interface RememberedLogicalSelections {
	providers?: Readonly<Record<string, string>>;
	compressorModel?: string;
}

function safeText(value: string): string {
	return value
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, " ")
		.replace(/[|`<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
function cell(values: readonly string[]): string { return values.length === 0 ? "none" : safeText(values.join(" / ")); }
export function portableRouterText(text: string, documentationDirectory = ""): string {
	return documentationDirectory === "" ? text : text.split(documentationDirectory).join("");
}
function responsibleField(policy: LogicalModelPolicy, lineOverflow: boolean): string {
	if (lineOverflow) return `ordinary membership (${policy.ordinary.length} model rows)`;
	let result = "ordinary membership";
	let size = 0;
	for (const model of policy.ordinary) {
		const contributions = [
			[`${model.model}.model`, safeText(model.model)],
			[`${model.model}.guidelines`, cell(model.guidelines)],
			[`${model.model}.cautions`, cell(model.cautions)],
		] as const;
		for (const [field, rendered] of contributions) {
			if (rendered.length > size) { size = rendered.length; result = field; }
		}
	}
	return result;
}
export function renderLogicalModelPrompt(policy: LogicalModelPolicy, documentationDirectory = ""): Readonly<RouterPromptRender> {
	const rows = policy.ordinary.map((model) => `| ${safeText(model.model)} | ${model.capabilityRating} | ${model.costRating} | ${cell(model.guidelines)} | ${cell(model.cautions)} |`);
	const text = [
		"Model routing policy:",
		...ROUTER_PROMPT_INSTRUCTIONS,
		"| logical model | capability rating | cost rating | guidelines | cautions |",
		"| --- | ---: | ---: | --- | --- |",
		...rows,
	].join("\n");
	const portableCharacters = portableRouterText(text, documentationDirectory).length;
	const lines = text.split("\n").length;
	if (portableCharacters > ROUTER_PROMPT_MAX_PORTABLE_CHARACTERS || lines > ROUTER_PROMPT_MAX_LINES) {
		const field = responsibleField(policy, lines > ROUTER_PROMPT_MAX_LINES);
		return Object.freeze({
			portableCharacters, lines, responsibleField: field,
			error: `Logical model policy is too large after sanitation and rendering: ${portableCharacters} portable characters and ${lines} lines. Limits are ${ROUTER_PROMPT_MAX_PORTABLE_CHARACTERS} characters and ${ROUTER_PROMPT_MAX_LINES} lines. Responsible field: ${field}. Nothing was truncated.`,
		});
	}
	return Object.freeze({ text, portableCharacters, lines });
}

function definitionOrder(policy: LogicalModelPolicy): LogicalModelDefinition[] {
	const names = [...policy.ordinary.map((model) => model.model), ...policy.compressor.map((entry) => entry.model)];
	return names.filter((name, index) => names.indexOf(name) === index).map((name) => policy.definitions[name]!).filter(Boolean);
}
function rememberedProvider(model: LogicalModelDefinition, remembered: RememberedLogicalSelections): string {
	const value = remembered.providers?.[model.model];
	if (value === undefined) return "none";
	return Object.prototype.hasOwnProperty.call(model.providers, value) ? safeText(value) : "invalid or unavailable";
}
export function renderEffectiveLogicalModelPolicy(resolution: LogicalPolicyResolution, remembered: RememberedLogicalSelections = {}): string {
	const lines = ["Effective logical model policy"];
	if (resolution.errors.length > 0) {
		lines.push("Status: blocked. No usable policy was produced.");
		lines.push("Errors:");
		for (const error of resolution.errors) lines.push(`- ${safeText(error)}`);
	} else {
		lines.push("Status: usable.");
	}
	if (resolution.warnings.length > 0) {
		lines.push("Warnings and ignored legacy keys:");
		for (const warning of resolution.warnings) lines.push(`- ${safeText(warning)}`);
	} else lines.push("Warnings: none.");
	const policy = resolution.policy;
	if (!policy) {
		lines.push("Ordinary membership: unavailable because validation blocked the policy.");
		lines.push("Compressor order: unavailable because validation blocked the policy.");
		lines.push(GUIDANCE_MEANING);
		lines.push(RATING_MEANING);
		lines.push(RATING_LIMITS);
		lines.push("Runtime evidence limits: static policy does not prove task quality, registry presence, credentials, authorization, provider equivalence, or availability.");
		return lines.join("\n");
	}
	lines.push(`Ordinary membership in configured order after exclusion: ${policy.ordinary.length === 0 ? "empty" : policy.ordinary.map((model) => safeText(model.model)).join(", ")}`);
	lines.push("Definitions used by ordinary or compressor policy:");
	for (const model of definitionOrder(policy)) {
		lines.push(`- ${safeText(model.model)}: capabilityRating=${model.capabilityRating}; costRating=${model.costRating}; fixedEffort=${model.effort}; preferredProvider=${safeText(model.preferredProvider)}; rememberedProvider=${rememberedProvider(model, remembered)}`);
		for (const [provider, physical] of Object.entries(model.providers)) lines.push(`  permission ${safeText(provider)}/${safeText(physical)}`);
		lines.push(`  guidelines: ${cell(model.guidelines)}`);
		lines.push(`  cautions: ${cell(model.cautions)}`);
	}
	lines.push("Compressor order is independent from ordinary membership:");
	for (const [index, entry] of policy.compressor.entries()) lines.push(`${index + 1}. ${safeText(entry.model)} @ ${entry.effort}`);
	const compressorRemembered = remembered.compressorModel === undefined
		? "none"
		: policy.compressor.some((entry) => entry.model === remembered.compressorModel)
			? safeText(remembered.compressorModel)
			: "invalid or unavailable";
	lines.push(`Remembered compressor selection: ${compressorRemembered}`);
	lines.push("Remembered selections are runtime facts. Static preferred providers are configuration facts.");
	lines.push(GUIDANCE_MEANING);
	lines.push(RATING_MEANING);
	lines.push(RATING_LIMITS);
	lines.push("Runtime evidence limits: static policy does not prove task quality, registry presence, credentials, authorization, provider equivalence, or availability.");
	return lines.join("\n");
}
