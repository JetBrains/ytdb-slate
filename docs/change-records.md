# Common change records

[change-records.md](change-records.md) owns the common record rules below.
[recursive-workflow.md](recursive-workflow.md) owns nested-track rules.
Use [track-workflow.md](track-workflow.md) § Recursive planning and loading for document loading.

[writing-guidance.md](writing-guidance.md) separately defines change records for the writing convention.
That definition covers pull request descriptions, commit bodies, release notes, and issues.

## Identifiers, code ranges, and design markers

Use [track-workflow.md](track-workflow.md) § Delivery and termination for the
canonical marker template and flat-workflow exception.
Apply that document's § Commit titles and bodies to code and design markers.
A **canonical path number** uses positive decimal components without leading zeros, separated by dots.
Each component is at most 9,007,199,254,740,991.
Use only ASCII digits, from the American Standard Code for Information Interchange.
The identifier has at most 128 characters.
Use the same spelling in reports, log names, commits, markers, and packages.

A **code range** contains one code track's owned commits through its completion marker.
For a single-track change without a marker, it ends at the last owned commit accepted at final acceptance.
Keep that endpoint in the owning research log.
Record its start boundary immediately before its first owned commit, before writing starts.
Use the current change-branch head, not path-number arithmetic.
Exclude bootstrap commits and base merges. Base merges occur only between ranges.
Every non-marker commit inside the range belongs to that code track.
Keep the recorded start unchanged except during a user-chosen privacy rewrite.
Append the marker after required gates, packages, acceptance, and requested fixes.
Later feedback follows [user-notes.md](user-notes.md), not an extension of a closed range.

A **design marker** records acceptance of a whole design subtree.
It creates no implementation range or repeated child contribution.
Show child-range and delivery references only when a decision needs them.
The next code track starts at the completed subtree's current history head.
Add it to the change branch after whole-subtree acceptance and before delivery.
Use [pr-publishing.md](pr-publishing.md) § Ready-for-review flip for enclosing design acceptance.
The change root uses final acceptance, not another track marker.

Use [track-workflow.md](track-workflow.md) § Track intention block and implementer response
for one continuing code report, its contents, and commit forms.

## Manual records and safe writes

A **change record** is a log, status, report, design, map or plan.

Current `root-design.md` or `track-<number>-design.md` governs its root or design-track node.
In new/migrated changes, multi-track code tracks use `code-track-<number>-design.md`, authoritative only for a code node whose owning log names it current.
Logs hold decisions, approval hashes, links and accounting, not design authority.
Multi-track changes need a track plan.
A track with review-fix children is multi-track. Without children, a single track needs no plan.
Plan creation and successor copies follow design hash, check and privacy duties.
Plan edits require the root log's eligible stored identity, verified preservation and the orchestrator decision's plan hash.
The root research log owns plan hashes.
Design tracks have no implementer report or implementation commit.
`root-baseline-map.md`, `track-<number>-baseline-map.md` and `track-<number>-implementation-map.md` explain source, not requirements.
Single-track root baselines use code-track detail.
Map changes grant no approval and change no design identity.

