import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { ROUTER_OFF, type ModelRouterResolution } from "../extension/model-router.ts";
import { sanitizeMaxConcurrent, SlateStore, type SlateConfig, type SlateSnapshot } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";
import {
  EMPTY_WORKER_EXTENSION_SET,
  type WorkerExtensionSet,
} from "../extension/worker-extensions.ts";

interface SemaphoreView {
  acquire(): Promise<void>;
  release(): void;
}

interface ThreadManagerConstructorFields {
  semaphore: SemaphoreView;
  resolveExtensions: () => WorkerExtensionSet;
  resolveRouter: () => ModelRouterResolution;
  baseModelTracker?: BaseModelTracker;
  startDispatch: (...args: unknown[]) => Promise<unknown>;
  runDispatchInner: (...args: unknown[]) => Promise<unknown>;
}

function constructorFields(manager: ThreadManager): ThreadManagerConstructorFields {
  return manager as unknown as ThreadManagerConstructorFields;
}

test("ThreadManager preserves explicit constructor arguments and resolver defaults", async () => {
  const store = { paused: true, dispatchSeq: 0, save() {} } as unknown as SlateStore;
  const config: SlateConfig = { maxConcurrent: 2, workerTools: ["distinguishable-config"] };
  const extensions = {
    units: [],
    paths: ["/distinguishable/extensions"],
    toolNames: ["distinguishable-extension"],
  } satisfies WorkerExtensionSet;
  const router = { enabled: true, candidates: [] } as unknown as ModelRouterResolution;
  const extensionResolver = () => extensions;
  const routerResolver = () => router;
  const baseModelTracker = { get: () => ({ model: "provider/distinguishable" }) } as unknown as BaseModelTracker;

  const manager = new ThreadManager(
    store,
    config,
    extensionResolver,
    routerResolver,
    baseModelTracker,
  );
  const fields = constructorFields(manager);

  assert.strictEqual(manager.getConfig(), config);
  await assert.rejects(
    manager.dispatch(
      { task: "must stop at the injected paused store" },
      {} as ExtensionContext,
      undefined,
    ),
    /Slate is paused for handoff/,
  );
  assert.strictEqual(fields.resolveExtensions(), extensions);
  assert.strictEqual(fields.resolveRouter(), router);
  assert.strictEqual(fields.baseModelTracker, baseModelTracker);

  const defaults = constructorFields(new ThreadManager(store, config));
  assert.strictEqual(defaults.resolveExtensions(), EMPTY_WORKER_EXTENSION_SET);
  assert.strictEqual(defaults.resolveRouter(), ROUTER_OFF);
});

// A missed wakeup must fail this test instead of hanging the test process. Keep
// an explicit timeout on every waiter-based test that follows this pattern.
test("ThreadManager's semaphore honours configured and default limits and returns capacity", { timeout: 1000 }, async () => {
  const configured = constructorFields(new ThreadManager(
    { paused: false } as unknown as SlateStore,
    { maxConcurrent: 3 },
  )).semaphore;
  const configuredHolders = [configured.acquire(), configured.acquire(), configured.acquire()];
  await Promise.all(configuredHolders);
  let configuredWaiterAdmitted = false;
  const configuredWaiter = configured.acquire().then(() => {
    configuredWaiterAdmitted = true;
  });

  await Promise.resolve();
  assert.equal(configuredWaiterAdmitted, false);
  configured.release();
  await configuredWaiter;
  assert.equal(configuredWaiterAdmitted, true);

  // All three releases take the no-waiter branch. Capacity must return: deleting
  // its active-count decrement makes the following acquisitions time out.
  configured.release();
  configured.release();
  configured.release();
  const reacquired = [configured.acquire(), configured.acquire(), configured.acquire()];
  await Promise.all(reacquired);
  configured.release();
  configured.release();
  configured.release();

  const defaulted = constructorFields(new ThreadManager(
    { paused: false } as unknown as SlateStore,
    {},
  )).semaphore;
  const defaultHolders = [
    defaulted.acquire(),
    defaulted.acquire(),
    defaulted.acquire(),
    defaulted.acquire(),
  ];
  await Promise.all(defaultHolders);
  let defaultWaiterAdmitted = false;
  const defaultWaiter = defaulted.acquire().then(() => {
    defaultWaiterAdmitted = true;
  });

  await Promise.resolve();
  assert.equal(defaultWaiterAdmitted, false);
  defaulted.release();
  await defaultWaiter;
  assert.equal(defaultWaiterAdmitted, true);

  defaulted.release();
  defaulted.release();
  defaulted.release();
  defaulted.release();
});

