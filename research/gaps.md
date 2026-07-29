# gaps.md — gap-filling + verification pass on digest.md

**Pass date: 2026-07-29 (UTC).** Appends to `openai.md` / `anthropic.md` / `digest.md`; does not replace them.
Method: `curl` + raw-payload extraction (Next.js SSR HTML, Astro `props=`, JSON-LD `Dataset` blocks) to defeat
JS-rendered charts that the earlier passes recorded as UNKNOWN. Every number below was read out of a primary
payload, not a search summary. `V` = vendor, `I` = independent. **UNKNOWN = still not retrievable.**

Extraction note for reuse: **artificialanalysis.ai embeds every chart as `<script type="application/ld+json">`
`Dataset` with exact float values**, and **vals.ai embeds full per-benchmark records** (`accuracy`, `stderr`,
`latency`, `cost_per_test`, `reasoning_effort`/`compute_effort`, `provider`, `harness`) in the page payload.
swe-rebench.com and tbench.ai server-render their leaderboard `<table>`s. None of these needed a browser.

---

## GOAL 1a — gpt-5.6-terra on SWE-rebench: **PROVEN ABSENT** (not "not found")

Full model registry extracted from the server-rendered table at <https://swe-rebench.com/> — **117 rows**,
including the 100 scored-`N/A` registry entries. `GPT-5.6 Sol [medium]` and `GPT-5.6 Luna [medium]` are present;
**there is no Terra row of any kind, scored or N/A**. Terra was never submitted, not merely unranked.

Complete scored table (17 scored rows), verbatim — this is the digest's primary routing table, re-verified:

| # | Model | Resolved | Pass@5 | $/problem | Tokens/problem | vs digest |
|---|---|---|---|---|---|---|
| 1 | Fable 5 [high] | 64.5% ±1.41 | 78.4% | $4.40 | 2,518,308 (94.9% cached) | ✓ |
| 2 | Grok 4.5 [high] | 63.8% ±0.60 | 77.5% | $1.47 | 2,429,424 (92.6%) | ✓ |
| 3 | Opus 5 [high] | 63.4% ±1.35 | 74.8% | $3.47 | 4,322,143 (95.7%) | ✓ |
| 4 | GLM-5.2 [high] | 62.9% ±1.19 | 81.1% | $1.40 | 5,524,892 (92.1%) | ✓ |
| 5 | **GPT-5.6 Sol [medium]** | **62.3% ±1.83** | 79.3% | **$0.85** | 605,340 (84.7%) | ✓ |
| 6 | **Junie** | **61.8% ±0.54** | 73.9% | **$0.81** | 1,684,501 (85.9%) | **NEW — absent from digest** |
| 7 | Claude Code (agent) | 60.4% ±1.03 | 75.7% | $3.39 | 3,341,581 (93.4%) | ✓ |
| 8 | Codex (agent) | 58.0% ±1.29 | 73.0% | $1.59 | 2,070,976 (94.6%) | ✓ |
| 9 | Sonnet 5 [high] | 56.8% ±0.94 | 74.8% | $1.43 | 4,645,617 (96.4%) | ✓ |
| 10 | Cursor | 51.7% ±0.84 | 65.8% | $0.41 | 1,827,002 | new |
| 11 | MiniMax M3 | 47.2% ±1.13 | 69.4% | $0.95 | 13,869,459 | new |
| 12 | MiMo V2.5 Pro | 46.5% ±0.54 | 65.8% | $0.10 | 4,687,987 | new |
| 13 | **GPT-5.6 Luna [medium]** | **43.6% ±1.47** | 59.5% | **$0.11** | 395,522 (85.2%) | ✓ |
| 14 | DeepSeek-V4 Pro [high] | 40.2% ±1.29 | 64.0% | $0.15 | 3,955,414 | new |
| 15–17 | Qwen3.6-27B / Qwen3.6-35B-A3B / Qwen3.5-35B-A3B | 31.2 / 24.7 / 17.1% | — | $0.62 / $0.27 / $0.99 | — | new |
| — | **GPT-5.6 Terra** | **ABSENT FROM REGISTRY** | — | — | — | ✓ (now proven) |

Source for every cell: <https://swe-rebench.com/> (SSR `<table>`, read 2026-07-29).
Routing consequence unchanged: Terra stays unrouted-by-default on the contamination-resistant signal. New
consequence: **Junie (JetBrains agent) is a cheaper Sol-class point (61.8% @ $0.81)** — out of scope for this
router (agent, not an OpenAI/Anthropic model) but it caps what Sol-medium's $0.85 is worth.

---

