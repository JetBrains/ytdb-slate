# Verification ladder — global model-default restore

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

The repo has **no test suite** (see `AGENTS.md` § Build & verification), so this
ladder is the only regression net any part of the codebase has. It exists
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

One line per rung:

```
RUNG R1     PASS    — failover probe-a/alpha-1⇒probe-b/beta-1 fired (model_change in session), settings byte-identical …
RUNG P6     NOT RUN — strace not available
SAFE          PASS    — real /home/you/.pi/agent/settings.json unchanged (57b3e320… 289:1785133943)
== summary: 24 pass, 0 fail, 0 not run ==
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
| `R4a`,`R4b`,`R5a`,`R5b`,`R5c`,`G4b`,`P8`,`P9a` | a parent session, which they create on demand — no cross-rung dependency |
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

1. **End-to-end failover** — a `modelFailover` map in `<lab>/work/.pi/slate.json`
   plus `pi -e <repo> -p "say ok"`. The switch is proven from the session record
   (`model_change` entry), never from a log line — the success notice is
   deliberately UI-only.
2. **End-to-end handoff adoption** — a seeded
   `<lab>/work/.pi/slate/pending-handoff.json` whose `parentSession` matches the
   header `--fork` writes, plus `-a` for project trust.
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
| `R4a` | handoff adoption writing the thinking key **alone**, when its equality guard skips `setModel` |
| `R4b` | handoff adoption writing model *and* thinking level |
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
5. **The real settings file is fingerprinted.** sha256, size and mtime, recorded
   before the run and re-checked after; a change is a failed run (`SAFE FAIL`,
   non-zero exit) saying a pi invocation escaped the redirect. The real agent
   directory is located **the way pi locates it** — via `node os.homedir()`, which
   still works when `HOME` is unset — or from `SLATE_LADDER_REAL_AGENT_DIR`; if
   neither can be determined the script aborts rather than watch nothing.

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

A second, much smaller net, for these subjects:

- the **worker-extension resolver** in `extension/worker-extensions.ts` and the
  doctrine rule it feeds in `extension/mode.ts`;
- the **model router** in `extension/model-router.ts` — its config sanitizer, its
  candidate resolution and warnings, and its dispatch-side effort predicate;
- the **dispatch guards** in `extension/route.ts` (`route-*`) — the route planner:
  the seven guards that decide whether one dispatched action may run at all, and
  on which (model, effort) pair;
- **episode compression** in `extension/episodes.ts` (`episode-*`) — the compressor
  pin, its usability rule, the newest-Sonnet ordering, its diagnostics and the
  episode header's sanitisation. Loaded through a second loader instance with the
  pi packages aliased to local stubs (see below);
- the **model-spec vocabulary** in `extension/state.ts` (`spec-*`) — the canonical
  predicate, splitter, defect reasons and confusable annotation that the router
  shares with `failover.ts`, `episodes.ts` and `worker.ts`, plus the
  single-spec config-key sanitizer (`episodeModel`);
- the **orchestrator base-model tracker** in `extension/base-model.ts` (`base-*`)
  — the reducer that decides which model switches move the base model new worker
  threads inherit;
- **structural invariants of the shipped profile table** in
  `extension/model-profiles.ts` (`profiles-*`) — shape and internal consistency
  only, never a research number.

Eight modules are loaded: `worker-extensions.ts`, `mode.ts`, `model-router.ts`,
`route.ts`, `state.ts`, `base-model.ts`, `model-profiles.ts` and — through the
aliased loader — `episodes.ts`. All eight are therefore re-run triggers — and
because `state.ts`'s spec helpers are also used by `failover.ts`, a change to **them** additionally needs the ladder above.

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

Every router check injects **its own** registry *and* **its own** profile table,
so none of them depends on the *data* in `extension/model-profiles.ts` — with two
deliberate exceptions: `router-shipped-default`, which exists precisely to prove
the shipped table really is the default of the injected `profiles` parameter (it
reads the first profile's id *from the table*, so a research refresh cannot stale
it), and the `profiles-*` block, whose subject **is** the table. If the router or
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
CHECK off-inert        PASS    — empty pattern list → shared empty set, registry never walked
CHECK router-cheapest  PASS    — the base model is the cheapest PREFERRED candidate — a non-preferred model is skipped …
CHECK profiles-ladder  FAIL    — for every profile the ladder is a non-empty, duplicate-free subset of pi's effort vocabulary …
      observed: no violation → ["openai/gpt-5.6-luna: ladder level in neither list (minimal)"]
CHECK roster           PASS    — all 102 expected checks reported exactly once and the counters agree …
== summary: 102 pass, 1 fail, 0 not run (103 result lines = 102 expected checks + this roster audit) ==
```

