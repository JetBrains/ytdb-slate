import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REDISCOVERY_TURNS,
  MAX_PRICED_TURNS,
  classifyPrefixWarmth,
  estimateArmCost,
  planThreadChoice,
  resolveLongContext,
  resolveTokenRates,
  type ThreadChoiceInput,
  type ThreadChoiceVerdict,
} from "../extension/thread-choice.ts";

const thread = { id: "t1", tools: ["read"] } as const;
const last = {
  status: "ok" as const,
  model: "p/m",
  effort: "low" as const,
  cacheRead: 100,
  cacheWrite: 100,
  contextTokens: 1000,
  createdAt: 1000,
};
const rates = { inUsdPerMTok: 2, outUsdPerMTok: 4, cachedInUsdPerMTok: 1, cacheWriteUsdPerMTok: 3 };
const sizes = { freshSeedTokens: 100, episodeTokens: 50, taskTokens: 10, growthTokensPerTurn: 10, outputTokensPerTurn: 5, rediscoveryTurns: 1 };

function estimateOf(verdict: ThreadChoiceVerdict) {
  assert.ok("estimate" in verdict && verdict.estimate);
  return verdict.estimate;
}

function priced(overrides: Partial<ThreadChoiceInput> = {}): ThreadChoiceInput {
  return {
    now: 61_000,
    thread,
    last,
    action: { model: "p/m", effort: "low", expectedTurns: 3 },
    retention: { documentedSeconds: 60 },
    rates,
    sizes,
    allowance: ["e1"],
    knownEpisodeIds: ["e1"],
    ...overrides,
  };
}

test("warmth reports every cache evidence state and exact retention boundary", () => {
  const base = { now: 61_000, model: "p/m", effort: "low" as const, last };
  const cases = [
    [{ last: undefined }, false, "no-previous-dispatch"],
    [{ model: "p/other" }, false, "model-change"],
    [{ effort: "high" as const }, false, "effort-change"],
    [{ last: { ...last, cacheRead: 0, cacheWrite: 0 } }, false, "measured-cache-miss"],
    [{ retention: undefined }, true, "no-retention-data"],
    [{ now: undefined, retention: { documentedSeconds: 60 } }, true, "unknown-elapsed-time"],
    [{ now: 62_001, retention: { documentedSeconds: 60 } }, false, "retention-expired"],
    [{ now: 61_000, retention: { documentedSeconds: 60 } }, true, "within-retention"],
    [{ last: { ...last, cacheRead: 0, cacheWrite: 20 }, now: 62_001, retention: { documentedSeconds: 60 } }, false, "retention-expired"],
    [{ now: 61_000, retention: { documentedSeconds: 10, measuredWarmSeconds: 60 } }, true, "within-retention"],
  ] as const;
  for (const [override, warm, code] of cases) {
    const result = classifyPrefixWarmth({ ...base, ...override });
    assert.equal(result.warm, warm, code);
    assert.equal(result.code, code);
    assert.ok(result.reason.length > 20, code);
  }
  const negative = classifyPrefixWarmth({ ...base, now: 999, retention: { documentedSeconds: 60 } });
  assert.equal(negative.code, "unknown-elapsed-time");
});

test("planner settles unusable input and permission before later decisions", () => {
  const noAction = planThreadChoice({ thread, allowance: undefined, action: undefined });
  assert.deepEqual({ kind: noAction.kind, code: noAction.code }, { kind: "abstain", code: "no-action" });

  const absent = planThreadChoice({ ...priced(), allowance: undefined });
  assert.equal(absent.code, "allowance-absent");
  assert.match(absent.reason, /PERMISSION/);

  const malformed = planThreadChoice({ ...priced(), allowance: "bad" as unknown as readonly string[] });
  assert.equal(malformed.code, "allowance-absent");

  const empty = planThreadChoice({ ...priced(), allowance: [] });
  assert.equal(empty.code, "allowance-empty");
  assert.match(empty.reason, /explicit refusal/);

  const noIndex = planThreadChoice({ ...priced(), knownEpisodeIds: undefined });
  assert.equal(noIndex.code, "episode-index-unavailable");
  const missing = planThreadChoice({ ...priced(), knownEpisodeIds: ["other"] });
  assert.equal(missing.code, "episode-missing");
  assert.equal(missing.subject, "e1");
});

test("planner rejects malformed action and thread identities defensively", () => {
  assert.equal(planThreadChoice({ thread, action: null as unknown as ThreadChoiceInput["action"] }).code, "no-action");
  const noThread = planThreadChoice({ action: { model: "p/m", effort: "low", expectedTurns: 3 } });
  assert.equal(noThread.code, "no-thread-to-continue");
  const emptyId = planThreadChoice({ ...priced({ thread: { id: "", tools: ["read"] } }) });
  assert.equal(emptyId.code, "fresh-cheaper");
});

