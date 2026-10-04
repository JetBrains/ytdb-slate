// record-tool-test: all
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { createChangeDirectory } from "../extension/slate-files.ts";
import { buildRecordAssignment } from "../extension/record-names.ts";
import { RecordOwnership } from "../extension/record-ownership.ts";
import { createRecordWorkerRuntime, recordWorkerGuidance } from "../extension/record-worker.ts";
import { recordHash } from "../extension/record-write.ts";
import { registerSlateTools } from "../extension/tools.ts";
import { SlateStore } from "../extension/state.ts";
import { workerPreamble } from "../extension/worker.ts";

test("record-outcome-reporting keeps failed preparation hashes and classifies lost reports as unknown", { timeout: 10000 }, async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "slate-record-failure-"))); t.after(() => rm(cwd, { recursive: true, force: true }));
  const currentChange = createChangeFolder(); createChangeDirectory(cwd, currentChange);
  const assignment = buildRecordAssignment({ type: "general", records: ["status.md"] }, currentChange, undefined)!;
  const lease = new RecordOwnership({ currentChange }).reserve(assignment);
  let execute!: Function;
  const api = { on() {}, registerTool(tool: any) { execute = tool.execute; } } as unknown as ExtensionAPI;
  const good = createRecordWorkerRuntime(cwd, lease); good.extension(api);
  assert.equal((await execute("create", { record: "status.md", mode: "create", payload: "earlier" })).details.state, "published and synced");
  const hash = recordHash(Buffer.from("earlier"));
  const failing = createRecordWorkerRuntime(cwd, lease, { fs: { ...fs, open: async (...args) => {
    if (String(args[0]).includes(".slate-record-")) throw Object.assign(new Error("staging failed"), { code: "EIO" });
    return fs.open(...args);
  } } }); failing.extension(api);
  const failure = await execute("failed", { record: "status.md", mode: "replace", payload: "not written", expectedHash: hash });
  assert.equal(failure.details.state, "failed before publication"); assert.equal(failure.isError, true);
  assert.equal(failing.facts()[0]!.observedBeforeHash, hash); assert.equal(failing.facts()[0]!.observedAfterHash, undefined);
  assert.equal(await readFile(join(cwd, assignment.currentFolder, "status.md"), "utf8"), "earlier");
  const lost = createRecordWorkerRuntime(cwd, lease, {}, async () => { throw new Error("unexpected lost report"); }); lost.extension(api);
  assert.equal((await execute("lost", { record: "status.md", mode: "replace", payload: "private", expectedHash: hash })).details.state, "unknown outcome");
  assert.equal(lost.facts()[0]!.observedBeforeHash, undefined); assert.match(lost.facts()[0]!.reason, /Inspect the current record/);
  assert.throws(() => new RecordOwnership({ currentChange }).reserve({ ...assignment, writerRole: "invalid" } as never), /no longer matches/);
  lease.release();
});

test("record-tool-sizes measures unchanged production thread definition and composed worker guidance", () => {
  let thread!: { description: string; parameters: unknown };
  registerSlateTools({ registerTool(tool: any) { if (tool.name === "thread") thread = tool; } } as unknown as ExtensionAPI, new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI), () => { throw new Error("not dispatched"); });
  assert.equal(Buffer.byteLength(thread.description), 973);
  assert.equal(Buffer.byteLength(JSON.stringify(thread.parameters)), 2458);
  const currentChange = "change-20261004T000000Z-" + "a".repeat(32);
  const lease = new RecordOwnership({ currentChange }).reserve(buildRecordAssignment({ type: "implementer", trackNumber: "2.4" }, currentChange, undefined)!);
  assert.deepEqual([false, true].map((trusted) => Buffer.byteLength([workerPreamble(trusted, false), recordWorkerGuidance(lease)].join("\n\n"))), [769, 1322]);
});
