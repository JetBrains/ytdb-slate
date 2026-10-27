# Track-based development workflow

This document is the lifecycle spine for every repository change. Proved focus
areas select design and review gates.

| actor | action | document | exact section |
| --- | --- | --- | --- |
| orchestrator | every change | this document | § Lifecycle and phases |
| orchestrator | focus planning | [blast-radius.md](blast-radius.md) | § Focus states and track constraints |
| implementer | every track | this document | § Track intention block and implementer response |
| reviewer | every review | [review-rules.md](review-rules.md) | § Reviewer sets, merge rule and charters |
| orchestrator | track or change package | [delivery-packages.md](delivery-packages.md) | § Package preparation |
| user | feedback and note accounting | [user-notes.md](user-notes.md) | § Receiving and routing a user note |
| publisher | draft pull request enabled | [pr-publishing.md](pr-publishing.md) | § One draft pull request |

## Lifecycle and phases

The mandatory phases run in this order:

1. research.
2. assess and record all eleven risk lines.
3. design and validate for a multi-track change, a proved DESIGN-TRIGGERING area, or a per-track estimate above 100 counted lines.
4. when a design exists, reconfirm the focus list against the validated design.
5. when a design exists, run one adversarial design review for each proved
   DESIGN-TRIGGERING area that has not reviewed the applicable design.
6. when a design exists, obtain final design approval.
7. run the track loop.
8. obtain blocking final acceptance.
9. deliver.

The track loop
presents the approved high-level design when required, plans and judges the
track's independent risk record, implements, validates, compares the committed
difference with the proved areas, reviews, and fixes. It then presents any
changed high-level design when required and delivers the track package. It applies and commits required user-review
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
after it. Omit the before phase only when approval state covers the track design.
Approval state is the last approved version plus recorded changes that need no approval.
Presentation alone grants no approval. Omit the after phase when implementation
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
The orchestrator selects required reviews and reuses applicable unchanged design reviews
without asking approval of the review count.
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
[pr-publishing.md](pr-publishing.md) § One draft pull request.
Its § Creation sets the draft timing. When publishing is disabled, create no pull request.
The retained research log is the durable workflow record.

## Track size and split

<!-- track-size-policy:begin -->
About 400 added plus removed lines per track is a planning guideline, not a hard
limit or a completion gate. Lockfiles, migration files, and generated output do
not count. The orchestrator estimates each track separately and chooses the
split without approval.
An estimate above 100 counted lines requires a high-level design before
implementation, including for a documentation-only track. Counted lines are
added plus removed lines, excluding lockfiles, migration files, and generated
output. The implementer reports an approximate track size in its response and
implementer report. Neither role needs an exact line counter, a token estimate,
or a total-input measurement. When the orchestrator estimates at most 100 but
the implementer reports above 100, do not require a design after the fact.
Reviewer I still runs when the track is not documentation-only. Use the larger
size to estimate remaining tracks.

Plan each code track as one coherent review unit inside a level.
A code track implements bounded approved work, including document changes.
A level contains the sibling tracks created by one split.
Levels group planning only. The change is the merge unit.
All checks pass at each child marker.
At change end, documents, prompt guidance, and the extension must agree.
Intermediate packages and review intentions list each remaining difference and its later owning track.
Do not merge an incomplete change.
Aim for a coherent boundary close to 400 counted changed lines.
If the nearest coherent unit needs a small overrun,
finish that unit and report the reason. Size never permits dropping an approved
requirement, reducing implementation or test quality, or declaring partial work
complete.

When an implementer approaches the guideline, the implementer stops adding
scope and finishes at the nearest coherent point. The response reports completed
work, remaining work, and a proposed track split. It also reports the reason for
a small overrun. If the remaining approved work cannot fit in the coherent unit,
the orchestrator chooses the additional tracks without split approval.
Announce each added track and its reason, then complete its applicable gates.
The announcement authorizes neither a scope exception nor a changed design.
<!-- track-size-policy:end -->

## Recursive planning and loading

<!-- recursive-planning-policy:begin -->
A design track plans and completes a nested change.
A multi-track change requires a high-level design.
An estimate above 100 counted lines and a proved DESIGN-TRIGGERING area remain
separate design triggers.
A required high-level design alone does not create a design track.
Expand a design track when work reaches it.
Each subtree root receives its own high-level design and independent risk assessment.
A subtree contains a node and its descendant tracks.
Design-track designs have no size cap.
Each design track completes the gates of a nested multi-track change.
Each code track keeps its independent gates.
Reuse applicable evidence only under § Confirmation gate's user-decision reuse rule.

