import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyRuntimeAuthority,
	parseSlateBindingRecord,
	type RuntimeAuthorityClassification,
	type RuntimeAuthorityRefusal,
	type SlateBindingRecord,
} from "../extension/runtime-authority.ts";

const ID = "20260827T090000Z-0123abcd0123abcd";
const OTHER_ID = "20260827T090001Z-deadbeefdeadbeef";
const NAME = "calm-otter-7f3a";
const OTHER_NAME = "brisk-bison-abcd";

function binding(overrides: Partial<SlateBindingRecord> = {}): SlateBindingRecord {
	return {
		policy: "durable-session-v1",
		identity: ID,
		name: NAME,
		...overrides,
	};
}

function legacy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		threads: [],
		episodes: [],
		threadSeq: 0,
		orchestratorMode: false,
		paused: false,
		workerCostUsd: 0,
		carriedCostUsd: 0,
		...overrides,
	};
}

function legacyThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "t1",
		name: "thread",
		sessionFile: "/tmp/t1.jsonl",
		status: "idle",
		episodeIds: ["t1.e1"],
		episodeSeq: 1,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function legacyEpisode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "t1.e1",
		threadId: "t1",
		task: "task",
		status: "ok",
		file: "/tmp/t1.e1.md",
		createdAt: 1,
		...overrides,
	};
}

function legacyGraph(
	thread: Record<string, unknown> = legacyThread(),
	episode: Record<string, unknown> = legacyEpisode(),
): Record<string, unknown> {
	return legacy({ threads: [thread], episodes: [episode] });
}

function entry(customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", customType, data };
}

function bindingEntry(value: unknown = binding()): Record<string, unknown> {
	return entry("slate-binding", value);
}

function legacyEntry(value: unknown = legacy()): Record<string, unknown> {
	return entry("slate-state", value);
}

function expectRefused(
	result: RuntimeAuthorityClassification,
	reason: RuntimeAuthorityRefusal,
	message?: string,
): void {
	assert.equal(result.kind, "refused", message);
	if (result.kind === "refused") {
		assert.equal(result.reason, reason);
		assert.match(result.message, /slate refused/);
	}
}

test("exact binding parsing accepts only the non-authoritative locator schema", () => {
	const source = binding();
	const parsed = parseSlateBindingRecord(source);
	assert.deepEqual(parsed, source);
	assert.deepEqual(Object.keys(parsed ?? {}).sort(), ["identity", "name", "policy"]);
	assert.equal("threads" in (parsed ?? {}), false);
	assert.equal("runtime" in (parsed ?? {}), false);
});

test("exact binding parsing rejects every malformed plain-data field class and competing payload", () => {
	const cases: ReadonlyArray<readonly [string, unknown]> = [
		["non-object", null],
		["array", []],
		["missing field", (() => { const value = { ...binding() } as Record<string, unknown>; delete value.name; return value; })()],
		["unknown field", { ...binding(), extra: true }],
		["policy", { ...binding(), policy: "legacy" }],
		["identity", { ...binding(), identity: "bad" }],
		["name", { ...binding(), name: "bad/name" }],
		["removed ownership payload", { ...binding(), ownerSessionDigest: "a".repeat(64) }],
		["removed generation payload", { ...binding(), generation: 1 }],
		["canonical snapshot payload", { ...binding(), threads: [] }],
	];
	for (const [label, value] of cases) assert.equal(parseSlateBindingRecord(value), undefined, label);
});

test("malformed plain persisted Slate evidence is refused", () => {
	const malformedBinding = bindingEntry({ ...binding(), generation: "four" });
	expectRefused(
		classifyRuntimeAuthority([malformedBinding], [malformedBinding]),
		"malformed-binding",
	);
	const malformedLegacy = legacyEntry(legacy({ threads: [null] }));
	expectRefused(
		classifyRuntimeAuthority([malformedLegacy], [malformedLegacy]),
		"malformed-legacy",
	);
});

test("absence of binding and legacy evidence is fresh", () => {
	const unrelated = [
		{ type: "message", message: { role: "user" } },
		entry("another-extension", { value: true }),
	];
	assert.deepEqual(classifyRuntimeAuthority(unrelated, unrelated), { kind: "fresh" });
});

test("known Slate custom entries with missing or invalid Pi types refuse", () => {
	for (const [customType, reason, data] of [
		["slate-binding", "malformed-binding", binding()],
		["slate-state", "malformed-legacy", legacy()],
	] as const) {
		for (const [label, candidate] of [
			["missing", { customType, data }],
			["invalid", { type: "message", customType, data }],
		] as const) {
			expectRefused(
				classifyRuntimeAuthority([candidate], [candidate]),
				reason,
				`${customType} ${label}`,
			);
		}
	}
});

