import assert from "node:assert/strict";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCorpusSession, resolveCorpusProject, validateCorpusSession, type CorpusProject } from "../extension/corpus.ts";
import {
	closeDurableSession,
	createDurableSession,
	DURABLE_SESSION_POLICY,
	readDurableSession,
	updateDurableSession,
} from "../extension/session-record.ts";

const ID = "20260826T141500Z-0123abcd0123abcd";
const OTHER_ID = "20260826T141501Z-deadbeefdeadbeef";
const OWNER = "a".repeat(64);
const NAME = "calm-otter-7f3a";

interface Workspace {
	root: string;
	cwd: string;
	agent: string;
	project: CorpusProject;
	close(): void;
}

function workspace(afterEnvironmentChange?: () => void): Workspace {
	const previous = process.env.PI_CODING_AGENT_DIR;
	let root: string | undefined;
	try {
		root = mkdtempSync(join(tmpdir(), "slate-session-record."));
		const cwd = join(root, "project");
		const agent = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agent);
		process.env.PI_CODING_AGENT_DIR = agent;
		afterEnvironmentChange?.();
		const project = resolveCorpusProject(cwd, "records");
		return {
			root,
			cwd,
			agent,
			project,
			close() {
				if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previous;
				rmSync(root!, { recursive: true, force: true });
			},
		};
	} catch (error) {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		if (root !== undefined) rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function create(box: Workspace, name = NAME, identity = ID) {
	return createDurableSession({
		cwd: box.cwd,
		project: box.project,
		name,
		identity,
		creatorOwnerDigest: OWNER,
		now: new Date("2026-08-26T14:15:00.000Z"),
	});
}

function parse(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function mutation(box: Workspace, expectedGeneration: number, name = NAME, identity = ID) {
	return { project: box.project, name, identity, cwd: box.cwd, expectedGeneration };
}

function privateStateEntries(box: Workspace): string[] {
	return readdirSync(box.project.directory).filter((entry) => entry.startsWith(".staging-durable-state-"));
}

test("a durable session publishes complete metadata and active state", () => {
	const box = workspace();
	try {
		const created = create(box);
		assert.equal(created.directory, join(box.project.directory, NAME));
		assert.deepEqual(created.state, { generation: 0, status: "active" });
		assert.deepEqual(readDurableSession({ project: box.project, name: NAME, identity: ID, cwd: box.cwd }), created);
		assert.deepEqual(readdirSync(created.directory).sort(), ["episodes", "observations", "session.json", "state.json", "threads"]);
		assert.equal(statSync(created.directory).mode & 0o777, 0o700);
		assert.equal(statSync(join(created.directory, "session.json")).mode & 0o777, 0o600);
		assert.equal(statSync(join(created.directory, "state.json")).mode & 0o777, 0o600);
		assert.deepEqual(created.metadata, {
			policy: DURABLE_SESSION_POLICY,
			identity: ID,
			name: NAME,
			createdAt: "2026-08-26T14:15:00.000Z",
			currentDirectory: box.cwd,
			projectKey: box.project.key,
			projectDigest: box.project.digest,
			creatorOwnerDigest: OWNER,
		});
	} finally {
		box.close();
	}
});

test("state updates preserve immutable metadata and omit live runtime configuration", () => {
	const box = workspace();
	try {
		const created = create(box);
		const metadataFile = join(created.directory, "session.json");
		const before = readFileSync(metadataFile);
		const updated = updateDurableSession(mutation(box, 0));
		assert.deepEqual(updated.state, { generation: 1, status: "active" });
		assert.deepEqual(readFileSync(metadataFile), before);
		const text = before.toString("utf8");
		for (const liveKey of ["router", "writing", "workerTools", "contextBudget", "draftPRs", "followUpIssues"]) {
			assert.doesNotMatch(text, new RegExp(liveKey));
		}
	} finally {
		box.close();
	}
});

test("duplicate publication preserves the first namespace", () => {
	const box = workspace();
	try {
		const created = create(box);
		const beforeMetadata = readFileSync(join(created.directory, "session.json"));
		const beforeState = readFileSync(join(created.directory, "state.json"));
		assert.throws(() => create(box), /duplicate durable session publication/);
		assert.deepEqual(readFileSync(join(created.directory, "session.json")), beforeMetadata);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), beforeState);
	} finally {
		box.close();
	}
});

