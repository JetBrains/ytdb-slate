import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { readOnlyEarlierLogLine } from "../extension/record-names.ts";
import { cleanupRecordTemporary, prepareRecordWrite, recordHash, RecordPrepublicationError, RECORD_PAYLOAD_MAX,
  type RecordFileSystem, type RecordWriteArguments, type RecordWriteContext, type RecordWriteOptions } from "../extension/record-write.ts";

const name = "track-2.2-implementer-report.md";
const tempName = `.slate-record-${"a".repeat(32)}.tmp`;
const independentHash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function observeChanges(base: RecordFileSystem = fs) {
  const changes: string[] = [];
  const io: RecordFileSystem = { ...base,
    async open(path, flags, mode) {
      const handle = await base.open(path, flags, mode);
      if (flags & constants.O_CREAT) {
        changes.push("create");
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...args) => { changes.push("write"); return write(...args); };
      }
      return handle;
    },
    async link(from, to) { changes.push("link"); await base.link(from, to); },
    async rename(from, to) { changes.push("rename"); await base.rename(from, to); },
    async unlink(path) { changes.push("unlink"); await base.unlink(path); },
  };
  return { io, changes };
}
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "slate-record-core-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = createChangeFolder();
  const parent = join(root, "slate-changes");
  const dir = join(parent, current);
  await fs.mkdir(dir, { recursive: true });
  const context: RecordWriteContext = { projectRoot: root, assignment: { currentFolder: `slate-changes/${current}`, writerRole: "implementer", names: [name] } };
  const options: RecordWriteOptions = { platform: process.platform, temporaryName: () => tempName,
    platformFacts: async () => ({ platform: process.platform, wsl: false, windowsMounts: [], windowsFileSystem: false }) };
  const path = join(dir, name);
  const call = (args: RecordWriteArguments, extra: RecordWriteOptions = {}) => prepareRecordWrite(context, args, { ...options, ...extra });
  return { root, current, parent, dir, context, options, path, call };
}
const create = { record: name, mode: "create", payload: "first\r\n😀\n" };
async function refused(action: Promise<unknown>, reason: RegExp, state = "refused before publication") {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof RecordPrepublicationError);
    assert.equal(error.state, state);
    assert.match(error.message, reason);
    assert.ok(error.message.length > 0);
    assert.doesNotMatch(error.message, /;|\b(?:can't|don't|isn't|won't)\b/i);
    return true;
  });
}

test("record-private-creation publishes through a hard link and removes only its matching temporary name", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const write = await f.call(create, { fs: { ...fs, async link(from, to) { calls.push("link"); await fs.link(from, to); }, async rename() { assert.fail("create must not rename"); } } });
  const staged = await fs.lstat(write.temporaryPath);
  assert.equal(staged.mode & 0o777, 0o600);
  assert.equal(staged.nlink, 1);
  assert.deepEqual(await fs.readFile(write.temporaryPath), Buffer.from(create.payload));
  await assert.rejects(fs.lstat(f.path), { code: "ENOENT" });
  const outcome = await write.publish();
  assert.equal(outcome.state, "published and synced");
  assert.equal(outcome.observedAfterHash, independentHash(Buffer.from(create.payload)));
  assert.deepEqual(calls, ["link"]);
  const published = await fs.lstat(f.path);
  assert.equal(published.ino, staged.ino);
  assert.equal(published.dev, staged.dev);
  assert.equal(published.nlink, 1);
  assert.equal(published.mode & 0o777, 0o600);
  assert.deepEqual(await write.cleanup(), {});
  assert.equal((await fs.lstat(f.path)).nlink, 1);
  assert.deepEqual(await fs.readFile(f.path), Buffer.from(create.payload));
  assert.deepEqual(await fs.readdir(f.dir), [name]);
  await refused(write.publish(), /already used/);
});

