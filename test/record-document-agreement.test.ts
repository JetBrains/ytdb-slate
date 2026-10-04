// record-tool-test: all
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as ts from "typescript";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RECORD_NAME_RULES, buildRecordAssignment, readOnlyEarlierLogLine } from "../extension/record-names.ts";
import { prepareRecordWrite, RECORD_PAYLOAD_MAX } from "../extension/record-write.ts";
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

function recordRows(source: string) {
  const tables = [...source.matchAll(/^\| Exact record name \| Permitted modes \| Writer \|\n\| --- \| --- \| --- \|\n((?:\|[^\n]*\|\n)+)/gm)];
  assert.equal(tables.length, 1, "one record-mode table");
  return [...tables[0]![1]!.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)];
}

function assertRecordRows(source: string) {
  const rows = recordRows(source);
  assert.equal(rows.length, RECORD_NAME_RULES.length);
  assert.deepEqual(rows.map((row) => [row[1], row[2]!.trim(), row[3]!.trim()]), RECORD_NAME_RULES.map((rule) => [
    rule.hasIdentifier ? `${rule.prefix}<number>${rule.suffix}` : rule.prefix,
    rule.modes.join(", "), rule.writerRole === "implementer" ? "implementer for that number" : rule.writerRole,
  ]));
}

function assertSharedPlaceholders(source: string) {
  assert.doesNotMatch(source, /track-<(?:path|path-number|identifier)>-(?:design|research-log|implementer-report)\.md/);
}

test("record-name-agreement compares document names and modes with production rules", () => {
  assertRecordRows(recursive);
  assert.throws(() => assertRecordRows(recursive.replace("| create, replace | record-only |", "| create, append | record-only |")));
  assertRecordRows(recursive + "\n## Unrelated table\n\n| `README.md` | read | reader |\n");
  for (const reader of [doc("pr-publishing"), doc("delivery-packages"), recursive]) {
    assert.ok(reader.includes("`root-design.md`"));
    assert.ok(reader.includes("`track-<number>-design.md`"));
    assertSharedPlaceholders(reader);
  }
  const change = "change-20261004T000000Z-" + "a".repeat(32);
  assert.ok(recursive.includes("`" + readOnlyEarlierLogLine(change).replace(change, "<change>") + "`"));
});

test("record-shared-placeholder-agreement checks doctrine source and every document", () => {
  const sources = [readFileSync(new URL("../extension/mode.ts", import.meta.url), "utf8"),
    ...readdirSync(new URL("../docs/", import.meta.url), { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".md"))
      .map((name) => readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8"))];
  for (const source of sources) {
    assertSharedPlaceholders(source);
    for (const suffix of ["design", "research-log", "implementer-report"]) {
      assert.throws(() => assertSharedPlaceholders(source + `\ntrack-<identifier>-${suffix}.md`));
    }
    assertSharedPlaceholders(source + "\n<!-- Unrelated placeholder control. -->");
  }
});

function assertPlatform(source: string) {
  assert.ok(source.includes("Change-record writes support Linux, macOS, and Windows Subsystem for Linux (WSL) on its own Linux filesystem."));
  assert.match(source, /Native Windows refuses with a reason before any record-tool file operation/);
  assert.match(source, /Detected Windows drive destinations inside WSL (?:also refuse\.|refuse before file changes\.)/);
  assert.match(source, /Windows drives (?:inside WSL )?are unsupported even when detection misses them/);
  assert.ok(source.includes("https://github.com/JetBrains/ytdb-slate/issues/498"));
}

test("record-platform-document-agreement keeps supported systems, refusal, and evidence limits", () => {
  for (const source of [doc("design-principles"), recursive]) {
    assertPlatform(source);
    assert.throws(() => assertPlatform(source.replace("Detected Windows drive destinations inside WSL", "Allowed Windows drive destinations inside WSL")));
    assert.throws(() => assertPlatform(source.replace("are unsupported even when detection misses them", "are supported when detection misses them")));
    assertPlatform(source + "\n<!-- Outside platform control. -->");
  }
  assert.ok(recursive.includes("WSL tested through Linux CI and simulated drive checks."));
  assert.ok(recursive.includes("including drives exposed through virtiofs, a virtual-machine file-sharing filesystem"));
  assert.ok(recursive.includes("https://github.com/JetBrains/ytdb-slate/issues/499"));
});

function assertPayloadLimit(source: string) {
  const limits = [...source.matchAll(/Each payload may contain at most ([\d,]+) encoded bytes/g)];
  assert.equal(limits.length, 1);
  assert.equal(Number(limits[0]![1]!.replaceAll(",", "")), RECORD_PAYLOAD_MAX);
}

function assertParameters(source: string) {
  const lists = [...source.matchAll(/^The tool accepts (.+)\.$/gm)];
  assert.equal(lists.length, 1);
  assert.deepEqual([...lists[0]![1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]), Object.keys(RECORD_TOOL_PARAMETERS.properties));
}

function assertOutcomeStates(source: string) {
  const production = readFileSync(new URL("../extension/record-write.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("record-write.ts", production, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = ast.statements.filter(ts.isTypeAliasDeclaration).filter((alias) => alias.name.text === "RecordOutcomeState");
  assert.equal(aliases.length, 1);
  const union = aliases[0]!.type;
  assert.ok(ts.isUnionTypeNode(union));
  const states = union.types.map((type) => {
    assert.ok(ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal));
    return type.literal.text;
  });
  const tables = [...source.matchAll(/^\| Outcome state \| Caller duty \|\n\| --- \| --- \|\n((?:\|[^\n]*\|\n)+)/gm)];
  assert.equal(tables.length, 1);
  assert.deepEqual([...tables[0]![1]!.matchAll(/^\| ([^|]+) \|/gm)].map((row) => row[1]!.trim()), states);
}

test("record-tool-value-agreement derives payload limit, parameters, and outcome states from production", () => {
  for (const [check, before, after] of [
    [assertPayloadLimit, "1,048,576 encoded bytes", "2,097,152 encoded bytes"],
    [assertParameters, "`payload`, and optional", "`text`, and optional"],
    [assertOutcomeStates, "| unknown outcome |", "| lost outcome |"],
  ] as const) {
    check(recursive);
    assert.ok(recursive.includes(before));
    assert.throws(() => check(recursive.replace(before, after)));
    check(recursive + "\n<!-- Outside tool-value control. -->");
  }
});

function assertDesignEvidence(source: string) {
  assert.ok(source.includes("A tool-retained design copy under `versions/` is evidence only when its complete bytes match its hash-bound name."));
  assert.ok(source.includes("An interim `<name>.vN.md` design copy is evidence when its complete bytes match the hash recorded in the owning log."));
  assert.ok(source.includes("The current design file remains authoritative."));
}

test("record-design-evidence-agreement admits hash-verified interim copies and tool-retained versions", () => {
  const source = doc("delivery-packages");
  assertDesignEvidence(source);
  assert.throws(() => assertDesignEvidence(source.replace("is evidence when its complete bytes match the hash recorded in the owning log", "is never evidence")));
  assertDesignEvidence(source + "\n<!-- Outside accounting control. -->");
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
