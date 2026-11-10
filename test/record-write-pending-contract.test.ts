import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
// @ts-ignore Shared independent contract checks.
import { pendingDuties, pendingAttacks, pendingMutationIds, pendingContractChecks, pendingRegions, acceptsPendingDocument, acceptsPendingRegions, acceptsPendingMutationRoster, safeWriteRegion, acceptsPending, acceptsNoPendingReader, safeWriteDuties, acceptsSafeWriteDuty, createMutationAudit } from "../verification/record-mutation-roster.mjs";
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
 assert.equal(rows.length, 2512);
 assert.ok(acceptsPendingMutationRoster());
 assert.equal(acceptsPendingMutationRoster(pendingMutationIds.slice(1)), false);
 for (const kind of ["remove", "24", "indent-space", "indent-tab", "html-comment", "html-block"]) {
  assert.equal(acceptsPendingMutationRoster(pendingMutationIds.filter((id: string) => !id.endsWith("/" + kind))), false);
 }
 // Omit generation inputs before attacks exist, not rows after generation.
 for (const kind of ["remove", "indent-space", "indent-tab", "html-comment", "html-block"])
  assert.equal(check(pendingAttacks(sources, { omitKind: kind })), false);
 assert.equal(check(pendingAttacks(sources, { omitWord: "24" })), false);
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

test("pending ownership excludes relocated duties and pins complete regions", () => {
 const headings = { PW: "## Pending worker contract", PE: "## Pending history decisions" };
 for (const [owner, clauses] of pendingDuties) {
  const clause = clauses[4];
  const offset = sources.P!.indexOf(headings[owner as keyof typeof headings]);
  const removed = sources.P!.slice(0, offset) + sources.P!.slice(offset).replace(clause, "");
  const end = owner === "PW" ? removed.indexOf(headings.PE) : removed.length;
  for (const heading of ["## Outside", "# Outside", "Outside\n-------", "Outside\n======="]) {
   const text = removed.slice(0, end) + "\n" + heading + "\n" + clause + "\n" + removed.slice(end);
   assert.equal(acceptsPending({ ...sources, P: text }, owner, clause), false);
   assert.equal(pendingContractChecks({ ...sources, P: text }), false);
  }
  for (const fence of ["```", "~~~~"]) {
   const text = removed.slice(0, offset) + removed.slice(offset).replace("\n", "\n" + fence + "text\n" + clause + "\n" + fence + "\n");
   assert.equal(acceptsPending({ ...sources, P: text }, owner, clause), false);
   assert.equal(pendingContractChecks({ ...sources, P: text }), false);
  }
  for (const added of ["A retry may omit its expected identity.",
   "A symlink or nonregular final component is acceptable when bytes are equal.",
   "Exit 0 with exclusiveCreate applied also satisfies a fresh check."]) {
   const contradiction = removed.replace(headings[owner as keyof typeof headings],
    headings[owner as keyof typeof headings] + "\n" + clause + "\n" + added);
   assert.equal(acceptsPending({ ...sources, P: contradiction }, owner, clause), true);
   assert.equal(acceptsPendingRegions(contradiction), false);
   assert.equal(pendingContractChecks({ ...sources, P: contradiction }), false);
  }
 }
 for (const fence of ["```", "~~~"]) {
  const text = sources.P!.replace("### Pending preservation contract",
   fence + "text\n## Outside\n" + fence + "\n### Pending preservation contract");
  assert.deepEqual(pendingRegions(text), {});
 }
});

