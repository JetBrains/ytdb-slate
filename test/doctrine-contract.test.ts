import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { createLogicalRuntime, type LogicalRuntime } from "../extension/logical-model-runtime.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { BLAST_RADIUS_DOC, PR_PUBLISHING_DOC, REVIEW_RULES_DOC, TRACK_WORKFLOW_DOC, WRITING_GUIDANCE_DOC } from "../extension/paths.ts";
import { SlateStore, type SlateConfig } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { DESIGN_REQUIREMENTS, WRITING_REQUIREMENTS } from "../extension/writing-reminder.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-doctrine-contract-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

type Handler = (event: any, context: ExtensionContext) => unknown;

class FakeExtensionApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  readonly sentMessages: Array<{ message: unknown; options: unknown }> = [];

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void { this.commands.set(name, command); }
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

async function renderDoctrine(runtime: Readonly<LogicalRuntime> | null = createLogicalRuntime({ trusted: true }), config: SlateConfig = {}, trusted = true, paused = false, model?: { provider: string; id: string }, extensions = EMPTY_WORKER_EXTENSION_SET, change?: { current: string; source: string; legacy: boolean }): Promise<string> {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  store.paused = paused;
  if (change) {
    store.currentChange = change.current;
    store.sourceChange = change.source;
  }
  registerSlateMode(
    api as unknown as ExtensionAPI,
    store,
    {
      startHandoff: async () => {},
      effectiveContextBudget: () => undefined,
    } as any,
    () => config,
    () => extensions,
    () => runtime ?? undefined,
  );
  const handler = api.handlers.get("before_agent_start")?.[0];
  assert.ok(handler);
  const cwd = change?.legacy ? join(scratch, "legacy-case") : scratch;
  if (change?.legacy) {
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "research-log.md"), "read-only legacy input");
  }
  const context = extensionContext(cwd, [], trusted);
  context.model = model as never;
  const result = await handler({ systemPrompt: "BASE" }, context) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("BASE"));
  return result.systemPrompt.slice("BASE".length);
}

test("logical doctrine uses the cached static runtime policy without physical routes", { timeout: 5000 }, async () => {
  const runtime = createLogicalRuntime({ trusted: true });
  const doctrine = await renderDoctrine(runtime);
  assert.match(doctrine, /Every `thread` call must name logical `model` and a short `reason`/);
  assert.match(doctrine, /Effort is fixed by policy/);
  assert.match(doctrine, /Model routing policy:/);
  assert.match(doctrine, /\| luna-6 \| 45 \| 5 \| auxiliary tasks only,[^|]+routine text management such as modifying research logs[^|]+\|[^|]+Do not use Luna to handle complex texts\. \|/);
  assert.match(doctrine, /\| sol-6 \| 58 \| 20 \| default thread choice \|/);
  assert.match(doctrine, /Apply a more specific active guideline when it states an exception to a general preference\./);
  assert.match(doctrine, /\| claude-opus-5\.5 \| 90 \| 65 \| concurrency work \/ data-loss work \/ performance work \/ prefer over Astra for code reviews of focus areas that require high-level design, except non-local logic \/ Do not select Opus 5\.5 as the default implementer\.[^|]+first ask Opus 5\.5 to investigate[^|]+guided attempt also fails[^|]+Existing approval requirements and repair limits still apply\. \|/);
  assert.match(doctrine, /\| gpt-6-astra \| 86 \| 60 \| prefer when available for design reviews of all focus areas that require high-level design \/ prefer for code reviews of non-local logic defects \/ security work \/ performance work \/ Do not select Astra as the default implementer\. Use Astra for review only when assigned to a specific focus area\. Use Astra for research when appropriate\. \| none \|/);
  assert.doesNotMatch(doctrine, /preferredProvider|permission openai\/|registry prices|context window|`effort`/);
  assert.match(doctrine, /orchestrator selects the model for a no-area track under the same ordinary guidance/);
});

