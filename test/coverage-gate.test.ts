import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const GATE = fileURLToPath(new URL("../verification/coverage-gate.mjs", import.meta.url));
const RUNNER = fileURLToPath(new URL("../verification/run-tests.sh", import.meta.url));

interface RunResult { status: number | null; stdout: string; stderr: string }

function command(cwd: string, executable: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const mergedEnv = { ...process.env, ...env };
  for (const [name, value] of Object.entries(mergedEnv)) if (value === undefined) delete mergedEnv[name];
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", env: mergedEnv, timeout: 20_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, ...args: string[]): string {
  const result = command(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t: { after(fn: () => void): void }, initial = "export const before = 1;\n") {
  const repo = mkdtempSync(join(tmpdir(), "slate-gate-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "gate@example.invalid");
  git(repo, "config", "user.name", "Gate Test");
  write(repo, "extension/sample.ts", initial);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

function write(repo: string, relative: string, content: string | NodeJS.ArrayBufferView) {
  const path = join(repo, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commit(repo: string, message = "head") {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
}

function runGate(repo: string, base: string, lcov: string, extra: string[] = [], env?: NodeJS.ProcessEnv): RunResult {
  const lcovPath = join(repo, "gate.lcov");
  writeFileSync(lcovPath, lcov);
  return command(repo, process.execPath, [GATE, "--repo", repo, "--base", base, "--head", "HEAD", "--lcov", lcovPath, ...extra], env);
}

function emptyLcov() { return "TN:\n"; }
function sourceLcov(lines: string[], branches: string[] = []) {
  return ["TN:", "SF:extension/sample.ts", ...lines.map((line) => `DA:${line}`), ...branches.map((branch) => `BRDA:${branch}`), "end_of_record", ""].join("\n");
}

test("gate parser keeps no-newline markers and ++ source lines out of file accounting (WH20, WH21)", async (t) => {
  await t.test("no trailing newline", (t) => {
    const { repo, base } = fixture(t, "export const before = 1;\nexport const tail = 2;");
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const tail = 2;\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\n");
    commit(repo);
    const additions = Number(git(repo, "diff", "--numstat", `${base}..HEAD`).split("\t")[0]);
    const result = runGate(repo, base, sourceLcov(["2,1", "3,1", "4,1", "5,1", "6,1", "7,1", "8,0"]));
    assert.match(result.stdout, new RegExp(`line denominator ${additions}(?:;|$)`));
  });

  await t.test("source beginning with ++ and a space", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const text = `\n++ tmp/notes.txt\nfollowing line\n`;\n");
    commit(repo);
    const additions = Number(git(repo, "diff", "--numstat", `${base}..HEAD`).split("\t")[0]);
    const result = runGate(repo, base, emptyLcov());
    assert.match(result.stdout, /extension\/sample\.ts:/);
    assert.match(result.stdout, new RegExp(`line denominator ${additions}(?:;|$)`));
  });
});

test("gate forces an internal unified diff and rejects nonempty unparseable output (WH22)", async (t) => {
  await t.test("external diff cannot hide a file", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const changed = 2;\n");
    commit(repo);
    const external = join(repo, "external-diff.sh");
    writeFileSync(external, "#!/bin/sh\nprintf 'external output only\\n'\n");
    chmodSync(external, 0o755);
    git(repo, "config", "diff.external", external);
    const result = runGate(repo, base, emptyLcov());
    assert.match(result.stdout, /extension\/sample\.ts:/);
    assert.equal(result.status, 1);
  });

  await t.test("configured diff prefixes cannot move a file out of scope", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const changed = 2;\n");
    commit(repo);
    git(repo, "config", "diff.dstPrefix", "poison/");
    const result = runGate(repo, base, emptyLcov());
    assert.match(result.stdout, /extension\/sample\.ts:/);
    assert.equal(result.status, 1);
  });

  await t.test("textconv cannot erase a changed file", (t) => {
    const first = fixture(t);
    write(first.repo, ".gitattributes", "extension/*.ts diff=poison\n");
    commit(first.repo, "attributes");
    const base = git(first.repo, "rev-parse", "HEAD");
    const textconv = join(first.repo, "textconv.sh");
    writeFileSync(textconv, "#!/bin/sh\nprintf 'same transformed text\\n'\n");
    chmodSync(textconv, 0o755);
    git(first.repo, "config", "diff.poison.textconv", textconv);
    write(first.repo, "extension/sample.ts", "export const changed = 2;\n");
    commit(first.repo);
    const result = runGate(first.repo, base, emptyLcov());
    assert.match(result.stdout, /extension\/sample\.ts:/);
    assert.equal(result.status, 1);
  });

  await t.test("nonempty output with no parsed file is an error", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const changed = 2;\n");
    commit(repo);
    const bin = join(repo, "bin");
    mkdirSync(bin);
    const realGit = command(repo, "sh", ["-c", "command -v git"]).stdout.trim();
    const fakeGit = join(bin, "git");
    writeFileSync(fakeGit, "#!/bin/sh\ncase \" $* \" in *' --unified=0 '*) printf 'malformed diff bytes\\n'; exit 0;; esac\nexec \"$REAL_GIT\" \"$@\"\n");
    chmodSync(fakeGit, 0o755);
    const result = runGate(repo, base, emptyLcov(), [], { PATH: `${bin}:${process.env.PATH ?? ""}`, REAL_GIT: realGit });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nonempty git diff produced zero parsed files/i);
  });
});

test("thresholds reject empty and whitespace-only values (WH24)", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const changed = 2;\n");
  commit(repo);
  for (const value of ["", "   "]) {
    const result = runGate(repo, base, emptyLcov(), ["--threshold-lines", value]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /threshold must be a number from 0 to 100/i);
  }
});

