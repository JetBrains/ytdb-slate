import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { createLogicalRuntime, type LogicalRuntime } from "../extension/logical-model-runtime.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { BLAST_RADIUS_DOC, CHANGE_RECORDS_DOC, DESIGN_PRINCIPLES_DOC, PR_PUBLISHING_DOC, RECURSIVE_WORKFLOW_DOC, REVIEW_RULES_DOC, TRACK_WORKFLOW_DOC, WRITING_GUIDANCE_DOC } from "../extension/paths.ts";
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

async function renderDoctrine(runtime: Readonly<LogicalRuntime> | null = createLogicalRuntime({ trusted: true }), config: SlateConfig = {}, trusted = true, paused = false, model?: { provider: string; id: string }, extensions = EMPTY_WORKER_EXTENSION_SET, change?: { current?: string; source?: string; legacy?: boolean }, register = registerSlateMode, pauseReason?: "context-budget" | "adoption"): Promise<string> {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  store.paused = paused;
  store.pauseReason = pauseReason;
  if (change) {
    store.currentChange = change.current;
    store.sourceChange = change.source;
  }
  register(
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
  assert.match(doctrine, /\| sol-6\.1 \| 85 \| 20 \| default thread choice \|/);
  assert.match(doctrine, /Apply a more specific active guideline when it states an exception to a general preference\./);
  assert.match(doctrine, /\| claude-opus-5\.5 \| 90 \| 65 \| Reviewer for each proved DESIGN-TRIGGERING focus area, in adversarial design review and in implementation area review\. \/ Do not select Opus 5\.5 as the default implementer\.[^|]+first ask Opus 5\.5 to investigate[^|]+guided attempt also fails[^|]+Existing approval requirements and repair limits still apply\. \|/);
  assert.match(doctrine, /\| gpt-6-astra \| 86 \| 60 \| Do not select Astra as the default implementer\. \/ Prefer Sol 6\.1 over Astra\. \| none \|/);
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
  assert.deepEqual(metric(runtime.promptText()!), { portable: 3596, lines: 11, paths: 0 });
  assert.deepEqual(metric(await renderDoctrine(runtime)), { portable: 8397, lines: 74, paths: 5 });
  assert.deepEqual(metric(await renderDoctrine(runtime, {}, false)), { portable: 2711, lines: 33, paths: 4 });
  assert.deepEqual(metric(await renderDoctrine(runtime, { workflow: { draftPRs: true, followUpIssues: true, routingRecommendations: true } }, true, false, undefined, capped)), { portable: 9937, lines: 87, paths: 6 });
  const change = { current: `change-20260101T000000Z-${"a".repeat(32)}`, source: `change-20260101T000001Z-${"b".repeat(32)}`, legacy: true };
  const linked = await renderDoctrine(runtime, { workflow: { draftPRs: true, followUpIssues: true, routingRecommendations: true } }, true, false, undefined, capped, change);
  assert.deepEqual(metric(linked), { portable: 10365, lines: 90, paths: 6 });
  assert.ok(metric(linked).portable * 1.05 < 26300);
  assert.match(linked, /Follow each log's first entry to read the full source chain and accounting/);
  assert.match(linked, /Read-only legacy root log: research-log.md/);
});

test("every declared doctrine composition fits the original production hook", { timeout: 60000 }, async () => {
  const original = "d8bca25ef8947e370a92a68a4d98d0e2ec9f1a53";
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-C", process.cwd(), ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" } });
    assert.equal(result.error, undefined, `Cannot read original doctrine base ${original}: ${result.error?.message}`);
    assert.equal(result.status, 0, `Cannot read original doctrine base ${original}: ${result.stderr}`);
    return result.stdout;
  };
  const verifyIdentity = (ref: string): void => {
    assert.equal(git("rev-parse", ref).trim(), "d8bca25ef8947e370a92a68a4d98d0e2ec9f1a53", "original commit identity");
    assert.equal(git("rev-parse", `${ref}:extension`).trim(), "2b4f7f3bc2b305ff52c39cd08856cf265747069a", "original extension tree");
    assert.equal(git("rev-parse", `${ref}:package.json`).trim(), "0e770c4b04b32bdd5afe061031538391b314d806", "original manifest blob");
  };
  verifyIdentity(original);
  const root = join(scratch, "original-doctrine");
  const blobs = new Map<string, string>();
  for (const entry of git("ls-tree", "-r", original, "--", "package.json", "extension/").trim().split("\n")) {
    const match = entry.match(/^100(?:644|755) blob ([a-f0-9]{40})\t(package\.json|extension\/[\w-]+\.(?:ts|mjs))$/);
    assert.ok(match, `Unexpected original doctrine source: ${entry}`);
    const name = match[2]!;
    blobs.set(name, match[1]!);
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), git("show", `${original}:${name}`));
  }
  const verifyExport = (): void => {
    for (const [name, hash] of blobs) {
      const bytes = readFileSync(join(root, name));
      assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), hash, `original exported bytes: ${name}`);
    }
  };
  verifyExport();
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  const historical = await import(pathToFileURL(join(root, "extension", "mode.ts")).href);
  const logical = await import(pathToFileURL(join(root, "extension", "logical-model-runtime.ts")).href);
  const paths = await import(pathToFileURL(join(root, "extension", "paths.ts")).href);
  const prefix = TRACK_WORKFLOW_DOC.slice(0, -"track-workflow.md".length);
  const reference = { register: historical.registerSlateMode, create: logical.createLogicalRuntime, directory: paths.TRACK_WORKFLOW_DOC.slice(0, -"track-workflow.md".length) };
  const verifyReference = async (selected: typeof reference): Promise<void> => {
    verifyExport();
    assert.equal(selected.register, (await import(pathToFileURL(join(root, "extension", "mode.ts")).href)).registerSlateMode, "original hook provenance");
    assert.equal(selected.create, (await import(pathToFileURL(join(root, "extension", "logical-model-runtime.ts")).href)).createLogicalRuntime, "original runtime provenance");
    assert.equal(`${selected.directory}track-workflow.md`, join(root, "docs", "track-workflow.md"), "original paths provenance");
  };
  await verifyReference(reference);
  const basePrefix = reference.directory;
  const runtimes = (create: typeof createLogicalRuntime, directory: string) => {
    const replace = (n: number): SlateConfig => ({ router: { models: { replace: [{ model: "sol-6.1", guidelines: ["x".repeat(n)], cautions: [] }] } } });
    const runtime = (projectConfig?: SlateConfig) => create({ trusted: true, projectConfig, documentationDirectory: directory });
    const projectRoster: SlateConfig = { router: { models: { include: ["sol-6.1"], replace: [{ model: "sol-6.1", guidelines: ["x"], cautions: [] }] } } };
    return [runtime(), null, runtime({ router: { compressor: { models: [] } } }), runtime(replace(19401 - runtime(replace(1)).promptText()!.length)), runtime(projectRoster)];
  };
  const oldRuntimes = runtimes(reference.create, basePrefix), newRuntimes = runtimes(createLogicalRuntime, prefix);
  assert.equal(oldRuntimes[3]!.promptText()!.length, 19400);
  assert.equal(newRuntimes[3]!.promptText()!.length, 19400);
  for (const runtime of [oldRuntimes[4], newRuntimes[4]]) assert.deepEqual(runtime!.policy!.ordinary.map((model) => model.model), ["sol-6.1"]);
  const capped = { units: ["a", "b"].map((c) => ({ path: `/fixture/${c}`, source: c.repeat(128), isDirectory: true, tools: [c, c.toUpperCase()].map((n) => ({ name: n.repeat(64), description: "d".repeat(140) })) })), paths: [], toolNames: [] };
  const current = `change-20260101T000000Z-${"a".repeat(32)}`, source = `change-20260101T000001Z-${"b".repeat(32)}`;
  const perspectives = join(scratch, "comparison-perspectives.md"), extra = join(scratch, "comparison-extra.md");
  writeFileSync(perspectives, "Project perspective.");
  writeFileSync(extra, "Optional doctrine content.");
  const comparison = (before: string, after: string): boolean[] => {
    const reduction = before.split(basePrefix).join("").length - after.split(prefix).join("").length;
    return [reduction >= 0, before.split(basePrefix).length === after.split(prefix).length,
      ...["/x/docs/", "/fixture/a-much-longer-installed-package/docs/"].map((p) => before.split(basePrefix).join(p).length - after.split(prefix).join(p).length === reduction)];
  };
  const domains = { options: [0, 1, 2, 3, 4, 5, 6, 7], trusted: [false, true], runtime: [0, 1, 2, 3], extensions: [0, 1, 2], change: [0, 1, 2, 3, 4], paused: [false, true], perspective: [false, true], optional: [false, true] };
  const validDomains = (values: typeof domains): boolean => JSON.stringify(values) === '{"options":[0,1,2,3,4,5,6,7],"trusted":[false,true],"runtime":[0,1,2,3],"extensions":[0,1,2],"change":[0,1,2,3,4],"paused":[false,true],"perspective":[false,true],"optional":[false,true]}'
    && Object.values(values).every((domain) => new Set<number | boolean>(domain).size === domain.length)
    && Object.values(values).reduce((total, domain) => total * domain.length, 1) === 7680;
  assert.ok(validDomains(domains), "fixed, distinct matrix domains");
  assert.equal(validDomains({ ...domains, paused: [false, false] }), false);
  assert.equal(validDomains({ ...domains, options: domains.options.slice(1) }), false);
  const extensionCases = [EMPTY_WORKER_EXTENSION_SET, { units: [{ path: "/x", source: "npm:demo", isDirectory: true, tools: [{ name: "d", description: "d" }] }], paths: [], toolNames: [] }, capped];
  const changeCases = [{}, { current }, { current, source, legacy: true }, { source }, { legacy: true }];
  let count = 0, fixedCount = 0;
  for (const options of domains.options) for (const trusted of domains.trusted) for (const runtime of domains.runtime)
  for (const extensionIndex of domains.extensions) for (const changeIndex of domains.change) for (const paused of domains.paused)
  for (const perspective of domains.perspective) for (const optional of domains.optional) {
    const extensions = extensionCases[extensionIndex]!, change = changeCases[changeIndex]!;
    const config = { workflow: { draftPRs: !!(options & 1), followUpIssues: !!(options & 2), routingRecommendations: !!(options & 4) },
      ...(perspective ? { reviewPerspectivesPath: perspectives } : {}), ...(optional ? { doctrineExtraPath: extra, orchestratorPromptDocs: [extra] } : {}) };
    for (const index of runtime === 3 ? [3, 4] : [runtime]) {
      const before = await renderDoctrine(oldRuntimes[index], config, trusted, paused, undefined, extensions, change, reference.register);
      const after = await renderDoctrine(newRuntimes[index], config, trusted, paused, undefined, extensions, change);
      assert.deepEqual(comparison(before, after), [true, true, true, true], JSON.stringify({ options, trusted, runtime: index, change, paused, perspective, optional }));
      if (index === 4) fixedCount++;
      else count++;
    }
  }
  assert.equal(count, 7680);
  assert.equal(fixedCount, 1920);
  const before = await renderDoctrine(oldRuntimes[0], {}, true, false, undefined, EMPTY_WORKER_EXTENSION_SET, undefined, reference.register);
  const normalized = before.split(basePrefix).join(prefix);
  assert.deepEqual(comparison(before, normalized), [true, true, true, true]);
  assert.equal(comparison(before, `${normalized}x`)[0], false);
  assert.equal(comparison(before, `${normalized}${prefix}`)[1], false);
  const fixed = newRuntimes[4]!;
  const grown = { ...fixed, promptText: () => `${fixed.promptText()}${"x".repeat(128)}` };
  const fixedBefore = await renderDoctrine(oldRuntimes[4], {}, true, false, undefined, EMPTY_WORKER_EXTENSION_SET, undefined, reference.register);
  assert.equal(comparison(fixedBefore, await renderDoctrine(grown))[0], false, "fixed project input exposes logical prompt growth");
  for (const paused of domains.paused) {
    const pausedBefore = await renderDoctrine(oldRuntimes[0], {}, true, paused, undefined, EMPTY_WORKER_EXTENSION_SET, undefined, reference.register);
    const changed = `${await renderDoctrine(newRuntimes[0], {}, true, paused)}${paused ? "x".repeat(128) : ""}`;
    assert.equal(comparison(pausedBefore, changed)[0], !paused, "paused-only growth is visible");
  }
  for (const ref of ["HEAD", `${original}^`]) assert.throws(() => verifyIdentity(ref), /original commit identity/);
  for (const selected of [{ ...reference, register: registerSlateMode }, { ...reference, create: createLogicalRuntime }, { ...reference, directory: prefix }]) {
    await assert.rejects(() => verifyReference(selected), /original (hook|runtime|paths) provenance/);
  }
  const exportedMode = join(root, "extension", "mode.ts"), savedMode = readFileSync(exportedMode);
  try {
    writeFileSync(exportedMode, Buffer.concat([savedMode, Buffer.from(" ")]));
    assert.throws(verifyExport, /original exported bytes/);
  } finally { writeFileSync(exportedMode, savedMode); }
  assert.throws(() => git("show", `${"0".repeat(40)}:extension/mode.ts`), /Cannot read original doctrine base/);
});

