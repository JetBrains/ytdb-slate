# Orchestrator context budget

`contextBudget` in home or trusted project `slate.json` sets the ABSOLUTE
token count at which Slate pauses the orchestrator and prepares the
fresh-session handoff. It replaces the deprecated percentage knob.
This document is reference documentation, not workflow doctrine.

## Why absolute tokens, not a percentage

pi's registry context windows differ per model: current Anthropic
flagships are registered at 1,000,000 tokens; `claude-haiku-4-5`,
`claude-opus-4-1`, and `claude-opus-4-5` (and their dated aliases)
at 200,000; direct-OpenAI GPT-5.6 models default to 272,000 as a
pricing-tier guard (the full 1.05M window is opt-in). One percentage
cannot express a consistent orchestrator budget across those
denominators — 40% of a flagship Claude is 400K tokens; 40% of a
GPT-5.6 is 108.8K. An absolute budget says what it means on every
model.

## The OpenAI pricing cliff

OpenAI long-context pricing is request-wide: a request whose total
input exceeds 272K tokens bills the ENTIRE request at long-context
rates. The multipliers are the tier pattern — 2× input, 1.5×
output, 2× cache read, 2× cache write; the dollar figures are
`gpt-5.6-sol`'s registered rates (absolute rates vary per model):
input $5→$10/M, output $30→$45/M, cache read $0.5→$1/M, cache
write $6.25→$12.5/M. In an agent loop the whole conversation is
resent every turn, so once the boundary is
crossed, every subsequent turn stays at those rates. The budget's
job is to stop the orchestrator before that happens.

## Defaults

- **256,000** — the built-in default, ≈16K under the 272K boundary
  so the pause turn and the handoff brief itself stay on
  short-context rates.
- **`anthropic/.*` → 400,000** — a built-in override for Anthropic
  models, preserving continuity with the previous 40%-of-1M default
  on flagship Claude.

## Configuration

Set `contextBudget` in home `<getAgentDir()>/slate.json` or project
`.pi/slate.json`. Project values apply only when the project is trusted.
Objects merge recursively before budget validation. Arrays, scalar values,
and explicit `null` replace the home value. Untrusted projects use home
preferences over the built-in defaults. The [configuration reference](configuration.md)
defines file locations and error handling.

The setting accepts a bare positive integer, shorthand for `{"tokens": N}`,
or an object:

```json
{
  "contextBudget": {
    "tokens": 256000,
    "overrides": [
      { "match": "openai/gpt-5\\.6-.*", "tokens": 240000 },
      { "match": "anthropic/.*", "tokens": 400000 }
    ]
  }
}
```

Each override's `match` is an anchored regex tested against the full
`provider/id` spec. The FIRST matching override wins, in config
order. Precedence overall: user override → user scalar (`tokens`) →
built-in `anthropic/.*` rule → built-in default. Invalid input is
warned about and never silently changes behavior; what applies
afterwards depends on where the damage is:

- An invalid WHOLE value (bad number, wrong type) is treated as if
  `contextBudget` were unset: legacy percent mode if
  `pauseThresholdPercent` is configured, built-in budget defaults
  otherwise.
- An invalid `tokens` inside an otherwise valid object is dropped —
  the object still opts into budget mode, so the built-in defaults
  fill the scalar layer.
- An invalid override entry is skipped — the next layer of the
  precedence chain applies.

Legacy note: `pauseThresholdPercent` is deprecated; it keeps its
exact old semantics only when it is set AND `contextBudget` is
absent or entirely invalid — an invalid budget sanitizes to absent
and never disables the percent. A PARTIALLY invalid object (e.g.
`{"tokens": -1}`) remains a valid budget object: budget mode with
built-in defaults, percent ignored.

## The clamp

The configured budget is clamped against the model's registry
context window:

```
effective = min(budget,
                max(contextWindow − compactionReserve − 32768,
                    ceil(contextWindow / 2)))
```

