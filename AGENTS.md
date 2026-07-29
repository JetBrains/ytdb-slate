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

  Two automated nets do exist for the mechanisms that fail silently — the verification ladder and the pure-resolver checks below. Run the one that covers what you touched, and both when you touch something they share: the model-spec helpers in `extension/state.ts` are consumed by `failover.ts`, `episodes.ts`, `worker.ts` and the router, and `extension/base-model.ts` is driven by `failover.ts` and `handoff.ts` — the ladder's own switch sites — so a change to either implicates BOTH.

### Verification ladder (global model defaults across slate's model switches)

`verification/run-ladder.sh` is the automated regression net for slate's model-switch machinery (the pure-resolver checks below are the other net). It covers:

- `extension/model-default.ts` and both switch sites (`extension/failover.ts` failover, `extension/handoff.ts` handoff adoption): the per-key restore rule, the untrustworthy-read stand-downs, the retry budget and the reporting channels;
- `extension/worker.ts`'s worker-session settings isolation, in rung `WK1`: a **worker-side per-dispatch model AND effort switch** — what every routed action performs — writes zero bytes to the global settings file and does not survive into a reopened session as a sticky default. It is the only automated net for that guarantee, and the only rung that opens a worker session at all.

Everything runs against fake offline providers in a throwaway agent directory, so real pi settings are never touched (the run fails if the real file changes).

- Run it with `bash verification/run-ladder.sh --repo .` (~3 min; `--only <ids>` for a subset). Not as root, and needs GNU coreutils. Exit 0 means nothing failed and the real settings file is unchanged — rungs can still report NOT RUN, so read the lines; automation should pass `--strict`, which makes any NOT RUN fatal.
- **Re-run it after any change to `extension/model-default.ts` or to either switch site**, and **after any change to how a worker session is opened or switched** — `extension/worker.ts`'s settings manager, the model/`thinkingLevel` options it passes to `createAgentSession`, or the per-dispatch switch in `threads.ts`'s `applyRoute` (`WK1`). Both mechanisms fail silently when they regress — the switch still works, and the damage lands in the user's own pi configuration — so a passing smoke test proves nothing about either. Details, rung table and the timing-sensitive rungs: `verification/README.md`.

### Pure-resolver checks (worker extensions + model router + dispatch guards + profile table)

`verification/run-resolver-checks.sh` is the automated net for the repo's PURE pipelines. It loads and exercises seven modules against fabricated in-memory registries, fabricated profile tables, fabricated events, a fabricated compaction predicate and an injected clock — no pi session, no real state — in ~1 second:

- `extension/worker-extensions.ts` — the worker-extension resolver (candidate filtering, load-unit selection, barriers, matching, memoization) and the doctrine rule it feeds in `extension/mode.ts`;
- `extension/model-router.ts` — the model router: the `router` config sanitizer, candidate resolution (drops, ordering by preference/tier-sourcing/tier/price, the `nonPreferred`-aware base-model pick, the W1/W3/failover-coverage warnings, dedup, memoization) and the dispatch-side effort predicate;
- `extension/route.ts` — the route planner (`route-*`): the SAFETY CORE of action-level routing, i.e. the seven dispatch guards (effort vocabulary, list membership on both router states, per-model ladder validity, evidence gap, API-rejected level, the never-blocking context-window substitution, long-context billing, and the failover carve-out) plus the base-effort seed. It was extracted from `threads.ts` into a pure module for exactly this harness, because a guard that silently stops guarding still "works": the dispatch runs and an episode is written;
- `extension/state.ts` — loaded directly for the canonical model-spec vocabulary (`isModelSpec` / `splitModelSpec` / `describeSpecDefect` / `describeConfusables`), which `failover.ts`, `episodes.ts`, `worker.ts` and the router all share, plus the single-spec config-key sanitizer (`sanitizeEpisodeModel`) — it lives there rather than in `episodes.ts` because that module imports `@earendil-works/pi-ai` and so cannot be loaded by this harness at all;
- `extension/base-model.ts` — the orchestrator base-model tracker (`base-*`): the pure reducer deciding which model switches move the base model new worker threads inherit (seeding, slate's own declared switches, user/cycle/restore sources, handoff adoption, stale declarations and their TTL, switches in flight, and a setter that throws). Driven with fabricated `model_select` events and an injected clock, so nothing sleeps and no timer can fire after teardown;
- `extension/model-profiles.ts` — STRUCTURAL invariants of the shipped table only (id/alias resolvability, ladder vs measured/gap coverage, price-schedule shape, tier range, freezing). Never a research number: those are a review concern, and a refresh must not have to touch this suite.

- Run it with `bash verification/run-resolver-checks.sh --repo .` (needs `pi` and `node` on `PATH`). One line per check, an `observed:` line under a failure, a `roster` check that every expected check reported, then a summary. Exit 0 = all passed, 1 = a check failed or went missing, 2 = refused to start. Automation should pass `--strict`, which makes any NOT RUN fatal.
- **Re-run it after any change to `extension/worker-extensions.ts`, `extension/mode.ts`'s doctrine rule, `extension/model-router.ts`, `extension/route.ts`, `extension/model-profiles.ts`, `extension/base-model.ts`, or the model-spec helpers in `extension/state.ts`** — those are the modules it loads. A guard change in `route.ts` is the highest-stakes case: re-run it, and if the guard's INPUTS moved (what `threads.ts` injects) re-read the assembler too, since the harness fabricates those inputs. The `state.ts` helpers are shared with `failover.ts`, so a change to them also needs the ladder above. A router change is the same class of hazard as the model-default mechanism: a wrong candidate list or a suppressed warning still "works", so a smoke test proves nothing about it. Details, the check table and the mutation-testing method that gives these checks teeth: `verification/README.md`.
- It does NOT touch `extension/worker.ts`: the worker-session load path — the allowlist-mode extension load, the `excludeTools` deny list that keeps slate's dispatch tools out of a worker, and the post-load collision re-check — is out of its scope. Exercise those with the isolated-load smoke test (`pi --no-extensions -e .`) above after changing `extension/worker.ts`, and the ladder's `WK1` rung for that module's settings isolation. It likewise stops at the PURE boundary: it proves what the planner DECIDES, not what `threads.ts` does with a verdict (applying the switch, raising a tool error, aborting without an episode, remembering the long-context notice) — nor the doctrine's routing rule. Those are separate mechanisms; the ladder's `WK1` rung covers one slice of the first.

## Packaging rules

- Pi-bundled SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) must stay in `peerDependencies` with version `"*"` — never bundle them.
- The `files` whitelist in `package.json` **must include `docs/`**: the doctrine points at those files at package-resolved paths at runtime, so a publish that omits them ships a broken doctrine (adversarial finding AD6).
- Keep `"keywords": ["pi-package"]` — it is what lists the package in the pi.dev gallery.

## Release & versioning (AD8)

1. Bump `version` in `package.json`.
2. `npm publish`.
3. Bump the pin in `.pi/settings.json` (`npm:ytdb-slate@<version>`) so this repo dogfoods the new release.
4. Consumers install pinned (`pi install -l npm:ytdb-slate@<version>`); pinned specs are skipped by `pi update`, so consumers bump their pin deliberately — and on every bump they must re-review their project delta docs (`doctrineExtraPath`, `reviewPerspectivesPath`, prompt-doc lists) against the shipped doctrine for drift.
