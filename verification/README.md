# Verification ladder — global model-default restore

A manual regression net for the mechanism in `extension/model-default.ts` and its
two callers, `extension/failover.ts` (orchestrator failover) and
`extension/handoff.ts` (handoff adoption) — plus one rung (`WK1`) for the other
half of the same hazard: the guarantee in `extension/worker.ts` that a
**worker-side per-dispatch** model/effort switch never reaches the user's global
defaults at all. Same failure class (a slate-initiated switch leaving the user's
pi configuration changed), different mechanism. Pi 0.85.1 makes ordinary
extension setters session-scoped, so the production switch sites write zero
global-settings bytes. The probe also drives the real `AgentSession` setters
with `persist:true`. That explicit fixture keeps the compatibility restore under
test. Worker sessions use a read-only settings snapshot, so even the explicit
persisted control cannot reach the global file.

## Unit-test process boundary

`verification/run-tests.sh` runs two mandatory, disjoint processes from the
discovered `test/**/*.test.ts` roster. The native TypeScript process runs every
test except `test/recovery-ownership-host.test.ts` and produces the only LCOV
input for patch coverage. The real-Pi host process runs that test alone with a
separate temporary directory and Jiti cache. It writes a separate host LCOV file.
Either process can fail the wrapper. The runner audits that their union equals
discovery and contains no overlap or duplicate. Host coverage is not merged,
concatenated, filtered, or credited. The existing
source-authoritative denominator, 85 percent line and branch floors, and
small-branch-denominator warning policy remain unchanged.

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
SAFE          PASS    — real /home/you/.pi/agent/settings.json unchanged (57b3e320… 289:1785133943)
== summary: 26 pass, 0 fail, 0 not run ==
```

Exit status: **0** all good; **1** a rung failed, **no rung ran**, the real
settings file changed, or `--strict` was given and a rung reported NOT RUN;
**2** refused to start — a safety guard or a usage error;
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
| `--lab <dir>` | scratch dir for `agent/`, `work/`, `out/`, `weak/` (default: fresh `mktemp`, kept) |
| `--only <ids>` | comma-separated rung ids, e.g. `--only R5a,R5b,R5c`. An **unknown id is a hard error** (exit 2), and a run that ends up executing no rung at all exits **1** — a mistyped id must never look like success |
| `--old-module <file>` | supply the pre-fix `model-default.ts` for the P5a/P5b teeth proof yourself; by default it is derived from the current module at run time |
| `--strict` | any NOT RUN becomes a failure (exit 1). **Automation should always pass this** — otherwise a ladder that skipped rungs, because `strace` was missing or a teeth derivation broke, reads as a clean pass. Off by default so a human without the optional tracing tool is not blocked |
| `--setup-only` | run every guard and build every fixture and generated copy, then stop without launching pi. The supported way to exercise the safety machinery |
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
| `R4a`,`R4b`,`R5a`,`R5b`,`R5c`,`G4b`,`P8`,`P9a` | nothing: each seeds its own successor session JSONL and resumes it — no cross-rung dependency |
| `WK1` | nothing: it launches its own two pi processes and opens its own worker sessions — no cross-rung dependency |

`LAT` is informational: it prints a median wall-clock comparison and never
contributes to pass/fail.

### Requirements and hard constraints

* `pi`, `node`, `python3`, and **GNU** coreutils — `sha256sum`, `stat -c`,
  `timeout`, `cmp`, `mkfifo`, `awk`, `sed`, `grep`, `cat`, `cp`, `cut`, `date`,
  `dirname`, `head`, `ls`, `rm`, `sort`, `tail`, `wc`, `mktemp`. All are checked
  up front and a missing one aborts — a half-run ladder proves nothing. BSD/macOS
  `stat` and `shasum` are **not** supported: the script aborts rather than
  silently skipping the safety fingerprint.
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

1. **End-to-end logical recovery** — a complete `router.models.add` definition
   in `<lab>/work/.pi/slate.json` plus `pi -e <repo> -p "say ok"`. The definition
   permits the active fake route and the target route. The switch is proven from
   the session record (`model_change` entry), never from a log line. The success
   notice is deliberately UI-only.
2. **End-to-end handoff adoption** — a seeded successor session JSONL with a
   `slate-handoff` custom entry bound to its header session ID. The harness
   resumes it with `--session` and checks the saved `slate-state` entry and
   model switch. The entry needs no shared project file or parent match.
3. **`probe.ts`** — imports the module under test by absolute path and calls the
   real `withGlobalModelDefaultRestored` with the real `pi` and `ctx` around real
   session setters. The driver temporarily wraps `AgentSession.setModel` and
   `AgentSession.setThinkingLevel` so each call uses `persist:true`. It restores
   both methods in `finally`. This test-only fixture makes the failure-injection
   windows deterministic without changing production code.
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
| `R1` | a real failover fires and leaves the file byte-identical under current session-scoped setter behavior |
| `R2` | current production setters write zero bytes; the `persist:true` fixture leaks with the knob off and restores with it on |
| `R3a` | production stays session-scoped; an explicit persisted clamp (`xhigh`→`high`) restores to the user's preference |
| `R3b` | production stays session-scoped; an explicit persisted thinking-only divergence restores with the pair untouched |
| `R4a` | handoff adoption sets thinking without a global write; the explicit thinking-only fixture restores |
| `R4b` | handoff adoption sets model and thinking without a global write; the explicit persisted fixture restores both |
| `R5a` | zero-byte settings file ⇒ warn, write nothing, never delete |
| `R5b` | corrupt settings file ⇒ warn, write nothing, never delete |
| `R5c` | settings lock held ⇒ warn, write nothing, never delete |
| `R6` | a mid-session third-party write survives session end — there is no shutdown backstop |
| `R7` | a failed restore write is reported with its cause, not swallowed; the process still ends normally |
| `R8` | the retry budget is bounded: it abandons and reports instead of hanging |
| `G1` | the **macrotask** yield survives a deep write queue — *with teeth*, see below |
| `G2` | a transient write failure retries and writes back the ORIGINAL pre-switch reference, never a value re-read after the failed attempt |
| `G4a` | a same-provider production switch writes zero bytes; its explicit persisted model-only fixture restores |
| `G4b` | production keeps an absent thinking key absent; the explicit persisted fixture restores it to **absence** |
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
| `SAFE` | the real settings file is bit-for-bit unchanged across the whole run |

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
| `the file-backed copy could not be built or did not leak either` (`WK1`) | `worker.ts`'s read-only `SettingsManager.fromStorage(…)` block changed shape, or the generated probe no longer forces `persist:true` for the file-backed control. Fix the substitution or explicit-persistence control. The real worker path must remain session-scoped and byte-identical. |

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
  `SettingsManager` instead of the read-only snapshot one. The real worker uses
  ordinary session-scoped setters. The control calls those setters with
  `persist:true`, and it must write the switch or leave the next session on the
  switched model. The real module must do neither. If the control does not leak,
  the rung reports NOT RUN.

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
   directory, or the repository working tree.
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
   symlink's target while only the launch was refused.
5. **The real settings file is fingerprinted.** sha256, size and mtime are
   recorded before the run and re-checked after. A change is a failed run
   (`SAFE FAIL`, non-zero exit) saying a pi invocation escaped the redirect.
   Because mtime is part of the fingerprint, any pi process that writes the same
   real `settings.json` trips it, regardless of its project or working tree. A
   process with `PI_CODING_AGENT_DIR` set to another directory cannot trip this
   fingerprint.

   A pi process can write settings for many reasons. Model changes and effective
   thinking-level changes are common examples, not an exhaustive list. The
   harness cannot prove that an apparently idle session will remain read-only.
   Treat every pi process sharing the real agent directory as a possible
   concurrent writer.

   An isolated-load smoke test, an interactive session or a dogfooding session
   can rewrite the file concurrently. The resulting `SAFE FAIL` has an IDENTICAL
   recorded hash and size, with only the mtime moved. That shape says only that
   the bytes did not change. It does not name the writer: a child that ignored
   the redirect and wrote the same bytes back produces the same shape as a
   concurrent writer. Treat it as the likely concurrent-writer case, and confirm
   it by rerunning alone rather than by reading the shape as proof. The run
   still fails because the sentinel can no longer speak for the rungs above it. Stop the other pi processes
   that share the real agent directory, then rerun the ladder alone.

   The real agent directory is located **the way pi locates it** — via
   `node os.homedir()`, which still works when `HOME` is unset — or from
   `SLATE_LADDER_REAL_AGENT_DIR`. If neither can be determined, the script aborts
   rather than watch nothing.

On top of that, every pi invocation goes through one helper that sets
`PI_CODING_AGENT_DIR=<lab>/agent` and unsets the inherited `PI_CODING_AGENT`,
`PI_SESSION_FILE`, `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL` and
`PI_REASONING_LEVEL`, so a run launched from inside a pi session cannot pick up
the caller's session or model. `getAgentDir()` in pi honours that variable for
settings, auth, model catalogue and sessions alike — confirm the redirect took
effect by checking that `<lab>/agent/sessions/` filled up.

An `EXIT`/`INT`/`TERM` trap restores permissions on any settings file the rungs
made read-only, removes any lock directory left held, and kills background
helpers — for lab paths containing spaces too, and skipping anything that is no
longer a real directory inside the lab. Artifacts are deliberately **not**
removed — they are the evidence.

### What the guards do NOT cover

* They protect the **pi home tree, the real agent directory and the repository**.
  A `--lab` elsewhere is accepted, so pointing it at another directory you care
  about will let the harness write there.
* The fingerprint watches **one file** — the real `settings.json`. Escapes that
  touched only, say, the real session directory would not be caught by it.
* Guard 2/3 canonicalise **at startup**. The *agent* directory is re-checked
  before every launch and every write (guard 4), but the other lab directories —
  `out/`, `weak/`, `work/` — are not: a symlink swapped underneath one of those
  mid-run would redirect artifact or fixture writes. They hold no user state, and
  the attack needs same-user access to a `0700` scratch directory.
* Nothing here defends against a `pi` binary that ignores
  `PI_CODING_AGENT_DIR`; the fingerprint is what would notice after the fact.

Nothing the harness writes lands inside the repository: the repo is only read —
the module under test and `probe.ts` are read, and every weakened copy is
generated into `<lab>/weak/`.

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
  `--lab`. Old `out/` artifacts survive; see § Requirements and hard constraints.

# Pure-resolver checks — `run-resolver-checks.sh`

The pure-resolver harness loads current production modules through Pi's bundled
Jiti TypeScript loader. It uses fabricated registries, policies, events, stores,
and extension rosters. It starts no Pi session, uses no network, and writes only
to its disposable work directory.

It also checks the workflow contract for requirement-level investigation after
two same-requirement repair rounds (`contract-requirement-investigation`). The
check proves policy text and mutation resistance only. It does not enforce live
round counting, user interaction, dispatch pausing, or research-log writes.

```sh
bash verification/run-resolver-checks.sh --repo .
bash verification/run-resolver-checks.sh --repo . --strict
```

The wrapper reports one `CHECK` line per identifier, one roster audit, and one
summary. Exit 0 means every check passed. Exit 1 means a failure, missing check,
or strict `NOT RUN`. Exit 2 means the wrapper refused to start. The roster and
summary output own the live count.

## Current coverage

The suite covers worker-extension resolution and doctrine, logical-model defaults
and configuration, the active parent-session runtime, common recovery planning,
exact reviewed import edges, state sanitation, episode headers, base-model
reduction, writing and reminder policy, worker prompt plumbing, and the shipped
workflow contracts.

The logical import guard parses TypeScript and JavaScript references. Its exact
edge roster must equal the active six-module logical graph. It fails on missing,
duplicate, computed, external, or unreviewed recognized edges and parse errors.
Recognized edges are static imports, exports, import-equals declarations,
dynamic imports, and direct `require` calls. Arbitrary loader forms are an
accepted limitation.

The brand-cast check rejects direct and `unknown` or `any` two-step named `as`
assertions in every scanned extension source except the exact brand producer,
`extension/logical-model-runtime.ts`. In the bounded consumer
`extension/threads.ts`, it also rejects angle-bracket assertions to `OpenModel`
or `SessionBaseline` and rejects `as never`. The syntax-only check does not
resolve renamed imports, local or transitive type aliases, or type flow. Type
checking does not make those brands tamper-proof. This bounded source scan
remains required, but it does not provide complete type-security enforcement.

Doctrine checks call the real `registerSlateMode` `before_agent_start` handler
with orchestrator mode enabled. They cover the trust gate, blocked policy,
provider-free table, sanitation, positional numbering, excluded source data,
exact portable sizes, and growth bounds. A headless load smoke test does not
enter orchestrator mode and does not replace these checks.

## Delivery-document reference boundary

`contract-delivery-packages` keeps the exact package-preparation-only loading
unit, package-document digest, accounting sequence, and acceptance delegation.
It also scans `README.md` and every recursively discovered `.md` file under
`docs/`. The package whitelist ships these inputs. Discovery includes new and
unreferenced documents without a maintained file list.

Every literal `delivery-packages.md` occurrence must belong to an explicitly
reviewed context. The roster records the document, heading ancestry, and complete
paragraph, list item, or table row. It requires unique owning headings and the
same reference-context order within each document. Additions, removals, changed
text, duplicate contexts, and moves to another document or heading fail. Moving
text within the same heading past only unrelated prose is not distinguished.
Whitespace normalization allows line wrapping within a context. Unrelated prose
and new documents without the literal filename remain unrestricted.

This is a bounded source check, not a Markdown parser or a semantic reading
check. Blank lines, ATX headings, list-item starts, table rows, and standalone
HTML comments delimit contexts. The scanner examines literal filenames even in
comments and code. It does not resolve aliases, encoded filenames, or eager-read
instructions that omit the literal filename. Those forms remain outside the
approved guarantee.

`test/delivery-reference-contract.test.ts` runs disposable mutations through the
real strict resolver wrapper. Each negative case requires exit 1 and a failed
`contract-delivery-packages` result. Positive controls require the full suite to
pass. Run this test and the strict resolver suite after changing the scanner,
its reviewed roster, or a reference-bearing documentation context.

## Doctrine measurement basis

Portable measurement removes every exact installed documentation-directory
prefix and keeps the filename. Raw character counts are path-dependent. The
exact current production renders are:

| fixture | paths | portable characters | lines |
| --- | ---: | ---: | ---: |
| shipped logical section | 0 | 3,892 | 11 |
| trusted shipped-default doctrine | 5 | 8,683 | 85 |
| untrusted doctrine | 4 | 2,694 | 44 |
| draft pull requests, shipped policy | 6 | 8,911 | 88 |
| capped workers, shipped policy | 5 | 10,030 | 95 |
| draft plus capped workers | 6 | 10,258 | 98 |
| deferred issues plus capped workers | 5 | 10,104 | 96 |
| routing recommendations plus capped workers | 5 | 10,127 | 96 |
| draft plus deferred issues and capped workers | 6 | 10,332 | 99 |
| draft plus routing recommendations and capped workers | 6 | 10,206 | 97 |
| deferred issues plus routing recommendations and capped workers | 5 | 10,201 | 97 |
| canonical maximal baseline with all workflow options | 6 | 10,280 | 98 |
| maximal baseline with an open change | 6 | 10,478 | 99 |
| maximal baseline with source and legacy root log | 6 | 10,708 | 101 |
| dogfood config and extension roster | 6 | 9,405 | 97 |
| 19,400-character policy plus draft, source and legacy log | 6 | 26,194 | 102 |
| same policy plus draft and deferred issues, source and legacy log | 6 | 26,268 | 103 |
| same policy plus routing recommendations, source and legacy log | 5 | 26,063 | 100 |
| same policy plus deferred issues and routing recommendations, source and legacy log | 5 | 26,137 | 101 |
| same policy plus draft and routing recommendations, source and legacy log | 6 | 26,142 | 101 |
| same boundary composition plus deferred issues | 6 | 26,216 | 102 |
| valid shipped policy plus 88 capped tools, source and legacy log | 6 | 28,382 | 184 |

The capped worker baseline has two units and four tools. Each unit label has 128
characters. Each tool name has 64 characters. Each description has 140
characters. The dogfood fixture reads `.pi/slate.json` and represents its two
configured extension units.

The canonical 10,280-character baseline uses all six shipped logical models,
all three workflow options, and the capped worker roster. With an open change,
a direct source folder, and a legacy root log, it measures 10,708 characters.
Its required five-percent value is 11,244. The 26,300 whole-doctrine ceiling
keeps that reserve. The exact fixtures cover all eight workflow-option
combinations.

Runtime rejection controls are separate. A logical section at exactly 19,400
portable characters or 105 lines is valid. A section at 19,401 characters or
106 lines is rejected before work. The four routing-enabled boundary
compositions and the 26,194-character and 26,268-character feature-off
compatibility controls include the current change, direct source, and legacy
root log. They prove that an exact-boundary policy fits the 26,300-character
whole-doctrine ceiling. The 26,268-character control has the smallest margin.
A valid third worker unit with a 26-character label measures 26,300.
A 27-character label measures 26,301 and fails the ceiling. These controls are
not reserve-bearing canonical baselines.

The over-cap counterfactual keeps the shipped logical policy valid and adds 88
supported capped worker tools. With an open change, source, and legacy log, its
28,382 portable characters exceed the ceiling by 2,082 characters.
This transformed fixture replaces the retired six-copy physical model-row shape.
It does not assume an old per-row or per-tool increment. Removing the whole-
doctrine comparison makes the counterfactual pass and therefore breaks the
check.

Exact literals are maintenance tripwires. Any doctrine-size change requires a
fresh production render and matching updates in `docs/context-budget.md`, this
file, `verification/resolver-checks.mjs`, and `test/doctrine-contract.test.ts`.
The logical limits remain 19,400 characters and 105 lines. The all-tail limit
remains 24,600 characters. The new whole-doctrine ceiling is 26,300 characters.

## Re-run triggers

Re-run the strict suite after changes to active logical-model modules,
`mode.ts`, `paths.ts`, worker-extension doctrine, state sanitizers, base-model
tracking, episode headers, writing or reminder modules, worker prompt wiring, or
any workflow contract read by the harness. Track-size or publishing-mode rule
changes require the strict suite because mutation checks pin those policy units.
A model-switch or handoff change can
also require the full ladder. The package and writing checks remain separate
nets.

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
proxy variables and the canary evidence paths. The controller waits for the RPC
`agent_settled` event between prompts instead of using a fixed delay. `PI_OFFLINE=1` keeps pi startup
offline. The fake provider performs no network operation. This is **not** a
network sandbox because reviewed extension code can still open raw sockets.

The harness runs three trusted projects. The main project enables
`writing.findings` and `remindOnFinding`. The trigger-off project disables
`remindOnFinding`. The findings-off project disables `writing.findings`. All
projects set `remindTurns: 4`. The main session proves the finding trigger and
the later cadence reminder. The two switch sessions prove that cadence remains
active. The findings-off session proves that the findings section disappears when
disabled. Measurement continues in the disabled case. The fake model advertises a 1,000,000-token
window. The canary completes a finding-heavy first turn. The controller records the event position before each command. It waits only for events after that position, including `agent_settled` between prompts.

The canary registers an in-process fake provider and one real tool. The main
provider response emits two parallel calls to that tool. Both executions append
a marker. Each persisted tool result must contain exactly one text block, no
extra block or key, and the text `CANARY_TOOL_RESULT_ONLY`. Slate's real
turn-end path selects steer delivery for the tool-result turn and next-turn
delivery for the later tool-free turn.

The main session runs six provider calls and persists two reminders. The
trigger-off and findings-off sessions run five calls and persist one cadence
reminder each. Each provider call writes a unique response after observing the
expected reminder shape.

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
- The provider runs the expected calls and emits its success markers.
- The next model calls receive the expected exact reminders.
- The main session persists two reminders and each switch session persists one reminder with `display: false`.
- No tool result carries extra content, keys or reminder text.
- The three sessions report the expected checks.
- The fixed roster has 27 expected identifiers plus the roster audit, for 28 result lines. The identifiers are `pi-exit`, `rpc-json`, `hook-errors`, `working-tree`, `trusted-config`, `tool-executed`, `provider-calls`, `trigger-position`, `cadence-position`, `delivery-modes`, `counter-restart`, `trigger-switch`, `findings-grammar`, `requirements-complete`, `findings-classes`, `quotation-cap`, `findings-next-call`, `reminder-persisted`, `reminder-counts`, `display-false`, `no-findings-clean`, `findings-off`, `findings-off-measurement`, `advisory-hidden`, `message-bound`, `delivery-details-hidden`, and `tool-result-clean`.
- The checks cover finding-trigger timing, four-turn cadence, delivery modes, switch behavior, findings order, classes, quotations, persistence, hidden delivery, and the message bound.

A clean run removes its physical scratch directory. A failure keeps the
directory, prints its path, and inlines pi stderr and stdout. The directory also
contains the raw RPC stream, session JSONL, provider evidence, tool marker and
parsed analysis.

## Boundary and re-run rules

This is an integration net, but it is not part of CI. It is also separate
from the extension-load check and the ladder. The load check proves registration
without executing a tool. The ladder covers model-default restoration and worker
settings isolation. This harness covers three reminder sessions through real pi.
No current workflow invokes it automatically.

The harness structurally proves `display: false`. It does not prove that the TUI
visually hides the message. Confirm visual invisibility manually in an interactive
TUI session when that presentation contract changes. A PTY check would add a
fragile render-loop dependency, so this boundary stays explicit.

Re-run the harness after changes to:

- `extension/writing-reminder.ts`, including requirement text, rendering, cadence,
  or gates.
- Reminder config sanitization in `extension/writing.ts`.
- The `message_end`, `turn_end` or `agent_settled` reminder hooks in `extension/mode.ts`.
- The handoff `forceNext` assignment or session-start ordering in
  `extension/handoff.ts` and `extension/mode.ts`.
- Custom message options, custom type, steer delivery or next-turn delivery.
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

# Worker-reminder integration check — `run-worker-reminder-check.sh`

Run the hand-run integration net from the repository root:

```sh
bash verification/run-worker-reminder-check.sh --repo .
```

The harness starts one real offline pi session. A deterministic in-process
provider makes the orchestrator call the real `thread` tool. The worker issues
two independent built-in `read` calls in one turn, receives the hidden reminder
on its continuation request, returns a fixed marker and produces an episode.
The scratch config keeps `workerExtensions` empty and sets `cacheKeyEnabled` to
`false`. The TypeScript canary loads through the same jiti module aliases as
Slate. It registers the native provider on the host and on every test-created
`ModelRuntime`. It delays the legacy compatibility registration until the
worker finishes, just before compression. This ordering makes missing native
worker registration and missing legacy compressor registration independent
failures. The canary restores its `ModelRuntime.create` wrapper during session
shutdown when it still owns that method.

On the reference machine, the run takes about five seconds. The hard bound is
GNU `timeout`: TERM after 60 seconds and KILL five seconds later. Exit **0** means
every assertion passed. Exit **1** means at least one check failed. Exit **2**
means the harness refused to start because its invocation, tools, checkout,
canary, pi binary or exact version pin did not satisfy a precondition.

The 18 result lines assert these properties:

1. Pi exits zero within the timeout.
2. The RPC, host-session and worker-session JSON Lines parse completely.
3. Pi emits no `extension_error` event.
4. The `/slate` command comes from the checkout under test.
5. The module-global custom API handles orchestrator, worker and compressor calls offline.
6. One real thread dispatch completes with status `ok`.
7. The worker makes one two-read request and one fixed-marker continuation request.
8. Both built-in read results persist in their exact unchanged shape.
9. Exactly one worker reminder persists with the exact type, text and `display: false`.
10. The reminder follows both tool results and precedes the continuation assistant message.
11. The continuation provider context contains exactly one reminder.
12. The provider sees exactly two worker calls, two orchestrator calls and one compressor call.
13. The delivered reminder produces no false reminder-miss warning.
14. The compressor request contains no reminder text or custom type.
15. The durable episode exists and contains no reminder text or custom type.
16. An empty worker-extension allowlist and disabled cache key do not prevent delivery.
17. The orchestrator receives the result and returns its fixed completion marker.
18. The roster reports every expected identifier exactly once.

The run proves one clean worker path through factory loading, tool-result hooks,
steer delivery, provider context, worker JSON Lines and episode filtering. It
proves that successful delivery produces no false reminder-miss warning. A single
clean run cannot prove that a real missing reminder produces the warning. The
pure `worker-reminder-detection` and `worker-reminder-wiring` checks, plus the
unit tests in `test/single-action-threads.test.ts`, carry that property. The run
proves `display: false` structurally. It does not prove visual invisibility in
the terminal user interface. Check that presentation manually. It also does not
prove concurrent session isolation. The pure `worker-reminder-state` family
covers two interleaved factory instances.

A clean run removes its disposable scratch directory. A failed run keeps the
directory and inlines pi stderr and stdout. The child starts through `env -i`,
uses dead proxy settings and sets `PI_OFFLINE=1`. The provider performs no
network operation. This setup is not an operating-system network sandbox.

Re-run this harness after changes to `extension/worker-reminder.ts`, reminder
factory loading or error handling in `extension/worker.ts`, action-slice
detection or compression filtering in `extension/threads.ts`, custom-message
shape or steer delivery, either harness file, the pi pin, or an asserted RPC,
provider-evidence or JSON Lines shape.

| file | role |
| --- | --- |
| `run-worker-reminder-check.sh` | driver, isolated scratch environment, real pi session, evidence parser, 18-result roster and artifact policy |
| `worker-reminder-canary.ts` | deterministic offline provider, orchestrator and worker scripts, call classification and provider-context evidence |

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

The harness starts two pi session processes. Both load the checkout explicitly
through `-e`. A full invocation also starts one separate `pi --version` process
to enforce the declared pin. `T4`, `T5` and the non-selectable roster audit start
no session.

Three checks were deleted from this harness, and it no longer proves the sibling
worktree arrangement. `T6` classified the layout of the checkout. `T7` built a
scratch sibling package layout and loaded slate through the tracked spelling
alone. `T8` counted the copies of slate that an ordinary session loaded. Each of
the three needed the sibling worktree of this repository to be present. A plain
clone has no sibling, and a continuous-integration checkout has no sibling, so
the three checks established nothing there. On a developer machine every pi
session in this checkout already proves the same property by running, because a
session with no slate extension has no `/slate` command and no dispatch tool. The
user applied one test. A check earns its place only if it can fail somewhere the
property is not already proven by use. `T6`, `T7` and `T8` failed that test. The
user approved removing the goal that the arrangement is proven automatically.
`T5` passes the test, because `T5` reads a tracked file, so `T5` runs in
continuous integration and in a plain clone.

Two things establish the arrangement now. Every session in this checkout proves
it by running. The manual isolated-load smoke test, `pi --no-extensions -e .`,
proves it on demand. `T5` protects the tracked settings entry itself in
continuous integration. Nothing automatic proves the sibling arrangement.

Both sessions run offline. Each receives an empty throwaway
`PI_CODING_AGENT_DIR` under the `mktemp` scratch directory. No session receives
`models.json` or `auth.json`. Both sessions receive `PI_OFFLINE=1` and non-model
rpc requests from a file, so stdin reaches EOF at once. Both also receive
`--no-extensions`.

The environment scrub is a variable-name pattern, not a complete credential
inventory. It removes names containing `API_KEY`, names ending in `_TOKEN`,
names containing `TOKEN_`, names ending in `_SECRET`, names containing
`_SECRET_`, and names containing `CREDENTIALS`. It also removes
`PI_CODING_AGENT`, `PI_CODING_AGENT_DIR`, `PI_SESSION_FILE`, `PI_SESSION_ID`,
`PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, `PI_KEY` and `PI_HOST`. A
credential under another name remains. For
example, the gate proved that `AWS_ACCESS_KEY_ID` reaches a real pi child. The
stronger permitted-variable-list design is deferred.