test("pending regions reject non-prose duties and hidden owners independently of byte identity", () => {
 assert.ok(acceptsPendingRegions(sources.P));
 assert.ok(pendingContractChecks({ ...sources, P: sources.P!.replace(/\n/g, "\r\n") }));
 for (const [owner, clauses] of pendingDuties) {
  for (const clause of clauses) {
   const heading = owner === "PW" ? "## Pending worker contract" : "## Pending history decisions";
   const offset = sources.P!.indexOf(heading);
   const replaceOwned = (replacement: string) =>
    sources.P!.slice(0, offset) + sources.P!.slice(offset).replace(clause, replacement);
   // These controls construct their bytes independently of pendingAttacks.
   const attacks = [
    replaceOwned("\n    " + clause + "\n"),
    replaceOwned("\n\t" + clause + "\n"),
    ...[" \t", "  \t", "   \t"].map((prefix) => replaceOwned("\n" + prefix + clause + "\n")),
    replaceOwned("\n<!--\n" + clause + "\n-->\n"),
    replaceOwned("\n<div>\n" + clause + "\n</div>\n"),
    replaceOwned("\n```text\n" + clause + "\n```\n"),
    replaceOwned("\n~~~text\n" + clause + "\n~~~\n"),
    replaceOwned("\n- " + clause + "\n"),
    replaceOwned("\n1. " + clause + "\n"),
    replaceOwned("\n| " + clause + " |\n"),
    replaceOwned("\n> " + clause + "\n"),
    "<!--\n" + sources.P + "\n## End\n-->",
    "<div>\n" + sources.P + "\n</div>",
    sources.P!.replace(heading, "    " + heading),
    sources.P!.replace(heading, "\t" + heading),
    sources.P!.replace(heading, "<!--\n" + heading + "\n-->"),
   ];
   for (const P of attacks) {
    assert.deepEqual(pendingRegions(P), {});
    assert.equal(acceptsPending({ ...sources, P }, owner, clause), false);
    assert.equal(acceptsPendingRegions(P), false);
    if (clause === clauses[4]) assert.equal(pendingContractChecks({ ...sources, P }), false);
   }
  }
 }
});

test("pending byte guard and region guard protect different changes", () => {
 assert.ok(acceptsPendingDocument(sources.P));
 assert.ok(acceptsPendingDocument(sources.P!.replace(/\n/g, "\r\n")));
 const section = sources.P + "\n## Pending override\nA retry may omit its expected identity.\n";
 const bare = sources.P + "\nA retry may omit its expected identity.\n";
 const outside = "Outside prose.\n" + sources.P;
 for (const P of [section, bare, outside]) {
  assert.equal(acceptsPendingDocument(P), false);
  assert.equal(pendingContractChecks({ ...sources, P }), false);
  for (const [owner, clauses] of pendingDuties)
   for (const clause of clauses) assert.ok(acceptsPending({ ...sources, P }, owner, clause));
 }
 assert.ok(acceptsPendingRegions(section));
 assert.ok(acceptsPendingRegions(outside));
 assert.equal(acceptsPendingRegions(bare), false);
});

test("pending owner boundaries accept outside prose at each supported heading form", () => {
 for (const [owner] of pendingDuties) {
  const end = owner === "PW" ? sources.P!.indexOf("## Pending history decisions") : sources.P!.length;
  for (const heading of ["# Outside", "## Outside"]) {
   const P = sources.P!.slice(0, end) + "\n" + heading + "\nOutside prose.\n" + sources.P!.slice(end);
   assert.ok(acceptsPendingRegions(P), owner + ": " + heading);
   for (const [key, clauses] of pendingDuties)
    for (const clause of clauses) assert.ok(acceptsPending({ ...sources, P }, key, clause));
   assert.equal(acceptsPendingDocument(P), false);
  }
 }
 for (const heading of ["## Pending worker contract", "## Pending history decisions"])
  assert.deepEqual(pendingRegions(sources.P + "\n" + heading + "\n"), {});
});

