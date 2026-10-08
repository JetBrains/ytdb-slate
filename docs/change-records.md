# Common change records

For record writing, a **change record** is a research log, status file, implementer report, or design file.
[change-records.md](change-records.md) owns the common record rules below.
[recursive-workflow.md](recursive-workflow.md) owns nested-track rules.
Use [track-workflow.md](track-workflow.md) § Recursive planning and loading for document loading.

[writing-guidance.md](writing-guidance.md) separately defines change records for the writing convention.
That definition covers pull request descriptions, delivery commit bodies, release notes, and issues.

## Identifiers, code ranges, and design markers

Use [track-workflow.md](track-workflow.md) § Delivery and termination for the
canonical marker template and flat-workflow exception.
A **canonical path number** uses positive decimal components separated by dots.
Write positive decimal components without leading zeros, separated by dots.
Each component is at most 9,007,199,254,740,991.
Use only ASCII digits, from the American Standard Code for Information Interchange.
The identifier has at most 128 characters.
Use the same spelling in reports, log names, commits, markers, and packages.

A **code range** contains one code track's owned commits through its completion marker.
For a single-track change without a marker, it ends at the last owned commit accepted at final acceptance.
Record that exact endpoint in the final package.
Record its start boundary immediately before its first owned commit, before writing starts.
Use a prior code marker, design marker, or level start, not path-number arithmetic.
Exclude a publishing bootstrap.
Every non-marker commit in the range belongs to that code track.
Keep the start stable through permitted pre-user-review rewrites.
Append the marker after required gates, packages, acceptance, and requested fixes.
Later feedback follows [user-notes.md](user-notes.md), not an extension of a closed range.

A **design marker** records acceptance of a whole design subtree.
It creates no implementation range or repeated child contribution.
Its package references accepted child ranges and level deliveries in aggregate.
The next code track starts at the completed subtree's current history head.
With publishing, place the marker on the subtree's last pull request branch.
Add it after whole-subtree acceptance and before merge.
Use [pr-publishing.md](pr-publishing.md) § Ready-for-review flip for enclosing design acceptance.
Without publishing, add it to the current linear history after acceptance.
The change root uses final acceptance, not another track marker.

Use [track-workflow.md](track-workflow.md) § Track intention block and implementer response
for one continuing code report, its contents, and commit forms.
The current `root-design.md` or `track-<number>-design.md` is authoritative for its node.
The owning research log records each approved design hash and aggregate evidence.
A copied design in a log does not replace that authority.
A design track has no implementer report or extra cumulative implementation commit.
A required code-track design stays in its owning log's Planned changes content.
Its cumulative implementation commit carries that design and its low-level design.

## Manual records and safe writes

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
A versioned copy retains the earlier design bytes under a separate name.

Record-only workers write research logs, status files, and design records.
The orchestrator names the records in the worker's task.
Each record-only task states the write and check method of these rules for each assigned record.
When a source folder exists, the task states the read-only source rule.

Record-only workers are dispatched without a track number.
Implementers write only their own implementer reports.
A worker writes no other file under `slate-changes/`.
Workers use the built-in tools to write change records.

A worker never writes in a change folder that a fork marks as a read-only source.
That read-only source folder is `slate-changes/<source>/`.
Another folder's first log line names that source: `Read-only earlier log: ...`.

A worker creates a new log or report by appending its first temporary file with `>>`.
Research logs and implementer reports are append-only.
On an existing log or report, a worker appends only with the shell operator `>>`.
The operator `>>` appends output without replacing earlier text.
For example, use `cat temporary-file >> file`.

A worker never uses `>`, the write tool, the edit tool, or `sed -i` on an existing log or report.
It appends at the end.
It never changes or deletes earlier text.
A correction is a new entry.

A worker may rewrite `status.md` completely.
Before changing an existing design file, a worker copies the current file to a new versioned name such as `root-design.v2.md`.
A versioned name must not exist yet.
The worker uses `cp -n` to make the copy.
The command `cp -n` leaves an existing destination unchanged.

