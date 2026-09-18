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
const { SlateStore, THREAD_TYPES } = await import("../extension/state.ts");

function session(counter: { disposed: number }) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const messages: unknown[] = [];
  return {
    messages,
    agent: {
      onPayload: async (payload: unknown, _model?: unknown) => payload,
      streamFunction: async (..._args: unknown[]) => ({ delegated: true }),
    },
    model: undefined,
    thinkingLevel: "medium",
    sessionFile: undefined,
    subscribe(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      messages.push({ role: "user", content: text });
      const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
      messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message });
    },
    async abort() {},
    dispose() { counter.disposed++; },
    async setModel() {},
    setThinkingLevel() {},
    getContextUsage() { return undefined; },
  };
}

test("session scope gives distinct workers one shared key and throttle", { timeout: 2000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-session-scope-"));
  const opened: ReturnType<typeof session>[] = [];
  const counter = { disposed: 0 };
  codingAgentStub.createAgentSession = async () => {
    const created = session(counter);
    opened.push(created);
    return { session: created };
  };
  let admissions = 0;
  const throttle: RequestThrottle = {
    settings: { enabled: true, maxRequestsPerMinute: 12, baseWaitMs: 1000, jitterMs: 1000 },
    async admit() { admissions++; },
    inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
  };
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, {}, undefined, undefined, undefined, {
    promptCacheKey: "slate-session-shared",
    requestThrottle: throttle,
  });
  const ctx = {
    cwd, model: undefined, hasUI: false, isProjectTrusted: () => true,
    modelRegistry: { find() { return undefined; }, hasConfiguredAuth() { return false; }, async getAvailable() { return []; } },
  } as unknown as ExtensionContext;
  try {
    await manager.dispatch({ task: "first", type: "general" }, ctx, undefined);
    await manager.dispatch({ task: "second", type: "general" }, ctx, undefined);
    for (const openedSession of opened) {
      const payload: Record<string, unknown> = {};
      await openedSession.agent.onPayload?.(payload, { api: "openai-responses" });
      assert.equal(payload.prompt_cache_key, "slate-session-shared");
      await openedSession.agent.streamFunction({ api: "openai-responses" }, {}, {});
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
  codingAgentStub.createAgentSession = async () => {
    const created = session(counter);
    // The raw stream function, taken BEFORE slate can wrap it. A later identity
    // comparison therefore shows whether the throttle wrapper was installed.
    opened.push({ worker: created, rawStream: created.agent.streamFunction });
    return { session: created };
  };
  const openaiModel = { api: "openai-responses" };
  const ctx = {
    cwd, model: undefined, hasUI: false, isProjectTrusted: () => true,
    modelRegistry: { find() { return undefined; }, hasConfiguredAuth() { return false; }, async getAvailable() { return []; } },
  } as unknown as ExtensionContext;
  const managerWith = (config: SlateConfig, scope: ThreadSessionScope) =>
    new ThreadManager(
      new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI),
      config,
      undefined,
      undefined,
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
      inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
    };
    const pacingOnly = managerWith(
      { cacheKeyEnabled: false },
      { promptCacheKey: "slate-session-withheld", requestThrottle: counting },
    );
    await pacingOnly.dispatch({ task: "pacing only", type: "general" }, ctx, t.signal);
    const first = opened[0]!;
    assert.equal(await payloadKey(first.worker), undefined, "a disabled cache key must not reach the payload");
    assert.notStrictEqual(first.worker.agent.streamFunction, first.rawStream, "pacing must be installed with the cache key off");
    await first.worker.agent.streamFunction(openaiModel, {}, { signal: t.signal });
    assert.equal(admissions, 1, "the request must pass the limiter with the cache key off");

    // SWITCH TWO ABSENT: the cache key without any limiter.
    const keyOnly = managerWith({}, { promptCacheKey: "slate-session-key-only" });
    await keyOnly.dispatch({ task: "key only", type: "general" }, ctx, t.signal);
    const second = opened[1]!;
    assert.equal(await payloadKey(second.worker), "slate-session-key-only");
    assert.strictEqual(second.worker.agent.streamFunction, second.rawStream, "no limiter means no wrapper");
    await second.worker.agent.streamFunction(openaiModel, {}, { signal: t.signal });
    assert.equal(admissions, 1, "a worker without a limiter must not reach another session's limiter");

    // BOTH ON, PACING DISABLED BY ITS OWN SETTING: the key still reaches the
    // payload, requests never wait, and the limiter keeps no state.
    const disabled = createRequestThrottle({ enabled: false, maxRequestsPerMinute: 1, baseWaitMs: 1000, jitterMs: 1000 });
    const both = managerWith({}, { promptCacheKey: "slate-session-both", requestThrottle: disabled });
    await both.dispatch({ task: "both", type: "general" }, ctx, t.signal);
    const third = opened[2]!;
    assert.equal(await payloadKey(third.worker), "slate-session-both");
    assert.notStrictEqual(third.worker.agent.streamFunction, third.rawStream);
    for (let i = 0; i < 5; i++) {
      await third.worker.agent.streamFunction(openaiModel, {}, { signal: t.signal });
    }
    assert.deepEqual(disabled.inspect(), { models: 0, timestamps: 0, waiters: 0 });
  } finally {
    codingAgentStub.createAgentSession = originalCreateAgentSession;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("each completed action opens and disposes a distinct real worker session", { timeout: 2000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-session-lifetime-"));
  const opened: unknown[] = [];
  const counter = { disposed: 0 };
  codingAgentStub.createAgentSession = async () => {
    const created = session(counter);
    opened.push(created);
    return { session: created };
  };
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, { cacheKeyEnabled: false });
  const ctx = {
    cwd,
    model: undefined,
    hasUI: false,
    isProjectTrusted: () => true,
    modelRegistry: { find() { return undefined; }, hasConfiguredAuth() { return false; }, async getAvailable() { return []; } },
  } as unknown as ExtensionContext;
  try {
    for (const type of THREAD_TYPES) {
      const before = opened.length;
      await manager.dispatch({ type, task: `${type} first` }, ctx, undefined);
      await manager.dispatch({ type, task: `${type} second` }, ctx, undefined);
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
