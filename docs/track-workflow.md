# Track-based development workflow

This document is the lifecycle spine for every repository change. Size is a
workload grade. Focus identifies the review gates that the change engages.
Neither axis substitutes for the other.

| actor | grade or shape | document | exact section |
| --- | --- | --- | --- |
| orchestrator | every change | this document | § Lifecycle and phases |
| orchestrator | size and focus assessment | [blast-radius.md](blast-radius.md) | § Two independent axes |
| implementer | every track | this document | § Track intention block and focus declaration |
| reviewer | every review | [review-rules.md](review-rules.md) | § Reviewer sets, merge rule and charters |
| user | completed track | [user-notes.md](user-notes.md) | § Track packets |
| publisher | draft pull request enabled | [pr-publishing.md](pr-publishing.md) | § Creation |

## Lifecycle and phases

The mandatory phases run in this order:

1. research.
2. predict size and focus.
3. obtain user confirmation.
4. design and validate when required.
5. run adversarial design review when required.
6. obtain final design approval.
7. run the track loop.
8. run closing review when required.
9. obtain blocking final acceptance.
10. deliver.

The cumulative implementation commit is the original implementation and all
agentic-review fixes squashed into one commit before user review. The track loop
is present the approved high-level design when required, implement, validate,
declare focus, measure the first real committed boundary, review, and fix. Then
present any changed high-level design when required, create the cumulative
implementation commit, deliver the track packet, and apply and commit any
user-review fixes. Verify their range when one exists, and mark the boundary.
The implementer produces the low-level design and implements it as one
integrated action.

Every high-level design states the intention, goals, non-goals, approach, key
decisions, rejected alternatives, risks, scope boundary, and open questions. A
MEDIUM or LARGE design also includes a components diagram that shows how the
change affects components. Every grade includes a data-flow diagram when the
change alters data flow. The design stays high level. It names no file path,
method signature, or line number.

A high-level design states what must be true and why. A low-level design states
how the code achieves it. Apply the abstraction test: would this statement stay
true if the implementer chose a different reasonable implementation? A
statement that stays true is high-level. A statement that stops being true is
low-level. A size limit the result must respect, a behaviour a user can
observe, and a compatibility requirement for an exported format pass the test.
A line number, a function name, an exact string literal, a rename, and an
arithmetic result computed inside one check fail it. Low-level material is not
discarded. It belongs in the implementer report.

When an approved high-level design exists, present it before the track and
after it. Omit the before phase when the track design has not changed since its
last presentation to the user. Treat that omitted phase as auto-approved, so
implementation starts without waiting. Omit the after phase when implementation
did not change the design. This omission skips only the design-difference
presentation. It does not skip the track review. By default, a high-level
design update presents what changed. It omits unchanged text that
the reader does not need in order to act. The self-contained message test below
governs every update. Restate the minimum context the reader needs to act.
When no approved high-level design exists, neither presentation applies. A
material deviation instead follows [blast-radius.md](blast-radius.md) § Halt,
re-derivation and grade correction.

The user validates the design before an adversarial design review. A fresh
adversary tests the design and cited evidence. `No substantive findings.` is a
valid result.

The orchestrator triages each finding by strengthening a rationale, reversing
a decision, recording an accepted risk, or routing low-level material to the
implementer report. Hold a routed finding in the follow-up ledger until its
owning track starts. The implementer then copies it into that track's report.
The finding requires a report for that track when the grade does not already
require one. A reversal permits one more adversarial round. The user gives
final design approval after adversarial review and triage. When no adversarial
review is required, validation and final approval form one gate.

Publishing depends on `workflow.draftPRs` in `slate.json`. When enabled, use
[pr-publishing.md](pr-publishing.md). When disabled, the retained research log
is the durable workflow record.

## Size script and focus prediction

The orchestrator predicts the initial size grade before committed work exists.
The prediction states the expected changed production-logic lines, files,
grade, basis, and uncertainty. A committed candidate may inform the prediction.
It never mechanically sets the initial grade.

| size grade | predicted changed production-logic lines | file rule |
| --- | ---: | --- |
| SMALL | 0–50 | more than 25 files raises the grade to MEDIUM |
| MEDIUM | 51–1,000 | more than 25 files raises the grade to LARGE |
| LARGE | more than 1,000 | remains LARGE |

