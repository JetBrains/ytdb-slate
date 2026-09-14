# Model-router research provenance and refresh procedure

This directory is the research record for Slate's static model profiles. Slate does not read it at runtime and the package does not ship it. The profile table is the shipped runtime data. This corpus explains the evidence and the decisions behind that table.

## Generation ownership and archive index

The active generation is **v6**. It supersedes v1 through v5 and supplies the current profile basis.

| path | role | state |
| --- | --- | --- |
| `digest-v6.md` | current digest and profile basis | active |
| `openai.md` | current OpenAI source report | active |
| `anthropic.md` | current Anthropic source report | active |
| `gaps.md` | current cross-source reconciliation | active |
| `README.md` | this procedure and archive index | active |
| `digest-v5.md` | labelled historical archive edition | archived and inactive |

`digest-v6.md` is the only active digest. The archived v5 edition does not modify it. Generations v1 through v4 are unavailable. This project does not reconstruct them from Git history or another source. The presence of an older Git object does not make an unavailable generation available.

The archived v5 edition is a project-authored historical record. It is not a byte-identical copy of the original v5 blob. The exact original remains recoverable from Git for comparison only:

- path commit: `23918af72efbaf273868ac6d9841039caa100d78`
- original v5 blob: `accbbb37983654ef04723ef76d175d94fa52eb04`
- original size: 72,756 bytes and 776 lines
- original SHA-256: `70faa72816e11abf8177a467c270b244201c77c2cd41e42598cac467c6aee6c3`.

The original companion source objects at that commit are:

| trace family | historical path | blob |
| --- | --- | --- |
| `O*` | `research/openai.md` | `65b50807ca2fc99cc1ec4c643676cf7c76534b98` |
| `A*` | `research/anthropic.md` | `139dc1c4db5c4452069496d2cb55cbba5a022062` |
| `G*`, `GM*` | `research/gaps.md` | `c6b2424f3c82c70d3658db0e8a46f91f72e8a0d9` |

Every `O*`, `A*`, `G*` and `GM*` key in the archived edition resolves against those historical companion files. A reader must not resolve an archived key against the current file at the same path. `RI*` keys identify audit findings in the historical digest. `arb` identifies a project calculation. `contract` and `registry` identify project or runtime contracts. They are not source-file trace keys.

## Vocabulary and evidence boundary

