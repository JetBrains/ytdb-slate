import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

register("../verification/test-resolve-hooks.mjs", import.meta.url);

const load = <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>;
const { ThreadManager } = await load<typeof import("../extension/threads.ts")>("../extension/threads.ts");
const { writeFailedEpisode } = await load<typeof import("../extension/episodes.ts")>("../extension/episodes.ts");
const { SlateStore, sanitizeEpisodeRecord } = await load<typeof import("../extension/state.ts")>("../extension/state.ts");
const { NO_SESSION_BASELINE } = await load<typeof import("../extension/route.ts")>("../extension/route.ts");
const { piAiCompatStub } = await load<{
  piAiCompatStub: { complete: (...args: unknown[]) => Promise<unknown> };
}>("../verification/stubs/pi-ai-compat.mjs");

interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface FakeSession {
  messages: unknown[];
  model: FakeModel | undefined;
  thinkingLevel: undefined;
  sessionFile: undefined;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  setModel(model: FakeModel): Promise<void>;
  setThinkingLevel(): void;
  getContextUsage(): undefined;
  listenerCount(): number;
  emit(event: Record<string, unknown>): void;
}

interface FakeModel {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

type PromptScript = (session: FakeSession) => void | Promise<void>;

function assistant(usage: TokenUsage, text = "worker result") {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
    usage,
  };
}

