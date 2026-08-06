import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

register("../verification/test-resolve-hooks.mjs", import.meta.url);

const { normalizeFreshContext, ThreadManager } = await import("../extension/threads.ts");
const { SlateStore } = await import("../extension/state.ts");
import type { ThreadRecord } from "../extension/state.ts";
const { NO_SESSION_BASELINE } = await import("../extension/route.ts");
const { threadChoiceLine } = await import("../extension/tools.ts");

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    model: undefined,
    hasUI: false,
    modelRegistry: {
      find: () => undefined,
      getAvailable: async () => [],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      hasConfiguredAuth: () => true,
    },
  } as unknown as ExtensionContext;
}

function session() {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const value = {
    messages: [] as unknown[],
    model: undefined,
    thinkingLevel: undefined,
    sessionFile: undefined,
    subscribe(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "reported" }] };
      value.messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message });
    },
    async abort() {},
    dispose() {},
    async setModel() {},
    setThinkingLevel() {},
    getContextUsage() { return undefined; },
  };
  return value;
}

test("freshContext validation preserves absent, malformed, empty, and named states", () => {
  assert.equal(normalizeFreshContext(undefined), undefined);
  assert.equal(normalizeFreshContext(null), null);
  assert.deepEqual(normalizeFreshContext([]), []);
  assert.deepEqual(normalizeFreshContext(["t1.e1", "t2.e1"]), ["t1.e1", "t2.e1"]);
  assert.equal(normalizeFreshContext(["t1.e1", 7] as unknown), null);
  assert.throws(
    () => normalizeFreshContext(Array.from({ length: 33 }, (_, index) => `t1.e${index + 1}`)),
    /accepts at most 32 episode ids/,
  );
});

test("named freshContext rejects unknown episodes before creating or mutating a thread", async () => {
  const root = mkdtempSync(join("/tmp", "slate-dispatch-choice-validation-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {});
    await assert.rejects(
      manager.dispatch({ task: "bad context", type: "general", freshContext: ["missing"] }, context(root), undefined),
      /Unknown freshContext episode "missing"\. Known episodes: none/,
    );
    assert.deepEqual([...store.threads.keys()], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report-only dispatch computes an exact verdict without moving work", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-dispatch-choice-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, { threadChoice: { report: true, act: false } });
  const internal = manager as unknown as {
    live: Map<string, unknown>;
    planChoice: (...args: unknown[]) => unknown;
    openWorkerFor: (...args: unknown[]) => Promise<unknown>;
  };
  const worker = session();
  const source: ThreadRecord = {
    id: "t1",
    name: "source",
    sessionFile: "",
    status: "idle" as const,
    type: "general" as const,
    tools: ["read"],
    episodeIds: [],
    episodeSeq: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  store.threads.set(source.id, source);
  internal.openWorkerFor = async (...args: unknown[]) => {
    const thread = (args[0] as { thread: { id: string } }).thread;
    internal.live.set(thread.id, worker);
    return { session: worker, baseline: NO_SESSION_BASELINE };
  };
  const planned = {
    kind: "fresh",
    code: "fresh-cheaper",
    reason: "fresh costs less for this work stream",
    warmth: { warm: true, code: "within-retention", elapsedSeconds: 5, windowSeconds: 60 },
    estimate: {
      continuation: { usd: 0.12, turns: 3, cacheReadTokens: 1, freshTokens: 2, outputTokens: 3, longContextTurns: 0 },
      fresh: { usd: 0.08, turns: 4, cacheReadTokens: 1, freshTokens: 2, outputTokens: 3, longContextTurns: 0 },
      expectedTurns: 3,
      rediscoveryTurns: 1,
      freshSeedCache: "write" as const,
    },
  };
  internal.planChoice = () => planned;

  const result = await manager.dispatch(
    { threadId: source.id, task: "report choice", type: "general", freshContext: [] },
    context(root),
    undefined,
  );
  assert.equal(result.thread.id, "t1");
  assert.deepEqual(result.choice, planned);
  assert.deepEqual([...store.threads.keys()], ["t1"]);
  assert.equal(source.supersededBy, undefined);
  assert.equal(source.restartOf, undefined);
});

test("threadChoiceLine renders exact priced and unpriced reporting shapes", () => {
  const priced = threadChoiceLine({
    kind: "fresh",
    code: "fresh-cheaper",
    reason: "fresh costs less",
    warmth: { warm: true, code: "within-retention", elapsedSeconds: 5, windowSeconds: 60, reason: "warm" },
    estimate: {
      continuation: { usd: 0.12, turns: 3, cacheReadTokens: 0, freshTokens: 0, outputTokens: 0, longContextTurns: 0 },
      fresh: { usd: 0.08, turns: 4, cacheReadTokens: 0, freshTokens: 0, outputTokens: 0, longContextTurns: 0 },
      expectedTurns: 3,
      rediscoveryTurns: 1,
      freshSeedCache: "write",
    },
  });
  assert.equal(priced, "Choice: FRESH | continue $0.1200/3t | fresh $0.0800/4t | fresh cheaper; warm: age 5s/60s retention");

  const unpriced = threadChoiceLine({ kind: "abstain", code: "prices-unusable", reason: "no prices" });
  assert.equal(unpriced, "Choice: ABSTAIN | continue unpriced | fresh unpriced | prices unusable");
});