Use the higher grade when uncertainty crosses a band. The user may confirm a
lower prediction before implementation starts. Record the reason. The grade
never falls after implementation starts.

| stage | gate | SMALL | MEDIUM | LARGE |
| --- | --- | --- | --- | --- |
| pre-implementation | high-level design | only when design uncertainty or a changed existing public contract engages it | required | required |
| pre-implementation | validation before adversarial review | when a design adversary is required | required | required |
| pre-implementation | adversarial design review | when design uncertainty engages, or an existing consumer-reachable rule changes | when the same focus condition engages | when the same focus condition engages |
| pre-implementation | final design approval | after required design work | required after validation and any adversarial review | required after validation and any adversarial review |
| lifecycle | research log | when any trigger fires | always | always |
| per-track | implementer report | optional | required | required |
| per-track | Reviewer I | no by grade, except carved-out verification work | every track | every track |
| per-track | engaged-area reviewers | every engaged area whose canonical gate runs per track | every engaged area whose canonical gate runs per track | every engaged area whose canonical gate runs per track |
| final | final change acceptance | blocking | blocking | blocking |

The package-resolved command does not measure absent work. At the first track
boundary, run it against the real committed range:

```bash
node <package>/extension/size-grade.mjs --base <ref> --head <ref>
```

`<package>` is the absolute root of the installed `ytdb-slate` package. Slate's
doctrine supplies absolute installed document paths. The package root is the
parent of their `docs` directory.

Record both counts and the grade. A measured higher band halts work and returns
to § Confirmation gate. A lower band does not lower the grade. The canonical
counting and exclusion list lives only in [blast-radius.md](blast-radius.md)
§ Canonical counting and exclusion rules.

The orchestrator predicts focus from the request, repository evidence, likely
files, and uncertainty. Uncertainty engages an area.

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

[blast-radius.md](blast-radius.md) defines each area and owns the canonical
copy of this table.

## Confirmation gate

The orchestrator presents one proposal before implementation. It states the
predicted grade, expected counts, basis, uncertainty, change-level focus set,
per-track focus sets, split, and gates. The user confirms the grade and focus
set together. No file-modifying dispatch starts before confirmation and every
required pre-implementation gate.

When an approved high-level design exists, a **scope exception** is a design
proposal, reviewer finding, or implemented change that covers something the
approved goals do not list. The orchestrator presents every scope exception to
the user. The user chooses exactly one outcome:

1. add a goal.
2. approve a non-goal and require the work reverted.
3. approve a non-goal and keep the work, with the reason recorded.
4. defer the item to a later change and record it in the existing follow-up
   ledger.

Repeated regressions on one item make the orchestrator propose that item as a
non-goal candidate. The orchestrator marks nothing automatically. Every
non-goal needs user approval. The fourth outcome appears through the existing
follow-up ledger delta in the track packet. It creates no second register. A
scope exception from an already-implemented change also follows
[blast-radius.md](blast-radius.md) § Halt, re-derivation and grade correction.
The scope-exception outcome composes with that route and does not replace it.
The route still re-derives size and updates the coverage register. When no
approved high-level design exists, the scope-exception rule does not apply. The
same halt, re-derivation, and grade-correction route governs instead.

Every message to the user must be complete on its own. State the substance
before any identifier. State each item in words, including what was found,
where it matters, and what follows. An index entry is exempt because an index
is a list of pointers by design. The substance for each index entry lives in
its referenced finding, packet, register entry, or final report. When asking
for a decision, state each option and its consequence. Apply the self-contained
message test: a reader who has read nothing except this message can act on it.
The test governs claims, decisions, and options. It does not require the
artifact under review to be inlined. A review request names that artifact and
states where to find it. The research log, observation files, and episode
records are orchestrator tools. They are never the channel that informs the
user.

The scope-exception rule and the self-contained message rule govern every
workflow phase. Their position beside re-confirmation does not limit them to
pre-implementation work.

New evidence can only raise the grade or add focus. Either change halts work,
updates the coverage register, and requires user re-confirmation. Newly required
gates run over all affected completed work before work resumes.

## Focus touchpoints

Focus has four mandatory touchpoints.

1. **PREDICT.** The orchestrator predicts the change-level and per-track sets
   before confirmation.
