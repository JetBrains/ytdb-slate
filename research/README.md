# Model-router research provenance

This directory holds the research corpus behind the action-level model
router's static model-profile table. It is provenance, not
documentation: no file here is read at runtime, and none of it is
published with the package. The shipped profile table was transcribed
from these files by hand, so this directory is where a claim in that
table is checked. When a reviewer asks "where does this number come
from?", the answer is in these four files.

Scope note, because it changes what the claims below can mean: at this
commit the router is a **data layer plus a pure resolver**. Its
configuration is validated at session start, so a bad model list warns
there; but nothing calls the resolver. The dispatch-time behaviour it is
built for — enforcing the configured model list on a dispatch, acting on
an evidence-gap verdict, and the routing section the orchestrator's
doctrine will carry — is **Track 02**, not yet written. User-facing
documentation of the feature is **Track 03**. Where a passage below has
to describe behaviour that does not exist yet, it says which track
delivers it.

## Vocabulary

pi calls the reasoning knob a **thinking level** (the `ThinkingLevel`
type, the `defaultThinkingLevel` setting). The research corpus and
these files call the same knob an **effort level**, and pi's ladder —
`off | minimal | low | medium | high | xhigh | max`, digest §V — is
that one scale under both names. This directory says *effort*
throughout; read it as pi's thinking level with no shift in meaning.

Vendor spellings are not part of that ladder: the lowest OpenAI knob
value is pi's `off`, the abbreviation `med` never appears, and "ultra"
— which `openai.md` §6 prints alongside effort levels — is a product
beta, not a rung on pi's ladder. The primary reports predate that
convention and use their vendors' own spellings — see the canonicity
caveat below.

## The files

| File | What it is |
| --- | --- |
| `digest-v5.md` | The **canonical digest** — the single artifact the shipped profile table is derived from. Carries Artifact A (per-model machine-readable profile fields), Artifact B (the routing table), Artifact C (one discriminating evidence one-liner per model), §D router-relevant hazards, §E the out-of-scope cheap tier, §H the significance ledger, and §G/§I the adjudications of every cross-source conflict and audit finding. |
| `gaps.md` | The **verification pass** over the primary reports: gap-filling by raw-payload extraction, spot-verification of the routing-critical numbers, and the mismatch list (`M1`–`M12`) that the digest adjudicates in §G. |
| `openai.md` | Primary research report — the three `openai/gpt-5.6-*` variants. |
| `anthropic.md` | Primary research report — the three `anthropic/claude-*-5` models. |

Read `digest-v5.md` first. The other three are its sources, and the
digest's trace keys (`O2`, `A4b`, `G1a`, `G2#7`, …) resolve into their
numbered sections — the key table at the top of the digest maps every
key in both directions.

### Only the digest is canonical — for numbers *and* for advice

All four files are copied **verbatim**. The two primary reports were
written before the verification pass and the three adversarial audits
that produced the digest, so they retain material the digest has since
overturned. That is deliberate — the audit trail is worth more than a
tidy corpus — but it means **nothing may be quoted out of `openai.md`
or `anthropic.md` without checking the digest first**. Three distinct
kinds of staleness, not just wrong numbers:

- **Superseded numbers.** `gaps.md` re-read the primary sources and
  found twelve mismatches (`M1`–`M12`), including a **fabricated**
  benchmark rank; the digest adjudicates each one in §G. A number
  straight out of a primary report may be one of those twelve.
- **Superseded recommendations.** Both reports end in routing advice
  of their own — `openai.md` §6 (including its "Router summary line")
  and `anthropic.md` §8 ("Suggested routing table") — and that advice
  is **not** the shipped routing policy. Examples, not an exhaustive
  list: `openai.md` §6 keeps a long-context niche for
  `openai/gpt-5.6-terra`, which the digest destroys (§H row 10 — a
  cheap-tier model ties terra on its one positive result — leaving
  terra outside the tier ordering and never auto-selected); it also
  carries a "long context collapses" hard stop for
  `openai/gpt-5.6-luna` that `gaps.md` M8 shows to be true only of
  multi-needle retrieval, not of long-context reasoning;
  `anthropic.md` §8 routes trivial edits to `anthropic/claude-sonnet-5`,
  which the digest marks non-preferred. **Artifact B is the routing
  policy**; §6 and §8 are historical inputs to it.
