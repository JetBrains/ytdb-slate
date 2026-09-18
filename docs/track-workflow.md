# Track-based development workflow

This document is the lifecycle spine for every repository change. Proved focus
areas select design, review, and track-acceptance gates.

| actor | action | document | exact section |
| --- | --- | --- | --- |
| orchestrator | every change | this document | § Lifecycle and phases |
| orchestrator | focus planning | [blast-radius.md](blast-radius.md) | § Focus states and track constraints |
| implementer | every track | this document | § Track intention block and implementer response |
| reviewer | every review | [review-rules.md](review-rules.md) | § Reviewer sets, merge rule and charters |
| user | completed track | [user-notes.md](user-notes.md) | § Track packets |
| publisher | draft pull request enabled | [pr-publishing.md](pr-publishing.md) | § Creation |

## Lifecycle and phases

The mandatory phases run in this order:

1. research.
2. propose the eleven-line risk record and obtain user approval.
3. design and validate when a proved DESIGN-TRIGGERING area requires a design.
4. when a design exists, reconfirm the focus list against the validated design.
5. when a design exists, run one adversarial design review for each proved
   DESIGN-TRIGGERING area that has not reviewed the applicable design.
6. when a design exists, obtain final design approval.
7. run the track loop.
8. obtain blocking final acceptance.
9. deliver.

The cumulative implementation commit is the original implementation and all
agentic-review fixes squashed into one commit before user review. The track loop
presents the approved high-level design when required, plans and approves the
track's independent risk record, implements, validates, compares the committed
difference with the proved areas, reviews, and fixes. It then presents any
changed high-level design when required, creates the cumulative implementation
commit, and delivers the track packet. It applies and commits required user-review
fixes whenever the user requests them. It verifies their range when one exists
and marks the boundary. The implementer produces the low-level design and
implements it as one integrated action.

Every high-level design states the intention, goals, non-goals, approach, key
decisions, rejected alternatives, risks, scope boundary, and open questions.
The design author includes each component or data-flow diagram that helps the
reader. Each omitted diagram gets a one-sentence reason. The design stays high
level. It names no file path, method signature, or line number.

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
material deviation instead follows [blast-radius.md](blast-radius.md) § Halt
and focus re-derivation.

<!-- design-review-policy:begin -->
The user validates the design and judges whether it is the simplest solution.
The orchestrator then reconfirms every focus line against that design. Each
proved DESIGN-TRIGGERING area receives one fresh adversarial design reviewer.
A fresh adversary tests the design and cited evidence. Every review with no
findings, including an adversarial design review, ends with the exact standalone
line `No findings.`

The orchestrator triages each finding by strengthening a rationale, reversing
a decision, recording an accepted risk, or routing low-level material to the
implementer report. Hold a routed finding in the research log until its
owning track starts. The implementer then copies it into that track's report.
The finding stays in that track's implementer report. Each design reversal
permits one additional independent adversarial design-review round. This
permission changes neither ordinary fix-round nor consultation caps. The user
gives final design approval after adversarial review and triage. When no
adversarial review is required, validation and final approval form one gate.
<!-- design-review-policy:end -->

Publishing depends on `workflow.draftPRs` in `slate.json`. When enabled, use
[pr-publishing.md](pr-publishing.md). When disabled, the retained research log
is the durable workflow record.

## Focus classes and gates

DESIGN-TRIGGERING areas are data loss, concurrency defect, security weakness,
performance degradation, and non-local logic defect. REVIEWER-ONLY areas are
test-quality defect, unreadable user-facing prose, licensing exposure, consumer
contract break, governing-rule defect, and unreported failure.

Only a proved area adds a focus-dependent gate or routine implementation
reviewer. Every proved area adds its specialist. A track with at least one
proved area also gets exactly one Reviewer I in a separate thread. A track with
no proved area gets no routine implementation reviewer. A proved
DESIGN-TRIGGERING area also requires a high-level design, user validation,
focus reconfirmation, its own adversarial design reviewer, and final design
approval. User acceptance of a track is blocking when that track proves at
least one DESIGN-TRIGGERING area. A track with only REVIEWER-ONLY areas, or no
proved area, has no mandatory track-acceptance gate. A track with no proved area
also has no area reviewer. Final change acceptance is always blocking.

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