function fakeSession(script: PromptScript, model?: FakeModel): FakeSession {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const session: FakeSession = {
    messages: [],
    model,
    thinkingLevel: undefined,
    sessionFile: undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      await script(session);
    },
    async abort() {},
    dispose() {},
    async setModel(next) {
      session.model = next;
    },
    setThinkingLevel() {},
    getContextUsage() {
      return undefined;
    },
    listenerCount() {
      return listeners.size;
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
  return session;
}

function successfulPrompt(usages: TokenUsage[]): PromptScript {
  return (session) => {
    for (const [index, usage] of usages.entries()) {
      const message = assistant(usage, `turn ${index + 1}`);
      session.messages.push(message);
      session.emit({ type: "message_end", message });
    }
  };
}

function model(provider: string, id: string): FakeModel {
  return { provider, id, contextWindow: 200_000, maxTokens: 8192, reasoning: false };
}

function context(cwd: string, models: FakeModel[] = []): ExtensionContext {
  const bySpec = new Map(models.map((entry) => [`${entry.provider}/${entry.id}`, entry]));
  return {
    cwd,
    model: undefined,
    hasUI: false,
    modelRegistry: {
      find(provider: string, id: string) {
        return bySpec.get(`${provider}/${id}`);
      },
      async getAvailable() {
        return models;
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key" };
      },
      hasConfiguredAuth() {
        return true;
      },
    },
  } as unknown as ExtensionContext;
}

function store(): InstanceType<typeof SlateStore> {
  return new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
}

function managerWithSessions(
  sessions: FakeSession[],
  config: ConstructorParameters<typeof ThreadManager>[1] = {},
): InstanceType<typeof ThreadManager> {
  const manager = new ThreadManager(store(), config);
  const internals = manager as unknown as {
    live: Map<string, FakeSession>;
    openWorkerFor(args: { thread: { id: string } }): Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
  };
  let next = 0;
  internals.openWorkerFor = async ({ thread }) => {
    const session = sessions[next++];
    assert.ok(session, "a scripted worker session must exist for every dispatch");
    internals.live.set(thread.id, session);
    return { session, baseline: NO_SESSION_BASELINE };
  };
  return manager;
}

function temporaryProject(t: test.TestContext): string {
  const cwd = mkdtempSync(join(tmpdir(), "slate-usage-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function completeResponse(usage: TokenUsage, stopReason = "stop") {
  return {
    stopReason,
    errorMessage: stopReason === "error" ? "transient provider failure" : undefined,
    content: stopReason === "error" ? [] : [{ type: "text", text: "## Intent\ncompressed" }],
    usage: { ...usage },
  };
}

test("model authorization failures are sanitized before thread creation", async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const ctx = context(cwd, [ran]);
  ctx.modelRegistry.hasConfiguredAuth = () => { throw new Error("auth backend\nfailed"); };
  const manager = managerWithSessions([]);
  await assert.rejects(
    manager.dispatch({ task: "validate auth", type: "general", model: "test/worker" }, ctx, undefined),
    /could not be validated: auth backendfailed/,
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(internalStore.threads.size, 0);
});

test("pre-start aborts leave no thread or episode record", async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");

  const internal = fakeSession(async () => {});
  internal.setModel = async () => { throw new Error("switch unavailable"); };
  const internalManager = managerWithSessions([internal]);
  await assert.rejects(
    internalManager.dispatch({ task: "internal abort", type: "general", model: "test/worker" }, context(cwd, [ran]), undefined),
    /switching its worker session/,
  );
  const internalStore = (internalManager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(internalStore.threads.size, 0);
  assert.equal(internalStore.episodes.size, 0);

  const controller = new AbortController();
  const cancelled = fakeSession(async () => {});
  cancelled.setModel = async (next) => {
    cancelled.model = next;
    controller.abort();
  };
  const cancelledManager = managerWithSessions([cancelled]);
  await assert.rejects(
    cancelledManager.dispatch({ task: "caller abort", type: "general", model: "test/worker" }, context(cwd, [ran]), controller.signal),
    /aborted by the orchestrator/,
  );
  const cancelledStore = (cancelledManager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(cancelledStore.threads.size, 0);
  assert.equal(cancelledStore.episodes.size, 0);
});

test("fixed failure episodes use bounded fallbacks and report write failures", (t) => {
  const cwd = temporaryProject(t);
  const result = writeFailedEpisode({
    ctx: { cwd }, episodeId: "t9.e1", threadId: "", threadName: " \n ",
    task: "\t", diagnostics: "", workerCostUsd: Number.NaN,
  });
  const text = readFileSync(result.file, "utf8");
  assert.match(text, /thread \(unknown\) \(\(unknown\)\)/);
  assert.match(text, /> task: \(no task recorded\)/);
  assert.match(text, /> error: the worker action failed/);
  assert.match(text, /> model: \(unknown\)/);
  assert.match(text, /> cost: USD 0\.000000/);
  assert.throws(
    () => writeFailedEpisode({
      ctx: { cwd }, episodeId: "../bad", threadId: "t9", threadName: "bad",
      task: "bad", diagnostics: "bad", workerCostUsd: 0,
    }),
    /episode persistence failed/,
  );
});

test("failed actions compress a worker response into one failed episode", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession((current) => {
    const message = {
      role: "assistant", stopReason: "error", errorMessage: "provider stopped",
      content: [{ type: "text", text: "partial work to preserve" }],
      usage: { input: 5, output: 2, cost: { total: 0.125 } },
    };
    current.messages.push(message);
    current.emit({ type: "message_end", message });
  }, ran);
  let compressionCalls = 0;
  piAiCompatStub.complete = async (...args: unknown[]) => {
    compressionCalls++;
    assert.match(JSON.stringify(args[1]), /partial work to preserve/);
    return completeResponse({ input: 3, output: 1, cost: { total: 0.01 } });
  };
  const manager = managerWithSessions([session], { episodeModel: "test/compressor" });
  const result = await manager.dispatch(
    { task: "record failed work", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  const episode = internalStore.episodes.get("t1.e1");
  assert.equal(compressionCalls, 1);
  assert.equal(result.episode.id, "t1.e1");
  assert.equal(result.episodeText, readFileSync(result.episode.file, "utf8"));
  assert.equal(episode?.status, "failed");
  assert.equal(episode?.model, "test/worker");
  assert.equal(episode?.workerCostUsd, 0.125);
  assert.equal(episode?.compressorCostUsd, 0.01);
  assert.equal(internalStore.threads.get("t1")?.status, "failed");
  assert.equal(internalStore.threads.get("t1")?.episodeId, "t1.e1");
  const text = readFileSync(episode!.file, "utf8");
  assert.match(text, /STATUS: FAILED/);
  assert.match(text, /## Intent\ncompressed/);
  assert.doesNotMatch(text, /> status: FAILED/);
});

test("a throwing initial progress callback still leaves a terminal failed action", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const manager = managerWithSessions([]);
  const result = await manager.dispatch(
    { task: "survive progress failure", type: "general" },
    context(cwd),
    undefined,
    () => { throw new Error("progress sink failed"); },
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(result.episode.status, "failed");
  assert.equal(internalStore.threads.get("t1")?.status, "failed");
  assert.equal(internalStore.threads.get("t1")?.episodeId, "t1.e1");
  assert.match(internalStore.threads.get("t1")?.outcomeReason ?? "", /progress sink failed/);
});

test("failed actions without a worker response write one fixed episode without compression", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession(async () => {
    throw new Error("provider stopped before response");
  }, ran);
  let compressionCalls = 0;
  piAiCompatStub.complete = async () => {
    compressionCalls++;
    throw new Error("the no-response path must not call compression");
  };
  const manager = managerWithSessions([session], { episodeModel: "test/compressor" });
  const result = await manager.dispatch(
    { task: "record empty failure", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  const episode = internalStore.episodes.get("t1.e1");
  assert.equal(compressionCalls, 0);
  assert.equal(result.episode.status, "failed");
  assert.equal(result.episodeText, readFileSync(result.episode.file, "utf8"));
  assert.equal(episode?.status, "failed");
  assert.equal(episode?.model, "test/worker");
  assert.equal(internalStore.episodes.size, 1);
  assert.equal(internalStore.threads.get("t1")?.episodeId, "t1.e1");
  const text = readFileSync(episode!.file, "utf8");
  assert.match(text, /STATUS: FAILED/);
  assert.match(text, /> task: record empty failure/);
  assert.match(text, /> status: FAILED/);
  assert.match(text, /> error: provider stopped before response/);
  assert.match(text, /> model: test\/worker/);
  assert.match(text, /> cost: USD 0\.000000/);
  assert.match(text, /failed before the worker produced a response/);
});

test("an empty output block does not trigger paid failure compression", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const compressor = model("test", "compressor");
  const session = fakeSession((current) => {
    const message = assistant({}, "");
    current.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_start" } });
    throw new Error("provider stopped after opening an empty block");
  });
  let compressionCalls = 0;
  piAiCompatStub.complete = async () => {
    compressionCalls++;
    return completeResponse({});
  };
  const result = await managerWithSessions([session], { episodeModel: "test/compressor" }).dispatch(
    { task: "do not summarize emptiness", type: "general" },
    context(cwd, [compressor]),
    undefined,
  );
  assert.equal(compressionCalls, 0);
  assert.match(result.episodeText, /failed before the worker produced a response/);
});

test("a recorded zero cost triggers failure compression for empty output", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const compressor = model("test", "compressor");
  const session = fakeSession((current) => {
    const message = {
      role: "assistant", stopReason: "error", errorMessage: "provider stopped",
      content: [{ type: "text", text: "" }],
      usage: { cost: { total: 0 } },
    };
    current.messages.push(message);
    current.emit({ type: "message_end", message });
  });
  let compressionCalls = 0;
  piAiCompatStub.complete = async () => {
    compressionCalls++;
    return completeResponse({ cost: { total: 0 } });
  };
  const result = await managerWithSessions([session], { episodeModel: "test/compressor" }).dispatch(
    { task: "preserve zero-cost evidence", type: "general" },
    context(cwd, [compressor]),
    undefined,
  );
  assert.equal(compressionCalls, 1);
  assert.equal(result.episode.status, "failed");
  assert.equal(result.episode.workerCostUsd, 0);
  assert.doesNotMatch(result.episodeText, /failed before the worker produced a response/);
});

test("response evidence survives a rewritten worker message list", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession((current) => {
    const message = {
      role: "assistant", stopReason: "error", errorMessage: "provider stopped",
      content: [{ type: "text", text: "partial work" }],
      usage: { input: 2, output: 1, cost: { total: 0.05 } },
    };
    current.messages.push(message);
    current.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "partial" } });
    current.messages.length = 0;
    throw new Error("host rewrote the transcript");
  }, ran);
  let compressionCalls = 0;
  piAiCompatStub.complete = async () => {
    compressionCalls++;
    return completeResponse({ input: 1, output: 1, cost: { total: 0.01 } });
  };
  const result = await managerWithSessions([session], { episodeModel: "test/compressor" }).dispatch(
    { task: "preserve rewritten response", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  assert.equal(compressionCalls, 1);
  assert.equal(result.episode.status, "failed");
  assert.doesNotMatch(result.episodeText, /failed before the worker produced a response/);
});

test("fixed episode write failure leaves a terminal reason and no orphan episode", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  mkdirSync(join(cwd, ".pi", "slate", "episodes", "t1.e1.md"), { recursive: true });
  const session = fakeSession(async () => { throw new Error("provider stopped before response"); });
  const manager = managerWithSessions([session]);
  await assert.rejects(
    manager.dispatch({ task: "fail durably", type: "general" }, context(cwd), undefined),
    (error: Error) => {
      assert.match(error.message, /provider stopped before response/);
      assert.match(error.message, /could not store episode t1\.e1/);
      assert.match(error.message, /not a regular file/);
      assert.doesNotMatch(error.message, /slate episode persistence failed/);
      return true;
    },
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  const thread = internalStore.threads.get("t1");
  assert.equal(thread?.status, "failed");
  assert.match(thread?.outcomeReason ?? "", /provider stopped before response/);
  assert.match(thread?.outcomeReason ?? "", /persistence failed/);
  assert.match(thread?.outcomeReason ?? "", /not a regular file/);
  assert.equal(thread?.episodeId, undefined);
  assert.equal(internalStore.episodes.size, 0);
});

test("fixed failure reports a thread-record save failure", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession(async () => { throw new Error("worker failed without output"); });
  const manager = managerWithSessions([session]);
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  const originalSave = internalStore.save.bind(internalStore);
  internalStore.save = () => {
    if (internalStore.episodes.size > 0) throw new Error("snapshot storage unavailable");
    originalSave();
  };
  await assert.rejects(
    manager.dispatch({ task: "persist fixed result", type: "general" }, context(cwd), undefined),
    /stored episode t1\.e1, but could not save its thread record: snapshot storage unavailable/,
  );
  assert.equal(internalStore.threads.get("t1")?.status, "failed");
  assert.equal(internalStore.threads.get("t1")?.episodeId, "t1.e1");
});

test("worker episode usage preserves all quantities and accumulates several turns", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession(successfulPrompt([
    { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: 0 } },
    { input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: { total: 0 } },
  ]));
  const result = await managerWithSessions([session]).dispatch({ task: "account worker usage", type: "general" }, context(cwd), undefined);

  assert.deepEqual(
    {
      input: result.episode.input,
      output: result.episode.output,
      cacheRead: result.episode.cacheRead,
      cacheWrite: result.episode.cacheWrite,
    },
    { input: 13, output: 16, cacheRead: 22, cacheWrite: 26 },
  );
  assert.equal(result.episode.workerCostUsd, 0);
});

