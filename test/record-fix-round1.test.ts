import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { readOnlyEarlierLogLine } from "../extension/record-names.ts";
import { prepareRecordWrite, RecordPrepublicationError, type RecordWriteOptions } from "../extension/record-write.ts";

const abc = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const next = "sha256:c6c1c9a9c8543f1e4cd980064cf1625eeb61a90703b2464fff039f21682508b3";
const appended = "sha256:84e43cf07a8e2f9a84baced30eb7b67baaba1badea807e85b66775f29e594a4a";
const fault = (code = "EIO") => Object.assign(new Error("PRIVATE PAYLOAD"), { code });
async function fixture(t: TestContext, append = false) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "slate-record-fixes-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = createChangeFolder();
  const dir = join(root, "slate-changes", current);
  await fs.mkdir(dir, { recursive: true });
  const record = append ? "track-2.3-implementer-report.md" : "status.md";
  const context = { projectRoot: root, assignment: { currentFolder: `slate-changes/${current}`, writerRole: append ? "implementer" as const : "record-only" as const, names: [record] } };
  const path = join(dir, record);
  const versions = join(dir, "versions");
  await fs.writeFile(path, "abc", { mode: 0o600 });
  const call = (options: RecordWriteOptions = {}) => prepareRecordWrite(context,
    { record, mode: append ? "append" : "replace", payload: "next", expectedHash: abc }, options);
  return { root, current, dir, record, path, versions, call };
}
async function rejected(pending: Promise<unknown>, state = "refused before publication") {
  let found!: RecordPrepublicationError;
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RecordPrepublicationError);
    assert.equal(error.state, state);
    assert.equal(error.outcome!.state, state);
    assert.equal(error.outcome!.publication, "not attempted");
    assert.ok(error.outcome!.reason);
    assert.doesNotMatch(JSON.stringify(error.outcome), /PRIVATE PAYLOAD/);
    found = error;
    return true;
  });
  return found.outcome!;
}

test("record-fix-F1 reports a possible version when link and observation reject", async (t) => {
  const f = await fixture(t);
  const version = join(f.versions, `status.md.v1.${abc.slice(7)}`);
  let linked = false;
  const result = await rejected((await f.call({ fs: { ...fs,
    async link(from, to) { await fs.link(from, to); linked = true; throw fault(); },
    async lstat(path) { if (linked && path === version) throw fault("EACCES"); return fs.lstat(path); },
  } })).publish(), "failed before publication");
  const artifact = result.artifacts.find((entry) => entry.path === version);
  assert.ok(artifact);
  assert.equal(artifact.kind, "version");
  assert.equal(artifact.complete, false);
  assert.match(artifact.reason, /Possible.*could not be observed/);
  assert.equal(result.replacement, undefined);
  assert.equal(await fs.readFile(version, "utf8"), "abc");
  assert.equal(await fs.readFile(f.path, "utf8"), "abc");
});

for (const phase of ["partial-copy", "private-sync", "link"] as const) {
  test(`record-fix-RI2 reserves failed staging sequence after ${phase}`, async (t) => {
    const f = await fixture(t);
    const result = await rejected((await f.call({ fs: { ...fs,
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode);
        if (path.startsWith(f.versions + "/") && flags & constants.O_CREAT) {
          if (phase === "partial-copy") handle.writeFile = async () => { await handle.write(Buffer.from("a")); throw fault(); };
          if (phase === "private-sync") handle.sync = async () => { throw fault(); };
        }
        return handle;
      },
      async link(from, to) { if (phase === "link") throw fault(); await fs.link(from, to); },
    } })).publish(), "failed before publication");
    const entries = await fs.readdir(f.versions);
    assert.equal(entries.length, 1);
    assert.match(entries[0]!, /^\.slate-record-version-status\.md\.v1\.[0-9a-f]{32}\.tmp$/);
    const path = join(f.versions, entries[0]!);
    assert.ok(result.artifacts.some((entry) => entry.path === path && !entry.complete));
    assert.equal(await fs.readFile(path, "utf8"), phase === "partial-copy" ? "a" : "abc");
    assert.equal((await fs.lstat(path)).nlink, 1);
    assert.equal((await fs.lstat(path)).mode & 0o777, 0o600);
    const retry = await (await f.call()).publish();
    assert.equal(retry.state, "published and synced");
    assert.match(retry.replacement!.version, /status\.md\.v2\./);
    assert.equal((await fs.readdir(f.versions)).some((entry) => entry.startsWith("status.md.v1.")), false);
    assert.equal(await fs.readFile(path, "utf8"), phase === "partial-copy" ? "a" : "abc");
  });
}