`PI_OFFLINE=1` is mandatory for both runs, and the trusted run needs it
most: `-a` makes pi read `.pi/settings.json`, and pi then npm-installs every
package in that file. One such run hung for 60 seconds and wrote a `.pi/npm`
directory **into the checkout under test**. `L8` and `T3` therefore assert that
the directory did not change.

The harness is valid because the failure modes that it covers have no other
signal (`AGENTS.md` § How extension-load failures surface). pi drops an entry in
`pi.extensions` that resolves nowhere, and it says nothing. A throw in
`session_start` appears as an `extension_error` event on stdout only. A tool
registration that disappears produces **no diagnostic at all**.

The last failure mode needs a positive control, because pinned Pi 0.85.1 offers
no rpc command and no CLI flag that lists the registered tools.
`verification/ci-canary.ts`
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

The override does not switch off any precondition, and it has one exit code.
The three `NOTE` lines print first, and then the ordinary checks run against the
named CLI. A `PI_BIN` path that is not executable is an exit-2 refusal. A
`PI_BIN` CLI whose `--version` output does not equal the
`@earendil-works/pi-coding-agent` pin is an exit-2 refusal too, and the message
is the same version-mismatch text that a checkout-local CLI gets. Measured on
2026-09-04: `PI_BIN=/nonexistent/pi` refused with exit 2 and the not-executable
message, `PI_BIN=/usr/bin/true` refused with exit 2 and the version-mismatch
message, and `PI_BIN` set to the checkout's own `node_modules/.bin/pi` printed
the three notes and then exited 0 on `--only T4`. There is no exit code that
belongs to the override alone.

