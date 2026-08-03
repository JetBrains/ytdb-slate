import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SlateStore, type SlateSnapshot } from "../extension/state.ts";

function emptySnapshot(dispatchSeq?: number): SlateSnapshot {
	return {
		threads: [],
		episodes: [],
		orchestratorMode: false,
		paused: false,
		...(dispatchSeq === undefined ? {} : { dispatchSeq }),
		workerCostUsd: 0,
		carriedCostUsd: 0,
	};
}

function restoreContext(branch: unknown[], entries = branch): ExtensionContext {
	return {
		hasUI: false,
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
}

function stateEntry(snapshot: unknown): unknown {
	return { type: "custom", customType: "slate-state", data: snapshot };
}

test("restore accepts an old snapshot with no dispatch sequence", () => {
	const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
	const snapshot = emptySnapshot();
	store.restore(restoreContext([stateEntry(snapshot)]));
	assert.equal(store.dispatchSeq, 0);
});

test("restore keeps the lineage dispatch high-water mark", () => {
	const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
	const branch = emptySnapshot(7);
	const higherAbandonedBranch = emptySnapshot(41);
	store.restore(restoreContext([stateEntry(branch)], [stateEntry(branch), stateEntry(higherAbandonedBranch)]));
	assert.equal(store.dispatchSeq, 41);
});

test("a corrupt dispatch sequence rejects restore without changing or overwriting live history", () => {
	const directory = mkdtempSync(join(tmpdir(), "slate-bg27-"));
	try {
		const episodeFile = join(directory, "t9.e1.md");
		writeFileSync(episodeFile, "episode", "utf8");
		const good: SlateSnapshot = {
			threads: [
				{
					id: "t9",
					name: "preserved",
					sessionFile: "",
					status: "idle",
					episodeIds: ["t9.e1"],
					episodeSeq: 1,
					createdAt: 10,
					updatedAt: 20,
				},
			],
			episodes: [
				{
					id: "t9.e1",
					threadId: "t9",
					task: "keep this history",
					status: "ok",
					file: episodeFile,
					createdAt: 30,
				},
			],
			orchestratorMode: true,
			paused: true,
			dispatchSeq: 52,
			workerCostUsd: 1.25,
			carriedCostUsd: 2.5,
		};
		const appended: unknown[] = [];
		const store = new SlateStore({
			appendEntry(_type: string, data: unknown) {
				appended.push(data);
			},
		} as unknown as ExtensionAPI);
		const ctx = restoreContext([]);
		store.adoptSnapshot(good, ctx);
		const before = structuredClone(store.snapshot());
		const corrupt = { ...emptySnapshot(1), dispatchSeq: -1 };

		assert.throws(
			() => store.restore(restoreContext([stateEntry(corrupt)])),
			/dispatchSeq must be a non-negative safe integer/,
		);
		assert.deepEqual(store.snapshot(), before, "a rejected restore must leave every live record and counter unchanged");
		assert.throws(() => store.save(), /refusing to save after a failed state restore/);
		assert.deepEqual(appended, [], "fail-closed persistence must not append an empty replacement snapshot");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("restore validates abandoned-branch sequences before adopting the current branch", () => {
	const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
	store.adoptSnapshot({ ...emptySnapshot(19), orchestratorMode: true }, restoreContext([]));
	const before = structuredClone(store.snapshot());
	const current = emptySnapshot(20);
	const corruptAbandoned = { ...emptySnapshot(21), dispatchSeq: "21" };

	assert.throws(
		() => store.restore(restoreContext([stateEntry(current)], [stateEntry(current), stateEntry(corruptAbandoned)])),
		/dispatchSeq must be a non-negative safe integer/,
	);
	assert.deepEqual(store.snapshot(), before);
});
