# Draft-PR publishing

A pull request proposes a branch's changes for review and merge.
A draft pull request is not yet ready for that review.
Use [track-workflow.md](track-workflow.md) for the common lifecycle.
This document applies when `workflow.draftPRs` is enabled in home or trusted project `slate.json`.
The default is false. When disabled, create no pull request.
The research-log lifecycle is owned by track-workflow.md § Session handoff and the research log.

## One draft pull request

<!-- level-publishing-policy:begin -->
Create one draft pull request for the whole change on one branch.
A change is the whole user request.
A level contains sibling tracks created by one split and groups planning only.
A code track implements bounded approved work.
A design track plans a nested change.
Nested work and review-fix children use the same change branch and pull request.
Use [recursive-workflow.md](recursive-workflow.md) § Dependency order and pauses for nested work.

The change is the merge unit.
All checks pass at each child marker.
Intermediate track packages and review intentions list every remaining difference across documents, prompt guidance, and extension behavior.
Name the later owning track for each difference.
Full agreement is required at change end.
Do not merge an incomplete change.
Only the user merges after root final acceptance.
Code and design markers follow track-workflow.md § Delivery and termination.

Draft publishing moves no planning, design, focus assessment, review, package, user-note, acceptance, or finding-disposition requirement.
Keep the research log and every implementer report through and after delivery.
Only the user may delete the change folder.
Every path under `slate-changes/` stays outside pull requests, including `tmp/` and leftover action files.
<!-- level-publishing-policy:end -->

## Creation

Create the change's draft after all applicable pre-implementation gates and before implementation.
With a high-level design, create it after final design approval.
Author the template-shaped description from established facts under § Description rules.
Author and maintain it without presenting it for approval.

Without a high-level design, create the draft after the confirmation gate and before implementation.
If a design becomes required later, keep the existing draft.
Follow the size or late-area design route in track-workflow.md.
Record changed intent in the research log, not as a draft progress update.
Do not recreate the pull request or apply creation timing retrospectively.

Every creation path keeps these safeguards:

- Create the pull request as a DRAFT from the project's development branch.
  Nested work creates no other branch base or pull request.
- If the working branch has no difference against the base, create a bootstrap empty commit to open the pull request.
- When a high-level design exists, read the current authoritative root design at creation.
  Use its approved plan only for fields requested by the selected template.
  Read the owning log for approval hashes, decisions, and review evidence.
  A copied design in a log is not the authoritative plan.
- Without a high-level design, use established request facts and intended results only for fields requested by the template.
- Retain the research log and append decisions throughout implementation.
  track-workflow.md § Session handoff and the research log owns its full lifecycle.

## Description rules

The selected project template exclusively governs description content.
Slate adds no required sections, accounting fields, or progress table.
At creation, inspect the project's contributor instructions and available pull request templates.
Follow the project's documented choice when several templates exist.
Ask the user before creation if the choice remains ambiguous.
An unavailable template does not prove that none applies.
Resolve access or selection uncertainty rather than silently using the default.
Use § Default template only when no applicable project template exists.

Fill only fields supported by established request facts, approved design, or completed evidence.
Describe intended changes as intent, not completed work.
Do not mark tests or checklist items complete before their evidence exists.
Leave unsupported fields unfilled in the form the project permits.
Do not invent results to complete a template.
Describe the whole change within the fields the template requests.
The description is not a workflow accounting record.

## Default template

Use this short form when no applicable project template or commit rule exists.
At creation, describe why the change is needed and the planned change.
For the final description at change completion, describe delivered results.

```markdown
## Why
<Why the change is needed.>

## What changed
<What the change delivers.>
```

This form adds no workflow accounting or progress table.

## Keeping the PR in sync

Create the draft description from established facts using the selected template.
Keep progress, decisions, and plan differences in the research log during implementation.
Do not refresh the draft description after each track or marker.
At change completion, update the final title and description under § Ready-for-review flip.
The final title names the delivered result and preserves project title conventions.
Before renewed merge handoff after fixes, refresh final-result text if the result or template changed.
An unchanged result and template need no rewrite.

## Ready-for-review flip

