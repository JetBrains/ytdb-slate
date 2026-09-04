# Releasing ytdb-slate

Ten steps, numbered 0 to 9, in order. The agent owns most of them. The user owns two: the merge and the publication. Everything that reaches npm or the default branch is the user's act.

Every command block enables fail-closed shell behavior. Do not continue after a failed command unless the applicable recovery branch says to continue.

## How to read this runbook

**Steps may run in separate sessions.** The first real release ran across four agent actions. Nothing carries between them in shell variables, so no step trusts one. Step 0 writes the state file, and every block after it reloads that state, revalidates it, and re-derives the facts it gates on. A block that gates on a registry fact re-reads the registry. A typed word never unlocks anything.

**No step assumes the checkout you happen to be standing in.** This repository is worked in many worktrees at once. Run `git worktree list` to see how many there are now, and do not trust a count written in a document. Every git command names its repository with `git -C`, and every gh command names its repository with `--repo`. The release itself happens in a dedicated worktree that step 9 removes. One checkout is bound, once: step 0 records the checkout it runs in as `REPO_DIR`, and steps 1, 3, 7, 8 and 9 work in that recorded path rather than the current directory. Run step 0 in the umbrella PR branch checkout.

**Some paths have never executed.** They are marked **Untested.** where they appear, and listed under "Untested paths" below. A marked path is reviewed, not proven. Read it before you run it.

**Never set a state value by hand.** If a block stops because a state key is missing or malformed, re-run the step that writes that key. Hand-setting the value is how the first release turned a guard into a formality.

**A state file from an earlier runbook still loads.** An earlier version of this runbook wrote three keys that no step writes now: `PRIOR_VERSION`, `PINNED_AT` and `GIT_COMMON_DIR`. The state helper drops such a key on every read, prints one line on standard error saying which key it dropped, and continues. The next `save` writes the state without it. A release that was in flight across that change therefore resumes and can be repaired, and no operator has to edit a state file. Do not add a removed key back.

**`GIT_COMMON_DIR` is gone, and this is why.** The first two removed keys belonged to the removed package-pin step. The third is different. Step 0 recorded the git common directory of the recorded checkout, every later block read the state with `load` and evaluated its output, and `load` exports every key it holds. `GIT_COMMON_DIR` is a name that git itself reads from the environment, so every later git command ran with a git common directory forced by a file, and so did anything else that a block started, including `npm test`. No step and no resume-index row ever read the value. A review of this runbook found both facts, and a fabricated state file naming another repository made every `git -C` call of step 8's gate block fail with `fatal: not a git repository`. The field, its writer, its schema entry and its export are removed together, and nothing derives a git directory from the state any more. Each block names its repository with `git -C "$REPO_DIR"` instead, which is what the blocks already did.

**Declare the release once per session.** Run `export SLATE_RELEASE=<version>` before any block after step 0. Step 0 prints that line, and step 0 itself needs no declaration, because it takes the version as an argument. Every later block refuses to run without the declaration and stops if the declaration disagrees with the state behind the pointer. It is the one fact a block cannot derive — which release you mean — and it is never used as evidence for anything else.

## Before you start

Have all of this before step 0. Steps 5 and 7 act in public, and a missing tool or a missing permission is cheap to fix now and expensive to find after publication.

- **Tools on `PATH`:** bash 4 or newer (the blocks use `mapfile`, arrays and `[[ ]]`), git, GNU coreutils, `gh`, `node`, `npm`, `pi`, `tar`, `cmp`, `awk`, `sed`, `grep`, `diff`, `find`, `mktemp` and GNU `timeout`.
- **GitHub:** `gh auth status` reports you as logged in, against the host that serves this repository, with write access to it. Step 7 pushes a tag and creates a release.
- **npm:** the user who runs step 5 has an account that may publish `ytdb-slate` and can answer its two-factor prompt. The agent never needs npm credentials; it only reads the registry.
- **The registry, from this machine:** steps 0, 6, 7 and 8 read <https://registry.npmjs.org>. Step 8 must download the published tarball there, and it accepts no local substitute.
- **The registry address is pinned, not inherited.** Every registry command in this runbook passes `--registry https://registry.npmjs.org/`, and step 8's child receives the same address in `npm_config_registry`. npm reads configuration files that a scrubbed environment cannot remove, including a global file, and such a file can point npm at a mirror. An explicit address wins over every configuration file. A machine that can reach the real registry only through a mirror cannot run this runbook as written.
- **A direct connection to the registry, with nothing in the path.** Step 8 requires a direct connection from this machine to <https://registry.npmjs.org>. Three conditions put the proof out of scope. A configured proxy is the first. A transparent intercepting proxy is the second. A local registry mirror is the third. Each of them can change the bytes or the metadata that this machine receives, and step 8 then compares values that no longer describe the published artifact. Step 8 contains no proxy detection at all, and proxy support is a declared non-goal of this runbook. A proxy is administrator-controlled, so the operator resolves it at their own level and then runs step 8 from a machine with a direct connection. Step 8 states the residual risk of ignoring this precondition, and it states the three protections that survive without any detection.
- **The step 1 verification set:** run it as a normal user, not as root. The ladder needs GNU coreutils. The resolver checks need `pi` and `node`. The writing-reminder integration harness needs its checked command set, including GNU `timeout` with `--kill-after`.

## Release state

State lives outside the repository, so it survives session ends, branch switches and worktree removal:

```
${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/
  current              # one line: the absolute path of the release directory in progress
  <version>/
    release.json       # machine-written release state
    state.cjs          # state loader/writer, written by step 0
    hash.cjs           # tarball hasher, written by step 0
    release-note.md    # release notes, written before step 7
    artifact/          # the inspected tarball, retained until step 9
    registry/          # the tarball downloaded back from npm
    evidence/          # publish log, registry replies, proof evidence,
                       # escalation material
    proof.lock/        # the step 8 run lock, held for one run at a time
    checkout/          # the release worktree, detached at the squash commit,
                       # removed by step 9
```

Two files under `evidence/` belong to step 8. `proof-attempts.log` holds one `started` line and one verdict line for each attempt. `proof.json` is the proof itself: it appears only after every check of a proof attempt passed, and no later run overwrites it.

Keep the whole `<version>` directory until the release closes. Step 9 removes the worktree and clears the `current` pointer; it keeps the evidence.

## Resume index

What each step changes outside this machine, and how to find out whether it already ran. Read this before resuming a release in a new session. Where completion cannot be detected, the entry says so and the answer is to re-run the step — an index that reads as authoritative and is wrong is worse than no index.

| Step | Effect outside the repository | Determine whether it already ran |
| --- | --- | --- |
| 0 | None. Writes the release directory and the pointer. | `release.json` exists and holds your version. |
| 1 | None. | **Not detectable. Re-run it.** A bumped `package.json` shows an edit was made, not that the verification set passed; the runs leave no durable record except the load log, and a passing run yesterday says nothing about the tree today. |
| 2 | The squash merge, by the user. | `gh pr view <PR> --json mergeCommit` reports a commit. |
| 3 | Adds a worktree to this repository. | `release.json` has `SQUASH_SHA`, and `$RELEASE_DIR/checkout` exists. |
| 4 | None. | `release.json` has `TARBALL_SHA256`, and the retained tarball hashes to it. Re-running is refused after the handoff. |
| 5 | **Publishes to npm. Irreversible.** By the user. | `npm view <package>@<version> version --registry https://registry.npmjs.org/` succeeds. |
| 6 | None. Read-only; downloads the published tarball. | **Not detectable, and does not need to be.** Re-running it is the intended way to resolve it. |
| 7 | Pushes a tag and creates a GitHub release. | `git ls-remote --refs origin refs/tags/<tag>` and `gh release view <tag> --repo <repo>`. The block determines this itself before it creates anything. |
| 8 | None outside this machine. It reads the registry, and it installs the published version into a throwaway project outside every checkout. Its gate block writes into the real npm package cache. | `$RELEASE_DIR/evidence/proof.json` exists and describes this release. `release.json` then has `PROVEN_AT`, and `$RELEASE_DIR/evidence/proof-attempts.log` ends with a `proven` line. |
| 9 | Removes the worktree it added. | `git worktree list` shows no path under the release directory. |

Step 5 is the only irreversible step. Step 7 re-derives its gates on every run and detects its own prior completion. Step 8 changes nothing outside this machine, and its own attempt log stops a repeat after a verdict.

## Untested paths

These have never run. Treat any of them as a hypothesis and read the commands before executing them.

- The integrity-mismatch halt in step 6.
- The inconclusive branch and escalation in step 6.
- Every restart state in step 7 except "nothing exists yet".
- The duplicate-version tripwire in step 0.
- Step 8's `registry-unavailable` branch and its `failed` branch inside a real release. Step 8's two blocks were rehearsed against the published 0.10.0 on a workstation, and that rehearsal drove the passing path, the `inconclusive` outcome for a missing tool and for a mirror host, the `failed` outcome on corrupted artifact evidence, the interrupted success and its recovery, and the retry accounting. A later rehearsal, run after the proxy machinery was removed from this step, drove the passing path, the single `inconclusive` outcome of an integrity error, a genuine artifact disagreement that still produced `failed`, and the load of a state file written by an earlier runbook. What has never run is the human procedure after a real failed publication.
- The load of a state file written by an earlier runbook, inside a real release. The migration rule was rehearsed on a fabricated file carrying all three removed keys.
- Teardown after a failure in step 9.

## Step 0 — the agent starts the release

Run this block in the umbrella PR branch checkout. It records that checkout as `REPO_DIR`, the value is immutable, and step 1 verifies the bumped version there.

Replace every `REPLACE_*` value. The guards reject placeholders, empty values, invalid versions and an invalid PR number.

Re-running this block for the same version is safe: `init` keeps existing state and fails if a value would change. That is what makes a restart in a new session possible.