test("malformed metadata and unsupported policy fail closed", () => {
	for (const [label, mutate] of [
		["missing field", (value: Record<string, unknown>) => { delete value.creatorOwnerDigest; }],
		["unknown field", (value: Record<string, unknown>) => { value.extra = true; }],
		["unsupported policy", (value: Record<string, unknown>) => { value.policy = "durable-session-v2"; }],
		["mismatched namespace name", (value: Record<string, unknown>) => { value.name = "brisk-bison-abcd"; }],
		["invalid identity", (value: Record<string, unknown>) => { value.identity = "bad"; }],
		["invalid creation time", (value: Record<string, unknown>) => { value.createdAt = "tomorrow"; }],
		["relative current directory", (value: Record<string, unknown>) => { value.currentDirectory = "project"; }],
		["relative project key", (value: Record<string, unknown>) => { value.projectKey = "project"; }],
		["invalid project digest", (value: Record<string, unknown>) => { value.projectDigest = "ABC"; }],
		["invalid provenance", (value: Record<string, unknown>) => { value.creatorOwnerDigest = "owner"; }],
	] as const) {
		const box = workspace();
		try {
			const created = create(box);
			const file = join(created.directory, "session.json");
			const value = parse(file);
			mutate(value);
			writeJson(file, value);
			assert.throws(() => readDurableSession({ project: box.project, name: NAME }), /refused/, label);
		} finally {
			box.close();
		}
	}
});

test("malformed authoritative state fails closed", () => {
	for (const [label, value] of [
		["non-object state", "[]"],
		["malformed JSON", "{"],
		["negative generation", JSON.stringify({ generation: -1, status: "active" })],
		["fractional generation", JSON.stringify({ generation: 0.5, status: "active" })],
		["unknown status", JSON.stringify({ generation: 0, status: "paused" })],
		["terminal without time", JSON.stringify({ generation: 1, status: "delivered" })],
		["terminal with invalid time", JSON.stringify({ generation: 1, status: "abandoned", terminalAt: "later" })],
		["active with terminal time", JSON.stringify({ generation: 1, status: "active", terminalAt: "2026-08-26T14:15:00.000Z" })],
	] as const) {
		const box = workspace();
		try {
			const created = create(box);
			writeFileSync(join(created.directory, "state.json"), value);
			assert.throws(() => readDurableSession({ project: box.project, name: NAME }), /refused/, label);
		} finally {
			box.close();
		}
	}
});

test("non-regular, oversized, and invalid UTF-8 records are refused", () => {
	for (const [label, content] of [
		["oversized", Buffer.alloc(64 * 1024 + 1, 0x20)],
		["invalid UTF-8", Buffer.from([0xc3, 0x28])],
	] as const) {
		const box = workspace();
		try {
			const created = create(box);
			writeFileSync(join(created.directory, "state.json"), content);
			assert.throws(() => readDurableSession({ project: box.project, name: NAME }), /oversized|valid UTF-8/, label);
		} finally {
			box.close();
		}
	}
	const box = workspace();
	try {
		const created = create(box);
		const stateFile = join(created.directory, "state.json");
		rmSync(stateFile);
		mkdirSync(stateFile);
		assert.throws(() => readDurableSession({ project: box.project, name: NAME }), /non-regular/);
	} finally {
		box.close();
	}
});

test("symbolic-link substitution of the namespace or either authoritative record is refused", () => {
	for (const fileName of ["session.json", "state.json"]) {
		const box = workspace();
		try {
			const created = create(box);
			const file = join(created.directory, fileName);
			const outside = join(box.root, fileName);
			renameSync(file, outside);
			symlinkSync(outside, file);
			assert.throws(() => readDurableSession({ project: box.project, name: NAME }), /linked or non-regular/, fileName);
			assert.equal(lstatSync(file).isSymbolicLink(), true);
		} finally {
			box.close();
		}
	}
	const box = workspace();
	try {
		const created = create(box);
		const outside = join(box.root, "outside-namespace");
		renameSync(created.directory, outside);
		symlinkSync(outside, created.directory);
		assert.throws(() => readDurableSession({ project: box.project, name: NAME }), /linked.*namespace/);
	} finally {
		box.close();
	}
});