test("rule 9 directs built-in implementation reviews without growing doctrine", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine();
  const rule = doctrine.match(/9\. Before review dispatch, follow [^\n]+\n   Implementation review: pass built-in perspectives and data\.\n   No-area model choice follows Lifecycle\./)?.[0];
  assert.ok(rule);
  assert.ok(rule.includes(REVIEW_RULES_DOC));
  assert.equal(rule.split(REVIEW_RULES_DOC).join("review-rules.md").length, 180);
  assert.equal(rule.split("\n").length, 3);
});

test("logical doctrine production renders match published portable measurements", { timeout: 5000 }, async () => {
  const docsDirectory = TRACK_WORKFLOW_DOC.slice(0, -"track-workflow.md".length);
  const runtime = createLogicalRuntime({ trusted: true, documentationDirectory: docsDirectory });
  const capped = { units: [
    { path: "/fixture/a", source: "x".repeat(128), isDirectory: true, tools: [{ name: "a".repeat(64), description: "d".repeat(140) }, { name: "b".repeat(64), description: "e".repeat(140) }] },
    { path: "/fixture/b", source: "y".repeat(128), isDirectory: true, tools: [{ name: "c".repeat(64), description: "f".repeat(140) }, { name: "d".repeat(64), description: "g".repeat(140) }] },
  ], paths: [], toolNames: [] };
  const metric = (text: string) => ({ portable: text.split(docsDirectory).join("").length, lines: text.split("\n").length, paths: text.split(docsDirectory).length - 1 });
  assert.deepEqual(metric(runtime.promptText()!), { portable: 3892, lines: 11, paths: 0 });
  assert.deepEqual(metric(await renderDoctrine(runtime)), { portable: 8764, lines: 88, paths: 5 });
  assert.deepEqual(metric(await renderDoctrine(runtime, {}, false)), { portable: 2775, lines: 47, paths: 4 });
  assert.deepEqual(metric(await renderDoctrine(runtime, { workflow: { draftPRs: true, followUpIssues: true, routingRecommendations: true } }, true, false, undefined, capped)), { portable: 10353, lines: 101, paths: 6 });
  const change = { current: `change-20260101T000000Z-${"a".repeat(32)}`, source: `change-20260101T000001Z-${"b".repeat(32)}`, legacy: true };
  const linked = await renderDoctrine(runtime, { workflow: { draftPRs: true, followUpIssues: true, routingRecommendations: true } }, true, false, undefined, capped, change);
  assert.deepEqual(metric(linked), { portable: 10781, lines: 104, paths: 6 });
  assert.ok(metric(linked).portable * 1.05 < 26300);
  assert.match(linked, /Follow each log's first entry to read the full source chain and accounting/);
  assert.match(linked, /Read-only legacy root log: research-log.md/);
});

test("blocked logical policy renders a visible doctrine refusal", { timeout: 5000 }, async () => {
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { compressor: { models: [] } } } });
  const doctrine = await renderDoctrine(runtime);
  assert.match(doctrine, /Logical model work is blocked/);
  assert.match(doctrine, /compressor.models must not be empty/);
  assert.doesNotMatch(doctrine, /Model routing policy:/);
});

test("effective command reads current preferences without policy or provider work", async () => {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  const runtime = createLogicalRuntime({
    trusted: true,
    projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "openai", providers: { openai: "gpt-6-luna", second: "luna-2" } }] } } },
  });
  const admission = runtime.admit();
  assert.ok(admission);
  assert.equal(runtime.publishProvider(admission, "luna-6", "second"), true);
  registerSlateMode(
    api as unknown as ExtensionAPI,
    store,
    { startHandoff: async () => {}, effectiveContextBudget: () => undefined } as any,
    () => ({}),
    () => EMPTY_WORKER_EXTENSION_SET,
    () => runtime,
  );
  const notices: string[] = [];
  const ctx = extensionContext(scratch, notices);
  await api.commands.get("slate")!.handler("effective", ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /preferredProvider=openai; rememberedProvider=second/);
  assert.match(notices[0]!, /Remembered compressor selection: none/);
});

