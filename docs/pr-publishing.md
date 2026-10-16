# Draft-PR publishing

A pull request proposes a branch's changes for review and merge.
A draft pull request is not yet ready for that review.
Use [track-workflow.md](track-workflow.md) for the common lifecycle.
This document applies ONLY when
`workflow.draftPRs` is enabled in home or trusted project `slate.json`
(default: false). When it is disabled, the workflow creates no pull request.
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

Draft publishing does not remove or move planning, design, focus approval,
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
level description before final design approval.
Present the draft beside the validated design.
Each design track with a level pull request presents its level description
with its validated design for one final approval.
When an adversarial design review is required, present both after that review.
One final approval covers the design and description.
The description has no separate approval gate.
Create the pull request after final design approval.

For a change without a high-level design, create the pull request after the
confirmation gate and before implementation. If the change later requires a
high-level design, keep the existing draft. Follow the size or late-area design route in track-workflow.md and synchronize
the description. Do not recreate the pull
request or apply its creation timing retrospectively.

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
  Use its approved plan in the pull request description.
  The files are `root-design.md` and `track-<number>-design.md` in the current change folder.
  Here `<number>` is the canonical path number defined in [change-records.md](change-records.md).
  Read the owning log for approval hashes, decisions, and review evidence.
  A copied design in a log is not the authoritative plan.
  Create the pull request only after final design approval, as stated above.

  Key decisions, Risks, and Open questions feed the corresponding
  Planned-changes subsections. The applicable design review verdict lines land
  in Risks & accepted trade-offs. The adversarial review verdict line lands
  there only when that review ran. A change without that review carries the
  design verdict lines alone.
- For a change without a high-level design, the initial request supplies
  Motivation. The intended fix supplies Planned changes. If a log exists, its
  relevant decisions and Open Questions also fold into the description.
- The research log is retained until delivery, and its Decision Log
  keeps appending during implementation. track-workflow.md § Session handoff
  and the research log owns the full lifecycle.

## Description rules

The description follows the repository's PR template, if any, and
carries three parts: Motivation (why), "Planned changes" (detailed but
high-level), and "Tracks" (a display table for a level with several code tracks).
Each description states its level's scope.
Link related level deliveries without claiming their changes as new work.

Write Planned changes at a high design level using the MAIN DOMAIN
ENTITIES from the code — real class and component names. Hard guards:
no file paths, no method signatures. If a sentence would change when a
method is renamed, it is too deep.

Subsections activate when their content exists:

- **Current state** — the before-picture per affected area.
- **What changes** — the externally observable contract/behavior: API
  surface, semantics, defaults, persisted formats, compatibility,
  concurrency guarantees.
- **How** — design-level description.
- **Key decisions** — chosen vs rejected; preempts "why not X?" review
  comments.
- **Out of scope** — explicit non-goals.
- **Risks & accepted trade-offs** — including the applicable design
  review verdict lines, and the adversarial review verdict line only
  when that review ran.
- **Ignored findings** — a one-line index for every ignored finding. Each entry
  carries its identifier, location, and one-line summary.
- **Delivery accounting** — the conclusions that
  [delivery-packages.md](delivery-packages.md) § Durable accounting requires.
  Update this subsection from all owning accounting sources defined there
  before each package for this level. Keep private reasoning and private data out of it.
- **Verification approach** — 1–2 lines.

"Deep enough" test: a reviewer who knows the codebase but not this
change can (1) predict which subsystems the diff touches, (2) evaluate
each track's diff against a stated intent, and (3) answer "why not
alternative X" without asking.

A squash merge combines a pull request's commits into one delivery commit.
Its description becomes that commit's body on the default development branch.
Write it as the durable record for this level.

Aim to keep the final delivery commit body at or below 16,384 UTF-8
bytes, excluding the subject. This is a target, not a gate. Measure
the exact body text as UTF-8 without adding a newline: for a PR, count
the GitHub API `body` string; for a delivered commit, count the byte
sequence after the subject separator in `git cat-file commit <sha>`.
Do not use a formatted `git log` value such as `%b`, which adds an
output newline.

