# Action-level model routing

Opt-in, per-action model and effort selection for worker
dispatches. `router` in the project's `slate.json` names a closed
list of models an action may run on; every dispatch then resolves to
one model from that list and one effort level from that model's own
ladder — chosen to be up to the task and no more, so the bill is
bounded by the action rather than by the session's current model.
The list is empty by default. With no entries the router is OFF: no
model list is enforced, no thread gets a seeded base, no effort level
is derived, and the router's window, billing and substitution paths
are inert. A dispatch that names no model then plans for the thread's
pre-router pin, and for no model at all when the thread has none: a
new worker opens on the host session's model, and a reused one stays
on the model it opened on. The per-action `model` and `effort`
arguments are honoured on both router states. What a dispatch plans
is not always what it runs; the cases known to bite are collected
under [Known cases where the model or level
differs](#known-cases-where-the-model-or-level-differs).

This document is reference documentation, not workflow doctrine.

A model can only be routed to if Slate ships a benchmark profile for
it. An entry with no profile is named in a warning and excluded —
the router will not invent a tier, a price or an effort ladder for a
model it has no traced evidence about. Project-supplied profiles are
not implemented, so adding a model means a new shipped profile
rather than a config entry. The nine specs Slate profiles today are
listed under [Where the numbers come
from](#where-the-numbers-come-from-and-how-stale-they-can-be).

## What routing decides, per action

Two route inputs are per dispatch — on a new thread and on a
continuation alike:

- **the model** — the `model` argument (`"provider/id"`), else the
  thread's base model (router ON), else the thread's pre-router pin,
  else no plan target at all, in which case the session returns to
  the model it opened on (router OFF; M1, M3, M7);
- **the effort level** — the `effort` argument (one of pi's thinking
  levels), else a level Slate resolves for the model it routes to
  (router ON) or the level the worker session opened on (router
  OFF). See [Effort levels](#effort-levels).

The arguments themselves do not become thread defaults. An explicit
`effort` never governs a later action. An explicit `model` governs
only its own action too, outside M1, M3, M6 and M7. An omitted `effort`
is never "whatever the last action asked for":

- **router on** — the thread's base effort, re-validated, or a level
  derived for the model it routes to (see [Effort
  levels](#effort-levels)). A thread based on `luna@medium` whose
  previous action ran at `max` runs the next one at `medium`.
- **router off** — the worker session is put back to the level it
  opened on, which is pi's own settings default
  (`defaultThinkingLevel`, else pi's built-in default). Slate passes
  that level explicitly at every open, so it is re-clamped against
  the session's current model rather than inherited from the session
  file.

The model axis carries live-session cases the effort axis does not,
M1 and M3 among them, and they predate action-level routing. The
effort axis shares only M7. All of them, with the code that
implements each, are under [Known cases where the model or level
differs](#known-cases-where-the-model-or-level-differs).

A thread's base model and base effort are separate planning state,
visible in the `threads` listing, and are never set from an action's
own route. A live failover marker, when present, identifies the
model that currently overrides that nominal base.

Two things can come back instead of a normal episode:

- a **tool error** — the pair was refused (an unlisted model, a
  level the model does not offer, a level the provider rejects
  outright, or an unevidenced level in a project that forbids one).
  Nothing ran, nothing was billed and no episode was written; the
  message names what is allowed.
- **⚠ notice lines** prefixed above the episode text in the tool
  result — advisory: an evidence gap, a window substitution, a
  long-context billing cliff, a re-seeded base. The action ran.

## Known cases where the model or level differs

The model and the level an action runs on are not always the ones it
asked for, or the ones its thread implies. The cases below are the
ones known to bite, each with the code that implements it. **This
list is not exhaustive.** `planRoute`, `decideModelSwitch` and
`decideEffortSwitch` in `extension/route.ts`, applied by `applyRoute`
in `extension/threads.ts`, are the authority: read them when you need
certainty rather than a map. This section is the reference for these
cases. Other sites may name or summarise them; if a summary disagrees,
this section governs, with the source functions above the ultimate
authority.

Why the MODEL can differ:

- **M1 — a live failover holds the thread.** After a successful
  `modelFailover` the worker stays on its fallback, and a dispatch
  that omits `model` keeps it: the revert to the session's opening
  model stands down (BG16). The hold ends when the session is
  disposed, and when a later non-`openOnly` route moves it — an
  explicit `model` on either router state, or the thread's routed
  base while the router is ON. An OFF pre-router pin is `openOnly`
  and does not release it. A reopen ends it too, except in M6.
  *Code:* the `failover-held` keep in `decideModelSwitch`
  (`route.ts`); `applyRoute` clears the marker after a plan-driven
  `setModel`, and `liveFailoverModel` reports it (`threads.ts`).
- **M2 — a failover fires inside the dispatch.** When the attempt
  fails with a model-API error, Slate switches the live session to
  the mapped model and re-prompts once. One episode covers both
  attempts, and its `ran:` line names the model the action ended on
  rather than the planned one. *Code:* the `isFailoverCandidate`
  block in `runDispatchInner` (`threads.ts`) and `planFailoverSwitch`,
  guard 7 (`route.ts`).
- **M3 — the revert was attempted and failed.** A dispatch that names
  no model switches the session back to the model it opened on. When
  that spec no longer resolves, or `setModel` throws, Slate warns and
  leaves the session on the model the previous action left it on
  (BG24). A PLAN-driven switch that fails is the opposite case: the
  dispatch aborts, nothing runs and no episode is written. M7 is the
  case where no revert is attempted at all. *Code:* `giveUp` inside
  `applyRoute` (`threads.ts`).
- **M4 — the window guard substitutes** (router ON). A model that
  cannot hold the thread's context is replaced by the widest listed
  candidate, and only when one is STRICTLY wider than the model it
  would replace. When nothing listed is wider, the action runs on the
  original model and a warning says pi will compact. It never blocks
  the action, and `substitutedFrom` records a replacement. *Code:*
  `strictlyWider` in `planRoute`'s guard 5 (`route.ts`).
- **M5 — the thread's base was not routable** (router ON). A base
  that is absent or has fallen off the list is re-seeded to a listed
  candidate with a warning, so a model-less dispatch runs on the
  seeded base and not on the value the record carried. *Code:* the
  re-seed branch of `planRoute` with `defaultBase` (`route.ts`),
  written back by `persistReseededBase` (`threads.ts`).
- **M6 — a reopened session restores a model from its file** (CQ3).
  Slate passes the reopening model explicitly whenever the dispatch
  resolves one, and that overrides the session file. When the
  dispatch resolves no model at all and the host session has none
  either, pi restores the file's last model change instead, which can
  be a fallback M1 was holding. The `live=` marker is cleared on every
  reopen, so in this one shape the fallback outlives its marker.
  *Code:* `opts.model ? resolveModel(ctx, opts.model) : ctx.model` in
  `openWorkerSession` (`worker.ts`); the marker delete in
  `openWorkerFor` and the CQ3 note on `liveFailoverModel`
  (`threads.ts`).
- **M7 — nothing was captured to return to.** When the worker session
  reported no model as it opened, there is no revert target, and a
  dispatch that names no model leaves the session where it is with no
  switch attempted. The effort axis has the same keep when no opening
  level was captured. *Code:* `NO_SESSION_BASELINE` and the
  `no-baseline` keeps in `decideModelSwitch` and `decideEffortSwitch`,
  fed by `captureSessionBaseline` (`route.ts`).

Why the LEVEL can differ. There is no counterpart to M1 here: a
dispatch that names no `effort` returns the session to the level it
opened on. M7 and E6 are known cases in which it does not.

- **E1 — pi clamps a level Slate cannot judge.** When the ladder for
  the judged model is unreadable — no profile, a throwing lookup, a
  non-array ladder — the guards stand down and the level goes to pi,
  which clamps it to something the model offers. Slate reports
  nothing, because it has no evidence to report. *Code:*
  `checkEffortFor` and `guardEffort`'s `ladderKnown` (`route.ts`).
- **E2 — M4 moved the model under an explicit level.** A level that
  is not valid on the substituted model is DROPPED with a warning
  rather than refusing the action — a context size must never
  hard-block a dispatch — and the session's opening level applies.
  *Code:* the `soft` branch of `guardEffort` (`route.ts`).
- **E3 — a stored base level no longer holds.** A base effort is a
  cached derivation over a table that ships with Slate. When today's
  table no longer reads it as `ok`, it is silently re-derived for
  that model: nobody asked for that level, so a stale cache is
  Slate's to correct rather than news to report. *Code:* the stored
  base-effort branch of `planRoute`, with `lowestMeasuredEffort`
  (`route.ts`).
- **E4 — the action's model is not the base model.** An explicit
  `model`, or M4, drops the inherited base level and derives the new
  model's own lowest measured level instead. A level derived for one
  model is never carried onto another. *Code:* the effort resolution
  in `planRoute`, keyed on `judgedModel` (`route.ts`).
- **E5 — M2 re-clamps the level.** The failover route requests no
  level, and pi re-clamps the session's current level for the
  fallback model. *Code:* `session.setModel(mapped)` in the failover
  block (`threads.ts`); `openWorkerSession` passes the settings
  default explicitly at every open for the same reason (`worker.ts`).
- **E6 — the level was judged for one model and another model runs.**
  When M1, M3 or M7 leaves the session on a model other than the plan
  target, the level the plan resolved is still applied, and pi clamps
  it to that model's own ladder with nothing reported.
  `effortJudgedFor` names the model the judgement was about, which is
  then not the model that ran. *Code:* the effort switch in
  `applyRoute`, which runs after a model `keep` (`threads.ts`), and
  `decideEffortSwitch` (`route.ts`).

## Configuration

`router` lives in `.pi/slate.json` and, like the rest of that file,
is honored **only in trusted projects** — an untrusted project loads
no project config, so the router stays off. There are exactly three
keys:

```json
{
  "router": {
    "models": [
      "openai/gpt-5.6-luna",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-5",
      "anthropic/claude-fable-5"
    ],
    "allowUnmeasuredEffort": true,
    "showWarnings": false
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `models` | array of `"provider/id"` strings | `[]` | the closed candidate list; empty or absent = router OFF |
| `allowUnmeasuredEffort` | boolean | `true` | `false` turns an evidence gap from a warning into a refusal |
| `showWarnings` | boolean | `false` | `true` shows model data notes in addition to the always-visible configuration faults |

Validation, all of it at session start so a broken list surfaces
before a dispatch is refused by it:

- A `router` value that is not an object is ignored with a warning
  and both defaults apply.
- An unknown key under `router` is reported by name, with the known
  keys listed — a typo'd `"model"` must not read as an empty list.
- A `models` value that is not an array is ignored with a warning
  (the router stays off).
- An individual entry that is not a canonical `provider/id` spec is
  dropped with a warning naming the entry and the defect; the valid
  entries in the same list still apply.
- A non-boolean `allowUnmeasuredEffort` is warned about and treated
  as `true`.
- A non-boolean `showWarnings` is warned about as a configuration
  fault and treated as `false`. The fault remains visible despite
  that fallback.

The config is read once, at session start. Editing `slate.json`
mid-session takes effect only in a new pi session.

## How a model becomes routable

A configured model is routable only where four things intersect:
your list, Slate's shipped profile table, pi's model registry, and
the credentials pi actually has configured. Resolution happens once
per session, lazily at the first consultation, and the answer is
then frozen for that session.

The class test has two independent conditions. A warning is a
**configuration fault** when EITHER condition holds:

1. Slate ignored or dropped part of the user's configuration.
2. The user can stop the warning by ADDING something to their own
   project config or pi credentials, such as a model, credential or
   failover entry. This differs from only removing the model named
   by the warning.

Every other warning is a **model data note**. The single-part test
that asks only whether a user can stop a warning does not partition
the classes: removing a dropped `router.models` entry can silence its
warning, but removal is not the ADD remedy in condition 2. Condition
1 catches every silently ignored or dropped config value first.

| what happens | outcome | warning fragment | class |
| --- | --- | --- | --- |
| entry is not a canonical `provider/id` | dropped | "It is not a canonical \"provider/id\" model spec. Reason:" | configuration fault |
| no profile in Slate's model profile table | dropped | "has no entry in slate's model profile table" | configuration fault |
| two entries resolve to the same profile (an alias or a case variant) | first kept, second dropped | "name the same profiled model" | configuration fault |
| the same spec is listed twice | first kept | none (silent) | — |
| pi's model registry does not know it | dropped | "is not in pi's model registry. Slate drops it from routing." | configuration fault |
| pi has no usable credentials configured for it | dropped | "has no usable credentials configured in pi. Slate drops it from routing." | configuration fault |
| every entry is dropped | router turns OFF | "survived validation. The warnings above name each dropped entry" | configuration fault |
| no usable input price exists for today's date | kept, ordered last | "Slate cannot compare its cost with the other models." | model data note |
| a profile price is negative or non-finite | kept, ordered last or unavailable | "has invalid input price data" or "has invalid output price data" | model data note |
| no usable effort ladder exists in the profile | kept | "Such a level passes through to pi, which clamps it" | model data note |
| profile context window differs from the registry window | kept, registry value used | "differs between two sources" | model data note |
| the first profile names unknown routing-critical fields | kept | "picks models from a research table shipped inside slate" | model data note |
| a profile names unknown routing-critical fields | kept | "model fact that slate could not trace to a source" or "model facts that slate could not trace to a source" | model data note |
| a reportable profile/registry context-window divergence exists, the registry figure is not the profile's recorded known-divergence figure, and the registry figure equals the model's own long-context billing threshold | kept | "context window equal to the model's own long-context billing threshold" | model data note |
| no `modelFailover` entry exists for a candidate | kept | "routable models have no modelFailover entry" | configuration fault |
| every configured candidate is marked non-preferred | cheapest candidate becomes the base | "profiles mark every configured model as one it must never pick by itself" | configuration fault |
| resolution throws | router turns OFF | "routing is disabled. The router could not resolve its model list" | configuration fault |

Each resolution warning is deduplicated by a condition key and retained in the
frozen resolution regardless of display filtering. With `router.showWarnings:
true`, every resolution warning reaches the normal UI notification or console
channel. With the default `false`, every configuration fault remains visible
and model data notes are hidden.

When resolution hides at least one note, Slate emits one discoverability line.
It gives the hidden warning count, names `router.showWarnings`, and says that a
hidden warning can affect model selection. The count is warnings, not physical
display lines. The line appears at most once per session.

Dispatch-time warnings are separate. Context substitution, effort evidence
gaps, long-context billing, failover window notices, and the model-visible
registry-price divergence warning are evaluated for each planned action. They
can repeat on later dispatches. The divergence warning is hardened and capped
through the router sanitizer. It omits exact rates and is not deduplicated.

The exact-rate companion uses the class-aware router sink as a model data note.
It is hidden by default and shown when `router.showWarnings` is true. Its
condition key includes the model, date, and differing rates, so identical live
evidence reports once while changed evidence reports again. It passes through
the same control stripping, citation cleanup, field caps, and whole-message cap
as resolution warnings. A hidden dispatch-time note can trigger the one-time
discoverability line only when resolution did not already trigger it.

Half a list is still a routing policy, so partial drops leave the
router ON. Nothing surviving is not a policy: the router turns OFF
rather than silently routing to whatever the session happens to be
on, which would hide the real problem.

The registry and credential reads are a snapshot taken at that first
consultation. Adding an API key later in the session does not revive
a model dropped as unauthenticated — start a new pi session.

The credential check is pi's synchronous configured-auth test, not a
live call: a key that is configured but expired or invalid survives
resolution and fails at dispatch instead, which is failover's
territory rather than the router's.

### Ordering and the thread base model

Candidates are ordered by five keys, in this order:

1. **preference** — a profile carrying a `nonPreferred` reason sorts
   after every preferred candidate, absolutely, whatever the tier or
   price says. The marker means "never a default pick";
2. **tier sourcing** — within a preference class, candidates whose
   tier is a sourced ordinal come before those whose tier is only a
   cost class read off the price;
3. **tier**, ascending (1 = cheapest class);
4. **current effective input price**, ascending;
5. **spec**, only so the order is total and reproducible.

The **base model of a new thread is the cheapest preferred
candidate**. That guarantees a dispatch which omits `model` can
never be rejected by the list guard. If every configured model is
marked non-preferred, the cheapest one is used anyway — the base
model has to exist — and that fallback is warned about.

Prices come from the profile's dated schedule, and the row in force
on today's date is the one used; a schedule with a dated step change
therefore re-orders candidates by itself on the day it takes effect.
Long-context multipliers are deliberately NOT folded into the
ordering price: they describe what happens above a token threshold,
not the base rate models are compared on.

An existing thread whose base is absent, or has fallen off the list
after a config change, is re-seeded to what a new thread would get,
with a warning, and the new base is persisted so it costs one
warning per thread rather than one per dispatch. An explicit
off-list `model` is still refused — that call has something to
correct.

## Effort levels

The vocabulary is pi's ladder and nothing else: `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`. Which of them a model
actually offers is per model — the shipped table records a ladder
per model id, not a family rule.

**An omitted `effort` never resolves to a fixed default.** With the
router ON, in order:

1. the thread's stored base effort — but only when the action runs
   on the thread's base model, and only while that stored level
   still reads as measured against today's profile table. A level
   that no longer holds (a refreshed table moved it onto a gap, off
   the ladder, or onto the provider's rejection list) is silently
   re-derived; nobody asked for it, so a stale cache is Slate's
   problem to correct rather than news to report;
2. otherwise the **lowest measured level of the model it routes to**
   — the lowest level on that model's ladder that carries a traced
   capability measurement. A level derived for one model is never
   carried onto another, so an explicit `model`, or a window
   substitution, re-derives it;
3. and if that model has no measured level at all, nothing is set:
   the level the worker session opened on applies, which is pi's own
   settings default — never a level another action left behind.

With the router OFF Slate resolves no level at all, so that same
opening level applies to every action that omits `effort`.

So a higher level is only ever reached by naming it: pass `effort`
explicitly on the dispatch. A derived level is measured by
construction and therefore cannot trip the effort guards; only an
explicit one can.

An explicit level is judged against the model the action routes to,
which `effortJudgedFor` names. [Known cases where the model or level
differs](#known-cases-where-the-model-or-level-differs) collects what
can move either afterwards. The difference between a warning and a
refusal is:

- **evidence gap** (the level is on that model's ladder but no
  traced source reports a capability result there) — advisory. The
  action runs, a ⚠ notice says the result is unevidenced for that
  level, and the episode is marked. Setting
  `router.allowUnmeasuredEffort: false` turns this one case into a
  hard refusal for the whole project;
- **off the model's ladder** — refused, whenever the ladder is
  known, outside E2. pi would otherwise clamp the level silently and
  the orchestrator would believe the action ran at a level the model
  never offered;
- **rejected outright by the provider** — refused, always. Such a
  level is still on pi's ladder for the model (the table records the
  hard rejection separately), so dispatching it would be a
  guaranteed API failure rather than an evidence gap.
  `allowUnmeasuredEffort` does NOT cover it;
- **no ladder data at all** — nothing is refused and nothing is
  marked. A failure to read evidence is not evidence of a problem;
  the level goes to pi, which clamps it.

## The seven dispatch guards

Two planning passes run per dispatch: an early one before any state
is touched (a rejection there is a tool error and costs nothing) and
an apply-time one once the thread's real context size is knowable (a
rejection there aborts the dispatch before any billed work, with no
episode). Both run the same guards, in the same order — and the
order is load-bearing: the model is settled before any effort
judgement is made about it, so no level is judged against a model
that is about to be substituted away.

The seven are preceded by an argument check the code numbers 0,
listed first here because a caller meets it first:

| guard | what it protects against |
| --- | --- |
| effort vocabulary (0) | a level pi has no name for — and an `effort` argument that is not a string at all, which read as "omitted" would quietly run the action at a different level than the caller asked for |
| list membership | an explicit model outside the configured list, i.e. the cost bound silently escaped. A thread's base is repaired by re-seeding, never refused, so only an explicit off-list model is ever rejected |
| context window | a thread whose context no longer fits the routed model. Judged with pi's own compaction predicate against the REGISTRY window; NEVER a hard block. The action moves to the widest listed candidate only when that one is strictly wider, with a warning; if nothing wider exists it runs anyway and says so |
| API-rejected level | a guaranteed provider failure. Checked before the ladder, because such a level is on the model's pi ladder — the provider refuses it, the ladder does not |
| ladder validity | pi's silent clamp — the orchestrator believing an action ran at a level the model never offered. Fires only on a KNOWN ladder, and per model, never as a union over models |
| evidence gap | an unevidenced capability claim reported as a normal result. Advisory unless the project set `allowUnmeasuredEffort: false` |
| long-context billing | an unnoticed cost cliff: above a model's threshold the price multipliers apply. Warned once per thread and model; a cost event, never a capacity limit |
| failover carve-out | the router vetoing a rescue. On a **failover switch** the list and effort guards are bypassed entirely and the window check only warns: a model that just failed is worse than an unlisted one that works. The one rule failover still obeys is that the mapping may not resolve to the model that just failed — see `model-failover.md` |

Every guard goes inert when the data it needs cannot be read (a
missing profile, a throwing lookup, an unreadable ladder, an unknown
window) rather than refusing: the guards exist to stop dispatches
that are known to be wrong, not ones that could not be checked. The
one exception is a positive fact that is still readable — a
provider's hard rejection of a level still refuses it even when that
model's ladder is unreadable.

## What you'll see

- **Thread type marker:** `type=<type>` names one of `researcher`,
  `reviewer`, `adversarial`, or `implementer`. It appears in the Slate
  widget, the dispatch call line, live and completed result lines, and
  the `threads` listing. The fifth type is `general`. Slate suppresses
  the marker whenever the type displays as `general`. A missing marker
  cannot distinguish a stored `general` value from an absent or
  unrecognised value.
- **On the call line (TUI):** what the action asked for, e.g.
  `thread t1 type=reviewer [openai/gpt-5.6-sol @medium]`, or just
  `[@medium]` when only the level was named.
- **On the collapsed result line (TUI):** what it actually ran on,
  labelled so it cannot be read as the request:
  `[ran openai/gpt-5.6-sol @medium]`, with a trailing `unmeasured`
  when the level had no capability measurement. Request and result
  can legitimately differ — pi clamps a level the model cannot do,
  the window guard can substitute a wider model, and a failover
  switches it again.
- **In the episode header:** a `ran:` segment on the existing
  date/compressor line —
  `> date: … | ran: openai/gpt-5.6-sol @ medium (unmeasured level) | compressor: …`.
  This is the durable copy: it travels into every later prompt that
  cites the episode. It names the model the session ended the action
  on, and it is absent when the action produced no assistant message
  at all. `compressor:` beside it is a different fact — the model
  that wrote the episode body.
- **In the tool result:** ⚠ notice lines above the episode text (so
  the orchestrator reads them — a cost cliff or an evidence gap is
  its decision to make), the same lines in the live progress output,
  and `details.ranModel` / `details.ranEffort` /
  `details.ranEffortUnmeasured` / `details.warnings` for a renderer.
- **In the `threads` listing:** `type=<type>` precedes the model markers
  for a non-general thread. `base=<model>@<level>?` is the nominal plan
  target when a dispatch omits `model`. The trailing `?` marks
  the level, not the model, as provisional: it is a stored default,
  re-validated against the model's current capability data on every
  dispatch and silently re-derived if it no longer holds. `last=` is
  the model and level that the last action actually ran on, with
  `(unmeasured)` where that applies. `live=<model> (failover)` means
  a held fallback currently overrides the nominal base for the live
  session.
- **At the session level:** configuration faults and model data notes enabled by
  `router.showWarnings`, as UI notifications or console output. The default
  instead shows one discoverability line when it hides notes.
- **In the orchestrator's own system prompt, every turn:** the
  doctrine gains a routing rule — a table with one row per routable
  model, plus the rules for reading it. This is the surface you do
  not see, and it is the router's standing cost: 2,030 characters /
  21 added doctrine lines for six configured models, 2,585 / 24 for
  all nine. In the current snapshot a model row costs 146–183
  characters, plus a one-off legend clause for each marker it
  introduces. Configuring the router roughly doubles Slate's
  always-loaded block (2,498 characters with routing and writing
  off). Those are PORTABLE characters — the
  doctrine with each occurrence of the installed `docs/` directory
  removed, filenames kept — because the doctrine embeds absolute doc
  paths and its raw size therefore depends on where the package is
  installed. `context-budget.md` states that convention, tabulates
  every configuration with its full basis, and gives the arithmetic
  for your own install.

## Expected first-session warnings

The stock count below comes from executing `resolveModelRouter` with this
repository's sanitized `.pi/slate.json`, the shipped profile table, and a real
`ModelRuntime` from the pinned pi 0.83.0 package. The runtime used
`modelsPath: null` and `allowModelNetwork: false`, so no local registry override
or network refresh could affect it. Dummy OpenAI and Anthropic credentials made
the configured-auth premise explicit. The packaged OpenAI data at
`@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/openai.json`
reports a **272,000-token** context window for
`openai/gpt-5.6-luna`, `openai/gpt-5.6-terra` and
`openai/gpt-5.6-sol`. The packaged Anthropic data reports 1,000,000
for each configured Anthropic model. The render treated all six as
authenticated, matching this repository's configured-auth state.

The shipped profiles record 1,050,000 tokens for those three OpenAI
models. Each stock registry value therefore produces a context-window
divergence note. The same 272,000-token value equals each model's
long-context billing threshold, so one aggregate billing-pattern note
also fires.

Resolution emits **11 warnings: 0 configuration faults and 11 model
data notes**. The default `router.showWarnings: false` therefore
shows **0 of those warnings** and one discoverability line. That line
begins `slate: there are 11 hidden warnings in the model router.`
Enabling the option shows all 11 warnings and no discoverability
line. Each resolution warning fires at most once per session, and the
resolution is frozen after the first consultation.

| warnings | class | condition keys | why | shown by default |
| --- | --- | --- | --- | --- |
| 1 | model data note | `w3-explainer` | explains the shipped research table before the first unknown-data warning | 0 |
| 6 | model data note | one `w3:string:<JSON spec>` for each configured model | each profile names model facts with no traced source, or conflicting figures with no adjudication | 0 |
| 3 | model data note | one `w1:string:<JSON spec>` for each configured OpenAI model | each stock registry window differs from its profile window | 0 |
| 1 | model data note | `w1-billing-pattern` | aggregates the three registry windows that equal their models' billing thresholds | 0 |
| **11** | **all model data notes** | — | stock measured total | **0 warnings; 1 discoverability line** |

The stock emission order is:

1. `w1:string:"openai/gpt-5.6-luna"`
2. `w3-explainer`
3. `w3:string:"openai/gpt-5.6-luna"`
4. `w1:string:"openai/gpt-5.6-terra"`
5. `w3:string:"openai/gpt-5.6-terra"`
6. `w1:string:"openai/gpt-5.6-sol"`
7. `w3:string:"openai/gpt-5.6-sol"`
8. `w3:string:"anthropic/claude-sonnet-5"`
9. `w3:string:"anthropic/claude-opus-5"`
10. `w3:string:"anthropic/claude-fable-5"`
11. `w1-billing-pattern`

This count depends on pi's registry data and any local registry
override. This machine's `~/.pi/agent/models.json` overrides the
three OpenAI windows to 1,050,000 tokens. A live render here therefore
suppresses the three divergence notes and the billing-pattern note,
leaving **7 model data notes**. That seven-note result describes this
machine, not a stock install.

The configured failover map covers all six candidates, so the
failover-coverage condition does not fire in either render. Preferred
candidates remain in the list, so the non-preferred-base condition
does not fire either.

In orchestrator mode the first consultation is the DOCTRINE BUILD,
not a dispatch: the orchestrator's system prompt carries the
routable model table, and it is assembled when the first message
starts a turn. Outside orchestrator mode the first dispatch triggers
resolution instead. Config-shape warnings land earlier, at session
start.

A hidden warning can still alter which model runs an action. Context-
window divergence is the concrete case, and the stock registry emits
three such hidden notes for this list. Routing uses the registry
window, and that value drives the context-window substitution guard.
`router.showWarnings` changes display only. It does not change the
resolution or the guard input.

## Thread choice after routing

Routing resolves the model and effort for one action. Thread choice then uses that applied pair when it evaluates a continuation.

A model or effort change makes the existing prefix cold. Current cache-write prices are 12.5 times the matching cache-read prices.

The `thread` tool owns the economic comparison. The orchestrator still decides whether named episodes can replace the live transcript.

On a continuation with `threadChoice.act: true`, `freshContext` is required. With acting off, it is optional. Every supplied valid value reaches the planner on either continuation path. An empty array refuses a restart. A non-empty list of existing episode ids permits one and seeds the new thread.

Whenever `freshContext` is supplied, malformed input or an unknown episode is a tool error before creation or mutation. A valid value on a creation call is accepted and unused because creation has no planner.

The planner can return `continue`, `fresh`, `abstain`, or `refused`. Only `fresh` can trigger a restart when `threadChoice.act` is enabled.

Acting defaults off. The default `threadChoice.report` setting returns the verdict without moving the action.

The planner uses current price rows, recorded prefix size, episode size, and dated retention evidence. It abstains when required price or size evidence is missing.

A stale retention row grants no retention window. Missing retention or elapsed time does not prove expiry, so an unchanged route remains warm.

The complete mechanism and evidence limits are in [Thread cache cost](thread-cache-cost.md).

## What the router does NOT enforce

Two obligations carried by the shipped profile data and stated in
the injected doctrine are **doctrine obligations, not code-enforced
guards**. Both are PREVENTIVE — they decide what may be dispatched,
not what must be checked afterwards — and nothing in the dispatch
path implements either. A warning must not be read as an interlock:

- **The compliance refusal.** `anthropic/claude-fable-5` has no
  zero-data-retention option (mandatory 30-day retention, first-
  and third-party), and its profile says a ZDR-obligated action
  must be REFUSED there at every effort level. Slate's dispatch
  path has no concept of a ZDR-obligated action: list that model
  and an action routed to it will run. The refusal is the
  orchestrator's to make, under the doctrine and under your own
  compliance rules.
- **The measured-level rule for review and gate actions.** Keep
  review and gate actions ON MEASURED LEVELS — dispatch them at a
  level the target model has a capability measurement at. This is a
  rule about what to dispatch, not a licence to run a review at an
  unevidenced level and treat the result carefully afterwards: an
  unmeasured review result is not evidence that can be repaired by
  reading it sceptically, which is why the doctrine states the rule
  up front. Slate's code does not enforce it. It contributes exactly
  two things — the ⚠ notice at dispatch and the `(unmeasured level)`
  marker in the episode header — and neither refuses the dispatch,
  distinguishes a review action from any other, or checks anything
  after the fact. `allowUnmeasuredEffort: false` is not this rule
  either: it is a blanket refusal of unevidenced levels for every
  action in the project.

The same is true of a model whose profile puts a verification gate
on its high effort levels: the gate is advice the orchestrator must
act on, and the dispatch path neither enforces nor tracks it.

The guards in the table above are the complete list of what the
routing code refuses. Everything else in the profile data — hazards,
`routeFor` / `avoidFor` clauses, verification gates — is advice the
orchestrator is expected to follow, not a mechanism.

## Where the numbers come from, and how stale they can be

The routing data is a static, deep-frozen table in
`extension/model-profiles.ts` that ships with the package. There is
no network access and no runtime refresh; the table changes only
when the package is republished.

It profiles nine models, and because the list is closed these are
the only specs `router.models` can be built from. Copy the spelling
exactly — a spec that differs is dropped as unprofiled:

| canonical spec | measured levels | notes |
| --- | --- | --- |
| `openai/gpt-5.6-luna` | medium, max | |
| `openai/gpt-5.6-terra` | xhigh, max | non-preferred: configured-only, never auto-selected |
| `openai/gpt-5.6-sol` | medium, high, xhigh, max | |
| `anthropic/claude-sonnet-5` | high, xhigh, max | non-preferred |
| `anthropic/claude-opus-5` | low, medium, high, xhigh, max | |
| `anthropic/claude-fable-5` | high, xhigh, max | non-preferred; no zero-data-retention option (see [What the router does NOT enforce](#what-the-router-does-not-enforce)) |
| `openai/gpt-5.4-nano` | none | cheap tier, out of scope (below) |
| `openai/gpt-5.4-mini` | none | cheap tier, out of scope |
| `anthropic/claude-haiku-4-5` | none | cheap tier, out of scope |

"Measured levels" are the levels an omitted `effort` can resolve to
and the levels an explicit one passes the evidence-gap guard at; the
first of each list is what a thread based on that model starts at.

**Use the canonical spelling.** The table also carries alias
spellings — the research corpus's dated snapshot ids, and
`openai/gpt-5.6` for sol — but an alias is only a lookup key for the
profile, not a routable spec. Checked against a stock pi install:
`openai/gpt-5.6`, `openai/gpt-5.4-nano-2026-03-17` and
`openai/gpt-5.4-mini-2026-03-17` are NOT in pi's registry, so listing
one of them drops it with the "not in pi's model registry" warning
even though the profile was found. `anthropic/claude-haiku-4-5-20251001`
happens to be a real registry id and does route. Registry contents
change, so treat that as a dated observation and prefer the canonical
column above.

The last three are profiled but OUT OF SCOPE for routing — they are
there so that naming one gets you data instead of a spurious "no
profile" warning, and all three are marked non-preferred, carry
assumed rather than traced effort ladders, and have no
effort-labelled capability results at all. Routing to them is a
deliberate scope decision, not a default.

`PROFILES_AS_OF` is **2026-07-29** — the date of the research behind
the table — and every profile carries the same date in its own
`asOf`, which is what the divergence warning quotes. The only
time-varying part of the data is price-row selection: a schedule
with a dated step change switches rows by itself on that date.

The table's own provenance rules, which the warnings above depend
on:

- a value is transcribed from the research corpus unless the file
  marks it otherwise at its own site (pi's registry decides the id
  spelling; an unsourced tier is a cost class, not a ranking; an
  assumed ladder is a provider-family shape, not a traced fact;
  aliases are resolution spellings, not data);
- a figure that cannot be traced is NOT carried: the field is `null`
  and its name appears in the profile's unknown-routing-critical
  list, which is exactly what the "routing decisions for it are
  provisional" warning reports;
- context window and max output are DOCUMENTATION-ONLY and
  non-authoritative — pi's registry is the single runtime authority,
  and the profile figures exist only so a cross-check can warn;
- long-context threshold and multipliers are BILLING, never
  capacity: crossing the threshold costs money, it does not fail;
- prices are the provider's first-party standard tier only. Batch,
  flex, priority and fast-mode tiers and every regional or
  geographic uplift are NOT carried, so a dispatch on any of those
  surfaces bills above these numbers.

**Standing limitation: the automated checks are provably blind to
wrong research data.** Slate's automated checks (a development
harness in the source repository — it is not part of the published
package) assert **structure only** for this table — ids and aliases
resolve, ladders are
duplicate-free subsets of pi's vocabulary, the measured and gap
lists are disjoint and cover the ladder, price rows are well formed
and tiers do not price-invert, the table is frozen. It asserts no
research number, and cannot: scaling every price by the same factor
passes green, a tier moved so that it does not invert prices passes
green, and an invented hazard clause or evidence sentence passes
green. Numeric and evidential fidelity to the research is a review
concern; a green suite says nothing about it.

## Accepted limitations

- **Frozen per session.** The candidate list, the registry lookup
  and the credential check are resolved once and cached, so a
  dispatch guard and anything else that consults the router agree.
  A key or provider added mid-session, and an edit to
  `slate.json`, both need a new pi session.
- **Router OFF disables candidate routing, not action arguments or
  failover.** With an empty list there is no model list, window
  guard, billing notice, seeded base or candidate substitution, and
  Slate derives no effort level. A model-less plan targets the
  thread's pre-router pin, else nothing, so the session returns to the
  model it opened on outside M1, M3 and M7, and to the level it opened
  on outside M7 and E6. An explicit `effort` is still judged against
  the shipped profile for the plan target when pi's registry can serve
  that model. The `model` argument itself is passed through
  byte-for-byte, so a malformed spec still produces pi's own error.
- **A mid-thread route can cost the prompt cache.** A model or effort
  change makes the prefix cold. The thread-choice planner prices that
  cache state after routing. See [Thread choice after routing](#thread-choice-after-routing).
- **The window guard can move an action to a model you did not
  choose** (it warns, and names what it replaced), and it never
  blocks: if nothing listed is wider, the action runs and pi
  compacts.
- **A `base=` level in the `threads` listing is provisional** — it
  is re-checked on every dispatch and may be re-derived silently.
  The `last=` value is fact.
- **The router bounds the price of an action, not a budget.** There
  is no spend cap, no cross-action cost target and no per-action
  cost attribution: episodes and the `threads` listing account for
  spend per thread and per session, not per route.
- **A longer model list is not free.** Every routable model adds a
  row to the doctrine table that sits in the orchestrator's system
  prompt for the whole session (see [What you'll
  see](#what-youll-see)), so listing models you will not route to
  costs context on every turn. List the models you actually want
  actions to land on.
- **Unprofiled models cannot be routed at all.** A model pi can
  serve but the shipped table does not profile is excluded by
  design; adding one today requires a table refresh in the package.
