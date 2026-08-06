import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

register("../verification/test-resolve-hooks.mjs", import.meta.url);

const { ThreadManager } = await import("../extension/threads.ts");
const { SlateStore } = await import("../extension/state.ts");
import type { ThreadRecord } from "../extension/state.ts";
const { NO_SESSION_BASELINE } = await import("../extension/route.ts");

interface FakeSession {
  messages: unknown[];
  model: undefined;
  thinkingLevel: undefined;
  sessionFile: undefined;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  setModel(): Promise<void>;
  setThinkingLevel(): void;
  getContextUsage(): undefined;
}

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

function session(script: (self: FakeSession) => Promise<void> | void) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let disposed = false;
  const value: FakeSession = {
    messages: [],
    model: undefined,
    thinkingLevel: undefined,
    sessionFile: undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text) {
      await script(value);
      if (text === "") return;
    },
    async abort() {},
    dispose() {
      disposed = true;
    },
    async setModel() {},
    setThinkingLevel() {},
    getContextUsage() {
      return undefined;
    },
  };
  return {
    value,
    emitAssistant(stopReason: "stop" | "error" = "stop") {
      const message = {
        role: "assistant",
        stopReason,
        content: stopReason === "error" ? [] : [{ type: "text", text: "worker completed" }],
      };
      value.messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message });
    },
    wasDisposed: () => disposed,
  };
}

function harness(
  config: Record<string, unknown>,
  sessions: Array<ReturnType<typeof session>>,
) {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, config);
  const internal = manager as unknown as {
    live: Map<string, FakeSession>;
    queues: Map<string, Promise<unknown>>;
    planChoice: (...args: unknown[]) => unknown;
    openWorkerFor: (args: { thread: { id: string } }) => Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
  };
  let index = 0;
  internal.openWorkerFor = async ({ thread }) => {
    const selected = sessions[index++];
    assert.ok(selected, `missing fake session for ${thread.id}`);
    internal.live.set(thread.id, selected.value);
    return { session: selected.value, baseline: NO_SESSION_BASELINE };
  };
  return { store, manager, internal };
}

function sourceRecord(): ThreadRecord {
  return {
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
}

const fresh = { kind: "fresh", code: "fresh-cheaper", reason: "fresh is cheaper" } as const;
const continued = { kind: "continue", code: "short-work", reason: "continue" } as const;

test("abort before successor prompt rolls back and restores a usable source", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-abort-before-commit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  });
  const successorSession = session(async () => {});
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, successorSession]);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const controller = new AbortController();
  const originalOpen = internal.openWorkerFor;
  internal.openWorkerFor = async (...args: unknown[]) => {
    const result = await originalOpen(args[0] as { thread: { id: string } });
    const thread = (args[0] as { thread: { id: string } }).thread;
    if (thread.id === "t2") controller.abort();
    return result;
  };
  await assert.rejects(
    manager.dispatch(
      { threadId: source.id, task: "restart me", type: "general", freshContext: [] },
      context(root),
      controller.signal,
    ),
    /aborting the dispatch to thread t2 before any billed work/,
  );

  assert.equal(source.id, "t1");
  assert.equal(store.threads.has("t2"), false);
  assert.deepEqual([...store.episodes.keys()].filter((id) => id.startsWith("t2.")), []);
  assert.equal(internal.queues.has("t2"), false);
  assert.equal(internal.live.has("t2"), false);
  assert.equal(successorSession.wasDisposed(), true);
  assert.equal(source.supersededBy, undefined);
  assert.equal(source.status, "idle");

  internal.planChoice = () => continued;
  const resumed = await manager.dispatch(
    { threadId: source.id, task: "use source again", type: "general", freshContext: [] },
    context(root),
    undefined,
  );
  assert.equal(resumed.thread.id, "t1");
  assert.equal(store.threads.has("t2"), false);
});

test("abort after successor prompt commits lineage and retains the failed successor", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-abort-after-commit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let releaseSuccessor!: () => void;
  let successorStarted!: () => void;
  const started = new Promise<void>((resolve) => { successorStarted = resolve; });
  const successorGate = new Promise<void>((resolve) => { releaseSuccessor = resolve; });
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  });
  const successorSession = session(async () => {
    successorStarted();
    await successorGate;
  });
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, successorSession]);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const controller = new AbortController();
  const dispatch = manager.dispatch(
    { threadId: source.id, task: "restart me", type: "general", freshContext: [] },
    context(root),
    controller.signal,
  );
  await started;
  controller.abort();
  releaseSuccessor();
  const result = await dispatch;
  assert.equal(result.thread.id, "t2");

  const successor = store.threads.get("t2");
  assert.ok(successor);
  assert.equal(source.supersededBy, "t2");
  assert.equal(successor.restartOf, "t1");
  assert.equal(successor.episodeIds.length, 1);
  const episodeId = successor.episodeIds[0];
  assert.ok(episodeId);
  assert.equal(store.episodes.get(episodeId)?.status, "failed");
  assert.equal(internal.queues.has("t2"), true);
  assert.equal(internal.live.has("t2"), true);
});

test("a successor with a failed episode keeps its lineage", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-failed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  });
  const failedSuccessor = session(async (self) => {
    const message = { role: "assistant", stopReason: "error", content: [] };
    self.messages.push(message);
  });
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, failedSuccessor]);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const result = await manager.dispatch(
    { threadId: source.id, task: "restart and fail", type: "general", freshContext: [] },
    context(root),
    undefined,
  );
  const successor = store.threads.get(result.thread.id);
  assert.ok(successor);
  assert.equal(successor.restartOf, "t1");
  assert.equal(successor.restartGeneration, 1);
  assert.equal(source.supersededBy, successor.id);
  assert.equal(source.status, "idle");
  assert.equal(successor.episodeIds.length, 1);
  const successorEpisodeId = successor.episodeIds[0];
  assert.ok(successorEpisodeId);
  assert.equal(store.episodes.get(successorEpisodeId)?.status, "failed");
});

test("naming a superseded thread names its successor", async () => {
  const { store, manager } = harness({}, []);
  const source = { ...sourceRecord(), supersededBy: "t2" };
  store.threads.set(source.id, source);
  await assert.rejects(
    manager.dispatch({ threadId: "t1", task: "stale" }, context("/tmp"), undefined),
    /Thread "t1" was superseded by t2\. Continue the successor instead\./,
  );
});

test("a successor without its own episode refuses another restart", () => {
  const { manager } = harness({ threadChoice: { act: true } }, []);
  const refusal = (manager as unknown as { restartRefusal(source: { id: string; type: string; restartOf?: string; episodeIds: string[] }): string | undefined })
    .restartRefusal({ id: "t2", type: "general", restartOf: "t1", episodeIds: [] });
  assert.equal(refusal, "thread t2 is a successor with no episode of its own, so no new evidence supports another restart");
});

test("acting off leaves the source without successor lineage", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-off-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  });
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: false } }, [worker]);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const result = await manager.dispatch(
    { threadId: source.id, task: "report only", type: "general", freshContext: [] },
    context(root),
    undefined,
  );
  assert.equal(result.thread.id, "t1");
  assert.deepEqual([...store.threads.keys()], ["t1"]);
  assert.equal(source.restartOf, undefined);
  assert.equal(source.restartGeneration, undefined);
  assert.equal(source.supersededBy, undefined);
});
