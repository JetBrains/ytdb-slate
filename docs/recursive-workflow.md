# Recursive workflow

Use [track-workflow.md](track-workflow.md) for the lifecycle.
This document owns nested-track relations.

## Terms and scope

A **change tree** records tracks and their parent-child relationships.
The **change root** represents the whole request.
A **design track** plans a nested change.
A **code track** implements bounded approved work, including documents.
A **level** contains sibling tracks created by one split, not all tracks at one depth.
A **level pull request** contains the code tracks of one level.
A **subtree** contains a node and its descendants.
A **review-fix child track** repairs outstanding work under a user-approved split.
An **inner node** has children.
The root and design tracks are ordinary inner nodes.
A code track becomes an inner node only through review-fix children.
Ordinary leaves are code tracks.
Slate maintains no tree controller.

## Loading and planning

Use [track-workflow.md](track-workflow.md) § Recursive planning and loading for
loading, the direct-child limit, and the implementer-requested split exception.
Apply its split rule to the root and each expanded design track.
Use its § Confirmation gate for approvals and § Track intention block and
implementer response for scope.

Every change reads § Identifiers, code ranges, and design markers and § Manual records and safe writes in [recursive-workflow.md](recursive-workflow.md).
Load its other sections when the current or proposed plan contains a design track or review-fix child track.
Check the loading condition during planning and again during resume reconciliation.
Load the document before proposing a review-fix split.

## Nested designs and gates

<!-- nested-design-policy:begin -->
Expand a design track when work reaches it.
Each subtree root receives its own high-level design and independent risk assessment.
A multi-track change requires a high-level design.
An estimate above 100 counted lines and a proved DESIGN-TRIGGERING area remain
separate design triggers.
Design-track designs have no size cap.
Each design track completes the gates of a nested multi-track change.
Each code track keeps its independent gates.
Use [track-workflow.md](track-workflow.md) § Confirmation gate for user-decision reuse.
<!-- nested-design-policy:end -->

Parent approval does not approve children.
Use [track-workflow.md](track-workflow.md) § Lifecycle and phases for design gates,
§ Risk planning and reconciliation for risk records, and § Review coverage for reviews.
Use its § Delivery and termination for acceptance.

## Code-track sizing and split requests

Use [track-workflow.md](track-workflow.md) § Track size and split for sizing and stopping.
Use its § Recursive planning and loading for split exceptions.

## Level consistency

Use [track-workflow.md](track-workflow.md) § Track size and split for level consistency.

## Proportional process

Use [design-principles.md](design-principles.md) § 4. Operating principles for proportional process.
Use [track-workflow.md](track-workflow.md) § Recursive planning and loading for record triggers.
Entering a design track triggers its research log and nested gates.
An ordinary code track or a high-level design alone triggers neither extra record.
Questions follow unresolved decisions rather than record or track counts.

## Recorded-workflow compatibility

Use [track-workflow.md](track-workflow.md) § Migration for compatibility.
Use its § Session handoff and the research log for ownership.

## Level publishing and retained history

Use [pr-publishing.md](pr-publishing.md) for activation, approval, ready safeguards, and accounting.

<!-- level-history-policy:begin -->
Within a level, complete every design-track subtree before starting its code tracks.
A plan that needs the opposite order must change its split.
Complete one entered subtree before continuing its sibling tracks.
Keep one sequential implementation writer.
Independent research and reviews may run in parallel.

All work forms one linear history.
Each level pull request contains one contiguous slice of that history.
A contiguous slice is an uninterrupted range of commits.
Earlier completed descendant work is the foundation, not new work in an upper-level slice.
A stacked pull request uses another pull request's branch as its base.
Sibling subtree pull requests stack in completion order by default.
Upper-level pull requests stack on completed lower-level work by default.
A user-approved project arrangement may differ.
It must preserve linear history, contiguous slices, and every gate.
No new setting is needed to approve that arrangement.