test("record-append-preservation keeps binary prefixes, repeated and empty additions, and large existing records", async (t) => {
  const f = await fixture(t);
  let bytes = Buffer.concat([Buffer.from([0, 255, 128, 13, 10]), Buffer.alloc(RECORD_PAYLOAD_MAX + 1, 65)]);
  await fs.writeFile(f.path, bytes, { mode: 0o644 });
  for (const payload of ["second\r\n😀", "", "third\n", "é".repeat(RECORD_PAYLOAD_MAX / 2)]) {
    const old = await fs.lstat(f.path);
    const write = await f.call({ record: name, mode: "append", payload, expectedHash: independentHash(bytes) });
    assert.equal((await fs.lstat(f.path)).mode & 0o777, old.mode & 0o777, "reading must not change manual permissions");
    await write.publish();
    assert.deepEqual(await write.cleanup(), {});
    const candidate = Buffer.concat([bytes, Buffer.from(payload)]);
    assert.deepEqual(await fs.readFile(f.path), candidate);
    assert.deepEqual(candidate.subarray(0, bytes.length), bytes);
    const fresh = await fs.lstat(f.path);
    assert.notEqual(fresh.ino, old.ino);
    assert.equal(fresh.nlink, 1);
    assert.equal(fresh.mode & 0o777, 0o600);
    bytes = candidate;
  }
  assert.deepEqual(await fs.readdir(f.dir), [name]);
});

test("record-hash-known-answer and append use an independent SHA-256 digest", async (t) => {
  const f = await fixture(t);
  const hash = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(recordHash(Buffer.from("abc")), hash);
  await fs.writeFile(f.path, "abc");
  const write = await f.call({ record: name, mode: "append", payload: "def", expectedHash: hash });
  assert.equal(write.candidateHash, independentHash(Buffer.from("abcdef")));
  await write.publish();
  assert.deepEqual(await write.cleanup(), {});
  assert.equal(await fs.readFile(f.path, "utf8"), "abcdef");
  assert.equal((await fs.lstat(f.path)).nlink, 1);
  assert.deepEqual(await fs.readdir(f.dir), [name]);
});

test("record-stale-update refuses wrong hashes and leaves earlier bytes and names unchanged", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "earlier");
  await refused(f.call({ record: name, mode: "append", payload: "extra", expectedHash: recordHash(Buffer.from("other")) }), /stale.*fresh hash/);
  assert.equal(await fs.readFile(f.path, "utf8"), "earlier");
  assert.deepEqual(await fs.readdir(f.dir), [name]);
});

test("record-name-ownership and argument checks refuse before changes", async (t) => {
  const f = await fixture(t);
  const cases: [RecordWriteArguments, RegExp][] = [
    [{ ...create, record: "../outside" }, /not assigned/], [{ ...create, record: "status.md" }, /not assigned/],
    [{ ...create, record: "track-01-implementer-report.md" }, /not assigned/],
    [{ ...create, mode: "replace" }, /mode/], [{ ...create, mode: "other" }, /mode/],
    [{ ...create, expectedHash: recordHash(Buffer.from("")) }, /expected hash/],
    [{ ...create, mode: "append" }, /expected hash/], [{ ...create, mode: "append", expectedHash: "SHA256:" + "a".repeat(64) }, /expected hash/],
    [{ ...create, mode: "append", expectedHash: "sha256:" + "a".repeat(64) + "\n" }, /expected hash/],
    [{ ...create, payload: "\ud800" }, /Unicode/], [{ ...create, payload: 7 }, /Unicode/],
    [{ ...create, payload: "a".repeat(RECORD_PAYLOAD_MAX + 1) }, /exceeds/],
  ];
  for (const [args, reason] of cases) await refused(f.call(args), reason);
  const original = f.context.assignment;
  for (const assignment of [
    { ...original, writerRole: "record-only" as const }, { ...original, currentFolder: "slate-changes/../escape" },
    { ...original, names: [] }, { ...original, currentFolder: "slate-changes/invalid" },
  ]) { f.context.assignment = assignment; await refused(f.call(create), /assigned|folder/); }
  f.context.assignment = original;
  for (const sourceFolder of [f.current, "invalid"]) { f.context.sourceFolder = sourceFolder; await refused(f.call(create), /source conflicts/); }
  delete f.context.sourceFolder;
  await refused(f.call(create, { temporaryName: () => "../escape" }), /temporary name/);
  assert.deepEqual(await fs.readdir(f.dir), []);
  f.context.assignment = { currentFolder: original.currentFolder, writerRole: "record-only", names: ["research-log.md", "status.md", "root-design.md", "track-2-design.md", "track-2-research-log.md"] };
  await refused(f.call({ ...create, record: "research-log.md" }), /mode/);
  await refused(f.call({ ...create, record: "status.md", mode: "append", expectedHash: recordHash(Buffer.from("")) }), /mode/);
  for (const record of ["status.md", "root-design.md", "track-2-design.md", "track-2-research-log.md"]) {
    const write = await f.call({ ...create, record }); await write.publish(); await write.cleanup();
    assert.equal((await fs.lstat(join(f.dir, record))).mode & 0o777, 0o600);
  }
});

