import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCorpusProject, type CorpusProject } from "../extension/corpus.ts";
import {
	DurableCommitUncertain,
	DurableRevisionConflict,
	readDurableSession,
} from "../extension/session-record.ts";
import {
	createRuntimeAuthorityBackend,
	createRuntimeAuthorityContext,
} from "../extension/runtime-authority.ts";
import {
	SlateStore,
	type CanonicalRuntimeState,
	type RuntimeAuthorityBackend,
	type RuntimeAuthorityBinding,
	type RuntimeAuthorityContext,
	type RuntimeAuthorityExternalRecord,
} from "../extension/state.ts";

const ID = "20260827T120000Z-0123abcd0123abcd";
const OTHER_ID = "20260827T120001Z-deadbeefdeadbeef";
const NAME = "calm-otter-7f3a";
const OWNER = "a".repeat(64);

function project(): CorpusProject {
	return {
		root: "/corpus",
		key: "/project-key",
		label: "project",
		digest: "0123456789ab",
		directory: "/corpus/project-0123456789ab",
		matchingDirectories: [],
	};
}

function context(overrides: Partial<RuntimeAuthorityContext> = {}): RuntimeAuthorityContext {
	return {
		key: "pi-session:branch-main",
		cwd: "/project",
		ownerSessionDigest: OWNER,
		project: project(),
		...overrides,
	};
}

function binding(overrides: Partial<RuntimeAuthorityBinding> = {}): RuntimeAuthorityBinding {
	return {
		policy: "durable-session-v1",
		identity: ID,
		name: NAME,
		ownerSessionDigest: OWNER,
		generation: 0,
		...overrides,
	};
}

function runtime(overrides: Partial<CanonicalRuntimeState> = {}): CanonicalRuntimeState {
	return {
		threads: [],
		episodes: [],
		threadSeq: 0,
		slateSessionParentChain: [],
		orchestratorMode: false,
		paused: false,
		workerCostUsd: 0,
		carriedCostUsd: 0,
		...overrides,
	};
}

function record(
	ctx: RuntimeAuthorityContext,
	relation: RuntimeAuthorityBinding,
	generation: number,
	value: CanonicalRuntimeState,
	status: "active" | "delivered" | "abandoned" = "active",
): RuntimeAuthorityExternalRecord {
	return {
		directory: join(ctx.project.directory, relation.name),
		metadata: {
			identity: relation.identity,
			name: relation.name,
			currentDirectory: ctx.cwd,
			projectKey: ctx.project.key,
			projectDigest: ctx.project.digest,
		},
		state: {
			generation,
			status,
			ownerSessionDigest: relation.ownerSessionDigest,
			runtime: structuredClone(value),
		},
	};
}

class FakeBackend implements RuntimeAuthorityBackend {
	readonly events: string[] = [];
	readonly bindings: RuntimeAuthorityBinding[] = [];
	readonly uncertain = new WeakSet<object>();
	current: RuntimeAuthorityExternalRecord | undefined;
	createError: Error | undefined;
	updateError: Error | undefined;
	readError: Error | undefined;
	bindingError: Error | undefined;
	onMint: (() => void) | undefined;
	onCreate: (() => void) | undefined;
	onRead: (() => void) | undefined;
	onUpdate: (() => void) | undefined;
	onWriteBinding: (() => void) | undefined;
	onIsCommitUncertain: (() => void) | undefined;
	onIsRevisionConflict: (() => void) | undefined;

	mint(): { identity: string; name: string } {
		this.events.push("mint");
		this.onMint?.();
		return { identity: ID, name: NAME };
	}

	create(options: {
		context: RuntimeAuthorityContext;
		identity: string;
		name: string;
		runtime: CanonicalRuntimeState;
	}): RuntimeAuthorityExternalRecord {
		this.events.push("external-create");
		this.onCreate?.();
		if (this.createError !== undefined) throw this.createError;
		this.current = record(options.context, binding({ identity: options.identity, name: options.name }), 0, options.runtime);
		return this.current;
	}

	read(_options: {
		context: RuntimeAuthorityContext;
		binding: RuntimeAuthorityBinding;
	}): RuntimeAuthorityExternalRecord {
		this.events.push("external-read");
		this.onRead?.();
		if (this.readError !== undefined) throw this.readError;
		if (this.current === undefined) throw new Error("missing authority");
		return structuredClone(this.current);
	}

	update(options: {
		context: RuntimeAuthorityContext;
		binding: RuntimeAuthorityBinding;
		expectedGeneration: number;
		runtime: CanonicalRuntimeState;
	}): RuntimeAuthorityExternalRecord {
		this.events.push("external-update");
		this.onUpdate?.();
		if (this.updateError !== undefined) throw this.updateError;
		this.current = record(options.context, options.binding, options.expectedGeneration + 1, options.runtime);
		return this.current;
	}

	writeBinding(value: RuntimeAuthorityBinding): void {
		this.events.push("pi-binding");
		this.onWriteBinding?.();
		if (this.bindingError !== undefined) throw this.bindingError;
		this.bindings.push(structuredClone(value));
	}

	isCommitUncertain(error: unknown): boolean {
		this.onIsCommitUncertain?.();
		return typeof error === "object" && error !== null && this.uncertain.has(error);
	}

	isRevisionConflict(error: unknown): boolean {
		this.onIsRevisionConflict?.();
		return error instanceof DurableRevisionConflict;
	}
}

function store(): { value: SlateStore; piSnapshots: string[] } {
	const piSnapshots: string[] = [];
	const value = new SlateStore({
		appendEntry(customType: string) { piSnapshots.push(customType); },
	} as unknown as ExtensionAPI);
	return { value, piSnapshots };
}

function activeStore(value = runtime()): {
	store: SlateStore;
	backend: FakeBackend;
	context: RuntimeAuthorityContext;
} {
	const ctx = context();
	const backend = new FakeBackend();
	backend.current = record(ctx, binding(), 4, value);
	const instance = store().value;
	instance.configureRuntimeAuthority({ kind: "durable", binding: binding({ generation: 1 }) }, ctx, backend);
	return { store: instance, backend, context: ctx };
}

