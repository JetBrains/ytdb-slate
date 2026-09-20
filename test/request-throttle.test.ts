import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createRequestThrottle,
  REQUEST_THROTTLE_DEFAULTS,
  RequestThrottleAbort,
  sanitizeRequestThrottle,
  THROTTLE_WINDOW_MS,
  throttleIdentity,
  type SanitizedRequestThrottle,
} from "../extension/request-throttle.ts";
import { createWorkerRequestContract, WORKER_REQUEST_CONTRACT_ERROR } from "../extension/worker.ts";

const OPENAI_A = { api: "openai-responses", provider: "openai", id: "a" };
const OPENAI_B = { api: "openai-responses", provider: "openai", id: "b" };

// Every test that awaits an admission can await an operation that never settles,
// so each one carries this explicit node:test timeout. The value follows the
// waiter tests in test/thread-manager.test.ts. Without it a never-settling timer
// hangs the file instead of failing one test.
const WAITER_TIMEOUT_MS = 1000;

function settings(overrides: Partial<SanitizedRequestThrottle> = {}): SanitizedRequestThrottle {
  return { ...REQUEST_THROTTLE_DEFAULTS, ...overrides };
}

interface Scheduled {
  delay: number;
  run: () => void;
  cancelled: boolean;
}

function harness(overrides: Partial<SanitizedRequestThrottle> = {}, random: () => number = () => 0.5) {
  let at = 0;
  const waits: Scheduled[] = [];
  const expiries: Scheduled[] = [];
  const add = (queue: Scheduled[]) => (delay: number, run: () => void) => {
    const item = { delay, run, cancelled: false };
    queue.push(item);
    return () => { item.cancelled = true; };
  };
  const throttle = createRequestThrottle(settings(overrides), {
    now: () => at,
    random,
    schedule: add(waits),
    scheduleExpiry: add(expiries),
  });
  return {
    throttle,
    waits,
    expiries,
    setNow(value: number) { at = value; },
    run(item: Scheduled) { if (!item.cancelled) item.run(); },
  };
}

/**
 * The delay the limiter asks its scheduler for, on the first wait of a blocked
 * caller. Every expectation below is a literal number, so no test can agree with
 * a production defect by recomputing the delay from the production formula.
 */
async function firstWaitDelay(
  overrides: Partial<SanitizedRequestThrottle>,
  random: () => number,
): Promise<number> {
  const h = harness({ maxRequestsPerMinute: 1, ...overrides }, random);
  await h.throttle.admit(OPENAI_A);
  const controller = new AbortController();
  const blocked = h.throttle.admit(OPENAI_A, controller.signal);
  const delay = h.waits[0]?.delay;
  controller.abort();
  await assert.rejects(blocked, RequestThrottleAbort);
  assert.equal(typeof delay, "number", "a blocked caller must ask the scheduler for one delay");
  return delay as number;
}

test("request throttle configuration accepts documented values and defaults invalid values", { timeout: WAITER_TIMEOUT_MS }, () => {
  const warnings: string[] = [];
  assert.deepEqual(sanitizeRequestThrottle(undefined, warnings.push.bind(warnings)), REQUEST_THROTTLE_DEFAULTS);
  assert.deepEqual(sanitizeRequestThrottle({ enabled: false, maxRequestsPerMinute: 7, baseWaitMs: 2, jitterMs: 0 }, warnings.push.bind(warnings)), {
    enabled: false, maxRequestsPerMinute: 7, baseWaitMs: 2, jitterMs: 0,
  });
  assert.deepEqual(warnings, []);

  const malformed: string[] = [];
  assert.deepEqual(sanitizeRequestThrottle({ enabled: "no", maxRequestsPerMinute: 0, baseWaitMs: 0, jitterMs: -1 }, malformed.push.bind(malformed)), REQUEST_THROTTLE_DEFAULTS);
  assert.equal(malformed.length, 4);
  assert.match(malformed.join("\n"), /enabled[\s\S]*maxRequestsPerMinute[\s\S]*baseWaitMs[\s\S]*jitterMs/);
  assert.match(malformed.join("\n"), /baseWaitMs.*from 1 to 60000/);
});