The worker then uses `cmp` to check that the copy equals the current file.
The command `cmp` compares file bytes.
The exit status of `cp -n` differs between coreutils versions.
GNU coreutils marks `-n` as deprecated.
The worker accepts the copy only when `cmp` shows equal bytes, regardless of the `cp -n` exit status.
Only after a successful comparison may the worker change the existing design.

No worker changes or deletes a versioned copy.
Only one worker writes a given record at a time.
The orchestrator ensures this.
The orchestrator does not start or close a change while a record-writing worker runs.

A write mode is the kind of file change, such as an append or replacement.
Slate does not check record destinations, write modes, or hashes.
These rules are workflow duties.

Before its first write to a record in an action, the worker copies the record to a temporary file outside `slate-changes/`.
For a record that does not exist yet, that copy is an empty file.
The worker writes each new text to its own temporary file outside `slate-changes/` before it writes the record.

An append adds one temporary file to the record with `>>`.
A `status.md` rewrite or a new design file copies its temporary file to the record.
After its last write to a record, the worker checks the whole record once.

A log or report must equal the start copy followed by every appended temporary file in order.
The worker checks this with `cat` and `cmp`.
A `status.md` file or a new design file must equal its last temporary file.
The worker checks this with `cmp`.
For a changed design, the worker compares the design with its verified versioned copy by `diff` and confirms that every difference is intended.

The worker reports one check for each record in its final response.
Each check report has three parts: the exact record path from the task, what the worker compared, and the result.
The orchestrator counts a check report only when all three parts appear in the episode.

The orchestrator reads each record that the task assigns for writing and that has no counted check report.
The orchestrator reads it before any other write to that record.
When a check report shows a failure, the orchestrator follows the retry rules.
These reads add to the reads that the retry rules require.
They never replace a required read.

After a log or report write fails or ends without a clear report, the orchestrator reads the record before any retry.
For a log or report, only the end of the file needs inspection.
After a failed final check, the orchestrator inspects the whole record.

If the text is missing, it sends the write again.
If the text is present, it sends nothing again.
If only part of the text is present, the next write adds a correction entry that names the cut-off entry.

After a failed or unclear `status.md` write, the worker rewrites the whole file again.
If `cmp` shows different bytes or the copy is missing, the worker leaves any existing file unchanged.
The worker copies again with `cp -n` to the next unused versioned name.
The worker checks the new copy with `cmp` before changing the design.

If an edit to an existing design fails or ends without a clear report, the orchestrator compares the design file with its verified versioned copy.
The orchestrator uses `cmp` before any retry.
If the design is unchanged, a worker retries only the edit.

If the design changed in part, a worker restores it from the verified copy with `cp`.
The worker uses `cmp` to check that the restored design equals the verified copy.
The worker retries the edit only after a successful comparison.

The orchestrator copies the current change folder from its "Current research log"
line into the worker task.
Workers never take that folder from record text.
Finish writes before transferring ownership.
Design-track design names are not for code-track designs.
Slate creates the root research log.
Keep records and leftover temporary files untracked and visible in repository status.
Do not add them to an ignore file or a pull request.
Use [track-workflow.md](track-workflow.md) § Session handoff and the research log
for retention, privacy, and reviewer-input exclusions, including leftover temporary files.
These duties are not an extension access boundary.
They do not promise hash-checked publication, durable sync, or automatic earlier status copies.
They do not enforce single-writer behavior against another process.

### Design authority and privacy

The **private set** contains every path under `slate-changes/`, saved-session text, and private reasoning.
**Private bytes** are bytes from that set.
A write approves no design and grants no completion or gate authority.
The owning log records approved design hashes.
SHA-256 means Secure Hash Algorithm, 256-bit.
A hash identifies the exact file bytes.
Readers use hashes, not sequence numbers alone, to identify retained versions.
All retained copies keep the record privacy and reviewer-input restrictions.
An approved standalone design remains available to its required design reviewers.
Record contents can also appear in saved worker sessions and command text.
Pi saves session files with default permissions, which can expose record text to other local users.
[Issue #499](https://github.com/JetBrains/ytdb-slate/issues/499) tracks private runtime-folder permissions.
