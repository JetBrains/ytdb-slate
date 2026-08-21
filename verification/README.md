# Verification ladder — global model-default restore

## Corpus session listing

`test/corpus-list.test.ts` covers `extension/corpus-list.ts` and the `/slate sessions`
command. It checks trust gating, bounded reads, metadata validation, display
sanitization, pending and foreign-worktree markers, defect rows, duplicate
identities, truncation, refusal paths, and the read-only guarantee.

Run the focused tests with:

```sh
node --test test/corpus-list.test.ts
```

The test creates temporary corpus data. It does not modify the repository or
user state. The listing command writes nothing and removes nothing.

Open an interactive session against a real corpus copy after command or
registration changes. Run `/slate sessions` from the project root and from a
subdirectory. Confirm that the output lists sessions, marks foreign worktrees,
and reports pending state without changing the corpus copy.

## Size-grade regression suite

`node verification/size-grade-tests.mjs` checks the shipped `extension/size-grade.mjs` command. The suite covers grade boundaries, all declared source extensions, binary numstat zero-line handling, configuration safety, Git failures, and output formats. It runs first through `verification/run-tests.sh`, so `npm test` and `npm run test:coverage` include it before the TypeScript tests and coverage gate. Use `npm run test:size-grade` for the focused package script. `run-tests.sh` refuses to start with exit 2 when the suite file is absent, so CI cannot silently skip this net.

Run the focused suite after any change to `extension/size-grade.mjs` or `verification/size-grade-tests.mjs`. Run `npm test -- --base <ref>` after changes to those files, `verification/run-tests.sh`, `package.json`, or any covered TypeScript source. The wrapper preserves forwarded `--base`, `--no-gate`, and threshold arguments.

A manual regression net for the mechanism in `extension/model-default.ts` and its
two callers, `extension/failover.ts` (orchestrator failover) and
`extension/handoff.ts` (handoff adoption) — plus one rung (`WK1`) for the other
half of the same hazard: the guarantee in `extension/worker.ts` that a
**worker-side per-dispatch** model/effort switch never reaches the user's global
defaults at all. Same failure class (a slate-initiated switch leaving the user's
pi configuration changed), different mechanism: the restore machinery repairs a
write that pi has already made, while a worker session is built so the write
cannot happen.

## Why this exists

The mechanism restores the user's **global** pi defaults — `defaultProvider`,
`defaultModel`, `defaultThinkingLevel` in `~/.pi/agent/settings.json` — after a
slate-initiated model switch. Two properties make it uniquely dangerous to leave
unguarded:

- **It fails silently when it regresses.** A restore that never runs looks
  exactly like a restore that ran and found nothing to do: no error, no warning,
  a settings file that merely still holds the switched value. The defect only
  surfaces later, in unrelated projects, as "pi keeps starting on the wrong
  model". Every rung here is therefore written to assert the *positive* fact
  (the switch fired **and** the file came back) rather than the absence of a
  complaint.
- **It writes to state outside the repository.** A bug here corrupts the user's
  own pi configuration, so the harness treats not touching real state as a
  hard requirement, not a convention (see § Safety model).

This ladder was the repo's first automated net, and it is no longer the only
one (`AGENTS.md` § Build & verification lists them all). CI (`AGENTS.md`
§ CI) runs the typecheck, guards the packaging, checks that the extension
loads, and checks that the resolver resolves. The package-content check, the
writing checker's two nets, and the writing-reminder integration check run by hand. None of those nets touches a
model switch, so this ladder is the only regression net for the mechanism. It exists
because several earlier ad-hoc verification passes silently proved nothing: a
probe that waited for pi's write from inside the wrapped switch made the
macrotask-yield rung unable to fail, and rungs with no recorded after-state
could not be re-checked. Rungs that cannot demonstrate their own teeth now
report **NOT RUN**, never PASS.

## Running it

```sh
bash verification/run-ladder.sh --repo .                  # everything, ~3 min
bash verification/run-ladder.sh --repo . --only G1,P5a    # a subset
bash verification/run-ladder.sh --repo . --lab /tmp/mylab
bash verification/run-ladder.sh --repo . --strict         # CI: any NOT RUN is fatal
bash verification/run-ladder.sh --repo . --setup-only     # guards + fixtures, no pi runs
bash verification/run-ladder.sh --list-rungs
bash verification/run-ladder.sh --help
```

The harness prints one line for each rung, then the safety verdict, then a
summary. A machine without `strace` prints the `P6` line below. The summary comes
from a complete run on a machine with `strace`:

```
RUNG R1     PASS    — failover probe-a/alpha-1⇒probe-b/beta-1 fired (model_change in session), settings byte-identical …
RUNG P6     NOT RUN — strace not available
SAFE   CORPUS PASS    — at least one current-run slate child published a scratch corpus session
SAFE   HOME   PASS    — throwaway HOME fallback agent remained untouched
SAFE   SESSION PASS   — selected throwaway agent contains current-run session evidence
SAFE   REPO   PASS    — repository fingerprint unchanged …
NOTE   REAL           — real settings content hash unchanged …; diagnostic only
== summary: 26 pass, 0 fail, 0 not run ==
```

Exit status: **0** all good; **1** a rung failed, **no rung ran**, a sandbox
safety check failed, the repository fingerprint changed, or `--strict` was given
and a check reported NOT RUN; **2** refused to start — a safety guard or usage error;
**3** the scratch directory disappeared mid-run, so every result printed is void
— re-run with an explicit `--lab` under a path nothing else touches. (That last
one is real: a neighbouring job doing `rm -rf /tmp/<prefix>*` will eat the
default scratch dir. The guard turns the cascade that follows into one clear
line — but it is checked at a **rung boundary**, so the rung already in flight
can still print one misleading line first, and that line can be a **PASS or a
FAIL**. Treat everything printed before the void-run message as void, whichever
verdict it carries.)

Options:

| option | meaning |
| --- | --- |
| `--repo <dir>` | checkout under test; `--repo .` from the repository root |
| `--lab <dir>` | scratch dir for `agent/`, `work/`, `out/`, `weak/` (default: fresh `mktemp`, kept). The caller must own it, group and other users must not have write access, and one run holds its atomic `.slate-ladder.lock` |
| `--only <ids>` | comma-separated rung ids, e.g. `--only R5a,R5b,R5c`. An **unknown id is a hard error** (exit 2), and a run that ends up executing no rung at all exits **1** — a mistyped id must never look like success |
| `--old-module <file>` | supply the pre-fix `model-default.ts` for the P5a/P5b teeth proof yourself; by default it is derived from the current module at run time |
| `--strict` | any NOT RUN becomes a failure (exit 1). **Automation should always pass this** — otherwise a ladder that skipped rungs, because `strace` was missing or a teeth derivation broke, reads as a clean pass. Off by default so a human without the optional tracing tool is not blocked |
| `--setup-only` | run every guard and build every fixture and generated copy, then stop without launching pi. The supported way to exercise setup safety |
| `--self-test` | run deterministic hermetic-launcher tests for environment closure, invalid roots, redirect loss, nested children, alternate agents, the runtime violation sentinel, outer guard, source audit and concurrent fabricated writes |
| `--list-rungs` | print the rung ids and exit |

### Rung selection semantics and interdependencies

`--only` filters which rung bodies execute; it does not reorder them, and rungs
run in the order listed in the table below regardless of the order you pass.
Three rungs read another rung's artifacts, so a subset that omits the
prerequisite makes them report NOT RUN rather than guess:

| rung | needs |
| --- | --- |
| `P9b` | `R7` **and** `R8` in the same run (it compares their two report verbs) |
| `P10` | `R5a` in the same run (to confirm failure reports still reach stderr) |
| `R4a`,`R4b`,`R5a`,`R5b`,`R5c`,`G4b`,`P8`,`P9a` | a valid named corpus handoff record and source-session metadata, which they create on demand — no cross-rung dependency |
| `WK1` | nothing: it launches its own two pi processes and opens its own worker sessions — no cross-rung dependency |

`LAT` is informational: it prints a median wall-clock comparison and never
contributes to pass/fail.

### Requirements and hard constraints

* `pi`, `node`, `python3`, and **GNU** coreutils — `sha256sum`, `stat -c`,
  `timeout`, `cmp`, `mkfifo`, `awk`, `sed`, `grep`, `cat`, `cp`, `cut`, `date`,
  `dirname`, `head`, `ls`, `rm`, `rmdir`, `sort`, `tail`, `wc`, `mktemp`. All are
  checked up front and a missing one aborts — a half-run ladder proves nothing.
  GNU `rm --one-file-system` is also required for scratch-state clearing.
  BSD/macOS `stat` and `shasum` are **not** supported: the script aborts rather
  than silently skipping the safety fingerprint.
* **`strace` is optional**; `P6` reports NOT RUN without it. It also needs
  permission to trace — in a container, `--cap-add=SYS_PTRACE` or an unrestricted
  `/proc/sys/kernel/yama/ptrace_scope`; without that `P6` reports NOT RUN too.
* **Do not run as root.** The script refuses. Every failure injection here is a
  `chmod 444`, and root writes straight through it, so `R7`, `G2`, `P6` and `P11`
  would report on behaviour that never happened.
* **No network**: every fake provider points at a dead local port.
* If you **reuse a `--lab`**, fixtures and generated copies are overwritten but
  old `out/` artifacts from previous runs are *not* deleted. Rungs that read
  another rung's artifacts (see above) can then read a stale one. Use a fresh lab
  when a verdict matters; the default `mktemp` lab is always fresh.

Artifacts land in `<lab>/out/`: per rung `<id>-before.json`, `<id>-after.json`,
`<id>.err`, `<id>.out`, plus `<id>.json` for probe rungs (elapsed ms, live
model, live thinking level, raw before/after) and `summary.txt`. Nothing is
cleaned up, deliberately — every verdict must be re-checkable from the files
alone.

## Files

| file | role |
| --- | --- |
| `run-ladder.sh` | the driver: fixtures, guards, all rungs, verdicts |
| `probe.ts` | pi extension that drives one switch through a chosen copy of the module, with controllable injections |
| `README.md` | this document |

Everything else the harness needs — the fake model catalogue, the settings-lock
holder, the `P11` assertion helper, `WK1`'s worker probe, and the deliberately
weakened module copies — is **generated at run time** into `<lab>/`. (`WK1`'s
probe is generated rather than committed for the same reason the weakened copies
are: it imports the module under test by a path chosen per run, so the same file
drives `extension/worker.ts` and the file-backed copy of it.) Every weakened copy
is derived from the module under test by a single textual transformation,
precisely so it cannot go stale and start proving nothing. Nothing is recovered from git history and no
snapshot of an old revision is committed: both go stale or vanish (a shallow
clone has no history to search, and a squash-merge erases the commit a history
search would look for).

`verification/` is not shipped: `package.json`'s `files` whitelist is
`extension`, `docs`, `README.md`, `LICENSE`.

## How the harness drives a switch

`<lab>/agent/models.json` declares three fake providers whose `baseUrl` points
at `127.0.0.1:8731` (nothing listens) and which carry a literal `apiKey` —
enough to satisfy pi's *configured-auth* check offline:

| model | reasoning | thinking ladder |
| --- | --- | --- |
| `probe-a/alpha-1` | yes | off…xhigh |
| `probe-a/alpha-2` | yes | off…xhigh — same provider, for a model-only divergence |
| `probe-b/beta-1` | no | — |
| `probe-c/gamma-1` | yes | off…**high** — narrower, so pi must clamp |

Seeded settings always carry `retry: { enabled: false }`: connection-refused is
classified RETRYABLE, and slate's cancel guard would otherwise suppress the
failover until pi exhausted its own retries.

Four drive modes, chosen per rung:

1. **End-to-end failover** — a `modelFailover` map in `<lab>/work/.pi/slate.json`
   plus `pi -e <repo> -p "say ok"`. The switch is proven from the session record
   (`model_change` entry), never from a log line — the success notice is
   deliberately UI-only.
2. **End-to-end handoff adoption** — a valid named record under the throwaway
   corpus, backed by source-session metadata, plus a real RPC request for
   `/slate adopt <name>` in a fresh trusted session. The record must remain after
   adoption, and stderr must carry the explicit positive success marker.
3. **`probe.ts`** — imports the module under test by absolute path and calls the
   real `withGlobalModelDefaultRestored` with the real `pi` and `ctx` around a
   real `pi.setModel`. Only the *caller* differs from the two shipped switch
   sites, which is what makes the injection windows (write failure, lock
   contention, third-party write, write-queue depth) deterministic.
4. **The worker probe** (`<lab>/worker-probe.ts`, generated) — opens a REAL
   worker session through `openWorkerSession` in the module under test and
   performs the per-dispatch model **and** effort switch exactly as
   `threads.ts`'s `applyRoute` does (`session.setModel` then
   `session.setThinkingLevel`). Used only by `WK1`, in two phases across two pi
   processes; `PI_OFFLINE=1` is set for it because `createAgentSession` may
   otherwise attempt a create-time catalogue refresh and this harness has no
   network.

## Rungs

