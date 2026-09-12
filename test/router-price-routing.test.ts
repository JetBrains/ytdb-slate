import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findProfile, MODEL_PROFILES, type ModelProfile } from "../extension/model-profiles.ts";
import { ROUTER_OFF, resolveModelRouter, SHIPPED_PROFILE_SOURCE, type RouterProfileSource, type RouterRegistryModel } from "../extension/model-router.ts";
import { planRoute, type RoutePlanInput } from "../extension/route.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";

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

test("removed profiles are unprofiled through the real ThreadManager router-off composition", () => {
  const manager = new ThreadManager(new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI), {});
  const internals = manager as unknown as {
    routeInputs(ctx: ExtensionContext, thread: undefined, opts: { model: string; effort: "off" | "max" }): RoutePlanInput;
  };
  const models = new Set(["openai/gpt-5.4-mini", "openai/gpt-5.4-nano", "anthropic/claude-fable-5"]);
  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) => models.has(`${provider}/${id}`) ? { provider, id } : undefined,
      hasConfiguredAuth: () => true,
    },
  } as unknown as ExtensionContext;
  for (const [spec, effort] of [
    ["openai/gpt-5.4-mini", "max"],
    ["openai/gpt-5.4-nano", "max"],
    ["anthropic/claude-fable-5", "off"],
  ] as const) {
    assert.equal(findProfile(spec), undefined);
    assert.equal(planRoute(internals.routeInputs(ctx, undefined, { model: spec, effort })).kind, "proceed", spec);
  }
});

test("current Fable profile guards normal router-off source composition", () => {
  const manager = new ThreadManager(new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI), {});
  const internals = manager as unknown as {
    routeInputs(ctx: ExtensionContext, thread: undefined, opts: { model: string; effort: "off" }): RoutePlanInput;
  };
  const spec = "anthropic/claude-fable-5-1";
  assert.ok(findProfile(spec));
  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) => `${provider}/${id}` === spec ? { provider, id } : undefined,
      hasConfiguredAuth: () => true,
    },
  } as unknown as ExtensionContext;
  const verdict = planRoute(internals.routeInputs(ctx, undefined, { model: spec, effort: "off" }));
  assert.equal(verdict.kind, "reject");
  assert.match(verdict.kind === "reject" ? verdict.reason : "", /rejected outright as a provider-unsupported requested control/);
});

