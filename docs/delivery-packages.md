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
defined in § Durable accounting. A package
summarizes the result. It does not replace those records.

Use short, self-contained statements. Lead with the track or change intention.
Put the result and the user's next action
first. Link the diff only when a decision needs it. Do not add a file table, a
proved-area roster, review counts, a verification section, a user-requested-fix
verification section, or a list of material available on request.

Keep failed checks, unmet targets, missing measurements, and known limits that
affect acceptance visible. Never hide a blocking failure, a relevant risk, a design
difference, or a decision that the user must make. Put such information in the
conditional attention section. A package may mention a check only when its
failure or limit affects the user's decision. The durable record keeps the full
check results and review verdicts.

## Track package

Use this order. `<number>` is the track identifier (canonical path number).

```markdown
## Track <position> of <count> (<number>): <name>

**Intention**
<The approved behavior and scope.>

**Result**
<What the track completed and the user-visible or workflow result.>

**Needs attention**
<Only acceptance-relevant risks, failures, limits, design differences, or decisions. For
each decision, give every option and its consequence. Omit this field when none
exists.>

**Next step**
<Ask for blocking track acceptance for every code track in a multi-track change.
For a design track, ask for whole-subtree acceptance.>
```

The **Result** states the completed outcome, not an activity log.
Show names, finding details, and accounting references only when a decision needs them.
Keep the cumulative implementation commit or exact range in the owning research log.
For code ranges and design markers, use [change-records.md](change-records.md)
§ Identifiers, code ranges, and design markers.
The owning research log names a design track's approved design, accepted child ranges,
and its contribution to the change delivery. A design track has no implementation range or extra cumulative commit.
Do not count accepted child work as new implementation.
With publishing, state the delivery result when it affects acceptance.
Disclose merge state and unmerged dependencies when acceptance needs them.
Keep the publishing state in the owning log.

The **Next step** states the applicable acceptance action. Follow
[track-workflow.md](track-workflow.md) § Delivery and termination for the
code-track acceptance and boundary rules.
For a design track, use [recursive-workflow.md](recursive-workflow.md) § Whole-subtree acceptance.
The package states deviations and their effects on later sibling tracks.
Before change completion, list each remaining document, prompt, or extension difference and its later owning track.
The package asks for blocking track acceptance for every code track in a multi-track
change, regardless of proved areas. Final change acceptance remains separate.

## Change package

Use this order:

```markdown
## Change: <name>

**Intention**
<The approved behavior and scope.>

**Outcome**
<What the whole change now achieves.>

**Goal status**
<State whether every approved goal is complete. Identify any incomplete goal.>

**Remaining concerns**
<Only relevant risks, deferred work, open issues, or unresolved feedback. Omit
this field when none exists.>

**Model-routing recommendations**
<Advice supported by current-change records, only when trusted configuration
also enables workflow.routingRecommendations. Omit this field when no advice exists.>

**Decision**
<Request final acceptance. State every other required decision with all options
and consequences.>
```

The **Decision** field asks explicitly for the final acceptance required by
[track-workflow.md](track-workflow.md) § Delivery and termination. Do not treat
silence as acceptance.
The owning research log records the change's delivery state.
Disclose an unfinished dependency when it affects acceptance.
The whole change uses one branch and at most one pull request.

When trusted configuration enables `workflow.routingRecommendations` and records
support advice, include **Model-routing recommendations** immediately before **Decision**. Use
only current-change action records that name a logical model. Follow the
evidence and authority limits in
[track-workflow.md](track-workflow.md) § Routing recommendations at change
completion. Keep a no-advice result only in the research log and omit the field.

When the setting is disabled, omit the field. The field is advisory. It never
authorizes or performs a configuration, routing, model, effort, rating,
provider, or roster change.

## Single-track combined package

A single-track change sends one completion message using the change package.
Use no track name and ask only for final change acceptance.
Do not send a separate track package.
Apply the presentation comparison rule in [track-workflow.md](track-workflow.md).
Show full content once, then only changes from the last shown version, else the
last approved or accepted version. Give one no-change sentence when unchanged.
Neither presentation nor that sentence grants approval.

## Durable accounting

