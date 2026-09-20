/**
 * Entry-point wiring for the shared cache key and the shared request throttle.
 *
 * Every other test in this family builds a ThreadManager itself. This file does
 * not: it registers the REAL extension from extension/index.ts, emits the real
 * `session_start` event, and dispatches through the real registered `thread`
 * tool. Only that path proves that one main session hands one cache key and one
 * limiter to every worker, and that a second main session starts with a new key
 * and an empty request budget.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import "../verification/test-hooks.mjs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RequestThrottleAbort } from "../extension/request-throttle.ts";

const codingAgentModule = await import("@earendil-works/pi-coding-agent") as unknown as {
  codingAgentStub: { createAgentSession(options: Record<string, unknown>): Promise<{ session: unknown }> };
};
const { codingAgentStub } = codingAgentModule;
const originalCreateAgentSession = codingAgentStub.createAgentSession;
const slateExtension = (await import("../extension/index.ts")).default;

const scratch = mkdtempSync(join(tmpdir(), "slate-throttle-entry-"));
after(() => {
  codingAgentStub.createAgentSession = originalCreateAgentSession;
  rmSync(scratch, { recursive: true, force: true });
});

const OPENAI_MODEL = { api: "openai-responses", provider: "openai", id: "entry-model" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type WorkerStub = ReturnType<typeof workerSessionStub>;

function workerSessionStub(initialModel?: unknown) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const messages: unknown[] = [];
  const requestStarted = deferred<void>();
  const requestFailed = deferred<unknown>();
  const promptRelease = deferred<void>();
  const requestAbort = new AbortController();
  let delegatedRequests = 0;
  const worker = {
    messages,
    get delegatedRequests() { return delegatedRequests; },
    requestStarted: requestStarted.promise,
    requestFailed: requestFailed.promise,
    finishPrompt() { promptRelease.resolve(); },
    agent: {
      onPayload: async (payload: unknown, _model?: unknown) => payload,
      streamFunction: async (..._args: unknown[]) => {
        delegatedRequests += 1;
        return { delegated: true };
      },
    },
    model: initialModel,
    thinkingLevel: "off",
    sessionFile: undefined,
    modelRuntime: { getRegisteredProviderIds() { return []; } },
    subscribe(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      requestStarted.resolve();
      try {
        await worker.agent.streamFunction(
          { ...(worker.model as object), api: "openai-responses", provider: "test", id: "worker" },
          { systemPrompt: "", messages: [], tools: [] },
          { signal: requestAbort.signal },
        );
      } catch (error) {
        requestFailed.resolve(error);
        throw error;
      }
      await promptRelease.promise;
      messages.push({ role: "user", content: text });
      const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
      messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message });
    },
    async abort() { requestAbort.abort(); },
    async bindExtensions() {},
    extensionRunner: { async emit() {}, onError() { return () => {}; } },
    dispose() {},
    async setModel() {},
    setThinkingLevel() {},
    getContextUsage() { return undefined; },
  };
  return worker;
}

type Handler = (event: unknown, context: ExtensionContext) => unknown;
type RegisteredTool = {
  name: string;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<unknown>;
};

/** A pi API stand-in that KEEPS the registered tools, so a test can call them. */
class CapturingExtensionApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, RegisteredTool>();

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(): void {}
  registerTool(tool: RegisteredTool): void { this.tools.set(tool.name, tool); }
  getActiveTools(): string[] { return []; }
  setActiveTools(): void {}
  getAllTools(): Array<{ name: string }> { return []; }
  appendEntry(): void {}
  sendMessage(): void {}
  getThinkingLevel(): undefined { return undefined; }

  async emit(event: string, payload: unknown, context: ExtensionContext): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, context);
  }
}

function project(name: string, config: unknown): string {
  const cwd = join(scratch, name);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify(config));
  return cwd;
}

function context(cwd: string, warnings: string[]): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    model: undefined,
    modelRegistry: {
      find(provider: string, id: string) { return provider === "test" && id === "worker" ? { api: "openai-responses", provider, id, reasoning: false } : undefined; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
      hasConfiguredAuth() { return true; }, async getAvailable() { return []; },
      getRegisteredProviderIds() { return []; }, getRegisteredNativeProvider() { return undefined; }, getRegisteredProviderConfig() { return undefined; },
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    ui: { notify: (message: string) => warnings.push(message), setWidget: () => {}, setStatus: () => {} },
  } as unknown as ExtensionContext;
}

/** One request throttle admits one request per minute, and a wait lasts a minute. */
const ONE_PER_MINUTE = {
  router: { models: { include: [], add: [{
    model: "fixture", capabilityRating: 50, costRating: 50, effort: "off",
    preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [],
  }] } },
  requestThrottle: { maxRequestsPerMinute: 1, baseWaitMs: 60000, jitterMs: 0 },
};