test("project startup settings merge causally and select Opus 5.5 at high when unscoped", { timeout: 5000 }, async () => {
  const settingsPath = join(process.cwd(), ".pi", "settings.json");
  const projectSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(projectSettings, {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-5-5",
    defaultThinkingLevel: "high",
    packages: ["../../main", "npm:pi-smart-fetch@0.3.17", "npm:pi-web-search@1.6.0"],
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
  assert.equal(manager.getDefaultProvider(), "anthropic");
  assert.equal(manager.getDefaultModel(), "claude-opus-5-5");
  assert.equal(manager.getDefaultThinkingLevel(), "high");
  assert.deepEqual(manager.getProjectSettings().packages, projectSettings.packages);
  const opus = { provider: "anthropic", id: "claude-opus-5-5" };
  const other = { provider: "openai", id: "scoped" };
  const runtime = {
    getModel: (provider: string, id: string) => provider === opus.provider && id === opus.id ? opus
      : provider === other.provider && id === other.id ? other : undefined,
    hasConfiguredAuth: () => true,
    getModels: () => [opus, other],
    getAvailable: async () => [other],
  };
  const selected = await resolverModule.findInitialModel({
    scopedModels: [], isContinuing: false,
    defaultProvider: manager.getDefaultProvider(), defaultModelId: manager.getDefaultModel(),
    defaultThinkingLevel: manager.getDefaultThinkingLevel(), modelRuntime: runtime,
  });
  assert.strictEqual(selected.model, opus);
  assert.equal(selected.thinkingLevel, "high");
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
  const restored = await resolverModule.restoreModelFromSession(other.provider, other.id, opus, false, runtime);
  assert.strictEqual(restored.model, other, "a usable restored model must replace the startup default");
  const untrusted = settingsModule.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
  assert.equal(untrusted.getDefaultProvider(), "anthropic");
  assert.equal(untrusted.getDefaultModel(), "global-model");
  assert.deepEqual(untrusted.getProjectSettings(), {});
});

test("real Pi startup prefers Opus 5.5 anywhere in the scoped model set", { timeout: 15000 }, () => {
  const trackedSettings = JSON.parse(readFileSync(join(process.cwd(), ".pi", "settings.json"), "utf8"));
  const trackedDefaults = {
    defaultProvider: trackedSettings.defaultProvider,
    defaultModel: trackedSettings.defaultModel,
    defaultThinkingLevel: trackedSettings.defaultThinkingLevel,
  };
  assert.deepEqual(trackedDefaults, {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-5-5",
    defaultThinkingLevel: "high",
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
        anthropic: {
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "literal-offline-startup-key",
          api: "anthropic-messages",
          models: ["claude-opus-5-5"].map((id) => ({
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
      "--models", "anthropic/claude-opus-5-5",
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
    assert.equal(response.data?.model?.provider, "anthropic");
    assert.equal(response.data?.model?.id, "claude-opus-5-5");
    assert.equal(response.data?.thinkingLevel, "high");
  } finally {
    rmSync(cliScratch, { recursive: true, force: true });
  }
});

test("single-action doctrine requires new threads and episode references", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine();
  assert.match(doctrine, /Every `thread` call creates a new thread for one action\./);
  assert.match(doctrine, /A follow-up action\s+must use another new thread\./);
  assert.match(doctrine, /No worker conversation crosses that boundary\./);
  assert.match(doctrine, /Slate loads those episodes into the new worker prompt\./);
  assert.doesNotMatch(doctrine, /freshContext|threadChoice|restart/);
});

test("doctrine uses approved focus states, the four-part proof, and effective gates", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Keep separate change/track records. NAMED: defect, place, consequence, review contribution. User approval proves it. Rejection is SKIPPED."));
  assert.ok(doctrine.includes("Proved areas add specialists and one Reviewer I."));
  assert.ok(doctrine.includes("Above 100 counted lines requires design before work, even documentation-only."));
  assert.ok(doctrine.includes("Implementer reports approximate size in response and report. Above 100 adds Reviewer I except documentation-only."));
  assert.ok(doctrine.includes("Size adds no specialist, design adversary or track acceptance."));
  assert.ok(doctrine.includes("If size crosses 100 late, add Reviewer I unless documentation-only. No late design. Use larger size later."));
  assert.doesNotMatch(doctrine, /Every track (?:also )?gets Reviewer I\./);
  assert.ok(doctrine.includes("Late areas add only specialists if Reviewer I ran."));
  const workflow = readFileSync(TRACK_WORKFLOW_DOC, "utf8");
  assert.match(workflow, /Counted lines are\s+added plus removed lines, excluding lockfiles, migration files, and generated\s+output/);
  assert.match(workflow, /Neither role needs an exact line counter/);
  assert.doesNotMatch(doctrine, /Reviewer I remains required on every track|Review every track with Reviewer I/);
  assert.ok(doctrine.includes(`Definitions: ${BLAST_RADIUS_DOC}. Lifecycle: ${TRACK_WORKFLOW_DOC}.`));
  assert.doesNotMatch(doctrine, /Concurrency defect|Data loss|Security weakness|Licensing exposure/);
  assert.ok(doctrine.includes("Approve proofs before edits."));
  assert.ok(doctrine.includes("User judges proofs and simplicity."));
});

test("doctrine reuses known facts and only applicable user authorization", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Apply evidence and prior answers before asking."));
  assert.ok(doctrine.includes("Evidence cannot authorize."));
  assert.ok(doctrine.includes("Reuse approvals only for covered decisions with current conditions and prerequisites complete when answered."));
  assert.ok(doctrine.includes("Ask only unresolved parts. Explain changes. Preserve gates and reviews."));
  const workflow = readFileSync(TRACK_WORKFLOW_DOC, "utf8");
  assert.match(workflow, /Reassess evidence and answer applicability at every existing reassessment\s+boundary/);
  assert.match(workflow, /Do not ask the user for that fact\s+again while its source remains applicable/);
  assert.match(workflow, /Reopen only the part\s+that the material change affects, and explain that change before asking again/);
  assert.doesNotMatch(doctrine, /prior required gates hold/);
});

test("design gates state validation, adversarial review, and final approval as one ordered contract", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Each proved DESIGN-TRIGGERING area requires design, user validation, focus reconfirmation, adversarial design review, final approval, and blocking track acceptance."));
  assert.doesNotMatch(doctrine, /final design approval before.*adversarial design review/);
});

// Acceptance policy itself is NOT asserted here any more. The audited
// `session-instructions` unit in verification/resolver-checks.mjs
// (`contract-acceptance-units`) compares that whole rendered region against one
// canonical acceptance-fact set, and `contract-acceptance-mutations` attacks it.
// That is strictly stronger than the three substring assertions this test used
// to carry, so the substrings retired with them. Everything below is rendering
// and wiring, which stays here.
test("doctrine states research-log, packet, and reviewer rules", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes(`Before review dispatch, follow ${REVIEW_RULES_DOC}. Read unless in context.`));
  assert.ok(doctrine.includes("Implementation review: pass built-in perspectives and data."));
  assert.ok(doctrine.includes("No-area model choice follows Lifecycle."));
  assert.doesNotMatch(doctrine, /Verification or gate machinery receives the general implementation reviewer|engaged focus areas|Review every track with Reviewer I/);
});

test("rule 8 renders exact feature-off and enabled publishing tails", { timeout: 5000 }, async () => {
  const local = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(local.includes("Keep workflow records in the change folder."));
  assert.doesNotMatch(local, /repo-root workflow log/);
  assert.equal(local.includes(PR_PUBLISHING_DOC), false);
  assert.doesNotMatch(local, /Publish one umbrella draft PR/);

  const published = (await renderDoctrine(undefined, { workflow: { draftPRs: true } })).replace(/\s+/g, " ");
  assert.ok(published.includes("Publish one umbrella draft PR for the change. Keep tracks mergeable. Only users merge."));
  assert.ok(published.includes(`Mechanics: ${PR_PUBLISHING_DOC}.`));
  assert.doesNotMatch(published, /repo-root (?:workflow|research) log/);

  const combined = (await renderDoctrine(undefined, { workflow: { draftPRs: true, routingRecommendations: true } })).replace(/\s+/g, " ");
  assert.ok(combined.includes("Publish one umbrella draft PR for the change. Keep tracks mergeable. Only users merge."));
  assert.ok(combined.includes(`Follow ${PR_PUBLISHING_DOC}.`));
});

test("routing-recommendation doctrine is trusted, opt-in, and feature-off inert", { timeout: 5000 }, async () => {
  const pointer = "At change completion, follow Lifecycle's routing-recommendation rule before final acceptance.";
  const absent = await renderDoctrine();
  const disabled = await renderDoctrine(undefined, { workflow: { routingRecommendations: false } });
  const enabled = await renderDoctrine(undefined, { workflow: { routingRecommendations: true } });
  assert.equal(disabled, absent);
  assert.ok(enabled.includes(pointer));
  assert.ok(enabled.replace(/\s+/g, " ").includes("Keep workflow records in the change folder"));

  const untrustedAbsent = await renderDoctrine(undefined, {}, false);
  const untrustedEnabled = await renderDoctrine(undefined, { workflow: { routingRecommendations: true } }, false);
  assert.equal(untrustedEnabled, untrustedAbsent);
  assert.equal(untrustedEnabled.includes(pointer), false);
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
  const doctrine = await renderDoctrine(undefined, { writing: { check: false, remind: false } });
  const absent = await renderDoctrine(undefined);
  const untrusted = await renderDoctrine(undefined, { writing: { check: true, remind: true } }, false);
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
    () => undefined,
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
    () => undefined,
  );
  for (let index = 0; index < 4; index++) await configuredApi.emit("turn_end", turn, context);
  assert.deepEqual(configuredApi.sentMessages, [], "a configured five-turn interval must stay silent through turn four");
});

