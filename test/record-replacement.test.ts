import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { prepareRecordWrite, RecordPrepublicationError, RECORD_PAYLOAD_MAX, type RecordWriteOptions } from "../extension/record-write.ts";

const abc = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture(t: TestContext, record = "status.md") {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "slate-record-replacement-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = createChangeFolder();
  const dir = join(root, "slate-changes", current);
  await fs.mkdir(dir, { recursive: true });
  const context = { projectRoot: root, assignment: { currentFolder: `slate-changes/${current}`, writerRole: "record-only" as const, names: [record] } };
  const path = join(dir, record);
  const versions = join(dir, "versions");
  const call = (payload: string, expectedHash = abc, extra: RecordWriteOptions = {}) => prepareRecordWrite(context,
    { record, mode: "replace", payload, expectedHash }, extra);
  return { root, dir, record, path, versions, context, call };
}
async function failure(action: Promise<unknown>, reason: RegExp, state = "refused before publication") {
  let found!: RecordPrepublicationError;
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof RecordPrepublicationError);
    assert.equal(error.state, state);
    assert.match(error.message, reason);
    assert.equal(error.outcome?.state, state);
    assert.equal(error.outcome?.reason, error.message);
    found = error;
    return true;
  });
  return found;
}
function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release, hold: async () => { enter(); await wait; } };
}

for (const record of ["status.md", "root-design.md", "track-2.3-design.md"]) {
  test(`record-version-retention preserves repeated replacements and private bytes for ${record}`, async (t) => {
    const f = await fixture(t, record);
    let earlier = Buffer.from("abc");
    await fs.writeFile(f.path, earlier, { mode: 0o644 });
    const interim = join(f.dir, record.replace(/\.md$/, ".v1.md"));
    await fs.writeFile(interim, "manual version");
    const retained = new Map<string, Buffer>();
    for (const [index, payload] of ["replacement\r\n😀", "second", ""].entries()) {
      const old = await fs.lstat(f.path);
      const write = await f.call(payload, digest(earlier));
      assert.equal((await fs.lstat(f.path)).mode & 0o777, old.mode & 0o777);
      const result = await write.publish();
      assert.equal(result.state, "published and synced");
      assert.match(result.reason, /Do not repeat/);
      const version = join(f.versions, `${record}.v${index + 1}.${digest(earlier).slice(7)}`);
      assert.deepEqual(result.replacement, { version, oldHash: digest(earlier), newHash: digest(Buffer.from(payload)) });
      assert.deepEqual(result.sync, { candidate: true, version: true, record: true, folders: true, cleanup: true });
      assert.equal(result.observedBeforeHash, digest(earlier));
      assert.equal(result.observedAfterHash, digest(Buffer.from(payload)));
      retained.set(version, earlier);
      for (const [path, bytes] of retained) {
        assert.deepEqual(await fs.readFile(path), bytes);
        const entry = await fs.lstat(path);
        assert.equal(entry.mode & 0o777, 0o600);
        assert.equal(entry.nlink, 1);
        assert.notEqual(entry.ino, old.ino, "retention copies rather than links the manual record");
      }
      assert.deepEqual(await fs.readFile(f.path), Buffer.from(payload));
      assert.equal((await fs.lstat(f.path)).nlink, 1);
      assert.equal((await fs.lstat(f.path)).mode & 0o777, 0o600);
      assert.equal((await fs.lstat(f.versions)).mode & 0o777, 0o700);
      assert.equal(await fs.readFile(interim, "utf8"), "manual version");
      assert.ok((await fs.readdir(f.versions)).every((entry) => !entry.endsWith(".tmp")));
      earlier = Buffer.from(payload);
    }
  });
}

