const TEST_ROUTE = { model: "fixture", reason: "test fixture" } as const;

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { bindFakeWorkerRequest } from "./worker-request-contract-fixture.ts";

register("../verification/test-resolve-hooks.mjs", import.meta.url);

const load = <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>;
const { ThreadManager } = await load<typeof import("../extension/threads.ts")>("../extension/threads.ts");
const { compressEpisode, createCompletedFactRecorder, writeFailedEpisode } = await load<typeof import("../extension/episodes.ts")>("../extension/episodes.ts");
const { SlateStore, sanitizeEpisodeRecord } = await load<typeof import("../extension/state.ts")>("../extension/state.ts");
const { registerSlateTools } = await load<typeof import("../extension/tools.ts")>("../extension/tools.ts");
const { NO_SESSION_BASELINE } = await load<typeof import("../extension/logical-model-runtime.ts")>("../extension/logical-model-runtime.ts");
const { OBSERVATIONS_MAX_BYTES } = await load<typeof import("../extension/observations.ts")>("../extension/observations.ts");
const compressorStub: { complete: (...args: unknown[]) => Promise<unknown> } = {
  async complete() { return completeResponse({}); },
};

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
  thinkingLevel: string | undefined;
  sessionFile: undefined;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  shutdownWorker(): Promise<void>;
  dispose(): void;
  shutdownCalls: number;
  disposeCalls: number;
  shutdownPromise: Promise<void> | undefined;
  setModel(model: FakeModel): Promise<void>;
  setThinkingLevel(level: string): void;
  getContextUsage(): undefined;
  workerReminderHandledToolResult(): boolean;
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

type PromptScript = (session: FakeSession, prompt: string) => void | Promise<void>;

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
    async prompt(text) {
      await script(session, text);
    },
    async abort() {},
    shutdownWorker() {
      if (session.shutdownPromise !== undefined) return session.shutdownPromise;
      session.shutdownCalls++;
      session.shutdownPromise = Promise.resolve().then(() => { session.dispose(); });
      return session.shutdownPromise;
    },
    dispose() {
      session.disposeCalls++;
    },
    shutdownCalls: 0,
    disposeCalls: 0,
    shutdownPromise: undefined,
    async setModel(next) {
      session.model = next;
    },
    setThinkingLevel(level) {
      session.thinkingLevel = level;
    },
    getContextUsage() {
      return undefined;
    },
    workerReminderHandledToolResult() {
      return false;
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
  return { provider, id, contextWindow: 200_000, maxTokens: 8192, reasoning: true };
}

function context(cwd: string, models: FakeModel[] = [], headers?: Record<string, string | null>): ExtensionContext {
  const routedWorker = model("test", "worker");
  const bySpec = new Map([routedWorker, ...models].map((entry) => [`${entry.provider}/${entry.id}`, entry]));
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
        return { ok: true, apiKey: "test-key", headers };
      },
      hasConfiguredAuth() {
        return true;
      },
      streamSimple(...args: unknown[]) {
        return { result: async () => {
          try {
            return await compressorStub.complete(...args);
          } catch (error) {
            // Pi's lazy registry stream resolves provider setup throws as zero-usage errors.
            const selected = args[0] as FakeModel;
            return {
              role: "assistant", api: "fixture", provider: selected.provider, model: selected.id,
              content: [], stopReason: "error", timestamp: Date.now(),
              errorMessage: error instanceof Error ? error.message : String(error),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
          }
        } };
      },
    },
  } as unknown as ExtensionContext;
}

function store(): InstanceType<typeof SlateStore> {
  return new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
}

function fixtureRuntime() {
  return createLogicalRuntime({ trusted: true, projectConfig: { router: {
    models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }], replace: [{ model: "claude-sonnet-5", preferredProvider: "test", providers: { test: "compressor" } }] },
    compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }] },
  } } });
}

function managerWithSessions(
  sessions: FakeSession[],
  config: ConstructorParameters<typeof ThreadManager>[1] = {},
  runtime = fixtureRuntime(),
  sharedStore?: InstanceType<typeof SlateStore>,
): InstanceType<typeof ThreadManager> {
  const manager = new ThreadManager(sharedStore ?? store(), config, undefined, runtime, { enabled: true, maxRetries: 1, baseDelayMs: 0 });
  const internals = manager as unknown as {
    live: Map<string, FakeSession>;
    openWorkerFor(args: { thread: { id: string }; open: { model?: string }; requestContract: import("../extension/worker.ts").WorkerRequestContract }): Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
  };
  let next = 0;
  internals.openWorkerFor = async ({ thread, open, requestContract }) => {
    const session = sessions[next++];
    assert.ok(session, "a scripted worker session must exist for every dispatch");
    if (open.model) {
      const [provider, id] = open.model.split("/");
      assert.ok(provider && id);
      session.model = model(provider, id);
    }
    bindFakeWorkerRequest(session, requestContract);
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

/** A store that keeps every durable snapshot Slate saved, newest last. */
function capturingStore(snapshots: unknown[]): InstanceType<typeof SlateStore> {
  return new SlateStore({
    appendEntry(_customType: string, data: unknown) { snapshots.push(structuredClone(data)); },
  } as unknown as ExtensionAPI);
}

/** The exact prompt text of one compression request. */
function promptTextOf(request: unknown): string {
  const text = (request as { messages?: Array<{ content?: Array<{ type?: string; text?: string }> }> } | null)
    ?.messages?.[0]?.content?.[0]?.text;
  assert.equal(typeof text, "string", "one compression request carries one text prompt");
  return text as string;
}

/** The transcript region of one compression prompt, without the fixed instructions. */
function transcriptOf(prompt: string): string {
  const marker = "Transcript:\n";
  const start = prompt.indexOf(marker);
  assert.ok(start >= 0, "the compression prompt carries one transcript section");
  return prompt.slice(start + marker.length);
}

interface DurableExpectation {
  status: "ok" | "failed";
  reason?: string;
  logicalModel?: string;
  requestedModel?: string;
  requestedEffort?: string;
  model?: string;
  effort?: string;
  outcomeReason?: RegExp;
}

/**
 * The four durable consumers of one retained action: exact persisted bytes (D1),
 * the restored durable snapshot (D2), the production episode tool (D3), and one
 * later action's prompt (D4). It returns that later prompt for extra checks.
 */
async function assertDurableConsumers(opts: {
  snapshot: unknown;
  cwd: string;
  result: { episode: { id: string; file: string }; episodeText: string; thread: { id: string } };
  expect: DurableExpectation;
  laterContains?: RegExp[];
  laterTask?: string;
}): Promise<string> {
  const { result } = opts;
  const want = opts.expect;
  const label = result.episode.id;
  assert.equal(readFileSync(result.episode.file, "utf8"), result.episodeText, `${label}: D1 exact episode bytes`);
  const ctx = context(opts.cwd);
  const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  restored.adoptSnapshot(opts.snapshot as Parameters<InstanceType<typeof SlateStore>["adoptSnapshot"]>[0], ctx);
  const thread = restored.threads.get(result.thread.id);
  assert.equal(thread?.episodeId, label, `${label}: D2 restored thread reference`);
  assert.equal(thread?.status, want.status === "ok" ? "successful" : "failed", `${label}: D2 restored thread status`);
  if (want.outcomeReason !== undefined) {
    assert.match(thread?.outcomeReason ?? "", want.outcomeReason, `${label}: D2 restored terminal cause`);
  }
  const episode = restored.episodes.get(label);
  assert.equal(episode?.file, result.episode.file, `${label}: D2 restored file identity`);
  assert.equal(episode?.status, want.status, `${label}: D2 restored status`);
  for (const field of ["reason", "logicalModel", "requestedModel", "requestedEffort", "model", "effort"] as const) {
    const expected = want[field];
    if (expected !== undefined) assert.equal(episode?.[field], expected, `${label}: D2 restored ${field}`);
  }
  let episodeTool: { execute(...args: unknown[]): Promise<{ content: Array<{ type: string; text?: string }> }> } | undefined;
  registerSlateTools(
    { registerTool(tool: { name: string }) { if (tool.name === "episode") episodeTool = tool as unknown as typeof episodeTool; } } as unknown as ExtensionAPI,
    restored,
    () => new ThreadManager(restored, {}, undefined, fixtureRuntime()),
  );
  assert.ok(episodeTool, `${label}: production episode tool registered`);
  const fetched = await episodeTool.execute("call", { id: label }, undefined, undefined, ctx);
  assert.equal(fetched.content[0]?.text, result.episodeText, `${label}: D3 episode tool bytes`);
  const later = new ThreadManager(restored, {}, undefined, fixtureRuntime());
  const laterTask = opts.laterTask ?? "later durable consumer";
  const laterPrompt = (later as unknown as { buildPrompt(o: { task: string; contextEpisodeIds: string[] }, cwd: string): string })
    .buildPrompt({ task: laterTask, contextEpisodeIds: [label] }, opts.cwd);
  assert.match(laterPrompt, new RegExp(label.replace(".", "\\.")), `${label}: D4 later context identity`);
  assert.match(laterPrompt, new RegExp(laterTask), `${label}: D4 later action text`);
  for (const pattern of opts.laterContains ?? []) {
    assert.match(laterPrompt, pattern, `${label}: D4 retained content`);
  }
  return laterPrompt;
}

async function assertNoEpisodeConsumers(
  source: InstanceType<typeof SlateStore>,
  cwd: string,
  episodeId: string,
  durableSnapshot?: unknown,
): Promise<void> {
  const snapshot = durableSnapshot as Parameters<InstanceType<typeof SlateStore>["adoptSnapshot"]>[0]
    ?? (source as unknown as { snapshot(): Parameters<InstanceType<typeof SlateStore>["adoptSnapshot"]>[0] }).snapshot();
  const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const ctx = context(cwd);
  restored.adoptSnapshot(snapshot, ctx);
  assert.equal(restored.episodes.has(episodeId), false, `${episodeId}: restored state has no episode`);
  const threadId = episodeId.split(".")[0]!;
  assert.equal(restored.threads.get(threadId)?.episodeId, undefined, `${episodeId}: restored thread has no episode reference`);

  let episodeTool: { execute(...args: unknown[]): Promise<unknown> } | undefined;
  registerSlateTools(
    { registerTool(tool: { name: string }) { if (tool.name === "episode") episodeTool = tool as unknown as typeof episodeTool; } } as unknown as ExtensionAPI,
    restored,
    () => new ThreadManager(restored, {}, undefined, fixtureRuntime()),
  );
  assert.ok(episodeTool);
  await assert.rejects(episodeTool.execute("call", { id: episodeId }, undefined, undefined, ctx), /Unknown episode/);

  const later = new ThreadManager(restored, {}, undefined, fixtureRuntime());
  const before = restored.threads.size;
  await assert.rejects(
    later.dispatch({ ...TEST_ROUTE, task: "inverse durable consumer", type: "general", contextEpisodeIds: [episodeId] }, ctx, undefined),
    /Unknown context episode/,
  );
  assert.equal(restored.threads.size, before, `${episodeId}: later context rejection allocates no thread`);
}

function completeResponse(usage: TokenUsage, stopReason = "stop", errorMessage = "transient provider failure") {
  return {
    stopReason,
    errorMessage: stopReason === "error" ? errorMessage : undefined,
    content: stopReason === "error" ? [] : [{ type: "text", text: "## Intent\ncompressed" }],
    usage: { ...usage },
  };
}

test("model authorization failures are sanitized before thread creation", async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const ctx = context(cwd, [ran]);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("auth backend\nfailed"); };
  const manager = managerWithSessions([]);
  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "validate auth", type: "general" }, ctx, undefined),
    /credentials/,
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(internalStore.threads.size, 0);
  assert.equal(internalStore.episodes.size, 0);
  await assertNoEpisodeConsumers(internalStore, cwd, "t1.e1");
});