function runtimeReentryOutcomes(
	value: SlateStore,
	ctx: RuntimeAuthorityContext,
	backend: RuntimeAuthorityBackend,
): boolean[] {
	const replacement = context({ key: `${ctx.key}:replacement` });
	const legacyContext = {
		cwd: ctx.cwd,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionContext;
	const attempts = [
		() => value.configureRuntimeAuthority({ kind: "fresh" }, replacement, backend),
		() => value.prepareMutation(ctx),
		() => value.save(),
		() => value.restore(legacyContext),
		() => value.adoptSnapshot(undefined, legacyContext),
		() => value.resolveSessionIdentity(OWNER, () => {}),
		() => value.claimNextThreadId(),
	];
	return attempts.map((attempt) => {
		try {
			attempt();
			return false;
		} catch (error) {
			return error instanceof Error && /nested runtime transaction/.test(error.message);
		}
	});
}

test("legacy remains the default and keeps historical Pi snapshot saves", () => {
	const harness = store();
	assert.deepEqual(harness.value.authorityState(), { kind: "legacy" });
	harness.value.paused = true;
	harness.value.save();
	assert.deepEqual(harness.piSnapshots, ["slate-state"]);
});

test("legacy save establishes its transaction guard before Pi persistence", () => {
	let value: SlateStore;
	let appends = 0;
	const nestedOutcomes: boolean[] = [];
	const pi = {
		appendEntry() {
			appends += 1;
			for (const attempt of [() => value.save(), () => value.prepareMutation(context())]) {
				try {
					attempt();
					nestedOutcomes.push(false);
				} catch (error) {
					nestedOutcomes.push(error instanceof Error && /nested runtime transaction/.test(error.message));
				}
			}
		},
	} as unknown as ExtensionAPI;
	value = new SlateStore(pi);
	value.save();
	assert.equal(appends, 1);
	assert.deepEqual(nestedOutcomes, [true, true]);
});

test("legacy restore establishes its transaction guard before the branch read", () => {
	const value = store().value;
	const outcomes: boolean[] = [];
	const observe = (attempt: () => unknown): void => {
		try {
			attempt();
			outcomes.push(false);
		} catch (error) {
			outcomes.push(error instanceof Error && /nested runtime transaction/.test(error.message));
		}
	};
	const ctx = {
		cwd: "/project",
		sessionManager: {
			getBranch() {
				observe(() => value.restore({} as ExtensionContext));
				observe(() => value.save());
				return [];
			},
			getEntries: () => [],
		},
	} as unknown as ExtensionContext;
	value.restore(ctx);
	assert.deepEqual(outcomes, [true, true]);
});

test("legacy save preserves persisted state when its observer throws", () => {
	const snapshots: Array<Record<string, unknown>> = [];
	const value = new SlateStore({
		appendEntry(_type: string, data: Record<string, unknown>) { snapshots.push(structuredClone(data)); },
	} as unknown as ExtensionAPI);
	value.paused = true;
	let observed: boolean | undefined;
	value.onDidChange = () => {
		observed = value.paused;
		throw new Error("legacy observer failed");
	};
	assert.throws(() => value.save(), /legacy observer failed/);
	assert.equal(observed, true);
	assert.equal(snapshots[0]?.paused, true);
	assert.equal(value.paused, true);
});

test("failed legacy restoration exposes no prior-branch state", async (t) => {
	const seeded = (): SlateStore => {
		const value = store().value;
		value.paused = true;
		value.workerCostUsd = 5;
		value.carriedCostUsd = 7;
		value.slateSessionParentChain = [{ identity: ID, name: NAME }];
		return value;
	};
	const assertCleared = (value: SlateStore, changes: number): void => {
		assert.equal(value.paused, false);
		assert.equal(value.workerCostUsd, 0);
		assert.equal(value.carriedCostUsd, 0);
		assert.deepEqual(value.slateSessionParentChain, []);
		assert.equal(value.threads.size, 0);
		assert.equal(value.episodes.size, 0);
		assert.equal(changes, 1);
	};

	await t.test("branch read failure", () => {
		const value = seeded();
		let changes = 0;
		value.onDidChange = () => { changes += 1; };
		const ctx = {
			cwd: "/project",
			sessionManager: {
				getBranch() { throw new Error("branch read failed"); },
				getEntries: () => [],
			},
		} as unknown as ExtensionContext;
		assert.throws(() => value.restore(ctx), /branch read failed/);
		assertCleared(value, changes);
	});

	await t.test("session entry read failure after branch read", () => {
		const value = seeded();
		const selected = runtime({ paused: false, workerCostUsd: 2, carriedCostUsd: 3 });
		const custom = { type: "custom", customType: "slate-state", data: selected };
		const observations: boolean[] = [];
		let changes = 0;
		value.onDidChange = () => { changes += 1; };
		const ctx = {
			cwd: "/project",
			sessionManager: {
				getBranch: () => [custom],
				getEntries() {
					observations.push(value.paused);
					throw new Error("session read failed");
				},
			},
		} as unknown as ExtensionContext;
		assert.throws(() => value.restore(ctx), /session read failed/);
		assert.deepEqual(observations, [false]);
		assertCleared(value, changes);
	});
});

test("legacy restore notifies once after session-wide cost restoration completes", () => {
	const value = store().value;
	const latest = runtime({ workerCostUsd: 2, carriedCostUsd: 3 });
	const olderBranchCost = runtime({ workerCostUsd: 7, carriedCostUsd: 11 });
	const custom = (data: CanonicalRuntimeState) => ({ type: "custom", customType: "slate-state", data });
	const ctx = {
		cwd: "/project",
		sessionManager: {
			getBranch: () => [custom(latest)],
			getEntries: () => [custom(latest), custom(olderBranchCost)],
		},
	} as unknown as ExtensionContext;
	const observations: Array<readonly [number, number]> = [];
	value.onDidChange = () => { observations.push([value.workerCostUsd, value.carriedCostUsd]); };
	value.restore(ctx);
	assert.deepEqual(observations, [[7, 11]]);
	assert.equal(value.workerCostUsd, 7);
	assert.equal(value.carriedCostUsd, 11);
});

test("legacy restore without Slate state clears memory and notifies once", () => {
	const value = store().value;
	value.paused = true;
	value.workerCostUsd = 5;
	value.slateSessionParentChain = [{ identity: ID, name: NAME }];
	const observations: CanonicalRuntimeState[] = [];
	value.onDidChange = () => observations.push(runtime({
		threads: [...value.threads.values()],
		episodes: [...value.episodes.values()],
		threadSeq: 0,
		slateSessionParentChain: structuredClone(value.slateSessionParentChain),
		orchestratorMode: value.orchestratorMode,
		paused: value.paused,
		workerCostUsd: value.workerCostUsd,
		carriedCostUsd: value.carriedCostUsd,
	}));
	value.restore({
		cwd: "/project",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionContext);
	assert.equal(observations.length, 1);
	assert.equal(observations[0]?.paused, false);
	assert.equal(observations[0]?.workerCostUsd, 0);
	assert.deepEqual(observations[0]?.slateSessionParentChain, []);
	assert.equal(value.paused, false);
	assert.equal(value.workerCostUsd, 0);
});

test("legacy restore keeps selected-branch state when its observer fails", () => {
	const value = store().value;
	value.paused = true;
	const selected = runtime({ paused: false, workerCostUsd: 7 });
	const custom = { type: "custom", customType: "slate-state", data: selected };
	let changes = 0;
	let observedPaused: boolean | undefined;
	value.onDidChange = () => {
		changes += 1;
		observedPaused = value.paused;
		throw new Error("selected branch display failed");
	};
	assert.doesNotThrow(() => value.restore({
		cwd: "/project",
		sessionManager: { getBranch: () => [custom], getEntries: () => [custom] },
	} as unknown as ExtensionContext));
	assert.equal(changes, 1);
	assert.equal(observedPaused, false);
	assert.equal(value.paused, false);
	assert.equal(value.workerCostUsd, 7);
});

test("legacy restore keeps selected state when its advisory repair notice throws", () => {
	const value = store().value;
	const selected = runtime({
		threads: [{
			id: "t1",
			name: "selected",
			sessionFile: "/missing-selected-session.jsonl",
			status: "idle",
			episodeIds: [],
			episodeSeq: 0,
			createdAt: 1,
			updatedAt: 1,
		}],
		threadSeq: 1,
		paused: true,
		workerCostUsd: 7,
	});
	const custom = { type: "custom", customType: "slate-state", data: selected };
	let notices = 0;
	const ctx = {
		cwd: "/project",
		hasUI: true,
		ui: {
			notify() {
				notices += 1;
				throw new Error("repair notice display failed");
			},
		},
		sessionManager: { getBranch: () => [custom], getEntries: () => [custom] },
	} as unknown as ExtensionContext;
	assert.doesNotThrow(() => value.restore(ctx));
	assert.equal(notices, 1);
	assert.equal(value.paused, true);
	assert.equal(value.workerCostUsd, 7);
	assert.equal(value.threads.get("t1")?.name, "selected");
	assert.equal(value.threads.get("t1")?.sessionFile, "/missing-selected-session.jsonl");
});

test("fresh selection stays unbound until an authorized mutation commits", () => {
	const harness = store();
	const backend = new FakeBackend();
	const ctx = context();
	harness.value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
	assert.deepEqual(harness.value.authorityState(), { kind: "fresh", contextKey: ctx.key });
	assert.equal(harness.value.slateSessionId, undefined);
	assert.deepEqual(backend.events, []);
	assert.throws(() => harness.value.save(), /authorized mutation permit/);
	assert.throws(() => harness.value.resolveSessionIdentity(OWNER, () => {}), /legacy identity persistence/);
	assert.throws(
		() => harness.value.adoptSnapshot(undefined, { cwd: ctx.cwd } as ExtensionContext),
		/Pi-held canonical state/,
	);

	const permit = harness.value.prepareMutation(ctx);
	permit.runtime.paused = true;
	const result = harness.value.save(permit);
	assert.equal(result?.kind, "committed");
	assert.equal(harness.value.paused, true);
	assert.equal(harness.value.slateSessionId, ID);
	assert.deepEqual(backend.events, ["mint", "external-create", "pi-binding"]);
	assert.deepEqual(harness.piSnapshots, []);
});

test("failed first publication restores fresh state without fallback authority", () => {
	const harness = store();
	const backend = new FakeBackend();
	const ctx = context();
	backend.createError = new Error("creation failed");
	harness.value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
	const permit = harness.value.prepareMutation(ctx);
	permit.runtime.paused = true;
	assert.throws(() => harness.value.save(permit), /creation failed/);
	assert.deepEqual(harness.value.authorityState(), { kind: "fresh", contextKey: ctx.key });
	assert.equal(harness.value.paused, false);
	assert.equal(harness.value.slateSessionId, undefined);
	assert.deepEqual(backend.bindings, []);
	assert.deepEqual(harness.piSnapshots, []);
});

test("creation responses must preserve initial generation and active status", async (t) => {
	for (const [label, generation, status] of [
		["generation", 1, "active"],
		["status", 0, "abandoned"],
	] as const) {
		await t.test(label, () => {
			const harness = store();
			const backend = new FakeBackend();
			const ctx = context();
			backend.create = (options) => {
				backend.events.push("external-create");
				backend.current = record(ctx, binding({ identity: options.identity, name: options.name }), generation, options.runtime, status);
				return backend.current;
			};
			harness.value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
			const permit = harness.value.prepareMutation(ctx);
			assert.throws(() => harness.value.save(permit), /unexpected external generation or status after creation/);
			assert.equal(harness.value.authorityState().kind, "unavailable");
			assert.equal(backend.bindings.length, 0);
		});
	}
});

test("durable selection trusts current external generation and content over advisory Pi details", () => {
	const current = runtime({ paused: true, workerCostUsd: 7 });
	const harness = activeStore(current);
	assert.equal(harness.store.paused, true);
	assert.equal(harness.store.workerCostUsd, 7);
	assert.deepEqual(harness.store.authorityState(), {
		kind: "durable",
		contextKey: harness.context.key,
		binding: binding({ generation: 4 }),
		generation: 4,
	});
});

test("every authority selection clears state from the previous Pi context", () => {
	const harness = activeStore(runtime({ paused: true, workerCostUsd: 7 }));
	harness.store.slateSessionParentChain = [{ identity: ID, name: NAME }];
	let changes = 0;
	harness.store.onDidChange = () => { changes += 1; };
	const next = context({ key: "pi-session:legacy-branch" });
	harness.store.configureRuntimeAuthority({ kind: "legacy" }, next, harness.backend);
	assert.deepEqual(harness.store.authorityState(), { kind: "legacy" });
	assert.equal(harness.store.paused, false);
	assert.equal(harness.store.workerCostUsd, 0);
	assert.deepEqual(harness.store.slateSessionParentChain, []);
	assert.equal(harness.store.slateSessionId, undefined);
	assert.equal(changes, 1);
});

test("a legacy selection without a snapshot cannot reuse a prior context identity", () => {
	const harness = store();
	const backend = new FakeBackend();
	const first = context({ key: "pi-session:legacy-first" });
	harness.value.configureRuntimeAuthority({
		kind: "legacy",
		snapshot: {
			...runtime(),
			slateSessionId: ID,
			slateSessionName: NAME,
			ownerSessionDigest: OWNER,
		},
	}, first, backend, { cwd: first.cwd, hasUI: false } as unknown as ExtensionContext);
	const second = context({ key: "pi-session:legacy-second" });
	harness.value.configureRuntimeAuthority({ kind: "legacy" }, second, backend);
	const minted = harness.value.resolveSessionIdentity(OWNER, () => {}, () => OTHER_ID);
	assert.equal(minted, true);
	assert.equal(harness.value.slateSessionId, OTHER_ID);
	assert.notEqual(harness.value.slateSessionId, ID);
});

test("mutation permits remain drafts until an authorized save commits", () => {
	const harness = activeStore(runtime({ paused: false, workerCostUsd: 2 }));
	const permit = harness.store.prepareMutation(harness.context);
	permit.runtime.paused = true;
	permit.runtime.workerCostUsd = 3;
	assert.equal(harness.store.paused, false);
	assert.equal(harness.store.workerCostUsd, 2);
	assert.equal(harness.store.save(permit)?.kind, "committed");
	assert.equal(harness.store.paused, true);
	assert.equal(harness.store.workerCostUsd, 3);
});

test("mutation preparation revalidates external identity, owner, project, and current directory", async (t) => {
	const cases: ReadonlyArray<readonly [string, (value: RuntimeAuthorityExternalRecord) => void]> = [
		["identity", (value) => { (value.metadata as { identity: string }).identity = "20260827T120001Z-deadbeefdeadbeef"; }],
		["owner", (value) => { (value.state as { ownerSessionDigest: string }).ownerSessionDigest = "b".repeat(64); }],
		["project", (value) => { (value.metadata as { projectKey: string }).projectKey = "/foreign"; }],
		["current directory", (value) => { (value.metadata as { currentDirectory: string }).currentDirectory = "/foreign"; }],
	];
	for (const [label, mutate] of cases) {
		await t.test(label, () => {
			const harness = activeStore(runtime({ paused: true }));
			mutate(harness.backend.current!);
			assert.throws(() => harness.store.prepareMutation(harness.context), /mismatched|different project/);
			assert.equal(harness.store.authorityState().kind, "unavailable");
			assert.equal(harness.store.paused, false);
		});
	}
});

test("mutation preparation refuses a generation below the selected authority floor", () => {
	const harness = activeStore(runtime({ paused: true }));
	harness.backend.current = record(harness.context, binding(), 3, runtime({ paused: false }));
	assert.throws(
		() => harness.store.prepareMutation(harness.context),
		/older than the last validated generation/,
	);
	assert.equal(harness.store.authorityState().kind, "unavailable");
	assert.equal(harness.store.paused, false);
});

test("generation floors do not cross a legitimate Pi context selection", () => {
	const first = activeStore(runtime({ paused: true }));
	const nextContext = context({ key: "pi-session:branch-next" });
	first.backend.current = record(nextContext, binding(), 2, runtime({ paused: false, workerCostUsd: 3 }));
	first.store.configureRuntimeAuthority(
		{ kind: "durable", binding: binding({ generation: 2 }) },
		nextContext,
		first.backend,
	);
	assert.deepEqual(first.store.authorityState(), {
		kind: "durable",
		contextKey: nextContext.key,
		binding: binding({ generation: 2 }),
		generation: 2,
	});
	assert.equal(first.store.paused, false);
	assert.equal(first.store.workerCostUsd, 3);
});

test("a stale terminal reread cannot replace newer selected authority", () => {
	const harness = activeStore(runtime({ paused: false }));
	harness.backend.current = record(harness.context, binding(), 3, runtime({ paused: true }), "delivered");
	assert.throws(
		() => harness.store.prepareMutation(harness.context),
		/older than the last validated generation/,
	);
	assert.equal(harness.store.authorityState().kind, "unavailable");
	assert.equal(harness.store.paused, false);
});

test("mutation preparation accepts exact and newer valid active generations", async (t) => {
	await t.test("exact generation", () => {
		const harness = activeStore(runtime({ paused: true }));
		const permit = harness.store.prepareMutation(harness.context);
		assert.equal(permit.runtime.paused, true);
		const authority = harness.store.authorityState();
		assert.equal(authority.kind, "durable");
		if (authority.kind === "durable") assert.equal(authority.generation, 4);
	});

	await t.test("newer generation", () => {
		const harness = activeStore(runtime({ paused: false }));
		harness.backend.current = record(harness.context, binding(), 7, runtime({ paused: true }));
		const permit = harness.store.prepareMutation(harness.context);
		assert.equal(permit.runtime.paused, true);
		permit.runtime.workerCostUsd = 2;
		harness.store.save(permit);
		assert.equal(harness.backend.current?.state.generation, 8);
		const authority = harness.store.authorityState();
		assert.equal(authority.kind, "durable");
		if (authority.kind === "durable") assert.equal(authority.generation, 8);
	});
});

test("update responses must advance exactly once and remain active", async (t) => {
	for (const [label, generation, status] of [
		["generation", 6, "active"],
		["status", 5, "delivered"],
	] as const) {
		await t.test(label, () => {
			const harness = activeStore();
			harness.backend.update = (options) => {
				harness.backend.events.push("external-update");
				harness.backend.current = record(options.context, options.binding, generation, options.runtime, status);
				return harness.backend.current;
			};
			const permit = harness.store.prepareMutation(harness.context);
			permit.runtime.paused = true;
			assert.throws(() => harness.store.save(permit), /unexpected external generation or status after update/);
			assert.equal(harness.backend.bindings.length, 0);
			assert.notEqual(harness.store.authorityState().kind, "fresh");
		});
	}
});

test("external commit precedes every advisory binding update", () => {
	const harness = activeStore();
	harness.backend.events.length = 0;
	const permit = harness.store.prepareMutation(harness.context);
	permit.runtime.orchestratorMode = true;
	const result = harness.store.save(permit);
	assert.equal(result?.kind, "committed");
	assert.deepEqual(harness.backend.events, ["external-read", "external-update", "pi-binding"]);
	assert.equal(harness.backend.bindings.at(-1)?.generation, 5);
	assert.equal(harness.store.orchestratorMode, true);
});

test("a first Pi binding failure keeps the external commit and reports partial success", () => {
	const reports: string[] = [];
	const ctx = context({ report: (message) => reports.push(message) });
	const backend = new FakeBackend();
	backend.bindingError = new Error("Pi disk full");
	const harness = store();
	harness.value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
	const permit = harness.value.prepareMutation(ctx);
	permit.runtime.paused = true;
	const result = harness.value.save(permit);
	assert.equal(result?.kind, "partial");
	assert.equal(backend.current?.state.generation, 0);
	assert.equal(backend.current?.state.runtime.paused, true);
	assert.equal(harness.value.paused, true);
	assert.equal(harness.piSnapshots.length, 0);
	assert.match(reports.join("\n"), /committed external state.*advisory Pi binding.*Pi disk full/);
});

test("reporter and display throws do not reverse an external commit", () => {
	let harness: SlateStore;
	let inspectCommittedState = false;
	const reporterObservations: boolean[] = [];
	const observerObservations: boolean[] = [];
	const ctx = context({
		report: () => {
			if (inspectCommittedState) reporterObservations.push(harness.paused);
			throw new Error("reporter failed");
		},
	});
	const backend = new FakeBackend();
	backend.bindingError = new Error("Pi disk full");
	harness = store().value;
	harness.onDidChange = () => {
		if (inspectCommittedState) observerObservations.push(harness.paused);
		throw new Error("display failed");
	};
	harness.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
	const permit = harness.prepareMutation(ctx);
	permit.runtime.paused = true;
	inspectCommittedState = true;
	const result = harness.save(permit);
	assert.equal(result?.kind, "partial");
	assert.equal(backend.current?.state.runtime.paused, true);
	assert.deepEqual(observerObservations, [true]);
	assert.deepEqual(reporterObservations, [true, true]);
	assert.equal(harness.paused, true);
	assert.equal(harness.authorityState().kind, "durable");
});

test("a late external update failure reconciles authority or becomes unavailable", async (t) => {
	await t.test("successful reconciliation", () => {
		const harness = activeStore();
		const permit = harness.store.prepareMutation(harness.context);
		permit.runtime.paused = true;
		permit.runtime.workerCostUsd = 9;
		harness.backend.update = (options) => {
			harness.backend.events.push("external-update");
			harness.backend.current = record(options.context, options.binding, 6, options.runtime);
			throw new Error("late update failure");
		};
		assert.throws(() => harness.store.save(permit), /late update failure/);
		assert.equal(harness.store.paused, true);
		assert.equal(harness.store.workerCostUsd, 9);
		const authority = harness.store.authorityState();
		assert.equal(authority.kind, "durable");
		if (authority.kind === "durable") assert.equal(authority.generation, 6);
	});

	await t.test("stale reconciliation", () => {
		const harness = activeStore(runtime({ paused: true }));
		const permit = harness.store.prepareMutation(harness.context);
		harness.backend.update = (options) => {
			harness.backend.events.push("external-update");
			harness.backend.current = record(options.context, options.binding, 3, runtime({ paused: false }));
			throw new Error("late stale update failure");
		};
		assert.throws(() => harness.store.save(permit), /late stale update failure/);
		assert.equal(harness.store.authorityState().kind, "unavailable");
		assert.equal(harness.store.paused, false);
	});

	await t.test("failed reconciliation", () => {
		const harness = activeStore(runtime({ paused: true }));
		const permit = harness.store.prepareMutation(harness.context);
		harness.backend.update = (options) => {
			harness.backend.events.push("external-update");
			harness.backend.current = record(options.context, options.binding, 5, options.runtime);
			throw new Error("late update failure");
		};
		harness.backend.readError = new Error("recovery read failed");
		assert.throws(() => harness.store.save(permit), /late update failure/);
		assert.equal(harness.store.authorityState().kind, "unavailable");
		assert.equal(harness.store.paused, false);
		assert.equal(harness.store.threads.size, 0);
	});
});

test("ordinary external failure restores a deep committed baseline", () => {
	const original = runtime({
		threads: [{
			id: "t1", name: "original", sessionFile: "", status: "idle", tools: ["read"],
			episodeIds: [], episodeSeq: 0, createdAt: 1, updatedAt: 1,
		}],
		threadSeq: 1,
	});
	const harness = activeStore(original);
	const permit = harness.store.prepareMutation(harness.context);
	permit.runtime.threads[0]!.name = "candidate";
	permit.runtime.threads[0]!.tools![0] = "write";
	harness.store.threads.get("t1")!.name = "leaked live mutation";
	harness.store.threads.get("t1")!.tools![0] = "leaked live tool mutation";
	harness.backend.updateError = new Error("external write failed");
	assert.throws(() => harness.store.save(permit), /external write failed/);
	assert.equal(harness.store.threads.get("t1")?.name, "original");
	assert.deepEqual(harness.store.threads.get("t1")?.tools, ["read"]);
	assert.equal(harness.backend.current?.state.runtime.threads[0]?.name, "original");
});

test("foreign, stale, and old-context permits are refused", () => {
	const harness = activeStore();
	const stale = harness.store.prepareMutation(harness.context);
	const winner = harness.store.prepareMutation(harness.context);
	winner.runtime.paused = true;
	harness.store.save(winner);
	assert.throws(() => harness.store.save(stale), /stale mutation permit/);

	const other = activeStore();
	const foreign = other.store.prepareMutation(other.context);
	assert.throws(() => harness.store.save(foreign), /foreign mutation permit/);
	assert.throws(
		() => harness.store.prepareMutation(context({ key: "another-branch" })),
		/stale or foreign Pi context/,
	);

	const beforeSwitch = other.store.prepareMutation(other.context);
	const switched = context({ key: "pi-session:branch-other" });
	other.store.configureRuntimeAuthority({ kind: "fresh" }, switched, other.backend);
	assert.throws(() => other.store.save(beforeSwitch), /stale mutation permit/);
});

test("a field-identical A-to-B-to-A switch rejects the first selection context", () => {
	const firstA = context();
	const backend = new FakeBackend();
	backend.current = record(firstA, binding(), 4, runtime());
	const value = store().value;
	value.configureRuntimeAuthority({ kind: "durable", binding: binding() }, firstA, backend);
	const b = context({ key: "pi-session:branch-b" });
	value.configureRuntimeAuthority({ kind: "fresh" }, b, backend);
	const secondA = context();
	backend.current = record(secondA, binding(), 4, runtime());
	value.configureRuntimeAuthority({ kind: "durable", binding: binding() }, secondA, backend);
	assert.throws(() => value.prepareMutation(firstA), /stale or foreign Pi context/);
	const current = value.prepareMutation(secondA);
	current.runtime.paused = true;
	assert.equal(value.save(current)?.kind, "committed");
	assert.equal(value.paused, true);
});

test("the identical context object cannot revive a permit after an A-to-B-to-A reselection", () => {
	const a = context();
	const backend = new FakeBackend();
	backend.current = record(a, binding(), 4, runtime());
	const value = store().value;
	value.configureRuntimeAuthority({ kind: "durable", binding: binding() }, a, backend);
	const oldPermit = value.prepareMutation(a);
	value.configureRuntimeAuthority({ kind: "fresh" }, context({ key: "pi-session:branch-b" }), backend);
	backend.current = record(a, binding(), 4, runtime());
	value.configureRuntimeAuthority({ kind: "durable", binding: binding() }, a, backend);
	assert.throws(() => value.save(oldPermit), /stale mutation permit/);
	const current = value.prepareMutation(a);
	current.runtime.paused = true;
	assert.equal(value.save(current)?.kind, "committed");
	assert.equal(value.paused, true);
});

test("nested transactions cannot mint or publish a second namespace", () => {
	const harness = store();
	const backend = new FakeBackend();
	const ctx = context();
	harness.value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
	const outer = harness.value.prepareMutation(ctx);
	const nested = harness.value.prepareMutation(ctx);
	outer.runtime.paused = true;
	let outcomes: boolean[] = [];
	backend.onMint = () => {
		outcomes = [() => harness.value.save(nested), () => harness.value.prepareMutation(ctx)].map((attempt) => {
			try {
				attempt();
				return false;
			} catch (error) {
				return error instanceof Error && /nested runtime transaction/.test(error.message);
			}
		});
	};
	const result = harness.value.save(outer);
	assert.deepEqual(outcomes, [true, true]);
	assert.equal(result?.kind, "committed");
	assert.throws(() => harness.value.save(nested), /stale mutation permit/);
	assert.equal(backend.events.filter((event) => event === "external-create").length, 1);
	assert.equal(backend.bindings.length, 1);
});

test("every authority backend boundary refuses reentrant selection and mutation", async (t) => {
	const observe = (
		observations: boolean[][],
		value: SlateStore,
		ctx: RuntimeAuthorityContext,
		backend: RuntimeAuthorityBackend,
	): void => {
		observations.push(runtimeReentryOutcomes(value, ctx, backend));
	};
	const assertObserved = (observations: boolean[][], count: number): void => {
		assert.equal(observations.length, count);
		assert.equal(observations.flat().every(Boolean), true);
	};

	await t.test("selection read", () => {
		const observations: boolean[][] = [];
		const ctx = context();
		const backend = new FakeBackend();
		backend.current = record(ctx, binding(), 4, runtime());
		const value = store().value;
		backend.onRead = () => observe(observations, value, ctx, backend);
		value.configureRuntimeAuthority({ kind: "durable", binding: binding() }, ctx, backend);
		assertObserved(observations, 1);
		assert.equal(value.authorityState().kind, "durable");
	});

	await t.test("preparation read", () => {
		const observations: boolean[][] = [];
		const harness = activeStore();
		harness.backend.onRead = () => observe(observations, harness.store, harness.context, harness.backend);
		assert.doesNotThrow(() => harness.store.prepareMutation(harness.context));
		assertObserved(observations, 1);
	});

	await t.test("mint, create, and advisory binding", () => {
		const observations: boolean[][] = [];
		const ctx = context();
		const backend = new FakeBackend();
		const value = store().value;
		value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
		const permit = value.prepareMutation(ctx);
		const observeBoundary = () => observe(observations, value, ctx, backend);
		backend.onMint = observeBoundary;
		backend.onCreate = observeBoundary;
		backend.onWriteBinding = observeBoundary;
		assert.equal(value.save(permit)?.kind, "committed");
		assertObserved(observations, 3);
	});

	await t.test("update and advisory binding", () => {
		const observations: boolean[][] = [];
		const harness = activeStore();
		const permit = harness.store.prepareMutation(harness.context);
		const observeBoundary = () => observe(observations, harness.store, harness.context, harness.backend);
		harness.backend.onUpdate = observeBoundary;
		harness.backend.onWriteBinding = observeBoundary;
		assert.equal(harness.store.save(permit)?.kind, "committed");
		assertObserved(observations, 2);
	});

	await t.test("uncertainty classification and storage reread", () => {
		const observations: boolean[][] = [];
		const harness = activeStore();
		const permit = harness.store.prepareMutation(harness.context);
		const uncertain = new Error("uncertain boundary");
		harness.backend.updateError = uncertain;
		harness.backend.uncertain.add(uncertain);
		harness.backend.current = record(harness.context, binding(), 5, runtime());
		const observeBoundary = () => observe(observations, harness.store, harness.context, harness.backend);
		harness.backend.onIsCommitUncertain = observeBoundary;
		harness.backend.onRead = observeBoundary;
		assert.equal(harness.store.save(permit)?.kind, "committed");
		assertObserved(observations, 2);
	});

	await t.test("conflict classification and restoration read", () => {
		const observations: boolean[][] = [];
		const harness = activeStore();
		const permit = harness.store.prepareMutation(harness.context);
		harness.backend.updateError = new DurableRevisionConflict("generation", "conflict boundary");
		harness.backend.current = record(harness.context, binding(), 5, runtime({ workerCostUsd: 2 }));
		const observeBoundary = () => observe(observations, harness.store, harness.context, harness.backend);
		harness.backend.onIsRevisionConflict = observeBoundary;
		harness.backend.onRead = observeBoundary;
		assert.throws(() => harness.store.save(permit), /conflict boundary/);
		assertObserved(observations, 2);
		assert.equal(harness.store.workerCostUsd, 2);
	});
});

test("context replacement is refused while an external update is active", () => {
	const harness = activeStore(runtime({ paused: true }));
	const permit = harness.store.prepareMutation(harness.context);
	permit.runtime.workerCostUsd = 9;
	const next = context({ key: "pi-session:branch-next" });
	let replacementRefused = false;
	harness.backend.onUpdate = () => {
		try {
			harness.store.configureRuntimeAuthority({ kind: "fresh" }, next, harness.backend);
		} catch (error) {
			replacementRefused = error instanceof Error && /nested runtime transaction/.test(error.message);
		}
	};
	const result = harness.store.save(permit);
	assert.equal(replacementRefused, true);
	assert.equal(result?.kind, "committed");
	assert.equal(harness.store.workerCostUsd, 9);
	assert.equal(harness.backend.bindings.length, 1);
});

test("a revision conflict installs validated current external authority before returning", () => {
	const harness = activeStore(runtime({ paused: false }));
	const permit = harness.store.prepareMutation(harness.context);
	permit.runtime.paused = true;
	const conflict = new DurableRevisionConflict("generation", "generation changed");
	harness.backend.updateError = conflict;
	harness.backend.onUpdate = () => {
		harness.backend.current = record(harness.context, binding(), 8, runtime({ paused: false, workerCostUsd: 11 }));
	};
	assert.throws(() => harness.store.save(permit), /generation changed/);
	assert.equal(harness.store.paused, false);
	assert.equal(harness.store.workerCostUsd, 11);
	const authority = harness.store.authorityState();
	assert.equal(authority.kind, "durable");
	if (authority.kind === "durable") assert.equal(authority.generation, 8);
});

test("an unresolvable revision conflict enters unavailable state and clears visible state", () => {
	const reports: string[] = [];
	const ctx = context({ report: (message) => reports.push(message) });
	const backend = new FakeBackend();
	backend.current = record(ctx, binding(), 1, runtime({ paused: true }));
	const harness = store().value;
	harness.configureRuntimeAuthority({ kind: "durable", binding: binding() }, ctx, backend);
	const permit = harness.prepareMutation(ctx);
	backend.updateError = new DurableRevisionConflict("generation", "generation changed");
	backend.onUpdate = () => { backend.readError = new Error("corrupt authority"); };
	assert.throws(() => harness.save(permit), /generation changed/);
	assert.equal(harness.authorityState().kind, "unavailable");
	assert.equal(harness.paused, false);
	assert.equal(harness.threads.size, 0);
	assert.match(reports.join("\n"), /could not restore authority after a revision conflict/);
});

test("a valid uncertain commit aligns memory with external storage reread", () => {
	const harness = activeStore();
	const permit = harness.store.prepareMutation(harness.context);
	permit.runtime.paused = true;
	const uncertain = new Error("durability uncertain");
	harness.backend.updateError = uncertain;
	harness.backend.uncertain.add(uncertain);
	harness.backend.current = record(harness.context, binding(), 5, runtime({ paused: true, workerCostUsd: 3 }));
	const result = harness.store.save(permit);
	assert.equal(result?.kind, "committed");
	assert.equal(harness.store.paused, true);
	assert.equal(harness.store.workerCostUsd, 3);
	const authority = harness.store.authorityState();
	assert.equal(authority.kind, "durable");
	if (authority.kind === "durable") assert.equal(authority.generation, 5);
});

test("an uncertain update restores a valid newer active external generation", () => {
	const harness = activeStore();
	const permit = harness.store.prepareMutation(harness.context);
	const uncertain = new Error("uncertain newer generation");
	harness.backend.updateError = uncertain;
	harness.backend.uncertain.add(uncertain);
	harness.backend.current = record(harness.context, binding(), 6, runtime({ paused: true, workerCostUsd: 12 }));
	const result = harness.store.save(permit);
	assert.equal(result?.kind, "committed");
	assert.equal(result?.binding.generation, 6);
	assert.equal(harness.store.paused, true);
	assert.equal(harness.store.workerCostUsd, 12);
	assert.deepEqual(harness.store.authorityState(), {
		kind: "durable",
		contextKey: harness.context.key,
		binding: binding({ generation: 6 }),
		generation: 6,
	});
});

test("uncertain updates reject stale and terminal storage rereads", async (t) => {
	for (const [label, generation, status] of [
		["stale generation", 4, "active"],
		["terminal status", 5, "abandoned"],
	] as const) {
		await t.test(label, () => {
			const harness = activeStore();
			const permit = harness.store.prepareMutation(harness.context);
			const uncertain = new Error(`uncertain ${label}`);
			harness.backend.updateError = uncertain;
			harness.backend.uncertain.add(uncertain);
			harness.backend.current = record(harness.context, binding(), generation, runtime({ paused: true }), status);
			assert.throws(() => harness.store.save(permit), new RegExp(`uncertain ${label}`));
			assert.equal(harness.store.authorityState().kind, "unavailable");
			assert.equal(harness.store.paused, false);
			assert.equal(harness.backend.bindings.length, 0);
		});
	}
});

test("an uncertain first publication without valid reconciliation becomes unavailable", async (t) => {
	for (const [label, reconciled] of [
		["missing record", undefined],
		["terminal record", record(context(), binding(), 0, runtime({ paused: true }), "abandoned")],
	] as const) {
		await t.test(label, () => {
			const harness = store();
			const backend = new FakeBackend();
			const ctx = context();
			harness.value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
			const permit = harness.value.prepareMutation(ctx);
			permit.runtime.paused = true;
			const uncertain = new Error(`creation uncertain: ${label}`);
			backend.createError = uncertain;
			backend.uncertain.add(uncertain);
			backend.current = reconciled;
			assert.throws(() => harness.value.save(permit), /creation uncertain/);
			assert.equal(harness.value.authorityState().kind, "unavailable");
			assert.equal(harness.value.paused, false);
			assert.equal(backend.bindings.length, 0);
		});
	}
});

test("a valid uncertain first publication establishes only its reconciled namespace", () => {
	const harness = store();
	const backend = new FakeBackend();
	const ctx = context();
	const permit = (() => {
		harness.value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
		return harness.value.prepareMutation(ctx);
	})();
	permit.runtime.paused = true;
	const uncertain = new Error("creation durability uncertain");
	backend.createError = uncertain;
	backend.uncertain.add(uncertain);
	backend.current = record(ctx, binding(), 2, runtime({ paused: true }));
	const result = harness.value.save(permit);
	assert.equal(result?.kind, "committed");
	assert.equal(result?.binding.generation, 2);
	assert.equal(harness.value.authorityState().kind, "durable");
	assert.equal(harness.value.paused, true);
	assert.equal(backend.events.filter((event) => event === "external-create").length, 1);
	assert.equal(backend.bindings.length, 1);
});

test("an uncertain commit without a valid reconciled record becomes unavailable", () => {
	const harness = activeStore(runtime({ paused: true }));
	const permit = harness.store.prepareMutation(harness.context);
	const uncertain = new Error("durability uncertain without record");
	harness.backend.updateError = uncertain;
	harness.backend.uncertain.add(uncertain);
	assert.throws(() => harness.store.save(permit), /durability uncertain/);
	assert.equal(harness.store.authorityState().kind, "unavailable");
	assert.equal(harness.store.paused, false);
});

test("a refused classification enters unavailable state without storage access", () => {
	const harness = store();
	const backend = new FakeBackend();
	const ctx = context();
	harness.value.paused = true;
	harness.value.configureRuntimeAuthority(
		{ kind: "refused", reason: "mixed-authority", message: "slate refused mixed authority" },
		ctx,
		backend,
	);
	assert.deepEqual(harness.value.authorityState(), {
		kind: "unavailable",
		contextKey: ctx.key,
		message: "slate refused mixed authority",
	});
	assert.equal(harness.value.paused, false);
	assert.deepEqual(backend.events, []);
});

test("failed updates expose installed terminal authority inside the observer callback", () => {
	const harness = activeStore(runtime({ paused: false }));
	let changes = 0;
	let inspectTerminal = false;
	let observedAuthority: ReturnType<SlateStore["authorityState"]> | undefined;
	let observedPaused: boolean | undefined;
	harness.store.onDidChange = () => {
		changes += 1;
		if (!inspectTerminal) return;
		observedAuthority = harness.store.authorityState();
		observedPaused = harness.store.paused;
	};
	const permit = harness.store.prepareMutation(harness.context);
	changes = 0;
	inspectTerminal = true;
	harness.backend.updateError = new DurableRevisionConflict("terminal", "authority became terminal");
	harness.backend.onUpdate = () => {
		harness.backend.current = record(harness.context, binding(), 5, runtime({ paused: true }), "abandoned");
	};
	assert.throws(() => harness.store.save(permit), /authority became terminal/);
	const expectedAuthority = {
		kind: "terminal" as const,
		contextKey: harness.context.key,
		binding: binding({ generation: 5 }),
		generation: 5,
		status: "abandoned" as const,
	};
	assert.deepEqual(observedAuthority, expectedAuthority);
	assert.equal(observedPaused, true);
	assert.deepEqual(harness.store.authorityState(), expectedAuthority);
	assert.equal(harness.store.paused, true);
	assert.equal(changes, 1);
});

test("terminal and unavailable authority refuse mutation without fallback", () => {
	const terminalContext = context();
	const terminalBackend = new FakeBackend();
	terminalBackend.current = record(terminalContext, binding(), 9, runtime({ paused: true }), "delivered");
	const terminal = store().value;
	terminal.configureRuntimeAuthority({ kind: "durable", binding: binding() }, terminalContext, terminalBackend);
	assert.equal(terminal.authorityState().kind, "terminal");
	assert.throws(() => terminal.prepareMutation(terminalContext), /delivered terminal authority/);

	const raced = activeStore();
	let racedChanges = 0;
	raced.store.onDidChange = () => { racedChanges += 1; };
	raced.backend.current = record(raced.context, binding(), 10, runtime({ paused: true }), "abandoned");
	assert.throws(() => raced.store.prepareMutation(raced.context), /abandoned terminal authority/);
	assert.equal(raced.store.authorityState().kind, "terminal");
	assert.equal(racedChanges, 1);

	const unavailableContext = context({ key: "missing" });
	const unavailableBackend = new FakeBackend();
	unavailableBackend.readError = new Error("missing namespace");
	const unavailable = store().value;
	unavailable.paused = true;
	unavailable.configureRuntimeAuthority({ kind: "durable", binding: binding() }, unavailableContext, unavailableBackend);
	assert.equal(unavailable.authorityState().kind, "unavailable");
	assert.equal(unavailable.paused, false);
	assert.throws(() => unavailable.prepareMutation(unavailableContext), /could not establish current external authority/);
});

test("concurrent first-mutation permits publish one namespace and preserve winner state", () => {
	const harness = store();
	const backend = new FakeBackend();
	const ctx = context();
	harness.value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
	const winner = harness.value.prepareMutation(ctx);
	const loser = harness.value.prepareMutation(ctx);
	winner.runtime.paused = true;
	loser.runtime.workerCostUsd = 99;
	harness.value.save(winner);
	assert.throws(() => harness.value.save(loser), /stale mutation permit/);
	assert.equal(backend.events.filter((event) => event === "external-create").length, 1);
	assert.equal(harness.value.paused, true);
	assert.equal(harness.value.workerCostUsd, 0);
	assert.equal(backend.current?.state.runtime.workerCostUsd, 0);
});

test("legacy classification can adopt its validated snapshot without durable writes", () => {
	const harness = store();
	const backend = new FakeBackend();
	const ctx = context();
	const legacy = {
		threads: [], episodes: [], threadSeq: 0, orchestratorMode: true, paused: false,
		workerCostUsd: 2, carriedCostUsd: 0,
	};
	harness.value.configureRuntimeAuthority(
		{ kind: "legacy", snapshot: legacy },
		ctx,
		backend,
		{ cwd: ctx.cwd, hasUI: false } as unknown as ExtensionContext,
	);
	assert.equal(harness.value.authorityState().kind, "legacy");
	assert.equal(harness.value.orchestratorMode, true);
	harness.value.save();
	assert.deepEqual(harness.piSnapshots, ["slate-state"]);
	assert.deepEqual(backend.events, []);
});

test("new-policy authority refuses every Pi snapshot restore path", () => {
	const harness = activeStore(runtime({ paused: true }));
	const extensionContext = {
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
		},
	} as unknown as ExtensionContext;
	assert.throws(() => harness.store.restore(extensionContext), /Pi snapshot restore/);
	assert.equal(harness.store.paused, true);
	assert.equal(harness.store.authorityState().kind, "durable");
});

test("revision conflict classification is structural instead of message-based", () => {
	const backend = createRuntimeAuthorityBackend({ appendEntry() {} } as unknown as ExtensionAPI);
	assert.equal(backend.isRevisionConflict(new DurableRevisionConflict("terminal", "words may change")), true);
	assert.equal(backend.isRevisionConflict(new Error("generation mismatch and state modified during replacement")), false);
});

test("caller-created uncertainty records never replace actual external authority", () => {
	const root = mkdtempSync(join(tmpdir(), "slate-runtime-authority-forgery-test-"));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const corpus = resolveCorpusProject(cwd);
		const ctx = createRuntimeAuthorityContext({ key: "real:forgery", cwd, ownerSessionDigest: OWNER, project: corpus });
		let attack = false;
		const forged = record(ctx, binding(), 1, runtime({ paused: true }));
		const backend = createRuntimeAuthorityBackend(
			{ appendEntry() {} } as unknown as ExtensionAPI,
			{
				mint: () => ({ identity: ID, name: NAME }),
				durable: {
					drawStateNonce() {
						if (attack) {
							throw new DurableCommitUncertain(
								"update",
								forged as unknown as ConstructorParameters<typeof DurableCommitUncertain>[1],
								new Error("forged uncertainty"),
							);
						}
						return "0".repeat(16);
					},
				},
			},
		);
		const value = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
		value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
		value.save(value.prepareMutation(ctx));
		const candidate = value.prepareMutation(ctx);
		candidate.runtime.paused = true;
		attack = true;
		assert.throws(() => value.save(candidate), /directory synchronization is uncertain/);
		assert.equal(value.authorityState().kind, "unavailable");
		const actual = readDurableSession({ project: corpus, name: NAME, identity: ID, cwd });
		assert.equal(actual.state.generation, 0);
		assert.equal(actual.state.runtime.paused, false);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("the production adapter creates external authority before its Pi binding", () => {
	const root = mkdtempSync(join(tmpdir(), "slate-runtime-authority-test-"));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const appended: Array<{ type: string; data: Record<string, unknown> }> = [];
		const pi = {
			appendEntry(type: string, data: Record<string, unknown>) { appended.push({ type, data }); },
		} as unknown as ExtensionAPI;
		const corpus = resolveCorpusProject(cwd);
		const ctx = createRuntimeAuthorityContext({ key: "real:main", cwd, ownerSessionDigest: OWNER, project: corpus });
		const backend = createRuntimeAuthorityBackend(pi, { mint: () => ({ identity: ID, name: NAME }) });
		const value = new SlateStore(pi);
		value.configureRuntimeAuthority({ kind: "fresh" }, ctx, backend);
		const permit = value.prepareMutation(ctx);
		permit.runtime.paused = true;
		const result = value.save(permit);
		assert.equal(result?.kind, "committed");
		assert.deepEqual(appended.map((item) => item.type), ["slate-binding"]);
		assert.equal(appended[0]?.data.generation, 0);
		assert.equal(value.authorityState().kind, "durable");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
