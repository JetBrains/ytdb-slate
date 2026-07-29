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

# Pure-resolver checks — `run-resolver-checks.sh`

A second, much smaller net, for three subjects:

- the **worker-extension resolver** in `extension/worker-extensions.ts` and the
  doctrine rule it feeds in `extension/mode.ts`;
- the **model router** in `extension/model-router.ts` — its config sanitizer, its
  candidate resolution and warnings, and its dispatch-side effort predicate —
  together with the canonical model-spec helpers it shares with `failover.ts`,
  `episodes.ts` and `worker.ts`, which live in `extension/state.ts`;
- **structural invariants of the shipped profile table** in
  `extension/model-profiles.ts` (`profiles-*`) — shape and internal consistency
  only, never a research number.

Five modules are loaded: `worker-extensions.ts`, `mode.ts`, `model-router.ts`,
`state.ts` and `model-profiles.ts`. All five are therefore re-run triggers — and
because `state.ts`'s spec helpers are also used by `failover.ts`, a change to
**them** additionally needs the ladder above.

The ladder above covers only the model-default machinery and says nothing about
any of them.

Unlike the ladder, these pipelines are **pure and deterministic** — one maps a
host tool registry and a list of regex patterns to a set of load units, the other
maps a configured model list plus a model registry plus a profile table to an
ordered candidate set — so the checks need no pi session and no real state at
all. They run the real modules (loaded through the jiti that ships with pi,
because node's strip-only TypeScript mode cannot load `state.ts`'s constructor
parameter property) against **fabricated in-memory registries, fabricated
profile tables** and temp-dir package fixtures, and assert the observable result.

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
CHECK roster           PASS    — all 53 expected checks reported exactly once (a crashed or deleted check cannot pass silently)
== summary: 53 pass, 1 fail, 0 not run ==
```

Three output rules exist because earlier versions of this suite could pass
vacuously (findings TS1–TS3 of the Track 01 review):

- **`roster`** asserts that every expected check id reported **exactly once**. A
  section that crashes mid-way, a check that was deleted, and a check whose id
  was mistyped all surface here instead of vanishing into a clean exit.
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
| `router-load` / `profiles-load` | the two modules load at all; a failure here converts the checks below into explicit NOT RUN lines |
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
| `router-w1-canary` | a profile/registry context-window divergence warns with both values and the profile `asOf` date, and the candidate carries the **registry** value (W1/D55: the registry is the authority) |
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
`extension/state.ts` or `extension/model-profiles.ts`, and re-run the suite
against the copy (`--repo <copy>`). Each behaviour listed above has at least one
mutation that it catches — including the two that used to pass vacuously (the
dedup mechanism and the shipped-table default), the ordering tie-breaks, the
price-row selection rules, the W1 absence guards, the `nonPreferred` rule, and
the roster machinery itself (renaming or deleting a check fails `roster`). Never
mutate the repository itself; the scratch copy is the point.

It loads only those five modules, so it does **not** exercise
`extension/worker.ts`'s worker-session load path — the allowlist-mode extension
load, the `excludeTools` deny list that structurally keeps slate's dispatch
tools out of a worker, and the post-load collision re-check. Those need a live
loader and session, so the manual isolated-load smoke test
(`pi --no-extensions -e .`, see `AGENTS.md`) covers them instead; a passing run
here says nothing about them.

The router checks likewise stop at the resolver's boundary: they prove what the
resolution and the effort predicate *report*, not what a dispatch then *does*
with either. The dispatch-side enforcement and the doctrine's routing rule are
separate mechanisms with their own verification.

## Files

| file | role |
| --- | --- |
| `run-resolver-checks.sh` | the entry point: tool checks, jiti location, temp dir, `--strict`, exit code |
| `resolver-checks.mjs` | the driver: imports the modules through jiti, builds fixtures, runs the checks, prints the roster and the summary |

Like the ladder, `verification/` is not shipped (`package.json`'s `files`
whitelist is `extension`, `docs`, `README.md`, `LICENSE`).
