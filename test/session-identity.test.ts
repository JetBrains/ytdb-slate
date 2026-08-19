import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import { createCorpusSession, resolveCorpusProject } from "../extension/corpus.ts";
import { isSlateSessionName } from "../extension/session-names.ts";
import slateExtension from "../extension/index.ts";
import {
  createOwnerSessionDigest,
  mintSlateSessionId,
  OWNER_SESSION_DIGEST_PATTERN,
  resolveSlateSessionIdentity,
  sanitizeSnapshotIdentity,
  SlateStore,
  SLATE_SESSION_ID_PATTERN,
  type SlateSnapshot,
} from "../extension/state.ts";

const ID = "20260818T101112Z-0123abcd0123abcd";
const FRESH_ID = "20260818T111213Z-deadbeefdeadbeef";
const OWNER = "a".repeat(64);
const FOREIGN_OWNER = "b".repeat(64);
const HANDOFF_SOURCE = fileURLToPath(new URL("../extension/handoff.ts", import.meta.url));
const PROCESS_CHILD = fileURLToPath(new URL("./fixtures/handoff-process-child.ts", import.meta.url));

function snapshot(overrides: Record<string, unknown> = {}): SlateSnapshot {
  return {
    threads: [],
    episodes: [],
    orchestratorMode: false,
    paused: false,
    workerCostUsd: 0,
    carriedCostUsd: 0,
    ...overrides,
  } as SlateSnapshot;
}

function sanitize(raw: SlateSnapshot | undefined) {
  const repairs: string[] = [];
  return { value: sanitizeSnapshotIdentity(raw, repairs), repairs };
}

test("minted slate session identities use compact UTC time and distinct cryptographic suffixes", () => {
  const now = new Date("2026-08-18T10:11:12.999Z");
  const minted = Array.from({ length: 8 }, () => mintSlateSessionId(now));
  for (const value of minted) {
    assert.match(value, SLATE_SESSION_ID_PATTERN);
    assert.match(value, /^20260818T101112Z-[0-9a-f]{16}$/);
  }
  assert.equal(new Set(minted).size, minted.length);
});

test("owner digests are bounded and separate duplicate pi identifiers by resolved session file", () => {
  const root = join(tmpdir(), "slate-owner-digest-test");
  const source = createOwnerSessionDigest("../../escape", join(root, "source.jsonl"));
  const fork = createOwnerSessionDigest("../../escape", join(root, "fork.jsonl"));
  const oversized = createOwnerSessionDigest("x".repeat(1_000_000), join(root, "source.jsonl"));
  assert.match(source, OWNER_SESSION_DIGEST_PATTERN);
  assert.match(oversized, OWNER_SESSION_DIGEST_PATTERN);
  assert.equal(source.length, 64);
  assert.equal(oversized.length, 64);
  assert.notEqual(source, fork);
  assert.equal(
    createOwnerSessionDigest("id", join(root, "nested", "..", "source.jsonl")),
    createOwnerSessionDigest("id", join(root, "source.jsonl")),
  );
});

test("snapshot identity sanitization accepts both valid fields and leaves absent fields silent", () => {
  const accepted = sanitize(snapshot({ slateSessionId: ID, slateSessionName: "calm-otter-7f3a", ownerSessionDigest: OWNER }));
  assert.deepEqual(accepted.value, {
    snapshotPresent: true,
    slateSessionIdPresent: true,
    ownerSessionDigestPresent: true,
    slateSessionId: ID,
    slateSessionName: "calm-otter-7f3a",
    ownerSessionDigest: OWNER,
  });
  assert.deepEqual(accepted.repairs, []);

  const absent = sanitize(snapshot());
  assert.deepEqual(absent.value, {
    snapshotPresent: true,
    slateSessionIdPresent: false,
    ownerSessionDigestPresent: false,
  });
  assert.deepEqual(absent.repairs, []);
});