An ordinary split creates at most five direct child tracks.
An ordinary plan that needs more than five direct children must add a design track.
Load [recursive-workflow.md](recursive-workflow.md) for that design track.
An implementer-requested split may add siblings beyond five to the same level.
The exception does not automatically create another level.
Obtain each new track's required approvals before implementation.
The exception changes neither review requirements nor repair budgets.
Track numbers remain stable and are never reused.

Every change reads [change-records.md](change-records.md) § Identifiers, code ranges, and design markers and § Manual records and safe writes.
Load [recursive-workflow.md](recursive-workflow.md) when the current or proposed plan contains a design track or review-fix child track.
A review-fix child track repairs outstanding work under a user-approved split.
Check the loading condition during planning and again during resume reconciliation.
Load the document before proposing a review-fix split.
Read the applicable sections before relying on their rules.
A lazy plan needs no total descendant count to apply the condition.
A small tree with a design track still loads the whole document.
A change with neither triggering track type reads only the named common sections.
For nested work, use [recursive-workflow.md](recursive-workflow.md) § Dependency order and pauses.

The approved plan supplies specific evidence for proportional process.
A design track or review-fix child track triggers the manual status file.
Entering a design track triggers its research log and nested gates.
An ordinary code track or a high-level design alone triggers neither extra record.
Standalone designs and maps use the artifact exceptions in [design-principles.md](design-principles.md) P11.
Questions follow unresolved decisions rather than record or track counts.
[recursive-workflow.md](recursive-workflow.md) owns the nested planning relations.
<!-- recursive-planning-policy:end -->

## Focus classes and gates

DESIGN-TRIGGERING areas are data loss, concurrency defect, security weakness,
performance degradation, and non-local logic defect. REVIEWER-ONLY areas are
test-quality defect, unreadable user-facing prose, licensing exposure, consumer
contract break, governing-rule defect, and unreported failure.

Only a proved area adds a focus-dependent gate or area reviewer. Every proved
area adds its specialist. A track with at least one proved area gets exactly one
Reviewer I in a separate thread, including on documentation-only work. An
implementer's approximate size above 100 counted lines also requires Reviewer I
unless the track is documentation-only. With neither trigger, routine
implementation review is `NOT REQUIRED`. Size alone adds no area reviewer,
adversarial design reviewer, or blocking track acceptance. A proved
DESIGN-TRIGGERING area also requires a high-level design, user validation,
focus reconfirmation, its own adversarial design reviewer, and final design
approval. A track with no proved area also has no area reviewer.

Acceptance follows § Delivery and termination.

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

For implementation of a track with no proved area, the orchestrator selects a
logical model under the ordinary action guidance. The orchestrator considers
action fit, capability, cost, guidance, and cautions. The selection uses no
sourced-tier threshold, highest-tier fallback, or mandatory user-choice gate.
The ordinary logical-model membership, fixed effort, and dispatch restrictions
still apply.

[blast-radius.md](blast-radius.md) defines each area and owns the canonical
copy of this table.

## Confirmation gate

In multi-track changes, use "Track <number> <title> (<position> of <count>)" for pre-track checks, plans, track packages, and acceptance requests.
Number is the identifier (canonical path number).
Position is execution order at that level, not the identifier.
Count is the current planned track count there.
After a split, reorder, or drop, update both next time.
Review-fix children use the affected track's identifier and position.

Follow [review-rules.md](review-rules.md) § Findings and output for severity, required fixes,
minor dispositions, and moot or rejected findings in both review phases.

Five cases require a user decision: a waiver, a scope exception, a pre-existing
defect, lowering a blocker, and an implementation-level finding without a recommended fix.
A design-level finding that adds goals or non-goals requires approval.
A fix that changes an approved guarantee, assumption, or reasoning requires design-update approval.
Record every design-level change in the design update or track package.
Automatic repair never bypasses halt rules, user notes, checks, gates, or acceptance.

The orchestrator obtains solution approval before implementation.
Without a required high-level design, present a short plan for approval of behavior,
scope, and necessary user choices. Keep the split, routine gates, and log location
internal unless a decision needs them.
It records an independent eleven-line risk record for the change. Each line is NAMED with a four-part proof or states
which trigger part answers no. The orchestrator judges each proof internally.
The user judges the proposed solution. No file-modifying dispatch starts before
solution approval and every required pre-implementation gate.

When an approved high-level design exists, a **scope exception** is a design
proposal, reviewer finding, or implemented change that covers something the
approved goals do not list. A proposal to remove an approved goal is also a
scope exception. Lead each request with one recommended outcome and its reason.
List the other allowed outcomes and their consequences.
The user chooses exactly one outcome:

1. add a goal.
2. approve a non-goal and require the work reverted.
3. approve a non-goal and keep the work, with the reason recorded.
4. defer the item to a later change and create a tracked issue. When the project
   has no issue tracker, record the deferral in the owning research log.
   Disclose relevant concerns in the user package.