test("planner applies equipment and failed-dispatch refusals after allowance checks", () => {
  const unrecorded = planThreadChoice({ ...priced(), thread: { id: "t1" }, allowance: ["e1"] });
  assert.equal(unrecorded.code, "tool-allowance-unrecorded");
  assert.match(unrecorded.reason, /EQUIPMENT/);

  const emptyTools = planThreadChoice({ ...priced(), thread: { id: "t1", tools: [] }, allowance: ["e1"] });
  assert.equal(emptyTools.code, "tool-allowance-empty");

  const failed = planThreadChoice({ ...priced(), last: { ...last, status: "failed" } });
  assert.equal(failed.code, "last-dispatch-failed");

  const fresh = planThreadChoice({ action: { model: "p/m", effort: "low", expectedTurns: 3 } });
  assert.equal(fresh.kind, "fresh");
  assert.equal(fresh.code, "no-thread-to-continue");
  assert.match(fresh.reason, /new work stream/);
});

test("planner returns each economic abstention with its missing figure", () => {
  const cases: Array<[ThreadChoiceInput, string]> = [
    [{ ...priced({ rates: undefined }) }, "prices-unusable"],
    [{ ...priced({ last: { ...last, contextTokens: 0 } }) }, "prefix-size-unknown"],
    [{ ...priced({ sizes: { ...sizes, freshSeedTokens: undefined } }) }, "fresh-size-unknown"],
    [{ ...priced({ sizes: { ...sizes, episodeTokens: undefined } }) }, "episode-size-unknown"],
  ];
  for (const [input, code] of cases) {
    const result = planThreadChoice(input);
    assert.equal(result.kind, "abstain");
    assert.equal(result.code, code);
    assert.match(result.reason, /slate cannot compare|no usable input/);
  }
});

test("short work continues without arithmetic and preserves warmth evidence", () => {
  for (const expectedTurns of [undefined, 0, 1, 2, Number.NaN]) {
    const result = planThreadChoice(priced({ action: { model: "p/m", effort: "low", expectedTurns } }));
    assert.equal(result.kind, "continue");
    assert.equal(result.code, "short-work");
    assert.equal(result.estimate, undefined);
    assert.ok(result.warmth);
  }
});

test("token rates and arm costs preserve disjoint buckets and future-growth indexing", () => {
  assert.deepEqual(resolveTokenRates({ inUsdPerMTok: 2, outUsdPerMTok: 4, cachedInUsdPerMTok: 1, cacheWriteUsdPerMTok: 3 }), {
    cacheRead: 1,
    fresh: 3,
    output: 4,
    freshFromInputPrice: false,
  });
  assert.deepEqual(resolveTokenRates({ inUsdPerMTok: 2, outUsdPerMTok: 4, cachedInUsdPerMTok: 1, cacheWriteUsdPerMTok: 0 }), {
    cacheRead: 1,
    fresh: 2,
    output: 4,
    freshFromInputPrice: true,
  });
  assert.equal(resolveTokenRates({ inUsdPerMTok: 2, outUsdPerMTok: 4 }), undefined);

  const estimate = estimateArmCost({
    cachedPrefixTokens: 100,
    uncachedPrefixTokens: 50,
    turns: 3,
    growthTokensPerTurn: 10,
    outputTokensPerTurn: 5,
    rates: { cacheRead: 0.1, fresh: 1, output: 2, freshFromInputPrice: false },
  });
  assert.deepEqual(
    { turns: estimate.turns, cacheReadTokens: estimate.cacheReadTokens, freshTokens: estimate.freshTokens, outputTokens: estimate.outputTokens },
    { turns: 3, cacheReadTokens: 410, freshTokens: 70, outputTokens: 15 },
  );
  assert.ok(Math.abs(estimate.usd - 0.000141) < 1e-12);
});

test("long-context pricing uses the request threshold and reports an unpriced cliff", () => {
  const resolved = resolveLongContext({ threshold: 100, multipliers: { in: 2, out: 3, cachedIn: 4, cacheWrite: 5 } });
  assert.deepEqual(resolved, { threshold: 100, cacheRead: 4, fresh: 5, output: 3, priced: true });
  const ratesResolved = { cacheRead: 1, fresh: 1, output: 1, freshFromInputPrice: false };
  const at = estimateArmCost({ cachedPrefixTokens: 60, uncachedPrefixTokens: 40, turns: 1, growthTokensPerTurn: 0, outputTokensPerTurn: 10, rates: ratesResolved, longContext: resolved });
  const below = estimateArmCost({ cachedPrefixTokens: 59, uncachedPrefixTokens: 40, turns: 1, growthTokensPerTurn: 0, outputTokensPerTurn: 10, rates: ratesResolved, longContext: resolved });
  assert.equal(at.longContextTurns, 1);
  assert.equal(below.longContextTurns, 0);
  const unknown = resolveLongContext({ threshold: 1, multipliers: null });
  assert.deepEqual(unknown, { threshold: 1, cacheRead: 1, fresh: 1, output: 1, priced: false });
  const unpriced = planThreadChoice(priced({ longContext: { threshold: 1, multipliers: null } }));
  assert.equal(estimateOf(unpriced).longContextUnpriced, true);
});

