import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  captureObservation,
  durableObservation,
  findingsGrammar,
  hasZeroFindings,
  OBSERVATIONS_MAX_BYTES,
  shouldWarnFindingsGrammar,
} from "../extension/observations.ts";
import { isJudgementThreadType, JUDGEMENT_THREAD_TYPES } from "../extension/worker.ts";
import { sanitizeEpisodeRecord, SlateStore, type ThreadRecord } from "../extension/state.ts";
import { ThreadManager, type DispatchProgress } from "../extension/threads.ts";

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
    assert.match(result.warning ?? "", /^slate: could not store observations for episode t1\.e1\./);
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
  store.artifactSessionName = () => undefined;
  store.commit = () => ({ kind: "committed", binding: { policy: "durable-session-v1", identity: "20260820T010203Z-0123456789abcdef", name: "calm-otter-7f3a" } });
  opts.onStore?.(store);
  const manager = new ThreadManager(store, {});
  const messages: unknown[] = [];
  const subscribers = new Set<(event: unknown) => void>();
  const session = {
    messages,
    model: undefined,
    thinkingLevel: undefined,
    sessionFile: opts.sessionFile,
    getContextUsage: () => undefined,
    subscribe: (listener: (event: unknown) => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    prompt: async () => {
      if (!opts.noMessage) {
        const message = opts.message ?? { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No findings." }] };
        const withUsage = opts.workerCostUsd === undefined
          ? message
          : { ...(message as Record<string, unknown>), usage: { cost: { total: opts.workerCostUsd } } };
        messages.push(withUsage);
        for (const listener of subscribers) listener({ type: "message_end", message: withUsage });
      }
      opts.arm?.();
    },
  };
  const view = manager as unknown as {
    live: Map<string, unknown>;
    openWorkerFor(args: unknown): Promise<{ session: unknown; baseline: unknown }>;
  };
  view.openWorkerFor = async () => {
    opts.onOpen?.();
    view.live.set(opts.dispatch?.threadId ?? "t1", session);
    return { session, baseline: {} };
  };
  // Built with defineProperty rather than a spread: spreading an object with a
  // throwing getter would fire it here, in the harness, instead of inside the
  // dispatch step under test.
  const ctxFields: Record<string, unknown> = { cwd: opts.root };
  opts.defineCtx?.(ctxFields);
  const ctx = ctxFields as unknown as ExtensionContext;
  // Use the public dispatch boundary. The harness overrides only the existing
  // private worker opener to avoid a real pi session.
  return await manager.dispatch(
    { task: "review", type: "reviewer", name: "review", ...opts.dispatch },
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
          { type: "toolCall", name: "ignored" },
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
        message: { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", name: "done" }] },
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
          assert.match(grammarWarnings[0] ?? "", /exactly five fields for each finding, or end with the exact line No findings\./, item.label);
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

test("dispatch routes observation and judgement warnings through results and progress", async () => {
  const root = temporaryRoot();
  try {
    const slateDir = join(root, ".pi", "slate");
    mkdirSync(slateDir, { recursive: true });
    writeFileSync(join(slateDir, "observations"), "not a directory", "utf8");

    const progress: DispatchProgress[] = [];
    const result = await dispatchOnce({
      root,
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Review complete." }] },
      onProgress: (update) => progress.push({ ...update, lines: [...update.lines] }),
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
