import assert from "node:assert/strict";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { createCorpusSession, currentBranchLabel } from "../extension/corpus.ts";
import {
  corpusHandoffFile,
  DEFAULT_HANDOFF_DURABILITY_OPERATIONS,
  fsyncHeldDirectory,
  handoffTreeWithinDepth,
  listCorpusHandoffCandidates,
  readCorpusHandoffRecord,
  writeCorpusHandoffRecord,
  type CorpusHandoffRecord,
} from "../extension/handoff-record.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import { SlateStore, type SlateSnapshot, type ThreadRecord } from "../extension/state.ts";

const SOURCE_ID = "20260820T010203Z-0123456789abcdef";
const ADOPTER_ID = "20260820T020304Z-fedcba9876543210";
const SOURCE_OWNER = "a".repeat(64);
const ADOPTER_OWNER = "b".repeat(64);

function baseSnapshot(overrides: Partial<SlateSnapshot> = {}): SlateSnapshot {
  return {
    threads: [],
    episodes: [],
    orchestratorMode: true,
    paused: false,
    workerCostUsd: 0,
    carriedCostUsd: 0,
    ...overrides,
  };
}

function thread(id: string, sessionFile = ""): ThreadRecord {
  return {
    id,
    name: id,
    sessionFile,
    status: "idle",
    episodeIds: [],
    episodeSeq: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function episodeRecord(box: Sandbox, overrides: Record<string, unknown> = {}) {
  return {
    id: "t1.e1",
    threadId: "t1",
    task: "verified task",
    status: "ok" as const,
    file: join(box.source.directory, "episodes", "t1.e1.md"),
    createdAt: 1,
    ...overrides,
  };
}

function recordWithEpisode(box: Sandbox, overrides: Record<string, unknown> = {}): CorpusHandoffRecord {
  const episode = episodeRecord(box, overrides);
  return {
    ...box.record,
    snapshot: {
      ...box.record.snapshot,
      threadSeq: 1,
      threads: [{ ...thread("t1"), episodeIds: ["t1.e1"], episodeSeq: 1 }],
      episodes: [episode],
    },
  } as CorpusHandoffRecord;
}

interface Sandbox {
  root: string;
  cwd: string;
  source: ReturnType<typeof createCorpusSession>;
  adopter: ReturnType<typeof createCorpusSession>;
  record: CorpusHandoffRecord;
  restore(): void;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "slate-handoff-adoption-"));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agent);
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const source = createCorpusSession({ cwd, identity: SOURCE_ID, initialNameBytes: Uint8Array.from([1, 2, 3, 4]) });
  const adopter = createCorpusSession({ cwd, identity: ADOPTER_ID, initialNameBytes: Uint8Array.from([5, 6, 7, 8]) });
  const sourceSnapshot = baseSnapshot({
    slateSessionId: SOURCE_ID,
    slateSessionName: source.name,
    ownerSessionDigest: SOURCE_OWNER,
  });
  const record: CorpusHandoffRecord = {
    version: 1,
    author: { identity: SOURCE_ID, name: source.name },
    authorSessionDirectory: source.directory,
    createdAt: Date.now(),
    worktreePath: cwd,
    branchLabel: currentBranchLabel(cwd),
    parentChain: [],
    brief: "Continue the verified work.",
    snapshot: sourceSnapshot,
  };
  writeCorpusHandoffRecord(source.project, record);
  return {
    root,
    cwd,
    source,
    adopter,
    record,
    restore() {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function adoptionHarness(box: Sandbox, options: {
  failSave?: boolean;
  currentModel?: { provider: string; id: string };
  foundModel?: { provider: string; id: string };
  failModelSwitch?: boolean;
  failThinkingSwitch?: boolean;
  currentThinking?: string;
  events?: string[];
  pauseThresholdPercent?: number;
  contextBudget?: { tokens: number };
  contextUsage?: { percent?: number; tokens?: number; contextWindow?: number };
} = {}) {
  const messages: Array<{ customType?: string; content?: string }> = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const appended: Array<Record<string, unknown>> = [];
  const adoptedModels: Array<{ model: string; effort: unknown }> = [];
  const modelSwitches: string[] = [];
  const thinkingSwitches: string[] = [];
  const store = new SlateStore({
    appendEntry(_type: string, data: Record<string, unknown>) {
      options.events?.push("save");
      appended.push(data);
      if (options.failSave && appended.length === 1) throw new Error("forced persistence failure");
    },
  } as unknown as ExtensionAPI);
  store.corpusProject = box.source.project;
  store.slateSessionId = ADOPTER_ID;
  store.slateSessionName = box.adopter.name;
  store.ownerSessionDigest = ADOPTER_OWNER;
  store.orchestratorMode = true;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
    sendMessage(message: { customType?: string; content?: string }) {
      messages.push(message);
      options.events?.push(message.customType === "slate-kickoff" ? "kickoff" : "message");
    },
    getThinkingLevel() { return thinkingSwitches.at(-1) ?? options.currentThinking; },
    async setModel(model: { provider: string; id: string }) {
      const spec = `${model.provider}/${model.id}`;
      modelSwitches.push(spec);
      options.events?.push(`model-switch:${spec}`);
      if (options.failModelSwitch) throw new Error("forced model switch failure");
      return true;
    },
    setThinkingLevel(level: string) {
      thinkingSwitches.push(level);
      options.events?.push(`thinking-switch:${level}`);
      if (options.failThinkingSwitch) throw new Error("forced thinking switch failure");
    },
  } as unknown as ExtensionAPI;
  const tracker = {
    async ownSwitch<T>(_from: string | undefined, _to: string, perform: () => Promise<T>): Promise<T> { return perform(); },
    adopt(model: string, effort: unknown) {
      adoptedModels.push({ model, effort });
      options.events?.push(`restore:${model}:${String(effort)}`);
    },
  } as unknown as BaseModelTracker;
  const hooks = registerSlateHandoff(
    pi,
    store,
    () => ({
      preserveGlobalModelDefault: false,
      pauseThresholdPercent: options.pauseThresholdPercent,
      contextBudget: options.contextBudget,
    }),
    () => tracker,
  );
  const ctx = {
    cwd: box.cwd,
    hasUI: false,
    model: options.currentModel,
    modelRegistry: { find: () => options.foundModel },
    isProjectTrusted: () => true,
    getContextUsage: () => options.contextUsage,
  } as unknown as ExtensionCommandContext;
  return { adoptedModels, appended, ctx, handlers, hooks, messages, modelSwitches, store, thinkingSwitches };
}

function overwriteRecord(box: Sandbox, value: unknown): string {
  const file = corpusHandoffFile(box.source.project, box.source.name);
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  return file;
}

const noModeChange = () => () => {};

test("pause guidance names handoff writing and explicit adoption", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const percent = adoptionHarness(box, {
    pauseThresholdPercent: 10,
    contextUsage: { percent: 100 },
  });
  const turnEnd = percent.handlers.get("turn_end");
  assert.ok(turnEnd);
  await turnEnd?.({}, percent.ctx);
  assert.match(String(percent.messages[0]?.content), /\/slate handoff \[optional focus\]/);
  assert.match(String(percent.messages[0]?.content), /\/slate adopt <name>/);

  const budget = adoptionHarness(box, {
    contextBudget: { tokens: 10_000 },
    contextUsage: { tokens: 20_000, contextWindow: 1_000_000 },
    currentModel: { provider: "openai", id: "gpt-4o" },
  });
  const budgetEnd = budget.handlers.get("turn_end");
  assert.ok(budgetEnd);
  await budgetEnd?.({}, budget.ctx);
  assert.match(String(budget.messages[0]?.content), /\/slate adopt <name>/);

  const compact = adoptionHarness(box, { contextBudget: { tokens: 10_000 } });
  const beforeCompact = compact.handlers.get("session_before_compact");
  assert.ok(beforeCompact);
  await beforeCompact?.({ reason: "threshold" }, compact.ctx);
  assert.match(String(compact.messages[0]?.content), /\/slate adopt <name>/);
});

