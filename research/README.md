# Model-router research provenance

This directory holds the research corpus behind the action-level
model router's shipped model-profile table. It is provenance, not
documentation: no file here is read at runtime or published with the
package — the shipped table and the routing rules the doctrine injects
were derived from these files when they were written. When a reviewer
asks "where does this number come from?", the answer is in these four
files.

## The files

| File | What it is |
| --- | --- |
| `digest-v5.md` | The **canonical digest** — the single artifact the shipped profile table is derived from. Carries Artifact A (per-model machine-readable profile fields), Artifact B (the routing table for prompt injection), Artifact C (one discriminating evidence one-liner per model), the router-relevant hazards, the significance ledger, and the adjudications of every cross-source conflict and audit finding. |
| `gaps.md` | The **verification pass** over the primary reports: gap-filling by raw-payload extraction, spot-verification of the routing-critical numbers, and the mismatch list (`M1`–`M12`) that the digest adjudicates. |
| `openai.md` | Primary research report — the three `openai/gpt-5.6-*` variants. |
| `anthropic.md` | Primary research report — the three `anthropic/claude-*-5` models. |

Read `digest-v5.md` first. The other three are its sources, and the
digest's trace keys (`O2`, `A4b`, `G1a`, `G2#7`, …) resolve into their
numbered sections — the key table at the top of the digest maps every
key in both directions.

All four files are copied **verbatim**, including the errors the
digest adjudicates against them. A number read straight out of a
primary report is therefore not necessarily a number the digest
accepts: check the digest's mismatch adjudications and its hazard list
before quoting one. The digest is the only file here whose numbers are
canonical.

## digest-v5 supersedes v1–v4

Five digest revisions exist; only the fifth is canonical. The earlier
four (`digest.md`, `digest-v2.md`, `-v3`, `-v4`) are **not** copied
here, so the digest's internal references to them are historical
notes, not links.

The revision chain is not tidying. Each round was an independent
adversarial audit that found substantive errors in the round before:

- **v1 carried a fabricated benchmark rank** — a LiveCodeBench
  standing of `#33/131` for `openai/gpt-5.6-luna` that appears in no
  source. It was invented in `openai.md` §4.2 and propagated
  unchallenged into the digest. The model has no LiveCodeBench entry
  at all. This is the single reason the tracing rule below exists.
- **v4 fabricated a capacity limit** by restating a number that
  appears in its source only inside a pricing row (`272,000`, a
  long-context **billing** threshold on input tokens) as a context
  window, then deriving usable-token figures and a routing rule from
  it. v3 had the window right; v4 regressed.

Both classes of error were invisible to a reader who trusted the
prose. Only a source-by-source re-read caught them.

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
  computable), computed from the traced ± figures.
- **A figure that appears in a source only inside a pricing row is a
  billing figure** and may never be restated as a capacity, a limit,
  or a default — the standing lesson from the v4 regression.

`UNKNOWN` is a first-class, shippable value here. A profile field
that says `UNKNOWN` is more useful than a plausible guess, because
the router can warn on it.

## Why this is the provenance for `asOf`

The shipped profile table carries an `asOf` date. That date is the
date this corpus was observed, not the date the code was written: the
digest records prices and specs as observed in force on **2026-07-29**
and `gaps.md` records its verification pass on the same day. The
table's numbers are a snapshot of what these four files say, and the
`asOf` date is the reader's warning about how stale that snapshot may
be. Any change to a shipped profile number must be traceable to a
change in this directory, and any change here must move `asOf`.

## Not published

This directory is deliberately **outside** the `files` whitelist in
`package.json`, alongside `issues/` and `verification/`. Consumers
install a profile table with an `asOf` date; they do not install ~1700
lines of benchmark tables, adversarial-audit dispositions and
significance arithmetic. Do not add `research` to that whitelist —
the whitelist is what keeps the published tarball to the extension,
the doctrine docs, the README and the licence.

The trade-off is accepted: the provenance lives in the repository, so
it is one `git clone` away from any consumer who wants to audit a
number, and zero bytes for everyone else.

## Refresh procedure

The model landscape moves; this corpus does not. When it goes stale —
a new model, a price change, a withdrawn benchmark, or an `asOf` date
old enough to be untrustworthy — refresh it as a whole, in order:

1. **Re-run the research.** Regenerate the primary reports from
   vendor and independent sources. Same structure, same section
   numbering, so the digest's trace keys still resolve.
2. **Re-derive the digest.** Rebuild Artifacts A, B and C from the
   new reports under the tracing rule. Do not patch the old digest in
   place: a partial refresh mixes observation dates inside one table
   and there is then no honest `asOf` to write.
3. **Re-verify with an independent adversarial pass.** A fresh
   context, not the thread that wrote the digest, re-reads every
   routing-critical number against its cited source. Both fabrications
   above survived a self-review and died in an independent one.
4. **Regenerate the profile table and bump `asOf`.** Derive the
   shipped table from the new digest and set `asOf` to the new
   observation date. Then re-run the router's own checks — a profile
   change can move a routing decision.

Bump the digest's revision number (`digest-v6.md`, superseding v5) and
keep the superseding note: the chain is the audit trail.