test("Gemini aliases use cached frozen evidence-gap views in normal router ON and OFF", () => {
  const canonicalSpec = "google-vertex/gemini-3.8-flash";
  const aliases = [
    "google/gemini-3.8-flash",
    "opencode/gemini-3.8-flash",
    "openrouter/google/gemini-3.8-flash",
  ];
  const canonical = findProfile(canonicalSpec);
  assert.ok(canonical);
  assert.deepEqual(canonical.capabilityMeasuredAt, ["low", "medium", "high"]);
  assert.match(canonical.routeFor, /71\.02%/);
  assert.equal(MODEL_PROFILES.length, 9);
  const canonicalResolution = resolveModelRouter({
    models: [canonicalSpec],
    registry: { find: () => ({ contextWindow: 1_048_576 }), hasConfiguredAuth: () => true },
    failover: { [canonicalSpec]: "anthropic/claude-opus-5" },
  });
  for (const effort of ["low", "medium", "high"] as const) {
    const on = planRoute({ resolution: canonicalResolution, requestedModel: canonicalSpec, requestedEffort: effort, requireExplicit: true, allowUnmeasuredEffort: false });
    assert.equal(on.kind, "proceed");
    if (on.kind === "proceed") assert.equal(on.effortUnmeasured, false);
    const off = planRoute({ resolution: ROUTER_OFF, profiles: SHIPPED_PROFILE_SOURCE, requestedModel: canonicalSpec, requestedEffort: effort, requireExplicit: true, allowUnmeasuredEffort: false });
    assert.equal(off.kind, "proceed");
    if (off.kind === "proceed") assert.equal(off.effortUnmeasured, false);
  }

  for (const alias of aliases) {
    const view = findProfile(alias);
    assert.ok(view);
    assert.strictEqual(findProfile(alias.toUpperCase()), view);
    assert.notStrictEqual(view, canonical);
    assert.equal(Object.isFrozen(view), true);
    assert.equal(Object.isFrozen(view.capabilityMeasuredAt), true);
    assert.equal(view.id, canonicalSpec);
    assert.deepEqual(view.aliases, aliases);
    assert.deepEqual(SHIPPED_PROFILE_SOURCE.ladderFor(view), ["low", "medium", "high"]);
    assert.deepEqual(view.apiRejectedLevels, ["off", "minimal"]);
    assert.deepEqual(view.capabilityMeasuredAt, []);
    assert.deepEqual(view.evidenceGapAt, ["low", "medium", "high"]);
    assert.doesNotMatch(view.routeFor, /71\.02%|\$1\.97|@medium/);
    assert.match(view.avoidFor, /cache, privacy, adapter, wire-format, rate/i);

    const registryModel = { cost: { input: 9, output: 10 }, contextWindow: 777_000 };
    const resolution = resolveModelRouter({
      models: [alias, canonicalSpec],
      registry: {
        find: (provider, id) => `${provider}/${id}` === alias ? registryModel : { cost: { input: 1, output: 2 }, contextWindow: 1_048_576 },
        hasConfiguredAuth: () => true,
      },
      failover: { [alias]: canonicalSpec, [canonicalSpec]: alias },
    });
    assert.deepEqual(resolution.candidates.map((candidate) => candidate.spec), [alias]);
    assert.deepEqual(resolution.candidates[0]?.registryCost.input, 9);
    assert.equal(resolution.candidates[0]?.contextWindow, 777_000);
    for (const effort of ["low", "medium", "high"] as const) {
      for (const allowUnmeasuredEffort of [true, false]) {
        const on = planRoute({ resolution, requestedModel: alias, requestedEffort: effort, requireExplicit: true, allowUnmeasuredEffort });
        assert.equal(on.kind, allowUnmeasuredEffort ? "proceed" : "reject", `${alias} ${effort} ON ${allowUnmeasuredEffort}`);
        if (on.kind === "proceed") assert.equal(on.effortUnmeasured, true);
        const off = planRoute({ resolution: ROUTER_OFF, profiles: SHIPPED_PROFILE_SOURCE, requestedModel: alias, requestedEffort: effort, requireExplicit: true, allowUnmeasuredEffort });
        assert.equal(off.kind, allowUnmeasuredEffort ? "proceed" : "reject", `${alias} ${effort} OFF ${allowUnmeasuredEffort}`);
        if (off.kind === "proceed") assert.equal(off.effortUnmeasured, true);
      }
    }
    for (const effort of ["off", "minimal"] as const) {
      assert.equal(planRoute({ resolution, requestedModel: alias, requestedEffort: effort, requireExplicit: true }).kind, "reject");
      assert.equal(planRoute({ resolution: ROUTER_OFF, profiles: SHIPPED_PROFILE_SOURCE, requestedModel: alias, requestedEffort: effort, requireExplicit: true }).kind, "reject");
    }
    const failover = planRoute({ resolution, profiles: SHIPPED_PROFILE_SOURCE, failoverSwitch: true, failoverFrom: "other/model", requestedModel: alias, requestedEffort: "medium", allowUnmeasuredEffort: false });
    assert.equal(failover.kind, "proceed");
    if (failover.kind === "proceed") assert.equal(failover.effortUnmeasured, false);
    const blockedFailover = planRoute({ resolution, profiles: SHIPPED_PROFILE_SOURCE, failoverSwitch: true, failoverFrom: "other/model", requestedModel: alias, requestedEffort: "off", allowUnmeasuredEffort: true });
    assert.equal(blockedFailover.kind, "reject");
  }
});

test("an unlisted Gemini alias fails membership before evidence policy", () => {
  const resolution = resolveModelRouter({
    models: ["google-vertex/gemini-3.8-flash"],
    registry: { find: () => ({ contextWindow: 1_048_576 }), hasConfiguredAuth: () => true },
    failover: { "google-vertex/gemini-3.8-flash": "anthropic/claude-opus-5" },
  });
  const verdict = planRoute({ resolution, requestedModel: "google/gemini-3.8-flash", requestedEffort: "medium", requireExplicit: true, allowUnmeasuredEffort: true });
  assert.equal(verdict.kind, "reject");
  assert.match(verdict.kind === "reject" ? verdict.reason : "", /not routable/);
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