test("foreign adoption preserves the adopter namespace and appends predecessor lineage", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const harness = adoptionHarness(box);
  let entered = 0;
  const adopted = await harness.hooks.adoptHandoff(harness.ctx, box.source.name, () => {
    entered += 1;
    return () => { entered -= 1; };
  });

  assert.equal(adopted, true);
  assert.equal(harness.store.slateSessionId, ADOPTER_ID);
  assert.equal(harness.store.slateSessionName, box.adopter.name);
  assert.equal(harness.store.ownerSessionDigest, ADOPTER_OWNER);
  assert.deepEqual(harness.store.slateSessionParentChain, [{ identity: SOURCE_ID, name: box.source.name }]);
  assert.equal(entered, 1);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0]?.customType, "slate-kickoff");
  assert.equal(readFileSync(corpusHandoffFile(box.source.project, box.source.name), "utf8").length > 0, true);
});

test("untrusted adoption refuses before malformed JSON is parsed", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  overwriteRecord(box, "{ definitely malformed");
  const harness = adoptionHarness(box);
  const untrusted = { ...harness.ctx, isProjectTrusted: () => false } as ExtensionCommandContext;
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  assert.equal(await harness.hooks.adoptHandoff(untrusted, box.source.name, noModeChange), false);
  assert.match(warnings.join("\n"), /requires a trusted project/);
  assert.doesNotMatch(warnings.join("\n"), /malformed/);
  assert.equal(harness.messages.length, 0);
});

test("adoption requires the complete persisted adopter identity before parsing", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  overwriteRecord(box, "{ malformed and must remain unread");
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  for (const field of ["slateSessionId", "slateSessionName", "ownerSessionDigest"] as const) {
    const harness = adoptionHarness(box);
    harness.store[field] = undefined;
    warnings.length = 0;
    assert.equal(await harness.hooks.adoptHandoff(harness.ctx, box.source.name, noModeChange), false, field);
    assert.match(warnings.join("\n"), /requires this session's persisted identity, name, and owner digest/, field);
    assert.doesNotMatch(warnings.join("\n"), /malformed/, field);
    assert.equal(harness.messages.length, 0, field);
  }
});

test("the 1 MiB boundary is checked before parsing", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const file = corpusHandoffFile(box.source.project, box.source.name);
  const valid = JSON.stringify(box.record);
  assert.ok(Buffer.byteLength(valid) < 1024 * 1024);
  writeFileSync(file, valid + " ".repeat(1024 * 1024 - Buffer.byteLength(valid)));
  const exact = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(exact.ok, true);

  writeFileSync(file, valid + " ".repeat(1024 * 1024 + 1 - Buffer.byteLength(valid)));
  const oversized = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.reason, /larger than 1 MiB/);
});

test("large task strings survive within the total record cap", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const record = recordWithEpisode(box, { task: "x".repeat(13_500) });
  writeCorpusHandoffRecord(box.source.project, record);
  const result = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.snapshot.episodes[0]?.task.length, 13_500);
});

test("wire v1 keeps long scalar compatibility while v2 chunks exact UTF-8 boundaries", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const v1 = recordWithEpisode(box, { task: `v1-${"x".repeat(9000)}` });
  overwriteRecord(box, v1);
  const legacy = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.equal(legacy.record.snapshot.episodes[0]?.task, v1.snapshot.episodes[0]?.task);

  for (const [label, task, chunked] of [
    ["8192", "x".repeat(8192), false],
    ["8193", "x".repeat(8193), true],
    ["multibyte", `${"é".repeat(4096)}z`, true],
    ["lone-surrogate", `${"x".repeat(8191)}\ud800z`, true],
  ] as const) {
    const runtime = recordWithEpisode(box, { task });
    const file = writeCorpusHandoffRecord(box.source.project, runtime);
    const wire = JSON.parse(readFileSync(file, "utf8")) as { version: number; snapshot: { episodes: Array<{ task: unknown }> } };
    assert.equal(wire.version, 2, label);
    assert.equal(Array.isArray(wire.snapshot.episodes[0]?.task), chunked, label);
    if (Array.isArray(wire.snapshot.episodes[0]?.task)) {
      assert.ok(wire.snapshot.episodes[0]!.task.length >= 2, label);
      assert.ok(wire.snapshot.episodes[0]!.task.every((part) => typeof part === "string" && part.length > 0 && Buffer.byteLength(part) <= 8192), label);
    }
    const reread = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
    assert.equal(reread.ok, true, label);
    if (reread.ok) assert.equal(reread.record.snapshot.episodes[0]?.task, task, label);
  }
});

test("version 2 preserves every flexible runtime string position", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const long = (label: string) => `${label}:${"λ".repeat(5000)}:\ud800`;
  const episode = episodeRecord(box, { task: long("task"), model: long("episode-model"), effort: long("effort") });
  const record: CorpusHandoffRecord = {
    ...box.record,
    brief: long("brief"),
    focus: long("focus"),
    branchLabel: long("branch"),
    model: { provider: long("provider"), id: long("model-id") },
    thinkingLevel: long("thinking") as never,
    snapshot: {
      ...box.record.snapshot,
      threadSeq: 1,
      threads: [{
        ...thread("t1"),
        name: long("thread-name"),
        type: long("type") as never,
        model: long("thread-model"),
        baseModel: long("base-model"),
        baseEffort: long("base-effort") as never,
        tools: [long("tool")],
        episodeIds: ["t1.e1"],
        episodeSeq: 1,
      }],
      episodes: [episode],
    },
  };
  writeCorpusHandoffRecord(box.source.project, record);
  const reread = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(reread.ok, true);
  if (reread.ok) {
    assert.equal(reread.record.brief, record.brief);
    assert.equal(reread.record.focus, record.focus);
    assert.equal(reread.record.branchLabel, record.branchLabel);
    assert.deepEqual(reread.record.model, record.model);
    assert.equal(reread.record.thinkingLevel, record.thinkingLevel);
    assert.deepEqual(reread.record.snapshot.threads, record.snapshot.threads);
    assert.deepEqual(reread.record.snapshot.episodes, record.snapshot.episodes);
  }
});

