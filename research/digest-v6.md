# Model-router digest v6

**SUPERSEDES `digest-v5.md`, `digest-v4.md`, `digest-v3.md`, `digest-v2.md`, and `digest.md`.** Observed and retrieved 2026-09-11. Git history is the archive. This generation refreshes every surviving field for nine shipped profiles and prepares checked Gemini and Astra records for Track 5.

## Tracing and source policy

Every factual statement traces to `openai.md` (`O`), `anthropic.md` (`A`), or `gaps.md` (`G`). `V` means vendor-published and `I` means independently measured. A figure without a source, model, effort, harness or version becomes `UNKNOWN` when those labels are required.

An effort is measured only when a source reports a numerical quality result for that exact model and effort. Accuracy, resolve rate, F1, Elo, and a composite capability index qualify. Cost, tokens, turns, latency, registry presence, prose, and provisional estimates do not.

Attributed facts and computed summaries are permitted. Publisher prose, table arrangement, and downloaded raw data are not copied. Later effective dates win. Source class decides only when dates are equal or absent.

## Existing profile transcription

| canonical spec | ladder | measured | gaps | context / output | tier status |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-5.6-luna` | off, low, medium, high, xhigh, max | low–max | off | 1,050,000 / 128,000 | tier 1, prior judgment |
| `anthropic/claude-sonnet-5` | all seven | low–max | off, minimal | 1,000,000 / 128,000 | tier 2, prior judgment |
| `openai/gpt-5.6-terra` | off, low, medium, high, xhigh, max | low–max | off | 1,050,000 / 128,000 | tier 2 placeholder, unsourced |
| `openai/gpt-5.6-sol` | off, low, medium, high, xhigh, max | low–max | off | 1,050,000 / 128,000 | tier 3, prior judgment |
| `anthropic/claude-opus-5` | all seven | low–max | off, minimal | 1,000,000 / 128,000 | tier 3, prior judgment |
| `anthropic/claude-fable-5` | minimal, low, medium, high, xhigh, max | low–max | minimal | 1,000,000 / 128,000 | tier 4, prior judgment |
| `openai/gpt-5.4-nano` | off, low, medium, high, xhigh | xhigh | off, low, medium, high | 400,000 / 128,000 | tier 1 placeholder, unsourced |
| `openai/gpt-5.4-mini` | off, low, medium, high, xhigh | xhigh | off, low, medium, high | 400,000 / 128,000 | tier 1 placeholder, unsourced |
| `anthropic/claude-haiku-4-5` | off, minimal, low, medium, high | none | all five | 200,000 / 64,000 | tier 1 placeholder, unsourced |

The OpenAI 1,000,000 Artificial Analysis value is a known rounded divergence. Runtime context and prices come from pi's exact provider-qualified registry row.

## Per-model guidance

- Luna: DeepSWE quality rises sharply through max. Max is the only source interval that does not overlap xhigh. Preserve the max latency hazard. OpenAI reports 41.3% MRCR v2 8-needle in both the 256K–512K and 512K–1M bands, which supports the deep-retrieval hazard. `[O7, O10]`
- Terra: max is highest on DeepSWE, but no source proves a unique niche. Keep configured-only guidance and the unsourced marker. `[O7, O8]`
- Sol: high is the cheapest DeepSWE effort whose run interval overlaps max. Supervise long and highest-effort work because user-intent and cheating hazards remain. `[O6, O7, O9]`
- Sonnet: low through max now have evidence. `off` is accepted but unmeasured. Keep the existing narrow high recommendation. `[A2, A6, A8]`
- Opus: low through max are measured. High remains the narrow recommendation because higher DeepSWE intervals overlap while work rises. DeepSWE is a distinct Vertex AI deployment. The named Vals evaluation used an Opus 4.8 fallback. `[A6, A9]`
- Fable: low through max are measured. Keep non-preferred guidance. Refuse zero-retention work unless express Anthropic authorization and required configuration are confirmed. DeepSWE is a distinct Vertex AI deployment. The named Vals and Artificial Analysis evaluations used an Opus 4.8 fallback. `[A1, A4, A6, A9, A10]`
- Mini and nano: only xhigh has non-provisional exact-effort quality. Keep explicit-scope-only guidance and warn about weak deep retrieval. `[O1, O5, O8]`
- Haiku: five pi labels alter disabled or manual budget thinking. No exact-effort quality result exists. Vals has a Thinking row but no exact pi budget label. Keep explicit-scope-only guidance. `[A1, A2, A6, A9]`

These are model-and-effort statements. No benchmark score enters doctrine and no automatic task classifier is derived.

## Cache and privacy

GPT-5.6 has a documented 1,800-second minimum refreshed by reuse. Anthropic's default is a five-minute lifetime refreshed by a hit. The three local probe series remain exactly as recorded on 2026-08-06. They are historical measurements, not universal guarantees.

Slate changes top-level effort. OpenAI `configuration_update` and Anthropic per-message effort are alternate cache-preserving APIs that Slate does not emit. They are excluded alternatives. GPT-5.4 model-specific cache lifetime remains unknown. Cache lifetime, provider application-state retention, abuse logs, training policy, and Covered Model retention are distinct.

## Future Track 5 basis

| future spec | aliases | ladder | rejected requested controls | measured | context / output | cache | tier status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `google-vertex/gemini-3.8-flash` | Google, OpenCode, OpenRouter approved specs | low, medium, high | off, minimal | all three | 1,048,576 / 65,536 | null, provider-specific unknowns | candidate 2, unsourced |
| `openai/gpt-6-astra` | none | low, medium, high, xhigh, max | off, minimal | all five | 1,050,000 / 128,000, known pi divergence 272,000 | 1,800s minimum, refresh on reuse, machine-local; alternate update excluded | candidate 4, unsourced |

Artificial Analysis Intelligence Index v4.3 independently measures Gemini low, medium, and high at 34, 40, and 41, and Astra low through max at 46, 50, 51, 53, and 53. The index is a weighted composite of ten mixed-method evaluations: Agents 30%, Coding 20%, General 30%, and Scientific Reasoning 20%. The v4.3 announcement is dated 2026-09-07, and the public pages were retrieved 2026-09-11. They publish no single composite harness, exact per-model execution date, or complete endpoint configuration. These index points are not percentages or one coding benchmark. `[G]`

Astra's documented cache record has a 1,800-second minimum, refresh on reuse without another write charge, machine-local placement, and the default `30m` control. A model change invalidates the prefix. Slate's top-level effort change starts a cold path. The alternate `configuration_update` request can preserve a prefix but Slate does not emit it, so it belongs in `excluded`. These are documented Astra-family facts, not Astra probe results. Privacy is separate: cache tensors can remain for up to 24 hours, default abuse logs for up to 30 days, training is opt-in, and Zero Data Retention depends on eligibility, approval, and configuration. `[G]`

Pinned pi 0.83 supports both through the remote-catalogue overlay and generic adapters. No SDK upgrade is required. `apiRejectedLevels` protects the requested control before pi can omit or silently substitute it. Track 5 owns production profiles, named-model tests, and the final field comparison after all Track 5 edits. `[G]`

## Conflicts and unknowns

The current Sonnet vendor page shows the original price still in force and no future increase. The 2026-07-29 scheduled increase remains in Git history. Runtime prices are registry-only. OpenAI's Astra launch material was effective on 2026-09-03 and was retrieved on 2026-09-11. It cites 61.2 on Artificial Analysis Intelligence Index v4.1.1. The later independently measured v4.3 effort series is 46/50/51/53/53, with the v4.3 index published on 2026-09-07. The generations are different scales and must not be subtracted. The later 2026-09-07 v4.3 method controls the future measured-level basis. Astra rollout completion remains unknown because current API pages coexist with a limited-rollout announcement. Other Artificial Analysis and Vals generations also changed. Terminal-Bench 2.1 was not freshly retrievable. No common uncertainty-aware method derives all tier labels. Unknowns remain explicit rather than inferred.

## Generation findings retained

V1–v5 corrections remain binding through this supersession: fabricated ranks are deleted, billing thresholds are not capacities, source deployment and harness labels stay attached, absent rows are not zero scores, and evidence gaps remain advisory unless project policy refuses them. Full finding dispositions remain in Git history and the v5 supersession record.
