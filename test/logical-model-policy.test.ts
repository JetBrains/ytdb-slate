import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { SHIPPED_COMPRESSOR_MODELS, SHIPPED_LOGICAL_MODELS, type LogicalModelDefinition } from "../extension/logical-model-definitions.ts";
import { resolveLogicalModelPolicy, type LogicalModelPolicy } from "../extension/logical-model-resolver.ts";
import { renderEffectiveLogicalModelPolicy, renderLogicalModelPrompt } from "../extension/logical-model-render.ts";
import { REVIEWED_LOGICAL_MODEL_EDGES, REVIEWED_NON_LITERAL_MODULE_SITES, analyzeLogicalModelSources, scanLogicalModelImports } from "../verification/logical-model-import-check.ts";

const REPOSITORY_ROOT = process.cwd();
const resolve = (projectConfig?: unknown, trusted = true) => resolveLogicalModelPolicy({ trusted, projectConfig });
const validCustom = { model: "custom-model", capabilityRating: 52, effort: "high", costRating: 25, preferredProvider: "custom", providers: { custom: "vendor/model-v1" }, guidelines: ["bounded custom work"], cautions: [] };
const SOURCE = {
  capabilityRating: { publisher: "DeepSWE/DataCurve", retrieved: "2026-09-11", sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json", basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence" },
  costRating: { publisher: "DeepSWE/DataCurve", retrieved: "2026-09-11", sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json", basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence" },
  guidelines: { publisher: "DeepSWE/DataCurve", retrieved: "2026-09-11", sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json", basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence" },
};
const EXPECTED_GUIDANCE_MEANING = "Guidance and cautions direct selection, but Slate does not enforce them at runtime. Shipped preferences are not rigid rankings and do not guarantee quality. Apply a more specific active guideline when it states an exception to a general preference. A reference to another model describes a conditional preference and does not require selecting an excluded model. Trusted project definitions can replace shipped guidance, and custom model definitions remain supported. Guidance and cautions create no runtime eligibility or rejection rules.";
const EXPECTED_ROUTER_PROMPT_INSTRUCTIONS = [
  `Select a logical model for the current action. Use action fit, relevant area guidance, behavioral cautions, capability evidence, and a lower supported cost rating. A higher capability rating or higher cost rating is not enough by itself. Reassess after each episode. Change models only when there is a concrete reason and an expected benefit. Keep quality redispatch separate from transient recovery. ${EXPECTED_GUIDANCE_MEANING}`,
  "Capability and cost ratings are fixed project judgments expressed as integers from 1 through 100. Higher capability means stronger expected capability. Higher cost means greater expected expense. Ratings stay fixed when membership changes. Ties are valid, and ratings form no fixed groups. They are not percentages, measurements, ratios, statistical claims, realized costs, or billing forecasts. A small gap has no claimed statistical significance, and the endpoints have no fixed absolute meaning.",
] as const;
const EXPECTED_DEFAULT_PROMPT_LINES = [
  "Model routing policy:",
  EXPECTED_ROUTER_PROMPT_INSTRUCTIONS[0],
  EXPECTED_ROUTER_PROMPT_INSTRUCTIONS[1],
  "| logical model | capability rating | cost rating | guidelines | cautions |",
  "| --- | ---: | ---: | --- | --- |",
  "| gpt-5.6-luna | 45 | 10 | auxiliary tasks only, such as file location or check-result collection / never primary research, implementation, design, or review / consumer-contract work only when auxiliary | May treat supplied repair context as permission to implement despite explicit task limits. Restrict write access for record-only work and verify the changed files. |",
  "| claude-sonnet-5 | 40 | 90 | none | May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements. |",
  "| gpt-5.6-terra | 50 | 55 | none | none |",
  "| gpt-5.6-sol | 58 | 40 | default thread choice / prefer for changes that amend prose or governing rules expressed in prose / this Sol preference overrides the general Flash preference / the Astra preference for design and code reviewers of focus areas that trigger high-level design overrides this Sol preference / Sol should remain available when Gemini produces weak evidence, misses a requirement, or when a different approach could help. / Switching models should have a concrete reason. | When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action. |",
  "| gemini-3.8-flash | 55 | 30 | default thread choice / generally prefer over Sol and Luna when available / a more specific active guideline overrides this general Flash preference / concurrency work / data-loss work / performance work | Verify source citations and distinguish proposed behavior from existing behavior in design reviews. |",
  "| claude-opus-5 | 72 | 80 | concurrency work / data-loss work / performance work | May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements. |",
  "| gpt-6-astra | 86 | 60 | prefer when available for design and code reviewers of focus areas that trigger high-level design / this Astra preference overrides the Sol prose preference / security work / performance work | none |",
] as const;

function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