test("snapshot identity sanitization rejects malformed identity and owner digest values by field name", () => {
  const badIdentities: unknown[] = [
    "20260818T101112Z-0123ABCD0123abcd",
    "2026-08-18T10:11:12Z-0123abcd0123abcd",
    "20260818T101112Z-0123abcd0123abc/",
    "20260818T101112Z-0123abcd",
    7,
    null,
  ];
  for (const slateSessionId of badIdentities) {
    const result = sanitize(snapshot({ slateSessionId, ownerSessionDigest: OWNER }));
    assert.equal(result.value.slateSessionId, undefined, String(slateSessionId));
    assert.equal(result.value.slateSessionIdPresent, true, String(slateSessionId));
    assert.equal(result.repairs.length, 1, String(slateSessionId));
    assert.match(result.repairs[0] ?? "", /slateSessionId/);
  }

  for (const slateSessionName of ["bad/name-7f3a", "calm-otter-7F3A", 7, null]) {
    const result = sanitize(snapshot({ slateSessionId: ID, slateSessionName, ownerSessionDigest: OWNER }));
    assert.equal(result.value.slateSessionName, undefined);
    assert.equal(result.repairs.length, 1);
    assert.match(result.repairs[0] ?? "", /slateSessionName/);
  }

  const badOwners: unknown[] = ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "owner/path", 7, null];
  for (const ownerSessionDigest of badOwners) {
    const result = sanitize(snapshot({ slateSessionId: ID, ownerSessionDigest }));
    assert.equal(result.value.ownerSessionDigest, undefined, String(ownerSessionDigest));
    assert.equal(result.value.ownerSessionDigestPresent, true, String(ownerSessionDigest));
    assert.equal(result.repairs.length, 1, String(ownerSessionDigest));
    assert.match(result.repairs[0] ?? "", /ownerSessionDigest/);
  }
});

test("snapshot adoption reports rejected identity fields through the existing repair notification", () => {
  const notices: string[] = [];
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: { notify(message: string) { notices.push(message); } },
  } as unknown as ExtensionContext;
  store.adoptSnapshot(
    snapshot({ slateSessionId: "bad/id", ownerSessionDigest: "bad owner" }),
    ctx,
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /snapshot: ignoring slateSessionId \(string\)/);
  assert.match(notices[0] ?? "", /snapshot: ignoring ownerSessionDigest \(string\)/);
});

test("identity resolution mints only for fresh, malformed, ownerless, malformed-owner, and foreign snapshots", () => {
  const mint = () => FRESH_ID;

  const fresh = resolveSlateSessionIdentity(sanitize(undefined).value, OWNER, mint);
  assert.deepEqual(fresh, { slateSessionId: FRESH_ID, ownerSessionDigest: OWNER, minted: true });

  const legacy = resolveSlateSessionIdentity(sanitize(snapshot()).value, OWNER, mint);
  assert.deepEqual(legacy, { minted: false });

  const owned = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: ID, ownerSessionDigest: OWNER })).value,
    OWNER,
    mint,
  );
  assert.deepEqual(owned, { slateSessionId: ID, ownerSessionDigest: OWNER, minted: false });

  const foreign = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: ID, ownerSessionDigest: FOREIGN_OWNER })).value,
    OWNER,
    mint,
  );
  assert.equal(foreign.slateSessionId, FRESH_ID);
  assert.equal(foreign.ownerSessionDigest, OWNER);
  assert.equal(foreign.minted, true);
  assert.match(foreign.report ?? "", /different ownerSessionDigest/);

  const ownerless = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: ID })).value,
    OWNER,
    mint,
  );
  assert.equal(ownerless.slateSessionId, FRESH_ID);
  assert.equal(ownerless.minted, true);
  assert.match(ownerless.report ?? "", /no ownerSessionDigest/);

  const malformedOwner = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: ID, ownerSessionDigest: "bad owner" })).value,
    OWNER,
    mint,
  );
  assert.equal(malformedOwner.slateSessionId, FRESH_ID);
  assert.equal(malformedOwner.minted, true);
  assert.match(malformedOwner.report ?? "", /malformed ownerSessionDigest/);

  const malformedIdentity = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: "bad/id", ownerSessionDigest: OWNER })).value,
    OWNER,
    mint,
  );
  assert.equal(malformedIdentity.slateSessionId, FRESH_ID);
  assert.equal(malformedIdentity.minted, true);
  assert.match(malformedIdentity.report ?? "", /malformed slateSessionId/);
});

