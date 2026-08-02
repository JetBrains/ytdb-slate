# Capability & Cost Report — `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`

**As of 2026-07-29.** V = vendor-reported · I = independently measured. Every number carries a source.

## 1. Existence & Identity — ALL THREE EXIST, ALL THREE ARE ANTHROPIC

"fable-5" is **not** a different company's model — it is **Claude Fable 5**, Anthropic's first *Mythos-class* model (a tier Anthropic places **above** Opus). It is the safeguarded public twin of `claude-mythos-5` (Project Glasswing, invitation-only).

| | Sonnet 5 | Opus 5 | Fable 5 |
|---|---|---|---|
| **API ID** | `claude-sonnet-5` | `claude-opus-5` | `claude-fable-5` |
| Vendor | Anthropic | Anthropic | Anthropic |
| Released | **2026-06-30** | **2026-07-24** | **2026-06-09** |
| Class | Sonnet | Opus | Mythos-class |
| Bedrock ID | `anthropic.claude-sonnet-5` | `anthropic.claude-opus-5` | `anthropic.claude-fable-5` |
| Google Cloud ID | `claude-sonnet-5` | `claude-opus-5` | `claude-fable-5` |
| Announcement | [news/claude-sonnet-5](https://www.anthropic.com/news/claude-sonnet-5) | [news/claude-opus-5](https://www.anthropic.com/news/claude-opus-5) | [news/claude-fable-5-mythos-5](https://www.anthropic.com/news/claude-fable-5-mythos-5) |
| System card | [claude-sonnet-5-system-card](https://www.anthropic.com/claude-sonnet-5-system-card) | [claude-opus-5-system-card](https://www.anthropic.com/claude-opus-5-system-card) | [claude-fable-5-mythos-5-system-card](https://www.anthropic.com/claude-fable-5-mythos-5-system-card) |

Specs/IDs: [platform.claude.com models/overview](https://platform.claude.com/docs/en/about-claude/models/overview). All IDs are **pinned snapshots**, not evergreen aliases (dateless format since the 4.6 generation).

## 2. Pricing / Specs / Knobs

Source for all: [pricing docs](https://platform.claude.com/docs/en/about-claude/pricing), [models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort), [whats-new-sonnet-5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5)

| $/MTok | Sonnet 5 (now→Sep 1) | Opus 5 | Fable 5 |
|---|---|---|---|
| Input | **$2 → $3** | $5 | $10 |
| Output | **$10 → $15** | $25 | $50 |
| Cache write 5m | $2.50 → $3.75 | $6.25 | $12.50 |
| Cache write 1h | $4 → $6 | $10 | $20 |
| Cache hit | $0.20 → $0.30 | $0.50 | $1.00 |
| Batch (50% off) | $1/$5 → $1.50/$7.50 | $2.50/$12.50 | $5/$25 |
| Fast mode | n/a | $10/$50 (2.5× speed) | n/a |
| Context | 1M | 1M | 1M |
| Max output | 128k (300k via batch beta) | 128k (300k) | 128k (300k) |
| Reliable knowledge cutoff | **Jan 2026** | **May 2026** | **Jan 2026** |
| Effort levels | low/med/high/xhigh/max (default high) | all 5 (default high) | all 5 (default high) |
| Thinking | adaptive, default on; manual → 400 error | adaptive; cannot disable at xhigh/max | adaptive, **always on** |
| Sampling params | non-default → **400 error** | 400 error | 400 error |
| ZDR | **Yes** | Yes | **NO — 30-day retention mandatory** |

⚠️ **Two cost traps.** (1) Sonnet 5's introductory price **ends 2026-08-31** — a **+50% increase** in ~4 weeks. (2) Sonnet 5 uses a new tokenizer producing **~30% more tokens for identical text**, so per-token parity ≠ per-request parity.

Additional pricing modifiers (all three): `inference_geo: "us"` applies a **1.1×** multiplier on every token category; Bedrock/Google Cloud regional & multi-region endpoints carry a **+10%** premium over global; 1M context is billed at standard rates with **no long-context premium**; cache multipliers are 1.25× (5m write), 2× (1h write), 0.1× (hit).

## 3. Vendor-reported benchmarks (V)

From the three system cards' §8.1 summary tables + announcement chart images.

| Benchmark | Sonnet 5 | Opus 5 | Fable 5 | (Mythos 5) | Opus 4.8 | Best rival |
|---|---|---|---|---|---|---|
| **SWE-bench Verified** | **85.2%** | **96.0%** | **95%** | 95.5% | 88.6% | — |
| SWE-bench Pro | 63.2 | 79.2 | 80 | 80.3 | 69.2 | GPT-5.6 Sol 64.6 |
| SWE-bench Multilingual | 78.3 | **89.5** | 86.6 | — | 84.4 | — |
| SWE-bench Multimodal | 28.1 | **59.4** | 54.1 | — | 38.4 | — |
| **Terminal-Bench 2.1** | 80.4 | *not reported* | 84.3 | 88.0 | 82.7 | GPT-5.5+Codex 83.4 |
| **Frontier-Bench v0.1** | — | **43.3** | 33.8 | — | 21.1 | GPT-5.6 Sol 34.4 |
| DeepSWE v1.1 | — | 68.8 | 69.7 | — | 59.0 | **GPT-5.6 Sol 72.7** |
| FrontierCode 1.1 Main | 38.8 (v1) | 53.4 | 53.5 | — | 46.5 | GPT-5.6 Sol 47.5 |
| FrontierCode Diamond | — | — | 29.3 | — | 13.4 | GPT-5.5 5.7 |
| **HLE** no tools / tools | 43.2 / 57.4 | 56.3 / **64.7** | 56.5 / 63.9 | 59.0/64.5 | 49.8/57.9 | GPT-5.5 41.4/52.2 |
| **OSWorld-Verified** | 81.2 | — | **85.0** | 85.0 | 83.4 | GPT-5.5 78.7 |
| **OSWorld 2.0** | — | **70.6** | 66.1 | — | 55.7 | GPT-5.6 Sol 62.6 |
| BrowseComp | 84.7 / 86.6 multi | **90.8** | 87.4 | 88.0/93.3 | 84.3 | GPT-5.6 Sol 90.4 |
| **GDPval-AA v2** (Elo) | 1618 | **1861** | 1747 | — | 1593–1615 | GPT-5.6 Sol 1736 |
| AA-Briefcase (Elo) | — | **1720** | 1574 | — | 1346 | GPT-5.6 Sol 1505 |
| AutomationBench | 13.5 | **26.0** | 17.4 | — | 17.0 | GPT-5.6 Sol 18.1 |
| **ARC-AGI-1 / -2 / -3** | — | **97.5 / 90.4 / 30.2** | — / — / — | — | 92.5/72.1/1.5 | GPT-5.6 Sol 97.5/92.5/7.8 |
| **ProgramBench** (long ctx, ep1→ep5) | 76→86% | 83→**93%** | — | 84→93% | 80→90% | — |
| GraphWalks BFS/Parents 256K | — | — | — | 91.1 / 99.96 | 85.9/99.3 | GPT-5.5 73.7/90.1 |
| HealthBench Professional | 57.8 | 59.8 | — | **66.0** | 56.9–57.4 | GPT-5.6 Sol 60.5 |
| Legal Agent (Harvey held-out) | 5.8 | 11.7 | **13.3** | — | 10.4 | GPT-5.6 Sol 2.5 |
| Blueprint-Bench 2 (spatial) | — | — | **38.6** | — | 14.5 | GPT-5.5 36.2 |
| CritPt | — | — | — | 28.6 | 20.9 | GPT-5.5 27.1 |
| GDPval-AA v1 (Elo) | — | — | **1932** | 1932 | 1890 | GPT-5.5 1769; Gemini 3.1 Pro 1314 |
| GDP.pdf (vision, no tools) | — | — | **29.8** | — | 22.5 | GPT-5.5 24.9 |
| OfficeQA Pro | — | — | **57.9** | — | 48.1 | GPT-5.5 52.6 |
| ArxivMath | — | — | — | **78.5** | 71.8 | GPT-5.5 71.5 |
| RiemannBench | — | — | — | **55.0** | 34.0 | — |
| CharXiv Reasoning (no/with tools) | — | — | — | **88.9 / 93.5** | 80.5/89.9 | — |
| BioMysteryBench (human/hard) | — | 90.1 / **49.4** | 89.0 / 46.5 | 83.9/46.1 | 88.5/42.4 | — |

Methodology note carried on all three tables: unless noted, Claude results use **adaptive thinking at max effort, default sampling, averaged over 5 trials**; context windows are evaluation-dependent and never exceed 1M. Competitor figures are drawn from rivals' own system cards/leaderboards. Fable 5's scores **reflect its production safeguards including fallback to Opus 4.8**, which is why some rows are lower for Fable than Mythos 5.

## 4. Independently measured (I)

### 4a. Artificial Analysis — Intelligence Index v4.1 (9 evals)

[Opus 5 article](https://artificialanalysis.ai/articles/opus-5) · [Opus 5 briefcase article](https://artificialanalysis.ai/articles/claude-opus-5-leader-agentic-knowledge-work) · [Sonnet 5 article](https://artificialanalysis.ai/articles/claude-sonnet-5-agentic-cost) · [Fable 5 article](https://artificialanalysis.ai/articles/claude-fable-5-mythos-intelligence-index)

Index v4.1 components: GDPval-AA v2, τ³-Banking, Terminal-Bench v2.1, SciCode, Humanity's Last Exam, GPQA Diamond, CritPt, AA-Omniscience, AA-LCR.

| | Sonnet 5 (max) | Opus 5 (max) | Fable 5 (max, w/ fallback) |
|---|---|---|---|
| **AA Intelligence Index** | **53** (#5) | **61** (#1) | **60** |
| by effort | — | max 61 / xhigh 60 / high 59 / med 56 | — |
| **Cost per Index task** | $1.53 | $2.03 | $2.75 |
| GDPval-AA v2 | 55% | **68%** (1861) | 62% (1747) |
| τ³-Banking (tool use) | 28% | **33%** | ~27% |
| Terminal-Bench v2.1 | 81% | **89%** | 84% |
| SciCode | 54% | 56% | **60%** |
| HLE | 40% | **53%** | **53%** |
| GPQA Diamond | 91% | **94%** | 93% |
| CritPt (physics) | 17% | 29% | 29% |
| AA-Omniscience Accuracy | 38% | 54% | **61%** |
| **Non-hallucination rate** | **63%** | 50% | 45–46% |
| **AA-LCR (long context)** | **71%** | 70% | 70% |
| AA-Briefcase Elo | 1391 | **1720** | 1574 |
| MMMU-Pro (vision) | ~77% | **85%** | — |
| IFBench (instr. following) | NO DATA | NO DATA | **63%** (weak; leader 83%) |

Also: Opus 5 (xhigh)+Claude Code is **joint #1 on the AA Coding Index**, with the highest SWE-Atlas-QnA score. Fable 5 was **#1 at launch on index v4.0 with 64.9**, ~5 points ahead of GPT-5.5, setting the top score on 5 of 10 underlying benchmarks; τ²-Bench Telecom **99%**, Terminal-Bench Hard **63%**, HLE **53%**, AA-Omniscience accuracy **61%** (+7 over prior leader), SciCode **60%**, CritPt **29%**, AA-LCR **70%**, IFBench **63%**.

**AA-Briefcase economics (agentic knowledge work, Elo + cost + wall time):**

| Variant | Elo | $/task | min/task | turns/task |
|---|---|---|---|---|
| Opus 5 max | **1720** | $17.79 | 36.2 | 103 |
| Opus 5 xhigh | 1693 | $14.26 | 34.3 | 91 |
| Opus 5 high | 1606 | **$10.41** | 25.7 | 76 |
| Fable 5 | 1574 | $22.30 | — | — |
| GPT-5.6 Sol max | 1505 | — | — | — |
| Opus 5 medium | 1470 | — | — | — |
| Sonnet 5 max | 1391 | — | — | — |
| Opus 4.8 max | 1346 | — | 24.1 | 55 |
| Opus 5 low | 1223 | — | — | — |

Opus 5 max Analytical Quality Elo **2016** (~+300 over Fable 5), but Presentation Elo **1628** — still ~40 behind GPT-5.6 Sol max (1666).

**AA on Sonnet 5's token economics (index v4.0 run):** Sonnet 5 cost **$2.29 per Index task — ~2× Sonnet 4.6 and ~15% MORE than Opus 4.8** — driven entirely by token usage: ~40% more output tokens per task than Sonnet 4.6 and ~3× the agentic turns on knowledge-work evals; max effort uses ~6× more turns than low on GDPval-AA. Sonnet 5 output speed 79.0 t/s (below its tier median). AA's Sonnet 5 figures use standard $3/$15, not promo pricing.

### 4b. SWE-rebench — contamination-resistant, fresh GitHub issues, fixed ReAct scaffold

[swe-rebench.com](https://swe-rebench.com/) — **the single best cost-aware signal here.** Methodology: fresh GitHub issues to avoid contamination, 5 runs per problem, fixed scaffolding, best pass@1 resolved rate.

| Rank | Model | Resolved | Pass@5 | **$/problem** | Tokens/problem |
|---|---|---|---|---|---|
| 1 | **Fable 5** [high] | **64.5% ±1.41** | 78.4% | $4.40 | 2,518,308 (94.9% cached) |
| 2 | Grok 4.5 [high] | 63.8% ±0.60 | 77.5% | $1.47 | 2,429,424 |
| 3 | **Opus 5** [high] | **63.4% ±1.35** | 74.8% | $3.47 | 4,322,143 (95.7% cached) |
| 4 | GLM-5.2 [high] | 62.9% ±1.19 | 81.1% | $1.40 | 5,524,892 |
| 5 | GPT-5.6 Sol [med] | 62.3% ±1.83 | 79.3% | $0.85 | 605,340 |
| 7 | Claude Code (agent) | 60.4% ±1.03 | 75.7% | $3.39 | 3,341,581 |
| 9 | **Sonnet 5** [high] | **56.8% ±0.94** | 74.8% | **$1.43** | 4,645,617 (96.4% cached) |

### 4c. Vals AI

[SWE-bench Verified](https://www.vals.ai/benchmarks/swebench) (mini-swe-agent, bash-only harness) · [LiveCodeBench](https://www.vals.ai/benchmarks/lcb) · [GPQA Diamond](https://www.vals.ai/benchmarks/gpqa) · [Terminal-Bench 2.1](https://www.vals.ai/benchmarks/terminal-bench-2-1) · model pages: [Opus 5](https://www.vals.ai/models/anthropic_claude-opus-5), [Sonnet 5](https://www.vals.ai/models/anthropic_claude-sonnet-5), [Fable 5](https://www.vals.ai/models/anthropic_claude-fable-5)

| | Sonnet 5 | Opus 5 | Fable 5 |
|---|---|---|---|
| Vals Index | 68.61% ±1.00 (#7/40) | 74.82% ±1.35 (#2/40) | **75.14% ±0.64 (#1/40)** |
| **Cost/test** | **$9.01** | $8.54 | $11.00 |
| Latency/test | 1324s | 1182s | 1051s |
| Vals listed release date | 6/30/2026 | 7/22/2026 | 6/9/2026 |
| SWE-bench Verified | not published (per-difficulty 84/77/76/67%) | **97.00% (#1)** | 95.00% (#3) |
| LiveCodeBench | #43/131 (% not published) | 89.03% (#2) | **89.78% (#1)** |
| GPQA Diamond | #25/126 (% not published) | 93.43% | 93.18% |
| Terminal-Bench 2.1 | 74.53% (#7/45) | 84.64% (#2/45) — **81.27%** if fallbacks=fail | 80.52% (#4/45) |
| Legal Research Bench | #6/27 | **#1/27** | #2/27 |
| Code Migration | #7/33 | **#1/33** | #2/33 |
| Vibe Code Bench v1.1 | #5/76 | #2/76 | **#1/76** |
| IOI | not listed | **#1/60** | #4/60 |
| CyberBench | not listed | **#18/20** | not listed |
| Vals Multimodal Index | #7/29 | #2/29 | **#1/29** |

Vals hyperparameters for all three: temperature 1, default top-p/top-k, max output 128,000, **compute effort = max**, provider Anthropic.

SWE-bench Verified context: Opus 5 97.00% > GPT-5.6 Sol 96.20% > Fable 5 95.00% > Kimi K3 93.40% > GPT-5.6 Luna 93.00% > Opus 4.8 88.60% > Grok 4.5 86.60%.
GPQA Diamond context (Vals calls it "largely saturated"): Gemini 3.1 Pro 95.45% > GPT-5.6 Sol 95.20% > Gemini 3.6 Flash / Opus 5 93.43% > Fable 5 / GPT-5.5 93.18%.
Terminal-Bench 2.1 context: GPT-5.6 Sol 85.77% > Opus 5 84.64% > Kimi K3 80.90% > Fable 5 80.52% > GPT-5.6 Luna 79.03% > GPT-5.5 76.40% > Sonnet 5 74.53%.

⚠️ **Sonnet 5 costs MORE per test than Opus 5 on the Vals Index ($9.01 vs $8.54)** despite a 2.5× cheaper sticker price — verbosity eats the discount.

### 4d. Other independent sources

| Source | Sonnet 5 | Opus 5 | Fable 5 |
|---|---|---|---|
| **LMArena** ([arena.ai/leaderboard/text](https://arena.ai/leaderboard/text/)) | #43, 1460±6 (15,622 votes) | #5 max 1495±12 (2,386); #7 high 1493±8 (6,159) | **#1, 1508±6 (16,056)** |
| **Terminal-Bench official** ([tbench.ai](https://www.tbench.ai/leaderboard/terminal-bench/2.1)) | Claude Code high **74.6% ±1.6** ($288.18) | **not listed** | **#1** Claude Code xhigh **83.8% ±1.2** ($552.67); Terminus 2 high 80.4% ±1.2 ($438.64) |
| **ARC Prize verified** ([arcprize.org](https://arcprize.org/results/anthropic-claude-opus-5)) | 404 — NO DATA | ARC-AGI-1 97.5 / -2 90.4 (max), 88.3 (high) / **-3 30.16% (SOTA)** | 404 — NO DATA |
| **Epoch ECI** | **NO DATA** | ~159 *(secondhand, unverified — site is JS-rendered)* | **161** ([Epoch AI](https://x.com/EpochAIResearch/status/2066674892809101767)) |
| **Aider Polyglot** ([aider.chat](https://aider.chat/docs/leaderboards/)) | **NO DATA** | **NO DATA** | **NO DATA** — leaderboard is stale (newest entries are gpt-5/o3-pro/gemini-2.5-pro era) |
| **Frontier-Bench public board** ([frontierbench.ai](https://www.frontierbench.ai/)) | — | table renders empty | — |

ARC Prize detail for Opus 5 (only model of the three with ARC data): ARC-AGI-3 evaluated at High effort only due to a short testing window; it beat five Public Demo environments no prior model had solved; 25 ARC-AGI-3 environments span 100.0% down to 0.0%.

## 5. Hallucination, refusal, alignment, compliance

| Metric | Sonnet 5 | Opus 5 | Fable 5 / Mythos 5 | Source |
|---|---|---|---|---|
| AA-Omniscience **net score** (V) | **0.20** (worst) | 0.49 | **0.53** (Mythos) | SC §6.5.1 / §6.3.3.1 |
| Incorrect-rate (V) | 26.5% | +6% vs Opus 4.8 | 20.9% (Mythos) | SC §6.5.1 |
| Correct-rate (V) | 46.9% (lowest in set) | +11% vs Opus 4.8 | highest of any prior model | SC §6.5.1 |
| Abstention rate (V) | **26.6%** (highest) | near Mythos | 5.7% (Mythos) | SC §6.5.1 |
| Non-hallucination (I) | **63%** (best) | 50% | 45–46% | AA charts |
| MASK lying rate (V) | **3.1%** (best) | 4.4–6.1% (qual.) | 8.6% (Mythos) | SC §6.5.2 |
| **Over-refusal, benign, API** (V) | **0.59%** ±0.05 (worst) | **0.09%** ±0.02 (best) | 0.01% ±0.01 (Mythos 0.03%) | Opus5 SC §4.1.2 |
| Over-refusal, claude.ai (V) | 1.54% ±0.10 | **0.47%** ±0.08 | 0.49% ±0.07 | Opus5 SC §4.1.2 |
| Misaligned-behavior audit (V) | < Sonnet 4.6, > Opus 4.8 & Mythos Preview | **2.3 — best ever** | ≈ Opus 4.8 | announcements |
| Safeguard fallback rate | n/a | 85% less often than Fable | <5% of sessions claimed (V); **~8% of Index tasks, 9% of HLE/AA-Omniscience (I)** | AA |
| Cyber posture (V) | 0.0% working Firefox exploit; cyber safeguards on by default | close to Mythos 5 at *finding* vulns, far behind at *exploiting*; OSS-Fuzz gap | Mythos 5 strongest cyber model in the world; Fable blocks broadly | announcements + SCs |

Reference points for AA-Omniscience net score across the family (V): Mythos 5 0.53 > Mythos Preview 0.50 > **Opus 5 0.49** > Opus 4.8 0.37 > Opus 4.7 0.35 > Opus 4.6 0.21 > **Sonnet 5 0.20** > Sonnet 4.6 0.14.
MASK lying-rate ladder (V): **Sonnet 5 3.1%** < Mythos Preview 4.4% < Opus 4.8 6.1% < Mythos 5 8.6% < Opus 4.6/4.7 9.8% < Sonnet 4.6 13.3%. Opus 5 sits between Sonnet 5/Mythos Preview and Opus 4.8 — exact value is figure-only.

⚠️ Anthropic's own Sonnet 5 card: *"the Sonnet 5 training run was flagged as unhealthy in its second half, so these results may partly reflect a training-health issue rather than a calibration-specific regression."*
⚠️ Fable 5 & Opus 5 scores marked with fallback are **partly Opus 4.8's scores**. Anthropic's Fable 5 table stars (*) the rows where this gap is largest: HLE, Terminal-Bench 2.1, BioMysteryBench, ExploitBench, HealthBench Professional — on those, **Fable 5 performs closer to Opus 4.8 than the headline suggests.**
⚠️ **Compliance:** Fable 5 and Mythos 5 are Covered Models with **mandatory 30-day data retention on first- and third-party surfaces and no zero-data-retention option**. Sonnet 5 supports ZDR for organizations with ZDR agreements. Opus 5 has no data-retention requirement for general access.
⚠️ Fable 5 refusals return as **HTTP 200 with `stop_reason: "refusal"`**, not an error; rerouted requests are not billed at Fable prices. Automatic fallbacks are an opt-in beta on the API for Opus 5 and Fable 5.

## 6. Explicit NO DATA / UNKNOWN

- **Aider Polyglot** — no Claude-5-gen model, any of the three. Leaderboard abandoned (newest entries are the gpt-5 / o3-pro / gemini-2.5-pro era).
- **AIME** — retired as saturated; the Sonnet 5 card says so explicitly and substitutes USAMO 2026. No AIME numbers for any of the three.
- **MMLU-Pro** — no vendor data for any of the three; Anthropic reports GMMLU (Global MMLU, multilingual) instead; not a component of AA index v4.1. A third-party aggregator's "Fable 5 = 91.5% MMLU-Pro" is **unverified — do not use**.
- **Tau-bench (original)** — superseded. Only AA's τ²-Bench Telecom (Fable 5 99%) and τ³-Banking (Opus 5 33% / Sonnet 5 28% / Fable ~27%) exist.
- **ARC-AGI for Sonnet 5 and Fable 5** — none. Both arcprize.org result pages 404; the Opus 5 vendor table shows "—" for Fable on ARC-AGI-1/2/3.
- **Epoch ECI for Sonnet 5** — none. Opus 5's ECI (~159) is **secondhand only** and conflicts with a 162.1 figure circulating from a system-card write-up; Epoch's own tables are JS-rendered and could not be read.
- **Opus 5 Terminal-Bench 2.1 vendor number** — Anthropic did not report it in the Opus 5 system card (AA independently measured 89%; Opus 5 is absent from the official tbench leaderboard).
- **Frontier-Bench independent verification** — the public leaderboard at frontierbench.ai renders empty; **43.3% is vendor-only and unverifiable**. Anthropic's own two disclosures differ slightly (hero chart 43.3/33.7/21.1 vs system-card table 43.3/33.8/21.1, the latter "from Harbor's evaluations").
- **Sonnet 5 exact %** on Vals GPQA Diamond / LiveCodeBench / SWE-bench Verified — ranks published, numbers not.
- **IFBench for Sonnet 5 / Opus 5** — listed on AA model pages but absent from the published v4.1 breakdown charts.
- **Opus 5 exact MASK lying rate** — figure-only, no numeral in text.
- **Opus 5 IMO 2026 / RiemannBench / ArxivMath numerals** — sections exist in the system card (§8.6–8.8) but were not extracted in this pass; treat as UNKNOWN pending follow-up rather than absent.

## 7. Capability-tier verdicts

**`claude-sonnet-5` — mid-tier coding & high-volume mechanical execution. Do NOT route hard reasoning here.**

- *For:* cheapest per solved problem on the only contamination-resistant coding benchmark ($1.43 vs $3.47/$4.40 on SWE-rebench); best hallucination discipline of the three (63% non-hallucination, 3.1% MASK lying, 26.6% abstention); long-context code reconstruction 76→86% on ProgramBench; AA-LCR 71% is nominally the best of the three.
- *Against:* SWE-bench Verified 85.2% vs Opus 5's 96.0%; SWE-rebench 56.8% vs 63.4%; AA Index 53 vs 61; HLE 40% vs 53%; CritPt 17% vs 29%; AA-Omniscience accuracy 38% vs 54%; GPQA 91 vs 94; SWE-bench Multimodal 28.1 vs 59.4; worst over-refusal of the three (0.59% API / 1.54% claude.ai); "unhealthy training run" flag in its own system card; **Vals cost/test $9.01 > Opus 5's $8.54**; AA measured it at **~15% more per task than Opus 4.8** on index v4.0; ~30% token inflation from the new tokenizer; **+50% price on 2026-09-01**.
- *Verdict:* worth its cost on mechanical edits, well-specified refactors, test writing, and low/medium-effort subagents. Its cheapness is real **only at low/medium effort** — at max effort the discount vanishes entirely.

**`claude-opus-5` — hard reasoning, architecture, long-horizon agentic work. Best frontier price-performance today.**

- *For:* #1 AA Intelligence Index (61); #1 Vals SWE-bench Verified (97.0%); #1 GDPval-AA v2 (1861); #1 AA-Briefcase (1720, +146 over Fable at 20% lower cost — and **high effort alone beats Fable at $10.41 vs $22.30/task**); vendor SWE-bench Verified 96.0%, Pro 79.2%, Multilingual 89.5%, Multimodal 59.4%; ARC-AGI-3 30.2% ARC-verified SOTA (~4× GPT-5.6 Sol's 7.8%, 20× Opus 4.8's 1.5%); ARC-AGI-2 90.4%; OSWorld 2.0 70.6%; AutomationBench 26.0% (~1.5× next best); BrowseComp 90.8%; ProgramBench 93% at ep5 across 1M-token episodes; joint #1 AA Coding Index; lowest over-refusal of any model tested (0.09% API / 0.47% claude.ai); most-aligned model Anthropic has shipped (audit score 2.3); newest knowledge cutoff (May 2026).
- *Against:* hallucination rate rose **+14 points to 50%** (AA) — it answers more often when uncertain; factual breadth below Fable (AA-Omniscience 54% vs 61%); **AA-LCR only 70% (mid-pack — long-context *reasoning* is not its strength despite the 1M window)**; DeepSWE v1.1 68.8 < GPT-5.6 Sol 72.7; Presentation Elo 1628 trails GPT-5.6 Sol; slow and expensive per unit wall time — 36.2 min and 103 turns per AA-Briefcase task at max, ~50% longer than Opus 4.8; absent from the official Terminal-Bench leaderboard; 18/20 on Vals CyberBench (deliberately weak by design).
- *Verdict:* the default for architecture, design review, hard multi-file debugging, computer use, and multi-hour autonomous runs. **Route at `high`/`xhigh`, not `max`** — AA shows high/xhigh already beat Fable 5 at under half its cost, and `max` buys ~2 Index points for ~70% more spend.

**`claude-fable-5` — frontier factual breadth & longest-horizon autonomy only. Largely dominated by Opus 5 on cost.**

- *For:* #1 LMArena (1508±6, 16k votes); #1 Vals Index (75.14%); #1 Vals LiveCodeBench (89.78%); #1 Vals Vibe Code Bench; #1 SWE-rebench (64.5%); #1 Epoch ECI (161, first Anthropic ECI lead in over a year); #1 AA-Omniscience accuracy (61%); #1 official Terminal-Bench 2.1 (83.8%); τ²-Bench Telecom 99%; SWE-bench Pro 80 / Verified 95%; GraphWalks BFS 256K 91.1 and Parents 256K 99.96 (Mythos); Blueprint-Bench 2 38.6 (~2.7× Opus 4.8); FrontierCode Diamond 29.3 (~2.2× Opus 4.8); OSWorld-Verified 85.0; strongest reported multi-day autonomy and vision (rebuilt web apps from screenshots; beat Pokémon FireRed vision-only).
- *Against:* **2× Opus 5's price** yet Opus 5 beats it on GDPval-AA v2 (1861 v 1747), AA-Briefcase (1720 v 1574), Frontier-Bench (43.3 v 33.8), OSWorld 2.0 (70.6 v 66.1), AutomationBench (26.0 v 17.4), SWE-bench Multilingual (89.5 v 86.6), SWE-bench Multimodal (59.4 v 54.1), Vals SWE-bench Verified (97.0 v 95.0), Vals Terminal-Bench (84.6 v 80.5), and the AA Index (61 v 60) — all at half the input price; worst hallucination of the three (~54%); weak instruction following (IFBench 63% vs 83% leader); AA-LCR 70% mid-pack; safeguard fallback contaminates 8–9% of eval tasks, so an unknown slice of its "wins" are Opus 4.8's; highest cost everywhere ($22.30/AA-Briefcase task, $11.00/Vals test, $4.40/SWE-rebench problem, $552.67 for a single Terminal-Bench run); **no ZDR + mandatory 30-day retention = hard compliance blocker**; was pulled from service by the Commerce Department days after launch.
- *Verdict:* justify per-task, never as a default. Its only defensible edges over Opus 5 are closed-book factual breadth, competitive-programming-style codegen (LiveCodeBench #1), human-preference polish (LMArena #1), and a **1.1-point SWE-rebench lead that sits inside overlapping error bars (±1.41 / ±1.35)** — i.e. statistically indistinguishable from Opus 5 at 27% higher cost per problem.

## 8. Suggested routing table

| Task class | Route to | Effort | Evidence |
|---|---|---|---|
| Trivial/mechanical edits, formatting | Sonnet 5 (or Haiku 4.5) | low | SWE-rebench $1.43/problem |
| Well-specified refactor, test writing, subagents | Sonnet 5 | medium→high | 85.2% SWE-bench Verified; 74.6% TB 2.1 |
| Mid-tier feature work, multi-file but scoped | Sonnet 5 xhigh → escalate on failure | xhigh | 56.8% SWE-rebench vs Opus 63.4% |
| Hard debugging, architecture, design review | **Opus 5** | high→xhigh | 96.0%/97.0% SWE-bench Verified; AA Index 61 |
| Long-horizon autonomous agentic runs, computer use | **Opus 5** | xhigh | ProgramBench 93%; OSWorld 2.0 70.6%; AA-Briefcase 1720 |
| Novel/unprecedented reasoning | **Opus 5** | max | ARC-AGI-3 30.2% (~4× next best) |
| Closed-book factual breadth; multi-day autonomy | Fable 5 (only after Opus 5 measurably fails) | high | AA-Omniscience 61%; ECI 161 |
| Human-facing prose/polish where preference matters | Fable 5 or Opus 5 | high | LMArena 1508 vs 1495 |
| Anything under ZDR obligation | **NOT Fable 5** | — | Fable/Mythos excluded from ZDR |
| Offensive-security / exploit work | none of the three | — | Sonnet 5 0.0% exploit; Opus 5 blocked on exploitation; Fable blocks broadly |

**Cross-cutting caveats for the routing table:**
1. Never mix **OSWorld-Verified with OSWorld 2.0**, or **GDPval-AA v1 with v2**, or **AA Index v4.0 with v4.1** — different scales, different absolute levels.
2. Terminal-Bench 2.1 spans **74.5%–89% for the same model** depending on harness (Claude Code vs Terminus 2 vs mini-SWE-agent vs AA). Pin the harness before trusting any delta.
3. Re-cost every Sonnet 5 route after **2026-08-31**; the +50% step change flips several Sonnet-vs-Opus decisions.
4. Fable 5 and Opus 5 scores may be **partly Opus 4.8's** via server-side fallback; Vals publishes a fallbacks-as-failures variant (Opus 5 Terminal-Bench 84.64% → 81.27%) and that is the number to use for automation planning.
5. Sticker price is a poor proxy for cost here: on two independent cost-per-unit-of-work measures (Vals Index, AA index v4.0) **Sonnet 5 was more expensive than an Opus-class model**.
6. Effort changes invalidate prompt caching — pick one effort level per cached conversation, vary effort across workloads instead.

## 9. Source index

**Vendor / primary**
- https://www.anthropic.com/news/claude-sonnet-5
- https://www.anthropic.com/news/claude-opus-5
- https://www.anthropic.com/news/claude-fable-5-mythos-5
- https://www.anthropic.com/claude-sonnet-5-system-card
- https://www.anthropic.com/claude-opus-5-system-card
- https://www.anthropic.com/claude-fable-5-mythos-5-system-card
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/build-with-claude/effort
- https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5
- https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions

**Independent**
- https://artificialanalysis.ai/articles/opus-5
- https://artificialanalysis.ai/articles/claude-opus-5-leader-agentic-knowledge-work
- https://artificialanalysis.ai/articles/claude-sonnet-5-agentic-cost
- https://artificialanalysis.ai/articles/claude-fable-5-mythos-intelligence-index
- https://artificialanalysis.ai/models/claude-sonnet-5
- https://swe-rebench.com/
- https://www.vals.ai/benchmarks/swebench
- https://www.vals.ai/benchmarks/lcb
- https://www.vals.ai/benchmarks/gpqa
- https://www.vals.ai/benchmarks/terminal-bench-2-1
- https://www.vals.ai/models/anthropic_claude-opus-5
- https://www.vals.ai/models/anthropic_claude-sonnet-5
- https://www.vals.ai/models/anthropic_claude-fable-5
- https://www.tbench.ai/leaderboard/terminal-bench/2.1
- https://arena.ai/leaderboard/text/
- https://arcprize.org/results/anthropic-claude-opus-5
- https://epoch.ai/benchmarks/eci
- https://x.com/EpochAIResearch/status/2066674892809101767
- https://aider.chat/docs/leaderboards/ (negative result)
- https://www.frontierbench.ai/ (negative result)

## 10. Research provenance & warnings

- Vendor benchmark tables were read by downloading Anthropic's chart PNGs and OCR-reading them directly; system-card numbers were extracted from the PDFs (`pdftotext -layout`). The Opus 5 "system card" URL serves a PDF directly despite the HTML-looking path.
- `url_context` is unavailable on `claude-opus-5` (requires a Gemini-compatible model). The working substitute for chart/table images is `curl` + image read.
- **The web_search provider was wrong twice** in ways that would have corrupted this table: it claimed SWE-rebench had **no** results for these models (it has all three, verified by direct fetch), and it reported Frontier-Bench figures of 18.7%/33.7% where the system card gives 21.1%/33.8%. Treat search summaries as leads only; every number above was re-verified against a primary source.
- Working artifacts from this pass live in `/tmp/bench/`: `opus5_sc.pdf/.txt`, `sonnet5_sc.pdf/.txt`, `fable5_sc.pdf/.txt`, `aa_opus5_breakdown.png`, `aa_sonnet5_breakdown.png`, `aa_breakdown.png`, `sonnet5_table.png`, `fable5_table.png`, `opus5_hero.png`, `opus5_evals.png`.
