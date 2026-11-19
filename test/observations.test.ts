const TEST_ROUTE = { model: "fixture", reason: "test fixture" } as const;

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  captureObservation,
  durableObservation,
  findingsGrammar,
  hasZeroFindings,
  OBSERVATIONS_MAX_BYTES,
  shouldWarnFindingsGrammar,
} from "../extension/observations.ts";
import { isJudgementThreadType, JUDGEMENT_THREAD_TYPES } from "../extension/worker.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { sanitizeEpisodeRecord, SlateStore, type ThreadRecord } from "../extension/state.ts";
import { ThreadManager, type DispatchProgress } from "../extension/threads.ts";
import { bindFakeWorkerRequest } from "./worker-request-contract-fixture.ts";

function fixtureRuntime() {
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
  return Object.freeze({ ...runtime, validateRoute: async () => ({ ok: true } as const) });
}

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "slate-observations-test."));
}

function withRoot(run: (root: string) => void): void {
  const root = temporaryRoot();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the observations cap keeps exact-cap content and truncates only above it", () => {
  withRoot((root) => {
    const exact = "x".repeat(OBSERVATIONS_MAX_BYTES);
    const exactResult = captureObservation(root, "t1.e1", exact);
    assert.equal(exactResult.stored, true);
    if (!exactResult.stored) return;
    assert.equal(exactResult.truncated, false);
    assert.equal(exactResult.bytes, OBSERVATIONS_MAX_BYTES);
    assert.equal(readFileSync(join(root, exactResult.path), "utf8"), exact);

    const above = `${exact}x`;
    const aboveResult = captureObservation(root, "t1.e2", above);
    assert.equal(aboveResult.stored, true);
    if (!aboveResult.stored) return;
    assert.equal(aboveResult.truncated, true);
    assert.ok(aboveResult.bytes > OBSERVATIONS_MAX_BYTES);
    assert.equal(readFileSync(join(root, aboveResult.path), "utf8"), `${exact} […truncated]`);
  });
});

test("observation capture preserves full 20k ASCII response and early findings row without truncation", () => {
  withRoot((root) => {
    const findingRow = "BG1 | blocker | x.ts:1 | summary | counterexample";
    const filler = "y".repeat(20_000);
    const content = `${findingRow}\n${filler}`;
    const result = captureObservation(root, "t1.e1", content);
    assert.equal(result.stored, true);
    if (!result.stored) return;
    assert.equal(result.truncated, false);
    assert.equal(result.grammar, "present");
    assert.equal(result.zeroFindings, false);
    assert.equal(result.bytes, Buffer.byteLength(content, "utf8"));
    const stored = readFileSync(join(root, result.path), "utf8");
    assert.equal(stored, content);
    assert.ok(stored.includes(findingRow));
  });
});

test("separator-only overflow reports truthful truncation", () => {
  withRoot((root) => {
    const exact = "x".repeat(OBSERVATIONS_MAX_BYTES);
    const result1 = captureObservation(root, "t1.e1", [
      { type: "text", text: exact },
      { type: "text", text: "extra" },
    ]);
    assert.equal(result1.stored, true);
    if (!result1.stored) return;
    assert.equal(result1.truncated, true);
    assert.equal(result1.bytes, OBSERVATIONS_MAX_BYTES + 15);
    assert.equal(readFileSync(join(root, result1.path), "utf8"), `${exact} […truncated]`);

    const result2 = captureObservation(root, "t1.e2", [
      { type: "text", text: exact },
      { type: "text", text: "" },
    ]);
    assert.equal(result2.stored, true);
    if (!result2.stored) return;
    assert.equal(result2.truncated, true);
    assert.equal(readFileSync(join(root, result2.path), "utf8"), `${exact} […truncated]`);

    const near = "x".repeat(OBSERVATIONS_MAX_BYTES - 1);
    const result3 = captureObservation(root, "t1.e3", [
      { type: "text", text: near },
      { type: "text", text: "" },
      { type: "text", text: "z" },
    ]);
    assert.equal(result3.stored, true);
    if (!result3.stored) return;
    assert.equal(result3.truncated, true);
    assert.equal(readFileSync(join(root, result3.path), "utf8"), `${near}\n […truncated]`);

    const result4 = captureObservation(root, "t1.e4", [
      { type: "text", text: near },
      { type: "text", text: "" },
    ]);
    assert.equal(result4.stored, true);
    if (!result4.stored) return;
    assert.equal(result4.truncated, false);
    assert.equal(result4.bytes, OBSERVATIONS_MAX_BYTES);
    assert.equal(readFileSync(join(root, result4.path), "utf8"), `${near}\n`);
  });
});