```bash
set -euo pipefail
PACKAGE='ytdb-slate'
VERSION='REPLACE_VERSION'
PR='REPLACE_PR_NUMBER'
[[ "$VERSION" != REPLACE_* && "$PR" != REPLACE_* ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$PR" =~ ^[1-9][0-9]*$ ]]
TAG="v$VERSION"

# The duplicate-version tripwire. A published version is immutable, so a number
# the registry already serves can never be published and must not start a
# release. The read must succeed: a registry this block cannot read is a
# precondition it cannot check, and it stops here rather than later. **Untested.**
PUBLISHED=$(npm view "$PACKAGE" versions --json --registry 'https://registry.npmjs.org/')
node -e '
const served = JSON.parse(process.argv[1]);
const list = Array.isArray(served) ? served : [served];
if (list.includes(process.argv[2])) throw new Error(`${process.argv[2]} is already published; start again with the next unused patch version`);
' "$PUBLISHED" "$VERSION"

REPO_DIR=$(git rev-parse --show-toplevel)
[[ "$REPO_DIR" == /* ]]
REPO=$(cd "$REPO_DIR" && gh repo view --json nameWithOwner --jq '.nameWithOwner')
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]

STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release"
RELEASE_DIR="$STATE_ROOT/$VERSION"
if [[ -f "$STATE_ROOT/current" ]]; then
  IN_PROGRESS=$(cat "$STATE_ROOT/current")
  if [[ "$IN_PROGRESS" != "$RELEASE_DIR" ]]; then
    printf 'A release is already in progress at %s. Finish it, or tear it down with step 9, before starting %s.\n' "$IN_PROGRESS" "$VERSION" >&2
    exit 1
  fi
fi
mkdir -p "$RELEASE_DIR/evidence" "$RELEASE_DIR/artifact"

cat >"$RELEASE_DIR/state.cjs" <<'CJS'
const fs = require("node:fs");
const nodePath = require("node:path");

const FIELDS = {
  PACKAGE: /^ytdb-slate$/,
  VERSION: /^[0-9]+\.[0-9]+\.[0-9]+$/,
  PR: /^[1-9][0-9]*$/,
  TAG: /^v[0-9]+\.[0-9]+\.[0-9]+$/,
  REPO: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  REPO_DIR: /^\/[^'\n]*$/,
  RELEASE_DIR: /^\/[^'\n]*$/,
  SQUASH_SHA: /^[0-9a-f]{40}$/,
  WORKTREE: /^\/[^'\n]*$/,
  TARBALL: /^\/[^'\n]*\.tgz$/,
  TARBALL_SHA256: /^[0-9a-f]{64}$/,
  TARBALL_INTEGRITY: /^sha512-[A-Za-z0-9+/]+={0,2}$/,
  REGISTRY_INTEGRITY: /^sha512-[A-Za-z0-9+/]+={0,2}$/,
  HANDOFF_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
  REGISTRY_VERIFIED_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
  TAGGED_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
  PROVEN_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
};

// Values that identify the release. Once written they are facts, not settings:
// a different value means a different release, which starts again at step 0.
const IMMUTABLE = new Set([
  "PACKAGE", "VERSION", "PR", "TAG", "REPO",
  "REPO_DIR", "RELEASE_DIR", "SQUASH_SHA", "WORKTREE",
]);
// The reference bytes may be re-derived by a re-pack, but not after the user
// has been handed a command naming them.
const SEALED_BY_HANDOFF = new Set(["TARBALL", "TARBALL_SHA256", "TARBALL_INTEGRITY"]);
// Keys that an earlier runbook wrote and no step writes now. The first two
// belonged to the removed package-pin step. GIT_COMMON_DIR was written, never
// read, and exported into every later block under a name that git itself reads
// from the environment, which forced a git common directory on every command a
// block ran. A release in flight across such a change must still load, so a
// read drops each one, says so, and continues. The next save writes the state
// without them. Nothing reads these values.
const REMOVED = new Set(["PRIOR_VERSION", "PINNED_AT", "GIT_COMMON_DIR"]);
const reportRemoved = (key) => process.stderr.write(`state: dropped ${key}, which an earlier runbook wrote and no step uses now\n`);

const [mode, statePath, ...rest] = process.argv.slice(2);
if (!mode || !statePath) throw new Error("usage: state.cjs <init|save|load> <state.json> ...");

// The pointer file is a convenience, not an identity. Every read confirms that
// the state found is the state for the release the caller named.
const takeExpected = () => {
  if (rest[0] !== "--expect") throw new Error(`${mode} needs --expect <version> naming the release you are working on`);
  const expected = rest[1];
  if (!FIELDS.VERSION.test(expected ?? "")) throw new Error(`--expect needs a version, got ${JSON.stringify(expected)}`);
  rest.splice(0, 2);
  return expected;
};

const checkIdentity = (state, expected) => {
  const directory = nodePath.resolve(nodePath.dirname(statePath));
  if (state.RELEASE_DIR !== directory) throw new Error(`state names release directory ${state.RELEASE_DIR} but was read from ${directory}`);
  if (nodePath.basename(directory) !== state.VERSION) throw new Error(`release directory ${directory} does not belong to version ${state.VERSION}`);
  if (expected !== undefined && state.VERSION !== expected) {
    throw new Error(`the pointer leads to the release of ${state.VERSION}, but you declared ${expected}; another release is in progress`);
  }
};

const readState = () => {
  if (!fs.existsSync(statePath)) return {};
  const value = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("state file is not an object");
  for (const [key, entry] of Object.entries(value)) {
    if (REMOVED.has(key)) { reportRemoved(key); delete value[key]; continue; }
    if (!FIELDS[key]) throw new Error(`state file has unknown key ${key}`);
    if (typeof entry !== "string" || !FIELDS[key].test(entry)) throw new Error(`state key ${key} is malformed: ${JSON.stringify(entry)}`);
  }
  return value;
};

const parsePairs = () => {
  const pairs = [];
  for (const argument of rest) {
    const at = argument.indexOf("=");
    if (at <= 0) throw new Error(`expected KEY=VALUE, got ${JSON.stringify(argument)}`);
    const key = argument.slice(0, at);
    const value = argument.slice(at + 1);
    if (REMOVED.has(key)) throw new Error(`state key ${key} was removed from this runbook; nothing writes it now`);
    if (!FIELDS[key]) throw new Error(`unknown state key ${key}`);
    if (!FIELDS[key].test(value)) throw new Error(`value for ${key} is malformed: ${JSON.stringify(value)}`);
    pairs.push([key, value]);
  }
  return pairs;
};

const write = (state) => {
  const ordered = Object.fromEntries(Object.keys(FIELDS).filter(key => key in state).map(key => [key, state[key]]));
  fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(ordered, null, 2)}\n`);
  fs.renameSync(`${statePath}.tmp`, statePath);
};

