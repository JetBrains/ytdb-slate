import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { prepareRecordWrite, RecordPrepublicationError, type RecordFileSystem, type RecordWriteOptions } from "../extension/record-write.ts";

const abc = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const nextHash = "sha256:c6c1c9a9c8543f1e4cd980064cf1625eeb61a90703b2464fff039f21682508b3";
const fault = (errno = "EIO") => Object.assign(new Error("PRIVATE PAYLOAD must never reach a report"), { code: errno });
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "slate-record-settlement-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = createChangeFolder();
  const dir = join(root, "slate-changes", current);
  await fs.mkdir(dir, { recursive: true });
  const context = { projectRoot: root, assignment: { currentFolder: `slate-changes/${current}`, writerRole: "record-only" as const, names: ["status.md"] } };
  const path = join(dir, "status.md");
  const versions = join(dir, "versions");
  const call = (mode = "create", options: RecordWriteOptions = {}) => prepareRecordWrite(context,
    { record: "status.md", mode, payload: "next", ...(mode === "create" ? {} : { expectedHash: abc }) }, options);
  return { root, dir, path, versions, context, call };
}
async function failure(action: Promise<unknown>, reason: RegExp, state = "failed before publication") {
  let result!: RecordPrepublicationError;
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof RecordPrepublicationError);
    assert.equal(error.state, state);
    assert.match(error.message, reason);
    assert.equal(error.outcome?.state, state);
    assert.ok(error.outcome?.reason);
    assert.doesNotMatch(JSON.stringify(error.outcome), /PRIVATE PAYLOAD/);
    result = error;
    return true;
  });
  return result;
}
function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release, hold: async () => { enter(); await wait; } };
}

for (const mode of ["create", "replace"]) {
  test(`record-outcome-reporting classifies known failed ${mode} publication`, async (t) => {
    const f = await fixture(t);
    if (mode === "replace") await fs.writeFile(f.path, "abc");
    const io = { ...fs, async link(from: string, to: string) { if (to === f.path) throw fault(); await fs.link(from, to); }, async rename() { throw fault(); } };
    const write = await f.call(mode, { fs: io });
    const error = await failure(write.publish(), /publication.*Inspect/);
    assert.equal(error.outcome!.publication, "not published");
    assert.equal(error.outcome!.intendedHash, nextHash);
    assert.equal(error.outcome!.observedAfterHash, mode === "replace" ? abc : undefined);
    if (mode === "replace") {
      assert.equal(await fs.readFile(f.path, "utf8"), "abc");
      assert.equal(await fs.readFile(error.outcome!.replacement!.version, "utf8"), "abc");
    } else await assert.rejects(fs.lstat(f.path), { code: "ENOENT" });
    assert.equal((await fs.readdir(f.dir)).some((entry) => entry.endsWith(".tmp")), false);
  });
}

for (const errno of ["EIO", "EEXIST"]) {
  test(`record-outcome-reporting detects a completed create despite ${errno}`, async (t) => {
    const f = await fixture(t);
    const result = await (await f.call("create", { fs: { ...fs, async link(from, to) { await fs.link(from, to); throw fault(errno); } } })).publish();
    assert.equal(result.state, "published with uncertain durability");
    assert.equal(result.publication, "observed");
    assert.equal(result.observedAfterHash, nextHash);
    assert.equal(result.intendedHash, nextHash);
    assert.ok(result.reason);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE PAYLOAD/);
    assert.equal(await fs.readFile(f.path, "utf8"), "next");
    assert.equal((await fs.lstat(f.path)).nlink, 1);
    assert.deepEqual(await fs.readdir(f.dir), ["status.md"]);
  });
}

test("record-outcome-reporting never adopts equal competitor bytes after EEXIST", async (t) => {
  const f = await fixture(t);
  const write = await f.call("create", { fs: { ...fs, async link(from, to) { await fs.writeFile(to, "next"); await fs.link(from, to); } } });
  const error = await failure(write.publish(), /already exists/, "refused before publication");
  assert.equal(error.outcome!.publication, "not published");
  assert.equal(error.outcome!.observedAfterHash, nextHash);
  assert.equal(await fs.readFile(f.path, "utf8"), "next");
  assert.equal((await fs.lstat(f.path)).nlink, 1);
});