| id | what it proves |
| --- | --- |
| `R1` | a real failover restores the file byte-identically, with the switch proven from the session record |
| `R2` | knob off ⇒ the leak reappears — the negative control that makes R1 non-vacuous |
| `R3a` | a clamped thinking level (`xhigh`→`high`) is restored to the user's preference, not the clamp |
| `R3b` | a thinking-level-**only** divergence through the failover site (pair already at the target) |
| `R4a` | explicit named handoff adoption writes the thinking key **alone**, skips `setModel`, emits a positive success marker, and retains its corpus record |
| `R4b` | explicit named handoff adoption writes model *and* thinking level, emits a positive success marker, and retains its corpus record |
| `R5a` | zero-byte settings file ⇒ warn, write nothing, never delete |
| `R5b` | corrupt settings file ⇒ warn, write nothing, never delete |
| `R5c` | settings lock held ⇒ warn, write nothing, never delete |
| `R6` | a mid-session third-party write survives session end — there is no shutdown backstop |
| `R7` | a failed restore write is reported with its cause, not swallowed; the process still ends normally |
| `R8` | the retry budget is bounded: it abandons and reports instead of hanging |
| `G1` | the **macrotask** yield survives a deep write queue — *with teeth*, see below |
| `G2` | a transient write failure retries and writes back the ORIGINAL pre-switch reference, never a value re-read after the failed attempt |
| `G4a` | same-provider, model-only divergence |
| `G4b` | thinking key absent beforehand ⇒ restored to **absence**, pair untouched |
| `P5a` | a third party changing **one half** of the provider/model pair ⇒ the whole pair is left alone (no mixed pair pi could never produce) |
| `P5b` | the same with the pre-switch pair absent — no `defaultModel` left with no `defaultProvider` |
| `P6` | retry pacing bounds real write attempts to tens, not hundreds |
| `P7` | the budget uses a monotonic clock — established by code inspection; the system clock is deliberately **not** manipulated |
| `P8` | escape bytes in a corrupt settings file never reach the terminal through slate's own report |
| `P9a` | when no pi setter ran, the wrapper does no post-switch work, burns no budget and says nothing |
| `P9b` | when divergence could not be established, the report says "could not check", never an unfounded leak claim |
| `P10` | success notices stay off stderr (they would scribble pi-tui's frame) while failure reports remain visible in print mode |
| `P11` | a report that hits the length cap is cut **on a word boundary**, carries an explicit truncation marker, and keeps the headline, affected keys, settings path and cause while losing only the advisory tail |
| `WK1` | a **worker-side per-dispatch** model *and* effort switch (a) writes **zero bytes** to the global settings file and (b) does not survive into a reopened session as a sticky default |
| `LAT` | median wall clock, knob on vs off, n=7 each — informational, never a pass/fail |
| `SAFE` | the runtime pi shim recorded no unauthorized PATH-based invocation, corpus evidence exists, every recorded agent root is validated, the throwaway-HOME fallback stayed untouched, and the read-only repository fingerprint is unchanged. A focused rung whose guarded launcher starts no pi child reports a positive not-applicable PASS |

Every rung that drives a switch also asserts **positive evidence that the switch
actually fired**, from the session record (`model_change`, or
`thinking_level_change` for the thinking-only paths) — not from the settings file
alone. Without that a rung passes happily when the mechanism aborted before doing
anything, which is the exact failure mode this ladder exists to catch. `WK1` takes
its positive evidence from the live worker session instead (`session.model` and
`session.thinkingLevel` before and after the switch), because its subject is a
worker session, not the host one.

### What `WK1` does, and why it is here

Nothing else in this repo's verification story opened a worker session, so the
per-dispatch worker switch — which per-action routing performs on **every**
dispatch, not just on failover — was completely unguarded. It fails silently in
the same way the restore mechanism does: the switch works, the action runs, the
episode is fine, and the only symptom surfaces weeks later as "pi keeps starting
on the model some worker thread was routed to".

The rung drives one worker session through the module under test, switching it
from `probe-a/alpha-1` at `medium` to `probe-c/gamma-1` at `high` — both halves,
because `applyRoute` performs both and only the model half goes through
`setModel`. It then asserts, in order:

1. the switch **took effect on the worker session** (`session.model` /
   `session.thinkingLevel` moved), so the rung cannot pass on a switch that never
   happened;
2. the global settings file is **byte-identical** across both pi processes — the
   zero-bytes claim, asserted on the file rather than on the absence of a
   complaint;
3. a **second pi process, launched with no model on the command line** (so its
   session model *is* the global default), opens its worker on the seeded default
   — the not-sticky claim, observed as a consequence in a real reopened session
   rather than inferred from the byte comparison. The two are physically linked
   (a sticky default *is* a settings write), which is the point: they are two
   independent observations of one leak, and the second is the one a user would
   actually notice.

What it deliberately does **not** assert: reopening the same **thread** session
file can legitimately restore the switched model from that session's own record
(`threads.ts`, CQ3). That is session-scoped state, not a global default, and a
different mechanism.

### What to do about a NOT RUN

NOT RUN means the rung could not be made meaningful, never that it passed. None is
fatal on its own, but a run with NOT RUNs has proportionally less coverage — do
not merge a change to the mechanism on the strength of one. **In automation pass
`--strict`**, which turns any NOT RUN into a failing run; the table below is then
the list of things to fix before CI goes green again.

| NOT RUN reason | what to do |
| --- | --- |
| `strace not available` (`P6`) | install `strace`, or run where tracing is permitted (`--cap-add=SYS_PTRACE`, or `ptrace_scope=0`). Without it the retry-pacing bound is unverified. |
| `no failed settings write syscalls seen in the trace` (`P6`) | `strace` ran but the pattern did not match — usually a different libc/`openat` shape. Inspect `<lab>/out/P6.strace` and adjust the pattern in the rung. |
| `the pacing-0 copy could not be built or did not blow the bound` (`P6`) | `RETRY_PACING_MS = 25;` was renamed or reformatted in the module. Update the substitution in the driver. |
| `weakened copy could not be produced` (`G1`) | the yield helper's body no longer matches the driver's substitution. Update it, or `G1` has no teeth. |
| `write queue was not deep enough at depth N` (`G1`) | a pi upgrade changed the number of internal awaits in `setModel`, so pi's write had already landed and a weakened yield could not be caught. Raise `QD` in the rung (see the depth-threshold note below). |
| `the pre-fix module could not be recovered` / `did not reproduce the mixed pair` (`P5a`,`P5b`) | `planPairRestore` was renamed or restructured, so the per-half variant could not be derived. Fix the transformation, or pass `--old-module <file>` pointing at any revision that decides the halves separately. |
| `the cap-removed copy could not be generated` (`P11`) | `REPORT_MAX_CHARS = 500;` changed shape. Update the substitution. |
| `the cap-removed copy emitted no report` (`P11`) | the copy with the cap removed produced no `slate:` line, so the full message is unknown and there is nothing to compare a cut against. Check `<lab>/out/P11-full.err` — usually the injection stopped working, not the truncation. |
| `the fixture's full report is only N chars` (`P11`) | the report got shorter; raise `P11_PATH_LEN` until the cap is reached. |
| `scratch path too long` (`P11`) | re-run with a shorter `--lab`. |
| `the JSON parse error carries no raw escapes` (`P8`) | the Node version stopped embedding the raw snippet. The rung would pass vacuously, so it stands down; sanitisation must then be reviewed by reading the code. |
| `needs the R7 and R8 artifacts` (`P9b`) / `needs the R5a artifact` (`P10`) | you used `--only` without the prerequisite. Add it (see the interdependency table above). |
| `the file-backed copy could not be built or did not leak either` (`WK1`) | `worker.ts`'s read-only `SettingsManager.fromStorage(…)` block changed shape, so the file-backed variant could not be derived — or it was derived and did **not** leak, which would mean pi stopped persisting a session-level `setModel` at all. Fix the substitution, or the rung has no teeth. The rung's own assertions are reported first, so a FAIL still means a real leak. |

### Teeth

Three rungs are paired with a deliberately broken copy of the module, generated
into `<lab>/weak/` and never committed, so a rung that *cannot* fail is visible
as such:

- **`G1`** — a copy with the macrotask yield replaced by a microtask one. It must
  leak while the real module does not; if it does not leak, the rung reports NOT
  RUN.
- **`P6`** — a copy with `RETRY_PACING_MS = 0`. It must blow the attempt bound.
- **`P5a` / `P5b`** — a **per-half variant** of the current module: the pair
  decision is rewritten to decide each half on its own and re-state the other half
  at its current on-disk value, which is exactly what the pre-fix revision did. It
  must produce the mixed pair and the provider-less model that the fix eliminates.
  Derived at run time from the module under test, so it works on a shallow clone
  and survives a squash-merge; `--old-module <file>` overrides it. If the
  transformation cannot be applied, both rungs report NOT RUN.
- **`P11`** — two copies: one with the report cap removed, which is how the rung
  learns the *full* message and can prove the emitted line is only a cut of it;
  and one with the word-boundary search removed, which the rung's own checks must
  **reject**. The rung claims teeth only when they do, and says so otherwise.

- **`WK1`** — a copy of `worker.ts` whose worker sessions get a **file-backed**
  `SettingsManager` instead of the read-only snapshot one, which is precisely the
  pre-AF8/AF9 defect. It must leak — write the switch into the global settings
  and/or leave the next session's worker on the switched model — while the real
  module does neither; if it does not leak, the rung reports NOT RUN.

`G2` carries an inline teeth check instead: it fails itself if the run finished
too fast for the first write attempt to have failed. `P8` first confirms that
the fixture's JSON parse error really does carry raw escape bytes before
asserting that none reach the terminal.

### Assertions are anchored on meaning, not prose

Every assertion that reads slate's own output goes through the helpers at the top
of the driver (`said_something`, `said`, `names_settings_file`) and matches only:

- the **distinguishing verb phrase** — `not restoring the global model defaults`
  (stood down), `could not restore the global model defaults` (tried and failed),
  `could not check the global model defaults` (could not even establish
  divergence). These carry meaning, and `P9b` exists precisely to keep the last
  two distinguishable;
- the **presence of the diagnostic parts** — the settings path (harness-known),
  the affected keys, and a **cause class written as a tolerant alternation**
  (`empty|zero.?byte|0 bytes`, `cannot read|unreadable|not valid JSON|JSON|pars`,
  `[Ll]ock`, `EACCES|permission denied`);
- **structural facts** — did slate write to stderr at all, does the session
  record contain a `model_change`, how many bytes is the file.

Two rules follow from the truncation behaviour and are worth stating outright:

1. **No assertion may require any part of an advisory tail.** Reports are built
   diagnostics-first and cut at `REPORT_MAX_CHARS`, so on a long settings path
   the tail — including any duration or "slate will not retry" clause — is
   legitimately absent. An assertion that needed it would fail on nothing but a
   long path. Where a rung needs to prove a bound, it asserts the **measured**
   elapsed time (`R8`), not a sentence claiming one.
2. **Prefer absence of a channel over absence of a phrase.** `P10` asserts that a
   successful failover leaves *no* `slate:` line on stderr rather than that one
   particular notice is missing — the phrase version would quietly stop
   discriminating the moment the notice were reworded.

#### The `G1` depth threshold is construction- and version-dependent

`G1` builds pi's settings write-queue depth by alternating `pi.setThinkingLevel`
synchronously immediately before `pi.setModel`, so pi's own pair write lands
behind those links. On **pi 0.82.1** with this construction the microtask-yield
copy first leaks at **depth ≥ 7** (depths 2–6 still pass), and the real module is
correct at every depth tried up to 51. The design text in PR #15 asserts "depth
four or more"; that number came from a different construction. The driver uses
depth 16 for headroom. **If a pi upgrade changes the number of internal awaits
inside `setModel`, this threshold moves** — when `G1` reports NOT RUN because
"pi's write had already landed", raise `QD` in the rung rather than assuming the
mechanism is fine.

### Timing-sensitive rungs

These depend on machine speed and load, and are the first to go flaky on a busy
or much slower box. A failure here is not automatically a code defect —
re-run on an idle machine before concluding anything.

| rung | why it is timing-sensitive |
| --- | --- |
| `G1` | needs pi's write to still be queued when `setModel` resolves; depends on pi's internal await count (see above) |
| `G2` | the 150 ms unwritable window must sit inside the 500 ms budget and cover at least one attempt |
| `R8` | asserts the abandon lands in a 400–1700 ms band around the 500 ms budget |
| `P6` | counts write syscalls inside the budget; the expected bound is ⌈500/25⌉+1 attempts |
| `R6` | polls an RPC session for the failover before writing the third-party change |
| `LAT` | pure wall-clock measurement; the knob's cost is within noise on a fast box |

`P11` is not timing-sensitive but **is path-length sensitive**: it pins the
settings path to a fixed length (`P11_PATH_LEN`, default 81) with a letters-only
pad, so the cap lands in the advisory prose on any machine and a no-boundary-search
copy demonstrably cuts mid-word. A very long `TMPDIR` makes that impossible and the
rung reports NOT RUN with the reason. If the report's fixed prose changes length,
the rung still asserts correctly — only the teeth line may change to "not
demonstrated at this alignment"; sweep `P11_PATH_LEN` by a few characters to
restore it.

## Safety model

The mechanism under test writes to the user's real pi settings, so the harness
tries hard to make reaching them structurally impossible. What follows is what
the guards actually check — not a claim that nothing could ever go wrong.

Every guard **aborts the run**; none degrades to a pass. Guard messages go to a
duplicate of the original stderr, so an abort from inside a rung (whose stderr is
redirected into an artifact file) is still visible.

0. **Refuse root, and refuse to start without the tools.** Root defeats the
   `chmod`-based failure injections silently, so the script will not run as root.
   Every required tool is checked up front, including the GNU `sha256sum` and
   `stat -c` that guard 4 depends on — a safety check that *cannot run* aborts
   rather than passing vacuously.
1. **No inherited redirect.** If `PI_CODING_AGENT_DIR` is already set, the script
   refuses to start: the harness must own that variable. The advice it prints
   hands your value back through `SLATE_LADDER_REAL_AGENT_DIR`, so a **custom**
   agent directory stays the thing the later guards protect — clearing the
   variable alone would point them at the default location instead.
2. **No scratch directory over real state.** `--lab` *and* the default location
   (which follows `TMPDIR`) are resolved through symlinks **before anything is
   created**, and rejected if they land inside the pi home tree, the real agent
   directory, or the repository working tree. The caller must own the resolved
   lab and agent directories, and neither may permit group or other writes.
   Existing removal-path directories receive the same ownership and mode check.

   One atomic `mkdir` acquires `<lab>/.slate-ladder.lock` before setup. The lock
   remains through final safety reporting. Cleanup releases it, or prints the
   lock path and manual remedy when release fails. A failed release changes an
   otherwise successful exit to non-zero. An existing lock refuses the run
   immediately; the harness never waits or guesses whether another run is alive.
3. **Every directory the harness writes to is validated, not just one.**
   `agent/`, `work/`, `out/` and `weak/` are each created with a *checked*
   `mkdir`, canonicalised, required to be non-empty, absolute, an actual
   directory, and inside the scratch root — so a symlinked component cannot walk
   out (a `work/` symlink into `~/.pi` used to be enough to write there). An
   unchecked `mkdir` here was a real blocker: it left the agent path **empty**,
   and an empty `PI_CODING_AGENT_DIR` makes pi fall back to the user's real agent
   directory.
4. **The agent directory is re-verified before every launch AND before every
   write into it.** One check, used at both sites: the path must be non-empty,
   absolute, **a real directory rather than a symlink**, not the real agent
   directory, and canonicalise to somewhere inside the scratch root. Deliberately
   redundant with guard 3 so no future edit can reintroduce the empty-variable
   blocker upstream of it — and applied at *writes*, not only launches, because a
   launch-time-only check is not enough: a same-user racer replacing
   `<lab>/agent` with a symlink mid-run once let harness fixture data land in the
   symlink's target while only the launch was refused. The recursive corpus and
   session reset inherits this same residual race. It validates ownership, mode,
   containment and device twice, removes the resolved path with
   `--one-file-system`, and performs the second check immediately before removal.
   A same-user swap after that final check remains outside the guarantee.
5. **Every child uses one hermetic launcher.** `env -i` supplies validated
   throwaway `HOME`, `TMPDIR` and the selected `PI_CODING_AGENT_DIR`, `PI_OFFLINE`,
   a PATH assembled from guarded absolute tool resolutions, and only explicit
   rung canaries. The real pi directory is absent from that PATH. After parent
   tools resolve, the parent PATH also removes that directory and puts the
   refusing shim first. A generated token-guarded `pi` shim is therefore the
   only PATH-visible pi command. It records the selected agent root in a durable
   ledger on every actual pi start. The script unsets its real pi path variable
   after generating the shim. The generated guard requires exact environment-key
   equality before it starts the requested command. `NODE_OPTIONS`, credentials, proxies,
   stale pi variables and `PI_CODING_AGENT_SESSION_DIR` are absent. A marker
   written from the child process `spawn` event makes every launch positive.
   P11 and alternate-agent launches use this same path.

   `HOME`, `TMPDIR` and each selected agent root are checked before every launch.
   Each must be non-empty, absolute, a real non-symlink directory and inside the
   lab. The inherited `PI_CODING_AGENT_DIR` refusal remains an outer fatal guard.
   A refused invocation with an invalid token or ledger atomically creates a
   per-run violation sentinel. Every hermetic launch fails when the sentinel
   exists. Before the final `SAFE PI` report, a bounded poll enumerates shell
   jobs and reaps jobs that are already exiting. A live job after the bound
   makes the report fail. The report checks the sentinel only after that drain.

   The runtime control catches PATH-based forms when command substitution or
   missing `set -e` hides the shim status. The sentinel resets only at controlled
   self-test boundaries.

   Before any rung starts, the source audit checks the complete ladder script.
   It rejects a literal or tainted pi-like command in foreground, background,
   or subshell command position. `echo pi` remains harmless. The audit also
   recursively parses command, input and output process substitutions. Its
   parser balances parentheses across nesting and lines while honoring shell
   quotes and escapes. A pi launcher command inside any parsed form is fatal.

   These controls prevent asynchronous checked-in syntax from racing the final
   sentinel check. The audit also checks direct real-path and exposed alias
   references. It does not claim to parse all shell grammar or inspect
   deliberately generated shell code.

   `--self-test` exercises poisoned parents, absent and empty roots, redirect-loss
   teeth, nested inheritance, runtime alternate-agent ledger registration and
   shim refusal outside the launcher. Source mutations cover background commands,
   subshells, command substitutions and input and output process substitutions.
   Process-substitution cases include nested and multiline forms. Harmless
   background jobs, process redirections and `echo pi` remain accepted. Drain
   tests cover an exiting job and bounded refusal of a live job. Runtime mutations
   cover `command pi`, both process substitutions, backticks, `$()`, bare `pi`,
   `xargs` and a shell wrapper. The remaining tests cover the outer guard and
   concurrent fabricated settings writes.

   The real settings content hash is now a NOTE only. A concurrent real session
   may change it without changing the verdict. Redirect evidence instead comes
   from the selected agent's session and corpus, plus an untouched fallback agent
   under the throwaway HOME.
6. **Slate child runs must populate the scratch corpus.** A marker is written
   only after a child that loads the full slate extension completes. Before any
   child runs, the harness validates the scratch agent directory and every
   existing removal-path directory. It clears `agent/ytdb-slate/projects`,
   `agent/sessions`, and the prior-run marker. Each recursive removal uses a
   resolved contained path, requires the agent device, and stays on one
   filesystem. A reused `--lab` therefore retains `work/`, `out/`, and `weak/`,
   while only current-run corpus and session records can satisfy assertions. The
   reset prints a NOTE for each prior state tree it removes.

   After the rungs finish, the harness requires a depth-three `session.json`
   under `<lab>/agent/ytdb-slate/projects`. The predicate re-validates the agent
   directory before reading it. Absence after a marked full-slate child is
   `SAFE CORPUS FAIL` and a non-zero exit. A focused rung with no full-slate
   child reports a positive not-applicable PASS.

   Across several marked children, the aggregate assertion proves that at least
   one current-run child published a scratch corpus session. It does not prove
   that every marked child did. A no-pi teeth fixture rejects a wrong filename,
   a too-shallow `session.json`, and a too-deep `session.json`. It then accepts an
   exact depth-three `session.json`. An always-success predicate, removal of the
   filename constraint, and removal or weakening of the depth constraint are
   therefore fatal during setup.

7. **The checkout is fingerprinted before and after.** The fatal read-only digest
   covers HEAD, index entries from `git ls-files --stage`, tracked files, relevant
   untracked files, content and metadata. It never calls `git write-tree`.
   Self-tests prove the digest changes no index bytes or metadata, loose objects,
   or worktree fingerprint. Concurrent pi sessions are permitted only when they cannot write
   this checkout. A same-checkout writer is prohibited. Same-user edit-and-restore
   remains the stated residual because a final userspace digest cannot observe it.

The reset removes prior selected-agent sessions and corpus state before children
start. Session JSONL and depth-three corpus metadata therefore belong to this
run. The fallback `$HOME/.pi/agent` fingerprint catches loss of the explicit
agent redirect.

An `EXIT`/`INT`/`TERM` trap restores permissions on any settings file the rungs
made read-only, releases its lab lock, and kills background helpers — for lab
paths containing spaces too, and skipping anything that is no longer a real
directory inside the lab. A failed lock release is reported and forces a
non-zero exit. Artifacts are deliberately **not** removed — they are the
evidence.

### What the guards do NOT cover

* The hermetic environment is not an operating-system filesystem sandbox. A
  dependency using a hardcoded absolute real-home path remains outside the
  portable guarantee. The launcher blocks accidental and ordinary PATH-based
  bypasses. It does not defend against a deliberately malicious same-user child.
  Such a child can read the shim or its token and forge writable evidence. It
  can also reconstruct and invoke an absolute binary. Those attacks require
  operating-system isolation.
* The real settings hash is diagnostic and nonfatal. Selected-agent, fallback-
  agent, session, corpus and repository evidence determine the safety verdict.
* Guard 2/3 canonicalise **at startup**. The *agent* directory is re-checked
  before every launch and every write (guard 4), but the other lab directories —
  `out/`, `weak/`, `work/` — are not: a symlink swapped underneath one of those
  mid-run would redirect artifact or fixture writes. They hold no user state.
  Lab ownership and mode checks exclude another local user from the intended
  threat model. A same-user swap remains possible, including in the narrow
  interval between the reset's final validation and recursive removal.
* A marked slate child whose `pi` binary ignores `PI_CODING_AGENT_DIR` leaves no
  current-run scratch corpus and triggers `SAFE CORPUS FAIL`. A focused run with
  no full-slate child reports a positive not-applicable PASS.
* Same-user repository edit-and-restore can evade the final fingerprint. A
  concurrent process capable of writing this checkout remains prohibited.

Nothing the harness intentionally writes lands inside the repository. The final
fingerprint makes an accidental or concurrent change fatal. Generated copies and
all launcher artifacts remain under the lab.

## Environmental noise — not failures

Three things appear in `<lab>/out/*.err` on a perfectly healthy run:

- **`Connection error.`** — on essentially every run. The fake providers point at
  a dead port on purpose; that failure is what triggers failover in the first
  place.
- **`Extension error (…/extension/index.ts): This extension ctx is stale after
  session replacement or reload. …`** — in print-mode failover runs only. This
  reproduces identically on the commit *before* the restore mechanism existed;
  it is a pre-existing print/RPC stale-context defect tracked separately
  upstream, not something this ladder can fix or should fail on.
- **`Warning: (… global settings) …`** lines from pi itself. When the fixture is
  a corrupt settings file, pi's own warning prints the file's raw bytes —
  escape sequences included. That is pi, not slate; `P8` asserts only that
  *slate's* own line is sanitised.

A long wall clock on the `R5*` rungs is also expected: an unreadable settings
file hides `retry.enabled: false`, so pi falls back to its own retry backoff.

Also expected, and not a harness problem:

- `mkdir: cannot create directory …: File exists` immediately before a
  `verification: cannot create …` abort — that is a guard doing its job.
- The default scratch directory is **kept**, not cleaned up, and so is a reused
  `--lab`. Old `work/`, `out/`, and `weak/` artifacts survive. The scratch corpus,
  pi session transcripts, and child marker are reset at the next run so they
  cannot become prior-run evidence; see § Requirements and hard constraints.

# Pure-resolver checks — `run-resolver-checks.sh`

A net much smaller than the ladder, for these subjects:

- the **worker-extension resolver** in `extension/worker-extensions.ts` and the
  doctrine rule it feeds in `extension/mode.ts`;
- the **action-routing doctrine rule** in `extension/mode.ts` (`doctrine-*`) —
  rendered live from the session's frozen router resolution: its feature-off
  byte-identity, its positional numbering beside the worker-extension rule, its
  injection safety (it bypasses `sanitizeForDoctrine` by design), its two content
  exclusions, and its size budget;
- the **model router** in `extension/model-router.ts` — its config sanitizer, its
  candidate resolution and warnings, and its dispatch-side effort predicate;
- the **dispatch guards** in `extension/route.ts` (`route-*`) — the route planner:
  the seven guards that decide whether one dispatched action may run at all, and
  on which (model, effort) pair;
- the **thread-choice planner** in `extension/thread-choice.ts` (`choice-*`) — the
  pure continue-or-fresh decision, its safety refusals, cache evidence, pricing,
  short-work guard and conservative uncertainty rules;
- **episode compression** in `extension/episodes.ts` (`episode-*`) — the compressor
  pin, its usability rule, the newest-Sonnet ordering, its diagnostics and the
  episode header's sanitisation. Loaded through a second loader instance with the
  pi packages aliased to local stubs (see below);
- the **model-spec vocabulary** in `extension/state.ts` (`spec-*`) — the canonical
  predicate, splitter, defect reasons and confusable annotation that the router
  shares with `failover.ts`, `episodes.ts` and `worker.ts`, plus the
  single-spec config-key sanitizer (`episodeModel`);
- the **snapshot record sanitizers** in `extension/state.ts` (`state-*`) — BG26:
  `sanitizeThreadRecord` / `sanitizeEpisodeRecord`, re-run over the user's whole
  thread and episode history at every session restore, plus the CQ22 adoption
  checklist they are audited against;
- the **orchestrator base-model tracker** in `extension/base-model.ts` (`base-*`)
  — the reducer that decides which model switches move the base model new worker
  threads inherit;
- **structural invariants of the shipped profile table** in
  `extension/model-profiles.ts` (`profiles-*`) — shape and internal consistency
  only, never a research number;
- the **writing checker** `extension/writing-check.mjs` (`writing-checker-*`) and
  the **writing status line** it feeds through `extension/writing.ts` and
  `extension/mode.ts` (`writing-status-*`), plus the **writing config sanitizer**
  (`writing-config-*`) and the **writing doctrine rule** (`writing-doctrine-*`).
  The `writing-reminder-*` family covers the reminder policy module, requirement
  roster, cadence, gates, real mode handlers, runtime-only state, and handoff
  ordering. The checker module has two nets of its own. See § The writing checker.
- the **worker preamble and reviewer charter** across `extension/worker.ts`,
  `extension/threads.ts` and the marked block in `docs/review-rules.md`
  (`worker-preamble`, `reviewer-charter-sync`). The checks cover historical
  feature-off bytes, writing and charter gates, and worker prompt plumbing. They
  also cover normalized byte identity between the shipped charter and its source
  block. Nothing else in these modules is in scope here (see the load-path note
  below).

The TypeScript modules loaded are `worker-extensions.ts`, `mode.ts`, `paths.ts`,
`model-router.ts`, `route.ts`, `state.ts`, `writing.ts`, `writing-reminder.ts`,
`worker.ts`, `threads.ts` (source inspection only), `base-model.ts`,
`model-profiles.ts` and — through the aliased loader — `episodes.ts`. The shipped command `extension/writing-check.mjs` is also imported
and spawned by its own checks. Every one of them is a re-run trigger — and
because `state.ts`'s spec helpers are also used by `failover.ts`, a change to
**them** additionally needs the ladder above. A change to the
`reviewer-charter:begin` / `reviewer-charter:end` block in
`docs/review-rules.md` also triggers this suite.

The ladder above covers slate's model-switch machinery — the model-default
restore and, in `WK1`, worker-session settings isolation — and says nothing about
any of the subjects below.

Unlike the ladder, these pipelines are **pure and deterministic** — one maps a
host tool registry and a list of regex patterns to a set of load units, the second
maps a configured model list plus a model registry plus a profile table to an
ordered candidate set, the third turns one dispatch's arguments plus that
resolution into a proceed/reject verdict, the fourth reduces a stream of
model-selection events to one base model — so the checks need no pi session and no
real state at all. They run the real modules (loaded through the jiti that ships
with pi, because node's strip-only TypeScript mode cannot load `state.ts`'s
constructor parameter property) against **fabricated in-memory registries,
fabricated profile tables**, fabricated events with an injected clock, a
fabricated compaction predicate, and temp-dir package fixtures, and assert the
observable result.

Router checks normally inject **their own** registry and profile table. Four
checks deliberately read `extension/model-profiles.ts`. `router-shipped-default`
proves that the shipped table is the resolver default. `router-tag-strip` tests
real trace-bearing profile prose. `router-field-cap` measures every real unknown
field against its cap. The `profiles-*` block tests the table itself. If the router or
the table cannot be loaded, `router-load` / `profiles-load` **FAIL** and every
check they void reports **NOT RUN** by name — the rest of the suite still runs.

## Running it

```sh
bash verification/run-resolver-checks.sh --repo .            # ~1 s; --repo defaults to "."
bash verification/run-resolver-checks.sh --repo . --strict   # CI: NOT RUN is fatal
```

One line per check, an `observed:` line under any failure, a `roster` check, then
a summary (the sample below deliberately shows a **failing** run, to show the
shape of a failure):

```
CHECK off-inert                        PASS    — empty pattern list → shared empty set, registry never walked
CHECK router-cheapest                  PASS    — the base model is the cheapest PREFERRED candidate — a non-preferred model is skipped …
CHECK profiles-ladder                  FAIL    — for every profile the ladder is a non-empty, duplicate-free subset of pi's effort vocabulary …
      observed: no violation → ["openai/gpt-5.6-luna: ladder level in neither list (minimal)"]
CHECK roster                           PASS    — all N expected checks reported exactly once and the counters agree …
== summary: N pass, 1 fail, 0 not run (N+1 result lines = N expected checks + this roster audit) ==
```

The run prints the numbers; this document deliberately does not. The expected
check count moves with every check added, and a transcribed copy of it here has
gone stale more than once. **The suite output is the definition of record** —
read the `roster` line and the summary identity, never a figure in this file.

The id column is 32 characters wide. Every CI harness uses that width, so a
verdict sits in the same place in each one. The width is the longest id in any
harness plus two characters. `padEnd` truncates no id: an id longer than the
column would move its own verdict to the right, and it would lose no text.

### Why the summary counts one more than the roster

The `roster` line counts **expected checks**; the summary counts **result lines**,
and the roster audit is itself a result line while deliberately *not* an expected
check — it cannot appear in its own expected list, because the audit is computed
before it reports, so listing it would make it permanently "missing". A clean run
therefore prints `EXPECTED + 1` result lines.

That is the whole of the old off-by-one, and it is now **stated in the output**
rather than left to be re-derived: the summary prints the identity
(`N result lines = N−1 expected checks + this roster audit`), and on a run where it
does not hold — a deleted check, a duplicate report, a crashed section adding an id
— it prints the residual as `±N unaccounted — see the roster line`. The roster
additionally asserts the identity it *can* own: `pass + fail + notrun` equals the
number of rostered ids, so the counters and the roster can never drift apart
silently (they are written by the same three functions but are separate state).

Three output rules exist because earlier versions of this suite could pass
vacuously (findings TS1–TS3 of the Track 01 review):

- **`roster`** asserts that every expected check id reported **exactly once**, that
  no unexpected id reported, that every module-dependent check is on a NOT RUN
  list, and that the counters match the roster. A section that crashes mid-way, a
  check that was deleted, a check that reports twice and a check whose id was
  mistyped all surface here instead of vanishing into a clean exit.
- **Every section is guarded.** A throwing oracle becomes a `<section>-crash`
  FAIL and the checks after it still run; the summary line is printed from a
  `finally`, so it appears even then.
- **A FAIL prints what it observed**, and a multi-term oracle names the term that
  failed — `observed: <label> → <value>` — so a failure localises itself instead
  of restating the claim.

Exit status: **0** every check passed · **1** a check failed, a check went
missing, or `--strict` was given and a check reported NOT RUN · **2** refused to
start. A missing tool, a bad `--repo`, no pi CLI, or a jiti that the script
cannot locate each give exit 2. `node` and `mktemp` must be on `PATH`. **The
script resolves pi itself, so `PATH` does not need pi.** `AGENTS.md` § CI
gives the shared order, and this script is the one that accepts a pi from `PATH`
as a last choice and prints a `NOTE` line for it. The script uses no network, and
it writes into one throwaway temp directory, which it removes on exit.

This script carries **no version-drift guard**, and the load check does. It
borrows only the bundled jiti from pi: it starts no session, and it asserts
nothing about the behaviour of pi. No module in the graph that it loads imports a
pi SDK package at run time, because each SDK import in that graph is an
`import type` and the transpiler erases it. `episodes.ts` does import
`@earendil-works/pi-ai`, and a second loader instance loads it with that package
aliased to a local stub. An old jiti can therefore only fail to transpile the
sources, and then the driver stops with a non-zero exit and no summary line,
which nobody reads as a pass. The load check has the opposite exposure, because
pi's rpc output shapes *are* its evidence and a new shape reads as "no events",
so the pinned-version guard belongs there and not here.

## What it covers

Worker-extension resolver:

| id | what it proves |
| --- | --- |
| `off-inert` / `off-doctrine` | an empty pattern list resolves to the shared empty set without walking the registry, and the doctrine is byte-identical to the feature-off baseline |
| `cand-builtin-sdk` / `cand-missing-path` | builtin- and sdk-sourced tools, and a tool whose entry path is absent, are never candidates |
| `unit-directory` / `unit-glob-fallback` / `unit-unrun-fallback` | a single literal manifest entry the host runs yields the package directory; a glob, or a declared entry the host is not running, fall back to entry-file paths |
| `bar-self-exclude` / `bar-collision` | a unit under slate's own root is dropped even under `.*`; a unit registering a slate dispatch name or a pi built-in is dropped whole and warned, survivors intact |
| `match-*` | patterns test unanchored against source spec, unit path and each tool entry path; a non-match yields nothing; an invalid regex is dropped with a warning while its valid siblings apply |
| `inject-safety` | a newline-bearing tool name, a 2000-char label and a backtick/markdown description all render into the doctrine without breaking its structure or exceeding the caps |
| `memoization` | the memoizing resolver walks the registry exactly once across repeated calls |

The **action-routing doctrine rule** (`extension/mode.ts`, `b092f92`) — driven
through `registerSlateMode`'s `before_agent_start` handler with a fabricated
resolution passed to its optional 6th parameter, the way `index.ts` supplies the
session's frozen one. This text is injected into every session's system prompt and
is paid for on every turn, which is what makes size and injection safety load-bearing
rather than tidy. The group is voided by `profiles-load`, because
`doctrine-no-trace` renders the **real** shipped table:

| id | what it proves |
| --- | --- |
| `doctrine-router-off` | **I2** — with the router off the rule contributes NOTHING. Every off-shaped resolution a session can hand the doctrine renders **byte-identically** to the default 5-argument call: explicitly off, off *while carrying candidates* (the shape that isolates the `on` flag — without it a guard weakened to `on === undefined` survives, because the empty-list guard catches it two lines later), on-with-no-candidates, on-with-only-unusable-candidates, a non-array candidate list, and no resolution at all. Asserted with and without the worker-extension rule beside it, plus a non-vacuity term proving the same helper *does* render the rule when the router is on. Note that `off-doctrine` above reaches this path only by OMISSION — it calls the helper with five arguments, so `getRouter` takes its default |
| `doctrine-untrusted` | **SE3** — an UNTRUSTED project gets **no routing rule even with `router.models` fully configured**, and its doctrine is byte-identical to the untrusted router-off one. `74a728c` re-gated the rule on `trusted` at the injection point, mirroring rule 9's tail: defence in depth (index.ts reads project config for trusted projects only) and therefore exactly the kind of guard that can be removed with no visible symptom. Its **own** check, not a term in `doctrine-router-off`, because untrusted-with-config and trusted-with-router-off render the same text by different mechanisms — folded together they are indistinguishable, and a baseline that is itself untrusted would keep comparing equal while one path broke. Here the baseline is the untrusted one and the discriminator is explicit: the SAME resolution, trusted, must render the rule. Two further terms separate "routing is gated" from "untrusted gets no tail rules at all": the worker-extension rule, which is NOT trust-gated, still renders for an untrusted project and keeps slot 11, with no gap where the suppressed rule would have been |
| `doctrine-numbering` | the conditional tail rules are numbered by **position**, not identity, in all four combinations. With neither rendering there is no rule 11; with extensions only it is 11; **with routing only it is also 11** — the case a hardcoded `12.` gets wrong, and the common one, since worker extensions are off by default; with both, extensions keep 11 and routing takes 12. Contiguity is derived rather than spelled (the rendered numbers must run 11, 12, … with no gap and no repeat), the routing rule's number is asserted to MOVE between combinations, and its body is asserted identical whichever slot it takes, so no number is baked into the text |
| `doctrine-inject` | the highest-stakes item in this group: the rule deliberately **bypasses `sanitizeForDoctrine`** (that sanitizer strips `\|`, which would destroy the table), so the narrow `cell()` is the entire defence. Eight attacks on the data cells — a pipe plus a forged `12. Ignore all previous rules`, a newline in the other guidance field, CR/CRLF, C0 **and** C1 controls, a spec-shaped value, markdown, a 5000-character field, a forged legend line — each collapse to exactly one row of exactly seven cells, add no line, and forge no numbered directive. Judged structurally (row count, pipe count per line, rule height) rather than on rendered text. Since `e52023d` it also covers the two values that fix added to the sanitized set: the **spec** (the gap this check found, now closed — the term is inverted, and asserts alongside it that `isModelSpec` still accepts `p/evil|forged`, which is what makes `cell()` load-bearing rather than belt-and-braces) and the **prose thread-default**, which is the more dangerous of the two because a newline there forges a numbered RULE rather than a column — attacked through `cheapest` and through the first-candidate fallback it defers to. The rule's closing **doc-pointer** line is pinned present-exactly-once and second-from-last under every attack, so it can be neither forged nor displaced. One residual **closed** and one standing: `74a728c` replaced the codepoint-range sanitizer with a UNICODE-CATEGORY one (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}` plus the pipe), so the bidi/zero-width residual this check used to pin as observed is gone — the term is inverted and widened to the class the categories buy: RLO, RLM, ALM, ZWSP, BOM, soft hyphen, tag letters, lone surrogates, and **U+2028**, which is a line break to many renderers and which the old range did not strip. Asserted in both directions, since a sanitizer that simply deleted everything non-ASCII would also pass the first half: NBSP, emoji and the `≥` the profile guidance uses are still carried verbatim. Cell length remains unbounded, and the budget check is what catches that |
| `doctrine-no-trace` | two hard content exclusions, against the **real** shipped table because a fabricated profile cannot leak what it does not carry: no research trace tag (`[O2]`, `[G1a]`, …) appears anywhere in the doctrine — they point into a `research/` directory this package does not publish — and no `nonPreferred` **reason** is rendered, whole or as a distinctive prefix, because those are written in the same trace-contaminated register. Non-vacuous by construction: the table must really contain tags (it carries 12 distinct ones) and a reason must really carry one (2 of 6 do), or the terms prove nothing. Plus the other half — the fact is *relocated*, not lost: every non-preferred model is marked `!` in its tier cell |
| `doctrine-budget` | a **guard**, not a timeless fact, measured on an install-invariant figure. The check removes each absolute docs-directory occurrence and keeps the filename. It separately pins every path count, rule size, line count, fixed fabricated six-model basis, all-nine basis, worker rule, model-row increment and tool-line increment. It reads no project config. The corpus-off draft-enabled maximum is **7,929 of 8,600** portable characters. The corpus-off draft-disabled maximum is **7,914 of 8,600**. The longest-name corpus-on equivalents are **8,067 of 8,600** and **8,052 of 8,600**. Corpus-off writing plus routing is **6,567 of 6,900**. Corpus-off all tails are **6,822 of 7,200**. The corpus-off capped worker rule is **1,347 of 1,600**. The **8,877-character, 109-line corpus-off** positive control exceeds the maximal bound by 277. These are verification budgets, not runtime limits. |
| `doctrine-budget-follow-up` | the trusted maximal fixture with `workflow.followUpIssues: true` measures **8,007 of 8,600** portable characters and 105 lines with corpus off. It keeps 593 characters of reserve. With the longest corpus name, it measures **8,145 of 8,600** and 107 lines. That corpus-on fixture is the largest maximal-family fixture and keeps 455 characters of reserve. |

The doctrine contract checks read the shipped workflow documents directly:

| id | what it proves |
| --- | --- |
| `contract-safety-floor-sync` | the two marked safety-floor blocks occur once, remain equal, and match the fixed seven-item content |
| `contract-focus-table-sync` | both marked focus tables occur once, remain equal, and match the complete fixed ten-row table |
| `contract-area9-artifact` | the unique marked area-9 definition and dual-purpose tie-break match canonical normalized text. A negated counterfactual must differ |
| `contract-fast-path-artifact` | the ten-item SMALL checklist, omitted gates, retained sequence, and fallback to ordinary SMALL remain present |
| `contract-test-composite` | the composite charter requires both behavioral effectiveness and structure and isolation sections |
| `contract-no-test-structure` | the retired standalone test-structure role does not return or merge into another reviewer |
| `contract-section-targets` | every named level-two target across the five workflow documents occurs exactly once. Regex metacharacters are escaped, and a duplicated Fast path counterfactual fails uniqueness |

The **writing checker command** (`extension/writing-check.mjs`) is covered both by
direct import and by spawned command tests. This is the checker's smallest net:
its rules, its caps, its offsets and its growth are covered by two suites of its
own — see § The writing checker:

| id | what it proves |
| --- | --- |
| `writing-checker-length` / `writing-checker-para` / `writing-checker-semicolon` / `writing-checker-contraction` | each fail rule has positive and negative cases; 21–25 words produce one warning, more than 25 words produce one fail, and no sentence produces both length levels |
| `writing-checker-class` / `writing-checker-not-checked` | house-style findings stay out of fail counts; the fixed not-checked list is non-empty and every item has a reason |
| `writing-checker-caps` | spawned command input caps reject an oversized regular file and a symlink to a special file with non-zero, explanatory errors |
| `writing-checker-modes` / `writing-checker-determinism` | JSONL, direct-file and unified-diff modes work; diff mode checks added lines in prose files; repeated input produces byte-identical output |

The **human-only writing status line** is covered through `registerSlateMode` with fabricated hooks and contexts:

| id | what it proves |
| --- | --- |
| `writing-status-fresh` / `writing-status-clean` / `writing-status-positive` | real hook cycles distinguish no completed turns (`0/0`), one clean turn (`0/1`), and one failing turn (`1/1`) |
| `writing-status-import-fail` / `writing-status-fail-open` | a rejected checker import and a checker throw both fail open through `turn_end` and render `writing unavailable` |
| `writing-status-gate-switch` / `writing-status-gate-trust` / `writing-status-gate-mode` / `writing-status-gate-ui` | each visibility condition independently suppresses the rate: switch off, untrusted project, orchestrator mode off and no UI |
| `writing-status-cap-skip` | the **checker's own** 1 MiB input cap (`MAX_INPUT_BYTES`) fails open: an oversized message is skipped rather than counted or thrown. It calls `measureWritingTurn` directly with `MAX_INPUT_BYTES + 1` bytes, so it says nothing about the 16 KiB turn bound — that is the row below |
| `writing-status-cap-visible` | the **turn** bound (`WRITING_TURN_MAX_BYTES`, 16 KiB in `mode.ts`): a larger assistant message goes through the real `turn_end` hook, is never handed to the checker, and the status line says `writing skipped (message too large)` |
| `writing-status-counting` | only fail findings count; warnings, house-style findings and advisories do not |
| `writing-status-no-store-write` | counter updates do not call `SlateStore.save()` or persist the orchestrator-mode seed |

`measureWritingTurn` lives in `extension/writing.ts`, beside the writing config
boundary. This keeps the pi-shaped message handling typechecked while the standalone
checker and CLI remain dependency-free plain JavaScript.

The **writing config sanitizer** (`extension/writing.ts`) and the **writing
doctrine rule** (`extension/mode.ts`), rendered through the same
`before_agent_start` handler the routing rule uses:

| id | what it proves |
| --- | --- |
| `writing-config-default` / `writing-config-invalid` | an absent config silently yields `{ check: false, remind: false, remindPercent: 10 }`; old check-only configs keep their behavior; malformed shapes warn and default; an unknown key warns and is not rebuilt; a non-boolean `check` warns and defaults; explicit `false` stays silent |
| `writing-config-reminder-valid` / `writing-config-reminder-inert` / `writing-config-reminder-percent` | reminder fields accept booleans and a finite percentage in `(0, 100]`; `check: false` makes reminders inert without changing a valid percentage; bad percentages warn once and fall back to 10 |
| `writing-config-hostile` | a prototype-polluting object, a throwing getter, an inherited `check` and a 30,000-deep value neither crash nor pollute: every result is a fresh object that defaults to off, and only the malformed shapes warn |
| `writing-doctrine-off` / `writing-doctrine-untrusted` | `writing.check: false` renders the doctrine byte-identically to an absent writing config, and an untrusted project renders byte-identically to `false` even with the rule configured. Both carry the discriminator: the same config, on and trusted, must render the rule |
| `writing-doctrine-numbering` | the writing rule is numbered by tail **position** over all combinations of the three conditional tail rules, and adding it renumbers nothing before it: alone it is 11, behind the routing rule or the worker-extension rule it is 12, and with all three it is 13 while those two keep their own numbers |
| `writing-doctrine-inject` | the rule is **static**: three configs carrying extra and nested keys beside the boolean render byte-identically to the plain on-rendering, so no config-derived text reaches the prompt |
| `writing-doctrine-cite` | the rule's **doc citation** (`docs/writing-guidance.md`, absolute and package-resolved like rules 8–10) renders **exactly once**, **only** while the rule renders — feature-off, absent-config, untrusted, router-on-writing-off and extensions-on-writing-off carry no occurrence of it — and inside the rule rather than anywhere else in the block. The path is read from `paths.ts`, never re-derived from the rendered text, so a rename that leaves the doctrine citing a document the package no longer ships fails here; the named file must also exist on disk, which is the half `package-content-check.mjs` cannot see (it checks the publish set, not the rendering). Two terms guard the shape: the rule still carries exactly **one** numbered line, so a citation line cannot become a forged tail rule, and `off + rule` is byte-identically `on`. Its per-turn **cost** is bounded by `doctrine-budget`, which since the citation landed also bounds the writing rule's own portable size, its line count and its **one** embedded path |

The **writing reminder policy and mode wiring** (`extension/writing-reminder.ts`,
`extension/mode.ts`, and the handoff ordering contract):

| id | what it proves |
| --- | --- |
| `writing-reminder-load` / `writing-reminder-roster` / `writing-reminder-render` | the pure module loads; the frozen six-line requirement roster keeps exact order and markers; doctrine renders all six bulleted lines while reminders render the exact five eligible lines |
| `writing-reminder-interval` / `writing-reminder-cadence` / `writing-reminder-budget` | the percentage derives cadence from the effective clamped budget with an 8,192-token floor; equality sends; lower usage repairs a stale mark; unusable usage does not send; force works without usage; override, scalar, Anthropic default, global default and clamp branches reach the real hook |
| `writing-reminder-gates` / `writing-reminder-mode-gates` | orchestrator mode, trust, writing check, reminder switch, pause state and the one-send round slot close independently; force does not bypass policy gates; no UI gate exists |
| `writing-reminder-state-machine` / `writing-reminder-mode-send` / `writing-reminder-rearm` / `writing-reminder-mode-force` | claim queues a pending mark without consuming force; the matching custom `message_start` commits it; unrelated custom messages cannot commit it; only assistant `message_end` re-arms the next round |
| `writing-reminder-send-retry` / `writing-reminder-cleared-retry` | a synchronous `sendMessage` throw releases the claim for retry; an assistant response that arrives before delivery also clears the pending claim without consuming cadence or force |
| `writing-reminder-runtime-only` / `writing-reminder-handoff-order` | reminder cadence state never enters snapshots; the explicit `/slate adopt <name>` command sets force before mode reset; reset preserves that force while clearing mark, round and pending state |

The family uses the real `registerSlateMode` handlers with fabricated contexts.
It remains a pure harness with no pi session. The live hook and persistence path
has its own integration check below.

The **worker preamble** (`extension/worker.ts`):

| id | what it proves |
| --- | --- |
| `worker-load` / `worker-preamble` | the module loads; feature-off keeps the exact historical bounded-action preamble; writing and reviewer guidance compose independently; only their explicit gates add them; and `ThreadManager` passes the sanitized writing switch and review-thread decision into the worker system prompt |
| `reviewer-charter-sync` | the non-empty marked generic charter block in `docs/review-rules.md` matches the shipped `REVIEWER_CHARTER` after whitespace normalization. The role-specific composite test charter remains in the document and is not injected into every review worker |

The worker check was mutation-verified three ways: weaken the literal-true gate to a
truthiness gate, replace `ThreadManager`'s config value with `false`, and change one
word of the guidance. Each mutation makes `worker-preamble` fail.

The mutations that give all of these checks teeth are recorded with the module
they defend, in § The writing checker.

**The doctrine checks are the ONLY automated coverage of doctrine rendering, and the
smoke test is not a backstop.** Stated plainly because the opposite is easy to
assume: `AGENTS.md` names the isolated-load smoke test (`pi --no-extensions -e .`)
as a verification step beside the automated nets, and a reader could reasonably take
it to corroborate these checks end to end. It does not, and could not have at any point during the routing
feature's development.

The reason, verified in the source rather than inferred. Orchestrator mode is seeded
automatically in exactly one place, `mode.ts:599`, and that seed is gated on
`ctx.mode === "tui"` (deliberately — `hasUI` is also true in RPC mode, and scripted
runs must not silently lose tactical tools). `store.orchestratorMode` otherwise
defaults to **false** (`state.ts:504`), and `before_agent_start` returns immediately
on `!store.orchestratorMode` (`mode.ts:551`). So in headless `pi -p "…"` the flag is
never set, the handler exits before `buildDoctrine`, and `getRouter()` is never
called. Measured through the loader: with the fresh default, `getRouter()` receives
**zero** calls and the system prompt comes back untouched; flipping only
`orchestratorMode` to true on the same print-mode context builds the doctrine and
consults the router once. The gate is the mode seed, not print mode as such — but the
consequence for the smoke test is the same.

| net | what it actually proves |
| --- | --- |
| the `doctrine-*` family | that the doctrine RENDERS correctly from a resolution: feature-off byte-identity, positional numbering, injection safety, the SE3 trust re-gate, the two content exclusions, and the install-invariant size budget — all by calling `registerSlateMode`'s own `before_agent_start` handler with `orchestratorMode` forced on |
| isolated-load smoke test | that the extension REGISTERS and that `session_start` runs (config load and validation). It never enters orchestrator mode, so it reaches neither the doctrine build nor the router consultation |
| **neither** | that the doctrine reaches a REAL session's system prompt — that pi calls the handler, with a live resolution, and that the model receives the text. Every check here forces the flag the real path is gated on |

**What does reach it: an interactive TUI session.** Recorded so a maintainer need not
rediscover the mechanics. There is no `script(1)` on this machine; a Python
`pty.fork()` harness works, driving pi's TUI with **`\r`** as the submit key (not
`\n`). The doctrine text is **not stored in the session JSONL** — it is assembled
into the system prompt at agent start and discarded — so verifying its CONTENT means
prompting the model to echo it back rather than grepping a transcript.

