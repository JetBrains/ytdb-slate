# Orchestrator context budget

`contextBudget` in home or trusted project `slate.json` sets the ABSOLUTE
token count at which Slate pauses the orchestrator and prepares the
fresh-session handoff. It replaces the deprecated percentage knob.
This document is reference documentation, not workflow doctrine.

## Why absolute tokens, not a percentage

pi registers `anthropic/claude-sonnet-5-5` and `anthropic/claude-opus-5-5`
with 1,000,000-token context windows. It registers `openai/gpt-6.1-sol`,
`openai/gpt-6-luna` and `openai/gpt-6-astra` with 272,000-token windows.
It registers `google-vertex/gemini-3.8-flash` with 1,048,576 tokens.

One percentage cannot express a consistent budget across these windows.
For example, 40% of the `anthropic/claude-sonnet-5-5` window is 400,000 tokens.
For `openai/gpt-6.1-sol`, 40% is 108,800 tokens.
An absolute budget states the token count directly.

## OpenAI long-context pricing

For `openai/gpt-6.1-sol`, a request above 272,000 input tokens uses long-context
rates for the full request. The input and cache rates double.
The output rate rises by a factor of 1.5.
The registered rates in dollars per million tokens are:

| Token type | Up to 272,000 input tokens | Above 272,000 input tokens |
| --- | ---: | ---: |
| Input | 2 | 4 |
| Output | 10 | 15 |
| Cache read | 0.10 | 0.20 |
| Cache write | 2.50 | 5 |

An agent loop resends the conversation on each turn.
A prompt cache hit can lower the cost of reused input tokens.
Cached tokens still count toward the pricing boundary and the context window.

## Default

