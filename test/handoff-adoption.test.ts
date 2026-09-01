import assert from "node:assert/strict";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { currentBranchLabel, resolveCorpusProject, type CorpusProject } from "../extension/corpus.ts";
import {
  corpusHandoffFile,
  DEFAULT_HANDOFF_DURABILITY_OPERATIONS,
  fsyncHeldDirectory,
  handoffTreeWithinDepth,
  holdDirectory,
  listCorpusHandoffCandidates,
  readCorpusHandoffRecord,
  writeCorpusHandoffRecord,
  type CorpusHandoffRecord,
} from "../extension/handoff-record.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import {
  activateSlateStorage,
  createRuntimeAuthorityBackend,
  SLATE_BINDING_CUSTOM_TYPE,
} from "../extension/runtime-authority.ts";
import { createDurableSession, updateDurableSession, type CanonicalSlateRuntime } from "../extension/session-record.ts";
import { SlateStore, type SlateSessionParent, type ThreadRecord } from "../extension/state.ts";

const SOURCE_ID = "20260820T010203Z-0123456789abcdef";
const SOURCE_NAME = "calm-otter-7f3a";
const SOURCE_OWNER = "a".repeat(64);
const RECEIVER_OWNER = "b".repeat(64);

function thread(id: string): ThreadRecord {
  return { id, name: id, status: "failed", type: "general", outcomeReason: "stopped", createdAt: 1, updatedAt: 2 };
}

function runtime(overrides: Partial<CanonicalSlateRuntime> = {}): CanonicalSlateRuntime {
  return {
    threads: [], episodes: [], threadSeq: 0, slateSessionParentChain: [],
    orchestratorMode: true, paused: true, workerCostUsd: 5, carriedCostUsd: 2,
    ...overrides,
  };
}

interface Box {
  root: string;
  cwd: string;
  project: CorpusProject;
  directory: string;
  record: CorpusHandoffRecord;
}

function box(t: TestContext, options: { runtime?: Partial<CanonicalSlateRuntime>; parents?: SlateSessionParent[] } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), "slate-handoff-adoption."));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agent);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const project = resolveCorpusProject(cwd);
  const parents = options.parents ?? [];
  const created = createDurableSession({
    cwd,
    project,
    identity: SOURCE_ID,
    name: SOURCE_NAME,
    creatorSessionDigest: SOURCE_OWNER,
    runtime: runtime({ slateSessionParentChain: parents, ...options.runtime }),
  });
  const record: CorpusHandoffRecord = {
    version: 1,
    author: { identity: SOURCE_ID, name: SOURCE_NAME },
    authorSessionDirectory: created.directory,
    createdAt: Date.now(),
    worktreePath: cwd,
    branchLabel: currentBranchLabel(cwd),
    parentChain: parents,
    brief: "Continue the verified work.",
    carriedCostUsd: 7,
  };
  writeCorpusHandoffRecord(project, record);
  return { root, cwd, project, directory: created.directory, record };
}

function overwrite(b: Box, value: unknown): void {
  writeFileSync(corpusHandoffFile(b.project, SOURCE_NAME), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

function receiver(b: Box, options: {
  refusing?: boolean;
  model?: { provider: string; id: string };
  foundModel?: { provider: string; id: string };
  thinking?: string;
  events?: string[];
  failModelSwitch?: boolean;
  failThinkingSwitch?: boolean;
  failUpdate?: boolean;
  pauseThresholdPercent?: number;
  contextBudget?: { tokens: number };
  contextUsage?: { percent?: number; tokens?: number; contextWindow?: number };
  orchestratorMode?: boolean;
  hasUI?: boolean;
} = {}) {
  const entries: Array<{ type: "custom"; customType: string; data: Record<string, unknown> }> = [];
  const messages: Array<{ customType?: string; content?: string }> = [];
  const notifications: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const switches: string[] = [];
  const efforts: string[] = [];
  const adopted: Array<{ model: string; effort: unknown }> = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
    appendEntry(customType: string, data: Record<string, unknown>) {
      options.events?.push("save");
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: { customType?: string; content?: string }) {
      options.events?.push(message.customType === "slate-kickoff" ? "kickoff" : "message");
      messages.push(message);
    },
    getThinkingLevel: () => efforts.at(-1) ?? options.thinking,
    async setModel(model: { provider: string; id: string }) {
      switches.push(`${model.provider}/${model.id}`);
      options.events?.push("model");
      if (options.failModelSwitch === true) throw new Error("forced model switch failure");
      return true;
    },
    setThinkingLevel(level: string) {
      efforts.push(level);
      options.events?.push("effort");
      if (options.failThinkingSwitch === true) throw new Error("forced thinking switch failure");
    },
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  if (options.refusing) store.refuseRuntimeAuthority("forced startup refusal");
  else activateSlateStorage({
    store,
    session: {
      key: "receiver", cwd: b.cwd, sessionDigest: RECEIVER_OWNER, project: b.project,
      entries, branch: entries,
    },
    backend: createRuntimeAuthorityBackend(pi, {
      branch: () => entries,
      ...(options.failUpdate === true ? {
        durable: { beforeStatePublish() { throw new Error("forced receiving update failure"); } },
      } : {}),
    }),
    report: () => {},
  });
  if (options.orchestratorMode !== undefined) store.orchestratorMode = options.orchestratorMode;
  const tracker = {
    async ownSwitch<T>(_from: string | undefined, _to: string, perform: () => Promise<T>): Promise<T> { return perform(); },
    adopt(model: string, effort: unknown) { adopted.push({ model, effort }); },
  } as unknown as BaseModelTracker;
  const hooks = registerSlateHandoff(pi, store, () => ({
    preserveGlobalModelDefault: false,
    pauseThresholdPercent: options.pauseThresholdPercent,
    contextBudget: options.contextBudget,
  }), () => tracker);
  const ctx = {
    cwd: b.cwd,
    hasUI: options.hasUI ?? false,
    ui: { notify(message: string) { notifications.push(message); } },
    isProjectTrusted: () => true,
    model: options.model,
    modelRegistry: { find: () => options.foundModel },
    getContextUsage: () => options.contextUsage,
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => entries, getEntries: () => entries },
  } as unknown as ExtensionCommandContext;
  return { adopted, ctx, efforts, entries, handlers, hooks, messages, notifications, store, switches };
}

const noModeChange = () => () => {};

test("handoff records carry only coordination data and a dedicated cost", (t) => {
  const b = box(t);
  const file = corpusHandoffFile(b.project, SOURCE_NAME);
  const wire = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(wire.version, 2);
  assert.equal(wire.carriedCostUsd, 7);
  assert.equal(Object.hasOwn(wire, "snapshot"), false);
  const read = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.record.carriedCostUsd, 7);

  overwrite(b, { ...b.record, snapshot: { threads: [] } });
  assert.equal(readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true }).ok, false);
  for (const carriedCostUsd of [-1, Number.NaN, "7", undefined]) {
    const candidate = { ...b.record, carriedCostUsd } as Record<string, unknown>;
    if (carriedCostUsd === undefined) delete candidate.carriedCostUsd;
    overwrite(b, candidate);
    assert.equal(readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true }).ok, false);
  }
});

