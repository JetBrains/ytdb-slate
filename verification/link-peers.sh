#!/usr/bin/env bash
# Link pi's bundled SDK peers into this checkout for native node:test imports.
# Real packages already installed in node_modules are left untouched.
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
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ -L "$target" ] && [ "$(cd "$(dirname "$target")" && realpath "$(readlink "$target")")" = "$source" ]; then
      printf 'link-peers: already linked %s -> %s\n' "$name" "$source"
    else
      printf 'link-peers: keeping existing %s (will not overwrite a real package or different link)\n' "$target"
    fi
    continue
  fi
  mkdir -p "$(dirname "$target")"
  ln -s "$source" "$target"
  printf 'link-peers: linked %s -> %s\n' "$name" "$source"
done <<< "$resolved"
