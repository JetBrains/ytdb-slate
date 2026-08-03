import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { ROUTER_OFF, type ModelRouterResolution } from "../extension/model-router.ts";
import { sanitizeMaxConcurrent, SlateStore, type SlateConfig, type SlateSnapshot } from "../extension/state.ts";
import { DispatchAbandoned, DispatchAbandonedInFlight, ThreadManager } from "../extension/threads.ts";
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
  assert.deepEqual(results, [
    { ticket: "d9", outcome: "settled", result: { status: "fulfilled", value: { episode: { status: "ok" } } } },
  ]);
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
  assert.equal(results[0]?.outcome, "settled", "a failed action is settled, never abandoned");
  assert.equal(entry?.state, "joined");
  await assert.rejects(dispatch, /action failed/);
});

// ---------------------------------------------------------------------------
// CN45 — the join always resolves, and abandoning wakes what was waiting.
// ---------------------------------------------------------------------------

test("clear resolves a join over never-started work without cancelling the work", { timeout: 1000 }, async () => {
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
  // startDispatch is stubbed, so nothing ever reached a concurrency slot.
  assert.equal(results[0]?.outcome, "abandoned-before-start");
  assert.equal(results[0]?.result.status, "rejected");
  assert.ok(
    results[0]?.result.status === "rejected" && results[0].result.reason instanceof DispatchAbandoned,
    "an abandoned entry reports DispatchAbandoned, not a worker failure",
  );
  // Work already under way is NOT cancelled, and its late settlement neither
  // throws an illegal transition nor rewrites the abandoned state.
  finish({ episode: { status: "ok" } });
  assert.deepEqual(await dispatch, { episode: { status: "ok" } });
  assert.equal(entry?.state, "abandoned");
});

// ---------------------------------------------------------------------------
// BG29 — the join reports by STATE, not by which promise reaction won a race.
// Abandonment resolves in about one microtask and settlement takes six or more,
// so a timing-based decision reported finished, billed work as "nothing ran".
// ---------------------------------------------------------------------------

// These two drive the dispatch through the REAL runDispatch (only the worker
// call itself is stubbed), because that is where the completion is recorded. A
// harness that replaces startDispatch cannot reach the completion site and so
// cannot pose this question at all: it produces work that finished without ever
// having started, which no real dispatch can do.
test("work that already succeeded is never reported as abandoned, even if clear follows", { timeout: 1000 }, async () => {
  const store = realStore();
  store.threads.set("t1", threadRecord("t1"));
  const manager = new ThreadManager(store, { maxConcurrent: 2 });
  const fields = constructorFields(manager);
  let finish!: (value: unknown) => void;
  fields.runDispatchInner = () => new Promise((resolve) => { finish = resolve; });

  const dispatch = manager.dispatch({ threadId: "t1", task: "succeeds" }, {} as ExtensionContext, undefined);
  const entry = manager.outstanding().get("d1");
  const joined = manager.join();
  await settleMicrotasks();

  // The action finishes, and the registry is torn down in the very same tick,
  // before the result has propagated out through the promise chain. The timing
  // race let the teardown win and reported "Nothing ran and no episode was
  // recorded" about work that had just succeeded.
  finish({ episode: { status: "ok" } });
  manager.clear();

  const results = await joined;
  assert.equal(results[0]?.outcome, "settled");
  assert.deepEqual(results[0]?.result, { status: "fulfilled", value: { episode: { status: "ok" } } });
  await dispatch;
  // The mechanism, not just its effect: the real outcome is RECORDED on the entry,
  // which is the fact the decision reads instead of racing promises.
  const recorded = entry as unknown as { settled?: PromiseSettledResult<unknown> };
  assert.deepEqual(recorded.settled, { status: "fulfilled", value: { episode: { status: "ok" } } });
});

