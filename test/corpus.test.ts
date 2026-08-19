import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCorpusSession,
  ensureCorpusRoot,
  findCorpusSessionByIdentity,
  resolveContainedFile,
  resolveCorpusProject,
  sanitizeCorpusLabel,
  SlateWriteRefused,
} from "../extension/corpus.ts";
import { isSlateArtifactReference, slateArtifactReference } from "../extension/artifact-names.ts";
import { isSlateSessionName, SESSION_ADJECTIVES, SESSION_NOUNS } from "../extension/session-names.ts";
import { writeSlateArtifact } from "../extension/slate-files.ts";
import { captureObservation } from "../extension/observations.ts";

function workspace(): { root: string; project: string; agent: string } {
  const root = mkdtempSync(join(tmpdir(), "slate-corpus-test."));
  const project = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(project);
  mkdirSync(agent);
  return { root, project, agent };
}

function withAgent<T>(agent: string, run: () => T): T {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try { return run(); }
  finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

test("session names use one strict portable grammar", () => {
  assert.equal(isSlateSessionName("calm-otter-7f3a"), true);
  for (const rejected of [
    "", "a", "calm-otter-7F3A", ".calm-otter-7f3a", "calm/otter-7f3a",
    "calm\\otter-7f3a", "calm otter-7f3a", "-calm-otter-7f3a", "é-otter-7f3a",
    "calm-otter-7f3a ", `${"a".repeat(44)}-7f3a`, "con-tool-7f3a",
  ]) assert.equal(isSlateSessionName(rejected), false, rejected);
});

test("the self-authored vocabulary has fixed size and no edit-distance-one pair", () => {
  assert.equal(SESSION_ADJECTIVES.length, 32);
  assert.equal(SESSION_NOUNS.length, 32);
  for (const words of [SESSION_ADJECTIVES, SESSION_NOUNS]) {
    assert.equal(new Set(words).size, 32);
    for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) {
      assert.notEqual(distance(words[i]!, words[j]!), 1, `${words[i]} and ${words[j]}`);
    }
  }
});