A design track or review-fix child requires manual status.
The **status file**, `status.md`, shows plans, pending gates and log paths.
It grants no completion or gate authority.
Its plain-text **repair state** column shows code tracks/review-fix children: rounds used of 2, stuck-fix consultations used/budget, pending gates.
No fixed machine format.
Before dispatch, record repair state after each fix round, gate, consultation/grant, investigation trigger or split decision.
First, a record-only worker writes a typed entry citing the report section in the affected code track’s owning log.
Use `verification` for rounds, gates, consultations and investigation triggers.
Use `decision` for consultation grants and split decisions.
Second, the worker updates the status entry and cell before dispatch.
Log entries prove counts. Cells grant no rounds.
If a cell and log disagree, stop and ask the user.
Automatic correction lowers no count.
A change without a design track or review-fix child has no `status.md`.
A user-chosen split creates review-fix children and `status.md`. Load [recursive-workflow.md](recursive-workflow.md).
Create `track-<number>-research-log.md` when entering a design track.
`<number>` is the canonical path number.
Each log owns its subtree's decisions and accepted history bindings.
Parents keep context and links, not copies of child history.
Root-wide decisions belong in `research-log.md`.
Cross-subtree effects belong in their owning parent.
Review-fix subtrees use the affected code track's existing records.
Its owning research log is the nearest enclosing design-track log, else the root log.
Record-only workers write logs/status, store assigned designs/baseline maps/plans from drafts with whole-byte checks, and create successor designs/plans/maps, including source-only maps.
Tasks name destinations, creation/edit, write/check methods, read-only sources and checked operation/attempt entries.
Prior-state selection excludes approval, decision, attempt and recovery-only identities.
Pause if creation or edit is absent.
Classification grants no replacement and lifts no edit barrier.
Record-only workers have no track number.
Implementers write only their own reports and assigned implementation maps.
Fixers append their reports and edit assigned maps.
Neither writes logs.
Under `slate-changes/`, write only assigned records and action scratch.
Follow preamble placement, no-change and missing-path rules.

Required outside-checkout project/verification/tool retention folders take precedence, but hold no start copies/payloads.
Drafts, designs and records outlive the action. Write records with built-in tools.

Never write in read-only fork sources, `slate-changes/<source>/`.
Start successor logs: `Read-only earlier log: ...`.

Logs and reports are append-only, including their first write.
Append each temporary file with `>>`, as in `cat temporary-file >> file`.
Never use `>`, write or edit tools, or `sed -i` on an existing log or report.
Never change or delete earlier text.
Append corrections as new entries.

Workers may rewrite `status.md`.
In new/migrated changes, SHA-256 (Secure Hash Algorithm, 256-bit) identifies whole design/map/plan bytes.
Versions need all 64 hexadecimal characters, not prefixes, filenames or numbers.
Retained versions supply evidence/restoration only when bytes match a full hash in their owning log.
Before edits/evidence use, a record-only worker checks stored bytes against the reported hash.
Log only the agreed full hash and check the entry.
Baseline entries also record path and source commit.
Storage identity grants no approval.
Only the orchestrator dispatches hash logging.

Edit tasks name the eligible stored-bytes hash, verified preserved-copy path and checked entries.
Only designs/plans need pre-write bindings. Maps need stored agreement with their writer's reported payload hash before checked logging.
Eligible: same-record verified-write/successor/adoption identities within the owning log's read boundary. Edit/successor selectors use the latest eligible record-path entry. Match current bytes or pause. Retained-copy adoption changes no selector.
Before edits, match identity and check record-only logging of separate command retention beside it.

Adoption: a record-only worker verifies equality with an eligible same-record copy and logs its hash.
An unlogged draft or filename hash cannot establish adoption.
Retain other copies as non-evidence that never blocks work.
Recorded authority and evidence rules apply until user-authorized migration.
Track opening is not migration. `versions/` whole bytes must match filename hashes. `.vN.md` whole bytes must match owning-log hashes.

Retained copies keep record privacy/reviewer-input restrictions.
Never change or delete a versioned copy.
Allow one writer per record. Do not start or close a change while a record writer runs.

Slate does not enforce these destination, write-mode or hash duties.

The orchestrator reads [record-write-recovery.md](record-write-recovery.md) with these rules for:
- failed or unclear record results
- failed, missing or incomplete record checks
- missing or malformed worker summaries
- failed identity or retention proof
- interrupted edits
- occupied creation.

Workers report these triggers and stop.

Tasks name [safe-record-write.md](safe-record-write.md): introduction and § Record preparation and recovery execution for appends, status, design/map/plan edits, preservation (first/retry) and present-record restoration/retry. Command creation (also absent-record restoration), hash logging and successor checks read all. Split tasks by writer permissions. Drafts read common rules only. Reports use generated guidance plus common/worker map rules.