test("work that already failed is reported as its own failure, not as abandonment", { timeout: 1000 }, async () => {
  const store = realStore();
  store.threads.set("t1", threadRecord("t1"));
  const manager = new ThreadManager(store, { maxConcurrent: 2 });
  const fields = constructorFields(manager);
  let fail!: (error: unknown) => void;
  fields.runDispatchInner = () => new Promise((_resolve, reject) => { fail = reject; });

  const dispatch = manager.dispatch({ threadId: "t1", task: "fails" }, {} as ExtensionContext, undefined);
  const joined = manager.join();
  await settleMicrotasks();
  fail(new Error("the action itself failed"));
  manager.clear();

  const results = await joined;
  assert.equal(results[0]?.outcome, "settled");
  assert.ok(
    results[0]?.result.status === "rejected" && /the action itself failed/.test(String(results[0].result.reason)),
    "the action's own error must survive the teardown",
  );
  assert.ok(
    results[0]?.result.status === "rejected" && !(results[0].result.reason instanceof DispatchAbandoned),
    "a real failure must not be relabelled as abandonment",
  );
  await assert.rejects(dispatch, /the action itself failed/);
});

test("work abandoned WHILE RUNNING is reported as billed with an unknown outcome", { timeout: 2000 }, async () => {
  const store = realStore();
  store.threads.set("t1", threadRecord("t1"));
  const manager = new ThreadManager(store, { maxConcurrent: 2 });
  const fields = constructorFields(manager);
  let finish!: (value: unknown) => void;
  fields.runDispatchInner = () => new Promise((resolve) => { finish = resolve; });

  const dispatch = manager.dispatch({ threadId: "t1", task: "in flight" }, {} as ExtensionContext, undefined);
  await settleMicrotasks();
  const entry = manager.outstanding().get("d1");
  assert.equal(entry?.started, true, "a dispatch holding a slot has started");

  const joined = manager.join();
  manager.clear();

  const results = await joined;
  assert.equal(results[0]?.outcome, "abandoned-in-flight");
  assert.equal(results[0]?.result.status, "rejected");
  const reason = results[0]?.result.status === "rejected" ? results[0].result.reason : undefined;
  assert.ok(reason instanceof DispatchAbandonedInFlight, "in-flight abandonment has its own error class");
  assert.ok(
    !(reason instanceof DispatchAbandoned),
    "it must not be confusable with the never-started class A3 reads as 'nothing ran'",
  );
  assert.ok(
    /may have been billed and may still record an episode/.test(String(reason)),
    "the message must not claim that nothing ran",
  );
  // The work really does continue, which is why the report says "unknown".
  finish({ episode: { status: "ok" }, usage: {} });
  await dispatch;
});

// The anti-regression net for the whole class: sweep the microtask distance
// between the work finishing and the registry being torn down. A timing-based
// decision changes its answer somewhere along this sweep; a state-based one is
// decided purely by which event happened first, including when they land in the
// same batch (gap 0). The invariant asserted at every point is the one BG29
// broke: work that STARTED is never reported as never-started.
test("the join verdict depends on event order, not on microtask distance", { timeout: 5000 }, async () => {
  const observed: string[] = [];
  for (const order of ["finish-then-clear", "clear-then-finish"] as const) {
    for (let gap = 0; gap <= 6; gap++) {
      const store = realStore();
      store.threads.set("t1", threadRecord("t1"));
      const manager = new ThreadManager(store, { maxConcurrent: 2 });
      const fields = constructorFields(manager);
      let finish!: (value: unknown) => void;
      fields.runDispatchInner = () => new Promise((resolve) => { finish = resolve; });

      const dispatch = manager.dispatch({ threadId: "t1", task: "sweep" }, {} as ExtensionContext, undefined);
      await settleMicrotasks();
      assert.equal(manager.outstanding().get("d1")?.started, true);
      const joined = manager.join();

      let hop = Promise.resolve();
      for (let i = 0; i < gap; i++) hop = hop.then(() => undefined);
      if (order === "finish-then-clear") {
        finish({ episode: { status: "ok" } });
        await hop;
        manager.clear();
      } else {
        manager.clear();
        await hop;
        finish({ episode: { status: "ok" } });
      }

      const outcome = (await joined)[0]?.outcome;
      assert.notEqual(
        outcome,
        "abandoned-before-start",
        `${order} at gap ${gap} claimed nothing ran about work that had started`,
      );
      observed.push(`${order}/${outcome}`);
      await dispatch.catch(() => undefined);
    }
  }
  // One answer per order, all the way across the sweep — no crossover point.
  assert.deepEqual([...new Set(observed)], ["finish-then-clear/settled", "clear-then-finish/abandoned-in-flight"]);
});