test("pre-start aborts leave no thread or episode record", async (t) => {
  const cwd = temporaryProject(t);
  const controller = new AbortController();
  controller.abort();
  const manager = managerWithSessions([]);
  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "caller abort", type: "general" }, context(cwd), controller.signal),
    /cancelled before the action started/,
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(internalStore.threads.size, 0);
  assert.equal(internalStore.episodes.size, 0);
  await assertNoEpisodeConsumers(internalStore, cwd, "t1.e1");
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
  compressorStub.complete = async (...args: unknown[]) => {
    compressionCalls++;
    assert.match(JSON.stringify(args[1]), /partial work to preserve/);
    return completeResponse({ input: 3, output: 1, cost: { total: 0.01 } });
  };
  const snapshots: unknown[] = [];
  const manager = managerWithSessions([session], {}, fixtureRuntime(), capturingStore(snapshots));
  const result = await manager.dispatch(
    { ...TEST_ROUTE, task: "record failed work", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  const episode = internalStore.episodes.get("t1.e1");
  assert.equal(compressionCalls, 1);
  assert.equal(result.episode.id, "t1.e1");
  assert.equal(result.episodeText, readFileSync(result.episode.file, "utf8"));
  assert.equal(episode?.status, "failed");
  assert.equal(episode?.reason, TEST_ROUTE.reason);
  assert.equal(episode?.logicalModel, TEST_ROUTE.model);
  assert.equal(episode?.requestedModel, "test/worker");
  assert.equal(episode?.requestedEffort, "off");
  assert.equal(episode?.model, "test/worker");
  assert.equal(episode?.workerCostUsd, 0.125);
  assert.equal(episode?.compressorCostUsd, 0.01);
  assert.equal(internalStore.threads.get("t1")?.status, "failed");
  assert.equal(internalStore.threads.get("t1")?.episodeId, "t1.e1");
  const text = readFileSync(episode!.file, "utf8");
  assert.match(text, /STATUS: FAILED/);
  assert.match(text, /## Intent\ncompressed/);
  assert.doesNotMatch(text, /> status: FAILED/);
  // O1: one fact-bearing failed action with successful compression reaches every
  // durable consumer, and each consumer keeps the logical, requested and accepted
  // identity of that action.
  await assertDurableConsumers({
    snapshot: snapshots.at(-1),
    cwd,
    result,
    expect: {
      status: "failed",
      reason: TEST_ROUTE.reason,
      logicalModel: TEST_ROUTE.model,
      requestedModel: "test/worker",
      requestedEffort: "off",
      model: "test/worker",
      effort: "off",
    },
    laterTask: "later failed-fact consumer",
    laterContains: [/## Intent\ncompressed/, /ran: test\/worker @ off/],
  });
});

test("a successful action keeps its format and reaches every durable consumer", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession(successfulPrompt([{ input: 3, output: 5, cost: { total: 0.05 } }]), ran);
  let compressionCalls = 0;
  compressorStub.complete = async () => {
    compressionCalls++;
    return completeResponse({ input: 2, output: 1, cost: { total: 0.02 } });
  };
  const snapshots: unknown[] = [];
  const result = await managerWithSessions([session], {}, fixtureRuntime(), capturingStore(snapshots)).dispatch(
    { ...TEST_ROUTE, task: "succeed durably", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  assert.equal(compressionCalls, 1);
  assert.equal(result.episode.status, "ok");
  assert.equal(result.thread.status, "successful");
  // The successful format is unchanged: an OK header, the compressor body, no
  // failure line and no bounded-fallback notice.
  assert.match(result.episodeText, /STATUS: OK/);
  assert.match(result.episodeText, /ran: test\/worker @ off/);
  assert.match(result.episodeText, /## Intent\ncompressed/);
  assert.doesNotMatch(result.episodeText, /> failure:/);
  assert.doesNotMatch(result.episodeText, /bounded completed result was retained/i);
  await assertDurableConsumers({
    snapshot: snapshots.at(-1),
    cwd,
    result,
    expect: {
      status: "ok",
      reason: TEST_ROUTE.reason,
      logicalModel: TEST_ROUTE.model,
      requestedModel: "test/worker",
      requestedEffort: "off",
      model: "test/worker",
      effort: "off",
    },
    laterTask: "later successful consumer",
    laterContains: [/STATUS: OK/, /## Intent\ncompressed/],
  });
});

test("a throwing progress callback stays separate from a successful action", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]), ran);
  session.workerReminderHandledToolResult = () => true;
  compressorStub.complete = async () => completeResponse({ input: 1, output: 1, cost: { total: 0.01 } });
  let progressCalls = 0;
  const manager = managerWithSessions([session]);
  const result = await manager.dispatch(
    { ...TEST_ROUTE, task: "survive progress failure", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
    () => {
      progressCalls++;
      throw new Error("progress sink failed");
    },
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.ok(progressCalls > 0);
  assert.equal(result.episode.status, "ok");
  assert.equal(result.thread.status, "successful");
  assert.equal(result.thread.outcomeReason, undefined);
  assert.equal(result.warnings.filter((warning) => warning.includes("progress sink failed")).length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("worker tool result reached the reminder handler")));
  assert.match(result.episodeText, /STATUS: OK/);
  assert.equal(internalStore.threads.get("t1")?.status, "successful");
});

test("failed actions without a worker response write one fixed episode without compression", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession(async () => {
    throw new Error("provider stopped before response");
  }, ran);
  let compressionCalls = 0;
  compressorStub.complete = async () => {
    compressionCalls++;
    throw new Error("the no-response path must not call compression");
  };
  const manager = managerWithSessions([session]);
  const result = await manager.dispatch(
    { ...TEST_ROUTE, task: "record empty failure", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  const episode = internalStore.episodes.get("t1.e1");
  assert.equal(compressionCalls, 0);
  assert.equal(result.episode.status, "failed");
  assert.equal(result.episodeText, readFileSync(result.episode.file, "utf8"));
  assert.equal(episode?.status, "failed");
  assert.equal(episode?.reason, TEST_ROUTE.reason);
  assert.equal(episode?.logicalModel, TEST_ROUTE.model);
  assert.equal(episode?.requestedModel, "test/worker");
  assert.equal(episode?.requestedEffort, "off");
  assert.equal(episode?.model, "test/worker");
  assert.equal(internalStore.episodes.size, 1);
  assert.equal(internalStore.threads.get("t1")?.episodeId, "t1.e1");
  const text = readFileSync(episode!.file, "utf8");
  assert.match(text, /STATUS: FAILED/);
  assert.match(text, /> task: record empty failure/);
  assert.match(text, /> status: FAILED/);
  assert.match(text, /> error: The worker prompt threw without cancellation evidence/);
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
  compressorStub.complete = async () => {
    compressionCalls++;
    return completeResponse({});
  };
  const result = await managerWithSessions([session]).dispatch(
    { ...TEST_ROUTE, task: "do not summarize emptiness", type: "general" },
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
  compressorStub.complete = async () => {
    compressionCalls++;
    return completeResponse({ cost: { total: 0 } });
  };
  const result = await managerWithSessions([session]).dispatch(
    { ...TEST_ROUTE, task: "preserve zero-cost evidence", type: "general" },
    context(cwd, [compressor]),
    undefined,
  );
  assert.equal(compressionCalls, 1);
  assert.equal(result.episode.status, "failed");
  assert.equal(result.episode.workerCostUsd, 0);
  assert.doesNotMatch(result.episodeText, /failed before the worker produced a response/);
});

test("partial streaming text does not become a completed fact after history rewrite", { timeout: 1000 }, async (t) => {
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
  compressorStub.complete = async () => {
    compressionCalls++;
    return completeResponse({ input: 1, output: 1, cost: { total: 0.01 } });
  };
  const result = await managerWithSessions([session]).dispatch(
    { ...TEST_ROUTE, task: "preserve rewritten response", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  assert.equal(compressionCalls, 0);
  assert.equal(result.episode.status, "failed");
  assert.match(result.episodeText, /failed before the worker produced a response/);
});

test("a partial stream with recorded billing evidence compresses without any completed fact", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession((current) => {
    const message = {
      role: "assistant", stopReason: "pending",
      content: [{ type: "text", text: "UNFINISHED BILLED DELTA" }],
      usage: { input: 4, output: 2, cost: { total: 0.2 } },
    };
    current.messages.push(message);
    // One real history-compaction event is this action's only billing evidence.
    current.emit({ type: "compaction_end", result: { usage: { input: 7, output: 3, cost: { total: 0.4 } } } });
    current.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "UNFINISHED BILLED DELTA" } });
    throw new Error("provider stopped mid-stream");
  }, ran);
  let compressionCalls = 0;
  let compressorPrompt = "";
  compressorStub.complete = async (...args: unknown[]) => {
    compressionCalls++;
    compressorPrompt = promptTextOf(args[1]);
    return completeResponse({ input: 1, output: 1, cost: { total: 0.01 } });
  };
  const snapshots: unknown[] = [];
  const result = await managerWithSessions([session], {}, fixtureRuntime(), capturingStore(snapshots)).dispatch(
    { ...TEST_ROUTE, task: "bill without a completed fact", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  // T3: recorded billing evidence selects the compression branch, which the
  // fixed-failure branch of the partial-stream case above never reaches.
  assert.equal(compressionCalls, 1);
  assert.equal(result.episode.status, "failed");
  assert.equal(result.episode.compactionCostUsd, 0.4);
  assert.deepEqual(result.episode.compactionUsage, { input: 7, output: 3 });
  assert.doesNotMatch(result.episodeText, /failed before the worker produced a response/);
  // The unfinished delta is no completed fact, so the compression input carries
  // only the terminal diagnostics.
  assert.equal(
    transcriptOf(compressorPrompt),
    "\n\n[dispatch diagnostics: The worker prompt threw without cancellation evidence.]",
    "a partial stream contributes no completed fact to the compression input",
  );
  assert.doesNotMatch(compressorPrompt, /UNFINISHED BILLED DELTA/);
  assert.doesNotMatch(result.episodeText, /UNFINISHED BILLED DELTA/);
  assert.doesNotMatch(result.episodeText, /\[final assistant text/);
  assert.doesNotMatch(result.episodeText, /\[completed tool result/);
  await assertDurableConsumers({
    snapshot: snapshots.at(-1),
    cwd,
    result,
    expect: {
      status: "failed",
      reason: TEST_ROUTE.reason,
      logicalModel: TEST_ROUTE.model,
      requestedModel: "test/worker",
      requestedEffort: "off",
      model: "test/worker",
      effort: "off",
      outcomeReason: /threw without cancellation evidence/,
    },
    laterTask: "later partial-stream consumer",
    laterContains: [/threw without cancellation evidence/],
  });
});

test("finalized response evidence survives a rewritten worker message list", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession((current) => {
    const message = {
      role: "assistant", stopReason: "error", errorMessage: "provider stopped",
      content: [{ type: "text", text: "FINALIZED WORK BEFORE REWRITE" }],
      usage: { input: 2, output: 1, cost: { total: 0.05 } },
    };
    current.messages.push(message);
    current.emit({ type: "message_end", message });
    current.messages.length = 0;
    throw new Error("host rewrote the transcript");
  }, ran);
  let compressionCalls = 0;
  compressorStub.complete = async (...args: unknown[]) => {
    compressionCalls++;
    assert.match(JSON.stringify(args[1]), /FINALIZED WORK BEFORE REWRITE/);
    return completeResponse({ input: 1, output: 1, cost: { total: 0.01 } });
  };
  const result = await managerWithSessions([session]).dispatch(
    { ...TEST_ROUTE, task: "preserve finalized rewritten response", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  assert.equal(compressionCalls, 1);
  assert.equal(result.episode.status, "failed");
  assert.doesNotMatch(result.episodeText, /failed before the worker produced a response/);
});

test("finalized length text remains a completed fact without changing successful outcome semantics", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession((current) => {
    const message = {
      role: "assistant", stopReason: "length",
      content: [{ type: "text", text: "FINAL LENGTH-LIMITED TEXT" }],
      usage: {},
    };
    current.messages.push(message);
    current.emit({ type: "message_end", message });
  });
  const result = await managerWithSessions([session]).dispatch(
    { ...TEST_ROUTE, task: "retain length completion", type: "general" },
    context(cwd),
    undefined,
  );
  assert.equal(result.episode.status, "ok");
  assert.equal(result.thread.status, "successful");
  assert.match(result.episodeText, /stop reason=length/);
  assert.match(result.episodeText, /FINAL LENGTH-LIMITED TEXT/);
});

test("completed fact recording keeps a bounded newest suffix and one omission marker", () => {
  const recorder = createCompletedFactRecorder();
  recorder.addAssistant("   ", "stop");
  for (let index = 0; index < 50; index++) {
    recorder.addTool("read", { content: [{ type: "text", text: "x".repeat(9_000) + `-FACT-${index}` }] }, false);
  }
  recorder.addAssistant("FINAL-ASSISTANT", "length");
  const frozen = recorder.freeze();
  assert.equal(frozen.hasFacts, true);
  assert.equal(frozen.omitted, true);
  assert.ok(frozen.text.length <= 300_000);
  assert.doesNotMatch(frozen.text, /-FACT-0/);
  assert.match(frozen.text, /-FACT-49/);
  assert.match(frozen.text, /FINAL-ASSISTANT/);
  assert.equal(frozen.text.match(/older completed facts omitted or truncated/g)?.length, 1);
  assert.strictEqual(recorder.freeze(), frozen, "freeze is at most once");

  for (const stopReason of ["stop", "error", "aborted", "length"] as const) {
    const classified = createCompletedFactRecorder();
    classified.addAssistant(`FINAL-${stopReason}`, stopReason);
    const fact = classified.freeze();
    assert.equal(fact.hasFacts, true, stopReason);
    assert.match(fact.text, new RegExp(`stop reason=${stopReason}`));
    assert.match(fact.text, new RegExp(`FINAL-${stopReason}`));
  }
});

test("completed facts bound multi-block traversal, oversized labels, and all tool-result kinds", () => {
  const megabyte = "x".repeat(1_000_000);
  const newest = `${"n".repeat(999_980)}NEWEST-MULTI-BLOCK`;
  const blocks = [
    ...Array.from({ length: 63 }, () => ({ type: "text", text: megabyte })),
    { type: "text", text: newest },
  ];
  const originalJoin = Array.prototype.join;
  let attemptedOversizedJoin = false;
  Object.defineProperty(Array.prototype, "join", {
    configurable: true,
    writable: true,
    value(this: unknown[], separator?: string) {
      const copiedChars = this.reduce<number>(
        (total, value) => total + (typeof value === "string" ? value.length : 0),
        0,
      );
      if (copiedChars > 100_000) {
        attemptedOversizedJoin = true;
        throw new Error("full multi-block materialization attempted");
      }
      return Reflect.apply(originalJoin, this, [separator]);
    },
  });
  try {
    const tool = createCompletedFactRecorder();
    assert.doesNotThrow(() => tool.addTool("bulk", { content: blocks }, false));
    const toolFacts = tool.freeze();
    assert.equal(toolFacts.facts.length, 1);
    assert.ok(toolFacts.facts[0]!.text.length <= 8_000);
    assert.match(toolFacts.text, /NEWEST-MULTI-BLOCK/);
    assert.doesNotMatch(toolFacts.text, /^x{100000}/);

    const assistantFacts = createCompletedFactRecorder();
    assert.doesNotThrow(() => assistantFacts.addAssistant(blocks, "stop"));
    assert.ok(assistantFacts.freeze().facts[0]!.text.length <= 8_000);
    assert.match(assistantFacts.freeze().text, /NEWEST-MULTI-BLOCK/);
  } finally {
    Object.defineProperty(Array.prototype, "join", {
      configurable: true,
      writable: true,
      value: originalJoin,
    });
  }
  assert.equal(attemptedOversizedJoin, false, "insertion never joins the full multi-block value");

  for (const toolName of ["n".repeat(8_000), "n".repeat(20_000)]) {
    const zeroRoom = createCompletedFactRecorder();
    zeroRoom.addTool(toolName, { content: [{ type: "text", text: "RAW-BODY-MUST-NOT-ESCAPE".repeat(10_000) }] }, false);
    const frozen = zeroRoom.freeze();
    assert.equal(frozen.facts.length, 1);
    assert.ok(frozen.facts[0]!.label.length <= 7_997);
    assert.ok(frozen.facts[0]!.text.length <= 8_000);
    assert.doesNotMatch(frozen.facts[0]!.text, /RAW-BODY-MUST-NOT-ESCAPE/);
    assert.equal(frozen.omitted, true);
  }

  const kinds = createCompletedFactRecorder();
  kinds.addTool("empty", { content: [] }, false);
  kinds.addTool("image", { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }, false);
  kinds.addTool("mixed", { content: [{ type: "image", data: "SECRET", mimeType: "image/png" }, { type: "text", text: "VISIBLE" }] }, false);
  const frozenKinds = kinds.freeze();
  assert.equal(frozenKinds.facts.length, 3, "empty and non-text results each record completion");
  assert.match(frozenKinds.text, /completed tool result: empty/);
  assert.match(frozenKinds.text, /completed tool result: image/);
  assert.match(frozenKinds.text, /completed tool result: mixed/);
  assert.match(frozenKinds.text, /VISIBLE/);
  assert.doesNotMatch(frozenKinds.text, /AA==|SECRET/);
  assert.equal(frozenKinds.omitted, true);
  assert.equal(frozenKinds.text.match(/older completed facts omitted or truncated/g)?.length, 1);
});

test("ThreadManager bounds multi-block assistant event and observation capture before joining", { timeout: 4_000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const megabyte = "x".repeat(1_000_000);
  const newest = `${"n".repeat(999_980)}NEWEST-MULTI-BLOCK`;
  const blocks = [
    ...Array.from({ length: 63 }, () => ({ type: "text", text: megabyte })),
    { type: "text", text: newest },
  ];
  let enterPrompt!: () => void;
  const promptEntered = new Promise<void>((resolve) => { enterPrompt = resolve; });
  let releaseAssistant!: () => void;
  const assistantGate = new Promise<void>((resolve) => { releaseAssistant = resolve; });
  const session = fakeSession(async (current) => {
    enterPrompt();
    await assistantGate;
    const message = { role: "assistant", stopReason: "stop", content: blocks, usage: {} };
    current.messages.push(message);
    current.emit({ type: "message_end", message });
  }, ran);
  const snapshots: unknown[] = [];
  const manager = managerWithSessions([session], {}, fixtureRuntime(), capturingStore(snapshots));
  const originalComplete = compressorStub.complete;
  const originalJoin = Array.prototype.join;
  let attemptedOversizedJoin = false;
  compressorStub.complete = async () => { throw new Error("compressor unavailable"); };
  Object.defineProperty(Array.prototype, "join", {
    configurable: true,
    writable: true,
    value(this: unknown[], separator?: string) {
      const copiedChars = this.reduce<number>(
        (total, value) => total + (typeof value === "string" ? value.length : 0),
        0,
      );
      if (copiedChars > 100_000) {
        attemptedOversizedJoin = true;
        throw new Error("full multi-block materialization attempted");
      }
      return Reflect.apply(originalJoin, this, [separator]);
    },
  });
  try {
    const pending = manager.dispatch(
      { ...TEST_ROUTE, task: "bound production assistant capture", type: "general" },
      context(cwd, [ran, compressor]),
      undefined,
    );
    await promptEntered;
    releaseAssistant();
    const result = await pending;

    const factPrefix = "[final assistant text, stop reason=stop]\n";
    const expectedFact = `${factPrefix}${newest.slice(-(8_000 - factPrefix.length))}`;
    assert.equal(attemptedOversizedJoin, false, "neither production assistant entry path joins the full block array");
    assert.equal(result.episode.status, "ok");
    assert.ok(result.episodeText.includes(expectedFact), "event capture persists the exact bounded newest suffix");
    assert.match(result.episodeText, /older completed facts omitted or truncated/);
    assert.doesNotMatch(result.episodeText, /^x{100000}/m);

    const observation = result.episode.observations;
    assert.ok(observation?.stored, "the production observation path stores the final assistant text");
    const observationText = readFileSync(join(cwd, observation.path), "utf8");
    assert.equal(observation.truncated, true, "observation capture reports truncation for oversized content");
    assert.equal(observation.bytes, OBSERVATIONS_MAX_BYTES + 15, "stored byte count matches bounded content plus marker");
    assert.equal(
      observationText,
      `${"x".repeat(OBSERVATIONS_MAX_BYTES)} […truncated]`,
      "observation capture stores the exact bounded oldest prefix",
    );
    assert.ok(
      result.episodeText.includes(`> observations: stored | path: ${observation.path}`),
      "the durable episode names the production observation artifact",
    );

    const laterPrompt = await assertDurableConsumers({
      snapshot: snapshots.at(-1),
      cwd,
      result,
      expect: {
        status: "ok",
        reason: TEST_ROUTE.reason,
        logicalModel: TEST_ROUTE.model,
        requestedModel: "test/worker",
        requestedEffort: "off",
        model: "test/worker",
        effort: "off",
      },
      laterTask: "later bounded-assistant consumer",
      laterContains: [/NEWEST-MULTI-BLOCK/, /older completed facts omitted or truncated/],
    });
    assert.ok(laterPrompt.includes(expectedFact), "D4 carries the exact event-capture suffix");
  } finally {
    compressorStub.complete = originalComplete;
    Object.defineProperty(Array.prototype, "join", {
      configurable: true,
      writable: true,
      value: originalJoin,
    });
  }
});

test("empty and image-only completed tools remain durable after caller cancellation", { timeout: 4_000 }, async (t) => {
  for (const scenario of ["empty", "image"] as const) await t.test(scenario, { timeout: 2_000 }, async (t) => {
    const cwd = temporaryProject(t);
    const ran = model("test", "worker");
    const controller = new AbortController();
    const resultContent = scenario === "empty"
      ? []
      : [{ type: "image", data: "IMAGE-BYTES-MUST-NOT-PERSIST", mimeType: "image/png" }];
    const session = fakeSession((current) => {
      current.emit({
        type: "tool_execution_end",
        toolName: scenario,
        result: { content: resultContent },
        isError: false,
      });
      const aborted = { role: "assistant", stopReason: "aborted", content: [], usage: {} };
      current.messages.push(aborted);
      current.emit({ type: "message_end", message: aborted });
      controller.abort();
    }, ran);
    const snapshots: unknown[] = [];
    const result = await managerWithSessions([session], {}, fixtureRuntime(), capturingStore(snapshots)).dispatch(
      { ...TEST_ROUTE, task: `${scenario} completed result`, type: "general" },
      context(cwd, [ran]),
      controller.signal,
    );
    assert.equal(result.episode.status, "failed");
    assert.equal(result.thread.status, "failed");
    assert.match(result.episodeText, new RegExp(`completed tool result: ${scenario}`));
    assert.match(result.episodeText, /worker action was cancelled/);
    if (scenario === "empty") {
      assert.doesNotMatch(result.episodeText, /completed fact content omitted/);
    } else {
      assert.match(result.episodeText, /completed fact content omitted/);
      assert.doesNotMatch(result.episodeText, /IMAGE-BYTES-MUST-NOT-PERSIST/);
    }
    await assertDurableConsumers({
      snapshot: snapshots.at(-1),
      cwd,
      result,
      expect: {
        status: "failed",
        reason: TEST_ROUTE.reason,
        logicalModel: TEST_ROUTE.model,
        requestedModel: "test/worker",
        requestedEffort: "off",
        model: "test/worker",
        effort: "off",
        outcomeReason: /worker action was cancelled/,
      },
      laterTask: `later ${scenario} consumer`,
      laterContains: [new RegExp(`completed tool result: ${scenario}`), /worker action was cancelled/],
    });
  });
});

test("an omitted bounded fallback persists exact bytes and reaches every durable consumer", { timeout: 2000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const facts = Array.from({ length: 50 }, (_value, index) => ({
    tool: "read",
    text: `${"y".repeat(9_000)}-OLD-${index}`,
  }));
  const session = fakeSession((current) => {
    for (const fact of facts) {
      current.emit({
        type: "tool_execution_end",
        toolName: fact.tool,
        result: { content: [{ type: "text", text: fact.text }] },
        isError: false,
      });
    }
    throw new Error("host stopped the worker");
  }, ran);
  compressorStub.complete = async () => { throw new Error("compressor unavailable"); };
  const snapshots: unknown[] = [];
  const result = await managerWithSessions([session], {}, fixtureRuntime(), capturingStore(snapshots)).dispatch(
    { ...TEST_ROUTE, task: "retain the newest suffix", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  // O2: rebuild the same bounded record from the same facts in the same order,
  // then compare the persisted fallback bytes with it by equality.
  const expected = createCompletedFactRecorder();
  for (const fact of facts) expected.addTool(fact.tool, { content: [{ type: "text", text: fact.text }] }, false);
  const frozen = expected.freeze();
  assert.equal(frozen.omitted, true, "the fixture must exceed the bounded record");
  const diagnostics = "The worker prompt threw without cancellation evidence.";
  const expectedTail = `${["", frozen.text, "", "## Open Issues", diagnostics].join("\n")}\n`;
  const persisted = readFileSync(result.episode.file, "utf8");
  assert.equal(persisted, result.episodeText, "D1 exact episode bytes");
  assert.equal(
    persisted.slice(persisted.length - expectedTail.length),
    expectedTail,
    "the persisted bounded fallback equals the newest retained suffix and the unchanged worker cause",
  );
  assert.equal(persisted.match(/older completed facts omitted or truncated/g)?.length, 1);
  assert.match(persisted, /-OLD-49/);
  assert.doesNotMatch(persisted, /-OLD-0(?![0-9])/);
  assert.match(persisted, /threw without cancellation evidence/i);
  assert.equal(result.episode.status, "failed");
  await assertDurableConsumers({
    snapshot: snapshots.at(-1),
    cwd,
    result,
    expect: {
      status: "failed",
      reason: TEST_ROUTE.reason,
      logicalModel: TEST_ROUTE.model,
      requestedModel: "test/worker",
      requestedEffort: "off",
      model: "test/worker",
      effort: "off",
      outcomeReason: /threw without cancellation evidence/,
    },
    laterTask: "later omitted-suffix consumer",
    laterContains: [/-OLD-49/, /older completed facts omitted or truncated/],
  });
});

test("overlapping terminal callers convert one fact once, compress once, save once, and dispose once", { timeout: 2000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const controller = new AbortController();
  let contentReads = 0;
  const toolResult = {
    get content() {
      contentReads++;
      return [{ type: "text", text: "OVERLAP TOOL FACT" }];
    },
  };
  let manager!: InstanceType<typeof ThreadManager>;
  let teardown: Promise<void> | undefined;
  let prompts = 0;
  let settleCalls = 0;
  let closeCalls = 0;
  const session = fakeSession((current) => {
    prompts++;
    current.emit({ type: "tool_execution_end", toolName: "read", result: toolResult, isError: false });
    // Two terminal owners start while the worker call is still running.
    controller.abort();
    teardown = manager.disposeAll();
    const emptyAbort = { role: "assistant", stopReason: "aborted", content: [], usage: {} };
    current.messages.push(emptyAbort);
    current.emit({ type: "message_end", message: emptyAbort });
  }, ran);
  let compressorCalls = 0;
  let compressorPrompt = "";
  compressorStub.complete = async (...args: unknown[]) => {
    compressorCalls++;
    compressorPrompt = promptTextOf(args[1]);
    return completeResponse({ input: 1, output: 1, cost: { total: 0.02 } });
  };
  const snapshots: unknown[] = [];
  const sharedStore = capturingStore(snapshots);
  let saves = 0;
  const originalSave = sharedStore.save.bind(sharedStore);
  sharedStore.save = () => { saves++; originalSave(); };
  let compressorLookups = 0;
  const ctx = context(cwd, [ran, compressor]);
  const baseFind = ctx.modelRegistry.find.bind(ctx.modelRegistry);
  ctx.modelRegistry.find = ((provider: string, id: string) => {
    if (provider === "test" && id === "compressor") compressorLookups++;
    return baseFind(provider, id);
  }) as typeof ctx.modelRegistry.find;
  // Each managed settlement offers one more fact. Only a settlement that happens
  // BEFORE the one capture freeze can add to the stable record.
  const managed = session as unknown as {
    closeManagedOperations(): void;
    settleManagedOperations(): Promise<void>;
  };
  managed.closeManagedOperations = () => { closeCalls++; };
  managed.settleManagedOperations = async () => {
    settleCalls++;
    session.emit({
      type: "tool_execution_end",
      toolName: "settle",
      result: { content: [{ type: "text", text: `SETTLE-FACT-${settleCalls}` }] },
      isError: false,
    });
  };
  manager = managerWithSessions([session], {}, fixtureRuntime(), sharedStore);
  const result = await manager.dispatch(
    { ...TEST_ROUTE, task: "overlap terminal callers", type: "general" },
    ctx,
    controller.signal,
  );
  assert.ok(teardown, "manager teardown overlaps the caller cancellation");
  await teardown;
  // T16: every counter below counts one real operation, not one stored artifact.
  assert.equal(prompts, 1, "no terminal owner repeats the worker call");
  assert.equal(contentReads, 1, "one conversion at insertion, and no reconversion during freeze or compression");
  // One compression operation looks its compressor route up exactly twice: once
  // when it validates the route, and once when it resolves the model to call.
  assert.equal(compressorLookups, 2, "exactly one compression operation validates and resolves its route");
  assert.equal(compressorCalls, 1, "exactly one compression call runs for the shared outcome");
  assert.equal(
    compressorPrompt.match(/OVERLAP TOOL FACT/g)?.length,
    1,
    "one frozen record reaches one compression operation once",
  );
  assert.equal(
    result.episodeText.match(/bounded completed result was retained/gi)?.length,
    1,
    "the cancelled compression constructs exactly one bounded fallback",
  );
  assert.equal(
    result.episodeText.match(/OVERLAP TOOL FACT/g)?.length,
    1,
    "the one frozen fact is persisted once",
  );
  assert.equal(settleCalls, 2, "one settlement before the capture freeze, and one during worker cleanup");
  assert.ok(closeCalls >= 1, "the terminal transition closes managed admission");
  assert.equal(
    compressorPrompt.match(/SETTLE-FACT-1/g)?.length,
    1,
    "the freeze follows managed settlement and keeps that fact once",
  );
  assert.doesNotMatch(compressorPrompt, /SETTLE-FACT-2/);
  assert.doesNotMatch(result.episodeText, /SETTLE-FACT-2/);
  assert.equal(
    result.episodeText.match(/SETTLE-FACT-1/g)?.length,
    1,
    "one capture freeze produces one record, and no later fact joins it",
  );
  assert.equal(saves, 3, "queued creation, running admission, and one final durable save");
  assert.equal(session.shutdownCalls, 1, "overlapping owners emit one shutdown");
  assert.equal(session.disposeCalls, 1, "overlapping owners dispose the worker once");
  assert.deepEqual(
    readdirSync(join(cwd, ".pi", "slate", (manager as unknown as { store: InstanceType<typeof SlateStore> }).store.runtimeFolder, "episodes")).filter((name) => name.endsWith(".md")),
    ["t1.e1.md"],
    "one episode write",
  );
  assert.equal(snapshots.length, 3, "three durable snapshots, one for each save");
  assert.equal(result.episode.status, "failed");
  await assertDurableConsumers({
    snapshot: snapshots.at(-1),
    cwd,
    result,
    expect: {
      status: "failed",
      reason: TEST_ROUTE.reason,
      logicalModel: TEST_ROUTE.model,
      requestedModel: "test/worker",
      requestedEffort: "off",
      model: "test/worker",
      effort: "off",
      outcomeReason: /cancelled/,
    },
    laterTask: "later overlap consumer",
    laterContains: [/OVERLAP TOOL FACT/, /worker action was cancelled/],
  });
});

test("a disposal failure after durable persistence stays separate from the worker outcome", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]), ran);
  compressorStub.complete = async () => completeResponse({ input: 1, output: 1, cost: { total: 0.01 } });
  const snapshots: unknown[] = [];
  const sharedStore = capturingStore(snapshots);
  const manager = new ThreadManager(sharedStore, {}, undefined, fixtureRuntime(), { enabled: true, maxRetries: 1, baseDelayMs: 0 });
  const internals = manager as unknown as {
    live: Map<string, FakeSession>;
    openWorkerFor(args: {
      thread: { id: string };
      report: (message: string) => void;
      requestContract: import("../extension/worker.ts").WorkerRequestContract;
    }): Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
  };
  internals.openWorkerFor = async ({ thread, report, requestContract }) => {
    bindFakeWorkerRequest(session, requestContract);
    // The real worker reports a failing dispose and still resolves its cleanup
    // (test/worker-lifecycle.test.ts proves that behaviour on a real session).
    session.dispose = () => { session.disposeCalls++; throw new Error("dispose exploded"); };
    session.shutdownWorker = async () => {
      session.shutdownCalls++;
      try { session.dispose(); }
      catch (error) { report(`slate worker session disposal failed: ${(error as Error).message}`); }
    };
    internals.live.set(thread.id, session);
    return { session, baseline: NO_SESSION_BASELINE };
  };
  const result = await manager.dispatch(
    { ...TEST_ROUTE, task: "persist before cleanup fails", type: "general" },
    context(cwd, [ran, compressor]),
    undefined,
  );
  // O6: the cleanup failure is its own signal. It changes neither the worker
  // outcome nor the durable record.
  assert.ok(
    result.warnings.some((warning) => warning.includes("disposal failed") && warning.includes("dispose exploded")),
    result.warnings.join("\n"),
  );
  assert.equal(session.shutdownCalls, 1);
  assert.equal(session.disposeCalls, 1);
  assert.equal(result.episode.status, "ok");
  assert.equal(result.thread.status, "successful");
  assert.equal(result.thread.outcomeReason, undefined, "a cleanup failure writes no terminal cause");
  assert.doesNotMatch(result.episodeText, /dispose exploded/);
  await assertDurableConsumers({
    snapshot: snapshots.at(-1),
    cwd,
    result,
    expect: { status: "ok", model: "test/worker", effort: "off" },
    laterTask: "later cleanup-failure consumer",
    laterContains: [/## Intent\ncompressed/],
  });
});

test("fixed episode write failure leaves a terminal reason and no orphan episode", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession(async () => { throw new Error("provider stopped before response"); });
  const snapshots: unknown[] = [];
  const manager = managerWithSessions([session], {}, fixtureRuntime(), capturingStore(snapshots));
  mkdirSync(join(cwd, ".pi", "slate", (manager as unknown as { store: InstanceType<typeof SlateStore> }).store.runtimeFolder, "episodes", "t1.e1.md"), { recursive: true });
  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "fail durably", type: "general" }, context(cwd), undefined),
    (error: Error) => {
      assert.match(error.message, /worker prompt threw without cancellation evidence/);
      assert.match(error.message, /could not store episode t1\.e1/);
      assert.match(error.message, /not a regular file/);
      assert.doesNotMatch(error.message, /slate episode persistence failed/);
      return true;
    },
  );
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  const thread = internalStore.threads.get("t1");
  assert.equal(thread?.status, "failed");
  assert.match(thread?.outcomeReason ?? "", /worker prompt threw without cancellation evidence/);
  assert.match(thread?.outcomeReason ?? "", /persistence failed/);
  assert.match(thread?.outcomeReason ?? "", /not a regular file/);
  assert.equal(thread?.episodeId, undefined);
  assert.equal(internalStore.episodes.size, 0);
  assert.equal(session.shutdownCalls, 1);
  assert.equal(session.disposeCalls, 1);
  // O4: the last durable snapshot claims no episode, and no durable consumer of
  // that snapshot can reach one.
  await assertNoEpisodeConsumers(internalStore, cwd, "t1.e1", snapshots.at(-1));
});

test("fixed failure reports a thread-record save failure", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession(async () => { throw new Error("worker failed without output"); });
  const manager = managerWithSessions([session]);
  const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  const originalSave = internalStore.save.bind(internalStore);
  const successfulSnapshots: Array<Parameters<InstanceType<typeof SlateStore>["adoptSnapshot"]>[0]> = [];
  internalStore.save = () => {
    if (internalStore.episodes.size > 0) throw new Error("snapshot storage unavailable");
    successfulSnapshots.push(structuredClone((internalStore as unknown as { snapshot(): Parameters<InstanceType<typeof SlateStore>["adoptSnapshot"]>[0] }).snapshot()));
    originalSave();
  };
  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "persist fixed result", type: "general" }, context(cwd), undefined),
    /stored episode t1\.e1, but could not save its thread record: snapshot storage unavailable/,
  );
  assert.equal(internalStore.threads.get("t1")?.status, "failed");
  assert.equal(internalStore.threads.get("t1")?.episodeId, "t1.e1");
  assert.ok(successfulSnapshots.length > 0);
  const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  restored.adoptSnapshot(successfulSnapshots.at(-1)!, context(cwd));
  assert.equal(restored.episodes.has("t1.e1"), false, "the last successful snapshot cannot claim unwritten state");
  assert.equal(restored.threads.get("t1")?.episodeId, undefined, "the failed save publishes no durable episode reference");
  assert.match(readFileSync(join(cwd, ".pi", "slate", internalStore.runtimeFolder, "episodes", "t1.e1.md"), "utf8"), /STATUS: FAILED/, "episode bytes may remain after state-save failure");
});