5. approve the removal of a goal, with the reason recorded.

The orchestrator also proposes the simplest solution. This duty applies when an approved high-level design exists, because the approved goals live in that design. When a planned or implemented solution reaches something the approved goals do not list, the orchestrator proposes one of two repairs. The first repair simplifies the solution until it fits the approved goals. The second repair adds the missing goals.

The orchestrator presents that proposal together with the scope exception. The first repair leads to the second outcome above. The second repair leads to the first outcome above. The five outcomes above remain the user decision set.

Repeated regressions on one item make the orchestrator propose that item as a
non-goal candidate. The orchestrator marks nothing automatically. Every
non-goal needs user approval. The fourth outcome appears as a tracked issue.
When the project has no issue tracker, record the deferral in the owning research log. A scope exception from an
already-implemented change also follows
[blast-radius.md](blast-radius.md) § Halt and focus re-derivation. The
scope-exception outcome composes with that route and does not replace it. The
route still re-derives the focus set. When no approved high-level design exists,
the scope-exception rule does not apply. The same halt and focus re-derivation
route governs instead.

Present each design, plan, and implementation explanation fully once.
Apply this rule to a baseline map when one is supplied.
For later presentations, compare with the last shown version, else the last
approved or accepted version. Keep those versions distinct from internal revisions.
Retain the comparison versions in the state summary across handoffs.
Show only changes. If unchanged, give one short no-change sentence.
Neither presentation nor a no-change statement grants approval.
Give a full recap on request. Each question names the earlier content and gives
the context needed for that decision. Explain a needed workflow artifact at its
first use in each session. Keep no explanation-history register across handoffs.
Put all open decisions in one section with separate choices for each decision.

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

<!-- user-decision-reuse:begin -->
Before asking the user for information or a decision, the orchestrator assesses
applicable evidence and prior explicit user answers. Use a fact that applicable
evidence or a prior answer already establishes. Do not ask the user for that fact
again while its source remains applicable. Evidence can establish facts. It
cannot grant user authorization.

A prior answer applies only when all of these conditions hold:

1. The answer covers the current fact or decision and the relevant part of its
   scope.
2. Its stated and implied conditions remain current. New evidence does not
   materially change the available choices or their consequences.
3. Every required prerequisite was complete when the user gave the answer.
   Prerequisites include any investigation or review that must precede the
   decision.

A clear correction supersedes the earlier answer for the part it corrects. Two
answers that conflict without a clear correction leave that part unresolved.
Reuse every covered part and ask only for the unresolved remainder. A material
change alters a choice, scope, condition, or consequence. Reopen only the part
that the material change affects, and explain that change before asking again.

Reassess evidence and answer applicability at every existing reassessment
boundary. These boundaries include new-track planning, focus reconfirmation,
and resume reconciliation. Reassessment is mandatory, but it does not require
a repeated question when the prior answer still applies. It also does not grant
automatic approval for a changed decision.

This rule governs every workflow instruction to ask the user. A more specific
ask instruction sets timing or content. It does not require a question about a
fact or decision that this rule already settles.

Batch independent questions when one request reduces user effort. Do not move a
question before an investigation or review that it depends on. Record the
source answer and its applicable scope in the existing workflow record.
Independent change and track risk records remain separate assessments, but they
may cite shared evidence. Reuse never removes a required review,
changes decision authority, or turns planning approval into track or final
acceptance. Final change acceptance remains a separate blocking decision.
<!-- user-decision-reuse:end -->

<!-- requirement-investigation-workflow:begin -->
After two failed ordinary fix rounds leave the same approved requirement incomplete,
stop repair dispatch before another repair.
Count failed rounds across the affected code track and all its review-fix children.
A split never resets that requirement count.
After a completed investigation, two further failed ordinary rounds trigger it again.
Complete a triggered investigation and obtain solution approval before starting a child.
The requirement is the exact
user-approved requirement named in the track intention or design approval
record. If those records name different requirements, ask the user to identify
the requirement before counting rounds. Do not choose between them or treat a
broad track intention as one requirement. A new finding identifier does not
create a new requirement or reset the two-round count. Start a bounded read-only
investigation within the approved requirement. Cover relevant lifecycle stages,
dependencies, unchanged code, actual consumers, and the durable or observable
boundary where the requirement is judged. Ask before wider access or higher cost.

