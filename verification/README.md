# Verification ladder — global model-default restore

A manual regression net for the mechanism in `extension/model-default.ts` and its
two callers, `extension/failover.ts` (orchestrator failover) and
`extension/handoff.ts` (handoff adoption).

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

No other net in the repo covers this mechanism — tier-1 CI (`AGENTS.md`
§ Tier-1 CI) typechecks, guards packaging, and checks that the extension loads
and that the resolver resolves; none of that touches a model switch, so this
ladder is the only regression net the mechanism has. It exists
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

One line per rung, then the safety verdict and a summary. The `P6` line below is
what a machine without `strace` prints; the summary is from a complete run, where
it was available:

```
RUNG R1     PASS    — failover probe-a/alpha-1⇒probe-b/beta-1 fired (model_change in session), settings byte-identical …
RUNG P6     NOT RUN — strace not available
SAFE          PASS    — real /home/you/.pi/agent/settings.json unchanged (57b3e320… 289:1785133943)
== summary: 25 pass, 0 fail, 0 not run ==
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
holder, the `P11` assertion helper, and the deliberately weakened module copies —
is **generated at run time** into `<lab>/`. Every weakened copy is derived from
the module under test by a single textual transformation, precisely so it cannot
go stale and start proving nothing. Nothing is recovered from git history and no
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

Three drive modes, chosen per rung:

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
| `LAT` | median wall clock, knob on vs off, n=7 each — informational, never a pass/fail |
| `SAFE` | the real settings file is bit-for-bit unchanged across the whole run |

Every rung that drives a switch also asserts **positive evidence that the switch
actually fired**, from the session record (`model_change`, or
`thinking_level_change` for the thinking-only paths) — not from the settings file
alone. Without that a rung passes happily when the mechanism aborted before doing
anything, which is the exact failure mode this ladder exists to catch.

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

# Worker-extension resolver checks — `run-resolver-checks.sh`

A second, much smaller net, for a different mechanism: the worker-extension
resolver in `extension/worker-extensions.ts` and the doctrine rule it feeds in
`extension/mode.ts`. The ladder above covers only the model-default machinery
and says nothing about this feature.

Unlike the ladder, this pipeline is **pure and deterministic** — it maps a host
tool registry and a list of regex patterns to a set of load units — so the
checks need no pi session and no real state at all. They run the real resolver
and the real doctrine builder (loaded through the jiti that ships with pi,
because node's strip-only TypeScript mode cannot load `state.ts`'s constructor
parameter property) against **fabricated in-memory registries** and temp-dir
package fixtures, and assert the observable result.

## Running it

```sh
bash verification/run-resolver-checks.sh --repo .   # ~0.2 s; --repo defaults to "."
```

One line per check, then a summary:

```
CHECK off-inert                  PASS — empty pattern list → shared empty set, registry never walked
CHECK unit-directory             PASS — package with a single literal entry the host runs → the package DIRECTORY is the unit
== summary: 16 pass, 0 fail ==
```

Exit status: **0** every check passed · **1** a check failed · **2** refused to
start (a missing tool, a bad `--repo`, no resolvable pi CLI, or jiti could not be
located). `node` and `mktemp` must be on `PATH`; **pi is resolved, not required on
`PATH`** — the shared order is in `AGENTS.md` § Tier-1 CI, and this script is the
one that accepts a `PATH`-resolved pi as a last resort, announcing it as a `NOTE`
line. There is no network and no writing outside a throwaway temp dir the script
removes on exit.

It deliberately carries **no version-drift guard**, unlike the load check. All it
borrows from pi is the bundled jiti: it starts no session and asserts nothing
about pi's own behaviour, and nothing in the module graph it loads
(`worker-extensions.ts`, `mode.ts` and their runtime imports — `notify.ts`,
`paths.ts`, `prompt-docs.ts`, `state.ts`) imports a pi SDK package at runtime; the
SDK imports in that graph are all `import type` and are erased at transpile time.
A jiti old enough to matter can therefore only fail to transpile, which crashes
the driver with a non-zero exit and no summary line — loud, and impossible to
mistake for a pass. The load check has the opposite exposure, since pi's rpc
output shapes *are* its evidence and a shape change would read as "no events",
which is why the pinned-version guard lives there and not here.

## What it covers

| id | what it proves |
| --- | --- |
| `off-inert` / `off-doctrine` | an empty pattern list resolves to the shared empty set without walking the registry, and the doctrine is byte-identical to the feature-off baseline |
| `cand-builtin-sdk` / `cand-missing-path` | builtin- and sdk-sourced tools, and a tool whose entry path is absent, are never candidates |
| `unit-directory` / `unit-glob-fallback` / `unit-unrun-fallback` | a single literal manifest entry the host runs yields the package directory; a glob, or a declared entry the host is not running, fall back to entry-file paths |
| `bar-self-exclude` / `bar-collision` | a unit under slate's own root is dropped even under `.*`; a unit registering a slate dispatch name or a pi built-in is dropped whole and warned, survivors intact |
| `match-*` | patterns test unanchored against source spec, unit path and each tool entry path; a non-match yields nothing; an invalid regex is dropped with a warning while its valid siblings apply |
| `inject-safety` | a newline-bearing tool name, a 2000-char label and a backtick/markdown description all render into the doctrine without breaking its structure or exceeding the caps |
| `memoization` | the memoizing resolver walks the registry exactly once across repeated calls |

It loads only those two modules, so it does **not** exercise
`extension/worker.ts`'s worker-session load path — the allowlist-mode extension
load, the `excludeTools` deny list that structurally keeps slate's dispatch
tools out of a worker, and the post-load collision re-check. Those need a live
loader and session, so the manual isolated-load smoke test
(`pi --no-extensions -e .`, see `AGENTS.md`) covers them instead; a passing run
here says nothing about them.

## Files

| file | role |
| --- | --- |
| `run-resolver-checks.sh` | the entry point: tool checks, jiti location, temp dir, exit code |
| `resolver-checks.mjs` | the driver: imports the modules through jiti, builds fixtures, runs the checks |

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`).

