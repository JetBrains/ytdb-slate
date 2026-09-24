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
before preparing a package. Keep the full working evidence in the research log.
Keep every required conclusion and separate verdict in the current accounting
source and the final delivery record as the lifecycle below requires. A package
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
**References** field identifies the cumulative implementation commit or range.
When draft publishing is enabled, it also gives the umbrella pull-request
link. When publishing is disabled, state that no pull request exists.

The **Next step** states the applicable acceptance action. Follow
[track-workflow.md](track-workflow.md) § Delivery and termination for the
acceptance and boundary rules. The package still reports progress and every
requested decision.

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
<Umbrella pull request when publishing is enabled, exact change range, diff location, and
supporting accounting source or delivery record.>

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

The current change folder's research log holds the complete working evidence behind each package. The
final delivery record holds the conclusions that must remain after local
cleanup. It retains all check results and limits, the separate routine-review
and user-requested-fix verdicts, every finding and disposition, user-note
accounting, the ignored-finding index, tracked issues, overrides, escalations,
coverage conclusions, and approved risk changes.

The delivery record uses existing publication and Git artifacts. It is not a
new artifact. When draft publishing is enabled, the current pull-request
description is the reachable delivery record before merge. The resulting
default-branch commit body is the final delivery record. Before each package,
copy the required accounting from the research log into the description.

<!-- publishing-disabled-accounting:begin -->
When draft publishing is disabled, the final Git record does not exist before
final acceptance. Use this sequence:

1. Before every intermediate track package in a multi-track change, confirm
   that the retained research log contains all required accounting to date.
   The package references the exact range and the retained research log as the
   current accounting source. Do not claim that the final commit exists.
2. Before a single-track combined package or the final change package in a
   multi-track change, complete the accounting in the retained research log.
   Keep the log and every implementer report through final acceptance.
3. After final acceptance, create the final squashed delivery commit. Copy all
   required accounting from the research log into the commit body as part of
   that commit creation.
4. Verify that the commit body contains the required accounting. Only then
   close the current change with `slate_change close`. Keep its research log and
   every implementer report. Only the user deletes the change folder.

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