test("worker episode usage distinguishes an absent quantity from reported zero", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession(successfulPrompt([{ input: 0, output: 4, cacheRead: 0, cost: { total: 0 } }]));
  const result = await managerWithSessions([session]).dispatch({ task: "preserve absence", type: "general" }, context(cwd), undefined);

  assert.equal(result.episode.input, 0);
  assert.equal(result.episode.cacheRead, 0);
  assert.equal(Object.hasOwn(result.episode, "input"), true);
  assert.equal(Object.hasOwn(result.episode, "cacheRead"), true);
  assert.equal(Object.hasOwn(result.episode, "cacheWrite"), false);
  assert.equal(result.episode.cacheWrite, undefined);
  assert.equal(result.episode.workerCostUsd, 0);
});

test("worker episode cost stays absent when no message reports dollars", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1 }]));
  const result = await managerWithSessions([session]).dispatch({ task: "preserve missing worker cost", type: "general" }, context(cwd), undefined);

  assert.equal(Object.hasOwn(result.episode, "workerCostUsd"), false);
  assert.equal(result.episode.workerCostUsd, undefined);
});

test("compressor usage persists all quantities and accumulates a billed failover", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const primary = model("test", "primary");
  const fallback = model("test", "fallback");
  const responses = [
    completeResponse({ input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: 0.1 } }, "error"),
    completeResponse({ input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: { total: 0.2 } }),
  ];
  const calls: Array<{ model: unknown; options: unknown }> = [];
  piAiCompatStub.complete = async (...args: unknown[]) => {
    calls.push({ model: args[0], options: args[2] });
    const response = responses.shift();
    assert.ok(response, "compression must make only the scripted calls");
    return response;
  };
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const manager = managerWithSessions([session], {
    episodeModel: "test/primary",
    modelFailover: { "test/primary": "test/fallback" },
  });
  const controller = new AbortController();
  const result = await manager.dispatch({ task: "compress with failover", type: "general" }, context(cwd, [primary, fallback]), controller.signal);

  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0]?.model, primary);
  assert.strictEqual(calls[1]?.model, fallback);
  assert.notStrictEqual(calls[1]?.model, primary);
  assert.deepEqual(
    calls.map((call) => call.options),
    [
      { apiKey: "test-key", headers: undefined, env: undefined, maxTokens: 4096, signal: controller.signal },
      { apiKey: "test-key", headers: undefined, env: undefined, maxTokens: 4096, signal: controller.signal },
    ],
  );
  assert.deepEqual(result.episode.compressorUsage, {
    input: 13,
    output: 16,
    cacheRead: 22,
    cacheWrite: 26,
  });
  assert.equal(result.episode.compressorCostUsd, 0.1 + 0.2);
  assert.equal(responses.length, 0);
});