test("record-path-protection refuses linked records, planted temporary names, and non-regular records", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await fs.writeFile(outside, "keep");
  for (const kind of ["symlink", "hardlink", "directory"] as const) {
    if (kind === "symlink") await fs.symlink(outside, f.path);
    else if (kind === "hardlink") await fs.link(outside, f.path);
    else await fs.mkdir(f.path);
    await refused(f.call({ ...create, mode: "append", expectedHash: recordHash(Buffer.from("keep")) }), /regular file|extra hard links/);
    await refused(f.call(create), /already exists/);
    assert.equal(await fs.readFile(outside, "utf8"), "keep");
    await fs.rm(f.path, { recursive: true });
  }
  const temp = join(f.dir, tempName);
  for (const kind of ["symlink", "file", "directory"] as const) {
    if (kind === "symlink") await fs.symlink(outside, temp);
    else if (kind === "file") await fs.writeFile(temp, "planted");
    else await fs.mkdir(temp);
    await refused(f.call(create), /private staging/, "failed before publication");
    assert.equal(await fs.readFile(outside, "utf8"), "keep");
    assert.equal((await fs.lstat(temp)).isSymbolicLink(), kind === "symlink");
    if (kind === "file") assert.equal(await fs.readFile(temp, "utf8"), "planted");
    await fs.rm(temp, { recursive: true });
  }
  await refused(f.call({ ...create, mode: "append", expectedHash: recordHash(Buffer.from("")) }), /record read/, "failed before publication");
  assert.deepEqual(await fs.readdir(f.dir), []);
});

for (const component of ["slate-changes", "current"] as const) {
  test(`record-path-protection refuses a symbolic link or missing directory at ${component}`, async (t) => {
    const f = await fixture(t);
    const path = component === "current" ? f.dir : f.parent;
    const backup = path + "-held";
    await fs.rename(path, backup);
    await fs.symlink(backup, path);
    await refused(f.call(create), /real directory/);
    assert.deepEqual(await fs.readdir(component === "current" ? backup : join(backup, f.current)), []);
    await fs.unlink(path);
    await refused(f.call(create), /folder checks/, "failed before publication");
    await fs.rename(backup, path);
  });
}

test("record-read-only-source skips missing sibling logs and refuses matches and every other sibling read error", async (t) => {
  const f = await fixture(t);
  const sibling = createChangeFolder();
  const siblingDir = join(f.parent, sibling);
  const log = join(siblingDir, "research-log.md");
  await fs.mkdir(siblingDir);
  let write = await f.call(create); await write.cleanup();
  await fs.writeFile(log, readOnlyEarlierLogLine(f.current) + "\nremaining");
  const markerObserver = observeChanges();
  await refused(f.call(create, { fs: markerObserver.io }), new RegExp(`${sibling}.*read-only`));
  assert.deepEqual(markerObserver.changes, []);
  assert.deepEqual(await fs.readdir(f.dir), []);
  for (const first of [readOnlyEarlierLogLine(f.current) + "\r", " " + readOnlyEarlierLogLine(f.current), "# unrelated"]) {
    await fs.writeFile(log, first + "\n" + readOnlyEarlierLogLine(f.current));
    write = await f.call(create); await write.cleanup();
  }
  await fs.writeFile(join(f.dir, "research-log.md"), readOnlyEarlierLogLine(f.current));
  write = await f.call(create); await write.cleanup();
  const errorObserver = observeChanges({ ...fs, async lstat(path) { if (path === log) throw Object.assign(new Error("denied"), { code: "EACCES" }); return fs.lstat(path); } });
  await refused(f.call(create, { fs: errorObserver.io }), new RegExp(`sibling folder ${sibling}.*Inspect`));
  assert.deepEqual(errorObserver.changes, []);
  await fs.unlink(log);
  await fs.symlink(join(f.dir, "research-log.md"), log);
  await refused(f.call(create), new RegExp(`sibling folder ${sibling}`));
  assert.deepEqual(await fs.readdir(f.dir), ["research-log.md"]);
});

