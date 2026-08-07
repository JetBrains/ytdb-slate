# Thread cache cost

This document explains Slate's implemented choice between continuing a worker thread and starting a fresh one. It carries mechanism and evidence that would be too costly in Slate's doctrine.

## Evidence record

This document is the durable measurement summary. The deleted research log was folded into the description of [pull request 130](https://github.com/JetBrains/ytdb-slate/pull/130), so that description preserves the approved decisions and their reasoning. It does not contain raw measurements, per-arm tables, or transcripts, and no repository copy of those raw records survives. For more decision rationale and implementation review history, read the pull request. The numerical evidence needed to assess the rules is carried below. Dates are measurement dates, not guarantees about later provider behavior.

Every numerical figure carries one of these evidence labels:

- **Measured probe** reports an observed provider response or local run. Its date and sample size bound the claim. Re-run it under the matching refresh condition below. Slate accepts cache-retention probes for 90 days, then treats them as stale.
- **Documented provider price** reports a dated provider price row. The profile table records when a row was observed or took effect. No age check rejects an old price row, so maintainers must review prices under the refresh conditions below.
- **Modelled projection** computes a result from stated inputs. It stays current only while every input and assumption stays current. Regenerate it when any listed input changes.
- **Implemented constant** reports a code or configuration value. Re-check it whenever the named implementation changes.

## Terms

A **warm thread** can reuse the cached request prefix from its previous turn. That prefix includes the worker instructions, tools, conversation, and prior tool results accepted by the provider's cache.

A **cold thread** cannot reuse that prefix on its next request. The provider must process the prefix again. A cache hit remains a provider decision, so a warm classification predicts eligibility rather than guaranteeing billed cached tokens.

A **turn** is one worker model response and its associated tool activity. The planner prices a caller-supplied turn estimate.

## Total cold transitions

Changing an existing thread's model makes its next request cold. Changing its effort level also makes the request cold, even when the model stays the same. Treat either change as a rewrite of the whole prefix.

The two transition claims have different evidence.

**Measured probe, model-change method, 2026-08-06.** A transcript audit covered three real OpenAI worker threads and 71 assistant turns. It found one in-thread model transition, from `gpt-5.6-luna` to `gpt-5.6-sol`. The switch request read **0** cached tokens and wrote **53,763**; its next request recovered to a 0.528 cache-hit fraction. Thus the model-change sample size is **n=1**, on one provider family. It was observational rather than a controlled arm, and no Anthropic model-change sample was run.

**Measured probe, effort-change method, 2026-08-06.** A corrected controlled run gave each arm a distinct approximately 18,000-token system prefix and a unique tool. It changed only the live effort through the same `setThinkingLevel` route Slate uses. Each provider family had one unchanged control and three changed arms: step up, step down, and `off`.

| family and model | unchanged control | changed arms | changed-arm result |
| --- | ---: | ---: | --- |
| OpenAI `gpt-5.6-luna` | 18,113 written, then 18,113 read | 3 | each read 0 after an approximately 18,115-token write |
| Anthropic `claude-sonnet-5` | 18,555 written, then 18,555 read | 3 | each read 0 after an approximately 18,556-token write |

The effort-change sample is **n=6 transitions** across two model families, with **n=2 controls**. No changed arm showed partial survival. An earlier calibration run had cross-arm tool-definition reuse and was excluded; unique tools removed that independent cache breakpoint.

**Measured probe, effort-change replication, 2026-08-06.** A second controlled harness used a dedicated cache key for every probe, an approximately 6,000-token prefix, and a 60-second gap. The harness also asserted the effort value sent on every request. A low-to-high change produced zero cache reads in **3 of 3 probes** on OpenAI `gpt-5.6-luna` and **3 of 3 probes** on Anthropic `claude-sonnet-5`. Same-effort controls remained warm in **3 of 3 probes** on each model. The sample is three probes per changed or control cell. It tested only a low-to-high transition and only one model from each provider family.

Anthropic documents that a thinking or effort change invalidates the message portion of its cache, so the Anthropic result confirms documented behavior. OpenAI documents no cache effect for an effort change in either direction, so the OpenAI result is new evidence rather than a confirmation of a published guarantee.

The decision rule therefore treats the transitions as binary:

- the model and effort both stay unchanged, so the existing thread remains eligible for prefix reuse;
- either value changes, so none of the existing prefix receives warm-thread credit.

This rule is conservative rather than a provider guarantee. Provider caching is best effort. The same 2026-08-06 transcript audit found one unexplained OpenAI miss 571 seconds after the prior dispatch, inside the observed retention window and without a model change or known expiry. A zero read can therefore occur without a transition, and these samples cannot prove that every future model, API path, or provider release behaves the same way.

**Measured probe, unexplained-miss follow-up, 2026-08-06.** The 571-second miss did not reproduce. On the same OpenAI `gpt-5.6-sol` model, one dedicated key remained warm in **5 of 5 probes at 571 seconds** and **3 of 3 probes at 1,500 seconds**. A shared key under contention remained warm in **4 of 4 probes at 571 seconds**. An earlier OpenAI `gpt-5.6-luna` arm remained warm in **12 of 12 probes at 571 and 1,500 seconds** while four prefixes competed and a writer ran every 30 seconds.

The follow-up means the original miss is rare or environment-specific. It also means cache-key contention is not the explanation at this tested scale. It does not explain the original miss, which remains unresolved. The original observation stays in this record because failure to reproduce it does not erase the observation.

## Fresh-thread rediscovery

A fresh thread lacks the working context that an existing thread accumulated. Episodes can transfer durable results, but the new worker still has to orient itself to the task and repository.

**Measured probe, method and result, 2026-08-06.** One repository follow-up was given to a continuation and to a fresh thread with durable episode context. The fresh arm made **one more tool call** than the continuation and produced the better answer, with line numbers and a flagged error. The usable sample is **n=1 task pair**. It was not designed as a model-family comparison, and the surviving decision record does not identify the worker models, so no provider-family conclusion follows. A second question supplies no independent sample because its continuation arm was contaminated by prior self-correction.

Slate expresses the observed **+1 tool call** as an approximate one-turn rediscovery penalty. Charge the fresh-thread option one extra turn when comparing it with continuation. The raw transcript and absolute per-arm call counts were not retained; only the measured difference, answer comparison, and contamination finding survive. The sample cannot establish a distribution or a universal constant. A simple action may need no rediscovery, while a poorly compressed or unusual work stream may need more.

## Basis of the two-turn guard

**Modelled projection, method, 2026-08-06.** Six cost-model grids covered OpenAI and Anthropic paths. Each grid crossed context sizes **20k, 40k, 60k, 80k, 120k, and 160k** with **1, 3, 5, 10, and 20** future turns: 30 cells per grid and **180 modeled cells** in total, not 180 live dispatches. The cases were OpenAI warm and cold before shared seed reads, OpenAI warm and cold after shared seed reads, and Anthropic warm and cold.

The projection used **measured probe** seeds of **16,116 OpenAI tokens** and **26,481 Anthropic tokens**, each observed twice. Its model inputs were three injected episodes totaling **5,400 OpenAI tokens** or **7,200 Anthropic tokens**, plus **500 task tokens**, **3,500 growth tokens per turn**, and **600 output tokens per turn**. **Documented provider price:** the dated current rows produced a cache-write/cache-read ratio of **12.5**. Those inputs gave this modelled boundary:

`existing context > seed + episodes + 11.5 × written share / expected turns`

**Modelled projection:** the exact boundaries show why turn count matters.

| modelled case | 1 turn | 3 turns | 5 turns | 20 turns |
| --- | ---: | ---: | ---: | ---: |
| OpenAI warm, seed written | 269k | 104k | 71k | 34k |
| OpenAI warm, seed read | 84k | 43k | 34k | 25k |
| OpenAI cold | 22k | 22k | 22k | 22k |
| Anthropic warm, seed read | 118k | 62k | 51k | 38k |
| Anthropic cold | 34k | 34k | 34k | 34k |

A 50k OpenAI threshold classified **22 of 30** warm, seed-written cells correctly and missed eight. Five misses were material: four at one turn and one at three turns. The guard therefore places one- and two-turn work on the continuation side. Two turns was inferred as the boundary between modeled one- and three-turn cases; no live two-turn break-even experiment was run.

The grids cannot establish a universal break-even point. Their result depends on the project's prompt seed, episode size, cache state, input and cache-write prices, expected output, and the accuracy of the orchestrator's turn estimate. They also optimize one dispatch rather than the permanent context growth of a whole work stream.

## Implemented choice mechanism

Unless a paragraph carries another label, every figure in this section is an **implemented constant**.

Slate divides thread choice between the orchestrator and the `thread` tool. The orchestrator retains every semantic decision.

The orchestrator chooses the work stream, thread, model, effort, task, and required context. It also decides whether episodes can replace the live transcript.

The tool makes one narrow economic judgement. It decides whether continuing the named thread costs more than a fresh thread seeded with named episodes.

A blanket refusal of a thread restart has a price. Refuse a restart only when the next action depends on context from the previous action that the thread's episodes do not carry. The orchestrator can apply this test because it reads those episodes before choosing the successor's context.

Episodes carry published findings, approved decisions, named file paths, and recorded verification results. They do not carry unrecorded intermediate reasoning, unpublished terminal output, or conversational details omitted during compression. Continue the live thread when the next action needs one of those missing details. Permit a restart when the published episode contains the context needed to act.

### Permission through `freshContext`

The `freshContext` contract asks three separate questions:

1. **Presence:** a continuation requires the argument only when `threadChoice.act` is `true`.
2. **Validity:** every supplied value is validated on every call.
3. **Delivery:** every continuation delivers a supplied valid value to the planner. Creation has no planner, so it delivers nothing.

The twelve distinct combinations follow. Creation has one behavior for both acting settings, so its four input rows cover acting off and on.

| call | acting | input | result |
| --- | --- | --- | --- |
| create | off or on | omitted | accepted, with nothing delivered |
| create | off or on | malformed | tool error before creation or mutation |
| create | off or on | `[]` | accepted and unused |
| create | off or on | non-empty list | accepted and unused if every id names an existing episode, otherwise a tool error |
| continue | off | omitted | accepted, with no permission delivered to the planner |
| continue | off | malformed | tool error before mutation |
| continue | off | `[]` | accepted, with an explicit refusal delivered to the planner |
| continue | off | non-empty list | permission and seed episodes reach the planner if every id exists, otherwise a tool error |
| continue | on | omitted | tool error before mutation |
| continue | on | malformed | tool error before mutation |
| continue | on | `[]` | accepted, with an explicit refusal delivered to the planner |
| continue | on | non-empty list | permission and seed episodes reach the planner if every id exists, otherwise a tool error |

A valid array stays within the size limit and contains only strings. Slate never treats missing permission as consent. Slate also does not judge whether the named episodes preserve enough meaning. The orchestrator must make that judgement.

### Planner verdicts and order

The planner returns one of four verdicts:

- `continue` keeps the named thread.
- `fresh` says the fresh option costs less.
- `abstain` says the available inputs cannot support a choice.
- `refused` says a rule forbids a fresh thread.

Every verdict carries a machine code and a human-readable reason. Priced verdicts include both arm estimates and their warmth evidence.

The planner evaluates refusals before cache evidence or prices. Missing permission, unusable tools, and a failed last dispatch can forbid a fresh thread. The dispatch boundary rejects malformed or unknown episodes before the planner runs.

A dispatch without a source thread starts a new work stream. No comparison is needed because no existing prefix can be reused.

The pure planner keeps work of one or two turns on the named thread. The current dispatch caller estimates at least three turns from work-stream depth.

The doctrine therefore uses an empty `freshContext` for one-turn or two-turn work. It also uses an empty value when the live transcript is required.

For longer work, the planner prices both arms over every expected turn. It charges the fresh arm one extra rediscovery turn.

Input, cache-read, and cache-write buckets remain disjoint. Long-context billing applies independently to each arm at the exact threshold.

**Documented provider price:** the dated current rows produce a cache-write to cache-read ratio of **12.5**. A false cold estimate can therefore destroy a valuable warm prefix.

A tie continues the named thread. Uncertainty never becomes permission to destroy a warm prefix.

### Reporting, acting, and lineage

Configure the feature under `threadChoice` in the project's `.pi/slate.json` file. This example reports choices and enables automatic restarts:

```json
{
  "threadChoice": {
    "report": true,
    "act": true
  }
}
```

**Implemented constants:** `threadChoice.report` defaults to `true`, while `threadChoice.act` defaults to `false`. The default therefore reports the verdict without moving work. Only a `fresh` verdict can move work when acting is enabled.

Acting adds semantic refusals after the economic verdict. Reviewer and adversarial threads keep their live review transcripts.

A successor with no episode of its own cannot restart again. It must publish new evidence before another restart.

Slate writes the successor and restart lineage before the successor publishes an episode. The source record names the successor through `supersededBy`.

A later dispatch to the superseded source is a tool error. The error names the successor that must continue the work stream.

A restart carries the source thread's type, tools, and base route. The named `freshContext` episodes become the successor's injected context.

A restart has an explicit commit point. The commit point occurs when the successor's worker session starts executing its prompt.

Before the commit point, an abort or failure removes the successor and restores the source. A failure then runs the action on the source. An abort ends the action without running it again.

At or after the commit point, an abort or failure never rolls the restart back. The successor keeps its lineage, and Slate reports the action outcome on that successor. Slate never repeats the committed action on the source.

### Missing and stale evidence

The planner abstains rather than guessing when missing or stale evidence prevents honest pricing.

**Implemented constant:** the dispatch path accepts documented and measured retention evidence for 90 days. Older retention rows grant no retention window.

Documented retention comes from provider sources with retrieval dates. Measured retention comes from dated local probes listed in the model profiles.

Missing retention data does not prove expiry. The planner treats an unchanged route as warm when retention or elapsed time is unknown.

An unknown shared-seed cache state is priced as a write. This conservative assumption makes a fresh thread look no cheaper than the evidence supports.

The planner abstains when required prices or sizes are unavailable. Required sizes include the existing prefix, fresh seed, and named episodes.

A failed episode write makes the live session newer than its durable measurements. The next choice drops those stale measurements and abstains.

Do not preserve warmth by choosing a model or effort that cannot clear the action. Cache savings never justify lower required capability.

## Cache-key sharding experiment

**Measured probe, 2026-08-06.** A controlled experiment tested the implementation as shipped in this branch on the OpenAI `gpt-5.6-luna` path. Two arms used distinct long prefixes. Each arm created four worker threads sequentially in one persistent process. Treatment used the default two shards. Control set `cacheKeyEnabled: false`, so Slate installed no shared key.

| measured arm | threads | input tokens | cached tokens | cached/input | worker cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| two-shard treatment | 4 | 119,124 | 59,496 | 0.499 | $0.01612032 |
| disabled control | 4 | 119,116 | 0 | 0.000 | $0.02980240 |

**Measured probe:** worker cost fell 45.91%. All-in cost was $0.04249825 for treatment and $0.05489782 for control, or $0.09739607 across both arms.

The per-thread pattern is evidence that the provider path honors the key. The first thread on each treatment shard wrote its full prefix. The later thread on the same shard read 29,748 cached tokens. Threads with identical prefixes but different shard keys did not share cache. That pattern is inconsistent with a provider ignoring the key.

The experiment is thin: four threads per arm. Treatment ran before control. Traffic passed through a local proxy, so attribution to the upstream provider is indirect. The run covers only the first dispatch. It does not cover long conversations, retention expiry, compaction, other models, other providers, or high request rates. This result supersedes every earlier cache-key measurement in the pull request record.

## Limits and refresh conditions

Re-measure each claim when its inputs can have changed:

- **Cold transitions:** repeat controlled model and effort arms after a provider changes cache semantics, pi changes request construction, Slate changes route application, or a new model family becomes supported. A future model-change run should include controlled samples from both provider families because the current model evidence is one OpenAI event.
- **Rediscovery:** repeat controlled pairs across several task shapes, model families, and repository sizes. Replace the one-turn charge only after the distribution is stable enough to support another policy.
- **Two-turn guard and prices:** regenerate the grids after material changes to prompt-seed size, episode construction, provider prices, cache-write behavior, cache-key behavior, compaction, or supported model families. Validate the inferred two-turn boundary with live two-turn actions when possible. Price rows have no automatic age check, so review their provider sources whenever this projection is refreshed.
- **Cache-key sharding:** repeat with more threads and randomized arm order after changes to key derivation, shard assignment, the disable switch, the local proxy, the OpenAI API path, or provider cache policy. Add continuation, expiry, and compaction arms before applying the first-dispatch result to those cases.

This document describes decision inputs. The provider's reported usage remains the authority for the cost that actually occurred.