test("compressor usage is absent when no quantity was reported", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const compressor = model("test", "compressor");
  piAiCompatStub.complete = async () => completeResponse({ cost: { total: 0 } });
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const result = await managerWithSessions([session], { episodeModel: "test/compressor" }).dispatch(
    { task: "compress without usage", type: "general" },
    context(cwd, [compressor]),
    undefined,
  );

  assert.equal(Object.hasOwn(result.episode, "compressorUsage"), false);
  assert.equal(result.episode.compressorUsage, undefined);
  assert.equal(result.episode.compressorCostUsd, 0);
});

test("compressor cost stays absent when the call reports usage without dollars", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const compressor = model("test", "compressor");
  piAiCompatStub.complete = async () => completeResponse({ input: 3, output: 2 });
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const result = await managerWithSessions([session], { episodeModel: "test/compressor" }).dispatch(
    { task: "compress without reported dollars", type: "general" },
    context(cwd, [compressor]),
    undefined,
  );

  assert.equal(Object.hasOwn(result.episode, "compressorCostUsd"), false);
  assert.equal(result.episode.compressorCostUsd, undefined);
});

test("compaction usage counts one event once and does not contaminate the next dispatch", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const compactionEvent = {
    type: "compaction_end",
    result: { usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: 0.25 } } },
  };
  const first = fakeSession((session) => {
    session.emit(compactionEvent);
    session.emit(compactionEvent);
    return successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }])(session);
  });
  const second = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const manager = managerWithSessions([first, second]);

  const firstResult = await manager.dispatch({ task: "dispatch with compaction", type: "general" }, context(cwd), undefined);
  const secondResult = await manager.dispatch({ task: "dispatch without compaction", type: "general" }, context(cwd), undefined);

  assert.deepEqual(firstResult.episode.compactionUsage, { input: 2, output: 3, cacheRead: 5, cacheWrite: 7 });
  assert.equal(firstResult.episode.compactionCostUsd, 0.25);
  assert.equal(Object.hasOwn(secondResult.episode, "compactionUsage"), false);
  assert.equal(secondResult.episode.compactionUsage, undefined);
  assert.equal(Object.hasOwn(secondResult.episode, "compactionCostUsd"), false);
});

