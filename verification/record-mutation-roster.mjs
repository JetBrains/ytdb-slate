import { createHash } from "node:crypto";
// Independent accepted mutation identities and fail-closed execution accounting.
// Literal duties keep clause checks independent of document digest updates.
export const safeWriteDuties = [
 ["S01",["A **change record** is a research log, status file, implementer report, design, map or plan.","Current `root-design.md` or `track-<number>-design.md` governs its root or design-track node.","In changes started under or migrated to this workflow, a multi-track code track uses `code-track-<number>-design.md`, authoritative only while its node is code and its owning log names it current.","Logs hold decisions, approval identities, links and accounting, not design authority.","Every multi-track change creates a track plan.","A track with review-fix children is multi-track. Without children, a single track needs no plan.","Plan creation and successor copies follow design hash, check and privacy duties.","Pause plan edits and ask the user.","A plan hash identifies bytes, not approval.","The root research log owns plan hashes.","Design tracks have no implementer report or implementation commit.","Use `root-baseline-map.md`, `track-<number>-baseline-map.md` and `track-<number>-implementation-map.md` for factual source explanation, not requirements.","Single-track root baselines use code-track detail.","Map changes grant no approval and change no design identity."]],
 ["S02",["A design track or review-fix child requires manual status.","The **status file**, `status.md`, shows plans, pending gates and log paths.","It grants no completion or gate authority.","A change without a design track or review-fix child has no `status.md`.","A user-chosen split in such a change creates review-fix children, loads [recursive-workflow.md](recursive-workflow.md), and creates `status.md`."]],
 ["S03",["Its plain-text **repair state** column shows each code track and review-fix child’s rounds used of 2, stuck-fix consultations used/budget and pending gates.","No fixed machine format required.","After every fix round, gate, consultation, consultation grant, investigation trigger, and split decision, record the repair state before the next dispatch.","First, a record-only worker writes a typed entry in the affected code track’s owning log, citing the report section.","Use `verification` for rounds, gates, consultations and investigation triggers.","Use `decision` for consultation grants and split decisions.","Second, the worker updates the status entry and cell before dispatch.","Typed log entries prove counts. Cells grant no rounds.","If a cell and log disagree, stop and ask the user.","Automatic correction lowers no count."]],
 ["S04",["Create `track-<number>-research-log.md` when entering a design track.","`<number>` is the canonical path number.","Each log owns its subtree's decisions and accepted history bindings.","Parents keep context and links, not copies of child history.","Root-wide decisions belong in `research-log.md`.","Cross-subtree effects belong in their owning parent.","Review-fix subtrees use the affected code track's existing records.","Its owning research log is the nearest enclosing design-track log, else the root log."]],
 ["S05",["Record-only workers write logs and status.","They store assigned designs, baseline maps and plans from drafts with complete byte comparison.","They create successor designs, plans and maps, including source-folder-only maps.","Record-only workers have no track number.","Implementers write only their own reports and assigned implementation maps.","Fixers append their reports and edit assigned maps.","Neither writes logs."]],
 ["S06",["Classification grants no replacement and lifts no edit barrier."]],
 ["S07",["Under `slate-changes/`, write only assigned records and action scratch.","Follow preamble placement, no-change and missing-path rules.","Required project, verification and tool retention folders outside the checkout take precedence, but hold no start copies or payloads.","Drafts, designs and records outlive the action. Write records with built-in tools."]],
 ["S08",["Never write in a fork's read-only source, `slate-changes/<source>/`.","The successor log starts: `Read-only earlier log: ...`."]],
 ["S09",["Logs and reports are append-only, including their first write.","Append each temporary file with `>>`, as in `cat temporary-file >> file`.","Never use `>`, write or edit tools, or `sed -i` on an existing log or report.","Never change or delete earlier text.","Append corrections as new entries."]],
 ["S10",["A worker may fully rewrite `status.md`."]],
 ["S11",["In new or migrated changes, SHA-256 (Secure Hash Algorithm, 256-bit) identifies complete design/map bytes.","Only all 64 hexadecimal characters identify versions, not prefixes, filenames or sequence numbers.","A retained version is evidence or a restore source only if its bytes match a full hash in its owning log."]],
 ["S12",["Before further edits or evidence use, a record-only worker checks stored bytes against the reported expected hash.","The worker logs only that agreed full hash and checks the entry.","Baseline entries also record path and source commit.","Storage identity grants no approval.","The orchestrator dispatches all hash logging."]],
 ["S13",["Before editing a design or map in these changes, match its last logged full hash or pause."]],
 ["S14",["Preserve a separate copy with `cp -n` at an unused versioned name, such as `track-<number>-implementation-map.vN.md`.","Leave occupied destinations unchanged.","Check complete equality with `cmp` regardless of copy exit."]],
 ["S15",["Before editing, a record-only worker logs the preserved identity and checks its entry.","Split these tasks as writer permissions require."]],
 ["S16",["Adopt a retained copy only after a record-only worker verifies equality with a copy already identified by a logged full hash and logs the adopted hash.","An unlogged draft or filename hash cannot establish adoption.","Retain other copies as non-evidence that never blocks work."]],
 ["S17",["Recorded authority and evidence rules apply until user-authorized migration.","Opening a track is not migration. Complete `versions/` bytes must match the filename hash. `.vN.md` bytes must match their owning log’s hash."]],
 ["S18",["Retained copies keep record privacy and reviewer-input restrictions.","Never change or delete a versioned copy."]],
 ["S19",["Allow one writer per record. Do not start or close a change while a record writer runs."]],
 ["S20",["Slate does not enforce these destination, write-mode or hash duties."]],
 ["S21",["Before an action’s first record write, copy current bytes to an action-folder start file, empty for a new record.","Write each payload to a separate temporary file there."]],
 ["S22",["Append with `>>`.","Copy the temporary file for status creation or rewrites. Use the assigned command for new designs, maps and plans.","Creation: first log/report append, new status/design/map/plan. Edit: later append, status rewrite, design/map/plan change.","Create drafts from payloads, checked with `cmp`. Never edit drafts. Each revision is a new file.","After the last write, check the whole record once.","Delete record-write files only on a pass, else keep evidence and report failure.","Delete scratch files without a record before finishing.","On shutdown, Slate removes only empty action folders and reports retained paths."]],
 ["S23",["A log or report must equal the start copy followed by every appended temporary file in order.","With `cat` and `cmp`, require the log/report to equal its start copy followed by every appended temporary file in order."]],
 ["S24",["Check a status file or new design or map against its last temporary file with `cmp`.","For design/map edits, use `diff` against the verified versioned copy and confirm each difference is intended.","After a design/map edit passes its check, report its full hash."]],
 ["S25",["Report each record's exact task path, comparison and result in the final response.","Only all three episode parts count as a check."]],
 ["S26",["Before writing again, read assigned records lacking a counted check, plus required retry reads.","Failed check: worker reports and stops. Orchestrator applies exception rules.","The orchestrator reads [record-write-recovery.md](record-write-recovery.md) with these rules for:","- failed or unclear record results","- failed, missing or incomplete record checks","- missing or malformed worker summaries","- failed identity or retention proof","- interrupted edits","- occupied creation.","Workers report these triggers and stop."]],
 ["S27",["Failed or unclear log/report write: orchestrator reads its end before retry.","Failed final check: inspect the whole record.","Retry absent text, never present text.","Partial text: append a correction naming the cut-off entry."]],
 ["S28",["Failed or unclear `status.md`: retry a whole rewrite.","A logged interrupted edit stays an edit even when the destination vanishes.","Failed or unclear creation: only common command-result retries.","Only workers run the command because orchestrator mode has no shell tool.","Tasks name [safe-record-write.md](safe-record-write.md): introduction and § Record preparation and recovery execution for appends, status creation/rewrite, design/map edits, preservation retry and restoration with edit retry. Command creation, hash logging and successor checks read all. Draft creation needs only these common rules. Reports use generated guidance plus common and applicable worker rules for maps.","Workers report exactly one class: accept, retry creation, pause occupied, pause identity or pause unknown.","For command results, only retry creation permits another attempt, with no added cap.","Log appends, status rewrites, `cp -n` copies and edit retries keep their own rules.","A worker report with no defined class, several classes or accept without creation proof below or restoration hash proof in the named worker section means pause unknown.","Creation acceptance needs operation create, code ok, writeState verified, equal true and full destinationHash = sourceHash = expected hash when supplied.","Without expected, both full hashes must still agree.","Exit 0 alone is not proof.","The first creation and every retry supply the source’s logged or approval hash as expected when the task holds one.","Identity failure pauses.","New designs, maps and plans allow no non-exclusive creation.","Unavailable exclusive creation or an unrun command pauses.","Never delete, move, rename, truncate or overwrite an occupied creation name as repair.","Occupied creation, even equal: pause for record-only classification.","Until recovery delivers classification, ask the user.","An exit 3 result is never logged as a write identity.","For create, missing/invalid report or signal: retry creation with the same expected hash.","Then occupied means pause occupied.","Known exits 2, 5, 6, 8, unavailable exclusive creation and a command that cannot run take precedence.","Other unclear command results: pause unknown.","Inactive preservation: all preserve operation-and-exit pairs mean pause unknown.","Command proof grants no file authority. Keep explicit edit methods."]],
 ["S29",["Missing or different preservation copy: leave current unchanged.","Retry preservation at the next unused versioned name."]],
 ["S30",["Failed or unclear design/map edit: `cmp` against the intended retained version matching its logged full hash.","If unchanged, retry only the edit.","Otherwise the orchestrator decides restoration under recovery, outside the pre-edit barrier. Require verified restore-source hash before copying.","If the intended copy cannot be verified, pause replacement. Never guess another numbered copy.","Unverifiable intended copy: pause replacement. Never guess another numbered copy.","Authorized preservation retry: `cp -n` at the next unused versioned name, then `cmp`.","The orchestrator decides restoration under recovery, not the pre-edit barrier.","Immediately before copying, run `node COMMAND hash --expected HASH -- SOURCE`.","COMMAND is ../extension/safe-record-write.mjs relative to this reference.","SOURCE is the intended restore source. HASH is its logged full lowercase SHA-256 hash (64 hexadecimal digits).","Quote paths and escape embedded quotes.","Agreement requires exactly one valid JavaScript Object Notation (JSON) report, process exit 0, operation hash, code ok, stage complete, writeState not-created, expected agreed, sourceHash equal to HASH, equal null, destinationHash null and retainedVerified false.","protections has exactly exclusiveCreate, noFollowOpen, nonblockingOpen and mode0600, each applied, unavailable or not-applicable.","No report or HASH: pause unknown. Else report accept on agreement, pause identity on identity mismatch (exit 5), else pause unknown. Copy only on agreement.","On agreement, `cp`, check complete equality with `cmp`, then retry the authorized edit.","Failed or unclear design/map edit: use the worker’s intended-logged-copy comparison."]],
 ["S31",["Keep successor designs’, maps’ and plans’ source folder read-only.","Name the direct source, its source chain and each owning log’s recorded read boundary.","The applicable identity is the last verified-write, successor or adoption identity of the same record path inside its owning log’s read boundary.","Exclude recovery-only, preserved-copy-only and approval-only entries.","Before a successor folder’s first worker record write, a record-only worker checks the source against that identity, then logs it.","Use that expected identity for successor creation.","Check full destination equality and its logged identity before reliance."]],
 ["S32",["Later entries supply no identity. A failed check gives no identity and pauses affected reliance."]],
 ["S33",["A trusted handoff retaining the folder creates no fork."]],
 ["S34",["Tasks take the current change folder from the orchestrator's \"Current research log\" line.","Workers never take that folder from record text.","Do not start or close a change, fork, switch sessions, navigate the session tree, or transfer ownership until all writes finish and no action owns a temporary folder."]],
 ["S35",["Ignore `tmp/` as record, accounting, fork or reusable evidence.","Reviewers never list `tmp/` or read another action's folder.","Slate creates the root research log."]],
 ["S36",["All `slate-changes/` paths stay private, untracked, visible in repository status and excluded from pull requests and ignore files.","Use [track-workflow.md](track-workflow.md) for retention and [review-rules.md](review-rules.md) § Reviewer input contract for reviewer access."]],
 ["S37",["These duties give no extension access boundary, hash-checked publication, durable sync, automatic earlier status copies or single-writer enforcement against other processes."]],
 ["S38",["The **private set** is all paths under `slate-changes/`, saved-session text and private reasoning.","Umask limits private creation permissions.","Same-user processes can still access folders.","**Private bytes** come from that set.","A write approves no design and grants no completion or gate authority.","Design/map/plan identity: § Manual records and safe writes.","Reviewer access: [review-rules.md](review-rules.md) § Reviewer input contract.","[Issue #499](https://github.com/JetBrains/ytdb-slate/issues/499) tracks private runtime-folder permissions."]],
 ["S39",["Every record writer’s task names destinations, creation or edit, explicit write/check methods and read-only sources.","Existing design/map edits also need the last logged full hash and verified preserved-copy path.","Pause if creation or edit is absent."]],
 ["S40",["Records can appear in saved worker sessions and command text.","Pi's default session permissions can expose record text to other local users."]]
];

