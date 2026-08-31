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
		sessionFile: join(DIRECTORY, "threads", `${id}.jsonl`),
		status: "idle",
		episodeIds: [],
		episodeSeq: 0,
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
				forkedFrom: join(DIRECTORY, "threads", "imported.jsonl"),
				type: "reviewer",
				supersededBy: "t2",
				model: "provider/model",
				baseModel: "provider/base",
				baseEffort: "high",
				cacheKeyShard: 3,
				tools: ["read", "grep"],
				choiceEvidenceStale: true,
				episodeIds: ["t1.e1"],
				episodeSeq: 1,
				createdAt: 1,
				updatedAt: 2,
			}),
			thread("t2", { restartOf: "t1", restartGeneration: 1, createdAt: 3, updatedAt: 4 }),
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

test("root, relationship, parent, counter, and cost validation fail closed", () => {
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
		["running normalization", (value) => { value.threads[0]!.status = "running"; }, /requires sanitizer repair/],
		["thread counter", (value) => { value.threads[0]!.episodeSeq = -1; }, /requires sanitizer repair/],
		["thread mixed ids", (value) => { (value.threads[0]!.episodeIds as unknown[]).push(7); }, /requires sanitizer repair/],
		["episode missing required", (value) => { delete (value.episodes[0] as Partial<EpisodeRecord>).task; }, /missing or unknown fields/],
		["episode unknown field", (value) => { Object.assign(value.episodes[0]!, { unknown: true }); }, /missing or unknown fields/],
		["episode status", (value) => { value.episodes[0]!.status = "other" as "ok"; }, /requires sanitizer repair/],
		["token counter", (value) => { value.episodes[0]!.input = 1.5; }, /requires sanitizer repair/],
		["episode cost", (value) => { value.episodes[0]!.compressorCostUsd = -1; }, /requires sanitizer repair/],
		["nested usage", (value) => { value.episodes[0]!.compressorUsage = { input: -1 }; }, /requires sanitizer repair/],
	];
	for (const [label, mutate, expected] of cases) rejects(label, mutate, expected);
});

test("identifier and episode graph mutations are all rejected", () => {
	const cases: Array<[string, (value: CanonicalRuntimeState) => void, RegExp]> = [
		["duplicate thread", (value) => { value.threads.push(structuredClone(value.threads[0]!)); }, /duplicate thread identifier/],
		["duplicate episode", (value) => { value.episodes.push(structuredClone(value.episodes[0]!)); }, /duplicate episode identifier/],
		["missing episode", (value) => { value.episodes.length = 0; }, /broken episode reference/],
		["unknown thread", (value) => { value.episodes[0]!.threadId = "t9"; }, /broken episode reference|not listed/],
		["unlisted episode", (value) => { value.threads[0]!.episodeIds = []; }, /not listed by its thread/],
		["duplicate reference", (value) => { value.threads[0]!.episodeIds.push("t1.e1"); }, /repeats episode reference/],
		["foreign prefix", (value) => { value.threads[0]!.episodeIds[0] = "t2.e1"; }, /foreign or malformed episode reference/],
		["counter behind reference", (value) => { value.threads[0]!.episodeSeq = 0; }, /beyond episodeSeq/],
		["stale thread sequence", (value) => { value.threadSeq = 1; }, /threadSeq is stale/],
		["shared writable transcript", (value) => { value.threads[1]!.sessionFile = value.threads[0]!.sessionFile; }, /repeats a writable sessionFile/],
	];
	for (const [label, mutate, expected] of cases) rejects(label, mutate, expected);
});

test("restart graph mutations are all rejected", () => {
	const cases: Array<[string, (value: CanonicalRuntimeState) => void, RegExp]> = [
		["missing source", (value) => { value.threads[1]!.restartOf = "t9"; }, /broken restart source link|broken successor link/],
		["missing backlink", (value) => { delete value.threads[0]!.supersededBy; }, /broken restart source link/],
		["wrong successor", (value) => { value.threads[0]!.supersededBy = "t9"; }, /broken restart source link|broken successor link/],
		["wrong generation", (value) => { value.threads[1]!.restartGeneration = 2; }, /broken restart source link/],
		["cycle", (value) => {
			value.threads[0]!.restartOf = "t2";
			value.threads[0]!.restartGeneration = 2;
			value.threads[1]!.supersededBy = "t1";
		}, /restart cycle/],
	];
	for (const [label, mutate, expected] of cases) rejects(label, mutate, expected);
});

test("artifact validation is required independently for every declared artifact kind", () => {
	const seen: Array<{ kind: string; path: string }> = [];
	assert.doesNotThrow(() => decodeCanonicalRuntime({
		...options(),
		artifactPathAllowed(kind, path) {
			seen.push({ kind, path });
			return true;
		},
	}));
	assert.deepEqual(seen, [
		{ kind: "thread-session", path: join(DIRECTORY, "threads", "t1.jsonl") },
		{ kind: "thread-fork", path: join(DIRECTORY, "threads", "imported.jsonl") },
		{ kind: "thread-session", path: join(DIRECTORY, "threads", "t2.jsonl") },
		{ kind: "episode", path: join(DIRECTORY, "episodes", "t1.e1.md") },
		{ kind: "observation", path: join(DIRECTORY, "observations", "t1.e1.md") },
	]);
	const kinds: CanonicalRuntimeArtifactKind[] = ["thread-session", "thread-fork", "episode", "observation"];
	for (const rejectedKind of kinds) {
		assert.throws(
			() => decodeCanonicalRuntime({
				...options(),
				artifactPathAllowed: (kind) => kind !== rejectedKind,
			}),
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
		["outside session file", (value) => { value.threads[0]!.sessionFile = "/tmp/outside.jsonl"; }, /unsafe sessionFile/],
		["nested session file", (value) => { value.threads[0]!.sessionFile = join(DIRECTORY, "threads", "nested", "t1.jsonl"); }, /unsafe sessionFile/],
		["wrong transcript suffix", (value) => { value.threads[0]!.sessionFile = join(DIRECTORY, "threads", "t1.txt"); }, /unsafe sessionFile/],
		["outside fork", (value) => { value.threads[0]!.forkedFrom = "/tmp/source.jsonl"; }, /unsafe forkedFrom/],
		["self fork", (value) => { value.threads[0]!.forkedFrom = value.threads[0]!.sessionFile; }, /unsafe forkedFrom/],
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
		(value) => { value.threads[0]!.episodeSeq = -1; },
		(value) => { value.episodes[0]!.workerCostUsd = -1; },
		(value) => { value.threads.push(structuredClone(value.threads[0]!)); },
		(value) => { value.episodes.push(structuredClone(value.episodes[0]!)); },
		(value) => { value.threads[0]!.episodeIds = []; },
		(value) => { delete value.threads[0]!.supersededBy; },
		(value) => { value.threads[0]!.sessionFile = "/tmp/outside.jsonl"; },
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