## GOAL 1b — LiveCodeBench exact percentages: **RESOLVED for 5 of 6** (Luna is absent, not unranked)

Vals AI, <https://www.vals.ai/benchmarks/lcb> — 131 models, values from the page payload (`accuracy`/`stderr`/
`cost_per_test`/`latency`/effort). Sub-columns are Vals' difficulty bands.

| Model | Overall | ± | Easy | Medium | Hard | Rank | $/test | latency | effort |
|---|---|---|---|---|---|---|---|---|---|
| claude-fable-5 | **89.778%** | 0.892 | 98.758 | 90.862 | 79.714 | 1/131 | $0.42816 | 118.53 s | max |
| claude-opus-5 | **89.033%** | 0.913 | 99.068 | 90.601 | 77.429 | 2/131 | $0.13421 | 59.22 s | unspecified |
| **gpt-5.6-terra** | **85.930%** | 1.017 | 97.205 | 87.728 | 72.857 | 19/131 | $0.07776 | 44.33 s | xhigh |
| **gpt-5.6-sol** | **82.604%** | 1.088 | 98.137 | 82.245 | 67.429 | 42/131 | $0.08983 | 56.51 s | max |
| **claude-sonnet-5** | **82.429%** | 1.088 | 98.447 | 81.984 | 66.857 | 43/131 | $0.09466 | 77.02 s | max |
| **gpt-5.6-luna** | **NO ENTRY** | — | — | — | — | — | — | — | — |

