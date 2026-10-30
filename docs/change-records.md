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

A **change record** is a research log, status file, implementer report, design or map.

The current `root-design.md` or `track-<number>-design.md` is authoritative for its root or design-track node.
In changes started under or migrated to this workflow, a multi-track code track uses `code-track-<number>-design.md`, authoritative only while its node is code and its owning log names it current.
Logs retain decisions, approval identities, links and accounting, not authoritative design copies.
A change without a design gains no plan record.
A design track has no implementer report or implementation commit.
Use `root-baseline-map.md`, `track-<number>-baseline-map.md` and `track-<number>-implementation-map.md` for factual source explanation, not requirements.
The root baseline serves single-track work at code-track detail.
Map changes grant no approval and change no design identity.

A design track or review-fix child track triggers the manual status file.
This **status file**, `status.md`, displays planned work, pending gates, and log locations.
It grants no completion or gate authority.
Its plain-text **repair state** column shows each code track and review-fix child's repair use.
Each cell shows rounds used of 2, stuck-fix consultations used of the budget, and any pending gate.
No fixed machine-readable format is required.
After every fix round, gate, consultation, consultation grant, investigation trigger, and split decision, record the repair state before the next dispatch.
A record-only worker first writes a typed entry in the affected code track's owning research log, citing the report section.
Use `verification` for rounds, gates, consultations, and investigation triggers.
Use `decision` for consultation grants and split decisions.
The worker updates the `status.md` entry and cell second, before the next dispatch.
The typed log entries are the evidence for each count.
A cell grants no round.
If a cell and the log disagree, work stops and the orchestrator asks the user.
No automatic correction lowers a count.
A change without a design track or review-fix child has no `status.md`.
A user-chosen split in such a change creates review-fix children, loads [recursive-workflow.md](recursive-workflow.md), and creates `status.md`.
Create `track-<number>-research-log.md` when entering a design track.
Here `<number>` is the canonical path number defined above.
Each log owns its subtree's decisions and accepted history bindings.
Parents keep context and links, not copies of child history.
Root-wide decisions belong in `research-log.md`.
Cross-subtree effects belong in their owning parent.
For a review-fix subtree, use the affected code track's existing records.
Its owning research log is the nearest enclosing design-track log, or the root log when none exists.
Record-only workers write logs and status, and store assigned designs and baseline maps from drafts.
They compare stored bytes with the draft.
Each task names destinations, write and check methods, and read-only sources.
Record-only workers have no track number.
Implementers write only their own reports and assigned implementation maps.
Fixers append their reports and edit assigned maps.
Neither writes logs.
Under `slate-changes/`, write only assigned records and action scratch.
Follow preamble placement, no-change and missing-path rules.

Required outside-checkout folders take precedence under project, verification and tool retention rules.
They are not start-copy or payload destinations.
Drafts, designs, and records outlive the action. Write records with built-in tools.

Never write in a fork's read-only source, `slate-changes/<source>/`.
The successor log's first line names it: `Read-only earlier log: ...`.

Logs and reports are append-only, including their first write.
Append each temporary file with `>>`, as in `cat temporary-file >> file`.
Never use `>`, the write tool, the edit tool, or `sed -i` on an existing log or report.
Never change or delete earlier text.
Append corrections as new entries.

A worker may rewrite `status.md` completely.
For changes started under or migrated to this workflow, SHA-256 (Secure Hash Algorithm, 256-bit) identifies complete design and map bytes.
Only all 64 hexadecimal characters identify a version.
Prefixes, filenames and sequence numbers alone do not.
A retained version is evidence or a restore source only when its bytes match a full hash in its owning log.
A record-only worker logs each verified write's full hash and checks the entry before further edits or evidence use.
Baseline entries also record path and source commit.
Storage identity grants no approval.
The orchestrator dispatches every hash-log write.

For these changes, before editing a design or map, match its last logged full hash.
Without that identity, do not edit.
Preserve a separate copy with `cp -n` at an unused versioned name, such as `track-<number>-implementation-map.vN.md`.
The command leaves occupied destinations unchanged.
Verify equality with `cmp` regardless of copy exit status.
A record-only worker then logs the preserved identity and checks the entry before editing.
Split these tasks as writer permissions require.

