import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
// @ts-ignore Shared independent contract checks.
import { pendingDuties, pendingAttacks, pendingMutationIds, pendingContractChecks, acceptsPending, acceptsNoPendingReader, safeWriteDuties, acceptsSafeWriteDuty, createMutationAudit } from "../verification/record-mutation-roster.mjs";
// @ts-ignore Data-only read assignments.
import { reads, resumeReads, dependencies, conditionalSets, sessionEntries, scenarios, accumulatedReads, sessionReads } from "../verification/workflow-context-map.mjs";
import { RECORD_WRITE_PENDING_DOC } from "../extension/paths.ts";

const read = (file: string) => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const sources = Object.fromEntries([["C", "change-records"], ["W", "safe-record-write"],
 ["E", "record-write-recovery"], ["P", "record-write-pending"]].map(([key, file]) => [key!, read("docs/" + file + ".md")]));

test("pending owners retain clauses with closed mutation accounting", () => {
 assert.ok(pendingContractChecks(sources));
 const rows = pendingAttacks(sources);
 const check = (entries: any[], crash = false) => {
  const audit = createMutationAudit({ pending: pendingMutationIds });
  if (crash) audit.crash(new Error("control"));
  audit.record("pending", entries);
  return audit.inspect().ok;
 };
 assert.ok(check(rows));
 for (const bad of [rows.slice(1), [...rows, rows[0]], [...rows, { ...rows[0], id: "unexpected" }],
  rows.map((r: any, i: number) => i ? r : { ...r, rejected: false }),
  rows.map((r: any, i: number) => i ? r : { ...r, changed: false })]) assert.equal(check(bad), false);
 assert.equal(check(rows, true), false);
 for (const [owner, clauses] of pendingDuties) {
  const heading = owner === "PW" ? "## Pending worker contract" : "## Pending history decisions";
  assert.equal(pendingContractChecks({ ...sources, P: sources.P!.replace(heading, "## Other") }), false);
  for (const clause of clauses) assert.ok(acceptsPending(sources, owner, clause));
 }
 for (const [, clauses] of safeWriteDuties) for (const clause of clauses) {
  assert.equal(acceptsSafeWriteDuty({ ...sources, P: sources.P + "\n" + clause }, clauses), false);
 }
});

const walk = (dir: string): string[] => readdirSync(new URL("../" + dir, import.meta.url), { withFileTypes: true })
 .flatMap((entry) => entry.isDirectory() ? walk(dir + "/" + entry.name) : [dir + "/" + entry.name]);

test("pending inventory has no source, document, alias or read-set consumer", () => {
 const surfaces: Array<[string, string]> = [["README.md", read("README.md")]];
 for (const file of walk("docs").filter((f) => f.endsWith(".md") && f !== "docs/record-write-pending.md")) surfaces.push([file, read(file)]);
 for (const file of walk("extension").filter((f) => /\.(ts|mjs)$/.test(f))) {
  let text = read(file);
  if (file === "extension/paths.ts") {
   const declaration = 'export const RECORD_WRITE_PENDING_DOC = join(DOCS_DIR, "record-write-pending.md");';
   assert.equal(text.split(declaration).length, 2);
   text = text.replace(declaration, "");
  }
  surfaces.push([file, text]);
 }
 const families = { reads, resumeReads, dependencies, conditionalSets };
 for (const [name, value] of Object.entries(families)) surfaces.push([name, JSON.stringify(value)]);
 for (let p = 1; p <= 9; p++) for (const scenario of scenarios) for (const maximum of [false, true])
  surfaces.push([`accumulated ${p} ${scenario} ${maximum}`, JSON.stringify(accumulatedReads(p, scenario, maximum))]);
 for (const entry of sessionEntries) for (const scenario of scenarios.filter((s: string) => entry.plans.includes(s.split(" ")[1])))
  for (let through = entry.phase; through <= 9; through++) for (const maximum of [false, true])
   surfaces.push([`session ${entry.id} ${scenario} ${through} ${maximum}`, JSON.stringify(sessionReads(entry, scenario, maximum, through))]);
 for (const [name, text] of surfaces) {
  assert.ok(acceptsNoPendingReader(text, RECORD_WRITE_PENDING_DOC), name);
  for (const spelling of ["record-write-pending.md", "RECORD_WRITE_PENDING_DOC", RECORD_WRITE_PENDING_DOC])
   assert.equal(acceptsNoPendingReader(text + spelling, RECORD_WRITE_PENDING_DOC), false, name);
 }
 assert.equal(acceptsNoPendingReader('import { RECORD_WRITE_PENDING_DOC as alias } from "./paths.ts"'), false);
 assert.equal(acceptsNoPendingReader('export { RECORD_WRITE_PENDING_DOC as alias } from "./paths.ts"'), false);
});

