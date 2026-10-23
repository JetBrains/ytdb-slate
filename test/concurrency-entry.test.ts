import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";
import { bindFakeWorkerRequest } from "./worker-request-contract-fixture.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
class Api {
  handlers = new Map<string, Handler[]>();
  tools = new Map<string, any>();
  on(name: string, handler: Handler) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  registerTool(tool: any) { this.tools.set(tool.name, tool); }
  registerCommand() {}
  getActiveTools() { return []; }
  setActiveTools() {}
  getAllTools() { return []; }
  appendEntry() {}
  sendMessage() {}
  getThinkingLevel() { return undefined; }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const key = Symbol.for("ytdb-slate.codemode-limit.v1");
const shared = globalThis as typeof globalThis & { [key]?: { lastWritten?: string } };

test("startup commits the validated limit at manager publication", { timeout: 20000 }, async (t) => {
  const names = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_CODEMODE_MAX_WORKERS"] as const;
  const saved = names.map(name => process.env[name]);
  const hadRecord = Object.hasOwn(shared, key), record = shared[key];
  const root = mkdtempSync(join(tmpdir(), "slate-concurrency-entry-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const apis: Api[] = [];
  const originalDispose = ThreadManager.prototype.disposeAll;
  const originalDispatch = ThreadManager.prototype.dispatch;
  let disposal: (() => Promise<void>) | undefined;
  let selected: ThreadManager | undefined;
  t.mock.method(ThreadManager.prototype, "disposeAll", function(this: ThreadManager) {
    return disposal ? disposal() : originalDispose.call(this);
  });
  const dispatched = new Error("captured production dispatch boundary");
  t.mock.method(ThreadManager.prototype, "dispatch", function(this: ThreadManager) {
    selected = this;
    throw dispatched;
  });
  let restoreError = false;
  const originalRestore = SlateStore.prototype.restore;
  t.mock.method(SlateStore.prototype, "restore", function(this: SlateStore, ctx: ExtensionContext) {
    if (restoreError) throw new Error("restore failed");
    return originalRestore.call(this, ctx);
  });
  function source(name: string, value: unknown) {
    const cwd = join(root, name);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi/slate.json"), JSON.stringify(value));
    return cwd;
  }
  function context(cwd: string, trusted = true) {
    const warnings: string[] = [];
    const ctx = {
      cwd, hasUI: true, mode: "rpc", isProjectTrusted: () => trusted,
      model: undefined, modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, reasoning: true, thinkingLevelMap: { max: "max" } }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
      },
      sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "fixture" },
      ui: { notify: (message: string) => warnings.push(message), setWidget() {}, setStatus() {} },
    } as unknown as ExtensionContext;
    return { ctx, warnings };
  }
  function factory(make = slateExtension) {
    const api = new Api();
    make(api as unknown as ExtensionAPI);
    apis.push(api);
    return api;
  }
  async function start(api: Api, ctx: ExtensionContext) {
    await api.handlers.get("session_start")![0]!({}, ctx);
  }
  async function manager(api: Api, ctx: ExtensionContext) {
    selected = undefined;
    await assert.rejects(api.tools.get("thread").execute("fixture", { model: "fixture", reason: "fixture", type: "general", task: "fixture" }, undefined, undefined, ctx), error => error === dispatched);
    assert.ok(selected);
    return selected as ThreadManager;
  }
  async function capacity(manager: ThreadManager, count: number) {
    const semaphore = (manager as unknown as { semaphore: { acquire(): Promise<void>; release(): void } }).semaphore;
    await Promise.all(Array.from({ length: count }, () => semaphore.acquire()));
    let entered = false;
    const next = semaphore.acquire().then(() => { entered = true; });
    try {
      await Promise.resolve();
      assert.equal(entered, false);
    } finally {
      semaphore.release();
      await next;
      for (let index = 0; index < count; index++) semaphore.release();
    }
    assert.equal(entered, true);
  }
  try {
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_OFFLINE = "1";
    delete process.env.PI_CODEMODE_MAX_WORKERS;
    delete shared[key];
    const empty = context(source("empty", {}));
    const api = factory();
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, undefined, "factory construction does not write");
    await start(api, empty.ctx);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "8");
    await capacity(await manager(api, empty.ctx), 8);