Keep branches and accepted marker history available until the root change closes.
For each delivered level, retain its accepted history boundaries and accepted branch head.
Bind that history to its pull request and observed merge result in the owning research log.
The default-branch merge result proves delivery, not track completion.
A squash merge does not replace accepted marker authority.

Use [track-workflow.md](track-workflow.md) § Delivery and termination for permitted
history rewrites, rebased-marker mappings, range updates, and unavailable history.
<!-- level-history-policy:end -->

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
A user-chosen split in such a change creates review-fix children, loads this document, and creates `status.md`.
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

## Resume and folder forks

Use [track-workflow.md](track-workflow.md) § Resume order and reconciliation first.
Apply the loading condition before tree rules.
Before relying on a summary, check that its named subtree entry exists.
Reconcile the tree, reports, ranges, review coverage, focus records, and live difference.
Marker history decides accepted completion, not status entries or merge results.
A disagreement or missing evidence pauses work.
A rebuild keeps uncontradicted status entries and changes only entries that disagree with evidence.
For repair-state disagreement, stop and ask the user under § Manual records and safe writes.
No automatic rebuild lowers a repair count.

A **folder fork** gives a different session owner new active records.
Use [track-workflow.md](track-workflow.md) § Session handoff and the research log
for same-owner resume, trusted handoff, and folder allocation.
At the first record write after a fork, name each direct source record as read-only.
A successor design names its read-only source design.
Name the last source entry seen in each record, including the root log.
Readers ignore later source entries.
Follow source links for earlier history without copying or rewriting source files.
Continue subtree logs and reports in the current folder.
Take uncontradicted status entries from the read-only source `status.md` and cite it.
Keep review-fix child path numbers among those entries.
Older sessions without tree records remain readable under their recorded workflow.
Do not invent a tree or gates from missing files.

## Handoff boundaries

Use [track-workflow.md](track-workflow.md) § Confirmation gate for handoff timing,
record order, and waivers.
Use its § Resume order and reconciliation to check the summary's subtree entry.
Existing context-budget, user-requested, and unfinished-session handoff rules still apply.

## Review-fix subtrees and repair limits

Create review-fix children only when the user approves splitting outstanding fixes.
Use [user-notes.md](user-notes.md) § Mandatory escalation set for the split option.
Use [review-rules.md](review-rules.md) § Fix loop and gate verdicts for repair controls.
Load this document before proposing the split.
The approval names the affected code track and exact incomplete approved requirements.
A finding alone creates no child.
Use this subtree for repairs, not new feature scope.

The affected track remains a code track.
A review-fix child is not a code track for identity purposes.
A split at any depth creates sibling review-fix children under the same affected code track.
For example, splitting 1.4.1 creates 1.4.2 and 1.4.3, not 1.4.1.1.
All children use that code track's identifier, report, slice, and marker.
Its children stay in its publishing slice and review accounting.
They have no separate pull requests, research logs, or implementer reports.
Dispatch each child with the affected code track's identifier.
Record child path numbers only in status entries.
Use the affected track's identifier in commit titles, packages, and report names.
Use [track-workflow.md](track-workflow.md) § Track intention block and implementer response
for commit title and body forms.
Before user review, use `Track <n> fix round <r>: <intent title>`.
After user review, use `Track <n> user review fix <r>: <intent title>` for requested fixes.
Use `Track <n> fix round <r>: <intent title>` for gate corrections after user review.
Here `<n>` is the affected track's identifier, never the child's path number.

Reassess each child's planning, focus approvals, and applicable review gates.
Parent approval does not cover changed child behavior automatically.
Keep completion evidence in the affected track's report and retained repair records.
Status may show a repair action finished while the affected track remains incomplete.
A fix child has no independent boundary marker.
The affected track's marker closes its accepted code track and fix subtree together.
No status entry independently declares accepted completion.

