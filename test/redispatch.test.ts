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
const { createModelRouterResolver } = await import("../extension/model-router.ts");
const load = <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>;
const { piAiCompatStub } = await load<{ piAiCompatStub: { complete: (...args: unknown[]) => Promise<unknown> } }>("../verification/stubs/pi-ai-compat.mjs");

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
  getContextUsage(): { tokens: number } | undefined;
}

function context(cwd: string, models: Array<{ provider: string; id: string }> = []): ExtensionContext {
  const bySpec = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  return {
    cwd,
    model: undefined,
    hasUI: false,
    modelRegistry: {
      find: (provider: string, id: string) => bySpec.get(`${provider}/${id}`),
      getAvailable: async () => models,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      hasConfiguredAuth: () => true,
    },
  } as unknown as ExtensionContext;
}

function session(script: (self: FakeSession) => Promise<void> | void, contextTokens?: number) {
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
      return contextTokens === undefined ? undefined : { tokens: contextTokens };
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
  testContext?: { after(callback: () => void): void },
) {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const routerModels = (config.router as { models?: unknown } | undefined)?.models;
  const resolveRouter = Array.isArray(routerModels)
    ? createModelRouterResolver(() => ({
        registry: { find: () => billedModel, hasConfiguredAuth: () => true },
        models: routerModels.filter((model): model is string => typeof model === "string"),
      }))
    : undefined;
  const manager = new ThreadManager(store, config, undefined, resolveRouter);
  const internal = manager as unknown as {
    live: Map<string, FakeSession>;
    queues: Map<string, Promise<unknown>>;
    planChoice: (...args: unknown[]) => unknown;
    openWorkerFor: (args: { thread: { id: string } }) => Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
    buildPrompt: (...args: unknown[]) => string;
    longContextWarned: Map<string, Set<string>>;
    rollbackRestart: (source: ThreadRecord, successor: ThreadRecord) => void;
    createThread: (...args: unknown[]) => ThreadRecord;
  };
  let index = 0;
  internal.openWorkerFor = async ({ thread }) => {
    const selected = sessions[index++];
    assert.ok(selected, `missing fake session for ${thread.id}`);
    internal.live.set(thread.id, selected.value);
    return { session: selected.value, baseline: NO_SESSION_BASELINE };
  };
  testContext?.after(() => manager.disposeAll());
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
const billedModel = { provider: "openai", id: "gpt-5.6-luna", contextWindow: 1_050_000 };
const billedConfig = { threadChoice: { report: true, act: true }, router: { models: ["openai/gpt-5.6-luna"] } };
const billedSpec = "openai/gpt-5.6-luna";

test("abort before successor prompt rolls back and restores a usable source", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-abort-before-commit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  });
  const successorSession = session(async () => {});
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, successorSession], t);
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

test("an unbilled restart rollback does not consume the source long-context notice", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-billing-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  }, 300_000);
  const successorSession = session(async () => {});
  const { store, manager, internal } = harness(billedConfig, [sourceSession, successorSession], t);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const controller = new AbortController();
  const originalOpen = internal.openWorkerFor;
  internal.openWorkerFor = async (args) => {
    if (args.thread.id === "t2") {
      controller.abort();
      throw new Error("successor failed before prompt");
    }
    return originalOpen(args);
  };
  await assert.rejects(
    manager.dispatch({ threadId: source.id, task: "restart", type: "general", freshContext: [] }, context(root, [billedModel]), controller.signal),
    /restart from thread t1 ended before its action started/,
  );
  assert.equal(internal.longContextWarned.has(source.id), false);
});

