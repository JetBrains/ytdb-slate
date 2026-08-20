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

function adoptionHarness(box: Sandbox, options: { failSave?: boolean } = {}) {
  const messages: Array<{ customType?: string; content?: string }> = [];
  const appended: Array<Record<string, unknown>> = [];
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
    getThinkingLevel() { return undefined; },
  } as unknown as ExtensionAPI;
  const hooks = registerSlateHandoff(pi, store, () => ({}), () => ({} as BaseModelTracker));
  const ctx = {
    cwd: box.cwd,
    hasUI: false,
    model: undefined,
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;
  return { appended, ctx, hooks, messages, store };
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