**Recommendation on a new automated rung: do NOT build one, and record the gap
instead.** The reasoning, since it cuts against the usual instinct here:

- a TUI-driving rung would be the only net proving the doctrine reaches a real
  session, and that is a genuine gap — so the case for it is real, not dismissed;
- but it would be the most fragile test in the repo: a pty, a TUI render loop, a
  submit keystroke, and a live model call, with verification going through *the
  model's willingness to echo its own system prompt*. Every one of those is a
  false-failure source, and a flaky net in this suite is worse than a known gap
  because it trains a maintainer to disbelieve red;
- the `WK1` precedent is the decisive argument. A live rung that ends up
  re-implementing the mechanism instead of driving it is vacuous while looking
  authoritative, and the honest failure mode of a TUI rung is exactly that: forcing
  `orchestratorMode`, or asserting against text the harness itself composed;
- and the marginal coverage is thin. What is unproven is the WIRING — pi calls
  `before_agent_start`, and the `tui` seed fires — both of which are pi's behaviour
  and one line of slate's, not the routing logic. The rendering, numbering, safety
  and size properties are already covered purely, and the one live confirmation
  below found them correct.

If the gap is ever closed, the smaller and more honest target is the SEED, not the
doctrine: assert that a fresh `tui`-mode session sets `orchestratorMode`, with no
model call and no prompt inspection. That is one branch, cheaply reachable, and it is
the actual thing this suite cannot see.

**One live end-to-end confirmation, recorded as evidence.** An interactive TUI
session with six configured models rendered the rule correctly: one row per model
carrying price, context window, tier markers (`t2!`, `t4!`, `t?!`), measured levels
and both guidance columns, `anthropic/claude-fable-5`'s ZDR REFUSE present in its
avoid cell, and the thread base resolving to the cheapest candidate,
`openai/gpt-5.6-luna`. This is the first confirmation the rendering is right in a
real session rather than against a fixture, and it agrees with these checks.

> **Registry-dependent warning count.** The pinned pi package's shipped OpenAI
> provider data records a 272,000-token context window for `gpt-5.6-luna`,
> `gpt-5.6-terra` and `gpt-5.6-sol`. With that STOCK registry, the six-model project
> configuration emits **11 model data notes**: one class explanation, six
> unknown-data warnings, three context-window divergence warnings and one aggregate
> billing-pattern warning. With `router.showWarnings: false`, all 11 notes are hidden
> and one discoverability line is visible. With `true`, all 11 notes are visible
> and the discoverability line is absent. This machine's `~/.pi/agent/models.json`
> overrides those three windows to 1,050,000 tokens. Its live registry therefore
> emits **7 model data notes**, because the three divergences and aggregate do not
> fire. A local registry override can therefore change the applicable count.
> Dispatch-time warnings are conditional and can repeat after this resolution-time
> batch. The model-visible price-divergence warning is not deduplicated. Its exact-rate
> `model-data-note` companion uses condition-key deduplication and the same display gate.

**Recorded sizes use one portable basis.** The doctrine embeds ABSOLUTE doc
paths. Raw size therefore changes with the install directory. `portable` removes
each occurrence of the docs directory and keeps the filename. This is the figure
that `doctrine-budget` enforces. To recover a raw count, add `paths × docs directory
length`.

The full multi-basis table lives in `docs/context-budget.md`. The resolver check
owns these stable verification fixtures. Standard corpus-on rows use
`calm-otter-7f3a`. Maximal corpus-on rows use the longest minted name,
`daring-dolphin-ffff`.

| fixture | corpus | paths | portable | lines | bound |
| --- | --- | ---: | ---: | ---: | ---: |
| routing rule, 9 profiles | independent | 1 | **2,585** | 25 | 4,000 |
| writing rule | off | 1 | **1,070** | 23 | 1,150 |
| capped worker rule, 2 units / 4 tools | off | 0 | **1,347** | 11 | 1,600 |
| router-off doctrine | off | 4 | **2,912** | 48 | — |
| router-off doctrine, standard corpus name | on | 4 | **3,046** | 50 | — |
| router-on doctrine | off | 5 | **5,497** | 72 | 6,500 |
| writing-only doctrine | off | 5 | **3,982** | 70 | 5,600 |
| writing plus router | off | 6 | **6,567** | 94 | 6,900 |
| writing plus extensions | off | 5 | **4,237** | 76 | 6,000 |
| writing plus router and extensions | off | 6 | **6,822** | 100 | 7,200 |
| maximal doctrine with draft PRs enabled | off | 7 | **7,929** | 104 | 8,600 |
| maximal doctrine with draft PRs disabled | off | 6 | **7,914** | 104 | 8,600 |
| maximal doctrine with follow-up issues enabled | off | 7 | **8,007** | 105 | 8,600 |
| maximal doctrine with draft PRs enabled, longest corpus name | on | 7 | **8,067** | 106 | 8,600 |
| maximal doctrine with draft PRs disabled, longest corpus name | on | 6 | **8,052** | 106 | 8,600 |
| maximal doctrine with follow-up issues enabled, longest corpus name | on | 7 | **8,145** | 107 | 8,600 |
| positive control, one extra capped tool plus four maximum-growth model rows | off | 7 | **8,877** | 109 | must exceed 8,600 |

Each exact pinned literal catches every size change in its rendered fixture. The
maximal pins cover draft pull requests enabled, draft pull requests disabled,
and follow-up issues enabled.
The upper bounds are coarse growth ceilings, not single-edit detectors. Every
upper bound must exceed the current measurement by at least five percent.
Required character raises round up to the next hundred, while line bounds use
the next whole line.

A doctrine change updates its exact literal. A bound changes only when this
reserve policy requires it. Corpus-off writing plus routing uses
`6,567 × 1.05 = 6,895.35`. Ceiling gives 6,896. Next-hundred rounding gives
6,900.

Corpus-off all tails use `6,822 × 1.05 = 7,163.1`. Ceiling gives 7,164.
Next-hundred rounding gives 7,200.

The largest maximal fixture is the longest-name corpus-on follow-up render.
It uses `8,145 × 1.05 = 8,552.25`. Ceiling gives 8,553. Next-hundred rounding
gives 8,600. Its reserve is 455 characters.

The largest corpus-off model-row growth is 184 characters. The capped
corpus-off tool-line growth is 212 characters. The corpus-off positive control
measures 8,877 characters and 109 lines. It exceeds the maximal bound by 277.

These bounds protect representative fixtures from silent prompt growth. The
synthetic worker fixture uses capped ASCII fields and no installed extension
prose. The bounds are not runtime limits. A larger extension roster can exceed
every representative figure. `docs/context-budget.md` records the same stable fixture and a distinct
real project basis. Matching fixture rows must agree exactly, while different
bases must be named.

The exact equalities are maintenance tripwires. A deliberate wording,
requirement-roster, renderer-cap or fixture change requires remeasurement through
the production `before_agent_start` doctrine path. Update resolver expectations
and every published figure in the same commit. Preserve the positive-control
construction unless the fixture design itself changes.

**One definition of `portable`, and it is this one.** Keeping filenames is
deliberate because maintainers control them. A document rename must move the
budget. Removing whole paths would make that growth free. The resolver check is
the definition of record because its bounds fail the run.

Model router (`extension/model-router.ts`):

| id | what it proves |
| --- | --- |
| `router-load` / `profiles-load` | the modules load at all; a failure here converts the checks below into explicit NOT RUN lines |
| `router-off` | an empty *or* absent model list yields the shared `ROUTER_OFF` result with zero warnings and without consulting the registry — the resolver's default empty-candidate fast path |
| `router-unprofiled` | a model with no profile is warned about **by name** (no benchmark data ⇒ dropped) and kept out of the candidates |
| `router-malformed` | a spec that is not canonical `provider/id` is dropped with a warning that names the **reason** — including "control characters" and "leading or trailing whitespace", which the display sanitizer would otherwise strip, leaving a warning that reads like a valid name (BG2) |
| `router-unroutable` | a model pi's registry does not know, and one with no configured credentials, are each warned about and dropped — routing there could only produce billed failures |
| `router-alias-duplicate` | two specs resolving to the same profile (canonical id + alias) yield **one** candidate, the later one warned about and dropped |
| `router-all-dropped` | when every entry is dropped the router is OFF with **exactly one** summary warning on top of the per-entry ones |
| `router-order` / `router-order-ties` | ordering is tier ascending then effective input price ascending; a tier+price tie is broken by spec; a candidate with no usable price row sorts **last**, is warned about, and stays routable; a non-numeric tier sorts last instead of poisoning the comparator with `NaN` |
| `router-cheapest` | the default base model (D48) is the cheapest **preferred** candidate: a profile carrying a `nonPreferred` reason is skipped even when it is the cheapest thing on the list, while remaining a routable candidate (BG1). The **ordering** honours the same markers (DF4): non-preferred candidates, and candidates whose tier is not a sourced ordinal, sort after their comparable siblings, so a consumer walking the list cannot meet an evidentially-thin model first |
| `router-cheapest-fallback` | when *every* candidate is non-preferred a base model is still chosen (D48 requires one), the result flags it, and exactly one warning names that base and explains it with the profile's own reason |
| `router-price-date` / `router-price-rows` | the effective row is the one in force on the resolution date; overlapping rows resolve to the greatest `from`; an expired or future-only schedule falls back to the most recent past row, else the first; non-ISO dates — including a **timestamp** where a date belongs, which string comparison would accept as a valid past bound and let win the pick — are treated as absent bounds instead of being compared lexicographically |
| `router-w1-canary` | a profile/registry context-window divergence is **reported, not diagnosed** (W1/D55), as a per-model golden-master line plus an optional aggregate billing-pattern note. The line pins both figures, both sources, the profile date, the registry value used by routing, and the exact non-adjudication sentence. The verdict-word scan removes that sanctioned sentence first, so its word `correct` cannot false-fail the check. A registry figure equal to the model's own threshold adds the exact pointer and aggregate. The pair fires together at arbitrary profile-provided figures. The aggregate appears once, names only every matching model in candidate order, and sits between per-model lines and failover coverage |
| `router-w1-guards` | an absent window on either side is **not** a divergence, and neither is a registry value equal to the profile's recorded `contextWindowKnownDivergence` figure — while a third, unrecorded value still warns |
| `router-w3-unknown` | a candidate with `unknownRoutingCriticalFields` produces exactly one per-model warning, naming the model and every field; the class explainer is a separate warning |
| `router-class-partition` | every real resolution-time `once` condition is classified. The exact model-data-note key roster is `invalid-price`, `price`, `w1`, `w1-billing-pattern`, `ladder`, `w3`, `w3-explainer`. Every other resolution key is a configuration fault. A future hidden key therefore fails the roster (AD21) |
| `router-class-default` | a real warning whose `once` call omits the class argument reaches the sink as `configuration-fault`; this executes the helper rather than inferring its default from source |
| `router-tag-strip` | no bracket span survives in warnings built from real shipped unknown fields or real `nonPreferred` reasons. Both source sets must contain tagged text, and both warning paths must render, so the exclusions cannot pass vacuously |
| `router-tag-keep` | a nested-array user value is rejected as a configuration fault while its bracketed display survives, preserving the identity of the bad entry (AD18) |
| `router-empty-fields` | a tag-only profile field is dropped after rendering. A three-field raw array becomes two named entries, and the warning reports two facts with no empty separator slot |
| `router-subject-repair` | both directions of citation handling are pinned in one three-field warning. A tag acting as the grammatical subject after punctuation becomes `the source`. Inline and start-of-field tags follow plain stripping and invent no subject. Every field renders and no tag survives |
| `router-nonpreferred-visible` | an all-non-preferred fixture emits a configuration fault, names the selected base, and strips the profile reason's bracket span |
| `router-field-cap` | every real shipped unknown field **and non-preferred reason** fits the 180-character pre-strip input cap. The two reasons exactly at the boundary are a canary. A hostile 200-character field truncates, and its one-field warning uses singular grammar |
| `router-profile-input-bound` | a structural assertion, not a timing gate: `profileText` slices raw text to `max` before either bracket scanner, and the replacement chain starts from that bounded value. An unclosed bracket run therefore cannot scale tag scanning with hostile input length |
| `router-message-cap` | a profile with many hostile fields still produces an assembled warning of at most 800 display characters, and the fixture proves whole-message truncation occurred |
| `router-separator` | unknown fields are joined with U+00B7 MIDDLE DOT, and the assembled warning contains no C0 or C1 control byte, including newline |
| `router-separator-forgery` | an embedded middle dot is neutralized. Two fields produce one structural separator, two apparent entries, and a count of two |
| `router-notify-controls` | the shared notification sanitizer strips every C1 byte and every supported Unicode bidirectional control on both sanitizer and profile-warning paths. It pins `false\u202Etrue` → `falsetrue` and `\u009D0;PWNED\u009C` → `0;PWNED` |
| `router-profile-date` | a tagged `profile.asOf` value passes through profile rendering. The divergence warning keeps the cleaned date and leaks no bracket span |
| `router-w3-explainer` | one singular and one plural unknown-data warning produce exactly one model-data-note explainer. A candidate with no unknown data produces none. The separate fixtures reject both incorrect noun forms |
| `router-failover-coverage` | uncovered candidates produce **one aggregate** warning naming them all (not one per model); a covered, window-aligned candidate warns about nothing at all; a map entry whose target is not a spec does not count as coverage |
| `router-warnings-echo` | on the router-**ON** path the returned `warnings` are exactly what the warn sink received, in order |
| `router-labels` | a valid spec inside a warning is extracted and pinned to the exact 120-character display fragment plus ellipsis, independent of changing explanatory or remedy prose around it. The full warning has no incidental 300-character budget. The same check annotates confusable non-ASCII code points and bounds a value that cannot be stringified or coerced |
| `router-dedup` | a condition warns at most once per resolution even when its trigger repeats — exercised through the **live** duplicate path (three identical malformed specs), since a repeated *valid* spec is skipped earlier and cannot reach the dedup at all; two values sharing a JSON form but not a type (`NaN` / `null`) stay separate conditions |
| `router-memo` | the memoizing resolver resolves once across repeated consultation, returns the same frozen object, and each warning reaches the sink once (D58) |
| `router-ladder-validation` | the ladder handed back by the profile table is filtered to pi's own effort vocabulary and de-duplicated: a foreign level reads as `off-ladder` even when the table claims a measurement at it, and a non-array ladder (what a prototype-key lookup returns) yields an empty ladder **plus** a warning rather than silent nonsense |
| `router-effort` / `router-effort-gap` / `router-effort-hard` / `router-effort-off` | the predicate returns `ok`, `not-listed`, `off-ladder` and `evidence-gap` and carries the ladder, `measured`, `listedGap` and `apiRejected`; a ladder level that is neither measured nor a listed gap reports `evidence-gap`, never a false `ok` (BG9); a level in `apiRejectedLevels` reports `off-ladder` even when it is measured and on the ladder; with the router off the predicate is inert, and an omitted effort is never a ladder complaint |
| `router-hostile` | every warning — resolver and sanitizer alike — is stripped of control/ANSI bytes and length-capped, even when fed a 5000-char profile field and an escape-bearing spec |
| `router-robust` | hostile inputs degrade instead of crashing: a throwing warn sink still leaves the memo intact, a throwing registry/profile source and a throwing `getInput` turn the router OFF with one plain-language explanation, a cyclic or 30 000-deep config value is dropped with a warning, `allowUnmeasuredEffort: false` survives, `null` config falls back to the defaults, and a non-array model list is treated as empty |
| `router-config-default` / `router-config-invalid` | an absent `router` config silently yields `{ models: [], allowUnmeasuredEffort: true, showWarnings: false }`; a wrong-shape value warns once and falls back to those defaults; invalid `models` entries are dropped one warning each; non-boolean option values warn and retain their defaults; **unknown keys are reported**, so a typo'd `"model"` cannot masquerade as an empty list (CQ1) |
| `router-shipped-default` | with `profiles` omitted the resolver really does use the shipped table — tier, ladder and price all arrive from it — and an unprofiled spec is still excluded |

The pure suite does **not** execute the class-aware sink wrapper in
`extension/index.ts`. It therefore does not prove default suppression, the hidden
warning count, or the one-time discoverability line. The extension-load check
covers wrapper registration and session startup. A live interactive session
covers the wrapper's rendered behavior. The resolver checks prove only that the
resolver emits every warning and supplies the class that the wrapper consumes.

Thread choice — the pure planner (`extension/thread-choice.ts`). A dead refusal
or reversed comparison still produces a normal dispatch and episode, so every
input is fabricated and every verdict is asserted by kind and code:

| id | what it proves |
| --- | --- |
| `choice-load` | the module loads. A failure converts every other `choice-*` check into an explicit NOT RUN line |
| `choice-order` | unusable input and safety refusals settle before source selection, warmth, short-work handling, or arithmetic |
| `choice-refusals` | absent and empty permission, a missing episode, unrecorded or empty tools, and a failed last dispatch each return their exact refusal code |
| `choice-new-stream` | no source thread returns `fresh/no-thread-to-continue` without allowance, cache, size, or price inputs |
| `choice-warmth` | model changes, zero read-plus-write, retention boundaries, expiry, missing retention, and unknown age classify conservatively |
| `choice-effort-cold` | an effort change is cold against an otherwise identical same-effort warm control |
| `choice-short-work` | one and two turns continue before pricing, while three turns reach arithmetic |
| `choice-abstentions` | every missing economic input returns its exact abstention code instead of a fabricated choice |
| `choice-token-buckets` | cache-read, fresh, and output tokens remain disjoint, with zero or absent write premiums falling back to input price |
| `choice-long-context` | multipliers start at the exact threshold and apply independently to both arms |
| `choice-rediscovery` | the fresh arm keeps its extra turn, including at the maximum-turn clamp |
| `choice-final-verdict` | wide cost gaps choose in both directions, while an exact tie continues. The fresh fixture is the positive control |
| `choice-verdict-shape` | every verdict explains itself, and priced choices carry estimates and warmth evidence |
| `choice-hostile` | malformed values never throw, verdict kinds stay closed, and oversized turn estimates clamp |

Mutation checks give the family teeth. Moving the short-work guard above
permission breaks `choice-order`. Removing effort comparison breaks
`choice-effort-cold`. Double-charging fresh input breaks
`choice-token-buckets`. Reversing the final comparison breaks
`choice-final-verdict` despite its wide positive-control gap.

Every other row has a discriminating mutation. Break the export for
`choice-load`. Change one refusal code for `choice-refusals`. Require rates on a
new work stream for `choice-new-stream`. Expire at equality for `choice-warmth`.
Move the short-work boundary for `choice-short-work`. Default a missing price or
size to zero for `choice-abstentions`. Start long-context billing above rather
than at the threshold for `choice-long-context`. Clamp both arms before adding
rediscovery for `choice-rediscovery`. Blank a reason for `choice-verdict-shape`.
Remove the turn clamp for `choice-hostile`.

The family executes only `thread-choice.ts`. It fabricates time, route, cache,
retention, prices, sizes, episodes, tools, and turn estimates. It does not execute
`ThreadManager`, a worker session, reporting, lineage, restart refusal, rollback,
or successor creation. Those caller and acting-path behaviors belong in unit or
integration tests.

Dispatch guards — the route planner (`extension/route.ts`). The **safety core** of
action-level routing, and the one place where a regression is completely silent: a
guard that stops guarding still "works", the dispatch runs and an episode is
written. Every input is fabricated, **including pi's compaction predicate**, and
the resolutions are built by the real router so candidates carry exactly what a
session's frozen resolution carries:

| id | what it proves |
| --- | --- |
| `route-load` | the module loads; a failure converts every `route-*` check into an explicit NOT RUN line |
| `route-vocabulary` | an `effort` outside pi's vocabulary is **rejected** (never clamped, never ignored), the reason names the value and the ascending level list, `THINKING_LEVELS` *is* that ascending vocabulary, a padded valid level is trimmed, and this guard runs **before** the list guard. A whitespace-only or omitted effort names no level, so one is **derived for the model the planner routes to** (its lowest measured level) and `effortJudgedFor` names that model — it no longer resolves to nothing |
| `route-effort-type` | a **non-string** `effort` is rejected rather than read as absent — reading it as absent would silently run the action at the thread's **base** level, a substitution that looks like success. Seven shapes (number, object, array, boolean, function, cyclic, escape-bearing), each rejected with the type and value named, pi's levels offered, display-safe text and no throw; `undefined`/`null` stay absent and the base effort then applies |
| `route-list-on` | with the router ON a model outside the candidate list is rejected, naming every candidate **in resolution order** and a remediation clause naming a **listed** base to fall back to — for a listed base, for a base that was just seeded or re-seeded (the clause can no longer be empty, nor name the model it just refused), and for a thread that does not exist yet; the rejection still carries the repair's own warning; a listed model routes that action, at a level derived for it |
| `route-list-off` | with the router OFF the **candidate-list and window guards** are inert: an unlisted model and a ladder-less valid-vocabulary effort pass through unwarned, the `model` argument is preserved **byte-for-byte** for pi to resolve, the thread's **pre-router pin** is the planner's only model-field fall-through and is `openOnly`, and a **stored `baseModel` resolves nothing**. The check stops at planner output; it does not claim which model a held live session runs |
| `route-resolution` | a malformed, half-built (`on: true` with no candidates) or absent resolution collapses to the shared `ROUTER_OFF` constant, so candidate-dependent planner guards become inert instead of walking a shape they cannot read |
| `route-resolved-pair` | an **omitted** model and an **omitted** effort still go through the guards, because they fall through to the thread's base values: an off-list base is **re-seeded** to a listed candidate (signalled for persistence, naming what it replaced, base effort re-derived, one warning) rather than rejected, an off-ladder base effort is rejected, a valid base pair proceeds and is echoed back, a pre-router `model` pin still reads as the base, a new thread is seeded with the cheapest candidate at its lowest **measured** level, and an omitted model falls back to the host model for the effort check. A suite that only ever passed explicit arguments would miss the most common real dispatch |
| `route-base-reseed` | the base **repair** (route.ts's THE ONE RULE): with the router ON an off-list or **absent** base — including a pre-router `model` pin — is seeded to the cheapest preferred candidate with its effort re-derived, signalled for persistence (`baseReseeded` / `baseReseededFrom`) and warned about once, never refused. A listed base or pin is untouched and silent; the router-OFF path is unaffected; an explicit route does not become the base nor the base the route; and a resolution that is ON but carries nothing usable to seed from **drops** the base rather than enforcing a list it could not read. Both repaired shapes are ordinary states — a thread predating `router.models`, or a list that changed — and the baseless one is the dangerous half: it used to run outside the closed list silently, so the cost bound the list expresses simply did not apply |
| `route-base-reseed-guarded` | the repair opens **no hole**: over six thread shapes (new, baseless, off-list base, off-list pin, listed base, off-list base whose stored effort the new base lacks) every plan that proceeds on an omitted `model` runs on a **listed** candidate, while an **explicit** off-list model is still rejected in every one of them, each rejection offering a listed base. A "do not reject what we just repaired" shortcut in guard 1 would satisfy `route-base-reseed` entirely and still let an explicit off-list model through |
| `route-read-failure-inert` | on the router-**ON** path, an **unreadable** ladder (a candidate whose ladder filtered to nothing, or one carrying no profile at all) makes guard 2 stand **down** — the level goes to pi, which clamps it — and is not reported as an evidence gap either, since that would be a claim about data nobody could read; a malformed candidate never throws; a provider's `apiRejectedLevels` entry **still refuses** (a positive, readable fact bites even with no ladder), saying the ladder was not recorded rather than inventing one; and a **known** ladder still refuses an off-ladder level, so none of this is the guard being dead |
| `route-ladder-per-model` | the ladder guard answers **per model**, never as a union: two ladders differing in *both* directions, so a union implementation fails whichever way it is built, and the reason names the offending model's own ladder |
| `route-evidence-gap` | an unmeasured but ladder-valid level is dispatched **with** a warning and the proceed verdict carries the unmeasured marker; an unlisted table hole says so; `router.allowUnmeasuredEffort: false` refuses it instead; a measured level is silent and unmarked |
| `route-api-rejected` | a level in `apiRejectedLevels` is refused **outright**, named as a guaranteed provider failure rather than an evidence gap, and not rescued by `allowUnmeasuredEffort` — while a normal level on the same model still proceeds |
| `route-window-substitute` | a model that cannot hold the thread's context is replaced by the **widest** candidate (not the next, not the cheapest); the verdict still PROCEEDS and records `substitutedFrom`; the warning names both models and the widest window; and a level invalid on the *substituted* model is **dropped with a warning** rather than rejecting the action |
| `route-window-skip` | the guard is skipped when the context size is unknowable, when pi supplies no compaction predicate, and when that predicate throws — and it never rejects: with no listed model able to hold the context the widest is used anyway ("pi will compact"), and with nothing wider the resolved model is kept with a warning |
| `route-window-reserve` | capacity is judged by **pi's own** compaction predicate on the candidate's **registry** window — a context that fits the bare window but *not* the window minus pi's reserve is substituted; the predicate is asked with exactly `(tokens, window)`; a predicate that says it fits is obeyed; and `reserveTokens` only shapes the warning text |
| `route-price-divergence-*` | dispatch reads fresh registry prices and the dispatch date. Material divergence returns one hardened model-visible warning without exact rates. An exact-rate companion goes through the router sink as a `model-data-note`. Identical evidence is condition-key deduplicated there, while the model-visible warning is re-evaluated and can repeat. The checks cover exact wording, tolerance, absent or invalid rates, output-only divergence, and dated schedule boundaries |
| `route-long-context` | the long-context **billing** notice fires once per thread and model, at or above the profile's threshold, naming the threshold and the multipliers; the caller's memory suppresses the second one (and only for that model); a non-array memory degrades instead of throwing; a profile with no multiplier figures says so; and after a substitution the notice belongs to the model the planner routes to |
| `route-failover` | a failover switch bypasses the list and effort guards entirely, never sets an effort level, keeps a **non-substituting** window check that warns and proceeds, refuses the model that just failed, and refuses an unresolved target — while a router-OFF failover emits **no window warning at all**, which is the only pre-router equivalence this row asserts (it says nothing about router-OFF per-action model switches, which still move a held session) |
| `route-lowest-effort` | the base-effort seed is the **lowest measured, non-provider-rejected** level on that model's ladder — never an evidence gap — ascending from pi's vocabulary rather than the table's authoring order, and `undefined` (pi's own default) when there is no measured level, the model is unlisted, the router is off, or the resolution is junk |
| `route-off-ladder-source` | with the router **OFF** the ladder used for effort validation comes from the caller's **injected** profile source and nothing else: it is consulted by spec, it is authoritative (a level off a **known** ladder is refused even for a spec the shipped table has never heard of — the discriminating direction), a spec it **declines** is not judged at all, an absent source, a throwing lookup and an **unreadable ladder** (throwing or non-array) are all **inert** — the level is kept, with no unmeasured marker and no warning — a foreign level is filtered out of the quoted ladder, and the module reaches the shipped table at runtime by no route at all. That last property is asserted **behaviourally first**: a REAL shipped spec (read from the table at runtime, never hard-coded) paired with a level really off ITS shipped ladder, so the injected source and the table disagree and only a planner consulting the table can be caught — with no source injected, and with a source that DECLINES the spec, which is the shape `threads.ts`'s vetted source produces for a model pi cannot serve. Two text terms back it up: no `import type`-less reference to `model-profiles.ts`, and no shipped-table VALUE (`SHIPPED_PROFILE_SOURCE`, `MODEL_PROFILES`, `findProfile`, `ladderFor`, `PROFILES_AS_OF`) imported under any name from any module — the re-export route, which needs no new import statement, only a new name on an existing one. A fifth behavioural fixture covers the **router-ON** path (TQ9), where `checkEffortFor` answers from the CANDIDATE's ladder and every router-OFF fixture above is blind: the same real shipped spec, with a candidate ladder that deliberately CONTAINS a level the shipped table says it lacks, so the candidate and the table disagree in the opposite direction. It is the only term in the suite that stands between that path and a **rename**-re-export — a new name defeats the value scanner, and consuming it only for specs the table knows leaves every fabricated `p/*` fixture green |
| `route-effort-derived-for-model` | THE ONE RULE's effort half: a level stored on the thread is inherited **only** while the planner routes the action to the base model it was derived for. An explicit per-action model gets **that model's** own lowest measured level instead — asserted with two **disjoint** ladders, so an inheriting implementation cannot pass: it would refuse a level absent from the new model's ladder where this asserts a proceed, including under `allowUnmeasuredEffort: false` (BG14). A window substitution re-derives for the substituted model; an **explicit** level is still judged hard against the routed model; `effortJudgedFor` always names the model used for that judgement |
| `route-off-invisible` | pins the **router-OFF planner state**: no base model or effort is seeded or persisted, no re-seed signal or derived level appears, the pin is `openOnly`, no candidate-dependent guard speaks even with a 5M-token context, a malformed model argument passes through for pi to reject, and the removed tracker input changes nothing. The **ladder** guard remains active and refuses an off-ladder explicit level. The check does not assert the live model after switch decisions |
| `route-stored-effort-refresh` | a thread's stored `baseEffort` is a **cached derivation** over a table that ships with slate, so a refresh can invalidate it. It is re-checked against today's table and, when it no longer reads `ok`, **re-derived** for that model rather than replayed — for all four ways a refresh can invalidate it (evidence gap, gap under `allowUnmeasuredEffort: false`, a shrunken ladder, a provider's hard rejection), three of which used to make the thread **undispatchable** through a dispatch that named no effort at all. The correction is **silent** (nobody asked for that level) and is **not persisted** (the verdict still echoes the stored value, no re-seed is signalled — pinned as observed). A still-measured level is kept rather than re-derived, a model with no measured level yields none, and an **explicit** level keeps the full guard treatment: warned on a gap, refused under `allowUnmeasuredEffort: false`, off-ladder or API-rejected |
| `route-stored-effort-vocabulary` | a stored `baseEffort` outside pi's vocabulary — wrong case, a non-vocabulary string, a number, an object, an empty string, `null`, an array — is **discarded**, never replayed onto a dispatch: the record is an unversioned snapshot, so its declared type is a claim about the writer, and pi would clamp a junk level silently while the episode reported a level nothing ran at. The boundary is the **vocabulary itself, not the profile table**: with an unreadable ladder (nothing to re-derive from) a junk value is still gone from the verdict's own base-effort echo while a vocabulary-valid one survives it — the discriminator that a table-trusting boundary fails |
| `route-switch-decision` | the model-switch decision, whole: a **plan** target moves a live session and outranks even a held failover; an **`openOnly`** target never does — it only chose what a NEW session opened on (BG16) — and falls through to the revert rule; an action naming no model **reverts** to the session's opening model (BG22) unless a failover holds it; `no-baseline` outranks the failover stand-down; a model spec is carried **byte-for-byte** — a padded one is not normalised into a silent success and a whitespace-only one is not read as an absence that silently reverts (RG1, repinned; CQ13's one rule, shared with `planRoute` and asserted on the same value through both modules) — and every switch is labelled `plan` or `revert`, the split that tells the caller whether failing to perform it may fail the action (BG24) |
| `route-open-plan-inputs` | the plan that decides what a NEW session opens on strips **both** of the action's arguments. With `effort` left in, that plan can REJECT — an explicit level the thread's pin does not offer — and a rejection carries no model, so the session opens on the HOST and the pin is silently dropped while the real plan a moment later never complains (BG25). Asserted on both router states — and on the caller's half too, which is a CALL now rather than a regex: `planSessionOpen` IS the stripping, so "both arguments dropped, and the open model taken from that plan" is exercised, not matched. (Until TQ4 those were two text terms over `threads.ts`; the regex enumerated two keys in two orders and would have false-failed on a third.) |
| `route-switch-opening-baseline` | the revert target is what a **model-less plan** resolves to, never what a routed open happened to use. Composed from both plans plus the decision helper: with the correct baseline the next model-less action reverts off the per-action model; with the defective one it reports `already-current` and the explicit model becomes the thread's permanent default — BG22 surviving its own first fix, on the opening path. Router-ON is shown to be immune (the base arrives as a plan target), which is why only a router-OFF fixture could ever have caught it. The caller's half — the open planned with `model` dropped, and the baseline read from the session that plan opened — was two text terms over `threads.ts` and is now EXECUTED through `planSessionOpen` and `captureSessionBaseline` (TQ4); the regexes were deleted rather than kept beside them, because a brittle term next to a real one contributes nothing but false alarms. One further fixture is **router-ON** (TQ8): under WINDOW SUBSTITUTION the thread's base and the model this action resolves to diverge — the base stays the thread's own while the open must report the widest candidate — and that is the only shape in which `planSessionOpen` returning a base-flavoured value looks identical everywhere else |
| `route-baseline-capture` | **TQ7** — the caller's **dataflow into** the switch decisions, which was the last hole in this track: the decisions were pinned and correct, and both flagship defects re-inserted fully green one line OUTSIDE them, because the baseline came from somewhere else, later. Pins the producer: `captureSessionBaseline` reads the SESSION object and nothing else — the caller-assembled `{ model, effort }` record the old signature took, and every argument-shaped decoy beside it (`baseModel`, `requestedModel`, `spec`, `level`), reads as **no baseline at all**. Each axis is captured independently and validated on the way in (the spec byte-for-byte per RG1, the level against pi's vocabulary per BG21); an unreadable axis is an **absent key**, which is what makes a session reporting nothing identical to `NO_SESSION_BASELINE` and to omitting the argument. Both decisions read their own axis off ONE captured object — the collapse of the two per-axis maps — and a baseline carrying only the other axis is an absence on this one. An absent baseline is `no-baseline` on both axes **even with a live value sitting right there**: that is the BG18 fallback shape, executable, and it is what a `?? current` in either decision dies on. **Two** structural terms sit alongside, for the two facts no pure function can hold: the residual no type can close (`applyRoute` takes its baseline as a parameter, uses it, captures none itself, and the caller never asserts a value into the brand), and the other end of the lifecycle — every per-thread map the session OPEN touches must be RELEASED on disposal, so a baseline cannot outlive its session and be handed to a switch decision for a reused thread id. The second is derived from what `openWorkerFor` writes rather than from a list of map names, so a new session-scoped map is covered the day it is added (see below) |
| `route-switch-lifecycle-i1` | **I1** — the model and effort axes obey the same per-action lifecycle: a value the action names applies to that action, an action naming none falls back to what the session OPENED with, a failover holds the model axis in place. **Both** halves execute through their extracted helpers over one thread's life, off ONE captured baseline object, including the BG18 shape (revert to the baseline, never to the live level) and BG21's vocabulary rule on the effort axis. The two structural per-axis terms this row used to list are deleted, not re-anchored (TQ10): TQ7 collapsed the two baseline maps into a single `liveBaselines` written in one place and moved the capture into a private `openWorkerFor`, so there is no per-axis ordering left to assert. That asymmetry is why BG22 needed two rounds — the effort axis had had its baseline since BG18, the model axis had none, and no net noticed — and what now prevents it is a type, not a regex: the baseline is a branded object only `captureSessionBaseline` can produce and `applyRoute` takes it as a parameter |
| `route-hostile` | a hostile `model` or `effort` argument is stripped of control/ANSI bytes and length-capped before it reaches a rejection reason — that text goes to the orchestrator *and* to pi-tui, which renders escapes verbatim — while the rejection itself still happens |

#### Documented coverage boundary of the `route-*` checks

What they deliberately do **not** cover, because it is not in the pure module —
listed so a reader never has to infer it:

- **What `threads.ts` does with a verdict**: applying the switch to a worker
  session, turning an early rejection into a tool error and an apply-time one into
  an episode-less abort, and recording guard 6's once-per-pair memory. The ladder's
  `WK1` rung covers the settings-isolation half of applying a switch; the rest
  needs a live session.
- **pi's real compaction settings** behind `wouldCompact` / `reserveTokens`. The
  checks inject a fabricated predicate, which is the point — but it means the
  *reading* of pi's settings is unverified here.
- **The registry-and-auth vetting behind the router-off ladder source.** This is
  the one property that was previously covered by a throwaway check
  (`off-unservable-allows`) and is now split in two. The planner's half — that the
  injected source is the sole authority and a declined spec is not judged — IS
  covered, by `route-off-ladder-source` above. The *composition* is not: that
  `threads.ts` builds that source by asking pi's registry whether the model exists
  and has configured auth (`routerOffProfiles` / `registryCanServe`) lives in a
  module this harness cannot load, so **it remains a known uncovered property**. A
  regression there — handing the planner the shipped table unvetted — would make
  the planner refuse effort levels for models the session cannot even run, and only
  a live session would show it.
- **Persisting the base repair.** `route-base-reseed` proves the planner *signals*
  a re-seed (`baseReseeded` / `baseReseededFrom` / the re-derived `baseEffort`);
  that `threads.ts` then writes those onto the thread record and saves the store —
  which is what makes the repair and its warning happen **once per thread instead
  of once per dispatch** — is caller behaviour and needs a live store. A regression
  there is not silent in the same way (the warning would simply repeat), but it is
  not caught here.
- **The two-call protocol.** `threads.ts` calls `planRoute` twice per dispatch —
  early, before any state mutation, and again at apply time once the context size
  is knowable — and the early caller must discard the warnings so nothing
  double-reports and guard 6's once-per-pair notice is not consumed twice. The
  checks exercise one call at a time; the protocol itself is the caller's.
- **How a verdict SURFACES to a user.** That a rejection becomes a tool error the
  orchestrator can correct, and that a re-seed warning reaches the tool result and
  the progress lines rather than only a log, is end-to-end behaviour. The module
  owner exercises it with a live-session demo; nothing here can.
- **The failover WIRING.** `route-failover` proves the carve-out's rules; that the
  in-dispatch failover block is the thing that passes `failoverSwitch: true` (and
  `failoverFrom`) is in `threads.ts`.
- **BG22's revert-on-omit decision — CLOSED, by extraction.** This was recorded here
  as a known gap: the decision lived entirely in `threads.ts` and the planner emitted
  no revert instruction, so nothing pure could reach it. The dispatch side then took
  the first of the closure paths below and extracted it into `decideModelSwitch` in
  `route.ts`, and `route-switch-decision`, `route-switch-opening-baseline` and
  `route-switch-lifecycle-i1` now pin it. Three of the four caller-side facts this
  bullet used to list as "asserted structurally" have since stopped being text at all:
  planning the open with `model` dropped and reading the baseline from the session
  that plan opened are EXECUTED through `planSessionOpen` and `captureSessionBaseline`
  (TQ4), and "captures both axes' baselines before any per-action switch" was
  DISSOLVED rather than moved (TQ7/TQ10) — there is one `liveBaselines` map written in
  one place, the baseline is a branded object `applyRoute` takes as a parameter, and
  what remains of the claim is carried by `route-baseline-capture`'s two structural
  terms — the late-capture residual, and the disposal release that keeps a baseline
  from outliving its session.
  ONE caller-side fact is still genuinely uncovered: that a failed `revert` is
  non-fatal while a failed `plan` switch aborts (BG24 — the harness pins the
  decision's `source` label, not the caller's reaction to it).
  The episode is worth keeping: the gap was closed by making the decision pure, not by
  building a live-session rung, and the extraction cost less than the rung would have.

- **The compaction-settings elision (CQ17) is verified indirectly, on purpose.** The
  caller now reads pi's compaction settings only when the router is ON, so with it
  OFF `wouldCompact`/`reserveTokens` arrive `undefined`. No check asserts "the
  off-path verdict does not depend on them", because that cannot be falsified: with
  the router off the window guard is structurally unreachable — it needs a candidate,
  and an off resolution has none — so such a term would be a tautology. What the
  elision actually risks is reaching the **ON** path, where a missing predicate makes
  the guard **inert** (`route-window-skip` pins exactly that, and
  `route-window-reserve` pins that a supplied predicate is asked with `(tokens,
  window)` and obeyed). The conditionality itself — `resolution.on ? read : undefined`
  — is in `threads.ts` and is not reachable from here; the ON-path checks passing
  unchanged is the whole of the evidence this harness can offer.

One earlier entry has been **removed from this list because it was fixed**: an
unreadable ladder used to make the planner refuse the level, contradicting the
module's own "a failure to read evidence is not evidence of a problem" rule. The
harness pinned that behaviour explicitly as *not endorsed*; the module now goes
inert, and `route-off-ladder-source` and `route-read-failure-inert` assert the new
behaviour on the router-OFF and router-ON paths respectively.

Episode compression (`extension/episodes.ts`) — the module the suite could not
load until now. It imports `@earendil-works/pi-ai`, a peer dependency this repo
does not install, so a **second loader instance** is created with `alias` pointing
each pi package at a local stub written into the throwaway work dir. The module and
everything it imports from this repo are the real thing; only the SDK boundary is
faked:

| id | what it proves |
| --- | --- |
| `episode-load` | the module loads through the aliased loader and exports `compressEpisode`; a failure converts every `episode-*` check into an explicit NOT RUN line |
| `episode-pin` | the model an **action** ran on is never selected as the compressor — at any rung, under any failure (no configured model, an unknown configured model, no available Sonnet, a throwing registry): each ends in the uncompressed fallback carrying the worker's own last output rather than reaching for the action's model, and no LLM call is made at all. The orchestrator's tracked base **is** selected even when it coincides with the action's model, because a rung is chosen on its own merits — coincidence is not derivation |
| `episode-auth` | usability is pi's own verdict, not "has an API key": a provider authenticating by **header** and one authenticating from the **environment** (the bedrock/vertex shape — `ok` with neither key nor headers) are both accepted, an unconfigured provider is still rejected at every rung, the failover retry applies the same rule, and the auth the rung was accepted for is exactly what reaches the call (headers present, no `apiKey` option at all) |
| `episode-version` | the newest-Sonnet rung compares version components **numerically**: a two-digit minor beats a one-digit one (`4-10` over `4-9`), a higher major beats both, a dated snapshot orders stably against its alias, and a non-Sonnet is not a candidate |
| `episode-report` | a well-formed but unusable `episodeModel` is **reported**, not silently skipped — separately for one the registry does not know and one whose provider is unconfigured — each naming the model, the reason and the fallback, display-safe and bounded, **once per process** rather than once per episode; a usable configured model is silent and is the one that runs |
| `episode-header` | nothing interpolated into the header can forge a line or field; every field is bounded; stored observations render path, bytes, truncation and grammar; not-stored variants render their reason without a path or transient warning; `ran:` is omitted without output; and effort/model claims remain bound to validated values |

#### Real versus stubbed, stated plainly

A stub-backed check can degenerate into proving the stubs consistent with
themselves, so the split is explicit.

**Proven against real code**: `episodes.ts` itself — rung order and the pin, the
`auth.ok` usability rule and its single point of definition, the numeric id
comparison, the `reportOnce` diagnostics, `headerField`'s collapse/delimiter/bound
rules and the whole header assembly — plus everything it imports from this repo:
`failover.ts`'s `resolveMappedModel`, `base-model.ts`'s `modelSpecOf`,
`notify.ts`'s `sanitizeForNotify`, `state.ts`'s `splitModelSpec`.

**Assumed by a stub**, each justified in a comment at the stub:

- `complete()` records the call and returns a fixed assistant message. What is
  proven is *which* model was selected and *what auth* the call received; the
  provider's own behaviour, and the attempt classification built on it (AF7/AF11),
  are a different mechanism these checks make no claim about.
- `isContextOverflow` / `isRetryableAssistantError` return `false`, the shipped
  answer for a non-error message. Only retry classification reads them, and no
  check asserts a retry decision beyond "the mapped model was consulted under the
  same auth rule".
- `CONFIG_DIR_NAME` is pi's own value `".pi"`; `convertToLlm` and
  `serializeConversation` are identity/JSON and only feed transcript text that no
  check inspects. `getAgentDir`/`SettingsManager` exist merely because
  `failover.ts` and `model-default.ts` import them at load time.
- The **auth verdicts** the fabricated registry returns are *not* invented: the
  three shapes are what pi's own `ModelRegistry.getApiKeyAndHeaders` produces —
  `{ok:true, apiKey, headers, env}`, `{ok:true, headers}` with no key for a
  provider without an `authHeader`, and `{ok:false, error}` when unconfigured
  (`dist/core/model-registry.js`). BG42 turned on exactly that distinction, so it is
  asserted against the SDK's real shapes rather than a convenient one.

What this family therefore does **not** cover: that a real provider accepts the
request slate builds, and the attempt/retry classification of a real failure. Those
need a live provider, and the ladder's fake-provider rungs are the nearest thing
the repo has.

Config-sanitizer wiring (`extension/index.ts`) — a **text** check:

| id | what it proves |
| --- | --- |
| `wiring` | every config sanitizer is imported by `index.ts` and called at `session_start` with its own key and a live diagnostic sink. The router receives the class-aware `routerWarn` wrapper. Every other sanitizer receives the shared `warn` sink. A missing call or throwaway sink is precisely the silent failure RG20 was. `index.ts` cannot be loaded here, so this check asserts against source text. It proves wiring, not wrapper behavior |

Model-spec vocabulary and snapshot sanitizers (`extension/state.ts`):

