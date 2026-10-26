# Recursive workflow

Use [track-workflow.md](track-workflow.md) for the lifecycle.
This document owns nested-track relations.

## Terms and scope

A **change tree** records tracks and their parent-child relationships.
The **change root** represents the whole request.
A **design track** plans a nested change.
A **code track** implements bounded approved work, including documents.
A **level** contains sibling tracks created by one split, not all tracks at one depth.
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

Every change reads [change-records.md](change-records.md) § Identifiers, code ranges, and design markers and § Manual records and safe writes.
Load [recursive-workflow.md](recursive-workflow.md) when the current or proposed plan contains a design track or review-fix child track.
Check the loading condition during planning and again during resume reconciliation.
Load the document before proposing a review-fix split.
Read the applicable sections before relying on their rules.

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

## Change consistency

Use [track-workflow.md](track-workflow.md) § Track size and split for change consistency.

## Proportional process

Use [track-workflow.md](track-workflow.md) § Recursive planning and loading for record triggers.
Entering a design track triggers its research log and nested gates.
An ordinary code track or a high-level design alone triggers neither extra record.
Questions follow unresolved decisions rather than record or track counts.

## Recorded-workflow compatibility

Use [track-workflow.md](track-workflow.md) § Migration for compatibility.
Use its § Session handoff and the research log for ownership.

## Dependency order and pauses

Use [pr-publishing.md](pr-publishing.md) for the single change branch and optional pull request.
Use [delivery-packages.md](delivery-packages.md) § Durable accounting for accounting sources and verification.

<!-- level-history-policy:begin -->
Within one level, tracks finish in dependency order.
A dependency requires another track's result before affected work can finish.
When tracks do not depend on each other, design tracks finish first.
All implementation uses one change branch and one sequential writer.
Independent research and reviews may run in parallel.

Complete an entered subtree before continuing its siblings, except for a permitted dependency pause.
A subtree may pause for an unfinished sibling dependency only between code-track ranges.
It may pause before its first code track or after completed code tracks.
An open range starts with its first owned commit and ends at its accepted completion boundary.
No code track may leave an open owned range while another track commits.
Completed descendant ranges need not form one uninterrupted subtree slice.
A late dependency inside an open range stops implementation for a user-approved replan.
It gives no other writer permission to commit inside that range.

Record the pause as a typed `decision` entry in the owning parent research log.
Name the paused subtree, dependency, completed boundary, and resume condition.
Confirm that no code-track range remains open.
Show pending work and the dependency in `status.md` when that file is required.
Before resume, read the decision and verify the dependency's completion evidence.
A status entry alone authorizes neither pause nor resume.

A pause changes work order, not completion or acceptance.
Keep stable track numbers, pending gates, accepted evidence, and repair budgets.
A split change keeps each new track's required approvals.
It reduces no reviews, markers, or acceptance requirements.
Earlier completed descendant work is not new implementation.
Use [track-workflow.md](track-workflow.md) § Delivery history and accounting for reviewed-state safeguards and unavailable history.
<!-- level-history-policy:end -->

## Identifiers, code ranges, and design markers

Use [change-records.md](change-records.md) § Identifiers, code ranges, and design markers.

## Manual records and safe writes

Use [change-records.md](change-records.md) § Manual records and safe writes.

### Design authority and privacy

Use [change-records.md](change-records.md) § Design authority and privacy.

## Resume and folder forks

Use [track-workflow.md](track-workflow.md) § Resume order and reconciliation first.
Apply the loading condition before tree rules.
Before relying on a summary, check that its named subtree entry exists.
Reconcile the tree, reports, ranges, review coverage, focus records, and live difference.
Marker history decides accepted completion, not status entries or merge results.
A disagreement or missing evidence pauses work.
A rebuild keeps uncontradicted status entries and changes only entries that disagree with evidence.
For repair-state disagreement, stop and ask the user under [change-records.md](change-records.md) § Manual records and safe writes.
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
record order, and mandatory boundaries.
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
All children use that code track's identifier, report, range, and marker.
Its children stay in its review accounting on the change branch.
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

Reassess each child's planning, risk assessment, and applicable review gates.
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
Start the bounded read-only investigation without scope approval.
Obtain holistic-solution approval and the user's split decision before starting the child.
After a completed investigation, two further failed ordinary rounds on that requirement trigger it again.
Neither read-only investigation nor holistic-solution approval permits repair beyond the two-round limit.
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
Show design, child-evidence, and delivery references only when the decision needs them.
State remaining decisions, evidence limits, deviations, and effects on later sibling tracks.
Use [delivery-packages.md](delivery-packages.md) § Track package for the package fields.

Acceptance of child tracks does not accept the whole design subtree.
A merge is not an acceptance statement.
The user may accept the whole subtree while reviewing the change pull request.
That statement must explicitly name the whole design subtree and its aggregate evidence.
An earlier answer cannot accept work that was incomplete when the user gave it.
Without publishing, request the same explicit aggregate decision directly.
A root package cannot replace a missing design-track acceptance.
Root final acceptance remains a separate blocking decision.
In either publishing setting, follow [delivery-packages.md](delivery-packages.md) § Durable accounting after each decision.
Reconcile and verify the owning log under that sequence before merge or root closure.
Use [change-records.md](change-records.md) § Identifiers, code ranges, and design markers for the marker after acceptance.

Code-track acceptance follows [track-workflow.md](track-workflow.md) § Delivery and termination.
Merging the change supplies no missing gate or decision.
A design node alone adds no routine implementation reviewer.
Its aggregate evidence must show each child's required review coverage and separate fix-range verdicts.

## Packages, attribution, and issues

Use [delivery-packages.md](delivery-packages.md) for package fields.
Keep the change delivery state in the owning research log.
Use its § Durable accounting for record sources and owning-log reconciliation.
Use [pr-publishing.md](pr-publishing.md) § Description rules for the change's template-shaped description.
Do not count accepted child work as new implementation.

A **subtree issue** groups approved work within this change when the user requests it.
It neither moves work outside the change nor approves implementation.
A **deferred-work issue** records work explicitly excluded from this change.
Use [user-notes.md](user-notes.md) § Mandatory escalation set for the user's disposition.
Use [review-rules.md](review-rules.md) § Findings and output for a self-contained deferred issue.
Issue creation supplies no gate, review, or acceptance.
Distinguish both purposes in packages and durable accounting.
Without an issue tracker, record an approved deferral in the owning research log.
Disclose the deferral in the relevant package.
<!-- recursive-delivery:end -->