test("project derivation uses a sanitized label and stable twelve-hex digest", () => {
  const paths = workspace();
  try {
    withAgent(paths.agent, () => {
      const first = resolveCorpusProject(paths.project, "  My Corpus  ");
      const second = resolveCorpusProject(paths.project, "  My Corpus  ");
      assert.equal(first.label, "My-Corpus");
      assert.match(first.digest, /^[0-9a-f]{12}$/);
      assert.equal(first.directory, second.directory);
      for (const rejected of [undefined, "", ".", "..", "../escape", "-hidden", "   ", "CON", "\u0000", "___"]) {
        assert.equal(sanitizeCorpusLabel(rejected), undefined, String(rejected));
      }
      assert.equal(sanitizeCorpusLabel("a   b"), "a-b");
      assert.equal(sanitizeCorpusLabel("a💥b"), "a-b");
      assert.equal(sanitizeCorpusLabel("x".repeat(60))?.length, 48);
    });
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("exclusive session creation retries a collision with fresh four-byte input", () => {
  const paths = workspace();
  try {
    withAgent(paths.agent, () => {
      const firstBytes = Uint8Array.from([0, 0, 0x12, 0x34]);
      const first = createCorpusSession({ cwd: paths.project, identity: "id-one", initialNameBytes: firstBytes, piSessionName: "pi-one" });
      let retries = 0;
      const second = createCorpusSession({
        cwd: paths.project,
        identity: "id-two",
        initialNameBytes: firstBytes,
        drawRetry: () => { retries++; return Uint8Array.from([1, 1, 0xab, 0xcd]); },
      });
      assert.equal(retries, 1);
      assert.notEqual(first.name, second.name);
      const metadata = JSON.parse(readFileSync(join(second.directory, "session.json"), "utf8"));
      assert.equal(metadata.identity, "id-two");
      assert.equal(metadata.name, second.name);
      assert.equal(metadata.worktreePath, paths.project);
    });
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("exclusive session creation refuses after all eight candidates collide", () => {
  const paths = workspace();
  try {
    withAgent(paths.agent, () => {
      const bytes = Uint8Array.from([4, 4, 0x55, 0x55]);
      createCorpusSession({ cwd: paths.project, identity: "first", initialNameBytes: bytes });
      let retries = 0;
      assert.throws(() => createCorpusSession({
        cwd: paths.project,
        identity: "second",
        initialNameBytes: bytes,
        drawRetry: () => { retries++; return bytes; },
      }), /after eight attempts/);
      assert.equal(retries, 7);
    });
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("session metadata lookup ignores unrelated entries and recovers the matching identity", () => {
  const paths = workspace();
  try {
    withAgent(paths.agent, () => {
      const session = createCorpusSession({ cwd: paths.project, identity: "wanted", initialNameBytes: Uint8Array.from([5, 5, 0, 3]) });
      mkdirSync(join(session.project.directory, "not-a-session"));
      assert.deepEqual(findCorpusSessionByIdentity(session.project, "wanted"), { name: session.name, directory: session.directory });
      assert.equal(findCorpusSessionByIdentity(session.project, "missing"), undefined);
    });
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("corpus creation refuses loudly when the agent path cannot be a directory", () => {
  const paths = workspace();
  const blocked = join(paths.root, "blocked");
  writeFileSync(blocked, "not a directory");
  try {
    withAgent(blocked, () => assert.throws(() => ensureCorpusRoot(), SlateWriteRefused));
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("new artifact writes use the corpus session namespace and logical session reference", () => {
  const paths = workspace();
  try {
    withAgent(paths.agent, () => {
      const session = createCorpusSession({ cwd: paths.project, identity: "id", initialNameBytes: Uint8Array.from([3, 3, 0, 2]) });
      const written = writeSlateArtifact({ cwd: paths.project, sessionName: session.name, kind: "episodes", id: "t1.e1", content: "episode" });
      assert.equal(written.absolutePath, join(session.directory, "episodes", "t1.e1.md"));
      assert.equal(written.reference, `.pi/slate/sessions/${session.name}/episodes/t1.e1.md`);
      assert.equal(readFileSync(written.absolutePath, "utf8"), "episode");
      const captured = captureObservation(paths.project, session.name, "t1.e2", "exact output");
      assert.equal(captured.stored, true);
      if (captured.stored) assert.equal(captured.path, `.pi/slate/sessions/${session.name}/observations/t1.e2.md`);
      const absent = captureObservation(paths.project, session.name, "t1.e3", undefined);
      assert.deepEqual(absent, { stored: false, reason: "no-final-message", grammar: "absent" });
    });
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("followed paths accept both roots and reject outside files and symlinks", () => {
  const paths = workspace();
  try {
    withAgent(paths.agent, () => {
      const session = createCorpusSession({ cwd: paths.project, identity: "id", initialNameBytes: Uint8Array.from([2, 2, 0, 1]) });
      const corpusFile = join(session.directory, "episodes", "t1.e1.md");
      writeFileSync(corpusFile, "episode");
      assert.equal(resolveContainedFile(paths.project, corpusFile), corpusFile);

      const legacyDir = join(paths.project, ".pi", "slate", "episodes");
      mkdirSync(legacyDir, { recursive: true });
      const legacy = join(legacyDir, "t1.e0.md");
      writeFileSync(legacy, "legacy");
      assert.equal(resolveContainedFile(paths.project, legacy), legacy);

      assert.equal(resolveContainedFile(paths.project, undefined), undefined);
      assert.equal(resolveContainedFile(paths.project, "relative.md"), undefined);
      const outside = join(paths.root, "outside.md");
      writeFileSync(outside, "outside");
      assert.equal(resolveContainedFile(paths.project, outside), undefined);
      const link = join(session.directory, "episodes", "linked.md");
      symlinkSync(outside, link);
      assert.equal(resolveContainedFile(paths.project, link), undefined);
    });
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("artifact references accept session and legacy forms only", () => {
  const current = slateArtifactReference("calm-otter-7f3a", "episodes", "t1.e1");
  assert.equal(isSlateArtifactReference(current, "episodes", "t1.e1"), true);
  assert.equal(isSlateArtifactReference(".pi/slate/episodes/t1.e1.md", "episodes", "t1.e1"), true);
  for (const bad of [
    ".pi/slate/sessions/../episodes/t1.e1.md",
    ".pi/slate/sessions/calm-otter-7f3a/threads/t1.e1.md",
    ".pi/slate/sessions/calm-otter-7f3a/episodes/../../x.md",
    `${current}${"x".repeat(241)}`,
  ]) assert.equal(isSlateArtifactReference(bad), false, bad);
});