test("P14 preserves exact conditional text, P13, and published byte figures", { timeout: 5000 }, async () => {
  const source = readFileSync(DESIGN_PRINCIPLES_DOC, "utf8"), budget = readFileSync(join(process.cwd(), "docs", "context-budget.md"), "utf8");
  const body = "- **P14 — Put workflow steps in code.** *(Repo-local note, not from the report.)*\n"
    + "  Move a workflow step into Slate code when code can perform or check it in a mechanical, deterministic way.\n"
    + "  The move reduces the prompt text in the orchestrator context, and code performs the step the same way each time.\n"
    + "  A step stays as prompt text when the move would not reduce context usage, or when the user decided to keep it as text.\n";
  const block = `### Workflow steps in code\n\n${body}`;
  const row = "| P14 mechanical workflow steps | `action-temporary.ts` manages temporary folders. Other existing rules remain future work for a tracked issue. |";
  const valid = (text: string): boolean => {
    const p13 = text.indexOf("### Built-in focus-area authoring\n"), p14 = text.indexOf(block), table = text.indexOf("## 5. Where each principle lives in the code");
    return p13 >= 0 && p13 < p14 && p14 < table && text.slice(p14, table) === `${block}\n`
      && text.split("**P14 —").length === 2 && text.split("### Workflow steps in code").length === 2
      && text.split(row).length === 2 && text.slice(table).split("\n\n")[1]?.endsWith(row) === true;
  };
  assert.ok(valid(source));
  assert.deepEqual([Buffer.byteLength(body), Buffer.byteLength(block), Buffer.byteLength(row)], [429, 457, 145]);
  const published = [
    "P14 enters neither injected totals nor the always-loaded principle subset.",
    "Read P14 only when reading [design-principles.md](design-principles.md).",
    "Design-track planning alone does not require design-principles.md.",
    "Explaining or changing Slate can require design-principles.md.",
    "Unusual routing or compaction can also require design-principles.md.",
    "Routine dispatch does not require design-principles.md.",
    "The P14 body contains 429 UTF-8 bytes, including the final line feed.",
    "The heading and body contain 457 bytes.",
    "The separate principle-table row contains 145 bytes without its final line feed.",
    "A blank separator before § 5 of design-principles.md adds one byte outside the 457-byte figure.",
    "The complete design-principles.md document adds 604 bytes for P14.",
  ];
  const validBudget = (text: string): boolean => published.every((line) => text.split(line).length === 2);
  assert.ok(validBudget(budget));
  for (const line of published) assert.equal(validBudget(budget.replace(line, "")), false);
  const p13 = source.slice(source.indexOf("- **P13"), source.indexOf("### Workflow steps in code") - 2);
  assert.equal(createHash("sha256").update(p13).digest("hex"), "05322ebeef792c4face701dc9c45d1712a01aa3519e3bcc3133f8447118e0766");
  assert.doesNotMatch(await renderDoctrine(), /Put workflow steps in code/);
  for (const changed of [source.replace(block, ""), source.replace("*(Repo-local note, not from the report.)*\n  Move", "*(From the report.)*\n  Move"), source.replace("when the user decided to keep it as text", "even when the user requires code"), source.replace("when the move would not reduce context usage", "when the move would reduce context usage"), source.replace("when the move would not reduce context usage", "when code would cost more than the protection it adds"), source.replace(row, ""), source.replace(row, row.replace("future work", "completed work")), source.replace(block, `${block}${body}`), source.replace(block, "").replace("### Built-in focus-area authoring", `${block}\n### Built-in focus-area authoring`)]) {
    assert.notEqual(changed, source);
    assert.equal(valid(changed), false);
  }
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
  const restored = await resolverModule.restoreModelFromSession(other.provider, other.id, opus, false, runtime);
  assert.strictEqual(restored.model, other, "a usable restored model must replace the startup default");
  const untrusted = settingsModule.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
  assert.equal(untrusted.getDefaultProvider(), "anthropic");
  assert.equal(untrusted.getDefaultModel(), "global-model");
  assert.deepEqual(untrusted.getProjectSettings(), {});
});

