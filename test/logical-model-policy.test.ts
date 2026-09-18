import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SHIPPED_COMPRESSOR_MODELS, SHIPPED_LOGICAL_MODELS, type LogicalModelDefinition } from "../extension/logical-model-definitions.ts";
import { resolveLogicalModelPolicy, type LogicalModelPolicy } from "../extension/logical-model-resolver.ts";
import { renderEffectiveLogicalModelPolicy, renderLogicalModelPrompt } from "../extension/logical-model-render.ts";
import { REVIEWED_NON_LITERAL_MODULE_SITES, analyzeLogicalModelSources, scanLogicalModelImports } from "../verification/logical-model-import-check.ts";

const resolve = (projectConfig?: unknown, trusted = true) => resolveLogicalModelPolicy({ trusted, projectConfig });
const validCustom = { model: "custom-model", capabilityRating: 52, effort: "high", costRating: 25, preferredProvider: "custom", providers: { custom: "vendor/model-v1" }, guidelines: ["bounded custom work"], cautions: [] };
const SOURCE = {
  capabilityRating: { publisher: "DeepSWE/DataCurve", retrieved: "2026-09-11", sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json", basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence" },
  costRating: { publisher: "DeepSWE/DataCurve", retrieved: "2026-09-11", sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json", basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence" },
  guidelines: { publisher: "DeepSWE/DataCurve", retrieved: "2026-09-11", sourceUrl: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json", basis: "Project judgment informed by DeepSWE v1.1 and reviewed supporting evidence" },
};
const EXPECTED_ROUTER_PROMPT_INSTRUCTIONS = [
  "Select a logical model for the current action. Use action fit, relevant area guidance, behavioral cautions, capability evidence, and a lower supported cost rating. A higher capability rating or higher cost rating is not enough by itself. Reassess after each episode. Change models only for a concrete expected benefit. Keep quality redispatch separate from transient recovery. Guidance and cautions are advisory and non-exclusive. They do not create fixed roles, rankings, eligibility rules, or quality guarantees.",
  "Capability and cost ratings are fixed project judgments expressed as integers from 1 through 100. Higher capability means stronger expected capability. Higher cost means greater expected expense. Ratings stay fixed when membership changes. Ties are valid, and ratings form no fixed groups. They are not percentages, measurements, ratios, statistical claims, realized costs, or billing forecasts. A small gap has no claimed statistical significance, and the endpoints have no fixed absolute meaning.",
] as const;
const EXPECTED_DEFAULT_PROMPT_LINES = [
  "Model routing policy:",
  EXPECTED_ROUTER_PROMPT_INSTRUCTIONS[0],
  EXPECTED_ROUTER_PROMPT_INSTRUCTIONS[1],
  "| logical model | capability rating | cost rating | guidelines | cautions |",
  "| --- | ---: | ---: | --- | --- |",
  "| gpt-5.6-luna | 45 | 10 | consumer-contract work | none |",
  "| claude-sonnet-5 | 40 | 90 | none | May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements. |",
  "| gpt-5.6-terra | 50 | 55 | none | none |",
  "| gpt-5.6-sol | 58 | 40 | none | When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action. |",
  "| gemini-3.8-flash | 55 | 30 | concurrency work / data-loss work / performance work | none |",
  "| claude-opus-5 | 72 | 80 | concurrency work / data-loss work / performance work | May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements. |",
  "| gpt-6-astra | 86 | 60 | security work / performance work | none |",
] as const;

function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

const COMPLETE_DEFAULTS = [
  { model: "gpt-5.6-luna", capabilityRating: 45, effort: "max", costRating: 10, preferredProvider: "openai", providers: { openai: "gpt-5.6-luna" }, guidelines: ["consumer-contract work"], cautions: [], source: SOURCE },
  { model: "claude-sonnet-5", capabilityRating: 40, effort: "high", costRating: 90, preferredProvider: "anthropic", providers: { anthropic: "claude-sonnet-5" }, guidelines: [], cautions: ["May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements."], source: SOURCE },
  { model: "gpt-5.6-terra", capabilityRating: 50, effort: "max", costRating: 55, preferredProvider: "openai", providers: { openai: "gpt-5.6-terra" }, guidelines: [], cautions: [], source: SOURCE },
  { model: "gpt-5.6-sol", capabilityRating: 58, effort: "high", costRating: 40, preferredProvider: "openai", providers: { openai: "gpt-5.6-sol" }, guidelines: [], cautions: ["When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action."], source: SOURCE },
  { model: "gemini-3.8-flash", capabilityRating: 55, effort: "medium", costRating: 30, preferredProvider: "google-vertex", providers: { "google-vertex": "gemini-3.8-flash" }, guidelines: ["concurrency work", "data-loss work", "performance work"], cautions: [], source: SOURCE },
  { model: "claude-opus-5", capabilityRating: 72, effort: "high", costRating: 80, preferredProvider: "anthropic", providers: { anthropic: "claude-opus-5" }, guidelines: ["concurrency work", "data-loss work", "performance work"], cautions: ["May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements."], source: SOURCE },
  { model: "gpt-6-astra", capabilityRating: 86, effort: "medium", costRating: 60, preferredProvider: "openai", providers: { openai: "gpt-6-astra" }, guidelines: ["security work", "performance work"], cautions: [], source: SOURCE },
];

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
    [{ guidelines: [] }, [true, true, true]],
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

test("unknown fields in add, replace, router.models, and compressor entries independently block", () => {
  const cases = [
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
  const template = base.ordinary[0]!;
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
  guidelines: none
  cautions: When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action.
- claude-sonnet-5: capabilityRating=40; costRating=90; fixedEffort=high; preferredProvider=anthropic; rememberedProvider=none
  permission anthropic/claude-sonnet-5
  guidelines: none
  cautions: May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements.
Compressor order is independent from ordinary membership:
1. claude-sonnet-5 @ medium
Remembered compressor selection: claude-sonnet-5
Remembered selections are runtime facts. Static preferred providers are configuration facts.
Guidance and cautions are advisory and non-exclusive. They do not create fixed roles, rankings, eligibility rules, or quality guarantees.
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
Guidance and cautions are advisory and non-exclusive. They do not create fixed roles, rankings, eligibility rules, or quality guarantees.
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
  guidelines: none
  cautions: When blocked, may substitute unapproved resources or perform destructive cleanup. Require permission before either action.
- claude-sonnet-5: capabilityRating=40; costRating=90; fixedEffort=high; preferredProvider=anthropic; rememberedProvider=none
  permission anthropic/claude-sonnet-5
  guidelines: none
  cautions: May exceed explicit scope or infer permission from earlier requests. Check changes against stated exclusions and approval requirements.
Compressor order is independent from ordinary membership:
1. claude-sonnet-5 @ medium
Remembered compressor selection: invalid or unavailable
Remembered selections are runtime facts. Static preferred providers are configuration facts.
Guidance and cautions are advisory and non-exclusive. They do not create fixed roles, rankings, eligibility rules, or quality guarantees.
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
  const result = analyzeLogicalModelSources(sources);
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
  ]);
  assert.deepEqual(result.issues.map((issue) => issue.kind).sort(), ["computed-reference", "parse-error"]);
  assert.equal(result.issues.find((issue) => issue.kind === "computed-reference")?.expression, "target");
  assert.match(result.issues.find((issue) => issue.kind === "parse-error")?.message ?? "", /expected|declaration/i);
});

