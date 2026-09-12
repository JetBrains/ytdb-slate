const TEST_ROUTE = { model: "test/worker", effort: "low", reason: "test fixture" } as const;

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NO_SESSION_BASELINE } from "../extension/route.ts";
import { registerSlateTools } from "../extension/tools.ts";
import { sanitizeThreadRecord, SLATE_STATE_FORMAT, SlateStore, type EpisodeRecord, type ThreadRecord } from "../extension/state.ts";
import { MAX_CONTEXT_EPISODES, messagesForCompression, ThreadManager, type DispatchOptions, type DispatchResult } from "../extension/threads.ts";

function managerHarness(root: string) {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, {});
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

    const routedStore = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const routedManager = new ThreadManager(
      routedStore,
      {},
      undefined,
      () => ({ on: true, candidates: [{ spec: "p/base" }], warnings: [] } as any),
    );
    const routedThread = (routedManager as any).createThread(
      { type: "general", task: "routed", model: "p/requested" },
      { kind: "proceed", effortUnmeasured: false, warnings: [] },
    ) as ThreadRecord;
    assert.equal(routedThread.model, undefined);
    assert.equal("baseModel" in routedThread, false);
    assert.equal("baseEffort" in routedThread, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an action cancelled before its worker call leaves no record", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-cancelled-action-"));
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {});
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
      /unavailable|credentials/,
    );
    assert.equal(store.threads.size, 0);
    assert.equal(store.episodes.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task and pause validation run before thread creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-action-validation-"));
  try {
    const { manager, store } = managerHarness(root);
    const ctx = { cwd: root, modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined, hasConfiguredAuth: () => true, getAvailable: async () => [] } } as unknown as ExtensionContext;
    await assert.rejects(manager.dispatch({ ...TEST_ROUTE, type: "general", task: "" }, ctx, undefined), /non-empty/);
    await assert.rejects(manager.dispatch({ ...TEST_ROUTE, type: "general", task: 7 as unknown as string }, ctx, undefined), /non-empty/);
    store.paused = true;
    await assert.rejects(manager.dispatch({ ...TEST_ROUTE, type: "general", task: "blocked" }, ctx, undefined), /paused/);
    assert.equal(store.threads.size, 0);
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
      { task: "x", type: "general", effort: "low", reason: "why" },
      { task: "x", type: "general", model: 7, effort: "low", reason: "why" },
      { task: "x", type: "general", model: "   ", effort: "low", reason: "why" },
      { task: "x", type: "general", model: "test/worker", reason: "why" },
      { task: "x", type: "general", model: "test/worker", effort: 7, reason: "why" },
      { task: "x", type: "general", model: "test/worker", effort: "   ", reason: "why" },
      { task: "x", type: "general", model: "test/worker", effort: "low" },
      { task: "x", type: "general", model: "test/worker", effort: "low", reason: "" },
      { task: "x", type: "general", model: "test/worker", effort: "low", reason: "   " },
      { task: "x", type: "general", model: "test/worker", effort: "low", reason: "\u0000\u001f" },
      { task: "x", type: "general", model: "test/worker", effort: "low", reason: "\u200b\u2060" },
      { task: "x", type: "general", model: "test/worker", effort: "low", reason: "x".repeat(201) },
    ]) await assert.rejects(manager.dispatch(opts as DispatchOptions, ctx, undefined), /requires|reason must/);
    assert.equal(store.threads.size, 0);

    const boundary = await manager.dispatch({ ...TEST_ROUTE, type: "general", task: "boundary", reason: "x".repeat(200) }, ctx, undefined);
    assert.equal(boundary.episode.reason, "x".repeat(200));
    const cleaned = await manager.dispatch({ ...TEST_ROUTE, type: "general", task: "cleaned", reason: " visible\u2028text\u2029\u200b " }, ctx, undefined);
    assert.equal(cleaned.episode.reason, "visible text");

    const faulted = new ThreadManager(store, {}, undefined, () => ({
      on: false, candidates: [], warnings: [], fault: "slate: retained router fault",
    } as any));
    await assert.rejects(faulted.dispatch({ ...TEST_ROUTE, task: "fault", type: "general" }, ctx, undefined), /retained router fault/);
    assert.equal(store.threads.size, 2);

    const routed = new ThreadManager(store, {}, undefined, () => ({
      on: true,
      candidates: [{ spec: "test/worker", ladder: ["low"], profile: { capabilityMeasuredAt: ["low"], evidenceGapAt: [] } }],
      warnings: [],
    } as any));
    const view = routed as unknown as { runDispatch(thread: ThreadRecord): Promise<ThreadRecord> };
    view.runDispatch = async (thread) => thread;
    const created = await routed.dispatch({ ...TEST_ROUTE, task: "router on", type: "general" }, ctx, undefined) as unknown as ThreadRecord;
    assert.equal("baseModel" in created, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removed fields are absent from the schema and rejected before creation", async () => {
  let threadTool: any;
  const pi = { registerTool(tool: any) { if (tool.name === "thread") threadTool = tool; } } as ExtensionAPI;
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, {});
  registerSlateTools(pi, store, () => manager);
  assert.ok(threadTool);
  assert.equal(Object.hasOwn(threadTool.parameters.properties, "thread"), false);
  assert.equal(Object.hasOwn(threadTool.parameters.properties, "freshContext"), false);
  const ctx = { cwd: process.cwd() } as ExtensionContext;
  await assert.rejects(threadTool.execute("x", { ...TEST_ROUTE, type: "general", task: "x", thread: "t1" }, undefined, undefined, ctx), /field was removed/);
  await assert.rejects(threadTool.execute("x", { ...TEST_ROUTE, type: "general", task: "x", freshContext: [] }, undefined, undefined, ctx), /field was removed/);
  await assert.rejects(manager.dispatch({ ...TEST_ROUTE, threadId: "t1", type: "general", task: "x" }, ctx, undefined), /field was removed/);
  await assert.rejects(manager.dispatch({ ...TEST_ROUTE, freshContext: [], type: "general", task: "x" }, ctx, undefined), /field was removed/);
  assert.equal(store.threads.size, 0);
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
    const manager = new ThreadManager(store, {});
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const session = {
      messages: (compactionEvent === "successful" ? [{ role: "user", content: "earlier turn" }] : []) as unknown[],
      model: undefined,
      thinkingLevel: undefined,
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
      async setModel() {},
      setThinkingLevel() {},
      getContextUsage() { return undefined; },
    };
    const internals = manager as unknown as {
      live: Map<string, typeof session>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: typeof session; baseline: typeof NO_SESSION_BASELINE }>;
    };
    internals.openWorkerFor = async ({ thread }) => {
      internals.live.set(thread.id, session);
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
    baseModel: "p/base", baseEffort: "medium", cacheKeyShard: 1, tools: ["read"],
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
  for (const cacheKeyShard of [undefined, "1", 1.5, -1, 64]) {
    const adopted = sanitizeThreadRecord({ ...valid, status: "failed", episodeId: undefined, cacheKeyShard }, []);
    assert.equal(adopted?.cacheKeyShard, undefined);
  }
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
  const manager = new ThreadManager(store, {});
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
