import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	captureSessionBaseline,
	createLogicalRuntime,
	decideEffortSwitch,
	decideModelSwitch,
	planSessionOpen,
} from "../extension/logical-model-runtime.ts";
import { sanitizeEpisodeRecord } from "../extension/state.ts";
import { executeWithRecoveryOwnership } from "../extension/logical-model-adapters.ts";
import { RecoveryOwnership } from "../extension/logical-model-recovery.ts";

function policyWithSharedRoute() {
	return {
		router: {
			models: {
				add: [{
					model: "shared-alias", capabilityRating: 45, effort: "max", costRating: 11,
					preferredProvider: "openai", providers: { openai: "gpt-6-luna" },
					guidelines: [], cautions: [],
				}],
			},
		},
	};
}

function route(logicalModel = "luna-6", effort = "max" as const) {
	return { kind: "ordinary" as const, logicalModel, effort, provider: "openai", model: "gpt-6-luna" };
}

function fakeModel(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "gpt-6-luna", name: "Luna", provider: "openai", api: "openai-responses",
		baseUrl: "https://invalid.example", reasoning: true,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000, maxTokens: 100, thinkingLevelMap: { max: "max" }, ...overrides,
	} as Model<any>;
}

function registry(model: Model<any> | undefined, auth: "ok" | "missing" | "throw" = "ok") {
	return {
		find: () => model,
		getApiKeyAndHeaders: async () => {
			if (auth === "throw") throw new Error("auth failed");
			return auth === "ok" ? { ok: true, apiKey: "test-only" } : { ok: false, error: "missing" };
		},
	} as unknown as Pick<ExtensionContext, "modelRegistry">["modelRegistry"];
}

test("runtime freezes one usable policy and keeps prompt, effective view, and defaults aligned", () => {
	const warnings: string[] = [];
	const runtime = createLogicalRuntime({ trusted: true, projectConfig: { modelFailover: {}, router: {} }, warn: (message) => warnings.push(message) });
	assert.ok(Object.isFrozen(runtime));
	assert.ok(Object.isFrozen(runtime.policy));
	assert.deepEqual(runtime.criticalErrors, []);
	assert.equal(runtime.policy?.ordinary.length, 6);
	assert.equal(runtime.definition("sol-6")?.capabilityRating, 58);
	assert.equal(runtime.effortFor("claude-sonnet-5"), "high");
	assert.match(runtime.promptText() ?? "", /gpt-6-astra/);
	assert.match(runtime.effectiveText(), /fixedEffort=max/);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /Legacy key modelFailover is ignored/);
});

test("untrusted configuration cannot alter policy or inject warnings", () => {
	const runtime = createLogicalRuntime({ trusted: false, projectConfig: { router: { models: { include: [] } }, episodeModel: "bad" } });
	assert.deepEqual(runtime.criticalErrors, []);
	assert.equal(runtime.policy?.ordinary.length, 6);
	assert.deepEqual(runtime.warnings, []);
});

test("prompt overflow blocks every operational policy surface without truncation", () => {
	const runtime = createLogicalRuntime({
		trusted: true,
		projectConfig: { router: { models: { replace: [{ model: "luna-6", cautions: ["x".repeat(20_000)] }] } } },
	});
	assert.equal(runtime.policy, undefined);
	assert.equal(runtime.promptText(), undefined);
	assert.equal(runtime.admit(), undefined);
	assert.match(runtime.criticalErrors.join("\n"), /Nothing was truncated/);
	assert.match(runtime.effectiveText(), /Status: blocked/);
});

test("routes use remembered, preferred, then declared providers and publish only admitted values", () => {
	const runtime = createLogicalRuntime({
		trusted: true,
		projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "openai", providers: { openai: "gpt-6-luna", second: "luna-2" } }] } } },
	});
	const first = runtime.admit();
	assert.ok(first);
	assert.equal(runtime.startRoute("luna-6", first.snapshot)?.provider, "openai");
	assert.deepEqual({ ...runtime.rememberedSelections().providers }, {});
	assert.equal(runtime.publishProvider(first, "luna-6", "second"), true);
	const second = runtime.admit();
	assert.ok(second);
	assert.equal(runtime.startRoute("luna-6", second.snapshot)?.provider, "second");
	assert.deepEqual({ ...runtime.rememberedSelections().providers }, { "luna-6": "second" });
	assert.match(runtime.effectiveText(runtime.rememberedSelections()), /preferredProvider=openai; rememberedProvider=second/);
	assert.equal(runtime.publishProvider(second, "luna-6", "invented"), false);
	assert.equal(runtime.startRoute("not-present", second.snapshot), undefined);

	const manyProviders = Object.fromEntries(Array.from({ length: 12_000 }, (_, index) => [`p${index}`, `model-${index}`]));
	const large = createLogicalRuntime({
		trusted: true,
		projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "p1", providers: manyProviders }] } } },
	});
	assert.equal(large.startRoute("luna-6", { providers: { "luna-6": "p11999" }, compressorIndex: 0, resetEpoch: 0 })?.provider, "p11999");
});