test("a failed namespace publication leaves only ignored private staging", () => {
	const box = workspace();
	try {
		let staged = "";
		assert.throws(() => createDurableSession({
			cwd: box.cwd,
			project: box.project,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
			hooks: {
				beforeNamespacePublish(path) {
					staged = path;
					assert.equal(existsSync(join(path, "session.json")), true);
					assert.equal(existsSync(join(path, "state.json")), true);
					throw new Error("forced publication failure");
				},
			},
		}), /could not publish/);
		assert.notEqual(staged, "");
		assert.equal(existsSync(staged), true);
		assert.equal(existsSync(join(box.project.directory, NAME)), false);
		assert.deepEqual(readdirSync(box.project.directory), [staged.split("/").at(-1)!]);
		assert.throws(() => createDurableSession({
			cwd: box.cwd,
			project: box.project,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
			hooks: { beforeNamespacePublish: () => mkdirSync(join(box.project.directory, NAME)) },
		}), /duplicate durable session publication/);
		assert.deepEqual(readdirSync(join(box.project.directory, NAME)), []);
		assert.equal(readdirSync(box.project.directory).filter((entry) => entry.startsWith(".creating-durable-")).length, 2);
	} finally {
		box.close();
	}
});

test("creation and read boundaries reject invalid identity, time, and project context", () => {
	const box = workspace();
	try {
		const validOptions = {
			cwd: box.cwd,
			project: box.project,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
		};
		for (const [label, overrides] of [
			["identity", { identity: "bad" }],
			["name", { name: "bad/name" }],
			["provenance", { creatorOwnerDigest: "bad" }],
		] as const) {
			assert.throws(() => createDurableSession({ ...validOptions, ...overrides }), /invalid/, label);
		}
		assert.throws(() => createDurableSession({
			cwd: box.cwd,
			project: box.project,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
			now: new Date(Number.NaN),
		}), /invalid durable session creation time/);
		const forged = { ...box.project, key: join(box.root, "foreign") };
		assert.throws(() => createDurableSession({
			cwd: box.cwd,
			project: forged,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
		}), /different corpus project/);
		create(box);
		assert.throws(
			() => readDurableSession({ project: { ...box.project, root: box.root }, name: NAME }),
			/outside the corpus root/,
		);
		assert.throws(
			() => readDurableSession({ project: { ...box.project, digest: "bad" }, name: NAME }),
			/invalid durable session project identity/,
		);
		assert.throws(
			() => readDurableSession({ project: box.project, name: "bad/name" }),
			/invalid durable session name/,
		);
		rmSync(box.cwd, { recursive: true });
		assert.throws(
			() => updateDurableSession(mutation(box, 0)),
			/current directory is unavailable/,
		);
	} finally {
		box.close();
	}
});

test("generation mismatch refuses overwrite and leaves no staged state", () => {
	const box = workspace();
	try {
		const created = create(box);
		const before = readFileSync(join(created.directory, "state.json"));
		assert.throws(() => updateDurableSession(mutation(box, 1)), /generation mismatch: expected 1, found 0/);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
		assert.equal(readdirSync(created.directory).some((entry) => entry.startsWith(".state-")), false);
	} finally {
		box.close();
	}
});

test("invalid and exhausted generation inputs refuse replacement", () => {
	const box = workspace();
	try {
		const created = create(box);
		assert.throws(() => updateDurableSession(mutation(box, -1)), /invalid expected durable session generation/);
		writeJson(join(created.directory, "state.json"), { generation: Number.MAX_SAFE_INTEGER, status: "active" });
		assert.throws(
			() => updateDurableSession(mutation(box, Number.MAX_SAFE_INTEGER)),
			/generation exhaustion/,
		);
		assert.equal(readdirSync(created.directory).some((entry) => entry.startsWith(".state-")), false);
	} finally {
		box.close();
	}
});

