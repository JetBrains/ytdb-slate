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
Within one level, tracks finish in dependency order.
A dependency requires another track's result before affected work can finish.
When tracks do not depend on each other, design tracks finish first.
All work forms one linear history.
Each level pull request contains one contiguous slice of that history.
A contiguous slice is an uninterrupted range of commits.

When dependency order would break a contiguous level pull request, the planner changes the split.
Complete an entered subtree before continuing its siblings, except for a permitted dependency pause.
A subtree may pause for an unfinished sibling dependency only when none of its open level slices has commits.
A publishing bootstrap commit does not count as a subtree commit for this pause precondition.
Otherwise the planner changes the split before that subtree's first commit.

A late dependency discovery after commits exist stops work for a user-approved replan.
A pause creates no permission to interleave commits in an open slice.

A pause changes work order, not completion or acceptance.
The paused subtree keeps its records, pending gates, and accepted evidence.
Keep one sequential implementation writer.
Independent research and reviews may run in parallel.

Record the pause as a typed `decision` entry in the owning parent research log.
The entry names the paused subtree, unfinished sibling dependency, and resume condition.
It records that no open level slice of the subtree has commits.
Show that decision and pending dependency in `status.md` before continuing the sibling.
Resume reconciliation reads the decision and checks the completed dependency before continuing the subtree.
A status entry alone does not authorize a pause or resume.

A split change keeps stable track numbers and each new track's required approvals.
It does not authorize a noncontiguous level delivery.
It does not reduce reviews, repair budgets, markers, or acceptance.
Earlier completed descendant work is the foundation, not new work in an upper-level slice.
A stacked pull request uses another pull request's branch as its base.

Use dependency order for branch bases and merges, including when code must finish before a sibling design subtree.
The code-containing level branch starts from the latest completed history head for that level's dependency order.
The dependent subtree's first level branch bases on the completed code-containing branch.
Later dependent level branches base on the latest completed preceding level branch.
The user merges the code-containing level pull request only after its level is complete.
Every track of that level, including the dependent design subtree, must have its required acceptance.
The user then merges the dependent pull requests in dependency order.

An existing level slice cannot be reopened around an intervening subtree.
If the plan would require that reopening, change the split before the first affected commit.
If an enclosing acceptance gate prevents a foundation-first merge, change the split before those commits.
The branch-base rule waives no enclosing acceptance or final-merge gate.

This dependency-driven order needs no separate project-arrangement approval.
A different project arrangement still needs user approval and every existing history safeguard.

Keep branches and accepted marker history available until the root change closes.
For each delivered level, retain its accepted history boundaries and accepted branch head.
Bind that history to its pull request and observed merge result in the owning research log.
The default-branch merge result proves delivery, not track completion.
A squash merge does not replace accepted marker authority.

The retention rules below apply only to changes that load this document's nested sections.
Such a change has a current or proposed design track or review-fix child track.
An ordinary change with neither triggering track type has no retention-reference duty, with publishing enabled or disabled.

A retention reference is a named Git reference that keeps a recorded commit reachable.
A binding records its name and exact commit.
Use `slate-retained/<change>/<name>`.

The `<change>` component is a short name recorded in the root research log before the first retention reference.
The full name must be a valid Git reference name and safe to publish.
It contains no private data.
Pass the name to commands as a quoted value.

The allowed `<name>` forms are the level branch name, `track-<number>-reviewed`, and `track-<number>-fix<r>-reviewed`.
A level reference uses the level branch name form.
A level reference moves only under the update rules below.
A reviewed reference uses the `track-<number>-reviewed` or `track-<number>-fix<r>-reviewed` form.
The `<number>` component uses the accepted canonical track spelling.
The `<r>` component is one increasing sequence per affected track across every review-fix child and every fix kind.
Record each allocated value and binding in the owning log.
The sequence is not a child's local fix-round count.
A retention reference is never a pull request head branch.