test("never-started and in-flight dispatches in one join get different verdicts", { timeout: 2000 }, async () => {
  const store = realStore();
  for (const id of ["t1", "t2"]) store.threads.set(id, threadRecord(id));
  const manager = new ThreadManager(store, { maxConcurrent: 1 });
  const fields = constructorFields(manager);
  fields.runDispatchInner = () => new Promise(() => {});
  const ctx = {} as ExtensionContext;

  const running = manager.dispatch({ threadId: "t1", task: "holds the slot" }, ctx, undefined);
  const queued = manager.dispatch({ threadId: "t2", task: "never got a slot" }, ctx, undefined);
  await settleMicrotasks();
  assert.equal(manager.outstanding().get("d1")?.started, true);
  assert.equal(manager.outstanding().get("d2")?.started, false, "a queued dispatch has not started");

  const joined = manager.join();
  manager.disposeAll();

  const results = await joined;
  assert.deepEqual(
    results.map((r) => [r.ticket, r.outcome]),
    [
      ["d1", "abandoned-in-flight"],
      ["d2", "abandoned-before-start"],
    ],
  );
  await assert.rejects(queued, DispatchAbandoned);
  assert.equal(await isPending(running), true);
  fields.semaphore.release();
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
  // The slot holder was executing; the two queued ones never ran a thing.
  assert.deepEqual(results.map((r) => r.outcome), [
    "abandoned-in-flight",
    "abandoned-before-start",
    "abandoned-before-start",
  ]);
  assert.ok(results.every((r) => r.result.status === "rejected"));

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

// CN46: abandoning a queued dispatch must not let the NEXT dispatch on that
// thread overtake the predecessor that is still talking to the worker session.
// The abandoned dispatch's own promise rejects at once, so storing that in the
// per-thread queue would hand the next dispatch an already-settled predecessor.
test("an abandoned queued dispatch does not let its successor overtake the running one", { timeout: 2000 }, async () => {
  const store = realStore();
  store.threads.set("t1", threadRecord("t1"));
  const manager = new ThreadManager(store, { maxConcurrent: 4 });
  const fields = constructorFields(manager);
  let started = 0;
  fields.runDispatchInner = () => {
    started++;
    return new Promise(() => {}); // the first dispatch never finishes
  };
  const ctx = {} as ExtensionContext;

  const running = manager.dispatch({ threadId: "t1", task: "still running" }, ctx, undefined);
  const abandonedQueued = manager.dispatch({ threadId: "t1", task: "queued then abandoned" }, ctx, undefined);
  await settleMicrotasks();
  assert.equal(started, 1);

  manager.clear();
  await assert.rejects(abandonedQueued, DispatchAbandoned);

  // A LATER dispatch on the same thread, registered after the abandonment.
  const later = manager.dispatch({ threadId: "t1", task: "must wait its turn" }, ctx, undefined);
  await settleMicrotasks();
  assert.equal(started, 1, "the thread's serial stream must still be held by the running dispatch");
  assert.equal(await isPending(later), true);

  // And it is not deadlocked either: abandoning it ends its wait.
  manager.clear();
  await assert.rejects(later, DispatchAbandoned);
  assert.equal(started, 1);
  assert.equal(await isPending(running), true);
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