Each review-fix child starts at round zero.
Run at most two ordinary fix rounds.
The stuck-fix consultation budget counts separately for each child.
The ordinary budget permits one consultation.
Use [review-rules.md](review-rules.md) § Stuck-fix consultation for additional explicit user grants.
Only the user chooses a split through [user-notes.md](user-notes.md) § Mandatory escalation set.
Each new set of child rounds requires that user decision.
The split option discloses two ordinary rounds and one stuck-fix consultation per child.
The split escalation record stores that budget.
The affected code track's own count and two-round limit never change.
Repairs that the user's split decision does not move to a new child stay with their current track or child at 2 of 2.
Those repairs take redesign or waive only.
When a child uses both rounds, escalate again with redesign, waive, or split.
A change without a design track or review-fix child keeps the hard limit of two ordinary rounds.
A new finding identifier resets neither a child's round count nor its consultation budget.

A split never resets the per-requirement count of failed ordinary rounds.
Two failed ordinary rounds on the same approved requirement trigger the requirement investigation.
Count those failed rounds across the affected code track and all its review-fix children.
Use [track-workflow.md](track-workflow.md) § Confirmation gate for that investigation.
Complete any triggered investigation before a child starts.
Investigation approval and holistic-solution approval remain separate.
Obtain those approvals and the user's split decision before starting the child.
After a completed investigation, two further failed ordinary rounds on that requirement trigger it again.
Neither investigation approval nor holistic-solution approval permits repair beyond the two-round limit.
A split bypasses no consultation, verification, or escalation rule.

Before user review, child fixes join the affected cumulative implementation commit.
After user review, keep child fixes and corrections as separate commits.
Never fold them into the already reviewed cumulative commit.
Re-pin permitted rewritten ranges before review or packaging.
Required fix gates inspect the child fix differences and cumulative result.
The affected track completes only after every child repair and required gate is resolved.

## Whole-subtree acceptance

Every design track requires one explicit blocking acceptance of its whole subtree.
This requirement applies with any proved-area set and with publishing enabled or disabled.
Present one design-track package for that aggregate decision.
It identifies the approved design, accepted child evidence, and every subtree level delivery.
State remaining decisions, evidence limits, deviations, and effects on later sibling tracks.
Use [delivery-packages.md](delivery-packages.md) § Track package for the package fields.

Acceptance of a descendant pull request does not accept the whole design subtree.
A merge is not an acceptance statement.
The user may accept the whole subtree while reviewing its last pull request.
That statement must explicitly name the whole design subtree and its aggregate evidence.
An earlier answer cannot accept work that was incomplete when the user gave it.
Without publishing, request the same explicit aggregate decision directly.
A root package cannot replace a missing design-track acceptance.
Root final acceptance remains a separate blocking decision.
With publishing, follow [delivery-packages.md](delivery-packages.md) § Durable accounting after each decision and before merge.
Use § Identifiers, code ranges, and design markers for the marker after acceptance.

Code-track acceptance follows [track-workflow.md](track-workflow.md) § Delivery and termination.
A code track without mandatory acceptance still receives its package and every other required gate.
Merging a level supplies no missing gate or decision.
A design node alone adds no routine implementation reviewer.
Its aggregate evidence must show each child's required review coverage and separate fix-range verdicts.

## Packages, attribution, and issues

Use [delivery-packages.md](delivery-packages.md) § Track package for code and design references.
Use its § Change package for the root's complete level-delivery list.
Use its § Durable accounting for all record sources and public transfer.
Use [pr-publishing.md](pr-publishing.md) § Description rules for each level's scope and accounting.
Do not count accepted child work as new implementation.

A **subtree issue** groups approved work within this change when the user requests it.
It neither moves work outside the change nor approves implementation.
A **deferred-work issue** records work explicitly excluded from this change.
Use [user-notes.md](user-notes.md) § Mandatory escalation set for the user's disposition.
Use [review-rules.md](review-rules.md) § Findings and output for a self-contained deferred issue.
Issue creation supplies no gate, review, or acceptance.
Distinguish both purposes in packages and durable accounting.
Without an issue tracker, keep an approved deferral in the delivery record.
<!-- recursive-delivery:end -->
