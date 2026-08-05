import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  captureObservation,
  findingsGrammar,
  OBSERVATIONS_MAX_BYTES,
  shouldWarnFindingsGrammar,
} from "../extension/observations.ts";
import { isJudgementThreadType, JUDGEMENT_THREAD_TYPES } from "../extension/worker.ts";
import { sanitizeEpisodeRecord, sanitizeThreadRecord, SlateStore, type ThreadRecord } from "../extension/state.ts";
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
    assert.match(result.warning, /^slate: could not store observations for episode t1\.e1\./);
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

test("snapshot adoption rejects an unsafe thread id with a visible repair", () => {
  const repairs: string[] = [];
  assert.equal(sanitizeThreadRecord({ id: "review:main", episodeSeq: 0 }, repairs), undefined);
  assert.deepEqual(repairs, ["thread review:main: invalid id cannot form a canonical episode filename — remove or rename this record"]);
});

test("restored episode counters accept only non-negative safe integers", () => {
  for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const repairs: string[] = [];
    const adopted = sanitizeThreadRecord({ id: "review-main", episodeIds: ["review-main.e1"], episodeSeq: value }, repairs);
    assert.equal(adopted?.episodeSeq, 1);
    assert.deepEqual(repairs, [`thread review-main: ignoring episodeSeq (number)`]);
  }
  for (const value of [0, Number.MAX_SAFE_INTEGER]) {
    const repairs: string[] = [];
    assert.equal(sanitizeThreadRecord({ id: "review-main", episodeSeq: value }, repairs)?.episodeSeq, value);
    assert.deepEqual(repairs, []);
  }
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
    assert.equal("identity" in observations, false, "write ownership must not enter the durable episode record");
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
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No findings." }] },
        expected: undefined,
      },
      {
        label: "failed reviewer absent",
        type: "reviewer" as const,
        message: { role: "assistant", stopReason: "error", errorMessage: "failed", content: [{ type: "text", text: "No findings." }] },
        expected: undefined,
      },
      {
        label: "successful reviewer absent",
        type: "reviewer" as const,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No findings." }] },
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
      const result = await dispatchOnce({
        root,
        message: item.message,
        noMessage: item.noMessage,
        dispatch: { type: item.type },
        onProgress: (update) => progress.push({ ...update, lines: [...update.lines] }),
      });
      const grammarWarnings = result.warnings.filter((warning) => /findings row/.test(warning));
      if (item.expected === undefined) {
        assert.deepEqual(grammarWarnings, [], item.label);
      } else {
        assert.equal(grammarWarnings.length, 1, item.label);
        assert.match(grammarWarnings[0] ?? "", new RegExp(item.expected), item.label);
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
    const interimWarning = progress.findIndex((update) => !update.done && update.lines.some((line) => line.includes("final response has no pipe-delimited findings row")));
    const terminal = progress.findIndex((update) => update.done);
    assert.ok(interimWarning >= 0, "grammar warning must appear in a non-terminal progress update");
    assert.ok(terminal > interimWarning, "grammar warning must precede the terminal update");
    assert.ok(progress[interimWarning]?.lines.some((line) => line.includes("could not store observations")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("episode persistence failure records worker and compressor costs, recovery state, and a sanitized error", () => {
  const probe = spawnSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      join(process.cwd(), "verification", "test-hooks.mjs"),
      join(process.cwd(), "test", "episode-persistence-probe.ts"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, `probe stderr:\n${probe.stderr}\nprobe stdout:\n${probe.stdout}`);
  assert.equal(probe.stdout, "episode-persistence-probe: PASS\n");
  assert.equal(probe.stderr, "");
});

test("two queued actions plan consecutive episode ids inside per-thread execution", { timeout: 1000 }, async () => {
  const root = temporaryRoot();
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {});
    const messages: unknown[] = [];
    const subscribers = new Set<(event: unknown) => void>();
    const session = {
      messages,
      model: undefined,
      thinkingLevel: undefined,
      sessionFile: undefined,
      getContextUsage: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
      prompt: async (task: string) => {
        const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: task }] };
        messages.push(message);
        for (const listener of subscribers) listener({ type: "message_end", message });
      },
    };
    const view = manager as unknown as {
      live: Map<string, unknown>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: unknown; baseline: unknown }>;
    };
    view.openWorkerFor = async ({ thread }) => {
      view.live.set(thread.id, session);
      return { session, baseline: {} };
    };
    const ctx = { cwd: root } as ExtensionContext;

    const first = manager.dispatch({ name: "queued", task: "first", type: "reviewer" }, ctx, undefined);
    const second = manager.dispatch({ threadId: "t1", task: "second" }, ctx, undefined);
    const results = await Promise.all([first, second]);

    assert.deepEqual(results.map((result) => result.episode.id), ["t1.e1", "t1.e2"]);
    assert.deepEqual(store.threads.get("t1")?.episodeIds, ["t1.e1", "t1.e2"]);
    assert.equal(store.threads.get("t1")?.episodeSeq, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a queued action rechecks its episode id after its predecessor finishes", { timeout: 1000 }, async () => {
  const root = temporaryRoot();
  try {
    const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const manager = new ThreadManager(store, {});
    const messages: unknown[] = [];
    const subscribers = new Set<(event: unknown) => void>();
    let prompts = 0;
    const session = {
      messages,
      model: undefined,
      thinkingLevel: undefined,
      sessionFile: undefined,
      getContextUsage: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
      prompt: async () => {
        prompts++;
        const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No findings." }] };
        messages.push(message);
        for (const listener of subscribers) listener({ type: "message_end", message });
      },
    };
    const view = manager as unknown as {
      live: Map<string, unknown>;
      openWorkerFor(args: { thread: ThreadRecord }): Promise<{ session: unknown; baseline: unknown }>;
    };
    view.openWorkerFor = async ({ thread }) => {
      view.live.set(thread.id, session);
      return { session, baseline: {} };
    };
    const ctx = { cwd: root } as ExtensionContext;

    const first = manager.dispatch(
      { name: "queued-recheck", task: "first", type: "reviewer" },
      ctx,
      undefined,
      (update) => {
        if (update.done) {
          const thread = store.threads.get("t1");
          if (thread) thread.episodeSeq = Number.MAX_SAFE_INTEGER;
        }
      },
    );
    const second = manager.dispatch({ threadId: "t1", task: "must not run" }, ctx, undefined);

    assert.equal((await first).episode.id, "t1.e1");
    await assert.rejects(second, /restored id or episode counter cannot form the next canonical episode filename/);
    assert.equal(prompts, 1, "the rejected queued action performs no worker turn");
    assert.deepEqual(store.threads.get("t1")?.episodeIds, ["t1.e1"]);
    assert.deepEqual([...store.episodes.keys()], ["t1.e1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid restored ids and exhausted counters reject before worker work without state changes", async () => {
  const root = temporaryRoot();
  try {
    for (const [id, episodeSeq] of [["restored\nforeign", 0], ["review-main", Number.MAX_SAFE_INTEGER]] as const) {
      let store: SlateStore | undefined;
      let opens = 0;
      await assert.rejects(
        dispatchOnce({
          root,
          dispatch: { threadId: id },
          onOpen: () => { opens++; },
          onStore: (value) => {
            store = value;
            value.workerCostUsd = 4.5;
            value.threads.set(id, {
              id,
              name: "restored",
              sessionFile: "",
              status: "idle",
              type: "reviewer",
              episodeIds: [],
              episodeSeq,
              createdAt: 1,
              updatedAt: 1,
            });
          },
        }),
        /restored id or episode counter cannot form the next canonical episode filename/,
      );
      assert.equal(opens, 0);
      assert.equal(store?.workerCostUsd, 4.5);
      assert.equal(store?.threads.get(id)?.episodeSeq, episodeSeq);
      assert.equal(store?.threads.get(id)?.status, "idle");
      assert.equal(store?.episodes.size, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated dispatch of an invalid restored thread never opens a worker or mutates state", async () => {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const id = "invalid:restored";
  const thread: ThreadRecord = {
    id,
    name: "invalid",
    sessionFile: "",
    status: "idle",
    type: "reviewer",
    episodeIds: [],
    episodeSeq: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  store.threads.set(id, thread);
  store.workerCostUsd = 7;
  const manager = new ThreadManager(store, {});
  let opens = 0;
  (manager as unknown as { openWorkerFor(): Promise<never> }).openWorkerFor = async () => {
    opens++;
    throw new Error("worker opener must not run");
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      manager.dispatch({ threadId: id, task: "retry" }, { cwd: process.cwd() } as ExtensionContext, undefined),
      /restored id or episode counter/,
    );
  }
  assert.equal(opens, 0);
  assert.equal(store.workerCostUsd, 7);
  assert.deepEqual(store.threads.get(id), thread);
  assert.equal((manager as unknown as { queues: Map<string, unknown> }).queues.has(id), false, "public validation rejects before queue adoption");
});

/**
 * BG6: every step of the capture must sit inside the guard. Each case makes ONE
 * step throw and requires that the dispatch still completes, still records an
 * episode, and still reports the problem as a warning.
 *
 * Every throw is ONE-SHOT and armed when the worker turn ends. That scoping is
 * deliberate: `compressEpisode`'s uncompressed fallback reads the same message
 * object again through its own unguarded `lastAssistantText`, so a permanently
 * throwing getter would fail the dispatch inside episodes.ts and prove nothing
 * about this guard. A one-shot throw hits the capture and only the capture.
 */
function throwOnce(message: string, later: unknown, skip = 0): { get(): unknown; arm(): void } {
  let armed = false;
  let remaining = skip;
  return {
    arm() {
      armed = true;
    },
    get() {
      if (armed) {
        if (remaining > 0) {
          remaining--;
        } else {
          armed = false;
          throw new Error(message);
        }
      }
      return later;
    },
  };
}

const NOT_STORED = { stored: false, reason: "write-failed", grammar: "absent" };

const THROWING_STEPS: Array<{
  step: string;
  build: (root: string) => Parameters<typeof dispatchOnce>[0];
  /** What the durable record must hold once the throw has been absorbed. */
  expected: unknown;
}> = [
  {
    step: "scanning for the final assistant message",
    expected: NOT_STORED,
    build: (root) => {
      // `skip: 1` because `deriveOutcome` reads `role` through the SAME helper
      // first, to decide the action's status. That read is pre-existing and is
      // already covered by the dispatch's own catch, so letting it pass puts the
      // throw on the capture's read, which is the one this guard owns.
      const role = throwOnce("role read exploded", "assistant", 1);
      return {
        root,
        arm: role.arm,
        message: { get role() { return role.get(); }, stopReason: "stop", content: [{ type: "text", text: "No findings." }] },
      };
    },
  },
  {
    step: "extracting the final message text",
    expected: NOT_STORED,
    build: (root) => {
      const content = throwOnce("content read exploded", [{ type: "text", text: "No findings." }]);
      return {
        root,
        arm: content.arm,
        message: { role: "assistant", stopReason: "stop", get content() { return content.get(); } },
      };
    },
  },
  {
    step: "reading the project directory for the write",
    expected: NOT_STORED,
    build: (root) => {
      const cwd = throwOnce("cwd read exploded", root);
      return {
        root,
        arm: cwd.arm,
        defineCtx: (fields) => {
          Object.defineProperty(fields, "cwd", { get: () => cwd.get(), enumerable: true });
        },
      };
    },
  },
  {
    step: "emitting the observation progress line",
    // The capture SUCCEEDED before this step threw, so its real facts are kept:
    // the guard absorbs the throw without inventing a failure.
    expected: { stored: true, truncated: false, grammar: "absent", bytes: 12 },
    build: (root) => ({
      root,
      onProgress: (update: DispatchProgress) => {
        // Target the capture's OWN interim emit, so the throw lands on that step
        // rather than on the dispatch's final progress event.
        if (!update.done && update.lines.some((line) => line.includes("findings row"))) {
          throw new Error("progress channel exploded");
        }
      },
    }),
  },
];

for (const { step, build, expected } of THROWING_STEPS) {
  test(`a throw while ${step} still completes the dispatch`, async () => {
    const root = temporaryRoot();
    try {
      const result = await dispatchOnce(build(root));

      assert.equal(result.episode.status, "ok");
      assert.equal(existsSync(result.episode.file), true);
      assert.equal(result.thread.status, "idle");
      const observations = result.episode.observations as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
        assert.equal(observations[key], value, `observations.${key}`);
      }
      assert.ok(
        result.warnings.some((warning) => /could not (record|store) observations/.test(warning)),
        `expected an observation warning, got ${JSON.stringify(result.warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