test("version 2 rejects invalid UTF-8, malformed chunks, unknown layers, and excessive depth", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const record = recordWithEpisode(box, {
    observations: { stored: true, path: `${CONFIG_DIR_NAME}/slate/sessions/${box.source.name}/observations/t1.e1.md`, bytes: 1, truncated: false, grammar: "absent" },
    compressorUsage: { input: 1 },
  });
  const file = writeCorpusHandoffRecord(box.source.project, record);
  const original = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

  writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]));
  const invalidUtf8 = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(invalidUtf8.ok, false);
  if (!invalidUtf8.ok) assert.match(invalidUtf8.reason, /not valid UTF-8/);

  const mutations: Array<[string, (wire: Record<string, any>) => void]> = [
    ["one chunk", (wire) => { wire.snapshot.episodes[0].task = ["only"]; }],
    ["empty chunk", (wire) => { wire.snapshot.episodes[0].task = ["a", ""]; }],
    ["nested chunk", (wire) => { wire.snapshot.episodes[0].task = ["a", ["b"]]; }],
    ["non-string chunk", (wire) => { wire.snapshot.episodes[0].task = ["a", 2]; }],
    ["oversized segment", (wire) => { wire.snapshot.episodes[0].task = ["x".repeat(8193), "z"]; }],
    ["root unknown", (wire) => { wire.unknown = true; }],
    ["snapshot unknown", (wire) => { wire.snapshot.unknown = true; }],
    ["thread unknown", (wire) => { wire.snapshot.threads[0].unknown = true; }],
    ["episode unknown", (wire) => { wire.snapshot.episodes[0].unknown = true; }],
    ["observation unknown", (wire) => { wire.snapshot.episodes[0].observations.unknown = true; }],
    ["usage unknown", (wire) => { wire.snapshot.episodes[0].compressorUsage.unknown = 1; }],
    ["depth", (wire) => { wire.snapshot.episodes[0].compressorUsage.input = [[[[[[[[[1]]]]]]]]]; }],
  ];
  for (const [label, mutate] of mutations) {
    const wire = structuredClone(original);
    mutate(wire);
    writeFileSync(file, JSON.stringify(wire));
    const result = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.match(result.reason, /version 2.*wire schema or bounds/, label);
  }
});

test("compact serialization keeps a valid large record under the unchanged 1 MiB cap", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const count = 3000;
  const episodes = Array.from({ length: count }, (_, index) => episodeRecord(box, {
    id: `t1.e${index + 1}`,
    task: "x".repeat(80),
    file: join(box.source.directory, "episodes", `t1.e${index + 1}.md`),
  }));
  const record: CorpusHandoffRecord = {
    ...box.record,
    snapshot: {
      ...box.record.snapshot,
      threadSeq: 1,
      threads: [{ ...thread("t1"), episodeIds: episodes.map((episode) => episode.id), episodeSeq: count }],
      episodes,
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") < 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(record, null, 2), "utf8") > 1024 * 1024);
  const file = writeCorpusHandoffRecord(box.source.project, record);
  assert.ok(readFileSync(file).byteLength <= 1024 * 1024);
  assert.equal(readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true }).ok, true);
});

test("tree-depth guard rejects depth nine while accepting depth eight", () => {
  const nested = (depth: number): unknown => depth === 0 ? true : [nested(depth - 1)];
  assert.equal(handoffTreeWithinDepth(nested(8)), true);
  assert.equal(handoffTreeWithinDepth(nested(9)), false);
});

test("schema, unknown fields, and thread and episode count overflows are refused", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  overwriteRecord(box, { ...box.record, unexpected: true });
  const unknown = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /schema or bounds/);

  const threads = Array.from({ length: 513 }, (_, index) => thread(`t${index + 1}`));
  overwriteRecord(box, {
    ...box.record,
    snapshot: { ...box.record.snapshot, threads, threadSeq: threads.length },
  });
  const overflow = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.match(overflow.reason, /schema or bounds/);

  const episodes = Array.from({ length: 4097 }, (_, index) => ({
    id: `t1.e${index + 1}`,
    threadId: "t1",
    task: "x",
    status: "ok" as const,
    file: `/unused/t1.e${index + 1}.md`,
    createdAt: 1,
  }));
  overwriteRecord(box, {
    ...box.record,
    snapshot: {
      ...box.record.snapshot,
      threads: [{ ...thread("t1"), episodeIds: episodes.map((episode) => episode.id), episodeSeq: episodes.length }],
      episodes,
      threadSeq: 1,
    },
  });
  const episodeOverflow = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(episodeOverflow.ok, false);
  if (!episodeOverflow.ok) assert.match(episodeOverflow.reason, /schema or bounds/);
});

