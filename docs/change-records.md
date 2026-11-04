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

A **change record** is a research log, status file, implementer report, design, map or plan.

The current `root-design.md` or `track-<number>-design.md` is authoritative for its root or design-track node.
In changes started under or migrated to this workflow, a multi-track code track uses `code-track-<number>-design.md`, authoritative only while its node is code and its owning log names it current.
Logs hold decisions, approval identities, links and accounting, not design authority.
Every multi-track change creates a track plan.
A single track with review-fix children counts as multi-track.
A single track without children needs no plan.
Plan creation and successor copies follow design hash, check and privacy duties.
Pause plan edits and ask the user.
A plan hash identifies bytes, not approval.
The root research log owns plan hashes.
A design track has no implementer report or implementation commit.
Use `root-baseline-map.md`, `track-<number>-baseline-map.md` and `track-<number>-implementation-map.md` for factual source explanation, not requirements.
The root baseline serves single-track work at code-track detail.
Map changes grant no approval and change no design identity.

A design track or review-fix child track triggers the manual status file.
The **status file**, `status.md`, shows plans, pending gates and log paths.
It grants no completion or gate authority.
Its plain-text **repair state** column shows each code track and review-fix child’s rounds used of 2, stuck-fix consultations used/budget and pending gates.
No fixed machine format required.
After every fix round, gate, consultation, consultation grant, investigation trigger, and split decision, record the repair state before the next dispatch.
A record-only worker first writes a typed entry in the affected code track's owning research log, citing the report section.
Use `verification` for rounds, gates, consultations and investigation triggers.
Use `decision` for consultation grants and split decisions.
The worker updates the `status.md` entry and cell second, before the next dispatch.
Typed log entries prove counts. Cells grant no rounds.
If a cell and log disagree, stop and ask the user.
Automatic correction lowers no count.
A change without a design track or review-fix child has no `status.md`.
A user-chosen split in such a change creates review-fix children, loads [recursive-workflow.md](recursive-workflow.md), and creates `status.md`.
Create `track-<number>-research-log.md` when entering a design track.
`<number>` is the canonical path number.
Each log owns its subtree's decisions and accepted history bindings.
Parents keep context and links, not copies of child history.
Root-wide decisions belong in `research-log.md`.
Cross-subtree effects belong in their owning parent.
Review-fix subtrees use the affected code track's existing records.
Its owning research log is the nearest enclosing design-track log, else the root log.
Record-only workers write logs and status.
They store assigned designs, baseline maps and plans from drafts and compare complete bytes.
They create successor designs, plans and maps, including maps found only in the source folder.
Every record writer’s task names destinations, creation or edit, explicit write/check methods and read-only sources.
Existing design/map edits also need the last logged full hash and verified preserved-copy path.
Pause if creation or edit is absent.
Classification grants no replacement and lifts no edit barrier.
Record-only workers have no track number.
Implementers write only their own reports and assigned implementation maps.
Fixers append their reports and edit assigned maps.
Neither writes logs.
Under `slate-changes/`, write only assigned records and action scratch.
Follow preamble placement, no-change and missing-path rules.

Required outside-checkout folders take precedence under project, verification and tool retention rules, but hold no start copies or payloads.
Drafts, designs and records outlive the action. Write records with built-in tools.

Never write in a fork's read-only source, `slate-changes/<source>/`.
The successor log starts: `Read-only earlier log: ...`.

Logs and reports are append-only, including their first write.
Append each temporary file with `>>`, as in `cat temporary-file >> file`.
Never use `>`, write or edit tools, or `sed -i` on an existing log or report.
Never change or delete earlier text.
Append corrections as new entries.

A worker may fully rewrite `status.md`.
For changes started under or migrated to this workflow, SHA-256 (Secure Hash Algorithm, 256-bit) identifies complete design and map bytes.
Only all 64 hexadecimal characters identify a version, not prefixes, filenames or sequence numbers.
A retained version is evidence or a restore source only if its bytes match a full hash in its owning log.
Before further edits or evidence use, a record-only worker checks the stored file with the reported hash as expected.
The worker logs only that agreed full hash and checks the entry.
Baseline entries also record path and source commit.
Storage identity grants no approval.
The orchestrator dispatches all hash logging.

Before editing a design or map in these changes, match its last logged full hash or pause.
Preserve a separate copy with `cp -n` at an unused versioned name, such as `track-<number>-implementation-map.vN.md`.
Leave occupied destinations unchanged.
Check complete equality with `cmp` regardless of copy exit status.
A record-only worker then logs the preserved identity and checks the entry before editing.
Split these tasks as writer permissions require.

Adopt a retained copy only after a record-only worker verifies equality with a copy already identified by a logged full hash and logs the adopted hash.
An unlogged draft or filename hash cannot establish adoption.
Retain other copies as non-evidence that never blocks work.
Recorded changes keep recorded authority and evidence rules until user-authorized migration.
Opening another track does not migrate a change. Recorded `versions/` copies must match their filename hash in complete bytes. Recorded `.vN.md` copies must match the hash in their owning log.

