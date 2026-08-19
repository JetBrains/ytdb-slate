import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  publishStagedFile,
  resolveContainedThreadFile,
  withContainedThreadFile,
  type CorpusProject,
} from "../extension/corpus.ts";
import {
  forkSourceSizeAllowed,
  inspectTranscriptPath,
  MAX_FORK_SOURCE_BYTES,
  ThreadManager,
} from "../extension/threads.ts";
import {
  sanitizeThreadRecord,
  SlateStore,
  type EpisodeRecord,
  type SlateSnapshot,
  type ThreadRecord,
} from "../extension/state.ts";

const SESSION_NAME = "calm-otter-0001";
const GENEROUS_LIMIT = 64 * 1024 * 1024;

// Every dispatch path this file drives reads pi settings, so keep the real agent
// directory out of reach for the whole file.
const agentScratch = mkdtempSync(join(tmpdir(), "slate-transcript-fork-agent."));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = agentScratch;
process.env.PI_OFFLINE = "1";
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  rmSync(agentScratch, { recursive: true, force: true });
});

interface Workspace {
  root: string;
  cwd: string;
  projectDirectory: string;
  project: CorpusProject;
}

interface Session {
  workspace: Workspace;
  threads: string;
  store: SlateStore;
  manager: ThreadManager;
  ctx: ExtensionContext;
  reports: string[];
  snapshots: number;
  prepare(thread: ThreadRecord): string | undefined;
  assign(thread: ThreadRecord, candidate: string, source?: string): boolean;
}

