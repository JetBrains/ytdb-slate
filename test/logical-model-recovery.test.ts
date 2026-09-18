import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalModelDefinition } from "../extension/logical-model-definitions.ts";
import { executeCompression, executeRecovery, executeWithRecoveryOwnership } from "../extension/logical-model-adapters.ts";
import { RecoveryOperation, RecoveryOwnership, RecoveryPreferences, ordinaryModelRecoveryOrder, planCompressorRecovery, planOrdinaryRecovery } from "../extension/logical-model-recovery.ts";
import type { LogicalModelPolicy } from "../extension/logical-model-resolver.ts";

function model(name: string, capabilityRating: number, costRating: number, providers: Record<string, string>, preferredProvider = Object.keys(providers)[0]!): LogicalModelDefinition {
	return { model: name, capabilityRating, costRating, effort: "high", preferredProvider, providers, guidelines: [], cautions: [] };
}

function policy(): LogicalModelPolicy {
	const rows = [
		model("active", 50, 50, { a: "shared", b: "active-b", c: "active-c" }, "b"),
		model("same-expensive", 50, 80, { x: "same-expensive" }),
		model("same-cheap", 50, 10, { x: "same-cheap" }),
		model("higher-expensive", 60, 90, { h: "higher-expensive" }),
		model("higher-cheap", 60, 20, { h: "higher-cheap" }),
		model("lower", 40, 30, { l: "lower" }),
		model("higher-far", 80, 5, { z: "higher-far" }),
		model("lower-far", 20, 5, { z: "lower-far" }),
	];
	const definitions = Object.fromEntries(rows.map((row) => [row.model, row]));
	return { definitions, ordinary: rows, compressor: [{ model: "active", effort: "medium" }, { model: "same-cheap", effort: "low" }, { model: "higher-cheap", effort: "max" }] };
}

const noPreferences = { providers: Object.freeze(Object.create(null) as Record<string, string>), compressorIndex: 0, resetEpoch: 0 };

test("ordinary recovery uses provider-first exact-rating cost order and sparse alternation", () => {
	const value = policy();
	assert.deepEqual(ordinaryModelRecoveryOrder(value, "active").map((row) => row.model), [
		"active", "same-cheap", "same-expensive", "higher-cheap", "higher-expensive", "lower", "higher-far", "lower-far",
	]);
	const initial = planOrdinaryRecovery(value, "active", noPreferences);
	assert.deepEqual(initial.slice(0, 3).map((route) => route.provider), ["b", "a", "c"]);
	const rememberedUnavailable = planOrdinaryRecovery(value, "active", { ...noPreferences, providers: Object.freeze({ active: "missing" }) });
	assert.deepEqual(rememberedUnavailable.slice(0, 3).map((route) => route.provider), ["b", "a", "c"]);
	const plan = planOrdinaryRecovery(value, "active", { ...noPreferences, providers: Object.freeze({ active: "c" }) }, { provider: "a", model: "shared" });
	assert.deepEqual(plan.slice(0, 2).map((route) => `${route.provider}/${route.model}@${route.effort}`), ["c/active-c@high", "b/active-b@high"]);
	assert.equal(plan.some((route) => route.provider === "a" && route.model === "shared"), false);
	assert.equal(plan.every((route) => value.definitions[route.logicalModel]?.providers[route.provider] === route.model), true);
});

test("post-exhaustion planning excludes the active physical pair across logical identities", () => {
	const rows = [
		model("active", 50, 10, { p: "shared", q: "next" }, "p"),
		model("alias-identity", 50, 20, { p: "shared", r: "other" }, "p"),
	];
	const value: LogicalModelPolicy = { definitions: Object.fromEntries(rows.map((row) => [row.model, row])), ordinary: rows, compressor: [{ model: "active", effort: "medium" }] };
	const plan = planOrdinaryRecovery(value, "active", noPreferences, { provider: "p", model: "shared" });
	assert.deepEqual(plan.map((candidate) => `${candidate.logicalModel}:${candidate.provider}/${candidate.model}@${candidate.effort}`), ["active:q/next@high", "alias-identity:r/other@high"]);
});

test("one-sided ordinary recovery exhausts each entered rating by cost and configured ties", () => {
	const rows = [model("start", 10, 10, { p: "start" }), model("far-b", 30, 20, { p: "far-b" }), model("far-a", 30, 20, { p: "far-a" }), model("near", 20, 90, { p: "near" })];
	const value: LogicalModelPolicy = { definitions: Object.fromEntries(rows.map((row) => [row.model, row])), ordinary: rows, compressor: [{ model: "start", effort: "medium" }] };
	assert.deepEqual(ordinaryModelRecoveryOrder(value, "start").map((row) => row.model), ["start", "near", "far-b", "far-a"]);
});

