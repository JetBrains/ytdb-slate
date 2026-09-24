# Guidelines for editing README.md

Read this file when you edit the root `README.md`.
The README is the first page for this project on GitHub, npmjs.com, and in Google results.
Assume the reader knows software but not this project.
The reader may not have English as a first language.

## The first screen

Keep the H1 as the project name and its category.
The current H1 is `# ytdb-slate: multi-agent orchestration for the pi coding agent`.
Make Slate the subject of the first sentence and say what it is.
Explain each project term before or at its first use in the first paragraph:

- The **main session** is the interactive pi session where the user sets goals.
- A **bounded action** is focused work with a clear limit.
- A **worker thread** is an isolated pi session for an action.
- An **episode** is a structured summary of an action.

Make the first screen tell the reader what Slate does and how to start.
Use one term for each concept, as in the README definitions.
Say “worker thread”, not “worker session” or “subagent”.

## Claims and search

Make factual, verifiable claims about current behavior only.
Avoid hype words such as “powerful”, “seamless”, “effortless”, “ultimate”, and “revolutionary”.
Put planned work only in `## Roadmap` and `docs/roadmap.md`.
Mark it as planned.

Google and npm use the H1 and first paragraph for titles and snippets.
Use natural category terms such as “pi coding agent” and “multi-agent orchestration”.
Do not repeat keywords to attract search traffic.
Use descriptive headings that tell readers what a section contains.
GitHub repository search uses the repository name, the About description, and topics, not README text.
Keep the About description and topics in line with the README.
The maintainer sets the About description and topics by hand.
The npm `keywords` field must stay `["pi-package"]` (see `AGENTS.md` § Packaging rules).
Npm search therefore relies on the `package.json` `description` and the README.
The npmjs.com page shows a README change only after the next release.

## Length and structure

Target about 1,000 words or less.
Keep the current section order:

1. What Slate does
2. Quick start
3. How Slate works
4. Commands
5. Configuration
6. Safety and trust
7. Roadmap
8. Shipped docs
9. Community
10. License

Put reference material in `docs/` and link to it from the README.
A new `docs/` file needs one export in `extension/paths.ts` and an entry in the README `## Shipped docs` list.
See `AGENTS.md` § Package-content check.
Before removing a README fact that still describes current behavior, keep it reachable in the new README or in `docs/`.
Follow `docs/writing-guidance.md` § Current-state documentation rule for facts about removed or past behavior.

## Text used by checks and tests

- `contract-focus-table-sync` in `verification/resolver-checks.mjs` (near line 1903) requires exactly one occurrence of “Eleven focus areas name specific risks.” in `README.md`. It also requires a regex match for this wrapped list somewhere in the README. The list need not follow the opener, and the check does not count list occurrences:
  ```text
  They cover
  concurrency defects, data loss, security weaknesses, performance degradation,
  test-quality defects, unreadable user-facing prose, licensing exposure,
  non-local logic defects, consumer contract breaks, governing-rule defects, and
  unreported failures.
  ```
- `contract-delivery-packages` in `verification/resolver-checks.mjs` (near lines 3384-3534) requires the exact H1 above as the heading owner and the exact `docs/delivery-packages.md` list entry under `## Shipped docs`. It checks the context and heading owner of every literal `delivery-packages.md` reference across the README and shipped docs. It also rejects the stale phrases listed in `stalePackageRules` anywhere in `README.md`. See the phrase list and rejection check near lines 3518 and 3534.
- `test/delivery-reference-contract.test.ts` (near lines 23-105) requires the delivery document list entry to be present. Its fixtures check changed or duplicated reference contexts and the H1 heading owner. The “unrelated prose edit” fixture replaces “Slate sends bounded actions” and requires the replacement to change the README text. Keep that phrase present. The fixture does not require exactly one occurrence.
- `FILES_EXACT` in `verification/packaging-checks.mjs` (near line 193) lists `README.md` in the package whitelist. `pack-allowed` (near line 97) permits the README as a shipped path. Neither check asserts README prose.
- `test/coverage-gate.test.ts` (near line 751) copies `README.md` into a test repository. It does not assert README prose.

Update this list in the same change when a listed check or test changes, or when protected README text changes.
If a README edit changes text used by a check or test, update the matching check or test in the same change with approval.
Run `bash verification/run-resolver-checks.sh --repo . --strict` and `npm test` after every README edit.

## Writing rules

Follow `AGENTS.md` § Writing convention.
Follow `docs/writing-guidance.md` § Current-state documentation rule.
Find the advisory writing checker command in `docs/writing-guidance.md` § The command line.
