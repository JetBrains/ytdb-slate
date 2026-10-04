// record-tool-test: all
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { createChangeDirectory } from "../extension/slate-files.ts";
import { buildRecordAssignment } from "../extension/record-names.ts";
import { recordOwnership } from "../extension/record-ownership.ts";
import { prepareRecordWrite, recordHash } from "../extension/record-write.ts";
import { openWorkerSession, type WorkerSession } from "../extension/worker.ts";
import { ThreadManager } from "../extension/threads.ts";
import { SlateStore } from "../extension/state.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import { createBaseModelTracker } from "../extension/base-model.ts";

function barrier() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function context(cwd: string): ExtensionContext { return { cwd, mode: "rpc", hasUI: false, isProjectTrusted: () => true,
  sessionManager: { getSessionId: () => "owner", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
  modelRegistry: { find: (provider: string, id: string) => ({ provider, id, reasoning: false }), getRegisteredProviderIds: () => [],
    hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline" }), getAvailable: async () => [] } } as unknown as ExtensionContext; }
function fixture(t: import("node:test").TestContext) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "slate-record-transition-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent"); mkdirSync(process.env.PI_CODING_AGENT_DIR);
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(cwd, { recursive: true, force: true }); });
  const api = { on() {}, registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
  const store = new SlateStore(api); store.currentChange = createChangeFolder(); createChangeDirectory(cwd, store.currentChange);
  return { cwd, store, api, ctx: context(cwd) };
}

for (const entry of ["closeManagedOperations", "settleManagedOperations", "shutdownWorker", "closeWorker", "disposeAll"] as const) {
  for (const boundary of ["runtime", "lease"] as const) {
    test(`record-abort-settlement real ${entry} joins held ${boundary} calls and refuses late writes`, { timeout: 20000 }, async (t) => {
      const f = fixture(t), owner = recordOwnership(f.store), folder = f.store.currentChange;
      const assignment = buildRecordAssignment({ type: "implementer", trackNumber: "2.4" }, folder, undefined)!;
      const lease = owner.reserve(assignment), entered = barrier(), release = barrier();
      const session = await openWorkerSession({ ctx: f.ctx, recordLease: lease, extensionPaths: [], tools: ["read"] });
      const tool = session.agent.state.tools.find((tool) => tool.name === "slate_record")!;
      const args = { record: assignment.names[0]!, mode: "create", payload: "bound bytes" };
      await tool.execute("create", args, undefined, undefined);
      let running: Promise<unknown>;
      if (boundary === "runtime") {
        const call = lease.call.bind(lease);
        let first = true;
        lease.call = async (operation) => { if (first) { first = false; entered.resolve(); await release.promise; } return call(operation); };
        running = tool.execute("held", { ...args, mode: "append", payload: "+held", expectedHash: recordHash(Buffer.from("bound bytes")) }, undefined, undefined);
      } else {
        running = lease.call(async () => {
          const prepared = await prepareRecordWrite({ projectRoot: f.cwd, assignment }, { ...args, mode: "append", payload: "+held", expectedHash: recordHash(Buffer.from("bound bytes")) });
          entered.resolve(); await release.promise; return prepared.publish();
        });
      }
      await entered.promise;
      const manager = new ThreadManager(f.store, {});
      const view = manager as unknown as { live: Map<string, WorkerSession>; closeWorker(id: string, session: WorkerSession): Promise<void> };
      view.live.set("t1", session);
      let finished = false;
      let transfer: Promise<void>;
      if (entry === "closeManagedOperations") {
        session.closeManagedOperations();
        assert.throws(() => lease.check(), /admission ended/);
        transfer = session.settleManagedOperations();
      } else if (entry === "closeWorker") transfer = view.closeWorker("t1", session);
      else if (entry === "disposeAll") transfer = manager.disposeAll();
      else transfer = session[entry]();
      const settled = transfer.then(() => { finished = true; });
      try {
        assert.throws(() => lease.check(), /admission ended/);
        if (entry === "disposeAll") assert.throws(() => owner.reserve(buildRecordAssignment({ type: "general", records: ["status.md"] }, folder, undefined)!), /admission is closed/);
        await tick(); assert.equal(finished, false, "the real entry point must join the held call");
        assert.equal(f.store.currentChange, folder);
        assert.equal(readFileSync(join(f.cwd, assignment.currentFolder, args.record), "utf8"), "bound bytes");
        const late = tool.execute("late", { ...args, mode: "append", payload: "+late", expectedHash: recordHash(Buffer.from("bound bytes")) }, undefined, undefined);
        release.resolve(); await running;
        const result = await late;
        assert.match(JSON.stringify(result), /refused before publication/);
        await settled;
        assert.equal(finished, true);
        assert.equal(readFileSync(join(f.cwd, assignment.currentFolder, args.record), "utf8"), boundary === "lease" ? "bound bytes+held" : "bound bytes");
      } finally { release.resolve(); await running; await settled; await session.shutdownWorker(); lease.release(); }
    });
  }
}

for (const event of ["session_start", "session_shutdown"] as const) {
  test(`record-abort-settlement real index ${event} awaits teardown before folder fork`, { timeout: 10000 }, async (t) => {
    const f = fixture(t), hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
    const original = f.store.currentChange;
    let snapshot: any = { ...f.store.snapshot(), changeOwnerSessionId: "owner", orchestratorMode: true };
    extension({ on(name: string, hook: Function) { hooks.set(name, [...hooks.get(name) ?? [], hook]); }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
      appendEntry(_type: string, value: unknown) { snapshot = structuredClone(value); }, getActiveTools: () => ["thread", "read", "slate_change"], setActiveTools() {}, getAllTools: () => [], getThinkingLevel: () => "off" } as unknown as ExtensionAPI);
    const ctx = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getBranch: () => [{ type: "custom", customType: "slate-state", data: snapshot }] } } as unknown as ExtensionContext;
    for (const hook of hooks.get("session_start") ?? []) await hook({}, ctx);
    const entered = barrier(), release = barrier();
    let lease!: ReturnType<ReturnType<typeof recordOwnership>["reserve"]>;
    const dispatch = ThreadManager.prototype.dispatch;
    ThreadManager.prototype.dispatch = async function (opts) {
      const store = (this as unknown as { store: SlateStore }).store;
      lease = recordOwnership(store).reserve(opts.recordAssignment!);
      const held = lease.call(async () => { entered.resolve(); await release.promise; });
      (this as unknown as { live: Map<string, WorkerSession> }).live.set("t1", { closeManagedOperations: () => lease.close(), settleManagedOperations: () => held, shutdownWorker: async () => {}, abort: async () => {} } as unknown as WorkerSession);
      await held;
      return { thread: { id: "t1", name: "writer", type: "implementer", status: "successful", createdAt: 0, updatedAt: 0 }, episode: { id: "t1.e1", threadId: "t1", task: "write", status: "ok", file: "unused", createdAt: 0 }, episodeText: "done", warnings: [], usage: { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 } };
    };
    t.after(() => { ThreadManager.prototype.dispatch = dispatch; });
    const writer = tools.get("thread").execute("writer", { type: "implementer", trackNumber: "2.4", task: "write", model: "sol-6.1", reason: "fixture" }, undefined, undefined, ctx);
    await entered.promise;
    const fresh = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "fork-owner" } } as unknown as ExtensionContext;
    let finished = false;
    const transfer = (async () => {
      for (const hook of hooks.get(event) ?? []) await hook({}, event === "session_start" ? fresh : ctx);
      finished = true;
    })();
    try {
      await tick(); assert.equal(finished, false, "index must await manager.disposeAll");
      assert.throws(() => lease.check(), /admission ended/);
      assert.equal(snapshot.currentChange, original);
      assert.deepEqual(readdirSync(join(f.cwd, "slate-changes")), [original!]);
      const late = assert.rejects(lease.call(async () => {}), /admission ended/);
      release.resolve(); await late;
    } finally { release.resolve(); await writer; await transfer; lease.release(); }
    if (event === "session_shutdown") for (const hook of hooks.get("session_start") ?? []) await hook({}, fresh);
    assert.notEqual(snapshot.currentChange, original);
    assert.equal(snapshot.sourceChange, original);
    assert.equal(snapshot.changeOwnerSessionId, "fork-owner");
    assert.equal(readFileSync(join(f.cwd, "slate-changes", snapshot.currentChange, "research-log.md"), "utf8"), `Read-only earlier log: slate-changes/${original}/research-log.md\n`);
    assert.deepEqual(readdirSync(join(f.cwd, "slate-changes", original!)), ["research-log.md"]);
    await tools.get("thread").execute("fork-writer", { type: "implementer", trackNumber: "2.4", task: "write in fork", model: "sol-6.1", reason: "fixture" }, undefined, undefined, fresh);
    assert.equal(lease.assignment.currentFolder, `slate-changes/${snapshot.currentChange}`);
    lease.release();
  });
}

