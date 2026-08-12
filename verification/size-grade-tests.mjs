#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_SCRIPT = fileURLToPath(new URL("../extension/size-grade.mjs", import.meta.url));
const SCRIPT = process.env.SIZE_GRADE_SCRIPT || DEFAULT_SCRIPT;
const {
  MAX_INPUT_BYTES,
  classifyPath,
  compileDeclarations,
  gradeFor,
  parseNumstat,
  readDeclarations,
} = await import(pathToFileURL(SCRIPT).href);
let passed = 0;
let failed = 0;
const reported = [];

function test(name, fn) {
  const number = reported.length + 1;
  reported.push(name);
  try {
    fn();
    passed++;
    console.log(`ok ${number} - ${name}`);
  } catch (error) {
    failed++;
    console.log(`not ok ${number} - ${name}`);
    console.log(`  ---\n  error: ${JSON.stringify(error?.stack ?? String(error))}\n  ...`);
  }
}

function lab() {
  const root = fs.mkdtempSync(join(os.tmpdir(), "slate-size-grade-test."));
  const bin = join(root, "bin");
  const nested = join(root, "nested");
  fs.mkdirSync(bin);
  fs.mkdirSync(nested);
  const git = join(bin, "git");
  fs.writeFileSync(git, `#!/usr/bin/env node
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (process.env.FAKE_ARGS) fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify(args) + "\\n");
    if (args[0] === "rev-parse") {
      if (process.env.FAKE_MODE === "root-error") { console.error("not a repository"); process.exit(7); }
      process.stdout.write(process.env.FAKE_ROOT + "\\n");
    } else if (process.env.FAKE_MODE === "signal") {
      process.kill(process.pid, "SIGTERM");
    } else if (process.env.FAKE_MODE === "bad-ref") {
      console.error("fatal: bad revision"); process.exit(9);
    } else if (process.env.FAKE_MODE === "oversize") {
      process.stdout.write("1\\t0\\ta.mjs\\0".repeat(200000));
    } else {
      process.stdout.write(fs.readFileSync(process.env.FAKE_NUMSTAT));
    }
  `, { mode: 0o755 });
  const numstat = join(root, "numstat");
  const args = join(root, "args.jsonl");
  fs.writeFileSync(numstat, "");
  return { root, bin, nested, numstat, args };
}

function runCli(paths, records = "", extra = [], env = {}) {
  fs.writeFileSync(paths.numstat, records);
  return spawnSync(process.execPath, [SCRIPT, "--base", "base", "--head", "head", ...extra], {
    cwd: paths.nested,
    encoding: "utf8",
    maxBuffer: 32 * MAX_INPUT_BYTES,
    env: {
      ...process.env,
      PATH: `${paths.bin}:${process.env.PATH ?? ""}`,
      FAKE_ROOT: paths.root,
      FAKE_NUMSTAT: paths.numstat,
      FAKE_ARGS: paths.args,
      ...env,
    },
  });
}

function jsonResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function records(count, added = 1, extension = ".mjs") {
  return Array.from({ length: count }, (_, index) => `${added}\t0\tf${index}${extension}\0`).join("");
}

function withLab(fn) {
  const paths = lab();
  try { fn(paths); }
  finally { fs.rmSync(paths.root, { recursive: true, force: true }); }
}

test("line boundaries are SMALL at 50, MEDIUM at 51 and 1000, and LARGE at 1001", () => {
  assert.equal(gradeFor(50, 1), "SMALL");
  assert.equal(gradeFor(51, 1), "MEDIUM");
  assert.equal(gradeFor(1000, 1), "MEDIUM");
  assert.equal(gradeFor(1001, 1), "LARGE");
});

test("file boundary raises at 26 but not 25 and never raises past LARGE", () => {
  assert.equal(gradeFor(25, 25), "SMALL");
  assert.equal(gradeFor(25, 26), "MEDIUM");
  assert.equal(gradeFor(1001, 26), "LARGE");
});

test("CLI measures every grade boundary and an empty diff", () => withLab((paths) => {
  for (const [changed, expected] of [[0, "SMALL"], [50, "SMALL"], [51, "MEDIUM"], [1000, "MEDIUM"], [1001, "LARGE"]]) {
    const record = changed === 0 ? "" : `${changed}\t0\tchange.mjs\0`;
    const output = jsonResult(runCli(paths, record));
    assert.equal(output.changedProductionLogicLines, changed);
    assert.equal(output.sizeGrade, expected);
  }
}));

test("CLI raises a 26-file change and keeps a 25-file change SMALL", () => withLab((paths) => {
  assert.equal(jsonResult(runCli(paths, records(25))).sizeGrade, "SMALL");
  assert.equal(jsonResult(runCli(paths, records(26))).sizeGrade, "MEDIUM");
}));

test("Node module source extensions include mjs cjs mts and cts", () => {
  const declarations = compileDeclarations({ testPaths: [], generatedMarkers: [], lockfiles: [] });
  for (const extension of [".mjs", ".cjs", ".mts", ".cts"]) {
    assert.equal(classifyPath(`extension/file${extension}`, declarations).kind, "source", extension);
  }
});