for (const mode of ["create", "replace"]) {
  test(`record-outcome-reporting distinguishes ambiguous ${mode} from publication success`, async (t) => {
    const f = await fixture(t);
    if (mode === "replace") await fs.writeFile(f.path, "abc");
    let attempted = false;
    const io: RecordFileSystem = { ...fs,
      async link(from, to) { await fs.link(from, to); if (to === f.path) { attempted = true; throw fault(); } },
      async rename(from, to) { await fs.rename(from, to); attempted = true; throw fault(); },
      async lstat(path) { if (attempted && path === f.path) throw fault(); return fs.lstat(path); },
    };
    const result = await (await f.call(mode, { fs: io })).publish();
    assert.equal(result.state, "unknown outcome");
    assert.equal(result.publication, "unknown");
    assert.equal(result.observedAfterHash, undefined, "intended bytes are not an observation");
    assert.equal(result.intendedHash, nextHash);
    assert.match(result.reason, /Pause dependent work.*inspect/);
    assert.equal(await fs.readFile(f.path, "utf8"), "next");
    assert.equal((await fs.lstat(f.path)).nlink, 1);
  });
}

for (const phase of ["file-sync", "folder-sync", "cleanup", "verification"] as const) {
  test(`record-outcome-reporting reports post-publication ${phase} as uncertain`, async (t) => {
    const f = await fixture(t);
    let published = false;
    const io: RecordFileSystem = { ...fs,
      async link(from, to) { await fs.link(from, to); published = true; },
      async open(path, flags, mode) {
        if (published && phase === "verification" && path === f.path) throw fault();
        const handle = await fs.open(path, flags, mode);
        if (published && (phase === "file-sync" && path === f.path || phase === "folder-sync" && path === f.dir)) handle.sync = async () => { throw fault(); };
        return handle;
      },
      async unlink(path) { if (published && phase === "cleanup") throw fault(); await fs.unlink(path); },
    };
    const write = await f.call("create", { fs: io });
    const result = await write.publish();
    assert.equal(result.state, "published with uncertain durability");
    assert.equal(result.publication, "returned");
    assert.match(result.reason, /Pause dependent work.*inspect/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE PAYLOAD/);
    assert.equal(result.observedAfterHash, phase === "verification" ? undefined : nextHash);
    assert.equal(await fs.readFile(f.path, "utf8"), "next");
    assert.equal((await fs.lstat(f.path)).nlink, phase === "cleanup" ? 2 : 1);
    if (phase === "cleanup") {
      assert.ok(result.artifacts.some((artifact) => artifact.path === write.temporaryPath));
      assert.equal(result.sync.cleanup, false);
      const remaining = await fs.readdir(f.dir);
      await failure(f.call("replace"), /hard links/, "refused before publication");
      await failure(f.call(), /extra hard links/, "refused before publication");
      assert.deepEqual(await fs.readdir(f.dir), remaining, "a later call never recovers the second name");
    }
  });
}

