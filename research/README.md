# Model-router research provenance

This directory holds the research corpus behind the action-level model
router's static model-profile table. It is provenance, not
documentation: no file here is read at runtime, and none of it is
published with the package. The shipped profile table was transcribed
from these files by hand, so this directory is where a claim in that
table is checked. When a reviewer asks "where does this number come
from?", the answer is in these four files.

Historical scope note: this corpus was written during the action-level
model-router change. In that change, **Track 02** added dispatch-time
behavior and the orchestrator's routing doctrine. **Track 03** added the
router's user documentation. Both tracks have shipped. Those labels do
not refer to track numbers in later changes.

## Vocabulary

pi calls the knob a **thinking level** (the `ThinkingLevel` type, the
`defaultThinkingLevel` setting). The research corpus and these files
call the same knob an **effort level**, and pi's ladder —
`off | minimal | low | medium | high | xhigh | max`, digest §V — is
that one scale under both names. This directory says *effort*
throughout; read it as pi's thinking level with no shift in meaning.
Nothing here is called a "reasoning level": that is a third name for the
same thing and this repository does not use it.

Two more terms that are **not** synonyms, though both are tables of
models:

- the **profile table** is the shipped data — one row per model, with
  prices, tier, ladder, hazards and `asOf`. It is what this corpus is
  provenance for.
- the **routing table** is the digest's Artifact B — which task classes
  go where, what is never a default pick, and the numbered policy lines
  that qualify both. It is advice derived from the profile data, not the
  data itself.

When this README says a number is traceable it means the profile table;
when it says the digest's advice supersedes a report's advice it means
the routing table. Those two names are the only ones used for the two
things, here and in the GitHub issue tracker.

Vendor spellings are not part of pi's ladder: the lowest OpenAI knob
value is pi's `off`, the abbreviation `med` never appears, and "ultra"
— which `openai.md` §6 prints alongside effort levels — is a product
beta, not a rung on pi's ladder. The primary reports predate that
convention and use their vendors' own spellings — see the canonicity
caveat below.

## The files

| File | What it is |
| --- | --- |
| `digest-v5.md` | The **canonical digest** — the single artifact the shipped profile table is derived from. Carries Artifact A (per-model machine-readable profile fields), Artifact B (the routing table), Artifact C (one discriminating evidence one-liner per model), §D router-relevant hazards, §E the out-of-scope cheap tier, §H the significance ledger, and §G/§I the adjudications of every cross-source conflict and audit finding. |
| `gaps.md` | The **verification pass** over the primary reports: gap-filling by raw-payload extraction (its GOAL 1a–1f sections), spot-verification of the routing-critical numbers (GOAL 2) with the mismatch list `M1`–`M12` that the digest adjudicates in §G, and **GOAL 3**, the cheap-tier coverage check — the sole source of every `[G3]`-tagged figure in the digest and in the shipped table, including the three out-of-scope cheap-tier models and `anthropic/claude-haiku-4-5`'s cache prices. |
| `openai.md` | Primary research report — the three `openai/gpt-5.6-*` variants. |
| `anthropic.md` | Primary research report — the three `anthropic/claude-*-5` models. |

Read `digest-v5.md` first. The other three are its sources, and the
digest's trace keys (`O2`, `A4b`, `G1a`, `G2#7`, …) resolve into their
numbered sections — the key table at the top of the digest maps every
key in both directions.

### The digest is canonical — for numbers *and* for advice

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
  and `anthropic.md` §8 ("Suggested routing table") — and that advice is
  **not** current guidance. Examples, not an exhaustive list:
  `openai.md` §6 keeps a long-context niche for
  `openai/gpt-5.6-terra`, which the digest destroys (§H row 10 — a
  cheap-tier model ties terra on its one positive result — leaving
  terra outside the tier ordering and never auto-selected); it also
  carries a "long context collapses" hard stop for
  `openai/gpt-5.6-luna` that `gaps.md` M8 shows to be true only of
  multi-needle retrieval, not of long-context reasoning;
  `anthropic.md` §8 routes trivial edits to `anthropic/claude-sonnet-5`,
  which the digest marks non-preferred. **Artifact B is the routing
  table**; §6 and §8 are historical inputs to it.
