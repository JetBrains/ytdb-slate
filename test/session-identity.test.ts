import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
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
  const accepted = sanitize(snapshot({ slateSessionId: ID, ownerSessionDigest: OWNER }));
  assert.deepEqual(accepted.value, {
    snapshotPresent: true,
    slateSessionIdPresent: true,
    ownerSessionDigestPresent: true,
    slateSessionId: ID,
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
  assert.match(reports.join("\n"), /could not persist.*disk full.*legacy paths/);

  assert.equal(store.resolveSessionIdentity(OWNER, (message) => reports.push(message), mint), false);
  assert.equal(mintCalls, 1);
  assert.equal(changes, 1);
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function handoffHarness(options: { failSave?: boolean } = {}) {
  const appended: Array<Record<string, unknown>> = [];
  const store = new SlateStore({
    appendEntry(_type: string, data: Record<string, unknown>) {
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

function writePendingHandoff(cwd: string): string {
  const file = join(cwd, CONFIG_DIR_NAME, "slate", "pending-handoff.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    parentSession: "/tmp/parent.jsonl",
    createdAt: Date.now(),
    brief: "",
    snapshot: snapshot({
      slateSessionId: ID,
      ownerSessionDigest: FOREIGN_OWNER,
      orchestratorMode: true,
    }),
  }));
  return file;
}

function claimFiles(file: string): string[] {
  return readdirSync(dirname(file)).filter((name) => name.includes(".claim-"));
}

test("failed adoption releases its claim and a following session can adopt", { timeout: 1000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-recovery-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = writePendingHandoff(cwd);
  const failing = handoffHarness({ failSave: true });
  await failing.handler({}, handoffContext(cwd, "failed-successor", join(cwd, "failed.jsonl")));

  assert.equal(existsSync(file), true);
  assert.deepEqual(claimFiles(file), []);

  const following = handoffHarness();
  await following.handler({}, handoffContext(cwd, "following-successor", join(cwd, "following.jsonl")));
  assert.equal(following.appended.length, 1);
  assert.equal(following.store.slateSessionId, ID);
  assert.equal(existsSync(file), false);
  assert.deepEqual(claimFiles(file), []);
});

test("successful adoption removes the claimed pending handoff", { timeout: 1000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-success-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = writePendingHandoff(cwd);
  const successor = handoffHarness();
  await successor.handler({}, handoffContext(cwd, "successor", join(cwd, "successor.jsonl")));

  assert.equal(successor.appended.length, 1);
  assert.equal(existsSync(file), false);
  assert.deepEqual(claimFiles(file), []);
});

test("atomic pending-handoff claim lets exactly one racing successor adopt and re-stamp", { timeout: 1000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-race-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const first = handoffHarness();
  const second = handoffHarness();
  const file = writePendingHandoff(cwd);
  const firstContext = handoffContext(cwd, "successor-one", join(cwd, "one.jsonl"));
  const secondContext = handoffContext(cwd, "successor-two", join(cwd, "two.jsonl"));
  await Promise.all([
    first.handler({}, firstContext),
    second.handler({}, secondContext),
  ]);

  const winners = [first, second].filter((entry) => entry.appended.length === 1);
  assert.equal(winners.length, 1);
  const winner = winners[0];
  assert.ok(winner);
  assert.equal(winner.store.slateSessionId, ID);
  const expectedOwners = [
    createOwnerSessionDigest("successor-one", join(cwd, "one.jsonl")),
    createOwnerSessionDigest("successor-two", join(cwd, "two.jsonl")),
  ];
  assert.ok(expectedOwners.includes(winner.store.ownerSessionDigest ?? ""));
  assert.equal(winner.appended[0]?.ownerSessionDigest, winner.store.ownerSessionDigest);
  assert.equal(existsSync(file), false);
  assert.deepEqual(claimFiles(file), []);
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

test("entry-point session-start wiring mints fresh and resolves only after handoff adoption", { timeout: 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "slate-identity-entry-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const freshCwd = join(root, "fresh");
  mkdirSync(freshCwd, { recursive: true });
  const freshApi = new EntryExtensionApi();
  slateExtension(freshApi as unknown as ExtensionAPI);
  const freshFile = join(root, "fresh-session.jsonl");
  await startEntry(freshApi, entryContext(freshCwd, "../../hostile", freshFile));
  assert.equal(freshApi.appended.length, 1);
  assert.match(String(freshApi.appended[0]?.slateSessionId), SLATE_SESSION_ID_PATTERN);
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
      ownerSessionDigest: FOREIGN_OWNER,
      orchestratorMode: true,
    }),
  }));
  const adoptedApi = new EntryExtensionApi();
  slateExtension(adoptedApi as unknown as ExtensionAPI);
  const adoptedFile = join(root, "adopted-session.jsonl");
  await startEntry(adoptedApi, entryContext(adoptedCwd, "successor", adoptedFile));
  assert.equal(adoptedApi.appended.length, 1);
  assert.equal(adoptedApi.appended[0]?.slateSessionId, ID);
  assert.equal(
    adoptedApi.appended[0]?.ownerSessionDigest,
    createOwnerSessionDigest("successor", adoptedFile),
  );
});
