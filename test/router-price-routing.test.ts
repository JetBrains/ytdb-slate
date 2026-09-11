import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProfile } from "../extension/model-profiles.ts";
import { ROUTER_OFF, resolveModelRouter, type RouterProfileSource, type RouterRegistryModel } from "../extension/model-router.ts";
import { planRoute } from "../extension/route.ts";

function profile(id: string, tier: 1 | 2 | 3 | 4 = 1, tierUnsourced = false, aliases: string[] = []): ModelProfile {
  return {
    id, aliases, contextWindow: null, maxOutput: null, tier,
    ...(tierUnsourced ? { tierUnsourced: true as const } : {}),
    routeFor: "fixture work", avoidFor: "nothing", hazards: [],
    capabilityMeasuredAt: ["medium"], evidenceGapAt: [],
    unknownRoutingCriticalFields: [], evidence: "fixture evidence", asOf: "2026-08-06",
  };
}

function resolve(rows: ModelProfile[], models: Record<string, RouterRegistryModel>, configured = rows.map((row) => row.id)) {
  const profiles: RouterProfileSource = {
    findProfile: (spec) => rows.find((row) => row.id === spec || row.aliases.includes(spec)),
    ladderFor: () => ["medium"],
  };
  return resolveModelRouter({
    models: configured, profiles,
    registry: {
      find: (provider, id) => models[`${provider}/${id}`],
      hasConfiguredAuth: () => true,
    },
    failover: Object.fromEntries(configured.map((spec) => [spec, spec])),
  });
}

test("configured candidate order survives tier and registry-rate differences", () => {
  const rows = [profile("p/expensive", 4), profile("p/zero", 1, true), profile("p/unknown", 2)];
  const result = resolve(rows, {
    "p/expensive": { cost: { input: 100, output: 200 } },
    "p/zero": { cost: { input: 0, output: 0 } },
    "p/unknown": {},
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.spec), rows.map((row) => row.id));
  assert.equal("cheapest" in result, false);
  assert.deepEqual(result.candidates.map((candidate) => candidate.registryCost), [
    { input: 100, output: 200, cacheRead: undefined, cacheWrite: undefined },
    { input: 0, output: 0, cacheRead: undefined, cacheWrite: undefined },
    { input: undefined, output: undefined, cacheRead: undefined, cacheWrite: undefined },
  ]);
});

test("registry base-rate components validate independently without dropping a model", () => {
  const throwing = { get input(): number { throw new Error("hostile getter"); }, output: 7 };
  const cases: Array<[string, RouterRegistryModel, number | undefined, number | undefined]> = [
    ["p/zero", { cost: { input: 0, output: 0 } }, 0, 0],
    ["p/partial", { cost: { input: 2 } }, 2, undefined],
    ["p/negative", { cost: { input: -1, output: -2 } }, undefined, undefined],
    ["p/nan", { cost: { input: Number.NaN, output: Number.POSITIVE_INFINITY } }, undefined, undefined],
    ["p/text", { cost: { input: "1", output: 3 } as never }, undefined, 3],
    ["p/throwing", { cost: throwing }, undefined, 7],
    ["p/throwing-parent", { get cost(): never { throw new Error("hostile parent getter"); } }, undefined, undefined],
  ];
  const result = resolve(cases.map(([id]) => profile(id)), Object.fromEntries(cases.map(([id, model]) => [id, model])));
  assert.equal(result.candidates.length, cases.length);
  for (const [id, , input, output] of cases) {
    const candidate = result.candidates.find((item) => item.spec === id);
    assert.deepEqual([candidate?.registryCost.input, candidate?.registryCost.output], [input, output], id);
  }
});

test("provider-qualified registry lookup never borrows a canonical rate for an alias", () => {
  const canonical = profile("direct/same-id", 1, false, ["gateway/same-id"]);
  const result = resolve([canonical], {
    "direct/same-id": { cost: { input: 1, output: 2 } },
    "gateway/same-id": { cost: { input: 9, output: 10 } },
  }, ["gateway/same-id"]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.spec, "gateway/same-id");
  assert.deepEqual(result.candidates[0]?.registryCost, {
    input: 9, output: 10, cacheRead: undefined, cacheWrite: undefined,
  });
});

test("registry prices have no dispatch warning or routing effect", () => {
  const result = resolve([profile("p/selected"), profile("p/other")], {
    "p/selected": { cost: { input: 99, output: 100 } },
    "p/other": { cost: { input: 0, output: 0 } },
  });
  const verdict = planRoute({ resolution: result, requestedModel: "p/selected", requestedEffort: "medium", requireExplicit: true });
  assert.equal(verdict.kind, "proceed");
  assert.equal(verdict.kind === "proceed" ? verdict.model : undefined, "p/selected");
  assert.deepEqual(verdict.warnings, []);
  assert.equal(JSON.stringify(verdict).includes("price"), false);
});

test("explicit effort guards remain fail-soft on unreadable profiles and hard on readable facts", () => {
  const requested = { resolution: ROUTER_OFF, requestedModel: "p/model", requestedEffort: "medium", requireExplicit: true } as const;
  assert.equal(planRoute(requested).kind, "proceed");
  assert.equal(planRoute({ ...requested, profiles: { findProfile: () => { throw new Error("unreadable"); }, ladderFor: () => ["medium"] } }).kind, "proceed");
  assert.equal(planRoute({ ...requested, profiles: { findProfile: () => undefined, ladderFor: () => ["medium"] } }).kind, "proceed");

  const row = profile("p/model");
  assert.equal(planRoute({ ...requested, profiles: { findProfile: () => row, ladderFor: () => { throw new Error("unreadable"); } } }).kind, "proceed");
  const offLadder = planRoute({ ...requested, profiles: { findProfile: () => row, ladderFor: () => ["low"] } });
  assert.equal(offLadder.kind, "reject");
  assert.match(offLadder.kind === "reject" ? offLadder.reason : "", /effort ladder/);

  const rejected = { ...row, apiRejectedLevels: ["medium"] as const } as unknown as ModelProfile;
  const apiRejected = planRoute({ ...requested, profiles: { findProfile: () => rejected, ladderFor: () => ["medium"] } });
  assert.equal(apiRejected.kind, "reject");
  assert.match(apiRejected.kind === "reject" ? apiRejected.reason : "", /rejected outright/);

  const gap = { ...row, capabilityMeasuredAt: [], evidenceGapAt: ["medium"] } as ModelProfile;
  const source = { findProfile: () => gap, ladderFor: () => ["medium"] as const };
  const advisory = planRoute({ ...requested, profiles: source });
  assert.equal(advisory.kind, "proceed");
  assert.equal(advisory.kind === "proceed" ? advisory.effortUnmeasured : false, true);
  assert.equal(planRoute({ ...requested, profiles: source, allowUnmeasuredEffort: false }).kind, "reject");
});