test("the active branch selects one coherent durable relationship", () => {
	const first = bindingEntry();
	const offBranchLatest = bindingEntry();
	const activeLatest = bindingEntry();
	const result = classifyRuntimeAuthority([first, offBranchLatest, activeLatest], [first, activeLatest]);
	assert.equal(result.kind, "durable");
	if (result.kind === "durable") assert.deepEqual(result.binding, binding());
});

test("repeated bindings refuse every conflicting stable relationship", () => {
	for (const [label, changed] of [
		["identity", binding({ identity: OTHER_ID })],
		["name", binding({ name: OTHER_NAME })],
	] as const) {
		const first = bindingEntry();
		const conflict = bindingEntry(changed);
		expectRefused(classifyRuntimeAuthority([first, conflict], [first, conflict]), "conflicting-bindings");
		assert.ok(label);
	}
});

test("any malformed binding evidence refuses before older or active valid bindings", () => {
	const active = bindingEntry();
	const malformed = bindingEntry({ ...binding(), generation: "2" });
	expectRefused(classifyRuntimeAuthority([active, malformed], [active]), "malformed-binding");
	expectRefused(classifyRuntimeAuthority([active, malformed], [malformed]), "malformed-binding");
});

test("legacy and durable evidence refuse as mixed across the whole Pi session", () => {
	const durable = bindingEntry();
	const historical = legacyEntry();
	expectRefused(classifyRuntimeAuthority([historical, durable], [durable]), "mixed-authority");
	expectRefused(classifyRuntimeAuthority([historical, durable], [historical]), "mixed-authority");
});

test("a binding found only outside the active branch refuses instead of appearing fresh", () => {
	const durable = bindingEntry();
	const unrelated = entry("another-extension", {});
	expectRefused(classifyRuntimeAuthority([durable, unrelated], [unrelated]), "off-branch-binding");
});

test("valid active legacy evidence selects only the latest active snapshot", () => {
	const oldSnapshot = legacy({ paused: false });
	const latestSnapshot = legacy({ paused: true, extraFutureField: "preserved" });
	const oldEntry = legacyEntry(oldSnapshot);
	const latestEntry = legacyEntry(latestSnapshot);
	const offBranchEntry = legacyEntry(legacy({ workerCostUsd: 9 }));
	const result = classifyRuntimeAuthority([oldEntry, offBranchEntry, latestEntry], [oldEntry, latestEntry]);
	assert.equal(result.kind, "legacy");
	if (result.kind === "legacy") {
		assert.deepEqual(result.snapshot, latestSnapshot);
	}
});

test("legacy snapshots may omit additive pause and cost fields", () => {
	const historical = legacy();
	delete historical.paused;
	delete historical.workerCostUsd;
	delete historical.carriedCostUsd;
	const result = classifyRuntimeAuthority([legacyEntry(historical)], [legacyEntry(historical)]);
	assert.equal(result.kind, "legacy");
	if (result.kind === "legacy") assert.deepEqual(result.snapshot, historical);
});

test("session-wide legacy evidence remains non-fresh without active branch state", () => {
	const historical = legacyEntry();
	assert.deepEqual(classifyRuntimeAuthority([historical], []), { kind: "legacy" });
});

test("a malformed latest active legacy snapshot refuses without using an older snapshot", () => {
	const oldSnapshot = legacy({ paused: true });
	for (const [label, latestEntry] of [
		["missing data", entry("slate-state", undefined)],
		["missing required field", legacyEntry({ threads: [], episodes: [] })],
		["non-object", legacyEntry(null)],
		["invalid counter", legacyEntry(legacy({ threadSeq: -1 }))],
		["invalid identity", legacyEntry(legacy({ slateSessionId: "bad" }))],
		["invalid parent chain", legacyEntry(legacy({
			slateSessionParentChain: [{ identity: ID, name: "bad/name" }],
		}))],
		["malformed thread", legacyEntry(legacy({ threads: [null] }))],
		["malformed episode", legacyEntry(legacy({ episodes: [null] }))],
	] as const) {
		const oldEntry = legacyEntry(oldSnapshot);
		const result = classifyRuntimeAuthority([oldEntry, latestEntry], [oldEntry, latestEntry]);
		expectRefused(result, "malformed-legacy", label);
	}
});

test("legacy threads must contain every required schema field", () => {
	const complete = {
		id: "t1",
		name: "thread",
		sessionFile: "/tmp/t1.jsonl",
		status: "idle",
		episodeIds: [],
		episodeSeq: 0,
		createdAt: 1,
		updatedAt: 1,
	};
	for (const field of [
		"id", "name", "sessionFile", "status", "episodeIds", "episodeSeq", "createdAt", "updatedAt",
	] as const) {
		const malformed = { ...complete } as Partial<typeof complete>;
		delete malformed[field];
		const evidence = legacyEntry(legacy({ threads: [malformed] }));
		expectRefused(classifyRuntimeAuthority([evidence], [evidence]), "malformed-legacy", field);
	}
});