The built-in budget is **400,000 tokens** for every provider.
The [clamp](#the-clamp) can lower the effective budget for smaller windows.
The budget is a pause threshold, not a price limit.

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
    "tokens": 350000,
    "overrides": [
      { "match": "openai/gpt-6\\.1-sol", "tokens": 240000 }
    ]
  }
}
```

Each override's `match` is a regular expression that matches the full
`provider/id` value. Slate uses the first matching override in file order.
Without a match, Slate uses `tokens` if set, or the built-in default.
Slate warns about invalid input:

- An invalid WHOLE value (bad number, wrong type) is treated as if
  `contextBudget` were unset: legacy percent mode if
  `pauseThresholdPercent` is configured, or the built-in budget otherwise.
- Slate drops an invalid `tokens` value from an otherwise valid object.
  The object still selects budget mode.
- Slate skips an invalid override entry.

Legacy note: `pauseThresholdPercent` is deprecated; it keeps its
exact old semantics only when it is set AND `contextBudget` is
absent or entirely invalid — an invalid budget sanitizes to absent
and never disables the percent. A PARTIALLY invalid object (e.g.
`{"tokens": -1}`) remains a valid budget object: budget mode with
the built-in budget, percent ignored.

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

With the built-in budget and the default compaction reserve:

| Context window (tokens) | Effective budget (tokens) |
| --- | --- |
| 200,000 | 150,848 |
| 272,000 | 222,848 |
| 400,000 | 350,848 |
| 1,000,000 | 400,000 |

The clamp subtracts a 32,768-token margin from Pi's compaction threshold
(the context window minus the reserve). The half-window floor can reduce
this margin. With a large reserve, the floor can put the pause threshold
above Pi's compaction threshold. Slate can cancel the first threshold
compaction and pause instead. This does not guarantee room for the brief.

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
parameter schema is 2,137 bytes from `JSON.stringify(parameters)`. The schema
requires logical `model` and `reason`. It includes the bounded `context` list,
the optional implementer `trackNumber` with canonical dotted identifiers,
the built-in `reviewPerspectives` list, and the 200-character reason limit.
The two values total 3,110 bytes before provider
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

The remote procedure call (RPC) commands `steer` and `follow_up` pass through the Pi input hook.
Pi also applies the hook when it sends input buffered during compaction.
Input accepted before the pause can still reach the agent.

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
| shipped logical section | 0 | 3,803 | 9 |
| trusted shipped-default doctrine | 5 | 8,611 | 72 |
| untrusted doctrine without a home configuration file | 4 | 2,711 | 33 |
| draft pull requests, shipped policy | 6 | 8,681 | 73 |
| capped workers, shipped policy | 5 | 9,958 | 82 |
| draft plus capped workers | 6 | 10,028 | 83 |
| deferred issues plus capped workers | 5 | 10,032 | 83 |
| routing recommendations plus capped workers | 5 | 10,011 | 83 |
| draft plus deferred issues and capped workers | 6 | 10,102 | 84 |
| draft plus routing recommendations and capped workers | 6 | 10,077 | 84 |
| deferred issues plus routing recommendations and capped workers | 5 | 10,085 | 84 |
| canonical maximal baseline with all workflow options | 6 | 10,151 | 85 |
| maximal baseline with an open change | 6 | 10,349 | 86 |
| maximal baseline with source and legacy root log | 6 | 10,579 | 88 |
| dogfood `.pi/slate.json` and its two extension units | 6 | 9,276 | 84 |
| runtime boundary plus draft and capped workers, source and legacy log | 6 | 26,053 | 86 |
| runtime boundary plus draft and deferred issues, source and legacy log | 6 | 26,127 | 87 |
| runtime boundary plus routing recommendations, source and legacy log | 5 | 26,036 | 86 |
| runtime boundary plus deferred issues and routing recommendations, source and legacy log | 5 | 26,110 | 87 |
| runtime boundary plus draft and routing recommendations, source and legacy log | 6 | 26,102 | 87 |
| same boundary composition plus deferred issues | 6 | 26,176 | 88 |
| valid shipped policy plus 88 capped worker tools, source and legacy log | 6 | 28,253 | 171 |

An untrusted session with an empty home `slate.json` receives the same doctrine
as the trusted shipped-default fixture above. It includes routing and writing
rules. `test/config-loading.test.ts` renders both through the real entry hooks
and checks that equality. Home preferences can change this size, just as trusted
project preferences can.

The canonical maximal baseline uses all four default logical models, all
three workflow options, and the fixed capped worker roster. Its largest variant
has an open change, one direct source folder, and a legacy root log. Its
five-percent requirement is `ceil(10,579 × 1.05) = 11,108`.
The 26,300 whole-doctrine ceiling exceeds it. The table pins all eight
combinations of the three workflow options with the capped worker roster. The
dogfood row reads the actual project configuration. A change to `.pi/slate.json` requires a fresh render.

The four routing-enabled rows from 26,036 through 26,176 are
boundary-composition controls. The 26,053 and 26,127 rows keep the
routing-recommendation feature off as compatibility controls. The 26,176 row
pins the largest supported composition. It has 124 characters of headroom.
Each row combines a valid logical section padded to exactly 19,400 characters with supported doctrine tails. The rows do not define reserve-bearing
baselines. Every row remains below the 26,300 portable-character ceiling.
A valid third worker unit with a 118-character label reaches 26,300 exactly
when all three workflow options are on. A 119-character label reaches 26,301,
the first value beyond the ceiling.

The over-cap counterfactual uses a valid shipped logical policy and one supported
worker-extension unit with 88 capped tools. It also includes an open change,
its source, and the legacy root log. Its 28,253 portable characters exceed
the whole-doctrine ceiling by 1,953. The check therefore detects whole-doctrine
growth without using a retired model-row shape or an assumed per-tool increment.
Worker-extension doctrine has no runtime size cap, so the fixture reaches the
whole-doctrine guard rather than failing logical-policy validation first.

Exact literals fail on any fixture size change. Coarse ceilings stop cumulative
growth. A changed fixture requires a fresh production render.
Update matching copies in `docs/context-budget.md` (including the phase-row table),
`verification/README.md`, `verification/resolver-checks.mjs`,
`test/doctrine-contract.test.ts`, `test/config-loading.test.ts`,
`test/logical-model-policy.test.ts`, and `test/focused-decisions-contract.test.ts`.
Check the phase-row table with `test/workflow-context-budget.test.ts`.
The logical-section limits remain 19,400 characters and 105 lines. The
all-tail limit remains 24,600 characters. The whole-doctrine ceiling is 26,300 characters.

The shipped model policy section has a separate limit of 3,994 portable
characters and 9 lines. The character limit is the measured 3,803 characters
plus five percent reserve, rounded up. The line limit has no reserve.
A fifth default model needs a new user approval. A higher limit requires a new user
approval.

For the comparison with the fixed earlier commit, both sides receive the same
candidate shipped policy input. The earlier code uses explicit default membership and adds candidate definitions
that it does not define. Trusted project configuration supplies these rows. A check requires equal resolved ordinary policy rows in the same order.
The check compares model names, both ratings, effort, preferred providers,
permitted provider routes, guidelines and cautions. It excludes source metadata.
This comparison does not measure growth of the shipped policy text.
It still rejects growth of all other doctrine text and growth caused by the
policy rendering code. Separate controls reject added text per caution row
and text added only with several rows.

### Worker writing preamble

The doctrine table does not include the worker preamble. It belongs
to each worker session's system prompt, not to the orchestrator's
per-turn doctrine.

| Worker preamble form | UTF-8 bytes | Increase from base |
| --- | ---: | ---: |
| Base | 1,317 | — |
| Base + writing guidance | 1,861 | 544 |
| Base + reviewer charter | 3,472 | 2,155 |
| Base + writing guidance + reviewer charter | 4,016 | 2,699 |

The preamble explains that the harness runs calls issued in one turn at the
same time. It also explains that cumulative token cost grows with the square of
the number of turns because each turn resends the conversation history.

The writing guidance is 543 bytes. The reviewer charter constant is 2,154 bytes.
The writing addendum needs one separating space. The reviewer charter addendum
needs one separating newline. The current text uses UTF-8 punctuation, so byte
and character counts can differ.
This separate figure states the worker-session cost without presenting
it as orchestrator doctrine.

### Change-folder guidance

Each admitted action adds one change-level system block after the preamble.
Record-writing types share one block. Review types share another.
The canonical change name uses a date stamp and 32 lowercase hexadecimal characters.
Its action path adds `/tmp/action.` and six allocator characters.

| Canonical addition | Block bytes | Separator bytes | Complete bytes | Limit |
| --- | ---: | ---: | ---: | ---: |
| Open-change record-writing system | 797 | 2 | 799 | 800 |
| Open-change review system | 311 | 2 | 313 | 350 |
| No-change record-writing system | 149 | 2 | 151 | 180 |
| No-change review system | 293 | 2 | 295 | 300 |
| Open-change hidden action message | 162 | 0 | 162 | 180 |
| No-change hidden action message | 0 | 0 | 0 | 0 |

The message includes both final line feeds. System blocks have no final line feed.
Open-change record-writing system totals are 2,116 or 2,660 bytes without or with writing guidance.
Open-change review system totals are 3,785 or 4,329 bytes without or with writing guidance.
These totals exclude selected review guidance, prompt documents, base Pi text, and provider framing.

The parent-session cache key stays unchanged.
System blocks vary by change and type group, never by action.
Otherwise matching inputs share a system prefix within that group and change.
Across changes, the shared prefix ends before the changed folder name.

Slate delivers the action path only in its generated hidden action message.
Compression input excludes that message.
Slate keeps the path out of system guidance and generated episode fields.
Worker messages, tool results, and compaction summaries can still quote the path.
Compaction preserves the change-level system block but can lose the hidden action message.
A worker without that path pauses destination-dependent writes.

Scratch placement excepts required outside-checkout tool folders under their own rules.
The record-writing block includes that exception within its 800-byte limit.

### Implementer task guidance

Slate adds report instructions to an implementer's task message.
The system preamble and task guidance have separate costs.
The track-3 fixture uses a canonical change folder and no earlier episodes.
Its generated guidance is 995 UTF-8 bytes without a source folder.
With a canonical source folder, the guidance is 1,377 bytes.
The count excludes the original task and its separating newlines.

| Writing guidance | System preamble bytes | Task guidance bytes, no source / source | Sum, no source / source |
| --- | ---: | ---: | ---: |
| Off | 1,317 | 995 / 1,377 | 2,312 / 2,694 |
| On | 1,861 | 995 / 1,377 | 2,856 / 3,238 |

The sums exclude message and provider framing.
They do not join the preamble and task as one system block.
These worker measurements are separate from the doctrine table and raise no budget.

## Worker actions

The budget above applies to the orchestrator. Each worker session runs one action.
Slate does not select worker actions by prompt size. Pi owns worker compaction
and context overflow behavior. `model-routing.md` documents logical selection,
validation, and recovery.

| Worker context item | Measured UTF-8 bytes per copy | Copies after N turns | Cumulative appearances across N requests |
| --- | ---: | ---: | ---: |
| Simultaneous-tool-call reminder | 330 text; 383 converted request message; 499 persisted JSONL line | N - 1 | N × (N - 1) / 2 |

The reminder tells a worker to issue independent tool calls in one turn. `N` is
the total number of provider turns in one action. The first `N - 1` turns have
tool results that reach the reminder handler. The final turn returns the answer.

The 330-byte figure is the exact ASCII production text. The 383-byte figure is
the compact JSON form after pi converts the reminder to a provider request user
message with one text part. It excludes the volatile timestamp.

The 499-byte figure measures one compact persisted `custom_message` JSONL line
from pi 1.4.0. It includes two eight-character identifiers, the timestamp, JSON framing
and the final line-feed byte. These figures contain no installed path, so the
portable and rendered counts are identical.

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
| Reviewer I | 8,664 | 8,541 |
| Concurrency reviewer | 7,418 | 7,295 |
| Data loss and recovery reviewer | 7,613 | 7,490 |
| Security reviewer | 7,560 | 7,437 |
| Performance reviewer | 7,615 | 7,492 |
| Test-quality and structure reviewer | 8,869 | 8,746 |
| Prose reviewer | 7,827 | 7,704 |
| Licensing reviewer | 7,558 | 7,435 |
| Non-local logic defect reviewer | 8,555 | 8,432 |
| Consumer contract break reviewer | 8,839 | 8,716 |
| Governing-rule defect reviewer | 8,948 | 8,825 |
| Unreported failure reviewer | 8,480 | 8,357 |

The rendered column uses installed directory prefixes totaling 123 UTF-8 bytes.
Prefixes totaling 145 bytes add 22 bytes to each rendered row. Portable counts stay unchanged.
These totals exclude the separate change-level review block and hidden action message.

The focused-reference figure measures one reference copy in one implementation
dispatch. It excludes the research log and every other task input. Worker history
can resend that reference in later model requests. The figure is not a total
conversation-size or billing promise. Each charter row measures one role file.
These figures add no runtime limit and raise no existing budget. The on-demand
P13 author guideline body contains 2,311 UTF-8 bytes. Its subsection heading
and following blank line add 35 bytes. The heading and body together contain
2,346 bytes. Its separate principle-table row contains 201 bytes. Neither enters injected totals or the always-loaded
principle subset.

P14 enters neither injected totals nor the always-loaded principle subset.
Read P14 only when reading [design-principles.md](design-principles.md).
Design-track planning alone does not require design-principles.md.
Explaining or changing Slate can require design-principles.md.
Unusual routing or compaction can also require design-principles.md.
Routine dispatch does not require design-principles.md.

The P14 body contains 429 UTF-8 bytes, including the final line feed.
The heading and body contain 457 bytes.
The separate principle-table row contains 145 bytes without its final line feed.
A blank separator before § 5 of design-principles.md adds one byte outside the 457-byte figure.
The complete design-principles.md document adds 604 bytes for P14.

## Using GPT-6.1 Sol's full 1.05M window

OpenAI documents a 1,050,000-token context window for `gpt-6.1-sol`.
Pi registers `openai/gpt-6.1-sol` with a 272,000-token window and a maximum
output of 128,000 tokens.
The registered window equals the long-context pricing boundary.
To use the larger window, first set `modelOverrides` in pi's custom-models
file, `~/.pi/agent/models.json`. Pi ignores this block in `settings.json`
without a message.

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-6.1-sol": { "contextWindow": 1050000 }
      }
    }
  }
}
```