for (const phase of ["partial-copy", "private-sync", "version-sync", "versions-sync", "parent-sync", "collision"] as const) {
  test(`record-version-retention fault ${phase} preserves current bytes`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.path, "abc");
    const io: RecordFileSystem = { ...fs,
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode);
        if (path.startsWith(f.versions + "/") && flags & constants.O_CREAT) {
          if (phase === "partial-copy") handle.writeFile = async () => { await handle.write(Buffer.from("a")); throw fault(); };
          if (phase === "private-sync") handle.sync = async () => { throw fault(); };
        }
        if (phase === "version-sync" && path.startsWith(f.versions + "/status.md.v")) handle.sync = async () => { throw fault(); };
        if (phase === "versions-sync" && path === f.versions || phase === "parent-sync" && path === f.dir) handle.sync = async () => { throw fault(); };
        return handle;
      },
      async link(from, to) {
        if (phase === "collision") await fs.writeFile(to, "planted", { flag: "wx", mode: 0o600 });
        await fs.link(from, to);
      },
      async unlink(path) { if (phase === "partial-copy" && path.startsWith(f.versions + "/")) throw fault(); await fs.unlink(path); },
    };
    const result = await failure((await f.call("replace", { fs: io })).publish(), /cleanup failed|collision|version retention/,
      phase === "collision" ? "refused before publication" : "failed before publication");
    assert.equal(await fs.readFile(f.path, "utf8"), "abc");
    assert.equal(result.outcome!.publication, "not attempted");
    const entries = await fs.readdir(f.versions);
    if (phase === "partial-copy") {
      assert.equal(entries.length, 1);
      assert.match(entries[0]!, /^\.slate-record-.*\.tmp$/);
      assert.equal(await fs.readFile(join(f.versions, entries[0]!), "utf8"), "a");
      assert.equal((await fs.lstat(join(f.versions, entries[0]!))).mode & 0o777, 0o600);
      assert.ok(result.outcome!.artifacts.some((artifact) => !artifact.complete && /Incomplete version/.test(artifact.reason)));
    } else if (phase === "private-sync") assert.deepEqual(entries, []);
    else assert.equal(await fs.readFile(join(f.versions, entries[0]!), "utf8"), phase === "collision" ? "planted" : "abc");
  });
}

test("record-private-creation refuses broad version staging before copying bytes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "abc");
  let copied = false;
  const io = { ...fs, async open(path: string, flags: number, mode?: number) {
    const handle = await fs.open(path, flags, mode);
    if (path.startsWith(f.versions + "/") && flags & constants.O_CREAT) {
      await handle.chmod(0o644);
      handle.writeFile = async () => { copied = true; assert.fail("privacy check must precede version bytes"); };
    }
    return handle;
  } };
  await failure((await f.call("replace", { fs: io })).publish(), /version staging file is not private/, "refused before publication");
  assert.equal(copied, false);
  assert.equal(await fs.readFile(f.path, "utf8"), "abc");
  assert.deepEqual(await fs.readdir(f.versions), []);
});

test("record-abort-settlement checks abort before work and immediately before publication", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  let operations = 0;
  const io = new Proxy({} as RecordFileSystem, { get() { operations++; assert.fail("aborted work must not start"); } });
  const early = await failure(f.call("create", { signal: controller.signal, fs: io }), /aborted before work/, "refused before publication");
  assert.equal(operations, 0);
  assert.equal(early.outcome!.abortObserved, true);
  const late = new AbortController();
  const write = await f.call("create", { signal: late.signal, beforeFinalCheck: async () => late.abort() });
  const error = await failure(write.publish(), /aborted before publication/, "refused before publication");
  assert.equal(error.outcome!.abortObserved, true);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

for (const phase of ["publication", "settlement"] as const) {
  test(`record-abort-settlement awaits ${phase}, folder sync and concurrent cleanup`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const b = barrier();
    const events: string[] = [];
    let published = false;
    const io: RecordFileSystem = { ...fs,
      async link(from, to) { if (phase === "publication") await b.hold(); await fs.link(from, to); published = true; events.push("published"); },
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode);
        if (published && path === f.dir) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { if (phase === "settlement") await b.hold(); await sync(); events.push("folder-synced"); };
        }
        return handle;
      },
      async unlink(path) { await fs.unlink(path); events.push("cleaned"); },
    };
    const write = await f.call("create", { fs: io, signal: controller.signal });
    let reported = false;
    const pending = write.publish().then((result) => { reported = true; events.push("reported"); return result; });
    await b.ready;
    controller.abort();
    let cleaned = false;
    const cleanup = write.cleanup().then((result) => { cleaned = true; return result; });
    assert.equal(reported, false);
    assert.equal(cleaned, false);
    b.release();
    const result = await pending;
    assert.equal(result.state, "published and synced");
    assert.equal(result.abortObserved, true);
    assert.equal(result.observedAfterHash, nextHash);
    assert.deepEqual(await cleanup, {});
    assert.deepEqual(events, ["published", "cleaned", "folder-synced", "reported"]);
    assert.equal((await fs.lstat(f.path)).nlink, 1);
    assert.equal(await fs.readFile(f.path, "utf8"), "next");
  });
}

