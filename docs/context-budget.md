# Orchestrator context budget

`contextBudget` in the project's `slate.json` sets the ABSOLUTE
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

## Configuration (`.pi/slate.json`)

`contextBudget` lives in `.pi/slate.json` and, like the rest of
that file, is honored **only in trusted projects** — untrusted
projects load no project config, so the built-in defaults apply. It
accepts a bare positive integer — shorthand for `{"tokens": N}` —
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

`compactionReserve` comes from pi's compaction settings
(`compaction.reserveTokens`, default 16,384).

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

The effective budget also sets the optional hidden writing-reminder cadence.
When `writing.check` and `writing.remind` are both true, Slate computes:

```
interval = max(8192, floor(effectiveBudget × remindPercent / 100))
```

`remindPercent` defaults to 10 and accepts a finite value in `(0, 100]`. The
context-window clamp therefore shortens the cadence on a model whose configured
budget does not fit. Slate checks the cadence after tool results. One reminder
slot can fire after each assistant response.

A successful handoff adoption sets `forceNext`. The next eligible tool result
then bypasses token cadence and missing usage. It does not bypass trust,
orchestrator mode, `writing.check`, `writing.remind`, or pause gates. Slate
commits the cadence mark only when pi starts delivery of the custom message.

The current hidden message is 320 ASCII characters, including its `[slate]`
header, five reminder requirements, blank separator, and scope exclusion. That
is about 80 tokens at four characters per token. This count is for the exact
rendered production string, without JSONL framing or provider-role overhead. The
message enters conversation context only when a reminder fires. Later requests
resend it with the rest of the conversation.

## What always-loaded tool definitions cost the budget

A registered tool adds its description and serialized parameter schema to each
request while that tool is available. Parameter descriptions sit inside the
schema. A tool description and a parameter description are therefore both
always loaded.

The current `thread` tool description is 1,386 UTF-8 bytes. Its serialized
parameter schema is 2,005 bytes, measured as `JSON.stringify(parameters)`.
The schema includes the 289-byte `type` parameter description and the
`freshContext` argument.

The description and schema total 3,391 bytes before provider framing. The
`freshContext` schema entry adds 214 bytes to the previous combined figure.
The increase is roughly 54 tokens at four characters per token.

The figure excludes the prompt snippet, prompt guidelines, tool name,
provider framing, and serialization outside the parameter schema.

The always-loaded doctrine has a separate measurement after the compaction
policy.

## Compaction policy

In orchestrator mode, for budget-driven configs only: a
threshold-triggered compaction that arrives while the session is
unpaused is cancelled and converted into the Slate pause — the
handoff, not lossy compaction, handles the full context. Once
paused, threshold compactions pass through as an escape valve.
Overflow-recovery compaction and manual `/compact` are never
touched.

## What the always-loaded doctrine costs the budget

The budget's denominator includes Slate's own always-loaded block.
While orchestrator mode is on, the doctrine sits in the
orchestrator's system prompt for the whole session — and, like the
rest of the conversation (see the pricing cliff above), it is sent
again with every request. It occupies its space in the window once;
you pay its input tokens every turn.

**Its size depends on where the package is installed.** That is not
obvious, and it catches anyone who measures: the doctrine cites the
shipped docs by ABSOLUTE path, so four to seven full filesystem paths
are embedded in the block — four at minimum
(`thread-cache-cost.md`, `track-workflow.md`, `review-rules.md`,
`design-principles.md`), plus `pr-publishing.md` when
`workflow.draftPRs` is on, plus `model-routing.md` when the routing
rule renders, plus `writing-guidance.md` when `writing.check` is on.
Every additional character in the installed `docs/` directory therefore
costs 4–7 characters of doctrine.

The figures below are **portable characters**, defined exactly as
Slate's own automated `doctrine-budget` check defines them: the
block with each occurrence of the installed `docs/` DIRECTORY
removed, keeping the filename. That makes them install-invariant by
construction and makes the arithmetic one multiplication:

> rendered characters = portable + (embedded paths × length of your
> installed `docs/` directory)

`doctrine-budget` in `verification/resolver-checks.mjs` is the
definition of record for this convention and its enforced bounds.
This table is a measured snapshot, not a second authority. It uses
the same shipped-profile fixture as that check. The six-model rows
use the six models in this repository's `.pi/slate.json`. Every row
states its full basis, because router state, model count, `draftPRs`,
and `writing.check` each move the number. Rows with the same fixture
and basis must agree with `verification/README.md`. A different basis
must be named instead of presented as the same measurement:

