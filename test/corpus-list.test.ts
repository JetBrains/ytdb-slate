import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CORPUS_LIST_AGGREGATE_BYTES,
  CORPUS_LIST_CELL_CHARS,
  CORPUS_LIST_COUNT_ENTRIES,
  CORPUS_LIST_FILE_BYTES,
  CORPUS_LIST_ROOT_ENTRIES,
  CORPUS_LIST_ROW_ENTRIES,
  CORPUS_LIST_SESSION_ENTRIES,
  corpusListCell,
  listCorpusSessions,
} from "../extension/corpus-list.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCorpusSession } from "../extension/corpus.ts";
import { writeCorpusHandoffRecord, type CorpusHandoffRecord } from "../extension/handoff-record.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";

const ID1 = "20260821T010203Z-0123456789abcdef";
const ID2 = "20260821T010204Z-0123456789abcdef";

function box() {
  const root = mkdtempSync(join(tmpdir(), "slate-corpus-list."));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agent);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const session = createCorpusSession({ cwd, identity: ID1, initialNameBytes: Uint8Array.from([0, 0, 0, 1]), now: new Date("2026-08-21T01:02:03.004Z") });
  return {
    root, cwd, session,
    list(limits = {}) { return listCorpusSessions({ cwd, project: session.project, isTrusted: () => true, limits }); },
    close() {
      if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = old;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function metadata(name: string, identity = ID2, overrides: Record<string, unknown> = {}) {
  return {
    identity,
    name,
    createdAt: "2026-08-21T01:02:03.004Z",
    worktreePath: "/outside/worktree",
    branchLabel: "main",
    ...overrides,
  };
}

function addSession(project: string, name: string, raw: unknown): string {
  const directory = join(project, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "session.json"), typeof raw === "string" ? raw : JSON.stringify(raw));
  return directory;
}

function output(result: ReturnType<typeof listCorpusSessions>): string {
  assert.equal(result.ok, true);
  return result.ok ? result.lines.join("\n") : "";
}

test("listing constants pin every approved production bound", () => {
  assert.deepEqual([
    CORPUS_LIST_ROOT_ENTRIES,
    CORPUS_LIST_ROW_ENTRIES,
    CORPUS_LIST_COUNT_ENTRIES,
    CORPUS_LIST_FILE_BYTES,
    CORPUS_LIST_AGGREGATE_BYTES,
    CORPUS_LIST_SESSION_ENTRIES,
    CORPUS_LIST_CELL_CHARS,
  ], [4096, 4096, 65536, 65536, 4 * 1024 * 1024, 64, 240]);
});

test("trust runs before corpus access and root overflow refuses every row", () => {
  let trusted = false;
  const denied = listCorpusSessions({ cwd: "/missing", isTrusted: () => { trusted = true; return false; } });
  assert.equal(trusted, true);
  assert.deepEqual(denied, { ok: false, reason: "slate: corpus session listing requires a trusted project" });

  const b = box();
  try {
    mkdirSync(join(b.session.project.root, "unrelated-one"));
    const accepted = b.list({ rootEntries: 2 });
    assert.equal(accepted.ok, true);
    mkdirSync(join(b.session.project.root, "unrelated-two"));
    const refused = b.list({ rootEntries: 2 });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /more than 2 entries/);
  } finally { b.close(); }
});

test("project overflow reports exact and at-least omitted counts without retaining rows", () => {
  const b = box();
  try {
    for (let i = 0; i < 4; i++) writeFileSync(join(b.session.project.directory, `junk-${i}`), "x");
    const exact = b.list({ rowEntries: 3, countEntries: 8 });
    assert.match(output(exact), /listing truncated: read 3 entries\. Did not read 2 entries/);
    const singular = b.list({ rowEntries: 4, countEntries: 8 });
    assert.match(output(singular), /listing truncated: read 4 entries\. Did not read 1 entry/);
    const bounded = b.list({ rowEntries: 2, countEntries: 2 });
    assert.match(output(bounded), /listing truncated: read 2 entries\. Did not read at least 2 entries/);
  } finally { b.close(); }
});