# Packaging guards — `run-packaging-checks.sh`

The net for what the package *ships*, and the only one in this directory that
loads no slate code at all: it makes `AGENTS.md` § Packaging rules executable.
Two layers. The **manifest shape** of `package.json` — the exact `files`
whitelist, the `docs` entry the shipped doctrine resolves at runtime, the
`pi-package` keyword the pi.dev gallery listing depends on, each pi-bundled SDK
package peer-only at `"*"` and absent from `dependencies`, and no install-time
lifecycle script. And the **real `npm pack --dry-run` output** — only allowed
file kinds, no junk or secret shapes, every doctrine doc the extension
references actually shipped, and no tarball left behind.

The second layer is not redundant with the first: npm expands a whitelisted
directory **recursively** and a `files` whitelist makes `.npmignore` and
`.gitignore` inert, so a stray file under `extension/` or `docs/` ships
invisibly behind a manifest that passes every assertion in layer one. The pack
runs with **`--ignore-scripts`**, because `npm pack` otherwise executes
`prepack`/`prepare` — and an install-time script is precisely one of the things
these guards exist to catch, so running it to check for it would be absurd.

Cheap and valid for the same reason: there is nothing to drive. Every manifest
assertion is a pure function of the parsed manifest, and every pack assertion a
pure function of the pack file list, which is what makes `--self-test` possible
— each guard is re-run against a **deep clone of the real input** carrying
exactly one violating mutation and must FAIL. Fixtures are never hand-built: an
assertion that read a misspelled field would happily pass a mutation of the real
field, so the self-test compares each clone against its source and fails on a
no-op mutation instead of reporting a green run. And a pack report with no files
would make `pack-allowed`/`pack-no-junk` vacuous, so an unreadable report is
treated as "refused to start", never as a pass.

## Running it

```sh
bash verification/run-packaging-checks.sh --repo .              # ~0.3 s; --repo defaults to "."
bash verification/run-packaging-checks.sh --repo . --self-test  # CI: prove the guards can still fail
bash verification/run-packaging-checks.sh --help
```

One line per check, then a summary:

```
CHECK files-exact                PASS — files is exactly ["extension","docs","README.md","LICENSE"] (order included), got ["extension","docs","README.md","LICENSE"]
CHECK pack-doctrine-docs         PASS — every doctrine doc derived from extension/*.ts via DOCS_DIR ships: design-principles.md, pr-publishing.md, review-rules.md, track-workflow.md — missing: none
== summary: 16 pass, 0 fail ==
```

