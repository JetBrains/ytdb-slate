import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { openWorkerSession } from "../extension/worker.ts";
import { SLATE_TOOL_NAMES } from "../extension/worker-extensions.ts";
import { createWorkerCodemodeComponent, WORKER_CODEMODE_COMPONENT_NAME } from "../extension/worker-codemode.ts";
type WorkerSession = Awaited<ReturnType<typeof createAgentSession>>["session"] & { shutdownWorker(): Promise<void> };
type Arguments = Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"];

async function worker(
  body: string,
  run: (session: WorkerSession, root: string, requests: TranscriptContext[], reports: string[]) => Promise<void>,
  enabled = true,
  checkpointOnly = false,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wc-"));
  const env = { agent: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_OFFLINE = "1";
  let session: WorkerSession | undefined;
  try {
    const sentinel = join(root, ".pi", "extensions", "sentinel.ts");
    mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
    writeFileSync(sentinel, `import { writeFileSync } from 'node:fs'; export default () => writeFileSync(${JSON.stringify(join(root, "discovered"))}, 'bad');`);
    const fixture = join(root, "fixture.mjs");
    writeFileSync(fixture, `import { appendFileSync } from 'node:fs';
      export default pi => {
        const register = (name, extra = {}) => pi.registerTool({ name, label: name, description: name,
          parameters: { type: 'object', properties: {} },
          execute: async () => { appendFileSync(${JSON.stringify(join(root, "executed"))}, name + '\\n'); return { content: [{ type: 'text', text: name }], details: undefined }; }, ...extra });
        ${body}
      }`);
    const requests: TranscriptContext[] = [];
    const host = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    let next: AssistantMessage["content"] = [];
    host.registerProvider("codemode-offline", {
      api: "codemode-offline-api", apiKey: "fixture", baseUrl: "http://127.0.0.1:9",
      models: [{ id: "worker", name: "worker", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, request) {
        requests.push(structuredClone(request));
        const content = next;
        next = [{ type: "text", text: "complete" }];
        const stopReason = content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content, stopReason, timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
        return stream;
      },
    });
    const reports: string[] = [];
    const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true,
      modelRegistry: new ModelRegistry(host), model: host.getModel("codemode-offline", "worker") } as unknown as ExtensionContext;
    if (checkpointOnly) {
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [fixture], extensionFactories: [{ name: WORKER_CODEMODE_COMPONENT_NAME,
          factory: createWorkerCodemodeComponent(message => reports.push(message)) }] });
      await loader.reload();
      const created = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), modelRuntime: host,
        model: ctx.model, tools: ['read', 'codemode', 'bridge', ...SLATE_TOOL_NAMES], resourceLoader: loader, settingsManager,
        sessionManager: SessionManager.inMemory() });
      session = Object.assign(created.session, { async shutdownWorker() { created.session.dispose(); } });
      await session.bindExtensions({ mode: 'print' });
    } else {
      session = await openWorkerSession({ ctx, tools: ["read"], extensionPaths: [fixture],
        testOnlyCodemode: enabled, report: message => reports.push(message) });
    }
    // Drive real model tool calls without substituting Pi's tool pipeline.
    drivers.set(session, async (name, args) => {
      next = [{ type: "toolCall", id: `call-${requests.length}`, name, arguments: args }];
      await session!.prompt("Run the requested tool.");
      const results = session!.messages.filter(message => message.role === "toolResult");
      const result = results.at(-1)!;
      assert.equal(result.role, "toolResult");
      return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    });
    await run(session, root, requests, reports);
    assert.equal(existsSync(join(root, "discovered")), false, "automatic extension discovery stays disabled");
  } finally {
    if (session) { drivers.delete(session); await session.shutdownWorker(); }
    if (env.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = env.agent;
    if (env.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = env.offline;
    rmSync(root, { recursive: true, force: true });
  }
}
const drivers = new WeakMap<WorkerSession, (name: string, args: Arguments) => Promise<string>>();
const call = (session: WorkerSession, name: string, args: Arguments) => drivers.get(session)!(name, args);
const script = (session: WorkerSession, code: string) => call(session, "codemode", { code });

test("worker codemode keeps normal declarations and has no models or discovered Slate", { timeout: 20000 }, async () => {
  await worker("", async (session, root, requests, reports) => {
    writeFileSync(join(root, "data.txt"), "normal tool bytes");
    const output = await script(session, `text(typeof models); return await tools.read({ path: 'data.txt' });`);
    assert.match(output, /undefined/);
    assert.match(output, /normal tool bytes/);
    assert.deepEqual(requests[0]!.messages.filter(message => message.role === "system").flatMap(message => message.toolsAdded?.map(tool => tool.name) ?? []).sort(), ["codemode", "read"]);
    assert.match(await call(session, "read", { path: "data.txt" }), /normal tool bytes/);
    const paths = session.resourceLoader.getExtensions().extensions.map(ext => ext.path);
    assert.deepEqual(paths.filter(path => path.startsWith("<inline:")), ["<inline:slate-worker-reminder>", "<inline:slate-worker-codemode>"]);
    assert.equal(paths.some(path => /extension\/index\.ts$/.test(path)), false);
    assert.deepEqual(reports, []);
  });
});

test("production worker does not load or activate the internal codemode component", { timeout: 10000 }, async () => {
  await worker("", async (session, _root, _requests, reports) => {
    assert.deepEqual(session.getActiveToolNames(), ["read"]);
    assert.equal(session.getAllTools().some(tool => tool.name === "codemode"), false);
    assert.deepEqual(session.resourceLoader.getExtensions().extensions.filter(ext => ext.path.startsWith("<inline:")).map(ext => ext.path), ["<inline:slate-worker-reminder>"]);
    assert.deepEqual(reports, []);
  }, false);
});

test("checkpoint denies inactive deferred tools and rechecks active membership during a script", { timeout: 20000 }, async () => {
  await worker(`register('switch_off', { execute: async () => { pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'read')); return { content: [], details: undefined }; } });
    pi.on('before_agent_start', () => register('mcp__inactive__read', { exposure: 'deferred' }));`, async (session, root) => {
    const output = await script(session, `
      const found = ALL_TOOLS.some(t => t.name === 'mcp__inactive__read');
      text({found});
      try { await tools.mcp__inactive__read({}); } catch (e) { text(e.message); }
      await tools.switch_off({});
      try { await tools.read({path: 'unused'}); } catch (e) { text(e.message); }`);
    assert.match(output, /"found":true/);
    assert.match(output, /Slate scripts cannot call inactive tool "mcp__inactive__read"/);
    assert.match(output, /Tool read not found/);
    assert.equal(existsSync(join(root, "executed")), false);
  });
});

test("worker excludes every Slate name after deferred registration", { timeout: 20000 }, async () => {
  await worker(`pi.on('before_agent_start', () => { for (const name of ${JSON.stringify(SLATE_TOOL_NAMES)}) register(name, { exposure: 'deferred' }); });`, async (session, root) => {
    const output = await script(session, `for (const name of ${JSON.stringify(SLATE_TOOL_NAMES)}) {
      try { await tools[name]({}); } catch (e) { text(e.message); }
    }`);
    for (const name of SLATE_TOOL_NAMES) assert.ok(output.includes(`tools.${name} does not exist`), output);
    assert.equal(existsSync(join(root, "executed")), false);
  });
});

test("checkpoint blocks a deferred replacement codemode and reports a warning", { timeout: 20000 }, async () => {
  await worker(`pi.on('before_agent_start', () => register('codemode'));`, async (session, root, _requests, reports) => {
    const output = await script(session, "return 'must not execute';");
    assert.match(output, /not owned by the worker component/);
    assert.equal(existsSync(join(root, "executed")), false);
    assert.equal(reports.length, 1);
    assert.match(reports[0]!, /not owned by the worker component/);
  });
});

test("component denies all four Slate tools without the worker excludeTools guard", { timeout: 20000 }, async () => {
  for (const exposure of ['direct', 'deferred']) {
    await worker(`pi.on('before_agent_start', () => {
      for (const name of ${JSON.stringify(SLATE_TOOL_NAMES)}) register(name, { exposure: '${exposure}' });
      pi.setActiveTools([...pi.getActiveTools(), ...${JSON.stringify(SLATE_TOOL_NAMES)}]);
    });`, async (session, root) => {
      const output = await script(session, `for (const name of ${JSON.stringify(SLATE_TOOL_NAMES)}) {
        try { await tools[name]({}); } catch (e) { text(e.message); }
      }`);
      for (const name of SLATE_TOOL_NAMES) {
        assert.ok(session.getActiveToolNames().includes(name));
        assert.ok(output.includes(`Slate scripts cannot call the Slate tool "${name}"`), output);
      }
      assert.equal(existsSync(join(root, "executed")), false);
    }, true, true);
  }
});

test("active deferred worker tools remain callable beside ordinary tools", { timeout: 20000 }, async () => {
  await worker(`register('mcp__active__read', { exposure: 'deferred' });`, async (session, root) => {
    assert.match(await script(session, `return await tools.mcp__active__read({});`), /mcp__active__read/);
    assert.equal(existsSync(join(root, "executed")), true);
  });
});

test("checkpoint blocks nested codemode through the real nested tool pipeline", { timeout: 20000 }, async () => {
  await worker(`register('bridge', { execute: async (_id, _args, _signal, _update, ctx) => {
    register('codemode', { exposure: 'deferred' });
    const outcome = await ctx.executeTool('codemode', {});
    return { content: outcome.result.content, details: undefined };
  } });`, async (session, root) => {
    const output = await script(session, `text(await tools.bridge({}));`);
    assert.match(output, /Slate blocks nested codemode calls/);
    assert.equal(existsSync(join(root, "executed")), false);
  });
});
