import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWorkerCodemodeComponent } from "../extension/worker-codemode.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`event did not arrive within ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;
function component() {
  let tool!: ToolDefinition;
  createWorkerCodemodeComponent(message => assert.fail(message))({
    registerTool(value: ToolDefinition) { tool = value; }, on() {}, getAllTools: () => [],
  } as unknown as ExtensionAPI);
  assert.equal(tool.name, "codemode");
  return tool;
}
async function fixture(capacity: number, body: (f: ReturnType<typeof setup>) => Promise<void>) {
  const previous = process.env.PI_CODEMODE_MAX_WORKERS;
  process.env.PI_CODEMODE_MAX_WORKERS = String(capacity);
  let f: ReturnType<typeof setup> | undefined;
  try {
    f = setup();
    // A result can precede worker exit. Prove all configured slots are usable,
    // with real workers held together, before each serial scenario.
    const probes = Array.from({ length: capacity }, (_, i) => f!.run(`idle-${i}`, i % 2));
    await bounded(Promise.all(probes.map(p => p.entered.promise)));
    probes.forEach(p => p.release.resolve());
    await bounded(Promise.all(probes.map(p => p.result)));
    await body(f);
  } finally {
    try { await f?.cleanup(); }
    finally {
      if (previous === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
      else process.env.PI_CODEMODE_MAX_WORKERS = previous;
      assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, previous);
    }
  }
}
function setup() {
  const tools = [component(), component()];
  const entries: string[] = [];
  const calls: { controller: AbortController; release: ReturnType<typeof gate>; result: Promise<Result> }[] = [];
  function run(id: string, index = 0, timeout?: number, code = 'await tools.held({});', preAborted = false) {
    const entered = gate(), release = gate(), progress = gate();
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const ctx = { tools: [{ name: "held", description: "held",
      parameters: { type: "object", properties: {} } }],
      sessionManager: { getBranch: () => [] },
      async executeTool() {
        entries.push(id); entered.resolve(); await release.promise;
        return { toolCall: { id: `${id}/held` }, isError: false,
          result: { content: [{ type: "text", text: id }], details: undefined } };
      },
    } as unknown as ExtensionToolContext;
    // pi 1.4.0 dist/extensions/codemode/execute.js:445-485 publishes the
    // first onUpdate before synchronously registering admission. Awaiting this
    // promise resumes after waiter registration. Never abort inside onUpdate.
    const source = timeout === undefined ? code : `// @options: {"timeout_ms":${timeout}}\n${code}`;
    const result = tools[index]!.execute(id, { code: source }, controller.signal, () => progress.resolve(), ctx);
    calls.push({ controller, release, result });
    return { entered, release, progress, controller, result };
  }
  return { run, entries, async cleanup() {
    calls.forEach(c => { c.release.resolve(); c.controller.abort(); });
    await bounded(Promise.allSettled(calls.map(c => c.result)));
  } };
}
function noStart(result: Result) {
  assert.equal(result.isError, true);
  assert.deepEqual((result.details as { calls: unknown[] }).calls, []);
  const last = result.content.at(-1);
  assert.ok(last?.type === "text" && last.text.endsWith("The script did not start."));
}
function ok(result: Result) { assert.notEqual(result.isError, true, JSON.stringify(result)); }