test("record-abort-settlement cancelled idle handoff keeps the current action writable", { timeout: 10000 }, async (t) => {
  const f = fixture(t), owner = recordOwnership(f.store);
  const assignment = buildRecordAssignment({ type: "implementer", trackNumber: "2.4" }, f.store.currentChange, undefined)!;
  const record = assignment.names[0]!;
  const lease = owner.reserve(assignment);
  const hooks = registerSlateHandoff(f.api, f.store, () => ({}), () => createBaseModelTracker({ warn() {} }));
  await assert.rejects(hooks.startHandoff({ ...f.ctx, waitForIdle: async () => { throw new Error("handoff cancelled while waiting"); }, newSession: async () => { assert.fail("cancelled handoff must not replace the session"); } } as any), /cancelled/);
  lease.check();
  const create = await lease.call(async () => (await prepareRecordWrite({ projectRoot: f.cwd, assignment }, { record, mode: "create", payload: "still writable" })).publish());
  const appended = await lease.call(async () => (await prepareRecordWrite({ projectRoot: f.cwd, assignment }, { record, mode: "append", payload: "+later bytes", expectedHash: create.observedAfterHash })).publish());
  assert.equal(appended.state, "published and synced");
  assert.equal(readFileSync(join(f.cwd, assignment.currentFolder, record), "utf8"), "still writable+later bytes"); lease.release();
});
