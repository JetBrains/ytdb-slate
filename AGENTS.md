# AGENTS.md — ytdb-slate contributor guide

## Overview

This repo is a [pi package](https://pi.dev/docs/latest/packages) providing the **slate** extension: thread-weaving orchestration for pi (orchestrator dispatches bounded actions to persistent worker threads; results come back as compressed episodes; a shipped doctrine enforces the research/design-review/adversarial-review/track-review workflow, with optional draft-PR publishing).

- Extension entry point: `extension/index.ts`
- Shipped doctrine docs: `docs/`
- Default branch: `main`
- Finding tags — `AD6` in this file, `AD41`/`RG2` and friends in code comments — are findings from slate's own adversarial-review rounds. They are numbered **per round**, so the same tag can denote different findings in different reviews (§ Packaging rules' `AD6` is not the `AD6` of the tier-1 CI review), and they resolve only inside the PR or track discussion that raised them. Every citation here therefore states its substance in prose; the tag is provenance, nothing more.

## Dogfooding

This repo runs slate on itself:

- `.pi/settings.json` pins the published package (`npm:ytdb-slate@<version>`). A session in this repo runs the released extension — the same thing consumers run. Bump the pin as part of each release (see § Release & versioning).
- Local edits to `extension/` are NOT live in a dogfooding session. Smoke-test them in isolation with `pi --no-extensions -e .` from the repo root — without `--no-extensions`, the pinned npm copy loads alongside your edits and can mask failures. Do not add a local-path package entry to `.pi/settings.json` next to the npm pin: loading the same package from two settings sources has broken pi startup with a file conflict in practice.
- Development follows the package's own `docs/track-workflow.md`, with `workflow.draftPRs` enabled in `.pi/slate.json`.
- A `.pi/settings.json.lock` in the checkout is pi's own transient lock around a read of the project settings, not debris of yours; a hard-killed session or verification run can leave one behind, which is why `.gitignore` covers `.pi/*.lock`. Deleting a stale one is safe when no session is running — while one is, it is theirs.

## Build & verification

- **No build step, but there is a typecheck.** pi loads raw TypeScript via jiti; `extension/index.ts` is consumed as-is, and nothing is compiled to run it. `npm run typecheck` (`tsc --noEmit`, config in `tsconfig.json`) therefore emits **nothing** — no artifact, no `dist/`, no prerequisite for running anything. It only reads `extension/**/*.ts`, `verification/probe.ts` and `verification/ci-canary.ts`.
- **There is automated verification.** Tier-1 CI runs four checks on every push and pull request, and each one is exactly the command you run locally — see § Tier-1 CI below. What genuinely stays manual:
  1. **Carefully re-read the full diff before committing.** Nothing automates this.
  2. The isolated-load smoke test — `pi --no-extensions -e .` from the repo root — whenever you need to actually *use* what you just edited (an installed session runs the pinned published package, not your working tree). The load check proves the extension loads and registers; it does not prove any of it works, so this is still where tool execution, worker sessions, failover and handoff get exercised by hand.
  3. The verification ladder (tier 2, § Verification ladder below), deliberately not in CI.

### Tier-1 CI (`.github/workflows/tier-1.yml`)

Fast, fully offline, secret-free: fabricated inputs and a plain checkout, no network beyond the dependency install, no credentials, nothing written outside the workspace. The token is read-only (`permissions: contents: read`), the trigger is the ordinary `pull_request` (never `pull_request_target`), third-party actions are pinned by commit SHA, and the job runs as a matrix on **Node 22 and 24** — pi requires node ≥ 22.19.0 and consumers run both current LTS lines.

The four checks, with the commands that reproduce them verbatim on a laptop (after `npm ci --ignore-scripts`):

| check | local command |
| --- | --- |
| typecheck | `npm run typecheck` |
| packaging guards | `bash verification/run-packaging-checks.sh --repo .` and `bash verification/run-packaging-checks.sh --repo . --self-test` |
| extension load check | `bash verification/run-load-check.sh --repo .` |
| worker-extension resolver checks | `bash verification/run-resolver-checks.sh --repo .` |