test("configuration resolves from the repository root during a nested invocation", () => withLab((paths) => {
  fs.mkdirSync(join(paths.root, ".pi"));
  fs.writeFileSync(join(paths.root, ".pi", "size-grade.json"), JSON.stringify({ generatedMarkers: ["(^|/)gen/"] }));
  const output = jsonResult(runCli(paths, "4\t0\tgen/x.mjs\0" + "1\t0\tlib/x.mjs\0"));
  assert.equal(output.changedProductionLogicLines, 1);
  assert.equal(output.files.find((file) => file.path === "gen/x.mjs").reason, "generated file");
}));

test("present null declarations are rejected instead of defaulted", () => withLab((paths) => {
  fs.mkdirSync(join(paths.root, ".pi"));
  fs.writeFileSync(join(paths.root, ".pi", "size-grade.json"), '{"testPaths":null}');
  assert.throws(() => readDeclarations(paths.root), /testPaths must be an array/);
}));

test("declaration helpers reject unknown keys, wrong values, and broken patterns", () => withLab((paths) => {
  fs.mkdirSync(join(paths.root, ".pi"));
  const config = join(paths.root, ".pi", "size-grade.json");
  fs.writeFileSync(config, '{"unknown":[]}');
  assert.throws(() => readDeclarations(paths.root), /unknown key unknown/);
  fs.writeFileSync(config, '{"lockfiles":"x"}');
  assert.throws(() => readDeclarations(paths.root), /lockfiles must be an array/);
  fs.writeFileSync(config, '{"testPaths":["["]}');
  assert.throws(() => compileDeclarations(readDeclarations(paths.root)), /Invalid \.pi\/size-grade\.json pattern/);
}));