/** `entries` JSONL records, the first one a valid session header. */
function transcript(entries = 2): string {
  const lines = [
    { type: "session", version: 3, id: "source-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/source" },
    ...Array.from({ length: Math.max(entries - 1, 0) }, (_, index) => ({
      type: "message",
      id: `m${index}`,
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: `turn ${index}` },
    })),
  ];
  return `${lines.slice(0, entries).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Count exactly what pi's loader and the fork verification count: parseable lines. */
function parsedCount(file: string): number {
  return readFileSync(file, "utf8").split("\n").filter((line) => {
    if (line.trim() === "") return false;
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }).length;
}

function forkedFiles(session: Session): string[] {
  return readdirSync(session.threads).sort();
}

/** The workspace removal hook is registered first and may already have run. */
function restorePermissions(directory: string): void {
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* the workspace is already gone */
  }
}

function workspace(t: TestContext): Workspace {
  const root = mkdtempSync(join(tmpdir(), "slate-transcript-fork."));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "worktree");
  const projectDirectory = join(root, "corpus-project");
  mkdirSync(cwd);
  mkdirSync(projectDirectory, { recursive: true });
  return {
    root,
    cwd,
    projectDirectory,
    project: {
      root,
      key: cwd,
      label: "project",
      digest: "0123456789ab",
      directory: projectDirectory,
      matchingDirectories: [],
    },
  };
}

function session(space: Workspace, name = SESSION_NAME): Session {
  const threads = join(space.projectDirectory, name, "threads");
  mkdirSync(threads, { recursive: true });
  let snapshots = 0;
  const store = new SlateStore({ appendEntry() { view.snapshots++; } } as unknown as ExtensionAPI);
  store.corpusProject = space.project;
  store.slateSessionName = name;
  const manager = new ThreadManager(store, {});
  const ctx = {
    cwd: space.cwd,
    hasUI: false,
    model: undefined,
    isProjectTrusted: () => false,
    modelRegistry: {
      find: () => undefined,
      getAvailable: async () => [],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      hasConfiguredAuth: () => true,
    },
  } as unknown as ExtensionContext;
  const reports: string[] = [];
  const internals = manager as unknown as {
    prepareTranscriptForOpen(args: { thread: ThreadRecord; ctx: ExtensionContext; report(message: string): void }): string | undefined;
    assignSessionFile(record: ThreadRecord, candidate: string, source?: string): boolean;
  };
  const view: Session = {
    workspace: space,
    threads,
    store,
    manager,
    ctx,
    reports,
    snapshots,
    prepare: (record) => internals.prepareTranscriptForOpen({ thread: record, ctx, report: (message) => reports.push(message) }),
    assign: (record, candidate, source) => internals.assignSessionFile(record, candidate, source),
  };
  return view;
}

function harness(t: TestContext): Session {
  return session(workspace(t));
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

function snapshotOf(threads: ThreadRecord[], episodes: EpisodeRecord[] = []): SlateSnapshot {
  return { threads, episodes, orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
}

/** A transcript in another corpus session's threads directory, which is inherited storage. */
function corpusSource(space: Workspace, name = "brisk-bison-0002", entries = 2): string {
  const directory = join(space.projectDirectory, name, "threads");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "worker.jsonl");
  writeFileSync(file, transcript(entries));
  return file;
}

function legacySource(space: Workspace, content = transcript()): string {
  const directory = join(space.cwd, ".pi", "slate", "threads");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "legacy.jsonl");
  writeFileSync(file, content);
  return file;
}

function assertForked(h: Session, record: ThreadRecord, source: string): string {
  const before = readFileSync(source, "utf8");
  const opened = h.prepare(record);
  assert.ok(opened);
  assert.notEqual(opened, source);
  assert.equal(record.sessionFile, opened);
  assert.equal(record.forkedFrom, source);
  assert.equal(opened.startsWith(`${h.threads}/`), true);
  assert.equal(parsedCount(opened), parsedCount(source));
  assert.equal(readFileSync(source, "utf8"), before, "the source must stay byte-identical");
  return opened;
}

function withStubbedFork(t: TestContext, value: unknown): void {
  const original = SessionManager.forkFrom;
  Object.defineProperty(SessionManager, "forkFrom", { configurable: true, value });
  t.after(() => Object.defineProperty(SessionManager, "forkFrom", { configurable: true, value: original }));
}

test("an inherited corpus transcript forks on first use and rewrites durable thread state", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace);
  assertForked(h, thread(source), source);
});

test("a legacy flat transcript forks before its next append", (t) => {
  const h = harness(t);
  const source = legacySource(h.workspace);
  assertForked(h, thread(source), source);
});

test("an owned transcript opens in place on every later dispatch and is copied exactly once", (t) => {
  const h = harness(t);
  const owned = join(h.threads, "current.jsonl");
  writeFileSync(owned, transcript());
  const record = thread(owned);
  assert.equal(h.prepare(record), owned);
  assert.equal(h.prepare(record), owned, "a second dispatch must reuse the same transcript");
  assert.equal(record.sessionFile, owned);
  assert.equal(record.forkedFrom, undefined);
  assert.deepEqual(forkedFiles(h), ["current.jsonl"], "no second copy may appear");
});

test("the transcript fork size boundary accepts 64 MiB and refuses the next byte", () => {
  assert.equal(forkSourceSizeAllowed(MAX_FORK_SOURCE_BYTES - 1), true);
  assert.equal(forkSourceSizeAllowed(MAX_FORK_SOURCE_BYTES), true);
  assert.equal(forkSourceSizeAllowed(MAX_FORK_SOURCE_BYTES + 1), false);
});

test("a staged entry mismatch publishes nothing, retains the source and reports the thread, source and reason", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace);
  const record = thread(source);
  let attempts = 0;
  withStubbedFork(t, (_source: string, _cwd: string, stagingDirectory: string) => {
    attempts++;
    const file = join(stagingDirectory, "short.jsonl");
    writeFileSync(file, transcript(1));
    return { getSessionFile: () => file };
  });

  assert.throws(() => h.prepare(record), /staged entry count 1 does not match source entry count 2/);
  assert.equal(attempts, 1, "a refusal before publication must not be retried");
  assert.equal(record.sessionFile, source);
  assert.equal(record.forkedFrom, undefined);
  assert.equal(readFileSync(source, "utf8"), transcript());
  assert.deepEqual(forkedFiles(h), [], "nothing may be published");
  const report = h.reports.join("\n");
  assert.match(report, /thread t7/);
  assert.match(report, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(report, /staged entry count/);
  assert.match(report, /Nothing ran and no episode was recorded/);
});

test("D124: a published entry mismatch re-forks once, persists nothing and never falls back to the source", (t) => {
  const h = harness(t);
  const source = legacySource(h.workspace);
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

  assert.throws(() => h.prepare(record), /published entry count 1 does not match source entry count 2/);
  assert.equal(attempts, 2, "one copy and D121's single re-fork, then a refusal");
  assert.equal(record.sessionFile, source, "an unverified path is never persisted");
  assert.equal(record.forkedFrom, undefined);
  assert.equal(readFileSync(source, "utf8"), transcript());
  assert.match(h.reports.join("\n"), /thread t7/);
  assert.match(h.reports.join("\n"), /published entry count/);
});

test("D121: an owned fork holding no parseable entry is re-forked from the retained source, which survives", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace, "brisk-bison-0002", 3);
  const damaged = join(h.threads, "damaged.jsonl");
  writeFileSync(damaged, "not-json\n");
  const record = thread(damaged, { forkedFrom: source });

  const recovered = h.prepare(record);
  assert.ok(recovered);
  assert.notEqual(recovered, damaged);
  assert.equal(record.sessionFile, recovered);
  assert.equal(record.forkedFrom, source);
  assert.equal(parsedCount(recovered), 3);
  assert.equal(existsSync(damaged), true, "a discarded copy is dereferenced, never unlinked");
  assert.equal(readFileSync(source, "utf8"), transcript(3));
});

test("D121: an empty transcript and a headerless transcript are refused as damaged", (t) => {
  const h = harness(t);
  const empty = join(h.threads, "empty.jsonl");
  const headerless = join(h.threads, "headerless.jsonl");
  writeFileSync(empty, "");
  writeFileSync(headerless, `${transcript().split("\n")[1]}\n`);

  assert.throws(() => h.prepare(thread(empty)), /holds no parseable entry/);
  assert.throws(() => h.prepare(thread(headerless)), /no valid session header/);
  assert.equal(existsSync(empty), true);
  assert.equal(existsSync(headerless), true);
});

test("BG1: a successor session forks the thread's own newest transcript and deletes nothing", (t) => {
  const space = workspace(t);
  const first = session(space, SESSION_NAME);
  const source = corpusSource(space);
  const record = thread(source);
  const inherited = assertForked(first, record, source);
  appendFileSync(inherited, transcript(3).split("\n").slice(1).join("\n"));
  const grown = parsedCount(inherited);
  assert.equal(grown, 4, "the fixture must make the inherited fork newer than its own source");

  const successor = session(space, "dusky-heron-0003");
  const opened = successor.prepare(record);
  assert.ok(opened);
  assert.equal(opened.startsWith(`${successor.threads}/`), true);
  assert.equal(parsedCount(opened), grown, "the successor must copy the newest transcript, not the stale source");
  assert.equal(existsSync(inherited), true, "the inherited transcript must survive");
  assert.equal(existsSync(source), true, "the original source must survive");
  assert.equal(record.sessionFile, opened);
  assert.equal(record.forkedFrom, inherited);
});

test("SE94: a record pairing two unrelated transcripts forks the session file and deletes neither", (t) => {
  const h = harness(t);
  const victim = corpusSource(h.workspace, "foggy-ibex-0005", 4);
  const other = corpusSource(h.workspace, "gaunt-koala-0006", 2);
  const record = thread(victim, { forkedFrom: other });

  const opened = h.prepare(record);
  assert.ok(opened);
  assert.equal(parsedCount(opened), 4, "the fork must copy the session file, never the paired path");
  assert.equal(existsSync(victim), true, "the paired session file must survive");
  assert.equal(existsSync(other), true, "the paired source must survive");
  assert.equal(record.forkedFrom, victim);
});

test("BG2: an owned fork with a crash-truncated trailing line opens in place and is never replaced", (t) => {
  const h = harness(t);
  const owned = join(h.threads, "live.jsonl");
  writeFileSync(owned, `${transcript(3)}{"type":"message","id":"trunc`);
  const record = thread(owned, { forkedFrom: corpusSource(h.workspace) });
  const before = readFileSync(owned);

  assert.equal(h.prepare(record), owned, "pi's loader skips such a line, and so must slate");
  assert.deepEqual(readFileSync(owned), before);
  assert.deepEqual(forkedFiles(h), ["live.jsonl"], "no re-fork may happen");
});