test("SlateStore saves through the ExtensionAPI supplied to its constructor", () => {
  const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const pi = {
    appendEntry(customType: string, data: Record<string, unknown>) {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);

  store.paused = true;
  store.workerCostUsd = 1.25;
  store.save();

  assert.deepEqual(appended, [
    {
      customType: "slate-state",
      data: {
        threads: [],
        episodes: [],
        orchestratorMode: false,
        paused: true,
        dispatchSeq: 0,
        workerCostUsd: 1.25,
        carriedCostUsd: 0,
      },
    },
  ]);
});

function registryHarness(sequence = 0) {
  const store = {
    paused: false,
    dispatchSeq: sequence,
    save() {},
  } as unknown as SlateStore;
  const manager = new ThreadManager(store, { maxConcurrent: 1 });
  return { store, manager, fields: constructorFields(manager) };
}

function realStore(paused = false) {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.paused = paused;
  return store;
}

for (const terminal of ["DispatchAbort", "worker-open collision", "compressEpisode throw", "existsSync throw"] as const) {
  test(`dispatch registry deregisters and real semaphore capacity returns after ${terminal}`, { timeout: 1000 }, async () => {
    const manager = new ThreadManager(realStore(), { maxConcurrent: 1 });
    const fields = constructorFields(manager);
    // These terminal failures originate at different sites below runDispatch's
    // semaphore acquisition. Throwing at its inner boundary exercises the real
    // release finally and the registry's still-outer cleanup finally.
    fields.runDispatchInner = async () => { throw new Error(terminal); };

    const dispatch = manager.dispatch({ task: terminal }, {} as ExtensionContext, undefined);
    assert.deepEqual([...manager.outstanding().keys()], ["d1"]);
    await assert.rejects(dispatch, new RegExp(terminal));
    assert.equal(manager.outstanding().size, 0);
    await fields.semaphore.acquire();
    fields.semaphore.release();
  });
}

test("pre-semaphore terminal paths all deregister", { timeout: 1000 }, async () => {
  const cases: Array<{ name: string; manager: ThreadManager; options: Parameters<ThreadManager["dispatch"]>[0]; pattern: RegExp }> = [];

  cases.push({
    name: "paused",
    manager: new ThreadManager(realStore(true), {}),
    options: { task: "paused" },
    pattern: /Slate is paused/,
  });
  cases.push({
    name: "unknown thread",
    manager: new ThreadManager(realStore(), {}),
    options: { threadId: "missing", task: "unknown" },
    pattern: /Unknown thread/,
  });
  cases.push({
    name: "early route rejection",
    manager: new ThreadManager(realStore(), {}),
    options: { task: "route", effort: 42 as unknown as string },
    pattern: /effort.*string/i,
  });
  const promptStore = realStore();
  promptStore.threads.set("t1", {
    id: "t1", name: "one", sessionFile: "", status: "idle", episodeIds: [], episodeSeq: 0,
    createdAt: 1, updatedAt: 1,
  });
  cases.push({
    name: "buildPrompt throw",
    manager: new ThreadManager(promptStore, {}),
    options: { threadId: "t1", task: "prompt", contextEpisodeIds: ["missing-episode"] },
    pattern: /Unknown episode/,
  });

  for (const item of cases) {
    const dispatch = item.manager.dispatch(item.options, {} as ExtensionContext, undefined);
    assert.equal(item.manager.outstanding().size, 1, item.name);
    await assert.rejects(dispatch, item.pattern, item.name);
    assert.equal(item.manager.outstanding().size, 0, item.name);
  }
});

test("ticket-persistence store.save failure deregisters before dispatch setup", async () => {
  const store = { paused: false, dispatchSeq: 0, save() { throw new Error("stale store.save"); } } as unknown as SlateStore;
  const manager = new ThreadManager(store, {});
  const dispatch = manager.dispatch({ task: "save" }, {} as ExtensionContext, undefined);
  assert.equal(manager.outstanding().size, 1);
  await assert.rejects(dispatch, /stale store\.save/);
  assert.equal(manager.outstanding().size, 0);
});

test("dispatch attaches its rejection observer in the registration tick", { timeout: 1000 }, async () => {
  const { manager, fields } = registryHarness();
  fields.startDispatch = async () => { throw new Error("same-tick rejection"); };
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const dispatch = manager.dispatch({ task: "reject" }, {} as ExtensionContext, undefined);
    assert.equal(manager.outstanding().size, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, []);
    await assert.rejects(dispatch, /same-tick rejection/);
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.equal(manager.outstanding().size, 0);
});

test("join snapshots pending work and clear abandons without changing its outcome", { timeout: 1000 }, async () => {
  const { manager, fields } = registryHarness(8);
  let finish!: (value: unknown) => void;
  fields.startDispatch = () => new Promise((resolve) => { finish = resolve; });

  const dispatch = manager.dispatch({ task: "pending" }, {} as ExtensionContext, undefined);
  const entry = manager.outstanding().get("d9");
  assert.equal(entry?.state, "pending");
  const joined = manager.join();
  manager.clear();
  assert.equal(entry?.state, "abandoned");
  assert.equal(manager.outstanding().size, 0);
  await Promise.resolve();
  finish({ episode: { status: "ok" } });

  assert.deepEqual(await dispatch, { episode: { status: "ok" } });
  assert.deepEqual(await joined, [{ ticket: "d9", result: { status: "fulfilled", value: { episode: { status: "ok" } } } }]);
});

test("disposeAll abandons an unsettled registry without waiting", { timeout: 1000 }, async () => {
  const { manager, fields } = registryHarness();
  let finish!: (value: unknown) => void;
  fields.startDispatch = () => new Promise((resolve) => { finish = resolve; });
  const dispatch = manager.dispatch({ task: "pending" }, {} as ExtensionContext, undefined);
  const entry = manager.outstanding().get("d1");

  manager.disposeAll();
  assert.equal(manager.outstanding().size, 0);
  assert.equal(entry?.state, "abandoned");
  await Promise.resolve();
  finish({ episode: { status: "ok" } });
  await dispatch;
});

test("dispatch ticket high-water mark survives branch restore and rejects malformed snapshots", () => {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const oldSnapshot: SlateSnapshot = {
    threads: [], episodes: [], orchestratorMode: false, paused: false,
    dispatchSeq: 7, workerCostUsd: 0, carriedCostUsd: 0,
  };
  const newerBranch = { ...oldSnapshot, dispatchSeq: 41 };
  const ctx = {
    hasUI: false,
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "slate-state", data: oldSnapshot }],
      getEntries: () => [
        { type: "custom", customType: "slate-state", data: oldSnapshot },
        { type: "custom", customType: "slate-state", data: newerBranch },
      ],
    },
  } as unknown as ExtensionContext;

  store.restore(ctx);
  assert.equal(store.dispatchSeq, 41);
  assert.equal(store.snapshot().dispatchSeq, 41);
  assert.throws(
    () => store.adoptSnapshot({ ...oldSnapshot, dispatchSeq: -1 }, ctx),
    /dispatchSeq must be a non-negative safe integer/,
  );
});