## Running it

```sh
bash verification/run-load-check.sh --repo .              # --repo defaults to "."
bash verification/run-load-check.sh --repo . --only L4,L6
bash verification/run-load-check.sh --list-checks
bash verification/run-load-check.sh --help
```

Measurements on 2026-09-04 used the then-pinned Pi 0.83.0 on an x86-64 desktop
in the AMD Ryzen 9 7950X3D class with 62 GiB of memory. These are historical
measurements. Three clean full runs after the deletion of `T6`,
`T7` and `T8` took **2.48 s**, **2.61 s** and **2.63 s**. `--list-checks` and
`--help` each measured below 0.01 s. These wall-clock values are measurements on
that machine, not speed promises. Every invocation that creates the scratch
directory also runs one short node program for the scratch-directory guard below.

The harness prints a header with the run context, one line for each check, any
`NOTE` lines that qualify a verdict, and a summary. This abbreviated sample reflects the current Pi pin and tracked configuration.
The timing figures above remain historical measurements from 2026-09-04.

```
repo  = /home/you/src/main-as-source (02b6bf8)
pi    = /home/you/src/main-as-source/node_modules/.bin/pi (0.85.1, pinned 0.85.1)
lab   = /tmp/slate-loadcheck.example

CHECK L4                               PASS — the canary observed all three dispatch tools registered: thread, threads, episode
CHECK L6                               PASS — /slate is registered and attributed to /home/you/src/main-as-source/extension/index.ts — inside the checkout under test, so this run exercised the working tree and not an installed release
CHECK T2                               PASS — the trusted config emitted no sanitizer warning
CHECK T4                               PASS — /home/you/src/main-as-source/.pi/slate.json parses as a JSON object, 4 top-level key(s): orchestratorModeDefault, workflow, router, workerExtensions
CHECK T5                               PASS — /home/you/src/main-as-source/.pi/settings.json carries exactly one local package entry, spelled "../../main", and no registry entry for ytdb-slate (3 package entry/entries in total)

CHECK roster                           PASS — all 13 selected check(s) reported exactly once (13 result line(s) before this audit)
== summary: 14 pass, 0 fail (14 result lines = 13 selected checks + this roster audit) ==
```

