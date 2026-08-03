import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import { SlateStore, type SlateSnapshot } from "../extension/state.ts";
import { createFakeExtensionAPI } from "./fakes.ts";

interface AdoptionHarness {
	store: SlateStore;
	file: string;
	messages: Array<{ message: string; level: string }>;
	run(): Promise<void>;
	cleanup(): void;
}

function snapshot(dispatchSeq: number): SlateSnapshot {
	return {
		threads: [],
		episodes: [],
		orchestratorMode: false,
		paused: true,
		dispatchSeq,
		workerCostUsd: 0,
		carriedCostUsd: 0,
	};
}

function adoptionHarness(pendingSnapshot: unknown, saveError?: Error): AdoptionHarness {
	const cwd = mkdtempSync(join(tmpdir(), "slate-handoff-bg30-"));
	const directory = join(cwd, CONFIG_DIR_NAME, "slate");
	const file = join(directory, "pending-handoff.json");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			parentSession: "parent.jsonl",
			createdAt: Date.now(),
			brief: "",
			snapshot: pendingSnapshot,
		}),
		"utf8",
	);

	const fake = createFakeExtensionAPI();
	if (saveError) {
		fake.api.appendEntry = () => {
			throw saveError;
		};
	}
	const store = new SlateStore(fake.api);
	const messages: Array<{ message: string; level: string }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string, level: string) {
				messages.push({ message, level });
			},
		},
		isProjectTrusted: () => true,
		sessionManager: {
			getHeader: () => ({ parentSession: "parent.jsonl" }),
		},
		model: undefined,
	} as unknown as ExtensionContext;
	registerSlateHandoff(fake.api, store, () => ({}), () => ({}) as BaseModelTracker);
	const handler = fake.handler<(event: unknown, context: ExtensionContext) => Promise<void>>("session_start");

	return {
		store,
		file,
		messages,
		run: () => handler({}, ctx),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

test("failed handoff adoption reports that the store stayed unchanged", async () => {
	const harness = adoptionHarness({ ...snapshot(99), dispatchSeq: -1 });
	try {
		harness.store.dispatchSeq = 7;
		harness.store.paused = false;
		const before = structuredClone(harness.store.snapshot());
		await harness.run();

		assert.deepEqual(harness.store.snapshot(), before);
		assert.equal(existsSync(harness.file), true);
		assert.equal(harness.messages.length, 1);
		assert.match(harness.messages[0]?.message ?? "", /could not adopt pending handoff state/);
		assert.match(harness.messages[0]?.message ?? "", /current session state was left unchanged/);
	} finally {
		harness.cleanup();
	}
});

test("save failure after handoff adoption reports adopted memory state without false reassurance", async () => {
	const harness = adoptionHarness(snapshot(99), new Error("session file is read-only"));
	try {
		await harness.run();

		assert.equal(harness.store.dispatchSeq, 99, "the adopted state is live even though persistence failed");
		assert.equal(harness.store.paused, false);
		assert.equal(existsSync(harness.file), true);
		assert.equal(harness.messages.length, 1);
		const message = harness.messages[0]?.message ?? "";
		assert.match(message, /state was adopted in memory, but could not be saved — session file is read-only/);
		assert.match(message, /active for this session but is not in session history/);
		assert.match(message, /pending file was retained so reload can retry/);
		assert.doesNotMatch(message, /state was left unchanged/);
	} finally {
		harness.cleanup();
	}
});

test("successful handoff adoption reports restored state after persistence", async () => {
	const harness = adoptionHarness(snapshot(99));
	try {
		await harness.run();

		assert.equal(harness.store.dispatchSeq, 99);
		assert.equal(harness.store.paused, false);
		assert.equal(existsSync(harness.file), false);
		assert.deepEqual(harness.messages, [{ message: "slate: handoff state restored (0 threads, 0 episodes).", level: "info" }]);
	} finally {
		harness.cleanup();
	}
});