test("common command permission excludes bounded retries after every other class", () => {
 const common = sources.C!;
 const rule = "Only retry creation allows command retries, uncapped.";
 assert.ok(common.includes(rule));
 assert.ok(common.includes("Report one: accept, retry creation, pause occupied, pause identity, pause unknown."));
 assert.ok(common.includes("Command preservation and attempt history are pending."));
 const permits = (text: string, result: string) => text.includes(rule) && result === "retry creation";
 for (const [result, allowed] of [["accept", false], ["retry creation", true], ["pause occupied", false],
  ["pause identity", false], ["pause unknown", false]] as const) {
  assert.equal(permits(common, result), allowed);
  const weakened = common.replace(rule, "Only retry creation permits uncapped command retries.");
  assert.equal(weakened.includes(rule), false, result);
 }
 assert.ok(sources.W!.includes("| preserve | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown |"));
});

// This model interprets pending rules only. No caller uses it.
type History = { ordinary: number, recovery: number, unresolved?: boolean, stopped: boolean,
 checked: boolean, used: boolean, identity?: string, retryIdentity?: string };
const attempt = (h: History, recovery = false) => {
 if (!h.stopped || h.unresolved || !h.checked || h.used) return "pause";
 const count = recovery ? h.recovery : h.ordinary;
 if (count >= 2 || !h.identity || count > 0 && h.retryIdentity !== h.identity) return "pause";
 return "attempt";
};
test("pending history keeps independent allowances and identities across redispatch", () => {
 const base: History = { ordinary: 0, recovery: 0, stopped: true, checked: true, used: false, identity: "stored" };
 assert.equal(attempt(base), "attempt");
 assert.equal(attempt({ ...base, ordinary: 1, retryIdentity: "stored" }), "attempt");
 assert.equal(attempt(JSON.parse(JSON.stringify({ ...base, ordinary: 2 }))), "pause");
 assert.equal(attempt({ ...base, ordinary: 2 }, true), "attempt");
 assert.equal(attempt({ ...base, recovery: 2 }, true), "pause");
 for (const change of [{ checked: false }, { used: true }, { unresolved: true }, { stopped: false },
  { identity: undefined }, { ordinary: 1 }, { ordinary: 1, retryIdentity: "other" }])
  assert.equal(attempt({ ...base, ...change }), "pause");
 assert.equal(attempt({ ...base, stopped: true }), "attempt", "confirmed session end");
 assert.equal(attempt({ ...base, unresolved: true }, true), "pause", "new operation cannot bypass record history");
 assert.equal(attempt({ ...base, identity: "observed" }, true), "attempt", "recovery has its own identity");
 assert.equal(attempt({ ...base, recovery: 1, identity: "observed", retryIdentity: "observed" }, true), "attempt");
 assert.equal(attempt({ ...base, recovery: 1, identity: undefined }, true), "pause");
});


