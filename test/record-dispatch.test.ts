// record-tool-test: all
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AgentTool, runToolCall as RunToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";
const { runToolCall } = await import(pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js")).href) as { runToolCall: typeof RunToolCall };
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function parseFacts(text: string) { return text.slice(text.lastIndexOf("## Record call outcomes") + "## Record call outcomes\n".length).trim().split("\n").map((line) => JSON.parse(line)); }
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { buildRecordAssignment } from "../extension/record-names.ts";
import { recordOwnership, type RecordLease } from "../extension/record-ownership.ts";
import { createRecordWorkerRuntime } from "../extension/record-worker.ts";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { createChangeDirectory } from "../extension/slate-files.ts";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { ThreadManager } from "../extension/threads.ts";
import { SlateStore } from "../extension/state.ts";
import type { WorkerSession, WorkerRequestContract } from "../extension/worker.ts";

function barrier() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
function runtime() {
  const policy = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, costRating: 50, effort: "off", preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
  return Object.freeze({ ...policy, validateRoute: async () => ({ ok: true } as const) });
}
function context(cwd: string): ExtensionContext { return { cwd, mode: "rpc", hasUI: false, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "owner", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, modelRegistry: {} } as unknown as ExtensionContext; }

test("record-write-interleavings thread plus slate_change close in one turn refuses close without moving ownership", { timeout: 10000 }, async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "slate-record-close-"))); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tools = new Map<string, any>(), hooks = new Map<string, Function[]>();
  let snapshot: any = { format: "single-action-v1", threads: [], episodes: [], currentChange: createChangeFolder(), changeOwnerSessionId: "owner", orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  const original = snapshot.currentChange;
  createChangeDirectory(cwd, original);
  extension({ registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, on(name: string, hook: Function) { hooks.set(name, [...hooks.get(name) ?? [], hook]); },
    appendEntry(_type: string, data: unknown) { snapshot = structuredClone(data); }, getActiveTools: () => ["read", "thread", "slate_change"], setActiveTools() {}, getAllTools: () => [], getThinkingLevel: () => "off" } as unknown as ExtensionAPI);
  const ctx = { ...context(cwd), sessionManager: { getSessionId: () => "owner", getEntries: () => [], getBranch: () => [{ type: "custom", customType: "slate-state", data: snapshot }] } } as unknown as ExtensionContext;
  for (const hook of hooks.get("session_start") ?? []) await hook({}, ctx);
  const entered = barrier(), release = barrier();
  const dispatch = ThreadManager.prototype.dispatch;
  ThreadManager.prototype.dispatch = async function (opts) {
    const store = (this as unknown as { store: SlateStore }).store;
    const owner = recordOwnership(store), lease = owner.reserve(opts.recordAssignment!);
    try { await lease.call(async () => { entered.resolve(); await release.promise; }); }
    finally { lease.release(); }
    return { thread: { id: "t1", name: "writer", type: "implementer", status: "successful", createdAt: 0, updatedAt: 0 }, episode: { id: "t1.e1", threadId: "t1", task: "write", status: "ok", file: "unused", createdAt: 0 }, episodeText: "done", warnings: [], usage: { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 } };
  };
  t.after(() => { ThreadManager.prototype.dispatch = dispatch; });
  const writer = tools.get("thread").execute("write", { type: "implementer", trackNumber: "2.4", task: "write", model: "fixture", reason: "test" }, undefined, undefined, ctx);
  await entered.promise;
  const closing = tools.get("slate_change").execute("close", { action: "close" }, undefined, undefined, ctx);
  await assert.rejects(closing, /busy with record writers/);
  assert.equal(snapshot.currentChange, original);
  release.resolve(); await writer;
  await tools.get("slate_change").execute("close", { action: "close" }, undefined, undefined, ctx);
  assert.equal(snapshot.currentChange, undefined);
  assert.equal(readFileSync(join(cwd, "slate-changes", original, "research-log.md"), "utf8"), "# Research log\n");
});

