# Action-level model routing

Opt-in, per-action model and effort selection for worker
dispatches. `router` in the project's `slate.json` names a closed
list of models an action may run on; every dispatch then resolves to
one model from that list and one effort level from that model's own
ladder — chosen to be up to the task and no more, so the bill is
bounded by the action rather than by the session's current model.
The list is empty by default: with no entries the router is OFF, no
model list is enforced, no thread gets a seeded base, and a
dispatch that names no model resolves exactly as it did before the
router existed — the thread's pre-router pin, else the host
session's model. (The per-action `model` and `effort` arguments
themselves are honoured on both router states; see the accepted
limitations.) This document is reference documentation, not
workflow doctrine.

A model can only be routed to if Slate ships a benchmark profile for
it. An entry with no profile is named in a warning and excluded —
the router will not invent a tier, a price or an effort ladder for a
model it has no traced evidence about. Project-supplied profiles are
not implemented, so adding a model means a new shipped profile
rather than a config entry. The nine specs Slate profiles today are
listed under [Where the numbers come
from](#where-the-numbers-come-from-and-how-stale-they-can-be).

## What routing decides, per action

Two levers, both per dispatch — on a new thread and on a
continuation alike:

- **the model** — the `model` argument (`"provider/id"`), else the
  thread's base model (router ON), else the thread's pre-router pin
  or the host session's model (router OFF);
- **the effort level** — the `effort` argument (one of pi's thinking
  levels), else a level Slate resolves for the model that actually
  runs (router ON) or the level the worker session opened on (router
  OFF). See [Effort levels](#effort-levels).

Neither is sticky, and that is the guarantee to hold on to: an
explicit `model` or `effort` governs its own action and no later
one. An omitted `model` resolves to the thread's base. An omitted
`effort` resolves differently on the two router states, and neither
of them is "whatever the last action asked for":

- **router on** — the thread's base effort, re-validated, or a level
  derived for the model that runs (see [Effort
  levels](#effort-levels)). A thread based on `luna@medium` whose
  previous action ran at `max` runs the next one at `medium`.
- **router off** — nothing is resolved, so the worker session is put
  back to the level it opened on, which is pi's own settings default
  (`defaultThinkingLevel`, else pi's built-in default). Slate passes
  that level explicitly at every open, so it is re-clamped against
  the session's current model rather than inherited from the session
  file.

A thread's base model and base effort are separate state, visible in
the `threads` listing, and are never set from an action's own route.

Two things can come back instead of a normal episode:

- a **tool error** — the pair was refused (an unlisted model, a
  level the model does not offer, a level the provider rejects
  outright, or an unevidenced level in a project that forbids one).
  Nothing ran, nothing was billed and no episode was written; the
  message names what is allowed.
- **⚠ notice lines** prefixed above the episode text in the tool
  result — advisory: an evidence gap, a window substitution, a
  long-context billing cliff, a re-seeded base. The action ran.

## Configuration

`router` lives in `.pi/slate.json` and, like the rest of that file,
is honored **only in trusted projects** — an untrusted project loads
no project config, so the router stays off. There are exactly two
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
    "allowUnmeasuredEffort": true
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `models` | array of `"provider/id"` strings | `[]` | the closed candidate list; empty or absent = router OFF |
| `allowUnmeasuredEffort` | boolean | `true` | `false` turns an evidence gap from a warning into a refusal |

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

The config is read once, at session start. Editing `slate.json`
mid-session takes effect only in a new pi session.

## How a model becomes routable

A configured model is routable only where four things intersect:
your list, Slate's shipped profile table, pi's model registry, and
the credentials pi actually has configured. Resolution happens once
per session, lazily at the first consultation, and the answer is
then frozen for that session.

| what happens | outcome | warning |
| --- | --- | --- |
| entry is not a canonical `provider/id` | dropped | names the entry and the defect |
| no profile in Slate's model profiles | dropped | "has no benchmark data … excluding it from routing" |
| two entries resolve to the same profile (an alias or a case variant) | first kept, second dropped | names both spellings and the profile |
| the same spec listed twice | first kept | none (silent) |
| pi's model registry does not know it | dropped | "routing there could only produce billed failures" |
| pi has no usable credentials configured for it | dropped | same wording, credentials variant |
| every entry dropped | router turns OFF | one summary line naming the count |
| no usable input price for today's date | kept, ordered last | "its cost cannot be compared" |
| no usable effort ladder in the profile | kept | "every explicit effort level for it will read as off-ladder" |
| profile's context window differs from the registry's | kept (registry value used) | see [Expected first-session warnings](#expected-first-session-warnings) |
| profile names unknown routing-critical fields | kept | "routing decisions for it are provisional", naming the fields |
| no `modelFailover` entry for a candidate | kept | one aggregate line naming every uncovered candidate |

Every warning is emitted at most once per session and reaches the
same channel as the other config warnings: a UI notification when a
UI is attached, the console otherwise.

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

**An omitted `effort` never resolves to a fixed default.** In order:

1. the thread's stored base effort — but only when the action runs
   on the thread's base model, and only while that stored level
   still reads as measured against today's profile table. A level
   that no longer holds (a refreshed table moved it onto a gap, off
   the ladder, or onto the provider's rejection list) is silently
   re-derived; nobody asked for it, so a stale cache is Slate's
   problem to correct rather than news to report;
2. otherwise the **lowest measured level of the model that actually
   runs** — the lowest level on its ladder that carries a traced
   capability measurement. A level derived for one model is never
   carried onto another, so an explicit `model`, or a window
   substitution, re-derives it;
3. and if that model has no measured level at all, nothing is set:
   the level the worker session opened on applies, which is pi's own
   settings default — never a level another action left behind.

So a higher level is only ever reached by naming it: pass `effort`
explicitly on the dispatch. A derived level is measured by
construction and therefore cannot trip the effort guards; only an
explicit one can.

An explicit level is judged against the model the action will
actually run on, and the difference between a warning and a refusal
is:

- **evidence gap** (the level is on that model's ladder but no
  traced source reports a capability result there) — advisory. The
  action runs, a ⚠ notice says the result is unevidenced for that
  level, and the episode is marked. Setting
  `router.allowUnmeasuredEffort: false` turns this one case into a
  hard refusal for the whole project;
- **off the model's ladder** — refused, whenever the ladder is
  known. pi would otherwise clamp the level silently and the
  orchestrator would believe the action ran at a level the model
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

- **On the call line (TUI):** what the action asked for, e.g.
  `thread t1 [openai/gpt-5.6-sol @medium]`, or just `[@medium]` when
  only the level was named.
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
- **In the `threads` listing:** `base=<model>@<level>?` — what a
  dispatch that omits `model` will run on. The trailing `?` marks
  the level, not the model, as provisional: it is a stored default,
  re-checked on every dispatch. Then `last=<model>@<level>` — what the thread's
  last action actually ran on, with `(unmeasured)` where that
  applies — and `live=<model> (failover)` while a failover holds the
  live session.
- **At the session level:** the resolution's own warnings, as UI
  notifications (console when no UI is attached).
- **In the orchestrator's own system prompt, every turn:** the
  doctrine gains a routing rule — a table with one row per routable
  model, plus the rules for reading it. This is the surface you do
  not see, and it is the router's standing cost: 1,924 characters /
  20 lines for six configured models, 2,502 / 23 for all nine,
  growing about 150–185 characters per model you add. Configuring
  the router roughly doubles Slate's always-loaded block (1,874
  characters with routing off). Those counts exclude the absolute
  doc paths the doctrine embeds, whose length depends on where the
  package is installed; `context-budget.md` has the full table, the
  install-path arithmetic and what it means for the orchestrator's
  token budget.

## Expected first-session warnings

**A batch of warnings on the first routed session is expected UX,
not a bug.** With a six-model list on a stock pi install, resolution
emits eleven lines, broken down below. They are not repeated: every
warning fires at most once per session, and the resolution is frozen
after the first consultation.

In orchestrator mode that first consultation is the DOCTRINE BUILD,
not a dispatch: the orchestrator's system prompt carries the
routable model table, and it is assembled when your first message
starts a turn. So the whole batch can arrive in a session where you
typed nothing but "hi" and dispatched nothing at all — that is the
router reading its inputs for the session, not a dispatch
misfiring. (Outside orchestrator mode no doctrine is built, so the
first dispatch triggers it instead. The config-shape warnings above
land earlier still, at session start.)

The breakdown:

| lines | class | why |
| --- | --- | --- |
| 6 | unknown routing data | each of the six profiles names routing-critical fields with no traced value, or with two published values and no adjudication, so routing decisions for them are provisional |
| 3 | context-window divergence | the three `openai/gpt-5.6-*` models — see below |
| 1 | billing-pattern note | one aggregate line naming those three models |
| 1 | failover coverage | one aggregate line, when `modelFailover` covers none of them |

The window divergence is real, and both sides are stated without
adjudication. On a stock install pi's registry reports **272,000**
tokens for `openai/gpt-5.6-luna`, `-terra` and `-sol`, while their
profiles record **1,050,000** (with the profile's asOf date in the
same line). Routing uses the REGISTRY figure — that is a fact about
this code, and it is stated as such — but which figure is factually
correct is not established by the router: it sees two numbers and no
provenance for either.

The registry's 272,000 is also exactly those models' long-context
BILLING threshold, so one further line says so once, naming all
three: a window equal to its own threshold would leave the
long-context price tier unreachable, which is the
billing-row-restated-as-a-capacity pattern. That is suggestive, not
proof, which is why it is a pointer and not a verdict.

**Why Slate does not "fix" this by changing its own number.** The
research pass that produced this table explicitly withdrew 272,000
as a capacity figure: in the source it appears only inside a pricing
row, as a boundary on input tokens. Restating it as a window is the
fabrication that pass caught and corrected. Editing the profile to
match the registry would silence the warning by asserting something
the evidence does not support, and would suppress a divergence that
is currently true. The honest options are the two you already have:
leave it (routing uses the registry number, which is the
conservative one) or raise the registry window deliberately in pi's
custom-models file, after which the warning stops on its own —
`context-budget.md` documents that opt-in and the billing
consequences of running above the threshold.

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
- **Router OFF is not "no effort checking".** With an empty list
  there is no model list, no window guard, no billing notice, no
  seeded base and no substitution — but an explicit `effort` is
  still judged against the shipped profile for the model that runs,
  when pi's registry can serve that model. The `model` argument
  itself is passed through byte-for-byte, so a malformed spec still
  produces pi's own error.
- **A mid-thread model switch costs the prompt cache.** A long
  thread runs overwhelmingly on cache reads; routing a small action
  to a cheaper model on a cold cache can cost more than staying on
  the warm one. The router compares base rates, not the cache state
  of your thread.
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