**`--ignore-scripts` on the install is deliberate — do not drop it.** The pinned pi SDK is a devDependency, and its own dependency tree declares install scripts: `@google/genai` (preinstall) and `protobufjs` (postinstall), each also duplicated inside `@earendil-works/pi-coding-agent`'s shrinkwrapped tree, so four entries in `package-lock.json` carry `hasInstallScript`. A plain `npm ci` executes all four on every run — arbitrary third-party code in the job for no gain, since nothing tier 1 does needs them. npm still creates `node_modules/.bin` itself, so the `pi` and `tsc` launchers appear either way.

**How the harnesses find pi.** Two of the four checks need a pi binary, and both start from the same order: `PI_BIN` when set (announced with `NOTE` lines in the output — an escape hatch for people who know what they are doing, never a security boundary), otherwise the checkout's own `node_modules/.bin/pi`, which is what the install above produces and the only pi a CI runner has. From there they diverge on purpose. The **resolver checks** accept a `PATH`-resolved pi as a last resort and apply no version guard: all they borrow is the jiti transpiler bundled with pi, the module graph they load imports no pi SDK package at runtime, and a jiti too old can only fail to transpile — which crashes the run with no summary rather than passing wrongly. The **load check** has no `PATH` fallback and additionally requires the CLI's `--version` to equal the `@earendil-works/pi-coding-agent` pin, because pi's rpc output shapes *are* its evidence and a changed shape could read as "no events" and pass silently. (The ladder, tier 2, is unchanged: it needs `pi` on `PATH`.)

All three tier-1 verification scripts (packaging guards, load check, resolver checks) share one exit-code contract: **0** every check passed · **1** a check failed · **2** refused to start (a missing tool, a bad `--repo`, or an environment that cannot support a meaningful run). A `2` is never a defect report — it means nothing was verified.

**When one fails**, that contract is where to start. A `2` is the environment or the invocation: read the single `verification: …` line it prints, which names the missing tool, the bad path or the version mismatch and, where there is one, the remedy — there is nothing to debug in the code yet. (The load check spells the status out in words, `verification: refused to start — …`, so it is greppable in a CI log; the other two print the reason alone.) A `1` is a real finding, and the failing `CHECK … FAIL — <detail>` line is written to be the explanation rather than a pointer to one:

- **typecheck** — `tsc` prints `file(line,col): error TS…`; the source is what is wrong, and a re-run costs about a second.
- **packaging guards** — the detail names the offending manifest field or shipped path. A failure under `--self-test` is the opposite situation: a guard can no longer detect its own violating mutation, so fix the guard, not the manifest.
- **load check** — when a failing run actually launched pi, the raw rpc stdout/stderr is kept and its path printed (`artifacts: …`); the detail line is a summary of those streams, so read them before theorising. The one check that needs no pi run keeps nothing, because there would be nothing in it.
- **resolver checks** — the temp fixtures are removed on exit, but the pipeline is pure and deterministic: the detail line plus a re-run is the whole evidence trail.

For the ladder, a NOT RUN is neither pass nor fail; `verification/README.md` carries the table of what to do about each one.

**Re-run obligations** (the same imperative as the two sections below):