Exit status: **0** every check passed · **1** a check failed, or `--only` matched
no check, because a mistyped subset must never look like success · **2** the
harness refused to start.

One exit-2 case reports a **real defect through another mechanism**. A deleted
`extension/index.ts`, or a deleted `verification/ci-canary.ts`, makes the sentinel
`die` in the driver refuse the run instead of a FAIL report. pi drops the
nonexistent entry from `pi.extensions` in silence and starts normally. Every
check would otherwise pass on an empty session, and no failure report could
appear. The other exit-2 cases come from the environment: a missing tool, a bad
`--repo`, no pi CLI, or a mismatch between the CLI and the pin. The harness
prints the remedy with the message (`run 'npm ci --ignore-scripts'`, which is the
install that CI runs; after a deliberate change of the pin, that install is
enough). A scratch directory inside the checkout under test, or inside the real
agent directory, is an exit-2 refusal as well.

Requirements: `node` and `mktemp`. Missing any required tool is an exit-2
refusal. `git` was required while `T6` existed, and no surviving check reads git
evidence. The context header still asks git for the short commit of the checkout,
and it prints `not a git checkout` when git cannot answer. The harness uses `timeout` when it is present, and it does not require
it. An unknown id in
`--only` is a hard error (exit 2). Every refusal starts with
`verification: refused to start — `, which is the vocabulary of all three CI
wrappers and not a local convention. `AGENTS.md` § CI also states the
meaning of an exit code of 2.