| router | models | `draftPRs` | `writing.check` | paths | portable | lines |
| --- | --- | --- | --- | --- | --- | --- |
| off | — | off | off | 4 | 2,908 | 48 |
| off | — | off | on | 5 | 3,978 | 70 |
| off | — | on | off | 5 | 2,927 | 48 |
| off | — | on | on | 6 | 3,997 | 70 |
| on | `.pi/slate.json` six | off | off | 5 | 4,938 | 69 |
| on | `.pi/slate.json` six | off | on | 6 | 6,008 | 91 |
| on | `.pi/slate.json` six | on | off | 6 | 4,957 | 69 |
| on | `.pi/slate.json` six | on | on | 7 | 6,027 | 91 |
| on | all 9 shipped | off | off | 5 | 5,493 | 72 |
| on | all 9 shipped | off | on | 6 | 6,563 | 94 |
| on | all 9 shipped | on | off | 6 | 5,512 | 72 |
| on | all 9 shipped | on | on | 7 | 6,582 | 94 |

An untrusted project reads the first row whatever its `slate.json`
says: no project config is loaded, so no optional rule renders. Line
counts do not vary with the install path. Enabling `draftPRs` costs
19 portable characters plus one embedded path. Enabling
`writing.check` costs 1,070 portable characters, adds 22 lines to the
whole doctrine, and adds one embedded path. Considered alone, the
writing rule is 1,070 portable characters / 23 lines. Its leading
newline becomes the separator when appended.

Two parts of the block grow with configuration rather than with the
path:

- The routing rule is a live table with ONE ROW PER ROUTABLE MODEL,
  so what renders is the models you CONFIGURE — not the nine Slate
  ships profiles for. In this snapshot it is 2,030 portable
  characters and adds 21 doctrine lines for six configured models;
  for all nine it is 2,585 characters and adds 24 lines. The six
  model rows are 146–181 characters; all nine are 146–183. The
  legend adds a one-off clause per marker it has to explain, so
  growth is not only the sum of new rows.
- The worker-extension rule grows per whitelisted extension and per
  tool that extension contributes, so it has no fixed size. One
  extension contributing two tools measured 373 portable characters
  / 7 lines.

The table above isolates the shipped rules. Two representative bases include
worker extensions and support verification decisions:

| basis | models | worker extensions | paths | portable | lines | rough tokens |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| current `.pi/slate.json` dogfood config | 6 | pinned-package 2 units / 4 tools | 7 | 6,943 | 101 | ≈1,736 |
| stable maximal fixture | 9 | synthetic 2 units / 4 tools, every rendered field at its cap | 7 | 7,929 | 104 | ≈1,982 |
| follow-up-issues maximal fixture | 9 | synthetic 2 units / 4 tools, every rendered field at its cap | 7 | 8,007 | 105 | ≈2,002 |

The dogfood row uses `workflow.draftPRs: true`, `writing.check: true`, and the
six models in `.pi/slate.json`. Its extension basis is
`pi-smart-fetch@0.3.12` plus `pi-web-search@1.3.1`. Those packages resolve to two
units and four tools. Their worker-extension rule is 916 portable characters /
11 lines. Raw size remains symbolic: `portable + 7 × length(installed docs
directory)`. No maintainer checkout path belongs in this shipped document.

The stable maximal row uses all nine shipped profiles, draft PRs, and writing.
The follow-up-issues row uses the same basis with `workflow.followUpIssues: true`.
Its direct post-resolution worker fixture has two units and four tools. Unit
labels are 128 characters. Tool names are 64 characters. Descriptions are 140
characters.

Those are the renderer caps. The fixture uses safe ASCII letters. It is
independent of installed extension labels, descriptions, versions and other
prose. The worker rule measures 1,347 characters against its 1,600-character
verification budget.

The reserve policy is: every doctrine upper bound must exceed its current
measurement by at least five percent, with a required character-bound raise
rounded up to the next hundred characters. Existing bounds stay in place when
they already satisfy the policy. Line bounds use the same five-percent rule and
the next whole line.

Two guards have different jobs. An exact pinned literal is the sensitive guard.
It fails for every size change in its rendered fixture, including one character.
The maximal fixtures cover draft pull requests enabled, draft pull requests
disabled, and follow-up issues enabled. Each budget term also has one enforced
bound. The bound is a coarse ceiling that stops unbounded growth over time. A
bound close to a fixture adds friction but no detection, because its exact
literal already detects the change. Real reserve therefore weakens nothing.

A doctrine change updates the exact literal and every published measurement. A
maintainer revisits a bound only when the reserve policy requires it. The check
applies the five-percent rule to every upper bound, so this decision is auditable.

| budget term | current | enforced bound | current reserve |
| --- | ---: | ---: | ---: |
| routing rule characters | 2,585 | 4,000 | 1,415 |
| routing rule lines | 25 | 34 | 9 |
| routing fixed prose | 1,110 | 1,500 | 390 |
| largest model row | 183 | 300 | 117 |
| router-on doctrine | 5,493 | 6,500 | 1,007 |
| writing-only doctrine | 3,978 | 5,600 | 1,622 |
| writing plus router | 6,563 | 6,900 | 337 |
| writing plus extensions | 4,233 | 6,000 | 1,767 |
| writing plus router and extensions | 6,818 | 7,200 | 382 |
| maximal doctrine, draft PRs enabled | 7,929 | 8,500 | 571 |
| maximal doctrine, draft PRs disabled | 7,910 | 8,500 | 590 |
| maximal doctrine, follow-up issues enabled | 8,007 | 8,500 | 493 |
| capped worker rule | 1,347 | 1,600 | 253 |
| writing rule characters | 1,070 | 1,150 | 80 |
| writing rule lines | 23 | 25 | 2 |