test("adoption reads every record from the namespace and keeps carried cost", async (t) => {
  const b = box(t, { runtime: { threads: [thread("t1")], threadSeq: 1 } });
  const before = readFileSync(join(b.directory, "state.json"));
  const h = receiver(b);
  assert.equal(await h.hooks.adoptHandoff(h.ctx, SOURCE_NAME, noModeChange), true);
  assert.deepEqual([...h.store.threads.keys()], ["t1"]);
  assert.equal(h.store.workerCostUsd, 5);
  assert.equal(h.store.carriedCostUsd, 7);
  assert.equal(h.store.slateSessionId, SOURCE_ID);
  assert.equal(h.store.ownerSessionDigest, RECEIVER_OWNER);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0]?.customType, SLATE_BINDING_CUSTOM_TYPE);
  assert.equal(h.messages[0]?.customType, "slate-kickoff");
  const after = readFileSync(join(b.directory, "state.json"));
  assert.notDeepEqual(after, before);
  assert.deepEqual(JSON.parse(after.toString()).runtime.threads.map((item: ThreadRecord) => item.id), ["t1"]);
});

test("the handoff record cannot replace newer namespace records", async (t) => {
  const b = box(t);
  updateDurableSession({
    project: b.project,
    cwd: b.cwd,
    identity: SOURCE_ID,
    name: SOURCE_NAME,
    writerSessionDigest: SOURCE_OWNER,
    runtime: runtime({ threads: [thread("t2")], threadSeq: 2 }),
  });
  const h = receiver(b);
  assert.equal(await h.hooks.adoptHandoff(h.ctx, SOURCE_NAME, noModeChange), true);
  assert.deepEqual([...h.store.threads.keys()], ["t2"]);
});

test("a stopped adoption loses no namespace record and writes no locator", async (t) => {
  const b = box(t, { runtime: { threads: [thread("t1")], threadSeq: 1 } });
  const before = readFileSync(join(b.directory, "state.json"));
  rmSync(join(b.directory, "threads"), { recursive: true });
  const h = receiver(b);
  assert.equal(await h.hooks.adoptHandoff(h.ctx, SOURCE_NAME, noModeChange), false);
  assert.deepEqual(h.entries, []);
  assert.deepEqual(readFileSync(join(b.directory, "state.json")), before);
});

