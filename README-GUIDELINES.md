# Guidelines for editing README.md

Read this file when you edit the root `README.md`.
The README is the first page for this project on GitHub, npmjs.com, and in Google results.
Assume the reader knows software but not this project.
The reader may not have English as a first language.

## The first screen

Keep the H1 as the project name and its category.
The current H1 is `# ytdb-slate: design-first feature development for the pi coding agent`.
Make Slate the subject of the first sentence and say what it is.
Keep the opening about the user's purpose and decisions.
Define these mechanism terms at first use in `## How Slate works`:

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
Use natural category terms such as “pi coding agent” and “design-first feature development”.
Name “multi-agent orchestration” exactly once in `## How Slate works` as the mechanism, not the product category.
Do not repeat keywords to attract search traffic.
Use descriptive headings that tell readers what a section contains.
GitHub repository search uses the repository name, the About description, and topics, not README text.
Keep the About description and topics in line with the README.
The maintainer sets the About description and topics by hand.
The npm `keywords` field must stay `["pi-package"]` (see `AGENTS.md` § Packaging rules).
Npm search therefore relies on the `package.json` `description` and the README.
The npmjs.com page shows a README change only after the next release.

## Length and structure

Target about 1,500 words or fewer.
Keep the current section order after the title and opening:

1. Who does what
2. Quick start
3. How a change works
4. How Slate differs from spec-driven development
5. What users say
6. When plain pi is enough
7. Product principles
8. How Slate works
9. Commands
10. Configuration
11. Safety and trust
12. Roadmap
13. Shipped docs
14. Community
15. License

Put reference material in `docs/` and link to it from the README.
A new `docs/` file needs one export in `extension/paths.ts` and an entry in the README `## Shipped docs` list.
See `AGENTS.md` § Package-content check.
Before removing a README fact that still describes current behavior, keep it reachable in the new README or in `docs/`.
Follow `docs/writing-guidance.md` § Current-state documentation rule for facts about removed or past behavior.

## Text used by checks and tests

The checks below protect README text. Workflow policy checks protect the owned sections in shipped documents. The four `publishing-*` merge-method fixtures use `docs/pr-publishing.md` § Merge method advice. Each fixture requires its source text to be present and its mutations to change and fail that text check.

- `contract-focus-table-sync` in `verification/resolver-checks.mjs` (near line 2281) requires exactly one occurrence of “Eleven focus areas name specific risks.” in `README.md`. It also requires a regex match for this wrapped list somewhere in the README. The list need not follow the opener, and the check does not count list occurrences:
  ```text
  They cover
  concurrency defects, data loss, security weaknesses, performance degradation,
  test-quality defects, unreadable user-facing prose, licensing exposure,
  non-local logic defects, consumer contract breaks, governing-rule defects, and
  unreported failures.
  ```
- `contract-delivery-packages` in `verification/resolver-checks.mjs` (near lines 6259-6350) requires the exact H1 above as the heading owner and the exact `docs/delivery-packages.md` list entry under `## Shipped docs`. It checks the context and heading owner of every literal `delivery-packages.md` reference across the README and shipped docs. It also rejects the stale phrases listed in `stalePackageRules` anywhere in `README.md`. See the phrase list and rejection check near lines 6331-6350.
- `test/delivery-reference-contract.test.ts` (near lines 25-255) requires the delivery document list entry to be present. Its fixtures check changed or duplicated reference contexts and the H1 heading owner (title literals near lines 215 and 219). The “unrelated prose edit” fixture replaces “Slate sends bounded actions” and requires the replacement to change the README text. Keep that phrase present. The fixture does not require exactly one occurrence.
- `FILES_EXACT` in `verification/packaging-checks.mjs` (near line 194) lists `extension`, `docs`, `README.md`, `CHANGELOG.md` and `LICENSE` in the package whitelist. `pack-allowed` (near line 265, using the permitted-path list near line 95) permits the README and changelog as shipped paths. Neither check asserts README prose.
- `test/coverage-gate.test.ts` (near line 752) copies `README.md` into a test repository. It does not assert README prose.

Update this list in the same change when a listed check or test changes, or when protected README text changes.
If a README edit changes text used by a check or test, update the matching check or test in the same change with approval.
Run `bash verification/run-resolver-checks.sh --repo . --strict` and `npm test` after every README edit.

## Writing rules

Follow `AGENTS.md` § Writing convention.
An attributed user quote with recorded permission is reproduced verbatim.
The quote is exempt from the hype-word and writing rules.
The README's own prose remains bound by those rules.
Follow `docs/writing-guidance.md` § Current-state documentation rule.
Find the advisory writing checker command in `docs/writing-guidance.md` § The command line.
