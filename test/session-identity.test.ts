import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import {
  mintSlateSessionId,
  resolveSlateSessionIdentity,
  sanitizeSnapshotIdentity,
  SlateStore,
  SLATE_SESSION_ID_PATTERN,
  type SlateSnapshot,
} from "../extension/state.ts";

const ID = "20260818T101112Z-0123abcd";
const FRESH_ID = "20260818T111213Z-deadbeef";
const OWNER = "0198bb31-b16f-7acd-9000-123456789abc";
const FOREIGN_OWNER = "0198bb31-b16f-7acd-9000-abcdef012345";

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

test("minted slate session identities use compact UTC time and lowercase random bytes", () => {
  const minted = mintSlateSessionId(new Date("2026-08-18T10:11:12.999Z"));
  assert.match(minted, SLATE_SESSION_ID_PATTERN);
  assert.match(minted, /^20260818T101112Z-[0-9a-f]{8}$/);
});

test("snapshot identity sanitization accepts both valid fields and leaves absent fields silent", () => {
  const accepted = sanitize(snapshot({ slateSessionId: ID, ownerPiSessionId: OWNER }));
  assert.deepEqual(accepted.value, {
    snapshotPresent: true,
    slateSessionIdPresent: true,
    ownerPiSessionIdPresent: true,
    slateSessionId: ID,
    ownerPiSessionId: OWNER,
  });
  assert.deepEqual(accepted.repairs, []);

  const absent = sanitize(snapshot());
  assert.deepEqual(absent.value, {
    snapshotPresent: true,
    slateSessionIdPresent: false,
    ownerPiSessionIdPresent: false,
  });
  assert.deepEqual(absent.repairs, []);
});

test("snapshot identity sanitization rejects malformed identity and owner values by field name", () => {
  const badIdentities: unknown[] = [
    "20260818T101112Z-0123ABCd",
    "2026-08-18T10:11:12Z-0123abcd",
    "20260818T101112Z-0123abc/",
    "20260818T101112Z-0123abc",
    7,
    null,
  ];
  for (const slateSessionId of badIdentities) {
    const result = sanitize(snapshot({ slateSessionId, ownerPiSessionId: OWNER }));
    assert.equal(result.value.slateSessionId, undefined, String(slateSessionId));
    assert.equal(result.value.slateSessionIdPresent, true, String(slateSessionId));
    assert.equal(result.repairs.length, 1, String(slateSessionId));
    assert.match(result.repairs[0] ?? "", /slateSessionId/);
  }

  const badOwners: unknown[] = ["", "-owner", "owner-", "owner/path", "owner session", 7, null];
  for (const ownerPiSessionId of badOwners) {
    const result = sanitize(snapshot({ slateSessionId: ID, ownerPiSessionId }));
    assert.equal(result.value.ownerPiSessionId, undefined, String(ownerPiSessionId));
    assert.equal(result.value.ownerPiSessionIdPresent, true, String(ownerPiSessionId));
    assert.equal(result.repairs.length, 1, String(ownerPiSessionId));
    assert.match(result.repairs[0] ?? "", /ownerPiSessionId/);
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
    snapshot({ slateSessionId: "bad/id", ownerPiSessionId: "bad owner" }),
    ctx,
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /snapshot: ignoring slateSessionId \(string\)/);
  assert.match(notices[0] ?? "", /snapshot: ignoring ownerPiSessionId \(string\)/);
});