const COMPLETE_DEFAULTS = [
  { model: "gpt-5.6-luna", capabilityRating: 45, effort: "max", costRating: 10, preferredProvider: "openai", providers: { openai: "gpt-5.6-luna" }, guidelines: ["auxiliary tasks only, such as file location or check-result collection", "never primary research, implementation, design, or review", "consumer-contract work only when auxiliary"], cautions: ["May treat supplied repair context as permission to implement despite explicit task limits. Restrict write access for record-only work and verify the changed files."], source: SOURCE },
  { model: "claude-sonnet-5", capabilityRating: 40, effort: "high", costRating: 90, preferredProvider: "anthropic", providers: { anthropic: "claude-sonnet-5" }, guidelines: [], cautions: ["May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements."], source: SOURCE },
  { model: "gpt-5.6-terra", capabilityRating: 50, effort: "max", costRating: 55, preferredProvider: "openai", providers: { openai: "gpt-5.6-terra" }, guidelines: [], cautions: [], source: SOURCE },
  { model: "gpt-5.6-sol", capabilityRating: 58, effort: "high", costRating: 40, preferredProvider: "openai", providers: { openai: "gpt-5.6-sol" }, guidelines: ["default thread choice", "prefer for changes that amend prose or governing rules expressed in prose", "this Sol preference overrides the general Flash preference", "the Astra preference for design and code reviewers of focus areas that trigger high-level design overrides this Sol preference", "Sol should remain available when Gemini produces weak evidence, misses a requirement, or when a different approach could help.", "Switching models should have a concrete reason."], cautions: ["When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action."], source: SOURCE },
  { model: "gemini-3.8-flash", capabilityRating: 55, effort: "medium", costRating: 30, preferredProvider: "google-vertex", providers: { "google-vertex": "gemini-3.8-flash" }, guidelines: ["default thread choice", "generally prefer over Sol and Luna when available", "a more specific active guideline overrides this general Flash preference", "concurrency work", "data-loss work", "performance work"], cautions: ["Verify source citations and distinguish proposed behavior from existing behavior in design reviews."], source: SOURCE },
  { model: "claude-opus-5", capabilityRating: 72, effort: "high", costRating: 80, preferredProvider: "anthropic", providers: { anthropic: "claude-opus-5" }, guidelines: ["concurrency work", "data-loss work", "performance work"], cautions: ["May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements."], source: SOURCE },
  { model: "gpt-6-astra", capabilityRating: 86, effort: "medium", costRating: 60, preferredProvider: "openai", providers: { openai: "gpt-6-astra" }, guidelines: ["prefer when available for design and code reviewers of focus areas that trigger high-level design", "this Astra preference overrides the Sol prose preference", "security work", "performance work"], cautions: [], source: SOURCE },
];

test("project configuration selects the exact approved logical defaults", () => {
  const config = JSON.parse(readFileSync(join(process.cwd(), ".pi", "slate.json"), "utf8"));
  assert.deepEqual(config, {
    orchestratorModeDefault: true,
    workflow: { draftPRs: true, routingRecommendations: true },
    router: {
      models: { include: COMPLETE_DEFAULTS.map((row) => row.model) },
      compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }] },
    },
    workerExtensions: ["pi-smart-fetch", "pi-web-search"],
  });
  const resolution = resolve(config);
  assert.deepEqual(resolution.policy?.ordinary.map((row) => row.model), COMPLETE_DEFAULTS.map((row) => row.model));
  assert.deepEqual(resolution.policy?.compressor, [{ model: "claude-sonnet-5", effort: "medium" }]);
});

test("documented add and replace JSON examples resolve through production policy", () => {
  const document = readFileSync(join(process.cwd(), "docs", "model-routing.md"), "utf8");
  const example = (label: "add" | "replace"): unknown => {
    const match = new RegExp("Complete `" + label + "` example:\\n\\n```json\\n([\\s\\S]*?)\\n```").exec(document);
    assert.ok(match?.[1], `missing ${label} JSON example`);
    return JSON.parse(match[1]);
  };

  const added = resolve(example("add"));
  assert.deepEqual(added.errors, []);
  assert.deepEqual(added.policy?.ordinary.map((row) => row.model), ["project-fast"]);
  assert.deepEqual({ ...added.policy?.definitions["project-fast"]?.providers }, {
    acme: "acme-fast-v2",
    "acme-backup": "acme/fast-v2",
  });

  const replaced = resolve(example("replace"));
  assert.deepEqual(replaced.errors, []);
  assert.deepEqual(plain(replaced.policy?.definitions["gpt-5.6-sol"]), {
    model: "gpt-5.6-sol",
    capabilityRating: 58,
    effort: "max",
    costRating: 40,
    preferredProvider: "gateway",
    providers: { gateway: "openai/gpt-5.6-sol" },
    guidelines: ["repository-wide implementation"],
    cautions: [],
  });
});

test("shipped definitions match the complete approved literal", () => {
  assert.deepEqual(plain(SHIPPED_LOGICAL_MODELS), COMPLETE_DEFAULTS);
  assert.deepEqual(SHIPPED_COMPRESSOR_MODELS, [{ model: "claude-sonnet-5", effort: "medium" }]);
  assert.equal(SHIPPED_LOGICAL_MODELS.some((row) => row.model.includes("fable")), false);
  assert.equal(SHIPPED_LOGICAL_MODELS.every((row) => Object.isFrozen(row) && Object.isFrozen(row.providers) && Object.isFrozen(row.guidelines) && Object.isFrozen(row.cautions) && Object.isFrozen(row.source) && Object.isFrozen(row.source?.capabilityRating)), true);
});

test("default ratings remain fixed and the policy is deeply immutable", () => {
  const result = resolve();
  assert.deepEqual(result.policy?.ordinary.map((row) => [row.model, row.capabilityRating, row.costRating]), COMPLETE_DEFAULTS.map((row) => [row.model, row.capabilityRating, row.costRating]));
  assert.equal(Object.isFrozen(result) && Object.isFrozen(result.policy) && Object.isFrozen(result.policy?.ordinary) && Object.isFrozen(result.policy?.definitions), true);
  assert.throws(() => (result.policy!.ordinary[0]!.guidelines as string[]).push("mutation"), TypeError);
});

test("trusted membership applies include then add then exclusion while compressors stay independent", () => {
  const result = resolve({ router: { models: { include: ["gpt-5.6-sol"], add: [validCustom], exclude: ["gpt-5.6-sol"] }, compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }, { model: "custom-model", effort: "high" }] } } });
  assert.deepEqual(result.policy?.ordinary.map((row) => row.model), ["custom-model"]);
  assert.deepEqual(result.policy?.ordinary.map((row) => [row.capabilityRating, row.costRating]), [[52, 25]]);
  assert.deepEqual(result.policy?.compressor, [{ model: "claude-sonnet-5", effort: "medium" }, { model: "custom-model", effort: "high" }]);
});

test("include empty is distinct from omission and add still applies", () => {
  assert.deepEqual(resolve({ router: { models: { include: [] } } }).policy?.ordinary, []);
  assert.deepEqual(resolve({ router: { models: { include: [], add: [validCustom] } } }).policy?.ordinary.map((row) => row.model), ["custom-model"]);
  assert.equal(resolve().policy?.ordinary.length, 7);
});

