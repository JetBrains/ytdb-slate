import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSlateBindingRecord,
  selectStartupAuthority,
  type SlateBindingRecord,
} from "../extension/runtime-authority.ts";

const ID = "20260827T090000Z-0123abcd0123abcd";
const NAME = "calm-otter-7f3a";

function binding(overrides: Partial<SlateBindingRecord> = {}): SlateBindingRecord {
  return { policy: "durable-session-v1", identity: ID, name: NAME, ...overrides };
}

function entry(customType: string, data: unknown): Record<string, unknown> {
  return { type: "custom", customType, data };
}

test("exact binding parsing accepts only the locator schema", () => {
  const source = binding();
  assert.deepEqual(parseSlateBindingRecord(source), source);
  for (const value of [null, [], { ...source, extra: true }, { ...source, policy: "old" }, { ...source, identity: "bad" }]) {
    assert.equal(parseSlateBindingRecord(value), undefined);
  }
});

test("startup selects one coherent active-branch locator", () => {
  const note = entry("slate-binding", binding());
  assert.deepEqual(selectStartupAuthority([note], [note]), { kind: "durable", binding: binding() });
  assert.deepEqual(selectStartupAuthority([], []), { kind: "fresh" });
});

test("startup refuses malformed, conflicting, and off-branch locator evidence", () => {
  const note = entry("slate-binding", binding());
  const malformed = entry("slate-binding", { ...binding(), extra: true });
  const conflict = entry("slate-binding", binding({ name: "brisk-bison-abcd" }));
  assert.equal(selectStartupAuthority([malformed], [malformed]).kind, "refused");
  assert.equal(selectStartupAuthority([note, conflict], [note, conflict]).kind, "refused");
  assert.equal(selectStartupAuthority([note], []).kind, "refused");
});

test("entries from removed conversation storage have no meaning", () => {
  const oldEntry = entry("slate-state", { threads: [{ id: "t1" }], orchestratorMode: true });
  assert.deepEqual(selectStartupAuthority([oldEntry], [oldEntry]), { kind: "fresh" });
});
