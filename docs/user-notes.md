# User notes and user-facing registers

This document governs user feedback and its durable accounting after the user
validates the design. A **user note** is one piece of user feedback on a
delivered track package. An **observation** is a worker evidence file and never
user feedback.

[delivery-packages.md](delivery-packages.md) owns the short user-facing package
format. Other workflow documents may call a track package a **track packet** and
a change package a **final report**. Those terms do not change the feedback or
accounting rules in this document.

The orchestrator reads this document at every track-package boundary. It also
reads it at the first recorded user note, at a drain with a non-empty note
queue, and at the first owner triage. Reading the package-format document does
not satisfy these triggers.

## Package acceptance and note timing

Every completed track reaches the user through the track package defined in
[delivery-packages.md](delivery-packages.md) § Track package. The research log
keeps the full working evidence. The delivery record keeps the required durable
accounting. The package references that record and the diff.

The track package states which acceptance rule applies. User acceptance of a
track is blocking when that track proves at least one DESIGN-TRIGGERING area.
Where a marker applies, it waits for required track acceptance and every
requested fix. A track with only REVIEWER-ONLY areas, or no proved area, has
no mandatory track-acceptance gate. Its package reports progress and every
requested decision. Without mandatory track acceptance, an
applicable marker waits for completed machine gates, the package, and resolved
blocking user notes. In a single-track change, any blocking track acceptance
and final change acceptance are one event. Final change acceptance is always
blocking.


## Receiving and routing a user note

The orchestrator records and acknowledges every user note on receipt. The note
gets a stable identifier. The acknowledgement states all three of these facts:

- the note identifier.
- whether the note is blocking.
- its route.

A note has exactly one initial route:

- **Current track.** The note applies to work still owned by the current track.
- **Tracked issue.** The note is deferred as standalone work in the project
  issue tracker. A project with no issue tracker records it in the delivery
  record.
- **Note queue.** The note awaits the mandatory drain before final acceptance.

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
drains the queue before final acceptance.

An empty drain is a no-op. The orchestrator records one line that the queue was
empty. It performs no deduplication, location re-check or conflict detection.

For a non-empty drain, the orchestrator performs all of these operations:

- reconcile the queued notes with their acknowledgement records.
- deduplicate the queued notes while retaining every contributing identifier.
- re-check each recorded location against the current work before applying or
  routing the note.
- compare every remaining pair of queued notes for conflict.
- resolve each non-conflicting note through the current track or a tracked issue,
  then record its disposition.
- escalate every conflict that remains undecidable.
- reconcile the result with every acknowledgement and record whether the queue
  is empty.

A plain location is not a content anchor. Every report of a resolved location
states any residual uncertainty about an in-place rewrite.

Two user notes conflict when their recorded locations overlap and their
requested outcomes cannot both hold. When the orchestrator cannot decide that
condition, it escalates. The user may choose one note, defer one note to a tracked issue, or ask for a rewrite of a note.

### Repeated drain cycles

The orchestrator reports every repeated post-drain cycle. On the second repeat,
the orchestrator stops the ordinary cycle and escalates. The user chooses one
of these options:

- continue the drain cycle.
- defer the remaining notes to tracked issues.
- stop.

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

Every override log entry has at least these five fields:

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
| A fix round lands no fix. | At the end of that round. | Redesign, waive, split. |
| The two-round fix cap is exhausted with the same approved requirement still incomplete. | At the end of round two, before any further repair. | Correct or approve the investigation scope, then approve or reject the holistic solution separately. Redesign, waive, or split remain available. |
| The two-round fix cap is exhausted for another case. | At the end of round two. | Redesign, waive, split. |
| A second regression is filed on one finding. | When the gate thread reports it. | Redesign, waive, accept the regression. |
| A blocker is proposed for lowering. | Before the lowering takes effect. | Confirm the lowering, keep the blocker. |
| A pre-existing defect is found. | At once, then again in every later packet until disposition. | Fix, waive, create a tracked issue. |
| The orchestrator disputes a design-flawed stuck-fix verdict. | When the verdict arrives. | Accept the amendment, override with a reason. |
| The stuck-fix budget is exhausted and another consultation is wanted. | When the second consultation is requested. | Grant another consultation, stop consulting. |
| A user note conflict is undecidable. | During the drain that finds it. | Choose one note, defer one to a tracked issue, ask for a rewrite. |
| A second repeated drain cycle occurs. | At the second repeat. | Continue, defer the rest to tracked issues, stop. |
| Finished tracks depend on a track affected by a blocking user note. | With the report of those tracks. | Keep them, re-run them, revert them. |

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

## Durable final accounting

A single-track change uses the combined package defined in
[delivery-packages.md](delivery-packages.md) § Single-track combined package. A
multi-track change uses the separate change package defined in that document.
Package preparation does not delay or replace the feedback triggers above.

Before final acceptance, the current research log and its read-only source
chain provide full accounting for the current work. The transfer defined in
[delivery-packages.md](delivery-packages.md) § Durable accounting follows the
reachable record lifecycle. Draft publishing copies the required conclusions to
the pull-request description before each package. Without draft publishing,
intermediate and final-acceptance packages use the current research log and
its source chain as the accounting source. After final acceptance, commit
creation copies the required conclusions into the final squashed commit body.
Cleanup waits for verification of that body. The accounting covers:

- every finding and its disposition.
- every user note, acknowledgement, route, blocking reading and disposition.
- a one-line index of every ignored finding.
- every tracked issue created for deferred work.
- every override log entry.
- every escalation and its disposition.

The delivery record carries a one-line index of every ignored finding. Each
entry carries the identifier, location and one-line summary.

The durable record gives routine implementation review and user-requested-fix
verification as separate verdicts. The routine line concludes whether the full
required reviewer set covered the range. It states `NOT REQUIRED` when the
track has neither a proved area nor a size-triggered Reviewer I. It does not
claim Reviewer I coverage for that track. When a user-requested-fix range
exists, another line gives its dedicated gate verdict.

The coverage register stays in the research log. Neither its entries nor its
size enter a user-facing package. The detailed register never leaves the
research log. Its one-line coverage conclusion enters the durable delivery
record.
