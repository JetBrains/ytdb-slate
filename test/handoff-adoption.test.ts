import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { createCorpusSession } from "../extension/corpus.ts";
import {
  corpusHandoffFile,
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
    branchLabel: "test-branch",
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
} = {}) {
  const messages: Array<{ customType?: string; content?: string }> = [];
  const appended: Array<Record<string, unknown>> = [];
  const adoptedModels: Array<{ model: string; effort: unknown }> = [];
  const modelSwitches: string[] = [];
  const thinkingSwitches: string[] = [];
  const store = new SlateStore({
    appendEntry(_type: string, data: Record<string, unknown>) {
      if (options.failSave) throw new Error("forced persistence failure");
      appended.push(data);
    },
  } as unknown as ExtensionAPI);
  store.corpusProject = box.source.project;
  store.slateSessionId = ADOPTER_ID;
  store.slateSessionName = box.adopter.name;
  store.ownerSessionDigest = ADOPTER_OWNER;
  const pi = {
    on() {},
    sendMessage(message: { customType?: string; content?: string }) { messages.push(message); },
    getThinkingLevel() { return thinkingSwitches.at(-1); },
    async setModel(model: { provider: string; id: string }) {
      modelSwitches.push(`${model.provider}/${model.id}`);
      if (options.failModelSwitch) throw new Error("forced model switch failure");
      return true;
    },
    setThinkingLevel(level: string) {
      thinkingSwitches.push(level);
      if (options.failThinkingSwitch) throw new Error("forced thinking switch failure");
    },
  } as unknown as ExtensionAPI;
  const tracker = {
    async ownSwitch<T>(_from: string | undefined, _to: string, perform: () => Promise<T>): Promise<T> { return perform(); },
    adopt(model: string, effort: unknown) { adoptedModels.push({ model, effort }); },
  } as unknown as BaseModelTracker;
  const hooks = registerSlateHandoff(
    pi,
    store,
    () => ({ preserveGlobalModelDefault: false }),
    () => tracker,
  );
  const ctx = {
    cwd: box.cwd,
    hasUI: false,
    model: options.currentModel,
    modelRegistry: { find: () => options.foundModel },
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;
  return { adoptedModels, appended, ctx, hooks, messages, modelSwitches, store, thinkingSwitches };
}

function overwriteRecord(box: Sandbox, value: unknown): string {
  const file = corpusHandoffFile(box.source.project, box.source.name);
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  return file;
}

test("foreign adoption preserves the adopter namespace and appends predecessor lineage", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const harness = adoptionHarness(box);
  let entered = 0;
  const adopted = await harness.hooks.adoptHandoff(harness.ctx, box.source.name, () => { entered += 1; });

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

  assert.equal(await harness.hooks.adoptHandoff(untrusted, box.source.name, () => {}), false);
  assert.match(warnings.join("\n"), /requires a trusted project/);
  assert.doesNotMatch(warnings.join("\n"), /malformed/);
  assert.equal(harness.messages.length, 0);
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
    snapshot: { ...box.record.snapshot, threads },
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

test("linked transcript paths fail containment validation", (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const real = join(box.source.directory, "threads", "real.jsonl");
  const linked = join(box.source.directory, "threads", "linked.jsonl");
  writeFileSync(real, "{}\n");
  symlinkSync(real, linked);
  overwriteRecord(box, {
    ...box.record,
    snapshot: { ...box.record.snapshot, threads: [thread("t1", linked)] },
  });
  const result = readCorpusHandoffRecord({ cwd: box.cwd, name: box.source.name, isTrusted: () => true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /session file is missing, linked, or outside/);
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

test("adoption refuses any existing thread or episode", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const withThread = adoptionHarness(box);
  withThread.store.threads.set("t1", thread("t1"));
  assert.equal(await withThread.hooks.adoptHandoff(withThread.ctx, box.source.name, () => {}), false);
  assert.equal(withThread.messages.length, 0);

  const withEpisode = adoptionHarness(box);
  withEpisode.store.episodes.set("t1.e1", {
    id: "t1.e1", threadId: "t1", task: "x", status: "ok", file: "x", createdAt: 1,
  });
  assert.equal(await withEpisode.hooks.adoptHandoff(withEpisode.ctx, box.source.name, () => {}), false);
  assert.equal(withEpisode.messages.length, 0);
});

test("adoption rejects unreadable and future records but warns and accepts stale records", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  overwriteRecord(box, "{broken");
  const malformed = adoptionHarness(box);
  assert.equal(await malformed.hooks.adoptHandoff(malformed.ctx, box.source.name, () => {}), false);
  assert.match(warnings.join("\n"), /malformed handoff JSON.*list candidates/);
  assert.equal(malformed.messages.length, 0);

  overwriteRecord(box, { ...box.record, createdAt: Date.now() + 60_000 });
  warnings.length = 0;
  const future = adoptionHarness(box);
  assert.equal(await future.hooks.adoptHandoff(future.ctx, box.source.name, () => {}), false);
  assert.match(warnings.join("\n"), /future creation time/);
  assert.equal(future.messages.length, 0);

  overwriteRecord(box, { ...box.record, createdAt: Date.now() - 16 * 60_000 });
  warnings.length = 0;
  const stale = adoptionHarness(box);
  assert.equal(await stale.hooks.adoptHandoff(stale.ctx, box.source.name, () => {}), true);
  assert.match(warnings.join("\n"), /older than 15 minutes.*adoption continues/);
  assert.equal(stale.messages.at(-1)?.customType, "slate-kickoff");
});

test("adoption restores matching, discoverable, and failing model outcomes without blocking kickoff", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  overwriteRecord(box, {
    ...box.record,
    model: { provider: "provider", id: "target" },
    thinkingLevel: "high",
  });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  const matching = adoptionHarness(box, { currentModel: { provider: "provider", id: "target" } });
  assert.equal(await matching.hooks.adoptHandoff(matching.ctx, box.source.name, () => {}), true);
  assert.deepEqual(matching.modelSwitches, []);
  assert.deepEqual(matching.thinkingSwitches, ["high"]);
  assert.deepEqual(matching.adoptedModels, [
    { model: "provider/target", effort: undefined },
    { model: "provider/target", effort: "high" },
  ]);
  assert.equal(matching.messages.at(-1)?.customType, "slate-kickoff");

  warnings.length = 0;
  const unavailable = adoptionHarness(box, { currentModel: { provider: "provider", id: "other" } });
  assert.equal(await unavailable.hooks.adoptHandoff(unavailable.ctx, box.source.name, () => {}), true);
  assert.match(warnings.join("\n"), /could not restore handoff model provider\/target/);
  assert.deepEqual(unavailable.adoptedModels, []);
  assert.equal(unavailable.messages.at(-1)?.customType, "slate-kickoff");

  warnings.length = 0;
  const throwing = adoptionHarness(box, {
    currentModel: { provider: "provider", id: "other" },
    foundModel: { provider: "provider", id: "target" },
    failModelSwitch: true,
  });
  assert.equal(await throwing.hooks.adoptHandoff(throwing.ctx, box.source.name, () => {}), true);
  assert.deepEqual(throwing.modelSwitches, ["provider/target"]);
  assert.match(warnings.join("\n"), /could not restore handoff model provider\/target.*forced model switch failure/);
  assert.equal(throwing.messages.at(-1)?.customType, "slate-kickoff");

  warnings.length = 0;
  const badThinking = adoptionHarness(box, {
    currentModel: { provider: "provider", id: "target" },
    failThinkingSwitch: true,
  });
  assert.equal(await badThinking.hooks.adoptHandoff(badThinking.ctx, box.source.name, () => {}), true);
  assert.match(warnings.join("\n"), /could not restore thinking level high.*forced thinking switch failure/);
  assert.equal(badThinking.messages.at(-1)?.customType, "slate-kickoff");
});

test("kickoff is sent only after persistence succeeds", async (t) => {
  const box = sandbox();
  t.after(() => box.restore());
  const failing = adoptionHarness(box, { failSave: true });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));

  assert.equal(await failing.hooks.adoptHandoff(failing.ctx, box.source.name, () => {}), false);
  assert.equal(failing.messages.length, 0);
  assert.equal(readFileSync(corpusHandoffFile(box.source.project, box.source.name), "utf8").length > 0, true);
  assert.match(warnings.join("\n"), /could not persist.*No kickoff was sent/);
});
