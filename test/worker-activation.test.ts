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

const prefix = "slate: codemode is unavailable for this worker — ";
const failure = "worker extension startup failed worker extension failed to load\nunsafe";
const mode = process.env.SLATE_ACTIVATION_FAILURE;
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
      const source = mode === 'factory' ? `export function createWorkerCodemodeComponent() { return () => { throw Error(${JSON.stringify(failure)}); }; }`
        : mode === 'missing' ? 'export function createWorkerCodemodeComponent() { return () => {}; }'
        : mode === 'undefined' ? 'export const createWorkerCodemodeComponent = undefined;'
        : mode === 'bad-name' ? 'export function createWorkerCodemodeComponent() { return () => {}; }'
        : mode === 'non-function' ? 'export function createWorkerCodemodeComponent() { return {}; }'
        : undefined;
      return source === undefined ? result : { ...result, source: source +
        `\nexport const WORKER_CODEMODE_COMPONENT_NAME = ${JSON.stringify(mode === 'bad-name' ? 'wrong' : 'slate-worker-codemode')};` };
    },
  });
}

async function fixture(run: (ctx: ExtensionContext, path: string, declarations: string[][]) => Promise<void>, body = "", forceCodemodeCall = false) {
  const root = mkdtempSync(join(tmpdir(), 'slate-activation-'));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  try {
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
        const call = forceCodemodeCall && declarations.length === 1
          || (mode === 'import' || mode === 'construction') && !request.messages.some(m => m.role === 'toolResult');
        const read = mode === 'import' || mode === 'construction' && !declarations.at(-1)!.includes('codemode');
        const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: call ? [{ type: 'toolCall', id: 'activation-call', name: read ? 'read' : 'codemode',
            arguments: read ? { path } : { code: 'text("recovered")' } }] : [{ type: 'text', text: 'complete' }],
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
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous.offline;
    rmSync(root, { recursive: true, force: true });
  }
}

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
          assert.doesNotMatch(warnings[0]!, /\n|\r/);
          assert.equal(result.warnings.some(w => w.startsWith('slate: worker extension failed to load')), false);
          assert.doesNotMatch(result.episodeText, /Lifecycle failures:/);
          assert.ok(declarations.at(-1)!.includes('extra'));
          assert.ok(declarations.at(-1)!.includes('read'));
          assert.equal(declarations.at(-1)!.includes('codemode'), false);
        } finally { await instance.disposeAll(); }
      }
    }, "pi.on('before_agent_start', () => register('codemode'));");
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
  for (const failureMode of ['import', 'undefined', 'construction', 'factory', 'missing', 'bad-name', 'non-function']) {
    test(`missing codemode continues dispatch with one warning: ${failureMode}`, { timeout: 25000 }, () => {
      const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^missing codemode child$', fileURLToPath(import.meta.url)], {
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, SLATE_ACTIVATION_FAILURE: failureMode }, encoding: 'utf8', timeout: 20000,
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
  test('production opening connects queued scripts to the close signal', { timeout: 90000 }, async () => {
    await fixture(async (ctx, path) => {
      const session = await openWorkerSession({ ctx, extensionPaths: [path] });
      const tool = session.resourceLoader.getExtensions().extensions.find(e => e.path === '<inline:slate-worker-codemode>')!.tools.get('codemode')!.definition;
      let release!: () => void;
      let entered!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      let count = 0;
      const context = { tools: [{ name: 'held', description: 'held', parameters: { type: 'object', properties: {} } }],
        sessionManager: { getBranch: () => [] }, async executeTool() {
          if (++count === 2) entered();
          await hold;
          return { toolCall: { id: 'held' }, isError: false, result: { content: [], details: undefined } };
        } } as unknown as ExtensionToolContext;
      const run = (id: string) => tool.execute(id, { code: 'await tools.held({});' }, undefined, undefined, context);
      const running = [run('first'), run('second')];
      try {
        await Promise.race([ready, Promise.all(running).then(() => { throw Error('scripts ended before entering held tools'); })]);
        const waiting = run('waiting');
        session.closeManagedOperations();
        const stopped = await waiting;
        assert.equal(stopped.isError, true);
        assert.match(JSON.stringify(stopped.content), /Operation aborted/);
        assert.equal(count, 2);
      } finally { release(); await Promise.all(running); await session.shutdownWorker(); }
    });
  });
  test('startup failure after codemode load closes its queue signal', { timeout: 10000 }, async () => {
    await fixture(async (ctx, path) => {
      let created: WorkerSession | undefined;
      await assert.rejects(openWorkerSession({ ctx, extensionPaths: [path], report() {}, onCreated(session) { created = session; } }), /startup did not complete/);
      assert.ok(created);
      const owned = created.resourceLoader.getExtensions().extensions.find(e => e.path === '<inline:slate-worker-codemode>');
      const tool = owned!.tools.get('codemode')!;
      const result = await tool.definition.execute('after-startup-failure', { code: 'return 1;' }, undefined, undefined, {} as ExtensionToolContext);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Operation aborted/);
    }, "pi.on('session_start', () => { throw Error('startup fixture'); });");
  });
}
