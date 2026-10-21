import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { openWorkerSession, type WorkerSession } from "../extension/worker.ts";
import { isWorkerReminderMessage, workerReminderDeliveryMissing } from "../extension/worker-reminder.ts";
import { WORKER_NESTED_CLOSED_REASON } from "../extension/worker-nested-lifecycle.ts";
import { ThreadManager } from "../extension/threads.ts";
import { SlateStore } from "../extension/state.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SLATE_TOOL_NAMES } from "../extension/worker-extensions.ts";
import { createWorkerCodemodeComponent, WORKER_CODEMODE_COMPONENT_NAME } from "../extension/worker-codemode.ts";
type TestWorkerSession = Awaited<ReturnType<typeof createAgentSession>>["session"] & { shutdownWorker(): Promise<void> };
type Arguments = Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"];

async function worker(
  body: string,
  run: (session: TestWorkerSession, root: string, requests: TranscriptContext[], reports: string[], ctx: ExtensionContext, fixture: string, setNext: (content: AssistantMessage['content']) => void) => Promise<void>,
  checkpointOnly = false,
  onReport?: (message: string) => void,
  successfulCompression = false,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wc-"));
  const env = { agent: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_OFFLINE = "1";
  let session: TestWorkerSession | undefined;
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
        maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { id: "compressor", name: "compressor", reasoning: false, input: ["text"], contextWindow: 100_000,
          maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, request) {
        requests.push(structuredClone(request));
        const content = model.id === "compressor" ? (successfulCompression ? [{ type: "text" as const, text: "## Intent\nOUTER-PRINTED-SENTINEL" }] : []) : next;
        next = [{ type: "text", text: "complete" }];
        const stopReason = model.id === "compressor" && !successfulCompression ? "error" : content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content, stopReason, errorMessage: stopReason === "error" ? "fixture compression failure" : undefined, timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        if (stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: "done", reason: stopReason, message });
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
        testOnlyNestedWarningMs: 15,
        report: message => { reports.push(message); onReport?.(message); } });
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
    await run(session, root, requests, reports, ctx, fixture, content => { next = content; });
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
const drivers = new WeakMap<TestWorkerSession, (name: string, args: Arguments) => Promise<string>>();
const call = (session: TestWorkerSession, name: string, args: Arguments) => drivers.get(session)!(name, args);
const script = (session: TestWorkerSession, code: string) => call(session, "codemode", { code });

test("worker codemode keeps normal declarations and has no models or discovered Slate", { timeout: 20000 }, async () => {
  await worker("", async (session, root, requests, reports) => {
    writeFileSync(join(root, "data.txt"), "normal tool bytes");
    const output = await script(session, `text(typeof models); return await tools.read({ path: 'data.txt' });`);
    assert.match(output, /undefined/);
    assert.match(output, /normal tool bytes/);
    assert.deepEqual(requests[0]!.messages.filter(message => message.role === "system").flatMap(message => message.toolsAdded?.map(tool => tool.name) ?? []).sort(), ["codemode", "read"]);
    assert.match(await call(session, "read", { path: "data.txt" }), /normal tool bytes/);
    const paths = session.resourceLoader.getExtensions().extensions.map(ext => ext.path);
    assert.deepEqual(paths.filter(path => path.startsWith("<inline:")), ["<inline:slate-worker-reminder>", "<inline:slate-worker-codemode>", "<inline:slate-worker-nested-lifecycle>"]);
    assert.equal(paths.some(path => /extension\/index\.ts$/.test(path)), false);
    assert.deepEqual(reports, []);
  });
});