test("empty and ignored blocks follow separator and retention semantics", () => {
  withRoot((root) => {
    const exact = "x".repeat(OBSERVATIONS_MAX_BYTES);
    const resultIgnored = captureObservation(root, "t1.e1", [
      { type: "text", text: exact },
      { type: "toolCall", name: "done", arguments: {} },
    ]);
    assert.equal(resultIgnored.stored, true);
    if (!resultIgnored.stored) return;
    assert.equal(resultIgnored.truncated, false);
    assert.equal(resultIgnored.bytes, OBSERVATIONS_MAX_BYTES);
    assert.equal(readFileSync(join(root, resultIgnored.path), "utf8"), exact);

    const singleEmpty = captureObservation(root, "t1.e2", [{ type: "text", text: "" }]);
    assert.deepEqual(singleEmpty, { stored: false, reason: "no-final-text", grammar: "absent" });

    const twoEmpty = captureObservation(root, "t1.e3", [
      { type: "text", text: "" },
      { type: "text", text: "" },
    ]);
    assert.equal(twoEmpty.stored, true);
    if (!twoEmpty.stored) return;
    assert.equal(twoEmpty.truncated, false);
    assert.equal(twoEmpty.bytes, 1);
    assert.equal(readFileSync(join(root, twoEmpty.path), "utf8"), "\n");

    const middleEmpty = captureObservation(root, "t1.e4", [
      { type: "text", text: "hello" },
      { type: "text", text: "" },
      { type: "text", text: "world" },
    ]);
    assert.equal(middleEmpty.stored, true);
    if (!middleEmpty.stored) return;
    assert.equal(middleEmpty.truncated, false);
    assert.equal(readFileSync(join(root, middleEmpty.path), "utf8"), "hello\n\nworld");
  });
});

test("2-byte, 3-byte, and 4-byte Unicode boundary and surrogate handling", () => {
  withRoot((root) => {
    const prefix2 = "x".repeat(OBSERVATIONS_MAX_BYTES - 1);
    const result2 = captureObservation(root, "t1.e1", `${prefix2}£`);
    assert.equal(result2.stored, true);
    if (!result2.stored) return;
    assert.equal(result2.truncated, true);
    const stored2 = readFileSync(join(root, result2.path), "utf8");
    assert.equal(stored2, `${prefix2} […truncated]`);
    assert.equal(stored2.includes("\uFFFD"), false);

    const prefix4Exact = "x".repeat(OBSERVATIONS_MAX_BYTES - 4);
    const result4Exact = captureObservation(root, "t1.e2", `${prefix4Exact}😀`);
    assert.equal(result4Exact.stored, true);
    if (!result4Exact.stored) return;
    assert.equal(result4Exact.truncated, false);
    assert.equal(result4Exact.bytes, OBSERVATIONS_MAX_BYTES);
    assert.equal(readFileSync(join(root, result4Exact.path), "utf8"), `${prefix4Exact}😀`);

    const prefix4Over = "x".repeat(OBSERVATIONS_MAX_BYTES - 3);
    const result4Over = captureObservation(root, "t1.e3", `${prefix4Over}😀`);
    assert.equal(result4Over.stored, true);
    if (!result4Over.stored) return;
    assert.equal(result4Over.truncated, true);
    const stored4 = readFileSync(join(root, result4Over.path), "utf8");
    assert.equal(stored4, `${prefix4Over} […truncated]`);
    assert.equal(stored4.includes("\uFFFD"), false);

    const hugeWithSurrogate = `${prefix4Over}😀${"y".repeat(100_000)}`;
    const resultHuge = captureObservation(root, "t1.e4", hugeWithSurrogate);
    assert.equal(resultHuge.stored, true);
    if (!resultHuge.stored) return;
    assert.equal(resultHuge.truncated, true);
    const storedHuge = readFileSync(join(root, resultHuge.path), "utf8");
    assert.equal(storedHuge, `${prefix4Over} […truncated]`);
    assert.equal(storedHuge.includes("\uFFFD"), false);
  });
});

test("nested bare strings inside content arrays are ignored while top-level strings are preserved", () => {
  withRoot((root) => {
    // Top-level string is preserved
    const topLevel = captureObservation(root, "t1.e1", "top level text");
    assert.equal(topLevel.stored, true);
    if (!topLevel.stored) return;
    assert.equal(readFileSync(join(root, topLevel.path), "utf8"), "top level text");

    // Array containing only bare strings is ignored as having no eligible text blocks
    const arrayOnlyStrings = captureObservation(root, "t1.e2", ["raw-string-block"]);
    assert.deepEqual(arrayOnlyStrings, { stored: false, reason: "no-final-text", grammar: "absent" });

    // Mixed array ignores bare strings and retains only eligible text block objects
    const mixed = captureObservation(root, "t1.e3", [
      { type: "text", text: "first" },
      "ignored bare string",
      { type: "toolCall", name: "call_1", arguments: {} },
      { type: "text", text: "second" },
    ]);
    assert.equal(mixed.stored, true);
    if (!mixed.stored) return;
    assert.equal(mixed.truncated, false);
    assert.equal(readFileSync(join(root, mixed.path), "utf8"), "first\nsecond");
  });
});