test("record validation rejects malformed fields and inconsistent graph references", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const validEpisode = {
    id: "t1.e1",
    threadId: "t1",
    task: "verified task",
    status: "ok" as const,
    file: join(box.source.directory, "observations", "t1.e1.md"),
    createdAt: 1,
  };
  const graph = () => ({
    ...box.record,
    snapshot: {
      ...box.record.snapshot,
      threads: [{ ...thread("t1"), episodeIds: [validEpisode.id], episodeSeq: 1 }],
      episodes: [{ ...validEpisode }],
      threadSeq: 1,
    },
  });
  const cases: Array<[string, (record: CorpusHandoffRecord) => void]> = [
    ["non-object author", (record) => { record.author = null as never; }],
    ["author with an unknown field", (record) => { Object.assign(record.author, { extra: true }); }],
    ["invalid author identity", (record) => { record.author.identity = "invalid"; }],
    ["non-string source directory", (record) => { record.authorSessionDirectory = 3 as never; }],
    ["non-string branch", (record) => { record.branchLabel = false as never; }],
    ["non-string focus", (record) => { record.focus = 4 as never; }],
    ["non-finite timestamp", (record) => { record.createdAt = Number.NaN; }],
    ["invalid parent", (record) => { record.parentChain = [{ identity: "bad", name: box.source.name }]; }],
    ["non-object model", (record) => { record.model = "bad" as never; }],
    ["model with an unknown field", (record) => { record.model = { provider: "p", id: "m", extra: true } as never; }],
    ["empty model provider", (record) => { record.model = { provider: "", id: "m" }; }],
    ["empty model id", (record) => { record.model = { provider: "p", id: "" }; }],
    ["non-string thinking level", (record) => { record.thinkingLevel = 7 as never; }],
    ["non-object thread", (record) => { record.snapshot.threads = [null as never]; }],
    ["thread with an unknown field", (record) => { record.snapshot.threads = [{ ...thread("t1"), extra: true } as never]; }],
    ["invalid thread status", (record) => { record.snapshot.threads = [{ ...thread("t1"), status: "done" as never }]; }],
    ["non-string thread episode id", (record) => { record.snapshot.threads = [{ ...thread("t1"), episodeIds: [4 as never] }]; }],
    ["non-object episode", (record) => { record.snapshot.episodes = [null as never]; }],
    ["episode with an unknown field", (record) => {
      const value = graph();
      value.snapshot.episodes = [{ ...validEpisode, extra: true } as never];
      Object.assign(record, value);
    }],
    ["duplicate thread id", (record) => { record.snapshot.threads = [thread("t1"), thread("t1")]; }],
    ["duplicate episode id", (record) => {
      const value = graph();
      value.snapshot.episodes.push({ ...validEpisode });
      Object.assign(record, value);
    }],
    ["episode with no thread", (record) => { record.snapshot.episodes = [{ ...validEpisode }]; }],
    ["duplicate episode reference", (record) => {
      const value = graph();
      value.snapshot.threads[0]!.episodeIds.push(validEpisode.id);
      Object.assign(record, value);
    }],
    ["missing episode reference", (record) => {
      const value = graph();
      value.snapshot.threads[0]!.episodeIds = ["t1.e2"];
      Object.assign(record, value);
    }],
    ["unlisted episode", (record) => {
      const value = graph();
      value.snapshot.threads[0]!.episodeIds = [];
      Object.assign(record, value);
    }],
    ["non-boolean orchestrator mode", (record) => { record.snapshot.orchestratorMode = 1 as never; }],
    ["non-boolean pause", (record) => { record.snapshot.paused = "no" as never; }],
    ["negative worker cost", (record) => { record.snapshot.workerCostUsd = -1; }],
    ["non-finite carried cost", (record) => { record.snapshot.carriedCostUsd = Number.NaN; }],
    ["fractional thread sequence", (record) => { record.snapshot.threadSeq = 1.5; }],
    ["invalid snapshot identity", (record) => { record.snapshot.slateSessionId = "bad"; }],
    ["invalid snapshot name", (record) => { record.snapshot.slateSessionName = "BAD"; }],
    ["invalid owner digest", (record) => { record.snapshot.ownerSessionDigest = "short"; }],
    ["invalid snapshot parent", (record) => { record.snapshot.slateSessionParentChain = [{ identity: "bad", name: box.source.name }]; }],
    ["author identity mismatch", (record) => { record.snapshot.slateSessionId = ADOPTER_ID; }],
    ["author name mismatch", (record) => { record.snapshot.slateSessionName = box.adopter.name; }],
    ["parent chain mismatch", (record) => {
      record.parentChain = [{ identity: SOURCE_ID, name: box.source.name }];
      record.snapshot.slateSessionParentChain = [];
    }],
    ["excessive nesting", (record) => { (record as unknown as Record<string, unknown>).extra = [[[[[[[[[true]]]]]]]]]; }],
  ];

  for (const [label, mutate] of cases) {
    const candidate = structuredClone(box.record);
    mutate(candidate);
    overwriteRecord(box, candidate);
    const result = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.match(result.reason, /schema or bounds/, label);
  }
});

test("multi-generation lineage is non-authoritative, unique, and oldest-first", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const grandId = "20260819T010203Z-2222222222222222";
  const parentId = "20260819T020304Z-3333333333333333";
  const grand = createCorpusSession({ cwd: box.cwd, identity: grandId, initialNameBytes: Uint8Array.from([21, 22, 23, 24]) });
  const parent = createCorpusSession({ cwd: box.cwd, identity: parentId, initialNameBytes: Uint8Array.from([25, 26, 27, 28]) });
  const chain = [
    { identity: grandId, name: grand.name },
    { identity: parentId, name: parent.name },
  ];
  overwriteRecord(box, {
    ...box.record,
    parentChain: chain,
    snapshot: { ...box.record.snapshot, slateSessionParentChain: chain },
  });
  const read = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(read.ok, true);
  const harness = adoptionHarness(box);
  assert.equal(await harness.hooks.adoptHandoff(harness.ctx, box.source.name, noModeChange), true);
  assert.deepEqual(harness.store.slateSessionParentChain, [
    ...chain,
    { identity: SOURCE_ID, name: box.source.name },
  ]);

  const cyclicAdopter = adoptionHarness(box);
  cyclicAdopter.store.slateSessionId = grandId;
  cyclicAdopter.store.slateSessionName = grand.name;
  assert.equal(await cyclicAdopter.hooks.adoptHandoff(cyclicAdopter.ctx, box.source.name, noModeChange), false);
  assert.equal(cyclicAdopter.messages.length, 0);

  for (const [label, invalid] of [
    ["duplicate", [chain[0], chain[0]]],
    ["author cycle", [...chain, { identity: SOURCE_ID, name: box.source.name }]],
  ] as const) {
    overwriteRecord(box, {
      ...box.record,
      parentChain: invalid,
      snapshot: { ...box.record.snapshot, slateSessionParentChain: invalid },
    });
    const refused = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
    assert.equal(refused.ok, false, label);
    if (!refused.ok) assert.match(refused.reason, /parent lineage/, label);
  }

  const historical = [{ identity: "20260818T010203Z-4444444444444444", name: "calm-otter-4444" }];
  overwriteRecord(box, {
    ...box.record,
    parentChain: historical,
    snapshot: { ...box.record.snapshot, slateSessionParentChain: historical },
  });
  assert.equal(readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true }).ok, true);
  rmSync(grand.directory, { recursive: true });
  rmSync(parent.directory, { recursive: true });
  assert.equal(readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true }).ok, true);
});