test("worker episode usage preserves all quantities and accumulates several turns", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession(successfulPrompt([
    { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: 0 } },
    { input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: { total: 0 } },
  ]));
  const result = await managerWithSessions([session]).dispatch({ ...TEST_ROUTE, reason: "test\u0000 fixture", task: "account worker usage", type: "general" }, context(cwd), undefined);

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
  assert.equal(result.episode.reason, TEST_ROUTE.reason);
  assert.equal(result.episode.logicalModel, TEST_ROUTE.model);
  assert.equal(result.episode.requestedModel, "test/worker");
  assert.equal(result.episode.requestedEffort, "off");
  assert.equal(result.episodeText.includes(TEST_ROUTE.reason), false, "dispatch metadata must stay out of episode Markdown");
});

test("worker episode usage distinguishes an absent quantity from reported zero", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const session = fakeSession(successfulPrompt([{ input: 0, output: 4, cacheRead: 0, cost: { total: 0 } }]));
  const result = await managerWithSessions([session]).dispatch({ ...TEST_ROUTE, task: "preserve absence", type: "general" }, context(cwd), undefined);

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
  const result = await managerWithSessions([session]).dispatch({ ...TEST_ROUTE, task: "preserve missing worker cost", type: "general" }, context(cwd), undefined);

  assert.equal(Object.hasOwn(result.episode, "workerCostUsd"), false);
  assert.equal(result.episode.workerCostUsd, undefined);
});