test("generation recheck catches a competing writer before the accepted final race window", () => {
	const box = workspace();
	try {
		const created = create(box);
		assert.throws(() => updateDurableSession({
			...mutation(box, 0),
			hooks: {
				beforeGenerationRecheck() {
					assert.deepEqual(updateDurableSession(mutation(box, 0)).state, { generation: 1, status: "active" });
				},
			},
		}), /generation mismatch: expected 0, found 1/);
		assert.deepEqual(readDurableSession({ project: box.project, name: NAME }).state, { generation: 1, status: "active" });
		assert.equal(readdirSync(created.directory).some((entry) => entry.startsWith(".state-")), false);
		assert.equal(privateStateEntries(box).length, 1);
	} finally {
		box.close();
	}
});

test("generation recheck rejects a competing terminal transition", () => {
	const box = workspace();
	try {
		const created = create(box);
		assert.throws(() => updateDurableSession({
			...mutation(box, 0),
			hooks: {
				beforeGenerationRecheck() {
					closeDurableSession({ ...mutation(box, 0), outcome: "abandoned" });
				},
			},
		}), /terminal durable session/);
		assert.equal(readDurableSession({ project: box.project, name: NAME }).state.status, "abandoned");
		assert.equal(readdirSync(created.directory).some((entry) => entry.startsWith(".state-")), false);
		assert.equal(privateStateEntries(box).length, 1);
	} finally {
		box.close();
	}
});

test("delivered and abandoned transitions advance one generation", () => {
	for (const [index, outcome] of ["delivered", "abandoned"].entries()) {
		const box = workspace();
		try {
			const name = index === 0 ? NAME : "brisk-bison-abcd";
			create(box, name);
			const closed = closeDurableSession({
				...mutation(box, 0, name),
				outcome: outcome as "delivered" | "abandoned",
				now: new Date("2026-08-26T15:00:00.000Z"),
			});
			assert.deepEqual(closed.state, {
				generation: 1,
				status: outcome,
				terminalAt: "2026-08-26T15:00:00.000Z",
			});
		} finally {
			box.close();
		}
	}
});

test("terminal transitions reject invalid outcomes and times", () => {
	const box = workspace();
	try {
		create(box);
		assert.throws(
			() => closeDurableSession({ ...mutation(box, 0), outcome: "active" as "delivered" }),
			/unsupported durable session terminal outcome/,
		);
		assert.throws(
			() => closeDurableSession({ ...mutation(box, 0), outcome: "delivered", now: new Date(Number.NaN) }),
			/invalid durable session terminal time/,
		);
		assert.deepEqual(readDurableSession({ project: box.project, name: NAME }).state, { generation: 0, status: "active" });
	} finally {
		box.close();
	}
});

test("terminal state rejects later update and closure", () => {
	const box = workspace();
	try {
		const created = create(box);
		closeDurableSession({ ...mutation(box, 0), outcome: "delivered", now: new Date("2026-08-26T15:00:00.000Z") });
		const before = readFileSync(join(created.directory, "state.json"));
		assert.throws(() => updateDurableSession(mutation(box, 1)), /terminal durable session/);
		assert.throws(
			() => closeDurableSession({ ...mutation(box, 1), outcome: "abandoned" }),
			/terminal durable session/,
		);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
	} finally {
		box.close();
	}
});

test("publication refuses removed records and required child directories", () => {
	for (const child of ["state.json", "threads"]) {
		const box = workspace();
		try {
			let staged = "";
			assert.throws(() => createDurableSession({
				cwd: box.cwd,
				project: box.project,
				name: NAME,
				identity: ID,
				creatorOwnerDigest: OWNER,
				hooks: { beforeNamespacePublish(path) { staged = path; rmSync(join(path, child), { recursive: true }); } },
			}), /incomplete|non-regular/);
			assert.equal(existsSync(join(box.project.directory, NAME)), false, child);
			assert.equal(existsSync(staged), true, child);
		} finally {
			box.close();
		}
	}
});

