// record-tool-test: all
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { createChangeDirectory } from "../extension/slate-files.ts";
import { buildRecordAssignment } from "../extension/record-names.ts";
import { RecordOwnership } from "../extension/record-ownership.ts";
import { createRecordWorkerRuntime, renderRecordFacts, recordWorkerGuidance, RECORD_TOOL_DESCRIPTION, RECORD_TOOL_PARAMETERS } from "../extension/record-worker.ts";
import { recordHash, prepareRecordWrite, RecordPrepublicationError, type RecordWriteArguments, type RecordWriteOptions } from "../extension/record-write.ts";

function barrier() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: import("node:test").TestContext, options: RecordWriteOptions = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "slate-record-worker-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = { currentChange: createChangeFolder(), sourceChange: undefined as string | undefined };
  createChangeDirectory(cwd, store.currentChange);
  const owner = new RecordOwnership(store);
  const assignment = buildRecordAssignment({ type: "implementer", trackNumber: "2.4" }, store.currentChange, undefined)!;
  const lease = owner.reserve(assignment);
  const runtime = createRecordWorkerRuntime(cwd, lease, options);
  let execute!: (id: string, args: RecordWriteArguments, signal?: AbortSignal) => Promise<any>;
  const hooks = new Map<string, Function>();
  runtime.extension({ on(name: string, fn: Function) { hooks.set(name, fn); }, registerTool(tool: any) { execute = tool.execute; } } as unknown as ExtensionAPI);
  return { cwd, store, owner, assignment, lease, runtime, execute, hooks, path: join(cwd, assignment.currentFolder, assignment.names[0]!) };
}

test("record-write-interleavings serializes parallel same-hash appends through settlement", { timeout: 10000 }, async (t) => {
  const entered = barrier(), release = barrier(); let stages = 0;
  const f = await fixture(t, { beforeFinalCheck: async () => { if (++stages === 2) { entered.resolve(); await release.promise; } } });
  const args = { record: f.assignment.names[0], mode: "create", payload: "earlier" };
  const created = await f.execute("create", args);
  assert.equal(created.details.state, "published and synced");
  // Independent Node digest supplies this fixture's update witness.
  const { createHash } = await import("node:crypto");
  const hash = `sha256:${createHash("sha256").update("earlier").digest("hex")}`;
  assert.equal(hash.length, 71);
  const first = f.execute("first", { ...args, mode: "append", payload: "+one", expectedHash: hash });
  await entered.promise;
  const second = f.execute("second", { ...args, mode: "append", payload: "+two", expectedHash: hash });
  assert.equal(stages, 2, "second has not entered preparation or publication");
  assert.equal((await readFile(f.path)).toString(), "earlier");
  release.resolve();
  assert.equal((await first).details.state, "published and synced");
  const stale = await second;
  assert.equal(stale.isError, true);
  assert.equal(stale.details.state, "refused before publication");
  assert.match(stale.details.reason, /stale/);
  assert.equal((await readFile(f.path)).toString(), "earlier+one");
  assert.equal((await stat(f.path)).nlink, 1);
  assert.equal(f.runtime.facts().length, 3);
  assert.equal(f.runtime.facts()[2]!.observedBeforeHash, recordHash(Buffer.from("earlier+one")));
});

test("record-name-ownership reserves one destination at admission and releases after settlement", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.owner.reserve(f.assignment), /already has an admitted writer/);
  assert.throws(() => f.owner.change(() => { f.store.currentChange = createChangeFolder(); }), /busy with record writers/);
  assert.equal(f.store.currentChange, f.assignment.currentFolder.slice(14));
  f.lease.close(); await f.lease.settle(); f.lease.release();
  const next = f.owner.reserve(f.assignment);
  f.lease.release();
  assert.throws(() => f.owner.reserve(f.assignment), /already has an admitted writer/);
  const folder = f.store.currentChange;
  f.store.currentChange = createChangeFolder();
  assert.throws(() => next.check(), /ownership moved/);
  f.store.currentChange = folder;
  f.store.sourceChange = createChangeFolder();
  assert.throws(() => next.check(), /ownership moved/);
  f.store.sourceChange = undefined;
  next.release();
  f.owner.change(() => { f.store.currentChange = createChangeFolder(); });
  assert.throws(() => f.owner.reserve(f.assignment), /no longer matches/);
});

for (const transition of ["handoff", "folder fork", "session teardown", "worker teardown"]) {
  test(`record-abort-settlement ${transition} stops admission before ownership changes`, { timeout: 10000 }, async (t) => {
    const entered = barrier(), release = barrier();
    const f = await fixture(t, { beforeFinalCheck: async () => { entered.resolve(); await release.promise; } });
    const running = f.execute("first", { record: f.assignment.names[0], mode: "create", payload: "bound bytes" });
    await entered.promise;
    f.owner.stop();
    let moved = false;
    const transfer = f.owner.settle().then(() => { moved = true; f.store.currentChange = createChangeFolder(); });
    assert.equal(moved, false);
    const later = f.execute("later", { record: f.assignment.names[0], mode: "append", payload: "late", expectedHash: recordHash(Buffer.from("bound bytes")) });
    release.resolve();
    assert.equal((await running).details.state, "published and synced");
    await transfer;
    assert.equal((await later).details.state, "refused before publication");
    assert.match((await later).details.reason, /admission ended/);
    assert.equal((await readFile(f.path)).toString(), "bound bytes");
    assert.equal((await stat(f.path)).nlink, 1);
  });
}