At each user review or acceptance event, create the named reference locally and record its exact commit.
If that name already has the identical binding, verify it and record the repeated event instead of recreating it.
Keep every reviewed or accepted head reachable before any later rewrite.
Never move an existing reviewed binding, even by fast-forward.

With publishing enabled, use only the remote that holds the level pull request branch.
Remote retention references are branches under `refs/heads/slate-retained/<change>/`.
With publishing enabled, require an empty remote listing for `slate-retained/<change>/` before the first retention push.
With publishing enabled, record the remote, listing, and observation in the root research log.
A failed listing or existing namespace does not establish uniqueness.
Pause and ask the user instead of overwriting an existing namespace.
A resumed change checks its recorded namespace and bindings instead of claiming a new empty namespace.
The namespace check authorizes no rename or update of existing references.

A reviewed reference is create-only, locally and remotely.
A create-only update makes an absent reference and never moves an existing one.
Check local absence before creation and make creation conditional on continued absence.
A lease makes an update conditional on the remote reference still selecting a specified commit.
An expected-absent lease requires the remote reference to be absent.
With publishing enabled, create the remote reviewed reference with an expected-absent lease.
A plain push does not establish remote create-only behavior.
Use the same local absence safeguards when first creating a level reference.
With publishing enabled, use the same remote absence safeguards for that creation.
A divergent binding under the same reviewed name pauses affected work for a user decision.
The user may approve another unique name, preserve both states under another kept reference, or choose an explicit evidence waiver.
A non-waiver choice must preserve every reviewed and accepted head.
No collision authorizes moving an existing reviewed binding.

A read-back observes the reference on the selected remote after a push.
With publishing enabled, inspect reachable history at each user review or acceptance event.
With publishing enabled, then push the event's named references under their creation or update safeguards.
With publishing enabled, read back each remote reference and check its exact binding.
Record each result in the owning log.
Complete this sequence before any later rewrite or reliance on remote retention.
With publishing enabled, keep these remote references until root closure.

Before every retention push, inspect all commits and objects reachable from each reference to be pushed.
This inspection covers event pushes, preserving-reference pushes, level updates, and retries.
Inspect reachable history, not only the pushed tree.
Use [recursive-workflow.md](recursive-workflow.md) § Design authority and privacy for the private-set definition and exposure warnings.
A current untracked file does not prove that ancestor commits contain no private bytes.
If inspection finds private bytes, do not push and pause.
Ask the user to choose a permitted rewrite, a limited explicit waiver, or abandonment.
A permitted rewrite removes the private bytes and records a new reviewed binding after its required review.
It never moves an existing reviewed reference.
History preservation before a rewrite must not push a commit that holds private bytes.
A waiver states which exposure or evidence limit the user accepts.
It grants no unstated publication permission and claims no recovered evidence.
Keep private reference-to-commit evidence in the owning log locally.
Public accounting includes only permitted conclusions and history references.
After inspection, every retention push must name its references explicitly.
No untargeted push may publish retention references, including all-branches, mirror, or matching pushes.
The reachable-history inspection duty applies only to retention pushes, not pull request branch pushes.
A pull request branch push must name its branch explicitly.
A pull request branch push must publish no retention reference.

A fast-forward update moves a reference to a descendant of its current commit.
An ancestry check proves that one commit is an ancestor of another commit.
A moving level reference normally advances by fast-forward from its latest recorded commit.
Before that update, check locally that the recorded commit is an ancestor of the target head.
With publishing enabled, the remote update must use a lease on that latest recorded commit.
Make any local update conditional on the same expected old commit.
Verify the result and record the successful new binding before relying on it.
With publishing enabled, verification includes a remote read-back after the inspected push.
The latest successfully recorded binding governs later comparisons.
Keep earlier bindings in the owning log.