- Terra/Sol/Sonnet-5 percentages were UNKNOWN in the digest → now exact. Ranks all confirm the digest (#19/#42/#43).
- **Luna is not on the Vals LCB leaderboard at all** — zero occurrences of "luna" in the LCB payload, and
  <https://www.vals.ai/models/openai_gpt-5.6-luna> contains no `lcb` reference. The digest's "Luna #33/131"
  (openai.md §4.2) is **wrong** — see mismatch M1.
- Sol's 82.604% vs Terra's 85.930% quantifies the digest's "highest-signal anomaly": the premium tier is
  **3.3 pts worse** at single-shot competitive codegen than the tier the digest tells you never to route to.
- **Official LiveCodeBench leaderboard: NO DATA for all 6.** <https://livecodebench.github.io/leaderboard.html>
  is client-rendered from <https://livecodebench.github.io/performances_generation.json>; that file was fetched
  and parsed: **28 models, newest is `Claude-Opus-4 (Thinking)`** era. Nothing from the 5.6 / Claude-5 generation.
  Vals is therefore the *only* LCB source for these models.

---

## GOAL 1c — Aider Polyglot: **NO DATA for all 6, benchmark confirmed abandoned**

<https://aider.chat/docs/leaderboards/> — all 139 table rows parsed. Zero matches for `terra`, `luna`,
`opus-5`, `sonnet-5`, `fable`. Top entry `gpt-5 (high) 88.0% / $29.08` (dirname `2025-08-23-15-47-21`);
**newest run of any model is `2025-10-03` (DeepSeek-V3.2-Exp)** — the board is ~10 months stale as of this pass.
Status: UNKNOWN-and-unclosable. Do not wait on it.

---

## GOAL 1d — Terminal-Bench 2.1 official leaderboard: **RESOLVED — and Sol + Opus 5 are absent**

<https://www.tbench.ai/leaderboard/terminal-bench/2.1> — page states "Displaying 17 of 17 available entries",
so this is the complete board. Harness ("Agent"), effort, cost/run and hack-rate are all published per row.

| # | Agent (harness) | Model | Effort | Accuracy | Date | Hacks | Cost/run |
|---|---|---|---|---|---|---|---|
| 1 | Claude Code | **Fable 5** | xhigh | **83.8% ±1.2** | Jun 7 2026 | −0.2% | $552.67 |
| 2 | Codex | GPT-5.5 | xhigh | 83.1% ±1.1 | May 1 2026 | −0.2% | $2,059.19 |
| 3 | Terminus 2 | **Fable 5** | high | **80.4% ±1.2** | Jun 5 2026 | −0.0% | $438.64 |
| 4 | Cursor CLI | Grok 4.5 | high | 79.3% ±1.5 | Jul 9 2026 | −9.0% | $134.09 |
| 5 | Claude Code | Opus 4.8 | high | 78.9% ±1.3 | Jul 9 2026 | −0.0% | $286.94 |
| 6 | Codex | **GPT-5.6 Terra** | max | **78.4% ±1.3** | Jul 11 2026 | −0.2% | **$421.15** |
| 7 | Terminus 2 | GPT-5.5 | xhigh | 78.0% ±1.2 | May 1 2026 | −0.2% | $493.85 |
| 8 | mini-SWE-agent | Muse Spark 1.1 | xhigh | 76.2% ±1.2 | Jul 9 2026 | −0.0% | $198.05 |
| 9 | Codex | **GPT-5.6 Luna** | max | **75.7% ±1.3** | Jul 11 2026 | −0.9% | **$241.45** |
| 10 | Claude Code | **Sonnet 5** | high | **74.6% ±1.6** | Jul 9 2026 | −0.7% | $288.18 |
| 11 | Terminus 2 | Gemini 3 Pro | high | 73.9% ±1.3 | May 1 2026 | −0.5% | $224.44 |
| 12–17 | Opus 4.7 ×2, Gemini 3/3.1 Pro ×3, GLM-5.1 | — | — | 68.9 → 58.7% | — | — | $224–600 |
| — | **gpt-5.6-sol** | — | — | **NOT LISTED** | — | — | — |
| — | **claude-opus-5** | — | — | **NOT LISTED** | — | — | — |

**Terra (78.4%) and Luna (75.7%) are new numbers** — both UNKNOWN in the digest. Sol's absence is new
information too: every Sol Terminal-Bench figure the digest carries (V 88.8/91.9, AA 89.5, Vals 85.77) comes
from a non-official harness, and **Opus 5 is still absent from the official board** (digest ✓).

### Cross-harness table for the same benchmark (the digest's Conflict #1, now fully populated)

| Model | tbench.ai official | Vals (Terminus 2) | AA (Codex harness) | Vendor |
|---|---|---|---|---|
| gpt-5.6-sol | **absent** | 85.768% ±1.35 (max) | **89.513%** (xhigh) / **88.015%** (max) | 88.8% / 91.9% Ultra (V, effort unlabelled) |
| gpt-5.6-terra | **78.4% ±1.3** (Codex/max) | **73.408%** ±2.085 (xhigh) | **88.015%** (max) | 87.4% (V) |
| gpt-5.6-luna | **75.7% ±1.3** (Codex/max) | 79.026% ±0.991 (max) | **80.899%** (max) | 84.7% (V) |
| claude-sonnet-5 | 74.6% ±1.6 (Claude Code/high) | 74.532% ±2.085 (max) | **80.524%** (max) | 80.4% (mini-SWE-agent, **xhigh**, GKE 1× timeout / 3× mem) |
| claude-opus-5 | **absent** | 84.644% ±0.991 (**high**, not max) | **89.139%** (max) / **88.015%** (xhigh) | not reported |
| claude-fable-5 | **83.8% ±1.2** (Claude Code/xhigh) | 80.524% ±1.35 | **84.644%** (with fallback) | 84.3% (V) |

Sources: tbench.ai URL above · <https://www.vals.ai/benchmarks/terminal-bench-2-1> (page methodology:
"All models were benchmarked using the Terminus 2 harness … All results reported are pass@1") ·
<https://artificialanalysis.ai/evaluations/terminalbench-v2-1> (JSON-LD `Terminal-Bench v2.1: Score`) ·
Sonnet-5 vendor harness/effort/infra from the Sonnet 5 system card §8.3 (`/tmp/bench/sonnet5_sc.txt` L≈3820).

**Routing-relevant reversal:** on the AA/Codex harness Terra (88.015%) **ties Sol-max and beats Luna by 7.1 pts**;
on Vals/Terminus-2 Terra (73.4%) **loses to Luna by 5.6 pts**. The digest's "Luna/Sol Pareto-dominate Terra" rule
is harness-conditional for terminal work — it holds on Terminus 2 and fails on Codex.

---

## GOAL 1e — AA Intelligence Index + cost: **RESOLVED, exact, per effort level**

All from JSON-LD `Dataset` blocks on the AA model pages (<https://artificialanalysis.ai/models/gpt-5-6-sol>,
`/gpt-5-6-terra`, `/gpt-5-6-luna`, `/claude-sonnet-5`, `/claude-opus-5`, `/claude-fable-5>`) and
<https://artificialanalysis.ai/models>. Index = **v4.1**.