test("pending result interpretation keeps fatal precedence and bounded retry", () => {
 const classify = (exit: number | null, valid: boolean, proof: boolean, remaining: boolean) => {
  if (!valid) return "pause unknown";
  if (exit === 5) return "pause identity";
  if (exit === 4) return remaining ? "retry preservation" : "pause unknown";
  return (exit === 0 || exit === 3) && proof ? "accept retention" : "pause unknown";
 };
 const expected = [[0, "accept retention"], [2, "pause unknown"], [3, "accept retention"],
  [4, "retry preservation"], [5, "pause identity"], [6, "pause unknown"], [7, "pause unknown"],
  [8, "pause unknown"], [null, "pause unknown"]] as const;
 for (const [exit, result] of expected) {
  assert.equal(classify(exit, true, true, true), result);
  assert.equal(classify(exit, false, true, true), "pause unknown");
 }
 for (const exit of [0, 3]) assert.equal(classify(exit, true, false, true), "pause unknown");
 assert.equal(classify(4, true, false, false), "pause unknown");
 const changed = { stopped: false, ordinary: 1, recovery: 0, checked: true, used: false, identity: "stored", retryIdentity: "stored" };
 assert.equal(attempt(changed), "pause", "observed change voids earlier stop evidence");
 for (const result of ["missing", "duplicate", "malformed", "wrong operation", "wrong exit", "signal"])
  assert.equal(classify(null, false, false, true), "pause unknown", result);
 const active = sources.W!.split("| preserve |")[1]!.split("\n")[0]!;
 assert.equal((active.match(/pause unknown/g) ?? []).length, 8);
 assert.ok(sources.P!.includes("Only overlapping exclusive command creations may use the narrow creation exemption."));
 assert.ok(sources.P!.includes("An occupant ends that exemption before classification."));
 assert.ok(sources.P!.includes("Never infer that hash from a later task, approval or report."));
 assert.ok(sources.P!.includes("Attempt-entry appends require no recursive attempt entries."));
 assert.ok(sources.E!.includes("A logged interrupted edit stays an edit even when the destination vanishes."));
});

test("real occupied proof and vanished-copy control follow the pending fresh-check rule", () => {
 const dir = mkdtempSync(join(tmpdir(), "slate-pending-"));
 try {
  const source = join(dir, "source"), destination = join(dir, "kept");
  writeFileSync(source, "retained bytes"); writeFileSync(destination, "retained bytes");
  const invoke = (args: string[]) => spawnSync(process.execPath, ["extension/safe-record-write.mjs", ...args], { encoding: "utf8" });
  const hash = JSON.parse(invoke(["hash", "--", source]).stdout).sourceHash;
  const occupied = () => invoke(["preserve", "--expected", hash, "--", source, destination]);
  const freshCheck = (result: ReturnType<typeof invoke>) => {
   const r = JSON.parse(result.stdout);
   return result.status === 3 && r.operation === "preserve" && r.code === "occupied" && r.stage === "compare"
    && r.writeState === "not-created" && r.equal === true && r.retainedVerified === true
    && r.expected === "agreed" && r.sourceHash === hash && r.destinationHash === hash;
  };
  const result = occupied(), report = JSON.parse(result.stdout);
  assert.ok(freshCheck(result));
  assert.deepEqual(Object.keys(report.protections).sort(), ["exclusiveCreate", "mode0600", "noFollowOpen", "nonblockingOpen"]);
  assert.equal(report.protections.exclusiveCreate, "not-applicable");
  for (const [field, value] of Object.entries({ stage: "complete", writeState: "verified", retainedVerified: false,
   expected: "not-supplied", sourceHash: "0".repeat(64), destinationHash: "0".repeat(64) }))
   assert.equal(freshCheck({ ...result, stdout: JSON.stringify({ ...report, [field]: value }) }), false, field);
  unlinkSync(destination);
  const vanished = occupied();
  assert.equal(vanished.status, 0);
  assert.equal(JSON.parse(vanished.stdout).protections.exclusiveCreate, "applied");
  assert.equal(freshCheck(vanished), false);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