test("replace inherits fields and replaces maps and lists as whole values", () => {
  const result = resolve({ router: { models: { replace: [{ model: "gpt-5.6-sol", preferredProvider: "gateway", providers: { gateway: "openai/gpt-5.6-sol" }, guidelines: ["new guide"], cautions: [] }] } } });
  const row = result.policy?.definitions["gpt-5.6-sol"];
  assert.ok(row);
  assert.deepEqual([row.capabilityRating, row.effort, row.costRating], [58, "high", 40]);
  assert.deepEqual({ ...row.providers }, { gateway: "openai/gpt-5.6-sol" });
  assert.deepEqual(row.guidelines, ["new guide"]);
  assert.deepEqual(row.cautions, []);
  assert.ok(row.source?.capabilityRating && row.source.costRating);
  assert.equal(row.source.guidelines, undefined);
});

test("field attribution survives equal and unrelated replacements and clears only changed facts", () => {
  const cases = [
    [{ preferredProvider: "gateway", providers: { gateway: "gpt-5.6-sol" } }, [true, true, true]],
    [{ cautions: ["changed"] }, [true, true, true]],
    [{ guidelines: ["default thread choice", "prefer for changes that amend prose or governing rules expressed in prose", "this Sol preference overrides the general Flash preference", "the Astra preference for design and code reviewers of focus areas that trigger high-level design overrides this Sol preference", "Sol should remain available when Gemini produces weak evidence, misses a requirement, or when a different approach could help.", "Switching models should have a concrete reason."] }, [true, true, true]],
    [{ capabilityRating: 58 }, [true, true, true]],
    [{ costRating: 40 }, [true, true, true]],
    [{ capabilityRating: 59 }, [false, true, true]],
    [{ costRating: 41 }, [true, false, true]],
    [{ guidelines: ["changed"] }, [true, true, false]],
    [{ effort: "max", capabilityRating: 58, costRating: 40 }, [false, false, true]],
  ] as const;
  for (const [change, expected] of cases) {
    const row = resolve({ router: { models: { replace: [{ model: "gpt-5.6-sol", ...change }] } } }).policy?.definitions["gpt-5.6-sol"];
    assert.ok(row, JSON.stringify(change));
    assert.deepEqual([!!row.source?.capabilityRating, !!row.source?.costRating, !!row.source?.guidelines], expected, JSON.stringify(change));
  }
});

test("repeated effort needs no ratings while an actual change needs both", () => {
  assert.equal(resolve({ router: { models: { replace: [{ model: "gpt-5.6-sol", effort: "high" }] } } }).policy?.definitions["gpt-5.6-sol"]?.effort, "high");
  const bad = resolve({ router: { models: { replace: [{ model: "gpt-5.6-sol", effort: "max" }] } } });
  assert.equal(bad.policy, undefined);
  assert.deepEqual(bad.errors.filter((error) => error.includes("changes effort")), ["router.models.replace[0] changes effort and must also supply capabilityRating and costRating."]);
  assert.equal(resolve({ router: { models: { replace: [{ model: "gpt-5.6-sol", effort: "max", capabilityRating: 59, costRating: 41 }] } } }).policy?.definitions["gpt-5.6-sol"]?.effort, "max");
});

test("one-defect definition fixtures independently block each validation rule", () => {
  const cases: [string, unknown, RegExp][] = [
    ["logical name", { ...validCustom, model: "bad/name" }, /model must be one provider-free logical name/],
    ["capability low", { ...validCustom, capabilityRating: 0 }, /capabilityRating must be an integer from 1 through 100/],
    ["capability fractional", { ...validCustom, capabilityRating: 50.5 }, /capabilityRating must be an integer from 1 through 100/],
    ["capability high", { ...validCustom, capabilityRating: 101 }, /capabilityRating must be an integer from 1 through 100/],
    ["cost low", { ...validCustom, costRating: 0 }, /costRating must be an integer from 1 through 100/],
    ["cost fractional", { ...validCustom, costRating: 50.5 }, /costRating must be an integer from 1 through 100/],
    ["cost high", { ...validCustom, costRating: 101 }, /costRating must be an integer from 1 through 100/],
    ["effort", { ...validCustom, effort: "med" }, /effort must be one of/],
    ["provider name", { ...validCustom, preferredProvider: "bad provider", providers: { custom: "vendor/model-v1" } }, /preferredProvider must be one exact provider name/],
    ["provider membership", { ...validCustom, preferredProvider: "missing" }, /preferredProvider must be present/],
    ["physical identifier", { ...validCustom, providers: { custom: "bad id" } }, /must be one exact Pi model identifier/],
    ["guidelines", { ...validCustom, guidelines: [""] }, /guidelines\[0\] must be a non-empty string/],
    ["cautions", { ...validCustom, cautions: "wrong" }, /cautions must be an array of strings/],
  ];
  for (const [label, candidate, expected] of cases) {
    const result = resolve({ router: { models: { add: [candidate] } } });
    assert.equal(result.policy, undefined, label);
    assert.match(result.errors.join("\n"), expected, label);
  }
});

test("unknown fields at every router level independently block", () => {
  const cases = [
    ["router models typo", { router: { modles: {} } }, "router has unknown field \"modles\"."],
    ["router compressor typo", { router: { compresor: {} } }, "router has unknown field \"compresor\"."],
    ["complete add", { router: { models: { add: [{ ...validCustom, unexpected: true }] } } }, "router.models.add[0] has unknown field \"unexpected\"."],
    ["partial replace", { router: { models: { replace: [{ model: "gpt-5.6-sol", unexpected: true }] } } }, "router.models.replace[0] has unknown field \"unexpected\"."],
    ["models section", { router: { models: { unexpected: true } } }, "router.models has unknown field \"unexpected\"."],
    ["compressor entry", { router: { compressor: { models: [{ model: "claude-sonnet-5", effort: "medium", unexpected: true }] } } }, "router.compressor.models[0] has unknown field \"unexpected\"."],
  ] as const;
  for (const [label, config, expected] of cases) {
    const result = resolve(config);
    assert.equal(result.policy, undefined, label);
    assert.deepEqual(result.errors, [expected], label);
  }
});

