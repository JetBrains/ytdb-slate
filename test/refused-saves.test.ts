/**
 * Every save site must REPORT a refusal (Track 14 goal 5), and no site may
 * present an unsaved change as saved. These tests drive the refusal paths of the
 * pause sites, the mode command, handoff adoption, the dispatch record keeping
 * and the state store's own fail-closed guards.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../extension/base-model.ts";
import { currentBranchLabel, resolveCorpusProject, type CorpusProject } from "../extension/corpus.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import { writeCorpusHandoffRecord, type CorpusHandoffRecord } from "../extension/handoff-record.ts";
import { registerSlateMode } from "../extension/mode.ts";
import {
	activateSlateStorage,
	createRuntimeAuthorityBackend,
	SLATE_BINDING_CUSTOM_TYPE,
	type SlateStartupSession,
} from "../extension/runtime-authority.ts";
import {
	createDurableSession,
	updateDurableSession,
	validateSessionNamespace,
	type CanonicalSlateRuntime,
} from "../extension/session-record.ts";
import { SlateStore, type EpisodeRecord, type ThreadRecord } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";

const SOURCE_ID = "20260828T120000Z-0123abcd0123abcd";
const SOURCE_NAME = "calm-otter-7f3a";
const SOURCE_OWNER = "a".repeat(64);
const ADOPTER_OWNER = "b".repeat(64);

interface Lab {
	root: string;
	cwd: string;
	project: CorpusProject;
	close(): void;
}

function lab(name: string): Lab {
	const root = mkdtempSync(join(tmpdir(), `slate-refused-${name}.`));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	return {
		root,
		cwd,
		project: resolveCorpusProject(cwd),
		close() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function runtime(overrides: Partial<CanonicalSlateRuntime> = {}): CanonicalSlateRuntime {
	return {
		threads: [],
		episodes: [],
		threadSeq: 0,
		slateSessionParentChain: [],
		orchestratorMode: true,
		paused: true,
		workerCostUsd: 1,
		carriedCostUsd: 1,
		...overrides,
	};
}

function thread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
	return {
		id,
		name: `action ${id}`,
		status: "failed",
		type: "general",
		outcomeReason: "stored for the test",
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

// ---------------------------------------------------------------- pause sites --

function pauseHarness(options: { commitError?: unknown; config?: Record<string, unknown> } = {}) {
	const sent: Array<{ customType?: string }> = [];
	const notifications: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
		sendMessage(message: { customType?: string }) { sent.push(message); },
		appendEntry() {},
		getThinkingLevel() { return undefined; },
	} as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	store.refuseRuntimeAuthority("forced startup refusal");
	if (options.commitError !== undefined) {
		store.commit = () => { throw options.commitError; };
	}
	store.orchestratorMode = true;
	const hooks = registerSlateHandoff(pi, store, () => (options.config ?? {}), () => ({} as unknown as BaseModelTracker));
	return { handlers, hooks, notifications, pi, sent, store };
}

test("the automatic pause reports its refused save and stays paused", async (t) => {
	const box = lab("pause");
	t.after(() => box.close());
	const harness = pauseHarness({ config: { pauseThresholdPercent: 10 } });
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	const ctx = {
		cwd: box.cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		getContextUsage: () => ({ percent: 100 }),
		model: undefined,
	} as unknown as ExtensionContext;
	const turnEnd = harness.handlers.get("turn_end");
	assert.ok(turnEnd);
	await turnEnd({}, ctx);
	assert.equal(harness.store.paused, true);
	assert.match(warnings.join("\n"), /the automatic pause was not saved: forced startup refusal/);
	// The steer still reaches the orchestrator, because the pause holds in memory.
	assert.equal(harness.sent.at(-1)?.customType, "slate-pause");
});

test("the intercepted compaction pause reports a refusal that is not an error object", async (t) => {
	const box = lab("compaction");
	t.after(() => box.close());
	const harness = pauseHarness({ commitError: "plain refusal text", config: { contextBudget: { tokens: 1000 } } });
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	const ctx = {
		cwd: box.cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 10, contextWindow: 100 }),
		model: undefined,
	} as unknown as ExtensionContext;
	const beforeCompact = harness.handlers.get("session_before_compact");
	assert.ok(beforeCompact);
	const result = await beforeCompact({ reason: "threshold" }, ctx);
	assert.deepEqual(result, { cancel: true });
	assert.equal(harness.store.paused, true);
	assert.match(warnings.join("\n"), /the intercepted compaction pause was not saved: plain refusal text/);
});

// ------------------------------------------------------------- the mode command --

test("a refused mode change reports through the user interface and reverts", async (t) => {
	const box = lab("mode");
	t.after(() => box.close());
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const activeTools: string[] = ["read", "bash"];
	const pi = {
		on() {},
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) {
			commands.set(name, command.handler);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(tools: string[]) { activeTools.length = 0; activeTools.push(...tools); },
		getAllTools: () => [],
		sendMessage() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	store.refuseRuntimeAuthority("forced startup refusal");
	store.commit = () => { throw "plain refusal text"; };
	const hooks = {
		startHandoff: async () => {},
		adoptHandoff: async () => false,
		effectiveContextBudget: () => undefined,
	};
	registerSlateMode(pi, store, hooks, () => ({}), () => ({ units: [], paths: [], toolNames: [] }));
	const notified: string[] = [];
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	const ctx = {
		cwd: box.cwd,
		mode: "print",
		hasUI: true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			notify(message: string) { notified.push(message); },
			setStatus() {},
			setWidget() {},
		},
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionContext;
	const command = commands.get("slate");
	assert.ok(command);
	await command("on", ctx);
	assert.match(warnings.join("\n"), /the mode change was not saved: plain refusal text/);
	assert.equal(notified.some((message) => message.includes("was not saved")), true);
	assert.equal(store.orchestratorMode, false);
	assert.deepEqual(activeTools, ["read", "bash"]);

	// A user interface that throws leaves the console line as the only report.
	const throwingCtx = {
		...(ctx as unknown as Record<string, unknown>),
		ui: {
			notify() { throw new Error("stale user interface"); },
			setStatus() {},
			setWidget() {},
		},
	} as unknown as ExtensionContext;
	warnings.length = 0;
	await command("resume", throwingCtx);
	assert.match(warnings.join("\n"), /the resume was not saved/);
});

// ------------------------------------------------------------------- adoption --

interface AdoptBox {
	lab: Lab;
	directory: string;
	record: CorpusHandoffRecord;
}

function adoptSandbox(box: Lab, options: { withEpisode?: boolean } = {}): AdoptBox {
	const created = createDurableSession({
		project: box.project,
		cwd: box.cwd,
		identity: SOURCE_ID,
		name: SOURCE_NAME,
		creatorSessionDigest: SOURCE_OWNER,
		runtime: runtime(),
	});
	if (options.withEpisode === true) {
		writeFileSync(join(created.directory, "episodes", "t1.e1.md"), "episode\n");
		const episode: EpisodeRecord = {
			id: "t1.e1",
			threadId: "t1",
			task: "stored",
			status: "ok",
			file: join(created.directory, "episodes", "t1.e1.md"),
			createdAt: 3,
		};
		updateDurableSession({
			project: box.project,
			cwd: box.cwd,
			identity: SOURCE_ID,
			name: SOURCE_NAME,
			writerSessionDigest: SOURCE_OWNER,
			runtime: runtime({
				threads: [thread("t1", { status: "successful", episodeId: "t1.e1", outcomeReason: undefined })],
				episodes: [episode],
				threadSeq: 1,
			}),
		});
	}
	const record: CorpusHandoffRecord = {
		version: 1,
		author: { identity: SOURCE_ID, name: SOURCE_NAME },
		authorSessionDirectory: created.directory,
		createdAt: Date.now(),
		worktreePath: box.cwd,
		branchLabel: currentBranchLabel(box.cwd),
		parentChain: [],
		brief: "continue",
		carriedCostUsd: 1,
	};
	writeCorpusHandoffRecord(box.project, record);
	return { lab: box, directory: created.directory, record };
}

function adoptHarness(box: Lab, options: { noteFails?: () => boolean } = {}) {
	const entries: Array<{ type: "custom"; customType: string; data: Record<string, unknown> }> = [];
	const messages: Array<{ customType?: string }> = [];
	const pi = {
		on() {},
		appendEntry(customType: string, data: Record<string, unknown>) {
			if (options.noteFails?.() === true) throw new Error("forced locator note failure");
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: { customType?: string }) { messages.push(message); },
		getThinkingLevel: () => undefined,
	} as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	const session: SlateStartupSession = {
		key: "pi-session:adopter",
		cwd: box.cwd,
		sessionDigest: ADOPTER_OWNER,
		project: box.project,
		entries,
		branch: entries,
	};
	activateSlateStorage({
		store,
		session,
		backend: createRuntimeAuthorityBackend(pi, { branch: () => entries }),
		report: () => {},
	});
	const hooks = registerSlateHandoff(pi, store, () => ({}), () => ({} as unknown as BaseModelTracker));
	const ctx = {
		cwd: box.cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		waitForIdle: async () => {},
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
	} as unknown as ExtensionCommandContext;
	return { ctx, entries, hooks, messages, store, notes: () => entries.filter((entry) => entry.customType === SLATE_BINDING_CUSTOM_TYPE) };
}

test("adoption reports a refused namespace read and changes nothing", async (t) => {
	const box = lab("adopt-read");
	t.after(() => box.close());
	adoptSandbox(box);
	// The handoff record still reads, and the store's own validating read of the
	// namespace refuses: its selected project directory does not exist.
	const harness = adoptHarness({
		...box,
		project: { ...box.project, directory: join(box.project.root, `absent-${box.project.digest}`) },
	});
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	assert.equal(await harness.hooks.adoptHandoff(harness.ctx, SOURCE_NAME, () => () => {}), false);
	assert.match(warnings.join("\n"), /adoption refused the external namespace calm-otter-7f3a.*No Slate record changed/s);
	assert.equal(harness.store.authorityState().kind, "fresh");
	assert.deepEqual(harness.notes(), []);
});

test("adoption reports a partial save and its advertised retry completes the note", { timeout: 20_000 }, async (t) => {
	const box = lab("adopt-partial");
	t.after(() => box.close());
	adoptSandbox(box, { withEpisode: true });
	let fail = true;
	const harness = adoptHarness(box, { noteFails: () => fail });
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	assert.equal(await harness.hooks.adoptHandoff(harness.ctx, SOURCE_NAME, () => () => {}), true);
	// The records are adopted, and the missing note is reported as a partial result.
	assert.match(warnings.join("\n"), /adoption saved every Slate record, but .*advisory Pi binding/);
	assert.match(warnings.join("\n"), /adopted successfully with 1 thread and 1 episode/);
	assert.equal(harness.notes().length, 0);
	assert.equal(harness.messages.at(-1)?.customType, "slate-kickoff");

	// THE ADVERTISED RECOVERY, performed (BG1502/CN1506). The partial report tells
	// the user to run the same adopt command again, and that command must work.
	fail = false;
	warnings.length = 0;
	assert.equal(await harness.hooks.adoptHandoff(harness.ctx, SOURCE_NAME, () => () => {}), true);
	assert.match(warnings.join("\n"), /was already adopted in this Pi session, and slate completed its locator note/);
	assert.equal(harness.notes().length, 1);
	assert.equal(harness.notes()[0]?.data.name, SOURCE_NAME);
	// It repeats no kickoff and loses no record.
	assert.equal(harness.messages.filter((message) => message.customType === "slate-kickoff").length, 1);
	assert.equal(harness.store.threads.size, 1);
	assert.equal(harness.store.episodes.size, 1);
});

test("a stop between the namespace update and the locator note loses no record", { timeout: 20_000 }, async (t) => {
	const box = lab("adopt-interrupted");
	t.after(() => box.close());
	adoptSandbox(box, { withEpisode: true });
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	// The receiving save updates the namespace and then fails to write the locator
	// note. The Pi session stops at exactly that point (Track 14 goal 12).
	const stopped = adoptHarness(box, { noteFails: () => true });
	assert.equal(await stopped.hooks.adoptHandoff(stopped.ctx, SOURCE_NAME, () => () => {}), true);
	assert.equal(stopped.notes().length, 0);

	// ANOTHER PI SESSION. Its conversation holds no locator note, so its startup
	// prepares a new namespace, and every record still waits in the old one.
	const next = adoptHarness(box);
	assert.equal(next.store.authorityState().kind, "fresh");
	assert.equal(next.store.threads.size, 0);
	assert.equal(next.store.episodes.size, 0);
	warnings.length = 0;
	assert.equal(await next.hooks.adoptHandoff(next.ctx, SOURCE_NAME, () => () => {}), true);
	assert.match(warnings.join("\n"), /adopted successfully with 1 thread and 1 episode/);
	assert.equal(next.store.threads.size, 1);
	assert.equal(next.store.episodes.size, 1);
	assert.equal(next.notes().length, 1);
	assert.equal(next.notes()[0]?.data.name, SOURCE_NAME);
});

test("a refused adoption save reports a failed tool-set rollback too", async (t) => {
	const box = lab("adopt-rollback");
	t.after(() => box.close());
	const sandbox = adoptSandbox(box);
	const harness = adoptHarness(box);
	let forceValue = false;
	Object.defineProperty(harness.store.writingReminder, "forceNext", {
		enumerable: true,
		configurable: true,
		get: () => forceValue,
		set: (value: boolean) => {
			forceValue = value;
			// The save that follows this assignment finds an incomplete namespace.
			if (value) rmSync(join(sandbox.directory, "threads"), { recursive: true, force: true });
		},
	});
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	const adopted = await harness.hooks.adoptHandoff(harness.ctx, SOURCE_NAME, () => () => {
		throw new Error("forced tool-set restore failure");
	});
	assert.equal(adopted, false);
	assert.match(warnings.join("\n"), /could not save the receiving session state/);
	assert.match(warnings.join("\n"), /Restoring the previous tool set also reported: forced tool-set restore failure/);
	assert.deepEqual(harness.notes(), []);
});

test("a handoff stops when the records cannot be saved", { timeout: 20_000 }, async (t) => {
	const box = lab("handoff-save");
	t.after(() => box.close());
	const harness = pauseHarness();
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	const ctx = {
		cwd: box.cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		waitForIdle: async () => {},
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionCommandContext;
	await harness.hooks.startHandoff(ctx);
	assert.match(warnings.join("\n"), /handoff stopped because slate could not save its records.*No handoff record was written/);
});

// ------------------------------------------------------ state store guards --

test("the state store refuses a save whose selection has no context", (t) => {
	const box = lab("guards");
	t.after(() => box.close());
	const entries: Array<{ type: "custom"; customType: string; data: Record<string, unknown> }> = [];
	const pi = { appendEntry() {} } as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	activateSlateStorage({
		store,
		session: {
			key: "pi-session:guards",
			cwd: box.cwd,
			sessionDigest: ADOPTER_OWNER,
			project: box.project,
			entries,
			branch: entries,
		},
		backend: createRuntimeAuthorityBackend(pi, { branch: () => entries }),
		report: () => {},
	});
	assert.equal(store.authorityState().kind, "fresh");
	const internals = store as unknown as { runtimeAuthoritySourceContext: unknown; runtimeAuthorityContext: unknown };
	internals.runtimeAuthoritySourceContext = undefined;
	assert.throws(() => store.commit(), /runtime authority is not configured/);
	internals.runtimeAuthorityContext = undefined;
	assert.throws(
		() => store.adoptExternalAuthority({ policy: "durable-session-v1", identity: SOURCE_ID, name: SOURCE_NAME }),
		/runtime authority is not configured/,
	);
});

test("the state store refuses a nested transaction from a display refresh", (t) => {
	const box = lab("nested");
	t.after(() => box.close());
	const entries: Array<{ type: "custom"; customType: string; data: Record<string, unknown> }> = [];
	const pi = {
		appendEntry(customType: string, data: Record<string, unknown>) {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	const reports: string[] = [];
	activateSlateStorage({
		store,
		session: {
			key: "pi-session:nested",
			cwd: box.cwd,
			sessionDigest: ADOPTER_OWNER,
			project: box.project,
			entries,
			branch: entries,
		},
		backend: createRuntimeAuthorityBackend(pi, { branch: () => entries }),
		report: (message) => reports.push(message),
	});
	const attempts: string[] = [];
	store.onDidChange = () => {
		for (const [label, attempt] of [
			["commit", () => store.commit()],
			["refuse", () => store.refuseRuntimeAuthority("nested refusal")],
			["adopt", () => store.adoptExternalAuthority({ policy: "durable-session-v1", identity: SOURCE_ID, name: SOURCE_NAME })],
		] as const) {
			try {
				attempt();
				attempts.push(`${label}: accepted`);
			} catch (error) {
				attempts.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
	store.orchestratorMode = true;
	store.commit();
	assert.equal(store.authorityState().kind, "durable");
	for (const label of ["commit", "refuse", "adopt"]) {
		assert.equal(
			attempts.some((entry) => entry.startsWith(`${label}: slate refused a nested runtime transaction`)),
			true,
			`${label}: ${attempts.join(" | ")}`,
		);
	}
});

// --------------------------------------------------------- dispatch reporting --

test("a refused dispatch save reports both the failure and the refused rollback", { timeout: 5_000 }, async (t) => {
	const box = lab("dispatch");
	t.after(() => box.close());
	const entries: Array<{ type: "custom"; customType: string; data: Record<string, unknown> }> = [];
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
			sessionDigest: ADOPTER_OWNER,
			project: box.project,
			entries,
			branch: entries,
		},
		backend: createRuntimeAuthorityBackend(pi, { branch: () => entries }),
		report: () => {},
	});
	const realCommit = store.commit.bind(store);
	// The FIRST save of each dispatch is accepted, so the thread record exists and
	// the later record keeping is what gets refused. The refusal is deliberately
	// not an error object.
	let acceptNext = true;
	store.commit = () => {
		if (!acceptNext) throw "plain refusal text";
		acceptNext = false;
		return realCommit();
	};
	const manager = new ThreadManager(store, { maxConcurrent: 1 });
	(manager as unknown as { openWorkerFor(): Promise<unknown> }).openWorkerFor = async () => {
		throw new Error("the worker must not open");
	};
	await assert.rejects(
		manager.dispatch({ name: "refused", task: "refused", type: "general" }, { cwd: box.cwd } as ExtensionContext, undefined),
		/Slate could not start thread t1: plain refusal text.*Slate could not save that removal either: plain refusal text/s,
	);
	assert.equal(store.threads.size, 0);

	// An already aborted dispatch reports the refused removal in the same way, and
	// an error object reads through the same clause as a plain value.
	acceptNext = true;
	store.commit = () => {
		if (!acceptNext) throw new Error("forced save refusal");
		acceptNext = false;
		return realCommit();
	};
	await assert.rejects(
		manager.dispatch({ name: "aborted", task: "aborted", type: "general" }, { cwd: box.cwd } as ExtensionContext, AbortSignal.abort()),
		/cancelled before the action started.*Slate could not save that removal: forced save refusal/s,
	);
});

// ------------------------------------------------------- namespace validation --

test("a startup report that cannot read its own session refuses with a plain message", (t) => {
	const box = lab("startup-guards");
	t.after(() => box.close());
	const pi = { appendEntry() {} } as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	const reports: string[] = [];
	const backend = createRuntimeAuthorityBackend(pi, { branch: () => [] });
	activateSlateStorage({
		store,
		session: {
			key: "pi-session:throwing",
			cwd: box.cwd,
			sessionDigest: ADOPTER_OWNER,
			// A throw that is not an error object still produces a readable refusal.
			get project(): CorpusProject { throw "plain project failure"; },
			entries: [],
			branch: [],
		} as unknown as SlateStartupSession,
		backend,
		report: (message) => reports.push(message),
	});
	assert.equal(store.authorityState().kind, "unavailable");
	assert.match(reports.join("\n"), /could not select storage for this Pi session: plain project failure/);

	// A store that refuses the selection itself is reported the same way.
	const second = new SlateStore(pi);
	second.configureRuntimeAuthority = () => { throw new Error("forced selection failure"); };
	const secondReports: string[] = [];
	activateSlateStorage({
		store: second,
		session: {
			key: "pi-session:refusing-store",
			cwd: box.cwd,
			sessionDigest: ADOPTER_OWNER,
			project: box.project,
			entries: [],
			branch: [],
		},
		backend,
		report: (message) => secondReports.push(message),
	});
	assert.equal(second.authorityState().kind, "unavailable");
	assert.match(secondReports.join("\n"), /could not select storage for this Pi session: forced selection failure/);
});

test("the locator writer refuses malformed branch evidence", (t) => {
	const box = lab("writer");
	t.after(() => box.close());
	const branch = [{ type: "message", customType: SLATE_BINDING_CUSTOM_TYPE, data: {} }];
	const backend = createRuntimeAuthorityBackend({ appendEntry() {} } as unknown as ExtensionAPI, { branch: () => branch });
	assert.throws(
		() => backend.writeBinding({ policy: "durable-session-v1", identity: SOURCE_ID, name: SOURCE_NAME }),
		/beside malformed Pi binding evidence/,
	);
});

test("namespace validation accepts a durable namespace without an identity", (t) => {
	const box = lab("namespace");
	t.after(() => box.close());
	const created = createDurableSession({
		project: box.project,
		cwd: box.cwd,
		identity: SOURCE_ID,
		name: SOURCE_NAME,
		creatorSessionDigest: SOURCE_OWNER,
		runtime: runtime(),
	});
	assert.equal(validateSessionNamespace(box.project, SOURCE_NAME, undefined), true);
	assert.equal(validateSessionNamespace(box.project, SOURCE_NAME, SOURCE_ID), true);
	assert.equal(validateSessionNamespace(box.project, SOURCE_NAME, "20260828T120001Z-deadbeefdeadbeef"), false);
	assert.equal(created.metadata.name, SOURCE_NAME);
});

test("handoff writing refuses an author directory that is not the derived one", (t) => {
	const box = lab("author-directory");
	t.after(() => box.close());
	const sandbox = adoptSandbox(box);
	assert.throws(
		() => writeCorpusHandoffRecord(box.project, {
			...sandbox.record,
			authorSessionDirectory: join(box.project.directory, "brisk-bison-abcd"),
		}),
		/author metadata that does not match its corpus session/,
	);
});
