# Thread cache cost

This document explains how to compare continuing work in an existing worker thread with starting a new thread. It carries mechanism and evidence that would be too costly in Slate's doctrine, which enters every orchestrator turn.

## Evidence record

This document is the durable measurement summary. The deleted research log was folded into the description of [pull request 130](https://github.com/JetBrains/ytdb-slate/pull/130), so that description preserves the approved decisions and their reasoning. It does not contain raw measurements, per-arm tables, or transcripts, and no repository copy of those raw records survives. For more decision rationale and implementation review history, read the pull request. The numerical evidence needed to assess the rules is carried below. Dates are measurement dates, not guarantees about later provider behavior.

## Terms

A **warm thread** can reuse the cached request prefix from its previous turn. That prefix includes the worker instructions, tools, conversation, and prior tool results accepted by the provider's cache.

A **cold thread** cannot reuse that prefix on its next request. The provider must process the prefix again. A cache hit remains a provider decision, so a warm classification predicts eligibility rather than guaranteeing billed cached tokens.

A **turn** is one worker model response and its associated tool activity. The orchestrator estimates how many turns an action needs before choosing a thread.

## Total cold transitions

Changing an existing thread's model makes its next request cold. Changing its effort level also makes the request cold, even when the model stays the same. Treat either change as a rewrite of the whole prefix.

The two transition claims have different evidence.

**Model-change method, 2026-08-06.** A transcript audit covered three real OpenAI worker threads and 71 assistant turns. It found one in-thread model transition, from `gpt-5.6-luna` to `gpt-5.6-sol`. The switch request read **0** cached tokens and wrote **53,763**; its next request recovered to a 0.528 cache-hit fraction. Thus the model-change sample size is **n=1**, on one provider family. It was observational rather than a controlled arm, and no Anthropic model-change sample was run.

**Effort-change method, 2026-08-06.** A corrected controlled run gave each arm a distinct approximately 18,000-token system prefix and a unique tool. It changed only the live effort through the same `setThinkingLevel` route Slate uses. Each provider family had one unchanged control and three changed arms: step up, step down, and `off`.

| family and model | unchanged control | changed arms | changed-arm result |
| --- | ---: | ---: | --- |
| OpenAI `gpt-5.6-luna` | 18,113 written, then 18,113 read | 3 | each read 0 after an approximately 18,115-token write |
| Anthropic `claude-sonnet-5` | 18,555 written, then 18,555 read | 3 | each read 0 after an approximately 18,556-token write |

The effort-change sample is **n=6 transitions** across two model families, with **n=2 controls**. No changed arm showed partial survival. An earlier calibration run had cross-arm tool-definition reuse and was excluded; unique tools removed that independent cache breakpoint.

**Effort-change replication, 2026-08-06.** A second controlled harness used a dedicated cache key for every probe, an approximately 6,000-token prefix, and a 60-second gap. The harness also asserted the effort value sent on every request. A low-to-high change produced zero cache reads in **3 of 3 probes** on OpenAI `gpt-5.6-luna` and **3 of 3 probes** on Anthropic `claude-sonnet-5`. Same-effort controls remained warm in **3 of 3 probes** on each model. The sample is three probes per changed or control cell. It tested only a low-to-high transition and only one model from each provider family.

Anthropic documents that a thinking or effort change invalidates the message portion of its cache, so the Anthropic result confirms documented behavior. OpenAI documents no cache effect for an effort change in either direction, so the OpenAI result is new evidence rather than a confirmation of a published guarantee.

The decision rule therefore treats the transitions as binary:

- the model and effort both stay unchanged, so the existing thread remains eligible for prefix reuse;
- either value changes, so none of the existing prefix receives warm-thread credit.

This rule is conservative rather than a provider guarantee. Provider caching is best effort. The same 2026-08-06 transcript audit found one unexplained OpenAI miss 571 seconds after the prior dispatch, inside the observed retention window and without a model change or known expiry. A zero read can therefore occur without a transition, and these samples cannot prove that every future model, API path, or provider release behaves the same way.

## Fresh-thread rediscovery

A fresh thread lacks the working context that an existing thread accumulated. Episodes can transfer durable results, but the new worker still has to orient itself to the task and repository.

**Method and result, 2026-08-06.** One repository follow-up was given to a continuation and to a fresh thread with durable episode context. The fresh arm made **one more tool call** than the continuation and produced the better answer, with line numbers and a flagged error. The usable sample is **n=1 task pair**. It was not designed as a model-family comparison, and the surviving decision record does not identify the worker models, so no provider-family conclusion follows. A second question supplies no independent sample because its continuation arm was contaminated by prior self-correction.

Slate expresses the observed **+1 tool call** as an approximate one-turn rediscovery penalty. Charge the fresh-thread option one extra turn when comparing it with continuation. The raw transcript and absolute per-arm call counts were not retained; only the measured difference, answer comparison, and contamination finding survive. The sample cannot establish a distribution or a universal constant. A simple action may need no rediscovery, while a poorly compressed or unusual work stream may need more.

## Basis of the two-turn guard

**Method, 2026-08-06.** Six cost-model grids covered OpenAI and Anthropic paths. Each grid crossed context sizes **20k, 40k, 60k, 80k, 120k, and 160k** with **1, 3, 5, 10, and 20** future turns: 30 cells per grid and **180 modeled cells** in total, not 180 live dispatches. The cases were OpenAI warm and cold before shared seed reads, OpenAI warm and cold after shared seed reads, and Anthropic warm and cold.

The model used measured seeds of **16,116 OpenAI tokens** and **26,481 Anthropic tokens**, each observed twice. It used three injected episodes totaling **5,400 OpenAI tokens** or **7,200 Anthropic tokens**, plus **500 task tokens**, **3,500 growth tokens per turn**, and **600 output tokens per turn**. Current rows had cache-write/cache-read ratio **12.5**, giving this boundary:

`existing context > seed + episodes + 11.5 × written share / expected turns`

The exact boundaries show why turn count matters:

| case | 1 turn | 3 turns | 5 turns | 20 turns |
| --- | ---: | ---: | ---: | ---: |
| OpenAI warm, seed written | 269k | 104k | 71k | 34k |
| OpenAI warm, seed read | 84k | 43k | 34k | 25k |
| OpenAI cold | 22k | 22k | 22k | 22k |
| Anthropic warm, seed read | 118k | 62k | 51k | 38k |
| Anthropic cold | 34k | 34k | 34k | 34k |

A 50k OpenAI threshold classified **22 of 30** warm, seed-written cells correctly and missed eight. Five misses were material: four at one turn and one at three turns. The guard therefore places one- and two-turn work on the continuation side. Two turns was inferred as the boundary between modeled one- and three-turn cases; no live two-turn break-even experiment was run.

The grids cannot establish a universal break-even point. Their result depends on the project's prompt seed, episode size, cache state, input and cache-write prices, expected output, and the accuracy of the orchestrator's turn estimate. They also optimize one dispatch rather than the permanent context growth of a whole work stream.

## Comparing continuation with a fresh thread

Apply the comparison to one action:

1. Start a new thread when the action begins a new work stream. Thread separation is a semantic boundary before it is a cost choice.
2. Estimate the action's required model, effort, and worker turns. Preserve the quality needed to complete the action.
3. Continue the existing thread when the action needs at most two turns. Measurements found that short actions do not recover the fresh-thread setup cost.
4. For a longer action, classify continuation as warm only when its model and effort remain unchanged. Otherwise classify continuation as cold.
5. Add one turn to the fresh-thread estimate for rediscovery.
6. Compare the complete options. Include every estimated turn, the model's input and output rates, the existing prefix size, and any expected compaction. Give cached-input credit only to an option whose prefix is warm.

Do not compare model prices alone. A cheaper routed model can lose its advantage when selecting it rewrites a large warm prefix. The same warning applies to a cheaper effort level because an effort change is also a total cold transition.

Do not preserve warmth by choosing a model or effort that cannot clear the action. Cache savings are a cost input, not permission to lower required capability.

## Cache-key sharding experiment

A controlled experiment on 2026-08-06 tested the implementation as shipped in this branch on the OpenAI `gpt-5.6-luna` path. Two arms used distinct long prefixes. Each arm created four worker threads sequentially in one persistent process. Treatment used the default two shards. Control set `cacheKeyEnabled: false`, so Slate installed no shared key.

| arm | threads | input tokens | cached tokens | cached/input | worker cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| two-shard treatment | 4 | 119,124 | 59,496 | 0.499 | $0.01612032 |
| disabled control | 4 | 119,116 | 0 | 0.000 | $0.02980240 |

Worker cost fell 45.91%. All-in cost was $0.04249825 for treatment and $0.05489782 for control, or $0.09739607 across both arms.

The per-thread pattern is evidence that the provider path honors the key. The first thread on each treatment shard wrote its full prefix. The later thread on the same shard read 29,748 cached tokens. Threads with identical prefixes but different shard keys did not share cache. That pattern is inconsistent with a provider ignoring the key.

The experiment is thin: four threads per arm. Treatment ran before control. Traffic passed through a local proxy, so attribution to the upstream provider is indirect. The run covers only the first dispatch. It does not cover long conversations, retention expiry, compaction, other models, other providers, or high request rates. This result supersedes every earlier cache-key measurement in the pull request record.

## Limits and refresh conditions

Re-measure each claim when its inputs can have changed:

- **Cold transitions:** repeat controlled model and effort arms after a provider changes cache semantics, pi changes request construction, Slate changes route application, or a new model family becomes supported. A future model-change run should include controlled samples from both provider families because the current model evidence is one OpenAI event.
- **Rediscovery:** repeat controlled pairs across several task shapes, model families, and repository sizes. Replace the one-turn charge only after the distribution is stable enough to support another policy.
- **Two-turn guard:** regenerate the grids after material changes to prompt-seed size, episode construction, provider prices, cache-write behavior, cache-key behavior, compaction, or supported model families. Validate the inferred two-turn boundary with live two-turn actions when possible.
- **Cache-key sharding:** repeat with more threads and randomized arm order after changes to key derivation, shard assignment, the disable switch, the local proxy, the OpenAI API path, or provider cache policy. Add continuation, expiry, and compaction arms before applying the first-dispatch result to those cases.

This document describes decision inputs. The provider's reported usage remains the authority for the cost that actually occurred.
