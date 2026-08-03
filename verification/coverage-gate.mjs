#!/usr/bin/env node
// Patch-coverage gate for Node's LCOV reporter. It intersects added diff lines
// with DA/BRDA records; files absent from LCOV fail closed instead of vanishing.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

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
const rawOption = (flag) => {
  const index = process.argv.lastIndexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};
for (const [name, value, raw] of [
  ["line", options.line, rawOption("--threshold-lines")],
  ["branch", options.branch, rawOption("--threshold-branches")],
]) {
  if ((raw !== undefined && raw.trim() === "") || !Number.isFinite(value) || value < 0 || value > 100) {
    usage(`${name} threshold must be a number from 0 to 100`);
  }
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

// These options are the gate's input boundary. Local external-diff, textconv,
// and prefix configuration must never change the grammar parsed below.
const diffRun = spawnSync("git", [
  "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv",
  "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", `${options.base}..${options.head}`, "--",
], {
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
let inHunk = false;
let parsedFiles = 0;
for (const text of diffRun.stdout.split("\n")) {
  if (text.startsWith("diff --git ")) {
    parsedFiles++;
    file = undefined;
    inHunk = false;
    continue;
  }
  // A source line beginning `++ ` is encoded as `+++ ` by unified diff. A file
  // header is therefore recognized only before the first hunk in that file.
  if (!inHunk && text.startsWith("+++ ")) {
    const name = text.slice(4);
    file = name === "/dev/null" ? undefined : name.replace(/^b\//, "");
    if (file) {
      if (!changed.has(file)) changed.set(file, new Set());
      if (!addedText.has(file)) addedText.set(file, []);
    }
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
  if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
  if (!file || !inHunk) continue;
  // Git's no-trailing-newline annotation describes the preceding line. It is
  // not content and advances neither side of the hunk.
  if (text.startsWith("\\ ")) continue;
  if (text.startsWith("+")) {
    changed.get(file).add(newLine);
    addedText.get(file).push({ line: newLine, text: text.slice(1) });
    newLine++;
  } else if (!text.startsWith("-")) {
    newLine++;
  }
}
// CENTRAL INVARIANT: nonempty diff bytes must identify at least one file. A
// successful parse of nothing is indistinguishable from disabling the gate.
if (diffRun.stdout.length > 0 && parsedFiles === 0) {
  console.error("coverage-gate: nonempty git diff produced zero parsed files; refusing to report coverage");
  process.exit(2);
}

// Copied from Node 24.18's internal/test_runner/coverage.js. Node applies
// these regexes directly to raw source lines: no anchoring, lexical analysis,
// case folding or whitespace normalization. Diverging in either direction can
// hide coverage or reject inert text, so keep these byte-for-byte equivalent.
// That exact-matching rule governs these directives; comment classification
// instead has to be monotone whenever its lexer cannot decide.
const NODE_IGNORE_DIRECTIVE = /\/\* node:coverage ignore next (?<count>\d+ )?\*\//;
const NODE_STATUS_DIRECTIVE = /\/\* node:coverage (?<status>enable|disable) \*\//;
function directivesOnLine(text) {
  return [NODE_IGNORE_DIRECTIVE.exec(text), NODE_STATUS_DIRECTIVE.exec(text)]
    .filter((match) => match !== null)
    .sort((left, right) => left.index - right.index)
    .map((match) => ({ suffix: text.slice(match.index + match[0].length) }));
}
function hasDirectiveReason(suffix) {
  const match = /\b(?:reason|because|rationale)\s*[:=-]\s*(.*)$/iu.exec(suffix);
  return match !== null && /[\p{L}\p{N}]{2}/u.test(match[1]);
}

const directiveFailures = [];
for (const [name, lines] of addedText) {
  for (const entry of lines) {
    for (const directive of directivesOnLine(entry.text)) {
      console.log(`IGNORE DIRECTIVE: ${name}:${entry.line}: ${entry.text.trim()}`);
      if (!hasDirectiveReason(directive.suffix)) directiveFailures.push(`${name}:${entry.line}`);
    }
  }
}

let lcovText;
try {
  lcovText = readFileSync(resolve(options.lcov), "utf8");
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`coverage-gate: infrastructure error reading LCOV: ${detail}`);
  process.exit(2);
}
const coverage = new Map();
let source;
for (const text of lcovText.split("\n")) {
  if (text.startsWith("SF:")) {
    const raw = text.slice(3);
    source = slash(isAbsolute(raw) ? relative(repo, raw) : raw);
    if (!coverage.has(source)) coverage.set(source, { lines: new Map(), branches: new Map() });
  } else if (source && text.startsWith("DA:")) {
    const [line, hits] = text.slice(3).split(",", 2).map(Number);
    if (Number.isInteger(line) && line > 0 && Number.isFinite(hits) && hits >= 0) {
      coverage.get(source).lines.set(line, Math.max(coverage.get(source).lines.get(line) ?? 0, hits));
    }
  } else if (source && text.startsWith("BRDA:")) {
    const [rawLine, block, branch, rawHits] = text.slice(5).split(",");
    const line = Number(rawLine);
    const hits = rawHits === "-" ? 0 : Number(rawHits);
    if (Number.isInteger(line) && line > 0 && Number.isFinite(hits) && hits >= 0) {
      const identity = JSON.stringify([line, block, branch]);
      const previous = coverage.get(source).branches.get(identity);
      if (!previous || hits > previous.hits) coverage.get(source).branches.set(identity, { line, block, branch, hits });
    }
  } else if (text === "end_of_record") source = undefined;
}

// Node emits DA records for every physical line of a loaded file, including
// blanks, comments, interfaces and type-only imports, so DA presence does not
// prove executability. DA absence does not disprove it either: an ordinary
// executable `if` inside Node's coverage-disable region has no DA.
// Source classification decides which lines are counted; LCOV decides whether
// those lines are covered. Exclusion needs positive proof. Any unresolved
// classification counts every addition as uncovered.
function blankComments(text) {
  const out = text.split("");
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " "; };
  // Stack entries distinguish a template body from `${` and ordinary braces.
  const stack = [];
  let prev = "";
  let i = 0;
  const inTemplate = () => stack.length && stack[stack.length - 1].kind === "tpl";
  while (i < text.length) {
    const ch = text[i];
    if (inTemplate()) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { stack.pop(); prev = "`"; i++; continue; }
      if (ch === "$" && text[i + 1] === "{") { stack.push({ kind: "brace" }); prev = "{"; i += 2; continue; }
      i++; continue;
    }
    const next = text[i + 1];
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      blank(i, end + 2); i = end + 2; continue;
    }
    if (ch === "/" && next === "/") {
      let j = i; while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
      blank(i, j); i = j; continue;
    }
    if (ch === "\"" || ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) return undefined;
        const c = text[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "\n" || c === "\r") return undefined;
        if (c === ch) { j++; break; }
        j++;
      }
      prev = "x"; i = j; continue;
    }
    if (ch === "`") { stack.push({ kind: "tpl" }); i++; continue; }
    if (ch === "{") { stack.push({ kind: "brace" }); prev = "{"; i++; continue; }
    if (ch === "}") {
      if (stack.length && stack[stack.length - 1].kind === "brace") stack.pop();
      prev = "}"; i++; continue;
    }
    if (ch === "/") {
      const regexOk = prev === "" || /[=(,:[!&|?{};+\-*%~^<>]$/.test(prev)
        || /\b(return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/.test(prev)
        || /\b(?:if|while|for|with)\s*\([^)]*\)$/.test(prev);
      if (regexOk) {
        let j = i + 1, cls = false, closed = false;
        while (j < text.length) {
          const c = text[j];
          if (c === "\\") { j += 2; continue; }
          if (c === "\n" || c === "\r") break;
          if (c === "[") cls = true;
          else if (c === "]") cls = false;
          else if (c === "/" && !cls) { j++; closed = true; break; }
          j++;
        }
        if (!closed) return undefined;
        prev = "x"; i = j; continue;
      }
      prev = "/"; i++; continue;
    }
    if (!/\s/.test(ch)) prev = (prev + ch).slice(-12);
    i++;
  }
  if (stack.length) return undefined;
  return out.join("");
}

function executableLinesAtHead(name) {
  const sourceText = gitOutput(["show", `${options.head}:${name}`], `reading ${name} at ${options.head}`);
  let stripped;
  const emitWarning = process.emitWarning;
  try {
    // Node labels the API experimental even though native type stripping is the
    // harness's execution path. Keep that process-global warning out of output.
    process.emitWarning = () => {};
    stripped = stripTypeScriptTypes(sourceText, { mode: "strip" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? ` ${error.code}` : "";
    console.error(`coverage-gate: ${name} at ${options.head} is not erasable TypeScript (${code.trim() || "parse error"}); refusing to report coverage`);
    process.exit(2);
  } finally {
    process.emitWarning = emitWarning;
  }
  try {
    const withoutComments = blankComments(stripped);
    if (withoutComments === undefined) return { status: "void" };
    const executable = new Set();
    for (const [index, text] of withoutComments.split("\n").entries()) {
      if (text.trim() !== "") executable.add(index + 1);
    }
    return { status: "ok", lines: executable };
  } catch {
    return { status: "void" };
  }
}

let lineHit = 0, lineTotal = 0, branchHit = 0, branchTotal = 0;
const classifierFailures = [];
const scoped = [...changed.entries()].filter(([name, lines]) => inScope(name) && lines.size > 0).sort(([a], [b]) => a.localeCompare(b));
for (const [name, added] of scoped) {
  const record = coverage.get(name);
  const classified = executableLinesAtHead(name);
  const executableAdded = [...added].filter((line) => classified.status === "void" || classified.lines.has(line));
  let lines, branches, note = "";
  if (!record || record.lines.size === 0) {
    lines = executableAdded.map((line) => ({ line, hits: 0 }));
    branches = lines.length === 0 ? [] : [{ line: Math.min(...executableAdded), hits: 0 }];
    note = lines.length === 0 && classified.status === "ok"
      ? " [NO EXECUTABLE ADDITIONS]"
      : " [NO USABLE LCOV; fail-closed synthetic branch]";
  } else {
    lines = executableAdded.map((line) => ({ line, hits: classified.status === "void" ? 0 : record.lines.get(line) ?? 0 }));
    branches = [...record.branches.values()].filter((branch) =>
      added.has(branch.line) && (classified.status === "void" || classified.lines.has(branch.line) || branch.hits <= 0));
    const uncoveredOrUnmeasured = lines.some((entry) => entry.hits <= 0);
    if (classified.status === "void" || (uncoveredOrUnmeasured && !branches.some((branch) => branch.hits <= 0))) {
      branches.push({ line: Math.min(...executableAdded), hits: 0 });
      note = classified.status === "void"
        ? " [CLASSIFIER VOID; all additions counted uncovered]"
        : " [LCOV GAP; fail-closed synthetic branch]";
    }
  }
  if (classified.status === "void") {
    note = " [CLASSIFIER VOID; all additions counted uncovered]";
    classifierFailures.push(`classifier could not resolve ${name}; all additions counted uncovered`);
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

const failures = [...classifierFailures];
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
