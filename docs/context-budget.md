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

The hidden message uses 1,429 UTF-8 bytes without findings. The checked worst
case uses 1,899 bytes and needs 1,994 bytes with five-percent reserve. The
2,000-byte bound leaves six bytes above that requirement. The case counts the
header, two capped quotations, writing and design blocks, form cue, retained
style rules, separators and scope exclusion.
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
| shipped logical section | 0 | 4,938 | 9 |
| trusted shipped-default doctrine | 5 | 9,739 | 72 |
| untrusted doctrine without a home configuration file | 4 | 2,711 | 33 |
| draft pull requests, shipped policy | 6 | 9,809 | 73 |
| capped workers, shipped policy | 5 | 11,086 | 82 |
| draft plus capped workers | 6 | 11,156 | 83 |
| deferred issues plus capped workers | 5 | 11,160 | 83 |
| routing recommendations plus capped workers | 5 | 11,139 | 83 |
| draft plus deferred issues and capped workers | 6 | 11,230 | 84 |
| draft plus routing recommendations and capped workers | 6 | 11,205 | 84 |
| deferred issues plus routing recommendations and capped workers | 5 | 11,213 | 84 |
| canonical maximal baseline with all workflow options | 6 | 11,279 | 85 |
| maximal baseline with an open change | 6 | 11,477 | 86 |
| maximal baseline with source and legacy root log | 6 | 11,707 | 88 |
| dogfood `.pi/slate.json` and its two extension units | 6 | 10,404 | 84 |
| runtime boundary plus draft and capped workers, source and legacy log | 6 | 26,046 | 86 |
| runtime boundary plus draft and deferred issues, source and legacy log | 6 | 26,120 | 87 |
| runtime boundary plus routing recommendations, source and legacy log | 5 | 26,029 | 86 |
| runtime boundary plus deferred issues and routing recommendations, source and legacy log | 5 | 26,103 | 87 |
| runtime boundary plus draft and routing recommendations, source and legacy log | 6 | 26,095 | 87 |
| same boundary composition plus deferred issues | 6 | 26,169 | 88 |
| valid shipped policy plus 88 capped worker tools, source and legacy log | 6 | 29,381 | 171 |

An untrusted session with an empty home `slate.json` receives the same doctrine
as the trusted shipped-default fixture above. It includes routing and writing
rules. `test/config-loading.test.ts` renders both through the real entry hooks
and checks that equality. Home preferences can change this size, just as trusted
project preferences can.

The canonical maximal baseline uses all four default logical models, all
three workflow options, and the fixed capped worker roster. Its largest variant
has an open change, one direct source folder, and a legacy root log. Its
five-percent requirement is `ceil(11,707 × 1.05) = 12,293`.
The 26,300 whole-doctrine ceiling exceeds it. The table pins all eight
combinations of the three workflow options with the capped worker roster. The
dogfood row reads the actual project configuration. A change to `.pi/slate.json` requires a fresh render.

The four routing-enabled rows from 26,029 through 26,169 are
boundary-composition controls. The 26,046 and 26,120 rows keep the
routing-recommendation feature off as compatibility controls. The 26,169 row
pins the capped-roster boundary composition. It has 131 characters of headroom.
Each row combines a valid logical section padded to exactly 19,400 characters with supported doctrine tails. The rows do not define reserve-bearing
baselines. Every row remains below the 26,300 portable-character ceiling.
A valid third worker unit with a 125-character label reaches 26,300 exactly
when all three workflow options are on. A 126-character label reaches 26,301,
the first value beyond the ceiling.

The over-cap counterfactual uses a valid shipped logical policy and one supported
worker-extension unit with 88 capped tools. It also includes an open change,
its source, and the legacy root log. Its 29,381 portable characters exceed
the whole-doctrine ceiling by 3,081. The check measures the whole doctrine
directly.
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

The shipped model policy section has a limit of 5,185 portable characters and
9 lines. The approval date is 2026-11-25. The character limit adds five percent
to the measured 4,938 characters and rounds up. The line limit has no reserve.
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

The review-rules cap is 24,403 UTF-8 bytes, enforced by the resolver checks.
A separate checked ceiling limits the delivered review rules to 24,203 bytes.
For publishing-off ordinary research, the classification and recovery ceilings are 79,410 required and 152,344 maximum bytes.
The **protected pool** is context reserved for later workflow documentation.
The protected pool owns 211 bytes (187 + 5 + 17 + 2). This ownership adds no measured headroom.
The safe-write allocation does not draw from that pool.