test("dispatch subscriptions are removed after normal completion and error", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const normal = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const failed = fakeSession(async () => {
    throw new Error("scripted prompt failure");
  });
  const manager = managerWithSessions([normal, failed]);

  await manager.dispatch({ task: "normal teardown", type: "general" }, context(cwd), undefined);
  const failedResult = await manager.dispatch({ task: "error teardown", type: "general" }, context(cwd), undefined);
  assert.equal(failedResult.episode.status, "failed");

  assert.equal(normal.listenerCount(), 0);
  assert.equal(failed.listenerCount(), 0);
  const failedThread = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store.threads.get("t2");
  assert.equal(failedThread?.status, "failed");
  assert.match(failedThread?.outcomeReason ?? "", /scripted prompt failure/);
  assert.equal(failedThread?.episodeId, "t2.e1");
});

test("caller abort and manager disposal record cancellation without an episode", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const controller = new AbortController();
  const aborted = fakeSession(async () => {
    controller.abort();
    throw new Error("prompt stopped after abort");
  });
  const callerManager = managerWithSessions([aborted]);
  await assert.rejects(
    callerManager.dispatch({ task: "caller cancellation", type: "general" }, context(cwd), controller.signal),
    /cancelled by the caller.*No episode was recorded/,
  );
  assert.equal(aborted.listenerCount(), 0);
  const callerStore = (callerManager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(callerStore.threads.get("t1")?.status, "cancelled");
  assert.equal(callerStore.threads.get("t1")?.episodeId, undefined);
  assert.equal(callerStore.episodes.size, 0);

  let disposalManager: InstanceType<typeof ThreadManager>;
  const disposed = fakeSession(async () => {
    disposalManager.disposeAll();
    throw new Error("disposed session stopped");
  });
  disposalManager = managerWithSessions([disposed]);
  await assert.rejects(
    disposalManager.dispatch({ task: "session disposal", type: "general" }, context(cwd), undefined),
    /cancelled during session teardown.*No episode was recorded/,
  );
  const disposalStore = (disposalManager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(disposalStore.threads.get("t1")?.status, "cancelled");
  assert.equal(disposalStore.threads.get("t1")?.episodeId, undefined);
  assert.equal(disposalStore.episodes.size, 0);
});

test("snapshot sanitizer loads old records without accounting fields", () => {
  const repairs: string[] = [];
  const record = sanitizeEpisodeRecord(
    { id: "t1.e1", threadId: "t1", task: "legacy", status: "ok", file: "/tmp/legacy.md", createdAt: 1 },
    repairs,
  );

  assert.ok(record);
  assert.equal(record.task, "legacy");
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    assert.equal(Object.hasOwn(record, field), false, field);
  }
  assert.equal(Object.hasOwn(record, "workerCostUsd"), false);
  assert.equal(Object.hasOwn(record, "compressorUsage"), false);
  assert.equal(Object.hasOwn(record, "compressorCostUsd"), false);
  assert.equal(Object.hasOwn(record, "compactionUsage"), false);
  assert.equal(Object.hasOwn(record, "compactionCostUsd"), false);
  assert.deepEqual(repairs, []);
});