Track 2 replaced the four-class prompt with size grades and focus areas. The
fixed rules grew by 207 portable characters and two lines. The writing-plus-
router fixture requires `6,563 × 1.05 = 6,891.15`. Ceiling gives 6,892, and the
next-hundred rule sets 6,900. The all-tail fixture requires
`6,818 × 1.05 = 7,158.9`. Ceiling gives 7,159, and the rule sets 7,200.

The follow-up fixture is the largest maximal-family member. Its calculation is
`8,007 × 1.05 = 8,407.35`. Ceiling gives 8,408. Rounding to the next hundred
sets the shared maximal bound to 8,500. The draft-enabled and draft-disabled
fixtures fit that bound with the required reserve.

The positive control adds one capped tool and four copies of the largest
measured model row. It measures 8,877 portable characters and exceeds the
8,500-character maximal bound by 377. That margin remains larger than the
184-character maximum model-row growth and the 212-character capped tool growth.
The raised bound does not blunt the positive control.

These figures are verification budgets, never runtime limits. Arbitrary user
extension rosters can exceed them. Keep the positive-control steps unchanged
unless the fixture design itself changes.

Against a 256,000-token context budget, these blocks remain small. The rough
estimate divides each measured portable-character render by four and rounds to
the nearest whole token. The shipped-rule table ranges from about 727 tokens to
about 1,646 tokens. The current dogfood basis is about 1,736 tokens. The stable
representative maximum is about 1,982 tokens. The follow-up-issues maximum is
about 2,002 tokens, or 0.78 percent of the default budget.

No tokenizer was run, and tables are denser than prose. The block is re-sent on every request rather than paid once. These figures show how
much headroom Slate consumes before conversation content.

### Worker writing preamble

The doctrine table does not include the worker preamble. It belongs
to each worker session's system prompt, not to the orchestrator's
per-turn doctrine.

| Worker preamble form | UTF-8 bytes | Increase from base |
| --- | ---: | ---: |
| Base | 226 | — |
| Base + writing guidance | 384 | 158 |
| Base + reviewer charter | 2,386 | 2,160 |
| Base + writing guidance + reviewer charter | 2,544 | 2,318 |

The writing guidance is 157 bytes. The reviewer charter constant is
2,159 bytes. The writing addendum needs one separating space. The reviewer
charter addendum needs one separating newline. The current text uses UTF-8
punctuation, so byte and character counts can differ.
This separate figure states the worker-session cost without presenting
it as orchestrator doctrine.

## Worker threads: the routing window guard

The budget above is the ORCHESTRATOR's. Worker threads have no
budget and never pause; with action-level routing on, they get a
weaker but automatic counterpart. Before each dispatch — whenever
the thread's context size is knowable, so not for a thread whose
worker session has not been opened yet — the routed model's
REGISTRY context window is checked against that size using pi's OWN
compaction settings, the same settings whose `reserveTokens` clamps
the budget above. (The check runs even if you disabled
auto-compaction: turning compaction off does not make an
over-window dispatch safe, it only turns the compaction into an
overflow error.) If the thread no longer fits, the action is moved
to the widest listed model when that one is strictly wider, with a
warning; if nothing listed is wider it runs anyway and pi compacts.
The guard never blocks a dispatch and never pauses a thread.

Two consequences for this document's subject:

- The registry window is what decides the substitution, so the
  overrides in the next section change worker routing too: raising
  `gpt-5.6-*` to 1,050,000 makes those models genuinely wide
  candidates rather than 272K ones.
- A narrow model in `router.models` is not a hazard the way it would
  be for the orchestrator — it is a model long threads get routed
  AWAY from, paying the wider model's rate instead. That is not
  silent: the substituted action carries a ⚠ notice naming both
  models.

Routing itself — the two `router` keys, what makes a model routable,
how effort levels resolve and the full guard list — is documented in
`model-routing.md` in this directory.

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

With action-level routing on, this override also settles a warning
you will otherwise see once per session for each configured
`gpt-5.6-*` model during resolution. Dispatch-time price divergence warnings
are conditional and can repeat on later dispatches. Slate's own profile for those
models records a
1,050,000-token window, pi's stock registry reports 272,000, and the
router reports that divergence without adjudicating it (routing uses
the registry figure). Raising the registry window removes the
disagreement at its source. Leaving it alone is equally valid — the
registry figure is the conservative one — and `model-routing.md`
explains why Slate does not silence the warning by editing its own
number.

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
