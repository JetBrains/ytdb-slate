// record-tool-test: windows
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordGuardBlocks, resolveRecordGuardPath, type RecordGuardFacts } from "../extension/record-guard.ts";

function facts() {
  const protectedNames = new Map([
    ["c:\\repo\\slate-changes", { dev: 7, ino: 20 }],
    ["c:\\repo\\slate-changes\\change", { dev: 7, ino: 21 }],
    ["c:\\repo", { dev: 7, ino: 10 }], ["c:\\", { dev: 7, ino: 1 }],
    ["c:\\repo\\slate-changes-other", { dev: 7, ino: 30 }],
    ["\\\\server\\share\\records", { dev: 7, ino: 21 }],
    ["\\\\server\\share\\", { dev: 7, ino: 1 }],
  ]);
  const io: RecordGuardFacts = {
    platform: "win32", home: "C:\\repo",
    async realpath(file) {
      const key = file.toLowerCase();
      if (protectedNames.has(key)) return file;
      if (key === "c:\\alias") return "C:\\repo\\slate-changes\\change";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async stat(file) { const identity = protectedNames.get(file.toLowerCase()); if (!identity) throw new Error("unresolved identity"); return { ...identity, isDirectory: () => true }; },
    async readdir(file) { return file.toLowerCase() === "c:\\repo\\slate-changes" ? ["change"] : []; },
  };
  return io;
}
test("record-guard-windows-paths blocks case variants, drive forms, home, file URLs, aliases and network paths by identity", { timeout: 10000 }, async () => {
  for (const target of ["slate-changes/CHANGE/new.md", "C:\\REPO\\SLATE-CHANGES\\change\\new.md", "@C:/repo/slate-changes/change/new.md", "~/slate-changes/change/new.md", "~\\slate-changes\\change\\new.md", "file:///C:/REPO/slate-changes/change/new.md", "/c/repo/slate-changes/change/new.md", "/mnt/c/repo/slate-changes/change/new.md", "/cygdrive/c/repo/slate-changes/change/new.md", "C:\\alias\\new.md", "\\\\SERVER\\share\\records\\new.md", "file://server/share/records/new.md"]) {
    assert.equal(await recordGuardBlocks(target, "C:\\repo", "C:\\repo", facts()), true, target);
  }
  assert.equal(await recordGuardBlocks("slate-changes-other/new.md", "C:\\repo", "C:\\repo", facts()), false);
  assert.equal(await recordGuardBlocks("outside.md", "C:\\repo", "C:\\repo", facts()), false);
  assert.equal(resolveRecordGuardPath("/mnt/c/repo/x", "C:\\repo", facts()), "C:\\repo\\x");
});
test("record-guard-windows-paths blocks failed resolution and identity reads conservatively", { timeout: 10000 }, async () => {
  const io = facts();
  io.realpath = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  assert.equal(await recordGuardBlocks("outside.md", "C:\\repo", "C:\\repo", io), true);
  for (const value of [null, 42, "", "file:///"]) assert.equal(await recordGuardBlocks(value, "C:\\repo", "C:\\repo", facts()), true);
  const bad = facts(); bad.stat = async () => { throw new Error("identity unknown"); };
  assert.equal(await recordGuardBlocks("outside.md", "C:\\repo", "C:\\repo", bad), true);
});
