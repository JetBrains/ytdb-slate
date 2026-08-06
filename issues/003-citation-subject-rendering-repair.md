# 003 — Remove the citation-subject rendering repair

**Status:** open, deferred from the **router warning visibility change**
(draft pull request 123) by the user review on **2026-08-06**.
**Type:** maintenance.

Remove a bespoke grammar repair from profile warning rendering by making
the two shipped source fields readable under plain citation stripping.

## The citation-subject problem

Router warnings remove bracketed research citation tags from
profile-sourced text. Most tags are parenthetical metadata, so deleting
the tag and collapsing the remaining whitespace preserves the sentence.
A tag can instead occupy the grammatical subject position. Plain removal
then leaves the predicate with no subject.

`profileText` in `extension/model-router.ts` currently repairs one such
shape before it strips tags. After `;`, `:`, `,` or `.`, a citation tag
followed by any ASCII word becomes the generic subject `the source`.
Thus `vendor data is incomplete; [G3] gives input only` renders as
`vendor data is incomplete; the source gives input only`.

The rule is bespoke grammar inference over prose maintained by hand. It
recognises punctuation and an ASCII word, but it does not recognise a
verb. Exactly two fields in the shipped table need the rule. Both are in
cheap-tier profiles, and both place `[G3]` after a semicolon:

- `openai/gpt-5.4-nano`:
  `cache-WRITE price — not published for this model; [G3] gives in / cached / out only, and nothing is derived from the GPT-5.6 table's 1.25× rule [O2]`
- `openai/gpt-5.4-mini`:
  `cache-WRITE price — not published for this model; [G3] gives in / cached / out only, and nothing is derived from the GPT-5.6 table's 1.25× rule [O2]`

The current repair renders either field as:

> cache-WRITE price — not published for this model; the source gives in / cached / out only, and nothing is derived from the GPT-5.6 table's 1.25× rule

A plain tag strip renders either field as:

> cache-WRITE price — not published for this model; gives in / cached / out only, and nothing is derived from the GPT-5.6 table's 1.25× rule

The plain form is awkward because `gives` has no subject, but it does not
fabricate a subject or alter any number. The current form is readable,
but the renderer has guessed what grammatical role the deleted tag
played.

### Known residual

The narrowed rule still treats every ASCII word after the tag as the
start of a predicate. It can therefore misfire on a field shaped as a
phrase, then punctuation, then a citation tag, then a noun, adjective or
other non-verb word. A shape such as `<phrase>; [tag] <non-verb>` becomes
`<phrase>; the source <non-verb>`. The inserted subject may imply a
relationship the authored field did not state, and it can still leave an
incomplete clause.

The resolver check pins the intended verb case and the separate inline-
tag case. It does not prove that the lookahead word is a verb. The gate
review accepted this residual for the current change because the plain
strip was already ungrammatical for that shape and model data notes are
hidden by default.

## Replace authored prose, then delete inference

Rewrite the two fields so each remains grammatical after a plain
citation strip. Preserve the same claims: the cache-write price is not
published, `[G3]` supplies only input, cached-input and output prices,
and Slate derives nothing from the GPT-5.6 multiplier.

After the shipped prose no longer depends on a citation tag as its
subject:

1. delete the punctuation-and-ASCII-word subject repair from
   `profileText`;
2. keep ordinary citation stripping, whitespace collapse, separator
   neutralisation and length bounds unchanged;
3. delete the dedicated `router-subject-repair` check and its roster
   entry;
4. retain coverage that inline tags disappear without adding words; and
5. sweep every shipped unknown field and non-preferred reason to prove
   that no rendered field becomes empty or ungrammatical at the two
   former sites.

The profile rewrite should remain grammar-only. It must not change a
price, provenance claim, unknown-data classification or routing result.

## Questions before editing traced profile prose

- **What exact wording preserves `[G3]`'s role?** Moving the citation to
  the end is mechanically simple, but the sentence must still make clear
  that `[G3]`, and not another source, publishes the three listed price
  columns.
- **Does a grammar-only rewrite require a new research trace?** The
  `model-profiles.ts` header says everything outside its named derived
  exceptions is traced and a traced value is never edited without
  re-tracing it. These strings are explanatory unknown-field prose, not
  numeric values, but the header gives them no exemption. The safe
  interpretation is to re-trace both fields, or to establish explicitly
  that the rule does not classify this prose as a traced value.
- **How broad must the post-edit sweep be?** The two known dependencies
  are identical, but removing the repair changes a shared renderer. A
  future implementation must decide whether the shipped-table sweep is
  sufficient or whether fabricated punctuation cases remain useful as
  plain-strip tests.
- **Should rendering ever add words?** If future profile prose creates
  another missing-subject case, should validation reject that prose,
  should review correct it, or may a renderer perform a narrower repair?

## Why the repair remains for now

The router warning visibility change needed readable warnings after
citation tags were hidden. Removing the tag from the two shipped fields
produced broken prose, so the bounded repair was the smallest production
change that preserved their meaning during that delivery.

The user review for draft pull request 123 on 2026-08-06 deferred the
profile rewrite. A rewrite touches the traced profile table and invokes
its re-tracing rule. Folding that research review, renderer deletion and
resolver-check movement into a warning-visibility change would have
widened both its evidence boundary and its verification diff.

The issue remains open because the accepted residual is structural. A
future hand-authored field can match the punctuation pattern with a
non-verb, and the renderer will add `the source` without enough grammar
information to justify it.