test("an uncovered addition in an LCOV-recorded file gets a synthetic branch (WH25)", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\nexport function fresh(value: number) {\n  if (value > 0) return value;\n  return 0;\n}\n");
  commit(repo);
  const result = runGate(repo, base, sourceLcov(["2,1", "3,1", "4,0", "5,1"]), ["--threshold-lines", "0"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /branches 0\/1=0\.00%.*synthetic branch/i);
  assert.match(result.stdout, /branch denominator 1/);
});

test("coverage directives require a substantive reason after the directive (WH26, RG24, RG25)", (t) => {
  // Use explicit fixtures rather than a shared file so one accepted reason cannot mask another.
  for (const text of [
    "/* node:coverage disable */ // .", // reason: fixture tests a one-character pseudo-reason
    "/* node:coverage disable */ // reason: x", // reason: fixture tests an insubstantial named reason
    "// reason: substantial but before /* node:coverage disable */", // reason: fixture tests reason position
    "// reason: unrelated neighbouring prose\n/* node:coverage disable */", // reason: fixture tests neighboring prose
  ]) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", `export const before = 1;\n${text}\n`);
    commit(repo);
    const result = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /coverage directives without a diff-recorded reason/);
  }
  for (const reason of [
    "// reason: generated fallback cannot execute",
    "// reason - generated fallback cannot execute",
  ]) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", `export const before = 1;\n/* node:coverage disable */ ${reason}\n`); // reason: fixture tests accepted reason separators
    commit(repo);
    const accepted = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
    assert.doesNotMatch(accepted.stdout, /coverage directives without a diff-recorded reason/);
  }
});