test("worker extension deactivation of owned codemode stays silent", { timeout: 10000 }, async () => {
  await worker("pi.on('session_start', () => pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'codemode')));", async (session, _root, _requests, reports) => {
    assert.deepEqual(session.getActiveToolNames(), ["read"]);
    assert.equal(session.getAllTools().find(tool => tool.name === 'codemode')?.sourceInfo.path, '<inline:slate-worker-codemode>');
    assert.deepEqual(reports, []);
  });
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

test("component denies all four Slate tools without the worker excludeTools guard", { timeout: 180000 }, async () => {
  for (const exposure of ['direct', 'deferred']) {
    for (const parent of ['normal', '']) {
    await worker(`pi.on('before_agent_start', () => {
      for (const name of ${JSON.stringify(SLATE_TOOL_NAMES)}) register(name, { exposure: '${exposure}' });
      pi.setActiveTools([...pi.getActiveTools(), ...${JSON.stringify(SLATE_TOOL_NAMES)}]);
    });`, async (session, root, _requests, _reports, _ctx, _path, setNext) => {
      setNext([{ type: 'toolCall', id: parent, name: 'codemode', arguments: { code: `for (const name of ${JSON.stringify(SLATE_TOOL_NAMES)}) {
        try { await tools[name]({}); } catch (e) { text(e.message); }
      }` } }]);
      await session.prompt('Run script');
      const result = session.messages.filter(message => message.role === 'toolResult').at(-1)!;
      assert.equal(result.role, 'toolResult');
      const output = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      for (const name of SLATE_TOOL_NAMES) {
        assert.ok(session.getActiveToolNames().includes(name));
        assert.ok(output.includes(`Slate scripts cannot call the Slate tool "${name}"`), output);
      }
      assert.equal(existsSync(join(root, "executed")), false);
    }, true);
    }
  }
});

test("checkpoint rechecks a deactivated deferred tool inside one real script", { timeout: 10000 }, async () => {
  await worker(`register('deferred', { exposure: 'deferred' });
    register('deactivate', { execute: async () => {
      pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'deferred'));
      return { content: [], details: undefined };
    }}); pi.on('session_start', () => pi.setActiveTools([...pi.getActiveTools(), 'deferred']));`, async (session, root) => {
    const output = await script(session, `await tools.deactivate({});
      try { await tools.deferred({}); } catch (e) { text(e.message); }`);
    assert.match(output, /Slate scripts cannot call inactive tool "deferred"\./);
    assert.equal(existsSync(join(root, 'executed')), false);
  });
});

test("active deferred worker tools remain callable beside ordinary tools", { timeout: 20000 }, async () => {
  await worker(`register('mcp__active__read', { exposure: 'deferred' });`, async (session, root) => {
    assert.match(await script(session, `return await tools.mcp__active__read({});`), /mcp__active__read/);
    assert.equal(existsSync(join(root, "executed")), true);
  });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("nested settlement joins detached calls, rejects repeated identifiers and blocks top-level calls", { timeout: 10000 }, async () => {
  for (const shutdown of [false, true]) {
    const entered = gate();
    const release = gate();
    const warned = gate();
    const symbol = Symbol.for('slate-nested-test');
    const state = { entered: entered.resolve, release: release.promise, bodies: 0,
      execute: undefined as undefined | ((name: string) => Promise<{ isError: boolean; result: { content: { type: string; text?: string }[] } }>) };
    (globalThis as Record<symbol, unknown>)[symbol] = state;
    try {
      await worker(`const state = globalThis[Symbol.for('slate-nested-test')];
        register('held', { execute: async () => { state.bodies++; state.entered(); await state.release; return { content: [], details: undefined }; } });
        register('bridge', { execute: async (_id, _args, _signal, _update, ctx) => {
          state.execute = name => ctx.executeTool(name, {});
          void state.execute('held');
          return { content: [], details: undefined };
        }});`, async (raw, _root, _requests, reports, ctx) => {
        const session = raw as WorkerSession;
        if (shutdown) {
          ctx.hasUI = true;
          ctx.ui = { notify() { throw new Error('stale host context'); } } as unknown as ExtensionContext['ui'];
        }
        try {
        await call(session, 'bridge', {});
        await entered.promise;
        const ids: string[] = [];
        session.subscribe(event => { if (event.type === 'tool_execution_start' && typeof event.parentToolCallId === 'string') ids.push(event.toolCallId); });
        let settled = false;
        const settlement = session.settleManagedOperations();
        assert.equal(session.settleManagedOperations(), settlement, 'settlement is memoized');
        const terminal = (shutdown ? session.shutdownWorker() : settlement).then(() => { settled = true; });
        const rejected = await state.execute!('held');
        assert.equal(rejected.isError, true);
        assert.ok(JSON.stringify(rejected.result.content).includes(WORKER_NESTED_CLOSED_REASON));
        assert.equal(state.bodies, 1, 'late repeated call never enters its body');
        assert.equal(ids[0], 'call-0/1', 'Pi resets nested identifiers at agent_end');
        assert.ok((await call(session, 'held', {})).includes(WORKER_NESTED_CLOSED_REASON));
        assert.equal(state.bodies, 1, 'closed top-level call never enters its body');
        const topLevel = await session.extensionRunner.emitToolCall({ type: 'tool_call', toolName: 'held', toolCallId: '', input: {} });
        assert.equal(topLevel?.block, true, 'closed admission also blocks top-level and empty identifiers');
        await Promise.race([warned.promise, terminal.then(() => { throw new Error('settlement completed before release'); })]);
        assert.equal(settled, false, 'warning proves settlement is waiting on the admitted call');
        assert.equal(reports.length, 1);
        assert.match(reports[0]!, /has not reported its end.*identifier "call-0\/1", tool "held", count 1/);
        assert.doesNotMatch(reports[0]!, /worker (?:extension (?:startup|shutdown) failed|session disposal failed|extension failed to load)/u);
        release.resolve();
        await terminal;
        assert.equal(settled, true);
        } finally { release.resolve(); }
      }, false, () => warned.resolve());
    } finally { release.resolve(); delete (globalThis as Record<symbol, unknown>)[symbol]; }
  }
});

for (const parentId of ['', 'worker extension startup failed']) {
test(`manager teardown joins nested work and publishes the warning through all three channels: ${parentId || 'empty parent identifier'}`, { timeout: 15000 }, async () => {
  const entered = gate();
  const release = gate();
  const warned = gate();
  const symbol = Symbol.for('slate-manager-nested');
  const state = { entered: entered.resolve, release: release.promise, bodies: 0, shutdowns: 0 };
  (globalThis as Record<symbol, unknown>)[symbol] = state;
  try {
    await worker(`const state = globalThis[Symbol.for('slate-manager-nested')];
      register('worker extension failed to load', { execute: async () => { state.bodies++; state.entered(); await state.release; return { content: [], details: undefined }; } });
      register('bridge', { execute: async (_id, _args, _signal, _update, ctx) => {
        void ctx.executeTool('worker extension failed to load', {}); return { content: [], details: undefined };
      }}); pi.on('session_shutdown', () => { state.shutdowns++; throw new Error('ordinary shutdown warning'); });`, async (_session, _root, _requests, _reports, ctx, path, setNext) => {
      const notifications: string[] = [];
      ctx.hasUI = true;
      ctx.ui = { notify(message: string, level: string) { assert.equal(level, 'warning'); notifications.push(message); } } as unknown as ExtensionContext['ui'];
      const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: 'fixture', capabilityRating: 50, costRating: 50, effort: 'off', preferredProvider: 'codemode-offline', providers: { 'codemode-offline': 'worker' }, guidelines: [], cautions: [] }] } } } });
      const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
      const manager = new ThreadManager(store, {}, () => ({ units: [], paths: [path], toolNames: ['worker extension failed to load', 'bridge'] }), runtime);
      setNext([{ type: 'toolCall', id: parentId, name: 'bridge', arguments: {} }]);
      const progress: string[] = [];
      let dispatchDone = false;
      const dispatch = manager.dispatch({ model: 'fixture', reason: 'nested lifecycle', task: 'run bridge', type: 'general' }, ctx, undefined,
        update => { progress.push(...update.lines); if (update.lines.some(line => line.includes('has not reported its end'))) warned.resolve(); });
      const observedDispatch = dispatch.then(() => { dispatchDone = true; });
      try {
        await entered.promise;
        let teardownDone = false;
        const teardown = manager.disposeAll().then(() => { teardownDone = true; });
        await Promise.race([warned.promise, observedDispatch.then(() => { throw new Error('dispatch completed before release'); })]);
        assert.equal(dispatchDone, false);
        assert.equal(teardownDone, false);
        assert.equal(state.shutdowns, 0);
        assert.ok(progress.some(line => line.includes(`identifier "${parentId}/1", tool "worker extension failed to load", count 1`)));
        assert.equal(notifications.filter(line => line.includes('has not reported its end')).length, 1);
        release.resolve();
        const result = await dispatch;
        await teardown;
        assert.ok(result.warnings.some(line => line.includes('has not reported its end')));
        assert.equal(state.shutdowns, 1);
        assert.ok(result.warnings.some(line => line.includes('ordinary shutdown warning')));
        assert.equal(notifications.length, 1, 'ordinary dispatch warnings stay in the report sink');
        await manager.disposeAll();
      } finally { release.resolve(); await manager.disposeAll(); }
    });
  } finally { release.resolve(); delete (globalThis as Record<symbol, unknown>)[symbol]; }
});
}