| Model (effort) | AA Intelligence Index | $/Index task (published) | $/Index task (Σ components) | $ to run whole Index (Σ published components) |
|---|---|---|---|---|
| claude-opus-5 (max) | **60.6919** | $2.0277 | $2.0277 ✓ | $3,836 |
| claude-opus-5 (xhigh) | **60.0682** | — | — | $2,910 |
| claude-fable-5 (with fallback) | **59.8606** | $2.7498 | — | UNKNOWN (outside AA's 20-row chart) |
| claude-opus-5 (high) | **58.8642** | — | $1.0571 | $1,974 |
| gpt-5.6-sol (max) | **58.8898** | $1.5368 | $1.5368 ✓ | $3,443 |
| gpt-5.6-sol (xhigh) | **57.6538** | — | $0.9440 | $1,863 |
| gpt-5.6-sol (high) | **55.8665** | — | $0.6227 | $1,159 |
| claude-opus-5 (medium) | **56.2806** | — | $0.6184 | $1,115 |
| gpt-5.6-sol (medium) | **53.5888** | — | $0.4066 | $697 |
| gpt-5.6-terra (max) | **54.9529** | $0.7801 | $0.7801 ✓ | $2,010 |
| gpt-5.6-terra (xhigh) | **51.6046** | — | $0.4522 | $882 |
| claude-sonnet-5 (max) | **53.3500** | $1.5254 | $1.5254 ✓ | **$4,010** |
| gpt-5.6-luna (max) | **51.2359** | $0.2854 | $0.2854 ✓ | $954 |
| *claude-haiku-4-5 (ref, GOAL 3)* | *(not in v4.1 index chart)* | — | $0.2371 | $539 |

Cost components published per model/effort: `input`, `cacheHit`, `cacheWrite`, `answer`, `reasoning`. The
Σ-components column reproduces AA's headline `costPerIntelligenceIndexTask` **exactly** where both exist (✓),
so the per-effort sums for Sol high/xhigh/medium, Terra xhigh and Opus 5 high/medium are trustworthy derivations.
⚠ The "$ to run whole Index" column is a **sum of AA's own five published component costs**; it is *not*
proportional to $/task (implied task counts differ 1,891–3,344 across models), so treat it as AA's stacked-chart
total on its own basis, not as $/task × N.

**Two things a cost-bounded router should take from this table:**
1. **claude-sonnet-5 at max effort is the single most expensive model here to run the AA Index ($4,010)** — more
   than Opus 5 max ($3,836) and Sol max ($3,443), at 2.5× lower sticker price. This is an *independent second
   confirmation* of the digest's Vals-only finding ($9.01 > $8.54/test), from a different harness.
2. Sol at `medium` buys Index 53.59 for $0.4066/task; Sonnet 5 at `max` buys 53.35 for $1.5254/task — **same
   intelligence, 3.75× the cost.** Sol-medium also beats Luna-max (51.24) at 1.42× Luna's cost.

Other AA values pulled in the same sweep (all previously UNKNOWN or rounded in the digest):

| Metric | Sol | Terra | Luna | Sonnet 5 | Opus 5 | Fable 5 |
|---|---|---|---|---|---|---|
| AA-Omniscience Index | 21.70 (max) / 20.55 xh / 19.75 h / 18.95 m | **−0.217** | **−11.233** | 15.317 | 31.267 max / 29.80 xh / 28.083 h / 25.633 m | 40.15 |
| AA-Briefcase Elo (mid, CI) | 1503.5 (1493.78–1514.41) | UNKNOWN | UNKNOWN | 1385.36 (1376.86–1395.09) | 1720.87 / 1693.05 xh / 1606.01 h / 1470.21 m | 1573.78 (1562.40–1585.03) |
| **AA-LCR (long-ctx reasoning)** | **73.67%** | **74.00%** | **74.00%** | **70.67%** | **70.00%** | **70.00%** |
| Output tokens/Index task (answer+reasoning) | 15,346 max | 19,370 max | 18,912 max | UNKNOWN | 28,703 xh | 33,127 |
| Time per Index task (h) | 3.398 max / 2.335 xh / 1.587 h / 0.986 m | 2.206 max / 1.405 xh | 1.585 max | UNKNOWN | 5.413 xh / 3.696 h / 2.300 m | 4.652 |
| AA context window (note) | 1,000,000 | 1,000,000 | 1,000,000 | 1,000,000 | 1,000,000 | 1,000,000 |

AA-LCR source: <https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning> (JSON-LD
`AA-LCR: Score`, 20 rows; leader `GPT-5.2 Codex (xhigh) 75.67%` — digest ✓). See mismatch **M8**: this is the
biggest single correction in this pass.

---

## GOAL 1f — latency / throughput / TTFT: **partially resolved**

| Model (effort) | Median output tok/s (AA, `I`) | TTFT — time to first answer token (AA, `I`) | End-to-end answer time (AA) | Vals mean latency/test (`I`) |
|---|---|---|---|---|
| gpt-5.6-luna (max) | **196.646** | **118.469 s** ← worst of all six | 2.543 s | 554.38 s |
| gpt-5.6-terra (max) | **142.740** | UNKNOWN | UNKNOWN | 352.05 s |
| gpt-5.6-terra (xhigh) | **127.561** | **12.601 s** | 3.920 s | — |
| claude-sonnet-5 (max) | **78.956** | UNKNOWN | UNKNOWN | 1324.29 s |
| gpt-5.6-sol (max) | **73.132** | UNKNOWN | UNKNOWN | 753.48 s |
| gpt-5.6-sol (xhigh) | 70.830 | **26.631 s** | 7.059 s | — |
| gpt-5.6-sol (high) | 68.881 | **11.576 s** | 7.259 s | — |
| gpt-5.6-sol (medium) | 71.854 | **4.129 s** | 6.959 s | — |
| claude-fable-5 (w/ fallback) | **73.057** | UNKNOWN | UNKNOWN | 1050.68 s |
| claude-opus-5 (max) | **55.424** | **50.606 s** | 9.021 s | 1182.44 s |
| claude-opus-5 (xhigh) | — | **39.349 s** | 9.284 s | — |
| claude-opus-5 (high) | — | **15.873 s** | 9.312 s | — |
| claude-opus-5 (medium) | — | **5.781 s** | 9.985 s | — |
| *claude-haiku-4-5 (ref)* | *106.262* | *14.789 s* | *4.705 s* | *376.93 s* |

Sources: AA JSON-LD `Speed` / `Output Speed` / `Latency: Time To First Answer Token` / `End-to-End Response Time`
on the six model pages + <https://artificialanalysis.ai/models> · Vals latency from each benchmark payload
(`latency`, Vals Index page). Output-speed values confirm the digest's rounded 73.1 / 142.7 / 196.6 / 79.0
and add Opus 5 (55.4) and Fable 5 (73.1), both previously UNKNOWN.

**Still UNKNOWN:** TTFT for Sol-max, Terra-max, Sonnet-5-max and Fable-5. Reason (not a fetch failure): AA's
TTFT chart is a **fixed 20-row list** and those four configurations fall outside it on every page that carries
the chart. No AA endpoint reachable without JS exposes the rest. Third-party TTFT (pricepertoken: Sol 1.11 s /
58 tok/s) remains contradicted by AA and stays `A`-grade — do not route on it.

**New latency fact worth a routing rule:** Luna is the *fastest streamer* (196.6 tok/s) and the *slowest starter*
(118.5 s TTFT at max) of all six. For interactive/low-latency actions, Luna at `max` is the worst choice in the
set despite its throughput; the digest's cheap-tier framing implicitly assumes low effort, and that assumption
is now load-bearing.

---

## GOAL 2 — spot-verification of the 10 routing-critical numbers

| # | Number (digest value) | Primary source | Verdict |
|---|---|---|---|
| 1 | gpt-5.6 prices 5/30, 2.5/15, 1/6; cached 0.50/0.25/0.10; >272K 10/45, 5/22.50, 2/9 | <https://developers.openai.com/api/docs/pricing> | **CONFIRMED** exactly (Terra cache-write $3.125) |
| 2 | Sonnet 5 $2/$10 → **$3/$15 on 2026-09-01**; cache-hit 0.20→0.30; batch 1/5→1.50/7.50 | <https://platform.claude.com/docs/en/about-claude/pricing> + models-overview fn 4 | **CONFIRMED** ("Introductory pricing … through August 31, 2026"); 5m-write $2.50→$3.75, 1h-write $4→$6 |
| 3 | Opus 5 $5/$25, Fable 5 $10/$50, 1M ctx, no long-ctx premium | Anthropic pricing + models overview | **CONFIRMED** |
| 4 | SWE-rebench: Fable 64.5/$4.40, Opus 63.4/$3.47, Sol 62.3/$0.85, Sonnet 56.8/$1.43, Luna 43.6/$0.11 | <https://swe-rebench.com/> | **CONFIRMED** to the decimal, incl. all ± and cache% |
| 5 | AA Index 61 / 60 / 59 / 55 / 53 / 51 | AA model pages (JSON-LD) | **CONFIRMED** = 60.69 / 59.86 / 58.89 / 54.95 / 53.35 / 51.24 |
| 6 | MRCR v2 8-needle: Luna 41.3/41.3, Terra 89.6/72.5, Sol 91.5/73.8 | <https://openai.com/index/gpt-5-6/> (vendor table) | **CONFIRMED** exactly; GraphWalks 1M 77.1/71.2/51.2 also confirmed |
| 7 | Vals Index + cost/test all six (Sonnet $9.01 > Opus $8.54) | <https://www.vals.ai/benchmarks/vals_index> | **CONFIRMED** (75.145/74.820/74.700 K3/73.118/69.878/68.608/65.135; $11.0025/$8.5384/$7.4571/$9.0124/$2.6552/$1.0887) |
| 8 | Vals SWE-bench Verified: Opus 97.0, Sol 96.2, Fable 95.0, Luna 93.0 | <https://www.vals.ai/benchmarks/swebench> | **CONFIRMED**; **two gaps closed** — see M3/M4 |
| 9 | Vendor SWE-bench Verified: Sonnet 5 85.2%, Opus 5 96.0% | Sonnet 5 / Opus 5 system cards §8.2 | **CONFIRMED** verbatim ("Claude Sonnet 5 achieved 85.2%", "Claude Opus 5 achieved 96.0%") |
| 10 | LMArena: Fable 1508±6/16,056 #1; Opus 5 1495±12 #5, 1493±8 #7; Sol-xhigh 1485±7 #13; Sonnet 5 1460±6 #43; Terra/Luna no data | <https://arena.ai/leaderboard/text> | **CONFIRMED** all, incl. vote counts; Terra (`gpt-5.6-terra-medium`) and Luna are in the arena *registry* but have **no ranked row** |

### Mismatches found (both values + URLs)

| ID | Digest / source report says | Primary source now says | URL | Router impact |
|---|---|---|---|---|
| **M1** | Vals LiveCodeBench **Luna #33/131** (openai.md §4.2) | **Luna has no LCB entry** (0 hits in payload; model page has no `lcb`) | <https://www.vals.ai/benchmarks/lcb> · <https://www.vals.ai/models/openai_gpt-5.6-luna> | removes a Luna capability claim; LCB-shaped work has no Luna evidence at all |
| **M2** | AA cost per Index task: **Sol $1.04 / Terra $0.55 / Luna $0.21** (openai.md §4.1, launch article) | **$1.5368 / $0.7801 / $0.2854** | AA model pages, JSON-LD `Cost per Task` | **+48% / +42% / +36%.** Sol-max/task is now ≈ Sonnet-5-max/task ($1.5368 vs $1.5254), not 2/3 of Opus 5 |
| **M3** | Vals SWE-bench Verified Sonnet 5 "**not published**" (anthropic.md §4c) | **79.600% ±1.804, #15/75**, $1.4899/test; bands 83.5/77.4/76.2/66.7 | <https://www.vals.ai/benchmarks/swebench> | independent Sonnet 5 is **5.6 pts below** its own vendor 85.2% |
| **M4** | Vals SWE-bench Verified Terra "**rank only, UNKNOWN**" | **75.200% ±1.933, #32/75**, $0.7160/test; bands 77.8/75.5/64.3/**33.3** | same | Terra is **17.8 pts below Luna** (93.0%) here and collapses to 33.3% on >4 h tasks — strongest anti-Terra evidence yet |
| **M5** | "Vals hyperparameters for all three [Claudes]: **compute effort = max**" (anthropic.md §4c) | Sonnet 5 & Fable 5 = `max`; **Opus 5 = `high` on Terminal-Bench 2.1** and **unspecified (null)** on Vals Index / SWE-bench / LCB / GPQA | payload fields `compute_effort` on each Vals benchmark page | Opus 5's 84.644% TB2.1 is a **high-effort** number → *strengthens* digest policy 3 ("route Opus at high/xhigh, not max") |
| **M6** | digest Artifact A labels Sonnet 5's 74.53% TB2.1 as "**(mini-swe-agent, max)**" | Vals TB2.1 methodology: "**All models were benchmarked using the Terminus 2 harness**". mini-SWE-agent is the *SWE-bench* harness; separately it is Anthropic's *vendor* TB harness (80.4% at **xhigh**) | <https://www.vals.ai/benchmarks/terminal-bench-2-1> · Sonnet 5 SC §8.3 | harness label in the routing artifact is wrong; fix before any cross-harness comparison |
| **M7** | AA-Briefcase Sol **1505** (anthropic.md) / "#2 overall" (openai.md); Sonnet 5 **1391** | Sol **1503.5** (1493.78–1514.41); Sonnet 5 **1385.36** (1376.86–1395.09) | AA JSON-LD `AA-Briefcase Elo` | cosmetic; resolves digest Conflict #2 in favour of ~1503.5 |
| **M8** | "**AA-LCR: GPT-5.6 = UNKNOWN (not top-3) — 5.6 does not lead AA long-context reasoning**" (openai.md §4.1) | **Luna 74.00%, Terra 74.00%, Sol 73.67%** — i.e. Luna and Terra are the **joint-best of all six**, above Sonnet 5 (70.67%) and Opus 5 / Fable 5 (70.00%) | <https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning> | **directly contradicts digest hard-stop "Luna long context collapses."** Correct framing: Luna collapses on **256K+ multi-needle retrieval** (MRCR 41.3%, GraphWalks-1M 51.2%) but is *top-of-set* on long-context **reasoning** at AA-LCR document sizes. Also kills the "Terra's one clean win is long context" exclusivity |
| **M9** | "Sonnet 5 uses a **new tokenizer** producing ~30% more tokens" framed as a Sonnet-5-specific trap | "**Claude 4.7 and later models** and Claude Mythos Preview use a newer tokenizer … approximately 30% more tokens" | <https://platform.claude.com/docs/en/about-claude/pricing> | applies to Opus 5 and Fable 5 too → **not a Sonnet-vs-Opus differentiator**, only a Claude-vs-GPT one |
| **M10** | context window 1,050,000 (OpenAI docs) | AA reports **1,000,000** for all GPT-5.6 | AA JSON-LD `Context Window` | cosmetic; keep the vendor 1,050,000, note AA rounds |
| **M11** | Vals GPQA "Sonnet 5 #25/126, % not published"; Luna/Terra UNKNOWN | **Sonnet 5 88.889% ±2.224 (#25)**, **Luna 91.666% (#12)**, **Terra 90.909% (#18)** | <https://www.vals.ai/benchmarks/gpqa> | closes three UNKNOWNs; Luna > Terra > Sonnet 5 on GPQA |
| **M12** | OpenAI pricing = single standard tier | OpenAI publishes **Standard / Batch (−50%) / Flex (−50%) / Priority (2×)** for the 5.6 trio, plus a **+10% regional-processing uplift for models released on/after 2026-03-05** | <https://developers.openai.com/api/docs/pricing> | **whole service-tier axis missing from the digest** — see below |

**M12 detail (new cost lever, not a correction):**

| Model | Standard in/out | Batch in/out | Flex in/out | Priority in/out |
|---|---|---|---|---|
| gpt-5.6-sol | $5.00 / $30.00 | $2.50 / $15.00 | $2.50 / $15.00 | $10.00 / $60.00 |
| gpt-5.6-terra | $2.50 / $15.00 | $1.25 / $7.50 | $1.25 / $7.50 | $5.00 / $30.00 |
| gpt-5.6-luna | $1.00 / $6.00 | $0.50 / $3.00 | $0.50 / $3.00 | $2.00 / $12.00 |

Batch/Flex Luna at **$0.50/$3.00** is the cheapest 5.6-class configuration in existence and the digest never
mentions it; Anthropic's Batch (−50%) *is* in the digest, so the two vendors were being compared on unequal terms.

---

## GOAL 3 — cheap-tier coverage check (OpenAI + Anthropic only)

**Yes — three currently-released models a cost-bounded router would obviously want, and the research missed all
three.** Two are OpenAI `gpt-5.4`-generation small models (released 2026-03-17, still listed and priced), one is
Anthropic's only Haiku-class model.

| id | Price in / cached / out | Ctx / max-out | Benchmark signal (one, with $/test) | Source |
|---|---|---|---|---|
| **`gpt-5.4-nano-2026-03-17`** | **$0.20 / $0.02 / $1.25** | short-context tier only (no >272K row) | **Vals LiveCodeBench 84.009% ±1.044, #34/131, at $0.0025/test** — *higher than gpt-5.6-sol's 82.604% at 1/36 the cost per test* | price <https://developers.openai.com/api/docs/pricing> · <https://www.vals.ai/benchmarks/lcb> |
| **`gpt-5.4-mini-2026-03-17`** | **$0.75 / $0.075 / $4.50** | short-context tier only | **Vals Index 52.425% ±2.054, #23/40, at $0.660/test** — 75% of Luna's Index score at 61% of Luna's cost/test | same · <https://www.vals.ai/benchmarks/vals_index> |
| **`claude-haiku-4-5` (`claude-haiku-4-5-20251001`)** | **$1.00 / $0.10 / $5.00** (5m write $1.25, 1h write $2.00) | 200K / 64K | **Vals SWE-bench Verified 66.600% ±2.111, #60/75, at $0.3662/test**; AA-LCR **70.33%** (= Opus 5 / Fable 5) | <https://platform.claude.com/docs/en/about-claude/pricing> · <https://platform.claude.com/docs/en/about-claude/models/overview> · Vals · AA-LCR |

Full comparison of the three cheap-tier candidates against Luna, all from the same five Vals payloads:

| Benchmark | gpt-5.4-nano | gpt-5.4-mini | claude-haiku-4-5 | (gpt-5.6-luna, for scale) |
|---|---|---|---|---|
| Vals Index | 46.635% #31/40 · $0.3251 | 52.425% #23/40 · $0.6597 | 40.903% #35/40 · $0.5581 | 69.878% #6/40 · $1.0887 |
| SWE-bench Verified | 69.800% #53/75 · $0.0977 | 73.000% #42/75 · $0.5111 | 66.600% #60/75 · $0.3662 | 93.000% #5/75 · $0.2136 |
| LiveCodeBench | **84.009% #34/131** · $0.0025 | 81.465% #52/131 · $0.0329 | 41.175% #118/131 · $0.0598 | no entry |
| GPQA Diamond | 77.526% #66/126 · $0.0016 | 83.080% #47/126 · $0.0127 | 72.222% #78/126 · $0.0551 | 91.666% #12/126 · $0.0531 |
| Terminal-Bench 2.1 | 41.573% #41/45 · $0.0723 | 54.682% #27/45 · $0.2867 | 43.820% #39/45 · $0.3638 | 79.026% #5/45 · $0.2688 |
| SWE-rebench | **NO DATA** (registry N/A) | **NO DATA** | **NO DATA** | 43.6% · $0.11 |
| AA output speed / TTFT | UNKNOWN | UNKNOWN | 106.262 tok/s / 14.789 s | 196.646 tok/s / 118.469 s |

Findings a router should act on:
1. **`gpt-5.4-nano` beats `claude-haiku-4-5` on all five Vals benchmarks while costing 5× less per token**
   ($0.20/$1.25 vs $1/$5). If a sub-Luna tier is wanted, it is `gpt-5.4-nano`, not Haiku 4.5.
2. **`gpt-5.4-nano` beats `gpt-5.6-sol` on Vals LiveCodeBench** (84.009% vs 82.604%) — reinforcing the digest's
   "never route LCB-shaped work to Sol" rule with a 25×-cheaper positive alternative.
3. Anthropic has **no 2026 cheap tier at all**: the pricing page lists only Haiku 4.5 (Oct 2025, cutoff Feb 2025,
   200K ctx, no adaptive thinking) and retired Haiku 3.5. Anthropic's own docs route trivial work to Haiku 4.5,
   but its LCB 41.2% (#118/131) and AA-Briefcase Elo 611.83 make it unsuitable for anything code-shaped.
4. Neither `gpt-5.4-mini` nor `gpt-5.4-nano` has a long-context price row (short-context tier only) and neither
   appears on SWE-rebench — so any escalation from them must be measured, not assumed.
5. Out of scope but noted so nobody re-researches it: `gpt-5.5-pro` and `gpt-5.4-pro` exist at $30/$180 standard
   ($15/$90 batch); `claude-mythos-5` / `claude-mythos-preview` are invitation-only (Project Glasswing).

---

## Residual UNKNOWNs after this pass

| Item | Why it stays UNKNOWN |
|---|---|
| TTFT for Sol-max, Terra-max, Sonnet-5-max, Fable-5 | AA's TTFT chart is a fixed 20-row list; these four configs fall outside it on every page carrying it |
| Output tokens / time per Index task for Sonnet 5 | same 20-row truncation |
| $ to run whole AA Index for Fable 5 | same |
| gpt-5.6-luna on Vals LiveCodeBench | model genuinely not submitted (M1) |
| gpt-5.6-sol and claude-opus-5 on official Terminal-Bench 2.1 | genuinely not submitted (17/17 board complete) |
| gpt-5.6-terra on SWE-rebench | genuinely not in the registry (117/117 rows) |
| Aider Polyglot, any of the 6 | benchmark abandoned; newest run 2025-10-03 |
| Official LiveCodeBench, any of the 6 | `performances_generation.json` stops at the Claude-Opus-4 era |
| Epoch FrontierMath / ECI per-model values | not retried this pass; still JS-only per prior report |
| OpenAI factuality Figure 4 numerals | image-only per prior report; not retried |
| Terra / Luna LMArena Elo | in arena registry (`gpt-5.6-terra-medium`, `gpt-5.6-luna`), no ranked row yet |

**Files touched:** `/tmp/model-router-research/gaps.md` (this file) only. Working artifacts in `/tmp/gapwork/`
(raw HTML/JSON + `valsparse.py`, `rank.py`, `eff.py`, `aa.py`, `aa2.py`, `astro.py`). No repository files written.