Complete every code track, required machine review, track package, requested fix, and blocking user note.
Code-track acceptance follows [track-workflow.md](track-workflow.md) § Delivery and termination.
A subtree contains a track and all its descendants.
Obtain every design track's explicit whole-subtree acceptance and add its design marker.
Then obtain root final acceptance after the note queue, final accounting, and every other final gate.
Follow [delivery-packages.md](delivery-packages.md) § Durable accounting in order.
Ready status supplies no acceptance or permission for an agent merge.
Apply this sequence even when the pull request is already ready.

The flip to ready-for-review is the agent's last act before merge handoff.
The user performs the merge. The agent never merges a pull request.
Post-flip fixes and post-merge verification remain agent duties.
Execute this checklist in order:

- Complete every layered peer review or obtain an explicit user waiver.
  A flip discards no pending review.
- Summarize behavior changes since the last user-approved gate, including without a design gate.
  Apply the presentation comparison rule.
  Ask for ready-for-review permission.
  Keep commits, accounting, and the ignored-finding index in the owning research log.
- Update the title to name the delivered result under project conventions.
  Reread the selected project template, or § Default template when none applies.
  Fill the final description with only the change's final results that the template requests.
- Resolve every open question or record its explicit user-approved disposition in the owning log and relevant package.
  A mention without the user's disposition is not enough.
- Reread the whole description against the selected template and final result.
  Confirm that the text is consistent.
  The behavior summary replaces presentation of the final description.
  The description remains available on request.
- Complete the private-history check under track-workflow.md § Delivery history and accounting before each push and before delivery.
  Finish required markers and branch updates under § After the flip, including renewed acceptance when required.
  Record the accepted final head in the owning research log before merge handoff.
  The head is the branch's final commit.

## After the flip

The user may wait for passing continuous integration checks or peer review and request fixes.
Commit each requested fix separately and report behavior and fix status when acceptance is needed.
Ask one batch acceptance question with each fix separately selectable.
Keep progress in the owning research log, not the description.
Reconcile reviewer-pushed changes at renewed merge handoff.
Reread the selected template and refresh final-result text only if the result or template changed.
Before merge, summarize behavior changes since the previous summary.
Use one no-change sentence when unchanged. The summary grants no approval.
The description remains available on request.

After root final acceptance, only required empty markers may be added without renewed acceptance.
Any other commit, including a base merge or fix, needs renewed acceptance before recording the accepted final head.
Record that head before merge handoff.
A commit pushed after acceptance needs renewed acceptance and a new recorded head before merge handoff.
Record each decision and its evidence only in the owning research log.
Verify log accounting before the behavior summary and merge handoff.
Keep the skipped late-area design-gate record visible at final acceptance.
Ready status and the merge act supply no missing whole-subtree or root final acceptance.

## Merge method advice

Recommend merge commits or rebase merges because they preserve separate implementation commits.
A merge commit keeps source history as ancestry.
A rebase merge reapplies commits and can drop empty markers.
A squash merge combines the change into one commit.
Its separate commit list and markers do not reach the target branch.
Slate accepts those losses.
The user chooses a method the project permits.
Slate requires no method and configures no repository merge setting.

Do not require target-branch marker survival or a source-to-target commit mapping.
GitHub keeps original pull request commits under a host-managed reference.
That host behavior is not a portable retention service supplied by Slate.
Unverified merge-queue behavior supplies no workflow precondition.

## After the merge

For every merge method, verify that the source head the host merged equals the recorded accepted final head.
Compare the source head, not the resulting target commit or its parents.
If the host cannot report the merged head, pause and ask the user.
A mismatch pauses delivery verification.
Record the observed delivery result and accepted-head comparison only in the owning research log.
Verify completed history and change accounting before root closure.
Use the local change branch for delivery verification and resume, not the target branch or a host reference.
Keep the local change branch and every branch holding accepted markers until root closure.
Host branch deletion does not permit local deletion before closure.
Report delivery state only when a decision needs it.
Close only after delivery verification and owning-log reconciliation under track-workflow.md § Session handoff and the research log.

Abandonment also ends with `slate_change close`, even without a delivery artifact.
Closing deletes nothing. Keep the folder and reports.
Only the user deletes the change folder.

Any cleanup required by layered peer review remains an agent duty under that process's rules.
<!-- accepted-history-cleanup:begin -->
Cleanup that deletes the local change branch or a branch holding accepted markers waits until root closure.
A reported merge alone is not root closure.
<!-- accepted-history-cleanup:end -->
