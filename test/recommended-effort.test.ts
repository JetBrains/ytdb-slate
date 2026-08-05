import assert from "node:assert/strict";
import test from "node:test";
import { registerSlateMode } from "../extension/mode.ts";
import {
  recommendationRejectionReason,
  resolveModelRouter,
  type EffortCheck,
  type ModelRouterResolution,
  type RouterCandidate,
} from "../extension/model-router.ts";
import { planRoute, seededEffort } from "../extension/route.ts";
import type { ModelProfile } from "../extension/model-profiles.ts";
import { SlateStore, type SlateConfig } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";

const spec = "fake/model";

function profile(recommendedEffort: unknown = null, measured: string[] = ["low", "medium"], extra: Record<string, unknown> = {}): ModelProfile {
  return {
    id: spec,
    aliases: [],
    provider: "fake",
    tier: 1,
    contextWindow: 1000,
    price: [{ inUsdPerMTok: 1, outUsdPerMTok: 1 }],
    routeFor: "tests",
    avoidFor: "none",
    hazards: [],
    recommendedEffort: recommendedEffort as ModelProfile["recommendedEffort"],
    capabilityMeasuredAt: measured as ModelProfile["capabilityMeasuredAt"],
    evidenceGapAt: [],
    unknownRoutingCriticalFields: [],
    ...extra,
  } as unknown as ModelProfile;
}

function resolution(candidate: Partial<RouterCandidate> = {}): ModelRouterResolution {
  const model: RouterCandidate = {
    spec,
    provider: "fake",
    id: "model",
    profile: profile(),
    tier: 1,
    inUsdPerMTok: 1,
    outUsdPerMTok: 1,
    contextWindow: 1000,
    ladder: ["low", "medium"],
    recommendedEffort: undefined,
    hasFailover: false,
    nonPreferred: null,
    tierUnsourced: false,
    ladderAssumed: false,
    ...candidate,
  };
  return { on: true, candidates: [model], cheapest: spec, cheapestNonPreferred: false, warnings: [] };
}

function resolved(recommended: unknown, measured = ["low", "medium"], extra: Record<string, unknown> = {}) {
  return resolveModelRouter({
    models: [spec],
    registry: { find: () => ({ contextWindow: 1000 }), hasConfiguredAuth: () => true },
    profiles: { findProfile: () => profile(recommended, measured, extra), ladderFor: () => ["low", "medium"] },
    today: "2026-08-01",
  });
}

test("seeded effort accepts recommendations and uses the lowest measured fallback", () => {
  assert.equal(seededEffort(resolved("medium"), spec), "medium");
  assert.equal(seededEffort(resolved(null), spec), "low");
});