The artifacts are the raw rpc stdout and stderr streams of the pi runs. They live
under the scratch directory, which the header names `lab`. The harness removes
that directory after a clean run. It **keeps** the directory, and prints the
path, when a check failed **and** a pi run happened. A static-only failure of
`T4` or `T5` keeps nothing, because the directory holds no pi streams. A run whose pi wrote
nothing still keeps the directory, because the gate is the pi run and not its
output. The
scratch directory must sit outside the checkout: when `TMPDIR` points into the
checkout, the harness refuses the run, because pi must write nothing there.
The real agent directory carries the same rule. When `TMPDIR` points inside the
real agent directory, the harness refuses the run with exit 2, because that
directory is one the harness may only read. The refusal is deliberate, and a
silent relocation is deliberately not offered: `TMPDIR` comes from the caller, so
the state is a bad invocation and not a defect in the checkout, and a silent move
would hide the misconfiguration. The guard applies the agent-directory rules of
the shared program, and it compares the real paths as well as the spellings.
Measured before the guard existed: `TMPDIR=<agent dir>/scratch` with `--only L1`
left 26 entries inside the real agent directory and reported a pass. The same
invocation now refuses and leaves nothing.

A failing run also **prints those streams to its own stdout**, because a CI job
deletes its scratch directory and the path then names a directory that nobody can
open. The same two conditions gate the output: a check failed, and a pi run
happened. A clean run therefore prints nothing extra, and a static-only failure
prints no empty section. The harness prints one delimited section for each
stream of each run that started. A failing full run can therefore print four
sections: stderr and stdout for each of `run1` and `run2`. It
prints stderr before stdout, because pi's diagnostics and the canary line go to
stderr. The size of a section is not a fixed figure of this harness. All four
sections carry the absolute path of the checkout once, so each of them grows with
the length of that path. Every section also follows pi's own diagnostic text and
the configuration of the checkout. This
document therefore states a bound and one example measurement, and it states no
figure that a reader is expected to match exactly. The bound is the cap
arithmetic below. The example is ONE RUN on 2026-09-04, on the x86-64 desktop
named above, in this dogfooding checkout at a path of 55 characters, with the
committed `.pi/settings.json` and `.pi/slate.json`. A copy of the harness with
the `L1` assertion inverted made an otherwise
clean run fail, and that run printed 4 sections of 179, 2237, 178 and 1124 bytes,
which sum to 3718 bytes. The same four values are the first four values of the
eight that the earlier four-session harness printed. Another checkout path or
another project configuration gives other values. Each section names its run, and
the `artifacts:` pointer still follows for a local run. The sample below abbreviates
every body, so each stated size is the size of the real stream and not of the
line shown:

```
rpc streams below, inlined because a CI scratch directory does not outlive the
job — the artifacts path at the end is only reachable on the machine that ran.
---- run2 (the trusted config run, -a) stderr — 178 bytes ----
CI-CANARY {"tools":[…],"cwd":"…","trusted":true}
---- end run2 (the trusted config run, -a) stderr ----
---- run2 (the trusted config run, -a) stdout — 1124 bytes ----
{"type":"extension_ui_request",…,"method":"notify","message":"slate: ignoring …"}
---- end run2 (the trusted config run, -a) stdout ----
artifacts: /tmp/slate-loadcheck.5eHaps (raw rpc streams, kept because a check failed)
```

The output has a bound, so a pathological run cannot flood the log. The harness
cuts each stream at **20000 bytes** (`STREAM_CAP`). It cuts at the last line
boundary when that boundary lies past half of the cap. The header of a section
that lost bytes states the real size, the size after the cut, and the cap, so
nobody reads a cut stream as a whole one. Four sections therefore carry at most
**80000 bytes** of stream bodies after a full two-session run: 4 streams ×
20000 bytes per stream.

The inlined raw stream dumps are byte-faithful before the documented C0
neutralization, and they are **NOT credential-redacted**. A credential in pi's
own output can therefore appear in a failing log. A stream of 0 bytes gives one
header with `— 0 bytes (empty)` and no body, and a stream that the harness cannot
read gives `unavailable` with the reason.

The `CHECK` and `NOTE` lines redact every value that came out of a settings file,
a manifest, a specifier or one of pi's own diagnostics. They do **not** redact
everything, and this document states the two exceptions plainly. `T4` prints the
top-level key names of `.pi/slate.json` as they stand. The paths the harness was
given or created are printed as they stand too: the `--repo` path, the scratch
path and the working directory that the canary
reports. The npm-specifier pass keeps a package name whose shape is a legal npm
name, and it keeps a range that looks like a version range. A dot-free range is
kept only up to 5 characters, because every dot-free range that npm accepts is a
short bare major, while a hexadecimal or UUID-shaped token is long. A name that
is a bare scope with no `/name` is redacted, because npm has no such specifier.

The harness replaces each C0 control
character other than tab and newline with `?`, because the output goes into a
log, and the harness promises no ANSI anywhere. The copy in the artifacts
directory keeps the original bytes. A real
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
a dogfooding session, before any cleanup runs.

The separate version-pin probe reads the real user agent directory before the
throwaway session directories exist. It creates and removes `settings.json.lock`
beside the real user settings file. That operation moves the real agent
directory's modification time. The scratch guard also resolves the real path of
the real agent directory on every invocation that reaches check selection. The
scratch guard reads directory metadata only. It never reads the user
`settings.json` content. The measured user `settings.json` content, size and
modification time stayed unchanged.

The mirror of the real agent directory, and the fingerprint that watched the
user `settings.json` file, belonged to `T8`. Both were deleted with `T8`. No
session of this harness reads the real user settings file now, and no session
resolves a package or an extension out of the real agent directory. The recorded
risk that a mirrored symbolic link gave pi a write path into that directory is
gone with the mirror that created it.

## What it covers

`--list-checks` prints 13 selectable identifiers. `L1`–`L8` cover the
untrusted explicit load path, and `T1`–`T3` cover the trusted explicit path
(`-a`). `T4`, `T5` and the
roster audit start no session. The non-selectable `roster` audit compares the
selected identifiers with the identifiers that reported and emits its own result
line. A clean full run therefore prints 14 result lines: 13 selected checks plus
the roster audit. Every invocation that reaches check selection also runs the
separate pi version-pin probe. The measured full invocation had 3 real pi
processes: 1 version-pin probe plus 2 rpc sessions.

| id | what it proves |
| --- | --- |
| `L1` | pi **exited 0** and loaded the checkout (rpc, offline, empty agent dir, no `models.json` and no `auth.json`, environment scrubbed by name pattern). The verdict names the pattern scrub, and it claims no more than that. The run does **not** deliver an environment with no credentials of any kind: the scrub is a variable-name pattern list, and a credential under an unmatched name reaches the child, as the measured `AWS_ACCESS_KEY_ID` case above shows. What holds is that the run has nothing to spend a credential on. This check is a real signal on pinned Pi 0.85.1, where the covered load failures exit 1 |
| `L2` | stderr holds **neither** `Failed to load extension` **nor** `Extension error (`. The check reads both markers, because the first is the channel for a reported load failure and the second is the channel for a hook, which the first misses. Its own verdict line names the two markers and reproduces neither, so a grep of a CI log for either literal finds no line from a run that passed |
| `L3` | **stdout** holds no `extension_error` event, which is the only signal from a hook that throws in rpc mode |
| `L4` | the canary saw all three dispatch tools: `thread`, `threads` and `episode`. Nothing else detects their removal |
| `L5` | the canary reported a **non-empty** tool list, and it named the place. This check stops `L4` from a pass when the canary never loaded, or when `session_start` runs before the registration |
| `L6` | pi registered the `/slate` command **and attributed it to a path inside the checkout under test**, which proves that the run used the working tree and not an installed release |
| `L7` | `/slate on` completes through the command handler offline: the prompt response succeeded, the handler appended a `slate-state` entry, and the widget holds lines |
| `L8` | the run left `.pi/npm` in the checkout unchanged, so the run stayed offline and npm-installed nothing into the working tree |
| `T1` | pi exited 0 on the trusted (`-a`) run, **and** the `trusted` field of the canary reads `true` (the `canary-trusted` query of the driver). This check protects `T2`: without trust slate reads no `.pi/slate.json`, and a clean `T2` then means nothing |
| `T2` | the trusted config emitted no sanitizer warning. Any warning, malformed rpc output, or untrusted positive control FAILS. This check passes the tracked logical `router.models` and `router.compressor` configuration through the current sanitizer together with `contextBudget`, `workerExtensions`, and `writing` when those groups are present |
| `T3` | the trusted run also left `.pi/npm` unchanged, so `PI_OFFLINE` held where `-a` would otherwise install |
| `T4` | the project config file **parses as JSON and holds a plain object at the top level**. node reads the file directly from disk. The check PASSES when the file is absent, because a project config is optional for a consumer |
| `T5` | without starting a pi session, the tracked `.pi/settings.json` is readable JSON with a `packages` array, contains exactly one local package entry spelled `../../main`, and contains no npm entry named `ytdb-slate`. The local entry must be a bare string or an object whose only key is `source`. It FAILS on a missing or malformed file, an invalid package-entry shape, another local entry, another spelling, a registry slate entry, `autoload: false`, or any package filter key |