Second, raise the Slate budget with an override in `.pi/slate.json`.
Keep the full nested form shown below.
A bare `{"match": …, "tokens": …}` used as the `contextBudget` value sets
a global token budget. Slate drops its `match`.
Slate reports a warning about the unknown key.

```json
{
  "contextBudget": {
    "overrides": [
      { "match": "openai/gpt-6\\.1-sol", "tokens": 900000 }
    ]
  }
}
```

With the default 16,384-token compaction reserve, the clamp allows
1,000,848 tokens for this window. The configured 900,000-token budget binds.
That budget is about 85.7% of the 1,050,000-token window.

WARNING: every request above 272,000 input tokens uses the long-context
rates listed above for the full request.

Logical-model routing does not change this context-window setting. Pi's registry
remains the runtime source for context capacity. Slate validates permitted routes
against that registry but does not compare it with a second profile window.

Compression requests are the one exception. On an OpenAI GPT-6-or-later route, a
compression request uses a context window of at least 1,050,000 tokens, as
[model-routing.md](model-routing.md) § Shipped definitions describes.

## Accepted limitations

- If the effective pause threshold exceeds the active model's pricing
  boundary, a request can use the higher rates before Slate pauses.
  This can happen with an expanded window or a larger registered window.
  For example, Pi registers `openai-codex/gpt-6.1-sol` with a 500,000-token
  window. With the default reserve, the built-in pause threshold is 400,000
  tokens, above the pricing boundary of 272,000 input tokens.
  To leave more room before the boundary, set a lower budget, such as
  240,000 tokens. Match the override to the active `provider/id`.
  The example override matches only `openai/gpt-6.1-sol`.
  One large turn can still cross the pricing boundary before the pause.