`compactionReserve` resolves from pi's settings for the active model on every
calculation. The exact `provider/modelId` entry in `compaction.modelOverrides`
takes precedence over ordinary `compaction.reserveTokens`, then the default
of 16,384. Global and trusted project settings merge before this lookup.
Slate keeps one read-only settings snapshot, so model switches take effect
immediately but mid-session settings-file edits do not. If the settings reader
fails, Slate keeps its fallback of 16,384. The formula and half-window floor
above remain unchanged.

| Context window | Effective budget |
| --- | --- |
| 200K | 150,848 |
| 272K | 222,848 |
| 400K | 256,000 (default binds) |
| 1M (Anthropic) | 400,000 |

Rationale: the clamp guarantees the pause fires before pi's
auto-compaction and leaves room to write the handoff brief; the
half-window floor keeps small-window models usable.

## Writing-reminder cadence

The effective context budget does not set the hidden writing-reminder cadence.
With orchestrator mode active, Slate counts completed turns if the project is
trusted or a home configuration file exists. The default interval is 4 turns.
The configured range is 1 through 20 turns. The `writing.remindTurns` key sets the interval.

The `writing.remindOnFinding` key enables a trigger after a measured turn with a
model-visible finding. The trigger defaults to `true`. The `writing.findings`
key disables the trigger when it is `false`. The retired `writing.remindPercent`
key is accepted and ignored with a notice that the cadence changed from a token
share to a turn count.

A turn with a tool result receives a steer. A turn without a tool result receives
next-turn delivery. Slate counts aborted completed turns. It does not count a
provider retry attempt. An abort after a tool turn does not reopen the response
round. The counter restarts after delivery. A trusted handoff sets `forceNext`,
which bypasses the turn cadence on the next eligible turn. It does not bypass
the Slate configuration permission, orchestrator mode, or the pause gate.

The current hidden message has a checked worst case of 1,845 UTF-8 bytes. The
2,000-byte bound leaves a 155-byte reserve. The case includes the header, the
findings section with two capped quotations, ten writing requirements, seven
design requirements, retained style rules, separators, and scope exclusion.
The count excludes JSONL framing and provider-role overhead. The message enters conversation context only when a
reminder fires. Later requests resend it with the rest of the conversation.

## What always-loaded tool definitions cost the budget

The registered `thread` tool description is 973 UTF-8 bytes. Its serialized
parameter schema is 1,921 bytes from `JSON.stringify(parameters)`. The schema
requires logical `model` and `reason`. It includes the bounded `context` list,
the optional implementer `trackNumber`, the built-in `reviewPerspectives` list,
and the 200-character reason limit. The two values total 2,894 bytes before provider
framing. The figure excludes the tool name, prompt text, and outer serialization.

## Compaction policy

In orchestrator mode, for budget-driven configs only, a threshold-triggered
compaction while the session is unpaused becomes the Slate pause. Once paused,
threshold compactions pass through as an escape valve. Overflow-recovery
compaction and manual `/compact` remain unchanged.

While paused, Slate refuses new user prompts at the Pi input hook. Registered
extension commands run before that hook, so `/slate resume` and `/slate handoff
[focus]` remain available. Orchestrator worker dispatch also remains available
for state saving. The `thread` tool applies no pause rule.

Slate reports each refused prompt once. The orchestrator must use one state-save
worker at a time. It must wait for the result and verify success. It must report
incomplete preparation rather than claim that the research log was saved.

Remote steer or follow-up, compaction-buffered input, and input accepted before
the pause can bypass the hook. These are accepted limits of the pinned Pi input
surface.

## What the always-loaded doctrine costs the budget

The doctrine is sent in every orchestrator request. Raw size depends on the
installed package path because the doctrine cites shipped documents by absolute
path. A **portable character** count removes every exact installed `docs/`
directory prefix and keeps each filename.

> rendered characters = portable characters + embedded path count × installed
> documentation-directory length