test("operation-local visitation prevents repeated physical pairs across logical and compressor entries", { timeout: 2_000 }, async () => {
	const operation = new RecoveryOperation();
	assert.equal(operation.enter({ provider: "p", model: "m" }), true);
	assert.equal(operation.enter({ provider: "p", model: "m" }), false);
	assert.equal(operation.enter({ provider: "p2", model: "m" }), true);
	assert.equal(operation.visitedCount, 2);
	assert.equal(new RecoveryOperation().enter({ provider: "p", model: "m" }), true);

	let calls = 0;
	const duplicate = Object.freeze([
		{ kind: "ordinary", logicalModel: "one", effort: "high", provider: "p", model: "m" },
		{ kind: "ordinary", logicalModel: "two", effort: "low", provider: "p", model: "m" },
	] as const);
	const result = await executeRecovery({
		candidates: duplicate,
		retainedToolResults: [],
		validateSwitch: () => ({ ok: true }),
		attempt: () => { calls++; return { kind: "retry-exhausted" }; },
	});
	assert.equal(result.kind, "exhausted");
	assert.equal(calls, 1);
	assert.equal(result.attempted.length, 1);
});

test("preferences use admission freshness, reset invalidation, and no-backward compressor precedence", () => {
	const state = new RecoveryPreferences(policy());
	const earlier = state.admit();
	const later = state.admit();
	assert.equal(state.publishProvider(later, "active", "c"), true);
	assert.equal(state.publishProvider(earlier, "active", "a"), false);
	assert.equal(state.publishCompressor(earlier, 2), true);
	assert.equal(state.publishCompressor(later, 1), false);
	const after = state.admit();
	assert.equal(after.snapshot.providers.active, "c");
	assert.equal(after.snapshot.compressorIndex, 2);
	state.reset();
	assert.equal(state.publishProvider(after, "active", "b"), false);
	assert.equal(state.publishCompressor(after, 2), false);
	const reset = state.admit();
	assert.equal(reset.snapshot.providers.active, undefined);
	assert.equal(reset.snapshot.compressorIndex, 0);
});

test("compressor progression starts at remembered entry, moves only forward, and keeps entry effort", () => {
	const plan = planCompressorRecovery(policy(), { ...noPreferences, compressorIndex: 1 });
	assert.deepEqual(plan.map((entry) => [entry.compressorIndex, entry.logicalModel, entry.effort]), [[1, "same-cheap", "low"], [2, "higher-cheap", "max"]]);
});

test("execution advances only on known retry exhaustion and records actual effort", { timeout: 2_000 }, async () => {
	const candidates = planOrdinaryRecovery(policy(), "active", noPreferences).slice(0, 3);
	const seen: string[] = [];
	const retained = Object.freeze([{ id: "tool-1", value: "done" }]);
	const result = await executeRecovery({
		candidates,
		retainedToolResults: retained,
		validateSwitch: () => ({ ok: true }),
		attempt: ({ candidate, retainedToolResults }) => {
			assert.equal(retainedToolResults, retained);
			seen.push(candidate.model);
			return seen.length < 3 ? { kind: "retry-exhausted" } : { kind: "success", value: "ok", actualEffort: "medium" };
		},
	});
	assert.equal(result.kind, "success");
	if (result.kind === "success") assert.equal(result.actualEffort, "medium");
	assert.deepEqual(seen, candidates.map((candidate) => candidate.model));
});

test("cancellation, unknown evidence, terminal faults, and validation refusal stop without fallback", { timeout: 2_000 }, async () => {
	const candidates = planOrdinaryRecovery(policy(), "active", noPreferences).slice(0, 3);
	for (const terminal of [{ kind: "cancelled" }, { kind: "unknown", reason: "no retry evidence" }, { kind: "terminal-fault", reason: "authentication" }] as const) {
		let calls = 0;
		const result = await executeRecovery({ candidates, retainedToolResults: [], validateSwitch: () => ({ ok: true }), attempt: () => { calls++; return terminal; } });
		assert.equal(result.kind, terminal.kind);
		assert.equal(calls, 1);
	}
	let calls = 0;
	const refused = await executeRecovery({ candidates, retainedToolResults: [], validateSwitch: () => ({ ok: false, kind: "unsupported", reason: "unsupported effort" }), attempt: () => { calls++; return { kind: "retry-exhausted" }; } });
	assert.equal(refused.kind, "terminal-fault");
	assert.equal(calls, 0);
	let validations = 0;
	const unavailable = await executeRecovery({ candidates, retainedToolResults: [], validateSwitch: () => ++validations < 3 ? ({ ok: false, kind: "unavailable", reason: "not available" }) : ({ ok: true }), attempt: () => ({ kind: "success", value: "later", actualEffort: "high" }) });
	assert.equal(unavailable.kind, "success");
	assert.equal(validations, 3);
	const thrown = await executeRecovery({ candidates, retainedToolResults: [], validateSwitch: () => ({ ok: true }), attempt: () => { throw new Error("lost evidence"); } });
	assert.equal(thrown.kind, "unknown");
	assert.equal(thrown.kind === "unknown" ? thrown.reason : "", "Execution adapter threw before producing evidence.");
});