test("pre-base suppression counts executable DA gaps as uncovered, but types stay excluded (RG26)", async (t) => {
  await t.test("pre-base disable cannot hide half the added executable lines", (t) => {
    const { repo, base } = fixture(t, "/* node:coverage disable */\n/* node:coverage enable */\n"); // reason: fixture establishes pre-base suppression
    const hidden = Array.from({ length: 12 }, (_, index) => `export const hidden${index} = ${index};`);
    const visible = Array.from({ length: 12 }, (_, index) => `export const visible${index} = ${index};`);
    write(repo, "extension/sample.ts", ["/* node:coverage disable */", ...hidden, "/* node:coverage enable */", ...visible, ""].join("\n")); // reason: fixture preserves pre-base directive scope
    commit(repo);
    const da = visible.map((_, index) => `${15 + index},1`);
    const branches = visible.flatMap((_, index) => [`${15 + index},0,0,1`, `${15 + index},0,1,1`]);
    const result = runGate(repo, base, sourceLcov(da, branches));
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /lines 12\/24=50\.00%/);
    assert.match(result.stdout, /branches 24\/25=96\.00%.*synthetic branch/i);
  });

  await t.test("a new type-only module has no executable denominator", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/types.ts", [
      "// This comment and the blank line below have no runtime coverage.",
      "",
      "import type { Readable } from 'node:stream';",
      "export interface Shape {",
      "  readonly name: string;",
      "}",
      "export type Maybe<T> = T | null;",
      "export type StreamShape = Readable & Shape;",
      "",
    ].join("\n"));
    commit(repo);
    const result = runGate(repo, base, emptyLcov());
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /extension\/types\.ts: lines 0\/0=n\/a \| branches 0\/0=n\/a/);
    assert.match(result.stdout, /no changed executable line had an LCOV DA record; manual review is required/);
    assert.match(result.stdout, /VERDICT: WARN/);
    assert.doesNotMatch(result.stdout, /FAIL:/);
  });
});

test("DA-bearing lines survive classifier comment confusion (RG27)", { timeout: 20_000 }, (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", [
    "export const before = 1;",
    "export const providerPattern = 'anthropic/*';",
    "export function hiddenA(value: number) {",
    "  const first = value + 1;",
    "  if (first > 10) return first;",
    "  if (first > 5) return first + 1;",
    "  return 0;",
    "}",
    "export function hiddenB(value: number) {",
    "  const second = value + 2;",
    "  if (second > 3) return second;",
    "  return 0;",
    "}",
    "/**",
    " * This real terminator closes the wildcard-like substring above.",
    " */",
    "export function visible(value: number) {",
    "  const result = value + 1;",
    "  return result;",
    "}",
    "export const visibleValue = visible(1);",
    "",
  ].join("\n"));
  commit(repo);
  write(repo, "fixture.test.mjs", "import test from 'node:test';\nimport { hiddenA, visibleValue } from './extension/sample.ts';\ntest('visible path', () => { if (hiddenA(0) !== 0 || visibleValue !== 2) throw new Error('bad value'); });\n");
  const lcovPath = join(repo, "real.lcov");
  const coverageRun = command(repo, process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", "--experimental-test-coverage",
    "--test-coverage-include=extension/sample.ts", "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`, "fixture.test.mjs",
  ], { NODE_TEST_CONTEXT: undefined });
  assert.equal(coverageRun.status, 0, coverageRun.stderr);
  const lcov = readFileSync(lcovPath, "utf8");
  const da = [...lcov.matchAll(/^DA:(\d+),(\d+)/gm)]
    .map((match) => ({ line: Number(match[1]), hits: Number(match[2]) }))
    .filter((entry) => entry.line >= 2);
  const brda = [...lcov.matchAll(/^BRDA:(\d+),[^,]*,[^,]*,([^\r\n]+)/gm)]
    .map((match) => ({ line: Number(match[1]), hits: match[2] === "-" ? 0 : Number(match[2]) }))
    .filter((entry) => entry.line >= 2);
  assert.ok(da.some((entry) => entry.hits === 0), "fixture must contain real uncovered DA records");
  assert.ok(brda.filter((entry) => entry.hits === 0).length >= 2, "fixture must contain multiple real uncovered BRDA records before the terminator");
  const result = runGate(repo, base, lcov);
  assert.equal(result.status, 1, result.stdout);
  // The classifier excludes the added blank line, three JSDoc lines and
  // TypeScript-only syntax. Raw DA/BRDA counts are not executable denominators.
  assert.match(result.stdout, /lines 13\/17=76\.47%/);
  assert.match(result.stdout, /branches 2\/4=50\.00%/);
  assert.match(result.stdout, /VERDICT: FAIL/);
});

