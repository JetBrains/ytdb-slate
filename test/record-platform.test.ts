import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join, parse } from "node:path";
import { test, type TestContext } from "node:test";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { prepareRecordWrite, recordPlatformFacts, RecordPrepublicationError, type RecordPlatformProbe } from "../extension/record-write.ts";

const mounts = [
  "1 0 0:1 / /custom/windows rw - drvfs D: rw",
  "2 0 0:2 / /media/drive\\040D rw - 9p D: rw,aname=drvfs;path=D:\\;uid=1000",
  "3 0 0:3 / /vol/ntfs rw - ntfs3 /dev/test rw",
  "4 0 0:4 / /vol/old rw - ntfs /dev/test rw",
  "5 0 0:5 / /linux rw - ext4 /dev/test rw",
  "6 0 0:6 / /nine rw - 9p linux rw,aname=linux",
  "malformed",
].join("\n");
function probe(extra: Partial<RecordPlatformProbe> = {}): RecordPlatformProbe {
  return { platform: "linux", releaseText: "6.6-microsoft-standard-WSL2", environment: {},
    readMountInfo: async () => mounts, fileSystemType: async () => 0xef53, ...extra };
}
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "slate-record-platform-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = createChangeFolder();
  const dir = join(root, "slate-changes", current);
  await fs.mkdir(dir, { recursive: true });
  const context = { projectRoot: root, assignment: { currentFolder: `slate-changes/${current}`, writerRole: "record-only" as const, names: ["status.md"] } };
  return { root, dir, context };
}
const create = { record: "status.md", mode: "create", payload: "text" };

test("record-windows-drive-facts recognizes relocated and escaped mounts and Windows filesystem information", async () => {
  for (const [type, windows] of [[0x5346544e, true], [0x4d44, true], [0xef53, false], [0x65735546, false]] as const) {
    const facts = await recordPlatformFacts("/destination", probe({ fileSystemType: async (path) => { assert.equal(path, "/destination"); return type; } }));
    assert.deepEqual(facts.windowsMounts, ["/custom/windows", "/media/drive D", "/vol/ntfs", "/vol/old"]);
    assert.equal(facts.windowsFileSystem, windows);
    assert.equal(facts.wsl, true);
  }
});

test("record-default-platform-probe detects release and environment signals and skips non-WSL systems", async () => {
  for (const inputs of [
    { releaseText: "6.6-Microsoft", environment: {} },
    { releaseText: "linux", environment: { WSL_INTEROP: "/run/WSL/1_interop" } },
    { releaseText: "linux", environment: { WSL_DISTRO_NAME: "Ubuntu" } },
  ]) {
    const facts = await recordPlatformFacts("/destination", probe(inputs));
    assert.equal(facts.wsl, true);
    assert.equal(facts.windowsMounts.length, 4);
  }
  for (const platform of ["linux", "darwin", "win32"]) {
    const facts = await recordPlatformFacts("/destination", probe({ platform, releaseText: "linux", environment: {},
      readMountInfo: async () => { assert.fail("not WSL"); }, fileSystemType: async () => { assert.fail("not WSL"); } }));
    assert.deepEqual(facts, { platform, wsl: false, windowsMounts: [], windowsFileSystem: false });
  }
  assert.equal((await recordPlatformFacts("/destination", probe({ platform: "darwin" }))).wsl, false);
});