test("pending setext attacks fail with refreshed byte identity", { timeout: 30_000 }, async () => {
 const original = read("verification/record-mutation-roster.mjs");
 const digest = createHash("sha256").update(sources.P!).digest("hex");
 assert.equal(original.split(digest).length, 2);
 assert.equal(/^ {0,3}(?:=+|-+) *$/m.test(sources.P!), false);
 for (const ending of ["\n", "\r\n"]) for (const marker of ["-", "="])
  for (const indent of ["", " ", "  ", "   "]) for (const suffix of ["", " ", "  "]) {
   const P = sources.P!.replace("Never infer that hash from a later task, approval or report.",
    "Never infer that hash from a later task, approval or report.\nOutside\n" + indent + marker.repeat(7) + suffix)
    .replace(/\n/g, ending);
   const refreshedDigest = createHash("sha256").update(P.replace(/\r\n/g, "\n")).digest("hex");
   const refreshed = await import("data:text/javascript;base64," +
    Buffer.from(original.replace(digest, refreshedDigest)).toString("base64"));
   assert.ok(refreshed.acceptsPendingDocument(P), "byte guard must accept the refreshed identity");
   assert.deepEqual(refreshed.pendingRegions(P), {});
   assert.equal(refreshed.acceptsPendingRegions(P), false);
   for (const [owner, clauses] of pendingDuties)
    for (const clause of clauses) assert.equal(refreshed.acceptsPending({ ...sources, P }, owner, clause), false);
   assert.equal(refreshed.pendingContractChecks({ ...sources, P }), false);
  }
});

test("pending symbol-only lines fail with refreshed byte identity", { timeout: 30_000 }, async () => {
 const original = read("verification/record-mutation-roster.mjs");
 const digest = createHash("sha256").update(sources.P!).digest("hex");
 assert.equal(original.split(digest).length, 2);
 assert.equal(/^ *[-=*_][ =*_-]*$/m.test(sources.P!), false);
 for (const ending of ["\n", "\r\n"]) {
  const unchanged = sources.P!.replace(/\n/g, ending);
  assert.ok(acceptsPendingDocument(unchanged));
  assert.ok(acceptsPendingRegions(unchanged));
  assert.ok(pendingContractChecks({ ...sources, P: unchanged }));
  for (const form of ["-- --", "- - -", "-  -  -", "* * *", "_ _ _", "= =", "- = * _"])
   for (const indent of ["", " ", "  ", "   "]) for (const suffix of ["", " ", "  "])
    for (const position of ["before", "inside"]) {
     const line = indent + form + suffix + "\n";
     const P = (position === "before" ? line + sources.P :
      sources.P!.replace("### Pending attempt execution", line + "### Pending attempt execution"))
      .replace(/\n/g, ending);
     const refreshedDigest = createHash("sha256").update(P.replace(/\r\n/g, "\n")).digest("hex");
     const refreshed = await import("data:text/javascript;base64," +
      Buffer.from(original.replace(digest, refreshedDigest)).toString("base64"));
     assert.ok(refreshed.acceptsPendingDocument(P), "byte guard must accept the refreshed identity");
     assert.deepEqual(refreshed.pendingRegions(P), {});
     assert.equal(refreshed.acceptsPendingRegions(P), false);
     assert.equal(refreshed.pendingContractChecks({ ...sources, P }), false);
    }
 }
});

test("pending prose subset rejects other Markdown forms globally", () => {
 const forms = ["=", "==", "-", "--", "---", "----", "-- --", "- - -", "-  -  -", "* * *", "_ _ _", "= =", "___", "~~~", "```",
  "- ", "+", "1.", "2)", ": definition", "> quote", "<div>", "| cell |",
  "[target]: destination", "[link](target)", "![image](target)", "\\# escaped",
  "&num; heading", "*emphasis*", "_emphasis_", "`code`", "~~deleted~~", "####### Outside", "Hard break  "];
 for (const ending of ["\n", "\r\n"]) for (const indent of ["", " ", "  ", "   "])
  for (const form of forms) for (const position of ["before", "inside", "after"]) {
   const line = indent + form;
   let P = position === "before" ? line + "\n" + sources.P :
    position === "after" ? sources.P + "\n" + line :
     sources.P!.replace("### Pending attempt execution", line + "\n### Pending attempt execution");
   P = P.replace(/\n/g, ending);
   assert.deepEqual(pendingRegions(P), {}, JSON.stringify({ ending, indent, form, position }));
   assert.equal(acceptsPendingRegions(P), false);
   for (const [owner, clauses] of pendingDuties)
    assert.equal(acceptsPending({ ...sources, P }, owner, clauses[4]), false);
  }
});