- **Superseded vocabulary.** The primary reports use vendor effort
  spellings the digest bans — `anthropic.md` §2 and §4a use `med`,
  `openai.md` §6 uses `none` and `ultra`. Translate through §V before
  reusing any effort label from them.

The rule, in one line: **`digest-v5.md` wins over `gaps.md`, and both
win over the primary reports, on every axis — figures, routing advice,
and terminology.**

## digest-v5 supersedes v1–v4

Five digest generations were written; only the fifth is canonical.

The revision chain is not tidying. Each round was an independent
adversarial audit that found substantive errors in the round before:

- **v1 carried a fabricated benchmark rank** — a LiveCodeBench
  standing of `#33/131` for `openai/gpt-5.6-luna` that appears in no
  source. It was invented in `openai.md` §4.2 and propagated
  unchallenged into the digest. The model has no LiveCodeBench entry
  at all (`gaps.md` M1). This is the single reason the tracing rule
  below exists.
- **v4 fabricated a capacity limit** by restating a number that
  appears in its source only inside a pricing row (`272,000`, a
  long-context **billing** threshold on input tokens) as a context
  window, then deriving usable-token figures and a routing rule from
  it. v3 had the window right; v4 regressed.

Both classes of error were invisible to a reader who trusted the
prose. Only a source-by-source re-read caught them.

### Generation lifecycle — one digest at a time

The repo keeps **exactly one digest generation**: the canonical one.
`digest.md` and `digest-v2.md` – `digest-v4.md` were never committed,
which is why the canonical file's internal references to them resolve
to nothing — read those as historical notes, not links. Git history is
the archive; a superseded digest is deleted in the same commit that
adds its successor, and is not restored, mirrored, or copied into an
`archive/` subdirectory.

What must survive a supersession is the **`SUPERSEDES` header** at the
top of the canonical digest, naming every generation before it, and the
per-finding dispositions that say what each audit changed. Those two
things are the chain of custody; the superseded files themselves are
not.

## The tracing rule

> **Every number carries an inline trace to a source file and
> section. A number that cannot be traced is DELETED and its field is
> set to `UNKNOWN`. Nothing is estimated, interpolated, or imported
> from outside the corpus.**

Three corollaries the digest enforces:

- Every benchmark value names its **harness** and its **effort
  level**, or says `UNKNOWN` for them.
- Every comparison used to place a model in a tier carries a
  significance verdict (`SIG` / `NS` / `UNDETERMINED` / not
  computable), computed from the traced ± figures (§H).
- **A figure that appears in a source only inside a pricing row is a
  billing figure** and may never be restated as a capacity, a limit,
  or a default — the standing lesson from the v4 regression.

`UNKNOWN` is a first-class, shippable value here. A profile field that
says `UNKNOWN` is more useful than a plausible guess: the shipped table
records the absence rather than a zero, and the resolver warns by name
when a routing-critical field is missing.

## Why this is the provenance for `asOf`

The shipped profile table carries an `asOf` date. That date is the date
this corpus was observed, not the date the code was written: the digest
records prices and specs as observed in force on **2026-07-29**, and
`gaps.md` records its verification pass on the same day. The table's
numbers are a snapshot of what these four files say, and `asOf` is the
reader's warning about how stale that snapshot may be.

Two directions, both binding. Any change to a shipped profile number
must be traceable to a change in this directory; and any change here
must move `asOf` everywhere it is stated. Those places, as of this
commit:

- the module-wide `PROFILES_AS_OF` constant in the profile module;
- the per-profile `asOf` field — **nine** profiles today, so nine
  edits, and they must not drift apart from the constant;
- the prose in that module's header comment, which states the date in
  words as well;
- the digest's own `observedInForceOn` rows (one per Artifact A model —
  six, since the three cheap-tier models of §E carry no such row) plus
  its revision date;
- the date in this README;
- any user-facing document that quotes the date (Track 03 owns those;
  none exists at this commit).