test("record-preparation uses the default probe without a platformFacts override", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  let changes = 0;
  await assert.rejects(prepareRecordWrite(f.context, create, { platform: "linux", platformProbe: probe({
    readMountInfo: async () => { calls.push("mounts"); return `1 0 0:1 / ${parse(f.root).root} rw - 9p C: rw,aname=drvfs;path=C:\\;uid=1000`; },
    fileSystemType: async (path) => { assert.equal(path, f.dir); calls.push("filesystem"); return 0x01021997; },
  }), fs: { ...fs, async open() { changes++; assert.fail("staging must not start"); }, async unlink() { changes++; assert.fail("cleanup must not start"); } } }), (error: unknown) => {
    assert.ok(error instanceof RecordPrepublicationError);
    assert.equal(error.state, "refused before publication");
    assert.match(error.message, /Windows drive.*Windows Subsystem for Linux \(WSL\).*own Linux filesystem/);
    return true;
  });
  assert.deepEqual(calls, ["mounts", "filesystem"]);
  assert.equal(changes, 0);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test("record-production-default probe reads host release and WSL environment before any change", async (t) => {
  const f = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const environment = { WSL_INTEROP: process.env.WSL_INTEROP, WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME };
  const calls: string[] = [];
  const changes: string[] = [];
  let releaseText = "linux";
  const io = { ...fs,
    async open() { changes.push("open"); assert.fail("staging must not start"); },
    async unlink() { changes.push("unlink"); assert.fail("cleanup must not start"); },
    async link() { changes.push("link"); assert.fail("publication must not start"); },
    async rename() { changes.push("rename"); assert.fail("publication must not start"); },
  };
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    t.mock.method(os, "release", () => releaseText);
    t.mock.method(fsPromises, "readFile", async (path: unknown) => {
      assert.equal(path, "/proc/self/mountinfo");
      calls.push("mounts");
      return "1 0 0:1 / / rw - 9p C: rw,aname=drvfs;path=C:\\;uid=1000";
    });
    t.mock.method(fsPromises, "statfs", async (path: unknown) => {
      assert.equal(path, f.dir);
      calls.push("filesystem");
      return { type: 0xef53 };
    });
    syncBuiltinESMExports();
    for (const signal of ["release", "WSL_INTEROP", "WSL_DISTRO_NAME"] as const) {
      delete process.env.WSL_INTEROP;
      delete process.env.WSL_DISTRO_NAME;
      releaseText = signal === "release" ? "6.6-Microsoft-standard-WSL2" : "linux";
      if (signal !== "release") process.env[signal] = "host-signal";
      calls.length = 0;
      // No platformFacts or platformProbe override enters this call.
      await assert.rejects(prepareRecordWrite(f.context, create, { fs: io }), (error: unknown) => {
        assert.ok(error instanceof RecordPrepublicationError);
        assert.equal(error.state, "refused before publication");
        assert.match(error.message, /Windows drive.*Windows Subsystem for Linux \(WSL\).*own Linux filesystem/);
        return true;
      });
      assert.deepEqual(calls, ["mounts", "filesystem"], signal);
      assert.deepEqual(changes, [], signal);
      assert.deepEqual(await fs.readdir(f.dir), []);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    for (const key of ["WSL_INTEROP", "WSL_DISTRO_NAME"] as const) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
  }
});

test("record-windows-drive-refusal checks root mounts, boundaries and filesystem facts before any change", async (t) => {
  const f = await fixture(t);
  for (const facts of [
    { platform: "linux", wsl: true, windowsMounts: [parse(f.root).root], windowsFileSystem: false },
    { platform: "linux", wsl: true, windowsMounts: [f.root], windowsFileSystem: false },
    { platform: "linux", wsl: true, windowsMounts: [f.dir], windowsFileSystem: false },
    { platform: "linux", wsl: true, windowsMounts: [], windowsFileSystem: true },
  ]) {
    let changes = 0;
    await assert.rejects(prepareRecordWrite(f.context, create, {
      platform: "linux", platformFacts: async () => facts,
      fs: { ...fs, async open() { changes++; assert.fail("staging must not start"); }, async unlink() { changes++; assert.fail("cleanup must not start"); } },
    }), (error: unknown) => {
      assert.ok(error instanceof RecordPrepublicationError);
      assert.equal(error.state, "refused before publication");
      assert.match(error.message, /Windows drive.*Windows Subsystem for Linux \(WSL\).*Move.*WSL on its own Linux filesystem/);
      return true;
    });
    assert.equal(changes, 0);
    assert.deepEqual(await fs.readdir(f.dir), []);
  }
  // These controls represent Linux destinations and the detection limit, not Windows support.
  const prefix = f.root.slice(0, -1);
  assert.ok(f.dir.startsWith(prefix));
  for (const facts of [
    { platform: "linux", wsl: true, windowsMounts: [prefix], windowsFileSystem: false },
    { platform: "linux", wsl: true, windowsMounts: [], windowsFileSystem: false },
    { platform: "darwin", wsl: false, windowsMounts: [], windowsFileSystem: false },
  ]) {
    const write = await prepareRecordWrite(f.context, create, { platform: facts.platform, platformFacts: async () => facts });
    assert.equal(await fs.readFile(write.temporaryPath, "utf8"), "text");
    assert.deepEqual(await write.cleanup(), {});
    assert.deepEqual(await fs.readdir(f.dir), []);
  }
});
