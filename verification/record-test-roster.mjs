import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// These patterns apply to normalized project-relative paths on every system.
export const RECORD_TEST_PATTERN = /^test\/(?:[^/]+\/)*record-[^/]*\.test\.ts$/;
export const WINDOWS_TEST_PATTERN = /^test\/(?:[^/]+\/)*record-windows-[^/]*\.test\.ts$/;
export const NATIVE_WINDOWS_TEST = "record-native-windows-refusal uses the real platform on Windows";
const recordPattern = "test/**/record-*.test.ts";
const windowsPattern = "test/**/record-windows-*.test.ts";
export function auditRecordTestRoster(files) {
  const records = [];
  const windows = [];
  const errors = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    const recordTest = /(?:^|\/)record-/.test(path) || /record-tool-test:|extension\/record-[^\s"']+/.test(file.source);
    if (!recordTest) continue;
    const isWindows = /^\s*(?:\/\/|\/\*)\s*record-tool-test:\s*windows(?:\s*\*\/)?\s*$/m.test(file.source) || /(?:^|\/)record-windows-/.test(path);
    if (!RECORD_TEST_PATTERN.test(path) || (isWindows && !WINDOWS_TEST_PATTERN.test(path))) {
      errors.push(`Record-tool test is outside its applicable pattern: ${path}. Rename it to match ${isWindows ? windowsPattern : recordPattern}.`);
    }
    if (RECORD_TEST_PATTERN.test(path)) records.push(path);
    if (WINDOWS_TEST_PATTERN.test(path)) windows.push(path);
  }
  if (!records.length) errors.push(`The record-tool test pattern matches no file. Add a test matching ${recordPattern}.`);
  if (!windows.length) errors.push(`The Windows test pattern matches no file. Add a test matching ${windowsPattern}.`);
  return { records, windows, errors };
}
export function discoverRecordTests(repo) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.ts")) files.push({ path: relative(repo, path), source: readFileSync(path, "utf8") });
    }
  }
  walk(join(repo, "test"));
  return auditRecordTestRoster(files);
}
export function auditRecordTestExecution(repo, files, events, platform = process.platform) {
  const errors = [];
  for (const file of files) {
    const absolute = resolve(repo, file);
    const summaries = events.filter((event) => event.type === "test:summary" && event.data.file === absolute);
    const outcomes = events.filter((event) => ["test:pass", "test:fail"].includes(event.type) && event.data.file === absolute);
    const executed = outcomes.filter((event) => !event.data.skip && !event.data.todo && event.data.details?.type === "test" && event.data.name !== absolute);
    if (summaries.length !== 1 || !summaries[0].data.success || !executed.length) errors.push(`${file} has no complete successful test execution. Add and run a non-skipped test.`);
    const summary = summaries[0]?.data.counts;
    const skips = outcomes.filter((event) => event.data.skip);
    if (summary?.skipped !== skips.length || summary?.todo || summary?.cancelled || summary?.failed) errors.push(`${file} has incomplete test evidence. Run every required test.`);
    for (const event of skips) {
      const allowed = platform !== "win32" && file === "test/record-windows-refusal.test.ts" && event.data.name === NATIVE_WINDOWS_TEST;
      if (!allowed) errors.push(`${file} skipped ${event.data.name}. Run this required test on the selected system.`);
    }
  }
  return errors;
}
export function runRecordTests(repo, files, platform = process.platform) {
  const reporter = fileURLToPath(new URL("./record-test-reporter.mjs", import.meta.url));
  // Each child owns an independent Node test context.
  const run = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", `--test-reporter=${reporter}`, ...files], { cwd: repo, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const events = [];
  const errors = [];
  try {
    for (const line of (run.stdout ?? "").split("\n").filter(Boolean)) events.push(JSON.parse(line));
  } catch { errors.push("The test reporter returned invalid evidence. Inspect the runner output before retrying."); }
  errors.push(...auditRecordTestExecution(repo, files, events, platform));
  if (run.status !== 0 || run.error) errors.push("The record test process failed. Inspect its output and correct the failing test.");
  return { status: errors.length ? 1 : 0, errors, events, stderr: run.stderr ?? "" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const selection = process.argv.slice(2);
  if (selection.length && (selection.length !== 2 || selection[0] !== "--run" || !["all", "windows"].includes(selection[1]))) {
    console.error("Use record-test-roster.mjs [--run all|windows].");
    process.exitCode = 2;
  } else {
    const result = discoverRecordTests(repo);
    for (const error of result.errors) console.error(error);
    if (result.errors.length) process.exitCode = 1;
    else {
      console.log(`Record test roster passed: ${result.records.length} record-tool files and ${result.windows.length} Windows files.`);
      if (selection.length) {
        const files = selection[1] === "windows" ? result.windows : result.records;
        const run = runRecordTests(repo, files);
        for (const event of run.events) {
          if (event.type === "test:fail" || event.type === "test:stderr" || event.type === "test:summary") console.log(JSON.stringify(event));
        }
        for (const error of run.errors) console.error(error);
        if (run.stderr) console.error(run.stderr);
        process.exitCode = run.status;
      }
    }
  }
}
