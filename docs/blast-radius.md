# Blast radius, size and review coverage

This document defines the measured size axis and the judged focus axis. It
also defines decomposition constraints, review coverage, drift control and
commit discipline that depends on drift. [track-workflow.md](track-workflow.md)
is the lifecycle spine. [review-rules.md](review-rules.md) defines reviewer
composition and finding handling.

## Two independent axes

**Size is measured.** One script counts changed production-logic lines and
files touched. The line count sets the initial size grade. The file count sets
the track floor and can raise the grade.

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
exports that command path as `SIZE_GRADE_SCRIPT`. The command prints the
changed production-logic line count, the files-touched count and the exclusion
decision for every changed file.

Run the command during initial assessment. Record both counts. Run it again on
the real diff at the first track boundary. The first run supports the proposed
grade and track plan. The boundary run verifies them against implemented work.

### Canonical counting and exclusion rules

This section is the only normative statement of the counting and exclusion
rules. Other documents must point here instead of restating them.

The command uses `git diff --no-renames --numstat`. It adds each source file's
added-line count and deleted-line count. Only files classified as `source`
contribute to the production-logic line total. The excluded kinds are `test`,
`generated`, `documentation`, `build`, `configuration` and `other`.

The classifier applies this order and stops at the first match:

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
| 9 | test integrity | the test-quality reviewer | every track that engages the area |
| 10 | user-facing or licensing-adjacent prose | one prose and licensing reviewer | every track that engages the area |
<!-- focus-area-table:end -->

The marked table is the canonical copy of the duplicated ten-area table. Its
second copy is in [track-workflow.md](track-workflow.md). The two marked blocks
must remain equal.

Duplicated doctrine blocks follow the reviewer-charter marker convention. An
HTML comment `<!-- <block-name>:begin -->` immediately precedes the block, and
`<!-- <block-name>:end -->` immediately follows it. This table's block name is
`focus-area-table`. Its second copy must use the exact markers
`<!-- focus-area-table:begin -->` and `<!-- focus-area-table:end -->`.

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
that has non-trivial invariants or state machines. Its frequency is not a
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

### 9. Test integrity

Test integrity covers deleting a test, weakening an assertion, relaxing a
tolerance or adding a skip or ignore marker. It always adds the test-quality
reviewer.

Test addition is not a focus area. A track whose only content adds tests still
receives the test-quality reviewer. When tests accompany code, the area
reviewers read those tests and test addition adds no separate thread.

### 10. User-facing or licensing-adjacent prose

This area covers text that a consumer of the package can read. It includes
user documentation, command help, release notes, prompt strings and
public-facing messages. It adds a prose and licensing reviewer whose first
charter item is licensing and provenance exposure.

A short internal comment, a test name or a mechanical label does not engage
this area.

### Reviewer merge rule

Merge two focus areas into one reviewer only when both reviewers would read
the same code and use the same evidence. Do not merge areas that read
different lines or use the same lines for different reasons. The orchestrator
records the shared code, shared evidence and reason for every merge. No fixed
reviewer-slot map applies.

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

## Four focus touchpoints

The workflow produces and corrects the focus set at four explicit points.

### 1. PREDICT

Before implementation, derive the engaged areas from the design, planned file
list and any project path declarations. Give each area a one-line reason.
Present the predicted set, measured counts and proposed grade at the single
user confirmation gate. An uncertain area counts as engaged.

### 2. DECLARE

Every implementer reports each area that its work engaged in its episode. Use
one line for each area:

```text
focus: <area name> | file: <path> | reason: <one short clause>
```

An implementer that engaged no area emits one line saying so. Silence is not a
declaration. The declaration reaches the orchestrator and successor
implementers. It never reaches a reviewer.

A missing declaration blocks the track. Ask the same thread again and record
the miss. After two failed attempts, escalate to the user. Offer exactly three options:
use a fresh implementer thread, re-run the track, or accept a declaration
supplied by the user.

### 3. CONFIRM