### Worker writing preamble

The doctrine table does not include the worker preamble. It belongs
to each worker session's system prompt, not to the orchestrator's
per-turn doctrine.

| Worker preamble form | UTF-8 bytes | Increase from base |
| --- | ---: | ---: |
| Base | 1,317 | — |
| Base + complete writing guidance | 2,479 | 1,162 |
| Base + reviewer charter | 3,472 | 2,155 |
| Base + short writing guidance + reviewer charter | 4,016 | 2,699 |

The preamble explains that the harness runs calls issued in one turn at the
same time. It also explains that cumulative token cost grows with the square of
the number of turns because each turn resends the conversation history.

The writing guidance is 1,161 bytes. This complete form includes the design-scope exception.
Short review writing guidance is 543 bytes.
The reviewer charter constant is 2,154 bytes.
The writing addendum needs one separating space. The reviewer charter addendum
needs one separating newline. The current text uses UTF-8 punctuation, so byte
and character counts can differ.
These figures measure the preamble in the worker system prompt.
Slate assembles it once per session. Each ordinary worker request includes it.
For example, a worker with full guidance that reads a file and then answers
carries the 1,162-byte addition in both requests. The 2,324-byte total measures
logical request content, not billed input.

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
Open-change record-writing system totals are 2,116 or 3,278 bytes without or with writing guidance.
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
Its generated guidance is 1,925 UTF-8 bytes without a source folder.
With a canonical source folder, the guidance is 2,479 bytes.
The portable count removes only the installed documentation-directory prefix.
It keeps the filename and all other bytes.
Two references add twice the prefix's UTF-8 byte length as a separate installation cost.
The count excludes the original task and its separating newlines.

| Writing guidance | System preamble bytes | Task guidance bytes, no source / source | Sum, no source / source |
| --- | ---: | ---: | ---: |
| Off | 1,317 | 1,925 / 2,479 | 3,242 / 3,796 |
| On | 2,479 | 1,925 / 2,479 | 4,404 / 4,958 |

The sums exclude message and provider framing.
They do not join the preamble and task as one system block.
These worker measurements are separate from the doctrine table and raise no budget.

## Worker actions

The budget above applies to the orchestrator. Each worker session runs one action.
Slate does not select worker actions by prompt size. Pi owns worker compaction
and context overflow behavior. `model-routing.md` documents logical selection,
validation, and recovery.

Slate queues one hidden tool reminder per eligible tool round. When writing
is due and permitted, the same reminder adds the role's writing guidance.
Use Pi 1.6.0 to reproduce these UTF-8 byte counts.

| Worker reminder form | Content | Converted without timestamp | Provider-facing object | Saved JSON Lines record |
| --- | ---: | ---: | ---: | ---: |
| Tools only | 330 | 383 | 409 | 499 |
| Tools with full writing guidance | 1,493 | 1,563 | 1,589 | 1,679 |
| Tools with short writing guidance | 875 | 930 | 956 | 1,046 |

The standalone writing form includes its header. It uses 1,180 bytes for
the full form and 562 for the short form. Slate caps it at 1,180 content bytes
with no reserve. The combined reminder keeps the tools opening and replaces
the writing header with two line feeds. This adds 1,163 or 545 content bytes.
Slate checks the increment against the same cap. The cap does not cover tools
text or serialization.

Pi converts each reminder to a user message with one text part. The
provider-facing figure includes the timestamp. The saved record includes
two eight-character identifiers, a timestamp and the final line feed.
Escaped line feeds make the serialized increase 1,180 or 547 bytes per
appearance. The figures measure compact JavaScript Object Notation (JSON).
They include no installed path. They do not measure network bytes or tokens.

| Worker context item | Copies in request N | Cumulative appearances across N requests |
| --- | ---: | ---: |
| Tool reminder, any form | N - 1 | N × (N - 1) / 2 |

The row assumes a fresh session with `N` requests and one normal turn per
request. Each of the first `N - 1` turns sends one tool reminder after a
qualifying result. The next request takes it immediately and every later
request retains it. The number of tool reminders does not show when writing
arrives. A session can retain tools-only reminders without any writing.

In that sequence, an interval of `k` turns makes writing due after turn `k`.
Turn `k + 1` offers the first chance to attach writing if it has an eligible
tool result. Writing must be permitted and fit the cap. The combined send must
return normally. If the next request takes that reminder, writing first appears
in request `k + 2`. It joins again every `k` turns under the same conditions.
If every later request retains it, a combined reminder from turn `i` adds its
serialized increase to each of the next `N - i` requests. Slate sends no
additional reminder for writing.