test("reverse mapping reports zero, one, and many and accepts only a matching trusted identity", () => {
	const ordinary = createLogicalRuntime({ trusted: true });
	assert.deepEqual(ordinary.reverseMap({ provider: "absent", model: "none" }), { kind: "none" });
	assert.deepEqual(ordinary.reverseMap({ provider: "openai", model: "gpt-6-sol" }), {
		kind: "one", logicalModel: "sol-6", source: "exact-route",
	});
	const shared = createLogicalRuntime({ trusted: true, projectConfig: policyWithSharedRoute() });
	const ambiguous = shared.reverseMap({ provider: "openai", model: "gpt-6-luna" });
	assert.deepEqual(ambiguous, { kind: "several", logicalModels: ["luna-6", "shared-alias"] });
	assert.equal(shared.reverseMap({ provider: "openai", model: "gpt-6-luna" }, "not-a-match").kind, "several");
	assert.deepEqual(shared.reverseMap({ provider: "openai", model: "gpt-6-luna" }, "shared-alias"), {
		kind: "one", logicalModel: "shared-alias", source: "trusted-identity",
	});
});

test("route validation uses exact policy permission, Pi registry, credentials, and effort support", async () => {
	const runtime = createLogicalRuntime({ trusted: true });
	const throwingRegistry = registry(undefined);
	throwingRegistry.find = () => { throw new Error("registry unavailable"); };
	assert.deepEqual(await runtime.validateRoute({ modelRegistry: throwingRegistry }, route()), {
		ok: false, kind: "unavailable", reason: "The permitted physical route is absent from Pi's model registry.",
	});
	assert.deepEqual(await runtime.validateRoute({ modelRegistry: registry(undefined) }, route()), {
		ok: false, kind: "unavailable", reason: "The permitted physical route is absent from Pi's model registry.",
	});
	const missing = await runtime.validateRoute({ modelRegistry: registry(fakeModel(), "missing") }, route());
	assert.equal(missing.ok ? undefined : missing.kind, "unavailable");
	const thrown = await runtime.validateRoute({ modelRegistry: registry(fakeModel(), "throw") }, route());
	assert.equal(thrown.ok ? undefined : thrown.kind, "unavailable");
	const unsupported = await runtime.validateRoute({ modelRegistry: registry(fakeModel({ thinkingLevelMap: { max: null } })) }, route());
	assert.equal(unsupported.ok ? undefined : unsupported.kind, "unsupported");
	assert.deepEqual(await runtime.validateRoute({ modelRegistry: registry(fakeModel()) }, route()), { ok: true });
	const forbidden = await runtime.validateRoute({ modelRegistry: registry(fakeModel()) }, { ...route(), provider: "other" });
	assert.equal(forbidden.ok ? undefined : forbidden.kind, "unavailable");
});

test("replacement runtimes share active saved-default ownership but reset preferences independently", { timeout: 2_000 }, async () => {
	const scope = `runtime-test-settings:${Date.now()}:${Math.random()}`;
	const first = createLogicalRuntime({ trusted: true, ownership: new RecoveryOwnership(scope) });
	const admission = first.admit();
	assert.ok(admission);
	assert.equal(first.publishProvider(admission, "luna-6", "openai"), true);
	const held = first.ownership.acquire("old-session", "saved-default");
	assert.equal(held.kind, "acquired");
	first.resetPreferences();
	first.ownership.retireLifecycle();
	const replacement = createLogicalRuntime({ trusted: true, ownership: new RecoveryOwnership(scope) });
	assert.notEqual(replacement.ownership, first.ownership);
	assert.equal(first.ownership.isCurrentLifecycle(), false);
	assert.equal(replacement.ownership.isCurrentLifecycle(), true);
	assert.deepEqual(replacement.ownership.acquire("new-session", "saved-default"), { kind: "busy", resource: "saved-default", key: "saved-default" });
	if (held.kind === "acquired") held.lease.release();
	assert.equal(replacement.ownership.acquire("new-session", "saved-default").kind, "acquired");
});

test("preference resets invalidate snapshots but never force-release an active ownership lease", async () => {
	const runtime = createLogicalRuntime({ trusted: true });
	const before = runtime.admit();
	assert.ok(before);
	assert.equal(runtime.publishProvider(before, "luna-6", "openai"), true);
	const acquired = runtime.ownership.acquire("session", "defaults");
	assert.equal(acquired.kind, "acquired");
	runtime.resetPreferences();
	assert.equal(runtime.publishProvider(before, "luna-6", "openai"), false);
	assert.deepEqual(runtime.ownership.acquire("session", "defaults"), { kind: "busy", resource: "execution-session", key: "session" });
	if (acquired.kind === "acquired") acquired.lease.release();
	assert.equal(runtime.ownership.acquire("session", "defaults").kind, "acquired");

	let releaseInner: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => { releaseInner = resolve; });
	const operation = executeWithRecoveryOwnership(runtime.ownership, "held", "shared", async () => entered);
	await Promise.resolve();
	runtime.resetPreferences();
	assert.equal(runtime.ownership.acquire("held", "shared").kind, "busy");
	releaseInner?.();
	assert.equal((await operation).kind, "completed");
	assert.equal(runtime.ownership.acquire("held", "shared").kind, "acquired");
});

