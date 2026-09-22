# Logical-model routing and recovery

This document defines Slate's provider-free action policy and common recovery
rules. It is reference documentation, not workflow doctrine.

## Action contract

Every `thread` call names one logical `model` and one non-empty `reason` of at
most 200 characters. The caller does not choose effort. Each logical definition
owns one fixed ordinary effort. A definition also owns capability and cost
ratings, a preferred provider, exact provider-to-model permissions, guidance,
and cautions.

A physical route is one exact provider and Pi model identifier. Slate never
infers provider equivalence from aliases, names, registry entries, or benchmark
deployments. Pi owns discovery, authentication, credentials, and execution.
Slate validates each planned route against the immutable policy and Pi's current
registry and credential result before a switch.

Every managed worker request also crosses Pi's provider-neutral stream input.
Slate checks the current exact physical provider and model, the action owner and
session lifetime, and Pi's request reasoning value. Undefined reasoning is the
normal representation of `off`. The same check covers initial work, later turns,
recovery continuation, and worker history compaction.

The first refused request permanently closes its action. Slate refuses every
later request of that action before Pi handoff. Slate also refuses a later
request that carries the pair the action expects now. Slate starts no ordinary,
recovery, substitute, or replay request after that refusal.

A closed action fails visibly. It keeps the work that it completed before the
refusal. It also keeps the pair that it accepted last. This rule is not the busy
refusal for overlapping recovery, which the ownership section below describes.

A request remains pending while it waits for pacing capacity. One synchronous
local event performs final validation, applicable throttle admission, accepted
pair attribution, and Pi handoff. Cancellation or lifecycle invalidation before
this event creates none of those facts. Cancellation after it does not remove
them. The accepted pair proves only Slate's local Pi handoff. It does not prove
transport, provider-native payload fields, the model served by a remote gateway,
or billing.

`requestedModel` and `requestedEffort` remain the initial physical pair before
failover. Final `model` and `effort` identify only the latest accepted local
handoff. A blocked request cannot replace them. An action with no accepted
request has no final pair.

The orchestrator selects a logical model from action fit, relevant area guidance,
behavioral cautions, capability evidence, and a lower supported cost rating. A
higher capability or cost rating is not enough by itself. Guidance and cautions
direct selection, but Slate does not enforce them at runtime. Shipped preferences
are not rigid rankings and do not guarantee quality. Apply a more specific active
guideline when it states an exception to a general preference. A reference to
another model describes a conditional preference and does not require selecting
an excluded model. Trusted project definitions can replace shipped guidance, and
custom model definitions remain supported. Guidance and cautions create no
runtime eligibility or rejection rules. A track with no proved focus area uses
this same ordinary rule. It has no sourced-tier threshold,
highest-tier fallback, or mandatory user-choice gate.

## Shipped definitions

Capability and cost ratings are fixed project judgments from 1 through 100. A
higher capability rating means stronger expected capability. A higher cost
rating means greater expected expense. Ratings are not percentages,
measurements, price ratios, statistical claims, realized costs, or billing
forecasts. Membership changes do not rescale them.

| logical model | ordinary effort | capability | cost | preferred provider | exact initial permission | guidance | cautions |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `gpt-5.6-luna` | `max` | 45 | 10 | `openai` | `openai/gpt-5.6-luna` | Auxiliary tasks only, such as file location or check-result collection. Never primary research, implementation, design, or review. Consumer-contract work only when auxiliary. | scope caution below |
| `claude-sonnet-5` | `high` | 40 | 90 | `anthropic` | `anthropic/claude-sonnet-5` | none | scope caution below |
| `gpt-5.6-terra` | `max` | 50 | 55 | `openai` | `openai/gpt-5.6-terra` | Prefer for implementing and reviewing user-facing prose. Prefer for routine text management, including organizing research logs. | none |
| `gpt-5.6-sol` | `high` | 58 | 40 | `openai` | `openai/gpt-5.6-sol` | Default thread choice. Prefer for changes that amend governing rules expressed in prose. This Sol governing-rule preference overrides the general Flash preference. The Astra preference for design and code reviewers of focus areas that trigger high-level design overrides this Sol governing-rule preference. Sol should remain available when Gemini produces weak evidence, misses a requirement, or when a different approach could help. Switching models should have a concrete reason. | blocked-action caution below |
| `gemini-3.8-flash` | `medium` | 55 | 30 | `google-vertex` | `google-vertex/gemini-3.8-flash` | Default thread choice. Generally prefer over Sol and Luna when available. A more specific active guideline overrides this general Flash preference. Concurrency, data-loss, performance. | reviewer and evidence caution below |
| `claude-opus-5` | `high` | 72 | 80 | `anthropic` | `anthropic/claude-opus-5` | concurrency, data-loss, performance | scope caution below |
| `gpt-6-astra` | `medium` | 86 | 60 | `openai` | `openai/gpt-6-astra` | Prefer when available for design and code reviewers of focus areas that trigger high-level design. This Astra preference overrides the Sol governing-rule preference. Security and performance work. Do not select Astra as the default implementer. Use Astra for review only when assigned to a specific focus area. Use Astra for research when appropriate. If a lower-capability model repeatedly fails at implementation, first ask Astra to investigate and provide detailed repair instructions. Let the implementer try those instructions. Use Astra as the implementer only if that guided attempt also fails. Treat that use as an exception. Select another suitable model for later implementation work. Existing approval requirements and repair limits still apply. | none |