test("publication refuses staged directory and individual record replacement", () => {
	const replaced = workspace();
	try {
		let original = "";
		let replacement = "";
		assert.throws(() => createDurableSession({
			cwd: replaced.cwd,
			project: replaced.project,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
			hooks: {
				beforeNamespacePublish(path) {
					original = `${path}.saved`;
					replacement = path;
					renameSync(path, original);
					mkdirSync(path);
					writeFileSync(join(path, "sentinel"), "do not delete");
				},
			},
		}), /changing staged durable session namespace/);
		assert.equal(existsSync(join(replaced.project.directory, NAME)), false);
		assert.equal(readFileSync(join(replacement, "sentinel"), "utf8"), "do not delete");
		assert.equal(existsSync(original), true);
	} finally {
		replaced.close();
	}

	for (const kind of ["symbolic link", "hard link"] as const) {
		const box = workspace();
		try {
			let staged = "";
			assert.throws(() => createDurableSession({
				cwd: box.cwd,
				project: box.project,
				name: NAME,
				identity: ID,
				creatorOwnerDigest: OWNER,
				hooks: {
					beforeNamespacePublish(path) {
						staged = path;
						const state = join(path, "state.json");
						const outside = join(box.root, `${kind}.json`);
						if (kind === "symbolic link") {
							renameSync(state, outside);
							symlinkSync(outside, state);
						} else {
							linkSync(state, outside);
						}
					},
				},
			}), /linked or non-regular/);
			assert.equal(existsSync(join(box.project.directory, NAME)), false, kind);
			assert.equal(existsSync(staged), true, kind);
		} finally {
			box.close();
		}
	}
});

test("single-link validation rejects externally writable authoritative records", () => {
	for (const fileName of ["session.json", "state.json"]) {
		const box = workspace();
		try {
			const created = create(box);
			linkSync(join(created.directory, fileName), join(box.root, fileName));
			assert.throws(
				() => readDurableSession({ project: box.project, name: NAME }),
				/linked or non-regular/,
				fileName,
			);
		} finally {
			box.close();
		}
	}
});

test("creation refuses a second valid namespace with the same identity", () => {
	const box = workspace();
	try {
		const first = create(box);
		assert.throws(() => create(box, "brisk-bison-abcd", ID), /duplicate durable session identity publication/);
		assert.equal(existsSync(join(box.project.directory, "brisk-bison-abcd")), false);
		assert.deepEqual(readDurableSession({ project: box.project, name: NAME }).state, first.state);
	} finally {
		box.close();
	}
});

test("creation fails closed on a malformed session-named sibling", () => {
	const box = workspace();
	try {
		const hostile = join(box.project.directory, "brisk-bison-abcd");
		mkdirSync(hostile, { recursive: true });
		writeFileSync(join(hostile, "session.json"), "{");
		assert.throws(() => create(box), /malformed durable session JSON/);
		assert.equal(readFileSync(join(hostile, "session.json"), "utf8"), "{");
		assert.equal(existsSync(join(box.project.directory, NAME)), false);
	} finally {
		box.close();
	}
});

test("generation recheck refuses a hard-linked staged state before rename", () => {
	const box = workspace();
	try {
		const created = create(box);
		const before = readFileSync(join(created.directory, "state.json"));
		assert.throws(() => updateDurableSession({
			...mutation(box, 0),
			hooks: {
				beforeGenerationRecheck() {
					const staged = privateStateEntries(box)[0];
					assert.ok(staged);
					linkSync(join(box.project.directory, staged), join(box.root, "externally-writable-state.json"));
				},
			},
		}), /linked or changing staged durable session state/);
		assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
	} finally {
		box.close();
	}
});