test("only OpenAI Responses requests receive provider-and-model identities", { timeout: WAITER_TIMEOUT_MS }, () => {
  assert.equal(throttleIdentity(OPENAI_A), "openai/a");
  assert.equal(throttleIdentity(OPENAI_B), "openai/b");
  assert.equal(throttleIdentity({ api: "anthropic-messages", provider: "openai", id: "a" }), undefined);
  assert.equal(throttleIdentity({ api: "openai-responses" }), "openai-responses/unidentified");
  assert.equal(throttleIdentity(null), undefined);
});

test("admission is immediate below the threshold and model counters are independent", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ maxRequestsPerMinute: 2 });
  await h.throttle.admit(OPENAI_A);
  await h.throttle.admit(OPENAI_A);
  await h.throttle.admit(OPENAI_B);
  await h.throttle.admit({ api: "anthropic-messages", provider: "openai", id: "a" });
  assert.deepEqual(h.throttle.inspect(), { models: 2, timestamps: 3, waiters: 0 });

  let admitted = false;
  const blocked = h.throttle.admit(OPENAI_A).then(() => { admitted = true; });
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(h.waits.length, 1);
  assert.equal(h.throttle.inspect().waiters, 1);
  h.setNow(THROTTLE_WINDOW_MS + 1);
  h.run(h.waits[0]!);
  await blocked;
  assert.equal(admitted, true);
  assert.deepEqual(h.throttle.inspect(), { models: 2, timestamps: 2, waiters: 0 });
});

test("a blocked caller waits the configured base wait plus the configured jitter share", { timeout: WAITER_TIMEOUT_MS }, async () => {
  // Zero jitter: the delay is the base wait for every random value.
  assert.equal(await firstWaitDelay({ baseWaitMs: 250, jitterMs: 0 }, () => 0), 250);
  assert.equal(await firstWaitDelay({ baseWaitMs: 250, jitterMs: 0 }, () => 0.999999), 250);
  // The base wait moves the delay on its own.
  assert.equal(await firstWaitDelay({ baseWaitMs: 7, jitterMs: 0 }, () => 0.5), 7);
  // The jitter bound moves the delay on its own, and the base wait is the floor.
  assert.equal(await firstWaitDelay({ baseWaitMs: 1000, jitterMs: 1000 }, () => 0), 1000);
  assert.equal(await firstWaitDelay({ baseWaitMs: 1000, jitterMs: 1000 }, () => 0.5), 1500);
  assert.equal(await firstWaitDelay({ baseWaitMs: 1000, jitterMs: 1000 }, () => 0.999999), 2000);
  assert.equal(await firstWaitDelay({ baseWaitMs: 1000, jitterMs: 4 }, () => 0.5), 1002);
  // A random source outside 0 to 1 is clamped to the documented delay range.
  assert.equal(await firstWaitDelay({ baseWaitMs: 400, jitterMs: 100 }, () => -5), 400);
  assert.equal(await firstWaitDelay({ baseWaitMs: 400, jitterMs: 100 }, () => 5), 500);
});

test("every recheck of one blocked caller takes another configured delay", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ maxRequestsPerMinute: 1, baseWaitMs: 300, jitterMs: 0 }, () => 0.5);
  await h.throttle.admit(OPENAI_A);
  const controller = new AbortController();
  const blocked = h.throttle.admit(OPENAI_A, controller.signal);
  assert.equal(h.waits.length, 1);
  assert.equal(h.waits[0]?.delay, 300);
  // The first delay elapses while the window is still full, so the caller must
  // take a second delay of the same configured size instead of looping freely.
  h.run(h.waits[0]!);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.waits.length, 2);
  assert.equal(h.waits[1]?.delay, 300);
  controller.abort();
  await assert.rejects(blocked, RequestThrottleAbort);
});