Only a level reference may select a non-descendant head under the following exception.
Apply the exception only after a permitted rewrite under [track-workflow.md](track-workflow.md) § Delivery and termination.
A rebase reapplies commits on a different base commit.
A stacked level may need a rebase after its foundation merges by squash or rebase.
Before replacing the level binding, record the rebased-marker mapping in the owning log.
The mapping names each old and new marker commit and its applicable evidence.
It grants no new acceptance and waives no required rewrite review.
Check every reviewed and accepted head reachable from the old level commit.
An ancestry check must show that each head remains reachable from another recorded retention reference.
That preserving reference must differ from the level reference selected for replacement.
Verify each preserving reference against its recorded binding before the replacement.
With publishing enabled, inspect its reachable history, push it under its safeguards, and read back its exact remote binding.
With publishing disabled, verify its local binding.
Keep every preserving reference until root closure.
A mapping alone is not reachable history.
Record the old level binding, proposed target, mapping, and ancestry results before the update.
With publishing enabled, replace only the remote level reference under a lease on its latest recorded commit after reachable-history inspection.
In either publishing setting, make the local replacement conditional on the same expected old commit.
Verify and record the successful new level binding before relying on it.
With publishing enabled, that verification includes a remote read-back.
This exception permits no replacement of a reviewed reference.
If any exception condition is unmet, pause and ask the user under the collision rule above.
Do not move the old reference merely to solve that conflict.

A forced update is any non-fast-forward update or replacement of an existing retention reference, except for the permitted level replacement.
A checked fast-forward advances a binding and is not a replacement.
Forbid every forced update outside the exception.
The Git option `--force-with-lease` supplies a lease, not permission to bypass these rules.
With publishing enabled, use `--force-with-lease=<ref>:` for expected-absent remote creation.
With publishing enabled, use `--force-with-lease=<ref>:<recorded-commit>` for an authorized existing remote level update.
The fast-forward ancestry check or the complete rewrite exception must also pass.

With publishing enabled, after a failed or unclear push, read the remote before trying again.
For creation, an absent reference permits retry under the original inspection and create-only safeguards.
For an update, the recorded old commit permits retry only after its original inspection and authorization checks pass again.
The exact proposed target confirms the completed effect and needs no repeated push.
Record that observed successful binding before relying on it.
An absent existing reference or another commit pauses affected work for a user decision.
Do not retry an update against an unexpected commit.
A failed read leaves the effect unresolved and does not authorize retry.

**Stacked foundation rewrite example.** H1, H2, S, and H2' label commits.
The user accepts subtree 3.1 at H1.
The recorded create-only `track-3.1-reviewed` reference selects H1.
Track 3 has a user review or acceptance event at H2, which descends from H1.
Code track 3.2 receives blocking acceptance at H2 in this example.
Record H2 under create-only `track-3.2-reviewed` and the moving track 3 level reference.
With publishing enabled, complete event-time inspection, push, read-back, and recording before rewriting.
With publishing disabled, create and verify local bindings without a remote operation.
The user squash-merges 3.1 as S, which differs from H1.
A permitted rebase onto S produces H2'.
Record its old-to-new rebased-marker mapping in the owning log.
Complete every review and evidence-reconciliation duty required by that rewrite.
H2' does not descend from H2, so a fast-forward is not authorized.
Verify `track-3.2-reviewed` still selects H2 and `track-3.1-reviewed` still selects H1.
Check every reviewed and accepted head reached by H2 against another recorded retention reference.
An ancestry check proves H2 remains reachable from recorded `track-3.2-reviewed` at H2.
H1 and every other reviewed or accepted head remain reachable under their verified preserving references.
With publishing enabled, verify those remote bindings after inspection, push, and read-back.
With publishing disabled, verify their local bindings.
Replace only the track 3 level reference under the complete exception, using a lease on H2 when publishing is enabled.
In either setting, make the local replacement conditional on the expected old H2 commit.
Verify H2' and record it as the successful new level binding, with remote read-back when enabled.
Later level comparisons use H2', not the earlier H2 binding.
Keep the H2 and H1 reviewed bindings unchanged through root closure.
All exception conditions hold, so this example continues without a retention pause.