test("adoption refuses trust, a refusing store, and malformed records before changing state", { timeout: 20_000 }, async (t) => {
  const b = box(t);
  overwrite(b, "{broken");
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
  const h = receiver(b);
  const untrusted = { ...h.ctx, isProjectTrusted: () => false } as ExtensionCommandContext;
  assert.equal(await h.hooks.adoptHandoff(untrusted, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /requires a trusted project/);
  assert.equal(h.entries.length, 0);
  warnings.length = 0;
  const refusing = receiver(b, { refusing: true });
  assert.equal(await refusing.hooks.adoptHandoff(refusing.ctx, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /selected no storage/);
  assert.equal(refusing.entries.length, 0);
  // THE MALFORMED RECORD ITSELF (TQ1504). The two refusals above return before the
  // reader parses anything, so only a trusted session with a prepared namespace
  // reaches the parse, and that is the case this test claimed to cover.
  warnings.length = 0;
  assert.equal(await h.hooks.adoptHandoff(h.ctx, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /malformed handoff JSON/);
  assert.equal(h.entries.length, 0);
  assert.equal(h.store.authorityState().kind, "fresh");
});

test("adoption keeps namespace lineage", async (t) => {
  const parents = [{ identity: "20260819T010203Z-fedcba9876543210", name: "brisk-bison-abcd" }];
  const b = box(t, { parents });
  const h = receiver(b);
  assert.equal(await h.hooks.adoptHandoff(h.ctx, SOURCE_NAME, noModeChange), true);
  assert.deepEqual(h.store.slateSessionParentChain, parents);
});

test("model restoration follows the receiving save", { timeout: 20_000 }, async (t) => {
  const events: string[] = [];
  const b = box(t);
  overwrite(b, { ...b.record, model: { provider: "p", id: "target" }, thinkingLevel: "high" });
  const h = receiver(b, {
    model: { provider: "p", id: "other" }, foundModel: { provider: "p", id: "target" },
    thinking: "low", events,
  });
  assert.equal(await h.hooks.adoptHandoff(h.ctx, SOURCE_NAME, noModeChange), true);
  assert.deepEqual(h.switches, ["p/target"]);
  assert.deepEqual(h.efforts, ["high"]);
  assert.deepEqual(h.adopted, [
    { model: "p/target", effort: "low" },
    { model: "p/target", effort: "high" },
  ]);
  assert.deepEqual(events, ["save", "model", "effort", "kickoff"]);
});

test("candidate listing stays bounded and never adopts", (t) => {
  const b = box(t);
  const listed = listCorpusHandoffCandidates({ cwd: b.cwd, isTrusted: () => true });
  assert.equal(listed.ok, true);
  if (listed.ok) assert.deepEqual(listed.candidates.map((item) => item.name), [SOURCE_NAME]);
  const pending = join(b.project.directory, "pending");
  rmSync(pending, { recursive: true });
  mkdirSync(pending);
  for (let index = 0; index < 65; index++) {
    writeFileSync(join(pending, `calm-otter-${index.toString(16).padStart(4, "0")}.json`), "{}");
  }
  assert.equal(listCorpusHandoffCandidates({ cwd: b.cwd, isTrusted: () => true }).ok, false);
});

test("record publication and reading reject changing directories", (t) => {
  const b = box(t);
  const pending = join(b.project.directory, "pending");
  const moved = join(b.project.directory, "pending-moved");
  const result = readCorpusHandoffRecord({
    cwd: b.cwd,
    name: SOURCE_NAME,
    isTrusted: () => true,
    afterPendingOpen() { renameSync(pending, moved); mkdirSync(pending); },
  });
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(moved, `${SOURCE_NAME}.json`)), true);
});

test("wire encoding preserves long coordination strings", (t) => {
  const b = box(t);
  const record = { ...b.record, brief: `brief:${"λ".repeat(5000)}:\ud800` };
  writeCorpusHandoffRecord(b.project, record);
  const wire = JSON.parse(readFileSync(corpusHandoffFile(b.project, SOURCE_NAME), "utf8")) as { brief: unknown };
  assert.equal(Array.isArray(wire.brief), true);
  const read = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.record.brief, record.brief);
});

test("tree depth remains bounded", () => {
  assert.equal(handoffTreeWithinDepth([[[[[[[[true]]]]]]]]), true);
  assert.equal(handoffTreeWithinDepth([[[[[[[[[true]]]]]]]]]), false);
});

// ---------------------------------------------------------- restored coverage --
//
// The Track 14 rewrite of this file dropped safety cases that still apply to the
// current record format, the current reader and the current adoption command
// (TQ1503). Accepted risk 4 of the design names exactly this hazard. The cases
// below cover those classes again against the current interfaces: the size,
// wire-schema and lineage bounds of the reader, the frozen durability
// operations, descriptor and staging discipline of the writer, the listing
// bounds, and the refusals and reports of the adoption command.

test("the 1 MiB boundary is checked before parsing", (t) => {
  const b = box(t);
  const file = corpusHandoffFile(b.project, SOURCE_NAME);
  const valid = readFileSync(file, "utf8").trim();
  assert.ok(Buffer.byteLength(valid, "utf8") < 1024 * 1024);
  writeFileSync(file, valid + " ".repeat(1024 * 1024 - Buffer.byteLength(valid, "utf8")));
  assert.equal(readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true }).ok, true);

  writeFileSync(file, valid + " ".repeat(1024 * 1024 + 1 - Buffer.byteLength(valid, "utf8")));
  const oversized = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.reason, /larger than 1 MiB/);
});

test("the version 2 wire refuses invalid UTF-8, malformed chunks, unknown fields, and excessive depth", (t) => {
  const b = box(t);
  const file = corpusHandoffFile(b.project, SOURCE_NAME);
  const original = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

  writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]));
  const invalidUtf8 = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(invalidUtf8.ok, false);
  if (!invalidUtf8.ok) assert.match(invalidUtf8.reason, /not valid UTF-8/);

  const mutations: Array<[string, (wire: Record<string, unknown>) => void]> = [
    ["one chunk", (wire) => { wire.brief = ["only"]; }],
    ["empty chunk", (wire) => { wire.brief = ["a", ""]; }],
    ["nested chunk", (wire) => { wire.brief = ["a", ["b"]]; }],
    ["non-string chunk", (wire) => { wire.brief = ["a", 2]; }],
    ["oversized segment", (wire) => { wire.brief = ["x".repeat(8193), "z"]; }],
    ["root unknown", (wire) => { wire.unknown = true; }],
    ["author unknown", (wire) => { (wire.author as Record<string, unknown>).unknown = true; }],
    ["parent unknown", (wire) => { wire.parentChain = [{ identity: ["20260819T010203Z-fedcba9876543210"], name: ["brisk-bison-abcd"], unknown: 1 }]; }],
    ["depth", (wire) => { wire.carriedCostUsd = [[[[[[[[[1]]]]]]]]]; }],
  ];
  for (const [label, mutate] of mutations) {
    const wire = structuredClone(original);
    mutate(wire);
    writeFileSync(file, JSON.stringify(wire));
    const result = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.match(result.reason, /version 2 handoff record that does not match its wire schema or bounds/, label);
  }
});

