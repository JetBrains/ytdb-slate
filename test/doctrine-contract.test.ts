import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { MODEL_PROFILES, ladderFor } from "../extension/model-profiles.ts";
import { ROUTER_OFF, resolveModelRouter, type ModelRouterResolution, type RouterCandidate } from "../extension/model-router.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { PR_PUBLISHING_DOC, REVIEW_RULES_DOC, TRACK_WORKFLOW_DOC, WRITING_GUIDANCE_DOC } from "../extension/paths.ts";
import { SlateStore, type SlateConfig } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { DESIGN_REQUIREMENTS, WRITING_REQUIREMENTS } from "../extension/writing-reminder.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-doctrine-contract-"));

const EXPECTED_ROUTING_BENCHMARK_GUIDE = "\n   Benchmark score guide:\n   - DeepSWE v1.1: scored-attempt pass rate. Context-window failures and agent\n     timeouts are failures. Provider, verifier, and network errors are excluded.\n     Its published 95% run interval is 1.96 * std(runs) / sqrt(4) across four\n     whole-benchmark runs. The standard-deviation divisor is not published.\n   - Vals Code Migration: mean hidden-test pass rate across migrations, with\n     equal source-repository weight after target-language averaging. It is not\n     the percentage of whole migrations completed. Anti-cheat checks can zero\n     wrappers, copied artifacts, and wrong-language submissions.\n   - Terminal-Bench 2.1: binary task pass@1. Every test must pass. There is no\n     partial credit.\n   - OpenAI MRCR v2, eight needles: mean approximate text-match credit. The\n     required 12-character hash must precede the retrieved text or the example\n     scores zero. This is fractional credit, not binary correctness. Tool access\n     is a separate setup condition.\n   - OSWorld 2.0: partial is weighted checkpoint credit. Strict is the share of\n     fully completed workflows. Keep the two results separate. Release, tasks,\n     evaluator, interface, and action limit affect comparability.\n   - AutomationBench-AA: objectives completed after guardrail violations are\n     penalized. Raw objectives completed is separate. The accessible method does\n     not publish the exact penalty and aggregation formula.\n   - AA-LCR v1.1: percentage of 100 answers accepted by an equality-checker\n     judge. Its roughly 99K mean completed-prompt tokens describe the evidence\n     window, not route capacity. Version 1.0.0 is not comparable with v1.1.\n   - AA-Omniscience: current hallucination rate is Incorrect / (Incorrect +\n     Partial + Not Attempted), and lower is better. Accuracy and attempt rate are\n     separate. The current method does not prove that this denominator applied\n     to the dated Opus 5 result.\n   - ARC-AGI-3: Relative Human Action Efficiency (RHAE) combines level completion with\n     action efficiency against a human reference. Uncompleted levels score zero.\n     It is not a task-solve percentage. Standard and Provider Adapter harnesses\n     are separate. Adapter state retention and compaction are not normal Slate\n     capabilities. Published cost is total evaluation cost.\n   Use this guide:\n   - Pi's complete effort vocabulary is off < minimal < low < medium < high <\n     xhigh < max. A model can offer only a subset. The five provider effort\n     labels used by several benchmark series are low through max.\n   - For DeepSWE-shaped repository coding, choose the lowest measured effort for\n     which no higher measured effort has a clearly better nonoverlapping\n     published 95% interval. A higher effort clearly beats it only when the\n     higher lower bound exceeds the candidate upper bound. Do not recompute\n     unpublished bounds.\n   - Interval overlap only means this heuristic does not select the higher\n     effort. It does not prove equality, equivalence, non-inferiority, or no gain.\n   - Do not transfer the coding rule to computer use, retrieval, tool use,\n     factual recall, long-context work, or other tasks.\n   - Keep each effort attached to its result. An unreported setting validates no\n     setting. A model-level signal can guide a choice with judgment and an\n     explicit valid setting, but it proves no capability at that setting.\n   - Fable 5.1 and Haiku 4.5 have no evidence-based coding default. This is an\n     evidence gap, not a prohibition. Provisional use needs an explicit valid\n     effort and normal result verification. Do not invent a recommended coding\n     effort, coding optimality, or DeepSWE price.\n   - Terra is nonpreferred. Do not pick it by default. State a work-specific\n     reason in the task text. Do not add a tool argument or report field.\n   - Unknown capabilities are not prohibited. An explicit avoid cell is the\n     exception.\n   - Many short tasks means separate independent actions with directly checkable\n     results, not one long loop that repeatedly plans, uses tools, reads feedback,\n     and adapts. No numeric boundary is supported.\n   - Treat a near-zero ARC-AGI-3 result as evidence against benchmark-shaped\n     interactive work. Do not create a universal numerical threshold.\n   - Benchmarks are proxies, not Slate execution. Harness adaptation is not a\n     supported routing feature.\n   - Use the active Pi registry for route capacity and prices. DeepSWE costs are\n     dated cost-per-attempt figures generated on 2026-09-03 and retrieved on\n     2026-09-11. They are not future quotes. Context bands are not route limits.\n   - Keep partial, strict, fallback-assisted, and special-harness results\n     separate. Do not turn limited evidence into a positive recommendation.\n   - Respect provider, tool, credential, account, and privacy constraints.\n     Benchmark availability does not establish eligibility.\n   - The Fable 5.1 72.6% label is \"among questions not answered correctly\".\n     Do not derive another denominator from it.\n   - Zero Data Retention needs account-owner confirmation of model-specific\n     authorization and the required provider and account configuration under the\n     governing agreement. Use the project's established authorization record.";

