# Track-based development workflow

The mandatory flow for every change delivered under this workflow:

Research → research log above trivial → design → user review of the
design → adversarial review for complex and risky changes → per-track
loop (implement → track code review when required → fixes → mandatory
user review → marker commit when required) → delivery.

Publishing is conditional on `workflow.draftPRs` in the project's
`slate.json` (default: false). When it is ENABLED, an umbrella draft
PR is created after the applicable pre-implementation gates pass and
before implementation starts — see pr-publishing.md in this directory
for all PR mechanics. When it is DISABLED, the workflow log is the
change's durable record; its lifecycle is defined in § Research log
below. Marker commits work identically in both modes.

## Change classes

Gates key on the change class, not on size:

| Class | Definition |
| --- | --- |
| Trivial | A typo, wording change, mechanical rename, or obvious one-file fix. |
| Medium | A change of known shape that touches more than one file and has no risky invariant. |
| Complex | A change with an unclear shape, several interacting parts, or a live design alternative. |
| Risky | A change that touches concurrency, durability, recovery, transactional semantics, a public API or behavioural change, security, or user data, or that has a silent failure mode. |

The orchestrator proposes the class and the user confirms it. The
proposal states the class, the reason, and the property that would
raise it. The orchestrator re-proposes the class whenever new
information appears. An upgrade to complex or risky re-opens the
design gate and the adversarial gate for the WHOLE change, including
decisions already landed. The class is never lowered after
implementation starts.

Size drives only the track split and marker commits. The orchestrator
owns the track split at every class; it is not a user approval gate.

### Gate matrix

| Gate | Trivial | Medium | Complex | Risky |
| --- | --- | --- | --- | --- |
| High-level design | No | Yes | Yes | Yes |
| Design shown before adversarial review | No | No | Yes | Yes |
| Design shown before implementation | No | Yes | Yes | Yes |
| Adversarial review of the design | No | No | Yes | Yes |
| Research log | No | Yes | Yes | Yes |
| Agent code review of a track | No, when the whole change is wholly trivial | Yes | Yes | Yes |
| User review of the track diff | Yes | Yes | Yes | Yes |

The track split belongs to the orchestrator at every class.

## Research phase (lightweight)

Research is interactive exploration before any implementation: read
real source code, trace call chains, and clarify aims and constraints
with the user. Before the class is settled, no design document,
implementation plan, or mandatory artifact is assumed. The phase ends
when the initial shape and class of the change are understood.

## Research log

A research log is mandatory for every change above trivial. For the
trivial tier, and during research before the class is settled, start
research WITHOUT a log. Open one the moment any trigger below fires,
then backfill the decisions already made — backfilling is cheap while
they are still in context.

| # | Trigger |
| --- | --- |
| 1 | Second non-trivial decision (a choice where a plausible alternative was rejected for a reason). |
| 2 | First surprise — the codebase behaves differently than assumed. |
| 3 | First risky invariant identified — concurrency, durability or recovery, transactional semantics, a public API or behavioral change. |
| 4 | Research will cross a session boundary. |
| 5 | The change is multi-track. |
| 6 | The user requests it. |

The trigger table governs the trivial tier and research before class
confirmation. Once the user confirms a class above trivial, the log is
mandatory whether or not a trigger fired.

The Decision Log remains append-only throughout research and
implementation. It records decisions taken after implementation
starts because the log is the record that survives a context handoff.
At design approval, it records the workflow rule-set version and the
gates already passed.

### Log format

Four sections are opened with the log:

- **Initial request** — verbatim, written once.
- **Decision Log** — append-only. Each entry is at most 4 lines: the
  decision, why, and the alternatives rejected. Each entry MUST be
  self-sufficient in one sentence; optional evidence citations go in
  as deep links.
- **Surprises & Discoveries**
- **Open Questions**

Three more named sections join as the corresponding material appears:

- **Planned changes** — the high-level design, added when the design
  converges; the applicable design-review and adversarial-review
  verdict lines are appended at its end.
- **Suggestions** — one standalone entry per suggestion. Each entry
  states what the suggestion is, where it applies, why it matters,
  and what a fix needs. It MUST be readable without the review that
  produced it.
- **Track table** — added when the orchestrator splits the change into
  tracks (constraints in § Track table). With publishing enabled the
  table also lives in the PR description as pr-publishing.md directs.

### Persistence

During the change the log lives as an untracked file
`research-log.md` at the repo root. The log is RETAINED until delivery
with `workflow.draftPRs` either enabled or disabled. Post-design and
implementation decisions keep appending to its Decision Log.
pr-publishing.md owns how the log content reaches the pull request
description when publishing is enabled.

