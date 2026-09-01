import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSlateTools } from "../extension/tools.ts";
import { sanitizeThreadRecord, SlateStore, type EpisodeRecord, type ThreadRecord } from "../extension/state.ts";
import { MAX_CONTEXT_EPISODES, messagesForCompression, ThreadManager, type DispatchOptions, type DispatchResult } from "../extension/threads.ts";

/**
 * A store whose save is a stub. Every test in this file is about the DISPATCH
 * logic around a save — identifiers, context references, validation order — and
 * not about the save itself.
 *
 * The stub is deliberate and bounded: it stores nothing, so no test here can
 * support a claim about persistence. The real save path has its own tests in
 * test/dispatch-persistence.test.ts, which drive a dispatch through the
 * production store, the production durable backend and a real external
 * namespace (TQ1601).
 */
function memoryStore(): SlateStore {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.artifactSessionName = () => undefined;
  store.commit = () => ({ kind: "committed", binding: { policy: "durable-session-v1", identity: "20260820T010203Z-0123456789abcdef", name: "calm-otter-7f3a" } });
  return store;
}

function managerHarness(root: string) {
  const store = memoryStore();
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
    const ctx = { cwd: root } as ExtensionContext;
    const first = await manager.dispatch({ name: "first", type: "general", task: "one" }, ctx, undefined);
    const second = await manager.dispatch({ name: "second", type: "reviewer", task: "two" }, ctx, undefined);
    assert.equal(first.thread.id, "t1");
    assert.equal(second.thread.id, "t2");
    assert.equal(store.threads.size, 2);
    assert.equal(first.thread.episodeId, "t1.e1");
    assert.equal(second.thread.episodeId, "t2.e1");

    const routedStore = memoryStore();
    const routedManager = new ThreadManager(
      routedStore,
      {},
      undefined,
      () => ({ on: true, candidates: [{ spec: "p/base" }], cheapest: "p/base", warnings: [] } as any),
    );
    const routedThread = (routedManager as any).createThread(
      { type: "general", task: "routed", model: "p/requested" },
      { kind: "proceed", baseModel: "p/base", baseEffort: "low" },
    ) as ThreadRecord;
    assert.equal(routedThread.model, undefined);
    assert.equal(routedThread.baseModel, "p/base");
    assert.equal(routedThread.baseEffort, "low");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an action cancelled before its worker call leaves no record", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-cancelled-action-"));
  try {
    const store = memoryStore();
    const manager = new ThreadManager(store, {});
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      manager.dispatch({ type: "general", task: "cancel me" }, { cwd: root } as ExtensionContext, controller.signal),
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
    const ctx = { cwd: root } as ExtensionContext;
    await manager.dispatch({ type: "researcher", task: "follow up", contextEpisodeIds: ["t9.e1", "t8.e1", "t9.e1"] }, ctx, undefined);
    assert.ok(prompts[0]!.indexOf("SECOND") < prompts[0]!.indexOf("FIRST"));
    assert.equal(prompts[0]!.match(/SECOND/g)?.length, 1);

    const before = store.threads.size;
    await assert.rejects(
      manager.dispatch({ type: "general", task: "bad", contextEpisodeIds: Array(MAX_CONTEXT_EPISODES + 1).fill("t8.e1") }, ctx, undefined),
      /at most 32/,
    );
    await assert.rejects(
      manager.dispatch({ type: "general", task: "bad", contextEpisodeIds: "t8.e1" }, ctx, undefined),
      /context must be a list/,
    );
    await assert.rejects(
      manager.dispatch({ type: "general", task: "bad", contextEpisodeIds: [7] }, ctx, undefined),
      /context must be a list/,
    );
    await assert.rejects(
      manager.dispatch({ type: "general", task: "bad", contextEpisodeIds: ["missing.e1"] }, ctx, undefined),
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
      manager.dispatch({ type: "general", task: "must not persist", model: "missing/model" }, ctx, undefined),
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
    const ctx = { cwd: root } as ExtensionContext;
    await assert.rejects(manager.dispatch({ type: "general", task: "" }, ctx, undefined), /non-empty/);
    await assert.rejects(manager.dispatch({ type: "general", task: 7 as unknown as string }, ctx, undefined), /non-empty/);
    store.paused = true;
    await assert.rejects(manager.dispatch({ type: "general", task: "blocked" }, ctx, undefined), /paused/);
    assert.equal(store.threads.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removed fields are absent from the schema and rejected before creation", async () => {
  let threadTool: any;
  const pi = { registerTool(tool: any) { if (tool.name === "thread") threadTool = tool; } } as ExtensionAPI;
  const store = memoryStore();
  const manager = new ThreadManager(store, {});
  registerSlateTools(pi, store, () => manager);
  assert.ok(threadTool);
  assert.equal(Object.hasOwn(threadTool.parameters.properties, "thread"), false);
  assert.equal(Object.hasOwn(threadTool.parameters.properties, "freshContext"), false);
  const ctx = { cwd: process.cwd() } as ExtensionContext;
  await assert.rejects(threadTool.execute("x", { type: "general", task: "x", thread: "t1" }, undefined, undefined, ctx), /field was removed/);
  await assert.rejects(threadTool.execute("x", { type: "general", task: "x", freshContext: [] }, undefined, undefined, ctx), /field was removed/);
  await assert.rejects(manager.dispatch({ threadId: "t1", type: "general", task: "x" }, ctx, undefined), /field was removed/);
  await assert.rejects(manager.dispatch({ freshContext: [], type: "general", task: "x" }, ctx, undefined), /field was removed/);
  assert.equal(store.threads.size, 0);
});

test("episode compression excludes only the injected user prompt", () => {
  const injected = { role: "user", content: "loaded episode text" };
  const assistant = { role: "assistant", content: "result" };
  const compacted = { role: "compactionSummary", content: "summary" };
  assert.deepEqual(messagesForCompression([compacted, injected, assistant], "loaded episode text"), [compacted, assistant]);
  assert.deepEqual(messagesForCompression([assistant], "loaded episode text"), [assistant]);
  assert.deepEqual(messagesForCompression([injected, assistant]), [injected, assistant]);
});

test("the current thread record sanitizer covers every terminal shape", () => {
  const valid = {
    id: "t1", name: "done", status: "successful", type: "reviewer", model: "p/pin",
    baseModel: "p/base", baseEffort: "medium", cacheKeyShard: 1, tools: ["read"],
    episodeId: "t1.e1", outcomeReason: "done", createdAt: 1, updatedAt: 2,
  };
  assert.deepEqual(sanitizeThreadRecord(valid, []), valid);
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
  const store = memoryStore();
  store.commit = () => {
    saves++;
    if (saves === 2) throw new Error("session file unavailable");
    return { kind: "committed", binding: { policy: "durable-session-v1", identity: "20260820T010203Z-0123456789abcdef", name: "calm-otter-7f3a" } };
  };
  const manager = new ThreadManager(store, {});
  await assert.rejects(
    manager.dispatch({ task: "must not start", type: "general" }, {} as ExtensionContext, undefined),
    /Nothing ran and no episode was recorded/,
  );
  assert.equal(store.threads.size, 0);
  assert.equal(store.episodes.size, 0);
});

test("dropped thread records report the invalid field", () => {
  for (const [field, value] of [["name", undefined], ["type", "unknown"], ["status", "idle"]] as const) {
    const repairs: string[] = [];
    const raw = { id: "t1", name: "x", type: "general", status: "failed", [field]: value };
    assert.equal(sanitizeThreadRecord(raw, repairs), undefined);
    assert.deepEqual(repairs, [`thread t1: invalid ${field}`]);
  }
});
