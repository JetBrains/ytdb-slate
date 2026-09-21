import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, mergeConfig, permitsSlateConfig } from "../extension/config.ts";
import slateExtension from "../extension/index.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { loadPromptDocs } from "../extension/prompt-docs.ts";
import { TRACK_WORKFLOW_DOC } from "../extension/paths.ts";
import { sanitizeCacheKeyEnabled, warnRemovedCacheKeyShards } from "../extension/state.ts";
import { sanitizeRequestThrottle, REQUEST_THROTTLE_DEFAULTS } from "../extension/request-throttle.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "slate-config-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agent);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(agent, "slate.json");
  const project = join(cwd, ".pi", "slate.json");
  const warnings: string[] = [];
  return { root, agent, cwd, home, project, warnings,
    load: (trusted = true) => loadConfig(cwd, trusted, (message) => warnings.push(message)),
    put: (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value)),
  };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("missing sources preserve defaults and do not authorize standalone untrusted config", (t) => {
  const f = fixture(t);
  const config = f.load(false);
  assert.deepEqual(plain(config), {});
  assert.equal(permitsSlateConfig(config, false), false);
  assert.equal(permitsSlateConfig(undefined, false), false);
  assert.equal(permitsSlateConfig({}, true), true);
  f.put(f.project, { workerTools: ["read"] });
  assert.deepEqual(plain(f.load()), { workerTools: ["read"] });
  assert.deepEqual(f.warnings, []);
});

test("recursive source merge replaces arrays, scalars and explicit null without mutating inputs", (t) => {
  const f = fixture(t);
  const home = { writing: { remindTurns: 7, findings: false }, workflow: { draftPRs: true }, contextBudget: { tokens: 12345 }, workerTools: ["read", "bash"], custom: { nested: { x: 1 }, array: [{ x: 1 }] } };
  const project = { writing: { remindTurns: 2 }, workflow: null, contextBudget: 9000, workerTools: [], custom: { nested: { y: 2 } } };
  const before = JSON.stringify([home, project]);
  const merged = mergeConfig(home, project) as any;
  assert.deepEqual(plain(merged), { writing: { remindTurns: 2, findings: false }, workflow: null, contextBudget: 9000, workerTools: [], custom: { nested: { x: 1, y: 2 }, array: [{ x: 1 }] } });
  merged.custom.nested.x = 9;
  merged.custom.array[0].x = 8;
  assert.equal(JSON.stringify([home, project]), before);
  f.put(f.home, home);
  f.put(f.project, project);
  assert.deepEqual(plain(f.load()), plain(mergeConfig(home, project)));
  assert.equal(readFileSync(f.home, "utf8"), JSON.stringify(home));
});

test("prototype keys stay inert and cannot forge home-only permission", (t) => {
  const f = fixture(t);
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"homeOnly":true,"trusted":true}');
  const merged = mergeConfig({}, hostile) as object;
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.deepEqual(merged, hostile);
  assert.equal(Object.hasOwn(merged, "__proto__"), true);
  const inherited = Object.create({ writing: { findings: false }, inherited: true });
  inherited.writing = { remindTurns: 2 };
  assert.deepEqual(mergeConfig(inherited, { writing: { check: true } }), { writing: { remindTurns: 2, check: true } });
  assert.deepEqual(mergeConfig({}, JSON.parse('{"__proto__":{"nested":1},"toString":{"own":true}}')),
    JSON.parse('{"__proto__":{"nested":1},"toString":{"own":true}}'));
  assert.equal(({} as any).polluted, undefined);
  assert.equal(permitsSlateConfig(merged, false), false);
  f.put(f.project, hostile);
  const trustedView = f.load();
  assert.equal(permitsSlateConfig(trustedView, false), false);
  f.put(f.home, { workerTools: ["read"] });
  const homeView = f.load(false);
  assert.equal(permitsSlateConfig(homeView, false), true);
  assert.equal(permitsSlateConfig({ ...homeView }, false), false);
  assert.equal(permitsSlateConfig(Object.create(homeView), false), false);
});