for (const phase of ["folder-sync", "version-sync", "identity"] as const) {
  test(`record-fix-UF1 preserves ${phase} primary failure when close also rejects`, async (t) => {
    const f = await fixture(t);
    let versionOpens = 0;
    const result = await rejected((await f.call({ fs: { ...fs, async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      const versionSync = path.startsWith(f.versions + "/status.md.v") && ++versionOpens === 2;
      if (phase === "folder-sync" && path === f.versions || phase !== "folder-sync" && versionSync) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); throw fault(); };
        if (phase === "identity") {
          const identity = await handle.stat();
          handle.stat = async () => Object.assign(Object.create(Object.getPrototypeOf(identity)), identity, { ino: identity.ino + 1 });
        } else handle.sync = async () => { throw fault("ENOTSUP"); };
      }
      return handle;
    } } })).publish());
    assert.match(result.reason, phase === "identity" ? /version sync identity changed/ : /filesystem lacks a required write operation/);
    assert.ok(result.secondaryFailures.some((reason) => /handle did not close/.test(reason)));
    assert.equal(await fs.readFile(f.path, "utf8"), "abc");
  });
}

test("record-fix-UF2 never certifies bytes truncated after retained-file sync", async (t) => {
  const f = await fixture(t);
  const version = join(f.versions, `status.md.v1.${abc.slice(7)}`);
  const result = await rejected((await f.call({ fs: { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    if (path === version) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); await fs.truncate(path, 1); };
    }
    return handle;
  } } })).publish());
  const artifact = result.artifacts.find((entry) => entry.path === version)!;
  assert.equal(artifact.complete, false);
  assert.doesNotMatch(artifact.reason, /Retained earlier bytes/);
  assert.equal(result.replacement, undefined);
  assert.equal(result.sync.version, false);
  assert.equal(await fs.readFile(version, "utf8"), "a");
  assert.equal(await fs.readFile(f.path, "utf8"), "abc");
});

for (const kind of ["two-link", "symlink", "broad"] as const) {
  test(`record-fix-M1 names unsafe version evidence ${kind}`, async (t) => {
    const f = await fixture(t);
    await fs.mkdir(f.versions, { mode: 0o700 });
    const version = join(f.versions, `status.md.v1.${abc.slice(7)}`);
    const staging = join(f.versions, `.slate-record-version-status.md.v1.${"a".repeat(32)}.tmp`);
    if (kind === "two-link") { await fs.writeFile(staging, "abc", { mode: 0o600 }); await fs.link(staging, version); }
    if (kind === "symlink") await fs.symlink(f.path, version);
    if (kind === "broad") await fs.writeFile(version, "abc", { mode: 0o644 });
    const result = await rejected((await f.call()).publish());
    const artifact = result.artifacts.find((entry) => entry.path === version || entry.path === staging);
    assert.ok(artifact);
    assert.ok(result.reason.includes(artifact.path.slice(f.versions.length + 1)));
    assert.match(result.reason, /version entry/);
    assert.equal(artifact.complete, false);
    assert.equal((await fs.lstat(f.path)).nlink, 1);
    assert.equal(await fs.readFile(f.path, "utf8"), "abc");
    if (kind === "two-link") assert.equal((await fs.lstat(version)).nlink, 2);
  });
}

for (const change of ["identity", "bytes", "read-only"] as const) {
  test(`record-fix-M2 rejects ${change} before version retention`, async (t) => {
    const f = await fixture(t);
    const write = await f.call();
    if (change === "identity") { await fs.rename(f.path, f.path + "-held"); await fs.writeFile(f.path, "abc"); }
    if (change === "bytes") await fs.writeFile(f.path, "changed");
    let log: string | undefined;
    if (change === "read-only") {
      const sibling = join(f.root, "slate-changes", createChangeFolder());
      await fs.mkdir(sibling);
      log = join(sibling, "research-log.md");
      await fs.writeFile(log, readOnlyEarlierLogLine(f.current) + "\n");
    }
    const result = await rejected(write.publish());
    assert.match(result.reason, change === "read-only" ? /read-only/ : /changed before publication/);
    assert.deepEqual(result.artifacts, []);
    await assert.rejects(fs.lstat(f.versions), { code: "ENOENT" });
    if (log) await fs.unlink(log);
    if (change === "bytes") await fs.writeFile(f.path, "abc");
    const retry = await (await f.call()).publish();
    assert.equal(retry.state, "published and synced");
    assert.match(retry.replacement!.version, /status\.md\.v1\./);
  });
}

for (const existing of [false, true]) {
  test(`record-fix-SE1 refuses broad version folder on ${existing ? "preexisting" : "retry"} path`, async (t) => {
    const f = await fixture(t);
    if (existing) await fs.mkdir(f.versions, { mode: 0o777 });
    else {
      const initial = await rejected((await f.call({ fs: { ...fs, async mkdir(path, options) {
        await fs.mkdir(path, options); await fs.chmod(path, 0o755);
      } } })).publish());
      assert.match(initial.reason, /version folder is not private/);
    }
    if (existing) await fs.chmod(f.versions, 0o777);
    const result = await rejected((await f.call()).publish());
    assert.match(result.reason, /version folder is not private/);
    assert.deepEqual(await fs.readdir(f.versions), []);
    assert.equal(await fs.readFile(f.path, "utf8"), "abc");
  });
}

