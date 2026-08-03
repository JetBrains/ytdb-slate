import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { ROUTER_OFF, type ModelRouterResolution } from "../extension/model-router.ts";
import { sanitizeMaxConcurrent, SlateStore, type SlateConfig, type SlateSnapshot } from "../extension/state.ts";
import { DispatchAbandoned, ThreadManager } from "../extension/threads.ts";
import { createFakeWorkerSession } from "./fakes.ts";
import {
  EMPTY_WORKER_EXTENSION_SET,
  type WorkerExtensionSet,
} from "../extension/worker-extensions.ts";

interface SemaphoreView {
  acquire(): Promise<void>;
  release(): void;
  abortWaiters(reason: () => Error): void;
}

/** Drain the whole microtask queue, so every dispatch reaches its real wait point. */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Whether `promise` is still pending after the microtask queue has drained. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const observed = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    settleMicrotasks().then(() => marker),
  ]);
  return observed === marker;
}

function threadRecord(id: string) {
  return {
    id, name: id, sessionFile: "", status: "idle" as const, episodeIds: [], episodeSeq: 0,
    createdAt: 1, updatedAt: 1,
  };
}

interface ThreadManagerConstructorFields {
  semaphore: SemaphoreView;
  resolveExtensions: () => WorkerExtensionSet;
  resolveRouter: () => ModelRouterResolution;
  baseModelTracker?: BaseModelTracker;
  startDispatch: (...args: unknown[]) => Promise<unknown>;
  runDispatchInner: (...args: unknown[]) => Promise<unknown>;
  live: Map<string, unknown>;
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

// TQ30: this test injects its failure at the runDispatchInner BOUNDARY, and its
// name says so rather than naming a site it does not reach. It stands in for the
// three real throws that ESCAPE runDispatchInner's own try/catch — the compressor
// call, the sessionFile existsSync, and the closing store.save() — because from
// the caller's side all three are exactly this: a rejection arriving from
// runDispatchInner after the slot was acquired. That is the position I4 is about,
// and it is what the outer cleanup has to cover. Driving those three sites for
// real needs a live worker session, a billed compressor call and episode-file
// writes, i.e. modules A2 does not touch; the real apply-time abort path below is
// driven end to end instead.
test("registry cleanup and semaphore release cover a rejection escaping runDispatchInner", { timeout: 1000 }, async () => {
  const manager = new ThreadManager(realStore(), { maxConcurrent: 1 });
  const fields = constructorFields(manager);
  fields.runDispatchInner = async () => { throw new Error("escaped runDispatchInner"); };

  const dispatch = manager.dispatch({ task: "escape" }, {} as ExtensionContext, undefined);
  assert.deepEqual([...manager.outstanding().keys()], ["d1"]);
  await assert.rejects(dispatch, /escaped runDispatchInner/);
  assert.equal(manager.outstanding().size, 0);
  // A leaked slot makes this hang; the explicit timeout turns that into a failure.
  await fields.semaphore.acquire();
  fields.semaphore.release();
});

// TQ30: the REAL runDispatchInner, end to end, through its one non-billed exit.
// The apply-time route rejection is the terminal path that records no episode and
// never calls the compressor, so it is reachable without a real worker session.
test("a real apply-time route rejection runs the abort tail and leaves nothing behind", { timeout: 1000 }, async () => {
  const store = realStore();
  store.threads.set("t1", threadRecord("t1"));
  const manager = new ThreadManager(store, { maxConcurrent: 1 });
  const fields = constructorFields(manager);
  // A live session, so runDispatchInner reuses it instead of opening a real one.
  fields.live.set("t1", createFakeWorkerSession().session);

  // "The world moved between the two validations": the registry cannot serve the
  // model when dispatch() validates (no profile ⇒ the effort guard stands down),
  // and can by apply time, where `off` is in the profile's apiRejectedLevels and
  // is refused outright. The flip happens in the progress callback, which
  // runDispatchInner emits between the two planRoute calls.
  let serves = false;
  const ctx = {
    model: undefined,
    isProjectTrusted: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => (serves ? { provider, id, contextWindow: 200_000 } : undefined),
      hasConfiguredAuth: () => true,
    },
  } as unknown as ExtensionContext;

  let progressEvents = 0;
  const dispatch = manager.dispatch(
    { threadId: "t1", task: "abort", model: "anthropic/claude-sonnet-5", effort: "off" },
    ctx,
    undefined,
    () => { progressEvents++; serves = true; },
  );
  await assert.rejects(dispatch, /aborting the dispatch to thread t1 before any billed work/);

  assert.ok(progressEvents > 0, "runDispatchInner must have reached its first progress emit");
  // The abort tail ran: "running" would mean it did not.
  assert.equal(store.threads.get("t1")?.status, "idle");
  assert.equal(store.episodes.size, 0);
  assert.equal(store.threads.get("t1")?.episodeIds.length, 0);
  assert.equal(manager.outstanding().size, 0);
  await fields.semaphore.acquire();
  fields.semaphore.release();
});

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