and under `--self-test`, the same 16 ids prefixed `self-`. The verdict column
carries the meaning: PASS means the guard rejected its mutated input, which is
what was required of it.

```
== self-test: each guard must reject a real input carrying one violating mutation ==
CHECK self-files-exact           PASS — mutated the real manifest: pushed "verification" onto files → the guard rejected it, as required
CHECK self-pack-doctrine-docs    PASS — not manifest-shaped, so mutated the REAL pack list: dropped docs/design-principles.md from the shipped paths → the guard rejected it, as required
== summary: 16 pass, 0 fail ==
```

Exit status: **0** every check passed · **1** a check failed · **2** refused to
start (a missing tool, a bad `--repo`, a checkout without
`verification/packaging-checks.mjs`, or a pack report from which no file list
could be read). `node` and `npm` must be on `PATH` and that is the whole
dependency list — **no pi, no jiti, no network, no session**. It writes nothing
anywhere: the pack is a dry run, and `pack-no-tarball` is what proves it.

## What it covers

16 checks. Twelve read the manifest, four read the real pack output:

| id | what it proves |
| --- | --- |
| `files-exact` | `files` is exactly `["extension","docs","README.md","LICENSE"]`, order included — asserted by **equality**, so a deliberate whitelist change must update `FILES_EXACT` in the driver in the same commit |
| `files-docs` | `files` contains `docs` — named separately from the equality check because omitting it ships a **broken doctrine** (recorded adversarial finding), and that deserves its own verdict line |
| `keywords-pi-package` | `keywords` contains `pi-package`, which is what lists the package in the pi.dev gallery |
| `peer-pi-ai` / `nodep-pi-ai` | `@earendil-works/pi-ai` is `"*"` in `peerDependencies` and absent from `dependencies` |
| `peer-pi-agent` / `nodep-pi-agent` | the same for `@earendil-works/pi-coding-agent` |
| `peer-pi-tui` / `nodep-pi-tui` | the same for `@earendil-works/pi-tui` |
| `peer-typebox` / `nodep-typebox` | the same for `typebox` |
| `no-install-scripts` | `scripts` declares none of `prepare`/`postinstall`/`install`/`preinstall` — each would execute on **every consumer install** |
| `pack-allowed` | every shipped path is one of `package.json`, `README.md`, `LICENSE`, `docs/**/*.md`, `extension/**/*.ts` — the recursive-expansion guard, and the only thing covering docs referenced from prose alone |
| `pack-no-junk` | no shipped path matches `.env* *.log *.pem *.key *.p12 *secret* *credential* node_modules/** *.tgz .git* *.local.*` (case-insensitive; a pattern without `/` matches the basename anywhere) |
| `pack-doctrine-docs` | every doctrine doc the extension resolves at a package-resolved path ships, with the expected set **derived at run time** from the `DOCS_DIR` joins in `extension/*.ts` — see the honesty note below |
| `pack-no-tarball` | the `--dry-run` pack left no `*.tgz` in the checkout (`node_modules/` and `.git/` excluded, where cached tarballs are not ours) |

Two honest limits. `pack-doctrine-docs` **derives** its expected set from the
sources — it finds the identifiers bound to the package's own docs directory and
collects every `*.md` literal joined onto one of them — so adding a reference
extends the guard automatically, but it therefore covers exactly the four docs
referenced that way (`design-principles.md`, `pr-publishing.md`,
`review-rules.md`, `track-workflow.md`) and **not** a doc mentioned only in
prose. That narrowness is deliberate: doc names in comments, project-local
templates and runtime-computed episode names are not package-resolved doctrine
docs and must not leak into the derived set. The docs it does not name are
covered by `pack-allowed` instead, which admits `docs/**/*.md` as a kind. And
nothing here asserts *content*: a shipped doc that says the wrong thing packs
just fine.

Scope: this is a **packaging** net, so it says nothing about behaviour. It never
loads `extension/index.ts`, never starts a session, and cannot tell you whether
the shipped doctrine is correct, whether the extension loads (that is
`run-load-check.sh`) or whether it typechecks (`npm run typecheck`). It also
does not publish, log in, or contact the registry.

## Files

