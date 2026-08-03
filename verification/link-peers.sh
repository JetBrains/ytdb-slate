#!/usr/bin/env bash
# Link pi's bundled SDK peers into this checkout for native node:test imports.
# Replace any other package or link: tests must use the SDK that pi itself runs.
set -euo pipefail

fail() { printf 'link-peers: %s\n' "$*" >&2; exit 2; }
command -v node >/dev/null 2>&1 || fail "node is required"
command -v pi >/dev/null 2>&1 || fail "pi is not installed or is not on PATH; install pi, then rerun npm run link:peers"

repo="$(cd "$(dirname "$0")/.." && pwd -P)"
pi_bin="$(command -v pi)"
mkdir -p "$repo/node_modules/@earendil-works"

# Resolve from pi's real launcher, as Node resolves pi's own bundled modules.
# resolve.paths() is used because some SDK export maps intentionally expose no
# package root or package.json subpath.
resolved="$(node - "$pi_bin" <<'NODE'
const { existsSync, readFileSync, realpathSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const launcher = realpathSync(process.argv[2]);
const requireFromPi = createRequire(launcher);
for (const name of [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]) {
  let found;
  for (const modules of requireFromPi.resolve.paths(name) ?? []) {
    const candidate = join(modules, name);
    const manifest = join(candidate, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      if (JSON.parse(readFileSync(manifest, "utf8")).name === name) {
        found = realpathSync(candidate);
        break;
      }
    } catch {}
  }
  if (!found) {
    console.error(`link-peers: pi at ${launcher} does not provide bundled peer ${name}`);
    process.exitCode = 9;
  } else {
    console.log(`${name}\t${found}`);
  }
}
NODE
)" || fail "could not locate all bundled peers from pi at $pi_bin"

while IFS=$'\t' read -r name source; do
  [ -n "$source" ] || continue
  target="$repo/node_modules/$name"
  current="$(realpath "$target" 2>/dev/null || true)"
  if [ "$current" = "$source" ]; then
    printf 'link-peers: verified %s uses pi copy %s\n' "$name" "$source"
    continue
  fi

  if [ -L "$target" ]; then
    printf 'link-peers: replacing stale or wrong link %s -> %s\n' "$target" "$(readlink "$target")"
    rm -f -- "$target"
  elif [ -e "$target" ]; then
    printf 'link-peers: replacing installed package at %s; tests require pi copy %s\n' "$target" "$source"
    rm -rf -- "$target"
  fi

  mkdir -p "$(dirname "$target")"
  ln -s "$source" "$target"
  [ "$(realpath "$target" 2>/dev/null || true)" = "$source" ] || fail "linked $name but could not verify target $target"
  printf 'link-peers: linked %s to pi copy %s\n' "$name" "$source"
done <<< "$resolved"