for (const target of ["version", "record"] as const) {
  test(`record-fix-SE2 does not block on a FIFO at the ${target} sync open`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, target === "record");
    const controller = new AbortController();
    let opens = 0;
    let swapped = false;
    let syncFlags: number | undefined;
    const write = await f.call({ signal: controller.signal, fs: { ...fs, async open(path, flags, mode) {
      const selected = target === "record" ? path === f.path : path.startsWith(f.versions + "/status.md.v");
      if (selected && ++opens === (target === "record" ? 4 : 2)) {
        await fs.unlink(path);
        await promisify(execFile)("mkfifo", [path]);
        swapped = true;
        syncFlags = flags;
        controller.abort();
        assert.ok(flags & constants.O_NONBLOCK, "sync opens must be nonblocking before opening the FIFO");
      }
      return fs.open(path, flags, mode);
    } } });
    if (target === "version") {
      const result = await rejected(write.publish());
      assert.match(result.reason, /version sync identity changed/);
      assert.equal(result.abortObserved, true);
    } else {
      const result = await write.publish();
      assert.equal(result.state, "published with uncertain durability");
      assert.equal(result.abortObserved, true);
      assert.equal(result.sync.record, false);
      assert.ok(result.reason);
    }
    assert.equal(swapped, true);
    assert.ok(syncFlags! & constants.O_NONBLOCK, "the attempted sync open must retain O_NONBLOCK even when settlement catches its error");
    assert.equal((await fs.lstat(target === "record" ? f.path : join(f.versions, `status.md.v1.${abc.slice(7)}`))).isFIFO(), true);
  });
}

for (const scenario of ["success", "folder-failure", "abort", "abort-failure"] as const) {
  test(`record-fix-TQ1 asserts append outcome for ${scenario}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, true);
    const controller = new AbortController();
    let enter!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { enter = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let published = false;
    const write = await f.call({ signal: controller.signal, fs: { ...fs,
      async rename(from, to) { if (scenario.startsWith("abort")) { enter(); await barrier; } await fs.rename(from, to); published = true; },
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode);
        if (published && path === f.dir && scenario.endsWith("failure")) handle.sync = async () => { throw fault(); };
        return handle;
      },
    } });
    let reported = false;
    const pending = write.publish().then((result) => { reported = true; return result; });
    if (scenario.startsWith("abort")) { await ready; controller.abort(); assert.equal(reported, false); release(); }
    const result = await pending;
    assert.equal(result.state, scenario.endsWith("failure") ? "published with uncertain durability" : "published and synced");
    assert.match(result.reason, scenario.endsWith("failure") ? /Pause dependent work.*inspect/ : /Do not repeat/);
    assert.equal(result.publication, "returned");
    assert.equal(result.abortObserved, scenario.startsWith("abort"));
    assert.deepEqual(result.sync, { candidate: true, version: false, record: true, folders: !scenario.endsWith("failure"), cleanup: true });
    assert.equal(result.observedBeforeHash, abc);
    assert.equal(result.observedAfterHash, appended);
    assert.equal(result.intendedHash, appended);
    assert.equal(await fs.readFile(f.path, "utf8"), "abcnext");
    assert.equal((await fs.lstat(f.path)).nlink, 1);
    assert.deepEqual(result.artifacts, []);
    await assert.rejects(fs.lstat(write.temporaryPath), { code: "ENOENT" });
  });
}

test("record-fix-TQ2 observes replacement when rename lands then rejects", async (t) => {
  const f = await fixture(t);
  const write = await f.call({ fs: { ...fs, async rename(from, to) { await fs.rename(from, to); throw fault(); } } });
  const result = await write.publish();
  assert.equal(result.state, "published with uncertain durability");
  assert.equal(result.publication, "observed");
  assert.match(result.reason, /Pause dependent work.*inspect/);
  assert.equal(result.observedBeforeHash, abc);
  assert.equal(result.observedAfterHash, next);
  assert.deepEqual(result.sync, { candidate: true, version: true, record: true, folders: true, cleanup: true });
  assert.deepEqual(result.replacement, { version: join(f.versions, `status.md.v1.${abc.slice(7)}`), oldHash: abc, newHash: next });
  assert.equal(await fs.readFile(result.replacement!.version, "utf8"), "abc");
  assert.equal((await fs.lstat(result.replacement!.version)).nlink, 1);
  assert.equal(await fs.readFile(f.path, "utf8"), "next");
  assert.equal((await fs.lstat(f.path)).nlink, 1);
  await assert.rejects(fs.lstat(write.temporaryPath), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE PAYLOAD/);
});
