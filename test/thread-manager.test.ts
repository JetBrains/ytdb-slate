const TEST_ROUTE = { model: "gpt-5.6-luna", reason: "test fixture" } as const;

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogicalRuntime, type LogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore, type SlateConfig, type ThreadRecord } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";
import { bindFakeWorkerRequest } from "./worker-request-contract-fixture.ts";
import {
  EMPTY_WORKER_EXTENSION_SET,
  type WorkerExtensionSet,
} from "../extension/worker-extensions.ts";

interface SemaphoreView {
  acquire(): Promise<void>;
  release(): void;
}

interface ThreadManagerConstructorFields {
  store: SlateStore;
  semaphore: SemaphoreView;
  resolveExtensions: () => WorkerExtensionSet;
  logicalRuntime?: Readonly<LogicalRuntime>;
}

function constructorFields(manager: ThreadManager): ThreadManagerConstructorFields {
  return manager as unknown as ThreadManagerConstructorFields;
}

test("ThreadManager preserves explicit constructor arguments and extension defaults", async () => {
  const store = { orchestratorMode: true, paused: true } as unknown as SlateStore;
  const config: SlateConfig = { maxConcurrent: 2, workerTools: ["distinguishable-config"] };
  const extensions = { units: [], paths: ["/distinguishable/extensions"], toolNames: ["distinguishable-extension"] } satisfies WorkerExtensionSet;
  const runtime = createLogicalRuntime({ trusted: true });
  const manager = new ThreadManager(store, config, () => extensions, runtime);
  const fields = constructorFields(manager);
  assert.strictEqual(manager.getConfig(), config);
  assert.strictEqual(fields.store, store);
  await assert.rejects(manager.dispatch({ ...TEST_ROUTE, task: "" }, {} as ExtensionContext, undefined), /task must be a non-empty string/);
  assert.strictEqual(fields.resolveExtensions(), extensions);
  assert.strictEqual(fields.logicalRuntime, runtime);
  const defaults = constructorFields(new ThreadManager(store, config));
  assert.strictEqual(defaults.store, store);
  assert.strictEqual(defaults.resolveExtensions(), EMPTY_WORKER_EXTENSION_SET);
  assert.equal(defaults.logicalRuntime, undefined);
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

test("public dispatch enforces maxConcurrent across different threads", { timeout: 1000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-semaphore-dispatch-test."));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const runtime = createLogicalRuntime({
      trusted: true,
      projectConfig: { router: { models: { replace: [{ model: "gpt-5.6-luna", preferredProvider: "test", providers: { test: "worker" } }] } } },
    });
    const manager = new ThreadManager(store, { maxConcurrent: 1 }, undefined, runtime);
    const live = (manager as unknown as { live: Map<string, unknown> }).live;
    let opens = 0;
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    let firstEnteredResolve: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstEnteredResolve = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondEnteredResolve!: () => void;
    const secondEntered = new Promise<void>((resolve) => { secondEnteredResolve = resolve; });

    (manager as unknown as {
      openWorkerFor(args: { thread: ThreadRecord; requestContract: import("../extension/worker.ts").WorkerRequestContract }): Promise<{ session: unknown; baseline: unknown }>;
    }).openWorkerFor = async ({ thread, requestContract }) => {
      opens++;
      const messages: unknown[] = [];
      const subscribers = new Set<(event: unknown) => void>();
      const session = {
        messages,
        model: { provider: "test", id: "worker" },
        thinkingLevel: "max",
        sessionFile: undefined,
        getContextUsage: () => undefined,
        setThinkingLevel(level: string) { session.thinkingLevel = level; },
        subscribe: (listener: (event: unknown) => void) => {
          subscribers.add(listener);
          return () => subscribers.delete(listener);
        },
        dispose() {},
        prompt: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          order.push(`start-${thread.id}`);
          if (thread.id === "t1") {
            firstEnteredResolve();
            await firstGate;
          } else {
            secondEnteredResolve();
          }
          order.push(`end-${thread.id}`);
          active--;
          const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
          messages.push(message);
          for (const listener of subscribers) listener({ type: "message_end", message });
        },
      };
      bindFakeWorkerRequest(session, requestContract);
      live.set(thread.id, session);
      return { session, baseline: {} };
    };

    const ctx = { cwd: root, modelRegistry: {
      find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id, reasoning: true, thinkingLevelMap: { max: "max" } } : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only" }),
    } } as unknown as ExtensionContext;
    const first = manager.dispatch({ ...TEST_ROUTE, name: "first", task: "first", type: "researcher" }, ctx, undefined);
    await firstEntered;
    const second = manager.dispatch({ ...TEST_ROUTE, name: "second", task: "second", type: "general" }, ctx, undefined);
    const beforeRelease = await Promise.race([
      secondEntered.then(() => "entered" as const),
      new Promise<"turn">((resolve) => setImmediate(() => resolve("turn"))),
    ]);
    if (beforeRelease === "entered") {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
    assert.equal(beforeRelease, "turn", "the second action must not enter before the first releases");
    assert.equal(opens, 1, "the second worker must wait outside the critical section");
    assert.equal(maxActive, 1);

    releaseFirst();
    await secondEntered;
    await Promise.all([first, second]);
    assert.equal(opens, 2);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, ["start-t1", "end-t1", "start-t2", "end-t2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
        format: "single-action-v1",
        threads: [],
        episodes: [],
        threadSeq: 0,
        orchestratorMode: false,
        paused: true,
        workerCostUsd: 1.25,
        carriedCostUsd: 0,
      },
    },
  ]);
});
