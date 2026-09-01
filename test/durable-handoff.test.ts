import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	readDurableSession,
	type CanonicalSlateRuntime,
} from "../extension/session-record.ts";

const ID = "20260828T120000Z-0123abcd0123abcd";
const OTHER_ID = "20260828T120001Z-deadbeefdeadbeef";
const NAME = "calm-otter-7f3a";
const OTHER_NAME = "brisk-bison-abcd";
const SOURCE = "a".repeat(64);
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

function handoffOptions(box: Workspace, overrides: Partial<DurableHandoffOptions> = {}): DurableHandoffOptions {
	const record = readDurableSession({ project: box.project, name: NAME, identity: ID, cwd: box.cwd });
	return {
		project: box.project,
		cwd: box.cwd,
		reference: durableHandoffReference(record),
		...overrides,
	};
}

/** Store one thread and one episode in the namespace, as a saving session would. */
function storeRecords(box: Workspace, directory: string): CanonicalSlateRuntime {
	writeFileSync(join(directory, "episodes", "t1.e1.md"), "episode\n");
	const value = runtime({
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
	closeDurableSession({
		project: box.project,
		cwd: box.cwd,
		identity: ID,
		name: NAME,
		writerSessionDigest: SOURCE,
		outcome: "delivered",
		now: new Date("2026-08-28T12:30:00.000Z"),
	});
	return value;
}

test("handoff validation returns the stored records and writes nothing", () => {
	const box = workspace();
	try {
		const created = create(box);
		writeFileSync(join(created.directory, "episodes", "t1.e1.md"), "episode\n");
		const before = readFileSync(join(created.directory, "state.json"));
		const result = completeDurableHandoff(handoffOptions(box));
		assert.equal(result.kind, "complete");
		assert.deepEqual(result.binding, { policy: "durable-session-v1", identity: ID, name: NAME });
		// The read returns the stored records. No caller record set can reach storage.
		assert.deepEqual(result.record.state.runtime, runtime());
		assert.equal(result.record.state.lastWriterSessionDigest, SOURCE);
		assert.equal(result.record.state.generation, 0);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
		assert.equal(readFileSync(join(created.directory, "episodes", "t1.e1.md"), "utf8"), "episode\n");
	} finally {
		box.close();
	}
});

test("a repeated validation keeps every stored record", () => {
	const box = workspace();
	try {
		const created = create(box);
		const stored = storeRecords(box, created.directory);
		void stored;
		const first = recoverDurableHandoff(handoffOptions(box));
		const second = recoverDurableHandoff(handoffOptions(box));
		assert.deepEqual(first.record, second.record);
		assert.equal(first.record.state.status, "delivered");
		assert.deepEqual(
			readDurableSession({ project: box.project, name: NAME, identity: ID, cwd: box.cwd }),
			second.record,
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

test("handoff validation rejects a malformed reference and an incomplete namespace", () => {
	const box = workspace();
	try {
		const created = create(box);
		const before = readFileSync(join(created.directory, "state.json"));
		assert.throws(() => completeDurableHandoff(handoffOptions(box, {
			reference: { policy: "durable-session-v1", identity: "bad", name: NAME },
		})), /malformed or unsupported durable handoff reference/);
		rmSync(join(created.directory, "threads"), { recursive: true });
		assert.throws(() => completeDurableHandoff(handoffOptions(box)), /incomplete.*namespace/);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
	} finally {
		box.close();
	}
});

test("different durable sessions remain isolated", () => {
	const box = workspace();
	try {
		create(box);
		create(box, { identity: OTHER_ID, name: OTHER_NAME, value: runtime({ workerCostUsd: 9 }) });
		const first = completeDurableHandoff(handoffOptions(box));
		assert.equal(first.record.metadata.identity, ID);
		assert.equal(readDurableSession({ project: box.project, name: OTHER_NAME }).state.runtime.workerCostUsd, 9);
		assert.throws(() => completeDurableHandoff(handoffOptions(box, {
			reference: { policy: "durable-session-v1", identity: OTHER_ID, name: NAME },
		})), /identity mismatch/);
	} finally {
		box.close();
	}
});

test("writer provenance and terminal history do not block a validation", () => {
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
		const result = completeDurableHandoff(handoffOptions(box));
		assert.equal(result.record.state.status, "delivered");
		assert.equal(result.record.state.lastWriterSessionDigest, RIVAL);
		assert.deepEqual(result.record.state.runtime, runtime());
	} finally {
		box.close();
	}
});

test("normal startup reaches the storage report and no removed module", () => {
	assert.equal(existsSync(new URL("../extension/authority-transition.ts", import.meta.url)), false);
	// Track 14 activates external storage during startup, so startup MUST reach the
	// runtime authority check. The dormant handoff module stays outside startup.
	const forbidden = new Set(["durable-handoff.ts"]);
	const required = new Set(["runtime-authority.ts", "session-record.ts"]);
	const reached = new Set<string>();
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
			const leaf = dependency.pathname.split("/").at(-1)!;
			assert.equal(forbidden.has(leaf), false, `${file.pathname} reaches ${specifier.text}`);
			reached.add(leaf);
			pending.push(dependency);
		}
	}
	for (const module of required) assert.equal(reached.has(module), true, `startup does not reach ${module}`);
	assert.equal([...visited].some((file) => file.endsWith("/tools.ts")), true);
});