For implementation of a track with no proved area and model routing on, choose
a suitable candidate from `router.models` with a sourced tier of 2 or higher.
If none exists, choose the highest sourced tier and record the fallback in the
track packet. A rendered `t?` is not a rank. It cannot qualify for tier 2 or
enter a rank comparison. If no candidate has a sourced tier, stop before
implementation and ask the user to choose explicitly from `router.models`.
Record the choice and the unknown-tier limitation. Candidate membership,
effort, avoid, and dispatch restrictions still apply. Routing off has no tier
vocabulary, so this policy has an accepted enforcement gap and adds no runtime
guard.

[blast-radius.md](blast-radius.md) defines each area and owns the canonical
copy of this table.

## Confirmation gate

The orchestrator presents one proposal before implementation. It states the
track split, required pre-implementation gates, research-log location, and the
independent eleven-line risk record for the change. Each line is NAMED with a
four-part proof or states which trigger part answers no. The user alone approves
or rejects each proof and judges the proposed solution. An approved proof makes
the area proved. A rejected proof makes the area SKIPPED. No file-modifying
dispatch starts before user approval and every required pre-implementation gate.

When an approved high-level design exists, a **scope exception** is a design
proposal, reviewer finding, or implemented change that covers something the
approved goals do not list. A proposal to remove an approved goal is also a
scope exception. The orchestrator presents every scope exception to the user.
The user chooses exactly one outcome:

1. add a goal.
2. approve a non-goal and require the work reverted.
3. approve a non-goal and keep the work, with the reason recorded.
4. defer the item to a later change and create a tracked issue. When the project
   has no issue tracker, record the deferral in the delivery record.
5. approve the removal of a goal, with the reason recorded.

The orchestrator also proposes the simplest solution. This duty applies when an approved high-level design exists, because the approved goals live in that design. When a planned or implemented solution reaches something the approved goals do not list, the orchestrator proposes one of two repairs. The first repair simplifies the solution until it fits the approved goals. The second repair adds the missing goals.

The orchestrator presents that proposal together with the scope exception. The first repair leads to the second outcome above. The second repair leads to the first outcome above. The five outcomes above remain the user decision set.

Repeated regressions on one item make the orchestrator propose that item as a
non-goal candidate. The orchestrator marks nothing automatically. Every
non-goal needs user approval. The fourth outcome appears as a tracked issue, or as a delivery-record entry
when the project has no issue tracker. A scope exception from an
already-implemented change also follows
[blast-radius.md](blast-radius.md) § Halt and focus re-derivation. The
scope-exception outcome composes with that route and does not replace it. The
route still re-derives the focus set. When no approved high-level design exists,
the scope-exception rule does not apply. The same halt and focus re-derivation
route governs instead.

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

Before each track implementation, assess whether the approved design and
completed design gates cover the track's proved areas and planned behavior. A
new track created after the original confirmation gate needs user approval of
its independent risk record before implementation starts. If that planning
newly proves a DESIGN-TRIGGERING area, enter or re-enter the design sequence
before the affected implementation. Present the necessary new, revised, or
materially clarified high-level design, its delta, and the reason to the user.
User validation precedes each newly required area-specific adversarial review
and final approval. Reuse adequate unchanged approved design and completed
applicable gates. Reusing text does not bypass a newly required area-specific
design review. Routine low-level design choices need no user approval unless
they change approved behavior or constraints. If an implementer discovers a
design gap later, pause affected work and complete this route before continuing.

<!-- multi-track-handoff:begin -->
For a multi-track change, immediately before the implementation of every track, the orchestrator saves a current state summary in `research-log.md` and appends a typed `handoff` entry. The orchestrator then asks the user whether to hand off to a fresh session.

The first boundary is after all required planning and pre-implementation gates for the affected track are complete, including the confirmation gate, any scope-exception decisions, and every applicable design gate. It is immediately before the first track implementation. At each later boundary, the orchestrator completes the current track packet and required acceptance before saving state and asking for handoff before the next track implementation.

The orchestrator pauses dispatch pending an actual handoff and resume or an explicit user decision to continue in the same session. The explicit same-session decision is recorded as a user waiver in the existing override log. A resumed session follows Resume order and reconciliation and does not repeat a boundary request already recorded as completed. Same-track fix rounds do not retrigger the request. Single-track changes are exempt. This workflow rule has no automated runtime enforcement.
<!-- multi-track-handoff:end -->

If the planned split exceeds twelve tracks, stop and present the split to the
user. The user chooses whether and how the change proceeds.