The logical-model runtime limit and doctrine regression budgets have different
jobs. The runtime accepts a logical section at exactly 19,400 portable characters
and 105 lines. It rejects 19,401 characters or 106 lines. The five-percent reserve
rule applies to measured regression baselines. It does not apply to an input
constructed to equal a runtime rejection boundary.

These measurements execute the real `before_agent_start` doctrine hook. The
capped worker fixture has two units and four tools. Unit labels use 128
characters. Tool names use 64 characters. Descriptions use 140 characters.

| fixture | paths | portable characters | lines |
| --- | ---: | ---: | ---: |
| shipped logical section | 0 | 3,892 | 11 |
| trusted shipped-default doctrine | 5 | 8,764 | 88 |
| untrusted doctrine without a home configuration file | 4 | 2,775 | 47 |
| draft pull requests, shipped policy | 6 | 8,839 | 89 |
| capped workers, shipped policy | 5 | 10,111 | 98 |
| draft plus capped workers | 6 | 10,186 | 99 |
| deferred issues plus capped workers | 5 | 10,185 | 99 |
| routing recommendations plus capped workers | 5 | 10,208 | 99 |
| draft plus deferred issues and capped workers | 6 | 10,260 | 100 |
| draft plus routing recommendations and capped workers | 6 | 10,279 | 100 |
| deferred issues plus routing recommendations and capped workers | 5 | 10,282 | 100 |
| canonical maximal baseline with all workflow options | 6 | 10,353 | 101 |
| maximal baseline with an open change | 6 | 10,551 | 102 |
| maximal baseline with source and legacy root log | 6 | 10,781 | 104 |
| dogfood `.pi/slate.json` and its two extension units | 6 | 9,478 | 100 |
| runtime boundary plus draft and capped workers, source and legacy log | 6 | 26,122 | 102 |
| runtime boundary plus draft and deferred issues, source and legacy log | 6 | 26,196 | 103 |
| runtime boundary plus routing recommendations, source and legacy log | 5 | 26,144 | 102 |
| runtime boundary plus deferred issues and routing recommendations, source and legacy log | 5 | 26,218 | 103 |
| runtime boundary plus draft and routing recommendations, source and legacy log | 6 | 26,215 | 103 |
| same boundary composition plus deferred issues | 6 | 26,289 | 104 |
| valid shipped policy plus 88 capped worker tools, source and legacy log | 6 | 28,455 | 187 |

An untrusted session with an empty home `slate.json` receives the same doctrine
as the trusted shipped-default fixture above. It includes routing and writing
rules. `test/config-loading.test.ts` renders both through the real entry hooks
and checks that equality. Home preferences can change this size, just as trusted
project preferences can.

The canonical maximal baseline uses all six shipped logical definitions, all
three workflow options, and the fixed capped worker roster. Its largest variant
has an open change, one direct source folder, and a legacy root log. Its
five-percent requirement is `ceil(10,781 × 1.05) = 11,321`.
The 26,300 whole-doctrine ceiling exceeds it. The table pins all eight
combinations of the three workflow options with the capped worker roster. The
dogfood row reads the actual project configuration. A change to `.pi/slate.json` requires a fresh render.

The four routing-enabled rows from 26,144 through 26,289 are
boundary-composition controls. The 26,122 and 26,196 rows keep the
routing-recommendation feature off as compatibility controls. The 26,289 row
pins the largest supported composition. It has 11 characters of headroom.
Each row combines a valid logical section padded to exactly 19,400 characters with supported doctrine tails. The rows do not define reserve-bearing
baselines. Every row remains below the 26,300 portable-character ceiling.
A valid third worker unit with a 5-character label reaches 26,300 exactly
when all three workflow options are on. A 6-character label reaches 26,301,
the first value beyond the ceiling.