test("session mechanics preserve opening baseline on both axes", () => {
	const baseline = captureSessionBaseline({ model: { provider: "p", id: "opened" }, thinkingLevel: "medium" });
	assert.deepEqual(decideModelSwitch({ planned: "p/action", current: "p/opened", baseline }), { kind: "switch", spec: "p/action", source: "plan" });
	assert.deepEqual(decideModelSwitch({ current: "p/action", baseline }), { kind: "switch", spec: "p/opened", source: "revert" });
	assert.deepEqual(decideModelSwitch({ current: "p/action", baseline, failoverHeld: true }), { kind: "keep", reason: "failover-held" });
	assert.deepEqual(decideEffortSwitch({ current: "high", baseline }), { kind: "switch", level: "medium", source: "revert" });
	assert.equal(planSessionOpen({ provider: "p", model: "opened" }).model, "p/opened");
});

test("session normalization fails closed and covers every keep and switch decision", () => {
	assert.deepEqual(captureSessionBaseline({}), {});
	assert.deepEqual(captureSessionBaseline({ model: { provider: 7, id: "model" }, thinkingLevel: "invented" }), {});
	assert.deepEqual(captureSessionBaseline({ model: { provider: "p", id: 7 }, thinkingLevel: "high" }), { effort: "high" });
	const baseline = captureSessionBaseline({ model: { provider: "p", id: "base" }, thinkingLevel: "medium" });
	assert.deepEqual(decideModelSwitch({ planned: "p/live", current: "p/live", baseline }), { kind: "keep", reason: "already-current" });
	assert.deepEqual(decideModelSwitch({ current: "p/base", baseline }), { kind: "keep", reason: "already-current" });
	assert.deepEqual(decideModelSwitch({ current: "p/live" }), { kind: "keep", reason: "no-baseline" });
	assert.deepEqual(decideModelSwitch({ planned: "", current: "p/live", baseline }), { kind: "switch", spec: "p/base", source: "revert" });
	assert.deepEqual(decideEffortSwitch({ current: "medium", baseline }), { kind: "keep", reason: "already-current" });
	assert.deepEqual(decideEffortSwitch({ planned: "high", current: "low", baseline }), { kind: "switch", level: "high", source: "plan" });
	assert.deepEqual(decideEffortSwitch({ current: "low" }), { kind: "keep", reason: "no-baseline" });
	assert.deepEqual(planSessionOpen(undefined), {});
});

test("blocked runtime surfaces remain inert and remember no compressor", () => {
	const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { compressor: { models: [] } } } });
	assert.deepEqual(runtime.rememberedSelections(), {});
	assert.deepEqual(runtime.planOrdinary("luna-6", { providers: {}, compressorIndex: 0, resetEpoch: 0 }), []);
	assert.deepEqual(runtime.planCompressor({ providers: {}, compressorIndex: 0, resetEpoch: 0 }), []);
	assert.equal(runtime.publishProvider({ sequence: 1, resetEpoch: 0, snapshot: { providers: {}, compressorIndex: 0, resetEpoch: 0 } } as never, "luna-6", "openai"), false);
	assert.equal(runtime.publishCompressor({} as never, 0), false);
	runtime.resetPreferences();
});

test("logical action history preserves every resolver-accepted name and rejects malformed values", () => {
	const longName = `m${"x".repeat(200)}`;
	const longRuntime = createLogicalRuntime({
		trusted: true,
		projectConfig: { router: { models: { add: [{ model: longName, capabilityRating: 50, effort: "high", costRating: 50, preferredProvider: "p", providers: { p: "exact/id" }, guidelines: [], cautions: [] }] } } },
	});
	assert.equal(longRuntime.definition(longName)?.model, longName, "the resolver accepts the 201-character name");
	const physical = {
		id: "t1.e1", threadId: "t1", task: "work", status: "ok", file: "/tmp/e.md",
		logicalModel: longName, requestedModel: "openai/gpt-6-sol", requestedEffort: "high",
		model: "openai/gpt-6-sol", effort: "high", createdAt: 1,
	};
	const repairs: string[] = [];
	assert.deepEqual(sanitizeEpisodeRecord(physical, repairs), physical);
	assert.deepEqual(repairs, []);
	const legacy = sanitizeEpisodeRecord({ id: "t2.e1", threadId: "t2", task: "old", status: "ok", file: "/tmp/old.md", createdAt: 2 }, []);
	assert.ok(legacy);
	assert.equal("logicalModel" in legacy, false);
	for (const value of ["", "bad/name", "UPPER", 7]) {
		const rejectedRepairs: string[] = [];
		const rejected = sanitizeEpisodeRecord({ ...physical, logicalModel: value }, rejectedRepairs);
		assert.equal(rejected?.logicalModel, undefined);
		assert.match(rejectedRepairs.join("\n"), /ignoring logicalModel/);
		assert.equal(rejected?.model, physical.model);
	}
});
