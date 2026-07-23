# Model failover

Opt-in high availability for model outages. `modelFailover` in the
project's `slate.json` maps a model to an equal-quality alternative;
when a Slate action fails because of a model API failure, the
affected site retries ONCE on the mapped model, at code level,
without user intervention (in worker and orchestrator sessions only
after pi's own retries are exhausted — see below). The map is empty
by default: with no entries the feature is off and failures surface
exactly as before. This document is reference documentation, not
workflow doctrine.

## Configuration

`modelFailover` lives in `.pi/slate.json` and, like the rest of that
file, is honored **only in trusted projects**. Both sides of every
entry are full model specs in `provider/id` form:

```json
{
  "modelFailover": {
    "anthropic/claude-sonnet-5": "openai/gpt-5.2",
    "openai/gpt-5.2": "anthropic/claude-sonnet-5",
    "anthropic/claude-haiku-4": "google/gemini-3-flash"
  }
}
```

Validation rules:

- Key and value must both have the `provider/id` shape.
- Key and value must differ (mapping a model to itself is invalid).
- Invalid entries are dropped with a warning; valid entries in the
  same map still apply.

Mutual entries (A→B and B→A, as above) are fine — see the single-hop
rule below.

The map is read ONCE, at session start. Editing `slate.json`
mid-session — e.g. adding a mapping in the middle of an outage —
takes effect only in a NEW pi session.

Configuring the map is the whole opt-in: in a trusted project with a
`modelFailover` entry, ORCHESTRATOR failover is active in every pi
session regardless of whether Slate's orchestrator mode is on — a
matching model failure switches the session's model (and pi's global
default, see the caveats) even if you never use threads.

## When failover fires

A failure is eligible for failover when it is either:

- an error stop reason that is NOT a context overflow, or
- a preflight failure: a worker prompt that throws is confirmed by
  re-running the auth check on the current model (a transient throw
  with healthy credentials does not switch models); the episode
  compressor treats any thrown attempt as eligible.

pi's own retry settings (`retry.enabled` / `retry.maxRetries`, with
exponential backoff) run first inside worker and orchestrator
sessions — there, failover fires only after pi gives up on the
original model. Quota and billing errors are non-retryable in pi, so
those fail over promptly. The episode compressor is a single direct
API call with no retry loop of its own, so its mapped retry fires on
the first failure.

What NEVER triggers failover:

- **Aborts** — a user abort is not a model failure.
- **Context overflow** — a different model does not fix an oversized
  prompt; the existing overflow handling applies unchanged.
- **Worker task-level failures** — the model answered but the action's
  outcome was bad; those surface as failed episodes, as before.

Before any switch, the mapped model is resolved against pi's model
registry and auth-checked. If it is unknown or unauthenticated, no
switch happens and the original failure stands. The map is applied a
single hop per failure — it is never chained, so cycles (A→B, B→A)
cannot loop.

## Per-site behavior

Failover applies at three sites:

- **Worker threads.** The live worker session switches to the mapped
  model and the failed action is re-prompted once with a continuation
  nudge. The transcript is preserved; usage and cost accumulate across
  both attempts. The thread stays on the mapped model while its
  session is live and returns to its configured model when the session
  is reopened (e.g. after a pi restart). The `threads` listing marks a
  switched live session as `model=A ⇒B (live)` — the marker means a
  live failover switch happened (it is not a value comparison) and
  disappears when the session is reopened.
- **Episode compression.** The compression call is retried once with
  the mapped compressor model — only if it is distinct from the
  original, resolvable, and authed. If the retry also fails, the
  uncompressed fallback applies exactly as today. Compression cost
  accumulates across both attempts — a failed first attempt may still
  bill.
- **Orchestrator.** Once pi's retries are exhausted, Slate switches
  the session to the mapped model and automatically re-issues the
  failed turn. A one-shot guard prevents loops; it re-arms only when a
  run settles without a model error (an abort also re-arms it) or on a
  genuine new user prompt. The session STAYS on the mapped model
  afterwards. Failover runs even while Slate is paused for handoff, so
  the handoff brief is written by a working model.

## What you'll see when failover fires

- **Orchestrator:** a `slate: model failover <old> ⇒ <new> — retrying
  the failed turn` warning notification, then a visible `[slate]`
  steer message in the conversation instructing the model to re-issue
  the failed action. A skipped or failed switch (no API key, auth
  throw) also notifies, and the original failure stands.
- **Worker threads:** a `⚠ failover <old> ⇒ <new>` line in the thread
  tool's progress output; if the retry also fails, the episode's
  failure diagnostics carry a `(failover to <new> also failed)`
  suffix. The `threads` listing shows the live-model marker while the
  switched session is live.
- **Episode compression:** no live signal — the episode header's
  `compressor:` line names whichever model actually produced the
  episode.

## Caveats & accepted limitations

- Orchestrator failover persists the mapped model as the user's
  **global default model** — that is pi's `setModel` semantics. Switch
  back with `/model` once the outage is over.
- Worker sessions use a read-only settings view, so worker failover
  persists nothing.
- Orchestrator **preflight** auth failures (e.g. an OAuth token that
  expired before any run starts) bypass failover — pi surfaces the
  error itself; recover manually with `/model`.
- A worker retry holds its concurrency slot across both attempts.
- Stickiness is per-thread only: each NEW thread still starts on its
  configured/default model during an outage.
- Cancelling a run while pi is sleeping between its internal retry
  attempts is not reliably distinguishable from pi exhausting those
  retries — pi emits no extension-visible signal for that cancel.
  Slate mitigates by counting consecutive retryable errors against
  pi's retry settings, which blocks failover in the normal cancel
  case; a narrow residual window remains (e.g. retry settings changed
  mid-session) where a cancelled run could still fail over.

## Troubleshooting

Failover looked eligible but was skipped: check the mapped model. It
must be a well-formed `provider/id` spec, present in pi's model
registry, and pass its auth check at failure time — otherwise the
original failure stands (malformed entries are additionally dropped
with a warning when the config is read). If you edited the map
mid-session, remember it is read only at session start — start a new
pi session for the change to apply.
