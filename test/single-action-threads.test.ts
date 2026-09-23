const TEST_ROUTE = { model: "fixture", reason: "test fixture" } as const;

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NO_SESSION_BASELINE, createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { registerSlateTools } from "../extension/tools.ts";
import { sanitizeThreadRecord, SLATE_STATE_FORMAT, SlateStore, type EpisodeRecord, type ThreadRecord } from "../extension/state.ts";
import { MAX_CONTEXT_EPISODES, messagesForCompression, ThreadManager, type DispatchOptions, type DispatchResult } from "../extension/threads.ts";
import { WORKER_REQUEST_CONTRACT_ERROR, type WorkerRequestContract } from "../extension/worker.ts";
import { bindFakeWorkerRequest } from "./worker-request-contract-fixture.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fixtureRuntime() {
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
  return Object.freeze({ ...runtime, validateRoute: async () => ({ ok: true } as const) });
}

function recoveryRuntime() {
  return createLogicalRuntime({
    trusted: true,
    projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "test", providers: { test: "worker", backup: "worker-2" } }] } } },
  });
}

function workerModel(provider: string, id: string) {
  return {
    provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
    maxTokens: 100, thinkingLevelMap: { max: "max" },
  };
}

function recoveryContext(root: string, state: { registry: boolean; auth: boolean }): ExtensionContext {
  const models = new Map([
    ["test/worker", workerModel("test", "worker")],
    ["backup/worker-2", workerModel("backup", "worker-2")],
  ]);
  return {
    cwd: root, hasUI: false,
    modelRegistry: {
      find(provider: string, id: string) { return state.registry ? models.get(`${provider}/${id}`) : undefined; },
      async getApiKeyAndHeaders() { return state.auth ? { ok: true, apiKey: "test" } : { ok: false, reason: "missing" }; },
      hasConfiguredAuth() { return state.auth; },
      async getAvailable() { return [...models.values()]; },
    },
  } as unknown as ExtensionContext;
}

function managerHarness(root: string) {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
  const prompts: string[] = [];
  const internal = manager as unknown as {
    runDispatch(
      thread: ThreadRecord,
      opts: DispatchOptions,
      prompt: string,
      ctx: ExtensionContext,
    ): Promise<DispatchResult>;
  };
  internal.runDispatch = async (thread, opts, prompt) => {
    prompts.push(prompt);
    const id = `${thread.id}.e1`;
    const episode: EpisodeRecord = {
      id,
      threadId: thread.id,
      task: opts.task,
      status: "ok",
      file: join(root, ".pi", "slate", "episodes", `${id}.md`),
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
      createdAt: 1,
    };
    thread.episodeId = id;
    thread.status = "successful";
    return {
      episodeText: "episode",
      episode,
      thread,
      usage: { turns: 1, input: 0, output: 0, cost: 0, contextTokens: 0 },
      warnings: [],
    };
  };
  return { manager, store, prompts };
}

/**
 * The inverse durable contract of an action that recorded nothing: the restored
 * durable snapshot has no episode and no thread reference, the production episode
 * tool refuses that id, and a later action cannot load it as context.
 */
async function assertNoDurableEpisodeConsumers(
  ctx: ExtensionContext,
  episodeId: string,
  snapshot: unknown,
): Promise<void> {
  const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  restored.adoptSnapshot(snapshot as Parameters<SlateStore["adoptSnapshot"]>[0], ctx);
  assert.equal(restored.episodes.has(episodeId), false, `${episodeId}: restored state has no episode`);
  assert.equal(
    restored.threads.get(episodeId.split(".")[0]!)?.episodeId,
    undefined,
    `${episodeId}: restored thread has no episode reference`,
  );
  let episodeTool: { execute(...args: unknown[]): Promise<unknown> } | undefined;
  registerSlateTools(
    { registerTool(tool: { name: string }) { if (tool.name === "episode") episodeTool = tool as unknown as typeof episodeTool; } } as unknown as ExtensionAPI,
    restored,
    () => new ThreadManager(restored, {}, undefined, fixtureRuntime()),
  );
  assert.ok(episodeTool, `${episodeId}: production episode tool registered`);
  await assert.rejects(
    episodeTool.execute("call", { id: episodeId }, undefined, undefined, ctx),
    /Unknown episode/,
  );
  const later = new ThreadManager(restored, {}, undefined, fixtureRuntime());
  const before = restored.threads.size;
  await assert.rejects(
    later.dispatch(
      { ...TEST_ROUTE, task: "inverse durable consumer", type: "general", contextEpisodeIds: [episodeId] },
      ctx,
      undefined,
    ),
    /Unknown context episode/,
  );
  assert.equal(restored.threads.size, before, `${episodeId}: later context rejection allocates no thread`);
}

