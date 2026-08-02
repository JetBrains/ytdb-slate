# Draft-PR publishing

Umbrella draft PR mechanics for the track-based workflow (see
track-workflow.md in this directory). This document applies ONLY when
`workflow.draftPRs` is enabled in the project's `slate.json` (default:
false). When it is disabled, the workflow creates no PR; the
workflow-log lifecycle in that mode is owned by track-workflow.md
§ Research log.

## Creation

The umbrella draft PR is created once the design has passed the user
design review and the adversarial review, BEFORE implementation:

- Created as a DRAFT, based on the repository's default development
  branch.
- If the working branch has no diff against the base yet, land a
  bootstrap empty commit so the PR can be created.
- At creation, the research log's content folds into the PR
  description — Key decisions, Risks, and Open questions feed the
  corresponding Planned-changes subsections, and the design review and
  adversarial review verdict lines land in Risks & accepted
  trade-offs — and the log file is deleted. Decisions made after PR
  creation are appended to the PR description directly.
- The user approves the description (and the track split — see
  track-workflow.md) before implementation starts.

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
- **Risks & accepted trade-offs** — including the design review and
  adversarial review verdict lines.
- **Verification approach** — 1–2 lines.

"Deep enough" test: a reviewer who knows the codebase but not this
change can (1) predict which subsystems the diff touches, (2) evaluate
each track's diff against a stated intent, and (3) answer "why not
alternative X" without asking.

The description becomes the squash-commit body on the default
development branch — it is the permanent git-archaeology record for
the change. Write it accordingly.

Aim to keep the final delivery commit body at or below 16,384 UTF-8
bytes, excluding the subject. This is a target, not a gate. If the
body must be larger, condense it where possible and state briefly why
the retained detail is necessary. Do not remove decisions, risks,
verdicts, or evidence needed to understand or review the change only
to meet the target. The most recent accepted delivery body was 20,958
bytes, 27.9% above the target; exceeding it is therefore an exercised
exception that carries the condensation and justification duties, not
a prohibited outcome.

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
  to the user.
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
- Measure the final PR description in UTF-8 bytes. If it exceeds the
  target in § Description rules, confirm that condensation was
  attempted and that the description briefly justifies the detail
  retained above the target.
- Last, re-read the whole PR description end-to-end to confirm the
  as-flipped text tells one consistent story.

## After the flip

The user may wait for CI green and/or peer-review completion and ask
the agent to fix test failures or review observations. The agent lands
fixes as normal commits, keeps the description in sync, and presents
agent-landed commits to the user as they land. Commits pushed directly
by reviewers are visible in the PR UI; the agent reconciles the
description with them on its next task. The user's merge act is the
final approval.

## After the merge

Any cleanup a layered peer-review process requires (closing its review
PRs, deleting its pinned branches) is an agent duty, executed when the
user reports the merge or a later session detects it, per that
process's own rules.