### Delivery

A change is DELIVERED when its final squashed commit lands on the
repository's default development branch, or when the user explicitly
abandons it. With publishing disabled, the agent folds the log into
the delivery commit's message body — the motivation, the planned
changes, and the applicable verdict lines: the same content that would
have become the PR description — strips the track table (track numbers
are ephemeral branch-life identifiers and would dangle in history),
resolves or explicitly hands any remaining Open Questions to the user,
then deletes the log file. With publishing enabled, pr-publishing.md
owns delivery of the log content. In both modes the retained local log
is deleted only at delivery. On abandonment the agent deletes the log
file after offering its content to the user for archiving.

The delivery commit body carries a one-line index of every suggestion:
identifier, location, and one-line summary. The standalone suggestion
text lives in the final report to the user, or in a tracker issue when
the project enables that prompt.

Aim to keep the final delivery commit body at or below 16,384 UTF-8
bytes, excluding the subject. This is a target, not a gate. Measure
the exact body text as UTF-8 without adding a newline: count the byte
sequence after the subject separator in `git cat-file commit <sha>`.
Do not use a formatted `git log` value such as `%b`, which adds an
output newline. For a proposed commit, apply the same rule to the
exact body text before committing.

If the body is larger, first remove repetition and merge overlapping
material. Then add a `Size exception` paragraph to the delivery commit
body carrying measurements, not assurances: the overrun, by the
canonical method above; every top-level section's byte count by that
same method, largest first; and, for each section that was condensed,
its byte count before condensing. A section with no before-count is
visibly untouched, so the user weighs any claim that nothing could be
removed against the counts beside it, and can refuse the exception. Do
not remove decisions, risks, verdicts, or evidence needed to
understand or review the change only to meet the target. Immediately
before presenting the final delivery commit to the user, measure it by
that method and obtain the user's approval of the body and of any size
exception; repeat both steps if the body changes before it lands.

By this canonical measurement, the most recent accepted delivery body
from the publishing-enabled path was 20,957 bytes, 27.9% above the
target. That precedent establishes only that a justified overrun can
pass in that path. Publishing-enabled descriptions can carry material
that this path does not, so the figure is neither a direct measurement
nor an exercised exception for publishing-disabled delivery.

### Under-trigger guardrail

For a trivial change shaped without a log, state this explicitly (for
example, "no log kept — one trivial decision, no surprises") so the
user can override and request one. This guardrail applies only to the
trivial tier.

## High-level design and user review

A design is required for medium, complex, and risky changes. It is
HIGH-LEVEL only: goal, approach, key decisions, rejected alternatives,
risks, scope boundary, and open questions. Implementation detail
belongs to code review, not to the design.

For complex and risky changes, present the design twice: once before
the adversarial review, and once before implementation. For medium
changes, present it once before implementation. For trivial changes,
there is no design and no consent gate. When the project sets
`writing.check` to true, the design text follows the project's writing
convention.

At each presentation, the orchestrator loops on user feedback and
revises the design and log until the user explicitly approves. For a
complex or risky change, append this verdict line after the first
approval:

```
Design review (pre-adversarial): user-approved — YYYY-MM-DD
```

For every designed change, append this second verdict line after the
approval immediately before implementation:

```
Design review (pre-implementation): user-approved — YYYY-MM-DD
```

The Planned changes section of the retained log is the durable home
for both lines. If adversarial triage changes the design, the second
presentation shows every change before the user gives the
pre-implementation approval.

## Adversarial review of the design

Adversarial review runs only for complex and risky changes. It runs
after the user approves the design for review and before the design's
pre-implementation presentation. The reviewer judges the DESIGN.
Implementation detail and style are out of bounds. The reviewer must
be a fresh context that did not author the decisions.

The adversary attacks the log and its cited evidence. Licensed null
verdict: "no substantive findings" is an acceptable, respected outcome
— the review prompt MUST say so.

### Finding triage

The orchestrator triages every finding itself with one of three
outcomes:

- **Strengthen** — enrich the alternatives-rejected rationale of the
  attacked decision.
- **Reverse** — change the decision now, while it is still cheap.
- **Accept-as-risk** — record it in Open Questions / Risks.

Every reversal and every accepted risk appears in the design that the
user approves before implementation. A design-stage finding is
triaged at design time whatever its severity. The suggestion-deferral
rule of the track loop does not apply to a design-stage finding.

One round runs by default. A second round runs only after a reversal.
Append a verdict line to the log:

```
Adversarial review: passed, N accepted risks — YYYY-MM-DD
```

### Escape hatch during implementation

