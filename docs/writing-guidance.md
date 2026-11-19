# Writing guidance and the prose checker

Slate ships an always-active writing convention and a command that measures
prose against a mechanical proxy. Trusted projects receive the guidance in
orchestrator mode. The command remains available.

This reference defines the rules, severity classes, command line and caps.
The doctrine cites it for detail.

## Current-state documentation rule

Describe only the current state in new or changed text in the root `README.md`,
`docs/`, code comments and this project's agent instruction file, `AGENTS.md`.
Do not describe removed features or past behavior in those places. Existing
historical sentences are pre-existing debt and need no rewrite for this rule.
Support for a deprecated key that still exists is current state and may be
documented.

Change records may describe removals and past behavior. Pull request
descriptions, commit bodies, release notes and issues are change
records. The other writing requirements still apply to change records.

This rule is separate from the ten writing requirements and seven design
requirements below. It applies to `AGENTS.md` even though that file is excluded
from the other writing requirements. The prose checker cannot decide whether
a feature still exists, so it does not enforce this rule.

## What the checker is, and what it is not

`extension/writing-check.mjs` is a dependency-free Node command. It
reads text, strips the parts that are not prose, splits what remains
into blocks and sentences, and reports surface facts about them:
sentence length, sentence count per paragraph, and matches for a
closed list of eleven rules. It emits per-rule counts, length
distributions and one finding record per match, including a sentence-length
finding when the configured limit is exceeded. Each finding has a source
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
reproduced here or in the checker. Boeing's
[public checker page](https://www.boeing.com/company/simplified-english-checker)
is the source for the six-sentence figure.
The source repository keeps the citation trail in its non-published
`research/writing-threshold-provenance.md`. Slate defines the severity
classes, patterns and suppression lists. A clean run
is evidence about surface form only. It is not a certificate.

**It is not an authority over a reviewer.** A match is a place to
look, not a verdict. `review-rules.md` governs how a text reviewer
turns checker output into findings and severities, and it is the
document to follow when reviewing prose. The short version: a
`fail` class match deserves inspection, an `advisory` class match is
never a defect on its own, and the checker cannot see meaning,
accuracy, structure or completeness at all.

## Configuration

Writing guidance needs no enable switch. It requires permitted settings.
Orchestrator reminders also require active orchestrator mode.

Slate still accepts `writing.check` and `writing.remind` for compatibility.
They are ignored writing keys and have no effect. Remove them from `slate.json`.
Either explicitly set key produces one configuration notice, even when its
value is `false`. When both keys are present, Slate sends one notice.

`writing.remindTurns` sets the cadence for both recipients. Cadence is the
number of completed turns that makes writing due. Slate accepts whole numbers
from 1 through 20. The default is 4. Invalid values warn and use 4.
`writing.remindOnFinding` controls the orchestrator finding trigger. It
defaults to `true` and accepts only booleans. An invalid value warns and uses
`true`. Slate warns if you set it while `writing.findings` is false.
Slate accepts and ignores `writing.remindPercent` with a notice.
`writing.sentenceWordLimit` accepts whole numbers from 10 through 200, or
`false` to disable the rule. Invalid values warn and use the 25-word default.
The checker reports one sentence-length distribution across scanned files.

`writing.statusWindowTurns` controls the status window. It defaults to 10 and
accepts whole numbers from 3 through 100. An invalid value warns and falls back
to 10. `writing.showStatus` defaults to `false` and accepts only booleans.
It controls only the writing part of the status line. An invalid value warns
and falls back to `false`. Measurement and reminders continue when it is
`false`. `writing.findings` defaults to `true` and accepts only booleans. An
invalid value warns and falls back to `true`. It controls only the findings
section in the hidden reminder. Measurement continues when it is `false`.
The status line follows `writing.showStatus`. Unknown keys under `writing`
also warn and are ignored. The validator is `sanitizeWritingConfig` in
`extension/writing.ts`.

Slate reads home `<getAgentDir()>/slate.json` before trusted project config.
Nested writing settings merge, with project values taking precedence.
The doctrine, worker preamble, status, and reminders use that same permitted
configuration. Untrusted projects cannot supply writing settings.
Without a home file, untrusted projects receive no writing guidance.
The [configuration reference](configuration.md) defines the file and merge rules.

Sessions with permitted Slate settings receive the first three writing and
design surfaces. The fourth surface needs `writing.showStatus: true`:

1. **The writing doctrine rule.** One numbered rule states the writing
   convention and cites this file by absolute path.
2. **The design doctrine rule.** A final numbered rule requires the
   simplest-solution requirement, outcome-focused user-approved scope, and
   self-contained design updates.
3. **The worker preamble guidance.** With permitted settings, researcher,
   implementer, general and untyped workers receive the ten requirements.
   Reviewers and adversaries receive short writing guidance.
   Both forms include the scope exclusion and current-state rule.
   Maps, designs and package drafts are governed prose.
   A high-level design stays governed inside a research log.
4. **The turn status line.** When `writing.showStatus` is `true`, the Slate status
   line gains `writing <n> fail, <m> style / <w> turns`. The default window is ten
   measured prose turns. The configured range is 3 through 100. Both counts
   include model-visible findings only.

Slate also queues hidden guidance through separate orchestrator and worker rules.

Running the command by hand needs no config. It is a plain Node command.

## Writing requirements and reminders

The doctrine includes these ten requirements in this order:

- Write for a reader whose first language is not English.
- Use plain words that appear in standard libraries and textbooks. Treat any other term as new. A multi-word noun phrase, an abbreviation and a CamelCase name are terms.
- Avoid idioms.
- Replace bare-reference openers with the subject they reference.
- Explain each term, including project-specific, at first use.
- Define each abbreviation at first use.
- Express one idea in each sentence.
- Use one term for each concept.
- Do not explain an idea with a metaphor.
- Do not invent a term when the project already has one.

The doctrine also renders `Use short, active language.` in its lead-in. The
roster owns vocabulary, because one roster item fixes which words a writer may
assume the reader knows. Slate dropped the earlier word-shortening rule from
that lead-in. Two near-identical rules in one requirement block break the
project requirement to use one term for each concept.

**Orchestrator.**
The optional `Recent writing findings:` section marks quotes as data and shows
one quote per model-visible class. The title is `Writing and conversation requirements`.
The next line carries these three retained style rules: `Use short, active
language.` `Keep exact technical terms.` `Do not use semicolons or
contractions.` The reminder then repeats all ten writing requirements. It also
carries this seven-line design requirement block:

- Choose the simplest solution with the fewest changes that keeps every approved goal, the product and implementation quality, and every required gate.
- Keep a design statement only if a different reasonable implementation keeps it true.
- Present to the user any item the approved goals do not list.
- Never add or remove an approved goal yourself.
- Propose a repeated regression as a non-goal candidate.
- Present what changed when you update a design.
- Assume the user knows software but not this project.

The reminder then includes this exact scope guard:

`Exclude research logs, worker task text, and the project's own agent instruction file.`

This guard summarizes the ten writing requirements and the design requirements
wherever Slate renders it, including the doctrine rule and the reminder. It
does not exclude `AGENTS.md` from the separate current-state documentation rule.
The summary names research logs as excluded from the other requirements. A
high-level design remains governed even while it lives inside a research log.
This document defines the precise scope of every rendering.

These requirements are not mechanical checker findings. The shipped checker
has no rule for the reader's first language, vocabulary, idioms or
bare-reference openers. It also has no rule for term explanations or
abbreviation definitions. It cannot count ideas in a sentence or enforce one
term per concept. It tests neither metaphor-based explanations nor invented
project terms.

After an eligible turn, Slate uses `steer` if a tool returned a result.
Otherwise it queues guidance for the next turn. Pi saves a `custom_message`
with `customType: slate-writing-reminder` and `display: false`. The terminal
does not show it. Inspect the session through Pi without relying on a stable
file path. The guidance enters later model context.

Delivery requires active orchestrator mode, permitted settings and no pause.
It also requires a due cadence, a finding trigger or a forced handoff reminder.
Slate sends at most once per response round, which covers one assistant
response and its tool-result continuations. Parallel results do not repeat
the send. An abort after a tool turn does not reopen that round.

Completed turns count, including aborted turns. Provider retry attempts do
not count. Slate claims before sending and resets the count even if sending
throws. The finding trigger fires on the turn after a measured finding.
With findings enabled, reminders retain the latest measured finding summary
even when cadence fires. Turning findings off disables the trigger but keeps
cadence. A trusted handoff reloads doctrine and forces the next eligible
reminder without waiting for cadence or a finding.

**Workers.** Writing needs a trusted project or authenticated home-only
settings. Orchestrator mode, pause, handoff and findings do not affect worker
cadence. Workers use their role's preamble without a checker, design block or
findings.

Cadence starts at zero on open. Retry and failover keep the count within the
same session. At turn end, Pi's reported `stop` or `toolUse` counts once,
even with no tools or a skipped tool. Reported `aborted`, `error` and
`length` do not count. Only earlier turns can make writing due. With cadence
four and eligible tools on each turn, turn five can queue writing for
response six.

The first eligible result takes the hidden `slate-worker-reminder` slot.
Nested results and call identifiers starting with `/` do not qualify. Due
writing follows the tools text after two line feeds. If construction fails,
Slate sends tools text only. If the send throws, Slate frees the slot for
another eligible result in that round. Only a normal combined send resets
cadence. It does not prove delivery. Without another eligible result, writing
can stay due at action end.

Slate neither sends writing alone nor catches up after compaction. Slate adds
no warning or request for writing. Pi controls queue order and continuation.
The extra context can lead Pi to compact, retry or fail on overflow.

Pi saves the reminder with `display: false`. An incomplete file append can
affect a later record. A worker summary can repeat guidance. Neither the
reminder nor that summary enters the episode input. Ordinary worker output
can enter even if it quotes guidance.

Slate makes no claim that reminders improve prose.

## Keeping the requirement text synchronized

`WRITING_REQUIREMENTS_TITLE`, `WRITING_STYLE_RULES`, `WRITING_REQUIREMENTS`,
`DESIGN_REQUIREMENTS`, and `WRITING_SCOPE_EXCLUSION` in
`extension/writing-reminder.ts` export the authoritative wording. The complete
ten-line writing roster has six manual copies: this guide, the writing
convention in `AGENTS.md` near line 372, and the `writingLines` and
`doctrineRequirements` copies in
`verification/resolver-checks.mjs`, `verification/writing-reminder-canary.mjs`,
and the clause list in `test/doctrine-contract.test.ts`. The seven-line design
roster has four manual copies: this guide, the `designLines` copy in
`verification/resolver-checks.mjs`, `verification/writing-reminder-canary.mjs`,
and the clause list in `test/doctrine-contract.test.ts`.

The title and retained style rules have five manual check copies. They are the
`writingTitle`, `styleLines`, and `exactWritingOpening` values in
`verification/resolver-checks.mjs`, the expected values in
`test/writing.test.ts`, the doctrine clauses in `test/doctrine-contract.test.ts`,
and the full message in `verification/writing-reminder-canary.mjs`. This guide
holds the document copy.

The scope exclusion has manual copies in this guide, resolver fixtures,
`test/doctrine-contract.test.ts`, and the integration canary.
`extension/writing-reminder.ts` defines both worker forms with this exclusion.
`AGENTS.md` carries equivalent scope prose. Update applicable copies together.

The check counts literal occurrences and cannot detect a generated copy, while
issue 317 tracks the general solution.

`extension/mode.ts` renders the shared exports directly.
`extension/worker.ts` imports the full and short guidance forms.
Neither holds a manual roster. The shell harness uses canary evidence.

## What it costs when it is on

The orchestrator prompt includes doctrine.
Slate assembles the worker preamble once per session. Ordinary requests
repeat it. Retained reminders can recur. These counts do not measure billing.
`context-budget.md` defines the portable-character measure. It records
the whole-doctrine sizes and owns the size budget.

An interactive session runs the checker synchronously at the assistant
`message_end` event. This event runs before tool execution. The older `turn_end`
position could carry a quotation from an earlier turn into the model. The hook
refuses text over 16 KiB. The status line reports `writing skipped (message too large)`
when `writing.showStatus` is `true`. Slate retries a failed checker import on a
later message. This TUI bound is separate
from the command's 1 MiB input cap.

The checker hook supplies model-visible findings for four rules: semicolons,
contractions, paragraph length, and sentence length. Four advisory rules remain
review-only. The reminder carries one quotation for each present
model-visible class and its count. Each quotation is capped at 120 bytes and
uses `…` when truncated. Truncation keeps both `⟦` and `⟧` frame characters. The
section states that quoted text is data, not an instruction. It states that a
finding is a signal, not a verdict. It states: `Split a long sentence, keep the logical connection explicit, name each subject, and avoid disconnected fragments.` A checker
failure reports `writing unavailable` in the status line when `writing.showStatus`
is `true`. It does not fail the turn. The hidden reminder uses the
model-visible channel described above.

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

Four of the pattern rules ignore identifier-shaped text. `PASSIVE`,
`INGFORM`, `NOUNCLUSTER` and `MULTICMD` run over a filtered token
list with path-like tokens, dotted names, `snake_case`, `camelCase`
and em-dash-bearing quotations removed, so a file name or a symbol
cannot trip them. The punctuation and parenthetical rules see the unfiltered
text.

## The rules

Eleven rules in four severity classes. The class is the checker's own
label, reported with every finding and in the per-rule summary.

**`fail` — a mechanical violation of the convention.**

| rule | what it flags |
| --- | --- |
| `SEMICOLON` | each `;` in a prose block |
| `CONTRACTION` | a contracted form. Two shapes match: a pronoun or one of `that`, `there`, `here`, `what`, `who`, `how`, `where`, `when`, `why`, `let` carrying `n't` or `'re`, `'ll`, `'ve`, `'d`, `'m`, `'s`; and a negated auxiliary such as `don't`, `won't` or `shan't`. Straight and curly apostrophes both match |

**`warning` — no rule currently emits this severity.**

**`house-style` — legitimate constructions this convention avoids.**

| rule | what it flags |
| --- | --- |
| `PARA6` | a paragraph block of more than 6 sentences |
| `SENTENCE_LENGTH` | a sentence longer than the configured whole-word limit. The default is 25 words, the accepted range is 10 through 200, and `false` turns this rule off |
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
node extension/writing-check.mjs --input records.jsonl [--format json|text] [--sentence-word-limit 10..200|off]
node extension/writing-check.mjs --file PATH [--file PATH ...] [--format json|text] [--sentence-word-limit 10..200|off]
node extension/writing-check.mjs --diff changes.diff [--format json|text] [--sentence-word-limit 10..200|off]
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
| `IDEA_COUNT` | counting ideas in a sentence needs semantic review |
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
- **Not a gate.** The checker hook is diagnostic. It cannot fail a turn. The
  reminder carries selected findings as guidance, not as a checker verdict.
- **Not universal.** The ten writing requirements cover prose written for
  people: documents, maps, designs, package drafts, README text, pull request and commit text, issues,
  review comments, release notes and messages to the user. Research
  logs, worker task text and this repository's own agent instruction
  file are excluded from those requirements, because a dense exact register
  serves them better. A high-level design is governed prose even while it lives
  inside an otherwise excluded research log. The separate current-state
  documentation rule covers the agent instruction file as stated above.