const EXPECTED_PROFILE_GUIDANCE = new Map<string, { routeFor: string; avoidFor: string }>([
  ["openai/gpt-5.6-luna", { routeFor: "Use for agentic repository coding at @max. DeepSWE v1.1 reports 67.19% scored-attempt pass rate. The dated mean benchmark cost is $0.61 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. Vendor guidance supports well-specified changes with explicit tests. Vals Code Migration reports 36.1% mean hidden-test pass rate across migrations. This result does not measure architecture or design quality. ARC-AGI-3 Standard reports 0.18% at @max under the RHAE method. This near-zero result is evidence against routing novel interactive reasoning for benchmark-shaped work.", avoidFor: "For DeepSWE-shaped repository coding, avoid lower efforts. The interval rule in the guide selected @max from the measured series. The mean DeepSWE duration was 1,123 seconds per complete benchmark task. It includes the benchmark harness, tools, host, and provider load. It is not response latency and does not establish ordinary interactive speed. Capabilities not listed are unknown, not prohibited." }],
  ["anthropic/claude-sonnet-5", { routeFor: "Use for agentic repository coding at @high. DeepSWE v1.1 reports 48.23% scored-attempt pass rate. The dated mean benchmark cost is $7.43 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. Terminal-Bench 2.1 reports 74.53% task pass rate at @high over three runs in the Vals deployment. Every task needs all tests to pass. Vals Code Migration reports 36.3% mean hidden-test pass rate across migrations. ARC-AGI-3 has no verified result. Missing evidence is not zero or a routing prohibition.", avoidFor: "Do not raise coding effort to @xhigh or @max only to claim better quality. Their published DeepSWE 95% intervals overlap the @high interval. Under the exact rule, no clearly better nonoverlapping interval is shown. Overlap does not prove equal performance. This advice applies only to DeepSWE-shaped coding." }],
  ["openai/gpt-5.6-terra", { routeFor: "Use for agentic repository coding at @max. DeepSWE v1.1 reports 69.62% scored-attempt pass rate. The dated mean benchmark cost is $3.96 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. OpenAI MRCR v2 reports 89.6% mean approximate text-match credit in the 256K–512K token band and 72.5% in the 512K–1M token band. The source reports its best tested effort but does not identify that effort. Vals Code Migration reports 40.4% mean hidden-test pass rate across migrations. ARC-AGI-3 Standard reports 0.80% at @max under the RHAE method. This near-zero result is evidence against routing novel interactive reasoning for benchmark-shaped work. This is a nonpreferred route. Do not pick it by default. If a task uses it, state the work-specific reason in the task text under the existing doctrine rule. Do not add a tool argument or report field.", avoidFor: "For coding, lower efforts are not the selected setting under the interval rule. This coding rule does not establish the best effort for another task type. MRCR context bands do not establish active route capacity or uniform retrieval quality across every size in either band. Check the active Pi registry for current route capacity. Capabilities not listed are unknown, not prohibited." }],
  ["openai/gpt-5.6-sol", { routeFor: "Use for agentic repository coding at @high. DeepSWE v1.1 reports 69.40% scored-attempt pass rate. The dated mean benchmark cost is $2.66 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. OpenAI MRCR v2 reports 91.5% mean approximate text-match credit in the 256K–512K token band and 73.8% in the 512K–1M token band. The source reports its best tested effort but does not identify that effort. Vendor Terminal-Bench 2.1 reports 88.8% task pass rate. Vals Code Migration reports 47.2% mean hidden-test pass rate across migrations. ARC-AGI-3 Standard reports 7.78% at @max under the RHAE method. The low score and effort mismatch make it weak evidence for novel interactive reasoning.", avoidFor: "Do not raise coding effort to @xhigh or @max only to claim better quality. Their published DeepSWE 95% intervals overlap the @high interval. Under the exact rule, no clearly better nonoverlapping interval is shown. The interactive result uses @max under its own harness. It does not support the proposed @high coding setting or establish ordinary worker performance. MRCR does not establish active route capacity. Check the active Pi registry for current route capacity. Capabilities not listed are unknown, not prohibited." }],
  ["anthropic/claude-opus-5", { routeFor: "Use for agentic repository coding at @high. DeepSWE v1.1 reports 72.83% scored-attempt pass rate. The dated mean benchmark cost is $6.08 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. Vals Code Migration reports 53.3% mean hidden-test pass rate across migrations with server-side fallback permitted. The fallback-assisted share is unknown. ARC-AGI-3 Standard reports 30.16% at @high under the RHAE method. OSWorld 2.0 reports 70.57% first-attempt success over five runs in a live 1080p Ubuntu environment with a 500-action limit. Keep that source unit and setup. This supports computer-interface work only within the stated setup.", avoidFor: "Do not raise coding effort to @xhigh or @max only to claim better quality. Their published DeepSWE 95% intervals overlap the @high interval. Under the exact rule, no clearly better nonoverlapping interval is shown. Use caution for factual recall at @max. AA-Omniscience reported a 50% hallucination rate on 2026-07-24. The dated source does not state its denominator. Do not impute the current denominator to that historical result." }],
  ["anthropic/claude-fable-5-1", { routeFor: "This row has no established agentic-coding effort. DeepSWE v1.1 has no result, interval, benchmark cost, or duration for this row. Provisional use is allowed with an explicit valid measured effort where policy requires one, normal result verification, and no claim of coding optimality or DeepSWE price. Vals Code Migration reports 57.10% mean hidden-test pass rate at @max with server-side fallback enabled. The fallback-assisted share is unknown. OSWorld 2.0 reports 77.9% partial score and 41.7% strict score on the August 2026 release. AA-LCR v1.1 reports 85% at @medium, 84% at @high, 83% at @xhigh, and 85% at @max on completed prompts averaging about 99K tokens. Fallback contribution is unknown. ARC-AGI-3 has no verified result. Missing evidence is not zero.", avoidFor: "Do not claim an evidence-based coding effort or DeepSWE cost. Do not treat @max on Code Migration or the AA-LCR effort labels as a general recommendation. AA-Omniscience at @max reports 67.2% accuracy, a 93.4% attempt rate, and a 72.6% hallucination rate among questions not answered correctly. Preserve that exact denominator label. Zero Data Retention work without account-owner confirmation of express model-specific authorization and the required provider and account configuration under the governing agreement (REFUSE). Use the project's established authorization record. A general agreement, model availability, or successful request does not provide automatic approval." }],
  ["google-vertex/gemini-3.8-flash", { routeFor: "Use for agentic repository coding at @medium. DeepSWE v1.1 reports 71.02% scored-attempt pass rate. The dated mean benchmark cost is $1.97 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. Terminal-Bench 2.1 reports 90.8% task pass rate in Google Vertex documentation and 89.4% in the Google DeepMind model card. Neither source states a tested effort. The difference is unresolved, so preserve both figures. AutomationBench-AA v1.0.6 reports a 61% score at @medium across 657 simulated software-as-a-service workflows after tools were available. The headline score penalizes guardrail violations. Its exact penalty formula is unpublished. AA-LCR v1.1 reports 84% at @medium on prompts averaging about 99K tokens. Vals Code Migration reports 25.9% mean hidden-test pass rate across migrations. ARC-AGI-3 has no verified result. Missing evidence is not zero.", avoidFor: "Do not raise coding effort to @high only to claim better quality. The tested DeepSWE @high interval overlaps the @medium interval. Under the exact rule, no clearly better nonoverlapping interval is shown. AA-LCR does not establish retrieval quality for substantially larger contexts or a precise boundary near 100K. The benchmark publications do not establish deployment support, discovery, or selection of an unknown tool. Check the active deployment and tool configuration separately. Vertex measurements do not establish cache, privacy, adapter, or measured-effort behavior on alias routes." }],
  ["openai/gpt-6-astra", { routeFor: "Use for agentic repository coding at @medium. DeepSWE v1.1 reports 72.79% scored-attempt pass rate. The dated mean benchmark cost is $4.38 per attempted task. Context-window failures and agent timeouts count as failures. Provider, verifier, and network errors are excluded. OpenAI MRCR v2 reports 100% mean approximate text-match credit in the 256K–512K token band and 96.3% in the 512K–1M token band. The source reports its best tested effort but does not identify that effort. OSWorld 2.0 reports 72.6% partial score. AutomationBench-AA reports a 68% score at @max. The @max label records that tested capability setting, not the coding recommendation. Vals Code Migration reports 67.5% mean hidden-test pass rate across migrations. ARC-AGI-3 Standard reports 62.71% at @max through the ordinary ARC interface. A separate Provider Adapter evaluation reports 99.95% at @high through a special provider-specific integration. The adapter preserves provider state and compaction. Keep the two evaluations separate. The adapter is not a normal Slate route.", avoidFor: "Do not raise coding effort to @high, @xhigh, or @max only to claim better quality. Their published DeepSWE 95% intervals overlap the @medium interval. Under the exact rule, no clearly better nonoverlapping interval is shown. The computer and tool scores retain their measured setup and effort. Neither interactive result came from the Slate worker harness. Keep the Provider Adapter result separate from ordinary dispatch. MRCR does not establish active route capacity. Check the active Pi registry for current route capacity." }],
  ["anthropic/claude-haiku-4-5", { routeFor: "Use for many separate, independent, short tasks when each result can be checked directly. Bulk describes the number of independent tasks. It does not mean one long action with repeated planning and adaptation. Vendor guidance describes high-volume work and a fastest-model use case with checkable outputs. No project benchmark establishes a preferred effort. Terminal-Bench 2.1 reports 43.8% task pass rate. Vals Code Migration reports 10.1% mean hidden-test pass rate across migrations on a separately labelled Thinking deployment. That label does not map to a verified Pi effort. ARC-AGI-3 has no verified result. Missing evidence is not zero.", avoidFor: "Avoid one long action that depends on repeated autonomous planning, tool use, feedback, and adaptation. No numeric turn, token, or duration threshold is supported. Split suitable bulk work into independent short tasks. Do not make an exact-effort quality claim because no project effort was measured. A supported explicit effort may be chosen with judgment, but this row provides no evidence-based coding default. No DeepSWE result or comparable DeepSWE cost exists. A context-window snapshot does not establish permanent route capacity or retrieval quality. Check the active Pi registry for current route capacity." }],
]);

