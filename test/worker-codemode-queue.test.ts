import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCodemodeExtension, type ExtensionAPI, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { mkdtemp, writeFile, rm, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerCodemodeComponent, createCodemodeQueue, readFullError, CODEMODE_LIMIT_TEXT, type CodemodeQueueClock } from '../extension/worker-codemode.ts';
import { createWorkerNestedLifecycle } from '../extension/worker-nested-lifecycle.ts';
type Execute = ToolDefinition['execute'];
type Result = Awaited<ReturnType<Execute>>;
const ok: Result = { content: [{ type: 'text', text: 'ok' }], details: undefined };
const busy: Result = { isError: true, content: [{ type: 'text', text: CODEMODE_LIMIT_TEXT }], details: { calls: [] } };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  let now = 0;
  const timers = new Map<() => void, number>();
  const clock: CodemodeQueueClock = { now: () => now, schedule(callback, ms) { timers.set(callback, now + ms); return () => { timers.delete(callback); }; }, readFullError: async () => CODEMODE_LIMIT_TEXT };
  const queue = createCodemodeQueue(clock);
  const args = (signal?: AbortSignal): Parameters<Execute> => ['id', { code: '// @options: {"timeout_ms":123}\nreturn 1;' }, signal, undefined, {} as Parameters<Execute>[4]];
  const run = (execute: Execute, signal?: AbortSignal, close?: AbortSignal) => queue.run(execute, args(signal), close);
  async function tick(ms: number) { now += ms; for (const [callback, due] of [...timers]) if (due <= now) { timers.delete(callback); callback(); } await flush(); }
  async function early(ms: number) {
    now += ms;
    const callback = timers.keys().next().value;
    assert.ok(callback, 'a pending timer must fire');
    timers.delete(callback); callback(); await flush();
  }
  return { queue, run, args, clock, tick, early, timers };
}
function text(result: Result) { const last = result.content.at(-1); return last?.type === 'text' ? last.text : ''; }
const waitText = 'The codemode script limit is reached. Call the tools without codemode. Issue independent tool calls together in one turn.';
function assertError(result: Result, expected: string) {
  assert.equal(text(result), expected);
  assert.equal(result.isError, true);
  assert.deepEqual((result.details as { calls: unknown }).calls, []);
}

test('queue capacity is two and FIFO never permits bypass', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); const order: number[] = [];
  const first = f.run(async () => { order.push(1); return hold.promise; });
  const second = f.run(async () => { order.push(2); return hold.promise; });
  const third = f.run(async () => { order.push(3); return ok; });
  await flush(); assert.deepEqual(order, [1, 2]);
  hold.resolve(ok);
  const fourth = f.run(async () => { order.push(4); return ok; });
  await Promise.all([first, second, third, fourth]);
  assert.deepEqual(order, [1, 2, 3, 4]); assert.equal(f.timers.size, 0);
});

test('head and middle abort remove waiters and pre-abort never enters', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); const a = new AbortController(); const b = new AbortController(); const pre = new AbortController(); pre.abort();
  const calls: number[] = [];
  const running = [f.run(async () => hold.promise), f.run(async () => hold.promise)];
  const head = f.run(async () => { calls.push(1); return ok; }, a.signal);
  const kept = f.run(async () => { calls.push(2); return ok; });
  const middle = f.run(async () => { calls.push(3); return ok; }, b.signal);
  const tail = f.run(async () => { calls.push(4); return ok; });
  a.abort(); b.abort();
  assertError(await head, 'Operation aborted'); assertError(await middle, 'Operation aborted');
  assertError(await f.run(async () => { throw Error('pre-abort executed'); }, pre.signal), 'Operation aborted');
  hold.resolve(ok); await Promise.all([...running, kept, tail]);
  assert.deepEqual(calls, [2, 4]); assert.equal(f.timers.size, 0);
  for (const signal of [a.signal, b.signal, pre.signal]) assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('deadline is entry plus 60000 and grant or rejection never resets it', { timeout: 2000 }, async () => {
  for (const grant of [false, true]) {
    const f = fixture(); const hold = gate<Result>();
    const running = [f.run(async () => hold.promise), f.run(async () => hold.promise)];
    let attempts = 0; let done = false;
    const waiting = f.run(async () => { attempts++; return busy; }).then(result => { done = true; return result; });
    await f.tick(59999); assert.equal(done, false); assert.equal(attempts, 0);
    if (grant) { hold.resolve(ok); await flush(); assert.equal(attempts, 1); }
    await f.tick(1); assertError(await waiting, waitText);
    assert.equal(attempts, grant ? 1 : 0);
    hold.resolve(ok); await Promise.all(running); assert.equal(f.timers.size, 0);
  }
});

