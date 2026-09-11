# Verification and gap reconciliation

**Pass date: 2026-09-11 UTC.** This pass reconciles the refreshed OpenAI and Anthropic reports and prepares the future Gemini and Astra digest basis. It does not ship either future profile.

## Evidence policy

A measured effort needs a traced numerical quality result for that exact model and effort. Accuracy, resolve rate, F1, Elo, and a composite capability index qualify. Cost, tokens, latency, turns, registry presence, and vendor prose do not. An Artificial Analysis row labelled as an estimate with independent evaluation forthcoming is not a result.

Later effective dates win. If effective dates are equal or absent, source class breaks the tie. Conflicts retain both values and dates. `UNKNOWN` is preferred to inference.

## DeepSWE reconciliation

Source: DeepSWE v1.1 live aggregate generated 2026-09-03 and retrieved 2026-09-11. Harness is mini-swe-agent over 113 tasks and four whole-benchmark runs. Pass@1 excludes provider, verifier, and network errors. Published 95% intervals use run-to-run standard error, not Wilson intervals. Mean cost is descriptive benchmark output, not runtime pricing or expected retry cost.

The active source contains five effort rows for GPT-5.6 Luna, Terra, Sol, Claude Sonnet 5, Claude Opus 5, Claude Fable 5, and GPT-6 Astra. Gemini 3.8 Flash has medium and high rows. GPT-5.4 mini, GPT-5.4 nano, and Claude Haiku 4.5 have no rows.

Provider identity from an exact cached public-trial join is OpenAI for GPT-5.6 and Astra, Anthropic for Sonnet, and Vertex AI for Opus, Fable, and Gemini. No raw trial file enters this repository.

## Pinned pi 0.83 mapping

- GPT-5.6: `off, low, medium, high, xhigh, max`.
- GPT-5.4 mini and nano: `off, low, medium, high, xhigh`. `minimal` and `max` clamp to valid controls.
- Sonnet and Opus: all seven pi labels. `minimal` maps to low. `off` sends disabled thinking.
- Fable: `minimal, low, medium, high, xhigh, max`.
- Haiku: `off, minimal, low, medium, high` through disabled or manual budget thinking. xhigh and max clamp to high.

The future Gemini and Astra records work on pi 0.83 through the remote catalogue overlay and generic adapters. No SDK upgrade is required. Their approved ladders are narrower than pi's permissive clamp behavior because Slate must preserve the requested control rather than silently substitute another.

## Future Track 5 digest basis

### Gemini 3.8 Flash

Canonical spec is `google-vertex/gemini-3.8-flash`. Approved aliases are `google/gemini-3.8-flash`, `opencode/gemini-3.8-flash`, and `openrouter/google/gemini-3.8-flash`. These are distinct provider routes. They share model identity and limits, not cache, privacy, wire format, or rates.

Vendor sources retrieved 2026-09-11 establish the ladder `low, medium, high`, context 1,048,576, output 65,536, and that requested `off` and `minimal` are unsupported. Artificial Analysis independently measures low 34, medium 40, and high 41 on Artificial Analysis Intelligence Index v4.3. The index is a weighted composite of ten evaluations: Agents 30%, Coding 20%, General 30%, and Scientific Reasoning 20%. The v4.3 announcement was published 2026-09-07. Component harnesses and scoring methods differ. The public pages do not publish one composite harness, an exact per-model execution date, or complete endpoint configuration. DeepSWE Vertex AI measures medium 71.02% and high 73.83%. Its intervals are 68.74–73.30 and 72.41–75.24. Keep all three levels measured and no valid-ladder gaps.

Use `cacheRetention: null` in the future shared profile. Vertex explicit-cache and governance facts do not establish one reusable cache contract for Google, OpenCode, and OpenRouter. Record provider-specific privacy and implicit-cache behavior as unknown.

Tier 2 is only a practical display candidate. Mark it unsourced unless a later common method proves an ordinal boundary.

Sources: <https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash>, <https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-8-flash>, <https://artificialanalysis.ai/models/releases/gemini-3-8-flash>, <https://artificialanalysis.ai/methodology/intelligence-benchmarking>, <https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3>, and the DeepSWE aggregate above. All were retrieved 2026-09-11. The Google Cloud model page states release date 2026-09-02.

### GPT-6 Astra

Canonical spec is `openai/gpt-6-astra` with no alias. Vendor sources retrieved 2026-09-11 establish `low, medium, high, xhigh, max`, context 1,050,000, output 128,000, and unsupported requested controls `off` and `minimal`. Pi's 272,000 registry value is a known runtime divergence and billing threshold, not vendor capacity.

Artificial Analysis independently measures 46, 50, 51, 53, and 53 from low through max on Artificial Analysis Intelligence Index v4.3. The same ten-evaluation weighted composite and mixed-method qualification described for Gemini applies. DeepSWE measures 67.04%, 72.79%, 73.23%, 74.12%, and 73.23%. Max is not always best. All five levels qualify and no valid-ladder gap remains.

Formal rollout completion remains unknown. Current API documentation coexists with OpenAI's limited-rollout announcement. The OpenAI launch announcement was effective on 2026-09-03 and was retrieved on 2026-09-11. It cites Astra at 61.2 on Artificial Analysis Intelligence Index v4.1.1. The later independently measured v4.3 effort series is 46/50/51/53/53, with the v4.3 index published on 2026-09-07. These generations are different scales and must not be subtracted. The later 2026-09-07 v4.3 method controls the future measured-level basis.

The prompt-caching guide documents a 1,800-second minimum after the latest write or reuse, refresh on reuse without another write charge, machine-local placement, and the default `prompt_cache_options.ttl="30m"` control. A model change invalidates the prefix. Slate's top-level effort change starts a cold path. The alternate `configuration_update` request can preserve a prefix, but Slate does not emit it. Put that path in `excluded`. These are documented facts for Astra, not Astra-specific probe results. Keep privacy separate. Cache tensors can remain for up to 24 hours. Default abuse logs can retain content for up to 30 days. API training is opt-in. Zero Data Retention depends on eligibility, approval, and configuration.

Tier 4 is only a practical display candidate. Mark it unsourced unless a later common method proves an ordinal boundary.

Sources: <https://developers.openai.com/api/docs/models/gpt-6-astra>, <https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra>, <https://developers.openai.com/api/docs/guides/prompt-caching>, <https://developers.openai.com/api/docs/guides/your-data>, <https://openai.com/index/gpt-6-astra/>, <https://openai.com/products/release-notes/>, <https://artificialanalysis.ai/models/releases/gpt-6-astra>, <https://artificialanalysis.ai/methodology/intelligence-benchmarking>, <https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3>, and the DeepSWE aggregate above. All were retrieved 2026-09-11.

## Adjudications carried from earlier generations

Git history preserves every v1–v5 finding. The v6 `SUPERSEDES` header is the chain of custody. The standing corrections remain active: do not invent a benchmark rank, do not turn a billing threshold into capacity, do not compare benchmark generations as one scale, do not call missing rows zero, do not assign significance without compatible uncertainty, and do not transfer a deployment result to another provider.

## Remaining gaps

No fresh common method establishes all tier boundaries. No exact GPT-5.4 cache lifetime exists. Haiku has no exact-effort quality result. Gemini aliases lack a shared cache and privacy contract. Astra rollout completion is unknown. Provider-backed behavior can still differ by account, region, quota, and future remote-catalogue state.