Before the final ready flip and every merge handoff, complete all required commits and retention checks.
For an already-ready pull request, repeat the checks without treating another flip as acceptance.
With publishing enabled, after acceptance markers, push every kept reference under its creation or update safeguards.
This includes final-marker and recovery-reference pushes, which require the reachable-history inspection above.
Read back every pushed reference and record each exact result in the owning log before handoff.
Recheck review-event retention rather than replacing it with the final checks.
Advance the current level reference through every final marker under the authorized update rules.
At handoff, that reference and its latest recorded binding must equal the actual pull request head.
Verify that remote binding by read-back.
An earlier binding does not satisfy handoff equality.
Any new commit after a check requires a fresh handoff check.

After merge, compare the host's recorded merged pull request head with the latest level binding used at final handoff.
Check that the level reference still equals that final-handoff binding.
Compare every kept reference with its latest recorded binding, including remote copies when publishing is enabled.
An exact head comparison uses that reference's binding, not a reachable ancestor.
Earlier level bindings remain historical evidence, not the merge-comparison target.
Record these comparisons with the merge-result evidence before root closure.
If the host cannot supply the merged head, pause rather than infer it from a squash commit.
Branch deletion by the host does not remove retained marker authority.
Missing evidence or any comparison mismatch pauses affected work for the user-choice route below.

A missing reference or a reference at another commit pauses affected work.
The user chooses recovery from another kept copy, an explicit evidence waiver, or abandonment.
Before recovering a wrong-commit reference, record its observed unexpected commit.
Keep that commit under a new unique reference approved through the collision route unless the user explicitly chooses to discard it.
Keep that preserving reference until root closure, with inspected push and read-back when publishing is enabled.
A missing reference has no unexpected commit to record or preserve.
Resetting a moved reference is a user choice, not an automatic recovery attempt.
A reset must pass the checked fast-forward rules or the complete permitted level-replacement exception above.
No choice authorizes a forced update or replacement of an existing reviewed reference.
Recovery establishes exact recorded evidence under an allowed binding before work relies on it.
An evidence waiver records its limit and claims no recovered evidence.
A status entry, merge result, or copied marker title cannot replace lost history.
Never create a marker to claim an earlier boundary that was not proved.

With publishing disabled, before the final squash, compare the local level reference for the branch being squashed and its latest recorded binding with that branch head.
Both must equal the complete head, including every marker commit.
An earlier binding does not satisfy this equality even when the reference still matches it.
Use the authorized local level-update rules above.
With publishing disabled, keep these local references until root closure, including through the final squash.
Check every kept local reference against its latest recorded binding before closure.
Retention requires no remote operation in this setting.
Do not push any retention reference to any remote when publishing is disabled.

**Retention cleanup before root closure.** Cleanup deletes retention references, not change records or delivered content.
These cleanup duties apply only to nested changes.
An ordinary change has no cleanup duty in either publishing setting.

A cleanup inventory lists recorded retention references and their latest recorded bindings.
Record the inventory after all closure conditions hold, including final post-merge comparisons and verified accounting.
With publishing disabled, record the inventory after final local comparisons and verified final-squash accounting.
For abandonment cleanup, record the inventory after the archival offer and the recorded explicit user choice to delete.

Count inventory entries across the root log and its read-only source chain within the recorded boundaries.
Read the chain in its recorded source order and select its latest inventory.
Require exactly one unambiguous latest inventory after every non-cleanup record and after all closure conditions hold.
Earlier inventories remain evidence and grant no deletion authority.
Zero entries or an ambiguous latest inventory permit no deletion.
Multiple historical inventories permit deletion only when one latest valid inventory is unambiguous.
The inventory condition governs deletion only, not close.

Before stopping, the cleanup worker records the inventory-count refusal under the ordinary safe-write rules of the still-open change folder.
Treat that refusal as incomplete cleanup and report it to the user.
Every authorizing record precedes the latest inventory, including closure evidence, the abandonment deletion choice, and marked-entry discard choices.
Read authorization only from those earlier records.
No record after an inventory may widen that inventory's deletion authority.