    writeFileSync(join(agent, "slate.json"), JSON.stringify({ maxConcurrent: 3, router: { models: { replace: [{ model: "luna-6", preferredProvider: "test", providers: { test: "worker" } }] } } }));
    await start(api, empty.ctx);
    assert.equal((await manager(api, empty.ctx)).getConfig().maxConcurrent, 3);
    const project = context(source("project", { maxConcurrent: 1 }));
    await start(api, project.ctx);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");
    await capacity(await manager(api, project.ctx), 1);
    const untrusted = context(project.ctx.cwd, false);
    await start(api, untrusted.ctx);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "3");

    for (const override of [undefined, ""]) {
      if (override === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
      else process.env.PI_CODEMODE_MAX_WORKERS = override;
      const invalid = context(source("invalid", { maxConcurrent: "secret-invalid-input" }));
      await start(api, invalid.ctx);
      assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, override ?? "8");
      assert.equal((await manager(api, invalid.ctx)).getConfig().maxConcurrent, 8);
      assert.deepEqual(invalid.warnings, ["slate: maxConcurrent must be a positive safe integer. Using 8."]);
    }
    delete process.env.PI_CODEMODE_MAX_WORKERS;
    await start(api, project.ctx);
    const before = await manager(api, project.ctx);
    const ownership = { ...shared[key] };
    disposal = async () => { throw new Error("dispose failed"); };
    await assert.rejects(start(api, empty.ctx), /dispose failed/);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");
    assert.deepEqual(shared[key], ownership);
    assert.strictEqual(await manager(api, project.ctx), before);
    disposal = undefined;

    for (const override of [undefined, "9"]) {
      if (override === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
      else process.env.PI_CODEMODE_MAX_WORKERS = override;
      restoreError = true;
      await assert.rejects(start(api, empty.ctx), /restore failed/);
      restoreError = false;
      const published = await manager(api, empty.ctx);
      assert.notStrictEqual(published, before);
      assert.equal(published.getConfig().maxConcurrent, 3);
      const fields = published as unknown as {
        live: Map<string, unknown>;
        openWorkerFor(args: { thread: { id: string }; requestContract: import("../extension/worker.ts").WorkerRequestContract }): Promise<unknown>;
      };
      fields.openWorkerFor = async ({ thread, requestContract }) => {
        const messages: unknown[] = [];
        const listeners = new Set<(event: unknown) => void>();
        const session = {
          messages, model: { provider: "test", id: "worker" }, thinkingLevel: "max",
          sessionFile: undefined, getContextUsage: () => undefined,
          setThinkingLevel(level: string) { session.thinkingLevel = level; },
          subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
          dispose() {},
          async prompt() {
            const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
            messages.push(message);
            for (const listener of listeners) listener({ type: "message_end", message });
          },
        };
        bindFakeWorkerRequest(session, requestContract);
        fields.live.set(thread.id, session);
        return { session, baseline: {} };
      };
      const result = await originalDispatch.call(published, { model: "luna-6", reason: "fixture", type: "general", task: "prove published dispatch" }, empty.ctx, undefined);
      assert.equal(result.thread.status, "successful");
      assert.match(result.episodeText, /done/);
      await capacity(published, 3);
      assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, override ?? "3");
    }

    delete process.env.PI_CODEMODE_MAX_WORKERS;
    await start(api, project.ctx);
    const held = gate();
    disposal = () => held.promise;
    const stale = start(api, empty.ctx);
    disposal = undefined;
    await start(api, project.ctx);
    const currentRecord = { ...shared[key] };
    held.release();
    await stale;
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");
    assert.deepEqual(shared[key], currentRecord);

    const external = gate();
    disposal = () => external.promise;
    const pending = start(api, empty.ctx);
    process.env.PI_CODEMODE_MAX_WORKERS = "08";
    disposal = undefined;
    external.release();
    await pending;
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "08");
    assert.deepEqual(shared[key], {});

    delete process.env.PI_CODEMODE_MAX_WORKERS;
    const slow = factory(), fast = factory();
    const reverse = gate();
    disposal = () => reverse.promise;
    const first = start(slow, project.ctx);
    disposal = undefined;
    await start(fast, empty.ctx);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "3");
    const earlier = await manager(fast, empty.ctx);
    reverse.release();
    await first;
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");
    await capacity(earlier, 3);
    await fast.handlers.get("session_shutdown")![0]!({ reason: "replace" }, empty.ctx);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");

    const retired = factory(), retireGate = gate();
    disposal = () => retireGate.promise;
    const rejected = start(retired, empty.ctx);
    disposal = undefined;
    await retired.handlers.get("session_shutdown")![0]!({ reason: "replace" }, empty.ctx);
    const retirementRecord = { ...shared[key] };
    retireGate.release();
    await rejected;
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");
    assert.deepEqual(shared[key], retirementRecord);

    const reloaded = await import(new URL("../extension/index.ts?reload-concurrency", import.meta.url).href);
    await start(factory(reloaded.default), empty.ctx);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "3");
    await start(factory(), project.ctx);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");

    const childCode = `
      import slate from ${JSON.stringify(new URL("../extension/index.ts", import.meta.url).href)};
      const handlers = new Map();
      slate({ on(name, handler) { if (!handlers.has(name)) handlers.set(name, handler); },
        registerTool() {}, registerCommand() {}, getActiveTools() { return []; },
        setActiveTools() {}, getAllTools() { return []; }, appendEntry() {},
        sendMessage() {}, getThinkingLevel() {} });
      await handlers.get("session_start")({}, {
        cwd: ${JSON.stringify(empty.ctx.cwd)}, mode: "rpc", hasUI: false,
        isProjectTrusted: () => true, sessionManager: { getBranch: () => [], getEntries: () => [] },
        modelRegistry: {}
      });
      console.log(JSON.stringify(process.env.PI_CODEMODE_MAX_WORKERS));
    `;
    for (const mode of ["inherited", "absent", "empty"]) {
      const env = { ...process.env };
      if (mode === "absent") delete env.PI_CODEMODE_MAX_WORKERS;
      if (mode === "empty") env.PI_CODEMODE_MAX_WORKERS = "";
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], { env, encoding: "utf8", timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout.trim()), mode === "inherited" ? "1" : mode === "absent" ? "3" : "");
    }
  } finally {
    try {
      disposal = undefined;
      restoreError = false;
      for (const api of apis) await api.handlers.get("session_shutdown")![0]!({ reason: "replace" }, {} as ExtensionContext);
    } finally {
      try {
        names.forEach((name, index) => {
          const value = saved[index];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        });
        if (hadRecord) shared[key] = record;
        else delete shared[key];
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