test("bounded intermediate allocations avoid full-block or full-array materialization", () => {
  withRoot((root) => {
    // Instrument Buffer.from to reject encoding any string exceeding the bounded budget
    const originalBufferFrom = Buffer.from;
    let attemptedOversizedBuffer = false;
    let maxEncodedStringLength = 0;

    // We replace Buffer.from temporarily during capture
    const patchedBufferFrom = function (value: unknown, ...args: unknown[]): Buffer {
      if (typeof value === "string") {
        if (value.length > maxEncodedStringLength) {
          maxEncodedStringLength = value.length;
        }
        // Retained prefix budget is at most OBSERVATIONS_MAX_BYTES + 1 character (for surrogate pairing)
        if (value.length > OBSERVATIONS_MAX_BYTES + 1) {
          attemptedOversizedBuffer = true;
          throw new Error(`Buffer.from called with oversized string of length ${value.length}`);
        }
      }
      return Reflect.apply(originalBufferFrom, Buffer, [value, ...args]);
    } as typeof Buffer.from;

    Buffer.from = patchedBufferFrom;
    try {
      const huge = "a".repeat(20_000_000);
      const result = captureObservation(root, "t1.e1", huge);
      assert.equal(result.stored, true);
      if (!result.stored) return;
      assert.equal(result.truncated, true);
      assert.equal(result.bytes, OBSERVATIONS_MAX_BYTES + 15);
      assert.equal(readFileSync(join(root, result.path), "utf8"), `${"a".repeat(OBSERVATIONS_MAX_BYTES)} […truncated]`);
      assert.equal(attemptedOversizedBuffer, false, "no oversized string was passed to Buffer.from");
      assert.ok(maxEncodedStringLength <= OBSERVATIONS_MAX_BYTES + 1);

      // Verify array-level element access rejects unneeded tail access and full-array copying (e.g. [...content], slice, map)
      let tailAccessed = false;
      const blocksWithGuardedTail: unknown[] = [
        { type: "text", text: "x".repeat(OBSERVATIONS_MAX_BYTES + 1000) },
      ];
      Object.defineProperty(blocksWithGuardedTail, 1, {
        get() {
          tailAccessed = true;
          throw new Error("unneeded array tail item was accessed after budget exhaustion");
        },
        configurable: true,
        enumerable: true,
      });
      blocksWithGuardedTail.length = 10_000;

      const tailResult = captureObservation(root, "t1.e2", blocksWithGuardedTail);
      assert.equal(tailResult.stored, true);
      assert.equal(tailAccessed, false, "array items after full budget exhaustion were not accessed");

      // Verify array index reads do not scale with array size (input-sized collection/copy guard)
      let indexReadCount = 0;
      const arrayTarget: unknown[] = [
        { type: "text", text: "x".repeat(OBSERVATIONS_MAX_BYTES + 1000) },
      ];
      arrayTarget.length = 10_000;
      const countingArray = new Proxy(arrayTarget, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && /^\d+$/.test(prop)) {
            indexReadCount++;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const proxyResult = captureObservation(root, "t1.e3", countingArray);
      assert.equal(proxyResult.stored, true);
      assert.equal(indexReadCount, 1, "only the first array item needed for the budget was read");
    } finally {
      Buffer.from = originalBufferFrom;
    }
    assert.equal(Buffer.from, originalBufferFrom, "Buffer.from is restored after test completion");
  });
});

test("truncation backs up to a complete UTF-8 character", () => {
  withRoot((root) => {
    const prefix = "x".repeat(OBSERVATIONS_MAX_BYTES - 1);
    const result = captureObservation(root, "t1.e1", `${prefix}€`);
    assert.equal(result.stored, true);
    if (!result.stored) return;
    const stored = readFileSync(join(root, result.path), "utf8");
    assert.equal(stored, `${prefix} […truncated]`);
    assert.equal(stored.includes("�"), false);
  });
});

test("findings grammar requires exactly five fields", () => {
  assert.equal(findingsGrammar("BG1 | blocker | x.ts:1 | summary | counterexample"), "present");
  assert.equal(findingsGrammar("BG1 | blocker | x.ts:1 | summary"), "malformed");
  assert.equal(findingsGrammar("BG1 | blocker | x.ts:1 | summary | counterexample | extra"), "malformed");
  assert.equal(findingsGrammar("No findings."), "absent");
});

test("zero findings requires the exact final standalone line and stays transient", () => {
  assert.equal(hasZeroFindings("No findings."), true);
  assert.equal(hasZeroFindings("Review complete.\nNo findings.\n"), true);
  for (const nearMiss of ["no findings.", "No findings", " No findings.", "No findings. later", "No findings.\nmore"]) {
    assert.equal(hasZeroFindings(nearMiss), false, nearMiss);
  }
  withRoot((root) => {
    const stored = captureObservation(root, "t1.e1", "No findings.");
    assert.equal(stored.stored, true);
    if (!stored.stored) return;
    assert.equal(stored.grammar, "absent");
    assert.equal(stored.zeroFindings, true);
    assert.equal("zeroFindings" in durableObservation(stored), false);

    const truncated = captureObservation(root, "t1.e2", `${"x".repeat(OBSERVATIONS_MAX_BYTES)}No findings.`);
    assert.equal(truncated.stored, true);
    if (truncated.stored) assert.equal(truncated.zeroFindings, false);
  });
});

test("durable grammar describes only the bounded stored text", () => {
  withRoot((root) => {
    const beyondCap = `${"x".repeat(OBSERVATIONS_MAX_BYTES)}\nBG1 | blocker | x.ts:1 | summary | counterexample`;
    const result = captureObservation(root, "t1.e1", beyondCap);
    assert.equal(result.stored, true);
    if (!result.stored) return;
    assert.equal(result.truncated, true);
    assert.equal(result.grammar, "absent");
    assert.doesNotMatch(readFileSync(join(root, result.path), "utf8"), /BG1/);
  });
});

test("the reviewer charter and findings warning share the exact judgement set", () => {
  assert.deepEqual(JUDGEMENT_THREAD_TYPES, ["reviewer", "adversarial"]);
  assert.equal(isJudgementThreadType("reviewer"), true);
  assert.equal(isJudgementThreadType("adversarial"), true);
  assert.equal(isJudgementThreadType("researcher"), false);
  assert.equal(isJudgementThreadType(undefined), false);
  assert.equal(shouldWarnFindingsGrammar("ok", isJudgementThreadType("reviewer"), "absent"), true);
  assert.equal(shouldWarnFindingsGrammar("ok", isJudgementThreadType("researcher"), "absent"), false);
  assert.equal(shouldWarnFindingsGrammar("failed", isJudgementThreadType("reviewer"), "absent"), false);
  assert.equal(shouldWarnFindingsGrammar("ok", isJudgementThreadType("reviewer"), "present"), false);
  assert.equal(shouldWarnFindingsGrammar("ok", isJudgementThreadType("reviewer"), "absent", true), false);
  assert.equal(shouldWarnFindingsGrammar("ok", isJudgementThreadType("adversarial"), "absent", true), false);
  assert.equal(shouldWarnFindingsGrammar("ok", isJudgementThreadType("reviewer"), "malformed", true), true);
  assert.equal(shouldWarnFindingsGrammar("ok", isJudgementThreadType("researcher"), "absent", false), false);
});

test("an absent message and a message without text write no file, while whitespace is preserved", () => {
  withRoot((root) => {
    const absent = captureObservation(root, "t1.e1", undefined);
    assert.deepEqual(absent, { stored: false, reason: "no-final-message", grammar: "absent" });
    const noText = captureObservation(root, "t1.e2", "");
    assert.deepEqual(noText, { stored: false, reason: "no-final-text", grammar: "absent" });
    for (const id of ["t1.e1", "t1.e2"]) {
      assert.equal(existsSync(join(root, ".pi", "slate", "observations", `${id}.md`)), false);
    }

    const whitespace = captureObservation(root, "t1.e3", " \n\t");
    assert.equal(whitespace.stored, true);
    if (!whitespace.stored) return;
    assert.equal(readFileSync(join(root, whitespace.path), "utf8"), " \n\t");
    assert.equal(whitespace.grammar, "absent");
  });
});

test("a failed observations write returns a warning instead of throwing", () => {
  withRoot((root) => {
    writeFileSync(join(root, ".pi"), "not a directory", "utf8");
    const result = captureObservation(root, "t1.e1", "No findings.");
    assert.equal(result.stored, false);
    if (result.stored) return;
    assert.equal(result.reason, "write-failed");
    assert.equal(result.grammar, "absent");
    assert.equal(result.zeroFindings, true);
    assert.match(result.warning ?? "", /^slate: could not store observations for episode t1\.e1: .*not a directory/);
    assert.equal("zeroFindings" in durableObservation(result), false);
  });
});

/**
 * SE5: the persisted path is a pointer the review workflow tells a reader to
 * open, so an implausible value drops the WHOLE field with one repair note.
 */
const DEFECTIVE_PERSISTED: Array<[string, unknown]> = [
  ["empty path", { stored: true, path: "", bytes: 1, truncated: false, grammar: "present" }],
  ["oversized path", { stored: true, path: `/${"p".repeat(4096)}`, bytes: 1, truncated: false, grammar: "present" }],
  ["absolute path", { stored: true, path: "/tmp/o.md", bytes: 1, truncated: false, grammar: "present" }],
  ["wrong episode reference", { stored: true, path: ".pi/slate/observations/t2.e1.md", bytes: 1, truncated: false, grammar: "present" }],
  ["wrong kind reference", { stored: true, path: ".pi/slate/episodes/t1.e1.md", bytes: 1, truncated: false, grammar: "present" }],
  ["NaN bytes", { stored: true, path: ".pi/slate/observations/t1.e1.md", bytes: Number.NaN, truncated: false, grammar: "present" }],
  ["positive infinite bytes", { stored: true, path: ".pi/slate/observations/t1.e1.md", bytes: Number.POSITIVE_INFINITY, truncated: false, grammar: "present" }],
  ["negative infinite bytes", { stored: true, path: ".pi/slate/observations/t1.e1.md", bytes: Number.NEGATIVE_INFINITY, truncated: false, grammar: "present" }],
  ["negative bytes", { stored: true, path: ".pi/slate/observations/t1.e1.md", bytes: -1, truncated: false, grammar: "present" }],
  ["non-integer bytes", { stored: true, path: ".pi/slate/observations/t1.e1.md", bytes: 3.7, truncated: false, grammar: "present" }],
  ["unsafe integer bytes", { stored: true, path: ".pi/slate/observations/t1.e1.md", bytes: 2 ** 53, truncated: false, grammar: "present" }],
];

test("a defective persisted observation drops the whole field with one note", () => {
  for (const [label, observations] of DEFECTIVE_PERSISTED) {
    const repairs: string[] = [];
    const adopted = sanitizeEpisodeRecord({ id: "t1.e1", threadId: "t1", file: "/tmp/e.md", observations }, repairs);
    assert.ok(adopted, label);
    assert.equal("observations" in adopted, false, `${label} must drop the whole field`);
    assert.deepEqual(repairs, ["episode t1.e1: ignoring observations (object)"], label);
  }
});

test("a canonical persisted observation survives, and an absent one stays absent", () => {
  const valid = { stored: true as const, path: ".pi/slate/observations/t1.e1.md", bytes: 0, truncated: false, grammar: "absent" as const };
  const withField: string[] = [];
  const adopted = sanitizeEpisodeRecord({ id: "t1.e1", threadId: "t1", file: "/tmp/e.md", observations: valid }, withField);
  assert.deepEqual(adopted?.observations, valid);
  assert.deepEqual(withField, []);

  const withoutField: string[] = [];
  const old = sanitizeEpisodeRecord({ id: "t1.e1", threadId: "t1", file: "/tmp/e.md" }, withoutField);
  assert.ok(old);
  assert.equal("observations" in old, false);
  assert.deepEqual(withoutField, []);
});

interface DispatchOutcome {
  warnings: readonly string[];
  episode: { status: string; file: string; observations?: unknown };
  thread: ThreadRecord;
}

/**
 * Run ONE real dispatch against a fake worker session. `message` and `ctx`
 * overrides exist so a chosen step of the observation capture can be made to
 * throw (BG6).
 */
async function dispatchOnce(opts: {
  root: string;
  message?: unknown;
  noMessage?: boolean;
  compact?: boolean;
  cut?: "plain" | "edited" | "omitted" | "partial-then-omitted" | "retained-omission" | "retained-restoration" | "partial";
  projection?: "empty-startup" | "detached-startup";
  settle?: (manager: SessionManager) => void;
  /** Called when the fake worker turn ends, so a one-shot throw arms just before the capture. */
  arm?: () => void;
  defineCtx?: (ctx: Record<string, unknown>) => void;
  onProgress?: (update: DispatchProgress) => void;
  onStore?: (store: SlateStore) => void;
  onOpen?: () => void;
  workerCostUsd?: number;
  sessionFile?: string;
  dispatch?: { task?: string; type?: "reviewer" | "adversarial" | "researcher"; name?: string; threadId?: string };
}): Promise<DispatchOutcome> {
  const pi = { appendEntry() {} } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  opts.onStore?.(store);
  const manager = new ThreadManager(store, {}, undefined, fixtureRuntime());
  const messages: unknown[] = opts.compact || opts.projection === "detached-startup" ? [
    { role: "user", content: "startup prompt" },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "startup response" }] },
    { role: "custom", content: "startup context" },
  ] : [];
  const sessionManager = opts.compact || opts.cut || opts.projection || opts.settle ? SessionManager.inMemory(opts.root) : undefined;
  for (const message of messages) sessionManager?.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
  const subscribers = new Set<(event: unknown) => void>();
  const session = {
    messages,
    sessionManager,
    model: { provider: "test", id: "worker" },
    thinkingLevel: "off",
    sessionFile: opts.sessionFile,
    getContextUsage: () => undefined,
    setThinkingLevel(level: string) { session.thinkingLevel = level; },
    subscribe: (listener: (event: unknown) => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    prompt: async () => {
      let partial: string | undefined;
      if (opts.cut === "partial-then-omitted" || opts.cut === "retained-restoration") {
        assert.ok(sessionManager);
        partial = sessionManager.appendMessage({
          role: "assistant", stopReason: "toolUse", content: [
            { type: "text", text: "earlier partial text" },
            { type: "toolCall", id: "probe", name: "probe", arguments: {} },
          ],
        } as Parameters<SessionManager["appendMessage"]>[0]);
        sessionManager.appendMessage({
          role: "toolResult", toolCallId: "probe", toolName: "probe", isError: false,
          content: [{ type: "text", text: "retained result" }], timestamp: 1,
        });
      }
      if (!opts.noMessage) {
        const message = opts.message ?? { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No findings." }] };
        const withUsage = opts.workerCostUsd === undefined
          ? message
          : { ...(message as Record<string, unknown>), usage: { cost: { total: opts.workerCostUsd } } };
        messages.push(withUsage);
        sessionManager?.appendMessage(withUsage as Parameters<SessionManager["appendMessage"]>[0]);
        for (const listener of subscribers) listener({ type: "message_end", message: withUsage });
      }
      if (sessionManager && opts.settle) {
        opts.settle(sessionManager);
        messages.splice(0, messages.length, ...sessionManager.buildSessionProjection().messages);
      } else if (sessionManager && opts.cut) {
        const candidate = sessionManager.getLeafId();
        assert.ok(candidate);
        if (opts.cut === "edited") {
          sessionManager.appendCompaction("summarize the original answer", null, 100);
          sessionManager.appendCompaction("keep the answer again", candidate, 100);
          sessionManager.appendContextEdit(candidate, { content: "Exact edited answer." });
        } else if (opts.cut.endsWith("omitted") || opts.cut === "retained-omission" || opts.cut === "retained-restoration") {
          sessionManager.appendContextEdit(candidate, null);
        }
        sessionManager.appendCompaction("summarize the answer",
          partial ?? (opts.cut === "retained-omission" ? candidate : null), 100);
        if (opts.cut === "retained-restoration") {
          sessionManager.appendContextEdit(candidate, { content: "Later edit restores the answer." });
        }
        if (opts.cut === "edited") {
          sessionManager.appendContextEdit(candidate, { content: "Edit outside the retained context." });
          sessionManager.appendCompaction("summarize again without the answer", null, 100);
        }
        messages.splice(0, messages.length, ...sessionManager.buildSessionProjection().messages);
      } else if (sessionManager && opts.compact) {
        const keep = opts.noMessage ? messages[1] : messages.at(-1);
        const keptEntry = sessionManager.getBranch().find(entry => entry.type === "message" && entry.message === keep);
        assert.ok(keptEntry);
        sessionManager.appendCompaction("startup context summary", keptEntry.id, 100);
        messages.splice(0, messages.length, ...sessionManager.buildSessionProjection().messages);
        for (const listener of subscribers) listener({ type: "compaction_end", result: {} });
      } else if (sessionManager && opts.projection === "detached-startup") {
        sessionManager.branch(sessionManager.getBranch()[1]!.id);
        messages.splice(0, messages.length, ...sessionManager.buildSessionProjection().messages);
      }
      opts.arm?.();
    },
  };
  const view = manager as unknown as {
    live: Map<string, unknown>;
    openWorkerFor(args: {
      requestContract: import("../extension/worker.ts").WorkerRequestContract;
      observeSession: (worker: typeof session) => void;
    }): Promise<{ session: unknown; baseline: unknown }>;
  };
  view.openWorkerFor = async ({ requestContract, observeSession }) => {
    opts.onOpen?.();
    bindFakeWorkerRequest(session, requestContract);
    if (opts.compact) {
      observeSession(session);
      for (const listener of subscribers) listener({ type: "message_end", message: messages[1] });
    }
    view.live.set(opts.dispatch?.threadId ?? "t1", session);
    return { session, baseline: {} };
  };
  // Built with defineProperty rather than a spread: spreading an object with a
  // throwing getter would fire it here, in the harness, instead of inside the
  // dispatch step under test.
  const ctxFields: Record<string, unknown> = { cwd: opts.root, modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined, hasConfiguredAuth: () => true } };
  opts.defineCtx?.(ctxFields);
  const ctx = ctxFields as unknown as ExtensionContext;
  // Use the public dispatch boundary. The harness overrides only the existing
  // private worker opener to avoid a real pi session.
  return await manager.dispatch(
    { ...TEST_ROUTE, task: "review", type: "reviewer", name: "review", ...opts.dispatch },
    ctx,
    undefined,
    opts.onProgress,
  ) as DispatchOutcome;
}

