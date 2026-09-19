import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import { streamSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RequestThrottleAbort, type RequestThrottle } from "../extension/request-throttle.ts";
import { installRequestThrottle, openWorkerSession, type WorkerSession } from "../extension/worker.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-throttle-worker-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
const sessions: WorkerSession[] = [];

after(() => {
  for (const session of sessions) session.dispose();
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = oldOffline;
  rmSync(scratch, { recursive: true, force: true });
});

async function worker(name: string): Promise<WorkerSession> {
  const ctx = {
    cwd: join(scratch, name),
    hasUI: false,
    isProjectTrusted: () => false,
    model: undefined,
    modelRegistry: {
      getRegisteredProviderIds: () => [],
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    },
  } as unknown as ExtensionContext;
  const session = await openWorkerSession({ ctx });
  sessions.push(session);
  return session;
}

function model(api: Api = "openai-responses"): Model<Api> {
  return {
    api, provider: "openai", id: "test-model", name: "test-model",
    baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
  } as Model<Api>;
}

function response(text = "summary") {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
    provider: "openai", model: "test-model", stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

test("fresh pi 0.85.1 workers already use the SDK stream wrapper rather than streamSimple", { timeout: 5000 }, async () => {
  const session = await worker("identity");
  assert.notStrictEqual(session.agent.streamFunction, streamSimple);
  assert.equal(typeof session.agent.streamFunction, "function");
});

test("worker installation waits before delegating and preserves model, context, options, and errors", { timeout: 5000 }, async () => {
  const session = await worker("delegate");
  const calls: string[] = [];
  const admitted: unknown[] = [];
  let delegated: unknown[] | undefined;
  const sentinel = new Error("delegated failure");
  session.agent.streamFunction = (async (...args: unknown[]) => {
    calls.push("delegate");
    delegated = args;
    throw sentinel;
  }) as typeof session.agent.streamFunction;
  const throttle: RequestThrottle = {
    settings: { enabled: true, maxRequestsPerMinute: 12, baseWaitMs: 1000, jitterMs: 1000 },
    async admit(candidate) { calls.push("admit"); admitted.push(candidate); },
    inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
  };
  installRequestThrottle(session, throttle);
  const selectedModel = model();
  const context = { systemPrompt: "system", messages: [], tools: [] };
  const controller = new AbortController();
  await assert.rejects(async () => session.agent.streamFunction(selectedModel, context, { signal: controller.signal }), sentinel);
  assert.deepEqual(calls, ["admit", "delegate"]);
  assert.strictEqual(delegated?.[0], selectedModel);
  assert.strictEqual(delegated?.[1], context);
  assert.strictEqual((delegated?.[2] as { signal?: AbortSignal }).signal, controller.signal);
  // The limiter must count THIS request's own model. A wrapper that passed a
  // fixed model would merge two models into one counter.
  assert.strictEqual(admitted[0], selectedModel, "the limiter receives the model of this request");

  // A second request of the same session runs on another selected model, and the
  // limiter must see that second model.
  const otherModel = { ...model(), id: "other-model", name: "other-model" } as typeof selectedModel;
  await assert.rejects(async () => session.agent.streamFunction(otherModel, context, { signal: controller.signal }), sentinel);
  assert.strictEqual(admitted[1], otherModel, "a changed selected model reaches the limiter unchanged");
  assert.strictEqual(delegated?.[0], otherModel);
  assert.equal(admitted.length, 2);

  // An out-of-scope interface also reaches the limiter, because the limiter owns
  // the scope decision and the wrapper owns none of it.
  const anthropicModel = model("anthropic-messages");
  await assert.rejects(async () => session.agent.streamFunction(anthropicModel, context, undefined), sentinel);
  assert.strictEqual(admitted[2], anthropicModel);
});

test("worker throttle cancellation rejects before the provider stream function runs", { timeout: 5000 }, async () => {
  const session = await worker("abort");
  let delegated = false;
  session.agent.streamFunction = (async () => { delegated = true; throw new Error("must not run"); }) as typeof session.agent.streamFunction;
  const throttle: RequestThrottle = {
    settings: { enabled: true, maxRequestsPerMinute: 1, baseWaitMs: 1, jitterMs: 0 },
    async admit(_model, signal) {
      if (signal?.aborted) throw new RequestThrottleAbort("request was not sent");
    },
    inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
  };
  installRequestThrottle(session, throttle);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => session.agent.streamFunction(model(), { systemPrompt: "", messages: [], tools: [] }, { signal: controller.signal }), RequestThrottleAbort);
  assert.equal(delegated, false);
});

test("an abort immediately after admission reaches the delegated SDK stream", { timeout: 5000 }, async () => {
  const session = await worker("after-admission-abort");
  const controller = new AbortController();
  let delegatedSignal: AbortSignal | undefined;
  session.agent.streamFunction = (async (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
    delegatedSignal = options.signal;
    return { delegated: true };
  }) as unknown as typeof session.agent.streamFunction;
  const throttle: RequestThrottle = {
    settings: { enabled: true, maxRequestsPerMinute: 1, baseWaitMs: 1, jitterMs: 0 },
    async admit() { controller.abort(); },
    inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
  };
  installRequestThrottle(session, throttle);
  await session.agent.streamFunction(model(), { systemPrompt: "", messages: [], tools: [] }, { signal: controller.signal });
  assert.strictEqual(delegatedSignal, controller.signal);
  assert.equal(delegatedSignal?.aborted, true);
});

test("real SDK summary generation crosses the installed worker throttle once", { timeout: 5000 }, async () => {
  const session = await worker("summary");
  const admissions: Array<{ model: unknown; signal: AbortSignal | undefined }> = [];
  let delegated = 0;
  let summaryOptions: Record<string, unknown> | undefined;
  session.agent.streamFunction = (async (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
    delegated++;
    summaryOptions = options;
    return { result: async () => response() };
  }) as typeof session.agent.streamFunction;
  const throttle: RequestThrottle = {
    settings: { enabled: true, maxRequestsPerMinute: 12, baseWaitMs: 1000, jitterMs: 1000 },
    async admit(candidate, signal) { admissions.push({ model: candidate, signal }); },
    inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
  };
  installRequestThrottle(session, throttle);
  const controller = new AbortController();
  const summaryModel = model();
  const text = await generateSummary(
    [{ role: "user", content: [{ type: "text", text: "history" }], timestamp: Date.now() }],
    summaryModel, 100, "test-key", undefined, controller.signal, undefined, undefined, undefined,
    session.agent.streamFunction,
  );
  assert.equal(text, "summary");
  assert.equal(admissions.length, 1);
  assert.strictEqual(admissions[0]?.signal, controller.signal);
  // The summary's own model reaches the limiter, so a summary counts against the
  // model that produced it.
  assert.strictEqual(admissions[0]?.model, summaryModel);
  assert.equal(delegated, 1);
  assert.equal(summaryOptions?.cacheRetention, "none");
  assert.equal(typeof summaryOptions?.sessionId, "string");
});
