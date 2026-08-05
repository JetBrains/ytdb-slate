# AGENTS.md — ytdb-slate contributor guide

## Overview

This repo is a [pi package](https://pi.dev/docs/latest/packages) providing the **slate** extension: thread-weaving orchestration for pi (orchestrator dispatches bounded actions to persistent worker threads; results come back as compressed episodes; a shipped doctrine enforces the research/design-review/adversarial-review/track-review workflow, with optional draft-PR publishing).

Dispatch also carries **action-level model routing**: `router.models` in the project's `slate.json` names a CLOSED candidate list, resolved once per session, from which each action's model and effort are chosen and guarded. It is off by default: an empty list adds no candidate-routing policy, base seed, context-window substitution, billing notice, or routing doctrine rule. Per-action arguments and pre-existing live failover holds remain active. Reference: `docs/model-routing.md`, which the doctrine cites at runtime alongside the workflow/review/design docs.

- Extension entry point: `extension/index.ts`
- Shipped doctrine docs: `docs/` — `track-workflow.md`, `review-rules.md`, `design-principles.md`, `pr-publishing.md` and (since routing shipped) `model-routing.md` are cited by ABSOLUTE path resolved inside the installed package (`extension/paths.ts`)
- Default branch: `main`
- Finding tags come from slate's own adversarial reviews. This file uses `AD6`, and code comments use `AD41`, `RG2` and other tags. Each review round numbers its findings from 1, so one tag can name two different findings. The `AD6` in § Packaging rules is not the `AD6` of the tier-1 CI review. Only the pull request or the track discussion that raised a finding explains the tag. Every citation in this file therefore states the finding in words, and the tag gives the origin only.

## Dogfooding

This repo runs slate on itself:

- `.pi/settings.json` pins the published package (`npm:ytdb-slate@<version>`). A session in this repo runs the released extension — the same thing consumers run. Bump the pin as part of each release (see § Release & versioning).
- Local edits to `extension/` are NOT live in a dogfooding session. Smoke-test them in isolation with `pi --no-extensions -e .` from the repo root — without `--no-extensions`, the pinned npm copy loads alongside your edits and can mask failures. Do not add a local-path package entry to `.pi/settings.json` next to the npm pin: loading the same package from two settings sources has broken pi startup with a file conflict in practice.
- Development follows the package's own `docs/track-workflow.md`, with `workflow.draftPRs` enabled in `.pi/slate.json`.
- pi creates a `.pi/settings.json.lock` directory in the checkout while it reads the project settings, and then deletes it. A session or a verification run that stops abruptly can leave one lock behind. `.gitignore` therefore covers `.pi/*.lock`. You can delete an old lock safely when no session runs. When a session runs, the lock belongs to that session.

## Build & verification

- **There is no build step, but there is a typecheck.** pi loads raw TypeScript through jiti, and it uses `extension/index.ts` as it is. No tool compiles the sources before pi runs them. jiti removes the types, and it does not check them. The typecheck is therefore the only check of the types, and it has no other purpose. `npm run typecheck` runs `tsc --noEmit -p tsconfig.json`, and it writes no output: no artifact, no `dist/` directory, and no input for a later step.

  The typecheck reads `extension/**/*.ts`, `verification/probe.ts` and `verification/ci-canary.ts`. It skips `verification/*.mjs`, because that code is JavaScript without type annotations. `tsconfig.json` sets `strict`, `noUncheckedIndexedAccess` and `noUncheckedSideEffectImports`. It also sets `skipLibCheck: true`, and that flag is necessary. Without it, `tsc` reports more errors, and all of them sit inside third-party `.d.ts` files under the pi SDK. This repo cannot correct those files.

  `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` stay off. This repo measured both flags and then rejected them, and `tsconfig.json` records the error counts and the reasons. Nobody must repeat that decision without the data. Every flag in the set passes on the current tree. Add a new flag together with its fix. A flag that fails makes the check unreliable, and people then ignore it.

  A passing `npm run typecheck` does NOT make the TypeScript brands (`SessionBaseline`, `OpenModel` in `extension/route.ts`) tamper-proof: TypeScript permits an assertion to a branded subtype, so `someString as OpenModel` — the exact shape that reintroduced a shipped defect while the full suite stayed green — still typechecks cleanly. The resolver checks' source-scan gates for cast shapes are therefore still load-bearing and must not be removed on the grounds that the repo has a typecheck; the two nets cover different failures, and only the source scan covers this one.
- **Automated verification exists.** Tier-1 CI runs four checks on every pull request, on every merge-queue candidate, on a push to `main`, and on a manual dispatch. Each check is the same command that you run locally, and the four checks together take about five seconds (§ Tier-1 CI). Three more nets run by hand and are named in the list below. Writing also has a focused correctness suite: `verification/writing-check-tests.mjs` tests the shipped, dependency-free JavaScript checker in `extension/writing-check.mjs` and the turn-outcome helper `measureWritingTurn` in `extension/writing.ts`. It does not unit-test the other TypeScript modules, and the repo has no general unit-test suite. Four tasks stay manual:
  1. **Read the full diff before you commit.** No tool does this for you.
  2. **Run the isolated-load smoke test when you must use an edit that you just made.** The command is `pi --no-extensions -e .` from the repo root, because an installed session runs the pinned published package and not your working tree. The load check proves that the extension loads and registers its tools, but it does not prove that the tools work. Exercise tool execution, worker sessions, failover and handoff by hand here.
  3. **Open an INTERACTIVE session to reach the doctrine and the router.** A headless `pi --no-extensions -e . -p "exit"` run exercises extension registration and `session_start` only, and it never builds the doctrine. slate seeds orchestrator mode only when `ctx.mode === "tui"` (`extension/mode.ts`), and `before_agent_start` returns at once while the mode is off. A headless run therefore reaches neither `buildDoctrine` nor the `getRouter()` consultation inside it, and that consultation is the only one in the doctrine. Every smoke test during the work on the routing feature missed both. A release-time accident exposed this gap.

     An automatic interactive session needs a pty. This machine has no `script(1)`, and a small Python `pty.fork` harness works instead. Use **`\r`** as the submit key, and not `\n`.

     The session JSONL holds no doctrine text. Its entries are `session`, `message`, `custom`, `model_change` and `thinking_level_change`, and the system prompt is not one of them. To verify the CONTENT of the doctrine, ask the model to repeat it, and do not grep the transcript. This gap is a smoke-test gap, and it is not a coverage gap. The `doctrine-*` checks cover the rendering, and the router checks cover the resolution. Only a live session proves that the wiring runs.
  4. **Run by hand every net that tier-1 CI leaves out.** They are the verification ladder (tier 2, § Verification ladder below), the package-content check (§ Package-content check), the writing checker's correctness suite and the writing checker's scaling gate (§ Writing-checker nets). Each of those sections states its own re-run trigger. Tier-1 CI leaves the ladder out on purpose, for the reasons under § Tier-1 CI; the other three are simply not wired into the workflow yet.

### Tier-1 CI (`.github/workflows/tier-1.yml`)

Tier-1 CI is fast, and it needs no secret. Every check uses fabricated inputs and a plain checkout. The checks reach the network for the dependency install only, and they use no credential. They also touch no real pi state: the only harness that starts a pi session points `PI_CODING_AGENT_DIR` at an empty throwaway directory. The packaging guards reach no registry, and they pass when npm runs offline.

The checks write in three places only:

- The load check and the resolver checks each make a scratch directory under `TMPDIR`, outside the checkout. Each harness removes its own directory after a clean run. The load check keeps its directory when a check fails, and it prints the path.
- The packaging guards write nothing.
- pi creates a `.pi/settings.json.lock` directory inside the checkout, and deletes it again, around each read of the project settings.

Tier-1 CI is not hermetic beyond that, and it makes no such claim: the install fills the npm cache under `HOME`, like every other install.

The workflow uses a read-only token (`permissions: contents: read`). Four events start it: `pull_request`, `merge_group`, a `push` to `main`, and `workflow_dispatch`. It never uses `pull_request_target`. The job stops after 15 minutes (`timeout-minutes: 15`), and the workflow pins each third-party action to a commit SHA. The job runs as a matrix on **Node 22 and Node 24**. pi needs node 22.19.0 or later, and consumers run both current LTS lines.

The four checks follow. Each command reproduces its check on a laptop, after `npm ci --ignore-scripts`:

| check | local command |
| --- | --- |
| typecheck | `npm run typecheck` |
| packaging guards | `bash verification/run-packaging-checks.sh --repo .` and `bash verification/run-packaging-checks.sh --repo . --self-test` |
| extension load check | `bash verification/run-load-check.sh --repo .` |
| pure-resolver checks | `bash verification/run-resolver-checks.sh --repo . --strict` |

**Keep `--ignore-scripts` on the install.** The pinned pi SDK is a devDependency, and its dependency tree declares install scripts: `@google/genai` (preinstall) and `protobufjs` (postinstall). `@earendil-works/pi-coding-agent` holds a copy of each package in its shrinkwrapped tree, so `package-lock.json` carries four entries with `hasInstallScript`. A plain `npm ci` runs all four scripts on every install. Tier 1 needs none of them, so the flag keeps third-party code out of the job. npm creates `node_modules/.bin` without those scripts, so the `pi` and `tsc` launchers appear in both installs.

**How the harnesses find pi.** Two of the four checks need a pi binary, and both start with the same two steps:

1. `PI_BIN`, when you set it. The harness prints `NOTE` lines for this case. `PI_BIN` is an override for an expert user, and it is not a security boundary.
2. `node_modules/.bin/pi` in the checkout. The install above creates it, and a CI runner has no other pi.

The two harnesses then differ on purpose. The **resolver checks** accept a pi from `PATH` as a last choice, and they apply no version guard. They borrow only the jiti transpiler inside pi, and the module graph that they load imports no pi SDK package at run time. An old jiti can only fail to transpile the sources, and then the run stops with no summary, and no check passes.

The **load check** accepts no pi from `PATH`, and it also requires the same version from `pi --version` as the `@earendil-works/pi-coding-agent` pin. pi's rpc output shapes are the evidence for its checks, and a new shape can look like "no events" and pass in silence. The ladder (tier 2) keeps its own rule: it needs `pi` on `PATH`.

The three tier-1 harnesses (the packaging guards, the load check and the resolver checks) share one exit-code contract:

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
- **load check** — a failing run that started pi prints the raw rpc streams in its own output. It prints one section for each stream, stderr before stdout, and it cuts each stream at a limit. It also keeps the streams in the scratch directory (`artifacts: …`), so the evidence survives a CI job that deletes that directory. The detail line summarises those streams, so read the streams first. A pi run must happen before the streams appear, and the identity of the failed check does not matter. A full run that fails the config-syntax check still prints the streams of the earlier pi runs, and only a run with `--only T4` prints none.
- **resolver checks** — the detail line repeats the expectation that broke, and the harness prints the same sentence for a pass, for example `CHECK memoization FAIL — createWorkerExtensionResolver walks the registry exactly once across repeated calls`. An `observed:` line under it gives the value that the check saw, for example `observed: {"walked":3}`. The harness removes its fixtures on exit, but the pipeline is pure and deterministic. Read the body of that check in `verification/resolver-checks.mjs`, then run the harness again.

A NOT RUN from the ladder is neither a pass nor a fail. `verification/README.md` holds the table of the action for each one.

The four checks together take about **five seconds** on a warm machine. One machine gave these times:

| check | time |
| --- | --- |
| typecheck | 2.2 s |
| packaging guards, each pass | 0.3 s |
| extension load check | 2.3 s (it starts two real pi processes) |
| pure-resolver checks | 0.2 s |

Run all four checks before you commit.

**Re-run obligations.** The two sections below use the same form:

- **Run the packaging guards again after a change to a packaging-relevant manifest field.** Those fields are the `files` whitelist, `peerDependencies`, `dependencies`, `keywords` and `scripts`. Run them again also after you add, move or delete a file under `extension/` or `docs/`. The pack layer asserts the *real* file list from `npm pack`, and not the manifest. The guard asserts the `files` whitelist by **exact equality**, so a deliberate change to the whitelist must update `FILES_EXACT` in `verification/packaging-checks.mjs` **in the same commit**. Run `--self-test` too: it runs every guard against the real input with one violating mutation, and it requires a failure.
- **Run the load check again after a change to extension loading, to tool or command registration, or to `session_start`.** Run it again also after a change to the `.pi/slate.json` of this checkout. Those failure modes have no other signal (see § How extension-load failures surface). A check of its own reads the config file directly from disk, because slate drops an unparseable file in silence. The load check answers two conditions with exit 2 instead of a FAIL report:
  - **A checkout without `extension/index.ts`** stops the run. pi drops a nonexistent entry from `pi.extensions` in silence, and every check then passes on an empty session. A checkout without `verification/ci-canary.ts` stops the run for the same reason.
  - **A mismatch between the pin and the installed pi** stops the run. The message carries the remedy `run 'npm ci --ignore-scripts'`, which is the install that CI runs. The rpc output shapes hold for one pi version only.
- **Tier 2, the verification ladder, stays outside CI on purpose** (issue #24). It takes about 3 minutes, and most of that time is wall-clock wait in timing-sensitive rungs. It needs GNU coreutils, and it refuses to run as root. On a slow machine, or on a machine without the optional tools, it reports NOT RUN instead of PASS. A required check with that behaviour gives unreliable results, so the ladder stays a check for a person to read. Run it as § Verification ladder describes.

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

`verification/run-load-check.sh` holds all of this knowledge, so you do not have to remember it. `L1` reads the exit code. `L2` reads both stderr markers. `L3` reads the `extension_error` channel on stdout. `L4` and `L5` read the registered tool set through the positive control in `verification/ci-canary.ts`. `L6` reads which copy of slate pi loaded.

**A pipeline hides the exit code of a process, and that trap probably produced the wrong claim.** `$?` after a pipeline gives the status of the **last** command, and not the status of the piped process. A broken extension shows the difference. A direct run of pi exits `1`. The same run as `pi … 2>&1 | head -1` gives a `$?` of `0`, while `${PIPESTATUS[0]}` for that pipeline is still `1`, and `set -o pipefail` makes the pipeline exit `1`. Read a real exit code in one of three ways: use no pipe, read `${PIPESTATUS[0]}`, or run `set -o pipefail` first. Every script in `verification/` runs `set -o pipefail`.

  **Run the typecheck after ANY TypeScript change.** That trigger is wide on purpose, and the deep nets below use a narrow trigger instead. The run takes about 2 seconds, and it checks every file that it covers in one pass. Spend no time on a decision about the type relevance of your edit.

  These nets cover the mechanisms that fail in silence: the verification ladder, the pure-resolver checks, the packaging guards, the extension-load check, the package-content check, the writing checker's correctness suite and the writing checker's scaling gate. The first four are described above or below; the last three have their own sections below. No number is written here on purpose — this inventory has been wrong twice, once when it said two and once when it said five — so read the list, and add to the list when you add a net. The typecheck is NOT one of them. It sees shapes, it never sees behaviour, and every mechanism in those sections fails with correct types. Run the net that covers your change, and run more than one when your change touches something that they share: an edit to `extension/writing-check.mjs` implicates all three of the nets that watch it (the correctness suite, the scaling gate, and the resolver suite's `writing-*` families).

  `failover.ts`, `episodes.ts`, `worker.ts` and the router use the model-spec helpers in `extension/state.ts`. `failover.ts` and `handoff.ts` drive `extension/base-model.ts`, and those two modules are the switch sites of the ladder. A change to either module therefore implicates BOTH nets.

### Verification ladder (global model defaults across slate's model switches)

`verification/run-ladder.sh` is the deepest regression net in this repo. It is not the only net: § Tier-1 CI names the four checks that run on every pull request, and the sections below add the package-content check and the writing checker's two nets. It is the only net that touches the global model-default machinery. It covers:

- `extension/model-default.ts` and both switch sites (`extension/failover.ts` failover, `extension/handoff.ts` handoff adoption): the per-key restore rule, the untrustworthy-read stand-downs, the retry budget and the reporting channels;
- `extension/worker.ts`'s worker-session settings isolation, in rung `WK1`: a **worker-side per-dispatch model AND effort switch** — what every routed action performs — writes zero bytes to the global settings file and does not survive into a reopened session as a sticky default. It is the only automated net for that guarantee, and the only rung that opens a worker session at all.

Everything runs against fake offline providers in a throwaway agent directory, so real pi settings are never touched (the run fails if the real file changes).

- Run it with `bash verification/run-ladder.sh --repo .` (~3 min; `--only <ids>` for a subset). Not as root, and needs GNU coreutils. Exit 0 means nothing failed and the real settings file is unchanged — rungs can still report NOT RUN, so read the lines; automation should pass `--strict`, which makes any NOT RUN fatal.
- **Re-run it after any change to `extension/model-default.ts` or to either switch site**, and **after any change to how a worker session is opened or switched** — `extension/worker.ts`'s settings manager, the model/`thinkingLevel` options it passes to `createAgentSession`, or the per-dispatch switch in `threads.ts`'s `applyRoute` (`WK1`). Both mechanisms fail silently when they regress — the switch still works, and the damage lands in the user's own pi configuration — so a passing smoke test proves nothing about either. Details, rung table and the timing-sensitive rungs: `verification/README.md`.

### Pure-resolver checks (worker extensions + doctrine rules + model router + dispatch guards + state sanitizers + profile table + writing wiring)

`verification/run-resolver-checks.sh` is the automated net for the repo's PURE pipelines. It loads and exercises the modules listed below against fabricated in-memory registries, fabricated profile tables, fabricated events, fabricated doctrine inputs and a fabricated compaction predicate — no pi session, no real state — in ~1 second. How many checks that is, is the `roster` line's business and is deliberately NOT transcribed here: it moves with every check added, and both this file and `verification/README.md` have carried stale counts before. The roster asserts that every expected id reported exactly once, and the summary prints the identity (`N result lines = N−1 expected checks + this roster audit`), so a deleted, duplicated or crashed check cannot read as a clean exit — read those two lines, not a number in this file:

- `extension/worker-extensions.ts` — the worker-extension resolver (candidate filtering, load-unit selection, barriers, matching, memoization) and the doctrine rule it feeds in `extension/mode.ts`;
- `extension/mode.ts`'s **action-routing doctrine rule** (`doctrine-*`, driven through `registerSlateMode`'s `before_agent_start` handler with a fabricated resolution): that a router-OFF session gets byte-identically nothing, that an UNTRUSTED project gets no routing rule even with `router.models` fully configured (SE3's trust re-gate — defence in depth, so its removal has no visible symptom), that the conditional tail rules are numbered by position, its **injection safety** — the rule deliberately bypasses `sanitizeForDoctrine` (that sanitizer strips `|`, which would destroy the table), so the narrow `cell()` is the entire defence and the checks attack it structurally — that no research trace tag or `nonPreferred` reason leaks into the prompt, and a **size budget**, because this text is injected into every session's system prompt and paid for on every turn. The group is voided by `profiles-load`: one of its checks renders the real shipped table;
- `extension/model-router.ts` — the model router: the `router` config sanitizer, candidate resolution (drops, ordering by preference/tier-sourcing/tier/price, the `nonPreferred`-aware base-model pick, the W1/W3/failover-coverage warnings, dedup, memoization) and the dispatch-side effort predicate;
- `extension/route.ts` — the route planner (`route-*`): the SAFETY CORE of action-level routing, i.e. the argument check the code numbers guard 0 (effort vocabulary) and the seven dispatch guards 1–7 (list membership on both router states, per-model ladder validity, evidence gap, API-rejected level, the never-blocking context-window substitution, long-context billing, and the failover carve-out) plus the base-effort seed. It was extracted from `threads.ts` into a pure module for exactly this harness, because a guard that silently stops guarding still "works": the dispatch runs and an episode is written;
- `extension/state.ts` — the canonical model-spec vocabulary (`spec-*`: `isModelSpec` / `splitModelSpec` / `describeSpecDefect` / `describeConfusables`), which `failover.ts`, `episodes.ts`, `worker.ts` and the router all share, plus the single-spec config-key sanitizer (`sanitizeEpisodeModel`) — AND the **snapshot record sanitizers** (`state-*`: `sanitizeThreadRecord` / `sanitizeEpisodeRecord`, BG26), which are re-run over the user's whole thread and episode history at every session restore and are now pinned: a MISSED repair throws out of the `thread` tool, a FALSE one silently destroys a thread the user still needs;
- `extension/base-model.ts` — the orchestrator base-model tracker (`base-*`): the pure reducer deciding which model switches move the base model new worker threads inherit (seeding, slate's own declared switches, user/cycle/restore sources, handoff adoption, stale declarations and their one-event grace, switches in flight, and a setter that throws). Driven with fabricated `model_select` events through the declare/observe/settle protocol — the module has no clock, so nothing sleeps and no timer can fire after teardown;
- `extension/episodes.ts` (`episode-*`) — episode compression, loaded through a SECOND loader instance with the pi packages aliased to local stubs, since it imports `@earendil-works/pi-ai` (a peer dependency this repo does not install). The module and everything it imports from this repo are real; only the SDK boundary is faked;
- `extension/model-profiles.ts` — STRUCTURAL invariants of the shipped table only (id/alias resolvability, ladder vs measured/gap coverage, price-schedule shape, tier range, freezing). Never a research number: those are a review concern, and a refresh must not have to touch this suite;
- the **writing wiring**: `extension/writing.ts`'s config sanitizer and `measureWritingTurn` outcomes (`writing-config-*`), `extension/mode.ts`'s writing status line and its four visibility gates (`writing-status-*`), the writing doctrine rule (`writing-doctrine-*`), the shipped command `extension/writing-check.mjs` by import and by spawn (`writing-checker-*`), and the worker preamble's config gate across `extension/worker.ts` and `extension/threads.ts` (`worker-preamble`). Two bounds meet here and are easy to confuse: `writing-status-cap-visible` covers `mode.ts`'s 16 KiB `WRITING_TURN_MAX_BYTES` turn bound, while `writing-status-cap-skip` covers the checker's own 1 MiB input cap. The checker MODULE has two nets of its own — see below.

- Run it with `bash verification/run-resolver-checks.sh --repo .`. The harness needs `node` and `mktemp` on `PATH`, and it resolves pi itself, so **`PATH` does not need pi** (§ Tier-1 CI). It prints one line for each check, an `observed:` line under a failure, a `roster` check that every expected check reported, and then a summary. Pass `--strict` in automation, because it makes any NOT RUN fatal. Tier-1 CI passes it.
  - Exit 0 means that every check passed.
  - Exit 1 means that a check failed or went missing.
  - Exit 2 means that the harness refused to start.
- **Re-run it after any change to `extension/worker-extensions.ts`, `extension/model-router.ts`, `extension/route.ts`, `extension/model-profiles.ts`, `extension/base-model.ts`, `extension/episodes.ts`, `extension/writing.ts`, `extension/writing-check.mjs`, the worker preamble or its config plumbing in `extension/worker.ts` and `extension/threads.ts`, `extension/state.ts`'s spec helpers or snapshot sanitizers, or `extension/mode.ts`'s doctrine RENDERING and writing status wiring** — those are the modules or source paths it checks. Doctrine rendering is stated plainly because it is easy to file under prose: the routing rule bypasses the doctrine sanitizer, so touching it is an edit to an injection surface and to a per-turn cost, and only this suite watches either. A guard change in `route.ts` is the highest-stakes case: re-run it, and if the guard's INPUTS moved (what `threads.ts` injects) re-read the assembler too, since the harness fabricates those inputs. The `state.ts` helpers are shared with `failover.ts`, so a change to them also needs the ladder above. A router change is the same class of hazard as the model-default mechanism: a wrong candidate list or a suppressed warning still "works", so a smoke test proves nothing about it. Details, the check table and the mutation-testing method that gives these checks teeth: `verification/README.md`.
- It imports `extension/worker.ts` for the preamble builder and reads the prompt/config plumbing in that module and `extension/threads.ts`; nothing else in either module is covered. The worker-session load path — the allowlist-mode extension load, the `excludeTools` deny list that keeps slate's dispatch tools out of a worker, and the post-load collision re-check — is out of its scope. Exercise those with the isolated-load smoke test (`pi --no-extensions -e .`) above after changing `extension/worker.ts`, and the ladder's `WK1` rung for that module's settings isolation. It likewise stops at the PURE boundary: it proves what the planner DECIDES, not what `threads.ts` does with a verdict (applying the switch, raising a tool error, aborting without an episode, remembering the long-context notice). Those are separate mechanisms; the ladder's `WK1` rung covers one slice of the first.
- **Doctrine size figures are install-path dependent — compare a PORTABLE one.** The doctrine cites its docs by absolute path (three always, one more with `workflow.draftPRs`, one more with the router on, and one more with writing guidance on), so every character of installed-`docs/`-directory length costs **3–6 characters of rendered doctrine**. A raw count measured in a deeper checkout or under `node_modules` is therefore larger and nothing is wrong. Nothing needs re-deriving to see past that: `doctrine-budget` bounds an install-INVARIANT figure — the rendered text with each occurrence of the docs directory removed, filename kept — and carries two terms that fail if that normalisation ever degrades to the identity; `docs/context-budget.md` (with `docs/model-routing.md` deferring to it) and `verification/README.md` publish portable figures on that same convention, and `docs/context-budget.md` names the check as the definition of record. Their published rows are not all identical — they were measured against different commits and fixtures — so when a figure matters, re-measure it rather than reconciling two tables.

### Package-content check (package-resolved runtime files)

`node verification/package-content-check.mjs --repo .` runs `npm pack --dry-run --json --ignore-scripts` and checks the publish file set. It derives the checker filename and every exported docs path from `extension/paths.ts`, then reports each missing runtime file by its exported path name. It also parses `extension/mode.ts` and validates its path imports, but those imports do not limit the document roster. It does not create a tarball, run package scripts, or use the network; it normally takes under 1 second.

- **Re-run it after any change to `package.json`'s `files` whitelist, `extension/paths.ts`'s package-resolved files, or path imports in `extension/mode.ts`**, and before release.
- The check covers package presence only. The resolver suite still covers doctrine rendering and checker behavior.
- **It overlaps the tier-1 packaging guards, and the overlap is not yet consolidated.** Both read the file list from `npm pack --dry-run`, and both demand that the doctrine docs ship. They derive that demand from different places: this check reads the exported constants of `extension/paths.ts` and names a missing file by its export, while `pack-doctrine-docs` in `verification/packaging-checks.mjs` scans every `extension/*.ts` for `join(<docs dir>, "<name>.md")`. This check is also the only one that requires the shipped **checker** (`extension/writing-check.mjs`) itself; the guards only permit its file kind. Merging the two is a reasonable future change, and until then run both.

### Writing-checker nets (correctness suite + scaling gate)

`extension/writing-check.mjs` is the shipped writing checker and the only module with two nets of its own. It has them because it is called from a HOT path: `extension/mode.ts`'s `turn_end` hook runs it synchronously on the completed assistant message, so its wall clock is the TUI's. `WRITING_TURN_MAX_BYTES` (16 KiB of assistant text, in `mode.ts`) is what keeps a pathological input away from that hook — the command's own cap is 1 MiB, three orders of magnitude higher, and only the command can reach it.

- `node verification/writing-check-tests.mjs` — CORRECTNESS: the rules, source offsets (BG2), the caps, report and file-input safety, command modes, the five hand-written scanners against the regexes they replaced, and `extension/writing.ts`'s turn outcomes. Under 1 s, machine-independent. Exit 1 on any failure. It is fail-soft (one failure does not hide the rest) and ends with a **roster audit** against an `EXPECTED` list, so a deleted, duplicated or crashed test cannot exit 0. Any test added, renamed or removed must update `EXPECTED`. Its test count and test numbers are the run's business and are deliberately NOT transcribed here or in `verification/README.md`: both were, and both went stale.
- `node verification/writing-check-scaling.mjs` — GROWTH: nothing in that module may grow faster than linearly. ~18 s, wall-clock. It is a separate file on purpose, so a timing assertion never makes the correctness suite read as machine-dependent.
- **Re-run BOTH after any change to `extension/writing-check.mjs`**, and the scaling gate in particular after adding or editing a REGEX, which is the change that reintroduces the class. Re-run the correctness suite and pure-resolver checks after a change to `extension/writing.ts`. Three reviews found six superlinear paths in the checker while every correctness net stayed green — the findings were right and the module was slow, which is precisely the failure a correctness suite cannot see. The gate's `roster` refuses an unclassified new regex literal by name, and its `canary` fails if the thresholds stop discriminating.

## Writing convention

The convention governs new or changed prose in the root `README.md`, PR descriptions, delivery commit bodies in either mode, issues, comments, release notes and agent messages to users: use short, active, plain language; keep exact terms. Research logs and worker-thread task text are excluded. So are `docs/` and `verification/README.md`, which are precision-first mechanism references, and `AGENTS.md`, whose agent rules need a dense, exact register.

The writing checker is diagnostic everywhere and authoritative nowhere: a match directs a reviewer's attention, and the reviewer decides whether the text has a defect. In convention-governed files, changed text should carry no fail-level findings; fail-level findings in unchanged text are pre-existing debt, not a blocker for an unrelated change. In excluded files every checker class is advisory only. This is deliberate: fail-level rules include sentence and paragraph length, and length trades directly against the precision those exclusions protect. ASD-STE100 inspires only; Slate claims no conformance. Copy no standard material or examples.

## Packaging rules

- Keep the pi-bundled SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) in `peerDependencies` with the version `"*"`. Never bundle them, and never add them to `dependencies`.
- **The devDependency carve-out.** `devDependencies` also pins the same four packages to exact versions, so the typecheck and the load check use one known SDK. That practice is correct, and a bundle is a different matter: npm installs `devDependencies` for no consumer, and it installs `dependencies` only. `devDependencies` pins the tools of the typecheck (`typescript`, `@types/node`) in the same place and for the same reason. `tsconfig.json` sits outside the `files` whitelist, so no part of the check reaches a consumer install.
- **Commit `package-lock.json`.** This repo ignored the file while the four SDK packages existed as `"*"` peers only, because a lockfile then pinned an arbitrary resolution from npm. The exact pins in `devDependencies` removed that reason, and the lockfile now records the versions that this repo chose. `npm ci --ignore-scripts`, the install that tier-1 CI runs, also needs the file.
- **Never add an install-time lifecycle script.** npm runs `prepare`, `postinstall`, `install` and `preinstall` on **every consumer install**. Add none of them to `scripts`.
- The `files` whitelist in `package.json` **must include `docs/`**. The doctrine points at those files at package-resolved paths at run time. A publish without them ships a doctrine with a dangling citation in every rule, and an orchestrator that reads the workflow rules finds nothing. This is a rule and not a note, because adversarial review raised it as a finding (`AD6` in that round). Action-level routing needed no packaging change, because `docs/` ships as a whole and covered `docs/model-routing.md` on its first day. That fact makes the rule MORE important: one more doc now resolves at a package-resolved path at run time.
- The guard asserts the `files` whitelist by **exact equality**. A deliberate change to the whitelist must update the guard in the same commit (see § Tier-1 CI).
- Keep `"keywords": ["pi-package"]` — it is what lists the package in the pi.dev gallery.

`verification/run-packaging-checks.sh` enforces every rule above. It asserts the manifest, and it also asserts the *real* file list from `npm pack --dry-run`, because the manifest alone proves too little. npm expands a whitelisted directory **recursively**, and a `files` whitelist makes `.npmignore` and `.gitignore` inert. A stray file under `extension/` or `docs/` therefore ships behind a correct manifest.

The pack policy answers that risk. It permits a small set of file kinds, and it rejects junk and secrets. It also requires every doctrine doc that the extension references. `verification/README.md` gives the details.

**The permitted kinds include `extension/**/*.mjs`, and that is deliberate.** The shipped writing checker (`extension/writing-check.mjs`) is dependency-free plain JavaScript, because it runs as a command and inside a hot turn hook without a transpiler. It is a runtime file of the package, so the pack policy must permit it. `verification/package-content-check.mjs` is what asserts that the file really ships.

## Release & versioning

Before any release, read and follow `RELEASING.md` in full. The runbook
keeps the release pin, the package version, the exact merge, the package
contents and the registry artifact in agreement. This repository dogfoods
the exact package version that it publishes, because `.pi/settings.json`
pins `npm:ytdb-slate@<version>`. Bump the four SDK devDependency pins with
any targeted pi release and refresh `package-lock.json`. Run all four tier-1
checks before publication. Update the dogfood pin only after the package is
available.