test("the parent chain accepts and adopts 256 ancestors, then refuses one more", async (t) => {
  const parents = Array.from({ length: 256 }, (_, index) => ({
    identity: `20260819T010203Z-${index.toString(16).padStart(16, "0")}`,
    name: `brisk-bison-${index.toString(16).padStart(4, "0")}`,
  }));
  const b = box(t, { parents });
  writeCorpusHandoffRecord(b.project, { ...b.record, parentChain: parents });
  assert.equal(readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true }).ok, true);
  const h = receiver(b);
  assert.equal(await h.hooks.adoptHandoff(h.ctx, SOURCE_NAME, noModeChange), true);
  assert.deepEqual(h.store.slateSessionParentChain, parents);

  const overflow = [...parents, { identity: "20260819T010203Z-ffffffffffffffff", name: "brisk-bison-ffff" }];
  assert.throws(() => writeCorpusHandoffRecord(b.project, { ...b.record, parentChain: overflow }));
  const wire = JSON.parse(readFileSync(corpusHandoffFile(b.project, SOURCE_NAME), "utf8")) as Record<string, unknown>;
  wire.parentChain = overflow.map((parent) => ({ identity: parent.identity, name: parent.name }));
  writeFileSync(corpusHandoffFile(b.project, SOURCE_NAME), JSON.stringify(wire));
  const refused = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /schema or bounds/);
});

test("record reads reject invalid names, malformed JSON, and mismatched source metadata", (t) => {
  const b = box(t);
  const invalidName = readCorpusHandoffRecord({ cwd: b.cwd, name: "../escape", isTrusted: () => true });
  assert.equal(invalidName.ok, false);
  if (!invalidName.ok) assert.match(invalidName.reason, /invalid handoff session name/);

  overwrite(b, "{broken");
  const malformed = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.reason, /malformed handoff JSON/);

  overwrite(b, { ...b.record, authorSessionDirectory: join(b.project.directory, "brisk-bison-abcd") });
  const unexpected = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(unexpected.ok, false);
  if (!unexpected.ok) assert.match(unexpected.reason, /unexpected author session directory/);

  rmSync(b.directory, { recursive: true });
  overwrite(b, b.record);
  const missing = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /missing or linked author session directory/);
});

test("production handoff durability defaults are the real frozen fsync operations", () => {
  assert.equal(Object.isFrozen(DEFAULT_HANDOFF_DURABILITY_OPERATIONS), true);
  assert.equal(DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncFile, fsyncSync);
  assert.equal(DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncDirectory, fsyncHeldDirectory);
});

test("a failed directory status query closes its descriptor", (t) => {
  const b = box(t);
  const descriptorDirectory = "/proc/self/fd";
  if (process.platform !== "linux" || !existsSync(descriptorDirectory)) {
    t.skip("/proc/self/fd is unavailable");
    return;
  }
  const before = readdirSync(descriptorDirectory).length;
  const failure = Object.assign(new Error("injected status query failure"), { code: "EIO" });
  for (let attempt = 0; attempt < 32; attempt++) {
    assert.throws(
      () => holdDirectory(b.project.directory, () => { throw failure; }),
      (error) => error === failure,
    );
  }
  assert.equal(readdirSync(descriptorDirectory).length, before);
});

test("write closes the pending directory when the staging directory hold fails", (t) => {
  const b = box(t);
  const stagingDirectory = join(b.project.directory, "handoff-staging");
  rmSync(stagingDirectory, { recursive: true, force: true });
  writeFileSync(stagingDirectory, "not a directory");
  const descriptorDirectory = "/proc/self/fd";
  const descriptorCount = process.platform === "linux" && existsSync(descriptorDirectory)
    ? () => readdirSync(descriptorDirectory).length
    : undefined;
  const before = descriptorCount?.();
  for (let attempt = 0; attempt < 32; attempt++) {
    assert.throws(() => writeCorpusHandoffRecord(b.project, b.record));
  }
  if (descriptorCount !== undefined) assert.equal(descriptorCount(), before);

  rmSync(stagingDirectory);
  mkdirSync(stagingDirectory);
  assert.equal(existsSync(writeCorpusHandoffRecord(b.project, b.record)), true);
});

test("write refuses more than 64 staged handoff files", (t) => {
  const b = box(t);
  const stagingDirectory = join(b.project.directory, "handoff-staging");
  mkdirSync(stagingDirectory, { recursive: true });
  for (let index = 0; index < 65; index++) {
    writeFileSync(join(stagingDirectory, `.residue-${index}.tmp`), "x");
  }
  assert.throws(() => writeCorpusHandoffRecord(b.project, b.record), /more than 64 staged handoff files/);
});

test("candidate listing refuses an aggregate above 4 MiB", (t) => {
  const b = box(t);
  const pending = join(b.project.directory, "pending");
  for (let index = 0; index < 5; index++) {
    writeFileSync(join(pending, `brisk-bison-${index.toString(16).padStart(4, "0")}.json`), " ".repeat(900_000));
  }
  const tooLarge = listCorpusHandoffCandidates({ cwd: b.cwd, isTrusted: () => true });
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.match(tooLarge.reason, /exceed 4 MiB in aggregate/);
});

