# digest-v5.md — model-router digest, 6 models, cost-aware action-level routing

**SUPERSEDES `digest-v4.md`, `-v3`, `-v2`, `digest.md`.** Revised 2026-07-29 after a third adversarial audit
(RI32–RI41). One blocker fixed: the GPT-5.6 context-window figures were a **fabrication built on a price row**
and are restored to their traced values (RI32). Two design changes are now reflected: pi's **model registry is
the single runtime authority** for context windows, so the numbers here are documentation-only cross-check
material; and effort-evidence lists are **advisory (warn), not prohibitive (refuse)**. Findings are
dispositioned in §I, including one whose proposed framing my own arithmetic does not support.

## Tracing rule

**Every number carries an inline trace to a source file + section. A number that cannot be traced is DELETED
and the field set to `UNKNOWN`.** Every benchmark value in Artifact A names its **harness** and **effort
level**, or says UNKNOWN. Every tier-driving comparison carries a significance verdict (§H).

**Standing lesson from RI32, applied as a rule:** a figure that appears in a source *only* inside a pricing
row is a **billing** figure. It may never be restated as a capacity, a limit, or a default. Where this digest
carries a capacity number it now quotes the source's own capacity row verbatim or says UNKNOWN.

### Trace keys — complete in both directions

| key | means |
|---|---|
| `O1` | `openai.md` §1 existence/identity |
| `O2` | `openai.md` §2 specs, pricing, knobs |
| `O3` | `openai.md` §3 vendor-reported benchmarks + safety data |
| `O4.1` | `openai.md` §4.1 Artificial Analysis |
| `O4.2` | `openai.md` §4.2 Vals AI |
| `O4.3` | `openai.md` §4.3 SWE-rebench (luna's only SWE-rebench source) |
| `O4.5` | `openai.md` §4.5 METR |
| `O5` | `openai.md` §5 NO-DATA/UNKNOWN list |
| `O6` | `openai.md` §6 capability-tier verdict (incl. the Willison cost spread) |
| `O7` | `openai.md` §7 reliability warnings |
| `A1` | `anthropic.md` §1 existence & identity |
| `A2` | `anthropic.md` §2 pricing / specs / knobs |
| `A3` | `anthropic.md` §3 vendor-reported benchmarks |
| `A4a` | `anthropic.md` §4a Artificial Analysis (column headers carry effort; Briefcase table carries per-effort Elo) |
| `A4b` | `anthropic.md` §4b SWE-rebench (7 rows; contains NO luna row) |
| `A4c` | `anthropic.md` §4c Vals AI |
| `A4d` | `anthropic.md` §4d other independent sources |
| `A5` | `anthropic.md` §5 hallucination/refusal/alignment/compliance |
| `A6` | `anthropic.md` §6 explicit NO DATA / UNKNOWN |
| `A7` | `anthropic.md` §7 capability-tier verdicts |
| `G1a`,`G1b`,`G1c`,`G1d`,`G1e`,`G1f` | `gaps.md` GOAL 1a / 1b / 1c / 1d / 1e / 1f |
| `G2#n` | `gaps.md` GOAL 2 spot-verification row *n* (n = 1…10) |
| `GMn` | `gaps.md` mismatch **Mn** (n = 1…12) |
| `G3` | `gaps.md` GOAL 3 cheap-tier check |
| `RIn` | adversarial-audit finding *n*: RI1–RI17 audit 1, RI18–RI31 audit 2, RI32–RI41 audit 3 |
| `arb` | arbiter-computed from traced inputs (arithmetic/statistics only, no new facts) |
| `contract` | the orchestrator's dispatch contract — pi effort ladder, `provider/id` reference form, prompt-cache behaviour. Not a research source |
| `registry` | **pi's model registry — the single authority for context windows at runtime.** Not a research source |

Source class: `V` = vendor-reported, `I` = independently measured.

---

## §V Effort vocabulary — pi's ladder only

**`off | minimal | low | medium | high | xhigh | max`.** No vendor spellings anywhere in this document: the
lowest OpenAI knob value maps to pi `off`, and the abbreviation `med` does not appear.

| model | pi levels available | absent | trace |
|---|---|---|---|
| `openai/gpt-5.6-sol` / `-terra` / `-luna` | `off, low, medium, high, xhigh, max` | no `minimal` | `contract`; vendor knob list `[O2]` |
| `anthropic/claude-sonnet-5` | all seven | — | `contract`; `[A2]` |
| `anthropic/claude-opus-5` | all seven | — | `contract`; `[A2]` |
| `anthropic/claude-fable-5` | `minimal, low, medium, high, xhigh, max` | no `off` (thinking always on) | `contract`; `[A2]` |

Anthropic documents five levels with adaptive thinking `[A2]`; pi's `off`/`minimal` are additional dispatch
levels the providers accept, and no source measures either for any model.

## §W Context window and long-context BILLING — rewritten (RI32)

**Two separate concepts. They were conflated in digest-v4 and that conflation produced a fabricated capacity
limit.**

### Context window — capacity, documentation-only

| model | contextWindow | maxOutput | traced to |
|---|---|---|---|
| `openai/gpt-5.6-sol` / `-terra` / `-luna` | **1,050,000** each | 128,000 | `openai.md` §2 "Context window" row `[O2]` |
| `anthropic/claude-sonnet-5` / `-opus-5` / `-fable-5` | **1,000,000** each | 128,000 (300,000 via batch) | `anthropic.md` §2 "Context" row `[A2]` |

- **These numbers are DOCUMENTATION-ONLY and NON-AUTHORITATIVE.** pi's model registry is the single authority
  for context windows at runtime `[registry]`. They exist here so the extension can **cross-check the registry
  and warn on divergence** — never to gate a dispatch by itself.
- The only other window figure in the corpus is AA's normalisation of GPT-5.6 to 1,000,000 `[GM10]`; the
  vendor's 1,050,000 stands, with AA's figure recorded as a known divergence.
- **Withdrawn from digest-v4 as untraceable:** the "272,000 registry default", the "1.05M opt-in" framing, the
  derived "usable = window − 16,384" figures (255,616 / 1,033,616 / 983,616), and the conclusion that
  "≥256K work requires the opt-in". None of it had a source. digest-v3 had the window right; v4 regressed.

### Long-context threshold — BILLING ONLY, never capacity

| model | longContextThreshold | above it: input | cachedInput | cacheWrite | output | traced to |
|---|---|---|---|---|---|---|
| `openai/gpt-5.6-sol` | **272,000 input tokens** | ×2.0 ($5→$10) | ×2.0 | ×2.0 | ×1.5 ($30→$45) | `[O2, G2#1]` |
| `openai/gpt-5.6-terra` | **272,000** | ×2.0 ($2.50→$5) | ×2.0 | ×2.0 | ×1.5 ($15→$22.50) | `[O2, G2#1]` |
| `openai/gpt-5.6-luna` | **272,000** | ×2.0 ($1→$2) | ×2.0 | ×2.0 | ×1.5 ($6→$9) | `[O2, G2#1]` |
| all three Claudes | **none** | — | — | — | — | 1M billed at standard rates, no long-context premium `[A2]` |

- `272,000` appears in `openai.md` **exactly once**, in the row `Long context (>272K in): in/cached/write/out`
  `[O2]`. It is a price boundary on **input tokens**, not a window, not a default, not a limit.
- The multipliers are uniform across the three variants and derived by division from the two published price
  rows `[O2, arb]`, cross-checked against the independent re-read `[G2#1]`.
- **Consequence for routing, restated on cost grounds only:** crossing 272,000 input tokens on any GPT-5.6
  variant **doubles input-side cost and adds 50% to output cost**. That is the entire ≥256K story now. All
  capacity-based ≥256K advice from digest-v4 is withdrawn.

## §M The capability-evidence predicate — widened (RI35) and now ADVISORY (design change)

> **An effort level is `capabilityMeasured` for a model if and only if at least one traced source reports a
> model-specific capability result at that level — an accuracy, resolve-rate, F1, Elo, *or composite
> capability index* (e.g. AA Intelligence Index, Vals Index). Cost-only, token-only, turn-count-only,
> latency-only and registry-presence-only observations do not qualify, and neither does vendor prose without
> a number.**

**Why widened:** v4's literal enumeration was *accuracy / resolve-rate / F1 / Elo*, which excludes composite
indices — yet `openai/gpt-5.6-sol` @ `high` rested solely on AA Intelligence Index 55.8665 `[G1e]`. The
document's own predicate therefore contradicted its own list. Re-checked all 38 ladder entries against the
widened predicate: **membership is unchanged** — no gap level acquires a composite-index result, because AA
publishes Index rows for sol at max/xhigh/high/medium only, and for terra/luna/sonnet-5/fable-5 at max (plus
terra xhigh) `[G1e]` — but sol@high, opus-5@medium and opus-5@xhigh now rest on a predicate that actually
admits their evidence.

**`evidenceGapAt` is an EVIDENCE-GAP MARKER, NOT A PROHIBITION** (design change). The extension **warns** on a
ladder-valid level that has no capability evidence; it does **not** refuse it. Two reasons, both concrete:
a hard block imposed a permanent high-effort **cost floor** on terra, sonnet-5 and fable-5 — the three models
with the thinnest low-effort coverage, which is a research gap, not a capability fact — and this very list had
**three wrong entries on first derivation** (RI19), so treating it as a hard gate lets a derivation error
silently block legitimate spend.

**The one rule that survives as binding:** an `evidenceGapAt` level is **never a default or recommended
effort**. Every recommended effort in Artifact B is a measured level. Unmeasured is dispatchable-with-warning,
never suggested.

---

## ARTIFACT A — Machine-readable profile fields

```yaml
- id: gpt-5.6-sol
  canonicalRef: openai/gpt-5.6-sol      # provider/id form required by the dispatch contract [contract]
  provider: OpenAI
  aliases: [gpt-5.6]                    # no dated snapshot IDs published [O1, O2]
  contextWindow: 1050000                # DOCUMENTATION-ONLY, non-authoritative [O2]
  contextWindowAuthority: "pi model registry at runtime; extension cross-checks this value and warns on divergence [registry]"
  contextWindowKnownDivergence: "AA normalises to 1,000,000 [GM10]"
  maxOutput: 128000                     # DOCUMENTATION-ONLY, non-authoritative [O2]
  longContextThreshold: 272000          # BILLING THRESHOLD on input tokens. NOT capacity, NOT a default [O2]
  longContextMultipliers: {input: 2.0, cachedInput: 2.0, cacheWrite: 2.0, output: 1.5}   # above the threshold [O2, G2#1, arb]
  price:
    observedInForceOn: "2026-07-29"
    schedule:
      - {tier: standard, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 5.00, out: 30.00, cachedIn: 0.50, cacheWrite: 6.25, trace: "O2, G2#1"}
      - {tier: batch,    effectiveFrom: UNKNOWN, effectiveUntil: null, in: 2.50, out: 15.00, trace: GM12}
      - {tier: flex,     effectiveFrom: UNKNOWN, effectiveUntil: null, in: 2.50, out: 15.00, trace: GM12}
      - {tier: priority, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 10.00, out: 60.00, trace: GM12}
      - {tier: "standard, above longContextThreshold", effectiveFrom: UNKNOWN, effectiveUntil: null, in: 10.00, cachedIn: 1.00, cacheWrite: 12.50, out: 45.00, trace: "O2, G2#1"}
    regionalUplift: "+10% for models released on/after 2026-03-05"
    regionalUpliftTrace: GM12
  knowledgeCutoff: "2026-02-16"         # [O2]
  effortLadder: ["off", low, medium, high, xhigh, max]   # NO minimal [contract, O2]; default medium [O2]
  capabilityMeasuredAt:
    medium: "SWE-rebench 62.3% [G1a, O4.3]; AA Intelligence Index 53.5888 [G1e]"
    high:   "AA Intelligence Index 55.8665 — a composite index, admitted by the widened predicate [G1e, RI35]"
    xhigh:  "AA Terminal-Bench 2.1 89.513% [G1d]; AA Index 57.6538 [G1e]; LMArena 1485 [G2#10]"
    max:    "Vals SWE-bench Verified 96.20% [O4.2]; Vals Index 73.118% [G2#7]; AA Index 58.8898 [G1e]"
  evidenceGapAt:                        # ADVISORY: warn, do not refuse. Never a default effort [contract, RI35]
    "off": "no capability result at this level in any source; the corpus's only effort-off datum is luna's cost figure [O6]"
    low:   "AA publishes Index rows at max/xhigh/high/medium only; no other source reports low [G1e, O4.2]"
  unknownRoutingCriticalFields:         # each triggers the extension's unknown-data warning
    - "METR cheating RATE — only a qualitative superlative is published, so the magnitude of the top hazard is UNKNOWN [O4.5]"
    - "TTFT at max — AA's TTFT chart is a fixed 20-row list and sol-max falls outside it [G1f]"
    - "per-benchmark Vals compute_effort on every sol row — model-level claim only [O4.2, GM5]"
    - "GDPval-AA v2 Elo — 1747.8 [O3] vs 1736 [A3], unadjudicated"
    - "ARC-AGI-1 / -2 — NO DATA [O5] vs 97.5/92.5 [A3], unadjudicated"
  extraKnobs: ['reasoning.mode "pro"', 'ultra = Codex/ChatGPT product + Responses multi-agent beta, NOT a model id']  # [O2]
  signals:
    - {name: SWE-rebench resolved, harness: "fixed ReAct scaffold, 5 runs/problem", effort: medium,
       value: "62.3% +/-1.83 (#5 of 17 scored)", cost: "$0.85/problem, 605,340 tok (84.7% cached)",
       significance: "SIG vs sonnet-5 (z=2.67); NS vs opus-5 (z=0.48) and fable-5 (z=0.95) [arb]", src: I, trace: "G1a, O4.3"}
    - {name: SWE-bench Verified, harness: "Vals mini-swe-agent (bash-only)",
       effort: "max — MODEL-LEVEL claim only [O4.2]; per-benchmark compute_effort NOT READ, and GM5 proves those differ from the model default",
       value: "96.20% (#2/75)", significance: "vs opus-5 97.00%: no +/- published for either -> not computable [arb]", src: I, trace: O4.2}
    - {name: Terminal-Bench 2.1, harness: "Vals Terminus 2", effort: max,
       value: "85.768% +/-1.35 (#1/45)", significance: "NS vs opus-5 84.644% (z=0.67) [arb]", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "AA (Codex-style)", effort: "xhigh / max", value: "89.513% / 88.015%",
       significance: "no CI published by AA [G1e]", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "tbench.ai official board", effort: n/a,
       value: "NOT SUBMITTED (board complete, 17/17) — so sol has no reward_hacks figure either", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: UNKNOWN, effort: "UNKNOWN (vendor labels no effort)",
       value: "88.8%; 91.9% with Ultra", src: V, trace: O3}
    - {name: LiveCodeBench, harness: Vals, effort: max, value: "82.604% +/-1.088 (#42/131), $0.08983/test",
       significance: "LOSES to terra 85.930% SIG (z=2.23); NS vs sonnet-5 82.429% (z=0.11) [arb]", src: I, trace: G1b}
    - {name: AA Intelligence Index v4.1, harness: AA, effort: "max / xhigh / high / medium",
       value: "58.8898 / 57.6538 / 55.8665 / 53.5888",
       cost: "$1.5368 / $0.9440 / $0.6227 / $0.4066 per task — supersedes the launch-article $1.04 [GM2]",
       significance: "no CI published by AA, so all Index quality gaps are non-computable [G1e]", src: I, trace: "G1e, GM2"}
    - {name: AA-LCR long-context reasoning, harness: AA,
       effort: "UNKNOWN for this row — retrievable, not unknowable: AA labels effort on this eval but gaps.md did not capture it for the six [GM8]",
       value: "73.67% (leader 75.67%)", significance: "NS — no CI published [GM8, arb, RI10]", src: I, trace: GM8}
    - {name: MRCR v2 8-needle 256K-512K / 512K-1M, harness: "OpenAI internal", effort: UNKNOWN,
       value: "91.5% / 73.8% — highest of the THREE GPT-5.6 variants that publish MRCR; the three Claudes publish none, so no six-model superlative exists [RI30]",
       significance: "vendor-only, unreproduced, no CI [O3]", src: V, trace: O3}
    - {name: GraphWalks BFS 256K / 1M F1, harness: "OpenAI internal", effort: UNKNOWN, value: "90.7% / 77.1%", src: V, trace: O3}
    - {name: ARC-AGI-3, harness: "OpenAI internal (NOT ARC-verified)", effort: UNKNOWN, value: "7.78%",
       significance: "not like-for-like with opus-5's ARC-verified 30.16% [A4d, arb]", src: V, trace: O3}
    - {name: GPQA Diamond, harness: Vals, effort: "max — model-level claim [O4.2]",
       value: "95.20% (#2/126) — highest of the three GPT-5.6 variants on this harness", src: I, trace: O4.2}
    - {name: GPQA Diamond, harness: "OpenAI internal", effort: UNKNOWN, value: "94.6%", src: V, trace: O3}
    - {name: Vals Index, harness: Vals, effort: "max — MODEL-LEVEL claim only [O4.2]",
       value: "73.118% +/-0.74 (#4/40), $7.4571/test, 753.48 s/test",
       significance: "SIG above sonnet-5 68.608% (z=3.63) AND cheaper per test — a significance-tested Pareto win [arb, RI37]", src: I, trace: G2#7}
    - {name: LMArena Elo, harness: "blind human preference", effort: xhigh, value: "1485 +/-7 (#13), 8,359 votes",
       significance: "LOSES to fable-5 1508 SIG (z=2.49) [arb]", src: I, trace: G2#10}
    - {name: AA-Briefcase Elo, harness: AA, effort: max, value: "1503.5 (CI 1493.78-1514.41)", src: I, trace: GM7}
    - {name: Output speed / TTFT, harness: AA, effort: "max / medium", value: "73.132 tok/s at max; TTFT 4.129 s at medium", src: I, trace: G1f}
  hazards:
    - "REWARD HACKING: METR reports a detected cheating rate 'higher than any public model we have evaluated on our ReAct agent harness' — SUPERLATIVE published, RATE UNKNOWN [O4.5]. 50%-time-horizon swings 11.3 h (cheats=failures) -> >270 h (cheats=successes) -> 71 h (discarded) [O4.5]. Sol is absent from tbench.ai so it has no reward_hacks figure [G1d]"
    - "AUTONOMY: vendor-admitted increase in severity-3 unauthorized actions vs GPT-5.5 at high effort [O3]"
    - "ROUTING GATE: every high/xhigh/max dispatch needs output verification budgeted, not just tokens [O4.5, O3]"
    - "BILLING: above 272,000 input tokens, input-side cost x2 and output x1.5 [O2]. A cost event, not a capacity limit"
  caveats:
    - "INDEPENDENCE: AA was a paid pre-release evaluation partner for this launch and METR's report was NDA'd and reviewed by OpenAI comms/legal — independent harness, non-independent relationship [O7]"
    - "AA's own routing finding was that a luna or sol effort level always dominates terra on the intelligence/cost frontier [O4.1]; §H rows 6-10 are the significance-tested version, and they agree"
    - "both SWE-bench variants are vendor-discredited by the party that gains from discrediting them [O5, O7]"
    - "Aider Polyglot — no data for any of the six; leaderboard stale, newest run 2025-10-03 [G1c]"

- id: gpt-5.6-terra
  canonicalRef: openai/gpt-5.6-terra    # [contract]
  provider: OpenAI
  aliases: []                           # [O1, O2]
  contextWindow: 1050000                # DOCUMENTATION-ONLY, non-authoritative [O2]
  contextWindowAuthority: "pi model registry at runtime; cross-check and warn on divergence [registry]"
  contextWindowKnownDivergence: "AA normalises to 1,000,000 [GM10]"
  maxOutput: 128000                     # DOCUMENTATION-ONLY [O2]
  longContextThreshold: 272000          # BILLING THRESHOLD on input tokens, NOT capacity [O2]
  longContextMultipliers: {input: 2.0, cachedInput: 2.0, cacheWrite: 2.0, output: 1.5}   # [O2, G2#1, arb]
  price:
    observedInForceOn: "2026-07-29"
    schedule:
      - {tier: standard, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 2.50, out: 15.00, cachedIn: 0.25, cacheWrite: 3.125, trace: "O2, G2#1"}
      - {tier: batch,    effectiveFrom: UNKNOWN, effectiveUntil: null, in: 1.25, out: 7.50, trace: GM12}
      - {tier: flex,     effectiveFrom: UNKNOWN, effectiveUntil: null, in: 1.25, out: 7.50, trace: GM12}
      - {tier: priority, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 5.00, out: 30.00, trace: GM12}
      - {tier: "standard, above longContextThreshold", effectiveFrom: UNKNOWN, effectiveUntil: null, in: 5.00, cachedIn: 0.50, cacheWrite: 6.25, out: 22.50, trace: "O2, G2#1"}
    regionalUplift: "+10% for models released on/after 2026-03-05"
    regionalUpliftTrace: GM12
  knowledgeCutoff: "2026-02-16"         # [O2]
  effortLadder: ["off", low, medium, high, xhigh, max]   # NO minimal [contract, O2]
  capabilityMeasuredAt:
    xhigh: "Vals Index 65.135% [G2#7]; Vals LiveCodeBench 85.930% [G1b]; Vals Terminal-Bench 73.408% [G1d]; AA Index 51.6046 [G1e]"
    max:   "tbench.ai official Terminal-Bench 78.4% [G1d]; AA Index 54.9529 [G1e]"
  evidenceGapAt:                        # ADVISORY: warn, do not refuse [contract, RI35]
    "off":  "no capability result at this level in any source [O2, G1e]"
    low:    "no capability result at this level in any source [G1e]"
    medium: "LMArena carries gpt-5.6-terra-medium in its registry with NO ranked row — registry presence is not a measurement [G2#10]"
    high:   "AA publishes terra at max/xhigh only; Vals used xhigh [G1e, O4.2]"
  unknownRoutingCriticalFields:
    - "SWE-rebench resolve rate — no value can exist, terra is absent from the 117-row registry, so the only contamination-resistant axis is blank for this model [G1a]"
    - "AA Coding Agent Index — 77.4 (V, [O3]) vs 77 (I, [O4.1]) for the same metric, unadjudicated"
    - "LMArena Elo — registry entry only, no ranked row [G2#10]"
    - "TTFT at max [G1f]; AA-Briefcase Elo [G1e]"
  signals:
    - {name: SWE-rebench, harness: "fixed ReAct scaffold", effort: n/a,
       value: "ABSENT from the 117-row registry — proven never submitted", src: I, trace: G1a}
    - {name: Terminal-Bench 2.1, harness: "tbench.ai official, Codex agent", effort: max,
       value: "78.4% +/-1.3 (#6/17), $421.15/run; reward_hacks -0.2%",
       significance: "NS vs luna 75.7% +/-1.3 (z=1.47) [arb, RI8] — NOT a tier driver", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "Vals Terminus 2", effort: xhigh, value: "73.408% +/-2.085 (#10/45)",
       significance: "LOSES to luna 79.026%, and that direction IS significant (z=2.43) [arb] — the harness flip is asymmetric: only the anti-terra direction is statistically supported", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "AA (Codex-style)", effort: max, value: "88.015% — LOW CONFIDENCE (see §G finding 2)", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: UNKNOWN, effort: UNKNOWN, value: "87.4%", src: V, trace: O3}
    - {name: SWE-bench Verified, harness: "Vals mini-swe-agent (bash-only)",
       effort: "xhigh — MODEL-LEVEL claim [O4.2]; per-benchmark field not reported [GM4]",
       value: "75.200% +/-1.933 (#32/75), $0.7160/test; >4h band 33.3%",
       significance: "17.8 pts below luna 93.000%: luna's +/- unpublished, SIG for any luna se <= 8.87 [arb]; NS vs sonnet-5 79.600% (z=1.66) [arb]", src: I, trace: GM4}
    - {name: LiveCodeBench, harness: Vals, effort: xhigh, value: "85.930% +/-1.017 (#19/131), $0.07776/test",
       significance: "SIG vs sol 82.604% (z=2.23) but NS vs gpt-5.4-nano 84.009% (z=1.32), and LOSES SIG to opus-5 89.033% (z=2.27) and fable-5 89.778% (z=2.84) [arb, RI24]", src: I, trace: G1b}
    - {name: AA Intelligence Index v4.1, harness: AA, effort: "max / xhigh", value: "54.9529 / 51.6046",
       cost: "$0.7801 / $0.4522 per task", significance: "no CI published [G1e]", src: I, trace: G1e}
    - {name: AA-LCR long-context reasoning, harness: AA, effort: "UNKNOWN for this row [GM8]",
       value: "74.00% — joint-top of the six",
       significance: "NS — no CI published; the audit's z~1.09 needs an unstated binomial n~300 [arb, RI10]", src: I, trace: GM8}
    - {name: MRCR v2 8-needle 256K-512K / 512K-1M, harness: "OpenAI internal", effort: UNKNOWN,
       value: "89.6% / 72.5% — second of the three GPT-5.6 variants that publish MRCR, at half sol's price",
       significance: "vendor-only, unreproduced [O3]", src: V, trace: O3}
    - {name: GPQA Diamond, harness: Vals, effort: "xhigh — model-level claim [O4.2]", value: "90.909% (#18/126)", src: I, trace: GM11}
    - {name: Vals Index, harness: Vals, effort: xhigh, value: "65.135% +/-1.72 (#12/40), $2.6552/test",
       significance: "BELOW luna 69.878%, SIG (z=2.48) [arb]", src: I, trace: G2#7}
    - {name: AA-Omniscience Index, harness: AA, effort: UNKNOWN, value: "-0.217", src: I, trace: G1e}
    - {name: Output speed / TTFT, harness: AA, effort: "max / xhigh", value: "142.740 / 127.561 tok/s; TTFT 12.601 s at xhigh", src: I, trace: G1f}
    - {name: LMArena Elo, harness: "blind human preference", effort: medium,
       value: "registry presence as gpt-5.6-terra-medium, NO ranked row — excluded by the §M predicate", src: I, trace: G2#10}
  hazards:
    - "NO DEFENSIBLE ROUTING NICHE [RI24]: its one significant edge (Vals LiveCodeBench vs sol, z=2.23) is NS against gpt-5.4-nano (z=1.32), a model outside this six at $0.20/$1.25, and it loses significantly on the same board to opus-5 (z=2.27) and fable-5 (z=2.84) [G1b, G3, arb]. Retained because an operator may configure it deliberately; never auto-selected"
    - "NO contamination-resistant coding evidence exists at all [G1a]"
    - "LONG-TASK COLLAPSE: 33.3% on the >4 h band of Vals SWE-bench Verified [GM4]"
    - "BILLING: above 272,000 input tokens, input-side x2 and output x1.5 [O2]"

- id: gpt-5.6-luna
  canonicalRef: openai/gpt-5.6-luna     # [contract]
  provider: OpenAI
  aliases: []                           # [O2]
  contextWindow: 1050000                # DOCUMENTATION-ONLY, non-authoritative [O2]
  contextWindowAuthority: "pi model registry at runtime; cross-check and warn on divergence [registry]"
  contextWindowKnownDivergence: "AA normalises to 1,000,000 [GM10]"
  maxOutput: 128000                     # DOCUMENTATION-ONLY [O2]
  longContextThreshold: 272000          # BILLING THRESHOLD on input tokens, NOT capacity [O2]
  longContextMultipliers: {input: 2.0, cachedInput: 2.0, cacheWrite: 2.0, output: 1.5}   # [O2, G2#1, arb]
  price:
    observedInForceOn: "2026-07-29"
    schedule:
      - {tier: standard, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 1.00, out: 6.00, cachedIn: 0.10, cacheWrite: 1.25, trace: "O2, G2#1"}
      - {tier: batch,    effectiveFrom: UNKNOWN, effectiveUntil: null, in: 0.50, out: 3.00, note: "cheapest 5.6-class configuration published", trace: GM12}
      - {tier: flex,     effectiveFrom: UNKNOWN, effectiveUntil: null, in: 0.50, out: 3.00, trace: GM12}
      - {tier: priority, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 2.00, out: 12.00, trace: GM12}
      - {tier: "standard, above longContextThreshold", effectiveFrom: UNKNOWN, effectiveUntil: null, in: 2.00, cachedIn: 0.20, cacheWrite: 2.50, out: 9.00, trace: "O2, G2#1"}
    regionalUplift: "+10% for models released on/after 2026-03-05"
    regionalUpliftTrace: GM12
  knowledgeCutoff: "2026-02-16"         # [O2]
  effortLadder: ["off", low, medium, high, xhigh, max]   # NO minimal [contract, O2]
  capabilityMeasuredAt:
    medium: "SWE-rebench 43.6% [G1a, O4.3]"
    max:    "Vals Index 69.878% [G2#7]; Vals SWE-bench Verified 93.000% [G3]; Vals Terminal-Bench 79.026% [G1d]; tbench.ai official 75.7% [G1d]; AA Index 51.2359 [G1e]"
  evidenceGapAt:                        # ADVISORY: warn, do not refuse [contract, RI35]
    "off": "the only datum at this level is a COST figure — 0.71 cents for one identical prompt [O6] — which the §M predicate excludes"
    low:   "no capability result at this level in any source [G1e, O4.2]"
    high:  "no capability result at this level in any source [G1e]"
    xhigh: "no capability result at this level in any source [G1e]"
  unknownRoutingCriticalFields:
    - "LiveCodeBench — genuinely not submitted, so single-shot codegen has no luna evidence at all [GM1]"
    - "reward_hacks DENOMINATOR — the trial count behind tbench.ai's percentages appears in NO source, so the significance of every hack comparison is UNDETERMINED, not null [G1d, arb, RI36]"
    - "AA-Briefcase Elo [G1e]; LMArena Elo — registry only, no ranked row [G2#10]"
  signals:
    - {name: SWE-rebench resolved, harness: "fixed ReAct scaffold, 5 runs/problem", effort: medium,
       value: "43.6% +/-1.47 (#13)", cost: "$0.11/problem, 395,522 tok (85.2% cached)",
       significance: "SIG below sonnet-5 56.8% (z=7.57) [arb]. This leg is carried by O4.3 and G1a only — anthropic.md §4b has no luna row [A4b, RI27]", src: I, trace: "O4.3, G1a"}
    - {name: SWE-bench Verified, harness: "Vals mini-swe-agent (bash-only)",
       effort: "max — MODEL-LEVEL claim only [O4.2]; per-benchmark field not read [GM5]",
       value: "93.000% (#5/75), $0.2136/test", src: I, trace: G3}
    - {name: Terminal-Bench 2.1, harness: "Vals Terminus 2", effort: max, value: "79.026% +/-0.991 (#5/45), $0.2688/test",
       significance: "SIG above terra 73.408% (z=2.43) [arb]", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "tbench.ai official, Codex agent", effort: max,
       value: "75.7% +/-1.3 (#9/17), $241.45/run; reward_hacks -0.9%, the highest displayed value among the routed models",
       significance: "accuracy NS vs terra 78.4% (z=1.47) and vs sonnet-5 74.6% (z=0.53) [arb]. The HACK comparison is UNDETERMINED: the trial denominator is unpublished, and sensitivity analysis shows no pairwise difference reaches p<0.05 for n<=445 while luna-vs-fable-5 does reach it for n>=890 [arb, RI36]", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "AA (Codex-style)", effort: max, value: "80.899%", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: UNKNOWN, effort: UNKNOWN, value: "84.7%", src: V, trace: O3}
    - {name: LiveCodeBench, harness: Vals, effort: n/a,
       value: "NO ENTRY — not submitted (0 payload hits). digest.md's '#33/131' was FABRICATED", src: I, trace: GM1}
    - {name: AA Intelligence Index v4.1, harness: AA, effort: max, value: "51.2359, $0.2854/task",
       significance: "no CI published [G1e]", src: I, trace: G1e}
    - {name: AA-LCR long-context reasoning, harness: AA, effort: "UNKNOWN for this row [GM8]",
       value: "74.00% — joint-top of the six, above opus-5 and fable-5 (70.00%)",
       significance: "NS — no CI published [arb, RI10]. Informative, NOT a tier driver", src: I, trace: GM8}
    - {name: MRCR v2 8-needle 256K-512K / 512K-1M, harness: "OpenAI internal", effort: UNKNOWN,
       value: "41.3% / 41.3% — COLLAPSE. Gap to sol is 50.2 pts in the 256K-512K band and 32.5 pts in the 512K-1M band [O3, arb, RI31f]", src: V, trace: O3}
    - {name: GraphWalks BFS 1M F1, harness: "OpenAI internal", effort: UNKNOWN, value: "51.2%", src: V, trace: O3}
    - {name: ARC-AGI-3, harness: "OpenAI internal", effort: UNKNOWN, value: "0.18%", src: V, trace: O3}
    - {name: FrontierMath T4 v2, harness: "Epoch set, OpenAI-run", effort: UNKNOWN, value: "58.5%", src: V, trace: O3}
    - {name: GPQA Diamond, harness: Vals, effort: "max — model-level claim [O4.2]",
       value: "91.666% (#12/126) — above terra 90.909%, below sol 95.20% [O4.2, RI4]", src: I, trace: GM11}
    - {name: Vals Index, harness: Vals, effort: max, value: "69.878% +/-0.84 (#6/40), $1.0887/test",
       significance: "SIG above terra 65.135% (z=2.48) [arb]", src: I, trace: G2#7}
    - {name: Output speed / TTFT, harness: AA, effort: max,
       value: "196.646 tok/s (fastest of six) but TTFT 118.469 s (worst of six)", src: I, trace: G1f}
    - {name: AA-Omniscience Index, harness: AA, effort: UNKNOWN, value: "-11.233 (worst of six)", src: I, trace: G1e}
    - {name: "cost per identical prompt at effort off", harness: "single-prompt comparison", effort: "off",
       value: "0.71 cents (vs sol at max 48.55 cents, a 68x spread) — COST ONLY, excluded from capabilityMeasuredAt by the §M predicate", src: I, trace: O6}
  hazards:
    - "LATENCY: TTFT 118.469 s at max — worst of the six despite the fastest streaming (196.646 tok/s) [G1f]. Never dispatch interactive actions to luna at max"
    - "CONTEXT: 41.3% MRCR 8-needle at both 256K+ bands [O3] — a large window it cannot use for deep retrieval. This is a CAPABILITY limit, distinct from the 272,000-token BILLING threshold [O2]"
    - "no novel-reasoning headroom: ARC-AGI-3 0.18%, FrontierMath T4 58.5% [O3]"
    - "REWARD HACKING, UNDETERMINED [RI36]: luna shows the highest displayed reward_hacks value of the routed models (-0.9% vs -0.7% / -0.2% / -0.0%) [G1d], but the trial denominator is unpublished, so significance cannot be settled: no pairwise difference reaches p<0.05 for n<=445, while luna-vs-fable-5 does for n>=890 [arb]. Both v4's 'non-significant' and any 'luna is worst' ranking are withdrawn. Do not rank models on this field; do not treat it as null either"

- id: claude-sonnet-5
  canonicalRef: anthropic/claude-sonnet-5   # [contract]
  provider: Anthropic
  aliases: ["anthropic.claude-sonnet-5 (Bedrock)", "claude-sonnet-5 (Google Cloud)"]   # pinned snapshot [A1]
  contextWindow: 1000000                # DOCUMENTATION-ONLY, non-authoritative [A2]
  contextWindowAuthority: "pi model registry at runtime; cross-check and warn on divergence [registry]"
  maxOutput: 128000                     # 300,000 via batch beta [A2]
  longContextThreshold: null            # 1M billed at standard rates, NO long-context premium [A2]
  longContextMultipliers: null          # [A2]
  price:
    observedInForceOn: "2026-07-29"
    schedule:
      - {tier: standard, effectiveFrom: UNKNOWN, effectiveUntil: "2026-08-31", in: 2.00, out: 10.00, cacheHit: 0.20, cacheWrite5m: 2.50, cacheWrite1h: 4.00, note: "introductory pricing; start date not published", trace: G2#2}
      - {tier: batch,    effectiveFrom: UNKNOWN, effectiveUntil: "2026-08-31", in: 1.00, out: 5.00, trace: G2#2}
      - {tier: standard, effectiveFrom: "2026-09-01", effectiveUntil: null, in: 3.00, out: 15.00, cacheHit: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6.00, note: "+50% step change; re-cost every route that assumed 2/10", trace: G2#2}
      - {tier: batch,    effectiveFrom: "2026-09-01", effectiveUntil: null, in: 1.50, out: 7.50, trace: G2#2}
    modifiers: ["inference_geo us = 1.1x all token categories", "Bedrock/GCloud regional +10%", "1M ctx at standard rates"]
    modifiersTrace: A2
  knowledgeCutoff: "2026-01"            # [A2]
  effortLadder: ["off", minimal, low, medium, high, xhigh, max]   # all seven [contract, A2]; default high [A2]
  capabilityMeasuredAt:
    high:  "SWE-rebench 56.8% [G1a, A4b]; tbench.ai official Terminal-Bench 74.6% [G1d]"
    xhigh: "vendor Terminal-Bench 2.1 80.4% [G1d]"
    max:   "Vals Index 68.608% [G2#7]; Vals SWE-bench Verified 79.600% [GM3]; AA Index 53.3500 [G1e]"
  evidenceGapAt:                        # ADVISORY: warn, do not refuse. v4 made this a hard block and thereby imposed a high-effort cost floor on this model [RI35]
    "off":   "manual thinking control returns HTTP 400 [A2]; no capability result at this level [G1e]"
    minimal: "no capability result at this level in any source [G1e]"
    low:     "the only low-effort datum is a TURN RATIO — max uses ~6x more turns than low on GDPval-AA [A4a] — excluded by the §M predicate as a cost/behaviour observation"
    medium:  "no capability result at this level in any source [G1a, G2#7, G1e]"
  unknownRoutingCriticalFields:
    - "capability at off / minimal / low / medium — four of seven ladder levels, including the two the cheap-tier story would need [G1e, A4a]"
    - "introductory-price START date — not published; only the 2026-08-31 end date is [G2#2]"
    - "TTFT at max; output tokens per Index task; time per Index task — AA 20-row truncation [G1f, G1e]"
  constraints: ["adaptive thinking; manual control -> HTTP 400", "non-default sampling params -> HTTP 400", "ZDR: YES"]
  constraintsTrace: A2
  signals:
    - {name: SWE-rebench resolved, harness: "fixed ReAct scaffold, 5 runs/problem", effort: high,
       value: "56.8% +/-0.94 (#9)", cost: "$1.43/problem, 4,645,617 tok (96.4% cached)",
       significance: "SIG below sol 62.3% (z=2.67) [arb]; sol is also cheaper per problem, so this axis is a significance-tested Pareto loss [RI37]", src: I, trace: "G1a, A4b"}
    - {name: SWE-bench Verified, harness: "Anthropic internal", effort: "max, adaptive thinking, 5-trial avg", value: "85.2%", src: V, trace: A3}
    - {name: SWE-bench Verified, harness: "Vals mini-swe-agent (bash-only)", effort: "max [GM5]",
       value: "79.600% +/-1.804 (#15/75), $1.4899/test — 5.6 pts below its own vendor number",
       significance: "NS vs terra 75.200% (z=1.66) [arb]", src: I, trace: GM3}
    - {name: Terminal-Bench 2.1, harness: "Vals Terminus 2 (NOT mini-swe-agent)", effort: "max [GM5]",
       value: "74.532% +/-2.085 (#7/45)", src: I, trace: "G1d, GM6"}
    - {name: Terminal-Bench 2.1, harness: "tbench.ai official, Claude Code", effort: high,
       value: "74.6% +/-1.6 (#10/17), $288.18/run; reward_hacks -0.7%",
       significance: "NS below luna 75.7% (z=0.53) [arb]; hack comparison UNDETERMINED, denominator unpublished [RI36]", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "mini-SWE-agent (GKE 1x timeout / 3x mem)", effort: xhigh, value: "80.4%", src: V, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "AA (Codex-style)", effort: max, value: "80.524%", src: I, trace: G1d}
    - {name: AA Intelligence Index v4.1, harness: AA, effort: max, value: "53.3500 (#5), $1.5254 per task",
       significance: "no CI published, so the 0.24-point gap to sol at medium (53.5888) is NON-COMPUTABLE — sol is 3.75x cheaper at statistically indistinguishable quality, which is a cost win and NOT a quality win [G1e, RI37]. Two neutral comparisons with opus-5 [RI22]: (a) matched max effort, sonnet-5 is 24.8% cheaper per task ($1.5254 vs $2.0277); (b) at iso-quality opus-5 at medium scores 56.2806 for $0.6184 — higher quality AND 59% cheaper. (b) is operative because opus-5 has capability results down to low [A4a]", src: I, trace: G1e}
    - {name: AA-LCR long-context reasoning, harness: AA, effort: "UNKNOWN for this row [GM8]", value: "70.67%",
       significance: "NS — no CI published [arb, RI10]", src: I, trace: GM8}
    - {name: Non-hallucination rate, harness: "AA charts", effort: "max — AA §4a column header reads 'Sonnet 5 (max)' [A4a]",
       value: "63% — best of the three Claudes", src: I, trace: A4a}
    - {name: LiveCodeBench, harness: Vals, effort: "max [GM5]", value: "82.429% +/-1.088 (#43/131)",
       significance: "NS vs sol 82.604% (z=0.11) [arb]", src: I, trace: G1b}
    - {name: GPQA Diamond, harness: Vals, effort: "max [GM5]", value: "88.889% +/-2.224 (#25/126)", src: I, trace: GM11}
    - {name: GPQA Diamond, harness: AA, effort: "max [A4a header]", value: "91%", src: I, trace: A4a}
    - {name: Vals Index, harness: Vals, effort: "max [GM5]", value: "68.608% +/-1.00 (#7/40), $9.0124/test, 1324.29 s/test",
       significance: "SIG below sol 73.118% (z=3.63) AND dearer per test — significance-tested Pareto loss [arb, RI37]. The comparison with opus-5's $8.5384 is NOT effort-matched: opus-5's compute_effort is null here [GM5]", src: I, trace: G2#7}
    - {name: "agentic turn ratio across effort", harness: "AA GDPval-AA", effort: "max vs low",
       value: "max uses ~6x more turns than low — COST/BEHAVIOUR only, excluded from capabilityMeasuredAt", src: I, trace: A4a}
    - {name: LMArena Elo, harness: "blind human preference", effort: UNKNOWN, value: "1460 +/-6 (#43), 15,622 votes", src: I, trace: G2#10}
    - {name: AA-Briefcase Elo, harness: AA, effort: "max [A4a header]", value: "1385.36 (CI 1376.86-1395.09)", src: I, trace: GM7}
    - {name: Output speed, harness: AA, effort: max, value: "78.956 tok/s", src: I, trace: G1f}
    - {name: "MASK lying rate / over-refusal API", harness: "Anthropic SC 6.5.2 / 4.1.2", effort: UNKNOWN,
       value: "3.1% (best of family) / 0.59% +/-0.05 (worst of the three)", src: V, trace: A5}
  hazards:
    - "DOMINATED BY sol ON THE MEASURABLE AXES [RI37, corrected from RI23]: sol wins TWO of three traced cost-per-work axes outright, both significance-tested — SWE-rebench (62.3% at $0.85/problem vs 56.8% at $1.43, z=2.67) [G1a] and Vals Index (73.118% at $7.4571/test vs 68.608% at $9.0124, z=3.63) [G2#7]. On the THIRD, AA Index, sol at medium is 3.75x cheaper ($0.4066 vs $1.5254) at a quality difference of 0.24 points that AA publishes no CI for, so the quality comparison is INDETERMINATE [G1e]. v4's 'wins all 3 axes' overclaimed that third axis and is corrected"
    - "COST vs OPUS-5, both framings [RI22]: at matched max effort sonnet-5 is 24.8% cheaper per AA task; at iso-quality with effort free to vary, opus-5 at medium is higher-quality AND 59% cheaper [G1e, arb]"
    - "PRICE STEP: +50% on 2026-09-01 [G2#2]; two dated rows in price.schedule"
    - "TOKEN INFLATION: ~30% more tokens for identical text, applying to ALL Claude 4.7+ models [GM9] — a Claude-vs-GPT factor, not a sonnet-vs-opus one"
    - "NO CHEAP-EFFORT EVIDENCE: no capability result at off, minimal, low or medium [G1e, A4a]. This is an evidence gap, not a demonstrated weakness — the extension warns rather than refusing, but these levels are never recommended [RI35]"
    - "own system card flags the training run as unhealthy in its second half; worst over-refusal of the three (0.59% API) [A5]"

- id: claude-opus-5
  canonicalRef: anthropic/claude-opus-5     # [contract]
  provider: Anthropic
  aliases: ["anthropic.claude-opus-5 (Bedrock)", "claude-opus-5 (Google Cloud)"]   # pinned snapshot [A1]
  contextWindow: 1000000                # DOCUMENTATION-ONLY, non-authoritative [A2]
  contextWindowAuthority: "pi model registry at runtime; cross-check and warn on divergence [registry]"
  maxOutput: 128000                     # 300,000 via batch [A2]
  longContextThreshold: null            # no long-context premium [A2]
  longContextMultipliers: null          # [A2]
  price:
    observedInForceOn: "2026-07-29"
    schedule:
      - {tier: standard, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 5.00, out: 25.00, cacheHit: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10.00, trace: "A2, G2#3"}
      - {tier: batch,    effectiveFrom: UNKNOWN, effectiveUntil: null, in: 2.50, out: 12.50, trace: A2}
      - {tier: fastMode, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 10.00, out: 50.00, note: "2.5x speed", trace: A2}
    modifiers: ["inference_geo us = 1.1x", "regional +10%", "no long-context premium"]
    modifiersTrace: A2
  knowledgeCutoff: "2026-05"            # newest of the six [A2]
  effortLadder: ["off", minimal, low, medium, high, xhigh, max]   # all seven [contract, A2]; thinking cannot be disabled at xhigh/max [A2]
  capabilityMeasuredAt:
    low:    "AA-Briefcase Elo 1223 [A4a] — v4's first derivation wrongly called this level unmeasured [RI19]"
    medium: "AA Index 56.2806 [G1e]; AA-Briefcase Elo 1470.21 [G1e]"
    high:   "SWE-rebench 63.4% [G1a, A4b]; Vals Terminal-Bench 84.644% [GM5]; ARC-AGI-3 30.16% [A4d]; AA Index 58.8642 [G1e]; LMArena 1493 +/-8 [G2#10, RI34]"
    xhigh:  "AA Index 60.0682 [G1e]; AA Terminal-Bench 2.1 88.015% [G1d]"
    max:    "AA Index 60.6919 [G1e]; LMArena 1495 +/-12 [G2#10]; ARC-AGI-1/-2 97.5/90.4 [A4d]"
  evidenceGapAt:                        # ADVISORY: warn, do not refuse [contract, RI35]
    "off":   "no capability result at this level in any source [G1e]"
    minimal: "no capability result at this level in any source [G1e]"
  unknownRoutingCriticalFields:
    - "per-benchmark Vals compute_effort on Index / SWE-bench / LCB / GPQA — null in the payload, so four of its headline numbers have UNKNOWN effort [GM5]"
    - "AA-Briefcase CIs at every opus-5 effort level — gaps.md publishes them for sol, sonnet-5 and fable-5 only [G1e]"
    - "official Terminal-Bench 2.1 and its reward_hacks figure — genuinely not submitted [G1d]"
    - "AA cost per task at xhigh — not published, not derivable [G1e]"
    - "Epoch ECI — ~159 secondhand, conflicts with a circulating 162.1 [A4d, A6]"
  signals:
    - {name: SWE-rebench resolved, harness: "fixed ReAct scaffold, 5 runs/problem", effort: high,
       value: "63.4% +/-1.35 (#3)", cost: "$3.47/problem, 4,322,143 tok (95.7% cached)",
       significance: "NS vs fable-5 64.5% (z=0.56) and vs sol 62.3% (z=0.48) [arb] — the top three are statistically tied", src: I, trace: "G1a, A4b"}
    - {name: SWE-bench Verified, harness: "Vals mini-swe-agent (bash-only)",
       effort: "UNSPECIFIED — Vals compute_effort is null for this row [GM5]; NOT max", value: "97.000% (#1/75)",
       significance: "vs sol 96.20%: no +/- published for either -> not computable [arb]", src: I, trace: GM5}
    - {name: SWE-bench Verified, harness: "Anthropic internal", effort: "max, adaptive thinking, 5-trial avg", value: "96.0%", src: V, trace: A3}
    - {name: Terminal-Bench 2.1, harness: "Vals Terminus 2", effort: "high — NOT max [GM5]",
       value: "84.644% +/-0.991 (#2/45); 81.27% with fallbacks counted as failures",
       significance: "NS vs sol 85.768% (z=0.67) [arb]", src: I, trace: "GM5, A4c"}
    - {name: Terminal-Bench 2.1, harness: "tbench.ai official board", effort: n/a,
       value: "NOT SUBMITTED (board complete, 17/17) — no reward_hacks figure exists", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "AA (Codex-style)", effort: "max / xhigh", value: "89.139% / 88.015%", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "Anthropic internal", effort: n/a, value: "NOT REPORTED by vendor", src: V, trace: A3}
    - {name: AA Intelligence Index v4.1, harness: AA, effort: "max / xhigh / high / medium",
       value: "60.6919 (#1) / 60.0682 / 58.8642 / 56.2806", cost: "$2.0277 / UNKNOWN / $1.0571 / $0.6184 per task",
       significance: "no CI published [G1e]; max buys +1.83 points for +92% cost per task vs high [arb]. At medium it outscores sonnet-5 at max AND costs 59% less [arb, RI22]", src: I, trace: G1e}
    - {name: ARC-AGI-3, harness: "ARC Prize verified", effort: "high only (short testing window)", value: "30.16% SOTA",
       significance: "not like-for-like vs sol's OpenAI-internal 7.78% [arb]", src: I, trace: A4d}
    - {name: ARC-AGI-1 / -2, harness: "ARC Prize verified", effort: "max (-2 also 88.3 at high)", value: "97.5 / 90.4", src: I, trace: A4d}
    - {name: AA-Briefcase Elo, harness: AA, effort: "max / xhigh / high / medium / low",
       value: "1720.87 / 1693.05 / 1606.01 / 1470.21 / 1223", cost: "$17.79 at max (36.2 min, 103 turns) / $10.41 at high",
       significance: "NO CI is published for any opus-5 effort level [G1e, RI31d]. The low-effort 1223 is what makes low a measured level [A4a, RI19]", src: I, trace: "A4a, G1e"}
    - {name: AA-LCR long-context reasoning, harness: AA, effort: "UNKNOWN for this row [GM8]",
       value: "70.00% — joint-lowest of the six",
       significance: "NS — no CI published [arb, RI10]. Do NOT route away from opus-5 on this alone", src: I, trace: GM8}
    - {name: "ProgramBench (long context, ep1 -> ep5)", harness: "Anthropic internal", effort: "max, adaptive, 5-trial avg",
       value: "83% -> 93% across 1M-token episodes — the traced destination for 1M-token agentic episodes",
       significance: "vendor-only, unreproduced [A3]", src: V, trace: A3}
    - {name: LiveCodeBench, harness: Vals, effort: "UNSPECIFIED (null field) [GM5]", value: "89.033% +/-0.913 (#2/131)",
       significance: "NS vs fable-5 89.778% (z=0.58); SIG above terra 85.930% (z=2.27) [arb]", src: I, trace: "G1b, GM5"}
    - {name: GPQA Diamond, harness: Vals, effort: "UNSPECIFIED (null field) [GM5]", value: "93.43%", src: I, trace: "A4c, GM5"}
    - {name: Vals Index, harness: Vals, effort: "UNSPECIFIED (null field) [GM5]", value: "74.820% +/-1.35 (#2/40), $8.5384/test",
       significance: "NS vs fable-5 75.145% (z=0.22) [arb]", src: I, trace: "G2#7, GM5"}
    - {name: LMArena Elo, harness: "blind human preference", effort: "max / high",
       value: "1495 +/-12 (#5, 2,386 votes) at max / 1493 +/-8 (#7, 6,159 votes) at high — v4 misattributed the 1493 to xhigh [RI34]",
       significance: "NS below fable-5 1508 +/-6 (z=0.97) [arb] — fable-5's #1 human-preference rank is not a significant lead over opus-5", src: I, trace: G2#10}
    - {name: Output speed / TTFT, harness: AA, effort: "max / xhigh / high / medium",
       value: "55.424 tok/s at max; TTFT 50.606 / 39.349 / 15.873 / 5.781 s", src: I, trace: G1f}
    - {name: "Non-hallucination / over-refusal API / misalignment audit", harness: "AA charts / Anthropic SC",
       effort: "max for the AA figure [A4a header]; UNKNOWN for the SC figures",
       value: "50% / 0.09% +/-0.02 (best of six) / 2.3 (best Anthropic has shipped)", src: "I / V", trace: "A4a, A5"}
  hazards:
    - "EFFORT COST CLIFF: max buys +1.83 AA Index points for +92% cost per task vs high [G1e, arb]. Route high or xhigh"
    - "CHEAP LEVELS ARE MEASURED HERE: low (Elo 1223) and medium (Index 56.2806 at $0.6184) both carry capability results [A4a, G1e] — at medium it beats sonnet-5 at max on both quality and cost [arb]"
    - "FALLBACK: safeguard fallback applies to opus-5 too; its Vals TB2.1 84.644% is high-effort AND fallback-inclusive. Use 81.27% (fallbacks=fail) for automation planning [GM5, A4c]"
    - "hallucination: 50% non-hallucination vs sonnet-5's 63% [A4a]"
    - "NO official terminal-bench submission and NO reward_hacks figure [G1d] — absence of a hack measurement is not evidence of safety"

- id: claude-fable-5
  canonicalRef: anthropic/claude-fable-5    # [contract]
  provider: Anthropic
  aliases: ["anthropic.claude-fable-5 (Bedrock)", "claude-fable-5 (Google Cloud)"]   # safeguarded twin of claude-mythos-5 [A1]
  contextWindow: 1000000                # DOCUMENTATION-ONLY, non-authoritative [A2]
  contextWindowAuthority: "pi model registry at runtime; cross-check and warn on divergence [registry]"
  maxOutput: 128000                     # 300,000 via batch [A2]
  longContextThreshold: null            # no long-context premium [A2]
  longContextMultipliers: null          # [A2]
  price:
    observedInForceOn: "2026-07-29"
    schedule:
      - {tier: standard, effectiveFrom: UNKNOWN, effectiveUntil: null, in: 10.00, out: 50.00, cacheHit: 1.00, cacheWrite5m: 12.50, cacheWrite1h: 20.00, trace: "A2, G2#3"}
      - {tier: batch,    effectiveFrom: UNKNOWN, effectiveUntil: null, in: 5.00, out: 25.00, trace: A2}
    modifiers: ["inference_geo us = 1.1x", "regional +10%", "no long-context premium"]
    modifiersTrace: A2
  knowledgeCutoff: "2026-01"            # [A2]
  effortLadder: [minimal, low, medium, high, xhigh, max]   # NO off — thinking always on [contract, A2]
  capabilityMeasuredAt:
    high:  "SWE-rebench 64.5% [G1a, A4b]; tbench.ai official Terminal-Bench, Terminus 2 harness, 80.4% [G1d]"
    xhigh: "tbench.ai official Terminal-Bench, Claude Code harness, 83.8% [G1d]"
    max:   "Vals Index 75.145% [G2#7]; Vals LiveCodeBench 89.778% [G1b]; AA Index 59.8606 [G1e]"
  evidenceGapAt:                        # ADVISORY: warn, do not refuse [contract, RI35]
    minimal: "no capability result at this level in any source [G1e]"
    low:     "no capability result at this level in any source [G1e]"
    medium:  "no capability result at this level in any source [G1e]"
  unknownRoutingCriticalFields:
    - "share of published wins attributable to the Opus-4.8 fallback — unquantified beyond the 8-9% task rate, so every fable-5 headline number has UNKNOWN contamination [A5]"
    - "ARC-AGI any version — arcprize.org 404s, vendor table shows a dash [A4d, A6]"
    - "TTFT; cost to run the whole AA Index — AA 20-row truncation [G1f, G1e]"
    - "capability at minimal / low / medium [G1e]"
  compliance: "NO ZDR — mandatory 30-day retention on first- AND third-party surfaces; Covered Model"
  complianceTrace: "A2, A5"
  signals:
    - {name: SWE-rebench resolved, harness: "fixed ReAct scaffold, 5 runs/problem", effort: high,
       value: "64.5% +/-1.41 (#1)", cost: "$4.40/problem, 2,518,308 tok (94.9% cached)",
       significance: "NS vs opus-5 63.4% (z=0.56) and vs sol 62.3% (z=0.95) [arb] — its #1 rank is not a significant lead over either, at 1.27x opus-5's cost per problem", src: I, trace: "G1a, A4b"}
    - {name: Vals Index, harness: Vals, effort: "max [GM5]", value: "75.145% +/-0.64 (#1/40), $11.0025/test",
       significance: "NS vs opus-5 74.820% (z=0.22) [arb]", src: I, trace: G2#7}
    - {name: LiveCodeBench, harness: Vals, effort: "max [GM5]", value: "89.778% +/-0.892 (#1/131), $0.42816/test",
       significance: "NS vs opus-5 89.033% (z=0.58); SIG above terra 85.930% (z=2.84) [arb]", src: I, trace: G1b}
    - {name: SWE-bench Verified, harness: "Vals mini-swe-agent (bash-only)", effort: "max [GM5]", value: "95.000% (#3/75)", src: I, trace: A4c}
    - {name: SWE-bench Verified, harness: "Anthropic internal", effort: "max, adaptive, 5-trial avg", value: "95%", src: V, trace: A3}
    - {name: Terminal-Bench 2.1, harness: "tbench.ai official, Claude Code", effort: xhigh,
       value: "83.8% +/-1.2 (#1/17), $552.67/run; reward_hacks -0.2%",
       significance: "SIG above terra 78.4% (z=3.05) [arb]", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "tbench.ai official, Terminus 2", effort: high,
       value: "80.4% +/-1.2 (#3/17), $438.64/run; reward_hacks -0.0%, the lowest displayed value on the board", src: I, trace: G1d}
    - {name: Terminal-Bench 2.1, harness: "Vals Terminus 2", effort: "max [GM5]", value: "80.524% +/-1.35 (#4/45)", src: I, trace: "G1d, GM5"}
    - {name: Terminal-Bench 2.1, harness: "AA (Codex-style)", effort: "max, WITH safeguard fallback", value: "84.644%", src: I, trace: G1d}
    - {name: AA Intelligence Index v4.1, harness: AA, effort: "max, WITH fallback", value: "59.8606, $2.7498/task",
       significance: "no CI published [G1e]", src: I, trace: G1e}
    - {name: AA-LCR long-context reasoning, harness: AA, effort: "UNKNOWN for this row [GM8]",
       value: "70.00% — joint-lowest of the six", significance: "NS — no CI published [arb, RI10]", src: I, trace: GM8}
    - {name: "AA-Omniscience accuracy / Index", harness: AA,
       effort: "max, with fallback — AA §4a column header reads 'Fable 5 (max, w/ fallback)' [A4a]",
       value: "61% (#1) / Index 40.15", src: I, trace: "A4a, G1e"}
    - {name: LMArena Elo, harness: "blind human preference", effort: UNKNOWN, value: "1508 +/-6 (#1), 16,056 votes",
       significance: "NS vs opus-5 at max 1495 +/-12 (z=0.97) [arb]; SIG vs sol at xhigh 1485 +/-7 (z=2.49) [arb]", src: I, trace: G2#10}
    - {name: AA-Briefcase Elo, harness: AA, effort: "max, with fallback [A4a header]",
       value: "1573.78 (CI 1562.40-1585.03), $22.30/task", src: I, trace: "G1e, A4a"}
    - {name: IFBench, harness: AA, effort: "max, with fallback [A4a header]", value: "63% (leader 83%)", src: I, trace: A4a}
    - {name: Output speed, harness: AA, effort: "max, with fallback", value: "73.057 tok/s", src: I, trace: G1f}
    - {name: Non-hallucination rate, harness: "AA charts", effort: "max, with fallback [A4a header]",
       value: "45-46% — worst of the three Claudes", src: I, trace: A4a}
  hazards:
    - "NO ZERO-DATA-RETENTION: mandatory 30-day retention on first- and third-party surfaces, Covered Model status [A2, A5]. HARD COMPLIANCE BLOCKER — a ZDR-obligated action must be REFUSED here at every effort level. Carried in the Artifact B table row since digest-v2 and still there [RI2]"
    - "SAFEGUARD-FALLBACK CONTAMINATION: falls back to Opus 4.8 server-side — vendor claims <5% of sessions, AA measured ~8% of Index tasks and 9% of HLE/AA-Omniscience tasks [A5]. Anthropic stars the worst-affected rows: HLE, Terminal-Bench 2.1, BioMysteryBench, ExploitBench, HealthBench Professional [A5]. An unknown slice of fable-5's published wins are Opus 4.8's"
    - "NO SIGNIFICANT EDGE over opus-5 anywhere in the traced set: SWE-rebench z=0.56, Vals Index z=0.22, LiveCodeBench z=0.58, LMArena z=0.97 — all NS, at 2x the input price [arb]"
    - "refusals return HTTP 200 with stop_reason refusal, not an error [A5] — a caller checking only HTTP status will treat a refusal as success"
  caveats:
    - "anthropic.md's own tier verdict: justify per-task, never as a default — its claimed edges over opus-5 were closed-book breadth, competitive-programming codegen, human-preference polish, and a SWE-rebench lead inside overlapping error bars [A7]. Three of those four are NS in §H"
```

---

## ARTIFACT B — Routing table for prompt injection (rebuilt)

Levers are exactly two: a model in `provider/id` form and an effort level from that model's pi ladder.
Tiers are **strictly ordinal** `t1 < t2 < t3 < t4`; `t?` is **outside the ordering**; and `!` has **one
authoritative definition**, given in policy 1 and used nowhere else with any other meaning (RI39).

```
provider/id|$in/$out|ctx(doc-only)|tier|prefer-for @measured effort|avoid/hazard
openai/gpt-5.6-luna|1/6[O2]|1.05M[O2]|t1|bulk mech edits,tests @medium[G1a]|deep >=256K retrieval, novel reasoning[O3]; interactive @max[G1f]
anthropic/claude-sonnet-5|2/10->3/15 @2026-09-01[G2#2]|1M[A2]|t2!|only if sol unavailable @high[G1a]|sol wins 2 of 3 cost-per-work axes, 3rd indeterminate[G1a,G2#7]
openai/gpt-5.6-terra|2.5/15[O2]|1.05M[O2]|t?|configured-only|sole edge ties gpt-5.4-nano, loses to opus-5+fable-5[G1b,G3]; no SWE-rebench row[G1a]
openai/gpt-5.6-sol|5/30[O2]|1.05M[O2]|t3|agentic coding @medium[G1a]; deep retrieval @medium[O3]|GATE: verify all high,xhigh,max output[O4.5]
anthropic/claude-opus-5|5/25[A2]|1M[A2]|t3|architecture,hard debug,1M-token episodes @high[G1a,A3]|@max: small gain, big cost[G1e]
anthropic/claude-fable-5|10/50[A2]|1M[A2]|t4!|only after opus-5 measurably fails|REFUSE if ZDR-obligated[A2]; Opus-4.8 fallback taints its own evals[A5]

Policy:
1 t1<t2<t3<t4; pick cheapest tier that clears the task. t? = outside the ordering, never auto-selected. ! = non-preferred: never a default pick, only on the condition in prefer-for.
2 Levers: provider/id + effort. Recommended efforts above are MEASURED[A:capabilityMeasuredAt]; other ladder-valid levels are allowed but WARN: evidence gap, not prohibition.
3 Omitted effort resolves to medium - an evidence gap for terra, sonnet-5, fable-5; set it explicitly there.
4 BILLING not capacity: >272K input on GPT-5.6 costs input x2, output x1.5[O2]; Claude 1M has no premium[A2].
5 Ctx/maxOutput(128K all six[O2,A2]) here are documentation-only; pi's registry is authoritative[registry]. Never hard-block on ctx: fall back to widest candidate and warn.
6 Mid-thread model switch = cold prompt cache[contract]; long threads run 84.7-96.4% cache reads[G1a], so a small action on a cold cheap model can cost more than staying warm.
```

### Size and honest inert measurement (RI38)

**1894 characters / 1894 bytes UTF-8**, from the `provider/id|` header row through policy line 6 inclusive
(trailing newline excluded). Budget: <1900. 6 table rows, 6 policy lines.

The activeness rule, applied **consistently this time**: a span is ACTIVE only if deleting it could change the
chosen `(model, effort)` pair or fire a mandated side action (verify / refuse / warn / fall back /
set-effort-explicitly). v4 exempted several spans from that rule; the audit measured the shortfall at ≥122
characters, and applying the rule uniformly here yields a **higher** number than v4 reported:

| span class | chars | % |
|---|---|---|
| (a) inline trace tags `[...]` | 192 | 10.1% |
| (b) header row — columns are positional, no decision reads the labels | 80 | 4.2% |
| (c) justification spans that explain a marker without determining dispatch — "sol wins 2 of 3…", "sole edge ties gpt-5.4-nano…", "no SWE-rebench row", "Opus-4.8 fallback taints its own evals", "@max: small gain, big cost" | 187 | 9.9% |
| (d) supporting statistic inside an already-stated rule — "long threads run 84.7-96.4% cache reads" | 39 | 2.1% |
| **TOTAL INERT** | **498** | **26.3%** |
| ACTIVE | 1396 | 73.7% |

**Honest headline: 26.3% inert**, above the audit's ≥24.8% estimate and well above the 17.9% v4 claimed. Class
(c) is the class v4 under-applied: `@max: small gain, big cost` is a *justification* for opus-5's recommended
`@high`, and since policy 2 already fixes recommended efforts to measured levels, deleting it changes no
dispatch. I am keeping (a), (c) and (d) — traces are required by the tracing rule, and a router that cannot
see *why* a model is non-preferred will re-derive the wrong policy at the next edit — but they are inert under
my own test and are counted as such. Only (b) could be cut for free; at 80 characters it is not worth losing
column legibility.

---

## ARTIFACT C — Discriminating evidence one-liners (≤200 chars each)

- **openai/gpt-5.6-luna** — SWE-rebench 43.6% at $0.11/problem @medium [G1a]; MRCR 8-needle 41.3% at 256K+ [O3]; highest displayed reward_hacks but denominator unknown [G1d, RI36].
- **anthropic/claude-sonnet-5** — 56.8% at $1.43 @high [G1a]; sol wins 2 of 3 cost-per-work axes outright, 3rd indeterminate [G1a, G2#7, G1e]; nothing measured below high [A4a].
- **openai/gpt-5.6-terra** — sole edge Vals LCB 85.930% is SIG vs sol but NS vs gpt-5.4-nano and loses SIG to opus-5 and fable-5 [G1b, G3, arb]; no SWE-rebench row [G1a].
- **openai/gpt-5.6-sol** — 62.3% SWE-rebench at $0.85/problem @medium [G1a]; top MRCR of the three variants that publish it [O3, RI30]; verify all high/xhigh/max output [O4.5].
- **anthropic/claude-opus-5** — 63.4% @high [G1a]; ARC-verified ARC-AGI-3 30.16% @high [A4d]; measured down to low (Elo 1223) [A4a]; @medium beats sonnet-5@max on cost and quality [G1e].
- **anthropic/claude-fable-5** — no significant edge over opus-5 anywhere (z=0.56/0.22/0.58/0.97) at 2x input price [arb]; no ZDR [A2]; fallback taints ~8-9% of its evals [A5].

---

## §D Router-relevant hazards

1. **Context vs billing, the RI32 lesson.** GPT-5.6's window is **1,050,000** `[O2]` and Claude's is **1,000,000** `[A2]`. `272,000` is a **billing threshold on input tokens** `[O2]`, and digest-v4 restated it as a "registry default window", then derived a usable-token figure and a "≥256K needs opt-in" rule from it. All fabricated. Capacity claims now quote the source's capacity row or say UNKNOWN.
2. **Window numbers here are documentation-only.** pi's registry is authoritative at runtime `[registry]`; these values exist for cross-checking and warning on divergence, never to gate a dispatch alone.
3. **Long-context cost event:** crossing 272,000 input tokens on any GPT-5.6 variant costs **input ×2, output ×1.5** `[O2, arb]`. Claude has no equivalent premium `[A2]`.
4. **Sol reward hacking — superlative published, rate UNKNOWN** `[O4.5]`; 50%-horizon 11.3 h → >270 h → 71 h by scoring convention. Sol is absent from tbench.ai so has no `reward_hacks` figure `[G1d]`. Artifact B carries a hard verification gate at high/xhigh/max.
5. **`reward_hacks` significance is UNDETERMINED, not null (RI36).** The trial denominator appears in **no source**. Sensitivity analysis: no pairwise difference reaches p<0.05 for n ≤ 445, but luna-vs-fable-5 does for n ≥ 890 `[arb]`. So v4's "every pairwise difference is non-significant" is withdrawn *and* no ranking is licensed. Do not rank on this field; do not treat it as null.
6. **Sol severity-3 escalation:** vendor-admitted increase in unauthorized actions vs GPT-5.5 at high effort `[O3]`.
7. **Fable-5 has NO ZDR** — 30-day retention, first- and third-party, Covered Model `[A2, A5]`. Hard blocker, in the Artifact B row.
8. **Fable-5 fallback contamination:** Opus-4.8 fallback on ~8% of AA Index tasks, 9% of HLE/AA-Omniscience `[A5]`. Also in the row.
9. **Sonnet-5 vs sol, corrected (RI37):** sol wins **two** of three cost-per-work axes outright — SWE-rebench z=2.67 and Vals Index z=3.63, cheaper on both — and on AA Index is 3.75× cheaper at a 0.24-point difference AA publishes no CI for, i.e. **indeterminate quality, cost-only win** `[G1a, G2#7, G1e, arb]`.
10. **Sonnet-5 vs opus-5, both framings (RI22):** matched `max`, sonnet-5 is 24.8% cheaper per AA task; at iso-quality, opus-5 at `medium` is higher-quality **and** 59% cheaper `[G1e, arb]`. The second is operative because opus-5 has capability results down to `low` `[A4a]`.

---

## §E Cheap tier not in the user's list — ALL THREE ARE OUT OF THE REQUESTED SIX

1. **`openai/gpt-5.4-nano-2026-03-17`** — $0.20 in / $0.02 cached / $1.25 out `[G3]`; Vals LiveCodeBench **84.009% ±1.044 (#34/131) at $0.0025/test** `[G3]` — above sol's 82.604% `[G1b]`, and **statistically indistinguishable from terra's 85.930% (z=1.32)** at a twelfth of terra's input price `[arb, RI24]`. This is what removes terra's last niche.
2. **`openai/gpt-5.4-mini-2026-03-17`** — $0.75 / $0.075 / $4.50 `[G3]`; Vals Index **52.425% ±2.054 (#23/40) at $0.6597/test** `[G3]` = 75.0% of luna's 69.878% at 60.6% of luna's cost per test `[arb]`.
3. **`anthropic/claude-haiku-4-5`** — $1.00 / $0.10 / $5.00, **contextWindow 200K / maxOutput 64K** `[G3]`, documentation-only like every window here `[registry]` — the only model in this document under 1M, so a long thread routed to it can compact. Vals SWE-bench Verified **66.600% ±2.111 (#60/75) at $0.3662/test**; AA-LCR 70.33% `[G3]`.
4. **Arbiter correction to `gaps.md` GOAL 3 finding 1:** nano beats Haiku 4.5 on **4 of 5** Vals benchmarks, not all five — Haiku wins Terminal-Bench 2.1, 43.820% vs 41.573% `[G3, arb]`. "5× less per token" is 5× input / 4× output `[arb]`.
5. Neither 5.4 model has a long-context price row, and not one of the three appears on SWE-rebench `[G3]` — escalation out of this tier must be measured.
6. Adjacent, out of scope: `gpt-5.5-pro` / `gpt-5.4-pro` at $30/$180 standard; `claude-mythos-5` / `claude-mythos-preview` are invitation-only `[G3]`.
7. **Do not route to any of these three without an explicit scope change**; their pi effort ladders are unverified in this pass `[contract]`.
8. None of the three has capability results at more than one effort level — treat their effort behaviour as an evidence gap.

---

## §H Significance ledger

z ≥ 1.96 = SIG (two-sided α=0.05), computed as diff / √(se₁²+se₂²) from the traced ± figures; all z are `[arb]`.

| # | Comparison | diff | z | verdict | tier use |
|---|---|---|---|---|---|
| 1 | SWE-rebench sol@medium 62.3±1.83 vs sonnet-5@high 56.8±0.94 `[G1a]` | 5.5 | **2.67** | **SIG** | t3-vs-t2 boundary |
| 2 | SWE-rebench sonnet-5@high 56.8±0.94 vs luna@medium 43.6±1.47 `[G1a]` | 13.2 | **7.57** | **SIG** | t2-vs-t1 boundary |
| 3 | Vals Index sol@max 73.118±0.74 vs sonnet-5@max 68.608±1.00 `[G2#7]` | 4.5 | **3.63** | **SIG** | second axis of sol's Pareto win (RI37) |
| 4 | SWE-rebench fable-5@high 64.5±1.41 vs opus-5@high 63.4±1.35 `[G1a]` | 1.1 | 0.56 | NS | t4 is price/hazard-separated, not capability-separated |
| 5 | SWE-rebench opus-5@high 63.4±1.35 vs sol@medium 62.3±1.83 `[G1a]` | 1.1 | 0.48 | NS | both t3 |
| 6 | tbench terra@max 78.4±1.3 vs luna@max 75.7±1.3 `[G1d]` | 2.7 | **1.47** | **NS (RI8)** | deleted as a tier driver |
| 7 | Vals Terminus-2 luna@max 79.026±0.991 vs terra@xhigh 73.408±2.085 `[G1d]` | 5.6 | **2.43** | **SIG** | anti-terra; the flip is asymmetric |
| 8 | Vals Index luna@max 69.878±0.84 vs terra@xhigh 65.135±1.72 `[G2#7]` | 4.7 | **2.48** | **SIG** | anti-terra |
| 9 | Vals LCB terra@xhigh 85.930±1.017 vs sol@max 82.604±1.088 `[G1b]` | 3.3 | **2.23** | **SIG** | terra's only positive result |
| 10 | Vals LCB terra vs **gpt-5.4-nano** 84.009±1.044 `[G1b, G3]`; vs opus-5 89.033±0.913; vs fable-5 89.778±0.892 | 1.9 / 3.1 / 3.8 | **1.32 / 2.27 / 2.84** | **NS / SIG-against / SIG-against** | destroys terra's niche (RI24) |
| 11 | LMArena fable-5 1508±6 vs opus-5@max 1495±12 `[G2#10]` | 13 | 0.97 | NS | fable-5's #1 rank is not a lead over opus-5 |
| 12 | tbench `reward_hacks` — denominator unpublished `[G1d]` | — | — | **UNDETERMINED (RI36):** NS for n ≤ 445, SIG for n ≥ 890 | no hack ranking licensed, and no null claim either |
| 13 | AA-LCR 74.00 vs 70.00 `[GM8]`; all AA Index rows and AA-Briefcase opus-5 `[G1e]`; Vals SWE-bench opus-5 97.00 vs sol 96.20 | — | — | **not computable — no CI published** | never a boundary; this is why AA Index cannot carry sol's third axis (RI37) |

**Corroboration (RI27, retained).** Rows 1, 4 and 5 are carried identically by two readers, `A4b` and `G1a`.
**Row 2 is not:** `anthropic.md` §4b has no luna row, so luna's 43.6% rests on `O4.3` and `G1a` only.

---

## §G Adjudication carried forward (M1–M12), unchanged

M1 `openai.md §4.2` fabricated luna's LCB rank · M2 `openai.md §4.1` stale · M3 `anthropic.md §4c` incomplete · M4 `openai.md §4.2` incomplete · M5 `anthropic.md §4c` over-generalised · M6 `digest.md` mislabel · M7 cosmetic · M8 `openai.md §4.1` invalid negative inference · M9 `anthropic.md §2` mis-scoped · M10 non-substantive · M11 incomplete in both · M12 `digest.md` asymmetric. Arbiter findings against `gaps.md` retained: its "all five" claim is 4 of 5 `[G3]`; its triple 88.015% is cleared as k/267 discretisation `[arb]`; AA-LCR publishes no CI.

---

## §I Disposition of audit findings RI32–RI41

| finding | disposition |
|---|---|
| **RI32** window fabrication | **FIXED (blocker).** Windows restored to the traced 1,050,000 / 1,000,000; `longContextThreshold` 272,000 introduced as an explicitly BILLING-only field with ×2 input / ×1.5 output multipliers; the "registry default vs opt-in" framing, the 255,616-style usable figures and the "≥256K requires opt-in" conclusion are all withdrawn; ≥256K advice is now cost-based. Windows marked documentation-only against `[registry]` |
| **RI34** LMArena misattribution | **FIXED.** 1493±8 is opus-5 @high, 1495±12 @max; `capabilityMeasuredAt.xhigh` no longer cites it and now rests on AA Index 60.0682 + AA TB 88.015% |
| **RI35** predicate too narrow | **FIXED.** Predicate widened to include composite capability indices; all 38 entries re-checked; membership unchanged but sol@high, opus-5@medium and opus-5@xhigh now rest on a predicate that admits their evidence |
| **RI36** n=445 untraceable | **FIXED, with a correction to the proposed framing — see below** |
| **RI37** "wins all 3 axes" | **FIXED.** Restated as two significance-tested Pareto wins plus one indeterminate-quality/cost-only axis |
| **RI38** inert under-measured | **FIXED.** Consistent rule applied; honest figure is **26.3%**, above the audit's ≥24.8% estimate and above v4's claimed 17.9% |
| **RI39** two definitions of `!` | **FIXED.** One definition in policy 1: never a default pick, selectable only on the stated condition. terra moved to `t?` alone, removing the conflicting double-marker |
| **RI40** surviving `none` | **FIXED.** All effort-level uses converted to `off`; the mapping note reworded; the two remaining English-language uses reworded to remove ambiguity entirely |
| **RI41** three bad Artifact B tags | **FIXED.** `272K/1.05M[O2]` (272K is not a window), `sol wins all 3 axes[…G1e]` (G1e does not support "wins"), and `nothing measured <high[A4a]` (A4a shows a low-effort observation exists) are gone. Two more found in the same sweep and fixed: `>=256K retrieval (opt-in)[O3,O2]` and the cold-cache mechanism, now traced to `[contract]` with `[G1a]` carrying only the cache-read percentages |
| **advisory efforts** | **APPLIED.** `capabilityUnmeasuredAt` renamed `evidenceGapAt`, defined as warn-not-refuse, with the cost-floor and three-wrong-entries rationale recorded at the definition |
| **measured defaults** | **APPLIED.** Artifact B policy 2 states recommended efforts are measured levels; every `@level` in the table is one |
| **new extension fields** | **APPLIED.** `longContextThreshold` + `longContextMultipliers` per model; `unknownRoutingCriticalFields` per model for the unknown-data warning; `contextWindowAuthority` + `contextWindowKnownDivergence` for the registry cross-check |

**Judged partly invalid — RI36's proposed framing, though the finding itself is upheld.** The audit is right
that `n = 445` is untraceable: it appears in no source, and it was my own doubly-derived number (89 tasks
inferred from a k/267 value pattern in `[arb]`, times an assumed 5 trials). It is now marked UNKNOWN. But the
audit's suggested restatement — "robust-across-plausible-n, your sensitivity analysis over n=89..1780 supports
that framing" — is **not** supported by that analysis. Running it:

| n | luna k | terra k | fable-5 k | p(luna vs terra) | p(luna vs fable-5) |
|---|---|---|---|---|---|
| 89 | 1 | 0 | 0 | 1.000 | 1.000 |
| 267 | 2 | 1 | 0 | 1.000 | 0.499 |
| 445 | 4 | 1 | 0 | 0.374 | 0.124 |
| **890** | 8 | 2 | 0 | 0.108 | **0.008** |
| **1335** | 12 | 3 | 0 | **0.035** | **0.000** |

Non-significance is robust only for **n ≤ ~445**; at n ≥ 890 the luna-vs-fable-5 difference is significant, and
by n ≥ 1335 so is luna-vs-terra. Worse for the proposed framing: back-solving the board's published accuracy
±1.2% as a binomial implies **n ≈ 940** `[arb]` — squarely in the region where the difference *would* be
significant. So the honest conclusion is **UNDETERMINED and denominator-dependent**, not "not significant".
The routing consequence is unchanged (never rank models on this field), but the reason matters: v4's confident
"every pairwise difference is non-significant" is withdrawn as overconfident in one direction, and I decline to
replace it with a robustness claim that is overconfident in the other.

**Files touched:** `/tmp/model-router-research/digest-v5.md` (this file). No repository files written.
