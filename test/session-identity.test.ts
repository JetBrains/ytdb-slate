import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOwnerSessionDigest,
  mintSlateSessionId,
  OWNER_SESSION_DIGEST_PATTERN,
  SLATE_SESSION_ID_PATTERN,
} from "../extension/state.ts";

test("minted Slate session identities use compact UTC time and distinct cryptographic suffixes", () => {
  const now = new Date("2026-08-18T10:11:12.999Z");
  const minted = Array.from({ length: 8 }, () => mintSlateSessionId(now));
  for (const value of minted) {
    assert.match(value, SLATE_SESSION_ID_PATTERN);
    assert.match(value, /^20260818T101112Z-[0-9a-f]{16}$/);
  }
  assert.equal(new Set(minted).size, minted.length);
});

test("owner digests are bounded and separate duplicate Pi identifiers by resolved session file", () => {
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
