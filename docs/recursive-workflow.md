# Recursive workflow

A recursive workflow plans a large change as nested bounded work.
Use [track-workflow.md](track-workflow.md) for the common lifecycle.
This document owns the relations between nested tracks.

## Terms and scope

A **track** is a bounded unit of work within a change.
A **change tree** records tracks and their parent-child relationships.
The **change root** represents the whole user request.
A **design track** plans and completes a nested change.
A **code track** implements a bounded part of approved work.
A code track can change documents rather than executable code.
A **child track** belongs directly to the node that planned it.
**Sibling tracks** have the same parent.
A **split** creates the direct child tracks of one parent.
A **level** contains the sibling tracks created by one split.
A level does not mean every track at the same depth.
A **level pull request** contains the code tracks of one level.
A **subtree** contains a node and its descendant tracks.
A **leaf** has no ordinary child tracks.
Only code tracks are ordinary leaves.
An **inner node** has child tracks.
The change root and design tracks are ordinary inner nodes.
A code track becomes an inner node when review fixes create child tracks.
A **review-fix child track** repairs outstanding work under a user-approved split.
A **path number** identifies a track through its numbered ancestors.

A **high-level design** states what must be true and why.
A **low-level design** states how the implementation achieves it.
A **focus area** is a risk-defined concern that can require a workflow gate.
A **risk record** assesses all eleven focus areas for a change or track.
A **proved area** has a proof approved by the user.
A **DESIGN-TRIGGERING area** is a proved area that requires the design sequence.
The focus definitions and classes remain in
[blast-radius.md](blast-radius.md) and [track-workflow.md](track-workflow.md).

A **research log** retains decisions, evidence, questions, and workflow state.
An **implementer report** records a code track's design, implementation, and checks.
A **status file** displays the tree and current work.
A **marker commit** is an empty commit that records a completed track boundary.
A **track package** presents a track's result and acceptance evidence.
A **review intention** states the scope and purpose of a review.

The recursive workflow is a rule for the orchestrator and its workers.
It is not an extension-managed tree controller.
Slate does not expand tracks, schedule subtrees, or maintain manual tree records.
The extension's session ownership rules still select the current change folder.
A nested plan does not create a new saved-session format or configuration key.

## Loading and planning

[track-workflow.md](track-workflow.md) § Recursive planning and loading owns the
loading condition, direct-child limit, and implementer-requested split exception.
Apply its split rule to the change root and each expanded design track.
The loading summary follows that section:

Load [recursive-workflow.md](recursive-workflow.md) when the current or proposed
plan contains a design track or review-fix child track.
Check the loading condition during planning and again during resume reconciliation.
Load the document before proposing a review-fix split.
Load it before planning or execution relies on a recursive rule.
A lazy plan needs no total descendant count to apply the condition.
A small tree with a design track still loads the document.
A change with neither triggering track type does not load it.

Use [track-workflow.md](track-workflow.md) § Confirmation gate for split approvals.
Use its § Track intention block and implementer response for each child's scope.

```text
Change root
  Design track: bounded nested change, expanded when entered
    Code track: one coherent implementation and review unit
    Code track: another coherent implementation and review unit
  Code track: bounded work in the root's level
```

Each indentation identifies a parent-child relation.
The two children of the design track form one level.
The design track and the root's code track form another level.
The diagram describes planning structure rather than commit ranges or merge order.
Those relations have their own sections below.

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

Start from the initial request and the approved parent scope.
Explain how each child contributes to the approved result.
The parent design supplies context rather than automatic child approval.

Use [track-workflow.md](track-workflow.md) § Lifecycle and phases for design content
and the ordered validation, review, and approval sequence.
Use its § Risk planning and reconciliation for each child's independent risk record.
Use its § Review coverage for implementation-review duties.
Use its § Delivery and termination for acceptance duties.
[review-rules.md](review-rules.md) § Reviewer sets, merge rule and charters owns
reviewer composition.

## Code-track sizing and split requests

Use [track-workflow.md](track-workflow.md) § Track size and split for sizing,
counted-line exclusions, estimates, overrun reports, and stopping duties.
Use its § Recursive planning and loading for the implementer-requested split exception.

## Level consistency

Use [track-workflow.md](track-workflow.md) § Track size and split for the level
boundary, child checks, and remaining-difference accounting.
[blast-radius.md](blast-radius.md) § Focus states and track constraints states the same level rule.

## Proportional process

Use principle P11 in [design-principles.md](design-principles.md) § 4. Operating
principles for proportional-process limits.
The conditional-record summary agrees with
[track-workflow.md](track-workflow.md) § Recursive planning and loading:

The approved plan supplies specific evidence for proportional process.
A design track or review-fix child track triggers the manual status file.
Entering a design track triggers its research log and nested gates.
An ordinary code track or a high-level design alone triggers neither extra record.
These conditions add no unconditional-artifact exception.
Questions follow unresolved decisions rather than record or track counts.

Use [track-workflow.md](track-workflow.md) § Confirmation gate for user-decision reuse.
The record procedures belong in § Manual records and safe writes.
The handoff timing belongs in § Handoff boundaries.

## Recorded-workflow compatibility

Use [track-workflow.md](track-workflow.md) § Migration for recorded-workflow
compatibility, small changes, manual-record absence, and the publishing default.
Use its § Session handoff and the research log for saved-session ownership.

## Level publishing and retained history

## Identifiers, code ranges, and design markers

## Manual records and safe writes

## Resume and folder forks

## Handoff boundaries

## Review-fix subtrees and repair limits

## Whole-subtree acceptance

## Packages, attribution, and issues
