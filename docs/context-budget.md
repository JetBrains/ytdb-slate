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
header, five reminder requirements, blank separator, and scope exclusion. The
character count is derived from the exact rendered string pinned by the reminder
checks. The roughly 80-token estimate derives from four characters per token.
Both figures exclude JSONL framing and provider-role overhead. The message enters
conversation context only when a reminder fires. Later requests resend it with
the rest of the conversation.

## What always-loaded tool definitions cost the budget

A registered tool adds its description and serialized parameter schema to each
request while that tool is available. Parameter descriptions sit inside the
schema. A tool description and a parameter description are therefore both
always loaded.

The current `thread` tool description is 1,062 UTF-8 bytes. Its serialized
parameter schema is 1,246 bytes, measured as `JSON.stringify(parameters)`.
The schema includes the bounded `context` argument.

The description and schema total 2,308 bytes before provider framing.
The `context` entry accepts at most 32 episode identifiers.

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
shipped docs by ABSOLUTE path, so three to six full filesystem paths
are embedded in the block — three at minimum
(`track-workflow.md`, `review-rules.md`,
`design-principles.md`), plus `pr-publishing.md` when
`workflow.draftPRs` is on, plus `model-routing.md` when the routing
rule renders, plus `writing-guidance.md` when `writing.check` is on.
Every additional character in the installed `docs/` directory therefore
costs 3–6 characters of doctrine.

The figures below are **portable characters**, defined exactly as Slate's
automated `doctrine-budget` check defines them. The check removes each installed
`docs/` directory and keeps its filename. It removes the variable session
directory prefix only inside the marked research log path. It keeps
`research-log.md`.

> rendered characters = portable + (documentation paths × installed `docs/`
> directory length) + research log session-directory prefix length

`doctrine-budget` in `verification/resolver-checks.mjs` is the
definition of record for this convention and its enforced bounds.
This table is a measured snapshot, not a second authority. It uses
the same shipped-profile fixture as that check. The six-model rows use a fixed
fabricated roster of six resolvable shipped profile specs. The roster currently
matches this repository's config, but the check never reads that config. Every row
states its full basis, because router state, model count, `draftPRs`,
and `writing.check` each move the number. Rows with the same fixture
and basis must agree with `verification/README.md`. A different basis
must be named instead of presented as the same measurement:

| router | models | `draftPRs` | `writing.check` | paths | portable | lines |
| --- | --- | --- | --- | --- | --- | --- |
| off | — | off | off | 3 | 2,732 | 46 |
| off | — | off | on | 4 | 3,802 | 68 |
| off | — | on | off | 4 | 2,761 | 46 |
| off | — | on | on | 5 | 3,831 | 68 |
| on | fixed six-model fixture | off | off | 4 | 4,762 | 67 |
| on | fixed six-model fixture | off | on | 5 | 5,832 | 89 |
| on | fixed six-model fixture | on | off | 5 | 4,791 | 67 |
| on | fixed six-model fixture | on | on | 6 | 5,861 | 89 |
| on | all 9 shipped | off | off | 4 | 5,317 | 70 |
| on | all 9 shipped | off | on | 5 | 6,387 | 92 |
| on | all 9 shipped | on | off | 5 | 5,346 | 70 |
| on | all 9 shipped | on | on | 6 | 6,416 | 92 |

Every row above carries one complete research log path in the raw prompt. The
portable count removes its variable session-directory prefix only from that
marked path. It retains `research-log.md`. The prefix is mandatory environment
data, not authored wording. The resolver check renders one long prefix and a
different prefix with non-basic Unicode. Both must produce identical normalized
text and counts. A mutation control places the same prefix in authored wording
outside the marked path. Every character of that authored occurrence must count.

An untrusted project reads the first row whatever its `slate.json`
says: no project config is loaded, so no optional rule renders. Line
counts do not vary with the install path. Enabling `draftPRs` costs
29 portable characters plus one embedded path. Enabling
`writing.check` costs 1,070 portable characters, adds 22 lines to the
whole doctrine, and adds one embedded path. Considered alone, the
writing rule is 1,070 portable characters / 23 lines. Its leading
newline becomes the separator when appended.

Two parts of the block grow with configuration rather than with the
path:

- The routing rule is a live table with ONE ROW PER ROUTABLE MODEL,
  so what renders is the models you CONFIGURE — not the nine Slate
  ships profiles for. The six-model figure is derived from exact
  doctrine pins. It is 2,030 portable characters and adds 21 doctrine
  lines. The all-nine figure uses the same basis. It is 2,585
  characters and adds 24 lines.
  The row ranges are unpinned renderer measurements from those profile
  rosters. The six rows are 146–181 characters. All nine are 146–183.
  The ranges depend on current profile text and candidate ordering.
  The legend adds a one-off clause per marker it has to explain, so
  growth is not only the sum of new rows.
- The worker-extension rule grows per whitelisted extension and per
  tool that extension contributes, so it has no fixed size. One
  extension contributing two tools measured 373 portable characters
  / 7 lines. This measurement is unpinned. It depends
  on that extension's rendered label, tool names, and descriptions.

The table above isolates the shipped rules. Two representative bases include
worker extensions and support verification decisions:

| basis | models | worker extensions | paths | portable | lines | rough tokens |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| current `.pi/slate.json` dogfood config | 6 | pinned-package 2 units / 4 tools | 6 | 6,763 | 99 | ≈1,691 |
| stable maximal fixture | 9 | synthetic 2 units / 4 tools, every rendered field at its cap | 6 | 7,763 | 102 | ≈1,941 |
| follow-up-issues maximal fixture | 9 | synthetic 2 units / 4 tools, every rendered field at its cap | 6 | 7,841 | 103 | ≈1,960 |

The project-config row uses `workflow.draftPRs: true`, `writing.check: true`,
and the six models in `.pi/slate.json`. Its figures depend on the live project
config and the currently resolved extension packages. The research log rule adds
144 portable characters and three lines to every doctrine after its variable
session-directory prefix is excluded. The raw prompt still adds that full prefix. The extension basis is
`pi-smart-fetch@0.3.12` plus `pi-web-search@1.3.1`. Those packages resolve to two
units and four tools. Their worker-extension rule is 916 portable characters /
11 lines. Raw size remains symbolic: `portable + 6 × length(installed docs
directory) + length(session directory prefix)`. The research path prefix includes
the separator before `research-log.md`. No maintainer path belongs here.

The stable maximal row uses all nine shipped profiles, draft pull requests,
and writing. The follow-up-issues row uses the same basis with
`workflow.followUpIssues: true`. Their direct
post-resolution worker fixture has two units and four tools. Unit labels are 128
characters. Tool names are 64 characters. Descriptions are 140 characters.

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
| router-on doctrine | 5,317 | 6,500 | 1,183 |
| writing-only doctrine | 3,802 | 5,600 | 1,798 |
| writing plus router | 6,387 | 6,900 | 513 |
| writing plus extensions | 4,057 | 6,000 | 1,943 |
| writing plus router and extensions | 6,642 | 7,200 | 558 |
| maximal doctrine, draft PRs enabled | 7,763 | 8,500 | 737 |
| maximal doctrine, draft PRs disabled | 7,734 | 8,500 | 766 |
| maximal doctrine, follow-up issues enabled | 7,841 | 8,500 | 659 |
| capped worker rule | 1,347 | 1,600 | 253 |
| writing rule characters | 1,070 | 1,150 | 80 |
| writing rule lines | 23 | 25 | 2 |

Slate replaced the four-class prompt with size grades and focus areas. The
fixed rules grew by 207 portable characters and two lines. The writing-plus-
router fixture requires `6,387 × 1.05 = 6,706.35`. Ceiling gives 6,707. The
existing 6,900 bound remains larger. The all-tail fixture requires
`6,642 × 1.05 = 6,974.1`. Ceiling gives 6,975. The existing 7,200 bound remains
larger.

The follow-up fixture requires `7,841 × 1.05 = 8,233.05`. Ceiling gives 8,234.
The shared 8,500 bound keeps the required reserve for every maximal fixture.
The authored-doctrine budget does not limit the mandatory research log path.
`extension/research-log.ts` instead applies a 4,096-JavaScript-unit Slate sanity
guard, which is not a universal operating-system path limit.

The positive control adds one capped tool and six copies of the largest
measured model row. It measures 9,079 portable characters. It exceeds the
8,500-character maximal bound by 579. That margin remains larger than the
184-character maximum model-row growth and the 212-character capped tool growth.
The raised bound does not blunt the positive control.

These figures are verification budgets, never runtime limits. Arbitrary user
extension rosters can exceed them. Keep the positive-control steps unchanged
unless the fixture design itself changes.

Against a 256,000-token context budget, these blocks remain small. The rough
estimate divides each measured portable-character render by four and rounds to
the nearest whole token. The shipped-rule table ranges from about 683 tokens to
about 1,604 tokens. The current dogfood basis is about 1,691 tokens. The stable
representative maximum is about 1,941 tokens. The follow-up-issues maximum is
about 1,960 tokens, or 0.77 percent of the default budget.

No tokenizer was run, and tables are denser than prose. The block is re-sent on every request rather than paid once. These figures show how
much headroom Slate consumes before conversation content.

### Worker writing preamble

The doctrine table does not include the worker preamble. It belongs
to each worker session's system prompt, not to the orchestrator's
per-turn doctrine.

| Worker preamble form | UTF-8 bytes | Increase from base | figure source |
| --- | ---: | ---: | --- |
| Base | 226 | — | exact resolver pin |
| Base + writing guidance | 384 | 158 | exact resolver pin, with derived increase |
| Base + reviewer charter | 2,381 | 2,155 | live renderer measurement, unpinned |
| Base + writing guidance + reviewer charter | 2,539 | 2,313 | live renderer measurement, unpinned |

The unpinned rows depend on the current reviewer charter and separator. The
157-byte writing guidance is derived from the two pinned preamble forms. The
2,154-byte reviewer charter is derived from the unpinned base-plus-charter row.
The writing addendum needs one separating space. The reviewer charter addendum
needs one separating newline. The current text uses UTF-8 punctuation, so byte
and character counts can differ.
This separate figure states the worker-session cost without presenting
it as orchestrator doctrine.

## Worker actions

The budget above applies to the orchestrator. Each worker session runs one action.
Slate does not route worker actions by prompt size. Pi owns worker compaction and
context overflow behavior. `model-routing.md` documents the routing guards.

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
`gpt-5.6-*` model during resolution. Slate's own profile for those models records a
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