The over-cap counterfactual uses a valid shipped logical policy and one supported
worker-extension unit with 88 capped tools. It also includes an open change,
its source, and the legacy root log. Its 28,455 portable characters exceed
the whole-doctrine ceiling by 2,155. The check therefore detects whole-doctrine
growth without using a retired model-row shape or an assumed per-tool increment.
Worker-extension doctrine has no runtime size cap, so the fixture reaches the
whole-doctrine guard rather than failing logical-policy validation first.

Exact literals fail on any fixture size change. Coarse ceilings stop cumulative
growth. A changed fixture requires fresh production rendering and matching updates
to this table, `verification/README.md`, resolver checks, and doctrine contract
tests. The logical-section limits remain 19,400 characters and 105 lines. The
all-tail limit remains 24,600 characters. The whole-doctrine ceiling is 26,300 characters.

### Worker writing preamble

The doctrine table does not include the worker preamble. It belongs
to each worker session's system prompt, not to the orchestrator's
per-turn doctrine.

| Worker preamble form | UTF-8 bytes | Increase from base |
| --- | ---: | ---: |
| Base | 544 | — |
| Base + writing guidance | 1,097 | 553 |
| Base + reviewer charter | 2,699 | 2,155 |
| Base + writing guidance + reviewer charter | 3,252 | 2,708 |

The preamble explains that the harness runs calls issued in one turn at the
same time. It also explains that cumulative token cost grows with the square of
the number of turns because each turn resends the conversation history.

The writing guidance is 552 bytes. The reviewer charter constant is 2,154 bytes.
The writing addendum needs one separating space. The reviewer charter addendum
needs one separating newline. The current text uses UTF-8 punctuation, so byte
and character counts can differ.
This separate figure states the worker-session cost without presenting
it as orchestrator doctrine.

## Worker actions

The budget above applies to the orchestrator. Each worker session runs one action.
Slate does not select worker actions by prompt size. Pi owns worker compaction
and context overflow behavior. `model-routing.md` documents logical selection,
validation, and recovery.

| Worker context item | Measured UTF-8 bytes per copy | Copies after N turns | Cumulative appearances across N requests |
| --- | ---: | ---: | ---: |
| Simultaneous-tool-call reminder | 150 text; 203 converted request message; 319 persisted JSONL line | N - 1 | N × (N - 1) / 2 |

The reminder tells a worker to issue independent tool calls in one turn. `N` is
the total number of provider turns in one action. The first `N - 1` turns have
tool results that reach the reminder handler. The final turn returns the answer.

The 150-byte figure is the exact ASCII production text. The 203-byte figure is
the compact JSON form after pi converts the reminder to a provider request user
message with one text part. It excludes the volatile timestamp.

The 319-byte figure is one compact persisted `custom_message` record from pi
0.83.0, including its identifiers, timestamp, JSON framing, and final line-feed
byte. These figures contain no installed path, so the portable and rendered
counts are identical.

Before automatic compaction, transcript storage grows in proportion to the number
of turns. Cumulative request appearances grow with the square of the number of
turns. Provider cache reads can lower billed input without changing the number of
logical appearances.

### Implementation reference and specialist charters

The implementation reference is one exact block in each implementation dispatch.
Each of the four specialist charter figures measures its complete shipped file,
including the level-one heading and final line feed. An automatic implementation
review loads the common policy and implementation input once. The input file includes
one shared design-quality rule after the input restrictions. Slate then loads each
selected perspective once in selection order. Each perspective file includes its
questions and examples of useful evidence.

| bounded block | exact UTF-8 bytes |
| --- | ---: |
| implementation-dispatch focused-context reference | 351 |
| non-local logic defect reviewer charter | 2,464 |
| consumer contract break reviewer charter | 2,748 |
| governing-rule defect reviewer charter | 2,857 |
| unreported failure reviewer charter | 2,389 |