test("compressor usage persists all quantities across a Pi-owned same-route retry", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const primary = model("test", "compressor");
  const responses = [
    completeResponse({ input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: 0.1 } }, "error"),
    completeResponse({ input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: { total: 0.2 } }),
  ];
  const calls: Array<{ model: unknown; options: unknown }> = [];
  compressorStub.complete = async (...args: unknown[]) => {
    calls.push({ model: args[0], options: args[2] });
    const response = responses.shift();
    assert.ok(response, "compression must make only the scripted calls");
    return response;
  };
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const manager = managerWithSessions([session]);
  const controller = new AbortController();
  const headers = { authorization: "test-token", "x-provider-default": null };
  const result = await manager.dispatch({ ...TEST_ROUTE, task: "compress with failover", type: "general" }, context(cwd, [primary], headers), controller.signal);
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0]?.model, primary);
  assert.strictEqual(calls[1]?.model, primary);
  assert.deepEqual(
    calls.map((call) => call.options),
    [
      { maxTokens: 4096, reasoning: "medium", signal: controller.signal },
      { maxTokens: 4096, reasoning: "medium", signal: controller.signal },
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
  compressorStub.complete = async () => completeResponse({ cost: { total: 0 } });
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const result = await managerWithSessions([session]).dispatch(
    { ...TEST_ROUTE, task: "compress without usage", type: "general" },
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
  compressorStub.complete = async () => completeResponse({ input: 3, output: 2 });
  const session = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const result = await managerWithSessions([session]).dispatch(
    { ...TEST_ROUTE, task: "compress without reported dollars", type: "general" },
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
    return successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }])(session, "compacted prompt");
  });
  const second = fakeSession(successfulPrompt([{ input: 1, output: 1, cost: { total: 0 } }]));
  const manager = managerWithSessions([first, second]);

  const firstResult = await manager.dispatch({ ...TEST_ROUTE, task: "dispatch with compaction", type: "general" }, context(cwd), undefined);
  const secondResult = await manager.dispatch({ ...TEST_ROUTE, task: "dispatch without compaction", type: "general" }, context(cwd), undefined);

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

  await manager.dispatch({ ...TEST_ROUTE, task: "normal teardown", type: "general" }, context(cwd), undefined);
  const failedResult = await manager.dispatch({ ...TEST_ROUTE, task: "error teardown", type: "general" }, context(cwd), undefined);
  assert.equal(failedResult.episode.status, "failed");

  assert.equal(normal.listenerCount(), 0);
  assert.equal(failed.listenerCount(), 0);
  assert.deepEqual(
    [normal.shutdownCalls, normal.disposeCalls, failed.shutdownCalls, failed.disposeCalls],
    [1, 1, 1, 1],
  );
  const failedThread = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store.threads.get("t2");
  assert.equal(failedThread?.status, "failed");
  assert.match(failedThread?.outcomeReason ?? "", /worker prompt threw without cancellation evidence/);
  assert.equal(failedThread?.episodeId, "t2.e1");
});