test("record-session-isolation keeps assignment and outcome state separate", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const other = f.owner.reserve(buildRecordAssignment({ type: "general", records: ["status.md"] }, f.store.currentChange, undefined)!);
  const runtime = createRecordWorkerRuntime(f.cwd, other);
  let execute!: Function;
  runtime.extension({ on() {}, registerTool(tool: any) { execute = tool.execute; } } as unknown as ExtensionAPI);
  const [one, two] = await Promise.all([
    f.execute("one", { record: f.assignment.names[0], mode: "create", payload: "report" }),
    execute("two", { record: "status.md", mode: "create", payload: "status" }),
  ]);
  assert.equal(one.details.state, "published and synced"); assert.equal(two.details.state, "published and synced");
  const wrong = await execute("wrong", { record: f.assignment.names[0], mode: "append", payload: "wrong", expectedHash: recordHash(Buffer.from("report")) });
  assert.equal(wrong.details.state, "refused before publication"); assert.match(wrong.details.reason, /not assigned/);
  assert.equal(f.runtime.facts().length, 1); assert.equal(runtime.facts().length, 2);
  assert.equal((await readFile(f.path)).toString(), "report");
  assert.equal(await readFile(join(f.cwd, f.assignment.currentFolder, "status.md"), "utf8"), "status");
  assert.match(recordWorkerGuidance(other), /status.md \(create, replace\)/);
  assert.equal(recordWorkerGuidance(undefined), "");
});

test("record-outcome-reporting preserves core refusal, uncertain and unknown evidence but rejects invalid-mode and reuse evidence", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const args = { record: f.assignment.names[0], mode: "create", payload: "private" };
  for (const state of ["published with uncertain durability", "unknown outcome"] as const) {
    const runtime = createRecordWorkerRuntime(f.cwd, f.lease, {}, async (...input) => {
      const prepared = await prepareRecordWrite(...input);
      return { ...prepared, async publish() { const result = await prepared.publish(); return { ...result, state }; } };
    });
    let execute!: Function;
    runtime.extension({ on() {}, registerTool(tool: any) { execute = tool.execute; } } as unknown as ExtensionAPI);
    const result = await execute("uncertain", state === "unknown outcome" ? { ...args, mode: "append", expectedHash: recordHash(Buffer.from("private")), payload: "+x" } : args);
    assert.equal(result.details.state, state); assert.equal(result.isError, true);
    assert.ok(runtime.facts()[0]!.observedAfterHash);
    assert.match(renderRecordFacts(runtime.facts()), new RegExp(state));
  }
  const before = recordHash(await readFile(f.path));
  let execute!: Function;
  const refusal = new RecordPrepublicationError("refused before publication", "This prepared write was already used.", "admission");
  const prepared = await prepareRecordWrite({ projectRoot: f.cwd, assignment: f.assignment }, { ...args, mode: "append", payload: "", expectedHash: before });
  const outcome = await prepared.publish();
  refusal.outcome = outcome;
  const runtime = createRecordWorkerRuntime(f.cwd, f.lease, {}, async () => { throw refusal; });
  runtime.extension({ on() {}, registerTool(tool: any) { execute = tool.execute; } } as unknown as ExtensionAPI);
  const reused = await execute("reuse", args);
  assert.equal(reused.details.state, "refused before publication");
  assert.equal(runtime.facts()[0]!.observedAfterHash, undefined);
  const invalid = await f.execute("invalid", { ...args, mode: "bogus" });
  assert.equal(invalid.details.mode, "invalid");
  assert.equal(f.runtime.facts()[0]!.observedAfterHash, undefined);
  assert.equal(renderRecordFacts([]), "");
  f.runtime.close();
  const closed = await f.execute("closed", args);
  assert.match(closed.details.reason, /not live/);
});

test("record-tool-sizes measures production definitions and separate assignment guidance", () => {
  assert.equal(Buffer.byteLength(RECORD_TOOL_DESCRIPTION), 402);
  assert.equal(Buffer.byteLength(JSON.stringify(RECORD_TOOL_PARAMETERS)), 507);
  const owner = new RecordOwnership({ currentChange: "change-20261004T000000Z-" + "a".repeat(32) });
  const lease = owner.reserve(buildRecordAssignment({ type: "implementer", trackNumber: "2.4" }, "change-20261004T000000Z-" + "a".repeat(32), undefined)!);
  assert.equal(Buffer.byteLength(recordWorkerGuidance(lease)), 223);
  assert.equal(renderRecordFacts([]), "");
});