Record the trigger, investigation scope, access or cost decisions, findings,
evidence, limits, holistic solution, verification plan, and decision as typed
entries in the affected code track's owning research log.
Use [change-records.md](change-records.md) § Manual records and safe writes for record ownership.
The investigation must distinguish a symptom
repair from closure of the full approved requirement. After investigation,
present a holistic solution for the full requirement and wait for a separate
user approval before implementation resumes. Existing repair caps, the
stuck-fix consultation and its budget, reviewer input restrictions, focus gates,
required reviews, and verification remain unchanged. This route adds no repair
round, resets no cap, creates no new reviewer or separate artifact beyond the
existing change research-log record, narrows no requirement, and does not require
verbatim retention of every tool result.
<!-- requirement-investigation-workflow:end -->

Before each track implementation, assess whether the approved design and
completed design gates cover the track's proved areas and planned behavior. A
new track created after the original confirmation gate needs an independent
orchestrator assessment and risk record before implementation starts. If
that planning
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
For a multi-track change, handoff is mandatory at the start of each design track.
Handoff is mandatory before each code track's implementation.
A design track plans a nested change before implementation.
The design-track boundary precedes research, expansion, and design work.
The code-track boundary follows all required planning and pre-implementation gates.
These include confirmation, scope-exception decisions, applicable design gates, and enabled draft creation.
Save subtree detail in the active subtree log first.
Save the state summary in the root `research-log.md` last as a typed `handoff` entry.
The summary names the subtree entry it relies on.
For a review-fix subtree, use the affected code track's existing records.
When no subtree log exists, save the summary in the root log alone.

Complete the prior ordinary track package and required acceptance before the next ordinary track boundary, except for a recorded permitted dependency pause.
A subtree under that pause does not block the named unfinished sibling dependency's boundary until the recorded resume condition holds.
Use [recursive-workflow.md](recursive-workflow.md) § Dependency order and pauses for the pause conditions.
The paused subtree's package and acceptance stay pending and still block its own completion.
Complete requested fixes and blocking acceptance before the marker, state save, and handoff.
Save the prior package's assessment of effects on upcoming tracks.
Single-track changes are exempt. If one later splits, accept its initial package and fixes before the marker, save, and first handoff, before the next track.

The successor performs Resume reconciliation, then a short pre-track check of the design or intention.
Use reconciled records and the prior package's assessment, or completed planning records for the first track.
Settle facts and applicable answers before asking unresolved questions.
Record the track, design or intention version, source state, decisions, and gates.
Reuse the check while those inputs apply, even after another handoff.
New evidence reopens only the affected part.
A meaningful design or intention change requires its decisions and gates, revised records, then a second handoff before implementation.
Finishing a required gate, confirming an answer, or rewording unchanged meaning adds no handoff.
Further substantive changes follow the same rule.

At a mandatory boundary request `/slate handoff --track-boundary`. After a post-check change use `--post-check`.
Details: [safety-and-trust.md](safety-and-trust.md) § Fresh-session entry.
Pause dispatch until actual transfer. Record each purpose and completion separately.
Reuse completed boundary transfers on resume.
Cancellation, failure, and `/slate resume` do not satisfy the boundary.
There is no same-session substitute. The command grants no acceptance.
Same-track fix rounds and review-fix children add no boundary or acceptance.
Budget and user-requested handoffs keep their purposes.
This workflow rule has no automated runtime enforcement.
<!-- multi-track-handoff:end -->

## Risk planning and reconciliation

The orchestrator judges each focus area for the whole planned track, not for
each file. It writes all eleven risk-record lines. A NAMED line carries the
four-part proof defined in [blast-radius.md](blast-radius.md) § Judged proof
and risk record. Each other line states which trigger part answers no.
The orchestrator judges each proof. A sufficient proof makes the area proved.
An insufficient proof makes it SKIPPED. A SKIPPED area adds no gate or reviewer.

The proof basis is the approved track design. When the track has no design, the
basis is the track intention block and planned file list. When a design exists,
the user validates it before the orchestrator reconfirms all eleven lines against
that design. The orchestrator records every addition and removal with its proof
or failed trigger part. Reconfirmation precedes one adversarial design review
for each proved DESIGN-TRIGGERING area. Final design
approval follows those reviews. The design stage is the only stage where an
adversarial reviewer receives the risk record and area proofs as
separate inputs. Implementation reviewers and both repair gates receive neither.
The stuck-fix consultation follows the whole-episode exception in
[review-rules.md](review-rules.md) and receives no separately supplied risk
record or area proof.

Before code review, the orchestrator compares the committed difference with the
proved set. A missed area follows the late-area route below. For an area that no
longer engages, the orchestrator records the failed trigger part and removes it.
Removal never silently waives a separate required gate. Keep every reviewer
that already covered completed work. The owning research log reports every
addition, removal, SKIPPED state, user direction, and reviewer-coverage decision. A package puts any unresolved
requested decision or relevant risk under **Needs attention**.