Queue order, retries, failover and compaction can change delivery and retention.
The row does not bound total request cost. Provider cache reads can reduce billed
input without reducing appearances.

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
| implementation-dispatch focused-context reference | 226 |
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
| Reviewer I | 9,260 | 9,137 |
| Concurrency reviewer | 7,922 | 7,799 |
| Data loss and recovery reviewer | 8,117 | 7,994 |
| Security reviewer | 8,064 | 7,941 |
| Performance reviewer | 8,119 | 7,996 |
| Test-quality and structure reviewer | 9,373 | 9,250 |
| Prose reviewer | 8,331 | 8,208 |
| Licensing reviewer | 8,062 | 7,939 |
| Non-local logic defect reviewer | 9,059 | 8,936 |
| Consumer contract break reviewer | 9,343 | 9,220 |
| Governing-rule defect reviewer | 9,452 | 9,329 |
| Unreported failure reviewer | 8,984 | 8,861 |

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
and final line feeds up to the next heading of the same or higher level.
The phase rows preserve accumulation for single-track work without a handoff.

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

The user approved these limits on 2026-10-16. Each initial byte limit
is ceil(baseline bytes * 1.05). Tests enforce total <= stored literal limit.
The token limit is ceil(byte limit / 4). Reserve is checked at approval,
not recalculated as text grows. A maximum includes all applicable optional
reads. Any subset fits because removing ranges cannot increase union size.
The user approved the two nested research maximum limits on 2026-10-25.
They are 227,750 bytes / 56,938 estimated tokens with publishing off and
244,594 bytes / 61,149 estimated tokens with publishing on.
The fixed historical safe-write raise G is 2,593 bytes.
The approval of 2026-11-26 assigns 410 bytes of shipped model policy text to each comparison start.
The same approval assigns 410 bytes to the seven funded ordinary maximum limits.
Each reservation equals its row start plus its approved share.
The five percent reserve does not apply to these seven increases. All other phase limits stay fixed.
The classification and recovery allowance applies independently to each required and maximum row.
Research candidate ceilings are 79,410 required and 152,344 maximum bytes.
Actual research totals are 79,213 required and 152,300 maximum bytes.
Each phase and session row permits at most 566 required and 3,061 maximum bytes above the classification and recovery start. No sibling saving transfers.
The protected pool owns 211 bytes (187 + 5 + 17 + 2). This ownership adds no measured headroom. Unused share moves only by recorded user decision.

