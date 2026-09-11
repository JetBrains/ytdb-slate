# Anthropic capability evidence

**Observed in force and retrieved 2026-09-11 UTC.** `V` means vendor-published. `I` means independently measured. This report covers four existing profiles. Runtime prices remain pi registry facts.

## Sources

- `A1` (`V`): model overview, identifiers, limits, lifecycle, and effort controls. <https://platform.claude.com/docs/en/models/overview>
- `A2` (`V`): effort and thinking guides. <https://platform.claude.com/docs/en/build-with-claude/effort> and <https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting>
- `A3` (`V`): prompt caching. Default short retention is five minutes. A hit refreshes it without another write charge. <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- `A4` (`V`): API and data retention plus Covered Models. <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention> and <https://support.claude.com/en/articles/15425695-covered-models>
- `A5` (`V`): refusals and fallback. A refusal can return HTTP 200 with `stop_reason: refusal`. <https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback>
- `A6` (`I`): DeepSWE v1.1 live aggregate, generated 2026-09-03. It uses mini-swe-agent, 113 tasks, and four runs. <https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json>
- `A7` (`I`): Artificial Analysis Intelligence Index v4.3 model pages. <https://artificialanalysis.ai/models>
- `A8` (`I`): SWE-rebench fixed ReAct scaffold. <https://swe-rebench.com/>
- `A9` (`I`): Vals model and SWE-bench pages. The Opus and Fable pages disclose an Opus 4.8 refusal fallback. The benchmark page includes a Haiku 4.5 Thinking row without an exact pi budget label. <https://www.vals.ai/models/anthropic_claude-opus-5>, <https://www.vals.ai/models/anthropic_claude-fable-5>, and <https://www.vals.ai/benchmarks/swebench>
- `A10` (`I`): Artificial Analysis Opus 5 report. Its Intelligence Index evaluation discloses an Opus 4.8 fallback. <https://artificialanalysis.ai/articles/opus-5>

The cached exact DeepSWE trial join identifies Opus and Fable as Vertex AI deployments and Sonnet as Anthropic. The live aggregate omits those provider fields. Provider identity is retained because deployments are not interchangeable.

## Contracts and limits

Sonnet and Opus use all seven pi labels. Pi maps `minimal` to provider effort low. `off` uses disabled thinking and is accepted. Fable has `minimal, low, medium, high, xhigh, max` because adaptive thinking is always on. Haiku has `off, minimal, low, medium, high`. Pi maps the four non-off levels to `budget_tokens` 1,024, 2,048, 8,192, and 16,384. Haiku xhigh and max clamp to high and are not distinct controls.

Sonnet, Opus, and Fable have 1,000,000 context and 128,000 maximum output. Haiku has 200,000 context and 64,000 output. These are documentation-only cross-checks.

## DeepSWE exact-effort evidence

| model and deployment | low | medium | high | xhigh | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sonnet, Anthropic | 30.51% | 39.78% | 48.23% | 49.67% | 53.85% |
| Opus, Vertex AI | 58.13% | 68.90% | 72.83% | 73.15% | 73.65% |
| Fable, Vertex AI | 59.58% | 65.37% | 68.60% | 69.91% | 69.72% |

`A6` reports pass@1 over scored attempts. Its 95% intervals use run-to-run standard error. Errors excluded by the source must not be restored to denominators. Haiku has no exact row.

Therefore Sonnet, Opus, and Fable measure low through max. Sonnet and Opus retain gaps at `off` and `minimal`. Fable retains a gap at `minimal`. Haiku has no measured level.

## Per-model guidance and hazards

### `anthropic/claude-sonnet-5`

Low through max now have exact-effort evidence. The old claim that nothing below high is measured is withdrawn. Sonnet accepts disabled thinking, so `off` is not provider-rejected. Keep tier 2 as the existing project judgment. The current vendor price page shows the original rate still in force. The previously scheduled increase did not take effect. Runtime price still comes only from pi.

### `anthropic/claude-opus-5`

Low through max are measured. High remains the narrow recommendation because higher DeepSWE intervals overlap while observed work rises. DeepSWE is a distinct Vertex deployment whose records do not report fallback. The named Vals evaluation used an Opus 4.8 refusal fallback. Keep tier 3.

### `anthropic/claude-fable-5`

Low through max are measured. The model is active legacy and has a successor. It remains a Covered Model with at least 30-day retention unless Anthropic expressly authorizes the organization and the required configuration is confirmed. Unknown authorization is not authorization. Availability, a successful request, and a general zero-retention agreement do not establish the exception. The provider can return refusals with HTTP 200. DeepSWE is a distinct Vertex deployment with no reported fallback. The named Vals and Artificial Analysis evaluations used an Opus 4.8 fallback, but neither publishes its share. Keep tier 4 and non-preferred guidance.

### `anthropic/claude-haiku-4-5`

No source supplies exact-effort numerical quality. The five pi controls change manual thinking budget even though Anthropic does not expose adaptive effort. Keep explicit-scope-only guidance, tier 1, and `tierUnsourced`. Haiku is absent from DeepSWE and current Artificial Analysis. Vals lists a Haiku 4.5 Thinking result without an exact pi budget label, so it closes no exact-effort gap.

## Cache and privacy

Keep the three historical 2026-08-06 probe series unchanged. Slate and pi 0.83 change top-level effort, which starts a cold cache path. Anthropic's per-message effort beta can preserve a prefix on supported models, but Slate does not emit it. The alternative belongs in `excluded`, not in an invented schema field. Paid one-hour retention is also outside Slate's current short-cache mode.

Cache lifetime and privacy retention are separate. Fable's mandatory retention is not a cache lifetime. Provider and deployment policies must not be transferred across aliases or benchmark deployments.

## Conflicts and unknowns

The 2026-07-29 corpus recorded a future Sonnet rate increase. The current vendor page has no such row and still lists the original rate. The later in-force observation wins, while both dated records remain in Git history. Artificial Analysis changed from v4.1 to v4.3, so generation scores are not compared by subtraction. Current Terminal-Bench 2.1 rows could not be re-fetched from the new site. Their old dated values remain historical, not refreshed measurements.