test("record-sibling-read-error refuses before any mutating operation", async (t) => {
  const f = await fixture(t);
  const sibling = createChangeFolder();
  const dir = join(f.parent, sibling);
  const log = join(dir, "research-log.md");
  await fs.mkdir(dir);
  await fs.writeFile(log, "# unrelated");
  const observed = observeChanges({ ...fs, async lstat(path) {
    if (path === log) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.lstat(path);
  } });
  await refused(f.call(create, { fs: observed.io }), new RegExp(`sibling folder ${sibling}.*Inspect`));
  assert.deepEqual(observed.changes, []);
  assert.deepEqual(await fs.readdir(f.dir), []);
  assert.equal(await fs.readFile(log, "utf8"), "# unrelated");
});

test("record-sibling-shape skips unrelated files and folders without reading their contents", async (t) => {
  const f = await fixture(t);
  const stray = join(f.parent, ".DS_Store");
  for (const kind of ["file", "folder"]) {
    if (kind === "file") await fs.writeFile(stray, "outside change grammar");
    else await fs.mkdir(stray);
    const write = await f.call(create);
    assert.equal(await fs.readFile(write.temporaryPath, "utf8"), create.payload);
    assert.deepEqual(await write.cleanup(), {});
    assert.deepEqual(await fs.readdir(f.dir), []);
    if (kind === "file") assert.equal(await fs.readFile(stray, "utf8"), "outside change grammar");
    else assert.deepEqual(await fs.readdir(stray), []);
    await fs.rm(stray, { recursive: true });
  }
});

test("record-sibling-identity refuses a folder replacement after reading its log", async (t) => {
  const f = await fixture(t);
  const sibling = createChangeFolder();
  const dir = join(f.parent, sibling);
  const log = join(dir, "research-log.md");
  await fs.mkdir(dir);
  await fs.writeFile(log, "# unrelated");
  const observed = observeChanges({ ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    if (path === log) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        await fs.rename(dir, dir + "-held");
        await fs.mkdir(dir);
        await fs.writeFile(log, "# unrelated");
      };
    }
    return handle;
  } });
  await refused(f.call(create, { fs: observed.io }), new RegExp(`sibling folder ${sibling}.*Inspect`));
  assert.deepEqual(observed.changes, []);
  assert.deepEqual(await fs.readdir(f.dir), []);
  assert.equal(await fs.readFile(log, "utf8"), "# unrelated");
  assert.equal(await fs.readFile(join(dir + "-held", "research-log.md"), "utf8"), "# unrelated");
});

test("record-pre-staging-recheck refuses a folder replaced after the initial checks", async (t) => {
  const f = await fixture(t);
  let swapped = false;
  const observed = observeChanges({ ...fs, async lstat(path) {
    try { return await fs.lstat(path); } catch (error) {
      if (path === f.path && !swapped) {
        swapped = true;
        await fs.rename(f.dir, f.dir + "-held");
        await fs.mkdir(f.dir);
      }
      throw error;
    }
  } });
  await refused(f.call(create, { fs: observed.io }), /folder changed identity.*Inspect/);
  assert.equal(swapped, true);
  assert.deepEqual(observed.changes, []);
  assert.deepEqual(await fs.readdir(f.dir), []);
  assert.deepEqual(await fs.readdir(f.dir + "-held"), []);
});

for (const phase of ["initial record", "final candidate", "final record"] as const) {
  test(`record-read-close preserves the primary refusal during ${phase}`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.path, "earlier");
    let final = false;
    let faults = 0;
    const io: RecordFileSystem = { ...fs, async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      const target = phase === "final candidate" ? join(f.dir, tempName) : f.path;
      if (path === target && !(flags & constants.O_CREAT) && (phase === "initial record" || final)) {
        const stat = handle.stat.bind(handle);
        handle.stat = async () => {
          const bad = Object.create(await stat());
          bad.nlink = 2;
          return bad;
        };
        const close = handle.close.bind(handle);
        handle.close = async () => { faults++; await close(); throw new Error("secondary close fault"); };
      }
      return handle;
    } };
    const args = { ...create, mode: "append", expectedHash: independentHash(Buffer.from("earlier")) };
    const pending = phase === "initial record" ? f.call(args, { fs: io }) : (await f.call(args, { fs: io, beforeFinalCheck: async () => { final = true; } })).publish();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof RecordPrepublicationError);
      assert.equal(error.state, "refused before publication");
      assert.match(error.message, /record changed identity.*Read the safe current record/);
      assert.deepEqual(error.secondaryFailures, ["The record read handle did not close. Inspect open handles before retrying."]);
      assert.deepEqual(error.cleanup, {});
      return true;
    });
    assert.equal(faults, 1);
    assert.equal(await fs.readFile(f.path, "utf8"), "earlier");
    assert.equal((await fs.lstat(f.path)).nlink, 1);
    assert.deepEqual(await fs.readdir(f.dir), [name]);
  });
}