### Why the summary counts one more than the roster

The `roster` line counts **expected checks**; the summary counts **result lines**,
and the roster audit is itself a result line while deliberately *not* an expected
check — it cannot appear in its own expected list, because the audit is computed
before it reports, so listing it would make it permanently "missing". A clean run
therefore prints `EXPECTED + 1` result lines.

That is the whole of the old off-by-one, and it is now **stated in the output**
rather than left to be re-derived: the summary prints the identity
(`103 result lines = 102 expected checks + this roster audit`), and on a run where it
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
start (a missing tool, a bad `--repo`, or jiti could not be located). `pi` and
`node` must be on `PATH`; there is no network and no writing outside a throwaway
temp dir the script removes on exit.

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

Model router (`extension/model-router.ts`):

| id | what it proves |
| --- | --- |
| `router-load` / `profiles-load` | the modules load at all; a failure here converts the checks below into explicit NOT RUN lines |
| `router-off` | an empty *or* absent model list yields the shared `ROUTER_OFF` result with zero warnings and without consulting the registry — the default, behaviourally identical to the pre-router extension |
| `router-unprofiled` | a model with no profile is warned about **by name** (no benchmark data ⇒ excluded) and kept out of the candidates |
| `router-malformed` | a spec that is not canonical `provider/id` is dropped with a warning that names the **reason** — including "control characters" and "leading or trailing whitespace", which the display sanitizer would otherwise strip, leaving a warning that reads like a valid name (BG2) |
| `router-unroutable` | a model pi's registry does not know, and one with no configured credentials, are each warned about and dropped — routing there could only produce billed failures |
| `router-alias-duplicate` | two specs resolving to the same profile (canonical id + alias) yield **one** candidate, the later one warned about and dropped |
| `router-all-dropped` | when every entry is dropped the router is OFF with **exactly one** summary warning on top of the per-entry ones |
| `router-order` / `router-order-ties` | ordering is tier ascending then effective input price ascending; a tier+price tie is broken by spec; a candidate with no usable price row sorts **last**, is warned about, and stays routable; a non-numeric tier sorts last instead of poisoning the comparator with `NaN` |
| `router-cheapest` | the default base model (D48) is the cheapest **preferred** candidate: a profile carrying a `nonPreferred` reason is skipped even when it is the cheapest thing on the list, while remaining a routable candidate (BG1). The **ordering** honours the same markers (DF4): non-preferred candidates, and candidates whose tier is not a sourced ordinal, sort after their comparable siblings, so a consumer walking the list cannot meet an evidentially-thin model first |
| `router-cheapest-fallback` | when *every* candidate is non-preferred a base model is still chosen (D48 requires one), the result flags it, and exactly one warning explains it with the profile's own reason |
| `router-price-date` / `router-price-rows` | the effective row is the one in force on the resolution date; overlapping rows resolve to the greatest `from`; an expired or future-only schedule falls back to the most recent past row, else the first; non-ISO dates — including a **timestamp** where a date belongs, which string comparison would accept as a valid past bound and let win the pick — are treated as absent bounds instead of being compared lexicographically |
| `router-w1-canary` | a profile/registry context-window divergence is **reported, not diagnosed** (W1/D55). The whole message is a golden master: both figures with their sources, the `asOf` date, the candidate carrying the **registry** value, the statement that routing *uses* that figure, and one sanctioned sentence declining to say which source is right. Outside that sentence no verdict word may appear anywhere, hint included — the scan strips the disclaimer first, because "which source **is correct** is not established here" is the one place the word may legitimately stand. The RI32 billing hint is appended to the same line **exactly when** the registry figure equals that model's own long-context threshold, at any figure (the threshold is read off the profile, never hardcoded), and is absent when the threshold merely differs or was never recorded. Before `98c63f3` this row asserted only two numbers, a date and the phrase "context window" — which the old message and the new one pass equally, so the change that mattered was unpinned |
| `router-w1-guards` | an absent window on either side is **not** a divergence, and neither is a registry value equal to the profile's recorded `contextWindowKnownDivergence` figure — while a third, unrecorded value still warns |
| `router-w3-unknown` | a candidate with `unknownRoutingCriticalFields` warns once, naming the model and the fields (W3/D57) |
| `router-failover-coverage` | uncovered candidates produce **one aggregate** warning naming them all (not one per model); a covered, window-aligned candidate warns about nothing at all; a map entry whose target is not a spec does not count as coverage |
| `router-warnings-echo` | on the router-**ON** path the returned `warnings` are exactly what the warn sink received, in order |
| `router-labels` | a valid spec inside a warning is length-capped (the only path where a >120-character spec is observable) and annotated with the code points when it carries confusable non-ASCII characters, e.g. a Cyrillic homoglyph; a value that can neither be JSON-stringified nor coerced to a string renders as a bounded placeholder instead of throwing |
| `router-dedup` | a condition warns at most once per resolution even when its trigger repeats — exercised through the **live** duplicate path (three identical malformed specs), since a repeated *valid* spec is skipped earlier and cannot reach the dedup at all; two values sharing a JSON form but not a type (`NaN` / `null`) stay separate conditions |
| `router-memo` | the memoizing resolver resolves once across repeated consultation, returns the same frozen object, and each warning reaches the sink once (D58) |
| `router-ladder-validation` | the ladder handed back by the profile table is filtered to pi's own effort vocabulary and de-duplicated: a foreign level reads as `off-ladder` even when the table claims a measurement at it, and a non-array ladder (what a prototype-key lookup returns) yields an empty ladder **plus** a warning rather than silent nonsense |
| `router-effort` / `router-effort-gap` / `router-effort-hard` / `router-effort-off` | the predicate returns `ok`, `not-listed`, `off-ladder` and `evidence-gap` and carries the ladder, `measured`, `listedGap` and `apiRejected`; a ladder level that is neither measured nor a listed gap reports `evidence-gap`, never a false `ok` (BG9); a level in `apiRejectedLevels` reports `off-ladder` even when it is measured and on the ladder; with the router off the predicate is inert, and an omitted effort is never a ladder complaint |
| `router-hostile` | every warning — resolver and sanitizer alike — is stripped of control/ANSI bytes and length-capped, even when fed a 5000-char profile field and an escape-bearing spec |
| `router-robust` | hostile inputs degrade instead of crashing: a throwing warn sink still leaves the memo intact, a throwing registry/profile source and a throwing `getInput` turn the router OFF (once, cached), a cyclic or 30 000-deep config value is dropped with a warning, `allowUnmeasuredEffort: false` survives, `null` config falls back to the defaults, and a non-array model list is treated as empty |
| `router-config-default` / `router-config-invalid` | an absent `router` config silently yields `{ models: [], allowUnmeasuredEffort: true }`; a wrong-shape value warns once and falls back to those defaults; invalid `models` entries are dropped one warning each; a non-boolean `allowUnmeasuredEffort` warns and stays `true`; **unknown keys are reported**, so a typo'd `"model"` cannot masquerade as an empty list (CQ1) |
| `router-shipped-default` | with `profiles` omitted the resolver really does use the shipped table — tier, ladder and price all arrive from it — and an unprofiled spec is still excluded |