When the orchestrator or implementer discovers a late area, the orchestrator
judges and records its four-part proof at once. A sufficient proof recomputes the
complete required routine reviewer set. If Reviewer I has not covered the range,
dispatch Reviewer I and the new area specialist. If Reviewer I already ran
because of size or another proved area, dispatch only the new area specialist.
Do not dispatch Reviewer I again. A newly proved
DESIGN-TRIGGERING area also enters or re-enters the design sequence for
remaining affected work unless the user records a decision to skip that gate.
Present any necessary new, revised, or materially clarified design before
continuing that work. Reuse unchanged approved design and completed applicable
gates, but run the newly required area-specific design review. Completed work
receives no retrospective design gate. Every newly required routine reviewer
perspective reviews the completed range, even when another perspective already
covered it. When no work remains, record the design-gate skip, complete that
review, and present the record at final acceptance.

The implementer reports any risk that the plan did not name. The orchestrator
writes and judges its proof through the same late-area route. An implementation
reviewer receives no proof. The user may request the risk record or direct an
area addition or removal. Honor that direction and record its gate effects.
Do not routinely present the assessment or advertise this option.

## Track intention block and implementer response

Every implementation and review dispatch carries these fields:

- target.
- scope boundary.
- deferred work.
- acceptance condition.
- declared file list.

Every implementation dispatch carries this focused current-context block:

> Name the exact retained research-log path `slate-changes/<change>/research-log.md` and implementer-report path `slate-changes/<change>/track-<number>-implementer-report.md`. Use supplied references and excerpts. Read further history only for unresolved relevant questions.

Name the current standalone approved design, if any, task, acceptance condition, assigned findings with compact fix evidence, affected files, relevant decisions and unresolved questions.
Give implementers and fixers section references or bounded excerpts, never a required whole-log read.
Identify assigned maps as factual context, not requirements.
When a stored baseline exists, obtain its path and source commit from the log and name both.
Use the root baseline for single-track work.
Recorded changes without baselines gain no retrospective requirement.
For map reading depth, use [maps.md](maps.md).
Reviewer input restrictions remain unchanged.
Every implementation dispatch either carries each focus-area trigger with its boundary
sentences or directs the implementer to the risk definitions in
[blast-radius.md](blast-radius.md) § Focus areas and their gates. The implementer
ends its response with an approximate track size in counted lines, followed by
`unplanned risk: none` or one line that names a risk the plan did not name.

Review dispatches follow [review-rules.md](review-rules.md) § Reviewer input
contract. Reviewers receive the approved inputs for their role. Ordinary
repository and library evidence needed for the assigned work remains available.
This permission is not a closed changed-file allowlist.

### Commit titles and bodies

At change start after solution approval, record one title for publication once in the root research log.
Keep it fixed across pull request renames.
Exclude other private bytes, secrets, credentials, and private user data.
Every authored commit for the change on any branch starts its body with the complete line `Change: <change title>`.
Metadata keeps content and adds no body part.
It conveys intent, not acceptance proof or post-merge mapping.
Host-generated target-branch commits are exempt.

Use `Track <n>: <intent title>` for implementation.
Use `Track <n> fix round <r>: <intent title>` for agentic-review fixes.
Use `Track <n> user review fix <r>: <intent title>` for user-review fixes.
Number user-review fixes from 1, increasing by one per commit.
Use [blast-radius.md](blast-radius.md) § Commit discipline for drift and boundaries for content and coverage.

### Implementer reports and execution

For each code track, the implementer creates
`track-<number>-implementer-report.md` in the current change folder when the track
starts. The dispatch gives the exact path. The report is untracked working
material. After a session with a different identifier takes ownership, create
a report in the new change folder. If the source folder has this track's report,
name it as read-only in the new report's first entry. Continue the work in the
new report. The report has four required
sections: changes to the high-level design with the reason for each, the
low-level design, diagrams where they help, and checks run with their results.
The report states the approximate track size in counted lines. Later fix
rounds append to that report in the current change folder.

Tracks are contiguous and execute through one sequential writer. Independent
research and reviews may run in parallel. File-writing implementation does not.
A later track builds on the accepted boundary before it.

## Session handoff and the research log

Start a change with `slate_change start` before the first implementation
dispatch. Slate creates `slate-changes/<change>/research-log.md` without waiting
for a retained trigger. It records the generated folder name and owning Pi
session identifier in saved state. Each code track creates its implementer report
there at track start. Append a retained entry immediately when any trigger
below fires. `slate_change close` clears the current change after delivery or
abandonment. It deletes no files.

- a second non-obvious decision.
- a surprise about repository behaviour.
- a NAMED focus area.
- a session boundary.
- multiple tracks.
- a plan-changing ruling.
- a user request.
- an unresolved question needed later.