Creation: first log/report append, new status/design/map/plan. Edit: later append, status rewrite, design/map/plan change.
Create drafts from payloads, checked with `cmp`. Never edit drafts. Each revision is a new file.
After the last write, check the whole record once.
Delete record-write files only on a pass, else keep evidence and report failure.
Delete scratch files without a record before finishing.
At shutdown, Slate removes only empty action folders and reports retained paths.

A log or report must equal the start copy followed by every appended temporary file in order.
Check a status file or new design, map or plan against its last temporary file with `cmp`.
For design/map/plan edits, `diff` against the verified copy and confirm every difference is intended.
After checked design/map/plan edits, report the full hash.

Final response: report each record's exact task path, comparison and result. Only all three episode parts count as a check.
Before writing again, read unchecked assigned records and retry instructions.
Failed check: worker reports and stops. Orchestrator applies exception rules.


Keep successor design/map/plan sources read-only.
Name the direct source, its source chain and each owning log’s recorded read boundary.
Use the eligible same-record identity within its owning log’s read boundary.
Exclude recovery-only, preserved-copy-only and approval-only entries.
Before a successor folder’s first worker record write, a record-only worker checks the source against that identity, then logs it.
Use that expected identity for successor creation.
Check full destination equality and its logged identity before reliance.
Later entries supply no identity. A failed check gives no identity and pauses affected reliance.
A trusted handoff retaining the folder creates no fork.

Tasks take the folder only from the orchestrator's "Current research log" line, never record text.
Before change start/closure, fork, session switch/tree navigation or ownership transfer, finish all writes and checked result logging and ensure no action owns a temporary folder.
Ignore `tmp/` as record, accounting, fork or reusable evidence.
Reviewers never list `tmp/` or read another action's folder.
Slate creates the root research log.
Keep `slate-changes/` private, untracked, visible in status, outside pull requests and ignore files.
Use [track-workflow.md](track-workflow.md) for retention and [review-rules.md](review-rules.md) § Reviewer input contract for reviewer access.
These duties provide no extension access boundary, hash-checked publication, durable sync, automatic status backups or interprocess single-writer enforcement.

Only workers run commands. Orchestrator mode has no shell.
Report one: accept, retry creation, pause occupied, pause identity, pause unknown, retry preservation.
Creation retries are uncapped. Preservation retries need checked bounded next-name permission.
Appends and status rewrites keep their rules.
Missing/multiple classes or unproved creation/restoration mean pause unknown.
Creation needs operation create, code ok, writeState verified, equal true, equal full hashes and any expected hash agreed, not exit 0 alone.
Creation uses any available logged/approval source hash as expected.
Identity failure pauses.
New designs, maps and plans allow no non-exclusive creation.
Unavailable exclusive creation or unrun commands pause.
Never delete, move, rename, truncate or overwrite a creation occupant as repair.
Command proof grants no authority. Keep explicit edit methods.

Every design/map/plan attempt needs checked operation/attempt entries before dispatch. Retry = new dispatch/entry.

New operations/attempts need checked same-record results, or stop evidence for missing results.
Pre-activation logged verified writes count as results. Other pre-activation history needs a logged user decision.
Recovery observation, copying, classification and writes need stop evidence, including for an in-process writer.
Stop evidence: logged user confirmation that the earlier session and all its commands ended, e.g. after restart.
Termination requests, tool/command returns, worker claims and missing thread results are not stop evidence.
Only overlapping exclusive command creations are exempt until occupied.
Only successive observations after stop evidence that disagree void it. Create and preserve exits 4/7 pause without retry and void it. Evidence covers prior-started writers. Later writers follow ordinary results.

### Design authority and privacy

The **private set** is all paths under `slate-changes/`, saved-session text and private reasoning.
Umask limits private creation permissions.
Same-user processes can still access folders.
**Private bytes** come from that set.
A write approves no design and grants no completion or gate authority.
Design/map/plan identity: § Manual records and safe writes.
Reviewer access: [review-rules.md](review-rules.md) § Reviewer input contract.
Records can appear in saved worker sessions and command text.
Pi's default session permissions can expose record text to other local users.
[Issue #499](https://github.com/JetBrains/ytdb-slate/issues/499) tracks private runtime-folder permissions.