test("snapshot sanitizer rejects noncanonical and mismatched episode ids", () => {
  for (const candidate of [
    { id: "t1.e2", threadId: "t1" },
    { id: "t2.e1", threadId: "t1" },
    { id: "legacy.e1", threadId: "legacy" },
  ]) {
    const repairs: string[] = [];
    const record = sanitizeEpisodeRecord({ ...candidate, task: "bad", status: "ok", file: "/tmp/bad.md" }, repairs);
    assert.equal(record, undefined);
    assert.match(repairs.join("\n"), /canonical \.e1 id/);
  }
});

test("snapshot sanitizer rejects negative and fractional token quantities with repairs", () => {
  const repairs: string[] = [];
  const record = sanitizeEpisodeRecord(
    {
      id: "t1.e1",
      threadId: "t1",
      task: "damaged usage",
      status: "ok",
      file: "/tmp/t1.e3.md",
      input: -1000,
      output: 1.5,
      cacheRead: 0,
      compressorUsage: { input: 5, cacheRead: -2 },
      compactionUsage: { output: -3, cacheWrite: 0 },
      createdAt: 9,
    },
    repairs,
  );

  assert.ok(record);
  assert.equal(Object.hasOwn(record, "input"), false);
  assert.equal(Object.hasOwn(record, "output"), false);
  assert.equal(record.input, undefined);
  assert.equal(record.output, undefined);
  assert.equal(record.cacheRead, 0);
  assert.deepEqual(record.compressorUsage, { input: 5 });
  assert.deepEqual(record.compactionUsage, { cacheWrite: 0 });
  assert.match(repairs.join("\n"), /ignoring input \(number\)/);
  assert.match(repairs.join("\n"), /ignoring output \(number\)/);
  assert.match(repairs.join("\n"), /compressorUsage\.cacheRead \(number\)/);
  assert.match(repairs.join("\n"), /compactionUsage\.output \(number\)/);
});