test("a rejected synchronous handoff consumes no admission", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ maxRequestsPerMinute: 1 });
  assert.equal(h.throttle.inspect().timestamps, 0);
  await assert.rejects(h.throttle.accept(OPENAI_A, undefined, () => { throw new Error("final validation failed"); }), /final validation failed/);
  assert.equal(h.throttle.inspect().timestamps, 0);
  assert.equal(await h.throttle.accept(OPENAI_A, undefined, () => "accepted"), "accepted");
  assert.equal(h.throttle.inspect().timestamps, 1);
});

test("contract invalidation before immediate capacity or during a wait consumes no admission", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const immediate = harness({ maxRequestsPerMinute: 1 });
  const inactive = createWorkerRequestContract();
  inactive.expect({ provider: "openai", model: "a", effort: "off" });
  inactive.invalidate();
  await assert.rejects(
    immediate.throttle.accept(OPENAI_A, undefined, () => inactive.accept(OPENAI_A, undefined, undefined, () => "sent")),
    new RegExp(WORKER_REQUEST_CONTRACT_ERROR),
  );
  assert.deepEqual(immediate.throttle.inspect(), { models: 0, timestamps: 0, waiters: 0 });

  const waiting = harness({ maxRequestsPerMinute: 1 });
  await waiting.throttle.accept(OPENAI_A, undefined, () => "seed");
  const pending = createWorkerRequestContract();
  pending.expect({ provider: "openai", model: "a", effort: "off" });
  const blocked = waiting.throttle.accept(
    OPENAI_A,
    pending.invalidationSignal,
    () => pending.accept(OPENAI_A, undefined, undefined, () => "must not reach Pi"),
  );
  await Promise.resolve();
  assert.equal(waiting.throttle.inspect().waiters, 1);
  assert.equal(waiting.waits.length, 1);
  pending.invalidate();
  await assert.rejects(blocked, RequestThrottleAbort);
  assert.equal(waiting.waits[0]?.cancelled, true, "invalidation cancels the current timer directly");
  assert.equal(waiting.waits.length, 1, "invalidation schedules no capacity recheck");
  assert.deepEqual(waiting.throttle.inspect(), { models: 1, timestamps: 1, waiters: 0 });
});

test("disabled and out-of-scope throttles still run the atomic handoff without state", { timeout: WAITER_TIMEOUT_MS }, async () => {
  for (const [candidate, enabled] of [
    [OPENAI_A, false],
    [{ api: "anthropic-messages", provider: "anthropic", id: "a" }, true],
  ] as const) {
    const h = harness({ enabled, maxRequestsPerMinute: 1 });
    let handoffs = 0;
    assert.equal(await h.throttle.accept(candidate, undefined, () => ++handoffs), 1);
    assert.equal(handoffs, 1);
    assert.deepEqual(h.throttle.inspect(), { models: 0, timestamps: 0, waiters: 0 });
  }
});

test("cancellation inside the accepted handoff keeps admission and attribution", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ maxRequestsPerMinute: 1 });
  const contract = createWorkerRequestContract();
  contract.expect({ provider: "openai", model: "a", effort: "off" });
  const controller = new AbortController();
  const result = await h.throttle.accept(OPENAI_A, controller.signal, () =>
    contract.accept(OPENAI_A, undefined, controller.signal, () => {
      controller.abort();
      return "accepted";
    }),
  );
  assert.equal(result, "accepted");
  assert.deepEqual(contract.latestAccepted(), { model: { provider: "openai", id: "a" }, effort: "off" });
  assert.equal(h.throttle.inspect().timestamps, 1);
});

