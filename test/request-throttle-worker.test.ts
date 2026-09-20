import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError, streamSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequestThrottle, RequestThrottleAbort, type RequestThrottle } from "../extension/request-throttle.ts";
import {
  createWorkerRequestContract,
  installRequestThrottle,
  openWorkerSession,
  WORKER_REQUEST_CONTRACT_ERROR,
  type WorkerSession,
} from "../extension/worker.ts";

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

test("worker request contract accepts off as undefined and uses a stable non-retryable refusal", { timeout: 5000 }, () => {
  const contract = createWorkerRequestContract();
  contract.expect({ provider: "openai", model: "test-model", effort: "off" });
  const result = contract.accept(model(), undefined, undefined, () => "delegated");
  assert.equal(result, "delegated");
  assert.deepEqual(contract.latestAccepted(), { model: { provider: "openai", id: "test-model" }, effort: "off" });
  assert.throws(
    () => contract.accept({ ...model(), id: "drift" }, undefined, undefined, () => "must not run"),
    (error: Error) => error.message === WORKER_REQUEST_CONTRACT_ERROR,
  );
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: WORKER_REQUEST_CONTRACT_ERROR } as never), false);
});

test("worker request contracts isolate actions and replace history only on acceptance", { timeout: 5000 }, () => {
  const first = createWorkerRequestContract();
  const second = createWorkerRequestContract();
  first.expect({ provider: "openai", model: "test-model", effort: "off" });
  second.expect({ provider: "openai", model: "other", effort: "high" });
  first.accept(model(), undefined, undefined, () => "initial");
  assert.equal(second.latestAccepted(), undefined);
  // One refused request is terminal for its own owner. The blocked-request rule
  // and the later legitimate recovery acceptance therefore need separate owners.
  // Both rules keep the assertions they had before that tightening.
  const blockedOwner = createWorkerRequestContract();
  blockedOwner.expect({ provider: "openai", model: "test-model", effort: "off" });
  blockedOwner.accept(model(), undefined, undefined, () => "initial");
  blockedOwner.expect({ provider: "openai", model: "recovery", effort: "high" });
  assert.throws(() => blockedOwner.accept(model(), undefined, undefined, () => "blocked"));
  assert.deepEqual(blockedOwner.latestAccepted(), { model: { provider: "openai", id: "test-model" }, effort: "off" });
  first.expect({ provider: "openai", model: "recovery", effort: "high" });
  const controller = new AbortController();
  first.accept({ ...model(), id: "recovery" }, "high", undefined, () => { controller.abort(); return "accepted"; });
  assert.deepEqual(first.latestAccepted(), { model: { provider: "openai", id: "recovery" }, effort: "high" });
  first.expect({ provider: "openai", model: "later", effort: "high" });
  assert.throws(() => first.accept({ ...model(), id: "blocked-later" }, "high", undefined, () => "must not run"));
  assert.deepEqual(first.latestAccepted(), { model: { provider: "openai", id: "recovery" }, effort: "high" });
  second.accept({ ...model(), id: "other" }, "high", undefined, () => "second");
  assert.deepEqual(second.latestAccepted(), { model: { provider: "openai", id: "other" }, effort: "high" });
  first.invalidate();
  assert.throws(() => first.accept({ ...model(), id: "recovery" }, "high", undefined, () => "stale"));
});

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
    async accept<T>(candidate: unknown, _signal: AbortSignal | undefined, handoff: () => T): Promise<Awaited<T>> { calls.push("admit"); admitted.push(candidate); return await handoff() as Awaited<T>; },
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
    async accept<T>(_model: unknown, signal: AbortSignal | undefined, handoff: () => T): Promise<Awaited<T>> {
      if (signal?.aborted) throw new RequestThrottleAbort("request was not sent");
      return await handoff() as Awaited<T>;
    },
    inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
  };
  installRequestThrottle(session, throttle);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => session.agent.streamFunction(model(), { systemPrompt: "", messages: [], tools: [] }, { signal: controller.signal }), RequestThrottleAbort);
  assert.equal(delegated, false);
});