Dispatch guards — the route planner (`extension/route.ts`). The **safety core** of
action-level routing, and the one place where a regression is completely silent: a
guard that stops guarding still "works", the dispatch runs and an episode is
written. Every input is fabricated, **including pi's compaction predicate**, and
the resolutions are built by the real router so candidates carry exactly what a
session's frozen resolution carries:

| id | what it proves |
| --- | --- |
| `route-load` | the module loads; a failure converts every `route-*` check into an explicit NOT RUN line |
| `route-vocabulary` | an `effort` outside pi's vocabulary is **rejected** (never clamped, never ignored), the reason names the value and the ascending level list, `THINKING_LEVELS` *is* that ascending vocabulary, a padded valid level is trimmed, and this guard runs **before** the list guard. A whitespace-only or omitted effort names no level, so one is **derived for the model that runs** (its lowest measured level) and `effortJudgedFor` names that model — it no longer resolves to nothing |
| `route-effort-type` | a **non-string** `effort` is rejected rather than read as absent — reading it as absent would silently run the action at the thread's **base** level, a substitution that looks like success. Seven shapes (number, object, array, boolean, function, cyclic, escape-bearing), each rejected with the type and value named, pi's levels offered, display-safe text and no throw; `undefined`/`null` stay absent and the base effort then applies |
| `route-list-on` | with the router ON a model outside the candidate list is rejected, naming every candidate **in resolution order** and a remediation clause naming a **listed** base to fall back to — for a listed base, for a base that was just seeded or re-seeded (the clause can no longer be empty, nor name the model it just refused), and for a thread that does not exist yet; the rejection still carries the repair's own warning; a listed model routes that action, at a level derived for it |
| `route-list-off` | with the router OFF the module is **invisible**: the list and window guards are inert, an unlisted model and a ladder-less effort pass through unwarned, the `model` argument is passed through **byte-for-byte** (padding included, so pi still owns malformed-spec errors), the thread's **pre-router pin** is the only fall-through and is `openOnly` (a pin never moves a live session, while an explicit model does), and a **stored `baseModel` resolves nothing** — the tracker and the stored base are no longer consulted on this path at all |
| `route-resolution` | a malformed, half-built (`on: true` with no candidates) or absent resolution collapses to the shared `ROUTER_OFF` constant, so the guards fall back to the pre-router path instead of walking a shape they cannot read |
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
| `route-long-context` | the long-context **billing** notice fires once per thread and model, at or above the profile's threshold, naming the threshold and the multipliers; the caller's memory suppresses the second one (and only for that model); a non-array memory degrades instead of throwing; a profile with no multiplier figures says so; and after a substitution the notice belongs to the model the action actually runs on |
| `route-failover` | a failover switch bypasses the list and effort guards entirely, never sets an effort level, keeps a **non-substituting** window check that warns and proceeds, refuses the model that just failed, and refuses an unresolved target — while a router-off session keeps its pre-router failover behaviour exactly |
| `route-lowest-effort` | the base-effort seed is the **lowest measured, non-provider-rejected** level on that model's ladder — never an evidence gap — ascending from pi's vocabulary rather than the table's authoring order, and `undefined` (pi's own default) when there is no measured level, the model is unlisted, the router is off, or the resolution is junk |
| `route-off-ladder-source` | with the router **OFF** the ladder used for effort validation comes from the caller's **injected** profile source and nothing else: it is consulted by spec, it is authoritative (a level off a **known** ladder is refused even for a spec the shipped table has never heard of — the discriminating direction), a spec it **declines** is not judged at all, an absent source, a throwing lookup and an **unreadable ladder** (throwing or non-array) are all **inert** — the level is kept, with no unmeasured marker and no warning — a foreign level is filtered out of the quoted ladder, and the module reaches the shipped table at runtime by no route at all. That last property is asserted **behaviourally first**: a REAL shipped spec (read from the table at runtime, never hard-coded) paired with a level really off ITS shipped ladder, so the injected source and the table disagree and only a planner consulting the table can be caught — with no source injected, and with a source that DECLINES the spec, which is the shape `threads.ts`'s vetted source produces for a model pi cannot serve. Two text terms back it up: no `import type`-less reference to `model-profiles.ts`, and no shipped-table VALUE (`SHIPPED_PROFILE_SOURCE`, `MODEL_PROFILES`, `findProfile`, `ladderFor`, `PROFILES_AS_OF`) imported under any name from any module — the re-export route, which needs no new import statement, only a new name on an existing one |
| `route-effort-derived-for-model` | THE ONE RULE's effort half: a level stored on the thread is inherited **only** while the action runs on the base model it was derived for. An explicit per-action model gets **that model's** own lowest measured level instead — asserted with two **disjoint** ladders, so an inheriting implementation cannot pass: it would refuse a level absent from the new model's ladder where this asserts a proceed, including under `allowUnmeasuredEffort: false` (BG14). A window substitution re-derives for the substituted model; an **explicit** level is still judged hard against the model that runs; `effortJudgedFor` always names that model |
| `route-off-invisible` | with the router OFF nothing is seeded, persisted, derived or consulted: no base model, no base effort, no re-seed signal, no derived level, the pin is `openOnly`, no router guard speaks even with a 5M-token context, a malformed argument is passed through for pi to reject — and passing the **removed** orchestrator-tracker input changes the verdict not at all, which is what "not consulted" means asserted rather than assumed. The boundary is stated positively too: the **ladder** guard is deliberately *not* invisible, and still refuses an off-ladder explicit level |
| `route-stored-effort-refresh` | a thread's stored `baseEffort` is a **cached derivation** over a table that ships with slate, so a refresh can invalidate it. It is re-checked against today's table and, when it no longer reads `ok`, **re-derived** for that model rather than replayed — for all four ways a refresh can invalidate it (evidence gap, gap under `allowUnmeasuredEffort: false`, a shrunken ladder, a provider's hard rejection), three of which used to make the thread **undispatchable** through a dispatch that named no effort at all. The correction is **silent** (nobody asked for that level) and is **not persisted** (the verdict still echoes the stored value, no re-seed is signalled — pinned as observed). A still-measured level is kept rather than re-derived, a model with no measured level yields none, and an **explicit** level keeps the full guard treatment: warned on a gap, refused under `allowUnmeasuredEffort: false`, off-ladder or API-rejected |
| `route-stored-effort-vocabulary` | a stored `baseEffort` outside pi's vocabulary — wrong case, a non-vocabulary string, a number, an object, an empty string, `null`, an array — is **discarded**, never replayed onto a dispatch: the record is an unversioned snapshot, so its declared type is a claim about the writer, and pi would clamp a junk level silently while the episode reported a level nothing ran at. The boundary is the **vocabulary itself, not the profile table**: with an unreadable ladder (nothing to re-derive from) a junk value is still gone from the verdict's own base-effort echo while a vocabulary-valid one survives it — the discriminator that a table-trusting boundary fails |
| `route-switch-decision` | the model-switch decision, whole: a **plan** target moves a live session and outranks even a held failover; an **`openOnly`** target never does — it only chose what a NEW session opened on (BG16) — and falls through to the revert rule; an action naming no model **reverts** to the session's opening model (BG22) unless a failover holds it; `no-baseline` outranks the failover stand-down; a model spec is carried **byte-for-byte** — a padded one is not normalised into a silent success and a whitespace-only one is not read as an absence that silently reverts (RG1, repinned; CQ13's one rule, shared with `planRoute` and asserted on the same value through both modules) — and every switch is labelled `plan` or `revert`, the split that tells the caller whether failing to perform it may fail the action (BG24) |
| `route-open-plan-inputs` | the plan that decides what a NEW session opens on strips **both** of the action's arguments. With `effort` left in, that plan can REJECT — an explicit level the thread's pin does not offer — and a rejection carries no model, so the session opens on the HOST and the pin is silently dropped while the real plan a moment later never complains (BG25). Asserted on both router states, plus structurally on the caller: model and effort dropped in the same override, and the open model taken from that plan so a rejection means none |
| `route-switch-opening-baseline` | the revert target is what a **model-less plan** resolves to, never what a routed open happened to use. Composed from both plans plus the decision helper: with the correct baseline the next model-less action reverts off the per-action model; with the defective one it reports `already-current` and the explicit model becomes the thread's permanent default — BG22 surviving its own first fix, on the opening path. Router-ON is shown to be immune (the base arrives as a plan target), which is why only a router-OFF fixture could ever have caught it. Two structural terms pin the caller's half: the open is planned with `model` dropped, and the baseline is read from the session that plan opened |
| `route-baseline-capture` | **TQ7** — the caller's **dataflow into** the switch decisions, which was the last hole in this track: the decisions were pinned and correct, and both flagship defects re-inserted fully green one line OUTSIDE them, because the baseline came from somewhere else, later. Pins the producer: `captureSessionBaseline` reads the SESSION object and nothing else — the caller-assembled `{ model, effort }` record the old signature took, and every argument-shaped decoy beside it (`baseModel`, `requestedModel`, `spec`, `level`), reads as **no baseline at all**. Each axis is captured independently and validated on the way in (the spec byte-for-byte per RG1, the level against pi's vocabulary per BG21); an unreadable axis is an **absent key**, which is what makes a session reporting nothing identical to `NO_SESSION_BASELINE` and to omitting the argument. Both decisions read their own axis off ONE captured object — the collapse of the two per-axis maps — and a baseline carrying only the other axis is an absence on this one. An absent baseline is `no-baseline` on both axes **even with a live value sitting right there**: that is the BG18 fallback shape, executable, and it is what a `?? current` in either decision dies on. One structural term carries the residual no type can close (below) |
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
  `route-switch-lifecycle-i1` now pin it. What remains caller-side, and is asserted
  **structurally** rather than executed, is the wiring: that `threads.ts` plans the
  session open with the `model` argument dropped, reads the baseline from the session
  that plan opened, captures both axes' baselines before any per-action switch, and
  treats a failed `revert` as non-fatal while a failed `plan` switch aborts (BG24 —
  the harness pins the decision's `source` label, not the caller's reaction to it).
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
| `episode-header` | nothing interpolated into the header can forge a line or a field: newline-bearing diagnostics, thread name and task each collapse to one line, the `|` delimiter is stripped out of a model id, every field is length-bounded, `ran:` is omitted entirely when the action produced no output, the unmeasured marker is dropped when the effort guards judged another model, and a non-string provider/id is not rendered as a model name |

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
| `wiring` | every config sanitizer is imported by `index.ts` and called at `session_start` with its own key **and the shared warn sink**. A sanitizer that exists but is never wired, or is wired with a sink that swallows its diagnostics, is precisely the silent failure RG20 was. `index.ts` cannot be *loaded* here (it reaches `@earendil-works/pi-ai` through `threads.ts` → `episodes.ts`, a peer dependency not installed in this repo), so this one asserts against the source text — weaker than execution, and still the difference between "the fix is wired" and "the fix compiles" |