`T4` exists because `T2` cannot cover the syntax of the file. slate's
`loadConfig()` wraps the read and the `JSON.parse` in a `try`/`catch`, and it
accepts a non-null, non-array object only. For every other input it returns `{}`,
and the session continues on the defaults with **no output at all**: no warning,
no error and no event. A checkout whose `.pi/slate.json` holds `{{{` therefore
looks healthy to every check that reads pi's output, while slate drops every
setting in the file, `workflow.draftPRs` included. A direct read of the file is
the only way to see that state, and it needs no pi, no session and no trust.

Re-run the full harness after a change to extension loading, tool or command
registration, `session_start`, `.pi/slate.json`, `.pi/settings.json`, the shared
package-resolution helpers, the `T5` assertion, or the redaction paths. The
sibling-worktree triggers went with `T6`, `T7` and `T8`. A change to the sibling
target, to its manifest, to a declared extension entry point, to the worktree
layout, to a user-scope settings entry, or to either automatically discovered
extensions directory moves no result in this harness now.

Detection of a second loadable copy of slate is no longer a goal of this harness.
`T8` carried that goal. A duplicate load surfaces in use instead: pi reports a
tool conflict for every dispatch tool and exits 1 before the first prompt, so the
session is dead. `T5` still fails on a registry entry for `ytdb-slate` beside the
tracked local entry, which is the one duplicate this repository created in the
past.

One gap remains, and this document states it plainly. `T2` and `T4` together
cover the syntax of the file, its top-level shape, and the sanitizer-covered
config groups. **An unknown key, and a wrong-typed value under a key without a
sanitizer, pass both checks in silence**. `{"totallyUnknownKey": 5, "maxConcurrent": "lots"}`
gives a pass for `T4` and a pass for `T2`. No check in CI validates the
content of the config, and the reader of `README.md` § Configuration still
carries that duty.

The harness proves no tool behaviour. No check here executes a tool, starts a
worker session, or exercises failover or handoff: the harness performs loads,
registration checks, one command round trip, and direct config and package
reads. It is also no typecheck; `npm run typecheck` is that check, because jiti
transpiles each module and erases the types, so a type error loads correctly.
Both pi sessions use rpc mode, so no result here describes the TUI. Those subjects
need the ladder, the resolver checks, or the manual isolated-load smoke test (`pi --no-extensions -e .`, see
`AGENTS.md`).

## Files

