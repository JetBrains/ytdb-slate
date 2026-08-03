#!/usr/bin/env node
// Patch-coverage gate for Node's LCOV reporter. It intersects added diff lines
// with DA/BRDA records; files absent from LCOV fail closed instead of vanishing.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

function usage(message) {
  if (message) console.error(`coverage-gate: ${message}`);
  console.error("usage: coverage-gate.mjs --base <ref> --lcov <file> [--head <ref>] [--repo <dir>] [--threshold-lines N] [--threshold-branches N] [--include <glob>]");
  process.exit(2);
}
const options = { repo: ".", head: "HEAD", line: 85, branch: 85, includes: [] };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  const value = process.argv[++i];
  if (value === undefined) usage(`${flag} requires a value`);
  if (flag === "--repo") options.repo = value;
  else if (flag === "--base") options.base = value;
  else if (flag === "--head") options.head = value;
  else if (flag === "--lcov") options.lcov = value;
  else if (flag === "--threshold-lines") options.line = Number(value);
  else if (flag === "--threshold-branches") options.branch = Number(value);
  else if (flag === "--include") options.includes.push(value);
  else usage(`unknown option ${flag}`);
}
if (!options.base || !options.lcov) usage("--base and --lcov are required");
for (const [name, value] of [["line", options.line], ["branch", options.branch]]) {
  if (!Number.isFinite(value) || value < 0 || value > 100) usage(`${name} threshold must be from 0 to 100`);
}
if (options.includes.length === 0) options.includes.push("extension/**/*.ts");
const repo = resolve(options.repo);
const slash = (value) => value.split(sep).join("/").replace(/^\.\//, "");
function globRegex(glob) {
  let pattern = "^";
  for (let i = 0; i < glob.length; i++) {
    if (glob.slice(i, i + 3) === "**/") { pattern += "(?:.*/)?"; i += 2; }
    else if (glob.slice(i, i + 2) === "**") { pattern += ".*"; i += 1; }
    else if (glob[i] === "*") pattern += "[^/]*";
    else if (glob[i] === "?") pattern += "[^/]";
    else pattern += glob[i].replace(/[\\^$.[\]{}()+|]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`);
}
const includePatterns = options.includes.map(globRegex);
const inScope = (file) => includePatterns.some((pattern) => pattern.test(file));

function gitOutput(args, purpose) {
  const run = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (run.error || run.status !== 0) {
    process.stderr.write(run.stderr || String(run.error || `git ${purpose} failed`));
    process.exit(run.status || 2);
  }
  return run.stdout;
}
const uncommitted = new Set();
for (const args of [
  ["-c", "core.quotePath=false", "diff", "--name-only", "--"],
  ["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--"],
  ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"],
]) {
  for (const name of gitOutput(args, "working-tree inspection").split("\n")) {
    const normalized = slash(name.trim());
    if (normalized && inScope(normalized)) uncommitted.add(normalized);
  }
}
if (uncommitted.size) {
  console.log(`WORKTREE WARNING: ${uncommitted.size} uncommitted in-scope file(s) are INVISIBLE to ${options.base}..${options.head}:`);
  for (const name of [...uncommitted].sort()) console.log(`  ${name}`);
}

const diffRun = spawnSync("git", ["-c", "core.quotePath=false", "diff", "--unified=0", `${options.base}..${options.head}`, "--"], {
  cwd: repo,
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
if (diffRun.error || diffRun.status !== 0) {
  process.stderr.write(diffRun.stderr || String(diffRun.error || "git diff failed"));
  process.exit(diffRun.status || 2);
}
const changed = new Map();
const addedText = new Map();
let file;
let newLine = 0;
for (const text of diffRun.stdout.split("\n")) {
  if (text.startsWith("+++ ")) {
    const name = text.slice(4);
    file = name === "/dev/null" ? undefined : name.replace(/^b\//, "");
    if (file) {
      if (!changed.has(file)) changed.set(file, new Set());
      if (!addedText.has(file)) addedText.set(file, []);
    }
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
  if (hunk) { newLine = Number(hunk[1]); continue; }
  if (!file || text.startsWith("diff --git ")) continue;
  if (text.startsWith("+") && !text.startsWith("+++")) {
    changed.get(file).add(newLine);
    addedText.get(file).push({ line: newLine, text: text.slice(1) });
    newLine++;
  } else if (!text.startsWith("-")) {
    newLine++;
  }
}

const directiveFailures = [];
for (const [name, lines] of addedText) {
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i];
    const match = /node:coverage\s+(ignore|disable|enable)\b/i.exec(entry.text);
    if (!match) continue;
    console.log(`IGNORE DIRECTIVE: ${name}:${entry.line}: ${entry.text.trim()}`);
    let suffix = entry.text.slice((match.index ?? 0) + match[0].length);
    // `ignore next` and its optional count are directive syntax, not a reason.
    if (match[1].toLowerCase() === "ignore") suffix = suffix.replace(/^\s+next(?:\s+\d+)?\b/i, "");
    suffix = suffix.replace(/\*\//g, "").replace(/^\s*(?:[-:]+\s*)?/, "").trim();
    const neighbours = lines.slice(Math.max(0, i - 1), i + 2).map((item) => item.text).join(" ");
    const reason = suffix.length > 0 || /\b(?:reason|because|rationale)\b\s*[:=-]?\s*\S+/i.test(neighbours);
    if (!reason) directiveFailures.push(`${name}:${entry.line}`);
  }
}

const coverage = new Map();
let source;
for (const text of readFileSync(resolve(options.lcov), "utf8").split("\n")) {
  if (text.startsWith("SF:")) {
    const raw = text.slice(3);
    source = slash(isAbsolute(raw) ? relative(repo, raw) : raw);
    if (!coverage.has(source)) coverage.set(source, { lines: new Map(), branches: [] });
  } else if (source && text.startsWith("DA:")) {
    const [line, hits] = text.slice(3).split(",", 2).map(Number);
    coverage.get(source).lines.set(line, Math.max(coverage.get(source).lines.get(line) ?? 0, hits));
  } else if (source && text.startsWith("BRDA:")) {
    const [line, block, branch, rawHits] = text.slice(5).split(",");
    coverage.get(source).branches.push({ line: Number(line), block, branch, hits: rawHits === "-" ? 0 : Number(rawHits) });
  } else if (text === "end_of_record") source = undefined;
}

let lineHit = 0, lineTotal = 0, branchHit = 0, branchTotal = 0;
const scoped = [...changed.entries()].filter(([name, lines]) => inScope(name) && lines.size > 0).sort(([a], [b]) => a.localeCompare(b));
for (const [name, added] of scoped) {
  const record = coverage.get(name);
  let lines, branches, note = "";
  if (!record) {
    lines = [...added].map((line) => ({ line, hits: 0 }));
    branches = [{ line: Math.min(...added), hits: 0 }];
    note = " [NO LCOV; fail-closed synthetic branch]";
  } else {
    lines = [...added].filter((line) => record.lines.has(line)).map((line) => ({ line, hits: record.lines.get(line) }));
    branches = record.branches.filter((branch) => added.has(branch.line));
  }
  const lh = lines.filter((entry) => entry.hits > 0).length;
  const bh = branches.filter((entry) => entry.hits > 0).length;
  lineHit += lh; lineTotal += lines.length; branchHit += bh; branchTotal += branches.length;
  const lp = lines.length ? `${(100 * lh / lines.length).toFixed(2)}%` : "n/a";
  const bp = branches.length ? `${(100 * bh / branches.length).toFixed(2)}%` : "n/a";
  console.log(`${name}: lines ${lh}/${lines.length}=${lp} | branches ${bh}/${branches.length}=${bp}${note}`);
}
const linePct = lineTotal ? 100 * lineHit / lineTotal : undefined;
const branchPct = branchTotal ? 100 * branchHit / branchTotal : undefined;
const pct = (value) => value === undefined ? "n/a" : `${value.toFixed(2)}%`;
console.log(`OVERALL: lines ${lineHit}/${lineTotal}=${pct(linePct)} (floor ${options.line.toFixed(2)}%) | branches ${branchHit}/${branchTotal}=${pct(branchPct)} (floor ${options.branch.toFixed(2)}%)`);

const failures = [];
const warnings = [];
if (uncommitted.size) warnings.push(`${uncommitted.size} uncommitted in-scope file(s) are outside the committed range; commit or stash them before treating this result as complete`);
if (lineTotal === 0) warnings.push("no changed executable line had an LCOV DA record; manual review is required");
else if (linePct + Number.EPSILON < options.line) failures.push(`line patch coverage ${linePct.toFixed(2)}% is below ${options.line.toFixed(2)}%`);
if (branchTotal === 0) warnings.push("zero changed branches; branch coverage is not auto-passed and needs manual review");
else if (branchTotal < 20) warnings.push(`only ${branchTotal} changed branches (<20); branch threshold is advisory and needs manual review`);
else if (branchPct + Number.EPSILON < options.branch) failures.push(`branch patch coverage ${branchPct.toFixed(2)}% is below ${options.branch.toFixed(2)}%`);
if (directiveFailures.length) failures.push(`coverage directives without a diff-recorded reason: ${directiveFailures.join(", ")}`);
for (const warning of warnings) console.log(`WARN: ${warning}`);
for (const failure of failures) console.log(`FAIL: ${failure}`);
const verdict = failures.length ? "FAIL" : warnings.length ? "WARN" : "PASS";
console.log(`VERDICT: ${verdict} — ${scoped.length} in-scope changed file(s); line denominator ${lineTotal}; branch denominator ${branchTotal}`);
process.exitCode = failures.length ? 1 : 0;