test("defensive pricing guards reject malformed rates and retain known cliffs", () => {
  assert.equal(resolveTokenRates(undefined), undefined);
  assert.equal(resolveTokenRates({ inUsdPerMTok: -1, outUsdPerMTok: 1, cachedInUsdPerMTok: 1 }), undefined);
  assert.equal(resolveTokenRates({ inUsdPerMTok: 1, outUsdPerMTok: Number.NaN, cachedInUsdPerMTok: 1 }), undefined);
  assert.equal(resolveTokenRates({ inUsdPerMTok: 1, outUsdPerMTok: 1, cachedInUsdPerMTok: Number.POSITIVE_INFINITY }), undefined);
  assert.deepEqual(resolveLongContext(undefined), undefined);
  assert.deepEqual(resolveLongContext({ threshold: -1, multipliers: { in: 2, out: 2 } }), undefined);
  assert.deepEqual(resolveLongContext({ threshold: 10, multipliers: { in: -1, cachedIn: -2, cacheWrite: 0, out: 0 } }), {
    threshold: 10,
    cacheRead: 1,
    fresh: 1,
    output: 1,
    priced: false,
  });
  assert.deepEqual(resolveLongContext({ threshold: 10, multipliers: { in: 2, cachedIn: 0, cacheWrite: 0, out: 0 } }), {
    threshold: 10,
    cacheRead: 2,
    fresh: 2,
    output: 1,
    priced: true,
  });
});

test("planner preserves rediscovery, clamp metadata, seed assumptions, and exact ties", () => {
  const ordinary = planThreadChoice(priced());
  const ordinaryEstimate = estimateOf(ordinary);
  assert.equal(ordinaryEstimate.continuation.turns, 3);
  assert.equal(ordinaryEstimate.fresh.turns, 4);
  assert.equal(ordinaryEstimate.rediscoveryTurns, DEFAULT_REDISCOVERY_TURNS);
  assert.equal(ordinaryEstimate.freshSeedAssumedWritten, true);

  const clamped = planThreadChoice(priced({ action: { model: "p/m", effort: "low", expectedTurns: 1000 } }));
  const clampedEstimate = estimateOf(clamped);
  assert.equal(clampedEstimate.continuation.turns, MAX_PRICED_TURNS - 1);
  assert.equal(clampedEstimate.fresh.turns, MAX_PRICED_TURNS);
  assert.equal(clampedEstimate.turnsClamped, true);

  const readSeed = planThreadChoice(priced({ sizes: { ...sizes, freshSeedCache: "read" } }));
  const readSeedEstimate = estimateOf(readSeed);
  assert.equal(readSeedEstimate.freshSeedCache, "read");
  assert.equal(readSeedEstimate.freshSeedAssumedWritten, undefined);
  assert.match(readSeed.reason, /reads its seed prefix/);

  const tie = planThreadChoice(priced({ rates: { inUsdPerMTok: 0, outUsdPerMTok: 0, cachedInUsdPerMTok: 0, cacheWriteUsdPerMTok: 0 } }));
  assert.equal(tie.kind, "continue");
  assert.equal(tie.code, "equal-cost");
  assert.match(tie.reason, /tie keeps the existing prefix/);
});

test("planner chooses fresh and continuation from materially different exact prices", () => {
  const fresh = planThreadChoice(priced({
    sizes: { ...sizes, freshSeedTokens: 1, episodeTokens: 0 },
    last: { ...last, contextTokens: 1_000_000 },
  }));
  assert.equal(fresh.kind, "fresh");
  assert.equal(fresh.code, "fresh-cheaper");
  const freshEstimate = estimateOf(fresh);
  assert.ok(freshEstimate.fresh.usd < freshEstimate.continuation.usd);

  const continuation = planThreadChoice(priced({
    sizes: { ...sizes, freshSeedTokens: 1_000_000, episodeTokens: 100_000 },
    last: { ...last, contextTokens: 1000 },
  }));
  assert.equal(continuation.kind, "continue");
  assert.equal(continuation.code, "continuation-cheaper");
  const continuationEstimate = estimateOf(continuation);
  assert.ok(continuationEstimate.continuation.usd < continuationEstimate.fresh.usd);
});