| Phase | Publishing | Plan | Required bytes | Estimated tokens | Byte limit | Token limit | Conditional maximum bytes | Estimated tokens | Byte limit | Token limit |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Research | off | ordinary | 79213 | 19804 | 79389 | 19848 | 152300 | 38075 | 152344 | 38086 |
| 1. Research | off | nested | 94457 | 23615 | 129352 | 32338 | 167544 | 41886 | 227750 | 56938 |
| 1. Research | on | ordinary | 90725 | 22682 | 92915 | 23229 | 163812 | 40953 | 163856 | 40964 |
| 1. Research | on | nested | 105969 | 26493 | 146196 | 36549 | 179056 | 44764 | 244594 | 61149 |
| 2. Risk assessment | off | ordinary | 115250 | 28813 | 115341 | 28836 | 188337 | 47085 | 188381 | 47096 |
| 2. Risk assessment | off | nested | 130494 | 32624 | 167897 | 41975 | 203581 | 50896 | 236534 | 59134 |
| 2. Risk assessment | on | ordinary | 126762 | 31691 | 131460 | 32865 | 199849 | 49963 | 200097 | 50025 |
| 2. Risk assessment | on | nested | 142006 | 35502 | 184741 | 46186 | 215093 | 53774 | 253378 | 63345 |
| 3. Design validation | off | ordinary | 115250 | 28813 | 115341 | 28836 | 188337 | 47085 | 188381 | 47096 |
| 3. Design validation | off | nested | 130494 | 32624 | 167897 | 41975 | 203581 | 50896 | 236534 | 59134 |
| 3. Design validation | on | ordinary | 126762 | 31691 | 131460 | 32865 | 199849 | 49963 | 200097 | 50025 |
| 3. Design validation | on | nested | 142006 | 35502 | 184741 | 46186 | 215093 | 53774 | 253378 | 63345 |
| 4. Focus reconfirmation | off | ordinary | 115250 | 28813 | 115341 | 28836 | 188337 | 47085 | 188381 | 47096 |
| 4. Focus reconfirmation | off | nested | 130494 | 32624 | 167897 | 41975 | 203581 | 50896 | 236534 | 59134 |
| 4. Focus reconfirmation | on | ordinary | 126762 | 31691 | 131460 | 32865 | 199849 | 49963 | 200097 | 50025 |
| 4. Focus reconfirmation | on | nested | 142006 | 35502 | 184741 | 46186 | 215093 | 53774 | 253378 | 63345 |
| 5. Adversarial design review | off | ordinary | 139430 | 34858 | 139693 | 34924 | 240393 | 60099 | 240410 | 60103 |
| 5. Adversarial design review | off | nested | 154674 | 38669 | 192249 | 48063 | 255637 | 63910 | 290059 | 72515 |
| 5. Adversarial design review | on | ordinary | 150942 | 37736 | 155812 | 38953 | 251905 | 62977 | 253621 | 63406 |
| 5. Adversarial design review | on | nested | 166186 | 41547 | 209093 | 52274 | 267149 | 66788 | 306903 | 76726 |
| 6. Final design approval | off | ordinary | 139430 | 34858 | 139693 | 34924 | 240393 | 60099 | 240410 | 60103 |
| 6. Final design approval | off | nested | 154674 | 38669 | 192249 | 48063 | 255637 | 63910 | 290059 | 72515 |
| 6. Final design approval | on | ordinary | 150942 | 37736 | 155812 | 38953 | 251905 | 62977 | 253621 | 63406 |
| 6. Final design approval | on | nested | 166186 | 41547 | 209093 | 52274 | 267149 | 66788 | 306903 | 76726 |
| 7. Track loop | off | ordinary | 162542 | 40636 | 163599 | 40900 | 268101 | 67026 | 303139 | 75785 |
| 7. Track loop | off | nested | 177786 | 44447 | 216880 | 54220 | 268101 | 67026 | 303139 | 75785 |
| 7. Track loop | on | ordinary | 174054 | 43514 | 180443 | 45111 | 279613 | 69904 | 319984 | 79996 |
| 7. Track loop | on | nested | 189298 | 47325 | 233724 | 58431 | 279613 | 69904 | 319984 | 79996 |
| 8. Final acceptance | off | ordinary | 162542 | 40636 | 163599 | 40900 | 268101 | 67026 | 303139 | 75785 |
| 8. Final acceptance | off | nested | 177786 | 44447 | 216880 | 54220 | 268101 | 67026 | 303139 | 75785 |
| 8. Final acceptance | on | ordinary | 174054 | 43514 | 180443 | 45111 | 279613 | 69904 | 319984 | 79996 |
| 8. Final acceptance | on | nested | 189298 | 47325 | 233724 | 58431 | 279613 | 69904 | 319984 | 79996 |
| 9. Delivery | off | ordinary | 162542 | 40636 | 163599 | 40900 | 268101 | 67026 | 303139 | 75785 |
| 9. Delivery | off | nested | 177786 | 44447 | 216880 | 54220 | 268101 | 67026 | 303139 | 75785 |
| 9. Delivery | on | ordinary | 174054 | 43514 | 180443 | 45111 | 279613 | 69904 | 319984 | 79996 |
| 9. Delivery | on | nested | 189298 | 47325 | 233724 | 58431 | 279613 | 69904 | 319984 | 79996 |

### Session starts

A session runs between actual handoff transfers. A failed or cancelled transfer
and resume without transfer keep the current session. Single-track work has
no mandatory handoff. Reads continue accumulating inside each session.

Each start rereads the accumulated fixed-document set for its phase and plan.
Nested phase-1 resume starts include design-track entry and optional handoffs.
Their required sets cover unchanged-record reconciliation without added definitions.
Their conditional maxima add focus and coverage definitions for renewed focus judgment.
These two ranges in [blast-radius.md](blast-radius.md) add 29,762 bytes.
Root research starts add neither range, including with a nested plan.
From phase 2, the whole [blast-radius.md](blast-radius.md) already contains both ranges.

