import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

register("../verification/test-resolve-hooks.mjs", import.meta.url);

const { normalizeFreshContext, ThreadManager } = await import("../extension/threads.ts");
const { SlateStore } = await import("../extension/state.ts");
import type { ThreadRecord } from "../extension/state.ts";
const { NO_SESSION_BASELINE } = await import("../extension/route.ts");
const { threadChoiceLine, registerSlateTools } = await import("../extension/tools.ts");
const load = <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>;
const { estimateTokens } = await load<{ estimateTokens: (message: any) => number }>("../verification/stubs/pi-coding-agent.mjs");

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

function validationHarness(t: { after(callback: () => void): void }, config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join("/tmp", "slate-fresh-context-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, config);
  t.after(() => manager.disposeAll());
  const internal = manager as unknown as {
    live: Map<string, unknown>;
    openWorkerFor: (args: { thread: { id: string } }) => Promise<{ session: ReturnType<typeof session>; baseline: typeof NO_SESSION_BASELINE }>;
    planChoice: (...args: unknown[]) => unknown;
  };
  internal.openWorkerFor = async ({ thread }) => {
    const worker = session();
    internal.live.set(thread.id, worker);
    return { session: worker, baseline: NO_SESSION_BASELINE };
  };
  return { root, store, manager, internal };
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
  const oversized = new Proxy(Array.from({ length: 33 }, () => "never scanned"), {
    get(target, property, receiver) {
      if (property === "every") throw new Error("elements were scanned before the length guard");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => normalizeFreshContext(oversized),
    /accepts at most 32 episode ids/,
  );
});

test("stub token estimation follows pi message roles and character accounting", () => {
  assert.equal(estimateTokens({ role: "user", content: "éééé" }), 1);
  assert.equal(estimateTokens({ role: "user", content: [{ type: "image", data: "ignored" }] }), 1200);
  assert.equal(estimateTokens({ role: "assistant", content: [{ type: "thinking", thinking: "1234" }, { type: "toolCall", name: "read", arguments: { path: "x" } }] }), 5);
  assert.equal(estimateTokens({ role: "bashExecution", command: "abcd", output: "efgh" }), 2);
  assert.equal(estimateTokens({ role: "unknown", content: "a lot" }), 0);
});

test("create without freshContext is accepted", { timeout: 1000 }, async (t) => {
  const { root, store, manager } = validationHarness(t);
  const result = await manager.dispatch({ task: "create", type: "general" }, context(root), undefined);
  assert.equal(result.thread.id, "t1");
  assert.equal(store.threads.has("t1"), true);
});

test("create validates a supplied freshContext value but does not use it", { timeout: 1000 }, async (t) => {
  const { root, store, manager } = validationHarness(t);
  store.episodes.set("t9.e1", { id: "t9.e1", threadId: "t9", task: "seed", status: "ok", file: "", createdAt: 1 });
  const result = await manager.dispatch({ task: "create", type: "general", freshContext: ["t9.e1"] }, context(root), undefined);
  assert.equal(result.thread.id, "t1");
  assert.deepEqual(result.thread.episodeIds, ["t1.e1"]);
});

test("create rejects malformed or unknown freshContext before any state change", { timeout: 1000 }, async (t) => {
  const { root, store, manager, internal } = validationHarness(t);
  for (const freshContext of [null, ["missing"]] as const) {
    await assert.rejects(
      manager.dispatch({ task: "bad create", type: "general", freshContext }, context(root), undefined),
      freshContext === null ? /freshContext must be \[\] or a list/ : /Unknown freshContext episode "missing"/,
    );
    assert.deepEqual([...store.threads.keys()], []);
    assert.deepEqual([...store.episodes.keys()], []);
    assert.equal(internal.live.size, 0);
  }
});

test("a non-acting continuation may omit freshContext", { timeout: 1000 }, async (t) => {
  const { root, store, manager } = validationHarness(t, { threadChoice: { report: true, act: false } });
  const source = sourceRecord();
  store.threads.set(source.id, source);
  const result = await manager.dispatch({ threadId: source.id, task: "continue", type: "general" }, context(root), undefined);
  assert.equal(result.thread.id, source.id);
});

test("a non-acting continuation validates supplied freshContext but ignores it", { timeout: 1000 }, async (t) => {
  const { root, store, manager } = validationHarness(t, { threadChoice: { report: true, act: false } });
  const source = sourceRecord();
  store.threads.set(source.id, source);
  store.episodes.set("t9.e1", { id: "t9.e1", threadId: "t9", task: "seed", status: "ok", file: "", createdAt: 1 });
  const result = await manager.dispatch({ threadId: source.id, task: "continue", type: "general", freshContext: ["t9.e1"] }, context(root), undefined);
  assert.equal(result.thread.id, source.id);
  assert.equal(source.supersededBy, undefined);
});

test("a non-acting continuation rejects malformed or unknown freshContext before state change", { timeout: 1000 }, async (t) => {
  const { root, store, manager, internal } = validationHarness(t, { threadChoice: { report: true, act: false } });
  const source = sourceRecord();
  store.threads.set(source.id, source);
  for (const freshContext of [null, ["missing"]] as const) {
    await assert.rejects(manager.dispatch({ threadId: source.id, task: "bad", freshContext }, context(root), undefined));
    assert.deepEqual(source, sourceRecord());
    assert.deepEqual([...store.episodes.keys()], []);
    assert.equal(internal.live.size, 0);
  }
});

test("an acting continuation must not omit freshContext", { timeout: 1000 }, async (t) => {
  const { root, store, manager, internal } = validationHarness(t, { threadChoice: { report: true, act: true } });
  const source = sourceRecord();
  store.threads.set(source.id, source);
  await assert.rejects(manager.dispatch({ threadId: source.id, task: "missing permission" }, context(root), undefined), /require freshContext/);
  assert.deepEqual(source, sourceRecord());
  assert.deepEqual([...store.episodes.keys()], []);
  assert.equal(internal.live.size, 0);
});

test("an empty acting continuation refuses restart and keeps work on its source", { timeout: 1000 }, async (t) => {
  const { root, store, manager, internal } = validationHarness(t, { threadChoice: { report: true, act: true } });
  const source = sourceRecord();
  store.threads.set(source.id, source);
  const result = await manager.dispatch({ threadId: source.id, task: "refuse restart", freshContext: [] }, context(root), undefined);
  assert.equal(result.thread.id, source.id);
  assert.equal(store.threads.has("t2"), false);
});

test("known episode ids permit an acting continuation to consider restart", { timeout: 1000 }, async (t) => {
  const { root, store, manager, internal } = validationHarness(t, { threadChoice: { report: true, act: true } });
  const source = sourceRecord();
  store.threads.set(source.id, source);
  store.episodes.set("t9.e1", { id: "t9.e1", threadId: "t9", task: "seed", status: "ok", file: "", createdAt: 1 });
  internal.planChoice = () => ({ kind: "continue", code: "short-work", reason: "continue" });
  const result = await manager.dispatch({ threadId: source.id, task: "continue", freshContext: ["t9.e1"] }, context(root), undefined);
  assert.equal(result.thread.id, source.id);
});

test("an acting continuation rejects malformed or unknown freshContext before state change", { timeout: 1000 }, async (t) => {
  const { root, store, manager, internal } = validationHarness(t, { threadChoice: { report: true, act: true } });
  const source = sourceRecord();
  store.threads.set(source.id, source);
  for (const freshContext of [null, ["missing"]] as const) {
    await assert.rejects(manager.dispatch({ threadId: source.id, task: "bad", freshContext }, context(root), undefined));
    assert.deepEqual(source, sourceRecord());
    assert.deepEqual([...store.episodes.keys()], []);
    assert.equal(internal.live.size, 0);
  }
});

test("named freshContext rejects unknown episodes before creating or mutating a thread", { timeout: 1000 }, async () => {
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

test("episode reads revalidate slate ownership and reject external symlinks", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-episode-read-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const episodeDir = join(root, ".pi", "slate", "episodes");
  mkdirSync(episodeDir, { recursive: true });
  const outside = join(root, "outside.md");
  writeFileSync(outside, "outside");
  const insideLink = join(episodeDir, "t1.e1.md");
  symlinkSync(outside, insideLink);
  const store = new SlateStore({ registerTool() {}, appendEntry() {} } as unknown as ExtensionAPI);
  store.episodes.set("t1.e1", { id: "t1.e1", threadId: "t1", task: "x", status: "ok", file: outside, createdAt: 1 });
  const registered = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
  const pi = {
    appendEntry() {},
    registerTool(tool: { name: string; execute(...args: unknown[]): Promise<unknown> }) { registered.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  registerSlateTools(pi, store, () => ({ liveFailoverModel: () => undefined } as never));
  const episodeTool = registered.get("episode");
  assert.ok(episodeTool);
  await assert.rejects(episodeTool.execute("call", { id: "t1.e1" }, undefined, undefined, context(root)), /no longer a safe readable slate episode file/);
  store.episodes.get("t1.e1")!.file = insideLink;
  await assert.rejects(episodeTool.execute("call", { id: "t1.e1" }, undefined, undefined, context(root)), /no longer a safe readable slate episode file/);
});

test("report-only dispatch computes an exact verdict without moving work", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join("/tmp", "slate-dispatch-choice-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, { threadChoice: { report: true, act: false } });
  t.after(() => manager.disposeAll());
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