for (const explicitModel of [false, true]) test(explicitModel
  ? "real Pi startup gives an explicit command-line model precedence over a conflicting project default"
  : "real Pi startup prefers Opus 5.5 anywhere in the scoped model set", { timeout: 15000 }, () => {
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
        openai: {
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "literal-offline-startup-key",
          api: "openai-completions",
          models: [{
            id: "explicit-startup-model",
            name: "Explicit startup model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4096,
          }],
        },
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
      ...(explicitModel
        ? ["--provider", "openai", "--model", "explicit-startup-model"]
        : ["--models", "anthropic/claude-opus-5-5"]),
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
    assert.equal(response.data?.model?.provider, explicitModel ? "openai" : "anthropic",
      "an explicit command-line provider must outrank the conflicting project default");
    assert.equal(response.data?.model?.id, explicitModel ? "explicit-startup-model" : "claude-opus-5-5",
      "an explicit command-line model must outrank the conflicting project default");
    if (!explicitModel) assert.equal(response.data?.thinkingLevel, "high");
  } finally {
    rmSync(cliScratch, { recursive: true, force: true });
  }
});

test("single-action doctrine requires new threads and episode references", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine();
  assert.match(doctrine, /Each `thread` starts one action\./);
  assert.match(doctrine, /Follow-ups need new threads\./);
  const boundaryDuty = /No worker conversation crosses (?:threads|that boundary)\./;
  assert.match(doctrine, boundaryDuty);
  const unqualified = doctrine.replace(/crosses threads/, "continues");
  assert.notEqual(unqualified, doctrine);
  assert.match(unqualified, /No worker conversation continues\./);
  assert.equal(boundaryDuty.test(unqualified), false);
  assert.equal(boundaryDuty.test(doctrine.replace(/crosses threads/, "crosses")), false);
  assert.match(doctrine, /Slate loads them in worker prompts\./);
  assert.doesNotMatch(doctrine, /freshContext|threadChoice|restart/);
});