// ---------------------------------------------------------------------------
// BG28 — every registry edge is pinned below. Deleting any one transition, or
// handing out the live map, must fail a test here rather than pass 25/25 green.
// ---------------------------------------------------------------------------

test("a fulfilled dispatch moves pending → settled, and outstanding() is a snapshot", { timeout: 1000 }, async () => {
  const { manager, fields } = registryHarness();
  fields.startDispatch = async () => ({ episode: { status: "ok" } });

  const dispatch = manager.dispatch({ task: "ok" }, {} as ExtensionContext, undefined);
  const snapshot = manager.outstanding();
  const entry = snapshot.get("d1");
  assert.equal(entry?.state, "pending");
  assert.notStrictEqual(manager.outstanding(), manager.outstanding());

  await dispatch;
  assert.equal(entry?.state, "settled");
  assert.equal(manager.outstanding().size, 0);
  // A live map would have shrunk to 0 under the caller's feet.
  assert.equal(snapshot.size, 1);
});

test("a rejected dispatch also moves pending → settled", { timeout: 1000 }, async () => {
  const { manager, fields } = registryHarness();
  fields.startDispatch = async () => { throw new Error("failed action"); };

  const dispatch = manager.dispatch({ task: "fail" }, {} as ExtensionContext, undefined);
  const entry = manager.outstanding().get("d1");
  await assert.rejects(dispatch, /failed action/);
  assert.equal(entry?.state, "settled");
});

test("join moves a settled entry to joined and reports the real outcome", { timeout: 1000 }, async () => {
  const { manager, fields } = registryHarness(8);
  let finish!: (value: unknown) => void;
  fields.startDispatch = () => new Promise((resolve) => { finish = resolve; });

  const dispatch = manager.dispatch({ task: "pending" }, {} as ExtensionContext, undefined);
  const entry = manager.outstanding().get("d9");
  assert.equal(entry?.state, "pending");

  const joined = manager.join();
  assert.equal(await isPending(joined), true, "a join must not resolve while its work runs");
  finish({ episode: { status: "ok" } });

  const results = await joined;
  assert.deepEqual(results, [{ ticket: "d9", result: { status: "fulfilled", value: { episode: { status: "ok" } } } }]);
  assert.equal(results[0]?.abandoned, undefined);
  assert.equal(entry?.state, "joined");
  assert.deepEqual(await dispatch, { episode: { status: "ok" } });
});

test("join reports a rejected dispatch as rejected, and still joins it", { timeout: 1000 }, async () => {
  const { manager, fields } = registryHarness();
  let fail!: (error: unknown) => void;
  fields.startDispatch = () => new Promise((_resolve, reject) => { fail = reject; });

  const dispatch = manager.dispatch({ task: "pending" }, {} as ExtensionContext, undefined);
  const entry = manager.outstanding().get("d1");
  const joined = manager.join();
  await settleMicrotasks(); // startDispatch runs one microtask after registration
  fail(new Error("action failed"));

  const results = await joined;
  assert.equal(results[0]?.result.status, "rejected");
  assert.equal(results[0]?.abandoned, undefined);
  assert.equal(entry?.state, "joined");
  await assert.rejects(dispatch, /action failed/);
});

// ---------------------------------------------------------------------------
// CN45 — the join always resolves, and abandoning wakes what was waiting.
// ---------------------------------------------------------------------------