test("host admits three scripts across components", { timeout: 15000 }, async () => {
  await fixture(3, async f => {
    const scripts = [f.run("a"), f.run("b", 1), f.run("c")];
    await bounded(Promise.all(scripts.map(s => s.entered.promise)));
    scripts.forEach(s => s.release.resolve());
    (await bounded(Promise.all(scripts.map(s => s.result)))).forEach(ok);
  });
});
test("host shares arrival ordering across components", { timeout: 15000 }, async () => {
  await fixture(1, async f => {
    const a = f.run("a"); await bounded(a.progress.promise); await bounded(a.entered.promise);
    const b = f.run("b", 1); await bounded(b.progress.promise);
    const c = f.run("c"); await bounded(c.progress.promise);
    await sleep(100); assert.deepEqual(f.entries.slice(1), ["a"]);
    a.release.resolve(); ok(await bounded(a.result)); await bounded(b.entered.promise);
    await sleep(100); assert.deepEqual(f.entries.slice(1), ["a", "b"]);
    b.release.resolve(); ok(await bounded(b.result)); await bounded(c.entered.promise);
    c.release.resolve(); ok(await bounded(c.result));
    assert.deepEqual(f.entries.slice(1), ["a", "b", "c"]);
  });
});
test("host deadline expires while waiting", { timeout: 15000 }, async () => {
  await fixture(1, async f => {
    const holder = f.run("holder"); await bounded(holder.entered.promise);
    const waiter = f.run("waiter", 1, 500); await bounded(waiter.progress.promise);
    noStart(await bounded(waiter.result));
    assert.deepEqual(f.entries.slice(1), ["holder"]);
  });
});
test("host admission wait consumes runtime allowance", { timeout: 20000 }, async t => {
  await fixture(1, async f => {
    const holder = f.run("holder"); await bounded(holder.entered.promise);
    const start = performance.now();
    const waiter = f.run("timed", 1, 10000); await bounded(waiter.progress.promise);
    await sleep(6000);
    const released = performance.now(); holder.release.resolve();
    ok(await bounded(holder.result)); await bounded(waiter.entered.promise);
    const result = await bounded(waiter.result, 7000);
    const waited = released - start, afterRelease = performance.now() - released;
    t.diagnostic(`waited=${waited.toFixed(1)}ms afterRelease=${afterRelease.toFixed(1)}ms`);
    assert.ok(waited >= 5900 && waited < 7500, "timing precondition");
    assert.ok(afterRelease < 6500, "runtime must not restart a fresh ten-second allowance");
    assert.equal(result.isError, true);
    assert.equal((result.details as { calls: unknown[] }).calls.length, 1);
  });
});
test("host bounds capacity waiting at sixty seconds", { timeout: 90000 }, async t => {
  await fixture(1, async f => {
    const holder = f.run("holder"); await bounded(holder.entered.promise);
    const start = performance.now(), waiter = f.run("waiter", 1);
    await bounded(waiter.progress.promise);
    noStart(await bounded(waiter.result, 70000));
    const elapsed = performance.now() - start;
    t.diagnostic(`capacity wait=${elapsed.toFixed(1)}ms`);
    assert.ok(elapsed >= 59000 && elapsed < 70000);
    assert.deepEqual(f.entries.slice(1), ["holder"]);
  });
});
test("host removes pre-aborted and queued aborted waiters", { timeout: 15000 }, async () => {
  await fixture(1, async f => {
    noStart(await bounded(f.run("pre", 1, undefined, undefined, true).result));
    const holder = f.run("holder"); await bounded(holder.progress.promise); await bounded(holder.entered.promise);
    const cancelled = f.run("cancelled", 1); await bounded(cancelled.progress.promise);
    cancelled.controller.abort(); noStart(await bounded(cancelled.result));
    const live = f.run("live"); await bounded(live.progress.promise);
    await sleep(100); assert.deepEqual(f.entries.slice(1), ["holder"]);
    holder.release.resolve(); ok(await bounded(holder.result)); await bounded(live.entered.promise);
    live.release.resolve(); ok(await bounded(live.result));
    assert.deepEqual(f.entries.slice(1), ["holder", "live"]);
  });
});
test("host retains started calls on cancellation and later admits work", { timeout: 15000 }, async () => {
  await fixture(1, async f => {
    const started = f.run("started"); await bounded(started.progress.promise); await bounded(started.entered.promise);
    started.controller.abort();
    const result = await bounded(started.result);
    assert.equal(result.isError, true);
    assert.equal((result.details as { calls: unknown[] }).calls.length, 1);
    started.release.resolve();
    const later = f.run("later", 1); await bounded(later.entered.promise);
    later.release.resolve(); ok(await bounded(later.result));
  });
});
test("host preserves one completed effect before script failure", { timeout: 15000 }, async () => {
  await fixture(1, async f => {
    const script = f.run("effect", 1, undefined, 'await tools.held({}); throw Error("after effect");');
    await bounded(script.entered.promise); script.release.resolve();
    const result = await bounded(script.result);
    assert.equal(result.isError, true);
    const records = (result.details as { calls: { status: string }[] }).calls;
    assert.equal(records.length, 1); assert.equal(records[0]!.status, "ok");
    assert.deepEqual(f.entries.slice(1), ["effect"]);
    assert.doesNotMatch(JSON.stringify(result.content), /The script did not start/);
  });
});
