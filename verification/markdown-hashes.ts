import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const HASH_FILE = "verification/markdown-hashes.txt";
const HASH = /^[a-f0-9]{64}$/;
export const isReleaseNotes = (path: string): boolean =>
  /^release\/requests\/[^/]+\/notes\.md$/.test(path);
const isMarkdown = (path: string): boolean => /\.md$/i.test(path);
const validPath = (path: string): boolean =>
  isMarkdown(path) && !/[\r\n\0\\]/.test(path) && !path.startsWith("/") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export function digest(bytes: Buffer): string {
  // Latin-1 preserves every byte, including invalid UTF-8 and lone CR bytes.
  const normalized = Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha256").update(normalized).digest("hex");
}

export function renderHashes(entries: ReadonlyMap<string, string>): string {
  return [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, hash]) => `${hash}  ${path}`).join("\n\n") + "\n";
}

export function parseHashes(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (line === "") continue;
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !validPath(match[2]!) || isReleaseNotes(match[2]!)) {
      throw new Error(`Malformed or forbidden entry in ${HASH_FILE}: ${line}`);
    }
    const hash = match[1]!;
    const path = match[2]!;
    if (entries.has(path)) throw new Error(`Duplicate path in ${HASH_FILE}: ${path}`);
    entries.set(path, hash);
  }
  if (entries.size === 0) throw new Error(`Empty ${HASH_FILE}`);
  if (renderHashes(entries) !== text.replace(/\r\n/g, "\n")) {
    throw new Error(`${HASH_FILE} must be sorted by path with one blank line between entries and a final newline`);
  }
  return entries;
}

export function listMarkdown(root: string): string[] {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
  if (resolve(root) !== resolve(top)) throw new Error("Run the Markdown hash tools from the repository root");
  const paths = execFileSync("git", ["ls-files", "--cached", "--full-name", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .split("\0").filter(isMarkdown);
  if (paths.length === 0) throw new Error("Git index contains no Markdown documents");
  if (new Set(paths).size !== paths.length) throw new Error("Git index contains duplicate or unmerged Markdown paths");
  for (const path of paths) {
    if (!validPath(path)) throw new Error(`Unsupported Markdown path: ${JSON.stringify(path)}`);
  }
  return paths;
}

export function compareHashes(
  paths: readonly string[],
  entries: ReadonlyMap<string, string>,
  read: (path: string) => Buffer,
): string[] {
  if (paths.length === 0) return ["Git index contains no Markdown documents"];
  const errors: string[] = [];
  const tracked = new Set(paths);
  for (const path of entries.keys()) {
    if (!tracked.has(path)) errors.push(`${path}: stored hash names a document absent from the Git index`);
  }
  for (const path of paths) {
    try {
      const bytes = read(path);
      const actual = digest(bytes);
      if (isReleaseNotes(path)) {
        const requestPath = path.slice(0, -"notes.md".length) + "request.json";
        const request: unknown = JSON.parse(read(requestPath).toString("utf8"));
        if (typeof request !== "object" || request === null || !("notesSha256" in request) ||
            typeof request.notesSha256 !== "string" || !HASH.test(request.notesSha256)) {
          throw new Error(`invalid notesSha256 in ${requestPath}`);
        }
        const exact = createHash("sha256").update(bytes).digest("hex");
        if (actual !== request.notesSha256 && exact !== request.notesSha256) {
          errors.push(`${path}: notesSha256 mismatch in ${requestPath}`);
        }
      } else if (!entries.has(path)) {
        errors.push(`${path}: missing stored hash`);
      } else if (entries.get(path) !== actual) {
        errors.push(`${path}: SHA-256 mismatch`);
      }
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

const quote = (text: string): string => "'" + text.replace(/'/g, "'\\''") + "'";
export function investigation(path: string): string {
  const p = quote(path);
  const update = isReleaseNotes(path)
    ? "This release note is bound to sibling request.json notesSha256. Use the reviewed release request process, not the central update command."
    : `Only after investigation and repairs, run: node verification/update-markdown-hashes.ts ${p}`;
  return `Investigate ${p} before updating any hash:
  git log --follow -p -- ${p}
  git log --merges --follow -- ${p}
Find the commits and merges that changed this document. Check each merge for logical consistency against both parents:
  git diff <merge>^1 <merge> -- ${p}
  git diff <merge>^2 <merge> -- ${p}
Fix merge errors first. ${update}`;
}

export function checkRepository(root: string): void {
  const paths = listMarkdown(root);
  let entries: Map<string, string>;
  try {
    entries = parseHashes(readFileSync(join(root, HASH_FILE), "utf8"));
  } catch (error) {
    throw new Error(`${String(error)}\n${paths.map(investigation).join("\n")}`);
  }
  const errors = compareHashes(paths, entries, (path) => readFileSync(join(root, path)));
  if (errors.length) {
    const failing = new Set([...paths, ...entries.keys()].filter((path) =>
      errors.some((error) => error.startsWith(`${path}:`))));
    throw new Error(errors.join("\n") + "\n" + [...failing].map(investigation).join("\n"));
  }
}

export function updateHashes(root: string, requested: readonly string[]): void {
  if (!requested.length) throw new Error("Name explicit document paths. There is no update-all option");
  const tracked = new Set(listMarkdown(root));
  const manifest = join(root, HASH_FILE);
  const entries = existsSync(manifest) ? parseHashes(readFileSync(manifest, "utf8")) : new Map<string, string>();
  if (new Set(requested).size !== requested.length) throw new Error("Duplicate requested paths");
  for (const path of requested) {
    if (!validPath(path) || isReleaseNotes(path)) throw new Error(`Refusing path: ${path}`);
    if (tracked.has(path)) {
      entries.set(path, digest(readFileSync(join(root, path))));
    } else if (entries.has(path) && !existsSync(join(root, path))) {
      entries.delete(path);
    } else {
      throw new Error(`Refusing untracked or non-Markdown path: ${path}`);
    }
  }
  if (!entries.size) throw new Error("Refusing to write an empty hash file");
  writeFileSync(manifest, renderHashes(entries));
}