test("dispatch joins text around non-text blocks and distinguishes malformed warnings", async () => {
  const root = temporaryRoot();
  try {
    const joined = await dispatchOnce({
      root,
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "text", text: "Review complete." },
          { type: "toolCall", name: "ignored", arguments: {} },
          { type: "text", text: "BG1 | blocker | x.ts:1 | summary | counterexample" },
        ],
      },
    });
    const observations = joined.episode.observations as { stored: boolean; path?: string; grammar?: string };
    assert.equal(observations.stored, true);
    assert.equal(observations.grammar, "present");
    assert.equal(readFileSync(join(root, observations.path ?? ""), "utf8"), "Review complete.\nBG1 | blocker | x.ts:1 | summary | counterexample");
    assert.equal(joined.warnings.some((warning) => warning.includes("findings row")), false);

    const malformed = await dispatchOnce({
      root,
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "BG1 | blocker | x.ts:1 | summary" }] },
    });
    assert.ok(malformed.warnings.some((warning) => warning.includes("malformed findings row")));
    assert.ok(malformed.warnings.some((warning) => warning.includes("Put a file and line or line range in the location field, with no pipe character.")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation survives a compacted projection and excludes startup text", { timeout: 1000 }, async () => {
  const root = temporaryRoot();
  try {
    const answer = "Exact post-start answer.\nNo findings.";
    const withAnswer = await dispatchOnce({
      root, compact: true,
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] },
    });
    const observation = withAnswer.episode.observations as { stored?: boolean; path?: string } | undefined;
    assert.equal(observation?.stored, true);
    assert.ok(observation?.path);
    assert.deepEqual(readFileSync(join(root, observation.path)), Buffer.from(answer));

    const withoutAnswer = await dispatchOnce({ root, compact: true, noMessage: true });
    assert.deepEqual(withoutAnswer.episode.observations, {
      stored: false, reason: "no-final-message", grammar: "absent",
    });
    assert.ok(withoutAnswer.warnings.some((warning) => warning.includes("produced no final response")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation replays only a completed answer at the cut that removed it", { timeout: 2000 }, async () => {
  const root = temporaryRoot();
  try {
    for (const [cut, answer] of [
      ["plain", "original answer"],
      ["edited", "Exact edited answer."],
      ["omitted", undefined],
      ["partial-then-omitted", undefined],
      ["retained-omission", undefined],
      ["retained-restoration", "Later edit restores the answer."],
      ["partial", undefined],
    ] as const) {
      const result = await dispatchOnce({
        root, cut,
        message: {
          role: "assistant", stopReason: cut === "partial" ? "toolUse" : "stop",
          content: [{ type: "text", text: "original answer" }],
        },
      });
      const observation = result.episode.observations as { stored?: boolean; path?: string } | undefined;
      if (answer === undefined) {
        assert.deepEqual(observation, { stored: false, reason: "no-final-message", grammar: "absent" }, cut);
        assert.ok(result.warnings.some(warning => warning.includes("produced no final response")), cut);
      } else {
        assert.equal(observation?.stored, true, cut);
        assert.ok(observation?.path, cut);
        assert.deepEqual(readFileSync(join(root, observation.path)), Buffer.from(answer), cut);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation skips discarded recovery attempts within the saved action boundary", { timeout: 5000 }, async () => {
  const root = temporaryRoot();
  try {
    for (const compact of [false, true]) {
      for (const [scenario, answer] of [
        ["retained", "original completed answer"],
        ["summarized", "edited before summarization"],
        ["withheld", undefined],
        ["withheld-cut", undefined],
        ["replacement", "later completed answer"],
        ["partial-only", undefined],
        ["visible-error-cut", undefined],
      ] as const) {
        const result = await dispatchOnce({
          root, compact, noMessage: scenario === "partial-only",
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "original completed answer" }] },
          settle(manager) {
            const assistant = (stopReason: "stop" | "toolUse" | "error" | "length", text: string) =>
              manager.appendMessage({ role: "assistant", stopReason, content: [{ type: "text", text }] } as
                Parameters<SessionManager["appendMessage"]>[0]);
            if (scenario === "summarized") {
              const original = manager.getLeafId();
              assert.ok(original);
              manager.appendContextEdit(original, { content: "edited before summarization" });
              manager.appendCompaction("cut the completed answer", null, 100);
              manager.appendContextEdit(original, { content: "edit outside the retained range" });
            }
            assistant("toolUse", "intervening tool partial");
            manager.appendMessage({
              role: "toolResult", toolCallId: "probe", toolName: "probe", isError: false,
              content: [{ type: "text", text: "intervening tool result" }], timestamp: 1,
            });
            if (scenario === "withheld" || scenario === "withheld-cut") {
              manager.appendContextEdit(assistant("stop", "withheld answer"), null);
              if (scenario === "withheld-cut") manager.appendCompaction("cut the withheld answer", null, 100);
            }
            const attempt = assistant(scenario === "summarized" ? "length" : "error", "recovery attempt");
            if (scenario !== "visible-error-cut") manager.appendContextEdit(attempt, null);
            if (scenario === "summarized" || scenario === "visible-error-cut") {
              manager.appendCompaction("cut the recovery attempt", null, 100);
            }
            if (scenario === "replacement") assistant("stop", "later completed answer");
          },
        });
        const label = `${scenario}, startup entries: ${compact}`;
        const observation = result.episode.observations as { stored?: boolean; path?: string } | undefined;
        if (answer === undefined) {
          assert.deepEqual(observation, { stored: false, reason: "no-final-message", grammar: "absent" }, label);
          assert.equal(result.warnings.filter(warning => warning.includes("produced no final response")).length, 1, label);
        } else {
          assert.equal(observation?.stored, true, label);
          assert.ok(observation?.path, label);
          assert.deepEqual(readFileSync(join(root, observation.path)), Buffer.from(answer), label);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation keeps visible tool and error endings", { timeout: 2000 }, async () => {
  const root = temporaryRoot();
  try {
    for (const stopReason of ["toolUse", "error"] as const) {
      const result = await dispatchOnce({
        root, compact: true,
        message: {
          role: "assistant", stopReason, errorMessage: "worker error",
          content: [{ type: "text", text: "Visible ending." }],
        },
      });
      const observation = result.episode.observations as { stored: boolean; path?: string };
      assert.equal(result.episode.status, stopReason === "error" ? "failed" : "ok");
      assert.equal(observation.stored, true);
      assert.ok(observation.path);
      assert.deepEqual(readFileSync(join(root, observation.path)), Buffer.from("Visible ending."));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation distinguishes an empty startup branch from an unanchored branch", { timeout: 1000 }, async () => {
  const root = temporaryRoot();
  try {
    const empty = await dispatchOnce({ root, projection: "empty-startup" });
    const observation = empty.episode.observations as { stored?: boolean; path?: string } | undefined;
    assert.equal(observation?.stored, true);
    assert.ok(observation?.path);
    assert.deepEqual(readFileSync(join(root, observation.path)), Buffer.from("No findings."));
    const detached = await dispatchOnce({ root, projection: "detached-startup" });
    assert.deepEqual(detached.episode.observations, { stored: false, reason: "no-final-message", grammar: "absent" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public dispatch gates each grammar warning by outcome and judgement type", async () => {
  const root = temporaryRoot();
  try {
    const cases = [
      {
        label: "successful researcher absent",
        type: "researcher" as const,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Review complete." }] },
        expected: undefined,
      },
      {
        label: "failed reviewer absent",
        type: "reviewer" as const,
        message: { role: "assistant", stopReason: "error", errorMessage: "failed", content: [{ type: "text", text: "Review complete." }] },
        expected: undefined,
      },
      {
        label: "successful reviewer with zero findings",
        type: "reviewer" as const,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No findings." }] },
        expected: undefined,
      },
      {
        label: "successful adversarial with zero findings",
        type: "adversarial" as const,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No findings." }] },
        expected: undefined,
      },
      {
        label: "reviewer malformed response ending with zero findings",
        type: "reviewer" as const,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "bad | row\nNo findings." }] },
        expected: "stored final response has a malformed findings row",
      },
      {
        label: "reviewer zero-findings near miss",
        type: "reviewer" as const,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No findings. later" }] },
        expected: "stored final response has no pipe-delimited findings row",
      },
      {
        label: "successful adversarial malformed",
        type: "adversarial" as const,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "BG1 | blocker | file | summary" }] },
        expected: "stored final response has a malformed findings row",
      },
      {
        label: "reviewer without a final message",
        type: "reviewer" as const,
        noMessage: true,
        expected: "produced no final response, so no compact findings row is available",
      },
      {
        label: "successful reviewer without final text",
        type: "reviewer" as const,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", name: "done", arguments: {} }] },
        expected: "final response contained no text blocks, so no compact findings row is available",
      },
    ];
    for (const item of cases) {
      const progress: DispatchProgress[] = [];
      if (item.message?.stopReason === "error" || item.noMessage === true) {
        const result = await dispatchOnce({
          root,
          message: item.message,
          noMessage: item.noMessage,
          dispatch: { type: item.type },
          onProgress: (update) => progress.push({ ...update, lines: [...update.lines] }),
        });
        assert.equal(result.episode.status, "failed", item.label);
        assert.equal(progress.filter((update) => update.done).length, 1, item.label);
        assert.equal(progress.find((update) => update.done)?.status, "failed", item.label);
        continue;
      }
      const result = await dispatchOnce({
        root,
        message: item.message,
        dispatch: { type: item.type },
        onProgress: (update) => progress.push({ ...update, lines: [...update.lines] }),
      });
      const grammarWarnings = result.warnings.filter((warning) => /findings row/.test(warning));
      if (item.expected === undefined) {
        assert.deepEqual(grammarWarnings, [], item.label);
      } else {
        assert.equal(grammarWarnings.length, 1, item.label);
        assert.match(grammarWarnings[0] ?? "", new RegExp(item.expected), item.label);
        if (item.expected.includes("no pipe-delimited")) {
          assert.match(grammarWarnings[0] ?? "", /exactly five fields for each finding\. Put a file and line or line range in the location field, with no pipe character\. Otherwise end with the exact line No findings\./, item.label);
        }
        assert.ok(progress.some((update) => !update.done && update.lines.some((line) => line.includes(item.expected ?? ""))), item.label);
      }
      const terminal = progress.filter((update) => update.done);
      assert.equal(terminal.length, 1, `${item.label}: one terminal update`);
      assert.equal(terminal[0]?.status, result.episode.status, `${item.label}: terminal status`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an older manager keeps its storage folder after the store starts another runtime", async () => {
  const root = temporaryRoot();
  try {
    let store: SlateStore | undefined;
    let previous = "";
    let next = "";
    const result = await dispatchOnce({
      root,
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "result" }] },
      onStore: (value) => { store = value; previous = value.runtimeFolder; },
      onOpen: () => { store!.startRuntime(); next = store!.runtimeFolder; },
    });
    assert.notEqual(previous, next);
    assert.ok(result.episode.file.includes(`/${previous}/episodes/`));
    const observation = result.episode.observations as { stored?: boolean; path?: string } | undefined;
    assert.equal(observation?.stored, true);
    assert.ok(observation?.path?.includes(`/${previous}/observations/`));
    assert.equal(existsSync(join(root, ".pi", "slate", next)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dispatch routes observation and judgement warnings through results and progress", async () => {
  const root = temporaryRoot();
  try {
    const slateDir = join(root, ".pi", "slate");
    mkdirSync(slateDir, { recursive: true });
    const progress: DispatchProgress[] = [];
    const result = await dispatchOnce({
      root,
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Review complete." }] },
      onProgress: (update) => progress.push({ ...update, lines: [...update.lines] }),
      onStore: (store) => {
        mkdirSync(join(slateDir, store.runtimeFolder), { recursive: true });
        writeFileSync(join(slateDir, store.runtimeFolder, "observations"), "not a directory", "utf8");
      },
    });

    assert.equal(result.episode.status, "ok");
    assert.equal(existsSync(result.episode.file), true);
    assert.deepEqual(result.episode.observations, {
      stored: false,
      reason: "write-failed",
      grammar: "absent",
    });
    assert.match(
      readFileSync(result.episode.file, "utf8"),
      /^> observations: not stored \| reason: write-failed \| grammar: absent$/m,
    );
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0] ?? "", /could not store observations/);
    assert.match(result.warnings[1] ?? "", /final response has no pipe-delimited findings row/);
    assert.doesNotMatch(result.warnings[1] ?? "", /stored final response/);
    const interimWarning = progress.findIndex((update) =>
      !update.done &&
      update.lines.some((line) => line.includes("could not store observations")) &&
      update.lines.some((line) => line.includes("final response has no pipe-delimited findings row")),
    );
    const terminal = progress.findIndex((update) => update.done);
    assert.ok(interimWarning >= 0, "both observation warnings must reach a non-terminal progress update");
    assert.ok(terminal > interimWarning, "observation warnings must precede the terminal update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("episode persistence failure recovers with a retained or externally removed observation", { timeout: 5000 }, () => {
  const scratch = temporaryRoot();
  try {
    for (const mode of ["retained", "removed"] as const) {
      const probeRoot = join(scratch, mode);
      const probe = spawnSync(
        process.execPath,
        [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          "--import",
          join(process.cwd(), "verification", "test-hooks.mjs"),
          join(process.cwd(), "test", "episode-persistence-probe.ts"),
        ],
        {
          encoding: "utf8",
          timeout: 2000,
          killSignal: "SIGKILL",
          env: { ...process.env, SLATE_PROBE_ROOT: probeRoot, SLATE_OBSERVATION_MODE: mode },
        },
      );
      assert.equal(probe.error, undefined, `${mode} probe timed out or failed to start: ${probe.error?.message ?? "unknown error"}`);
      assert.equal(probe.status, 0, `${mode} probe stderr:\n${probe.stderr}\nprobe stdout:\n${probe.stdout}`);
      assert.equal(probe.stdout, `episode-persistence-probe: ${mode} PASS\n`);
      assert.equal(probe.stderr, "");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