test("a legitimately consumed source notice is not repeated after restart rollback", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-billing-already-seen-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  }, 300_000);
  const successorSession = session(async () => {});
  const { store, manager, internal } = harness(billedConfig, [sourceSession, successorSession], t);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.longContextWarned.set(source.id, new Set([billedSpec]));
  internal.planChoice = () => fresh;
  const originalOpen = internal.openWorkerFor;
  internal.openWorkerFor = async (args) => {
    if (args.thread.id === "t2") throw new Error("successor failed before prompt");
    return originalOpen(args);
  };
  const result = await manager.dispatch({ threadId: source.id, task: "restart", type: "general", freshContext: [] }, context(root, [billedModel]), undefined);
  assert.equal(result.thread.id, source.id);
  assert.deepEqual([...internal.longContextWarned.get(source.id) ?? []], [billedSpec]);
  assert.doesNotMatch(result.warnings.join("\n"), /long-context/);
});

test("a committed restart consumes the source long-context notice", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-billing-commit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  }, 300_000);
  const successorSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "successor" }] });
  });
  const { store, manager, internal } = harness(billedConfig, [sourceSession, successorSession], t);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const result = await manager.dispatch({ threadId: source.id, task: "restart", type: "general", freshContext: [] }, context(root, [billedModel]), undefined);
  assert.equal(result.thread.id, "t2");
  assert.match(result.warnings.join("\n"), /long-context/);
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
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, successorSession], t);
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

test("a queued sibling cannot publish after its source is superseded", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-sibling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first source action" }] });
  });
  const successorSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "successor" }] });
  });
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, successorSession], t);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const originalOpen = internal.openWorkerFor;
  internal.openWorkerFor = async (...args: unknown[]) => {
    const thread = (args[0] as { thread: { id: string } }).thread;
    if (thread.id === "t1") await openGate;
    return originalOpen(args[0] as { thread: { id: string } });
  };
  const first = manager.dispatch({ threadId: "t1", task: "restart", type: "general", freshContext: [] }, context(root), undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sibling = manager.dispatch({ threadId: "t1", task: "sibling", type: "general", freshContext: [] }, context(root), undefined);
  releaseOpen();
  const firstResult = await first;
  assert.equal(firstResult.thread.id, "t2");
  await assert.rejects(sibling, /Thread "t1" was superseded by t2/);
  assert.equal(source.episodeIds.length, 0);
  assert.equal(store.episodes.has("t1.e1"), false);
  assert.equal(store.episodes.has("t1.e2"), false);
});

test("successful restart retires the source runtime state", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-retire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  });
  const successorSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "successor" }] });
  });
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, successorSession], t);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const result = await manager.dispatch({ threadId: "t1", task: "restart", type: "general", freshContext: [] }, context(root), undefined);
  assert.equal(result.thread.id, "t2");
  assert.equal(internal.live.has("t1"), false);
  assert.equal((internal as unknown as { liveBaselines: Map<string, unknown> }).liveBaselines.has("t1"), false);
  assert.equal(internal.queues.has("t1"), false);
  assert.equal(sourceSession.wasDisposed(), true);
});

test("rollback advances identifiers and clears deleted warning state", (t) => {
  const sourceSession = session(() => {});
  const successorSession = session(() => {});
  const { store, internal } = harness({}, [sourceSession, successorSession], t);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  const successorId = store.claimNextThreadId();
  assert.equal(successorId, "t2");
  const successor = { ...source, id: successorId, name: "successor" };
  store.threads.set(successor.id, successor);
  internal.live.set(successor.id, successorSession.value);
  internal.queues.set(successor.id, Promise.resolve());
  internal.longContextWarned.set(successor.id, new Set(["p/m"]));

  internal.rollbackRestart(source, successor);
  const replacement = internal.createThread({ task: "replacement", type: "general" }, {});
  assert.equal(replacement.id, "t3");
  assert.equal(internal.longContextWarned.has("t2"), false);
  assert.equal(internal.longContextWarned.has(replacement.id), false);
});

