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
takes effect only in a NEW pi session. The same holds for
`preserveGlobalModelDefault` (see the caveats), which lives in the
same file under the same trust rule.

Configuring the map is the whole opt-in: in a trusted project with a
`modelFailover` entry, ORCHESTRATOR failover is active in every pi
session regardless of whether Slate's orchestrator mode is on — a
matching model failure switches the session's model (and, as a side
effect, pi's global model defaults, which Slate restores by default —
see the caveats) even if you never use threads.

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
  session is live, including across later model-less actions. The hold
  ends when the session is reopened or disposed, or when a later
  non-`openOnly` route actually moves the live session. Such a route is
  an explicit per-action model on either router state, or the thread's
  base route while the router is ON; an OFF pre-router pin is
  `openOnly` and therefore does not release the hold. The `threads`
  listing marks the held session as `live=<model> (failover)`, where
  `<model>` is the fallback the live worker currently runs. The marker
  disappears on session disposal or reopen, or when a later
  non-`openOnly` route moves the live session.
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
- **The global-default restore:** silent when it succeeds, which is
  the normal case. Otherwise a warning naming the reason — e.g.
  `slate: not restoring the global model defaults — …` when Slate
  stood down without writing anything, or `slate: could not restore
  the global model defaults within …` when it wrote but could not
  confirm the result in time — printed on the console and, when a UI
  is attached, also raised as a notification. Both states are
  explained in the caveats.

## Caveats & accepted limitations

- Slate switches the live model at two sites: orchestrator failover,
  and the handoff adoption that re-applies a parent session's model
  and thinking level when a fresh session picks up a Slate handoff.
  Adoption does NOT depend on the `modelFailover` map, so everything
  in this part of the caveats applies even with the map empty and
  failover off. Both switches persist into the user's **global**
  settings — that is pi's `setModel` / `setThinkingLevel` semantics —
  affecting `defaultProvider`, `defaultModel`, and, through pi's
  thinking-level cascade, `defaultThinkingLevel`. (Global settings
  live in `settings.json` inside pi's agent directory:
  `~/.pi/agent/` by default, elsewhere when `PI_CODING_AGENT_DIR`
  relocates it.) Slate puts them back, judging each switch by two
  fresh reads of the global scope taken immediately before and
  immediately after it. `defaultProvider` and `defaultModel` are
  decided and written as ONE UNIT, because pi only ever writes that
  pair together: the pair is restored only if every half the switch
  changed also holds exactly what that switch should have produced,
  and if either changed half holds something else the whole pair is
  left alone. When the pair is restored, the pre-switch values are
  written back exactly — including a half that had no value before,
  which is restored to absence. `defaultThinkingLevel` is decided and
  written on its own, by the same test. A key the switch did not
  change keeps its value; the live session still runs the switched
  model; and resume is unaffected — the restore rewrites the settings
  file, not the running session.
- `preserveGlobalModelDefault` (boolean, default `true`) disables that
  restore when set to `false`, at BOTH sites; with it off, the
  switched values stay in the global settings as they did before the
  mechanism existed.
- **Slate can decline to restore anything.** When it cannot trust what
  it read — the settings file held under another process's lock,
  unreadable, corrupt or empty, or an extension context gone stale —
  it warns, writes nothing and deletes nothing: acting on a read it
  cannot trust is the one way this mechanism could destroy settings
  rather than merely fail to tidy up. The switch itself still
  happened, so you are left where you were before the restore
  existed: the session runs the switched model, and the global
  defaults may hold Slate's pick. The warning names the file and the
  reason; clear that condition (release the other process, repair or
  remove the file) and put the defaults back by hand as below. A narrower
  variant: if only the session's live thinking level cannot be read,
  that one key is skipped and the provider/model pair is still
  evaluated.
- **A restore can also be abandoned.** Slate verifies that its
  restoring write landed and retries within a wall-clock budget; if
  the restore is still unconfirmed when the budget runs out, Slate
  gives up and does NOT retry later. The switched provider, model, or
  thinking level then persists in the global settings for that session
  and every session afterwards, exactly as it did before this
  mechanism existed. You are told by a console warning plus, when a UI
  is attached, a notification — though console output can be lost if
  the process exits on a signal immediately afterwards. Putting it
  back is manual, and only partly possible from inside pi: `/model`
  rewrites the provider/model pair, the thinking level has no slash
  command (cycle it with its keybinding — `/hotkeys` lists it), and
  neither can restore a key to ABSENT. If a key had no value before
  the switch, remove it from the settings file by hand.
- The restore takes pi's settings lock, and that lock is acquired
  SYNCHRONOUSLY. Under contention — another pi process writing
  settings at the same moment — a switch can stall the session for a
  noticeable interval before Slate gives up: the wall-clock budget
  gates whether a new attempt starts, it cannot interrupt one already
  waiting.
- The test is "does this key now hold exactly what Slate's switch
  should have produced?", and it cannot ask who wrote that value.
  Both directions follow from that one rule. A write by anything else
  is reverted when it happens to leave exactly that value — which
  covers a third-party write that pi's own switch then lands on top
  of, and one arriving after Slate's last read but before its
  restoring write, which is overwritten outright. A write that leaves
  anything else fails the test, so Slate stands off and leaves the key
  alone (for the pair, both keys) — and its own residue then survives
  in the global settings, which is what a second, concurrent pi
  session typically causes. The trade is deliberate: a missed cleanup
  over a reverted user change.
- Slate writes only those three keys, and only in the GLOBAL scope —
  but any settings write re-serialises the whole file through pi's own
  migration, which can rename or drop legacy keys. pi does that on its
  own writes too; Slate's restore can only make it happen earlier.
- Worker sessions use a read-only settings view, so worker failover
  persists nothing; episode compression invokes the mapped model
  directly for the one request instead of switching the session's
  model, so it persists nothing either.
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