test("BG5: a legacy source with a crash-truncated trailing line still forks, and no failure appends to the legacy path", (t) => {
  const h = harness(t);
  const source = legacySource(h.workspace, `${transcript(3)}{"type":"message","id":"trunc`);
  const legacyDirectory = join(h.workspace.cwd, ".pi", "slate", "threads");
  const record = thread(source);
  const before = readFileSync(source);

  const opened = h.prepare(record);
  assert.ok(opened);
  assert.equal(parsedCount(opened), 3, "the copy holds every parseable entry and nothing else");
  assert.deepEqual(readFileSync(source), before, "the legacy transcript is read-only");
  assert.deepEqual(readdirSync(legacyDirectory), ["legacy.jsonl"], "no append may reach the legacy layout");
});

test("BG3: a missing retained source leaves the thread openable and keeps its record and episodes", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace);
  const record = thread(source);
  const forked = assertForked(h, record, source);
  rmSync(source);

  assert.equal(h.prepare(record), forked, "a healthy owned fork never consults the retained source");

  const episodesDirectory = join(h.workspace.projectDirectory, SESSION_NAME, "episodes");
  mkdirSync(episodesDirectory, { recursive: true });
  const episodeFile = join(episodesDirectory, "t7.e1.md");
  writeFileSync(episodeFile, "episode");
  const notices: string[] = [];
  const ctx = {
    cwd: h.workspace.cwd,
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  h.store.adoptSnapshot(
    snapshotOf(
      [{ ...record, episodeIds: ["t7.e1"], episodeSeq: 1 }],
      [{ id: "t7.e1", threadId: "t7", task: "work", status: "ok", file: episodeFile, createdAt: 2 }],
    ),
    ctx,
  );
  const restored = h.store.threads.get("t7");
  assert.ok(restored, "the record must survive a retained source that vanished");
  assert.equal(restored.sessionFile, forked);
  assert.equal(restored.forkedFrom, undefined, "the unusable recovery hint is dropped");
  assert.deepEqual(restored.episodeIds, ["t7.e1"]);
  assert.equal(h.store.episodes.size, 1);
  assert.match(notices.join("\n"), /ignoring forkedFrom/);
});

