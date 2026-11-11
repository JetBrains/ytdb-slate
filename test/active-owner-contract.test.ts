import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-ignore Shared verification-only contract.
import { resolveActiveParser, assertActiveParserContract, activeParserContractIds, activeOwnerControls, activeOwnerControlIds, activeOwnerAttacks, activeOwnerMutationIds, safeWriteDuties, acceptsSafeWriteDuty } from "../verification/record-mutation-roster.mjs";

const source = Object.fromEntries([["C", "change-records"], ["W", "safe-record-write"], ["E", "record-write-recovery"], ["P", "record-write-pending"]].map(([key, file]) => [key, readFileSync(new URL("../docs/" + file + ".md", import.meta.url), "utf8")]));

test("active owner parser pins its selected origin, version and consumed shapes", () => {
  const parser = resolveActiveParser();
  assert.deepEqual(assertActiveParserContract(parser), activeParserContractIds);
  assert.throws(() => assertActiveParserContract({ ...parser, version: "other" }), /marked 18.0.11/);
  assert.throws(() => assertActiveParserContract({ ...parser, lex: () => [] }), /tokens|contract|fixture|Cannot/);
  assert.throws(() => resolveActiveParser(process.cwd(), "/missing/slate-pi"), /npm ci --ignore-scripts/);
});

test("active owner controls expose occurrence and boundary mutants without byte guards", async () => {
  const controls = await activeOwnerControls(source);
  assert.deepEqual(controls.map((control: any) => control.id), activeOwnerControlIds);
  for (const control of controls) assert.ok(control.passed, control.id);
  const rows = activeOwnerAttacks(source);
  assert.deepEqual(rows.map((row: any) => row.id), activeOwnerMutationIds);
  assert.equal(rows.length, 54);
  for (const row of rows) assert.ok(row.changed && row.rejected, row.id);
  // Contradictions leave clauses present, so the separate complete-byte layer is required.
  const contradiction = { ...source, E: source.E + "\nAll exceptions are optional.\n" };
  assert.notEqual(contradiction.E, source.E);
  assert.ok(safeWriteDuties.every(([, clauses]: any) => acceptsSafeWriteDuty(contradiction, clauses)));
});