test("record-abort-settlement preserves uncertain state after an aborted folder sync failure", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let published = false;
  const io: RecordFileSystem = { ...fs,
    async link(from, to) { await fs.link(from, to); published = true; controller.abort(); },
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (published && path === f.dir) handle.sync = async () => { throw fault(); };
      return handle;
    },
  };
  const result = await (await f.call("create", { fs: io, signal: controller.signal })).publish();
  assert.equal(result.state, "published with uncertain durability");
  assert.equal(result.abortObserved, true);
  assert.equal(result.sync.folders, false);
  assert.equal(result.observedAfterHash, nextHash);
  assert.equal(await fs.readFile(f.path, "utf8"), "next");
  assert.equal((await fs.lstat(f.path)).nlink, 1);
});

for (const phase of ["version-directory-mode", "version-stat", "version-cleanup", "retained-permissions", "version-link"] as const) {
  test(`record-private-creation reports ${phase} faults without changing current bytes`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.path, "abc");
    const io: RecordFileSystem = { ...fs,
      async mkdir(path, options) { await fs.mkdir(path, options); if (phase === "version-directory-mode") await fs.chmod(path, 0o755); },
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode);
        if (phase === "version-stat" && path.startsWith(f.versions + "/") && flags & constants.O_CREAT) handle.stat = async () => { throw fault(); };
        if (phase === "retained-permissions" && path.startsWith(f.versions + "/status.md.v")) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { await sync(); await handle.chmod(0o644); };
        }
        return handle;
      },
      async link(from, to) { if (phase === "version-link") throw fault(); await fs.link(from, to); },
      async unlink(path) { if (phase === "version-cleanup" && path.startsWith(f.versions + "/")) throw fault(); await fs.unlink(path); },
    };
    const error = await failure((await f.call("replace", { fs: io })).publish(), /private|retention|cleanup failed|permissions/,
      ["version-directory-mode", "version-cleanup", "retained-permissions"].includes(phase) ? "refused before publication" : "failed before publication");
    assert.equal(await fs.readFile(f.path, "utf8"), "abc");
    assert.equal(error.outcome!.publication, "not attempted");
    if (phase === "version-stat") {
      const artifact = error.outcome!.artifacts.find((entry) => entry.kind === "temporary");
      assert.ok(artifact);
      assert.equal(artifact.complete, false);
      assert.match(artifact.reason, /identity is unknown/);
      assert.equal((await fs.lstat(artifact.path)).mode & 0o777, 0o600);
    }
    if (phase === "version-cleanup") {
      const artifacts = error.outcome!.artifacts;
      assert.ok(artifacts.some((entry) => entry.kind === "temporary"));
      assert.equal((await fs.lstat(artifacts.find((entry) => entry.kind === "version")!.path)).nlink, 2);
    }
  });
}

test("record-outcome-reporting classifies unsupported sync and preserves preparation evidence", async (t) => {
  const f = await fixture(t);
  const error = await failure(f.call("create", { fs: { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    if (flags & constants.O_CREAT) handle.sync = async () => { throw fault("ENOTSUP"); };
    return handle;
  } } }), /filesystem lacks.*Use a filesystem/, "refused before publication");
  assert.equal(error.outcome!.sync.candidate, false);
  assert.equal(error.outcome!.publication, "not attempted");
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test("record-abort-settlement cleans an abort observed after preparation without entering publication", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const write = await f.call("create", { signal: controller.signal });
  controller.abort();
  const error = await failure(write.publish(), /aborted before publication/, "refused before publication");
  assert.equal(error.outcome!.abortObserved, true);
  assert.equal(error.outcome!.sync.folders, true);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test("record-write-interleavings cleanup before publication closes the prepared write", async (t) => {
  const f = await fixture(t);
  const write = await f.call();
  assert.deepEqual(await write.cleanup(), {});
  await assert.rejects(write.publish(), (error: unknown) => {
    assert.ok(error instanceof RecordPrepublicationError);
    assert.equal(error.state, "refused before publication");
    assert.match(error.message, /already used/);
    return true;
  });
  assert.deepEqual(await fs.readdir(f.dir), []);
});