test("BG4: an empty forkedFrom is treated as absent, and a valid pair survives adoptSnapshot", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace);
  const owned = join(h.threads, "owned.jsonl");
  writeFileSync(owned, transcript());

  const repairs: string[] = [];
  const sanitized = sanitizeThreadRecord({ ...thread(owned, { forkedFrom: "" }) }, repairs);
  assert.equal(sanitized?.forkedFrom, undefined);
  assert.equal("forkedFrom" in (sanitized ?? {}), false);
  assert.match(repairs.join("\n"), /ignoring forkedFrom/);

  const notices: string[] = [];
  const ctx = {
    cwd: h.workspace.cwd,
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  h.store.adoptSnapshot(snapshotOf([thread(owned, { forkedFrom: "" })]), ctx);
  assert.equal(h.store.threads.size, 1, "an empty recovery hint may not drop a thread");
  assert.equal(h.store.threads.get("t7")?.forkedFrom, undefined);

  h.store.adoptSnapshot(snapshotOf([thread(owned, { forkedFrom: source })]), ctx);
  const restored = h.store.threads.get("t7");
  assert.ok(restored, "a valid session file and fork source pair must survive restore");
  assert.equal(restored.sessionFile, owned);
  assert.equal(restored.forkedFrom, source);
});

test("CQ38: a fork failure aborts the dispatch with no episode and no compressor call", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  t.after(() => h.manager.disposeAll());
  const outside = join(h.workspace.root, "outside.jsonl");
  writeFileSync(outside, transcript());
  const record = thread(outside);
  h.store.threads.set(record.id, record);

  await assert.rejects(
    h.manager.dispatch({ threadId: record.id, task: "continue the thread" }, h.ctx, undefined),
    /transcript fork failed for thread t7/,
  );
  assert.equal(h.store.episodes.size, 0, "an aborted dispatch records no episode");
  assert.equal(record.episodeSeq, 0, "the episode counter may not advance");
  assert.deepEqual(record.episodeIds, []);
  assert.equal(record.status, "idle");
  assert.equal(h.store.workerCostUsd, 0, "no compressor or worker call may be billed");
  assert.deepEqual(forkedFiles(h), []);
});