// TQ1: the paused addendum is the orchestrator's only prompt-side statement of
// what a pause permits and requires. Reverting it to the pre-change claim that
// dispatches are rejected left the whole suite green, so the text is pinned
// here word for word, through the real registered before_agent_start handler.
test("the paused doctrine states worker availability and the one-writer save contract", { timeout: 5000 }, async () => {
  const running = await renderDoctrine();
  const paused = await renderDoctrine(undefined, {}, true, true);
  assert.equal(running.includes("PAUSED"), false, "an unpaused session must carry no pause text");
  assert.ok(paused.startsWith(running), "the addendum must be appended after the ordinary doctrine");

  const addendum = paused.slice(running.length).replace(/\s+/g, " ").trim();
  assert.equal(
    addendum,
    "# PAUSED — context budget exceeded" +
      " Slate is paused for handoff. Orchestrator worker dispatches remain available." +
      " Save the project state in the research log through exactly one worker at a time." +
      " Wait for that worker result and verify that it reports success before writing the final handoff brief." +
      " If preparation fails or is incomplete, report that fact and do not claim that the state was saved." +
      " Do not start other user work." +
      " Reply with a concise handoff brief (overall goal, per-thread state with episode ids, immediate next actions)" +
      " and direct the user to run /slate handoff [optional focus].",
  );
  // Order is part of the contract: one writer, then the result check, then the
  // brief. A reordered addendum would still contain every sentence.
  const writer = addendum.indexOf("exactly one worker at a time");
  const verify = addendum.indexOf("verify that it reports success");
  const brief = addendum.indexOf("Reply with a concise handoff brief");
  assert.ok(writer > 0 && writer < verify && verify < brief);
});