test("one-defect membership and compressor fixtures independently block", () => {
  const cases: [string, unknown, RegExp][] = [
    ["unknown include", { router: { models: { include: ["absent"] } } }, /include references unknown model/],
    ["unknown exclude", { router: { models: { exclude: ["absent"] } } }, /exclude references unknown model/],
    ["duplicate include", { router: { models: { include: ["gpt-5.6-sol", "gpt-5.6-sol"] } } }, /contains duplicate model/],
    ["duplicate add", { router: { models: { add: [validCustom, validCustom] } } }, /contains duplicate model/],
    ["existing add", { router: { models: { add: [{ ...validCustom, model: "gpt-5.6-sol" }] } } }, /cannot replace existing model/],
    ["unknown replace", { router: { models: { replace: [{ model: "absent", guidelines: [] }] } } }, /replace targets unknown model/],
    ["ambiguous add replace", { router: { models: { add: [validCustom], replace: [{ model: "custom-model", guidelines: [] }] } } }, /both add and replace/],
    ["empty compressor", { router: { compressor: { models: [] } } }, /compressor.models must not be empty/],
    ["unknown compressor", { router: { compressor: { models: [{ model: "absent", effort: "medium" }] } } }, /references unknown model/],
  ];
  for (const [label, config, expected] of cases) {
    const result = resolve(config);
    assert.equal(result.policy, undefined, label);
    assert.match(result.errors.join("\n"), expected, label);
  }
});

test("null-prototype dictionaries survive every clone and index build", () => {
  const policy = resolve().policy!;
  for (const row of [...policy.ordinary, ...Object.values(policy.definitions)]) assert.equal(Object.getPrototypeOf(row.providers), null);
  assert.equal(Object.getPrototypeOf(policy.definitions), null);
  for (const key of ["toString", "constructor", "__proto__"]) {
    assert.equal(policy.definitions[key], undefined);
    assert.equal(policy.ordinary[0]?.providers[key], undefined);
  }
});

test("legacy keys warn visibly and current configuration wins without migration", () => {
  const result = resolve({ modelFailover: {}, episodeModel: "old", router: { allowUnmeasuredEffort: true, showWarnings: false, models: { include: ["gpt-5.6-sol"] } } });
  assert.deepEqual(result.policy?.ordinary.map((row) => row.model), ["gpt-5.6-sol"]);
  assert.deepEqual(result.warnings, [
    "Legacy key modelFailover is ignored. Use router.models or router.compressor.models. No automatic migration is performed.",
    "Legacy key episodeModel is ignored. Use router.models or router.compressor.models. No automatic migration is performed.",
    "Legacy key router.allowUnmeasuredEffort is ignored. No automatic migration is performed.",
    "Legacy key router.showWarnings is ignored. No automatic migration is performed.",
  ]);
  const array = resolve({ router: { models: ["openai/gpt-5.6-sol"] } });
  assert.ok(array.policy);
  assert.match(array.warnings.join("\n"), /array form is not migrated/);
});

test("the trust gate does not consume or report untrusted project values", () => {
  let reads = 0;
  const value = Object.defineProperty({}, "router", { enumerable: true, get() { reads++; throw new Error("must not read"); } });
  const result = resolve(value, false);
  assert.equal(reads, 0);
  assert.equal(result.policy?.ordinary.length, 7);
  assert.deepEqual([result.errors, result.warnings], [[], []]);
});

test("the default prompt equals one complete independent literal for every row and column", () => {
  const rendered = renderLogicalModelPrompt(resolve().policy!);
  assert.equal(rendered.text, EXPECTED_DEFAULT_PROMPT_LINES.join("\n"));
  assert.equal(rendered.lines, EXPECTED_DEFAULT_PROMPT_LINES.length);
  assert.equal(rendered.portableCharacters, EXPECTED_DEFAULT_PROMPT_LINES.join("\n").length);
  assert.equal(rendered.error, undefined);
});