test("only the reviewed writing-checker computed import is accepted once", () => {
  const once = analyzeLogicalModelSources([{ path: "extension/writing.ts", source: "void import(WRITING_CHECKER_URL);" }]);
  assert.deepEqual(once.reviewedNonLiteralSites, REVIEWED_NON_LITERAL_MODULE_SITES);
  assert.deepEqual(once.issues, []);
  const twice = analyzeLogicalModelSources([{ path: "extension/writing.ts", source: "void import(WRITING_CHECKER_URL); void import(WRITING_CHECKER_URL);" }]);
  assert.deepEqual(twice.reviewedNonLiteralSites, REVIEWED_NON_LITERAL_MODULE_SITES);
  assert.deepEqual(twice.issues.map((issue) => issue.kind), ["computed-reference"]);
});

test("recursive runtime-source scanning uses exact dormant paths and includes nested TypeScript and JavaScript", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-logical-import-fixture-"));
  let passed = false;
  try {
    const extension = join(root, "extension");
    mkdirSync(join(extension, "nested"), { recursive: true });
    for (const file of ["logical-model-definitions.ts", "logical-model-resolver.ts", "logical-model-render.ts"]) {
      writeFileSync(join(extension, file), "this is deliberately invalid dormant syntax");
    }
    writeFileSync(join(extension, "logical-model-render.mjs"), 'import "./logical-model-resolver.ts";');
    writeFileSync(join(extension, "nested", "logical-model-render.ts"), 'import "../logical-model-render.ts";');
    writeFileSync(join(extension, "nested", "logical-model-resolver.mjs"), 'export { value } from "../logical-model-definitions.ts";');
    writeFileSync(join(extension, "nested", "runtime.mjs"), 'void import("../logical-model-resolver.js");');
    writeFileSync(join(extension, "clean.ts"), 'const note = "from \\\"./logical-model-render.ts\\\"";');
    const result = scanLogicalModelImports(extension);
    assert.deepEqual(result.files, [
      "extension/clean.ts",
      "extension/logical-model-render.mjs",
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

test("every non-policy runtime extension source stays disconnected from logical-model modules", () => {
  const result = scanLogicalModelImports("extension");
  assert.ok(result.files.length > 20);
  assert.equal(result.files.some((path) => path.endsWith(".mjs")), true);
  assert.deepEqual(result.reviewedNonLiteralSites, REVIEWED_NON_LITERAL_MODULE_SITES);
  assert.deepEqual(result.issues, []);
});

test("the disconnected policy contains no retired external score or ratio vocabulary", () => {
  const retired = new RegExp(["Artificial", "Analysis|artificialanalysis\\.ai|referenceCostUsd|capabilityScore|relativeCost|displayRelativeCost|capabilityBand"].join(" "));
  for (const path of ["extension/logical-model-definitions.ts", "extension/logical-model-resolver.ts", "extension/logical-model-render.ts"]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), retired, path);
  }
});