if (mode === "init" || mode === "save") {
  const expected = mode === "save" ? takeExpected() : undefined;
  const state = readState();
  if (mode === "save") checkIdentity(state, expected);
  for (const [key, value] of parsePairs()) {
    if (key in state && state[key] !== value) {
      if (mode === "init") throw new Error(`refusing to change ${key} from ${state[key]} to ${value}; this is a different release`);
      if (IMMUTABLE.has(key)) throw new Error(`refusing to change ${key} from ${state[key]} to ${value}; it identifies this release. If it is genuinely different, this is a different release: start again at step 0 with a new version.`);
      if (SEALED_BY_HANDOFF.has(key) && "HANDOFF_AT" in state) throw new Error(`refusing to change ${key} after the handoff at ${state.HANDOFF_AT}; the user was given a command naming the recorded bytes`);
      process.stderr.write(`state: ${key} ${state[key]} -> ${value}\n`);
    }
    state[key] = value;
  }
  if (mode === "init") checkIdentity(state, undefined);
  write(state);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
} else if (mode === "load") {
  const expected = takeExpected();
  const state = readState();
  checkIdentity(state, expected);
  for (const key of rest) {
    if (REMOVED.has(key)) throw new Error(`state key ${key} was removed from this runbook; nothing needs it now`);
    if (!FIELDS[key]) throw new Error(`unknown state key ${key}`);
    if (!(key in state)) throw new Error(`state key ${key} is not set; re-run the step that writes it`);
  }
  for (const [key, value] of Object.entries(state)) process.stdout.write(`export ${key}='${value}'\n`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
CJS

cat >"$RELEASE_DIR/hash.cjs" <<'CJS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const bytes = fs.readFileSync(process.argv[2]);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
process.stdout.write(`${sha256} ${integrity}\n`);
CJS

node "$RELEASE_DIR/state.cjs" init "$RELEASE_DIR/release.json" \
  PACKAGE="$PACKAGE" VERSION="$VERSION" PR="$PR" TAG="$TAG" \
  REPO="$REPO" REPO_DIR="$REPO_DIR" RELEASE_DIR="$RELEASE_DIR"
printf '%s\n' "$RELEASE_DIR" >"$STATE_ROOT/current"
printf 'release state: %s\n' "$RELEASE_DIR"
printf 'run this once in every session that continues this release:\n\n  export SLATE_RELEASE=%s\n' "$VERSION"
```

Every later block opens with the same five lines. They name the release, read the pointer, load the state, and stop if a required key is absent or if the state belongs to a different release:

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" VERSION)
eval "$STATE"
```

`SLATE_RELEASE` is the one thing no block can derive: which release the operator means. It is a declaration of intent, never carried evidence — a block that does not see it refuses to run, and a block whose declaration disagrees with the state behind the pointer stops rather than acting on the wrong release. Export it once per session; step 0 prints the line.

## Step 1 — the agent prepares the umbrella PR

Bump only `version` in `package.json`. Change no settings file. A release moves no pin in the checkout that step 0 recorded: its `.pi/settings.json` names the local `../../main` worktree and holds no registry entry for slate. Other checkouts of this repository are a different matter, and most of them still carry an `npm:ytdb-slate@<version>` entry that names an earlier release. Step 8 states what those entries do and do not prove. Step 8 proves the published package in a throwaway project instead. The load check below asserts the shape of that settings file, so this step does not repeat it. Follow `docs/pr-publishing.md` through the ready flip. Do not publish from the PR branch.

This block works in `REPO_DIR`, the checkout step 0 ran in; it does not use the directory you are standing in, and no release worktree exists yet. If step 0 recorded a checkout that is not the PR branch, the version assertion below stops the block. `REPO_DIR` is immutable, so the repair is to start the state again: steps 0 and 1 change nothing outside this machine, so delete the release directory printed by step 0, then run step 0 from the PR branch checkout.

**Run the full verification set, not only the typecheck.** `AGENTS.md` names several behavioral nets with distinct scopes. The typecheck is separate because it sees shapes, not behavior. A release ships every file, so step 1 runs every checked-in net and the manual smoke test:

- `npm run typecheck` checks TypeScript shapes.
- Both packaging-guard commands check the manifest and real pack list, including their self-tests.
- `bash verification/run-load-check.sh --repo .` checks working-tree loading, hooks, tools and config syntax.
- `bash verification/run-resolver-checks.sh --repo . --strict` checks pure pipelines and doctrine rendering.
- `npm test` runs the unit suite and the patch-coverage gate.
- `bash verification/run-ladder.sh --repo . --strict` checks model switches and worker settings isolation. It takes about three minutes. Do not run it as root.
- Both package-content commands check package-resolved runtime files. `AGENTS.md` requires the plain command and its `--self-test`, so this step runs both.
- `node verification/writing-check-tests.mjs` checks writing-checker correctness.
- `node verification/writing-check-scaling.mjs` checks linear growth and output caps.
- `bash verification/run-writing-reminder-check.sh --repo .` checks the real reminder hook, steer and persistence path. It requires GNU `timeout`.
- The isolated-load smoke test below provides an additional manual read of direct loader output.

The CI set remains the five checks in `AGENTS.md`. The other commands above are release-time hand-run nets.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION PR REPO_DIR)
eval "$STATE"
cd "$REPO_DIR"
[[ -z "$(git -C "$REPO_DIR" status --porcelain)" ]]

node - "$VERSION" <<'NODE'
const fs = require("node:fs");
const [version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (manifest.version !== version) throw new Error(`package version is ${manifest.version}`);
NODE

npm run typecheck
bash verification/run-packaging-checks.sh --repo .
bash verification/run-packaging-checks.sh --repo . --self-test
bash verification/run-load-check.sh --repo .
bash verification/run-resolver-checks.sh --repo . --strict
npm test
bash verification/run-ladder.sh --repo . --strict
node verification/package-content-check.mjs --repo .
node verification/package-content-check.mjs --repo . --self-test
node verification/writing-check-tests.mjs
node verification/writing-check-scaling.mjs
bash verification/run-writing-reminder-check.sh --repo .

LOAD_LOG="$RELEASE_DIR/evidence/isolated-load.log"
LOAD_STATUS=0
pi --no-extensions -e . -p exit >"$LOAD_LOG" 2>&1 || LOAD_STATUS=$?
cat "$LOAD_LOG"
printf 'pi exit status: %s\n' "$LOAD_STATUS"
if (( LOAD_STATUS != 0 )); then
  printf 'pi exited %s; that is a failure whatever the log says.\n' "$LOAD_STATUS" >&2
  exit 1
fi
if grep -Eq 'Failed to load extension|Cannot find module|SyntaxError' "$LOAD_LOG"; then
  printf 'The load log carries a failure marker; stop.\n' >&2
  exit 1
fi
```

A nonzero smoke-test exit is a failure outright. On pinned pi 0.83.0, reported direct-load failures normally exit 1 and print `Failed to load extension`. Other extension failures can remain exit 0 and use different channels. A missing file inside a package's `pi.extensions` list can stay completely silent. The marker scan is therefore a floor, not a ceiling. Read the log instead of treating three patterns as exhaustive.

That headless run proves registration and `session_start` only. It never enters orchestrator mode, so it builds no doctrine, consults no router and runs no tool or failover path. **If the release changes failover, doctrine rendering, the router, or any dispatch path, also open an interactive `pi --no-extensions -e .` session before flipping the PR to ready, and exercise `thread`, `threads` and `episode` by hand along with whatever changed.** `AGENTS.md` requires failover explicitly for this reason; the automated nets cover the resolution and the rendering, and only a live session proves the wiring runs.

Finally, re-read the full diff before requesting the merge.

## Step 2 — the user merges

The user squash-merges the umbrella PR. The agent must not merge it.

## Step 3 — the agent identifies the merged commit and creates the release worktree

Take the squash SHA from GitHub, not from recent history. If state already holds a SQUASH_SHA, it must match the freshly derived one; a mismatch means the PR was re-merged and the release must restart at step 0 with a new version.

The release worktree isolates the release from every other checkout. Nothing here switches a branch, so nothing collides with a branch that another worktree holds.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PR REPO REPO_DIR)
eval "$STATE"

git -C "$REPO_DIR" fetch origin main
SQUASH_SHA=$(gh pr view "$PR" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid')
[[ "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git -C "$REPO_DIR" rev-parse "$SQUASH_SHA^{commit}")" == "$SQUASH_SHA" ]]
git -C "$REPO_DIR" merge-base --is-ancestor "$SQUASH_SHA" origin/main

WORKTREE="$RELEASE_DIR/checkout"
if [[ -e "$WORKTREE" ]]; then
  [[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
else
  git -C "$REPO_DIR" worktree add --detach "$WORKTREE" "$SQUASH_SHA"
fi
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
[[ "$(git -C "$WORKTREE" rev-parse --is-inside-work-tree)" == 'true' ]]
[[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]

node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" SQUASH_SHA="$SQUASH_SHA" WORKTREE="$WORKTREE"
```

Stop if GitHub does not report an exact merge commit or any check fails. Ancestry alone is not proof that the intended PR produced the SHA.

Before step 4, require a successful continuous-integration run at that exact squash commit. The run must contain both matrix jobs.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" REPO SQUASH_SHA)
eval "$STATE"

RUNS=$(gh run list --repo "$REPO" --workflow ci.yml --commit "$SQUASH_SHA" --json databaseId,status,conclusion,headSha)
RUN_ID=$(node -e '
const runs = JSON.parse(process.argv[1]);
const sha = process.argv[2];
const run = runs.find(value => value.headSha === sha && value.status === "completed" && value.conclusion === "success");
if (!run) throw new Error(`no successful completed CI run at ${sha}`);
process.stdout.write(String(run.databaseId));
' "$RUNS" "$SQUASH_SHA")
JOBS=$(gh run view "$RUN_ID" --repo "$REPO" --json jobs)
node -e '
const jobs = JSON.parse(process.argv[1]).jobs;
for (const name of ["Node 22", "Node 24"]) {
  const job = jobs.find(value => value.name === name);
  if (!job || job.status !== "completed" || job.conclusion !== "success") {
    throw new Error(`${name} did not pass: ${JSON.stringify(job)}`);
  }
}
' "$JOBS"
printf 'CI run %s passed at %s with Node 22 and Node 24.\n' "$RUN_ID" "$SQUASH_SHA"
```

## Step 4 — the agent verifies and packs the exact commit

Verify the release version from the merged commit itself, then build the tarball inside the release worktree.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" VERSION SQUASH_SHA WORKTREE)
eval "$STATE"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
[[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]

node - "$WORKTREE/package.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [manifestPath, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== version) throw new Error(`merged package version is ${manifest.version}`);
NODE
```

Create and inspect the actual tarball that will be published. Do not rely on the clean source tree or a dry run. The tarball goes into the release directory, not `/tmp`: the user publishes it in a later session, and `/tmp` does not have to survive that long.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" VERSION SQUASH_SHA WORKTREE)
eval "$STATE"

# npm pack reads the working tree, not the commit. Re-derive both here, at the
# moment of packing: the earlier block's clean tree is not evidence about this one.
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
if [[ -n "$(git -C "$WORKTREE" status --porcelain)" ]]; then
  printf 'Release worktree %s is not clean; it would be packed as it stands.\n' "$WORKTREE" >&2
  git -C "$WORKTREE" status --porcelain >&2
  exit 1
fi

# Re-packing after the handoff would delete the bytes the user was told to
# publish. Refuse before touching the directory, not after.
if grep -q '"HANDOFF_AT"' "$RELEASE_DIR/release.json"; then
  printf 'The handoff already happened; the recorded bytes are sealed. Do not re-pack.\n' >&2
  exit 1
fi

PACK_DIR="$RELEASE_DIR/artifact"
rm -rf "$PACK_DIR"
mkdir -p "$PACK_DIR"
PACK_JSON=$(cd "$WORKTREE" && npm pack --json --pack-destination "$PACK_DIR")
TARBALL="$PACK_DIR/$(node -e "const x=JSON.parse(process.argv[1]);if(x.length!==1)throw Error('unexpected pack result');process.stdout.write(x[0].filename)" "$PACK_JSON")"
[[ -f "$TARBALL" ]]
tar -tzf "$TARBALL"
mkdir "$PACK_DIR/unpacked"
tar -xzf "$TARBALL" -C "$PACK_DIR/unpacked"

node - "$PACK_DIR/unpacked/package/package.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [manifestPath, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== expectedVersion) throw new Error(`packed version is ${manifest.version}`);
const sdk = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];
if (manifest.dependencies && Object.keys(manifest.dependencies).length) throw new Error("packed artifact has dependencies");
for (const name of sdk) {
  if (manifest.peerDependencies?.[name] !== "*") throw new Error(`${name} is not a peer at *`);
}
for (const name of ["typescript", "@types/node"]) {
  if (manifest.peerDependencies?.[name]) throw new Error(`${name} must stay dev-only, not a peer`);
}
if (!(manifest.keywords ?? []).includes("pi-package")) throw new Error("keywords must keep pi-package; it is what lists the package in the gallery");
NODE

for path in \
  extension/index.ts \
  README.md \
  LICENSE
do
  [[ -f "$PACK_DIR/unpacked/package/$path" ]]
done
[[ ! -e "$PACK_DIR/unpacked/package/tsconfig.json" ]]

EXPECTED_DOCS="$PACK_DIR/expected-docs.txt"
PACKED_DOCS="$PACK_DIR/packed-docs.txt"
git -C "$WORKTREE" ls-tree -r --name-only HEAD docs | sort >"$EXPECTED_DOCS"
tar -tzf "$TARBALL" | sed -n 's#^package/\(docs/.*[^/]\)$#\1#p' | sort >"$PACKED_DOCS"
(( $(wc -l <"$EXPECTED_DOCS") >= 7 ))
diff "$EXPECTED_DOCS" "$PACKED_DOCS"
for path in \
  docs/track-workflow.md \
  docs/review-rules.md \
  docs/design-principles.md \
  docs/pr-publishing.md \
  docs/model-routing.md
do
  grep -Fxq "$path" "$PACKED_DOCS"
done

HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r TARBALL_SHA256 TARBALL_INTEGRITY <<<"$HASHES"
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" \
  TARBALL="$TARBALL" TARBALL_SHA256="$TARBALL_SHA256" TARBALL_INTEGRITY="$TARBALL_INTEGRITY"
printf 'tarball:   %s\nsha256:    %s\nintegrity: %s\n' "$TARBALL" "$TARBALL_SHA256" "$TARBALL_INTEGRITY"
```

The manifest checks cover all four packaging rules in `AGENTS.md`: the four SDK packages stay peers at `*`, the typecheck's tooling stays dev-only and out of the artifact, `keywords` keeps `pi-package`, and the docs check below proves `docs/` shipped.

The docs check compares the tarball against the `docs/` tree of the merged commit and requires exact equality, so it cannot go stale when a document is added — as it did when it named five of the seven shipped documents. The floor of seven catches an empty or truncated `docs/` tree, and the named five are the documents the doctrine dereferences at runtime; a publish without them ships a broken doctrine.

`TARBALL_SHA256` and `TARBALL_INTEGRITY` are the record of the inspected bytes. `TARBALL_INTEGRITY` is in npm's own `dist.integrity` form, so step 6 compares the registry's value against it directly.

Read the `tar` listing for unexpected files as well as running the explicit checks. Stop before the handoff if the tarball is wrong.

## Step 5 — the user publishes

The agent does not publish. The npm account requires two-factor authentication, and both existing releases were published by the user after the agent could not complete the transaction. Publication is the user's step for the same reason the merge is: it needs the user's credentials and the user's consent. The agent prepares the artifact, hands over one exact command against one exact file, and verifies the result afterwards.

**The agent prints the handoff.** It hands over the absolute path of the inspected tarball and the hashes of its bytes, so both sides of the handoff refer to the same artifact:

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TARBALL TARBALL_SHA256 TARBALL_INTEGRITY)
eval "$STATE"
[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]
mkdir -p "$RELEASE_DIR/evidence"
HANDOFF_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" HANDOFF_AT="$HANDOFF_AT"
cat <<HANDOFF
Publish $PACKAGE@$VERSION. Run this command in your own terminal, so you can
answer the two-factor prompt:

  npm publish '$TARBALL' --registry https://registry.npmjs.org/

The registry address is named in the command on purpose. npm reads
configuration files that can point it at another registry, and this artifact
belongs on the public one.

The output is not redirected on purpose: npm asks for the one-time password on
the terminal, and a pipe or a file can hide the prompt or suppress it entirely.
Copy the whole console output into:

  $RELEASE_DIR/evidence/publish.log

The inspected bytes are:

  sha256     $TARBALL_SHA256
  integrity  $TARBALL_INTEGRITY

npm prints a shasum and an integrity line before it uploads. The integrity line
must equal the value above. If it does not, stop and do not confirm the upload.

Publish this file and no other. Do not repack it. Tell the agent when the
command has finished.
HANDOFF
```

**The user publishes.** Run the printed command. Complete two-factor authentication. Save the console output. Do not retry without the agent. A second attempt can repeat an accepted transaction.

**The agent waits.** It does not run `npm publish` or repack. It proceeds to step 6 after the command finishes.

Treat a reported exit status only as advisory evidence. The runbook never uses that status to decide whether the publish succeeded.

A shell may fail to run the line that reports status. The shell then reports a failure that did not happen. Within a pipeline, the shell reports the last command's status. The shell does not necessarily report the `npm publish` status.

Step 6 decides whether the publish succeeded. The registry must contain the artifact. The artifact must match what step 4 packed.

## Step 6 — the agent verifies the published artifact

This is the check the old runbook threw away: it fetched `dist.integrity` and compared it to nothing. Here the registry's integrity value is compared against the recorded integrity of the inspected bytes, and the served tarball is compared byte for byte against the retained one. A handoff can substitute a different artifact; this is what detects it.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TARBALL TARBALL_SHA256 TARBALL_INTEGRITY HANDOFF_AT)
eval "$STATE"
REGISTRY='https://registry.npmjs.org/'

# Every run reports only what it derived itself. Clear the last run's registry
# evidence before anything can fail, so no surviving file can be read as a fact
# about this result.
REGISTRY_DIR="$RELEASE_DIR/registry"
mkdir -p "$RELEASE_DIR/evidence"
rm -rf "$REGISTRY_DIR" \
  "$RELEASE_DIR/evidence/registry-view.json" \
  "$RELEASE_DIR/evidence/registry-view.err" \
  "$RELEASE_DIR/evidence/registry-result.txt"
mkdir -p "$REGISTRY_DIR"

[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]

REGISTRY_RESULT='inconclusive'
REGISTRY_INTEGRITY=''
VIEW_ERROR="$RELEASE_DIR/evidence/registry-view.err"
if VIEW_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity dist.tarball --json --registry "$REGISTRY" 2>"$VIEW_ERROR"); then
  printf '%s\n' "$VIEW_JSON" >"$RELEASE_DIR/evidence/registry-view.json"
  REGISTRY_VERSION=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$VIEW_JSON")
  REGISTRY_INTEGRITY=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$VIEW_JSON")
  if [[ "$REGISTRY_VERSION" != "$VERSION" ]]; then
    printf 'registry served version %s, expected %s\n' "$REGISTRY_VERSION" "$VERSION" >&2
  elif [[ ! "$REGISTRY_INTEGRITY" =~ ^sha512- ]]; then
    printf 'registry integrity %s is not sha512; cannot compare\n' "$REGISTRY_INTEGRITY" >&2
  elif [[ "$REGISTRY_INTEGRITY" != "$TARBALL_INTEGRITY" ]]; then
    REGISTRY_RESULT='integrity-mismatch'
  else
    if REGISTRY_JSON=$(cd "$REGISTRY_DIR" && npm pack "$PACKAGE@$VERSION" --json --pack-destination "$REGISTRY_DIR" --registry "$REGISTRY" 2>>"$VIEW_ERROR"); then
      REGISTRY_TARBALL="$REGISTRY_DIR/$(node -e "const x=JSON.parse(process.argv[1]);if(x.length!==1)throw Error('unexpected registry pack result');process.stdout.write(x[0].filename)" "$REGISTRY_JSON")"
      [[ -f "$REGISTRY_TARBALL" ]]
      CMP_STATUS=0
      cmp "$TARBALL" "$REGISTRY_TARBALL" || CMP_STATUS=$?
      if (( CMP_STATUS == 0 )); then
        REGISTRY_RESULT='verified'
      elif (( CMP_STATUS == 1 )); then
        REGISTRY_RESULT='integrity-mismatch'
      else
        printf 'cmp could not compare the files (status %s); this is not evidence of a mismatch\n' "$CMP_STATUS" >&2
      fi
    fi
  fi
fi

printf '%s\n' "$REGISTRY_RESULT" >"$RELEASE_DIR/evidence/registry-result.txt"
printf 'registry result: %s\nregistry integrity: %s\nrecorded integrity: %s\n' \
  "$REGISTRY_RESULT" "$REGISTRY_INTEGRITY" "$TARBALL_INTEGRITY"
if [[ "$REGISTRY_RESULT" == 'verified' ]]; then
  node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" \
    REGISTRY_INTEGRITY="$REGISTRY_INTEGRITY" REGISTRY_VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
```

The block clears `$RELEASE_DIR/registry/` and its three evidence files at the top, before any check can stop it. So whatever is there afterwards came from this run, on every branch: an empty `registry/` means this run downloaded nothing, and a missing `registry-view.json` means this run's `npm view` did not answer. Nothing needs a timestamp, because nothing outlives the run that wrote it.

`cmp` returns 1 for files that differ and more than 1 for a comparison it could not make — an unreadable file, a truncated download, an I/O error. Only 1 is a mismatch. Anything above it leaves the result `inconclusive`, because a failed comparison is not evidence, and reporting it as a mismatch would raise an alarm about a healthy release.

`registry-result.txt` and the recorded timestamp are a record, not a key. Steps 7 and 8 re-run the registry comparison themselves, so writing `verified` into a file or a variable unlocks nothing.

Use the matching branch:

- **`verified`.** npm serves the inspected bytes. Continue to step 7.

- **`integrity-mismatch`. Untested.** npm serves something other than the inspected artifact under an immutable version number. **Stop.** Do not tag and do not create a release.

  The runbook does not deprecate the version, move a distribution tag or unpublish anything. Those are public, irreversible acts on a package other people install, and an earlier draft of this document automated them: it read a byte difference and reached for `npm deprecate`. Review found two ways that path could fire on evidence that was stale or malformed. The action was worth less than the ways of getting it wrong, so it is gone. The runbook's job here is to put the facts in front of the user. The decision belongs to the user, and it is made outside this document.

  This run's evidence is under `$RELEASE_DIR/evidence/`: `registry-view.json`, `registry-view.err` and `registry-result.txt`, with the inspected tarball under `$RELEASE_DIR/artifact/`, the recorded hashes in `release.json`, and the downloaded tarball under `$RELEASE_DIR/registry/` — which is empty when the integrity values already differed, because the block downloads nothing once it knows they do. Nothing further needs collecting.

  Re-run step 6 once after a few minutes before reporting: a mid-propagation read can differ, and the re-run replaces the evidence with its own. Then tell the user the version, the recorded sha256 and integrity of the inspected tarball, the integrity npm serves, whether the difference is in the integrity value, in the bytes, or in both, and the path of the inspected tarball — with the downloaded one only if `$RELEASE_DIR/registry/` holds it.

  Either way this version number is spent. A published version cannot be replaced or reused, so a corrected release starts at step 0 with the next unused patch version.

- **`inconclusive`. Untested.** The block reached no conclusion. Do not publish again. Two different causes end here and they need different work, so read `registry-view.err` and the block's own stderr first and name the one you have:

  - **The registry read failed** — `npm view` errored, served another version, or served an integrity value the block could not compare. That can mean absence, propagation delay, lost permission, or a registry or network failure, and none of them is authoritative. This is what the numbered steps below are for.
  - **The local evidence collection failed** — `npm pack` could not write the download, or `cmp` could not read a file: a full disk, a permission error, an unreadable path. The registry may be perfectly healthy; the block just could not look. Fix the local condition and re-run step 6. Do not wait, and do not escalate to npm: nothing here is evidence about the publication.

  1. Preserve the evidence. It already belongs in `$RELEASE_DIR/evidence/`: `publish.log` from the user, `registry-view.err`, `registry-view.json` if this run's read answered, `registry-result.txt`. Add the recorded `sha256` and integrity from `release.json`, which is already there. This directory is outside `/tmp` and outside the repository, so it survives a reboot and a worktree removal.
  2. Wait and re-read. Re-run the step 6 block after 15 minutes, up to four times over an hour. Propagation delay resolves in that window.
  3. Widen the read once before escalating. `npm view "$PACKAGE" --json --registry "$REGISTRY"` returns the whole package document. Enumerate its `versions` array rather than trusting a single-version E404. That distinction was what identified the true state during the first release.
  4. Escalate if it is still unresolved. Open a ticket at <https://www.npmjs.com/support> against the package `ytdb-slate`. Include: the version, the publish timestamp from `publish.log`, the full publish log, the `npm view` error output, the recorded sha256 and sha512 integrity, and the question asked plainly — was the publish transaction for this version accepted?
  5. Do not retry step 5 until npm support or a registry operator confirms that the transaction was not accepted. If the version becomes visible instead, re-run step 6 and follow the branch it reports.

  Leave the release worktree in place while an escalation is open; step 9 removes it when the release closes, either way.

## Step 7 — the agent tags and creates the release

This step gates on facts it derives itself. It re-hashes the retained tarball, re-reads the registry, and compares the served integrity against the recorded integrity, before it creates anything. No inherited variable and no word written in a file can advance it — which is precisely the defect this replaces: during the first release the tag guard read a value typed in from a previous session's report.

Write the release notes to `$RELEASE_DIR/release-note.md` first. The block requires the file and refuses an empty one.

The block is restart-safe. It determines the local tag, the remote tag and the GitHub release states before creating anything, and accepts only a lightweight tag at the intended commit. **Untested** for every restart state except "nothing exists yet".

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TAG REPO REPO_DIR SQUASH_SHA TARBALL TARBALL_SHA256 TARBALL_INTEGRITY)
eval "$STATE"
REGISTRY='https://registry.npmjs.org/'

# Re-derive the artifact facts.
[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]

# Re-derive the registry facts. This is the gate, not a stored result.
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity --json --registry "$REGISTRY")
LIVE_VERSION=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$LIVE_JSON")
LIVE_INTEGRITY=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$LIVE_JSON")
[[ "$LIVE_VERSION" == "$VERSION" ]]
[[ "$LIVE_INTEGRITY" == "$TARBALL_INTEGRITY" ]]

# Re-derive the commit facts.
git -C "$REPO_DIR" fetch origin main
[[ "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C "$REPO_DIR" merge-base --is-ancestor "$SQUASH_SHA" origin/main

NOTE_FILE="$RELEASE_DIR/release-note.md"
[[ -s "$NOTE_FILE" ]]

halt_wrong_tag() {
  local location=$1 actual=$2
  printf 'SERIOUS: %s tag %s points at %s, expected %s.\n' "$location" "$TAG" "$actual" "$SQUASH_SHA" >&2
  printf 'Stop. Inspect the tag provenance and resolve the conflicting ref manually; never move, delete, or force-push it from this runbook.\n' >&2
  exit 1
}

LOCAL_TAG_EXISTS=false
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/tags/$TAG"; then
  LOCAL_TAG_EXISTS=true
  LOCAL_TAG_TYPE=$(git -C "$REPO_DIR" cat-file -t "$TAG")
  [[ "$LOCAL_TAG_TYPE" == 'commit' ]] || halt_wrong_tag 'local (non-lightweight)' "$LOCAL_TAG_TYPE"
  LOCAL_TAG_SHA=$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")
  [[ "$LOCAL_TAG_SHA" == "$SQUASH_SHA" ]] || halt_wrong_tag 'local' "$LOCAL_TAG_SHA"
fi

REMOTE_TAG_FILE=$(mktemp)
git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" >"$REMOTE_TAG_FILE"
mapfile -t REMOTE_TAG_LINES <"$REMOTE_TAG_FILE"
(( ${#REMOTE_TAG_LINES[@]} <= 1 ))
REMOTE_TAG_EXISTS=false
if (( ${#REMOTE_TAG_LINES[@]} == 1 )); then
  REMOTE_TAG_EXISTS=true
  read -r REMOTE_TAG_SHA REMOTE_TAG_REF <<<"${REMOTE_TAG_LINES[0]}"
  [[ "$REMOTE_TAG_REF" == "refs/tags/$TAG" && "$REMOTE_TAG_SHA" =~ ^[0-9a-f]{40}$ ]]
  [[ "$REMOTE_TAG_SHA" == "$SQUASH_SHA" ]] || halt_wrong_tag 'remote' "$REMOTE_TAG_SHA"
fi

RELEASE_PROBE=$(mktemp)
RELEASE_ERROR=$(mktemp)
RELEASE_EXISTS=false
if gh api --include "repos/$REPO/releases/tags/$TAG" >"$RELEASE_PROBE" 2>"$RELEASE_ERROR"; then
  RELEASE_EXISTS=true
  RELEASE_JSON=$(gh release view "$TAG" --repo "$REPO" --json tagName,targetCommitish)
  [[ "$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x.tagName)" "$RELEASE_JSON")" == "$TAG" ]]
  RELEASE_TARGET=$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x.targetCommitish)" "$RELEASE_JSON")
  [[ "$RELEASE_TARGET" == "$SQUASH_SHA" ]] || halt_wrong_tag 'release target' "$RELEASE_TARGET"
else
  RELEASE_HTTP_STATUS=$(awk 'NR == 1 { print $2 }' "$RELEASE_PROBE")
  if [[ "$RELEASE_HTTP_STATUS" != '404' ]]; then
    cat "$RELEASE_ERROR" >&2
    printf 'Cannot determine whether release %s exists; stop.\n' "$TAG" >&2
    exit 1
  fi
fi

if [[ "$RELEASE_EXISTS" == true && "$REMOTE_TAG_EXISTS" != true ]]; then
  printf 'SERIOUS: release %s exists without its expected remote tag; stop and inspect the repository state.\n' "$TAG" >&2
  exit 1
fi

if [[ "$LOCAL_TAG_EXISTS" != true ]]; then
  git -C "$REPO_DIR" tag "$TAG" "$SQUASH_SHA"
  [[ "$(git -C "$REPO_DIR" cat-file -t "$TAG")" == 'commit' ]]
  [[ "$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
fi
if [[ "$REMOTE_TAG_EXISTS" != true ]]; then
  git -C "$REPO_DIR" push origin "refs/tags/$TAG"
fi
if [[ "$RELEASE_EXISTS" != true ]]; then
  gh release create "$TAG" --repo "$REPO" --verify-tag --target "$SQUASH_SHA" \
    --title "$PACKAGE $VERSION" --notes-file "$NOTE_FILE"
fi

[[ "$(git -C "$REPO_DIR" cat-file -t "$TAG")" == 'commit' ]]
[[ "$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
[[ "$(git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
[[ "$(gh release view "$TAG" --repo "$REPO" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]
[[ "$(npm view "$PACKAGE@$VERSION" version --registry "$REGISTRY")" == "$VERSION" ]]
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" TAGGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`--target "$SQUASH_SHA"` is not decoration. Without it the release records the default branch head, which is why the last release's `targetCommitish` did not match the commit the runbook's own final check demanded. When the tag already exists the target is cosmetic — GitHub takes the commit from the tag — but the check compares it, so it must be set.

The normal restart states are these four. Nothing exists yet, so the block creates the tag, pushes it and creates the release. Only the correct local tag exists, so the block skips the creation, then pushes and releases. The correct remote tag exists with no release, so the block ensures the local tag, skips the push and creates the release. The correct remote tag and the release both exist, so the block ensures the local tag and skips both remote actions. If any existing tag or release target is wrong, stop, inspect who created it and why, and resolve it manually under repository policy. This runbook never moves or deletes a conflicting tag. The tag must point at the umbrella squash SHA, which is the commit that step 4 packed.

## Step 8 — the agent proves the published package in a throwaway project

This step is the only continuing evidence that a consumer install of this package works. No automated check in this repository installs the published package, and the umbrella checkout that a release runs from does not install it either. The `.pi/settings.json` of this checkout names the local `../../main` worktree and holds no registry entry for slate, so a session here never loads a release. Other checkouts of this repository are a different matter, and the claim is scoped to what a measurement supports. A count on 2026-09-04 found 34 worktrees of this repository on this machine. Of those, 32 carry an `npm:ytdb-slate@<version>` entry, and 2 name a local path. Each of those 32 entries names the version that its own file pins, which is an earlier release and never the version this runbook publishes. None of them is evidence about the release in hand. Read the live state with `git worktree list` and with the settings file of the checkout you care about, rather than trusting a number in this document.

**This step runs after publication only.** It never runs on a pull request, and it is not one of the five continuous-integration checks that `AGENTS.md` names. It needs a published version, and it needs the registry. A check on a pull request must need neither.

**What the proof covers.** The proof covers three facts. The published version installs from the registry. pi loads the installed extension. The extension registers its command. **The proof does not cover doctrine rendering, and it does not cover model routing.** A headless session never enters orchestrator mode, so it builds no doctrine and it consults no router. Issue 293 in this repository, at <https://github.com/JetBrains/ytdb-slate/issues/293>, tracks the deeper interactive proof. Read that limit as written. A pass here says nothing about either mechanism.

**Three isolations narrow the result, and none of them is a sandbox.** A throwaway project directory outside every checkout supplies the project scope, so no checkout's settings file takes part. A throwaway agent directory supplies the user scope, so the real user settings, the real trust record and the real model configuration take no part. A fresh empty npm cache directory supplies the download cache, so no earlier pack and no earlier install can serve the bytes. The child process starts through `env -i`, so only the values that the block names cross into it.

What those isolations do not do is stated here plainly, because an overstated isolation is worse than a narrow one:

- **npm still reads configuration files.** `env -i` removes variables and removes no file. The child keeps the global npm configuration file, whose path is `/etc/npmrc` on this machine, and it keeps the configuration built into the npm installation. A measured child with a throwaway `HOME` reported `globalconfig = "/etc/npmrc"`. Such a file can set the registry address. That is why the block pins the registry itself, and why it checks the host of the address that the registry served.
- **The child runs as the same operating-system user.** It can read every file that this user can read, and it can write every file that this user can write. `env -i` hides the names of this machine's variables, and it removes no permission.
- **This step reads the registry with the ordinary environment too.** The gate block below runs `npm view` without `env -i`, so it reads the real user npm configuration file and it writes into the real npm package cache. Only the proof block's child uses the throwaway cache.
- **The version probe touches the real agent directory.** `pi --version` in the preflight creates and removes a `settings.json.lock` directory beside the real user settings file, which moves the modification time of the real agent directory. The measured content of the real user settings file did not change.
- **The child receives no proxy variable.** The `CHILD` list names every value that crosses into the child, and no proxy value is among them. Do not add one. A machine that reaches the registry only through a proxy is out of scope for this step, which is what the precondition under "Before you start" states.

**The empty cache is the load-bearing guard, and no npm flag replaces it.** A shared cache that already holds the metadata document and the tarball of one version serves a whole install of that version while the registry is unreachable. That behaviour was measured on this machine against an unreachable registry address. The install then succeeded on the default flags, under `--prefer-offline`, and under `--prefer-online` alike. An empty cache holds nothing to serve, so the install must reach the registry or fail. The block asserts that the cache directory is empty before the install. It also asserts that the cache holds an entry for the published tarball address afterwards, and that entry is the record of the download. That second assertion is the download-address check, and it is the only check in this step that can see the bytes arriving from somewhere other than the published address. Its failure has two readings, and the first one is the serious one: nothing fetched that address. The second reading is a changed cache index layout, and naming only that one hid the first.

That guard was measured on both sides. With a fresh empty cache and an unreachable registry, the block stopped at the install and returned `registry-unavailable`. With a pre-filled cache and an unreachable registry, the same block returned `proven` while it reached no registry at all. Keep the fresh cache. It is what makes the outcome mean what it says.

The shared cache of a release machine is primed by this runbook itself. Step 0 reads the package document, step 4 packs the working tree, step 6 downloads the published tarball, and this step's gate block reads the package document again. Each of those writes an entry into the cache that npm uses by default. A measured run of step 0's read left the package document of `ytdb-slate` in the shared cache of this machine.

**The registry address is pinned, and the served host is checked.** Every registry command in this runbook passes `--registry https://registry.npmjs.org/`, and the proof block's child receives the same address in `npm_config_registry`. An explicit address wins over every configuration file, which a measurement confirmed: a child whose global configuration file set `https://mirror.invalid/` reported the pinned address when the command carried the flag. Pinning alone is not enough, so the block also reads the host out of the `dist.tarball` address that the registry served, and out of the `resolved` address that the install wrote. Both must be `registry.npmjs.org`. A mirror can otherwise answer with matching bytes and matching integrity, and the proof would then pass without reaching the real registry. A measured read against `https://registry.npmmirror.com` served this package and returned a `dist.tarball` on the mirror's own host. A host other than the expected one ends the attempt as `inconclusive`, because a mirror in the way is a local condition and says nothing about the published artifact. The host of the served address is recorded with the evidence.

**What the host assertion establishes, and what it cannot.** It establishes that the document this machine received names the expected host, in the served `dist.tarball` address and in the `resolved` address of the install alike. It cannot establish that the real registry answered. Both of those values come from a registry response, so one party that writes the response writes both, and the two then agree with each other. A mirror that is named in a configuration file writes its own host into both, and the assertion catches that. An intermediary that answers under the name `registry.npmjs.org`, and a proxy that passes the name through and changes the bytes, both leave the assertion satisfied. The integrity comparison and the download-address check below carry that part of the weight. This step detects no intermediary, and the precondition of a direct connection is what excludes one.

**The compared field is `dist.integrity`.** The block reads `version`, `dist.integrity` and `dist.tarball` from the registry metadata for this version. It compares `dist.integrity` against the `integrity` value that the install wrote into its own lock file, and against `TARBALL_INTEGRITY`, the recorded integrity of the bytes that step 4 inspected. All three values must be equal. It also compares `dist.tarball` against the `resolved` address in the same lock file.

**The pi version is pinned.** The preflight takes pi from `$REPO_DIR/node_modules/.bin/pi`, and it requires that `pi --version` equals the exact `@earendil-works/pi-coding-agent` version that the merged commit pins. The proof therefore speaks for that one pi version and for no other.

**The outcome is one of four words, and only one of them is an accusation.** The earlier version of this step had two outcomes, so a missing tool or an unwritable directory produced `failed`, and `failed` then asked for a public act against a healthy published version. The words are now these:

| word | meaning | what follows |
| --- | --- | --- |
| `proven` | every named piece of evidence appeared | continue to step 9 |
| `failed` | artifact evidence disagrees with the record | final for this version, and this version is spent |
| `registry-unavailable` | npm reported a network, server or rate-limit code in fact | wait 15 minutes and run the block again |
| `inconclusive` | the proof could not be performed | repair the local condition and run the block again |

**Only artifact evidence may produce `failed`.** Artifact evidence is an installed version, an installed integrity or a resolved address that disagrees with the registry metadata or with the inspected bytes, a wrong command source, a wrong command scope, a command path outside the throwaway project, a missing command, more than one command, or an extension error in the load session. Nothing else can reach that word. Every environment or mechanism failure produces `inconclusive` instead. `inconclusive` is not final, it requires no public act, and a fresh run after the repair is the intended answer to it.

**These failure shapes route to `inconclusive`, and this list is meant to be the whole set for the block as written.** A shape that is not here and is not artifact evidence is a defect in the block, so report it.

- Every preflight refusal: the lock held by another run, a `proof.json` that does not describe this release, a `proven` line with no `proof.json` beside it, a first `registry-unavailable` line without a timestamp, a missing `node`, `npm` or `timeout`, a `timeout` that is not the GNU one, a missing small tool from the checked list, no executable pi at the recorded checkout, a pi that reports no version, a pi version other than the pinned one, an unreadable pi pin, a scratch root that `mktemp` could not create, a scratch root inside a checkout or inside the release state, a throwaway layout that could not be built, a throwaway directory that is missing or not writable, and a throwaway cache that is not empty.
- An install that exits nonzero for a reason that is neither registry availability nor an integrity error.
- An install that reports an integrity error, on every path and without exception.
- A registry metadata read that exits nonzero for a reason other than registry availability.
- A served tarball address that is not a web address.
- A served tarball address on a host other than `registry.npmjs.org`.
- A fresh cache with no entry for the published tarball address, which is the download-address check below.
- An install that wrote no lock file.
- A comparison that could not be made: a lock file with no entry for this package, a served version other than this one, a served integrity that is not `sha512`, and a served or resolved address on another host.
- A load session that hit the 120 second timeout.
- A load session that exited nonzero and printed no load failure, which is where an unexpected exit status or unexpected output lands.
- Load evidence that could not be read: a stream line that looks like an object and does not parse, an answer that carries no command list, and a warning notification from the session.
- An attempt that stopped before it wrote its own verdict line, which the exit handler records.

**An integrity error never accuses the artifact.** npm reports the code `EINTEGRITY` when the bytes it received do not hash to the value that the metadata of the same registry names. A response that is rewritten in transit produces that code about a healthy published version, and a gate reproduced exactly that: a registry serving a doctored document for this real package made the install report an integrity error, and an earlier version of this step turned that error into `failed`, which is the verdict that leads a person toward a public deprecation. The rule is simple now. An install that reports `EINTEGRITY` ends the attempt as `inconclusive`, on every path and without exception, because this step cannot tell a fault in the path from a fault at the registry, and neither of them is a defect of the published artifact. The message names the precondition of a direct connection and asks the operator to satisfy it before the next run.

**Proxy support is a non-goal, and this is the residual risk.** This step contains no proxy detection. A person who ignores the precondition and runs the proof behind a rewriting proxy can therefore receive `failed` on a healthy published artifact. The installed version, the installed integrity or the resolved address can disagree with the record for a reason that sits in the path and not in the artifact, and this step cannot see that reason. The risk is accepted, and it is written here rather than hidden. Every earlier attempt to detect a proxy and reason about it opened more defects than it closed, so the detection is gone. Satisfy the precondition instead.

Three protections survive, and none of them needs any detection.

- An install that reports an integrity error ends the attempt as `inconclusive`. That is the shape a rewriting proxy produces most often.
- A served or resolved address on a host other than `registry.npmjs.org` is a local fault, and it ends the attempt as `inconclusive`. Both host checks stay in the comparison script.
- A fresh cache with no entry for the published tarball address ends the attempt as `inconclusive`. That is the download-address check, and it is what an intermediary answering from somewhere else looks like.

The load session is a different case. It runs only after the installed bytes matched the bytes step 4 inspected, so a finding there is about the artifact and not about the transfer.

A gate assertion in the first block is not a verdict. That block compares the served integrity against the recorded integrity with a plain shell test, so anything in the path that changes a served value stops it with a failed assertion and no outcome word. Such a stop records no attempt and says nothing about the artifact.

**The preflight runs before any attempt is recorded.** It resolves `node`, `npm`, GNU `timeout` and the pinned pi, and it passes each resolved location to the child, so the child's fixed search path cannot lose one. It also takes the run lock, checks the log for an existing verdict, checks the retry budget, and builds the throwaway layout. A preflight refusal reports `inconclusive`, records no attempt, and spends nothing. Its exit code is 2.

**One run at a time, enforced by a lock.** The attempt log is an append-only counter, so two runs would read the same count and both write attempt 3. The block therefore creates `$RELEASE_DIR/proof.lock` with `mkdir`, which either succeeds for exactly one run or fails for every other one. A second run refuses with `inconclusive` and names the lock. A run that is killed with an uncatchable signal leaves the directory behind, and the repair is to confirm that no proof is running and then remove that one directory by hand.

**Attempt verdicts, as measured.** The intended rule is one verdict line for each recorded attempt. An exit handler writes `inconclusive` for an attempt that stopped before its own verdict line, and it covers an early exit, a caught interrupt signal and a caught terminate signal. Two measured shapes break that rule, and a reader of the attempt log must know both. An earlier version of this section claimed the rule held with one exception, and that claim was not true.

The first shape is a missing verdict. A signal that no shell can catch, a power loss, or a killed shell leaves a `started` line with no verdict line under it. The next run does not report that gap, and this was measured. A log holding one `started` line for attempt 1 and no verdict made the next run record itself as attempt 2, print nothing about attempt 1 and finish normally. The dangling line stays in the log, and the raw streams of the killed attempt stay under `$RELEASE_DIR/evidence/`.

The second shape is two verdicts for one attempt, and this was measured too. A terminate signal that arrives after `proof.json` is renamed into place, and before the `proven` line is written, makes the exit handler record `inconclusive` for that attempt. `proof.json` is already in place, so the next run takes the interrupted-success path, counts the `started` lines, and appends a `proven` line under the same attempt number. Attempt 1 then carries an `inconclusive` line and a `proven` line, in that order.

Read an attempt log by these three rules. The presence of `proof.json` decides the outcome, because that file is renamed into place only after every check passed. A `proven` line that follows an `inconclusive` line for the same attempt number is the record of that repair, and it is not a second attempt. A `started` line with no verdict line under it is the record of an attempt that was killed. Count attempts by their `started` lines and never by their verdict lines, which is what the block itself does. The retry bound counts `registry-unavailable` lines only, so neither shape spends any part of it.

**The retry bound counts registry unavailability only.** At most four attempts may end `registry-unavailable`, and the hour is measured from the first such attempt. An `inconclusive` attempt spends nothing, because a local fault is not a reason to stop retrying a healthy release. The block refuses to start after a `failed` verdict, so no retry can bury one.

**Evidence retention, and redaction.** A successful attempt keeps `$RELEASE_DIR/evidence/proof.json` and deletes its own raw streams and its own throwaway directories. A failed or inconclusive attempt keeps its raw streams under `$RELEASE_DIR/evidence/proof-attempt-<n>.*`, keeps its throwaway root, and prints both paths. A later success never deletes the evidence of an earlier attempt.

Every retained value passes through one redaction, because a registry address can carry a credential and this evidence outlives the run. The redaction runs four passes, in this order.

1. It replaces the userinfo before the host.
2. It replaces the value of a query or fragment parameter whose name is a credential name, whatever the letter case of that name. The covered names are `access_key`, `access_token`, `api_key`, `api-key`, `apikey`, `auth`, `auth_token`, `authorization`, `authtoken`, `client_secret`, `credential`, `credentials`, `deploy_token`, `id_token`, `job_token`, `key`, `otp`, `passcode`, `passwd`, `password`, `personal_access_token`, `private_token`, `pwd`, `refresh_token`, `secret`, `secret_key`, `session_token`, `sig`, `signature` and `token`. That set covers the names used by npm, by GitHub, by GitLab, and by the OAuth 2.0 and OpenID Connect specifications. `private_token` is the GitLab name, and an earlier version of this pass missed it.
3. It replaces a token-shaped value wherever it sits, which includes a query string, a fragment and a path segment. A token-shaped value is an npm token, a GitHub token, or a GitHub fine-grained personal access token. Each one is recognised by its own prefix and by the length and the character set of its body. A benign configuration name such as `npm_config_prefer_offline` is not token-shaped, and this pass leaves it alone.
4. It replaces the value of an npm configuration key that carries a credential. Those keys are `_auth`, `_authToken` and `_password`, in the shape a user configuration file uses.

Passes 2, 3 and 4 stop at a double quote, so a JSON line still parses after the redaction. Two things survive on purpose. An integrity value survives, because it is the evidence this step compares. A credential that looks like an ordinary path segment survives too, because no pattern separates it from a package name, so keep a credential out of a path segment. The shell version inside the block and the Node version inside the evidence script run the same four passes. A table of 26 inputs, run through both versions, produced identical output, and that table includes every defect that a review of the earlier passes found.

**The success commit is interruption-safe.** `proof.json` is written under the attempt's own name and then renamed into place inside the same directory, so it appears whole or not at all, and it appears only after every check passed. Its presence is therefore the proof. A resumed run never overwrites it: the preflight validates it against this release and then finishes the bookkeeping that the interruption left undone, without repeating the proof. A `proven` line in the log with no `proof.json` beside it is the opposite case, and the preflight refuses that state for a person to inspect.

**How to read the result.** A pass prints `verdict: proven` as its last line on standard output. Every other outcome writes its verdict line to standard error, followed by the paths of the retained evidence, so the verdict is neither the last line nor on the same stream. Read the exit code and the last line of `$RELEASE_DIR/evidence/proof-attempts.log` instead:

| exit code | meaning |
| --- | --- |
| 0 | `proven` |
| 1 | `failed`, or a refusal that reports a verdict the log already holds |
| 2 | the proof was not performed: a preflight refusal, `inconclusive`, or `registry-unavailable` |

The first block holds the gates. It re-derives every published fact, and it stops before the proof when one disagrees. This is the combined recheck that the removed pin step used to carry at its tail, and no stored word advances it. It uses the ordinary environment, so it reads the real user npm configuration file and writes into the real npm package cache.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TAG REPO REPO_DIR SQUASH_SHA TARBALL_INTEGRITY)
eval "$STATE"
REGISTRY='https://registry.npmjs.org/'
REGISTRY_HOST='registry.npmjs.org'