after(() => rmSync(scratch, { recursive: true, force: true }));

type Handler = (event: any, context: ExtensionContext) => unknown;

class FakeExtensionApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly sentMessages: Array<{ message: unknown; options: unknown }> = [];

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(): void {}
  registerTool(): void {}
  getActiveTools(): string[] { return []; }
  setActiveTools(): void {}
  getAllTools(): Array<{ name: string }> { return []; }
  appendEntry(): void {}
  sendMessage(message: unknown, options: unknown): void { this.sentMessages.push({ message, options }); }
  getThinkingLevel(): undefined { return undefined; }

  async emit(event: string, payload: unknown, context: ExtensionContext): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, context));
    return results;
  }
}

function extensionContext(cwd: string, warnings: string[] = [], trusted = true): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
    },
    ui: {
      notify: (message: string) => warnings.push(message),
      setWidget: () => {},
      setStatus: () => {},
    },
  } as unknown as ExtensionContext;
}

function routedResolution(): ModelRouterResolution {
  const profile = MODEL_PROFILES[0];
  assert.ok(profile);
  const candidate: RouterCandidate = {
    spec: profile.id,
    provider: profile.id.split("/")[0] ?? "",
    id: profile.id.split("/")[1] ?? "",
    profile,
    tier: profile.tier,
    registryCost: { input: 0, output: 1.25, cacheRead: 99, cacheWrite: 88 },
    contextWindow: profile.contextWindow ?? undefined,
    ladder: ladderFor(profile),
    hasFailover: true,
    tierUnsourced: profile.tierUnsourced === true,
    ladderAssumed: profile.ladderAssumed === true,
  };
  return {
    on: true,
    candidates: [candidate],
    warnings: [],
  };
}

