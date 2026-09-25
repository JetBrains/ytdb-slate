## Common review policy

Review the assigned work without editing the reviewed artifacts. Apply your charter only within its assigned scope. Use the generic reviewer evidence standards supplied with this review.

Before applying your specific charter, run the writing checker on the unified review diff. Write that diff to a regular temporary file outside the checkout. This temporary evidence file is permitted by the read-only review rule.

```bash
node <installed-writing-checker> --diff <regular-temp-diff> --format text
```

Read the installed writing guidance at `<installed-writing-guidance>` for scope and limits. Apply the reviewed project's writing scope before grading checker output. A clean result cannot establish accuracy, completeness, or conformance.

The checker is diagnostic. In governed prose, a `fail` is normally major. No current rule emits a `warning`. A `warning` is at most minor without independent evidence. A `house-style` match is at most minor when the convention applies. An `advisory` is never a finding by itself. Independent evidence may justify another severity. Reviewer judgment remains authoritative.

Write full evidence for every finding. Record its type as defect, evidence gap, regression, or improvement. Record the reviewer perspective and stable finding identifier as its origin. Record severity as blocker, major, or minor. Record exposure as in-target, pre-existing, or outside-target.

Owner triage and disposition belong in the review evidence and orchestrator records when assigned. Owner triage is accept, amend, merge, dispute, or escalate. Disposition is fix, waive, moot, reject, or ignored. The orchestrator validates severity and exposure and owns final triage. A reviewer does not claim that authority.

Grade severity against the stated target:

- **blocker:** safe or correct delivery cannot proceed.
- **major:** the target or required evidence is materially incomplete.
- **minor:** a bounded defect does not defeat the target.

Use the stable prefix assigned to your perspective. In a merged specialist review, each finding keeps the prefix of its owning perspective. Identifiers remain cumulative and never renumber. Historical identifiers keep their recorded meaning. Project-supplied prefixes must not collide. The orchestrator assigns and records a replacement when they do.

End every finding with one compact row containing exactly five fields:

`ID | severity | location | one-line summary | counterexample gist`

The location contains a file and a line or line range. It contains no pipe character. Do not add a sixth field. Type, exposure, owner triage, disposition, and any stage-specific level belong outside the compact row.

A review with no findings ends with the exact standalone line `No findings.`. Any required role-specific sections appear before that line.