test("ordinary comments and erased types cannot dilute uncovered code (RG30, RG31)", { timeout: 20_000 }, (t) => {
  const seeded = fixture(t);
  git(seeded.repo, "mv", "extension/sample.ts", "extension/base.ts");
  commit(seeded.repo, "base module");
  const repo = seeded.repo;
  const base = git(repo, "rev-parse", "HEAD");
  write(repo, "extension/sample.ts", [
    "// Route planning helpers for the dispatch path.",
    "import { basename } from 'node:path';",
    "",
    "/** A resolved candidate model with its effort ladder. */",
    "export interface Candidate {",
    "  id: string;",
    "  tier: number;",
    "  ladder: string[];",
    "  price: { input: number; output: number };",
    "}",
    "",
    "/** The verdict a guard renders for one dispatch. */",
    "export type Verdict =",
    "  | { kind: 'allow'; model: string }",
    "  | { kind: 'deny'; reason: string };",
    "",
    "",
    "/** Options accepted by the dispatch assembler. */",
    "export interface DispatchOptions {",
    "  thread: string;",
    "  action: string;",
    "  model?: string;",
    "  effort?: string;",
    "  attachments?: string[];",
    "}",
    "",
    "/**",
    " * Pick the cheapest candidate that supports the requested effort.",
    " * Returns a deny verdict when no candidate has the level on its ladder.",
    " */",
    "export function pick(candidates: Candidate[], effort: string): Verdict {",
    "  const usable = candidates.filter((entry) => entry.ladder.includes(effort));",
    "  if (usable.length === 0) return { kind: 'deny', reason: 'no ladder support' };",
    "  const best = usable.sort((a, b) => a.price.input - b.price.input)[0];",
    "  return { kind: 'allow', model: best.id };",
    "}",
    "",
    "/**",
    " * Format a guard denial for the episode log. Never called in tests today.",
    " */",
    "export function describe(verdict: Verdict, file: string): string {",
    "  if (verdict.kind === 'allow') {",
    "    return `allow ${verdict.model} for ${basename(file)}`;",
    "  }",
    "  const suffix = verdict.reason.length > 20 ? '...' : '';",
    "  return `deny (${verdict.reason.slice(0, 20)}${suffix}) for ${basename(file)}`;",
    "}",
    "",
  ].join("\n"));
  commit(repo);
  write(repo, "fixture.test.mjs", "import test from 'node:test';\nimport { pick } from './extension/sample.ts';\ntest('allow', () => { if (pick([{ id: 'a', tier: 1, ladder: ['high'], price: { input: 1, output: 2 } }], 'high').kind !== 'allow') throw new Error('bad'); });\ntest('deny', () => { if (pick([], 'high').kind !== 'deny') throw new Error('bad'); });\n");
  const lcovPath = join(repo, "real.lcov");
  const coverageRun = command(repo, process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", "--experimental-test-coverage",
    "--test-coverage-include=extension/sample.ts", "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`, "fixture.test.mjs",
  ], { NODE_TEST_CONTEXT: undefined });
  assert.equal(coverageRun.status, 0, coverageRun.stderr);
  const result = runGate(repo, base, readFileSync(lcovPath, "utf8"));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /lines 8\/14=57\.14%/);
  assert.match(result.stdout, /branches 3\/4=75\.00%/);
  assert.match(result.stdout, /VERDICT: FAIL/);
});

test("uncovered branches on erased lines remain evidence (RG31)", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\nexport interface Shape {\n  name: string;\n}\n");
  commit(repo);
  const result = runGate(repo, base, sourceLcov(["2,1", "3,1", "4,1"], ["2,0,0,0"]));
  assert.match(result.stdout, /lines 0\/0=n\/a \| branches 0\/1=0\.00%/);
});