- **Re-run the packaging guards after touching any packaging-relevant manifest field** — the `files` whitelist, `peerDependencies`, `dependencies`, `keywords`, `scripts` — and after adding, moving or deleting a file under `extension/` or `docs/`, because the pack layer asserts the *real* `npm pack` file list, not the manifest. The `files` whitelist is asserted by **exact equality** (`files-exact`), so a deliberate whitelist change must update `FILES_EXACT` in `verification/packaging-checks.mjs` **in the same commit**. Run `--self-test` too: it re-runs every guard against the real input carrying one violating mutation and requires it to fail.
- **Re-run the load check after any change to extension loading, tool or command registration, `session_start`, or the checkout's own `.pi/slate.json`** — those failure modes have no other signal (see § How extension-load failures surface), and the config file is read straight off disk by a check of its own because slate drops an unparseable one in silence. Two things it does on purpose rather than reporting a failure: a **missing `extension/index.ts` makes it exit 2** (refuse to start) — pi would filter a nonexistent entry out of `pi.extensions` silently and every check would pass vacuously — and so does a missing `verification/ci-canary.ts`; and a **pin-vs-installed pi mismatch exits 2** with a `run 'npm ci'` remedy, because the rpc output shapes it asserts are pinned to one pi version.
- **Tier 2 — the verification ladder — is deliberately not in CI yet** (issue #24). It costs ~3 minutes of mostly wall-clock waiting on timing-sensitive rungs, needs GNU coreutils, refuses to run as root, and reports NOT RUN rather than PASS on a slow or tool-poor machine; as a gate on every push that is flake, not signal. It stays a human-read net, run per § Verification ladder.

### How extension-load failures surface (pi 0.83.0)

This file used to say "pi exits 0 even when extension loading fails — success is the ABSENCE of a `Failed to load extension` line on stderr". That is **wrong**, and acting on it is how issue #23 happened. Measured against the pinned pi 0.83.0:

- **Reported *and* fatal** — `Failed to load extension "<path>": <detail>` on stderr **and exit 1**: a syntax error, a broken import that is actually used, a top-level or factory throw, a module with no default export, and `-e <dir>` where the directory has no `package.json` (or nothing resolvable). Also `-e <file>` where the file does not exist. For all of these the exit code is as trustworthy as the string.
- **Genuinely silent** — exit 0 and *no* line matching either marker:
  - an entry in a package's `pi.extensions` that resolves to a **file that does not exist**: pi filters it out without a word and starts up perfectly happily with no extension loaded. This is the shape a real install has, so it is the one that matters.
  - a **throw inside `session_start`**: it surfaces only as an `extension_error` event on **stdout** in rpc mode, or as `Extension error (<path>): <msg>` on **stderr** in text mode. Neither string matches `Failed to load extension`, and the throw does not fail the process (exit 0 in rpc).
  - a **tool registration silently removed**: no diagnostic at all — pi exits 0 with an empty stderr and a fully working `/slate` command.

`verification/run-load-check.sh` encodes all of this so nobody has to remember it: `L1` reads the exit code, `L2` **both** stderr markers, `L3` the stdout `extension_error` channel, `L4`/`L5` the registered tool set through the `verification/ci-canary.ts` positive control, `L6` which copy of slate was loaded.

**And the process trap that most likely produced the wrong claim:** `$?` after a pipeline is the **last** command's status, not the piped process's. Measured on a deliberately broken extension: run directly, pi exits `1`; run as `pi … 2>&1 | head -1`, `$?` is `0` — while `${PIPESTATUS[0]}` for that same pipeline is still `1`, and under `set -o pipefail` the pipeline itself exits `1`. So read a real exit code one of three ways: do not pipe, take `${PIPESTATUS[0]}`, or `set -o pipefail` first — which is what every script in `verification/` does.

### Verification ladder (global model-default restore)

`verification/run-ladder.sh` is the repo's deepest regression net and the only one that touches the global model-default machinery — it is not the only one (see § Tier-1 CI). It covers `extension/model-default.ts` and both switch sites (`extension/failover.ts` failover, `extension/handoff.ts` handoff adoption): the per-key restore rule, the untrustworthy-read stand-downs, the retry budget and the reporting channels — against fake offline providers in a throwaway agent directory, so real pi settings are never touched.

- Run it with `bash verification/run-ladder.sh --repo .` (~3 min; `--only <ids>` for a subset). Not as root, and needs GNU coreutils. Exit 0 means nothing failed and the real settings file is unchanged — rungs can still report NOT RUN, so read the lines; automation should pass `--strict`, which makes any NOT RUN fatal.
- **Re-run it after any change to `extension/model-default.ts` or to either switch site** — that mechanism fails silently when it regresses, so a passing smoke test proves nothing about it. Details, rung table and the timing-sensitive rungs: `verification/README.md`.

### Worker-extension resolver checks

`verification/run-resolver-checks.sh` is the automated net for the worker-extension feature. It loads and exercises exactly two modules against fabricated in-memory registries — no pi session, no real state — in ~1 second: the pure resolver in `extension/worker-extensions.ts` (candidate filtering, load-unit selection, barriers, matching, memoization) and the doctrine rule it feeds in `extension/mode.ts`.

- Run it with `bash verification/run-resolver-checks.sh --repo .` (needs `pi` and `node` on `PATH`). One line per check; exit 0 = all passed, 1 = a check failed.
- **Re-run it after any change to `extension/worker-extensions.ts` (the resolver) or `extension/mode.ts` (the doctrine rule)** — those are the modules it loads. Details and the check table: `verification/README.md`.
- It does NOT touch `extension/worker.ts`: the worker-session load path — the allowlist-mode extension load, the `excludeTools` deny list that keeps slate's dispatch tools out of a worker, and the post-load collision re-check — is out of its scope. Exercise those with the isolated-load smoke test (`pi --no-extensions -e .`) above after changing `extension/worker.ts`.

## Packaging rules

- Pi-bundled SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) must stay in `peerDependencies` with version `"*"` — never bundle them, and they must **never** appear in `dependencies`.
- **The devDependency carve-out.** The same four packages are *also* pinned to exact versions in `devDependencies`, so the typecheck and the load check run against one known SDK. That is correct and has nothing to do with bundling: `devDependencies` are never installed by consumers. Only `dependencies` would be.
- **No install-time lifecycle script, ever.** `prepare`, `postinstall`, `install`, `preinstall` execute on **every consumer install**; none of them may be added to `scripts`.
- The `files` whitelist in `package.json` **must include `docs/`**: the doctrine points at those files at package-resolved paths at runtime, so a publish that omits them ships a doctrine whose every citation dangles — an orchestrator told to read the workflow rules would find nothing there. It is a rule rather than a note because adversarial review raised it as a finding (`AD6` in that round), before any release could hit it.
- The `files` whitelist is asserted by **exact equality**, so changing it deliberately means updating the guard in the same commit (see § Tier-1 CI).
- Keep `"keywords": ["pi-package"]` — it is what lists the package in the pi.dev gallery.