test("snapshot sanitizer restores fractional and zero dollar costs while preserving absence", () => {
  const repairs: string[] = [];
  const restored = sanitizeEpisodeRecord(
    {
      id: "t4.e1",
      threadId: "t4",
      task: "restore costs",
      status: "ok",
      file: "/tmp/costs.md",
      workerCostUsd: 0.0163,
      compressorCostUsd: 0,
      compactionCostUsd: 1.25,
      createdAt: 4,
    },
    repairs,
  );
  const absent = sanitizeEpisodeRecord(
    { id: "t5.e1", threadId: "t5", task: "absent costs", status: "ok", file: "/tmp/absent.md", createdAt: 5 },
    repairs,
  );

  assert.ok(restored);
  assert.equal(restored.workerCostUsd, 0.0163);
  assert.equal(restored.compressorCostUsd, 0);
  assert.equal(restored.compactionCostUsd, 1.25);
  assert.ok(absent);
  assert.equal(Object.hasOwn(absent, "workerCostUsd"), false);
  assert.equal(Object.hasOwn(absent, "compressorCostUsd"), false);
  assert.equal(Object.hasOwn(absent, "compactionCostUsd"), false);
  assert.deepEqual(repairs, []);
});

test("snapshot sanitizer repairs malformed usage without destroying valid record data", () => {
  const repairs: string[] = [];
  const record = sanitizeEpisodeRecord(
    {
      id: "t2.e1",
      threadId: "t2",
      task: "needed history",
      status: "failed",
      file: "/tmp/needed.md",
      model: "test/model",
      input: 23,
      cacheWrite: "invalid",
      workerCostUsd: -1,
      compressorUsage: { input: 5, output: "invalid", cacheRead: 0 },
      compressorCostUsd: Number.NaN,
      compactionUsage: { input: null, output: 7, cacheWrite: 0 },
      compactionCostUsd: "invalid",
      createdAt: 9,
    },
    repairs,
  );

  assert.ok(record);
  assert.equal(record.id, "t2.e1");
  assert.equal(record.task, "needed history");
  assert.equal(record.status, "failed");
  assert.equal(record.model, "test/model");
  assert.equal(record.input, 23);
  assert.equal(Object.hasOwn(record, "cacheWrite"), false);
  assert.equal(Object.hasOwn(record, "workerCostUsd"), false);
  assert.deepEqual(record.compressorUsage, { input: 5, cacheRead: 0 });
  assert.equal(Object.hasOwn(record, "compressorCostUsd"), false);
  assert.deepEqual(record.compactionUsage, { output: 7, cacheWrite: 0 });
  assert.equal(Object.hasOwn(record, "compactionCostUsd"), false);
  assert.match(repairs.join("\n"), /ignoring cacheWrite/);
  assert.match(repairs.join("\n"), /ignoring workerCostUsd/);
  assert.match(repairs.join("\n"), /ignoring compressorCostUsd/);
  assert.match(repairs.join("\n"), /ignoring compactionCostUsd/);
  assert.match(repairs.join("\n"), /compressorUsage\.output/);
  assert.match(repairs.join("\n"), /compactionUsage\.input/);
});
