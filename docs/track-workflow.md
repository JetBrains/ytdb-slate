# Track-based development workflow

The mandatory flow for every change delivered under this workflow:

Research → (lazy) research log → user design review → adversarial
review → user approves the track split → per-track loop (implement →
track code review → fixes → mandatory user review → marker commit) →
delivery.

Publishing is conditional on `workflow.draftPRs` in the project's
`slate.json` (default: false). When it is ENABLED, an umbrella draft
PR is created after both reviews pass and before implementation
starts, and the research log folds into its description — see
pr-publishing.md in this directory for all PR mechanics. When it is
DISABLED, the research log is RETAINED as the repo-root workflow log
until the change is delivered: verdict lines, the track table, and
post-design decisions anchor there, and marker commits work unchanged.

The flow scales with change size:

| Change size | What applies |
| --- | --- |
| Multi-track change | Full flow as described above. |
| Single-track change | No track split, no marker commits. Everything else applies. |
| Trivial change (typo, doc-only, mechanical rename, obvious one-file fix) | No split. The planned-changes statement is a 2–3-sentence paragraph; the design review collapses into user consent to it. Micro adversarial review, or skip it with explicit user consent. |

The mandatory user review gate applies at EVERY tier. For single-track
and trivial changes the whole branch diff is the track, so the user
review sits after the agent code review and before delivery.

Throughout this document, the "planned-changes statement" is the
high-level design summary of the change. With publishing enabled it
becomes the Planned-changes section of the PR description (see
pr-publishing.md); with publishing disabled it lives in the workflow
log.

## Research phase (lightweight)

Research is interactive exploration before any implementation: read
real source code, trace call chains, and clarify aims and constraints
with the user. There is no design document, no implementation plan,
and no mandatory artifacts. The phase ends when the initial design of
the change is understood and has passed the user design review (see
below).

## Research log (lazy-triggered)

Start research WITHOUT a log. Open one the moment any trigger below
fires, then backfill the decisions already made — backfilling is cheap
while they are still in context.

| # | Trigger |
| --- | --- |
| 1 | Second non-trivial decision (a choice where a plausible alternative was rejected for a reason). |
| 2 | First surprise — the codebase behaves differently than assumed. |
| 3 | First risky invariant identified — concurrency, durability or recovery, transactional semantics, a public API or behavioral change. |
| 4 | Research will cross a session boundary. |
| 5 | The change is multi-track. |
| 6 | The user requests it. |

### Log format

Four sections:

- **Initial request** — verbatim, written once.
- **Decision Log** — append-only. Each entry is at most 4 lines: the
  decision, why, and the alternatives rejected. Each entry MUST be
  self-sufficient in one sentence; optional evidence citations go in
  as deep links.
- **Surprises & Discoveries**
- **Open Questions**

### Persistence

During research the log lives as an untracked file `research-log.md`
at the repo root. What happens next depends on `workflow.draftPRs`:

- **Enabled** — at umbrella-PR creation the log's content folds into
  the PR description and the file is deleted; decisions made after PR
  creation are appended to the description directly (see
  pr-publishing.md in this directory).
- **Disabled (default)** — the log is RETAINED at the repo root as the
  change's workflow log until the change is delivered. The design and
  adversarial verdict lines, the track table, and post-design
  decisions all anchor there, and marker commits work unchanged.

### Under-trigger guardrail

When shaping the planned-changes statement without a log, state this
explicitly (e.g. "no log kept — one trivial decision, no surprises")
so the user can override and request one.

## User design review (mandatory, pre-adversarial)

When research converges, the agent presents the design to the user:
the proposed approach, key decisions with the alternatives rejected,
risks, and open questions. The presentation input is keyed on log
existence, the same way as the adversarial review's: log exists →
present from the log; no log → present the draft planned-changes
statement. The agent then loops on user feedback — revising the design
(and log) — until the user explicitly approves. Only after that
approval does the adversarial review run.

Rationale: the user owns the design direction. Reviewing with the user
first means the adversarial review attacks a stabilized, user-endorsed
design instead of one the user may still redirect — adversarial rounds
are not spent on designs that would change anyway. The loop mechanics
mirror the track loop's mandatory user review (present → feedback →
explicit approval); the position relative to machine review is
deliberately inverted — here the user reviews first.

Durable record — append a verdict line to the log:

```
Design review: user-approved — YYYY-MM-DD
```