After the inventory, only cleanup observations, the user report, the retry-or-keep choice, and `slate_change close` may follow.
Any other record voids that inventory's deletion authority.
Examples include a new track, fix, decision, merge-result binding, abandonment withdrawal, or handoff state summary outside those permitted kinds.
Check for voiding records before each deletion, on resume, and before each retry.
If any voiding record exists, delete nothing and report the refusal to the user.

This structural refusal offers no retry against the voided inventory.
The user may keep the remaining references and close only when closure conditions still hold.

Alternatively, wait until every closure condition holds again.
The orchestrator then records a new inventory after every non-cleanup record.
Cleanup then uses only that latest inventory and its preceding authorization.
A new inventory does not amend an earlier inventory or authorize deletion under it.

Apply this route to missing or ambiguous latest inventories and missing earlier closure evidence too.
Also apply it when current closure conditions no longer hold.

A URL (Uniform Resource Locator) identifies a remote location.
Include the recorded namespace and, with publishing enabled, the remote name and its fetch and push URLs.
With publishing enabled, obtain the effective fetch URL with `git remote get-url --all "<remote>"`.
With publishing enabled, obtain the effective push URL with `git remote get-url --push --all "<remote>"`.
Require each command to return exactly one URL, not raw configuration values.
If either command fails or returns zero or multiple URLs, run no remote command.
Before stopping, the cleanup worker records that refusal under the ordinary safe-write rules of the still-open change folder.
Report that refusal to the user.

Userinfo is the user name and password before `@` in a URL.
Remove any userinfo from each URL before recording or comparing it.
Apply this removal identically to recorded and current values.
Never record a credential.

Before any remote command, compare both current URLs with the inventory.
If either URL differs, or the fetch and push URLs differ from each other, run no remote command.
Before stopping, the cleanup worker records the URL mismatch under the ordinary safe-write rules of the still-open change folder.
Report the mismatch to the user.

Follow root and subtree logs and their read-only folder-fork source chains within each recorded last-entry boundary.
Never write to a source folder.
Check each entry against its owning log's latest recorded binding, never an inferred current branch head.
Each entry names its recorded local, remote, or both copies, with each copy's full reference name and inventory commit.
The inventory commit is that copy's latest recorded binding.
Use the full inventory reference name in every command and reject short names.
Require each name to pass `git check-ref-format "<ref>"` before use.
Require the prefix `refs/heads/slate-retained/<change>/`, including its trailing slash, for every cleanup name.
A name under `<change>-old/` does not match that prefix.

Mark entries that preserve an unexpected recovery commit or a collision-preserved state.
Keep those entries unless the user explicitly chooses to discard that commit or state before the inventory.
A choice recorded after the inventory authorizes nothing.
Delivery alone or a general abandonment deletion choice does not authorize discarding a marked entry.
Before any deletion, the worker checks each entry's owning logs for a recovery or collision-preservation record.
Treat an unmarked entry with such a record as marked.
Keep it unless an explicit discard choice precedes the inventory.

Run cleanup in the closing session after every closure condition holds and immediately before `slate_change close`.
Pass the open change's Current research log path to the cleanup worker as for any record worker.
Use the ordinary current-folder rule in § Manual records and safe writes.
The worker must not infer the folder from other record text.
No inventory folder-path field or closed-folder write permission is required.

Before each deletion, require current closure conditions and root-log closure evidence from records before the latest inventory.
Also recheck that no voiding record follows that inventory.
Delivered publishing work requires final acceptance, each applicable level merge-result binding, post-merge comparisons, and verified accounting.
An unmerged level prevents delivery closure and deletion.
Disabled delivery requires final acceptance, final local comparisons, and verified final-squash accounting instead of level merges.
Abandonment requires the recorded explicit user deletion choice after the archival offer.
If closure evidence is missing, delete nothing.
Before stopping, the cleanup worker records the missing closure evidence under the ordinary safe-write rules of the still-open change folder.
Report the missing evidence to the user.