test("a resolver failure observed after caller cancellation keeps no-fact cancellation primary", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const controller = new AbortController();
  const snapshots: unknown[] = [];
  const sharedStore = capturingStore(snapshots);
  const manager = new ThreadManager(
    sharedStore,
    {},
    () => {
      controller.abort();
      throw new Error("extension resolver exploded");
    },
    fixtureRuntime(),
    { enabled: true, maxRetries: 1, baseDelayMs: 0 },
  );
  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "resolver cancellation order", type: "general" }, context(cwd), controller.signal),
    (error: Error) => {
      assert.match(error.message, /cancelled by the caller/);
      assert.match(error.message, /extension resolver exploded/);
      assert.match(error.message, /No episode was recorded/);
      assert.equal(error.message.match(/extension resolver exploded/g)?.length, 1);
      return true;
    },
  );
  assert.equal(sharedStore.episodes.size, 0);
  assert.equal(sharedStore.threads.get("t1")?.status, "cancelled");
  await assertNoEpisodeConsumers(sharedStore, cwd, "t1.e1", snapshots.at(-1));
});

test("no-fact cancellation keeps lifecycle reports beside a terminal save failure", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const controller = new AbortController();
  const session = fakeSession(async () => { throw new Error("ordinary prompt must not run"); }, model("test", "worker"));
  const snapshots: unknown[] = [];
  const sharedStore = capturingStore(snapshots);
  const originalSave = sharedStore.save.bind(sharedStore);
  let saves = 0;
  sharedStore.save = () => {
    saves++;
    if (saves === 3) throw new Error("terminal state unavailable");
    originalSave();
  };
  const manager = new ThreadManager(sharedStore, {}, undefined, fixtureRuntime(), { enabled: true, maxRetries: 1, baseDelayMs: 0 });
  const internals = manager as unknown as {
    live: Map<string, FakeSession>;
    openWorkerFor(args: {
      thread: { id: string };
      report: (message: string) => void;
      requestContract: import("../extension/worker.ts").WorkerRequestContract;
      observeSession?: (worker: FakeSession) => void;
      observeStartupFailure?: (detail: string) => void;
    }): Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
  };
  internals.openWorkerFor = async ({ thread, report, requestContract, observeSession, observeStartupFailure }) => {
    bindFakeWorkerRequest(session, requestContract);
    observeSession?.(session);
    internals.live.set(thread.id, session);
    session.dispose = () => { session.disposeCalls++; throw new Error("disposal exploded"); };
    session.shutdownWorker = async () => {
      session.shutdownCalls++;
      report("slate: worker extension shutdown failed — shutdown exploded");
      try { session.dispose(); }
      catch (error) { report(`slate: worker session disposal failed — ${(error as Error).message}`); }
    };
    controller.abort();
    observeStartupFailure?.("startup exploded");
    throw new Error("startup open exploded");
  };

  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "save and lifecycle causes", type: "general" }, context(cwd), controller.signal),
    (error: Error) => {
      assert.match(error.message, /cancelled by the caller/);
      for (const detail of ["startup exploded", "shutdown exploded", "disposal exploded", "terminal state unavailable"]) {
        assert.equal(error.message.match(new RegExp(detail, "g"))?.length, 1, detail);
      }
      return true;
    },
  );
  assert.equal(sharedStore.episodes.size, 0);
  assert.equal(sharedStore.threads.get("t1")?.status, "cancelled");
  assert.equal(session.shutdownCalls, 1);
  assert.equal(session.disposeCalls, 1);
  await manager.disposeAll();
});