test("contract invalidation wakes an installed paced request without waiting for capacity or Pi disposal", { timeout: 5000 }, async () => {
  const session = await worker("contract-invalidation-wake");
  let delegated = 0;
  session.agent.streamFunction = (() => { delegated++; return { delegated: true }; }) as unknown as typeof session.agent.streamFunction;
  const scheduled: Array<{ cancelled: boolean; run(): void }> = [];
  const throttle = createRequestThrottle(
    { enabled: true, maxRequestsPerMinute: 1, baseWaitMs: 1, jitterMs: 0 },
    {
      now: () => 0,
      random: () => 0,
      schedule(_delay, run) {
        const item = { cancelled: false, run };
        scheduled.push(item);
        return () => { item.cancelled = true; };
      },
      scheduleExpiry: () => () => {},
    },
  );
  await throttle.accept(model(), undefined, () => "seed quota");
  const contract = createWorkerRequestContract();
  contract.expect({ provider: "openai", model: "test-model", effort: "off" });
  installRequestThrottle(session, throttle, contract);
  const pending = session.agent.streamFunction(model(), { systemPrompt: "", messages: [], tools: [] }, undefined);
  await Promise.resolve();
  assert.deepEqual(throttle.inspect(), { models: 1, timestamps: 1, waiters: 1 });
  assert.equal(scheduled.length, 1);
  contract.invalidate();
  await assert.rejects(async () => pending, new RegExp(WORKER_REQUEST_CONTRACT_ERROR));
  assert.equal(scheduled[0]?.cancelled, true);
  assert.equal(scheduled.length, 1, "a held shutdown cannot cause repeated pacing timers");
  assert.equal(delegated, 0);
  assert.equal(contract.latestAccepted(), undefined);
  assert.deepEqual(throttle.inspect(), { models: 1, timestamps: 1, waiters: 0 });
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
    async accept<T>(_model: unknown, _signal: AbortSignal | undefined, handoff: () => T): Promise<Awaited<T>> { controller.abort(); return await handoff() as Awaited<T>; },
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
    async accept<T>(candidate: unknown, signal: AbortSignal | undefined, handoff: () => T): Promise<Awaited<T>> { admissions.push({ model: candidate, signal }); return await handoff() as Awaited<T>; },
    inspect() { return { models: 0, timestamps: 0, waiters: 0 }; },
  };
  const contract = createWorkerRequestContract();
  contract.expect({ provider: "openai", model: "test-model", effort: "off" });
  installRequestThrottle(session, throttle, contract);
  const controller = new AbortController();
  const summaryModel = model();
  const text = await generateSummary(
    [{ role: "user", content: [{ type: "text", text: "history" }], timestamp: Date.now() }],
    summaryModel, 100, "test-key", undefined, controller.signal, undefined, undefined, undefined,
    session.agent.streamFunction,
  );
  assert.equal(text, "summary");
  assert.equal(admissions.length, 1);
  assert.notStrictEqual(admissions[0]?.signal, controller.signal, "the pacing wait also observes lifecycle invalidation");
  assert.equal(admissions[0]?.signal?.aborted, false);
  assert.strictEqual(summaryOptions?.signal, controller.signal, "the provider handoff keeps Pi's original request signal");
  // The summary's own model reaches the limiter, so a summary counts against the
  // model that produced it.
  assert.strictEqual(admissions[0]?.model, summaryModel);
  assert.equal(delegated, 1);
  assert.deepEqual(contract.latestAccepted(), { model: { provider: "openai", id: "test-model" }, effort: "off" });
  assert.equal(summaryOptions?.cacheRetention, "none");
  assert.equal(typeof summaryOptions?.sessionId, "string");
});

