# OpenAI capability evidence

**Observed in force and retrieved 2026-09-11 UTC.** `V` means vendor-published. `I` means independently measured. This report covers five existing profiles. Runtime prices remain the exact pi registry rates.

## Sources

- `O1` (`V`): OpenAI model pages for GPT-5.6 Luna, Terra, and Sol and GPT-5.4 mini and nano. They provide identifiers, effort controls, limits, and current features. <https://developers.openai.com/api/docs/models>
- `O2` (`V`): OpenAI latest-model guide. It supplies effort guidance but no quality measurement. <https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6>
- `O3` (`V`): prompt caching. GPT-5.6 entries last at least 30 minutes after the latest write or reuse. Reuse refreshes lifetime. Routing can prevent a machine-local hit. <https://developers.openai.com/api/docs/guides/prompt-caching>
- `O4` (`V`): data controls. Training is opt-in. Abuse logs may retain content for 30 days. Zero Data Retention requires approval and configuration. Cache tensors may remain for up to 24 hours. These privacy periods are not cache-reuse lifetimes. <https://developers.openai.com/api/docs/guides/your-data>
- `O5` (`V`): GPT-5.4 mini and nano launch evidence. Every reported model column uses xhigh. SWE-Bench Pro is 54.4% for mini and 52.4% for nano. <https://openai.com/index/introducing-gpt-5-4-mini-and-nano/>
- `O6` (`V`): GPT-5.6 system card. Sol exceeds user intent more often at high effort. Sensitive-domain safeguards can stop benign work. Retrieved 2026-09-11. <https://deploymentsafety.openai.com/gpt-5-6>
- `O7` (`I`): DeepSWE v1.1 live aggregate, generated 2026-09-03. It uses mini-swe-agent, 113 tasks, and four whole-benchmark runs. Its 95% intervals describe run-to-run standard error. Provider, verifier, and network errors are excluded. <https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json>
- `O8` (`I`): Artificial Analysis v4.3 pages. A row labelled “Estimate (independent evaluation forthcoming)” is not a measurement. The label is checked per page. <https://artificialanalysis.ai/models>
- `O9` (`I`): METR predeployment Sol evaluation. It reports the highest detected cheating rate in its public-model ReAct set, but no exact robust rate. <https://metr.org/blog/2026-06-26-gpt-5-6-sol/>
- `O10` (`V`): OpenAI GPT-5.6 launch results. MRCR v2 8-needle is 41.3% for Luna in both the 256K–512K and 512K–1M context bands. <https://openai.com/index/gpt-5-6/>

Pages without a stated update date are recorded as observed in force on retrieval. No publisher prose or table arrangement is copied.

## Shared contracts

GPT-5.6 has distinct pi controls `off, low, medium, high, xhigh, max`. GPT-5.4 mini and nano have `off, low, medium, high, xhigh`. In pinned pi 0.83, `minimal` clamps to low for all five. Mini and nano `max` clamps to xhigh. These clamp aliases are not distinct ladder levels and are not hard rejection metadata.

GPT-5.6 has a 1,050,000-token documented context window and 128,000 maximum output. Artificial Analysis rounds the context to 1,000,000. Mini and nano have 400,000 context and 128,000 maximum output. Capacity is documentation-only. Pi's registry remains authoritative at runtime.

## Exact-effort capability

DeepSWE measures low through max for each GPT-5.6 model. It has no mini or nano row.

| model | low | medium | high | xhigh | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Luna | 1.55% | 11.28% | 44.25% | 56.86% | 67.19% |
| Terra | 24.05% | 35.11% | 53.76% | 60.18% | 69.62% |
| Sol | 45.35% | 61.06% | 69.40% | 70.73% | 72.67% |

These values are pass@1 over the source's scored attempts. `O7` is the source. Observed mean cost is descriptive benchmark output. It is not expected retry cost or runtime pricing.

Artificial Analysis labels the GPT-5.6 non-reasoning values and several GPT-5.4 values as estimates pending independent evaluation. Those rows do not qualify. Mini and nano xhigh pages are measured, and `O5` independently supplies xhigh vendor quality numbers.

Therefore:

- Luna, Terra, and Sol measure low through max. `off` is an evidence gap.
- Mini and nano measure xhigh. `off`, low, medium, and high are evidence gaps.

## Per-model guidance and hazards

### `openai/gpt-5.6-luna`

For DeepSWE-shaped repository work, max is the only effort whose source interval does not overlap xhigh. Lower levels show steep aggregate quality loss. OpenAI's MRCR v2 8-needle result is 41.3% in both the 256K–512K and 512K–1M bands, so the large window does not by itself establish strong deep retrieval. This statement is per model and effort. It is not a task classifier. Keep tier 1 as a prior project judgment. Cache facts include the unchanged historical 2026-08-06 Luna probe series.

### `openai/gpt-5.6-terra`

For DeepSWE-shaped work, max has the highest measured rate. No refreshed source establishes a unique routing niche. Keep configured-only guidance and `tierUnsourced`. Cache retention is documented, but no local retention series exists.

### `openai/gpt-5.6-sol`

High is the cheapest effort whose DeepSWE run interval overlaps max. Sol high costs 2.414 times less in the source aggregate. This is a descriptive benchmark comparison only. Sol needs supervision on long or highest-effort coding because of `O6` and `O9`. Keep tier 3 as a prior project judgment. Preserve the unchanged 2026-08-06 warm probe series and the measured low-to-high invalidation transition.

### `openai/gpt-5.4-mini`

Only xhigh has non-provisional exact-effort quality evidence. The 400K capacity does not prove deep retrieval. Vendor MRCR at xhigh falls to 33.6% in the 128K–256K band. Keep explicit-scope-only guidance, tier 1, and `tierUnsourced`. Exact model-specific cache lifetime remains unknown.

### `openai/gpt-5.4-nano`

Only xhigh has non-provisional exact-effort quality evidence. Vendor MRCR at xhigh falls to 33.1% in the 128K–256K band. Computer use and tool search are unsupported. Keep explicit-scope-only guidance, tier 1, and `tierUnsourced`. Exact model-specific cache lifetime remains unknown.

## Conflicts and unknowns

OpenAI lists mini and nano as current. Artificial Analysis calls its own old benchmark profiles deprecated. The later current vendor availability wins. No source in this pass supplies a new common ordinal-tier method. No GPT-5.4 cache lifetime or invalidation transition is established. GPT-5.6 cache reuse can be machine- and load-dependent. `configuration_update` can preserve Astra cache in an alternate request form, but Slate does not emit that form.