async function renderDoctrine(router?: ModelRouterResolution, config: SlateConfig = {}, trusted = true, model?: { provider: string; id: string }): Promise<string> {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  registerSlateMode(
    api as unknown as ExtensionAPI,
    store,
    {
      startHandoff: async () => {},
      effectiveContextBudget: () => undefined,
    } as any,
    () => config,
    () => EMPTY_WORKER_EXTENSION_SET,
    router === undefined ? undefined : () => router,
  );
  const handler = api.handlers.get("before_agent_start")?.[0];
  assert.ok(handler);
  const context = extensionContext(scratch, [], trusted);
  context.model = model as never;
  const result = await handler({ systemPrompt: "BASE" }, context) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("BASE"));
  return result.systemPrompt.slice("BASE".length);
}

test("routing doctrine renders registry prices, configured order, and full tier words", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(routedResolution());
  assert.match(doctrine, /Candidate rows preserve\s+configured order after validation\./);
  assert.match(doctrine, /openai\/gpt-5\.6-luna\|0\/1\.25\|/);
  assert.match(doctrine, /\|tier 1\|/);
  assert.match(doctrine, /Prices are base input\/output rates from each exact pi registry entry\./);
  assert.doesNotMatch(doctrine, /cheapest|preference, tier sourcing|dated updates|never a default pick/);
  assert.match(doctrine, /Slate's model switch or top-level effort switch starts a cold prompt-cache path\./);
  assert.doesNotMatch(doctrine, /12\.5 times|cache reads/);
});

test("Fable 5.1 authorization exception survives production doctrine rendering", { timeout: 5000 }, async () => {
  const profile = MODEL_PROFILES.find((entry) => entry.id === "anthropic/claude-fable-5-1");
  assert.ok(profile);
  const resolution = resolveModelRouter({
    models: [profile.id],
    registry: {
      find: () => ({ cost: { input: 1, output: 5 }, contextWindow: profile.contextWindow ?? undefined }),
      hasConfiguredAuth: () => true,
    },
    failover: { [profile.id]: profile.id },
  });
  assert.equal(resolution.on, true);

  const doctrine = await renderDoctrine(resolution);
  const row = doctrine.split("\n").find((line) => line.includes(profile.id));
  assert.ok(row, "the production renderer must include the Fable row");
  assert.ok(row.length <= 1800, "the Fable row must remain within the enforced model-row bound");
  assert.match(row, /Zero Data Retention work without account-owner confirmation.*\(REFUSE\)/);
  assert.doesNotMatch(row, /claude-fable-5\|/);
});

test("routing benchmark guide matches the complete independent golden and only renders with a trusted live table", { timeout: 5000 }, async () => {
  const routed = await renderDoctrine(routedResolution());
  const start = routed.indexOf("\n   Benchmark score guide:");
  const end = routed.indexOf("\n   Routable this session", start);
  assert.ok(start >= 0 && end > start);
  assert.equal(routed.slice(start, end), EXPECTED_ROUTING_BENCHMARK_GUIDE);
  assert.doesNotMatch(routed, /Rows? [A-I]\b/);

  assert.doesNotMatch(await renderDoctrine(ROUTER_OFF), /Benchmark score guide/);
  assert.doesNotMatch(await renderDoctrine(routedResolution(), {}, false), /Benchmark score guide/);
  assert.doesNotMatch(await renderDoctrine({ on: true, candidates: [], warnings: [] }), /Benchmark score guide/);
});

test("all nine canonical profile rows match independent complete guidance goldens", { timeout: 5000 }, async () => {
  assert.deepEqual(MODEL_PROFILES.map((profile) => profile.id), [...EXPECTED_PROFILE_GUIDANCE.keys()]);
  for (const profile of MODEL_PROFILES) {
    assert.deepEqual(
      { routeFor: profile.routeFor, avoidFor: profile.avoidFor },
      EXPECTED_PROFILE_GUIDANCE.get(profile.id),
      `${profile.id} guidance changed`,
    );
  }
  const specs = [...EXPECTED_PROFILE_GUIDANCE.keys()];
  const resolution = resolveModelRouter({
    models: specs,
    registry: { find: () => ({ cost: { input: 1, output: 2 }, contextWindow: 1_000_000 }), hasConfiguredAuth: () => true },
    failover: Object.fromEntries(specs.map((spec) => [spec, spec])),
  });
  const doctrine = await renderDoctrine(resolution);
  for (const [spec, expected] of EXPECTED_PROFILE_GUIDANCE) {
    const row = doctrine.split("\n").find((line) => line.startsWith(`   ${spec}|`));
    assert.ok(row, `missing profile row: ${spec}`);
    const cells = row.split("|");
    assert.equal(cells[5], expected.routeFor, `${spec} rendered routeFor changed`);
    assert.equal(cells[6], expected.avoidFor, `${spec} rendered avoidFor changed`);
  }
  assert.doesNotMatch(doctrine, /\$1 per million input tokens|\$5 per million output tokens/);
});