test("clear resolves a join over unsettled work without cancelling the work", { timeout: 1000 }, async () => {
  const { manager, fields } = registryHarness(8);
  let finish!: (value: unknown) => void;
  fields.startDispatch = () => new Promise((resolve) => { finish = resolve; });

  const dispatch = manager.dispatch({ task: "pending" }, {} as ExtensionContext, undefined);
  const entry = manager.outstanding().get("d9");
  const joined = manager.join();
  manager.clear();

  assert.equal(entry?.state, "abandoned");
  assert.equal(manager.outstanding().size, 0);
  const results = await joined; // must resolve on the abandonment alone
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ticket, "d9");
  assert.equal(results[0]?.abandoned, true);
  assert.equal(results[0]?.result.status, "rejected");
  assert.ok(
    results[0]?.result.status === "rejected" && results[0].result.reason instanceof DispatchAbandoned,
    "an abandoned entry reports DispatchAbandoned, not a worker failure",
  );
  // Work already in flight is NOT cancelled, and its late settlement neither
  // throws an illegal transition nor rewrites the abandoned state.
  finish({ episode: { status: "ok" } });
  assert.deepEqual(await dispatch, { episode: { status: "ok" } });
  assert.equal(entry?.state, "abandoned");
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

// The reviewer's own probe (CN45): one hung dispatch holding the only slot, two
// siblings queued on the semaphore. Before the fix the join stayed pending 400ms
// after disposeAll() returned with an empty registry — which, once the join is
// wired into agent_end, hangs the turn, Esc, a model switch, a fork and quit.
test("a hung dispatch cannot hang the join, and queued siblings are woken", { timeout: 2000 }, async () => {
  const store = realStore();
  for (const id of ["t1", "t2", "t3"]) store.threads.set(id, threadRecord(id));
  const manager = new ThreadManager(store, { maxConcurrent: 1 });
  const fields = constructorFields(manager);
  let started = 0;
  fields.runDispatchInner = () => {
    started++;
    return new Promise(() => {}); // a worker that never answers
  };
  const ctx = {} as ExtensionContext;

  const hung = manager.dispatch({ threadId: "t1", task: "hung" }, ctx, undefined);
  const queuedA = manager.dispatch({ threadId: "t2", task: "queued a" }, ctx, undefined);
  const queuedB = manager.dispatch({ threadId: "t3", task: "queued b" }, ctx, undefined);
  await settleMicrotasks();
  assert.equal(manager.outstanding().size, 3);
  assert.equal(started, 1, "only the slot holder may have started");

  const joined = manager.join();
  assert.equal(await isPending(joined), true);
  manager.disposeAll();

  const results = await joined; // the whole point: this resolves
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.ticket), ["d1", "d2", "d3"]);
  assert.ok(results.every((r) => r.abandoned === true));
  assert.ok(
    results.every((r) => r.result.status === "rejected" && r.result.reason instanceof DispatchAbandoned),
  );

  // The two that never got a slot end as rejected promises rather than pending ones.
  await assert.rejects(queuedA, DispatchAbandoned);
  await assert.rejects(queuedB, DispatchAbandoned);
  assert.equal(started, 1, "a woken waiter must not start billed work");
  // The hung one still holds its slot: nothing can settle work that never answers.
  assert.equal(await isPending(hung), true);

  // Slot accounting survived the wake: exactly the one slot the hung dispatch
  // holds is missing, and the limit still binds afterwards.
  fields.semaphore.release();
  await fields.semaphore.acquire();
  let extra = false;
  const overflow = fields.semaphore.acquire().then(() => { extra = true; });
  await settleMicrotasks();
  assert.equal(extra, false, "abortWaiters must not inflate the slot count");
  fields.semaphore.release();
  await overflow;
  fields.semaphore.release();
});

test("a same-thread successor queued behind a hung predecessor is woken by clear", { timeout: 2000 }, async () => {
  const store = realStore();
  store.threads.set("t1", threadRecord("t1"));
  const manager = new ThreadManager(store, { maxConcurrent: 4 });
  const fields = constructorFields(manager);
  let started = 0;
  fields.runDispatchInner = () => {
    started++;
    return new Promise(() => {});
  };
  const ctx = {} as ExtensionContext;

  const hung = manager.dispatch({ threadId: "t1", task: "hung" }, ctx, undefined);
  const successor = manager.dispatch({ threadId: "t1", task: "successor" }, ctx, undefined);
  await settleMicrotasks();
  // The successor waits on the per-thread FIFO chain, not on the semaphore.
  assert.equal(started, 1);

  const joined = manager.join();
  manager.clear();
  await assert.rejects(successor, DispatchAbandoned);
  assert.equal(started, 1, "an abandoned successor must never start its action");
  assert.equal((await joined).length, 2);
  assert.equal(await isPending(hung), true);
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