test("overlapping calls cannot both consume one free slot", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ maxRequestsPerMinute: 1 });
  const secondController = new AbortController();
  const first = h.throttle.admit(OPENAI_A);
  const second = h.throttle.admit(OPENAI_A, secondController.signal);
  await first;
  await Promise.resolve();
  assert.equal(h.throttle.inspect().timestamps, 1);
  assert.equal(h.throttle.inspect().waiters, 1);
  assert.equal(h.waits.length, 1);
  secondController.abort();
  await assert.rejects(second, RequestThrottleAbort);
  assert.equal(h.throttle.inspect().waiters, 0);
});

test("a fresh arrival delays once while a waiter exists, then waiters compete without self-deadlock", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ maxRequestsPerMinute: 1 });
  await h.throttle.admit(OPENAI_A);
  const earlier = h.throttle.admit(OPENAI_A);
  await Promise.resolve();
  h.setNow(THROTTLE_WINDOW_MS + 1);
  const fresh = h.throttle.admit(OPENAI_A);
  await Promise.resolve();
  assert.equal(h.waits.length, 2, "fresh arrival must delay despite newly free capacity");
  h.run(h.waits[0]!);
  await earlier;
  assert.equal(h.throttle.inspect().timestamps, 1);
  let freshDone = false;
  void fresh.then(() => { freshDone = true; });
  h.run(h.waits[1]!);
  await Promise.resolve();
  assert.equal(freshDone, false, "fresh arrival must recheck after its delay");
  assert.equal(h.waits.length, 3);
  h.setNow(2 * THROTTLE_WINDOW_MS + 2);
  h.run(h.waits[2]!);
  await fresh;
});

test("cancellation before admission and during a wait sends nothing and cleans waiter state", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ maxRequestsPerMinute: 1 });
  const already = new AbortController();
  already.abort();
  await assert.rejects(h.throttle.admit(OPENAI_A, already.signal), /request was not sent/i);
  assert.deepEqual(h.throttle.inspect(), { models: 0, timestamps: 0, waiters: 0 });

  await h.throttle.admit(OPENAI_A);
  const controller = new AbortController();
  const waiting = h.throttle.admit(OPENAI_A, controller.signal);
  await Promise.resolve();
  assert.equal(h.throttle.inspect().waiters, 1);
  controller.abort();
  await assert.rejects(waiting, RequestThrottleAbort);
  assert.equal(h.waits[0]?.cancelled, true);
  assert.deepEqual(h.throttle.inspect(), { models: 1, timestamps: 1, waiters: 0 });
});

test("expiry removes inactive model state without another request", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness();
  await h.throttle.admit(OPENAI_A);
  assert.equal(h.expiries.length, 1);
  h.setNow(THROTTLE_WINDOW_MS + 1);
  h.run(h.expiries[0]!);
  assert.deepEqual(h.throttle.inspect(), { models: 0, timestamps: 0, waiters: 0 });
});

test("one expiry run keeps later admissions and arms the next expiry", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ maxRequestsPerMinute: 5 });
  await h.throttle.admit(OPENAI_A);
  h.setNow(1000);
  await h.throttle.admit(OPENAI_A);
  assert.equal(h.expiries.length, 1, "one live expiry timer follows the oldest admission");
  assert.equal(h.expiries[0]?.delay, THROTTLE_WINDOW_MS + 1);

  // The first expiry run drops only the first admission, so the model must stay
  // in the map and must arm a new timer for the admission that remains.
  h.setNow(THROTTLE_WINDOW_MS + 1);
  h.run(h.expiries[0]!);
  assert.deepEqual(h.throttle.inspect(), { models: 1, timestamps: 1, waiters: 0 });
  assert.equal(h.expiries.length, 2, "a retained admission must arm the next expiry");
  assert.equal(h.expiries[1]?.delay, 1000);

  // The second run empties the window, so the model is forgotten and no further
  // timer is armed.
  h.setNow(THROTTLE_WINDOW_MS + 1001);
  h.run(h.expiries[1]!);
  assert.deepEqual(h.throttle.inspect(), { models: 0, timestamps: 0, waiters: 0 });
  assert.equal(h.expiries.length, 2, "an empty window must not arm another expiry");
});