test("prompt rendering pins exact instructions, columns, sanitation, and determinism", () => {
  const result = resolve({ router: { models: { replace: [{ model: "gpt-5.6-sol", guidelines: ["safe | forged\n| row | <tag> `code` \u202esecret"], cautions: [] }] } } });
  const first = renderLogicalModelPrompt(result.policy!);
  assert.deepEqual(first, renderLogicalModelPrompt(result.policy!));
  assert.ok(first.text);
  assert.equal(first.text.split("\n").slice(1, 3).join("\n"), EXPECTED_ROUTER_PROMPT_INSTRUCTIONS.join("\n"));
  assert.match(first.text, /\| logical model \| capability rating \| cost rating \| guidelines \| cautions \|/);
  assert.doesNotMatch(first.text, /forged\n|<tag>|`code`|\u202e|preferredProvider=|fixedEffort=|permission [a-z]+\//i);
  assert.doesNotMatch(first.text, /benchmark|raw rate|capability band|relative reference cost/i);
});

test("trusted replacements remove shipped model rules from prompt and effective output", () => {
  const replacements = ["gpt-5.6-luna", "gpt-5.6-sol", "gemini-3.8-flash", "gpt-6-astra"].map((model) => ({ model, guidelines: [`custom guidance for ${model}`] }));
  const resolution = resolve({ router: { models: { replace: replacements } } });
  assert.ok(resolution.policy);
  const prompt = renderLogicalModelPrompt(resolution.policy).text;
  const effective = renderEffectiveLogicalModelPolicy(resolution);
  assert.ok(prompt);
  for (const replacement of replacements) {
    assert.match(prompt, new RegExp(`custom guidance for ${replacement.model}`));
    assert.match(effective, new RegExp(`custom guidance for ${replacement.model}`));
  }
  for (const staleRule of [
    "The Sol preference for changes that amend prose or governing rules expressed in prose overrides the general Flash preference.",
    "It does not override the Astra preference for design and code reviews of focus areas that trigger high-level design.",
    "The shipped Luna guidance restricts selection to auxiliary tasks.",
  ]) {
    assert.equal(prompt.includes(staleRule), false);
    assert.equal(effective.includes(staleRule), false);
  }
  assert.ok(prompt.includes(EXPECTED_GUIDANCE_MEANING));
  assert.ok(effective.includes(EXPECTED_GUIDANCE_MEANING));
});

test("remaining active guidance may refer to excluded models without selecting them", () => {
  const resolution = resolve({ router: { models: { include: ["gpt-5.6-sol"], exclude: ["gpt-5.6-luna", "gemini-3.8-flash", "gpt-6-astra"] } } });
  assert.ok(resolution.policy);
  const prompt = renderLogicalModelPrompt(resolution.policy).text;
  const effective = renderEffectiveLogicalModelPolicy(resolution);
  assert.ok(prompt);
  assert.match(prompt, /this Sol preference overrides the general Flash preference/);
  assert.match(prompt, /the Astra preference[^|]+overrides this Sol preference/);
  assert.match(effective, /this Sol preference overrides the general Flash preference/);
  assert.match(effective, /the Astra preference[^\n]+overrides this Sol preference/);
  for (const excluded of ["gpt-5.6-luna", "gemini-3.8-flash", "gpt-6-astra"]) {
    assert.equal(prompt.includes(`| ${excluded} |`), false);
    assert.equal(effective.includes(`- ${excluded}:`), false);
  }
});

function clonePolicy(policy: LogicalModelPolicy, ordinary: LogicalModelDefinition[]): LogicalModelPolicy {
  return { definitions: policy.definitions, ordinary, compressor: policy.compressor };
}
function paddedPolicy(target: number): LogicalModelPolicy {
  const base = resolve({ router: { models: { include: ["gpt-5.6-sol"] } } }).policy!;
  const row = base.ordinary[0]!;
  const zero = renderLogicalModelPrompt(clonePolicy(base, [{ ...row, guidelines: ["x"] }]));
  const padding = target - zero.portableCharacters + 1;
  assert.ok(padding > 0);
  return clonePolicy(base, [{ ...row, guidelines: ["x".repeat(padding)] }]);
}

test("prompt character budget accepts 19400 and rejects 19401 with sanitized attribution", () => {
  const accepted = renderLogicalModelPrompt(paddedPolicy(19_400));
  assert.equal(accepted.portableCharacters, 19_400);
  assert.ok(accepted.text);
  const rejected = renderLogicalModelPrompt(paddedPolicy(19_401));
  assert.equal(rejected.portableCharacters, 19_401);
  assert.equal(rejected.text, undefined);
  assert.equal(rejected.responsibleField, "gpt-5.6-sol.guidelines");
  assert.match(rejected.error ?? "", /Nothing was truncated/);
});

function linePolicy(rows: number): LogicalModelPolicy {
  const base = resolve().policy!;
  const template = { ...base.ordinary[0]!, guidelines: [], cautions: [] };
  const ordinary = Array.from({ length: rows }, (_, index) => ({ ...template, model: `m${index}` }));
  return clonePolicy(base, ordinary);
}

test("prompt line budget accepts 105 and rejects 106 with membership attribution", () => {
  const accepted = renderLogicalModelPrompt(linePolicy(100));
  assert.equal(accepted.lines, 105);
  assert.ok(accepted.text);
  const rejected = renderLogicalModelPrompt(linePolicy(101));
  assert.equal(rejected.lines, 106);
  assert.equal(rejected.text, undefined);
  assert.equal(rejected.responsibleField, "ordinary membership (101 model rows)");
});

test("effective output is a complete literal for success and compressor-only permission", () => {
  const resolution = resolve({ modelFailover: {}, router: { models: { include: ["gpt-5.6-sol"] } } });
  assert.equal(renderEffectiveLogicalModelPolicy(resolution, { providers: { "gpt-5.6-sol": "openai" }, compressorModel: "claude-sonnet-5" }), `Effective logical model policy
Status: usable.
Warnings and ignored legacy keys:
- Legacy key modelFailover is ignored. Use router.models or router.compressor.models. No automatic migration is performed.
Ordinary membership in configured order after exclusion: gpt-5.6-sol
Definitions used by ordinary or compressor policy:
- gpt-5.6-sol: capabilityRating=58; costRating=40; fixedEffort=high; preferredProvider=openai; rememberedProvider=openai
  permission openai/gpt-5.6-sol
  guidelines: default thread choice / prefer for changes that amend prose or governing rules expressed in prose / this Sol preference overrides the general Flash preference / the Astra preference for design and code reviewers of focus areas that trigger high-level design overrides this Sol preference / Sol should remain available when Gemini produces weak evidence, misses a requirement, or when a different approach could help. / Switching models should have a concrete reason.
  cautions: When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action.
- claude-sonnet-5: capabilityRating=40; costRating=90; fixedEffort=high; preferredProvider=anthropic; rememberedProvider=none
  permission anthropic/claude-sonnet-5
  guidelines: none
  cautions: May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements.
Compressor order is independent from ordinary membership:
1. claude-sonnet-5 @ medium
Remembered compressor selection: claude-sonnet-5
Remembered selections are runtime facts. Static preferred providers are configuration facts.
${EXPECTED_GUIDANCE_MEANING}
Rating meaning: capability and cost ratings are fixed project judgments expressed as integers from 1 through 100. Higher capability means stronger expected capability. Higher cost means greater expected expense. Ratings stay fixed when membership changes. Ties are valid, and ratings form no fixed groups.
Rating limits: ratings are not percentages, measurements, ratios, statistical claims, realized costs, or billing forecasts. A small gap has no claimed statistical significance, and the endpoints have no fixed absolute meaning.
Runtime evidence limits: static policy does not prove task quality, registry presence, credentials, authorization, provider equivalence, or availability.`);
});

test("effective output is a complete literal for blocked diagnostics", () => {
  const text = renderEffectiveLogicalModelPolicy(resolve({ episodeModel: "old", router: { compressor: { models: [] } } }));
  assert.equal(text, `Effective logical model policy
Status: blocked. No usable policy was produced.
Errors:
- router.compressor.models must not be empty. No hidden compressor fallback is approved.
Warnings and ignored legacy keys:
- Legacy key episodeModel is ignored. Use router.models or router.compressor.models. No automatic migration is performed.
Ordinary membership: unavailable because validation blocked the policy.
Compressor order: unavailable because validation blocked the policy.
${EXPECTED_GUIDANCE_MEANING}
Rating meaning: capability and cost ratings are fixed project judgments expressed as integers from 1 through 100. Higher capability means stronger expected capability. Higher cost means greater expected expense. Ratings stay fixed when membership changes. Ties are valid, and ratings form no fixed groups.
Rating limits: ratings are not percentages, measurements, ratios, statistical claims, realized costs, or billing forecasts. A small gap has no claimed statistical significance, and the endpoints have no fixed absolute meaning.
Runtime evidence limits: static policy does not prove task quality, registry presence, credentials, authorization, provider equivalence, or availability.`);
});

test("effective output is a complete literal for invalid remembered values", () => {
  const resolution = resolve({ router: { models: { include: ["gpt-5.6-sol"] } } });
  const text = renderEffectiveLogicalModelPolicy(resolution, { providers: { "gpt-5.6-sol": "secret; forged=value" }, compressorModel: "secret-compressor" });
  assert.equal(text, `Effective logical model policy
Status: usable.
Warnings: none.
Ordinary membership in configured order after exclusion: gpt-5.6-sol
Definitions used by ordinary or compressor policy:
- gpt-5.6-sol: capabilityRating=58; costRating=40; fixedEffort=high; preferredProvider=openai; rememberedProvider=invalid or unavailable
  permission openai/gpt-5.6-sol
  guidelines: default thread choice / prefer for changes that amend prose or governing rules expressed in prose / this Sol preference overrides the general Flash preference / the Astra preference for design and code reviewers of focus areas that trigger high-level design overrides this Sol preference / Sol should remain available when Gemini produces weak evidence, misses a requirement, or when a different approach could help. / Switching models should have a concrete reason.
  cautions: When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action.
- claude-sonnet-5: capabilityRating=40; costRating=90; fixedEffort=high; preferredProvider=anthropic; rememberedProvider=none
  permission anthropic/claude-sonnet-5
  guidelines: none
  cautions: May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements.
Compressor order is independent from ordinary membership:
1. claude-sonnet-5 @ medium
Remembered compressor selection: invalid or unavailable
Remembered selections are runtime facts. Static preferred providers are configuration facts.
${EXPECTED_GUIDANCE_MEANING}
Rating meaning: capability and cost ratings are fixed project judgments expressed as integers from 1 through 100. Higher capability means stronger expected capability. Higher cost means greater expected expense. Ratings stay fixed when membership changes. Ties are valid, and ratings form no fixed groups.
Rating limits: ratings are not percentages, measurements, ratios, statistical claims, realized costs, or billing forecasts. A small gap has no claimed statistical significance, and the endpoints have no fixed absolute meaning.
Runtime evidence limits: static policy does not prove task quality, registry presence, credentials, authorization, provider equivalence, or availability.`);
  assert.doesNotMatch(text, /secret|forged/);
});

test("the shared syntax check detects every approved literal form and ignores ordinary prose", () => {
  const longGap = " ".repeat(2_001);
  const sources = [
    { path: "extension/fixtures/named.ts", source: 'import { value } from "../logical-model-render.ts";' },
    { path: "extension/fixtures/commented.ts", source: 'import { value } from /* legal comment */ "../logical-model-resolver.ts";' },
    { path: "extension/fixtures/side-effect.ts", source: 'import /* legal comment */ "../logical-model-definitions.ts";' },
    { path: "extension/fixtures/type-only.ts", source: "import type { Value }\nfrom '../logical-model-render.ts';" },
    { path: "extension/fixtures/export-named.ts", source: 'export { value } from /* legal comment */ "../logical-model-render.js";' },
    { path: "extension/fixtures/export-star.ts", source: 'export * from "../logical-model-definitions";' },
    { path: "extension/fixtures/dynamic.ts", source: 'void import /* legal comment */ ("../logical-model-render.ts");' },
    { path: "extension/fixtures/template.ts", source: "void import(`../logical-model-resolver.ts`);" },
    { path: "extension/fixtures/require.ts", source: 'require("../logical-model-render.cjs");' },
    { path: "extension/fixtures/import-equals.ts", source: 'import Value = require("../logical-model-definitions.mts");' },
    { path: "extension/fixtures/long.ts", source: `import { value }${longGap}from "../logical-model-render.ts";` },
    { path: "extension/fixtures/runtime.mjs", source: 'export { value } from "../logical-model-resolver.jsx";' },
    { path: "extension/fixtures/harmless.ts", source: 'const note = "migration from \\\"../logical-model-render.ts\\\" is deferred";\n// import from "../logical-model-resolver.ts"' },
  ];
  const result = analyzeLogicalModelSources(sources, REPOSITORY_ROOT);
  const forbidden = result.issues.filter((issue) => issue.kind === "forbidden-reference");
  assert.equal(forbidden.length, 12);
  assert.deepEqual(new Set(forbidden.map((issue) => issue.target)), new Set([
    "extension/logical-model-definitions",
    "extension/logical-model-resolver",
    "extension/logical-model-render",
  ]));
  assert.deepEqual(result.issues.filter((issue) => issue.path.endsWith("harmless.ts")), []);
  assert.deepEqual(result.issues.filter((issue) => issue.kind !== "forbidden-reference"), []);
});

test("the shared syntax check fails closed for parse errors and unreviewed computed references", () => {
  const result = analyzeLogicalModelSources([
    { path: "extension/fixtures/computed.ts", source: "void import(target);" },
    { path: "extension/fixtures/broken.ts", source: 'import { from "./broken.ts";' },
  ], REPOSITORY_ROOT);
  assert.deepEqual(result.issues.map((issue) => issue.kind).sort(), ["computed-reference", "parse-error"]);
  assert.equal(result.issues.find((issue) => issue.kind === "computed-reference")?.expression, "target");
  assert.match(result.issues.find((issue) => issue.kind === "parse-error")?.message ?? "", /expected|declaration/i);
});

test("only the reviewed writing-checker computed import is accepted once", () => {
  const once = analyzeLogicalModelSources([{ path: "extension/writing.ts", source: "void import(WRITING_CHECKER_URL);" }], REPOSITORY_ROOT);
  assert.deepEqual(once.reviewedNonLiteralSites, REVIEWED_NON_LITERAL_MODULE_SITES);
  assert.deepEqual(once.issues, []);
  const twice = analyzeLogicalModelSources([{ path: "extension/writing.ts", source: "void import(WRITING_CHECKER_URL); void import(WRITING_CHECKER_URL);" }], REPOSITORY_ROOT);
  assert.deepEqual(twice.reviewedNonLiteralSites, REVIEWED_NON_LITERAL_MODULE_SITES);
  assert.deepEqual(twice.issues.map((issue) => issue.kind), ["computed-reference"]);
});

test("dormant target matching follows pinned jiti path and decoration behavior", { timeout: 15_000 }, async () => {
  const jitiUrl = pathToFileURL(join(REPOSITORY_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti-static.mjs")).href;
  const { createJiti } = await import(jitiUrl) as { createJiti(id: string, options?: object): { import(id: string): Promise<Record<string, unknown>> } };
  const nestedImporter = join(REPOSITORY_ROOT, "extension", "fixtures", "probe.ts");
  const jiti = createJiti(nestedImporter, { interopDefault: true, moduleCache: false });
  const targets = ["logical-model-definitions", "logical-model-resolver", "logical-model-render", "logical-model-recovery", "logical-model-adapters"];

  const check = async (specifier: string, expectedTarget: string | undefined, loads: boolean) => {
    if (loads) await jiti.import(specifier);
    else await assert.rejects(jiti.import(specifier), (error: unknown) => error instanceof Error, specifier);
    const result = analyzeLogicalModelSources([{ path: "extension/fixtures/probe.ts", source: `import ${JSON.stringify(specifier)};` }], REPOSITORY_ROOT);
    assert.deepEqual(result.issues.map((issue) => [issue.kind, issue.specifier, issue.target]), expectedTarget ? [["forbidden-reference", specifier, `extension/${expectedTarget}`]] : [], specifier);
  };

  for (const target of targets) {
    const absolute = join(REPOSITORY_ROOT, "extension", `${target}.ts`);
    await check(`../${target}.ts`, target, true);
    await check(absolute, target, true);
    await check(pathToFileURL(absolute).href, target, true);
  }

  const adapterPath = join(REPOSITORY_ROOT, "extension", "logical-model-adapters.ts");
  const adapterUrl = pathToFileURL(adapterPath).href;
  for (const specifier of [`../logical-model-adapters.ts?live`, `../logical-model-adapters.ts#live`, `${adapterPath}?live`, `${adapterPath}#live`, `${adapterUrl}?live`, `${adapterUrl}#live`, `${adapterUrl}%3Flive`, `${adapterUrl}%23live`]) {
    await check(specifier, "logical-model-adapters", true);
  }
  for (const specifier of [`../logical-model-adapters.ts%3Flive`, `${adapterPath}%3Flive`, `${adapterUrl}%253Flive`]) {
    await check(specifier, undefined, false);
  }

  const externalRoot = mkdtempSync(join(tmpdir(), "slate-logical-external-"));
  let passed = false;
  try {
    const external = join(externalRoot, "extension", "logical-model-adapters.ts");
    mkdirSync(join(externalRoot, "extension"), { recursive: true });
    writeFileSync(external, "export const marker = 77;\n");
    const externalSpecifier = `${pathToFileURL(external).href}?live`;
    const loaded = await jiti.import(externalSpecifier);
    assert.equal(loaded.marker, 77);
    await check(externalSpecifier, undefined, true);
    passed = true;
  } finally {
    if (passed) rmSync(externalRoot, { recursive: true, force: true });
    else process.stderr.write(`external same-tail fixture retained at ${externalRoot}\n`);
  }
});

test("recursive runtime-source scanning uses exact dormant paths and includes nested TypeScript and JavaScript", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-logical-import-fixture-"));
  let passed = false;
  try {
    const extension = join(root, "extension");
    mkdirSync(join(extension, "nested"), { recursive: true });
    for (const file of ["logical-model-definitions.ts", "logical-model-resolver.ts", "logical-model-render.ts", "logical-model-recovery.ts", "logical-model-adapters.ts"]) {
      writeFileSync(join(extension, file), "export {};\n");
    }
    writeFileSync(join(extension, "logical-model-render.mjs"), 'import "./logical-model-resolver.ts";');
    writeFileSync(join(extension, "nested", "logical-model-render.ts"), 'import "../logical-model-render.ts";');
    writeFileSync(join(extension, "nested", "logical-model-resolver.mjs"), 'export { value } from "../logical-model-definitions.ts";');
    writeFileSync(join(extension, "nested", "runtime.mjs"), 'void import("../logical-model-resolver.js");');
    writeFileSync(join(extension, "clean.ts"), 'const note = "from \\\"./logical-model-render.ts\\\"";');
    const result = scanLogicalModelImports(extension, []);
    assert.deepEqual(result.files, [
      "extension/clean.ts",
      "extension/logical-model-adapters.ts",
      "extension/logical-model-definitions.ts",
      "extension/logical-model-recovery.ts",
      "extension/logical-model-render.mjs",
      "extension/logical-model-render.ts",
      "extension/logical-model-resolver.ts",
      "extension/nested/logical-model-render.ts",
      "extension/nested/logical-model-resolver.mjs",
      "extension/nested/runtime.mjs",
    ]);
    assert.deepEqual(result.issues.map((issue) => [issue.kind, issue.path]), [
      ["forbidden-reference", "extension/logical-model-render.mjs"],
      ["forbidden-reference", "extension/nested/logical-model-render.ts"],
      ["forbidden-reference", "extension/nested/logical-model-resolver.mjs"],
      ["forbidden-reference", "extension/nested/runtime.mjs"],
    ]);
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`logical-model import fixture retained at ${root}\n`);
  }
});

test("the real resolver wrapper refuses a missing exact-pinned TypeScript compiler", { timeout: 15_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "slate-resolver-no-typescript-"));
  let passed = false;
  try {
    mkdirSync(join(root, "extension"), { recursive: true });
    writeFileSync(join(root, "extension", "worker-extensions.ts"), "export {};\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { typescript: "5.9.3" } }));
    const result = spawnSync("bash", [join(process.cwd(), "verification", "run-resolver-checks.sh"), "--repo", root, "--strict"], {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      env: { ...process.env, TMPDIR: process.env.TMPDIR ?? tmpdir() },
    });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /verification: refused to start — exact-pinned TypeScript compiler unavailable/);
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`missing-TypeScript wrapper fixture retained at ${root}\n`);
  }
});