test("a covered regex after a long non-braced if condition stays executable (RG32)", { timeout: 20_000 }, (t) => {
  const seeded = fixture(t);
  git(seeded.repo, "mv", "extension/sample.ts", "extension/base.ts");
  commit(seeded.repo, "base module");
  const repo = seeded.repo;
  const base = git(repo, "rev-parse", "HEAD");
  write(repo, "extension/sample.ts", [
    "export function testQuoted(value: string): boolean {",
    "  let matched = false;",
    "  if (valueHasEnoughCharacters(value)) /[\\\"'`]/.test(value) && (matched = true);",
    "  return matched;",
    "}",
    "function valueHasEnoughCharacters(value: string): boolean {",
    "  return value.length > 2;",
    "}",
    "export const observed = testQuoted('abc');",
  ].join("\n"));
  commit(repo);
  write(repo, "fixture.test.mjs", "import test from 'node:test';\nimport { observed } from './extension/sample.ts';\ntest('covered', () => { if (observed !== false) throw new Error('bad'); });\n");
  const lcovPath = join(repo, "real.lcov");
  const coverageRun = command(repo, process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", "--experimental-test-coverage",
    "--test-coverage-include=extension/sample.ts", "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`, "fixture.test.mjs",
  ], { NODE_TEST_CONTEXT: undefined });
  assert.equal(coverageRun.status, 0, coverageRun.stderr);
  const result = runGate(repo, base, readFileSync(lcovPath, "utf8"));
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /lines 9\/9=100\.00%/);
  assert.match(result.stdout, /VERDICT: WARN/);
  assert.doesNotMatch(result.stdout, /CLASSIFIER VOID|FAIL:/);
});

test("a missing exact-pinned TypeScript devDependency is a legible infrastructure error", { timeout: 20_000 }, (t) => {
  const isolated = mkdtempSync(join(tmpdir(), "slate-gate-no-typescript-"));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  const copiedGate = join(isolated, "coverage-gate.mjs");
  cpSync(GATE, copiedGate);
  const result = command(isolated, process.execPath, [copiedGate]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /infrastructure error loading exact-pinned devDependency typescript/i);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("classifier void forces zero hits and a failing verdict", { timeout: 20_000 }, (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\nexport const covered = 2;\n");
  commit(repo);
  const gateSource = readFileSync(GATE, "utf8");
  const mutantDir = mkdtempSync(join(dirname(GATE), ".gate-void-"));
  t.after(() => rmSync(mutantDir, { recursive: true, force: true }));
  const mutant = join(mutantDir, "coverage-gate-void.mjs");
  const needle = "const lines = executableTokenLines(stripped, name);";
  assert.equal(gateSource.split(needle).length, 2, "classifier injection point must remain unique");
  writeFileSync(mutant, gateSource.replace(needle, "const lines = undefined;"));
  const lcovPath = join(repo, "gate.lcov");
  writeFileSync(lcovPath, sourceLcov(["2,1"], ["2,0,0,1"]));
  const result = command(repo, process.execPath, [mutant, "--repo", repo, "--base", base, "--head", "HEAD", "--lcov", lcovPath]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /lines 0\/1=0\.00%/);
  assert.match(result.stdout, /CLASSIFIER VOID; all additions counted uncovered/);
  assert.match(result.stdout, /classifier could not resolve extension\/sample\.ts/);
  assert.match(result.stdout, /VERDICT: FAIL/);
});

test("a TypeScript parser diagnostic makes classification void", { timeout: 20_000 }, (t) => {
  const { repo, base } = fixture(t, "const before = 1;\n");
  // Node's stripper accepts this legacy numeric spelling in a script, while
  // TypeScript's JS parser reports diagnostic 1489. The gate must fail closed.
  write(repo, "extension/sample.ts", "const before = 1;\nconst legacy = 08;\n");
  commit(repo);
  const result = runGate(repo, base, sourceLcov(["2,1"], ["2,0,0,1"]));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /lines 0\/1=0\.00%/);
  assert.match(result.stdout, /CLASSIFIER VOID; all additions counted uncovered/);
  assert.match(result.stdout, /VERDICT: FAIL/);
});

test("non-erasable TypeScript stops coverage reporting", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\nenum Direction { Left, Right }\n");
  commit(repo);
  const result = runGate(repo, base, emptyLcov());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /is not erasable TypeScript \(ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX\); refusing to report coverage/);
  assert.doesNotMatch(result.stdout, /VERDICT:/);
});

