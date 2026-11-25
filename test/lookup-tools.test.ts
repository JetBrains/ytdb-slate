import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { AgentTool, runToolCall as RunToolCall } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { sanitizeEpisodeRecord, sanitizeThreadRecord, SlateStore, type EpisodeRecord, type ThreadRecord } from "../extension/state.ts";
import type { ThreadManager } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const coreManifestUrl = pathToFileURL(requireFromPi.resolve("@earendil-works/pi-agent-core/package.json"));
const coreExports = JSON.parse(readFileSync(coreManifestUrl, "utf8")).exports;
const { runToolCall } = await import(new URL(coreExports["."].import, coreManifestUrl).href) as { runToolCall: typeof RunToolCall };

function fixture(failover?: (id: string) => string | undefined, cwd = "") {
  const registered = new Map<string, ToolDefinition>();
  const pi = { registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool) } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  let liveReads = 0;
  const manager = {
    liveFailoverModel: (id: string) => {
      liveReads++;
      return failover?.(id);
    },
  } as unknown as ThreadManager;
  registerSlateTools(pi, store, () => manager);

  const ctx = { cwd, sessionManager: { getSessionId: () => "current" } } as ExtensionToolContext;
  const threadExecutions: unknown[] = [];
  const tools: AgentTool[] = [...registered.values()].map((definition) => ({
    ...definition,
    execute: (id, args, signal, update) => {
      if (definition.name === "threads") threadExecutions.push(args);
      return definition.execute(id, args, signal, update, ctx);
    },
  }));
  const invoke = async (name: "threads" | "episode", args: unknown) => {
    const { isError, result } = await runToolCall(
      { type: "toolCall", id: "lookup", name, arguments: args as never },
      { tools, context: { messages: [], tools }, assistantMessage: {} as never },
    );
    assert.equal(result.content.length, 1);
    const block = result.content[0]!;
    assert.equal(block.type, "text");
    return { isError, text: block.text, details: result.details };
  };
  const fetch = (id: string) => invoke("episode", { id });
  const page = async (args: { before?: string; detail?: boolean; parentSession?: boolean } = {}) => {
    const { isError, text, details } = await invoke("threads", args);
    assert.equal(isError, false, text);
    const [summary, mode, ...lines] = text.split("\n");
    const continuation = /^Remaining threads: (\d+)\. Next call: threads\((.+)\)$/.exec(lines.at(-1) ?? "");
    if (continuation) lines.pop();
    const remaining = continuation ? Number(continuation[1]) : 0;
    const next: typeof args | undefined = continuation ? JSON.parse(continuation[2]!) : undefined;
    return { summary, mode, lines, remaining, next, details, text };
  };

  function add(ordinal: number | string, overrides: Partial<ThreadRecord> = {}) {
    const id = `t${ordinal}`;
    const record: ThreadRecord = {
      id, sessionId: "current", name: "survey", status: "successful", type: "researcher",
      episodeId: `${id}.e1`, createdAt: 1, updatedAt: 1, ...overrides,
    };
    store.threads.set(id, record);
    return record;
  }

  const executeThreads = (args: object) => registered.get("threads")!.execute("lookup", args, undefined, undefined, ctx);
  return { invoke, executeThreads, fetch, page, add, store, threadExecutions, liveReads: () => liveReads };
}

test("lookup pages use exclusive decimal boundaries, even when a cursor row is absent", { timeout: 5000 }, async () => {
  const { add, page, store } = fixture();
  const empty = await page();
  assert.equal(empty.text, "No threads yet. Use the thread tool to create one.");
  assert.deepEqual(empty.details, { count: 0, failedCount: 0 });

  add(9, { status: "queued" });
  add(10, { status: "failed" });
  add(1, { status: "cancelled", episodeId: undefined });
  add(12, { status: "running" });
  add("9007199254740991");
  add("9007199254740992");

  const top = await page();
  assert.equal(top.summary, "Threads: 6. Queued: 1. Running: 1. Successful: 2. Failed: 1. Cancelled: 1. Current session: 6.");
  assert.equal(top.mode, "Listing: current session, 6 threads.");
  assert.deepEqual(top.lines.map((line) => line.split(" ")[0]), [
    "t9007199254740992", "t9007199254740991", "t12", "t10", "t9", "t1",
  ]);
  assert.equal(top.lines.at(-1), 't1 "survey" [cancelled] type=researcher — episode: (none)');
  assert.equal(top.next, undefined);

  const highCursor = await page({ before: "t9007199254740992" });
  assert.equal(highCursor.lines[0], 't9007199254740991 "survey" [successful] type=researcher — episode: t9007199254740991.e1');
  assert.equal(highCursor.lines.length, 5);
  assert.equal(highCursor.mode, "Listing: all sessions, threads older than t9007199254740992.");
  store.threads.delete("t9007199254740992");
  assert.deepEqual((await page({ before: "t9007199254740992" })).lines, highCursor.lines);

  const older = await page({ before: "t11" });
  assert.deepEqual(older.lines, top.lines.slice(3));
  assert.deepEqual(older.details, { count: 5, failedCount: 1 });
  const end = await page({ before: "t1" });
  assert.equal(end.text, "Threads: 5. Queued: 1. Running: 1. Successful: 1. Failed: 1. Cancelled: 1. Current session: 5.\nListing: all sessions, threads older than t1, 0 threads.\nNo older threads.");
  assert.deepEqual(end.details, older.details);
  assert.equal(end.next, undefined);
});