test("canonical and alias Gemini doctrine rows keep their separate evidence contracts", { timeout: 5000 }, async () => {
  const identities = [
    "google-vertex/gemini-3.8-flash",
    "google/gemini-3.8-flash",
    "opencode/gemini-3.8-flash",
    "openrouter/google/gemini-3.8-flash",
  ];
  for (const spec of identities) {
    const resolution = resolveModelRouter({
      models: [spec],
      registry: { find: () => ({ cost: { input: 7, output: 8 }, contextWindow: 777_000 }), hasConfiguredAuth: () => true },
      failover: { [spec]: "anthropic/claude-opus-5" },
    });
    assert.equal(resolution.candidates[0]?.spec, spec);
    const doctrine = await renderDoctrine(resolution);
    const row = doctrine.split("\n").find((line) => line.startsWith(`   ${spec}|`));
    assert.ok(row);
    assert.match(row, /\|7\/8\|777K\|/);
    if (spec === identities[0]) {
      assert.match(row, /\|low,medium,high\|Use for agentic repository coding at @medium\./);
      assert.match(row, /71\.02%/);
    } else {
      assert.match(row, /\|none\|No capability or effort measurement is established for this alias route\./);
      assert.doesNotMatch(row, /71\.02%|\$1\.97 per attempted task|coding at @medium/);
      assert.match(row, /Cache, privacy, adapter, wire-format, rate, deployment, and tool contracts can differ/);
      assert.match(doctrine, /none = no measured effort in Slate's profile/);
      assert.doesNotMatch(doctrine, /none = pi's own level applies/);
    }
  }
});

test("project startup settings merge causally and select Astra at medium when unscoped", { timeout: 5000 }, async () => {
  const settingsPath = join(process.cwd(), ".pi", "settings.json");
  const projectSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(projectSettings, {
    defaultProvider: "openai",
    defaultModel: "gpt-6-astra",
    defaultThinkingLevel: "medium",
    packages: ["../../main", "npm:pi-smart-fetch@0.3.12", "npm:pi-web-search@1.3.1"],
  });
  const agentDir = join(scratch, "startup-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "anthropic",
    defaultModel: "global-model",
    defaultThinkingLevel: "high",
    packages: ["global-package"],
  }));
  const packageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core");
  const settingsModule = await import(join(packageRoot, "settings-manager.js"));
  const resolverModule = await import(join(packageRoot, "model-resolver.js"));
  const manager = settingsModule.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: true });
  assert.equal(manager.getDefaultProvider(), "openai");
  assert.equal(manager.getDefaultModel(), "gpt-6-astra");
  assert.equal(manager.getDefaultThinkingLevel(), "medium");
  assert.deepEqual(manager.getProjectSettings().packages, projectSettings.packages);
  const astra = { provider: "openai", id: "gpt-6-astra" };
  const other = { provider: "anthropic", id: "scoped" };
  const runtime = {
    getModel: (provider: string, id: string) => provider === astra.provider && id === astra.id ? astra
      : provider === other.provider && id === other.id ? other : undefined,
    hasConfiguredAuth: () => true,
    getModels: () => [astra, other],
    getAvailable: async () => [other],
  };
  const selected = await resolverModule.findInitialModel({
    scopedModels: [], isContinuing: false,
    defaultProvider: manager.getDefaultProvider(), defaultModelId: manager.getDefaultModel(),
    defaultThinkingLevel: manager.getDefaultThinkingLevel(), modelRuntime: runtime,
  });
  assert.strictEqual(selected.model, astra);
  assert.equal(selected.thinkingLevel, "medium");
  const scoped = await resolverModule.findInitialModel({
    scopedModels: [{ model: other, thinkingLevel: "low" }], isContinuing: false,
    defaultProvider: manager.getDefaultProvider(), defaultModelId: manager.getDefaultModel(),
    defaultThinkingLevel: manager.getDefaultThinkingLevel(), modelRuntime: runtime,
  });
  assert.strictEqual(scoped.model, other, "the scoped set must constrain startup selection");
  assert.equal(scoped.thinkingLevel, "low");
  const explicit = await resolverModule.findInitialModel({
    cliProvider: other.provider, cliModel: other.id, scopedModels: [], isContinuing: false,
    defaultProvider: manager.getDefaultProvider(), defaultModelId: manager.getDefaultModel(),
    defaultThinkingLevel: manager.getDefaultThinkingLevel(), modelRuntime: runtime,
  });
  assert.strictEqual(explicit.model, other, "an explicit command-line model must outrank the project default");
  const restored = await resolverModule.restoreModelFromSession(other.provider, other.id, astra, false, runtime);
  assert.strictEqual(restored.model, other, "a usable restored model must replace the startup default");
  const untrusted = settingsModule.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
  assert.equal(untrusted.getDefaultProvider(), "anthropic");
  assert.equal(untrusted.getDefaultModel(), "global-model");
  assert.deepEqual(untrusted.getProjectSettings(), {});
});

