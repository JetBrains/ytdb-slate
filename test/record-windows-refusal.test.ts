// record-tool-test: windows
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareRecordWrite, RecordPrepublicationError, type RecordFileSystem } from "../extension/record-write.ts";

for (const platform of ["win32", "freebsd", "aix"]) {
  for (const mode of ["create", "append", "replace"]) {
    test(`record-native-windows-refusal admits no file operation on ${platform} for ${mode}`, async () => {
      let operations = 0;
      const io = new Proxy({} as RecordFileSystem, { get() { operations++; throw new Error("A file operation ran before refusal"); } });
      await assert.rejects(prepareRecordWrite({ projectRoot: "C:\\project", assignment: { currentFolder: "invalid", writerRole: "record-only", names: [] } },
        { record: "invalid", mode, payload: "text" }, { platform, fs: io, platformFacts: async () => { operations++; throw new Error("facts must not run"); } }), (error: unknown) => {
        assert.ok(error instanceof RecordPrepublicationError);
        assert.equal(error.state, "refused before publication");
        assert.match(error.message, platform === "win32" ? /Native Windows.*Use Windows Subsystem for Linux \(WSL\) on its own Linux filesystem/ : /This system.*Use Linux, macOS, or Windows Subsystem for Linux \(WSL\) on its own Linux filesystem/);
        return true;
      });
      assert.equal(operations, 0);
    });
  }
}

test("record-native-windows-refusal uses the real platform on Windows", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(prepareRecordWrite({ projectRoot: "C:\\project", assignment: { currentFolder: "invalid", writerRole: "record-only", names: [] } },
    { record: "invalid", mode: "create", payload: "text" }), /Native Windows.*Use Windows Subsystem for Linux \(WSL\) on its own Linux filesystem/);
});