test("every accepted action creates a distinct single-action thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-single-action-"));
  try {
    const { manager, store } = managerHarness(root);
    const ctx = { cwd: root, modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined, hasConfiguredAuth: () => true, getAvailable: async () => [] } } as unknown as ExtensionContext;
    const first = await manager.dispatch({ ...TEST_ROUTE, name: "first", type: "general", task: "one" }, ctx, undefined);
    const second = await manager.dispatch({ ...TEST_ROUTE, name: "second", type: "reviewer", task: "two" }, ctx, undefined);
    assert.equal(first.thread.id, "t1");
    assert.equal(second.thread.id, "t2");
    assert.equal(store.threads.size, 2);
    assert.equal(first.thread.episodeId, "t1.e1");
    assert.equal(second.thread.episodeId, "t2.e1");

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an action cancelled before its worker call leaves no record", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-cancelled-action-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "cancel me" }, { cwd: root, modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined, hasConfiguredAuth: () => true, getAvailable: async () => [] } } as unknown as ExtensionContext, controller.signal),
      /cancelled before the action started/,
    );
    assert.equal(store.threads.size, 0);
    assert.equal(store.episodes.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("episode references are bounded, deduplicated, ordered, and loaded before creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-context-"));
  try {
    const episodes = join(root, ".pi", "slate", "episodes");
    mkdirSync(episodes, { recursive: true });
    const { manager, store, prompts } = managerHarness(root);
    for (const [id, text] of [["t8.e1", "FIRST"], ["t9.e1", "SECOND"]] as const) {
      const file = join(episodes, `${id}.md`);
      writeFileSync(file, text);
      store.episodes.set(id, { id, threadId: id.split(".")[0]!, task: text, status: "ok", file, createdAt: 1 });
    }
    const ctx = { cwd: root, modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined, hasConfiguredAuth: () => true, getAvailable: async () => [] } } as unknown as ExtensionContext;
    await manager.dispatch({ ...TEST_ROUTE, type: "researcher", task: "follow up", contextEpisodeIds: ["t9.e1", "t8.e1", "t9.e1"] }, ctx, undefined);
    assert.ok(prompts[0]!.indexOf("SECOND") < prompts[0]!.indexOf("FIRST"));
    assert.equal(prompts[0]!.match(/SECOND/g)?.length, 1);

    const before = store.threads.size;
    await assert.rejects(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "bad", contextEpisodeIds: Array(MAX_CONTEXT_EPISODES + 1).fill("t8.e1") }, ctx, undefined),
      /at most 32/,
    );
    await assert.rejects(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "bad", contextEpisodeIds: "t8.e1" }, ctx, undefined),
      /context must be a list/,
    );
    await assert.rejects(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "bad", contextEpisodeIds: [7] }, ctx, undefined),
      /context must be a list/,
    );
    await assert.rejects(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "bad", contextEpisodeIds: ["missing.e1"] }, ctx, undefined),
      /Unknown context episode/,
    );
    assert.equal(store.threads.size, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unusable requested model is rejected before thread creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-model-validation-"));
  try {
    const { manager, store } = managerHarness(root);
    const ctx = {
      cwd: root,
      modelRegistry: {
        find() { return undefined; },
        hasConfiguredAuth() { return false; },
      },
    } as unknown as ExtensionContext;
    await assert.rejects(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "must not persist", model: "missing/model" }, ctx, undefined),
      /not available|credentials/,
    );
    assert.equal(store.threads.size, 0);
    assert.equal(store.episodes.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task validation runs before thread creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-action-validation-"));
  try {
    const { manager, store } = managerHarness(root);
    const ctx = { cwd: root, modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined, hasConfiguredAuth: () => true, getAvailable: async () => [] } } as unknown as ExtensionContext;
    await assert.rejects(manager.dispatch({ ...TEST_ROUTE, type: "general", task: "" }, ctx, undefined), /non-empty/);
    await assert.rejects(manager.dispatch({ ...TEST_ROUTE, type: "general", task: 7 as unknown as string }, ctx, undefined), /non-empty/);
    assert.equal(store.threads.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The paused orchestrator saves the project state through a worker, so a
// dispatch must COMPLETE while orchestratorMode and paused are both true.
// Restoring the removed pause guard in ThreadManager.dispatch makes this test
// fail at the first dispatch call, which is the counterfactual for the guard.
test("a paused orchestrator dispatch runs a worker and returns its episode", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-paused-dispatch-"));
  try {
    const { manager, store, prompts } = managerHarness(root);
    const ctx = { cwd: root, modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined, hasConfiguredAuth: () => true, getAvailable: async () => [] } } as unknown as ExtensionContext;
    store.orchestratorMode = true;
    store.paused = true;

    const saved = await manager.dispatch(
      { ...TEST_ROUTE, name: "state save", type: "general", task: "save the project state in the research log" },
      ctx,
      undefined,
    );

    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /save the project state in the research log/);
    assert.equal(saved.episodeText, "episode");
    assert.equal(saved.episode.id, "t1.e1");
    assert.equal(saved.episode.threadId, "t1");
    assert.equal(saved.episode.status, "ok");
    assert.equal(saved.episode.task, "save the project state in the research log");
    assert.equal(saved.thread.id, "t1");
    assert.equal(saved.thread.name, "state save");
    assert.equal(saved.thread.status, "successful");
    assert.equal(saved.thread.episodeId, "t1.e1");
    assert.equal(store.threads.size, 1);
    assert.equal(store.threads.get("t1")?.episodeId, "t1.e1");

    // The dispatch neither clears the pause nor leaves orchestrator mode.
    assert.equal(store.paused, true);
    assert.equal(store.orchestratorMode, true);

    // A second paused dispatch still works, and argument failures are still
    // reported while both flags are true.
    const second = await manager.dispatch({ ...TEST_ROUTE, type: "general", task: "verify the saved state" }, ctx, undefined);
    assert.equal(second.thread.id, "t2");
    assert.equal(second.episode.id, "t2.e1");
    await assert.rejects(manager.dispatch({ ...TEST_ROUTE, type: "general", task: "   " }, ctx, undefined), /non-empty/);
    await assert.rejects(
      manager.dispatch({ ...TEST_ROUTE, type: "nonsense", task: "bad type" } as unknown as DispatchOptions, ctx, undefined),
      /type/,
    );
    assert.equal(store.threads.size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit dispatch fields reject before thread allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-required-route-"));
  try {
    const { manager, store } = managerHarness(root);
    const ctx = { cwd: root, modelRegistry: { find: () => ({ provider: "test", id: "worker" }), hasConfiguredAuth: () => true } } as unknown as ExtensionContext;
    for (const opts of [
      { task: "x", type: "general", reason: "why" },
      { task: "x", type: "general", model: 7, reason: "why" },
      { task: "x", type: "general", model: "   ", reason: "why" },
      { task: "x", type: "general", model: "fixture" },
      { task: "x", type: "general", model: "fixture", reason: "" },
      { task: "x", type: "general", model: "fixture", reason: "   " },
      { task: "x", type: "general", model: "fixture", reason: "\u0000\u001f" },
      { task: "x", type: "general", model: "fixture", reason: "\u200b\u2060" },
      { task: "x", type: "general", model: "fixture", reason: "x".repeat(201) },
    ]) await assert.rejects(manager.dispatch(opts as DispatchOptions, ctx, undefined), /model must|reason must/);
    assert.equal(store.threads.size, 0);

    const boundary = await manager.dispatch({ ...TEST_ROUTE, type: "general", task: "boundary", reason: "x".repeat(200) }, ctx, undefined);
    assert.equal(boundary.episode.reason, "x".repeat(200));
    const cleaned = await manager.dispatch({ ...TEST_ROUTE, type: "general", task: "cleaned", reason: " visible\u2028text\u2029\u200b " }, ctx, undefined);
    assert.equal(cleaned.episode.reason, "visible text");

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Structural net for the same rule: a re-added pause rejection in threads.ts
// fails here even if a future fixture stops setting both flags.
test("ThreadManager carries no pause rejection", () => {
  const source = readFileSync(new URL("../extension/threads.ts", import.meta.url), "utf8");
  assert.equal(/this\.store\.paused/.test(source), false);
  assert.equal(source.includes("Slate is paused for handoff"), false);
});
test("removed fields are absent from the schema and rejected before creation", async () => {
  let threadTool: any;
  const pi = { registerTool(tool: any) { if (tool.name === "thread") threadTool = tool; } } as ExtensionAPI;
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
  registerSlateTools(pi, store, () => manager);
  assert.ok(threadTool);
  assert.equal(Object.hasOwn(threadTool.parameters.properties, "thread"), false);
  assert.equal(Object.hasOwn(threadTool.parameters.properties, "freshContext"), false);
  assert.equal(Object.hasOwn(threadTool.parameters.properties, "effort"), false);
  const ctx = { cwd: process.cwd() } as ExtensionContext;
  await assert.rejects(threadTool.execute("x", { ...TEST_ROUTE, type: "general", task: "x", thread: "t1" }, undefined, undefined, ctx), /field was removed/);
  await assert.rejects(threadTool.execute("x", { ...TEST_ROUTE, type: "general", task: "x", freshContext: [] }, undefined, undefined, ctx), /field was removed/);
  await assert.rejects(threadTool.execute("x", { ...TEST_ROUTE, effort: "low", type: "general", task: "x" }, undefined, undefined, ctx), /effort.*removed/);
  await assert.rejects(manager.dispatch({ ...TEST_ROUTE, threadId: "t1", type: "general", task: "x" }, ctx, undefined), /field was removed/);
  await assert.rejects(manager.dispatch({ ...TEST_ROUTE, freshContext: [], type: "general", task: "x" }, ctx, undefined), /field was removed/);
  assert.equal(store.threads.size, 0);
});

test("logical worker recovery retains tool results and records logical and physical facts", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-logical-worker-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const runtime = createLogicalRuntime({
      trusted: true,
      projectConfig: { router: { models: { replace: [{ model: "luna-6", providers: { test: "worker", backup: "worker-2" }, preferredProvider: "test" }] } } },
    });
    const manager = new ThreadManager(store, {}, undefined, runtime);
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const prompts: string[] = [];
    const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "retained" }] };
    const session = {
      messages: [] as unknown[],
      model: { provider: "test", id: "worker", contextWindow: 10_000 },
      thinkingLevel: "max",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(text: string) {
        prompts.push(text);
        if (prompts.length === 1) {
          const failed = { role: "assistant", stopReason: "error", errorMessage: "temporary timeout", content: [], usage: {} };
          session.messages.push(toolResult, failed);
          for (const attempt of [1, 2]) {
            for (const listener of listeners) listener({ type: "agent_end", willRetry: true });
            for (const listener of listeners) listener({ type: "auto_retry_start", attempt, maxAttempts: 2, delayMs: 0, errorMessage: "temporary timeout" });
          }
          for (const listener of listeners) listener({ type: "agent_end", willRetry: false });
          for (const listener of listeners) listener({ type: "auto_retry_end", success: false, attempt: 2 });
          for (const listener of listeners) listener({ type: "message_end", message: failed });
        } else {
          assert.equal(manager.liveFailoverModel("t1"), "backup/worker-2");
          const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }], usage: {} };
          session.messages.push(success);
          for (const listener of listeners) listener({ type: "agent_end", willRetry: false });
          for (const listener of listeners) listener({ type: "message_end", message: success });
        }
      },
      async setModel(model: { provider: string; id: string; contextWindow?: number }) { session.model = { ...model, contextWindow: model.contextWindow ?? 10_000 }; },
      setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as {
      live: Map<string, typeof session>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session; baseline: typeof NO_SESSION_BASELINE }>;
    };
    internals.openWorkerFor = async (args: any) => { bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session, baseline: NO_SESSION_BASELINE }; };
    const model = (provider: string, id: string) => ({
      provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
      maxTokens: 100, thinkingLevelMap: { max: "max" },
    });
    const ctx = {
      cwd: root, hasUI: false,
      modelRegistry: {
        find(provider: string, id: string) { return provider === "test" && id === "worker" || provider === "backup" && id === "worker-2" ? model(provider, id) : undefined; },
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "test" }; },
        hasConfiguredAuth() { return true; }, async getAvailable() { return []; },
      },
    } as unknown as ExtensionContext;
    const result = await manager.dispatch({ model: "luna-6", reason: "contract work", type: "general", task: "perform once" }, ctx, undefined);
    assert.equal(prompts[0], "perform once");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /conversation context is intact/i);
    assert.equal(session.messages.filter((message) => message === toolResult).length, 1);
    assert.equal(result.episode.logicalModel, "luna-6");
    assert.equal(result.episode.requestedModel, "test/worker");
    assert.equal(result.episode.requestedEffort, "max");
    assert.equal(result.episode.model, "backup/worker-2");
    assert.equal(result.episode.effort, "max");
    const remembered = runtime.admit();
    assert.ok(remembered);
    assert.equal(runtime.startRoute("luna-6", remembered.snapshot)?.provider, "backup");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("queued initial routes revalidate registry and credentials before opening a worker", { timeout: 3_000 }, async () => {
  for (const drift of ["registry", "auth"] as const) {
    const root = mkdtempSync(join(tmpdir(), `slate-queued-${drift}-`));
    try {
      const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
      const runtime = recoveryRuntime();
      const manager = new ThreadManager(store, { maxConcurrent: 1 }, undefined, runtime);
      const state = { registry: true, auth: true };
      let opens = 0;
      let prompts = 0;
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstPrompted!: () => void;
      const firstPrompt = new Promise<void>((resolve) => { firstPrompted = resolve; });
      const session = {
        messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
        workerReminderHandledToolResult: () => false,
        subscribe(listener: (event: Record<string, unknown>) => void) { session.listener = listener; return () => { session.listener = undefined; }; },
        listener: undefined as ((event: Record<string, unknown>) => void) | undefined,
        async prompt() {
          prompts++;
          firstPrompted();
          await firstGate;
          const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: {} };
          session.messages.push(message);
          session.listener?.({ type: "message_end", message });
        },
        async setModel() {}, setThinkingLevel(level: string) { session.thinkingLevel = level; }, async abort() {}, dispose() {}, getContextUsage() { return undefined; },
      };
      const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }> };
      internals.openWorkerFor = async (args: any) => { opens++; bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session }; };
      const ctx = recoveryContext(root, state);
      const first = manager.dispatch({ model: "luna-6", reason: "hold slot", type: "general", task: "first" }, ctx, undefined);
      await firstPrompt;
      const second = manager.dispatch({ model: "luna-6", reason: "wait in queue", type: "general", task: "second" }, ctx, undefined);
      while (store.threads.size < 2) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(opens, 1, `${drift} drift occurs after queue admission`);
      state[drift] = false;
      releaseFirst();
      await first;
      await assert.rejects(second, /startup stopped before billed work/);
      assert.equal(opens, 1, drift);
      assert.equal(prompts, 1, drift);
      assert.equal(store.threads.size, 1, drift);
      assert.equal(store.episodes.size, 1, drift);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("manager teardown enrolls a semaphore-queued dispatch and waits for its terminal rollback", { timeout: 3_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-queued-teardown-enrollment-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, { maxConcurrent: 1 }, undefined, fixtureRuntime());
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let innerCalls = 0;
    const internals = manager as unknown as {
      actionFinalizers: Map<string, Promise<void>>;
      runDispatchInner(thread: ThreadRecord): Promise<DispatchResult>;
    };
    internals.runDispatchInner = async (thread: ThreadRecord) => {
      innerCalls++;
      assert.equal(thread.id, "t1", "the queued action must never enter terminal work after teardown");
      firstEntered.resolve();
      await releaseFirst.promise;
      const episode: EpisodeRecord = {
        id: "t1.e1", threadId: thread.id, task: "first", status: "ok", file: join(root, "unused.md"), createdAt: 1,
      };
      return {
        episodeText: "first complete",
        episode,
        thread,
        usage: { turns: 1, input: 0, output: 0, cost: 0, contextTokens: 0 },
        warnings: [],
      };
    };
    const ctx = { cwd: root, hasUI: false, modelRegistry: {
      find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id } : undefined; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "test" }; }, hasConfiguredAuth() { return true; }, async getAvailable() { return []; },
    } } as unknown as ExtensionContext;
    const first = manager.dispatch({ ...TEST_ROUTE, type: "general", task: "first" }, ctx, undefined);
    await firstEntered.promise;
    const second = manager.dispatch({ ...TEST_ROUTE, type: "general", task: "second" }, ctx, undefined);
    while (internals.actionFinalizers.size < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.threads.size, 2);
    assert.equal(innerCalls, 1);

    let teardownSettled = false;
    const teardown = manager.disposeAll().then(() => { teardownSettled = true; });
    await Promise.resolve();
    assert.equal(teardownSettled, false, "teardown must join the active and queued action owners");
    releaseFirst.resolve();
    await settlesWithin(first, "the active dispatch to release its semaphore", 1_000);
    await assert.rejects(
      settlesWithin(second, "the queued dispatch to roll back after teardown", 1_000),
      /cancelled before the action started/,
    );
    await settlesWithin(teardown, "manager teardown to join the queued rollback", 1_000);
    assert.equal(teardownSettled, true);
    assert.equal(innerCalls, 1, "the queued dispatch performs no terminal work after teardown");
    assert.equal(store.threads.has("t2"), false);
    assert.equal(internals.actionFinalizers.size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("initial route application rejects physical and effort mismatches without work records", { timeout: 2_000 }, async () => {
  for (const mismatch of ["physical", "effort"] as const) {
    const root = mkdtempSync(join(tmpdir(), `slate-initial-${mismatch}-`));
    try {
      const snapshots: unknown[] = [];
      const store = new SlateStore({ appendEntry(_type: string, data: Record<string, unknown>) { snapshots.push(structuredClone(data)); } } as unknown as ExtensionAPI);
      const manager = new ThreadManager(store, {}, undefined, recoveryRuntime());
      let prompts = 0;
      const session = {
        messages: [] as unknown[],
        model: mismatch === "physical" ? { provider: "other", id: "wrong", contextWindow: 10_000 } : { provider: "test", id: "worker", contextWindow: 10_000 },
        thinkingLevel: mismatch === "effort" ? "medium" : "max",
        workerReminderHandledToolResult: () => false,
        subscribe() { return () => {}; }, async prompt() { prompts++; }, async setModel() {},
        setThinkingLevel(level: string) { if (mismatch !== "effort") session.thinkingLevel = level; },
        async abort() {}, dispose() {}, getContextUsage() { return undefined; },
      };
      const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }> };
      internals.openWorkerFor = async (args: any) => { bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session }; };
      await assert.rejects(
        manager.dispatch({ model: "luna-6", reason: "validate application", type: "general", task: "must not run" }, recoveryContext(root, { registry: true, auth: true }), undefined),
        /startup stopped before billed work/,
      );
      assert.equal(prompts, 0, mismatch);
      assert.equal(store.threads.size, 0, mismatch);
      assert.equal(store.episodes.size, 0, mismatch);
      // T1: a rejected route records nothing that any durable consumer can read.
      await assertNoDurableEpisodeConsumers(recoveryContext(root, { registry: true, auth: true }), "t1.e1", snapshots.at(-1));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("async initial effort drift after credential validation cannot reach prompt", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-initial-async-drift-"));
  try {
    const runtime = recoveryRuntime();
    const snapshots: unknown[] = [];
    const store = new SlateStore({ appendEntry(_type: string, data: Record<string, unknown>) { snapshots.push(structuredClone(data)); } } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, runtime);
    let prompts = 0;
    let authCalls = 0;
    const session = {
      messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
      workerReminderHandledToolResult: () => false,
      subscribe() { return () => {}; }, async prompt() { prompts++; }, async setModel() {},
      setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }> };
    internals.openWorkerFor = async (args: any) => { bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session }; };
    const ctx = recoveryContext(root, { registry: true, auth: true });
    ctx.modelRegistry.getApiKeyAndHeaders = async () => {
      authCalls++;
      if (authCalls === 3) await new Promise<void>((resolve) => queueMicrotask(() => {
        session.thinkingLevel = "low";
        resolve();
      }));
      return { ok: true, apiKey: "test" };
    };
    await assert.rejects(
      manager.dispatch({ model: "luna-6", reason: "detect async effort drift", type: "general", task: "must not run" }, ctx, undefined),
      /startup stopped before billed work.*effort low/i,
    );
    assert.equal(authCalls, 3);
    assert.equal(prompts, 0);
    assert.equal(store.threads.size, 0);
    assert.equal(store.episodes.size, 0);
    // T1: the same inverse durable contract holds for a late effort drift.
    await assertNoDurableEpisodeConsumers(recoveryContext(root, { registry: true, auth: true }), "t1.e1", snapshots.at(-1));
    const next = runtime.admit();
    assert.ok(next);
    assert.equal(runtime.startRoute("luna-6", next.snapshot)?.provider, "test");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery route mismatches do not prompt or publish and keep initial execution facts", { timeout: 2_000 }, async () => {
  for (const mismatch of ["physical", "effort"] as const) {
    const root = mkdtempSync(join(tmpdir(), `slate-recovery-${mismatch}-`));
    try {
      const runtime = recoveryRuntime();
      const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
      const manager = new ThreadManager(store, {}, undefined, runtime);
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      let prompts = 0;
      let switched = false;
      const session = {
        messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
        workerReminderHandledToolResult: () => false,
        subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async prompt() {
          prompts++;
          const failed = { role: "assistant", stopReason: "error", errorMessage: "temporary timeout", content: [{ type: "text", text: "completed partial output" }], usage: {} };
          session.messages.push(failed);
          for (const listener of listeners) listener({ type: "agent_end", willRetry: true });
          for (const listener of listeners) listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, errorMessage: "temporary timeout" });
          for (const listener of listeners) listener({ type: "agent_end", willRetry: false });
          for (const listener of listeners) listener({ type: "auto_retry_end", success: false, attempt: 1 });
          for (const listener of listeners) listener({ type: "message_end", message: failed });
        },
        async setModel(next: { provider: string; id: string; contextWindow?: number }) {
          switched = true;
          session.model = mismatch === "physical" ? { provider: "other", id: "wrong", contextWindow: 10_000 } : { ...next, contextWindow: next.contextWindow ?? 10_000 };
        },
        setThinkingLevel(level: string) { session.thinkingLevel = switched && mismatch === "effort" ? "medium" : level; },
        async abort() {}, dispose() {}, getContextUsage() { return undefined; },
      };
      const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }> };
      internals.openWorkerFor = async (args: any) => { bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session }; };
      const result = await manager.dispatch({ model: "luna-6", reason: "reject bad recovery", type: "general", task: "run once" }, recoveryContext(root, { registry: true, auth: true }), undefined);
      assert.equal(prompts, 1, mismatch);
      assert.equal(result.episode.status, "failed", mismatch);
      assert.equal(result.episode.model, "test/worker", mismatch);
      assert.equal(result.episode.effort, "max", mismatch);
      assert.match(result.episodeText, /completed partial output/, mismatch);
      const next = runtime.admit();
      assert.ok(next);
      assert.equal(runtime.startRoute("luna-6", next.snapshot)?.provider, "test", mismatch);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("async recovery model drift after credential validation cannot reach prompt or history", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-recovery-async-drift-"));
  try {
    const runtime = recoveryRuntime();
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, runtime);
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    let prompts = 0;
    let authCalls = 0;
    const session = {
      messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt() {
        prompts++;
        assert.equal(session.model.provider, "test", "only the initial physical route may prompt");
        const failed = { role: "assistant", stopReason: "error", errorMessage: "temporary timeout", content: [{ type: "text", text: "retained initial output" }], usage: {} };
        session.messages.push(failed);
        for (const listener of listeners) listener({ type: "agent_end", willRetry: true });
        for (const listener of listeners) listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, errorMessage: "temporary timeout" });
        for (const listener of listeners) listener({ type: "agent_end", willRetry: false });
        for (const listener of listeners) listener({ type: "auto_retry_end", success: false, attempt: 1 });
        for (const listener of listeners) listener({ type: "message_end", message: failed });
      },
      async setModel(next: { provider: string; id: string; contextWindow?: number }) { session.model = { ...next, contextWindow: next.contextWindow ?? 10_000 }; },
      setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }> };
    internals.openWorkerFor = async (args: any) => { bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session }; };
    const ctx = recoveryContext(root, { registry: true, auth: true });
    ctx.modelRegistry.getApiKeyAndHeaders = async () => {
      authCalls++;
      if (authCalls === 5) await new Promise<void>((resolve) => queueMicrotask(() => {
        session.model = { provider: "outside", id: "changed", contextWindow: 10_000 };
        resolve();
      }));
      return { ok: true, apiKey: "test" };
    };
    const result = await manager.dispatch({ model: "luna-6", reason: "detect async recovery drift", type: "general", task: "run once" }, ctx, undefined);
    assert.equal(authCalls, 5);
    assert.equal(prompts, 1);
    assert.equal(result.episode.status, "failed");
    assert.equal(result.episode.model, "test/worker");
    assert.equal(result.episode.effort, "max");
    assert.match(result.episodeText, /retained initial output/);
    const next = runtime.admit();
    assert.ok(next);
    assert.equal(runtime.startRoute("luna-6", next.snapshot)?.provider, "test");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("post-open validation failure waits at a deterministic barrier and starts no request", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-post-open-validation-"));
  try {
    const original = recoveryRuntime();
    const entered = deferred();
    const release = deferred();
    let validations = 0;
    const runtime = Object.freeze({
      ...original,
      async validateRoute(ctx: Pick<ExtensionContext, "modelRegistry">, candidate: any) {
        validations++;
        if (validations === 3) {
          entered.resolve();
          await release.promise;
        }
        return original.validateRoute(ctx, candidate);
      },
    });
    const state = { registry: true, auth: true };
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, runtime);
    let prompts = 0;
    const session = {
      messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
      workerReminderHandledToolResult: () => false,
      subscribe() { return () => {}; }, async prompt() { prompts++; },
      async setModel() {}, setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: any): Promise<{ session: typeof session }> };
    internals.openWorkerFor = async (args: any) => {
      bindFakeWorkerRequest(session, args.requestContract);
      internals.live.set(args.thread.id, session);
      return { session };
    };
    const dispatch = manager.dispatch(
      { model: "luna-6", reason: "barrier validation", type: "general", task: "must not run" },
      recoveryContext(root, state),
      undefined,
    );
    await entered.promise;
    state.auth = false;
    release.resolve();
    await assert.rejects(dispatch, /startup stopped before billed work/);
    assert.equal(validations, 3);
    assert.equal(prompts, 0);
    assert.equal(store.threads.size, 0);
    assert.equal(store.episodes.size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery validation failure, caller cancellation, and session replacement preserve the initial accepted pair", { timeout: 4_000 }, async (t) => {
  for (const mode of ["validation", "abort", "replacement"] as const) await t.test(mode, { timeout: 1_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), `slate-recovery-barrier-${mode}-`));
    try {
      const original = recoveryRuntime();
      const entered = deferred();
      const release = deferred();
      let validations = 0;
      const runtime = Object.freeze({
        ...original,
        async validateRoute(ctx: Pick<ExtensionContext, "modelRegistry">, candidate: any) {
          validations++;
          if (validations === 5) {
            entered.resolve();
            await release.promise;
          }
          return original.validateRoute(ctx, candidate);
        },
      });
      const state = { registry: true, auth: true };
      const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
      const manager = new ThreadManager(store, {}, undefined, runtime);
      const controller = new AbortController();
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      let prompts = 0;
      const session = {
        messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
        workerReminderHandledToolResult: () => false,
        subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async prompt() {
          prompts++;
          if (prompts > 1) throw new Error("a blocked recovery request reached the fake provider");
          const failed = { role: "assistant", stopReason: "error", errorMessage: "temporary timeout", content: [{ type: "text", text: "retained initial response" }], usage: {} };
          session.messages.push(failed);
          for (const listener of listeners) listener({ type: "agent_end", willRetry: true });
          for (const listener of listeners) listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, errorMessage: "temporary timeout" });
          for (const listener of listeners) listener({ type: "agent_end", willRetry: false });
          for (const listener of listeners) listener({ type: "auto_retry_end", success: false, attempt: 1 });
          for (const listener of listeners) listener({ type: "message_end", message: failed });
        },
        async setModel(next: { provider: string; id: string; contextWindow?: number }) { session.model = { ...next, contextWindow: next.contextWindow ?? 10_000 }; },
        setThinkingLevel(level: string) { session.thinkingLevel = level; },
        async abort() {}, dispose() {}, getContextUsage() { return undefined; },
      };
      const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: any): Promise<{ session: typeof session }> };
      internals.openWorkerFor = async (args: any) => {
        bindFakeWorkerRequest(session, args.requestContract);
        internals.live.set(args.thread.id, session);
        return { session };
      };
      const dispatch = manager.dispatch(
        { model: "luna-6", reason: `recovery ${mode}`, type: "general", task: "run once" },
        recoveryContext(root, state),
        controller.signal,
      );
      await entered.promise;
      let teardown: Promise<void> | undefined;
      if (mode === "validation") state.auth = false;
      else if (mode === "abort") controller.abort();
      else teardown = manager.disposeAll();
      release.resolve();
      const result = await dispatch;
      await teardown;
      assert.equal(validations, 6, "five worker-route validations plus one compressor candidate validation");
      assert.equal(prompts, 1);
      assert.equal(result.episode.status, "failed");
      assert.equal(result.episode.model, "test/worker");
      assert.equal(result.episode.effort, "max");
      assert.equal(result.episode.requestedModel, "test/worker");
      assert.notEqual(result.episode.model, "backup/worker-2");
      assert.match(result.episodeText, /retained initial response/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("a transient worker retry followed by billing stops before another provider prompt", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-worker-terminal-"));
  try {
    const runtime = recoveryRuntime();
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, runtime);
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    let prompts = 0;
    let switches = 0;
    const session = {
      messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt() {
        prompts++;
        const billing = { role: "assistant", stopReason: "error", errorMessage: "billing account exhausted", content: [], usage: {} };
        session.messages.push(billing);
        for (const listener of listeners) listener({ type: "agent_end", willRetry: true });
        for (const listener of listeners) listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, errorMessage: "temporary timeout" });
        for (const listener of listeners) listener({ type: "agent_end", willRetry: false });
        for (const listener of listeners) listener({ type: "auto_retry_end", success: false, attempt: 1, finalError: "billing account exhausted" });
        for (const listener of listeners) listener({ type: "message_end", message: billing });
      },
      async setModel() { switches++; }, setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }> };
    internals.openWorkerFor = async (args: any) => { bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session }; };
    const result = await manager.dispatch({ model: "luna-6", reason: "stop on billing", type: "general", task: "run" }, recoveryContext(root, { registry: true, auth: true }), undefined);
    assert.equal(prompts, 1);
    assert.equal(switches, 0);
    assert.equal(result.episode.status, "failed");
    const next = runtime.admit();
    assert.ok(next);
    assert.equal(runtime.startRoute("luna-6", next.snapshot)?.provider, "test");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancellation after a completed tool result retains durable bytes and every consumer", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-completed-cancel-"));
  try {
    const snapshots: unknown[] = [];
    const store = new SlateStore({ appendEntry(_type: string, data: Record<string, unknown>) { snapshots.push(structuredClone(data)); } } as unknown as ExtensionAPI);
    const runtime = createLogicalRuntime({
      trusted: true,
      projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "test", providers: { test: "worker" } }] } } },
    });
    const manager = new ThreadManager(store, {}, undefined, runtime, { enabled: true, maxRetries: 1, baseDelayMs: 0 });
    const controller = new AbortController();
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const session = {
      messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt() {
        const toolResult = { role: "toolResult", toolCallId: "done", toolName: "read", content: [{ type: "text", text: "COMPLETED TOOL BEFORE CANCEL" }], isError: false };
        const emptyAbort = { role: "assistant", stopReason: "aborted", content: [], usage: {} };
        session.messages.push(toolResult, emptyAbort);
        for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "read", result: toolResult, isError: false });
        for (const listener of listeners) listener({ type: "message_end", message: emptyAbort });
        controller.abort();
      },
      async setModel(next: { provider: string; id: string; contextWindow?: number }) { session.model = { ...next, contextWindow: next.contextWindow ?? 10_000 }; },
      setThinkingLevel(level: string) { session.thinkingLevel = level; }, async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session; baseline: typeof NO_SESSION_BASELINE }> };
    internals.openWorkerFor = async (args: any) => { bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session, baseline: NO_SESSION_BASELINE }; };
    const sdkModel = (provider: string, id: string, levels: Record<string, string>) => ({
      provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 100, thinkingLevelMap: levels,
    });
    const worker = sdkModel("test", "worker", { max: "max" });
    const ctx = { cwd: root, hasUI: false, modelRegistry: {
      find(provider: string, id: string) { return provider === "test" && id === "worker" ? worker : undefined; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "test" }; }, async getAvailable() { return [worker]; }, hasConfiguredAuth() { return true; },
    } } as unknown as ExtensionContext;
    const result = await manager.dispatch({ model: "luna-6", reason: "preserve completion", type: "general", task: "finish once" }, ctx, controller.signal);
    assert.match(result.episodeText, /COMPLETED TOOL BEFORE CANCEL/);
    assert.match(result.episodeText, /bounded completed result was retained/i);
    assert.match(result.episodeText, /worker action was cancelled/);
    assert.equal(readFileSync(result.episode.file, "utf8"), result.episodeText);

    const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    restored.adoptSnapshot(snapshots.at(-1) as Parameters<SlateStore["adoptSnapshot"]>[0], ctx);
    assert.equal(restored.threads.get(result.thread.id)?.episodeId, result.episode.id);
    assert.equal(restored.threads.get(result.thread.id)?.status, "failed");
    assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /worker action was cancelled/);
    const restoredEpisode = restored.episodes.get(result.episode.id);
    assert.equal(restoredEpisode?.status, "failed");
    assert.equal(restoredEpisode?.reason, "preserve completion");
    assert.equal(restoredEpisode?.logicalModel, "luna-6");
    assert.equal(restoredEpisode?.requestedModel, "test/worker");
    assert.equal(restoredEpisode?.requestedEffort, "max");
    assert.equal(restoredEpisode?.model, "test/worker");
    assert.equal(restoredEpisode?.effort, "max");
    assert.equal(restoredEpisode?.file, result.episode.file);
    let episodeTool: any;
    registerSlateTools(
      { registerTool(tool: any) { if (tool.name === "episode") episodeTool = tool; } } as ExtensionAPI,
      restored,
      () => manager,
    );
    const fetched = await episodeTool.execute("call", { id: result.episode.id }, undefined, undefined, ctx);
    assert.equal(fetched.content[0]?.text, result.episodeText);

    const later = new ThreadManager(restored, {}, undefined, runtime);
    let laterPrompt = "";
    (later as any).runDispatch = async (nextThread: ThreadRecord, _opts: DispatchOptions, loadedPrompt: string) => {
      laterPrompt = loadedPrompt;
      return { ...result, thread: nextThread };
    };
    await later.dispatch(
      { model: "luna-6", reason: "durable consumer", type: "general", task: "continue", contextEpisodeIds: [result.episode.id] },
      ctx,
      undefined,
    );
    assert.match(laterPrompt, /COMPLETED TOOL BEFORE CANCEL/);
    assert.match(laterPrompt, /worker action was cancelled/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancellation after finalized assistant text then an empty abort retains a durable raw episode", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-finalized-assistant-cancel-"));
  try {
    const snapshots: unknown[] = [];
    const store = new SlateStore({ appendEntry(_type: string, data: Record<string, unknown>) { snapshots.push(structuredClone(data)); } } as unknown as ExtensionAPI);
    const runtime = createLogicalRuntime({
      trusted: true,
      projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "test", providers: { test: "worker" } }] } } },
    });
    const manager = new ThreadManager(store, {}, undefined, runtime, { enabled: true, maxRetries: 1, baseDelayMs: 0 });
    const controller = new AbortController();
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const session = {
      messages: [] as unknown[], model: { provider: "test", id: "worker", contextWindow: 10_000 }, thinkingLevel: "max",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt() {
        const finalized = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "COMPLETED ASSISTANT BEFORE CANCEL" }], usage: {} };
        const emptyAbort = { role: "assistant", stopReason: "aborted", content: [], usage: {} };
        session.messages.push(finalized, emptyAbort);
        for (const listener of listeners) listener({ type: "message_end", message: finalized });
        for (const listener of listeners) listener({ type: "message_end", message: emptyAbort });
        controller.abort();
      },
      async setModel(next: { provider: string; id: string; contextWindow?: number }) { session.model = { ...next, contextWindow: next.contextWindow ?? 10_000 }; },
      setThinkingLevel(level: string) { session.thinkingLevel = level; }, async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as { live: Map<string, typeof session>; openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session; baseline: typeof NO_SESSION_BASELINE }> };
    internals.openWorkerFor = async (args: any) => { bindFakeWorkerRequest(session, args.requestContract); internals.live.set(args.thread.id, session); return { session, baseline: NO_SESSION_BASELINE }; };
    const worker = workerModel("test", "worker");
    const ctx = { cwd: root, hasUI: false, modelRegistry: {
      find(provider: string, id: string) { return provider === "test" && id === "worker" ? worker : undefined; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "test" }; }, async getAvailable() { return [worker]; }, hasConfiguredAuth() { return true; },
    } } as unknown as ExtensionContext;
    const result = await manager.dispatch({ model: "luna-6", reason: "preserve finalized assistant", type: "general", task: "finish once" }, ctx, controller.signal);
    assert.match(result.episodeText, /COMPLETED ASSISTANT BEFORE CANCEL/);
    assert.match(result.episodeText, /bounded completed result was retained/i);
    assert.match(result.episodeText, /worker action was cancelled/);
    assert.equal(readFileSync(result.episode.file, "utf8"), result.episodeText);

    const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    restored.adoptSnapshot(snapshots.at(-1) as Parameters<SlateStore["adoptSnapshot"]>[0], ctx);
    assert.equal(restored.threads.get(result.thread.id)?.episodeId, result.episode.id);
    assert.equal(restored.episodes.get(result.episode.id)?.file, result.episode.file);
    let episodeTool: any;
    registerSlateTools(
      { registerTool(tool: any) { if (tool.name === "episode") episodeTool = tool; } } as ExtensionAPI,
      restored,
      () => manager,
    );
    const fetched = await episodeTool.execute("call", { id: result.episode.id }, undefined, undefined, ctx);
    assert.equal(fetched.content[0]?.text, result.episodeText);
    const later = new ThreadManager(restored, {}, undefined, runtime);
    const laterPrompt = (later as any).buildPrompt({ task: "later finalized consumer", contextEpisodeIds: [result.episode.id] }, root);
    assert.match(laterPrompt, /COMPLETED ASSISTANT BEFORE CANCEL/);
    assert.match(laterPrompt, /worker action was cancelled/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("episode compression excludes worker reminders and only the injected user prompt", () => {
  const injected = { role: "user", content: "loaded episode text" };
  const assistant = { role: "assistant", content: "result" };
  const compacted = { role: "compactionSummary", content: "summary" };
  const reminder = { role: "custom", customType: "slate-worker-reminder", content: "reminder" };
  const otherCustom = { role: "custom", customType: "other", content: "keep" };
  assert.deepEqual(
    messagesForCompression([compacted, reminder, injected, assistant, reminder, otherCustom], "loaded episode text"),
    [compacted, assistant, otherCustom],
  );
  assert.deepEqual(messagesForCompression([reminder, assistant, reminder]), [assistant]);
  assert.deepEqual(messagesForCompression([assistant], "loaded episode text"), [assistant]);
  assert.deepEqual(messagesForCompression([injected, assistant]), [injected, assistant]);
});

async function dispatchWithUnpairedToolResult(
  handledToolResult: boolean,
  compactionEvent?: "successful" | "aborted" | "missing-result",
) {
  const root = mkdtempSync(join(tmpdir(), "slate-reminder-miss-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const session = {
      messages: (compactionEvent === "successful" ? [{ role: "user", content: "earlier turn" }] : []) as unknown[],
      model: { provider: "test", id: "worker", contextWindow: 10_000 },
      thinkingLevel: "off",
      sessionFile: undefined,
      workerReminderHandledToolResult: () => handledToolResult,
      subscribe(listener: (event: Record<string, unknown>) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "data" }] };
        const assistant = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: {} };
        session.messages.push(toolResult);
        if (compactionEvent === "successful") {
          session.messages.push({ role: "custom", customType: "slate-worker-reminder", content: "reminder" });
          session.messages.splice(0, session.messages.length, { role: "compactionSummary", content: "summary" });
          for (const listener of listeners) listener({ type: "compaction_end", result: {} });
        } else if (compactionEvent === "aborted") {
          for (const listener of listeners) listener({ type: "compaction_end", result: {}, aborted: true });
        } else if (compactionEvent === "missing-result") {
          for (const listener of listeners) listener({ type: "compaction_end" });
        }
        session.messages.push(assistant);
        for (const listener of listeners) listener({ type: "message_end", message: assistant });
      },
      async abort() {},
      dispose() {},
      async setModel(next: { provider: string; id: string; contextWindow?: number }) { session.model = { ...next, contextWindow: next.contextWindow ?? 10_000 }; },
      setThinkingLevel(level: string) { session.thinkingLevel = level; },
      getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as {
      live: Map<string, typeof session>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session; baseline: typeof NO_SESSION_BASELINE }>;
    };
    internals.openWorkerFor = async (args: any) => {
      bindFakeWorkerRequest(session, args.requestContract);
      internals.live.set(args.thread.id, session);
      return { session, baseline: NO_SESSION_BASELINE };
    };
    return await manager.dispatch(
      { ...TEST_ROUTE, type: "general", task: "complete despite the missing reminder" },
      {
        cwd: root,
        hasUI: false,
        modelRegistry: {
          find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id } : undefined; },
          async getAvailable() { return []; },
          hasConfiguredAuth() { return true; },
        },
      } as unknown as ExtensionContext,
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a missing worker reminder warns without changing a successful action", { timeout: 1000 }, async () => {
  const result = await dispatchWithUnpairedToolResult(true);
  const warning = "slate: a worker tool result reached the reminder handler, but the reminder is missing. Review the worker transcript before you rely on the result.";
  assert.equal(result.thread.status, "successful");
  assert.equal(result.episode.status, "ok");
  assert.deepEqual(result.warnings, [warning]);
});