| file | role |
| --- | --- |
| `run-packaging-checks.sh` | the entry point: argument parsing, tool checks, `--repo` validation, exit code |
| `packaging-checks.mjs` | the driver: the manifest and pack assertions, their mutations, the derived doctrine-doc set |

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`) — which is also why
`pack-allowed`'s self-test mutation is `verification/ci-canary.ts`: shipping a
file from this directory is exactly the regression it must catch.

# Extension-load check — `run-load-check.sh`

The tier-1 net for what every other check takes for granted: that pi's runtime
loader can **load** the extension in the checkout under test, that its
`session_start` hook runs, and that the dispatch tools and the `/slate` command
really got **registered** — from THIS checkout and not from an installed copy.

It is cheap: two pi launches, about a second each, both fully offline and both
without credentials of any kind — plus one check that launches no pi at all
(`T4`, below). Each launch gets a fresh `mktemp`'d and **empty**
`PI_CODING_AGENT_DIR` (no `models.json`, no `auth.json`, so no provider exists to
call), `PI_OFFLINE=1`, `--no-extensions`, and non-model rpc requests fed from a
file so stdin is at EOF immediately; inherited credentials and pi session
variables are scrubbed out of the child environment. `PI_OFFLINE=1` is mandatory
on both runs and on the trusted one above all: `-a` makes pi read
`.pi/settings.json` and it would otherwise npm-install every package listed
there — observed hanging for 60 s and writing a `.pi/npm` directory **into the
checkout under test**, which is why `L8` and `T3` assert that directory did not
change.

It is valid because the failure modes it covers are the ones with no other
signal (`AGENTS.md` § How extension-load failures surface): an entry in
`pi.extensions` that resolves nowhere is filtered without a word, a throw in
`session_start` surfaces only as an `extension_error` event on stdout, and a
silently removed tool registration produces **no diagnostic at all**. The last
one needs a positive control, because pi 0.83.0 exposes no rpc command and no
CLI flag that enumerates registered tools: `verification/ci-canary.ts` is loaded
alongside the checkout and prints one `CI-CANARY {"tools":[…],"cwd":…,"trusted":…}`
line to stderr from inside the session. It never asserts and never throws: a
throw in a `session_start` hook does not fail the process, so a canary that
asserted by throwing could not fail CI at all — which is exactly what adversarial
review pointed out (`AD1` in that round; on the tag convention see `AGENTS.md`
§ Overview). Every assertion lives in the driver, which reads that line; `L5` and
`T1` are the guards that make a missing or empty line a failure rather than a
quiet pass.

The pi CLI comes from the resolution order shared with the resolver checks
(`AGENTS.md` § Tier-1 CI), with two deliberate differences here: there is **no**
`PATH` last resort — after `PI_BIN` and the checkout's own
`node_modules/.bin/pi` it refuses to start — and the CLI's `--version` must equal
the `@earendil-works/pi-coding-agent` pin in `devDependencies`. Both exist for the
same reason: this check asserts on pi's rpc output shapes, so it must exercise the
very pi the typecheck pins. `PI_BIN` is reported loudly in the output — an
unhardened escape hatch for people who know what they are doing, **not a security
boundary**, and not treated as one: anyone who can set it can edit the script.

## Running it

```sh
bash verification/run-load-check.sh --repo .              # ~2 s; --repo defaults to "."
bash verification/run-load-check.sh --repo . --only L4,L6
bash verification/run-load-check.sh --list-checks
bash verification/run-load-check.sh --help
```

A provenance header, one line per check, then a summary:

```
repo  = /home/you/src/ytdb-slate (9d09fa5)
pi    = /home/you/src/ytdb-slate/node_modules/.bin/pi (0.83.0, pinned 0.83.0)
lab   = /tmp/slate-loadcheck.m81mvV