test("adoption refuses foreign worktrees and branches with sanitized diagnostics", { timeout: 20_000 }, async (t) => {
  const b = box(t);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  overwrite(b, { ...b.record, worktreePath: `${b.cwd}/foreign\u001b[31m` });
  const foreignWorktree = receiver(b);
  assert.equal(await foreignWorktree.hooks.adoptHandoff(foreignWorktree.ctx, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /handoff belongs to worktree/);
  assert.doesNotMatch(warnings.join("\n"), /\u001b/);
  assert.equal(foreignWorktree.messages.length, 0);
  assert.deepEqual(foreignWorktree.entries, []);

  warnings.length = 0;
  overwrite(b, { ...b.record, branchLabel: "foreign\u001b[31m" });
  const foreignBranch = receiver(b);
  assert.equal(await foreignBranch.hooks.adoptHandoff(foreignBranch.ctx, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /handoff belongs to branch/);
  assert.doesNotMatch(warnings.join("\n"), /\u001b/);
  assert.equal(foreignBranch.messages.length, 0);
});

test("adoption refuses a session that already holds a thread or an episode", { timeout: 20_000 }, async (t) => {
  const b = box(t);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
  const withThread = receiver(b);
  withThread.store.threads.set("t9", thread("t9"));
  assert.equal(await withThread.hooks.adoptHandoff(withThread.ctx, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /already has threads or episodes/);
  assert.deepEqual(withThread.entries, []);

  warnings.length = 0;
  const withEpisode = receiver(b);
  withEpisode.store.episodes.set("t9.e1", {
    id: "t9.e1", threadId: "t9", task: "held episode", status: "ok",
    file: join(b.directory, "episodes", "t9.e1.md"), createdAt: 1,
  });
  assert.equal(await withEpisode.hooks.adoptHandoff(withEpisode.ctx, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /already has threads or episodes/);
  assert.deepEqual(withEpisode.entries, []);
});

test("adoption rejects unreadable and future records, and warns about a stale one", { timeout: 20_000 }, async (t) => {
  const b = box(t);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  overwrite(b, "{broken");
  const malformed = receiver(b);
  assert.equal(await malformed.hooks.adoptHandoff(malformed.ctx, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /malformed handoff JSON.*list candidates/);
  assert.equal(malformed.messages.length, 0);

  overwrite(b, { ...b.record, createdAt: Date.now() + 60_000 });
  warnings.length = 0;
  const future = receiver(b);
  assert.equal(await future.hooks.adoptHandoff(future.ctx, SOURCE_NAME, noModeChange), false);
  assert.match(warnings.join("\n"), /future creation time/);
  assert.equal(future.messages.length, 0);

  overwrite(b, { ...b.record, createdAt: Date.now() - 16 * 60_000 });
  warnings.length = 0;
  const stale = receiver(b);
  assert.equal(await stale.hooks.adoptHandoff(stale.ctx, SOURCE_NAME, noModeChange), true);
  assert.match(warnings.join("\n"), /older than 15 minutes.*adoption continues/);
  assert.equal(stale.messages.at(-1)?.customType, "slate-kickoff");
});

test("pause guidance names handoff writing and adoption across all pause hooks", async (t) => {
  const b = box(t);
  const percent = receiver(b, {
    orchestratorMode: true,
    pauseThresholdPercent: 10,
    contextUsage: { percent: 100 },
  });
  const turnEnd = percent.handlers.get("turn_end");
  assert.ok(turnEnd);
  await turnEnd({}, percent.ctx);
  assert.match(percent.messages[0]?.content ?? "", /\/slate handoff \[optional focus\][\s\S]*\/slate adopt <name>/);

  const budget = receiver(b, {
    orchestratorMode: true,
    contextBudget: { tokens: 10_000 },
    contextUsage: { tokens: 20_000, contextWindow: 1_000_000 },
    model: { provider: "openai", id: "gpt-4o" },
  });
  const agentEnd = budget.handlers.get("agent_end");
  assert.ok(agentEnd);
  await agentEnd({}, budget.ctx);
  assert.match(budget.messages[0]?.content ?? "", /\/slate handoff \[optional focus\][\s\S]*\/slate adopt <name>/);

  const compact = receiver(b, {
    orchestratorMode: true,
    contextBudget: { tokens: 10_000 },
    hasUI: true,
  });
  const beforeCompact = compact.handlers.get("session_before_compact");
  assert.ok(beforeCompact);
  await beforeCompact({ reason: "threshold" }, compact.ctx);
  assert.match(compact.notifications[0] ?? "", /\/slate handoff \[focus\][\s\S]*\/slate adopt <name>/);
  assert.match(compact.messages[0]?.content ?? "", /\/slate handoff \[optional focus\][\s\S]*\/slate adopt <name>/);
});

test("raw version 1 records preserve long scalar handoff fields", (t) => {
  const b = box(t);
  const record = { ...b.record, brief: `v1:${"x".repeat(9000)}` };
  overwrite(b, record);
  const read = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.record.brief, record.brief);
});

test("wire strings split only above exact UTF-8 boundaries", (t) => {
  const b = box(t);
  for (const [label, brief, chunked] of [
    ["8192", "x".repeat(8192), false],
    ["8193", "x".repeat(8193), true],
    ["multibyte", `${"é".repeat(4096)}z`, true],
    ["lone surrogate", `${"x".repeat(8191)}\ud800z`, true],
  ] as const) {
    const file = writeCorpusHandoffRecord(b.project, { ...b.record, brief });
    const wire = JSON.parse(readFileSync(file, "utf8")) as { brief: unknown };
    assert.equal(Array.isArray(wire.brief), chunked, label);
    if (Array.isArray(wire.brief)) {
      assert.ok(wire.brief.length >= 2, label);
      assert.equal(wire.brief.every((part) => typeof part === "string" && part.length > 0 && Buffer.byteLength(part) <= 8192), true, label);
    }
    const read = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
    assert.equal(read.ok, true, label);
    if (read.ok) assert.equal(read.record.brief, brief, label);
  }
});

test("version 2 round trips every flexible coordination string", (t) => {
  const b = box(t);
  const long = (label: string) => `${label}:${"λ".repeat(5000)}:\ud800`;
  const record: CorpusHandoffRecord = {
    ...b.record,
    worktreePath: long("worktree"),
    branchLabel: long("branch"),
    brief: long("brief"),
    focus: long("focus"),
    model: { provider: long("provider"), id: long("model") },
    thinkingLevel: long("thinking") as never,
  };
  writeCorpusHandoffRecord(b.project, record);
  const read = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.record.worktreePath, record.worktreePath);
    assert.equal(read.record.branchLabel, record.branchLabel);
    assert.equal(read.record.brief, record.brief);
    assert.equal(read.record.focus, record.focus);
    assert.deepEqual(read.record.model, record.model);
    assert.equal(read.record.thinkingLevel, record.thinkingLevel);
  }
});

test("raw handoff validation refuses every malformed coordination field class", (t) => {
  const b = box(t);
  const cases: Array<[string, (record: Record<string, unknown>) => void]> = [
    ["unknown root field", (record) => { record.unexpected = true; }],
    ["missing required field", (record) => { delete record.brief; }],
    ["unsupported version", (record) => { record.version = 3; }],
    ["non-object author", (record) => { record.author = null; }],
    ["author unknown field", (record) => { (record.author as Record<string, unknown>).extra = true; }],
    ["invalid author identity", (record) => { (record.author as Record<string, unknown>).identity = "bad"; }],
    ["invalid author name", (record) => { (record.author as Record<string, unknown>).name = "BAD"; }],
    ["non-string author directory", (record) => { record.authorSessionDirectory = 3; }],
    ["non-string worktree", (record) => { record.worktreePath = 3; }],
    ["non-string branch", (record) => { record.branchLabel = false; }],
    ["non-string brief", (record) => { record.brief = 3; }],
    ["non-string focus", (record) => { record.focus = 3; }],
    ["non-finite timestamp", (record) => { record.createdAt = Number.NaN; }],
    ["non-array parents", (record) => { record.parentChain = "bad"; }],
    ["invalid parent identity", (record) => { record.parentChain = [{ identity: "bad", name: "brisk-bison-abcd" }]; }],
    ["invalid parent name", (record) => { record.parentChain = [{ identity: "20260819T010203Z-1111111111111111", name: "BAD" }]; }],
    ["parent unknown field", (record) => { record.parentChain = [{ identity: "20260819T010203Z-1111111111111111", name: "brisk-bison-abcd", extra: true }]; }],
    ["non-object model", (record) => { record.model = "bad"; }],
    ["model unknown field", (record) => { record.model = { provider: "p", id: "m", extra: true }; }],
    ["empty provider", (record) => { record.model = { provider: "", id: "m" }; }],
    ["non-string provider", (record) => { record.model = { provider: 3, id: "m" }; }],
    ["empty model id", (record) => { record.model = { provider: "p", id: "" }; }],
    ["non-string model id", (record) => { record.model = { provider: "p", id: 3 }; }],
    ["non-string thinking", (record) => { record.thinkingLevel = 3; }],
    ["missing carried cost", (record) => { delete record.carriedCostUsd; }],
    ["negative carried cost", (record) => { record.carriedCostUsd = -1; }],
    ["non-finite carried cost", (record) => { record.carriedCostUsd = Number.NaN; }],
    ["non-number carried cost", (record) => { record.carriedCostUsd = "7"; }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = structuredClone(b.record) as unknown as Record<string, unknown>;
    mutate(candidate);
    overwrite(b, candidate);
    const read = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
    assert.equal(read.ok, false, label);
    if (!read.ok) assert.match(read.reason, /schema or bounds/, label);
  }
});

test("handoff lineage is non-authoritative, unique, and acyclic", (t) => {
  const b = box(t);
  const first = { identity: "20260818T010203Z-1111111111111111", name: "brisk-bison-1111" };
  const second = { identity: "20260819T010203Z-2222222222222222", name: "brisk-bison-2222" };
  overwrite(b, { ...b.record, parentChain: [first, second] });
  assert.equal(readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true }).ok, true);

  for (const [label, parentChain] of [
    ["duplicate identity", [first, first]],
    ["duplicate name", [first, { ...second, name: first.name }]],
    ["author cycle", [first, { identity: SOURCE_ID, name: SOURCE_NAME }]],
  ] as const) {
    overwrite(b, { ...b.record, parentChain });
    const read = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
    assert.equal(read.ok, false, label);
    if (!read.ok) assert.match(read.reason, /duplicated or cyclic parent lineage/, label);
  }
});

test("the handoff reader rejects mismatched durable namespace metadata", (t) => {
  const b = box(t);
  const metadataFile = join(b.directory, "session.json");
  const original = JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
  writeFileSync(metadataFile, JSON.stringify({ ...original, identity: "20260820T010203Z-fedcba9876543210" }));
  const identity = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(identity.ok, false);
  if (!identity.ok) assert.match(identity.reason, /metadata that does not match/);

  writeFileSync(metadataFile, JSON.stringify({ ...original, name: "brisk-bison-abcd" }));
  const name = readCorpusHandoffRecord({ cwd: b.cwd, name: SOURCE_NAME, isTrusted: () => true });
  assert.equal(name.ok, false);
  if (!name.ok) assert.match(name.reason, /metadata that does not match/);
});

test("writer rejects one-way pending-directory replacement", (t) => {
  const b = box(t);
  const pending = join(b.project.directory, "pending");
  const moved = join(b.project.directory, "pending-moved");
  assert.throws(
    () => writeCorpusHandoffRecord(b.project, b.record, {
      afterPendingOpen() { renameSync(pending, moved); mkdirSync(pending); },
    }),
    /changing handoff directory/,
  );
  assert.equal(existsSync(join(moved, `${SOURCE_NAME}.json`)), true);
});

test("first handoff publication syncs project, file, staging, and pending in order", (t) => {
  const b = box(t);
  const pending = join(b.project.directory, "pending");
  const staging = join(b.project.directory, "handoff-staging");
  rmSync(pending, { recursive: true });
  const events: string[] = [];
  writeCorpusHandoffRecord(b.project, b.record, {}, {
    fsyncFile(fd) {
      DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncFile(fd);
      events.push("file");
    },
    fsyncDirectory(directory) {
      DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncDirectory(directory);
      if (directory.path === b.project.directory) events.push("project");
      else if (directory.path === staging) events.push("staging");
      else {
        assert.equal(directory.path, pending);
        events.push("pending");
      }
    },
  });
  assert.deepEqual(events, ["project", "file", "staging", "staging", "pending"]);
  assert.deepEqual(readdirSync(staging), []);
});

test("a post-fsync failure removes its staged handoff file", (t) => {
  const b = box(t);
  const staging = join(b.project.directory, "handoff-staging");
  const events: string[] = [];
  let stagedFile = "";
  assert.throws(
    () => writeCorpusHandoffRecord(b.project, b.record, {}, {
      fsyncFile(fd) {
        DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncFile(fd);
        const entries = readdirSync(staging);
        assert.equal(entries.length, 1);
        stagedFile = join(staging, entries[0]!);
        events.push("file");
      },
      fsyncDirectory(directory) {
        DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncDirectory(directory);
        assert.equal(directory.path, staging);
        events.push("staging");
        throw new Error("forced post-fsync failure");
      },
    }),
    /forced post-fsync failure/,
  );
  assert.deepEqual(events, ["file", "staging"]);
  assert.notEqual(stagedFile, "");
  assert.equal(existsSync(stagedFile), false);
  assert.deepEqual(readdirSync(staging), []);
});

test("temporary records obey the scan cap and candidate directory closes once", (t) => {
  const b = box(t);
  const pending = join(b.project.directory, "pending");
  for (let index = 0; index < 4095; index++) {
    writeFileSync(join(pending, `.${SOURCE_NAME}.${process.pid}.${index}.tmp`), "legacy");
  }
  let closes = 0;
  const listed = listCorpusHandoffCandidates({
    cwd: b.cwd,
    isTrusted: () => true,
    afterDirectoryClose(directory) {
      closes += 1;
      assert.throws(() => directory.readSync(), /closed/i);
    },
  });
  assert.equal(closes, 1);
  assert.equal(listed.ok, true);
  if (listed.ok) assert.deepEqual(listed.candidates.map((candidate) => candidate.name), [SOURCE_NAME]);

  writeFileSync(join(pending, `.${SOURCE_NAME}.${process.pid}.4095.tmp`), "legacy");
  const capped = listCorpusHandoffCandidates({ cwd: b.cwd, isTrusted: () => true });
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.match(capped.reason, /more than 4096 directory entries/);

  rmSync(pending, { recursive: true });
  mkdirSync(pending);
  for (let index = 0; index < 65; index++) {
    writeFileSync(join(pending, `.${SOURCE_NAME}.${process.pid}.${index}.tmp`), "legacy");
  }
  const free = listCorpusHandoffCandidates({ cwd: b.cwd, isTrusted: () => true });
  assert.equal(free.ok, true);
  if (free.ok) assert.deepEqual(free.candidates, []);
});

test("unnamed adoption reports empty, unavailable, one, and several candidates without adopting", { timeout: 20_000 }, async (t) => {
  const b = box(t);
  const h = receiver(b);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
  const pending = join(b.project.directory, "pending");

  rmSync(pending, { recursive: true });
  assert.equal(await h.hooks.adoptHandoff(h.ctx, undefined, () => assert.fail("must not enter mode")), false);
  assert.match(warnings.join("\n"), /no handoff records are available/);

  mkdirSync(pending);
  overwrite(b, "{broken");
  warnings.length = 0;
  assert.equal(await h.hooks.adoptHandoff(h.ctx, undefined, () => assert.fail("must not enter mode")), false);
  assert.match(warnings.join("\n"), /unavailable.*malformed handoff JSON/s);

  writeCorpusHandoffRecord(b.project, b.record);
  warnings.length = 0;
  assert.equal(await h.hooks.adoptHandoff(h.ctx, undefined, () => assert.fail("must not enter mode")), false);
  assert.match(warnings.join("\n"), /one handoff record is available/);

  const secondId = "20260820T030405Z-1111111111111111";
  const secondName = "brisk-bison-abcd";
  const second = createDurableSession({
    cwd: b.cwd,
    project: b.project,
    identity: secondId,
    name: secondName,
    creatorSessionDigest: "c".repeat(64),
    runtime: runtime(),
  });
  writeCorpusHandoffRecord(b.project, {
    ...b.record,
    author: { identity: secondId, name: secondName },
    authorSessionDirectory: second.directory,
  });
  warnings.length = 0;
  assert.equal(await h.hooks.adoptHandoff(h.ctx, undefined, () => assert.fail("must not enter mode")), false);
  assert.match(warnings.join("\n"), /several handoff records are available/);
  assert.match(warnings.join("\n"), new RegExp(SOURCE_NAME));
  assert.match(warnings.join("\n"), new RegExp(secondName));
  assert.deepEqual(h.entries, []);
  assert.deepEqual(h.messages, []);
});

test("startHandoff writes a compact record and reports missing identity and oversized focus", { timeout: 20_000 }, async (t) => {
  const b = box(t);
  const h = receiver(b);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
  const ctx = {
    ...h.ctx,
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "assistant", content: "verified handoff brief" } }],
      getEntries: () => [],
    },
  } as unknown as ExtensionCommandContext;

  await h.hooks.startHandoff(ctx, "next focus");
  const name = h.store.slateSessionName;
  const identity = h.store.slateSessionId;
  assert.ok(name);
  assert.ok(identity);
  assert.match(warnings.join("\n"), /handoff record written/);
  const written = readFileSync(corpusHandoffFile(b.project, name), "utf8");
  assert.equal(written.includes("\n  \""), false);
  const read = readCorpusHandoffRecord({ cwd: b.cwd, name, isTrusted: () => true });
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.record.brief, "verified handoff brief");
    assert.equal(read.record.focus, "next focus");
  }

  const realCommit = h.store.commit.bind(h.store);
  h.store.commit = () => ({
    kind: "committed" as const,
    binding: { policy: "durable-session-v1", identity, name },
  });
  h.store.slateSessionId = undefined;
  warnings.length = 0;
  await h.hooks.startHandoff(ctx);
  assert.match(warnings.join("\n"), /no persisted corpus identity/);

  h.store.slateSessionId = identity;
  warnings.length = 0;
  await h.hooks.startHandoff(ctx, "x".repeat(1024 * 1024));
  assert.match(warnings.join("\n"), /handoff record was not written.*larger than 1 MiB/);
  h.store.commit = realCommit;
});