The orchestrator dispatches one bounded cleanup worker action.
That action may only delete authorized inventory references and append permitted cleanup observations in the open root log.
Permitted cleanup record kinds are comparisons, listings, deleted and kept copies, failures, interruptions, refusals, incomplete-state observations, and the user report.
The cleanup action writes no other record and no record outside the open root log.
Use the normal temporary start copy, separate temporary append texts, `>>`, whole-record comparison, and retry inspection.
Finish the worker and every record write before close.
It cannot add or amend closure evidence, the inventory, a mark, or a user choice.
Cleanup acts only on recorded copies, without inferred counterparts or pairing by commit.

A regular reference stores a commit identifier, while a symbolic reference names another reference.
Before deleting any copy of an entry with a local copy, check that the local inventory reference is regular.
First confirm existence with `git show-ref --verify "<ref>"`.
A missing local reference permits no deletion for that entry.
Only after existence succeeds, run `git symbolic-ref -q "<ref>"`.
Exit status 1 means not symbolic only after that successful existence check.
Exit status 0 identifies a symbolic reference, so keep all recorded copies and report it.
This also forbids deleting a symbolic reference that resolves to an excluded branch at the inventory commit.
For any other exit status, delete nothing and report the failed check.

Compare each recorded local copy with its inventory commit.
With publishing enabled, read each recorded remote copy live and compare it with its inventory commit.
A remote-tracking reference is an earlier local observation, not a live remote read.
Delete only when all applicable comparisons match, except for the confirmed-absence continuation below.

For both-copy entries, delete the explicitly named remote reference first.
A delete refspec names the remote reference to remove.
A full-reference lease names that same complete reference and its expected inventory commit.
Use this explicit deletion form, with every placeholder quoted:

```sh
git push "--force-with-lease=refs/heads/slate-retained/<change>/<name>:<inventory-commit>" "<remote>" ":refs/heads/slate-retained/<change>/<name>"
```

The lease reference must equal the deleted reference.
Forbid `--force`, a `+` refspec, a bare lease, and a tracking-ref lease.
Read back remote absence before deleting a recorded local copy of that entry.

Repeat both the existence and regular-reference checks immediately before local deletion.
Delete locally with `git update-ref --no-deref -d "<ref>" "<inventory-commit>"` in either publishing setting.
The expected old commit is mandatory, and deletion must never dereference a symbolic target.
A remote-only entry uses the same leased deletion and absence read-back.
A local-only entry requires no remote counterpart.
A one-sided entry is complete when its recorded copy is deleted and absence is confirmed.
With publishing disabled, delete only recorded local copies under the conditional check and run no remote command.

Never delete an unlisted name or a name outside the recorded namespace.
Never delete a pull request branch, a local level branch, or the default branch.
Use no untargeted deletion, including prune, mirror, pattern, or all-branches deletion.
Every deletion requires an explicit inventory name.

A mismatch, missing recorded copy on initial comparison, or unexpected reference permits no deletion for that item.
Keep remaining copies unchanged, record the observation, and report to the user.
Never delete against an unexpected commit or substitute a pull request branch for a missing retention copy.
The confirmed-absence continuation below is the only exception for a missing remote copy.

An earlier cleanup observation may record the remote copy's confirmed absence for this cleanup.
For that both-copy entry, read the remote reference live before continuing.
If it is still absent, continue with the local copy under every local check.
A present remote copy or a failed read permits no continuation and must be reported.
Observations alone authorize no deletion.
Only the latest valid inventory remains the deletion authority.

After a failed or unclear remote deletion, read that remote reference before any retry.
Observed absence confirms deletion and must be recorded.
The inventory commit permits retry under the same full-reference lease and safeguards.
Another commit permits no retry and must be kept and reported.
A failed read leaves deletion unresolved, permits no retry, and must be reported.
A failed local conditional deletion leaves the remaining local copy unchanged and must be reported.
Before any local retry, read the local reference again.
Retry only if the fresh read shows the inventory commit and both regular-reference checks pass again.
A missing reference confirms absence, while another commit or a failed read permits no retry.
Record and report the observed result.

