import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EpisodeRecord, SlateStore, ThreadRecord } from "../extension/state.ts";
import type { DispatchOptions, DispatchResult, ThreadManager } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";

interface ThreadTool {
  name: string;
  execute(
    toolCallId: string,
    params: DispatchOptions,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
}

function threadRecord(): ThreadRecord & { warmNow: true } {
  return {
    id: "t1",
    name: "cost-test",
    type: "general",
    status: "cancelled",
    episodeId: "t1.e1",
    createdAt: 1,
    updatedAt: 2,
    warmNow: true,
  };
}

function episode(overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: "t1.e1",
    threadId: "t1",
    task: "measure cost",
    status: "ok",
    file: "/tmp/t1.e1.md",
    model: "fallback/final",
    effort: "high",
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    workerCostUsd: 0.1,
    compressorUsage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    compressorCostUsd: 0.2,
    compactionUsage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
    compactionCostUsd: 0.3,
    createdAt: 3,
    ...overrides,
  };
}

async function renderedCostLine(
  record: EpisodeRecord,
  requestedModel = "primary/first",
  attemptModels: readonly string[] = [requestedModel],
): Promise<string> {
  let registered: ThreadTool | undefined;
  const pi = {
    registerTool(tool: unknown) {
      const candidate = tool as ThreadTool;
      if (candidate.name === "thread") registered = candidate;
    },
  } as unknown as ExtensionAPI;
  const thread = threadRecord();
  const manager = {
    async dispatch(options: DispatchOptions): Promise<DispatchResult> {
      assert.equal(options.model, requestedModel);
      assert.equal(attemptModels[0], requestedModel);
      return {
        episodeText: "> episode",
        episode: record,
        thread,
        usage: { turns: 1, input: 1, output: 2, cost: 0, contextTokens: 3 },
        warnings: [],
      };
    },
  } as unknown as ThreadManager;

  registerSlateTools(pi, {} as SlateStore, () => manager);
  assert.ok(registered, "the thread tool must be registered");
  const result = await registered.execute(
    "call-1",
    { task: "measure cost", type: "general", model: requestedModel },
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  const text = result.content[0]?.text;
  assert.ok(text, "the thread result must contain text");
  return text.split("\n")[1] ?? "";
}

test("dispatch cost totals recorded dollars from all three sources", { timeout: 1000 }, async () => {
  const line = await renderedCostLine(episode(), "fallback/final");

  assert.equal(
    line,
    "Cost: $0.6000 across all calls and models | tokens: input 111, output 222, cache read 333, cache write 444 | ended fallback/final @high | warm",
  );
});

test("dispatch cost totals recorded dollars across mixed-model calls and reports the ending route", { timeout: 1000 }, async () => {
  const line = await renderedCostLine(
    episode({ workerCostUsd: 0.4 }),
    "primary/first",
    ["primary/first", "fallback/final"],
  );

  assert.equal(
    line,
    "Cost: $0.9000 across all calls and models | tokens: input 111, output 222, cache read 333, cache write 444 | ended fallback/final @high | warm",
  );
  assert.doesNotMatch(line, /primary\/first/);
});

test("dispatch cost keeps absent usage partial and does not infer warmth from current thread state", { timeout: 1000 }, async () => {
  const partial = episode();
  delete partial.cacheRead;
  delete partial.workerCostUsd;
  const line = await renderedCostLine(partial);

  assert.equal(
    line,
    "Cost: ≥$0.5000 across reported calls and models. Some cost was not reported | tokens: input 111, output 222, cache read ≥330, cache write 444 | ended fallback/final @high",
  );
  assert.doesNotMatch(line, /\| warm/);
  assert.doesNotMatch(line, /\|\s*$/);
});

test("dispatch cost distinguishes a reported zero from absent usage and keeps a cold dispatch cold", { timeout: 1000 }, async () => {
  const zero = episode({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    compressorUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  zero.workerCostUsd = 0;
  zero.compressorCostUsd = 0;
  zero.compactionCostUsd = 0;
  const line = await renderedCostLine(zero);

  assert.equal(
    line,
    "Cost: $0.0000 across all calls and models | tokens: input 0, output 0, cache read 0, cache write 0 | ended fallback/final @high",
  );
  assert.doesNotMatch(line, /reported calls|≥|\| warm/);
});

test("dispatch cost stays readable when whole usage sources and the ending route are unknown", { timeout: 1000 }, async () => {
  const unknown = episode({
    cacheRead: 0,
    compressorUsage: undefined,
    compactionUsage: undefined,
    workerCostUsd: undefined,
    compressorCostUsd: undefined,
    compactionCostUsd: undefined,
    model: undefined,
    effort: undefined,
  });
  const line = await renderedCostLine(unknown);

  assert.equal(
    line,
    "Cost: ≥$0.0000 across reported calls and models. Some cost was not reported | tokens: input ≥1, output ≥2, cache read ≥0, cache write ≥4 | ended unknown model @unknown effort",
  );
  assert.doesNotMatch(line, /\| warm|\|\s*$/);
});
