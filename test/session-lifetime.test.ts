const TEST_ROUTE = { model: "gpt-5.6-luna", reason: "test fixture" } as const;

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../verification/test-hooks.mjs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequestThrottle, type RequestThrottle } from "../extension/request-throttle.ts";
import type { SlateConfig } from "../extension/state.ts";
import type { ThreadSessionScope } from "../extension/threads.ts";

const codingAgentModule = await import("@earendil-works/pi-coding-agent") as unknown as {
  codingAgentStub: {
    createAgentSession(options: Record<string, unknown>): Promise<{ session: unknown }>;
  };
};
const { codingAgentStub } = codingAgentModule;
const originalCreateAgentSession = codingAgentStub.createAgentSession;
const { ThreadManager } = await import("../extension/threads.ts");
const { createLogicalRuntime } = await import("../extension/logical-model-runtime.ts");
const { SlateStore, THREAD_TYPES } = await import("../extension/state.ts");

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface PromptGate {
  entered(): void;
  wait: Promise<void>;
}

function session(counter: { disposed: number }, promptGate?: PromptGate) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const messages: unknown[] = [];
  let delegatedRequests = 0;
  return {
    messages,
    get delegatedRequests() { return delegatedRequests; },
    agent: {
      onPayload: async (payload: unknown, _model?: unknown) => payload,
      streamFunction: async (..._args: unknown[]) => {
        delegatedRequests += 1;
        return { delegated: true };
      },
    },
    model: undefined,
    thinkingLevel: "medium",
    sessionFile: undefined,
    modelRuntime: { getRegisteredProviderIds() { return []; } },
    subscribe(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      const requestModel = this.model ?? { api: "openai-responses", provider: "test", id: "worker" };
      await this.agent.streamFunction(requestModel, { systemPrompt: "", messages: [], tools: [] }, {
        reasoning: this.thinkingLevel === "off" ? undefined : this.thinkingLevel,
      });
      promptGate?.entered();
      await promptGate?.wait;
      messages.push({ role: "user", content: text });
      const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
      messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message });
    },
    async abort() {},
    async bindExtensions() {},
    extensionRunner: { async emit() {} },
    dispose() { counter.disposed++; },
    async setModel(model: unknown) { (this as { model?: unknown }).model = model; return true; },
    setThinkingLevel(level: string) { this.thinkingLevel = level; },
    getContextUsage() { return undefined; },
  };
}

