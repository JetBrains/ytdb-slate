import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { resolveCorpusProject, type CorpusProject } from "../extension/corpus.ts";
import {
	completeDurableHandoff,
	durableHandoffReference,
	parseDurableHandoffReference,
	recoverDurableHandoff,
	type DurableHandoffOptions,
} from "../extension/durable-handoff.ts";
import {
	closeDurableSession,
	createDurableSession,
	DurableCommitUncertain,
	readDurableSession,
	updateDurableSession,
	type CanonicalSlateRuntime,
} from "../extension/session-record.ts";

const ID = "20260828T120000Z-0123abcd0123abcd";
const OTHER_ID = "20260828T120001Z-deadbeefdeadbeef";
const NAME = "calm-otter-7f3a";
const OTHER_NAME = "brisk-bison-abcd";
const SOURCE = "a".repeat(64);
const RECIPIENT = "b".repeat(64);
const RIVAL = "c".repeat(64);

function runtime(overrides: Partial<CanonicalSlateRuntime> = {}): CanonicalSlateRuntime {
	return {
		threads: [],
		episodes: [],
		threadSeq: 0,
		slateSessionParentChain: [],
		orchestratorMode: true,
		paused: true,
		workerCostUsd: 3,
		carriedCostUsd: 1,
		...overrides,
	};
}

interface Workspace {
	root: string;
	cwd: string;
	agent: string;
	project: CorpusProject;
	close(): void;
}

function workspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "slate-durable-handoff."));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	const project = resolveCorpusProject(cwd, "handoff");
	return {
		root,
		cwd,
		agent,
		project,
		close() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function create(box: Workspace, options: { identity?: string; name?: string; value?: CanonicalSlateRuntime } = {}) {
	return createDurableSession({
		project: box.project,
		cwd: box.cwd,
		identity: options.identity ?? ID,
		name: options.name ?? NAME,
		creatorSessionDigest: SOURCE,
		runtime: options.value ?? runtime(),
		now: new Date("2026-08-28T12:00:00.000Z"),
	});
}

function handoffOptions(
	box: Workspace,
	recipientState: CanonicalSlateRuntime,
	overrides: Partial<DurableHandoffOptions> = {},
): DurableHandoffOptions {
	const record = readDurableSession({ project: box.project, name: NAME, identity: ID, cwd: box.cwd });
	return {
		project: box.project,
		cwd: box.cwd,
		reference: durableHandoffReference(record),
		recipientSessionDigest: RECIPIENT,
		recipientState,
		...overrides,
	};
}

function materializeArtifacts(directory: string): CanonicalSlateRuntime {
	writeFileSync(join(directory, "threads", "t1.jsonl"), "{}\n");
	writeFileSync(join(directory, "episodes", "t1.e1.md"), "episode\n");
	return runtime({
		threads: [{
			id: "t1",
			name: "durable thread",
			status: "successful",
			type: "general",
			episodeId: "t1.e1",
			createdAt: 1,
			updatedAt: 2,
		}],
		episodes: [{
			id: "t1.e1",
			threadId: "t1",
			task: "persist",
			status: "ok",
			file: join(directory, "episodes", "t1.e1.md"),
			createdAt: 3,
		}],
		threadSeq: 1,
		workerCostUsd: 7,
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) return;
		await delay(20);
	}
	throw new Error(`timed out waiting for ${path}`);
}

test("handoff completion saves recipient state and returns a structural read-back", () => {
	const box = workspace();
	try {
		const created = create(box);
		const recipientState = materializeArtifacts(created.directory);
		const result = completeDurableHandoff(handoffOptions(box, recipientState));
		assert.equal(result.kind, "complete");
		assert.deepEqual(result.binding, { policy: "durable-session-v1", identity: ID, name: NAME });
		assert.deepEqual(result.record.state.runtime, recipientState);
		assert.equal(result.record.state.lastWriterSessionDigest, RECIPIENT);
		assert.equal(readFileSync(join(created.directory, "threads", "t1.jsonl"), "utf8"), "{}\n");
		assert.equal(readFileSync(join(created.directory, "episodes", "t1.e1.md"), "utf8"), "episode\n");
		assert.deepEqual(
			readDurableSession({ project: box.project, name: NAME, identity: ID, cwd: box.cwd }),
			result.record,
		);
	} finally {
		box.close();
	}
});

test("handoff references contain only stable namespace identity", () => {
	const value = { policy: "durable-session-v1", identity: ID, name: NAME } as const;
	assert.deepEqual(parseDurableHandoffReference(value), value);
	for (const invalid of [
		null,
		{ ...value, policy: "legacy" },
		{ ...value, identity: "bad" },
		{ ...value, name: "bad/name" },
		{ ...value, generation: 1 },
		{ ...value, ownerSessionDigest: SOURCE },
	]) assert.equal(parseDurableHandoffReference(invalid), undefined);
});

test("public handoff completion rejects a malformed reference before saving", () => {
	const box = workspace();
	try {
		const created = create(box);
		const before = readFileSync(join(created.directory, "state.json"));
		assert.throws(() => completeDurableHandoff(handoffOptions(box, runtime(), {
			reference: { policy: "durable-session-v1", identity: "bad", name: NAME },
		})), /malformed or unsupported durable handoff reference/);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
	} finally {
		box.close();
	}
});

test("public handoff completion rejects invalid recipient session provenance before saving", () => {
	const box = workspace();
	try {
		const created = create(box);
		const before = readFileSync(join(created.directory, "state.json"));
		assert.throws(() => completeDurableHandoff(handoffOptions(box, runtime(), {
			recipientSessionDigest: "bad",
		})), /invalid recipient session provenance/);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
	} finally {
		box.close();
	}
});

test("malformed recipient state and incomplete saved data are rejected without replacement", () => {
	const box = workspace();
	try {
		const created = create(box);
		const before = readFileSync(join(created.directory, "state.json"));
		assert.throws(() => completeDurableHandoff(handoffOptions(box, {
			...runtime(),
			threads: [null as unknown as CanonicalSlateRuntime["threads"][number]],
		})), /thread 0 is not an object/);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
		rmSync(join(created.directory, "threads"), { recursive: true });
		assert.throws(() => completeDurableHandoff(handoffOptions(box, runtime())), /incomplete.*namespace/);
	} finally {
		box.close();
	}
});

test("different durable sessions remain isolated", () => {
	const box = workspace();
	try {
		create(box);
		create(box, { identity: OTHER_ID, name: OTHER_NAME, value: runtime({ workerCostUsd: 9 }) });
		const first = completeDurableHandoff(handoffOptions(box, runtime({ workerCostUsd: 4 })));
		assert.equal(first.record.metadata.identity, ID);
		assert.equal(readDurableSession({ project: box.project, name: OTHER_NAME }).state.runtime.workerCostUsd, 9);
		assert.throws(() => completeDurableHandoff(handoffOptions(box, runtime(), {
			reference: { policy: "durable-session-v1", identity: OTHER_ID, name: NAME },
		})), /identity mismatch/);
	} finally {
		box.close();
	}
});

test("writer provenance and terminal history do not block a later handoff", () => {
	const box = workspace();
	try {
		create(box);
		closeDurableSession({
			project: box.project,
			cwd: box.cwd,
			identity: ID,
			name: NAME,
			writerSessionDigest: RIVAL,
			outcome: "delivered",
			now: new Date("2026-08-28T13:00:00.000Z"),
		});
		const recipientState = runtime({ paused: false, workerCostUsd: 11 });
		const result = completeDurableHandoff(handoffOptions(box, recipientState));
		assert.equal(result.record.state.status, "delivered");
		assert.equal(result.record.state.lastWriterSessionDigest, RECIPIENT);
		assert.deepEqual(result.record.state.runtime, recipientState);
	} finally {
		box.close();
	}
});

test("recipient input changes during one handoff cannot alter the decoded candidate", () => {
	const box = workspace();
	try {
		create(box);
		const recipientState = runtime({ workerCostUsd: 5 });
		const result = completeDurableHandoff(handoffOptions(box, recipientState, {
			hooks: {
				beforeStatePublish() {
					recipientState.workerCostUsd = 99;
				},
			},
		}));
		assert.equal(result.record.state.runtime.workerCostUsd, 5);
		assert.equal(recipientState.workerCostUsd, 99);
	} finally {
		box.close();
	}
});

test("valid same-session writes are not rejected or conflict-resolved", () => {
	const box = workspace();
	try {
		create(box);
		const rivalState = runtime({ workerCostUsd: 8 });
		const result = completeDurableHandoff(handoffOptions(box, runtime({ workerCostUsd: 6 }), {
			hooks: {
				afterStatePublish() {
					updateDurableSession({
						project: box.project,
						cwd: box.cwd,
						identity: ID,
						name: NAME,
						writerSessionDigest: RIVAL,
						runtime: rivalState,
					});
				},
			},
		}));
		assert.deepEqual(result.record.state.runtime, rivalState);
		assert.equal(result.record.state.lastWriterSessionDigest, RIVAL);
	} finally {
		box.close();
	}
});

test("a pre-publication interruption leaves the prior state for sequential recovery", () => {
	const box = workspace();
	try {
		create(box);
		const recipientState = runtime({ workerCostUsd: 12 });
		assert.throws(() => completeDurableHandoff(handoffOptions(box, recipientState, {
			hooks: { beforeStatePublish() { throw new Error("interrupted before save"); } },
		})), (error: unknown) => error instanceof Error
			&& error.cause instanceof Error
			&& /interrupted before save/.test(error.cause.message));
		assert.equal(readDurableSession({ project: box.project, name: NAME }).state.runtime.workerCostUsd, 3);
		const recovered = recoverDurableHandoff(handoffOptions(box, recipientState));
		assert.deepEqual(recovered.record.state.runtime, recipientState);
	} finally {
		box.close();
	}
});

test("a post-publication interruption preserves saved data for sequential recovery", () => {
	const box = workspace();
	try {
		create(box);
		const recipientState = runtime({ workerCostUsd: 13 });
		let caught: unknown;
		try {
			completeDurableHandoff(handoffOptions(box, recipientState, {
				hooks: { afterStatePublish() { throw new Error("interrupted after save"); } },
			}));
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof DurableCommitUncertain);
		assert.deepEqual(readDurableSession({ project: box.project, name: NAME }).state.runtime, recipientState);
		const recovered = recoverDurableHandoff(handoffOptions(box, recipientState));
		assert.deepEqual(recovered.record.state.runtime, recipientState);
	} finally {
		box.close();
	}
});

test("a terminated handoff process leaves state that a later caller-controlled retry can save", { timeout: 8_000 }, async () => {
	const box = workspace();
	let child: ChildProcess | undefined;
	try {
		create(box);
		const barrier = join(box.root, "published");
		const script = join(box.root, "child.mjs");
		const moduleUrl = new URL("../extension/durable-handoff.ts", import.meta.url).href;
		const corpusUrl = new URL("../extension/corpus.ts", import.meta.url).href;
		const recipientState = runtime({ workerCostUsd: 21 });
		writeFileSync(script, `
import { writeFileSync } from "node:fs";
import { completeDurableHandoff } from ${JSON.stringify(moduleUrl)};
import { resolveCorpusProject } from ${JSON.stringify(corpusUrl)};
process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(box.agent)};
const cwd = ${JSON.stringify(box.cwd)};
completeDurableHandoff({
  project: resolveCorpusProject(cwd, "handoff"),
  cwd,
  reference: ${JSON.stringify({ policy: "durable-session-v1", identity: ID, name: NAME })},
  recipientSessionDigest: ${JSON.stringify(RECIPIENT)},
  recipientState: ${JSON.stringify(recipientState)},
  hooks: { afterStatePublish() {
    writeFileSync(${JSON.stringify(barrier)}, "published\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } },
});
`);
		child = spawn(process.execPath, [script], { stdio: "ignore" });
		await waitForFile(barrier);
		assert.equal(child.kill("SIGKILL"), true);
		await Promise.race([
			once(child, "exit"),
			delay(2_000).then(() => { throw new Error("child exit timed out"); }),
		]);
		assert.deepEqual(readDurableSession({ project: box.project, name: NAME }).state.runtime, recipientState);
		const nextState = runtime({ workerCostUsd: 22 });
		const recovered = recoverDurableHandoff(handoffOptions(box, nextState));
		assert.deepEqual(recovered.record.state.runtime, nextState);
	} finally {
		if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		box.close();
	}
});

test("Track 12 handoff code stays outside normal startup", () => {
	assert.equal(existsSync(new URL("../extension/authority-transition.ts", import.meta.url)), false);
	const forbidden = new Set(["durable-handoff.ts", "runtime-authority.ts", "session-record.ts"]);
	const pending = [new URL("../extension/index.ts", import.meta.url)];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (visited.has(file.href)) continue;
		visited.add(file.href);
		const source = readFileSync(file, "utf8");
		const parsed = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
		for (const statement of parsed.statements) {
			if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
			const specifier = statement.moduleSpecifier;
			if (specifier === undefined || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
			const dependency = new URL(specifier.text, file);
			assert.equal(forbidden.has(dependency.pathname.split("/").at(-1)!), false, `${file.pathname} reaches ${specifier.text}`);
			pending.push(dependency);
		}
	}
	assert.equal([...visited].some((file) => file.endsWith("/tools.ts")), true);
});