test("record-staging-close reports a secondary failure without hiding the write failure", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call(create, { fs: { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    if (flags & constants.O_CREAT) {
      handle.writeFile = async () => { throw new Error("write fault"); };
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw new Error("close fault"); };
    }
    return handle;
  } } }), (error: unknown) => {
    assert.ok(error instanceof RecordPrepublicationError);
    assert.equal(error.state, "failed before publication");
    assert.match(error.message, /private staging.*Inspect/);
    assert.deepEqual(error.secondaryFailures, ["The staging handle did not close. Inspect open handles before retrying."]);
    assert.deepEqual(error.cleanup, {});
    return true;
  });
  assert.deepEqual(await fs.readdir(f.dir), []);
});

for (const change of ["bytes", "identity", "folder", "temporary-bytes", "temporary-identity", "temporary-mode", "temporary-link"] as const) {
  test(`record-write-interleavings refuses ${change} changes before the final check`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.path, "earlier");
    let enter!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { enter = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const write = await f.call({ ...create, mode: "append", expectedHash: recordHash(Buffer.from("earlier")) }, { beforeFinalCheck: async () => { enter(); await barrier; } });
    const pending = write.publish();
    await reached;
    const heldPath = write.temporaryPath + "-held";
    if (change === "bytes") await fs.writeFile(f.path, "changed");
    if (change === "identity") { await fs.rename(f.path, f.path + "-held"); await fs.writeFile(f.path, "earlier"); }
    if (change === "folder") { await fs.rename(f.dir, f.dir + "-held"); await fs.mkdir(f.dir); }
    if (change === "temporary-bytes") await fs.writeFile(write.temporaryPath, "changed");
    if (change === "temporary-identity") { await fs.rename(write.temporaryPath, heldPath); await fs.writeFile(write.temporaryPath, await fs.readFile(heldPath), { mode: 0o600 }); }
    if (change === "temporary-mode") await fs.chmod(write.temporaryPath, 0o644);
    if (change === "temporary-link") await fs.link(write.temporaryPath, heldPath);
    release();
    await refused(pending, /changed|links|regular/);
    if (change === "folder") assert.deepEqual(await fs.readdir(f.dir), []);
    else assert.equal(await fs.readFile(f.path, "utf8"), change === "bytes" ? "changed" : "earlier");
    if (change === "temporary-identity") assert.equal(await fs.readFile(write.temporaryPath, "utf8"), "earlier" + create.payload);
  });
}

test("record-temporary-cleanup leaves different files and symbolic links untouched and reports failures", async (t) => {
  const f = await fixture(t);
  const write = await f.call(create);
  const identity = await fs.lstat(write.temporaryPath);
  const heldPath = write.temporaryPath + "-held";
  await fs.rename(write.temporaryPath, heldPath);
  await fs.writeFile(write.temporaryPath, "different");
  assert.match((await write.cleanup()).reason!, /different file.*Leave it untouched/);
  assert.equal(await fs.readFile(write.temporaryPath, "utf8"), "different");
  await fs.unlink(write.temporaryPath);
  await fs.symlink(heldPath, write.temporaryPath);
  assert.match((await write.cleanup()).reason!, /different file/);
  assert.equal((await fs.lstat(write.temporaryPath)).isSymbolicLink(), true);
  await fs.unlink(write.temporaryPath);
  assert.deepEqual(await write.cleanup(), {});
  await fs.rename(heldPath, write.temporaryPath);
  const failure = await cleanupRecordTemporary({ ...fs, async unlink() { throw new Error("denied"); } }, write.temporaryPath, identity);
  assert.equal(failure.leftover, write.temporaryPath);
  assert.match(failure.reason!, /cleanup failed.*Inspect/);
  assert.equal((await fs.lstat(write.temporaryPath)).ino, identity.ino);
  assert.deepEqual(await write.cleanup(), {});
});

