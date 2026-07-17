# AGENTS.md — ytdb-slate contributor guide

## Overview

This repo is a [pi package](https://github.com/earendil-works/pi-coding-agent) providing the **slate** extension: thread-weaving orchestration for pi (orchestrator dispatches bounded actions to persistent worker threads; results come back as compressed episodes; a shipped doctrine enforces the research/design-review/adversarial-review/track-review workflow, with optional draft-PR publishing).

- Extension entry point: `extension/index.ts`
- Shipped doctrine docs: `docs/`
- Default branch: `main`

## Dogfooding

This repo runs slate on itself:

- `.pi/settings.json` pins the published package (`npm:ytdb-slate@<version>`). A session in this repo runs the released extension — the same thing consumers run. Bump the pin as part of each release (see § Release & versioning).
- Local edits to `extension/` are NOT live in a dogfooding session. Smoke-test them with an ad-hoc load: `pi -e .` from the repo root. Do not add a local-path package entry alongside the npm pin — loading both registers the same package twice and pi fails to start on a file conflict.
- Development follows the package's own `docs/track-workflow.md`, with `workflow.draftPRs` enabled in `.pi/slate.json`.

## Build & verification

- **No build step.** pi loads raw TypeScript via jiti; `extension/index.ts` is consumed as-is.
- **No test suite yet.** Verification is manual:
  1. Load the extension in pi with an ad-hoc local load (`pi -e .` from the repo root — an installed session runs the pinned published package, not your edits) and smoke-test the tools (`thread`, `threads`, `episode`) and doctrine injection.
  2. Carefully re-read the full diff before committing.

## Packaging rules

- Pi-bundled SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) must stay in `peerDependencies` with version `"*"` — never bundle them.
- The `files` whitelist in `package.json` **must include `docs/`**: the doctrine points at those files at package-resolved paths at runtime, so a publish that omits them ships a broken doctrine (adversarial finding AD6).
- Keep `"keywords": ["pi-package"]` — it is what lists the package in the pi.dev gallery.

## Release & versioning (AD8)

1. Bump `version` in `package.json`.
2. `npm publish`.
3. Bump the pin in `.pi/settings.json` (`npm:ytdb-slate@<version>`) so this repo dogfoods the new release.
4. Consumers install pinned (`pi install -l npm:ytdb-slate@<version>`); pinned specs are skipped by `pi update`, so consumers bump their pin deliberately — and on every bump they must re-review their project delta docs (`doctrineExtraPath`, `reviewPerspectivesPath`, prompt-doc lists) against the shipped doctrine for drift.