test("invalid thread cursors produce a fixed error before argument conversion and at execution", { timeout: 5000 }, async () => {
  const { invoke, executeThreads } = fixture();
  const message = 'Invalid before value. Use a thread ID such as "t9". Omit both before and parentSession to list the current session.';
  for (const before of ["", "t0", "t01", "t-1", "t1\n", "t1.2", "t9007199254740993", "x".repeat(50_000), 9, null]) {
    const result = await invoke("threads", { before });
    assert.equal(result.isError, true);
    assert.equal(result.text, message);
    await assert.rejects(executeThreads({ before }), { message });
  }
});

test("Pi returns fixed errors for malformed threads arguments and ignores large extra properties", { timeout: 5000 }, async () => {
  const { invoke, page, add } = fixture();
  const large = "界".repeat(6000);
  for (const args of [large, [large], 1, false, null, undefined]) {
    const result = await invoke("threads", args);
    assert.equal(result.isError, true);
    assert.equal(result.text, "Invalid threads arguments. Use an object such as {}.");
  }
  for (const key of ["detail", "parentSession"]) {
    for (const value of [large, { payload: large }, [], null, 1, undefined]) {
      const result = await invoke("threads", { [key]: value });
      assert.equal(result.isError, true);
      assert.equal(result.text, `Invalid ${key} value. Use true or false.`);
    }
  }
  add(1);
  const result = await invoke("threads", { extra: large, detail: true });
  const expected = await page({ detail: true });
  assert.deepEqual(result, { isError: false, text: expected.text, details: expected.details });
});

test("Pi rejects accessors and faulty argument inspection before threads execute", { timeout: 5000 }, async () => {
  const { invoke, executeThreads, threadExecutions } = fixture();
  const large = "界".repeat(6000);
  const invalid = "Invalid threads arguments. Use an object such as {}.";
  const error = new Error(large);
  let getterReads = 0;
  const changing = { get detail() { return ++getterReads === 1 ? false : large; } };
  const throwing = { get detail(): boolean { getterReads++; throw error; } };
  const beforeAccessor = { get before() { getterReads++; return "t1"; } };
  const parentAccessor = { get parentSession() { getterReads++; return true; } };
  const throwingProxy = new Proxy({}, { getOwnPropertyDescriptor() { throw error; } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const args of [changing, throwing, beforeAccessor, parentAccessor, throwingProxy, revoked.proxy]) {
    const result = await invoke("threads", args);
    assert.equal(result.isError, true);
    assert.equal(result.text, invalid);
    await assert.rejects(executeThreads(args), { message: invalid });
  }
  assert.equal(getterReads, 0);

  for (const [key, message] of [
    ["before", 'Invalid before value. Use a thread ID such as "t9". Omit both before and parentSession to list the current session.'],
    ["detail", "Invalid detail value. Use true or false."],
    ["parentSession", "Invalid parentSession value. Use true or false."],
  ] as const) {
    let inspections = 0;
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor(_target, property) {
        if (property === key) {
          inspections++;
          return { configurable: true, enumerable: true, value: large };
        }
        return undefined;
      },
    });
    const result = await invoke("threads", proxy);
    assert.equal(result.isError, true);
    assert.equal(result.text, message);
    assert.equal(inspections, 1);
  }
  assert.deepEqual(threadExecutions, []);
});