git -C "$REPO_DIR" fetch origin main --tags
[[ "$(git -C "$REPO_DIR" cat-file -t "$TAG")" == 'commit' ]]
[[ "$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
[[ "$(git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
[[ "$(gh release view "$TAG" --repo "$REPO" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity dist.tarball --json --registry "$REGISTRY")
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$LIVE_JSON")" == "$VERSION" ]]
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$LIVE_JSON")" == "$TARBALL_INTEGRITY" ]]
LIVE_TARBALL=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.tarball"] ?? x.dist?.tarball ?? ""))' "$LIVE_JSON")
LIVE_HOST=${LIVE_TARBALL#*://}
LIVE_HOST=${LIVE_HOST%%/*}
LIVE_HOST=${LIVE_HOST##*@}
LIVE_HOST=${LIVE_HOST%%:*}
if [[ "$LIVE_HOST" != "$REGISTRY_HOST" ]]; then
  printf 'The registry served a tarball address on host %s, and this runbook expects %s.\n' "$LIVE_HOST" "$REGISTRY_HOST" >&2
  printf 'That is a local condition and not an artifact defect. Remove the mirror from the path, then run this block again.\n' >&2
  exit 2
fi
printf 'gates passed: the local tag, the remote tag, the release target, the registry version, the registry integrity and the registry host (%s) all agree.\n' "$LIVE_HOST"
```

The second block holds the proof. It runs once for each attempt.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION REPO_DIR WORKTREE TARBALL_INTEGRITY)
eval "$STATE"
REGISTRY='https://registry.npmjs.org/'
REGISTRY_HOST='registry.npmjs.org'
mkdir -p "$RELEASE_DIR/evidence"
ATTEMPTS="$RELEASE_DIR/evidence/proof-attempts.log"
PROOF="$RELEASE_DIR/evidence/proof.json"
LOCK_DIR="$RELEASE_DIR/proof.lock"
touch "$ATTEMPTS"

# A local fault must never read as an artifact defect, so the two refusals are
# separate. refuse_local ends the run as inconclusive: no attempt is recorded,
# nothing is spent, and no public act follows. refuse_verdict reports a verdict
# that the log already holds.
refuse_local() {
  printf 'preflight refused: %s\n' "$*" >&2
  printf 'outcome: inconclusive\nNo attempt was recorded and none was spent. Repair the condition, then run this block again.\n' >&2
  exit 2
}
refuse_verdict() {
  printf 'preflight refused: %s\n' "$*" >&2
  exit 1
}
# A credential can sit in several places inside a web address, and this evidence
# outlives the run, so all four passes below are needed. The first replaces the
# userinfo before the host. The second replaces the value of a credential-named
# parameter in a query string or in a fragment, and its name list includes the
# GitLab name private_token. The third replaces a token-shaped value wherever it
# sits, including a path segment; it matches a prefix plus a body of the right
# length and character set, so a benign name such as npm_config_prefer_offline
# is left alone. The fourth covers the npm configuration keys that carry a
# credential. Passes 2, 3 and 4 stop at a double quote, so a JSON line still
# parses after the redaction. A credential that looks like an ordinary path
# segment survives, because no pattern separates it from a package name, and an
# integrity value survives on purpose, because it is the evidence.
redact() {
  sed -E -e 's%//[^/@[:space:]]*@%//REDACTED@%g' \
    -e 's%([?&;#](access_key|access_token|api_key|api-key|apikey|auth|auth_token|authorization|authtoken|client_secret|credential|credentials|deploy_token|id_token|job_token|key|otp|passcode|passwd|password|personal_access_token|private_token|pwd|refresh_token|secret|secret_key|session_token|sig|signature|token)=)[^&;#[:space:]"]*%\1REDACTED%gI' \
    -e 's%(npm_[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{32,}|github_pat_[A-Za-z0-9_]{40,})%TOKEN_REDACTED%g' \
    -e 's%((:?_auth(Token)?|_password)[[:space:]]*=[[:space:]]*)[^[:space:]"]+%\1REDACTED%gI'
}

# --- the preflight. Nothing below it is recorded until it passes. ---

# One run at a time. The attempt log is an append-only counter, so two runs
# would read the same count and both write the same attempt number.
mkdir "$LOCK_DIR" 2>/dev/null || refuse_local "another proof run holds the lock at $LOCK_DIR. Run one proof at a time. If a run was killed, make sure that no proof is running, then remove that directory."
ATTEMPT=0
ATTEMPT_RECORDED=false
VERDICT_WRITTEN=false
PROOF_ROOT=''
finish() {
  local status=$?
  # Exactly one verdict for every recorded attempt, including on a path that
  # exits before its own verdict line.
  if [[ "$ATTEMPT_RECORDED" == true && "$VERDICT_WRITTEN" != true ]]; then
    printf '%s %s attempt %s inconclusive\n' "$(date -u +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ATTEMPT" >>"$ATTEMPTS"
    printf 'The attempt stopped before it recorded a verdict, so the log now reads inconclusive for attempt %s.\n' "$ATTEMPT" >&2
  fi
  # A preflight refusal leaves no throwaway directory behind.
  if [[ "$ATTEMPT_RECORDED" != true && -n "$PROOF_ROOT" ]]; then rm -rf "$PROOF_ROOT"; fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
  return "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if grep -q ' failed$' "$ATTEMPTS"; then
  cat "$ATTEMPTS" >&2
  refuse_verdict 'an earlier attempt returned failed on artifact evidence. Read "If the proof fails" below, and do not retry.'
fi

# proof.json is renamed into place after every check passed, so its presence is
# the proof. A resumed run finishes the bookkeeping and never overwrites it.
if [[ -f "$PROOF" ]]; then
  PROOF_OK=0
  node - "$PROOF" "$PACKAGE" "$VERSION" "$TARBALL_INTEGRITY" "$REGISTRY_HOST" <<'NODE' || PROOF_OK=$?
const fs = require("node:fs");
const [proofPath, name, version, recorded, host] = process.argv.slice(2);
const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
const differs = (actual, expected) => String(actual) !== String(expected);
if (differs(proof.package, name)) throw new Error(`the proof names package ${proof.package}`);
if (differs(proof.version, version)) throw new Error(`the proof names version ${proof.version}`);
if (differs(proof.installedIntegrity, recorded)) throw new Error(`the proof names installed integrity ${proof.installedIntegrity}`);
if (differs(proof.registryIntegrity, recorded)) throw new Error(`the proof names registry integrity ${proof.registryIntegrity}`);
if (differs(proof.registryHost, host)) throw new Error(`the proof names registry host ${proof.registryHost}`);
if (differs(proof.command, "slate")) throw new Error(`the proof names command ${proof.command}`);
NODE
  (( PROOF_OK == 0 )) || refuse_local "$PROOF exists and does not describe this release. Inspect it by hand. This block overwrites no proof evidence."
  if grep -q ' proven$' "$ATTEMPTS" && grep -q '"PROVEN_AT"' "$RELEASE_DIR/release.json"; then
    cat "$PROOF"
    refuse_verdict "the proof already passed for $PACKAGE@$VERSION, and its evidence is at $PROOF."
  fi
  if ! grep -q ' proven$' "$ATTEMPTS"; then
    printf '%s %s attempt %s proven\n' "$(date -u +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$(grep -c ' started$' "$ATTEMPTS" || true)" >>"$ATTEMPTS"
  fi
  grep -q '"PROVEN_AT"' "$RELEASE_DIR/release.json" \
    || node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PROVEN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat "$PROOF"
  printf 'verdict: proven (an interrupted success was completed, and the proof was not repeated)\n'
  exit 0
fi
if grep -q ' proven$' "$ATTEMPTS"; then
  refuse_local "the log holds a proven verdict and $PROOF is missing, so the evidence of that pass is gone. Inspect the release directory by hand before any further run."
fi

# The retry bound exists for registry propagation delay and for nothing else,
# so only attempts that really ended registry-unavailable count against it.
WAITS=$(grep -c ' registry-unavailable$' "$ATTEMPTS" || true)
if (( WAITS >= 4 )); then
  cat "$ATTEMPTS" >&2
  refuse_verdict 'four attempts already ended registry-unavailable. Stop, and escalate as step 6 describes.'
fi
if (( WAITS > 0 )); then
  FIRST_WAIT=$(awk '/ registry-unavailable$/ { print $1; exit }' "$ATTEMPTS")
  [[ "$FIRST_WAIT" =~ ^[0-9]+$ ]] || refuse_local "the first registry-unavailable line of $ATTEMPTS carries no timestamp"
  if (( $(date -u +%s) - FIRST_WAIT > 3600 )); then
    cat "$ATTEMPTS" >&2
    refuse_verdict 'the first registry-unavailable attempt is more than an hour old. Stop, and escalate as step 6 describes.'
  fi
fi

# Every tool that this run and its child need, resolved here by real location.
# The child gets those locations, so its fixed search path cannot lose one.
NODE_BIN=$(command -v node) || refuse_local 'node is not on PATH'
NPM_BIN=$(command -v npm) || refuse_local 'npm is not on PATH'
TIMEOUT_BIN=$(command -v timeout) || refuse_local 'timeout is not on PATH, and the load session needs GNU timeout'
TIMEOUT_ID=$("$TIMEOUT_BIN" --version 2>/dev/null || true)
[[ "$TIMEOUT_ID" == *'GNU coreutils'* ]] || refuse_local "$TIMEOUT_BIN is not GNU timeout, and the load session needs GNU timeout"
for tool in awk date find grep mktemp mv rm sed tail; do
  command -v "$tool" >/dev/null || refuse_local "$tool is not on PATH"
done
PI="$REPO_DIR/node_modules/.bin/pi"
[[ -x "$PI" ]] || refuse_local "no executable pi at $PI. Run 'npm ci --ignore-scripts' in $REPO_DIR."
PI_PIN=$(node - "$WORKTREE/package.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const pin = manifest.devDependencies?.["@earendil-works/pi-coding-agent"];
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pin ?? "")) throw new Error(`the merged commit has no exact pi pin: ${JSON.stringify(pin)}`);
process.stdout.write(pin);
NODE
) || refuse_local "could not read the pi pin from $WORKTREE/package.json"
PI_VERSION=$("$PI" --version) || refuse_local "$PI reports no version"
[[ "$PI_VERSION" == "$PI_PIN" ]] || refuse_local "pi at $PI reports $PI_VERSION, and the merged commit pins $PI_PIN. Run 'npm ci --ignore-scripts' in $REPO_DIR."

# Throwaway directories, outside every checkout and outside the release state.
PROOF_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/slate-release-proof.XXXXXX") || refuse_local 'mktemp could not create a scratch root'
PROOF_ROOT=$(cd "$PROOF_ROOT" && pwd -P)
case "$PROOF_ROOT" in
  "$REPO_DIR"|"$REPO_DIR"/*|"$WORKTREE"|"$WORKTREE"/*|"$RELEASE_DIR"|"$RELEASE_DIR"/*)
    refuse_local "the scratch root $PROOF_ROOT sits inside a checkout or inside the release state. Point TMPDIR somewhere else." ;;
esac
PROJECT="$PROOF_ROOT/project"
AGENT="$PROOF_ROOT/agent"
CACHE="$PROOF_ROOT/npm-cache"
CHILD_HOME="$PROOF_ROOT/home"
CHILD_TMP="$PROOF_ROOT/tmp"
mkdir -p "$PROJECT" "$AGENT" "$CACHE" "$CHILD_HOME" "$CHILD_TMP" \
  || refuse_local "could not build the throwaway layout under $PROOF_ROOT"
for directory in "$PROJECT" "$AGENT" "$CACHE" "$CHILD_HOME" "$CHILD_TMP"; do
  [[ -d "$directory" && -w "$directory" ]] || refuse_local "the throwaway directory $directory is missing or not writable"
done
[[ -z "$(find "$CACHE" -mindepth 1 -print -quit)" ]] || refuse_local "the throwaway cache $CACHE is not empty"

# The child sees no variable of this machine, and it keeps every resolved tool
# location. The empty cache forces the registry read. The pinned registry beats
# a configuration file that env -i cannot remove. The two offline flags stop an
# ambient npm configuration from turning a cache into an offline source.
CHILD_PATH="$(dirname "$NODE_BIN"):$(dirname "$NPM_BIN"):$(dirname "$TIMEOUT_BIN"):/usr/bin:/bin"
CHILD=(env -i PATH="$CHILD_PATH" HOME="$CHILD_HOME" TMPDIR="$CHILD_TMP"
  PI_CODING_AGENT_DIR="$AGENT" npm_config_cache="$CACHE"
  npm_config_registry="$REGISTRY"
  npm_config_offline=false npm_config_prefer_offline=false
  npm_config_audit=false npm_config_fund=false)

printf 'preflight passed: node %s, npm %s, GNU timeout %s, pi %s, scratch root %s\n' \
  "$NODE_BIN" "$NPM_BIN" "$TIMEOUT_BIN" "$PI_VERSION" "$PROOF_ROOT"

# --- the attempt. From here every exit writes exactly one verdict. ---

ATTEMPT=$(( $(grep -c ' started$' "$ATTEMPTS" || true) + 1 ))
RAW="$RELEASE_DIR/evidence/proof-attempt-$ATTEMPT"
note() {
  printf '%s %s attempt %s %s\n' "$(date -u +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ATTEMPT" "$1" >>"$ATTEMPTS"
  [[ "$1" == 'started' ]] || VERDICT_WRITTEN=true
}
redact_raw() {
  local file
  for file in "$RAW".*; do
    [[ -f "$file" ]] || continue
    redact <"$file" >"$file.redacting" && mv "$file.redacting" "$file"
  done
}
# failed is reserved for artifact evidence. Every other stop is inconclusive,
# except a registry that npm itself reported as unreachable.
stop() {
  local word="$1"; shift
  redact_raw
  note "$word"
  printf '%s\n' "$*" >&2
  printf 'verdict: %s\nraw evidence: %s.*\nthrowaway root: %s\n' "$word" "$RAW" "$PROOF_ROOT" >&2
  case "$word" in
    failed) exit 1 ;;
    *) exit 2 ;;
  esac
}
# npm prints its machine-readable code on a line of its own, and this pattern is
# anchored to that line. An unanchored search matches the same letters inside a
# base64 integrity value, a log path or a package name, and would then wait for a
# registry that answered. Measured with npm 11.16.0: a registry address that
# refuses the connection gives 'npm error code ECONNREFUSED', an absent version
# at install time gives ETARGET, and an absent package or an absent version at
# read time gives E404.
# None of those last two is a delay, so neither appears below.
registry_unavailable() {
  grep -Eq '^npm (error|ERR!) code (ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPROTO|ERR_SOCKET_TIMEOUT|E5[0-9][0-9]|E429)$' "$1"
}
note started
ATTEMPT_RECORDED=true

INSTALL_STATUS=0
( cd "$PROJECT" && "${CHILD[@]}" "$PI" install -l "npm:$PACKAGE@$VERSION" -a ) \
  >"$RAW.install.out" 2>"$RAW.install.err" || INSTALL_STATUS=$?
if (( INSTALL_STATUS != 0 )); then
  tail -n 40 "$RAW.install.err" >&2
  if registry_unavailable "$RAW.install.err"; then
    stop registry-unavailable 'The registry was unavailable. Wait 15 minutes, then run this block again.'
  fi
  if grep -Eq '^npm (error|ERR!) code EINTEGRITY$' "$RAW.install.err"; then
    # An integrity error says that the bytes this machine received are not the
    # bytes the served metadata names. Anything that rewrites a response in
    # transit produces that signal about a healthy published version, so this
    # error never reaches failed on any path. This step detects no intermediary
    # and supports none, so the message names the precondition instead of
    # guessing at a cause.
    stop inconclusive 'The install reported an integrity error, so the bytes this machine received are not the bytes the served metadata names. This step cannot tell a fault in the path from a fault at the registry, and it accuses nothing. This runbook requires a direct connection to the registry, with no proxy and no mirror in the path. Satisfy that precondition, then run this block again. Read the retained streams if the precondition is already satisfied.'
  fi
  stop inconclusive "The install exited with status $INSTALL_STATUS for a reason that is neither registry availability nor an integrity mismatch. Read the retained streams, repair the condition, and run this block again."
fi

VIEW_STATUS=0
"${CHILD[@]}" "$NPM_BIN" view "$PACKAGE@$VERSION" version dist.integrity dist.tarball --json \
  >"$RAW.view.json" 2>"$RAW.view.err" || VIEW_STATUS=$?
if (( VIEW_STATUS != 0 )); then
  tail -n 40 "$RAW.view.err" >&2
  if registry_unavailable "$RAW.view.err"; then
    stop registry-unavailable 'The registry metadata read failed. Wait 15 minutes, then run this block again.'
  fi
  stop inconclusive "The registry metadata read exited with status $VIEW_STATUS for a reason other than registry availability. Read the retained streams, repair the condition, and run this block again."
fi

TARBALL_URL=$(node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(x["dist.tarball"] ?? x.dist?.tarball ?? ""))' "$RAW.view.json")
[[ "$TARBALL_URL" == https://* ]] || stop inconclusive "The registry served no usable tarball address: $TARBALL_URL"
TARBALL_HOST=${TARBALL_URL#*://}
TARBALL_HOST=${TARBALL_HOST%%/*}
TARBALL_HOST=${TARBALL_HOST##*@}
TARBALL_HOST=${TARBALL_HOST%%:*}
printf '%s\n' "$TARBALL_HOST" >"$RAW.host.txt"
# A mirror can serve matching bytes, so the host is part of the evidence. It is
# a local condition and never an artifact defect.
[[ "$TARBALL_HOST" == "$REGISTRY_HOST" ]] \
  || stop inconclusive "The served tarball address is on host $TARBALL_HOST, and this runbook expects $REGISTRY_HOST. Remove the mirror from the path, then run this block again."

# The download-address check. The cache started empty, so an entry under that
# address is the record of a real download of it, and this is the only check
# here that can see the bytes arriving from somewhere else. A missing entry has
# two readings, and the first one is the serious one: nothing fetched that
# address, which is what a pre-filled cache, a local mirror or another
# intermediary looks like. The second reading is that npm changed its cache
# index layout. The layout read below was measured with npm 11 under Node 24.
# Either reading ends the attempt as inconclusive, and the empty cache above
# stays the guarantee.
grep -rlF "make-fetch-happen:request-cache:$TARBALL_URL" "$CACHE/_cacache/index-v5" >/dev/null 2>&1 \
  || stop inconclusive 'The fresh cache holds no entry for the published tarball address. Either nothing fetched that address, which is what an intermediary or a pre-filled cache looks like, or npm changed its cache index layout. This attempt established nothing about the published bytes either way.'

LOCK="$PROJECT/.pi/npm/package-lock.json"
[[ -f "$LOCK" ]] || stop inconclusive "The install wrote no lock file at $LOCK."
COMPARE_STATUS=0
node - "$LOCK" "$RAW.view.json" "$PACKAGE" "$VERSION" "$TARBALL_INTEGRITY" "$REGISTRY_HOST" \
  2>"$RAW.compare.err" <<'NODE' || COMPARE_STATUS=$?
const fs = require("node:fs");
const [lockPath, viewPath, name, version, recorded, host] = process.argv.slice(2);
// Exit 3 is artifact evidence. Every other exit is a local fault. The two host
// checks stay local faults, because a served or resolved address on another
// host is a condition of this machine and never a defect of the artifact.
const artifact = (message) => { process.stderr.write(`artifact evidence: ${message}\n`); process.exit(3); };
const local = (message) => { process.stderr.write(`local fault: ${message}\n`); process.exit(4); };
const hostOf = (address) => { try { return new URL(address).hostname; } catch { return ""; } };
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const view = JSON.parse(fs.readFileSync(viewPath, "utf8"));
const entry = lock.packages?.[`node_modules/${name}`];
if (!entry) local(`the lock file has no entry for node_modules/${name}`);
const served = String(view["dist.integrity"] ?? view.dist?.integrity ?? "");
const address = String(view["dist.tarball"] ?? view.dist?.tarball ?? "");
if (String(view.version ?? "") !== version) local(`the registry served version ${view.version}`);
if (!/^sha512-/.test(served)) local(`the registry integrity ${served} is not sha512`);
if (hostOf(address) !== host) local(`the registry served an address on host ${hostOf(address)}`);
if (hostOf(String(entry.resolved ?? "")) !== host) local(`the install resolved from host ${hostOf(String(entry.resolved ?? ""))}`);
if (entry.version !== version) artifact(`the installed version is ${entry.version}`);
if (entry.integrity !== served) artifact(`the installed integrity ${entry.integrity} is not the served ${served}`);
if (entry.integrity !== recorded) artifact(`the installed integrity ${entry.integrity} is not the inspected ${recorded}`);
if (entry.resolved !== address) artifact(`the install resolved ${entry.resolved}, not ${address}`);
NODE
if (( COMPARE_STATUS == 3 )); then
  cat "$RAW.compare.err" >&2
  stop failed 'The resolved artifact disagrees with the registry metadata or with the inspected bytes.'
elif (( COMPARE_STATUS != 0 )); then
  cat "$RAW.compare.err" >&2
  stop inconclusive 'The comparison could not be made. Read the retained streams, repair the condition, and run this block again.'
fi

# The load session. Extensions stay enabled, no -e argument names slate, and the
# project settings entry that the install wrote is the only route by which slate
# can load. PI_OFFLINE=1 and the empty agent directory leave no provider to call.
printf '%s\n' '{"id":"1","type":"get_commands"}' >"$PROOF_ROOT/requests.jsonl"
LOAD_STATUS=0
( cd "$PROJECT" && "${CHILD[@]}" PI_OFFLINE=1 "$TIMEOUT_BIN" 120 "$PI" --mode rpc -a \
  <"$PROOF_ROOT/requests.jsonl" ) >"$RAW.load.out" 2>"$RAW.load.err" || LOAD_STATUS=$?
if grep -Eq 'Failed to load extension|Cannot find module|SyntaxError' "$RAW.load.err"; then
  cat "$RAW.load.err" >&2
  stop failed 'The load session printed an extension load failure.'
fi
if (( LOAD_STATUS == 124 || LOAD_STATUS == 137 )); then
  tail -n 40 "$RAW.load.err" >&2
  stop inconclusive 'The load session hit the 120 second timeout, so it produced no evidence.'
fi
(( LOAD_STATUS == 0 )) || { tail -n 40 "$RAW.load.err" >&2; stop inconclusive "The load session exited with status $LOAD_STATUS and printed no load failure, so it produced no evidence."; }

EVIDENCE_STATUS=0
node - "$RAW.load.out" "$PROJECT" "$PACKAGE" "$VERSION" "$PI_VERSION" "$RAW.view.json" "$LOCK" "$TARBALL_HOST" \
  >"$RAW.proof.json" 2>"$RAW.evidence.err" <<'NODE' || EVIDENCE_STATUS=$?
const fs = require("node:fs");
const nodePath = require("node:path");
const [streamPath, project, name, version, piVersion, viewPath, lockPath, host] = process.argv.slice(2);
// Exit 3 is artifact evidence. Every other exit is a local fault.
const artifact = (message) => { process.stderr.write(`artifact evidence: ${message}\n`); process.exit(3); };
const local = (message) => { process.stderr.write(`local fault: ${message}\n`); process.exit(4); };
// The same four passes as the shell redact above, in the same order.
const redact = (value) => String(value)
  .replace(/\/\/[^/@\s]*@/g, "//REDACTED@")
  .replace(/([?&;#](?:access_key|access_token|api_key|api-key|apikey|auth|auth_token|authorization|authtoken|client_secret|credential|credentials|deploy_token|id_token|job_token|key|otp|passcode|passwd|password|personal_access_token|private_token|pwd|refresh_token|secret|secret_key|session_token|sig|signature|token)=)[^&;#\s"]*/gi, "$1REDACTED")
  .replace(/npm_[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{32,}|github_pat_[A-Za-z0-9_]{40,}/g, "TOKEN_REDACTED")
  .replace(/((?::?_auth(?:Token)?|_password)\s*=\s*)[^\s"]+/gi, "$1REDACTED");
const lines = fs.readFileSync(streamPath, "utf8").split("\n").map(line => line.trim());
const objects = [];
let unparseable = 0;
for (const line of lines) {
  if (!line.startsWith("{")) continue;
  try { objects.push(JSON.parse(line)); } catch { unparseable += 1; }
}
if (unparseable !== 0) local(`${unparseable} stream lines look like objects and did not parse`);
const errors = objects.filter(object => object?.type === "extension_error");
if (errors.length !== 0) artifact(`the session reported ${errors.length} extension errors: ${JSON.stringify(errors)}`);
const warnings = objects.filter(object => object?.type === "extension_ui_request" && object.method === "notify" && object.notifyType === "warning");
if (warnings.length !== 0) local(`the session raised ${warnings.length} warnings, which are not artifact evidence and need reading: ${JSON.stringify(warnings)}`);
const answer = objects.find(object => object?.type === "response" && object.command === "get_commands");
if (!answer || !Array.isArray(answer.data?.commands)) local("the session answered no command list");
const packaged = answer.data.commands.filter(command => command?.sourceInfo?.origin === "package");
if (packaged.length !== 1) artifact(`expected one packaged command, and got ${JSON.stringify(packaged)}`);
const command = packaged[0];
const base = nodePath.join(project, ".pi", "npm", "node_modules", name);
if (command.name !== "slate") artifact(`the packaged command is named ${command.name}`);
if (command.source !== "extension") artifact(`the command source is ${command.source}`);
if (command.sourceInfo.source !== `npm:${name}@${version}`) artifact(`the command comes from ${command.sourceInfo.source}`);
if (command.sourceInfo.scope !== "project") artifact(`the command scope is ${command.sourceInfo.scope}`);
if (command.sourceInfo.path !== nodePath.join(base, "extension", "index.ts")) artifact(`the command resolved to ${command.sourceInfo.path}`);
const view = JSON.parse(fs.readFileSync(viewPath, "utf8"));
const installed = JSON.parse(fs.readFileSync(lockPath, "utf8")).packages[`node_modules/${name}`];
process.stdout.write(`${JSON.stringify({
  package: name,
  version,
  piVersion,
  registryHost: host,
  registryIntegrity: String(view["dist.integrity"] ?? view.dist?.integrity ?? ""),
  registryTarball: redact(view["dist.tarball"] ?? view.dist?.tarball ?? ""),
  installedIntegrity: installed.integrity,
  installedFrom: redact(installed.resolved),
  command: command.name,
  commandSource: command.sourceInfo.source,
  commandScope: command.sourceInfo.scope,
  commandOrigin: command.sourceInfo.origin,
  commandPath: command.sourceInfo.path,
  extensionErrors: errors.length,
  warnings: warnings.length,
  provenAt: new Date().toISOString(),
}, null, 2)}\n`);
NODE
if (( EVIDENCE_STATUS == 3 )); then
  cat "$RAW.evidence.err" >&2
  stop failed 'The load evidence does not match the requirement.'
elif (( EVIDENCE_STATUS != 0 )); then
  cat "$RAW.evidence.err" >&2
  stop inconclusive 'The load evidence could not be read. Read the retained streams, repair the condition, and run this block again.'
fi

# The success commit, in this order and no other. The rename is atomic inside
# the evidence directory, so proof.json appears whole and only after every check
# passed. An interruption after it leaves the proof in place, and the next run
# finishes the bookkeeping instead of repeating the proof.
mv "$RAW.proof.json" "$PROOF"
note proven
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PROVEN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
rm -f "$RAW.install.out" "$RAW.install.err" "$RAW.view.json" "$RAW.view.err" \
  "$RAW.host.txt" "$RAW.compare.err" "$RAW.load.out" "$RAW.load.err" "$RAW.evidence.err"
rm -rf "$PROOF_ROOT"
cat "$PROOF"
printf 'verdict: proven\n'
```

The structured evidence file names the compared values, so a reader does not have to trust the exit status. `installedIntegrity`, `registryIntegrity` and the recorded `TARBALL_INTEGRITY` are one value on a pass. `registryHost` is the host that served the artifact. `commandPath` sits under the throwaway project, and never under a checkout.

**If the registry was unavailable. Untested.** Wait 15 minutes, then run the second block again. The bound is four `registry-unavailable` attempts and one hour from the first of them, and the block enforces both. Escalate as step 6's `inconclusive` branch describes when the fourth such attempt fails or the hour runs out. Nothing about the artifact is in doubt yet.

**If the outcome was inconclusive. Untested.** The proof was not performed. Nothing here is evidence about the published artifact, and no public act follows. Read the message, which names the condition, and read the retained streams under `$RELEASE_DIR/evidence/proof-attempt-<n>.*`. Repair the condition, then run the second block again. The attempt log keeps the inconclusive line as a record, and that line spends no part of the retry bound. The complete set of shapes that reach this outcome is listed above, under the rule that only artifact evidence may produce `failed`. The common ones are a missing or non-GNU `timeout`, a pi that does not match the pin, an unwritable scratch directory, a full disk, a registry mirror in the path, and an integrity error from the install.

**If the proof fails. Untested.** The verdict `failed` means that artifact evidence disagreed with the record, and it is final for this version. Step 6's `integrity-mismatch` branch already states the shared rule: a published version cannot be replaced or reused, so this version number is spent, and a corrected release starts at step 0 with the next unused patch version. Step 5 published the artifact and cannot undo it.

This runbook takes no public act on that outcome, exactly as step 6 does not. Step 6 says it in these words: "The runbook does not deprecate the version, move a distribution tag or unpublish anything. Those are public, irreversible acts on a package other people install", and "The decision belongs to the user, and it is made outside this document." The same holds here. The agent reports, and the user decides. Three actions follow, in this order.

1. Report the facts. Name the version, the verdict, the attempt log and the retained raw streams. The message of the failing check names the piece of evidence that disagreed. Say plainly that the evidence is artifact evidence, because only artifact evidence reaches this word.
2. Put the decision to the user. A deprecation warns a consumer who installs the version, and it is one option. The user decides whether to deprecate, and the user runs any such command in their own terminal, because it needs their credentials and their consent, exactly as the publication did. The agent never deprecates, never moves a distribution tag and never unpublishes.
3. Correct the defect, and release again from step 0 with the next unused patch version. Never publish this number again, and never move a distribution tag to hide it.

**If a success was interrupted.** A crash or a signal between the evidence file and its bookkeeping leaves `proof.json` in place with no `proven` line in the log. Run the second block again. Its preflight validates the file against this release, appends the missing verdict, saves `PROVEN_AT` if it is absent, prints the evidence, and exits 0 without repeating the proof. The block overwrites no proof evidence in any state. If the file does not describe this release, the block refuses with `inconclusive` and leaves the file for a person to read.

## Step 9 — the agent tears down the release worktree

The first release left a worktree detached at the squash commit, because no step removed it. This step is not optional, and it runs whether the release succeeded or was abandoned. **The failure path is untested.** The success path uses the same commands.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" REPO_DIR)
eval "$STATE"

TREE="$RELEASE_DIR/checkout"
if [[ -e "$TREE" ]]; then
  if [[ -n "$(git -C "$TREE" status --porcelain)" ]]; then
    printf 'Worktree %s has uncommitted changes; inspect it before removing it.\n' "$TREE" >&2
    git -C "$TREE" status --porcelain >&2
    exit 1
  fi
  git -C "$REPO_DIR" worktree remove "$TREE"
fi
git -C "$REPO_DIR" worktree prune
[[ ! -e "$TREE" ]]
git -C "$REPO_DIR" worktree list
rm -f "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current"
printf 'Release directory kept for the record: %s\n' "$RELEASE_DIR"
```

Read the final `git worktree list`: no path under the release directory may remain, and no worktree may be left detached by this release. This step creates no branch, so it leaves none behind. Keep `$RELEASE_DIR` — the tarball, the hashes and the evidence are the record of what was published. Delete it by hand when it is no longer wanted.

If an escalation is open, skip this step until the escalation closes, then run it.

## Consumers

Consumers install pinned with `pi install -l npm:ytdb-slate@<version>`. Pi skips pinned specs during `pi update`, so consumers bump their pin deliberately. On every bump, they must re-review their project delta documents (`doctrineExtraPath`, `reviewPerspectivesPath`, and prompt-document lists) against the shipped doctrine for drift.