test("directive scan catches every raw-line shape Node 24.18 matches (RG21)", (t) => {
  const rejected = [
    "/* node:coverage disable */", // reason: fixture tests a leading status directive
    "run(); /* node:coverage enable */", // reason: fixture tests a trailing status directive
    "/* node:coverage ignore next */", // reason: fixture tests the default ignore count
    "run(); /* node:coverage ignore next 3 */", // reason: fixture tests an explicit ignore count
    "const text = '/* node:coverage disable */';", // reason: fixture tests raw matching in a string
    "const text = `/* node:coverage enable */`;", // reason: fixture tests raw matching in a template
  ];
  for (const text of rejected) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", `export const before = 1;\n${text}\n`);
    commit(repo);
    const result = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
    assert.equal(result.status, 1, `${text}\n${result.stdout}`);
    assert.match(result.stdout, /IGNORE DIRECTIVE:/);
    assert.match(result.stdout, /coverage directives without a diff-recorded reason/);
  }

  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\nconst marker = '/* node:coverage disable */'; // reason: fixture validates raw matching\n");
  commit(repo);
  const reasoned = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
  assert.match(reasoned.stdout, /IGNORE DIRECTIVE:/);
  assert.doesNotMatch(reasoned.stdout, /coverage directives without a diff-recorded reason/);
});

test("directive scan ignores every shape Node 24.18 does not match (RG23)", (t) => {
  const ignored = [
    "// node:coverage disable",
    "run(); // node:coverage enable",
    "// node:coverage ignore next",
    "run(); // node:coverage ignore next",
    "* node:coverage disable */",
    "/* node:coverage DISABLE */",
    "/* node:coverage IGNORE next */",
    "/*  node:coverage disable */",
    "/* node:coverage  disable */",
    "/* node:coverage ignore  next */",
    "run(); /* note node:coverage disable */",
  ];
  for (const text of ignored) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", `export const before = 1;\n${text}\n`);
    commit(repo);
    const result = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
    assert.doesNotMatch(result.stdout, /IGNORE DIRECTIVE:/, text);
    assert.doesNotMatch(result.stdout, /coverage directives without a diff-recorded reason/, text);
  }
});

test("--head controls both the diff and source classification", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\nexport const atTarget = 2;\n");
  commit(repo, "target");
  const target = git(repo, "rev-parse", "HEAD");
  write(repo, "extension/sample.ts", "export const before = 1;\nexport type AtHead = number;\n");
  commit(repo, "later head");
  const lcovPath = join(repo, "gate.lcov");
  writeFileSync(lcovPath, sourceLcov(["2,1"]));
  const result = command(repo, process.execPath, [
    GATE, "--repo", repo, "--base", base, "--head", target, "--lcov", lcovPath,
  ]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /lines 1\/1=100\.00%/);
});

test("run-tests preserves a gate WARN as its final verdict (WH23)", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "slate-runner-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "verification"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  cpSync(RUNNER, join(repo, "verification/run-tests.sh"));
  writeFileSync(join(repo, "verification/size-grade-tests.mjs"), "process.exit(0);\n");
  writeFileSync(join(repo, "verification/link-peers.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(repo, "verification/coverage-gate.mjs"), "console.log('VERDICT: WARN — fixture requires manual review');\n");
  writeFileSync(join(repo, "test/smoke.test.ts"), "import test from 'node:test'; test('smoke', () => {});\n");
  const bin = join(repo, "bin");
  mkdirSync(bin);
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --test-reporter-destination=*) destination="\${arg#*=}" ;;
  esac
done
case " $* " in
  *size-grade-tests.mjs*) exit 0 ;;
  *' --test '*) printf 'TN:\\n' > "$destination"; printf 'fixture node:test PASS\\n'; exit 0 ;;