test("missing parent runtime produces an explicit blocked rule", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(null);
  assert.match(doctrine, /Logical model work is blocked: The logical model policy is unavailable/);
  assert.doesNotMatch(doctrine, /Routable this session|Session base model/);
});

test("entry configuration reports legacy keys and blocks invalid current policy", { timeout: 5000 }, async () => {
  const cwd = join(scratch, "logical-config-blocked");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify({
    modelFailover: { "old/model": "other/model" },
    episodeModel: "old/compressor",
    router: { allowUnmeasuredEffort: true, compressor: { models: [] } },
  }));
  const api = new FakeExtensionApi();
  slateExtension(api as unknown as ExtensionAPI);
  const notices: string[] = [];
  const ctx = extensionContext(cwd, notices);
  await api.emit("session_start", {}, ctx);
  assert.equal(notices.some((message) => /Legacy key modelFailover is ignored/.test(message)), true);
  assert.equal(notices.some((message) => /Legacy key episodeModel is ignored/.test(message)), true);
  assert.equal(notices.some((message) => /router.allowUnmeasuredEffort is ignored/.test(message)), true);
  assert.equal(notices.some((message) => /logical model policy blocked.*compressor.models must not be empty/i.test(message)), true);
  notices.length = 0;
  await api.commands.get("slate")!.handler("effective", ctx);
  assert.match(notices[0] ?? "", /Status: blocked/);
  assert.match(notices[0] ?? "", /No hidden compressor fallback is approved/);
});

