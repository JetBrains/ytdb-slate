# Draft-PR publishing

Umbrella draft PR mechanics for the track-based workflow (see
track-workflow.md in this directory). This document applies ONLY when
`workflow.draftPRs` is enabled in the project's `slate.json` (default:
false). When it is disabled, the workflow creates no PR; the
workflow-log lifecycle in that mode is owned by track-workflow.md
§ Research log.

## Creation

For every change with a high-level design, draft the PR description
before the pre-implementation presentation. Present the draft alongside
the high-level design, so one approval covers both. The description has
no separate approval gate.

The umbrella draft PR is created after the gate required by the
confirmed change class passes and BEFORE implementation. For a complex
or risky change, that gate is the final high-level design approval after
the adversarial review. For a medium change, it is the high-level design
approval. A trivial change has no high-level design gate, so the PR is
created after the user confirms the class and before implementation:

- Created as a DRAFT, based on the repository's default development
  branch.
- If the working branch has no diff against the base yet, land a
  bootstrap empty commit so the PR can be created.
- At creation for a medium, complex, or risky change, the research
  log's Planned changes content folds into the PR description. Key
  decisions, Risks, and Open questions feed the corresponding
  Planned-changes subsections. The applicable design review verdict
  lines land in Risks & accepted trade-offs. The adversarial review
  verdict line lands there only when that review ran; a medium change
  carries the design verdict lines alone.
- For a trivial change, the initial request supplies Motivation. The
  confirmed class proposal and intended fix supply Planned changes. If
  a log exists, its relevant decisions and Open Questions also fold
  into the description.
- The research log is retained until delivery, and its Decision Log
  keeps appending during implementation. track-workflow.md § Research
  log owns the full lifecycle.

## Description rules

The description follows the repository's PR template, if any, and
carries three parts: Motivation (why), "Planned changes" (detailed but
high-level), and "Tracks" (a display table, multi-track changes only).

Write Planned changes at a high design level using the MAIN DOMAIN
ENTITIES from the code — real class and component names. Hard guards:
no file paths, no method signatures. If a sentence would change when a
method is renamed, it is too deep.

Subsections activate when their content exists:

- **Current state** — the before-picture per affected area.
- **What changes** — the externally observable contract/behavior: API
  surface, semantics, defaults, persisted formats, compatibility,
  concurrency guarantees.
- **How** — design-level description.
- **Key decisions** — chosen vs rejected; preempts "why not X?" review
  comments.
- **Out of scope** — explicit non-goals.
- **Risks & accepted trade-offs** — including the applicable design
  review verdict lines, and the adversarial review verdict line only
  when that review ran.
- **Suggestions** — a one-line index per suggestion: identifier,
  location, and one-line summary. The standalone text lives in the
  final report to the user or in a tracker issue when
  `workflow.followUpIssues` enables that prompt.
- **Verification approach** — 1–2 lines.

"Deep enough" test: a reviewer who knows the codebase but not this
change can (1) predict which subsystems the diff touches, (2) evaluate
each track's diff against a stated intent, and (3) answer "why not
alternative X" without asking.

The description becomes the squash-commit body on the default
development branch — it is the permanent git-archaeology record for
the change. Write it accordingly.

Aim to keep the final delivery commit body at or below 16,384 UTF-8
bytes, excluding the subject. This is a target, not a gate. Measure
the exact body text as UTF-8 without adding a newline: for a PR, count
the GitHub API `body` string; for a delivered commit, count the byte
sequence after the subject separator in `git cat-file commit <sha>`.
Do not use a formatted `git log` value such as `%b`, which adds an
output newline.

If the body is larger, first remove repetition and merge overlapping
material. Then record a size exception in Risks & accepted trade-offs
carrying measurements, not assurances: the overrun, by the canonical
method above; every top-level section's byte count by that same
method, largest first; and, for each section that was condensed, its
byte count before condensing. A section with no before-count is
visibly untouched, so the user weighs any claim that nothing could be
removed against the counts beside it, and can refuse the exception. Do
not remove decisions, risks, verdicts, or evidence needed to
understand or review the change only to meet the target.

By the canonical measurement above, the most recent accepted delivery
body, from the publishing-enabled path, was 20,957 bytes: 27.9% above
the target. That precedent establishes that a justified overrun can
pass; it does not establish the typical size of either delivery path
or a content-equivalent exception in the publishing-disabled path.

## Tracks table

The description's Tracks section holds the track table; its
constraints (display-only, no SHAs, never the source of truth for
track boundaries) are owned by track-workflow.md § Track table.
Single-track changes carry an "N/A (single-track)" placeholder instead
of a table.

## Keeping the PR in sync

Keep the title and description synchronized with what is actually
pushed: update a track's table row when its marker commit lands,
append post-design decisions as they are made, and revise Planned
changes whenever reality diverges from it. A stale description fails
the "deep enough" test.

## Ready-for-review flip

The umbrella PR is the ONLY PR this workflow ever merges (squash), and
the merge is performed BY THE USER — the agent never merges it.
Flipping the PR to ready-for-review is the agent's last act before
handing the PR to the user; post-flip fix work and post-merge cleanup
stay agent duties (below). The flip is gated by this checklist,
executed in order:

- Any layered peer-review process (see track-workflow.md § Peer
  review) is completed or explicitly user-waived — flipping never
  discards a pending review.
- All commits landed since the last user-approved gate are presented
  to the user. For a trivial change, present the description here
  because no design gate presented it before implementation.
- Every remaining suggestion is reported to the user, and the
  Suggestions index is present in the description.
- Strip the whole Tracks section from the description, whatever its
  form — the table for multi-track changes or the "N/A (single-track)"
  placeholder — plus any notes under it. Track numbers are ephemeral
  branch-life identifiers: after the squash-merge the marker commits
  are gone, so track references would dangle in the default branch's
  history. The rest of the description — Motivation, Planned changes —
  stays: it becomes the squash-commit body.
- Update the PR title and description to the final state of the
  change: the title names what was actually delivered — preserving any
  prefixes or markers the project's conventions require — and the
  description, including the Planned changes section, describes the
  change as implemented, folding in everything added, dropped, or
  reshaped since the draft PR was opened.
- Resolve every remaining Open Question, or record its user-approved
  deferral or accepted uncertainty in Risks & accepted trade-offs. A
  mention without the user's disposition is not enough.
- Measure the final PR description by the canonical method in §
  Description rules. If it exceeds the target, verify that Risks &
  accepted trade-offs carries the size exception's measurements: the
  overrun, the per-section counts, and the before-counts of whatever
  was condensed.
- Last, re-read the whole PR description end-to-end to confirm the
  as-flipped text tells one consistent story.

## After the flip

The user may wait for CI green and/or peer-review completion and ask
the agent to fix test failures or review observations. The agent lands
fixes as normal commits, keeps the description in sync, and presents
agent-landed commits to the user as they land. After every post-flip
description change, and again at the final handoff for merge, repeat
the byte measurement and any over-target size exception required by §
Description rules. Commits pushed directly by reviewers are visible in
the PR UI; the agent reconciles the description with them on its next
task. The user's merge act is the final approval, including acceptance
of any recorded size exception.

## After the merge

Complete the research-log delivery cleanup defined by
track-workflow.md § Research log.

Any cleanup a layered peer-review process requires (closing its review
PRs, deleting its pinned branches) is an agent duty, executed when the
user reports the merge or a later session detects it, per that
process's own rules.