test("legacy episodes must contain every original required schema field", () => {
	const required = ["id", "threadId", "task", "status", "file", "createdAt"] as const;
	for (const field of required) {
		const malformed = legacyEpisode();
		delete malformed[field];
		const snapshot = legacyGraph(legacyThread(), malformed);
		const evidence = legacyEntry(snapshot);
		expectRefused(classifyRuntimeAuthority([evidence], [evidence]), "malformed-legacy", field);
	}
});

test("legacy classification refuses every sanitizer change instead of accepting repaired evidence", () => {
	const cases: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>]> = [
		["invalid thread status", legacyThread({ status: 17 }), legacyEpisode()],
		["running thread status", legacyThread({ status: "running" }), legacyEpisode()],
		["mixed episode identifiers", legacyThread({ episodeIds: ["t1.e1", 7] }), legacyEpisode()],
		["invalid episode status", legacyThread(), legacyEpisode({ status: 17 })],
		["invalid episode task", legacyThread(), legacyEpisode({ task: 17 })],
		["changed episode timestamp", legacyThread(), legacyEpisode({ createdAt: "1" })],
		["unknown thread field", legacyThread({ unknown: true }), legacyEpisode()],
		["unknown episode field", legacyThread(), legacyEpisode({ unknown: true })],
	];
	for (const [label, thread, episode] of cases) {
		const snapshot = legacyGraph(thread, episode);
		const evidence = legacyEntry(snapshot);
		expectRefused(classifyRuntimeAuthority([evidence], [evidence]), "malformed-legacy", label);
	}
});

test("malformed off-branch legacy evidence refuses without an active fallback", () => {
	const valid = legacyEntry();
	const malformed = legacyEntry(legacy({ threads: [null] }));
	expectRefused(classifyRuntimeAuthority([valid, malformed], [valid]), "malformed-legacy");
});

test("legacy graph validation rejects shared nonempty writable transcript paths", () => {
	const shared = "/tmp/shared.jsonl";
	const thread = (id: string) => ({
		id,
		name: id,
		sessionFile: shared,
		status: "idle",
		episodeIds: [],
		episodeSeq: 0,
		createdAt: 1,
		updatedAt: 1,
	});
	const snapshot = legacy({ threads: [thread("t1"), thread("t2")] });
	expectRefused(classifyRuntimeAuthority([legacyEntry(snapshot)], [legacyEntry(snapshot)]), "malformed-legacy");
});

test("legacy graph validation requires restart generation progression", () => {
	const source = legacyThread({
		episodeIds: [],
		episodeSeq: 0,
		supersededBy: "t2",
	});
	const successor = legacyThread({
		id: "t2",
		sessionFile: "/tmp/t2.jsonl",
		episodeIds: [],
		episodeSeq: 0,
		restartOf: "t1",
		restartGeneration: 2,
	});
	const malformed = legacyEntry(legacy({ threads: [source, successor], episodes: [] }));
	expectRefused(classifyRuntimeAuthority([malformed], [malformed]), "malformed-legacy");

	(successor as { restartGeneration: number }).restartGeneration = 1;
	const valid = legacyEntry(legacy({ threads: [source, successor], episodes: [] }));
	assert.equal(classifyRuntimeAuthority([valid], [valid]).kind, "legacy");
});

test("legacy graph validation rejects malformed episode ids and counter bounds", () => {
	const thread = (episodeId: string, episodeSeq: number) => ({
		id: "t1",
		name: "t1",
		sessionFile: "/tmp/t1.jsonl",
		status: "idle",
		episodeIds: [episodeId],
		episodeSeq,
		createdAt: 1,
		updatedAt: 1,
	});
	const episode = (id: string) => ({
		id,
		threadId: "t1",
		task: "task",
		status: "ok",
		file: `/tmp/${id}.md`,
		createdAt: 1,
	});
	for (const [label, id, sequence] of [
		["foreign id", "foreign", 1],
		["zero ordinal", "t1.e0", 1],
		["beyond counter", "t1.e2", 1],
	] as const) {
		const snapshot = legacy({ threads: [thread(id, sequence)], episodes: [episode(id)] });
		expectRefused(
			classifyRuntimeAuthority([legacyEntry(snapshot)], [legacyEntry(snapshot)]),
			"malformed-legacy",
			label,
		);
	}
});

test("malformed binding refusal precedes mixed-policy refusal", () => {
	const malformed = bindingEntry({ ...binding(), extra: true });
	const historical = legacyEntry();
	expectRefused(classifyRuntimeAuthority([historical, malformed], [historical, malformed]), "malformed-binding");
});