if (process.env.SLATE_NESTED_MISSING_END === '1') {
  test('nested missing end child', { timeout: 10000 }, async () => {
    await worker(`register('good', { execute: async () => ({ content: [], details: undefined,
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) });
      register('bad', { execute: async () => ({ content: [], details: undefined,
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 } }) });
      register('bridge', { execute: async (_id, _args, _signal, _update, ctx) => {
        await ctx.executeTool('good', {});
        try { await ctx.executeTool('bad', {}); } catch (error) { return { content: [{ type: 'text', text: error.message }], details: undefined }; }
      }});`, async raw => {
        const session = raw as WorkerSession;
        assert.match(await call(session, 'bridge', {}), /Cannot read properties of undefined/);
        await session.settleManagedOperations();
        throw new Error('missing end incorrectly completed settlement');
      }, false, message => { process.stdout.write(`CN104:${message}\n`); });
  });
} else {
  test('nested missing end warns in a disposable child without completing settlement', { timeout: 15000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cn104-'));
    const child = spawn(process.execPath, ['--test', '--test-name-pattern=^nested missing end child$', fileURLToPath(import.meta.url)], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, SLATE_NESTED_MISSING_END: '1', TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', data => { output += String(data); if (output.includes('CN104:')) resolve(); });
        child.stderr.on('data', data => { output += String(data); });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`child exited ${code}: ${output}`)));
      });
      assert.match(output, /has not reported its end.*identifier "call-0\/2", tool "bad", count 1/);
      assert.equal(child.exitCode, null);
    } finally {
      child.kill('SIGKILL');
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("real nested identifiers and reminder state follow the hook and execution contracts", { timeout: 90000 }, async () => {
  const symbol = Symbol.for('slate-t7-events');
  const state = { hooks: [] as Array<{ toolCallId: string; parentToolCallId?: string }>,
    calls: [] as Array<{ toolCallId: string; parentToolCallId?: string }>,
    starts: [] as Array<{ toolCallId: string; parentToolCallId?: string }>,
    ends: [] as Array<{ toolCallId: string; parentToolCallId?: string; handled: boolean }> };
  (globalThis as Record<symbol, unknown>)[symbol] = state;
  try {
    await worker(`const state = globalThis[Symbol.for('slate-t7-events')];
      pi.on('tool_result', event => { state.hooks.push(event); });
      pi.on('tool_call', event => { state.calls.push(event); });
      register('leaf');
      register('bridge', { execute: async (_id, _args, _signal, _update, ctx) => {
        await ctx.executeTool('leaf', {}); return { content: [], details: undefined };
      }});`, async (raw, _root, _requests, _reports, _ctx, _path, setNext) => {
      const session = raw as WorkerSession;
      session.subscribe(event => {
        if (event.type === 'tool_execution_start') state.starts.push(event);
        if (event.type === 'tool_execution_end') state.ends.push({ toolCallId: event.toolCallId,
          parentToolCallId: event.parentToolCallId, handled: session.workerReminderHandledToolResult() });
      });
      for (const parent of ['', 'parent']) {
        state.hooks.length = 0;
        state.calls.length = 0;
        state.starts.length = 0;
        state.ends.length = 0;
        const before = session.messages.filter(isWorkerReminderMessage).length;
        setNext([{ type: 'toolCall', id: parent, name: 'codemode', arguments: {
          code: 'await tools.bridge({}); await tools.leaf({}); text("OUTER");',
        } }]);
        await session.prompt('Run script');
        assert.deepEqual(state.starts.map(event => event.toolCallId), [parent, `${parent}/1`, `${parent}/1/1`, `${parent}/2`]);
        assert.deepEqual(state.starts.map(event => event.parentToolCallId), [undefined, parent, `${parent}/1`, parent]);
        const nestedCalls = state.calls.filter(event => event.toolCallId !== parent);
        assert.deepEqual(nestedCalls.map(event => event.toolCallId), [`${parent}/1`, `${parent}/1/1`, `${parent}/2`]);
        if (parent === '') {
          for (const event of [...nestedCalls, ...state.hooks].filter(event => event.toolCallId === '/1' || event.toolCallId === '/2')) {
            assert.equal(Object.hasOwn(event, 'parentToolCallId'), false);
          }
        }
        assert.deepEqual(state.ends.map(event => event.toolCallId), [`${parent}/1/1`, `${parent}/1`, `${parent}/2`, parent]);
        assert.deepEqual(state.ends.map(event => event.parentToolCallId), [`${parent}/1`, parent, parent, undefined]);
        const nestedHooks = state.hooks.filter(event => event.toolCallId !== parent);
        assert.deepEqual(nestedHooks.map(event => event.toolCallId), [`${parent}/1/1`, `${parent}/1`, `${parent}/2`]);
        assert.equal(nestedHooks[0]!.parentToolCallId, `${parent}/1`);
        for (const event of nestedHooks.slice(1)) assert.equal(event.parentToolCallId, parent || undefined);
        if (parent === '') assert.deepEqual(state.ends.slice(0, 3).map(event => event.handled), [false, false, false]);
        assert.equal(session.messages.filter(isWorkerReminderMessage).length - before, 1);
      }
      const before = session.messages.filter(isWorkerReminderMessage).length;
      setNext([{ type: 'toolCall', id: 'ordinary/middle', name: 'codemode', arguments: { code: 'text("MIDDLE-ID-OUTPUT");' } }]);
      await session.prompt('Run top-level script');
      const result = session.messages.filter(message => message.role === 'toolResult').at(-1)!;
      assert.equal(result.role, 'toolResult');
      assert.equal(result.isError, false);
      assert.match(JSON.stringify(result.content), /MIDDLE-ID-OUTPUT/);
      assert.equal(session.messages.filter(isWorkerReminderMessage).length - before, 1);
    });
  } finally { delete (globalThis as Record<symbol, unknown>)[symbol]; }
});

test("empty model identifier cannot bypass script checkpoint decisions", { timeout: 90000 }, async () => {
  await worker(`pi.on('before_agent_start', () => register('mcp__inactive__read', { exposure: 'deferred' }));
    register('bridge', { execute: async (_id, _args, _signal, _update, ctx) => {
      register('codemode', { exposure: 'deferred' });
      const result = await ctx.executeTool('codemode', {});
      return { content: result.result.content, details: undefined };
    }});`, async (session, root, _requests, _reports, _ctx, _path, setNext) => {
    setNext([{ type: 'toolCall', id: '', name: 'codemode', arguments: { code: `
      try { await tools.thread({}); } catch (e) { text(e.message); }
      try { await tools.mcp__inactive__read({}); } catch (e) { text(e.message); }
      text(await tools.bridge({}));` } }]);
    await session.prompt('Run empty-id script');
    const output = JSON.stringify(session.messages.filter(message => message.role === 'toolResult').at(-1));
    assert.match(output, /tools.thread does not exist/);
    assert.match(output, /Slate scripts cannot call inactive tool/);
    assert.match(output, /Slate blocks nested codemode calls/);
    setNext([{ type: 'toolCall', id: '', name: 'bridge', arguments: {} }]);
    await session.prompt('Run empty-id bridge');
    assert.match(JSON.stringify(session.messages.filter(message => message.role === 'toolResult').at(-1)), /Slate blocks nested codemode calls/);
    assert.equal(existsSync(join(root, 'executed')), false);
  });
});

test("manager retains compact nested outcomes and counts only outer failures", { timeout: 180000 }, async () => {
  for (const parent of ['', 'outer']) {
    for (const [failOuter, successfulCompression] of [[false, false], [false, true], [true, false], [true, true]]) {
      await worker(`register('good', { execute: async () => ({ content: [
        { type: 'text', text: 'RAW-NESTED-SUCCESS' }, { type: 'image', data: 'RAW-NESTED-IMAGE', mimeType: 'image/png' }
      ], details: { private: 'RAW-NESTED-DETAILS' } }) });
      register('bad', { execute: async () => { throw new Error('RAW-NESTED-FAILURE'); } });`, async (_session, _root, requests, _reports, ctx, path, setNext) => {
        const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: {
          models: { include: [], add: [{ model: 'fixture', capabilityRating: 50, costRating: 50, effort: 'off', preferredProvider: 'codemode-offline', providers: { 'codemode-offline': 'worker' }, guidelines: [], cautions: [] }],
            replace: [{ model: 'claude-sonnet-5.5', preferredProvider: 'codemode-offline', providers: { 'codemode-offline': 'compressor' } }] },
          compressor: { models: [{ model: 'claude-sonnet-5.5', effort: 'off' }] },
        } } });
        const manager = new ThreadManager(new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI), {}, undefined, runtime);
        // Replace only Slate's opening seam. Pi runs the real script and event pipeline.
        const internals = manager as unknown as { live: Map<string, WorkerSession>; openWorkerFor(args: {
          thread: { id: string }; requestContract: import('../extension/worker.ts').WorkerRequestContract;
          observeSession?: (session: WorkerSession) => void;
        }): Promise<{ session: WorkerSession }> };
        internals.openWorkerFor = async args => {
          const session = await openWorkerSession({ ctx, tools: ['read'], extensionPaths: [path],
            requestContract: args.requestContract, onCreated: args.observeSession });
          internals.live.set(args.thread.id, session);
          return { session };
        };
        setNext([{ type: 'toolCall', id: parent, name: 'codemode', arguments: { code: `
          await tools.good({secret: 'RAW-NESTED-ARGS'});
          await tools.good({});
          try { await tools.bad({}); } catch {}
          text('OUTER-PRINTED-SENTINEL');
          ${failOuter ? "throw new Error('outer failure');" : ''}` } }]);
        try {
          const result = await manager.dispatch({ model: 'fixture', reason: 'compact facts', task: 'run script', type: 'general' }, ctx, undefined);
          const compressorInput = JSON.stringify(requests.filter(request => JSON.stringify(request).includes('Transcript:')));
          assert.match(compressorInput, /nested tool: good.*succeeded/);
          assert.match(compressorInput, /nested tool: bad.*failed/);
          const saved = readFileSync(result.episode.file, 'utf8');
          assert.equal(saved, result.episodeText);
          assert.deepEqual(saved.split('\n').filter(line => line.startsWith('> nested tool calls:')),
            ['> nested tool calls: bad 1 failed, good 2 succeeded']);
          if (successfulCompression) {
            assert.match(saved, /compressor: codemode-offline\/compressor/);
            assert.doesNotMatch(saved, /\[nested tool:/);
          } else {
            assert.match(saved, /\[nested tool: good\]\nsucceeded/);
            assert.match(saved, /\[nested tool: bad\]\nfailed/);
            assert.equal(saved.match(/nested tool: good/g)?.length, 2);
            assert.equal(saved.match(/nested tool: bad/g)?.length, 1);
          }
          for (const text of [compressorInput, result.episodeText]) {
            assert.doesNotMatch(text, /RAW-NESTED-/);
            assert.match(text, /OUTER-PRINTED-SENTINEL/);
          }
          const failures = result.warnings.filter(warning => warning.includes('tool calls failed'));
          assert.equal(failures.length, failOuter ? 1 : 0, JSON.stringify(result.warnings));
          if (failOuter) assert.match(failures[0]!, /codemode \(1\)/);
          assert.equal(result.warnings.some(warning => warning.includes('reminder')), false);
        } finally { await manager.disposeAll(); }
      }, false, undefined, successfulCompression);
    }
  }
});