test("a short-path tool result does not produce a false reminder warning", { timeout: 1000 }, async () => {
  const result = await dispatchWithUnpairedToolResult(false);
  assert.equal(result.thread.status, "successful");
  assert.equal(result.episode.status, "ok");
  assert.deepEqual(result.warnings, []);
});

test("successful history compaction during an action keeps reminder-loss detection silent", { timeout: 1000 }, async () => {
  const result = await dispatchWithUnpairedToolResult(true, "successful");
  assert.equal(result.thread.status, "successful");
  assert.equal(result.episode.status, "ok");
  assert.deepEqual(result.warnings, []);
});

test("aborted history compaction does not suppress a reminder-loss warning", { timeout: 1000 }, async () => {
  const result = await dispatchWithUnpairedToolResult(true, "aborted");
  assert.equal(result.thread.status, "successful");
  assert.equal(result.episode.status, "ok");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /worker tool result reached the reminder handler/);
});

test("history compaction without a result does not suppress a reminder-loss warning", { timeout: 1000 }, async () => {
  const result = await dispatchWithUnpairedToolResult(true, "missing-result");
  assert.equal(result.thread.status, "successful");
  assert.equal(result.episode.status, "ok");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /worker tool result reached the reminder handler/);
});

test("the current thread record sanitizer covers every terminal shape", () => {
  const valid = {
    id: "t1", name: "done", status: "successful", type: "reviewer", model: "p/pin",
    baseModel: "p/base", baseEffort: "medium", tools: ["read"],
    episodeId: "t1.e1", outcomeReason: "done", createdAt: 1, updatedAt: 2,
  };
  const restored = sanitizeThreadRecord(valid, []);
  const { baseModel: _legacyBaseModel, baseEffort: _legacyBaseEffort, ...retained } = valid;
  assert.deepEqual(restored, retained);
  assert.equal("baseModel" in restored!, false);
  assert.equal("baseEffort" in restored!, false);
  const missingEpisodeRepairs: string[] = [];
  const missingEpisode = sanitizeThreadRecord({ ...valid, episodeId: undefined }, missingEpisodeRepairs);
  assert.equal(missingEpisode?.status, "failed");
  assert.equal(missingEpisode?.episodeId, undefined);
  assert.match(missingEpisodeRepairs.join("\n"), /normalized successful action/);
  assert.equal(sanitizeThreadRecord({ ...valid, id: undefined }, []), undefined);
  assert.equal(sanitizeThreadRecord({ ...valid, id: "legacy" }, []), undefined);
  assert.equal(sanitizeThreadRecord({ ...valid, name: undefined }, []), undefined);
  assert.equal(sanitizeThreadRecord({ ...valid, type: "unknown" }, []), undefined);
  assert.equal(sanitizeThreadRecord({ ...valid, status: "idle" }, []), undefined);
  for (const episodeId of ["t1.e2", 7]) {
    const mismatchedRepairs: string[] = [];
    const adopted = sanitizeThreadRecord({ ...valid, status: "failed", episodeId }, mismatchedRepairs);
    assert.equal(adopted?.status, "failed");
    assert.equal(adopted?.episodeId, undefined);
    assert.match(mismatchedRepairs.join("\n"), /ignoring episodeId/);
  }
  const legacyRepairs: string[] = [];
  const legacy = sanitizeThreadRecord({ ...valid, cacheKeyShard: 1 }, legacyRepairs);
  assert.deepEqual(legacy, retained, "obsolete route and shard metadata must be dropped without losing the thread");
  assert.deepEqual(legacyRepairs, []);
  const defaults = sanitizeThreadRecord({ id: "t2", name: "failed", status: "failed", type: "general" }, []);
  assert.equal(typeof defaults?.createdAt, "number");
  assert.equal(typeof defaults?.updatedAt, "number");
});

