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
rates — 2× input ($5→$10/M), 1.5× output ($30→$45/M), 2× cache read
($0.5→$1/M), 2× cache write ($6.25→$12.5/M). In an agent loop the
whole conversation is resent every turn, so once the boundary is
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

`contextBudget` accepts a bare positive integer — shorthand for
`{"tokens": N}` — or an object:

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
built-in `anthropic/.*` rule → built-in default. Invalid shapes and
invalid entries are warned about and ignored — an invalid budget
never silently changes behavior.

Legacy note: `pauseThresholdPercent` is deprecated; it is honored,
with its exact old semantics, only when `contextBudget` is absent.

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

## Using GPT-5.6's full 1.05M window

Two deliberate steps. First, raise the registry window in pi
settings:

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
Slate budget with an override such as:

```json
{ "match": "openai/gpt-5\\.6-.*", "tokens": 900000 }
```

WARNING: beyond 272K total input every request bills at the
long-context rates listed above.

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
  ingestion under 32,768 tokens; beyond that a pass-through
  compaction can land in the same cycle and the handoff brief is
  written from compacted context — episodes and thread state survive
  on disk, so handoff still functions.
