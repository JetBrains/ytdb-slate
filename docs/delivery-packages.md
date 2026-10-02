# Delivery packages

This document defines the short messages that present a completed track and a
completed change to the user. A **track package** is the user-facing message
that other workflow documents call a **track packet**. A **change package** is
the user-facing message that older rules call a **final report**. The new names
change presentation only. They do not change any gate, acceptance rule, or
durable record.

Read this document immediately before preparing a track package or change
package. Skip the read when this document is already in context. Do not inject
this document into the always-loaded doctrine.

This read does not replace any read trigger in
[user-notes.md](user-notes.md). Read that document separately at every trigger
that it defines, including the first user note and a non-empty note-queue drain.

<!-- delivery-package-contract:begin -->
## Package preparation

Complete the required checks, reviews, finding dispositions, note accounting,
overrides, escalations, coverage accounting, and acceptance prerequisites
before preparing a package. Keep full working evidence in its owning records.
Keep every required conclusion and separate verdict in the accounting sources
and final delivery records defined in § Durable accounting. A package
summarizes the result. It does not replace those records.

Use short, self-contained statements. Put the result and the user's next action
first. Reference the diff instead of copying it. Do not add a file table, a
proved-area roster, review counts, a verification section, a user-requested-fix
verification section, or a list of material available on request.

Never hide a blocking failure, an unfixed finding, a relevant risk, a design
difference, or a decision that the user must make. Put such information in the
conditional attention section. A package may mention a check only when its
failure or limit affects the user's decision. The durable record keeps the full
check results and review verdicts.

## Track package

Use this order:

```markdown
## Track <number>: <name>

**Result**
<What the track completed and the user-visible or workflow result.>

**Needs attention**
<Only risks, unfixed findings, design differences, or requested decisions. For
each decision, give every option and its consequence. Omit this field when none
exists.>

**References**
<Pull request and state when one exists, exact commit range, diff location, and
supporting accounting source or delivery record.>

**Next step**
<State whether acceptance is requested, a decision is required, or the track is
reporting progress. Name the action the user should take.>
```

The **Result** states the completed outcome, not an activity log. The
**References** field identifies a code track's cumulative implementation commit or exact range.
For code ranges and design markers, use [recursive-workflow.md](recursive-workflow.md)
§ Identifiers, code ranges, and design markers.
A design-track package names its approved design, accepted child ranges, and every subtree level delivery.
It has no implementation range or extra cumulative commit.
Do not count accepted child work as new implementation.
With publishing, a code package links its level pull request and states its delivery state.
A design package distinguishes merged levels from the last accepted level waiting for merge.
Without publishing, state that no pull request exists.

The **Next step** states the applicable acceptance action. Follow
[track-workflow.md](track-workflow.md) § Delivery and termination for the
code-track acceptance and boundary rules.
For a design track, use [recursive-workflow.md](recursive-workflow.md) § Whole-subtree acceptance.
The package states deviations and their effects on later sibling tracks.
Inside an incomplete level, list each remaining document, prompt, or extension difference and its later owner.
The package still reports progress and every requested decision.

## Change package

Use this order:

```markdown
## Change: <name>

**Outcome**
<What the whole change now achieves.>

**Goal status**
<State whether every approved goal is complete. Identify any incomplete goal.>

**Remaining concerns**
<Only relevant risks, deferred work, open issues, or unresolved feedback. Omit
this field when none exists.>

**References**
<Every level delivery and its state when publishing is enabled, exact change range,
diff location, and supporting accounting sources or delivery records.>

**Model-routing recommendations**
<Evidence-bounded advice, or the exact sentence below, only when trusted
configuration enables workflow.routingRecommendations.>

**Decision**
<Request final acceptance. State every other required decision with all options
and consequences.>
```

The **Decision** field asks explicitly for the final acceptance required by
[track-workflow.md](track-workflow.md) § Delivery and termination. Do not treat
silence as acceptance.
The root package lists every level delivery once.
Distinguish merged levels from the last accepted level waiting for merge.
A change without nested tracks has one level and at most one pull request.

When trusted configuration enables `workflow.routingRecommendations`, always
include **Model-routing recommendations** immediately before **Decision**. Use
only current-change action records that name a logical model. Follow the
evidence and authority limits in
[track-workflow.md](track-workflow.md) § Routing recommendations at change
completion. When the records support no advice, write exactly:

`No model-routing changes recommended.`

