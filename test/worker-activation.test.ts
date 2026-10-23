import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { openWorkerSession, DEFAULT_WORKER_TOOLS, type WorkerSession } from "../extension/worker.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";
import { WORKER_NESTED_CLOSED_REASON } from "../extension/worker-nested-lifecycle.ts";

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('managed event timeout')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

const prefix = "slate: codemode is unavailable for this worker — ";
const failure = "worker extension startup failed worker extension failed to load\nunsafe";
const mode = process.env.SLATE_ACTIVATION_FAILURE;
const validationCause = mode === 'bad-name' || mode === 'undefined-name' || mode === 'undefined' || mode === 'non-function-creator'
  ? 'Invalid worker codemode component exports'
  : mode === 'non-function' ? 'Invalid worker codemode component factory' : undefined;
let importCalls = 0;
if (mode) {
  registerHooks({
    resolve(specifier, context, next) {
      if (mode === 'import' && specifier === './worker-codemode.ts' && ++importCalls === 1) throw Error(failure);
      return next(specifier, context);
    },
    load(url, context, next) {
      const result = next(url, context);
      if (!url.endsWith('/extension/worker-codemode.ts')) return result;
      if (mode === 'construction') return { ...result, source: String(result.source)
        .replace('export function createWorkerCodemodeComponent(', 'function realCreator(')
        + `\nlet calls = 0; export function createWorkerCodemodeComponent(...args) {
          if (++calls === 1) throw Error(${JSON.stringify(failure)}); return realCreator(...args); }` };
      if (mode === 'bad-name' || mode === 'undefined-name') return { ...result,
        source: String(result.source).replace('export const WORKER_CODEMODE_COMPONENT_NAME', 'const WORKER_CODEMODE_COMPONENT_NAME')
          + `\nconst invalidName = ${mode === 'bad-name' ? '"wrong"' : 'undefined'};
            export { invalidName as WORKER_CODEMODE_COMPONENT_NAME };` };
      const source = mode === 'factory' ? `export function createWorkerCodemodeComponent() { return () => { throw Error(${JSON.stringify(failure)}); }; }`
        : mode === 'missing' ? 'export function createWorkerCodemodeComponent() { return () => {}; }'
        : mode === 'undefined' ? 'export const createWorkerCodemodeComponent = undefined;'
        : mode === 'non-function-creator' ? 'export const createWorkerCodemodeComponent = {};'
        : mode === 'non-function' ? 'export function createWorkerCodemodeComponent() { return {}; }'
        : undefined;
      return source === undefined ? result : { ...result, source: source +
        '\nexport const WORKER_CODEMODE_COMPONENT_NAME = "slate-worker-codemode";' };
    },
  });
}

async function fixture(run: (ctx: ExtensionContext, path: string, declarations: string[][]) => Promise<void>, body = "", forceCodemodeCall = false, script?: string) {
  const root = mkdtempSync(join(tmpdir(), 'slate-activation-'));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE, pool: process.env.PI_CODEMODE_MAX_WORKERS };
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  try {
    process.env.PI_CODEMODE_MAX_WORKERS = '2';
    const path = join(root, 'extension.mjs');
    writeFileSync(path, `export default pi => {
      const register = name => pi.registerTool({ name, label: name, description: name,
        parameters: { type: 'object', properties: {} }, execute: async () => ({content: [], details: undefined}) });
      register('extra'); ${body}
    };`);
    const host = await ModelRuntime.create({ authPath: join(root, 'auth'), modelsPath: null,
      modelsStorePath: join(root, 'models'), allowModelNetwork: false, refreshOnCreate: false });
    const declarations: string[][] = [];
    host.registerProvider('activation', { api: 'activation-api', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:9',
      models: [{ id: 'worker', name: 'worker', reasoning: false, input: ['text'], contextWindow: 100000,
        maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, request) {
        declarations.push(request.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded?.map(t => t.name) ?? []));
        const call = script !== undefined && !request.messages.some(m => m.role === 'toolResult')
          || forceCodemodeCall && declarations.length === 1
          || (mode === 'import' || mode === 'construction' || validationCause !== undefined && !forceCodemodeCall)
            && !request.messages.some(m => m.role === 'toolResult');
        const read = !forceCodemodeCall && (mode === 'import' || validationCause !== undefined
          || mode === 'construction' && !declarations.at(-1)!.includes('codemode'));
        const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: call ? [{ type: 'toolCall', id: 'activation-call', name: read ? 'read' : 'codemode',
            arguments: read ? { path } : { code: script ?? 'text("recovered")' } }] : [{ type: 'text', text: 'complete' }],
          stopReason: call ? 'toolUse' : 'stop', timestamp: 1,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(); return stream;
      },
    });
    const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true,
      modelRegistry: new ModelRegistry(host), model: host.getModel('activation', 'worker') } as unknown as ExtensionContext;
    await run(ctx, path, declarations);
  } finally {
    if (previous.pool === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
    else process.env.PI_CODEMODE_MAX_WORKERS = previous.pool;
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous.offline;
    rmSync(root, { recursive: true, force: true });
  }
}