- **Superseded vocabulary.** The primary reports use vendor effort
  spellings the digest bans — `anthropic.md` §2 and §4a use `med`,
  `openai.md` §6 uses `none` and `ultra`. Translate through §V before
  reusing any effort label from them.

The rule, in one line: **`digest-v5.md` wins over `gaps.md`, and both
win over the primary reports, on every axis — figures, routing advice,
and terminology.**

### Where the digest abbreviates, its cited source row is the authority

"Canonical" is not the same as "only". The digest is a **reduction** of
the corpus: it carries what a routing decision needs and drops the rest,
so a figure can be present in the source it cites and absent — or
summarised — in the digest. For those figures the digest is not the
authority, because it does not contain them.

So the hierarchy has two levels, not one:

- **For any routing decision** — a tier, a preference, a hazard, an
  effort recommendation, a supersession — the digest is canonical and
  final. Nothing reaches past it.
- **For an underlying figure the digest abbreviates**, the authority is
  **the source row the digest cites** for that field, in `gaps.md`,
  `openai.md` or `anthropic.md`. A transcription into the shipped table
  may legitimately read that row directly, and must trace to it — never
  derive the missing number by arithmetic, and never borrow another
  model's rule.

This is not hypothetical. `anthropic/claude-haiku-4-5`'s two cache-write
prices are published in `gaps.md` GOAL 3, while the digest's §E row
carries only the cache-read figure; the first iteration of the shipped
table read the digest alone, concluded the prices were unpublished, and
recorded that as fact. It was wrong, and the corpus already held the
answer. The profile module's header now states the same rule from the
other side — if the two ever disagree, they are describing one rule and
both should be corrected together.

The boundary that still holds absolutely: reaching past the digest is
allowed only to **retrieve a figure it omits or compresses**, never to
revive a number it overturned or advice it replaced. If the digest
adjudicated the field, §G and §I are the last word.

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

The rule is the digest's own, stated in its §"Tracing rule". Quoted
exactly:

> **Every number carries an inline trace to a source file + section. A
> number that cannot be traced is DELETED and the field set to
> `UNKNOWN`.**

Everything else in this section is a paraphrase of what the digest does
with that rule, not further quotation. In particular "nothing is
estimated, interpolated, or imported from outside the corpus" is a
summary in this README's words — an earlier revision presented it inside
the quotation, which it never was.

Three corollaries the digest enforces, paraphrased from that same
section and from §H:

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
must move the date everywhere it is stated.

**Do not work from a list of those places — find them.** An earlier
revision of this README enumerated them and was wrong within the same
track: a sibling commit added six more date literals to the profile
module the same day. The count moves with every commit that adds a
profile, a comment, or an unknown-field note, so the instruction here is
a command rather than an inventory.

**Search for the digits, not for the punctuation.** `research/openai.md`
writes its date with **non-breaking hyphens** (U+2011, `2026‑07‑29`), so
a plain search for `2026-07-29` silently skips it — which is exactly
how that file went unlisted here for two revisions. Match the
separator instead of assuming it:

```sh
# substitute the CURRENT asOf date's digits; the `.{0,3}` separator
# class matches an ASCII hyphen, a non-breaking hyphen, or none at all
git grep -nE '2026.{0,3}07.{0,3}29'
```

At the time of writing that command reports hits in seven files, and
every hit is one of four kinds. Only the first three are rewritten:

- **The profile module** (`extension/model-profiles.ts`). The
  `PROFILES_AS_OF` constant, the per-profile `asOf` field, and every
  piece of prose that states the date in words — header text, rule
  comments, and the `unknownRoutingCriticalFields` strings that record
  which figure is known only as of that observation date. All of it
  moves together. The check suite's `profiles-meta` fails if the
  constant and the per-profile fields disagree; **nothing checks the
  prose**, which is why it is named here.
- **This directory — all five files.** The digest's revision line and
  its per-model `observedInForceOn` rows; `gaps.md`'s pass date and its
  "read <date>" source note; `anthropic.md`'s "As of" line;
  **`openai.md`'s "Research date" line, the non-breaking-hyphen one**;
  and this README, which states the date once in the paragraph that
  opens this section and twice more in the hyphen warning above. A
  refresh rewrites the four research files wholesale, so they normally
  carry the new date by replacement rather than by editing — but this
  README is hand-edited and is the one most often forgotten. **And one
  place the command cannot show you is the command itself**: its pattern
  holds the date's digits yet does not match its own text, so it will
  never appear in its own output. Update it by hand when the date moves.
