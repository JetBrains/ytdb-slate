# Roadmap

This document separates current larger-change guidance from planned work.

## Design that readers can verify

The goal is to let you guide a change through its design without reading the code. Planned design documents will state exact guarantees and explain why the design keeps them. Design documents will cover several levels, from system goals to component details. They will stay updated while work continues. The [focus-area definitions](blast-radius.md#focus-areas-and-their-gates) name risks that can trigger a design. Those five areas are data loss, concurrency defect, security weakness, performance degradation, and non-local logic defect. A focus area is a named risk that adds a review gate after you approve its proof.

A verifiable design guarantee will have six parts:

1. **Exact result.** State a claim a reader can test. “Reads are consistent” is too broad. “All values returned by one logical read belong to the same committed state” names an exact result.
2. **Boundary.** Define one operation and the state it covers. State which failures and overlapping operations the claim permits. Name the guarantees supplied by dependencies. For a read guarantee, define one logical read and the committed state it covers.
3. **Mechanism.** Explain who owns state, how state changes, and in what order operations happen. The design does not need function names or source file paths.
4. **Argument for difficult cases.** Show why overlapping operations, failures, and retries cannot produce a result that the claim forbids. One successful example does not establish the claim.
5. **Suitable evidence.** Use a short logical argument for a simple rule. Use an abstract model check for a complex protocol. For a performance claim, measure a stated workload.
6. **Limits and open questions.** Separate established facts from assumptions and planned checks. Do not present an unresolved assumption as a proved guarantee.

The design will match the proved focus areas. A **non-local logic defect** is a wrong or missing result caused by a relation that two or more places must keep. A reader cannot settle the relation by checking each changed place alone. This definition is more precise than a general judgment that code is complex. [Issue #402](https://github.com/JetBrains/ytdb-slate/issues/402) tracks design work for that area.

Code reviewers will check for established code practices and avoid patterns that cause defects ([#403](https://github.com/JetBrains/ytdb-slate/issues/403)). They will report differences between the approved design and the implementation to the user ([#404](https://github.com/JetBrains/ytdb-slate/issues/404)).

## Larger changes

The current workflow supports nested planning through design tracks.
A **design track** plans a nested change with child tracks.
A **code track** implements bounded approved work.
A **level** contains sibling tracks created by one split.
Each level with code tracks has one optional draft pull request.
A **subtree** contains a track and its descendants.

Tracks finish in dependency order.
Design tracks finish first only when tracks do not depend on each other.
Complete an entered subtree before continuing its siblings, except for a permitted dependency pause.
A subtree may pause for an unfinished sibling dependency only when none of its open level slices has commits.
Otherwise change the split before the subtree's first commit.
A late dependency discovery after commits exist stops work for a user-approved replan.

Each design track needs explicit acceptance of its whole subtree.
Root final acceptance covers the whole change.
Only the user merges pull requests.
A **review-fix child track** repairs outstanding work under a user-approved split.
It stays in the affected code track's delivery.
Each new child starts at round zero with two ordinary rounds and one stuck-fix consultation.
Use [recursive-workflow.md](recursive-workflow.md) for the nested rules.
Use [track-workflow.md](track-workflow.md) for the common lifecycle.

## Developer experience

Planned asynchronous threads will let the main session continue while worker sessions run. Clear, accurate usage and cost reports will give a detailed breakdown of where resources go. A read-only view will show the order of actions in a worker thread without changing its execution. A redesigned terminal interface will let you follow and control running worker threads.

## Remote development

Planned integration with pi-agent-dashboard will let a desktop or laptop serve as a remote development workstation ([#417](https://github.com/JetBrains/ytdb-slate/issues/417)).