test("activation fixture restores absent, empty and external pool inputs", { timeout: 10000 }, async () => {
  const original = process.env.PI_CODEMODE_MAX_WORKERS;
  try {
    for (const previous of [undefined, "", "1", "9"]) {
      for (const failure of [false, true]) {
        if (previous === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
        else process.env.PI_CODEMODE_MAX_WORKERS = previous;
        const run = fixture(async (ctx, path) => {
          assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "2");
          const session = await openWorkerSession({ ctx, extensionPaths: [path], report() {} });
          await session.shutdownWorker();
        }, failure ? "pi.on('session_start', () => { throw Error('fixture startup failure'); });" : "");
        if (failure) await assert.rejects(run, /startup did not complete/);
        else await run;
        assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, previous);
      }
    }
  } finally {
    if (original === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
    else process.env.PI_CODEMODE_MAX_WORKERS = original;
  }
});

function manager(path: string, configured?: string[]) {
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{
    model: 'fixture', capabilityRating: 50, costRating: 50, effort: 'off', preferredProvider: 'activation',
    providers: { activation: 'worker' }, guidelines: [], cautions: [],
  }] } } } });
  return new ThreadManager(new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI), { workerTools: configured },
    () => ({ units: [], paths: [path], toolNames: ['extra', 'codemode'] }), runtime);
}