test("home paths keep agent ownership while project paths keep cwd ownership", (t) => {
  const f = fixture(t);
  for (const [directory, content] of [[f.agent, "HOME DOC"], [f.cwd, "PROJECT DOC"]]) writeFileSync(join(directory!, "role.md"), content!);
  f.put(f.home, { orchestratorPromptDocs: ["role.md", 9], workerPromptDocs: ["role.md"], doctrineExtraPath: "role.md", reviewPerspectivesPath: "role.md" });
  let config = f.load(false);
  assert.match(loadPromptDocs(f.cwd, config.workerPromptDocs!).join(""), /HOME DOC/);
  assert.equal(config.doctrineExtraPath, join(f.agent, "role.md"));
  assert.equal(config.reviewPerspectivesPath, join(f.agent, "role.md"));
  assert.equal(config.orchestratorPromptDocs?.[1], 9);
  f.put(f.project, { orchestratorPromptDocs: ["role.md"], doctrineExtraPath: "role.md", reviewPerspectivesPath: "" });
  config = f.load();
  assert.match(loadPromptDocs(f.cwd, config.orchestratorPromptDocs!).join(""), /PROJECT DOC/);
  assert.match(loadPromptDocs(f.cwd, config.workerPromptDocs!).join(""), /HOME DOC/);
  assert.equal(config.doctrineExtraPath, join(f.cwd, "role.md"));
  assert.equal(config.reviewPerspectivesPath, "");
  f.put(f.project, { workerPromptDocs: null, doctrineExtraPath: null });
  assert.equal(f.load().workerPromptDocs, null);
  assert.equal(f.load().doctrineExtraPath, null);
});

test("every invalid permitted source warns by path and blocks routing after merge", (t) => {
  const f = fixture(t);
  for (const file of [f.home, f.project]) {
    const other = file === f.home ? f.project : f.home;
    for (const kind of ["json", "null", "array", "scalar", "directory", "dangling", "loop"]) {
      rmSync(file, { recursive: true, force: true });
      f.put(other, { router: { models: { include: ["gpt-5.6-sol"] } } });
      if (kind === "directory") mkdirSync(file);
      else if (kind === "dangling") symlinkSync(join(f.root, "missing"), file);
      else if (kind === "loop") symlinkSync(file, file);
      else writeFileSync(file, kind === "json" ? "{ broken" : kind === "null" ? "null" : kind === "array" ? "[]" : "3");
      f.warnings.length = 0;
      const config = f.load();
      assert.equal(config.router, null, `${file}: ${kind}`);
      assert.equal(f.warnings.length, 1);
      assert.ok(f.warnings[0]!.includes(file));
      assert.match(f.warnings[0]!, /policy is blocked/);
      assert.ok(createLogicalRuntime({ trusted: true, projectConfig: config }).criticalErrors.length > 0);
    }
    rmSync(file, { recursive: true, force: true });
  }
});

test("an inaccessible source path warns and blocks even in an untrusted session", (t) => {
  const f = fixture(t);
  const notDirectory = join(f.root, "not-directory");
  writeFileSync(notDirectory, "file");
  process.env.PI_CODING_AGENT_DIR = notDirectory;
  const config = f.load(false);
  assert.equal(permitsSlateConfig(config, false), true);
  assert.equal(config.router, null);
  assert.ok(f.warnings[0]!.includes(join(notDirectory, "slate.json")));
  assert.match(f.warnings[0]!, /could not be read/);
});

test("untrusted project bytes are ignored even when unreadable or malformed", (t) => {
  const f = fixture(t);
  f.put(f.home, { router: { models: { include: ["gpt-5.6-sol"] } }, writing: { remindTurns: 2 } });
  for (const kind of ["valid", "broken", "loop"]) {
    rmSync(f.project, { force: true });
    if (kind === "loop") symlinkSync(f.project, f.project);
    else writeFileSync(f.project, kind === "valid" ? '{"router":null,"writing":{"remindTurns":19}}' : "{");
    const config = f.load(false);
    assert.equal(config.writing?.remindTurns, 2);
    const runtime = createLogicalRuntime({ trusted: permitsSlateConfig(config, false), projectConfig: config });
    assert.deepEqual(runtime.criticalErrors, []);
    assert.deepEqual(runtime.policy?.ordinary.map((model) => model.model), ["gpt-5.6-sol"]);
    assert.deepEqual(f.warnings, []);
  }
});

