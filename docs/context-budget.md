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
shipped docs by ABSOLUTE path, so three to five full filesystem
paths are embedded in the block — three at minimum
(`track-workflow.md`, `review-rules.md`, `design-principles.md`),
plus `pr-publishing.md` when `workflow.draftPRs` is on, plus
`model-routing.md` when the routing rule renders. Every additional
character in the installed `docs/` directory therefore costs 3–5
characters of doctrine.

So the figures below are **portable characters**, defined exactly as
Slate's own automated size check defines them: the block with each
occurrence of the installed `docs/` DIRECTORY removed, keeping the
filename. That makes them install-invariant by construction —
verified by measuring at a 12-character docs path and at this repo's
58-character one, which give identical portable counts — and it
makes the arithmetic one multiplication:

> rendered characters = portable + (embedded paths × length of your
> installed `docs/` directory)

Every row below states its full basis, because router state, model
count and `draftPRs` each move the number:

| router | models | `draftPRs` | paths | portable | lines | rendered at a 58-char docs dir |
| --- | --- | --- | --- | --- | --- | --- |
| off | — | off | 3 | 1,929 | 38 | 2,103 |
| off | — | on | 4 | 1,948 | 38 | 2,180 |
| on | 6 configured | off | 4 | 3,870 | 58 | 4,102 |
| on | 6 configured | on | 5 | 3,889 | 58 | 4,179 |
| on | all 9 shipped | off | 4 | 4,448 | 61 | 4,680 |
| on | all 9 shipped | on | 5 | 4,467 | 61 | 4,757 |

An untrusted project reads the first row whatever its `slate.json`
says: no project config is loaded, so neither optional rule renders.
Line counts do not vary with the install path. Enabling `draftPRs`
costs 19 portable characters plus one more embedded path.

Two parts of the block grow with configuration rather than with the
path:

- The routing rule is a live table with ONE ROW PER ROUTABLE MODEL,
  so what renders is the models you CONFIGURE — not the nine Slate
  ships profiles for. It is 1,941 portable characters / 20 lines for
  six configured models and 2,519 / 23 for all nine. A model ROW
  costs 154–186 characters; the legend adds a one-off clause per
  marker it has to explain, so listing the first cheap-tier model
  costs ~50 characters more than its row (two new clauses). That is
  why stepping from six to nine averages 193 per model where the
  first six average 171.
- The worker-extension rule grows per whitelisted extension and per
  tool that extension contributes, so it has no fixed size; one
  extension contributing two tools measured 373 portable characters
  / 7 lines.

Against a 256,000-token budget none of this is material — as a rough
estimate, at 4 characters per token (no tokenizer was run, and the
table is denser than prose, so treat it as a floor) the whole block
is ≈480–525 tokens with both optional rules off and ≈970–1,025 with
six models routed, each range spanning portable to as-rendered-here.
That is under half a percent of the default budget, though it is
re-sent on every request rather than paid once. It is listed here
because it is context Slate itself puts in front of the model on
every turn, and because it is the number to check before assuming
the budget's headroom is all conversation.

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
`gpt-5.6-*` model: Slate's own profile for those models records a
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
- The doctrine sizes above cover the shipped rules only. A project
  that also injects `doctrineExtraPath` or `orchestratorPromptDocs`,
  or whitelists worker extensions, pays for those on top in the same
  always-loaded position, and Slate measures none of it against the
  budget separately — it simply arrives as context the budget then
  has less room for.