test("disabled throttling admits immediately and retains no state", { timeout: WAITER_TIMEOUT_MS }, async () => {
  const h = harness({ enabled: false, maxRequestsPerMinute: 1 });
  for (let i = 0; i < 20; i++) await h.throttle.admit(OPENAI_A);
  assert.deepEqual(h.throttle.inspect(), { models: 0, timestamps: 0, waiters: 0 });
  assert.equal(h.waits.length, 0);
});

// The tests above inject a clock and a scheduler. The child process below runs
// the SHIPPED default timers instead, because those defaults carry two claims no
// injected scheduler can show: an expiry timer must not keep a process alive,
// and a real wait must keep running until it is admitted or cancelled. A child
// process proves both by its own exit, so no test waits a real rolling window.
const scratch = mkdtempSync(join(tmpdir(), "slate-throttle-default-timers-"));
const childPath = join(scratch, "default-timer-child.mjs");
const moduleUrl = new URL("../extension/request-throttle.ts", import.meta.url).href;
writeFileSync(
  childPath,
  `import { createRequestThrottle, RequestThrottleAbort } from ${JSON.stringify(moduleUrl)};

const model = { api: "openai-responses", provider: "openai", id: "child" };
const throttle = createRequestThrottle({ enabled: true, maxRequestsPerMinute: 1, baseWaitMs: 5, jitterMs: 0 });
await throttle.admit(model);
console.log("admitted");
const mode = process.argv[2];
if (mode === "expiry") {
  // Nothing else runs. The armed expiry timer must not hold this process open.
} else if (mode === "wait") {
  void throttle.admit(model).catch(() => {});
  console.log("waiting");
} else if (mode === "abort") {
  const controller = new AbortController();
  const pending = throttle.admit(model, controller.signal);
  setTimeout(() => controller.abort(), 20);
  try {
    await pending;
    console.log("admitted-unexpectedly");
    process.exitCode = 3;
  } catch (error) {
    if (error instanceof RequestThrottleAbort) console.log("aborted");
    else {
      console.log("wrong-error");
      process.exitCode = 4;
    }
  }
} else {
  console.log("unknown-mode");
  process.exitCode = 9;
}
`,
);

after(() => rmSync(scratch, { recursive: true, force: true }));

function runChild(mode: string, killAfterMs: number): Promise<{ code: number | null; signal: string | null; out: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [childPath, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    const killer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, out, ms: Date.now() - started });
    });
  });
}

test("the shipped expiry timer does not keep a process alive", { timeout: 20000 }, async () => {
  const result = await runChild("expiry", 5000);
  assert.match(result.out, /admitted/);
  assert.equal(result.signal, null, `the child had to be killed after ${result.ms} ms: ${result.out}`);
  assert.equal(result.code, 0);
  assert.ok(result.ms < 5000, `the child exited only after ${result.ms} ms`);
});

test("the shipped wait timer holds a blocked request until it is cancelled", { timeout: 20000 }, async () => {
  // A blocked caller must stay blocked: its real timer keeps rechecking, so the
  // child cannot exit while one request waits for capacity.
  const waiting = await runChild("wait", 1500);
  assert.match(waiting.out, /waiting/);
  assert.equal(waiting.signal, "SIGKILL", `the child exited on its own with code ${String(waiting.code)}: ${waiting.out}`);

  // The same default timers must release the request on cancellation, and then
  // the child exits by itself.
  const aborted = await runChild("abort", 5000);
  assert.match(aborted.out, /aborted/);
  assert.equal(aborted.signal, null, `the child had to be killed after ${aborted.ms} ms: ${aborted.out}`);
  assert.equal(aborted.code, 0);
  assert.ok(aborted.ms < 5000, `the child exited only after ${aborted.ms} ms`);
});