test("seeded effort reports invalid recommendations and falls back safely", () => {
  const warnings: string[] = [];
  assert.equal(seededEffort(resolved("high"), spec, (message) => warnings.push(message)), "low");
  assert.match(warnings[0] ?? "", /not on the model's effort ladder/);

  const absent = resolution();
  assert.equal(seededEffort({ ...absent, candidates: [], cheapest: undefined }, spec), undefined);
  assert.equal(seededEffort(resolution({ recommendedEffort: undefined }), "missing/model"), undefined);
});

test("seeded effort falls back without throwing on malformed rejection metadata", () => {
  const warnings: string[] = [];
  const candidate = { recommendedEffortRejected: { effort: 7 as unknown as string, reason: null as unknown as string } };
  assert.equal(seededEffort(resolution(candidate), spec, (message) => warnings.push(message)), "low");
  assert.deepEqual(warnings, []);
  assert.equal(seededEffort(resolution({ recommendedEffort: undefined },), spec), "low");
  assert.equal(seededEffort(resolution({ ladder: [] }), spec), undefined);
});

test("router records each recommendation rejection cause and accepts a measured level", () => {
  const cases: Array<[unknown, string, string]> = [
    [7, "it is not a string effort level", "rejected"],
    ["", "not one of pi's thinking levels", "rejected"],
    ["high", "not on the model's effort ladder", "rejected"],
    ["medium", "provider rejects that level outright", "rejected"],
    ["low", "", "accepted"],
  ];
  for (const [recommended, text, outcome] of cases) {
    const result = resolved(recommended, ["low"], recommended === "medium" ? { apiRejectedLevels: ["medium"] } : {});
    const candidate = result.candidates[0];
    assert.ok(candidate);
    if (outcome === "accepted") assert.equal(candidate.recommendedEffort, "low");
    else assert.match(candidate.recommendedEffortRejected?.reason ?? "", new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("plan route explains every reachable recommendation rejection reason", () => {
  const cases: Array<[Partial<RouterCandidate>, RegExp]> = [
    [{ recommendedEffort: "bogus" as never }, /not one of pi's thinking levels/],
    [{ recommendedEffort: "medium", profile: profile(null, ["low", "medium"], { apiRejectedLevels: ["medium"] }) }, /provider rejects that level outright/],
    [{ recommendedEffort: "high" }, /not on the model's effort ladder/],
    [{ recommendedEffort: "medium", profile: profile(null, ["low"]), ladder: ["low", "medium"] }, /no traced capability measurement/],
  ];
  for (const [candidate, reason] of cases) {
    const result = planRoute({ resolution: resolution(candidate) });
    assert.equal(result.kind, "proceed");
    assert.equal(result.warnings?.length, 1);
    assert.match(result.warnings?.[0] ?? "", reason);
  }

  // A listed candidate cannot produce checkEffort's not-listed verdict. Keep the
  // defensive fallback branch covered directly because the planner cannot reach it.
  const notListed: EffortCheck = { verdict: "not-listed", spec, effort: "low", ladder: [], measured: false, listedGap: false, apiRejected: false };
  assert.match(recommendationRejectionReason(notListed), /returned not-listed/);
});

test("plan route deduplicates repeated recommendation warnings", () => {
  const result = planRoute({ resolution: resolved("low", []) });
  assert.equal(result.kind, "proceed");
  assert.equal(result.baseEffort, undefined);
  assert.equal(result.effort, undefined);
  assert.equal(result.warnings?.filter((warning) => warning.includes("recommended effort")).length, 1);
  assert.match(result.warnings?.[0] ?? "", /No measured fallback exists, so pi's own level applies/);
});

test("routing doctrine marks recommendations and explains only used legends", async () => {
  let beforeStart: ((event: { systemPrompt: string }, ctx: { cwd: string; isProjectTrusted(): boolean }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
  const pi = {
    registerCommand() {},
    on(event: string, handler: unknown) { if (event === "before_agent_start") beforeStart = handler as typeof beforeStart; },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools() {},
  };
  const store = new SlateStore({ appendEntry() {} } as never);
  store.orchestratorMode = true;
  registerSlateMode(pi as never, store, {} as never, () => ({ router: { models: [spec] } } as SlateConfig), () => EMPTY_WORKER_EXTENSION_SET, () => resolved("low"));
  assert.ok(beforeStart);
  const output = await beforeStart!({ systemPrompt: "seed" }, { cwd: process.cwd(), isProjectTrusted: () => true });
  assert.ok(output);
  assert.match(output.systemPrompt, /low\*/);
  assert.match(output.systemPrompt, /\* = recommended default/);
  assert.doesNotMatch(output.systemPrompt, /none = pi's own level applies/);

  const noRecommendation = await (() => {
    const next = new SlateStore({ appendEntry() {} } as never);
    next.orchestratorMode = true;
    let handler: typeof beforeStart;
    registerSlateMode(pi as never, next, {} as never, () => ({ router: { models: [spec] } } as SlateConfig), () => EMPTY_WORKER_EXTENSION_SET, () => resolved(null, []));
    handler = beforeStart!;
    return handler({ systemPrompt: "seed" }, { cwd: process.cwd(), isProjectTrusted: () => true });
  })();
  assert.ok(noRecommendation);
  assert.match(noRecommendation.systemPrompt, /none/);
  assert.match(noRecommendation.systemPrompt, /none = pi's own level applies/);
});