esac
printf 'VERDICT: WARN — fixture requires manual review\\n'
`);
  chmodSync(fakeNode, 0o755);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "gate@example.invalid");
  git(repo, "config", "user.name", "Gate Test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  const result = command(repo, "bash", ["verification/run-tests.sh"], { PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RUN VERDICT: WARN —/);
  assert.doesNotMatch(result.stdout, /RUN VERDICT: PASS/);
});

test("run-tests refuses a missing size-grade suite before running tests", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "slate-missing-size-suite-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "verification"), { recursive: true });
  cpSync(RUNNER, join(repo, "verification/run-tests.sh"));
  const result = command(repo, "bash", ["verification/run-tests.sh"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /run-tests: missing size-grade regression suite at /);
  assert.doesNotMatch(result.stdout, /TEST VERDICT: PASS/);
});

test("run-tests refuses and removes a scratch directory inside home", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "slate-runner-home-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "verification"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  cpSync(RUNNER, join(repo, "verification/run-tests.sh"));
  writeFileSync(join(repo, "verification/size-grade-tests.mjs"), "process.exit(0);\n");
  writeFileSync(join(repo, "verification/link-peers.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(repo, "test/smoke.test.ts"), "// unreachable fixture\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "gate@example.invalid");
  git(repo, "config", "user.name", "Gate Test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  const home = join(repo, "home");
  mkdirSync(home);
  const result = command(repo, "bash", ["verification/run-tests.sh", "--no-gate"], { HOME: home, TMPDIR: home });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /temporary directory is inside the real home directory/);
  assert.deepEqual(readdirSync(home), []);
});

test("missing LCOV is an infrastructure error and the runner labels it (WH41)", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const changed = 2;\n");
  commit(repo);
  const missing = command(repo, process.execPath, [
    GATE, "--repo", repo, "--base", base, "--head", "HEAD", "--lcov", join(repo, "absent.lcov"),
  ]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /coverage-gate: infrastructure error.*LCOV/i);

  const runnerRepo = mkdtempSync(join(tmpdir(), "slate-runner-error-test-"));
  t.after(() => rmSync(runnerRepo, { recursive: true, force: true }));
  mkdirSync(join(runnerRepo, "verification"), { recursive: true });
  mkdirSync(join(runnerRepo, "test"), { recursive: true });
  cpSync(RUNNER, join(runnerRepo, "verification/run-tests.sh"));
  writeFileSync(join(runnerRepo, "verification/size-grade-tests.mjs"), "process.exit(0);\n");
  writeFileSync(join(runnerRepo, "verification/link-peers.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(runnerRepo, "verification/coverage-gate.mjs"), "process.exitCode = 2;\n");
  writeFileSync(join(runnerRepo, "test/smoke.test.ts"), "// fixture\n");
  const bin = join(runnerRepo, "bin");
  mkdirSync(bin);
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, `#!/bin/sh
for arg in "$@"; do case "$arg" in --test-reporter-destination=*) destination="\${arg#*=}" ;; esac; done
case " $* " in
  *size-grade-tests.mjs*) exit 0 ;;
  *' --test '*) printf 'TN:\\n' > "$destination"; exit 0 ;;
esac
exit 2
`);
  chmodSync(fakeNode, 0o755);
  git(runnerRepo, "init", "-q", "-b", "main");
  git(runnerRepo, "config", "user.email", "gate@example.invalid");
  git(runnerRepo, "config", "user.name", "Gate Test");
  git(runnerRepo, "add", ".");
  git(runnerRepo, "commit", "-qm", "fixture");
  const runner = command(runnerRepo, "bash", ["verification/run-tests.sh"], { PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(runner.status, 2);
  assert.match(runner.stdout, /RUN VERDICT: ERROR — coverage infrastructure failed/);
  assert.doesNotMatch(runner.stdout, /rejected the patch/);
  const retained = /retained failure artifacts at (.+)/.exec(runner.stderr)?.[1]?.trim();
  assert.ok(retained, runner.stderr);
  assert.equal(existsSync(join(retained, "lcov.info")), true);
  rmSync(retained, { recursive: true, force: true });
});

test("ordinary non-line diffs remain parseable", async (t) => {
  for (const kind of ["rename", "deletion", "binary", "mode"] as const) {
    await t.test(kind, (t) => {
      const { repo, base } = fixture(t);
      if (kind === "rename") git(repo, "mv", "extension/sample.ts", "extension/renamed.ts");
      if (kind === "deletion") rmSync(join(repo, "extension/sample.ts"));
      if (kind === "binary") write(repo, "extension/blob.ts", Buffer.from([0, 1, 2, 3]));
      if (kind === "mode") chmodSync(join(repo, "extension/sample.ts"), 0o755);
      commit(repo);
      const result = runGate(repo, base, emptyLcov());
      assert.notEqual(result.status, 2, `${kind}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /zero parsed files/i);
    });
  }
});