test("record-abort-settlement real handoff waits for Pi idle before stopping admission and joining calls", { timeout: 10000 }, async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "slate-record-handoff-"))); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const api = { on() {}, registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
  const store = new SlateStore(api); store.currentChange = createChangeFolder();
  const owner = recordOwnership(store), lease = owner.reserve(buildRecordAssignment({ type: "general", records: ["status.md"] }, store.currentChange, undefined)!);
  const entered = barrier(), release = barrier(), stopping = barrier();
  const originalStop = owner.stop.bind(owner);
  owner.stop = () => { originalStop(); stopping.resolve(); };
  const call = lease.call(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const hooks = registerSlateHandoff(api, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
  let idle = false;
  const transfer = hooks.startHandoff({ ...context(cwd), waitForIdle: async () => { idle = true; }, newSession: async () => {
    assert.throws(() => owner.reserve(lease.assignment), /admission is closed/);
    store.currentChange = createChangeFolder();
    return { cancelled: true };
  } } as any);
  await stopping.promise;
  assert.equal(idle, true);
  const later = lease.call(async () => { throw new Error("Call reached publication during transfer"); });
  release.resolve(); await call;
  await assert.rejects(later, /admission ended/); await transfer;
  assert.equal(idle, true); assert.throws(() => lease.check(), /admission ended/);
  lease.release();
});

for (const action of ["failed", "aborted", "uncertain", "storage-failed", "no-response"]) {
  test(`record-outcome-reporting ${action} action retains every call outside compressor output`, { timeout: 10000 }, async (t) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "slate-record-episode-"))); t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI); store.currentChange = createChangeFolder(); createChangeDirectory(cwd, store.currentChange);
    const manager = new ThreadManager(store, {}, undefined, runtime());
    const abort = new AbortController();
    const assignment = buildRecordAssignment({ type: "implementer", trackNumber: "2.4" }, store.currentChange, undefined)!;
    let callback: Function = () => {};
    const record = assignment.names[0]!;
    (manager as unknown as { openWorkerFor: Function }).openWorkerFor = async ({ recordLease, requestContract }: { recordLease: RecordLease; requestContract: WorkerRequestContract }) => {
      const recordRuntime = createRecordWorkerRuntime(cwd, recordLease, action === "uncertain" ? { fs: {
        ...(await import("node:fs/promises")), unlink: async () => { throw new Error("cleanup fault"); }
      } } : {});
      let tool!: AgentTool;
      recordRuntime.extension({ on() {}, registerTool(definition: any) { tool = definition; } } as unknown as ExtensionAPI);
      const execute = (id: string, args: Record<string, unknown>) => runToolCall({ type: "toolCall", id, name: "slate_record", arguments: args as never },
        { tools: [tool], context: { messages: [], tools: [tool] }, assistantMessage: {} as never }).then((outcome) => ({ ...outcome.result, isError: outcome.isError }));
      const messages: any[] = [];
      const model = { provider: "test", id: "worker" };
      const session = { messages, model, thinkingLevel: "off", setThinkingLevel() {}, resetIncludedOperationFailure() {}, recordCallFacts: recordRuntime.facts,
        subscribe(fn: Function) { callback = fn; return () => {}; }, closeManagedOperations: recordRuntime.close,
        settleManagedOperations: recordRuntime.settle, abort: async () => {}, shutdownWorker: async () => {},
        async prompt() {
          requestContract.accept(model, "off", undefined, () => {});
          for (const name of [record, "status.md"]) {
            const result = await execute(name, { record: name, mode: "create", payload: "private bytes" });
            callback({ type: "tool_execution_end", toolName: "slate_record", result, isError: result.isError });
          }
          const invalid = await execute("invalid", { record, mode: "bogus", payload: "SECRET_REFUSAL_PAYLOAD" });
          assert.equal(invalid.isError, true);
          assert.doesNotMatch(JSON.stringify(invalid), /SECRET_REFUSAL_PAYLOAD|Received arguments/);
          callback({ type: "tool_execution_end", toolName: "slate_record", result: invalid, isError: true });
          if (action === "no-response") throw new Error("failed before a final assistant response");
          const message = { role: "assistant", content: [{ type: "text", text: "Finished record calls." }], stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0 } } };
          messages.push(message); callback({ type: "message_end", message });
          if (action === "aborted") abort.abort();
          if (action === "failed") throw new Error("action failure after calls");
          if (action === "storage-failed") mkdirSync(join(cwd, ".pi", "slate", store.runtimeFolder, "episodes", "t1.e1.md"), { recursive: true });
        },
      } as unknown as WorkerSession;
      (manager as unknown as { live: Map<string, WorkerSession> }).live.set("t1", session);
      return { session };
    };
    const dispatch = () => manager.dispatch({ type: "implementer", task: "two record calls", model: "fixture", reason: "fixture", recordAssignment: assignment }, context(cwd), abort.signal);
    if (action === "storage-failed") {
      await assert.rejects(dispatch(), (error: any) => {
        assert.match(error.message, /could not store episode/);
        assert.equal(parseFacts(error.message).length, 3);
        assert.equal(parseFacts(error.message)[0].observedAfterHash, hash("private bytes"));
        assert.deepEqual(parseFacts(error.message)[2], { record, mode: "invalid", state: "refused before publication", reason: "Record arguments are invalid. Use an assigned record name, create, append or replace, text payload, and a current sha256 hash only for updates." });
        return true;
      });
      await manager.disposeAll(); return;
    }
    const result = await dispatch();
    const facts = result.episodeText.slice(result.episodeText.lastIndexOf("## Record call outcomes"));
    assert.equal(facts.split('"state":').length - 1, 3);
    const parsed = parseFacts(result.episodeText);
    assert.deepEqual(parsed.map(({ record, mode, state, observedBeforeHash, observedAfterHash }) => ({ record, mode, state, observedBeforeHash, observedAfterHash })), [
      { record, mode: "create", state: action === "uncertain" ? "published with uncertain durability" : "published and synced", observedBeforeHash: undefined, observedAfterHash: hash("private bytes") },
      { record: "unassigned", mode: "create", state: "refused before publication", observedBeforeHash: undefined, observedAfterHash: undefined },
      { record, mode: "invalid", state: "refused before publication", observedBeforeHash: undefined, observedAfterHash: undefined },
    ]);
    assert.deepEqual(parseFacts(readFileSync(result.episode.file, "utf8")), parsed);
    assert.doesNotMatch(facts, /SECRET_REFUSAL_PAYLOAD/);
    assert.match(facts, /"record":"track-2.4-implementer-report.md"/);
    assert.match(facts, /"record":"unassigned"/);
    assert.match(facts, /"observedAfterHash":"sha256:/);
    assert.match(facts, /"state":"refused before publication"/);
    assert.match(facts, new RegExp(action === "uncertain" ? "published with uncertain durability" : "published and synced"));
    assert.equal(readFileSync(result.episode.file, "utf8"), result.episodeText);
    assert.equal(readFileSync(join(cwd, assignment.currentFolder, record), "utf8"), "private bytes");
    if (action !== "uncertain") assert.equal(result.episode.status, "failed");
    await manager.disposeAll();
  });
}