test("record-version-retention numbers each record independently and allows gaps without reuse", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "abc");
  await fs.mkdir(f.versions, { mode: 0o700 });
  const prior = `status.md.v7.${abc.slice(7)}`;
  await fs.writeFile(join(f.versions, prior), "abc", { mode: 0o600 });
  await fs.writeFile(join(f.versions, `root-design.md.v90.${abc.slice(7)}`), "abc", { mode: 0o600 });
  let write = await f.call("first", abc, { beforeFinalCheck: async () => { throw new Error("stop after retention"); } });
  const error = await failure(write.publish(), /final safety check/, "failed before publication");
  assert.ok(error.outcome!.artifacts.some((artifact) => artifact.path.includes("status.md.v8.") && artifact.complete));
  assert.equal(await fs.readFile(f.path, "utf8"), "abc");
  write = await f.call("second");
  const result = await write.publish();
  assert.equal(result.state, "published and synced");
  assert.match(result.replacement!.version, /status\.md\.v9\./);
  for (const n of [7, 8, 9]) assert.equal(await fs.readFile(join(f.versions, `status.md.v${n}.${abc.slice(7)}`), "utf8"), "abc");
});

for (const suffix of ["01." + abc.slice(7), "0." + abc.slice(7), "2.bad", "9007199254740992." + abc.slice(7), "1." + "0".repeat(64), "1." + abc.slice(7) + "\n"]) {
  test(`record-version-retention rejects malformed or false evidence ${suffix}`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.path, "abc");
    await fs.mkdir(f.versions, { mode: 0o700 });
    const planted = join(f.versions, "status.md.v" + suffix);
    await fs.writeFile(planted, "abc", { mode: 0o600 });
    const write = await f.call("next");
    await failure(write.publish(), /version entry/);
    assert.equal(await fs.readFile(planted, "utf8"), "abc");
    assert.equal(await fs.readFile(f.path, "utf8"), "abc");
    assert.deepEqual(await fs.readdir(f.versions), ["status.md.v" + suffix]);
  });
}

test("record-version-retention refuses exhausted sequence and name bounds", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "abc");
  await fs.mkdir(f.versions, { mode: 0o700 });
  const path = join(f.versions, `status.md.v${Number.MAX_SAFE_INTEGER}.${abc.slice(7)}`);
  await fs.writeFile(path, "abc", { mode: 0o600 });
  await failure((await f.call("next")).publish(), /exceeds supported bounds/);
  assert.equal(await fs.readFile(f.path, "utf8"), "abc");
  // Valid record names and safe integer sequences fit the 255-byte name bound.
  assert.ok(Buffer.byteLength(`track-${"1.".repeat(56)}1234567890123456-design.md.v${Number.MAX_SAFE_INTEGER}.${abc.slice(7)}`) <= 255);
});

for (const kind of ["symlink", "directory", "hardlink", "broad"] as const) {
  test(`record-path-protection rejects unsafe retained evidence: ${kind}`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.path, "abc");
    await fs.mkdir(f.versions, { mode: 0o700 });
    const path = join(f.versions, `status.md.v1.${abc.slice(7)}`);
    if (kind === "symlink") await fs.symlink(f.path, path);
    if (kind === "directory") await fs.mkdir(path);
    if (kind === "hardlink") { await fs.writeFile(join(f.root, "other"), "abc"); await fs.link(join(f.root, "other"), path); }
    if (kind === "broad") await fs.writeFile(path, "abc", { mode: 0o644 });
    await failure((await f.call("next")).publish(), /regular file|hard links|permissions/);
    assert.equal(await fs.readFile(f.path, "utf8"), "abc");
    assert.ok(await fs.lstat(path));
  });
}

test("record-path-protection refuses a linked versions folder without touching its target", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "abc");
  const outside = join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, f.versions);
  await failure((await f.call("next")).publish(), /real directory/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(f.path, "utf8"), "abc");
});

for (const change of ["identity", "bytes", "versions-folder"] as const) {
  test(`record-stale-update replacement refuses ${change} at the final check`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.path, "abc");
    const b = barrier();
    const write = await f.call("next", abc, { beforeFinalCheck: b.hold });
    const pending = write.publish();
    await b.ready;
    if (change === "identity") { await fs.rename(f.path, f.path + "-held"); await fs.writeFile(f.path, "abc"); }
    if (change === "bytes") await fs.writeFile(f.path, "changed");
    if (change === "versions-folder") { await fs.rename(f.versions, f.versions + "-held"); await fs.mkdir(f.versions); }
    b.release();
    await failure(pending, /changed/);
    assert.equal(await fs.readFile(f.path, "utf8"), change === "bytes" ? "changed" : "abc");
    const versionDir = change === "versions-folder" ? f.versions + "-held" : f.versions;
    assert.equal(await fs.readFile(join(versionDir, `status.md.v1.${abc.slice(7)}`), "utf8"), "abc");
  });
}