test("failed receiving commit restores durable state, mode, and reminder", { timeout: 20_000 }, async (t) => {
  const b = box(t, { runtime: { threads: [thread("t1")], threadSeq: 1 } });
  const before = readFileSync(join(b.directory, "state.json"));
  const events: string[] = [];
  const h = receiver(b, { failUpdate: true, events });
  h.store.writingReminder.markTokens = 42;
  h.store.writingReminder.sentThisRound = true;
  h.store.writingReminder.forceNext = false;
  const warnings: string[] = [];
  let modeActive = false;
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  const adopted = await h.hooks.adoptHandoff(h.ctx, SOURCE_NAME, () => {
    modeActive = true;
    events.push("mode-on");
    return () => {
      modeActive = false;
      events.push("mode-undo");
    };
  });
  assert.equal(adopted, false);
  assert.equal(modeActive, false);
  assert.deepEqual(events, ["mode-on", "mode-undo"]);
  assert.equal(h.store.slateSessionId, SOURCE_ID);
  assert.equal(h.store.slateSessionName, SOURCE_NAME);
  assert.deepEqual([...h.store.threads.keys()], ["t1"]);
  assert.equal(h.store.orchestratorMode, true);
  assert.equal(h.store.paused, true);
  assert.equal(h.store.workerCostUsd, 5);
  assert.equal(h.store.carriedCostUsd, 2);
  assert.equal(h.store.writingReminder.markTokens, 42);
  assert.equal(h.store.writingReminder.sentThisRound, true);
  assert.equal(h.store.writingReminder.forceNext, false);
  assert.deepEqual(h.entries, []);
  assert.deepEqual(h.messages, []);
  assert.deepEqual(readFileSync(join(b.directory, "state.json")), before);
  assert.match(warnings.join("\n"), /could not save the receiving session state.*No kickoff was sent/);
});

