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

**Focus is judged.** The orchestrator decides which focus areas the change and
each track engage. No script decides focus.

The axes never substitute for each other. Size carries no risk meaning. A
focus area never changes a measured count.

Resolve uncertainty independently on each axis. An uncertain focus area counts
as engaged. An uncertain size grade takes the higher value. The user may
confirm a lower grade only before implementation starts. The confirmation
record states the reason.

Neither axis may shrink after implementation starts. A later event may add a
focus area or raise the grade. It may not remove an area from the change-level
set or lower the grade.

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

A focus area is one named area of risk that a change engages. A focus area
engaged anywhere belongs to the change-level set. A focus area engaged on one
track adds its reviewer to that track alone. An area that two tracks engage
together, and neither engages alone, reaches the closing review.

<!-- focus-area-table:begin -->
| # | focus area | the gate it adds | where the gate runs |
| --- | --- | --- | --- |
| 1 | concurrency | one area reviewer for concurrency | every track that engages the area |
| 2 | durability | one area reviewer for durability and recovery | every track that engages the area |
| 3 | security | one area reviewer for security | every track that engages the area |
| 4 | core behaviour or algorithms | one area reviewer for behavioural correctness | every track that engages the area |
| 5 | performance | one area reviewer for performance | every track that engages the area |
| 6 | design uncertainty | the change-level adversarial design review, and no track reviewer | once, at the design loop |
| 7 | public interface or contract | one contract reviewer | every track that engages the area |
| 8 | silent failure mode | one area reviewer that must state how each failure would be detected | every track that engages the area |
| 9 | project test artifact | one test-quality and structure reviewer | every track that engages the area |
| 10 | user-facing or licensing-adjacent prose | one prose and licensing reviewer | every track that engages the area |
<!-- focus-area-table:end -->

The marked table is the canonical copy of the duplicated ten-area table. Its
second copy is in [track-workflow.md](track-workflow.md). The two marked blocks
must remain equal.

Duplicated doctrine blocks follow the reviewer-charter marker convention. An
HTML begin comment immediately precedes each block. Its matching end comment
immediately follows it. This table uses the block name `focus-area-table` in
both documents.

### 1. Concurrency

Concurrency covers locks, atomics, shared mutable state, asynchronous
lifecycles and ordering guarantees. Any defect that requires reasoning about
thread or task interleavings engages this area.

### 2. Durability

Durability covers persistence formats, migrations, write-ahead and recovery
paths, and at-least-once or exactly-once semantics. It includes data that can
be lost, corrupted or irreversibly transformed. A lossy migration engages
this area even when nothing crashes and recovery works.

### 3. Security

Security covers authentication, authorization, cryptography, parsing of
untrusted input, sandbox or permission boundaries, and secrets handling. It
also covers user data that can be exposed.

Sensitive configuration engages security when the changed key controls a
consumer's run-time security posture. Decide sensitivity from what the key
controls at run time for a consumer of the published package. A key read only
by development tooling is not sensitive configuration.

### 4. Core behaviour or algorithms

Core behaviour or algorithms covers logic central to the product function
that has substantial invariants or state machines. Its frequency is not a
reason to disengage it.

### 5. Performance

Performance engages when any one of these signals exists:

1. The diff changes asymptotic complexity over an input-scaled or data-scaled
   collection.
2. The diff adds input-scaled or data-scaled input/output, allocation or
   synchronization inside a per-item path.
3. The diff changes caching, batching, pooling or eviction policy.
4. A touched symbol has an existing benchmark, performance assertion,
   hot-path annotation or profiling marker.
5. The approved design or project rules state a performance constraint on the
   touched code.

A general concern that a change might affect performance does not establish a
signal. When no repository artifact exists, the orchestrator still judges the
area from the design and diff.

### 6. Design uncertainty

Design uncertainty engages when the shape is unclear, several parts interact,
or a live design alternative exists. It adds the change-level adversarial
design review and no track reviewer.

### 7. Public interface or contract

This area covers an externally depended-on surface that changes the meaning of
a rule or contract. An internal method does not engage the area merely because
its language-level visibility is public. A typographical, formatting or
wording correction that changes no rule does not engage it.

The contract reviewer always runs on a track that engages this area. The area
also adds the change-level design adversary when the change removes or alters
an existing consumer-reachable rule. A purely additive interface change does
not add that adversary.

### 8. Silent failure mode

A silent failure mode is a failure that produces no signal by which a later
check or operator can detect it. Its reviewer must state how every in-scope
failure would be detected.

### 9. Project test artifact

A project test artifact is an artifact whose purpose is to exercise, configure,
feed, isolate, or assert project behavior under a project test or check. The
area includes test logic, assertions, fixtures, snapshots, golden data, mocks,
stubs, harnesses, test-specific configuration, and test support.

Decide purpose from content, imports, callers, project test commands, and
optional declarations. Filenames and directories are evidence, not
definitions. Uncertainty engages area 9.