Sonnet and Opus use this caution: `May exceed explicit scope or infer permission
from earlier requests. Check changes against stated exclusions and approval
requirements.` Sol uses this caution: `When blocked, may substitute unapproved
resources or perform destructive cleanup. Require permission before either
action.` Luna uses this caution: `May treat supplied repair context as
permission to implement despite explicit task limits. Restrict write access for
record-only work and verify the changed files.` Flash uses this caution: `Do not
use as a reviewer. It relies too much on passing tests and exact-size assertions.
Verify source citations and distinguish proposed behavior from existing
behavior.` Fable is not active because it has no complete
approved definition.

The independent shipped compressor list contains one entry. It is
`claude-sonnet-5` at `medium`. Ordinary Sonnet remains at `high`.

The ratings are project judgments informed by DeepSWE v1.1 by DataCurve and
reviewed supporting evidence. The live source is
<https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json>. The project
retrieved it on 2026-09-11. The 2026-09-18 rating decision reused that evidence
without a refresh. The live source has no confirmed licence bridge for every
newer result. Slate publishes no raw task, trajectory, leaderboard row, copied
publisher prose, or copied table structure. This attribution is not a new
licence grant.

## Configuration

Slate reads home preferences from `<getAgentDir()>/slate.json` first.
This path defaults to `~/.pi/agent/slate.json` and respects `PI_CODING_AGENT_DIR`.
Trusted project preferences in `.pi/slate.json` override home preferences.

Objects merge recursively. Arrays, scalar values, and explicit `null` replace.
The merged `router` is then validated as one policy. An invalid permitted file
blocks routing even when the other file is valid.

An untrusted project receives home preferences over shipped defaults, without
project router text. When a home configuration file permits a valid policy,
the session retains recovery preferences for successful provider and compressor
selections. These preferences belong to the session, not to the project file.
The resolved parent-session policy is immutable. A configuration edit requires a
new session.

```json
{
  "router": {
    "models": {
      "include": ["gpt-5.6-luna", "claude-sonnet-5", "gpt-6-astra"],
      "add": [],
      "replace": [],
      "exclude": []
    },
    "compressor": {
      "models": [{ "model": "claude-sonnet-5", "effort": "medium" }]
    }
  }
}
```

Omitted `include` starts with all seven shipped ordinary definitions. An explicit
empty `include` starts with an empty ordinary pool. `exclude` applies last and
wins.

Every `add` entry requires exactly these eight fields:

| field | accepted value |
| --- | --- |
| `model` | A new provider-free name. It starts with a lowercase letter or digit. Later characters can also be `.`, `_`, or `-`. |
| `capabilityRating` | An integer from 1 through 100. |
| `effort` | One fixed value from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `costRating` | An integer from 1 through 100. |
| `preferredProvider` | One provider name that is also a key in `providers`. A provider name starts with a lowercase letter or digit. Later characters can also be `.`, `_`, or `-`. |
| `providers` | A non-empty object that maps each provider name to one exact Pi model identifier. The provider is the key. The physical model identifier is the value. |
| `guidelines` | An array of non-empty strings. The array can be empty. |
| `cautions` | An array of non-empty strings. The array can be empty. |

A physical model identifier starts with a letter or digit. Later characters can
also include `.`, `_`, `:`, `/`, or `-`. The provider names `__proto__`,
`prototype`, and `constructor` are invalid. The provider map grants only the
exact provider and model pairs that it contains.

Complete `add` example:

```json
{
  "router": {
    "models": {
      "include": [],
      "add": [
        {
          "model": "project-fast",
          "capabilityRating": 48,
          "effort": "medium",
          "costRating": 20,
          "preferredProvider": "acme",
          "providers": {
            "acme": "acme-fast-v2",
            "acme-backup": "acme/fast-v2"
          },
          "guidelines": ["small bounded changes"],
          "cautions": []
        }
      ]
    }
  }
}
```

