import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
// @ts-ignore Shared verification-only contract.
import { assertActiveRosterSource, resolveActiveParser, assertActiveParserContract, activeParserContractIds, activeOwnerControls, activeOwnerControlIds, activeOwnerAttacks, activeOwnerMutationIds, safeWriteDuties, acceptsSafeWriteDuty } from "../verification/record-mutation-roster.mjs";

const repo = process.env.SLATE_ACTIVE_REPO ?? process.cwd();
const source = Object.fromEntries([["C", "change-records"], ["W", "safe-record-write"], ["E", "record-write-recovery"], ["P", "record-write-pending"]].map(([key, file]) => [key, readFileSync(join(repo, "docs", file + ".md"), "utf8")]));

test("active owner parser pins its selected origin, version and consumed shapes", () => {
  const parser = resolveActiveParser();
  assert.deepEqual(assertActiveParserContract(parser), activeParserContractIds);
  assert.throws(() => assertActiveParserContract({ ...parser, version: "other" }), /marked 18.0.11/);
  assert.throws(() => assertActiveParserContract({ ...parser, lex: () => [] }), /tokens|contract|fixture|Cannot/);
  assert.throws(() => resolveActiveParser(process.cwd(), "/missing/slate-pi"), /npm ci --ignore-scripts/);
});

test("active owner tooling requires a conveyed origin and the selected repository", (t) => {
  const absent = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import { resolveActiveParser } from "./verification/record-mutation-roster.mjs"; resolveActiveParser();'],
    { cwd: repo, encoding: "utf8", timeout: 5000, env: { ...process.env, SLATE_ACTIVE_PI: undefined } });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /missing SLATE_ACTIVE_PI.*npm test.*resolver-checks.*physical pi launcher/);
  const other = mkdtempSync(join(tmpdir(), "slate-active-owner-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  mkdirSync(join(other, "verification"));
  writeFileSync(join(other, "verification/record-mutation-roster.mjs"), "// different selected tree\n");
  assert.throws(() => assertActiveRosterSource(other), /roster source differs from --repo.*selected tree/);
  writeFileSync(join(other, "package.json"), JSON.stringify({
    devDependencies: { "@earendil-works/pi-coding-agent": "0.0.0" },
  }));
  assert.throws(() => resolveActiveParser(other), /pi version differs from repository pin/);
});

test("test runner retains selected linker diagnostics when linking fails", (t) => {
  const other = mkdtempSync(join(tmpdir(), "slate-linker-output-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  mkdirSync(join(other, "verification"));
  const runner = join(other, "verification/run-tests.sh");
  copyFileSync(join(repo, "verification/run-tests.sh"), runner);
  writeFileSync(join(other, "verification/link-peers.sh"),
    "printf '%s\\n' 'NOTE selected pi fixture' 'linked fixture'\nexit 1\n");
  const failed = spawnSync("bash", [runner, "--base", "HEAD"], { encoding: "utf8", timeout: 5000 });
  assert.equal(failed.status, 2);
  assert.match(failed.stdout, /NOTE selected pi fixture\nlinked fixture/);
  assert.match(failed.stderr, /peer linker failed/);
});

test("active owner task checkboxes validate in tight and loose list items", () => {
  const parser = resolveActiveParser();
  const tight = parser.lex("- [ ] task\n");
  const loose = parser.lex("- [ ] task\n\n  continuation\n");
  assert.equal(tight[0].loose, false);
  assert.equal(loose[0].loose, true);
  assert.ok(tight[0].items[0].tokens.some((token: any) => token.type === "checkbox"));
  assert.ok(loose[0].items[0].tokens.some((token: any) => token.type === "paragraph"
    && token.tokens.some((inline: any) => inline.type === "checkbox")));
});

test("active owner controls expose occurrence and boundary mutants without byte guards", async () => {
  assert.equal(safeWriteDuties.length, 40);
  assert.ok(safeWriteDuties.every(([, clauses]: any) => acceptsSafeWriteDuty(source, clauses)));
  const controls = await activeOwnerControls(source);
  assert.deepEqual(controls.map((control: any) => control.id), activeOwnerControlIds);
  for (const control of controls) assert.ok(control.passed, control.id);
  const rows = activeOwnerAttacks(source);
  assert.deepEqual(rows.map((row: any) => row.id), activeOwnerMutationIds);
  assert.equal(rows.length, 100);
  assert.equal(controls.length, 42);
  for (const row of rows) assert.ok(row.changed && row.rejected, row.id);
  // Contradictions leave clauses present, so the separate complete-byte layer is required.
  const contradiction = { ...source, E: source.E + "\nAll exceptions are optional.\n" };
  assert.notEqual(contradiction.E, source.E);
  assert.ok(safeWriteDuties.every(([, clauses]: any) => acceptsSafeWriteDuty(contradiction, clauses)));
});
