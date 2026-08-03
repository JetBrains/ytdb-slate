import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { ROUTER_OFF, type ModelRouterResolution } from "../extension/model-router.ts";
import { SlateStore, type SlateConfig } from "../extension/state.ts";
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
}

function constructorFields(manager: ThreadManager): ThreadManagerConstructorFields {
  return manager as unknown as ThreadManagerConstructorFields;
}

test("ThreadManager preserves explicit constructor arguments and resolver defaults", async () => {
  const store = { paused: true } as unknown as SlateStore;
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

test("ThreadManager's semaphore admits its limit and transfers a released slot", async () => {
  const manager = new ThreadManager(
    { paused: false } as unknown as SlateStore,
    { maxConcurrent: 2 },
  );
  const semaphore = constructorFields(manager).semaphore;
  let firstAdmitted = false;
  let secondAdmitted = false;
  let waiterAdmitted = false;

  const first = semaphore.acquire().then(() => {
    firstAdmitted = true;
  });
  const second = semaphore.acquire().then(() => {
    secondAdmitted = true;
  });
  const waiter = semaphore.acquire().then(() => {
    waiterAdmitted = true;
  });

  await Promise.resolve();
  assert.equal(firstAdmitted, true);
  assert.equal(secondAdmitted, true);
  assert.equal(waiterAdmitted, false);

  semaphore.release();
  await waiter;
  assert.equal(waiterAdmitted, true);

  await Promise.all([first, second]);
  semaphore.release();
  semaphore.release();
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
        workerCostUsd: 1.25,
        carriedCostUsd: 0,
      },
    },
  ]);
});