test("fact cancellation keeps lifecycle reports beside episode and state persistence failures", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const controller = new AbortController();
  const ran = model("test", "worker");
  const compressor = model("test", "compressor");
  const session = fakeSession(async () => { throw new Error("ordinary prompt must not run"); }, ran);
  compressorStub.complete = async () => completeResponse({ input: 1, output: 1, cost: { total: 0.01 } });
  const sharedStore = store();
  mkdirSync(join(cwd, ".pi", "slate", sharedStore.runtimeFolder, "episodes", "t1.e1.md"), { recursive: true });
  const originalSave = sharedStore.save.bind(sharedStore);
  sharedStore.save = () => {
    const thread = sharedStore.threads.get("t1");
    if (thread?.status === "failed" && sharedStore.episodes.size === 0) throw new Error("terminal state unavailable");
    originalSave();
  };
  const manager = managerWithSessions([session], {}, fixtureRuntime(), sharedStore);
  const internals = manager as unknown as {
    live: Map<string, FakeSession>;
    openWorkerFor(args: {
      thread: { id: string };
      report: (message: string) => void;
      requestContract: import("../extension/worker.ts").WorkerRequestContract;
      observeSession?: (worker: FakeSession) => void;
      observeStartupFailure?: (detail: string) => void;
    }): Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
  };
  internals.openWorkerFor = async ({ thread, report, requestContract, observeSession, observeStartupFailure }) => {
    bindFakeWorkerRequest(session, requestContract);
    observeSession?.(session);
    internals.live.set(thread.id, session);
    session.dispose = () => { session.disposeCalls++; throw new Error("disposal exploded"); };
    session.shutdownWorker = async () => {
      session.shutdownCalls++;
      report("slate: worker extension shutdown failed — shutdown exploded");
      try { session.dispose(); }
      catch (error) { report(`slate: worker session disposal failed — ${(error as Error).message}`); }
    };
    session.emit({
      type: "tool_execution_end",
      toolName: "read",
      result: { content: [{ type: "text", text: "FACT BEFORE STARTUP FAILURE" }] },
      isError: false,
    });
    controller.abort();
    observeStartupFailure?.("startup exploded");
    throw new Error("startup open exploded");
  };

  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "episode and state causes", type: "general" }, context(cwd, [ran, compressor]), controller.signal),
    (error: Error) => {
      assert.match(error.message, /cancelled by the caller/);
      assert.match(error.message, /not a regular file/);
      assert.match(error.message, /terminal state unavailable/);
      for (const detail of ["startup exploded", "shutdown exploded", "disposal exploded"]) {
        assert.equal(error.message.match(new RegExp(detail, "g"))?.length, 1, detail);
      }
      return true;
    },
  );
  const thread = sharedStore.threads.get("t1");
  assert.equal(thread?.status, "failed");
  assert.match(thread?.outcomeReason ?? "", /not a regular file/);
  assert.match(thread?.outcomeReason ?? "", /terminal state unavailable/);
  assert.equal(sharedStore.episodes.size, 0);
  assert.equal(session.shutdownCalls, 1);
  assert.equal(session.disposeCalls, 1);
});

test("a request refusal remains primary when cancellation and startup failure follow", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const controller = new AbortController();
  const session = fakeSession(async () => { throw new Error("the refused action must not prompt"); }, model("test", "worker"));
  const manager = managerWithSessions([session]);
  const internals = manager as unknown as {
    live: Map<string, FakeSession>;
    openWorkerFor(args: {
      thread: { id: string };
      requestContract: import("../extension/worker.ts").WorkerRequestContract;
      observeSession?: (worker: FakeSession) => void;
      observeStartupFailure?: (detail: string) => void;
    }): Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
  };
  internals.openWorkerFor = async ({ thread, requestContract, observeSession, observeStartupFailure }) => {
    bindFakeWorkerRequest(session, requestContract);
    observeSession?.(session);
    internals.live.set(thread.id, session);
    try { requestContract.accept({ provider: "wrong", id: "wrong" }, "off", undefined, () => undefined); }
    catch { /* the contract records the refusal for the action owner */ }
    controller.abort();
    observeStartupFailure?.("startup exploded");
    throw new Error("startup open exploded");
  };

  const result = await manager.dispatch({ ...TEST_ROUTE, task: "refusal precedence", type: "general" }, context(cwd), controller.signal);
  assert.equal(result.episode.status, "failed");
  assert.equal(result.thread.status, "failed");
  assert.match(result.episodeText, /Slate route contract violation/);
  assert.doesNotMatch(result.episodeText, /cancelled by the caller/);
  assert.equal(session.shutdownCalls, 1);
  assert.equal(session.disposeCalls, 1);
});

test("caller cancellation stops logical recovery after retry exhaustion", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const controller = new AbortController();
  const primary = model("test", "primary");
  const fallback = model("anthropic", "claude-sonnet-5");
  const compressor = model("test", "compressor");
  let prompts = 0;
  const session = fakeSession((current) => {
    prompts++;
    assert.equal(prompts, 1, "the recovery prompt must not reach the worker");
    const message = { role: "assistant", stopReason: "error", errorMessage: "service unavailable", content: [], usage: {} };
    current.messages.push(message);
    current.emit({ type: "message_end", message });
    current.emit({ type: "agent_end", willRetry: true });
    current.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: "service unavailable" });
    current.emit({ type: "agent_end", willRetry: false });
    current.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "service unavailable" });
  }, primary);
  const originalSetModel = session.setModel.bind(session);
  session.setModel = async (next) => {
    await originalSetModel(next);
    controller.abort();
  };
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: {
    models: {
      include: [],
      add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "primary", anthropic: "claude-sonnet-5" }, guidelines: [], cautions: [] }],
      replace: [{ model: "claude-sonnet-5", preferredProvider: "test", providers: { test: "compressor" } }],
    },
    compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }] },
  } } });
  const manager = managerWithSessions([session], {}, runtime);

  await assert.rejects(
    manager.dispatch({ ...TEST_ROUTE, task: "cancel recovery", type: "general" }, context(cwd, [primary, fallback, compressor]), controller.signal),
    /cancelled by the caller.*No episode was recorded/,
  );
  assert.equal(prompts, 1);
  assert.equal((manager as unknown as { store: InstanceType<typeof SlateStore> }).store.episodes.size, 0);
});