- A large turn can cross both the pause and compaction thresholds.
  If Slate has already paused, Pi can compact the context before the
  orchestrator writes the handoff brief. Episodes and thread state remain
  on disk.
- The doctrine sizes above cover the stated fixtures only. A project that
  injects `doctrineExtraPath` or `orchestratorPromptDocs` pays for those on top.
  A larger worker-extension roster also adds context beyond the representative
  fixtures. Slate imposes no runtime doctrine-size limit. This content simply
  leaves less room under the context budget.


<!-- workflow-phase:start -->
## Workflow context by phase

The doctrine is the workflow guidance rendered for the orchestrator. Each row
adds cumulative required document reads to that guidance. Earlier reads stay
in later rows. A later whole-file read replaces section ranges. Overlapping
ranges count once. Section ranges include headings, subsections, separators,
and final line feeds up to the next heading of the same or higher level. These rows describe one session from research to delivery. A change with more than one track hands off before each track, and the user runs each handoff. A session after a handoff holds less context than the rows for phases 7 to 9.

Each fixture uses trusted shipped policy, no worker extensions, and one open
change with a 56-character name. It has no source change. Deferred issues and
routing recommendations are off. Ordinary plans have no nested trigger.
Nested plans read the recursive workflow during research. Publishing adds
the publishing document during research. These are allowed compositions,
not maximum configurations. The 36 rows follow the lifecycle order, with four scenarios for each phase.