test("generation recheck refuses every stable metadata change", () => {
	const box = workspace();
	try {
		execFileSync("git", ["init", "-q"], { cwd: box.cwd });
		box.project = resolveCorpusProject(box.cwd, "records");
		const nested = join(box.cwd, "nested");
		mkdirSync(nested);
		const created = create(box);
		assert.throws(() => updateDurableSession({
			...mutation(box, 0),
			hooks: {
				beforeGenerationRecheck() {
					const metadata = parse(join(created.directory, "session.json"));
					metadata.currentDirectory = nested;
					writeJson(join(created.directory, "session.json"), metadata);
				},
			},
		}), /metadata modified during state replacement/);
		assert.deepEqual(parse(join(created.directory, "state.json")), { generation: 0, status: "active" });
		assert.equal(readdirSync(created.directory).some((entry) => entry.startsWith(".state-")), false);
		assert.equal(privateStateEntries(box).length, 1);
	} finally {
		box.close();
	}
});

test("failed record writes leave no unmanaged state in the authoritative namespace", () => {
	const creation = workspace();
	try {
		assert.throws(() => createDurableSession({
			cwd: creation.cwd,
			project: creation.project,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
			hooks: {
				beforeRecordWrite(file) {
					if (file.endsWith("state.json")) throw new Error("forced state write failure");
				},
			},
		}), /could not publish/);
		assert.equal(existsSync(join(creation.project.directory, NAME)), false);
		const staged = readdirSync(creation.project.directory).filter((entry) => entry.startsWith(".creating-durable-"));
		assert.equal(staged.length, 1);
		assert.equal(existsSync(join(creation.project.directory, staged[0]!, "state.json")), true);
	} finally {
		creation.close();
	}

	for (const failure of ["write", "fsync"] as const) {
		const update = workspace();
		try {
			const created = create(update);
			const before = readFileSync(join(created.directory, "state.json"));
			const fail = () => { throw new Error(`forced update ${failure} failure`); };
			assert.throws(() => updateDurableSession({
				...mutation(update, 0),
				hooks: failure === "write" ? { beforeRecordWrite: fail } : { beforeRecordFsync: fail },
			}), /could not replace/);
			assert.deepEqual(readFileSync(join(created.directory, "state.json")), before);
			assert.equal(readdirSync(created.directory).filter((entry) => entry.startsWith(".state-")).length, 0);
			const privateEntry = privateStateEntries(update)[0];
			assert.ok(privateEntry);
			assert.equal(validateCorpusSession(update.project, privateEntry, ID), false);
			assert.throws(
				() => readDurableSession({ project: update.project, name: privateEntry, identity: ID }),
				/invalid durable session name/,
			);
			assert.deepEqual(updateDurableSession(mutation(update, 0)).state, { generation: 1, status: "active" });
			assert.equal(existsSync(join(update.project.directory, privateEntry)), true);
		} finally {
			update.close();
		}
	}
});

test("cleanup never unlinks a pathname replaced with authoritative state", () => {
	const box = workspace();
	try {
		const created = create(box);
		let swapped = "";
		assert.throws(() => updateDurableSession({
			...mutation(box, 0),
			hooks: {
				beforeGenerationRecheck() {
					const staged = privateStateEntries(box)[0];
					assert.ok(staged);
					swapped = join(box.project.directory, staged);
					renameSync(swapped, `${swapped}.candidate`);
					renameSync(join(created.directory, "state.json"), swapped);
					throw new Error("forced path swap");
				},
			},
		}), /could not replace/);
		assert.deepEqual(parse(swapped), { generation: 0, status: "active" });
		assert.equal(existsSync(join(created.directory, "state.json")), false);
	} finally {
		box.close();
	}
});

test("random staging-name failure happens before opening the namespace", () => {
	const box = workspace();
	try {
		create(box);
		const descriptorDirectory = "/proc/self/fd";
		const before = existsSync(descriptorDirectory) ? readdirSync(descriptorDirectory).length : undefined;
		for (let index = 0; index < 40; index++) {
			assert.throws(() => updateDurableSession({
				...mutation(box, 0),
				hooks: { drawStateNonce: () => { throw new Error("forced random failure"); } },
			}), /could not prepare/);
		}
		if (before !== undefined) assert.equal(readdirSync(descriptorDirectory).length, before);
	} finally {
		box.close();
	}
});