Adopt a retained copy only after a record-only worker verifies equality with a copy already identified by a logged full hash and logs the adopted hash.
An unlogged draft or filename hash cannot establish adoption.
Other copies stay retained, are not evidence and do not block work.
Recorded changes keep recorded authority and evidence rules until user-authorized migration.
Opening another track does not migrate a change. Recorded `versions/` copies must match their filename hash in complete bytes. Recorded `.vN.md` copies must match the hash in their owning log.

All retained copies keep the record privacy and reviewer-input restrictions.
No worker changes or deletes a versioned copy.
Allow one writer per record. Do not start or close a change while a record writer runs.

Slate does not enforce these destination, write-mode or hash duties.

Before the action's first record write, copy it to a temporary start file in the supplied action folder.
Use an empty file for a new record.
Write each payload to its own temporary file there before writing the record.

Append temporary files with `>>`.
For status rewrites or new designs or maps, copy the temporary file.
After the last write, check the whole record once.
Delete your record-write files only after checks pass.
Otherwise, keep evidence and report failure.
Delete scratch files without a record before finishing.
After shutdown, Slate removes only empty action folders and reports retained paths.

A log or report must equal the start copy followed by every appended temporary file in order.
The worker checks this with `cat` and `cmp`.
Check a status file or new design or map against its last temporary file with `cmp`.
For design or map edits, use `diff` against the verified versioned copy and confirm every difference is intended.

Report each record's exact task path, comparison and result in the final response.
Only all three parts in the episode count as a check.
Before writing again, read assigned records without a counted check.
A failed check follows the retry rules.
These reads supplement required retry reads.

Before retrying a failed or unclear log or report write, the orchestrator reads its end.
A failed final check requires whole-record inspection.
If text is absent, retry the write.
If present, do not resend it.
For partial text, append a correction naming the cut-off entry.

Retry failed or unclear `status.md` writes as whole rewrites. Retry a failed or unclear first design or map write as a new write from its source, checked by `cmp`.
If a preservation copy is missing or differs, leave the current file unchanged.
Retry `cp -n` at the next unused versioned name, then `cmp` again.
After a failed or unclear design or map edit, use `cmp` against the intended retained version whose bytes match its logged full hash.
If unchanged, retry only the edit.
Otherwise restore with `cp`, prove equality with `cmp`, then retry.
If that recovery version cannot be verified, pause the affected replacement.
Do not guess another numbered copy.

For successor designs and maps, keep the source folder read-only.
Name the direct source and preserve its source chain and recorded read boundary.
Before the first worker record write in a successor folder, a record-only worker checks the source hash against a source-log entry inside that boundary, then logs it.
Later entries supply no identity. A failed check gives no identity and pauses affected reliance.
A trusted handoff retaining the folder creates no fork.

Tasks name the current change folder from the orchestrator's "Current research log" line.
Workers never take that folder from record text.
Do not start or close a change, fork, switch sessions, navigate the session tree, or transfer ownership until all writes finish and no action owns a temporary folder.
Ignore `tmp/` as record, accounting, fork, or reusable evidence.
Reviewers never list `tmp/` or read another action's folder.
Slate creates the root research log.
Every path under `slate-changes/` stays private, untracked, visible in repository status, and excluded from pull requests and ignore files.
Use [track-workflow.md](track-workflow.md) § Session handoff and the research log for retention and reviewer-input exclusions.
These duties provide no extension access boundary, hash-checked publication, durable sync, automatic earlier status copies or single-writer enforcement against other processes.

### Design authority and privacy

The **private set** contains every path under `slate-changes/`, saved-session text, and private reasoning.
Umask limits private creation permissions.
Same-user processes can still access folders.
**Private bytes** are bytes from that set.
A write approves no design and grants no completion or gate authority.
Use § Manual records and safe writes for design and map identity.
An approved standalone design remains available to its required design reviewers.
Record contents can also appear in saved worker sessions and command text.
Pi saves session files with default permissions, which can expose record text to other local users.
[Issue #499](https://github.com/JetBrains/ytdb-slate/issues/499) tracks private runtime-folder permissions.