- **Anything user-facing that quotes the date.** Update it in the same
  model-router refresh. This was assigned to that change's documentation
  track, not to a later track with the same number.
- **Fixture dates in the check suite — leave these alone.** The harness
  uses the same string as an arbitrary "today" inside fabricated price
  schedules. They are not provenance, and rewriting them can move a
  fixture across a step-change boundary and break a check that was
  testing something else. Judge by path: hits under `verification/` are
  fixtures.

The grep is the enumeration. Any list of line numbers in prose —
including this one, if it grows any — is stale by the next commit. If a
new corpus file arrives with yet another dash variant, widen the
separator class rather than adding a second command.

## Not published

This directory is deliberately **outside** the `files` whitelist in
`package.json`, alongside `verification/`. Consumers
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
   one; a transcription is not a merge — then run the grep under `asOf`
   above and rewrite every provenance hit it finds.
5. **Re-run the automated checks, knowing what they can and cannot
   tell you.** `bash verification/run-resolver-checks.sh --repo .`
   (needs `pi` and `node` on `PATH`; one line per check, a `roster`
   line, exit 0 = all passed; add `--strict` to make a `NOT RUN` fatal).
   Read the next section before believing a green run.
6. **Re-review the routing consequences by hand.** A refreshed number
   can move a tier, a `nonPreferred` marker, or the cheapest
   candidate, and no check in the repo has an opinion about whether
   the new placement is right. Diff the new profile table against the
   old one and argue each changed field.

### What the checks prove about a refresh — and what they do not

Do not read a green run as validation of refreshed research. The suite
has two kinds of check, and the boundary between them is exactly the
boundary of what a refresh can break unnoticed.

- **Resolver checks** exercise the router's logic — candidate
  filtering, ordering, the base-model pick, the window cross-check, the
  unknown-field and failover-coverage warnings, the effort predicate,
  memoization, hostile-input handling. These inject **their own**
  registry and **their own** profile table, so a change to the shipped
  data cannot make them pass or fail. Two deliberate exceptions read the
  real table: `router-shipped-default`, which proves the shipped table
  really is the resolver's default (it takes an id *from* the table, so
  a refresh cannot stale it), and the `profiles-*` block below, whose
  subject **is** the table.
- **Structural checks over the shipped table** (`profiles-*`) assert
  shape and internal consistency, and nothing else. They are the
  refresh-relevant ones, so what they cover is worth knowing precisely:
  every id is a canonical, unique, lower-case `provider/id`; every id
  and alias resolves to its own profile, with no alias shared, shadowing
  an id, or empty; every ladder is a duplicate-free subset of pi's
  effort vocabulary with the measured and gap lists disjoint and exactly
  covering it (the canary for a **mistyped ladder key**, which otherwise
  silently widens a model's ladder); every price schedule is ascending,
  non-overlapping and ISO-dated with positive prices and output ≥ input,
  tier an integer 1–4, and no tier price-inverting against the next one
  up; and `PROFILES_AS_OF` is an ISO date that every profile carries,
  over a deep-frozen table.

What that leaves uncovered is the whole point. **A structurally perfect
table can be entirely wrong.** Each of the following was applied to a
throwaway copy of the table and the whole suite still reported a clean
run — these are measured, not assumed:

- **every price scaled by the same factor** (all of them, ten-fold) —
  the price-inversion invariant is relative, so a uniformly wrong table
  is invisible to it;
- **a single price changed to a well-formed wrong number**;
- **a model's `tier` moved** to another plausible class;
- **an invented hazard clause** added, and **a fabricated `evidence`
  one-liner** substituted — free-text fields are checked for shape,
  never for truth;
- **the date moved consistently everywhere** to a day on which nobody
  observed anything — `profiles-meta` checks agreement, not truth.

Mutate a copy outside the repository, never the repository itself, and
export a clean one (`git archive HEAD`) rather than copying the working
tree — a copy taken while another change is in flight produces failures
that have nothing to do with the mutation.

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