test("record-stale-update rejects replacement hash mismatches and gives class-specific advice", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "abc");
  await failure(f.call("next", digest(Buffer.from("different"))), /stale.*fresh hash/);
  assert.deepEqual(await fs.readdir(f.dir), ["status.md"]);
  for (const args of [
    { record: f.record, mode: "create", payload: "next" },
    { record: f.record, mode: "replace", payload: "x".repeat(RECORD_PAYLOAD_MAX + 1), expectedHash: abc },
  ]) {
    const error = await failure(prepareRecordWrite(f.context, args), /already exists|exceeds/);
    assert.doesNotMatch(error.message, /append|Split/);
    assert.doesNotMatch(JSON.stringify(error.outcome), /xxxxx/);
  }
  await failure(prepareRecordWrite(f.context, { record: f.record, mode: "replace", payload: "next" }), /expected hash/);
});

test("record-version-retention preserves interrupted private attempts outside hash-bound names", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "abc");
  await fs.mkdir(f.versions, { mode: 0o700 });
  const partial = join(f.versions, `.slate-record-version-status.md.v4.${"a".repeat(32)}.tmp`);
  await fs.writeFile(partial, "a", { mode: 0o600 });
  const result = await (await f.call("next")).publish();
  assert.equal(result.state, "published and synced");
  assert.match(result.replacement!.version, /status\.md\.v5\./);
  assert.equal(await fs.readFile(partial, "utf8"), "a", "a later call never cleans another attempt");
  const malformed = join(f.versions, ".slate-record-version-status.md.vbad.tmp");
  await fs.writeFile(malformed, "a", { mode: 0o600 });
  await failure((await f.call("third", digest(Buffer.from("next")))).publish(), /staging entry.*invalid sequence/);
  assert.equal(await fs.readFile(f.path, "utf8"), "next");
  await fs.unlink(malformed);
  const newline = join(f.versions, `.slate-record-version-status.md.v6.${"a".repeat(32)}.tmp\n`);
  await fs.writeFile(newline, "a", { mode: 0o600 });
  await failure((await f.call("third", digest(Buffer.from("next")))).publish(), /staging entry.*invalid sequence/);
  assert.equal(await fs.readFile(newline, "utf8"), "a");
  await failure(f.call("next", digest(Buffer.from("next")), { temporaryName: () => `.slate-record-${"a".repeat(32)}.tmp\n` }), /temporary name is invalid/);
});

test("record-version-retention sync order precedes atomic replacement", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "abc");
  const events: string[] = [];
  const io = { ...fs, async open(path: string, flags: number, mode?: number) {
    const handle = await fs.open(path, flags, mode);
    if (flags & constants.O_CREAT) assert.equal(mode, 0o600);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { events.push("sync:" + path); await sync(); };
    return handle;
  }, async link(from: string, to: string) {
    assert.deepEqual(await fs.readFile(from), Buffer.from("abc"));
    assert.ok(events.includes("sync:" + from));
    events.push("link:" + to);
    await fs.link(from, to);
  }, async rename(from: string, to: string) {
    const version = join(f.versions, `status.md.v1.${abc.slice(7)}`);
    for (const path of [version, f.versions, f.dir, from]) assert.ok(events.includes("sync:" + path), path);
    events.push("rename");
    await fs.rename(from, to);
  } };
  const result = await (await f.call("next", abc, { fs: io })).publish();
  assert.equal(result.state, "published and synced");
  const publish = events.indexOf("rename");
  for (const path of [f.versions, f.dir, result.replacement!.version]) assert.ok(events.indexOf("sync:" + path) < publish);
  assert.ok(events.lastIndexOf("sync:" + f.dir) > publish);
});