test("lineage caps at 256 and foreign adoption keeps the newest 255 ancestors", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const [adjective, noun] = box.source.name.split("-");
  assert.ok(adjective && noun);
  const parents = Array.from({ length: 256 }, (_, index) => ({
    identity: `20260819T010203Z-${index.toString(16).padStart(16, "0")}`,
    name: `${adjective}-${noun}-${index.toString(16).padStart(4, "0")}`,
  }));
  const record: CorpusHandoffRecord = {
    ...box.record,
    parentChain: parents,
    snapshot: { ...box.record.snapshot, slateSessionParentChain: parents },
  };
  writeCorpusHandoffRecord(box.source.project, record);
  assert.equal(readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true }).ok, true);
  const harness = adoptionHarness(box);
  assert.equal(await harness.hooks.adoptHandoff(harness.ctx, box.source.name, noModeChange), true);
  assert.equal(harness.store.slateSessionParentChain.length, 256);
  assert.deepEqual(harness.store.slateSessionParentChain[0], parents[1]);
  assert.deepEqual(harness.store.slateSessionParentChain.at(-1), { identity: SOURCE_ID, name: box.source.name });

  const overflow = [...parents, {
    identity: "20260819T010203Z-ffffffffffffffff",
    name: `${adjective}-${noun}-ffff`,
  }];
  overwriteRecord(box, {
    ...box.record,
    parentChain: overflow,
    snapshot: { ...box.record.snapshot, slateSessionParentChain: overflow },
  });
  const refused = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /schema or bounds/);
});

test("thread counters and restart graph prevent identifier reuse", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const first = episodeRecord(box);
  const base = {
    ...box.record,
    snapshot: {
      ...box.record.snapshot,
      threadSeq: 2,
      threads: [
        { ...thread("t1"), episodeIds: [first.id], episodeSeq: 1, supersededBy: "t2" },
        { ...thread("t2"), restartOf: "t1", restartGeneration: 1 },
      ],
      episodes: [first],
    },
  } as CorpusHandoffRecord;
  overwriteRecord(box, base);
  assert.equal(readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true }).ok, true);

  const cases: Array<[string, (record: CorpusHandoffRecord) => void]> = [
    ["stale episode counter", (record) => { record.snapshot.threads[0]!.episodeSeq = 0; }],
    ["foreign episode prefix", (record) => { record.snapshot.threads[0]!.episodeIds = ["t2.e1"]; record.snapshot.episodes[0]!.id = "t2.e1"; }],
    ["stale thread counter", (record) => { record.snapshot.threadSeq = 1; }],
    ["missing successor backlink", (record) => { delete record.snapshot.threads[0]!.supersededBy; }],
    ["wrong restart generation", (record) => { record.snapshot.threads[1]!.restartGeneration = 2; }],
    ["restart cycle", (record) => {
      record.snapshot.threads[0]!.restartOf = "t2";
      record.snapshot.threads[0]!.restartGeneration = 2;
      record.snapshot.threads[1]!.supersededBy = "t1";
    }],
  ];
  for (const [label, mutate] of cases) {
    const record = structuredClone(base);
    mutate(record);
    overwriteRecord(box, record);
    const result = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.match(result.reason, /schema or bounds/, label);
  }
});

test("record reads reject malformed JSON, invalid names, and mismatched source metadata", (t) => {
  const box = sandbox();
  t.after(() => box.restore());

  const invalidName = readCorpusHandoffRecord({ cwd: box.cwd, name: "../escape", isTrusted: () => true });
  assert.equal(invalidName.ok, false);
  if (!invalidName.ok) assert.match(invalidName.reason, /invalid handoff session name/);

  overwriteRecord(box, "{broken");
  const malformed = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.reason, /malformed handoff JSON/);

  overwriteRecord(box, { ...box.record, authorSessionDirectory: box.adopter.directory });
  const unexpected = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(unexpected.ok, false);
  if (!unexpected.ok) assert.match(unexpected.reason, /unexpected author session directory/);

  rmSync(box.source.directory, { recursive: true });
  overwriteRecord(box, box.record);
  const missing = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /missing or linked author session directory/);
});

test("immediate metadata binds identity and name, while conflicting ancestors grant no authority", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const metadataFile = join(box.source.directory, "session.json");
  const original = JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown>;

  writeFileSync(metadataFile, JSON.stringify({ ...original, identity: ADOPTER_ID }));
  const wrongIdentity = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(wrongIdentity.ok, false);
  if (!wrongIdentity.ok) assert.match(wrongIdentity.reason, /metadata that does not match/);

  writeFileSync(metadataFile, JSON.stringify({ ...original, name: box.adopter.name }));
  const wrongName = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(wrongName.ok, false);
  if (!wrongName.ok) assert.match(wrongName.reason, /metadata that does not match/);
  writeFileSync(metadataFile, JSON.stringify(original));

  const ancestorId = "20260818T010203Z-5555555555555555";
  const ancestor = createCorpusSession({ cwd: box.cwd, identity: ancestorId, initialNameBytes: Uint8Array.from([31, 32, 33, 34]) });
  const chain = [{ identity: ancestorId, name: ancestor.name }];
  const ancestorMetadataFile = join(ancestor.directory, "session.json");
  const ancestorMetadata = JSON.parse(readFileSync(ancestorMetadataFile, "utf8")) as Record<string, unknown>;
  writeFileSync(ancestorMetadataFile, JSON.stringify({ ...ancestorMetadata, identity: ADOPTER_ID, name: box.adopter.name }));
  overwriteRecord(box, {
    ...box.record,
    parentChain: chain,
    snapshot: { ...box.record.snapshot, slateSessionParentChain: chain },
  });
  assert.equal(readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true }).ok, true);

  const outside = recordWithEpisode(box, { file: join(box.root, "ancestor-cannot-authorize.md") });
  overwriteRecord(box, {
    ...outside,
    parentChain: chain,
    snapshot: { ...outside.snapshot, slateSessionParentChain: chain },
  });
  const noAuthority = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(noAuthority.ok, false);
  if (!noAuthority.ok) assert.match(noAuthority.reason, /linked or outside slate storage/);
});

test("linked transcript paths fail containment validation", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const real = join(box.source.directory, "threads", "real.jsonl");
  const linked = join(box.source.directory, "threads", "linked.jsonl");
  writeFileSync(real, "{}\n");
  symlinkSync(real, linked);
  overwriteRecord(box, {
    ...box.record,
    snapshot: { ...box.record.snapshot, threads: [thread("t1", linked)], threadSeq: 1 },
  });
  const result = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /session file is linked or outside/);
});

