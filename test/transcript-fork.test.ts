import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  publishStagedFile,
  type CorpusProject,
} from "../extension/corpus.ts";
import {
  forkSourceSizeAllowed,
  MAX_FORK_SOURCE_BYTES,
  ThreadManager,
} from "../extension/threads.ts";
import {
  sanitizeThreadRecord,
  SlateStore,
  type SlateSnapshot,
  type ThreadRecord,
} from "../extension/state.ts";

const SESSION_NAME = "calm-otter-0001";

interface Harness {
  root: string;
  cwd: string;
  projectDirectory: string;
  currentThreads: string;
  store: SlateStore;
  manager: ThreadManager;
  ctx: ExtensionContext;
  reports: string[];
  prepare(thread: ThreadRecord): string | undefined;
  assign(thread: ThreadRecord, candidate: string, source?: string): boolean;
}

function transcript(entries = 2): string {
  const lines = [
    { type: "session", version: 3, id: "source-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/source" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "continue" } },
  ];
  return `${lines.slice(0, entries).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function entryCount(file: string): number {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
}

function thread(sessionFile: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "t7",
    name: "inherited worker",
    sessionFile,
    status: "idle",
    episodeIds: [],
    episodeSeq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function harness(t: TestContext): Harness {
  const root = mkdtempSync(join(tmpdir(), "slate-transcript-fork."));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "worktree");
  const projectDirectory = join(root, "corpus-project");
  const currentThreads = join(projectDirectory, SESSION_NAME, "threads");
  mkdirSync(cwd);
  mkdirSync(currentThreads, { recursive: true });
  const project: CorpusProject = {
    root: root,
    key: cwd,
    label: "project",
    digest: "0123456789ab",
    directory: projectDirectory,
    matchingDirectories: [],
  };
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.corpusProject = project;
  store.slateSessionName = SESSION_NAME;
  const manager = new ThreadManager(store, {});
  const ctx = { cwd, hasUI: false } as unknown as ExtensionContext;
  const reports: string[] = [];
  const internals = manager as unknown as {
    prepareTranscriptForOpen(args: { thread: ThreadRecord; ctx: ExtensionContext; report(message: string): void }): string | undefined;
    assignSessionFile(record: ThreadRecord, candidate: string, source?: string): boolean;
  };
  return {
    root,
    cwd,
    projectDirectory,
    currentThreads,
    store,
    manager,
    ctx,
    reports,
    prepare: (record) => internals.prepareTranscriptForOpen({ thread: record, ctx, report: (message) => reports.push(message) }),
    assign: (record, candidate, source) => internals.assignSessionFile(record, candidate, source),
  };
}

function corpusSource(h: Harness, name = "brisk-bison-0002"): string {
  const directory = join(h.projectDirectory, name, "threads");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "worker.jsonl");
  writeFileSync(file, transcript());
  return file;
}

function legacySource(h: Harness): string {
  const directory = join(h.cwd, ".pi", "slate", "threads");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "legacy.jsonl");
  writeFileSync(file, transcript());
  return file;
}

function assertForked(h: Harness, record: ThreadRecord, source: string): void {
  const opened = h.prepare(record);
  assert.ok(opened);
  assert.notEqual(opened, source);
  assert.equal(record.sessionFile, opened);
  assert.equal(record.forkedFrom, source);
  assert.equal(opened.startsWith(`${h.currentThreads}/`), true);
  assert.equal(entryCount(opened), entryCount(source));
  assert.equal(readFileSync(source, "utf8"), transcript());
}

test("an inherited corpus transcript forks on first use and rewrites durable thread state", (t) => {
  const h = harness(t);
  const source = corpusSource(h);
  assertForked(h, thread(source), source);
});

test("a legacy flat transcript forks before its next append", (t) => {
  const h = harness(t);
  const source = legacySource(h);
  assertForked(h, thread(source), source);
});

test("a current-session transcript opens in place without a fork", (t) => {
  const h = harness(t);
  const source = join(h.currentThreads, "current.jsonl");
  writeFileSync(source, transcript());
  const record = thread(source);
  assert.equal(h.prepare(record), source);
  assert.equal(record.sessionFile, source);
  assert.equal(record.forkedFrom, undefined);
  assert.deepEqual([source], [join(h.currentThreads, "current.jsonl")]);
});

test("the transcript fork size boundary accepts 64 MiB and refuses the next byte", () => {
  assert.equal(forkSourceSizeAllowed(MAX_FORK_SOURCE_BYTES - 1), true);
  assert.equal(forkSourceSizeAllowed(MAX_FORK_SOURCE_BYTES), true);
  assert.equal(forkSourceSizeAllowed(MAX_FORK_SOURCE_BYTES + 1), false);
});

test("post-stage entry mismatch retains the source and reports an actionable failure", (t) => {
  const h = harness(t);
  const source = corpusSource(h);
  const record = thread(source);
  const original = SessionManager.forkFrom;
  Object.defineProperty(SessionManager, "forkFrom", {
    configurable: true,
    value: (_source: string, _cwd: string, stagingDirectory: string) => {
      const file = join(stagingDirectory, "short.jsonl");
      writeFileSync(file, transcript(1));
      return { getSessionFile: () => file };
    },
  });
  t.after(() => Object.defineProperty(SessionManager, "forkFrom", { configurable: true, value: original }));

  assert.throws(() => h.prepare(record), /staged entry count 1 does not match source entry count 2/);
  assert.equal(record.sessionFile, source);
  assert.equal(record.forkedFrom, undefined);
  assert.equal(readFileSync(source, "utf8"), transcript());
  assert.match(h.reports.join("\n"), new RegExp(`thread ${record.id}`));
  assert.match(h.reports.join("\n"), new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(h.reports.join("\n"), /staged entry count/);
});

test("pre-open mismatch performs one re-fork and never falls back to the source", (t) => {
  const h = harness(t);
  const source = legacySource(h);
  const record = thread(source);
  let attempts = 0;
  const view = h.manager as unknown as {
    createTranscriptFork(args: { threadsDirectory: string }): { file: string; source: string; sourceEntries: number };
  };
  view.createTranscriptFork = ({ threadsDirectory }) => {
    attempts++;
    const file = join(threadsDirectory, `short-${attempts}.jsonl`);
    writeFileSync(file, transcript(1));
    return { file, source, sourceEntries: 2 };
  };

  assert.throws(() => h.prepare(record), /published entry count 1 is shorter than source entry count 2/);
  assert.equal(attempts, 2, "one initial fork and one re-fork must run");
  assert.equal(record.forkedFrom, source);
  assert.notEqual(record.sessionFile, source);
  assert.equal(readFileSync(source, "utf8"), transcript());
  assert.match(h.reports.join("\n"), /thread t7/);
  assert.match(h.reports.join("\n"), /published entry count/);
});

test("a damaged persisted fork gets exactly one re-fork attempt", (t) => {
  const h = harness(t);
  const source = corpusSource(h);
  const damaged = join(h.currentThreads, "damaged.jsonl");
  writeFileSync(damaged, transcript(1));
  const record = thread(damaged, { forkedFrom: source });
  let attempts = 0;
  const view = h.manager as unknown as {
    createTranscriptFork(args: { threadsDirectory: string }): { file: string; source: string; sourceEntries: number };
  };
  view.createTranscriptFork = ({ threadsDirectory }) => {
    attempts++;
    const file = join(threadsDirectory, `still-short-${attempts}.jsonl`);
    writeFileSync(file, transcript(1));
    return { file, source, sourceEntries: 2 };
  };

  assert.throws(() => h.prepare(record), /published entry count/);
  assert.equal(attempts, 1);
  assert.equal(record.forkedFrom, source);
  assert.equal(readFileSync(source, "utf8"), transcript());
});

test("fork failures never append to a legacy transcript", (t) => {
  const h = harness(t);
  const source = legacySource(h);
  writeFileSync(source, `${transcript()}not-json\n`);
  const before = readFileSync(source);
  const record = thread(source);
  assert.throws(() => h.prepare(record), /unparseable JSONL entry/);
  assert.deepEqual(readFileSync(source), before);
  assert.equal(record.sessionFile, source);
  assert.equal(existsSync(join(h.currentThreads, "legacy.jsonl")), false);
});

test("thread containment rejects direct links, outside files, and linked parents", (t) => {
  const h = harness(t);
  const outsideDirectory = join(h.root, "outside");
  mkdirSync(outsideDirectory);
  const outside = join(outsideDirectory, "worker.jsonl");
  writeFileSync(outside, transcript());
  const legacyDirectory = join(h.cwd, ".pi", "slate", "threads");
  mkdirSync(legacyDirectory, { recursive: true });
  const directLink = join(legacyDirectory, "direct.jsonl");
  symlinkSync(outside, directLink);
  const linkedParent = join(legacyDirectory, "linked-parent");
  symlinkSync(outsideDirectory, linkedParent);

  for (const candidate of [directLink, outside, join(linkedParent, "worker.jsonl")]) {
    const record = thread(candidate);
    assert.throws(() => h.prepare(record), /unsafe or missing/);
    assert.equal(record.sessionFile, candidate);
    assert.equal(record.forkedFrom, undefined);
  }
  assert.equal(readFileSync(outside, "utf8"), transcript());
});

test("thread snapshot sanitizing rejects hostile, stale, and inconsistent fork pairs", (t) => {
  const h = harness(t);
  const current = join(h.currentThreads, "current.jsonl");
  const source = corpusSource(h);
  const outside = join(h.root, "outside.jsonl");
  writeFileSync(current, transcript());
  writeFileSync(outside, transcript());

  const repairs: string[] = [];
  const malformed = sanitizeThreadRecord(thread(current, { forkedFrom: 42 as unknown as string }), repairs);
  assert.equal(malformed?.forkedFrom, undefined);
  assert.match(repairs.join("\n"), /ignoring forkedFrom/);

  const notifications: string[] = [];
  const ctx = {
    cwd: h.cwd,
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  const snapshot = (record: ThreadRecord): SlateSnapshot => ({
    threads: [record], episodes: [], orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0,
  });
  for (const hostile of [
    thread(outside, { forkedFrom: source }),
    thread(current, { forkedFrom: outside }),
    thread(source, { forkedFrom: source }),
  ]) {
    h.store.adoptSnapshot(snapshot(hostile), ctx);
    assert.equal(h.store.threads.size, 0);
  }
  assert.match(notifications.join("\n"), /outside slate thread storage|fork source.*inconsistent/);
});

test("the session-file guard permits only empty assignment and sanctioned fork rewrites", (t) => {
  const h = harness(t);
  const source = corpusSource(h);
  const first = join(h.currentThreads, "first.jsonl");
  const unrelated = join(h.currentThreads, "unrelated.jsonl");
  const forked = join(h.currentThreads, "forked.jsonl");

  const empty = thread("");
  assert.equal(h.assign(empty, first), true);
  assert.equal(empty.sessionFile, first);
  assert.equal(h.assign(empty, unrelated), false);
  assert.equal(empty.sessionFile, first);

  const inherited = thread(source);
  assert.equal(h.assign(inherited, forked, source), true);
  assert.equal(inherited.sessionFile, forked);
  assert.equal(inherited.forkedFrom, source);
});

test("publishStagedFile refuses existing destinations and linked staging files", (t) => {
  const h = harness(t);
  const staging = join(h.currentThreads, "staging.jsonl");
  const final = join(h.currentThreads, "final.jsonl");
  writeFileSync(staging, transcript());
  writeFileSync(final, "occupied");
  let verified = false;
  assert.throws(() => publishStagedFile(staging, final, () => { verified = true; }), /replace an existing published file/);
  assert.equal(verified, false);
  assert.equal(readFileSync(final, "utf8"), "occupied");

  rmSync(staging);
  rmSync(final);
  const real = join(h.currentThreads, "real.jsonl");
  writeFileSync(real, transcript());
  symlinkSync(real, staging);
  assert.throws(() => publishStagedFile(staging, final, () => {}), /missing or linked staged file/);
  assert.equal(existsSync(final), false);
});