class Api {
  handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  commands = new Map<string, any>();
  messages: any[] = [];
  on(name: string, handler: any) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  registerTool() {}
  getActiveTools() { return []; }
  setActiveTools() {}
  getAllTools() { return []; }
  getThinkingLevel() { return undefined; }
  appendEntry() {}
  sendMessage(message: any) { this.messages.push(message); }
  async emit(name: string, event: any, ctx: ExtensionContext) {
    const results = [];
    for (const handler of this.handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  }
}

test("invalid object settings warn and complete real entry startup through either permitted source", { timeout: 10000 }, async (t) => {
  const cases = [
    { cacheKeyEnabled: {} }, { cacheKeyShards: {} },
    { requestThrottle: { enabled: {} } }, { requestThrottle: { maxRequestsPerMinute: {} } },
    { requestThrottle: { baseWaitMs: {} } }, { requestThrottle: { jitterMs: {} } },
    { requestThrottle: [{}] },
  ];
  for (const trusted of [true, false]) {
    for (const invalid of cases) {
      await t.test(`${trusted ? "project-only" : "home-only"} ${JSON.stringify(invalid)}`, async (t) => {
        const f = fixture(t);
        f.put(trusted ? f.project : f.home, invalid);
        const expectedWarnings: string[] = [];
        const warn = (message: string) => expectedWarnings.push(message);
        const parsed = JSON.parse(JSON.stringify(invalid));
        assert.equal(sanitizeCacheKeyEnabled(parsed.cacheKeyEnabled, warn), true);
        warnRemovedCacheKeyShards(parsed.cacheKeyShards, warn);
        assert.deepEqual(sanitizeRequestThrottle(parsed.requestThrottle, warn), REQUEST_THROTTLE_DEFAULTS);
        const api = new Api();
        const ctx = { cwd: f.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => trusted,
          sessionManager: { getBranch: () => [], getEntries: () => [] }, modelRegistry: {}, getContextUsage: () => undefined,
          ui: { notify: (message: string) => f.warnings.push(message), setWidget() {}, setStatus() {} },
        } as unknown as ExtensionContext;
        slateExtension(api as unknown as ExtensionAPI);
        try {
          await api.emit("session_start", {}, ctx);
          assert.equal(expectedWarnings.length, 1);
          assert.deepEqual(f.warnings, expectedWarnings);
          const loaded = f.load(trusted);
          assert.equal(sanitizeCacheKeyEnabled(loaded.cacheKeyEnabled, () => {}), true);
          assert.deepEqual(sanitizeRequestThrottle(loaded.requestThrottle, () => {}), REQUEST_THROTTLE_DEFAULTS);
          await api.commands.get("slate").handler("effective", ctx);
          assert.match(f.warnings.at(-1)!, /gpt-5\.6-sol/);
          assert.doesNotMatch(f.warnings.at(-1)!, /Status: blocked|No parent-session runtime/);
        } finally { await api.emit("session_shutdown", {}, ctx); }
      });
    }
  }
});

test("empty home enables the trusted default doctrine in an untrusted session", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const render = async (trusted: boolean) => {
    const api = new Api();
    const ctx = { cwd: f.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => trusted,
      sessionManager: { getBranch: () => [], getEntries: () => [] }, modelRegistry: {}, getContextUsage: () => undefined,
      ui: { notify: (message: string) => f.warnings.push(message), setWidget() {}, setStatus() {} },
    } as unknown as ExtensionContext;
    slateExtension(api as unknown as ExtensionAPI);
    try {
      await api.emit("session_start", {}, ctx);
      await api.commands.get("slate").handler("on", ctx);
      const results = await api.emit("before_agent_start", { systemPrompt: "" }, ctx);
      return results.find((result) => result?.systemPrompt !== undefined).systemPrompt as string;
    } finally { await api.emit("session_shutdown", {}, ctx); }
  };
  const withoutHome = await render(false);
  const trusted = await render(true);
  f.put(f.home, {});
  const homeEnabled = await render(false);
  assert.equal(homeEnabled, trusted);
  assert.match(homeEnabled, /Every `thread` call must name logical/);
  assert.match(homeEnabled, /Check user-facing prose before delivery/);
  assert.doesNotMatch(withoutHome, /Every `thread` call must name logical|Check user-facing prose before delivery/);
  const docsDirectory = TRACK_WORKFLOW_DOC.slice(0, -"track-workflow.md".length);
  const metrics = (text: string) => ({ portable: text.split(docsDirectory).join("").length,
    paths: text.split(docsDirectory).length - 1, lines: text.split("\n").length });
  assert.deepEqual(metrics(withoutHome), { portable: 2713, paths: 4, lines: 44 });
  assert.deepEqual(metrics(homeEnabled), { portable: 8954, paths: 5, lines: 86 });
});