2. **DECLARE.** The implementer declares every area actually engaged by each
   changed file. Use one line per area and file:

   `focus: <area name> | file: <path> | reason: <one short clause>`

3. **CONFIRM.** The orchestrator compares the declaration with the prediction
   before review. A new area fires the halt in § Confirmation gate.
4. **BACKSTOP.** Every reviewer checks for missed areas. A missed area blocks,
   fires the same halt, and receives all retroactive gates.

A missing declaration blocks the track. Retry the implementer once. Escalate
a second failure under [user-notes.md](user-notes.md) § Mandatory escalation
set.

## Fast path

A SMALL single-track change may use the fast path only when every item passes.

1. The outcome is mechanical and has one clear implementation.
2. No design uncertainty exists.
3. No existing consumer-reachable rule changes.
4. No sensitive configuration changes.
5. No silent failure requires new detection reasoning.
6. No focus area is engaged.
7. No project test artifact changes.
8. No verification, gate, coverage, packaging, release, or workflow machinery changes.
9. The change remains within the declared file list.
10. One mechanical validation can establish the result.

When all ten conditions pass, the fast path omits the high-level design,
adversarial design review, machine reviewer, research log, implementer report,
and closing review. Another rule can still require any omitted gate or
artifact.

The fast-path sequence is prediction → confirmation → implementation →
mechanical validation → focus declaration → committed-boundary size measurement
→ mechanical checklist → track packet → blocking final acceptance → delivery.
After boundary measurement, run all ten checklist items against the committed
range and actual declarations.
If any item fails, return to the ordinary SMALL workflow before packet delivery.

Any project test artifact voids the fast path. Any verification or gate
machinery also voids it. Carved-out SMALL verification work receives Reviewer I.
Other SMALL work receives every reviewer whose canonical focus-area gate runs per track.

## Track packet shape

A SMALL track packet adds these four grade-specific fields to the common fields
in [user-notes.md](user-notes.md) § Track packets:

1. confirmed grade and its rationale.
2. commit range.
3. focus declaration and any focus change.
4. machine review outcome, with finding counts by type, severity, and
   disposition. When the fast path omits machine review, state that this field
   does not apply.

For a single-track SMALL change, the track packet asks for final change
acceptance. For a multi-track SMALL change, it reports the track without adding
a blocking acceptance gate.

## Track intention block and focus declaration

Every implementation and review dispatch carries these fields:

- target.
- scope boundary.
- deferred work.
- acceptance condition.
- declared file list.

The implementer returns the fixed focus declaration lines from § Focus
touchpoints. Implementation commit titles use `Track <n>: <intent title>`.
An agentic-review fix commit inside a track uses
`Track <n> fix round <r>: <intent title>`. The original implementation commit
uses the Intent and Deviation-delta discipline in
[blast-radius.md](blast-radius.md) § Commit discipline for drift and boundaries.
Each agentic-review fix commit uses the same discipline. A user-review fix
commit uses
`Track <n> user review fix <r>: <intent title>` and the same two-part body.
For that title, `<r>` starts at 1 and increases by one for each user-review fix
commit in the track. That section also defines the distinct cumulative
implementation body.

For each MEDIUM or LARGE track, the implementer creates
`track-<number>-implementer-report.md` at the repository root when the track
starts. The report is untracked working material. It has four required
sections: changes to the high-level design with the reason for each, the
low-level design, diagrams where they help, and checks run with their results.
Later fix rounds append to the same report.

Tracks are contiguous and execute through one sequential writer. Independent
research and reviews may run in parallel. File-writing implementation does not.
A later track builds on the accepted boundary before it.

## Session handoff and the research log

MEDIUM and LARGE changes always use `research-log.md` at the repository root.
A SMALL change opens it when any retained trigger fires. Each MEDIUM or LARGE
track creates its implementer report at track start, beside the research log.

| trigger | SMALL | MEDIUM and LARGE |
| --- | --- | --- |
| second non-obvious decision | opens the log | already open |
| surprise about repository behaviour | opens the log | already open |
| any focus area engages | opens the log | already open |
| session boundary | opens the log | already open |
| multiple tracks | opens the log | already open |
| plan-changing ruling | opens the log | already open |
| user request | opens the log | already open |
| unresolved question needed later | opens the log | already open |