test("detached nested-only results do not set reminder evidence or rearm after an outer result", { timeout: 90000 }, async () => {
  const entered = gate();
  const release = gate();
  const ended = gate();
  const symbol = Symbol.for('slate-t7-detached');
  const state = { entered: entered.resolve, release: release.promise,
    execute: undefined as undefined | (() => Promise<unknown>) };
  (globalThis as Record<symbol, unknown>)[symbol] = state;
  try {
    await worker(`const state = globalThis[Symbol.for('slate-t7-detached')];
      register('held', { execute: async () => { state.entered(); await state.release; return { content: [], details: undefined }; } });
      register('bridge', { execute: async (_id, _args, _signal, _update, ctx) => {
        state.execute = () => ctx.executeTool('held', {});
        void state.execute(); return { content: [], details: undefined };
      }});`, async raw => {
      const session = raw as WorkerSession;
      session.subscribe(event => { if (event.type === 'tool_execution_end' && event.toolName === 'held') ended.resolve(); });
      try {
        await script(session, 'await tools.bridge({}); text("outer");');
        await entered.promise;
        assert.equal(session.messages.filter(isWorkerReminderMessage).length, 1);
        release.resolve();
        await ended.promise;
        // A subsequent real nested call has no outer result to supply a reminder.
        const before = session.messages.length;
        await state.execute!();
        assert.equal(session.messages.filter(isWorkerReminderMessage).length, 1);
        assert.equal(workerReminderDeliveryMissing(session.messages, session.workerReminderHandledToolResult(), false), false);
        assert.equal(session.messages.slice(before).filter(isWorkerReminderMessage).length, 0);
      } finally { release.resolve(); }
    });
  } finally { release.resolve(); delete (globalThis as Record<symbol, unknown>)[symbol]; }
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