review-rules.md in this directory defines a separate escape-hatch
adversarial review. It runs during implementation when a fix is stuck.
It is separate from this pre-implementation gate. Its output is
evidence and never a verdict.

## Track loop

A track is one unit in a stacked series: it builds on the tracks
before it, stands alone as an independently reviewable diff, and
carries as much of the change as one reviewable diff holds.

Sizing (soft bounds): a track of ≤~12 in-scope files folds into a
neighbor; >~20–25 in-scope files is a split candidate. Size determines
the split and whether marker commits are needed. It does not determine
the change class or any gate.

The orchestrator owns the track split. No user approval gate applies
to the split.

All development is linear on the single working branch; each track is
a contiguous commit range. Track numbering is append-only: completed
tracks never renumber, a replanned remainder gets new numbers, and
abandoned planned tracks are struck through in the track table — their
numbers are never reused.

Every review dispatch carries a track intention block with four
fields: target, scope boundary, deferred work, and acceptance
condition.

Per-track sequence:

1. Implement the track, following the project's own engineering
   guidelines for commit/test/push discipline. An implementation
   commit body states what had to be implemented, then how the result
   differs and why. It never restates the diff.
2. MANDATORY agent code review of the cumulative track diff
   `git diff <prev-marker>..HEAD` — correctness, test coverage, style,
   API surface, documentation sync — composed per review-rules.md in
   this directory. Skip this step only when the WHOLE change is
   trivial. No track inside a medium or higher change is trivial.
3. Fix findings as normal commits. Suggestions are never fixed inside
   the change. Record each one as a standalone entry in the log's
   Suggestions section.
4. MANDATORY user review: present the track summary and the track diff
   to the user, then loop on user feedback — landing fixes as normal
   commits — until the user explicitly approves. The agent waits for
   that approval; the marker commit certifies a fully user-reviewed
   track.
5. Land the marker commit when the change has more than one track.
6. Update the track's row in the track table (status, scope drift);
   revise the design only if reality diverged from it.

### Internal review loops and escalations

The adversarial and agent code review loops are internal to the
orchestrator. The orchestrator asks the user only for a decision it
cannot make. Four escalations always reach the user: an iteration that
clears nothing, a third iteration on should-fix findings, a second
regression filed on one finding, and any lowering of a blocker.

### Track table

This section owns the track-table constraints. The table is a
display-only index of the split: track names, one-line scopes,
statuses — never commit SHAs, and never the source of truth for track
boundaries (marker commits are, see § Marker commits). It lives in the
umbrella PR description when publishing is enabled and in the workflow
log's Track table section in both modes.

## Marker commits (source of truth for track boundaries)

Format — an empty commit with a zero-padded two-digit track number:

```bash
git commit --allow-empty -m "Track NN complete: <short name>"
# e.g.  Track 03 complete: cache-refactor
```

List all boundaries offline:

```bash
git log --oneline --grep '^Track [0-9]* complete:'
```

Track N's diff is `marker(N-1)..marker(N)`; track 01's base is the
merge-base with the repository's default development branch.

Properties:

- **Rebase-resilient** — markers are in the history being rebased, so
  they move with it.
- **Zero cleanup** — delivering the change as a single squashed unit
  erases them.
- The track table is never an alternative source of truth for
  boundaries (constraints owned by § Track table).

A change with one track lands no marker — the whole branch diff is the
track.

## Rebase note

After any rebase of the working branch the markers move with the
rebased history — nothing to fix in this baseline. Any layered process
that pins refs to marker commits must re-pin them after a rebase.

## Peer review (project-layered)

This baseline contains no peer-review process. Projects may layer one
— e.g. per-track satellite review PRs for separate peer reviewers —
via a doctrine extension (the `doctrineExtraPath` key in the project's
`slate.json`). A layered peer review supplements, never replaces, the
mandatory per-track user review.

## Migration

A change whose design was approved under the previous rules finishes
under those rules. The new rules apply to a change started after the
upgrade. When the previous document text is no longer installed, the
log's recorded rule-set version and gate list are the authority.

## Layering richer workflows on top

Richer internal planning and execution machinery — whatever agent
tooling is in use — may be layered on top of this baseline, provided
it satisfies the mandatory gates for the confirmed class: a
high-level design for medium and above; design presentation before
adversarial review for complex and risky; design presentation before
implementation for medium and above; adversarial review of the design
for complex and risky; a research log for medium and above; agent code
review for every track unless the whole change is trivial; mandatory
user review of every track diff; marker commits at multi-track
boundaries; and, when draft-PR publishing is enabled, the obligations
of pr-publishing.md. This document defines the baseline that applies
regardless of the tooling.
