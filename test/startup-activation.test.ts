import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCorpusProject, type CorpusProject } from "../extension/corpus.ts";
import {
	activateSlateStorage,
	createRuntimeAuthorityBackend,
	SLATE_BINDING_CUSTOM_TYPE,
	STARTUP_PENDING_REFUSAL,
	type SlateStartupSession,
} from "../extension/runtime-authority.ts";
import { SlateStore, type EpisodeRecord, type ThreadRecord } from "../extension/state.ts";

const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const FOREIGN_ID = "20260828T120000Z-0123abcd0123abcd";

interface Entry {
	type: "custom";
	customType: string;
	data: Record<string, unknown>;
}

interface Lab {
	root: string;
	cwd: string;
	project: CorpusProject;
	close(): void;
}

function lab(): Lab {
	const root = mkdtempSync(join(tmpdir(), "slate-startup-activation."));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	return {
		root,
		cwd,
		project: resolveCorpusProject(cwd, "startup"),
		close() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** One Pi session over a shared entry list, wired to the production backend. */
function session(box: Lab, options: {
	entries: Entry[];
	branch?: Entry[];
	sessionId?: string;
	digest?: string;
	appendFails?: () => boolean;
	/**
	 * Pi adds an entry to its own memory BEFORE it writes that entry, and it keeps
	 * the memory entry when its write throws (CN1504). A fake that throws first
	 * cannot show that difference.
	 */
	memoryFirstAppend?: boolean;
	/** The conversation FILE. Present only where the memory-disk difference matters. */
	persisted?: Entry[];
} = { entries: [] }) {
	const reports: string[] = [];
	const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
	const branch = () => options.branch ?? options.entries;
	const pi = {
		appendEntry(customType: string, data: Record<string, unknown>) {
			const entry: Entry = { type: "custom", customType, data };
			if (options.appendFails?.() === true) {
				if (options.memoryFirstAppend === true) options.entries.push(entry);
				throw new Error("forced locator note failure");
			}
			options.entries.push(entry);
			options.persisted?.push(entry);
		},
	} as unknown as ExtensionAPI;
	const startup: SlateStartupSession = {
		key: `pi-session:${options.sessionId ?? "one"}`,
		cwd: box.cwd,
		sessionDigest: options.digest ?? OWNER,
		project: box.project,
		entries: options.entries,
		branch: branch(),
	};
	const activate = () =>
		activateSlateStorage({
			store,
			session: { ...startup, branch: branch() },
			backend: createRuntimeAuthorityBackend(pi, {
				branch,
				...(options.persisted === undefined ? {} : { persisted: () => options.persisted }),
			}),
			report: (message) => reports.push(message),
		});
	return { store, reports, activate, notes: () => options.entries.filter((entry) => entry.customType === SLATE_BINDING_CUSTOM_TYPE) };
}

function thread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
	return {
		id,
		name: `action ${id}`,
		status: "failed",
		type: "general",
		outcomeReason: "recorded for the test",
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

/** Namespace directories of the corpus project, excluding its other contents. */
function namespaces(project: CorpusProject): string[] {
	if (!existsSync(project.directory)) return [];
	return readdirSync(project.directory).filter((name) => /^[a-z]+-[a-z]+-[0-9a-f]{4}$/.test(name)).sort();
}

test("a start with no locator note prepares storage and creates no directory", () => {
	const box = lab();
	try {
		const first = session(box, { entries: [] });
		first.activate();
		assert.deepEqual(first.store.authorityState(), { kind: "fresh", contextKey: "pi-session:one" });
		assert.deepEqual(first.notes(), []);
		assert.deepEqual(namespaces(box.project), []);
		assert.equal(first.store.slateSessionName, undefined);
	} finally {
		box.close();
	}
});

test("the first change creates one namespace and then writes one locator note", () => {
	const box = lab();
	try {
		const entries: Entry[] = [];
		const first = session(box, { entries });
		first.activate();
		const id = first.store.claimNextThreadId();
		first.store.threads.set(id, thread(id));
		first.store.orchestratorMode = true;
		const result = first.store.commit();
		assert.equal(result?.kind, "committed");
		const created = namespaces(box.project);
		assert.equal(created.length, 1);
		assert.equal(first.store.slateSessionName, created[0]);
		assert.equal(first.notes().length, 1);
		assert.deepEqual(first.notes()[0]?.data, {
			policy: "durable-session-v1",
			identity: first.store.slateSessionId,
			name: created[0],
		});

		// A LATER SAVE ADDS NO SECOND NOTE AND NO SECOND NAMESPACE.
		first.store.workerCostUsd = 4;
		assert.equal(first.store.commit()?.kind, "committed");
		assert.equal(first.notes().length, 1);
		assert.deepEqual(namespaces(box.project), created);
	} finally {
		box.close();
	}
});

test("a start with one valid locator note restores every record", () => {
	const box = lab();
	try {
		const entries: Entry[] = [];
		const first = session(box, { entries });
		first.activate();
		const id = first.store.claimNextThreadId();
		first.store.threads.set(id, thread(id));
		first.store.orchestratorMode = true;
		first.store.paused = true;
		first.store.workerCostUsd = 2.5;
		first.store.carriedCostUsd = 1.25;
		first.store.commit();
		const directory = join(box.project.directory, first.store.slateSessionName!);
		writeFileSync(join(directory, "episodes", `${id}.e1.md`), "episode text\n");
		const episode: EpisodeRecord = {
			id: `${id}.e1`,
			threadId: id,
			task: "restore me",
			status: "ok",
			file: join(directory, "episodes", `${id}.e1.md`),
			createdAt: 3,
		};
		first.store.episodes.set(episode.id, episode);
		first.store.threads.set(id, thread(id, { status: "successful", episodeId: episode.id, outcomeReason: undefined }));
		assert.equal(first.store.commit()?.kind, "committed");

		// ANOTHER PI SESSION, same conversation branch, so the locator note selects
		// the same external namespace.
		const second = session(box, { entries, sessionId: "two", digest: OTHER_OWNER });
		second.activate();
		assert.equal(second.store.authorityState().kind, "durable");
		assert.equal(second.store.slateSessionName, first.store.slateSessionName);
		assert.deepEqual([...second.store.threads.keys()], [id]);
		assert.equal(second.store.threads.get(id)?.episodeId, episode.id);
		assert.deepEqual(second.store.episodes.get(episode.id), episode);
		assert.equal(second.store.orchestratorMode, true);
		assert.equal(second.store.paused, true);
		assert.equal(second.store.workerCostUsd, 2.5);
		assert.equal(second.store.carriedCostUsd, 1.25);
		assert.equal(second.notes().length, 1);
	} finally {
		box.close();
	}
});

test("an action that did not finish reads as failed after the next start", () => {
	const box = lab();
	try {
		const entries: Entry[] = [];
		const first = session(box, { entries });
		first.activate();
		const id = first.store.claimNextThreadId();
		// A dispatch saves its thread record BEFORE the worker session starts, so the
		// namespace legitimately holds a queued action.
		first.store.threads.set(id, thread(id, { status: "queued", outcomeReason: undefined }));
		const running = first.store.claimNextThreadId();
		first.store.threads.set(running, thread(running, { status: "running", outcomeReason: undefined }));
		assert.equal(first.store.commit()?.kind, "committed");
		assert.equal(first.store.threads.get(id)?.status, "queued");
		assert.equal(first.store.threads.get(running)?.status, "running");

		const second = session(box, { entries, sessionId: "two", digest: OTHER_OWNER });
		second.activate();
		assert.equal(second.store.threads.get(id)?.status, "failed");
		assert.equal(second.store.threads.get(id)?.outcomeReason, "the session ended before the action finished");
		assert.equal(second.store.threads.get(running)?.status, "failed");
		assert.match(second.reports.join("\n"), new RegExp(`${id}, ${running} did not finish .* reads them as failed`));

		// One unfinished action reports the singular form.
		const third = session(box, { entries, sessionId: "three", digest: OTHER_OWNER });
		third.activate();
		third.store.threads.set(id, thread(id, { status: "running", outcomeReason: undefined }));
		third.store.threads.delete(running);
		assert.equal(third.store.commit()?.kind, "committed");
		const fourth = session(box, { entries, sessionId: "four", digest: OWNER });
		fourth.activate();
		assert.match(fourth.reports.join("\n"), new RegExp(`${id} did not finish .* reads it as failed`));
	} finally {
		box.close();
	}
});

test("conflicting locator notes leave slate refusing and every save reports it", () => {
	const box = lab();
	try {
		const note = (name: string, identity: string): Entry => ({
			type: "custom",
			customType: SLATE_BINDING_CUSTOM_TYPE,
			data: { policy: "durable-session-v1", identity, name },
		});
		const entries: Entry[] = [
			note("calm-otter-7f3a", FOREIGN_ID),
			note("brisk-bison-abcd", "20260828T120001Z-deadbeefdeadbeef"),
		];
		const conflicted = session(box, { entries });
		conflicted.activate();
		const state = conflicted.store.authorityState();
		assert.equal(state.kind, "unavailable");
		assert.match(conflicted.reports.join("\n"), /conflicting Pi binding relationships/);
		assert.throws(() => conflicted.store.commit(), /conflicting Pi binding relationships/);
		assert.throws(() => conflicted.store.save(), /conflicting Pi binding relationships/);
		assert.throws(() => conflicted.store.prepareMutation({} as never), /stale or foreign Pi context/);
	} finally {
		box.close();
	}
});

test("a locator note that names no readable namespace leaves slate refusing", () => {
	const box = lab();
	try {
		const entries: Entry[] = [{
			type: "custom",
			customType: SLATE_BINDING_CUSTOM_TYPE,
			data: { policy: "durable-session-v1", identity: FOREIGN_ID, name: "calm-otter-7f3a" },
		}];
		const missing = session(box, { entries });
		missing.activate();
		assert.equal(missing.store.authorityState().kind, "unavailable");
		assert.match(missing.reports.join("\n"), /could not establish current external authority/);
		assert.throws(() => missing.store.commit(), /could not establish current external authority/);
		assert.deepEqual(namespaces(box.project), []);
	} finally {
		box.close();
	}
});

test("a locator note outside the active branch refuses instead of preparing a second namespace", () => {
	const box = lab();
	try {
		const entries: Entry[] = [{
			type: "custom",
			customType: SLATE_BINDING_CUSTOM_TYPE,
			data: { policy: "durable-session-v1", identity: FOREIGN_ID, name: "calm-otter-7f3a" },
		}];
		const rewound = session(box, { entries, branch: [] });
		rewound.activate();
		assert.equal(rewound.store.authorityState().kind, "unavailable");
		assert.match(rewound.reports.join("\n"), /only outside the active branch/);
		assert.deepEqual(namespaces(box.project), []);
	} finally {
		box.close();
	}
});

test("a report that cannot finish leaves the pending refusal in place", () => {
	const box = lab();
	try {
		const broken = session(box, { entries: [] });
		rmSync(box.cwd, { recursive: true, force: true });
		broken.activate();
		const state = broken.store.authorityState();
		assert.equal(state.kind, "unavailable");
		assert.match(broken.reports.join("\n"), /could not select storage for this Pi session/);
		assert.throws(() => broken.store.commit(), /could not select storage for this Pi session/);
	} finally {
		box.close();
	}
});

test("the pending refusal covers the window before the report installs storage", () => {
	const box = lab();
	try {
		const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
		store.refuseRuntimeAuthority(STARTUP_PENDING_REFUSAL);
		assert.deepEqual(store.authorityState(), { kind: "unavailable", message: STARTUP_PENDING_REFUSAL });
		assert.throws(() => store.commit(), /has not finished selecting storage/);
	} finally {
		box.close();
	}
});

test("a locator note failure keeps the records and reports a partial save", () => {
	const box = lab();
	try {
		const entries: Entry[] = [];
		let fail = true;
		const first = session(box, { entries, appendFails: () => fail });
		first.activate();
		const id = first.store.claimNextThreadId();
		first.store.threads.set(id, thread(id));
		const partial = first.store.commit();
		assert.equal(partial?.kind, "partial");
		assert.match(partial?.kind === "partial" ? partial.message : "", /could not persist its advisory Pi binding/);
		assert.equal(namespaces(box.project).length, 1);
		assert.equal(first.notes().length, 0);
		assert.equal(first.store.threads.size, 1);

		// A retry completes the missing note without adding a second one.
		fail = false;
		assert.equal(first.store.commit()?.kind, "committed");
		assert.equal(first.notes().length, 1);
		assert.equal(namespaces(box.project).length, 1);
	} finally {
		box.close();
	}
});

test("a locator note that Pi keeps in memory after a failed write is written again", () => {
	const box = lab();
	try {
		const entries: Entry[] = [];
		const persisted: Entry[] = [];
		let fail = true;
		const first = session(box, { entries, persisted, appendFails: () => fail, memoryFirstAppend: true });
		first.activate();
		const id = first.store.claimNextThreadId();
		first.store.threads.set(id, thread(id));
		const partial = first.store.commit();
		assert.equal(partial?.kind, "partial");
		// The note is in Pi's memory and absent from the conversation file, so the save
		// is partial and no later save may read that memory entry as durable.
		assert.equal(first.notes().length, 1);
		assert.equal(persisted.length, 0);

		fail = false;
		assert.equal(first.store.commit()?.kind, "committed");
		assert.equal(persisted.length, 1);
		assert.equal(persisted[0]?.customType, SLATE_BINDING_CUSTOM_TYPE);
		assert.equal(persisted[0]?.data.name, first.store.slateSessionName);

		// Every further save reads the persisted note and writes nothing.
		assert.equal(first.store.commit()?.kind, "committed");
		assert.equal(persisted.length, 1);
	} finally {
		box.close();
	}
});

test("a failed append whose write did reach the file adds no second note", () => {
	const box = lab();
	try {
		const entries: Entry[] = [];
		const persisted: Entry[] = [];
		let fail = true;
		const first = session(box, { entries, persisted, appendFails: () => fail, memoryFirstAppend: true });
		first.activate();
		const id = first.store.claimNextThreadId();
		first.store.threads.set(id, thread(id));
		assert.equal(first.store.commit()?.kind, "partial");
		assert.equal(first.notes().length, 1);
		// The write reached the file, and the failure came after it.
		persisted.push(first.notes()[0]!);

		fail = false;
		assert.equal(first.store.commit()?.kind, "committed");
		assert.equal(persisted.length, 1);
		assert.equal(first.notes().length, 1);
	} finally {
		box.close();
	}
});

test("adoption keeps the records the validating read returned and refuses a second one", () => {
	const box = lab();
	try {
		const senderEntries: Entry[] = [];
		const sender = session(box, { entries: senderEntries });
		sender.activate();
		const id = sender.store.claimNextThreadId();
		sender.store.threads.set(id, thread(id));
		sender.store.orchestratorMode = true;
		sender.store.workerCostUsd = 6;
		sender.store.commit();
		const binding = {
			policy: "durable-session-v1" as const,
			identity: sender.store.slateSessionId!,
			name: sender.store.slateSessionName!,
		};

		// The receiving Pi session has its own conversation and no locator note.
		const receiverEntries: Entry[] = [];
		const receiver = session(box, { entries: receiverEntries, sessionId: "receiver", digest: OTHER_OWNER });
		receiver.activate();
		assert.equal(receiver.store.authorityState().kind, "fresh");
		const adopted = receiver.store.adoptExternalAuthority(binding);
		assert.deepEqual(adopted, binding);
		assert.deepEqual([...receiver.store.threads.keys()], [id]);
		assert.equal(receiver.store.workerCostUsd, 6);
		assert.equal(receiver.notes().length, 0);

		// The receiving store now saves into the adopted namespace, and its first save
		// writes exactly one locator note.
		receiver.store.paused = false;
		assert.equal(receiver.store.commit()?.kind, "committed");
		assert.equal(receiver.notes().length, 1);
		assert.deepEqual(receiver.notes()[0]?.data, binding);
		assert.equal(namespaces(box.project).length, 1);

		// A session that already continues a Slate session adopts nothing further.
		assert.throws(
			() => receiver.store.adoptExternalAuthority(binding),
			/already selected durable storage/,
		);
	} finally {
		box.close();
	}
});

test("a refused adoption changes no record and keeps the prepared selection", () => {
	const box = lab();
	try {
		const entries: Entry[] = [];
		const receiver = session(box, { entries });
		receiver.activate();
		assert.throws(
			() => receiver.store.adoptExternalAuthority({
				policy: "durable-session-v1",
				identity: FOREIGN_ID,
				name: "calm-otter-7f3a",
			}),
			/slate refused a missing, linked, or changing durable session/,
		);
		assert.equal(receiver.store.authorityState().kind, "fresh");
		assert.equal(receiver.store.threads.size, 0);
		assert.deepEqual(receiver.notes(), []);
	} finally {
		box.close();
	}
});

test("a refusing session adopts nothing and reports its refusal", () => {
	const box = lab();
	try {
		const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
		store.refuseRuntimeAuthority("no storage in this session");
		assert.throws(
			() => store.adoptExternalAuthority({ policy: "durable-session-v1", identity: FOREIGN_ID, name: "calm-otter-7f3a" }),
			/no storage in this session/,
		);
	} finally {
		box.close();
	}
});

test("the locator writer refuses a second, different note on one branch", () => {
	const box = lab();
	try {
		const entries: Entry[] = [{
			type: "custom",
			customType: SLATE_BINDING_CUSTOM_TYPE,
			data: { policy: "durable-session-v1", identity: FOREIGN_ID, name: "calm-otter-7f3a" },
		}];
		const backend = createRuntimeAuthorityBackend(
			{ appendEntry: (customType: string, data: Record<string, unknown>) => entries.push({ type: "custom", customType, data }) } as unknown as ExtensionAPI,
			{ branch: () => entries },
		);
		assert.throws(
			() => backend.writeBinding({ policy: "durable-session-v1", identity: FOREIGN_ID, name: "brisk-bison-abcd" }),
			/already names session calm-otter-7f3a/,
		);
		// The matching note is present, so nothing is appended.
		backend.writeBinding({ policy: "durable-session-v1", identity: FOREIGN_ID, name: "calm-otter-7f3a" });
		assert.equal(entries.length, 1);
		// A malformed note stops the writer rather than adding a note beside it.
		entries.push({ type: "custom", customType: SLATE_BINDING_CUSTOM_TYPE, data: { policy: "legacy" } });
		assert.throws(
			() => backend.writeBinding({ policy: "durable-session-v1", identity: FOREIGN_ID, name: "calm-otter-7f3a" }),
			/beside a malformed locator note/,
		);
	} finally {
		box.close();
	}
});