test("CRLF additions and duplicate, malformed, truncated, and foreign LCOV records fail closed", async (t) => {
  await t.test("CRLF", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\r\nexport const crlf = 2;\r\n");
    commit(repo);
    const additions = Number(git(repo, "diff", "--numstat", `${base}..HEAD`).split("\t")[0]);
    const result = runGate(repo, base, emptyLcov());
    assert.match(result.stdout, new RegExp(`line denominator ${additions}(?:;|$)`));
  });

  await t.test("duplicate SF takes the highest line and branch hit counts in either order (RG22)", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const duplicate = 2;\n");
    commit(repo);
    const blocks = [
      "SF:extension/sample.ts\nDA:2,1\nBRDA:2,0,0,1\nBRDA:2,0,1,0\nend_of_record",
      "SF:extension/sample.ts\nDA:2,0\nBRDA:2,0,0,0\nBRDA:2,0,1,1\nend_of_record",
    ];
    const result = runGate(repo, base, `TN:\n${blocks.join("\n")}\n`, ["--threshold-lines", "100"]);
    assert.match(result.stdout, /lines 1\/1=100\.00% \| branches 2\/2=100\.00%/);
  });

  await t.test("BRDA identity includes both line and block (RG22)", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const second = 2;\nexport const third = 3;\n");
    commit(repo);
    const lcov = [
      "TN:", "SF:extension/sample.ts", "DA:2,1", "DA:3,1",
      "BRDA:2,0,0,1", "BRDA:3,0,0,0",
      "BRDA:2,1,1,1", "BRDA:2,2,1,0",
      "end_of_record", "",
    ].join("\n");
    const result = runGate(repo, base, lcov);
    assert.match(result.stdout, /branches 2\/4=50\.00%/);
  });

  await t.test("duplicate BRDA identities cannot dilute uncovered branches (WH40)", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const duplicate = 2;\n");
    commit(repo);
    const identity = (index: number, hits: number) => `BRDA:2,0,${index},${hits}`;
    const truth = Array.from({ length: 40 }, (_, index) => identity(index, index < 20 ? 1 : 0));
    const duplicateCovered = Array.from({ length: 20 }, (_, index) => identity(index, 1));
    const records = [truth, ...Array.from({ length: 6 }, () => duplicateCovered)]
      .map((branches) => `SF:extension/sample.ts\nDA:2,1\n${branches.join("\n")}\nend_of_record`);
    const result = runGate(repo, base, `TN:\n${records.join("\n")}\n`);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /branches 20\/40=50\.00%/);
  });

  for (const [name, lcov] of [
    ["malformed", "TN:\nSF:extension/sample.ts\nDA:not-a-line,nope\nBRDA:oops,0,0,nope\nend_of_record\n"],
    ["truncated", "TN:\nSF:extension/sample.ts\n"],
    ["foreign", "TN:\nSF:/tmp/foreign/extension/sample.ts\nDA:2,99\nend_of_record\n"],
  ] as const) {
    await t.test(name, (t) => {
      const { repo, base } = fixture(t);
      write(repo, "extension/sample.ts", "export const before = 1;\nexport const uncovered = 2;\n");
      commit(repo);
      const result = runGate(repo, base, lcov);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /lines 0\/1=0\.00%/);
      if (name !== "foreign") assert.match(result.stdout, /NO USABLE LCOV; fail-closed synthetic branch/);
    });
  }
});

test("branch minimum-denominator boundary is 19 WARN, 20 enforced, 21 enforced", (t) => {
  function branchCase(count: number, hits: number) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const branchy = 2;\n");
    commit(repo, `branches-${count}`);
    const branches = Array.from({ length: count }, (_, index) => `2,0,${index},${index < hits ? 1 : 0}`);
    return runGate(repo, base, sourceLcov(["2,1"], branches));
  }
  const nineteen = branchCase(19, 0);
  assert.equal(nineteen.status, 0);
  assert.match(nineteen.stdout, /only 19 changed branches \(<20\)/);
  const twenty = branchCase(20, 0);
  assert.equal(twenty.status, 1);
  assert.match(twenty.stdout, /branch patch coverage 0\.00% is below/);
  const twentyOne = branchCase(21, 18);
  assert.equal(twentyOne.status, 0);
  assert.match(twentyOne.stdout, /branches 18\/21=85\.71%/);
});