test("maxConcurrent sanitizer clamps non-positive numbers and drops invalid values", async () => {
  const warnings: string[] = [];
  assert.equal(sanitizeMaxConcurrent(0, (message) => warnings.push(message)), 1);
  assert.equal(sanitizeMaxConcurrent(-4, (message) => warnings.push(message)), 1);
  assert.equal(sanitizeMaxConcurrent(Number.NaN, (message) => warnings.push(message)), undefined);
  assert.equal(sanitizeMaxConcurrent("2", (message) => warnings.push(message)), undefined);
  assert.equal(sanitizeMaxConcurrent(3, (message) => warnings.push(message)), 3);
  assert.equal(sanitizeMaxConcurrent(undefined, (message) => warnings.push(message)), undefined);
  assert.equal(warnings.length, 4);

  // Constructor floor is independent of session_start sanitization.
  for (const limit of [0, -1, Number.NaN]) {
    const semaphore = constructorFields(new ThreadManager(
      { paused: false } as unknown as SlateStore,
      { maxConcurrent: limit },
    )).semaphore;
    await semaphore.acquire();
    let admitted = false;
    const waiter = semaphore.acquire().then(() => { admitted = true; });
    await Promise.resolve();
    assert.equal(admitted, false);
    semaphore.release();
    await waiter;
    semaphore.release();
  }
});