function harness(): { api: CapturingExtensionApi; opened: WorkerStub[]; workerAt(index: number): Promise<WorkerStub> } {
  const opened: WorkerStub[] = [];
  const opening = new Map<number, Deferred<WorkerStub>>();
  codingAgentStub.createAgentSession = async (options) => {
    const created = workerSessionStub(options.model);
    const index = opened.push(created) - 1;
    opening.get(index)?.resolve(created);
    return { session: created };
  };
  const api = new CapturingExtensionApi();
  slateExtension(api as unknown as ExtensionAPI);
  return {
    api,
    opened,
    workerAt(index) {
      const existing = opened[index];
      if (existing !== undefined) return Promise.resolve(existing);
      let pending = opening.get(index);
      if (pending === undefined) {
        pending = deferred<WorkerStub>();
        opening.set(index, pending);
      }
      return pending.promise;
    },
  };
}

async function dispatch(api: CapturingExtensionApi, ctx: ExtensionContext, task: string, signal: AbortSignal): Promise<void> {
  const tool = api.tools.get("thread");
  assert.ok(tool, "the extension must register the thread tool");
  await tool.execute(`call-${task}`, { model: "fixture", reason: "throttle fixture", type: "general", task }, signal, undefined, ctx);
}

async function cacheKeyOf(worker: WorkerStub): Promise<unknown> {
  const payload: Record<string, unknown> = {};
  await worker.agent.onPayload(payload, OPENAI_MODEL);
  return payload.prompt_cache_key;
}

test("one main session gives every worker the same cache key and one shared request budget", { timeout: 20000 }, async (t) => {
  const { api, opened, workerAt } = harness();
  const warnings: string[] = [];
  const cwd = project("shared-scope", ONE_PER_MINUTE);
  const ctx = context(cwd, warnings);
  await api.emit("session_start", {}, ctx);

  const firstWorker = workerAt(0);
  const firstDispatch = dispatch(api, ctx, "first", t.signal);
  const first = await firstWorker;
  await first.requestStarted;
  assert.equal(first.delegatedRequests, 1, "the first request must cross the real worker stream handoff");

  const secondController = new AbortController();
  const secondWorker = workerAt(1);
  const secondDispatch = dispatch(api, ctx, "second", AbortSignal.any([secondController.signal, t.signal]));
  const second = await secondWorker;
  await second.requestStarted;

  assert.equal(opened.length, 2, "two live actions must open two worker sessions");
  const firstKey = await cacheKeyOf(first);
  const secondKey = await cacheKeyOf(second);
  assert.match(String(firstKey), /^slate-session-/);
  assert.equal(secondKey, firstKey, "both workers of one main session share one cache key");
  assert.equal(first.delegatedRequests, 1);
  assert.equal(second.delegatedRequests, 0, "the second worker must wait before the underlying provider handoff");

  secondController.abort();
  const blockedError = await second.requestFailed;
  assert.ok(blockedError instanceof RequestThrottleAbort, "cancelling a paced request must preserve the throttle abort outcome");
  await assert.rejects(secondDispatch, /cancelled by the caller/);
  assert.equal(second.delegatedRequests, 0, "a cancelled waiter must never delegate its request");

  first.finishPrompt();
  await firstDispatch;
  assert.deepEqual(warnings, []);
});

test("a second main session issues a new cache key and an empty request budget", { timeout: 20000 }, async (t) => {
  const { api, opened, workerAt } = harness();
  const warnings: string[] = [];
  const firstCwd = project("scope-one", ONE_PER_MINUTE);
  const firstCtx = context(firstCwd, warnings);
  await api.emit("session_start", {}, firstCtx);

  const oldWorkerPromise = workerAt(0);
  const oldDispatch = dispatch(api, firstCtx, "one", t.signal);
  const oldWorker = await oldWorkerPromise;
  await oldWorker.requestStarted;
  assert.equal(oldWorker.delegatedRequests, 1);
  const firstKey = await cacheKeyOf(oldWorker);
  oldWorker.finishPrompt();
  await oldDispatch;

  // The first live request in a new main session must delegate immediately. A
  // second live request must then wait on that new session's own threshold.
  const secondCwd = project("scope-two", ONE_PER_MINUTE);
  const secondCtx = context(secondCwd, warnings);
  await api.emit("session_start", {}, secondCtx);
  const freshWorkerPromise = workerAt(1);
  const freshDispatch = dispatch(api, secondCtx, "fresh", t.signal);
  const freshWorker = await freshWorkerPromise;
  await freshWorker.requestStarted;
  assert.equal(freshWorker.delegatedRequests, 1, "the new main session must start with an empty request budget");
  const secondKey = await cacheKeyOf(freshWorker);
  assert.match(String(secondKey), /^slate-session-/);
  assert.notEqual(secondKey, firstKey, "a new main session must not reuse the previous cache key");

  const blockedController = new AbortController();
  const blockedWorkerPromise = workerAt(2);
  const blockedDispatch = dispatch(api, secondCtx, "threshold", AbortSignal.any([blockedController.signal, t.signal]));
  const blockedWorker = await blockedWorkerPromise;
  await blockedWorker.requestStarted;
  assert.equal(blockedWorker.delegatedRequests, 0, "the new limiter must enforce its configured threshold");

  blockedController.abort();
  const blockedError = await blockedWorker.requestFailed;
  assert.ok(blockedError instanceof RequestThrottleAbort);
  await assert.rejects(blockedDispatch, /cancelled by the caller/);
  assert.equal(blockedWorker.delegatedRequests, 0);

  freshWorker.finishPrompt();
  await freshDispatch;
  assert.equal(opened.length, 3);
  assert.deepEqual(warnings, []);
});