test("model and thinking restoration failures are reported without blocking the kickoff", { timeout: 20_000 }, async (t) => {
  const b = box(t);
  overwrite(b, { ...b.record, model: { provider: "p", id: "target" }, thinkingLevel: "high" });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  const modelFailure = receiver(b, {
    model: { provider: "p", id: "other" }, foundModel: { provider: "p", id: "target" }, failModelSwitch: true,
  });
  assert.equal(await modelFailure.hooks.adoptHandoff(modelFailure.ctx, SOURCE_NAME, noModeChange), true);
  assert.match(warnings.join("\n"), /could not restore handoff model p\/target.*forced model switch failure/);
  assert.equal(modelFailure.messages.at(-1)?.customType, "slate-kickoff");

  warnings.length = 0;
  const thinkingFailure = receiver(b, {
    model: { provider: "p", id: "target" }, foundModel: { provider: "p", id: "target" },
    thinking: "low", failThinkingSwitch: true,
  });
  assert.equal(await thinkingFailure.hooks.adoptHandoff(thinkingFailure.ctx, SOURCE_NAME, noModeChange), true);
  assert.match(warnings.join("\n"), /could not restore thinking level high.*forced thinking switch failure/);
  assert.equal(thinkingFailure.messages.at(-1)?.customType, "slate-kickoff");
});