test("compression success and failure preserve completed identity and actual execution facts", { timeout: 2_000 }, async () => {
	const completed = Object.freeze({ text: "bounded completed output" });
	const compressed = Object.freeze({ text: "compressed output from the later candidate" });
	const retainedTools = Object.freeze([{ call: "already-completed" }]);
	const candidates = planCompressorRecovery(policy(), noPreferences);
	const attempted: typeof candidates[number][] = [];
	const success = await executeCompression(completed, {
		candidates, retainedToolResults: retainedTools, validateSwitch: () => ({ ok: true }),
		attempt: ({ candidate, retainedToolResults }) => {
			assert.equal(retainedToolResults, retainedTools);
			attempted.push(candidate);
			if (candidate === candidates[0]) return { kind: "retry-exhausted" };
			assert.equal(candidate, candidates[1]);
			return { kind: "success", value: compressed, actualEffort: "low" };
		},
	});
	assert.equal(success.completed, completed);
	assert.equal(success.compressed, compressed);
	assert.deepEqual(attempted, candidates.slice(0, 2));
	assert.equal(attempted.length, 2);
	assert.deepEqual(success.compression, { kind: "compressed", candidate: candidates[1], actualEffort: "low" });

	let calls = 0;
	const exhausted = await executeCompression(completed, {
		candidates, retainedToolResults: retainedTools, validateSwitch: () => ({ ok: true }),
		attempt: ({ retainedToolResults }) => { calls++; assert.equal(retainedToolResults, retainedTools); return { kind: "retry-exhausted" }; },
	});
	assert.equal(exhausted.completed, completed);
	assert.equal(exhausted.compression.kind, "failed");
	assert.equal(calls, new Set(candidates.map((item) => `${item.provider}/${item.model}`)).size);
	const cancelled = await executeCompression(completed, { candidates, retainedToolResults: retainedTools, validateSwitch: () => ({ ok: true }), attempt: () => ({ kind: "cancelled" }) });
	assert.equal(cancelled.completed, completed);
	assert.match(cancelled.compression.kind === "failed" ? cancelled.compression.notice : "", /cancelled/);
});

test("ownership refuses overlap promptly but permits independent sessions", () => {
	const ownership = new RecoveryOwnership();
	const first = ownership.acquire("s1", "global");
	assert.equal(first.kind, "acquired");
	assert.deepEqual(ownership.acquire("s1", "other"), { kind: "busy", resource: "execution-session", key: "s1" });
	assert.deepEqual(ownership.acquire("s2", "global"), { kind: "busy", resource: "saved-default", key: "global" });
	const independent = ownership.acquire("worker-2");
	assert.equal(independent.kind, "acquired");
	if (independent.kind === "acquired") independent.lease.release();
	if (first.kind === "acquired") first.lease.release();
	assert.equal(ownership.acquire("s2", "global").kind, "acquired");
});

test("ownership releases after success, cancellation outcome, failure outcome, and exception", { timeout: 2_000 }, async () => {
	const ownership = new RecoveryOwnership();
	for (const value of ["success", "cancelled", "failure"] as const) {
		const result = await executeWithRecoveryOwnership(ownership, "session", "global", () => value);
		assert.deepEqual(result, { kind: "completed", value });
		const next = ownership.acquire("session", "global");
		assert.equal(next.kind, "acquired");
		if (next.kind === "acquired") next.lease.release();
	}
	const thrown = await executeWithRecoveryOwnership(ownership, "session", "global", () => { throw new Error("boom"); });
	assert.equal(thrown.kind, "exception");
	assert.equal(ownership.acquire("session", "global").kind, "acquired");
});

test("replacement retains live ownership until the original callback settles", { timeout: 2_000 }, async () => {
	for (const replace of [
		(ownership: RecoveryOwnership) => ownership.replaceSession("session"),
		(ownership: RecoveryOwnership) => ownership.replaceLifecycle(),
	]) {
		const ownership = new RecoveryOwnership();
		let releaseExecution!: () => void;
		const suspended = new Promise<void>((resolve) => { releaseExecution = resolve; });
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => { started = resolve; });
		const first = executeWithRecoveryOwnership(ownership, "session", "global", async () => {
			started();
			await suspended;
			return "first";
		});
		await didStart;
		replace(ownership);
		let conflictingCalls = 0;
		const conflict = await executeWithRecoveryOwnership(ownership, "replacement", "global", () => { conflictingCalls++; return "wrong"; });
		assert.deepEqual(conflict, { kind: "busy", resource: "saved-default", key: "global" });
		assert.equal(conflictingCalls, 0);
		const independentReplacement = ownership.acquire("session", "other");
		assert.equal(independentReplacement.kind, "acquired");
		if (independentReplacement.kind === "acquired") independentReplacement.lease.release();
		releaseExecution();
		assert.deepEqual(await first, { kind: "completed", value: "first" });
		const replacement = ownership.acquire("replacement", "global");
		assert.equal(replacement.kind, "acquired");
		if (replacement.kind === "acquired") replacement.lease.release();
	}
});