test("restart unions context and allowance in stable order and refuses overflow", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  });
  const successorSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "successor" }] });
  });
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, successorSession], t);
  for (const id of ["a", "b", "c"]) store.episodes.set(id, { id, threadId: "t1", task: id, status: "ok", file: "", createdAt: 1 });
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const prompts: string[] = [];
  internal.buildPrompt = ((opts: { contextEpisodeIds?: string[] }) => {
    prompts.push(JSON.stringify(opts.contextEpisodeIds ?? []));
    return "prompt";
  }) as unknown as (...args: unknown[]) => string;
  const result = await manager.dispatch({ threadId: "t1", task: "restart", type: "general", contextEpisodeIds: ["a", "b"], freshContext: ["b", "c"] }, context(root), undefined);
  assert.equal(result.thread.id, "t2");
  assert.deepEqual(JSON.parse(prompts.at(-1) ?? "[]"), ["a", "b", "c"]);

  const overflowSessions = [session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  })];
  const overflow = harness({ threadChoice: { report: true, act: true } }, overflowSessions, t);
  const overflowSource = sourceRecord();
  overflow.store.threads.set(overflowSource.id, overflowSource);
  overflow.internal.planChoice = () => fresh;
  overflow.internal.buildPrompt = (() => "prompt") as unknown as (...args: unknown[]) => string;
  for (let index = 0; index < 33; index++) {
    const id = `e${index}`;
    overflow.store.episodes.set(id, { id, threadId: "t1", task: id, status: "ok", file: "", createdAt: 1 });
  }
  const overflowResult = await overflow.manager.dispatch({ threadId: "t1", task: "overflow", type: "general", contextEpisodeIds: Array.from({ length: 2 }, (_, index) => `e${index}`), freshContext: Array.from({ length: 32 }, (_, index) => `e${index + 1}`) }, context(root), undefined);
  assert.equal(overflowResult.thread.id, "t1");
  assert.equal(overflow.store.threads.has("t2"), false);
  assert.match(overflowResult.warnings.join("\n"), /combined context names 33 episodes/);
});

test("abort during committed successor compression preserves its episode", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-redispatch-compression-abort-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let releaseCompression!: () => void;
  let compressionStarted!: () => void;
  const compressionGate = new Promise<void>((resolve) => { releaseCompression = resolve; });
  const compressionStart = new Promise<void>((resolve) => { compressionStarted = resolve; });
  const originalComplete = piAiCompatStub.complete;
  let compressionCalls = 0;
  piAiCompatStub.complete = async (...args: unknown[]) => {
    compressionCalls++;
    if (compressionCalls === 1) {
      compressionStarted();
      await compressionGate;
      const options = args[2] as { signal?: AbortSignal } | undefined;
      if (options?.signal?.aborted) return { stopReason: "aborted", content: [], usage: {} };
    }
    return originalComplete(...args);
  };
  t.after(() => { piAiCompatStub.complete = originalComplete; });
  const sourceSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "source" }] });
  });
  const successorSession = session(async (self) => {
    self.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "successor" }] });
  });
  const { store, manager, internal } = harness({ episodeModel: "anthropic/claude-sonnet-5", threadChoice: { report: true, act: true } }, [sourceSession, successorSession], t);
  const source = sourceRecord();
  store.threads.set(source.id, source);
  internal.planChoice = () => fresh;
  const controller = new AbortController();
  const compressor = { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200_000, maxTokens: 8192, reasoning: true, api: "anthropic-messages" };
  const dispatch = manager.dispatch({ threadId: "t1", task: "restart", type: "general", freshContext: [] }, context(root, [compressor]), controller.signal);
  await compressionStart;
  controller.abort();
  releaseCompression();
  const result = await dispatch;
  assert.equal(result.thread.id, "t2");
  const successor = store.threads.get("t2");
  assert.ok(successor);
  const episodeId = successor.episodeIds[0];
  assert.ok(episodeId);
  assert.equal(store.episodes.has(episodeId), true);
  assert.equal(store.episodes.get(episodeId)?.status, "ok");
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
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: true } }, [sourceSession, failedSuccessor], t);
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

test("naming a superseded thread names its successor", { timeout: 1000 }, async () => {
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
  const { store, manager, internal } = harness({ threadChoice: { report: true, act: false } }, [worker], t);
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