test("real Pi startup prefers Astra anywhere in the scoped model set", { timeout: 15000 }, () => {
  const trackedSettings = JSON.parse(readFileSync(join(process.cwd(), ".pi", "settings.json"), "utf8"));
  const trackedDefaults = {
    defaultProvider: trackedSettings.defaultProvider,
    defaultModel: trackedSettings.defaultModel,
    defaultThinkingLevel: trackedSettings.defaultThinkingLevel,
  };
  assert.deepEqual(trackedDefaults, {
    defaultProvider: "openai",
    defaultModel: "gpt-6-astra",
    defaultThinkingLevel: "medium",
  });
  const cliScratch = mkdtempSync(join(tmpdir(), "slate-startup-cli-"));
  const projectDir = join(cliScratch, "project");
  const agentDir = join(cliScratch, "agent");
  const homeDir = join(cliScratch, "home");
  const tempDir = join(cliScratch, "tmp");
  try {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(trackedDefaults));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        openai: {
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "literal-offline-startup-key",
          api: "openai-completions",
          models: ["gpt-5.6-luna", "gpt-6-astra"].map((id) => ({
            id,
            name: id,
            reasoning: true,
            thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 4096,
          })),
        },
      },
    }));
    writeFileSync(join(agentDir, "auth.json"), "{}");

    const cli = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    const result = spawnSync(process.execPath, [
      cli,
      "--no-extensions",
      "--mode", "rpc",
      "-a",
      "--no-session",
      "--models", "openai/gpt-5.6-luna:high,openai/gpt-6-astra",
    ], {
      cwd: projectDir,
      env: {
        HOME: homeDir,
        TMPDIR: tempDir,
        PATH: process.env.PATH ?? "",
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "",
      },
      input: '{"id":"state","type":"get_state"}\n',
      encoding: "utf8",
      timeout: 8000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    });
    assert.equal(result.error, undefined, `Pi startup failed: ${result.error?.message ?? "unknown error"}`);
    assert.equal(result.signal, null, `Pi startup ended from signal ${result.signal ?? "unknown"}`);
    assert.equal(result.status, 0, `Pi startup exited ${result.status}: ${result.stderr.slice(0, 4096)}`);
    assert.ok(result.stdout.length <= 256 * 1024);
    assert.ok(result.stderr.length <= 256 * 1024);
    const response = result.stdout.split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.id === "state");
    assert.ok(response, `missing get_state response: ${result.stdout.slice(0, 4096)}`);
    assert.equal(response.success, true);
    assert.equal(response.data?.model?.provider, "openai");
    assert.equal(response.data?.model?.id, "gpt-6-astra");
    assert.equal(response.data?.thinkingLevel, "medium");
  } finally {
    rmSync(cliScratch, { recursive: true, force: true });
  }
});

test("project routing configuration keeps seven candidates and both new Opus fallbacks", () => {
  const config = JSON.parse(readFileSync(join(process.cwd(), ".pi", "slate.json"), "utf8"));
  assert.deepEqual(config.router.models, [
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-5",
    "google-vertex/gemini-3.8-flash",
    "openai/gpt-6-astra",
  ]);
  assert.deepEqual(config.modelFailover, {
    "openai/gpt-5.6-luna": "anthropic/claude-sonnet-5",
    "openai/gpt-5.6-terra": "anthropic/claude-opus-5",
    "openai/gpt-5.6-sol": "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5": "openai/gpt-5.6-luna",
    "anthropic/claude-opus-5": "openai/gpt-5.6-sol",
    "google-vertex/gemini-3.8-flash": "anthropic/claude-opus-5",
    "openai/gpt-6-astra": "anthropic/claude-opus-5",
  });

  const resolution = resolveModelRouter({
    models: config.router.models,
    registry: {
      find: (provider, id) => ({
        cost: { input: 1, output: 2 },
        contextWindow: provider === "anthropic" ? 1_000_000
          : provider === "google-vertex" ? 1_048_576
            : id === "gpt-6-astra" ? 1_050_000 : 272_000,
      }),
      hasConfiguredAuth: () => true,
    },
    failover: config.modelFailover,
  });
  assert.deepEqual(resolution.candidates.map((candidate) => candidate.spec), config.router.models);
  assert.equal(resolution.warnings.length, 11);
});

test("registry rates flow through production resolution into doctrine rows", { timeout: 5000 }, async () => {
  const specs = MODEL_PROFILES.slice(0, 3).map((profile) => profile.id);
  assert.equal(specs.length, 3);
  const registry = new Map([
    [specs[0], { cost: { input: 7, output: 8 } }],
    [specs[1], { cost: { input: 0 } }],
    [specs[2], { cost: { output: 9 } }],
  ]);
  const resolution = resolveModelRouter({
    models: specs,
    registry: {
      find: (provider, id) => registry.get(`${provider}/${id}`),
      hasConfiguredAuth: () => true,
    },
    failover: Object.fromEntries(specs.map((spec) => [spec, spec])),
  });
  assert.equal(resolution.on, true);
  assert.deepEqual(resolution.candidates.map((candidate) => candidate.spec), specs);

  const doctrine = await renderDoctrine(resolution);
  assert.match(doctrine, new RegExp(`   ${specs[0]?.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\|7/8\\|`));
  assert.match(doctrine, new RegExp(`   ${specs[1]?.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\|0/unknown\\|`));
  assert.match(doctrine, new RegExp(`   ${specs[2]?.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\|unknown/9\\|`));
});

test("single-action doctrine requires new threads and episode references", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(routedResolution());
  assert.match(doctrine, /Every `thread` call creates a new thread for one action\./);
  assert.match(doctrine, /A follow-up action\s+must use another new thread\./);
  assert.match(doctrine, /No worker conversation crosses that boundary\./);
  assert.match(doctrine, /Slate loads those episodes into the new worker prompt\./);
  assert.doesNotMatch(doctrine, /freshContext|threadChoice|restart/);
});

test("doctrine reads workflow only for changes and enforces size confirmation", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Scale change gates by size grade: SMALL, MEDIUM, or LARGE."));
  assert.ok(doctrine.includes("You own focus-area planning."));
  assert.ok(doctrine.includes("Write a seven-line risk record and give a concrete three-part proof for each named area."));
  assert.ok(doctrine.includes("No rule mechanically decides whether a proof holds."));
  assert.ok(doctrine.includes("Obtain user approval of the record at every confirmation gate."));
  assert.doesNotMatch(doctrine, /The implementer declares focus|validated declaration/);
  assert.doesNotMatch(doctrine, /Concurrency defect|Data loss|Security weakness|Licensing exposure/);
  assert.ok(doctrine.includes(`For repository changes, read ${TRACK_WORKFLOW_DOC} (skip the read if it is already in your context).`));
  assert.ok(doctrine.includes("Before the first file-modifying dispatch, confirm the user confirmed the predicted grade and every required pre-implementation gate ran."));
});