Open these sections: Initial request, Decision Log, Surprises and Discoveries,
and Open Questions. Add Planned changes, Track table, coverage register,
follow-up ledger, override log, and escalation records when needed. Do not use
an observations section. Worker observation files are review evidence, not
user feedback.

At MEDIUM and LARGE, every retained entry is typed as `decision`, `evidence`,
`ruling`, `risk`, `question`, `focus`, `verification`, or `handoff`. Append an
entry immediately after its event. Keep each entry self-contained.

Do not copy secrets, credentials, private user data, or unnecessary personal
data into the log. Record a privacy exception as a typed ruling. State what was
omitted and why.

Use a safe write method. Create the file without following a symlink. Append
through a temporary file and atomic rename when replacement is needed. Keep the
log and every implementer report untracked and visible in repository status.
Do not add either name to an ignore file. Never overwrite either from a stale
in-memory copy. An implementer report never enters a pull request.

Before a session handoff, append a state summary. It names the confirmed grade,
focus sets, current track, current implementer report location, last boundary
marker, live registers, open findings, checks run, and next action. A
context-budget handoff, user-requested handoff, or session end with unfinished
work triggers this summary.

## Resume order and reconciliation

Resume in this fixed order:

1. Read the initial request and latest state summary.
2. Read decisions, rulings, risks, and open questions added since the prior
   summary. When the state summary names an existing current implementer
   report, read it at that location.
3. Inspect marker commits and the current branch state.
4. Reconcile the declared file list, track table, coverage register, focus sets,
   and live diff.
5. Re-run any stale precondition check.
6. Continue only after answering: **What changed since the last state summary,
   and does it change grade, focus, scope, or required gates?**

A mismatch pauses work. Reconcile it in the log. Use marker commits and Git
history as boundary authority. The track table is display-only.

## Closing review

Every part of the combined diff must reach the review set required by the whole
change. A coverage register records any track whose set falls below that set.
It also records each contiguous user-review fix range. User review never
replaces machine review.

Closing review runs for these combinations:

- every LARGE change.
- every multi-track change with a shared file or interface.
- every change with cross-track focus that no single track engaged.
- every change whose coverage register contains a track range that must reach
  missing change-level reviewers.

The closing set includes one `integration` reviewer. It also includes each
missing change-level area reviewer for contributed ranges. Those ranges are
defined in [blast-radius.md](blast-radius.md) § Review coverage and the coverage
register. Test-quality and structure, and prose and licensing, remain additional
reviewers when engaged. Reviewer I does not replace integration.

Reviewer composition follows [review-rules.md](review-rules.md) § Reviewer
sets, merge rule and charters. The coverage invariant is satisfied only when
every changed part reaches all required perspectives, except for a user-review
fix range. That range does not enter the change-level review set, and its
dedicated gate thread satisfies the coverage invariant for that range. Cap
production area reviewers at four per review action. Split review actions when
more are needed. Reviewer I, test-quality and structure, prose and licensing,
and integration do
not count against that cap.

A closing review has two fix rounds. A round that clears nothing stops and
escalates. At budget exhaustion, the user may waive the remainder, extend the
budget, or split the range. The change cannot reach final acceptance with an
open blocker or an unverified addressed finding.

<!-- safety-floor:begin -->
- concurrency and ordering guarantees.
- durability, recovery, and transactional semantics.
- security, authorization, secrets, and user-data exposure.
- consumer-reachable public interfaces and behavioural contracts.
- silent failures without a reliable detection path.
- missing or ineffective tests for changed behaviour, branches, or failure paths.
- verification and gate machinery that can report success without establishing its claim.
<!-- safety-floor:end -->

## Delivery and termination

Every completed track reaches the user through the track packet defined in
[user-notes.md](user-notes.md) § Track packets. At MEDIUM and LARGE, user review
of each track is blocking. The orchestrator cannot add the marker or start the
next track until the user accepts the track and every requested fix. At SMALL,
a track packet in a multi-track change reports progress without adding a
blocking acceptance gate. For every single-track change, the track review and
blocking final change acceptance are one event. Final change-level acceptance
remains blocking at every grade.

Done means all required reviews and gates passed. No blockers remain. Every
addressed finding is verified. Every major finding is fixed or has a recorded
user waiver.