test("store identity resolution persists before committing and preserves a legacy snapshot", () => {
  const appended: Array<Record<string, unknown>> = [];
  const store = new SlateStore({
    appendEntry(_type: string, data: Record<string, unknown>) { appended.push(data); },
  } as unknown as ExtensionAPI);
  const reports: string[] = [];
  assert.equal(store.resolveSessionIdentity(OWNER, (message) => reports.push(message), () => FRESH_ID), true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.slateSessionId, FRESH_ID);
  assert.equal(appended[0]?.ownerSessionDigest, OWNER);
  assert.equal(store.slateSessionId, FRESH_ID);
  assert.equal(store.ownerSessionDigest, OWNER);
  assert.equal(reports.length, 0);

  store.adoptSnapshot(snapshot(), { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext);
  assert.equal(store.resolveSessionIdentity(OWNER, (message) => reports.push(message), () => FRESH_ID), false);
  assert.equal(store.snapshot().slateSessionId, undefined);
  assert.equal(store.snapshot().ownerSessionDigest, undefined);
});

test("failed mint persistence leaves no in-memory identity, notifies, and does not retry", () => {
  const reports: string[] = [];
  let mintCalls = 0;
  let changes = 0;
  const store = new SlateStore({
    appendEntry() { throw new Error("disk full"); },
  } as unknown as ExtensionAPI);
  store.onDidChange = () => { changes += 1; };
  const mint = () => {
    mintCalls += 1;
    return FRESH_ID;
  };
  assert.doesNotThrow(() => store.resolveSessionIdentity(OWNER, (message) => reports.push(message), mint));
  assert.equal(store.slateSessionId, undefined);
  assert.equal(store.ownerSessionDigest, undefined);
  assert.equal(store.snapshot().slateSessionId, undefined);
  assert.equal(store.snapshot().ownerSessionDigest, undefined);
  assert.equal(mintCalls, 1);
  assert.equal(changes, 1);
  assert.match(reports.join("\n"), /could not persist.*disk full.*refuse artifact writes/);

  assert.equal(store.resolveSessionIdentity(OWNER, (message) => reports.push(message), mint), false);
  assert.equal(mintCalls, 1);
  assert.equal(changes, 1);
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function handoffHarness(options: { failSave?: boolean; beforeSave?: () => void } = {}) {
  const appended: Array<Record<string, unknown>> = [];
  const store = new SlateStore({
    appendEntry(_type: string, data: Record<string, unknown>) {
      options.beforeSave?.();
      if (options.failSave) throw new Error("forced adoption save failure");
      appended.push(data);
    },
  } as unknown as ExtensionAPI);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  registerSlateHandoff(pi, store, () => ({}), () => ({} as BaseModelTracker));
  const handler = handlers.get("session_start")?.[0];
  assert.ok(handler);
  return { appended, store, handler };
}

function handoffContext(cwd: string, sessionId: string, sessionFile: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    model: undefined,
    isProjectTrusted: () => true,
    sessionManager: {
      getHeader: () => ({ parentSession: "/tmp/parent.jsonl" }),
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
}

function pendingHandoffContent(slateSessionId = ID, brief = ""): string {
  return JSON.stringify({
    parentSession: "/tmp/parent.jsonl",
    createdAt: Date.now(),
    brief,
    snapshot: snapshot({
      slateSessionId,
      ownerSessionDigest: FOREIGN_OWNER,
      orchestratorMode: true,
    }),
  });
}

function writePendingHandoff(cwd: string, content = pendingHandoffContent()): string {
  const file = join(cwd, CONFIG_DIR_NAME, "slate", "pending-handoff.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function claimMarker(file: string): string {
  return `${file}.claim`;
}

function claimFiles(file: string): string[] {
  return readdirSync(dirname(file)).filter((name) => name.endsWith("pending-handoff.json.claim"));
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function spawnHandoffChild(
  mode: "race" | "hold",
  cwd: string,
  resultFile: string,
  readyFile: string,
  goFile: string,
  sessionId: string,
): { child: ChildProcess; completed: Promise<{ code: number | null; stderr: string }> } {
  const child = spawn(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", PROCESS_CHILD, mode, cwd, resultFile, readyFile, goFile, sessionId],
    { cwd: dirname(dirname(PROCESS_CHILD)), stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const completed = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  return { child, completed };
}

test("a snapshot without a name recovers durable session metadata and persists the name", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-name-recovery-test-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(project);
  mkdirSync(agent);
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const created = createCorpusSession({ cwd: project, identity: ID, initialNameBytes: Uint8Array.from([1, 2, 3, 4]) });
    const appended: Array<Record<string, unknown>> = [];
    const store = new SlateStore({ appendEntry(_type: string, data: Record<string, unknown>) { appended.push(data); } } as unknown as ExtensionAPI);
    store.adoptSnapshot(snapshot({ slateSessionId: ID, ownerSessionDigest: OWNER }), { cwd: project, hasUI: false } as unknown as ExtensionContext);
    assert.equal(store.resolveSessionIdentity(OWNER, () => {}, undefined, { cwd: project }), false);
    assert.equal(store.slateSessionName, created.name);
    assert.equal(appended.at(-1)?.slateSessionName, created.name);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an identity-less snapshot reuses its persisted valid session name", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-legacy-name-recovery-test-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(project);
  mkdirSync(agent);
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const created = createCorpusSession({ cwd: project, identity: "", initialNameBytes: Uint8Array.from([3, 4, 5, 6]) });
    const appended: Array<Record<string, unknown>> = [];
    const store = new SlateStore({ appendEntry(_type: string, data: Record<string, unknown>) { appended.push(data); } } as unknown as ExtensionAPI);
    store.adoptSnapshot(snapshot({ slateSessionName: created.name }), { cwd: project, hasUI: false } as unknown as ExtensionContext);
    store.resolveSessionIdentity(OWNER, () => {}, undefined, { cwd: project });
    assert.equal(store.slateSessionId, undefined);
    assert.equal(store.slateSessionName, created.name);
    assert.equal(appended.at(-1)?.slateSessionName, created.name);
    assert.equal(readdirSync(created.project.directory).filter(isSlateSessionName).length, 1);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing named session directory is replaced and reported", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-name-missing-test-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(project);
  mkdirSync(agent);
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const appended: Array<Record<string, unknown>> = [];
    const reports: string[] = [];
    const store = new SlateStore({ appendEntry(_type: string, data: Record<string, unknown>) { appended.push(data); } } as unknown as ExtensionAPI);
    store.adoptSnapshot(snapshot({ slateSessionId: ID, slateSessionName: "calm-otter-7f3a", ownerSessionDigest: OWNER }), { cwd: project, hasUI: false } as unknown as ExtensionContext);
    store.resolveSessionIdentity(OWNER, (message) => reports.push(message), undefined, { cwd: project });
    assert.notEqual(store.slateSessionName, "calm-otter-7f3a");
    assert.match(reports.join("\n"), /missing or does not match/);
    assert.equal(appended.at(-1)?.slateSessionName, store.slateSessionName);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate durable identity claims are reported and refused", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-name-duplicate-test-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(project);
  mkdirSync(agent);
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    createCorpusSession({ cwd: project, identity: ID, initialNameBytes: Uint8Array.from([1, 1, 0, 1]) });
    createCorpusSession({ cwd: project, identity: ID, initialNameBytes: Uint8Array.from([2, 2, 0, 2]) });
    const reports: string[] = [];
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    store.adoptSnapshot(snapshot({ slateSessionId: ID, ownerSessionDigest: OWNER }), { cwd: project, hasUI: false } as unknown as ExtensionContext);
    assert.throws(() => store.resolveSessionIdentity(OWNER, (message) => reports.push(message), undefined, { cwd: project }), /duplicate session identity/);
    assert.match(reports.join("\n"), /duplicate session directories/);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime persistence failure removes its new namespace and refuses later writes", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-name-persist-fail-test-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(project);
  mkdirSync(agent);
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const reports: string[] = [];
    const store = new SlateStore({ appendEntry() { throw new Error("disk full"); } } as unknown as ExtensionAPI);
    store.resolveSessionIdentity(OWNER, (message) => reports.push(message), undefined, { cwd: project });
    assert.throws(() => store.artifactSessionName(), /namespace is unavailable/);
    assert.match(reports.join("\n"), /refuse artifact writes/);
    const directory = resolveCorpusProject(project).directory;
    assert.equal(readdirSync(directory).filter(isSlateSessionName).length, 0);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreign snapshot adoption drops predecessor identity, owner, and name", () => {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.adoptSnapshot(
    snapshot({ slateSessionId: ID, slateSessionName: "calm-otter-7f3a", ownerSessionDigest: OWNER }),
    { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext,
    { foreignSessionIdentity: true },
  );
  assert.equal(store.slateSessionId, undefined);
  assert.equal(store.ownerSessionDigest, undefined);
  assert.equal(store.slateSessionName, undefined);
  assert.equal(store.snapshot().slateSessionId, undefined);
  assert.equal(store.snapshot().ownerSessionDigest, undefined);
  assert.equal(store.snapshot().slateSessionName, undefined);
});

test("failed adoption preserves pending content and a following session adopts it", { timeout: 1000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-recovery-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const original = pendingHandoffContent();
  const file = writePendingHandoff(cwd, original);
  const failing = handoffHarness({ failSave: true });
  await failing.handler({}, handoffContext(cwd, "failed-successor", join(cwd, "failed.jsonl")));

  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(claimFiles(file), []);

  const following = handoffHarness();
  await following.handler({}, handoffContext(cwd, "following-successor", join(cwd, "following.jsonl")));
  assert.equal(following.appended.length, 1);
  assert.equal(following.store.slateSessionId, undefined);
  assert.equal(existsSync(file), false);
  assert.deepEqual(claimFiles(file), []);
});

test("failed adoption never overwrites a newer pending handoff", { timeout: 1000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-newer-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = writePendingHandoff(cwd);
  const newer = pendingHandoffContent(FRESH_ID, "newer-pending-handoff");
  const failing = handoffHarness({
    failSave: true,
    beforeSave: () => writeFileSync(file, newer),
  });
  await failing.handler({}, handoffContext(cwd, "failed-successor", join(cwd, "failed.jsonl")));

  assert.equal(readFileSync(file, "utf8"), newer);
  assert.deepEqual(claimFiles(file), []);

  const following = handoffHarness();
  await following.handler({}, handoffContext(cwd, "following-successor", join(cwd, "following.jsonl")));
  assert.equal(following.store.slateSessionId, undefined);
  assert.equal(existsSync(file), false);
});

test("successful adoption removes both pending handoff and claim marker", { timeout: 1000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-success-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = writePendingHandoff(cwd);
  const successor = handoffHarness();
  await successor.handler({}, handoffContext(cwd, "successor", join(cwd, "successor.jsonl")));

  assert.equal(successor.appended.length, 1);
  assert.equal(existsSync(file), false);
  assert.deepEqual(claimFiles(file), []);
});

test("exclusive pending-handoff marker lets exactly one operating-system process adopt", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-race-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = writePendingHandoff(cwd);
  const goFile = join(cwd, "go");
  const firstResult = join(cwd, "first-result.json");
  const secondResult = join(cwd, "second-result.json");
  const firstReady = join(cwd, "first-ready");
  const secondReady = join(cwd, "second-ready");
  const first = spawnHandoffChild("race", cwd, firstResult, firstReady, goFile, "successor-one");
  const second = spawnHandoffChild("race", cwd, secondResult, secondReady, goFile, "successor-two");
  t.after(() => { first.child.kill("SIGKILL"); second.child.kill("SIGKILL"); });

  await Promise.all([waitForFile(firstReady), waitForFile(secondReady)]);
  writeFileSync(goFile, "go");
  const [firstExit, secondExit] = await Promise.all([first.completed, second.completed]);
  assert.equal(firstExit.code, 0, firstExit.stderr);
  assert.equal(secondExit.code, 0, secondExit.stderr);
  const results = [firstResult, secondResult].map((path) => JSON.parse(readFileSync(path, "utf8")) as {
    adoptions: number;
    slateSessionId?: string;
    ownerSessionDigest?: string;
  });
  assert.equal(results.reduce((sum, result) => sum + result.adoptions, 0), 1);
  const winner = results.find((result) => result.adoptions === 1);
  assert.ok(winner);
  assert.equal(winner.slateSessionId, undefined);
  assert.equal(winner.ownerSessionDigest, undefined);
  assert.equal(existsSync(file), false);
  assert.deepEqual(claimFiles(file), []);

  const source = readFileSync(HANDOFF_SOURCE, "utf8");
  assert.match(source, /openSync\(marker, "wx"\)/, "the marker claim must use exclusive creation");
  assert.doesNotMatch(source, /if \(existsSync\(marker\)\) return false;/, "an existence check is not an atomic claim");
});

test("terminated claimant leaves pending data for adoption after marker ages out", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-abandoned-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const original = pendingHandoffContent();
  const file = writePendingHandoff(cwd, original);
  const marker = claimMarker(file);
  const resultFile = join(cwd, "held-result.json");
  const readyFile = join(cwd, "held-ready");
  const holder = spawnHandoffChild("hold", cwd, resultFile, readyFile, join(cwd, "unused-go"), "terminated-successor");
  t.after(() => holder.child.kill("SIGKILL"));

  await waitForFile(readyFile);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(existsSync(marker), true);
  holder.child.kill("SIGKILL");
  const holderExit = await holder.completed;
  assert.equal(holderExit.code, null);

  const abandonedAt = new Date(Date.now() - 16 * 60 * 1000);
  utimesSync(marker, abandonedAt, abandonedAt);
  const following = handoffHarness();
  await following.handler({}, handoffContext(cwd, "following-successor", join(cwd, "following.jsonl")));
  assert.equal(following.appended.length, 1);
  assert.equal(following.store.slateSessionId, undefined);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(marker), false);
});

class EntryExtensionApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly appended: Array<Record<string, unknown>> = [];
  private activeTools: string[] = [];

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(): void {}
  registerTool(): void {}
  getActiveTools(): string[] { return [...this.activeTools]; }
  setActiveTools(tools: string[]): void { this.activeTools = [...tools]; }
  getAllTools(): Array<{ name: string }> { return []; }
  appendEntry(_type: string, data: Record<string, unknown>): void { this.appended.push(data); }
  sendMessage(): void {}
  getThinkingLevel(): undefined { return undefined; }
}

function entryContext(cwd: string, sessionId: string, sessionFile: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getHeader: () => ({ parentSession: "/tmp/parent.jsonl" }),
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  } as unknown as ExtensionContext;
}

async function startEntry(api: EntryExtensionApi, ctx: ExtensionContext): Promise<void> {
  const handlers = api.handlers.get("session_start");
  assert.ok(handlers);
  for (const handler of handlers) await handler({}, ctx);
}

test("entry-point session-start wiring mints fresh name and resolves only after handoff adoption", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "slate-identity-entry-test-"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  t.after(() => {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  });

  const freshCwd = join(root, "fresh");
  mkdirSync(freshCwd, { recursive: true });
  const freshApi = new EntryExtensionApi();
  slateExtension(freshApi as unknown as ExtensionAPI);
  const freshFile = join(root, "fresh-session.jsonl");
  await startEntry(freshApi, entryContext(freshCwd, "../../hostile", freshFile));
  assert.equal(freshApi.appended.length, 1);
  assert.match(String(freshApi.appended[0]?.slateSessionId), SLATE_SESSION_ID_PATTERN);
  assert.match(String(freshApi.appended[0]?.slateSessionName), /^[a-z][a-z0-9-]*-[0-9a-f]{4}$/);
  assert.equal(
    freshApi.appended[0]?.ownerSessionDigest,
    createOwnerSessionDigest("../../hostile", freshFile),
  );

  const adoptedCwd = join(root, "adopted");
  const pending = join(adoptedCwd, CONFIG_DIR_NAME, "slate", "pending-handoff.json");
  mkdirSync(dirname(pending), { recursive: true });
  writeFileSync(pending, JSON.stringify({
    parentSession: "/tmp/parent.jsonl",
    createdAt: Date.now(),
    brief: "",
    snapshot: snapshot({
      slateSessionId: ID,
      slateSessionName: "calm-otter-7f3a",
      ownerSessionDigest: FOREIGN_OWNER,
      orchestratorMode: true,
    }),
  }));
  const adoptedApi = new EntryExtensionApi();
  slateExtension(adoptedApi as unknown as ExtensionAPI);
  const adoptedFile = join(root, "adopted-session.jsonl");
  await startEntry(adoptedApi, entryContext(adoptedCwd, "successor", adoptedFile));
  assert.equal(adoptedApi.appended.length, 2);
  const adoptedState = adoptedApi.appended.at(-1);
  assert.match(String(adoptedState?.slateSessionId), SLATE_SESSION_ID_PATTERN);
  assert.notEqual(adoptedState?.slateSessionId, ID);
  assert.match(String(adoptedState?.slateSessionName), /^[a-z][a-z0-9-]*-[0-9a-f]{4}$/);
  assert.notEqual(adoptedState?.slateSessionName, "calm-otter-7f3a");
  assert.equal(
    adoptedState?.ownerSessionDigest,
    createOwnerSessionDigest("successor", adoptedFile),
  );
});