| file | role |
| --- | --- |
| `run-load-check.sh` | the driver: it resolves the pi CLI, matches the pin, runs two pattern-scrubbed offline rpc sessions, parses their streams, reads the project config file and the tracked package settings, and holds every assertion |
| `ci-canary.ts` | the positive control: a `session_start` hook that prints the registered tool set, the cwd and the trust state to stderr, and asserts nothing |

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`). No module in
`extension/` imports the canary, and the canary reaches a session only because
this harness passes it to pi with `-e`.

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
every shipped command, while the guards only permit the `.mjs` file kind. Run
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
| the `message_end` hook in `extension/mode.ts`, through `measureWritingTurn` in `extension/writing.ts` | the completed assistant message before tool execution, for the `writing N fail, M style / W turns` status line and the latest reminder findings | `WRITING_TURN_MAX_BYTES` — 16 KiB of assistant text. A larger message is never handed to the checker, and the status line says it was skipped |
| the command — `--input records.jsonl`, `--file PATH …`, `--diff changes.diff` | whole files, JSONL records, or the added prose lines of a unified diff | the module's own `MAX_INPUT_BYTES` — 1 MiB per record and per run |

The hook is why the module's wall clock matters at all: it runs synchronously
inside `message_end`, so time spent in the checker is time the TUI is frozen. The
message-end position runs before tool execution. The older turn-end position let
an earlier quotation reach the model. A rejected checker import clears its load
promise, so a later message retries the import. The 16 KiB bound exists for that reason and is the reason the module's slowest legal
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

- **Every rule, positively and negatively.** `PARA6`, `SEMICOLON`,
  `CONTRACTION`, `PARENTHETICAL_PAREN`, `PARENTHETICAL_DASH`, `SLASHED`,
  `PASSIVE`, `INGFORM`, `NOUNCLUSTER` and `MULTICMD` each have a case that fires
  and a case that must stay silent. Separate cases prove sentence length emits
  the configured house-style finding and the warning class remains empty.
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
whole-unit findings, including `PARA6`. The limit was set above the longest
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

The `BG5 URL boundaries keep sentence punctuation and strip URL data` check
covers the first six boundary-table rows and asserts each resulting sentence
count. The `URL query remains stripped` check covers the final semicolon-query
row. The separate `200-word prose sentence keeps telemetry and surviving
findings` check proves sentence-length telemetry remains available. Restoring
the greedy `[^\s<>()]+` tail in a throwaway copy fails the BG5 check. The
scaling roster names the revised pattern and adds a punctuation-heavy hostile
generator.

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
| suppress a sentence-length finding or populate the warning class | `writing-checker-length` |
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

# Unit-test Git fixture isolation

`test/coverage-gate.test.ts` routes Git, Node, Bash, and their descendants through
one fixture command boundary. The boundary builds a new environment from the
executable search path only. It sets an isolated home. It maps Git system and
global configuration to `/dev/null` and sets an empty command-line configuration
before the first Git command. A test may
replace `PATH` to select a trusted fake executable. Other caller environment
values cannot pass through this boundary.

Each new fixture repository checks its physical worktree, Git directory, common
directory, index, object, local configuration, hook, and refs destinations after
`git init` and before later Git writes. The permitted environment protects the
initial `git init`. The destination checks provide a second control for later
writes. A fake Git proxy delegates ordinary commands to real Git. For each real
resolution query in turn, the proxy returns an outside physical path. The test
requires refusal before configuration, index, object, or commit writes. Deleting
the proof call or any protected query makes that test continue into a marked
write and fail.

The poison regression passes repository redirects, index and object redirects,
and command-line hook configuration into the command boundary. It compares the
complete disposable decoy tree before and after the fixture run. A separate
negative control proves that an unsanitized redirect changes a decoy. Both
repositories live under a physically resolved system temporary directory. The
test helper refuses a temporary root inside the physical checkout, including a
symbolic-link alias, before it creates any fixture. The classifier-void mutant
uses the same helper. A temporary `node_modules/typescript` link preserves
resolution of the exact-pinned TypeScript package without creating scratch data
under the checkout.

`verification/run-tests.sh` protects its own real-checkout Git reads separately.
Before repository inspection or scratch creation, it physically resolves the
caller-selected temporary root. It rejects the checkout itself, any nested
checkout path, and any symbolic-link alias to either location. A copied-runner
regression uses real `mktemp` with direct and aliased checkout roots. It requires
refusal with a byte-identical copied checkout and no scratch entry.

The runner refuses inherited repository redirects, write-destination redirects,
unsafe configuration injection, executable or template selection, and every
`GIT_TRACE*` output family before its first Git call. Trace targets can append to
an arbitrary file. The safe isolated values `/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`, and `GIT_CONFIG_COUNT=0` remain valid. After the
preflight check, the runner replaces the Git system, global, and command-line
configuration sources with those safe values. Every descendant, including the
coverage gate, inherits that boundary. The refusal names every detected setting
and tells the caller to unset it. The runner does not reject unrelated Git
variables such as `GIT_PREFIX` or `GIT_SEQUENCE_EDITOR`, which normal Git
workflows may export.

The refusal regression checks every rejected setting independently. It includes
the documented Trace1 and Trace2 output targets and a future trace-family name.
A fake Git command proves refusal occurs before repository inspection. Existing
trace decoys remain byte-identical. Separate accepted-value cases prove that the
safe configuration values and unrelated workflow variables reach repository
inspection. A real coverage-gate regression puts `core.fsmonitor` in a
disposable global configuration file. Its negative control runs the monitor,
while the complete runner and gate path leaves the same file tree unchanged.


## Automated release control

`.github/workflows/release.yml` owns preparation, exact-merge continuation, proof-gated publication, promotion, final records, and recovery. `verification/release-control.mjs` is the schema-versioned state and identity authority. `verification/release-job.mjs` owns the four effect boundaries: upload, npm distribution-tag promotion, empty-cache installed-command proof, and immutable final records. The workflow calls those production commands directly.

The `release-state` branch keeps an additive history. Every request has a hash identity that includes the version, base, release-notes hash, exact coverage path set, and preparation authorization generation. A rerun keeps the workflow run identifier. A later dispatch gets a new generation, including after a terminal outcome with otherwise identical metadata. The path set has five metadata paths for an initial version change and three request paths for a corrected same-unused-version authorization. `verification/release-checks.sh` reads that set from the reviewed request. It does not rebuild the set from the version.

The state distinguishes prepared, claimed, preupload, unknown upload, byte-verified, install-proved, unknown promotion, promoted, complete, abandoned, retired, terminal mismatch, and closed-without-promotion outcomes. A GitHub run and run-attempt pair authorizes one upload. A publisher rerun with another attempt number stops before npm. Recovery from `upload-unknown` requests failed jobs and dependent jobs from the original release run. The upload rerun refuses, while proof-gated dependents can record registry and installation proof, promote, and create final records. Installation proof is read-only and may use a later run attempt. Its success or failure result binds the producing execution to the exact identity, version, release commit, parent, and verified registry integrity. A separate state writer records validated installation failures while the install job remains failed. The failed install produces `install-failure-<attempt>`. `record-install-failure` consumes that artifact under the same run attempt and commits it under `install-failures/`. Failed-job recovery reruns both jobs with one new attempt. A recorder-only rerun cannot consume the prior attempt name. Recovery from `published` state also requests failed jobs and dependent jobs. The recovery job has no upload or promotion authority. The claim is idempotent for an accepted write whose response was lost. Retirement and every irreversible effect use the exact identity, release commit, and owning stage execution. Every workflow stage carries the identity captured by its authorized launch. Operator recovery and terminal actions require both the intended version and identity. A stale artifact or late recorder cannot stamp the current identity onto its own result.

Upload uses OpenID Connect in the main-only `npm-release` environment and publishes under `slate-candidate`. Promotion begins only after registry-byte and installed-command proofs. Only the promotion job references the protected stage-only granular token. It records the expected `latest` value before the write and observes the value after the write. A conflict causes no write. An interrupted write remains unknown until recovery records the observed result. npm supplies no conditional distribution-tag write, so the workflow guarantees serialization only for its own writers.

An `upload-unknown` release may retire only when GitHub reports the sealed run attempt complete and its `upload` job complete with a non-success result for at least 60 minutes. The workflow reads the full package document with an empty npm cache. It requires earlier versions and publication times, and requires the target version absent from both `versions` and `time`. A missing package, failed read, malformed document or present version refuses without a state write. The terminal state marks upload `observed-absent`, keeps the artifact and upload execution, and permits a new identity to prepare the same unused version. Preparation also checks both `versions` and `time` and refuses package-not-found and failed reads. The gate records an observation, not proof of non-acceptance. An incorrect verdict can leave only an unpromoted `slate-candidate` version with the sealed archive. `latest` needs independent proof. A later same-version upload fails with an unknown or mismatch outcome. If the registry shows the version, use recover instead.

A byte mismatch is terminal and carries `attribution: unknown`. It does not claim that this workflow uploaded the served bytes. A proved release with a resolved conflict or superseding selection may close without promotion. A registry-verified published release with a validated installation failure may also close. The published route requires resolved upload and promotion outcomes and no active publisher or promoter. It preserves every installation attempt and consumes the version. Neither route creates an npm promotion, Git tag, or GitHub release. These terminal outcomes free the lane while preserving evidence. Late installation records cannot revive a closed identity.

`test/release-control.test.ts` directly imports the production state and effect functions. Its owned adapters record upload, promotion, install, Git, and GitHub effects. The tests cover stale identities at each stage, upload and promotion execution mismatches, retryable installation proof, durable installation failure, accepted-but-lost claims, same-version correction, terminal identical re-preparation, grouped push selection, wrong operator targets, mismatch attribution, promotion conflict and unknown state, close without promotion, and final-record conflicts. They extract and execute the production workflow run blocks for upload sealing, installation, installation-failure recording, published-state recovery, retirement, and close against closed temporary fixtures. They assert the exact producing run attempt, upload flags, registry, tag, and archive. Removing an effect command from the workflow fails the workflow contract assertion. Removing an effect inside `release-job.mjs` fails the adapter assertion.

The same test file executes the real `verification/release-checks.sh` in a temporary Git repository outside the checkout. Closed fake `npm`, `bash`, and `node` commands record the roster. The fixture checks exact order and arguments, strict flags, first-command failure propagation through `PIPESTATUS`, missing verdict refusal, permitted and forbidden coverage `WARN` boundaries, identity evidence, and final roster completeness. Replacing the typecheck command with `true` changes the command record and makes the roster audit fail.

Run the focused tests with:

```sh
node --test test/release-control.test.ts
```

Run the full release roster only in a disposable exact-release checkout with installed dependencies:

```sh
bash verification/release-checks.sh --repo . --base <exact-parent-sha> \
  --request release/requests/<version>/request.json \
  --evidence /tmp/slate-release-evidence
```

The evidence directory must be outside the checkout. The script uses an isolated home for the ladder. It treats every failed command, strict `NOT RUN`, missing final verdict, skipped or reordered roster entry, and unsupported coverage `WARN` as fatal. The evidence includes `commands.tsv`, per-command logs, a coverage disposition when needed, and the final roster identity.