test("pending mutation audit detects broken occurrence and boundary predicates", { timeout: 30_000 }, async () => {
 const original = read("verification/record-mutation-roster.mjs");
 const loadMutant = async (before: string, after: string) => {
  assert.equal(original.split(before).length, 2, "one mutation target");
  return import("data:text/javascript;base64," + Buffer.from(original.replace(before, after)).toString("base64"));
 };
 for (const [before, after] of [
  ['if ((regions[owner] ?? "").split(clause).length - 1 !== 1) return false;', 'if (!regions[owner]) return false;'],
  ["   owner = undefined;", "   // Boundary reset omitted by the test mutant."],
 ]) {
  const mutant = await loadMutant(before!, after!);
  const rows = mutant.pendingAttacks(sources);
  assert.ok(rows.some((row: any) => !row.rejected), "broken checker must admit an attack");
  const audit = createMutationAudit({ pending: pendingMutationIds });
  audit.record("pending", rows);
  assert.equal(audit.inspect().ok, false);
  assert.equal(mutant.pendingContractChecks(sources), false);
 }
 const P = sources.P!.replace("## Pending history decisions",
  "## Pending history decisions\nA retry may omit its expected identity.");
 assert.equal(acceptsPendingRegions(P), false);
 const bypass = await loadMutant("export function acceptsPendingRegions(text) {",
  "export function acceptsPendingRegions(text) { return true;");
 assert.equal(bypass.acceptsPendingRegions(P), true, "direct region control detects a bypass");
});

test("pending prose rejects unsupported whitespace on duties, headings and blank lines", () => {
 const prefixes = [" \t", "  \t", "   \t", "\t", "    ", "     ",
  "\u00a0", "\f", "\v", "\u2028", "\u2029", "\ufeff"];
 for (const ending of ["\n", "\r\n"]) {
  const clean = sources.P!.replace(/\n/g, ending);
  assert.ok(acceptsPendingDocument(clean));
  assert.ok(acceptsPendingRegions(clean));
  for (const [owner, clauses] of pendingDuties) {
   const heading = owner === "PW" ? "## Pending worker contract" : "## Pending history decisions";
   const clause = clauses[4];
   for (const prefix of [" ", "  ", "   "]) {
    assert.ok(acceptsPendingRegions(clean.replace(clause, ending + prefix + clause + ending)));
    assert.ok(acceptsPendingRegions(clean.replace(heading, prefix + heading)));
    assert.ok(acceptsPendingRegions(clean.replace(heading, heading + ending + prefix + ending)));
   }
   for (const target of [clause, heading, "### Pending preservation contract"])
    assert.deepEqual(pendingRegions(clean.replace(target, "\r" + target)), {});
   for (const prefix of prefixes) {
    for (const P of [
     clean.replace(clause, ending + prefix + clause + ending),
     clean.replace(heading, prefix + heading),
     clean.replace(heading, heading + ending + prefix + ending),
     clean.replace("### Pending preservation contract", prefix + "### Pending preservation contract"),
     clean.replace(heading, heading.slice(3) + ending + prefix + "-------"),
    ]) {
     assert.deepEqual(pendingRegions(P), {}, JSON.stringify({ ending, owner, prefix }));
     assert.equal(acceptsPendingRegions(P), false);
     assert.equal(acceptsPending({ ...sources, P }, owner, clause), false);
    }
   }
  }
 }
 for (const ending of ["\r", "\u2028", "\u2029", "\f", "\v"])
  assert.deepEqual(pendingRegions(sources.P!.replace(/\n/g, ending)), {});
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
 // Pin the reviewed permission owner, including added policy, independently of clause presence.
 const acceptsPermission = (text: string) => createHash("sha256").update(safeWriteRegion(text)).digest("hex") ===
  "99ddccb0ffb505299daf5509a37b3a3c53a54ec9a6e7cf4d98a41c171a8306c2";
 assert.ok(acceptsPermission(common));
 assert.equal(acceptsPermission(common.replace(rule, "Only retry creation permits uncapped command retries.")), false);
 for (const result of ["Accept", "Pause occupied", "Pause identity", "Pause unknown"]) {
  const widened = common.replace(rule, rule + "\n" + result + " also allows next-name retries.");
  assert.ok(widened.includes(rule));
  assert.equal(acceptsPermission(widened), false, result);
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
