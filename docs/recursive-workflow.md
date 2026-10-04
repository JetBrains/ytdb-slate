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
A record-only worker writes records, not implementation.
Only record-only workers write status files and research logs.
Implementers write only their own implementer report.
Record-only workers omit `trackNumber`.
Serialize all record writers and finish writes before transferring ownership.
Use [track-workflow.md](track-workflow.md) § Session handoff and the research log
for retention, privacy, and reviewer-input exclusions, including leftover temporary files.

Research logs and implementer reports are append-only.
A correction is a new entry.
Use `slate_record` for all tool-governed record writes.
Only status and design files permit full replacement.
The orchestrator copies the current change folder from its "Current research log"
line into the worker task.
Workers never take that folder from record text.
Checks protect against accidents, not worker authority.

### Tool assignments and writes

A record assignment binds one action to the trusted current folder and exact record names.
Dispatch a record-only worker as `type: general` with a nonempty `records` list and no `trackNumber`.
The list contains no duplicate names or paths and requires an open change.
An implementer receives only `track-<number>-implementer-report.md` from its validated `trackNumber`.
Other actions receive no record tool.
Saved sessions do not restore assignments.

| Exact record name | Permitted modes | Writer |
| --- | --- | --- |
| `research-log.md` | append | record-only |
| `track-<number>-research-log.md` | create, append | record-only |
| `track-<number>-implementer-report.md` | create, append | implementer for that number |
| `status.md` | create, replace | record-only |
| `root-design.md` | create, replace | record-only |
| `track-<number>-design.md` | create, replace | record-only |

Design-track design names are not for code-track designs.
Slate creates the root research log.
The tool accepts `record`, `mode`, `payload`, and optional `expectedHash`.
The record must equal one assigned name, not a path.
A **payload** is the supplied text for that call.
Create supplies complete initial text and no expected hash.
Append supplies only added text.
Replace supplies complete status or design text.
Every append and replacement requires the current hash as `sha256:<64 lowercase hexadecimal digits>`.
SHA-256 means Secure Hash Algorithm, 256-bit.
Read the current safe record and hash its bytes before each update.
The tool encodes text as UTF-8, or Unicode Transformation Format, 8-bit.
It does not trim text, normalize line endings, or add a newline.
It refuses characters that require encoding substitution.
Each payload may contain at most 1,048,576 encoded bytes, or one mebibyte (MiB).
That limit applies per call, not to the total log size.
For an oversized first create of a log or report, create an initial part within the limit, then append remaining parts with fresh hashes.
For status or design files, reduce the complete payload to fit the limit or stop and ask the user.
Those files do not permit append, so splitting a create into appends is not valid.

The tool creates files exclusively with owner-only read and write permissions.
It rejects unsafe folder components, symbolic links, non-regular files, and current records with extra hard links.
A symbolic link points to another path.
A hard link gives another name to the same file.
The tool compares identity and bytes again before replacement.
It checks sibling root logs for the exact first line `Read-only earlier log: slate-changes/<change>/research-log.md`.
Here `<change>` is the trusted current change-folder name.
A matching sibling line makes the current folder read-only.
A missing sibling root log is skipped.
Every other sibling read error refuses with its folder name before the record changes.
A retained version or staging file may already exist and is reported for inspection.

The built-in write guard blocks `write` and `edit` inside `slate-changes/` in every worker session.
An assigned worker uses `slate_record` instead.
An unassigned worker requests a suitable dispatch.
A path that cannot be established as outside that directory also blocks.
Inspect that path and choose a verifiable outside destination for unrelated work.
The guard does not block `bash`, other extensions, or unrelated programs.
These limits grant no permission to write tool-governed records outside `slate_record`.
Node checks protect against accidents, not a hostile process running as the same user.
A folder swapped and restored between checks can redirect a write.
Comparison and replacement have a race window.
Cleanup identity checks and removal have another race window.
Keep exclusive writer ownership across both windows.
Change start and close refuse while a record writer owns an assignment.
Ownership transfers stop new calls and wait for admitted calls to settle.

### Earlier versions and design authority

A replacement retains the earlier status or design bytes in `versions/<record>.v<N>.<sha256 hex>`.
Here `<record>` is the exact record name and `<sha256 hex>` is its earlier bytes' digest without `sha256:`.
`<N>` is a positive decimal integer without leading zeros.
The first number is 1 and each next number exceeds every recognized number for that record.
Interrupted attempts consume numbers and gaps are valid.
Retained bytes stay unchanged even when the replacement fails.
A complete copy and its file and folder entries must sync before record replacement.
An incomplete staging copy is not a verified earlier version.
The replacement result names the retained version and both hashes.
A write approves no design and grants no completion or gate authority.
The owning log records approved design hashes.
Every interim `<name>.vN.md` copy stays byte-unchanged in place and outside the tool's version numbering.
The tool does not rename those copies or move them into `versions/`.
Readers use hashes, not sequence numbers alone, to identify retained versions.
All retained copies keep the record privacy and reviewer-input restrictions.
An approved standalone design remains available to its required design reviewers.

