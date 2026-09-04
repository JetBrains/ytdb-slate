/**
 * A DISPATCH THROUGH THE REAL SAVE PATH.
 *
 * Most dispatch tests replace `SlateStore.commit` with a success stub. The
 * production-path thread-type test persists creation only. These tests also
 * cover terminal mutation and episode linking. That gap hid a blocker: an accepted save reinstalled
 * the stored records, the dispatch kept mutating the record it had created, and
 * the durable thread stayed queued with no episode link (BG1501/CN1501). These
 * tests use the production store, the production durable backend and a real
 * external namespace, and they read the stored file back.
 *
 * They also pin the location of the fixed failure episode: it belongs inside the
 * external namespace, because the canonical decoder refuses a file outside it
 * (CN1502).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCorpusProject, type CorpusProject } from "../extension/corpus.ts";
import { activateSlateStorage, createRuntimeAuthorityBackend } from "../extension/runtime-authority.ts";
import { SlateStore, type EpisodeRecord, type ThreadRecord } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";

interface Entry {
	type: "custom";
	customType: string;
	data: Record<string, unknown>;
}

interface Lab {
	cwd: string;
	project: CorpusProject;
}

function lab(t: TestContext): Lab {
	const root = mkdtempSync(join(tmpdir(), "slate-dispatch-persistence."));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	return { cwd, project: resolveCorpusProject(cwd) };
}

/** The production store over a real external namespace. No save is stubbed. */
function durableStore(box: Lab): SlateStore {
	const entries: Entry[] = [];
	const pi = {
		appendEntry(customType: string, data: Record<string, unknown>) {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	activateSlateStorage({
		store,
		session: {
			key: "pi-session:dispatch",
			cwd: box.cwd,
			sessionDigest: "a".repeat(64),
			project: box.project,
			entries,
			branch: entries,
		},
		backend: createRuntimeAuthorityBackend(pi, { branch: () => entries }),
		report: () => {},
	});
	return store;
}

interface FakeSession {
	messages: unknown[];
	model: undefined;
	thinkingLevel: undefined;
	sessionFile: undefined;
	getContextUsage(): undefined;
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(): Promise<void>;
	dispose(): void;
}

/** One worker session whose turn either answers or stays silent. */
function fakeWorker(answer: string | undefined): FakeSession {
	const messages: unknown[] = [];
	const listeners = new Set<(event: unknown) => void>();
	return {
		messages,
		model: undefined,
		thinkingLevel: undefined,
		sessionFile: undefined,
		getContextUsage: () => undefined,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt() {
			if (answer === undefined) return;
			const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] };
			messages.push(message);
			for (const listener of listeners) listener({ type: "message_end", message });
		},
		dispose() {},
	};
}

function managerOver(store: SlateStore, session: FakeSession): ThreadManager {
	const manager = new ThreadManager(store, {});
	const view = manager as unknown as {
		live: Map<string, unknown>;
		openWorkerFor(args: { thread: { id: string } }): Promise<{ session: unknown; baseline: unknown }>;
	};
	view.openWorkerFor = async (args) => {
		view.live.set(args.thread.id, session);
		return { session, baseline: {} };
	};
	return manager;
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		model: undefined,
		hasUI: false,
		modelRegistry: {
			find: () => undefined,
			hasConfiguredAuth: () => false,
			async getAvailable() { return []; },
		},
	} as unknown as ExtensionContext;
}

interface StoredRuntime {
	runtime: { threads: ThreadRecord[]; episodes: EpisodeRecord[]; threadSeq: number };
}

function storedFile(box: Lab, name: string): StoredRuntime {
	return JSON.parse(readFileSync(join(box.project.directory, name, "state.json"), "utf8")) as StoredRuntime;
}

test("a completed dispatch stores its final thread state and its episode link", { timeout: 20_000 }, async (t) => {
	const box = lab(t);
	const store = durableStore(box);
	const manager = managerOver(store, fakeWorker("No findings."));
	const result = await manager.dispatch(
		{ name: "real save", task: "do the work", type: "general" },
		context(box.cwd),
		undefined,
	);
	const name = store.slateSessionName;
	assert.ok(name);

	// The record the dispatch holds is the record the store holds.
	assert.strictEqual(store.threads.get(result.thread.id), result.thread);
	assert.equal(result.thread.status, "successful");
	assert.equal(result.thread.episodeId, result.episode.id);

	// The DURABLE file carries the same terminal state, so the canonical decoder
	// accepts the thread and its episode reference.
	const stored = storedFile(box, name);
	assert.deepEqual(stored.runtime.threads.map((thread) => thread.status), ["successful"]);
	assert.equal(stored.runtime.threads[0]?.episodeId, result.episode.id);
	assert.deepEqual(stored.runtime.episodes.map((episode) => episode.id), [result.episode.id]);
	assert.equal(stored.runtime.episodes[0]?.threadId, result.thread.id);

	// A fresh store restores that state, which is the proof that no reference was
	// lost between the dispatch and the file.
	const restored = durableStore(box);
	restored.configureRuntimeAuthority(
		{ kind: "durable", binding: { policy: "durable-session-v1", identity: store.slateSessionId!, name } },
		// The context of the restoring session is its own.
		(store as unknown as { runtimeAuthorityContext: never }).runtimeAuthorityContext,
		(store as unknown as { runtimeAuthorityBackend: never }).runtimeAuthorityBackend,
	);
	assert.equal(restored.threads.get(result.thread.id)?.status, "successful");
	assert.equal(restored.episodes.size, 1);
});

test("a failed action without a worker response stores its episode inside the namespace", { timeout: 20_000 }, async (t) => {
	const box = lab(t);
	const store = durableStore(box);
	const manager = managerOver(store, fakeWorker(undefined));
	const result = await manager.dispatch(
		{ name: "silent worker", task: "produce nothing", type: "general" },
		context(box.cwd),
		undefined,
	);
	const name = store.slateSessionName;
	assert.ok(name);
	assert.equal(result.episode.status, "failed");
	assert.equal(result.episode.file, join(box.project.directory, name, "episodes", `${result.episode.id}.md`));
	assert.match(readFileSync(result.episode.file, "utf8"), /STATUS: FAILED/);

	const stored = storedFile(box, name);
	assert.deepEqual(stored.runtime.threads.map((thread) => thread.status), ["failed"]);
	assert.equal(stored.runtime.threads[0]?.episodeId, result.episode.id);
	assert.equal(stored.runtime.episodes[0]?.file, result.episode.file);
});