For a dual-purpose artifact, inspect the changed responsibility. A product
artifact does not engage area 9 merely because tests call it. Engage area 9
when the changed responsibility serves test execution, isolation, inputs, or
evidence.

Area 9 always adds one `test-quality and structure reviewer` at every size
grade. No tests-alone or weakening condition limits this rule. Reviewer
composition belongs to [review-rules.md](review-rules.md) § Reviewer sets,
merge rule and charters.

### 10. User-facing or licensing-adjacent prose

This area covers text that a consumer of the package can read. It includes
user documentation, command help, release notes, prompt strings and
public-facing messages. It adds a prose and licensing reviewer whose first
charter item is licensing and provenance exposure.

A short internal comment, a test name or a mechanical label does not engage
this area.

Reviewer composition and merging belong to
[review-rules.md](review-rules.md), in § Reviewer sets, merge rule and
charters. This document does not duplicate those rules.

## Optional path declarations

A project may declare paths for a focus area as prose in its contributor
guide. No configuration key or parser is required. A declaration is optional
and add-only.

1. Touching a declared path engages that focus area for certain.
2. A change outside all declared paths still receives orchestrator judgement.
3. A declaration may add a focus area and may never remove one.
4. A narrow or stale declaration may never switch a gate off.

A path is evidence, not a definition. Paths cannot decide core behaviour or
algorithms, design uncertainty, or a silent failure mode.

## Lifecycle rules owned by the spine

[track-workflow.md](track-workflow.md) § Focus touchpoints owns prediction,
declaration, confirmation and the reviewer backstop. Its § Fast path owns fast
path eligibility, the mechanical checklist, every voiding condition and the
verification-machinery carve-out. This document does not duplicate those
rules.

[review-rules.md](review-rules.md) § Reviewer sets, merge rule and charters owns
Reviewer I on a SMALL track removed by that carve-out.

## Halt, re-derivation and grade correction

An implementer halts when work engages an unlisted focus area or requires an
unplanned sensitive configuration change. The implementer also halts before
weakening a test or materially deviating from the approved design. A reviewer
backstop that finds a missed area also fires a halt. The halt occurs before
further work builds on the new fact.

On a halt, the orchestrator:

1. pauses implementation.
2. re-derives the change-level and per-track focus sets.
3. re-runs the size command and re-derives the grade upward only.
4. returns to the user confirmation gate when an area was added or the grade
   rose.
5. updates or creates the coverage register.
6. runs every newly required gate over all affected completed work.
7. resumes only after the blocking re-confirmation and retroactive gates pass.

A first-boundary measurement above the confirmed band fires this halt
immediately. Present the measured counts at re-confirmation. A measurement
below the confirmed band does not lower the grade. The route for confirming a
lower grade closes when implementation starts.

A halt may never remove an area or lower the grade after implementation has
started.

## Review coverage and the coverage register

Every part of the combined diff must reach the review set required by the
whole change. A track whose review set is below the change-level set
contributes its whole commit range to the closing review. User review does not
satisfy this machine-review floor.

The closing-review scope is the union of every contributed commit range, plus
integration across track boundaries, plus conformance to the approved design.
A LARGE change always receives a closing review. A SMALL or MEDIUM change with
more than one track receives one when the tracks share a file or interface.
[track-workflow.md](track-workflow.md) defines the closing-review combinations,
reviewers and fix budget.

Create a coverage register when either condition first holds:

1. the change has more than one track.
2. any track's review set is below the change-level set.

For every track, record its track number, review set and review commit range.
When a halt changes coverage, create or update the register and add every
newly contributed range. The register remains the review-accounting authority.
The track table remains a display-only split index and carries no commit
identifier.

A single-track change whose track review set equals the change-level set
satisfies the invariant without a register. At delivery, a live register
produces the one-line coverage conclusion required by
[track-workflow.md](track-workflow.md). The detailed register stays in the
research log.

## Commit discipline for drift and boundaries

[track-workflow.md](track-workflow.md) owns marker commits, track-title prefixes
and the source of truth for track boundaries. This section owns the remaining
commit discipline.

Every implementation commit body has exactly two parts:

1. **Intent:** what the commit accomplishes, not how it accomplishes it.
2. **Deviation delta:** only what differs from the original track task. Leave
   this part empty when nothing differs.

The deviation delta may contain only a deviation already sanctioned by a halt
and re-confirmation, a design-delta approval, or an immaterial design change.
A material deviation discovered at commit time fires a halt. The commit body
must never become a side channel for unapproved drift.

Do not put implementation rationale, self-assessment or verification claims in
the body. Examples of forbidden claims include `tested`, `verified
thread-safe` and `reviewed edge cases`. Fresh reviewers receive repository
state and declared intent, not implementer confidence.

For a multi-track change, every commit in a track's review range must belong to
that track. A reviewer checks the range against the track brief, its boundary
markers and its title prefixes. A commit from another track is cross-track
contamination. Correct a wrong boundary or title before the next writer
starts. An undeclared material deviation found during this check fires the
halt and re-derivation route above.