test("CN111: a source appended to during the copy is refused, publishes nothing and stays untouched", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace, "kelpy-raven-0010", 3);
  const record = thread(source);
  const original = SessionManager.forkFrom;
  withStubbedFork(t, (from: string, targetCwd: string, stagingDirectory: string) => {
    const manager = original.call(SessionManager, from, targetCwd, stagingDirectory);
    appendFileSync(source, transcript(2).split("\n").slice(1).join("\n")); // a live writer appends
    return manager;
  });

  assert.throws(() => h.prepare(record), /the source changed while the fork was copied/);
  assert.equal(record.sessionFile, source, "a copy of a changed source is never persisted");
  assert.equal(record.forkedFrom, undefined);
  assert.equal(parsedCount(source), 4, "the source keeps every entry, including the new one");
  assert.deepEqual(forkedFiles(h), [], "nothing may be published");
  assert.match(h.reports.join("\n"), /thread t7/);
});

test("CN113: a copy that throws mid-flight leaves no staging directory behind", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace);
  withStubbedFork(t, (_from: string, _cwd: string, stagingDirectory: string) => {
    writeFileSync(join(stagingDirectory, "half.jsonl"), transcript());
    throw new Error("copy failed mid-flight");
  });

  assert.throws(() => h.prepare(thread(source)), /copy failed mid-flight/);
  assert.deepEqual(forkedFiles(h), [], "the attempt directory and its partial file must be gone");
});