## Risk planning and reconciliation

The orchestrator judges each focus area for the whole planned track, not for
each file. It writes all eleven risk-record lines. A NAMED line carries the
four-part proof defined in [blast-radius.md](blast-radius.md) § Judged proof
and risk record. Each other line states which trigger part answers no. The user
alone judges each proof. User approval makes the area proved. User rejection
makes it SKIPPED. A SKIPPED area adds no gate or reviewer.

The proof basis is the approved track design. When the track has no design, the
basis is the track intention block and planned file list. The user approves or
rejects every NAMED proof at the confirmation gate. When a design exists, the
user validates it before the orchestrator reconfirms all eleven lines against
that design. The orchestrator presents every addition and removal with its proof
or failed trigger part. User approval of the reconfirmed list precedes one
adversarial design review for each proved DESIGN-TRIGGERING area. Final design
approval follows those reviews. The design stage is the only stage where an
adversarial reviewer receives the approved risk record and area proofs as
separate inputs. Implementation reviewers and both repair gates receive neither.
The stuck-fix consultation follows the whole-episode exception in
[review-rules.md](review-rules.md) and receives no separately supplied risk
record or area proof.

Before code review, the orchestrator compares the committed difference with the
proved set. A missed area follows the late-area route below. For an area that no
longer engages, record the failed trigger part and present a removal proposal to
the user at once. The area remains proved, with all of its gates and reviewers,
until the user approves removal. Rejection preserves the proved area. Keep every
reviewer that already covered completed work. The track packet reports every
addition, proposed or approved removal, SKIPPED state, user decision, and
reviewer-coverage decision.

When the orchestrator or implementer discovers a late area, the orchestrator
presents its four-part proof to the user at once. Approval recomputes the
complete required routine reviewer set. If the track had no proved area, the
newly required perspectives are Reviewer I and the new area specialist.
Otherwise, the existing Reviewer I remains required but is not dispatched
again. The only newly required perspective is the new area specialist. Approval
of a DESIGN-TRIGGERING area also enters or re-enters the design sequence for
remaining affected work unless the user records a decision to skip that gate.
Present any necessary new, revised, or materially clarified design before
continuing that work. Reuse unchanged approved design and completed applicable
gates, but run the newly required area-specific design review. Completed work
receives no retrospective design gate. Every newly required routine reviewer
perspective reviews the completed range, even when another perspective already
covered it. When no work remains, record the design-gate skip, complete that
review, and present the record at final acceptance.

The implementer reports any risk that the plan did not name. The orchestrator
writes its proof and starts the same immediate user-decision route. An
implementation reviewer receives no proof.

## Track intention block and implementer response

Every implementation and review dispatch carries these fields:

- target.
- scope boundary.
- deferred work.
- acceptance condition.
- declared file list.

Every implementation dispatch carries this focused current-context block:

> Research log: `research-log.md` remains the retained full record. Use the references and excerpts supplied for this action. Read more history only when a relevant question remains unresolved.

The block states the current approved design when one exists, the current task
and acceptance condition, assigned findings and compact evidence when fixing,
affected code or documents, relevant decisions, and unresolved relevant
questions. The orchestrator supplies these inputs through specific section
references or bounded excerpts. Implementers and fixers use the supplied
current context. The full log remains available for unresolved relevant
questions and retention. No implementation dispatch requires reading the entire
historical log. This rule does not change reviewer input restrictions.
Every implementation dispatch either carries each focus-area trigger with its boundary
sentences or directs the implementer to the risk definitions in
[blast-radius.md](blast-radius.md) § Focus areas and their gates. The implementer
ends its response with `unplanned risk: none` or one line that names a risk the
plan did not name.

Review dispatches follow [review-rules.md](review-rules.md) § Reviewer input
contract. Reviewers receive the approved inputs for their role. Ordinary
repository and library evidence needed for the assigned work remains available.
This permission is not a closed changed-file allowlist.

Implementation commit titles use `Track <n>: <intent title>`.
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

For each track, the implementer creates
`track-<number>-implementer-report.md` at the repository root when the track
starts. The report is untracked working material. It has four required
sections: changes to the high-level design with the reason for each, the
low-level design, diagrams where they help, and checks run with their results.
Later fix rounds append to the same report.