test("metadata validation, duplicate identities, foreign marker, and pending states are explicit", () => {
  const b = box();
  try {
    const duplicateName = "calm-otter-0002";
    addSession(b.session.project.directory, duplicateName, metadata(duplicateName, ID1, {
      branchLabel: `evil\u2028row\u2029tail\u0000`,
      createdAt: "2026-08-21T01:02:03Z",
      extra: "must-not-display",
    }));
    const malformedName = "calm-otter-0003";
    addSession(b.session.project.directory, malformedName, metadata(malformedName, "", { worktreePath: 4 }));
    mkdirSync(join(b.session.project.directory, "pending"));
    writeFileSync(join(b.session.project.directory, "pending", `${malformedName}.json`), "not json");
    const linkedName = "calm-otter-0004";
    symlinkSync(b.session.directory, join(b.session.project.directory, linkedName));

    const text = output(b.list());
    assert.equal(text.includes("\u2028"), false);
    assert.equal(text.includes("\u2029"), false);
    assert.equal(text.includes("\u0000"), false);
    assert.equal(text.includes("must-not-display"), false);
    assert.equal((text.match(/duplicate session identity/g) ?? []).length, 2);
    assert.match(text, /creation time is invalid/);
    assert.match(text, /worktreePath has the wrong type/);
    assert.match(text, /identity is empty/);
    assert.match(text, /pending unreadable/);
    assert.match(text, /symbolic link/);
    assert.match(text, /session started outside this working tree/);
    assert.match(text, /Sequential best-effort reading/);
    assert.match(text, /No line describes a single instant/);
  } finally { b.close(); }
});

test("every malformed metadata shape becomes a row and does not hide healthy sessions", () => {
  const b = box();
  try {
    const cases: Array<[string, unknown]> = [
      ["calm-otter-0010", "{"],
      ["calm-otter-0011", []],
      ["calm-otter-0012", null],
      ["calm-otter-0013", metadata("calm-otter-0013", ID2, { identity: 1, name: 2, createdAt: 3, worktreePath: 4, branchLabel: 5, piSessionName: 6 })],
      ["calm-otter-0014", metadata("different-name")],
      ["calm-otter-0015", metadata("calm-otter-0015", "invalid")],
    ];
    for (const [name, raw] of cases) addSession(b.session.project.directory, name, raw);
    const missing = join(b.session.project.directory, "calm-otter-0016");
    mkdirSync(missing);
    const text = output(b.list());
    assert.match(text, /metadata is malformed/);
    assert.match(text, /metadata is not an object/);
    for (const field of ["identity", "name", "createdAt", "worktreePath", "branchLabel", "piSessionName"]) assert.match(text, new RegExp(`${field} has the wrong type`));
    assert.match(text, /metadata name does not match/);
    assert.match(text, /identity is invalid/);
    assert.match(text, /session metadata is unreadable/);
    assert.equal((text.match(/^-/gm) ?? []).length, cases.length + 2);
  } finally { b.close(); }
});

test("missing project state and a disappeared matching project refuse the whole run", () => {
  const b = box();
  try {
    const unavailable = listCorpusSessions({ cwd: b.cwd, isTrusted: () => true });
    assert.deepEqual(unavailable, { ok: false, reason: "slate: corpus project is unavailable" });
    rmSync(b.session.project.directory, { recursive: true });
    const missing = b.list();
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /could not be resolved/);
  } finally { b.close(); }
});

test("a session started in a checkout subdirectory is not foreign under an inherited Git directory", () => {
  const b = box();
  const oldGitDir = process.env.GIT_DIR;
  const oldGitWorkTree = process.env.GIT_WORK_TREE;
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: b.cwd }).status, 0);
    const sub = join(b.cwd, "nested");
    mkdirSync(sub);
    const raw = JSON.parse(readFileSync(join(b.session.directory, "session.json"), "utf8"));
    raw.worktreePath = b.cwd;
    writeFileSync(join(b.session.directory, "session.json"), JSON.stringify(raw));
    process.env.GIT_DIR = join(b.cwd, ".git");
    process.env.GIT_WORK_TREE = sub;
    const listed = listCorpusSessions({ cwd: sub, project: b.session.project, isTrusted: () => true });
    const line = output(listed).split("\n").find((value) => value.startsWith(`- ${b.session.name}`));
    assert.ok(line);
    assert.equal(line.includes("outside this working tree"), false);
  } finally {
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
    if (oldGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = oldGitWorkTree;
    b.close();
  }
});