| Session start | Entry phase | Plan | Added required reads | Added conditional reads |
| --- | --- | --- | --- | --- |
| Root research | 1 | ordinary or nested | none | none |
| Optional handoff | 1 | ordinary | none | none |
| Design track or optional handoff | 1 | nested | none | [Focus areas and their gates](blast-radius.md#focus-areas-and-their-gates), including Judged proof and risk record, plus [Review coverage and the coverage register](blast-radius.md#review-coverage-and-the-coverage-register) |
| Code track, including the second boundary | 7 | ordinary or nested | none | none |
| Parent return | continuing phase 2–9 | ordinary or nested | none | none |
| Optional handoff | continuing phase 2–9 | ordinary or nested | none | none |

All starts use the corresponding phase limits. Only nested phase-1 resume maxima
differ from the phase totals. Their measured entry totals follow.

| Publishing | Required bytes | Estimated tokens | Conditional maximum bytes | Estimated tokens | Byte limit | Token limit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| off | 94457 | 23615 | 197306 | 49327 | 227750 | 56938 |
| on | 105969 | 26493 | 208818 | 52205 | 244594 | 61149 |

The doctrine requires common change records at every start. Nested planning
and resume load recursive workflow. Fresh sessions cannot reuse prior context
to skip review rules, rationale, or unusual-prose guidance when applicable.
Resume reconciles records, accepted history, focus, coverage, and the live difference.
Variable records remain required evidence but are outside fixed-document bytes.
Tests compare document identities, conditions, and selected range unions.
Current source rules release no fixed-document read at a handoff.

A handoff saves retained conversation content, including messages, episodes,
and variable records. It does not save required fixed-document reads.
These tables exclude that conversation content and repeated reads.
They do not measure the total context saving from a handoff.

Conditional sets have the following whole-document costs. Early notes cost
zero extra after required notes enter phase 7. Unusual prose costs zero extra
when manual review already includes writing guidance. Nested plans already
include the recursive workflow. Ordinary plans add it to their maximum from
phase 7 before a split proposal. Manual review includes common policy, writing
guidance, and all twelve charters from phase 5. Built-in review loads its
implementation input for workers only. It adds no orchestrator read.
| Conditional set | Bytes | Estimated tokens |
| --- | ---: | ---: |
| Rationale | 30142 | 7536 |
| Unusual prose | 28106 | 7027 |
| Early notes | 10648 | 2662 |
| Ordinary split | 15244 | 3811 |
| Manual review | 55982 | 13996 |
| Record exception | 4191 | 1048 |

Maps and designs have soft guidelines of about 1,500 and 2,500 words.
Diagrams do not count. The map reference is 3726 bytes per full read.
See [maps.md](maps.md) for its worker readers. The design reference is 3369 bytes
per full read by a design author, with a 3,369-byte bound. Name
[design-format.md](design-format.md) in design-writing tasks without reading it.
The orchestrator never reads it, including on worker failure. Count worker
reads again on each repeat. Worker reads, record text and composed drafts
are separate costs outside the fixed orchestrator rows.
The safe-write section is 12,085 bytes and includes privacy rules.
Only its worker read is a separate excluded cost. Its orchestrator read enters phase totals.
Whole applicable designs supplied to reviewers are excluded costs that repeat across reviewers and fix-gate rounds.
Several maps can exceed fixed-row headroom. These totals do not bound the whole conversation.

Private evidence, designs, reports, source chains, project additions, configured
prompt documents, provider framing, tools, results, message wrappers, repeated
reads, and the incoming system prompt are excluded. These variable costs can
exceed every total. Compaction can reduce retained text but not this metric.
The reference scanner checks filenames and reviewed contexts, not read semantics.
A reviewer checks recipients, conditions, dependencies, and first-read phases.
After any resume, handoff, or reread duty changes, reconcile session-entry
assignments against source duties even when tests pass. Follow
[Workflow-phase context maintenance](https://github.com/JetBrains/ytdb-slate/blob/main/verification/README.md#workflow-phase-context-maintenance)
and record either the updated assignments, expectations, and publication or a no-change decision.
<!-- workflow-phase:end -->

The worker-only safe-record-write.md reference measures 14,480 bytes.
Its separate and repeated reads are excluded from fixed orchestrator context.
The task's installed reference path and shell quoting add variable worker costs.
Command source and optional help reads are also excluded costs.
Each non-help command call has a 2,304-byte output bound.
That bound includes a 2,048-byte report and 256 standard-error bytes.
Uncapped creation retries have no cumulative output bound.
The preservation route allows two ordinary attempts and two recovery attempts per record operation across dispatches.
Those four attempts have a 9,216-byte output bound.
Accepted occupied fresh checks consume no attempt and each adds at most 2,304 output bytes.
Repeated fresh checks have no cumulative output bound.
Output bounds grant no preservation permission.
Command help measures 999 bytes within its 1,024-byte bound.

