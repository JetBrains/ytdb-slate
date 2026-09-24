# Roadmap

This document describes planned work, not current Slate features.

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

Planned recursive decomposition will split large, long-running changes into smaller parts that can themselves be split when needed ([#361](https://github.com/JetBrains/ytdb-slate/issues/361)).

## Developer experience

Planned asynchronous threads will let the main session continue while worker sessions run. Clear, accurate usage and cost reports will give a detailed breakdown of where resources go. A read-only view will show the order of actions in a worker thread without changing its execution. A redesigned terminal interface will let you follow and control running worker threads.

## Remote development

Planned integration with pi-agent-dashboard will let a desktop or laptop serve as a remote development workstation ([#417](https://github.com/JetBrains/ytdb-slate/issues/417)).
