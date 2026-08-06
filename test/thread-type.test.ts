import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveThreadType, sanitizeThreadRecord, SlateStore, THREAD_TYPES, type ThreadRecord, type ThreadType } from "../extension/state.ts";
import { ThreadManager, type DispatchOptions } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";

interface ManagerInternals {
  live: Map<string, unknown>;
  runDispatchInner: (...args: unknown[]) => Promise<unknown>;
  openWorkerFor: (...args: unknown[]) => Promise<unknown>;
  createThread(opts: DispatchOptions, plan: unknown): ThreadRecord;
  setExistingThreadType(thread: ThreadRecord, requested: ThreadType | undefined): void;
  runDispatch: (...args: unknown[]) => Promise<unknown>;
}

function internals(manager: ThreadManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function record(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "t1",
    name: "legacy",
    sessionFile: "",
    status: "idle",
    episodeIds: [],
    episodeSeq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function storeHarness(): { store: SlateStore; snapshots: Record<string, unknown>[] } {
  const snapshots: Record<string, unknown>[] = [];
  const pi = {
    appendEntry(_customType: string, data: Record<string, unknown>) {
      snapshots.push(data);
    },
  } as unknown as ExtensionAPI;
  return { store: new SlateStore(pi), snapshots };
}

interface RegisteredThreadTool {
  description: string;
  parameters: {
    properties: {
      type: { description: string };
    };
  };
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

function registeredThreadTool(): { tool: RegisteredThreadTool; calls: DispatchOptions[] } {
  let registered: unknown;
  const pi = {
    registerTool(tool: unknown) {
      const candidate = tool as { name?: string };
      if (candidate.name === "thread") registered = tool;
    },
  } as unknown as ExtensionAPI;
  const calls: DispatchOptions[] = [];
  const manager = {
    async dispatch(opts: DispatchOptions) {
      calls.push(opts);
      const thread = record({ type: opts.type });
      return {
        thread,
        episode: { id: "t1.e1", threadId: "t1", task: opts.task, status: "ok", file: "/tmp/e", createdAt: 1 },
        episodeText: "episode",
        warnings: [],
        usage: { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 },
      };
    },
  } as unknown as ThreadManager;
  registerSlateTools(pi, storeHarness().store, () => manager);
  assert.ok(registered);
  return { tool: registered as RegisteredThreadTool, calls };
}

const ctx = {} as ExtensionContext;

test("thread tool enforces the creation type and publishes the closed vocabulary", async () => {
  const { tool, calls } = registeredThreadTool();
  const allowed = "researcher, reviewer, adversarial, implementer, general";
  assert.match(tool.description, /See the `type` parameter for the thread-type choices and their meanings\./);
  assert.doesNotMatch(tool.description, /researcher, reviewer, adversarial, implementer/);
  assert.equal(
    tool.parameters.properties.type.description,
    "Required for a new thread and immutable after creation. Pick by main job: researcher investigates, reviewer judges work, adversarial seeks counterexamples, implementer makes the change, general is anything else. Slate adds its reviewer evidence charter to reviewer and adversarial threads.",
  );
  const descriptionBytes = Buffer.byteLength(tool.description, "utf8");
  const parameterSchemaBytes = Buffer.byteLength(JSON.stringify(tool.parameters), "utf8");
  assert.equal(descriptionBytes, 1_386, "thread description byte budget changed; update docs/context-budget.md in the same commit");
  assert.equal(parameterSchemaBytes, 1_791, "thread parameter schema byte budget changed; update docs/context-budget.md in the same commit");
  assert.equal(
    descriptionBytes + parameterSchemaBytes,
    3_177,
    "thread combined byte budget changed; update docs/context-budget.md in the same commit",
  );

  await assert.rejects(
    tool.execute("missing", { task: "x" }, undefined, undefined, ctx),
    new RegExp(`type is required.*Allowed values: ${allowed}`, "i"),
  );
  await assert.rejects(
    tool.execute("invalid", { task: "x", type: "observer" }, undefined, undefined, ctx),
    new RegExp(`Invalid thread type.*Allowed values: ${allowed}`, "i"),
  );

  for (const type of THREAD_TYPES) {
    await tool.execute(type, { task: `create ${type}`, type }, undefined, undefined, ctx);
  }
  await tool.execute("continue", { thread: "t1", task: "continue without a type" }, undefined, undefined, ctx);
  assert.deepEqual(calls.map((call) => call.type), [...THREAD_TYPES, undefined]);
});

test("new records persist every valid type", () => {
  const { store } = storeHarness();
  const manager = new ThreadManager(store, {});
  const view = internals(manager);

  for (const type of THREAD_TYPES) {
    const created = view.createThread({ task: "x", type }, {});
    assert.equal(created.type, type);
    assert.equal(store.threads.get(created.id)?.type, type);
  }
});

test("an existing type is immutable, while a matching value is silently ignored", () => {
  const { store, snapshots } = storeHarness();
  const manager = new ThreadManager(store, {});
  const view = internals(manager);
  const existing = record({ type: "reviewer" });
  store.threads.set(existing.id, existing);

  view.setExistingThreadType(existing, "reviewer");
  assert.equal(snapshots.length, 0);
  assert.throws(
    () => view.setExistingThreadType(existing, "implementer"),
    /immutable type "reviewer".*cannot be changed to "implementer"/,
  );
  assert.equal(existing.type, "reviewer");
  assert.equal(snapshots.length, 0);
});

test("public dispatch rejects a conflicting type before worker work or state changes", { timeout: 1000 }, async () => {
  const { store, snapshots } = storeHarness();
  const existing = record({ type: "reviewer" });
  store.threads.set(existing.id, existing);
  store.workerCostUsd = 4.5;
  const before = structuredClone(existing);
  const manager = new ThreadManager(store, {});
  let opens = 0;
  internals(manager).openWorkerFor = async () => {
    opens++;
    throw new Error("worker must not open");
  };

  await assert.rejects(
    manager.dispatch(
      { threadId: existing.id, task: "conflict", type: "implementer" },
      {} as ExtensionContext,
      undefined,
    ),
    /immutable type "reviewer"\. It cannot be changed to "implementer"/,
  );
  assert.equal(opens, 0);
  assert.deepEqual(existing, before);
  assert.equal(store.workerCostUsd, 4.5);
  assert.equal(store.episodes.size, 0);
  assert.equal(snapshots.length, 0);
});

test("dispatch passes route warnings from worker opening to the episode result", { timeout: 1000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-route-warning-test."));
  try {
    const { store } = storeHarness();
    const manager = new ThreadManager(store, {});
    const view = internals(manager);
    view.openWorkerFor = async (args: unknown) => {
      const report = (args as { report: (message: string) => void }).report;
      report("worker opening warning");
      throw new Error("worker opening failed");
    };
    const thread = record({ id: "t1", type: "researcher" });
    const result = await view.runDispatchInner(
      thread,
      { task: "x", type: "researcher" },
      "x",
      "t1.e1",
      { cwd: root } as ExtensionContext,
      undefined,
    ) as { warnings: string[] };
    assert.deepEqual(result.warnings, ["worker opening warning"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch creates and persists a typed thread before running it", async () => {
  const { store } = storeHarness();
  const manager = new ThreadManager(store, {});
  const view = internals(manager);
  view.runDispatch = async (thread: unknown) => thread;

  const result = await manager.dispatch(
    { name: "fresh", task: "x", type: "researcher" },
    {} as ExtensionContext,
    undefined,
  ) as unknown as ThreadRecord;
  assert.equal(result.name, "fresh");
  assert.equal(result.type, "researcher");
  assert.strictEqual(store.threads.get(result.id), result);
});

test("dispatch applies a one-time type to an existing thread after argument planning", async () => {
  const { store } = storeHarness();
  const existing = record();
  store.threads.set(existing.id, existing);
  const manager = new ThreadManager(store, {});
  const view = internals(manager);
  view.runDispatch = async () => ({ marker: "dispatched" });

  const result = await manager.dispatch(
    { threadId: existing.id, task: "x", type: "reviewer" },
    {} as ExtensionContext,
    undefined,
  );
  assert.deepEqual(result, { marker: "dispatched" });
  assert.equal(existing.type, "reviewer");
});

test("a legacy thread can be typed once unless its worker session is live", () => {
  const { store, snapshots } = storeHarness();
  const manager = new ThreadManager(store, {});
  const view = internals(manager);
  const legacy = record();
  store.threads.set(legacy.id, legacy);

  view.setExistingThreadType(legacy, "researcher");
  assert.equal(legacy.type, "researcher");
  assert.equal(snapshots.length, 1);
  assert.equal((snapshots[0]?.threads as ThreadRecord[])[0]?.type, "researcher");

  const liveLegacy = record({ id: "t2" });
  store.threads.set(liveLegacy.id, liveLegacy);
  view.live.set(liveLegacy.id, {});
  assert.throws(
    () => view.setExistingThreadType(liveLegacy, "general"),
    /live worker session.*cannot be set safely.*Dispose or restart the Slate session/,
  );
  assert.equal(liveLegacy.type, undefined);
  assert.equal(snapshots.length, 1);
});

test("a restored unrecognised type accepts one valid correction", () => {
  const repairs: string[] = [];
  const adopted = sanitizeThreadRecord({ ...record(), type: "future-role" }, repairs);
  assert.ok(adopted);
  assert.equal(adopted.type, "future-role");
  assert.deepEqual(repairs, []);

  const { store, snapshots } = storeHarness();
  store.threads.set(adopted.id, adopted);
  const view = internals(new ThreadManager(store, {}));
  view.setExistingThreadType(adopted, "implementer");
  assert.equal(adopted.type, "implementer");
  assert.equal(snapshots.length, 1);

  assert.throws(
    () => view.setExistingThreadType(adopted, "reviewer"),
    /immutable type "implementer".*cannot be changed to "reviewer"/,
  );
});

test("an absent type survives save and restore without materialising a default", () => {
  const first = storeHarness();
  first.store.threads.set("t1", record());
  first.store.save();
  const snapshot = first.snapshots.at(-1);
  assert.ok(snapshot);
  assert.equal((snapshot.threads as ThreadRecord[])[0]?.type, undefined);
  assert.equal(Object.hasOwn((snapshot.threads as ThreadRecord[])[0] ?? {}, "type"), false);

  const restored = storeHarness().store;
  const context = {
    hasUI: false,
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "slate-state", data: snapshot }],
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
  restored.restore(context);
  const adopted = restored.threads.get("t1");
  assert.ok(adopted);
  assert.equal(adopted.type, undefined);
  assert.equal(Object.hasOwn(adopted, "type"), false);
});

test("restore drops a non-string type with a visible repair note", () => {
  const repairs: string[] = [];
  const adopted = sanitizeThreadRecord({ ...record(), type: 7 }, repairs);
  assert.equal(adopted?.type, undefined);
  assert.deepEqual(repairs, ["thread t1: ignoring type (number)"]);
});

test("an unrecognised restored string survives and reads as general with one report", () => {
  const repairs: string[] = [];
  const adopted = sanitizeThreadRecord({ ...record(), type: "future-role" }, repairs);
  assert.ok(adopted);
  assert.equal(adopted.type, "future-role");
  assert.deepEqual(repairs, []);

  const reports: string[] = [];
  assert.equal(effectiveThreadType(adopted, (message) => reports.push(message)), "general");
  assert.equal(effectiveThreadType(adopted, (message) => reports.push(message)), "general");
  assert.deepEqual(reports, ["slate: thread t1 has unrecognised type future-role. Slate is treating it as general."]);

  const absent = record();
  assert.equal(effectiveThreadType(absent, (message) => reports.push(message)), "general");
  assert.equal(reports.length, 1);
});