test("configuration rejects malformed, oversized, and non-regular inputs", () => withLab((paths) => {
  fs.mkdirSync(join(paths.root, ".pi"));
  const config = join(paths.root, ".pi", "size-grade.json");
  fs.writeFileSync(config, "{");
  assert.throws(() => readDeclarations(paths.root), /Invalid .*size-grade\.json/);
  fs.writeFileSync(config, "x".repeat(MAX_INPUT_BYTES + 1));
  assert.throws(() => readDeclarations(paths.root), /configuration exceeds/);
  fs.rmSync(config);
  fs.mkdirSync(config);
  assert.throws(() => readDeclarations(paths.root), /must be a regular file/);
  fs.rmSync(config, { recursive: true });
  const fifo = spawnSync("mkfifo", [config], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  assert.throws(() => readDeclarations(paths.root), /must be a regular file/);
}));

test("numstat parser rejects malformed records", () => {
  assert.throws(() => parseNumstat(Buffer.from("1\tbroken\0")), /malformed numstat output/);
  assert.throws(() => parseNumstat(Buffer.from("x\t0\ta.mjs\0")), /malformed no-renames numstat output/);
  assert.throws(() => parseNumstat(Buffer.from("1\t0\t\0")), /malformed no-renames numstat output/);
});

test("configuration open refuses a symlink swapped in after inspection", () => withLab((paths) => {
  fs.mkdirSync(join(paths.root, ".pi"));
  const target = join(paths.root, "target.json");
  const config = join(paths.root, ".pi", "size-grade.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, config);
  const original = fs.lstatSync;
  fs.lstatSync = (path, options) => String(path) === config ? fs.statSync(target) : original(path, options);
  try { assert.throws(() => readDeclarations(paths.root), /Cannot read/); }
  finally { fs.lstatSync = original; }
}));

test("configuration open does not block when a FIFO replaces an inspected file", () => withLab((paths) => {
  fs.mkdirSync(join(paths.root, ".pi"));
  const target = join(paths.root, "target.json");
  const config = join(paths.root, ".pi", "size-grade.json");
  fs.writeFileSync(target, "{}");
  const fifo = spawnSync("mkfifo", [config], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  const helper = join(paths.root, "fifo-check.mjs");
  fs.writeFileSync(helper, `
    import fs from "node:fs";
    const module = await import(process.argv[2]);
    const root = process.argv[3];
    const config = root + "/.pi/size-grade.json";
    const target = root + "/target.json";
    const original = fs.lstatSync;
    fs.lstatSync = (path, options) => String(path) === config ? fs.statSync(target) : original(path, options);
    try { module.readDeclarations(root); process.exit(2); }
    catch { process.exit(0); }
  `);
  const result = spawnSync(process.execPath, [helper, pathToFileURL(SCRIPT).href, paths.root], {
    encoding: "utf8",
    timeout: 2000,
  });
  assert.equal(result.status, 0, JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }));
}));

test("configuration permission failures report a read failure rather than invalid JSON", () => withLab((paths) => {
  fs.mkdirSync(join(paths.root, ".pi"));
  fs.writeFileSync(join(paths.root, ".pi", "size-grade.json"), "{}");
  const original = fs.openSync;
  fs.openSync = () => { const error = new Error("permission denied"); error.code = "EACCES"; throw error; };
  try { assert.throws(() => readDeclarations(paths.root), /Cannot read .*permission denied/); }
  finally { fs.openSync = original; }
}));

test("bad format reports the accepted values", () => withLab((paths) => {
  const result = runCli(paths, "", ["--format", "xml"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--format requires json or text/);
}));

test("bad refs and a signal-killed git process report their real causes", () => withLab((paths) => {
  const outside = runCli(paths, "", [], { FAKE_MODE: "root-error" });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /not a repository/);
  const bad = runCli(paths, "", [], { FAKE_MODE: "bad-ref" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /fatal: bad revision/);
  const signal = runCli(paths, "", [], { FAKE_MODE: "signal" });
  assert.equal(signal.status, 1);
  assert.match(signal.stderr, /Git terminated by signal SIGTERM/);
}));

test("missing git and oversized git output fail with bounded diagnostics", () => withLab((paths) => {
  const missing = spawnSync(process.execPath, [SCRIPT, "--base", "base", "--head", "head"], {
    cwd: paths.root, encoding: "utf8", env: { ...process.env, PATH: join(paths.root, "empty") },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot run git/);
  const oversized = runCli(paths, "", [], { FAKE_MODE: "oversize" });
  assert.equal(oversized.status, 1, JSON.stringify({ status: oversized.status, signal: oversized.signal, error: oversized.error?.message, stderr: oversized.stderr }));
  assert.match(oversized.stderr, new RegExp(`Git output exceeds the ${MAX_INPUT_BYTES}-byte limit`));
}));

test("refs beginning with two dashes follow end-of-options and cannot become git options", () => withLab((paths) => {
  const result = spawnSync(process.execPath, [SCRIPT, "--base", "--output=/tmp/precious", "--head", "head"], {
    cwd: paths.nested,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${paths.bin}:${process.env.PATH ?? ""}`,
      FAKE_ROOT: paths.root,
      FAKE_NUMSTAT: paths.numstat,
      FAKE_ARGS: paths.args,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(paths.args, "utf8").trim().split("\n").map(JSON.parse);
  const diff = calls.find((args) => args[0] === "diff");
  const end = diff.indexOf("--end-of-options");
  assert.ok(end >= 0);
  assert.equal(diff[end + 1], "--output=/tmp/precious");
}));

const EXPECTED = [
  "line boundaries are SMALL at 50, MEDIUM at 51 and 1000, and LARGE at 1001",
  "file boundary raises at 26 but not 25 and never raises past LARGE",
  "CLI measures every grade boundary and an empty diff",
  "CLI raises a 26-file change and keeps a 25-file change SMALL",
  "Node module source extensions include mjs cjs mts and cts",
  "configuration resolves from the repository root during a nested invocation",
  "present null declarations are rejected instead of defaulted",
  "declaration helpers reject unknown keys, wrong values, and broken patterns",
  "configuration rejects malformed, oversized, and non-regular inputs",
  "numstat parser rejects malformed records",
  "configuration open refuses a symlink swapped in after inspection",
  "configuration open does not block when a FIFO replaces an inspected file",
  "configuration permission failures report a read failure rather than invalid JSON",
  "bad format reports the accepted values",
  "bad refs and a signal-killed git process report their real causes",
  "missing git and oversized git output fail with bounded diagnostics",
  "refs beginning with two dashes follow end-of-options and cannot become git options",
];

const seen = new Set(reported);
const missing = EXPECTED.filter((name) => !seen.has(name));
const duplicated = reported.filter((name, index) => reported.indexOf(name) !== index);
const expectedDuplicated = EXPECTED.filter((name, index) => EXPECTED.indexOf(name) !== index);
const unexpected = [...seen].filter((name) => !EXPECTED.includes(name));
const counted = passed + failed;
const rosterOk = missing.length === 0 && duplicated.length === 0 && expectedDuplicated.length === 0
  && unexpected.length === 0 && counted === reported.length;
const rosterNumber = reported.length + 1;
if (rosterOk) {
  passed++;
  console.log(`ok ${rosterNumber} - roster - all expected tests reported exactly once and the counters agree`);
} else {
  failed++;
  console.log(`not ok ${rosterNumber} - roster - every expected test must report exactly once and the counters must agree`);
  console.log(`  ---\n  observed: ${JSON.stringify({ missing, duplicated, expectedDuplicated, unexpected, counted, reported: reported.length })}\n  ...`);
}

const resultLines = passed + failed;
const unaccounted = resultLines - (EXPECTED.length + 1);
console.log(`1..${resultLines}`);
console.log(
  `# summary: ${passed} pass, ${failed} fail `
  + `(${resultLines} result lines = ${EXPECTED.length} expected tests + this roster audit`
  + `${unaccounted === 0 ? "" : `, ${unaccounted > 0 ? "+" : "−"}${Math.abs(unaccounted)} unaccounted - see the roster line`})`,
);
process.exitCode = failed > 0 ? 1 : 0;