if (mode) {
  test('missing codemode child', { timeout: 15000 }, async () => {
    if (mode === 'import' || mode === 'construction') await fixture(async (ctx, path, declarations) => {
      if (mode === 'construction') {
        const instance = manager(path);
        try {
          const result = await instance.dispatch({ model: 'fixture', reason: 'construction failure',
            task: 'read direct tool', type: 'general' }, ctx, undefined);
          assert.equal(result.episode.status, 'ok');
          assert.deepEqual(result.warnings, [prefix + failure.replace(/\n/g, '')]);
          assert.doesNotMatch(result.episodeText, /Lifecycle failures:/);
          assert.ok(declarations.at(-1)!.includes('read'));
          assert.equal(declarations.at(-1)!.includes('codemode'), false);
        } finally { await instance.disposeAll(); }
      }
      const warnings: string[][] = [];
      const sessions: WorkerSession[] = [];
      const open = async () => {
        const messages: string[] = []; warnings.push(messages);
        try { return { session: await openWorkerSession({ ctx, tools: ['read'], report: m => messages.push(m),
          onCreated: session => { sessions.push(session); } }) }; }
        catch (error) { return { error }; }
      };
      try {
        const first = await Promise.all(Array.from({ length: mode === 'import' ? 3 : 0 }, open));
        const later = await open();
        const results = [...first, later];
        for (let i = 0; i < results.length; i++) {
          const session = results[i]!.session;
          assert.ok(session, String(results[i]!.error));
          const unavailable: boolean = mode === 'import';
          assert.equal(session.getActiveToolNames().includes('read'), true);
          assert.equal(session.getActiveToolNames().includes('codemode'), !unavailable);
          assert.equal(warnings[i]!.length, unavailable ? 1 : 0);
          if (unavailable) {
            assert.equal(warnings[i]![0], prefix + failure.replace(/\n/g, ''));
            await session.prompt('complete');
            if (mode === 'import') {
              const read = session.messages.find(m => m.role === 'toolResult');
              assert.ok(read && read.role === 'toolResult' && read.toolName === 'read' && !read.isError);
            }
          } else {
            assert.equal(session.getAllTools().find(t => t.name === 'codemode')?.sourceInfo?.path, '<inline:slate-worker-codemode>');
            await session.prompt('execute recovery');
            const result = session.messages.find(m => m.role === 'toolResult');
            assert.ok(result && result.role === 'toolResult');
            assert.notEqual(result.isError, true);
            assert.match(JSON.stringify(result.content), /recovered/);
          }
        }
        if (mode === 'import') assert.equal(importCalls, 1);
      } finally { await Promise.allSettled(sessions.map(session => session.shutdownWorker())); }
    });
    if (mode === 'construction') return;
    await fixture(async (ctx, path, declarations) => {
      for (const configured of [undefined, ['read', 'codemode'], ['*']]) {
        const instance = manager(path, configured);
        try {
          const result = await instance.dispatch({ model: 'fixture', reason: 'missing codemode', task: 'complete', type: 'general',
            tools: configured ? undefined : ['*'] }, ctx, undefined);
          assert.equal(result.episode.status, 'ok', JSON.stringify(result));
          const warnings = result.warnings.filter(w => w.startsWith(prefix));
          assert.equal(warnings.length, 1, JSON.stringify(result.warnings));
          if (validationCause !== undefined) assert.equal(warnings[0], prefix + validationCause);
          assert.doesNotMatch(warnings[0]!, /\n|\r/);
          assert.equal(result.warnings.some(w => w.startsWith('slate: worker extension failed to load')), false);
          assert.doesNotMatch(result.episodeText, /Lifecycle failures:/);
          assert.ok(declarations.at(-1)!.includes('extra'));
          assert.ok(declarations.at(-1)!.includes('read'));
          assert.equal(declarations.at(-1)!.includes('codemode'), false);
        } finally { await instance.disposeAll(); }
      }
    }, "pi.on('before_agent_start', () => register('codemode'));");
    if (validationCause !== undefined) await fixture(async (ctx, _path, declarations) => {
      const warnings: string[] = [];
      const session = await openWorkerSession({ ctx, tools: ['read'], report: warning => warnings.push(warning) });
      try {
        assert.deepEqual(warnings, [prefix + validationCause]);
        assert.deepEqual(session.getActiveToolNames(), ['read']);
        assert.equal(session.getAllTools().some(tool => tool.name === 'codemode'), false);
        await session.prompt('read the fixture');
        assert.deepEqual(declarations[0], ['read']);
        const result = session.messages.find(message => message.role === 'toolResult');
        assert.ok(result && result.role === 'toolResult' && result.toolName === 'read' && !result.isError);
        assert.match(JSON.stringify(result.content), /register\('extra'\)/);
      } finally { await session.shutdownWorker(); }
    });
    await fixture(async (ctx, path, declarations) => {
      const session = await openWorkerSession({ ctx, tools: ['*'], extensionPaths: [path] });
      try {
        await session.prompt('attempt external codemode');
        assert.equal(declarations.flat().includes('codemode'), false);
        assert.equal(existsSync(join(ctx.cwd, 'executed')), false, 'excluded codemode must not execute');
      } finally { await session.shutdownWorker(); }
    }, `pi.on('before_agent_start', () => pi.registerTool({ name: 'codemode', label: 'external', description: 'external',
      parameters: { type: 'object', properties: {} }, execute: async () => {
        (await import('node:fs')).writeFileSync(new URL('./executed', import.meta.url), 'executed');
        return { content: [], details: undefined };
      } }));`, true);
    await fixture(async (ctx, path) => {
      const instance = manager(path);
      const controller = new AbortController();
      const key = Symbol.for('slate-activation-classification');
      const globals = globalThis as Record<symbol, unknown>;
      globals[key] = () => controller.abort();
      try {
        await assert.rejects(instance.dispatch({ model: 'fixture', reason: 'startup classification',
          task: 'must not run', type: 'general' }, ctx, controller.signal), error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /cancelled by the caller/);
          assert.equal(error.message.includes(prefix), false, 'optional codemode warning must not enter lifecycle failure diagnostics');
          return true;
        });
      } finally { delete globals[key]; await instance.disposeAll(); }
    }, "pi.on('session_start', () => { globalThis[Symbol.for('slate-activation-classification')](); throw Error('classification startup failure'); });");
  });
} else {
  for (const failureMode of ['import', 'undefined', 'non-function-creator', 'construction', 'factory', 'missing', 'bad-name', 'undefined-name', 'non-function']) {
    test(`missing codemode continues dispatch with one warning: ${failureMode}`, { timeout: 25000 }, () => {
      const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^missing codemode child$', fileURLToPath(import.meta.url)], {
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, PI_CODEMODE_MAX_WORKERS: '2', SLATE_ACTIVATION_FAILURE: failureMode }, encoding: 'utf8', timeout: 20000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
  for (const selection of ['default', 'configured', 'explicit']) {
    test(`production ${selection} tools include owned codemode and extension tools`, { timeout: 15000 }, async () => {
      await fixture(async (ctx, path, declarations) => {
        const instance = manager(path, selection === 'configured' ? ['read'] : undefined);
        try {
          const result = await instance.dispatch({ model: 'fixture', reason: 'production tools', task: 'complete', type: 'general',
            tools: selection === 'explicit' ? ['read'] : undefined }, ctx, undefined);
          assert.equal(result.episode.status, 'ok');
          assert.deepEqual(declarations[0]!.sort(), [...(selection === 'default' ? DEFAULT_WORKER_TOOLS : ['read']), 'extra', 'codemode'].sort());
          assert.equal(result.warnings.some(w => w.startsWith(prefix)), false);
        } finally { await instance.disposeAll(); }
      });
    });
  }
  for (const tools of [['-bash'], ['+read'], ['-codemode'], ['+codemode'], ['-bash', '-extra', '-late']]) {
    for (const withExtension of [false, true]) {
      test(`modifier tools ${tools} with extension=${withExtension}`, { timeout: 15000 }, async () => {
        await fixture(async (ctx, path, declarations) => {
          const session = await openWorkerSession({ ctx, tools,
            extensionPaths: withExtension ? [path] : [],
            extensionToolNames: withExtension ? ['late'] : [] });
          try {
            await session.prompt('complete');
            const expected = ['read', 'bash', 'edit', 'write']
              .filter(name => tools[0] !== `-${name}`);
            assert.deepEqual(declarations[0]!.sort(), [...expected, 'codemode', ...(withExtension ? ['extra', 'late'] : [])].sort());
          } finally { await session.shutdownWorker(); }
        }, "pi.on('before_agent_start', () => register('late'));");
      });
    }
  }
  for (const configured of [false, true]) {
    test(`modifier dispatch configured=${configured}`, { timeout: 15000 }, async () => {
      await fixture(async (ctx, path, declarations) => {
        const instance = manager(path, configured ? ['-bash'] : undefined);
        try {
          const result = await instance.dispatch({ model: 'fixture', reason: 'modifier tools', task: 'complete', type: 'general',
            tools: configured ? undefined : ['-bash'] }, ctx, undefined);
          assert.equal(result.episode.status, 'ok');
          assert.deepEqual(declarations[0]!.sort(), ['read', 'edit', 'write', 'extra', 'codemode'].sort());
        } finally { await instance.disposeAll(); }
      });
    });
  }
  for (const startup of [false, true]) {
    test(`external codemode is refused by ${startup ? 'startup' : 'post-load'} scan`, { timeout: 10000 }, async () => {
      await fixture(async (ctx, path) => {
        let created = false;
        await assert.rejects(openWorkerSession({ ctx, extensionPaths: [path], onCreated() { created = true; } }),
          startup ? /refusing to start worker.*codemode/ : /refusing to open worker.*codemode/);
        assert.equal(created, startup, 'post-load collision must reject before session creation');
      }, startup ? "pi.on('session_start', () => register('codemode'));" : "register('codemode');");
    });
  }
  test('managed settlement aborts a host waiter while external holders stay active', { timeout: 20000 }, async () => {
    await fixture(async (ctx, path) => {
      // Dynamic import keeps the failure-child loader hooks effective.
      const { createWorkerCodemodeComponent } = await import("../extension/worker-codemode.ts");
      let tool!: import("@earendil-works/pi-coding-agent").ToolDefinition;
      createWorkerCodemodeComponent(message => assert.fail(message))({
        registerTool(value: typeof tool) { tool = value; }, on() {}, getAllTools: () => [],
      } as unknown as ExtensionAPI);
      const releases: (() => void)[] = [];
      const controllers: AbortController[] = [];
      const results: Promise<unknown>[] = [];
      const hold = (id: string) => {
        let entered!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { releases.push(resolve); });
        const controller = new AbortController(); controllers.push(controller);
        const context = { tools: [{ name: 'held', description: 'held', parameters: { type: 'object', properties: {} } }],
          sessionManager: { getBranch: () => [] }, async executeTool() {
            entered(); await gate;
            return { toolCall: { id }, isError: false, result: { content: [], details: undefined } };
          } } as unknown as ExtensionToolContext;
        const result = tool.execute(id, { code: 'await tools.held({});' }, controller.signal, undefined, context);
        results.push(result);
        return { ready, result };
      };
      let session: WorkerSession | undefined;
      try {
        // Bounded full-capacity precondition, not merely completion of prior results.
        const probes = [hold('probe-a'), hold('probe-b')];
        await within(Promise.all(probes.map(p => p.ready)));
        releases.forEach(release => release());
        await within(Promise.all(probes.map(p => p.result)));
        const holders = [hold('a'), hold('b')];
        await within(Promise.all(holders.map(h => h.ready)));
        session = await openWorkerSession({ ctx, tools: ['read'], extensionPaths: [path] });
        let update!: () => void;
        const updated = new Promise<void>(resolve => { update = resolve; });
        let finished = false, nested = 0;
        session.subscribe(event => {
          // pi 1.4.0 dist/extensions/codemode/execute.js:445-485 publishes
          // the first update before synchronous waiter registration. Resolve
          // only here, then await before settlement. Never abort in the handler.
          if (event.type === 'tool_execution_update' && event.toolCallId === 'activation-call') update();
          if (event.type === 'tool_execution_start' && typeof event.parentToolCallId === 'string') nested++;
          if (event.type === 'tool_execution_end' && event.toolCallId === 'activation-call') finished = true;
        });
        const prompt = session.prompt('run the script');
        await within(updated);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(finished, false); assert.equal(nested, 0);
        await within(session.settleManagedOperations());
        await within(prompt);
        const result = session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'activation-call');
        assert.ok(result && result.role === 'toolResult');
        assert.equal(result.isError, true);
        assert.deepEqual((result.details as { calls: unknown[] }).calls, []);
        assert.match(JSON.stringify(result.content), /Script aborted[\s\S]*The script did not start/);
        assert.equal(nested, 0);
        await within(session.shutdownWorker());
      } finally {
        try {
          controllers.forEach(c => c.abort()); releases.forEach(release => release());
          await within(Promise.allSettled(results));
        } finally { if (session) await within(session.shutdownWorker()); }
      }
    }, "", false, 'await tools.read({ path: "must-not-enter" });');
  });
  test('startup failure closes codemode admission and permits repeatable shutdown', { timeout: 10000 }, async () => {
    await fixture(async (ctx, path) => {
      let created: WorkerSession | undefined;
      await assert.rejects(openWorkerSession({ ctx, extensionPaths: [path], deferShutdownOnOpenFailure: true, report() {}, onCreated(session) { created = session; } }), /startup did not complete/);
      assert.ok(created);
      try {
        const result = await created.extensionRunner.emitToolCall({
          type: 'tool_call', toolName: 'codemode', toolCallId: 'after-startup-failure', input: { code: 'return 1;' },
        });
        assert.deepEqual(result, { block: true, reason: WORKER_NESTED_CLOSED_REASON });
      } finally { await within(created.shutdownWorker()); await within(created.shutdownWorker()); }
    }, "pi.on('session_start', () => { throw Error('startup fixture'); });");
  });
}
