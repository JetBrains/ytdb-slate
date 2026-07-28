# AGENTS.md — ytdb-slate contributor guide

## Overview

This repo is a [pi package](https://pi.dev/docs/latest/packages) providing the **slate** extension: thread-weaving orchestration for pi (orchestrator dispatches bounded actions to persistent worker threads; results come back as compressed episodes; a shipped doctrine enforces the research/design-review/adversarial-review/track-review workflow, with optional draft-PR publishing).

- Extension entry point: `extension/index.ts`
- Shipped doctrine docs: `docs/`
- Default branch: `main`

## Dogfooding

This repo runs slate on itself:

- `.pi/settings.json` pins the published package (`npm:ytdb-slate@<version>`). A session in this repo runs the released extension — the same thing consumers run. Bump the pin as part of each release (see § Release & versioning).
- Local edits to `extension/` are NOT live in a dogfooding session. Smoke-test them in isolation with `pi --no-extensions -e .` from the repo root — without `--no-extensions`, the pinned npm copy loads alongside your edits and can mask failures. Do not add a local-path package entry to `.pi/settings.json` next to the npm pin: loading the same package from two settings sources has broken pi startup with a file conflict in practice.
- Development follows the package's own `docs/track-workflow.md`, with `workflow.draftPRs` enabled in `.pi/slate.json`.

## Build & verification

- **No build step.** pi loads raw TypeScript via jiti; `extension/index.ts` is consumed as-is.
- **No test suite yet.** Verification is manual:
  1. Load the extension in isolation with `pi --no-extensions -e .` from the repo root (an installed session runs the pinned published package, not your edits) and smoke-test the tools (`thread`, `threads`, `episode`) and doctrine injection.
  2. Judge extension load by output, not exit code: pi exits 0 even when extension loading fails — success is the ABSENCE of a `Failed to load extension` line on stderr. A bare `pi --no-extensions -e . -p "exit"` run exercises only extension registration and `session_start` (config load/validation); it touches no tool execution or failover paths — exercise those explicitly when they change.
  3. Carefully re-read the full diff before committing.

### Verification ladder (global model-default restore)

`verification/run-ladder.sh` is the one automated regression net in the repo. It covers `extension/model-default.ts` and both switch sites (`extension/failover.ts` failover, `extension/handoff.ts` handoff adoption): the per-key restore rule, the untrustworthy-read stand-downs, the retry budget and the reporting channels — against fake offline providers in a throwaway agent directory, so real pi settings are never touched.

- Run it with `bash verification/run-ladder.sh --repo .` (~3 min; `--only <ids>` for a subset). Not as root, and needs GNU coreutils. Exit 0 means nothing failed and the real settings file is unchanged — rungs can still report NOT RUN, so read the lines; automation should pass `--strict`, which makes any NOT RUN fatal.
- **Re-run it after any change to `extension/model-default.ts` or to either switch site** — that mechanism fails silently when it regresses, so a passing smoke test proves nothing about it. Details, rung table and the timing-sensitive rungs: `verification/README.md`.

### Worker-extension resolver checks

`verification/run-resolver-checks.sh` is the automated net for the worker-extension feature. It loads and exercises exactly two modules against fabricated in-memory registries — no pi session, no real state — in ~1 second: the pure resolver in `extension/worker-extensions.ts` (candidate filtering, load-unit selection, barriers, matching, memoization) and the doctrine rule it feeds in `extension/mode.ts`.

- Run it with `bash verification/run-resolver-checks.sh --repo .` (needs `pi` and `node` on `PATH`). One line per check; exit 0 = all passed, 1 = a check failed.
- **Re-run it after any change to `extension/worker-extensions.ts` (the resolver) or `extension/mode.ts` (the doctrine rule)** — those are the modules it loads. Details and the check table: `verification/README.md`.
- It does NOT touch `extension/worker.ts`: the worker-session load path — the allowlist-mode extension load, the `excludeTools` deny list that keeps slate's dispatch tools out of a worker, and the post-load collision re-check — is out of its scope. Exercise those with the isolated-load smoke test (`pi --no-extensions -e .`) above after changing `extension/worker.ts`.

## Packaging rules

- Pi-bundled SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) must stay in `peerDependencies` with version `"*"` — never bundle them.
- The `files` whitelist in `package.json` **must include `docs/`**: the doctrine points at those files at package-resolved paths at runtime, so a publish that omits them ships a broken doctrine (adversarial finding AD6).
- Keep `"keywords": ["pi-package"]` — it is what lists the package in the pi.dev gallery.

## Release & versioning (AD8)

1. Bump `version` in `package.json`.
2. `npm publish`.
3. Bump the pin in `.pi/settings.json` (`npm:ytdb-slate@<version>`) so this repo dogfoods the new release.
4. Consumers install pinned (`pi install -l npm:ytdb-slate@<version>`); pinned specs are skipped by `pi update`, so consumers bump their pin deliberately — and on every bump they must re-review their project delta docs (`doctrineExtraPath`, `reviewPerspectivesPath`, prompt-doc lists) against the shipped doctrine for drift.