test("record-private-protection refuses broad staging permissions before writing payload bytes", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  await refused(f.call(create, { fs: { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    if (flags & constants.O_CREAT) {
      await handle.chmod(0o644);
      handle.writeFile = async () => { writes++; assert.fail("private protection must precede payload bytes"); };
    }
    return handle;
  } } }), /private regular candidate.*Use a filesystem/);
  assert.equal(writes, 0);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test("record-prepublication-failures preserve original bytes and keep the primary error when cleanup fails", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "earlier");
  const io: RecordFileSystem = { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    if (flags & constants.O_CREAT) handle.writeFile = async () => { throw new Error("private payload must not be echoed"); };
    return handle;
  }, async unlink() { throw new Error("cleanup denied"); } };
  await assert.rejects(f.call({ ...create, mode: "append", expectedHash: recordHash(Buffer.from("earlier")) }, { fs: io }), (error: unknown) => {
    assert.ok(error instanceof RecordPrepublicationError);
    assert.equal(error.state, "failed before publication");
    assert.match(error.message, /private staging.*Inspect/);
    assert.equal(error.message.includes("private payload"), false);
    assert.equal(error.cleanup.leftover, join(f.dir, tempName));
    assert.match(error.cleanup.reason!, /cleanup failed/);
    return true;
  });
  assert.deepEqual((await fs.readdir(f.dir)).sort(), [name, tempName].sort());
  assert.equal(await fs.readFile(f.path, "utf8"), "earlier");
  assert.equal((await fs.lstat(join(f.dir, tempName))).mode & 0o777, 0o600);
});

test("record-exclusive-publication refuses an EEXIST race without overwriting the competing file", async (t) => {
  const f = await fixture(t);
  const write = await f.call(create, { fs: { ...fs, async link(from, to) { await fs.writeFile(to, "competitor", { flag: "wx" }); await fs.link(from, to); } } });
  await refused(write.publish(), /already exists/);
  assert.equal(await fs.readFile(f.path, "utf8"), "competitor");
  assert.deepEqual(await fs.readdir(f.dir), [name]);
});

test("record-open-identity refuses a replacement between path metadata and open", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.path, "earlier");
  await refused(f.call({ ...create, mode: "append", expectedHash: recordHash(Buffer.from("earlier")) }, { fs: { ...fs, async open(path, flags, mode) {
    if (path === f.path) { await fs.rename(path, path + "-held"); await fs.writeFile(path, "earlier"); }
    return fs.open(path, flags, mode);
  } } }), /changed identity/);
  assert.equal(await fs.readFile(f.path, "utf8"), "earlier");
  assert.deepEqual((await fs.readdir(f.dir)).sort(), [name, name + "-held"].sort());
});

test("record-final-check refuses a newly read-only folder or a competing final name", async (t) => {
  const f = await fixture(t);
  let write = await f.call(create, { beforeFinalCheck: async () => { await fs.writeFile(f.path, "competitor"); } });
  await refused(write.publish(), /name appeared/);
  assert.equal(await fs.readFile(f.path, "utf8"), "competitor");
  await fs.unlink(f.path);
  const sibling = createChangeFolder();
  write = await f.call(create, { beforeFinalCheck: async () => {
    await fs.mkdir(join(f.parent, sibling));
    await fs.writeFile(join(f.parent, sibling, "research-log.md"), readOnlyEarlierLogLine(f.current));
  } });
  await refused(write.publish(), new RegExp(`${sibling}.*read-only`));
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test("record-final-failure and ambiguous publication stay distinct", async (t) => {
  const f = await fixture(t);
  let write = await f.call(create, { beforeFinalCheck: async () => { throw new Error("fault"); } });
  await refused(write.publish(), /final safety check.*Inspect/, "failed before publication");
  assert.deepEqual(await fs.readdir(f.dir), []);
  const fault = new Error("ambiguous publication requires settlement");
  write = await f.call(create, { fs: { ...fs, async link(from, to) { await fs.link(from, to); throw fault; } } });
  const result = await write.publish();
  assert.equal(result.state, "published with uncertain durability");
  assert.equal(result.publication, "observed");
  assert.match(result.reason, /Pause dependent work.*inspect/);
  assert.equal(await fs.readFile(f.path, "utf8"), create.payload);
  assert.equal((await fs.lstat(f.path)).nlink, 1);
  await write.cleanup();
});