test('early entry timer cannot admit a third execution without a reservation', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); let attempts = 0;
  const running = [f.run(async () => hold.promise), f.run(async () => hold.promise)];
  await flush();
  const waiting = f.run(async () => { attempts++; return ok; });
  await f.early(59999.5);
  assertError(await waiting, waitText); assert.equal(attempts, 0);
  hold.resolve(ok); await Promise.all(running); assert.equal(f.timers.size, 0);
});

test('early retry deadline timer ends waiting without another attempt', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); let attempts = 0;
  const running = [f.run(async () => hold.promise), f.run(async () => hold.promise)];
  const waiting = f.run(async () => { attempts++; return busy; });
  await f.tick(59999); hold.resolve(ok); await Promise.all(running); await flush();
  assert.equal(attempts, 1);
  await f.early(0.5);
  assertError(await waiting, waitText); assert.equal(attempts, 1); assert.equal(f.timers.size, 0);
});

test('retry uses 250ms and keeps its place while waiting', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); let attempts = 0; let newer = false;
  const retry = f.run(async () => ++attempts === 1 ? busy : ok);
  const running = f.run(async () => hold.promise);
  const waiting = f.run(async () => { newer = true; return ok; });
  await flush(); assert.equal(attempts, 1); assert.equal(newer, false);
  await f.tick(249); assert.equal(attempts, 1); assert.equal(newer, false);
  await f.tick(1); await retry; await waiting; assert.equal(attempts, 2); assert.equal(newer, true);
  hold.resolve(ok); await running; assert.equal(f.timers.size, 0);
});

test('close wakes a queued waiter while both places remain held', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); const lifecycle = createWorkerNestedLifecycle(() => {});
  const running = [f.run(async () => hold.promise), f.run(async () => hold.promise)];
  await flush();
  let settled = false;
  const waiting = f.run(async () => { throw Error('closed waiter executed'); }, undefined, lifecycle.closeSignal).then(result => { settled = true; return result; });
  lifecycle.close(); assert.equal(lifecycle.closeSignal.aborted, true);
  await flush(); assert.equal(settled, true);
  assertError(await waiting, 'Operation aborted');
  hold.resolve(ok); await Promise.all(running); assert.equal(f.timers.size, 0);
});

test('close during retry wakes before the retry tick and releases its place', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); const lifecycle = createWorkerNestedLifecycle(() => {});
  let attempts = 0; let settled = false; let newer = false;
  const running = f.run(async () => hold.promise);
  const retry = f.run(async () => { attempts++; return busy; }, undefined, lifecycle.closeSignal).then(result => { settled = true; return result; });
  const waiting = f.run(async () => { newer = true; return ok; });
  await flush(); assert.equal(attempts, 1); assert.equal(newer, false);
  lifecycle.close(); await flush(); assert.equal(settled, true);
  assertError(await retry, 'Operation aborted'); await waiting;
  assert.equal(newer, true); assert.equal(attempts, 1);
  hold.resolve(ok); await running; assert.equal(f.timers.size, 0);
});

test('stop wins when the deadline timer and close fire together', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); const lifecycle = createWorkerNestedLifecycle(() => {});
  const running = [f.run(async () => hold.promise), f.run(async () => hold.promise)];
  const waiting = f.run(async () => ok, undefined, lifecycle.closeSignal);
  const expired = f.tick(60000); lifecycle.close(); await expired;
  assertError(await waiting, 'Operation aborted'); hold.resolve(ok); await Promise.all(running);
});