### Outcomes and inspection before re-dispatch

Publication makes candidate bytes visible at the final record name.
Settlement verifies publication, requests durable file and folder sync, and cleans matching temporary names.
Durable sync asks the filesystem to persist bytes or folder entries.
The filesystem's sync guarantees limit durability claims.
Each result gives a reason, observed hashes when known, sync evidence, and remaining artifacts.
An artifact is a temporary file or retained copy left by a call.
An intended candidate hash is not an observed current hash.
The thread result keeps every call's outcome, including aborted, failed, and uncertain actions.

| Outcome state | Caller duty |
| --- | --- |
| refused before publication | Correct the refusal. Read again after a stale hash or identity mismatch. Inspect reported artifacts. |
| failed before publication | Inspect the unchanged record and artifacts. For a two-link artifact, use Manual interrupted-create recovery below. Resolve the failure and obtain a fresh update hash. |
| published and synced | Continue dependent work. Do not repeat an append because an abort was also reported. |
| published with uncertain durability | Pause dependent work. Publication is known, but settlement is incomplete. Inspect the record and artifacts. For a two-link record, use Manual interrupted-create recovery below. |
| unknown outcome | Pause dependent work and inspect current bytes and possible artifacts. Missing evidence is not success. |

An abort after publication is reported only after settlement.
A process exit or abort without a delivered report requires unknown-outcome treatment.
After an aborted, failed, or uncertain action with record calls, the orchestrator reads each current record before any re-dispatch.
To decide whether an append landed, compare current bytes with the exact earlier bytes followed by the exact payload bytes.
The earlier bytes must hash to the supplied expected hash.
An exact match establishes the append's bytes in the current record, not its earlier durable sync.
A mismatch does not prove that the append is missing.
Repeat an append only when no writer is active and the current bytes equal exactly the earlier bytes.
Their hash must equal the supplied expected hash.
For every other result, including a comparison that cannot be established, pause and ask the user rather than repeat the append.
Never retry an append or replacement after uncertainty without inspection.
Do not roll back a published record to force a retry.

### Manual interrupted-create recovery

An interruption or a reported failure during hard-link publication can leave a record or retained version with two links.
This procedure covers both causes, including failed-before-publication version retention and uncertain create cleanup.
Later tool calls refuse that state and do not repair it automatically.
The private candidate pattern is `.slate-record-<32hex>.tmp` in the current folder.
The private version staging pattern is `.slate-record-version-<record>.v<N>.<32hex>.tmp` in `versions/`.
Here `<32hex>` means exactly 32 lowercase hexadecimal digits.
A candidate can share identity with its final record.
A version staging name can share identity with `versions/<record>.v<N>.<sha256 hex>`.
Use this one procedure for either pair, including an authorized manual create's leftover candidate:

1. Stop every writer. Establish exclusive ownership and verify the current folder chain without following symbolic links. Recovery grants no write permission to a read-only source folder.
2. Inspect the final record or hash-bound version and the suspected temporary name without following symbolic links. Both must be regular files with the same device and file identifier and exactly two links.
3. Verify the final name against the assignment or reported version. Verify both names' bytes against a trusted hash or the exact authorized payload. For a version, its complete bytes must also match its hash-bound name.
4. Remove only the matching temporary name under exclusive writer ownership. Never remove the record name or the hash-bound version name. Never delete a different file or replace a linked record to force progress.
5. Sync the containing folder and verify that the final file now has one link. Read the current record again and use its fresh hash for the next update.

If any condition fails, stop and ask the user.
A missing, renamed, or different temporary name does not authorize removing another name.
Single-link leftovers also require manual inspection under exclusive writer ownership.
They are not current records or accounting sources.
The tool does not adopt them.

### Supported systems and existing permissions

Change-record writes support Linux, macOS, and Windows Subsystem for Linux (WSL) on its own Linux filesystem.
Native Windows refuses with a reason before any record-tool file operation and directs users to that WSL route.
[Issue #498](https://github.com/JetBrains/ytdb-slate/issues/498) tracks native Windows support.
Detected Windows drive destinations inside WSL refuse before file changes.
Windows drives are unsupported even when detection misses them, including drives exposed through virtiofs, a virtual-machine file-sharing filesystem.
WSL tested through Linux CI and simulated drive checks.
CI means continuous integration, or automated repository checks.
The filesystem must provide the required hard links, replacement, permissions, and sync operations.
If a required capability is unavailable, stop and report the limitation instead of choosing a weaker write method.

A safe existing regular record remains usable without silently changing its permissions.
Every replacement and new retained copy still receives owner-only permissions.
Private record permissions do not protect payload copies in worker session files.
Pi saves those files with default permissions, which can expose payload text to other local users.
An authorized manual procedure has the same exposure through saved command text.
[Issue #499](https://github.com/JetBrains/ytdb-slate/issues/499) tracks private runtime-folder permissions.
An open change keeps its recorded workflow until the user authorizes migration.
It may use its authorized manual procedure through `bash` until then.
The built-in guard remains active, and this route does not permit tool-governed actions to bypass the tool.

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