Pi calls the dispatch control a thinking level. This corpus calls it an effort level. Both use `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, subject to each model's traced ladder.

A **measured effort** has a model-specific numerical quality result. Accuracy, resolve rate, F1, Elo, and a composite capability index qualify. Cost, token count, turn count, latency, registry presence, vendor prose without a number, and a provisional estimate do not qualify. `UNKNOWN` is a valid result. A plausible guess is not evidence.

A source class is either `V` for vendor-published or `I` for independently measured. Keep the class beside each result. Keep provider and deployment labels beside benchmark results because two deployments are not interchangeable.

The pi model registry is authoritative for runtime availability, context, and provider-qualified input and output rates. Corpus capacity values are documentation cross-checks. A billing threshold is not a capacity value.

## Source-use and licensing policy

The project may cite a publication without treating the publication as redistributable. The project approved this six-rule policy on 2026-09-10. This date records project approval, not publisher permission. The DeepSWE public trial file remains outside this repository. The policy has six rules:

1. Cite a publication with attribution, version, and retrieval date whatever its licence status.
2. Transcribe an individual figure as a fact. Record its source, version, and date beside the figure.
3. Copy no publisher table structure and no publisher prose into a project file.
4. Commit no downloaded data file and ship no downloaded data file.
5. Publish a computed summary with its method. Do not publish raw rows.
6. Respect a stated term of use when one exists. An absent terms page does not create a term or grant publication permission.

A source identifies evidence. It does not grant permission. The licensing review must inspect copied or adapted language, table arrangement, raw-data handling, trademarks, and stated source conditions. A citation alone does not close that review.

## Future refresh procedure

This procedure applies to a future evidence refresh or model addition. It is a procedure, not a runtime framework. It creates no automatic model selector and it assumes no fixed number of models.

### 1. Freeze the boundary

Record the active digest commit, every companion source commit, the project profile-table commit, and the observation date before research starts. Name the models and files in scope. State whether the action adds a model, refreshes a field, removes a claim, or creates a successor generation.

Keep the active digest immutable during the refresh. Build a successor digest when the active generation changes. Do not edit an active generation to repair historical evidence. Keep an archival edition separate from the active generation.

### 2. Record each observation

Every future record carries these fields when they apply:

- observation date and source retrieval date.
- source class, publication or dataset version, and source key.
- canonical model identifier and provider.
- deployment, endpoint, region, adapter, or fallback condition.
- exact effort level and the provider control that it represents.
- harness, software version, prompt or task set, sample size, and scoring method.
- score meaning, unit, denominator, uncertainty, and exclusions.
- dated cost, price tier, currency, and whether the cost is measured, listed, or expected.
- context and output units, with capacity separated from billing.
- limitations, conflicts, and unknown values.

A source record must say whether a number is a score, a rate, a token count, a duration, a cost, a capacity, or a registry fact. Do not use one unit as another unit. Keep the exact effort label. A model-level result does not become a benchmark-level effort result unless the source states that mapping.

### 3. Resolve dated conflicts

The later effective date wins first when two otherwise comparable records conflict about the same claim. Do not treat records for different models, benchmark versions, deployments, harnesses, or effort levels as one claim. Record both values, both effective dates, and the reason for the choice. Retrieval date does not replace an effective date. If effective dates are equal or absent, prefer `I` for independently measured evidence over `V` for vendor-published evidence when the comparable claims genuinely conflict. If records from the same source class still conflict, publish `UNKNOWN`, retain both values, and retain the conflict record.

A future record must distinguish a current value, a scheduled future value, a historical value, and a value whose date is unknown. Runtime registry rates remain runtime facts. Static research cost values must carry their observation date and price basis.

### 4. Reconcile source forms

When a source provides a machine-readable record and a rendered page, compare them before writing the digest. Record the source version and effective date for both forms. Explain any difference. Use the selected figure in the digest only after the reconciliation.

Do not commit or ship a downloaded source file. Do not paste raw rows into the corpus. Store only attributed facts and computed summaries with the method that produced them. A raw source file may remain outside the repository for temporary analysis.

### 5. Compare every profile field

Compare every future profile record with the digest, the companion source reports (`openai.md` and `anthropic.md`), and the cross-source reconciliation record (`gaps.md`). The comparison covers canonical identifiers, aliases, provider and deployment, effort ladder, rejected controls, measured levels, evidence gaps, context, output, cache facts, price facts, tier status, guidance, hazards, limitations, and unknowns. A roster is discovered from the records. The procedure never assumes a hard model count.

A field that has no supporting source remains `UNKNOWN` or uses an explicit project-policy label. Do not convert missing evidence into a low capability judgment. Do not transfer a result across a provider, deployment, alias, fallback path, or effort level without evidence.

### 6. Write guidance cells

Each guidance cell or equivalent record states all applicable items:

- a supported result and its source key.
- the exact effort and deployment for that result.
- the dated cost and its price basis when cost informs the guidance.
- a capability tip stated as a bounded task or work class.
- limitations, uncertainty, and the evidence boundary.
- the distinction between project policy and publisher permission.

A recommended effort must be measured under the corpus predicate. An unmeasured but valid effort may remain dispatchable with a warning when runtime policy permits it. It must not become a default or recommendation without evidence. A claim removal must leave either a typed reason and an `UNKNOWN` result or a replacement summary with its source.

### 7. Record claim removal

Record every removed claim with a typed reason. Permitted reasons include unsupported, superseded, conflicting, stale, outside scope, duplicate, prohibited source material, unresolved licence concern, or incompatible deployment. Record the historical location, factual purpose, replacement summary, retained source key, and review state. Do not repeat removed external prose in the ledger.

For an archival edition, compare the edition with the exact historical blob. Enumerate every changed hunk. Give each hunk one ledger entry. The ledger may live inside the edition. A wrapper, archive index, or ledger addition gets one structural entry that covers that addition. The structural entry does not recurse into its own ledger rows.

### 8. Separate source review from contract checks

An independent source review asks whether the cited source supports the fact, model, effort, deployment, date, unit, method, and limitation. It also checks whether a rewrite preserves factual scope.

A contract check asks whether the profile shape, identifier set, effort vocabulary, rejected set, rendered form, and status vocabulary remain exact. A contract check does not prove source fidelity. Source review does not replace a contract check. Keep the two results separate in the report.

### 9. Add future canaries and render budgets

A later refresh should add a deliberate mutation canary for every model record and each sensitive guidance rule. The canary must fail when a field is changed to an invalid value. A later refresh should render the largest supported fixtures and retain the documented character and line reserve.

These canaries and render budgets are future procedure steps. The repository contains no checker, test, runtime machinery, or new budget gate for them. A procedure description must not be reported as an automated proof until the machinery exists and its own tests pass.

### 10. Keep pull request status fixed

Use only these track-row statuses in the pull request description:

- `Planned` means the track has not reached user acceptance.
- `Awaiting user review` means the implementation boundary is complete and the user review is blocking.
- `Accepted` means the user accepted the track and its requested fixes.

Use the pull request lifecycle state separately. `Draft` and `Ready for review` describe the umbrella pull request, not a track row. Do not replace the track statuses with synonyms. Keep the status consistent with the research log, marker boundary, and actual user decision.

## What the current checks prove

The resolver checks prove selected profile structure, lookup, effort coverage, rendering, and frozen values. They do not prove that a source says what the corpus claims. The independent source review is the source-fidelity gate.

The current generation is not refreshed by this procedure. This document covers the labelled v5 archival edition and the refresh procedure only. It does not edit v6, add a current model, transcribe a current profile, add a test or checker, change runtime behavior, alter configuration, or begin a separate generation.

## Publication boundary

The research directory remains outside the package `files` whitelist. Consumers receive the profile table and its observation date, not this corpus. A future change that publishes research documents requires a separate packaging and licensing decision.