test("entry configuration rejects every non-object JSON root", { timeout: 5000 }, async () => {
  for (const [name, value] of [["null", null], ["array", []], ["scalar", 7]] as const) {
    const cwd = join(scratch, `logical-config-${name}`);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify(value));
    const api = new FakeExtensionApi();
    slateExtension(api as unknown as ExtensionAPI);
    const notices: string[] = [];
    await api.emit("session_start", {}, extensionContext(cwd, notices));
    assert.equal(notices.some((message) => /must contain one JSON object.*policy is blocked/i.test(message)), true, name);
    assert.equal(notices.some((message) => /logical model policy blocked.*router must be an object/i.test(message)), true, name);
  }
});

test("session startup accepts mapped and ambiguous physical routes without a false warning", { timeout: 5000 }, async () => {
  for (const ambiguous of [false, true]) {
    const cwd = join(scratch, `startup-reverse-${ambiguous}`);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify({ router: { models: {
      include: ["luna-6"],
      ...(ambiguous ? { add: [{ model: "alias", capabilityRating: 40, costRating: 40, effort: "max", preferredProvider: "openai", providers: { openai: "gpt-6-luna" }, guidelines: [], cautions: [] }] } : {}),
    } } }));
    const api = new FakeExtensionApi();
    slateExtension(api as unknown as ExtensionAPI);
    const warnings: string[] = [];
    const ctx = extensionContext(cwd, warnings);
    ctx.model = { provider: "openai", id: "gpt-6-luna" } as never;
    await api.emit("session_start", {}, ctx);
    assert.deepEqual(warnings, [], `startup route ambiguous=${ambiguous} must not invent a failure`);
  }
});

test("entry configuration reports malformed JSON and keeps logical work blocked", { timeout: 5000 }, async () => {
  const cwd = join(scratch, "logical-config-malformed");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "slate.json"), "{ broken");
  const api = new FakeExtensionApi();
  slateExtension(api as unknown as ExtensionAPI);
  const notices: string[] = [];
  const ctx = extensionContext(cwd, notices);
  await api.emit("session_start", {}, ctx);
  assert.equal(notices.some((message) => /could not be parsed.*policy is blocked/i.test(message)), true);
  assert.equal(notices.some((message) => /logical model policy blocked.*router must be an object/i.test(message)), true);
});

test("entry configuration reports either ignored writing key through the shared warning sink", { timeout: 5000 }, async () => {
  const run = async (name: string, writing: Record<string, unknown> | undefined): Promise<string[]> => {
    const cwd = join(scratch, name);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify({
      ...(writing === undefined ? {} : { writing }),
      router: { models: { include: ["luna-6"] } },
    }));
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

test("entry configuration validates request pacing and reports the removed shard setting once", { timeout: 5000 }, async () => {
  const run = async (name: string, config: unknown): Promise<string[]> => {
    const cwd = join(scratch, name);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify({
      ...(config as Record<string, unknown>),
      router: { models: { include: ["luna-6"] } },
    }));
    const api = new FakeExtensionApi();
    slateExtension(api as unknown as ExtensionAPI);
    const warnings: string[] = [];
    await api.emit("session_start", {}, extensionContext(cwd, warnings));
    return warnings;
  };

  assert.deepEqual(await run("valid-throttle", { requestThrottle: { enabled: false, maxRequestsPerMinute: 3, baseWaitMs: 1, jitterMs: 0 } }), []);
  const invalid = await run("invalid-throttle", { requestThrottle: { maxRequestsPerMinute: 0, baseWaitMs: 0 } });
  assert.equal(invalid.length, 2);
  assert.match(invalid.join("\n"), /maxRequestsPerMinute[\s\S]*baseWaitMs/);
  const removed = await run("removed-shards", { cacheKeyShards: 3 });
  assert.equal(removed.length, 1);
  assert.match(removed[0] ?? "", /cacheKeyShards 3 is a removed setting and has no effect/);
});
