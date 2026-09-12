# Action-level model routing

Opt-in model and effort selection for each worker action. `router` in the
project's `slate.json` names a closed model list. Every `thread` call creates a
new worker session for one action. The list is empty by default. With no entries,
the router is off. Every call still requires `model`, `effort`, and a non-empty
`reason` of at most 200 characters.

This document is reference documentation, not workflow doctrine.

A model can only be routed to if Slate ships a benchmark profile for
it. An entry with no profile is named in a warning and excluded —
the router will not invent a tier or an effort ladder for a
model it has no traced evidence about. Project-supplied profiles are
not implemented, so adding a model means a new shipped profile
rather than a config entry. The nine specs Slate profiles today are
listed under [Where the numbers come
from](#where-the-numbers-come-from-and-how-stale-they-can-be).

## Project startup default and action routing

This repository's `.pi/settings.json` prefers `openai/gpt-6-astra` at medium
for a fresh trusted Pi session. When a scoped model set is active, Pi selects
Astra if Astra appears anywhere in that set. Astra keeps the project default
effort unless its scope entry or an explicit thinking option supplies another
effort. If Astra is absent, the scope excludes it. Explicit command-line and
restored-session choices keep their existing precedence.

The project setting can also initialize a new worker session when no opening
model was supplied. Initialization is not action routing. Every worker action
still names a model and effort. Slate applies that explicit route before the
first billed worker call. The setting does not rewrite global settings, change
a current or restored session, or add a routing or failover rule.

## What routing decides, per action

Each new action validates three explicit values:

- **model** — the required `provider/id` model for this action.
- **effort level** — the required pi thinking level for this action.
- **reason** — the required, sanitized rationale for the pair. Slate stores it
  with the request but does not add it to worker or compressor prompts.

The action opens one worker session. Slate may switch that session before the
prompt. Failover may switch and re-prompt the same session once. The action then
ends. No later action reopens or reuses that worker session.

A rejected model or effort returns a tool error before billed work. Advisory
notices report evidence gaps and model-data limits. Slate does not
substitute a wider model based on context size. Slate does not emit a
long-context billing notice.

## Known cases where the model or level differs

The model can differ after in-action failover. The episode records the model
that ended the action. Pi can also clamp an effort level when capability data is
unreadable. Slate reports only facts supported by its profile data.

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
      "anthropic/claude-fable-5-1",
      "google-vertex/gemini-3.8-flash",
      "openai/gpt-6-astra",
      "anthropic/claude-haiku-4-5"
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
| two entries resolve to the same profile (an alias or a case variant) | first spelling claims the profile, second is dropped | "name the same profiled model" | configuration fault |
| the same spec is listed twice | first kept; later copy appears as `[warn]` only if the whole list is dropped | none outside the all-dropped summary | — |
| pi's model registry does not know it | dropped | "is not in pi's model registry. Slate drops it from routing." | configuration fault |
| pi has no usable credentials configured for it | dropped | "has no usable credentials configured in pi. Slate drops it from routing." | configuration fault |
| every entry is dropped, with at least one malformed spec, missing profile, or profile-alias duplicate | dispatch blocked by a retained fault | "survived validation" with each cause marked `[fault]` or `[warn]` | configuration fault |
| every entry is dropped for registry, credential, or exact-duplicate causes only | router turns OFF; explicit dispatch remains available | "survived validation" with each cause marked `[warn]` | configuration fault |
| no usable effort ladder exists in the profile | kept | "Such a level passes through to pi, which clamps it" | model data note |
| profile context window differs from the registry window | kept, registry value used | "differs between two sources" | model data note |
| the first profile names unknown routing-critical fields | kept | "advises model choices from a research table shipped inside slate" | model data note |
| a profile names unknown routing-critical fields | kept | "model fact that slate could not trace to a source" or "model facts that slate could not trace to a source" | model data note |
| no `modelFailover` entry exists for a candidate | kept | "routable models have no modelFailover entry" | configuration fault |
| resolution throws | router turns OFF | "routing is disabled. The router could not resolve its model list" | configuration fault |

Each resolution warning is deduplicated by a condition key and retained in the
frozen resolution regardless of display filtering. With `router.showWarnings:
true`, every resolution warning reaches the normal UI notification or console
channel. With the default `false`, every configuration fault remains visible
and model data notes are hidden.

When resolution hides at least one note, Slate emits one discoverability line.
It gives the hidden warning count, names `router.showWarnings`, and says that the
notes may inform an explicit model and effort choice. The notes do not select or
reroute an action. The count is warnings, not physical display lines. The line
appears at most once per session.

Dispatch-time warnings are separate. Effort evidence gaps and failover notices
are evaluated for each action. Registry prices do not produce dispatch warnings.

Half a list is still a routing policy, so partial drops leave the
router ON. Nothing surviving is not a policy. A malformed specification, missing shipped
profile, or profile-alias duplicate makes that all-dropped state a dispatch
fault. Other causes turn the router off with a loud warning and allow explicit
dispatch. A mixed all-dropped list faults when any fault-class cause appears.

The registry and credential reads are a snapshot taken at that first
consultation. Adding an API key later in the session does not revive
a model dropped as unauthenticated — start a new pi session.

The credential check is pi's synchronous configured-auth test, not a
live call: a key that is configured but expired or invalid survives
resolution and fails at dispatch instead, which is failover's
territory rather than the router's.

### Candidate order and explicit choice

Validation preserves the configured order of surviving `router.models` entries.
Filtering and alias de-duplication can remove entries. Tier, tier sourcing,
registry prices and model specification text never reorder the survivors.

The router selects no model and derives no default effort. Every normal dispatch
must provide its model and effort. An off-list model is refused before the thread
is created. A failover target keeps the existing narrow list-membership carve-out
and still receives the unsupported-request control check.

The injected table shows base input and output rates from the exact
provider-qualified pi registry entry used to resolve each row. It does not use a
canonical profile rate or a rate from another alias. Zero is a valid rate.
A missing, negative, non-finite, malformed or unreadable component renders as
`unknown`. Input and output are independent. Cache rates do not enter this table.

## Effort levels

The vocabulary is pi's ladder and nothing else: `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`. Which of them a model
actually offers is per model — the shipped table records a ladder
per model id, not a family rule.

Every dispatch must name `effort`. Slate does not read a stored router effort
or derive the lowest measured level. The requested level is checked against the
selected model. A valid request stays unchanged.

With the router OFF Slate derives no level. The required explicit value is
checked against profile data when that data is available. No derived route level exists.
A retired Mini, Nano, or Fable 5 model has no profile. Slate therefore does not
apply its former model-specific effort refusal, and Pi may clamp the request.

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
- **provider-unsupported requested control** — refused, always. Slate records this separately so pi cannot omit or silently substitute the requested control. It is a hard refusal rather than an evidence gap.
  `allowUnmeasuredEffort` does NOT cover it;
- **no ladder data at all** — nothing is refused and nothing is
  marked. A failure to read evidence is not evidence of a problem;
  the level goes to pi, which clamps it.

## Dispatch guards

Slate validates once before thread creation and again before the worker prompt.
The second pass catches registry or credential changes. Both passes use the same
model and effort rules.

| guard | what it protects against |
| --- | --- |
| effort vocabulary | an unknown or non-string effort value |
| list membership | an explicit model outside the configured list |
| unsupported request | a requested control Slate must preserve instead of letting pi omit or substitute it |
| ladder validity | an effort level outside the model's known ladder |
| evidence gap | an unmeasured capability claim when project policy rejects it |
| failover carve-out | a routing rule blocking an in-action rescue |

Slate does not route from prompt size. Pi owns worker compaction and context
overflow behavior. Slate also does not emit a prompt-size billing notice.

## What you'll see

- **Thread type marker:** `type=<type>` names one of `researcher`,
  `reviewer`, `adversarial`, or `implementer`. It appears in the Slate
  widget, the dispatch call line, live and completed result lines, and
  the `threads` listing. The fifth type is `general`. Slate suppresses
  the marker whenever the type displays as `general`. A missing marker
  cannot distinguish a stored `general` value from an absent or
  unrecognised value.
- **On the call line (TUI):** what the action asked for, e.g.
  `thread t1 type=reviewer [openai/gpt-5.6-sol @medium]`. Public
  dispatch always supplies both values. A legacy renderer input may omit one.
- **On the collapsed result line (TUI):** what it actually ran on,
  labelled so it cannot be read as the request:
  `[ran openai/gpt-5.6-sol @medium]`, with a trailing `unmeasured`
  when the level had no capability measurement. Request and result
  can legitimately differ because pi may clamp a level or an
  in-action failover may switch the model.
- **In the episode header:** a `ran:` segment on the existing
  date/compressor line —
  `> date: … | ran: openai/gpt-5.6-sol @ medium (unmeasured level) | compressor: …`.
  This is the durable copy: it travels into every later prompt that
  cites the episode. It names the model the session ended the action
  on, and it is absent when the action produced no assistant message
  at all. `compressor:` beside it is a different fact — the model
  that wrote the episode body.
- **In the tool result:** ⚠ notice lines above the episode text (so
  the orchestrator reads them — for example, an unmeasured-effort or
  evidence-gap warning), the same lines in the live progress output,
  and `details.ranModel` / `details.ranEffort` /
  `details.ranEffortUnmeasured` / `details.warnings` for a renderer.
- **In the `threads` listing:** `type=<type>` precedes the model markers
  for a non-general thread. `requested=<model>@<level>` and `reason=` show
  the last sanitized request. A marker says when `last=` differs from the
  requested model. `last=` is the model and level that the last action
  actually ran on, with `(unmeasured)` where that applies.
  `live=<model> (failover)` means the live session currently holds that
  fallback.
- **At the session level:** configuration faults and model data notes enabled by
  `router.showWarnings`, as UI notifications or console output. The default
  instead shows one discoverability line when it hides notes.
- **In the orchestrator's own system prompt, every turn:** the
  doctrine gains a benchmark guide and a routing table with one row per
  routable model. This is the surface you do not see, and it is the router's
  standing cost: 13,811 portable characters / 96 split lines for the fixed
  six-model fixture and 18,455 / 100 for all nine. The nine model rows cost
  953–1,655 characters each. The static guide and fixed routing prose cost
  6,292 characters. A one-off legend clause appears for each marker the rows
  introduce.
  The fixed fabricated roster does not read project config. Those are PORTABLE characters — the
  doctrine with each occurrence of the installed `docs/` directory
  removed, filenames kept — because the doctrine embeds absolute doc
  paths and its raw size therefore depends on where the package is
  installed. `context-budget.md` states that convention, tabulates
  every configuration with its full basis, and gives the arithmetic
  for your own install.

## Expected first-session warnings

The count below comes from executing `resolveModelRouter` with this repository's
seven-model `.pi/slate.json` and shipped profiles. A deterministic registry
fixture marks every candidate authenticated. It uses 272,000 tokens for the
three GPT-5.6 entries, matching the pinned pi package's provider data. It uses
the documented profile window for Gemini, Astra, and both Anthropic entries.
This isolates the stock GPT window from this machine's local overrides.

The shipped profiles record 1,050,000 tokens for those three OpenAI
models. Each stock registry value therefore produces a context-window
divergence note.

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
| 7 | model data note | one `w3:string:<JSON spec>` for each configured model | each profile names model facts with no traced source, or conflicting figures with no adjudication | 0 |
| 3 | model data note | one `w1:string:<JSON spec>` for each configured GPT-5.6 model | each stock registry window differs from its profile window | 0 |
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
10. `w3:string:"google-vertex/gemini-3.8-flash"`
11. `w3:string:"openai/gpt-6-astra"`

This count depends on pi's registry data and any local registry
override. This machine's `~/.pi/agent/models.json` overrides the
three OpenAI windows to 1,050,000 tokens. A live render here therefore
suppresses the three divergence notes, leaving **8 model data notes**.
That eight-note result describes this machine, not a stock install.

The configured failover map covers all seven candidates, so the
failover-coverage condition does not fire in either render.

In orchestrator mode the first consultation is the DOCTRINE BUILD,
not a dispatch: the orchestrator's system prompt carries the
routable model table, and it is assembled when the first message
starts a turn. Outside orchestrator mode the first dispatch triggers
resolution instead. Config-shape warnings land earlier, at session
start.

Context-window divergence remains a profile-data note. It does not change the
model selected for an action. `router.showWarnings` changes display only.


## What the router does NOT enforce

Two obligations carried by the shipped profile data and stated in
the injected doctrine are **doctrine obligations, not code-enforced
guards**. Both are PREVENTIVE — they decide what may be dispatched,
not what must be checked afterwards — and nothing in the dispatch
path implements either. A warning must not be read as an interlock:

- **The compliance refusal.** `anthropic/claude-fable-5-1` normally
  requires at least 30-day retention. REFUSE a zero-data-retention
  action unless the operator confirms both express Anthropic
  authorization for Fable and the required configuration. Unknown
  authorization counts as no authorization. Model availability, a
  successful request, or a general zero-data-retention agreement does
  not establish the exception. Slate's dispatch path has no concept of
  the obligation or authorization. A listed action routed to Fable will
  run. The orchestrator must apply the refusal and the operator's exact
  agreement and platform policy.
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
| `openai/gpt-5.6-luna` | low, medium, high, xhigh, max | |
| `openai/gpt-5.6-terra` | low, medium, high, xhigh, max | configured-only guidance |
| `openai/gpt-5.6-sol` | low, medium, high, xhigh, max | |
| `anthropic/claude-sonnet-5` | low, medium, high, xhigh, max | |
| `anthropic/claude-opus-5` | low, medium, high, xhigh, max | |
| `anthropic/claude-fable-5-1` | low, medium, high, xhigh, max | tier 4 is unsourced; no DeepSWE result; refuse zero-data-retention work unless express model-specific authorization and required provider and account configuration are confirmed |
| `google-vertex/gemini-3.8-flash` | low, medium, high | aliases use distinct provider contracts |
| `openai/gpt-6-astra` | low, medium, high, xhigh, max | tier 4 is unsourced; registry capacity can differ from documentation |
| `anthropic/claude-haiku-4-5` | none | no evidence-based coding default |

"Measured levels" are the levels Slate has capability evidence for.
An explicit level passes the evidence-gap guard at these levels. Slate does not select the first level automatically.

**Use the canonical spelling.** The table also carries approved aliases,
including `openai/gpt-5.6` for Sol, a dated Haiku spelling, and three Gemini
provider routes. An alias is a profile lookup key. It becomes routable only
when that exact provider-qualified entry exists in Pi's registry and has
configured credentials. Alias routes can have different cache, privacy, wire,
adapter, and rate contracts. Vertex measurements do not establish measured
effort behavior on another Gemini route. Slate therefore treats low, medium,
and high as evidence gaps for those aliases during normal dispatch. Strict
projects refuse the gap. Permissive projects run it with an unmeasured marker.
The live failover exception still permits a working alias at those levels. It
continues to reject provider-unsupported controls. Registry contents change, so
prefer the canonical column above unless the project has verified another route.

Mini, Nano, and Fable 5 are retired from the profile catalogue. Their canonical
ids and aliases no longer resolve. A configured list made only of retired names
becomes an all-dropped fault and blocks dispatch until the project config is
corrected. Slate performs no config rewrite or history migration. Stored thread
and episode history remains readable because replay does not require a live
profile. With routing off, these models are unprofiled and lose their former
model-specific effort checks. Pi may clamp the requested effort.

`PROFILES_AS_OF` is **2026-09-11** — the date of the research behind
the table — and every profile carries the same date in its own
`asOf`. The registry supplies runtime prices separately.

### Benchmark and model-result sources

Slate summarizes model-specific results from the linked publisher and evaluator
pages. The summaries are original project text. They copy no benchmark prompt,
dataset, marketing table, or publisher table arrangement. The project approved
this bounded factual use. A link does not imply publisher endorsement or
permission beyond the publisher's applicable terms. Scores and costs were
retrieved on 2026-09-11. Method definitions were checked on 2026-09-12.

Shared method and result sources:

- DeepSWE v1.1 results and costs: <https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json>, <https://deepswe.datacurve.ai/>, and <https://deepswe.datacurve.ai/changelog>.
- Vals Code Migration and Terminal-Bench 2.1 results: <https://www.vals.ai/benchmarks/code-migration> and <https://www.vals.ai/benchmarks/terminal-bench-2-1>.
- OpenAI MRCR v2 method: <https://github.com/google-deepmind/eval_hub/blob/master/eval_hub/mrcr_v2/README.md>.
- OSWorld 2.0 method: <https://arxiv.org/html/2606.29537v2>.
- AutomationBench-AA, AA-LCR v1.1, and AA-Omniscience methods: <https://artificialanalysis.ai/evaluations/automationbench-aa>, <https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning>, and <https://artificialanalysis.ai/evaluations/omniscience>.
- ARC-AGI-3 method and result data: <https://docs.arcprize.org/methodology> and <https://arcprize.org/media/data/leaderboard/v3.json>.

Model-specific result and vendor sources:

- Luna: <https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/>, <https://www.vals.ai/models/openai_gpt-5.6-luna>, <https://arcprize.org/results/openai-gpt-5-6>, and <https://openai.com/index/gpt-5-6/>.
- Sonnet 5: <https://www.vals.ai/models/anthropic_claude-sonnet-5>.
- Terra: <https://www.vals.ai/models/openai_gpt-5.6-terra>, <https://arcprize.org/results/openai-gpt-5-6-terra>, and <https://openai.com/index/gpt-5-6/>.
- Sol: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>, <https://www.vals.ai/models/openai_gpt-5.6-sol>, <https://arcprize.org/results/openai-gpt-5-6-sol>, <https://openai.com/index/gpt-5-6/>, <https://deploymentsafety.openai.com/gpt-5-6>, and <https://metr.org/blog/2026-06-26-gpt-5-6-sol/>.
- Opus 5: <https://www.vals.ai/models/anthropic_claude-opus-5>, <https://arcprize.org/results/anthropic-claude-opus-5>, <https://www.anthropic.com/claude-opus-5-system-card>, and <https://artificialanalysis.ai/articles/opus-5>. The dated 50% hallucination result has no published denominator. Fallback-assisted Code Migration share is also unknown.
- Fable 5.1: <https://platform.claude.com/docs/en/models/fable-5-1/overview>, <https://platform.claude.com/docs/en/build-with-claude/effort>, <https://www.vals.ai/models/anthropic_claude-fable-5-1>, <https://www.anthropic.com/claude/fable>, <https://artificialanalysis.ai/models/comparisons/claude-fable-5-1-vs-claude-fable-5-1-medium>, <https://artificialanalysis.ai/models/comparisons/claude-fable-5-1-low-vs-claude-fable-5-1-xhigh>, and <https://artificialanalysis.ai/articles/claude-fable-5-1>. Fallback-assisted shares remain unknown.
- Gemini 3.8 Flash: <https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-8-flash>, <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash>, <https://deepmind.google/models/model-cards/gemini-3-8-flash/>, <https://artificialanalysis.ai/models/releases/gemini-3-8-flash>, and <https://artificialanalysis.ai/models/gemini-3-8-flash>. The Vals benchmark page above contains the named Gemini row.
- Astra: <https://developers.openai.com/api/docs/models/gpt-6-astra>, <https://openai.com/index/gpt-6-astra/>, <https://artificialanalysis.ai/models/comparisons/gpt-6-astra-low-vs-gpt-6-astra>, <https://www.vals.ai/models/openai_gpt-6-astra>, <https://arcprize.org/results/openai-gpt-6-astra>, <https://arcprize.org/blog/astra>, and <https://openai.com/index/how-two-settings-tripled-our-arc-agi-3-scores/>.
- Haiku 4.5: <https://platform.claude.com/docs/en/models/haiku-4-5/overview> and <https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence>. The Vals benchmark pages above contain the named Haiku rows.

Cache policy sources are <https://developers.openai.com/api/docs/guides/prompt-caching>
and <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>.
Local cache probes are internal project measurements dated 2026-08-06. Fable
5.1 has no local cache probe. Covered Model retention sources are
<https://support.claude.com/en/articles/15425695-covered-models> and
<https://privacy.claude.com/en/articles/15425996-data-retention-practices-for-covered-models>.
OpenAI data controls are documented at
<https://developers.openai.com/api/docs/guides/your-data>. A public page cannot
prove account-specific Zero Data Retention authorization. The operator must use
the project's authorization record. Tier assignments and routing
recommendations are project judgments derived from the recorded evidence. They
are not publisher recommendations.

The table's own provenance rules, which the warnings above depend
on:

- A value comes from the research corpus unless its source comment says
  otherwise.
- Pi's registry decides identifier spelling.
- An unsourced tier carries an explicit marker and is not an ordering key.
- Every current ladder is traced to pinned pi 0.83 mapping and current provider documentation.
- Aliases are resolution spellings rather than profile data.
- A figure that cannot be traced is not carried. The field is `null`, and its
  name appears in the profile's unknown-routing-critical list.
- Context window and maximum output are documentation-only. Pi's registry is
  the runtime context-window authority. Profile figures support only a
  cross-check warning.

**Standing limitation: the automated checks cover only part of the
research data.** Slate's automated checks are a development harness
in the source repository. The harness is not part of the published
package. The checks assert table structure. They verify that ids and
aliases resolve. They verify that ladders are duplicate-free subsets
of pi's vocabulary. They verify that the measured and gap lists are
disjoint and cover the ladder. They also verify that tiers remain in range, unsourced markers have the expected
shape, and the table is frozen. Resolver and doctrine checks verify configured
order, exact provider-qualified registry rates, zero and unknown components, and
the absence of automatic selection. A tier move can still pass because tier is
advice rather than an ordering key. An invented hazard clause or evidence clause can
also pass. Other numeric and evidential fidelity to the research
remains a review concern. A green suite covers only the fields that
the checks assert.

## Accepted limitations

- **Frozen per session.** Candidate and credential resolution is cached. A
  configuration or credential change needs a new pi session.
- **Router off requires action arguments.** The candidate list is disabled. Every dispatch still names model, effort, and reason.
- **No context-size routing.** Slate does not substitute a wider model before an
  action. Pi owns compaction and context overflow behavior.
- **No long-context billing notice.** Slate does not print a long-context billing notice.
