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

type WorkerStub = ReturnType<typeof workerSessionStub>;

function workerSessionStub() {
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
    dispose() {},
    async setModel() {},
    setThinkingLevel() {},
    getContextUsage() { return undefined; },
  };
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
    modelRegistry: { find() { return undefined; }, hasConfiguredAuth() { return false; }, async getAvailable() { return []; } },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    ui: { notify: (message: string) => warnings.push(message), setWidget: () => {}, setStatus: () => {} },
  } as unknown as ExtensionContext;
}

/** One request throttle admits one request per minute, and a wait lasts a minute. */
const ONE_PER_MINUTE = { requestThrottle: { maxRequestsPerMinute: 1, baseWaitMs: 60000, jitterMs: 0 } };

function harness(): { api: CapturingExtensionApi; opened: WorkerStub[] } {
  const opened: WorkerStub[] = [];
  codingAgentStub.createAgentSession = async () => {
    const created = workerSessionStub();
    opened.push(created);
    return { session: created };
  };
  const api = new CapturingExtensionApi();
  slateExtension(api as unknown as ExtensionAPI);
  return { api, opened };
}

async function dispatch(api: CapturingExtensionApi, ctx: ExtensionContext, task: string, signal: AbortSignal): Promise<void> {
  const tool = api.tools.get("thread");
  assert.ok(tool, "the extension must register the thread tool");
  await tool.execute(`call-${task}`, { type: "general", task }, signal, undefined, ctx);
}

async function cacheKeyOf(worker: WorkerStub): Promise<unknown> {
  const payload: Record<string, unknown> = {};
  await worker.agent.onPayload(payload, OPENAI_MODEL);
  return payload.prompt_cache_key;
}

/** Start one request and report whether it is still waiting for capacity. */
function startRequest(worker: WorkerStub, testSignal: AbortSignal): { pending: Promise<unknown>; settled: () => boolean; cancel: () => void } {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, testSignal]);
  let done = false;
  const pending = worker.agent.streamFunction(OPENAI_MODEL, { systemPrompt: "", messages: [], tools: [] }, { signal });
  void pending.then(() => { done = true; }, () => { done = true; });
  return { pending, settled: () => done, cancel: () => controller.abort() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("one main session gives every worker the same cache key and one shared request budget", { timeout: 20000 }, async (t) => {
  const { api, opened } = harness();
  const warnings: string[] = [];
  const cwd = project("shared-scope", ONE_PER_MINUTE);
  const ctx = context(cwd, warnings);
  await api.emit("session_start", {}, ctx);
  await dispatch(api, ctx, "first", t.signal);
  await dispatch(api, ctx, "second", t.signal);
  assert.deepEqual(warnings, []);
  assert.equal(opened.length, 2, "two actions must open two worker sessions");

  const first = opened[0]!;
  const second = opened[1]!;
  const firstKey = await cacheKeyOf(first);
  const secondKey = await cacheKeyOf(second);
  assert.match(String(firstKey), /^slate-session-/);
  assert.equal(secondKey, firstKey, "both workers of one main session share one cache key");

  // The single admission of this main session is taken by the first worker, so
  // the second worker must wait. That wait proves the two workers share ONE
  // limiter and that the limiter runs on this project's configured threshold.
  const admitted = startRequest(first, t.signal);
  await admitted.pending;
  const blocked = startRequest(second, t.signal);
  await settle();
  assert.equal(blocked.settled(), false, "a second worker must wait on the shared request budget");
  blocked.cancel();
  await assert.rejects(blocked.pending, RequestThrottleAbort);
});

test("a second main session issues a new cache key and an empty request budget", { timeout: 20000 }, async (t) => {
  const { api, opened } = harness();
  const warnings: string[] = [];
  const firstCwd = project("scope-one", ONE_PER_MINUTE);
  const firstCtx = context(firstCwd, warnings);
  await api.emit("session_start", {}, firstCtx);
  await dispatch(api, firstCtx, "one", t.signal);
  const firstWorker = opened[0]!;
  const firstKey = await cacheKeyOf(firstWorker);
  const firstAdmission = startRequest(firstWorker, t.signal);
  await firstAdmission.pending;

  // A new main session. Its workers must receive a new key and a limiter whose
  // window holds none of the admissions above.
  const secondCwd = project("scope-two", ONE_PER_MINUTE);
  const secondCtx = context(secondCwd, warnings);
  await api.emit("session_start", {}, secondCtx);
  await dispatch(api, secondCtx, "two", t.signal);
  assert.deepEqual(warnings, []);
  assert.equal(opened.length, 2);
  const secondWorker = opened[1]!;
  const secondKey = await cacheKeyOf(secondWorker);
  assert.match(String(secondKey), /^slate-session-/);
  assert.notEqual(secondKey, firstKey, "a new main session must not reuse the previous cache key");

  const fresh = startRequest(secondWorker, t.signal);
  await settle();
  assert.equal(fresh.settled(), true, "the new main session starts with an empty request budget");
  await fresh.pending;

  // The new limiter still enforces the configured threshold, so the next request
  // of this main session waits.
  const blocked = startRequest(secondWorker, t.signal);
  await settle();
  assert.equal(blocked.settled(), false, "the new limiter must enforce the configured threshold");
  blocked.cancel();
  await assert.rejects(blocked.pending, RequestThrottleAbort);
});