test("missing artifact paths survive while links and outside paths fail every category", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const missingSession = join(box.source.directory, "threads", "missing.jsonl");
  const missingFork = join(box.source.directory, "threads", "missing-source.jsonl");
  const missingEpisode = join(box.source.directory, "episodes", "t1.e1.md");
  const observationReference = `${CONFIG_DIR_NAME}/slate/sessions/${box.source.name}/observations/t1.e1.md`;
  const withMissing: CorpusHandoffRecord = {
    ...recordWithEpisode(box, {
      file: missingEpisode,
      observations: { stored: true, path: observationReference, bytes: 10, truncated: false, grammar: "absent" },
    }),
    snapshot: {
      ...recordWithEpisode(box).snapshot,
      threadSeq: 1,
      threads: [{ ...thread("t1", missingSession), forkedFrom: missingFork, episodeIds: ["t1.e1"], episodeSeq: 1 }],
      episodes: [episodeRecord(box, {
        file: missingEpisode,
        observations: { stored: true, path: observationReference, bytes: 10, truncated: false, grammar: "absent" },
      })],
    },
  };
  overwriteRecord(box, withMissing);
  assert.equal(readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true }).ok, true);

  const victim = join(box.root, "outside.txt");
  writeFileSync(victim, "outside");
  const linkedCases: Array<[string, string, (record: CorpusHandoffRecord, linked: string) => void]> = [
    ["session", join(box.source.directory, "threads", "linked-session.jsonl"), (record, linked) => { record.snapshot.threads[0]!.sessionFile = linked; }],
    ["fork", join(box.source.directory, "threads", "linked-fork.jsonl"), (record, linked) => { record.snapshot.threads[0]!.forkedFrom = linked; }],
    ["episode", join(box.source.directory, "episodes", "linked-episode.md"), (record, linked) => { record.snapshot.episodes[0]!.file = linked; }],
    ["observation", join(box.source.directory, "observations", "t1.e1.md"), () => {}],
  ];
  for (const [label, linked, mutate] of linkedCases) {
    rmSync(linked, { force: true });
    symlinkSync(victim, linked);
    const candidate = structuredClone(withMissing);
    mutate(candidate, linked);
    overwriteRecord(box, candidate);
    const refused = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
    assert.equal(refused.ok, false, label);
    if (!refused.ok) assert.match(refused.reason, /linked or outside/, label);
    rmSync(linked, { force: true });
  }

  const outsideMissing = join(box.root, "outside-missing");
  for (const [label, mutate] of [
    ["session", (record: CorpusHandoffRecord) => { record.snapshot.threads[0]!.sessionFile = outsideMissing; }],
    ["fork", (record: CorpusHandoffRecord) => { record.snapshot.threads[0]!.forkedFrom = outsideMissing; }],
    ["episode", (record: CorpusHandoffRecord) => { record.snapshot.episodes[0]!.file = outsideMissing; }],
  ] as const) {
    const candidate = structuredClone(withMissing);
    mutate(candidate);
    overwriteRecord(box, candidate);
    const refused = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
    assert.equal(refused.ok, false, label);
    if (!refused.ok) assert.match(refused.reason, /linked or outside/, label);
  }
});

test("production handoff durability defaults are the real frozen fsync operations", () => {
  assert.equal(Object.isFrozen(DEFAULT_HANDOFF_DURABILITY_OPERATIONS), true);
  assert.equal(DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncFile, fsyncSync);
  assert.equal(DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncDirectory, fsyncHeldDirectory);
});

test("write closes the pending directory when the staging directory hold fails", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const stagingDirectory = join(box.source.project.directory, "handoff-staging");
  rmSync(stagingDirectory, { recursive: true });
  writeFileSync(stagingDirectory, "not a directory");

  const descriptorDirectory = "/proc/self/fd";
  const descriptorCount = process.platform === "linux" && existsSync(descriptorDirectory)
    ? () => readdirSync(descriptorDirectory).length
    : undefined;
  const descriptorsBefore = descriptorCount?.();
  for (let attempt = 0; attempt < 32; attempt++) {
    assert.throws(() => writeCorpusHandoffRecord(box.source.project, box.record));
  }
  if (descriptorCount !== undefined) assert.equal(descriptorCount(), descriptorsBefore);

  rmSync(stagingDirectory);
  mkdirSync(stagingDirectory);
  const published = writeCorpusHandoffRecord(box.source.project, box.record);
  assert.equal(existsSync(published), true);
});

test("read and write reject one-way pending-directory replacement and sync first publication", (t) => {
  const readBox = sandbox();
  t.after(() => readBox.restore());
  const pending = join(readBox.source.project.directory, "pending");
  const moved = join(readBox.source.project.directory, "pending-moved");
  const read = readCorpusHandoffRecord({
    cwd: readBox.cwd,
    name: readBox.source.name,
    isTrusted: () => true,
    afterPendingOpen() {
      renameSync(pending, moved);
      mkdirSync(pending);
    },
  });
  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.reason, /changing handoff directory/);

  const writeBox = sandbox();
  t.after(() => writeBox.restore());
  const writePending = join(writeBox.source.project.directory, "pending");
  rmSync(writePending, { recursive: true });
  const stagingDirectory = join(writeBox.source.project.directory, "handoff-staging");
  const syncEvents: string[] = [];
  writeCorpusHandoffRecord(writeBox.source.project, writeBox.record, {}, {
    fsyncFile(fd) {
      DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncFile(fd);
      syncEvents.push("file");
    },
    fsyncDirectory(directory) {
      DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncDirectory(directory);
      if (directory.path === writeBox.source.project.directory) syncEvents.push("project");
      else if (directory.path === stagingDirectory) syncEvents.push("staging");
      else {
        assert.equal(directory.path, writePending);
        syncEvents.push("pending");
      }
    },
  });
  assert.deepEqual(syncEvents, ["project", "file", "staging", "staging", "pending"]);
  assert.deepEqual(readdirSync(stagingDirectory), []);
  for (let index = 0; index < 65; index++) writeFileSync(join(stagingDirectory, `residue-${index}`), "x");
  assert.throws(() => writeCorpusHandoffRecord(writeBox.source.project, writeBox.record), /more than 64 staged handoff files/);
  for (const entry of readdirSync(stagingDirectory)) rmSync(join(stagingDirectory, entry));

  const failureSyncEvents: string[] = [];
  let failedStaging = "";
  assert.throws(
    () => writeCorpusHandoffRecord(writeBox.source.project, writeBox.record, {}, {
      fsyncFile(fd) {
        DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncFile(fd);
        const entries = readdirSync(stagingDirectory);
        assert.equal(entries.length, 1);
        failedStaging = join(stagingDirectory, entries[0]!);
        failureSyncEvents.push("file");
      },
      fsyncDirectory(directory) {
        DEFAULT_HANDOFF_DURABILITY_OPERATIONS.fsyncDirectory(directory);
        assert.equal(directory.path, stagingDirectory);
        failureSyncEvents.push("staging");
        throw new Error("forced post-fsync failure");
      },
    }),
    /forced post-fsync failure/,
  );
  assert.deepEqual(failureSyncEvents, ["file", "staging"]);
  assert.notEqual(failedStaging, "");
  assert.equal(existsSync(failedStaging), false);
  assert.deepEqual(readdirSync(stagingDirectory), []);

  const writeMoved = join(writeBox.source.project.directory, "pending-moved");
  assert.throws(
    () => writeCorpusHandoffRecord(writeBox.source.project, writeBox.record, {
      afterPendingOpen() {
        renameSync(writePending, writeMoved);
        mkdirSync(writePending);
      },
    }),
    /changing handoff directory/,
  );
  assert.equal(readFileSync(join(writeMoved, `${writeBox.source.name}.json`), "utf8").length > 0, true);
});