CHECK L4                         PASS — the canary observed all three dispatch tools registered: thread, threads, episode
CHECK L6                         PASS — /slate is registered and attributed to /home/you/src/ytdb-slate/extension/index.ts — inside the checkout under test, so this run exercised the working tree and not an installed release
CHECK T2                         PASS — slate's config sanitizers emitted no warning for the checkout's own .pi/slate.json (they cover the shape of modelFailover, contextBudget and workerExtensions only — not the file's syntax, which is T4, nor any other key)
CHECK T4                         PASS — /home/you/src/ytdb-slate/.pi/slate.json parses as a JSON object, 4 top-level key(s): orchestratorModeDefault, workflow, modelFailover, workerExtensions

== summary: 12 pass, 0 fail ==
```

Exit status: **0** every check passed · **1** a check failed, or `--only`
matched nothing (a mistyped subset must never read as success) · **2** refused
to start. The `2` cases are worth knowing, because one of them is a **defect
reported through a different mechanism**: a deleted `extension/index.ts` (or a
deleted `verification/ci-canary.ts`) makes the driver's sentinel `die` refuse to
start rather than report a FAIL — pi would filter the nonexistent entry out of
`package.json`'s `pi.extensions` silently and start up happily, so every check
would pass vacuously and a reported failure would be impossible. The other `2`s
are environmental: a missing tool, a bad `--repo`, no resolvable pi CLI, or a
CLI-versus-pin version mismatch, whose remedy is printed with it (`run 'npm ci
--ignore-scripts'` — the same install CI does; after a deliberate pin bump that is
all it needs).

Requirements: `node` and `mktemp`; `timeout` is used when present rather than
required, purely so a hung pi cannot hang CI. Unknown `--only` ids are a hard
error (exit 2), and every abort begins `verification: refused to start — ` — the
refusal vocabulary shared by all three tier-1 wrappers, not a local convention
(see `AGENTS.md` § Tier-1 CI, which also says what a `2` does and does not mean).
Artifacts — the raw rpc stdout/stderr streams of the pi runs — live under the
scratch directory (`lab` in the header), which is removed on a clean run and
**kept**, with its path printed, when a check failed *and* a pi run actually
happened: a `T4`-only failure keeps nothing, because there would be nothing in
it (a run whose pi wrote nothing is still kept — the gate is that pi ran, not
that it said something). The scratch directory must be outside the checkout: if `TMPDIR`
points into it, the run is refused, because pi must write nothing there.

A failing run also **inlines those streams into its own stdout**, because a CI
job's scratch directory dies with the job and the path alone names something
nobody can open. The same two conditions gate it — a check failed *and* a pi run
happened — so a green run prints nothing extra and a `T4`-only failure prints no
empty sections. One delimited section per stream, only for runs that actually
launched, stderr before stdout (pi's diagnostics and the canary line are there),
each naming its run, and the `artifacts:` pointer still follows for the local
case:

```
rpc streams below, inlined because a CI scratch directory does not outlive the
job — the artifacts path at the end is only reachable on the machine that ran.
---- run2 (the trusted config run, -a) stderr — 136 bytes ----
CI-CANARY {"tools":[…],"cwd":"…","trusted":true}
---- end run2 (the trusted config run, -a) stderr ----
---- run2 (the trusted config run, -a) stdout — 982 bytes ----
{"type":"extension_ui_request",…,"method":"notify","message":"slate: ignoring …"}
---- end run2 (the trusted config run, -a) stdout ----
artifacts: /tmp/slate-loadcheck.5eHaps (raw rpc streams, kept because a check failed)
```

It is bounded so a pathological run cannot flood the log: each stream is cut at
**20000 bytes** (`STREAM_CAP`), on the last line boundary when that falls past
half the cap, and a section that was cut says so in its own header — real size,
cut size and the cap — so a truncated stream can never be read as a whole one.
Four sections therefore cost ~80 KB at worst. An empty stream prints one
`— 0 bytes (empty)` header and no body; an unreadable one says `unavailable` with
the reason. C0 control characters other than tab and newline are replaced with
`?` on the way out, since the harness promises no ANSI anywhere — the bytes in the
artifacts copy are untouched. A real cut, from a run whose pi wrote 39900 bytes to
stderr:

```
---- run1 (the untrusted load run) stderr — 39900 bytes, TRUNCATED to the first 19949 (cap 20000 bytes per stream; the whole stream is in the artifacts directory) ----
```

One piece of debris is not this script's: while pi reads the checkout's
`.pi/settings.json` it takes a lock on it — a transient
`.pi/settings.json.lock` **directory inside the working tree**, created and
removed around every access, and a bare `pi --no-extensions --mode rpc` with no
extension does it too. The script removes it on the way out only when it was
absent at startup (one that was already there belongs to somebody else's live
session, and removing it would corrupt their write), and `.gitignore` covers
`.pi/*.lock` for the case where the script — or a dogfooding session — is killed
outright before any cleanup runs.

## What it covers

12 checks. `L1`–`L8` are the untrusted load path, `T1`–`T3` the trusted (`-a`)
one, and `T4` needs no pi at all — `--only T4` launches no session, only the
version probe that resolves the CLI:

| id | what it proves |
| --- | --- |
| `L1` | pi **exited 0** loading the checkout (rpc, offline, empty agent dir, no credentials) — a real signal on pi 0.83.0, where most load failures exit 1 |
| `L2` | stderr carries **neither** `Failed to load extension` **nor** `Extension error (` — both, because the first is the reported-load-failure channel and the second the hook channel it is blind to. Its own verdict line names the two markers without reproducing them, so grepping a CI log for either literal cannot land on a green line |
| `L3` | no `extension_error` event on **stdout**, the only signal a throwing hook produces in rpc mode |
| `L4` | the canary observed all three dispatch tools registered: `thread`, `threads`, `episode` — nothing else detects their removal |
| `L5` | the canary actually reported a **non-empty** tool list, and says from where: the vacuity guard that stops `L4` passing when the canary never loaded or `session_start` moved ahead of registration |
| `L6` | the `/slate` command is registered **and attributed to a path inside the checkout under test** — the proof that the working tree ran, not an installed release |
| `L7` | `/slate on` round-trips through the command handler offline: the prompt response succeeded, a `slate-state` entry was appended, and the widget was populated |
| `L8` | `.pi/npm` in the checkout is unchanged by the run — the run stayed offline and npm-installed nothing into the working tree |
| `T1` | pi exited 0 on the trusted `-a` run **and** the canary's `trusted` field reads `true` (the driver's `canary-trusted` query) — the vacuity guard for `T2`: without granted trust slate never reads `.pi/slate.json`, so a clean `T2` would mean nothing |
| `T2` | slate's config sanitizers emitted **no warning** for the checkout's own tracked `.pi/slate.json` — and that is all it claims: only three keys have sanitizers that warn (`modelFailover`, `contextBudget`, `workerExtensions`), so a warning is the only thing a clean `T2` rules out |
| `T3` | `.pi/npm` is unchanged by the trusted run either — `PI_OFFLINE` held where `-a` would otherwise install |
| `T4` | the project config file, read straight off disk with node, **parses as JSON and has a plain-object top level** — and it PASSES when the file is absent, since a project config is optional for a consumer |

