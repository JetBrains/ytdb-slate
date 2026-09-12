# Model-router research provenance

This directory is the source record for Slate's static model profiles. It is not read at runtime and does not ship in the package.

## Active generation

Exactly five files form the active generation:

| file | role |
| --- | --- |
| `digest-v6.md` | canonical reduction and profile transcription |
| `openai.md` | refreshed OpenAI source report |
| `anthropic.md` | refreshed Anthropic source report |
| `gaps.md` | cross-source reconciliation and the Gemini, Astra, and Fable 5.1 profile basis |
| `README.md` | lifecycle and refresh procedure |

Read `digest-v6.md` first. It supersedes v1 through v5. Git history is the archive. A superseded digest is deleted when its successor is added. The `SUPERSEDES` header and retained finding summary preserve the chain of custody.

## Vocabulary

Pi calls the dispatch control a thinking level. This corpus calls it an effort level. Both mean `off | minimal | low | medium | high | xhigh | max`, limited by each model's traced ladder.

The **profile table** is the shipped static data in `extension/model-profiles.ts`. The **routing table** is the model-visible table rendered from configured candidates. The profile table supplies guidance to the routing table. It does not select a model.

`UNKNOWN` is a valid result. A plausible guess is not evidence.

## Tracing rule

Every numerical capability claim names its source, model, exact effort, harness, version, and date when those labels exist. A measured effort requires numerical model-specific quality. Accuracy, resolve rate, F1, Elo, and a composite capability index qualify. Cost, tokens, latency, turns, registry presence, vendor prose, and provisional estimates do not.

Source classes are vendor-published and independently measured. The later effective date wins a conflict. Source class breaks a tie only when dates are equal or absent. Keep both dated values in the conflict record.

Pi's model registry is the runtime authority for model availability, context, and exact provider-qualified input and output rates. Corpus limits are documentation-only cross-checks. A billing threshold must never be restated as capacity.

## Source-use policy

The policy approved on 2026-09-10 permits attributed facts and computed summaries with their methods. It forbids copying publisher prose, copying publisher table arrangement, and committing or shipping downloaded raw data. The DeepSWE public trial file remains outside this repository.

## Observation date

The active generation was observed on **2026-09-11**. Every profile carries that date. Historical cache probes retain their actual 2026-08-06 measurement date.

Find provenance dates by content rather than by a fixed path list:

```sh
git grep -nE '2026.{0,3}09.{0,3}11'
```

Fixture dates under `verification/` can be fabricated test inputs. Judge each result by path and purpose.

## Refresh procedure

1. Re-run the source research for every surviving field.
2. Build a new canonical digest generation and delete the old digest in the same commit.
3. Ask an independent fresh-context reviewer to re-fetch every routing-critical value.
4. Transcribe every shipped profile field and move the common observation date.
5. Run the automated checks and re-render every doctrine measurement.
6. Review routing consequences by hand.

The implementation has seven work units, not a seventh procedure step. OpenAI research, Anthropic research, and cross-source reconciliation all implement step 1. Digest generation, profile transcription, automated verification, and manual routing review implement steps 2, 4, 5, and 6. Step 3 occurs after the integrated candidate and remains independent.

## What checks prove

Resolver checks prove structure, lookup, ladder coverage, freezing, rendering, and selected exact values. They do not prove that a source says what the corpus claims. The independent retrace in step 3 is the only source-fidelity gate.

A wrong tier, hazard, evidence sentence, or consistently moved date can remain structurally valid. Review those fields against the digest. Do not add an automatic corpus-to-profile comparison. The Track 5 field comparison covers Gemini, Astra, and Fable 5.1.

## Publication boundary

`research/` remains outside the package `files` whitelist. Consumers receive the profile table and its observation date, not the research corpus.