When the setting is disabled, omit the field. The field is advisory. It never
authorizes or performs a configuration, routing, model, effort, rating,
provider, or roster change.

## Single-track combined package

A single-track change uses one combined package. Do not send a track package
and then repeat the same facts in a second change package. Put the track heading
and fields first. Put the change heading and change-only fields after them.
Keep every required bold label. When a fact applies to both sections, state it
once and use a short reference from the other field. When the two conditional
attention fields have the same items, put the items under **Needs attention**.
Put a short reference under **Remaining concerns**. Keep **Model-routing
recommendations** immediately before **Decision** when that field is enabled.

## Durable accounting

The **accounting sources** are the owning records behind each package.
Read the root `research-log.md`, every entered design track's
`track-<path-number>-research-log.md`, every code track's implementer report,
and review-fix evidence in the affected track's records.
Follow each record's read-only source chain within its recorded read boundary.
Include required conclusions held in any of those records, not only the active log.
Use `status.md` to find records, never as gate or completion evidence.
A leftover temporary file is not an accounting source.
Keep all manual records and their source chains through and after root closure.
Only the user deletes the change folder.
The final delivery records hold the conclusions that must remain after local cleanup.
They retain all check results and limits, the separate routine-review
and user-requested-fix verdicts, every finding and disposition, user-note
accounting, the ignored-finding index, tracked issues, overrides, escalations,
coverage conclusions, and approved risk changes.
They also retain design-track acceptance, child completion references, accepted
history bindings, review-fix accounting, and each issue's purpose and disposition.
No required accounting may remain only in an untracked record at root closure.

The delivery record uses existing publication and Git artifacts. It is not a
new artifact. With draft publishing, each level description is its reachable
record before merge. Its resulting default-branch commit body is its final record.
The observed merge commit itself supplies the merge-result binding, including for the last level.
After merge, verify its identity and parents against the accepted history and pull request.
Record that binding in the reachable level description and owning log before root closure.
The commit body needs no hash of itself.
Before each package, copy that level's required conclusions from all accounting
sources into its description.
Include design-track and review-fix conclusions attributed to that level.
Keep root-wide and whole-subtree conclusions in the last level that closes them.
Link other level records without counting their implementation again.

For each required whole-subtree or root final acceptance, use this order even after the ready flip:

1. Obtain and record the explicit acceptance decision after its package and prerequisites.
2. Copy that decision and its aggregate evidence references into the closing level's description.
3. Add a marker only for each design track newly accepted by this decision. Reuse retained marker references for tracks accepted earlier. Record each track's history references in that description.
4. Verify the description against all accounting sources after these updates and before handoff for merge.
5. Hand the updated description to the user for merge. Only the user merges.

Repeat the description measurement and size-exception checks after each update.
A missing acceptance or required conclusion blocks handoff for merge.
Verify every level record and all root-wide accounting before root closure.

<!-- publishing-disabled-accounting:begin -->
When draft publishing is disabled, the final Git record does not exist before
final acceptance. Use this sequence:

1. Before each intermediate code or design package, reconcile all accounting
   sources for that track and its subtree. Reference those owning records and
   accepted ranges. Do not claim that a future delivery commit exists.
2. Before the combined single-track or root final package, reconcile every
   accounting source across the whole change. Complete each design-track
   acceptance before its marker. Retain all records and accepted histories
   through root final acceptance.
3. After root final acceptance, create the final squashed delivery commit.
   Copy every required conclusion from all accounting sources into its body.
   Before rewriting, preserve accepted source history under
   [track-workflow.md](track-workflow.md) § Delivery and termination.
4. Verify the body against every accounting source and required conclusion.
   Only then close the root change with `slate_change close`.
   Keep all manual records and source chains. Only the user deletes the change folder.

Abandonment at any stage ends with `slate_change close`. No delivery artifact is
needed for abandonment, and the close deletes nothing.

A publishing-disabled single-track change starts at step 2. A
publishing-disabled multi-track change repeats step 1 for each track, then runs
steps 2 through 4. No package requires a future commit body before that commit
exists.
<!-- publishing-disabled-accounting:end -->

Transfer conclusions and evidence needed for the listed accounting. Do not
transfer private reasoning, secrets, credentials, private user data, or
unnecessary personal data. A package references the current accounting source
or delivery record. It does not copy the full accounting into the conversation.
A blocking item or a relevant concern still appears in the package even when
its detail also exists in that source or record.
<!-- delivery-package-contract:end -->
