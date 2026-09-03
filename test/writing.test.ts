import assert from "node:assert/strict";
import test from "node:test";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { writingReminderGateOpen } from "../extension/writing-reminder.ts";
import {
  measureWritingTurn,
  sanitizeWritingConfig,
  type WritingChecker,
  type WritingCounters,
} from "../extension/writing.ts";

const IGNORED_KEYS_NOTICE =
  "slate: writing.check and writing.remind are ignored writing keys. Remove them from slate.json. Slate controls writing checks and reminders automatically for trusted projects in orchestrator mode.";

function sanitize(raw: unknown): { result: ReturnType<typeof sanitizeWritingConfig>; warnings: string[] } {
  const warnings: string[] = [];
  const result = sanitizeWritingConfig(raw, (warning) => warnings.push(warning));
  return { result, warnings };
}

function assistant(content: unknown): TurnEndEvent["message"] {
  return { role: "assistant", content } as TurnEndEvent["message"];
}

test("writing.check true is an ignored writing key and emits the shared notice", () => {
  const { result, warnings } = sanitize({ check: true, remindPercent: 7 });
  assert.deepEqual(result, { remindPercent: 7 });
  assert.deepEqual(warnings, [IGNORED_KEYS_NOTICE]);
});

test("writing.remind false is an ignored writing key and emits the shared notice", () => {
  const { result, warnings } = sanitize({ remind: false });
  assert.deepEqual(result, { remindPercent: 10 });
  assert.deepEqual(warnings, [IGNORED_KEYS_NOTICE]);
});

test("absent ignored writing keys emit no shared notice", () => {
  const { result, warnings } = sanitize({ remindPercent: 25 });
  assert.deepEqual(result, { remindPercent: 25 });
  assert.deepEqual(warnings, []);
});

test("both ignored writing keys produce one notice", () => {
  const { warnings } = sanitize({ check: false, remind: true });
  assert.deepEqual(warnings, [IGNORED_KEYS_NOTICE]);
});

test("invalid remindPercent falls back without hiding the ignored writing keys notice", () => {
  const { result, warnings } = sanitize({ check: false, remindPercent: 0 });
  assert.deepEqual(result, { remindPercent: 10 });
  assert.deepEqual(warnings, [
    IGNORED_KEYS_NOTICE,
    "slate: ignoring writing.remindPercent — expected a finite number in (0, 100] (defaulting to 10)",
  ]);
});

test("a throwing remindPercent getter warns and falls back", () => {
  const raw = {};
  Object.defineProperty(raw, "remindPercent", {
    enumerable: true,
    get() {
      throw new Error("unreadable percentage");
    },
  });

  assert.deepEqual(sanitize(raw), {
    result: { remindPercent: 10 },
    warnings: ["slate: ignoring writing.remindPercent — could not read the value (defaulting to 10)"],
  });
});

test("writing reminder gates exclude the ignored writing keys", () => {
  assert.equal(writingReminderGateOpen({ orchestratorMode: true, trusted: true, paused: false }, false), true);
  assert.equal(writingReminderGateOpen({ orchestratorMode: false, trusted: true, paused: false }, false), false);
  assert.equal(writingReminderGateOpen({ orchestratorMode: true, trusted: false, paused: false }, false), false);
  assert.equal(writingReminderGateOpen({ orchestratorMode: true, trusted: true, paused: true }, false), false);
  assert.equal(writingReminderGateOpen({ orchestratorMode: true, trusted: true, paused: false }, true), false);
});

test("measureWritingTurn counts a measured turn and one fail-class finding", () => {
  const seen: string[] = [];
  const checker: WritingChecker = {
    checkText(text) {
      seen.push(text);
      return { findings: [{ class: "house-style" }, { class: "fail" }] };
    },
  };
  const counters: WritingCounters = { measuredTurns: 2, findingTurns: 1 };

  assert.equal(measureWritingTurn(assistant("User-facing prose."), checker, counters), "measured");
  assert.deepEqual(seen, ["User-facing prose."]);
  assert.deepEqual(counters, { measuredTurns: 3, findingTurns: 2 });
});

test("measureWritingTurn joins text blocks and ignores non-fail findings", () => {
  const seen: string[] = [];
  const checker: WritingChecker = {
    checkText(text) {
      seen.push(text);
      return { findings: [{ class: "house-style" }] };
    },
  };
  const counters: WritingCounters = { measuredTurns: 0, findingTurns: 0 };
  const message = assistant([
    { type: "text", text: "First" },
    { type: "toolCall", name: "read" },
    { type: "text", text: "Second" },
  ]);

  assert.equal(measureWritingTurn(message, checker, counters), "measured");
  assert.deepEqual(seen, ["First\nSecond"]);
  assert.deepEqual(counters, { measuredTurns: 1, findingTurns: 0 });
});

test("measureWritingTurn leaves counters unchanged when no assistant prose exists", () => {
  let calls = 0;
  const checker: WritingChecker = {
    checkText() {
      calls += 1;
      return { findings: [] };
    },
  };
  const counters: WritingCounters = { measuredTurns: 4, findingTurns: 3 };
  const message = { role: "user", content: "not assistant prose" } as TurnEndEvent["message"];

  assert.equal(measureWritingTurn(message, checker, counters), "no-text");
  assert.equal(calls, 0);
  assert.deepEqual(counters, { measuredTurns: 4, findingTurns: 3 });
});

test("measureWritingTurn fails open when the checker throws", () => {
  const checker: WritingChecker = {
    checkText() {
      throw new Error("checker failed");
    },
  };
  const counters: WritingCounters = { measuredTurns: 1, findingTurns: 1 };

  assert.equal(measureWritingTurn(assistant("Prose"), checker, counters), "failed");
  assert.deepEqual(counters, { measuredTurns: 1, findingTurns: 1 });
});

test("measureWritingTurn treats an unreadable assistant message as no text", () => {
  const message = { role: "assistant" } as Record<string, unknown>;
  Object.defineProperty(message, "content", {
    get() {
      throw new Error("unreadable");
    },
  });
  const counters: WritingCounters = { measuredTurns: 0, findingTurns: 0 };
  const checker: WritingChecker = { checkText: () => ({ findings: [] }) };

  assert.equal(measureWritingTurn(message as unknown as TurnEndEvent["message"], checker, counters), "no-text");
  assert.deepEqual(counters, { measuredTurns: 0, findingTurns: 0 });
});
