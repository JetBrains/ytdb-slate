# AGENTS.md — ytdb-slate contributor guide

## Overview

This repo is a [pi package](https://pi.dev/docs/latest/packages). It provides the **slate** extension for thread-weaving orchestration in pi. The orchestrator dispatches bounded actions to persistent worker threads. Results return as compressed episodes.

The shipped doctrine uses SMALL, MEDIUM and LARGE size grades. Ten focus areas select additional gates. Draft pull request publishing is optional.

Dispatch also carries **action-level model routing**: `router.models` in the project's `slate.json` names a CLOSED candidate list, resolved once per session, from which each action's model and effort are chosen and guarded. It is off by default: an empty list adds no candidate-routing policy, base seed, context-window substitution, billing notice, or routing doctrine rule. Per-action arguments and pre-existing live failover holds remain active. Reference: `docs/model-routing.md`, which the doctrine cites at runtime alongside the workflow/review/design docs.

- Extension entry point: `extension/index.ts`
- Shipped doctrine docs: `docs/` — `track-workflow.md`, `review-rules.md`, `design-principles.md`, `pr-publishing.md` and (since routing shipped) `model-routing.md` are cited by ABSOLUTE path resolved inside the installed package (`extension/paths.ts`)
- Default branch: `main`
- Finding tags come from slate's own adversarial reviews. This file uses `AD6`, and code comments use `AD41`, `RG2` and other tags. Each review round numbers its findings from 1, so one tag can name two different findings. The `AD6` in § Packaging rules is not the `AD6` of the tier-1 CI review. Only the pull request or the track discussion that raised a finding explains the tag. Every citation in this file therefore states the finding in words, and the tag gives the origin only.

## Dogfooding

This repo runs slate on itself from the main worktree's sources:

- `.pi/settings.json` carries the local package entry `"../"`. Project-settings paths resolve relative to `.pi`, so the entry resolves to the worktree root. A session in the main worktree therefore runs that checkout's sources without a release.
- Keep exactly one effective slate package identity. The user-scope entry is the absolute path to the main worktree, and pi deduplicates it with the project entry there. Do not add an npm slate entry or another local copy at either scope. Two distinct identities load twice and stop startup with exit 1: `Failed to load extension "<path>": Tool "thread" conflicts with <path>`.
- Migrate a machine in this exact order: first remove the slate entry from the user-scope settings file, then merge the project change to `"../"`, then add the absolute path to the main worktree back at user scope. A session started between step one and step three can exit 1 with a tool conflict. This ordering is the only safe one of the six possible orders.
- The isolated smoke test remains `pi --no-extensions -e .` from the checkout root. `--no-extensions` prevents project-scope and user-scope packages from loading beside the explicit checkout. The command is still needed when testing edits outside the live main-worktree sources.
- Development follows the package's own `docs/track-workflow.md`, with `workflow.draftPRs` enabled in `.pi/slate.json`.
- pi creates a `.pi/settings.json.lock` directory in the checkout while it reads the project settings, and then deletes it. A session or a verification run that stops abruptly can leave one lock behind. `.gitignore` therefore covers `.pi/*.lock`. You can delete an old lock safely when no session runs. When a session runs, the lock belongs to that session.

## Worktree workflow

- Run the slate orchestrator session in the main worktree. Give each change its own sibling worktree; do not develop in main.
- Dispatch every action with absolute paths into its change worktree. A relative path can resolve against main and edit the live sources.
- Run `npm ci --ignore-scripts` in every new worktree before verification or an isolated smoke test.
- Keep `research-log.md` at the change worktree root for the life of the change.
- Keep the main worktree clean. Verify that it is clean before every user review.
- After a change merges, fast-forward local `main` before restarting the orchestrator session. The restarted session then loads the merged sources.

## Build & verification

- **There is no build step, but there is a typecheck.** pi loads raw TypeScript through jiti, and it uses `extension/index.ts` as it is. No tool compiles the sources before pi runs them. jiti removes the types, and it does not check them. The typecheck is therefore the only check of the types, and it has no other purpose. `npm run typecheck` runs `tsc --noEmit -p tsconfig.json`, and it writes no output: no artifact, no `dist/` directory, and no input for a later step.

  The typecheck reads `extension/**/*.ts`, `test/**/*.ts`, `verification/probe.ts` and `verification/ci-canary.ts`. It skips `verification/*.mjs`, because that code is JavaScript without type annotations. `tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports` and `erasableSyntaxOnly`. The last flag carries a second job beyond type safety: it keeps every source under `extension/` executable by Node's native type stripping, which is how the `node:test` suite imports the shipped modules with no build step (§ Unit tests and the coverage gate). It also sets `skipLibCheck: true`, and that flag is necessary. Without it, `tsc` reports more errors, and all of them sit inside third-party `.d.ts` files under the pi SDK. This repo cannot correct those files.

  `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` stay off. This repo measured both flags, then deferred the first and rejected the second, and `tsconfig.json` records the reasons together with the two commands that re-derive the current diagnostics. It records no counts on purpose: the include list moves them, and a recorded count went stale twice, most recently when `test/**/*.ts` joined the include list. Nobody must repeat that decision without re-measuring. Every flag in the set passes on the current tree. Add a new flag together with its fix. A flag that fails makes the check unreliable, and people then ignore it.

  A passing `npm run typecheck` does NOT make the TypeScript brands (`SessionBaseline`, `OpenModel` in `extension/route.ts`) tamper-proof: TypeScript permits an assertion to a branded subtype, so `someString as OpenModel` — the exact shape that reintroduced a shipped defect while the full suite stayed green — still typechecks cleanly. The resolver checks' source-scan gates for cast shapes are therefore still load-bearing and must not be removed on the grounds that the repo has a typecheck; the two nets cover different failures, and only the source scan covers this one.
- **Automated verification exists.** CI runs five checks on every pull request, on every merge-queue candidate and on a push to `main`. A manual dispatch runs the same five. It skips patch coverage loudly because that event carries no change boundary. Each check is the same command that you run locally (§ CI). The fifth check is `npm test`. It runs the `node:test` suite under `test/` and then the patch-coverage gate. That suite unit-tests the modules the tests import (§ Unit tests and the coverage gate). It is also the one check that no longer takes about a second. It dominates CI's wall clock. Additional nets run by hand and are named below. Writing also has a focused correctness suite. `verification/writing-check-tests.mjs` tests the shipped, dependency-free JavaScript checker in `extension/writing-check.mjs`. It also tests the turn-outcome helper `measureWritingTurn` in `extension/writing.ts`. It does not unit-test the modules that `test/` leaves alone. Four tasks stay manual:
  1. **Read the full diff before you commit.** No tool does this for you.
  2. **Run the isolated-load smoke test when you must use an edit that you just made.** The command is `pi --no-extensions -e .` from the edited worktree root. The live orchestrator session runs main's checkout sources, not a sibling change worktree, and `--no-extensions` prevents another configured slate copy from loading beside the explicit path. The load check proves that the extension loads and registers its tools, but it does not prove that the tools work. Exercise tool execution, worker sessions, failover and handoff by hand here. **Never run it while the ladder runs** — § Verification ladder states what that costs.
  3. **Open an INTERACTIVE session to reach the doctrine and the router.** A headless `pi --no-extensions -e . -p "exit"` run exercises extension registration and `session_start` only, and it never builds the doctrine. slate seeds orchestrator mode only when `ctx.mode === "tui"` (`extension/mode.ts`), and `before_agent_start` returns at once while the mode is off. A headless run therefore reaches neither `buildDoctrine` nor the `getRouter()` consultation inside it, and that consultation is the only one in the doctrine. Every smoke test during the work on the routing feature missed both. A release-time accident exposed this gap.

     An automatic interactive session needs a pty. This machine has no `script(1)`, and a small Python `pty.fork` harness works instead. Use **`\r`** as the submit key, and not `\n`.

     The session JSONL holds no doctrine text. Its entries are `session`, `message`, `custom`, `model_change` and `thinking_level_change`, and the system prompt is not one of them. To verify the CONTENT of the doctrine, ask the model to repeat it, and do not grep the transcript. This gap is a smoke-test gap, and it is not a coverage gap. The `doctrine-*` checks cover the rendering, and the router checks cover the resolution. Only a live session proves that the wiring runs.
  4. **Run by hand every net that CI leaves out.** The hand-run set is:
     - the verification ladder (§ Verification ladder below).
     - the package-content check and its `--self-test` (§ Package-content check).
     - the writing checker's correctness suite.
     - the writing checker's scaling gate (§ Writing-checker nets).
     - the writing-reminder integration check (§ Writing-reminder integration check).

     Each section states its own re-run trigger. CI excludes the ladder on purpose. The other hand-run nets are not wired into the workflow. The unit tests and the patch-coverage gate are NOT in this set any more: CI runs them (§ Unit tests and the coverage gate).

### CI (`.github/workflows/ci.yml`)

CI is fast, and it needs no secret. Every check uses fabricated inputs and a plain checkout. The checks reach the network for the dependency install only, and they use no credential. They also touch no real pi state: the only harness that starts a pi session points `PI_CODING_AGENT_DIR` at an empty throwaway directory. The packaging guards reach no registry, and they pass when npm runs offline.

The checks write in three places only:

- The load check, the resolver checks and the unit-test wrapper each make a scratch directory under `TMPDIR`, outside the checkout. Each harness removes its own directory after a clean run. The load check and unit-test wrapper keep their directories when a check fails, and each prints the path.
- The packaging guards write nothing.
- pi creates a `.pi/settings.json.lock` directory inside the checkout, and deletes it again, around each read of the project settings.

CI is not hermetic beyond that, and it makes no such claim: the install fills the npm cache under `HOME`, like every other install.

The workflow uses a read-only token (`permissions: contents: read`). Four events start it: `pull_request`, `merge_group`, a `push` to `main`, and `workflow_dispatch`. It never uses `pull_request_target`. The job stops after 15 minutes (`timeout-minutes: 15`), and the workflow pins each third-party action to a commit SHA. The job matrix pins **Node 22.23.1 and Node 24.18.0**: those are the exact versions on which native TypeScript execution, LCOV, `stripTypeScriptTypes`, physical-line DA emission, directive matching and the full suite were measured. A floating major would take experimental APIs beyond the evidence silently; an exact pin instead costs a manual re-measurement and workflow edit for every accepted Node patch. pi needs node 22.19.0 or later, and the two pins still exercise both current LTS lines.

The five checks follow. Each command reproduces its check on a laptop after `npm ci --ignore-scripts`; locally `npm test` derives a merge-base with `main`, while CI always passes the event's explicit base SHA:

| check | local command |
| --- | --- |
| typecheck | `npm run typecheck` |
| packaging guards | `bash verification/run-packaging-checks.sh --repo .` and `bash verification/run-packaging-checks.sh --repo . --self-test` |
| extension load check | `bash verification/run-load-check.sh --repo .` |
| pure-resolver checks | `bash verification/run-resolver-checks.sh --repo . --strict` |
| unit tests + patch coverage | `npm test` |

**Keep `--ignore-scripts` on the install.** The pinned pi SDK is a devDependency, and its dependency tree declares install scripts: `@google/genai` (preinstall) and `protobufjs` (postinstall). `@earendil-works/pi-coding-agent` holds a copy of each package in its shrinkwrapped tree, so `package-lock.json` carries four entries with `hasInstallScript`. A plain `npm ci` runs all four scripts on every install. CI needs none of them, so the flag keeps third-party code out of the job. npm creates `node_modules/.bin` without those scripts, so the `pi` and `tsc` launchers appear in both installs.

**How the harnesses find pi.** Three of the five checks need a pi binary, and all three start with the same two steps:

1. `PI_BIN`, when you set it. The harness prints `NOTE` lines for this case. `PI_BIN` is an override for an expert user, and it is not a security boundary.
2. `node_modules/.bin/pi` in the checkout. The install above creates it, and a CI runner has no other pi.

The three harnesses then differ on purpose. The **resolver checks** and **peer linker** accept a pi from `PATH` as a last choice, and they apply no version guard. The resolver checks borrow only the jiti transpiler inside pi; an old jiti can only fail to transpile the sources, and then the run stops with no summary. The peer linker instead imports the SDK copies bundled with that pi, so choosing the checkout-local exact pin before `PATH` is load-bearing: CI has both paths available through npm, and must not silently take another global installation. A `PI_BIN` override remains explicit and prints a note.

The **load check** accepts no pi from `PATH`, and it also requires the same version from `pi --version` as the `@earendil-works/pi-coding-agent` pin. pi's rpc output shapes are the evidence for its checks, and a new shape can look like "no events" and pass in silence. The verification ladder keeps its own rule: it needs `pi` on `PATH`.

The three CI harnesses (the packaging guards, the load check and the resolver checks) share one exit-code contract:

| exit code | meaning |
| --- | --- |
| **0** | every check passed |
| **1** | a check failed |
| **2** | the harness refused to start: a bad invocation, a missing tool, or a failed precondition |

An exit code of 2 gives no verdict for any check, because the harness verified nothing. The build still fails. One case of exit 2 reports a real defect on purpose: the load check refuses to start when the checkout has no `extension/index.ts`. pi drops a nonexistent entry from `pi.extensions` in silence, so every check would otherwise pass on an empty session.

The typecheck stands outside this contract. `tsc` uses its own exit codes. With the pinned TypeScript, a *type error* gives exit **2**. An unknown compiler option, or a missing `tsconfig.json`, gives exit **1**. Read an exit code from `tsc` as a `tsc` code, and never as a refusal.

**Read the exit code first when a check fails.** An exit code of 2 points at the invocation, the environment or a precondition. All three harnesses print the same first words: `verification: refused to start — <reason>`. The reason names the missing tool, the bad path, the version mismatch or the absent file, and it gives a remedy where one exists. You can therefore grep a CI log for that phrase.

That phrase belongs to the three wrapper scripts. `verification/packaging-checks.mjs` and `verification/resolver-checks.mjs` print their own refusal in the form `<module>.mjs: …` when you run a driver directly. Use the wrapper scripts for that reason.

An exit code of 1 reports a real finding. The `CHECK … FAIL — <detail>` line explains the failure:

- **typecheck** — `tsc` prints `file(line,col): error TS…`. Correct the source. A new run costs about 2 seconds.
- **packaging guards** — the detail names the manifest field or the shipped path that broke a rule. A failure under `--self-test` means the opposite: a guard no longer detects its own violating mutation. Correct the guard, and keep the manifest.
- **load check** — a failing run that started pi prints the raw rpc streams in its own output. It prints one section for each stream, stderr before stdout, and it cuts each stream at a limit. It also keeps the streams in the scratch directory (`artifacts: …`), so the evidence survives a CI job that deletes that directory. The detail line summarises those streams, so read the streams first. A pi run must happen before the streams appear, and the identity of the failed check does not matter. A full run that fails either disk-only settings check still prints the streams of the earlier pi runs. A run limited to `T4`, `T5` or both prints none.
- **resolver checks** — the detail line repeats the expectation that broke, and the harness prints the same sentence for a pass, for example `CHECK memoization FAIL — createWorkerExtensionResolver walks the registry exactly once across repeated calls`. An `observed:` line under it gives the value that the check saw, for example `observed: {"walked":3}`. The harness removes its fixtures on exit, but the pipeline is pure and deterministic. Read the body of that check in `verification/resolver-checks.mjs`, then run the harness again.

A NOT RUN from the ladder is neither a pass nor a fail. `verification/README.md` holds the table of the action for each one.

The original four checks take about **five seconds** on a warm machine. The unit tests dominate the enlarged CI set. One machine gave these times:

| check | time |
| --- | --- |
| typecheck | 2.2 s |
| packaging guards, each pass | 0.3 s |
| extension load check | not remeasured (it starts three real pi processes) |
| pure-resolver checks | 0.2 s |
| unit tests + patch coverage | ~35 s on Node 22.23.1; ~19 s on Node 24.18.0 |

Run all five checks before you commit.

**Re-run obligations.** The two sections below use the same form:

- **Run the packaging guards again after a change to a packaging-relevant manifest field.** Those fields are the `files` whitelist, `peerDependencies`, `dependencies`, `keywords` and `scripts`. Run them again also after you add, move or delete a file under `extension/` or `docs/`. The pack layer asserts the *real* file list from `npm pack`, and not the manifest. The guard asserts the `files` whitelist by **exact equality**, so a deliberate change to the whitelist must update `FILES_EXACT` in `verification/packaging-checks.mjs` **in the same commit**. Run `--self-test` too: it runs every guard against the real input with one violating mutation, and it requires a failure.
- **Run the load check again after a change to extension loading, to tool or command registration, or to `session_start`.** Run it again also after a change to this checkout's `.pi/slate.json` or `.pi/settings.json`. Those failure modes have no other signal (see § How extension-load failures surface). Two checks read the config and package settings directly from disk, because pi and slate can drop invalid input in silence. The load check answers two conditions with exit 2 instead of a FAIL report:
  - **A checkout without `extension/index.ts`** stops the run. pi drops a nonexistent entry from `pi.extensions` in silence, and every check then passes on an empty session. A checkout without `verification/ci-canary.ts` stops the run for the same reason.
  - **A mismatch between the pin and the installed pi** stops the run. The message carries the remedy `run 'npm ci --ignore-scripts'`, which is the install that CI runs. The rpc output shapes hold for one pi version only.
- **The verification ladder stays outside CI on purpose** (issue #24). It takes about 3 minutes, and most of that time is wall-clock wait in timing-sensitive rungs. It needs GNU coreutils, and it refuses to run as root. On a slow machine, or on a machine without the optional tools, it reports NOT RUN instead of PASS. A required check with that behaviour gives unreliable results, so the ladder stays a check for a person to read. Run it as § Verification ladder describes.

### How extension-load failures surface (pi 0.83.0)

An earlier version of this file said that pi exits 0 when extension loading fails. It also said that success is the ABSENCE of a `Failed to load extension` line on stderr. That statement is **wrong**, and issue #23 came from it. The lists below record measurements against the pinned pi 0.83.0.

pi **reports** each failure below on stderr as `Failed to load extension "<path>": <detail>`, and it **exits 1**:

- a syntax error;
- a broken import that the module uses;
- a throw at the top level or inside the factory function;
- a module without a default export;
- `-e <path>` for a path that does not exist, with the detail `Extension path does not exist`;
- `-e <dir>` for a directory that resolves to no module at all, with the detail `Cannot find module '<dir>'`. Such a directory has no `pi.extensions`, no `main` and no `index.*`.

A directory without a `pi` field in `package.json`, or without a `package.json`, still loads correctly when the directory resolves; a bare `index.ts` is enough. For each failure above, the exit code is as reliable as the string.

pi **stays silent** for each failure below: it exits 0, and it prints neither marker.

- An entry in the `pi.extensions` list of a package points at a **file that does not exist**. pi drops the entry without a word, and it starts with no extension. A real install has this shape, so this case matters most.
- A hook for `session_start` **throws**. In rpc mode pi reports an `extension_error` event on **stdout**. In text mode pi prints `Extension error (<path>): <msg>` on **stderr**. Neither string matches `Failed to load extension`, and the throw leaves the exit code at 0 in rpc mode.
- A **tool registration disappears**. pi prints no diagnostic at all: it exits 0, its stderr holds 0 bytes, and the `/slate` command still works.

`verification/run-load-check.sh` has 14 checks with roster `L1 L2 L3 L4 L5 L6 L7 L8 T1 T2 T3 T4 T5 T6`. `L1` reads the exit code. `L2` reads both stderr markers. `L3` reads the `extension_error` channel on stdout. `L4` and `L5` read the registered tool set through the positive control in `verification/ci-canary.ts`. `L6` reads which copy of slate pi loaded. `L7` exercises the `/slate on` command round-trip, and `L8` proves that the run did not change `.pi/npm`. `T1` proves the trusted run started with trust, `T2` reads sanitizer warnings, and `T3` proves that trusted run did not change `.pi/npm`. `T4` reads `.pi/slate.json` from disk and checks its JSON shape. `T5` reads project settings from disk and asserts that the slate entry is a local path resolving to this package with every declared extension entry file present. `T6` starts a real trusted session against a scratch package copy and asserts one slate load, the three dispatch tools and no duplicate-load conflict.

**A pipeline hides the exit code of a process, and that trap probably produced the wrong claim.** `$?` after a pipeline gives the status of the **last** command, and not the status of the piped process. A broken extension shows the difference. A direct run of pi exits `1`. The same run as `pi … 2>&1 | head -1` gives a `$?` of `0`, while `${PIPESTATUS[0]}` for that pipeline is still `1`, and `set -o pipefail` makes the pipeline exit `1`. Read a real exit code in one of three ways: use no pipe, read `${PIPESTATUS[0]}`, or run `set -o pipefail` first. Every script in `verification/` runs `set -o pipefail`.

  **Run the typecheck after ANY TypeScript change.** That trigger is wide on purpose, and the deep nets below use a narrow trigger instead. The run takes about 2 seconds, and it checks every file that it covers in one pass. Spend no time on a decision about the type relevance of your edit.

  The silent-failure nets are the ladder, pure-resolver checks, packaging guards, extension-load check, unit tests with the patch-coverage gate, and package-content check. They also include both writing-checker nets and the writing-reminder integration check. The sections below define their scope.

  This inventory intentionally has no total. Earlier totals went stale twice. Add each new net to this inventory when you add it.

  The typecheck is NOT one of these nets. It sees shapes, while each listed mechanism can fail with correct types. Run every net that covers a shared change. For example, `extension/writing-check.mjs` implicates its correctness suite, scaling gate and the resolver suite's `writing-*` families.

  `failover.ts`, `episodes.ts`, `worker.ts` and the router use the model-spec helpers in `extension/state.ts`. `failover.ts` and `handoff.ts` drive `extension/base-model.ts`, and those two modules are the switch sites of the ladder. A change to either module therefore implicates BOTH nets.

### Verification ladder (global model defaults across slate's model switches)

`verification/run-ladder.sh` is the deepest regression net in this repo. It is not the only net. § CI names the five checks that run on every pull request. The sections below add the package-content check, the writing checker's two nets and the writing-reminder integration check. The ladder is the only net that touches the global model-default machinery. It covers:

- `extension/model-default.ts` and both switch sites (`extension/failover.ts` failover, `extension/handoff.ts` handoff adoption): the per-key restore rule, the untrustworthy-read stand-downs, the retry budget and the reporting channels;
- `extension/worker.ts`'s worker-session settings isolation, in rung `WK1`: a **worker-side per-dispatch model AND effort switch** — what every routed action performs — writes zero bytes to the global settings file and does not survive into a reopened session as a sticky default. It is the only automated net for that guarantee, and the only rung that opens a worker session at all.

Everything runs against fake offline providers in a throwaway agent directory, so real pi settings are never touched (the run fails if the real file changes).

**RUN THE LADDER ALONE. Any other pi process that shares the real agent directory can make its `SAFE` check lie.** This remains the default. A process redirected to another directory through `PI_CODING_AGENT_DIR` cannot touch the watched file, but the harness refuses an inherited value because it must own that redirect. The final `SAFE` check compares the REAL `~/.pi/agent/settings.json` before and after the run, and it compares size and mtime as well as the hash. It therefore reports `SAFE FAIL — REAL SETTINGS FILE CHANGED` when a pi you started yourself — the isolated-load smoke test of manual task 2, an interactive session, or a dogfooding session in another terminal — rewrites that file mid-run. Measured shape of the false alarm: an identical hash and size with only the mtime moved, under a summary that reads `26 pass, 1 fail`. Read the hash first. Equal hashes mean a concurrent writer, not a leak, and the fix is to stop every other pi that shares the real agent directory and rerun the ladder, because a `SAFE FAIL` voids every rung above it and cannot be dispositioned by argument. Sequence the two nets; never overlap them.

A live main-worktree session may remain open only under the quiet-session variant. Quiet means that the existing session stays idle for the whole run: do not start or restart it, switch its model or thinking level, open its settings or theme panel, change packages, or trigger failover. Worker sessions use an isolated in-memory settings manager, but do not dispatch new work from the live session while the ladder runs. If `SAFE` fails, read the reported hash first, stop every pi process that shares the real agent directory, and rerun the ladder alone. An equal hash and size with only mtime changed identifies the measured concurrent-writer false alarm, but it does not rescue the run. Every `SAFE FAIL` still voids every rung above it.

- Run it with `bash verification/run-ladder.sh --repo .` (~3 min; `--only <ids>` for a subset). Not as root, and needs GNU coreutils. Exit 0 means nothing failed and the real settings file is unchanged — rungs can still report NOT RUN, so read the lines; automation should pass `--strict`, which makes any NOT RUN fatal.
- **Re-run it after any change to `extension/model-default.ts` or to either switch site**, and **after any change to how a worker session is opened or switched** — `extension/worker.ts`'s settings manager, the model/`thinkingLevel` options it passes to `createAgentSession`, or the per-dispatch switch in `threads.ts`'s `applyRoute` (`WK1`). Both mechanisms fail silently when they regress — the switch still works, and the damage lands in the user's own pi configuration — so a passing smoke test proves nothing about either. Details, rung table and the timing-sensitive rungs: `verification/README.md`.

### Pure-resolver checks (worker extensions + doctrine rules + model router + dispatch guards + state sanitizers + profile table + writing wiring)

`verification/run-resolver-checks.sh` is the automated net for the repo's PURE pipelines. It loads and exercises the modules listed below against fabricated in-memory registries, fabricated profile tables, fabricated events, fabricated doctrine inputs and a fabricated compaction predicate — no pi session, no real state — in ~1 second. How many checks that is, is the `roster` line's business and is deliberately NOT transcribed here: it moves with every check added, and both this file and `verification/README.md` have carried stale counts before. The roster asserts that every expected id reported exactly once, and the summary prints the identity (`N result lines = N−1 expected checks + this roster audit`), so a deleted, duplicated or crashed check cannot read as a clean exit — read those two lines, not a number in this file:

- `extension/worker-extensions.ts` — the worker-extension resolver (candidate filtering, load-unit selection, barriers, matching, memoization) and the doctrine rule it feeds in `extension/mode.ts`;
- `extension/mode.ts`'s **action-routing doctrine rule** (`doctrine-*`, driven through `registerSlateMode`'s `before_agent_start` handler with a fabricated resolution): that a router-OFF session gets byte-identically nothing, that an UNTRUSTED project gets no routing rule even with `router.models` fully configured (SE3's trust re-gate — defence in depth, so its removal has no visible symptom), that the conditional tail rules are numbered by position, its **injection safety** — the rule deliberately bypasses `sanitizeForDoctrine` (that sanitizer strips `|`, which would destroy the table), so the narrow `cell()` is the entire defence and the checks attack it structurally — that no research trace tag or `nonPreferred` reason leaks into the prompt, and a **size budget**, because this text is injected into every session's system prompt and paid for on every turn. The group is voided by `profiles-load`: one of its checks renders the real shipped table;
- the shipped workflow contracts. These pin complete safety-floor and focus-table content, plus a unique canonical project-test-artifact definition. They also cover SMALL fast-path grants and exclusions, both composite-review sections, retired-role absence, and unique named headings across all five workflow documents.
- `extension/model-router.ts` — the model router: the `router` config sanitizer, candidate resolution (drops, ordering by preference/tier-sourcing/tier/price, the `nonPreferred`-aware base-model pick, the W1/W3/failover-coverage warnings, dedup, memoization) and the dispatch-side effort predicate;
- `extension/route.ts` — the route planner (`route-*`): the SAFETY CORE of action-level routing, i.e. the argument check the code numbers guard 0 (effort vocabulary) and the seven dispatch guards 1–7 (list membership on both router states, per-model ladder validity, evidence gap, API-rejected level, the never-blocking context-window substitution, long-context billing, and the failover carve-out) plus the base-effort seed. It was extracted from `threads.ts` into a pure module for exactly this harness, because a guard that silently stops guarding still "works": the dispatch runs and an episode is written;
- `extension/state.ts` — the canonical model-spec vocabulary (`spec-*`: `isModelSpec` / `splitModelSpec` / `describeSpecDefect` / `describeConfusables`), which `failover.ts`, `episodes.ts`, `worker.ts` and the router all share, plus the single-spec config-key sanitizer (`sanitizeEpisodeModel`) — AND the **snapshot record sanitizers** (`state-*`: `sanitizeThreadRecord` / `sanitizeEpisodeRecord`, BG26), which are re-run over the user's whole thread and episode history at every session restore and are now pinned: a MISSED repair throws out of the `thread` tool, a FALSE one silently destroys a thread the user still needs;
- `extension/base-model.ts` — the orchestrator base-model tracker (`base-*`): the pure reducer deciding which model switches move the base model new worker threads inherit (seeding, slate's own declared switches, user/cycle/restore sources, handoff adoption, stale declarations and their one-event grace, switches in flight, and a setter that throws). Driven with fabricated `model_select` events through the declare/observe/settle protocol — the module has no clock, so nothing sleeps and no timer can fire after teardown;
- `extension/episodes.ts` (`episode-*`) — episode compression, loaded through a SECOND loader instance with the pi packages aliased to local stubs, since it imports `@earendil-works/pi-ai` (a peer dependency this repo does not install). The module and everything it imports from this repo are real; only the SDK boundary is faked;
- `extension/model-profiles.ts` — STRUCTURAL invariants of the shipped table only (id/alias resolvability, ladder vs measured/gap coverage, price-schedule shape, tier range, freezing). Never a research number: those are a review concern, and a refresh must not have to touch this suite;
- the **writing wiring** spans several modules. `extension/writing.ts` owns the config sanitizer and `measureWritingTurn` outcomes (`writing-config-*`). `extension/mode.ts` owns the writing status gates and doctrine rule (`writing-status-*`, `writing-doctrine-*`). The reminder policy and mode handlers are `writing-reminder-*`. The shipped command is imported and spawned by `writing-checker-*`. The worker preamble gate spans `extension/worker.ts` and `extension/threads.ts` (`worker-preamble`). Reminder checks cover the frozen roster, rendering, cadence, gates, state transitions, retry paths, runtime-only state, effective-budget clamp and real handoff ordering. Two bounds meet here. `writing-status-cap-visible` covers the 16 KiB turn bound. `writing-status-cap-skip` covers the checker's 1 MiB input cap. The checker module has two nets of its own.

- Run it with `bash verification/run-resolver-checks.sh --repo .`. The harness needs `node` and `mktemp` on `PATH`, and it resolves pi itself, so **`PATH` does not need pi** (§ CI). It prints one line for each check, an `observed:` line under a failure, a `roster` check that every expected check reported, and then a summary. Pass `--strict` in automation, because it makes any NOT RUN fatal. CI passes it.
  - Exit 0 means that every check passed.
  - Exit 1 means that a check failed or went missing.
  - Exit 2 means that the harness refused to start.
- **Re-run it after any change to a covered module or source path.** Covered production modules are:
  - `extension/worker-extensions.ts`, `model-router.ts`, `route.ts`, `model-profiles.ts`, `base-model.ts` and `episodes.ts`.
  - `extension/writing.ts`, `writing-reminder.ts` and `writing-check.mjs`.
  - The worker preamble or config plumbing in `extension/worker.ts` and `extension/threads.ts`.
  - `extension/state.ts` spec helpers or snapshot sanitizers.
  - `extension/handoff.ts` reminder force ordering.
  - `extension/mode.ts` doctrine rendering, writing status or reminder wiring.

  Doctrine rendering is an injection surface and per-turn cost that only this suite watches. A `route.ts` guard change is the highest-stakes case. Re-read `threads.ts` when a guard input changes because the harness fabricates those inputs. Changes to shared `state.ts` helpers also need the ladder. Router errors can remain invisible while dispatch still works, so a smoke test proves nothing. `verification/README.md` records the checks and mutation method.
- It imports `extension/worker.ts` for the preamble builder and reads the prompt/config plumbing in that module and `extension/threads.ts`; nothing else in either module is covered. The worker-session load path — the allowlist-mode extension load, the `excludeTools` deny list that keeps slate's dispatch tools out of a worker, and the post-load collision re-check — is out of its scope. Exercise those with the isolated-load smoke test (`pi --no-extensions -e .`) above after changing `extension/worker.ts`, and the ladder's `WK1` rung for that module's settings isolation. It likewise stops at the PURE boundary: it proves what the planner DECIDES, not what `threads.ts` does with a verdict (applying the switch, raising a tool error, aborting without an episode, remembering the long-context notice). Those are separate mechanisms; the ladder's `WK1` rung covers one slice of the first.
- **Doctrine size figures are install-path dependent, so compare portable counts.** The doctrine embeds four to seven absolute docs paths. Each docs-directory character therefore costs four to seven rendered characters. `doctrine-budget` removes each docs-directory occurrence while keeping filenames. Exact checks pin each fixture's occurrence count. `docs/context-budget.md` defines the same convention, and `docs/model-routing.md` defers to it. Rows using the same fixture and basis MUST agree across `docs/context-budget.md` and `verification/README.md`. A different basis must be named explicitly. Deliberate wording, roster, cap or fixture changes require fresh renders. Update resolver exact expectations and every published figure in the same commit.

### Writing-reminder integration check

`bash verification/run-writing-reminder-check.sh --repo .` starts one real pi
session against a deterministic in-process fake provider. Two parallel canary
tool calls must produce one hidden reminder steer. The next provider call must
receive it. Session JSONL must persist one custom message with `display: false`.
Both tool results must equal the exact one-block content shape.

The harness requires `node`, `mktemp`, GNU `timeout`, `mkdir`, `rm`, `date`,
`env`, `cat`, `tr` and `sed`. GNU `timeout` supplies the required
`--kill-after` option. The selected pi CLI must match the exact devDependency
pin.

The harness resolves every scratch path physically and rejects a scratch root
inside the checkout. It creates a trusted project, agent directory, home and
temp directory under that root. The child starts through `env -i`. Only explicit
throwaway values, a minimal `PATH`, dead proxy settings and canary paths cross
the boundary.

`PI_OFFLINE=1` keeps pi startup offline. The fake provider performs no network
operation. This is not a network sandbox because reviewed extension code can
still open raw sockets.

The canary uses a 1,000,000-token model window and reports 25,000 input tokens.
The project config sets a 200,000-token budget and `remindPercent: 10`. The
correct 20,000-token interval fires, while an incorrect 100,000-token interval
does not. This makes the effective-budget path load-bearing.

The pi phase is about one second on the reference machine. The wrapper's observed
wall clock is around two seconds. These figures describe one machine, not a speed
promise. GNU `timeout` sends TERM after 60 seconds and KILL five seconds later.

Exit 0 means every assertion passed. Exit 1 means a check failed. Exit 2 means
the harness refused to start. A failed run keeps its scratch directory and
inlines pi stderr and stdout. A clean run removes the directory.

This net is outside CI, the load check and the ladder. It proves the real
hook, steer, provider and persistence path. It proves `display: false`
structurally, not visual TUI invisibility. Check that presentation manually.

Re-run it after these changes:

- Requirement text, rendering, cadence or gates in `extension/writing-reminder.ts`.
- Reminder config in `extension/writing.ts`.
- Reminder hooks or reset ordering in `extension/mode.ts`.
- The handoff `forceNext` assignment in `extension/handoff.ts`.
- Custom-message type, options or steer delivery.
- The canary, harness, pi pin, RPC shape or JSONL shape.

A change to `extension/handoff.ts` still requires the full ladder. Run the
pure-resolver checks for reminder policy, config, mode, doctrine or ordering
changes.

### Package-content check (package-resolved runtime files)

Run both package-content commands:

- `node verification/package-content-check.mjs --repo .`
- `node verification/package-content-check.mjs --repo . --self-test`

The normal check runs `npm pack --dry-run --json --ignore-scripts`. It derives every exported extension command and document path from `extension/paths.ts`. It recursively enumerates every Markdown file under `docs/`. It also recursively enumerates `.mjs` files under `extension/` whose first line is exactly `#!/usr/bin/env node`.

That shebang is the runtime-command criterion. Helpers without it need no command export. Every document and command needs exactly one export. Every exported runtime path must appear in the publish set. The check also validates named path imports in `extension/mode.ts`.

The self-test uses temporary fixtures outside the checkout. It proves recursive nested-command discovery, helper exclusion, and the three required missing-roster findings. Isolated subprocesses prove help works without TypeScript and real analysis refuses missing TypeScript with exit 2. Exit 0 means all checks passed. Exit 1 means a real roster mismatch, missing packed runtime file, or escaped mutation. Exit 2 means a bad invocation, unavailable tool, parse failure, or failed precondition.

- **Re-run both commands after adding, moving or deleting a Markdown file under `docs/`.** Run both after adding, moving or deleting a shebang-bearing `.mjs` command anywhere under `extension/`. The same rule covers runtime path exports. Run both after a `package.json` `files`-whitelist change. Run both after a path import change in `extension/mode.ts`, and before release.
- The check covers package presence and roster completeness only. The resolver suite still covers doctrine content and rendering.
- **It overlaps the CI packaging guards.** The overlap is not yet consolidated. Both read the file list from `npm pack --dry-run`. Both require doctrine documents to ship. The package-content check derives the complete Markdown roster and recursive shebang-command roster independently, then requires matching exports. `pack-doctrine-docs` scans `extension/*.ts` for document joins instead. The package-content check is also the only net that requires each shipped runtime command by roster. Merging the nets is reasonable future work. Until then, run both and both self-tests.

### Writing-checker nets (correctness suite + scaling gate)

`extension/writing-check.mjs` is the shipped writing checker and the only module with two nets of its own. It has them because it is called from a HOT path: `extension/mode.ts`'s `turn_end` hook runs it synchronously on the completed assistant message, so its wall clock is the TUI's. `WRITING_TURN_MAX_BYTES` (16 KiB of assistant text, in `mode.ts`) is what keeps a pathological input away from that hook — the command's own cap is 1 MiB, three orders of magnitude higher, and only the command can reach it.

- `node verification/writing-check-tests.mjs` — CORRECTNESS: the rules, source offsets (BG2), the caps, report and file-input safety, command modes, the five hand-written scanners against the regexes they replaced, and `extension/writing.ts`'s turn outcomes. Under 1 s, machine-independent. Exit 1 on any failure. It is fail-soft (one failure does not hide the rest) and ends with a **roster audit** against an `EXPECTED` list, so a deleted, duplicated or crashed test cannot exit 0. Any test added, renamed or removed must update `EXPECTED`. Its test count and test numbers are the run's business and are deliberately NOT transcribed here or in `verification/README.md`: both were, and both went stale.
- `node verification/writing-check-scaling.mjs` — GROWTH: nothing in that module may grow faster than linearly. ~18 s, wall-clock. It is a separate file on purpose, so a timing assertion never makes the correctness suite read as machine-dependent.
- **Re-run BOTH after any change to `extension/writing-check.mjs`**, and the scaling gate in particular after adding or editing a REGEX, which is the change that reintroduces the class. Re-run the correctness suite and pure-resolver checks after a change to `extension/writing.ts`. Three reviews found six superlinear paths in the checker while every correctness net stayed green — the findings were right and the module was slow, which is precisely the failure a correctness suite cannot see. The gate's `roster` refuses an unclassified new regex literal by name, and its `canary` fails if the thresholds stop discriminating.

### Size-grade regression suite

`node verification/size-grade-tests.mjs` is the regression suite for the shipped `extension/size-grade.mjs` command. It covers grade boundaries, every declared source extension, binary numstat records, configuration safety, Git failures and output formats. The suite runs first inside `verification/run-tests.sh`, so `npm test` and `npm run test:coverage` execute it before the TypeScript tests and coverage gate. The standalone `npm run test:size-grade` script provides a discoverable focused command. `run-tests.sh` refuses to start with exit 2 when the suite file is absent, so CI cannot silently skip this net.

Run `node verification/size-grade-tests.mjs` after any change to `extension/size-grade.mjs` or `verification/size-grade-tests.mjs`. Run `npm test -- --base <ref>` after changes under `extension/`, `test/`, `verification/run-tests.sh` or `package.json`. The wrapper forwards `--base`, `--no-gate`, and threshold arguments to the existing coverage workflow.

### Unit tests and the coverage gate

`npm test` runs `verification/run-tests.sh`: it runs the size-grade regression suite, then `verification/link-peers.sh`, then the `node:test` suite under `test/`, then the patch-coverage gate in `verification/coverage-gate.mjs`. It needs `node`, `git` and a pi. The linker resolves `PI_BIN`, then the exact-pinned `node_modules/.bin/pi`, then `PATH`, and deliberately refuses to start without one.

**CI runs this net on both exact-pinned Node legs.** The checkout uses `fetch-depth: 0`, because the gate measures a COMMITTED `<base>..HEAD` diff. The base is event-specific and explicit. `pull_request.base.sha` against GitHub's synthetic PR merge commit measures that PR candidate. `merge_group.base_sha` against the queue's synthetic head measures the queued candidate. `github.event.before` against a push head measures that push to `main`.

A missing, all-zero, absent or HEAD-equal base exits 2. `workflow_dispatch` has no event change boundary. It runs the tests with `--no-gate` and emits a GitHub warning plus a job-summary section. It does not invent a diff or pass silently.

**CI keeps a WARN green but makes it prominent.** The small-denominator policy exists because a percentage verdict is not meaningful below 20 changed branches; turning WARN into FAIL would enforce the percentage the policy rejects. The test step therefore keeps exit 0, emits a GitHub warning annotation, and copies the OVERALL/WARN/VERDICT lines into the job summary with the instruction to record a manual disposition on the pull request. A green check is not that disposition.
- **The harness adds no test-only dependency and no publish payload.** It uses Node built-ins, shell, `git`, the SDK bundled with pi, and the exact-pinned `typescript` devDependency, which now has TWO consumers: `npm run typecheck` and the gate's executable-line classifier. `test/`, `verification/` and `tsconfig.json` stay outside the `files` whitelist (§ Packaging rules), so no part of this reaches a consumer install.
- **Native execution depends on an ERASABLE-SYNTAX invariant, and the compiler enforces it.** There is still no build step: stable native type stripping lets Node execute the TypeScript tests and every extension module they import directly, but it handles erasable syntax only. Constructor parameter properties are not erasable and were the single construct that would have forced `--experimental-transform-types`; this change replaced them in `extension/state.ts` and `extension/threads.ts` with explicit fields. Keep `erasableSyntaxOnly: true`: `npm run typecheck` now rejects a parameter property ANYWHERE under `extension/`, including in a module no test imports. Without that compiler guard, such a module passes both the typecheck and the tests, then throws when a real pi session loads it. (`--experimental-test-coverage` stays isolated in the wrapper, because Node's native LCOV API is separately still experimental.)
- **The two SDK import mechanisms have different jobs.** The ordinary path is `link-peers.sh` above: it resolves pi's own bundled copy of every declared SDK peer, replaces any installed package or stale link at the local target, symlinks the pi copies into `node_modules`, and verifies every resulting target. That is zero stub code, it keeps coverage clean, and it tests against the SDK the installed pi runs. Treat the alternate `verification/test-hooks.mjs`, `verification/test-resolve-hooks.mjs` and `verification/stubs/*.mjs` path as INTENTIONALLY DORMANT scaffolding until a test invocation activates it with `--import ./verification/test-hooks.mjs`; the absence of that preload is not evidence that the scaffold is dead. A test that must CONTROL SDK behaviour, scripted failure injection for example, uses the preload so `module.register()` maps peer imports to the mutable local stubs.
- **The floor is 85% LINE AND 85% BRANCH patch coverage, measured on the committed `<base>..HEAD` diff rather than on the repository; both floors are independent.** This is a FLOOR, not a target; the wrapper prints the configured floors and the gate prints the live numerators, denominators and percentages on every run. Branch coverage is the load-bearing metric for concurrency work, because the defects at issue are untaken paths — a waiter never woken, a join that throws, an abort arriving mid-flight — which line coverage does not distinguish. Coverage is not evidence by itself: a test that calls a function and asserts nothing can execute every measured path and still be worth nothing. A test earns its place only if it fails when the behaviour regresses.
- **Executable-line classification is SOURCE-authoritative; LCOV is coverage evidence only.** Node emits a DA record for EVERY physical line of a loaded file, including blanks, comments, JSDoc, interfaces, type-only imports and overload signatures, while a coverage-disable region can remove DA from genuinely executable code. DA presence therefore does not prove executability, and DA absence does not disprove it: source decides whether an added line is COUNTED, and LCOV decides whether that counted line is COVERED. The gate erases types with `stripTypeScriptTypes`, then classifies the stripped JavaScript with the exact-pinned TypeScript parser (`ts.createSourceFile(..., ScriptKind.JS)`) and a JSDoc-excluding leaf-token walk. The repo owns NO bespoke string/template/regex lexer; preserve that invariant, because the deleted lexer produced repeated defects in consecutive fixes. Type erasure remains REQUIRED rather than subsumed by the AST: the raw TypeScript AST was measured to over-include type-only lines and inflate the denominator.
- **Classifier uncertainty fails closed by forcing ZERO hits.** A missing `typescript` devDependency is a guarded infrastructure error and exits 2; non-erasable syntax rejected by `stripTypeScriptTypes` also exits 2; a parser diagnostic or a classifier exception marks the file void, counts every added line, and assigns each one zero hits. `erasableSyntaxOnly` is therefore a shared boundary for native test execution AND for gate classification, not merely a test-runner convenience. Do not replace the last rule with “assume executable and use DA”: covered comments commonly carry positive DA hits, so that intuitive fallback has already produced a false PASS. One known boundary remains: a `.d.ts` file using `export =` hard-exits 2 instead of being classified as non-executable; no such file exists in this repo. The TypeScript parser roughly doubles gate runtime and raises peak memory, an accepted dev-tooling cost; re-measure it by running the same gate command with the same refs and fresh LCOV under `/usr/bin/time -v` on the revisions being compared, not by recording a duration here.
- **Small branch denominators do not support a hard percentage verdict.** With one branch uncovered, denominators 5 and 6 produce 80% and 83.3%, below the floor, while 7 produces 85.7%, above it. The gate therefore WARNS instead of enforcing the branch floor below 20 changed branches; at 20 or more it enforces 85%. A zero-branch diff is NEVER auto-passed: it also warns. The gate always prints both denominators. A WARN is not acceptance: inspect the changed paths and the denominator, record the manual disposition (including why a small or zero denominator is adequate), add tests for any unjustified uncovered or unmeasured path, and do not report PASS. `run-tests.sh` preserves the distinction as `RUN VERDICT: WARN` even though WARN exits 0.
- **Locally the base is a merge-base with your `main` REF, so a stale ref silently changes the numbers.** `run-tests.sh` prefers `refs/heads/main`, then `origin/main`. A local `main` left behind while the remote moved therefore makes the diff include every commit that landed on `main` since, and the gate then measures other people's code against this suite: a real run in that state reported a 276-line denominator and `VERDICT: FAIL` for a change whose own denominator is 23. Nothing is wrong with the gate when that happens. Fetch and fast-forward `main`, or pass `--base <sha>` explicitly, which is what CI always does.
- **The gate sees committed changes only.** Uncommitted in-scope files are invisible to its `<base>..HEAD` coverage numbers; `WORKTREE WARNING` makes that omission visible but cannot measure the work. Commit the change, rerun `npm test`, and disposition any remaining WARN by hand. At the LCOV boundary the gate fails closed per changed file: no usable line records make every added line uncovered and add a synthetic uncovered branch; if a recorded file has an added line missing or uncovered and no changed-line BRDA records, it adds the synthetic branch rather than letting the LCOV gap disappear. A nonempty diff that parses to zero files is an internal ERROR, never an empty PASS.
- **Treat BRDA as execution-dependent, not as a static branch inventory.** Optional chaining, `&&` short-circuits and destructuring defaults do not appear as uncovered branches until the alternate path actually executes, so weak tests can produce a SMALLER denominator and a better-looking percentage. Always regenerate LCOV from a real full run; never trust a static branch inventory.
- **Coverage-DIRECTIVE matching is a separate boundary: do not make that scanner cleverer than Node.** Node v22.23.1 and v24.18.0 define byte-identical coverage directives with `kIgnoreRegex` and `kStatusRegex` in `lib/internal/test_runner/coverage.js` lines 43 and 46, then applies them directly to each RAW source line at lines 113 and 122. Both regexes are unanchored, case-sensitive, exact-spacing, block-comment-shaped matches with NO lexical analysis. Consequently a matching substring inside a string or template literal IS honoured; `// node:coverage ...` syntax is NEVER honoured, whether line-leading or trailing; and changed case (`DISABLE`) or doubled spacing is inert. The gate copies those regexes VERBATIM and deliberately does not normalize, parse or broaden them. That rule governs directive recognition only; delegating executable-line classification to TypeScript's parser removes bespoke cleverness rather than violating it. Any directive-regex divergence is a defect in either direction: under-matching hides coverage, and over-matching rejects legitimate inert text. The gate adds one policy after the verbatim match: every matching substring on an added line fails unless text AFTER it on that SAME line carries an explicit `reason`, `because` or `rationale` label followed by `:`, `=` or `-` and a substantive value. This is self-referential: an exact block-shaped directive substring on a newly added fixture, comment or explanatory string is itself caught, even when it merely describes the pattern, so its line also needs the trailing reason annotation. The wrapper's central include/exclude policy remains the sanctioned exclusion mechanism, because it is auditable in one place; inline directives are the most gameable form.
- **The gate has its own regression net.** `test/coverage-gate.test.ts` exercises diff grammar, malformed and foreign LCOV, source classification, threshold boundaries, fail-closed behaviour, directive reasons and WARN propagation through the wrapper. Run `npm test` after ANY change to `verification/coverage-gate.mjs` or `verification/run-tests.sh`. This is load-bearing quality control for every other test: manual review found false-PASS defects in the gate that no other check would have caught, so a gate change without its fixture family can invalidate all downstream coverage claims while still printing success.
- **Waiter tests require an explicit timeout.** `node:test` has no default timeout. Every test that awaits an operation which might never resolve must carry one, following the timeout option on the waiter test in `test/thread-manager.test.ts`; read that test for the maintained value instead of copying it here. Deadlocks and missed wakeups are exactly the defects that concurrency work targets; without the timeout they HANG the suite instead of failing it.
- **Run `npm test` after ANY change under `extension/` or `test/`.** Do not transcribe suite size or cost here: `run-tests.sh` prints the discovered test-file count, and Node's summary prints the current test count and duration on every run.

## Writing convention

The convention governs new or changed prose in the root `README.md`, PR descriptions and delivery commit bodies. It also governs issues, comments, release notes and agent messages to users. Use short, active, plain language. Keep exact technical terms. Do not use semicolons or contractions.

These six requirements are project-authored:

1. Avoid idioms.
2. Replace bare-reference openers with the subject they reference.
3. Explain each project-specific term at first use.
4. Define each abbreviation at first use.
5. Express one idea in each sentence.
6. Use one term for each concept.

Research logs and worker-thread task text are excluded. A high-level design is governed when `writing.check` is true, even inside a research log. The project's own agent instruction file, `AGENTS.md`, is also excluded. Its rules need a dense, exact register. `docs/` and `verification/README.md` remain precision-first mechanism references and are excluded too.

The writing checker is diagnostic everywhere and authoritative nowhere. A match directs reviewer attention, and the reviewer decides whether the text has a defect. Changed convention-governed text should carry no fail-level findings. Findings in unchanged text are pre-existing debt, not an unrelated blocker. Every checker class is advisory in excluded files because length limits can conflict with required precision. ASD-STE100 inspires only, Slate claims no conformance, and contributors must copy no standard material or examples.

## Packaging rules

- Keep the pi-bundled SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) in `peerDependencies` with the version `"*"`. Never bundle them, and never add them to `dependencies`.
- **The devDependency carve-out.** `devDependencies` also pins the same four packages to exact versions, so the typecheck, the load check and the unit tests use one known SDK. That practice is correct, and a bundle is a different matter: npm installs `devDependencies` for no consumer, and it installs `dependencies` only. `devDependencies` pins the tooling in the same place and for the same reason: `@types/node` serves the typecheck, and `typescript` serves both the typecheck and the coverage gate's executable-line classifier. `tsconfig.json`, `test/` and `verification/` all sit outside the `files` whitelist, so no part of the checks or the tests reaches a consumer install. Re-check that boundary with `npm pack --dry-run --json` after a packaging change.
- **Commit `package-lock.json`.** This repo ignored the file while the four SDK packages existed as `"*"` peers only, because a lockfile then pinned an arbitrary resolution from npm. The exact pins in `devDependencies` removed that reason, and the lockfile now records the versions that this repo chose. `npm ci --ignore-scripts`, the install that CI runs, also needs the file.
- **Never add an install-time lifecycle script.** npm runs `prepare`, `postinstall`, `install` and `preinstall` on **every consumer install**. Add none of them to `scripts`.
- The `files` whitelist in `package.json` **must include `docs/`**. The doctrine points at those files at package-resolved paths at run time. A publish without them ships a doctrine with a dangling citation in every rule, and an orchestrator that reads the workflow rules finds nothing. This is a rule and not a note, because adversarial review raised it as a finding (`AD6` in that round). Action-level routing needed no packaging change, because `docs/` ships as a whole and covered `docs/model-routing.md` on its first day. That fact makes the rule MORE important: one more doc now resolves at a package-resolved path at run time.
- The guard asserts the `files` whitelist by **exact equality**. A deliberate change to the whitelist must update the guard in the same commit (see § CI).
- Keep `"keywords": ["pi-package"]` — it is what lists the package in the pi.dev gallery.

`verification/run-packaging-checks.sh` enforces every rule above. It asserts the manifest, and it also asserts the *real* file list from `npm pack --dry-run`, because the manifest alone proves too little. npm expands a whitelisted directory **recursively**, and a `files` whitelist makes `.npmignore` and `.gitignore` inert. A stray file under `extension/` or `docs/` therefore ships behind a correct manifest.

The pack policy answers that risk. It permits a small set of file kinds, and it rejects junk and secrets. It also requires every doctrine doc that the extension references. `verification/README.md` gives the details.

**The permitted kinds include `extension/**/*.mjs`, and that is deliberate.** The shipped writing checker is dependency-free plain JavaScript. It runs as a command and inside a hot turn hook without a transpiler. The size-grade command is also plain JavaScript. The pack policy must permit both runtime commands. `verification/package-content-check.mjs` enumerates them independently. It proves that each has one exported path and packed file.

## Release & versioning

Before any release, read and follow `RELEASING.md` in full. The runbook
keeps the package version, the exact merge, the package contents and the
registry artifact in agreement. This repository dogfoods the main worktree's
sources independently of publication. Bump the four SDK devDependency pins
with any targeted pi release and refresh `package-lock.json`. Run all five CI
checks and both package-content commands before publication.
