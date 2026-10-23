# Draft-PR publishing

A pull request proposes a branch's changes for review and merge.
A draft pull request is not yet ready for that review.
Use [track-workflow.md](track-workflow.md) for the common lifecycle.
Except for the Default template section, this document applies only when
`workflow.draftPRs` is enabled in home or trusted project `slate.json`
(default: false). When it is disabled, the workflow creates no pull request.
The Default template section also applies to the final delivery commit when publishing is disabled.
That use adds no publishing duty.
The research-log lifecycle in that case is owned by track-workflow.md § Session
handoff and the research log.

## One draft pull request

<!-- level-publishing-policy:begin -->
Apply this section only when `workflow.draftPRs` is enabled.
A level contains the sibling tracks created by one split.
A code track implements bounded approved work.
A design track plans and completes a nested change.
Create one draft level pull request for each level with code tracks.
A level containing only design tracks has no pull request of its own.
A mixed level's pull request contains only its code tracks.
Design tracks produce the pull requests of their descendant levels.
A change without design tracks keeps exactly one pull request.
Do not create separate pull requests for code tracks or review-fix children.
For nested work, use [recursive-workflow.md](recursive-workflow.md) § Level publishing
and retained history for subtree ordering, branch bases, and history slices.

The level is the merge unit.
All checks pass at each child marker.
Agreement across documents, prompt guidance, and the extension is required at
the level boundary.
Do not merge an incomplete level into the default branch.
Intermediate track packages and review intentions list each remaining difference
across those surfaces and name the later child that owns it.
Only the user merges the pull request.
Each multi-track boundary uses a marker commit after its required gates,
as defined in track-workflow.md § Delivery and termination.

Draft publishing does not remove or move planning, design, focus assessment,
review, track-packet, user-note, blocking track-acceptance, final-acceptance,
or finding-disposition requirements. Retain the current change folder's
research log and every implementer report through and after delivery. Only
the user may delete the change folder.
Every path under `slate-changes/` stays outside pull requests, including `tmp/` and leftover action files.
<!-- level-publishing-policy:end -->

## Creation

Create the level's draft after all applicable pre-implementation gates.
Create it before the level's first code track implementation.

For a change with a high-level design and a level pull request, draft the
template-shaped level description before final design approval.
Use only established facts, as defined in § Description rules.
Present the draft beside the validated design.
Each design track with a level pull request presents its level description
with its validated design for one final approval.
When an adversarial design review is required, present both after that review.
One final approval covers the design and description.
The description has no separate approval gate.
Create the pull request after final design approval.

For a change without a high-level design, create the pull request after the
confirmation gate and before implementation. If the change later requires a
high-level design, keep the existing draft.
Follow the size or late-area design route in track-workflow.md.
Record changed intent in the research log, not as a draft progress update.
Do not recreate the pull request or apply its creation timing retrospectively.

Every creation path keeps these safeguards:

- Create the pull request as a DRAFT.
  A one-level change starts from the repository's default development branch.
  For nested work, choose its base under [recursive-workflow.md](recursive-workflow.md)
  § Level publishing and retained history.
  Use dependency order for bases, including code before a dependent design subtree.
  Base that subtree's first level branch on the completed code-containing branch.
  Base later dependent levels on the latest completed preceding level branch.

  The user merges the code-containing level pull request only after its level is complete.
  Every track of that level, including the dependent design subtree, must have its required acceptance.
  The user then merges the dependent pull requests in dependency order.
- If the working branch has no diff against the base yet, land a
  bootstrap empty commit so the PR can be created.
- At creation, if a high-level design exists, read the current authoritative design file for the change root or design track.
  Use its approved plan only for fields requested by the selected template.
  The files are `root-design.md` and `track-<number>-design.md` in the current change folder.
  Here `<number>` is the canonical path number defined in [change-records.md](change-records.md).
  Read the owning log for approval hashes, decisions, and review evidence.
  A copied design in a log is not the authoritative plan.
  Create the pull request only after final design approval, as stated above.

- For a change without a high-level design, use established request facts and
  the intended fix only for fields requested by the selected template.
- The research log is retained until delivery, and its Decision Log
  keeps appending during implementation. track-workflow.md § Session handoff
  and the research log owns the full lifecycle.

## Description rules

The selected project template exclusively governs description content.
Slate adds no required sections, accounting fields, or progress table.
At creation, inspect the project's contributor instructions and available pull request templates.
Follow the project's documented choice when several templates exist.
Ask the user before creation if the choice remains ambiguous.
An unavailable template is not evidence that no applicable project template exists.
Resolve access or selection uncertainty rather than silently using the default.
Use § Default template only when no applicable project template exists.

Fill only fields supported by facts established by the request, approved design, or completed evidence at that time.
Describe intended changes as intent, not as completed work.
Do not mark tests or checklist items complete before their evidence exists.
Leave unsupported fields unfilled in the form the project permits.
Do not invent results to complete a template.

