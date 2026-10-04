// record-tool-test: all
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RECORD_NAME_RULES, buildRecordAssignment, readOnlyEarlierLogLine } from "../extension/record-names.ts";
import { prepareRecordWrite } from "../extension/record-write.ts";
import { createChangeDirectory } from "../extension/slate-files.ts";
import { RECORD_TOOL_DESCRIPTION, RECORD_TOOL_PARAMETERS, recordWorkerGuidance } from "../extension/record-worker.ts";
import { RecordOwnership } from "../extension/record-ownership.ts";
import { workerPreamble } from "../extension/worker.ts";
import { registerSlateTools } from "../extension/tools.ts";
import { SlateStore } from "../extension/state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const doc = (name: string) => readFileSync(new URL(`../docs/${name}.md`, import.meta.url), "utf8");
const recursive = doc("recursive-workflow");
const hash = (bytes: string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

test("record-name-agreement compares document names and modes with production rules", () => {
  const rows = [...recursive.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)];
  assert.equal(rows.length, RECORD_NAME_RULES.length);
  assert.deepEqual(rows.map((row) => [row[1], row[2]!.trim(), row[3]!.trim()]), RECORD_NAME_RULES.map((rule) => [
    rule.hasIdentifier ? `${rule.prefix}<number>${rule.suffix}` : rule.prefix,
    rule.modes.join(", "), rule.writerRole === "implementer" ? "implementer for that number" : rule.writerRole,
  ]));
  for (const reader of [doc("pr-publishing"), doc("delivery-packages"), recursive]) {
    assert.ok(reader.includes("`root-design.md`"));
    assert.ok(reader.includes("`track-<number>-design.md`"));
    assert.doesNotMatch(reader, /track-<(?:path|path-number|identifier)>-(?:design|research-log)\.md/);
  }
  const change = "change-20261004T000000Z-" + "a".repeat(32);
  assert.ok(recursive.includes("`" + readOnlyEarlierLogLine(change).replace(change, "<change>") + "`"));
});

test("record-platform-document-agreement keeps supported systems, refusal, and evidence limits", () => {
  const principles = doc("design-principles");
  for (const source of [principles, recursive]) {
    assert.ok(source.includes("Change-record writes support Linux, macOS, and Windows Subsystem for Linux (WSL) on its own Linux filesystem."));
    assert.match(source, /Native Windows refuses with a reason before any record-tool file operation/);
    assert.ok(source.includes("https://github.com/JetBrains/ytdb-slate/issues/498"));
  }
  assert.ok(recursive.includes("WSL tested through Linux CI and simulated drive checks."));
  assert.ok(recursive.includes("including drives exposed through virtiofs"));
  assert.ok(recursive.includes("https://github.com/JetBrains/ytdb-slate/issues/499"));
});

test("record-temporary-name-agreement compares published patterns with real staged names and retained bytes", { timeout: 10000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slate-record-docs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const change = "change-20261004T000000Z-" + "b".repeat(32);
  createChangeDirectory(root, change);
  const assignment = buildRecordAssignment({ type: "general", records: ["status.md"] }, change, undefined)!;
  const context = { projectRoot: root, assignment };
  const create = await prepareRecordWrite(context, { record: "status.md", mode: "create", payload: "earlier" });
  assert.match(create.temporaryPath, /\/\.slate-record-[0-9a-f]{32}\.tmp$/);
  assert.ok(recursive.includes("`.slate-record-<32hex>.tmp`"));
  assert.equal((await create.publish()).state, "published and synced");
  const interim = join(root, assignment.currentFolder, "status.v99.md");
  await writeFile(interim, "unchanged interim bytes");
  const stagingNames: string[] = [];
  const replace = await prepareRecordWrite(context, { record: "status.md", mode: "replace", payload: "later", expectedHash: hash("earlier") }, { fs: { ...fs, async open(path, flags, mode) {
    if (path.includes(".slate-record-version-")) stagingNames.push(path);
    return fs.open(path, flags, mode);
  } } });
  const result = await replace.publish();
  assert.equal(result.state, "published and synced");
  const version = result.replacement!.version;
  assert.equal(version, join(root, assignment.currentFolder, `versions/status.md.v1.${hash("earlier").slice(7)}`));
  assert.ok(recursive.includes("`versions/<record>.v<N>.<sha256 hex>`"));
  assert.equal(await readFile(version, "utf8"), "earlier");
  assert.equal(await readFile(interim, "utf8"), "unchanged interim bytes");
  assert.ok(stagingNames.length > 0);
  for (const path of stagingNames) assert.match(path, /\/versions\/\.slate-record-version-status\.md\.v1\.[0-9a-f]{32}\.tmp$/);
  assert.ok(recursive.includes("`.slate-record-version-<record>.v<N>.<32hex>.tmp`"));
});

test("record-tool-context-agreement measures production worker surfaces against published figures", () => {
  const budget = doc("context-budget");
  assert.equal(Buffer.byteLength(RECORD_TOOL_DESCRIPTION), 531);
  assert.equal(Buffer.byteLength(JSON.stringify(RECORD_TOOL_PARAMETERS)), 507);
  let thread!: { description: string; parameters: unknown };
  const pi = { registerTool(tool: { name: string; description: string; parameters: unknown }) { if (tool.name === "thread") thread = tool; } } as unknown as ExtensionAPI;
  registerSlateTools(pi, new SlateStore(pi), () => { throw new Error("not dispatched"); });
  assert.deepEqual([Buffer.byteLength(thread.description), Buffer.byteLength(JSON.stringify(thread.parameters))], [973, 2458]);
  assert.ok(budget.includes("description is 973 UTF-8 bytes"));
  assert.ok(budget.includes("parameter schema is 2,458 bytes"));
  assert.ok(budget.includes("The two values total 3,431 bytes"));
  assert.ok(budget.includes("Its description is 531 UTF-8 bytes."));
  assert.ok(budget.includes("Its serialized parameters are 507 bytes"));
  const change = "change-20261004T000000Z-" + "c".repeat(32);
  const lease = new RecordOwnership({ currentChange: change }).reserve(buildRecordAssignment({ type: "implementer", trackNumber: "2.5" }, change, undefined)!);
  const guidance = recordWorkerGuidance(lease);
  assert.equal(Buffer.byteLength(guidance), 223);
  assert.deepEqual([false, true].map((writing) => Buffer.byteLength([workerPreamble(writing, false), guidance].join("\n\n"))), [769, 1322]);
  assert.ok(budget.includes("that guidance is 223 UTF-8 bytes"));
  assert.ok(budget.includes("769 bytes without writing guidance and 1,322 bytes with writing guidance"));
  lease.release();
});