`T4` exists because `T2` structurally cannot cover it. slate's `loadConfig()` wraps
the read and the `JSON.parse` in a `try`/`catch` and accepts only a non-null,
non-array object; anything else returns `{}` and the session continues on defaults
with **nothing emitted** — no warning, no error, no event. A checkout whose
`.pi/slate.json` is `{{{` therefore looks perfectly healthy to every check that
watches pi's output, while every setting in it, `workflow.draftPRs` included, is
being dropped. Reading the file directly is the only way to see that, and it needs
no pi, no session and no trust.

The residual gap is worth stating plainly: between them `T2` and `T4` cover the
file's syntax, its top-level shape, and the *shapes* of three keys. **Unknown keys
and wrong-typed values under the unsanitized keys pass both, silently** —
`{"totallyUnknownKey": 5, "maxConcurrent": "lots"}` is a green `T4` and a green
`T2`. Nothing in tier 1 validates the config's contents; that is still on the
reader of `README.md` § Configuration.

What it does **not** cover: anything working. No check here executes a tool,
spawns a worker session, or exercises failover or handoff — it is a load and
registration check, one command round-trip and one file read. It is not a
typecheck either (`npm run typecheck` is that): jiti transpiles per module and
erases types, so a type error loads perfectly well. And the two pi runs are
rpc-mode, so nothing here speaks to the TUI. Those need the ladder, the resolver
checks, or the manual isolated-load smoke test (`pi --no-extensions -e .`, see
`AGENTS.md`).

## Files

| file | role |
| --- | --- |
| `run-load-check.sh` | the driver: pi CLI resolution and pin match, scrubbed offline rpc runs, the rpc stream parser, the direct config read, every assertion |
| `ci-canary.ts` | the positive control: a `session_start` hook that prints the registered tool set, cwd and trust to stderr and asserts nothing |

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`), and nothing in
`extension/` imports the canary — it reaches a session only because this script
passes it to pi with a second `-e`.
