import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  HASH_FILE, checkRepository, compareHashes, digest, investigation, listMarkdown,
  parseHashes, renderHashes, updateHashes,
} from "../verification/markdown-hashes.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = join(repo, "verification/update-markdown-hashes.ts");
const rawHash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "slate-markdown-hashes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "verification"));
  put(root, "a.md", "Alpha\n");
  put(root, "b.md", "Beta\n");
  stage(root, "a.md", "b.md");
  updateHashes(root, ["a.md", "b.md"]);
  return root;
}
function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function stage(root: string, ...paths: string[]): void {
  execFileSync("git", ["add", "--", ...paths], { cwd: root });
}
function cli(root: string, paths: string[]) {
  return spawnSync(process.execPath, [command, ...paths], { cwd: root, encoding: "utf8", timeout: 10_000 });
}
function notes(root: string, request: string | undefined): void {
  const path = "release/requests/1.0.0/notes.md";
  put(root, path, "Notes\n");
  stage(root, path);
  if (request !== undefined) put(root, "release/requests/1.0.0/request.json", request);
}

test("Markdown hashes: real repository", () => checkRepository(repo));

test("Markdown hashes: current bytes, not staged bytes, are checked", (t) => {
  const root = fixture(t);
  checkRepository(root);
  put(root, "a.md", "alpha\n");
  assert.throws(() => checkRepository(root), /a\.md: SHA-256 mismatch/);
});

test("Markdown hashes: new indexed document requires an entry, untracked files do not", (t) => {
  const root = fixture(t);
  put(root, "new.md", "New\n");
  checkRepository(root);
  stage(root, "new.md");
  assert.throws(() => checkRepository(root), /new\.md: missing stored hash/);
  updateHashes(root, ["new.md"]);
  checkRepository(root);
});

test("Markdown hashes: deleted document leaves a stale entry until explicitly removed", (t) => {
  const root = fixture(t);
  execFileSync("git", ["rm", "-f", "-q", "--", "a.md"], { cwd: root });
  assert.throws(() => checkRepository(root), /a\.md: stored hash names a document absent/);
  const result = cli(root, ["a.md"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseHashes(readFileSync(join(root, HASH_FILE), "utf8")).has("a.md"), false);
  checkRepository(root);
});

test("Markdown hashes: indexed document missing on disk fails", (t) => {
  const root = fixture(t);
  rmSync(join(root, "a.md"));
  assert.throws(() => checkRepository(root), /a\.md:.*ENOENT/);
});

test("Markdown hashes: CRLF and LF are equivalent but lone CR and arbitrary bytes are preserved", (t) => {
  const root = fixture(t);
  put(root, "a.md", "Alpha\r\n");
  checkRepository(root);
  assert.equal(digest(Buffer.from("a\r\nb\r\n")), rawHash("a\nb\n"));
  assert.notEqual(digest(Buffer.from("a\rb")), rawHash("a\nb"));
  const bytes = Buffer.from([255, 13, 10, 128, 13]);
  assert.equal(digest(bytes), createHash("sha256").update(Buffer.from([255, 10, 128, 13])).digest("hex"));
});

const h = rawHash("x");
const entry = (path: string) => `${h}  ${path}`;
for (const [name, text, message] of [
  ["malformed digest", "not-a-hash  a.md\n", /Malformed/],
  ["duplicate path", entry("a.md") + "\n\n" + entry("a.md") + "\n", /Duplicate.*a\.md/],
  ["unsorted entries", entry("b.md") + "\n\n" + entry("a.md") + "\n", /sorted/],
  ["missing blank separator", entry("a.md") + "\n" + entry("b.md") + "\n", /blank line/],
  ["extra blank separator", entry("a.md") + "\n\n\n" + entry("b.md") + "\n", /blank line/],
  ["empty manifest", "", /Empty/],
  ["release note entry", entry("release/requests/1.0.0/notes.md") + "\n", /forbidden/],
  ["escaping path", entry("../a.md") + "\n", /forbidden/],
  ["non-Markdown entry", entry("a.txt") + "\n", /forbidden/],
] as const) {
  test(`Markdown hashes: reject ${name}`, (t) => {
    assert.throws(() => parseHashes(text), message);
    const root = fixture(t);
    put(root, HASH_FILE, text);
    assert.throws(() => checkRepository(root), message);
  });
}

test("Markdown hashes: notes accept the exact-byte digest of CRLF notes", (t) => {
  const root = fixture(t);
  notes(root, JSON.stringify({ notesSha256: rawHash("Notes\r\n") }));
  put(root, "release/requests/1.0.0/notes.md", "Notes\r\n");
  checkRepository(root);
});

test("Markdown hashes: notes accept an LF digest with a CRLF working copy", (t) => {
  const root = fixture(t);
  notes(root, JSON.stringify({ notesSha256: rawHash("Notes\n") }));
  checkRepository(root);
  put(root, "release/requests/1.0.0/notes.md", "Notes\r\n");
  checkRepository(root);
});

test("Markdown hashes: notes reject a digest matching neither exact nor converted bytes", (t) => {
  const root = fixture(t);
  notes(root, JSON.stringify({ notesSha256: rawHash("Notes\n") }));
  put(root, "release/requests/1.0.0/notes.md", "Wrong\r\n");
  assert.throws(() => checkRepository(root), /release\/requests\/1.0.0\/notes\.md: notesSha256 mismatch/);
});

for (const [name, request, expected] of [
  ["missing", undefined, /notes\.md:.*ENOENT/],
  ["invalid JSON", "{", /notes\.md:/],
  ["null", "null", /invalid notesSha256/],
  ["missing digest", "{}", /invalid notesSha256/],
  ["invalid digest", '{"notesSha256":"bad"}', /invalid notesSha256/],
] as const) {
  test(`Markdown hashes: notes reject ${name} request.json`, (t) => {
    const root = fixture(t);
    notes(root, request);
    assert.throws(() => checkRepository(root), expected);
  });
}

test("Markdown hashes: missing hash file fails", (t) => {
  const root = fixture(t);
  rmSync(join(root, HASH_FILE));
  assert.throws(() => checkRepository(root), /ENOENT/);
});

test("Markdown hashes: empty Git Markdown listing fails closed", (t) => {
  const root = fixture(t);
  execFileSync("git", ["rm", "-f", "-q", "--", "a.md", "b.md"], { cwd: root });
  assert.throws(() => listMarkdown(root), /no Markdown documents/);
  assert.throws(() => checkRepository(root), /no Markdown documents/);
  assert.deepEqual(compareHashes([], new Map(), () => Buffer.alloc(0)), ["Git index contains no Markdown documents"]);
});

for (const paths of [[], ["--all"], ["untracked.md"], ["file.txt"], ["../a.md"],
  ["a.md", "a.md"], ["release/requests/1.0.0/notes.md"], ["a.md", "untracked.md"]]) {
  test(`Markdown hashes: update command refuses ${JSON.stringify(paths)} without a write`, (t) => {
    const root = fixture(t);
    put(root, "untracked.md", "Untracked\n");
    put(root, "file.txt", "Text\n");
    stage(root, "file.txt");
    notes(root, JSON.stringify({ notesSha256: rawHash("Notes\n") }));
    const before = readFileSync(join(root, HASH_FILE));
    const result = cli(root, paths);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /explicit document paths|Refusing|Duplicate/);
    assert.deepEqual(readFileSync(join(root, HASH_FILE)), before);
  });
}