test("the active logical-model graph equals the exact reviewed edge roster", () => {
  const result = scanLogicalModelImports("extension");
  assert.ok(result.files.length > 20);
  assert.equal(result.files.some((path) => path.endsWith(".mjs")), true);
  assert.deepEqual(result.reviewedLiteralEdges, REVIEWED_LOGICAL_MODEL_EDGES);
  assert.deepEqual(result.reviewedNonLiteralSites, REVIEWED_NON_LITERAL_MODULE_SITES);
  assert.deepEqual(result.issues, []);

  const one = "extension/consumer.ts|import|extension/logical-model-runtime";
  const source = [{ path: "extension/consumer.ts", source: 'import "./logical-model-runtime.ts";' }];
  assert.deepEqual(analyzeLogicalModelSources(source, REPOSITORY_ROOT, [], [one]).issues, []);
  assert.deepEqual(analyzeLogicalModelSources([], REPOSITORY_ROOT, [], [one]).issues.map((issue) => issue.kind), ["missing-reviewed-edge"]);
  assert.deepEqual(analyzeLogicalModelSources([{ ...source[0]!, source: `${source[0]!.source}\n${source[0]!.source}` }], REPOSITORY_ROOT, [], [one]).issues.map((issue) => issue.kind), ["forbidden-reference"]);
  assert.deepEqual(analyzeLogicalModelSources(source, REPOSITORY_ROOT, [], []).issues.map((issue) => issue.kind), ["forbidden-reference"]);
  assert.deepEqual(analyzeLogicalModelSources([{ path: "extension/failover.ts", source: "const forged = value as OpenModel;" }], REPOSITORY_ROOT, [], []).issues.map((issue) => issue.kind), ["unsafe-brand-cast"]);
});

