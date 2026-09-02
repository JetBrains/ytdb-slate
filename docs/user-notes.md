# User notes, track packets and user-facing registers

This document governs the user surfaces after the user validates the design.
A **user note** is one piece of user feedback on a delivered track packet.
An **observation** is a worker evidence file and never user feedback.

The orchestrator reads this document at packet time for a MEDIUM or LARGE
track. It also reads it at the first recorded user note, at a drain with a
non-empty note queue, and at the first owner triage.

## Track packets

Every completed track reaches the user in a track packet. Every grade shares
these six fields:

1. the track intent.
2. a file table with added and removed line counts for each changed file.
3. when an approved high-level design exists, its differences since the last
   presentation or a statement that no difference exists. When no approved
   high-level design exists, state that this field does not apply.
4. the verification results: the mechanical checklist outcome when the fast
   path applies, and evidence from the required tests and checks.
5. the cumulative implementation commit reference, as defined in
   [track-workflow.md](track-workflow.md) § Lifecycle and phases, with the
   pull-request link when draft-pull-request publishing is enabled. Otherwise,
   it states that no pull request exists.
6. the places where the user's judgment matters. For each requested decision,
   state every option and its consequence. State that no decision is requested
   when none exists.

The track packet references the diff and never inlines it. It states where to
find the diff. The user may ask for any part of it.

At MEDIUM and LARGE, the user must accept each track and every requested fix
before the marker lands or the next track starts. The marker certifies that
machine review and required user review completed. At SMALL, a multi-track
packet reports progress without adding a blocking acceptance gate. In a
single-track change, the track review and final change acceptance are one
event. Final change acceptance is blocking at every size grade.

The SMALL grade-specific fields belong to
[track-workflow.md](track-workflow.md) § Track packet shape. This document does
not duplicate that shape.

### MEDIUM and LARGE packet

A MEDIUM or LARGE track packet adds these eight grade-specific fields to the
six common fields above:

1. **Grade and rationale.** The confirmed size grade and the reason for it.
2. **Commit range.** The range that contains the track.
3. **Machine review outcome.** Finding counts by type, severity and
   disposition.
4. **Override log delta.** Override log entries created for this track.
5. **Follow-up ledger delta.** New follow-up ledger entries and the running
   ledger count. The track packet never repeats the accumulated ledger.
6. **Live register sizes.** The current size of every live register except the
   coverage register. A register that does not exist is omitted.
7. **Focus set changes.** Every focus area added after the implementer's
   declaration, the halt outcome, and the gates re-run because of the change.
8. **Escalations.** Every escalation raised for the track and its recorded
   disposition.

Every MEDIUM or LARGE track packet reports the current size of each live
register subject to field six. A SMALL track packet adds no register-size
field. Register growth has no numeric escalation threshold. The orchestrator
escalates when growth widens the gate set for the change or a remaining track,
or when the user asks.

## Receiving and routing a user note

The orchestrator records and acknowledges every user note on receipt. The note
gets a stable identifier. The acknowledgement states all three of these facts:

- the note identifier.
- whether the note is blocking.
- its route.

A note has exactly one initial route:

- **Current track.** The note applies to work still owned by the current track.
- **Follow-up ledger.** The note is deferred as standalone follow-up work.
- **Note queue.** The note awaits the mandatory drain before closing review or,
  when no closing review runs, before final acceptance.

A user note is blocking when the user marks it blocking. A note that requests a
change to work that already landed is blocking by default. Every other note is
non-blocking. The acknowledgement states the reading that applies.

A blocking note stops every new track start. It also stops the track in flight.
The in-flight track finishes only the worker action already running, then stops.
No further commit lands on the rejected foundation.

The orchestrator reports every finished track that depends on the affected
track. The user chooses whether to keep, re-run or revert each dependent track.
That choice is recorded as the disposition of the escalation.

## Note queue and drain

The note queue is created by the first note routed to it. The orchestrator
drains the queue before the closing review. When no closing review runs, the
orchestrator drains it before final acceptance.

An empty drain is a no-op. The orchestrator records one line that the queue was
empty. It performs no deduplication, location re-check or conflict detection.

For a non-empty drain, the orchestrator performs all of these operations:

- reconcile the queued notes with their acknowledgement records.
- deduplicate the queued notes while retaining every contributing identifier.
- re-check each recorded location against the current work before applying or
  routing the note.
- compare every remaining pair of queued notes for conflict.
- resolve each non-conflicting note through the current track or follow-up
  ledger, then record its disposition.
- escalate every conflict that remains undecidable.
- reconcile the result with every acknowledgement and record whether the queue
  is empty.

A plain location is not a content anchor. Every report of a resolved location
states any residual uncertainty about an in-place rewrite.

Two user notes conflict when their recorded locations overlap and their
requested outcomes cannot both hold. When the orchestrator cannot decide that
condition, it escalates. The user may choose one note, defer one note to the
follow-up ledger, or ask for a rewrite of a note.

