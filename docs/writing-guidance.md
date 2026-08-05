# Writing guidance and the prose checker

Slate ships an optional writing convention and a command that measures
prose against a mechanical proxy. With `writing.check` absent or false,
Slate loads no writing guidance. The command remains available.

This document is reference documentation, not workflow doctrine. It
is the definition of record for the rule set, the severity classes,
the command line and the caps. The enabled doctrine rule states the
convention in a few lines and cites this file for everything else.
A session pays for the detail only when it reads this file.

## What the checker is, and what it is not

`extension/writing-check.mjs` is a dependency-free Node command. It
reads text, strips the parts that are not prose, splits what remains
into blocks and sentences, and reports surface facts about them:
sentence length, sentence count per paragraph, and matches for a
closed list of twelve patterns. It emits per-rule counts, length
distributions and one finding record per match, each with a source
offset and a framed excerpt.

**It is a proxy, and the proxy is dictionary-free.** It embeds no
controlled vocabulary and consults none. It therefore cannot decide
whether a word is approved, whether a word is used in an approved
sense or part of speech, or whether a technical term is legitimate.
It reports those limits in its own output, under `NOT CHECKED` — see
[What the checker declares unchecked](#what-the-checker-declares-unchecked).

**It establishes no conformance with any writing standard.** ASD-STE100
inspired the choice of what to measure. Slate claims no conformance
with it. No text, example or dictionary entry from the standard is
reproduced here or in the checker. TechScribe's
[public analysis](https://www.simplified-english.co.uk/analysis.html#write-short-sentences)
is the source for the 20- and 25-word figures. Boeing's
[public checker page](https://www.boeing.com/company/simplified-english-checker)
also publishes that pair and is the source for the six-sentence figure.
The source repository keeps the citation trail in its non-published
`research/writing-threshold-provenance.md`. Slate defines the severity
classes, patterns and suppression lists, and applies one band uniformly
to all prose rather than selecting a limit by text type. A clean run
is evidence about surface form only. It is not a certificate.

**It is not an authority over a reviewer.** A match is a place to
look, not a verdict. `review-rules.md` governs how a text reviewer
turns checker output into findings and severities, and it is the
document to follow when reviewing prose. The short version: a
`fail` class match deserves inspection, an `advisory` class match is
never a defect on its own, and the checker cannot see meaning,
accuracy, structure or completeness at all.

## Enabling it

Configure writing features in the project's `.pi/slate.json`:

```json
{
  "writing": {
    "check": true,
    "remind": false,
    "remindPercent": 10
  }
}
```

All three values are optional. `check` and `remind` default to false.
`remindPercent` defaults to 10. `remind` is inert unless `check` is
true.

A malformed `writing` value warns once and uses all defaults. A
non-boolean `check` or `remind` value warns and uses its default.
Unknown keys under `writing` also warn and are ignored.

`remindPercent` must be a finite number in `(0, 100]`. An invalid
value warns and defaults to 10. The validator is
`sanitizeWritingConfig` in `extension/writing.ts`.

Slate reads project config only for a TRUSTED project. The doctrine,
worker preamble, and reminder gates also check trust at their injection
points. These checks provide defense in depth because
`extension/index.ts` already gates the current config path. An
untrusted project behaves as if the switches were off.

The `check` switch turns on three things:

1. **The doctrine rule.** One numbered rule is appended to the
   orchestrator's system prompt while orchestrator mode is on. It
   states the convention and cites this file by absolute path.
2. **The worker preamble sentence.** Every worker thread dispatched
   while the switch is on gets one extra sentence of guidance in its
   preamble. With the switch off the preamble is byte-identical to
   its pre-feature text.
3. **The turn status line.** In an interactive session, the Slate
   status line gains a `writing <n>/<m>` counter. `m` counts measured
   prose turns. `n` counts turns with at least one `fail` finding.

The separate `remind` switch adds a hidden, context-paced message.
Context-paced means Slate waits for configured context growth between
reminders. It works only while `check` remains on. The next section
defines this channel and its gates.

Running the command by hand needs no config. It is a plain Node
command and works whether either switch is on.

## Writing requirements and reminders

The doctrine includes these six requirements in this order:

- Avoid idioms.
- Replace bare-reference openers with the subject they reference.
- Explain each project-specific term at first use.
- Define each abbreviation at first use.
- Express one idea in each sentence.
- Use one term for each concept.

These project-authored summaries came from the investigation for
[issue #96](https://github.com/JetBrains/ytdb-slate/issues/96). ASD-STE100
informed that work. Slate copied no standard text or controlled
vocabulary, and it claims no conformance.

A reminder repeats five lines. It omits this doctrine-only line:

`Express one idea in each sentence.`

The sentence-length rules provide a nearby mechanical signal. They do
not test idea count. The reminder then includes this exact scope guard:

`Exclude research logs, worker task text, and the project's own agent instruction file.`

This guard prevents the five requirements from applying to those
excluded artifacts.

These requirements are not mechanical checker findings. The shipped
checker has no rule for idioms or bare-reference openers. It also has
no rule for project-term explanations or abbreviation definitions.
It cannot enforce one term per concept.

After an eligible tool result, Slate queues a hidden custom message
with active `steer`. The message has `display: false` and arrives
before the next assistant response.

The normal UI has no reminder indicator. It does not appear in the
normal TUI or tool panel. A tool-free round receives no reminder.

To diagnose delivery, inspect the session JSONL through pi. A delivered
reminder has entry type `custom_message`, `customType` set to
`slate-writing-reminder`, and `display` set to false. It also enters
later model context. This diagnostic does not depend on a stable
session-file path.

Every reminder gate must be open:

- orchestrator mode is on
- the project is trusted
- `writing.check` and `writing.remind` are true
- Slate is not paused
- the context threshold is reached, or a handoff forces the next reminder
- no reminder has been sent in the current assistant response round

Slate permits at most one reminder for each assistant response round.
Parallel tool results therefore cannot produce repeated reminders in
one round.

The interval is `remindPercent` of Slate's current effective context
budget. Slate rounds down to whole tokens, then applies an 8,192-token
floor. It applies no interval cap.

The default interval is 10 percent. The configured range is greater
than zero through 100, inclusive. The effective budget reflects the
live model, configured budget, context window, and Slate's handoff
headroom.

The 8,192-token floor makes sufficiently small percentages equivalent.
At 100 percent, normal cadence reaches its threshold at the effective
pause boundary. These endpoints remain valid. A forced post-handoff
reminder bypasses the cadence threshold.

After a reminder, Slate marks the current context usage. Another
reminder needs one full interval of growth. When context usage shrinks,
Slate lowers the mark to the new usage before measuring growth again.

A trusted handoff reloads the doctrine in the fresh session. It also
forces a reminder after the first eligible tool result. This forced
reminder does not need context usage or a reached threshold.

A representative 256,000-token budget gives a 25,600-token default
interval. This example only illustrates cadence. Slate has no
controlled comparison or claim that reminders improve prose.

## Keeping the requirement text synchronized

`WRITING_REQUIREMENTS` and `WRITING_SCOPE_EXCLUSION` in
`extension/writing-reminder.ts` export the authoritative wording.
The complete six-line roster has three manual copies: this guide,
AGENTS.md's roster, and resolver exact fixtures. The integration canary
manually copies only the five reminder-eligible lines.

The scope exclusion has three exact copies: this guide, resolver exact
fixtures, and the integration canary. AGENTS.md carries equivalent
scope prose, not an exact copy. All applicable copies must update in
one commit.

`extension/mode.ts` renders the authoritative exports directly. The
shell harness reads expected text from canary evidence. Neither file
holds a manual wording copy.

## What it costs when it is on

The doctrine rule is part of every orchestrator system prompt, so its
cost is paid on every turn. The worker addition is paid once per
worker dispatch. Each sent reminder also enters later model context.
`context-budget.md` defines the portable-character measure. It records
the whole-doctrine sizes and owns the size budget.

An interactive session also runs the checker synchronously after each
completed assistant message. The hook refuses text over 16 KiB and
reports `writing skipped (message too large)`. This TUI bound is
separate from the command's 1 MiB input cap.

The checker hook is human-only telemetry. It does not change model
input. A checker failure reports `writing unavailable` instead of
failing the turn. The optional reminder uses the separate model-visible
channel described above.

## What counts as prose

Rules run over blocks, and only some blocks are prose. Before any
block is formed, the normalizer BLANKS the spans that are not prose,
keeping the source length so that every reported offset still points
into the original text:

- fenced code blocks, including an unterminated final fence;
- indented code (four or more leading spaces followed by a character
  that is not a list marker);
- unified-diff lines (`diff --git`, `@@`, `---`, `+++`);
- timestamped log lines (an ISO-8601 timestamp followed by a level
  such as `INFO` or `ERROR`);
- HTML comments;
- inline code spans;
- autolinks (`<https://…>`, `<mailto:…>`) and bare URLs.

What remains is split into lines and classified: `table-row`,
`heading`, `blockquote`, `list-item` or `paragraph`. Consecutive
paragraph lines join into one block with a single space, so a sentence
wrapped across source lines is one sentence. The block keeps a map
from its joined text back to source offsets, so findings on a
multi-line paragraph report the right characters.

Rules and prose statistics apply to `paragraph`, `list-item` and
`blockquote` blocks. Headings and table rows are parsed and counted as
blocks, but no rule fires in them and they contribute no words or
sentences to the statistics. `PARA6` is narrower still: it applies to
`paragraph` blocks only.

Sentences are split at `.`, `!` or `?` when followed by whitespace or
the end of the text. A period is treated as internal, and does not
split, when it is doubled, sits between two digits, ends one of a
small fixed abbreviation list (`e.g.`, `i.e.`, `etc.`, `vs.`, `dr.`,
`mr.`, `mrs.`, `ms.`, `prof.`, `sr.`, `jr.`, `no.`, `fig.`,
`approx.`, `dept.`, `inc.`, `ltd.`, `st.`), or closes an initialism
such as `U.S.`. An ellipsis is one punctuation run, not three empty
sentences. A candidate sentence with no letter in it is dropped.

A word is a run of letters and digits, with internal apostrophes and
hyphens kept, that contains at least one letter. So a hyphenated
compound counts as one word and a bare number counts as none.

Four of the twelve rules ignore identifier-shaped text. `PASSIVE`,
`INGFORM`, `NOUNCLUSTER` and `MULTICMD` run over a filtered token
list with path-like tokens, dotted names, `snake_case`, `camelCase`
and em-dash-bearing quotations removed, so a file name or a symbol
cannot trip them. The length, punctuation and parenthetical rules see
the unfiltered text.

## The rules

Twelve rules in four severity classes. The class is the checker's own
label, reported with every finding and in the per-rule summary.

**`fail` — a mechanical violation of the convention.**

| rule | what it flags |
| --- | --- |
| `SENT25` | a sentence of more than 25 words |
| `PARA6` | a paragraph block of more than 6 sentences |
| `SEMICOLON` | each `;` in a prose block |
| `CONTRACTION` | a contracted form. Two shapes match: a pronoun or one of `that`, `there`, `here`, `what`, `who`, `how`, `where`, `when`, `why`, `let` carrying `n't` or `'re`, `'ll`, `'ve`, `'d`, `'m`, `'s`; and a negated auxiliary such as `don't`, `won't` or `shan't`. Straight and curly apostrophes both match |

**`warning` — over the comfortable length, under the failing one.**

| rule | what it flags |
| --- | --- |
| `SENT20` | a sentence of more than 20 words and at most 25 |

A sentence reports one length result at most: `SENT25` when it is
over 25 words, `SENT20` when it is over 20, and nothing otherwise.

**`house-style` — legitimate constructions this convention avoids.**

| rule | what it flags |
| --- | --- |
| `PARENTHETICAL_PAREN` | a parenthesis pair whose content looks like a clause rather than an aside. The test is a surface one: an auxiliary or `be` form, a word ending in `ed` or `es`, or a non-initial word ending in `s` |
| `PARENTHETICAL_DASH` | a paired em dash, or a spaced en dash pair, enclosing text. A pair inside a quotation that itself contains an em dash is suppressed |
| `SLASHED` | a letters-only `word/word` construction such as `and/or`. Paths and URLs are already blanked, and a longer slash run does not match |

**`advisory` — noisy heuristics, never a defect on their own.**

| rule | what it flags |
| --- | --- |
| `PASSIVE` | a `be` form, optionally followed by an `-ly` adverb, then a likely participle: a word ending in `ed`, or one of a fixed irregular-participle list. A fixed list of state-like participles (`connected`, `installed`, `configured` and others) is suppressed, which lowers noise and can hide a real passive |
| `INGFORM` | a word ending in `ing` that is not preceded by a `be` form. A first token of a multi-token sentence is skipped, deliberately, because it is usually a gerund subject or a heading-like phrase |
| `NOUNCLUSTER` | a run of four or more words with no function word between them |
| `MULTICMD` | a token shape: a sentence starts with a non-function word and later has `and`, `and then` or `, then` followed by another non-function word. It approximates multiple commands but can match ordinary coordination such as “Files and folders exist.” |

Only the `fail` class moves the turn status counter. A `warning`,
`house-style` or `advisory` match is reported and counted, but the
counter treats the turn as clean.

Two properties are worth knowing before reading a report. Rule ids
and classes come from one closed table in the module, so a report can
never name a rule the table does not define. Every finding carries a
source offset range, a block index, a sentence index where the rule
is sentence-scoped, and an excerpt framed in `⟦…⟧` with the framing
characters removed from the content, so the frame is always the
checker's and never the text's.

## The command line

```
node extension/writing-check.mjs --input records.jsonl [--format json|text]
node extension/writing-check.mjs --file PATH [--file PATH ...] [--format json|text]
node extension/writing-check.mjs --diff changes.diff [--format json|text]
```

Exactly one input mode per run. `--format` is `json` by default and
`text` for a human-readable report. `--help` prints the usage.
`--input` and `--diff` take one path each; `--file` repeats.

Every input must be a REGULAR FILE. The command refuses a symlink, a
directory, a FIFO or a device. It checks the opened descriptor and
rejects a special file substituted between the initial check and the
open. It also detects growth while reading. It does not detect every
race or a same-size in-place modification.

### `--input`: JSONL records

One JSON object per line, each with a string `text` field. A missing
or non-string field is rejected. `id` names the record in the report;
with no `id` the record is named from its `session` and `line` fields,
else from its position. Blank lines are skipped. This is the mode for
text that is not a file on disk — an extracted message, a comment
body, a release note draft.

### `--file`: whole files

One record per path, named by the path. This is the mode for a
complete prose artifact: a document, a README, a release note.

### `--diff`: added lines of a unified diff

Reads a unified diff and checks the ADDED lines only. Consecutive
added lines form one record, named `path:firstAddedLine`, so a
sentence added across several lines is checked as one sentence. It
parses hunk headers strictly and fails loudly on a malformed diff
rather than checking a mis-attributed line.

Diff mode is for PROSE review, and its file filter is deliberately
narrow. It includes `.md`, `.markdown`, `.mdx`, `.txt`, `.rst`,
`.adoc` and `.asciidoc`, plus a small closed set of extensionless
conventional names (`readme`, `changelog`, `changes`, `contributing`,
`release_notes`).

It therefore EXCLUDES source files entirely, and that exclusion is
the mode's main limitation: prose that lives inside code — a
user-facing string, a comment, a help text, a commit message — is not
reviewed by `--diff`. Inspect those directly, or extract the text and
pass it through `--input`. Git's quoted-path encoding is decoded
before a path is classified or reported; a path that is not valid
UTF-8 is skipped and named in a `DIFF FILES SKIPPED` line rather than
being checked under a false name.

### Caps

Every cap is a hard bound with a reported consequence, never a silent
truncation.

| cap | value | applies to |
| --- | --- | --- |
| input bytes | 1,048,576 | one record, and the total across a run's records or files |
| records | 10,000 | a JSONL input, a `--file` list, and a diff's added-line runs |
| findings per record | 1,000 | one record's reported findings |
| findings per run | 20,000 | the whole run, shared as an EQUAL per-record allowance |
| excerpt characters | 2,000 | one finding's excerpt, framing characters included |
| reported stripped spans | 5,000 | the reported non-prose span list |
| reported block details | 5,000 | the reported per-block detail list |

The per-run budget is divided equally rather than first-come, so a
record's position never decides what it keeps, and the floor is one
finding per record so that a large run still shows every offending
record. When the run budget binds, the report states it BEFORE any
finding line, so a reduced report cannot read as a complete one. A
record that loses findings reports its own shortfall. The two
5,000-span caps bound the REPORT only: blanking and counting are
always complete.

## What the checker declares unchecked

The report ends with a `NOT CHECKED` list. It is part of the output on
purpose: the limits are a result, not a footnote.

| id | why not |
| --- | --- |
| `APPROVED_WORD` | approved-word membership needs an authorized controlled dictionary |
| `APPROVED_MEANING_POS` | approved meaning and part of speech need authorized dictionary data and contextual review |
| `NOUNCLUSTER_CORRECTNESS` | the token-run heuristic cannot decide whether a noun cluster is wrong or is an approved technical term |
| `TOPIC_UNITY` | topic unity and topic-sentence adequacy need semantic review |
| `WARNING_CAUTION_CONTENT` | risk level, placement, command adequacy and consequences need structured metadata and human review |

## What this feature deliberately does not do

These are settled decisions. Read them as scope, not as a backlog.

- **No controlled vocabulary, and no plan for one.** Word approval
  needs an authorized dictionary. Slate ships none and embeds none.
- **No conformance claim.** ASD-STE100 inspires the choice of what to
  measure. Slate claims no conformance. No text, example or dictionary
  entry from the standard is reproduced here or in the code.
- **No vocabulary or terminology enforcement.** The convention keeps
  exact technical terms, so the checker must not push a writer off
  them. Nothing in it rewrites, replaces or grades a word choice.
- **No broad prose rewriting.** The checker reports and never edits.
  Every fix is a human or agent decision.
- **No verdict.** No rule class is a defect by itself, and no clean
  run is a pass. `review-rules.md` owns the mapping from a match to a
  severity, and a reviewer owns the judgement.
- **Not a gate.** The checker hook is telemetry. It changes no model
  input and cannot fail a turn. The optional reminder is guidance,
  not a checker verdict.
- **Not universal.** The convention covers prose written for people:
  documents, README text, pull request and commit text, issues,
  review comments, release notes and messages to the user. Research
  logs, worker task text and this repository's own agent instruction
  file are excluded, because a dense exact register serves them
  better.