| id | what it proves |
| --- | --- |
| `state-load` | the module loads; a failure converts the `spec-*` **and `state-*`** checks into explicit NOT RUN lines (both prefixes are paired with `STATE_IDS` in `VOIDABLE` — with only `spec-` there the roster's coverage audit walked past the two sanitizer checks entirely, since it filters `EXPECTED` by prefix and never notices a list member that matches none) |
| `spec-invisible` | every zero-width or direction-changing character is **rejected** by the shared predicate — controls, bidi, soft hyphen, BOM, **variation selectors** (BMP *and* astral), **tag characters** and **Hangul fillers**, the three classes the first BG2 fix missed — each named by code point in the reason; a non-breaking space reports as whitespace; a *visible* non-ASCII spec (homoglyph, emoji) is accepted and merely annotated; a valid spec still splits on the first slash |
| `spec-config-key` | an unusable `episodeModel` is dropped **with** a warning naming the key, the reason and the fallback (RG20), while absent and valid values stay silent and the returned value is unchanged from the old silent behaviour; an unstringifiable value warns instead of throwing |
| `state-thread-record` | **BG26** — `sanitizeThreadRecord` re-validates the whole restored thread record. A well-formed record round-trips byte-identically; absent fields receive documented defaults silently; wrong types are refused by name and type; unsafe ids are dropped; live status normalizes to idle; counters and mixed episode-id arrays are repaired; thread type is preserved only as a string for later legacy resolution; model, pin and effort strings remain byte-identical for their owning validators; and the CQ22 adoption checklist proves every owned field returns without reporting a deliberate refusal twice |
| `state-episode-record` | the episode half of BG26, same restore path and same obligations. A well-formed record round-trips byte-identically, and so does an **all-fields** one (`wellFormed` omits the optional unmeasured marker, so the checklist walk needs its own fixture); a record with no id, no thread or no file is dropped, silently. `failed` is the only value that survives as a failure — `"FAILED"` reads as `ok` and is noted. The unmeasured marker needs the boolean: a truthy string is refused, and so is `false`, which is not a legal value of a `true`-only field. Model and effort are type-checked only, exactly as above. Since CQ22 this sanitizer has the thread sanitizer's **refuse-by-name** discipline — it used to take a repairs sink and never write to it, so an episode's dropped fields vanished while a thread's were reported — and every refusable axis is checked, while an accepted value, a bare record and a well-formed one report nothing at all |

Orchestrator base-model tracker (`extension/base-model.ts`) — driven with
fabricated `model_select` events and fabricated declarations. There is **no clock
to fake**: a declaration lives until the SETTER SETTLES — `expectOwnSwitch` returns
a settle callback and `ownSwitch` invokes it in a `finally` — so the checks drive
the protocol (declare / observe / settle) rather than advancing time:

| id | what it proves |
| --- | --- |
| `base-load` | the module loads; a failure converts the `base-*` checks into explicit NOT RUN lines |
| `base-seed` | the session seed records model **and** effort; an omitted effort reads as unknown; an **absent** model is legitimate and silent (a session with no model, or none it has auth for); an unusable one is reported once, leaves no base at all, and its report is stripped of control bytes and bounded |
| `base-own-switch` | a **declared** slate-initiated switch moves neither the base nor its effort and says nothing — **for as long as the setter takes** (driven through `ownSwitch` with the event emitted deep inside a slow performer) and for **every** event landing on its target while in flight, so an interleaved user switch on that target can no longer consume the declaration and make slate's fallback the base (the CN1 defect). It is retired **at settle**, after which a switch to the same model is an ordinary user switch again; `ownSwitch` returns exactly what the setter returned; an unexpected `previousModel` still counts as slate's own with one report; a target slate never declared moves the base; an unusable declared target is reported once and still hands back a safe, idempotent settle callback |
| `base-user-switch` | an **undeclared** `set` switch moves base and effort; an unreadable effort reads as unknown rather than the previous level; an event with no usable `provider/id` decides nothing and consumes no declaration; an unrecognised source — including one that is not a string — is reported once, treated as a user switch, and still matched against declarations |
| `base-cycle` | a `cycle`-sourced switch **always** moves the base, even when it lands exactly on a declared target, and consumes no declaration — proved by the declared switch still being recognised when its own event arrives later |
| `base-restore` | a `restore`-sourced event moves neither the base nor its effort, is reported once per session naming the target, and consumes no declaration |
| `base-adopt` | a handoff adoption moves the base **only on success**: a declared switch whose setter threw leaves it alone, while `adopt()` re-seeds base and effort deliberately; an unusable adopted model is reported once and changes nothing; `adopt` clears its **own** target's outstanding declaration (handoff's equality guard can skip the setter) but not another target's — a failover in flight is still recognised |
| `base-stale-declaration` | a declaration that **settled without ever being matched** (a setter that threw before pi emitted, handoff's equality guard skipping the setter, pi suppressing an already-equal pair) absorbs exactly **one** further event — and is **reported**, since pi emitting after the setter returned means its semantics moved — then suppresses nothing: the next switch to that model moves the base, an unrelated user switch moves it immediately *and* ends the grace, and a `restore` event or an unreadable payload spends no grace at all. The module's stated residual is pinned too: a declaration whose settle callback is never invoked keeps absorbing, which `ownSwitch` makes unreachable at the shipped sites |
| `base-two-in-flight` | two slate switches in flight are both recognised — chained (`A⇒B` then `B⇒C`) and out of order, in **any settle order** — with no report; beyond `MAX_PENDING` **live** declarations the oldest is dropped with exactly one warning, so its switch moves the base while the retained ones still do not; and the eviction is **settle-aware**: a settled entry waiting out its one-event grace is dropped first and silently, so a queue full of finished switches cannot cost a live declaration |
| `base-throwing-switch` | a slate switch whose setter **throws** (pi's `setModel` does, despite its `Promise<boolean>` contract) leaves the base correct and no armed state behind: `ownSwitch` re-throws the error **unchanged** and retires the declaration in its `finally`, the throw itself is silent, only the documented one-event grace on that target remains, an unrelated user switch moves the base immediately, three throwing switches in a row accumulate nothing, and the bare `expectOwnSwitch` + `finally` path behaves identically |

Shipped profile table (`extension/model-profiles.ts`) — **structural only**:

| id | what it proves |
| --- | --- |
| `profiles-ids` | every id is a canonical, lower-case, unique `provider/id` spec, and every profile carries the fields the router reads |
| `profiles-aliases` | `findProfile` resolves every id (case-insensitively) and every alias to its own profile; no alias is shared between profiles, shadows a canonical id, or is empty/padded; an unknown spec resolves to `undefined` |
| `profiles-ladder` | each ladder is a non-empty, duplicate-free subset of pi's effort vocabulary, and `capabilityMeasuredAt` / `evidenceGapAt` are disjoint and exactly cover it. This is the canary for a **mistyped ladder key**: a wrong key silently falls back to the widest ladder, which then contains levels the profile's own lists never mention |
| `profiles-price` | every schedule is a non-empty, ascending, non-overlapping sequence of rows with `null`-or-ISO bounds, positive prices and output ≥ input; `tier` is an integer 1–4; `nonPreferred` is `null` or a non-empty reason; and tiers do not **price-invert** (no tier is dearer at its cheapest than the next tier up) |
| `profiles-meta` | `PROFILES_AS_OF` is an ISO date, every profile carries it, the table is deep-frozen, and the free-text fields are of the declared shape |

What the `profiles-*` checks deliberately do **not** do: assert any research
number. A price, a context window or a benchmark value may legitimately change on
the next refresh, so only relative and structural facts are asserted. One
consequence is worth stating plainly — **scaling every price by the same factor
would pass**; the price-inversion invariant only catches a value that moves
relative to its neighbours. Numeric fidelity to the research is a review
concern, not something a structural check can own.

### Teeth

These checks were validated by **mutation testing**: copy the repo to a scratch
directory outside it, apply one textual change to `extension/model-router.ts`,
`extension/route.ts`, `extension/state.ts`, `extension/base-model.ts` or
`extension/model-profiles.ts`, and re-run the suite against the copy
(`--repo <copy>`). Each behaviour listed
above has at least one mutation that it catches — including the two that used to
pass vacuously (the
dedup mechanism and the shipped-table default), the ordering tie-breaks, the
price-row selection rules, the W1 absence guards, the `nonPreferred` rule, and
the roster machinery itself (renaming or deleting a check fails `roster`). Never
mutate the repository itself; the scratch copy is the point.

`route-baseline-capture` was mutation-proved when written (TQ7): sixteen mutations,
fourteen killed, and the two survivors are the interesting half. Killed on the pure
side — accepting a caller-assembled model or effort at capture; trimming the
captured spec; dropping the level's vocabulary check; emitting `undefined`-valued
keys instead of absent ones; a non-empty `NO_SESSION_BASELINE`; `?? current` as the
baseline fallback on **either** axis (the BG18 shape, on the model axis too); one
axis leaking the other off the shared object. Killed on the structural side — a
late `captureSessionBaseline` inside `applyRoute`; the parameter removed in favour
of a lookup; the parameter kept but ignored.

The two survivors, reported rather than papered over:

- **`?? opts.model` on the open path.** Expressed inside the pure module
  (`planSessionOpen` regaining `input.requestedModel`) it dies — but on
  `route-switch-opening-baseline`'s TQ4 term, not this one. Expressed where it
  actually shipped, at the call site in `threads.ts`, it is unreachable to this
  harness at all: that module cannot be loaded here, and what blocks the edit now
  is the `OpenModel` brand plus `openWorkerFor`'s scope, neither of which exists at
  run time. **No harness pin can catch that shape**; it is held by the type system
  and by the fact that `opts` is not in scope where the open happens.
- **A live reading laundered through the brand.** `baseline = { effort:
  this.sessionEffort(session) } as SessionBaseline` inside `applyRoute` is BG18
  reintroduced with **no capture call to see**, and it survived every term in the
  suite. That is why the residual term carries a fourth conjunct: the caller must
  never assert a value INTO the brand (`route.ts`'s producer is the one place that
  may, and it is a different module). With it the mutation dies.

The residual term is anchored on **shape**, and both directions were proved, because
this suite has twice been bitten by spelling-pinned terms — once badly enough that
an implementer abandoned a valid fix over a line that was not broken. Renaming the
baseline parameter, moving it to a different position, reflowing the whole signature
onto one line, and adding a doc comment that names both `captureSessionBaseline(
session)` and `as SessionBaseline` inside the method: all **PASS**. Inserting a real
late capture, or a real brand cast: **FAIL**. The parameter list and body are read
by paren/brace balance and the parameter is found by its TYPE rather than its name,
so none of the reformatting is visible to the term.

The two BG26 sanitizer checks were validated the same way (TQ12) when they were
reviewed — they had been committed unreviewed, recovered from a dispatch that died
mid-flight, so nothing was taken on faith. Ten mutations of `extension/state.ts`,
all killed, none surviving: dropping a valid field from the built record (thread
`updatedAt`; episode `task`); refusing SILENTLY instead of by name, on each
sanitizer separately (the episode one is the pre-CQ22 asymmetry restored);
weakening the model/pin check from type-only to content validation (trim + spec
shape, each sanitizer); suppressing the CQ22 adoption notice, which kills BOTH
sections since they share the function; destroying a VALID name — the
false-positive repair, the worst outcome in this track; noting a field that was
ACCEPTED, i.e. a repair notice that fires spuriously; and throwing away the valid
strings in `episodeIds`. Two gaps surfaced while writing them, both fixed: the
round-trip term could only speak for the fields its fixture carried (hence the
checklist walk over the exported `ADOPTED_*_FIELDS`), and only the wrong-TYPE case
was covered per field — absent was not, so a bare record now has to fill every
default in silence.

The `74a728c` follow-up was mutation-proved the same way, seven mutations, all
killed. The trust re-gate (SE3) had no coverage at all when it landed — the fix
turned the five `doctrine-*` checks red, and the tempting repair was to flip the
fixture to trusted and move on, which would have left a security-relevant guard
unpinned. Instead the flip is itself asserted (trusted and untrusted render
byte-identically for the configurations these checks use — true for the empty
config, the worker-extension set and `draftPRs`, and NOT true in general, since
`reviewPerspectivesPath` is a trusted-only rule-9 tail), and the gate got its own
check. Killed: the gate REMOVED (`doctrine-untrusted` alone); the gate INVERTED (all
six); the gate suppressing the rule but still CONSUMING its number, leaving a gap
(`doctrine-router-off` and `off-doctrine`); a BLANKET gate that also suppressed the
worker-extension rule for untrusted projects (four checks — the term that separates
"routing is gated" from "untrusted gets nothing"). And on the category sanitizer:
reverted to the old codepoint range, over-stripped to ASCII-only, and `\p{Zl}\p{Zp}`
dropped so U+2028 alone reopens — each fails `doctrine-inject`, the last one proving
the widened term is not just re-asserting what the old range already caught.

Both corrections that followed `e52023d` were mutation-proved in turn, seven
mutations, all killed. On `mode.ts`: `cell()` removed from the SPEC (the original
gap restored); `cell()` removed from the PROSE thread-default (a newline forging a
numbered rule); the doc-pointer line removed; a SECOND doc-pointer line added; the
pointer DISPLACED out of its closing position; the rule's prose doubled. On
`model-profiles.ts`: a profile growing a 2,000-character `routeFor`. The prose
doubling was run at BOTH a 13-character and a 128-character docs directory and fails
at both — the budget still bites regardless of install path — while a 128-character
install path on its own leaves the whole group green, which is the other direction.

The row-detection pattern needed care rather than adoption. Routing the spec through
`cell()` renders `p/a|b` as `p/a b`, and the old `/^ {3}\S+\/\S*\|/` stopped
matching — silently counting ZERO rows, which turns a row check into no check.
The relaxation suggested with the fix, `/^ {3}\S[^|]*\|/`, was **not** adopted: it
matches the table's own header line (`   this session (spec|$in/$out per Mtok|…`),
which carries six pipes like a row and would have inflated every row count by one.
Anchoring on the TIER cell instead (`t<digits>` or `t?`, optionally `!`) admits a
sanitized or hostile spec of any shape while excluding header, legend and prose, and
fails loudly if the column order changes rather than quietly matching nothing.

The **doctrine routing group** was mutation-proved when written, twelve mutations,
all killed — and one of them found a hole in the checks rather than in the code,
which is recorded because the naive version looked complete. Killed on `mode.ts`:
the router-off guard weakened to `on === undefined`; the empty-candidate guard
removed; the rule hardcoding `12.` instead of taking its position; `numberedTail`
consuming a number for a rule that did not render (leaving a gap); `cell()` no
longer stripping the newline; `cell()` no longer stripping the pipe; `cell()` made a
pass-through; the `nonPreferred` reason appended to a row; the `!` marker dropped so
the fact is lost rather than relocated; a trace tag added to the rule's prose; the
prose doubled. Killed on `model-profiles.ts`: one profile growing a 2000-character
`routeFor`, which the budget check catches as the silent prompt bloat it is.

**The instructive one is the first.** Weakening the router-off guard to
`on === undefined` initially **SURVIVED**, because every off-shaped fixture had an
empty candidate list and so tripped the *second* guard two lines later. The check
looked like it covered I2 and did not cover the flag at all. It now includes an
"off, but carrying candidates" shape — a resolution the resolver never builds — for
no other reason than to isolate which guard is load-bearing. A fixture set that only
contains shapes production emits cannot tell two guards apart.

**That finding is CLOSED, by `e52023d`, and closing it found a second one.** The
harness reported that the model spec was the only value interpolated raw, exempted
because it had passed `isModelSpec` — which rejects whitespace, control and bidi
characters but not `|`, the character the table's grammar is made of, so
`isModelSpec("p/evil|forged")` is `true` and such a spec rendered an eighth cell.
The fix took the rule rather than the case: every interpolated STRING now goes
through `cell()` and nothing is exempted for having been validated upstream. Re-
checking the rest under that rule turned up a value the harness had NOT found —
`resolution.cheapest`, rendered into the rule's PROSE, where a newline forges a
numbered directive rather than a column, which is strictly worse. Both are now
sanitized and both are pinned, along with the thread-default fallback that defers to
the first candidate's spec.

Worth recording as a lesson about the check rather than the code: `doctrine-inject`
attacked every DATA cell exhaustively and never attacked the PROSE, because the
table was where the structure obviously lived. The rule's grammar is not only its
table — a numbered line is structure too, and it was the unexamined half.


`router-w1-canary` was re-validated again after **`bad8dc4`** (BG27 split the message
in two; the golden master caught the change, which is what it is for). Eight mutants,
all behaving: restoring the old per-model repetition of the explanation **FAILS**;
making the aggregate unconditional **FAILS**; dropping the model names from the
aggregate **FAILS**; restoring the old "the registry wins; the profile is stale"
verdict **FAILS** (on the golden master *and* on the verdict scan, which reports
`["wins","wins",null]`); reverting WC5's `profile asOf` to `research asOf` **FAILS**;
colliding the aggregate's dedup key with `failover-coverage`'s **FAILS**; emitting the
aggregate after the failover-coverage warning instead of before it **FAILS**; and a
pure code reformat that emits byte-identical text (hoisted consts, reshaped template,
extra comments) **PASSES** — the pin is on the output, not on the code's spelling.

It was re-validated once before, after `98c63f3`, three mutants, all
killed — and the point of the exercise is what the DECORATIVE version of the row
did against them: restoring the old "the registry wins; the profile is stale"
diagnosis leaves both numbers, the `asOf` date and the phrase "context window"
intact, so every term it used to carry still passed. Now it fails seven terms,
the verdict scan among them. Making the hint unconditional (`&&` → `||`) fails
two; the subtler variant that keeps the `!== undefined` guard and drops only the
equality test — so the hint is well-formed and merely fires on the wrong models —
fails exactly one, the absence term, which is why that term is worded to cover
both a differing threshold and an unrecorded one.

The `base-*` checks were validated the same way, one mutation per check, all nine
killed: unguarding the seed predicate (`base-seed`); matching a declaration
without consuming it, since superseded by the settle protocol (`base-own-switch`); defaulting a non-string `source` to
`"set"` (`base-user-switch`); letting a `cycle` event consume a declaration
(`base-cycle`); letting a `restore` event move the base (`base-restore`); dropping
`adopt`'s declaration cleanup (`base-adopt`); making the declaration TTL
effectively infinite (`base-stale-declaration`); raising `MAX_PENDING` out of
reach (`base-two-in-flight`); and matching a declaration against **any** target,
which is the "armed flag swallows later user switches" defect the module was
written to avoid (`base-throwing-switch`). Three of those mutations also killed
other `base-*` checks, which is expected: the requirement is that every check is
killed by at least one mutation, not that a mutation kills only one check.

When the tracker moved from a clock to the settle protocol, the four checks that
pinned the old semantics were re-synced and re-proven with **five** mutations, all
killed — each one a plausible implementation of the new design rather than a
strawman: never retiring a declaration even when it was matched
(`base-own-switch`); consuming it at match time, which is exactly the CN1 defect
the redesign removed (`base-own-switch`, `base-stale-declaration`); never ending
the one-event grace (`base-stale-declaration`, `base-throwing-switch`); evicting a
LIVE declaration in preference to a settled one (`base-two-in-flight`); and
dropping the `settle()` out of `ownSwitch`'s `finally`, so a throwing setter leaves
its declaration in flight forever (`base-throwing-switch`, `base-own-switch`).

When the planner moved effort to the model it routes to and removed router-owned
base seeding and candidate-dependent guards from the OFF path, the six checks
that pinned the old answers were re-synced and the whole set re-proven with
**14** mutations, all killed: removing the derivation so an
omitted level resolves to nothing (`route-vocabulary`); dropping the
`effortJudgedFor` field (`route-list-on`); trimming the `model` argument instead of
passing it byte-for-byte (`route-list-off`); reading a stored `baseModel` on the
router-off path (`route-base-reseed`); ignoring the pre-router pin so the base is
re-seeded to the same model instead (`route-resolved-pair` — this one *survived*
first time and exposed a real gap: the check could not tell "the pin was honoured"
from "the pin was ignored and the base happened to be re-seeded to it", so it now
asserts the absence of the re-seed signal too); deriving the level for the
PRE-substitution model (`route-window-substitute`); inheriting a level across models,
which is BG14 reintroduced (`route-effort-derived-for-model`); seeding a base effort
with the router off (`route-off-invisible`); and, in `episodes.ts`, making the module
unloadable (`episode-load`, which is also how the NOT RUN registration was verified
— five `episode-*` lines report NOT RUN by name), falling back to the action's own
model as a rung (`episode-pin`), demanding an API key again (`episode-auth`), sorting
ids as strings (`episode-version`), silencing the unusable-config diagnostic
(`episode-report`), and dropping the header's whitespace collapse
(`episode-header`).

The `route-*` checks likewise, **27 mutations, 27 killed** — at the time, one per
check (the family has grown since; the later additions record their own rounds
below), plus a
second one for `route-resolved-pair`, whose model half and effort half are
independent, three for `route-off-ladder-source` (below), and seven for the checks
added or changed when the base-repair and read-failure rules landed (further
below). Each one is a defect that would leave the dispatch working: disabling the
vocabulary guard (the level then reaches the ladder guard and is complained about
for the wrong reason); disabling the list guard; making the list guard ignore the
router-OFF state; letting an `on: true` resolution with no candidates stay "on";
validating only the EXPLICIT model, and separately only the explicit effort, so a
thread's base values escape the guards; answering the ladder question for the first
candidate instead of the model in hand (the union-over-models defect); treating an
evidence gap as `ok`; dropping the API-rejected guard (the level is then reported
as a mere ladder problem); picking the NARROWEST candidate for a window
substitution; letting a throwing compaction predicate condemn a dispatch; judging
capacity against the bare window instead of pi's predicate; warning about
long-context billing on every dispatch instead of once; letting failover select the
model that just failed; seeding a base effort from an evidence gap; and dropping
the display sanitizer from a rejection reason. One further mutation makes
`route.ts` unloadable, which is how the NOT RUN registration itself was verified:
`route-load` FAILs and all `route-*` checks report NOT RUN by name, with the
roster still passing.

`route-off-ladder-source` was proven three ways, because its text term and its
behavioural terms catch different defects: making the module fall back to the
**shipped table** when no source is injected (caught by the text term alone — which
is exactly why that term exists); judging a spec the injected source **declined**;
and ignoring the injected **ladder** in favour of pi's whole vocabulary.

The base-repair and read-failure checks were proven with one mutation each, all
killed, and each is a plausible implementation rather than a strawman:

| mutation | kills |
| --- | --- |
| refuse on an unreadable ladder (the pre-fix behaviour) | `route-off-ladder-source`, `route-read-failure-inert` |
| drop guard 1's remediation clause | `route-list-on`, `route-base-reseed-guarded` |
| repair the base but never signal it for persistence | `route-resolved-pair`, `route-base-reseed` |
| read a non-string `effort` as absent (falls through to the base level) | `route-effort-type` — and only that check |
| no base repair at all | `route-base-reseed` and three others |
| "do not reject what we just repaired" in guard 1 — the hole the repair could open | `route-base-reseed-guarded`, `route-list-on` |
| gate the `apiRejectedLevels` refusal on a readable ladder, so the positive fact stops biting | `route-read-failure-inert` — and only that check |

`route-off-ladder-source` was later found **porous** by an independent mutation
gate and repaired: its back-door guard had been a text term matching only a direct
`model-profiles.ts` import, while `model-router.ts` **re-exports**
`SHIPPED_PROFILE_SOURCE` and `route.ts` already imports runtime values from there.
Two mutations passed the whole suite green — `profiles ?? SHIPPED_PROFILE_SOURCE`
(latent) and a fallback to the shipped table when the injected source **declines** a
spec (production-active, because that is exactly what the registry-and-auth-vetted
source does for a model pi cannot serve).

**That first repair was over-claimed, and the claim is corrected here rather than
quietly restated.** It said both mutations died "on the behavioural terms alone".
Re-running them with the text terms neutralised showed that only the first did: the
declining-source fixture stubbed `ladderFor: () => []`, which makes the effort check
inert whichever way the profile lookup goes, so the decline-time fallback died only
to the import scanner — and a scanner is defeated by `import * as mr`, which a later
audit proved passes the full suite. The fixture now mirrors production (`threads.ts`
pairs a VETTED `findProfile` with the SHIPPED `ladderFor`, gating only the lookup), a
fourth fixture covers a source whose LADDER is unreadable, and the scanner
additionally refuses a namespace import of any module carrying the table. Re-verified
with the three import terms neutralised: `profiles ?? SHIPPED`, the decline-time
fallback and the unreadable-ladder fallback **all three** die behaviourally.

The two fixtures recovered from a dead dispatch and committed unreviewed in
`ebcd76c` were mutation-proved afterwards, each against the mutation that motivated
it, and each **ablated** — deleted, with the mutation still applied — because a term
that kills nothing its neighbours would not kill anyway is decoration, and this
suite has shipped two of those.

- **TQ9** (the router-ON back door in `route-off-ladder-source`) is load-bearing
  outright. `model-router.ts` re-exporting `SHIPPED_PROFILE_SOURCE` under a NEW
  name, imported by `route.ts` from that module and consulted in
  `checkEffortFor`'s `resolution.on` branch for specs the table knows: the suite
  fails on this term ALONE, and with the term deleted the same mutation goes fully
  green (exit 0). Nothing else in the suite sees it — the value scanner is defeated
  by the rename, the namespace term by there being no namespace import, and every
  other router-ON fixture uses fabricated `p/*` specs the table declines.
- **TQ8** (the router-ON open in `route-switch-opening-baseline`) is load-bearing
  too, but **the mutation named in the original finding is now over-determined** —
  worth recording, because the obvious ablation gives the wrong answer. Returning
  `verdict.baseModel` bare also fails two OTHER terms, since `baseModel` is
  *undefined* on the router-OFF fixtures rather than equal to the pin, so the term
  looks redundant. The faithful forms — the ones that really do look identical
  everywhere else — carry a fallback: `baseModel ?? model`, and `substitutedFrom ??
  model` (the open silently undoing the window substitution). **Both die on the TQ8
  term and on nothing else**: ablate it and each goes green. Do not delete this term
  on the evidence of the bare mutation.

Neither is brittle: a semantically-null reformat of `checkEffortFor`'s router-ON
branch (block form, `=== true`, plus a comment naming the shipped table by all three
of its exported symbols) and of `planSessionOpen`'s return (hoisted const, explicit
branch) both leave the suite green.

The three switch-decision checks were proven with **11** mutations, all killed —
one per rule rather than one per check, because the helper's value is its
precedence: ignoring `openOnly` (the BG16 regression), never reverting (BG22),
dropping the failover stand-down, letting a held failover outrank a plan target,
removing the `already-current` short-circuit, and mislabelling a revert as a plan
(the BG24 split) each kill `route-switch-decision`; making the pin non-`openOnly`
and — the one that matters — planning the session OPEN *with* the model argument
kill `route-switch-opening-baseline`; and removing the effort axis's baseline,
capturing the model baseline after the switch, or not clearing it on disposal each
kill `route-switch-lifecycle-i1`.

**Three of those eleven kills no longer reproduce as recorded, and the reason is
good news rather than rot.** They were mutations of `threads.ts` that died on text
terms which have since been deleted: planning the session OPEN *with* the model
argument, capturing the model baseline after the switch, and not clearing the
baseline on disposal. The first is now caught EXECUTABLY — its in-module equivalent
(`planSessionOpen` regaining `input.requestedModel`) fails
`route-switch-opening-baseline`, verified. The second is caught only in its
`applyRoute` form, by `route-baseline-capture`'s residual term; captured later still,
in the dispatch body, it is not caught. **This used to say "TQ7 blocks that with a
type, not a check", and that was false** — see the enforcement note below. It stays
false now that a typecheck exists, for a subtler reason: TypeScript permits an
assertion to a branded subtype, so the bypass typechecks cleanly. What narrows the
shape is the brand-cast scan, which refuses that assertion; a capture taken late in
the dispatch body without any cast remains genuinely uncaught.
The third — not clearing the baseline map on disposal — was unpinned for a while, and
is **covered again**, by a term derived rather than re-anchored: see
`route-baseline-capture`'s disposal term below. The remaining eight kills are
behavioural and stand.

A check can also pin the WRONG thing, and this suite has now done it once: the
model-switch decision trimmed its `model` argument, `route-switch-decision`
asserted that trimming as intentional, and a quality gate used the check as
evidence that the behaviour was deliberate rather than a slip. It was a regression
against CQ13's byte-for-byte contract — a padded spec silently succeeded instead of
producing pi's own error, and a whitespace-only one silently reverted instead of
doing what was asked. The terms are repinned to the byte-for-byte rule, tied to
`planRoute` through the same value so the two modules cannot drift apart, and three
mutations now guard the way back: restoring the trim wholesale, trimming only
padding, and treating only whitespace as absent — all three killed. The lesson is
recorded here rather than quietly fixed: a pinned behaviour is an assertion that it
is CORRECT, and pinning something merely observed can convert a defect into a
documented feature.

`route-open-plan-inputs` (BG25) was proven both ways before it was committed — it
fails on the code that has the defect and passes on the code that fixes it — and by
one mutation against the fixed code: restoring `effort` to the open plan's inputs.
That kill has been **re-verified since the term stopped being structural** — it now
dies on the two EXECUTABLE terms (`planSessionOpen` returns `{unplanned: 'effort
"max" is not on p/pin's effort ladder'}` instead of the pin), which is strictly
better than the regex it replaced.

**A second claimed kill has been withdrawn.** It read "reading a model off a rejected
plan", and it did not reproduce: written naturally
(`const openModel = modelless.model as string | undefined;`) the structural term
matched and the mutation SURVIVED — and it is a runtime no-op anyway, since a
rejection carries no `model`, so there was never a defect there to catch. Only an
artificial spelling that happened to break the regex ever "died", which is a fact
about the regex, not about the code. That regex is gone: TQ4 extracted the
session-open derivation, so `planSessionOpen` is called rather than matched, and
`route-open-plan-inputs` asserts the shape by execution. What the caller does on a
REJECTION is still deliberately NOT pinned — see that check's own note: the behaviour
was in flight when it was written, and pinning an in-flight shape is how a check ends
up vouching for the weaker of two behaviours.

### Re-verification, and what it cost the claims above

Every mutation this file claims is periodically re-applied to the CURRENT code and
re-run, because a claim ages: the code under it moves, and an anchor that no longer
matches, or a mutation the code has since made harmless, silently turns a teeth
statement into folklore. The last sweep re-ran **44** claimed mutations against
`bdc6eba`; **42** reproduced exactly as claimed. The two that did not are corrected
here rather than dropped:

- **"inheriting a level across models (BG14)" no longer killed anything.** Not
  because the check rotted, but because BG23's re-validation had made the mutation
  almost harmless: with the DISJOINT ladders the fixture used, an inherited level is
  invalid on the target model and gets re-derived, so inheriting and deriving now
  produce the same answer. The half of BG14 that survives — running at a level chosen
  for a different model when that level happens to be legal on this one — was
  genuinely uncovered. `route-effort-derived-for-model` gained an OVERLAPPING-ladder
  case (stored `medium`, legal on both; the target's own lowest measured level is
  `low`), and the mutation kills again. A fix making a mutation harmless is good news;
  a fixture that can no longer tell the two apart is not.
- **"unguarding the seed predicate" was matching the wrong guard.** After the tracker
  redesign the anchor text also appeared in `adopt`, so the mutation landed there and
  killed `base-adopt` instead of `base-seed`. Re-targeted at the seed's own
  unknown-model branch, it kills `base-seed` as claimed. The check was always sound;
  the recorded recipe had drifted.

Everything else in this section reproduced. Claims are dated to the commit they were
last checked against — `bdc6eba` — rather than left as timeless assertions.

### Structural terms: both directions, every term

The eight regex-on-source terms were re-anchored on SHAPE after six of them were
shown to false-alarm on edits that changed nothing (an inline `type` import, a
hoisted const, another spelling of a template literal, one more stripped key, a
`readonly` modifier, and a doc comment that merely mentioned the symbol an ordering
check keyed on). That is not cosmetic: an implementer abandoned a candidate fix
partly because it "broke the harness's pinned line", and it had not. Every term —
those eight then, the two that stand now — is proven in BOTH directions: a
semantically null reformatting PASSES and a semantics-breaking edit FAILS. The
original round was 14 trials, all as expected; the table below is the running record,
with each row marked LIVE or DELETED so a reader can tell a current guarantee from a
historical one:

| term | null edit that must PASS | breaking edit that must FAIL |
| --- | --- | --- |
| shipped-table import scan **— LIVE** | inline `{ type X }` import | a value import of the table; a namespace import of a module carrying it |
| `applyRoute` baseline residual **— LIVE, added later (TQ7/TQ14)** | parameter renamed, moved, signature reflowed to one line, a brace-bearing return type, a GENERIC parameter list, doc comment naming `captureSessionBaseline(session)` and `as SessionBaseline` | a late `captureSessionBaseline` inside `applyRoute`; the parameter removed; the parameter ignored; a live reading cast through the brand; **and every cast into `OpenModel`** — `as OpenModel`, `as unknown as OpenModel`, `<OpenModel>`, and `as never` |
| session state released on disposal **— LIVE, added later (TQ13)** | `disposeAll`'s clears reordered, spaces inside the member access, comments, an unrelated statement between them; `openWorkerFor`'s thread id hoisted, its writes reordered, its return type reshaped, and its write made through a `const` **or destructuring alias** | the `liveBaselines` clear removed; the WRONG map cleared; a NEW session-scoped map written on open and never released; a **conditional** clear; a **short-circuit** clear; an **unresolvable alias** hiding the write (fails closed). Note: wrapping the clears in a nested arrow, a null edit the first version accepted, is now REFUSED — the term cannot tell an invoked closure from a dead one, so it asks for the shape it can verify and its failure names the rule |
| ~~open plan drops `model`~~ **— DELETED (TQ4)** | the `routeInputs` call hoisted to a const | `model` no longer stripped |
| ~~open plan drops both args~~ **— DELETED (TQ4)** | a THIRD stripped key; reordered keys | `effort` no longer stripped |
| ~~baseline from the session~~ **— DELETED (TQ4)** | the spec built by a different expression | the baseline recorded from the routed plan |
| ~~I1 axis symmetry~~ **— DELETED (TQ10)** | `readonly` on both maps | the effort baseline dropped |
| ~~capture ordering~~ **— DELETED (TQ10)** | a doc comment naming `applyRoute` | the model baseline captured after the switch |

The struck rows are kept as the record of what was proved and when, not as a claim
about the current suite: those terms no longer exist, so their trials cannot be
re-run. What replaced each is named in the paragraph below.

All source reading for these terms goes through one helper that strips comments and
matches calls by balanced parentheses, so spelling, spacing, key order and prose can
change freely while the claim stays exactly as strong.

**Five of those six are now gone entirely**, which is the better outcome, and the
tally is stated once here rather than accumulated in successive sentences (it was
briefly "four" and "five" in the same paragraph). Three went to TQ4: the dispatch
side extracted `planSessionOpen`, `captureSessionBaseline` and `decideEffortSwitch`,
so what the session opens on, what is recorded as the revert target, and the whole
effort-axis lifecycle are CALLS now, not text. Two more went to TQ7/TQ10: making the
baseline a branded object captured in one place DISSOLVED the I1 wiring terms (both
axes' baselines declared, set, cleared, used, and captured before any per-action
switch) rather than moving them — there is one `liveBaselines` map, so there is no
per-axis ordering left to assert, and the late reading those terms watched for is no
longer an expression the call sites accept.

> **A typecheck exists, and it does not close the brand.** `npm run typecheck`
> (`tsc --noEmit`, `typescript@5.9.3` exact-pinned, `strict` and
> `noUncheckedIndexedAccess` on) runs against `tsconfig.json` — an earlier version of
> this note said none of that existed, which was true when it was written and is not
> now. What has NOT changed is the conclusion, and the reason is worth stating
> precisely, because "the typecheck covers it" is exactly the kind of false confidence
> this file exists to prevent.
>
> TypeScript permits an **assertion** to a branded subtype. `someString as OpenModel`
> typechecks cleanly; so does `as never`, and so does `{ effort: "high" } as
> SessionBaseline`. Verified against this repo's own compiler settings: of those
> three plus a plain `const x: OpenModel = someString` control, **only the control
> errors**. The typecheck therefore catches the ACCIDENT — a raw string assigned where
> a brand is wanted — and not the DELIBERATE assertion, which is the shape both
> flagship defects were written in. Note also that pi loads this TypeScript through
> jiti at run time, which strips types without checking them, so the typecheck is a
> separate command a contributor runs, not something the loaded code has passed.
>
> What refuses the assertion is the **brand-cast scan** below — `as SessionBaseline`,
> `as OpenModel`, their `unknown`/`any` two-step and angle-bracket spellings, and `as
> never` outright (`never` is assignable to every brand at once, so a brand-by-brand
> list would miss it). A reader deciding whether a brand protects them should read
> that term, not the type.

**Four structural terms stand today**, each about a fact no pure function can hold,
and two of them were added AFTER this section was first written:

- the **`wiring` check** — the oldest of them, and easy to forget in this count
  because it is a whole check rather than a term inside one: every config sanitizer
  is imported by `index.ts` and called at `session_start` with its own key and its
  required live sink. The router uses `routerWarn`; the others use `warn`.
  `index.ts` cannot be loaded here, so this is asserted against source text;
- the **shipped-table import scan** in `route-off-ladder-source` — three conjunct
  terms over `route.ts`'s imports, because a back door is an import, not a value;
- the **`applyRoute` baseline residual** in `route-baseline-capture` — one term,
  four conjuncts, for the one thing TQ7's brand cannot encode: a brand says WHO
  produced a value, never WHEN, so a capture taken late inside `applyRoute` is still
  type-correct. Its fourth conjunct is the **brand-cast scan**, and it is doing more
  work than its name suggests — it is the only thing that refuses a deliberate cast
  INTO either brand, which the typecheck permits (see the note above). It was added
  because mutation found the first three conjuncts blind to a
  live reading laundered through `as SessionBaseline`; `OpenModel` was added to it
  later (TQ14) after a gate reproduced `open: { model: (open.model ?? opts.model) as
  OpenModel }` — BG22-on-the-opening-path verbatim — while the suite otherwise
  passed. The run's own summary line remains the count authority;
- **session state released on disposal**, also in `route-baseline-capture` — the
  other end of the same lifecycle. `liveBaselines` is keyed by THREAD ID, ids are
  reused, and an entry surviving disposal would be handed to `decideModelSwitch` as
  the revert target for a session that never opened on it. It is **derived, not
  enumerated**, which is the whole reason it is not brittle: naming the three maps
  would be a list to forget and a rename away from a false alarm, and "every map"
  would be wrong, since `queues` and `longContextWarned` deliberately outlive a
  session. The rule asserted is the one the code already obeys — *state a session's
  OPEN touches is state its DISPOSAL must release* — so the session-scoped set is
  read out of `openWorkerFor` and each member must be cleared in `disposeAll`. Two
  ways of defeating its first version are closed (TQ13): the clear must be an
  **unconditional top-level statement** — `if (cond) this.liveBaselines.clear()`
  satisfied a mention-scan while never running, and so did a short-circuit — and
  **aliases are resolved** before the scan, because `const baselines =
  this.liveBaselines` hid the write, so dropping the clear leaked state while a
  fourth, properly-cleared map kept the old `>= 3` vacuity threshold satisfied. That
  threshold is gone; the guard now asks that both methods were found, that the
  discovery found something, and that it was blind to **nothing** — a write whose
  receiver cannot be named FAILS the term rather than being skipped, which is what
  makes the alias class closed rather than the two spellings that happen to be
  handled. A new session-scoped map arrives already covered (proved: adding one that
  is never cleared FAILS), and renaming any of them changes nothing, because both halves move
  together. A vacuity guard fails the term if either method stops being findable or
  the discovered set drops below three.

All three were proven in both directions; the last two's trials are the rows above.
Writing the third surfaced a latent trap in the second: both find a method body by
balance, and "the first `{` after the parameters" is the RETURN TYPE for
`openWorkerFor`, which returns `Promise<{ session; baseline }>`. `applyRoute` returns
`Promise<void>` and so had worked by luck. Both now locate the body at **angle-depth
zero**, and giving `applyRoute` a brace-bearing return type is one of the null edits
that must pass.

The two defect shapes an audit proved invisible are now executable checks, and both
were confirmed to FAIL when reintroduced: `?? opts.model` in the session-open
derivation (BG22 on the opening path) and reverting the effort axis to the LIVE level
rather than the OPENING one (BG18). A third, found by mutation while writing them, is
new coverage: `decideEffortSwitch` dropping its vocabulary validation killed nothing,
because every fixture on that axis fed it valid levels — so BG21's rule is now
asserted on the effort axis too.

### The roster's own teeth

The roster is the only mechanism standing between a vanished check and a clean
exit, so it is mutation-tested too — four ways a check can disappear or lie, all
caught:

| mutation | result |
| --- | --- |
| a check **deleted** (its report call suppressed) | `roster` FAIL, `none missing → ["memoization"]`, exit 1, and the summary prints `−1 unaccounted — see the roster line` |
| a check **reporting twice** | `roster` FAIL, `none reported twice → ["memoization"]`, exit 1, summary `+1 unaccounted` |
| a check **renamed** to an id absent from the expected list | `roster` FAIL naming **both** halves — `none missing → ["memoization"]` and `none unexpected → ["memoisation"]` — exit 1. Note the counts still reconcile here: identity, not arithmetic, is what catches a rename |
| a whole **module unloadable** (`base-model.ts`) | its load check FAILs, every other `base-*` check reports **NOT RUN by name**, `roster` still PASSes (they *did* report), exit 1 |
| a check **missing from its NOT RUN list** (`VOIDABLE`) | `roster` FAIL, `every voidable check is on a NOT RUN list → ["<id>"]`, exit 1. This is the audit that keeps the row above honest: without the id in its list, an unloadable module turns an honest NOT RUN into a bare "missing" line naming no cause. It filters `EXPECTED` **by prefix**, so a list serving two id prefixes needs an entry per prefix — `STATE_IDS` had only `spec-`, and the two `state-*` checks were therefore uncovered by it until an entry was added. Proved twice, once per prefix |

And the strict semantics were verified in isolation, on a copy where one check
stands down with **no** FAIL anywhere: plain run exits **0** with `1 not run`, the
same run with `--strict` exits **1**. So a run that quietly skipped coverage cannot
read as success in automation.

Two of those mutations initially made a check **crash** rather than fail (a term
read `.reason` off a verdict that was suddenly a *proceed*). That is a worse signal
than a FAIL — it names a section, not a claim — so every reason read in this block
now goes through one helper that yields `""` for a proceed. The mutation testing is
what surfaced it; a suite that only ever runs against correct code cannot.

It loads the TypeScript modules listed above plus the standalone checker, and it
reads `extension/worker.ts` only for the preamble constant, so it does **not**
exercise that module's worker-session load path — the allowlist-mode extension
load, the `excludeTools` deny list that structurally keeps slate's dispatch
tools out of a worker, and the post-load collision re-check. Those need a live
loader and session, so the manual isolated-load smoke test
(`pi --no-extensions -e .`, see `AGENTS.md`) covers them instead; a passing run
here says nothing about them. **With the same caveat as the doctrine finding
above**: those paths are reached by a DISPATCH, which needs orchestrator mode, which
is only seeded in `tui` mode — so a headless `-p` smoke run does not reach them
either. It has to be an interactive session, and `AGENTS.md` says as much about a
bare `-p "exit"` run. One part of `worker.ts` *is* covered by an
automated net, but by the ladder rather than this suite: the settings isolation a
per-dispatch worker switch depends on, in rung `WK1` above.

The router and `route-*` checks stop at the **pure** boundary: they prove what the
resolution reports and what the planner *decides*, not what `threads.ts` then does
with a verdict — applying the switch to a worker session, raising an early
rejection as a tool error, aborting an apply-time one without an episode, or
remembering guard 6's once-per-pair notice. Those are separate mechanisms; `WK1`
above covers one slice of the first. **The doctrine's routing rule used to be listed
here too and no longer belongs**: the `doctrine-*` checks cover it — feature-off
byte-identity, positional numbering, injection safety, the two content exclusions and
the size budget — by rendering it through `registerSlateMode`'s own handler.

## Files

| file | role |
| --- | --- |
| `run-resolver-checks.sh` | the entry point: tool checks, jiti location, temp dir, `--strict`, exit code |
| `resolver-checks.mjs` | the driver: imports the modules through jiti, builds fixtures, runs the checks, prints the roster and the summary |
| `writing-check-tests.mjs` | the writing checker's correctness suite — see § The writing checker |
| `writing-check-scaling.mjs` | the writing checker's **growth** gate — see § The writing checker |

Those last two are separate nets with their own entry points; the resolver
suite's `writing-*` checks cover the wiring around the module rather than the
module itself.

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`).

# Writing-reminder integration check — `run-writing-reminder-check.sh`

This harness proves that the hidden reminder crosses real pi hook, steer, provider,
and persistence boundaries. Run it from the repository root:

```sh
bash verification/run-writing-reminder-check.sh --repo .
```

On the reference machine, the pi phase takes about one second and wrapper wall
clock is around two seconds. These are observed values, not a machine-independent
speed promise. The hard bound is GNU `timeout`: TERM after 60 seconds, then KILL
five seconds later.

Exit status: **0** every check passed · **1** a check failed · **2** the harness
refused to start. A missing tool, non-GNU `timeout`, bad checkout, missing canary,
missing pi binary or version mismatch gives exit 2. Every refusal starts with
`verification: refused to start — `.

The harness resolves pi in this order:

1. `PI_BIN`, when set. The harness prints a `NOTE` line for this expert override.
2. `node_modules/.bin/pi` in the checkout.

It accepts no pi from `PATH`. The selected CLI's `pi --version` must exactly match
`devDependencies["@earendil-works/pi-coding-agent"]`. Run
`npm ci --ignore-scripts` after a pin change or a missing local install.

Required commands are `node`, `mktemp`, GNU `timeout`, `mkdir`, `rm`, `date`,
`env`, `cat`, `tr` and `sed`. The preflight checks every command before its first
scratch write. It also checks that `timeout --version` identifies GNU coreutils,
because the hard bound needs `--kill-after`.

## What the live sequence proves

The harness resolves both repository and scratch roots to physical paths. It
installs cleanup immediately after `mktemp`, then rejects a scratch root inside
the checkout. The scratch root holds a trusted project, agent directory, home and
temp directory.

The child starts through `env -i`. Only explicit throwaway values cross that
boundary: `HOME`, `PATH`, `TMPDIR`, `PI_CODING_AGENT_DIR`, `PI_OFFLINE`, dead
proxy variables and the canary evidence paths. `PI_OFFLINE=1` keeps pi startup
offline. The fake provider performs no network operation. This is **not** a
network sandbox because reviewed extension code can still open raw sockets.

The project config enables orchestrator mode, writing checks and reminders. It
sets `contextBudget: 200000` and `remindPercent: 10`. The fake model advertises a
1,000,000-token window and the first response reports 25,000 input tokens. The
correct effective interval is 20,000 and fires. A broken path using the model
window would derive 100,000 and stay silent. This makes budget selection and the
clamp load-bearing.

The canary registers an in-process fake provider and one real tool. The first
provider response emits two parallel calls to that tool. Both executions append a
marker. Each persisted tool result must contain exactly one text block, no extra
block or key, and the text `CANARY_TOOL_RESULT_ONLY`. Slate's real `tool_result`
hook sends one hidden custom steer despite the parallel results.

The second provider call must receive the exact five requirements and shared
scope exclusion once. It writes a unique success response only after observing
the exact text and pre-normalized custom metadata.

Pi normalizes custom messages into user messages before the provider call. The
canary therefore checks two points. Its `message_start` hook sees
`role: "custom"` and `customType: "slate-writing-reminder"` before normalization.
Its provider sees the exact reminder text after normalization. The session JSONL
then persists a `custom_message` entry with the same custom type and
`display: false`.

The checks assert all of these facts:

- pi exits zero within the timeout.
- RPC output and session JSONL parse completely.
- No `extension_error` event appears.
- `/slate` is attributed to the checkout under test.
- The fake provider observes the trusted scratch project.
- Both parallel tool calls execute and both tool results persist.
- Each tool result equals the complete one-block content shape.
- The provider runs exactly twice and emits its success marker.
- The next model call receives exactly one exact reminder.
- Session JSONL persists exactly one exact reminder with `display: false`.
- No tool result carries extra content, keys or reminder text.
- The expected check roster reports exactly once.

A clean run removes its physical scratch directory. A failure keeps the
directory, prints its path, and inlines pi stderr and stdout. The directory also
contains the raw RPC stream, session JSONL, provider evidence, tool marker and
parsed analysis.

## Boundary and re-run rules

This is an integration net, but it is not part of CI. It is also separate
from the extension-load check and the ladder. The load check proves registration
without executing a tool. The ladder covers model-default restoration and worker
settings isolation. This harness covers one reminder steer through a real pi
session. No current workflow invokes it automatically.

The harness structurally proves `display: false`. It does not prove that the TUI
visually hides the message. Confirm visual invisibility manually in an interactive
TUI session when that presentation contract changes. A PTY check would add a
fragile render-loop dependency, so this boundary stays explicit.

Re-run the harness after changes to:

- `extension/writing-reminder.ts`, including requirement text, rendering, cadence,
  or gates.
- Reminder config sanitization in `extension/writing.ts`.
- The `message_end` or `tool_result` reminder hooks in `extension/mode.ts`.
- The handoff `forceNext` assignment or session-start ordering in
  `extension/handoff.ts` and `extension/mode.ts`.
- Custom message options, custom type, or steer delivery.
- `verification/writing-reminder-canary.mjs` or the harness itself.
- The pinned pi version or any asserted RPC and JSONL shape.

A change to `extension/handoff.ts` still requires the full ladder. Run the
resolver suite too after changes to the reminder policy, writing config, mode
wiring, doctrine rendering, or handoff ordering contract.

## Files

| file | role |
| --- | --- |
| `run-writing-reminder-check.sh` | driver, environment isolation, real pi session, evidence parser, assertions, roster, and artifact policy |
| `writing-reminder-canary.mjs` | real canary tool, offline provider, pre-normalization hook observation, and provider evidence |

# Packaging guards — `run-packaging-checks.sh`

This harness guards what the package ships, and it is the only harness in this
directory that loads no slate code. It makes `AGENTS.md` § Packaging rules
executable. It has two layers.

The first layer reads the shape of `package.json`:

- the exact `files` whitelist;
- the `docs` entry, which the shipped doctrine resolves at run time;
- the `pi-package` keyword, which the pi.dev gallery listing needs;
- each pi-bundled SDK package, which must be a peer at `"*"` and absent from
  `dependencies`;
- the absence of an install-time lifecycle script.

The second layer reads the real file list from `npm pack --dry-run`. It permits
a small set of file kinds, it rejects junk and secret shapes, it requires every
doctrine doc that the extension references, and it requires that the pack left
no tarball.

The second layer adds real value to the first. npm expands a whitelisted
directory **recursively**, and a `files` whitelist makes `.npmignore` and
`.gitignore` inert. A stray file under `extension/` or `docs/` therefore ships
behind a manifest that passes every assertion in the first layer. The pack runs
with **`--ignore-scripts`**, because `npm pack` otherwise runs `prepack` and
`prepare`, and an install-time script is one of the faults that these guards
catch.

The harness is cheap and valid for one reason: it drives nothing. Every manifest
assertion is a pure function of the parsed manifest, and every pack assertion is
a pure function of the pack file list. That purity makes `--self-test` possible:
the harness runs each guard again against a **deep clone of the real input** with
exactly one violating mutation, and the guard must FAIL. The harness writes no
fixture itself, because an assertion that reads a misspelled field accepts a
mutation of the real field. The self-test therefore compares each clone with its
source and fails on a mutation that changes nothing. A pack report without files
makes `pack-allowed` and `pack-no-junk` empty of meaning, so the harness treats
an unreadable report as a refusal to start, and never as a pass.

## Running it

```sh
bash verification/run-packaging-checks.sh --repo .              # ~0.3 s; --repo defaults to "."
bash verification/run-packaging-checks.sh --repo . --self-test  # CI: prove that the guards still fail
bash verification/run-packaging-checks.sh --help
```

The harness prints one line for each check, then a summary:

```
CHECK files-exact                      PASS — files is exactly ["extension","docs","README.md","LICENSE"] (order included), got ["extension","docs","README.md","LICENSE"]
CHECK pack-doctrine-docs               PASS — every doctrine doc derived from extension/*.ts via DOCS_DIR ships: design-principles.md, model-routing.md, pr-publishing.md, review-rules.md, track-workflow.md, writing-guidance.md — missing: none
== summary: 16 pass, 0 fail ==
```

`--self-test` prints the same 16 ids with the prefix `self-`. The verdict column
holds the meaning: PASS says that the guard rejected its mutated input, which is
the required result.

```
== self-test: each guard must reject a real input carrying one violating mutation ==
CHECK self-files-exact                 PASS — mutated the real manifest: pushed "verification" onto files → the guard rejected it, as required
CHECK self-pack-doctrine-docs          PASS — not manifest-shaped, so mutated the REAL pack list: dropped docs/design-principles.md from the shipped paths → the guard rejected it, as required
== summary: 16 pass, 0 fail ==
```

Exit status: **0** every check passed · **1** a check failed · **2** the harness
refused to start. Four conditions give exit 2: a missing tool, a bad `--repo`, a
checkout without `verification/packaging-checks.mjs`, and a pack report without a
file list. `node` and `npm` must be on `PATH`, and that pair is the whole
dependency list: the harness needs **no pi, no jiti, no network and no session**.
It writes nothing anywhere, because the pack is a dry run, and `pack-no-tarball`
proves that result.

## What it covers

The harness runs 16 checks. Twelve checks read the manifest, and four checks read
the real pack output.

| id | what it proves |
| --- | --- |
| `files-exact` | `files` is exactly `["extension","docs","README.md","LICENSE"]`, in that order. The guard asserts **equality**, so a deliberate change to the whitelist must update `FILES_EXACT` in the driver in the same commit |
| `files-docs` | `files` contains `docs`. This check has its own verdict line, separate from the equality check, because a package without `docs` ships a **broken doctrine** (a recorded adversarial finding) |
| `keywords-pi-package` | `keywords` contains `pi-package`, which lists the package in the pi.dev gallery |
| `peer-pi-ai` / `nodep-pi-ai` | `@earendil-works/pi-ai` is `"*"` in `peerDependencies`, and it is absent from `dependencies` |
| `peer-pi-agent` / `nodep-pi-agent` | the same for `@earendil-works/pi-coding-agent` |
| `peer-pi-tui` / `nodep-pi-tui` | the same for `@earendil-works/pi-tui` |
| `peer-typebox` / `nodep-typebox` | the same for `typebox` |
| `no-install-scripts` | `scripts` declares none of `prepare`, `postinstall`, `install` and `preinstall`. npm runs each of them on **every consumer install** |
| `pack-allowed` | every shipped path is one of `package.json`, `README.md`, `LICENSE`, `docs/**/*.md`, `extension/**/*.ts` and `extension/**/*.mjs`. This is the guard against the recursive expansion, and the only guard that covers a doc which prose alone references. The `.mjs` kind is a **runtime** kind, not a harness one: the shipped writing checker (`extension/writing-check.mjs`) is dependency-free plain JavaScript, because it runs both as a command and inside a synchronous turn hook with no transpiler in either path |
| `pack-no-junk` | no shipped path matches `.env* *.log *.pem *.key *.p12 *secret* *credential* node_modules/** *.tgz .git* *.local.*`. The match ignores case, and a pattern without `/` matches the basename at any depth |
| `pack-doctrine-docs` | the package ships every doctrine doc that the extension resolves at a package-resolved path. The driver **derives** the expected set at run time from the `DOCS_DIR` joins in `extension/*.ts`. See the limits below |
| `pack-no-tarball` | the `--dry-run` pack left no `*.tgz` in the checkout. The search skips `node_modules/` and `.git/`, because a cached tarball there belongs to another package |

This coverage has two limits, and both are deliberate.

`pack-doctrine-docs` **derives** its expected set from the sources. It finds each
identifier that holds the docs directory of the package, and it collects every
`*.md` literal that the code joins onto one of them. A new reference therefore
extends the guard without an edit. The `pack-doctrine-docs` verdict line names
every doc in the derived set, so this document transcribes no list of them: the
set grows with the code, and a copy here would go stale the way other
transcribed facts in this file already have. It covers **no**
doc that prose alone mentions, because a doc name in a comment, a project-local
template and a run-time episode name are not package-resolved doctrine docs, and
they must stay out of the derived set. `pack-allowed` covers the other docs,
because it permits `docs/**/*.md` as a kind.

The second limit is content: no check here reads the text of a doc. A shipped doc
with wrong content packs correctly.

This harness and the package-content check below **overlap, and the overlap is
not yet consolidated**. Both read the file list from `npm pack --dry-run`, and
both require doctrine documents to ship. They derive that requirement from
different places. `pack-doctrine-docs` scans `extension/*.ts` for Markdown joins.
The package-content side is separate:

- It independently enumerates every Markdown file.
- It recursively enumerates each `.mjs` entry whose first line is
  `#!/usr/bin/env node`.
- It requires one exported runtime path and one packed file for each roster item.
- Merging the two nets is reasonable future work.
- Until then, run both normal checks and both self-tests.

This harness guards **packaging**, so it says nothing about behaviour. It never
loads `extension/index.ts`, and it starts no session. It cannot tell you whether
the shipped doctrine is correct, whether the extension loads, or whether the
sources typecheck. `run-load-check.sh` answers the second question, and
`npm run typecheck` answers the third. The harness also publishes nothing, it
logs in nowhere, and it contacts no registry.

## Files

| file | role |
| --- | --- |
| `run-packaging-checks.sh` | the entry point: it parses the arguments, checks the tools, validates `--repo`, and returns the exit code |
| `packaging-checks.mjs` | the driver: the manifest assertions, the pack assertions, their mutations, and the derived set of doctrine docs |

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`). For that reason the
self-test of `pack-allowed` adds `verification/ci-canary.ts` to the pack list: a
shipped file from this directory is exactly the regression that the guard must
catch.

# Extension-load check — `run-load-check.sh`

This harness proves what every other check assumes: pi's run-time loader loads
the extension in the checkout under test, its `session_start` hook runs, and pi
registers the dispatch tools and the `/slate` command. It proves this for THIS
checkout, and not for an installed copy.

The harness is cheap. It starts three pi processes, each for about one second,
and all run offline without a credential. Two further checks start no pi at all
(`T4` and `T5`, below). Each pi process gets a fresh and **empty**
`PI_CODING_AGENT_DIR` from `mktemp`, with no `models.json` and no `auth.json`, so
no provider exists for a call. Each process also gets `PI_OFFLINE=1` and
non-model rpc requests from a file, so stdin reaches EOF at once. The first two
runs use `--no-extensions` and load the checkout explicitly. The third run keeps
project packages enabled and loads slate only through a local package entry. The
harness removes every inherited credential and every pi session variable from
the environment of the child process.

The third run builds a reduced scratch project containing `package.json`,
`extension/`, `docs/`, and `.pi/settings.json`. The settings file contains only
`{"packages":["../"]}`. The copy contains no `node_modules`; pi must resolve the
relative path from `.pi` and use its bundled peer packages. The run is trusted
with `-a`, loads the canary by absolute path, and never passes slate through
`-e`.

`PI_OFFLINE=1` is mandatory for all three runs, and the trusted runs need it most:
`-a` makes pi read `.pi/settings.json`, and pi then npm-installs every package in
that file. One such run hung for 60 seconds and wrote a `.pi/npm` directory
**into the checkout under test**. `L8` and `T3` therefore assert that the
directory did not change.

The harness is valid because the failure modes that it covers have no other
signal (`AGENTS.md` § How extension-load failures surface). pi drops an entry in
`pi.extensions` that resolves nowhere, and it says nothing. A throw in
`session_start` appears as an `extension_error` event on stdout only. A tool
registration that disappears produces **no diagnostic at all**.

The last failure mode needs a positive control, because pi 0.83.0 offers no rpc
command and no CLI flag that lists the registered tools. `verification/ci-canary.ts`
loads beside the checkout, and it prints one
`CI-CANARY {"tools":[…],"cwd":…,"trusted":…}` line to stderr from inside the
session. The canary asserts nothing, and it throws nothing: a throw in a
`session_start` hook does not fail the process, so a canary that asserts through
a throw cannot fail CI. Adversarial review raised exactly that point (`AD1` in
that round; `AGENTS.md` § Overview explains the tags). Every assertion lives in
the driver, which reads that line. `L5` and `T1` turn an absent line or an
empty line into a failure, and not into a quiet pass.

The harness takes the pi CLI from the order that it shares with the resolver
checks (`AGENTS.md` § CI), with two deliberate differences. It accepts
**no** pi from `PATH`: after `PI_BIN` and `node_modules/.bin/pi` in the checkout,
it refuses to start. It also requires the same version from `pi --version` as the
`@earendil-works/pi-coding-agent` pin in `devDependencies`. Both rules have one
reason: this harness asserts on pi's rpc output shapes, so it must exercise the
same pi that the typecheck pins.

The harness prints `PI_BIN` loudly in its output. `PI_BIN` is an override for an
expert user, and it is **no security boundary**. The harness treats it as none,
because a person who sets it can also edit the script.

## Running it

```sh
bash verification/run-load-check.sh --repo .              # ~4 s; --repo defaults to "."
bash verification/run-load-check.sh --repo . --only L4,L6
bash verification/run-load-check.sh --list-checks
bash verification/run-load-check.sh --help
```

The harness prints a header with the run context, one line for each check, and a
summary:

```
repo  = /home/you/src/ytdb-slate (7d4c479)
pi    = /home/you/src/ytdb-slate/node_modules/.bin/pi (0.83.0, pinned 0.83.0)
lab   = /tmp/slate-loadcheck.Qw69p0
NOTE   USER-SCOPE SLATE IDENTITY DIFFERS — historical pre-migration example: user /home/you/.pi/agent/settings.json: npm:ytdb-slate@0.10.0 => npm:ytdb-slate. Project /home/you/src/ytdb-slate/.pi/settings.json: ../ => local:/home/you/src/ytdb-slate. A real session loads two copies and exits 1 with a tool conflict.

CHECK L4                               PASS — the canary observed all three dispatch tools registered: thread, threads, episode
CHECK L6                               PASS — /slate is registered and attributed to /home/you/src/ytdb-slate/extension/index.ts — inside the checkout under test, so this run exercised the working tree and not an installed release
CHECK T2                               PASS — slate's config sanitizers emitted no warning for the checkout's own .pi/slate.json (they cover the shape of modelFailover, contextBudget and workerExtensions only — not the file's syntax, which is T4, nor any other key)
CHECK T4                               PASS — /home/you/src/ytdb-slate/.pi/slate.json parses as a JSON object, 5 top-level key(s): orchestratorModeDefault, workflow, modelFailover, router, workerExtensions
CHECK T5                               PASS — project settings contain one local ytdb-slate entry: ../ resolves from /home/you/src/ytdb-slate/.pi to this repository, with 1 existing pi extension entry file(s)
CHECK T6                               PASS — trusted scratch project loaded slate through "../" from /tmp/slate-loadcheck.Qw69p0/local-package/extension/index.ts, registered thread, threads and episode, and exited without a duplicate-load conflict

== summary: 14 pass, 0 fail ==
```

Exit status: **0** every check passed · **1** a check failed, or `--only` matched
no check, because a mistyped subset must never look like success · **2** the
harness refused to start.

One exit-2 case reports a **real defect through another mechanism**. A deleted
`extension/index.ts`, or a deleted `verification/ci-canary.ts`, makes the sentinel
`die` in the driver refuse the run instead of a FAIL report. A missing `docs/`
instead makes `T6` fail, so an earlier verdict and the summary remain visible. pi drops the
nonexistent entry from `pi.extensions` in silence and starts normally. Every
check would otherwise pass on an empty session, and no failure report could
appear. The other exit-2 cases come from the environment: a missing tool, a bad
`--repo`, no pi CLI, or a mismatch between the CLI and the pin. The harness
prints the remedy with the message (`run 'npm ci --ignore-scripts'`, which is the
install that CI runs; after a deliberate change of the pin, that install is
enough).

Requirements: `node` and `mktemp`. The harness uses `timeout` when it is present,
and it does not require it, so a hung pi cannot hang CI. An unknown id in
`--only` is a hard error (exit 2). Every refusal starts with
`verification: refused to start — `, which is the vocabulary of all three CI
wrappers and not a local convention. `AGENTS.md` § CI also states the
meaning of an exit code of 2.

The artifacts are the raw rpc stdout and stderr streams of the pi runs. They live
under the scratch directory, which the header names `lab`. The harness removes
that directory after a clean run. It **keeps** the directory, and prints the
path, when a check failed **and** a pi run happened. A static-only failure of
`T4` or `T5` keeps nothing, because the directory holds no relevant stream. A
run whose pi wrote nothing still keeps the directory, because the gate is the pi
run and not its output. The scratch directory must sit outside the checkout:
when `TMPDIR` points into the checkout, the harness refuses the run, because pi
must write nothing there.

A failing run also **prints those streams to its own stdout**, because a CI job
deletes its scratch directory and the path then names a directory that nobody can
open. The same two conditions gate the output: a check failed, and a pi run
happened. A clean run therefore prints nothing extra, and a static-only failure prints no
empty section. The harness prints one delimited section for each stream of each
run that started. It prints stderr before stdout, because pi's
diagnostics and the canary line go to stderr. Each section names its
run, and the `artifacts:` pointer still follows for a local run:

```
rpc streams below, inlined because a CI scratch directory does not outlive the
job — the artifacts path at the end is only reachable on the machine that ran.
---- run2 (the trusted config run, -a) stderr — 136 bytes ----
CI-CANARY {"tools":[…],"cwd":"…","trusted":true}
---- end run2 (the trusted config run, -a) stderr ----
---- run2 (the trusted config run, -a) stdout — 982 bytes ----
{"type":"extension_ui_request",…,"method":"notify","message":"slate: ignoring …"}
---- end run2 (the trusted config run, -a) stdout ----
---- run3 (the trusted local-package run, -a) stderr — 136 bytes ----
CI-CANARY {"tools":[…],"cwd":"…","trusted":true}
---- end run3 (the trusted local-package run, -a) stderr ----
artifacts: /tmp/slate-loadcheck.5eHaps (raw rpc streams, kept because a check failed)
```

The output has a bound, so a pathological run cannot flood the log. The harness
cuts each stream at **20000 bytes** (`STREAM_CAP`). It cuts at the last line
boundary when that boundary lies past half of the cap. The header of a section
that lost bytes states the real size, the size after the cut, and the cap, so
nobody reads a cut stream as a whole one. Each stream body contributes at most 20,000 bytes. Each fixed section header,
truncation note, and footer fits within 512 bytes. Six retained sections therefore
contribute at most `6 × (20,000 + 512) = 123,072` bytes. The introductory lines
and final artifact path sit outside that stream-section bound.

A stream of 0 bytes gives one header with `— 0 bytes (empty)` and no body, and a
stream that the harness cannot read gives `unavailable` with the reason. The
harness replaces each C0 control character other than tab and newline with `?`,
because the output goes into a log, and the harness promises no ANSI anywhere.
The copy in the artifacts directory keeps the original bytes. A real
cut, from a run whose pi wrote 39900 bytes to stderr, looks like this:

```
---- run1 (the untrusted load run) stderr — 39900 bytes, TRUNCATED to the first 19949 (cap 20000 bytes per stream; the whole stream is in the artifacts directory) ----
```

One directory in the checkout belongs to pi, and not to this harness. pi takes a
lock on `.pi/settings.json` while it reads that file. The lock is a transient
`.pi/settings.json.lock` **directory inside the working tree**, and pi creates it
and removes it around every access. A bare `pi --no-extensions --mode rpc` with
no extension does the same. The harness removes the lock at the end of a run only
when the lock was absent at the start, because a lock from the start belongs to
another live session, and a removal would corrupt the write of that session.
`.gitignore` covers `.pi/*.lock` for the case where a signal kills the harness, or
the live main-worktree session, before any cleanup runs.

## What it covers

The harness runs 14 checks. `L1`–`L8` cover the untrusted load path, `T1`–`T3`
cover the trusted config path, and `T6` covers the trusted local-package path.
`T4` and `T5` need no pi process: either static-only selection starts no session,
but still runs the version probe that resolves the CLI.

| id | what it proves |
| --- | --- |
| `L1` | pi **exited 0** and loaded the checkout (rpc, offline, empty agent dir, no credentials). This is a real signal on pi 0.83.0, where most load failures exit 1 |
| `L2` | stderr holds **neither** `Failed to load extension` **nor** `Extension error (`. The check reads both markers, because the first is the channel for a reported load failure and the second is the channel for a hook, which the first misses. Its own verdict line names the two markers and reproduces neither, so a grep of a CI log for either literal finds no line from a run that passed |
| `L3` | **stdout** holds no `extension_error` event, which is the only signal from a hook that throws in rpc mode |
| `L4` | the canary saw all three dispatch tools: `thread`, `threads` and `episode`. Nothing else detects their removal |
| `L5` | the canary reported a **non-empty** tool list, and it named the place. This check stops `L4` from a pass when the canary never loaded, or when `session_start` runs before the registration |
| `L6` | pi registered the `/slate` command **and attributed it to a path inside the checkout under test**, which proves that the run used the working tree and not an installed release |
| `L7` | `/slate on` completes through the command handler offline: the prompt response succeeded, the handler appended a `slate-state` entry, and the widget holds lines |
| `L8` | the run left `.pi/npm` in the checkout unchanged, so the run stayed offline and npm-installed nothing into the working tree |
| `T1` | pi exited 0 on the trusted (`-a`) run, **and** the `trusted` field of the canary reads `true` (the `canary-trusted` query of the driver). This check protects `T2`: without trust slate reads no `.pi/slate.json`, and a clean `T2` then means nothing |
| `T2` | slate's config sanitizers emitted **no warning** for the tracked `.pi/slate.json` of this checkout. That result is the whole claim: sanitizers warn for three keys only (`modelFailover`, `contextBudget` and `workerExtensions`), so a clean `T2` excludes a warning and nothing else |
| `T3` | the trusted run also left `.pi/npm` unchanged, so `PI_OFFLINE` held where `-a` would otherwise install |
| `T4` | the project config file **parses as JSON and holds a plain object at the top level**. node reads the file directly from disk. The check PASSES when the file is absent, because a project config is optional for a consumer |
| `T5` | the tracked `.pi/settings.json` contains exactly one package entry that resolves to this repository and identifies its `ytdb-slate` manifest. String and object forms are accepted. Unrelated packages are ignored. Every literal `pi.extensions` entry exists |
| `T6` | a trusted scratch project loads a reduced slate package through an entry spelled `"../"`, registers all three slate tools, exposes one `/slate` command from that package, and exits without a duplicate-load conflict |

`T4` exists because `T2` cannot cover the syntax of the file. slate's
`loadConfig()` wraps the read and the `JSON.parse` in a `try`/`catch`, and it
accepts a non-null, non-array object only. For every other input it returns `{}`,
and the session continues on the defaults with **no output at all**: no warning,
no error and no event. A checkout whose `.pi/slate.json` holds `{{{` therefore
looks healthy to every check that reads pi's output, while slate drops every
setting in the file, `workflow.draftPRs` included. A direct read of the file is
the only way to see that state, and it needs no pi, no session and no trust.

`T5` applies the same direct-read rule to `.pi/settings.json`. A missing or
unparseable file is a FAIL, because this checkout requires its tracked local
package entry. `T5` accepts a string source or an object with a string `source` field.
It resolves local entries and identifies slate by repository location or manifest
name. An unrelated local package does not become a slate candidate. The selected
target must have the same real path as the repository under test. `T5` also
rejects a registry slate entry and a missing literal extension entry. `T6` then
proves the literal `"../"` spelling through pi itself. Both checks report FAIL
rather than NOT RUN for a defect.

When the user-scope settings file may name this package, the harness prints one
fixed `NOTE` after the context block. It reads at most the first 1 MiB as raw text
and performs a case-insensitive package-name substring test. A raw read covers
string entries, object entries, bare names, file URLs and Git URLs without
parsing their shapes. Missing, unreadable, invalid, directory-shaped, binary and
enormous files remain fail-soft. The note never changes the verdict.

The note contains zero variable content. It prints no settings path, package
name, source text, identity, count, query, fragment, credential or object field.
Fixed wording tells the reader to inspect the settings file inside the agent
directory currently in effect. The substring test can fire when pi would dedupe
the entries or when no real conflict exists. This false positive is deliberate.
Three attempts to mirror pi package identity rules diverged from pi in both
directions. The harness therefore reports a possibility instead of making a
second identity verdict.

The canary tool list comes from pi's name-keyed tool map. That map cannot expose
a duplicate registration count. `T6` therefore uses the tool list only to prove
that all three names exist. Pi rejects a duplicate slate load with a tool conflict
and exits 1. The exit-code and conflict assertions cover that failure.

`T5` cannot prove that pi loads or registers the package. `T6` cannot validate
other package entries in the tracked settings file, because its scratch settings
contain only slate. Neither check executes a dispatch tool or validates TUI
presentation.

Re-run the load check after a change to `.pi/settings.json`, `.pi/slate.json`,
`package.json`, `verification/ci-canary.ts`, or any file under `extension/` or
`docs/`. These are the tracked inputs that the load-check rungs read, validate,
load, or copy. Re-run it
after a change to T5, T6, the help block, or their fixture and identity-note
helpers in `run-load-check.sh`.

One gap remains, and this document states it plainly. `T2` and `T4` together
cover the syntax of the file, its top-level shape, and the *shapes* of three
keys. **An unknown key, and a wrong-typed value under a key without a sanitizer,
pass both checks in silence**. `{"totallyUnknownKey": 5, "maxConcurrent": "lots"}`
gives a pass for `T4` and a pass for `T2`. No check in CI validates the
content of the config, and the reader of `README.md` § Configuration still
carries that duty.

The harness proves no dispatch behaviour. No check here executes a tool, starts
a worker session, or exercises failover or handoff. The harness performs loads,
registration checks, one command round trip, and two direct file reads. It is also no
typecheck; `npm run typecheck` is that check, because jiti transpiles each module
and erases the types, so a type error loads correctly. All three pi runs use rpc mode,
so no result here describes the TUI. Those subjects need the ladder, the resolver
checks, or the manual isolated-load smoke test (`pi --no-extensions -e .`, see
`AGENTS.md`).

## Files

| file | role |
| --- | --- |
| `run-load-check.sh` | the driver: it resolves the pi CLI, matches the pin, runs the scrubbed offline rpc runs, parses the streams, reads both tracked settings files, observes user-scope identity conflicts, builds the reduced package copy, and holds every assertion |
| `ci-canary.ts` | the positive control: a `session_start` hook that prints the registered tool set, the cwd and the trust state to stderr, and asserts nothing |

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`). No module in
`extension/` imports the canary, and the canary reaches a session only because
this harness passes it to pi with a second `-e`.

# Package-content check — `package-content-check.mjs`

The package-content check guards the publish boundary that runtime path resolution
cannot test. Run it from any checkout:

```sh
node verification/package-content-check.mjs --repo .
node verification/package-content-check.mjs --repo . --self-test
```

The normal check runs `npm pack --dry-run --json --ignore-scripts`. It derives
every exported extension command and document path from `extension/paths.ts`.
It recursively enumerates every Markdown file under `docs/`. It also recursively
enumerates `.mjs` files under `extension/` whose first line is exactly
`#!/usr/bin/env node`. That shebang is the objective runtime-command criterion.

A helper `.mjs` file without it needs no command export. Each document and
command must have exactly one export. Every exported runtime path must also
appear in the publish file list. The check still parses `extension/mode.ts` and
validates its named path imports.

The self-test uses temporary fixtures outside the checkout. It proves recursive
discovery of a nested shebang command and exclusion of a non-command helper. It
also proves missing command export, missing document export, and missing packed
runtime file findings. Two isolated subprocesses prove that `--help` works
without TypeScript and real analysis refuses a missing TypeScript dependency
with exit 2.

Exit 0 means all checks passed. Exit 1 means a roster mismatch, a missing packed
file, or an escaped self-test mutation. Exit 2 means a bad invocation, missing
tool, parse failure, or failed precondition. Argument help is parsed before the
optional TypeScript analyzer loads.

Run both commands after adding, moving, or deleting a Markdown file under
`docs/`, a shebang-bearing `.mjs` command anywhere under `extension/`, or a
runtime path export. Run them after
a `files` whitelist change or a path import change in `extension/mode.ts`. Run
them before release. The resolver checks still cover doctrine content and
rendering.

It **overlaps the packaging guards above**, and the overlap is not yet
consolidated. That harness derives its doctrine-doc set by scanning every
`extension/*.ts` for a `*.md` literal joined onto the docs directory; this check
reads the exported constants of `extension/paths.ts` instead. It also covers an
export that no module currently imports. Its recursive shebang roster requires
both shipped commands, while the guards only permit their `.mjs` file kind. Run
both until one absorbs the other.

The package-content self-test is separate from the packaging guard self-test.
Run both because they derive different rosters and detect different omissions.

# The writing checker — `extension/writing-check.mjs`

The writing checker is a dictionary-free STE proxy: it reports surface facts
about prose and claims no ASD-STE100 conformance. It is plain Node with no
dependencies, so one file is both a library and a command, and neither pi nor
TypeScript is reachable from it.

Two callers, with different bounds:

| caller | what it reads | the bound applied before the checker runs |
| --- | --- | --- |
| the `turn_end` hook in `extension/mode.ts`, through `measureWritingTurn` in `extension/writing.ts` | the completed assistant message of one turn, for the human-only `writing n/m` status line | `WRITING_TURN_MAX_BYTES` — 16 KiB of assistant text. A larger message is never handed to the checker, and the status line says it was skipped |
| the command — `--input records.jsonl`, `--file PATH …`, `--diff changes.diff` | whole files, JSONL records, or the added prose lines of a unified diff | the module's own `MAX_INPUT_BYTES` — 1 MiB per record and per run |

The hook is why the module's wall clock matters at all: it runs synchronously
inside `turn_end`, so time spent in the checker is time the TUI is frozen. The
16 KiB bound exists for that reason and is the reason the module's slowest legal
input is a command-line concern rather than a hook concern.

Three nets watch it, and they see different failures:

| net | file | what it can see |
| --- | --- | --- |
| correctness suite | `verification/writing-check-tests.mjs` | whether a finding is RIGHT: the rules, source offsets, the caps, report and file-input safety, command modes, and the five hand-written scanners against the regexes they replaced. Under a second, machine-independent |
| scaling gate | `verification/writing-check-scaling.mjs` | whether anything in the module GROWS faster than linearly, and whether the output caps hold at the input cap. A wall-clock gate, ~18 s |
| pure-resolver checks | `verification/resolver-checks.mjs`, the `writing-*` families | the WIRING around it: the status line's states and visibility gates, the config sanitizer, the doctrine rule, and the command's spawned modes. Documented above, in § Pure-resolver checks |

A correct but quadratic module passes the first and fails the second; a fast
module that reports the wrong offset does the reverse. **Run all three after any
change to `extension/writing-check.mjs`**, and the resolver suite as well after
any change to `extension/writing.ts` or the status wiring in `extension/mode.ts`.

## Correctness suite — `writing-check-tests.mjs`

```sh
node verification/writing-check-tests.mjs      # under a second
```

One `ok N - <name>` line per test, a `not ok` line plus the observed stack for a
failure, the roster audit last, then the summary. Exit **0** every test passed ·
**1** a test failed or the roster did not reconcile.

### The roster, and why no count is written here

The suite is **fail-soft**. Each `test()` call catches its own failure, prints
the stack, and lets every later test run. A failing test still exits nonzero.
Fail-fast hid results: one early failure used to mask every later verdict.

An independent `EXPECTED` roster audits the reported test names after the last
test. It fails when a name is missing, duplicated or unexpected, and when the
verdict counters do not equal the reported-name count. Deleting a test,
duplicating an id, or crashing one test therefore cannot make an eroded or
partial run look clean — before the roster, deleting a test exited 0.

`EXPECTED` is an enforcement mechanism, not documentation. Any test added,
renamed or removed must update it, so treat a roster failure as an unlisted
rename before treating it as a harness bug.

The roster audit is itself one result line and is deliberately not in `EXPECTED`
— it cannot list itself, because the audit is computed before it reports. The
summary publishes the computed identity:

```
RESULT_LINES = EXPECTED_TESTS + this roster audit
```

If the identity does not hold, the summary prints the residual and points at the
roster line. **The suite output is the definition of record. Do not copy its
test count, or any test number, into this document** — both have been
transcribed here before and both went stale.

### What it covers

- **Every rule, positively and negatively.** `SENT20`, `SENT25`, `PARA6`,
  `SEMICOLON`, `CONTRACTION`, `PARENTHETICAL_PAREN`, `PARENTHETICAL_DASH`,
  `SLASHED`, `PASSIVE`, `INGFORM`, `NOUNCLUSTER` and `MULTICMD` each have a case
  that fires and a case that must stay silent, and no sentence produces both
  length levels.
- **The class boundary.** House-style and advisory findings never enter the
  fail count, and the fixed `NOT CHECKED` list is non-empty with a reason per
  item.
- **The normalizer's exclusions.** Fenced and indented code, git-diff lines,
  timestamped log lines, URLs, HTML comments and inline code produce no findings
  and keep the source length, so offsets stay meaningful.
- **Sentence segmentation.** Abbreviations, decimals, version numbers, paths,
  ellipses and terminal punctuation inside quotes or parentheses.
- **Source offsets** (BG2) — see below.
- **Report and file-input safety** (SC4, SC5, SC9, SC6) — see below.
- **The caps**, at every enforcement point — see § Caps and bounds.
- **Command modes and the CLI.** JSONL, direct-file and unified-diff modes,
  byte-identical output for repeated input, a symlinked invocation, and the
  errors for refused inputs.
- **Scanner equivalence.** Each of the five hand-written scanners is pinned
  against the exact regex it replaced, plus a mixed document where whole-record
  output must stay identical. For `scanLogLines` exact means JavaScript
  multiline semantics across LF, CR, U+2028 and U+2029, not LF-only lines (FX1).
- **The aggregate.** It reuses the analysis `checkRecord` already produced (CQ3)
  and reports exact distribution values, not merely numbers of the right type.
- **Turn outcomes** (FX2), including one source scan of `extension/mode.ts`.

## Scaling gate — `writing-check-scaling.mjs`

One property of one module: **nothing in `extension/writing-check.mjs` may grow
faster than linearly.**

### Why it exists

Three independent reviews of the shipped checker found **six** separate
superlinear paths in that one module (SC1 ×4 in `normalizeMarkdown`, SC2 in the
path-exclusion pattern, BG1/PF1 in the quoted-dash rescan). Every one of them
was *correct*: the findings were right, so `writing-check-tests.mjs` stayed
green, `run-resolver-checks.sh` stayed green, and a legal 1 MiB message still
took **50–186 seconds** — synchronously, inside the `turn_end` hook, which is to
say with the TUI frozen.

That is the same silent-failure shape as everything else in this directory, and
it needs the same treatment: a check that fails when the property is lost rather
than when the output is wrong. Six offenders in one module also means the *class*
is the problem — the module holds dozens more regexes nobody had shown to be
linear — so this gate covers all of them and refuses to let a new one in
unclassified.

### Running it

```sh
node verification/writing-check-scaling.mjs           # ~18 s
node verification/writing-check-scaling.mjs --quick   # smaller sizes, looser budget
```

Exit **0** all checks passed · **1** a check failed · **2** refused to start. No
arguments needed and nothing is written anywhere; it imports the module directly
(plain `.mjs`, so no jiti) and generates its own inputs.

**Re-run it after any change to `extension/writing-check.mjs`** — in particular
after adding or editing a regex, which is the change that reintroduces the class.
It is a separate file from `writing-check-tests.mjs` on purpose: that suite is a
sub-second, machine-independent correctness net, while this one is a wall-clock
gate that takes ~18 s, and folding a timing assertion into the correctness suite
would make the correctness suite read as machine-dependent.

### What it covers

| id | what it proves |
| --- | --- |
| `roster` | every regex literal in the module, **extracted from its source**, is named in the coverage table — either with a hostile generator or with a written reason it cannot scale ("applied to one character", "applied to one already-bounded token"). This is the part that makes the net permanent: a newly added regex FAILS this check by name until someone classifies it, so the table cannot quietly fall behind the code. It also fails on a *stale* entry, so a deleted pattern does not leave dead coverage behind. The check's own line reports how many literals it found |
| `regex-scaling` | every scanning regex runs its hostile generator at four doubling sizes and at the module's own `MAX_INPUT_BYTES`, and must clear both rules below |
| `pass-scaling` | the same two rules for every exported pass and every end-to-end shape the reviews filed. The direct `blockOffset` subject uses an evenly spaced lookup grid to catch linear walks inside the exported helper. Two `checkText` subjects cluster findings at opposite ends of mapped paragraphs, so the real finding cap and the translation in `add()` are also exercised (GT1/GT7) |
| `canary` | the html-comment pattern **exactly as it shipped before the fix**, on the input that stalled it, must still be judged superlinear by these very thresholds. A timing gate that has stopped discriminating — a faster machine, an edited threshold, an engine optimisation — is otherwise indistinguishable from a clean run |
| `cap-output` / `cap-stripped` | **SC7** — a 1 MiB input reports at most `MAX_BLOCK_DETAILS` block details and `MAX_STRIPPED` stripped spans, says how many it dropped, keeps `blocks` exact, and stays under 4 MB of JSON. Before the cap that input produced **62,066,044 bytes** of stdout |
| `cap-run-findings` | **FX3** — a many-record `run()` applies the equal per-record allowance, reports every truncated record, and keeps the reported total inside `MAX_TOTAL_FINDINGS`. A per-record-only mutant reports too many findings and fails this check |

Two rules decide every subject:

- **Budget.** The hostile input at `MAX_INPUT_BYTES` must finish inside
  `BUDGET_MS` (1200 ms). This is the property that actually protects the hook,
  and it is an absolute rather than a ratio because the margin is enormous: on
  the reference machine every honest subject finishes at or under about 400 ms
  at the input cap — the slowest is the PR1 mapped-findings shape — where the
  defective forms measured 50,000–186,000 ms. That is roughly 3× headroom over
  honest work and two to three orders of magnitude over any real defect.
- **Growth.** A doubling must not quadruple the cost, measured across a factor-8
  span (linear ≈ 8×, quadratic ≈ 64×, threshold 24×). Enforced wherever the
  signal clears a 4 ms noise floor; below it the budget rule still binds and the
  output line says which rule decided, so nothing is left silently unguarded.

A failing subject prints its own measured times, so the figures of record are
the run's, not these.

### Why a wall-clock gate here is not flaky

Because it is deliberately loose everywhere it can afford to be. Timings are
**min-of-3**, not mean — scheduler noise is one-sided, so the minimum is the
stable estimator. The growth threshold sits at 3× the ideal. The budget carries
the headroom stated above over the slowest honest subject and two to three
**orders of magnitude** over any real defect. Inputs are fixed generators;
nothing is random. A machine three times slower than the reference still passes
every linear subject.

### Failing fast

Nothing can interrupt a running regex in-process, so every subject is escalated
from an 8 KiB probe upwards and abandoned the moment it breaks a ceiling scaled
to the size in hand. Without that the gate inherits the very cost it exists to
reject — reinstating the old inline-code pattern made this file run for over
**400 seconds** before saying anything, which in practice reads as a hung suite
rather than as a failure. With it, every mutation below reports in about 18 s. A
failure line names the generator and the size it was abandoned at.

### Teeth

The mutations below each revert one fix or defeat one rule. Each scratch copy
was caught in one gate run:

| mutation | caught by |
| --- | --- |
| revert the `html-comment` regex (SC1) | `roster` naming the pattern, **and** `pass-scaling` |
| revert the `autolink` regex (SC1) | `roster` naming the pattern, **and** `pass-scaling` |
| revert the `inline-code` regex (SC1) | `roster` naming the pattern, **and** `pass-scaling` abandoning `repro-ticks` at 8 KiB |
| revert the `log-line` regex (SC1) | `roster` naming the pattern, **and** `pass-scaling` abandoning `repro-logblank` at 64 KiB |
| revert the path-exclusion regex (SC2) | `roster` naming the pattern, **and** `pass-scaling` abandoning `repro-path` at 8 KiB |
| reinstate the per-candidate quoted-dash rescan (BG1/PF1) | `pass-scaling` **only** — the regex literals are unchanged, so this one is invisible to the roster and proves the timing rules catch an *algorithmic* regression, not just a pattern swap |
| replace `blockOffset`'s binary search with a forward, reverse or nearer-end linear scan (PR1/GT1) | `pass-scaling` on `pass:blockOffset/mapped-offset-grid`; this direct subject isolates the exported helper and uses a deliberately high lookup volume |
| inline a forward or reverse segment walk at `checkRecord`'s `add()` translation site (GT7) | `pass-scaling` on `repro-mapped-findings-tail` or `repro-mapped-findings-head`; these end-to-end subjects keep the production finding cap and prove that `checkText` builds and uses a mapped block |
| remove the whole-run finding allowance (FX3) | `cap-run-findings` |
| remove the `MAX_STRIPPED` / `MAX_BLOCK_DETAILS` caps (SC7) | `cap-stripped` and `cap-output` |
| add a new, unclassified regex to the module | `roster`, naming the new literal |
| widen `GROWTH_LIMIT` until it stops discriminating | `canary` |

The last two are the ones that matter for the net's own durability: the roster
catches coverage rot, and the canary catches the gate going blind.

The three mapped-offset subjects are complementary. The grid makes direction
irrelevant only for calls that still route through exported `blockOffset`; its
power also comes from doing more lookups than the production finding cap allows.
It cannot prove that `checkText` still uses the helper or that translation code
inlined at `add()` stays logarithmic. The head- and tail-clustered subjects keep
the real pipeline and make a full-map walk expensive at realistic lookup volume.
Neither cluster catches both directions alone. Keep all five mutants — three in
`blockOffset`, two at `add()` — as the acceptance test for any runtime reduction.

### What it does NOT cover

Apart from the explicit output-cap checks, this gate measures growth. It says
nothing about whether a finding is *right* — that is `writing-check-tests.mjs`.
It also does not bound **memory**.

The shape that makes both limits concrete is the one PF2 filed: 1 MiB of many
short blocks (`A.\n\n` repeated). The gate times `makeBlocks` on it and runs the
whole of `checkText` on it once, in `cap-output`, without a clock. Measured end
to end on the reference machine, that whole pass takes about **1.0–1.1 s** and
peaks around **450 MB** of RSS. It is linear and it is inside the 1200 ms
budget, but it is no longer "sub-second", so do not describe it that way. The
finding stays ACCEPTED and the reasoning behind that does not depend on the
tenth of a second: an input that size is reachable only from the command line,
because the turn hook stops at `WRITING_TURN_MAX_BYTES` — at 16 KiB the same
shape takes about **14 ms**.

## Caps and bounds

| cap | enforcement points | checks |
| --- | --- | --- |
| `MAX_INPUT_BYTES` (1 MiB) | each record, combined `run` input, unified-diff text, pre-open file size, post-open file size, and growth past the opened size | `MAX_INPUT_BYTES …` (three checks), `pre-read size refusal …`, `post-open size refusal …`, `bounded reads …`. The fail-open path, when a caller hands the checker an oversized message, is `writing measurement fails open on the checker byte cap` here and `writing-status-cap-skip` in the resolver suite |
| `MAX_RECORDS` (10000) | `run`, JSONL parsing, direct-file arguments and emitted diff records | `MAX_RECORDS rejects …` |
| `MAX_FINDINGS` (1000 per record) | finding insertion and omission counters | `MAX_FINDINGS caps …`, `BG6 finding caps …` |
| `MAX_TOTAL_FINDINGS` (20000 per run) | the equal per-record allowance `run` derives from the record count (FX3) | `FX3 the run budget …`, `FX3 a small run …`, and the scaling gate's `cap-run-findings` |
| `MAX_STRIPPED` (5000) | reported stripped-span list | `stripped spans are capped …`, `stripped spans below the cap …`, and the gate's `cap-stripped` |
| `MAX_BLOCK_DETAILS` (5000) | reported block-detail list | `block details are capped …`, `block details below the cap …`, and the gate's `cap-output` |
| `MAX_EXCERPT_CHARS` (2000, frame included) | head-and-tail excerpt elision | `excerpt cap includes …` |
| `WRITING_TURN_MAX_BYTES` (16 KiB) | `extension/mode.ts` rejects a turn before loading or calling the checker. This limit is outside `writing-check.mjs` | the resolver check `writing-status-cap-visible`, and only that one. `writing-status-cap-skip` belongs to the first row: it calls `measureWritingTurn` with `MAX_INPUT_BYTES + 1` bytes, so it exercises the checker's own cap. A crossed mutation proved the split — this table used to credit both checks to this row, which would send a maintainer to the wrong mechanism after a failure |

The file tests distinguish all three read stages. The pre-read check replaces
`openSync` and proves an oversized file is never opened. The post-open check
fakes a stale small `lstat` result. The growth check fakes an opened size smaller
than the bytes read.

## Decisions the module records

### Source offsets (BG2)

A paragraph's block text is its lines **trimmed and joined with one space**, so
past the first line a block position is not a source position: the indent, the
trailing spaces and the newline are gone. Every rule reported
`block.start + blockIndex`, so every offset on a multi-line paragraph pointed at
the wrong character. Over this repository's own Markdown that was roughly a
quarter of all findings — a fraction, not an edge case. The exact number moves
with the documents, so re-derive it by disabling the map rather than trusting a
figure written here.

Two smaller sites of the same class sat beside it. Non-paragraph blocks were
positioned with `indexOf(content)`, which finds an *earlier* copy of the content
when one exists; the marker strip is what makes that reachable, so the divergence
needs punctuation-only content. `>>` strips to `>`, which is at source offset 1
while `indexOf` reports 0; `# #` strips to `#`, which is at 2 while `indexOf`
reports 0. (An earlier version of this note used `> > x`. That example is wrong:
it strips to `> x`, which `indexOf` correctly locates at 2.) The second trim
after a marker was not counted at all.

The text is deliberately unchanged — a sentence split across two source lines
must still segment as one sentence — so the block carries a **segment map**
instead, and `blockOffset` translates block positions to source positions once,
inside `add`.

The reviewer's finding (TQ3) was that the paragraph-join mutation **survived
both suites untouched**: nothing anywhere asserted a source offset. These checks
assert exact numbers, so it cannot survive again.

| id | what it proves |
| --- | --- |
| `BG2 semicolon on a continuation line …` | the exact source offset of a finding on line 2 of a paragraph (25, not the block index 22), and that the character there is `;` |
| `BG2 a finding on the third line …` | offsets after **two** joins, so a map that only corrects the first continuation line fails |
| `BG2 a span crossing a line break …` | a range that spans the join covers the source newline: the reported slice is `(which\nis near it)` |
| `BG2 a list item indented after its marker …` | the marker-lead correction — `blockDetails[0].start` is the text, not the whitespace before it |
| `BG2 every block is a verbatim run …` | the root invariant: a block with no map IS the normalized source at `block.start`, and every segment of a mapped block is verbatim. Carries a non-vacuity term, since a fixture with no joined paragraph would prove nothing |
| `BG2 every finding … selects what its rule matched` | property check over a multi-line document: each finding's source slice has its own rule's shape (a `SEMICOLON` really selects `;`). Fails if fewer than five findings were checkable, so the fixture cannot silently stop exercising the rules |

| mutation | caught by |
| --- | --- |
| reinstate the join with no offset map (the reviewer's own mutation) | `BG2 semicolon on a continuation line` — offset 22, want 25 |
| keep the map but make `blockOffset` ignore it | same check, same numbers — the map has to be *consulted*, not merely built |
| revert the marker-lead correction to `indexOf(content)` | `BG2 every block is a verbatim run` — got `'   deeper; t'`, want `'deeper; text'` |

### Report and file-input safety (SC4/SC5/SC9/SC6)

Every value interpolated by `formatText` is enumerated at its finding-line call
site:

- `r.id` is attacker-controlled through JSONL `id`, a unified-diff `+++` label,
  or a direct-file path. `sanitizeReportId` strips Unicode control/format/line
  categories, collapses whitespace, encodes every character outside a narrow id
  alphabet, and reserves `ALL_CLEAR` plus the report's structural first words.
  Safe ids are unchanged, so ordinary reports do not churn.
- `f.excerpt` is attacker-controlled source prose. It goes through the category
  sanitizer and is framed as `⟦…⟧`; source occurrences of those two reserved
  delimiters are removed first, so the frame is unambiguous in JSON and text.
- `f.id` / `f.class` come from the closed `RULES` table. Block, sentence and
  offsets are generated integers. The summary, distribution, rule and
  `NOT_CHECKED` lines contain only checker-owned literals, closed rule data,
  fixed reasons, and computed numbers. No other source text reaches the report.

The category sanitizer follows `mode.ts`'s `cell()` rule: strip `Cc`, `Cf`, `Zl`,
`Zp` and `Cs`, which covers ESC/BEL/BS, bidi overrides, Unicode separators and
lone surrogates. It is repeated locally rather than imported because this file
must stay a plain-Node command with zero dependencies; importing `mode.ts` would
pull TypeScript and the pi SDK into it. `cell()` also strips `|` for its table
grammar. A writing report has no pipe grammar, so that one grammar-specific
character is not part of this sanitizer; the Unicode safety categories are the
same in intent.

Each excerpt is at most **2000 characters, including its two framing
characters**. Longer excerpts keep equal-sized head and tail sections with a
`[middle elided]` marker, which keeps the opening and the conclusion of
whole-unit SENT20, SENT25 and PARA6 findings. The limit was set above the longest
excerpt in the measured repository and assistant-message corpora (1640
characters). The number of findings is bounded separately — see § The run budget.

**Nonblocking open.** `O_NOFOLLOW` rejects a path that is already a symlink, but
it does not close the `lstat`→`open` race. If the path becomes a FIFO during that
window, blocking `O_RDONLY` waits forever before `fstat` can reject it. The open
flags therefore include `O_NONBLOCK`: a swapped FIFO opens without waiting, then
`fstat` rejects the non-regular descriptor. Regular files still read normally.

The SC6 check asserts the **mechanism** (`O_NONBLOCK` and `O_NOFOLLOW` are both in
the exported flags) and reads a legitimate regular file through the same path.
It does not race a scheduler: the review reproduced only 2 hangs in 60 trials,
so a race test would intermittently pass with the defect present and would be
worse than no test.

| id | what it proves | mutation |
| --- | --- | --- |
| `SC4 hostile ids …` | JSONL id, diff label and newline-bearing filename cannot create control bytes, `ALL_CLEAR`, a fake summary, or a second finding line | storing the raw `record.id` fails this check |
| `SC5 excerpts …` | ESC, BEL, BS and U+202E are absent from the in-memory/JSON excerpt and text report | restoring whitespace-only collapse fails this check |
| `SC9 excerpt framing …` | exactly one reserved opener and closer frame each excerpt in JSON and text; hostile source delimiters cannot become frame delimiters | returning clean but unframed text fails this check |
| `SC6 regular-file opens …` | the actual open flags cannot block on a FIFO and a normal file still reads | removing `O_NONBLOCK` fails this check |
| `excerpt cap includes …` | the frame counts toward 2000; the head, marker and tail all remain | remove the elision block |

Each mutation ran against a scratch copy and named only its intended check. The
scaling roster also caught the four report-safety regex literals and refused to
pass until each was classified.

### Diff mode and the CLI (BG4/BG7/BG8/FX4)

Diff mode includes `.md`, `.markdown`, `.mdx`, `.txt`, `.rst`, `.adoc` and
`.asciidoc` files. It also includes extensionless `README`, `CHANGELOG`,
`CHANGES`, `CONTRIBUTING` and `RELEASE_NOTES` files, without case sensitivity.
This closed list excludes source files. Markdown fenced code remains in the
selected file and the existing Markdown normalizer removes it, so the file filter
does not duplicate content parsing.

The unified-diff parser tracks both hunk counts. An invalid header, an unknown
hunk-line prefix, or an early end throws an error with its line number, and it
never returns the partial hunk. A hunk that promises two old and three new lines
but ends after one context and one addition reports `final hunk ended early (1
old and 1 new lines missing)` (BG7). The CLI main-module check compares real
paths, so a symlink invocation runs the command (BG8).

**FX4 — decode once, then classify and report.** Git's default `core.quotePath`
syntax is a C string. `decodeGitPath` decodes it before the `b/` prefix is
removed, and the same decoded value then drives `isProseDiffPath`, record `path`,
record `id` and the sanitized report id. That avoids both failure modes: silently
dropping a prose file during classification, and finding it under a raw encoded
label during reporting.

| Git path case | result |
| --- | --- |
| `"b/d\\303\\263c.md"` | `dóc.md`, included |
| `"b/tab\\tname.md"` | a literal tab in `tab<TAB>name.md`, included |
| `b/space name.md` | unchanged, included |
| `"b/quote\\"name.md"` | a literal quote in the decoded path, included |
| `"b/slash\\\\name.md"` | a literal backslash in the decoded path, included |
| `"b/code\\303\\263.ts"` | `codeó.ts`, correctly excluded as non-prose |

Unsupported escapes and an unterminated quote throw a malformed-path error,
because the input is not the unified diff it claims to be. Invalid UTF-8 is a
file-local failure instead: the parser consumes that file's hunks but emits no
records for it, then continues with later files. The returned records carry
non-enumerable skip metadata that `run()` copies to `skippedDiffFiles` in the
aggregate when it is non-empty. JSON therefore reports the labels, lines and
reasons. Text output puts a `DIFF FILES SKIPPED:` block directly after the
summary and before rule or finding lines. The encoded label is sanitized before
it reaches either report.

| id | what it proves | mutation |
| --- | --- | --- |
| `BG4 unified diff mode …` | Markdown is checked, TypeScript is excluded, and fenced code remains excluded | force every diff path to be prose |
| `BG7 malformed hunk …` | malformed content and headers throw with line numbers | restore the silent `inHunk = false` branch |
| `BG7 an incomplete final hunk …` | a truncated final hunk is rejected, naming the missing line counts | remove the final incomplete-hunk guard |
| `BG8 CLI runs …` | a symlinked checker executes and emits JSON | restore the URL/path string comparison |
| `FX4 Git C-quoted paths …` | the decoded path drives classification AND reporting | classify and report the raw Git label |
| `GT3 diff mode reports …` | invalid UTF-8 skips only its file and is prominent in library, JSON and text results; malformed quoting and unsupported escapes remain hard errors | restore whole-diff abort, or skip every decode failure |

The two surrogate-boundary regexes and the revised hunk-header regex are
classified in the scaling roster. The Git-path decoder added no regex literal,
so the roster needed no new name for it.

### One analysis pipeline (CQ3/CQ4)

`checkRecord` collects sentence lengths and paragraph sentence counts while it
tokenizes the blocks used for findings, and attaches these arrays to the checked
result with a private, non-enumerable symbol. `aggregate` consumes them instead
of normalizing, building blocks, segmenting and tokenizing the source a second
time. The public JSON and text shapes do not change. BG2 segment maps stay on the
live blocks until findings, offsets and distributions are complete.

The check named `aggregate reuses checked analysis …` uses a text value that
counts string conversions. `run` converts it for the total byte cap and
`checkRecord` converts it once. A third conversion proves that aggregation read
the source again. Restoring that read fails the check. The same check asserts
all distribution values, not only their types.

Two dead fallback sites were removed. `split` always returns at least one item,
so the empty-lines repair in `makeBlocks` was unreachable. Every block receives
`words` and `sentences` before `blockDetails` is built, so its tokenization and
segmentation fallbacks were also unreachable.

**CQ4 and reporting.** JSONL parsing now catches only syntax and record-shape
errors. Record overflow is outside that catch and reports `JSONL exceeds the
10000-record limit`, not `Invalid JSONL`. `makeAbbreviationSet` enforces the
lowercase-only table invariant that `periodIsInternal` requires. The text-report
check pins the summary, one rule line, one fixed `NOT CHECKED` reason, the cap
notice and every generated field in a finding line; removing the finding-line
loop fails it.

### URL sentence boundaries (BG5)

The URL pattern strips candidates that start with `http://`, `https://` or
`www.`. A scheme-less domain such as `example.test` remains prose; expanding
candidate detection is outside BG5. The pattern treats a trailing `.`, `,`,
`;`, `:`, `!` or `?` as prose punctuation. Those characters remain URL data when
another URL character follows, so dotted paths and query separators still work.
This is the explicit ambiguity boundary: a literal punctuation character at the
end of a URL must be percent-encoded. Parentheses remain outside URL candidates
as before.

| case | decision |
| --- | --- |
| `https://example.test/path.` | strip through `path`; keep the period as the sentence terminator |
| `https://example.test/releases/v1.2/file.html` | keep both internal periods in the URL |
| `(https://example.test/path).` | keep both parentheses and the period as prose |
| `https://example.test/path, then` | keep the comma as prose |
| `www.example.test.` | strip the bare `www.` domain; keep the period as prose |
| `example.test.` | leave the scheme-less domain as prose; keep its period as the sentence terminator |
| `https://example.test/path?a=1;b=two` | keep the internal semicolon because URL data follows it |

The length-rule fixture has 21 words, a sentence-final URL and a five-word
second sentence. Before BG5, URL stripping swallowed the first period and made
one 26-word sentence: one `SENT25`, no `SENT20`. After BG5, segmentation returns
two sentences: one `SENT20`, no `SENT25`.

Two direct checks cover the boundary table and the length-rule effect. Restoring
the greedy `[^\s<>()]+` tail in a throwaway copy fails `BG5 URL boundaries keep
sentence punctuation and strip URL data`. The scaling roster names the revised
pattern and adds a punctuation-heavy hostile generator.

### The run budget (BG6/FX3)

Both defects came from the fix series itself. BG6 replaced a shared finding
budget with a per-record cap, because a shared budget is consumed in record order
and makes later records look clean. That removed the only bound on a whole run:
the output limit became 1000 findings times the record count. An 8000-record
JSONL file of 918,890 bytes, inside every documented cap, produced 210,730,019
bytes of stdout and 1,244,252 KB of peak RSS in 1.94 s.

Both findings hold together because the run budget is spread as an **equal
allowance**, not as a first-come budget:

```
allowance = perRecordLimit == 0 ? 0 : max(1, min(perRecordLimit, floor(MAX_TOTAL_FINDINGS / recordCount)))
```

- BG6: the allowance depends only on the record count, so it is the same in any
  record order and for any record content. No record is starved by its position,
  and a quiet record still reports everything it found.
- FX3: a run reports at most `recordCount * allowance` findings, so the total is
  bounded by `MAX_TOTAL_FINDINGS`. An explicit `maxFindings: 0` stays zero in
  both `run()` and `checkRecord()`; the visibility floor applies only to a
  positive limit (GT2).
- Loss is never quiet. Each record keeps its own `findingsTruncated` and
  `omittedFindings`, the aggregate reports the total omission count, and
  `formatText` prints an `OUTPUT BUDGET:` line **before** every rule and finding
  line whenever the budget reduced the allowance.

The budget is 20000, which is 20 times the per-record cap. Two facts fix that
value. It must be at least `MAX_RECORDS`, or the one-finding visibility floor
would exceed it and the stated budget would be false. At 20 times the per-record
cap it also leaves a 19-record run at the full per-record cap, which is this
repository's own documentation set, so the budget binds on amplification rather
than on ordinary use.

Unused allowance is deliberately not redistributed to noisier records. Doing so
would make one record's reported count depend on the other records again, which
is the property BG6 rejected.

Measured on the reviewer's shape (8000 records, 918,890 bytes, 90 findings each):

| figure | before | after |
| --- | ---: | ---: |
| JSON stdout | 210,730,019 B | 8,522,108 B |
| peak RSS | 1,244,252 KB | 148,912 KB |
| wall clock | 1.94 s | 0.24 s |
| findings reported | 720,000 | 16,000 |
| records that report the loss | 0 | 8000 |

This repository's own Markdown was byte-identical before and after the fix, both
one file per run and all files in one run: the run allowance stays at the full
per-record cap and no `OUTPUT BUDGET:` line appears.

| id | what it proves | mutation |
| --- | --- | --- |
| `FX3 the run budget …` | 500 records of 60 findings report 40 each, the total stays inside the budget, a quiet record keeps all 5 of its findings, the `OUTPUT BUDGET:` line is the second line, and reversing the record order changes no count | drop the allowance, silence the notice, or restore a first-come shared budget |
| `FX3 a small run …` | the allowance boundaries, the positive-limit visibility floor, an explicit zero limit, and a small run that keeps the whole per-record cap with no budget line | remove the positive-limit floor or raise zero to one |
| `MAX_FINDINGS caps …` / `BG6 finding caps …` | two noisy records each keep findings and report every omission | restore the shared `remaining` budget |

The scaling gate drives `run()` with many noisy records too: its
`cap-run-findings` subject asserts the equal allowance, the total bound, the
truncated-record count and a visible omission count.

### Turn outcomes (FX2)

`measureWritingTurn` returned `void` and left the counters untouched both when a
turn carried no prose and when the checker threw. `mode.ts` could only tell the
two apart by watching the counter, so it read every text-less turn as a failure:
it rendered `writing unavailable` and discarded an accumulated `writing 3/3`.
The SDK's `AssistantMessage.content` is always an array of parts, and a
tool-call-only turn, a thinking-plus-tool-call turn and an aborted or failed turn
all carry no text part. Those are the majority of turns in an orchestrator
session, so the status line was wrong most of the time.

`measureWritingTurn` returns an outcome and the hook obeys it:

| outcome | counters | status |
| --- | --- | --- |
| `measured` | move | `ready` |
| `no-text` | untouched | unchanged, so an earlier rate survives |
| `failed` | untouched | `unavailable` |

The checker result is validated before either counter moves. A throw or a
malformed `findings` value therefore returns `failed` with both counters
untouched; `failed` can never describe a partly measured turn (GT4).

CQ2's five states are unchanged. `fresh`, `skipped` and the four visibility
gates never reached this branch, a rejected import still throws into the hook's
own catch, and a throwing checker now says so through `failed` rather than
through a counter that did not move.

| id | what it proves | mutation |
| --- | --- | --- |
| `FX2 a turn with no text part …` | five real message shapes (tool call, thinking plus tool call, empty content, empty text part, non-assistant) report `no-text` and leave healthy counters at 3/1 | return `failed` for a text-less turn, or measure an empty text part |
| `FX2 array content …` | array content with a text part measures exactly like string content, and a following tool-only turn does not disturb the counters | as above |
| `FX2 a throwing or malformed checker …` | a throw and malformed findings both return `failed` without moving counters, while a text-less turn remains `no-text` | move `measuredTurns` before result validation |
| `FX2 the turn hook …` | `mode.ts`'s `turn_end` handler branches on the outcome and holds no counter-delta inference | reinstate `measuredTurns > measuredBefore` |

`FX2 the turn hook …` is a source scan of `extension/mode.ts`. That module pulls
the pi SDK, so this suite cannot import it, and the resolver suite drives it with
string content only. The scan pins the wiring that decides the status until a
check with realistic array content exists on the resolver side.

### Log-line equivalence (FX1)

`scanLogLines` promises exact equivalence with the regex it replaced. That is the
correct policy for exported `normalized` and `stripped` data, and it is also the
correct Windows behavior: CRLF is a line boundary, not prose that a log stripper
may leave partly visible. JavaScript multiline `^` recognizes four terminators:
LF, CR, U+2028 and U+2029. The old regex can start after the first such
terminator in a whitespace run, then `\s*` consumes the rest of that run. The
scanner does the same.

The scanner first walks backward over whitespace, then walks forward only to the
first line terminator. It visits a whitespace run at most twice, and `lastEnd`
prevents later matches from revisiting it. The scaling gate adds CRLF and
Unicode-line hostile inputs to both the regex and scanner subjects, and the full
gate remains linear at the 1 MiB cap.

A deterministic differential run used the reviewer's shape: 200,000 generated
cases across all five scanners plus 316,585 exhaustive cases. It added U+2028
and U+2029 to the log alphabet and used a fixed seed. Result: **516,585 cases,
0 mismatches**.

The reviewer's CR counterexample changes from span `1003–1030` to `2–1030`, the
same as the old regex. In the tab/NBSP variant, the span changes from `5–32` to
`2–32`, so the tab and NBSP are blanked instead of leaking into `normalized`.

| id | what it proves | mutation |
| --- | --- | --- |
| `scanLogLines matches …` / `FX1 log spans …` | every JavaScript line terminator is honoured and the full span is blanked | restore the LF-only log start search |

The module gained no regex literal with this fix, so the scaling roster needed no
new name; its log generators changed to cover the new line-terminator paths.

## Teeth, and what auditing these checks found

Every mutation recorded here was applied to a throwaway copy outside the
repository, run, and reverted. Each named only its intended check. Never mutate
the repository itself, and mutate the MODULE copy rather than a checks file:
`run-resolver-checks.sh` loads `resolver-checks.mjs` from its own directory
whatever `--repo` says, so a mutated copy of the checks would not be the file
that runs.

The status-line and wiring mutations run against the **resolver** suite:

| mutation | killed by |
| --- | --- |
| count house-style findings as fail-level | `writing-status-counting` |
| remove the trust gate | `writing-status-gate-trust` |
| rethrow checker errors | `writing-status-crash` (the fail-open section cannot complete) |
| emit a fail with the 21–25-word warning | `writing-checker-length` |
| blank the rendered writing status line | `writing-status-positive` |
| remove the `measureWritingTurn` call | `writing-status-positive` |
| break the checker import path | `writing-status-positive` |
| remove the visible size-bound status | `writing-status-cap-visible` |
| remove the file-URL conversion | `writing-status-import-url` |
| render `unavailable` as `writing 0/0` | `writing-status-import-fail`, `writing-status-fail-open` |
| remove unavailable detection and silence the catch | `writing-status-import-fail`, `writing-status-fail-open` |

**One mutation is equivalent and no check can kill it**: capping the first-come
budget at the fair allowance. Every record already gets at most
`floor(total / recordCount)`, so the running total can never be exhausted and
that mutant computes the same result. The BG6-relevant mutant is the one in § The
run budget, which restores the per-record cap plus a shared budget.

**What the TQ4 audit of these checks found.** Four weak or misleading checks and
one reporting gap, all since repaired:

- Distribution checks asserted only that medians were numbers. Zeroed or
  unrelated distributions passed. They now assert exact values and the CQ3
  conversion count.
- The SC5 and SC9 JSON assertions serialized an in-memory result and parsed it
  immediately. That round trip could not test the CLI JSON path. Both now spawn
  the command and inspect its JSON output.
- The local `writing status skips a capped assistant message` name referred to
  the 16 KiB mode cap but called `measureWritingTurn` directly with a 2 MiB
  message, so it exercised the checker's own 1 MiB fail-open path instead. The
  test is renamed to state that fact, and the resolver suite owns the real
  mode-cap check. The same confusion between the two caps reached the cap
  inventory above and was corrected there too.
- The old text-format check could find `SLASHED` in the aggregate rule table
  after the detailed finding-line renderer was deleted. The expanded reporting
  check now requires the full finding line.

The resolver determinism check was not dead in the current tree. It starts two
separate commands and compares their output. Adding a random `nonce` to a
scratch command made the outputs differ, so the check's condition becomes false.
No repair was necessary.