test("fixed doctrine preserves loading clauses and resolves filenames beside Lifecycle", { timeout: 5000 }, async () => {
  const directory = dirname(TRACK_WORKFLOW_DOC);
  assert.equal(CHANGE_RECORDS_DOC, join(directory, "change-records.md"));
  assert.equal(RECURSIVE_WORKFLOW_DOC, join(directory, "recursive-workflow.md"));
  for (const [name, path] of [["CHANGE_RECORDS_DOC", CHANGE_RECORDS_DOC], ["RECURSIVE_WORKFLOW_DOC", RECURSIVE_WORKFLOW_DOC]]) {
    assert.ok(readFileSync(path!, "utf8").length > 0);
    assert.equal(readFileSync(join(process.cwd(), "extension", "paths.ts"), "utf8").split(`export const ${name} =`).length, 2);
  }
  // Loading requirements are owned by Lifecycle, not the candidate renderer.
  const clauses = [/Read change-records\.md for every change/, /load recursive-workflow\.md for any planned/,
    /planned design or/, /or review-fix track/, /At planning\/resume/,
    /At planning\/resume, load/, /and before proposing a review-fix split/,
    /Read applicable sections before use/, /Read change-records/];
  for (const trusted of [true, false]) {
    const doctrine = await renderDoctrine(undefined, {}, trusted);
    const pointers = doctrine.match(/   Read change-records[^\n]+/g) ?? [];
    assert.equal(pointers.length, 1);
    const pointer = pointers[0]!;
    assert.ok(clauses.every((clause) => clause.test(pointer)));
    for (const clause of clauses) {
      assert.equal([...pointer.matchAll(new RegExp(clause.source, "g"))].length, 1);
      const removed = pointer.replace(clause, "");
      assert.notEqual(removed, pointer);
      assert.equal(clauses.every((required) => required.test(removed)), false);
    }
    for (const filename of ["change-records.md", "recursive-workflow.md"]) {
      assert.equal(clauses.every((clause) => clause.test(pointer.replace(filename, "wrong.md"))), false);
    }
    assert.equal(pointer.includes(directory), false);
    assert.equal(doctrine.split(`${directory}/`).length - 1, trusted ? 5 : 4);
    assert.ok(doctrine.includes(`Lifecycle: ${TRACK_WORKFLOW_DOC}.`));
    assert.ok(doctrine.includes(`Design rationale: ${DESIGN_PRINCIPLES_DOC}.`));
    assert.match(doctrine, /Read only to explain or change slate or for unusual routing or compaction/);
    assert.match(doctrine, /Never for routine dispatch\. Skip if in context\./);
    assert.doesNotMatch(doctrine, /P1[34] —|Workflow steps in code/);
    const proportional = readFileSync(RECURSIVE_WORKFLOW_DOC, "utf8").split("## Proportional process\n\n")[1]!.split("\n## ")[0]!;
    const retained = "Use [track-workflow.md](track-workflow.md) § Recursive planning and loading for record triggers.\nEntering a design track triggers its research log and nested gates.\nAn ordinary code track or a high-level design alone triggers neither extra record.\nStandalone designs and maps follow the lifecycle artifact summary.\nQuestions follow unresolved decisions rather than record or track counts.\n";
    const valid = (text: string) => text === retained && !text.includes("Use [design-principles.md]");
    assert.ok(valid(proportional));
    assert.equal(valid(`Use [design-principles.md](design-principles.md) § 4. Operating principles for proportional process.\n${proportional}`), false);
    assert.equal(valid(proportional.replace("neither", "both")), false);
    assert.ok(readFileSync(DESIGN_PRINCIPLES_DOC, "utf8").includes("**Tier 2 — on demand.** Doctrine rule 10 points to this document."));
  }
});