test("real entry shares home routing, doctrine, writing cadence and startup settings in untrusted sessions", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agent, "role.md"), "HOME ROLE CONTENT");
  writeFileSync(join(f.agent, "extra.md"), "HOME EXTRA CONTENT");
  f.put(f.home, {
    orchestratorModeDefault: true, orchestratorPromptDocs: ["role.md"], doctrineExtraPath: "extra.md", reviewPerspectivesPath: "role.md",
    writing: { remindTurns: 1 }, workflow: { followUpIssues: true },
    router: { models: { include: ["gpt-5.6-sol"] } },
  });
  writeFileSync(f.project, "{ malformed untrusted project");
  const api = new Api();
  const statuses: string[] = [];
  const ctx = { cwd: f.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [], getEntries: () => [] }, modelRegistry: {}, getContextUsage: () => undefined,
    ui: { notify: (message: string) => f.warnings.push(message), setWidget() {}, setStatus: (_key: string, value: string) => statuses.push(value) },
  } as unknown as ExtensionContext;
  slateExtension(api as unknown as ExtensionAPI);
  await api.emit("session_start", {}, ctx);
  assert.deepEqual(f.warnings, []);
  const doctrine = JSON.stringify(await api.emit("before_agent_start", { systemPrompt: "BASE" }, ctx));
  assert.match(doctrine, /HOME ROLE CONTENT/);
  assert.match(doctrine, /HOME EXTRA CONTENT/);
  assert.ok(doctrine.includes(join(f.agent, "role.md")));
  assert.match(doctrine, /which deferred items become tracked issues/);
  assert.match(doctrine, /Check user-facing prose before delivery/);
  await api.commands.get("slate").handler("effective", ctx);
  assert.match(f.warnings.at(-1)!, /gpt-5\.6-sol/);
  assert.doesNotMatch(f.warnings.at(-1)!, /Status: blocked/);
  const message = { role: "assistant", content: [{ type: "text", text: "Read the file." }], stopReason: "stop" };
  await api.emit("message_end", { message }, ctx);
  await api.emit("turn_end", { message, toolResults: [] }, ctx);
  assert.equal(api.messages.length, 1);
  assert.equal(api.messages[0].display, false);
  assert.ok(statuses.some((value) => value?.includes("writing")));
  // Settings edits wait for the next session, rather than leaking into consumers.
  f.put(f.home, { orchestratorModeDefault: true, router: null });
  assert.match(JSON.stringify(await api.emit("before_agent_start", { systemPrompt: "BASE" }, ctx)), /HOME ROLE CONTENT/);
  await api.emit("session_start", {}, ctx);
  await api.commands.get("slate").handler("effective", ctx);
  assert.match(f.warnings.at(-1)!, /Status: blocked/);
  assert.doesNotMatch(JSON.stringify(await api.emit("before_agent_start", { systemPrompt: "BASE" }, ctx)), /HOME ROLE CONTENT/);
  // Trusted project values override the same home view before validation.
  writeFileSync(join(f.cwd, "role.md"), "PROJECT ROLE CONTENT");
  f.put(f.home, { orchestratorModeDefault: true, writing: { remindTurns: 1, findings: false }, router: { models: { include: ["gpt-5.6-sol"] } } });
  f.put(f.project, { orchestratorPromptDocs: ["role.md"], writing: { remindTurns: 2 }, router: { models: { include: ["gpt-5.6-luna"] } } });
  ctx.isProjectTrusted = () => true;
  await api.emit("session_start", {}, ctx);
  const projectDoctrine = JSON.stringify(await api.emit("before_agent_start", { systemPrompt: "BASE" }, ctx));
  assert.match(projectDoctrine, /PROJECT ROLE CONTENT/);
  assert.match(projectDoctrine, /gpt-5\.6-luna/);
  assert.doesNotMatch(projectDoctrine, /gpt-5\.6-sol/);
  api.messages.length = 0;
  for (let turn = 1; turn <= 2; turn++) {
    await api.emit("message_end", { message }, ctx);
    await api.emit("turn_end", { message, toolResults: [] }, ctx);
    assert.equal(api.messages.length, turn === 2 ? 1 : 0);
  }
  await api.emit("session_shutdown", {}, ctx);
});