After deletion, list the remote namespace when publishing is enabled and the local inventory names in either setting.
Record both applicable listings in the root research log.
Record each deleted copy's name and old commit, and each kept copy's name and reason.
Report the result to the user.
Cleanup is complete only when no inventoried copy remains and every confirmation listing succeeds.
Kept copies, failures, unresolved deletions, or a failed confirmation listing leave cleanup incomplete.
For every incomplete cleanup exit, report the result to the user.
Record an observation under the normal write rules before stopping.
The observation states that cleanup is incomplete.

The orchestrator reports the cleanup result to the user before `slate_change close`.
For incomplete cleanup without a structural refusal, the user chooses retry or close with the remaining references kept.
A structural refusal offers only keep or a new inventory after closure conditions hold again.
State the kept copies, failures, unresolved deletions, and failed listings in that report.
Record the explicit choice after the latest cleanup report through an ordinary record-only action.

The cleanup worker cannot record or amend that user choice.
A choice after the inventory authorizes no deletion.
A retry uses only the latest valid inventory and its earlier authorization, not the later choice as deletion authority.
Before each retry, recheck closure conditions and the absence of voiding records after that inventory.
Dispatch one bounded cleanup action at a time and repeat every applicable live read before each deletion.
Record the retry observations and report the result before close.

A keep choice ends cleanup.
Only close may follow in that cleanup sequence.
More deletion requires a new user report and a retry choice recorded after that report.
The retry still requires a valid latest inventory and all deletion safeguards.
A structural refusal still requires the new-inventory route before any further deletion.
The choice that permits close must follow the latest cleanup report.

A recorded keep choice permits close with incomplete cleanup only when closure conditions still hold.
It claims neither confirmed absence nor successful cleanup.
Neither incomplete cleanup nor that choice changes acceptance, accounting, or merge records.

For an applicable cleanup sequence, close follows the required user report and any required choice after that latest report.
An inventory-count refusal is incomplete cleanup, and a recorded keep choice permits close when closure conditions still hold.
Recheck closure conditions before every close, including close after complete cleanup.

If the session ends before cleanup finishes, the change stays open.
Keep remaining references in place.
Record the interruption and incomplete cleanup under normal write rules and report them to the user.
The next session follows Resume order and reconciliation and uses the structural-refusal route below.
Use the current folder and its read-only source chains under normal ownership rules.
On a folder fork, read inventories through the root log's recorded source boundary.
Apply the latest-inventory rule across the root log and its read-only source chain within the recorded boundaries.
On resume, check for voiding records before any deletion or retry.

The required handoff state summary voids the inventory like any other non-cleanup record.
The first source-naming record after a folder fork also voids the inventory.
Resume therefore permits keep-and-close only when closure conditions still hold.
Further deletion requires the orchestrator to record a new latest inventory after every non-cleanup record while all closure conditions hold.
Repeat every live read before deletion under that new inventory, including the confirmed-absence continuation rule above.
A closed folder grants no later-session cleanup route and permits no cleanup record write.

Abandonment has no automatic cleanup.
After the existing archival offer, ask whether to delete retention references.
Without an explicit recorded user deletion choice before the inventory, delete nothing.
If the user declines abandonment cleanup, record that choice and report the kept references before ordinary abandonment close.
The deletion inventory and worker sequence apply only when the user requests abandonment cleanup.
That no-cleanup choice grants no deletion authority.

`slate_change close` itself deletes nothing.
The cleanup step immediately before close is the only authorized end of the until-root-closure retention lifetime.
Authorized inventory cleanup after every closure condition holds ends approved retention and is not a rewrite under the reviewed-state rule.
This owner supplies deletion authority in both publishing settings.
The publishing-only accepted-history-cleanup block governs layered peer-review cleanup, not this inventory cleanup.

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