The note queue is drained. Every escalation has a disposition. The coverage
invariant holds. The user accepts the final change.

A track contributes one cumulative implementation commit and zero or more
user-review fix commits. It also contributes zero or more correction commits,
as defined later in [track-workflow.md](track-workflow.md) § Delivery and
termination. For a multi-track change, it contributes one marker commit.
During machine review, the implementer commits fixes separately so a gate
thread can inspect each fix difference. Before user review, squash the original
implementation commit and every agentic-review fix commit into the cumulative
implementation commit. This commit exists so the user reviews the high-level
design, low-level design, and implementation together.

When the track has a high-level design, the cumulative implementation commit
body carries the track high-level design followed by the track low-level
design. When the track has no high-level design, the ordinary two-part Intent
and Deviation-delta shape applies. This conditional body rule is also stated in
[blast-radius.md](blast-radius.md) § Commit discipline for drift and
boundaries.

Commit each fix requested during user review separately after the cumulative
commit. Do not squash a user-review fix into the cumulative commit, because
folding it back would destroy the exact state the user reviewed. Present each
fix and obtain user acceptance. When at least one such commit exists, add their
contiguous range to the coverage register. Dispatch one fresh gate thread to
verify that range before adding the marker, or before completing final
acceptance for a single-track change.

For a user-review fix range, one dedicated gate thread replaces the full
change-level review set as a deliberate proportionality choice. A **REJECTED**,
**STILL OPEN**, or **REGRESSION** verdict routes each correction through the
existing agentic-review fix title and body form. Repeat this gate on the
corrected range. This correction loop uses the ordinary two-round cap and
escalation rules in
[review-rules.md](review-rules.md) § Fix loop and gate verdicts.

The correction remains a separate commit after the cumulative implementation
commit. Do not squash it. A track with no user-review fix commit adds neither
this range nor this gate action. The marker comes last because it defines the
track range. A fix after the marker would belong to the next track.

A bootstrap commit created to open a draft pull request uses
`Bootstrap: <intent title>`. It is not part of any track. Re-pin every recorded
commit range after the rewrite, including the coverage register and any range
in a track packet. Complete the rewrite before user review, so later
user-review fix commits do not invalidate the reviewed range.

When draft-pull-request publishing is enabled, update its branch with a
lease-protected force-push. The lease must prevent discarding a commit pushed
by another party.

After user acceptance, a multi-track boundary adds one empty marker commit:

```bash
git commit --allow-empty -m "Track NN complete: <short name>"
```

Marker commits are the boundary authority. Track N is the range after marker
N-1 through marker N. A single-track change has no marker. Rebases move markers
with history. Any layered process that pins marker refs must re-pin after a
rebase.

The track table lists names, one-line scopes, and status. It contains no commit
identifier. Track numbers are append-only. Abandoned tracks are struck through.
Numbers are never reused.

Delivery is the final squashed commit on the default development branch, or an
explicit abandonment. Resolve or hand every open question to the user. Follow
[user-notes.md](user-notes.md) for final accounting. Delete the retained local
log and every implementer report only at delivery. The untracked-retention
rule in § Session handoff and the research log keeps them out of the pull
request. On abandonment, offer their content for archival first.

Aim for a delivery body at or below 16,384 UTF-8 bytes. Measure exact bytes from
the commit object. If larger, remove repetition first. Then record a measured
size exception and obtain user approval. Never remove needed decisions, risks,
verdicts, or evidence merely to meet the target.

No release occurs in this workflow. Packaging, publication, version changes,
tags, and registry release require a separate explicit user request and the
project release runbook.

## Migration

A change whose design was approved under an earlier workflow finishes under
that recorded workflow. New work uses this size-grade and focus-area workflow.
Historical records may name earlier gates only to identify the governing rule
set.

## Layering richer workflows on top

A project may add doctrine through `doctrineExtraPath`. Added rules may enrich
planning, peer review, or delivery. A layered peer review supplements machine
review and user acceptance. It never replaces either. Complete or obtain a user
waiver for every pending layered review before a draft pull request becomes
ready for review.

Added rules may not replace confirmation, design and validation gates, focus
coverage, fresh machine review, marker authority, blocking final acceptance,
or draft-pull-request safeguards.