Describe only this level's scope within the fields the template requests.
Link related level deliveries only when the template requests that information.
Do not claim related levels' changes as new work.
These scope and attribution rules add no template field.

A squash merge combines a pull request's commits into one delivery commit.
The host's merge behavior does not make the description a workflow accounting record.

## Default template

Use this short form when no applicable project template or commit rule exists.
At creation, describe why the change is needed and the planned change.
For the final description at level completion or a final delivery commit, describe delivered results.

```markdown
## Why
<Why the change is needed.>

## What changed
<What the change delivers.>
```

This form adds no workflow accounting or progress table.

## Keeping the PR in sync

Create the draft description from established facts using the selected template.
During implementation, keep progress, decisions, and plan differences in the research log.
Do not refresh the draft description after each track or marker.
At level completion, update the final title and description under § Ready-for-review flip.
The final title names the delivered result and preserves project title conventions.
Before renewed handoff for merge after fixes, refresh final-result text if the result or template changed.
An unchanged result and template need no rewrite.

## Ready-for-review flip

Apply this section separately to each level pull request.
All its code tracks and required machine reviews, track packages, requested fixes,
and blocking user notes must be complete.
A proved DESIGN-TRIGGERING area makes track acceptance blocking before its marker.
Keep the last pull request of a subtree unmerged until every design track it
closes has explicit whole-subtree acceptance and its design marker.
A subtree contains a track and all its descendants.
Ready status supplies neither acceptance nor permission for an agent merge.
Root final acceptance precedes the last level merge.
It waits for the note queue, final accounting, and every other final gate.
After each required acceptance, reconcile the owning log and verify retained history through the ordered sequence in
[delivery-packages.md](delivery-packages.md) § Durable accounting before handoff for merge.
Apply that sequence even when the pull request is already ready.

Flipping the current pull request to ready-for-review is the agent's last act
before handing that pull request to the user. The user performs every merge.
The agent never merges a pull request. Post-flip fix work and post-merge cleanup
stay agent duties below. The flip is gated by this checklist, executed in order:

- Any layered peer-review process (see track-workflow.md § Layering richer
  workflows on top) is completed or explicitly user-waived — flipping never
  discards a pending review.
- All commits landed since the last user-approved gate are presented
  to the user. For a change without a design gate, present the description here
  because no design approval presented it before implementation.
- Report every ignored finding to the user.
  Keep its index in the owning research log.
- A squash merge does not preserve marker commits in the default-branch history.
  For changes that load the nested sections, complete the retention protocol in
  [recursive-workflow.md](recursive-workflow.md) § Level publishing and retained history before the final ready flip and each merge handoff, and for the comparisons after each merge.
- Update the pull request title to name the delivered result and preserve project title conventions.
  Reread the selected project template, or § Default template when no applicable project template exists.
  Fill the final description with only this level's final results that the template requests.
- Resolve every remaining open question, or record its explicit user-approved disposition in the owning research log and relevant package.
  A mention without the user's disposition is not enough.
- Last, reread the whole description from start to end against the selected template and final result.
  Confirm that the text is consistent.
  Present the final description to the user before the flip, including when a design gate presented the draft.

## After the flip

The user may wait for passing continuous integration checks or peer-review completion and ask the agent to fix failures or review observations.
The agent lands fixes as normal commits and presents them to the user as they land.
Keep progress in the owning research log, not in the description.
At renewed handoff for merge after fixes, reread the selected template.
Refresh final-result text only if the result or template changed.
Reconcile reviewer-pushed changes at that handoff.
Present the final description before handing the pull request to the user for merge.

The user's merge act approves the current pull request.
A merge does not supply whole-subtree or root final acceptance.
Obtain each required explicit decision before the merge.
After the decision, record the acceptance and its evidence references only in the owning research log.
Verify that log accounting, then present the separate final description and merge handoff.
Ready status does not bypass this order.

## After the merge

After the user merges a level pull request, verify that level's delivery accounting.
Verify the observed merge commit's identity and parents against its accepted history and pull request.
Record the observed merge-result binding only in the owning research log.
Report the delivery state in the next applicable package.
The merge commit itself supplies that binding, including for the last level.
The root final package lists every level delivery.
It distinguishes merged levels from every level waiting for merge, including levels held behind an unmerged foundation.
Close the root change only after all delivery accounting is verified.
Use track-workflow.md § Session handoff and the research log for closure.
Abandonment at any stage also ends with
`slate_change close`, even if no delivery artifact exists. Closing deletes
nothing. Keep its folder and reports.

Any cleanup a layered peer-review process requires is an agent duty.
Examples include closing its review pull requests and deleting its pinned branches.
Execute cleanup when the user reports the applicable merge or a later session detects it.
Follow that process's own rules, subject to this retention exception:
<!-- accepted-history-cleanup:begin -->
Cleanup that deletes a branch or reference holding accepted marker history waits
until the root change closes.
A change without design tracks is unaffected because its root closes at its merge.
<!-- accepted-history-cleanup:end -->
