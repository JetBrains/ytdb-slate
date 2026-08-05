# Releasing ytdb-slate

Ten steps, numbered 0 to 9, in order. The agent owns most of them. The user owns three: the merge, the publication, and the merge of the pin pull request. Everything that reaches npm or the default branch is the user's act.

Every command block enables fail-closed shell behavior. Do not continue after a failed command unless the applicable recovery branch says to continue.

## How to read this runbook

**Steps may run in separate sessions.** The first real release ran across four agent actions. Nothing carries between them in shell variables, so no step trusts one. Every block reloads machine-written state from a file, revalidates it, and re-derives the facts it gates on. A block that gates on a registry fact re-reads the registry; a typed word never unlocks anything.

**No step assumes the checkout you happen to be standing in.** This repository is worked in many worktrees at once — eleven at the time of writing. Every git command names its repository with `git -C`, and every gh command names its repository with `--repo`. The release itself happens in a dedicated worktree that step 9 removes. One checkout is bound, once: step 0 records the checkout it runs in as `REPO_DIR`, and steps 1, 3, 7, 8 and 9 work in that recorded path rather than the current directory. Run step 0 in the umbrella PR branch checkout.

**Some paths have never executed.** They are marked **Untested.** where they appear, and listed under "Untested paths" below. A marked path is reviewed, not proven. Read it before you run it.

**Never set a state value by hand.** If a block stops because a state key is missing or malformed, re-run the step that writes that key. Hand-setting the value is how the first release turned a guard into a formality.

**Declare the release once per session.** `export SLATE_RELEASE=<version>` before running any block; step 0 prints the line. Every block refuses to run without it and stops if it disagrees with the state behind the pointer. It is the one fact a block cannot derive — which release you mean — and it is never used as evidence for anything else.

## Before you start

Have all of this before step 0. Steps 5, 7 and 8 act in public, and a missing tool or a missing permission is cheap to fix now and expensive to find after publication.

- **Tools on `PATH`:** bash 4 or newer (the blocks use `mapfile`, arrays and `[[ ]]`), git, GNU coreutils, `gh`, `node`, `npm`, `pi`, `tar`, `cmp`, `awk`, `sed`, `grep`, `diff`.
- **GitHub:** `gh auth status` reports you as logged in, against the host that serves this repository, with write access to it. Step 7 pushes a tag and creates a release; step 8 pushes a branch and opens a pull request.
- **npm:** the user who runs step 5 has an account that may publish `ytdb-slate` and can answer its two-factor prompt. The agent never needs npm credentials; it only reads the registry.
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
    evidence/          # publish log, registry replies, escalation material
    checkout/          # the release worktree: detached at the squash commit,
                       # then on the pin branch from step 8