Open these sections: Initial request, Decision Log, Surprises and Discoveries,
and Open Questions. Planned changes links standalone designs under [change-records.md](change-records.md).
Add Track table, risk record, coverage
register, override log, and escalation records when needed. Do not use an
observations section. Worker observation files are review evidence, not user
feedback. Naming an area opens the log even when the orchestrator later judges
its proof insufficient. Every retained entry is typed as `decision`, `evidence`,
`ruling`, `risk`, `question`, `focus`, `verification`, or `handoff`. Append an
entry immediately after its event. Keep each entry self-contained.

Do not copy secrets, credentials, private user data, or unnecessary personal
data into the log. Record a privacy exception as a typed ruling. State what was
omitted and why.

Use [change-records.md](change-records.md) § Manual records and safe writes for append-only logs and reports, correction entries, checks and retry inspection.
Slate checks the folder chain when it creates the change.
Keep all manual records and leftover temporary files untracked and visible in repository status.
Do not add them to an ignore file or a pull request.
Exclude their references and contents from reviewer inputs.
Use the common record rules for supplied action folders and temporary-reader exclusions.
Never overwrite a record from a stale in-memory copy. When a session adopts a
change owned by a different Pi session identifier, Slate starts a new folder.
Its log first names the direct source folder as a read-only earlier log. Each
source log's first entry links to its own source. Follow those links to read the
full history. The source remains in place without copying. A resume or reload
with the same identifier continues the current folder. A /tree move to parent
history with a different owner creates a new folder on reload. A handoff makes
the successor the owner of the current folder. If folder allocation fails,
Slate saves no open change and reports the failure. If that save fails, Slate
reports it too. A legacy root `research-log.md` remains read-only. Only the user
deletes a delivered or abandoned change folder.

### Handoff summary

Before a session handoff, use § Confirmation gate's handoff block for record order and the subtree-entry reference.
The root state summary names the proved focus
areas and risk-record location, current track, current implementer
report location, last boundary marker, live registers, open findings, checks
run, next action, and the last shown or fallback approved comparison versions. A
context-budget handoff, user-requested handoff, or session end with unfinished
work triggers this summary.

## Resume order and reconciliation

Resume in this fixed order:

1. Read the initial request and latest state summary.
   Before relying on a summary, check that its named subtree entry exists.
   An older summary without a subtree reference still resumes under its recorded workflow.
2. Read later decisions and the active subtree's records.
   When the summary names an existing current implementer report, read it there.
   Use [recursive-workflow.md](recursive-workflow.md) § Resume and folder forks
   for tree reconciliation and read-only source boundaries.
   Before resuming a paused subtree, read its typed `decision` entry in the owning parent research log.
   Check that its unfinished sibling dependency has completed and its recorded resume condition holds.
   Confirm the decision records a boundary between code-track ranges, with no open range.
   A status entry alone authorizes neither pause nor resume.
3. Inspect marker commits and the current branch state.
4. Reconcile the declared file list, track table, coverage register, proved
   focus areas, risk record, and live diff.
5. Re-run any stale precondition check.
6. Apply the user-decision reuse rule before asking any question.
7. Continue only after answering: **What changed since the last state summary,
   and does it change focus, scope, or required gates?**

A mismatch pauses work. Reconcile it in the log. Use marker commits and Git
history as boundary authority. The track table is display-only.

## Review coverage

Every part of a track range must reach its complete routine implementation
reviewer set. The set contains every specialist for a proved area. It contains
exactly one Reviewer I when an area is proved. Without a proved area, it
contains Reviewer I only when the implementer's approximate size is above 100
counted lines and the track is not documentation-only. Otherwise the set is
empty. User review never replaces required machine review. This
requirement is the coverage invariant. A track with an empty set reports
routine implementation review as `NOT REQUIRED`.

The coverage register records each contiguous range of user-review fix commits
together with the gate verdict for that range. It is the review-accounting
authority for those ranges. At delivery, a live register produces the one-line
coverage conclusion required below.

### Routing recommendations at change completion

When trusted configuration sets `workflow.routingRecommendations` to `true`, the
orchestrator adds model-routing recommendations before final acceptance only
when current-change records support advice. The advice covers only logical models named in
action records for the current change. Use the current-change workflow context
to set that boundary. Do not scan unrelated actions from the full session
history.

Treat the logical-model name as a selection fact. It does not prove which
physical model executed after recovery. State direct observations separately
from tentative inferences. Tie each recommendation to the evidence that supports
it. Keep the advice short and ready to copy.