If the body is larger, first remove repetition and merge overlapping
material. Then record a size exception in Risks & accepted trade-offs
carrying measurements, not assurances: the overrun, by the canonical
method above; every top-level section's byte count by that same
method, largest first; and, for each section that was condensed, its
byte count before condensing. A section with no before-count is
visibly untouched, so the user weighs any claim that nothing could be
removed against the counts beside it, and can refuse the exception. Do
not remove decisions, risks, verdicts, or evidence needed to
understand or review the change only to meet the target.

By the canonical measurement above, the most recent accepted delivery
body, from the publishing-enabled path, was 20,957 bytes: 27.9% above
the target. That precedent establishes that a justified overrun can
pass; it does not establish the typical size of either delivery path
or a content-equivalent exception in the publishing-disabled path.

## Tracks table

The description's Tracks section holds the track table; its
constraints (display-only, no SHAs, never the source of truth for
track boundaries) are owned by track-workflow.md § Delivery and termination.
A level with one code track carries an "N/A (single-track)" placeholder instead
of a table.

## Keeping the PR in sync

Keep the title and description synchronized with what is actually pushed.
Update a track's table row when its marker commit lands. Append post-design
decisions as they are made. Revise Planned changes whenever reality diverges
from it. Before each package for this level, copy its required delivery
accounting from the complete accounting source set in
[delivery-packages.md](delivery-packages.md) § Durable accounting into the description.
A stale description fails the "deep enough" test.

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
After each required acceptance, run the ordered acceptance-transfer sequence in
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
- Every ignored finding is reported to the user, and the Ignored findings index
  is present in the description.
- Strip the whole Tracks section from the description, whatever its
  form — the table for multi-track changes or the "N/A (single-track)"
  placeholder — plus any notes under it. Preserve required acceptance and
  history references in Delivery accounting.
  A squash merge does not preserve marker commits in the default-branch history.
  For changes that load the nested sections, complete the retention protocol in
  [recursive-workflow.md](recursive-workflow.md) § Level publishing and retained history before the final ready flip and each merge handoff, and for the comparisons after each merge.
  Motivation and Planned changes remain in the description.
- Update the PR title and description to the final state of the
  level: the title names what was actually delivered — preserving any
  prefixes or markers the project's conventions require — and the
  description, including the Planned changes section, describes the
  level as implemented, folding in everything added, dropped, or
  reshaped since the draft PR was opened.
- Resolve every remaining Open Question, or record its user-approved
  deferral or accepted uncertainty in Risks & accepted trade-offs. A
  mention without the user's disposition is not enough.
- Measure the final PR description by the canonical method in §
  Description rules. If it exceeds the target, verify that Risks &
  accepted trade-offs carries the size exception's measurements: the
  overrun, the per-section counts, and the before-counts of whatever
  was condensed.
- Last, re-read the whole PR description end-to-end to confirm the
  as-flipped text tells one consistent story.

## After the flip

The user may wait for CI green and/or peer-review completion and ask
the agent to fix test failures or review observations. The agent lands
fixes as normal commits, keeps the description in sync, and presents
agent-landed commits to the user as they land. After every post-flip
description change, and again at the final handoff for merge, repeat
the byte measurement and any over-target size exception required by §
Description rules. Commits pushed directly by reviewers are visible in
the PR UI; the agent reconciles the description with them on its next
task.
The user's merge act approves the current pull request, including
acceptance of any recorded description-size exception.
A merge does not supply whole-subtree or root final acceptance.
Obtain each required explicit decision before the merge.
After the decision, copy it and its evidence references into the closing level's description.
Verify that updated accounting and present the description before handing it to the user for merge.
Ready status does not bypass this order.

## After the merge

After the user merges a level pull request, verify that level's delivery accounting.
Verify the observed merge commit's identity and parents against its accepted history and pull request.
Record the observed merge-result binding in the reachable description and owning log.
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