Every `replace` entry requires `model`. That name must identify an existing
shipped definition. An entry added in the same configuration cannot also appear
in `replace`. A replacement can supply any subset of the other seven definition
fields.
Omitted fields keep their existing values. A replacement that changes `effort`
must also supply both ratings. Repeating the existing effort does not require
the ratings. Every supplied field follows the same rules as an `add` field.

Complete `replace` example:

```json
{
  "router": {
    "models": {
      "replace": [
        {
          "model": "gpt-5.6-sol",
          "effort": "max",
          "capabilityRating": 58,
          "costRating": 40,
          "preferredProvider": "gateway",
          "providers": { "gateway": "openai/gpt-5.6-sol" },
          "guidelines": ["repository-wide implementation"],
          "cautions": []
        }
      ]
    }
  }
}
```

A supplied provider map, guidance list, or caution list replaces the whole field.
Slate does not merge those values. Replacing an unrelated field preserves source
attribution for unchanged fields. Compressor membership is independent from
ordinary membership. Omitting it inherits Sonnet at `medium`. An explicit empty
compressor list is a blocking error. No hidden compressor follows it.

Unknown fields, duplicate names, incomplete definitions, invalid ratings, invalid
efforts, ambiguous operations, and unknown references are critical errors. They
block logical work before dispatch. Slate reports each critical error. Legacy
`modelFailover`, `episodeModel`, array-form `router.models`,
`router.allowUnmeasuredEffort`, and `router.showWarnings` values are named and
ignored. Slate performs no automatic migration.

`/slate effective` separates configured preferred providers from remembered
successful providers. It shows ordinary membership, definitions, fixed efforts,
exact permissions, compressor order, errors, warnings, and evidence limits. It
contains no authentication material.

## Prompt limits

The complete logical-model prompt section includes its instructions, table
header, formatting, and every ordinary row after sanitation. Slate rejects a
policy above 19,400 portable characters or 105 lines. Equality is accepted.
Nothing is truncated. The error identifies a responsible model or field.
Portable measurement removes each installed documentation-directory prefix and
keeps each filename. The whole-doctrine verification ceiling of 25,800 portable
characters is separate. [context-budget.md](context-budget.md) publishes the
current measured fixtures.

## Completion recommendations

Trusted projects can set `workflow.routingRecommendations` to `true`. At change
completion, the orchestrator then offers short routing advice in the final
report before final acceptance. The setting defaults to `false`.

The evidence set contains only current-change action records that name a
dispatched logical model. Current workflow context defines the change boundary.
The orchestrator does not treat all session history as evidence. An action with
no logical-model record supplies no model evidence.

A recorded logical name proves the selection. It does not prove which physical
model executed. Recovery can change the physical route. Final `model` and
`effort` prove only Slate's latest accepted local Pi handoff, under the limits in
§ Action contract. A failover is not evidence that one logical model has better
capability than another.

The advice separates direct observation from tentative inference. Each
recommendation names its evidence. Existing guidance and cautions are the first
adjustment targets. Changes to effort, ratings, provider permissions, provider
preference, or membership need sufficient empirical evidence for that exact
change. One result does not support a broad benchmark or capability claim.

The advice is advisory and ready to copy. When the feature is enabled, the
change package always includes its routing field. Weak evidence produces no
invented recommendation. It produces the exact no-change statement required by
[delivery-packages.md](delivery-packages.md) § Change package. The feature does
not edit any file. It does not authorize a model selection, a new model, or a
roster change.

## Common recovery

Pi retries the active physical route first with its active effort. Slate begins a
transition only after Pi reports known retry exhaustion for an eligible temporary
connection, timeout, rate-limit, or server failure. Authentication, billing, and
context-window failures do not begin transient recovery. Cancellation and unknown
exhaustion evidence stop recovery visibly.

Recovery tries the remembered successful provider first on later actions. It then
tries an unvisited configured preferred provider and the remaining exact provider
map order. Providers for one logical identity are exhausted before another
logical model or compressor entry. Each exact provider and model pair is entered
at most once in one recovery operation.

Ordinary recovery exhausts untried models at the active capability rating by
ascending cost rating. Configured order resolves equal costs. It then alternates
to the nearest higher and lower occupied ratings. Distance uses rating values.
When one side is exhausted, recovery continues on the other side. A healthy main
session never switches automatically.

Compression follows configured entry order and never moves backward or wraps in
one operation. A successful later entry can become the remembered start for a
later action. Starting there excludes earlier entries until preference reset.
A newer admission wins the freshness comparison only when the publication is
otherwise permitted. Freshness never permits a move to an earlier entry.
If that entry and its tail fail, Slate retains the bounded uncompressed completed
result with a compression-failure notice. This accepted limitation can leave an
earlier healthy compressor unused. The shipped one-entry default cannot reach it.

## Ownership, success, and stops