test("startup failure and cancellation order keeps the observed primary cause", { timeout: 2000 }, async (t) => {
  for (const order of ["cancel-first", "startup-first"] as const) {
    await t.test(order, { timeout: 1000 }, async (t) => {
      const cwd = temporaryProject(t);
      const controller = new AbortController();
      const session = fakeSession(async () => { throw new Error("ordinary prompt must not run"); }, model("test", "worker"));
      const snapshots: unknown[] = [];
      const manager = managerWithSessions([session], {}, fixtureRuntime(), capturingStore(snapshots));
      const internals = manager as unknown as {
        live: Map<string, FakeSession>;
        openWorkerFor(args: {
          thread: { id: string };
          report: (message: string) => void;
          requestContract: import("../extension/worker.ts").WorkerRequestContract;
          observeSession?: (worker: FakeSession) => void;
          observeStartupFailure?: (detail: string) => void;
        }): Promise<{ session: FakeSession; baseline: typeof NO_SESSION_BASELINE }>;
      };
      internals.openWorkerFor = async ({ thread, report, requestContract, observeSession, observeStartupFailure }) => {
        bindFakeWorkerRequest(session, requestContract);
        observeSession?.(session);
        internals.live.set(thread.id, session);
        session.dispose = () => { session.disposeCalls++; throw new Error("disposal exploded"); };
        session.shutdownWorker = async () => {
          session.shutdownCalls++;
          report("slate: worker extension shutdown failed — shutdown exploded");
          try { session.dispose(); }
          catch (error) { report(`slate: worker session disposal failed — ${(error as Error).message}`); }
        };
        if (order === "cancel-first") controller.abort();
        observeStartupFailure?.("startup exploded");
        if (order === "startup-first") controller.abort();
        throw new Error("slate: worker extension startup did not complete: startup exploded");
      };

      const dispatch = manager.dispatch(
        { ...TEST_ROUTE, task: `startup order ${order}`, type: "general" },
        context(cwd),
        controller.signal,
      );
      if (order === "cancel-first") {
        await assert.rejects(dispatch, (error: Error) => {
          assert.match(error.message, /cancelled by the caller/);
          for (const detail of ["startup exploded", "shutdown exploded", "disposal exploded"]) {
            assert.equal(error.message.match(new RegExp(detail, "g"))?.length, 1, detail);
          }
          return true;
        });
        const internalStore = (manager as unknown as { store: InstanceType<typeof SlateStore> }).store;
        assert.equal(internalStore.episodes.size, 0);
        assert.equal(internalStore.threads.get("t1")?.status, "cancelled");
        assert.equal(session.shutdownCalls, 1);
        assert.equal(session.disposeCalls, 1);
        assert.equal(existsSync(join(cwd, ".pi", "slate", internalStore.runtimeFolder, "episodes", "t1.e1.md")), false);
        await assertNoEpisodeConsumers(internalStore, cwd, "t1.e1", snapshots.at(-1));
      } else {
        const result = await dispatch;
        assert.equal(result.episode.status, "failed");
        assert.match(result.thread.outcomeReason ?? "", /startup exploded/);
        assert.doesNotMatch(result.episodeText, /shutdown exploded|disposal exploded/);
        for (const detail of ["startup exploded", "shutdown exploded", "disposal exploded"]) {
          assert.equal(result.warnings.join("\n").match(new RegExp(detail, "g"))?.length, 1, detail);
        }
        assert.equal(session.shutdownCalls, 1);
        assert.equal(session.disposeCalls, 1);
      }
    });
  }
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
    callerManager.dispatch({ ...TEST_ROUTE, task: "caller cancellation", type: "general" }, context(cwd), controller.signal),
    /cancelled by the caller.*No episode was recorded/,
  );
  assert.equal(aborted.listenerCount(), 0);
  const callerStore = (callerManager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(callerStore.threads.get("t1")?.status, "cancelled");
  assert.equal(callerStore.threads.get("t1")?.episodeId, undefined);
  assert.equal(callerStore.episodes.size, 0);
  await assertNoEpisodeConsumers(callerStore, cwd, "t1.e1");
  assert.equal(aborted.shutdownCalls, 1);
  assert.equal(aborted.disposeCalls, 1);

  let disposalManager: InstanceType<typeof ThreadManager>;
  const disposed = fakeSession(async () => {
    disposalManager.disposeAll();
    throw new Error("disposed session stopped");
  });
  disposalManager = managerWithSessions([disposed]);
  await assert.rejects(
    disposalManager.dispatch({ ...TEST_ROUTE, task: "session disposal", type: "general" }, context(cwd), undefined),
    /cancelled during session teardown.*No episode was recorded/,
  );
  const disposalStore = (disposalManager as unknown as { store: InstanceType<typeof SlateStore> }).store;
  assert.equal(disposalStore.threads.get("t1")?.status, "cancelled");
  assert.equal(disposalStore.threads.get("t1")?.episodeId, undefined);
  assert.equal(disposalStore.episodes.size, 0);
  assert.equal(disposed.shutdownCalls, 1);
  assert.equal(disposed.disposeCalls, 1);
  await assertNoEpisodeConsumers(disposalStore, cwd, "t1.e1");

  for (const scenario of ["partial-stream", "tool-call-only"] as const) {
    const controller = new AbortController();
    const noFact = fakeSession((current) => {
      const message = scenario === "partial-stream"
        ? { role: "assistant", stopReason: "pending", content: [{ type: "text", text: "UNFINISHED DELTA" }], usage: {} }
        : { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], usage: {} };
      current.messages.push(message);
      current.emit(scenario === "partial-stream"
        ? { type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "UNFINISHED DELTA" } }
        : { type: "message_end", message });
      controller.abort();
      throw new Error(`${scenario} cancelled`);
    });
    const noFactManager = managerWithSessions([noFact]);
    await assert.rejects(
      noFactManager.dispatch({ ...TEST_ROUTE, task: scenario, type: "general" }, context(cwd), controller.signal),
      /cancelled by the caller.*No episode was recorded/,
    );
    const noFactStore = (noFactManager as unknown as { store: InstanceType<typeof SlateStore> }).store;
    assert.equal(noFactStore.threads.get("t1")?.status, "cancelled", scenario);
    assert.equal(noFactStore.episodes.size, 0, scenario);
    await assertNoEpisodeConsumers(noFactStore, cwd, "t1.e1");
  }
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
  assert.equal(record.reason, undefined);
  assert.equal(record.requestedModel, undefined);
  assert.equal(record.requestedEffort, undefined);
  assert.deepEqual(repairs, []);

  const corruptRepairs: string[] = [];
  const corrupt = sanitizeEpisodeRecord({
    id: "t2.e1", threadId: "t2", task: "corrupt", status: "ok", file: "/tmp/corrupt.md",
    reason: "\u200b", requestedModel: "bad", requestedEffort: "high\u2028forged", createdAt: 2,
  }, corruptRepairs);
  assert.equal(corrupt?.reason, undefined);
  assert.equal(corrupt?.requestedModel, undefined);
  assert.equal(corrupt?.requestedEffort, undefined);
  assert.match(corruptRepairs.join("\n"), /reason.*requestedModel.*requestedEffort/s);

  const current = sanitizeEpisodeRecord({
    id: "t3.e1", threadId: "t3", task: "current", status: "ok", file: "/tmp/current.md",
    reason: "cost check", requestedModel: "p/requested", requestedEffort: "high", createdAt: 3,
  }, []);
  assert.equal(current?.reason, "cost check");
  assert.equal(current?.requestedModel, "p/requested");
  assert.equal(current?.requestedEffort, "high");
});

test("worker failover preserves requested metadata when the fallback succeeds or fails", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const primary = model("test", "primary");
  const fallback = model("anthropic", "claude-sonnet-5");
  const compressor = model("test", "compressor");
  compressorStub.complete = async () => completeResponse({});
  for (const secondAttempt of ["success", "failure"] as const) {
    let prompts = 0;
    const session = fakeSession((current) => {
      prompts++;
      if (prompts === 1) {
        const message = { role: "assistant", stopReason: "error", errorMessage: "service unavailable", content: [], usage: {} };
        current.messages.push(message);
        current.emit({ type: "message_end", message });
        current.emit({ type: "agent_end", willRetry: true });
        current.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: "service unavailable" });
        current.emit({ type: "agent_end", willRetry: false });
        current.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "service unavailable" });
        return;
      }
      if (secondAttempt === "failure") throw new Error("fallback failed before response");
      return successfulPrompt([{ input: 1, output: 1 }])(current, "retry");
    }, primary);
    const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "primary", anthropic: "claude-sonnet-5" }, guidelines: [], cautions: [] }], replace: [{ model: "claude-sonnet-5", preferredProvider: "test", providers: { test: "compressor" } }] }, compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }] } } } });
    const manager = managerWithSessions([session], {}, runtime);
    const result = await manager.dispatch(
      { model: "fixture", reason: `failover ${secondAttempt} canary`, task: `fallback ${secondAttempt}`, type: "general" },
      context(cwd, [primary, fallback, compressor]),
      undefined,
    );
    assert.equal(prompts, 2);
    assert.equal(result.episode.requestedModel, "test/primary");
    assert.equal(result.episode.requestedEffort, "off");
    assert.equal(result.episode.reason, `failover ${secondAttempt} canary`);
    assert.equal(result.episode.model, "anthropic/claude-sonnet-5");
    assert.equal(result.episode.effort, "off");
    assert.equal(result.episode.status, secondAttempt === "success" ? "ok" : "failed");
  }
});

test("request metadata stays out of first, reused-context, and compressor prompts", { timeout: 1000 }, async (t) => {
  const cwd = temporaryProject(t);
  const requested = model("request-canary", "secret-model");
  const actual = model("actual", "safe-model");
  const compressor = model("test", "compressor");
  const workerPrompts: string[] = [];
  const compressorPrompts: string[] = [];
  let firstCalls = 0;
  const sessions = [
    fakeSession((current, prompt) => {
      workerPrompts.push(prompt);
      firstCalls++;
      if (firstCalls === 1) {
        const message = { role: "assistant", stopReason: "error", errorMessage: "service unavailable", content: [], usage: {} };
        current.messages.push(message);
        current.emit({ type: "message_end", message });
        current.emit({ type: "agent_end", willRetry: true });
        current.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: "service unavailable" });
        current.emit({ type: "agent_end", willRetry: false });
        current.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "service unavailable" });
        return;
      }
      return successfulPrompt([{ input: 1, output: 1 }])(current, prompt);
    }, requested),
    fakeSession((current, prompt) => {
      workerPrompts.push(prompt);
      return successfulPrompt([{ input: 1, output: 1 }])(current, prompt);
    }, requested),
  ];
  compressorStub.complete = async (...args: unknown[]) => {
    compressorPrompts.push(JSON.stringify(args[1]));
    return completeResponse({});
  };
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "request-canary", providers: { "request-canary": "secret-model", actual: "safe-model" }, guidelines: [], cautions: [] }], replace: [{ model: "claude-sonnet-5", preferredProvider: "test", providers: { test: "compressor" } }] }, compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }] } } } });
  const manager = managerWithSessions(sessions, {}, runtime);
  const ctx = context(cwd, [requested, actual, compressor]);
  const first = await manager.dispatch(
    { model: "fixture", reason: "FIRST-REASON-CANARY", task: "first safe task", type: "general" },
    ctx,
    undefined,
  );
  await manager.dispatch(
    { model: "fixture", reason: "SECOND-REASON-CANARY", task: "second safe task", type: "general", contextEpisodeIds: [first.episode.id] },
    ctx,
    undefined,
  );
  assert.equal(workerPrompts[0], "first safe task");
  assert.match(workerPrompts[2] ?? "", /Context from prior episodes/);
  for (const prompt of [...workerPrompts, ...compressorPrompts]) {
    assert.doesNotMatch(prompt, /FIRST-REASON-CANARY|SECOND-REASON-CANARY|request-canary\/secret-model/);
  }
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