test("Pi executes threads with only checked data properties", { timeout: 5000 }, async () => {
  const { invoke, add, threadExecutions } = fixture();
  const large = "界".repeat(6000);
  add(1);
  add(2);
  const checked = { before: "t2", detail: false, parentSession: false };
  const expected = await invoke("threads", checked);
  assert.equal(expected.isError, false);
  assert.match(expected.text, /\nt1 "survey"/);
  assert.doesNotMatch(expected.text, /\nt2 | — updated /);

  const inspected: PropertyKey[] = [];
  const proxy = new Proxy({ ...checked, extra: large }, {
    get() { return large; },
    ownKeys() { throw new Error(large); },
    getOwnPropertyDescriptor(target, key) {
      inspected.push(key);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.deepEqual(await invoke("threads", proxy), expected);
  assert.deepEqual(inspected, ["before", "detail", "parentSession"]);
  const omitted = await invoke("threads", {});
  assert.equal(omitted.isError, false);
  assert.match(omitted.text, /\nt2 "survey"/);
  assert.deepEqual(threadExecutions, [checked, checked, {}]);
});

for (const detail of [undefined, true] as const) {
  test(`traverse 250 threads by the emitted calls with detail=${detail}`, { timeout: 5000 }, async () => {
    const { add, page, store, liveReads } = fixture((id) => "p/" + id + "j".repeat(5000));
    const status = ["queued", "running", "successful", "failed", "cancelled"] as const;
    const hostileName = 'a"\\\u0000\u202e\u2028\u2029' + "😀".repeat(3000);
    for (let step = 0; step < 250; step++) {
      const n = (step * 97) % 250 + 1;
      const raw = add(n, { name: hostileName, status: status[n % status.length], updatedAt: 1e20 });
      const thread = sanitizeThreadRecord(raw, []);
      assert.ok(thread);
      assert.equal(thread.updatedAt, 1e20);
      // Keep live statuses while using the accepted snapshot fields.
      store.threads.set(raw.id, { ...thread, status: raw.status });
      const episode = sanitizeEpisodeRecord({
        id: raw.episodeId, threadId: raw.id, task: "lookup", status: "ok",
        file: `episodes/${raw.episodeId}.md`, createdAt: 1, logicalModel: "choice",
        requestedModel: "p/" + "😀".repeat(4500), requestedEffort: "high",
        reason: '"\\'.repeat(100), model: "p/" + "é".repeat(5000),
        effort: "😀".repeat(2000), effortUnmeasured: true,
      }, []);
      assert.ok(episode);
      assert.ok(Buffer.byteLength(episode.requestedModel ?? "", "utf8") > 4096);
      store.episodes.set(episode.id, episode);
    }

    const seen: number[] = [];
    let args: { before: string; detail?: boolean } = detail ? { before: "t251", detail } : { before: "t251" };
    for (let index = 0; index < 250; index++) {
      const readsBefore = liveReads();
      const current = await page(args);
      const added = index === 0 ? 0 : 1;
      assert.equal(current.summary, `Threads: ${250 + added}. Queued: 50. Running: ${50 + added}. Successful: 50. Failed: 50. Cancelled: 50. Current session: ${250 + added}.`);
      assert.deepEqual(current.details, { count: 250 + added, failedCount: 50 });
      assert.equal(current.lines.length, Math.min(20, 250 - seen.length));
      assert.doesNotMatch(current.text, /[\p{Cs}\u0000\u2028\u2029\u202e�]/u);
      assert.equal(liveReads() - readsBefore, detail ? current.lines.length : 0);
      assert.ok(Buffer.byteLength(current.text, "utf8") > 4096 || index > 0);

      for (const line of current.lines) {
        const row = /^(t(\d+)) (".*?") \[(\w+)\] type=researcher .*?episode: (t\d+\.e1)(?: — updated (.+))?$/.exec(line);
        assert.ok(row, line);
        const [, id, ordinal, name, state, episodeId, updated] = row;
        const n = Number(ordinal);
        assert.equal(n, 250 - seen.length);
        assert.equal(state, status[n % status.length]);
        assert.equal(episodeId, `${id}.e1`);
        assert.match(JSON.parse(name!), /^a"\\  😀+…$/u);
        if (detail) {
          assert.equal(updated, "unavailable");
          assert.match(line, /logical=choice requested=p\/😀+…@high reason="/u);
          assert.match(line, /last=p\/é+…@😀+…\(unmeasured\) \(different from requested\)/u);
          assert.match(line, new RegExp(`live=p/${id}j+… \\(failover\\)`, "u"));
          const reason = / reason=("(?:[^"\\]|\\.)*") last=/.exec(line);
          assert.ok(reason);
          assert.equal(JSON.parse(reason[1]!), '"\\'.repeat(100));
        } else {
          assert.equal(updated, undefined);
          assert.doesNotMatch(line, /logical=|requested=|reason=|last=|live=/);
        }
        seen.push(n);
      }

      assert.equal(current.remaining, 250 - seen.length);
      if (current.remaining === 0) {
        assert.equal(current.next, undefined);
        break;
      }
      assert.deepEqual(current.next, detail ? { before: `t${seen.at(-1)}`, detail } : { before: `t${seen.at(-1)}` });
      args = current.next!;
      if (index === 0) add(251, { status: "running" });
    }
    assert.equal(seen.length, 250);
    if (!detail) assert.equal(liveReads(), 0);
  });
}

test("a page preserves a false detail flag and caps mostly invisible labels", { timeout: 5000 }, async () => {
  const { add, page } = fixture();
  for (let index = 1; index <= 21; index++) add(index);
  add(21, { name: "\u0000".repeat(5000) + "tail" });
  add(20, { name: "x\ud800y" });
  const first = await page({ before: "t22", detail: false });
  assert.equal(first.lines[0], 't21 "…" [successful] type=researcher — episode: t21.e1');
  assert.equal(first.lines[1], 't20 "x�y" [successful] type=researcher — episode: t20.e1');
  assert.equal(first.lines.length, 20);
  assert.equal(first.remaining, 1);
  assert.deepEqual(first.next, { before: "t2", detail: false });
  assert.deepEqual((await page(first.next)).lines, [
    't1 "survey" [successful] type=researcher — episode: t1.e1',
  ]);
});

test("thread mode arguments refuse a conflict before conversion and during execution", { timeout: 5000 }, async () => {
  const { invoke, executeThreads, threadExecutions } = fixture();
  const conflict = "Use either before or parentSession: true, not both.";
  for (const [args, message] of [
    [{ before: "t1", parentSession: true }, conflict],
    [{ before: "t0", parentSession: true }, conflict],
    [{ before: undefined, parentSession: true }, conflict],
    [{ before: "t0", parentSession: "true" }, "Invalid parentSession value. Use true or false."],
  ] as const) {
    const result = await invoke("threads", args);
    assert.equal(result.isError, true);
    assert.equal(result.text, message);
    await assert.rejects(executeThreads(args), { message });
  }
  assert.deepEqual(threadExecutions, []);
});

test("the parent list uses the newest other session and has no tagged row limit", { timeout: 5000 }, async () => {
  const { add, page } = fixture();
  add(1);
  const noParent = await page({ parentSession: true });
  assert.equal(noParent.mode, "Listing: parent session, 0 threads.");
  assert.deepEqual(noParent.lines, []);
  add(2, { sessionId: "earlier", status: "failed" });
  add(3, { sessionId: undefined });
  for (let i = 4; i <= 25; i++) add(i, { sessionId: "parent" });
  add(26);

  const current = await page({ parentSession: false });
  assert.equal(current.mode, "Listing: current session, 2 threads.");
  assert.deepEqual(current.lines.map((line) => line.split(" ")[0]), ["t26", "t1"]);
  const parent = await page({ parentSession: true });
  assert.equal(parent.mode, "Listing: parent session, 22 threads.");
  assert.deepEqual(parent.lines.map((line) => line.split(" ")[0]), Array.from({ length: 22 }, (_, i) => `t${25 - i}`));
  assert.deepEqual(parent.details, { count: 26, failedCount: 1 });
  assert.equal(parent.next, undefined);
});

test("a legacy parent continuation includes older tagged and legacy records", { timeout: 5000 }, async () => {
  const { add, page } = fixture();
  for (let i = 1; i <= 22; i++) add(i, { sessionId: i === 2 ? "earlier" : undefined });
  const current = await page();
  assert.equal(current.mode, "Listing: current session, 0 threads.");
  assert.deepEqual(current.lines, []);
  const parent = await page({ parentSession: true, detail: true });
  assert.equal(parent.mode, "Listing: parent session, 20 threads.");
  assert.deepEqual(parent.lines.map((line) => line.split(" ")[0]), Array.from({ length: 20 }, (_, i) => `t${22 - i}`));
  assert.equal(parent.remaining, 2);
  assert.deepEqual(parent.next, { before: "t3", detail: true });
  const next = await page(parent.next);
  assert.equal(next.mode, "Listing: all sessions, threads older than t3.");
  assert.deepEqual(next.lines.map((line) => line.split(" ")[0]), ["t2", "t1"]);
  assert.equal(next.next, undefined);

  // A legacy group of exactly 20 does not emit a next call, even with older tagged records.
  add(1, { sessionId: "earlier" });
  assert.equal((await page({ parentSession: true })).next, undefined);
});

function project(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "slate-lookups-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const episodes = join(cwd, ".pi", "slate", "episodes");
  mkdirSync(episodes, { recursive: true });
  return { cwd, episodes };
}

type RoutingFields = Omit<Partial<EpisodeRecord>, "effort"> & { effort?: string };

function restoredFixture(t: TestContext, failover?: (id: string) => string | undefined) {
  const { cwd, episodes } = project(t);
  const lookup = fixture(failover, cwd);
  function record(ordinal: number, name: string, metadata: RoutingFields) {
    const thread = lookup.add(ordinal, { name });
    const id = thread.episodeId!;
    const file = join(episodes, `${id}.md`);
    writeFileSync(file, "## Key Findings\nStored evidence.\n");
    lookup.store.episodes.set(id, {
      id, threadId: thread.id, task: "lookup", status: "ok", file, createdAt: 1, ...metadata,
    } as EpisodeRecord);
    return file;
  }
  function restore() {
    const snapshot = lookup.store.snapshot();
    lookup.store.adoptSnapshot(snapshot, { cwd, hasUI: true, ui: {
      notify(message: string) { assert.fail(message); },
    } } as unknown as ExtensionContext);
    assert.equal(lookup.store.threads.size, snapshot.threads.length);
    assert.equal(lookup.store.episodes.size, snapshot.episodes.length);
  }
  return { ...lookup, cwd, record, restore };
}

test("a restored current-session detail list has no row or byte limit", { timeout: 5000 }, async (t) => {
  const { record, restore, page } = restoredFixture(t, () => "p/" + "j".repeat(300));
  const newest = Number.MAX_SAFE_INTEGER;
  for (let rank = 0; rank < 23; rank++) {
    record(newest - rank, "n".repeat(300), {
      logicalModel: "l".repeat(300), requestedModel: "p/" + "r".repeat(300), requestedEffort: "high",
      reason: "r".repeat(89), model: "p/" + "m".repeat(300), effort: "e".repeat(300), effortUnmeasured: true,
    });
  }
  restore();

  const first = await page({ detail: true });
  const rowId = (line: string) => line.split(" ")[0];
  assert.deepEqual(first.lines.map(rowId), Array.from({ length: 23 }, (_, rank) => `t${newest - rank}`));
  assert.match(first.lines[0]!, / logical=l+… requested=/u);
  assert.equal(first.mode, "Listing: current session, 23 threads.");
  assert.equal(first.remaining, 0);
  assert.equal(first.next, undefined);
  assert.ok(Buffer.byteLength(first.text, "utf8") > 4096);
});

test("detail keeps full one-line dispatch reasons on both sides of a continuation", { timeout: 5000 }, async (t) => {
  const quotedLabel = 'p/ ' + '"\\'.repeat(200);
  const { record, restore, page } = restoredFixture(t, () => quotedLabel);
  const reasonA = "界".repeat(100) + ' reason "A"\\ end';
  const reasonB = "界".repeat(100) + ' reason "B"\\ end';
  const worstReason = "界".repeat(200);
  for (let ordinal = 1; ordinal <= 22; ordinal++) {
    const reason = ordinal === 8 ? reasonA : ordinal === 2 ? reasonB : worstReason;
    record(ordinal, '"\\'.repeat(200), {
      reason, logicalModel: "l".repeat(200), requestedModel: "p/" + "r".repeat(200), requestedEffort: "high",
      model: quotedLabel, effort: quotedLabel, effortUnmeasured: true,
    });
  }
  restore();

  const first = await page({ before: "t23", detail: true });
  assert.match(first.summary!, /^Threads: 22\./);
  assert.ok(first.next);
  assert.match(first.lines[0]!, /^t22 /);
  assert.match(first.lines[0]!, /…" \[successful\]/u);
  assert.match(first.lines[0]!, /logical=l+… requested=p\/r+…@high/u);
  assert.ok(first.lines[0]!.includes(`reason=${JSON.stringify(worstReason)} last=`));
  assert.match(first.lines[0]!, /last="p\/ .+…"@"p\/ .+…"\(unmeasured\).+ live="p\/ .+…" \(failover\)/u);
  assert.match(first.text, /\nRemaining threads: \d+\. Next call: threads\(/u);

  const reasons = new Map<string, string>();
  let current = first;
  for (;;) {
    for (const line of current.lines) {
      const reason = / reason=("(?:[^"\\]|\\.)*") last=/.exec(line);
      assert.ok(reason);
      reasons.set(line.split(" ")[0]!, JSON.parse(reason[1]!));
    }
    if (!current.next) break;
    current = await page(current.next);
  }
  assert.equal(reasons.size, 22);
  assert.equal(reasons.get("t8"), reasonA);
  assert.equal(reasons.get("t2"), reasonB);
});

test("detail separates whitespace-bearing routing labels from each thread's live failover", { timeout: 5000 }, async (t) => {
  const live = new Map([["t2", "p/other"], ["t3", "p/fake"]]);
  const { record, restore, page, store } = restoredFixture(t, (id) => live.get(id));
  const model = "p/" + "a".repeat(81);
  record(3, "survey", { model });
  record(2, "survey", { model: "p/base", effort: 'custom "effort"\\' });
  record(1, "survey", { model: "p/base", effort: "low" });
  restore();

  const real = await page({ detail: true });
  assert.ok(real.lines[0]!.includes(` last=${model} live=p/fake (failover) — episode:`));
  assert.ok(real.lines[1]!.includes(` last=p/base@${JSON.stringify('custom "effort"\\')} live=p/other (failover) — episode:`));
  assert.ok(real.lines[2]!.includes(" last=p/base@low — episode:"));
  assert.doesNotMatch(real.lines[2]!, /live=|failover/);

  const impostor = `${model} live=p/fake (failover)`;
  store.episodes.get("t3.e1")!.model = impostor;
  live.delete("t3");
  const fake = await page({ detail: true });
  assert.notEqual(fake.lines[0], real.lines[0]);
  assert.ok(fake.lines[0]!.includes(` last=${JSON.stringify(impostor)} — episode:`));
  assert.deepEqual(fake.lines.slice(1), real.lines.slice(1));
});

test("detail escapes stored controls without impersonating the unmeasured marker", { timeout: 5000 }, async (t) => {
  const tail = "x".repeat(200) + "\t";
  const { record, restore, page } = restoredFixture(t, (id) => id === "t3" ? tail : undefined);
  record(1, "survey", { model: "p/base", effort: "low", effortUnmeasured: true });
  record(2, "survey", { model: "p/base", effort: "low\t(unmeasured)" });
  record(3, "survey", { model: 'p/"\\\u202e\u2028\u0085\ud800' });
  restore();

  const { lines } = await page({ detail: true });
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, / last="p\//u);
  assert.ok(lines[0]!.includes(String.raw` last="p/\"\\\u202e\u2028\u0085\ud800"`));
  assert.match(lines[0]!, / live="x+…" \(failover\)/u);
  assert.ok(lines[1]!.includes(String.raw` last=p/base@"low\t(unmeasured)" — episode:`));
  assert.ok(lines[2]!.includes(" last=p/base@low(unmeasured) — episode:"));
  assert.doesNotMatch(lines.join(""), /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Cs}]/u);
});

test("episode reads return exact details and refuse a known path that becomes unsafe", { timeout: 5000 }, async (t) => {
  const { record, restore, fetch, cwd } = restoredFixture(t);
  const file = record(1, "survey", {});
  restore();
  assert.deepEqual(await fetch("t1.e1"), {
    isError: false, text: "## Key Findings\nStored evidence.\n", details: { id: "t1.e1", threadId: "t1", status: "ok" },
  });

  const outside = join(cwd, "outside.md");
  writeFileSync(outside, "Do not read this file.");
  rmSync(file);
  symlinkSync(outside, file);
  const result = await fetch("t1.e1");
  assert.equal(result.isError, true);
  assert.equal(result.text, 'Episode "t1.e1" is no longer a safe readable slate episode file.');
});

test("episode miss neither repeats the requested ID nor lists known IDs", { timeout: 5000 }, async () => {
  const { store, fetch } = fixture();
  for (let n = 1; n <= 500; n++) {
    const threadId = `t${n}`;
    const id = `${threadId}.e1`;
    store.episodes.set(id, { id, threadId, task: "lookup", status: "ok", file: "/tmp/fixture", createdAt: 1 });
  }
  const message = "Unknown episode. Use threads to find episode IDs.";
  for (const id of ["missing", "missing".repeat(10_000)]) {
    const result = await fetch(id);
    assert.equal(result.isError, true);
    assert.equal(result.text, message);
  }
});
