# Blast radius, size and review coverage

This document defines the measured size axis and the judged focus axis. It
also defines decomposition constraints, review coverage, drift control and
commit discipline that depends on drift. [track-workflow.md](track-workflow.md)
is the lifecycle spine. [review-rules.md](review-rules.md) defines reviewer
composition and finding handling.

## Two independent axes

**Size is predicted, then measured.** Before a committed diff exists, the
orchestrator predicts changed production-logic lines, files touched and the
initial grade. The prediction states its basis and uncertainty. The script
verifies the real committed range at the first track boundary. It never claims
to measure absent work.

**Focus is planned and proved.** The orchestrator judges engagement for the
whole planned track. It records all eleven areas and gives a concrete proof for
each named area. The user approves this risk record. Before review, the
orchestrator compares the proved set with the committed difference. No script
or rule decides whether a proof holds.

The axes never substitute for each other. Size carries no risk meaning. A
focus area never changes a measured count.

Resolve size uncertainty by taking the higher grade. The user may confirm a
lower grade only before implementation starts. The confirmation record states
the reason.

The grade may not shrink after implementation starts. The committed-difference
comparison may add a proved area with its reviewer. It may drop a proved area
that no longer engages.

## Size measurement and the exclusion list

Run the shipped size command against the two refs that bound the change:

```bash
node <package>/extension/size-grade.mjs --base <ref> --head <ref>
```

`<package>` is the absolute package root that contains this document. Slate
exports that command path as `SIZE_GRADE_SCRIPT`. Run it from any working
directory inside the target Git repository. The command resolves the project
root for `.pi/size-grade.json`. Both refs are required.

The default format is JSON. `--format json` selects it explicitly. The result
object has these fields:

| field | type and meaning |
| --- | --- |
| `base` | string containing the supplied base ref |
| `head` | string containing the supplied head ref |
| `changedProductionLogicLines` | number of added plus deleted source lines |
| `changedFiles` | number of numstat records |
| `sizeGrade` | `SMALL`, `MEDIUM` or `LARGE` |
| `files` | array containing one object per numstat record |

Every object in `files` has these fields:

| field | type and meaning |
| --- | --- |
| `path` | string containing the path from numstat |
| `added` | number of added lines, or zero for a binary record |
| `deleted` | number of deleted lines, or zero for a binary record |
| `changedLines` | number equal to `added + deleted` |
| `binary` | boolean that identifies a binary numstat record |
| `kind` | `generated`, `test`, `documentation`, `build`, `configuration`, `source` or `other` |
| `excluded` | boolean that is true unless `kind` is `source` |
| `reason` | string containing the classifier's reason |

`--format text` prints three summary lines for grade, production-logic lines
and changed files. It then prints one line per record. Each record line states
`INCLUDED` or `EXCLUDED`, the sanitized path, the classifier reason and the
changed-line count.

Success and `--help` exit with status 0. An argument, configuration, Git or
input-limit error exits with status 1 and writes a `size-grade:` diagnostic to
standard error. Git output and `.pi/size-grade.json` are each limited to
1,048,576 bytes.

During initial assessment, predict both counts and state the evidence. A
committed candidate may inform that prediction but never mechanically sets it.
Run the command on the real committed range at the first track boundary. That
mandatory boundary run verifies the prediction against implemented work.

### Canonical counting and exclusion rules

This section is the only normative statement of the counting and exclusion
rules. Other documents must point here instead of restating them.

The command uses `git diff --no-renames --numstat`. It adds each source file's
added-line count and deleted-line count. Only files classified as `source`
contribute to the production-logic line total. The excluded kinds are `test`,
`generated`, `documentation`, `build`, `configuration` and `other`.

The shipped command is the authority for the exact extension, filename and
directory tables used by classification. This document does not duplicate
those tables. The classifier applies this order and stops at the first match:

1. generated, including configured generated markers and lockfile names.
2. test.
3. documentation.
4. build.
5. configuration.
6. source.
7. other.

Every numstat record counts as one changed file, including an excluded file, a
binary file and a file with no changed lines. Binary and zero-line records add
zero lines. Exclusion affects only the production-logic line total.

Rename detection is off. A rename therefore appears as one deletion record
and one addition record. It counts as two changed files, and its added and
deleted lines contribute when the paths classify as source. This rule matches
the corpus that produced the thresholds, which hold only when the live count
uses the corpus method.