test("every durable transition performs its required directory syncs", () => {
	const box = workspace();
	try {
		const points: string[] = [];
		createDurableSession({
			cwd: box.cwd,
			project: box.project,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
			hooks: { syncDirectory: (_directory, point) => { points.push(point); } },
		});
		assert.deepEqual(points, ["staged-namespace", "project-before-publication", "project-after-publication"]);
		points.length = 0;
		updateDurableSession({
			...mutation(box, 0),
			hooks: { syncDirectory: (_directory, point) => { points.push(point); } },
		});
		assert.deepEqual(points, ["staged-state", "published-state", "project-after-state-publication"]);
	} finally {
		box.close();
	}
});

test("the production sync branch reports completed held-directory fsyncs", () => {
	const box = workspace();
	try {
		const observed: Array<{ point: string; source: string }> = [];
		createDurableSession({
			cwd: box.cwd,
			project: box.project,
			name: NAME,
			identity: ID,
			creatorOwnerDigest: OWNER,
			hooks: {
				observeDirectorySync: (_directory, point, source) => { observed.push({ point, source }); },
			},
		});
		updateDurableSession({
			...mutation(box, 0),
			hooks: {
				observeDirectorySync: (_directory, point, source) => { observed.push({ point, source }); },
			},
		});
		assert.deepEqual(observed, [
			{ point: "staged-namespace", source: "fsync" },
			{ point: "project-before-publication", source: "fsync" },
			{ point: "project-after-publication", source: "fsync" },
			{ point: "staged-state", source: "fsync" },
			{ point: "published-state", source: "fsync" },
			{ point: "project-after-state-publication", source: "fsync" },
		]);
	} finally {
		box.close();
	}
});

test("workspace setup restores the environment and removes partial fixtures", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const before = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("slate-session-record.")));
	assert.throws(() => workspace(() => { throw new Error("forced setup failure"); }), /forced setup failure/);
	assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
	const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith("slate-session-record.") && !before.has(entry));
	assert.deepEqual(after, []);
});

test("identity, project, and exact current-directory mismatches refuse mutation", () => {
	const box = workspace();
	try {
		execFileSync("git", ["init", "-q"], { cwd: box.cwd });
		box.project = resolveCorpusProject(box.cwd, "records");
		create(box);
		assert.throws(() => updateDurableSession(mutation(box, 0, NAME, OTHER_ID)), /identity mismatch/);
		const otherDirectory = join(box.cwd, "nested");
		mkdirSync(otherDirectory);
		assert.throws(
			() => updateDurableSession({ ...mutation(box, 0), cwd: otherDirectory }),
			/different current directory/,
		);
		const foreignProject = { ...box.project, key: otherDirectory };
		assert.throws(
			() => readDurableSession({ project: foreignProject, name: NAME }),
			/different corpus project/,
		);
	} finally {
		box.close();
	}
});

test("durable storage and legacy namespaces do not reinterpret each other", () => {
	const box = workspace();
	try {
		const legacy = createCorpusSession({
			cwd: box.cwd,
			project: box.project,
			identity: OTHER_ID,
			initialNameBytes: Uint8Array.from([1, 1, 0xab, 0xcd]),
		});
		const legacyMetadata = readFileSync(join(legacy.directory, "session.json"));
		assert.throws(
			() => readDurableSession({ project: box.project, name: legacy.name }),
			/does not match its schema|unsupported durable session/,
		);
		assert.throws(
			() => createDurableSession({
				cwd: box.cwd,
				project: box.project,
				name: legacy.name,
				identity: ID,
				creatorOwnerDigest: OWNER,
			}),
			/duplicate durable session publication/,
		);
		assert.deepEqual(readFileSync(join(legacy.directory, "session.json")), legacyMetadata);
		const durable = create(box);
		assert.equal(validateCorpusSession(box.project, durable.metadata.name, ID), false);
		assert.equal(validateCorpusSession(box.project, legacy.name, OTHER_ID), true);
		assert.deepEqual(readFileSync(join(legacy.directory, "session.json")), legacyMetadata);
		assert.equal(existsSync(join(legacy.directory, "state.json")), false);
	} finally {
		box.close();
	}
});