test("session scope gives distinct workers one shared key and throttle", { timeout: 2000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-session-scope-"));
  const opened: ReturnType<typeof session>[] = [];
  const counter = { disposed: 0 };
  codingAgentStub.createAgentSession = async (options) => {
    const created = session(counter);
    (created as { model?: unknown }).model = options.model;
    opened.push(created);
    return { session: created };
  };
  let admissions = 0;
  const throttle: RequestThrottle = {
    settings: { enabled: true, maxRequestsPerMinute: 12, baseWaitMs: 1000, jitterMs: 1000 },
    async admit() { admissions++; },
    async accept<T>(_model: unknown, _signal: AbortSignal | undefined, handoff: () => T): Promise<Awaited<T>> { admissions++; return await handoff() as Awaited<T>; },
    inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
  };
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { replace: [{ model: "gpt-5.6-luna", preferredProvider: "test", providers: { test: "worker" } }] } } } });
  const manager = new ThreadManager(store, {}, undefined, runtime, undefined, {
    promptCacheKey: "slate-session-shared",
    requestThrottle: throttle,
  });
  const ctx = {
    cwd, model: undefined, hasUI: false, isProjectTrusted: () => true,
    modelRegistry: {
      find(provider: string, id: string) { return provider === "test" && id === "worker" ? { api: "openai-responses", provider, id, reasoning: true, thinkingLevelMap: { max: "max" } } : undefined; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
      hasConfiguredAuth() { return true; }, async getAvailable() { return []; },
      getRegisteredProviderIds() { return []; }, getRegisteredNativeProvider() { return undefined; }, getRegisteredProviderConfig() { return undefined; },
    },
  } as unknown as ExtensionContext;
  try {
    await manager.dispatch({ ...TEST_ROUTE, task: "first", type: "general" }, ctx, undefined);
    await manager.dispatch({ ...TEST_ROUTE, task: "second", type: "general" }, ctx, undefined);
    for (const openedSession of opened) {
      const payload: Record<string, unknown> = {};
      await openedSession.agent.onPayload?.(payload, { api: "openai-responses" });
      assert.equal(payload.prompt_cache_key, "slate-session-shared");
    }
    assert.equal(opened.length, 2);
    assert.equal(admissions, 2);
  } finally {
    codingAgentStub.createAgentSession = originalCreateAgentSession;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the cache key and request pacing are two independent switches", { timeout: 2000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-two-switches-"));
  const opened: Array<{ worker: ReturnType<typeof session>; rawStream: unknown }> = [];
  const counter = { disposed: 0 };
  const disabledPromptEntered = deferred<void>();
  const disabledPromptRelease = deferred<void>();
  codingAgentStub.createAgentSession = async (options) => {
    const gate = opened.length === 2
      ? { entered: () => disabledPromptEntered.resolve(), wait: disabledPromptRelease.promise }
      : undefined;
    const created = session(counter, gate);
    (created as { model?: unknown }).model = options.model;
    // The raw stream function, taken BEFORE slate can wrap it. A later identity
    // comparison therefore shows whether the throttle wrapper was installed.
    opened.push({ worker: created, rawStream: created.agent.streamFunction });
    return { session: created };
  };
  const openaiModel = { api: "openai-responses", provider: "test", id: "worker" };
  const ctx = {
    cwd, model: undefined, hasUI: false, isProjectTrusted: () => true,
    modelRegistry: {
      find(provider: string, id: string) { return provider === "test" && id === "worker" ? { ...openaiModel, reasoning: true, thinkingLevelMap: { max: "max" } } : undefined; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
      hasConfiguredAuth() { return true; }, async getAvailable() { return []; },
      getRegisteredProviderIds() { return []; }, getRegisteredNativeProvider() { return undefined; }, getRegisteredProviderConfig() { return undefined; },
    },
  } as unknown as ExtensionContext;
  const managerWith = (config: SlateConfig, scope: ThreadSessionScope) =>
    new ThreadManager(
      new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI),
      config,
      undefined,
      createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { replace: [{ model: "gpt-5.6-luna", preferredProvider: "test", providers: { test: "worker" } }] } } } }),
      undefined,
      scope,
    );
  const payloadKey = async (worker: ReturnType<typeof session>): Promise<unknown> => {
    const payload: Record<string, unknown> = {};
    await worker.agent.onPayload?.(payload, openaiModel);
    return payload.prompt_cache_key;
  };
  try {
    // SWITCH ONE OFF: no cache key, and pacing still reaches the worker.
    let admissions = 0;
    const counting: RequestThrottle = {
      settings: { enabled: true, maxRequestsPerMinute: 12, baseWaitMs: 1000, jitterMs: 1000 },
      async admit() { admissions++; },
      async accept<T>(_model: unknown, _signal: AbortSignal | undefined, handoff: () => T): Promise<Awaited<T>> { admissions++; return await handoff() as Awaited<T>; },
      inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
    };
    const pacingOnly = managerWith(
      { cacheKeyEnabled: false },
      { promptCacheKey: "slate-session-withheld", requestThrottle: counting },
    );
    await pacingOnly.dispatch({ ...TEST_ROUTE, task: "pacing only", type: "general" }, ctx, t.signal);
    const first = opened[0]!;
    assert.equal(await payloadKey(first.worker), undefined, "a disabled cache key must not reach the payload");
    assert.notStrictEqual(first.worker.agent.streamFunction, first.rawStream, "pacing must be installed with the cache key off");
    assert.equal(admissions, 1, "the dispatch request must pass the limiter with the cache key off");

    // SWITCH TWO ABSENT: the cache key without any limiter.
    const keyOnly = managerWith({}, { promptCacheKey: "slate-session-key-only" });
    await keyOnly.dispatch({ ...TEST_ROUTE, task: "key only", type: "general" }, ctx, t.signal);
    const second = opened[1]!;
    assert.equal(await payloadKey(second.worker), "slate-session-key-only");
    assert.notStrictEqual(second.worker.agent.streamFunction, second.rawStream, "the request contract remains installed without a limiter");
    assert.equal(admissions, 1, "a worker without a limiter must not reach another session's limiter");

    // BOTH ON, PACING DISABLED BY ITS OWN SETTING: the key still reaches the
    // payload, requests never wait, and the limiter keeps no state.
    const disabled = createRequestThrottle({ enabled: false, maxRequestsPerMinute: 1, baseWaitMs: 1000, jitterMs: 1000 });
    const both = managerWith({}, { promptCacheKey: "slate-session-both", requestThrottle: disabled });
    const bothDispatch = both.dispatch({ ...TEST_ROUTE, task: "both", type: "general" }, ctx, t.signal);
    await disabledPromptEntered.promise;
    const third = opened[2]!;
    assert.equal(await payloadKey(third.worker), "slate-session-both");
    assert.notStrictEqual(third.worker.agent.streamFunction, third.rawStream);
    assert.deepEqual(disabled.inspect(), { models: 0, timestamps: 0, waiters: 0 });

    const before = third.worker.delegatedRequests;
    for (let i = 0; i < 5; i++) {
      await third.worker.agent.streamFunction(openaiModel, {}, {
        signal: t.signal,
        reasoning: third.worker.thinkingLevel === "off" ? undefined : third.worker.thinkingLevel,
      });
    }
    assert.equal(third.worker.delegatedRequests, before + 5, "all five disabled-throttle requests must reach the underlying handoff");
    assert.deepEqual(disabled.inspect(), { models: 0, timestamps: 0, waiters: 0 });
    disabledPromptRelease.resolve();
    await bothDispatch;
  } finally {
    disabledPromptRelease.resolve();
    codingAgentStub.createAgentSession = originalCreateAgentSession;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("each completed action opens and disposes a distinct real worker session", { timeout: 2000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-session-lifetime-"));
  const opened: unknown[] = [];
  const counter = { disposed: 0 };
  codingAgentStub.createAgentSession = async (options: Record<string, unknown>) => {
    const created = session(counter);
    (created as { model?: unknown }).model = options.model;
    opened.push(created);
    return { session: created };
  };
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const runtime = createLogicalRuntime({
    trusted: true,
    projectConfig: { router: { models: { replace: [{ model: "gpt-5.6-luna", preferredProvider: "test", providers: { test: "worker" } }] } } },
  });
  const manager = new ThreadManager(store, { cacheKeyEnabled: false }, undefined, runtime, { enabled: true, maxRetries: 0, baseDelayMs: 0 });
  const ctx = {
    cwd,
    model: undefined,
    hasUI: false,
    isProjectTrusted: () => true,
    modelRegistry: {
      find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id, reasoning: true, thinkingLevelMap: { max: "max" } } : undefined; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; }, hasConfiguredAuth() { return true; }, async getAvailable() { return []; },
    },
  } as unknown as ExtensionContext;
  try {
    for (const type of THREAD_TYPES) {
      const before = opened.length;
      await manager.dispatch({ ...TEST_ROUTE, type, task: `${type} first` }, ctx, undefined);
      await manager.dispatch({ ...TEST_ROUTE, type, task: `${type} second` }, ctx, undefined);
      assert.notStrictEqual(opened[before], opened[before + 1], `${type} actions must not reuse a session`);
    }
    assert.equal(opened.length, THREAD_TYPES.length * 2);
    assert.equal(new Set(opened).size, opened.length);
    assert.equal(counter.disposed, opened.length);
    assert.equal((manager as unknown as { live: Map<string, unknown> }).live.size, 0);
  } finally {
    codingAgentStub.createAgentSession = originalCreateAgentSession;
    rmSync(cwd, { recursive: true, force: true });
  }
});