test("a save failure before worker startup rolls back the new thread", async () => {
  let saves = 0;
  const store = new SlateStore({
    appendEntry() {
      saves++;
      if (saves === 2) throw new Error("session file unavailable");
    },
  } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "must not start", type: "general" }, { modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined, hasConfiguredAuth: () => true, getAvailable: async () => [] } } as unknown as ExtensionContext, undefined),
    /Nothing ran and no episode was recorded/,
  );
  assert.equal(store.threads.size, 0);
  assert.equal(store.episodes.size, 0);
});

test("restoration keeps only the one canonical episode referenced by its thread", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-single-restore-"));
  try {
    const episodesDir = join(root, ".pi", "slate", "episodes");
    mkdirSync(episodesDir, { recursive: true });
    writeFileSync(join(episodesDir, "t1.e1.md"), "canonical");
    writeFileSync(join(episodesDir, "t1.e2.md"), "extra");
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    store.adoptSnapshot({
      format: SLATE_STATE_FORMAT,
      threads: [{ id: "t1", name: "done", status: "successful", type: "general", episodeId: "t1.e1", createdAt: 1, updatedAt: 1 }],
      episodes: [
        { id: "t1.e1", threadId: "t1", task: "one", status: "ok", file: join(episodesDir, "t1.e1.md"), createdAt: 1 },
        { id: "t1.e2", threadId: "t1", task: "extra", status: "ok", file: join(episodesDir, "t1.e2.md"), createdAt: 2 },
      ],
      threadSeq: 1, orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0,
    }, { cwd: root, hasUI: false } as ExtensionContext);
    assert.deepEqual([...store.episodes.keys()], ["t1.e1"]);
    assert.equal(store.threads.get("t1")?.episodeId, "t1.e1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dropped thread records report the invalid field", () => {
  for (const [field, value] of [["name", undefined], ["type", "unknown"], ["status", "idle"]] as const) {
    const repairs: string[] = [];
    const raw = { id: "t1", name: "x", type: "general", status: "failed", [field]: value };
    assert.equal(sanitizeThreadRecord(raw, repairs), undefined);
    assert.deepEqual(repairs, [`thread t1: invalid ${field}`]);
  }
});

test("state restoration accepts only the current format marker", () => {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const ctx = { hasUI: false } as ExtensionContext;
  const thread: ThreadRecord = {
    id: "t1", name: "done", status: "cancelled", type: "general", outcomeReason: "cancelled", createdAt: 1, updatedAt: 1,
  };
  for (const status of ["queued", "running"] as const) {
    store.adoptSnapshot({ format: SLATE_STATE_FORMAT, threads: [{ ...thread, status }], episodes: [], threadSeq: 1, orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0 }, ctx);
    assert.equal(store.threads.get("t1")?.status, "failed");
    assert.match(store.threads.get("t1")?.outcomeReason ?? "", /session ended/);
  }
  for (const status of ["failed", "cancelled"] as const) {
    store.adoptSnapshot({ format: SLATE_STATE_FORMAT, threads: [{ ...thread, status }], episodes: [], threadSeq: 1, orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0 }, ctx);
    assert.equal(store.threads.get("t1")?.status, status);
  }
  store.adoptSnapshot({ threads: [thread], episodes: [], threadSeq: 1, orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0 } as any, ctx);
  assert.equal(store.threads.size, 0);
  store.adoptSnapshot({ format: SLATE_STATE_FORMAT, threads: [thread], episodes: [], threadSeq: 1, orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0 }, ctx);
  assert.equal(store.threads.size, 1);
  store.adoptSnapshot({ format: SLATE_STATE_FORMAT, threads: [{ ...thread, status: "successful", episodeId: "t1.e1" }], episodes: [], threadSeq: 1, orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0 }, ctx);
  assert.equal(store.threads.size, 0);
  store.adoptSnapshot({ format: SLATE_STATE_FORMAT, threads: [{ ...thread, status: "successful", episodeId: "t1.e2" }], episodes: [], threadSeq: 1, orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0 }, ctx);
  assert.equal(store.threads.get("t1")?.status, "failed");
  assert.equal(store.threads.get("t1")?.episodeId, undefined);
});

/** Bound wait for a promise that a defect could leave pending forever. */
async function settlesWithin<T>(promise: Promise<T>, label: string, ms = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("a synchronous startup preparation failure releases the opening and its exact request owner", { timeout: 4_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-opening-preparation-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    let ownerAtFailure: WorkerRequestContract | undefined;
    let resolverCalls = 0;
    const manager = new ThreadManager(
      store,
      {},
      () => {
        resolverCalls++;
        ownerAtFailure = [...internals.requestContracts.values()][0];
        throw new Error("resolver failed");
      },
      fixtureRuntime(),
    );
    const internals = manager as unknown as {
      live: Map<string, unknown>;
      openingWorkers: Set<Promise<void>>;
      requestContracts: Map<string, WorkerRequestContract>;
    };
    const ctx = {
      cwd: root,
      hasUI: false,
      modelRegistry: {
        find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id } : undefined; },
        async getAvailable() { return []; },
        hasConfiguredAuth() { return true; },
      },
    } as unknown as ExtensionContext;
    const result = await settlesWithin(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "fail during startup preparation" }, ctx, undefined),
      "the dispatch that fails during startup preparation",
      3_000,
    );
    assert.equal(resolverCalls, 1);
    assert.equal(result.episode.status, "failed");
    assert.equal(result.thread.status, "failed");
    assert.match(result.thread.outcomeReason ?? "", /resolver failed/);
    assert.ok(ownerAtFailure, "the action owner is published before startup preparation runs");
    assert.equal(ownerAtFailure.invalidationSignal.aborted, true, "the exact published owner is invalidated");
    assert.equal(internals.requestContracts.size, 0, "the exact request handle is removed");
    assert.equal(internals.openingWorkers.size, 0, "the opening promise is released");
    assert.equal(internals.live.size, 0);
    await settlesWithin(manager.disposeAll(), "manager teardown after a failed startup preparation", 1_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused request from worker startup ends the action before any ordinary request", { timeout: 4_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-startup-refusal-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    let prompts = 0;
    let promptAttempts = 0;
    let startupDelegations = 0;
    let startupRefusals = 0;
    const session = {
      messages: [] as unknown[],
      model: { provider: "test", id: "worker", contextWindow: 10_000 },
      thinkingLevel: "off",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(_text: string) {
        prompts++;
        const done = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ordinary work finished" }], usage: {} };
        session.messages.push(done);
        for (const listener of listeners) listener({ type: "message_end", message: done });
      },
      async setModel() {}, setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as {
      live: Map<string, typeof session>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }>;
    };
    internals.openWorkerFor = async (args: any) => {
      // A trusted worker extension sends a drifted request from session_start.
      // ThreadManager has no event subscriber yet, so only the owner sees it.
      try {
        args.requestContract.accept({ provider: "test", id: "worker" }, "low", undefined, () => { startupDelegations++; });
      } catch (error) {
        startupRefusals++;
        assert.equal((error as Error).message, WORKER_REQUEST_CONTRACT_ERROR);
      }
      bindFakeWorkerRequest(session, args.requestContract);
      // Count every ATTEMPT to prompt, outside the acceptance owner. The action
      // must not reach this wrapper at all after a refused startup request.
      const attempted = session.prompt.bind(session);
      session.prompt = async (text: string) => {
        promptAttempts++;
        await attempted(text);
      };
      internals.live.set(args.thread.id, session);
      return { session };
    };
    const ctx = {
      cwd: root,
      hasUI: false,
      modelRegistry: {
        find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id } : undefined; },
        async getAvailable() { return []; },
        hasConfiguredAuth() { return true; },
      },
    } as unknown as ExtensionContext;
    const result = await settlesWithin(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "startup refusal must stay visible" }, ctx, undefined),
      "the dispatch after a refused startup request",
      3_000,
    );
    assert.equal(startupRefusals, 1);
    assert.equal(startupDelegations, 0, "the refused startup request reaches no provider");
    assert.equal(promptAttempts, 0, "the action starts no ordinary request after the refusal");
    assert.equal(prompts, 0, "no ordinary and no substitute request follows the refused request");
    assert.equal(result.episode.status, "failed");
    assert.equal(result.thread.status, "failed");
    assert.equal(result.thread.outcomeReason, WORKER_REQUEST_CONTRACT_ERROR);
    assert.deepEqual(result.warnings, [WORKER_REQUEST_CONTRACT_ERROR]);
    assert.equal(result.episode.requestedModel, "test/worker", "the requested pair stays recorded");
    assert.equal(result.episode.requestedEffort, "off");
    assert.equal(result.episode.model, undefined, "a refused startup request records no final pair");
    assert.equal(result.episode.effort, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused automatic compaction fails the action, keeps completed work, and starts no recovery", { timeout: 4_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-initial-compaction-refusal-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    let prompts = 0;
    let compactionDelegations = 0;
    let contract: WorkerRequestContract | undefined;
    const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "retained tool output" }] };
    const session = {
      messages: [] as unknown[],
      model: { provider: "test", id: "worker", contextWindow: 10_000 },
      thinkingLevel: "off",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt() {
        prompts++;
        session.messages.push(toolResult);
        // Pi's automatic history compaction crosses the same owner. A worker hook
        // changed the effort, so the owner refuses that request and Pi keeps the
        // earlier successful response.
        assert.throws(
          () => contract!.accept({ provider: "test", id: "worker" }, "low", undefined, () => { compactionDelegations++; }),
          (error: Error) => error.message === WORKER_REQUEST_CONTRACT_ERROR,
        );
        for (const listener of listeners) listener({ type: "compaction_end", aborted: false, errorMessage: WORKER_REQUEST_CONTRACT_ERROR });
        const done = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "completed output" }], usage: {} };
        session.messages.push(done);
        for (const listener of listeners) listener({ type: "message_end", message: done });
      },
      async setModel() {}, setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as {
      live: Map<string, typeof session>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }>;
    };
    internals.openWorkerFor = async (args: any) => {
      contract = args.requestContract;
      bindFakeWorkerRequest(session, args.requestContract);
      internals.live.set(args.thread.id, session);
      return { session };
    };
    const ctx = {
      cwd: root,
      hasUI: false,
      modelRegistry: {
        find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id } : undefined; },
        async getAvailable() { return []; },
        hasConfiguredAuth() { return true; },
      },
    } as unknown as ExtensionContext;
    const result = await settlesWithin(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "refused compaction must be visible" }, ctx, undefined),
      "the dispatch after a refused compaction",
      3_000,
    );
    assert.equal(prompts, 1, "a refused compaction starts no replay and no substitute request");
    assert.equal(compactionDelegations, 0);
    assert.equal(result.episode.status, "failed");
    assert.equal(result.thread.status, "failed");
    assert.equal(result.thread.outcomeReason, WORKER_REQUEST_CONTRACT_ERROR);
    assert.deepEqual(result.warnings, [WORKER_REQUEST_CONTRACT_ERROR]);
    assert.equal(result.episode.model, "test/worker");
    assert.equal(result.episode.effort, "off");
    assert.equal(session.messages.filter((message) => message === toolResult).length, 1, "the completed tool result is retained");
    assert.match(result.episodeText, /completed output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused compaction inside a recovery prompt is not overwritten by the recovery result", { timeout: 4_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-recovery-compaction-refusal-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const runtime = recoveryRuntime();
    const manager = new ThreadManager(store, {}, undefined, runtime);
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const prompts: string[] = [];
    let compactionDelegations = 0;
    let contract: WorkerRequestContract | undefined;
    const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "retained" }] };
    const session = {
      messages: [] as unknown[],
      model: { provider: "test", id: "worker", contextWindow: 10_000 },
      thinkingLevel: "max",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(text: string) {
        prompts.push(text);
        if (prompts.length === 1) {
          const failed = { role: "assistant", stopReason: "error", errorMessage: "temporary timeout", content: [], usage: {} };
          session.messages.push(toolResult, failed);
          for (const attempt of [1, 2]) {
            for (const listener of listeners) listener({ type: "agent_end", willRetry: true });
            for (const listener of listeners) listener({ type: "auto_retry_start", attempt, maxAttempts: 2, delayMs: 0, errorMessage: "temporary timeout" });
          }
          for (const listener of listeners) listener({ type: "agent_end", willRetry: false });
          for (const listener of listeners) listener({ type: "auto_retry_end", success: false, attempt: 2 });
          for (const listener of listeners) listener({ type: "message_end", message: failed });
          return;
        }
        const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }], usage: {} };
        session.messages.push(success);
        for (const listener of listeners) listener({ type: "message_end", message: success });
        // The successful recovery response overflows the window. Pi starts its
        // automatic compaction, a worker hook has changed the effort, and the
        // owner refuses that compaction request.
        assert.throws(
          () => contract!.accept({ provider: "backup", id: "worker-2" }, "low", undefined, () => { compactionDelegations++; }),
          (error: Error) => error.message === WORKER_REQUEST_CONTRACT_ERROR,
        );
        for (const listener of listeners) listener({ type: "compaction_end", aborted: false, errorMessage: WORKER_REQUEST_CONTRACT_ERROR });
      },
      async setModel(model: { provider: string; id: string; contextWindow?: number }) { session.model = { ...model, contextWindow: model.contextWindow ?? 10_000 }; },
      setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as {
      live: Map<string, typeof session>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }>;
    };
    internals.openWorkerFor = async (args: any) => {
      contract = args.requestContract;
      bindFakeWorkerRequest(session, args.requestContract);
      internals.live.set(args.thread.id, session);
      return { session };
    };
    const result = await settlesWithin(
      manager.dispatch({ model: "luna-6", reason: "recovery compaction refusal", type: "general", task: "run once" }, recoveryContext(root, { registry: true, auth: true }), undefined),
      "the dispatch after a refused recovery compaction",
      3_000,
    );
    assert.equal(prompts.length, 2, "no further recovery candidate follows the refusal");
    assert.equal(compactionDelegations, 0);
    assert.equal(result.episode.status, "failed");
    assert.equal(result.thread.status, "failed");
    assert.equal(result.thread.outcomeReason, WORKER_REQUEST_CONTRACT_ERROR);
    assert.deepEqual(result.warnings, [WORKER_REQUEST_CONTRACT_ERROR]);
    assert.equal(result.episode.requestedModel, "test/worker");
    assert.equal(result.episode.model, "backup/worker-2", "the accepted recovery request keeps its true attribution");
    assert.equal(result.episode.effort, "max");
    assert.equal(session.messages.filter((message) => message === toolResult).length, 1);
    const next = runtime.admit();
    assert.ok(next);
    assert.equal(runtime.startRoute("luna-6", next.snapshot)?.provider, "test", "a refused action publishes no remembered provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused later startup request keeps the completed startup work and the accepted pair", { timeout: 4_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-startup-retention-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    let prompts = 0;
    let promptAttempts = 0;
    let startupHandoffs = 0;
    let startupRefusals = 0;
    const toolResult = { role: "toolResult", toolCallId: "startup-call-1", toolName: "read", content: [{ type: "text", text: "retained startup tool output" }] };
    const session = {
      messages: [] as unknown[],
      model: { provider: "test", id: "worker", contextWindow: 10_000 },
      thinkingLevel: "off",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(_text: string) {
        prompts++;
        const done = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ordinary work finished" }], usage: {} };
        session.messages.push(done);
        for (const listener of listeners) listener({ type: "message_end", message: done });
      },
      async setModel() {}, setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as {
      live: Map<string, typeof session>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }>;
    };
    internals.openWorkerFor = async (args: any) => {
      args.observeSession(session);
      // A trusted worker extension completes one accepted startup request. It
      // runs a tool and answers before it sends a second request.
      args.requestContract.accept({ provider: "test", id: "worker" }, undefined, undefined, () => { startupHandoffs++; });
      const startupAnswer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "startup work finished" }], usage: {} };
      session.messages.push(toolResult, startupAnswer);
      for (const listener of listeners) {
        listener({ type: "tool_execution_end", toolName: "read", result: toolResult, isError: false });
        listener({ type: "message_end", message: startupAnswer });
      }
      // The second startup request carries a drifted effort. The owner refuses it,
      // and Pi records an errored assistant message that carries no text.
      try {
        args.requestContract.accept({ provider: "test", id: "worker" }, "low", undefined, () => { startupHandoffs++; });
      } catch (error) {
        startupRefusals++;
        assert.equal((error as Error).message, WORKER_REQUEST_CONTRACT_ERROR);
      }
      session.messages.push({ role: "assistant", stopReason: "error", errorMessage: WORKER_REQUEST_CONTRACT_ERROR, content: [], usage: {} });
      bindFakeWorkerRequest(session, args.requestContract);
      // Count every ATTEMPT to prompt, outside the acceptance owner.
      const attempted = session.prompt.bind(session);
      session.prompt = async (text: string) => {
        promptAttempts++;
        await attempted(text);
      };
      internals.live.set(args.thread.id, session);
      return { session };
    };
    const ctx = {
      cwd: root,
      hasUI: false,
      modelRegistry: {
        find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id } : undefined; },
        async getAvailable() { return []; },
        hasConfiguredAuth() { return true; },
      },
    } as unknown as ExtensionContext;
    const result = await settlesWithin(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "completed startup work must survive" }, ctx, undefined),
      "the dispatch after a refused later startup request",
      3_000,
    );
    assert.equal(startupHandoffs, 1, "only the matching startup request reaches the provider");
    assert.equal(startupRefusals, 1);
    assert.equal(promptAttempts, 0, "the action starts no ordinary request after the refusal");
    assert.equal(prompts, 0, "no ordinary and no substitute request follows the refused request");
    assert.equal(result.episode.status, "failed");
    assert.equal(result.thread.status, "failed");
    assert.equal(result.thread.outcomeReason, WORKER_REQUEST_CONTRACT_ERROR);
    assert.deepEqual(result.warnings, [WORKER_REQUEST_CONTRACT_ERROR]);
    assert.equal(result.episode.requestedModel, "test/worker");
    assert.equal(result.episode.requestedEffort, "off");
    assert.equal(result.episode.model, "test/worker", "the accepted startup request keeps its true attribution");
    assert.equal(result.episode.effort, "off");
    assert.match(result.episodeText, /startup work finished/);
    assert.match(result.episodeText, /Slate route contract violation/);
    assert.equal(session.messages.filter((message) => message === toolResult).length, 1, "the completed startup tool result is retained");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected worker opening keeps the accepted pair, both diagnostics, and the completed startup work", { timeout: 4_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-rejected-open-retention-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
    let prompts = 0;
    let startupHandoffs = 0;
    let startupRefusals = 0;
    const toolResult = { role: "toolResult", toolCallId: "startup-call-1", toolName: "read", content: [{ type: "text", text: "retained startup tool output" }] };
    const openingListeners = new Set<(event: Record<string, unknown>) => void>();
    const session = {
      messages: [] as unknown[],
      model: { provider: "test", id: "worker", contextWindow: 10_000 },
      thinkingLevel: "off",
      workerReminderHandledToolResult: () => false,
      subscribe(listener: (event: Record<string, unknown>) => void) { openingListeners.add(listener); return () => openingListeners.delete(listener); },
      async prompt() { prompts++; },
      async setModel() {}, setThinkingLevel(level: string) { session.thinkingLevel = level; },
      async abort() {}, dispose() {}, getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as {
      live: Map<string, typeof session>;
      requestContracts: Map<string, WorkerRequestContract>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session }>;
    };
    internals.openWorkerFor = async (args: any) => {
      // The worker session exists and startup completes one accepted request.
      args.observeSession(session);
      args.requestContract.accept({ provider: "test", id: "worker" }, undefined, undefined, () => { startupHandoffs++; });
      const startupAnswer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "startup work finished" }], usage: {} };
      session.messages.push(toolResult, startupAnswer);
      for (const listener of openingListeners) {
        listener({ type: "tool_execution_end", toolName: "read", result: toolResult, isError: false });
        listener({ type: "message_end", message: startupAnswer });
      }
      try {
        args.requestContract.accept({ provider: "test", id: "worker" }, "low", undefined, () => { startupHandoffs++; });
      } catch (error) {
        startupRefusals++;
        assert.equal((error as Error).message, WORKER_REQUEST_CONTRACT_ERROR);
      }
      // A separate startup handler then fails, so opening rejects. The real
      // opening path invalidates and removes the owner before it rethrows.
      args.requestContract.invalidate();
      internals.requestContracts.delete(args.thread.id);
      throw new Error("independent startup handler failed");
    };
    const ctx = {
      cwd: root,
      hasUI: false,
      modelRegistry: {
        find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id } : undefined; },
        async getAvailable() { return []; },
        hasConfiguredAuth() { return true; },
      },
    } as unknown as ExtensionContext;
    const result = await settlesWithin(
      manager.dispatch({ ...TEST_ROUTE, type: "general", task: "a failed opening must report every fact" }, ctx, undefined),
      "the dispatch after a rejected worker opening",
      3_000,
    );
    assert.equal(startupHandoffs, 1);
    assert.equal(startupRefusals, 1);
    assert.equal(prompts, 0, "a rejected opening starts no ordinary request");
    assert.equal(result.episode.status, "failed");
    assert.equal(result.thread.status, "failed");
    assert.match(result.thread.outcomeReason ?? "", /independent startup handler failed/);
    assert.match(result.thread.outcomeReason ?? "", /Slate route contract violation/);
    assert.deepEqual(result.warnings, [WORKER_REQUEST_CONTRACT_ERROR], "the refusal is reported exactly once");
    assert.equal(result.episode.requestedModel, "test/worker");
    assert.equal(result.episode.model, "test/worker", "the accepted startup request keeps its true attribution");
    assert.equal(result.episode.effort, "off");
    assert.match(result.episodeText, /startup work finished/);
    assert.match(result.episodeText, /independent startup handler failed/);
    assert.match(result.episodeText, /Slate route contract violation/);
    assert.equal(internals.live.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