Grep the repository for the literal date before declaring a refresh
done — that is the only reliable enumeration, since this list ages.

## Not published

This directory is deliberately **outside** the `files` whitelist in
`package.json`, alongside `issues/` and `verification/`. Consumers
install a profile table with an `asOf` date; they do not install ~1700
lines of benchmark tables, adversarial-audit dispositions and
significance arithmetic. Do not add `research` to that whitelist — the
whitelist is what keeps the published tarball to the extension, the
doctrine docs, the README and the licence.

The trade-off is accepted: the provenance lives in the repository, so
it is one `git clone` away from any consumer who wants to audit a
number, and zero bytes for everyone else.

## Refresh procedure

The model landscape moves; this corpus does not. When it goes stale — a
new model, a price change, a withdrawn benchmark, or an `asOf` date old
enough to be untrustworthy — refresh it as a whole, in this order.

1. **Re-run the research.** Regenerate the primary reports from vendor
   and independent sources. Keep the structure and the section
   numbering, so the digest's trace keys still resolve.
2. **Re-derive the digest.** Rebuild Artifacts A, B and C from the new
   reports under the tracing rule, as a new generation
   (`digest-v6.md`, superseding v5), and delete the file it supersedes
   in the same commit per the lifecycle rule above. Do not patch the
   old digest in place: a partial refresh mixes observation dates
   inside one table, and there is then no honest `asOf` to write.
3. **Re-verify with an independent adversarial pass.** A fresh
   context, not the thread that wrote the digest, re-reads every
   routing-critical number against its cited source. Both fabrications
   above survived a self-review and died in an independent one; this
   step is the one that cannot be skipped.
4. **Re-transcribe the profile table and move `asOf`.** Update the
   shipped table from the new digest — field by field, re-tracing each
   one; a transcription is not a merge — and set the date at every
   site listed under `asOf` above.
5. **Re-run the automated checks, knowing what they can and cannot
   tell you.** `bash verification/run-resolver-checks.sh --repo .`
   (needs `pi` and `node` on `PATH`; one line per check, exit 0 = all
   passed).
6. **Re-review the routing consequences by hand.** A refreshed number
   can move a tier, a `nonPreferred` marker, or the cheapest
   candidate, and no check in the repo has an opinion about whether
   the new placement is right. Diff the new profile table against the
   old one and argue each changed field.

### What the checks prove about a refresh — and what they do not

Do not read a green run as validation of refreshed research. The
harness has two kinds of check and neither one can see a wrong number:

- **Resolver checks** exercise the router's logic — candidate
  filtering, ordering, the cheapest pick, the window cross-check, the
  unknown-field and failover-coverage warnings, the effort predicate,
  memoization. Every one of them **injects its own registry and its own
  profile table**, so they never read the shipped data at all; they
  depend on the profile module only insofar as it must load. A refresh
  that replaced every price with nonsense would leave them all green.
- **Structural checks over the shipped table**, being added by the
  harness track alongside this change, assert refresh-proof shape
  invariants over the real data: ladder coverage (every measured or
  gap effort level lies on the model's own declared ladder), price-row
  ordering, alias uniqueness against every id and alias in the table,
  and `asOf` consistency with `PROFILES_AS_OF`. Refresh-proof means
  they are invariants no correct refresh can violate, so they need no
  editing when the numbers change. These do catch the mechanical
  damage a hurried refresh causes: a level misspelled, a price row
  inserted out of order, a duplicated alias, a date moved in eight
  places out of nine. Consult the harness's own documentation for the
  authoritative list — that track owns it, not this directory.

So: structure yes, research numbers no. **No check in this repository
can tell you that a figure in the shipped table is what the source
says.** Only step 3's independent re-trace can, and that is a judgement
made by a human or a fresh context, not a test. Treat the checks as
protection against slips in step 4, and step 3 as the only protection
against a wrong or invented number.

---

Committing this directory, and keeping the profile table traceable to
it, is decision **D25** of the model-router change's design review.
Decision ids in this repository are per-change: slate's older ExecPlan
ids reuse some of the same numbers for unrelated decisions, so cite
them with their change, as here.
