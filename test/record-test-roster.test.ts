import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { auditRecordTestRoster, discoverRecordTests } = await import(pathToFileURL(join(process.cwd(), "verification/record-test-roster.mjs")).href);
const fixtures = [
  { path: "test/record-shared-rules.test.ts", source: 'import "../extension/record-names.ts"' },
  { path: "test/record-windows-refusal.test.ts", source: "// record-tool-test: windows" },
];
test("record-test-file-roster includes shared rules and rejects out-of-pattern tests and empty patterns", () => {
  assert.deepEqual(auditRecordTestRoster(fixtures).errors, []);
  for (const file of [
    { path: "test/misnamed.test.ts", source: 'import "../extension/record-write.ts"' },
    { path: "test/record-misnamed.test.ts", source: "// record-tool-test: windows" },
  ]) assert.match(auditRecordTestRoster([...fixtures, file]).errors.join("\n"), /outside its applicable pattern/);
  assert.match(auditRecordTestRoster([]).errors.join("\n"), /record-tool test pattern matches no file/);
  assert.match(auditRecordTestRoster([fixtures[0]]).errors.join("\n"), /Windows test pattern matches no file/);
  assert.deepEqual(auditRecordTestRoster([...fixtures, { path: "test/unrelated.test.ts", source: "// unrelated" }]).errors, []);
  const actual = discoverRecordTests(process.cwd());
  assert.deepEqual(actual.errors, []);
  assert.ok(actual.records.includes("test/record-shared-rules.test.ts"));
  assert.ok(actual.windows.includes("test/record-windows-refusal.test.ts"));
  assert.ok(actual.windows.every((path: string) => path.includes("record-windows-")));
});
