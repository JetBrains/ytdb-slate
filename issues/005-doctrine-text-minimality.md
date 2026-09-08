# 005 — Limit doctrine text growth

**Status:** open, deferred from the **reviewer-model-default deletion** by
**reviewer-model-default deletion decision D1**. **Type:** workflow.

Add a workflow rule that keeps doctrine changes proportional to the request.

## The doctrine-minimality problem

The workflow has no rule that limits how much doctrine text a change may add.
Principle P11, proportional process, governs the count of required gates,
artifacts, and review actions. Its repo-local note says that a rule which
changes how an existing step is performed does not add cost under P11
(`docs/design-principles.md`, § 4, P11 and the following repo-local note).
That note excludes the case at issue.

The confirmation gate requires the predicted grade, expected counts, basis,
uncertainty, split, and required pre-implementation gates. It does not require
the proposal to state the smallest change that meets the request. It does not
require the proposal to consider deleting a conflicting rule before adding a
new rule (`docs/track-workflow.md`, § Confirmation gate).

The high-level design template requires nine sections for every design. It
requires intention, goals, non-goals, approach, key decisions, rejected
alternatives, risks, scope boundary, and open questions
(`docs/track-workflow.md`, § Lifecycle and phases). A minimal change can then
produce invented material to fill required sections.

One session provides a measured example. The request was to stop routing every
reviewer to the strongest candidate. The orchestrator proposed five goal
candidates for a request that needed one. The user removed one goal as
unnecessary. The first high-level design proposed a new canonical principle in
the routing document, one cross-reference, and a new escalation attachment.
It also listed seven key decisions and seven rejected alternatives. The user
rejected all of those additions.

The accepted change deletes two sentences from the review-rules document. The
sentences were, before this change: `Prefer the strongest available reviewer
model with measured support for the review effort.` and `Keep review and gate
actions on measured effort levels.` They appeared in `docs/review-rules.md`, §
Reviewer sets, merge rule and charters, near lines 60–66. The remaining text
then meets the request without new doctrine text.

## Candidate changes

These are candidate shapes, not decisions for this issue:

- Extend P11 so a rule that adds doctrine text must name the condition that
  makes the text necessary.
- Add one item to the confirmation gate. The item would require the proposal
  to state the smallest change that meets the request, including deletion.
- Permit a reduced high-level design shape when a change only deletes text.

A future implementation must choose one shape or define a different one. It
must preserve the existing gates and the user's ability to approve a larger
change when the evidence supports it.

## Open questions for a future implementer

- Which document owns the doctrine-minimality rule?
- Could a minimality requirement under-design a genuinely complex change?
- How can the workflow require consideration of deletion without forcing an
  invented alternative?
- Does the nine-section design template need a short form? Which sections
  would the short form keep?
- Can an automated check observe this property? The doctrine size checks
  measure rendered prompt bytes, not document text.

## Why this was deferred

The user asked to keep the current change minimal. The current change deletes
the reviewer-model default sentence and relies on existing routing doctrine.
The deferring change is the **reviewer-model-default deletion**. Its decision
is **reviewer-model-default deletion decision D1**. This decision id is scoped
to that change, as required by `issues/README.md`.

The gap concerns the workflow itself. It needs its own size grade, design, and
approval. Adding that policy to the current deletion would expand the change
that the user explicitly kept small. This issue records the follow-up instead.