test("doctrine uses approved focus states, the four-part proof, and effective gates", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Keep separate change/track records. NAMED: defect, place, consequence, review contribution. Judge proof sufficiency internally."));
  assert.ok(doctrine.includes("Proved areas add specialists and one Reviewer I."));
  assert.ok(doctrine.includes("Estimate tracks first. Multi-track work or estimates >100 counted lines need design before work, even documentation-only."));
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
  assert.ok(doctrine.includes("Judge proof sufficiency internally."));
  assert.ok(doctrine.includes("User judges the solution."));
});

test("doctrine reuses known facts and only applicable user authorization", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Apply evidence and prior answers first."));
  assert.ok(doctrine.includes("Evidence cannot authorize."));
  assert.ok(doctrine.includes("Reuse approvals only for covered decisions with current prerequisites met when answered."));
  assert.ok(doctrine.includes("Ask unresolved parts. Explain changes. Preserve gates and reviews."));
  const workflow = readFileSync(TRACK_WORKFLOW_DOC, "utf8");
  assert.match(workflow, /Reassess evidence and answer applicability at every existing reassessment\s+boundary/);
  assert.match(workflow, /Do not ask the user for that fact\s+again while its source remains applicable/);
  assert.match(workflow, /Reopen only the part\s+that the material change affects, and explain that change before asking again/);
  assert.doesNotMatch(doctrine, /prior required gates hold/);
});

test("design gates state validation, adversarial review, and final approval as one ordered contract", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Each proved DESIGN-TRIGGERING area requires design, user validation, focus reconfirmation, adversarial design review, and final approval."));
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
  assert.ok(published.includes("Draft PRs: one per change on one branch. Only users merge after final acceptance."));
  assert.ok(published.includes(`Mechanics: ${PR_PUBLISHING_DOC}.`));
  assert.doesNotMatch(published, /repo-root (?:workflow|research) log/);

  const combined = (await renderDoctrine(undefined, { workflow: { draftPRs: true, routingRecommendations: true } })).replace(/\s+/g, " ");
  assert.ok(combined.includes("Draft PRs: one per change on one branch. Only users merge after final acceptance."));
  assert.ok(combined.includes(`Follow ${PR_PUBLISHING_DOC}.`));
});