test("the brand guard rejects exactly the approved assertion shapes in its bounded consumer", () => {
  const approved = [
    "value as SessionBaseline",
    "value as OpenModel",
    "value as unknown as SessionBaseline",
    "value as unknown as OpenModel",
    "value as any as SessionBaseline",
    "value as any as OpenModel",
    "<SessionBaseline>value",
    "<OpenModel>value",
    "value as never",
  ];
  for (const expression of approved) {
    const result = analyzeLogicalModelSources([{ path: "extension/threads.ts", source: `const forged = ${expression};` }], REPOSITORY_ROOT, [], []);
    assert.deepEqual(result.issues.map((issue) => issue.kind), ["unsafe-brand-cast"], expression);
    assert.equal(result.issues[0]?.expression, expression);
  }
  const producer = analyzeLogicalModelSources(approved.map((expression, index) => ({
    path: "extension/logical-model-runtime.ts",
    source: `const forged${index} = ${expression};`,
  })), REPOSITORY_ROOT, [], []);
  assert.deepEqual(producer.issues, [], "the exact authorized producer stays exempt");
  const secondConsumer = analyzeLogicalModelSources([
    { path: "extension/failover.ts", source: "const forgedBaseline = value as SessionBaseline;" },
    { path: "extension/failover.ts", source: "const forgedModel = value as OpenModel;" },
  ], REPOSITORY_ROOT, [], []);
  assert.deepEqual(secondConsumer.issues.map((issue) => issue.kind), ["unsafe-brand-cast", "unsafe-brand-cast"], "direct named as-assertions stay forbidden throughout the nonproducer scan scope");
  const outsideBound = analyzeLogicalModelSources([
    { path: "extension/tools.ts", source: "const renderAdapter = value as never;" },
    { path: "extension/fixture/consumer.ts", source: "const alias = value as Alias;" },
    { path: "extension/failover.ts", source: "const angle = <OpenModel>value;" },
  ], REPOSITORY_ROOT, [], []);
  assert.deepEqual(outsideBound.issues, [], "as-never and angle assertions stay bounded, and alias resolution stays outside scope");
});

test("the disconnected policy contains no retired external score or ratio vocabulary", () => {
  const retired = new RegExp(["Artificial", "Analysis|artificialanalysis\\.ai|referenceCostUsd|capabilityScore|relativeCost|displayRelativeCost|capabilityBand"].join(" "));
  for (const path of ["extension/logical-model-definitions.ts", "extension/logical-model-resolver.ts", "extension/logical-model-render.ts", "extension/logical-model-recovery.ts", "extension/logical-model-adapters.ts"]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), retired, path);
  }
});