Recommend changes to existing guidance or cautions first. Recommend another
entry change only when empirical evidence is sufficient for that specific
change. Do not derive broad capability claims from weak evidence. Do not invent
a recommendation when the records support none. Keep a no-advice result only
in the research log. Omit the routing field from the change package.

The advice is advisory. It never authorizes a model selection or roster change.
It never edits configuration, routing, or model files. A user decision and the
ordinary workflow govern any later change.

## Delivery and termination

<!-- delivery-package-loading:begin -->
Immediately before preparing any track package or final change package, read
[delivery-packages.md](delivery-packages.md). Skip the read when that document
is already in context. This is the only workflow stage that loads the document.
Do not read it at session start or during routine planning, implementation, or
review. The document owns package presentation only. Continue to read
[user-notes.md](user-notes.md) at each feedback and note-accounting trigger that
it defines.
<!-- delivery-package-loading:end -->

For design tracks, use [recursive-workflow.md](recursive-workflow.md) § Whole-subtree acceptance.
The following acceptance rules apply to code tracks.

Use [delivery-packages.md](delivery-packages.md) for completion messages.
A single-track change sends one change package without a track name and asks only final acceptance.
Every code track in a multi-track change needs blocking track acceptance, regardless of proved areas.
Where a marker applies, it waits for required track acceptance and every requested fix.
Complete machine gates, the package, and resolved blocking user notes before the marker.
A single-track change asks only final change acceptance.
Final change acceptance is always blocking.

Done means all required reviews and gates passed. For routine implementation
review, the required set is the set in § Review coverage. An empty set reports
`NOT REQUIRED` and requires no invented Reviewer I coverage. No blockers remain.
Every addressed finding at major severity or above is verified. Every major
finding is fixed or has a recorded user waiver. Every finding below major
severity has a recorded disposition of fixed, ignored, moot, or rejected.

The note queue is drained before final acceptance. Every escalation has a
disposition. The coverage
invariant holds. The user accepts the final change.

Each code track contributes its implementation, separate review fixes and
corrections, and a marker in multi-track changes.
For design markers, use [change-records.md](change-records.md)
§ Identifiers, code ranges, and design markers.
Keep the original implementation and each machine-review fix as separate commits.
Gates inspect each fix difference and the combined behavior.
The user reviews the approved high-level design and the implementation together.
Use the two-part Intent and Deviation-delta body in
[blast-radius.md](blast-radius.md) § Commit discipline for drift and boundaries.

### Closed-range corrections

Commit each fix requested during user review separately.
Preserve the exact state the user reviewed. Present each
fix's status in one batch acceptance question. Let the user accept or reject each
fix separately. Keep one commit per fix. When at least one such commit exists, add their
contiguous range to the coverage register. Dispatch one fresh gate thread to
verify that range before adding an applicable marker or before completing
final acceptance for a single-track change.

For a user-review fix range, one dedicated gate thread supplies machine review
for that range, including when the track has no proved area. This evidence-
triggered verification is separate from routine implementation review. Report
its verdict separately from a routine `NOT REQUIRED` result. A **REJECTED**,
**STILL OPEN**, or **REGRESSION** verdict routes each correction through the
existing agentic-review fix title and body form. Repeat this gate on the
corrected range. This correction loop uses the ordinary two-round cap and
escalation rules in
[review-rules.md](review-rules.md) § Fix loop and gate verdicts.

The correction remains a separate commit after the user-review fixes. A track with no user-review fix commit adds neither
this range nor this gate action. Where a marker applies, it comes last because
it defines the track range. Later feedback follows [user-notes.md](user-notes.md).
It does not extend the closed range or automatically belong to the next track.

### Delivery history and accounting

A bootstrap commit created to open a draft pull request uses
`Bootstrap: <intent title>`. It opens publishing before owned implementation
starts and is not part of any track.

Use ordinary branch updates. Do not routinely rewrite history or force-push.
Only a user-chosen privacy rewrite permits rewriting history under the duties below.

Markers follow § Commit titles and bodies.
A multi-track boundary adds one empty marker commit after
required machine gates and the track packet are complete. All blocking user
notes are resolved before the marker. When track acceptance is mandatory, the
marker also waits for that acceptance and every requested fix:

```bash
git commit --allow-empty -m 'Track <path-number> complete: <short name>' -m 'Change: <change title>'
```

<!-- marker-identity-policy:begin -->
A canonical path number identifies a track through its numbered ancestors.
Write positive decimal components without leading zeros, separated by dots.
Use this unpadded template for every change begun under the current workflow.
A flat-workflow change began before this workflow shipped.
It keeps padded `Track NN complete` markers and its recorded range form:
track N is the range after marker N-1 through marker N.
Do not rename those markers or rewrite their history.
Marker commits remain the boundary authority.
For current code ranges and design markers, use
[change-records.md](change-records.md) § Identifiers, code ranges, and design markers.
A single-track change has no marker.
<!-- marker-identity-policy:end -->