Retained copies keep record privacy and reviewer-input restrictions.
Never change or delete a versioned copy.
Allow one writer per record. Do not start or close a change while a record writer runs.

Slate does not enforce these destination, write-mode or hash duties.

Before an action’s first record write, copy the record to a temporary start file in its action folder.
For a new record, use an empty start file.
Write each payload to its own temporary file there first.

Append temporary files with `>>`.
For status creation or rewrites, copy the temporary file. Create new designs, maps and plans with the command below.
Creation: first log/report append, new status/design/map/plan. Edit: later append, status rewrite, design/map/plan change.
Create drafts from payloads, checked with `cmp`. Never edit drafts. Each revision is a new file.
After the last write, check the whole record once.
Delete record-write files only on a pass, else keep evidence and report failure.
Delete scratch files without a record before finishing.
On shutdown, Slate removes only empty action folders and reports retained paths.

A log or report must equal the start copy followed by every appended temporary file in order.
The worker checks this with `cat` and `cmp`.
Check a status file or new design or map against its last temporary file with `cmp`.
For design/map edits, use `diff` against the verified versioned copy and confirm each difference is intended.
After a design/map edit passes its check, report its full hash.

Report each record's exact task path, comparison and result in the final response.
Only all three episode parts count as a check.
Before writing again, read assigned records without a counted check, in addition to required retry reads.
Failed checks follow the retry rules.

Before retrying a failed or unclear log or report write, the orchestrator reads its end.
Failed final checks require whole-record inspection.
Retry absent text. Never resend present text.
For partial text, append a correction naming the cut-off entry.

Retry failed or unclear `status.md` writes as whole rewrites.
A logged interrupted edit stays an edit even if its destination vanishes.
Failed or unclear creation may retry only through the command-result rules below.
If a preservation copy is missing or differs, leave the current file unchanged.
Retry `cp -n` at the next unused versioned name, then `cmp`.
After a failed or unclear design or map edit, use `cmp` against the intended retained version whose bytes match its logged full hash.
If unchanged, retry only the edit.
Otherwise restore with `cp`, prove equality with `cmp`, then retry.
If that recovery version cannot be verified, pause the affected replacement.
Never guess another numbered copy.

Keep successor designs’, maps’ and plans’ source folder read-only.
Name the direct source, its source chain and each owning log’s recorded read boundary.
The applicable identity is the last verified-write, successor or adoption identity of the same record path inside its owning log’s read boundary.
Exclude recovery-only, preserved-copy-only and approval-only entries.
Before a successor folder’s first worker record write, a record-only worker checks the source against that identity, then logs it.
Use that expected identity for successor creation.
Check full destination equality and its logged identity before reliance.
Later entries supply no identity. A failed check gives no identity and pauses affected reliance.
A trusted handoff retaining the folder creates no fork.

Tasks take the current change folder from the orchestrator's "Current research log" line.
Workers never take that folder from record text.
Do not start or close a change, fork, switch sessions, navigate the session tree, or transfer ownership until all writes finish and no action owns a temporary folder.
Ignore `tmp/` as record, accounting, fork or reusable evidence.
Reviewers never list `tmp/` or read another action's folder.
Slate creates the root research log.
Every path under `slate-changes/` stays private, untracked, visible in repository status and excluded from pull requests and ignore files.
Use [track-workflow.md](track-workflow.md) for retention and [review-rules.md](review-rules.md) § Reviewer input contract for reviewer access.
These duties give no extension access boundary, hash-checked publication, durable sync, automatic earlier status copies or single-writer enforcement against other processes.

Only workers run the command because orchestrator mode has no shell tool.
Every command task names [safe-record-write.md](safe-record-write.md) for syntax, proofs and the operation-and-exit table.
Workers report exactly one class: accept, retry creation, pause occupied, pause identity or pause unknown.
For command results, only retry creation permits another attempt, with no added cap.
Log appends, status rewrites, `cp -n` copies and edit retries keep their own rules.
A worker report with no defined class, several classes or accept without the proof below means pause unknown.
Creation acceptance needs operation create, code ok, writeState verified, equal true and full destinationHash = sourceHash = expected hash when supplied.
Without expected, both full hashes must still agree.
Exit 0 alone is not proof.
The first creation and every retry supply the source’s logged or approval hash as expected when the task holds one.
Identity failure pauses.
New designs, maps and plans allow no non-exclusive creation.
Unavailable exclusive creation or an unrun command pauses.
For creation, an occupied name is never deleted, moved, renamed, truncated or overwritten as a repair.
Occupied creation pauses for record-only classification even if equal.
Recovery work delivers classification. Until then, ask the user.
An exit 3 result is never logged as a write identity.
Known exits 2, 5, 6, 8, unavailable exclusive creation and a command that cannot run take precedence.
For create, no command report, an invalid report or a signal means retry creation with the same expected hash.
An occupant then gives pause occupied.
Other unclear command results mean pause unknown.
While preservation is inactive, every preserve operation-and-exit pair maps to pause unknown.
Command proof grants no file authority. Keep explicit edit methods.

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