test("logical compressor uses production retries, moves forward, attributes usage, and remembers success", { timeout: 2_000 }, async (t) => {
  const cwd = temporaryProject(t);
  const runtime = createLogicalRuntime({
    trusted: true,
    projectConfig: { router: {
      models: { replace: [
        { model: "claude-sonnet-5", preferredProvider: "first", providers: { first: "compress-1", backup: "compress-1b" } },
        { model: "luna-6", preferredProvider: "second", providers: { second: "compress-2", "second-backup": "compress-2b" } },
      ] },
      compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }, { model: "luna-6", effort: "low" }] },
    } },
  });
  const admission = runtime.admit();
  assert.ok(admission);
  const first = { ...model("first", "compress-1"), reasoning: true, thinkingLevelMap: { medium: "medium" } };
  const backup = { ...model("backup", "compress-1b"), reasoning: true, thinkingLevelMap: { medium: "medium" } };
  const second = { ...model("second", "compress-2"), reasoning: true, thinkingLevelMap: { low: "low" } };
  const secondBackup = { ...model("second-backup", "compress-2b"), reasoning: true, thinkingLevelMap: { low: "low" } };
  const calls: unknown[] = [];
  const responses = [
    completeResponse({ input: 2, output: 1, cost: { total: 0.1 } }, "error"),
    completeResponse({ input: 4, output: 1, cost: { total: 0.15 } }, "error"),
    completeResponse({ input: 3, output: 1, cost: { total: 0.2 } }, "error"),
    completeResponse({ input: 5, output: 2, cost: { total: 0.25 } }),
  ];
  compressorStub.complete = async (selected: unknown) => { calls.push(selected); return responses.shift()!; };
  const result = await compressEpisode({
    ctx: context(cwd, [first, backup, second, secondBackup]), episodeId: "t1.e1", threadId: "t1", threadName: "logical",
    task: "retain this result", status: "ok", messages: [assistant({}, "RAW COMPLETED RESULT")],
    observations: { stored: false, reason: "no-final-message", grammar: "absent" },
    logicalRuntime: runtime, admission, retryPolicy: { enabled: true, maxRetries: 0, baseDelayMs: 0 },
  });
  assert.deepEqual(calls, [first, backup, second, secondBackup]);
  assert.equal(result.compressor, "second-backup/compress-2b");
  assert.deepEqual(result.compressorUsage, { input: 14, output: 5 });
  assert.equal(result.costUsd, 0.1 + 0.15 + 0.2 + 0.25);
  const next = runtime.admit();
  assert.ok(next);
  assert.equal(runtime.planCompressor(next.snapshot)[0]?.compressorIndex, 1);
  assert.equal(runtime.planCompressor(next.snapshot)[0]?.provider, "second-backup");
  const tailCalls: unknown[] = [];
  compressorStub.complete = async (selected: unknown) => { tailCalls.push(selected); return completeResponse({ input: 1 }, "error"); };
  const rememberedTail = await compressEpisode({
    ctx: context(cwd, [first, backup, second, secondBackup]), episodeId: "t2.e1", threadId: "t2", threadName: "tail",
    task: "do not wrap", status: "ok", messages: [assistant({}, "TAIL RAW")],
    observations: { stored: false, reason: "no-final-message", grammar: "absent" },
    logicalRuntime: runtime, admission: next, retryPolicy: { enabled: true, maxRetries: 0, baseDelayMs: 0 },
  });
  assert.deepEqual(tailCalls, [secondBackup, second]);
  assert.equal(rememberedTail.compressor, "(uncompressed fallback)");
  assert.match(rememberedTail.text, /TAIL RAW/);
});

test("logical compressor production pipeline succeeds after Pi retries the same physical route", { timeout: 2_000 }, async (t) => {
  const cwd = temporaryProject(t);
  const runtime = createLogicalRuntime({
    trusted: true,
    projectConfig: { router: { models: { replace: [{ model: "claude-sonnet-5", preferredProvider: "retry", providers: { retry: "compress" } }] } } },
  });
  const admission = runtime.admit(); assert.ok(admission);
  const compressor = { ...model("retry", "compress"), reasoning: true, thinkingLevelMap: { medium: "medium" } };
  const responses = [completeResponse({ input: 2, cost: { total: 0.1 } }, "error"), completeResponse({ input: 3, output: 1, cost: { total: 0.2 } })];
  let calls = 0;
  compressorStub.complete = async () => { calls++; return responses.shift()!; };
  const result = await compressEpisode({
    ctx: context(cwd, [compressor]), episodeId: "t1.e1", threadId: "t1", threadName: "retry", task: "retry once",
    status: "ok", messages: [assistant({}, "RAW")], observations: { stored: false, reason: "no-final-message", grammar: "absent" },
    logicalRuntime: runtime, admission, retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
  });
  assert.equal(calls, 2);
  assert.equal(result.compressor, "retry/compress");
  assert.deepEqual(result.compressorUsage, { input: 5, output: 1 });
  assert.equal(result.costUsd, 0.1 + 0.2);
});

test("logical compressor retains bounded completed output for disabled, cancelled, malformed, and thrown outcomes", { timeout: 2_000 }, async (t) => {
  const cwd = temporaryProject(t);
  const runtime = createLogicalRuntime({
    trusted: true,
    projectConfig: { router: { models: { replace: [{ model: "claude-sonnet-5", preferredProvider: "only", providers: { only: "compress" } }] } } },
  });
  const compressor = { ...model("only", "compress"), reasoning: true, thinkingLevelMap: { medium: "medium" } };
  const scenarios = [
    { id: 1, response: completeResponse({ input: 1, cost: { total: 0.01 } }, "error"), policy: { enabled: false, maxRetries: 2, baseDelayMs: 0 }, notice: /retries were disabled/i },
    { id: 2, response: completeResponse({ input: 1 }, "aborted"), policy: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, notice: /cancelled/i },
    { id: 3, response: {} as unknown, policy: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, notice: /valid final stop reason/i },
  ];
  for (const scenario of scenarios) {
    const admission = runtime.admit(); assert.ok(admission);
    compressorStub.complete = async () => scenario.response;
    const result = await compressEpisode({
      ctx: context(cwd, [compressor]), episodeId: `t${scenario.id}.e1`, threadId: `t${scenario.id}`, threadName: "raw",
      task: "keep raw", status: "ok", messages: [assistant({}, "R".repeat(9000))],
      observations: { stored: false, reason: "no-final-message", grammar: "absent" },
      logicalRuntime: runtime, admission, retryPolicy: scenario.policy,
    });
    assert.equal(result.compressor, "(uncompressed fallback)");
    assert.match(result.text, scenario.notice);
    assert.equal(Math.max(...(result.text.match(/R+/g) ?? []).map((run) => run.length)), 8000);
  }
  const admission = runtime.admit(); assert.ok(admission);
  let thrownCalls = 0;
  compressorStub.complete = async () => { thrownCalls++; throw new Error("SDK path failed"); };
  const thrown = await compressEpisode({
    ctx: context(cwd, [compressor]), episodeId: "t4.e1", threadId: "t4", threadName: "raw", task: "keep throw",
    status: "ok", messages: [assistant({}, "THROWN RAW")], observations: { stored: false, reason: "no-final-message", grammar: "absent" },
    logicalRuntime: runtime, admission, retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
  });
  assert.equal(thrownCalls, 1, "an SDK-normalized terminal provider error does not retry");
  assert.match(thrown.text, /terminal provider error/i);
  assert.equal(thrown.costUsd, 0);
  assert.deepEqual(thrown.compressorUsage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.match(thrown.text, /THROWN RAW/);

  const stableRecorder = createCompletedFactRecorder();
  for (let index = 0; index < 50; index++) {
    stableRecorder.addTool("bulk", { content: [{ type: "text", text: "z".repeat(9_000) + `-BULK-${index}` }] }, false);
  }
  let retainedValueReads = 0;
  const retainedValue = {
    get content() {
      retainedValueReads++;
      return [{ type: "text", text: "STABLE TOOL FACT" }];
    },
  };
  stableRecorder.addTool("read", retainedValue, false);
  assert.equal(retainedValueReads, 1, "a fact is converted and bounded when it enters the recorder");
  const stableAdmission = runtime.admit(); assert.ok(stableAdmission);
  const hostileMessages = new Proxy([] as unknown[], { get() { throw new Error("mutable history was inspected"); } });
  let exactCompressorInput = "";
  compressorStub.complete = async (...args: unknown[]) => {
    exactCompressorInput = promptTextOf(args[1]);
    return completeResponse({ input: 1 }, "error");
  };
  const stableFrozen = stableRecorder.freeze();
  const stable = await compressEpisode({
    ctx: context(cwd, [compressor]), episodeId: "t5.e1", threadId: "t5", threadName: "stable", task: "use stable facts",
    status: "failed", diagnostics: "cancelled", messages: hostileMessages, completedFacts: stableFrozen,
    observations: { stored: false, reason: "no-final-message", grammar: "absent" },
    logicalRuntime: runtime, admission: stableAdmission, retryPolicy: { enabled: true, maxRetries: 0, baseDelayMs: 0 },
  });
  assert.equal(retainedValueReads, 1, "freeze and compression never reconvert retained raw values");
  // The compression input equals the frozen bounded record plus the action's own
  // diagnostics, compared by equality and not by pattern.
  assert.equal(
    transcriptOf(exactCompressorInput),
    `${stableFrozen.text}\n\n[dispatch diagnostics: cancelled]`,
    "the compressor receives exactly the frozen bounded record",
  );
  assert.match(exactCompressorInput, /STABLE TOOL FACT/);
  assert.match(exactCompressorInput, /-BULK-49/);
  assert.doesNotMatch(exactCompressorInput, /-BULK-0/);
  assert.equal(exactCompressorInput.match(/older completed facts omitted or truncated/g)?.length, 1);
  assert.match(stable.text, /STABLE TOOL FACT/);
  assert.match(stable.text, /-BULK-49/);
  assert.doesNotMatch(stable.text, /-BULK-0/);
  assert.equal(stable.text.match(/older completed facts omitted or truncated/g)?.length, 1);
  assert.doesNotMatch(stable.text, /mutable history was inspected/);

  const prepFailureAdmission = runtime.admit(); assert.ok(prepFailureAdmission);
  const unconvertibleHistory = new Proxy([] as unknown[], { get() { throw new Error("input preparation exploded"); } });
  compressorStub.complete = async () => { throw new Error("compressor must not run after input preparation fails"); };
  const prepFailure = await compressEpisode({
    ctx: context(cwd, [compressor]), episodeId: "t6.e1", threadId: "t6", threadName: "prep", task: "retain prepared bound",
    status: "failed", diagnostics: "worker failed", messages: unconvertibleHistory, completedText: "BOUNDED INPUT PREPARATION FALLBACK",
    observations: { stored: false, reason: "no-final-message", grammar: "absent" },
    logicalRuntime: runtime, admission: prepFailureAdmission, retryPolicy: { enabled: true, maxRetries: 0, baseDelayMs: 0 },
  });
  assert.match(prepFailure.text, /Compression failed: input preparation exploded/);
  assert.match(prepFailure.text, /BOUNDED INPUT PREPARATION FALLBACK/);
  // O3: the compression overlay never replaces the worker outcome or its cause.
  assert.equal(prepFailure.compressor, "(uncompressed fallback)");
  assert.equal(prepFailure.costUsd, undefined, "a failed input preparation reports no compression spend");
  assert.match(prepFailure.text, /STATUS: FAILED/);
  assert.match(prepFailure.text, /> failure: worker failed/);
  assert.match(prepFailure.text, /## Open Issues\nworker failed/);
  assert.equal(
    prepFailure.text.slice(prepFailure.text.length - "\n## Open Issues\nworker failed\n".length),
    "\n## Open Issues\nworker failed\n",
    "the bounded fallback keeps the original worker cause as its last section",
  );
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
