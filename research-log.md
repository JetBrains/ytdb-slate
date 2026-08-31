# Research log — dogfood from main-branch sources (issue #198)

## Initial request

User: "Please read issue #198 let us implement it"

Issue #198 "Dogfooding from main branch" (JetBrains/ytdb-slate, OPEN, no labels, no comments), body verbatim:

```
Currently, dogfooding forces provide a release for each change.
We need to dogfood from sources directly, so we need to resolve the file version conflict raised by pi on extension start.

As we can not work on the source code that is in the middle of development, we need to change the project workflow.
1. All changes are made from the session that is located in the main branch and associated worktree.
2. For each new PR, a new worktree is created through the agent session directory, which is the main.

That will allow us to implement the same dogfooding concept without the need to release for every change.
```

## Decision Log

### Current authority index

A reader follows the governing decision. Later decisions win when they amend, reverse, scope or dissolve an earlier decision.

- D24 and D70 — legacy read and write policy — D125.
- D25 — sibling corpus root corrected to child root — D140.
- D29 — session layout and artifact categories amended — D99 and D136.
- D32 — delivery archive owner — D137, current track 08.
- D36 — trust gate reaffirmed against D82's closure list — D104.
- D37, D38, D39 and D64 — dissolved track assignments — D137.
- D43 — identity inheritance narrowed and then eliminated — D85, D120 and D102.
- D53 — branch-label artifact scope clarified against D101 — D53 annotation and D101.
- D68 — identity suffix width — D77.
- D69 — fork-collision reference — D85 and D120.
- D83 — name grammar suffix reference — D77.
- D84 — session path segment — D99.
- D86 — author-path authority — D126 and D133.
- D87 — command split and explicit adoption — D98.
- D88 — non-destructive housekeeping — D106.
- D91 — path containment ownership — D105 and D126.
- D94, D96 and D99 — dissolved relocation and layout assignments — D136 and D137.
- D97 — sub-track plan — D115 and D137.
- D101 and D102 — restore versus foreign-adoption identity handling — D120.
- D105 — followed-path classes — D126 and D133.
- D107 — fork durability — D121, D124, D132, D133 and D134.
- D109 — legacy read and new-write rule — D125.
- D113 — verification re-cut — D118, D128 and D129.
- D115 — track plan — D137.
- D118 — ladder discriminator and citations — D128 and D129.
- D119 — random-bit allocation and retry draws — D127 and D131.
- D121 — pre-open fork verification — D132.
- D123 and D124 — concrete bounds — D133.
- D126 — corpus containment root — D136 and D140.
- D136 — corpus-root location — D140.
- D138 — absent-root handling — D143.
- D142 — verification-safety owner — D146, D150 and D154, all track 04a.
- D146 — negative real-corpus observation replaced by positive scratch-corpus assertion — D150 and D154.
- D147 — resolver-harness corpus redirection — D147 remains governing.
- D224 — immediate author provenance binding — superseded by D227, which binds only identity and name to durable metadata.
- D223 — version 1 compatibility and wire-segment bound wording — superseded by D228 and D234.
- D148 through D157 — track 04a harness review, fixes and residual state — D150, D154 and D157.
- D154 — clear-at-run-start corpus reset — D166, pending the CN110 fix in D170.
- D162 — guarded reset and lock requirements — D166, D170 and D173.
- Track 04a — delivered and user signed off — D177.
- D158 through D165 — later harness gate, adversarial findings and bounded fix round — D162 and D165.

(backfilled from research, entries D1..D6 below)

- D1: The reported "file version conflict" is a pi tool-name collision, not a version check. pi computes package identity as `npm:<name>` or `local:<abs-path>` and never dedupes an npm pin against a local path, so both copies load and registration collides. Evidence: pi 0.83.0 `dist/core/package-manager.js:1363-1381`, `dist/core/resource-loader.js:838-871`, `dist/main.js:588-598`. Reproduced live: `Failed to load extension ".../.pi/npm/node_modules/ytdb-slate/extension/index.ts": Tool "thread" conflicts with .../extension/index.ts`, exit 1.
- D2: Fix by REPLACING the npm pin with one local-path package entry, not by keeping both. Rejected: a filtered pin (`extensions: []`) plus a top-level `extensions` path entry, which also works but loads slate as a bare extension instead of a package and so diverges from how consumers load it.
- D3: Spell the local path `"../"` (project settings paths resolve relative to `.pi`, so it is the worktree root). Rejected `"../../main"`, which would pin every worktree to the main sources, because pi treats a NONEXISTENT local package path as silent success (exit 0, no stderr), so a differently laid out clone would lose slate with no diagnostic.
- D4: No second SDK copy risk. pi's extension loader aliases `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` and `typebox` to the copies bundled inside the running pi binary (`dist/core/extensions/loader.js:8-21,62-109,325-332`). Working-tree `node_modules` is therefore not consulted for those imports at run time.
- D5: No production code change is needed. `extension/paths.ts` resolves `docs/` from its own module location, and `extension/worker-extensions.ts` keys on `origin === "package"` and self-excludes by path, so neither cares whether the package root is a worktree or `.pi/npm/node_modules/ytdb-slate`.
- D6: Empirically validated in throwaway copies with a fresh PI_CODING_AGENT_DIR: the local-path configuration loads `<repo>/extension/index.ts`, registers `thread`, `threads` and `episode`, keeps the other two npm packages working, emits no warning, and behaves the same whether or not the stale `.pi/npm/node_modules/ytdb-slate` directory remains.
- D7: The verification ladder may run from the live main-worktree session under a quiet-session rule, instead of requiring the session to be stopped. Rejected: mandatory session shutdown, which throws away live thread transcripts and the prompt cache for a hazard that measurement shows is narrow.
- D8: No `doctrineExtraPath` file. pi already injects the project `AGENTS.md` into every session and every worker session, so the workflow rule needs no second delivery mechanism and no per-turn token cost.
- D9: Fix the worker-extension self-exclusion barrier in shipped code, rather than moving the two worker extensions to user scope. Rejected the config-only alternative: it is completely silent for a contributor without user-scope entries, and it leaves two measured defects in place. User approved on 2026-08-17.
- D10: Replace the user-scope `npm:ytdb-slate@0.10.0` entry in `~/.pi/agent/settings.json` with the absolute path `/home/andrii0lomakin/Projects/ytdb-slate/main`. Rejected plain removal, because the user runs slate in other projects on this machine. User approved on 2026-08-17.
- D11: Keep the tracked project entry `"../"` alongside the user-scope absolute path. In the main worktree both entries carry the identity `local:<main>`, so pi dedupes them. In any other worktree the identities differ and pi exits 1 with a tool conflict. That loud stop is preferred over the silent wrong-copy load of AD3.
- D12: Raise the change class from Complex to Risky, because the change alters shipped code that decides which extensions load into a worker session and its failure mode is silent.
- D13: Split the change into three tracks: the barrier fix with its resolver checks, the settings switch with a new load-check guard, then the documentation rewrite.
- D14: Simplify and widen the barrier rule. Reject a candidate when its resolved path equals slate's package root, lies inside `<slate root>/extension/`, or contains that root, and also reject any candidate whose package name equals slate's own name. Rejected the earlier `node_modules`-crossing carve-out, which still excluded `.pi/git` and `.pi/extensions` sources, and rejected case folding, which only over-rejects and diverges from pi's own containment test.
- D15: Migrate in three steps, because both two-step orders break new sessions. Step one removes the slate entry from the user-scope settings file, step two merges the project change to the local path, step three adds the absolute path back at user scope.
- D16: Strengthen the track 02 guard with a real session control: a scratch copy whose settings hold the slate entry alone, trusted, started with extensions enabled, asserting one slate load, the three tools and no conflict. Rejected the static-only assertion, which passes on a configuration that makes a real session exit 1.
- D17: The rebuilt registry validation asserts explicit trust, a loaded path inside the installed package, the three registered tools, and an interactive step that reaches the doctrine. A headless run never builds the doctrine.
- D18: The project settings swap belongs to track 02 and lands after track 01. If it landed first, both worker extensions would drop silently.
- D19: Track 01 keeps a justified residual. A package source pointing at an entry file exposes no manifest, so the package-name rule cannot fire for that shape. The proper lookup needs a parent-directory manifest walk, which the module forbids. The tool-name collision barrier withholds such a copy, and a test pins that backstop. A gate thread verified the test fails when the barrier stops withholding.
- D20: Slate mints one session-lineage identity as a sortable timestamp joined to a short filename-safe random suffix. Rejected: the pi session identifier, which changes at handoff, and thread ordinals, which restart per session.
- D21: The identity is a state-snapshot field persisted through the existing custom session entry. Rejected: a separate identity file, which creates a second truth and failure mode.
- D22: The pending handoff already carries the whole snapshot, so a successor keeps the predecessor identity and directory after the existing parent-session match. Rejected: a duplicate handoff match key.
- D23: Restart and branch restore recover the identity from the restored snapshot; only a fresh session without a snapshot or pending handoff mints one. Rejected: minting at every start, which orphans prior artifacts.
- D24: A snapshot without an identity remains in legacy-path mode for that lineage. Rejected: adding an identity during old-session restore, which strands its recorded artifacts.
- D25: The default corpus root is the `ytdb-slate/projects` sibling of the pi agent directory, exactly `~/.pi/ytdb-slate/projects` under the default agent location. C2 is withdrawn because every current harness assigns `PI_CODING_AGENT_DIR` to a scratch `agent` subdirectory.
- D26: The corpus root has no new environment-variable or project-config override. Derivation follows agent-directory machine policy, while a new environment variable could leak through the load-check and ladder harnesses.
- D27: The project key is `git rev-parse --path-format=absolute --git-common-dir` with `GIT_DIR` and `GIT_COMMON_DIR` removed; on git failure it is the resolved current working directory. Rejected: the bare git form, which is subdirectory-relative, and inherited git variables, which can merge unrelated projects.
- D28: The project directory is `<readable>-<digest>`, where the readable candidate order is sanitized `corpusName`, origin basename without `.git`, key-parent basename, then `project`, and the digest is the first 12 lowercase hexadecimal SHA-256 characters of the resolved key. A declared leaf label does not turn the machine-policy root into project policy.
- D29: The layout is `<root>/<project>/<session>/<category>/`; observations, episodes, worker transcripts and the pending handoff file move, with the file directly under the session directory and categories `observations`, `episodes` and `threads`. Rejected: moving transcripts alone or flattening categories.
- D30: The state snapshot stays in the pi session file because pi owns its branch semantics and the snapshot carries the identity needed to find all other artifacts. Rejected: a corpus mirror that can diverge.
- D31: The research log stays at the change worktree root and is archived to the corpus at delivery. C1 is approved because the log is per change while a session directory is per session, and this change already spans two sessions.
- D32: Track 08 owns the delivery-time research-log archive copy. Rejected: no archive, which loses change evidence after worktree deletion, and a moved working log, which breaks doctrine and review locality. [track owner now: 08]
- D33: Existing artifacts are not migrated, and legacy project paths remain a read-only restore fallback. Rejected: a startup bulk copy, which can be slow and leave two partial truths.
- D34: An unwritable corpus root produces a loud refusal and never silently falls back into the checkout. Rejected: silent fallback, which restores project pollution and hides misconfiguration.
- D35: Artifact references become session-relative logical names resolved at read time; absolute paths do not enter prose or metadata. The fallback project key is resolved cwd, measured for `/tmp` as `project-e9671acd2448` after git exit 128.
- D36: The pending-handoff trust gate stays as defence in depth after the file moves. Session data may outlive a deleted checkout, and a pruning command is deferred to its own issue.
- D37: Tracks 04 to 08 extend D13 without renumbering tracks 01 to 03. Track 08 covers contributor guidance, doctrine, the research-log ruling and delivery archive. [track owner now: 04a-04d, 08]
- D38: Track 07 requires the full verification ladder because it changes worker-session opening. Rejected: an isolated smoke test, which cannot detect settings-isolation regressions. [track owner now: 04b]
- D39: Tracks 04 to 06 require pure-resolver checks and unit tests with the patch-coverage gate. Rejected: unit tests alone, because resolver checks pin path-derivation and validator agreement. [track owner now: 04a-04c]
- D40: The change remains Risky under D12. All worktrees of one clone deliberately share the common-directory key, while repository-directory renames split identity, separate clones stay separate, and a 12-hex digest has an accepted theoretical untested collision risk.

## Planned changes

Goal: dogfood slate from the main worktree's sources, so that no npm release is needed for each change, and record the worktree workflow that this makes possible.

Configuration.
1. Project `.pi/settings.json`: replace `"npm:ytdb-slate@0.10.0"` with `"../"`. The entry is tracked, layout independent, and resolves to the worktree root.
2. Machine user scope `~/.pi/agent/settings.json`: replace `"npm:ytdb-slate@0.10.0"` with `/home/andrii0lomakin/Projects/ytdb-slate/main`. One time, outside the repository.
3. Deliberate consequence: a session in the main worktree sees one identity and loads one copy. A session in any other worktree sees two identities and exits 1 with a tool conflict, which enforces the rule that sessions run in main. The isolated smoke test is unaffected, because it passes `--no-extensions`.
4. One-time cleanup: delete the stale `<main>/.pi/npm/node_modules/ytdb-slate`, which nothing prunes.

Track 01, barrier fix. Narrow the self-exclusion barrier in `extension/worker-extensions.ts`. Reject a candidate only when its unit path or a tool entry path, compared after realpath resolution, trailing-separator stripping and case folding, equals slate's package root, lies under that root without crossing a nested `node_modules`, or contains that root. Keep the AD24 protection for slate's own entry file, for a second manifest entry, and for an ancestor of the root. Accept an unrelated package under `<root>/.pi/npm/node_modules/`. Add six resolver checks named `bar-self-nested`, `bar-self-second-entry`, `bar-self-symlink`, `bar-self-escape`, `bar-self-trailing` and `bar-self-case`, and add each to the EXPECTED roster.

Track 02, settings guard. Add a load-check rung that reads `.pi/settings.json` from disk and asserts that the slate entry is a local path resolving to a directory whose `package.json` names this package and whose `pi.extensions` entry file exists. A wrong path is silent in pi, so this guard is the only signal. CI runs it.

Track 03, documentation. Rewrite the `AGENTS.md` dogfooding section for source loading, the migration steps and the exact conflict error text. Add a worktree-workflow section: the session runs in main, each change gets a sibling worktree, dispatches use absolute paths, a new worktree needs `npm ci --ignore-scripts`, the research log lives at the change worktree root, main stays clean and is verified clean before each user review, and the after-merge procedure fast-forwards local main before the session restarts. Keep the ladder run-alone rule as the default and add the quiet-session variant with its operational definition and disposition procedure. Remove every pin-dependent element from `RELEASING.md`, which renumbers from ten steps to nine, and rebuild the post-publication registry-load validation as a throwaway project with its own agent directory and its own settings file. Reword the stale dogfood labels in `docs/context-budget.md` and `verification/README.md`. Leave `README.md` unchanged.

Residual risks.
1. A broken main now blocks every session on this machine, because the user-scope entry points there too. Recovery is `pi -ne` or a checkout of a good commit. The load check on main is the preventive net.
2. A relative-path dispatch can still edit the live sources in main. The mitigation is the absolute-path rule plus the clean-tree check.
3. A contributor without a user-scope entry loads their own change worktree's slate. This is documented.

Scope boundary. No consumer install change in `README.md`. No packaging change. No ladder trigger module is touched.

Deferred. The pi version skew between the 0.83.0 devDependency pin and the 0.84.2 global install becomes its own issue. A warning when a `workerExtensions` pattern resolves to zero units becomes its own issue, because it would have caught this defect on its first day. Packaging-net consolidation stays deferred.

### Accepted risks

1. A broken main blocks every session on this machine, because the user-scope entry points there. Recovery is `pi -ne` or a checkout of a good commit.
2. A relative-path dispatch can still edit the live sources in main. The mitigation is the absolute-path rule plus a clean-tree check before each user review.
3. A missing entry file under main loses slate silently, because pi drops a nonexistent local path without a message.
4. A contributor without a user-scope entry loads their own change worktree's slate.

Design review (pre-adversarial): user-approved — 2026-08-17
Adversarial review: passed, 4 accepted risks — 2026-08-17
Design review (pre-implementation): user-approved — 2026-08-17

### Approved amendment: issue #200 slate session directory

Goal. Give each slate session lineage a unique identity, move session artifacts out of the checkout, and retain one durable corpus per project for later telemetry work. This amendment defines storage only; it grants no collection, reading or transmission of telemetry and changes no artifact format.

Conflicts and rulings. C1 is approved as recommended: the working research log stays at the change worktree root, then a delivery copy enters the corpus. The decisive mismatch is lifetime: the log is per change, the session directory is per session, and this change already spans two sessions. C2 is withdrawn: the default root is exactly `~/.pi/ytdb-slate/projects`, derived as the `ytdb-slate/projects` sibling of the pi agent directory. C3 remains: the state snapshot cannot move from the pi session file. C4 extends D13 with append-only tracks 04 to 08. C5 remains: telemetry behavior is outside scope.

Evidence for C2. Every current `PI_CODING_AGENT_DIR` assignment uses a scratch subdirectory named `agent`, never the scratch root: `verification/run-load-check.sh:246-248`, `verification/run-writing-reminder-check.sh:74,112`, `verification/run-ladder.sh:232-236,347-349,766-772,1298-1304`, and `test/cache-key-shards.test.ts:30,38`. Deriving a sibling therefore stays inside each scratch root. A future harness that assigns its scratch root directly would escape that root, so the contributor guide must preserve the `agent`-subdirectory rule.

Root policy. No new root environment variable or `.pi/slate.json` root key is added. `run-load-check.sh` and `run-ladder.sh` pass unlisted environment variables through, so a developer-shell value could leak into verification. The derived root already follows `PI_CODING_AGENT_DIR` through pi's agent-directory resolver. An unwritable root causes a caller error and user notice, with no silent checkout fallback.

Session identity. Slate mints a sortable timestamp plus a short random suffix for a fresh session with no snapshot or pending handoff. The filename-safe identity becomes part of the state snapshot and persists through the existing custom session entry. A restart or restored branch recovers it from the snapshot. The pending handoff already carries the complete snapshot, so a matched successor adopts the same identity and directory. A legacy snapshot without identity remains on legacy paths for its entire lineage.

Project identity. The key is the output of `git rev-parse --path-format=absolute --git-common-dir`, run with `GIT_DIR` and `GIT_COMMON_DIR` removed. The bare form is invalid here because measurement from `main/extension` returned the relative value `../.git`. Either inherited variable made an unrelated directory adopt another repository's exact identity, silently merging projects. If git reports no repository or exits non-zero, the key is the resolved current working directory; `/tmp` measured git exit 128 and final name `project-e9671acd2448`.

Readable naming. Candidate order is a declared string `corpusName` in `.pi/slate.json`, origin-remote basename with a trailing `.git` removed, parent basename of the key, then literal `project`. Each rejected candidate falls through. Sanitization permits exactly one path segment: reject empty, `.`, `..`, separators, Windows reserved names, whitespace-only values and leading hyphens; strip controls, collapse whitespace runs to one hyphen, and cap length. A declared label does not contradict machine root policy because it controls only a sanitized leaf label and the digest provides uniqueness.

Directory derivation. Join the readable name to the first 12 hexadecimal characters of SHA-256 over the resolved key. This clone measured `ytdb-slate-0d66e54fb12b` from a subdirectory and across all 29 worktrees. All worktrees of one clone share the resolved common directory and therefore one project directory, answering Q7. Accepted limits are measured: renaming the repository directory changes the key and splits identity; two clones of one remote remain separate; the truncated digest has a theoretical collision risk that was not tested.

Layout and movement. The layout is `<root>/<project directory>/<session identity>/<category>/`. Categories are `observations`, `episodes` and `threads`; the pending handoff file lives directly under the session directory. Observations, episodes, worker transcripts and the pending file move. The state snapshot stays in the pi session file because pi owns branch restoration and the snapshot contains the identity needed to locate everything else. Existing artifacts are not migrated. Legacy project paths remain a read-only validation and restore fallback.

References and safety. Artifact references become session-relative logical names, with absolute paths resolved only when read. The handoff trust gate remains after relocation. Per-session directories remove current cross-session last-writer-wins collisions. A cloned checkout can no longer seed the external pending file, but defence in depth remains useful.

Workflow boundaries. The storage key needs no distinction between worktree and plain-clone workflows. Adversarial measurement covered a plain clone, nested subdirectory, worktree layout, bare clone with worktrees, submodule and symlinked path without finding a layout that required one. The research-log location and branch label are the only workflow-dependent items, and both remain doctrine. The orchestrator records the branch label as session metadata through doctrine, not code. Slate has no branch subprocess: the only extension subprocess is `extension/size-grade.mjs:96-101,178-185` and never requests a branch, while the pi software development kit exposes branch data only through an unused footer factory.

Lifecycle rulings. Q8 is approved: corpus data outlives deletion of its checkout. Automatic pruning is out of scope and becomes its own issue. Q9 is approved: track 08 owns the delivery-time archive copy. The research log remains beside the change until delivery, preserving review access and its per-change lifetime.

Failure modes and nets. Wrong-root derivation can silently split a corpus. Derivation and validation drift can silently drop restored episodes. Resolver checks must pin project-key derivation, sanitizer fallthrough, layout and legacy fallback; unit tests and patch coverage cover implementation branches. Track 07 changes worker opening and requires the full ladder, especially `WK1`. Handoff changes also trigger the writing-reminder integration check and ladder. Doctrine edits trigger resolver doctrine checks and context-budget rendering. The load check proves loading, not artifact placement; packaging and writing-checker nets remain unrelated unless their normal path triggers apply.

Track split. Tracks 04 to 08 extend tracks 01 to 03. Identity lands first, then root and layout. Artifact and transcript moves follow root support. Documentation lands last and includes the delivery archive. No consumer installation or artifact-format change is included.

Accepted risks. A changed repository-directory name splits the corpus identity. Separate clones of one remote intentionally remain separate. Twelve hexadecimal digest characters carry a theoretical collision risk. External session data survives checkout deletion until a future pruning facility exists. A future harness violates isolation if it sets `PI_CODING_AGENT_DIR` directly to its scratch root rather than a child named `agent`.

Design review (pre-adversarial), issue #200 amendment: user-approved — 2026-08-18

## Surprises & Discoveries

- S1: A nonexistent local-path package entry is a SILENT no-op in pi 0.83.0 (exit 0, empty stderr). An existing directory with no loadable module is loud (exit 1). This asymmetry drives D3.
- S2: The stale `.pi/npm/node_modules/ytdb-slate` directory is never pruned when the pin leaves the settings file. `pi update` ignores local entries and reconciles nothing.
- S3: A new git worktree is untrusted, so a session started there loads no project settings and no slate at all until the user trusts it. `npm ci --ignore-scripts` in a fresh worktree costs about 3 seconds.
- S4: `verification/run-load-check.sh` rung L6 asserts only that the loaded `/slate` path lies inside the repo under test, so it is source-agnostic and needs no change.
- S5: The ladder never reads this checkout's `.pi/settings.json`. Every pi invocation uses `--no-extensions` plus an explicit `-e <repo>` path and writes its own fixture config through `slatecfg()` (`verification/run-ladder.sh:407`). Replacing the npm pin therefore cannot change any rung.
- S6: An idle pi session performs no write to the global settings file. Measured against a copy of the real agent directory: session start moved nothing, and 60 seconds of idling moved nothing. Only a model switch, a thinking-level change, a settings or theme panel action, a package change, or a fresh-session startup write moves it.
- S7: Slate's failover writes the global settings file on the switch and then restores it (`extension/failover.ts:287,310`, `extension/model-default.ts:540-587`). The final content matches the original, so a concurrent-writer false alarm shows an equal hash and size with only the mtime moved. That is exactly the shape AGENTS.md documents.
- S8: Slate worker sessions never write the global settings file. They use an isolated in-memory settings manager (`extension/worker.ts:229-238,341-378`), so routed per-action model and effort switches are safe during a ladder run.
- S9: The ladder takes no lock and scans no process table, so it cannot detect a concurrent pi session. It also refuses an inherited `PI_CODING_AGENT_DIR` (`verification/run-ladder.sh:122-133`) because it must own that redirect.
- S10: The user-scope settings file already listed `npm:ytdb-slate@0.10.0`. Identity dedup hid it while the project entry was also an npm pin. This is the conflict issue #198 reports, reproduced as exit 1 with `Tool "thread" conflicts with <main>/extension/index.ts`.
- S11: The self-exclusion barrier is a prefix containment test (`extension/worker-extensions.ts:111,117-120,329`, finding tag AD24). Under a checkout-root load it swallows every package installed under `<checkout>/.pi/npm/node_modules/`. Measured: the npm layout returns two units, the checkout layout returns zero units and zero warnings.
- S12: No warning fires when a `workerExtensions` pattern resolves to zero units. `extension/mode.ts:170-171` returns an empty rule silently, and the resolver check `match-none` pins that silence.
- S13: The only post-publication proof that the registry artifact loads under pi lives inside the dying dogfood-pin step of `RELEASING.md`. It must be rebuilt, not deleted.
- S14: `docs/context-budget.md` and `verification/README.md` need no figure changes. Their published columns are portable counts that strip the documentation directory. Only the stale word "dogfood" needs rewording.
- S15: A trusted session in a change worktree root stops loudly with a tool conflict, but an untrusted worktree, or a working directory below the worktree root, loads main's sources instead, because project settings never load. The earlier loud-stop claim was too broad.
- S16: A headless run never reaches the doctrine builder, because orchestrator mode seeds only when the session mode is the terminal interface. A registry validation that omits an interactive step proves nothing about the doctrine.
- S17: The orchestrator proposed retaining the npm pin as a filtered entry beside the local path, then withdrew it. D11 deliberately requires a non-main worktree session to stop loudly with a tool conflict, and filtering the pin would remove that stop. A live probe reproduced exit 1 against the real user-scope settings; that is the documented pre-migration state under D15, not a defect.
- S18: The track 02 gate on commit `757657b` returned no findings. All 14 load-check rungs passed, and mutation proved both new rungs discriminate. ShellCheck is absent on this machine, so the dead-code verdict rests on manual reading.

## Open Questions

- Q1 (RESOLVED, see D8): no doctrine extension file is needed, because pi injects `AGENTS.md` into every session and worker.
- Q2: How far does `RELEASING.md` shrink once the dogfood pin step disappears?
- Q3 (RESOLVED): the research log lives at the change worktree root. This log already does.
- Q4 (RESOLVED): `docs/context-budget.md` needs no figure refresh, because the published columns are portable counts. Only the labels change.

## Suggestions

- SG1: Warn when a `workerExtensions` pattern resolves to zero units. Location: `extension/worker-extensions.ts` matching stage and `extension/mode.ts:170-171`. Why it matters: the silence hid a total loss of worker capability during this design. A fix needs a warning on the resolver's warning channel plus a resolver check that pins the text.
- SG2: Prune or detect the stale managed package copy. Location: `<project>/.pi/npm/node_modules/ytdb-slate`. Why it matters: nothing prunes it when the settings entry leaves, and a reader can mistake it for the authoritative source. A fix needs either a documented one-time deletion or a check that reports an orphaned managed package.
- SG3: The writing checker reports fail-level matches in this log's Decision Log, mostly sentences above the length limit. Research logs are excluded from the convention, so this is advisory. The delivery commit body is governed, so the folded text needs a rewrite pass at delivery.
- SG4: Remove the redundant first clause of the self-load rule. Location: the self-load path predicate in the worker-extension resolver. Why it matters: the equality clause is fully subsumed by the ancestor clause, so it reads as a distinct decision that no input can reach. A fix needs the clause deleted and the comment updated.
- SG5: Remove the dead trailing-separator helper. Location: the path-comparison helper in the worker-extension resolver. Why it matters: path resolution already drops trailing separators, so the helper never changes a result, and a reader assumes it carries weight. A fix needs the helper deleted after re-proving the equivalence.
- SG6: Correct the tool-registration comment. Location: the boundary comment above slate's package constants in the worker-extension resolver. Why it matters: the comment says first-wins registration, while pi's tool registry is last-wins, so a reader draws a wrong conclusion about which copy survives. A fix needs the comment reworded.
- SG7: Resolve the two boundary paths once per resolution. Location: the self-load barrier in the worker-extension resolver. Why it matters: both boundaries derive from module constants, yet each unit re-resolves them, which costs repeated filesystem calls and lets a mid-resolution symlink swap split the decision. A fix needs the two values computed once and passed down.
- SG8: Pin the invariant that every slate entry point lives in the source directory. Location: slate's package manifest and the self-load barrier. Why it matters: the source-directory rule is sufficient only while that invariant holds, and nothing enforces it, so a new entry point outside that directory would be accepted into a worker session. A fix needs a check that compares the manifest entries against the directory.
- SG9: Stop hardcoding the copied files in the nested-package resolver check. Location: the nested-package check in the pure-resolver suite. Why it matters: the check copies a fixed file list into a fabricated checkout, so a new local import in the module under test breaks the check with an unrelated error instead of a clear failure. A fix needs the copy driven from the module's real import set.
- SG10: No automated check asserts the help output or the note output of the load check, so both can regress silently. A fix needs a small self-check in the harness.

## Track table

| Track | Scope | Status |
| --- | --- | --- |
| Track 01 barrier fix | `extension/worker-extensions.ts` plus six resolver checks. | landed, user-approved 2026-08-17 |
| Track 02 settings switch and guard | Project settings swap plus the new load-check guard rung. Lands after track 01. | landed, user-approved 2026-08-18 |
| Track 03 documentation | Documentation rewrite across `AGENTS.md`, `RELEASING.md`, `docs/context-budget.md` and `verification/README.md`. | planned |
| Track 04 identity | Session identity in the snapshot, carried through handoff. Historical row superseded by the approved 04a–04d recut. | superseded |
| Track 04a corpus and identity | Corpus root, project and session identity, namespaced artifacts, containment, legacy reads and status. | delivered, user-approved 2026-08-19 |
| Track 04b transcript fork | First-use worker transcript fork into the corpus, with durability and persistence ordering. Absorbs former track 07. | delivered, user-reviewed 2026-08-19; marker `ea8aefd` landed |
| Track 04c mechanism | Corpus handoff record, validation order, explicit adoption command, trust ordering, refusal, candidate listing and pending-handoff claim-marker deletion. | delivered, user-approved 2026-08-20 |
| Track 04d session commands | Session listing and explicit prune commands. | delivered, user-approved 2026-08-21 |
| ~~Track 04f explicit prune~~ | One named-session prune command with ordered safety gates and tombstone recovery. | moved to tracker issue 245; no reserved track number |
| Track 04e shipped text and verification | Shipped text corrections and the verification re-cut moved from approved track 04c. | delivered, user-approved 2026-08-20 |
| ~~Track 05 root and layout~~ | Retired. Its corpus work moved into track 04a. | retired |
| ~~Track 06 artifact move~~ | Retired. Its artifact work moved into tracks 04a and 04c. | retired |
| ~~Track 07 transcript move~~ | Retired and absorbed into track 04b. | retired |
| ~~Track 08~~ | ~~Mandatory delivery archive implementation and workflow split. Superseded before review and will not land. Historical artifacts remain unchanged.~~ | ~~abandoned~~ |
| Track 09 | Retire the delivery-archive contract and remove the superseded uncommitted archive implementation, configuration, doctrine, documents, package paths, and verification contracts. | Complete, user-approved 2026-08-26; marker `f03f171` |
| Track 10 | Add the authoritative external namespace foundation, immutable new-policy boundary, state validation, durable publication, and focused storage tests. | Complete, user-approved 2026-08-26; marker `cbc6050` |
| Track 11 | Integrate external authority with runtime state, delayed fresh binding, saves, restoration, Pi locator state, legacy no-migration behavior, and focused tests. | Complete, pushed, and published in draft pull request #211; user-approved 2026-08-27; strict ladder passed; implementation committed; coverage passed; marker committed; Tracks 12 through 15 remain pending |
| Track 12 | Implement caller-sequenced handoff and sequential interruption recovery for fresh durable sessions, with structural validation and safe legacy refusal. Slate does not assign same-session ownership or resolve same-session conflicts. | In progress |
| Track 13 | Implement project-independent advisory discovery and post-removal read-only lookup with sibling isolation, structural validation, and no ownership or conflict enforcement. | Planned |
| Track 14 | Implement the namespace-owned research log and historical terminal records. Keep project-writer guidance limited to a project file shared by different Slate sessions, without same-session enforcement. | Planned |
| Track 15 | Integrate public guidance, lifecycle wiring, acceptance tests, manual probes, and repository verification without restoring same-session coordination or conflict enforcement. | Planned |

## Session handoff 2026-08-17

State. Track 01 is complete, user-approved, and closed by its marker commit. Track 02 is implemented and reviewed, and its last fix round is not yet gated. Track 03 has not started.

Track 02 review history. Two perspectives produced twelve findings and no blockers. Four gate rounds followed. Gate rounds one and two verified every finding of their round. Gate round three left two findings open. Gate round four cleared nothing and filed a third blocker, which triggered the no-progress rule and an escalation to the user.

The escalation and its outcome. The user-scope note tried to predict pi's package-identity decision inside the harness. Three attempts diverged from pi in both directions, and each round exposed a new leak or a new disagreement. The user chose to replace the note with one fixed sentence that carries no variable content. The note now reports a possibility instead of a verdict, and a note that fires without a real conflict is accepted.

Next steps, in order.
1. Gate the last track 02 fix, which is commit 757657b. It must confirm that no variable text reaches the note, that no identity comparison survives, that no dead helper from the deleted mechanism remains, and that every rung still passes and still discriminates.
2. Present track 02 for user review, then land its marker commit and update the pull request row.
3. Implement track 03, the documentation rewrite. Its known requirements are recorded in this log and include the stale dogfooding text and load-check description in the contributor guide, the release runbook's dogfood-pin removal with the post-publication registry check rebuilt, the three-step migration order, the quiet-session rule for the ladder, the research-log location, the absolute-path dispatch rule, and the stale dogfood labels in the context-budget document and the verification reference.
4. Flip the pull request out of draft only after every track passes user review, following the publishing checklist.

Machine state. Nothing is merged, so the machine is unchanged. The user-scope settings file still names the published package, and the project entry on this branch names a local path. The three-step migration must run in order after the merge: first remove the slate entry from the user-scope settings file, then merge, then add the absolute path to the main worktree back at user scope. A session started before that migration completes can exit 1 with a tool conflict.

Suggestions carried forward. SG1 through SG9 are recorded above. Add SG10: no automated check asserts the help output or the note output of the load check, so both can regress silently. A fix needs a small self-check in the harness.

## Decision Log (continued)

- D41: The pending handoff file lives under `<root>/<project>/pending/`, keyed by the parent pi session identifier. A successor derives the project before identity lookup, concurrent handoffs use distinct files, and the adoption trust gate stays. Rejected: a per-identity location, which is circular, and one clone-wide file, which widens mis-adoption races.
- D42: Restored session identities pass the snapshot sanitizer, must match a strict format, and must be safe as one path segment. A rejection is reported and treated as absence, placing that lineage on legacy paths; pure-resolver state-sanitizer checks pin the behavior.
- D43: The snapshot records the pi session that minted its identity. Identity crosses pi sessions only through explicit matching pending-handoff adoption. Rejected: unconditional snapshot inheritance, which makes forked lineages collide.
- D44: A session seeing an identity minted by another pi session without matching pending adoption mints a fresh identity. A rewind before the first snapshot can therefore create a second identity, which is accepted and documented.
- D45: The digest is authoritative and the readable label is cosmetic. Resolution reuses an existing root directory ending in the same digest suffix regardless of label, and creates one only when none exists; an unreachable restored episode always produces a visible warning.
- D46: Slate probes corpus-root writability once at session start before dispatch. Observation-write failure degrades without failing the action, while episode and handoff writes must not silently lose data; this replaces the earlier uniform write-time refusal rule.
- D47: Derivation splits into a pure function covered by resolver checks and a thin uncovered git-subprocess adapter. `WK1` covers worker settings isolation, not transcript placement, and every pi-starting harness gains an assertion that the real corpus remains untouched.
- D48: Doctrine exposes the resolved session-directory path. The orchestrator uses ordinary file tools to write session metadata, including the branch label, and the delivery research-log archive there; no tool or snapshot label field is added, and doctrine-budget checks measure the added per-turn path cost.
- D49: Agent-directory isolation requires every `PI_CODING_AGENT_DIR` assignment to name a nonempty child of its scratch root, not necessarily a child named `agent`. A repository enclosing another repository can map both to one project directory, but session directories prevent overwrite; this is accepted.
- D50: One change may span legacy and corpus storage across migration because D33 forbids automatic migration. This split is accepted, and guidance recommends finishing a change before migration where practical.

## Planned changes (continued)

### Adversarial round 1 triage and design revision, issue #200 amendment

REVERSALS.

R1. Findings AD1 and AD6. Outcome: reversed. The pending handoff file must NOT live inside the per-session directory. A successor knows its parent pi session, not the predecessor identity, so an identity-named location is circular and fails silently. It also must not become one shared file for a whole clone, because that widens the existing mis-adoption race to every worktree. Revised design: the pending handoff file lives at the project level of the corpus, in a `pending` subdirectory, and its filename derives from the PARENT pi session identifier. The successor derives the project directory without any identity, then looks up its own parent session identifier. Two concurrent handoffs therefore cannot target one file. The existing trust gate on adoption stays.

R2. Finding AD2. Outcome: reversed. The session identity must be validated on restore, exactly like the other snapshot fields. Revised design: the identity joins the snapshot sanitizers. It must match a strict format, and it must be safe as one path segment. A rejected identity is treated as absent, so that lineage falls back to the legacy project paths and the failure is reported rather than silent. The pure-resolver suite gains checks for this, in the existing state sanitizer family.

R3. Findings AD3 and AD10. Outcome: reversed. A forked lineage copies the state entries, so two lineages would inherit one identity and collide again. Revised design: the snapshot also records the pi session that minted the identity. Identity is inherited ONLY through the explicit pending-handoff adoption path. A session that finds a snapshot minted by a different pi session, with no matching pending adoption, mints a fresh identity. Consequence: a rewind past the first snapshot mints a second identity, which is accepted and documented.

R4. Finding AD4. Outcome: reversed. The readable label is mutable, so a changed declared name or a changed origin URL would re-home the whole corpus. Revised design: the digest is authoritative and the label is cosmetic. Resolution first scans the root for an existing directory whose name ends with the same digest suffix, and reuses it whatever its label. A new directory is created only when no such directory exists. Additionally, an episode that a restore cannot reach must produce a visible warning, never a silent drop.

R5. Finding AD7. Outcome: reversed. A refusal on an unwritable root can wedge a paused orchestrator, and it can fail an episode write after the worker was already billed. Revised design: the root is probed for writability once at session start, and a failure is reported then, before any work is dispatched. The per-path policy becomes explicit and consistent: an observation write degrades without failing the action, and an episode write and a handoff write must not silently lose data. The earlier plain rule of a loud refusal at write time is replaced by this policy.

R6. Finding AD8. Outcome: reversed. The failure-mode section claimed net coverage that the nets do not provide. Revised design and corrected claims: ladder rung `WK1` covers worker session settings isolation and does NOT cover worker transcript placement. The pure-resolver suite cannot exercise a git subprocess, so the derivation must be split into a pure part that the suite can check and a thin subprocess part that it cannot. No existing net checks that a verification run leaves the real corpus untouched, so a corpus isolation assertion is added to the harnesses that start a pi process, in the same spirit as the ladder's existing real-settings check.

R7. Findings AS2 and AS3. Outcome: reversed. The design promised a branch label recorded as session metadata and a delivery-time research-log archive, and no mechanism existed for either. One mechanism fixes both. Revised design: the resolved session directory path is exposed to the orchestrator in the doctrine. The orchestrator then writes a session metadata file and the delivery-time research-log archive with ordinary file tools. No new tool is added, no new snapshot field is needed for the label, and the archive gains a defined destination inside the session directory. Cost: one additional path in the doctrine, which is a per-turn token cost that the doctrine size budget check must measure.

STRENGTHEN.

S1. Finding AD9. Outcome: strengthened. The cited evidence for the root derivation was imprecise. One site is `verification/run-load-check.sh:246-248`, which assigns `$WORK/agent-$label` and not a directory named exactly `agent`. Corrected invariant: every site assigns a CHILD of its scratch root, never the scratch root itself and never an empty value. The conclusion is unchanged.

ACCEPT AS RISK.

A1. Finding AD5. Outcome: accepted risk. A repository that encloses another repository, for example a home-directory dotfiles repository, makes both share one common directory and therefore one project directory. Sessions still keep separate directories, so nothing is overwritten. Accepted and documented.

A2. Finding AS1. Outcome: accepted risk. One change can write artifacts under the legacy project path and under the new corpus root when it spans the migration boundary. No automatic migration exists by decision D33. Accepted and documented, with guidance to finish a change before migrating where practical.

Review confirmations. The git common-directory key was independently re-verified across all 29 worktrees and matched. The declared corpus name is correctly trust gated. Worker transcript filenames cannot collide because they carry a version 7 universally unique identifier. No other pi code path assigns the agent-directory environment variable differently.

Adversarial review round 1: 10 reversals folded, 1 strengthened, 2 accepted risks — 2026-08-18

## Decision Log (continued)

- D51: On explicit handoff adoption, the successor re-stamps the identity's minting session to its own pi session. Rejected: retaining the predecessor stamp, which makes the first ordinary successor resume treat the identity as foreign and orphan corpus artifacts.
- D52: Identity ownership compares pi session identifiers only. Rejected: comparing session file paths, whose non-canonical spelling or symlink form can misclassify a resume as a fork.
- D53: Slate code writes session metadata at session start, while a dispatched worker writes the delivery research-log archive and branch label. Doctrine still exposes the resolved session directory. Rejected: ordinary orchestrator file writes, because its tools are read-only and doctrine forbids direct edits. [D53 governs only its dispatched-worker metadata/archive artifact; D101 governs the branch label in `session.json`.]
- D54: A present but unusable identity is reported and replaced with a fresh corpus identity. Legacy paths apply only when the snapshot has no identity field. Rejected: sending malformed post-migration snapshots to legacy paths, which abandons their corpus artifacts.
- D55: Multiple digest-suffix matches resolve to the lexicographically first directory with an ambiguity report, and directory creation is atomic. Rejected: an unspecified tie-break and non-atomic creation, which allow divergent selection or duplicate directories.
- D56: Pi-starting harnesses fingerprint the real default corpus root before and after the run and ignore expected writes inside the scratch corpus. Rejected: fingerprinting scratch corpus contents, which would false-alarm on legitimate artifacts.
- D57: D23 is narrowed by D43 and D44. Restore recovers an identity only when its minting session matches or pending adoption matches. D23 otherwise stands. Rejected: unconditional restore inheritance, which recreates fork collisions.
- D58: The frozen round 1 verdict remains unchanged, but its true tally is 7 reversals covering 10 findings, 1 strengthened and 2 accepted risks. Rejected: editing the approved verdict line.
- D59: A trusted repository may supply the readable corpus label, and the resolved path enters doctrine. This is accepted because one-segment sanitization and existing doctrine-cell escaping bound the exposure.
- D60: Handoff from a non-persisted parent without a pi session identifier is unsupported and must report the case. Rejected: silent loss or an unkeyed shared pending file.

## Planned changes (continued)

### Adversarial round 2 triage and design revision

REVERSALS.

R8. Finding AR1, blocker. Outcome: reversed. The rule that a snapshot minted by a different pi session causes a fresh mint breaks handoff itself, because an adopted snapshot still carries the predecessor's minting session. The first ordinary resume after a handoff would then read the identity as foreign and orphan every corpus artifact. Revised design: on handoff adoption the successor re-stamps the minting session to its own pi session. Adoption is therefore the one place where the stamp changes.

R9. Finding AR7, should-fix. Outcome: reversed. The revision never named which session handle is compared. The only precedent compares non-canonicalized session file paths, so a resume through a symlinked or differently spelled path would be misread as a fork. Revised design: the comparison uses the pi session IDENTIFIER, never a file path.

R10. Finding AR3, blocker. Outcome: reversed. The claim that the orchestrator writes the session metadata file and the delivery archive with ordinary file tools is false for this codebase. The orchestrator tool set is read-only, and the doctrine forbids direct edits. Revised design has three parts. Slate code writes the session metadata file at session start, because code already owns every other corpus write. The delivery-time research-log archive is performed by a dispatched worker action, which does have write access. The branch label is written by that same dispatched action, when the orchestrator knows the branch. The doctrine still exposes the resolved session directory path, because a dispatched action needs the destination.

R11. Finding AR6, should-fix. Outcome: reversed. Routing a rejected identity to the legacy paths abandons corpus artifacts that the same lineage already wrote, and it contradicts the neighbouring rule that an unusable identity mints fresh and stays in the corpus. Revised design: a snapshot whose identity is present but unusable mints a fresh identity, stays in the corpus, and reports the failure. The legacy path fallback applies ONLY to a snapshot that carries no identity field at all, which is a genuinely pre-migration lineage.

R12. Finding AR4, should-fix. Outcome: reversed. The digest-suffix scan had no tie-break, and two directories can share a suffix when the label diverges. Revised design: when more than one directory matches the digest suffix, resolution picks the lexicographically first one and reports the ambiguity. Directory creation is atomic, so two concurrent session starts cannot produce two directories.

R13. Finding AR5, should-fix. Outcome: reversed. A corpus isolation assertion modelled on the ladder's file fingerprint would false-alarm, because worker transcripts, episodes and observations legitimately write into the scratch corpus throughout a run. Revised design: the assertion checks that the REAL default corpus root is unchanged across a harness run. It never inspects the scratch corpus. This mirrors the ladder's existing check on the real settings file.

STRENGTHEN.

S2. Finding AR2, should-fix. Outcome: strengthened. Decision D23 said a restart and a snapshot restore always recover the identity. Decisions D43 and D44 narrowed that. Supersession: a restore recovers the identity only when the minting session matches, or when a pending adoption matches. D23 stands otherwise.

S3. Finding AR10, suggestion. Outcome: strengthened. The round 1 verdict line miscounts. The frozen line stays as written, and this correction records the true tally: 7 reversals covering 10 findings, 1 strengthened, 2 accepted risks.

ACCEPT AS RISK.

A3. Finding AR9, suggestion. Outcome: accepted risk. The project label can originate from a repository-supplied value, and the resolved path reaches the system prompt through the doctrine. The label is sanitized to one path segment and renders through the existing doctrine cell escaping, so the exposure is bounded. Accepted with that bound stated.

A4. Finding AR8, suggestion. Outcome: accepted risk. A parent pi session that is not persisted has no identifier to key a pending handoff file. Handoff from such a session is not supported, and the case must be reported rather than silent.

Round 2 confirmations. The successor can learn its parent pi session identifier, and pending-file keying is not circular. Doctrine build order is NOT circular: identity resolves at session start, and doctrine builds later in the `before_agent_start` hook. A report channel for a session-start failure already exists. Splitting derivation into a pure function and a thin subprocess adapter is sound. Every round 1 finding is covered by a round 1 revision, and none was silently dropped.

Adversarial review round 2: 6 reversals folded, 2 strengthened, 2 accepted risks — 2026-08-18

## Decision Log (continued)

- D61: The snapshot field is the mutable CURRENT OWNER pi session, not immutable minting provenance. Slate sets it when minting and again on explicit successor adoption; a differing owner without matching pending adoption causes a fresh identity. Rejected: a second immutable provenance field, which no rule reads.
- D62: Ambiguous digest-suffix matches resolve in order by a directory containing the restoring session identity, then newest modification time, then lexicographic order, with an ambiguity report in every case. Rejected: lexicographic selection alone, which can prefer an empty directory over the artifact-bearing lineage.
- D63: The adversarial loop stops after three rounds because finding counts fell from 10 to 10 to 2, round 3 changed no architecture, and both final fixes were textual. A fourth round had low expected value and was explicitly offered to the user.
- D64: The issue #200 amendment received pre-implementation approval from the user on 2026-08-18, after three adversarial rounds and 25 findings. Tracks 04 to 08 may start. [track owner now: 04a-04d, 08]
- D65: The probe cleanup in the release runbook is re-scoped because the threat model was wrong. Two rounds hardened a shell guard against an extension running inside the probe, and that extension is the package being released. Cleanup now removes only a path the same block created, reports a leftover loudly with its exact path, and states that in-probe subversion is out of scope. Rejected: a third hardening round, which the escalation showed was defending the wrong boundary.
- D66: Finding RG100 is removed by construction rather than by a check. Each block ignores any inherited probe variable and uses only the value it created, so a stale value can never reach a delete. Rejected: a stronger template match, which is what produced RG100.
- D67: The snapshot gains optional fields `slateSessionId` and `ownerPiSessionId`. Rejected: a bare `sessionId`, which reads ambiguously beside pi's own session identifier.
- D68: The identity grammar is a compact sortable coordinated-universal-time stamp, a hyphen, then eight lowercase hexadecimal characters, matching `^\d{8}T\d{6}Z-[0-9a-f]{8}$`. It is lexicographically sortable and safe as one path segment. The suffix uses Node's built-in crypto random-bytes function, so no dependency is added. Rejected: a universally unique identifier, which is not sortable, and a bare timestamp, which collides for sessions started in one second.
- D69: A snapshot with an identity but no owner field, or a malformed owner field, is foreign. It mints a fresh identity and reports because ownership cannot be proven, while fail-safe minting avoids silently adopting another lineage. Rejected: trusting an ownerless identity, which reintroduces the forked-lineage collision prevented by D85 and D120.
- D70: An absent snapshot means a fresh session, while a present snapshot without an identity means a legacy lineage on legacy paths under D24. The object-presence distinction is reliable. Rejected: treating both cases as fresh, which strands artifacts already recorded by a legacy lineage.
- D71: Identity resolution runs in its own session-start handler registered after the pending-handoff adoption handler. Earlier resolution would report a foreign owner before valid adoption, and snapshot-restore resolution runs too early. Rejected: resolving inside snapshot restore.
- D72: Adoption re-stamps the owner through a pure field assignment on the adopted snapshot, with no separate input or output operation. The assignment cannot throw, so the handoff module's broad catch cannot hide a new failure, and SG11 remains out of scope. Rejected: a separate post-adoption re-stamp step, which would add a swallowed failure.
- D73: The owner field accepts a pi session identifier matching pi's own validity pattern, taken from pi's `assertValidSessionId`. No approved decision specified an owner grammar, and the implementation needed one. Mirroring pi's own rule keeps slate from rejecting an identifier that pi itself considers valid. Rejected: accepting any non-empty string, which would let a value containing a path separator reach a later path-building track, and inventing a stricter grammar, which would reject a legitimate pi session.

Track 04 code review produced three blockers. These decisions change earlier decisions, and the Decision Log records post-implementation decisions for exactly this reason.

- D74: The owner field becomes `ownerSessionDigest`, a hexadecimal digest of the live pi session identifier joined to the resolved session file path. This supersedes D67's field name and D73's owner grammar. The live identifier was stamped without validation, pi does not validate a hand-edited session header, and `../../escape` reached a persisted snapshot. The mirrored grammar was unbounded, so a million-character owner could enter every later snapshot. An explicit duplicate-identifier fork defeated owner separation because both sessions carried one identifier. A digest cannot escape a path segment, cannot be unbounded, and differs between a fork and its source. Rejected: validating only the live identifier, which fixes escape but not fork separation, and a length cap, which fixes neither.
- D75: The cost of D74 is accepted. Moving a session file changes the digest, so its lineage looks foreign and the next session mints a fresh identity. This is fail-safe and is recorded in a code comment. Rejected: preserving the old digest across a changed session-file path, which would weaken the ownership proof.
- D76: Pending-handoff adoption uses an atomic claim. The successor atomically renames the pending file before reading it, so exactly one successor wins and a loser proceeds as an ordinary session. The race predates this change, and owner re-stamping worsened it because the former foreign-owner rule separated two successors. Rejected: a lock file, which adds state that can remain behind, and widening the broad catch owned by SG11.
- D77: The identity random suffix widens to sixteen lowercase hexadecimal characters from eight random bytes. This supersedes D68's suffix width. Four bytes gave a birthday bound of about 1.15 in a million across one hundred same-second starts, while the larger suffix costs only a few characters. Rejected: retaining eight characters, which leaves the measured collision risk.
- D78: A minted identity is persisted before it is committed to memory. If saving fails, the session runs without an identity on legacy paths and reports. An identity that never reached disk must not be used, because artifacts written under it become unreachable. Rejected: committing to memory first, which leaves memory ahead of disk and mints a second identity on the next reload.
- D79: The pending-handoff claim stops renaming the pending file. The claim becomes exclusive creation of a separate marker beside it, and the pending file never moves. This supersedes D76. Two blockers forced the reversal: a stale claim renamed back could overwrite a newer pending file, and termination after rename could strand the claim under a name nothing looks for. Renaming moves durable data, so every failure path can lose it. A marker leaves durable data untouched, so the worst outcome is a leftover marker. Rejected: a recovery scan for stranded claim files, which adds a second repair mechanism.
- D80: The orchestrator's instruction forbidding a lock file caused D76 and both blockers. It is recorded because the failure was a directive, not an implementation error. A constraint that forces durable data to move is wrong whatever else it buys.
- D81: An abandoned marker is recovered by age. When its age exceeds the threshold already used for a stale pending file, it is treated as abandoned, removed, and the claim is retried once. Reusing the existing convention avoids a second ageing rule. A marker that ages out too early returns to the pre-existing race, which is no worse than before this track.

Round 4 outcome. Four review rounds produced defects in the pending-handoff claim mechanism, with RG3, RG5 and RG6 still open at HEAD `ade5951`. The user-approved design deletes the shared claim resource and replaces it with per-session artifact namespacing plus non-destructive adoption, rather than adding another repair to a mechanism whose protected resource causes the defects.

- D82: Direction, user approved. Replace exclusive claiming of the pending handoff with per-session artifact namespacing plus non-destructive adoption. This closes the claim lineage D22, D29, D36, D41, D43, D51, D52, D60, D71, D72, D76, D79, D80 and D81 as a mechanism. Reason: four review rounds produced defects in claim code, with RG3, RG5 and RG6 open at HEAD `ade5951`, and namespacing removes the shared resource that the claim protected.
- D83: Every session mints its own identity, keeping D77's grammar, and additionally mints a readable session name in the style Docker gives a container. The name is unique inside one project directory. Mint it by exclusive `mkdir` of the session directory, retrying with a new name on collision. A name is an addressing handle, not a description.
- D84: D29 is amended. The session path segment becomes `<identity>-<name>`. Categories remain `episodes`, `observations` and `threads`. The identity remains in the segment because it is unique across projects and its timestamp prefix orders directories chronologically, while the name supports human addressing.
- D85: Identity never crosses sessions. A successor mints its own identity and name, and records the predecessor identity and name as its parent, forming a readable lineage chain. This supersedes the identity-inheritance clauses of D22, D23, D43, D51 and D52.
- D86: D41 and R1 are amended. The handoff record lives at `<project>/pending/<name>.json`, where `name` is the author session name, not the parent pi session identifier. Its content carries the author identity, author name, author session directory path, worktree path, branch label, parent chain and snapshot. A second handoff from one session atomically overwrites its own record, so a refresh supersedes rather than accumulates. D27 and D40 make all worktrees of one clone share one project directory, so one pending directory collects records from several concurrent changes, and an identifier-keyed filename gives a human nothing to select with.
- D87: Adoption is explicit and always requires a name. `/slate handoff <name>` adopts. With no argument in a session that has no live threads, slate refuses, adopts nothing and lists candidate records with name, branch, worktree and creation time. The `session_start` hook no longer adopts automatically, which deletes the startup race class. `/slate handoff` with no argument in a session that has live threads still writes a handoff record because that session already knows its own name.
- D88: Adoption is non-destructive. An adopter never renames, moves or deletes the handoff record. Housekeeping deletes records past the age window. A crash during adoption therefore loses nothing, and the age window is no longer a correctness gate.
- D89: Inherited episode and observation files remain in the predecessor session directory and are read in place because they are immutable evidence. Every new artifact goes into the successor session directory. Two successors of one parent may both mint episode id `t35.e2` without collision because their directories differ.
- D90: A successor forks an inherited worker transcript on first use. It calls the pi SDK `SessionManager.forkFrom` to copy the transcript into its own `threads` directory at the first continuation of that thread, then rewrites `ThreadRecord.sessionFile`. The `threads.ts` guard that assigns `sessionFile` only when empty must also fire for a rewritten path. Copy on first use bounds the cost to threads actually continued.
- D91: Path containment widens from the current working directory to the corpus project directory. `resolveEpisodeFile` currently builds its expected root from `ctx.cwd`, while `ThreadRecord.sessionFile` has an existence check without containment. This asymmetry closes as part of this work.
- D92: The session name is published to the status line through the pi SDK `ExtensionUIContext.setStatus`.
- D93: A listing command reports sessions in the project directory and pending records, each with name, identity, branch, worktree and creation time. Human selection depends on this listing because a name carries no description.
- D94: Track re-cut, user approved. Track 04 absorbs per-session namespacing and non-destructive adoption and deletes the claim code. Tracks 06 and 07 reduce to relocating an already correct tree into the corpus. [track owner now: 04a-04c]
- D95: RG3, RG5 and RG6 close by deletion of the mechanism that contains them, not by repair. The D80 instruction about lock files is now moot because the design has no lock.
- D96: Track 04 implements per-session namespacing at the existing in-project paths, under `.pi/slate/<category>/<identity>-<name>/`, and not in the corpus. Corpus relocation stays in tracks 05 to 07 because `resolveEpisodeFile` already requires only a strict descendant of the episodes root, so a session subdirectory passes the current validator unchanged, while D105 and D126 govern containment; the handoff record likewise stays at `.pi/slate/pending/<name>.json` until track 06 moves it. [track owner now: 04a]
- D97: Track 04 splits into four ordered sub-tracks, and the letters give the execution order. Track 04a mints the session name with its grammar, sanitizer and collision retry, adds the `<identity>-<name>` segment to in-project category directories, and publishes the name to the status line. Track 04b forks an inherited worker transcript on first use through `SessionManager.forkFrom` and rewrites `ThreadRecord.sessionFile`; track 04c deletes the claim mechanism and makes adoption explicit, non-destructive and name-addressed, including refusal with a candidate listing; track 04d exposes a session listing command. The fork must land before claim deletion because deleting exclusivity permits two successors and the transcript is the last shared write.

## Machine state — track 04 git forensics

- Branch `dogfood-sources` tracks `origin/dogfood-sources`, is three commits ahead and zero behind, and none of the three track 04 commits exists on any remote. The remote tip remains the track 03 marker `10c235a`.
- Commit `3b20b20` is identity-only, with 150 production and 266 test changed lines, and stays.
- Commit `8f6ad8d` mixes identity and claim inside `extension/handoff.ts`, with 137 identity and 57 claim production lines, so it is not reverted as a whole. Its `extension/state.ts` and `extension/index.ts` changes are identity-only and stay.
- Commit `ade5951` is claim-only, with 91 production and 224 test changed lines, and a plain git revert applies cleanly.
- Track 04c deletes claim code from both commits by editing forward rather than reverting history.
- Five tests in `test/session-identity.test.ts` serve only the claim mechanism and are deleted by track 04c, together with the whole fixture `test/fixtures/handoff-process-child.ts`. Eight tests are identity-only and stay. One test spans identity and adoption and needs rewriting.

### Round 5 design amendment

Three parallel pre-implementation reviews filed fifteen blockers against D82 to D97. The user approved four corrective decisions, and the direction is unchanged while the specification is completed.

- D98: Command split, user approved. D87 is amended: `/slate handoff [focus]` keeps its current meaning and writes a handoff record only, while the new `/slate adopt <name>` performs adoption. The `session_start` hook never adopts, so one argument slot carries one meaning and free focus text cannot be read as a session name. [closes: WI31, CN42, SE36]
- D99: Session directory, user approved. D84 and D96 are amended: the path segment is the name alone, and the identity moves into metadata. The layout is `.pi/slate/sessions/<name>/<category>/` with categories `episodes`, `observations` and `threads`, giving exactly one session directory per session and mirroring D29 so track 06 becomes pure relocation. Exclusive `mkdir` of `.pi/slate/sessions/<name>` is the uniqueness primitive, with at most eight retries; the artifact containment root is `.pi/slate/sessions`, and every artifact path must realpath-resolve to a strict descendant. [closes: CN34, SE30, WI32, CN35] [track owner now: 04a]
- D100: One canonical name grammar and one validator. A name is ASCII only, 1 to 48 bytes, matching `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, with a trailing four-character lowercase hex group supplying entropy, for example `calm-otter-7f3a`. Reject dots, separators, whitespace, leading hyphens and Windows reserved names, with no Unicode normalization or trimming; use this validator at mint, command argument, filename and display. [closes: SE30, SE31]
- D101: The name is persisted, and the session directory carries its own metadata. The name is a first-class snapshot field written before first use, following D78; minting also writes `session.json` inside the session directory with identity, name, creation time, worktree path and branch label. That file is durable immediately, while the snapshot custom entry is buffered until the first assistant message, so restart recovers the name by matching its identity there rather than minting again. An orphan directory from an aborted session is identifiable and prunable because it carries metadata and no snapshot referenced it. [closes: CN33, CN47]
- D102: Identity never crosses, enforced in code. D85 is amended: `adoptSnapshot` must not import `slateSessionId` or the owner session digest. The adopting session keeps its own identity, name and owner digest, while predecessor identity and name become parent fields; without this, a successor writes into the live predecessor namespace. [closes: CN32]
- D103: Adoption is additive and never destructive. The clear-and-overwrite behavior of `adoptSnapshot` must not be reachable from `/slate adopt`; adoption refuses when the current session already holds any thread or episode and reports that refusal. The earlier deleted guard is restored as an explicit command precondition. [closes: CN31]
- D104: The adoption trust gate is preserved, and D82 is corrected. Listing D36 among closed decisions in D82 was an error: D36 stays in force. The trust gate runs first, before parsing the record or following any path from it, and fails closed; an untrusted project never adopts. [closes: SE33]
- D105: Path containment moves from track 06 into track 04, user approved. D91 is amended: every path from a record is realpath-resolved and must be a strict descendant of the containment root, with symlink rejection using the pattern already present in `slate-files.ts`. An author session directory field is never authoritative; derive that directory from the validated name instead. `ThreadRecord.sessionFile` gains the episode file containment check, closing the earlier asymmetry. [closes: SE31, SE32, CN45]
- D106: Housekeeping never deletes, user approved. D88 is amended: a handoff record is replaced only by its own author, atomically, and a user prunes deliberately through an explicit command. No age-based cross-session deletion exists; age is advisory, so `/slate adopt <name>` reports an old record and still adopts it. No age threshold is load-bearing for correctness. [closes: CN36, SE34]
- D107: Fork durability contract and persistence ordering. A fork writes into a staging location inside the successor `threads` directory, verifies the result against the source entry count, then renames it into place. Failure removes the staging file and aborts that continuation with a report, never falling back to the inherited path. The rewritten `ThreadRecord.sessionFile` persists before any worker append, and the existing empty-only assignment guard also fires for a rewritten path. [closes: CN37, CN38, CN39, SE35, WI36]
- D108: The artifact reference grammar gains a session segment. The canonical reference form in `artifact-names.ts` and exact-match observation validation in `state.ts` accept a session segment, so inherited observation references remain valid and evidence links survive. [closes: CN41]
- D109: Legacy flat artifacts stay readable, and track 04 moves no file. Existing artifacts under flat `.pi/slate/<category>/` remain resolvable through an explicit legacy path rule, and that legacy root is contained exactly like the new root. Every new write uses the session namespace, completing D125's legacy distinction, which review found unreferenced by D82 to D97. [closes: WI34]
- D110: Reporting is never silent. Dropped threads and episodes are reported through a channel that works without a user interface, not only through a notify that a headless run discards. [closes: CN44]
- D111: A mode transition always uses the single mode entry point. Command-driven adoption calls the same entry that seeds tool restrictions, doctrine and the writing reminder; setting the orchestrator flag directly would leave tactical tools active while doctrine forbids direct edits. [closes: CN40]
- D112: D82's harmlessness claim is scoped to slate's own artifacts. The global model-defaults file remains shared, and two adoptions can still race it; this pre-existing race is governed by `model-default.ts` and is a known limitation outside track 04. [closes: CN46]
- D113: Verification nets are re-cut with the behavior change. Ladder rungs that seed automatic adoption or assert record consumption must drive `/slate adopt <name>` and assert non-consumption, because they cover the handoff switch site of global model default; the resolver check touching the mechanism is updated in the same track. No net is deleted without a replacement covering the same switch site. [closes: CN43]
- D114: Shipped text is corrected in the behavior-changing track. Strings and documents promising automatic restoration, or an optional focus argument with changed meaning, are updated in track 04c, including kickoff and pause strings in `handoff.ts`, widget and doctrine text in `mode.ts`, strings in `threads.ts`, `docs/model-failover.md`, `docs/writing-guidance.md` and `README.md`. Handoff output prints the exact successor command because a user cannot adopt without the name. [closes: CN42, SE36, WI30]
- D115: Sub-track re-cut, superseding D97. Track 04a delivers the grammar, validator, name mint, exclusive directory creation, `session.json`, persisted name, `.pi/slate/sessions/<name>/<category>/`, containment root, reference grammar, legacy path rule and status line. Track 04b delivers first-use transcript forking with durability and persistence ordering. Track 04c delivers the command split, `/slate adopt <name>`, additive adoption, identity separation, trust ordering, inherited-path containment, refusal, candidate listing, shipped text corrections and verification re-cut, and deletes claim; track 04d delivers `/slate sessions`. Each track writes the new namespace and reads the legacy one, so each is safe to land alone. [closes: WI35]
- D116: Refusal and candidate specification. `/slate adopt` never adopts on ambiguity, and every case reports what happened and what the user can do. The ten cases are zero candidates, exactly one candidate, several candidates, advisory-old record, missing author session directory, malformed record, unknown name, untrusted project, future creation time and record modified during read. [closes: WI33]
- D117: The successor flow is explicit from end to end, which closes the trigger gap the review found. The kickoff message is delivered by `/slate adopt <name>` on SUCCESS only, and the `session_start` hook sends nothing and claims nothing. A fresh session that adopts nothing therefore receives no text asserting restored state, and the only path that produces a kickoff is a completed adoption. The handoff output of the outgoing session is the sole place that tells a user the name to type, which makes that text load-bearing per D114. [closes: CN30]
- D118: The verification re-cut is now concrete, amending D113 with measured facts. The affected ladder rungs are R4a at `run-ladder.sh:887-900`, R4b at `902-914`, R5a, R5b and R5c at `916-968`, G4b at `1083-1104`, P8 at `1209-1241` and P9a at `1243-1255`, and all reach adoption through shared helpers `seed_pending` and `runadopt` at `786-812`, which drive automatic adoption with a plain prompt. Seven rungs FAIL after the change, while P9a becomes vacuously PASS and needs an explicit non-vacuity guard at `1251-1254`; a rung passing for the wrong reason is the failure the ladder exists to catch. The resolver check `writing-reminder-handoff-order` at `resolver-checks.mjs:982-1052` drives real `session_start` handlers and asserts adopt-before-force ordering, so it must invoke the explicit command instead, with identifier changes updating the EXPECTED roster at `7184-7231` and VOIDABLE list at `439-449`; in `test/`, the five adoption tests and entry-point wiring test in `session-identity.test.ts`, harness at `239-260` and fixture `test/fixtures/handoff-process-child.ts:20-56` must capture the explicit command handler and assert non-consumption. The nets needing no edit are `run-load-check.sh`, `package-content-check.mjs` and `run-writing-reminder-check.sh`, because none asserts the registered command set beyond the top-level `slate` name. [closes: CN43]
- D119: The name vocabulary is self-authored, and no external list is copied. Docker's names-generator word list is Apache License 2.0, copyright Docker, Inc., and this repository could comply mechanically because it carries the same license, but it will NOT copy that list: the noun list is largely personal names of real people, which conflicts with the no-proper-nouns requirement, and the upstream project froze the list after unresolved disagreement. No npm word-list package is acceptable either, because `package.json` declares only pi SDK peer dependencies and this repository ships no runtime dependency of its own. The design therefore ships an original list of 32 adjectives and 32 nouns, giving 1,024 combinations, and the four-character hex group of D100 raises the space to 67,108,864 names with a maximum generated length of 20 bytes, well inside the 48-byte grammar limit. The word indices and the hex group are derived from the existing random draw in `mintSlateSessionId` at `extension/state.ts:253-255`, using bits disjoint from those the identity consumes, so no second random source is introduced. A bounded retry of at most eight exclusive `mkdir` attempts is sufficient: with 10,000 existing names, the chance that all eight attempts collide is about 2.4 times 10 to the power of minus 31. Recorded limits: about 1,161 sessions in one project reaches a one percent chance of any collision across project history, and the scheme becomes uncomfortable above roughly 1,000 sessions per project. Recorded caveat: no native-speaker multilingual review of the word list was performed and trademark exposure for individual nouns was not exhaustively cleared, so the list must get that review before it is frozen. [closes: nothing, this decision answers an implementation question raised by D100]

A finding identifier appearing in two closes brackets is intentional joint closure by two decisions, and it is not a bookkeeping error. Known cases are CN42, CN43, SE30, SE31 and SE36.

### Round 6 design amendment

The gate verified 26 of 33 findings, left six open, filed one regression as RG200, and named three decisions unimplementable as written. This round closes all of those.

- D120: The identity-import ban of D102 is scoped to foreign adoption only, which fixes regression RG200. `adoptSnapshot` is shared by ordinary restore and cross-session adoption, so a literal ban would break resume identity recovery and orphan every resumed lineage's artifacts. The foreign adoption path must not import `slateSessionId` or the owner session digest and writes predecessor identity and name only into parent fields, while ordinary restore keeps current identity recovery unchanged; two named entry points or one parameter are permitted, provided shared record sanitizing is not duplicated, and a test covers resume identity recovery. [closes: RG200, CN32]
- D121: Fork durability closes the crash window D107 left open. Because pi performs no fsync and silently reinitializes a zero-length file, the staged copy's entry count must equal the source's before rename, the staged file and directory receive best-effort fsync where available, the thread record retains a `forkedFrom` field naming the validated source, and the successor re-verifies entry count before its first append. An empty or short copy is discarded and re-forked from the retained source, so silent reinitialization is unreachable. [closes: CN37]
- D122: Slate keeps its own name and records pi's durable session name rather than reusing it. Reusing pi's name would provide D101's persistence but would make a path segment and addressing key depend on an SDK-owned format, while slate must own D100's grammar and D99's uniqueness domain. The status line labels slate's name explicitly as slate followed by the name, and `session.json` records pi's name as a cross-reference. [closes: CN48]
- D123: The handoff record is validated against an explicit schema before any field is used, with D104's trust gate first. The schema names required fields and types, defines unknown-field policy, and bounds record size, thread count, episode count, each string field and nesting depth. Any violation is refused with a report and never partially applied. [closes: SE32]
- D124: Fork bounds and failure policy complete D107. A source transcript has a maximum size, and an oversized source refuses and reports rather than copying unbounded bytes. A missing source aborts with a report and never falls back, a failed attempt removes only its exact staging file, leaves the source usable, and does not retry automatically beyond the single re-fork triggered by failed entry-count verification. The rewritten path is never persisted before verification succeeds. [closes: SE35, WI36]
- D125: The legacy rule reconciles the gate contradiction. D33 already makes the legacy flat layout a read-only restore fallback, while D24 and D70 describe a legacy lineage without stating write policy and are therefore silent rather than contradicted. A legacy lineage reads existing artifacts from flat `.pi/slate/<category>/` paths and writes every new artifact into a session namespace, minting its name and session directory at first write. Track 04 moves no file. [closes: WI34]
- D126: D105 is amended by separating path classes because its literal every-path wording could not hold. A followed path is an episode file, observation reference, thread session file or author session directory, and must be realpath-resolved, strictly descendant of the corpus project directory, formed by joining the corpus root and project directory, or of the D125 legacy flat in-project root, with symlinks rejected. A display-only worktree path or branch label is never followed, opened or used to build a path, and is compared only as an opaque string and shown to a user. [closes: nothing new, this decision makes D105 implementable] [corrected in round 10: the corpus project directory replaces the superseded D99 in-project containment root.]
- D127: D119 is amended with a workable bit allocation because the existing random draw has no spare bits. One draw uses twelve random bytes: bytes zero through seven supply the identity's sixteen hex characters, bytes eight and nine supply the two word indices, and bytes ten and eleven supply the name's four hex characters. One random source remains, and the ranges are disjoint by construction. [closes: nothing new, this decision makes D119 implementable]
- D128: D118 is amended by naming the missing ladder discriminator. The rung must observe an explicit positive success marker printed by the adopt command and fails when that marker is absent. Silence is never a pass. [closes: nothing new, this decision makes D118 trustworthy]
- D129: D118's citations are corrected and reconciled with the Machine state section. The VOIDABLE table is at `verification/resolver-checks.mjs:456-479`, `439-449` holds `BASE_IDS`, and the writing prefix does not appear in VOIDABLE; the test inventory also omits `test/session-identity.test.ts:120` and `:191`. Three CLAIM-protocol tests are deleted with `test/fixtures/handoff-process-child.ts`: successful adoption removing pending handoff and claim marker, exclusive marker allowing one operating-system process to adopt, and terminated claimant leaving pending data adoptable after marker ageing; the two pending-content preservation tests become non-consumption assertions, and entry-point wiring drives the explicit command. [closes: nothing new, this decision corrects D118]
- D130: The prune command required by D106 belongs to track 04d beside D93's listing command, so no sub-track holds an unassigned deliverable. Unbounded record growth remains out of scope under the lifecycle ruling that automatic pruning becomes its own issue. [closes: nothing new, this decision assigns an owner]

### Round 7 design amendment

The focused gate verified all seven remaining findings, filed one new should-fix as RG210, and named four residuals. This round closes RG210 and all four residuals.

- D131: D127 is amended. One random source does not mean one random draw. The identity mint draws twelve bytes, with bytes zero through seven supplying the identity suffix unchanged and bytes eight through eleven supplying the first name candidate. Each subsequent exclusive-`mkdir` retry under D119 draws four fresh bytes for a new candidate, because reusing the same bytes would repeat the collision forever. A lineage that mints its name later than its identity, as D125 requires for a legacy lineage minting at first write, draws its own four bytes then. One helper owns every draw, preserving one random source and one code path. [closes: RG210]
- D132: D121 is amended with the required ordering. Entry-count re-verification runs before SDK session open, not merely before the first append, because the loader reinitializes a zero-length file and throws on an unparseable one inside open. A short, empty or unparseable copy is discarded and re-forked from the retained `forkedFrom` source, so open never receives a damaged copy. [closes: CN37 residual on ordering]
- D133: Bounds complete D123 and D124 with actual values. A handoff record is at most 1 MiB and is size-checked before parsing; it carries at most 512 threads, 4096 episodes, 8192 bytes per string field and nesting depth at most 8. A worker transcript above 64 MiB refuses to fork and reports instead of copying. The author session directory is derived as the exact expected path from the validated name, so containment alone is insufficient. Every display-only field from D126 passes through the existing control-character sanitizer at `extension/notify.ts:18-24` before display. Each bound needs a boundary test. [closes: SE32 residuals]
- D134: A fork failure report names the thread, retained source path and reason, so a user can act and a later session can recover. A report that only says a fork failed leaves the retained source undiscoverable in practice. [closes: SE35 and WI36 residual on report content]
- D135: A legacy flat worker transcript is forked into the session namespace before its next append, exactly like any inherited transcript. No append lands in the legacy flat layout, making D125 and D33's read-only rule true in practice rather than intent. [closes: WI34 residual on legacy transcript appends]

### Round 8 amendment, corpus location corrected

The user challenged the in-project location. D96 was wrong, and its justification had already collapsed.

- D136: D96 is reversed, user approved. Track 04 writes session artifacts directly into the corpus at D140, D28 and D29's approved layout: `<corpus root>/<project>/<session>/<category>/`, with the corpus root a child of the pi agent directory and the project keyed by the git common directory. D96 justified an in-project intermediate step because the existing episode containment check accepted a strict descendant of the flat episodes root, so no validator change was needed. That justification collapsed twice: D99 moved the layout to a sessions segment outside the episodes root, and D105 pulled path containment into track 04. The intermediate step buys nothing and would create a second legacy layout requiring a permanent read rule or live-data migration. The only legacy layout is the current flat in-project one, governed by D125 and D135. [closes: nothing, this decision corrects D96] [corrected in round 10: D140 governs a child corpus root, not D25's superseded sibling wording.]
- D137: Track re-cut, superseding D115 and D97, user approved. Tracks 05, 06 and 07 are dissolved and their numbers are retired because they existed to relocate artifacts that track 04 now writes correctly first time. Track 04a delivers corpus-root resolution, project derivation and sanitizer, D34's loud unwritable-root refusal, name grammar and mint, corpus session directory, `session.json`, persisted name, containment roots, session-segment reference grammar, legacy read rule and status line, absorbing former track 05. Track 04b delivers first-use transcript fork into the corpus with durability and persistence ordering, absorbing former track 07 and requiring the full verification ladder. Track 04c delivers the corpus handoff record, command split, explicit adoption, trust ordering, refusal and candidate listing, shipped text corrections and verification re-cut, and deletes claim; track 04d delivers listing and prune commands. Former track 08 keeps number 08 and keeps contributor guidance, doctrine, research-log rules and delivery archive. [closes: nothing, this decision re-cuts the plan] [corrected in round 10: dissolved track numbers 05-07 are retired and track 08 retains its former number and scope.]
- D138: The corpus root must derive from the pi agent directory, never directly from home. This is a verification-safety requirement: every harness and the node:test suite must write into its own scratch directory so tests never write into real pi state. The corpus root is created recursively on demand, so absence is the normal first-run state and never an error; D34's loud refusal applies only when creation fails or the root is not writable. The implementation must confirm the exact pi SDK accessor for that directory before writing any path builder. [closes: nothing, this decision states a safety requirement] [corrected in round 10: absent roots are created on demand; refusal is for creation or writability failure.]
- D139: The telemetry boundary is restated because the question was asked directly. The corpus provides storage and retention only, exactly as issue #200's goal states, and grants no telemetry collection, reading or transmission and changes no artifact format. A durable corpus makes later analysis possible but does not authorize analysis now; any collection is a separate issue requiring its own design and consent decision. [closes: nothing, this decision restates a scope boundary]

### Round 9 amendment, verification safety of the corpus root

A citation-backed safety analysis found that the unit test wrapper isolates neither the agent directory nor the home directory, that the ladder safety check watches only the settings file, and that D25's sibling wording can place the corpus outside a harness scratch directory.

- D140: D25 is amended. The corpus root is a child of the pi agent directory, at `<agent directory>/ytdb-slate/projects`, not its sibling. The pi SDK exports standalone `getAgentDir`, declared at `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:2` and `dist/core/config.d.ts:75-76`, and resolves nonempty `PI_CODING_AGENT_DIR` or falls back to the pi directory under home at `dist/core/config.js:393-418`. A sibling requires upward traversal, so a bare scratch `PI_CODING_AGENT_DIR` would place the corpus above scratch and share mutable state across runs; a child follows the variable exactly and isolates by construction. The implementer must confirm that pi never prunes or manages unknown content inside that directory. [closes: nothing, this decision corrects D25 on safety grounds]
- D141: `verification/run-tests.sh` must export a scratch `PI_CODING_AGENT_DIR`, created and removed by the wrapper, in the same commit as the first corpus path builder. Today it isolates neither `PI_CODING_AGENT_DIR` nor `HOME` at lines 54-82, while only `test/cache-key-shards.test.ts` overrides the agent directory at lines 27-41; without the wrapper change, artifact-writing tests including `test/slate-files.test.ts`, `test/observations.test.ts` and `test/dispatch-choice.test.ts` target real pi state. The scratch pattern already exists in `verification/run-writing-reminder-check.sh:74-81,108-112`, which sets both values. [closes: nothing, this decision closes a verification safety gap]
- D142: The ladder SAFE check widens to fingerprint the real corpus root alongside the real settings file. It currently fingerprints only the settings file at `verification/run-ladder.sh:151-170,246-259,1420-1449`, so corpus writes would not trip SAFE; the widened check covers existence and content because the first defect could create the directory rather than modify a file. [closes: nothing, this decision closes a verification safety gap] [track owner now: 04a]
- D143: The corpus root is created on demand and refuses loudly on failure. `getAgentDir` returns only a path, with no existence or writability check and no creation, while an in-memory session may have no persisted directory when a hook runs; creation is therefore recursive when needed, and failure raises the existing `SlateWriteRefused` idiom at `extension/slate-files.ts:52-57` without silent fallback, satisfying D34 and D138. No writable-directory probe helper exists and one must be written. [closes: nothing, this decision states the creation and refusal rule]
- D144: Accepted limitation, user approved. Finding SE41 stays open as a documented limitation rather than a fixed defect. The worker session open hands a pathname to the pi SDK, which resolves and reopens that path itself, so slate's descriptor-held containment cannot cover the final open. The pi SDK offers no open-by-descriptor entry point, so no code in this repository can close the window. The residual race requires an attacker who can already write inside a directory that slate creates with owner-only permissions, under the same user account, and who wins a race against a single open. The limitation is stated in the delivery record for this change, and an upstream request for an open-by-descriptor entry point is filed as its own issue; this decision does not depend on that request being accepted. [closes: SE41 as an accepted limitation, not as a fix]

The review rule normally forbids lowering a blocker without user confirmation. The user gave that confirmation for SE41, and the gate verdict of STILL OPEN stands unchanged in the record.

### Round 10 amendment, harness isolation

A user question about live pi sessions exposed a false-alarm defect in the ladder safety check. A static audit confirmed that corpus creation is eager.

- D145: Eager session-directory creation is confirmed, user approved, and D99 and D101 stand unchanged. Exclusive `mkdir` on the name segment is the uniqueness primitive, so deferring creation to first artifact write would defer uniqueness after the name is displayed in the status line and used for addressing. A name that changes after display is worse than an orphan directory, and an orphan directory is prunable from its metadata. Starting a session writes real state, so every harness that starts pi must redirect the agent directory. [closes: the eager or lazy question raised in round 10]
- D146: The ladder corpus safety check becomes a positive assertion about its own children, replacing negative observation of real state, and supersedes D142. Real-corpus observation cannot attribute a change to one process, and eager creation means an ordinary session during a run legitimately changes real corpus state, causing a non-dispositionable failure. Each child pi must create its session directory inside the scratch corpus, and an absent scratch corpus after a child runs fails because redirection failed. The agent-marker branch is deleted because shared-parent modification time has no attribution and three attempts produced three defects. Real-corpus comparison becomes a note naming concurrent activity as likely and pointing to scratch assertions as authoritative. The real settings check is unchanged. A write fully undone by the same run is not detected, but it loses no data. [closes: CN53, CN66, RG220 and CQ37 by replacement rather than repair]
- D147: `verification/run-resolver-checks.sh` must redirect `PI_CODING_AGENT_DIR`. No current check reaches a corpus path builder, so no current run writes into developer home, but that protection is accidental because one new check could resolve or create a corpus directory. The harness loads real state transitively through the corpus module, so redirection removes the latent trap at one line of cost. `verification/run-packaging-checks.sh` needs no redirection because it neither loads slate modules nor starts pi. [closes: nothing, this decision closes a latent verification-safety trap]

### Round 3-4 harness hardening amendment

A gate perspective and an adversarial perspective reviewed commit `36513aa` in parallel. The gate verified CN53, CN66, RG220 and CQ37 against D146, while the reviews filed RG240, WI50, RG241, SE60, RG242, RG243, WH50, WH52 and WH51; later fix rounds produced RG250, and this amendment records the full hardening sequence.

- D148: Round 3 review of `36513aa` recorded RG240 as a blocker for stale reused-lab evidence, WI50 as a should-fix for omitted corpus exit-one documentation, RG241 as a should-fix for a missing corpus verdict, SE60 as a should-fix for an unchecked agent-directory symlink, RG242 as a should-fix for pre-child marking and one-session discharge, RG243 as a should-fix after severity validation for missing teeth, WH50 as a suggestion for lost attributable real-corpus subclass detection, WH52 as a suggestion for permission-error false failure, and WH51 as a suggestion for an uncanonicalized resolver scratch path. The gate verified CN53, CN66, RG220 and CQ37 under D146 and filed RG240 and WI50; the adversarial review filed the remaining six. [closes: none, records the round 3 ledger]
- D149: The orchestrator raised RG243 from suggestion to should-fix because every load-bearing safety check needs a teeth fixture, kept WH50, WH51 and WH52 as suggestions for the user report, and retained RG240 as a blocker because review rules forbid lowering a gate-filed regression. [closes: none, records severity validation]
- D150: Track 04a fixes RG240, RG241, RG242, SE60, RG243 and WI50 in one commit under six properties: only a current-run write satisfies the assertion; the verdict never disappears and strict mode keeps NOT RUN fatal; the predicate validates its path before reading; no marker precedes its child and no count rule is adopted without proof that one marked child publishes one session directory; a no-pi teeth fixture proves the predicate; and exit-one documentation names corpus failure. [closes: RG240, RG241, RG242, SE60, RG243, WI50]
- D151: Commit `b82d1f7`, `Harden corpus isolation evidence`, implements D150 by refusing a reused scratch agent directory whose corpus already exists, clearing prior child markers, emitting corpus PASS/FAIL/NOT RUN with strict handling, asserting the agent path before reads, marking after child completion, adding filename teeth, and documenting SAFE CORPUS failure. The first property therefore initially used refusal as its mechanism. [closes: none, records b82d1f7]
- D152: The ladder ran alone at `36513aa` and `b82d1f7`, and both reported 26 pass, 0 fail, 0 not run with exit 0. The positive corpus assertion first executed at `36513aa`, and `b82d1f7` refused a prepared reused lab with exit 2. [closes: none, records ladder evidence]
- D153: The round 4 gate verified RG240, RG241, RG242, SE60 and WI50, left RG243 STILL OPEN because the fixture lacked depth mutations, and filed RG250 as a blocker because refusal rejected legitimate repeated `--lab` use documented by README. [closes: none, records b82d1f7 gate]
- D154: The refusal is replaced by clear-at-run-start under four properties: repeated use of one lab proceeds with no prior evidence satisfying the assertion; removal validates the target, rejects symlinks and stays inside the scratch directory; invalid paths still refuse; and the teeth fixture adds too-shallow and too-deep cases. The original rationale was: "A newer-than-run-start timestamp check was rejected because filesystem timestamp resolution and ordering are less deterministic than establishing an empty baseline." The corrected rationale is that a caller can forge a modification time and a clock moved backwards defeats the comparison, while an empty baseline remains deterministic. The guard validates the agent and corpus paths, canonicalizes them, checks containment, then removes only the validated corpus and clears the prior marker. [closes: RG240 and RG250 by replacement, RG243] [amended in round 11: timestamp resolution is not the discriminator; forgery and clock rollback are.]
- D155: Commit `a9feefd`, `Preserve safe ladder reuse`, implements D154 by resetting the validated corpus at run start, preserving symlink refusal, and extending the teeth fixture to wrong-name, too-shallow, too-deep and correct-depth cases. Each of the four separate predicate defeats was demonstrated to fail the fixture. [closes: RG240, RG250, RG243]
- D156: The ladder ran alone at `a9feefd` with 26 pass, 0 fail, 0 not run, exit 0 and no NOTE line. A repeat `--only R1` probe in one lab ran twice with exit 0 both times, and only the second run printed the corpus-clearing NOTE. [closes: none, records a9feefd evidence]
- D157: A gate round and adversarial review of the removal mechanism are in flight at `a9feefd`; track 04a is not signed off. [closes: none, records open gate state]

### Round 5 harness hardening amendment

The gate verified the seven round-five findings at `a9feefd`, while the adversarial review filed three should-fix findings and two suggestions. The user-approved bounded fix round addresses SE90, CN110, RG270 and the accepted WH80 and WH71 residuals.

- D158: Gate round 5 on `a9feefd` verified RG250 and RG243 and re-verified RG240, RG241, RG242, SE60 and WI50. Mutation testing showed all four teeth cases independently load-bearing, and `extension/corpus.ts` confirmed depth three as the production corpus boundary. [closes: none, records a9feefd gate evidence]
- D159: The gate filed WH70 because clearing and real-corpus NOTE lines share one tag format, and WH71 because the new removal's residual race is absent from the guard-limitations section. [closes: none, records suggestions]
- D160: The adversarial review filed SE90 for resolved-path validation followed by string-path removal without lab ownership or mode checks, CN110 for unguarded concurrent lab reuse, RG270 for stale session transcripts surviving corpus reset, WH80 for mount-boundary traversal, and WH81 for misleading corpus-refusal wording. [closes: none, records adversarial findings]
- D161: The orchestrator escalated to the user because review rules require escalation for a second regression against one finding, and the RG240 fix series produced its second regression. The user approved one bounded fix round. [closes: none, records escalation]
- D162: Track 04a fixes SE90, CN110 and RG270 in one commit under three properties: removal waits until the lab root, agent directory and every traversed element are caller-owned and not group- or world-writable, then restricts removal to one filesystem, compares devices and re-validates immediately before removal; the run holds an exclusive lab lock for its duration, and a second run or crash-left lock refuses with an actionable exit-2 message; and the session channel is cleared under the same validated guard chain as the corpus. [closes: SE90, CN110, RG270]
- D163: WH80 and WH71 close inside the SE90 remedy because mount-boundary restriction and corrected threat-model text belong there. WH50, WH51, WH52, WH70 and WH81 remain suggestions for the user report, while CQ30-CQ37, SE51, CN68, CN69 and CN70 remain deferred. [closes: WH80, WH71]
- D164: The `a9feefd` ladder evidence was 26 pass, 0 fail, 0 not run, exit 0 and no NOTE line. A repeat `--only R1` probe in one lab ran twice with exit 0, and only the second run printed the clearing NOTE. [closes: none, records a9feefd evidence]
- D165: The fix commit for SE90, CN110 and RG270 is in flight, and track 04a is not signed off. [closes: none, records open gate state]

### Round 6 harness lock-release amendment

Commit `8e0dca4`, `Harden ladder state reset`, implemented D162. The gate then verified the reset, while CN110 remained open because lock release still masked failure.

- D166: Commit `8e0dca4`, `Harden ladder state reset`, implemented D162 with caller-ownership and group/other-write checks for the lab, throwaway agent and traversed removal targets; an atomic lab-directory lock wired into cleanup and signal paths; one-filesystem removal with device comparison against the validated agent and immediate re-validation; and guarded clearing of corpus, session and child-marker channels. It added two tool requirements and a capability check for the removal option. [closes: SE90, RG270, WH80, WH71]
- D167: The ladder ran alone at `8e0dca4` with 26 pass, 0 fail, 0 not run, exit 0 and no NOTE line. A repeated lab run proceeded, cleared both channels and left no lock; a hand-made lock returned exit 2 with its path and remedy; and a world-writable agent returned exit 2 with its mode and remedy. [closes: none, records 8e0dca4 evidence]
- D168: Gate round 6 verified SE90 and RG270, confirmed WH80 and WH71 inside the SE90 remedy, re-checked RG240, RG241, RG242, RG243, RG250, SE60 and WI50 without disturbing their closing evidence, and re-ran four independently load-bearing teeth mutations. [closes: RG240, RG241, RG242, RG243, RG250, SE60, WI50]
- D169: Gate round 6 left CN110 STILL OPEN because release runs `rmdir` and discards its result, allowing a failed release to leave the lock on disk while reporting success. Injecting a file into the lock directory reproduced exit 0 with the lock retained, and README passages claiming cleanup releases the lock overstate the guarantee. [closes: none, records CN110 still open]
- D170: Track 04a fixes CN110 in one commit under three properties: failed release reports loudly, names the lock path and remedy, and cannot report success; the ordinary path preserves output, exit code and interrupt handling; and both README passages state the guarantee accurately. [closes: CN110]
- D171: This iteration cleared four findings, so no escalation trigger fired, and CN110 remains at iteration one of its three-iteration budget. [closes: none, records review-rules state]
- D172: The CN110 fix is in flight, and track 04a is not signed off. The recorded user-report suggestion set contains sixteen entries: CQ30, CQ31, CQ32, CQ34, CQ35, CQ36, CQ37, SE51, CN68, CN69, CN70, WH50, WH51, WH52, WH70 and WH81. [closes: none, records open state]

### Track 04a closeout

- D173: Commit `50e48c4`, `Surface ladder lock release failures`, implemented D170. Release now reports failure once, names the lock path and remedy, and wrappers around the exit trap and signal handler promote zero status to failure while preserving an existing nonzero status.
- D174: Gate round 7 verified CN110. It reproduced the original counterexample, then proved failed rung exit 1, refusal exit 2, clean exit 0 without extra output, strict skipped-check failure, and interrupt exit 130 with lock release. No new finding was filed.
- D175: One resolver-check failure was false, caused by a relative harness path running another worktree's older harness against these sources. That wrapper has a 213-check roster and older fixtures, while the paired harness passed three of three runs and a bisect placed the transition at the commit adding session-manager calls with its matching fixture. The extension load check's 14 checks and pure-resolver output's 223 result lines detect this mistake. Suggestion WH100 records the wrapper-path guard gap.
- D176: Verification at `50e48c4` used absolute harness paths throughout: ladder 26 pass with strict mode and exit 0, clean typecheck, packaging guards 16 pass and self-test 16 pass, load check 14 pass, resolver checks 223 result lines with roster audit, and unit tests 310 pass with line coverage 577 of 602 and branch coverage 266 of 303 against base `ade5951`; no worktree warning appeared.
- D177: The user reviewed and signed off the track 04a diff, requested the push and requested every suggestion become a tracker issue. Track 04a is delivered and signed off.
- D178: Seventeen follow-up issues exist in `JetBrains/ytdb-slate`: WH50→215, WH51→216, WH52→217, WH70→218, WH81→219, CQ30→220, WH100→221, CQ31→222, CQ32→223, CQ34→224, CQ35→225, CQ36→226, CQ37→227, SE51→228, CN68→229, CN69→230 and CN70→231. Issue bodies corrected several moved line numbers, and no suggestion remains only in a review episode.
- D179: The `dogfood-sources` push and pull request 211 update are in flight. The remote tip before push was `10c235a`, and twelve commits were unpushed because `3b20b20`, `8f6ad8d` and `ade5951` sit below the track 04a range.
- D180: Track 04b is next. It forks the transcript and requires a full verification ladder run.

OPEN QUESTIONS FOR ADVERSARIAL DESIGN REVIEW

- How is name reuse handled after archival, since track 08 archives session directories and an archived name is no longer detected by exclusive `mkdir`? — ANSWERED by D99 and D100; archival premise corrected by D137
- Can housekeeping delete a record while its author session rewrites it? — ANSWERED by D106
- What are the disk cost and failure-handling rules for `forkFrom`, including a partial copy? — ANSWERED by D121, D124, D132, D133 and D134
- What happens when a worktree is deleted or moved while its session directory still holds episode files that a successor references? — ANSWERED by D89, D110, D116, D126 and D133
- Does refusing adoption without an argument contradict any existing shipped text in `AGENTS.md`, `docs/` or the handoff command output? — ANSWERED by D98, D114, D118, D128 and D129
- Is a name unique per project sufficient, given that all worktrees of one clone share one project directory? — ANSWERED by D99, D100 and D137
- What happens when a named record exists but its author session directory is missing? — ANSWERED by D110, D116, D126 and D133

## Suggestions (continued)

- SG11: A broad catch in `extension/handoff.ts:639-640` suppresses adoption and save exceptions and can leave a half-updated snapshot. This durability gap predates the change and was not graded as a round 3 defect. It matters because failure can hide both the incomplete adoption and the failed persistence. A fix needs narrow catches, explicit reporting, and injected-failure tests proving that adoption and save errors cannot leave an unreported half-updated snapshot.
- SG12: Two sentences in `RELEASING.md` use semicolons, which the writing checker reports at fail level. The project convention's governed list does not include `RELEASING.md`, so this is advisory. A fix needs the two sentences split.

## Planned changes (continued)

### Adversarial round 3 triage and design revision

REVERSALS.

R14. Finding AT1, blocker. Outcome: reversed. The session stamp field carried two contradictory definitions. Decision D43 described it as immutable minting provenance, while decision D51 makes adoption overwrite it. Both cannot hold once a successor adopts. Revised design: the field is defined once, everywhere, as the CURRENT OWNER pi session. It is mutable. It is set when an identity is minted, and it is set again when a successor adopts. It is never described as minting provenance. The inheritance rule is unchanged in substance: a session whose recorded owner differs from its own pi session identifier, with no matching pending adoption, mints a fresh identity. Rejected: adding a second immutable provenance field, which adds state that no rule reads.

R15. Finding AT2, should-fix. Outcome: reversed. Lexicographic selection is not lineage aware, so an empty directory sharing the digest suffix can win over the directory that already holds the artifacts. Revised design, applied in order: prefer a matching directory that already contains the restoring session identity; otherwise prefer the matching directory with the most recent modification time; otherwise take the lexicographically first. Report the ambiguity in every case.

Round 3 confirmations. The corpus isolation assertion IS implementable. A redirected child cannot compute the real default root, but each harness computes the real root in the wrapper before it redirects the child. The earlier suspicion was checked in both directions and did not hold. The pi session identifier is available at snapshot restore time and is stable across an ordinary resume, so the comparison rule rests on a real fact. A dispatched worker does have write access and can reach an absolute corpus path, and session-start handlers run serially, so the metadata write cannot race ordinary delivery. Adoption is the only current cross-session path that can change the stamp. The round 1 tally correction is itself correct.

#### Loop termination

Three adversarial rounds ran. Round 1 produced 10 findings, round 2 produced 10, and round 3 produced 2. Neither round 3 finding touches the architecture, and both fixes are textual. The orchestrator judged a fourth round to have low expected value and stopped the loop, and it offered the user a fourth round explicitly.

Pre-existing durability gap. A broad catch in `extension/handoff.ts:639-640` suppresses adoption and save exceptions, which can leave a half-updated snapshot. This predates the change and round 3 did NOT grade it as a defect. SG11 records the location, impact and required fix so the gap is not lost.

Adversarial review round 3: 2 reversals folded, 0 accepted risks — 2026-08-18

### Track 03 review record

Two review perspectives ran on the track 03 cumulative diff: a non-code baseline across all four changed files, and an adversarial review of the rebuilt registry-load validation.

The review produced nine findings. Two were blockers, both in the rebuilt release step: the step could not run at all, and the step could pass while the published package was broken at run time.

The blockers were fixed and independently verified by a gate thread, which reproduced the discrimination itself against the real published package version 0.10.0 and against a deliberately broken copy.

The interactive doctrine check was replaced by a machine-checkable assertion. A fake model provider reads the assembled system prompt and asserts each required doctrine marker exactly once. A canary in the before-agent-start hook was tried first and does not work, because it runs before slate builds the doctrine.

The AGENTS.md findings were all verified, including the correction of a false claim about the migration windows.

One finding, WH52, went through two fix rounds and two STILL OPEN verdicts, and the second fix filed a new blocker, RG100. The orchestrator escalated to the user under the no-progress rule, and the user approved a re-scope.

One suggestion, WC2, is not fixed inside this change by rule, and it is reported to the user. Two sentences in the release runbook use semicolons.

Design review (pre-implementation), issue #200 amendment: user-approved — 2026-08-18

### Track 04 verification

The four track 04 nets passed: the typecheck passed, the pure-resolver checks passed in strict mode with 223 checks, the unit tests passed with 279 tests, and the extension-load check passed with 14 rungs.

The verification ladder remains outstanding for this track. It is required because `extension/handoff.ts` changed, and it must run alone.

Two pre-existing test fixtures needed a session-identifier accessor because the new session-start handler calls it unconditionally. This shows that the handler runs on every session, not only on a handoff.

### Track 04 review record

Three perspectives ran: a code baseline, a concurrency review and a security review.

The review produced eight findings, three of them blockers: an unvalidated live session identifier, a pending-handoff adoption race with no atomic claim, and a duplicate-identifier fork that defeated owner separation.

The concurrency review also CONFIRMED that pi runs session-start handlers in registration order and awaits each one, so the ordering the design depends on is real and not assumed.

Two test-quality findings showed the tests did not fail on regression. Both fixes must be proved by deliberately breaking the code and watching the test fail.

### Track 04 gate record

The gate thread independently reproduced every fix rather than accepting the diff as its own evidence. It ran two real operating-system processes to test the adoption race, crafted a hostile session header, and constructed the duplicate-identifier fork case.

Eight findings were verified: the unvalidated live identifier, the unbounded owner grammar, the adoption race, the duplicate-identifier fork, the narrow random suffix, the mint persistence ordering, and both test-quality findings.

The gate proved both deliberate-break claims itself instead of trusting the implementer.

Two new blockers were filed against the claim mechanism, which is the third defect round on that one mechanism.

The gate ruled stale pending-file preservation acceptable, because repeated stale starts left exactly one pending file and no accumulation.

### Track 04b implementation decisions

- D181: Track 04b hooks transcript preparation into `ThreadManager.openWorkerFor` before the SDK opens a worker session. A first continuation rewrites `ThreadRecord.sessionFile` to the successor copy and persists `forkedFrom` as a recovery hint. The same guarded assignment path handles initial assignment and an authorized rewrite.
- D182: A fork writes through `SessionManager.forkFrom` into a private staging directory. Slate verifies source and staged entry counts, fsyncs the staged file and directories where supported, reserves the destination, renames into place, and verifies the published inode before use.
- D183: A fork source may contain at most 64 MiB. Slate enforces the bound while reading, refuses oversized or continuously growing input, and reports rather than copying without limit.
- D184: Followed transcript paths must be strict descendants of the corpus project directory or the legacy flat thread root. Slate refuses symlinks, linked parents, non-regular files, FIFOs and multiply-linked transcript files before use. This rule does not authorize record deletion when another artifact class fails containment.
- D185: Transcript inspection follows pi loader behavior for malformed JSONL. It skips unparseable lines, while still requiring the first accepted entry to be a valid session header and comparing accepted entry counts.
- D186: A pre-prompt fork refusal throws `DispatchAbort`. The dispatch reports the thread, retained source and reason, but writes no episode and calls no compressor.
- D187: `forkedFrom` is an optional recovery hint, not a permanent dependency or preferred source. Slate continues from the thread's current transcript, drops an unusable hint without dropping the record, and never deletes a transcript while repairing or re-forking.
- D188: A containment refusal during restore must preserve the thread or episode record unless the record's own authoritative path is unusable. A shared hardlink predicate must not turn a safe refusal into silent durable record loss. RG271 remains open until code and regression tests enforce this rule.

## Surprises & Discoveries (continued)

- S19: `SessionManager` exposes its transcript path through `getSessionFile()`. Its internal `sessionFile` field is private, so track 04b cannot read that field directly.
- S20: `SessionManager.forkFrom` writes its target directly with exclusive `wx` creation and performs no fsync. Slate therefore needs its own staging, verification, rename and best-effort fsync layer.
- S21: Pi's transcript loader skips unparseable JSONL lines. Track 04b's first cut refused the whole transcript, so fix pass 1 changed Slate inspection to tolerate those lines too.

## Track 04b review ledger

Canonical observation paths below are relative to the main worktree.

- BG1 + SE94 — reviewer severities: blocker and blocker. Validated severity: VERIFIED blocker. Gate mutation and direct tests proved the current transcript is the source and no repair deletes it. Episodes: `t79.e1`, `t81.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t81.e1.md`, `.pi/slate/observations/t82.e1.md`.
- BG2 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Slate now skips a crash-truncated malformed line like pi's loader. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- BG3 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. An unusable `forkedFrom` hint is removed without dropping the thread. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- BG4 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Empty `forkedFrom` now sanitizes to absence and retains the thread. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- BG5 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. A malformed source line is skipped, so a truncated legacy source can still fork. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- CQ38 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. A fork refusal now reaches the unbilled `DispatchAbort` exit with no episode. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- CQ39 — reviewer severity: suggestion. Validated severity: suggestion, open as issue JetBrains/ytdb-slate#236. A source replacement can leave a published copy orphaned. Episode: `t79.e1`. Observation: `.pi/slate/observations/t79.e1.md`.
- CQ40 — reviewer severity: suggestion. Validated severity: suggestion, open as issue JetBrains/ytdb-slate#237. The remaining mechanics are a duplicate `fstatSync` call and a duplicated private-mode literal. The later source-stability fix made `TranscriptInspection.bytes` live, correcting the original dead-data finding. Episode: `t79.e1`. Observation: `.pi/slate/observations/t79.e1.md`.
- CQ41 — reviewer severity: suggestion. Validated severity: suggestion, open as issue JetBrains/ytdb-slate#238. Two comments contradict the persistence and recovery behavior. Episode: `t79.e1`. Observation: `.pi/slate/observations/t79.e1.md`.
- CQ42 — reviewer severity: suggestion. Validated severity: suggestion, open as issue JetBrains/ytdb-slate#239. The scanner repeatedly slices its pending buffer and can become quadratic. Episode: `t79.e1`. Observation: `.pi/slate/observations/t79.e1.md`.
- CQ43 — reviewer severity: suggestion. Validated severity: suggestion, open. Commit `d1baf45` has literal backslash-n text in its body. Episode: `t79.e1`. Observation: `.pi/slate/observations/t79.e1.md`.
- TQ1 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Mutation M16 proved tests pin healthy-fork reuse. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- TQ2 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Mutation M14 proved tests reject transcript deletion. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- TQ3 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Tests now pin empty-transcript damage. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- TQ4 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Tests now pin the missing-session-header refusal. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- TQ5 — reviewer severity: suggestion. Validated severity: VERIFIED suggestion. Tests now exercise the source-bound predicate and its in-read enforcement. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- TQ6 — reviewer severity: suggestion. Validated severity: VERIFIED suggestion. Tests and resolver fixtures now retain a valid `sessionFile` and `forkedFrom` pair. Episodes: `t79.e1`, `t82.e1`. Observations: `.pi/slate/observations/t79.e1.md`, `.pi/slate/observations/t82.e1.md`.
- CN111 — reviewer severity: blocker. Validated severity: VERIFIED blocker. Post-copy verification rereads the pinned source descriptor and compares byte and entry counts. Episodes: `t80.e1`, `t82.e1`. Observations: `.pi/slate/observations/t80.e1.md`, `.pi/slate/observations/t82.e1.md`.
- CN112 — reviewer severity: blocker. Validated severity: should-fix, lowered with explicit user confirmation. The missing fsync on state append is pre-existing behavior for all Slate state and was not introduced by this track. Follow-up issue JetBrains/ytdb-slate#234 records it. Episode: `t80.e1`. Observation: `.pi/slate/observations/t80.e1.md`.
- CN113 — reviewer severity: should-fix. Validated severity: accepted residual with explicit user confirmation. Attempt staging cleanup is verified. A crash after rename but before state save loses no data and can leave only an unreferenced copy. Episodes: `t80.e1`, `t82.e1`, `t84.e1`. Observations: `.pi/slate/observations/t80.e1.md`, `.pi/slate/observations/t82.e1.md`, `.pi/slate/observations/t84.e1.md`.
- SE91 — reviewer severity: blocker. Validated severity: VERIFIED blocker. Type checks now precede opens, and nonblocking opens make FIFO refusal load-bearing. Episodes: `t81.e1`, `t82.e1`. Observations: `.pi/slate/observations/t81.e1.md`, `.pi/slate/observations/t82.e1.md`.
- SE92 — reviewer severity: blocker. Validated severity: VERIFIED blocker. The fork-source hardlink refusal remains strict, and gate round 2 separately verified the RG271 retention regression. Episodes: `t81.e1`, `t82.e1`, `t84.e1`. Observations: `.pi/slate/observations/t81.e1.md`, `.pi/slate/observations/t82.e1.md`, `.pi/slate/observations/t84.e1.md`.
- SE93 — reviewer severity: blocker. Validated severity: VERIFIED blocker. Tests prove destination reservation and staged-inode pinning, with orphan cleanup retained under CN113. Episodes: `t81.e1`, `t82.e1`. Observations: `.pi/slate/observations/t81.e1.md`, `.pi/slate/observations/t82.e1.md`.
- SE95 — reviewer severity: blocker. Validated severity: VERIFIED blocker. The 64 MiB bound is enforced during each read. Episodes: `t81.e1`, `t82.e1`. Observations: `.pi/slate/observations/t81.e1.md`, `.pi/slate/observations/t82.e1.md`.
- RG271 — reviewer severity: blocker. Validated severity: VERIFIED blocker. Restore retains hardlinked thread and episode records, while the fork-source gate still refuses hardlinks. Gate mutations independently failed both retention halves and the fork-source relaxation. Episodes: `t82.e1`, `t84.e1`. Observations: `.pi/slate/observations/t82.e1.md`, `.pi/slate/observations/t84.e1.md`.
- BG6 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. The exact zero-length owned transcript returns to pi for in-place reinitialization, while nonempty damage remains refused. Two opposite mutations failed. Episodes: `t82.e1`, `t84.e1`. Observations: `.pi/slate/observations/t82.e1.md`, `.pi/slate/observations/t84.e1.md`.
- BG7 — reviewer severity: suggestion. Validated severity: suggestion, open as issue JetBrains/ytdb-slate#235. Slate counts falsy JSON values that pi's loader skips, causing false damage or count mismatch. Episode: `t82.e1`. Observation: `.pi/slate/observations/t82.e1.md`.
- TQ7 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Gate round 2 repeated mutation M15, and the new test failed when any inspection error could authorize re-fork. Episodes: `t82.e1`, `t84.e1`. Observations: `.pi/slate/observations/t82.e1.md`, `.pi/slate/observations/t84.e1.md`.
- CQ44 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Both `9c1943e` and `758079b` have real multiline bodies with no literal backslash-n pairs. Episodes: `t82.e1`, `t84.e1`. Observations: `.pi/slate/observations/t82.e1.md`, `.pi/slate/observations/t84.e1.md`.
- TS1 — reviewer severity: suggestion. Validated severity: VERIFIED should-fix after orchestrator escalation. Injected assertion failures left no protected fixture directories, while the reconstructed old shape leaked one per failure. Episodes: `t82.e1`, `t84.e1`. Observations: `.pi/slate/observations/t82.e1.md`, `.pi/slate/observations/t84.e1.md`.
- SE96 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix at gate round 4. The strict open preserves the security property, and RG272's verified abort conversion repairs its refusal outcome. Episodes: `t84.e1`, `t85.e1`, `t86.e1`. Observations: `.pi/slate/observations/t84.e1.md`, `.pi/slate/observations/t85.e1.md`, `.pi/slate/observations/t86.e1.md`.
- TQ8 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Gate round 3 mutation proved ordinary hardlinked reads remain accepted while strict transcript opens refuse. Episodes: `t84.e1`, `t85.e1`. Observations: `.pi/slate/observations/t84.e1.md`, `.pi/slate/observations/t85.e1.md`.
- CQ45 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix. Restore documentation and notices now describe retained records and later containment refusal accurately. Episodes: `t84.e1`, `t85.e1`. Observations: `.pi/slate/observations/t84.e1.md`, `.pi/slate/observations/t85.e1.md`.
- BG8 — reviewer severity: suggestion. Validated severity: VERIFIED should-fix after orchestrator escalation. The refusal names the extra disk name, probable hardlink backup and single-linked-copy remedy. Episodes: `t84.e1`, `t85.e1`. Observations: `.pi/slate/observations/t84.e1.md`, `.pi/slate/observations/t85.e1.md`.
- RG272 — reviewer severity: blocker. Validated severity: VERIFIED blocker at gate round 4. A self-derived dispatch probe observed no episode, sequence advance, compressor call or cost, while preserving the remedy text. Episodes: `t85.e1`, `t76.e9`, `t86.e1`. Observations: `.pi/slate/observations/t85.e1.md`, `.pi/slate/observations/t76.e9.md`, `.pi/slate/observations/t86.e1.md`.
- BG9 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix at gate round 4. Descriptor probes covered every containment helper, acquisition failure, callback failure and success without leaks or double-close failures. Episodes: `t85.e1`, `t76.e9`, `t86.e1`. Observations: `.pi/slate/observations/t85.e1.md`, `.pi/slate/observations/t76.e9.md`, `.pi/slate/observations/t86.e1.md`.
- TQ9 — reviewer severity: should-fix. Validated severity: VERIFIED should-fix at gate round 4. Deleting the successful strict-open branch failed all three positive tests. Episodes: `t85.e1`, `t76.e9`, `t86.e1`. Observations: `.pi/slate/observations/t85.e1.md`, `.pi/slate/observations/t76.e9.md`, `.pi/slate/observations/t86.e1.md`.
- CQ46 — reviewer severity: suggestion. Validated severity: suggestion, open as issue JetBrains/ytdb-slate#240. Commit bodies expand TQ, TS and CQ contrary to `review-rules.md` section 4. Episode: `t84.e1`. Observation: `.pi/slate/observations/t84.e1.md`.
- CQ47 — reviewer severity: suggestion. Validated severity: suggestion, open as issue JetBrains/ytdb-slate#241. Two dispatch comments incorrectly limit episode-free aborts to apply-time routing. Episode: `t86.e1`. Observation: `.pi/slate/observations/t86.e1.md`.
- Gate round 4 found no regression in the nineteen previously verified track 04b findings. Episode: `t86.e1`. Observation: `.pi/slate/observations/t86.e1.md`.
- Gate round 2 found no regression in the twelve previously verified track 04b findings. Episode: `t84.e1`. Observation: `.pi/slate/observations/t84.e1.md`.

## Suggestions (track 04b)

- CN112 → JetBrains/ytdb-slate#234: Add state-append durability so a crash cannot lose a published fork pointer.
- BG7 → JetBrains/ytdb-slate#235: Match pi's treatment of falsy parsed JSON values in the accepted-entry counter.
- CQ39 → JetBrains/ytdb-slate#236: Reclaim an unrecorded published fork after a source-stability failure.
- CQ40 → JetBrains/ytdb-slate#237: Remove the duplicate `fstatSync` call and use the named private-directory mode constant. The later source-stability fix made `TranscriptInspection.bytes` live, so the issue does not seek its removal.
- CQ41 → JetBrains/ytdb-slate#238: Correct transcript comments that contradict persistence ordering and recovery behavior.
- CQ42 → JetBrains/ytdb-slate#239: Make transcript scanning linear instead of repeatedly slicing the pending buffer.
- CQ46 → JetBrains/ytdb-slate#240: Use the review rule's finding-prefix meanings in future commit bodies.
- CQ47 → JetBrains/ytdb-slate#241: Correct dispatch comments so they cover every pre-work `DispatchAbort`.

### Track 04b gate round 2 decisions

- D189: Commit `9c1943e` amends the first review-fix commit without changing its tree, replacing CQ44's literal backslash-n body with real paragraphs. Commit `758079b` is fix iteration 2 for RG271, BG6, TQ7 and TS1.
- D190: Gate round 2 VERIFIED RG271, BG6, TQ7, TS1 and CQ44. Independent probes re-derived the original failures, and mutations failed the new retention, zero-length recovery, narrow re-fork and cleanup tests. Both reviewed commit bodies contain real line endings.
- D191: The SE96 remedy keeps D184 unchanged. The transcript OPEN path returns to the strict single-link predicate, while restore-time record retention and ordinary read-only artifact access stay relaxed. This split is chosen over a design change because D184 already requires multiply-linked transcript refusal. SE96, TQ8 and CQ45 remain in progress.
- D192: BG8 rises from suggestion to should-fix. Restoring D184's strict transcript-open gate makes a hardlink-backup refusal user-visible, so the report must identify the hardlink condition and give an actionable remedy. BG8 remains in progress.

### Track 04b gate round 3 and fix iteration 4 decisions

- D193: Commit `a4bebe8`, `Restore strict worker transcript opens`, landed fix iteration 3. Gate round 3 VERIFIED BG8, TQ8 and CQ45 through direct probes and a mutation that distinguished strict transcript opens from relaxed ordinary reads.
- D194: Gate round 3 found RG272. The strict transcript-open refusal preserved D184's security property but threw a plain error, so dispatch wrote a failed episode and paid a compressor call before worker action. Fix iteration 4 catches only that named refusal and converts it to `DispatchAbort`, matching CQ38 while preserving the user-facing hardlink message. RG272 awaits gate round 4.
- D195: Fix iteration 4 makes the containment helper close its file descriptor on every failure between `openSync` and callback ownership. Forty forced failures previously leaked forty descriptors. BG9 awaits gate round 4.
- D196: The containment helper gains an optional `afterOpen` fault-injection parameter. Tests can now force a deterministic post-open validation failure without weakening production checks. This seam supports BG9's mutation proof and awaits gate round 4.
- D197: Positive tests now pin strict-open success for a single-linked resumed transcript, an inherited transcript's fresh fork and a legacy flat transcript's corpus fork. A mutation deleting the successful strict-open branch had passed every focused test. TQ9 awaits gate round 4.
- D198: Three consecutive fix rounds each introduced one new defect that the next gate caught: RG271 from the SE92 fix, SE96 from the RG271 relaxation, and RG272 from the SE96 fix. Every round therefore required a fresh independent gate and mutation proofs rather than inherited confidence.

### Track 04b gate round 4 and ladder decisions

- D199: Commit `6d583f5`, `Close transcript dispatch and descriptor gaps`, landed fix iteration 4 for RG272, BG9 and TQ9.
- D200: Gate round 4 VERIFIED RG272, BG9 and TQ9. It used a self-derived dispatch counterexample, descriptor probes across every containment helper, and a strict-open deletion mutation. No regression appeared in the nineteen previously verified findings. Evidence: `.pi/slate/observations/t86.e1.md`.
- D201: The optional `afterOpen` callback is accepted as a narrow test seam. No production caller supplies it, project configuration cannot reach it, and it widens no public extension surface. Deterministic post-open failure testing otherwise requires a filesystem race or a broader adapter.
- D202: The full verification ladder ran alone at `6d583f5` and satisfied D180. It reported 26 pass, 0 fail and 0 not run, exited zero, and confirmed the real settings file was unchanged. Evidence: `.pi/slate/observations/t27.e14.md`.

## Track 04b compact review record

This table is the compact status index. Detailed evidence remains in the review ledger above.

| Finding | Reviewer severity | Validated severity | Closing gate | Observation |
| --- | --- | --- | --- | --- |
| BG1 | blocker | VERIFIED blocker | round 1 | `.pi/slate/observations/t82.e1.md` |
| BG2 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| BG3 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| BG4 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| BG5 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| BG6 | should-fix | VERIFIED should-fix | round 2 | `.pi/slate/observations/t84.e1.md` |
| BG7 | suggestion | open suggestion | none | `.pi/slate/observations/t82.e1.md` |
| BG8 | suggestion | VERIFIED should-fix | round 3 | `.pi/slate/observations/t85.e1.md` |
| BG9 | should-fix | VERIFIED should-fix | round 4 | `.pi/slate/observations/t86.e1.md` |
| SE91 | blocker | VERIFIED blocker | round 1 | `.pi/slate/observations/t82.e1.md` |
| SE92 | blocker | VERIFIED blocker | round 2 | `.pi/slate/observations/t84.e1.md` |
| SE93 | blocker | VERIFIED blocker | round 1 | `.pi/slate/observations/t82.e1.md` |
| SE94 | blocker | VERIFIED blocker | round 1 with BG1 | `.pi/slate/observations/t82.e1.md` |
| SE95 | blocker | VERIFIED blocker | round 1 | `.pi/slate/observations/t82.e1.md` |
| SE96 | should-fix | VERIFIED should-fix | round 4 with RG272 | `.pi/slate/observations/t86.e1.md` |
| CN111 | blocker | VERIFIED blocker | round 1 | `.pi/slate/observations/t82.e1.md` |
| CN112 | blocker | lowered to should-fix with user confirmation; issue 234 filed | user disposition | `.pi/slate/observations/t80.e1.md` |
| CN113 | should-fix | staging VERIFIED; published orphan accepted residual with user confirmation | user disposition after round 1 | `.pi/slate/observations/t82.e1.md` |
| RG271 | blocker | VERIFIED blocker | round 2 | `.pi/slate/observations/t84.e1.md` |
| RG272 | blocker | VERIFIED blocker | round 4 | `.pi/slate/observations/t86.e1.md` |
| CQ38 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| CQ39 | suggestion | open suggestion | none | `.pi/slate/observations/t79.e1.md` |
| CQ40 | suggestion | open suggestion | none | `.pi/slate/observations/t79.e1.md` |
| CQ41 | suggestion | open suggestion | none | `.pi/slate/observations/t79.e1.md` |
| CQ42 | suggestion | open suggestion | none | `.pi/slate/observations/t79.e1.md` |
| CQ43 | suggestion | VERIFIED suggestion | round 2 with commit amendments | `.pi/slate/observations/t84.e1.md` |
| CQ44 | should-fix | VERIFIED should-fix | round 2 | `.pi/slate/observations/t84.e1.md` |
| CQ45 | should-fix | VERIFIED should-fix | round 3 | `.pi/slate/observations/t85.e1.md` |
| CQ46 | suggestion | open suggestion | none | `.pi/slate/observations/t84.e1.md` |
| CQ47 | suggestion | open suggestion | none | `.pi/slate/observations/t86.e1.md` |
| TQ1 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| TQ2 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| TQ3 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| TQ4 | should-fix | VERIFIED should-fix | round 1 | `.pi/slate/observations/t82.e1.md` |
| TQ5 | suggestion | VERIFIED suggestion | round 1 | `.pi/slate/observations/t82.e1.md` |
| TQ6 | suggestion | VERIFIED suggestion | round 1 | `.pi/slate/observations/t82.e1.md` |
| TQ7 | should-fix | VERIFIED should-fix | round 2 | `.pi/slate/observations/t84.e1.md` |
| TQ8 | should-fix | VERIFIED should-fix | round 3 | `.pi/slate/observations/t85.e1.md` |
| TQ9 | should-fix | VERIFIED should-fix | round 4 | `.pi/slate/observations/t86.e1.md` |
| TS1 | suggestion | VERIFIED should-fix | round 2 | `.pi/slate/observations/t84.e1.md` |

## Track 04b remaining open items

- No track 04b follow-up issue is owed. CN112 and every open suggestion have issue numbers 234 through 241.
- Q5 is closed as expected behaviour. No issue was filed because the extension enforced its documented continuation guard.
- The remaining planned work is tracks 04c, 04d, 04e and 08.

### Track 04b user approval, marker and live smoke decisions

- D203: The user approved the track 04b diff on 2026-08-19. Empty marker commit `ea8aefd`, `Track 04b complete: transcript-fork`, landed with no file change. Marker evidence: `.pi/slate/observations/t77.e6.md`.
- D204: CN112 lowers from blocker to should-fix with explicit user confirmation. The state append's missing fsync is pre-existing behavior across all Slate state, and track 04b did not create it. Severity lowering required user confirmation and received it. Follow-up issue JetBrains/ytdb-slate#234 now records it.
- D205: The user accepts CN113's published-orphan half as a residual. A crash between fork rename and state save loses no data and leaves only an unreferenced copy on disk.
- D206: The live working-tree smoke test closed the last verification gap. A real dispatch succeeded and wrote its transcript under the first corpus session's `threads` directory. Handoff created a successor session, and inherited continuation forked the transcript into the successor `threads` directory. The fork header's `parentSession` points at the source. The thread record's `sessionFile` points at the fork, while `forkedFrom` points at the source. The source remained byte-identical with unchanged modification time. Both sessions exited zero without an extension-load failure. Evidence: `.pi/slate/observations/t89.e1.md`.
- D207: CQ40's original dead-data finding is corrected. The later source-stability fix made `TranscriptInspection.bytes` live. Issue JetBrains/ytdb-slate#237 therefore covers only the duplicate `fstatSync` call and the literal directory mode beside the named constant.
- D208: Q5 is expected behaviour. The live test displayed the orchestrator model's paraphrase, while `extension/threads.ts` owns the real `FRESH_CONTEXT_REQUIRED_ERROR`. This checkout sets non-default `threadChoice.act: true` in `.pi/slate.json`. The failing continuation omitted `freshContext`, while an earlier continuation passed one episode identifier and succeeded. The guard runs before transcript handling and billed no episode, so the refusal is unrelated to fork work. No issue was filed because the extension correctly enforced its documented policy. Evidence: `.pi/slate/observations/t91.e1.md`.
- D209: Future interactive smoke-test harnesses must pass `freshContext` on every continuation when `threadChoice.act` is true. Omitting it trips a designed guard and makes a valid harness run read as a failure.

## Open Questions (continued)

- Q5 (CLOSED — EXPECTED BEHAVIOUR, see D208): The live test saw the orchestrator model's own paraphrase. The real `FRESH_CONTEXT_REQUIRED_ERROR` in `extension/threads.ts` rejects a continuation without `freshContext` when `threadChoice.act` is true. This checkout enables that non-default setting in `.pi/slate.json`. The failing call omitted `freshContext`, while an earlier continuation with one episode identifier succeeded. The guard runs before transcript handling and billed no episode. The refusal is unrelated to fork work. No issue was filed because the extension enforced its documented policy.

### Track 04c opening decisions

- D210: The orchestrator splits the approved track 04c scope into two tracks and owns that split. Track 04c delivers the mechanism: the corpus handoff record, validation order, explicit adoption command, trust ordering, refusal, candidate listing and pending-handoff claim-marker deletion. New track 04e delivers the shipped text corrections and verification re-cut. Track numbering is append-only, and no track number is reused.
- D211: Recon confirmed that no decision appended after the pre-implementation approval at log line 590 changes the approved track 04c design. No design delta presentation is owed. Evidence: `.pi/slate/observations/t93.e2.md`.
- D212: Two mechanisms have been called a claim. D95 deletes the pending-handoff claim marker in `extension/handoff.ts`. The owner session digest in `extension/state.ts` stays. D102, D120 and D69 govern that digest. Implementation must preserve this distinction and must not delete the owner session digest.
- D213: The namespace-exclusivity question is settled by the approved design. D99 makes exclusive directory creation the uniqueness primitive, and D145 makes creation eager. D102 and D120 prevent adoption from importing the predecessor identity. D89 gives concurrent successors separate directories. Evidence: `.pi/slate/observations/t93.e2.md`.

## Surprises & Discoveries (continued)

- S22: The measured transcript-fork containment check is identity-blind. Two sessions sharing one session name would append to one transcript without a fork. Artifact writes under that shared name are last-writer-wins and refuse nothing. The approved design prevents the shared name. Track 04c therefore owes a test proving adoption never imports the predecessor session name, session id or owner digest. Evidence: `.pi/slate/observations/t94.e1.md`.

## Suggestions (continued)

- SG13: Make the transcript-fork containment check identity-aware as defence in depth. This would protect against a future shared-name regression before transcript reuse. It is a design change and stays outside track 04c.

- D214: The track 04c handoff-record validation order is resolved as follows: (1) trust gate, (2) pre-parse 1 MiB size check, (3) parse and perform full schema plus field-count validation, and (4) validate path containment and reject symlinks. This order resolves the task wording conflict and conforms to D133. Decision numbering remains append-only, and D214 is unique.
- D215: Malicious concurrent filesystem mutation by the same operating-system user, specifically a replace-open-restore ABA swap of the handoff-record parent directory, is outside Slate's threat model because Node 24 exposes no portable directory-relative open API. Track 04c will still add the strongest portable pre-open and post-open directory descriptor/inode checks. Those checks must reject static symlinks and ordinary one-way replacements, while the exact ABA race remains an accepted residual risk. Linux-only /proc/self/fd behavior and a native openat dependency are rejected to preserve portability and packaging boundaries.
- D216: Review finding CN4 is already governed by user-approved D112: the global model-default race is pre-existing, accepted, and outside track 04. The safe-stand-down change in commit b37533c drifted from the approved design and from D113's requirement that replacement ladder rungs still cover the handoff model-switch site. Track 04c will restore approved automatic model and thinking-level adoption through withGlobalModelDefaultRestored, retain the existing model-default safeguards, and treat CN4 as the already accepted D112 risk rather than a new blocker.

## Planned changes (continued)

### Track 04c ladder-isolation design amendment

Goal: Let the verification ladder run beside permitted real pi sessions without false failures from shared real settings state.

Approach: Use one hermetic `env -i` launcher for every ladder child. Before every launch, validate throwaway `HOME` and `TMPDIR` with the agent-redirect rules: non-empty, absolute, real directories, non-symlinks, and inside the lab. Give each child an explicit `PI_CODING_AGENT_DIR`, a controlled `PATH` built from guarded absolute tool resolutions, `PI_OFFLINE`, and only required canary variables. Require exact child-environment equality against that allowlist. Keep `PI_CODING_AGENT_SESSION_DIR`, `NODE_OPTIONS`, credentials, proxies, and stale pi variables absent. Unify P11 and every duplicate launcher path through the common launcher. Require a positive child marker for every launch.

Concurrency and evidence: Permit concurrent sessions only when they cannot write the checkout under test. Prohibit same-checkout writers. Capture a fatal repository fingerprint before and after the run covering `HEAD`, the index, tracked content, relevant untracked content, and metadata. Treat same-user edit-and-restore as the stated residual boundary. Keep selected-agent, fallback-home-agent, session, and corpus sandbox evidence authoritative. Keep the real settings content hash as a nonfatal note.

Scope and self-tests: Add tests for absent and empty HOME/TMPDIR, poisoned parent variables, redirect loss, exact environment closure, nested workers, P11, launcher bypass, positive child markers, the inherited `PI_CODING_AGENT_DIR` guard in an outer subprocess, and concurrent writes to fabricated settings. This amendment folds into track 04c because it is required to verify that track.

Risks: A dependency could use a hardcoded absolute real-home path. Same-user edit-and-restore can evade the repository fingerprint. The hermetic launcher does not provide operating-system filesystem sandboxing.

Rejected alternatives: HOME-only isolation, PI_CODING_AGENT_DIR-only isolation, fatal real-file monitoring, Linux tracing, and native sandboxing. No open question remains.

- D217: The user approved one hermetic `env -i` launcher for every verification-ladder child. It uses throwaway `HOME` and `TMPDIR`, explicit `PI_CODING_AGENT_DIR`, controlled `PATH`, `PI_OFFLINE`, and only required canary variables. `PI_CODING_AGENT_SESSION_DIR`, `NODE_OPTIONS`, credentials, proxies, and stale pi variables remain absent. P11 and every duplicate launcher path use the common launcher. Fatal real-settings fingerprinting is replaced by selected-agent, fallback-home-agent, session, and corpus sandbox evidence. The real settings content hash becomes a nonfatal note. Self-tests cover poisoned parent variables, redirect loss, nested workers, P11, launcher bypass, and concurrent writes to fabricated settings. The portable residual risk is a dependency using a hardcoded absolute real-home path. HOME-only isolation, PI_CODING_AGENT_DIR-only isolation, fatal real-file monitoring, Linux tracing, and native sandboxing are rejected. The amendment folds into track 04c because it is required to verify that track. No open question remains.
- D218: The ladder must validate throwaway HOME and TMPDIR before every child launch as non-empty, absolute, real directories, non-symlinks, and paths inside the lab. Self-tests must cover absent and empty values.
- D219: Permitted concurrent sessions are only sessions that cannot write the checkout under test. Same-checkout writers remain prohibited. A fatal before-and-after repository fingerprint covers HEAD, the index, tracked and relevant untracked content, and metadata. Same-user edit-and-restore is the stated residual boundary.
- D220: Every ladder child must satisfy exact environment equality against the reviewed allowlist. A deny list is insufficient. The common launcher must keep PI_CODING_AGENT_SESSION_DIR, NODE_OPTIONS, credentials, proxies, and stale pi variables absent.
- D221: The common launcher must derive controlled PATH entries from guarded absolute tool resolutions and require a positive child marker for every launch. This prevents isolated absence checks from passing vacuously. P11 and every duplicate launcher path must use this launcher.
- D222: Inherited PI_CODING_AGENT_DIR refusal remains fatal. A self-test must exercise that guard in an outer subprocess, while other poisoned variables test child environment closure. No final pre-implementation approval is recorded by this amendment.

Adversarial review: passed, 0 accepted risks — 2026-08-20
Design review (pre-implementation): user-approved — 2026-08-20

## Planned changes (continued)

### Track 04c handoff-wire and provenance amendment

Goal: Preserve exact handoff runtime strings while bounding new wire records and binding immediate provenance to durable local metadata.

Wire design: Version 2 uses field-position `WireString` values.

A plain string may contain up to 8,192 decoded UTF-8 bytes.

Longer values use Unicode-safe chunk arrays.

Structural checks and segment-size checks run before joining.

Joining must preserve exact runtime strings.

Compact serialization has independent 1 MiB total and depth-eight caps.

Legacy version 1 remains readable under its scalar schema, including strings above 8,192 bytes.

Only version 2 writes enforce chunk segments.

Provenance and lineage: Durable `session.json` binds the immediate author identity and name.

Worktree and branch remain live-at-handoff, display-only opaque values under D126.

Slate compares their raw exact values with adopter live state.

Slate sanitizes them only for reports and display.

Slate does not claim that they are authenticated or matched to frozen creation metadata.

`parentChain` is a shape-, uniqueness- and cycle-checked non-authoritative hint.

It has a 256-entry maximum.

Before appending the immediate predecessor, runtime state retains only the newest 255 entries.

The immediate predecessor requires its durable binding.

Historical absence is allowed after explicit pruning.

A present conflicting ancestor remains an unverifiable hint under the approved same-user boundary and grants no access.

Candidate and input safety: Writer staging files use a contained dedicated staging directory.

Interrupted staging files therefore do not consume the pending-candidate scan budget.

Final pending enumeration uses incremental `opendirSync` scanning with fixed scan, valid-candidate, aggregate-byte and output bounds.

Legacy exact-pattern staging entries are recognized separately and excluded from the valid-candidate budget.

An absolute scan-work cap produces a clear refusal when exceeded.

Junk is never silently treated as a candidate.

The writer identity-checks both directories.

It fsyncs the staging file and staging directory before rename.

It fsyncs both staging and pending directories after publication.

Failure cleanup covers every path.

Enumeration uses one manual `Dir.readSync` loop with one finally-close path.

Record bytes use fatal UTF-8 decoding before JSON parsing.

Every version 2 object layer rejects unknown fields.

Chunk arrays accept only strict string elements.

Scope: Update wire and runtime validation, provenance checks, lineage handling, staging layout, candidate enumeration and focused boundary tests.

Limit the work to track 04c.

Rejected alternatives: Refusing long strings, raising D133, truncation, requiring all ancestors, unkeyed checksums, signatures or key management in this track, and full-directory materialization.

Risks: Parallel wire and runtime schemas require synchronized maintenance.

Chunk overhead can push a near-1 MiB record over the cap.

Deliberate same-user rewriting of corpus files and metadata remains outside the threat model.

No open question remains.

- D223: Track 04c will use wire version 2 with field-position `WireString` values. Plain strings may contain at most 8,192 UTF-8 bytes. Longer values use Unicode-safe chunk arrays. Structural validation and segment-size validation precede joining. Joining must preserve exact runtime strings. Compact serialization enforces a 1 MiB total cap and depth eight. Version 1 remains accepted only when it satisfies D133. Long-string refusal, raising D133 and truncation are rejected.

- D224: The immediate handoff author identity, name, worktree and branch must match durable `session.json` metadata before adoption. Trusting record-supplied provenance or recomputing historical branches from Git is rejected.

- D225: `parentChain` is a shape-, uniqueness- and cycle-checked lineage hint. The immediate predecessor requires matching durable metadata. Historical ancestors may be absent after explicit pruning. Deliberate same-user rewriting of both corpus files and metadata is outside the threat model. Requiring every ancestor, unkeyed checksums, signatures and key management in this track are rejected.

- D226: Candidate enumeration will use incremental `opendirSync` scanning with fixed scan, valid-candidate, aggregate-byte and output bounds. Every path closes the directory descriptor. Full-directory materialization and silent truncation are rejected. Chunk overhead near the 1 MiB cap remains an accepted implementation risk.

- D227: Durable `session.json` binds the immediate handoff author identity and name. Worktree and branch remain live-at-handoff, display-only opaque values under D126. Slate sanitizes them and compares them with adopter live state. Slate does not claim that they are authenticated or matched to frozen creation metadata. The previous durable worktree and branch binding is reversed because frozen metadata can make a legitimate branch or worktree change unadoptable.

- D228: Legacy wire version 1 remains readable under its existing scalar schema, including strings above 8,192 bytes. It retains total-size, count, depth and semantic checks. Only version 2 writes enforce chunk segments. The prior requirement that version 1 satisfy the 8,192-byte bound is reversed because it would reproduce BG1.

- D229: Writer staging files move into a contained dedicated staging directory. Interrupted staging files cannot consume the pending-candidate scan budget. Final pending enumeration remains incremental and bounded.

- D230: The 8,192-byte limit applies to decoded UTF-8 bytes in each version 2 wire segment before JSON escaping. The total serialized file cap independently includes escaping overhead. This separates segment fidelity from file-size enforcement.

- D231: Handoff record bytes must pass fatal UTF-8 decoding before JSON parsing. A corrupted byte therefore refuses the record instead of becoming U+FFFD and passing later validation.

- D232: Every version 2 object layer rejects unknown fields. Version 2 chunk arrays accept only strict string elements and reject nesting, empty entries and other JSON types.

- D233: Historical lineage is non-authoritative. A present conflicting ancestor is treated as an unverifiable hint under the approved same-user boundary and grants no access. This accepted risk does not reopen the requirement for historical metadata binding.

- D234: D133's 8,192-byte bound is interpreted as applying to each version 2 wire segment. Version 1 remains the compatibility exception under D228. The amendment does not raise D133 or truncate runtime strings.

- D235: `parentChain` has a maximum of 256 entries. Boundary tests cover the limit and the first rejected entry. Historical pruning remains permitted under the lineage rules.

- D236: The governed amendment prose is revised to remove fail-level writing findings. A second adversarial review is required before any final verdict or implementation approval. No final adversarial or pre-implementation verdict is recorded here.

- D237: Runtime `parentChain` stays oldest-first. Before appending the immediate predecessor, adoption retains only the newest 255 entries. The result has at most 256 entries and drops only non-authoritative oldest hints. Boundary tests cover chains of 255 and 256 entries.

- D238: Slate compares `worktreePath` and `branchLabel` using raw exact values. Sanitization applies only to reports and display. This preserves the live-state equality guard without weakening it through display cleanup.

- D239: The staging-to-pending writer holds and identity-checks both directories. It fsyncs the staging file and staging directory before rename. It fsyncs both staging and pending directories after publication. Cleanup covers every failure path.

- D240: Legacy exact-pattern staging entries are recognized separately from final candidates and excluded from the 64-candidate budget. Incremental scanning has an absolute work cap with a clear refusal. Junk is never silently treated as a candidate.

- D241: Candidate enumeration uses one manual `Dir.readSync` loop with one finally-close path. It avoids iterator auto-close and double-close errors.

- D242: Append-only correction annotations record that D227 supersedes D224 and that D228 and D234 supersede D223's version 1 and wire-bound wording. The current authority index records both corrections. The amendment retains zero fail-level writing findings.
- D243: The user approved Track 04c on 2026-08-20 after reviewing `ea8aefd..66841dc`. Empty marker `Track 04c complete: handoff-mechanism` records completion.

Correction annotation (append-only): D227 supersedes D224's requirement to bind worktree and branch to frozen `session.json` metadata. D227 keeps durable binding for identity and name.

Correction annotation (append-only): D228 and D234 supersede D223's version 1 compatibility condition and clarify that the 8,192-byte bound applies to each version 2 wire segment.

Design review (pre-adversarial): user-approved — 2026-08-20
Adversarial review: passed, 1 accepted risk — 2026-08-20
Design review (pre-implementation): user-approved — 2026-08-20

### Track 04c review closure

Closure record: BG1-BG8, TQ1-TQ4 and all other blocker and should-fix findings from the track are closed and verified. The final required verification packet passed at HEAD `66841dc55605ee3b5ae04668dcae35cdf9b0b045`: typecheck, packaging guards and self-test, extension load check, strict resolver checks, unit tests with patch coverage, package-content checks and self-test, writing-reminder integration, ladder self-test and the full strict ladder. The packet reported 380 passing tests, 94.26% line coverage, 87.61% branch coverage, no failed checks and no NOT RUN entries. Episodes: `t98.e1`, `t115.e1`, `t123.e1`, `t131.e1`, `t133.e1`, `t134.e1`, `t135.e1`. Only implementation-stage suggestions remain below. CQ8 and RG50 are intentionally omitted because later work fixed them.

- CQ2: Suggestion. What: stale comments describe a removed `session_start` adoption handler and its ordering contract. Where: `extension/index.ts:268,293-295`, `extension/mode.ts:15,828-830` and `extension/handoff.ts:250`. Why it matters: maintainers can infer that automatic adoption still runs, which conflicts with the explicit `/slate adopt <name>` flow. A fix needs comments and nearby ordering text to describe only the registered `turn_end`, `agent_end` and `session_before_compact` handlers.
- CQ3: Suggestion. What: pause instructions promise a fresh session with automatic restore. Where: `extension/handoff.ts:315-316,336,369` and `extension/mode.ts:629`. Why it matters: users receive an incorrect successor workflow because adoption now requires a separate command. A fix needs the shipped instructions to name `/slate adopt <name>` and match the two-step handoff flow. Track 04e owns the shipped-text correction.
- CQ4: Suggestion. What: `_getBaseModel` carries an unused-parameter prefix. Where: `extension/handoff.ts:275`, called by `restoreAdoptedModel` at lines 453, 460 and 465. Why it matters: the prefix hides whether the callback still needs a base-model argument and leaves avoidable interface noise. A fix needs the parameter removed from the callback and its call sites, or a documented use restored.
- CQ5: Suggestion. What: `adoptedThisSessionStart` is dead runtime state, so the force-preservation term is always false. Where: `extension/writing-reminder.ts:159`. Why it matters: the state name suggests a session-start adoption path that no longer exists, and the branch obscures reminder behavior. A fix needs the dead state and unreachable branch removed, with resolver checks updated to cover the remaining policy.
- CQ6: Suggestion. What: an absent snapshot returns after clearing identity even when foreign identity preservation is requested. Where: `extension/state.ts:1291`, in `adoptSnapshot`. Why it matters: a failed foreign restore can erase the identity that the caller asked to preserve. A fix needs the absent-snapshot path to honor `foreignSessionIdentity` before clearing state, with a regression test for `adoptSnapshot(undefined, ctx, { foreignSessionIdentity: true })`.
- CQ7: Suggestion. What: listing failures use informational severity, and returned `file` and `authorSessionDirectory` fields are unused. Where: `extension/handoff.ts:485,516` and `extension/handoff-record.ts:63`. Why it matters: a real listing error can look like normal status output, while unused result fields obscure the intended error context. A fix needs error severity for failed listing, plus removal of unused fields or consumption in the diagnostic path.
- RG51: Suggestion. What: the residue cap refuses writes without naming the staging directory or a remedy. Where: `extension/handoff-record.ts:625,663-667`. Why it matters: more than 64 staged files can permanently wedge handoff writes, and users cannot locate the residue from the message. A fix needs the refusal to include the `handoff-staging` path and an actionable cleanup instruction without violating the no-automatic-deletion rule.
- RG52: Suggestion. What: the legacy-staging regex branch is dead and under-matches real legacy names. Where: `extension/handoff-record.ts:546-547`. Why it matters: the misleading branch suggests protection that the suffix check already provides, while its pattern does not describe historical names. A fix needs the dead branch removed or replaced with one tested pattern that matches the intended legacy staging grammar.
- RG53: Suggestion. What: `THREAD_STRING_KEYS` and `EPISODE_STRING_KEYS` are hand-maintained separately from runtime string-typed fields. Where: `extension/handoff-record.ts:132-133`. Why it matters: a future long string field can bypass wire chunk validation and fail only during later sanitization. A fix needs a compiler-linked `satisfies` witness or equivalent source-of-truth check, plus a regression test for newly added string fields.
- RG54: Suggestion. What: snapshot restore leaves `parentChain` untrimmed above the 256-entry write limit. Where: `extension/state.ts:1326`, compared with the adoption trim at `:1316` and the writer limit at `extension/handoff-record.ts:339`. Why it matters: a hand-edited snapshot can restore successfully, then make the next handoff fail. A fix needs restore to apply the same newest-255-plus-immediate-predecessor bound, with a boundary test for a 257-parent snapshot.

- D244: Track 04c already delivered and passed D118's verification re-cut. Track 04e therefore retains only approved shipped-text and comment corrections, with no design delta or new user gate.
- D245: The user approved Track 04e on 2026-08-20 after reviewing `ebb8f44..a38ddbd`. Empty marker subject `Track 04e complete: handoff-guidance` records completion.

### Track 04e review round 1

CQ200 | should-fix | should-fix | t147.e1 | .pi/slate/observations/t147.e1.md | fix extension/handoff.ts comment
TQ200 | should-fix | should-fix | t147.e1 | .pi/slate/observations/t147.e1.md | restore test-harness mode discrimination
TQ201+WI200 | should-fix | should-fix | t147.e1,t148.e1 | .pi/slate/observations/t147.e1.md;.pi/slate/observations/t148.e1.md | expand guidance assertions
WS200 | should-fix | should-fix | t148.e1 | .pi/slate/observations/t148.e1.md | correct explicit-adoption wording in docs/writing-guidance.md

### Track 04e gate round 2

WS200 | should-fix | should-fix | t150.e1 | .pi/slate/observations/t150.e1.md | STILL OPEN; iteration two names `/slate adopt <name>` in writing guidance

### Track 04e review closure

CQ200, TQ200, TQ201, WI200 and WS200 are VERIFIED. No blocker or should-fix remains. No new suggestion was filed.

The final packet passed at HEAD `a38ddbd`. Packaging guards passed 16/16, and the packaging self-test passed 16/16. The extension load check passed 14/14. Strict resolver checks passed 223/223, with zero NOT RUN entries. Unit tests passed 382/382. The package-content check passed 14 checks, and its self-test passed 6 checks. Writing checks reported zero fail, warning and house-style findings. The cumulative check reported one advisory only, and the focused synthetic check reported zero advisories. The Git diff check passed.

Patch coverage reported 8/8 changed lines and 0/0 changed branches. The overall verdict was WARN. The manual disposition is that prose, comments and tests added no executable production branch, so zero changed branches is expected.


### Planned changes amendment: Track 04d listing and Track 04f prune

Superseded: The user removed prune from this change, so this amendment now covers listing only.

## Goal

Slate stores its work evidence in a corpus. A corpus is the private directory tree where slate keeps one directory for each project and one directory for each session. Today no command shows a user what that corpus holds. No command removes anything from it either. The corpus therefore grows without limit, and a user cannot pick a past session by name because a session name carries no description.

This amendment covers two commands across two tracks. A listing command reports the sessions of the current project. A prune command deletes one named session on explicit user request. Track 04d delivers listing only. Track 04f delivers prune.

The goal is a user who can see the corpus and can remove one chosen session safely. Nothing in either track deletes anything on its own.

## Approach

### Listing, in Track 04d

The listing command reads the current project directory with a bounded scan. A bounded scan reads directory entries one at a time, counts them, and refuses when the count passes a fixed limit. The command reports one row for each session. Each row carries the session name, the durable session identity, the recorded branch label, the recorded worktree path, and the creation time.

The command also reports whether a pending handoff record exists for that session. A pending handoff record is the file an author session writes so that a later session can adopt its state. The command writes nothing and deletes nothing.

### Prune, in Track 04f

The prune command takes one session name. It resolves that name against the project directory. It then runs a fixed guard sequence. Every guard must pass before any byte is removed. The command then asks the user to confirm the exact session name through a real interactive dialog.

The command then moves the session directory to a reserved tombstone name inside the same project directory. A tombstone is a renamed directory that marks a session as condemned. The command deletes the tombstone content afterwards. A crash between the two steps leaves a tombstone that the next prune run reports and can finish.

Both commands reuse the existing subcommand surface of the slate command. Both commands reuse the existing dual reporting channel, which writes one message to the console and one message to the user interface.

## Key decisions

### Decision 1: the prune deletion set is one whole session unit

Prune removes one session unit. A session unit is the session directory, its metadata file, its three artifact categories, and the pending handoff record whose name matches that session.

Prune removes nothing else. It never touches another session. It never touches a project directory. It never touches the corpus root. It never touches a staging directory it did not create.

Rejected alternative: a sweep that removes every unreferenced directory. That design needs a global reachability judgement over the whole corpus. A wrong judgement destroys evidence that a user still needs. Rejected alternative: a category level prune that removes episodes but keeps threads. That design leaves a session whose evidence is partly missing, and every reader must then handle a new partial state.

### Decision 2: the command interface is explicit, named and single target

The listing command takes no argument. The prune command takes exactly one session name. The prune command supports one preview mode that reports what it would remove and removes nothing. The prune command refuses more than one name. The prune command has no force flag and no age filter and no pattern argument.

Rejected alternative: a multiple target prune. Batch deletion multiplies the cost of a single mistake. Rejected alternative: a force flag that skips confirmation. A skip path becomes the habitual path, and the confirmation then protects nobody.

### Decision 3: live session and lineage protection refuse before they guess

Prune refuses when the named session is the session that runs the command. Prune refuses when the running session holds any live worker session. Prune refuses when the named session appears in the parent chain of the running session. A parent chain is the recorded list of sessions that a session adopted state from.

Prune refuses when any surviving session in the project names the target in its own parent chain. Prune refuses when the target owns a pending handoff record that another session could still adopt. The user can lift that last refusal by naming the record in the confirmation as well.

Rejected alternative: a liveness file that each session writes and removes. A crashed session leaves a stale file, and the guard then blocks forever or gets ignored. Rejected alternative: trusting the recorded worktree path or branch label to decide liveness. Those two fields are display evidence only, and this design never follows either one as a path.

### Decision 4: confirmation needs a real answer from a real channel

The host offers blocking dialog primitives. A dialog blocks the command handler in an interactive terminal session. It also blocks in remote-procedure-call mode, which is the mode where another program drives the agent over a message channel. In every other mode the host installs no-operation dialogs. Those dialogs return a negative answer or an empty answer at once, without asking anybody.

Prune therefore treats a default answer as a refusal and never as consent. Prune first checks that dialog-capable user interface exists. When no such channel exists, prune refuses, reports that it needs an interactive session, and removes nothing. When the channel exists, prune prints the full row of the target session and asks the user to type the exact session name.

An empty answer aborts the run. A cancelled dialog aborts the run. A timed-out dialog aborts the run. A mismatched name aborts the run. Only an exact match of the target session name allows the run to continue.

Rejected alternative: treating a negative or empty dialog result as an unknown answer and continuing. The no-operation dialogs make that design delete data in a non-interactive run, with nobody asked. Rejected alternative: a yes-or-no confirmation. A single keystroke is too cheap for an unrecoverable action, and a typed name proves that the user read the target row. Rejected alternative: a custom terminal component. That primitive works in the terminal mode only, and prune would then have no path in remote-procedure-call mode.

### Decision 5: atomicity and recovery use a tombstone rename

The command renames the session directory to a tombstone name after confirmation. The rename is the commit point. Content deletion follows the rename. The command reports a leftover tombstone on any later run, and it can complete that leftover on request.

Rejected alternative: a direct recursive delete. A crash then leaves a half deleted session directory that still looks like a real session to every reader. Rejected alternative: a trash directory outside the project. That design moves user data across a containment boundary, and the containment rules exist to stop exactly that movement.

### Decision 6: the deletion validation predicate is a fixed ordered gate

The prune command runs these gates in this order. It refuses at the first failure and it reports the reason.

1. The project must be trusted. This gate runs first, before any other work.
2. The run mode must offer dialog-capable user interface. This gate runs before any path work, so a non-interactive run stops early and reads no directory.
3. The supplied name must match the session name grammar.
4. The corpus root must resolve to itself, and it must be a real directory.
5. The project directory must resolve to itself, must be a real directory, and must not be a symbolic link.
6. The project key must derive from a repository location that lies inside the current working tree.
7. The session directory must sit directly inside the validated project directory.
8. The session metadata must parse, and its recorded identity must match the identity the command resolved for that name.
9. The session directory content must match an expected entry allowlist. An allowlist is the fixed set of names that a session directory may hold. An unexpected entry makes the command refuse and report the entry.
10. Every entry count must stay inside a fixed bound.
11. The user must confirm by typing the exact session name.

Rejected alternative: a single containment string comparison. A string comparison accepts a path whose parent is a symbolic link, and it therefore permits deletion outside the corpus. Rejected alternative: a recursive delete over whatever the directory happens to hold. That design deletes an attacker planted entry without a word. Rejected alternative: placing the mode gate last, next to the dialog. A late gate reads the corpus for a run that can never proceed.

### Decision 7: the legacy layout is never pruned

An older slate version kept artifacts in a flat directory inside the working tree. Existing decisions keep that layout readable so that a user can still restore from it. Prune refuses any legacy path. The listing command may report that a legacy layout exists, and it reports no legacy row as a prune target.

Rejected alternative: pruning legacy artifacts once a corpus session exists. That design deletes the only copy of older evidence, and no approved decision authorises it.

### Decision 8: listing and prune ship as two tracks

Track 04d delivers listing. Track 04f delivers prune. Track numbering is append only, and 04e already names the handoff-guidance track, so the prune track takes 04f. This single amendment approves both designs together. The prune design stays approved as written even though it lands in a later track.

Reason: listing is read only, and its worst failure is a wrong report. Prune destroys user data, and its worst failure is unrecoverable. The two commands need different review depth and different test depth. Listing also gives the reviewer of the prune track a way to inspect the corpus before and after a deletion. Landing listing first therefore makes the prune review cheaper and safer.

Rejected alternative: one track for both commands. A single review then mixes a low-risk report with an unrecoverable delete. Review attention then goes to the larger surface rather than to the more dangerous one.

## Risks

Blocker class hazards and their guards follow.

- A symbolic link in the project path lets a delete escape the corpus. Gate 4 and gate 5 require each directory to resolve to itself before any removal.
- A hostile repository file can steer the project key to a foreign project. Gate 6 requires the derived key to lie inside the current working tree.
- The corpus records no liveness marker. Decision 3 derives liveness from the running session state and from the live worker set instead.
- Deleting a session that a later session adopted from destroys the evidence the later session still reads. Decision 3 refuses when any surviving parent chain names the target.
- A non-interactive run receives a negative dialog answer without asking anybody. Gate 2 and Decision 4 make that answer a refusal.

High severity hazards and their guards follow.

- An unbounded recursive delete removes anything present. Gate 9 and gate 10 replace it with an allowlist and a bound.
- Several working trees share one project directory. The prune command scopes itself to the project of the current working tree, and the confirmation shows the recorded worktree path of the target.
- A live worker still appends to a transcript. Decision 3 refuses while any worker session is live.

Accepted residual risks follow.

- Two prune runs in different processes can race. The tombstone rename is the single commit point, so the loser finds no directory and reports that. A full lock is deferred because it adds a new failure mode of its own.
- A crash between rename and content deletion leaves a tombstone. The next run reports it. Slate never removes it silently.
- A concurrent writer in another process can create a file during the run. The gates read the directory again before the rename, and a change makes the command refuse.
- A remote-procedure-call host can answer the dialog with the exact name on its own. Prune cannot tell a program from a person on that channel. The host already holds full command authority, so this adds no new power.
- Case insensitive filesystem behaviour stays untested here. The tested platform is Linux. The name grammar and the identity match limit the blast radius.
- Windows reserved names and path rules stay untested. The existing label sanitizer already rejects reserved names.

## Scope boundary for Track 04d

In scope: one listing command, its bounded scan, its report rows, its refusal reporting, and its tests.

Out of scope: any deletion. Track 04d writes no byte to the corpus and removes no byte from it. Out of scope: the tombstone protocol, the confirmation flow, the deletion predicate, and every prune guard. Out of scope: cross project listing. Out of scope: any usage counter or report that leaves the machine. This track sends no telemetry.

## Scope boundary for Track 04f

In scope: one prune command, its ordered gates, its confirmation, its tombstone rename, its tombstone recovery, and its tests.

Out of scope: automatic pruning of any kind. No timer, no startup hook, and no age trigger appears in this track. Age remains advisory reporting only, and it never authorises a deletion.

Out of scope: adoption changes. Adoption stays non destructive, and an old record stays adoptable. Out of scope: cross project prune, corpus wide sweep, and legacy layout prune. This track sends no telemetry.

## Open questions with recommended answers

Each question below carries a recommendation. The user can approve the recommendation or override it.

1. Does a user need a way to prune a pending handoff record alone, without its session directory? Recommendation: no, not in Track 04f. Reason: a record alone is small, an old record must stay adoptable, and a second deletion target doubles the guard surface for little gain.
2. Should the listing command report an unreadable session directory as a row with a defect note, or omit it? Recommendation: report it with a defect note. Reason: an omitted row hides a real corpus problem, and the listing command exists to show the user what is there.
3. Should the listing command report sessions of other working trees that share the project directory? Recommendation: yes, and mark each such row as out of scope for prune. Reason: the directory really holds them, and a hidden row makes the later prune refusal look like a defect.
4. What is the correct entry bound for a session directory? Recommendation: measure the largest real session in the dogfood corpus, then set the bound at a generous multiple of that count. Reason: a bound chosen without measurement either refuses real work or permits a hostile directory.
5. Should the tombstone recovery run as part of the listing command? Recommendation: no. Listing stays read only, and it reports a leftover tombstone as a row. Recovery stays in the prune command. Reason: a read-only command that sometimes deletes is the exact confusion this split avoids.

## Verification plan for Track 04d

- Unit tests for the listing scan: an empty project, a project with several sessions, a malformed metadata file, an entry count above the bound, and a symbolic link where a session directory belongs.
- A test that the command reports a legacy layout without offering it as a target.
- A test that the command writes nothing and removes nothing in every case above.
- The repository patch coverage gate on the changed code, with both the line floor and the branch floor met.
- A manual interactive session that runs the command against a real corpus copy, because command registration has no automated net.

## Verification plan for Track 04f

- Unit tests for each gate of the prune predicate, one test for each refusal, each asserting that nothing was removed.
- A test for the mode gate with no dialog-capable interface, asserting refusal and no directory read.
- Tests that a negative dialog answer, an empty answer, a cancelled dialog and a mismatched name each remove nothing.
- Unit tests for the live session guard, the live worker guard, and each parent chain guard.
- Unit tests for the tombstone protocol: a clean run, a simulated crash after the rename, and a recovery run.
- A test that a legacy path is always refused.
- The repository patch coverage gate on the changed code, with both the line floor and the branch floor met.
- A manual interactive session that runs the command against a real corpus copy, because the confirmation dialog has no automated net.

## Acceptance condition for Track 04d

Track 04d is accepted when a user can list every session of the current project with the approved field set. The command must refuse with a clear reason instead of guessing on every malformed or oversized input. The command must remove nothing in every case. Every test above must pass, and the full repository check set must pass.

## Acceptance condition for Track 04f

Track 04f is accepted when a user can delete one named session after typing that name in a real dialog. Every gate above must refuse with a clear reason instead of guessing. A run without a dialog-capable interface must refuse and remove nothing. No code path may delete a corpus session without an explicit user request. Every test above must pass, and the full repository check set must pass.

## Relationship to the previously approved design

Two parts change the previously approved design.

- The track split changes it. The earlier draft carried one track with both commands and offered a split as a recommendation. This amendment records the accepted split and names Track 04f for prune.
- The confirmation decision changes it. The earlier draft asked the user to type the session name and said nothing about a run without a real dialog channel. This amendment adds an explicit refusal for that case, and it states that a default dialog answer is never consent.

Everything else only adds detail.

- The gate list gained the mode gate and the confirmation gate, and the earlier gates kept their order. Their numbers moved because two entries joined the list.
- The risk list gained one blocker entry for the non-interactive run and one residual entry for a host that answers its own dialog.
- The scope boundary, the verification plan and the acceptance condition split into one set for each track. The content of each item is unchanged in substance.
- The five open questions gained a recommended answer each. The questions themselves are unchanged and still need user approval.
- The deletion set, the command interface, the lineage protection, the tombstone protocol and the legacy policy are unchanged.

---

## Evidence note (separate from the design body)

Verified in the pinned SDK inside `dogfood-sources/node_modules/@earendil-works/pi-coding-agent` at version 0.83.0.

- `ExtensionUIContext` declares `select`, `confirm` and `input` as promise-returning dialogs (`dist/core/extensions/types.d.ts:68-74`).
- `ExtensionContext.mode` carries the comment "Use \"tui\" to guard terminal-only UI" (`types.d.ts:212-213`). `hasUI` carries the comment "true in TUI and RPC modes" (`types.d.ts:214-215`).
- `noOpUIContext` returns `confirm` as `false`, `input` as `undefined` and `custom` as `undefined` (`dist/core/extensions/runner.js:88-103`). That object backs the non-interactive modes, so a default answer is not consent.
- Corpus and prune facts from the earlier episode remain unchanged: `extension/corpus.ts:100-190` for project resolution, `corpus.ts:290-311` for the session layout, `corpus.ts:350-356` for the unguarded removal primitive, and `handoff-record.ts:542-606` for the bounded-scan model.


## Decision Log (continued)

- D246: The approved design splits session listing into Track 04d and explicit prune into Track 04f. Track 04f uses append-only numbering because Track 04e already occupies the intervening number. Rejected: one combined track, which mixes read-only reporting with unrecoverable deletion.
- D247: Track 04f deletes only the target session unit and its matching pending handoff record. It never deletes another session, project directory, corpus root or unowned staging directory. Rejected: global unreferenced sweeps and category-only deletion, which can destroy needed evidence or leave partial sessions.
- D248: The interface has a no-argument listing command and a single-name prune command with preview mode. Prune has no force flag, age filter, pattern argument or multiple-target form. Rejected: batch deletion and force bypasses, which multiply mistakes and defeat confirmation.
- D249: Prune protects the live session, live workers, parent chains, surviving child lineage and adoptable pending handoffs before deletion. It derives protection from session state and lineage, not recorded worktree or branch display fields. Rejected: stale liveness files and display-field liveness guesses.
- D250: Prune requires a dialog-capable channel and exact session-name confirmation. Non-interactive modes refuse before directory reads, and negative, empty, cancelled, timed-out or mismatched answers remove nothing. Rejected: default consent, yes-or-no prompts and terminal-only custom components.
- D251: Confirmation commits deletion by renaming the session directory to an in-project tombstone. Content deletion follows the rename, and later prune runs report and can finish leftovers. Rejected: direct recursive deletion and an external trash directory.
- D252: The ordered prune gate runs trust, dialog capability, name grammar, corpus root, project directory, project-key containment, direct session placement, metadata identity, entry allowlist, entry bounds and exact-name confirmation. It stops at the first failure and reports that reason.
- D253: Track 04f never prunes legacy layout paths. Track 04d may report legacy layout presence, but it never offers legacy data as a prune target. Rejected: deleting older evidence after a corpus session exists.
- D254: Track 04d and Track 04f each require their approved unit tests, patch line and branch coverage, and a manual interactive corpus-copy run. Track 04f also verifies every refusal, lineage guard, tombstone crash and recovery path.
- D255: The user accepted the recommended answers to all five open questions. Track 04f does not prune a pending handoff alone, listing reports unreadable sessions with defect notes, listing includes other working trees with prune exclusion marks, the entry bound follows measured corpus size, and listing only reports tombstones.

Design review (pre-adversarial): user-approved — 2026-08-21

### Track 04d and Track 04f first-round adversarial triage

Adversarial review: 3 reviews, 26 findings, 10 blocker-class findings — 2026-08-21

Reversals.

- R1: Prune is removed from this change and moves to tracker issue 245. Track 04d no longer carries tombstones, deletion, recovery or prune confirmation. Evidence: `t164.e1` (`.pi/slate/observations/t164.e1.md`), `t165.e1` (`.pi/slate/observations/t165.e1.md`) and `t166.e1` (`.pi/slate/observations/t166.e1.md`).
- R2: The earlier cross-process liveness guard is withdrawn from Track 04d. It becomes a prerequisite for any future prune design because process-local state cannot protect a sibling process.
- R3: The earlier enumerable-lineage guard is withdrawn from Track 04d. It becomes a prerequisite for any future prune design because session-entry parent chains are not corpus-enumerable.
- R4: Gate 6's prune-specific current-working-tree containment claim is withdrawn from Track 04d. Listing does not authorize deletion and does not need that prune gate.

Accepted residual risks.

- A listing scan is best effort while sessions, handoffs or tombstones change concurrently. It reports the observed bounded result and does not claim an atomic snapshot.
- A future prune design remains blocked until the corpus exposes cross-process liveness and enumerable lineage. Track 04d accepts neither capability by guessing.
- A bounded listing can refuse an oversized or hostile corpus instead of doing unbounded work. The refusal is safer than silently truncating rows.

Strengthened items.

- The revised listing design adds explicit scan, aggregate-metadata and session-entry bounds, with refusal or defect reporting at each boundary. Evidence: `t168.e1` (`.pi/slate/observations/t168.e1.md`) and `t169.e1` (`.pi/slate/observations/t169.e1.md`).
- The revised listing design orders trust and schema validation before display, defines field sanitization and foreign-worktree markers, and distinguishes pending-record validity and duplicate identities.
- The revised listing design states that it performs no writes, exposes no prune capability, and requires tests for bounds, malformed data, duplicate identities and display safety.

### Track 04d second-round review record

Second-round review: `t168.e1` (`.pi/slate/observations/t168.e1.md`) and `t169.e1` (`.pi/slate/observations/t169.e1.md`). The revised listing-only design resolved the first-round prune withdrawal and several consistency gaps. Two blockers and several should-fix findings went back into a further design revision. No listing-only design text is appended here while that revision remains under review.

## Decision Log (continued)

- D256: Decisions D130 and D246 through D255 are superseded for prune ownership. Prune now lives in tracker issue 245, `Prune one corpus session explicitly`, with no reserved track number. The track number is never reused.
- D257: Any future prune design must first provide two corpus-visible prerequisites: cross-process liveness and enumerable lineage. Process-local state and hidden session-entry parent chains cannot satisfy either prerequisite.
- D258: Track 04d now delivers listing only. It must not delete, rename, recover or confirm corpus sessions, and it must not reintroduce a prune command while the separate prune issue remains open.


### Approved amendment: Track 04d listing only

# Track 04d high-level design amendment: corpus session listing

## Goal

Slate stores its work evidence in a corpus. A corpus is the private directory tree where slate keeps one directory for each project and one directory for each session. Today no command shows a user what that corpus holds. A user therefore cannot pick a past session by name, because a session name carries no description.

Track 04d adds one command. That command lists the sessions of the current project and reports one row for each session that it reads. The command reads only. It deletes nothing, and it writes nothing into the corpus.

## Approach

The command checks project trust first. It then locates the project directory of the current working tree with a bounded root walk. It then walks that project directory with a bounded scan. A bounded scan reads directory entries one at a time and counts them. It stops at a stated limit instead of loading a whole directory into memory.

For each entry that matches the session name grammar, the command reads the session metadata under a per-file byte ceiling. It validates the record against a named field set. Only a validated record supplies a display value.

The command then prints one row for each session that it read. Each row carries the session name, the durable session identity, the recorded branch label, the recorded worktree path, and the creation time. Each row also reports whether a pending handoff record file exists for that session. A pending handoff record is the file an author session writes so that a later session can adopt its state.

Every displayed value passes through one strict row-cell rule. The command marks a row whose recorded directory sits outside the current working tree. It reports a damaged session as a row with a defect note. It closes with a plain statement that the report is a sequential best-effort reading.

## Key decisions

### Decision 1: the trust gate runs first, and validation precedes any display use

The command checks project trust before any other work. It then resolves the corpus root and the project directory of the current working tree. It reads each candidate session metadata record and validates it. Only then does it use a recorded value, and it uses each value for display alone.

Rejected alternative: using a recorded value before validation. A malformed record then drives further work, which the approved validation order forbids. Rejected alternative: skipping the trust check because the command only reads. Reading a project directory is still project-derived work, and the existing candidate listing gates the same read on trust.

### Decision 2: every read the command performs is bounded

The command performs four kinds of read. Each one carries a bound. No read on this path loads a whole directory into memory.

**Corpus root walk.** The command walks the corpus root one entry at a time. It keeps only an entry whose name ends with the project digest. A project digest is the short hash that binds a project directory to its repository. Memory therefore stays bounded whatever the root holds.

The walk scans at most 4096 entries. It refuses the whole run when it reaches that count, and it reports the reason.

**The two directory reads have different overflow rules, and the reason is their different jobs.** The root walk answers an identity question. It must find the one directory that matches the current project, and it must also prove that no second directory matches. A truncated walk proves neither. The existing resolver already refuses when two directories share one digest. A missed second match would therefore make the command report one project while another exists.

The project scan answers a very different question. It enumerates sessions, and a partial enumeration is still a useful report when the command says how much it left out.

**Project directory scan.** The command reads metadata for at most 4096 entries of the project directory. It then stops reading rows. It continues to walk the remaining names, counting them and retaining nothing, so memory stays constant. The counting walk stops at 65536 entries.

The command then prints the rows that it did read. It adds one line that states the truncation, the number of entries it read, and the exact number of entries it did not read. It says at least that number when the counting walk hit its own bound. It does not refuse the run.

**Session metadata read.** The command holds a descriptor on each metadata file. It reads the size from that same held descriptor. It then requests at most 65537 bytes from that same descriptor, which is the ceiling plus one byte. A file that supplies more than 65536 bytes yields a defect-note row, and the command reads nothing further from it.

The ceiling therefore bounds the read itself and not only the size check. A file that grows between the size check and the read still cannot make the command allocate more than the ceiling plus one byte. The same rule covers the pending record file, which the command also reads under a held descriptor and the same ceiling.

The command adds each accepted size to a running total as the scan proceeds. It refuses the whole run when that running total would exceed 4 MiB.

**Session directory entry count.** The command counts the top-level entries of one session directory and stops counting at 65. A count above 64 yields a defect-note row for that session only.

Bound comparisons are exact. The root walk accepts entries 1 through 4096 inclusive, and entry 4097 refuses the run. The project scan reads rows for entries 1 through 4096 inclusive, and entry 4097 starts the counting walk. The counting walk reports an exact number up to 65536 further entries, and it says at least 65536 beyond that.

A metadata record of exactly 65536 bytes is accepted, and 65537 bytes is not. A running total of exactly 4 MiB is accepted, and one more byte refuses the run. A session directory with exactly 64 top-level entries is healthy, and 65 is a defect.

Measured basis: the largest real corpus session in the live dogfood corpus holds four top-level entries, and the largest real metadata record holds 286 bytes. The session layout is fixed at four entries, so 64 leaves a sixteen-fold margin for a future category. The per-file ceiling leaves a margin above 200-fold. The measurement uses real corpus sessions only.

The legacy flat layout is not the basis. That layout holds hundreds of files in one flat directory, and it has a different shape. A bound derived from it would not describe a corpus session directory.

Rejected alternative: an unbounded directory read, which the shared project resolver still performs. A damaged root then costs unbounded time and memory before any stated bound applies. Rejected alternative: a truncated root walk that continues with the first match. That walk cannot prove that a second matching directory is absent, so the command would report one project while another exists.

Rejected alternative: a whole-run refusal for the project scan bound. A user cannot shrink a corpus while prune is unavailable, so that user would lose the only report available. Rejected alternative: a size check followed by an unbounded read. A file that grows after the check then defeats the ceiling. A held descriptor alone does not bound the bytes that a full read returns.

### Decision 3: session start behaviour does not change

The shared project resolver runs at session start. This amendment adds no refusal to that shared path. A normal session must never fail to start because a corpus root grew large. The bounded root walk of Decision 2 therefore belongs to the listing command alone.

Rejected alternative: bounding the shared resolver. A refusal there stops a session from starting, which is a worse outcome than a slow listing command. Rejected alternative: leaving the listing path on the shared unbounded read. The listing command then inherits an unbounded read that no bound of its own can contain.

### Decision 4: one display rule covers every field

Every value that reaches the terminal passes through one row-cell rule. That rule removes each character that does not render, taken by Unicode category rather than by a hand-written list. The removed categories are the control characters, the format characters, the line separator, the paragraph separator, and an unpaired surrogate. The rule then caps the length of each value.

The line separator and the paragraph separator matter here. The terminal wrapper breaks lines on carriage return and line feed only, and it passes both separators through. A recorded branch label carrying a line separator can therefore forge an extra visual row. The repository already records that failure and already answers it with a category-based rule for its doctrine table. This design reuses that stricter rule, and it does not reuse the softer notification rule.

The rule covers the session name, the identity, the branch label, the worktree path, the creation time, each marker, and each defect note. No field is exempt.

Rejected alternative: the existing notification sanitizer. That helper leaves the line separator and the paragraph separator intact, so a forged row survives it. Rejected alternative: a hand-listed set of forbidden characters. Three earlier attempts in this repository each missed a member, and Unicode keeps adding members. Rejected alternative: an allowed-character list. Real values legitimately carry non-ASCII text, which such a list would mangle.

### Decision 5: recorded worktree and branch values are display evidence only

The recorded worktree path and the recorded branch label are display fields. The command never opens them, never resolves them, and never derives a path from them.

The command marks a row whose recorded directory sits outside the current working tree. It resolves the working tree root of the current checkout for that comparison, and it does not compare against the current directory. A session started in a subdirectory of this checkout is therefore not marked. Several working trees of one repository share one project directory, so a marked row describes a real session of another checkout.

The marker states only the fact it can prove. Its wording is that the session started outside this working tree. It makes no claim about that session's state, and it makes no claim about any future command.

Rejected alternative: comparing the recorded directory with the current directory. A session started in a subdirectory of the same checkout is then marked wrongly. Rejected alternative: omitting such a row. The directory really holds that session, and a hidden row makes later behaviour look like a defect.

### Decision 6: the validated metadata field set is named

A validated record carries these fields.

- Identity: a string that matches the durable session identity grammar. An absent, empty or non-matching identity yields a defect-note row. Slate can create an empty identity for a legacy session, so this case is real and not hypothetical.
- Name: a string that must equal the directory name exactly. Any difference yields a defect-note row.
- Creation time: a string in the standard timestamp format. A malformed value yields a defect-note row, and the row still reports the other fields.
- Worktree path: a string, display only.
- Branch label: a string, which may be empty. An empty label displays as a stated placeholder.
- Pi session name: an optional string, display only.

A value of the wrong type in any field yields a defect-note row. An unknown extra key is ignored and never displayed, so a newer slate version can add a field without breaking an older listing command.

Two session directories can both validate and both claim one identity. That state yields a defect note on both rows. Existing state recovery treats it as fatal.

Rejected alternative: the current loose check, which accepts a wrong type in every field except the identity. A wrong type then reaches later formatting and can throw. Rejected alternative: refusing an unknown key. A forward-compatible field would then break the command.

### Decision 7: the pending marker reports a file, not an adoptable record

The pending marker reports one of three states. The states are absent, present and unreadable. A present state means that a record file exists under the expected name for that session. It makes no claim that the record validates, and it makes no claim that adoption would succeed.

A record file that the command cannot read, or that fails record validation, yields the unreadable state and a defect note on that row. A record file above the byte ceiling of Decision 2 yields the same unreadable state. The command does not attempt adoption and does not evaluate any adoption gate.

Rejected alternative: reporting an adoptable state. Adoption validates the record, the worktree and the branch at the moment of adoption, so a listing claim would go stale at once. Rejected alternative: reporting presence alone with no unreadable state. A damaged record then looks identical to a healthy one.

### Decision 8: a whole-run refusal and a defect-note row are different outcomes

A whole-run refusal prints no rows. It prints one reason line, and it exits without a report. Its causes are an untrusted project, an unresolvable corpus root and an unresolvable project directory. Three more causes are a root walk that reached its bound, a running metadata total above 4 MiB, and a failed read of the project directory.

A defect-note row prints inside a normal report. The run continues, and every other row still prints. Its causes are an unreadable session directory, a missing metadata file, a failed field validation and an empty or absent identity. Its further causes are a metadata record above the per-file ceiling, a top-level entry count above 64 and a duplicate identity. Its last three causes are an unreadable pending record, a symbolic link where a session directory belongs, and a read failure on one entry.

A truncated report is a third outcome. It prints rows, and it adds one line that states the truncation, the number of entries read and the number of entries not read. Its only cause is a project scan that reached its row bound.

An input or output failure follows the same split. A failure while reading one entry yields a defect-note row for that entry, and the run continues. A failure while reading the project directory itself refuses the whole run. No further row can be trusted then, and the command cannot know what it missed.

Rejected alternative: treating every validation failure as a refusal. One damaged session then hides every healthy row. Rejected alternative: treating every failure as a row. A missing project directory has no row to carry the note. Rejected alternative: letting a directory read failure produce a normal report. That report would look complete while an unknown number of sessions went unseen.

### Decision 9: the report is a sequential best-effort reading

The command takes no lock. It holds no exclusive access to the project directory. The scan is sequential, so the command reads each row at a different moment. It never observes one coherent instant.

The closing line says exactly that. It states that the command read each row at a different moment. It states that another process may have changed the corpus during the scan. It states that no line describes a single instant. It makes no claim of a snapshot.

Rejected alternative: claiming a coherent snapshot, or saying that the report describes one moment. Both claims are false, because two rows can report states that never coexisted. Rejected alternative: taking a lock for the scan. A read-only report does not justify blocking a live session that wants to write. Rejected alternative: refusing when the directory changes during the scan. A busy project would then never produce a report.

### Decision 10: named documents ship with the command

Four documents change in the same delivery as the command.

- The root README file gains the command and its output shape for users.
- The user notes document under the docs directory gains the command in its user-facing command list.
- The AGENTS contributor guide gains the command and its re-run trigger.
- The verification README file gains the new checks and the manual corpus-copy run.

Rejected alternative: deferring the documentation to a later track. The shipped text then states something untrue from the day the command lands. Rejected alternative: naming document categories only. Two contributors then update different files, and a stale page survives.

## Risks

Guarded hazards and their guards follow.

- A damaged corpus root costs unbounded time and memory. Decision 2 walks the root one entry at a time and keeps only matching names.
- A metadata file grows between a size check and a read. Decision 2 requests at most the ceiling plus one byte from the held descriptor.
- A pending record file grows the same way. Decision 2 applies the same ceiling to it, and Decision 7 reports it as unreadable.
- A second project directory hides past the root bound. Decision 2 refuses the run on a root overflow.
- A read failure hides an unknown number of sessions. Decision 8 refuses the run on a directory read failure.
- A recorded value forges an extra visual row. Decision 4 removes the line separator and the paragraph separator with every other non-rendering category.
- A malformed record reaches later formatting. Decision 6 names every field and its type.
- A large legitimate corpus loses its only report. Decision 2 truncates the project scan instead of refusing the run.
- A session started in a subdirectory looks foreign. Decision 5 compares against the working tree root.
- A damaged pending record looks adoptable. Decision 7 reports presence only.
- A duplicate identity passes unnoticed. Decision 6 marks both rows.
- An untrusted project supplies the directory content. Decision 1 checks trust first.

Accepted residual risks follow.

- A concurrent writer can make one row stale, or can hide one new session. Decision 9 accepts this and states it in the output.
- A concurrent removal between enumeration and metadata reading produces a defect row for a session that no longer exists. The row is honest about what the command saw.
- A project above the row bound cannot show every row. The truncation line names the exact number of entries that the command did not read, so the user learns the size of the gap. The user cannot close that gap today, because prune is not available to reduce the corpus. A continuation mechanism is future work, and this design does not pretend otherwise.
- A session that the command marks as damaged stays damaged. This track has no repair path and no deletion path, by design.
- The shared project resolver keeps its unbounded root read for session start. Decision 3 accepts that on purpose, because a refusal there stops a session from starting.
- Case insensitive filesystem behaviour stays untested. The tested platform is Linux. The command only reads, so a name collision produces a wrong row and no data loss.
- Windows path rules stay untested. The same read-only reasoning applies.

## Scope boundary

In scope: one listing command, its trust gate, its bounded root walk and its bounded project scan. Also in scope: its per-file and aggregate byte bounds, its named field set, its row-cell display rule, and its markers and defect notes. Its truncation line, its best-effort statement, its tests and its four document updates are in scope too.

Out of scope: deletion of any kind. This track removes no byte from the corpus. Out of scope: any write to the corpus. The command creates no directory, no file and no marker.

Out of scope: pruning, tombstones, confirmation dialogs, deletion gates and legacy layout deletion. Out of scope: any change to session start behaviour. Out of scope: cross project listing, pagination, and a separate row for a pending record with no session. Out of scope: any usage counter or report that leaves the machine. This track sends no telemetry.

## Carried implementation requirements

Four items stay open as specification detail. Each one is a code-review obligation rather than a design choice, and the code review verifies all four.

- The exact accepted format of the creation-time value. The writer emits one fixed form today, and the reader must accept that form and reject a looser one.
- The exact rule that derives the pending record name from the session name. The command derives that name and never scans for a match.
- The exact display cap for each cell of a row.
- The rule that a cap must never make two different sessions look identical. A cap that removes a distinguishing part of a name or an identity is a defect.

## Where prune went, and what it needs first

Prune leaves this design. It now lives in tracker issue 245. It holds no track number, and no track number is reserved for it.

This reverses two earlier positions. One earlier decision assigned both listing and prune to Track 04d. A later group of decisions approved a numbered prune track with its interface, its guards, its tombstone protocol, its legacy policy and its verification. This amendment supersedes all of them. The research log therefore needs a new recorded decision that states the reversal. This amendment is not internally consistent with the log until that decision exists.

Prune also needs two corpus capabilities that do not exist today. Neither one belongs to this track.

- Cross-process liveness in the corpus. A session records no liveness marker today, and liveness lives in the private memory of one process. A second process therefore cannot tell that a session is running. Prune cannot refuse a live target without a corpus-visible marker.
- Enumerable lineage in the corpus. A session records no parent chain today, and a parent chain lives inside a pi session snapshot. A successor that adopted state and never published its own handoff record is invisible to a corpus scan. Prune cannot refuse an ancestor without corpus-visible lineage.

The earlier prune design and every review finding stay on the tracker issue as input. This amendment approves none of that mechanism.

## Verification plan

Trust and resolution:

- A refusal for an untrusted project.
- A refusal when the project directory cannot be resolved.

Bounded reads:

- A corpus root holding many unrelated project directories, asserting a completed run and bounded retained state.
- A root walk that reaches its bound, asserting a whole-run refusal with a reason, whether or not a match was already found.
- A second matching project directory placed past the root bound, asserting the same refusal rather than a report about the first match.
- A project scan that reaches its row bound, asserting printed rows, a truncation line, the number read and the exact number not read.
- A project scan whose counting walk reaches its own bound, asserting the at-least wording instead of an exact number.
- A metadata record of exactly the per-file ceiling, asserting acceptance.
- A metadata record one byte above the ceiling, asserting a defect-note row and no further read.
- A metadata file that grows after the size check, asserting a defect-note row and an allocation no larger than the ceiling plus one byte.
- A pending record file above the ceiling, asserting the unreadable state and a defect-note row.
- A pending record file that grows after the size check, asserting the same outcome.
- A running metadata total one byte above 4 MiB, asserting a whole-run refusal.
- A session directory with exactly 64 top-level entries, asserting a healthy row.
- A session directory with 65 top-level entries, asserting a defect-note row and a completed run.

Session start:

- A large corpus root, asserting that session start still succeeds and gains no refusal.

Failure classification:

- A read failure on one session entry, asserting a defect-note row and a completed run.
- A read failure on the project directory itself, asserting a whole-run refusal.

Carried requirements, verified in code review:

- The accepted creation-time format, asserting that the writer form is accepted and a looser form is not.
- The derived pending record name, asserting that the command derives it and never scans for a match.
- The per-cell display cap, asserting the stated value.
- Two sessions whose names differ only past the cap, asserting that the rows stay distinguishable.

Display:

- A branch label carrying a line separator, asserting one output row.
- A branch label carrying a paragraph separator, asserting one output row.
- Control bytes in every displayed field, asserting a sanitized output.
- An over-long value in every displayed field, asserting the length cap.

Field set:

- A wrong type in each named field, asserting a defect-note row for each.
- An absent identity and an empty identity, asserting a defect-note row for each.
- A name that differs from the directory name, asserting a defect-note row.
- A malformed creation time, asserting a defect-note row that still reports the other fields.
- An unknown extra key, asserting a normal row that never displays the key.
- Two directories claiming one identity, asserting a defect note on both rows.

Markers and pending state:

- A session recorded in a subdirectory of this checkout, asserting no foreign marker.
- A session recorded outside this checkout, asserting the foreign marker and its exact wording.
- An absent pending record, asserting the absent state.
- A present and valid pending record, asserting the present state.
- A pending record that fails validation, asserting the unreadable state and a defect note.
- A pending path that is a directory, a link or a non-regular file, asserting the unreadable state.

Outcomes and honesty:

- A missing metadata file, a malformed record and an unreadable session directory, each asserting a defect-note row.
- A symbolic link where a session directory belongs, asserting a defect-note row.
- A session appearing during a scan, asserting a completed run.
- The output carries the sequential best-effort statement, and it claims no single moment.
- The command writes nothing and removes nothing in every case above.

Repository nets:

- The patch coverage gate on the changed code, with both the line floor and the branch floor met.
- A manual interactive session against a real corpus copy, because command registration has no automated net.

## Acceptance condition

Track 04d is accepted when the conditions below all hold.

- A user can list the sessions of the current project with the approved field set.
- Every read the command performs is bounded, and each bound behaves exactly as Decision 2 states.
- A root overflow refuses the run, and a project row overflow truncates the report with an exact count of the entries not read.
- Every byte ceiling bounds the read itself, for a metadata record and for a pending record alike.
- Session start gains no new refusal.
- Every displayed value passes the row-cell rule, including both Unicode separators.
- Every named field is validated by type, and each failure yields a defect-note row.
- The foreign marker compares against the working tree root and states only the fact it proves.
- The pending marker reports absent, present or unreadable, and never claims adoptability.
- A duplicate identity marks both rows.
- A whole-run refusal, a defect-note row and a truncated report behave as Decision 8 states.
- A read failure on one entry produces a row, and a read failure on the directory refuses the run.
- The code review confirms all four carried implementation requirements.
- The output states that the report is a sequential best-effort reading.
- The command writes nothing and removes nothing in every tested case.
- The four named documents describe the command.
- Every test above passes, and the full repository check set passes.

## Relationship to the previously approved design

Four parts change the previously approved design.

- Prune leaves the design and moves to tracker issue 245, with no track number. This supersedes the earlier decision that gave prune to Track 04d, and it supersedes the later decisions that approved a numbered prune track. A new recorded decision is still needed.
- Every prune mechanism leaves the design. The ordered deletion gates, the confirmation flow, the tombstone protocol, the deletion set and the legacy no-prune rule are all gone. The legacy layout needs no rule here, because this track deletes nothing anywhere.
- The project scan row bound no longer refuses the run. It truncates the report, and it states both the number read and the exact number not read. The root walk bound now refuses the run instead, because that read must prove that no second project directory matches.
- Documentation joins the scope, and this amendment names the four documents.

The remaining parts add detail to the approved listing behaviour.

- The bounds now cover the root walk and a per-file ceiling, and each comparison is exact.
- Each byte ceiling now bounds the read request itself, and it covers the pending record file as well.
- An input or output failure now has a stated outcome for one entry and for the directory.
- Four carried implementation requirements are now named for the code review.
- The display rule moved from the notification sanitizer to the stricter row-cell rule, and it now covers both Unicode separators.
- The metadata field set, its types, its unknown-key policy and its identity rules are named.
- The foreign marker now compares against the working tree root.
- The pending marker now has three states.
- A duplicate identity now produces a defect note.
- The best-effort wording now says sequential reading rather than one moment.
- The outcome vocabulary now separates a refusal, a defect row and a truncation.
- The verification plan gained one case for each rule above.

The approved field set for a row is unchanged. The read-only nature of the command is unchanged. The trust-first order is unchanged. The bounded-enumeration approach is unchanged.

## Finding coverage for round three

| Finding | Now covered in |
| --- | --- |
| RG500 | Decision 2, root walk overflow rule and the paragraph on the two different jobs. Risks guarded row 4. Verification, bounded reads cases 2 and 3 |
| RG501 and SE501 | Decision 2, session metadata read and the ceiling-bounds-the-read paragraph. Decision 7 for the pending record. Risks guarded rows 2 and 3. Verification, bounded reads cases 8 to 11 |
| BG500 | Decision 2, project scan with the exact not-read count. Decision 8, truncated report. Risks residual row 3. Verification, bounded reads cases 4 and 5 |
| RG502 | Decision 8, input and output failure split. Risks guarded row 5. Verification, failure classification cases |
| BG501, WI504, WI501, RG503 | Carried implementation requirements section. Verification, carried requirements cases |
| WI500 | Where prune went, paragraph 2. Relationship section, change 1 |

## Evidence note (separate from the design body)

- Duplicate digest refusal that makes root uniqueness load bearing: `dogfood-sources/extension/corpus.ts:180-183`.
- Unbounded root read on the shared resolver path: `extension/corpus.ts:159-172`.
- Full-file metadata read with no ceiling: `extension/corpus.ts:219-230`. The held descriptor there proves identity only.
- Pending record reader that checks size after allocation: `extension/handoff-record.ts:465-467`. The existing pending path shape is `pending/<session-name>.json` at `extension/handoff-record.ts:352-354`.
- Node reads a whole file with the plain read helper, so a ceiling needs an explicit length: `@types/node/fs.d.ts:3163-3174`.
- Category-based row-cell rule that Decision 4 adopts: `extension/mode.ts:228-229`.
- Recorded start directory, not the worktree root: `extension/corpus.ts:337`. Project key from the git common directory: `extension/corpus.ts:132-137`.
- Measured basis from the live corpus: largest session directory holds 4 top-level entries, and largest metadata record holds 286 bytes.

Adversarial review: passed, 5 accepted risks — 2026-08-21
Design review (pre-implementation): user-approved — 2026-08-21

## Decision Log (continued)

- D259: Track 04d uses separate overflow rules for its two directory reads. A corpus-root walk overflow refuses the whole run because root uniqueness is unproven. A project-directory scan overflow truncates the report, counts the remaining entries within its bound, and reports the omitted count.
- D260: Track 04d applies a 65536-byte ceiling to metadata and pending-record reads by requesting at most 65537 bytes from each held descriptor. The extra byte detects overflow, and growth after size inspection cannot cause an unbounded allocation.
- D261: A project-scan truncation prints the rows already read and states both the number read and the exact number not read. If the counting walk reaches 65536 further entries, the report uses lower-bound wording for the omitted count.
- D262: A failure reading one session entry produces a defect-note row and the run continues. A failure reading the project directory refuses the whole run and prints no rows, because the command cannot know what it missed.
- D263: Code review must verify four carried requirements: the accepted creation-time format, pending-name derivation without scanning, the exact per-cell display cap, and distinct output for names or identities that differ only beyond that cap.
- D264: The user approved Track 04d after reviewing d134e09..c7589bb. The marker subject is `Track 04d complete: session-listing`.

### Track 04d review record

Round one used three perspectives. The code and test review was episode `t175.e1`, with observations at `.pi/slate/observations/t175.e1.md`. The input robustness review was episode `t180.e1`, with observations at `.pi/slate/observations/t180.e1.md`. The handoff record regression review was episode `t177.e1`, with observations at `.pi/slate/observations/t177.e1.md`. The handoff review reported no finding. The orchestrator changed none of the validated severities.

| Finding | Reviewer severity | Validated severity | Reviewer episode | Canonical observation | Current verdict |
| --- | --- | --- | --- | --- | --- |
| BG600 | should-fix | should-fix | t175.e1 | `.pi/slate/observations/t175.e1.md` | verified by t182.e1 |
| BG601 | should-fix | should-fix | t175.e1 | `.pi/slate/observations/t175.e1.md` | verified by t182.e1 |
| CQ600 | should-fix | should-fix | t175.e1 | `.pi/slate/observations/t175.e1.md` | verified by t182.e1 |
| CQ601 | should-fix | should-fix | t175.e1 | `.pi/slate/observations/t175.e1.md` | verified by t182.e1 |
| TQ600 | should-fix | should-fix | t175.e1 | `.pi/slate/observations/t175.e1.md` | verified by t182.e1 |
| TQ601 | should-fix | should-fix | t175.e1 | `.pi/slate/observations/t175.e1.md` | verified by t182.e1 |
| TQ602 | should-fix | should-fix | t175.e1 | `.pi/slate/observations/t175.e1.md` | verified by t182.e1 |
| TQ603 | should-fix | should-fix | t175.e1 | `.pi/slate/observations/t175.e1.md` | verified by t182.e1 |
| CQ602 | suggestion | suggestion | t175.e1 | `.pi/slate/observations/t175.e1.md` | open suggestion |
| CQ603 | suggestion | suggestion | t175.e1 | `.pi/slate/observations/t175.e1.md` | open suggestion |
| CQ604 | suggestion | suggestion | t175.e1 | `.pi/slate/observations/t175.e1.md` | open suggestion |
| CQ605 | suggestion | suggestion | t175.e1 | `.pi/slate/observations/t175.e1.md` | open suggestion |
| TQ604 | suggestion | suggestion | t175.e1 | `.pi/slate/observations/t175.e1.md` | open suggestion |
| TQ605 | suggestion | suggestion | t175.e1 | `.pi/slate/observations/t175.e1.md` | open suggestion |
| TQ606 | suggestion | suggestion | t175.e1 | `.pi/slate/observations/t175.e1.md` | open suggestion |
| SE600 | blocker | blocker | t180.e1 | `.pi/slate/observations/t180.e1.md` | verified by t184.e1; the later gate recorded the same directory identity defect |
| SE601 | should-fix | should-fix | t180.e1 | `.pi/slate/observations/t180.e1.md` | verified by t184.e1 |
| SE602 | should-fix | should-fix | t180.e1 | `.pi/slate/observations/t180.e1.md` | verified by t184.e1 |
| RG800 | should-fix | should-fix | t182.e1 | `.pi/slate/observations/t182.e1.md` | verified by t184.e1; same directory identity defect as the blocker row |
| RG801 | should-fix | should-fix | t182.e1 | `.pi/slate/observations/t182.e1.md` | VERIFIED by t187.e1; `.pi/slate/observations/t187.e1.md` |
| RG900 | should-fix | should-fix | t184.e1 | `.pi/slate/observations/t184.e1.md` | VERIFIED by t187.e1; `.pi/slate/observations/t187.e1.md` |

Gate one was episode `t182.e1`. It verified the eight code and test findings from the first review and raised two new should-fix findings. Gate two was episode `t184.e1`. It verified the three robustness findings and the first gate's directory identity finding, and recorded that the directory identity finding and the robustness blocker are one defect. The two remaining raised findings each received a fix, and each fix still needs a verdict.

Closure: Final gate episode `t187.e1` verified both remaining fixes. No blocker and no should-fix remains open. All four fix rounds are verified. Seven suggestions remain recorded and deferred: CQ602, CQ603, CQ604, CQ605, TQ604, TQ605 and TQ606. The prune command stays in tracker issue 245.

### Track 04d verification record

Packet result: episode `t188.e1`, canonical observation `.pi/slate/observations/t188.e1.md`, at head `c7589bb` against baseline `d134e09`.

- `npm run typecheck` passed.
- Packaging guards passed with 16 checks. The packaging self-test passed with 16 checks.
- The load check passed with 14 checks.
- Strict resolver checks passed with 223 checks and zero not-run entries.
- The full test command passed with 404 tests. The size-grade suite passed with 24 tests.
- Patch coverage reached 330 of 341 lines, or 96.77 percent, and 182 of 204 branches, or 89.22 percent. The coverage verdict was `PASS`.
- The package-content check and its self-test both passed.
- The writing-reminder integration check passed with 13 checks.
- The writing checker over the cumulative diff reported zero fail findings, one warning, zero house-style findings and 24 advisory findings.
- The whitespace check passed.
- The ladder self-test passed with 48 launcher checks.
- The full strict ladder passed every rung with zero not-run entries. Every SAFE line passed.
- The cumulative diff changed 10 files with 945 insertions and 10 deletions.

The orchestrator runs the remaining packet separately.

## Suggestions (Track 04d)

### CQ602

Suggestion: extract the duplicated cell-sanitization regular expression into shared code. It applies to `extension/corpus-list.ts` and the existing implementation in `extension/mode.ts`. The duplication matters because the two display paths can drift and enforce different safety rules. A fix needs one shared implementation that preserves the current sanitization behaviour without creating the circular import noted in the review.

### CQ603

Suggestion: use the exported `corpusHandoffFile` when constructing the pending path. It applies to the pending-record path in `extension/corpus-list.ts`. The duplicated path matters because a future handoff layout change could update one path and leave the listing command reading another. A fix needs the listing command to derive that path from the existing exported helper.

### CQ604

Suggestion: reuse the existing wire-record decode logic. It applies to the handoff record decoding in `extension/corpus-list.ts`. The duplicated decode matters because listing and adoption could diverge in how they interpret the same record. A fix needs one shared decoder or helper while preserving the listing command's read-only behaviour.

### CQ605

Suggestion: correct the identity note for a wrong-type identity. It applies to the defect message in `extension/corpus-list.ts`. The current note says that the identity is absent, although a wrong-type value is present. A fix needs wording that describes the actual validation defect without claiming absence.

### TQ604

Suggestion: add a test for a pending author-name mismatch. It applies to `test/corpus-list.test.ts`. The missing case matters because pending-name derivation and author-name validation can regress without the focused suite detecting it. A fix needs a fixture with the mismatch and an assertion for the resulting unreadable or defect outcome described by the implementation.

### TQ605

Suggestion: strengthen the collision test with names near the 240-character cap. It applies to `test/corpus-list.test.ts`. Short names do not exercise the display-cap boundary where distinct values could become indistinguishable. A fix needs long collision fixtures that reach the cap while still asserting distinct output.

### TQ606

Suggestion: test removal of pipe characters from displayed cells. It applies to `test/corpus-list.test.ts` and the row-cell sanitization path. The missing case matters because the table uses pipes as delimiters, so an unstripped pipe can forge or corrupt columns. A fix needs a fixture containing pipe characters in displayed fields and an exact sanitized-output assertion.


## Track 08 design, revision 6

Six design revisions ran. Three adversarial reviews and three gate rounds ran. The design under record is revision 6.

The user chose the simplified archive option. The user approved superseding decision D53 and decision D59. Decision D59 assumed a sanitized label, and the real path segment is an on-disk directory name that any worker can rename.

The orchestrator refinements are:

- The worker resolves the destination.
- The archive never deletes the working log.
- The archive is a required delivery step.

## Track 08 final design, revision 6

Repository: `/home/andrii0lomakin/Projects/ytdb-slate/dogfood-sources`

Branch: `dogfood-sources`

Verified head: `2c5b5708ced8a16206a4613c2171f49328a81574`

This design supersedes revision 4. It changes no repository file.

Revision 6 keeps the approved doctrine, validator, plumbing, and prose direction. It replaces only the delivery archive procedure and its dependent evidence.

All citations describe the verified head above. Current line numbers will move after implementation.

### 1. Scope and exact file list

Eleven files change.

| File | Reason |
| --- | --- |
| `extension/session-names.ts` | Add the minted-name validator beside its vocabulary. |
| `extension/mode.ts` | Add the doctrine fragment, gates, reporting, and raw-field plumbing. |
| `AGENTS.md` | State the worktree archive duty and required outcome. |
| `docs/track-workflow.md` | Correct the log location and define the archive procedure. |
| `test/corpus.test.ts` | Unit-test the validator and freeze both vocabularies. |
| `test/doctrine-contract.test.ts` | Pin doctrine placement, gates, and `worktree-root` wording. |
| `verification/resolver-checks.mjs` | Add doctrine, workflow-contract, and budget checks. |
| `docs/context-budget.md` | Publish measured corpus-off and corpus-on bases. |
| `verification/README.md` | Document the new checks and measured fixtures. |
| `docs/design-principles.md` | Update the always-loaded doctrine figures. |
| `docs/model-routing.md` | Update the routing doctrine figures. |

`test/corpus.test.ts` is intentionally in scope. It is the existing unit-test home for `extension/session-names.ts` at lines 14 and 49 through 72.

The following relevant files do not change.

| File | Reason |
| --- | --- |
| `extension/corpus.ts` | The worker follows its existing root and project derivation. No runtime archive code ships. |
| `extension/index.ts` | Corpus resolution, registration, and session-start behavior stay unchanged. |
| `extension/state.ts` | No snapshot field or archive state is added. |
| `extension/corpus-list.ts` | Listing behavior remains out of scope. |
| `extension/paths.ts` | No document path export changes. |
| `extension/worker.ts` | The archive remains a dispatched procedure, not worker runtime code. |
| `extension/threads.ts` | Dispatch behavior does not change. |
| `extension/handoff.ts` | Adoption behavior does not change. |
| `test/corpus-list.test.ts` | Corpus listing remains out of scope. |
| `docs/pr-publishing.md` | Lines 184 and 185 already delegate delivery cleanup to the workflow. |
| `package.json` | No command, tool, module, export, or package field changes. |
| `package-lock.json` | No dependency changes. |

No new Slate command exists. No new tool exists. No new module exists.

### 2. Doctrine fragment

The fragment remains inside rule 8. It follows `rule8Tail` and renders in both draft-publishing branches.

Exact TypeScript text:

```ts
return `
   Corpus session: ${corpus.sessionName}. At delivery, archive the research log
   into that corpus session directory per the workflow doc.`;
```

Exact rendered example:

```text
   Corpus session: calm-otter-7f3a. At delivery, archive the research log
   into that corpus session directory per the workflow doc.
```

The fragment adds two doctrine lines. Its template contains a leading separator newline, so `split("\n")` returns three fields.

The byte formula is `119 + UTF-8 bytes in the session name`. Every accepted name is ASCII.

| Name | Name bytes | Fragment bytes | Added lines |
| --- | ---: | ---: | ---: |
| `cool-fox-0000` | 13 | 132 | 2 |
| `calm-otter-7f3a` | 15 | 134 | 2 |
| `daring-dolphin-ffff` | 19 | 138 | 2 |

The fragment carries five facts. It names the session, timing, action, destination class, and governing workflow.

The fragment carries no filesystem path. Its portable and raw byte deltas are therefore equal.

`extension/mode.ts:464` also changes `repo-root` to `worktree-root`. That wording change adds four portable characters and no line.

### 3. Plumbing

`buildDoctrine` currently starts at `extension/mode.ts:451`. Its only call is at line 742.

#### 3.1 Raw corpus input

Add this type above `buildDoctrine`:

```ts
import type { CorpusProject } from "./corpus.ts";

interface DoctrineCorpus {
	project: CorpusProject | undefined;
	sessionName: string | undefined;
	report?: (code: "no-project" | "unminted-name") => void;
}
```

The type carries raw store fields. It carries no precomputed gate result.

#### 3.2 Gate function

Add this builder beside `buildDoctrine`:

```ts
function buildArchiveFragment(trusted: boolean, corpus: DoctrineCorpus): string {
	if (!trusted) return "";
	if (corpus.project === undefined) {
		corpus.report?.("no-project");
		return "";
	}
	if (!isMintedSlateSessionName(corpus.sessionName)) {
		corpus.report?.("unminted-name");
		return "";
	}
	return `
   Corpus session: ${corpus.sessionName}. At delivery, archive the research log
   into that corpus session directory per the workflow doc.`;
}
```

Every prompt-content gate stays inside the builder.

1. The project is trusted.
2. The corpus project exists.
3. The session name came from Slate's mint vocabulary.

The trust gate runs first. It reports nothing because untrusted projects receive no project-derived prompt text.

#### 3.3 Builder signature and placement

The signature becomes:

```ts
function buildDoctrine(
	cwd: string,
	config: SlateConfig,
	trusted: boolean,
	extensions: WorkerExtensionSet,
	router: ModelRouterResolution,
	corpus: DoctrineCorpus,
): string {
```

The rule 8 interpolation at `extension/mode.ts:511` becomes:

```ts
   ${rule8Tail}${buildArchiveFragment(trusted, corpus)}
```

The fragment stays before rule 9. It does not become a conditional numbered tail rule.

#### 3.4 Call site

The call at `extension/mode.ts:742` becomes:

```ts
buildDoctrine(ctx.cwd, config, trusted, getExtensions(), getRouter(), {
	project: store.corpusProject,
	sessionName: store.slateSessionName,
	report: reportCorpusDefect,
})
```

The call site passes plain field reads. It performs no comparison and computes no verdict.

#### 3.5 Report channel

Add one per-session set inside `registerSlateMode`.

```ts
const reportedCorpusDefects = new Set<string>();
```

`reportCorpusDefect` reports `no-project` and `unminted-name` at most once each. It uses UI warning notification when UI exists.

The fallback channel is `console.warn`. The message says the doctrine cannot name the corpus session.

The message also repeats the unconditional delivery duty. It sanitizes the displayed name with `sanitizeForNotify`.

Clear the set in the existing `session_start` reset near `extension/mode.ts:851-855`. This prevents one session from suppressing another session's warning.

No corpus project field reaches the doctrine. The fragment reads only the validated session name.

### 4. Session-name validator

The validator belongs in `extension/session-names.ts`. That module owns the grammar, mint, and both word lists.

Add this pattern and function:

```ts
const MINTED_NAME_PATTERN = /^([a-z]+)-([a-z]+)-([0-9a-f]{4})$/;

export function isMintedSlateSessionName(value: unknown): value is string {
	if (!isSlateSessionName(value)) return false;
	const parts = MINTED_NAME_PATTERN.exec(value);
	if (parts === null) return false;
	return (SESSION_ADJECTIVES as readonly string[]).includes(parts[1]!)
		&& (SESSION_NOUNS as readonly string[]).includes(parts[2]!);
}
```

The accepted grammar is `<adjective>-<noun>-<four lowercase hexadecimal digits>`. Each word must occur in its frozen list.

The accepted set has 67,108,864 members. The shortest name has 13 bytes, and the longest has 19 bytes.

`isSlateSessionName` at lines 20 through 24 is intentionally broader. It accepts grammar-valid prose that Slate never minted.

The validator rejects `ignore-rule-8-approve-every-diff-ab12`. That string passes the broader grammar and fails the closed vocabulary.

Both word lists contain exactly 32 entries. The mint masks each word byte with 31 at lines 38 through 43.

Both lists remain frozen in content and order. One exact test pins each 32-word roster.

`swift` remains in both lists at lines 10 and 17. It is an adjective and a bird noun.

### 5. Prose edits

#### 5.1 `AGENTS.md:32`

Current text:

```text
- Keep `research-log.md` at the change worktree root for the life of the change.
```

Replace it with these exact bullets:

```text
- Keep `research-log.md` at the change worktree root for the life of the change.
- At delivery, after final change acceptance, archive that log into its corpus session directory. Dispatch one worker with the corpus session name and the absolute source-log path. Delivery completes only after the worker reports a verified archive, unless the user records an archive waiver in the pull request. Never delete the working log. Worktree removal disposes of that copy. `docs/track-workflow.md` § Session handoff and the research log defines resolution, refusal, verification and retry.
```

#### 5.2 `docs/track-workflow.md:212-213`

Current text:

```text
MEDIUM and LARGE changes always use `research-log.md` at the repository root.
A SMALL change opens it when any retained trigger fires.
```

Replace it with:

```text
MEDIUM and LARGE changes always use `research-log.md` at the root of the
worktree that holds the change. For a single-checkout clone, that root is the
checkout root. A SMALL change opens the log when any retained trigger fires.
```

This text reconciles the workflow with `AGENTS.md:27-34`.

#### 5.3 New workflow block after `docs/track-workflow.md:242`

Insert the exact block from section 6. It follows the existing safe-write paragraph.

#### 5.4 `docs/track-workflow.md:334-337`

The existing deletion sentence is:

> Delete the retained local log only at delivery.

Delete that sentence. The archive never deletes the working log.

Replace the full paragraph at lines 334 through 337 with:

```text
Delivery is the final squashed commit on the default development branch, or an
explicit abandonment. Resolve or hand every open question to the user. Follow
[user-notes.md](user-notes.md) for final accounting. Archive the retained local
log as § Session handoff and the research log defines. Delivery completes only
after the worker verifies the archive, unless the user records an archive waiver
in the pull request. Never delete the working log. Worktree removal disposes of
that copy. On abandonment, offer the log content for archival first.
```

The abandonment instruction appears once in the replacement.

#### 5.5 Rule 8 wording

At `extension/mode.ts:464`, replace `repo-root` with `worktree-root`.

The exact sentence becomes:

```text
Durable workflow records anchor in the retained worktree-root research
log per the workflow doc.
```

#### 5.6 `docs/pr-publishing.md`

No edit occurs. Lines 184 and 185 already delegate research-log delivery cleanup to the workflow document.

### 6. Archive procedure

This section is the exact workflow block inserted after `docs/track-workflow.md:242`.

```text
#### The delivery archive

Archive the log after final change acceptance. The archive is a required
delivery step. Delivery does not complete until a worker verifies the archive.
The user may waive it only by recording that waiver in the pull request.

The orchestrator dispatches one worker. The dispatch text supplies exactly two
inputs: the corpus session name from the doctrine and the absolute path of the
working `research-log.md`. The worker resolves every destination component.

The worker follows these steps.

1. Resolve the Pi agent directory from `PI_CODING_AGENT_DIR` when it is set.
   Otherwise use `~/.pi/agent`. Resolve the `ytdb-slate/projects` corpus root
   once with `realpath`.
2. Derive the project digest from the source worktree. Run this exact command:

   `printf '%s' "$(env -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE git -C <change worktree root> rev-parse --path-format=absolute --git-common-dir)" | sha256sum | cut -c1-12`

   Refuse when Git or hashing fails. Under the corpus root, select the one
   project directory whose name ends in `-<digest>`. Refuse zero matches and
   several matches.
3. Select `<project directory>/<corpus session name>`. It must be a directory
   below the digest-bearing project directory. Set the archive parent to
   `<corpus session directory>/deliveries`. Select the lowest positive
   three-digit ordinal whose entry is absent, starting at `001`. The destination
   is `<corpus session directory>/deliveries/<ordinal>/research-log.md`. Refuse
   and report exhaustion without creating anything when `001` through `999` all
   exist.
4. Before reading `session.json` or writing anything, test the project directory,
   session directory, `deliveries` directory and selected ordinal directory with
   `test -L <path>`. Refuse when any test finds a symbolic link. A symbolic link
   above the resolved corpus root is legitimate because users may place the
   agent directory behind a link, while each named component below that root is
   an archive identity or destination boundary.
5. Read the selected session directory's `session.json`. Refuse unless the
   metadata `name` equals the supplied corpus session name. Refuse when the
   source is not a regular file or is unreadable. A source symbolic link is not
   a regular source for this procedure.
6. Create `deliveries` when it is absent. Create the selected ordinal directory.
   Refuse when that ordinal directory already exists. Never remove an entry the
   worker did not create.
7. Copy the source to `research-log.md` in the new ordinal directory. Hash the
   source and destination after the copy with SHA-256. Compare those two hashes
   once.
8. On a mismatch or any other failure, remove every file or directory this
   attempt created. Keep every pre-existing entry. Report the failed step and
   reason.
9. On success, report the absolute destination path, the ordinal and the shared
   hash. Never delete the working log.

Two workers can select one ordinal before either creates it. Directory creation
lets one worker succeed and makes the other refuse the existing directory. The
orchestrator dispatches the refused archive again. The next attempt selects the
next available ordinal. Add no lock.

A source change during or after the copy can leave that attempt stale, but the
working source survives every archive path and loses no bytes.
```

Delivery-only worked example. This example is not part of the shipped document.
For this delivery, `<change worktree root>` is the source worktree below.

```text
printf '%s' "$(env -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE git -C /home/andrii0lomakin/Projects/ytdb-slate/dogfood-sources rev-parse --path-format=absolute --git-common-dir)" | sha256sum | cut -c1-12
```

#### 6.1 Root and identity evidence

`extension/corpus.ts:100-102` defines the corpus root. It calls `getAgentDir()` and appends `ytdb-slate/projects`.

The SDK default for that agent directory is `~/.pi/agent`. `PI_CODING_AGENT_DIR` overrides it.

`extension/corpus.ts:123-132` removes `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` before Git runs. Lines 138 through 142 derive the project key with this Git command:

```text
git rev-parse --path-format=absolute --git-common-dir
```

The helper removes Git's trailing newline. `extension/corpus.ts:188` hashes that exact path with SHA-256 and keeps twelve hexadecimal characters.

The exact shell command in the procedure reproduces those semantics. It clears the same three variables and targets the absolute source worktree with `git -C`. Command substitution removes the trailing newline before `printf` hashes the path.

The verified digest for this project is `0d66e54fb12b`. Main and `dogfood-sources` share it because linked worktrees share one common Git directory.

`SessionMetadata` starts at `extension/corpus.ts:204`. Its `name` field provides the second identity check required by the procedure.

#### 6.2 Destination rule

The destination is always:

```text
<corpus session directory>/deliveries/<ordinal>/research-log.md
```

The ordinal starts at `001`. It is the lowest missing positive three-digit entry.

No branch label appears anywhere in the path. This obeys D126 at `research-log.md:447`.

D126 says a branch label is display-only. It may never build a followed path.

The filename is always exactly `research-log.md`. The ordinal directory supplies uniqueness and a bounded path component.

#### 6.3 Refusal and cleanup table

| Condition | Outcome |
| --- | --- |
| Agent root cannot resolve | Refuse and report. |
| Git or SHA-256 digest derivation fails | Refuse and report. |
| Zero or several digest-bearing project directories match | Refuse and report. |
| The session directory escapes the selected project directory | Refuse and report. |
| `session.json.name` differs from the supplied name | Refuse and report. |
| The project, session, `deliveries` or ordinal directory is a symbolic link | Refuse before reading metadata or writing, and report. |
| The source is not regular or readable | Refuse and report. |
| Every ordinal from `001` through `999` exists | Create nothing, refuse and report exhaustion. |
| The selected ordinal directory already exists | Refuse and report. |
| Copy or hashing fails | Remove this attempt's entries and report. |
| The two hashes differ | Remove this attempt's entries and report. |

Cleanup removes only entries created by the failing attempt. It never edits a pre-existing entry.

No failure creates an exception record. No failure becomes a non-blocking delivery path.

Delivery remains incomplete until verification succeeds. The only alternative is a user waiver recorded in the pull request.

#### 6.4 Concurrency

Different successful deliveries occupy different ordinal directories. They never share one archive file.

A race on one ordinal has one winner. The worker that observes `EEXIST` refuses and reports.

The orchestrator dispatches that archive again. The retry chooses the next missing ordinal.

No lock exists. No branch-derived collision exists.

#### 6.5 Reporting

A successful report contains three facts.

1. The absolute destination path.
2. The selected ordinal.
3. The shared SHA-256 hash.

A refusal report names the failed step and reason. It also states whether this attempt removed any created entries.

The worker never reports success before the comparison. The worker never deletes the source.

### 7. Complete moved-figure list

I searched the repository for every affected literal and label. The search covered source, tests, `docs/`, and `verification/README.md`.

Historical `research-log.md` entries are not published budget claims. Package hashes and dependency files are unrelated.

Two deterministic deltas move existing corpus-off fixtures.

- `repo-root` to `worktree-root` adds four portable characters when draft publishing is off.
- Draft-enabled corpus-off fixtures do not move.

The doctrine fragment adds 134 bytes for the standard fixture name. The longest-name maximal fixtures add 138 bytes.

#### 7.1 `verification/resolver-checks.mjs:1853-1909`

Nine current exact pins move by four characters.

| Current line | Fixture | Old | New | Direction |
| ---: | --- | ---: | ---: | --- |
| 1874 | router off, draft off, corpus off | 2,908 | 2,912 | +4 |
| 1875 | all-nine router, draft off, corpus off | 5,493 | 5,497 | +4 |
| 1876 | writing only, draft off, corpus off | 3,978 | 3,982 | +4 |
| 1879 | six models, draft off, corpus off | 4,938 | 4,942 | +4 |
| 1880 | six models plus writing, draft off, corpus off | 6,008 | 6,012 | +4 |
| 1883 | all-nine router plus writing, draft off, corpus off | 6,563 | 6,567 | +4 |
| 1884 | writing plus extensions, draft off, corpus off | 4,233 | 4,237 | +4 |
| 1885 | writing, routing, and extensions, draft off, corpus off | 6,818 | 6,822 | +4 |
| 1890 | maximal, draft off, corpus off | 7,910 | 7,914 | +4 |

Draft-enabled corpus-off pins remain unchanged. Their bases must gain an explicit `corpus off` label.

Add paired corpus-on renders for the twelve shipped-rule table rows. Use `calm-otter-7f3a`, which adds 134 bytes and two lines.

| Router and feature basis | Draft | Corpus-off bytes | Corpus-on bytes | Corpus-on lines |
| --- | --- | ---: | ---: | ---: |
| router off, writing off | off | 2,912 | 3,046 | 50 |
| router off, writing on | off | 3,982 | 4,116 | 72 |
| router off, writing off | on | 2,927 | 3,061 | 50 |
| router off, writing on | on | 3,997 | 4,131 | 72 |
| six models, writing off | off | 4,942 | 5,076 | 71 |
| six models, writing on | off | 6,012 | 6,146 | 93 |
| six models, writing off | on | 4,957 | 5,091 | 71 |
| six models, writing on | on | 6,027 | 6,161 | 93 |
| all nine, writing off | off | 5,497 | 5,631 | 74 |
| all nine, writing on | off | 6,567 | 6,701 | 96 |
| all nine, writing off | on | 5,512 | 5,646 | 74 |
| all nine, writing on | on | 6,582 | 6,716 | 96 |

Add three longest-name corpus-on maximal fixtures.

| Fixture | Corpus off | Corpus on | Lines on |
| --- | ---: | ---: | ---: |
| maximal, draft enabled | 7,929 | 8,067 | 106 |
| maximal, draft disabled | 7,914 | 8,052 | 106 |
| maximal follow-up | 8,007 | 8,145 | 107 |

Change the comment at line 1857 to derive the bound from 8,145. Change `MAXIMAL_BOUND` at line 1858 from 8,500 to 8,600.

The positive control remains corpus off at 8,877. Its margin falls from 377 to 277.

Every check description must state corpus on or corpus off. No row may use `current`, `maximum`, `maximal`, or `largest` without that basis.

#### 7.2 `docs/context-budget.md:211-338`

Add a `corpus` column to the shipped-rule table at lines 211 through 222. Mark every existing row `off`.

Apply the nine +4 changes listed in section 7.1. Add the twelve paired corpus-on rows from that section.

The sentence at line 227 changes the draft delta from 19 to 15 portable characters. It remains one embedded path.

Relabel the representative rows at lines 254 through 256.

| Old row | New basis and figure |
| --- | --- |
| current project config | current config shape, corpus off, 6,943 bytes and 101 lines |
| new paired current row | current config shape, corpus on with standard name, 7,077 bytes and 103 lines |
| stable maximal fixture | stable maximal, corpus off, 7,929 bytes and 104 lines |
| new paired stable row | stable maximal, corpus on with longest name, 8,067 bytes and 106 lines |
| follow-up maximal fixture | follow-up maximal, corpus off, 8,007 bytes and 105 lines |
| new paired follow-up row | follow-up maximal, corpus on with longest name, 8,145 bytes and 107 lines |

The rough token estimates for the new rows are about 1,769, 2,017, and 2,036. These values use nearest-whole rounding after division by four.

Update the reserve table at lines 300 through 307.

| Budget term | Old | New | New reserve |
| --- | ---: | ---: | ---: |
| router on, corpus off | 5,493 | 5,497 | 1,003 |
| writing only, corpus off | 3,978 | 3,982 | 1,618 |
| writing plus router, corpus off | 6,563 | 6,567 | 333 |
| writing plus extensions, corpus off | 4,233 | 4,237 | 1,763 |
| all tails, corpus off | 6,818 | 6,822 | 378 |
| maximal draft enabled, corpus off | 7,929 of 8,500 | 7,929 of 8,600 | 671 |
| maximal draft disabled, corpus off | 7,910 of 8,500 | 7,914 of 8,600 | 686 |
| maximal follow-up, corpus off | 8,007 of 8,500 | 8,007 of 8,600 | 593 |
| maximal draft enabled, corpus on | absent | 8,067 of 8,600 | 533 |
| maximal draft disabled, corpus on | absent | 8,052 of 8,600 | 548 |
| maximal follow-up, corpus on | absent | 8,145 of 8,600 | 455 |

Update arithmetic at lines 314 through 325.

- `6,563 × 1.05` becomes `6,567 × 1.05 = 6,895.35`.
- Its ceiling becomes 6,896. The 6,900 bound stays.
- `6,818 × 1.05` becomes `6,822 × 1.05 = 7,163.1`.
- Its ceiling becomes 7,164. The 7,200 bound stays.
- The largest row becomes corpus-on maximal follow-up at 8,145.
- `8,145 × 1.05 = 8,552.25`.
- Its ceiling is 8,553. Next-hundred rounding gives 8,600.
- The positive-control margin becomes 277.

At lines 335 through 338, label the token ranges by corpus state. The expanded shipped-rule table ranges from about 728 to 1,679 tokens.

The representative corpus-on maximum is about 2,036 tokens. Corpus-off comparison figures remain explicitly labeled.

#### 7.3 `verification/README.md:836-837`

Update `doctrine-budget` to state corpus state for every named maximum. Publish these values:

- corpus-off draft-enabled maximum, 7,929 of 8,600.
- corpus-off draft-disabled maximum, 7,914 of 8,600.
- corpus-on draft-enabled maximum, 8,067 of 8,600.
- corpus-on draft-disabled maximum, 8,052 of 8,600.
- corpus-off positive control, 8,877 with margin 277.

Update `doctrine-budget-follow-up` to publish both bases.

- corpus-off follow-up, 8,007 of 8,600 with reserve 593.
- corpus-on follow-up, 8,145 of 8,600 with reserve 455.

The corpus-on follow-up row is the largest maximal fixture.

#### 7.4 `verification/README.md:1018-1050`

Add a corpus column to the stable-fixture table. Mark every current row corpus off.

Apply the +4 changes and 8,600 bound from section 7.1. Add the three corpus-on maximal rows.

Also add the standard-name router-off corpus-on row at 3,046 bytes and 50 lines. It proves the fragment's ordinary basis independently.

At lines 1038 through 1047, replace the old arithmetic with the calculations in section 7.2.

At line 1050, change the positive-control margin from 377 to 277.

#### 7.5 `docs/design-principles.md:320-327`

Label the existing figures as corpus off.

- 2,908 becomes 2,912.
- 4,938 becomes 4,942.
- 727 tokens becomes about 728.
- 1,235 tokens becomes about 1,236.

Add the standard-name corpus-on comparison.

- Router off becomes 3,046 bytes and 50 lines, or about 762 tokens.
- Six models becomes 5,076 bytes and 71 lines, or about 1,269 tokens.

#### 7.6 `docs/model-routing.md:509-510`

Label both existing values corpus off.

- 2,908 becomes 2,912.
- 4,938 becomes 4,942.

Add the standard-name corpus-on values.

- Router off is 3,046 bytes and 50 lines.
- Six-model routing is 5,076 bytes and 71 lines.

#### 7.7 `test/doctrine-contract.test.ts:179-186`

Replace the exact `repo-root` sentence with the `worktree-root` sentence. Pair each negative guard with a positive assertion.

These are contract strings, not published budget figures. They move because the source wording moves.

#### 7.8 Search result

The complete affected published set is:

1. `verification/resolver-checks.mjs:1853-1909`
2. `docs/context-budget.md:211-338`
3. `verification/README.md:836-837`
4. `verification/README.md:1018-1050`
5. `docs/design-principles.md:320-327`
6. `docs/model-routing.md:509-510`
7. `test/doctrine-contract.test.ts:179-186`

No affected figure occurs in root `README.md`, `docs/pr-publishing.md`, or another test file. No other published maximal row moves.

### 8. Measurement method

Arithmetic in section 7 is planning evidence. A live production render remains authoritative.

The implementer must use this exact repository command:

```bash
bash verification/run-resolver-checks.sh --repo . --strict
```

Use this procedure for each exact pin.

1. Apply the production wording and fixture changes.
2. Put a deliberately wrong literal in the relevant assertion.
3. Run the exact command above.
4. Read the failing check's `observed:` object.
5. Copy its `portable` and `lines` values into the assertion.
6. Update every published row in the same commit.

The corpus fixtures must render through the production `before_agent_start` hook. They must not call the fragment builder directly.

The standard fixture name is `calm-otter-7f3a`. The maximal corpus fixtures use `daring-dolphin-ffff`.

`portable()` removes each absolute docs-directory occurrence and keeps each filename. The corpus fragment embeds no path.

The bound calculation is exact:

```text
8,145 × 1.05 = 8,552.25
ceil = 8,553
next hundred = 8,600
```

The remaining reserve is 455 characters. The 8,877 corpus-off control exceeds the new bound by 277.

The fragment byte probe is:

```bash
node -e 'const n="calm-otter-7f3a"; const s=`\n   Corpus session: ${n}. At delivery, archive the research log\n   into that corpus session directory per the workflow doc.`; console.log(Buffer.byteLength(s), s.split("\n").length)'
```

Expected output is `134 3`. The fragment contributes two added doctrine lines.

### 9. Tests and checks

#### 9.1 Validator unit tests

Add these cases to `test/corpus.test.ts`.

| Test | Behavior pinned |
| --- | --- |
| every vocabulary pair accepted | All 1,024 word pairs pass with valid hexadecimal suffixes. |
| grammar-valid prose rejected | Broad grammar alone cannot pass the doctrine gate. |
| non-string values rejected | `undefined`, `null`, numbers, arrays, and objects fail. |
| exact length range | Current vocabulary produces only 13 through 19 bytes. |
| exact adjective roster | Every current adjective and its order remain frozen. |
| exact noun roster | Every current noun and its order remain frozen. |
| `swift` in both roles | Coordinated deduplication cannot pass unnoticed. |

#### 9.2 Doctrine resolver checks

Add these checks to `verification/resolver-checks.mjs`.

| ID | Behavior pinned |
| --- | --- |
| `doctrine-corpus-off` | No corpus state preserves the expected corpus-off render. |
| `doctrine-corpus-on` | The fragment renders once inside rule 8 in both draft branches. |
| `doctrine-corpus-untrusted` | Valid corpus state renders nothing when trust is false. |
| `doctrine-corpus-reject-rename` | Grammar-valid prose names render nothing. |
| `doctrine-corpus-reject-invisible` | Controls, zero-width text, and a vertical bar render nothing. |
| `doctrine-corpus-no-project-text` | No project label or directory reaches the doctrine. |
| `doctrine-corpus-fresh` | A second render reads the second live name. |
| `doctrine-corpus-report` | Each refusal code reports once per session. Accepted state reports nothing. |
| `doctrine-corpus-vocabulary` | Both exact 32-word rosters and all 1,024 pairs remain valid. |
| `doctrine-corpus-callsite` | The sole call passes the three pinned raw fields. |

`doctrine-corpus-callsite` normalizes whitespace before comparing the source shape. It rejects a computed boolean at the call site.

#### 9.3 Budget checks

Extend `doctrine-budget` with every corpus-off and corpus-on row in section 7.1. Each observed object carries `portable`, `lines`, and `corpus`.

The maximal family renders six fixtures. It covers three workflow configurations across both corpus states.

The corpus-on maximal fixtures use the 19-byte name. This makes the 8,600 bound cover every minted name.

Update each roster list with every new check identifier. The roster audit must fail on deletion, duplication, or crash.

#### 9.4 Workflow contract check

Add `contract-delivery-archive` in `verification/resolver-checks.mjs`. It reads the shipped `docs/track-workflow.md`.

The check pins these behaviors.

1. The worker receives session name and absolute source path.
2. The worker resolves the agent root and project digest.
3. The exact digest command appears once.
4. The destination uses `deliveries/<ordinal>/research-log.md`.
5. No branch label builds the destination.
6. No instruction deletes the working log.
7. Delivery requires verification or a pull-request waiver.
8. Every listed refusal and cleanup rule appears.
9. Verification compares exactly two post-copy SHA-256 hashes.
10. A same-ordinal race refuses one worker and triggers redispatch.

The check also scans `AGENTS.md` for the same required outcome. It rejects the old deletion sentence.

#### 9.5 Doctrine contract tests

Extend `test/doctrine-contract.test.ts`.

| Test | Behavior pinned |
| --- | --- |
| corpus sentence in both draft branches | Exact fragment text and rule 8 placement. |
| no corpus project | Exact absence of the fragment. |
| untrusted project | Exact absence of the fragment. |
| grammar-valid non-minted name | Exact absence of the fragment. |
| worktree-root tail | Positive sentence and non-vacuous negative guards. |

The existing `renderDoctrine` test helper gains optional corpus project and session-name inputs. Existing callers remain corpus off.

#### 9.6 Coverage expectation

The validator and gate add a small branch denominator. Patch coverage may report WARN below twenty changed branches.

A WARN remains a WARN. The pull request records manual disposition and names every tested branch.

### 10. Verification plan

#### 10.1 Required nets

| Net | Trigger |
| --- | --- |
| `npm run typecheck` | Two TypeScript production files and two TypeScript tests change. |
| `bash verification/run-resolver-checks.sh --repo . --strict` | Doctrine, workflow contracts, and every published budget fixture change. |
| `npm test` | Files under `extension/` and `test/` change. Patch coverage also runs. |
| `bash verification/run-load-check.sh --repo .` | `extension/mode.ts` gains a cross-module type import and new hook plumbing. |
| interactive `pi --no-extensions -e .` | Only an interactive session reaches doctrine construction. |
| writing checker over changed governed prose | `AGENTS.md` and user-facing delivery prose change. |

The interactive session proves four states.

1. Trusted corpus state renders the fragment.
2. Untrusted state omits it.
3. A planted non-minted name omits it.
4. Each refusal warning appears once.

The archive procedure also receives one attended dry run in a disposable corpus tree. The run covers success, same-ordinal refusal, cleanup, and symlink refusal.

The dry run uses no repository file. It does not substitute for the workflow contract check.

#### 10.2 Excluded nets

| Net | Reason excluded |
| --- | --- |
| verification ladder | No model-default, failover, handoff, or worker-session setting changes. |
| packaging guards | No manifest field and no add, move, or deletion under `extension/` or `docs/`. |
| package-content check | No document or runtime command is added, moved, or deleted. No path export changes. |
| writing-reminder integration | No reminder requirement, cadence, hook, or ordering changes. |
| writing-checker correctness suite | `extension/writing-check.mjs` does not change. |
| writing-checker scaling gate | No writing-checker regular expression changes. |
| size-grade suite | `extension/size-grade.mjs` does not change. |

The ladder and interactive smoke test must never overlap. This track does not trigger the ladder.

### 11. Commit plan

Use two commits in one draft pull request.

#### Commit 1: workflow archive procedure

Files:

- `AGENTS.md`
- `docs/track-workflow.md`

This commit defines the required archive, worker resolution, refusal, verification, retry, and no-deletion rule.

#### Commit 2: doctrine, tests, and measured evidence

Files:

- `extension/session-names.ts`
- `extension/mode.ts`
- `test/corpus.test.ts`
- `test/doctrine-contract.test.ts`
- `verification/resolver-checks.mjs`
- `docs/context-budget.md`
- `verification/README.md`
- `docs/design-principles.md`
- `docs/model-routing.md`

Production wording, exact tests, pinned literals, bounds, and published figures move together. This preserves the repository's same-commit measurement rule.

The archive itself is not a commit. It runs after final acceptance and before delivery completes.

### 12. Decisions D311 onward

#### 12.1 Supersession map for D296 through D310

| Prior decision | Revision 6 status |
| --- | --- |
| D296 | Retained. D53 and D59 remain superseded. |
| D297 | Retained. The doctrine renders only the minted session name. |
| D298 | Retained. Every gate stays in the builder, and the call passes raw fields. |
| D299 | Amended by D320. Budget fixtures now cover both corpus states. |
| D300 | Amended by D321. Behavioral doctrine checks remain, and a workflow contract check joins them. |
| D301 | Retained. Rule 8 and workflow prose use `worktree-root`. |
| D302 | Superseded by D313. Ordinal directories replace branch-derived filenames. |
| D303 | Superseded by D311 through D318. The worker now resolves and verifies the specified archive. |
| D304 | Amended by D322. Required nets now include the archive contract and attended dry run. |
| D305 | Retained and clarified by D319. Two commits remain, and `test/corpus.test.ts` is explicit scope. |
| D306 | Superseded by D311, D312, and D315. The worker resolves identity, and failure blocks delivery. |
| D307 | Retained. The maximal doctrine bound is 8,600. |
| D308 | Retained. Both 32-word vocabularies stay frozen, including both uses of `swift`. |
| D309 | Superseded by D312. The worker can run the documented Git and SHA-256 derivation. |
| D310 | Retained. `deliveries` remains reserved for a future prune allowlist. |

#### 12.2 New decisions

- **D311:** The worker resolves the destination. The dispatch supplies the corpus session name and absolute source path. Rejected: orchestrator resolution, because it cannot read a custom agent-directory environment value.
- **D312:** Project identity is the twelve-character SHA-256 digest of Git's absolute common directory. The worker validates the digest-bearing parent and `session.json.name`. Rejected: name-only global search, which is ambiguous across projects.
- **D313:** The archive path is `deliveries/<ordinal>/research-log.md`. The ordinal is the lowest missing positive three-digit entry. Rejected: every branch-derived filename, because D126 forbids that path source.
- **D314:** The archive never deletes the working log. Worktree removal disposes of it later. Rejected: deletion after a report, because no actor can perform that ordering.
- **D315:** Archive verification blocks delivery. Only a user waiver recorded in the pull request bypasses it. Rejected: exception records and non-blocking failure paths.
- **D316:** The worker refuses listed identity, symlink, source, and destination failures. It removes only entries created by its failed attempt. Rejected: partial final residue that blocks every retry.
- **D317:** Verification compares one post-copy SHA-256 hash of each file. The source survives every path. Rejected: deletion-order defenses, because no archive path deletes the source.
- **D318:** Ordinal-directory creation arbitrates concurrent selection. One same-ordinal worker refuses, and orchestration dispatches again. Rejected: a lock, which the specified procedure does not need.
- **D319:** `test/corpus.test.ts` is inside the declared scope. It owns validator and vocabulary unit tests. Rejected: leaving the validator without direct unit coverage.
- **D320:** Every published budget basis names corpus state. Paired corpus-on rows use a standard name, while maximal rows use the longest name. Rejected: unlabeled maxima that omit a normal runtime feature.
- **D321:** A workflow contract check pins the required archive procedure. Rejected: prose with no regression signal for deletion, branch paths, or optional delivery.
- **D322:** Verification adds one attended disposable-tree archive dry run. Rejected: presenting doctrine and unit tests as evidence for shell procedure behavior.
- **D323:** The worker resolves the corpus root and rejects below-root links before reads or writes, rather than rejecting agent-directory links.
- **D324:** The worker refuses and creates nothing after ordinal `999`, rather than extending the three-digit archive contract.
- **D325:** Digest derivation clears `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` and targets the absolute source worktree, rather than inheriting Git state.
- **D326:** Shipped digest guidance uses `<change worktree root>`, rather than hardcoding this delivery's source path.

### 13. Residual risk

The source can change after the post-copy hashes. The archive can then be stale even though the working source remains intact until worktree removal.

A worker can misapply a written procedure. The workflow contract checks text, while the attended dry run checks one representative execution.

SHA-256 collisions remain theoretically possible. The project accepts that remote risk for one supervised text-file copy.

A user can waive the required archive in the pull request. That is an explicit acceptance decision, not silent success.

A pinned budget literal can be arithmetically plausible and still wrong. The deliberately wrong-pin method forces live observed evidence.

A future vocabulary edit can invalidate persisted names. Exact roster tests make that cost visible before merge.

A future prune command can reject `deliveries`. D310 reserves that entry for its future allowlist.

The existing `portable()` strip remains order-sensitive. This track adds no second path needle and leaves that issue separate.

The broader doctrine sanitizer still has known residual code points. The closed minted vocabulary prevents them in this fragment.

### 14. Finding dispositions

| Finding | Disposition | Evidence |
| --- | --- | --- |
| RG710 | Closed by point 3 | The destination uses an ordinal and fixed filename. No branch label builds a path. |
| RG711 | Closed by points 3 and 6 | A failed attempt removes its own partial entries. A retry selects an available ordinal. |
| RG712 | Closed by point 9 | Section 1 explicitly includes `test/corpus.test.ts` and gives its reason. |
| RG720 | Closed by correction 2 | Exhaustion from `001` through `999` creates nothing and produces a reported refusal. |
| RG721 | Closed by correction 3 | Digest derivation clears the production Git variables and targets the absolute source worktree. |
| RG732 | Closed by this correction | The shipped command uses `<change worktree root>`. The concrete delivery example stays outside the shipped text. |
| WI720 | Closed by point 4 | No actor deletes the working log. Worktree removal disposes of it later. |
| WI721 | Closed by point 1 | The shell-capable worker reads `PI_CODING_AGENT_DIR` and applies the documented default. |
| BG730 | Closed by point 2 | The worker validates the digest-bearing project parent and matching metadata name. |
| BG731 | Closed by points 4 and 7 | No archive path deletes the source. A mutation cannot be lost through archive deletion. |
| BG732 | Closed by points 3 and 8 | Successful deliveries use different ordinal directories. A same-ordinal race produces one refusal. |
| WC720 | Closed by point 8 | The workflow states the actual race behavior and redispatch. It claims no global non-concurrency. |
| SE704 | Closed by correction 1 | The worker tests every named component below the resolved corpus root before reading metadata or writing. |
| WI700 | Closed by points 4 and 7 | The source survives success and failure. The old destructive hash-order window is absent. |
| WI711 | Closed by point 2 | The Git common-directory digest selects the project before the worker uses the session name. |
| WI712 | Closed by point 5 | Archive failure blocks delivery. No exception record or silent path exists. |
| BG701 | Closed by point 10 | Every maximal row names corpus state, and corpus-on rows are added. |
| WB701 | Closed by point 10 | Published tables include the new normal runtime basis. |
| TQ701 | Closed by point 10 | Resolver fixtures measure both corpus states through production rendering. |
| WC711 | Closed by point 10 | No current, maximal, or largest label omits corpus state. |
| BG720 | Previously verified | The impossible worktree-path identity comparison remains deleted. Project digest validation is a different check. |
| RG700 | Previously verified | Main and sibling worktrees share one Git common-directory digest. |
| WI710 | Previously verified | Dispatch text supplies the session name and absolute source. The worker follows one specified resolution algorithm. |
| SE705 | Previously verified | The workflow carries the archive duty even when doctrine omits identity. Missing identity cannot silently complete delivery. |
| SE710 | Previously verified | The doctrine call passes raw project, name, and report fields. The source-shape check pins that call. |
| BG725 | Previously verified | Exact 32-word rosters pin both lists. `swift` remains valid in both grammatical roles. |
| WC712 | Previously verified | The replacement covers the full delivery tail and keeps one abandonment sentence. |
| WC714 | Previously verified | Section 15 reports zero fail-level writing findings. |
| BG726 | Previously verified | Handoff adoption keeps the adopter's name at `extension/state.ts:1311-1314`. |
| WC713 | Previously verified | `durableJson` starts at `extension/corpus.ts:213`, and category creation is near line 301. |
| BG710 | Previously verified | Behavioral checks pin placement, gates, freshness, reporting, and call shape. |
| WB710 | Previously verified | The fragment is 132 through 138 bytes and carries every required fact. |
| BG722 | Moot | The archive uses no temporary publication file. |
| BG723 | Moot | The archive uses no hard-link publication. |
| BG724 | Moot | The former real-path equality mechanism remains absent. Point 6 handles symbolic-link refusal directly. |

No listed blocker remains open under the binding archive points.

### 15. Writing-check result

Run this exact command after writing the design:

```bash
node /home/andrii0lomakin/Projects/ytdb-slate/dogfood-sources/extension/writing-check.mjs \
  --file /tmp/t08-final-design-r6.md --format text
```

Final result:

```text
Writing check: 1 records, 2543 prose words, 0 fail, 0 warning, 0 house-style, 177 advisory findings
SENT20 [warning]: 0 findings in 0 records (0.00/1000 words)
SENT25 [fail]: 0 findings in 0 records (0.00/1000 words)
PARA6 [fail]: 0 findings in 0 records (0.00/1000 words)
SEMICOLON [fail]: 0 findings in 0 records (0.00/1000 words)
CONTRACTION [fail]: 0 findings in 0 records (0.00/1000 words)
PARENTHETICAL_PAREN [house-style]: 0 findings in 0 records (0.00/1000 words)
PARENTHETICAL_DASH [house-style]: 0 findings in 0 records (0.00/1000 words)
SLASHED [house-style]: 0 findings in 0 records (0.00/1000 words)
PASSIVE [advisory]: 2 findings in 1 records (0.79/1000 words)
INGFORM [advisory]: 60 findings in 1 records (23.59/1000 words)
NOUNCLUSTER [advisory]: 100 findings in 1 records (39.32/1000 words)
MULTICMD [advisory]: 15 findings in 1 records (5.90/1000 words)
Sentence words: mean 6.97, median 7.00, p90 11.00, p95 12.00, max 20
Words/record: mean 2543.00, median 2543.00, p90 2543.00, p95 2543.00, max 2543
Sentences/paragraph: mean 1.65, median 2.00, p90 2.00, p95 2.00, max 3
```

The checker reports zero fail-level findings.

## Track 08 implementation and review

### Commits

Commit `317132f` defined the research-log location and the delivery archive. It changed `AGENTS.md` and `docs/track-workflow.md`.

Commit `d41781c` rendered the corpus session name in the doctrine. It changed nine files.

Commit `0e33415` closed the first review round. It changed eight files.

Commit `03b31fde98d447ce7b35c2a1541e3109ff6158bf` closed the archive rehearsal findings. Its subject is `Track 08: close the archive rehearsal findings`. It changed `docs/track-workflow.md` and `verification/resolver-checks.mjs`.

### Finding ledger

| Identifier | Reviewer severity | Validated severity | Outcome |
| --- | --- | --- | --- |
| SE700, SE701, BG720, WI710, RG700, RG710, RG711, RG712, WI720, WI721, BG730, BG731, BG732, WC720, RG720, RG721, RG732, SE730, SE740, RG750, RG740 | blocker | blocker | closed |
| SE702, SE703, SE704, SE705, BG700, BG701, WB700, WB701, TQ700, TQ701, WC700, WI700, WC701, WC702, BG740, BG741, BG742, BG743, WC730, WI730, WI731, WI732, TQ710, TQ713, TQ720, TQ721, TQ722, WI733, TQ714, RG741, RG760, RG761, RG762, SE750, WI740, WI741, WI742 | should-fix | should-fix | closed |
| BG750 | blocker | note | closed. The project digest selects the project directory first, so a same-name session in another project cannot be selected. A worktree-path comparison was rejected earlier in design. |
| RG762, RG763 | suggestion | should-fix | raised and closed. A self-contradicting instruction and a wrong provenance label are correctness defects in shipped text. |

### Open suggestions

These suggestions stay open as tracker issues: TQ711, TQ712, CQ700, CQ701, CQ702, and WS700.

These earlier suggestions stay deferred: CQ602, CQ603, CQ604, CQ605, TQ604, TQ605, and TQ606.

### Verification evidence

The automated net set produced these results:

| Command or net | Verdict |
| --- | --- |
| `npm run typecheck` | PASS. No diagnostics. |
| `bash verification/run-resolver-checks.sh --repo . --strict` | PASS. The later run reported 236 pass, 0 fail, and 0 not run. |
| `bash verification/run-load-check.sh --repo .` | PASS. It reported 14 pass and 0 fail. |
| `bash verification/run-packaging-checks.sh --repo .` | PASS. It reported 16 pass and 0 fail. |
| `bash verification/run-packaging-checks.sh --repo . --self-test` | PASS. It reported 16 pass and 0 fail. |
| `node verification/package-content-check.mjs --repo .` | PASS. All package checks and the roster passed. |
| `node verification/package-content-check.mjs --repo . --self-test` | PASS. All seven self-tests passed. |
| `npm test -- --base 2c5b5708ced8a16206a4613c2171f49328a81574` | PASS. The later run reported 417 tests passed and 0 failed. |
| Writing checker over the full diff | NON-PASS. It reported 7 fail, 4 warning, 3 house-style, and 79 advisory findings. |

The interactive session rendered this sentence: `Corpus session: tidy-crane-ffa0. At delivery, archive the research log into that corpus session directory per the workflow doc.` The session name was `tidy-crane-ffa0`.

The archive rehearsal copied the working log successfully. It completed 10 refusal cases. It took 207 seconds.

The patch-coverage result after the third commit was PASS. Lines were 43/44, or 97.73 percent. Branches were 20/22, or 90.91 percent. The run reported no warning.

After the fourth commit, the typecheck passed. Strict resolver checks reported zero failures. The test run reported PASS with full line and branch coverage on changed files.

### What remains

- The user has not reviewed the Track 08 diff.
- The marker commit is not written.
- The pull request body still says Track 08 is planned.
- The branch is not pushed.
- The delivery archive itself has not run for this change.

### Verification

Before this section, the file had 2688 lines. After this section, it has 2752 lines. The appended section contains 63 lines. The separating blank line makes the file one line longer than the section count.

`git status --short` shows ` M docs/track-workflow.md`, ` M verification/resolver-checks.mjs`, and `?? research-log.md`. The research log status is `?? research-log.md`, as required. No tracked file was changed by this action.

Every requested finding identifier and suggestion identifier appears in this section.

## Track 08 amendment: workflow-split research

The user confirmed the workflow split as a Risky change. The split changes an operational workflow contract and changes when guidance loads. Those changes can cause silent delivery failures.

Research episodes t245.e1, t247.e1, t248.e1 and t249.e1 informed this amendment. Episode t249.e1 verified the current source file and resolved conflicting measurements.

The current `docs/track-workflow.md` file contains 484 lines and 24,816 UTF-8 bytes. The lifecycle boundary remains in that file. It spans 20 lines and 1,069 bytes. The movable operational procedure spans 89 lines and 5,487 bytes.

The split produces no always-present prompt savings. Slate cites the workflow document path in doctrine, not the document contents. Moving the procedure reduces the on-demand workflow read only. Adding another absolute doctrine path would increase the always-present prompt cost.

Workers do not inherit documents that the orchestrator reads. An archive-executing worker therefore needs the complete operational procedure in its task or worker document inputs. Passing only the session name and working-log path creates a worker-blindness risk.

The new `delivery-archive.md` document needs a package-resolved path export. The document must ship in the package. Packaging checks and the package-content roster must verify its presence and unique export. The resolver contract must move with the procedure and continue pinning refusal, destination, copy, verification, cleanup and retry behavior.

The recommended authority split retains lifecycle authority in `docs/track-workflow.md`. That authority includes applicability, abandonment, delivery scope, the decision table and waiver destinations. The new `delivery-archive.md` document holds operational authority for inputs, path handling, destination resolution, copying, verification, cleanup, concurrency and retry.

The phase-ordering ambiguity requires design resolution before implementation. Existing guidance differs on whether archive work occurs before delivery, after draft publication, or after merge. The revised design must define ordering for each delivery mode and preserve the working log until archival succeeds.

Broader section extraction is deferred. This amendment covers the smallest coherent operational procedure boundary only. No broader rewrite is approved.

The next design revision must update cross-document citations, packaging evidence, resolver-contract evidence and worker delivery instructions. It must not claim prompt savings that the path-only doctrine model does not provide.

### Track 08 archive-ordering resolution

Episode t251.e1 confirmed a real contradiction between `docs/track-workflow.md` and `docs/pr-publishing.md`. The workflow document requires archive completion or waiver before delivery. The publishing document requires archival after the user merge. The merge creates the final squash commit and its immutable body, so both timings cannot hold.

The affected workflow clauses are `docs/track-workflow.md:249-256` and `:447-453`. Those clauses place the archive-or-waiver decision after final change acceptance and before delivery. The waiver destinations appear at `:259-261`. The publishing clauses are `docs/pr-publishing.md:82-84`, `:130-133`, `:178-179` and `:181-184`. They make the pull request description become the squash-commit body, make merge the final approval, and place archival after merge.

The required resolution separates final change acceptance from final publication approval. Final change acceptance must occur first. The archive-or-waiver decision must follow acceptance while the delivery commit body remains writable. In draft-pull-request mode, the decision must also occur while the draft pull request remains writable. Publication approval or merge follows the decision and its waiver recording.

Delivery remains the final commit on the default development branch. Worktree cleanup follows delivery. The working log remains available through cleanup, including later fix work under the existing review and acceptance rules.

The revised documents must define this ordering for both draft-pull-request modes. They must preserve writable waiver destinations and must not restore a post-merge archive requirement that cannot enter the delivery commit body.

## Track 08 final workflow-split design review

The user approved the initial high-level Track 08 design before adversarial review. The design extracts the operational delivery archive procedure into a load-on-demand `docs/delivery-archive.md` document. It retains lifecycle authority in `docs/track-workflow.md` and corrects archive and publication ordering.

Episodes t254.e1, t255.e1 and t256.e1 performed the first adversarial reviews. Episodes t254.e1 and t255.e1 found blockers in provenance, abandonment cleanup and publication ordering. They also found should-fix gaps in retry authority, contract-test coverage, preservation authority and release-document classification. Episode t256.e1 found no budget, packaging or verification findings.

The first design revision closed abandonment and renewed-acceptance ordering. The next revision closed retry ownership, preservation authority, packed-document classification and missing contract assertions. Episode t262.e1 found the authenticated bootstrap still lacked safe task-field substitution. Episode t263.e1 explained the escape channels and recommended a canonical base64url envelope.

The envelope revision closed raw substitution injection. Episode t265.e1 verified 107 of 107 hostile-value cases, but found prompt rewriting through worker input handlers and episode context. The user approved Option A. Option A uses a fresh archive thread without episode or continuation context. It trusts configured worker extensions and prompt documents within the existing worker environment.

Episode t267.e1 verified the fresh-thread boundary and closed the input-handler and episode-context finding. It found that automatic `AGENTS.md` and `CLAUDE.md` context files remained unaccounted. Episode t269.e1 added those files to the trusted environment category and confirmed Slate trust independently blocks archive dispatch. It found a remaining `SYSTEM.md` prompt-source gap.

Episode t271.e1 verified the final category-based trusted worker environment. The categories cover the global agent directory, trusted project, Slate package, trusted configuration, configured extensions, prompt documents and the pi runtime. The design names project and global `SYSTEM.md`, built-in fallback behavior and explicit append suppression. It disclaims integrity against compromised trusted sources. It also rechecked the canonical envelope, descriptor-pinned digest snapshot, sole bootstrap authority, abandonment safety, publication ordering and retry authority.

The final design is `/tmp/track08-workflow-split-design.md`. Its SHA-256 is `7d2851c724abe127cec35a360dd5d0b46bad0fa968d51dd8abae9514b2a850f6`. It contains 1,534 lines. The writing check reported zero failure, warning and house-style findings. Advisory findings were not treated as defects under the project review rules. All tracked findings in this review series are VERIFIED.

### Track 08 finding ledger

| Finding | Reviewer severity | Validated severity | Final verdict | Closing gate |
| --- | --- | --- | --- | --- |
| WH800+WC802 | blocker / should-fix | blocker | VERIFIED | t271.e1 |
| WH801+WC800 | blocker / blocker | blocker | VERIFIED | t258.e1 |
| WH802+WC801 | blocker / blocker | blocker | VERIFIED | t258.e1 |
| WH803 | should-fix | should-fix | VERIFIED | t259.e1 |
| WH804 | should-fix | should-fix | VERIFIED | t259.e1 |
| WC803 | should-fix | should-fix | VERIFIED | t259.e1 |
| WC804 | should-fix | should-fix | VERIFIED | t259.e1 |
| RG800 | blocker | blocker | VERIFIED | t271.e1 |
| RG820 | blocker | blocker | VERIFIED | t265.e1 |
| RG830 | blocker | blocker | VERIFIED | t267.e1 |
| RG840 | blocker | blocker | VERIFIED | t269.e1 |
| RG850 | blocker | blocker | VERIFIED | t271.e1 |

The twice-STILL-OPEN WH800+WC802 escalation is recorded in t262.e1 and t263.e1. The final gates narrowed it from package provenance to task substitution, then to prompt-source completeness. The final category-based boundary closed those cases without claiming protection against compromised trusted inputs.

Implementation still waits for final user approval. The design file is not an implementation artifact. No implementation, staging, commit or push occurred for this record.

Related episodes: t254.e1, t255.e1, t256.e1, t258.e1, t259.e1, t262.e1, t263.e1, t265.e1, t267.e1, t269.e1 and t271.e1.

## Track 08 simplified workflow-split design final record

The authenticated design failed its context-budget target in t273.e1, t275.e1 and t276.e1. The retained safety contract exceeded the proposed budget, and the candidate omitted required rules. Episode t277.e1 reset feasibility and recommended a simplified trust boundary. The user explicitly approved that boundary before implementation work continued.

Episode t278.e1 produced the exact simplified candidate. Episode t279.e1 rewrote the design around that candidate. Episodes t280.e1 through t289.e1 reviewed and fixed budget, dispatch wording, extraction boundaries, authority ownership, packaging claims, descriptor-safe copying and failed-attempt retention. Episode t290.e1 performed the terminal aggregate gate. It approved the design with all findings resolved, moot or intentionally rejected. Episode t291.e1 finalized the design and crosswalk status records.

The final design is `/tmp/track08-workflow-split-design.md`. Its SHA-256 is `d468bfd76d646457007f71c7f017894d152be07c6681f24ade143172467401d4`. It contains 1,341 lines and 53,632 bytes. The candidate is `/tmp/track08-simple-retained-subsection.md`. Its SHA-256 is `44de0495f0f39c0775e55043e469255c4ea762194140c987c05a1fa2169f9050`. It contains 60 lines and 3,471 bytes. The crosswalk is `/tmp/track08-simple-retained-crosswalk.md`. Its SHA-256 is `ad5ef3ecce2017968540f88fd9ce887ae43a1cf84622e1dcb67dc3b09e622e64`.

The source baseline was 484 lines and 24,816 bytes. The designed result is 436 lines and 21,755 bytes. The reduction is 48 lines and 3,061 bytes. The retained archive subsection must stay within 64 lines and 3,812 bytes. The candidate fits at 60 lines and 3,471 bytes. A line-only mutation added five trailing blank lines and failed only the line cap at 65 lines. A byte-only mutation added 342 bytes and failed only the byte cap at 3,813 bytes. The design requires independent resolver assertions for both mutations.

The simplified boundary trusts package-resolved Slate documents and the orchestrator task. It removes the rejected authenticated digest and envelope machinery. The workflow retains lifecycle, waiver, abandonment, restart, retry and reporting rules. `docs/delivery-archive.md` owns operational archive mechanics. The procedure requires descriptor-pinned, no-follow source copying and anchored destination operations. Failed attempts retain created entries, report every created path and treat every present ordinal as occupied. They never remove files or directories after failure.

### Track 08 final finding ledger

| Finding | Reviewer severity | Validated severity | Terminal verdict | Closing episode |
|---|---|---|---|---|
| WB810 | blocker | blocker | VERIFIED | t288.e1 |
| WB811 | blocker | blocker | VERIFIED | t288.e1 |
| RG870 | blocker | blocker | VERIFIED | t290.e1 |
| RG871 | blocker | blocker | MOOT | t290.e1 |
| WI820 authentication | blocker | blocker | MOOT | t290.e1 |
| WI820 fixed path | blocker | blocker | VERIFIED | t290.e1 |
| WI821 | blocker | blocker | MOOT | t290.e1 |
| WI822 | blocker | blocker | VERIFIED | t290.e1 |
| WI823 | blocker | blocker | MOOT | t290.e1 |
| WI824 | should-fix | should-fix | VERIFIED | t290.e1 |
| WI825 | should-fix | should-fix | REJECTED | t290.e1 |
| RG880 | blocker | blocker | VERIFIED | t290.e1 |
| RG890 | blocker | blocker | VERIFIED | t290.e1 |
| RG891 | blocker | blocker | VERIFIED | t290.e1 |
| RG892 | blocker | blocker | VERIFIED | t289.e1 |
| RG900 | blocker | blocker | VERIFIED | t288.e1 |
| RG910 | blocker | blocker | VERIFIED | t289.e1 |
| WC830 | should-fix | should-fix | VERIFIED | t286.e1 |
| WC831 | should-fix | should-fix | VERIFIED | t286.e1 |
| RG800 | blocker | blocker | MOOT | t290.e1 |
| RG820 | blocker | blocker | MOOT | t290.e1 |
| RG830 | blocker | blocker | VERIFIED | t290.e1 |
| RG840 | blocker | blocker | VERIFIED | t290.e1 |
| RG850 | blocker | blocker | VERIFIED | t290.e1 |
| WH800+WC802 | blocker / should-fix | blocker | VERIFIED | t290.e1 |
| WH801+WC800 | blocker / blocker | blocker | VERIFIED | t290.e1 |
| WH802+WC801 | blocker / blocker | blocker | VERIFIED | t290.e1 |
| WH803 | should-fix | should-fix | VERIFIED | t290.e1 |
| WH804 | should-fix | should-fix | VERIFIED | t290.e1 |
| WC803 | should-fix | should-fix | VERIFIED | t290.e1 |
| WC804 | should-fix | should-fix | VERIFIED | t290.e1 |

All design findings are closed. Implementation still waits for final user approval. This record changed no repository implementation file. It staged, committed and pushed nothing.

## Track 08 workflow-split artifact relocation

Relocated the final Track 08 workflow-split artifacts from `/tmp` into the persistent worktree. The move preserves review artifacts across temporary-directory cleanup and keeps them outside the implementation surface. The destination directory is outside `package.json`'s `files` whitelist.

- `track-artifacts/track-08-workflow-split/design.md`: 1,341 lines, 53,675 bytes, SHA-256 `d9da1c44cd3a17ecd0091a27468d04974519167fb41654e039d651c80f48a032`.
- `track-artifacts/track-08-workflow-split/retained-subsection.md`: 60 lines, 3,471 bytes, SHA-256 `44de0495f0f39c0775e55043e469255c4ea762194140c987c05a1fa2169f9050`.
- `track-artifacts/track-08-workflow-split/requirement-crosswalk.md`: 115 lines, 9,371 bytes, SHA-256 `793837edc665c25ad3c4bbc4688ed77dc39ca34a35397f7be9327339eee849fa`.

The design and crosswalk now use worktree-relative artifact paths. The retained subsection remains byte-identical to its required hash. Its embedded copy in `design.md` matches the standalone file byte-for-byte, including the trailing newline. The writing checker reports zero fail, warning, and house-style findings for all three moved files. Existing advisory findings remain diagnostic.

The three source paths no longer exist under `/tmp`. The physical worktree is `dogfood-sources` at commit `03b31fd`. Git status remains limited to untracked `research-log.md` and `track-artifacts/`. Nothing was staged, committed, or pushed.


## Decision Log (continued)

- D265: The final Track 08 amendment uses Option B1. This decision identifies the intended change worktree without transporting a direct working-log path.
- D266: The approved B1 design binds source bytes and Git project identity to the same worktree. This decision prevents two archive identities from naming different change roots.
- D267: The approved B1 design requires corpus resolution to use installed Pi's effective agent directory. This decision covers environment overrides and home-relative values.
- D268: The approved B1 design forbids corpus traversal through forbidden links or destination redirection. This decision states an outcome and selects no mechanism.
- D269: The approved B1 design requires a verified and durable copy for success. This decision keeps every failure non-destructive.
- D270: Trusted project configuration uses `workflow.archiveSourceMaxBytes`. The approved B1 default is 67,108,864 bytes, which equals 64 mebibytes.
- D271: The user selected configuration Option 2 for B1. A trusted project may lower or raise the finite source-byte limit.
- D272: A valid B1 limit is a positive safe integer. A missing value uses the default silently.
- D273: An invalid B1 limit warns once and uses the default. A trusted project that raises it accepts memory and availability risk.
- D274: The approved B1 design accepts Option A for the directory create-open interval. B1 protects conforming-worker collisions and identities after stable acquisition.
- D275: B1 excludes same-user replacement between directory creation and stable acquisition. The user accepts this create-open interval risk.
- D276: The approved B1 amendment keeps the archive layout, lifecycle policy, and publication policy unchanged. Generic worker sessions also remain unchanged.
- D277: Resolver, packaging, release-floor, and publication findings remain separate review-fix work. The approved B1 amendment does not absorb them.
- D278: The user gave final pre-implementation approval for the B1 amendment on 2026-08-26. Implementation may proceed only under the approved scope.

## Track 08 Option B1 design-review record

The user approved the concise B1 direction.

This approval established the B1 design basis before the final gate.

Adversarial review t322.e1 raised AD980, AD981, and AD982.

AD980 related to B1 because its source-byte bound lacked a named resource, unit, and value.

AD981 related to B1 because its accepted create-open threat boundary was absent.

AD982 related to B1 because corpus resolution did not require parity with installed Pi.

The user accepted Option A for the B1 create-open interval.

The user accepted installed Pi parity for B1 corpus resolution.

The user accepted a configurable B1 default of 64 mebibytes.

The user selected configuration Option 2 for B1.

Configuration Option 2 permits a trusted project to raise or lower the B1 source-byte limit.

Gate t325.e1 VERIFIED AD980, AD981, and AD982 against the final B1 design.

Gate t325.e1 found no B1 design regression.

The accepted B1 risk covers same-user replacement after directory creation and before stable acquisition.

The final B1 design makes no protection claim for that interval.

The user gave final pre-implementation approval on 2026-08-26.

No B1 design approval question remains open.

## Decision Log (continued)

- D279: The user approved delivery-time configuration authority for each new archive task before implementation.
- D280: The trusted session project remains the exclusive authority for `workflow.archiveSourceMaxBytes`.
- D281: Each new task receives one complete configuration read and one copied finite source-byte limit.
- D282: A later configuration change may affect a later task but cannot alter an existing task.
- D283: The B1 default remains 67,108,864 bytes. A trusted project may lower or raise it.
- D284: A valid configured limit is a positive safe integer.
- D285: Missing, unreadable, malformed, and wrong-shaped configuration use the default and produce one warning.
- D286: An inherited setting is ignored as a missing own setting. Unknown settings cannot affect the selected limit.
- D287: An invalid own value uses the default and produces one warning that states the reason and selected default.
- D288: The intended change worktree remains authoritative for source bytes and Git project identity.
- D289: Pi parity, the accepted create-open interval, doctrine identity, generic workers, and archive layout remain unchanged.
- D290: Executable transport coverage and doctrine identity coverage remain verification work and do not expand the product goal.
- D291: The amendment clarifies the approved goal rather than changing it. It changes configuration timing and the missing-setting warning rule.
- D292: Adversarial review t364.e1 returned PASS with no findings.

## Track 08 delivery-time authority review record

The user gave pre-implementation approval for the delivery-time configuration-authority amendment.

The amendment makes the trusted session project authoritative at archive-task creation time.

The amendment keeps the intended change worktree authoritative for source bytes and Git project identity.

The amendment covers missing, unreadable, malformed, wrong-shaped, inherited, unknown, and invalid configuration cases.

The amendment requires one copied task value and rejects rereading configuration after task creation.

The amendment preserves Pi parity, the accepted create-open interval, byte-identical doctrine, generic workers, and archive layout.

The amendment keeps transport and doctrine coverage outside the product goal.

Adversarial review t364.e1 checked the Goal, Approach, Acceptance criteria, Risks, and Non-goals.

Adversarial review t364.e1 confirmed task immutability and session-project authority.

Adversarial review t364.e1 confirmed worktree identity, Pi parity, doctrine identity, generic-worker invariance, archive-layout invariance, and the accepted create-open interval.

Adversarial review t364.e1 found no findings and returned PASS.

The amendment is a clarification, not a goal change.


## Decision Log (continued)

- D293: The final approved design defines one stable logical Slate session per change.
- D294: The external namespace is the sole authority for live and historical Slate state.
- D295: Explicit adoption preserves one namespace and requires a clean recipient.
- D296: Discovery metadata is advisory, and project-independent lookup provides read-only historical access.
- D297: Delivery and abandonment close the logical session for project work.
- D298: Each logical change fixes its policy at start, and adoption inherits that policy.
- D299: The final design retires the root-owned working log and namespace-per-adoption. It also retires mandatory delivery archive mechanics and lifecycle gates, `workflow.archiveSourceMaxBytes`, and Option B1 source selection.
- D300: Publishing content policy remains unchanged.
- D301: The user gave final pre-implementation approval for the complete design on 2026-08-26.

## Planned changes (continued)

### Final approved high-level design

# Revised high-level design

## Goal

One logical Slate session represents one change.

Independent logical Slate sessions are separate Slate records for separate changes. Several independent sessions may run concurrently from one canonical current directory. Slate hosts each logical session in its own Pi session. Slate supports concurrent independent sessions. Slate does not support concurrent modification of current-directory files.

The minted Slate name and identifier define its durable identity. The name and identifier remain stable throughout the change.

Slate names one canonical current directory as the working context and continuation guard. The current directory does not define identity.

Explicit linear adoption hands one logical Slate session from one Pi session to one successor. Sequential Pi sessions use explicit linear adoption in the same canonical current directory. Adoption preserves one logical Slate session namespace.

The external corpus project is Slate storage outside the current directory. The logical namespace is the durable Slate record.

The external namespace alone authoritatively records live and historical Slate state. The main Pi transcript authoritatively records only its conversation. Pi-held Slate state cannot supersede the external namespace.

Each independent session has its own stable name, identifier, and external namespace. Each namespace contains distinct threads, episodes, observations, healthy worker transcripts, handoff state, and research log.

Slate keeps the namespace readable after current-directory removal. Removal ends writable continuation. Project-independent lookup provides read-only access by stable Slate name and identifier.

## Approach

### Preserve one authoritative logical namespace

Create one logical Slate session for each new change. Keep its minted name and identifier through every sequential adoption.

Adoption preserves the namespace and all Slate data. Preserved data includes threads, episodes, observations, healthy worker transcripts, and the research log.

Adoption also preserves handoff state and other session records. The Pi writer is the active Pi session that writes the namespace. Adoption changes only the Pi writer and active Pi transcript.

The external namespace remains the sole authority before, during, and after adoption. Pi-held Slate state may support the active experience. Pi-held Slate state never becomes a competing canonical record.

Support linear handoff only. The latest handoff replaces the previous checkpoint.

The mainline writer is the Pi writer that advances the linear change. Allow one active mainline writer. Keep the single-writer rule as an extension invariant without heavy enforcement.

### Require a clean adoption recipient

Adoption requires a successor with no user-created canonical Slate data. The successor does not become an independent logical session before adoption completes.

Adoption refuses when the successor already owns canonical work. Adoption never merges or overwrites logical sessions.

Adoption does not leave or create an unused sibling logical session. The design does not prescribe how Slate represents pre-adoption recipient state.

### Support isolated same-directory sessions

Allow several independent logical Slate sessions to run concurrently from the same canonical current directory. Host each logical session in its own Pi session.

Keep each session's stable name, identifier, external namespace, threads, episodes, and observations distinct. Keep its healthy worker transcripts, handoff state, and research log distinct.

A sibling session is an independent logical Slate session in the same canonical current directory. Slate must not merge, inject, or overwrite sibling session data.

`/slate sessions` may expose sibling discovery metadata. Sibling discovery metadata identifies possible sibling sessions without loading their data. No sibling data enters another session's working context.

Discovery metadata is advisory and can become stale. Every state-changing operation revalidates authoritative namespace state. Discovery never authorizes adoption or writer transfer.

The project writer is the one Pi session allowed to modify current-directory files. Apply one directory-wide project-writer boundary across all independent sessions. At most one Pi session may serve as project writer.

A project-read-only Pi session leaves current-directory files unchanged. Every Pi session other than the project writer is project-read-only. A project-read-only session may still write all canonical data to its own external namespace.

Project-read-only sessions may research or create initial designs for upcoming changes. Readers may observe the project writer's in-progress filesystem changes. Filesystem snapshot isolation would give each reader a stable project-file view. Slate provides no filesystem snapshot isolation.

Directory-wide project-writer exclusion allows at most one project writer across independent sessions. The exclusion is an unenforced invariant. Slate does not coordinate or enforce the exclusion.

The directory-wide boundary governs current-directory files across independent sessions. The existing single-mainline-writer invariant governs linear namespace progress within one logical session.

### Keep the current directory as the work boundary

Slate performs project work only in the canonical current directory. Slate does not direct work into another project directory.

Explicit adoption requires the same canonical current directory. Another directory cannot continue the logical session.

The extension source may come from another directory. The extension source location affects extension loading only.

The extension source does not select trust, configuration, project context, session identity, worker context, or delivery context.

Git branches and worktrees do not define logical identity. Git branches and worktrees also do not authorize continuation.

### Treat the namespace as the durable record

Keep every canonical Slate session artifact in the external namespace. Keep no canonical Slate artifact in the current directory.

The session-owned research log remains part of the durable record. The research log remains after delivery and abandonment.

Delivery and abandonment close the logical session for project work. The external namespace records the terminal outcome.

The external namespace and research log remain as a historical read-only record after closure. No Pi writer or project writer continues after closure.

Slate does not delete the research log during delivery cleanup. Slate adds no automatic session-data pruning in this change.

Keep `/slate sessions` as the existing discovery surface. Add no new discovery command.

Use `/slate sessions` for project-independent, read-only lookup by stable Slate name and identifier. The lookup does not load project context.

The lookup does not authorize adoption, project work, writer transfer, or writable continuation. Every state-changing operation uses authoritative namespace state instead of discovery metadata.

Current-directory removal leaves the namespace available through that read-only lookup. Removal does not authorize continuation from another directory.

### Remove delivery archive support

Publishing and delivery continue to use the session-owned research log. Publishing and delivery retain existing content responsibilities.

Publishing content policy remains unchanged.

Delivery does not copy Slate data. Delivery does not prompt users about historical copies or archive destinations.

Remove mandatory archive creation and archive verification. Remove archive waivers, archive cleanup gates, archive prompts, and archive destinations.

Remove archive source selection and archive size limits. Remove `workflow.archiveSourceMaxBytes` from the current product design.

Retire the archive decision table and abandonment withdrawal gates. Retire the archive restart sequence and log-only reuse exception.

Retire ready-for-review archive ordering and the pre-publication archive prohibition. No archive lifecycle gate remains in delivery, abandonment, restart, review, or publication.

Retire Option B1, the historical archive source approach. Retire all sibling-worktree and intended-worktree selection mechanics from that approach.

Pi remains responsible for main Pi transcript storage. Slate does not copy or bundle that transcript in this change.

Developers may request manual copies through project guidelines. Slate provides no command, verification, or special support for those copies.

### Apply the policy prospectively

Fix the logical session policy when the logical change starts. Adoption inherits the source policy.

Historical sessions retain their historical policy. No adoption silently migrates a historical session.

Do not migrate existing sessions, historical namespace lineages, or root-owned logs. Old records retain their historical structure. New records follow this design.

Record the correction through a new superseding decision. Preserve every earlier decision as historical evidence.

The new decision supersedes these earlier choices:

- The root-owned working research log.
- A new namespace for each adoption.
- Mandatory delivery archive creation and verification.
- The archive waiver and archive cleanup flow.
- The archive decision table.
- The abandonment withdrawal gates.
- The archive restart sequence.
- The log-only archive reuse exception.
- Ready-for-review archive ordering.
- The pre-publication archive prohibition.
- The `workflow.archiveSourceMaxBytes` setting.
- All Option B1 archive source-selection mechanics.

The superseding decision must not rewrite history. The decision must state that publishing content policy remains unchanged.

## Key decisions

- One minted Slate name and identifier define one logical session.
- One logical session represents one change.
- Several independent logical sessions may run concurrently from one canonical current directory.
- Each independent logical session runs in its own Pi session and keeps distinct canonical data.
- Slate keeps sibling session data out of every other session's working context.
- At most one project writer may modify current-directory files across the independent sessions.
- Other Pi sessions remain project-read-only while writing canonical data to their own namespaces.
- Directory-wide project-writer exclusion remains an unenforced invariant.
- Filesystem snapshot isolation remains outside Slate's guarantees.
- The directory-wide project-writer boundary differs from each session's single-mainline-writer invariant.
- Explicit linear adoption preserves one namespace across sequential Pi sessions.
- Adoption requires a successor without user-created canonical Slate data.
- A successor becomes a logical session only after adoption completes.
- Adoption refuses canonical-work conflicts and never merges logical sessions.
- The current directory guards continuation but does not define identity.
- The extension source does not select project or session context.
- The external namespace is the sole authority for live and historical Slate state.
- The main Pi transcript is authoritative only for its conversation.
- Discovery metadata is advisory and never grants state-changing authority.
- Project-independent lookup provides historical read access without project context or continuation authority.
- Delivery and abandonment close the logical session for project work.
- The session-owned research log remains as part of the historical read-only record.
- Delivery creates no Slate archive or historical copy.
- Pi continues to own main Pi transcript storage.
- One mainline writer remains an extension invariant.
- Each logical change keeps the policy set at its start.
- Adoption inherits policy and never silently migrates historical sessions.

## Acceptance criteria

- A new change receives one logical Slate session.
- Several independent logical Slate sessions can run concurrently from the same canonical current directory.
- Each independent logical session has its own Pi session.
- Each independent session keeps a distinct stable name, identifier, and external namespace.
- Each session keeps distinct threads, episodes, observations, healthy worker transcripts, handoff state, and research log.
- Slate does not merge, inject, or overwrite sibling session data.
- `/slate sessions` may expose advisory sibling discovery metadata without loading sibling data.
- Discovery metadata may become stale.
- No sibling session data enters another session's working context.
- Every state-changing operation revalidates authoritative namespace state.
- Discovery authorizes no adoption or writer transfer.
- At most one Pi session across the independent sessions modifies current-directory files.
- Every other Pi session leaves current-directory files unchanged.
- Project-read-only sessions still write canonical data to their own external namespaces.
- Project-read-only sessions can research or create initial designs for upcoming changes.
- Readers can observe the project writer's in-progress filesystem changes.
- Slate provides no filesystem snapshot isolation.
- Directory-wide project-writer exclusion requires no enforcement for acceptance.
- The directory-wide boundary does not replace the single-mainline-writer invariant within each logical session.
- The session receives one minted Slate name and identifier.
- Explicit adoption in the same current directory preserves both values.
- Adoption preserves the namespace and all canonical Slate data.
- Preserved data includes threads, episodes, observations, healthy worker transcripts, the research log, and handoff state.
- Adoption changes only the Pi writer and active Pi transcript.
- The latest handoff becomes the current checkpoint.
- Branching adoption remains unsupported.
- One active mainline Pi session writes the namespace.
- No heavy writer enforcement becomes necessary for acceptance.
- Adoption requires a successor without user-created canonical Slate data.
- The successor is not an independent logical session before adoption completes.
- Adoption refuses when the successor already owns canonical work.
- Adoption neither merges nor overwrites logical sessions.
- Adoption leaves no unused sibling logical session.
- The external namespace alone authoritatively records live and historical Slate state.
- Pi-held Slate state cannot supersede the external namespace.
- The main Pi transcript remains authoritative only for its conversation.
- Slate performs project work only in the canonical current directory.
- Another current directory cannot continue the logical session.
- A separate extension source does not change project or session context.
- Every canonical Slate session artifact resides outside the current directory.
- Current-directory removal leaves the namespace readable by stable Slate name and identifier.
- `/slate sessions` provides project-independent, read-only lookup without loading project context.
- Read-only lookup authorizes no adoption, project work, writer transfer, or writable continuation.
- Current-directory removal ends writable continuation.
- Delivery and abandonment close the logical session for project work.
- No Pi writer or project writer continues after closure.
- The namespace and research log remain as a historical read-only record.
- Publishing and delivery use the research log for existing content responsibilities.
- Publishing content policy does not change.
- Delivery creates no Slate-data copy.
- Delivery presents no archive prompt or historical-copy notice.
- The product requires no archive destination, waiver, verification, source selection, or size limit.
- Archive decision, withdrawal, restart, reuse, review-ordering, and publication-ordering gates no longer apply.
- The current product design contains no `workflow.archiveSourceMaxBytes` setting.
- Slate does not copy or bundle the main Pi transcript.
- `/slate sessions` remains the discovery surface.
- Slate performs no automatic pruning.
- Each logical change sets its logical session policy at its start.
- Adoption inherits the source policy.
- Historical sessions retain historical policy.
- No adoption silently migrates a historical session.
- Existing sessions, namespace lineages, and root logs remain unchanged.
- The superseding decision names every retired choice without altering historical decisions.

## Risks

- A stale Pi session can write after adoption if users violate the single-writer invariant.
- Two independent Pi sessions can modify project files if users violate the directory-wide project-writer invariant.
- A project-read-only session can observe incomplete filesystem changes from the project writer.
- A defect can leak sibling session data or overwrite another session's data.
- Discovery metadata can become stale before a state-changing operation revalidates authoritative state.
- A replayed handoff can create an unsupported competing successor.
- Current-directory removal can end continuation before work finishes.
- Users may mistake durable read access for permission to continue elsewhere.
- Unauthorized later writes can alter a historical record after delivery or abandonment.
- The durable namespace has no automatic secondary archive.
- Namespace damage or manual deletion can remove the only Slate-owned record.
- Main Pi transcripts remain separate from the Slate namespace.
- Indefinite retention can increase storage use and retain sensitive project history.
- Old and new sessions will coexist under different historical policies.
- Slate does not verify manual copies, so they can become incomplete or stale.
- Same-path project replacement can associate old namespace data with an unrelated project.

Slate accepts these risks as design boundaries. Slate must not claim stronger guarantees than this design provides.

## Rejected alternatives

### New namespace after each adoption

A new namespace after each adoption fragments one change. The new namespace separates data that belongs to one logical session.

### Recipient data merge or replacement

Recipient data merge would combine separate canonical work. Recipient replacement would destroy canonical work that already belongs to another logical session.

### Pi-held Slate state as a competing authority

Competing Slate authority would leave readers unable to identify the canonical record. The external namespace provides one authority across Pi sessions.

### Root-owned working log

A root-owned working log ties canonical evidence to a removable directory. The root-owned log can also create contention between unrelated sessions.

### Mandatory delivery archive

The durable namespace already holds the canonical Slate record. A required delivery copy adds duplicate policy and cleanup complexity.

### Archive waiver and cleanup flow

The no-archive decision removes the archive requirement. A waiver and cleanup gate no longer have a requirement to waive.

### Option B1 source selection

Session-owned data removes the need for sibling-worktree or intended-worktree selection. Source selection would preserve avoidable ambiguity.

### Automatic historical migration

Historical sessions can follow different policies. Automatic consolidation could damage provenance or choose the wrong source.

### Heavy writer enforcement

Locks, leases, revocation, forced shutdown, and single-use controls exceed this correction. The extension invariant defines the accepted boundary.

Directory-wide locks, leases, and writer coordination also exceed this correction. Directory-wide project-writer exclusion remains an unenforced invariant.

Terminal write prevention through heavy enforcement also exceeds this correction. The historical read-only rule defines the accepted boundary.

## Follow-up issue

A future `/slate archive` command may create a historical bundle. The bundle may combine the main Pi transcript with logical Slate session data.

The project defers the command. The current product design does not include the command.

## Non-goals

- Adding a delivery archive prompt or historical-copy notice.
- Verifying developer-requested manual copies.
- Adding `/slate archive` now.
- Copying or bundling the main Pi transcript now.
- Adding automatic pruning or retention cleanup.
- Migrating existing sessions, historical namespace lineages, root logs, or artifacts.
- Silently migrating a historical session during adoption.
- Supporting branching adoption or parallel mainline writers.
- Merging or replacing canonical recipient work during adoption.
- Prescribing the representation of pre-adoption recipient state.
- Supporting concurrent project-file modification by two independent Slate sessions or their Pi sessions.
- Enforcing directory-wide project-writer exclusion.
- Providing filesystem snapshot isolation for project-read-only sessions.
- Merging, injecting, or overwriting sibling session data.
- Loading sibling session data into another session's working context.
- Making discovery metadata authoritative or snapshot-consistent.
- Letting discovery authorize adoption or writer transfer.
- Adding heavy writer enforcement, revocation, or single-use handoffs.
- Enforcing terminal read-only state through locks, leases, or forced shutdown.
- Continuing one logical session from a different current directory.
- Using project-independent lookup for adoption, project work, or writable continuation.
- Directing project work into another directory.
- Adding another session-discovery command.
- Restoring mandatory archive creation, verification, waivers, destinations, or cleanup gates.
- Restoring archive decision, withdrawal, restart, reuse, review-ordering, or publication-ordering gates.
- Restoring archive source selection or archive size limits.
- Selecting sibling worktrees or intended worktrees as archive sources.
- Providing special Slate support for manual copies.
- Changing publishing content policy.
- Changing Pi transcript ownership, storage, history, or fork behavior.
- Letting Pi-held Slate state supersede the external namespace.
- Consolidating historical namespaces or merging divergent logs.
- Continuing a logical session across separate clones or corpus projects.
- Adding special identity behavior for branch rename, branch reuse, or detached state.
- Adding stronger project-replacement detection, corpus authentication, or trust redesign.
- Guaranteeing writable continuation after current-directory removal.

## Open questions

No open question blocks this scope.


### Final design gate record

Applicable workflow rule-set: the installed Track-based development workflow. Rule-set version: current installed revision, because the document declares no numeric version. The project uses `workflow.draftPRs` enabled.

Completed gates:

- Risky change class approval.
- Pre-adversarial design approval.
- Adversarial review and disposition of every finding.
- Final pre-implementation design approval.
- Gate review with no regression findings.

Design review (pre-adversarial): user-approved — 2026-08-26

Adversarial review: passed, 1 accepted risk — 2026-08-26

Adversarial finding dispositions:

- WC1: Strengthen.
- WC2: Strengthen.
- WC3: Strengthen.
- WC4: Strengthen. Accepted residual product risk: unauthorized terminal writes.
- WC5: Strengthen.
- CN1: Strengthen.
- CN2: Strengthen.
- CN3: Accept as risk. Accepted risk: stale advisory discovery metadata before authoritative revalidation.
- WI1: Strengthen.
- WI2: Strengthen.

Design review (pre-implementation): user-approved — 2026-08-26

## Decision Log (continued)

- D327: Track 08 is abandoned because its mandatory delivery-archive implementation was superseded by the final approved logical-session design before review. The uncommitted archive code, configuration, doctrine, documents, package paths, and verification contracts will not land. Its historical artifacts remain unchanged. Tracks 09 through 15 replace Track 08 with ordered retirement, namespace foundation, runtime integration, stable handoff and adoption, project-independent discovery, namespace-owned logging and terminal records, and final doctrine, guidance, acceptance, manual, and repository verification work. These tracks implement the approved design without restoring mandatory archives, archive waivers, archive cleanup, or archive lifecycle gates.
- D328: Track 09 reached Awaiting user review after the final gate verified archive retirement, retained workflow safeguards, publishing order, headless warning absence, and independent verification rosters. No suggestion remains, and no lower-priority issue requires a follow-up issue.

## Track 09 review record

Track 09 retires the superseded delivery-archive contract. It removes the uncommitted archive implementation, configuration, doctrine, document, package path, and verification contracts. It preserves publishing content policy, delivery, abandonment, session names, command registration, and the retained workflow.

### Finding ledger

| Finding | Reviewer severity | Validated severity | Validation reason | Reviewer episode | Canonical observation path | Fix status | Closing gate evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TQ1 | should-fix | should-fix | Restored archive behavior passed the first doctrine checks. A headless-only archive warning also passed the first two gates. The final headless matrix rejected that warning. | t415.e1, t420.e1, t423.e1 | `.pi/slate/observations/t423.e1.md` | Fixed | Final gate t423.e1 injected a headless archive warning. The unit and strict resolver checks failed. |
| TQ2 | should-fix | should-fix | The first contract check covered the primary publishing sequence but not the post-change sequence. The final exact assertion rejected removal of the post-change acceptance clause. | t415.e1, t420.e1, t423.e1 | `.pi/slate/observations/t423.e1.md` | Fixed | Final strict resolver gate rejected a mutation that removed only the post-change acceptance sentence. |
| WI1 | should-fix | should-fix | Abandonment could remove the worktree and destroy the stated durable record without informed user approval. | t416.e1, t420.e1 | `.pi/slate/observations/t420.e1.md` | Fixed | The first contract gate verified informed confirmation, record-loss disclosure, worktree retention, user-arranged copies, and no Slate-managed copy support. |
| TS1 | should-fix | should-fix | Deleting the rule-eight doctrine test left the suite green because it had no independent test roster. | t417.e1, t421.e1 | `.pi/slate/observations/t421.e1.md` | Fixed | The roster gate made the deletion fail and verified all 13 expected tests in order. |
| WH1 | should-fix | should-fix | Deleting the package-content mutation case left its self-test green because it had no independent mutation roster. | t417.e1, t421.e1 | `.pi/slate/observations/t421.e1.md` | Fixed | The roster gate made the missing-document-export deletion fail through the independent case roster. |
| WH2 | should-fix | should-fix | Deleting the files-docs packaging guard and its mutation left both modes green without an independent guard roster. | t417.e1, t421.e1 | `.pi/slate/observations/t421.e1.md` | Fixed | The roster gate made both normal and self-test deletions fail through independent guard and mutation rosters. |
| WH3 | should-fix | should-fix | Deleting the L8 load-check verdict left the harness green because it did not reconcile declared and reported checks. | t417.e1, t421.e1 | `.pi/slate/observations/t421.e1.md` | Fixed | The roster gate made the deletion fail with missing L8. |
| WH100 | should-fix | should-fix | A renamed copy, hash, and waiver obligation passed heading-only workflow checks. | t418.e1, t420.e1 | `.pi/slate/observations/t420.e1.md` | Fixed | The first contract gate verified content-pattern rejection of archive-equivalent policy. |
| WH101 | should-fix | should-fix | Removing handoff, log-retention, or release-roster safeguards stayed green without dedicated retained-safety checks. | t418.e1, t420.e1 | `.pi/slate/observations/t420.e1.md` | Fixed | The first contract gate verified handoff, log retention, release roster, and primary publishing safeguards. |
| RG1 | blocker | blocker | Both initial doctrine harnesses forced visible mode and missed a headless-only warning path. | t420.e1, t423.e1 | `.pi/slate/observations/t423.e1.md` | Fixed | Final gate t423.e1 verified `hasUI: true` and `hasUI: false` coverage and rejected the headless warning mutation. |

The first contract gate verified WI1, WH100, and WH101. It left TQ1 and TQ2 open and filed RG1. The roster gate verified TS1, WH1, WH2, and WH3. Final gate t423.e1 verified TQ1, TQ2, and RG1 with no new findings.

### Closing verification

- Writing checker: 45 records, 949 words, zero fail-level findings, and one warning.
- Typecheck: passed.
- Doctrine contract suite: 13 passed.
- Strict resolver checks: 226 passed.
- Packaging checks and self-tests: passed.
- Package-content checks and self-tests: passed.
- Extension load check: 15 passed.
- Size-grade suite: 24 passed.
- Node test suite: 411 passed.
- Git diff check: passed.
- Coverage gate: skipped because the diff remains uncommitted.

The final gate used temporary mutations for the headless warning and post-change publishing sequence. Both mutations failed. Prior gates verified the other finding-specific mutations. No suggestion remains, and no lower-priority issue requires a follow-up issue.

## Decision Log (continued)

- D329: The user approved Track 09 on 2026-08-26. Implementation commit `a2408878337f59ed1effd2673b785b5e52e1547c` and empty marker `f03f171a444fa1a272daa44dde39e1d4f2bc8449` complete the approved archive-retirement scope. Coverage evidence is `OVERALL: lines 3/3=100.00%; branches 0/0=n/a`. The result is `VERDICT: WARN` because the branch denominator is zero. Manual disposition: Track 09 added no executable branch, all three changed executable lines were covered, and no changed path remained uncovered.

## Track 10 review record

Track 10 adds the authoritative external namespace foundation, the immutable new-policy boundary, state validation, durable publication, and focused storage tests. The review cycle found and closed every recorded finding. The final gates found no regression.

### Finding ledger

| Finding | Reviewer severity | Validated severity | Counterexample | Fix summary | Reviewer episode | Canonical observation path | First gate outcome | Final gate evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BG1 | blocker | blocker | Publication removed `state.json`, yet creation returned success with an incomplete namespace. | Validate every required record and directory before and after publication. | t431.e1 | `.pi/slate/observations/t431.e1.md` | t436 verified BG1. | t440 rechecked the validation guard with no regression. |
| BG2 | blocker | blocker | A hook changed `currentDirectory` before the generation recheck, yet generation one committed. | Compare all immutable metadata with the opened record before replacement. | t431.e1 | `.pi/slate/observations/t431.e1.md` | t436 verified BG2. | t440 rechecked metadata revalidation with no regression. |
| BG3 | should-fix | should-fix | Two different names claimed one stable identifier and both creations succeeded. | Scan existing namespaces and refuse duplicate identifier claims before publication. | t431.e1 | `.pi/slate/observations/t431.e1.md` | t436 verified BG3. | t440 rechecked identity exclusion with no regression. |
| CQ1 | should-fix | should-fix | A forced state-write failure left a private `.state-*` temporary file. | Stage failed state writes in the project directory, outside the authoritative namespace. | t431.e1 | `.pi/slate/observations/t431.e1.md` | t436 left CQ1 open. | t440 verified authoritative bytes stay unchanged, residue stays private, and later updates succeed. |
| TQ1 | should-fix | should-fix | The write-failure test required one orphan and could not detect missing cleanup. | Require zero authoritative `.state-*` files, private residue rejection, and a later successful update. | t431.e1 | `.pi/slate/observations/t431.e1.md` | t436 left TQ1 open. | t440 verified the rewritten test fails when staging or residue protections are removed. |
| CN1 | blocker | blocker | A pathname swap between identity check and unlink deleted authoritative state. | Remove pathname deletion and retain failed private staging after descriptor close. | t432.e1 | `.pi/slate/observations/t432.e1.md` | t437 verified CN1. | t440 rechecked that no pathname deletion exists and swap attacks preserve both records. |
| CN2 | should-fix | should-fix | Repeated synchronous random failures leaked one namespace descriptor per attempt. | Draw the staging nonce before opening the namespace descriptor. | t432.e1 | `.pi/slate/observations/t432.e1.md` | t437 verified CN2. | t440 rechecked failure ordering and the bounded writer race with no regression. |
| SE1 | blocker | blocker | A hard link outside the corpus changed authoritative state, which later reads accepted. | Require a single link for records at reads, writes, rechecks, and publication. | t433.e1 | `.pi/slate/observations/t433.e1.md` | t438 verified SE1. | t440 rechecked link-count validation with no regression. |
| SE2 | should-fix | should-fix | A hook replaced staged `state.json` with an outside link, yet creation reported success. | Revalidate both records and required child directories before and after rename. | t433.e1 | `.pi/slate/observations/t433.e1.md` | t438 verified SE2. | t440 rechecked pre-publication and post-publication validation with no regression. |
| TS100 | blocker | blocker | A forged project path escaped the digest child when path confinement was removed. | Keep direct-child digest confinement and add a forged-project regression test. | t434.e1 | `.pi/slate/observations/t434.e1.md` | t438 verified TS100. | t440 rechecked confinement and the mutation test with no regression. |
| TS101 | should-fix | should-fix | The current-directory test hit project rejection instead of the exact-directory guard. | Use a same-project nested Git directory and require the exact refusal. | t434.e1 | `.pi/slate/observations/t434.e1.md` | t438 verified TS101. | t440 rechecked the targeted branch test with no regression. |
| TS102 | blocker | blocker | Replacing the staged namespace during the hook bypassed the missing identity check in a weakened copy. | Assert staged-directory identity before publication and test replacement through the hook. | t434.e1 | `.pi/slate/observations/t434.e1.md` | t438 verified TS102. | t440 rechecked staged replacement rejection with no regression. |
| TS103 | should-fix | should-fix | Removing the production fsync fallback left the hook-backed ordering test green. | Exercise the production fallback and assert its observed fsync source. | t434.e1 | `.pi/slate/observations/t434.e1.md` | t438 left TS103 open. | t440 verified the fallback through typecheck and the focused sync-source assertion. |
| TS104 | should-fix | should-fix | Fixture setup failure leaked its temporary directory and changed environment. | Restore the environment and remove partial fixtures before rethrowing setup errors. | t434.e1 | `.pi/slate/observations/t434.e1.md` | t438 verified TS104. | t440 rechecked both cleanup mutations with no regression. |

The first review t431 recorded BG1, BG2, BG3, CQ1, and TQ1. The first gate t436 verified BG1, BG2, and BG3, but left CQ1 and TQ1 open. Review t432 recorded CN1 and CN2. Gate t437 verified both findings. Review t433 recorded SE1 and SE2. Review t434 recorded TS100 through TS104. Gate t438 verified SE1, SE2, TS100, TS101, TS102, and TS104, but left TS103 open. Final gate t440 verified CQ1, TQ1, and TS103 and found no regression.

### Closing verification

- Finding roster: BG1, BG2, BG3, CQ1, TQ1, CN1, CN2, SE1, SE2, TS100, TS101, TS102, TS103, and TS104.
- Severity roster: blockers BG1, BG2, CN1, SE1, TS100, and TS102. Should-fix findings BG3, CQ1, TQ1, CN2, SE2, TS101, TS103, and TS104.
- Typecheck: passed.
- Focused session-record tests: 31 passed.
- Full unit tests: 443 passed.
- Strict resolver checks: 226 passed.
- Packaging checks and self-tests: passed.
- Package-content checks and self-test: passed.
- Extension load check: 15 passed.
- Writing checker: passed on the reviewed source diff.
- Git diff check: passed.
- Final gate: t440 verified the remaining findings and found no regression.

No suggestion remains. No lower-priority item requires a follow-up issue.

## Decision Log (continued)

- D330: Track 10 reached Awaiting user review after t436 verified BG1, BG2, and BG3, t437 verified CN1 and CN2, t438 verified SE1, SE2, TS100, TS101, TS102, and TS104, and t440 verified CQ1, TQ1, and TS103 with no regression. All blockers and should-fix findings retain their validated severities. No suggestion remains, and no lower-priority item requires a follow-up issue.
- D331: The user approved Track 10 on 2026-08-26 after reviewing the complete implementation and verification packet. The implementation commit `cbea2de07c794e26ae0b6c74d345bf4b563e4818`, one-line test correction commit `143fed00e9349d4d5f7dc426de3456863aadd387`, and empty completion marker `cbc60500dd874c4aa9a0bd33283b5433e56927a0` complete the approved scope. The user separately approved the one-line correction after its review found no findings. The first coverage run targeted the wrong linked worktree and was discarded. The valid pre-correction run passed 443 tests and typecheck but failed the branch floor at 260/306, or 84.97%, against 85.00%. The correction added the mismatched-namespace test case and the review confirmed behavioral coverage with no production change. Final committed verification passed typecheck, 443 tests, line coverage at 535/582, or 91.92%, and branch coverage at 262/307, or 85.34%. The final result was `RUN VERDICT: PASS — tests passed and coverage gate accepted the patch`. The marker was pushed non-force, and `origin/dogfood-sources` equals `cbc60500dd874c4aa9a0bd33283b5433e56927a0`. This untracked workflow record is not committed or shipped.
- D332: The user approved the Track 11 high-level design on 2026-08-27. The user also approved the final terminology and scope confirmations. The external namespace remains the sole new-policy authority. The Pi binding record remains a locator without authority. Fresh binding stays delayed until the first canonical mutation. Option B remains the approved session and namespace relationship. The ephemeral Pi-session boundary remains explicit, with no automatic-continuation guarantee. The advisory sibling-discovery clarification allows Track 13 to locate a namespace for read-only inspection after binding loss. It does not allow writable continuation or adoption.

The initially approved artifact is `track-artifacts/track-11-runtime-authority/design.md`. Its source path was `/tmp/track11-high-level-design-approved.md`. Its initial SHA-256 was `135af14cf0f1746d91eb27b97e6d3eea9fbcbf52c52df97d0924cc7940433c97`. The initial artifact had 15599 bytes, 247 lines, and 2266 whitespace words. The design review resolved WC1, CN1, CN2, CN3, CN4, and WI200. One invalid extraction review was discarded. Final gates found no new findings. The writing checker passed with zero fail findings. Implementation had not started. This workflow record and the design artifact are untracked and not shipped.

## Track 11 implementation review record

- D333: The user selected option 1. Track 11 keeps its authority goal. Broad runtime performance and memory optimization remains deferred.

### Deferred follow-up suggestions

| Finding | Deferred suggestion | Follow-up issue |
| --- | --- | --- |
| PF1 | Reduce repeated full-runtime copying at callback boundaries. | [#261](https://github.com/JetBrains/ytdb-slate/issues/261) |
| PF2 | Remove superlinear restart and episode graph validation. | [#261](https://github.com/JetBrains/ytdb-slate/issues/261) |
| PF3 | Avoid full-runtime text allocation during durable state comparisons. | [#261](https://github.com/JetBrains/ytdb-slate/issues/261) |
| CN12 | Consider hostile-getter reentry before legacy transaction capture. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE11 | Consider structurally equal callback replacement and later mutation. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE13 | Consider callback reference graphs, Map keys, and retained aliases. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE15 | Consider effectful caller-owned contexts and permit accessors. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE16 | Consider executable backend records and post-return alias mutation. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE17 | Consider hostile Pi-entry iterators, Proxies, and accessors. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE18 | Consider inherited prototype properties on Pi entries. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE19 | Consider executable accessors inside public runtime Maps and arrays. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE20 | Consider hidden methods installed on public runtime Maps. | [#260](https://github.com/JetBrains/ytdb-slate/issues/260) |
| SE21 | Consider duplicate JSON names before standard parsing. | [#262](https://github.com/JetBrains/ytdb-slate/issues/262) |
| TQ6 | Consider tests for retained callback aliases after return. | [#259](https://github.com/JetBrains/ytdb-slate/issues/259) |
| TQ10 | Consider freeze assertions outside caught backend callbacks. | [#259](https://github.com/JetBrains/ytdb-slate/issues/259) |
| TS14 | Consider mutation tests for reference identity and Map-key changes. | [#259](https://github.com/JetBrains/ytdb-slate/issues/259) |
| TS15 | Consider mutation tests for the project-match freeze oracle. | [#259](https://github.com/JetBrains/ytdb-slate/issues/259) |

### Track 11 retained blocker fix outcomes

The trust-boundary clarification supersedes earlier closure claims for every row moved into the deferred table.

- RG1501 — resolved. Current valid active external generations now survive uncertain and late-failure reconciliation.
- RG1601 — resolved. A failed legacy restore observer no longer replaces selected-branch state with previous-branch state.
- TQ7 — resolved. A maintained test now protects selected-branch state after post-adoption observer failure.
- TQ8 — resolved. A maintained test now kills removal of legacy save whole-operation rollback.

### Track 11 trust-boundary clarification

- D334: The user approved persisted Slate evidence as plain data read from Pi or external JSON storage.
- D335: Same-process attackers, executable properties, prototype changes, modified built-ins, and pre-parse duplicate-name detection are non-goals.
- D336: The performance non-goal remains unchanged. PF1 through PF3 remain deferred.
- D337: Reference-graph rollback and callback object-identity restoration exceeded the approved trust boundary. The implementation removes both mechanisms.
- D338: Legacy save and restore guards now start before their first in-goal operation.
- D339: Failed legacy restoration clears prior-branch state after selection starts. It never reinstalls the pre-switch checkpoint.
- D340: Ordinary observer and reporter throws remain advisory after selected or committed state is installed.
- D341: New-policy external commits remain authoritative. Uncertain results still reconcile or make Slate unavailable.
- D342: The user approved the Track 11 implementation diff on 2026-08-27. The approved goal, trust boundary, design, and finding verdicts remain unchanged. Track 11 is not complete until the standalone ladder, commit, post-commit patch coverage, completion marker, and publication finish.
- D343: The strict standalone ladder passed in t551.e1. The pinned Pi 0.83.0 ran with exit 0. All 26 rungs passed, with 0 failures and 0 not-run rungs. SAFE CORPUS, SAFE PI, SAFE HOME, both SAFE SESSION checks, and SAFE REPO passed. NOTE REAL reported unchanged real-settings content. The repository fingerprint `7851971338a066a6058c8f773fc8b13c7750413d56d9458aec47befbc5d1f739` remained unchanged. Track 11 remains incomplete pending the implementation commit, post-commit patch coverage, completion marker, push, and pull request publication.
- D344: Post-commit verification passed in t554.e1 for commit `7bc903aac1a19b0ae88a6a6d0b0b65ca063e4156` against base `cbc60500dd874c4aa9a0bd33283b5433e56927a0`. The test suite passed 560 tests with 0 failures. Line coverage was 1481/1565, or 94.63 percent. Branch coverage was 525/594, or 88.38 percent. Both coverage floors were 85 percent. The overall verdict was PASS with no warning. The worktree was unchanged after verification. Track 11 remains incomplete pending the completion marker, push, and pull request publication.
- D345: Track 11 implementation commit `7bc903aac1a19b0ae88a6a6d0b0b65ca063e4156` was followed by empty completion marker `0e2e2eb1b850ee5976a78a0ef1be2bf934ac25fa`, whose parent is the implementation commit and whose exact subject is `Track 11 complete: runtime-authority`. Track 11 is complete locally. Push and pull request publication remain pending.
- D346: `origin/dogfood-sources` was pushed without force from `cbc60500dd874c4aa9a0bd33283b5433e56927a0` to `0e2e2eb1b850ee5976a78a0ef1be2bf934ac25fa`. Implementation commit `7bc903aac1a19b0ae88a6a6d0b0b65ca063e4156` sits directly before the marker. Track 11 is complete and pushed. Pull request publication remains pending only.
- D347: Draft pull request #211 was updated and verified at head `0e2e2eb1b850ee5976a78a0ef1be2bf934ac25fa`. Track 11 is marked complete and user-approved. The published record lists implementation commit `7bc903aac1a19b0ae88a6a6d0b0b65ca063e4156`, completion marker `0e2e2eb1b850ee5976a78a0ef1be2bf934ac25fa`, the strict ladder result of 26 pass, 0 fail, and 0 not run, 560 passing tests, 94.63 percent line coverage, and 88.38 percent branch coverage. Follow-up issues [#259](https://github.com/JetBrains/ytdb-slate/issues/259) through [#262](https://github.com/JetBrains/ytdb-slate/issues/262) remain linked. Tracks 12 through 15 remain pending. The pull request remains draft.

The deferred table records CN12 because its counterexample requires an executable getter on public store state.

The table records SE18 because inherited Pi-entry properties require same-process prototype construction or mutation.

The table records SE19 because its counterexample requires an executable array accessor inside public store state.

The table records SE20 because its counterexample requires a hidden method installed on a public Map.

The table records SE21 because duplicate-name detection requires a byte-level check before standard JSON parsing.

The table records TQ10 and TS15 because their only subject was a freeze defense outside the approved boundary.

The table records SE11 and the callback-isolation form of SE13 because both require retained same-process aliases.

The plain legacy graph checks previously associated with SE13 remain active because persisted JSON can violate them.

The table records the accessor form of SE15. Plain context, permit, identity, project, and directory checks remain active.

The table records the executable-record form of SE16. Plain external record schema and authority validation remain active.

The table records the iterator, Proxy, and accessor form of SE17. Malformed plain Pi evidence still causes refusal.

The table records TQ6 and TS14 because their mutations require retained object references after callback return.

RG901 remains active. Its stale-permit and context-epoch cases occur during normal Pi context reselection.

BG8 and Track 11 TQ9 remain verified. Both cover ordinary branch-read and later session-entry failures.

### Track 11 final scoped review ledger

| Finding | Reviewer severity | Validated severity | Final scoped evidence | Reviewer episodes | Canonical observations |
| --- | --- | --- | --- | --- | --- |
| RG2301 | blocker | VERIFIED blocker | Code and recovery gate confirmed that an advisory repair-notice failure preserves selected state and costs. | t538.e1 | `.pi/slate/observations/t538.e1.md` |
| TQ11 | should-fix | VERIFIED should-fix | Test and mutation gates confirmed that the restore test asserts installed state after a throwing repair notice. | t538.e1, t540.e1 | `.pi/slate/observations/t538.e1.md`, `.pi/slate/observations/t540.e1.md` |
| SE22 | blocker | VERIFIED blocker | Authority gates confirmed a nondecreasing generation floor while legitimate context and namespace selection remain possible. | t539.e1, t540.e1 | `.pi/slate/observations/t539.e1.md`, `.pi/slate/observations/t540.e1.md` |
| WC101 | should-fix | VERIFIED should-fix | Design gate confirmed the approved terminology and exactly two conceptual trust-boundary non-goals. | t541.e1 | `.pi/slate/observations/t541.e1.md` |

BG8 and TQ9 remain VERIFIED should-fix findings. The final scoped code, recovery, authority, test, and design gates found no other in-goal defects. These gates cover the approved Track 11 scope and do not close deferred work.

### Track 11 post-simplification review outcomes

- RG2301 — VERIFIED blocker. A failed advisory legacy repair notice no longer clears selected-branch state.
- TQ11 — VERIFIED should-fix. A maintained normal Pi-shaped restore test covers a throwing repair notice and asserts installed state after restoration.
- SE22 — VERIFIED blocker. Same-authority rereads and reconciliation enforce the last validated generation floor without crossing a new context selection.
- WC101 — VERIFIED should-fix. The approved same-process exclusions now form one non-goal bullet, leaving two conceptual trust-boundary bullets.

### Track 11 progress record

Track 11 is user-approved as of 2026-08-27. The strict standalone ladder has passed. The implementation is committed, and post-commit patch coverage has passed. Empty completion marker `0e2e2eb1b850ee5976a78a0ef1be2bf934ac25fa` follows implementation commit `7bc903aac1a19b0ae88a6a6d0b0b65ca063e4156` as its parent. Its exact subject is `Track 11 complete: runtime-authority`. `origin/dogfood-sources` was pushed without force from `cbc60500dd874c4aa9a0bd33283b5433e56927a0` to the marker. Draft pull request #211 was updated and verified at head `0e2e2eb1b850ee5976a78a0ef1be2bf934ac25fa`. Track 11 is complete, pushed, and published in the draft pull request. The published record lists the implementation commit, completion marker, strict ladder result, 560 passing tests, 94.63 percent line coverage, and 88.38 percent branch coverage. Follow-up issues [#259](https://github.com/JetBrains/ytdb-slate/issues/259) through [#262](https://github.com/JetBrains/ytdb-slate/issues/262) remain linked. Tracks 12 through 15 remain pending. Every deferred finding maps to exactly one follow-up issue. The approved goal, trust boundary, design, finding verdicts, and deferred dispositions remain unchanged.

## Decision Log (continued)

- D348: The user gave final Track 12 implementation approval on 2026-08-27. This decision amends D327 only for Track 12 scope authority. Track 12 replaces legacy compatibility with safe legacy refusal. Adoption inherits supported durable policy only. Legacy, mixed, unknown, or unsupported policy evidence causes refusal. Slate performs no migration, reinterpretation, copy, repair, or deletion of legacy evidence. Historical evidence remains unchanged. D338 and D339 remain unchanged as Track 11 implementation decisions. The current Track 12 table row records the approved scope and keeps Planned status. Tracks 13 through 15 remain unchanged and deferred.

## Track 12 final approved high-level design and gate record

The durable design artifact is `track-artifacts/track-12-stable-handoff/design.md`.

# Track 12 stable-namespace handoff and clean-recipient adoption

## Status

This document records the final approved Track 12 high-level design.

The user approved this design for adversarial review on 2026-08-27.

The final review gates verified every finding.

The user gave final pre-implementation approval on 2026-08-27.

Track 12 remains Planned.

## Goal

Track 12 defines stable-namespace handoff and clean-recipient adoption for fresh durable sessions.

The supported population contains fresh sessions on new deployment branches.

Track 12 creates those sessions only through direct staged validation.

Track 12 does not activate consumer startup or production lifecycle wiring.

A deployment branch defines a rollout boundary. It does not establish identity or grant authority.

One logical change keeps one Slate name, identifier, and external namespace across adoption.

Adoption transfers writer ownership. It never copies canonical state into another namespace.

The external namespace remains the sole authority for canonical Slate state.

The new extension supports durable policy only. It does not support legacy sessions.

Legacy evidence causes safe, non-destructive refusal.

Slate performs no migration, reinterpretation, copying, repair, or deletion of legacy evidence.

Track 12 preserves the approved plain persisted-data trust boundary.

Tracks 13 through 15 remain deferred.

### Approved scope

Implement stable-namespace handoff and clean-recipient adoption for fresh durable sessions.

Include policy inheritance, authoritative revalidation, safe legacy refusal, and focused tests.

This scope replaces the earlier legacy compatibility phrase.

## Terminology

- **Logical session:** One Slate session representing one change.
- **Canonical state:** Slate data controlling the current logical session.
- **External namespace:** The durable external location owning canonical state.
- **Durable session:** A supported session whose external namespace owns canonical state.
- **Supported population:** Fresh durable sessions on new deployment branches.
- **Deployment branch:** A new branch selected for the new extension.
- **Direct staged validation:** Focused validation that invokes staged mechanisms without production lifecycle wiring.
- **Legacy evidence:** Session, handoff, binding, or namespace evidence from the earlier lifecycle.
- **Source:** The durable session offering its namespace for adoption.
- **Successor:** The fresh Pi session seeking writer ownership.
- **Handoff checkpoint:** Current external authorization for one adoption attempt.
- **Adoption:** Writer ownership transfer from the source to a clean successor.
- **Authority evidence:** Data claiming a binding, namespace, owner, generation, checkpoint, or canonical status.
- **Clean recipient:** A successor without canonical Slate work, authority evidence, or an active canonical mutation.
- **Durable policy:** The supported policy fixed when a durable logical change starts.
- **Generation:** An increasing external revision that exposes stale state.
- **Owner:** The Pi session identity currently authorized to write the namespace.
- **Advisory locator:** Pi-held data that may identify a namespace but grants no authority.
- **Authoritative revalidation:** A fresh comparison with external state before a state-changing decision.
- **Active status:** The authoritative status permitting checkpoint creation and transfer.
- **Final external state:** The authoritative namespace state remaining after concurrent publications finish.
- **Terminal session:** A delivered or abandoned session that permits no further project work.
- **Canonical current directory:** The exact project directory guarding writable continuation.
- **Plain persisted-data boundary:** Ordinary persisted data with structural validation and no cryptographic authentication.

## Approach

### Limit support to fresh durable sessions

The new design supports only fresh durable sessions.

A deployment branch does not make existing Slate evidence fresh.

Copied canonical state, inherited authority, mixed evidence, or uncertain evidence defeats freshness.

A supported session begins with one durable policy and one authoritative namespace.

Track 12 validates session creation only through direct staged validation.

Consumer startup cannot create a durable session during Track 12.

The new extension provides no legacy mode, compatibility route, or snapshot-adoption route.

Older branches remain outside the new extension deployment.

The design makes no promise about running legacy sessions through the new extension.

### Keep one authoritative namespace

A durable handoff remains inside the source namespace.

The checkpoint authorizes writer transfer. It does not carry replacement canonical state.

The latest checkpoint supersedes every earlier checkpoint.

A source mutation after checkpoint creation makes that checkpoint stale.

Only current external state inside the selected namespace can authorize adoption.

An advisory locator may identify a possible namespace. It cannot authorize adoption.

Copied or altered locator data remains non-authoritative.

Locator provenance alone neither permits nor blocks adoption.

The selected namespace independently confirms identity, name, ownership, policy, generation, active status, and checkpoint authority.

A locator mismatch causes refusal.

Failed authoritative revalidation also causes refusal.

The namespace keeps its stable Slate name and identifier throughout adoption.

Track 12 does not define locator discovery.

### Require a clean recipient

An advisory locator alone does not make a recipient unclean.

An ordinary Pi conversation also does not make a recipient unclean.

Canonical Slate work makes a recipient unclean.

Authority evidence makes a recipient unclean.

An active canonical mutation makes a recipient unclean.

Legacy Slate evidence also makes a recipient unclean.

A durable binding, committed namespace, or ownership claim blocks adoption.

A committed empty namespace also blocks adoption.

Canonical mode, cost, thread, or related Slate work blocks adoption.

Malformed, conflicting, or uncertain authority evidence causes refusal.

The successor needs no pre-created logical identity or namespace.

Adoption never merges, replaces, or discards recipient work.

Successful adoption creates no unused sibling namespace.

Track 12 does not prescribe the recipient representation before adoption.

### Transfer current external authority

Adoption reads current external state instead of trusting a handoff snapshot.

The decision revalidates policy, identity, name, directory, status, owner, generation, and checkpoint.

The canonical current directory must match the source record.

Transfer requires the expected active owner, generation, and checkpoint.

Each observed authoritative state keeps owner, generation, and checkpoint facts consistent.

A completed publication advances authoritative state.

Advanced authoritative state rejects stale or replayed checkpoints.

The no-lock storage model still permits a final publication race.

Concurrent adopters may validate the same prior state and enter that race.

More than one publication may complete before participants observe advancement.

More than one participant may report publication success.

Track 12 does not promise one success report inside the race.

Final external state determines the owner.

Every process must revalidate final ownership before any later mutation.

A former owner or losing publisher fails later mutations after revalidation.

Track 12 adds no locks or lock-grade exclusion.

Transfer preserves current canonical runtime state.

Adoption does not change pause state, mode state, costs, or other runtime content.

Resume remains a separate successor mutation.

A failed resume cannot reverse completed writer transfer.

### Preserve external authority after failures

The final external ownership result takes precedence over Pi-held state.

A completed transfer never rolls back because later local setup fails.

Locator, model, mode, or kickoff failure cannot restore the former owner.

A post-transfer failure reports changed ownership and incomplete local continuation.

A success report alone does not establish final ownership during the accepted race.

Uncertain publication requires reconciliation from the external namespace.

Slate accepts a successor only when final external state names that successor.

Slate becomes unavailable when reconciliation cannot establish authority.

Slate never restores canonical authority from a Pi snapshot.

### Refuse legacy evidence safely

Legacy evidence is unsupported input to the new extension.

Legacy evidence causes refusal before ownership or canonical state changes.

Refusal preserves all existing data within the approved storage boundary.

Slate does not migrate legacy evidence into a durable namespace.

Slate does not reinterpret legacy records as durable records.

Slate does not copy legacy snapshots into a successor.

Slate does not delete or repair legacy evidence.

Legacy handoffs cannot authorize durable adoption.

Legacy bindings cannot identify a writable durable session.

Mixed legacy and durable evidence causes refusal.

Unknown policy evidence causes the same refusal.

The refusal identifies the unsupported deployment boundary.

The refusal leaves source and recipient state unchanged.

### Preserve durable policy inheritance

Each supported logical change fixes its durable policy when the change starts.

Adoption inherits the source durable policy.

Recipient defaults cannot replace that policy.

Unsupported policy versions cause refusal.

Policy inheritance does not select between durable and legacy behavior.

The new extension has one supported adoption model.

### Require authoritative active status

Checkpoint creation requires authoritative active status.

Ownership transfer also requires authoritative active status.

Absent status causes safe refusal.

Unknown status causes safe refusal.

Any status that is not active causes safe refusal.

A terminal change before publication defeats transfer.

A stale checkpoint cannot reopen a delivered or abandoned session.

Status refusal preserves owner, generation, checkpoint, and canonical runtime.

Track 12 consumes existing authoritative status.

Track 12 adds no terminal commands, records, or lifecycle behavior.

### Preserve the plain persisted-data boundary

Persisted evidence remains ordinary data within the approved storage boundary.

Slate validates expected fields, types, identities, names, sizes, and text encoding.

Namespace paths derive only from validated stable names.

Authoritative access remains inside the selected namespace.

Slate refuses linked, replaced, malformed, or escaped storage paths.

Publication must leave valid external state.

Uncertain publication results require external reconciliation before Slate continues.

Storage refusal preserves previous authoritative state.

Track 12 adds no cryptographic authentication or authenticated provenance.

Track 12 adds no defenses against hostile same-process objects or modified language built-ins.

### Keep staged mechanisms inactive

Track 12 may stage durable creation and transfer mechanisms.

Direct staged validation may exercise those mechanisms.

Consumer startup and production lifecycle wiring remain inactive.

Track 12 must not create production namespaces through accidental activation.

Dormancy does not create a legacy compatibility promise.

Track 15 remains responsible for coordinated lifecycle integration.

Track 15 may activate the durable lifecycle only for the supported population.

Track 15 must enforce refusal when the new extension encounters legacy evidence.

## Acceptance criteria

### Supported population and staging

- Direct staged validation can create a fresh durable session.
- That session receives one stable name, identifier, policy, and external namespace.
- Consumer startup cannot create that session during Track 12.
- Production lifecycle wiring remains unchanged.
- Branch selection does not replace freshness or authority checks.
- Legacy, mixed, malformed, or uncertain evidence prevents durable creation.
- Refusal changes no canonical state and deletes no evidence.

### Stable namespace and checkpoints

- Adoption preserves the source name, identifier, namespace, policy, and canonical records.
- Adoption creates no recipient namespace.
- Adoption copies no canonical snapshot.
- A newer source generation defeats an older checkpoint.
- A newer checkpoint defeats every earlier checkpoint.
- Advanced authoritative state rejects stale or replayed checkpoints.
- Another current directory cannot adopt the namespace.

### Clean recipient

- A genuinely fresh successor can adopt.
- An advisory locator alone does not block adoption.
- Ordinary Pi conversation does not block adoption.
- Canonical Slate work blocks adoption.
- Authority evidence blocks adoption.
- An active canonical mutation blocks adoption.
- Legacy evidence blocks adoption.
- A committed empty namespace blocks adoption.
- Malformed or conflicting evidence blocks adoption.
- Refusal changes neither source nor recipient authority.

### Ownership race and runtime preservation

- Each observed authoritative state keeps related ownership facts consistent.
- Concurrent publishers may enter the accepted final publication race.
- More than one publisher may complete or report success inside that race.
- Final external state determines the owner.
- Every later mutation requires fresh owner revalidation.
- A losing publisher cannot mutate after revalidation.
- Current canonical runtime keeps the same meaning after transfer.
- A separate resume failure leaves final ownership unchanged.
- Verification states the accepted no-lock publication limitation.

### Authority and failure handling

- An advisory locator can only identify a possible namespace.
- Locator provenance does not authorize or prohibit adoption.
- Current external state independently confirms authority.
- Locator mismatch or failed revalidation causes refusal.
- Local setup failure cannot reverse final external ownership.
- Local continuation failure reports partial completion.
- Uncertain publication reconciles from external state.
- Unresolved authority makes Slate unavailable.
- No failure path restores a Pi snapshot as canonical authority.

### Legacy refusal

- Legacy source evidence cannot enter durable adoption.
- Legacy recipient evidence defeats clean-recipient status.
- Mixed legacy and durable evidence causes refusal.
- Unknown policy evidence causes refusal.
- Refusal performs no migration, reinterpretation, copying, repair, or deletion.
- Refusal preserves source and recipient evidence.
- Verification covers refusal boundaries only.
- Verification does not preserve legacy adoption behavior.

### Status and storage

- Checkpoint creation requires authoritative active status.
- Ownership transfer requires authoritative active status.
- Absent, unknown, or non-active status causes refusal.
- A source becoming terminal before transfer cannot be adopted.
- Status refusal preserves owner, generation, checkpoint, and runtime.
- Linked, replaced, malformed, oversized, or escaped storage causes refusal.
- Rejected publication preserves previous authoritative state.
- Publication leaves valid external state.
- Uncertain publication requires reconciliation before Slate continues.

### Staging boundary

- Focused validation exercises staged durable creation and transfer directly.
- Track 12 does not activate consumer startup.
- Track 12 does not activate the durable production lifecycle.
- Track 12 creates no production namespace through accidental activation.
- Track 12 adds no terminal command or terminal record.
- Track 12 adds no candidate discovery or sibling metadata behavior.
- Legacy behavior has no compatibility acceptance requirement.
- Track 15 owns integrated lifecycle validation.

## Risks

- Users may run the new extension on branches containing legacy evidence.
- Safe refusal may prevent continuation until the correct extension returns.

- Copied canonical data may resemble fresh state.
- Freshness checks must refuse uncertain authority instead of guessing.

- Deployment depends on correct branch and extension selection.
- Branch selection cannot replace authority checks.

- The accepted no-lock race prevents a lock-grade uniqueness guarantee.
- Multiple publishers may complete or report success before final revalidation.

- A publisher may lose ownership after reporting success.
- Final external state and later revalidation resolve that outcome.

- A former source process may remain open after transfer.
- Authoritative owner checks reject its later mutations.

- A local failure may follow successful external transfer.
- Recovery may be necessary before local continuation.

- External storage remains the only canonical Slate record.
- Corruption or deletion may remove that record without an automatic archive.

- Staged validation cannot prove the later integrated user flow.
- Track 15 must validate consumer startup and integrated refusal behavior.

## Non-goals

- Supporting legacy sessions through the new extension.
- Preserving legacy adoption behavior.
- Testing legacy adoption for compatibility.
- Migrating legacy sessions, namespaces, logs, bindings, or handoffs.
- Reinterpreting legacy evidence as durable evidence.
- Copying legacy snapshots into durable namespaces.
- Deleting or repairing legacy evidence.
- Activating consumer startup during Track 12.
- Activating durable production authority during Track 12.
- Changing production lifecycle wiring during Track 12.
- Defining candidate discovery, unnamed listing, or sibling metadata.
- Setting candidate confidentiality policy.
- Adding project-independent discovery.
- Adding post-removal read-only lookup.
- Track 13 owns discovery, lookup, confidentiality, and sibling metadata.
- Track 13 remains deferred.
- Expanding Track 14 terminal scope.
- Adding terminal commands or terminal record creation.
- Adding project-writer doctrine or enforcement.
- Track 14 remains deferred.
- Expanding Track 15 integration, guidance, or validation work.
- Track 15 remains deferred.
- Adding archive creation, prompts, waivers, cleanup, or source selection.
- Supporting branching adoption.
- Merging or replacing canonical recipient work.
- Creating a new namespace during adoption.
- Adding locks, leases, revocation, or forced shutdown.
- Guaranteeing one publication or success report inside the accepted race.
- Detecting same-path project replacement.
- Adding hostile same-process defenses.
- Detecting duplicate properties before ordinary persisted-data parsing.
- Adding cryptographic authentication or authenticated provenance.
- Redesigning corpus authentication or project trust.
- Adding unrelated storage hardening.
- Changing Pi transcript ownership or storage.
- Adding automatic pruning or a secondary archive.

## Earlier observation continuity

| Observation | Final disposition |
| --- | --- |
| T12-P1 | Adoption uses current external state and a generation-bound checkpoint. Snapshots grant no authority. |
| T12-P2 | Cleanliness excludes canonical work, authority evidence, and active mutations. Advisory locators remain allowed. |
| T12-P3 | Only current external state authorizes transfer. Locator data grants no authority. |
| T12-P4 | Advanced state rejects replay. The accepted race may produce multiple publications and reports. Final state selects the owner. |
| T12-P5 | Transfer preserves canonical runtime. Resume remains a separate successor mutation. |
| T12-P6 | Active status gates creation and transfer. Missing, unknown, or non-active status causes refusal. |
| T12-P7 | The new extension has one durable path. Legacy, mixed, and unknown evidence causes refusal. |
| T12-P8 | The concern remains valid and deferred to Track 13. Track 12 adds no discovery or sibling metadata. |
| T12-P9 | Durable handoff retains approved containment, identity, durability, and valid external publication outcomes. |
| T12-P10 | Final external ownership survives local failure. Reconciliation uses external state only. |
| T12-P11 | Durable mechanisms remain staged until Track 15. Track 12 does not activate consumer startup. |

T12-P6 does not authorize new terminal behavior.

T12-P8 does not authorize discovery work during Track 12.

T12-P11 does not authorize current lifecycle integration.

## Review findings and gates

The pre-adversarial user approval occurred on 2026-08-27.

The adversarial review raised T12-AR1 through T12-AR4.

The goal-and-scope review raised T12-HDR-1 and T12-HDR-2.

Episodes t576.e1 and t577.e1 verified every finding.

Episode t577.e1 also found no scope regression.

The reviews left zero accepted review risks.

The final pre-implementation user approval occurred on 2026-08-27.

| Finding | Final resolution |
| --- | --- |
| T12-AR1 | The accepted race replaces uniqueness claims. Final state selects ownership. Later mutations require revalidation. |
| T12-AR2 | Advisory locators do not affect cleanliness. Canonical work, authority evidence, and active mutations still block adoption. |
| T12-AR3 | Absent, unknown, or non-active authoritative status causes safe refusal. |
| T12-AR4 | Durable creation applies only to direct staged validation. Consumer startup remains inactive. |
| T12-HDR-1 | Locator provenance does not cause rejection. Mismatch or failed external revalidation causes refusal. |
| T12-HDR-2 | The T12-AR4 correction resolves the shared staging ambiguity. No separate work remains. |

No finding changes the approved goal.

The corrections remove unsupported or ambiguous readings.

## Decision authority

Decision D348 amends D327 only for Track 12 scope authority.

D348 replaces legacy compatibility with safe legacy refusal.

Source policy inheritance accepts supported durable policy only.

Legacy, mixed, unknown, or unsupported policy evidence causes refusal.

Slate preserves legacy evidence without migration or reinterpretation.

Slate also performs no copy, repair, or deletion of that evidence.

Decisions D338 and D339 remain unchanged Track 11 implementation decisions.

The Track 12 table row records the approved scope and keeps Planned status.

Tracks 13 through 15 remain unchanged and deferred.

## Implementation boundary

This design includes no files, symbols, schemas, algorithms, or implementation steps.

The future implementer must create the complete low-level design.

The future implementer must implement that design in the same integrated action.

## Track 12 implementation intention — 2026-08-27

- Target: Add staged stable-namespace handoff and clean-recipient adoption for fresh durable sessions.
- Scope boundary: Keep one authoritative namespace, inherit supported durable policy, and refuse unsafe evidence without changing it.
- Deferred work: Tracks 13 through 15 retain discovery, confidentiality, terminal behavior, commands, doctrine, and lifecycle activation.
- Acceptance condition: Focused tests prove current checkpoint transfer, runtime preservation, race reconciliation, active-status gates, and safe refusal boundaries.

## Track 12 implementation decisions and findings — 2026-08-27

- D349: Every new durable state carries one checkpoint field. A null value means no handoff authority exists.
- D350: Checkpoint publication advances generation without changing owner or canonical runtime. A later ordinary mutation consumes the checkpoint.
- D351: Ownership transfer advances generation, changes only the owner, and consumes the expected checkpoint. Canonical runtime remains in the source namespace.
- D352: The staged adoption reference is exact plain data. Current external identity, owner, generation, status, policy, directory, and checkpoint grant authority.
- D353: Advisory locator placement, owner, generation, and provenance grant no authority. Matching namespace identity and name do not make a recipient unclean.
- D354: Every adoption result uses a fresh external read. A valid final owner wins even when several publishers previously reported success.
- D355: Local resume remains separate from ownership transfer. Track 12 adds no consumer startup or lifecycle call site.

Implementation surprise. Track 11's external-record decoder needed the checkpoint and policy fields. Without that update, staged durable reads rejected valid new records.

The legacy snapshot handoff remains unchanged and inactive. Track 12 adds no legacy adoption path or compatibility test.

Suggestion-level follow-ups: none. Tracks 13 through 15 retain their approved deferred work.

## Track 12 implementation verification — 2026-08-27

Focused durable, storage, and runtime-authority tests passed: 141 tests, zero failures.

The full unit suite passed: 583 tests, zero failures. Coverage collection passed, and the uncommitted patch gate was intentionally skipped.

The final typecheck passed. Strict resolver checks passed with 230 results and zero failures.

Both packaging-guard runs passed with 18 results and zero failures. The self-test rejected every required mutation.

The writing checker found zero fail-level and zero warning-level findings in changed governed text and comments.

The standalone ladder did not run by instruction. Later verification must run it alone.

Post-commit patch coverage also remains required because the gate measures committed changes only.

Track 12 remains In progress pending those later verification duties and user review.

## Track 12 implementation review fixes — 2026-08-27

Episodes t584.e1, t585.e1, and t586.e1 reported one shared publication blocker. The final test seam allowed a completed source change to be overwritten.

D356: State replacement now runs the test seam before a final external revalidation. A completed source mutation or terminal transition defeats stale publication.

The accepted no-lock limitation remains unchanged. Concurrent transfer candidates can still publish in the final read-to-rename window. Final external state selects the owner.

RI-T12-001, CN1, and SE-T12-1 are fixed. Regression tests preserve ordinary source mutation and terminal source authority during adoption.

Episode t587.e1 reported three test-quality findings. TQ12-01 now changes ownership after transfer returns and verifies the caller reports `lost`.

TQ12-02 now checks independent identity and policy locator mismatches with matching names. TQ12-03 now checks every recipient boolean and array field.

Each malformed recipient case refuses before adoption and preserves external state. Locator provenance, owner, and generation remain advisory.

Focused durable, storage, and runtime-authority tests passed: 146 tests, zero failures. The typecheck passed.

The full unit suite passed: 588 tests, zero failures. Coverage reached 89.84 percent lines and 85.42 percent branches.

Strict resolver checks passed with 230 results and zero failures. Both packaging runs passed with 18 results and zero failures.

The uncommitted coverage gate remained skipped by command. The standalone ladder and post-commit patch coverage remain later duties.

Track 12 remains In progress. Tracks 13 through 15 remain deferred, and production lifecycle wiring remains inactive.

## Track 12 final review fixes — 2026-08-27

TQ12-03 now uses falsy invalid values and requires the exact malformed-evidence refusal.

Removing either affected boolean type guard now fails its test. Each malformed case still verifies unchanged external state.

CQ-T12-001 now catches a post-transfer hook failure and always reconciles external authority.

`DurableAdoptionPostTransferFailure` carries the adopted, lost, or inactive authority result. Its cause preserves the original hook failure.

An unresolved reconciliation throws `DurableAdoptionUncertain`. Its aggregate cause preserves both the hook failure and reconciliation failure.

Regression tests cover adopted, lost, inactive, and unresolved final authority after a throwing hook.

The lost case transfers ownership twice and verifies the reconciled rival owner. The unresolved case preserves both failures.

The focused suites passed 149 tests with zero failures. Both targeted boolean-guard mutations failed the strengthened test.

The unguarded post-transfer-hook mutation also failed its regression test. The typecheck passed.

Strict resolver checks passed with 230 results and zero failures. The full suite passed 591 tests with zero failures.

Full-suite coverage reached 89.77 percent lines and 85.31 percent branches. The requested uncommitted coverage gate remained skipped.

The writing checker found zero fail-level and zero warning-level findings in changed governed prose.

Track 12 remains In progress. The standalone ladder and post-commit patch coverage remain later duties.

Production lifecycle wiring remains inactive. Tracks 13 through 15 retain their approved deferred scope.

## Track 12 exclusive-transition design revision — 2026-08-28

- D357: This decision supersedes only the prior Track 12 no-lock authority-transition limitation.
- One exclusive transition now protects source writer authority and recipient admission.
- Conflicting adoptions cannot both succeed when they share a source or recipient.
- Durable external state supports recovery after every interruption boundary without requiring the initiating process.
- Transition-created blockage must remain recoverable and finite.
- Permanent external storage loss remains a separate availability risk outside that guarantee.
- All other approved Track 12 design authority remains unchanged.

Option 2 was user-approved as a design direction.

Episode t602.e1 verified AD-T12-EX-001 and AD-T12-EX-002.

Episode t603.e1 verified T12-HDR-3 through T12-HDR-7.

The user approved the reformatted design.

Episode t609.e1 verified T12-FR-001.

The final approval date is 2026-08-28.

### Revised Track 12 high-level design

# High-Level Design

## 1. Intention

Pi is an agent application that hosts conversations, tools, extensions, and saved session information.

A Pi session is one Pi conversation and its associated runtime state.

Slate is a Pi extension that coordinates long-running work across persistent worker conversations.

This design lets one newly created Pi session take over another session’s durable work safely.

The source is the Pi session that currently controls the durable work.

The recipient is the new Pi session that seeks permission to write that work.

Writer authority is permission for one session to change the authoritative saved state.

Recipient admission is the authoritative decision that permits one recipient to accept one source.

Adoption transfers writer authority from the source to the recipient.

An exclusive authority transition prevents conflicting authority or admission outcomes from both succeeding.

The transfer keeps one durable storage location. It changes which session may write there.

Conflicting transfers cannot both succeed. Recovery remains possible when the initiating process disappears.

Normal startup cannot activate the change. Later work remains responsible for production activation.

## 2. Goals

- Support only newly created Pi sessions whose authoritative saved state survives process exit.
- Keep one stable durable storage location across a transfer.
- Preserve the work’s name, identity, policy, history, and runtime values.
- Permit exactly one session to write after a completed transfer.
- Protect source writer authority and recipient admission within one exclusive authority transition.
- Reject a transfer when the source changes the work first.
- Reject a transfer when the work becomes delivered or abandoned first.
- Reject later source changes when the transfer completes first.
- Prevent two recipients from obtaining authority over one source.
- Prevent two sources from entering one recipient.
- Recover without requiring the initiating process.
- Keep any blockage caused by a transfer recoverable and finite.
- Treat permanent external storage loss as a separate availability risk.
- Refuse evidence from the earlier lifecycle without changing or deleting it.
- Treat an advisory locator, which suggests a possible storage location, as information only.
- Preserve the existing trust assumptions for ordinary saved data.
- Allow direct staged validation, which provides focused validation without normal production startup.
- Keep session finding, terminal operations, and normal lifecycle activation deferred.

## 3. Glossary

- **Pi:** An agent application that hosts conversations, tools, extensions, and persisted session information.
- **Pi session:** One Pi conversation and its associated runtime state.
- **Slate:** A Pi extension that coordinates long-running work across persistent worker conversations.
- **Track:** A bounded work package within Slate’s planned development.
- **Track 12:** The work package described by this design.
- **Track 13:** Deferred work for discovery and related information handling.
- **Track 14:** Deferred work for terminal operations and research-log ownership.
- **Track 15:** Deferred work for production lifecycle activation and integrated validation.
- **Logical session:** One Slate-managed body of work representing one change.
- **External namespace:** The durable external location that contains one logical session’s authoritative state.
- **Canonical state:** The authoritative Slate data for a logical session.
- **Writer authority:** Permission for one session to change canonical state.
- **Durable session:** A logical session whose external namespace owns its canonical state.
- **Fresh durable session:** A newly created durable session without earlier lifecycle evidence or inherited authority.
- **Supported population:** The fresh durable sessions that Track 12 permits.
- **Deployment branch:** A new project branch selected for the staged extension.
- **Durable policy:** The supported behavior fixed when a durable logical session begins.
- **Source:** The durable session offering its external namespace for transfer.
- **Recipient:** The fresh Pi session seeking writer authority over the source namespace.
- **Successor:** The recipient after it receives writer authority.
- **Canonical work:** Durable Slate work already recorded for a logical session.
- **Authority evidence:** Persisted data that claims identity, ownership, authorization, revision, binding, or canonical status.
- **Legacy evidence:** Session, transfer, binding, or namespace evidence from the earlier lifecycle.
- **Advisory locator:** Local data that may identify a possible external namespace but grants no authority.
- **Clean recipient:** A recipient without canonical work, authority evidence, legacy evidence, or an active canonical change.
- **Recipient admission:** The authoritative decision that permits one clean recipient to accept one source.
- **Source mutation:** A canonical change attempted by the current source writer.
- **Active status:** The authoritative status that permits continued work and transfer.
- **Terminal session:** A delivered or abandoned logical session that permits no further project work.
- **Terminal transition:** An authoritative change from active status to terminal status.
- **Handoff checkpoint:** Current durable permission for one proposed authority transfer.
- **Generation:** An increasing external revision that reveals stale state or stale permission.
- **Adoption:** The transfer of writer authority from a source to a clean recipient.
- **Exclusive authority transition:** A recoverable decision that prevents conflicting authority or admission outcomes from both succeeding.
- **Publication:** A durable change to canonical state, writer authority, or recipient admission.
- **Authorized participant:** A participant that durable external state permits to settle an interrupted transition.
- **Durable external state:** Authoritative information that survives the disappearance of any participating process.
- **External reconciliation:** Resolution of an uncertain outcome using durable external state alone.
- **Canonical runtime values:** Authoritative runtime information, including pause state, mode state, costs, threads, and related records.
- **Pause state:** The canonical indication that work is paused.
- **Mode state:** The canonical operating mode selected for a logical session.
- **Costs:** Canonical usage and spending records associated with the logical session.
- **Plain persisted-data trust boundary:** Existing structural validation without cryptographic authentication or authenticated provenance.
- **Direct staged validation:** Focused validation that invokes staged behavior without normal production lifecycle wiring.
- **Consumer startup:** A normal Pi launch by a Slate user.
- **Production lifecycle:** The integrated creation, startup, transfer, continuation, and terminal behavior used during normal operation.
- **Discovery:** Finding possible logical sessions or external namespaces.
- **Candidate confidentiality:** Protection of information about possible discovery results.
- **Sibling metadata:** Information about related sessions or namespaces.
- **Terminal command:** A user operation that delivers or abandons a logical session.
- **Research log:** The project record that captures research evidence and conclusions.
- **Deferred:** Assigned to later work and excluded from Track 12.

## 4. Components affected by the change

The **adoption coordinator** is the conceptual Slate component that governs adoption and recovery.

The **staged validation entry** invokes Track 12 behavior directly. Consumer startup cannot invoke it.

Solid arrows below carry authoritative interactions. Dotted arrows carry advisory information only.

```text
                         . . possible location . .
[Advisory locator] . . . . . . . . . . . . . . . . .
                                                      v
[Source Pi session] ----------------------> [Adoption coordinator]
  current authority                         source authority
  checkpoint                                recipient admission
  canonical changes                         recovery decisions
                                                      ^
                                                      |
[Recipient Pi session] -------------------------------+
  cleanliness
  admission request
  continuation state
                                                      |
                                                      v
                                      [Durable external namespace]
                                        canonical state
                                        writer authority
                                        recipient admission
                                        transition outcome
                                        stable identity and policy

[Direct staged validation] ----------> [Track 12 staged behavior]

[Consumer startup] ----------------X   Track 12 production activation
```

The source and recipient interact through one authority decision.

The external namespace remains the sole authority. No Pi session snapshot can replace it.

The advisory locator can suggest a namespace. The namespace must independently confirm every authoritative fact.

## 5. Approach

### Limit support to fresh durable sessions

Track 12 supports only fresh durable sessions on new deployment branches.

A deployment branch marks staged rollout. It grants no identity, freshness, or writer authority.

Each supported session begins with one durable policy and one external namespace.

Copied canonical state or inherited authority defeats freshness. Mixed, malformed, or uncertain evidence also causes refusal.

A committed empty namespace makes a recipient unclean. Existing authority evidence also makes it unclean.

An ordinary Pi conversation does not make a recipient unclean. An advisory locator alone also does not make it unclean.

Direct staged validation may create and exercise supported sessions. Consumer startup cannot create them during Track 12.

### Keep one stable external namespace

Adoption remains inside the source external namespace.

The namespace retains its Slate name, identity, durable policy, canonical records, and external location.

Adoption creates no sibling namespace. It copies no canonical snapshot into the recipient.

A handoff checkpoint authorizes a possible transfer. It carries no replacement canonical state.

Current durable external state alone can authorize adoption.

A newer checkpoint supersedes every earlier checkpoint. A newer source generation makes an older checkpoint stale.

Advanced canonical state rejects stale or replayed checkpoints.

The advisory locator may identify a possible namespace. It cannot establish identity, ownership, status, policy, or writer authority.

The namespace must confirm its identity, expected location, policy, status, generation, and current writer.

A mismatch or failed authoritative revalidation causes refusal.

### Require a clean recipient

Canonical work makes a recipient unclean. Authority evidence, legacy evidence, or an active canonical change has the same effect.

Malformed, conflicting, or uncertain recipient evidence causes refusal.

Adoption never merges, replaces, or discards recipient work.

Recipient cleanliness must remain valid until adoption settles.

Recipient work completed before adoption defeats adoption.

A completed adoption makes the recipient unclean for every other source.

### Join source authority and recipient admission

One exclusive authority transition covers source authority and recipient admission together.

Adoptions conflict when they share either a source or a recipient.

Coordination covers only the involved source and recipient. Disjoint source-recipient pairs remain independent.

Track 12 adds no global coordination.

Successful adoption produces one settled outcome for both sides.

```text
[Active source]
  current writer authority
  current checkpoint
          |
          v
[Clean recipient] ---> [Joint authority and admission decision]
                                  |
                    authority confirmed
                    admission confirmed
                                  |
                                  v
[One settled completion]
  successor becomes the only writer
  recipient accepts exactly one source
  source namespace remains unchanged
  canonical runtime values remain unchanged
```

Earlier validation cannot establish success. An attempted publication also cannot establish success.

Success exists only after durable external state confirms both writer authority and recipient admission.

Cancellation grants no authority. It leaves the recipient without authority from that attempt.

### Resolve source and terminal races

Only one conflicting publication can complete successfully.

A completed source mutation advances authoritative state. Adoption must then refuse or reconcile as unsuccessful.

A completed terminal transition removes active status. Adoption must then refuse or reconcile as unsuccessful.

A completed adoption installs the successor as writer. Later mutations from the former source must refuse.

```text
                         [Adoption attempt]
                                |
             +------------------+------------------+
             |                                     |
             v                                     v
[Source mutation completes first]      [Terminal transition completes first]
  generation advances                    status becomes terminal
  checkpoint becomes stale               active status disappears
  adoption is unsuccessful               adoption is unsuccessful

                                |
                                v
                    [Adoption completes first]
                      successor becomes writer
                      former source loses authority
                      later source writes refuse
```

A simultaneous or uncertain result requires external reconciliation.

Reconciliation cannot reverse a completed source mutation. It cannot reopen a completed terminal session.

Reconciliation also cannot roll back completed successor ownership.

### Prevent shared-endpoint adoption

Two recipients cannot both obtain authority over one source.

Two sources cannot both enter one recipient.

The first completed adoption makes its recipient unclean. Every conflicting attempt must observe that result and refuse.

An interrupted attempt cannot retain a permanent veto. Its admission must settle before another conflicting adoption continues.

```text
[Source A] ---- adoption attempt ----\
                                      \
                                       > [One recipient]
                                      /    one admission decision
[Source B] ---- adoption attempt ----/             |
                                                    v
                                      [At most one completion]
                                        one source admitted
                                        recipient becomes unclean
                                        other attempt refuses
                                        or settles without authority
```

The same rule protects one source against two recipients.

```text
[Recipient A] ---- adoption attempt ----\
                                         > [One source authority]
[Recipient B] ---- adoption attempt ----/
                                                   |
                                                   v
                                      [At most one successor writer]
```

### Recover without the initiating process

Durable external state must support recovery after every interruption boundary.

Recovery cannot require the initiating process to return.

A later authorized participant can determine the valid outcome from durable external state.

The participant may complete or cancel the transition when external state permits that result.

Cancellation remains possible only before successor ownership becomes authoritative.

Authoritative successor ownership requires recovery to finish the adoption outcome.

An abandoned process cannot retain an unrecoverable veto.

Transition-created unresolved state must remain settleable.

Conflicting work may pause only while authorized recovery remains available.

Transition-created exclusivity cannot cause indefinite blockage.

```text
[Initiating process disappears]
              |
              v
[Later authorized participant]
              |
              v
[Read durable external state]
              |
       +------+-----------------------------+
       |                                    |
       v                                    v
[Successor ownership not final]   [Successor ownership is final]
  complete when permitted           finish adoption outcome
  or cancel when permitted          do not roll ownership back
       |                                    |
       +------------------+-----------------+
                          |
                          v
               [One settled outcome]
                 no permanent veto
                 no indefinite blockage
```

Permanent external storage loss may prevent this recovery.

That loss is a separate availability risk. It is outside the transition-created no-blockage guarantee.

### Preserve canonical runtime values

Adoption preserves every canonical runtime value unchanged.

Pause state remains unchanged. Mode state remains unchanged. Costs remain unchanged.

Threads and all related canonical records remain unchanged.

Resuming work is a separate successor mutation. Adoption does not resume a paused session automatically.

A failed resume cannot reverse completed writer authority.

A later local setup failure also cannot restore the former writer.

Such a failure must report changed ownership and incomplete continuation.

### Preserve terminal finality

Checkpoint creation requires authoritative active status. Authority transfer requires the same status.

Absent, unknown, or non-active status causes safe refusal.

A terminal transition completed before adoption defeats adoption.

A stale checkpoint cannot reopen a delivered or abandoned logical session.

Track 12 consumes existing terminal status. It adds no terminal commands or terminal records.

Track 14 owns terminal commands and research-log ownership.

### Refuse legacy evidence safely

Legacy evidence is unsupported input for Track 12.

Slate refuses legacy or mixed evidence before changing canonical state, writer authority, or recipient admission.

Legacy checkpoints cannot authorize durable adoption. Legacy bindings cannot identify a writable durable session.

Refusal performs no migration, reinterpretation, copying, repair, or deletion.

Refusal preserves all source and recipient evidence.

Adoption inherits the source durable policy. Recipient defaults cannot replace that policy.

### Preserve the plain persisted-data trust boundary

Persisted evidence remains ordinary data inside the existing storage trust boundary.

Slate validates structure, identity, names, sizes, text encoding, and namespace containment.

Malformed, oversized, replaced, linked, or escaped storage causes refusal.

A publication must leave valid durable external state.

An uncertain publication requires external reconciliation before Slate permits more work.

Unresolved authority makes Slate unavailable. Slate never permits uncertain writing.

A local Pi session snapshot cannot restore canonical authority.

Track 12 adds no cryptographic authentication, authenticated provenance, or hostile same-process defenses.

### Keep production activation deferred

Track 12 may stage durable-session creation and adoption behavior.

Only direct staged validation may exercise that behavior.

Consumer startup and production lifecycle wiring remain inactive.

Track 15 owns production lifecycle activation, guidance, integration, and integrated validation.

Track 13 owns discovery, lookup, candidate confidentiality, and sibling metadata.

Track 14 owns terminal commands and research-log ownership.

Tracks 13, 14, and 15 remain deferred.

## 6. Risks

- Exclusive authority decisions may delay conflicting work briefly.
- Recovery must prevent a transition-created delay from becoming permanent.
- An interrupted transfer may leave local continuation incomplete.
- Durable external state must still support one settled outcome.
- Poor conflict scoping could delay unrelated sessions.
- Coordination must remain limited to each involved source and recipient.
- A former source process may remain open after adoption.
- Authoritative checks must reject its later mutations.
- A second source may target a recipient during an interrupted adoption.
- The earlier recipient admission must settle before the second attempt continues.
- Legacy refusal may prevent progress until the correct earlier extension returns.
- External storage remains the sole canonical record.
- Permanent external storage loss or corruption may make recovery impossible.
- Direct staged validation cannot prove the later integrated user flow.
- Track 15 must validate production startup and lifecycle behavior.

## 7. Non-goals

- Supporting legacy sessions through Track 12.
- Preserving or validating legacy adoption behavior.
- Migrating legacy sessions, namespaces, logs, bindings, or checkpoints.
- Reinterpreting legacy evidence as durable evidence.
- Copying legacy snapshots into durable namespaces.
- Repairing or deleting legacy evidence.
- Activating durable behavior during consumer startup.
- Activating production writer authority during Track 12.
- Changing production lifecycle behavior during Track 12.
- Adding discovery or post-removal lookup.
- Exposing confidential discovery candidates.
- Adding sibling metadata behavior.
- Performing work assigned to Track 13.
- Adding terminal commands or terminal records.
- Changing rules for project writers.
- Changing research-log ownership.
- Performing work assigned to Track 14.
- Expanding Track 15 integration, guidance, or validation.
- Performing work assigned to Track 15.
- Adding global coordination.
- Delaying unrelated namespaces or unrelated work.
- Adding authority leases, revocation, or forced source shutdown.
- Adding archive creation, prompts, waivers, cleanup, or source selection.
- Supporting one source that branches into several successors.
- Merging, replacing, or discarding canonical recipient work.
- Creating a new namespace during adoption.
- Detecting project replacement when its directory path remains unchanged.
- Adding hostile same-process defenses.
- Detecting duplicate persisted-data properties before ordinary parsing.
- Adding cryptographic authentication or authenticated provenance.
- Redesigning project trust or authentication for stored records.
- Adding unrelated storage hardening.
- Changing ownership or storage of Pi conversation transcripts.
- Adding automatic pruning or a secondary archive.

## Track 12 exclusive-transition implementation — 2026-08-28

A durable session is Slate work whose canonical state survives process exit.

Adoption moves write authority from one source session to one recipient session.

- D358: Track 12 uses endpoint coordination for each involved source and recipient.
- Each source lock covers ordinary state changes and ownership transfer.
- Each recipient lock excludes other sources from the same recipient.
- Slate acquires both adoption locks in sorted path order.
- Disjoint endpoints use different coordination files and remain independent.
- Locks record process identity instead of an authority lease.
- A dead process leaves an interrupted transition that a later adoption can settle.
- Recipient admission commits before source ownership changes.
- A committed admission requires recovery to finish or reconcile ownership.
- A missing admission permits recovery to cancel dead coordination and retry.
- The durable recipient admission prevents later reuse with stale local evidence.
- Final source state and recipient admission determine one settled result.

The implementation removed the competing-transfer exception.

Source mutations, terminal transitions, and adoptions now use the same source exclusion.

The final state validation and rename execute while source coordination remains held.

Recipient admission uses an exclusive durable publication under the existing project storage.

No global coordination, time lease, cryptographic authentication, or lifecycle activation was added.

Legacy refusal, advisory locator limits, and deferred Track 13 through Track 15 scope remain unchanged.

The implementation changed no approved high-level design goal or non-goal.

The integrated low-level design is in `track-artifacts/track-12-stable-handoff/commit-message.md`.

The commit helper validates that file and passes it directly to `git commit --cleanup=verbatim --file`.

The helper did not run during this action.

Focused durable tests passed with 151 tests and zero failures.

The full test command passed with 593 tests and zero failures.

Full-suite coverage reported 89.91 percent lines and 85.11 percent branches.

The requested uncommitted coverage gate remained skipped.

The strict resolver suite passed all 230 result lines.

The packaging check passed all 18 checks.

The packaging self-test passed all 18 checks.

The TypeScript typecheck passed.

The writing check found no fail-level or warning-level finding in either commit-message artifact.

The standalone ladder remains a later duty and must run alone.

Post-commit patch coverage also remains a later duty.

Track 12 remains In progress.


## Track 12 concise lease design revision — 2026-08-28

- D359: The user approved the concise authority-lease revision.
- The current machine system clock is the only time authority.
- Each adoption has one fixed maximum deadline that activity, progress, retry, delay, restart, or clock adjustment cannot extend.
- System-clock failure can delay recovery, without a finite-recovery guarantee during that failure.
- Participants on different machines remain excluded.
- All other Track 12 goals remain unchanged.
- This revision resolves the interrupted-transition recovery design gap through expiry and an initiator-independent exclusive recovery decision.

The user approved this revised Track 12 high-level design on 2026-08-28.

Track 12 remains In progress.

### Revised Track 12 high-level design

# Track 12 High-Level Design

## Intention

Pi manages conversations with an agent. Slate is a Pi extension that coordinates work across Pi processes.

A durable session is Slate work that remains available after every participating process exits. Canonical state is the authoritative saved information for a durable session.

The source is the Pi session that currently controls the durable session. The recipient is one newly created Pi session that seeks control.

Adoption moves control from the source to the recipient. Writer authority is permission to change canonical state.

Track 12 adds safe adoption and recovery for new durable sessions. Track 12 keeps canonical state in one stable external storage location.

The source and recipient must run on one machine. Recovery must preserve the rule that only one session has writer authority.

Normal Pi startup remains unchanged. Direct validation can invoke Track 12 without activating Track 12 for ordinary users.

## Goals

- Support new durable sessions whose canonical state survives process exit.
- Preserve the work identity, policy, history, costs, modes, and pause state.
- Keep canonical state in one stable external storage location.
- Transfer writer authority from one source to one new recipient.
- Change source authority and recipient acceptance through one exclusive saved decision.
- Permit only the recipient to write after adoption completes.
- Prevent one source from transferring control to two recipients.
- Prevent one recipient from accepting two sources.
- Resolve conflicts with source changes and completed terminal actions.
- Limit coordination to adoptions that share a source or recipient.
- Run every participant on one machine.
- Use the machine system clock as the only time authority.
- Give each adoption one fixed maximum deadline.
- Prevent activity, progress, retry, delay, or restart from extending the deadline.
- Recover after expiry without requiring the process that started adoption.
- Include a stopped or unresponsive process in the recovery guarantee.
- Save an expiry decision and a newer authority revision before recovery becomes effective.
- Reject every write based on an expired lease or an earlier authority revision.
- Produce the same authority result on every supported operating system.
- Refuse legacy or uncertain saved information without changing the saved information.
- Preserve the existing trust rules for saved information.
- Keep normal startup inactive.
- Keep discovery, terminal operations, and production activation deferred.

## Components

Slate adoption coordination is the part of Slate that decides adoption, publication, expiry, and recovery.

The stable external storage location holds canonical state and every authoritative adoption decision.

The machine system clock supplies current time. The machine system clock grants no writer authority.

An authorized participant is a source, recipient, or recovery process that saved authority information permits to recover an interrupted adoption.

```text
[Source session] -------------\
[New recipient session] -------> [Slate adoption coordination]
[Authorized participant] -----/              |
                                             | reads and saves decisions
                                             v
                              [Stable external storage location]
                                             ^
                                             |
                                  [Machine system clock]

[Direct validation] ---------> [Track 12 behavior]

[Normal Pi startup] --------- Track 12 inactive
```

The stable external storage location remains authoritative for:

- canonical state
- writer authority
- recipient acceptance
- the fixed maximum deadline
- the expiry decision
- the authority revision
- adoption completion or cancellation

The machine system clock remains authoritative only for current time.

## Approach

### Support only new durable sessions

Track 12 accepts only durable sessions created for Track 12 behavior.

The recipient must remain free of canonical state and earlier authority information until adoption finishes.

Track 12 does not merge or replace recipient work.

Each durable session has one policy and one stable external storage location.

Adoption preserves the policy, work identity, saved history, and runtime state.

Adoption does not copy canonical state into the recipient.

Malformed, conflicting, legacy, or uncertain saved information causes refusal without a state change.

Every participant must run on the same machine.

### Change authority through one saved decision

Adoption changes writer authority and recipient acceptance together.

The stable external storage location must confirm both changes before adoption succeeds.

An incomplete or cancelled adoption grants no new authority.

Two adoptions conflict when both adoptions share a source or recipient.

Only one conflicting adoption can complete.

A completed source change causes a later adoption to fail.

A completed terminal action causes a later adoption to fail.

Completed adoption makes the recipient the only writer.

Every later source write must fail.

Unrelated source and recipient pairs remain independent.

### Use one fixed authority lease

An authority lease gives temporary control over one unfinished adoption.

Each authority lease has one saved fixed maximum deadline.

The durable session policy selects the lease duration.

The machine system clock supplies the only time basis.

Activity cannot extend the fixed maximum deadline.

Progress cannot extend the fixed maximum deadline.

Retry, delay, restart, and clock adjustment cannot extend the fixed maximum deadline.

Every publication must confirm the current authority revision and compare the machine time with the fixed maximum deadline.

Before the fixed maximum deadline, only the current writer may publish.

At or after the fixed maximum deadline, the expired authority lease grants no publication authority.

A saved expiry decision remains final after a later clock change.

A newer authority revision also remains final.

### Recover an interrupted adoption

Recovery does not depend on the identity or availability of the process that started adoption.

Recovery covers process exit, disappearance, stoppage, and an unresponsive process.

At or after the fixed maximum deadline, saved authority information must permit recovery.

Expiry alone grants no writer authority.

Recovery saves the expiry decision and a newer authority revision through one exclusive decision.

Recovered authority becomes effective only after both saved values become authoritative.

Only one competing recovery attempt can complete the exclusive decision.

Recovery may complete or cancel the interrupted adoption when canonical state permits that result.

Every unsuccessful recovery attempt must observe the newer authority revision and refuse.

A previous lease holder cannot publish after expiry.

An unresponsive previous holder cannot publish after resuming.

```text
[Publication or recovery request]
                 |
                 v
[Read canonical state and machine time]
                 |
                 v
[Is the authority revision current?]
       No ------> [Refuse without change]
                 |
                Yes
                 v
[Can the system clock support a safe comparison?]
       No ------> [Do not publish and wait]
                 |
                Yes
                 v
[Is the time before the fixed maximum deadline?]
       Yes -----> [The current writer may publish]
                 |
                No
                 v
[The expired lease grants no publication authority]
                 |
                 v
[Does canonical state permit authorized recovery?]
       No ------> [Refuse without change]
                 |
                Yes
                 v
[Save one exclusive recovery decision]
                 |
                 v
[Save the expiry decision and newer authority revision]
                 |
                 v
[Complete or cancel the interrupted adoption]
```

The fixed maximum deadline provides bounded recovery while the system clock supports a safe comparison.

An unavailable, frozen, or materially incorrect system clock delays recovery.

Track 12 does not guarantee bounded recovery during a system-clock failure.

Recovery can continue when the system clock again supports a safe comparison with the original deadline.

A system-clock failure grants no writer authority or recipient acceptance.

Permanent loss of the stable external storage location may prevent recovery.

### Preserve the existing trust rules

Track 12 accepts structurally valid saved information without requiring authenticated origin information.

Track 12 does not change that trust rule.

Slate still validates the saved properties needed for authority decisions.

Invalid, replaced, unexpectedly shared, or misplaced storage causes refusal without a state change.

Slate never permits writing when writer authority is uncertain.

Legacy information cannot authorize adoption or identify a writable durable session.

Refusal does not migrate, reinterpret, copy, repair, or delete legacy information.

### Keep Track 12 inactive during normal startup

Direct validation can invoke Track 12 authority and recovery behavior.

Normal Pi startup cannot create or adopt a Track 12 durable session.

Track 12 remains disconnected from the normal production behavior.

Later work will add discovery, terminal operations, production activation, user guidance, and integrated validation.

## Non-goals

- Track 12 does not support or migrate legacy adoption.
- Track 12 does not modify or delete legacy saved information.
- Track 12 does not activate durable behavior during normal Pi startup.
- Track 12 does not change normal production behavior.
- Track 12 does not add discovery after local session removal.
- Track 12 does not expose possible confidential discovery results.
- Track 12 does not add terminal operations or terminal records.
- Track 12 does not change repository or research-record permissions.
- Track 12 does not add production integration or user guidance.
- Track 12 does not support participants on different machines.
- Track 12 does not use an external time service.
- Track 12 does not guarantee bounded recovery during a system-clock failure.
- Track 12 does not coordinate unrelated durable sessions.
- Track 12 does not add general authority revocation.
- Track 12 does not force the source process to stop.
- Track 12 does not add source selection, cleanup, prompts, exceptions, or archive creation.
- Track 12 does not merge, replace, or discard recipient work.
- Track 12 does not create another authoritative storage location during adoption.
- Track 12 does not detect project replacement when the project path remains unchanged.
- Track 12 does not protect against malicious code inside a participating process.
- Track 12 does not add cryptographic authentication.
- Track 12 does not redesign trust for saved information.
- Track 12 does not change ownership of saved conversation history.
- Track 12 does not delete old saved information automatically.

## Track 12 bounded lease implementation — 2026-08-28

Decision D359 supplied the complete strategic amendment for this implementation.

The implementation required no further high-level amendment and created no new decision.

The low-level design now uses one fixed authority deadline and one monotonic authority revision.

Recovery records the expired token, deadline, old revision, new revision, and decision time.

Recipient admission and ownership transfer now require one matching exclusive decision.

Recipient evidence is bound to the intended owner and revalidated under endpoint exclusion.

Interrupted admission publication is recoverable from its exact dual-link state.

Cleanup failures preserve and report the settled canonical authority result.

Source directory replacement during a transition causes refusal.

Persisted coordination records have strict byte and schema bounds.

Focused coverage now includes a real second process, non-empty history, expiry, clock failure, replacement, cleanup, and admission interruption.

Typecheck and all 161 focused tests passed.

All 230 strict resolver checks passed.

Both 18-check packaging runs passed.

The full no-gate run passed 603 tests.

The four required writing-checker inputs had zero failures and zero warnings.

Normal startup remains inactive.

Discovery, terminal operations, and production activation remain deferred.

Track 12 remains In progress.


## Track 12 system-clock authority clarification — 2026-08-28

- D360: The user approved the system-clock authority clarification.
- The machine system clock remains the only time authority.
- Slate rejects an unavailable, invalid, negative, or unsafely saved reading.
- Slate accepts a valid system-clock reading as authoritative.
- A valid incorrect timestamp cannot be distinguished from a correct later timestamp without another trusted time source.
- A forward clock change can cause early lease expiry.
- A backward clock change can delay lease expiry.
- Track 12 does not guarantee correct expiry timing for a valid but incorrect timestamp.
- Track 12 adds no external time service.
- Every other Track 12 goal and non-goal remains unchanged.

Track 12 remains In progress.

### Revised Track 12 high-level design

# Track 12 High-Level Design

## Intention

Pi manages conversations with an agent. Slate is a Pi extension that coordinates work across Pi processes.

A durable session is Slate work that remains available after every participating process exits. Canonical state is the authoritative saved information for a durable session.

The source is the Pi session that currently controls the durable session. The recipient is one newly created Pi session that seeks control.

Adoption moves control from the source to the recipient. Writer authority is permission to change canonical state.

Track 12 adds safe adoption and recovery for new durable sessions. Track 12 keeps canonical state in one stable external storage location.

The source and recipient must run on one machine. Recovery must preserve the rule that only one session has writer authority.

Normal Pi startup remains unchanged. Direct validation can invoke Track 12 without activating Track 12 for ordinary users.

## Goals

- Support new durable sessions whose canonical state survives process exit.
- Preserve the work identity, policy, history, costs, modes, and pause state.
- Keep canonical state in one stable external storage location.
- Transfer writer authority from one source to one new recipient.
- Change source authority and recipient acceptance through one exclusive saved decision.
- Permit only the recipient to write after adoption completes.
- Prevent one source from transferring control to two recipients.
- Prevent one recipient from accepting two sources.
- Resolve conflicts with source changes and completed terminal actions.
- Limit coordination to adoptions that share a source or recipient.
- Run every participant on one machine.
- Use the machine system clock as the only time authority.
- Give each adoption one fixed maximum deadline.
- Prevent activity, progress, retry, delay, or restart from extending the deadline.
- Recover after expiry without requiring the process that started adoption.
- Include a stopped or unresponsive process in the recovery guarantee.
- Save an expiry decision and a newer authority revision before recovery becomes effective.
- Reject every write based on an expired lease or an earlier authority revision.
- Produce the same authority result on every supported operating system.
- Refuse legacy or uncertain saved information without changing the saved information.
- Preserve the existing trust rules for saved information.
- Keep normal startup inactive.
- Keep discovery, terminal operations, and production activation deferred.

## Components

Slate adoption coordination is the part of Slate that decides adoption, publication, expiry, and recovery.

The stable external storage location holds canonical state and every authoritative adoption decision.

The machine system clock supplies current time and remains the only time authority.

Slate rejects a clock reading when it is unavailable, invalid, negative, or cannot be saved safely.

Slate accepts every other system-clock reading as authoritative.

The machine system clock grants no writer authority.

An authorized participant is a source, recipient, or recovery process that saved authority information permits to recover an interrupted adoption.

```text
[Source session] -------------\
[New recipient session] -------> [Slate adoption coordination]
[Authorized participant] -----/              |
                                             | reads and saves decisions
                                             v
                              [Stable external storage location]
                                             ^
                                             |
                                  [Machine system clock]

[Direct validation] ---------> [Track 12 behavior]

[Normal Pi startup] --------- Track 12 inactive
```

The stable external storage location remains authoritative for:

- canonical state
- writer authority
- recipient acceptance
- the fixed maximum deadline
- the expiry decision
- the authority revision
- adoption completion or cancellation

The machine system clock remains authoritative only for current time.

## Approach

### Support only new durable sessions

Track 12 accepts only durable sessions created for Track 12 behavior.

The recipient must remain free of canonical state and earlier authority information until adoption finishes.

Track 12 does not merge or replace recipient work.

Each durable session has one policy and one stable external storage location.

Adoption preserves the policy, work identity, saved history, and runtime state.

Adoption does not copy canonical state into the recipient.

Malformed, conflicting, legacy, or uncertain saved information causes refusal without a state change.

Every participant must run on the same machine.

### Change authority through one saved decision

Adoption changes writer authority and recipient acceptance together.

The stable external storage location must confirm both changes before adoption succeeds.

An incomplete or cancelled adoption grants no new authority.

Two adoptions conflict when both adoptions share a source or recipient.

Only one conflicting adoption can complete.

A completed source change causes a later adoption to fail.

A completed terminal action causes a later adoption to fail.

Completed adoption makes the recipient the only writer.

Every later source write must fail.

Unrelated source and recipient pairs remain independent.

### Use one fixed authority lease

An authority lease gives temporary control over one unfinished adoption.

Each authority lease has one saved fixed maximum deadline.

The durable session policy selects the lease duration.

The machine system clock supplies the only time basis.

Activity cannot extend the fixed maximum deadline.

Progress cannot extend the fixed maximum deadline.

Retry, delay, restart, and clock adjustment cannot extend the fixed maximum deadline.

Every publication must confirm the current authority revision and compare the machine time with the fixed maximum deadline.

Before the fixed maximum deadline, only the current writer may publish.

At or after the fixed maximum deadline, the expired authority lease grants no publication authority.

A saved expiry decision remains final after a later clock change.

A newer authority revision also remains final.

### Recover an interrupted adoption

Recovery does not depend on the identity or availability of the process that started adoption.

Recovery covers process exit, disappearance, stoppage, and an unresponsive process.

At or after the fixed maximum deadline, saved authority information must permit recovery.

Expiry alone grants no writer authority.

Recovery saves the expiry decision and a newer authority revision through one exclusive decision.

Recovered authority becomes effective only after both saved values become authoritative.

Only one competing recovery attempt can complete the exclusive decision.

Recovery may complete or cancel the interrupted adoption when canonical state permits that result.

Every unsuccessful recovery attempt must observe the newer authority revision and refuse.

A previous lease holder cannot publish after expiry.

An unresponsive previous holder cannot publish after resuming.

```text
[Publication or recovery request]
                 |
                 v
[Read canonical state and machine time]
                 |
                 v
[Is the authority revision current?]
       No ------> [Refuse without change]
                 |
                Yes
                 v
[Can the system clock support a safe comparison?]
       No ------> [Do not publish and wait]
                 |
                Yes
                 v
[Is the time before the fixed maximum deadline?]
       Yes -----> [The current writer may publish]
                 |
                No
                 v
[The expired lease grants no publication authority]
                 |
                 v
[Does canonical state permit authorized recovery?]
       No ------> [Refuse without change]
                 |
                Yes
                 v
[Save one exclusive recovery decision]
                 |
                 v
[Save the expiry decision and newer authority revision]
                 |
                 v
[Complete or cancel the interrupted adoption]
```

The fixed maximum deadline provides bounded recovery while the system clock supports a safe comparison.

An unavailable, invalid, negative, or unsafely saved reading delays recovery.

A valid forward clock change can cause early lease expiry.

A valid backward clock change can delay lease expiry.

Track 12 does not guarantee correct expiry timing when the system clock returns a valid but incorrect timestamp.

Recovery can continue when the system clock again supplies an accepted reading for comparison with the original deadline.

A rejected clock reading grants no writer authority or recipient acceptance.

Permanent loss of the stable external storage location may prevent recovery.

### Preserve the existing trust rules

Track 12 accepts structurally valid saved information without requiring authenticated origin information.

Track 12 does not change that trust rule.

Slate still validates the saved properties needed for authority decisions.

Invalid, replaced, unexpectedly shared, or misplaced storage causes refusal without a state change.

Slate never permits writing when writer authority is uncertain.

Legacy information cannot authorize adoption or identify a writable durable session.

Refusal does not migrate, reinterpret, copy, repair, or delete legacy information.

### Keep Track 12 inactive during normal startup

Direct validation can invoke Track 12 authority and recovery behavior.

Normal Pi startup cannot create or adopt a Track 12 durable session.

Track 12 remains disconnected from the normal production behavior.

Later work will add discovery, terminal operations, production activation, user guidance, and integrated validation.

## Non-goals

- Track 12 does not support or migrate legacy adoption.
- Track 12 does not modify or delete legacy saved information.
- Track 12 does not activate durable behavior during normal Pi startup.
- Track 12 does not change normal production behavior.
- Track 12 does not add discovery after local session removal.
- Track 12 does not expose possible confidential discovery results.
- Track 12 does not add terminal operations or terminal records.
- Track 12 does not change repository or research-record permissions.
- Track 12 does not add production integration or user guidance.
- Track 12 does not support participants on different machines.
- Track 12 does not use an external time service.
- Track 12 does not guarantee bounded recovery during a system-clock failure.
- Track 12 does not coordinate unrelated durable sessions.
- Track 12 does not add general authority revocation.
- Track 12 does not force the source process to stop.
- Track 12 does not add source selection, cleanup, prompts, exceptions, or archive creation.
- Track 12 does not merge, replace, or discard recipient work.
- Track 12 does not create another authoritative storage location during adoption.
- Track 12 does not detect project replacement when the project path remains unchanged.
- Track 12 does not protect against malicious code inside a participating process.
- Track 12 does not add cryptographic authentication.
- Track 12 does not redesign trust for saved information.
- Track 12 does not change ownership of saved conversation history.
- Track 12 does not delete old saved information automatically.


## Track 12 integrated authority redesign implementation — 2026-08-28

Decision D360 remained the highest design decision.

No high-level conflict appeared, so this action added no decision.

The implementation replaced mutable lease files with append-only source and recipient decision chains.

A source decision stores complete canonical state in one non-empty revision directory.

Atomic directory rename publishes the exact next revision without hard links.

A stale participant targets an occupied revision and cannot replace the winner.

A transition decision stores one token, recipient, checkpoint, source revision, generation, and fixed deadline.

Recovery retains that deadline and publishes expiry with a newer authority revision.

Earlier transition evidence remains saved after recovery.

Recipient claims and releases use a separate append-only chain for that recipient.

A release names its exact prior claim and cannot remove a newer claim.

Final transfer rereads the saved recipient claim and current recipient cleanliness.

The source authority chain uses the stable source identity under the corpus project.

An in-window source namespace replacement cannot redirect canonical decision publication.

Decision cleanup is non-authoritative and cannot hide a settled result.

Clock validation now rejects unavailable, invalid, negative, unserializable, and unsafely saved values before authority changes.

Every other valid system-clock reading remains authoritative under Decision D360.

The implementation uses no process-liveness authority and no external time source.

Normal startup remains inactive.

Discovery, terminal operations, multi-machine support, and production activation remain deferred.

The maintained tests cover every consolidated blocker and should-fix behavior.

The tests include a live unresponsive child with deterministic clock barriers and bounded waits.

A focused portability test now runs on Linux, macOS, and Windows through continuous integration.

The commit helper now validates exact staged status and path pairs.

It refuses deletions, renames, copies, missing paths, unrelated paths, and an empty index.

It does not stage files or prove general content semantics.

Typecheck passed.

The focused Track 12 run passed 151 tests.

Strict resolver checks passed all 230 result lines.

Both packaging runs passed all 18 checks.

The full no-gate unit run passed 593 tests.

Full-suite coverage reported 89.73 percent lines and 84.51 percent branches.

The commit-helper regression suite passed its accepted and refused cases.

Writing checks found zero failures and zero warnings in the report, message, design, and new research-log region.

The script check found zero failures and two warnings from shell syntax.

The standalone ladder did not run by instruction.

Commit, staging, patch coverage, push, pull request updates, and the completion marker remain deferred.

Track 12 remains In progress.

## Track 12 source-process and saved-state recovery redesign — 2026-08-28

- D361: The user approved the revised Track 12 high-level design.
- Source-process inactivity is now a caller-owned handoff requirement rather than a Slate guarantee.
- Every clock, time-authority, authority-lease, maximum-deadline, expiry-decision, and clock-failure concept is removed from Track 12.
- Saved-state recovery can proceed immediately through a durable authority revision after the caller stops the source process.
- Recovery still covers interrupted recipient processes and recovery processes.
- Every other goal and non-goal remains unchanged.

Track 12 remains In progress.

### Revised Track 12 high-level design

# Track 12 High-Level Design

## Intention

Pi manages conversations with an agent. Slate is a Pi extension that coordinates work across Pi processes.

A durable session is Slate work that remains available after every participating process exits. Canonical state is the authoritative saved information for a durable session.

A source process is the Pi process that currently controls the saved work.

A recipient process is one newly created Pi process that seeks control of the durable session.

A recovery process continues an interrupted handoff.

A handoff transfers control from the source process to the recipient process. Writer authority is saved permission to change canonical state.

Recipient acceptance is saved confirmation that the recipient process has received control.

A durable authority revision is a saved version number for the current handoff decision.

A caller is the user or system that starts a handoff.

Before a handoff starts, the source process must finish all activity. The source process must exit or remain unable to change canonical state.

The caller must satisfy the source-process requirement.

Track 12 adds handoff and recovery for new durable sessions. Track 12 keeps canonical state in one stable external storage location.

Recovery preserves exclusive saved writer authority among recipient processes and recovery processes.

Normal Pi startup remains unchanged.

## Goals

- Support new durable sessions whose canonical state survives process exit.
- Preserve the work identity, policy, saved history, costs, modes, and pause state.
- Keep canonical state in one stable external storage location.
- Associate each handoff with exactly one source process and one new recipient process.
- Prevent a source process from completing handoffs to multiple recipient processes.
- Prevent a recipient process from accepting multiple source processes.
- Require the source process to finish all activity before the handoff starts.
- Require the source process to exit or remain unable to change canonical state.
- Make the caller responsible for satisfying the source-process requirement.
- Keep the recipient process free of canonical state and earlier authority information until the handoff finishes.
- Transfer saved writer authority and recipient acceptance through one exclusive saved decision.
- Keep saved writer authority exclusive among recipient processes and recovery processes.
- Make the recipient process the only saved writer after the handoff completes.
- Recover after the source process exits or terminates.
- Recover when a recipient process or recovery process becomes interrupted.
- Begin recovery immediately when saved state shows an incomplete handoff.
- Use saved handoff state and a durable authority revision for recovery.
- Allow competing recipient processes or recovery processes to attempt the next handoff decision.
- Permit only one competing process to save the next durable authority revision.
- Require every unsuccessful process to read and follow the saved result.
- Prevent a process-owned lock from governing or blocking recovery.
- Refuse a handoff after a conflicting source change was recorded.
- Refuse a handoff after a completed terminal action was recorded.
- Limit coordination to handoffs that share a source process or recipient process.
- Produce the same saved authority result on every supported operating system.
- Run every participant on one machine.
- Refuse legacy or uncertain saved information without changing the saved information.
- Preserve the existing trust rules for saved information.
- Keep normal startup inactive.
- Keep discovery, terminal operations, and production activation deferred.

## Components

Slate handoff coordination is the part of Slate that manages handoff decisions, saved writer authority, recipient acceptance, and recovery.

The stable external storage location holds canonical state and every authoritative handoff decision.

The source process controls the durable session before the handoff.

The recipient process seeks control after the caller satisfies the source-process requirement.

The recovery process continues an incomplete handoff after the source process exits or terminates.

```text
                      [Caller]
                          |
               satisfies the requirement
                          v
                  [Source process]
             finishes activity and exits
                  or cannot write

[Recipient process] ----\
                         > [Slate handoff coordination]
[Recovery process] -----/               |
                                        | reads and saves
                                        v
                         [Stable external storage location]
```

The stable external storage location remains authoritative for:

- canonical state
- writer authority
- recipient acceptance
- the durable authority revision
- handoff completion or cancellation

Explicit Track 12 invocation can reach handoff and recovery behavior.

Normal Pi startup keeps Track 12 behavior inactive.

## Approach

### Require source-process inactivity

The source process must finish every operation before the recipient process starts the handoff.

The source process must not change canonical state after the handoff starts.

The source process must exit or remain unable to change canonical state.

A live source process qualifies only when the caller has independently made the source process unable to write.

A stopped, unresponsive, or unreachable source process does not satisfy the source-process requirement by itself.

Slate assumes that the caller has satisfied the source-process requirement.

Slate does not verify or enforce source-process inactivity.

Slate does not protect a handoff if the source process resumes and changes canonical state.

Recovery may start only after the source process exits or terminates.

### Support only new durable sessions

Track 12 accepts only durable sessions created for Track 12 behavior.

The recipient process must remain free of canonical state and earlier authority information until the handoff finishes.

Track 12 does not merge or replace recipient work.

Each durable session has one policy and one stable external storage location.

The handoff preserves the policy, work identity, saved history, costs, modes, and pause state.

The handoff does not copy canonical state into the recipient process.

Malformed, conflicting, legacy, or uncertain saved information causes refusal without a state change.

Every participant must run on the same machine.

### Keep saved writer authority exclusive

The handoff changes saved writer authority from the source process to the recipient process.

An incomplete or cancelled handoff grants no new writer authority to the recipient process.

Only one recipient process or recovery process may hold saved authority to advance an unfinished handoff.

Only one conflicting handoff can complete.

Two handoffs conflict when both handoffs share a source process or recipient process.

A recorded source change causes a conflicting handoff to fail.

A terminal action is a saved action that permanently ends writable work.

A recorded terminal action causes a later handoff to fail.

A completed handoff makes the recipient process the only saved writer.

Unrelated source and recipient pairs remain independent.

Slate refuses recipient or recovery activity when saved writer authority is uncertain.

### Recover from saved state

Every handoff decision saves a new durable authority revision.

The stable external storage location must confirm the complete decision before the handoff decision becomes authoritative.

Recovery uses saved handoff state and the current durable authority revision.

Recovery may begin immediately when saved state shows an incomplete handoff and the source process has exited or terminated.

Recovery does not depend on the interrupted recipient process or recovery process.

Recovery does not require source-process participation.

Recovery does not require process-liveness evidence.

No process-owned lock governs or blocks recovery.

Competing recipient processes or recovery processes may attempt the next handoff decision.

Only one competing process may save the next durable authority revision.

Every unsuccessful process must read and follow the saved result.

Recovery may complete or cancel the interrupted handoff when canonical state permits that result.

Permanent loss of the stable external storage location may prevent recovery.

### Preserve the existing trust rules

Track 12 accepts structurally valid saved information without requiring authenticated origin information.

Track 12 does not change that trust rule.

Slate validates the saved properties needed for authority decisions.

Invalid, replaced, unexpectedly shared, or misplaced storage causes refusal without a state change.

Legacy information cannot authorize a handoff or identify a writable durable session.

Refusal does not migrate, reinterpret, copy, repair, or delete legacy information.

### Keep Track 12 inactive during normal startup

Explicit Track 12 invocation can reach handoff and recovery behavior.

Normal Pi startup cannot create or receive a Track 12 durable session.

Track 12 remains disconnected from normal production behavior.

Later work will add discovery, terminal operations, production activation, user guidance, and integrated validation.

## Non-goals

- Track 12 does not support a handoff while the source process remains able to change canonical state.
- Track 12 does not coordinate concurrent source-process activity during a handoff.
- Track 12 does not verify or enforce source-process inactivity.
- Track 12 does not force, suspend, or terminate the source process.
- Track 12 does not recover from a live source process.
- Track 12 does not treat an unresponsive or unreachable source process as inactive.
- Track 12 does not protect the handoff if the source process resumes and changes canonical state.
- Track 12 does not support or migrate legacy handoffs.
- Track 12 does not modify or delete legacy saved information.
- Track 12 does not activate durable behavior during normal Pi startup.
- Track 12 does not change normal production behavior.
- Track 12 does not add discovery after local session removal.
- Track 12 does not expose possible confidential discovery results.
- Track 12 does not add terminal operations or terminal records.
- Track 12 does not change repository or research-record permissions.
- Track 12 does not add production integration or user guidance.
- Track 12 does not support participants on different machines.
- Track 12 does not coordinate unrelated durable sessions.
- Track 12 does not add general authority revocation.
- Track 12 does not add source selection, cleanup, prompts, exceptions, or archive creation.
- Track 12 does not merge, replace, or discard recipient work.
- Track 12 does not create another authoritative storage location during a handoff.
- Track 12 does not detect project replacement when the project path remains unchanged.
- Track 12 does not protect against malicious code inside a participating process.
- Track 12 does not add cryptographic authentication.
- Track 12 does not redesign trust for saved information.
- Track 12 does not change ownership of saved conversation history.
- Track 12 does not delete old saved information automatically.

## Track 12 D361 implementation record — 2026-08-28

This action implemented Decision D361 without adding a decision.

The implementation removed the superseded time-based design and its saved fields.

Source inactivity is now a caller requirement that Slate does not inspect or enforce.

Saved handoff state and durable authority revisions now support immediate recovery.

One source chain stores canonical authority and each recipient chain stores reservations.

The final source decision changes writer ownership and records recipient acceptance together.

Competing completion and cancellation target one next authority revision.

Competing recipient reservations target one next recipient revision.

Every losing path rereads the saved result.

Source and recipient readers now validate predecessor order, endpoint identity, and claim grammar.

Authority-root device and inode identities detect replacement inside the stable storage location.

Publication writes `decision.json` and a matching `staging.json` marker in one complete non-empty directory.

Readers require both regular files after publication.

Cleanup requires the marker to match the staging directory name.

Publication verifies an absent destination before rename.

It never relies on replacing an existing directory and uses no hard link.

The final transfer rereads persisted reservation evidence and calls a current recipient reader.

The low-level boundary validates all recipient cleanliness fields itself.

Failed and competing publication cleans verified temporary state.

Cleanup and continuation failures preserve the authoritative saved result.

Focused tests passed 147 cases.

The full no-gate run passed 589 tests.

Strict resolver checks passed 230 result lines.

Both 18-result packaging runs passed.

Package-content checks and their self-test passed.

The latest full-suite run measured 89.54 percent lines and 83.99 percent branches.

The coverage gate remained skipped for the uncommitted diff.

The standalone ladder did not run by instruction.

Normal startup remains inactive.

Hosted macOS and Windows portability results remain pending.

Track 12 remains In progress.

## Track 12 handoff-process scope amendment — 2026-08-28

- D362: The user approved the Track 12 high-level design amendment.
- The caller runs only one handoff process at a time. The caller waits for that process to finish or terminate.
- Slate does not detect, coordinate, or protect saved work against overlapping handoff processes.
- Recipient-state safety remains required when recipient state changes during one handoff process.
- Repeated implementation regressions showed that coordination between overlapping handoff processes was outside the approved goal.
- The existing intention, goals, component diagram, approach, and non-goals remain preserved with this scope clarification.

Track 12 remains In progress.

### Amended Track 12 high-level design

# Track 12 High-Level Design

## Intention

Pi manages conversations with an agent. Slate is a Pi extension that coordinates work across Pi processes.

A durable session is Slate work that remains available after every participating process exits. Canonical state is the authoritative saved information for a durable session.

A source process is the Pi process that currently controls the saved work.

A recipient process is one newly created Pi process that seeks control of the durable session.

A recovery process continues an interrupted handoff.

A handoff transfers control from the source process to the recipient process. Writer authority is saved permission to change canonical state.

Recipient acceptance is saved confirmation that the recipient process has received control.

A durable authority revision is a saved version number for the current handoff decision.

A caller is the user or system that starts a handoff.

Before a handoff starts, the source process must finish all activity. The source process must exit or remain unable to change canonical state.

The caller must satisfy the source-process requirement. The caller runs only one handoff process at a time. The caller waits for that process to finish or terminate.

Track 12 does not detect, coordinate, or protect saved work against overlapping handoff processes.

Track 12 adds handoff and recovery for new durable sessions. Track 12 keeps canonical state in one stable external storage location.

Recovery preserves exclusive saved writer authority among recipient processes and recovery processes.

Normal Pi startup remains unchanged.

## Goals

- Support new durable sessions whose canonical state survives process exit.
- Preserve the work identity, policy, saved history, costs, modes, and pause state.
- Keep canonical state in one stable external storage location.
- Associate each handoff with exactly one source process and one new recipient process.
- Prevent a source process from completing handoffs to multiple recipient processes.
- Prevent a recipient process from accepting multiple source processes.
- Require the source process to finish all activity before the handoff starts.
- Require the source process to exit or remain unable to change canonical state.
- Make the caller responsible for satisfying the source-process requirement.
- Require the caller to run only one handoff process at a time.
- Require the caller to wait for that process to finish or terminate.
- Keep the recipient process free of canonical state and earlier authority information until the handoff finishes.
- Preserve recipient-state safety when recipient state changes during one handoff process.
- Transfer saved writer authority and recipient acceptance through one exclusive saved decision.
- Keep saved writer authority exclusive among recipient processes and recovery processes.
- Make the recipient process the only saved writer after the handoff completes.
- Recover after the source process exits or terminates.
- Recover when a recipient process or recovery process becomes interrupted.
- Begin recovery immediately when saved state shows an incomplete handoff.
- Use saved handoff state and a durable authority revision for recovery.
- Allow one caller-sequenced recipient process or recovery process to attempt the next handoff decision.
- Permit that process to save only the next durable authority revision.
- Require every later process to read and follow the saved result.
- Prevent a process-owned lock from governing or blocking recovery.
- Refuse a handoff after a conflicting source change was recorded.
- Refuse a handoff after a completed terminal action was recorded.
- Limit coordination to handoffs that share a source process or recipient process.
- Produce the same saved authority result on every supported operating system.
- Run every participant on one machine.
- Refuse legacy or uncertain saved information without changing the saved information.
- Preserve the existing trust rules for saved information.
- Keep normal startup inactive.
- Keep discovery, terminal operations, and production activation deferred.

## Components

Slate handoff coordination is the part of Slate that manages handoff decisions, saved writer authority, recipient acceptance, and recovery.

The stable external storage location holds canonical state and every authoritative handoff decision.

The source process controls the durable session before the handoff.

The recipient process seeks control after the caller satisfies the source-process requirement.

The recovery process continues an incomplete handoff after the source process exits or terminates.

```text
                      [Caller]
                          |
               satisfies the requirement
                          v
                  [Source process]
             finishes activity and exits
                  or cannot write

[Recipient process] ----\
                         > [Slate handoff coordination]
[Recovery process] -----/               |
                                        | reads and saves
                                        v
                         [Stable external storage location]
```

The stable external storage location remains authoritative for:

- canonical state
- writer authority
- recipient acceptance
- the durable authority revision
- handoff completion or cancellation

Explicit Track 12 invocation can reach handoff and recovery behavior.

Normal Pi startup keeps Track 12 behavior inactive.

## Approach

### Keep handoff-process coordination caller-owned

The caller runs only one handoff process at a time. The caller waits for that process to finish or terminate.

Slate does not detect, coordinate, or protect saved work against overlapping handoff processes.

Recipient-state safety remains required when recipient state changes during one handoff process.

Repeated implementation regressions showed that coordination between overlapping handoff processes was outside the approved goal.

### Require source-process inactivity

The source process must finish every operation before the recipient process starts the handoff.

The source process must not change canonical state after the handoff starts.

The source process must exit or remain unable to change canonical state.

A live source process qualifies only when the caller has independently made the source process unable to write.

A stopped, unresponsive, or unreachable source process does not satisfy the source-process requirement by itself.

Slate assumes that the caller has satisfied the source-process requirement.

Slate does not verify or enforce source-process inactivity.

Slate does not protect a handoff if the source process resumes and changes canonical state.

Recovery may start only after the source process exits or terminates.

### Support only new durable sessions

Track 12 accepts only durable sessions created for Track 12 behavior.

The recipient process must remain free of canonical state and earlier authority information until the handoff finishes.

Track 12 does not merge or replace recipient work.

Each durable session has one policy and one stable external storage location.

The handoff preserves the policy, work identity, saved history, costs, modes, and pause state.

The handoff does not copy canonical state into the recipient process.

Malformed, conflicting, legacy, or uncertain saved information causes refusal without a state change.

Every participant must run on the same machine.

### Keep saved writer authority exclusive

The handoff changes saved writer authority from the source process to the recipient process.

An incomplete or cancelled handoff grants no new writer authority to the recipient process.

Only one recipient process or recovery process may hold saved authority to advance an unfinished handoff.

Only one conflicting handoff can complete.

Two handoffs conflict when both handoffs share a source process or recipient process.

A recorded source change causes a conflicting handoff to fail.

A terminal action is a saved action that permanently ends writable work.

A recorded terminal action causes a later handoff to fail.

A completed handoff makes the recipient process the only saved writer.

Unrelated source and recipient pairs remain independent.

Slate refuses recipient or recovery activity when saved writer authority is uncertain.

### Recover from saved state

Every handoff decision saves a new durable authority revision.

The stable external storage location must confirm the complete decision before the handoff decision becomes authoritative.

Recovery uses saved handoff state and the current durable authority revision.

Recovery may begin immediately when saved state shows an incomplete handoff and the source process has exited or terminated.

Recovery does not depend on the interrupted recipient process or recovery process.

Recovery does not require source-process participation.

Recovery does not require process-liveness evidence.

No process-owned lock governs or blocks recovery.

One caller-sequenced recipient process or recovery process may attempt the next handoff decision.

That process may save only the next durable authority revision.

Every later process must read and follow the saved result.

Recovery may complete or cancel the interrupted handoff when canonical state permits that result.

Permanent loss of the stable external storage location may prevent recovery.

### Preserve the existing trust rules

Track 12 accepts structurally valid saved information without requiring authenticated origin information.

Track 12 does not change that trust rule.

Slate validates the saved properties needed for authority decisions.

Invalid, replaced, unexpectedly shared, or misplaced storage causes refusal without a state change.

Legacy information cannot authorize a handoff or identify a writable durable session.

Refusal does not migrate, reinterpret, copy, repair, or delete legacy information.

### Keep Track 12 inactive during normal startup

Explicit Track 12 invocation can reach handoff and recovery behavior.

Normal Pi startup cannot create or receive a Track 12 durable session.

Track 12 remains disconnected from normal production behavior.

Later work will add discovery, terminal operations, production activation, user guidance, and integrated validation.

## Non-goals

- Track 12 does not support a handoff while the source process remains able to change canonical state.
- Track 12 does not coordinate or protect saved work against overlapping handoff processes.
- Track 12 does not verify or enforce source-process inactivity.
- Track 12 does not force, suspend, or terminate the source process.
- Track 12 does not recover from a live source process.
- Track 12 does not treat an unresponsive or unreachable source process as inactive.
- Track 12 does not protect the handoff if the source process resumes and changes canonical state.
- Track 12 does not support or migrate legacy handoffs.
- Track 12 does not modify or delete legacy saved information.
- Track 12 does not activate durable behavior during normal Pi startup.
- Track 12 does not change normal production behavior.
- Track 12 does not add discovery after local session removal.
- Track 12 does not expose possible confidential discovery results.
- Track 12 does not add terminal operations or terminal records.
- Track 12 does not change repository or research-record permissions.
- Track 12 does not add production integration or user guidance.
- Track 12 does not support participants on different machines.
- Track 12 does not coordinate unrelated durable sessions.
- Track 12 does not add general authority revocation.
- Track 12 does not add source selection, cleanup, prompts, exceptions, or archive creation.
- Track 12 does not merge, replace, or discard recipient work.
- Track 12 does not create another authoritative storage location during a handoff.
- Track 12 does not detect project replacement when the project path remains unchanged.
- Track 12 does not protect against malicious code inside a participating process.
- Track 12 does not add cryptographic authentication.
- Track 12 does not redesign trust for saved information.
- Track 12 does not change ownership of saved conversation history.
- Track 12 does not delete old saved information automatically.

## Cross-track same-session scope decision — 2026-08-28

- D363: The user approved the final cross-track high-level design after the D362 amendment. Every synchronization attempt and every conflict between processes accessing the same Slate session belongs to the caller. Slate must not assign or enforce same-session writer ownership, preserve overlapping writes, resolve same-session conflicts, detect resumed source activity, enforce one writer, or enforce terminal lifecycle status against later same-session processes.
- D363 retains different-session isolation, structural validation, sequential interruption recovery, and inactive normal startup. Handoff completion means saved recipient state that Slate reads back and structurally validates. Completion is information and does not grant ownership.
- Track 12 must remove conflicting behavior introduced by Track 11 without reopening Track 11 history or unrelated goals. Track 13 remains read-only and informational. Track 14 records lifecycle status as historical information and may retain the project-writer rule only for a project file shared by different Slate sessions. Track 15 owns public guidance, integration, and verification without restoring removed behavior.
- The rule applies to every later track unless a new user-approved high-level design changes it. Track 14 owns the content of project-file guidance. Track 15 owns public publication, integration, and verification, so their guidance responsibilities do not conflict.

### Adversarial review findings and resolutions

- AD2601: The design now names the caller as the handoff actor, defines completion as saved recipient state read back and structurally validated, and states the caller's post-termination choices: accept the saved result as information, request sequential recovery, or abandon the operation.
- AD2602: Structural validation now lists record and storage checks separately from same-session coordination. Valid terminal information is historical and cannot block access. Namespace and record integrity refusal remains without ownership or lifecycle enforcement.
- AD2603: The same-session ownership ban is explicit. Track 14 may retain the project-writer rule only for a project file shared by different Slate sessions. It may not assign or enforce a writer for one Slate session.
- WC2601: Track 14 owns project-file guidance content. Track 15 owns public publication, integration, and verification. The split prevents contradictory guidance ownership.
- WI2601: D363 binds every later track to the no-synchronization and no-enforcement rule. Only a new user-approved high-level design may change that rule.

The user gave final approval for D363 on 2026-08-28.

The approved Track 12 design artifact is `track-artifacts/track-12-stable-handoff/design.md`.
The following copy is byte-identical to that artifact.

# Track 12 High-Level Design

## Intention

Pi manages conversations with an agent. Slate is a Pi extension that coordinates work across Pi processes.

A durable session is Slate work that remains available after participating processes exit. Canonical state is the authoritative saved information for a durable session.

A same-session process is a process that accesses one durable Slate session. A different-session process accesses another durable Slate session.

A source process is the process that holds the current saved state before handoff. A recipient process is the newly created process that receives a saved copy of the session state.

A recovery process continues an interrupted handoff. A caller is the user or system that starts a handoff.

A handoff is a caller-started operation that saves recipient state for a durable session. Handoff completion means that Slate saves the recipient state, reads it back, and structurally validates it. Completion is information. Completion does not grant ownership.

Structural validation checks the expected fields, types, identities, names, sizes, encoding, and storage paths. It does not assign ownership, detect process activity, resolve conflicts, or enforce lifecycle status.

The caller owns every synchronization attempt and every conflict between processes that access the same Slate session. Slate does not assign or enforce same-session writer ownership. Slate does not preserve overlapping writes or resolve same-session conflicts. Slate does not detect resumed source activity or enforce one writer. Slate does not enforce terminal lifecycle status against later same-session processes.

The caller runs only one handoff process at a time. The caller waits for that process to finish or terminate. After termination, the caller inspects the saved recipient state. The caller may accept that information, request sequential recovery, or abandon the operation. Slate does not coordinate another process for the caller.

Track 12 retains isolation between different durable sessions, structural validation, sequential interruption recovery, and inactive normal startup.

## Goals

- Support new durable sessions whose canonical state survives process exit.
- Preserve the work identity, policy, saved history, costs, modes, and pause state.
- Keep canonical state in one stable external storage location.
- Keep different durable sessions isolated from one another.
- Keep a recipient free of canonical state until the handoff saves recipient state.
- Save recipient state without copying canonical state into a second authoritative namespace.
- Define completion as saved recipient state that Slate reads back and structurally validates.
- Make completion informational rather than an ownership grant.
- Preserve recipient-state safety when recipient state changes during one handoff process.
- Let the caller run one handoff process at a time and wait for its result.
- Support sequential recovery after an interrupted handoff.
- Let a recovery process read saved state, save the next valid recipient state, and receive read-back structural validation.
- Preserve the saved result after a local continuation failure.
- Validate identity, policy, state shape, storage boundaries, and path containment.
- Refuse malformed, replaced, legacy, mixed, or uncertain saved information without changing it.
- Keep normal Pi startup inactive.
- Keep discovery, terminal operations, production activation, public guidance, and integrated validation deferred to later tracks.

## Components

The handoff reader and writer save recipient state in the stable external storage location. The structural validator checks saved data and storage boundaries. The caller supplies sequencing and owns same-session conflicts. The recovery process performs a later caller-selected attempt.

```text
                         [Caller]
                    owns sequencing and
                    same-session conflicts
                             |
                starts and waits for one process
                             v
 [Source process] ----> [Handoff process] <---- [Recipient process]
        |                      |
        |                      | saves recipient state
        |                      v
        |              [Structural validator]
        |                      |
        |                      | reads back and validates
        |                      v
        |           [Stable external namespace]
        |                      ^
        |                      |
        +------------ [Recovery process]

  Different namespaces remain isolated.
  Completion reports information and grants no ownership.
```

The stable external namespace remains authoritative for canonical state and saved recipient state. It does not become a writer-ownership registry.

Explicit Track 12 invocation can reach handoff and recovery behavior. Normal Pi startup keeps Track 12 behavior inactive.

## Approach and data flow

### Keep same-session coordination caller-owned

The caller runs only one handoff process at a time and waits for that process to finish or terminate. The caller owns every synchronization attempt and every same-session conflict.

The caller must prevent branch changes and staged-file changes during the Track 12 commit action. Track 12 does not coordinate with another process changing the same Git worktree during that action.

Track 12 retains the prepared commit message and the one-track-one-commit requirement. Track 12 removes the single-use commit helper and its tests because repeated commit-helper regressions were unrelated to Track 12 runtime goals.

Track 12 does not promise a stable whole-repository coverage percentage before the Track 12 commit exists. Repeated percentage changes unrelated to durable handoff behavior do not determine Track 12 correctness.

The implementation report keeps the exact full-test command, passing-test result, and exit status. It keeps the reason the patch coverage gate has not run. It keeps the requirement to run the patch coverage gate after the commit. The report omits unstable exact pre-commit coverage percentages. Committed patch coverage is the applicable change-specific check.

Slate does not assign or enforce same-session writer ownership. Slate does not coordinate overlapping processes. Slate does not preserve overlapping writes or resolve conflicts. Slate does not detect resumed source activity or enforce one writer. Slate does not enforce terminal lifecycle status against a later same-session process.

A different-session process remains isolated by its own durable namespace. This isolation does not create same-session ownership or conflict enforcement.

### Save and validate recipient state

The caller starts a handoff for a new durable session. The source process supplies the current saved state. The recipient process starts without canonical state or earlier authority information.

Slate validates the selected namespace, identity, policy, record shape, and storage path before writing. Slate saves recipient state in the stable external namespace. Slate reads the saved recipient state back and structurally validates the result.

A successful read-back is handoff completion information. It does not authorize a writer, select a winner, or prevent another same-session process from writing. Slate does not preserve overlapping writes or resolve the resulting conflict.

A malformed, replaced, legacy, mixed, or uncertain record causes refusal without migration, repair, deletion, or reinterpretation. Structural refusal protects namespace and record integrity. It does not enforce ownership or lifecycle status.

### Recover sequentially after interruption

If a handoff process terminates before a usable read-back result, the caller decides whether to request recovery. The caller starts recovery only as a later, sequential process.

Recovery reads the saved state and validates its structure. Recovery may save the next recipient state when the records and storage paths are valid. Recovery reads that state back and structurally validates it. Recovery does not need the interrupted process to run.

Slate does not detect whether the source process resumed. Slate does not protect recovery from a resumed source or another same-session process. The caller owns that risk and the conflict it creates.

A local failure after a valid saved result does not erase or roll back that result. Permanent loss or corruption of the stable namespace may prevent recovery.

### Support only new durable sessions

Track 12 accepts only durable sessions created for Track 12 behavior. Each durable session has one policy and one stable external namespace. Handoff preserves policy, work identity, saved history, costs, modes, and pause state.

Track 12 does not merge, replace, or discard recipient work. It does not create a second authoritative namespace. It does not support or migrate legacy sessions.

### Preserve the plain persisted-data boundary

Slate validates expected fields, types, identities, names, sizes, text encoding, and path containment. It refuses linked, replaced, malformed, oversized, or escaped storage paths.

Track 12 accepts structurally valid saved information without authenticated origin information. Track 12 does not add cryptographic authentication. Refusal leaves saved evidence unchanged.

### Keep Track 12 inactive during normal startup

Explicit Track 12 invocation can reach handoff and recovery behavior. Normal Pi startup cannot create or receive a Track 12 durable session.

Track 12 remains disconnected from normal production behavior. Track 13 remains read-only and informational. Track 14 records lifecycle status as historical information. It may retain the project-writer rule only for a project file shared by different Slate sessions. Track 15 owns public guidance, integration, and verification.

The same-session boundary applies to every later track. A later track may change it only through a new user-approved high-level design.

## Non-goals

- Assigning or enforcing same-session writer ownership.
- Preserving overlapping writes.
- Resolving conflicts between same-session processes.
- Detecting resumed source activity.
- Enforcing one writer.
- Enforcing terminal lifecycle status against later same-session processes.
- Coordinating overlapping handoff or recovery processes.
- Treating completion as an ownership grant.
- Treating a saved terminal status as an access-control gate.
- Verifying or enforcing source-process inactivity.
- Forcing, suspending, or terminating a source process.
- Recovering from a live source process as an automatic decision.
- Supporting or migrating legacy handoffs or sessions.
- Modifying or deleting legacy saved information.
- Activating durable behavior during normal Pi startup.
- Changing normal production behavior.
- Adding discovery, sibling metadata, terminal commands, or terminal enforcement.
- Assigning or enforcing a project writer for one Slate session.
- Changing the project-writer rule for a project file shared by different Slate sessions.
- Adding production integration, public guidance, or integrated verification.
- Supporting participants on different machines.
- Adding locks, leases, revocation, forced shutdown, source selection, prompts, waivers, cleanup, or archive creation.
- Merging, replacing, or discarding recipient work.
- Creating another authoritative storage location during a handoff.
- Adding cryptographic authentication or authenticated provenance.
- Redesigning trust for saved information.
- Changing Pi transcript ownership or storage.
- Adding automatic pruning or a secondary archive.
- Coordinating with another process changing the same Git worktree during the Track 12 commit action.
- Promising a stable whole-repository coverage percentage before the Track 12 commit exists.

## Track 12 Git-worktree scope amendment — 2026-08-28

- D364: The user approved a Git-worktree scope amendment after D363. Track 12 does not coordinate with another process changing the same Git worktree during the Track 12 commit action. The caller must prevent branch changes and staged-file changes during that action.
- D364 retains the prepared commit message and the one-track-one-commit requirement. Track 12 removes the single-use commit helper and its tests because repeated commit-helper regressions were unrelated to Track 12 runtime goals.

The user gave final approval for D364 on 2026-08-28.

## Track 12 coverage-report scope amendment — 2026-08-28

- D365: The user approved the final Track 12 coverage-report scope amendment after D364. Track 12 does not promise a stable whole-repository coverage percentage before the Track 12 commit exists. Repeated percentage changes unrelated to durable handoff behavior are not a Track 12 correctness measure. Committed patch coverage is the applicable change-specific check.
- D365 records the report consequence. The implementation report keeps the exact full-test command, passing-test result, and exit status. It keeps the reason the patch coverage gate has not run. It keeps the requirement to run the patch coverage gate after the commit. It omits unstable exact pre-commit coverage percentages.

The user gave final approval for D365 on 2026-08-28.

## Track 12 pre-commit verification record — 2026-08-31

The standalone Track 12 ladder used the repository-pinned Pi 0.83.0 through `PATH="$PWD/node_modules/.bin:$PATH"`.

`bash verification/run-ladder.sh --repo . --strict` exited 0 with 26 pass, 0 fail, and 0 not run.

All SAFE checks passed, and the real settings file remained unchanged.

The earlier 15-fail and 2-not-run result used global Pi 0.84.4 and is invalid for the pinned harness behavior.

## Track 12 final machine-review completion record — 2026-08-31

The cumulative D363-D365 implementation reviews and final gates have no open blocker or should-fix finding.

Hosted macOS and Windows portability results, post-commit patch coverage, commit, push, pull request updates, production activation, and Tracks 13 through 15 remain pending or deferred.

## Track 12 post-commit patch-coverage record — 2026-08-31

The command `npm test -- --base 0e2e2eb1b850ee5976a78a0ef1be2bf934ac25fa` exited with status 0.

The run reported 571 passing tests.

Line patch coverage was 191/194, or 98.45%.

Branch patch coverage was 60/70, or 85.71%.

The final verdict was PASS.

Uncovered changed lines were `extension/durable-handoff.ts:60`, `extension/durable-handoff.ts:61`, and `extension/state.ts:2277`.

Uncovered changed branches were `extension/durable-handoff.ts:58`, `extension/durable-handoff.ts:59`, `extension/session-record.ts:742`, `extension/session-record.ts:820`, `extension/state.ts:1450`, `extension/state.ts:1454`, `extension/state.ts:1553`, `extension/state.ts:1563`, `extension/state.ts:2275`, and `extension/state.ts:2323`.