test("identity resolution mints only for fresh, malformed, ownerless, malformed-owner, and foreign snapshots", () => {
  const mint = () => FRESH_ID;

  const fresh = resolveSlateSessionIdentity(sanitize(undefined).value, OWNER, mint);
  assert.deepEqual(fresh, { slateSessionId: FRESH_ID, ownerPiSessionId: OWNER, minted: true });

  const legacy = resolveSlateSessionIdentity(sanitize(snapshot()).value, OWNER, mint);
  assert.deepEqual(legacy, { minted: false });

  const owned = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: ID, ownerPiSessionId: OWNER })).value,
    OWNER,
    mint,
  );
  assert.deepEqual(owned, { slateSessionId: ID, ownerPiSessionId: OWNER, minted: false });

  const foreign = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: ID, ownerPiSessionId: FOREIGN_OWNER })).value,
    OWNER,
    mint,
  );
  assert.equal(foreign.slateSessionId, FRESH_ID);
  assert.equal(foreign.ownerPiSessionId, OWNER);
  assert.equal(foreign.minted, true);
  assert.match(foreign.report ?? "", /different ownerPiSessionId/);

  const ownerless = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: ID })).value,
    OWNER,
    mint,
  );
  assert.equal(ownerless.slateSessionId, FRESH_ID);
  assert.equal(ownerless.minted, true);
  assert.match(ownerless.report ?? "", /no ownerPiSessionId/);

  const malformedOwner = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: ID, ownerPiSessionId: "bad owner" })).value,
    OWNER,
    mint,
  );
  assert.equal(malformedOwner.slateSessionId, FRESH_ID);
  assert.equal(malformedOwner.minted, true);
  assert.match(malformedOwner.report ?? "", /malformed ownerPiSessionId/);

  const malformedIdentity = resolveSlateSessionIdentity(
    sanitize(snapshot({ slateSessionId: "bad/id", ownerPiSessionId: OWNER })).value,
    OWNER,
    mint,
  );
  assert.equal(malformedIdentity.slateSessionId, FRESH_ID);
  assert.equal(malformedIdentity.minted, true);
  assert.match(malformedIdentity.report ?? "", /malformed slateSessionId/);
});

test("store identity resolution persists minted fields and preserves a legacy snapshot", () => {
  const appended: Array<Record<string, unknown>> = [];
  const store = new SlateStore({
    appendEntry(_type: string, data: Record<string, unknown>) { appended.push(data); },
  } as unknown as ExtensionAPI);
  const reports: string[] = [];
  assert.equal(store.resolveSessionIdentity(OWNER, (message) => reports.push(message), () => FRESH_ID), true);
  store.save();
  assert.equal(appended.at(-1)?.slateSessionId, FRESH_ID);
  assert.equal(appended.at(-1)?.ownerPiSessionId, OWNER);
  assert.equal(reports.length, 0);

  store.adoptSnapshot(snapshot(), { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext);
  assert.equal(store.resolveSessionIdentity(OWNER, (message) => reports.push(message), () => FRESH_ID), false);
  assert.equal(store.snapshot().slateSessionId, undefined);
  assert.equal(store.snapshot().ownerPiSessionId, undefined);
});

test("pending handoff adoption re-stamps the owner before saving", { timeout: 1000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-identity-handoff-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const appended: Array<Record<string, unknown>> = [];
  const store = new SlateStore({
    appendEntry(_type: string, data: Record<string, unknown>) { appended.push(data); },
  } as unknown as ExtensionAPI);
  type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
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

  const file = join(cwd, CONFIG_DIR_NAME, "slate", "pending-handoff.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    parentSession: "/tmp/parent.jsonl",
    createdAt: Date.now(),
    brief: "",
    snapshot: snapshot({
      slateSessionId: ID,
      ownerPiSessionId: FOREIGN_OWNER,
      orchestratorMode: true,
    }),
  }));
  const ctx = {
    cwd,
    hasUI: false,
    model: undefined,
    isProjectTrusted: () => true,
    sessionManager: {
      getHeader: () => ({ parentSession: "/tmp/parent.jsonl" }),
      getSessionId: () => OWNER,
    },
  } as unknown as ExtensionContext;
  const sessionStart = handlers.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({}, ctx);

  assert.equal(store.slateSessionId, ID);
  assert.equal(store.ownerPiSessionId, OWNER);
  assert.equal(appended.at(-1)?.slateSessionId, ID);
  assert.equal(appended.at(-1)?.ownerPiSessionId, OWNER);
  assert.equal(existsSync(file), false);
  assert.equal(store.resolveSessionIdentity(OWNER, assert.fail, () => FRESH_ID), false);
  assert.equal(store.slateSessionId, ID);
});