test("project directory identity changes before or during the scan refuse every row", () => {
  for (const seam of ["afterProjectDirectoryOpen", "beforeProjectDirectoryFinalCheck"] as const) {
    const b = box();
    try {
      const moved = `${b.session.project.directory}-moved`;
      const listed = listCorpusSessions({
        cwd: b.cwd,
        project: b.session.project,
        isTrusted: () => true,
        [seam]() {
          renameSync(b.session.project.directory, moved);
          mkdirSync(b.session.project.directory);
        },
      });
      assert.deepEqual(listed, { ok: false, reason: "slate: corpus project directory identity changed during listing" });
    } finally { b.close(); }
  }
});

test("metadata growth after the held-descriptor size check produces a defect row", () => {
  const b = box();
  try {
    const file = join(b.session.directory, "session.json");
    let injected = false;
    const listed = listCorpusSessions({
      cwd: b.cwd,
      project: b.session.project,
      isTrusted: () => true,
      afterMetadataSizeCheck(path) {
        if (path !== file || injected) return;
        injected = true;
        appendFileSync(path, " ".repeat(CORPUS_LIST_FILE_BYTES + 1 - statSync(path).size));
      },
    });
    assert.equal(injected, true);
    const line = output(listed).split("\n").find((value) => value.startsWith(`- ${b.session.name}`));
    assert.match(line ?? "", /session metadata is unreadable: file is larger than 65536 bytes/);
    assert.match(line ?? "", /identity \(invalid\)/);
  } finally { b.close(); }
});

test("file and session-directory ceilings accept the boundary and defect one beyond it", () => {
  const b = box();
  try {
    const file = join(b.session.directory, "session.json");
    const raw = JSON.stringify(metadata(b.session.name, ID1, { worktreePath: b.cwd }));
    writeFileSync(file, `${raw}${" ".repeat(CORPUS_LIST_FILE_BYTES - Buffer.byteLength(raw))}`);
    for (let i = readdirSync(b.session.directory).length; i < CORPUS_LIST_SESSION_ENTRIES; i++) writeFileSync(join(b.session.directory, `entry-${i}`), "");
    let line = output(b.list()).split("\n").find((value) => value.startsWith(`- ${b.session.name}`));
    assert.ok(line);
    assert.match(line, new RegExp(`identity ${ID1}`));
    assert.equal(line.includes("session metadata is unreadable"), false);
    assert.equal(line.includes("more than 64"), false);
    writeFileSync(join(b.session.directory, "entry-65"), "");
    line = output(b.list()).split("\n").find((value) => value.startsWith(`- ${b.session.name}`));
    assert.ok(line?.includes("more than 64 entries"));
    writeFileSync(file, "x".repeat(CORPUS_LIST_FILE_BYTES + 1));
    assert.match(output(b.list()), /larger than 65536 bytes/);
  } finally { b.close(); }
});