test("candidate listing caps record count and aggregate bytes", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const pending = join(box.source.project.directory, "pending");
  rmSync(pending, { recursive: true });
  mkdirSync(pending);
  const [adjective, noun] = box.source.name.split("-");
  assert.ok(adjective && noun);
  for (let index = 0; index < 65; index++) {
    writeFileSync(join(pending, `${adjective}-${noun}-${index.toString(16).padStart(4, "0")}.json`), "{}");
  }
  const tooMany = listCorpusHandoffCandidates({ cwd: box.cwd, isTrusted: () => true });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.reason, /more than 64/);

  rmSync(pending, { recursive: true });
  mkdirSync(pending);
  for (let index = 0; index < 5; index++) {
    writeFileSync(
      join(pending, `${adjective}-${noun}-${index.toString(16).padStart(4, "0")}.json`),
      " ".repeat(900_000),
    );
  }
  const tooLarge = listCorpusHandoffCandidates({ cwd: box.cwd, isTrusted: () => true });
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.match(tooLarge.reason, /exceed 4 MiB in aggregate/);
});

test("legacy temps avoid candidate budget but obey scan cap, and candidate Dir closes exactly once", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const pending = join(box.source.project.directory, "pending");
  for (let index = 0; index < 4095; index++) {
    writeFileSync(join(pending, `.${box.source.name}.${process.pid}.${index}.tmp`), "legacy");
  }
  let closeObserved = false;
  const listed = listCorpusHandoffCandidates({
    cwd: box.cwd,
    isTrusted: () => true,
    afterDirectoryClose(directory) {
      closeObserved = true;
      assert.throws(() => directory.readSync(), /closed/i);
    },
  });
  assert.equal(closeObserved, true);
  assert.equal(listed.ok, true);
  if (listed.ok) assert.deepEqual(listed.candidates.map((candidate) => candidate.name), [box.source.name]);

  writeFileSync(join(pending, `.${box.source.name}.${process.pid}.4095.tmp`), "legacy");
  const capped = listCorpusHandoffCandidates({ cwd: box.cwd, isTrusted: () => true });
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.match(capped.reason, /more than 4096 directory entries/);

  rmSync(pending, { recursive: true });
  mkdirSync(pending);
  for (let index = 0; index < 65; index++) {
    writeFileSync(join(pending, `.${box.source.name}.${process.pid}.${index}.tmp`), "legacy");
  }
  const noCandidateCost = listCorpusHandoffCandidates({ cwd: box.cwd, isTrusted: () => true });
  assert.equal(noCandidateCost.ok, true);
  if (noCandidateCost.ok) assert.deepEqual(noCandidateCost.candidates, []);
});

test("candidate listing reports empty and unavailable records without adopting", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const harness = adoptionHarness(box);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  rmSync(join(box.source.project.directory, "pending"), { recursive: true });
  assert.equal(await harness.hooks.adoptHandoff(harness.ctx, undefined, () => assert.fail("must not enter mode")), false);
  assert.match(warnings.join("\n"), /no handoff records are available/);

  mkdirSync(join(box.source.project.directory, "pending"));
  overwriteRecord(box, "{broken");
  warnings.length = 0;
  assert.equal(await harness.hooks.adoptHandoff(harness.ctx, undefined, () => assert.fail("must not enter mode")), false);
  assert.match(warnings.join("\n"), new RegExp(`- ${box.source.name}: unavailable`));
  assert.match(warnings.join("\n"), /malformed handoff JSON/);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.messages.length, 0);
});

test("candidate listing never silently selects one or several records", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const harness = adoptionHarness(box);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  assert.equal(await harness.hooks.adoptHandoff(harness.ctx, undefined, () => assert.fail("must not enter mode")), false);
  assert.match(warnings.join("\n"), /one handoff record is available/);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.messages.length, 0);

  const second = createCorpusSession({ cwd: box.cwd, identity: "20260820T030405Z-1111111111111111", initialNameBytes: Uint8Array.from([9, 10, 11, 12]) });
  writeCorpusHandoffRecord(second.project, {
    ...box.record,
    author: { identity: "20260820T030405Z-1111111111111111", name: second.name },
    authorSessionDirectory: second.directory,
    snapshot: {
      ...box.record.snapshot,
      slateSessionId: "20260820T030405Z-1111111111111111",
      slateSessionName: second.name,
    },
  });
  warnings.length = 0;
  assert.equal(await harness.hooks.adoptHandoff(harness.ctx, undefined, () => assert.fail("must not enter mode")), false);
  assert.match(warnings.join("\n"), /several handoff records are available/);
  assert.match(warnings.join("\n"), new RegExp(box.source.name));
  assert.match(warnings.join("\n"), new RegExp(second.name));
});

test("adoption refuses foreign worktrees and branches with sanitized diagnostics", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  overwriteRecord(box, { ...box.record, worktreePath: `${box.root}/foreign\u001b[31m` });
  const foreignWorktree = adoptionHarness(box);
  assert.equal(await foreignWorktree.hooks.adoptHandoff(foreignWorktree.ctx, box.source.name, noModeChange), false);
  assert.match(warnings.join("\n"), /handoff belongs to worktree/);
  assert.doesNotMatch(warnings.join("\n"), /\u001b/);
  assert.equal(foreignWorktree.messages.length, 0);

  warnings.length = 0;
  overwriteRecord(box, { ...box.record, branchLabel: "foreign\u001b[31m" });
  const foreignBranch = adoptionHarness(box);
  assert.equal(await foreignBranch.hooks.adoptHandoff(foreignBranch.ctx, box.source.name, noModeChange), false);
  assert.match(warnings.join("\n"), /handoff belongs to branch/);
  assert.doesNotMatch(warnings.join("\n"), /\u001b/);
  assert.equal(foreignBranch.messages.length, 0);
});

test("adoption refuses any existing thread or episode", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const withThread = adoptionHarness(box);
  withThread.store.threads.set("t1", thread("t1"));
  assert.equal(await withThread.hooks.adoptHandoff(withThread.ctx, box.source.name, noModeChange), false);
  assert.equal(withThread.messages.length, 0);

  const withEpisode = adoptionHarness(box);
  withEpisode.store.episodes.set("t1.e1", {
    id: "t1.e1", threadId: "t1", task: "x", status: "ok", file: "x", createdAt: 1,
  });
  assert.equal(await withEpisode.hooks.adoptHandoff(withEpisode.ctx, box.source.name, noModeChange), false);
  assert.equal(withEpisode.messages.length, 0);
});

