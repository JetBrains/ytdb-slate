import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	CanonicalRuntimeDecodeError,
	decodeCanonicalRuntime,
	type CanonicalRuntimeArtifactKind,
	type CanonicalRuntimeDecodeOptions,
	type CanonicalRuntimeState,
	type EpisodeRecord,
	type ThreadRecord,
} from "../extension/state.ts";

const IDENTITY = "20260827T010203Z-0123456789abcdef";
const PARENT_IDENTITY = "20260826T010203Z-fedcba9876543210";
const NAME = "calm-otter-7f3a";
const DIRECTORY = join("/tmp", NAME);

function thread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
	return {
		id,
		name: id,
		status: "failed",
		type: "general",
		outcomeReason: "stopped",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function episode(id: string, threadId: string, overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
	return {
		id,
		threadId,
		task: "decode external state",
		status: "ok",
		file: join(DIRECTORY, "episodes", `${id}.md`),
		createdAt: 2,
		...overrides,
	};
}

function runtime(): CanonicalRuntimeState {
	return {
		threads: [
			thread("t1", {
				status: "successful",
				type: "reviewer",
				model: "provider/model",
				baseModel: "provider/base",
				baseEffort: "high",
				cacheKeyShard: 3,
				tools: ["read", "grep"],
				episodeId: "t1.e1",
				createdAt: 1,
				updatedAt: 2,
			}),
			thread("t2", { createdAt: 3, updatedAt: 4 }),
		],
		episodes: [episode("t1.e1", "t1", {
			model: "provider/model",
			effort: "high",
			effortUnmeasured: true,
			observations: {
				stored: true,
				path: `.pi/slate/sessions/${NAME}/observations/t1.e1.md`,
				bytes: 10,
				truncated: false,
				grammar: "present",
			},
			input: 11,
			output: 12,
			cacheRead: 13,
			cacheWrite: 14,
			contextTokens: 15,
			workerCostUsd: 1.25,
			compressorUsage: { input: 16, output: 17, cacheRead: 18, cacheWrite: 19 },
			compressorCostUsd: 0.25,
			compactionUsage: { input: 20, output: 21, cacheRead: 22, cacheWrite: 23 },
			compactionCostUsd: 0.5,
			createdAt: 5,
		})],
		threadSeq: 2,
		slateSessionParentChain: [{ identity: PARENT_IDENTITY, name: "brisk-bison-abcd" }],
		orchestratorMode: true,
		paused: false,
		workerCostUsd: 1.25,
		carriedCostUsd: 0.5,
	};
}

function options(value: unknown = runtime()): CanonicalRuntimeDecodeOptions {
	return {
		runtime: value,
		externalIdentity: IDENTITY,
		expectedIdentity: IDENTITY,
		namespaceName: NAME,
		namespaceDirectory: DIRECTORY,
		artifactPathAllowed: () => true,
	};
}

function rejects(label: string, mutate: (value: CanonicalRuntimeState) => void, expected: RegExp): void {
	const value = runtime();
	mutate(value);
	assert.throws(() => decodeCanonicalRuntime(options(value)), expected, label);
}

test("strict decoding preserves every canonical plain-data field", () => {
	const source = runtime();
	assert.deepEqual(decodeCanonicalRuntime(options(source)), source);
});

test("root, parent, counter, and cost validation fail closed", () => {
	const missing = { ...runtime() } as Partial<CanonicalRuntimeState>;
	delete missing.paused;
	for (const [label, value, expected] of [
		["non-object", [], /root is not an object/],
		["missing", missing, /missing or unknown fields/],
		["unknown", { ...runtime(), unknown: true }, /missing or unknown fields/],
	] as const) assert.throws(() => decodeCanonicalRuntime(options(value)), expected, label);
	assert.throws(() => decodeCanonicalRuntime({ ...options(), externalIdentity: PARENT_IDENTITY }), /identity does not match/);
	assert.throws(
		() => decodeCanonicalRuntime({ ...options(), namespaceDirectory: join(DIRECTORY, "nested") }),
		/namespace location is invalid/,
	);
	const cases: Array<[string, (value: CanonicalRuntimeState) => void, RegExp]> = [
		["threadSeq fraction", (value) => { value.threadSeq = 1.5; }, /threadSeq/],
		["threadSeq negative", (value) => { value.threadSeq = -1; }, /threadSeq/],
		["worker cost", (value) => { value.workerCostUsd = Number.NaN; }, /cost fields/],
		["carried cost", (value) => { value.carriedCostUsd = -1; }, /cost fields/],
		["parent duplicate", (value) => { value.slateSessionParentChain.push({ ...value.slateSessionParentChain[0]! }); }, /parent chain repeats/],
		["parent current identity", (value) => { value.slateSessionParentChain[0]!.identity = IDENTITY; }, /parent chain repeats/],
		["parent malformed", (value) => { value.slateSessionParentChain[0]!.name = "bad/name"; }, /parent 0 is malformed/],
	];
	for (const [label, mutate, expected] of cases) rejects(label, mutate, expected);
});

test("thread and episode sanitizer changes are refusals rather than repairs", () => {
	const cases: Array<[string, (value: CanonicalRuntimeState) => void, RegExp]> = [
		["thread missing required", (value) => { delete (value.threads[0] as Partial<ThreadRecord>).name; }, /missing or unknown fields/],
		["thread unknown field", (value) => { Object.assign(value.threads[0]!, { unknown: true }); }, /missing or unknown fields/],
		["wrong episode id", (value) => { value.threads[0]!.episodeId = "t2.e1"; }, /requires sanitizer repair/],
		["episode missing required", (value) => { delete (value.episodes[0] as Partial<EpisodeRecord>).task; }, /missing or unknown fields/],
		["episode unknown field", (value) => { Object.assign(value.episodes[0]!, { unknown: true }); }, /missing or unknown fields/],
		["episode status", (value) => { value.episodes[0]!.status = "other" as "ok"; }, /requires sanitizer repair/],
		["token counter", (value) => { value.episodes[0]!.input = 1.5; }, /requires sanitizer repair/],
		["episode cost", (value) => { value.episodes[0]!.compressorCostUsd = -1; }, /requires sanitizer repair/],
		["nested usage", (value) => { value.episodes[0]!.compressorUsage = { input: -1 }; }, /requires sanitizer repair/],
	];
	for (const [label, mutate, expected] of cases) rejects(label, mutate, expected);
});

test("a queued or running action is legitimate external state", () => {
	// Slate saves a worker thread BEFORE it starts the worker session, so external
	// storage must hold an unfinished action. "Unfinished means failed" is a restore
	// rule that the state store applies when it adopts a namespace.
	for (const status of ["queued", "running"] as const) {
		const value = runtime();
		value.threads[0]!.status = status;
		const decoded = decodeCanonicalRuntime(options(value));
		assert.equal(decoded.threads[0]?.status, status);
	}
});

test("identifier and one-action episode graph mutations are rejected", () => {
	const cases: Array<[string, (value: CanonicalRuntimeState) => void, RegExp]> = [
		["duplicate thread", (value) => { value.threads.push(structuredClone(value.threads[0]!)); }, /duplicate thread identifier/],
		["duplicate episode", (value) => { value.episodes.push(structuredClone(value.episodes[0]!)); }, /duplicate episode identifier/],
		["missing episode", (value) => { value.episodes.length = 0; }, /^CanonicalRuntimeDecodeError: slate refused canonical runtime state: thread t1 has a broken episode reference t1\.e1$/],
		["unknown thread", (value) => {
			value.threads[0]!.status = "failed";
			value.threads[0]!.outcomeReason = "stopped";
			delete value.threads[0]!.episodeId;
			value.episodes[0]!.threadId = "t9";
			value.episodes[0]!.id = "t9.e1";
			delete value.episodes[0]!.observations;
		}, /^CanonicalRuntimeDecodeError: slate refused canonical runtime state: episode t9\.e1 is not listed by its thread$/],
		["successful thread without episode", (value) => {
			delete value.threads[0]!.episodeId;
		}, /^CanonicalRuntimeDecodeError: slate refused canonical runtime state: thread t1 requires sanitizer repair: thread t1: normalized successful action without a valid episode id to failed$/],
		["unlisted episode", (value) => {
			value.threads[0]!.status = "failed";
			value.threads[0]!.outcomeReason = "stopped";
			delete value.threads[0]!.episodeId;
		}, /^CanonicalRuntimeDecodeError: slate refused canonical runtime state: episode t1\.e1 is not listed by its thread$/],
		["foreign reference", (value) => { value.threads[0]!.episodeId = "t2.e1"; }, /^CanonicalRuntimeDecodeError: slate refused canonical runtime state: thread t1 requires sanitizer repair: thread t1: ignoring episodeId because it is not t1\.e1; thread t1: normalized successful action without a valid episode id to failed$/],
		["stale thread sequence", (value) => { value.threadSeq = 1; }, /threadSeq is stale/],
	];
	for (const [label, mutate, expected] of cases) rejects(label, mutate, expected);
});

test("artifact validation covers only stored episode and observation artifacts", () => {
	const seen: Array<{ kind: string; path: string }> = [];
	assert.doesNotThrow(() => decodeCanonicalRuntime({
		...options(),
		artifactPathAllowed(kind, path) {
			seen.push({ kind, path });
			return true;
		},
	}));
	assert.deepEqual(seen, [
		{ kind: "episode", path: join(DIRECTORY, "episodes", "t1.e1.md") },
		{ kind: "observation", path: join(DIRECTORY, "observations", "t1.e1.md") },
	]);
	const kinds: CanonicalRuntimeArtifactKind[] = ["episode", "observation"];
	for (const rejectedKind of kinds) {
		assert.throws(
			() => decodeCanonicalRuntime({ ...options(), artifactPathAllowed: (kind) => kind !== rejectedKind }),
			CanonicalRuntimeDecodeError,
			`${rejectedKind} false`,
		);
		assert.throws(
			() => decodeCanonicalRuntime({
				...options(),
				artifactPathAllowed(kind) {
					if (kind === rejectedKind) throw new Error("unreadable artifact");
					return true;
				},
			}),
			CanonicalRuntimeDecodeError,
			`${rejectedKind} throw`,
		);
	}
});

test("lexically unsafe artifact references are rejected", () => {
	const cases: Array<[string, (value: CanonicalRuntimeState) => void, RegExp]> = [
		["wrong episode file", (value) => { value.episodes[0]!.file = join(DIRECTORY, "episodes", "t2.e1.md"); }, /unsafe file reference/],
		["legacy observation", (value) => {
			const observations = value.episodes[0]!.observations;
			if (observations?.stored === true) observations.path = ".pi/slate/observations/t1.e1.md";
		}, /unsafe observation reference/],
		["sibling observation", (value) => {
			const observations = value.episodes[0]!.observations;
			if (observations?.stored === true) observations.path = ".pi/slate/sessions/brisk-bison-abcd/observations/t1.e1.md";
		}, /unsafe observation reference/],
	];
	for (const [label, mutate, expected] of cases) rejects(label, mutate, expected);
});

test("the refusal matrix has independent mutations and an unmutated control", () => {
	const mutations: Array<(value: CanonicalRuntimeState) => void> = [
		(value) => { value.threadSeq = -1; },
		(value) => { value.threads[0]!.status = "other" as "failed"; },
		(value) => { value.episodes[0]!.workerCostUsd = -1; },
		(value) => { value.threads.push(structuredClone(value.threads[0]!)); },
		(value) => { value.episodes.push(structuredClone(value.episodes[0]!)); },
		(value) => { delete value.threads[0]!.episodeId; },
		(value) => { value.episodes[0]!.file = "/tmp/outside.md"; },
	];
	assert.doesNotThrow(() => decodeCanonicalRuntime(options(runtime())));
	let defeated = 0;
	for (const mutate of mutations) {
		const value = runtime();
		mutate(value);
		assert.throws(() => decodeCanonicalRuntime(options(value)), CanonicalRuntimeDecodeError);
		defeated++;
	}
	assert.equal(defeated, mutations.length);
});
