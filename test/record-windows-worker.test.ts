// record-tool-test: windows
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { buildRecordAssignment } from "../extension/record-names.ts";
import { RecordOwnership } from "../extension/record-ownership.ts";
import { createRecordWorkerRuntime } from "../extension/record-worker.ts";
import type { RecordFileSystem } from "../extension/record-write.ts";

test("record-guard-windows-paths stays installed after native Windows tool refusal with zero file operations", { timeout: 10000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "slate-windows-guard-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const currentChange = createChangeFolder(); await mkdir(join(cwd, "slate-changes", currentChange), { recursive: true });
  const lease = new RecordOwnership({ currentChange }).reserve(buildRecordAssignment({ type: "general", records: ["status.md"] }, currentChange, undefined)!);
  let operations = 0, guard!: Function, execute!: Function;
  const fs = new Proxy({} as RecordFileSystem, { get() { operations++; throw new Error("File operation before native Windows refusal"); } });
  const runtime = createRecordWorkerRuntime(cwd, lease, { platform: "win32", fs, platformFacts: async () => { operations++; throw new Error("Unexpected platform probe"); } });
  runtime.extension({ on(_event: string, handler: Function) { guard = handler; }, registerTool(tool: any) { execute = tool.execute; } } as unknown as ExtensionAPI);
  const result = await execute("refuse", { record: "status.md", mode: "create", payload: "text" });
  assert.equal(result.details.state, "refused before publication"); assert.match(result.details.reason, /Native Windows.*WSL/); assert.equal(operations, 0);
  for (const toolName of ["write", "edit"]) {
    assert.equal((await guard({ toolName, input: { path: `slate-changes/${currentChange}/status.md` } }, { cwd })).block, true);
  }
  assert.equal(await guard({ toolName: "read", input: { path: `slate-changes/${currentChange}/status.md` } }, { cwd }), undefined);
  lease.release();
});