test('abort during retry and spill classification never starts another attempt', { timeout: 2000 }, async () => {
  for (const classification of [false, true]) {
    const f = fixture(); const controller = new AbortController(); const read = gate<string>(); let attempts = 0;
    f.clock.readFullError = () => read.promise;
    const pending = f.run(async () => { attempts++; return classification ? { ...busy, content: [{ type: 'text', text: 'Warning: truncated output' }], details: { calls: [], fullOutputPath: '/spill' } } : busy; }, controller.signal);
    await flush(); controller.abort(); read.resolve(CODEMODE_LIMIT_TEXT);
    assertError(await pending, 'Operation aborted'); await f.tick(250);
    assert.equal(attempts, 1); assert.equal(f.timers.size, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(await f.run(async () => ok), ok);
  }
});

test('exact error predicate and failed reads return the original result', { timeout: 2000 }, async () => {
  const variants: Result[] = [ok, { ...busy, isError: false }, { ...busy, details: { calls: ['call'] } }, { ...busy, details: { calls: {} } }, { ...busy, details: undefined }, { ...busy, content: [] }, { ...busy, content: [{ type: 'image', data: '', mimeType: 'image/png' }] }, { ...busy, content: [{ type: 'text', text: CODEMODE_LIMIT_TEXT + '\nordinary error' }] }, { ...busy, content: [{ type: 'text', text: 'Warning: truncated output' }], details: { calls: [] } }];
  for (const result of variants) { const f = fixture(); assert.equal(await f.run(async () => result), result); assert.equal(f.timers.size, 0); }
  for (const read of [async () => undefined, async () => 'wrong text', async (): Promise<string> => { throw Error('read failed'); }]) {
    const f = fixture(); f.clock.readFullError = read;
    const result: Result = { ...busy, content: [{ type: 'text', text: 'Warning: truncated output' }], details: { calls: [], fullOutputPath: '/spill' } };
    assert.equal(await f.run(async () => result), result); assert.equal(f.timers.size, 0);
  }
});

test('delegation throws release places and a started script outlives the wait allowance', { timeout: 2000 }, async () => {
  const f = fixture(); const hold = gate<Result>(); const controller = new AbortController(); let completed = false;
  const args = f.args(controller.signal); args[3] = () => {};
  const running = f.queue.run(async (...actual) => { for (let i = 0; i < 5; i++) assert.equal(actual[i], args[i]); return hold.promise; }, args).then(result => { completed = true; return result; });
  await flush(); await f.tick(60001); controller.abort(); await flush(); assert.equal(completed, false);
  hold.resolve(ok); assert.equal(await running, ok);
  await assert.rejects(f.run(async () => { throw Error('execute failed'); }), /execute failed/);
  const afterThrow = gate<Result>(); const entered: number[] = [];
  const restored = [1, 2].map(id => f.run(async () => { entered.push(id); return afterThrow.promise; }));
  const third = f.run(async () => { entered.push(3); return ok; });
  await flush(); assert.deepEqual(entered, [1, 2], 'both places must be restored after a throw');
  afterThrow.resolve(ok); await Promise.all([...restored, third]); assert.deepEqual(entered, [1, 2, 3]);
  assert.equal(f.timers.size, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

function capture(factory: ExtensionFactory): Execute {
  let execute!: Execute;
  factory({ registerTool(tool: ToolDefinition) { execute = tool.execute; }, on() {},
    getSettings: () => ({}), getAllTools: () => [], appendEntry() {},
  } as unknown as ExtensionAPI);
  return execute;
}
function realContext(entered: () => void, release: Promise<void>): Parameters<Execute>[4] {
  return { tools: [{ name: 'held', description: 'held', parameters: { type: 'object', properties: {} } }],
    sessionManager: { getBranch: () => [] },
    async executeTool() { entered(); await release; return { toolCall: { id: 'nested' }, isError: false, result: ok }; },
  } as unknown as Parameters<Execute>[4];
}

test('component instances share the production two-place queue', { timeout: 15000 }, async () => {
  const first = capture(createWorkerCodemodeComponent(() => {}));
  const second = capture(createWorkerCodemodeComponent(() => {}));
  const hold = gate<void>(); const entered = gate<void>(); let count = 0;
  const ctx = realContext(() => { if (++count === 2) entered.resolve(); }, hold.promise);
  const args = (id: string, signal?: AbortSignal): Parameters<Execute> => [id, { code: 'await tools.held({});' }, signal, undefined, ctx];
  const running = [first(...args('a')), second(...args('b'))];
  try {
    await entered.promise;
    const stop = new AbortController(); const updates: unknown[] = [];
    const waitingArgs = args('c', stop.signal); waitingArgs[3] = result => updates.push(result);
    const waiting = second(...waitingArgs);
    await flush(); assert.deepEqual(updates, [], 'third wrapper cannot enter pi');
    stop.abort(); assertError(await waiting, 'Operation aborted');
    assert.equal(count, 2);
  } finally { hold.resolve(); await Promise.all(running); }
});

test('real pi rejection bytes, truncation, external occupancy and forged output', { timeout: 20000 }, async () => {
  const official = capture(createCodemodeExtension({ mode: 'on', models: false }));
  const hold = gate<void>(); const entered = gate<void>(); let count = 0;
  const ctx = realContext(() => { if (++count === 2) entered.resolve(); }, hold.promise);
  const args = (code: string): Parameters<Execute> => ['real', { code }, undefined, undefined, ctx];
  const externalQueue = createCodemodeQueue();
  const running = [externalQueue.run(official, args('await tools.held({});')), externalQueue.run(official, args('await tools.held({});'))];
  let queued: Promise<Result> | undefined;
  try {
    await entered.promise;
    const expected = 'Script error:\nScript sandbox failed: Codemode worker limit reached (2 workers are still running or shutting down). Retry after they exit.\n\nNo tool calls were made.';
    assert.equal(CODEMODE_LIMIT_TEXT, expected);
    for (const budget of [undefined, 0, 1, 32]) {
      const result = await official(...args((budget === undefined ? '' : '// @options: {"max_output_tokens":' + budget + '}\n') + 'return 1;'));
      assert.equal(result.isError, true); assert.deepEqual((result.details as { calls: unknown }).calls, []);
      if (budget === undefined) assert.equal(text(result), expected);
      else {
        assert.match(text(result)!, /^Warning: truncated output/);
        const path = (result.details as { fullOutputPath: string }).fullOutputPath;
        assert.equal(await readFile(path, 'utf8'), expected);
      }
    }
    let finished = false;
    const retried = gate<void>(); let attempts = 0;
    const retryQueue = createCodemodeQueue();
    queued = retryQueue.run(async (...actual) => {
      if (++attempts === 2) retried.resolve();
      return official(...actual);
    }, args('// @options: {"max_output_tokens":0}\nreturn "after external release";')).then(result => { finished = true; return result; });
    await Promise.race([retried.promise, queued.then(() => { throw Error('the production reader did not retry a real spill'); })]);
    assert.equal(finished, false, 'the production reader recognizes a real spill and retries while pi is occupied');
  } finally { hold.resolve(); await Promise.all(running); }
  const completed = (await queued)!;
  assert.notEqual(completed.isError, true);
  assert.match(JSON.stringify(completed), /truncated output/);
  assert.match(await readFile((completed.details as { fullOutputPath: string }).fullOutputPath, 'utf8'), /after external release/);
  // A real script prints the rejection prefix and then fails with no nested calls.
  const queue = createCodemodeQueue();
  const forged = await official(...args('text("Script error:\\nScript sandbox failed: Codemode worker limit reached"); throw new Error("ordinary failure");'));
  assert.equal(forged.isError, true); assert.deepEqual((forged.details as { calls: unknown }).calls, []);
  assert.equal(await queue.run(async () => forged, args('unused')), forged);
  const timeout = await queue.run(official, args('// @options: {"timeout_ms":10}\nwhile (true) {}'));
  assert.equal(timeout.isError, true); assert.match(text(timeout)!, /timed out|timeout|deadline/i);
});

test('production bounded reader reads all 512 bytes and refuses 513 bytes before reading', { timeout: 3000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cqb-'));
  try {
    const path = join(root, 'spill');
    const content = '0123456789abcdef'.repeat(32);
    await writeFile(path, content);
    const handle = await open(path, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    // The spy calls the real read. It distinguishes size refusal from a short read.
    const read = t.mock.method(prototype, 'read');
    assert.equal(await readFullError(path), content);
    assert.equal(read.mock.callCount(), 1);
    read.mock.resetCalls();
    await writeFile(path, content + 'x');
    assert.equal(await readFullError(path), undefined);
    assert.equal(read.mock.callCount(), 0, 'oversize files must be refused before any read');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production bounded reader stops on the endless Linux zero device', { timeout: 5000, skip: process.platform !== 'linux' }, async () => {
  // Linux CI supplies /dev/zero. Its reported size is zero, but reads never reach EOF.
  // A child deadline contains an unbounded read without blocking the test runner.
  const source = `import assert from 'node:assert/strict';
    import { readFullError } from ${JSON.stringify(new URL('../extension/worker-codemode.ts', import.meta.url).href)};
    assert.equal(await readFullError('/dev/zero'), undefined);
    console.log('bounded read complete');`;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--max-old-space-size=128', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '--eval', source],
    { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 });
  assert.equal(stdout, 'bounded read complete\n');
});

test('production bounded reader returns original results on oversize and read failures', { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cqr-'));
  try {
    // Each trailing byte makes the whole file differ from the exact rejection.
    for (const size of [Buffer.byteLength(CODEMODE_LIMIT_TEXT) + 1, 512, 513]) {
      await writeFile(join(root, String(size)), CODEMODE_LIMIT_TEXT + 'x'.repeat(size - Buffer.byteLength(CODEMODE_LIMIT_TEXT)));
    }
    for (const path of [root, join(root, 'missing'), ...[Buffer.byteLength(CODEMODE_LIMIT_TEXT) + 1, 512, 513].map(size => join(root, String(size)))]) {
      const result: Result = { ...busy, content: [{ type: 'text', text: 'Warning: truncated output' }], details: { calls: [], fullOutputPath: path } };
      const f = fixture(); assert.equal(await createCodemodeQueue().run(async () => result, f.args()), result);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