test("Markdown hashes: update command creates and sorts explicit entries only", (t) => {
  const root = fixture(t);
  rmSync(join(root, HASH_FILE));
  const result = cli(root, ["b.md", "a.md"]);
  assert.equal(result.status, 0, result.stderr);
  const entries = parseHashes(readFileSync(join(root, HASH_FILE), "utf8"));
  assert.deepEqual([...entries.keys()], ["a.md", "b.md"]);
  assert.equal(readFileSync(join(root, HASH_FILE), "utf8"), renderHashes(entries));
  checkRepository(root);
  put(root, "a.md", "Changed\n");
  assert.equal(cli(root, ["a.md"]).status, 0);
  checkRepository(root);
});

test("Markdown hashes: updating one document preserves an unrequested changed document hash", (t) => {
  const root = fixture(t);
  const before = parseHashes(readFileSync(join(root, HASH_FILE), "utf8")).get("b.md");
  put(root, "a.md", "Reviewed change\n");
  put(root, "b.md", "Unreviewed change\n");
  const result = cli(root, ["a.md"]);
  assert.equal(result.status, 0, result.stderr);
  const after = parseHashes(readFileSync(join(root, HASH_FILE), "utf8"));
  assert.equal(after.get("a.md"), rawHash("Reviewed change\n"));
  assert.equal(after.get("b.md"), before);
  assert.throws(() => checkRepository(root), /b\.md: SHA-256 mismatch/);
});

test("Markdown hashes: update refuses to remove an existing but untracked document", (t) => {
  const root = fixture(t);
  execFileSync("git", ["rm", "--cached", "-q", "--", "a.md"], { cwd: root });
  assert.ok(existsSync(join(root, "a.md")));
  assert.throws(() => updateHashes(root, ["a.md"]), /Refusing untracked/);
});

test("Markdown hashes: failure gives the full investigation procedure for each document", (t) => {
  const root = fixture(t);
  put(root, "a.md", "Changed\n");
  put(root, "b.md", "Changed too\n");
  assert.throws(() => checkRepository(root), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const path of ["a.md", "b.md"]) {
      assert.ok(error.message.includes(investigation(path)));
      for (const command of ["git log --follow -p --", "git log --merges --follow --",
        "git diff <merge>^1 <merge> --", "git diff <merge>^2 <merge> --",
        "node verification/update-markdown-hashes.ts"]) {
        assert.ok(error.message.includes(`${command} '${path}'`));
      }
    }
    assert.match(error.message, /logical consistency/);
    assert.match(error.message, /Fix merge errors first/);
    return true;
  });
  assert.match(investigation("release/requests/1.0.0/notes.md"), /reviewed release request process/);
});
