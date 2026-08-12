#!/usr/bin/env node
/** Measure changed production-logic lines, changed files, and the size grade. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { extname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MAX_INPUT_BYTES = 1024 * 1024;

const DOCUMENT_EXTENSIONS = new Set([".md", ".adoc", ".rst", ".txt", ".pdf"]);
const SOURCE_EXTENSIONS = new Set([
  ".java", ".kt", ".kts", ".scala", ".py", ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx", ".mts", ".cts", ".groovy", ".gql", ".graphql", ".g4",
  ".jj", ".jjt", ".sql", ".osql", ".html", ".css", ".sh", ".bat", ".cmd",
]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".xml", ".properties", ".ini", ".config", ".toml", ".hcl", ".env"]);

export const DEFAULT_DECLARATIONS = Object.freeze({
  testPaths: Object.freeze([
    "(^|/)(test|tests|testing|test-commons|docker-tests)/",
    "(^|/)(?:[^/]*[-_.])?(test|tests|spec)([-_.]|$)",
    "(^|/)[^/]*(test|tests|spec)\\.[^.]+$",
  ]),
  generatedMarkers: Object.freeze([
    "(^|/)(target|build|dist|generated|coverage|node_modules|vendor)/",
    "\\.min\\.(js|css)$",
  ]),
  lockfiles: Object.freeze(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]),
});

export const REGULAR_FILE_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

export function readDeclarations(repositoryRoot) {
  const path = join(repositoryRoot, ".pi", "size-grade.json");
  let stat;
  try { stat = fs.lstatSync(path); }
  catch (error) {
    if (error?.code === "ENOENT") return DEFAULT_DECLARATIONS;
    throw new Error(`Cannot inspect ${path}: ${error.message}`);
  }
  if (!stat.isFile()) throw new Error(`Refused ${path}: configuration must be a regular file`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`Refused ${path}: configuration exceeds the ${MAX_INPUT_BYTES}-byte limit`);

  let fd;
  let text;
  try {
    fd = fs.openSync(path, REGULAR_FILE_OPEN_FLAGS);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error("opened configuration is not a regular file");
    if (opened.size > MAX_INPUT_BYTES) throw new Error(`configuration exceeds the ${MAX_INPUT_BYTES}-byte limit`);
    const buffer = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > opened.size) throw new Error("configuration changed while it was read");
    text = buffer.subarray(0, used).toString("utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Invalid ${path}: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${path}: expected an object`);
  const allowed = new Set(["testPaths", "generatedMarkers", "lockfiles"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Invalid ${path}: unknown key ${key}`);
  const declarations = {};
  for (const key of allowed) {
    const list = Object.hasOwn(value, key) ? value[key] : DEFAULT_DECLARATIONS[key];
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error(`Invalid ${path}: ${key} must be an array of non-empty strings`);
    }
    declarations[key] = Object.freeze([...list]);
  }
  return Object.freeze(declarations);
}

export function compileDeclarations(declarations) {
  try {
    return {
      testPaths: declarations.testPaths.map((pattern) => new RegExp(pattern, "i")),
      generatedMarkers: declarations.generatedMarkers.map((pattern) => new RegExp(pattern, "i")),
      lockfiles: new Set(declarations.lockfiles.map((name) => name.toLowerCase())),
    };
  } catch (error) {
    throw new Error(`Invalid .pi/size-grade.json pattern: ${error.message}`);
  }
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: null,
    maxBuffer: MAX_INPUT_BYTES + 1,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (result.error.code === "ENOBUFS") throw new Error(`Git output exceeds the ${MAX_INPUT_BYTES}-byte limit`);
    throw new Error(`Cannot run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (result.signal) throw new Error(`Git terminated by signal ${result.signal}`);
    const detail = Buffer.from(result.stderr ?? "").toString("utf8").trim();
    throw new Error(detail || `git exited ${result.status}`);
  }
  const output = Buffer.from(result.stdout ?? "");
  if (output.length > MAX_INPUT_BYTES) throw new Error(`Git output exceeds the ${MAX_INPUT_BYTES}-byte limit`);
  return output;
}

function parseCount(value) {
  return value === "-" ? 0 : Number.parseInt(value, 10);
}

export function parseNumstat(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files = [];
  for (let index = 0; index < fields.length; index++) {
    const header = fields[index];
    const first = header.indexOf("\t");
    const second = header.indexOf("\t", first + 1);
    if (first < 1 || second < 0) throw new Error("Git returned malformed numstat output");
    const addedText = header.slice(0, first);
    const deletedText = header.slice(first + 1, second);
    const path = header.slice(second + 1);
    if (path === "" || !/^(?:-|\d+)$/.test(addedText) || !/^(?:-|\d+)$/.test(deletedText)) {
      throw new Error("Git returned malformed no-renames numstat output");
    }
    files.push({
      path,
      added: parseCount(addedText),
      deleted: parseCount(deletedText),
      binary: addedText === "-" || deletedText === "-",
    });
  }
  return files;
}

export function classifyPath(path, declarations) {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const parts = lower.split("/");
  const name = parts.at(-1) ?? "";
  const directories = parts.slice(0, -1);
  if (declarations.generatedMarkers.some((pattern) => pattern.test(lower))) return { kind: "generated", reason: "generated file" };
  if (declarations.lockfiles.has(name)) return { kind: "generated", reason: "lockfile" };
  if (declarations.testPaths.some((pattern) => pattern.test(lower))) return { kind: "test", reason: "test file" };
  if (directories.some((part) => ["doc", "docs", "documentation", "docs-internal", "issues", "research"].includes(part))
      || DOCUMENT_EXTENSIONS.has(extname(name)) || ["readme", "license", "notice"].includes(name)) {
    return { kind: "documentation", reason: "documentation" };
  }
  if (lower.startsWith(".github/workflows/")
      || directories.some((part) => [".mvn", "gradle", "gradle-wrapper", "buildsrc", "ci"].includes(part))
      || ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew", "gradlew.bat", "mvnw", "mvnw.cmd", "makefile", "dockerfile"].includes(name)) {
    return { kind: "build", reason: "build file" };
  }
  if (CONFIG_EXTENSIONS.has(extname(name)) || name.startsWith(".")
      || directories.some((part) => ["config", "configuration", "project-config", ".pi", ".claude"].includes(part))) {
    return { kind: "configuration", reason: "configuration" };
  }
  if (SOURCE_EXTENSIONS.has(extname(name)) || directories.includes("src")) return { kind: "source", reason: "production logic" };
  return { kind: "other", reason: "other file kind" };
}

export function gradeFor(lines, fileCount) {
  let grade = lines <= 50 ? 0 : lines <= 1000 ? 1 : 2;
  if (fileCount > 25) grade = Math.min(2, grade + 1);
  return ["SMALL", "MEDIUM", "LARGE"][grade];
}

export function measure(base, head) {
  const repositoryRoot = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  if (repositoryRoot === "") throw new Error("Git returned an empty repository root");
  const declarations = compileDeclarations(readDeclarations(repositoryRoot));
  // Match the 918-PR corpus command exactly. In particular, --no-renames makes
  // a rename appear as one deletion and one addition rather than one rename.
  // --end-of-options keeps untrusted refs from becoming git-diff options.
  const raw = git(["diff", "--no-renames", "--numstat", "-z", "--end-of-options", base, head, "--"]);
  const changed = parseNumstat(raw);
  let changedProductionLogicLines = 0;
  const files = changed.map((file) => {
    const classification = classifyPath(file.path, declarations);
    const changedLines = file.added + file.deleted;
    if (classification.kind === "source") changedProductionLogicLines += changedLines;
    return {
      path: file.path,
      added: file.added,
      deleted: file.deleted,
      changedLines,
      binary: file.binary,
      kind: classification.kind,
      excluded: classification.kind !== "source",
      reason: classification.reason,
    };
  });
  return {
    base,
    head,
    changedProductionLogicLines,
    changedFiles: files.length,
    sizeGrade: gradeFor(changedProductionLogicLines, files.length),
    files,
  };
}

function reportPath(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]+/gu, " ").replace(/\s+/g, " ").trim() || "(unnamed)";
}

export function formatText(result) {
  const lines = [
    `Size grade: ${result.sizeGrade}`,
    `Changed production-logic lines: ${result.changedProductionLogicLines}`,
    `Changed files: ${result.changedFiles}`,
  ];
  for (const file of result.files) {
    lines.push(`${file.excluded ? "EXCLUDED" : "INCLUDED"} ${reportPath(file.path)} — ${file.reason}; ${file.changedLines} changed lines`);
  }
  return lines.join("\n");
}

function usage() {
  return `Usage: node size-grade.mjs --base <ref> --head <ref> [--format json|text]\n\n.pi/size-grade.json may override testPaths and generatedMarkers with regular-expression arrays, and lockfiles with a filename array. Git diff output and configuration are each capped at ${MAX_INPUT_BYTES} bytes.`;
}

function cli() {
  const args = process.argv.slice(2);
  let base = null;
  let head = null;
  let format = "json";
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--base" && args[index + 1]) base = args[++index];
    else if (args[index] === "--head" && args[index + 1]) head = args[++index];
    else if (args[index] === "--format") {
      const value = args[++index];
      if (!/^(?:json|text)$/.test(value ?? "")) throw new Error("--format requires json or text");
      format = value;
    } else if (args[index] === "--help") { console.log(usage()); return; }
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  if (base === null || head === null) throw new Error("Both --base and --head are required");
  const result = measure(base, head);
  process.stdout.write(format === "json" ? `${JSON.stringify(result, null, 2)}\n` : `${formatText(result)}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try { cli(); }
  catch (error) { console.error(`size-grade: ${error.message}`); process.exitCode = 1; }
}