test("design gates state validation, adversarial review, and final approval as one ordered contract", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Validate each required design before adversarial design review, then obtain final user approval."));
  assert.doesNotMatch(doctrine, /final user approval before adversarial design review/);
});

test("doctrine states research-log, packet, acceptance, and reviewer rules", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("MEDIUM and LARGE always keep a research log; SMALL opens one on a listed trigger."));
  assert.ok(doctrine.includes("Track packets are non-blocking, but final change acceptance is blocking."));
  assert.ok(doctrine.includes("Review every track with Reviewer I and one area reviewer for each proved focus area."));
  assert.doesNotMatch(doctrine, /Verification or gate machinery receives the general implementation reviewer|engaged focus areas/);
  assert.ok(doctrine.includes(`Before dispatching review threads, read ${REVIEW_RULES_DOC} and follow it. Skip the read when that file is already in your context.`));
});

test("rule 8 renders the exact research-log and draft-publishing tails", { timeout: 5000 }, async () => {
  const local = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(local.includes("Durable workflow records anchor in the retained repo-root research log per the workflow doc."));
  assert.doesNotMatch(local, /repo-root workflow log/);
  assert.equal(local.includes(PR_PUBLISHING_DOC), false);

  const published = (await renderDoctrine(undefined, { workflow: { draftPRs: true } })).replace(/\s+/g, " ");
  assert.ok(published.includes("An umbrella draft PR is part of the pre-implementation gates;"));
  assert.ok(published.includes(`PR publishing mechanics are in ${PR_PUBLISHING_DOC}.`));
  assert.doesNotMatch(published, /repo-root (?:workflow|research) log/);
});


test("follow-up issue doctrine renders after review only when enabled", { timeout: 5000 }, async () => {
  const sentence = "After review, ask the user which deferred items become tracked issues.";
  assert.ok((await renderDoctrine(undefined, { workflow: { followUpIssues: true } })).includes(sentence));
  assert.equal((await renderDoctrine(undefined, { workflow: { followUpIssues: false } })).includes(sentence), false);
  assert.equal((await renderDoctrine()).includes(sentence), false);
});

test("untrusted follow-up issue configuration leaves doctrine byte-identical", { timeout: 5000 }, async () => {
  const enabled = await renderDoctrine(undefined, { workflow: { followUpIssues: true } }, false);
  const absent = await renderDoctrine(undefined, {}, false);
  assert.equal(enabled, absent);
  assert.doesNotMatch(enabled, /After review, ask the user which review suggestions become tracker issues\./);
});

test("writing doctrine is active for trusted projects regardless of ignored writing keys", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(ROUTER_OFF, { writing: { check: false, remind: false } });
  const absent = await renderDoctrine(ROUTER_OFF);
  const untrusted = await renderDoctrine(ROUTER_OFF, { writing: { check: true, remind: true } }, false);
  assert.match(absent, /Check user-facing prose before delivery\./);
  assert.equal(absent, doctrine);
  assert.doesNotMatch(untrusted, /Check user-facing prose before delivery\./);
  const normalized = doctrine.replace(/\s+/g, " ");
  const requiredClauses = [
    "Check user-facing prose before delivery.",
    "Write sentences a reader understands on one reading.",
    "Use short, active language.",
    "Keep exact technical terms.",
    "Do not use semicolons or contractions.",
    "The checker does not test vocabulary.",
    "Follow these writing and conversation requirements:",
    "Write for a reader whose first language is not English.",
    "Use plain words that appear in standard libraries and textbooks. Treat any other term as new. A multi-word noun phrase, an abbreviation and a CamelCase name are terms.",
    "Avoid idioms.",
    "Replace bare-reference openers with the subject they reference.",
    "Explain each term, including project-specific, at first use.",
    "Define each abbreviation at first use.",
    "Express one idea in each sentence.",
    "Use one term for each concept.",
    "Do not explain an idea with a metaphor.",
    "Do not invent a term when the project already has one.",
    "Follow these design requirements:",
    "Choose the simplest solution with the fewest changes that keeps every approved goal, the product and implementation quality, and every required gate.",
    "Keep a design statement only if a different reasonable implementation keeps it true.",
    "Present to the user any item the approved goals do not list.",
    "Never add or remove an approved goal yourself.",
    "Propose a repeated regression as a non-goal candidate.",
    "Present what changed when you update a design.",
    "Assume the user knows software but not this project.",
    "Apply these requirements to README and documentation text, code comments and pull request text.",
    "Apply these requirements also to commit bodies, issues, review comments, release notes and user messages.",
    "Exclude research logs, worker task text, and the project's own agent instruction file.",
    "Read it only for an unusual prose decision.",
    "Skip it if already in context.",
  ];
  for (const clause of requiredClauses) assert.ok(normalized.includes(clause), `missing doctrine clause: ${clause}`);
  assert.ok(
    normalized.includes(DESIGN_REQUIREMENTS.map((entry) => `- ${entry.text}`).join(" ")),
    "design doctrine must match the reminder roster word for word",
  );
  assert.ok(normalized.includes(`Rules, limits, and checker: ${WRITING_GUIDANCE_DOC}.`));
  assert.doesNotMatch(normalized, /\b\d+\s+words\b/i);
  assert.doesNotMatch(normalized, /\bSENT\d+\b/);
});

