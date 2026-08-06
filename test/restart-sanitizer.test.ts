import assert from "node:assert/strict";
import test from "node:test";
import { SlateStore, sanitizeThreadRecord, type SlateSnapshot, type ThreadRecord } from "../extension/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function rawThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t2",
    name: "successor",
    sessionFile: "",
    status: "idle",
    episodeIds: [],
    episodeSeq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function context(): ExtensionContext {
  return {
    hasUI: false,
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  } as unknown as ExtensionContext;
}

test("valid restart lineage survives sanitization and snapshot adoption", () => {
  const repairs: string[] = [];
  const adopted = sanitizeThreadRecord(
    rawThread({ restartOf: "t1", restartGeneration: 2, supersededBy: "t3" }),
    repairs,
  );
  assert.deepEqual(adopted?.restartOf, "t1");
  assert.equal(adopted?.restartGeneration, 2);
  assert.equal(adopted?.supersededBy, "t3");
  assert.deepEqual(repairs, []);

  const snapshot: SlateSnapshot = {
    threads: [adopted as ThreadRecord],
    episodes: [],
    orchestratorMode: false,
    paused: false,
    workerCostUsd: 0,
    carriedCostUsd: 0,
  };
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.adoptSnapshot(snapshot, context());
  assert.deepEqual(store.threads.get("t2"), adopted);
  assert.deepEqual(store.snapshot().threads[0], adopted);
});

test("self-referential lineage is repaired without throwing", () => {
  const repairs: string[] = [];
  assert.doesNotThrow(() => sanitizeThreadRecord(
    rawThread({ restartOf: "t2", restartGeneration: 1, supersededBy: "t2" }),
    repairs,
  ));
  const repaired = sanitizeThreadRecord(
    rawThread({ restartOf: "t2", restartGeneration: 1, supersededBy: "t2" }),
    [],
  );
  assert.equal(repaired?.restartOf, undefined);
  assert.equal(repaired?.restartGeneration, undefined);
  assert.equal(repaired?.supersededBy, undefined);
  assert.deepEqual(repairs, [
    "thread t2: ignoring restartOf (string)",
    "thread t2: ignoring incomplete restart lineage (restartOf and restartGeneration must appear together)",
    "thread t2: ignoring supersededBy (string)",
  ]);
});

test("restart generation requires a positive safe integer", () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    const repairs: string[] = [];
    const adopted = sanitizeThreadRecord(rawThread({ restartOf: "t1", restartGeneration: value }), repairs);
    assert.equal(adopted?.restartOf, undefined, String(value));
    assert.equal(adopted?.restartGeneration, undefined, String(value));
    assert.match(repairs.join("\n"), /ignoring restartGeneration/);
  }

  const repairs: string[] = [];
  const valid = sanitizeThreadRecord(rawThread({ restartOf: "t1", restartGeneration: 1 }), repairs);
  assert.equal(valid?.restartOf, "t1");
  assert.equal(valid?.restartGeneration, 1);
  assert.deepEqual(repairs, []);
});

test("restart lineage source and generation fields are paired", () => {
  const missingGenerationRepairs: string[] = [];
  const missingGeneration = sanitizeThreadRecord(rawThread({ restartOf: "t1" }), missingGenerationRepairs);
  assert.equal(missingGeneration?.restartOf, undefined);
  assert.equal(missingGeneration?.restartGeneration, undefined);
  assert.deepEqual(missingGenerationRepairs, [
    "thread t2: ignoring incomplete restart lineage (restartOf and restartGeneration must appear together)",
  ]);

  const missingSourceRepairs: string[] = [];
  const missingSource = sanitizeThreadRecord(rawThread({ restartGeneration: 1 }), missingSourceRepairs);
  assert.equal(missingSource?.restartOf, undefined);
  assert.equal(missingSource?.restartGeneration, undefined);
  assert.deepEqual(missingSourceRepairs, [
    "thread t2: ignoring incomplete restart lineage (restartOf and restartGeneration must appear together)",
  ]);
});

test("malformed lineage fields stay harmless and record repairs", () => {
  const repairs: string[] = [];
  let adopted: ThreadRecord | undefined;
  assert.doesNotThrow(() => {
    adopted = sanitizeThreadRecord(
      rawThread({ restartOf: { id: "t1" }, restartGeneration: { value: 1 }, supersededBy: ["t3"] }),
      repairs,
    );
  });
  assert.ok(adopted);
  assert.equal(adopted.restartOf, undefined);
  assert.equal(adopted.restartGeneration, undefined);
  assert.equal(adopted.supersededBy, undefined);
  assert.match(repairs.join("\n"), /ignoring restartOf/);
  assert.match(repairs.join("\n"), /ignoring restartGeneration/);
  assert.match(repairs.join("\n"), /ignoring supersededBy/);
});