test("adoption rejects unreadable and future records but warns and accepts stale records", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  overwriteRecord(box, "{broken");
  const malformed = adoptionHarness(box);
  assert.equal(await malformed.hooks.adoptHandoff(malformed.ctx, box.source.name, noModeChange), false);
  assert.match(warnings.join("\n"), /malformed handoff JSON.*list candidates/);
  assert.equal(malformed.messages.length, 0);

  overwriteRecord(box, { ...box.record, createdAt: Date.now() + 60_000 });
  warnings.length = 0;
  const future = adoptionHarness(box);
  assert.equal(await future.hooks.adoptHandoff(future.ctx, box.source.name, noModeChange), false);
  assert.match(warnings.join("\n"), /future creation time/);
  assert.equal(future.messages.length, 0);

  overwriteRecord(box, { ...box.record, createdAt: Date.now() - 16 * 60_000 });
  warnings.length = 0;
  const stale = adoptionHarness(box);
  assert.equal(await stale.hooks.adoptHandoff(stale.ctx, box.source.name, noModeChange), true);
  assert.match(warnings.join("\n"), /older than 15 minutes.*adoption continues/);
  assert.equal(stale.messages.at(-1)?.customType, "slate-kickoff");
});

test("successful persistence precedes model switch, thinking switch, and kickoff", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  overwriteRecord(box, {
    ...box.record,
    model: { provider: "provider", id: "target" },
    thinkingLevel: "high",
  });
  const events: string[] = [];
  const harness = adoptionHarness(box, {
    currentModel: { provider: "provider", id: "other" },
    currentThinking: "low",
    foundModel: { provider: "provider", id: "target" },
    events,
  });

  assert.equal(await harness.hooks.adoptHandoff(harness.ctx, box.source.name, noModeChange), true);
  assert.deepEqual(harness.modelSwitches, ["provider/target"]);
  assert.deepEqual(harness.thinkingSwitches, ["high"]);
  assert.deepEqual(harness.adoptedModels, [
    { model: "provider/target", effort: "low" },
    { model: "provider/target", effort: "high" },
  ]);
  assert.deepEqual(events, [
    "save",
    "model-switch:provider/target",
    "restore:provider/target:low",
    "thinking-switch:high",
    "restore:provider/target:high",
    "kickoff",
  ]);
});

test("model and thinking restoration failures are reported without blocking kickoff", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  overwriteRecord(box, {
    ...box.record,
    model: { provider: "provider", id: "target" },
    thinkingLevel: "high",
  });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  const modelFailure = adoptionHarness(box, {
    currentModel: { provider: "provider", id: "other" },
    foundModel: { provider: "provider", id: "target" },
    failModelSwitch: true,
  });
  assert.equal(await modelFailure.hooks.adoptHandoff(modelFailure.ctx, box.source.name, noModeChange), true);
  assert.deepEqual(modelFailure.modelSwitches, ["provider/target"]);
  assert.match(warnings.join("\n"), /could not restore handoff model provider\/target.*forced model switch failure/);
  assert.equal(modelFailure.messages.at(-1)?.customType, "slate-kickoff");

  warnings.length = 0;
  const thinkingFailure = adoptionHarness(box, {
    currentModel: { provider: "provider", id: "target" },
    currentThinking: "low",
    failThinkingSwitch: true,
  });
  assert.equal(await thinkingFailure.hooks.adoptHandoff(thinkingFailure.ctx, box.source.name, noModeChange), true);
  assert.deepEqual(thinkingFailure.thinkingSwitches, ["high"]);
  assert.match(warnings.join("\n"), /could not restore thinking level high.*forced thinking switch failure/);
  assert.equal(thinkingFailure.messages.at(-1)?.customType, "slate-kickoff");
});

test("startHandoff writes a compact record and reports specific identity and size refusals", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const harness = adoptionHarness(box);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
  const ctx = {
    ...harness.ctx,
    waitForIdle: async () => {},
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "assistant", content: "verified handoff brief" } }],
      getEntries: () => [],
    },
  } as unknown as ExtensionCommandContext;
  await harness.hooks.startHandoff(ctx, "next focus");
  assert.match(warnings.join("\n"), /handoff record written/);
  const written = readFileSync(corpusHandoffFile(box.source.project, box.adopter.name), "utf8");
  assert.equal(written.includes("\n  \""), false);
  const parsed = JSON.parse(written) as CorpusHandoffRecord;
  assert.equal(parsed.brief, "verified handoff brief");
  assert.equal(parsed.focus, "next focus");

  warnings.length = 0;
  harness.store.slateSessionId = undefined;
  await harness.hooks.startHandoff(ctx);
  assert.match(warnings.join("\n"), /not written because this session has no persisted corpus identity/);

  harness.store.slateSessionId = ADOPTER_ID;
  (harness.store as unknown as { threadSeq: number }).threadSeq = 1;
  harness.store.threads.set("t1", { ...thread("t1"), episodeIds: ["t1.e1"], episodeSeq: 1 });
  harness.store.episodes.set("t1.e1", episodeRecord(box, { task: "x".repeat(1024 * 1024) }));
  warnings.length = 0;
  await harness.hooks.startHandoff(ctx);
  assert.match(warnings.join("\n"), /handoff record was not written.*larger than 1 MiB/);
});

test("persistence failure rolls back store, mode, reminder, tools contract, and durable branch state", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const events: string[] = [];
  const failing = adoptionHarness(box, { failSave: true, events });
  failing.store.paused = true;
  failing.store.writingReminder.markTokens = 42;
  failing.store.writingReminder.sentThisRound = true;
  failing.store.writingReminder.forceNext = false;
  const before = failing.store.snapshot();
  const warnings: string[] = [];
  let modeActive = false;
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  const adopted = await failing.hooks.adoptHandoff(failing.ctx, box.source.name, () => {
    modeActive = true;
    events.push("mode-on");
    return () => {
      modeActive = false;
      events.push("mode-undo");
    };
  });
  assert.equal(adopted, false);
  assert.equal(modeActive, false);
  assert.deepEqual(failing.store.snapshot(), before);
  assert.equal(failing.store.writingReminder.markTokens, 42);
  assert.equal(failing.store.writingReminder.sentThisRound, true);
  assert.equal(failing.store.writingReminder.forceNext, false);
  assert.equal(failing.messages.length, 0);
  assert.equal(failing.appended.length, 2);
  assert.notDeepEqual(failing.appended[0], before);
  assert.deepEqual(failing.appended[1], before);
  assert.deepEqual(events, ["mode-on", "save", "mode-undo", "save"]);
  assert.equal(readFileSync(corpusHandoffFile(box.source.project, box.source.name), "utf8").length > 0, true);
  assert.match(warnings.join("\n"), /could not persist.*Runtime state was rolled back.*No kickoff was sent/);
});