test("SE91: a FIFO under an approved root is refused promptly instead of blocking the process", { timeout: 60000 }, (t) => {
  const h = harness(t);
  const fifo = join(h.threads, "blocking.jsonl");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch (error) {
    t.skip(`mkfifo is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // A blocking open is SYNCHRONOUS, so a test timeout cannot interrupt it: the whole
  // suite hangs instead of failing. The refusal therefore runs in a child process under a
  // wall-clock kill, which turns that hang into this test's failure.
  const child = `
    const { resolveContainedThreadFile } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "extension", "corpus.ts")).href)});
    console.log(String(resolveContainedThreadFile(${JSON.stringify(h.workspace.cwd)}, ${JSON.stringify(fifo)}, ${JSON.stringify(h.workspace.projectDirectory)})));
  `;
  const answer = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", child], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 20000,
    killSignal: "SIGKILL",
  }).trim();
  assert.equal(answer, "undefined", "containment must refuse a FIFO rather than open it");
  assert.equal(resolveContainedThreadFile(h.workspace.cwd, fifo, h.workspace.projectDirectory), undefined);
  assert.throws(() => h.prepare(thread(fifo)), /missing, linked, changing, or outside approved thread storage/);
});

test("SE92: a hardlink under an approved root is refused", (t) => {
  const h = harness(t);
  const outside = join(h.workspace.root, "outside.jsonl");
  writeFileSync(outside, transcript());
  const inside = join(h.threads, "hardlink.jsonl");
  linkSync(outside, inside);

  assert.equal(resolveContainedThreadFile(h.workspace.cwd, inside, h.workspace.projectDirectory), undefined);
  assert.throws(() => h.prepare(thread(inside)), /missing, linked, changing, or outside approved thread storage/);
  assert.equal(readFileSync(outside, "utf8"), transcript());
});

test("thread containment rejects direct links, outside files, and linked parents", (t) => {
  const h = harness(t);
  const outsideDirectory = join(h.workspace.root, "outside");
  mkdirSync(outsideDirectory);
  const outside = join(outsideDirectory, "worker.jsonl");
  writeFileSync(outside, transcript());
  const legacyDirectory = join(h.workspace.cwd, ".pi", "slate", "threads");
  mkdirSync(legacyDirectory, { recursive: true });
  const directLink = join(legacyDirectory, "direct.jsonl");
  symlinkSync(outside, directLink);
  const linkedParent = join(legacyDirectory, "linked-parent");
  symlinkSync(outsideDirectory, linkedParent);

  for (const candidate of [directLink, outside, join(linkedParent, "worker.jsonl")]) {
    const record = thread(candidate);
    assert.throws(() => h.prepare(record), /missing, linked, changing, or outside approved thread storage/);
    assert.equal(record.sessionFile, candidate);
    assert.equal(record.forkedFrom, undefined);
  }
  assert.equal(readFileSync(outside, "utf8"), transcript());
});

test("an unsafe session file drops its thread while a valid one survives restore", (t) => {
  const h = harness(t);
  const outside = join(h.workspace.root, "outside.jsonl");
  writeFileSync(outside, transcript());
  const notices: string[] = [];
  const ctx = {
    cwd: h.workspace.cwd,
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;

  h.store.adoptSnapshot(snapshotOf([thread(outside, { forkedFrom: corpusSource(h.workspace) })]), ctx);
  assert.equal(h.store.threads.size, 0, "the session file remains the load-bearing path");
  assert.match(notices.join("\n"), /session file is missing, linked, or outside slate thread storage/);

  const repairs: string[] = [];
  const malformed = sanitizeThreadRecord(thread(outside, { forkedFrom: 42 as unknown as string }), repairs);
  assert.equal(malformed?.forkedFrom, undefined);
  assert.match(repairs.join("\n"), /ignoring forkedFrom \(number\)/);
});

test("the session-file guard permits only empty assignment and sanctioned fork rewrites", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace);
  const first = join(h.threads, "first.jsonl");
  const unrelated = join(h.threads, "unrelated.jsonl");
  const forked = join(h.threads, "forked.jsonl");

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

test("publishStagedFile verifies through the pinned descriptor and refuses an existing destination", (t) => {
  const h = harness(t);
  const staging = join(h.threads, "staging.jsonl");
  const final = join(h.threads, "final.jsonl");
  writeFileSync(staging, transcript());
  writeFileSync(final, "occupied");
  let verified = false;
  assert.throws(() => publishStagedFile(staging, final, () => { verified = true; }), /replace an existing published file/);
  assert.equal(verified, false);
  assert.equal(readFileSync(final, "utf8"), "occupied");
  rmSync(final);

  let seenFd = -1;
  let seenPath = "";
  publishStagedFile(staging, final, (fd, path) => {
    seenFd = fd;
    seenPath = path;
    assert.equal(inspectTranscriptPath(h.workspace.cwd, path, h.workspace.projectDirectory, GENEROUS_LIMIT).entries, 2);
  });
  assert.ok(seenFd >= 0, "the verification must receive the pinned descriptor");
  assert.equal(seenPath, staging);
  assert.equal(existsSync(staging), false, "the staged name is retired by publication");
  assert.equal(parsedCount(final), 2);
});

test("publishStagedFile refuses a linked staged file", (t) => {
  const h = harness(t);
  const staging = join(h.threads, "staging.jsonl");
  const final = join(h.threads, "final.jsonl");
  const real = join(h.threads, "real.jsonl");
  writeFileSync(real, transcript());
  symlinkSync(real, staging);
  assert.throws(() => publishStagedFile(staging, final, () => {}), /missing or linked staged file/);
  assert.equal(existsSync(final), false);

  rmSync(staging);
  linkSync(real, staging);
  assert.throws(() => publishStagedFile(staging, final, () => {}), /missing or linked staged file/);
  assert.equal(existsSync(final), false);
});

test("SE93: a destination created during verification is not overwritten, and a swapped staging inode is not published", (t) => {
  const h = harness(t);
  const raced = join(h.threads, "raced.jsonl");
  const racedFinal = join(h.threads, "raced-final.jsonl");
  writeFileSync(raced, transcript());
  assert.throws(
    () => publishStagedFile(raced, racedFinal, () => writeFileSync(racedFinal, "a competing file")),
    /replace an existing published file/,
  );
  assert.equal(readFileSync(racedFinal, "utf8"), "a competing file", "the competing file must survive intact");

  const swapped = join(h.threads, "swapped.jsonl");
  const swappedFinal = join(h.threads, "swapped-final.jsonl");
  writeFileSync(swapped, transcript());
  assert.throws(
    () => publishStagedFile(swapped, swappedFinal, () => {
      rmSync(swapped);
      writeFileSync(swapped, transcript(1));
    }),
    /staged file because it changed/,
  );
  assert.equal(existsSync(swappedFinal), false, "an unverified inode may never be published");
  assert.equal(parsedCount(swapped), 1, "the replacement staged file is left where it is");
});

test("containment refuses a file that is replaced while it is being read", (t) => {
  const h = harness(t);
  const owned = join(h.threads, "racing.jsonl");
  writeFileSync(owned, transcript());
  let calls = 0;
  const answer = withContainedThreadFile(h.workspace.cwd, owned, h.workspace.projectDirectory, () => {
    calls++;
    rmSync(owned);
    writeFileSync(owned, transcript(1)); // a different inode now answers for the same name
    return "used";
  });
  assert.equal(calls, 1, "the callback must have run, so this is a post-use refusal");
  assert.equal(answer, undefined);
});

test("publishStagedFile refuses a missing staged file and rethrows a reservation failure it cannot classify", (t) => {
  const h = harness(t);
  assert.throws(
    () => publishStagedFile(join(h.threads, "absent.jsonl"), join(h.threads, "final.jsonl"), () => {}),
    /missing or linked staged file/,
  );

  const staging = join(h.threads, "staging.jsonl");
  writeFileSync(staging, transcript());
  const readOnly = join(h.workspace.projectDirectory, SESSION_NAME, "read-only");
  mkdirSync(readOnly, { recursive: true });
  t.after(() => restorePermissions(readOnly));
  chmodSync(readOnly, 0o500);
  assert.throws(() => publishStagedFile(staging, join(readOnly, "final.jsonl"), () => {}), /EACCES|EPERM/);
  assert.equal(existsSync(staging), true, "the staged file survives a refused reservation");
  assert.deepEqual(readdirSync(readOnly), [], "no placeholder may be left behind");
});

test("publishStagedFile retires its own reservation when the rename fails", (t) => {
  const h = harness(t);
  const stagingDirectory = join(h.workspace.projectDirectory, SESSION_NAME, "staging");
  mkdirSync(stagingDirectory, { recursive: true });
  const staging = join(stagingDirectory, "staged.jsonl");
  const final = join(h.threads, "final.jsonl");
  writeFileSync(staging, transcript());
  t.after(() => restorePermissions(stagingDirectory));
  chmodSync(stagingDirectory, 0o500); // a rename must unlink the staged name, so it fails here

  assert.throws(() => publishStagedFile(staging, final, () => {}), /could not publish the staged file/);
  assert.equal(existsSync(final), false, "the reserved destination must be retired again");
  chmodSync(stagingDirectory, 0o700);
  assert.equal(parsedCount(staging), 2, "the staged file still holds the only copy");
});

test("a verified fork is refused when the rewrite guard or the snapshot write rejects it", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace);
  const view = h.manager as unknown as {
    createTranscriptFork(args: { threadsDirectory: string }): { file: string; source: string; sourceEntries: number };
  };
  let made = 0;
  view.createTranscriptFork = ({ threadsDirectory }) => {
    made++;
    const file = join(threadsDirectory, `copy-${made}.jsonl`);
    writeFileSync(file, transcript());
    return { file, source: join(h.workspace.root, "a-source-this-thread-never-had.jsonl"), sourceEntries: 2 };
  };
  const foreign = thread(source);
  assert.throws(() => h.prepare(foreign), /the session-file rewrite guard refused the forked path/);
  assert.equal(foreign.sessionFile, source, "a refused rewrite leaves the record alone");

  view.createTranscriptFork = ({ threadsDirectory }) => {
    made++;
    const file = join(threadsDirectory, `copy-${made}.jsonl`);
    writeFileSync(file, transcript());
    return { file, source, sourceEntries: 2 };
  };
  (h.store as unknown as { pi: { appendEntry(): void } }).pi.appendEntry = () => {
    throw new Error("the snapshot could not be written");
  };
  const record = thread(source);
  assert.throws(() => h.prepare(record), /the verified fork could not be persisted: the snapshot could not be written/);
  assert.match(h.reports.join("\n"), /thread t7/);
});

test("an unsafe recorded transcript recovers from the retained source instead of stranding the thread", (t) => {
  const h = harness(t);
  const source = corpusSource(h.workspace, "nimble-shrew-0013", 3);
  const outside = join(h.workspace.root, "outside.jsonl");
  writeFileSync(outside, transcript());
  const unsafe = join(h.threads, "hardlinked.jsonl");
  linkSync(outside, unsafe); // containment refuses this, so the recorded path is unusable
  const record = thread(unsafe, { forkedFrom: source });

  const recovered = h.prepare(record);
  assert.ok(recovered);
  assert.notEqual(recovered, unsafe);
  assert.equal(parsedCount(recovered), 3);
  assert.equal(record.sessionFile, recovered);
  assert.equal(record.forkedFrom, source);
  assert.equal(existsSync(unsafe), true, "the unusable path is left exactly as it was");
});

test("SE95: the inspection byte bound is enforced while reading", (t) => {
  const h = harness(t);
  const big = join(h.threads, "big.jsonl");
  const filler = `${JSON.stringify({
    type: "message",
    id: "m",
    parentId: null,
    message: { role: "user", content: "x".repeat(900) },
  })}\n`;
  writeFileSync(big, transcript(1) + filler.repeat(220)); // roughly 200 KiB across several read chunks

  const limit = 100 * 1024;
  assert.ok(readFileSync(big).byteLength > limit, "the fixture must exceed the injected bound");
  assert.throws(
    () => inspectTranscriptPath(h.workspace.cwd, big, h.workspace.projectDirectory, limit),
    new RegExp(`exceeds the ${limit} byte inspection bound`),
  );
  assert.equal(
    inspectTranscriptPath(h.workspace.cwd, big, h.workspace.projectDirectory, GENEROUS_LIMIT).entries,
    221,
    "the same file passes under a generous bound, so the refusal is the bound and not the content",
  );
});
