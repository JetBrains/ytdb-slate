import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// These patterns apply to normalized project-relative paths on every system.
export const RECORD_TEST_PATTERN = /^test\/(?:[^/]+\/)*record-[^/]+\.test\.ts$/;
export const WINDOWS_TEST_PATTERN = /^test\/(?:[^/]+\/)*record-windows-[^/]+\.test\.ts$/;
export function auditRecordTestRoster(files) {
  const records = [];
  const windows = [];
  const errors = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    const recordTest = /(?:^|\/)record-/.test(path) || /record-tool-test:|extension\/record-[^\s"']+/.test(file.source);
    if (!recordTest) continue;
    const isWindows = /^\/\/ record-tool-test: windows\s*$/m.test(file.source) || /(?:^|\/)record-windows-/.test(path);
    if (!RECORD_TEST_PATTERN.test(path) || (isWindows && !WINDOWS_TEST_PATTERN.test(path))) errors.push(`Record-tool test is outside its applicable pattern: ${path}`);
    if (RECORD_TEST_PATTERN.test(path)) records.push(path);
    if (WINDOWS_TEST_PATTERN.test(path)) windows.push(path);
  }
  if (!records.length) errors.push("The record-tool test pattern matches no file.");
  if (!windows.length) errors.push("The Windows test pattern matches no file.");
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
        const run = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", ...files], { cwd: repo, stdio: "inherit" });
        process.exitCode = run.status ?? 1;
      }
    }
  }
}