```

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
| 5 | **Publishes to npm. Irreversible.** By the user. | `npm view <package>@<version> version` succeeds. |
| 6 | None. Read-only; downloads the published tarball. | **Not detectable, and does not need to be.** Re-running it is the intended way to resolve it. |
| 7 | Pushes a tag and creates a GitHub release. | `git ls-remote --refs origin refs/tags/<tag>` and `gh release view <tag> --repo <repo>`. The block determines this itself before it creates anything. |
| 8 | Pushes a branch and opens a pull request. The user merges it. | `gh pr list --repo <repo> --head dogfood-<version> --state all` shows the PR and whether it merged. No PR means the attempt stopped before that; step 8's "If it stopped partway" tells you which state you are in and what to run. |
| 9 | Removes the worktree it added. | `git worktree list` shows no path under the release directory. |

Step 5 is the only irreversible step. Step 7 re-derives its gates on every run and detects its own prior completion. Step 8 reaches the default branch only through a pull request the user merges, so a repeated or stale run proposes a change rather than making one.

## Untested paths

These have never run. Treat any of them as a hypothesis and read the commands before executing them.

- The integrity-mismatch halt in step 6.
- The inconclusive branch and escalation in step 6.
- Every restart state in step 7 except "nothing exists yet".
- The whole of step 8: the pin branch, its validation, the pull request, the recovery after a partway stop, and the checks after the merge. It replaced the earlier direct push to the default branch and has never run as a release path.
- Teardown after a failure in step 9.

## Step 0 — the agent starts the release

Run this block in the umbrella PR branch checkout. It records that checkout as `REPO_DIR`, the value is immutable, and step 1 verifies the bumped version there.

Replace every `REPLACE_*` value. The guards reject placeholders, empty values, invalid versions and an invalid PR number.

Re-running this block for the same version is safe: `init` keeps existing state and fails if a value would change. That is what makes a restart in a new session possible.

```bash
set -euo pipefail
PACKAGE='ytdb-slate'
VERSION='REPLACE_VERSION'
PRIOR_VERSION='REPLACE_PRIOR_VERSION'
PR='REPLACE_PR_NUMBER'
[[ "$VERSION" != REPLACE_* && "$PRIOR_VERSION" != REPLACE_* && "$PR" != REPLACE_* ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$PRIOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$VERSION" != "$PRIOR_VERSION" ]]
[[ "$PR" =~ ^[1-9][0-9]*$ ]]
TAG="v$VERSION"

REPO_DIR=$(git rev-parse --show-toplevel)
[[ "$REPO_DIR" == /* ]]
GIT_COMMON_DIR=$(cd "$(git -C "$REPO_DIR" rev-parse --git-common-dir)" && pwd)
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
  PRIOR_VERSION: /^[0-9]+\.[0-9]+\.[0-9]+$/,
  PR: /^[1-9][0-9]*$/,
  TAG: /^v[0-9]+\.[0-9]+\.[0-9]+$/,
  REPO: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  REPO_DIR: /^\/[^'\n]*$/,
  GIT_COMMON_DIR: /^\/[^'\n]*$/,
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
  PINNED_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
};

// Values that identify the release. Once written they are facts, not settings:
// a different value means a different release, which starts again at step 0.
const IMMUTABLE = new Set([
  "PACKAGE", "VERSION", "PRIOR_VERSION", "PR", "TAG", "REPO",
  "REPO_DIR", "GIT_COMMON_DIR", "RELEASE_DIR", "SQUASH_SHA", "WORKTREE",
]);
// The reference bytes may be re-derived by a re-pack, but not after the user
// has been handed a command naming them.
const SEALED_BY_HANDOFF = new Set(["TARBALL", "TARBALL_SHA256", "TARBALL_INTEGRITY"]);

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
  PACKAGE="$PACKAGE" VERSION="$VERSION" PRIOR_VERSION="$PRIOR_VERSION" PR="$PR" TAG="$TAG" \
  REPO="$REPO" REPO_DIR="$REPO_DIR" GIT_COMMON_DIR="$GIT_COMMON_DIR" RELEASE_DIR="$RELEASE_DIR"
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

Bump only `version` in `package.json`. Leave `.pi/settings.json` pinned to `npm:ytdb-slate@$PRIOR_VERSION`; step 8 moves the pin, after npm serves the new version. Follow `docs/pr-publishing.md` through the ready flip. Do not publish from the PR branch.

This block works in `REPO_DIR`, the checkout step 0 ran in; it does not use the directory you are standing in, and no release worktree exists yet. If step 0 recorded a checkout that is not the PR branch, the version assertion below stops the block. `REPO_DIR` is immutable, so the repair is to start the state again: steps 0 and 1 change nothing outside this machine, so delete the release directory printed by step 0, then run step 0 from the PR branch checkout.

**Run the full verification set, not only the typecheck.** `AGENTS.md` names several behavioral nets with distinct scopes. The typecheck is separate because it sees shapes, not behavior. A release ships every file, so step 1 runs every checked-in net and the manual smoke test:

- `npm run typecheck` checks TypeScript shapes.
- Both packaging-guard commands check the manifest and real pack list, including their self-tests.
- `bash verification/run-load-check.sh --repo .` checks working-tree loading, hooks, tools and config syntax.
- `bash verification/run-resolver-checks.sh --repo . --strict` checks pure pipelines and doctrine rendering.
- `bash verification/run-ladder.sh --repo . --strict` checks model switches and worker settings isolation. It takes about three minutes. Do not run it as root.
- `node verification/package-content-check.mjs --repo .` checks package-resolved runtime files.
- `node verification/writing-check-tests.mjs` checks writing-checker correctness.
- `node verification/writing-check-scaling.mjs` checks linear growth and output caps.
- `bash verification/run-writing-reminder-check.sh --repo .` checks the real reminder hook, steer and persistence path. It requires GNU `timeout`.
- The isolated-load smoke test below provides an additional manual read of direct loader output.

The tier-1 CI set remains the four commands in `AGENTS.md`. The other commands above are release-time hand-run nets.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION PRIOR_VERSION PR REPO_DIR)
eval "$STATE"
cd "$REPO_DIR"
[[ -z "$(git -C "$REPO_DIR" status --porcelain)" ]]

node - "$VERSION" "$PRIOR_VERSION" <<'NODE'
const fs = require("node:fs");
const [version, priorVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const settings = JSON.parse(fs.readFileSync(".pi/settings.json", "utf8"));
if (manifest.version !== version) throw new Error(`package version is ${manifest.version}`);
const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
const expected = `npm:ytdb-slate@${priorVersion}`;
if (slate.length !== 1 || slate[0] !== expected) throw new Error(`dogfood pin is ${JSON.stringify(slate)}`);
NODE

npm run typecheck
bash verification/run-packaging-checks.sh --repo .
bash verification/run-packaging-checks.sh --repo . --self-test
bash verification/run-load-check.sh --repo .
bash verification/run-resolver-checks.sh --repo . --strict
bash verification/run-ladder.sh --repo . --strict
node verification/package-content-check.mjs --repo .
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

## Step 4 — the agent verifies and packs the exact commit

Verify the release version and the prior serviceable pin from the merged commit itself, then build the tarball inside the release worktree.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" VERSION PRIOR_VERSION SQUASH_SHA WORKTREE)
eval "$STATE"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
[[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]

node - "$WORKTREE/package.json" "$WORKTREE/.pi/settings.json" "$VERSION" "$PRIOR_VERSION" <<'NODE'
const fs = require("node:fs");
const [manifestPath, settingsPath, version, priorVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
if (manifest.version !== version) throw new Error(`merged package version is ${manifest.version}`);
const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
const expected = `npm:ytdb-slate@${priorVersion}`;
if (slate.length !== 1 || slate[0] !== expected) throw new Error(`merged dogfood pin is ${JSON.stringify(slate)}`);
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
Publish $PACKAGE@$VERSION. Run these two lines in your own terminal, so you can
answer the two-factor prompt:

  npm publish '$TARBALL'
  echo "npm publish exit status: \$?"

The second line is the answer. Zero means the transaction completed; anything
else means it did not. Read that number rather than the wording of the output.

The output is not redirected on purpose: npm asks for the one-time password on
the terminal, and a pipe or a file can hide the prompt or suppress it entirely.
Copy the whole output, including the exit-status line, into:

  $RELEASE_DIR/evidence/publish.log

The inspected bytes are:

  sha256     $TARBALL_SHA256
  integrity  $TARBALL_INTEGRITY

npm prints a shasum and an integrity line before it uploads. The integrity line
must equal the value above. If it does not, stop and do not confirm the upload.

Publish this file and no other. Do not repack it. Tell the agent the exit status
when the command has finished.
HANDOFF
```

**The user publishes.** Run the printed commands, complete two-factor, save the output. Report the exit status number, not an impression. If it is not zero, say so and stop; do not retry without the agent, because a second attempt against an accepted transaction is the one thing this runbook cannot undo.

**The agent waits.** It does not run `npm publish`, does not repack, and does not infer the outcome from what the user reports — not even from a reported exit status of zero, which says the CLI returned, not that the registry serves the inspected bytes. It proceeds to step 6 once the command has finished, whatever anyone believes happened.

## Step 6 — the agent verifies the published artifact

This is the check the old runbook threw away: it fetched `dist.integrity` and compared it to nothing. Here the registry's integrity value is compared against the recorded integrity of the inspected bytes, and the served tarball is compared byte for byte against the retained one. A handoff can substitute a different artifact; this is what detects it.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TARBALL TARBALL_SHA256 TARBALL_INTEGRITY HANDOFF_AT)
eval "$STATE"

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
if VIEW_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity dist.tarball --json 2>"$VIEW_ERROR"); then
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
    if REGISTRY_JSON=$(cd "$REGISTRY_DIR" && npm pack "$PACKAGE@$VERSION" --json --pack-destination "$REGISTRY_DIR" 2>>"$VIEW_ERROR"); then
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

- **`integrity-mismatch`. Untested.** npm serves something other than the inspected artifact under an immutable version number. **Stop.** Do not tag, release or pin.

  The runbook does not deprecate the version, move a dist-tag or unpublish anything. Those are public, irreversible acts on a package other people install, and an earlier draft of this document automated them: it read a byte difference and reached for `npm deprecate`. Review found two ways that path could fire on evidence that was stale or malformed. The action was worth less than the ways of getting it wrong, so it is gone. The runbook's job here is to put the facts in front of the user; the decision is theirs and is made outside this document.

  This run's evidence is under `$RELEASE_DIR/evidence/`: `registry-view.json`, `registry-view.err` and `registry-result.txt`, with the inspected tarball under `$RELEASE_DIR/artifact/`, the recorded hashes in `release.json`, and the downloaded tarball under `$RELEASE_DIR/registry/` — which is empty when the integrity values already differed, because the block downloads nothing once it knows they do. Nothing further needs collecting.

  Re-run step 6 once after a few minutes before reporting: a mid-propagation read can differ, and the re-run replaces the evidence with its own. Then tell the user the version, the recorded sha256 and integrity of the inspected tarball, the integrity npm serves, whether the difference is in the integrity value, in the bytes, or in both, and the path of the inspected tarball — with the downloaded one only if `$RELEASE_DIR/registry/` holds it.

  Either way this version number is spent. A published version cannot be replaced or reused, so a corrected release starts at step 0 with the next unused patch version.

- **`inconclusive`. Untested.** The block reached no conclusion. Do not publish again. Two different causes end here and they need different work, so read `registry-view.err` and the block's own stderr first and name the one you have:

  - **The registry read failed** — `npm view` errored, served another version, or served an integrity value the block could not compare. That can mean absence, propagation delay, lost permission, or a registry or network failure, and none of them is authoritative. This is what the numbered steps below are for.
  - **The local evidence collection failed** — `npm pack` could not write the download, or `cmp` could not read a file: a full disk, a permission error, an unreadable path. The registry may be perfectly healthy; the block just could not look. Fix the local condition and re-run step 6. Do not wait, and do not escalate to npm: nothing here is evidence about the publication.

  1. Preserve the evidence. It already belongs in `$RELEASE_DIR/evidence/`: `publish.log` from the user, `registry-view.err`, `registry-view.json` if this run's read answered, `registry-result.txt`. Add the recorded `sha256` and integrity from `release.json`, which is already there. This directory is outside `/tmp` and outside the repository, so it survives a reboot and a worktree removal.
  2. Wait and re-read. Re-run the step 6 block after 15 minutes, up to four times over an hour. Propagation delay resolves in that window.
  3. Widen the read once before escalating. `npm view "$PACKAGE" --json` returns the whole package document; enumerate its `versions` array rather than trusting a single-version E404. That distinction was what identified the true state during the first release.
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

# Re-derive the artifact facts.
[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]

# Re-derive the registry facts. This is the gate, not a stored result.
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity --json)
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
[[ "$(npm view "$PACKAGE@$VERSION" version)" == "$VERSION" ]]
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" TAGGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`--target "$SQUASH_SHA"` is not decoration. Without it the release records the default branch head, which is why the last release's `targetCommitish` did not match the commit the runbook's own final check demanded. When the tag already exists the target is cosmetic — GitHub takes the commit from the tag — but the check compares it, so it must be set.

The normal restart states are: nothing exists (create, push, release); only the correct local tag exists (skip creation, then push and release); the correct remote tag exists with no release (ensure the local tag, skip the push, create the release); or the correct remote tag and release both exist (ensure the local tag, skip both remote actions). If any existing tag or release target is wrong, stop, inspect who created it and why, and resolve it manually under repository policy. This runbook never moves or deletes a conflicting tag. The tag must point at the umbrella squash SHA, not at the later pin-only commit.

## Step 8 — the agent opens the dogfooding pin as a pull request

Last, and only after npm serves the verified artifact and step 7 passes.

The pin bump is an ordinary pull request: a branch, one commit, the repository's review, a merge by the user. Earlier drafts pushed it straight to the default branch, which took a second worktree, a detached checkout, a completion probe and a chain of guards — and review still found two ways that push could carry content nobody had checked. All of it is gone. A pull request removes those failures by construction instead of by another guard, and no ruleset has to be worked around.

One block does the whole preparation, from the gates to the pull request. It is deliberately not resumable in the middle: every seam between a check and an action was a place where the action ran on a stale check. If it stops partway, the way back is the reset below — a return to a clean start, not a resume. The branch is made in the release worktree, which step 9 removes; a new branch is checked out nowhere else, so it cannot collide.

**Untested.** This whole step — the branch, the validation, the pull request, the reset, and the checks after the merge — replaced the earlier direct push to the default branch and has never run as a release path.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION PRIOR_VERSION TAG REPO REPO_DIR SQUASH_SHA WORKTREE TARBALL_INTEGRITY)
eval "$STATE"

# Re-derive the gates: npm serves the inspected bytes, and the tag and the release sit at the squash commit.
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity --json)
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$LIVE_JSON")" == "$VERSION" ]]
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$LIVE_JSON")" == "$TARBALL_INTEGRITY" ]]
git -C "$REPO_DIR" fetch origin main --tags
[[ "$(git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
[[ "$(gh release view "$TAG" --repo "$REPO" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]

# Branch from the default branch just fetched above, in the disposable release worktree.
PIN_BRANCH="dogfood-$VERSION"
git -C "$WORKTREE" switch -c "$PIN_BRANCH" origin/main
[[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]
git -C "$WORKTREE" merge-base --is-ancestor "$SQUASH_SHA" HEAD

node - "$WORKTREE/.pi/settings.json" "$VERSION" "$PRIOR_VERSION" <<'NODE'
const fs = require("node:fs");
const [path, version, priorVersion] = process.argv.slice(2);
const before = fs.readFileSync(path, "utf8");
const prior = `"npm:ytdb-slate@${priorVersion}"`;
const next = `"npm:ytdb-slate@${version}"`;
const occurrences = before.split(prior).length - 1;
if (occurrences !== 1) throw new Error(`expected exactly one ${prior} in ${path}, found ${occurrences}`);
if (before.includes(`"npm:ytdb-slate@${version}"`)) throw new Error("the new pin is already present");
const after = before.replace(prior, next);
if (after === before) throw new Error("pin replacement changed nothing");
if (after.length !== before.length - prior.length + next.length) throw new Error("pin replacement changed more than the pin");
JSON.parse(after);
fs.writeFileSync(path, after);
NODE

node - "$WORKTREE/.pi/settings.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [path, version] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
const expected = `npm:ytdb-slate@${version}`;
if (slate.length !== 1 || slate[0] !== expected) throw new Error(`new dogfood pin is ${JSON.stringify(slate)}`);
NODE

git -C "$WORKTREE" diff -- .pi/settings.json
[[ "$(git -C "$WORKTREE" diff --numstat -- .pi/settings.json)" == $'1\t1\t.pi/settings.json' ]]

# Validate what pi resolves and loads with the new pin, in this worktree.
LOAD_STDOUT="$RELEASE_DIR/evidence/pin-load.out"
LOAD_STDERR="$RELEASE_DIR/evidence/pin-load.err"
if ! (cd "$WORKTREE" && pi -a -p "exit") >"$LOAD_STDOUT" 2>"$LOAD_STDERR"; then
  cat "$LOAD_STDERR" >&2
  false
fi
if grep -Eq 'Failed to load extension|Cannot find module|SyntaxError' "$LOAD_STDERR"; then
  cat "$LOAD_STDERR" >&2
  false
fi
PACKAGE_LIST="$RELEASE_DIR/evidence/pin-package-list.txt"
(cd "$WORKTREE" && NO_COLOR=1 pi list -a) >"$PACKAGE_LIST"
INSTALLED_DIR=$(awk -v spec="  npm:$PACKAGE@$VERSION" '
  $0 == "Project packages:" { project = 1; next }
  project && $0 == spec { getline; sub(/^[[:space:]]+/, ""); print; exit }
' "$PACKAGE_LIST")
[[ -n "$INSTALLED_DIR" && -f "$INSTALLED_DIR/package.json" ]]
node - "$INSTALLED_DIR/package.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [path, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
if (manifest.name !== "ytdb-slate" || manifest.version !== version) throw new Error(`installed package is ${manifest.name}@${manifest.version}`);
if (!Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.includes("./extension/index.ts")) throw new Error("installed package has no Slate extension entry");
NODE

# Commit, check the commit itself, then propose it.
git -C "$WORKTREE" add .pi/settings.json
git -C "$WORKTREE" commit -m "Dogfood $VERSION"
[[ "$(git -C "$WORKTREE" show --numstat --format= HEAD)" == $'1\t1\t.pi/settings.json' ]]
git -C "$WORKTREE" push -u origin "$PIN_BRANCH"
gh pr create --repo "$REPO" --base main --head "$PIN_BRANCH" --title "Dogfood $VERSION" \
  --body "Bumps the dogfooding pin to $VERSION, published in this release. One line changes in .pi/settings.json. Before this branch was pushed, pi resolved and loaded npm:$PACKAGE@$VERSION from the registry in a clean checkout."
gh pr view "$PIN_BRANCH" --repo "$REPO" --json url --jq '.url'
```

The commit is checked after it exists, not before: `git show --numstat --format= HEAD` reads the commit object that will be pushed, so no extra file and no larger edit reaches the branch unseen. It proves a one-line-for-one-line delta and not the exact bytes — a `pre-commit` or `commit-msg` hook, or a clean filter, can substitute one line for another and still pass it — which stays low severity only because the destination is a review-gated pull request branch and never `main`: read the diff on the pull request.

**If it stopped partway.** The block is one shot, so find the state first and do only what that state says. A new session holds nothing but `SLATE_RELEASE`, and the failed block's variables are gone with it, so run this probe first: it loads the release state, derives the branch name, and prints the three facts the cases turn on. It stops if the state is missing or belongs to another release, rather than probing the wrong repository.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION REPO REPO_DIR SQUASH_SHA WORKTREE)
eval "$STATE"
PIN_BRANCH="dogfood-$VERSION"

printf -- '--- pull requests for %s (empty list means none)\n' "$PIN_BRANCH"
gh pr list --repo "$REPO" --head "$PIN_BRANCH" --state all --json number,state,url
printf -- '--- remote branch (no line means it was never pushed)\n'
git -C "$REPO_DIR" ls-remote --refs origin "refs/heads/$PIN_BRANCH"
printf -- '--- release worktree %s\n' "$WORKTREE"
git -C "$WORKTREE" status --short --branch
```

Take the first case that matches what it printed.

1. **A pull request already exists.** The `gh pr list` output names one. The block has nothing left to do; go to the merge below. `gh pr create` reports the same thing and prints the existing pull request.
2. **The branch is on the remote and there is no pull request.** The `ls-remote` line shows `refs/heads/$PIN_BRANCH` and the pull request list is empty. The push runs only after the validation and the commit check passed, so that branch is the checked commit: open the pull request by hand with the `gh pr create` and `gh pr view` commands above, in a shell where the probe has loaded the state. Do not run the block again.
3. **Anything else.** Nothing was pushed, whatever the worktree and the local branch look like — including the common case where pi validation failed and left the new pin in the working file. Reset, then run the whole step 8 block again from the top:

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" VERSION SQUASH_SHA WORKTREE)
eval "$STATE"
PIN_BRANCH="dogfood-$VERSION"

# Drop the pin edit wherever it got to: working file, index, or a local commit.
git -C "$WORKTREE" restore --source=HEAD --staged --worktree -- .pi/settings.json
git -C "$WORKTREE" switch --detach "$SQUASH_SHA"
if git -C "$WORKTREE" show-ref --verify --quiet "refs/heads/$PIN_BRANCH"; then
  git -C "$WORKTREE" branch -D "$PIN_BRANCH"
fi

# Step 8 starts from a clean worktree at the squash commit. Prove it is one.
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
if [[ -n "$(git -C "$WORKTREE" status --porcelain)" ]]; then
  printf 'Worktree %s is still not clean; inspect these paths before running step 8 again.\n' "$WORKTREE" >&2
  git -C "$WORKTREE" status --porcelain >&2
  exit 1
fi
printf 'Clean at %s. Run the step 8 block again from the top.\n' "$SQUASH_SHA"
```

The restore comes first on purpose. `git switch --detach` carries an uncommitted edit across, or refuses to move at all, so deleting the branch without it leaves the new pin in the working file and the rerun stops on its own cleanliness check — which is what the earlier reset did.

**The user merges the pin pull request.** The agent must not merge it, exactly as in step 2. The pin PR is a normal one-line change and needs no release ceremony.

After the merge, recheck every published target and the default-branch pin:

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TAG REPO REPO_DIR SQUASH_SHA TARBALL_INTEGRITY)
eval "$STATE"
git -C "$REPO_DIR" fetch origin main --tags
[[ "$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
[[ "$(git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
[[ "$(gh release view "$TAG" --repo "$REPO" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity --json)
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$LIVE_JSON")" == "$VERSION" ]]
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$LIVE_JSON")" == "$TARBALL_INTEGRITY" ]]
FINAL_SETTINGS="$RELEASE_DIR/evidence/final-settings.json"
git -C "$REPO_DIR" show origin/main:.pi/settings.json >"$FINAL_SETTINGS"
node - "$FINAL_SETTINGS" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [path, version] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
const expected = `npm:ytdb-slate@${version}`;
if (slate.length !== 1 || slate[0] !== expected) throw new Error(`default-branch dogfood pin is ${JSON.stringify(slate)}`);
NODE
if ! grep -q '"PINNED_AT"' "$RELEASE_DIR/release.json"; then
  node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PINNED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
```

## Step 9 — the agent tears down the release worktree

The first release left a worktree detached at the squash commit, carrying a stale pin, because no step removed it. This step is not optional, and it runs whether the release succeeded or was abandoned. **The failure path is untested**; the success path is the same commands.

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

Read the final `git worktree list`: no path under the release directory may remain, and no worktree may be left detached by this release. Removing the worktree leaves step 8's local branch behind; once `gh pr list --repo <repo> --head dogfood-<version> --state all` shows its pull request merged, delete it with `git -C <repository> branch -D dogfood-<version>`. Use `-D`, because a squash merge leaves the branch tip outside the history of `main` and `-d` then refuses; the pull request state is the check that the work is in, not the ancestry. Keep `$RELEASE_DIR` — the tarball, the hashes and the evidence are the record of what was published. Delete it by hand when it is no longer wanted.

If an escalation is open, skip this step until the escalation closes, then run it.

## Consumers

Consumers install pinned with `pi install -l npm:ytdb-slate@<version>`. Pi skips pinned specs during `pi update`, so consumers bump their pin deliberately. On every bump, they must re-review their project delta documents (`doctrineExtraPath`, `reviewPerspectivesPath`, and prompt-document lists) against the shipped doctrine for drift.