test("the request owner records an attempted refused request and keeps caller cancellation separate", { timeout: 5000 }, () => {
  const missing = createWorkerRequestContract();
  assert.throws(
    () => missing.accept(model(), undefined, undefined, () => "no expectation exists"),
    (error: Error) => error.message === WORKER_REQUEST_CONTRACT_ERROR,
  );
  assert.equal(missing.refusal(), WORKER_REQUEST_CONTRACT_ERROR, "a request without a current expectation is a refusal");

  const drifted = createWorkerRequestContract();
  drifted.expect({ provider: "openai", model: "test-model", effort: "off" });
  assert.equal(drifted.refusal(), undefined);
  drifted.accept(model(), undefined, undefined, () => "accepted before the refusal");
  assert.throws(() => drifted.accept({ ...model(), id: "drift" }, undefined, undefined, () => "must not run"));
  assert.equal(drifted.refusal(), WORKER_REQUEST_CONTRACT_ERROR, "a drifted request is a refusal");
  // The corrected route is the exact pair the owner now expects. The first
  // refusal is terminal for this action, so this request must not hand off.
  drifted.expect({ provider: "openai", model: "drift", effort: "off" });
  let correctedHandoffs = 0;
  assert.throws(
    () => drifted.accept({ ...model(), id: "drift" }, undefined, undefined, () => { correctedHandoffs++; return "must not run"; }),
    (error: Error) => error.message === WORKER_REQUEST_CONTRACT_ERROR,
  );
  assert.equal(correctedHandoffs, 0, "a corrected pair cannot be accepted after a refusal");
  assert.deepEqual(
    drifted.latestAccepted(),
    { model: { provider: "openai", id: "test-model" }, effort: "off" },
    "the identity accepted before the refusal stays",
  );
  assert.equal(drifted.refusal(), WORKER_REQUEST_CONTRACT_ERROR, "a later request cannot clear the recorded refusal");

  const stale = createWorkerRequestContract();
  stale.expect({ provider: "openai", model: "test-model", effort: "off" });
  stale.invalidate();
  assert.throws(() => stale.accept(model(), undefined, undefined, () => "must not run"));
  assert.equal(stale.refusal(), WORKER_REQUEST_CONTRACT_ERROR, "a request that reaches an inactive owner is a refusal");

  const cancelled = createWorkerRequestContract();
  cancelled.expect({ provider: "openai", model: "test-model", effort: "off" });
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => cancelled.accept(model(), undefined, controller.signal, () => "must not run"));
  assert.equal(cancelled.refusal(), undefined, "caller cancellation is not a refused request");
  assert.equal(cancelled.latestAccepted(), undefined);
});

test("repeated lifecycle invalidation aborts once, throws nothing, and changes no owner state", { timeout: 5000 }, () => {
  const contract = createWorkerRequestContract();
  contract.expect({ provider: "openai", model: "test-model", effort: "off" });
  contract.accept(model(), undefined, undefined, () => "accepted");
  let aborts = 0;
  contract.invalidationSignal.addEventListener("abort", () => { aborts++; });
  contract.invalidate();
  assert.doesNotThrow(() => contract.invalidate());
  contract.invalidate();
  assert.equal(aborts, 1, "one lifecycle invalidation aborts the signal exactly once");
  assert.equal(contract.invalidationSignal.aborted, true);
  assert.deepEqual(contract.latestAccepted(), { model: { provider: "openai", id: "test-model" }, effort: "off" });
  assert.equal(contract.refusal(), undefined, "an invalidation that no request reached is not a refusal");
});

test("caller cancellation of a paced contract request keeps its own identity and records no refusal", { timeout: 5000 }, async () => {
  for (const alsoInvalidate of [false, true]) {
    const session = await worker(`caller-cancel-${alsoInvalidate ? "and-invalidate" : "only"}`);
    let delegated = 0;
    session.agent.streamFunction = (() => { delegated++; return { delegated: true }; }) as unknown as typeof session.agent.streamFunction;
    const scheduled: Array<{ cancelled: boolean; run(): void }> = [];
    const throttle = createRequestThrottle(
      { enabled: true, maxRequestsPerMinute: 1, baseWaitMs: 1, jitterMs: 0 },
      {
        now: () => 0,
        random: () => 0,
        schedule(_delay, run) {
          const item = { cancelled: false, run };
          scheduled.push(item);
          return () => { item.cancelled = true; };
        },
        scheduleExpiry: () => () => {},
      },
    );
    await throttle.accept(model(), undefined, () => "seed quota");
    const contract = createWorkerRequestContract();
    contract.expect({ provider: "openai", model: "test-model", effort: "off" });
    installRequestThrottle(session, throttle, contract);
    const controller = new AbortController();
    const pending = session.agent.streamFunction(model(), { systemPrompt: "", messages: [], tools: [] }, { signal: controller.signal });
    await Promise.resolve();
    assert.deepEqual(throttle.inspect(), { models: 1, timestamps: 1, waiters: 1 });
    assert.equal(scheduled.length, 1);
    controller.abort();
    if (alsoInvalidate) contract.invalidate();
    await assert.rejects(async () => pending, RequestThrottleAbort);
    assert.equal(scheduled[0]?.cancelled, true, "the current pacing timer is cancelled");
    assert.equal(scheduled.length, 1, "a cancelled wait schedules no capacity recheck");
    assert.equal(delegated, 0, "the cancelled request reaches no provider stream");
    assert.equal(contract.latestAccepted(), undefined);
    assert.equal(contract.refusal(), undefined, "caller cancellation is not a request refusal");
    assert.deepEqual(throttle.inspect(), { models: 1, timestamps: 1, waiters: 0 });
  }
});