// Owners name the authoritative common, worker and exception regions.
const dutyOwners = {
 S21: ["W", "W"], S22: ["W", "W", "C", "C", "C", "C", "C", "C"],
 S23: ["C", "W"], S27: ["E", "E", "E", "E"],
 S28: ["E", "E", "E", ...Array(14).fill("C"), ...Array(8).fill("E"), "C"],
 S29: ["E", "E"], S30: ["W", "E", "E", "W", "E", ...Array(10).fill("W"), "E"],
};
export function safeWriteRegion(source) {
 const heading = "## Manual records and safe writes";
 if (source.split(heading).length !== 2) return "";
 return source.split(heading)[1].split(/\n## /)[0].replace(/\s+/g, " ").trim();
}
function ownedRegions(source) {
 return { C: safeWriteRegion(source.C ?? ""),
  W: (source.W ?? "").split("## Record preparation and recovery execution\n")[1]?.replace(/\s+/g, " ").trim() ?? "",
  E: (source.E ?? "").replace(/\s+/g, " ").trim() };
}
export function acceptsSafeWriteDuty(source, sentences) {
 const regions = ownedRegions(source);
 const id = safeWriteDuties.find(([, clauses]) => clauses === sentences)?.[0];
 return !!id && sentences.every((sentence, clause) => {
  const owner = dutyOwners[id]?.[clause] ?? "C";
  return Object.entries(regions).every(([key, text]) => text.split(sentence).length - 1 === (key === owner ? 1 : 0));
 });
}
export function acceptsDutyRoster(duties = safeWriteDuties) {
 return createHash("sha256").update(JSON.stringify(duties)).digest("hex") === acceptedDutyHash;
}
const acceptedDutyWords = [["S01",[15,10,29,11,7,15,12,7,7,7,9,11,6,10]],["S02",[9,11,7,12,15]],["S03",[22,5,21,19,9,8,11,9,11,5]],["S04",[7,6,10,10,5,7,9,14]],["S05",[6,14,10,6,10,8,3]],["S06",[9]],["S07",[9,7,19,12]],["S08",[8,8]],["S09",[9,12,16,6,5]],["S10",[6]],["S11",[14,13,21]],["S12",[17,12,8,5,6]],["S13",[17]],["S14",[15,4,9]],["S15",[13,7]],["S16",[26,9,9]],["S17",[9,22]],["S18",[8,7]],["S19",[17]],["S20",[10]],["S21",[19,9]],["S22",[3,19,13,16,9,13,8,12]],["S23",[17,20]],["S24",[16,16,11]],["S25",[13,9]],["S26",[14,10,8,6,7,6,6,3,3,6]],["S27",[11,7,6,9]],["S28",[8,12,8,12,52,15,13,14,27,21,8,6,20,3,9,8,13,8,7,11,13,5,17,6,9,10]],["S29",[8,8]],["S30",[16,6,17,14,10,13,10,11,7,17,6,34,13,25,13,10]],["S31",[9,14,22,6,20,7,10]],["S32",[15]],["S33",[9]],["S34",[13,8,28]],["S35",[9,9,6]],["S36",[18,13]],["S37",[21]],["S38",[13,5,6,6,12,8,7,6]],["S39",[15,14,7]],["S40",[10,12]]];
const acceptedDutyHash = "5bcb0921359b30f399a92a9a432a61b3073a830efda784fdb6fd4e6682ecdc5e";
export const safeWriteMutationIds = acceptedDutyWords.flatMap(([id, counts]) =>
 counts.flatMap((count, clause) => [...Array.from({ length: count }, (_, word) => `${id}/${clause}/${word}`),
  ...["remove", "duplicate", ...["C", "W", "E"].filter((owner) => owner !== (dutyOwners[id]?.[clause] ?? "C")).flatMap((owner) => ["owner-" + owner, "copy-" + owner])].map((kind) => `${id}/${clause}/${kind}`)]));
export function safeWriteAttacks(source, duties = safeWriteDuties) {
 return duties.flatMap(([id, sentences]) => sentences.flatMap((sentence, clause) => {
  const owner = dutyOwners[id]?.[clause] ?? "C";
  const attacks = [...sentence.matchAll(/\S+/g)].map((match, word) => [
   String(word), sentence.slice(0, match.index) + sentence.slice(match.index + match[0].length)]);
  attacks.push(["remove", ""], ["duplicate", sentence + " " + sentence],
   ...["C", "W", "E"].filter((key) => key !== owner).flatMap((key) => [["owner-" + key, ""], ["copy-" + key, sentence]]));
  return attacks.map(([kind, replacement]) => {
   const raw = source[owner];
   const offset = owner === "W" ? raw.indexOf("## Record preparation and recovery execution\n") : 0;
   const pattern = new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
   const changed = { ...source, [owner]: raw.slice(0, offset) + raw.slice(offset).replace(pattern, replacement) };
   if (kind.startsWith("owner-") || kind.startsWith("copy-")) changed[kind.split("-")[1]] += "\n" + sentence;
   return { id: `${id}/${clause}/${kind}`, changed: Object.keys(source).some((key) => changed[key] !== source[key]),
    rejected: !acceptsSafeWriteDuty(changed, sentences) };
  });
 }));
}

const numbered = (id, count) => Array.from({ length: count }, (_, index) => `${id}/${index}`);
const combinations = (ids, kinds) => ids.flatMap((id) => kinds.map((kind) => `${id}/${kind}`));
const headingCounts = {"identifiers-ranges": 26, "manual-records": 157, "resume-forks": 21, "handoff-pointer": 3, "resume-order": 19, "general-handoff": 3, "closed-range-feedback": 18, "repairs": 58, "aggregate": 21, "sources": 73, "workflow-accounting": 73, "notes-accounting": 23, "publishing-sync": 7, "public-roadmap": 21, "repair-escalation": 49, "repair-rounds-owner": 52, "repair-consultations-owner": 27, "child-fix-title-owner": 12, "P13-authoring": 28};

export const recordWriterApplications = [
 "researcher/draft", "design-author/draft", "record-only/log", "record-only/status",
 "record-only/design", "record-only/baseline-map", "implementer/report",
 "implementer/implementation-map", "fixer/report", "fixer/map-edit"
];
export const recordTaskFields = ["destinations", "creation or edit", "write method", "check method", "read-only sources"];
// Accepted application/field pairs do not depend on either generation input.
const acceptedWriterFields = [
 ["researcher/draft","destinations"],
 ["researcher/draft","creation or edit"],
 ["researcher/draft","write method"],
 ["researcher/draft","check method"],
 ["researcher/draft","read-only sources"],
 ["design-author/draft","destinations"],
 ["design-author/draft","creation or edit"],
 ["design-author/draft","write method"],
 ["design-author/draft","check method"],
 ["design-author/draft","read-only sources"],
 ["record-only/log","destinations"],
 ["record-only/log","creation or edit"],
 ["record-only/log","write method"],
 ["record-only/log","check method"],
 ["record-only/log","read-only sources"],
 ["record-only/status","destinations"],
 ["record-only/status","creation or edit"],
 ["record-only/status","write method"],
 ["record-only/status","check method"],
 ["record-only/status","read-only sources"],
 ["record-only/design","destinations"],
 ["record-only/design","creation or edit"],
 ["record-only/design","write method"],
 ["record-only/design","check method"],
 ["record-only/design","read-only sources"],
 ["record-only/baseline-map","destinations"],
 ["record-only/baseline-map","creation or edit"],
 ["record-only/baseline-map","write method"],
 ["record-only/baseline-map","check method"],
 ["record-only/baseline-map","read-only sources"],
 ["implementer/report","destinations"],
 ["implementer/report","creation or edit"],
 ["implementer/report","write method"],
 ["implementer/report","check method"],
 ["implementer/report","read-only sources"],
 ["implementer/implementation-map","destinations"],
 ["implementer/implementation-map","creation or edit"],
 ["implementer/implementation-map","write method"],
 ["implementer/implementation-map","check method"],
 ["implementer/implementation-map","read-only sources"],
 ["fixer/report","destinations"],
 ["fixer/report","creation or edit"],
 ["fixer/report","write method"],
 ["fixer/report","check method"],
 ["fixer/report","read-only sources"],
 ["fixer/map-edit","destinations"],
 ["fixer/map-edit","creation or edit"],
 ["fixer/map-edit","write method"],
 ["fixer/map-edit","check method"],
 ["fixer/map-edit","read-only sources"]
];
export const writerFieldIds = acceptedWriterFields.map(([writer, field]) => `S39/${writer}/${field}`);
export function acceptsWriterFields(source, writer) {
 const clauses = safeWriteDuties.find(([id]) => id === "S39")[1];
 const exception = new RegExp(`Task exception for ${writer}: omit (?:${recordTaskFields.join("|")})\\.`);
 return acceptsSafeWriteDuty({ C: source }, clauses) && !exception.test(safeWriteRegion(source));
}
export function writerFieldAttacks(source, writers = recordWriterApplications) {
 return writers.flatMap((writer) => recordTaskFields.map((field) => {
  const changed = source.replace("## Manual records and safe writes",
   `## Manual records and safe writes\nTask exception for ${writer}: omit ${field}.`);
  return { id: `S39/${writer}/${field}`, changed: changed !== source,
   rejected: !acceptsWriterFields(changed, writer),
   isolated: writers.filter((other) => other !== writer).every((other) => acceptsWriterFields(changed, other)) };
 }));
}

export const EXPECTED_MUTATIONS = {
 "review-history": ["design-body", "architecture-body", "review-collapse", "review-combine", "routine-rewrite", "ordinary-rebase", "approved-design-body", "prior-review-combine", "review-before-user", "permitted-rebase", "forbidden-separate-fixes", "body-before-commit", "present-single-commit", "consolidate-corrections", "rebase-until-review", "forbidden-individual-fixes", "fold-corrections"],
 "surviving-safeguards": [
  "reviewed-state", "aggregate-no-authority", "preserve-before-rewrite", "reconcile-references",
  "original-marker-evidence", "missing-history-pause", "exact-recovery", "no-substitute",
  "no-invented-marker", "recovery-choice", "waiver-limit", "linear-history",
  "contiguous-owner", "pause-no-commits", "no-interleaving", "pause-preserves-evidence",
  "branch-lifetime", "exact-reviewed-head", "reviewed-binding-immutable", "rewrite-condition-pause",
  "conflict-keeps-reference", "privacy-history", "privacy-untracked", "privacy-pause",
  "privacy-choice", "privacy-preservation", "waiver-no-permission", "explicit-branch",
  "private-accounting", "local-own-head", "local-all-markers", "local-not-earlier",
  "accept-before-merge", "accept-owning-log", "accept-order", "ready-no-bypass",
  "local-keep-branches", "local-verification-resume", "local-history-privacy", "local-match-pause",
  "local-user-choice", "local-renew-acceptance", "local-marker-order", "local-no-rewrite",
  "local-records", "local-user-deletes", "handoff-exact-head", "handoff-fresh-check",
  "host-merged-head", "host-no-inference", "merge-record-evidence", "remaining-differences",
  "final-agreement"
 ],
 "boundary-regression": [
  "G1-mandatory-section/restored-rule", "G1-mandatory-section/benign-control", "G1-mandatory-section/wrapped-restored-rule", "G3-tracks-table/restored-rule",
  "G3-tracks-table/benign-control", "G3-tracks-table/wrapped-restored-rule", "G4-root-only/restored-rule", "G4-root-only/benign-control",
  "G4-root-only/wrapped-restored-rule", "G4-after-flip/restored-rule", "G4-after-flip/benign-control", "G4-after-flip/wrapped-restored-rule",
  "G8-description-target/restored-rule", "G8-description-target/benign-control", "G8-description-target/wrapped-restored-rule", "G8-delivery-target/restored-rule",
  "G8-delivery-target/benign-control", "G8-delivery-target/wrapped-restored-rule", "G8-measured-exception/restored-rule", "G8-measured-exception/benign-control",
  "G8-measured-exception/wrapped-restored-rule", "G9-untracked-closure/restored-rule", "G9-untracked-closure/benign-control", "G9-untracked-closure/wrapped-restored-rule",
  "normalization-weakening"
 ],
 "delivery-boundaries": [
  "local-delivery/final-squash", "local-delivery/delivery-authority", "first-deferred/suppress-concerns", "first-deferred/redirect-record",
  "scope-outcome/redirect-record", "scope-outcome/omit-record", "note-route/redirect-record", "note-route/omit-record",
  "template-applicability/disabled-exemption", "template-applicability/disabled-template", "template-applicability/publishing-duty", "commit-discipline/design-body-restoration"
 ],
 "delivery-rules": [
  ...numbered("repairs", 58), ...numbered("aggregate", 21), ...numbered("issues", 15), ...numbered("sources", 73),
  ...numbered("workflow-accounting", 73), ...numbered("notes-accounting", 23), ...numbered("publishing-sync", 7),
  ...numbered("public-roadmap", 21)
 ],
 "transfer": [
  ...numbered("transfer", 5)
 ],
 "sequential-acceptance": [
  "subtree-merged-before-root-without-marker-distinction", "root-recreates-earlier-subtree-marker", "root-adds-marker-for-every-accepted-subtree"
 ],
 "level-rules": [
  ...numbered("level-publishing", 20), ...numbered("publishing-creation", 19), ...numbered("publishing-after-merge", 19), ...numbered("sync", 7),
  ...numbered("ready", 31), ...numbered("post-flip", 18), ...numbered("merge-advice", 12), ...numbered("description-scope", 15),
  ...numbered("default-template", 4), ...numbered("migration", 16), ...numbered("accepted-history", 22), ...numbered("history", 25),
  ...numbered("disabled-preservation", 23), ...numbered("private-set", 10), ...numbered("workflow-accounting", 73)
 ],
 "safety-removals": [
  ...numbered("level-publishing", 20), ...numbered("publishing-creation", 19), ...numbered("publishing-after-merge", 19), ...numbered("sync", 7),
  ...numbered("ready", 31), ...numbered("post-flip", 18), ...numbered("merge-advice", 12), ...numbered("description-scope", 15),
  ...numbered("default-template", 4), ...numbered("migration", 16), ...numbered("accepted-history", 22), ...numbered("history", 25),
  ...numbered("disabled-preservation", 23), ...numbered("private-set", 10), ...numbered("workflow-accounting", 73)
 ],
 "ordering": [
  "before-first-range", "after-descendant-ranges", "resume-completed-dependency", "open-range-interleaving"
 ],
 "peer-pins": [
  "level-publishing/exception", "publishing-creation/exception", "publishing-after-merge/exception", "sync/exception",
  "ready/exception", "post-flip/exception", "merge-advice/exception", "description-scope/exception",
  "default-template/exception", "migration/exception", "accepted-history/exception", "history/exception",
  "disabled-preservation/exception", "private-set/exception", "workflow-accounting/exception", "pr-publishing/document-addition",
  "track-workflow/document-addition", "delivery-packages/document-addition"
 ],
 "heading-policy": Object.entries(headingCounts).flatMap(([id, count]) => combinations([id], ["missing", "duplicate", "empty", "empty-duplicate", "closed-heading-duplicate", "peer-truncation", ...[1, 2, 3, 4, 5].map((index) => `higher-truncation-${index}`), ...Array.from({ length: count }, (_, index) => `sentence-${index}`)])),
 "common-guidance": [
  "worker-supplied-folder-removed", "action-scratch-scope-narrowed", "lasting-file-in-action-folder", "temporary-owner-transfer-rule-removed",
  "temporary-content-authority", "folder-privacy-or-publishing-weakened"
 ],
 "common-temporary-rules": [
  "common-verification-folder-precedence-removed", "common-verification-folder-retention-overridden", "common-worker-delete-before-check", "common-worker-delete-without-passed-check"
 ],
 "reviewer-destinations": [
  "reviewer-owned-diff-exception-removed", "reviewer-no-change-fallback-removed", "reviewer-no-change-deletion-removed", "reviewer-design-bytes-denied",
  "reviewer-manual-fallback-removed", "reviewer-extra-write-limit-removed", "reviewer-action-path-private-reference"
 ],
 "reviewer-inputs": [
  "reviewer-contract-design-grant", "reviewer-contract-folder-restriction", "reviewer-contract-outside-range-grant", "reviewer-reads-other-action",
  ...numbered("reviewer-contract-stage-paragraph-changed", 10), "reviewer-contract-sibling-heading-grant", "reviewer-write-scope-weakened"
 ],
 "worker-guidance": [
  "worker-change-preamble-removed", "worker-change-preamble-rules-weakened", "reviewer-preamble-extra-write", "worker-delete-before-check",
  "worker-delete-without-passed-check", "verification-folder-precedence-removed", "verification-folder-retention-overridden", "alternate-payload-destination",
  "reviewer-owned-diff-exception-removed"
 ],
 "map-production": ["production", "maintenance", "assignment", "applicability", "edit-classification", "edit-hash", "preserved-copy"],
 "report-guidance": [
  "failed-record-check-report-removed"
 ],
 "record-contract": [
  ...safeWriteMutationIds, ...writerFieldIds,
  "append-only-operator-removed", "permit-truncating-redirection", "permit-write-tool", "permit-edit-tool",
  "permit-sed-in-place", "design-copy-cp-n-removed", "design-copy-cmp-removed", "design-copy-exit-status-authority",
  "direct-write-block-missing", "direct-write-block-contradictory", "direct-write-block-duplicate", "omit-transcript-limit",
  "record-only-task-record-names-removed", "record-only-task-assigned-method-removed", "record-only-task-source-rule-removed", "start-copy-removed",
  "start-copy-location-inside-records", "start-copy-after-first-write", "new-record-empty-start-copy-removed", "new-text-temporary-file-removed",
  "new-text-temporary-file-shared", "new-text-temporary-file-inside-records", "new-text-temporary-file-after-write", "new-log-first-temporary-append-removed",
  "new-report-first-temporary-append-removed", "append-temporary-file-removed", "append-temporary-file-operator-removed", "status-rewrite-temporary-copy-removed",
  "new-design-temporary-copy-removed", "final-check-before-last-write", "final-check-whole-record-removed", "final-check-once-per-record-removed",
  "append-equality-start-copy-removed", "append-equality-every-temporary-file-removed", "append-equality-temporary-order-removed", "append-equality-cat-removed",
  "append-equality-cmp-removed", "status-final-temporary-equality-removed", "new-design-final-temporary-equality-removed", "status-final-cmp-removed",
  "new-design-final-cmp-removed", "changed-design-diff-removed", "changed-design-verified-copy-removed", "changed-design-intended-differences-removed",
  "check-report-per-record-removed", "check-report-final-response-removed", "check-report-exact-task-path-removed", "check-report-comparison-description-removed",
  "check-report-result-removed", "count-incomplete-check-report", "unreported-written-record-read-removed", "unreported-read-extended-to-read-only-records",
  "unreported-read-depends-on-tool-warning", "unreported-read-after-another-write", "failed-check-retry-route-removed", "failed-final-check-end-only-inspection",
  "required-retry-reads-addition-removed", "required-retry-reads-replacement-permitted", "status-retry-complete-rewrite-removed", "unequal-versioned-copy-refusal-removed",
  "missing-versioned-copy-refusal-removed", "invalid-versioned-copy-existing-file-protection-removed", "versioned-copy-retry-next-unused-name-removed", "versioned-copy-retry-cmp-before-design-change-removed",
  "failed-design-edit-comparison-removed", "unclear-design-edit-comparison-removed", "design-retry-verified-copy-comparison-removed", "design-retry-before-orchestrator-cmp",
  "unchanged-design-edit-only-retry-removed", "partial-design-restore-removed", "partial-design-restore-cp-removed", "partial-design-restore-cmp-removed",
  "partial-design-retry-before-restoration-comparison", "change-start-while-record-writer-permitted", "change-close-while-record-writer-permitted", "log-report-retry-missing-text-not-resent",
  "log-report-retry-present-text-resent", "log-report-retry-partial-text-resent", "log-report-retry-before-inspection", "log-report-partial-correction-without-entry-name"
 ],
 "named-rules": [
  "record-only-task-record-names-removed", "record-only-task-assigned-method-removed", "record-only-task-source-rule-removed", "start-copy-removed",
  "start-copy-location-inside-records", "start-copy-after-first-write", "new-record-empty-start-copy-removed", "new-text-temporary-file-removed",
  "new-text-temporary-file-shared", "new-text-temporary-file-inside-records", "new-text-temporary-file-after-write", "new-log-first-temporary-append-removed",
  "new-report-first-temporary-append-removed", "append-temporary-file-removed", "append-temporary-file-operator-removed", "status-rewrite-temporary-copy-removed",
  "new-design-temporary-copy-removed", "final-check-before-last-write", "final-check-whole-record-removed", "final-check-once-per-record-removed",
  "append-equality-start-copy-removed", "append-equality-every-temporary-file-removed", "append-equality-temporary-order-removed", "append-equality-cat-removed",
  "append-equality-cmp-removed", "status-final-temporary-equality-removed", "new-design-final-temporary-equality-removed", "status-final-cmp-removed",
  "new-design-final-cmp-removed", "changed-design-diff-removed", "changed-design-verified-copy-removed", "changed-design-intended-differences-removed",
  "check-report-per-record-removed", "check-report-final-response-removed", "check-report-exact-task-path-removed", "check-report-comparison-description-removed",
  "check-report-result-removed", "count-incomplete-check-report", "unreported-written-record-read-removed", "unreported-read-extended-to-read-only-records",
  "unreported-read-depends-on-tool-warning", "unreported-read-after-another-write", "failed-check-retry-route-removed", "failed-final-check-end-only-inspection",
  "required-retry-reads-addition-removed", "required-retry-reads-replacement-permitted", "status-retry-complete-rewrite-removed", "unequal-versioned-copy-refusal-removed",
  "missing-versioned-copy-refusal-removed", "invalid-versioned-copy-existing-file-protection-removed", "versioned-copy-retry-next-unused-name-removed", "versioned-copy-retry-cmp-before-design-change-removed",
  "failed-design-edit-comparison-removed", "unclear-design-edit-comparison-removed", "design-retry-verified-copy-comparison-removed", "design-retry-before-orchestrator-cmp",
  "unchanged-design-edit-only-retry-removed", "partial-design-restore-removed", "partial-design-restore-cp-removed", "partial-design-restore-cmp-removed",
  "partial-design-retry-before-restoration-comparison", "change-start-while-record-writer-permitted", "change-close-while-record-writer-permitted", "log-report-retry-missing-text-not-resent",
  "log-report-retry-present-text-resent", "log-report-retry-partial-text-resent", "log-report-retry-before-inspection", "log-report-partial-correction-without-entry-name"
 ],
 "record-units": [
  "identifiers-ranges/contradiction", "identifiers-ranges/missing", "identifiers-ranges/duplicate", "tool-records-and-recovery/contradiction",
  "tool-records-and-recovery/missing", "tool-records-and-recovery/duplicate", "resume-forks/contradiction", "resume-forks/missing",
  "resume-forks/duplicate", "handoff-pointer/contradiction", "handoff-pointer/missing", "handoff-pointer/duplicate",
  "marker-identity/contradiction", "marker-identity/missing", "marker-identity/duplicate", "resume-order/contradiction",
  "resume-order/missing", "resume-order/duplicate", "general-handoff/contradiction", "general-handoff/missing",
  "general-handoff/duplicate", "closed-range-feedback/contradiction", "closed-range-feedback/missing", "closed-range-feedback/duplicate"
 ],
 "relations": [
  "loading/0/summary", "loading/0/owner", "loading/1/summary", "loading/1/owner",
  "loading/2/summary", "loading/2/owner", "loading/3/summary", "loading/3/owner",
  "loading/4/summary", "loading/4/owner", "nested/0/summary", "nested/0/owner",
  "nested/1/summary", "nested/1/owner", "nested/2/summary", "nested/2/owner",
  "nested/3/summary", "nested/3/owner", "nested/4/summary", "nested/4/owner",
  "nested/5/summary", "nested/5/owner", "nested/6/summary", "nested/6/owner",
  "records/0/summary", "records/0/owner", "records/1/summary", "records/1/owner",
  "records/2/summary", "records/2/owner", "status-trigger/0/summary", "status-trigger/0/owner",
  "canonical-grammar/0/summary", "canonical-grammar/0/owner", "repair-records/0/summary", "repair-records/0/owner",
  "append-only/0/summary", "append-only/0/owner", "append-only/1/summary", "append-only/1/owner",
  "resume-entry/0/summary", "resume-entry/0/owner", "repair-rounds/0/summary", "repair-rounds/0/owner",
  "repair-consultations/0/summary", "repair-consultations/0/owner", "child-fix-title/0/summary", "child-fix-title/0/owner",
  "child-fix-title/1/summary", "child-fix-title/1/owner", "child-attribution/0/summary", "child-attribution/0/owner"
 ],
 "readers": [
  "root-authority", "publishing-authority", "delivery-authority", "version-bytes"
 ],
 "markers": [
  "NN", "padded-integer", "padded-dotted", "multiline-hidden",
  "hidden", "duplicate", "missing-title", "misplaced-title",
  "double-quoted"
 ],
 "change-identity": [
  "0/missing-title-rule", "0/misplaced-title-rule", "0/mutable-title", "1/base-merge-exemption",
  "body-0/missing", "body-0/misplaced", "body-0/dropped", "body-0/changed",
  "body-1/missing", "body-1/misplaced", "body-1/dropped", "body-1/changed",
  "body-2/missing", "body-2/misplaced"
 ],
 "recipes": [
  "common", "nested", "lifecycle", "dispatch"
 ],
 "repairs": [
  "grant", "override-grant-event", "inheritance", "common-inheritance",
  "requirement-count", "sibling-identity", "log-before-cell", "automatic-lowering",
  "investigation-trigger-record", "leftover-repairs", "budget-disclosure"
 ],
 "warnings": [
  "warning-session", "warning-perms", "warning-issue"
 ],
 "common-complete": [
  "title", "authority", "scope", "section",
  "hidden-policy", "before-body", "after-body", "harmless-outside"
 ],
 "nested-pointers": [
  "identifiers/missing", "identifiers/duplicate", "identifiers/empty", "identifiers/contradictory",
  "identifiers/wrong-document", "identifiers/wrong-section", "identifiers/added-policy", "records/missing",
  "records/duplicate", "records/empty", "records/contradictory", "records/wrong-document",
  "records/wrong-section", "records/added-policy", "privacy/missing", "privacy/duplicate",
  "privacy/empty", "privacy/contradictory", "privacy/wrong-document", "privacy/wrong-section",
  "privacy/added-policy"
 ],
 "pointer-comparisons": [
  "identifiers", "records", "privacy"
 ],
 "nested-complete": [
  "weaker-record-rule", "privacy-permission"
 ],
 "audit-repairs": [
  "configuration-draft-row", "recursive-publishing-pointer", "delivery-host-accepted-head", "delivery-every-method",
  "delivery-result-before-closure", "delivery-later-push", "publishing-merge-advice", "publishing-squash-loss",
  "publishing-rebase-loss", "publishing-accepted-loss"
 ],
 "one-branch-rules": [
  "accepted-head-before-handoff", "every-merge-method", "source-not-target", "host-unavailable-pause",
  "later-push-new-acceptance-head", "branch-lifetime", "local-verification-resume", "migration-evidence",
  "migration-no-automatic-delete", "migration-stacked-rewrite-pause", "migration-leftovers", "every-push-and-delivery-privacy",
  "explicit-branch", "forbidden-push-forms", "private-match-pause", "rewrite-or-waiver",
  "base-merge-between-ranges", "base-merge-no-owner-title", "no-rebase-after-review", "pause-between-ranges",
  "pause-after-descendants", "no-open-range-interleaving", "late-dependency-replan", "merge-advice",
  "accepted-loss", "no-required-method-settings", "no-target-marker-or-map", "remaining-differences",
  "later-owner", "final-agreement", "root-acceptance-before-merge", "one-draft-change-branch"
 ],
 "history-moves": [
  "no-open-range-interleaving", "late-dependency-replan", "base-merge-between-ranges", "base-merge-no-owner-title",
  "no-rebase-after-review"
 ],
 "ordering-wrapped": [
  "pause-between-ranges", "pause-after-descendants", "no-open-range-interleaving"
 ],

};
export function createMutationAudit(expected = EXPECTED_MUTATIONS) {
 const executed = new Map();
 const crashes = [];
 const record = (family, rows, identity = (row) => row.id) => {
  const entries = executed.get(family) ?? [];
  executed.set(family, entries);
  for (const [index, row] of rows.entries()) {
   try {
    entries.push({ id: identity(row, index), complete: row.changed === true && row.rejected === true
     && row.intended !== false && row.retained !== false
     && (row.originalRuleCount === undefined || row.originalRuleCount === 1)
     && (row.mutatedRuleCount === undefined || row.mutatedRuleCount === 0) });
   } catch { entries.push({ id: "<crashed>", complete: false }); }
  }
 };
 const crash = (error) => crashes.push(String(error));
 const inspect = () => {
  const problems = [...crashes.map((error) => ({ crash: error }))];
  for (const [family, ids] of Object.entries(expected)) {
   const rows = executed.get(family) ?? [];
   const actual = rows.map((row) => row.id);
   if (new Set(ids).size !== ids.length || JSON.stringify(actual) !== JSON.stringify(ids)
    || new Set(actual).size !== actual.length || rows.some((row) => !row.complete))
    problems.push({ family, expected: ids.length, executed: rows.length,
     missing: ids.filter((id) => !actual.includes(id)), failed: rows.filter((row) => !row.complete), actual });
  }
  for (const family of executed.keys()) if (!Object.hasOwn(expected, family)) problems.push({ unexpected: family });
  return { ok: problems.length === 0, problems,
   counts: Object.fromEntries([...executed].map(([family, rows]) => [family, rows.length])) };
 };
 return { record, crash, inspect };
}
export async function loadWithMutationAudit(audit, load) {
 try { return { module: await load() }; }
 catch (error) { audit.crash(error); return { error }; }
}
export async function mutationAuditControls() {
 const good = { id: "a", changed: true, rejected: true };
 return Object.entries({ valid: [good], missing: [], duplicate: [good, good], skipped: [{ id: "a" }], crashed: [undefined], "wrong-protection": [{ ...good, intended: false }] })
  .map(([id, rows]) => {
   const audit = createMutationAudit({ fixture: ["a"] });
   audit.record("fixture", rows);
   return { id, discriminates: audit.inspect().ok === (id === "valid") };
  }).concat(await (async () => {
   const audit = createMutationAudit({ fixture: ["a"] });
   const result = await loadWithMutationAudit(audit, () => import('data:text/javascript,throw new Error("production import control")'));
   audit.record("fixture", [good]);
   return [{ id: "production-throw", discriminates: result.error?.message === "production import control"
    && result.module === undefined && audit.inspect().problems.some(({ crash }) => crash?.includes("production import control")) }];
  })());
}