test("one session entry read failure yields a defect row and the report continues", (t) => {
  const b = box();
  const original = fs.lstatSync;
  try {
    t.mock.method(fs, "lstatSync", ((path: fs.PathLike, options?: unknown) => {
      if (String(path) === b.session.directory) throw new Error("injected entry failure");
      return original(path, options as never);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    const listed = b.list();
    const text = output(listed);
    assert.match(text, new RegExp(`${b.session.name}.*session entry read failed: injected entry failure`));
    assert.match(text, /Sequential best-effort reading/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    b.close();
  }
});

test("a project directory read failure refuses the whole report", (t) => {
  const b = box();
  const original = fs.opendirSync;
  try {
    t.mock.method(fs, "opendirSync", ((path: fs.PathLike, options?: fs.OpenDirOptions) => {
      if (String(path) === b.session.project.directory) throw new Error("injected project failure");
      return original(path, options);
    }) as typeof fs.opendirSync);
    syncBuiltinESMExports();
    const listed = b.list();
    assert.deepEqual(listed, { ok: false, reason: "slate: could not read the corpus project directory: injected project failure" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    b.close();
  }
});

test("two project directories with one digest refuse the whole report", () => {
  const b = box();
  try {
    mkdirSync(join(b.session.project.root, `duplicate-${b.session.project.digest}`));
    const listed = b.list();
    assert.deepEqual(listed, { ok: false, reason: "slate: several corpus project directories match this project" });
  } finally { b.close(); }
});

test("aggregate metadata accepts its boundary and refuses one byte beyond without rows", () => {
  const b = box();
  try {
    const firstBytes = statSync(join(b.session.directory, "session.json")).size;
    const secondName = "calm-otter-0005";
    addSession(b.session.project.directory, secondName, metadata(secondName));
    const secondBytes = statSync(join(b.session.project.directory, secondName, "session.json")).size;
    assert.equal(b.list({ aggregateBytes: firstBytes + secondBytes }).ok, true);
    const refused = b.list({ aggregateBytes: firstBytes + secondBytes - 1 });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /aggregate bytes/);
  } finally { b.close(); }
});

test("a valid pending record contributes to the aggregate boundary", () => {
  const b = box();
  try {
    const record: CorpusHandoffRecord = {
      version: 1,
      author: { identity: ID1, name: b.session.name },
      authorSessionDirectory: b.session.directory,
      createdAt: 1,
      worktreePath: b.cwd,
      branchLabel: "",
      parentChain: [],
      brief: "continue",
      snapshot: {
        threads: [], episodes: [], orchestratorMode: false, paused: false,
        workerCostUsd: 0, carriedCostUsd: 0, slateSessionId: ID1, slateSessionName: b.session.name,
      },
    };
    writeCorpusHandoffRecord(b.session.project, record);
    const metadataBytes = statSync(join(b.session.directory, "session.json")).size;
    const pendingBytes = statSync(join(b.session.project.directory, "pending", `${b.session.name}.json`)).size;
    assert.equal(b.list({ aggregateBytes: metadataBytes + pendingBytes }).ok, true);
    assert.equal(b.list({ aggregateBytes: metadataBytes + pendingBytes - 1 }).ok, false);
  } finally { b.close(); }
});

test("pending bytes alone can breach the aggregate bound and refuse every row", () => {
  const b = box();
  try {
    const metadataBytes = statSync(join(b.session.directory, "session.json")).size;
    const pending = join(b.session.project.directory, "pending");
    mkdirSync(pending);
    writeFileSync(join(pending, `${b.session.name}.json`), "not valid json");
    const refused = b.list({ aggregateBytes: metadataBytes });
    assert.deepEqual(refused, { ok: false, reason: `slate: session metadata exceeds ${metadataBytes} aggregate bytes` });
  } finally { b.close(); }
});

test("pending files above the ceiling and linked pending paths are unreadable", () => {
  const b = box();
  try {
    const pending = join(b.session.project.directory, "pending");
    mkdirSync(pending);
    writeFileSync(join(pending, `${b.session.name}.json`), "x".repeat(CORPUS_LIST_FILE_BYTES + 1));
    assert.match(output(b.list()), /pending unreadable.*larger than 65536 bytes/);
    rmSync(pending, { recursive: true });
    const outside = join(b.root, "outside-pending");
    mkdirSync(outside);
    writeFileSync(join(outside, `${b.session.name}.json`), "{}");
    symlinkSync(outside, pending);
    assert.match(output(b.list()), /pending unreadable.*not a real directory/);
  } finally { b.close(); }
});

test("valid pending records are present and their derived names need no scan", () => {
  const b = box();
  try {
    const record: CorpusHandoffRecord = {
      version: 1,
      author: { identity: ID1, name: b.session.name },
      authorSessionDirectory: b.session.directory,
      createdAt: 1,
      worktreePath: b.cwd,
      branchLabel: "",
      parentChain: [],
      brief: "continue",
      snapshot: {
        threads: [], episodes: [], orchestratorMode: false, paused: false,
        workerCostUsd: 0, carriedCostUsd: 0, slateSessionId: ID1, slateSessionName: b.session.name,
      },
    };
    writeCorpusHandoffRecord(b.session.project, record);
    writeFileSync(join(b.session.project.directory, "pending", "unrelated.json"), "bad");
    assert.match(output(b.list()), new RegExp(`${b.session.name}.*pending present`));
  } finally { b.close(); }
});

test("the row-cell cap strips unsafe categories and cannot collide valid session identifiers", () => {
  const left = `calm-otter-${"a".repeat(4)}`;
  const right = `calm-otter-${"b".repeat(4)}`;
  assert.notEqual(corpusListCell(left), corpusListCell(right));
  assert.equal(corpusListCell(`a\u0000\u2028\u2029\u200fb`), "a b");
  const long = corpusListCell("x".repeat(1000));
  assert.equal(long.length, CORPUS_LIST_CELL_CHARS);
  assert.equal(long.endsWith("…"), true);
});

test("the registered sessions subcommand reports success and trust refusal through the command channel", async (t) => {
  const b = box();
  try {
    let command: { handler(args: string, ctx: ExtensionContext): Promise<void> } | undefined;
    const pi = {
      registerCommand(_name: string, value: typeof command) { command = value; },
      on() {},
      getActiveTools() { return []; },
      getAllTools() { return []; },
      setActiveTools() {},
    } as unknown as ExtensionAPI;
    const store = new SlateStore(pi);
    store.corpusProject = b.session.project;
    registerSlateMode(
      pi,
      store,
      { startHandoff: async () => {}, adoptHandoff: async () => false, effectiveContextBudget: (window: number) => window },
      () => ({}),
      () => EMPTY_WORKER_EXTENSION_SET,
    );
    assert.ok(command);
    const notices: Array<[string, string]> = [];
    let trusted = true;
    const ctx = {
      cwd: b.cwd,
      hasUI: true,
      isProjectTrusted: () => trusted,
      ui: { notify: (message: string, level: string) => notices.push([message, level]) },
    } as unknown as ExtensionContext;
    t.mock.method(console, "warn", () => {});
    await command.handler("sessions", ctx);
    assert.equal(notices.at(-1)?.[1], "info");
    assert.match(notices.at(-1)?.[0] ?? "", /corpus sessions/);
    assert.match(notices.at(-1)?.[0] ?? "", /branch \(unknown\)/);
    for (let i = 0; i < 30; i++) {
      const name = `calm-otter-${String(i + 100).padStart(4, "0")}`;
      addSession(b.session.project.directory, name, metadata(name, ID2, {
        branchLabel: "b".repeat(1000),
        worktreePath: `/outside/${"w".repeat(1000)}`,
      }));
    }
    await command.handler("sessions", ctx);
    assert.equal(notices.at(-1)?.[0].length, 16_384);
    assert.match(notices.at(-1)?.[0] ?? "", /\[output truncated at 16384 characters\]$/);
    trusted = false;
    await command.handler("sessions", ctx);
    assert.deepEqual(notices.at(-1), ["slate: corpus session listing requires a trusted project", "warning"]);
  } finally { b.close(); }
});

test("listing performs no write, rename, creation, or removal", () => {
  const b = box();
  try {
    const before = readdirSync(b.session.project.directory).sort();
    const metadataBefore = readFileSync(join(b.session.directory, "session.json"));
    const mtimeBefore = statSync(join(b.session.directory, "session.json")).mtimeMs;
    assert.equal(b.list().ok, true);
    assert.deepEqual(readdirSync(b.session.project.directory).sort(), before);
    assert.deepEqual(readFileSync(join(b.session.directory, "session.json")), metadataBefore);
    assert.equal(statSync(join(b.session.directory, "session.json")).mtimeMs, mtimeBefore);
  } finally { b.close(); }
});
