import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { prepareRecordWrite, recordPlatformFacts, RecordPrepublicationError } from "../extension/record-write.ts";

test("record-windows-drive-facts recognizes relocated and escaped mounts and Windows filesystem information", async () => {
  const mounts = [
    "1 0 0:1 / /custom/windows rw - drvfs D: rw",
    "2 0 0:2 / /media/drive\\040D rw - 9p D: rw,aname=drvfs;path=D:\\;uid=1000",
    "3 0 0:3 / /vol/ntfs rw - ntfs3 /dev/test rw",
    "4 0 0:4 / /vol/old rw - ntfs /dev/test rw",
    "5 0 0:5 / /linux rw - ext4 /dev/test rw",
    "6 0 0:6 / /nine rw - 9p linux rw,aname=linux",
    "malformed",
  ].join("\n");
  for (const [type, windows] of [[0x5346544e, true], [0x4d44, true], [0xef53, false], [0x65735546, false]] as const) {
    const facts = await recordPlatformFacts("/destination", { platform: "linux", wsl: true,
      readMountInfo: async () => mounts, fileSystemType: async (path) => { assert.equal(path, "/destination"); return type; } });
    assert.deepEqual(facts.windowsMounts, ["/custom/windows", "/media/drive D", "/vol/ntfs", "/vol/old"]);
    assert.equal(facts.windowsFileSystem, windows);
    assert.equal(facts.wsl, true);
  }
  for (const platform of ["linux", "darwin", "win32"]) {
    const facts = await recordPlatformFacts("/destination", { platform, wsl: false,
      readMountInfo: async () => { assert.fail("not WSL"); }, fileSystemType: async () => { assert.fail("not WSL"); } });
    assert.deepEqual(facts, { platform, wsl: false, windowsMounts: [], windowsFileSystem: false });
  }
});

test("record-windows-drive-refusal checks mount boundaries and filesystem facts before any change", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "slate-record-platform-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = createChangeFolder();
  const dir = join(root, "slate-changes", current);
  await fs.mkdir(dir, { recursive: true });
  const context = { projectRoot: root, assignment: { currentFolder: `slate-changes/${current}`, writerRole: "record-only" as const, names: ["status.md"] } };
  for (const facts of [
    { platform: "linux", wsl: true, windowsMounts: [root], windowsFileSystem: false },
    { platform: "linux", wsl: true, windowsMounts: [dir], windowsFileSystem: false },
    { platform: "linux", wsl: true, windowsMounts: [], windowsFileSystem: true },
  ]) {
    let changes = 0;
    await assert.rejects(prepareRecordWrite(context, { record: "status.md", mode: "create", payload: "text" }, {
      platform: "linux", platformFacts: async () => facts,
      fs: { ...fs, async open() { changes++; assert.fail("staging must not start"); }, async unlink() { changes++; assert.fail("cleanup must not start"); } },
    }), (error: unknown) => {
      assert.ok(error instanceof RecordPrepublicationError);
      assert.equal(error.state, "refused before publication");
      assert.match(error.message, /Windows drive inside WSL.*Move.*WSL on its own Linux filesystem/);
      return true;
    });
    assert.equal(changes, 0);
    assert.deepEqual(await fs.readdir(dir), []);
  }
  // These controls represent Linux destinations and the documented detection limit, not Windows support.
  for (const facts of [
    { platform: "linux", wsl: true, windowsMounts: [root + "-other"], windowsFileSystem: false },
    { platform: "linux", wsl: true, windowsMounts: [], windowsFileSystem: false },
    { platform: "darwin", wsl: false, windowsMounts: [], windowsFileSystem: false },
  ]) {
    const write = await prepareRecordWrite(context, { record: "status.md", mode: "create", payload: "text" }, { platform: facts.platform, platformFacts: async () => facts });
    await write.cleanup();
    assert.deepEqual(await fs.readdir(dir), []);
  }
});
