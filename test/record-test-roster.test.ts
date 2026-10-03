import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { auditRecordTestRoster, discoverRecordTests, auditRecordTestExecution, runRecordTests, NATIVE_WINDOWS_TEST } = await import(pathToFileURL(join(process.cwd(), "verification/record-test-roster.mjs")).href);
const fixtures = [
  { path: "test/record-shared-rules.test.ts", source: 'import "../extension/record-names.ts"' },
  { path: "test/record-windows-refusal.test.ts", source: "// record-tool-test: windows" },
];
test("record-test-file-roster includes shared rules and rejects out-of-pattern tests and empty patterns", () => {
  assert.deepEqual(auditRecordTestRoster(fixtures).errors, []);
  for (const file of [
    { path: "test/misnamed.test.ts", source: 'import "../extension/record-write.ts"' },
    { path: "test/record-misnamed.test.ts", source: "// record-tool-test: windows" },
  ]) {
    const errors = auditRecordTestRoster([...fixtures, file]).errors.join("\n");
    assert.match(errors, /outside its applicable pattern/);
    assert.match(errors, /Rename it to match test\/\*\*\/record-/);
  }
  assert.match(auditRecordTestRoster([]).errors.join("\n"), /record-tool test pattern matches no file/);
  assert.match(auditRecordTestRoster([fixtures[0]]).errors.join("\n"), /Windows test pattern matches no file/);
  assert.deepEqual(auditRecordTestRoster([...fixtures, { path: "test/unrelated.test.ts", source: "// unrelated" }]).errors, []);
  for (const source of ["  // record-tool-test: windows", "/* record-tool-test: windows */"]) {
    assert.match(auditRecordTestRoster([...fixtures, { path: "test/record-misnamed.test.ts", source }]).errors.join("\n"), /Rename.*test\/\*\*\/record-windows-\*\.test\.ts/);
  }
  assert.deepEqual(auditRecordTestRoster([
    { path: "test/record-.test.ts", source: "// record-tool-test: all" },
    { path: "test/nested/record-windows-.test.ts", source: "// record-tool-test: windows" },
  ]).errors, []);
  for (const error of auditRecordTestRoster([]).errors) assert.match(error, /Add a test matching test\/\*\*\/record-/);
  const actual = discoverRecordTests(process.cwd());
  assert.deepEqual(actual.errors, []);
  assert.ok(actual.records.includes("test/record-shared-rules.test.ts"));
  assert.ok(actual.windows.includes("test/record-windows-refusal.test.ts"));
  assert.ok(actual.windows.every((path: string) => path.includes("record-windows-")));
});

test("record-test-execution requires actual outcomes and complete per-file summaries", () => {
  const repo = process.cwd();
  const path = "test/record-required.test.ts";
  const file = join(repo, path);
  const summary = { type: "test:summary", data: { file, success: true, counts: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 } } };
  const outcome = { type: "test:pass", data: { file, name: "required", details: { type: "test" } } };
  assert.deepEqual(auditRecordTestExecution(repo, [path], [summary, outcome]), []);
  assert.match(auditRecordTestExecution(repo, [path], [summary]).join("\n"), /non-skipped test/);
  assert.match(auditRecordTestExecution(repo, [path], [outcome]).join("\n"), /complete successful test execution/);
  assert.match(auditRecordTestExecution(repo, [path], [summary, summary, outcome]).join("\n"), /complete successful test execution/);
  assert.match(auditRecordTestExecution(repo, [path], [summary, { ...outcome, data: { ...outcome.data, name: file } }]).join("\n"), /non-skipped test/);
});

test("record-test-execution rejects empty files and required skips and limits the native Windows exception", { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "slate-record-runner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "test"));
  const regular = "test/record-required.test.ts";
  const windows = "test/record-windows-refusal.test.ts";
  const empty = "test/record-empty.test.ts";
  const pass = 'import {test} from "node:test"; test("required", () => {});\n';
  await fs.writeFile(join(root, regular), pass);
  await fs.writeFile(join(root, windows), pass);
  await fs.writeFile(join(root, empty), "// record-tool-test: all\n");
  const emptyRun = runRecordTests(root, [regular, windows, empty]);
  assert.equal(emptyRun.status, 1);
  assert.match(emptyRun.errors.join("\n"), /record-empty.*non-skipped test/);
  await fs.writeFile(join(root, regular), pass + 'test("required skip", {skip: true}, () => {});\n');
  const skipped = runRecordTests(root, [regular, windows]);
  assert.equal(skipped.status, 1);
  assert.match(skipped.errors.join("\n"), /skipped required skip.*Run this required test/);
  await fs.writeFile(join(root, regular), pass);
  await fs.writeFile(join(root, windows), pass + `test(${JSON.stringify(NATIVE_WINDOWS_TEST)}, {skip: true}, () => {});\n`);
  const allowed = runRecordTests(root, [regular, windows], "linux");
  assert.equal(allowed.status, 0, JSON.stringify(allowed));
  assert.deepEqual(allowed.errors, []);
  const native = runRecordTests(root, [regular, windows], "win32");
  assert.equal(native.status, 1);
  assert.match(native.errors.join("\n"), /skipped record-native-windows-refusal/);
  await fs.writeFile(join(root, regular), pass + `test(${JSON.stringify(NATIVE_WINDOWS_TEST)}, {skip: true}, () => {});\n`);
  assert.equal(runRecordTests(root, [regular], "linux").status, 1, "the exception applies to one exact file");
  await fs.writeFile(join(root, regular), 'import {test} from "node:test"; test("failure", () => { throw new Error("control"); });\n');
  assert.equal(runRecordTests(root, [regular]).status, 1);
});