Model-spec vocabulary and snapshot sanitizers (`extension/state.ts`):

| id | what it proves |
| --- | --- |
| `state-load` | the module loads; a failure converts the `spec-*` **and `state-*`** checks into explicit NOT RUN lines (both prefixes are paired with `STATE_IDS` in `VOIDABLE` — with only `spec-` there the roster's coverage audit walked past the two sanitizer checks entirely, since it filters `EXPECTED` by prefix and never notices a list member that matches none) |
| `spec-invisible` | every zero-width or direction-changing character is **rejected** by the shared predicate — controls, bidi, soft hyphen, BOM, **variation selectors** (BMP *and* astral), **tag characters** and **Hangul fillers**, the three classes the first BG2 fix missed — each named by code point in the reason; a non-breaking space reports as whitespace; a *visible* non-ASCII spec (homoglyph, emoji) is accepted and merely annotated; a valid spec still splits on the first slash |
| `spec-config-key` | an unusable `episodeModel` is dropped **with** a warning naming the key, the reason and the fallback (RG20), while absent and valid values stay silent and the returned value is unchanged from the old silent behaviour; an unstringifiable value warns instead of throwing |
| `state-thread-record` | **BG26** — `sanitizeThreadRecord`, re-run over the user's whole thread history at every session restore, and the highest-blast-radius pure function in this track: a MISSED repair throws out of the `thread` tool, a FALSE one silently destroys a thread the user still needs. Pins all three input cases per field, not just the wrong-typed one: a well-formed record round-trips **byte-identically** (key order included) and reports nothing; a bare id fills every default in silence, because absent is not a repair; each wrong type falls back to its documented default **with** a note naming the field and the type it saw (`thread t1: ignoring name (number)`). An unaddressable record is dropped **silently** — the caller owns that note. A live `status` normalises to `idle`; `episodeSeq` derives from the id count; a mixed `episodeIds` array keeps its strings. Model, pin and level are **type-checked only** by design, so a malformed-but-string spec (`"  p/x  "`, `"not a spec"`) survives untouched and reaches pi's own byte-for-byte error and `route.ts`'s vocabulary rule (CQ13/RG1, BG21) instead of being repaired here — repairing at this boundary is how a caller's error becomes a silent substitution. CQ22 is walked from the outside too: every key in the exported `ADOPTED_THREAD_FIELDS` comes back and no other, and `noteUnadoptedFields` is driven directly — a field the snapshot has and the build lost is reported as a **slate bug** by name, a deliberately refused one is not reported twice, and a key from another slate version is not reported at all |
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

`router-w1-canary` was re-validated this way after `98c63f3`, three mutants, all
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

When the planner moved the effort to the model that runs and made router-off
invisible again, the six checks that pinned the old answers were re-synced and the
whole set re-proven with **14** mutations, all killed: removing the derivation so an
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

The `route-*` checks likewise, **27 mutations, 27 killed** — one per check, plus a
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

The three switch-decision checks were proven with **11** mutations, all killed —
one per rule rather than one per check, because the helper's value is its
precedence: ignoring `openOnly` (the BG16 regression), never reverting (BG22),
dropping the failover stand-down, letting a held failover outrank a plan target,
removing the `already-current` short-circuit, and mislabelling a revert as a plan
(the BG24 split) each kill `route-switch-decision`; making the pin non-`openOnly`
and — the one that matters — planning the session OPEN *with* the model argument
kill `route-switch-opening-baseline`; and removing the effort axis's baseline,
capturing the model baseline after the switch, or not clearing it on disposal each
kill `route-switch-lifecycle-i1`. The opening-path mutation is worth singling out:
it lives in `threads.ts`, so it survived every behavioural term and died only on the
structural ones — which is precisely why those terms are there rather than a comment
saying "the caller should".

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
one mutation against the fixed code: restoring `effort` to the open plan's inputs,
which its structural term kills, because the stripping is the caller's to do.

**A second claimed kill has been withdrawn.** It read "reading a model off a rejected
plan", and it does not reproduce: written naturally
(`const openModel = modelless.model as string | undefined;`) the structural term
matches and the mutation SURVIVES — and it is a runtime no-op anyway, since a
rejection carries no `model`, so there was never a defect there to catch. Only an
artificial spelling that happened to break the regex ever "died", which is a fact
about the regex, not about the code. What the term does hold is the shape: the open
model comes from that plan. Pinning the caller's behaviour on a REJECTION is TQ4's
job, executably, once the session-open derivation is extracted.

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
partly because it "broke the harness's pinned line", and it had not. Each term is now
proven in BOTH directions — a semantically null reformatting PASSES and a
semantics-breaking edit FAILS — 14 trials, all as expected:

| term | null edit that must PASS | breaking edit that must FAIL |
| --- | --- | --- |
| shipped-table import scan | inline `{ type X }` import | a value import of the table; a namespace import of a module carrying it |
| open plan drops `model` | the `routeInputs` call hoisted to a const | `model` no longer stripped |
| open plan drops both args | a THIRD stripped key; reordered keys | `effort` no longer stripped |
| baseline from the session | the spec built by a different expression | the baseline recorded from the routed plan |
| I1 axis symmetry | `readonly` on both maps | the effort baseline dropped |
| capture ordering | a doc comment naming `applyRoute` | the model baseline captured after the switch |

All source reading for these terms goes through one helper that strips comments and
matches calls by balanced parentheses, so spelling, spacing, key order and prose can
change freely while the claim stays exactly as strong.

**Four of those six are now gone entirely**, which is the better outcome. The
dispatch side extracted `planSessionOpen`, `captureSessionBaseline` and
`decideEffortSwitch` — so what the session opens on, what is recorded as the revert
target, and the whole effort-axis lifecycle are CALLS now, not text. The regexes they
replace were deleted rather than kept beside them: a brittle term next to a real one
contributes nothing but false alarms. **Five** are gone now: TQ7 made the baseline a
branded object captured in one place, which dissolved the I1 wiring terms (both axes'
baselines declared, set, cleared, used, and captured before any per-action switch)
rather than moving them — there is one `liveBaselines` map, so there is no per-axis
ordering left to assert, and the late reading those terms watched for is no longer an
expression the call sites accept. One structural term remains, about a fact no pure
function can hold: the import scan (a back door is an import, not a value).

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
| a whole **module unloadable** (`base-model.ts`) | its load check FAILs, its 9 checks report **NOT RUN by name**, `roster` still PASSes (they *did* report), exit 1 |

And the strict semantics were verified in isolation, on a copy where one check
stands down with **no** FAIL anywhere: plain run exits **0** with `1 not run`, the
same run with `--strict` exits **1**. So a run that quietly skipped coverage cannot
read as success in automation.

Two of those mutations initially made a check **crash** rather than fail (a term
read `.reason` off a verdict that was suddenly a *proceed*). That is a worse signal
than a FAIL — it names a section, not a claim — so every reason read in this block
now goes through one helper that yields `""` for a proceed. The mutation testing is
what surfaced it; a suite that only ever runs against correct code cannot.

It loads only those eight modules, so it does **not** exercise
`extension/worker.ts`'s worker-session load path — the allowlist-mode extension
load, the `excludeTools` deny list that structurally keeps slate's dispatch
tools out of a worker, and the post-load collision re-check. Those need a live
loader and session, so the manual isolated-load smoke test
(`pi --no-extensions -e .`, see `AGENTS.md`) covers them instead; a passing run
here says nothing about them. One part of `worker.ts` *is* covered by an
automated net, but by the ladder rather than this suite: the settings isolation a
per-dispatch worker switch depends on, in rung `WK1` above.

The router and `route-*` checks stop at the **pure** boundary: they prove what the
resolution reports and what the planner *decides*, not what `threads.ts` then does
with a verdict — applying the switch to a worker session, raising an early
rejection as a tool error, aborting an apply-time one without an episode, or
remembering guard 6's once-per-pair notice. Those, and the doctrine's routing rule,
are separate mechanisms; `WK1` above covers one slice of the first.

## Files

| file | role |
| --- | --- |
| `run-resolver-checks.sh` | the entry point: tool checks, jiti location, temp dir, `--strict`, exit code |
| `resolver-checks.mjs` | the driver: imports the modules through jiti, builds fixtures, runs the checks, prints the roster and the summary |

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`).