test("writing guide rosters match the frozen production rosters", () => {
  const guide = readFileSync(WRITING_GUIDANCE_DOC, "utf8");
  const bullets = (start: string, end: string): string[] => {
    const from = guide.indexOf(start);
    const to = guide.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, "roster markers missing; update docs/writing-guidance.md in the same commit");
    const lines = guide.slice(from + start.length, to).split("\n");
    while (lines[0] === "") lines.shift();
    while (lines.at(-1) === "") lines.pop();
    assert.ok(lines.every((line) => /^- .+$/.test(line)), "invalid roster line; update docs/writing-guidance.md in the same commit");
    return lines.map((line) => line.slice(2));
  };
  assert.ok(Object.isFrozen(WRITING_REQUIREMENTS) && Object.isFrozen(DESIGN_REQUIREMENTS));
  assert.deepEqual(
    bullets("The doctrine includes these ten requirements in this order:", "The doctrine also renders"),
    WRITING_REQUIREMENTS.map((entry) => entry.text),
    "writing roster changed; update docs/writing-guidance.md in the same commit",
  );
  assert.deepEqual(
    bullets("seven-line design requirement block:", "The reminder then includes this exact scope guard:"),
    DESIGN_REQUIREMENTS.map((entry) => entry.text),
    "design roster changed; update docs/writing-guidance.md in the same commit",
  );
});

test("mode uses the four-turn reminder fallback when writing config is absent", { timeout: 5000 }, async () => {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  registerSlateMode(
    api as unknown as ExtensionAPI,
    store,
    { startHandoff: async () => {}, effectiveContextBudget: () => undefined } as any,
    () => ({}),
    () => EMPTY_WORKER_EXTENSION_SET,
    () => ROUTER_OFF,
  );
  const context = extensionContext(scratch);
  const turn = { message: { role: "assistant", content: [], stopReason: "stop" }, toolResults: [] };
  for (let index = 0; index < 3; index++) await api.emit("turn_end", turn, context);
  assert.deepEqual(api.sentMessages, []);
  assert.equal(store.writingReminder.turnsSinceDelivery, 3);
  await api.emit("turn_end", turn, context);
  assert.equal(api.sentMessages.length, 1, "the default interval must fire on turn four");
  assert.equal(store.writingReminder.turnsSinceDelivery, 0, "the claim restarts cadence");

  const configuredApi = new FakeExtensionApi();
  const configuredStore = new SlateStore(configuredApi as unknown as ExtensionAPI);
  configuredStore.orchestratorMode = true;
  registerSlateMode(
    configuredApi as unknown as ExtensionAPI,
    configuredStore,
    { startHandoff: async () => {}, effectiveContextBudget: () => undefined } as any,
    () => ({ writing: { remindTurns: 5 } }),
    () => EMPTY_WORKER_EXTENSION_SET,
    () => ROUTER_OFF,
  );
  for (let index = 0; index < 4; index++) await configuredApi.emit("turn_end", turn, context);
  assert.deepEqual(configuredApi.sentMessages, [], "a configured five-turn interval must stay silent through turn four");
});

test("routing off gives the explicit dispatch vocabulary without a candidate table", { timeout: 5000 }, async () => {
  const defaultOff = await renderDoctrine();
  const explicitOff = await renderDoctrine(ROUTER_OFF);
  assert.equal(explicitOff, defaultOff);
  assert.match(explicitOff, /Every `thread` call must name `model`, `effort` .* and `reason`\. Session base model: unknown\./);
  assert.doesNotMatch(explicitOff, /Routable this session/);
  assert.doesNotMatch(explicitOff, /Prices include dated updates/);

  const withBase = await renderDoctrine(ROUTER_OFF, {}, true, { provider: "p", id: "base" });
  assert.match(withBase, /Session base model: p\/base\./);
});

test("entry configuration reports either ignored writing key through the shared warning sink", { timeout: 5000 }, async () => {
  const run = async (name: string, writing: Record<string, unknown> | undefined): Promise<string[]> => {
    const cwd = join(scratch, name);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify(writing === undefined ? {} : { writing }));
    const api = new FakeExtensionApi();
    slateExtension(api as unknown as ExtensionAPI);
    const warnings: string[] = [];
    await api.emit("session_start", {}, extensionContext(cwd, warnings));
    return warnings;
  };
  const notice = "slate: writing.check and writing.remind are ignored writing keys. Remove them from slate.json. Slate controls writing checks and reminders automatically for trusted projects in orchestrator mode.";

  assert.deepEqual(await run("writing-check-true", { check: true }), [notice]);
  assert.deepEqual(await run("writing-remind-false", { remind: false }), [notice]);
  assert.match((await run("writing-percent-retired", { remindPercent: 10 }))[0] ?? "", /token share to a turn count/);
});

test("entry configuration accepts valid cache shards and rejects invalid counts", { timeout: 5000 }, async () => {
  const run = async (name: string, cacheKeyShards: number): Promise<string[]> => {
    const cwd = join(scratch, name);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify({ cacheKeyShards }));
    const api = new FakeExtensionApi();
    slateExtension(api as unknown as ExtensionAPI);
    const warnings: string[] = [];
    await api.emit("session_start", {}, extensionContext(cwd, warnings));
    return warnings;
  };

  const validWarnings = await run("valid", 3);
  assert.equal(validWarnings.some((warning) => warning.includes("cacheKeyShards")), false);

  const invalidWarnings = await run("invalid", 0);
  assert.equal(invalidWarnings.length, 1);
  assert.match(invalidWarnings[0] ?? "", /cacheKeyShards.*expected an integer from 1 to 64/);
});