Tracks are contiguous and execute through one sequential writer. Independent
research and reviews may run in parallel. File-writing implementation does not.
A later track builds on the accepted boundary before it.

## Session handoff and the research log

Create `research-log.md` at the repository root before the first implementation
dispatch, without waiting for a retained trigger. Each track creates its
implementer report at track start. Append a retained entry immediately when any
trigger below fires.

- a second non-obvious decision.
- a surprise about repository behaviour.
- a NAMED focus area.
- a session boundary.
- multiple tracks.
- a plan-changing ruling.
- a user request.
- an unresolved question needed later.

Open these sections: Initial request, Decision Log, Surprises and Discoveries,
and Open Questions. Add Planned changes, Track table, risk record, coverage
register, override log, and escalation records when needed. Do not use an
observations section. Worker observation files are review evidence, not user
feedback. Naming an area opens the log even when the user later rejects its
proof. Every retained entry is typed as `decision`, `evidence`,
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

Before a session handoff, append a state summary. It names the proved focus
areas and risk-record location, current track, current implementer
report location, last boundary marker, live registers, open findings, checks
run, and next action. A
context-budget handoff, user-requested handoff, or session end with unfinished
work triggers this summary.

## Resume order and reconciliation

Resume in this fixed order:

1. Read the initial request and latest state summary.
2. Read decisions, rulings, risks, and open questions added since the prior
   summary. When the state summary names an existing current implementer
   report, read it at that location.
3. Inspect marker commits and the current branch state.
4. Reconcile the declared file list, track table, coverage register, proved
   focus areas, risk record, and live diff.
5. Re-run any stale precondition check.
6. Continue only after answering: **What changed since the last state summary,
   and does it change focus, scope, or required gates?**

A mismatch pauses work. Reconcile it in the log. Use marker commits and Git
history as boundary authority. The track table is display-only.

## Review coverage

Every part of a track range must reach the complete routine implementation
reviewer set that the proved areas require. The set is empty when the track has
no proved area. Otherwise it contains exactly one Reviewer I and every required
area specialist. User review never replaces required machine review. This
requirement is the coverage invariant. A track with an empty set reports
routine implementation review as `NOT REQUIRED`.

The coverage register records each contiguous range of user-review fix commits
together with the gate verdict for that range. It is the review-accounting
authority for those ranges. At delivery, a live register produces the one-line
coverage conclusion required below.

## Delivery and termination

Every completed track reaches the user through the track packet defined in
[user-notes.md](user-notes.md) § Track packets. User acceptance of a track is
blocking when that track proves at least one DESIGN-TRIGGERING area. The
orchestrator cannot add the marker or start the next track until the user accepts
that track and every requested fix. A track with only REVIEWER-ONLY areas, or no
proved area, has no mandatory track-acceptance gate. In a single-track change,
any blocking track acceptance and final change acceptance are one event. Final
change acceptance is always blocking.

Done means all required reviews and gates passed. For routine implementation
review, the required set is the set in § Review coverage. An empty set reports
`NOT REQUIRED` and requires no invented Reviewer I coverage. No blockers remain.
Every addressed finding at major severity or above is verified. Every major
finding is fixed or has a recorded user waiver. Every finding below major
severity has a recorded disposition of fixed, ignored, moot, or rejected.

The note queue is drained before final acceptance. Every escalation has a
disposition. The coverage
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

For a user-review fix range, one dedicated gate thread supplies machine review
for that range, including when the track has no proved area. This evidence-
triggered verification is separate from routine implementation review. Report
its verdict separately from a routine `NOT REQUIRED` result. A **REJECTED**,
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

A multi-track boundary adds one empty marker commit after required machine
gates and the track packet are complete and all blocking user notes are
resolved. When track acceptance is mandatory, the marker also waits for that
acceptance and every requested fix:

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

A change approved under an earlier workflow finishes under its recorded
workflow. New work uses the focus-area workflow. Historical records may name
earlier gates only to identify the governing rule set.

## Layering richer workflows on top

A project may add doctrine through `doctrineExtraPath`. Added rules may enrich
planning, peer review, or delivery. A layered peer review supplements machine
review and user acceptance. It never replaces either. Complete or obtain a user
waiver for every pending layered review before a draft pull request becomes
ready for review.

Added rules may not replace confirmation, design and validation gates,
proved-focus coverage, fresh machine review, required track acceptance, marker
authority, blocking final acceptance, or draft-pull-request safeguards.