Compare the declaration with the design and predicted set. Re-clarify with the
same implementer when an area appears missing. A declared area missed during
prediction joins the change-level set immediately and adds its gate.

### 4. BACKSTOP

Every reviewer reports any observed focus area missing from the current set.
A missed area fires the halt rule below. Do not pass an implementer's focus
declaration to a reviewer, because that would give the backstop the same blind
spot.

The backstop does not exist on a reviewer-free fast path. The fast path instead
uses its checklist, the track diff in the user packet and blocking
change-level acceptance.

## Fast path

A change is eligible only when every condition below holds:

- its grade is SMALL.
- no focus area is engaged.
- the track content is not tests alone.
- the change does not touch verification or gate machinery.
- no other voiding condition below applies.

An eligible change follows these steps and no heavier path:

1. Research the change. Run the size command and record both counts. Predict
   an empty focus set.
2. Present the counts, SMALL grade, empty set with reasons, and a short design
   note containing intent, files and a risk statement. Obtain the user's
   confirmation and record the validation mark.
3. When `workflow.draftPRs` is true, publish as
   [pr-publishing.md](pr-publishing.md) directs.
4. Dispatch one implementer with the declared file list. Obtain its focus
   declaration. Apply the commit rules below and run the mechanical checklist.
5. Run the size command on the real diff at the track boundary. Apply the
   grade correction route when the measured band is higher.
6. Confirm the focus declaration. A newly engaged area voids this path. A
   missing declaration blocks the track.
7. Present the user packet with aim, size grade, commit range, track diff and
   checklist result. Use a diffstat beside the commit range for a large diff.
   This packet is non-blocking.
8. At delivery, state that no research log was kept and whether any user note
   arrived. Present and measure the delivery commit body. Obtain blocking final
   acceptance.

### Mechanical checklist

1. Every changed file appears in the declared file list, and every declared
   file is changed.
2. No file outside the declared list is added, renamed or deleted.
3. The focus declaration is present in the episode and uses the fixed shape.
4. The commit message carries the track prefix and two-part body required by
   [track-workflow.md](track-workflow.md) and this document.
5. The size command ran, and both counts remain inside the confirmed band.
6. Every project check required for the changed paths ran and exited zero.
7. The writing checker ran over every changed convention-governed prose file,
   and its fail-class count is zero or recorded.
8. On a track whose only content adds tests, every added test fails against the
   pre-change tree and passes against the post-change tree.

Item 8 remains a cheap backstop after test-only content has voided the fast
path. The test-quality reviewer is authoritative.

### Fast-path voiding conditions

Any one of these conditions takes the change off the fast path:

1. A research-log trigger in [track-workflow.md](track-workflow.md) fires.
2. A halt fires.
3. A user note arrives.
4. The change has more than one track.
5. A finding is raised on the track.
6. A focus area becomes engaged at any touchpoint.
7. The track content is tests alone.
8. The change touches verification or gate machinery.
9. The boundary measurement lands above the confirmed band.
10. The user requests a full packet, log, review or other heavier path.

The verification-machinery carve-out applies when every changed file belongs
to the project's own checks. A project declares that file set. In this
repository the set is everything under `verification/`,
`.github/workflows/ci.yml`, `extension/writing-check.mjs` and
`extension/size-grade.mjs`.

A track removed by condition 8 receives Reviewer I, the implementation
reviewer. This is the only case where a SMALL track receives Reviewer I solely
because of size and path shape. Any engaged focus area adds its reviewer too.

User-facing or licensing-adjacent prose needs no separate carve-out. It
engages area 10 and leaves the fast path through condition 6. Publishing alone
does not void the fast path.

## Halt, re-derivation and grade correction

An implementer halts when work engages an unlisted focus area or requires an
unplanned sensitive configuration change. The implementer also halts before
weakening a test or materially deviating from the approved design. A reviewer backstop that finds a missed
area also fires a halt. The halt occurs before further work builds on the new
fact.

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