One recovery operation owns its execution session through validation, switching,
restoration, continuation, and failure handling. Slate also shares saved-default
ownership between main recovery and handoff adoption. An overlapping operation
receives a prompt visible busy refusal. Slate does not queue, replay, or retry the
refused operation automatically. A later request reevaluates live state.

Only a successful action publishes a remembered provider or compressor selection.
Failure, cancellation, interruption, and unknown outcomes publish nothing.
Action admission order defines preference freshness. A later-started success wins
over an earlier-started success. Preference reset invalidates publication from
every earlier admission. Reopening, replacement, and handoff clear preferences.

Main recovery reverse-maps the active physical route. Zero logical matches stop
and request a user model choice. Several matches also stop unless the session has
an explicit trusted logical identity. Slate never chooses the first definition
for an unknown or ambiguous route. Main recovery stays available during handoff
pause. An unresolved stop keeps worker dispatch paused while brief writing waits
for the user choice.

Pi 0.85.1 model and effort switches are session-only unless the caller explicitly
requests persistence. Slate retains shared saved-default ownership and its
compatibility restoration guard. The guard still protects explicit persistence
and older behavior. A restoration failure is visible and can leave the changed
default in place.

## Package reliance boundary

`extension/index.ts` is the supported package entry point. Slate also ships the
TypeScript files under `extension/` because Pi loads that entry from source. The
exports in `extension/logical-model-runtime.ts` and the retry-evidence exports in
`extension/logical-model-adapters.ts` are internal implementation details. They
can change without compatibility support. This boundary does not change the
supported extension, tools, commands, configuration, or documented history
formats.

## Durable facts and accepted limits

Slate records the selected logical action name in a new optional history field.
Existing `requestedModel` and `requestedEffort` fields remain physical request
facts. Final model and effort remain actual physical and post-clamp facts.
Existing compressor attribution remains the final physical compressor. Old
history is never reinterpreted as logical data.

Slate never automatically resubmits a completed recorded tool call. Recovery
continues from retained worker state and persisted tool results. A model can still
issue a new equivalent call after recovery. Slate has no effect ledger and makes
no zero-repetition claim.

A completed fact is a completed tool result or nonblank assistant text observed
at `message_end`. Finalized text counts for every stop reason, including
`error`, `aborted`, and `length`. Streaming deltas, blank finalized text, and a
tool-call-only assistant message are not completed facts. Empty and non-text
tool results still record their completion. Slate need not retain image or
binary bytes. The omission marker reports content that the record does not keep.

Completed-fact capture starts before `session_start`. It continues through
ordinary turns, retry, compaction, recovery, cancellation, and teardown. The
capture keeps a bounded suffix of the newest facts in completion order. It
bounds each fact while it traverses the input and before aggregate serialization.
One marker states when older facts or fact content were omitted or truncated.
Mutable Pi message history is not the retention authority. Managed-operation
bookkeeping contains active operations only. A settled operation leaves that set.

The pre-finalization worker execution starts with worker startup. It includes
ordinary prompting, retry, recovery, Pi message calls made by worker extensions,
later turns and worker history reduction started by those calls, and Pi idle
confirmation. It excludes capture freeze, outcome classification, compression,
episode write, final state save, worker shutdown, and disposal. Independent
background tasks are also excluded.

A terminal transition closes managed-operation and provider-request admission
before it requests abort. Slate then awaits the pre-finalization worker execution.
Every included operation admitted before closure remains joined. A post-closure
operation does not invoke Pi and does not create a route-contract refusal. Slate
freezes completed facts once after that settlement. All terminal callers share
one finalization outcome.

After freeze, Slate classifies the outcome, compresses the bounded record or
builds its bounded fallback, writes episode bytes, saves the state reference,
and only then emits worker shutdown and disposes the session. Manager teardown
starts or joins finalization from outside the pre-finalization worker execution.
It awaits the whole sequence without making that execution wait for its own
finalization. Episode write, final state save, shutdown, and disposal each run at
most once for that outcome. Independent failures remain visible. Compression
failure never replaces the worker outcome. A state-save failure can leave episode
bytes without a proved durable reference.

Cancellation or manager teardown after a completed fact creates a durable failed
episode. Cancellation before any completed fact can end without an episode even
when Slate accepted a request. Slate sets no new timeout. A startup handler,
tool, provider, or included extension message call that ignores abort can keep
settlement pending. Independent background tasks remain outside this guarantee.

Completed tool and assistant content can reach the configured compressor and
current local worker and episode artifacts. Existing process umask and ancestor
directory permissions still govern local access. Slate adds no redaction,
confidentiality, permission, migration, replay, queue, attempt ledger, or
accepted-pair ledger. A real durable-write failure can still prevent an episode
and remains visible.