The **accounting sources** are the owning records behind each package.
Read the root `research-log.md` and current authoritative `root-design.md` when a root design exists.
Read every entered design track's `track-<number>-research-log.md` and authoritative `track-<number>-design.md`.
Here `<number>` is the canonical path number defined in [change-records.md](change-records.md).
Read every code track's implementer report and review-fix evidence in the affected track's records.
Follow each record's read-only source chain within its recorded read boundary.
Include required conclusions held in any of those records, not only the active log.
Use `status.md` to find records, never as gate or completion evidence.
Temporary files and incomplete retained copies are not accounting sources.
An action folder under `tmp/` supplies no accounting evidence.
A design copy under `versions/` is evidence only when its complete bytes match the hash in its name.
A `<name>.vN.md` design copy is evidence when its complete bytes match the hash recorded in the owning log.
Here `<name>` is the design filename without `.md`, and `N` is its version number.
The current design file remains authoritative.
Keep all manual records and their source chains through and after root closure.
Only the user deletes the change folder.
Reconcile required conclusions from every accounting source into the owning research log before each package and before root closure.
The owning research log retains all check results and limits, the separate routine-review
and user-requested-fix verdicts, every finding and disposition, user-note
accounting, the ignored-finding index, tracked issues, overrides, escalations,
coverage conclusions, and recorded risk changes.
It also retains design-track acceptance, child completion references, accepted
history bindings, review-fix accounting, and each issue's purpose and disposition.
Required accounting may remain only in retained private research records after root closure.

The research log is the accounting authority on both delivery paths.
Attribute design-track and review-fix conclusions to their level in the owning log.
Keep root-wide and whole-subtree conclusions in the log that closes them.
Reference other levels without counting their implementation again.
Keep accounting out of the pull request description and its squash-merge commit body.
Packages disclose relevant concerns and decisions.
Show accounting references only when a decision needs them.
After merge, verify that the host merged the recorded accepted final head.
Use [pr-publishing.md](pr-publishing.md) § After the merge for every merge method.
Record that result in the owning log before root closure.
Report delivery state only when a decision needs it.

Use this order even when the pull request is already ready:

1. Obtain every required code-track and whole-subtree acceptance after its package and prerequisites.
2. Record each decision and its aggregate evidence in the owning research log. Add design markers only after their whole-subtree acceptance. Reuse earlier accepted boundary evidence.
3. After all whole-subtree acceptances, obtain root final acceptance of the whole change.
4. Finish required markers and branch updates under [pr-publishing.md](pr-publishing.md) § After the flip. Obtain renewed acceptance when that rule requires it. Verify all owning logs against every accounting source.
5. Then record the accepted final head of the change branch in the owning research log before merge handoff.
6. Only then hand the pull request to the user for merge. Only the user merges.

A missing acceptance or required conclusion blocks handoff for merge.
Verify the change's delivery accounting and all root-wide accounting before root closure.

<!-- publishing-disabled-accounting:begin -->
With draft publishing disabled, deliver accepted branch history in this sequence:

1. Before each intermediate code or design package, reconcile all accounting
   sources for that track and its subtree. Show record and range references only
   when a decision needs them.
2. Before the change package, reconcile every accounting source across the whole
   change. Complete each design-track acceptance before its marker.
   Retain all records and accepted histories through root final acceptance.
3. After root final acceptance, finish required markers after their acceptance
   decisions. Acceptance adds no commit or rewrite.
   Keep the local branch and accepted-marker branches until root closure.
   Use the local branch for delivery verification and resume.
   Follow [track-workflow.md](track-workflow.md) § Delivery and termination.
4. Before local delivery, check all history reachable from the delivered branch for
   private change records and private bytes, not only the final tree. On a match, pause.
   The user chooses rewrite before publication, explicit waiver, or abandonment.
   Preserve reviewed state under [track-workflow.md](track-workflow.md)
   § Delivery history and accounting. Renew acceptance of the rewritten head before delivery verification.
   Verify the completed history and owning-log accounting separately against the
   accepted history and every required conclusion before closing with `slate_change close`.
   Keep all manual records and source chains. Only the user deletes the change folder.

Abandonment at any stage ends with `slate_change close`. No delivery artifact is
needed for abandonment, and the close deletes nothing.

A publishing-disabled single-track change starts at step 2.
A multi-track change repeats step 1 for each track, then runs steps 2 through 4.
<!-- publishing-disabled-accounting:end -->

Retain conclusions and evidence needed for the listed accounting. Do not
publish private reasoning, secrets, credentials, private user data, or
unnecessary personal data. A package names the accounting source only when a decision needs it. It does not copy the full accounting into the conversation.
A blocking item or a relevant concern still appears in the package even when
its detail also exists in that source or log.
<!-- delivery-package-contract:end -->