UTF-8 means Unicode Transformation Format, 8-bit. Bytes use UTF-8 source text.
Only the installed documentation-directory prefix is removed from doctrine.
Filenames and all other text remain. Estimated tokens equal ceil(bytes / 4)
for each complete total. This estimate is not a tokenizer result.
The excluded installed path cost is 5 times the prefix byte length with
publishing off and 6 times that length with publishing on. Tests measure
this cost separately. It depends on the installation path.

The user approved the limits for the other 35 rows on 2026-10-16.
Each of those byte limits is ceil(baseline bytes * 1.05).
The user approved the two limits for Research, publishing off, ordinary plan
on 2026-11-12. These limits are 76,835 and 145,471 bytes.
They equal the limits approved on 2026-10-16 plus 979 bytes of approved
shipped model policy growth. They carry no five percent reserve.
A higher limit requires a new user approval.
Tests enforce total <= stored literal limit.
The token limit is ceil(byte limit / 4). Reserve is checked at approval,
not recalculated as text grows. A maximum includes all applicable optional
reads. Any subset fits because removing ranges cannot increase union size.

| Phase | Publishing | Plan | Required bytes | Estimated tokens | Byte limit | Token limit | Conditional maximum bytes | Estimated tokens | Byte limit | Token limit |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Research | off | ordinary | 75714 | 18929 | 76835 | 19209 | 144697 | 36175 | 145471 | 36368 |
| 1. Research | off | nested | 90999 | 22750 | 129137 | 32285 | 159982 | 39996 | 197773 | 49444 |
| 1. Research | on | ordinary | 87226 | 21807 | 92700 | 23175 | 156209 | 39053 | 161336 | 40334 |
| 1. Research | on | nested | 102511 | 25628 | 145981 | 36496 | 171494 | 42874 | 214617 | 53655 |
| 2. Risk assessment | off | ordinary | 112107 | 28027 | 114401 | 28601 | 181090 | 45273 | 183038 | 45760 |
| 2. Risk assessment | off | nested | 127392 | 31848 | 167682 | 41921 | 196375 | 49094 | 236319 | 59080 |
| 2. Risk assessment | on | ordinary | 123619 | 30905 | 131245 | 32812 | 192602 | 48151 | 199882 | 49971 |
| 2. Risk assessment | on | nested | 138904 | 34726 | 184526 | 46132 | 207887 | 51972 | 253163 | 63291 |
| 3. Design validation | off | ordinary | 112107 | 28027 | 114401 | 28601 | 181090 | 45273 | 183038 | 45760 |
| 3. Design validation | off | nested | 127392 | 31848 | 167682 | 41921 | 196375 | 49094 | 236319 | 59080 |
| 3. Design validation | on | ordinary | 123619 | 30905 | 131245 | 32812 | 192602 | 48151 | 199882 | 49971 |
| 3. Design validation | on | nested | 138904 | 34726 | 184526 | 46132 | 207887 | 51972 | 253163 | 63291 |
| 4. Focus reconfirmation | off | ordinary | 112107 | 28027 | 114401 | 28601 | 181090 | 45273 | 183038 | 45760 |
| 4. Focus reconfirmation | off | nested | 127392 | 31848 | 167682 | 41921 | 196375 | 49094 | 236319 | 59080 |
| 4. Focus reconfirmation | on | ordinary | 123619 | 30905 | 131245 | 32812 | 192602 | 48151 | 199882 | 49971 |
| 4. Focus reconfirmation | on | nested | 138904 | 34726 | 184526 | 46132 | 207887 | 51972 | 253163 | 63291 |
| 5. Adversarial design review | off | ordinary | 135022 | 33756 | 138753 | 34689 | 231789 | 57948 | 236562 | 59141 |
| 5. Adversarial design review | off | nested | 150307 | 37577 | 192034 | 48009 | 247074 | 61769 | 289844 | 72461 |
| 5. Adversarial design review | on | ordinary | 146534 | 36634 | 155597 | 38900 | 243301 | 60826 | 253406 | 63352 |
| 5. Adversarial design review | on | nested | 161819 | 40455 | 208878 | 52220 | 258586 | 64647 | 306688 | 76672 |
| 6. Final design approval | off | ordinary | 135022 | 33756 | 138753 | 34689 | 231789 | 57948 | 236562 | 59141 |
| 6. Final design approval | off | nested | 150307 | 37577 | 192034 | 48009 | 247074 | 61769 | 289844 | 72461 |
| 6. Final design approval | on | ordinary | 146534 | 36634 | 155597 | 38900 | 243301 | 60826 | 253406 | 63352 |
| 6. Final design approval | on | nested | 161819 | 40455 | 208878 | 52220 | 258586 | 64647 | 306688 | 76672 |
| 7. Track loop | off | ordinary | 158217 | 39555 | 163384 | 40846 | 259621 | 64906 | 302924 | 75731 |
| 7. Track loop | off | nested | 173502 | 43376 | 216665 | 54167 | 259621 | 64906 | 302924 | 75731 |
| 7. Track loop | on | ordinary | 169729 | 42433 | 180228 | 45057 | 271133 | 67784 | 319769 | 79943 |
| 7. Track loop | on | nested | 185014 | 46254 | 233509 | 58378 | 271133 | 67784 | 319769 | 79943 |
| 8. Final acceptance | off | ordinary | 158217 | 39555 | 163384 | 40846 | 259621 | 64906 | 302924 | 75731 |
| 8. Final acceptance | off | nested | 173502 | 43376 | 216665 | 54167 | 259621 | 64906 | 302924 | 75731 |
| 8. Final acceptance | on | ordinary | 169729 | 42433 | 180228 | 45057 | 271133 | 67784 | 319769 | 79943 |
| 8. Final acceptance | on | nested | 185014 | 46254 | 233509 | 58378 | 271133 | 67784 | 319769 | 79943 |
| 9. Delivery | off | ordinary | 158217 | 39555 | 163384 | 40846 | 259621 | 64906 | 302924 | 75731 |
| 9. Delivery | off | nested | 173502 | 43376 | 216665 | 54167 | 259621 | 64906 | 302924 | 75731 |
| 9. Delivery | on | ordinary | 169729 | 42433 | 180228 | 45057 | 271133 | 67784 | 319769 | 79943 |
| 9. Delivery | on | nested | 185014 | 46254 | 233509 | 58378 | 271133 | 67784 | 319769 | 79943 |

Conditional sets have the following whole-document costs. Early notes cost
zero extra after required notes enter phase 7. Unusual prose costs zero extra
when manual review already includes writing guidance. Nested plans already
include the recursive workflow. Ordinary plans add it to their maximum from
phase 7 before a split proposal. Manual review includes common policy, writing
guidance, and all twelve charters from phase 5. Built-in review loads its
implementation input for workers only. It adds no orchestrator read.
| Conditional set | Bytes | Estimated tokens |
| --- | ---: | ---: |
| Rationale | 30268 | 7567 |
| Unusual prose | 28067 | 7017 |
| Early notes | 10648 | 2662 |
| Ordinary split | 15285 | 3822 |
| Manual review | 55851 | 13963 |

Private evidence, designs, reports, source chains, project additions, configured
prompt documents, provider framing, tools, results, message wrappers, repeated
reads, and the incoming system prompt are excluded. These variable costs can
exceed every total. Compaction can reduce retained text but not this metric.
The reference scanner checks filenames and reviewed contexts, not read semantics.
A reviewer checks recipients, conditions, dependencies, and first-read phases.
<!-- workflow-phase:end -->