A large mechanical rename can therefore reach a higher grade than its risk
deserves. [Two independent axes](#two-independent-axes) lets the user confirm a
lower grade before implementation starts. The confirmation record states the
reason.

### Project classification overrides

The command optionally reads `.pi/size-grade.json` from the project root. A
missing file uses all built-in defaults. The file accepts only these keys:

- `testPaths`: case-insensitive regular-expression strings for test paths.
- `generatedMarkers`: case-insensitive regular-expression strings for
  generated paths.
- `lockfiles`: case-insensitive lockfile names.

A missing key uses that key's built-in default. A present key replaces its
default with an array of non-empty strings. The built-in defaults are:

```json
{
  "testPaths": [
    "(^|/)(test|tests|testing|test-commons|docker-tests)/",
    "(^|/)(?:[^/]*[-_.])?(test|tests|spec)([-_.]|$)",
    "(^|/)[^/]*(test|tests|spec)\\.[^.]+$"
  ],
  "generatedMarkers": [
    "(^|/)(target|build|dist|generated|coverage|node_modules|vendor)/",
    "\\.min\\.(js|css)$"
  ],
  "lockfiles": [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml"
  ]
}
```

### Size grades

Apply these line-count bands first:

| size grade | changed production-logic lines |
| --- | ---: |
| SMALL | 0–50 |
| MEDIUM | 51–1,000 |
| LARGE | more than 1,000 |

A files-touched count above 25 then raises the grade by one step. The raise is
mandatory. SMALL becomes MEDIUM, and MEDIUM becomes LARGE. LARGE remains
LARGE. No count lowers a grade.

## Track function and track constraints

The track function returns a floor, not an exact track count. For `F` files
touched and `L` changed production-logic lines, calculate:

```text
file-derived count = ceil((F - 5) / 20)
line-derived count = ceil(L / 1000)
track floor = max(1, file-derived count, line-derived count)
```

The orchestrator may create more tracks than the floor for atomicity or
coherence. It records the reason. The orchestrator owns the split.

A track may not exceed 1,000 changed production-logic lines. Atomicity is the
only exception. A range that must land whole because several surfaces must
agree at one boundary may exceed the maximum. Measure the real range and
record both the overrun and the reason. Reject a split that would leave an
inconsistent intermediate state.

When the track floor exceeds twelve, stop and present the split plan to the
user. The user chooses whether and how the change proceeds. Twelve is an
escalation threshold, not a hard track cap.

## Focus areas and their gates

A focus area is one named risk. An area adds its reviewer only when the track
record contains a judged proof that holds.

<!-- focus-area-table:begin -->
| # | focus area | the gate it adds | where the gate runs |
| --- | --- | --- | --- |
| 1 | concurrency defect | one area reviewer for concurrency | every track that proves the area |
| 2 | data loss | one area reviewer for data loss and recovery | every track that proves the area |
| 3 | security weakness | one area reviewer for security | every track that proves the area |
| 4 | performance degradation | one area reviewer for performance | every track that proves the area |
| 5 | test-quality defect | one test-quality and structure reviewer | every track that proves the area |
| 6 | unreadable user-facing prose | one prose reviewer | every track that proves the area |
| 7 | licensing exposure | one licensing reviewer | every track that proves the area |
| 8 | non-local logic defect | one area reviewer for non-local logic defects | every track that proves the area |
| 9 | consumer contract break | one area reviewer for consumer contract breaks | every track that proves the area |
| 10 | governing-rule defect | one area reviewer for governing-rule defects | every track that proves the area |
| 11 | unreported failure | one area reviewer for unreported failures | every track that proves the area |
<!-- focus-area-table:end -->

The marked table is the canonical copy of the duplicated eleven-area table. Its
second copy is in [track-workflow.md](track-workflow.md). The two marked blocks
must remain equal.

Duplicated doctrine blocks follow the reviewer-charter marker convention. An
HTML begin comment immediately precedes each block. Its matching end comment
immediately follows it. This table uses the block name `focus-area-table` in
both documents.

### Concurrency defect

**Outcome:** a result that the specification forbids, or a stop of required
progress, produced by an allowed overlap or order of two or more executions.
**Trigger:** the area engages when the change can cause that outcome. A change
does not engage the area only because it runs inside a concurrent program.
Slower execution that still makes progress belongs to performance degradation.

### Data loss

**Outcome:** data that the project keeps for a user, a consumer or a later
session, and that cannot be recovered, or recovered data that differs from the
state the project kept. **Trigger:** the area engages when the change can cause
that outcome. Loss that the published contract permits does not engage the
area. A change that widens the permitted loss does engage it. Data that the
project may rebuild or discard without a consumer noticing does not engage the
area.

### Security weakness

**Outcome:** a condition that an actor can exploit or trigger to break
confidentiality, integrity, availability, authentication, authorization or
accountability for the project or its consumers. **Trigger:** the area engages
when the change can introduce or expose that condition and a credible actor can
reach it. Exploitation need not happen. A change to a control whose purpose is
to protect one of those six properties engages the area, whether or not an
actor can reach the condition today. A configuration key engages the area only
when the key controls the run-time security posture of a consumer of the
published package.

### Performance degradation

**Outcome:** latency, throughput or resource use that misses a stated
requirement, or a growth of work with input size or data size that moves to a
worse class than the current code has. **Trigger:** the area engages when the
change can cause that outcome. A stated requirement is a limit that project
rules, the approved design, a benchmark threshold, a timeout, a budget or a
pinned size figure states for the touched path. It includes a path that project
rules mark as hot or as running on every turn. A change that alters no work per
unit of input engages the area on such a path only through a stated size budget.

### Test-quality defect

<!-- test-quality-definition:begin -->
**Outcome:** a project test or check that gives an unreliable signal, or that
fails to detect a fault inside the behaviour it claims to protect. **Trigger:**
the area engages when the change can cause that outcome. A changed coverage
number or coverage denominator alone is not engagement. A product artifact
does not engage the area only because a test calls it.
<!-- test-quality-definition:end -->

### Unreadable user-facing prose

**Outcome:** text that leaves its intended reader unable to make the decision
or complete the task that the text supports, where that text is readable by a
consumer of the published package or governed by the project writing
convention. **Trigger:** the area engages when the change can cause that
outcome. A short internal comment, a test name, a mechanical label, and text
that the project excludes from its writing convention do not engage the area.
A readability score alone neither engages nor clears the area.

### Licensing exposure

**Outcome:** published material that the project has no permission to publish
under its own licence. **Trigger:** the area engages when the change can cause
that outcome through copied or adapted material from an identifiable external
work, a dependency or notice, or a trademark. Copying or adapting such
external material always engages the area. A dependency with a clear
permission basis and satisfied conditions does not engage the area. Material
that an author or a worker wrote for this project without an external source
does not engage the area. Unknown provenance alone does not engage it.

### Non-local logic defect

**Outcome:** a result that the specification forbids, or a required result that
never appears, because two or more places do not satisfy one shared relation. A
place is one application of that relation: a rule check, state transition,
condition interpretation, or representation read or write. The application and
the facts it holds define its boundary. A fact held by another application stays
outside that boundary, even when the first application reads or needs that fact.
Reading an external fact does not make the consuming application independently
checkable.

Moving equivalent applications next to each other, into one module,
or into separate files does not merge or split them. The reviewed change is a
separate boundary. Omitting a required matching edit from that change can alter
the area decision. An agreement is the shared relation that each place must
preserve. **Trigger:** the area engages when the change can cause
that outcome. The reader must be unable to
settle whether the relation remains satisfied by reading each changed place on
its own. The evidence for that risk must include at least one of these four
kinds:

1. A rule that two or more places must apply in the same way.
2. A state or a history that an earlier execution left behind.
3. Two or more conditions that must hold at the same time, where at least one
   condition takes its value or its meaning from a place the change does not
   show.
4. A matching edit that is required in a place the change does not touch.

One added condition whose two outcomes a reader checks separately leaves every
place independent and does not engage the area. Two conditions joined in one
expression do not engage the area when the same place shows the value and the
meaning of each condition. The number of branches, the number of changed lines,
the number of changed files and any complexity score neither engage nor clear
the area. A repeated edit that keeps behaviour the same does not engage the
area when every edited site appears in the change and a reader checks one site
at a time. A change confined to text that no execution reads does not engage
the area. Evidence that one lookup settles does not engage the area, because
the area needs two or more facts that a reader must compare.

A persisted-state write and its later read are separate applications in every
layout. A co-located representation write and read are also separate when both
must preserve one relation. An enforced constraint and a published copy held by
another application remain separate, even when one reads the other. A local
guard remains one independent application when it shows its value, meaning and
both outcomes. A complete mechanical rename remains excluded when every site is
shown and can be checked alone. An incomplete rename can engage when the missing
site owes a matching edit.

A proof for this area keeps the standard three parts. The defect class is the
shared relation that can fail. The standard place field lists the changed place
and every other place that must satisfy that relation. The consequence is the
forbidden or missing result.

- **Concurrency defect.** An unsatisfied agreement that appears only because two
  or more executions may overlap or may run in another order belongs to
  concurrency defect. Non-local logic defect covers an unsatisfied agreement
  inside one execution. Both areas engage only when the change can leave that
  agreement unsatisfied and the overlap or order can independently produce the
  concurrency outcome.
- **Data loss.** A forbidden result that destroys kept data, or that returns
  kept data in a changed form, belongs to data loss. Non-local logic defect
  covers an unsatisfied agreement whose result may be wrong without any data
  being lost. Both areas engage only when the change can leave that agreement
  unsatisfied and can independently destroy or alter kept data.
- **Security weakness.** A condition that a credible actor can reach and
  exploit against confidentiality, integrity, availability, authentication,
  authorization or accountability belongs to security weakness. Non-local
  logic defect covers a wrong result that needs no actor. Both areas engage
  only when the non-local logic trigger holds and the security trigger also
  holds for a protective control or a condition a credible actor can reach.
- **Performance degradation.** A correct result that misses a stated latency,
  throughput, resource or growth requirement belongs to performance
  degradation. Non-local logic defect requires a wrong or an absent result.
  Both areas engage only when the change can leave an agreement unsatisfied and
  can independently miss the stated performance requirement or worsen the
  growth class.
- **Test-quality defect.** A check that gives an unreliable signal, or that
  cannot detect a fault inside the behaviour it claims to protect, belongs to
  test-quality defect. Non-local logic defect covers the product behaviour and
  never engages because a test is missing. Both areas engage only when the
  change can leave an agreement unsatisfied. The test-quality trigger must also
  hold because the change makes a check unreliable or unable to detect the
  fault it claims to protect against.
- **Unreadable user-facing prose.** Text that leaves its reader unable to decide
  or to act belongs to unreadable user-facing prose. Non-local logic defect
  covers behaviour that an execution produces. Both areas engage only when the
  change can leave an agreement unsatisfied and can independently leave the
  reader unable to decide or act.
- **Licensing exposure.** Published material that the project has no permission
  to publish belongs to licensing exposure. Non-local logic defect never
  engages because material came from outside. Both areas engage only when the
  change can leave an agreement unsatisfied and also copies or adapts material
  from an identifiable external work.

### Consumer contract break


A consumer contract break changes a surface that an unchanged consumer reaches.

1. Does the change alter a consumer-reachable surface?
2. Would a consumer that does not change, using that surface in a way the review base permits, get a different result, a different exit status, a different output shape, an error, or data that it cannot read in the candidate?
3. Does the change show no route that keeps the base use working?
4. Does the change publish a new consumer-reachable surface without stating which parts of it a consumer may rely on?

The first three answers must all be yes, or the fourth answer can be yes on its own. The review base is the base endpoint of the declared review range. The candidate is the candidate endpoint of that range. Compare those two snapshots, including unreleased code. A version number, release label, changelog or publication state does not override the declared endpoints. A consumer-reachable surface is a name that a published entry point exports, an argument or option of a shipped command, an exit status of a shipped command, the machine-readable output of a shipped command, a configuration key together with the value used when it is absent, a record or file that the project writes and later reads, or a shipped statement about what the project accepts or produces. An internal name, a moved file or a helper that no published entry point exposes does not trigger the area. An addition that leaves every permitted base use unchanged does not trigger it. Human-readable wording, layout and log text do not trigger it. A file that the project may discard or rebuild without a consumer noticing does not trigger it. Version numbers, release labels, changelogs and counts neither trigger nor clear it. A defect correction triggers it when an unchanged consumer's result changes, even when the base result contradicted the published document. A surface introduced in the candidate, which no consumer can reach from the review base, triggers it only through the fourth question.

A proof for this area keeps the standard three parts. The defect class is the kind of break: a withdrawn name, a changed default, a changed exit status, a changed output shape, a narrowed input, or a format that the base reader cannot read in the candidate. The place names the consumer-reachable surface and the compared revisions in the declared review range, together with the concrete export, option, key, exit status or record. The consequence is what the unchanged consumer experiences in the candidate: a failed run, a silently different result, or data that it can no longer read.

#### Boundaries

Each pairing below engages both areas only when each area independently meets its own trigger.

- **Concurrency defect.** A forbidden result that appears only because two or more executions may overlap or may run in another order belongs to concurrency defect. Consumer contract break covers a result that changes for an unchanged consumer in a single ordinary execution. Both areas engage when the change alters a consumer-reachable surface and also allows a new overlap.
- **Data loss.** Kept data that cannot be recovered, or that comes back different, belongs to data loss. Consumer contract break covers a format, a default or a name that an outside party can no longer use as before, even when every byte survives. Both areas engage when a format change both withdraws the old reader and destroys the only copy.
- **Security weakness.** A condition that a credible actor can reach and exploit against confidentiality, integrity, availability, authentication, authorization or accountability belongs to security weakness. Consumer contract break needs no actor and no exploit, only an unchanged consumer. Both areas engage when the changed default or key controls the run-time security posture of a consumer.
- **Performance degradation.** A correct result that misses a stated latency, throughput, resource or growth requirement belongs to performance degradation. Consumer contract break needs a different result, a different status, a different shape or unreadable data, and speed alone never engages it. Both areas engage when a changed default also moves the work per unit of input on a path with a stated requirement.
- **Test-quality defect.** A check that gives an unreliable signal, or that cannot detect a fault inside the behaviour it claims to protect, belongs to test-quality defect. Consumer contract break covers only surfaces that a consumer reaches, and test material is not one of them. Both areas engage when the change alters a shipped command that a consumer runs and also alters the check that would catch the break.
- **Unreadable user-facing prose.** Text that leaves its reader unable to decide or to act belongs to unreadable user-facing prose. Consumer contract break covers a shipped document only when the document states what the project accepts or produces, and it never engages on wording, layout or log text. Both areas engage when the change alters an accepted input and also rewrites the sentence that states it.
- **Licensing exposure.** Published material that the project has no permission to publish belongs to licensing exposure. Consumer contract break never engages because material came from outside. Both areas engage when adapted external material arrives together with a changed consumer-reachable surface.
- **Non-local logic defect.** A wrong or missing result that follows from a broken agreement between two or more places inside the system belongs to non-local logic defect. Consumer contract break covers a result that a party outside the change observes as different, and it engages even when every place inside the change agrees. Both areas engage when a broken internal agreement is what produces the changed external result.

### Governing-rule defect


A governing-rule defect makes a rule for project work unusable or inconsistent.

1. Does another rule document, or another copy of the same rule, now state something different for one case?
2. Can a reader reach the end of the governed work without performing a required step and without recording a decision to skip it?
3. Does the rule now require a term, a threshold or a name that the change leaves undefined for the reader who must apply it?
4. Does an automated check, a gate or a script now permit work that the rule forbids, or forbid work that the rule permits?
5. Can a required step become unreachable, or run after the work is declared complete?

The change must add, alter or remove a rule for people or agents who produce, review, verify, publish or release work, or alter the machinery that enforces it. A product contract is outside this trigger. A change that only obeys an existing rule does not trigger the area. Counts and readability or coverage scores neither trigger nor clear it. A wording change that leaves every obligation the same does not trigger it. A record of a past rule that no reader must follow today does not trigger it.

A proof for this area keeps the standard three parts. The defect class is which of the five questions answers yes. The place is the changed rule together with the other rule, copy or enforcing check that must agree with it. The consequence is the work that then proceeds without its check, or the two conflicting ways in which two readers act.

---

#### Boundaries

Each pairing below engages both areas only when each area independently meets its own trigger.

- **Concurrency defect.** A forbidden result or a stop of progress that appears because two or more executions may overlap belongs to concurrency defect. Governing-rule defect covers a rule that people and agents follow, and it never engages because an interleaving exists. Both areas engage when a changed rule states how a program must serialise work and the change also alters that serialisation in code.
- **Data loss.** Unrecoverable or altered kept data belongs to data loss. Governing-rule defect covers work that proceeded without its check, even when no byte was lost. Both areas engage when the skipped step is the step that protects kept data.
- **Security weakness.** A condition that a credible actor can reach and exploit against one of the six named properties belongs to security weakness. Governing-rule defect needs no actor, because the harm is that the project itself does the work wrongly. Both areas engage when the weakened gate is a protective control, for example a rule that keeps a credential out of a child process.
- **Performance degradation.** Latency, throughput, resource use or growth that misses a stated requirement belongs to performance degradation. Governing-rule defect covers the rule that STATES such a requirement, and not the measured behaviour. Both areas engage when a change alters a size budget or a hot-path rule and also changes the work on that path.
- **Test-quality defect, sentence one.** A project test or check that gives an unreliable signal, or that fails to detect a fault inside the behaviour it claims to protect, belongs to test-quality defect, and that area judges the check against the PRODUCT behaviour under it. **Sentence two.** Governing-rule defect judges the same check against the RULE above it, so it engages when the check and the rule now permit different work, and when a required gate becomes passable with no decision, even though the check still detects every fault it ever detected. Both areas engage when one change edits a gate that both enforces a project rule and detects a product fault, and each reviewer then files a different finding about it.
- **Unreadable user-facing prose, sentence one.** Text that leaves its intended reader unable to make a decision or complete a task belongs to unreadable user-facing prose, and that area owns comprehension, audience, terminology, structure and the writing convention. **Sentence two.** Governing-rule defect covers a rule that a reader understands perfectly and still cannot apply, cannot satisfy, can satisfy in two conflicting ways, or can pass without a decision, so a rewording that changes only how easily a rule reads engages prose alone, while a rewording that changes what a reader must do engages this area. Both areas engage when a rule document is rewritten and its obligations change, and the prose code reviewer then judges the reading while this code reviewer judges the obligation.
- **Licensing exposure.** Published material that the project has no permission to publish belongs to licensing exposure. Governing-rule defect never engages because material came from outside. Both areas engage when a change adapts an external standard, a checklist or a policy template into a project rule.
- **Non-local logic defect.** A wrong or an absent result that no single changed place settles, because two or more places must agree, belongs to non-local logic defect, and its places are locations that an execution reads. Governing-rule defect covers a rule that a person or an agent must obey, and its consequence is work done wrongly rather than a wrong result. Both areas engage on a change that edits a rule, its duplicated copy and the check that pins the text.

### Unreported failure


An unreported failure leaves a product failure with no signal.

1. Does the change introduce, move or widen a place where the product can fail, refuse, drop, skip, partly complete or fall back?
2. Does the change leave at least one such failure with no signal that the change itself shows?

A signal is one observable event, for example a non-zero exit status, a message on the error stream, a rejected input with a stated reason, a failing check, a recorded event or an error handed to a caller. A dropped entry with no report, an error that is caught and discarded, a return status that no caller reads, a write that nothing verifies and a fallback that replaces a failure with a normal-looking result each trigger the area. A change that adds no new way to fail does not trigger it. A failure that reaches a reporter the change keeps and shows does not trigger it. A wrong value from an execution that met no failure does not trigger it. A change whose only affected artifact is a project test or check belongs to test-quality defect and does not trigger this area. A removed signal triggers the area unless the change shows that the failure it reported can no longer happen. Counts do not decide the result.

A proof for this area keeps the standard three parts. The defect class is the failure mode that carries no signal. The place is the failure site together with the boundary that owes the report. The consequence is what proceeds, spreads or completes as an apparent success while the failure stays unknown.

#### Boundaries

Areas may engage together when each area meets its own trigger. The unreported failure reviewer judges whether a product failure has a signal. That reviewer does not judge the outcome owned by another area. A silently swallowed write failure that changes a shipped command's exit status can engage both unreported failure and consumer contract break when both triggers hold. Unreported failure never grades a project test, which belongs to test-quality defect. It never grades the wording of a message, which belongs to unreadable user-facing prose. A wrong value from an execution that met no failure does not engage unreported failure. It engages non-local logic defect only when that area's cross-application relation trigger holds. A purely local wrong value can therefore engage neither area.

### Judged proof and risk record

The orchestrator records one line for every area. A named line gives a concrete
three-part proof. The proof states the defect class, the place in the planned
change where it can occur, and the consequence. A non-engagement line states
which part of the trigger answers no.

The proof basis is the approved track design. When the track has no design, the
basis is the track intention block and planned file list. The risk record is
orchestrator material, not high-level design. It may cite concrete paths,
symbols, and checks.

A proof must show a material consequence of omitting the area reviewer. A
consequence is material when a reasonable reviewer would file it at major
severity or above. Project tooling counts. A protective-control change is
material when loss of that control would be material. A cosmetic consequence
is not material. A proof is not convincing when its words would also fit a
change that does not engage the area.

No rule mechanically decides whether a proof holds. The adversarial design
review judges the whole record when that review runs. The user judges the whole
record at every confirmation gate. An area whose proof convinces neither reader
is skipped. A skipped area gets no reviewer. The skip is recorded and is not an
escalation. A track with no proved area still gets Reviewer I and every gate its
grade requires.

Reviewer composition and merging belong to
[review-rules.md](review-rules.md) § Reviewer sets, merge rule and charters.

## Optional path declarations

A project may declare paths for a focus area as prose in its contributor guide.
No configuration key or parser is required. A declaration is optional evidence
for the risk record.

1. A touched declared path is evidence that its area may engage.
2. A change outside all declared paths still receives orchestrator judgement.
3. A declaration may support a proof or a non-engagement line.
4. A narrow or stale declaration does not decide engagement or proof.

A path is evidence, not a definition or a decision.

## Lifecycle rules owned by the spine

[track-workflow.md](track-workflow.md) § Risk planning and reconciliation owns
planning, approval, and the committed-difference comparison. Its § Fast path owns fast
path eligibility, the omitted gates, retained sequence, mechanical checklist,
every voiding condition and the verification-machinery exclusion. This document
does not duplicate those rules.

[review-rules.md](review-rules.md) § Reviewer sets, merge rule and charters owns
Reviewer I and all area-reviewer composition.

## Halt, re-derivation and grade correction

An implementer halts for an unplanned sensitive configuration change, before
weakening a test, or before materially deviating from the approved design. The
halt occurs before further work builds on the new fact.

On a halt, the orchestrator:

1. pauses implementation.
2. re-runs the size command and re-derives the grade upward only.
3. returns to the user confirmation gate when the grade rose.
4. resumes only after the blocking re-confirmation passes.

A first-boundary measurement above the confirmed band fires this halt
immediately. Present the measured counts at re-confirmation. A measurement
below the confirmed band does not lower the grade. The route for confirming a
lower grade closes when implementation starts.

A halt may never lower the grade after implementation has started.

## Review coverage and the coverage register

Every part of a track range must reach Reviewer I and the perspectives that the
proved areas of that track require. User review never replaces machine review.
This requirement is the coverage invariant.

Create a coverage register when a user-review fix commit exists. Record each
contiguous user-review fix range and its gate verdict. The register remains the
review-accounting authority for those ranges. The track table remains a
display-only split index and carries no commit identifier.

At delivery, a live register produces the one-line coverage conclusion required
by [track-workflow.md](track-workflow.md). The detailed register stays in the
research log.

## Commit discipline for drift and boundaries

[track-workflow.md](track-workflow.md) owns marker commits, track-title
prefixes and the source of truth for track boundaries. This section owns the
remaining commit discipline.

The cumulative implementation commit is defined in
[track-workflow.md](track-workflow.md) § Lifecycle and phases. When the track
has a high-level design, the cumulative implementation commit body carries the
track high-level design followed by the track low-level design. When the track
has no high-level design, the ordinary two-part Intent and Deviation-delta shape
applies. This conditional body rule is also stated in
[track-workflow.md](track-workflow.md) § Delivery and termination.

The original implementation commit, each agentic-review fix commit, and each
user-review fix commit body has exactly two parts:

1. **Intent:** what the commit accomplishes, not how it accomplishes it.
2. **Deviation delta:** only what differs from the original track task. Leave
   this part empty when nothing differs.

The deviation delta may contain only a deviation already sanctioned by a halt
and re-confirmation, a design-delta approval, or an immaterial design change.
A material deviation discovered at commit time fires a halt. The commit body
must never become a side channel for unapproved drift.

In those two-part bodies, do not put implementation rationale, self-assessment
or verification claims. Examples of forbidden claims include
`tested`, `verified thread-safe` and `reviewed edge cases`. Fresh reviewers
receive repository state and declared intent, not implementer confidence.

For a multi-track change, every commit in a track's review range must belong to
that track. A reviewer checks the range against the track brief, its boundary
markers and its title prefixes. A commit from another track is cross-track
contamination. Correct a wrong boundary or title before the next writer
starts. An undeclared material deviation found during this check fires the
halt and re-derivation route above.