Production-rendered injected text replaces the two installed-path placeholders
with absolute shipped paths. The path-normalized count removes the exact
installed `docs/` and `extension/` directory prefixes and keeps each filename.
The generic reviewer evidence charter, task, provider framing, and manually supplied review data are
outside these figures. Counts are UTF-8 bytes, not token or billing estimates.
The two shared files appear once in each total. The shared design-quality rule
appears once inside the implementation input file. Each selected file contributes
its questions and evidence examples once. A merged specialist review adds each
selected file once and does not repeat the shared files.

| selected perspective | rendered injected bytes | path-normalized injected bytes |
| --- | ---: | ---: |
| Reviewer I | 8,575 | 8,452 |
| Concurrency reviewer | 7,329 | 7,206 |
| Data loss and recovery reviewer | 7,524 | 7,401 |
| Security reviewer | 7,471 | 7,348 |
| Performance reviewer | 7,526 | 7,403 |
| Test-quality and structure reviewer | 8,780 | 8,657 |
| Prose reviewer | 7,738 | 7,615 |
| Licensing reviewer | 7,469 | 7,346 |
| Non-local logic defect reviewer | 8,466 | 8,343 |
| Consumer contract break reviewer | 8,750 | 8,627 |
| Governing-rule defect reviewer | 8,859 | 8,736 |
| Unreported failure reviewer | 8,391 | 8,268 |

The focused-reference figure measures one reference copy in one implementation
dispatch. It excludes the research log and every other task input. Worker history
can resend that reference in later model requests. The figure is not a total
conversation-size or billing promise. Each charter row measures one role file.
These figures add no runtime limit and raise no existing budget. The on-demand
P13 author guideline contains 2,292 UTF-8 bytes. Its separate principle-table
row contains 201 bytes. Neither enters injected totals or the always-loaded
principle subset.

## Using GPT-5.6's full 1.05M window

Two deliberate steps. First, raise the registry window in
`~/.pi/agent/models.json` (pi's custom-models file — NOT
`settings.json`, where this block is silently ignored):

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": { "contextWindow": 1050000 }
      }
    }
  }
}
```

(repeat for `gpt-5.6-terra` / `gpt-5.6-luna`). Second, raise the
Slate budget with an override in `.pi/slate.json` — the full nested
form matters: a bare `{"match": …, "tokens": …}` pasted as the
`contextBudget` value becomes a global scalar with `match` silently
dropped:

```json
{
  "contextBudget": {
    "overrides": [
      { "match": "openai/gpt-5\\.6-.*", "tokens": 900000 }
    ]
  }
}
```

WARNING: beyond 272K total input every request bills at the
long-context rates listed above.

Logical-model routing does not change this context-window setting. Pi's registry
remains the runtime source for context capacity. Slate validates permitted routes
against that registry but does not compare it with a second profile window.

## Accepted limitations

- On models with a 272K pricing tier and a larger registry window
  (`gpt-5.4-pro`, `gpt-5.5-pro`, GPT-5.6 after the opt-in above), a
  >16K single-turn overshoot near the 256K default can bill the
  final turns at long-context rates — override to 240,000 to widen
  the margin.
- The 32K margin in the clamp covers typical turns, not extreme
  single-turn ingestion (several parallel large file reads) — hand
  off earlier or set a lower override when running tier-priced
  models hard.
- The pause-fires-before-compaction guarantee holds for single-turn
  ingestion under 32,768 tokens — and only where the margin branch
  of the clamp binds (context window ≥ ~98K with the default
  16,384-token reserve); on smaller, floor-clamped windows the
  pre-compaction margin is narrower. Beyond the margin a pass-through
  compaction can land in the same cycle and the handoff brief is
  written from compacted context — episodes and thread state survive
  on disk, so handoff still functions.
- The doctrine sizes above cover the stated fixtures only. A project that
  injects `doctrineExtraPath` or `orchestratorPromptDocs` pays for those on top.
  A larger worker-extension roster also adds context beyond the representative
  fixtures. Slate imposes no runtime doctrine-size limit. This content simply
  leaves less room under the context budget.