<!-- accepted-history-policy:begin -->
Never destroy the exact state the user reviewed.
A later aggregate package cannot authorize rewriting earlier user-reviewed ranges.
Keep the local change branch and accepted-marker branches until root closure.
Use the local branch for delivery verification and resume.
Do not rebase except for a user-chosen privacy rewrite under the duties below.
Use an ordinary merge of a moved base only for conflicts or required checks, between code-track ranges.
That merge belongs to no track and carries the change title under § Commit titles and bodies.

Before a privacy rewrite, keep reviewed and accepted heads reachable on a local branch.
Keep it unchanged until root closure, even on rewrite conflicts.
Log each preserved head and branch in its owning log.
After rewriting, reconcile markers and recorded ranges against preserved evidence.
Keep original marker evidence, not just rewritten titles.
Log the rewritten head separately. Keep the earlier review binding unchanged.
Renew acceptance of the rewritten head before delivery verification.
Pause if those bindings cannot be established.

Missing or contradictory history evidence pauses affected work.
Recover the exact recorded evidence from branches or source records before relying on it.
A status entry, merge result, or copied marker title cannot replace missing history.
Never recreate a marker to claim an unproved boundary.
If recovery fails, ask the user to choose recovery work, abandonment, or an explicit evidence waiver.
The waiver states its limit and claims no recovered evidence.
<!-- accepted-history-policy:end -->

The research-log track table lists names, one-line scopes, and status, not commit identifiers.
Track numbers are append-only and never reused. Strike through abandoned tracks.

With draft publishing, [pr-publishing.md](pr-publishing.md) § After the merge
owns change delivery accounting and root closure.
Without publishing, use all owning accounting sources defined in
[delivery-packages.md](delivery-packages.md) § Durable accounting.
Show references only for decisions. Never claim a future commit exists.
After root final acceptance, finish markers after their required acceptance.
Accepted history is delivery. Acceptance adds no commit or rewrite.
Keep accepted boundary evidence through verification.
Never use target or host references for verification or resume.
Before every change push and delivery in either setting, inspect history, not just the tree, for the private set in [change-records.md](change-records.md) § Design authority and privacy.
Inspect every pushed branch or reference, including recorded workflows.
Newly reachable history is unreachable from any reference on the destination remote.
For local delivery, inspect all history reachable from the delivered branch.
Name every pushed branch or reference explicitly. Forbid untargeted, all-branch, mirror, and matching pushes.
On a match, pause. The user chooses rewrite before publication, explicit waiver, or abandonment.
A waiver states the accepted exposure or evidence limit and grants no unstated publication permission.
Apply the rewrite duties above before delivery verification.
Verify the completed history and owning-log accounting separately before root closure.
This sequence applies to any track count.
Resolve or hand every open question to the user.
Follow [user-notes.md](user-notes.md) for feedback and note accounting.
Close with `slate_change close` after delivery and verified owning-log accounting.
Abandonment at any stage requires `slate_change close`, even without delivery.
Closing deletes nothing. Keep local records untracked under § Session handoff and the research log.
On abandonment, first offer their content for archival. Only the user deletes an old change folder.

No release occurs in this workflow. Packaging, publication, version changes,
tags, and registry release require a separate explicit user request and the
project release runbook.

## Migration

An existing change finishes under its recorded workflow unless the user
explicitly authorizes migration. Keep its recorded marker spelling and publishing
arrangement. Keep existing level pull requests and retained references as evidence.
Never move or delete those references automatically.
A needed stacked rewrite pauses for a user decision.
At closure, report leftover references for the user to delete.
Do not rename markers or rewrite history to resemble a tree.
Every new change uses the current workflow.
For log-content migration, record the exact source line range and full hash.
The standalone design must equal that span, including entry prefixes, without summary or correction.
Log its full hash under [change-records.md](change-records.md) § Manual records and safe writes.
Later corrections need a new user-approved design version.
A new change without design tracks or review-fix children has one level.
It needs no manual status file or design-track research log.
Missing manual tree records do not make an existing session unreadable.
The publishing setting and its disabled default remain unchanged.

## Layering richer workflows on top

A project may add doctrine through `doctrineExtraPath`. Added rules may enrich
planning, peer review, or delivery. A layered peer review supplements machine
review and user acceptance. It never replaces either. Complete or obtain a user
waiver for every pending layered review before a draft pull request becomes
ready for review.

Added rules may not replace confirmation, design and validation gates,
proved-focus coverage, fresh machine review, required track acceptance, the
marker commits as boundary authority, blocking final acceptance, or
draft-pull-request safeguards.