With no log, append the line to the draft planned-changes statement
instead. With publishing enabled it travels into the PR description at
umbrella-PR creation; with publishing disabled the workflow log is the
verdict line's only durable home — writing the first verdict line
opens the log if none exists, seeded with the planned-changes
statement. (Crossing a session boundary before the change is published
or delivered is research-log trigger #4.) The verdict line is written
at every tier; at the trivial tier it is appended after the
planned-changes paragraph, which stands in for the Risks & accepted
trade-offs subsection.

Tier scaling: at the trivial tier the design review collapses into the
user's consent to the 2–3-sentence planned-changes paragraph. With
publishing enabled, the ask for trivial and single-track changes may
be batched: the agent presents the design together with the draft PR
description in ONE pre-adversarial ask, and the user's single approval
covers both. Umbrella-PR creation still follows the adversarial
review; the description is re-presented only if adversarial triage
changed it.

## Adversarial review (mandatory, pre-implementation)

Adversarial review runs after the user approves the design in the user
design review, BEFORE the planned-changes statement is finalized and
implementation starts, for EVERY change. The rationale, briefly:
critique activates latent knowledge that constructive planning does
not (generator/critic asymmetry), and a fresh-context reviewer has no
anchoring on the author's rationale.

The reviewer must be a fresh context (sub-agent or fresh session) that
did not author the decisions.

Input is keyed on log existence:

- Log exists → the adversary attacks the log (plus its cited
  evidence).
- No log → the adversary attacks the draft planned-changes statement.
- Trivial tier → micro-review with one bounded question ("what breaks
  / what am I not seeing?"), or skipped with explicit user consent.

Charter scaling: for single-track changes, limit the mandate to
correctness, hidden coupling, and missed alternatives — style and
speculative scope creep are out of bounds.

Licensed null verdict: "no substantive findings" is an acceptable,
respected outcome — the review prompt must say so.

Triage each finding with the user. Three outcomes:

- **Strengthen** — enrich the alternatives-rejected rationale of the
  attacked decision.
- **Reverse** — change the decision now, while it is still cheap.
- **Accept-as-risk** — record it in Open Questions / Risks.

Triage runs with the user, so a Reverse outcome is itself
user-endorsed; after any reversal, refresh the design-review verdict
line (new date) before any further adversarial round (a round-2
reversal refreshes the line before the change is declared reviewed).

One round by default; run a second round only if any decision was
actually reversed. Append a verdict line to the log (or to the draft
planned-changes statement if there is no log — same homing rules as
the design-review verdict line):

```
Adversarial review: passed, N accepted risks — YYYY-MM-DD
```

## Track loop

A track is one unit in a stacked series: it builds on the tracks
before it, stands alone as an independently reviewable diff, and
carries as much of the change as one reviewable diff holds.

Sizing (soft bounds): a track of ≤~12 in-scope files folds into a
neighbor; >~20–25 in-scope files is a split candidate.

The user approves the proposed track split before implementation
starts. Mid-flight changes to the split are re-presented to the user.

All development is linear on the single working branch; each track is
a contiguous commit range. Track numbering is append-only: completed
tracks never renumber, a replanned remainder gets new numbers, and
abandoned planned tracks are struck through in the track table — their
numbers are never reused.

Per-track sequence:

1. Implement the track, following the project's own engineering
   guidelines for commit/test/push discipline.
2. MANDATORY agent code review of the cumulative track diff
   `git diff <prev-marker>..HEAD` — correctness, test coverage, style,
   API surface, documentation sync — composed per review-rules.md in
   this directory.
3. Fix findings as normal commits.
4. MANDATORY user review: present the track summary and the track diff
   to the user, then loop on user feedback — landing fixes as normal
   commits — until the user explicitly approves. The agent waits for
   that approval; the marker commit certifies a fully user-reviewed
   track.
5. Land the marker commit.
6. Update the track's row in the track table (status, scope drift);
   revise the planned-changes statement only if reality diverged from
   it.

### Track table

A display-only index of the split: track names, one-line scopes,
statuses — never commit SHAs. It lives in the umbrella PR description
when publishing is enabled and in the workflow log when it is
disabled. It is never the source of truth for track boundaries —
marker commits are.

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
- The track table is a display-only index; it is never the source of
  truth for track boundaries.

Single-track changes land no markers — the whole branch diff is the
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

## Layering richer workflows on top

Richer internal planning and execution machinery — whatever agent
tooling is in use — may be layered on top of this baseline, provided
it satisfies the mandatory gates: a user design review before
adversarial review, pre-implementation adversarial review, an agent
code review per track, a mandatory user review per track, marker
commits at track boundaries, and — when draft-PR publishing is
enabled — the obligations of pr-publishing.md (umbrella draft PR
before coding starts, user-performed merge). This document defines the
baseline that applies regardless of the tooling.