test("routing-recommendation doctrine is trusted, opt-in, and feature-off inert", { timeout: 5000 }, async () => {
  const pointer = "Show routing advice only when records support it.";
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
    "Apply these requirements to user-facing prose: README, docs, code comments, pull requests, commit bodies, issues, review comments, release notes, user messages, maps, designs and package drafts.",
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

  assert.doesNotMatch(paused.slice(running.length), /context budget exceeded|reached.*budget/);
  const addendum = paused.slice(running.length).replace(/\s+/g, " ").trim();
  assert.equal(
    addendum,
    "# PAUSED" +
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

test("budget pause instructions name their purpose without growing the paused doctrine", { timeout: 5000 }, async () => {
  const legacy = await renderDoctrine(undefined, {}, true, true);
  const budget = await renderDoctrine(undefined, {}, true, true, undefined, EMPTY_WORKER_EXTENSION_SET, undefined, registerSlateMode, "context-budget");
  assert.match(budget, /\/slate handoff --context-budget \[optional\s+focus\]/);
  assert.equal(budget.length - legacy.length, " --context-budget".length);
  assert.doesNotMatch(legacy, /--context-budget|context budget exceeded/);
});

test("turning slate off clears both the pause and its cause", { timeout: 5000 }, async () => {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  store.paused = true;
  store.pauseReason = "context-budget";
  registerSlateMode(api as unknown as ExtensionAPI, store, { startHandoff: async () => {} } as any, () => ({}), () => EMPTY_WORKER_EXTENSION_SET, () => undefined);
  await api.commands.get("slate")!.handler("off", extensionContext("/tmp") as any);
  assert.equal(store.paused, false);
  assert.equal(store.pauseReason, undefined);
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


const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const read = (file: string) => readFileSync(new URL(`../docs/${file}.md`, import.meta.url), "utf8");

// Independent policy expectations make each weakening observable without a hash refresh.
const policies: Record<string, Record<string, string>> = {
  "change-records": {
    categories: "A **change record** is a research log, status file, implementer report, design or map.",
    rootAuthority: "The current `root-design.md` or `track-<number>-design.md` is authoritative for its root or design-track node.",
    codeAuthority: "A multi-track code track uses `code-track-<number>-design.md`, authoritative only while its node is code and its owning log names it current.",
    logAuthority: "Logs retain decisions, approval identities, links and accounting, not authoritative design copies.",
    noPlan: "A change without a design gains no plan record.",
    mapFamilies: "Use `root-baseline-map.md`, `track-<number>-baseline-map.md` and `track-<number>-implementation-map.md` for factual source explanation, not requirements.",
    singleTrack: "The root baseline serves single-track work at code-track detail.",
    facts: "Map changes grant no approval and change no design identity.",
    draftCheck: "Record-only workers write logs and status, and store assigned designs and baseline maps from drafts. They compare stored bytes with the assigned draft.",
    writers: "Implementers write only their own reports and assigned implementation maps. Fixers change only assigned maps. Neither writes logs.",
    workflowScope: "For designs and maps in changes started under or migrated to this workflow, SHA-256 (Secure Hash Algorithm with a 256-bit result) identifies complete bytes.",
    fullHash: "Only all 64 hexadecimal characters identify a version. Prefixes, filenames and sequence numbers alone do not.",
    loggedEvidence: "A retained version is evidence or a restore source only when its bytes match a full hash in its owning log.",
    afterWrite: "A record-only worker logs each verified write's full hash and checks the entry before later editing or reliance as evidence.",
    baselineIdentity: "Baseline entries also record path and source commit.",
    noApproval: "Storage identity grants no approval.",
    logDispatch: "The orchestrator dispatches all hash-log writes, including after implementer or fixer writes.",
    editBarrier: "Before editing a design or map, match its bytes to its last logged full hash. Without that identity, do not edit.",
    preserve: "Preserve a separate copy with `cp -n` at an unused versioned name. The command leaves occupied destinations unchanged.",
    copyStatus: "Verify equality with `cmp` regardless of copy exit status.",
    preservationLog: "A record-only worker then logs the preserved identity and checks the entry before editing. Split these tasks as writer permissions require.",
    adoption: "Adopt an existing retained copy only after a record-only worker verifies equality with a copy already identified by a logged full hash and logs the adopted copy's full hash.",
    adoptionExclusions: "An unlogged draft or filename hash cannot establish adoption.",
    unrelatedCopies: "Other copies remain retained without evidence status and do not block work.",
    compatibility: "Recorded changes keep their recorded authority and evidence rules, including version-folder filename hashes, until user-authorized migration. Opening another track does not migrate a change.",
    immutableCopies: "No worker changes or deletes a versioned copy.",
    missingCopy: "If a preservation copy is missing or differs, leave the current file unchanged. Retry `cp -n` at the next unused versioned name, then `cmp` again.",
    recoveryIdentity: "After a failed or unclear design or map edit, use `cmp` against the intended retained version whose bytes match its logged full hash.",
    recoveryOrder: "If unchanged, retry only the edit. Otherwise restore with `cp`, prove equality with `cmp`, then retry.",
    recoveryPause: "If that recovery version cannot be verified, pause the affected replacement. Do not guess another numbered copy.",
    successorSource: "For successor designs and maps, keep the source folder read-only. Name the direct source and preserve its source chain and recorded read boundary.",
    successorLog: "At the first successor-folder write, a record-only worker logs the named source record's full hash in the successor log.",
    successorBoundary: "Check it against a source-log entry inside that boundary. Later source entries supply no identity.",
    handoff: "A trusted handoff retaining the folder creates no fork.",
    retainedPrivacy: "All retained copies keep the record privacy and reviewer-input restrictions.",
  },
  "track-workflow": {
    designDispatch: "Name the current standalone approved design, if any, task, acceptance condition, assigned findings with compact fix evidence, affected files, relevant decisions and unresolved questions.",
    boundedContext: "Give implementers and fixers section references or bounded excerpts, never a required whole-log read.",
    factualContext: "Identify assigned maps as factual context, not requirements.",
    baselineDispatch: "When a stored baseline exists, obtain its path and source commit from the log and name both.",
    singleBaseline: "Use the root baseline for single-track work.",
    recordedBaseline: "Recorded changes without baselines gain no retrospective requirement.",
    unresolvedHistory: "Use supplied references and excerpts. Read further history only for unresolved relevant questions.",
    migrationRange: "For log-content migration, record the exact source line range and full hash.",
    migrationBytes: "The standalone design must equal that span, including entry prefixes, without summary or correction.",
    migrationHash: "Log its full hash under [change-records.md](change-records.md) § Manual records and safe writes.",
    migrationCorrection: "Later corrections need a new user-approved design version.",
  },
  "delivery-packages": {
    identityOwner: "Use [change-records.md](change-records.md) § Manual records and safe writes for evidence identity and recorded-workflow compatibility.",
    discovery: "Read standalone code-track designs, baseline and implementation maps, code-track reports and review-fix evidence.",
    earlierNode: "Discovery grants no design authority to a retained earlier node kind.",
    facts: "Maps supply facts, not approval, acceptance or completion evidence.",
  },
};

for (const [file, rules] of Object.entries(policies)) {
  for (const [name, rule] of Object.entries(rules)) test(`factual record contract in ${file}: ${name} rejects removal and weakening`, () => {
    const source = normalize(read(file));
    const accepts = (text: string) => Object.values(rules).every((rule) => text.includes(rule));
    assert.ok(accepts(source), file);
    assert.ok(accepts(`${source} Unrelated framing.`));
    assert.equal(source.split(rule).length - 1, 1, name);
    for (const replacement of ["", `Contradictory ${name} policy.`]) {
      const changed = source.replace(rule, replacement);
      assert.notEqual(changed, source, name);
      assert.equal(accepts(changed), false, name);
      const offset = source.indexOf(rule);
      const restored = changed.slice(0, offset) + rule + changed.slice(offset + replacement.length);
      assert.equal(restored, source, "restored bytes");
      assert.ok(accepts(restored), "restored policy");
    }
    assert.ok(accepts(source), "original policy accepts its permitted case");
  });
}

// These are document-policy counterexamples, not a replacement record writer.
test("record policy rejects unsafe copy, identity, adoption and migration scenarios", (t) => {
  const cases = [
    ["change-records", "occupied preservation name", "The command leaves occupied destinations unchanged.", "The command replaces an occupied destination."],
    ["change-records", "equal copy with nonzero exit", "Verify equality with `cmp` regardless of copy exit status.", "Reject equal bytes when the copy exits nonzero."],
    ["change-records", "missing pre-edit log identity", "Without that identity, do not edit.", "Edit without a logged identity."],
    ["change-records", "failed preservation log check", "checks the entry before editing", "edits before checking the entry"],
    ["change-records", "failed resulting log check", "checks the entry before later editing or reliance as evidence", "permits reliance after a failed log check"],
    ["change-records", "short hash", "Only all 64 hexadecimal characters identify a version.", "A 12-character prefix identifies a version."],
    ["change-records", "sequence-only recovery", "Do not guess another numbered copy.", "Recover the highest numbered copy."],
    ["change-records", "unverified recovery", "If that recovery version cannot be verified, pause the affected replacement.", "Restore an unverified recovery copy."],
    ["change-records", "unchanged retry", "If unchanged, retry only the edit.", "If unchanged, overwrite the preserved copy."],
    ["change-records", "partial edit restoration", "Otherwise restore with `cp`, prove equality with `cmp`, then retry.", "Retry the partial edit before checking restoration."],
    ["change-records", "adoption without identified equal bytes", "equality with a copy already identified by a logged full hash", "equality with any unlogged copy"],
    ["change-records", "unlogged draft adoption", "An unlogged draft or filename hash cannot establish adoption.", "An unlogged draft establishes adoption."],
    ["change-records", "filename-only adoption", "An unlogged draft or filename hash cannot establish adoption.", "A filename hash establishes adoption."],
    ["change-records", "unrelated retained copy", "Other copies remain retained without evidence status and do not block work.", "An unrelated retained copy blocks every edit."],
    ["change-records", "new track in recorded change", "Opening another track does not migrate a change.", "Opening another track migrates the change."],
    ["change-records", "source hash beyond read boundary", "Later source entries supply no identity.", "Later source entries identify the source version."],
    ["change-records", "code node changed to design", "authoritative only while its node is code and its owning log names it current", "authoritative even after its node becomes a design track"],
    ["change-records", "map edit changes approval", "Map changes grant no approval and change no design identity.", "Map edits approve a new design."],
    ["change-records", "recorded filename evidence preserved until migration", "including version-folder filename hashes, until user-authorized migration", "excluding all version-folder filename hashes even without migration"],
    ["change-records", "source hash inside read boundary required", "Check it against a source-log entry inside that boundary.", "Use an entry from any part of the source log."],
    ["track-workflow", "migration exact line range", "record the exact source line range and full hash", "record an approximate source region without a hash"],
    ["track-workflow", "migration exact bytes", "must equal that span", "may summarize that span"],
    ["track-workflow", "migration strips entry prefix", "including entry prefixes, without summary or correction", "after removing entry prefixes"],
    ["track-workflow", "migration folds in a correction", "Later corrections need a new user-approved design version.", "Fold later corrections into the extracted span."],
  ] as const;
  for (const [file, scenario, operand, replacement] of cases) {
    const source = normalize(read(file));
    const accepts = (text: string) => Object.values(policies[file]!).every((rule) => text.includes(rule));
    assert.ok(accepts(source), scenario);
    assert.equal(source.split(operand).length - 1, 1, scenario);
    const changed = source.replace(operand, replacement);
    assert.notEqual(changed, source, scenario);
    assert.equal(accepts(changed), false, scenario);
    t.diagnostic(`${scenario}: original accepted, weakened policy rejected`);
  }
});

test("shared design and map duties stay in the measured safe-write owner", () => {
  const source = read("change-records");
  const start = "## Manual records and safe writes\n", end = "### Design authority and privacy\n";
  const keys = ["categories", "draftCheck", "writers", "workflowScope", "fullHash", "loggedEvidence",
    "afterWrite", "baselineIdentity", "logDispatch", "editBarrier", "preserve", "copyStatus",
    "preservationLog", "adoption", "adoptionExclusions", "compatibility", "missingCopy",
    "recoveryIdentity", "recoveryOrder", "recoveryPause", "successorSource", "successorLog", "successorBoundary"];
  const body = (text: string) => normalize(text.slice(text.indexOf(start) + start.length, text.indexOf(end)));
  for (const key of keys) {
    const rule = policies["change-records"]![key]!;
    const accepts = (text: string) => body(text).includes(rule);
    assert.ok(accepts(source), key);
    // Rebuild the same headings around the normalized body to test relocation alone.
    const owned = body(source);
    assert.equal(owned.split(rule).length - 1, 1, key);
    for (const outside of ["preface", "privacy"]) {
      const without = owned.replace(rule, "");
      const moved = outside === "preface"
        ? rule + "\n" + start + without + "\n" + end
        : start + without + "\n" + end + rule;
      assert.ok(normalize(moved).includes(rule), "the rule remains in the document");
      assert.equal(accepts(moved), false, `${key}: moved into ${outside}`);
    }
  }
});

const triggerRules = [
  "Entering a design track triggers its research log and nested gates.",
  "An ordinary code track or a high-level design alone triggers neither extra record.",
  "Questions follow unresolved decisions rather than record or track counts.",
];
test("artifact summaries preserve record triggers and standalone exceptions", () => {
  for (const file of ["track-workflow", "recursive-workflow"]) {
    const source = normalize(read(file));
    const rules = [...triggerRules, file === "track-workflow"
      ? "Standalone designs and maps use the artifact exceptions in [design-principles.md](design-principles.md) P11."
      : "Standalone designs and maps follow the lifecycle artifact summary."];
    const accepts = (text: string) => rules.every((rule) => text.includes(rule));
    assert.ok(accepts(source), file);
    for (const rule of rules) {
      assert.equal(accepts(source.replace(rule, "Every track requires every record.")), false, rule);
    }
  }
  const source = normalize(read("design-principles"));
  const exceptions = "The current change folder's research log, standalone designs and maps are permitted unconditional-artifact exceptions for authors of future rules.";
  assert.ok(source.includes(exceptions));
  for (const name of ["research log", "standalone designs", "maps"]) {
    assert.equal(source.replace(exceptions, exceptions.replace(name, "every report")).includes(exceptions), false);
  }
  for (const rule of [
    "It does not remove or condition current required artifacts, including the per-track implementer report.",
    "Mandatory multi-track handoffs under [track-workflow.md](track-workflow.md) § Confirmation gate are the sole unconditional-handoff exception.",
  ]) {
    assert.ok(source.includes(rule), rule);
    for (const replacement of ["", "Every artifact and handoff is optional."]) {
      const changed = source.replace(rule, replacement);
      assert.notEqual(changed, source);
      assert.equal(changed.includes(rule), false, rule);
    }
  }
});