### Repeated drain cycles

The orchestrator reports every repeated post-drain cycle. On the second repeat,
the orchestrator stops the ordinary cycle and escalates. The user chooses one
of these options:

- continue the drain cycle.
- defer the remaining notes to the follow-up ledger.
- stop.

## Follow-up ledger

The follow-up ledger is the single register for suggestions and deferred work.
It replaces any separate Suggestions section in the research log. The ledger is
created when the first finding, user note, or scope exception is ledgered.
[track-workflow.md](track-workflow.md) § Confirmation gate defines a scope
exception.

Every ledger entry uses the register shape in § Register entry shape. Its
statement is self-contained. It states what the finding or deferred work is,
where it applies, why it matters, and what a fix needs. The entry must remain
readable without the review that produced it.

Each MEDIUM or LARGE packet carries only the entries created since the
previous packet and the running ledger count. The final report carries the
complete ledger. The delivery record carries a one-line index of every ledger
entry. The index gives the identifier, location and one-line summary.

A defect protected by the safety floor in
[review-rules.md](review-rules.md) does not enter the ledger on severity
grounds alone. A protected pre-existing defect enters the
ledger only when the user selects the ledger option at its mandatory
escalation. An unanswered protected escalation never reaches the ledger.

## Override log

The override log is created when its first event occurs. Exactly these events
enter it:

- every user waiver.
- every override that changes the disposition category.
- every user grant of an extra stuck-fix consultation.

Each event uses the register shape below. Its statement records the proposed
value, the resulting value and the reason when those values apply. Only the
user may waive a finding. An absent override log is reported in one line at
delivery and is never created as an empty register.

## Register entry shape

Every follow-up ledger or override log entry has at least these five fields:

| field | required content |
| --- | --- |
| identifier | a stable identifier unique within the change |
| date | the date of the entry |
| location | the affected file, symbol, phase, track, or the whole change |
| statement | the self-contained fact, decision or work item |
| status | its current recorded disposition |

The location field accepts a non-file value. A phase or the whole change is a
valid location.

## Mandatory escalation set

This section is the single normative home of the mandatory escalation set.
Every escalation records its event, when it was raised, the options presented,
and the user's disposition.

| event | timing | available options |
| --- | --- | --- |
| A fix round resolves nothing. | At the end of that round. | Redesign, waive, split. |
| The two-round fix cap is exhausted. | At the end of round two. | Redesign, waive, split. |
| A second regression is filed on one finding. | When the gate thread reports it. | Redesign, waive, accept the regression. |
| A blocker is proposed for lowering. | Before the lowering takes effect. | Confirm the lowering, keep the blocker. |
| A protected pre-existing defect is found. | At once, then again in every later packet until disposition. | Fix, waive, ledger. |
| The orchestrator disputes a design-flawed stuck-fix verdict. | When the verdict arrives. | Accept the amendment, override with a reason. |
| The stuck-fix budget is exhausted and another consultation is wanted. | When the second consultation is requested. | Grant another consultation, stop consulting. |
| A user note conflict is undecidable. | During the drain that finds it. | Choose one note, defer one to the ledger, ask for a rewrite. |
| A second repeated drain cycle occurs. | At the second repeat. | Continue, defer the rest to the ledger, stop. |
| The closing-review fix budget is exhausted. | At the end of the last permitted round. | Waive the remainder, extend the budget, split the range. |
| Register growth widens a gate set. | In the packet that reports the growth. | Accept the wider set, re-scope the change, stop. |
| Finished tracks depend on a track affected by a blocking user note. | With the report of those tracks. | Keep them, re-run them, revert them. |
| A focus declaration is still missing after two attempts. | At the second failed attempt. | Use a fresh implementer thread, re-run the track, accept a user-supplied declaration. |

No silence supplies a disposition. Every escalation remains open until the user
selects an option. The final accounting includes every escalation and its
recorded disposition.

## User note accounting

The orchestrator maintains acknowledgement records and note records throughout
the change. Accounting reconciles every acknowledged identifier with its route,
blocking reading and final disposition. The queue must be drained before the
change terminates.

A change with no user note records one line that no note arrived. A change with
notes accounts for every note individually. An unanswered note is never treated
as accepted or resolved.

## Final report

A SMALL single-track change reports through its packet plus the delivery line.
A MEDIUM single-track change puts its report in a section of the delivery commit
body. A larger change produces a separate final report.

The final report provides full accounting for:

- every finding and its disposition.
- every user note, acknowledgement, route, blocking reading and disposition.
- every follow-up ledger entry.
- every override log entry.
- every escalation and its disposition.
- the final size of every live register except the coverage register.

The report includes one line that concludes whether the coverage invariant was
met.

The coverage register stays in the research log. Neither its entries nor its
size enter a packet or the final report. The detailed register never leaves the
research log. The one-line coverage conclusion is the only coverage-register
result that leaves it.