`verification/run-packaging-checks.sh` enforces every rule above. It asserts the manifest *and* the real `npm pack --dry-run` file list, because the manifest alone is not enough: npm expands a whitelisted directory **recursively** and a `files` whitelist makes `.npmignore`/`.gitignore` inert, so a stray file under `extension/` or `docs/` ships invisibly behind a perfectly correct manifest — hence the pack-output policy (allowed file kinds only, no junk or secrets, every doctrine doc the extension references actually shipped). Details: `verification/README.md`.

## Release & versioning

Releases are pinned end to end: this repo dogfoods the exact version it publishes (`.pi/settings.json` pins `npm:ytdb-slate@<version>`) and consumers move only by bumping a pin of their own. That is what makes the order of these steps matter rather than being a preference.

1. If you are targeting a newer pi release, bump the four SDK pins in `devDependencies` to it and refresh `package-lock.json`. Do this **in step with the pi release you target**: the typecheck only sees upstream SDK drift *after* such a bump, so until you bump, a breaking SDK change is invisible here. That is a recorded **accepted risk**, not an oversight — nothing notifies us that upstream moved.
2. Bump `version` in `package.json`.
3. Re-run tier 1 locally before publishing — all four checks (§ Tier-1 CI), not just the typecheck.
4. `npm publish`.
5. Bump the pin in `.pi/settings.json` (`npm:ytdb-slate@<version>`) so this repo dogfoods the new release.
6. Consumers install pinned (`pi install -l npm:ytdb-slate@<version>`); pinned specs are skipped by `pi update`, so consumers bump their pin deliberately — and on every bump they must re-review their project delta docs (`doctrineExtraPath`, `reviewPerspectivesPath`, prompt-doc lists) against the shipped doctrine for drift.
