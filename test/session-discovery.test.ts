import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capCorpusSessionOutput } from "../extension/corpus-list.ts";
import {
	DISCOVERY_AGGREGATE_BYTES,
	DISCOVERY_CANDIDATES,
	DISCOVERY_FILE_BYTES,
	DISCOVERY_PROJECT_ENTRIES,
	DISCOVERY_ROOT_ENTRIES,
	discoverCorpusSession,
	type SessionDiscoveryResult,
} from "../extension/session-discovery.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";

const NAME = "calm-otter-7f3a";
const OTHER_NAME = "brisk-bison-abcd";
const ID = "20260826T141500Z-0123abcd0123abcd";
const OTHER_ID = "20260826T141501Z-deadbeefdeadbeef";
const OWNER = "a".repeat(64);

interface Area {
	path: string;
	key: string;
	digest: string;
	label: string;
}

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "slate-session-discovery."));
	const corpus = join(root, "agent", "ytdb-slate", "projects");
	mkdirSync(corpus, { recursive: true });
	return {
		root,
		corpus,
		close() { rmSync(root, { recursive: true, force: true }); },
	};
}

function addArea(root: string, label: string, key: string): Area {
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
	const path = join(root, `${label}-${digest}`);
	mkdirSync(path);
	return { path, key, digest, label };
}

function identity(area: Area, name: string, value = ID, overrides: Record<string, unknown> = {}) {
	return {
		policy: "durable-session-v1",
		identity: value,
		name,
		createdAt: "2026-08-26T14:15:00.000Z",
		currentDirectory: join("/removed", area.label),
		projectKey: area.key,
		projectDigest: area.digest,
		creatorSessionDigest: OWNER,
		...overrides,
	};
}

function addSession(area: Area, name = NAME, value = ID, raw?: unknown): string {
	const path = join(area.path, name);
	mkdirSync(path);
	for (const child of ["episodes", "observations", "threads"]) mkdirSync(join(path, child));
	writeFileSync(join(path, "session.json"), typeof raw === "string" ? raw : `${JSON.stringify(raw ?? identity(area, name, value))}\n`);
	writeFileSync(join(path, "state.json"), "saved-state canary must never be read\n");
	writeFileSync(join(path, "episodes", "e1.md"), "episode canary must never be read\n");
	writeFileSync(join(path, "observations", "o1.md"), "observation canary must never be read\n");
	writeFileSync(join(path, "threads", "worker.jsonl"), "worker-history canary must never be read\n");
	return path;
}

function accepted(result: SessionDiscoveryResult) {
	if (!result.ok) assert.fail(result.reason);
	return result;
}

function snapshot(path: string): Record<string, { directory: boolean; mtimeMs: number; bytes?: string }> {
	const result: Record<string, { directory: boolean; mtimeMs: number; bytes?: string }> = {};
	const visit = (current: string, relative: string) => {
		const stat = statSync(current);
		result[relative] = {
			directory: stat.isDirectory(),
			mtimeMs: stat.mtimeMs,
			...(stat.isFile() ? { bytes: readFileSync(current).toString("base64") } : {}),
		};
		if (stat.isDirectory()) {
			for (const name of readdirSync(current).sort()) visit(join(current, name), join(relative, name));
		}
	};
	visit(path, ".");
	return result;
}

function mockBuiltin(t: TestContext, name: string, replacement: (...args: never[]) => unknown): void {
	const methods = fs as unknown as Record<string, (...args: never[]) => unknown>;
	t.mock.method(methods, name, replacement);
}

function restoreBuiltins(t: TestContext): void {
	t.mock.restoreAll();
	syncBuiltinESMExports();
}

interface FilesystemOperations {
	directoryReads: Map<string, number>;
	opened: string[];
	readCalls: number;
	readBytes: number;
}

function countFilesystemOperations(t: TestContext): FilesystemOperations {
	const operations: FilesystemOperations = {
		directoryReads: new Map(),
		opened: [],
		readCalls: 0,
		readBytes: 0,
	};
	const originalOpendir = fs.opendirSync;
	const originalOpen = fs.openSync;
	const originalRead = fs.readSync;
	t.mock.method(fs, "opendirSync", ((path: fs.PathLike, options?: fs.OpenDirOptions) => {
		const directory = originalOpendir(path, options);
		const key = String(path);
		const readDirectory = directory.readSync.bind(directory);
		t.mock.method(directory, "readSync", () => {
			operations.directoryReads.set(key, (operations.directoryReads.get(key) ?? 0) + 1);
			return readDirectory();
		});
		return directory;
	}) as typeof fs.opendirSync);
	t.mock.method(fs, "openSync", ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
		operations.opened.push(String(path));
		return originalOpen(path, flags, mode);
	}) as typeof fs.openSync);
	t.mock.method(fs, "readSync", ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
		operations.readCalls += 1;
		const count = originalRead(fd, buffer, offset, length, position);
		operations.readBytes += count;
		return count;
	}) as typeof fs.readSync);
	syncBuiltinESMExports();
	return operations;
}

function resetFilesystemOperations(operations: FilesystemOperations): void {
	operations.directoryReads.clear();
	operations.opened.length = 0;
	operations.readCalls = 0;
	operations.readBytes = 0;
}

function openedCount(operations: FilesystemOperations, path: string): number {
	return operations.opened.filter((opened) => opened === path).length;
}

function injectCloseFailure(t: TestContext, rejectedPath: string): () => number {
	const originalOpen = fs.openSync;
	const originalClose = fs.closeSync;
	const paths = new Map<number, string>();
	let failures = 0;
	t.mock.method(fs, "openSync", ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
		const fd = originalOpen(path, flags, mode);
		paths.set(fd, String(path));
		return fd;
	}) as typeof fs.openSync);
	t.mock.method(fs, "closeSync", ((fd: number) => {
		const path = paths.get(fd);
		paths.delete(fd);
		originalClose(fd);
		if (path === rejectedPath && failures === 0) {
			failures += 1;
			const error = new Error(`injected close failure for ${path}`) as NodeJS.ErrnoException;
			error.code = "EIO";
			throw error;
		}
	}) as typeof fs.closeSync);
	syncBuiltinESMExports();
	return () => failures;
}

function assertCloseFailureReturnsIncomplete(t: TestContext, target: "record" | "candidate" | "project" | "root"): void {
	const box = workspace();
	try {
		const area = addArea(box.corpus, "alpha", "/keys/alpha");
		const candidate = addSession(area);
		const paths = {
			record: join(candidate, "session.json"),
			candidate,
			project: area.path,
			root: box.corpus,
		};
		const failures = injectCloseFailure(t, paths[target]);
		const result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true }));
		assert.equal(failures(), 1);
		assert.equal(result.outcome, "incomplete");
		assert.equal(result.storageErrors, 1);
		assert.equal(result.unreadable, 0);
		assert.equal(result.matches.length, 1);
		assert.match(result.lines.join("\n"), /1 storage boundary operation failed outside candidate validation\./);
	} finally {
		restoreBuiltins(t);
		box.close();
	}
}

test("discovery constants pin every filesystem bound", () => {
	assert.deepEqual([
		DISCOVERY_ROOT_ENTRIES,
		DISCOVERY_PROJECT_ENTRIES,
		DISCOVERY_CANDIDATES,
		DISCOVERY_FILE_BYTES,
		DISCOVERY_AGGREGATE_BYTES,
	], [4096, 4096, 65_536, 64 * 1024, 4 * 1024 * 1024]);
});

test("name and identifier lookups return no match without current-project selection", () => {
	const box = workspace();
	try {
		writeFileSync(join(box.corpus, "not-a-project-area"), "ignored");
		addSession(addArea(box.corpus, "alpha", "/keys/alpha"), OTHER_NAME, OTHER_ID);
		for (const query of [NAME, ID]) {
			const result = accepted(discoverCorpusSession({ query, root: box.corpus, isTrusted: () => true }));
			assert.equal(result.outcome, "no match");
			assert.deepEqual(result.matches, []);
		}
	} finally { box.close(); }
});

test("invalid input refuses and an absent corpus root yields no match", () => {
	const box = workspace();
	try {
		const invalid = discoverCorpusSession({ query: "partial", root: box.corpus, isTrusted: () => true });
		assert.deepEqual(invalid, {
			ok: false,
			reason: "slate: sessions lookup requires one complete stable session name or session identifier",
		});
		const missing = accepted(discoverCorpusSession({
			query: NAME,
			root: join(box.root, "missing-root"),
			isTrusted: () => true,
		}));
		assert.equal(missing.outcome, "no match");
	} finally { box.close(); }
});

test("both lookup inputs return one validated identity record without disclosing the project key", () => {
	const box = workspace();
	try {
		const area = addArea(box.corpus, "alpha", "/private/alice/repository/.git");
		addSession(area);
		for (const query of [NAME, ID]) {
			const result = accepted(discoverCorpusSession({ query, root: box.corpus, isTrusted: () => true }));
			assert.equal(result.outcome, "one match");
			assert.equal(result.matches.length, 1);
			assert.deepEqual(result.matches[0], {
				name: NAME,
				identity: ID,
				createdAt: "2026-08-26T14:15:00.000Z",
				currentDirectory: "/removed/alpha",
				projectLabel: "alpha",
				projectDigest: area.digest,
			});
			const rendered = result.lines.join("\n");
			assert.match(rendered, new RegExp(`project alpha-${area.digest}`));
			assert.doesNotMatch(rendered, /private\/alice|project key/);
			assert.equal(result.lines[1], "Discovery metadata is advisory and can become stale immediately.");
		}
	} finally { box.close(); }
});

test("duplicate candidates across project areas remain separate and ambiguous", () => {
	const box = workspace();
	try {
		const first = addArea(box.corpus, "alpha", "/keys/alpha");
		const second = addArea(box.corpus, "beta", "/keys/beta");
		addSession(first);
		addSession(second);
		for (const query of [NAME, ID]) {
			const result = accepted(discoverCorpusSession({ query, root: box.corpus, isTrusted: () => true }));
			assert.equal(result.outcome, "ambiguous");
			assert.deepEqual(result.matches.map((match) => match.projectLabel), ["alpha", "beta"]);
			assert.match(result.lines.join("\n"), new RegExp(`project alpha-${first.digest}`));
			assert.match(result.lines.join("\n"), new RegExp(`project beta-${second.digest}`));
		}
	} finally { box.close(); }
});

test("a long match list keeps the advisory and reports command-channel truncation", () => {
	const box = workspace();
	try {
		for (let index = 0; index < 100; index += 1) {
			const label = `project-${String(index).padStart(3, "0")}-${"x".repeat(32)}`;
			addSession(addArea(box.corpus, label, `/keys/${index}`));
		}
		const result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true }));
		assert.equal(result.outcome, "ambiguous");
		assert.equal(result.matches.length, 100);
		const rendered = result.lines.join("\n");
		assert.equal(rendered.match(/^- /gmu)?.length, 100);
		const capped = capCorpusSessionOutput(rendered);
		assert.match(capped, /^slate:.*\nDiscovery metadata is advisory and can become stale immediately\./u);
		const summary = /Lookup found (\d+) matches\. The printed list contains (\d+) matches\./u.exec(capped);
		assert.ok(summary);
		assert.equal(Number(summary[1]), 100);
		const printed = capped.match(/^- /gmu)?.length ?? 0;
		assert.equal(Number(summary[2]), printed);
		assert.ok(printed < 100);
		assert.match(capped, /\[output truncated at 16384 characters\]$/u);
		assert.ok(capped.length <= 16_384);
	} finally { box.close(); }
});

test("an unreadable candidate and a scan stop have separate accurate counts", () => {
	const box = workspace();
	try {
		const first = addArea(box.corpus, "alpha", "/keys/alpha");
		const second = addArea(box.corpus, "beta", "/keys/beta");
		addSession(first, NAME, ID, identity(first, NAME, ID, { creatorSessionDigest: "invalid" }));
		addSession(second);
		const unreadable = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true }));
		assert.equal(unreadable.outcome, "incomplete");
		assert.equal(unreadable.unreadable, 1);
		assert.equal(unreadable.limitStops, 0);
		assert.match(unreadable.lines.join("\n"), /1 examined candidate could not be read or validated safely\./);
		assert.doesNotMatch(unreadable.lines.join("\n"), /resource limit/);
		const stopped = accepted(discoverCorpusSession({
			query: ID,
			root: box.corpus,
			isTrusted: () => true,
			limits: { rootEntries: 1 },
		}));
		assert.equal(stopped.outcome, "incomplete");
		assert.equal(stopped.examined, 0);
		assert.equal(stopped.unreadable, 0);
		assert.equal(stopped.limitStops, 1);
		assert.match(stopped.lines.join("\n"), /1 resource limit stopped scan work before completion\./);
		assert.doesNotMatch(stopped.lines.join("\n"), /examined candidate/);
	} finally { box.close(); }
});

test("every durable identity field validates before query comparison", () => {
	const mutations: Array<(area: Area) => unknown> = [
		() => null,
		(area) => ({ ...identity(area, NAME), extra: true }),
		(area) => ({ ...identity(area, NAME), policy: "future-policy" }),
		(area) => ({ ...identity(area, NAME), identity: "invalid" }),
		(area) => ({ ...identity(area, NAME), name: OTHER_NAME }),
		(area) => ({ ...identity(area, NAME), createdAt: "invalid" }),
		(area) => ({ ...identity(area, NAME), currentDirectory: "relative" }),
		(area) => ({ ...identity(area, NAME), projectKey: "relative" }),
		(area) => ({ ...identity(area, NAME), projectDigest: "0".repeat(12) }),
		(area) => ({ ...identity(area, NAME), projectKey: "/keys/different" }),
	];
	for (const mutate of mutations) {
		const box = workspace();
		try {
			const area = addArea(box.corpus, "alpha", "/keys/alpha");
			const path = addSession(area);
			writeFileSync(join(path, "session.json"), JSON.stringify(mutate(area)));
			const result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true }));
			assert.equal(result.outcome, "incomplete");
			assert.deepEqual(result.matches, []);
		} finally { box.close(); }
	}
});

test("name lookup excludes unreadable candidates at other stored names", () => {
	const box = workspace();
	try {
		const area = addArea(box.corpus, "alpha", "/keys/alpha");
		addSession(area);
		addSession(area, OTHER_NAME, OTHER_ID, "{");
		const named = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true }));
		assert.equal(named.outcome, "one match");
		assert.equal(named.examined, 1);
		const identified = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true }));
		assert.equal(identified.outcome, "incomplete");
		assert.equal(identified.examined, 2);
	} finally { box.close(); }
});

test("linked candidates and unsafe project areas produce incomplete outcomes", () => {
	const box = workspace();
	try {
		const area = addArea(box.corpus, "alpha", "/keys/alpha");
		const outside = join(box.root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(area.path, NAME));
		let result = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true }));
		assert.equal(result.outcome, "incomplete");
		assert.equal(result.unreadable, 1);
		rmSync(join(area.path, NAME));
		writeFileSync(join(box.corpus, `unsafe-${"b".repeat(12)}`), "not a directory");
		result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true }));
		assert.equal(result.outcome, "incomplete");
		assert.equal(result.storageErrors, 1);
	} finally { box.close(); }
});

test("hard-linked and symbolic-linked identity records are rejected", () => {
	for (const kind of ["hard", "symbolic"] as const) {
		const box = workspace();
		try {
			const area = addArea(box.corpus, "alpha", "/keys/alpha");
			const session = addSession(area);
			const record = join(session, "session.json");
			const outside = join(box.root, `${kind}-record.json`);
			writeFileSync(outside, `${JSON.stringify(identity(area, NAME))}\n`);
			unlinkSync(record);
			if (kind === "hard") linkSync(outside, record);
			else symlinkSync(outside, record);
			const result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true }));
			assert.equal(result.outcome, "incomplete", kind);
			assert.equal(result.unreadable, 1, kind);
			assert.deepEqual(result.matches, [], kind);
		} finally { box.close(); }
	}
});

test("an identity record replaced during reading is rejected", (t) => {
	const box = workspace();
	const originalRead = fs.readSync;
	try {
		const area = addArea(box.corpus, "alpha", "/keys/alpha");
		const session = addSession(area);
		const record = join(session, "session.json");
		let replaced = false;
		t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => {
			const count = originalRead(...args);
			if (!replaced && count > 0) {
				replaced = true;
				renameSync(record, join(session, "session.before-replacement.json"));
				writeFileSync(record, `${JSON.stringify(identity(area, NAME))}\n`);
			}
			return count;
		}) as typeof fs.readSync);
		syncBuiltinESMExports();
		const result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true }));
		assert.equal(replaced, true);
		assert.equal(result.outcome, "incomplete");
		assert.equal(result.unreadable, 1);
		assert.deepEqual(result.matches, []);
	} finally {
		restoreBuiltins(t);
		box.close();
	}
});

test("a record-handle close failure preserves the successful match", (t) => {
	assertCloseFailureReturnsIncomplete(t, "record");
});

test("a candidate-handle close failure stays inside the lookup outcome", (t) => {
	assertCloseFailureReturnsIncomplete(t, "candidate");
});

test("a project-directory-handle close failure stays inside the lookup outcome", (t) => {
	assertCloseFailureReturnsIncomplete(t, "project");
});

test("a root-directory-handle close failure stays inside the lookup outcome", (t) => {
	assertCloseFailureReturnsIncomplete(t, "root");
});

test("partial bytes before a read error count against the aggregate limit", (t) => {
	const box = workspace();
	const originalRead = fs.readSync;
	try {
		const area = addArea(box.corpus, "alpha", "/keys/alpha");
		addSession(area, OTHER_NAME, ID);
		addSession(area, NAME, ID);
		let calls = 0;
		t.mock.method(fs, "readSync", ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
			calls += 1;
			if (calls === 1) return originalRead(fd, buffer, offset, Math.min(length, 7), position);
			const error = new Error("injected read failure") as NodeJS.ErrnoException;
			error.code = "EIO";
			throw error;
		}) as typeof fs.readSync);
		syncBuiltinESMExports();
		const recordBytes = statSync(join(area.path, OTHER_NAME, "session.json")).size;
		const result = accepted(discoverCorpusSession({
			query: ID,
			root: box.corpus,
			isTrusted: () => true,
			limits: { aggregateBytes: recordBytes + 6 },
		}));
		assert.equal(result.outcome, "incomplete");
		assert.equal(result.work.bytes, 7);
		assert.equal(result.unreadable, 1);
		assert.equal(result.limitStops, 1);
		assert.equal(result.examined, 2);
		assert.equal(calls, 2);
	} finally {
		restoreBuiltins(t);
		box.close();
	}
});

test("every bound accepts its exact boundary and stops at the next unit", (t) => {
	const operations = countFilesystemOperations(t);
	try {
	{
		const box = workspace();
		try {
			const area = addArea(box.corpus, "alpha", "/keys/alpha");
			addSession(area);
			resetFilesystemOperations(operations);
			let result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true, limits: { rootEntries: 1 } }));
			assert.equal(result.outcome, "one match");
			assert.equal(result.work.rootEntries, 1);
			assert.equal(operations.directoryReads.get(box.corpus), 2);
			assert.equal(openedCount(operations, box.corpus), 1);
			assert.equal(operations.opened.length, 4);
			writeFileSync(join(box.corpus, "extra-root-entry"), "canary");
			resetFilesystemOperations(operations);
			result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true, limits: { rootEntries: 1 } }));
			assert.equal(result.outcome, "incomplete");
			assert.equal(operations.directoryReads.get(box.corpus), 2);
			assert.equal(operations.opened.length, 1);
			assert.deepEqual(result.work, { rootEntries: 2, projectEntries: 0, candidates: 0, bytes: 0 });
			assert.equal(result.limitStops, 1);
		} finally { box.close(); }
	}
	{
		const box = workspace();
		try {
			const area = addArea(box.corpus, "alpha", "/keys/alpha");
			addSession(area);
			resetFilesystemOperations(operations);
			let result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true, limits: { projectEntries: 1 } }));
			assert.equal(result.outcome, "one match");
			assert.equal(result.work.projectEntries, 1);
			assert.equal(operations.directoryReads.get(area.path), 2);
			assert.equal(openedCount(operations, join(area.path, NAME, "session.json")), 1);
			assert.equal(operations.opened.length, 4);
			writeFileSync(join(area.path, "extra-project-entry"), "canary");
			resetFilesystemOperations(operations);
			result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true, limits: { projectEntries: 1 } }));
			assert.equal(result.outcome, "incomplete");
			assert.equal(operations.directoryReads.get(area.path), 2);
			assert.equal(openedCount(operations, join(area.path, NAME, "session.json")), 0);
			assert.equal(operations.opened.length, 2);
			assert.deepEqual(result.work, { rootEntries: 1, projectEntries: 2, candidates: 0, bytes: 0 });
			assert.equal(result.limitStops, 1);
		} finally { box.close(); }
	}
	{
		const box = workspace();
		try {
			addSession(addArea(box.corpus, "alpha", "/keys/alpha"));
			resetFilesystemOperations(operations);
			let result = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true, limits: { candidates: 1 } }));
			assert.equal(result.outcome, "one match");
			assert.equal(result.work.candidates, 1);
			assert.equal(operations.opened.filter((path) => basename(path) === "session.json").length, 1);
			assert.equal(operations.opened.length, 4);
			addSession(addArea(box.corpus, "beta", "/keys/beta"));
			resetFilesystemOperations(operations);
			result = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true, limits: { candidates: 1 } }));
			assert.equal(result.outcome, "incomplete");
			assert.equal(operations.opened.filter((path) => basename(path) === "session.json").length, 1);
			assert.equal(operations.opened.length, 5);
			assert.equal(result.work.candidates, 1);
			assert.equal(result.limitStops, 1);
		} finally { box.close(); }
	}
	{
		const box = workspace();
		try {
			const session = addSession(addArea(box.corpus, "alpha", "/keys/alpha"));
			const bytes = statSync(join(session, "session.json")).size;
			resetFilesystemOperations(operations);
			let result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true, limits: { fileBytes: bytes } }));
			assert.equal(result.outcome, "one match");
			assert.equal(result.work.bytes, bytes);
			assert.equal(operations.readBytes, bytes);
			assert.equal(operations.readCalls, 1);
			assert.equal(operations.opened.length, 4);
			resetFilesystemOperations(operations);
			result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true, limits: { fileBytes: bytes - 1 } }));
			assert.equal(result.outcome, "incomplete");
			assert.equal(operations.readBytes, 0);
			assert.equal(operations.readCalls, 0);
			assert.equal(operations.opened.length, 4);
			assert.equal(result.work.bytes, 0);
			assert.equal(result.unreadable, 1);
		} finally { box.close(); }
	}
	{
		const box = workspace();
		try {
			const first = addArea(box.corpus, "alpha", "/keys/alpha");
			const session = addSession(first);
			const bytes = statSync(join(session, "session.json")).size;
			resetFilesystemOperations(operations);
			let result = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true, limits: { aggregateBytes: bytes } }));
			assert.equal(result.outcome, "one match");
			assert.equal(result.work.bytes, bytes);
			assert.equal(operations.readBytes, bytes);
			assert.equal(operations.opened.length, 4);
			const second = addArea(box.corpus, "bravo", "/keys/bravo");
			const secondSession = addSession(second);
			assert.equal(statSync(join(secondSession, "session.json")).size, bytes);
			resetFilesystemOperations(operations);
			result = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true, limits: { aggregateBytes: bytes } }));
			assert.equal(result.outcome, "incomplete");
			assert.equal(result.work.bytes, bytes);
			assert.equal(operations.readBytes, bytes);
			assert.equal(operations.opened.filter((path) => basename(path) === "session.json").length, 2);
			assert.equal(operations.opened.length, 7);
			assert.equal(result.work.candidates, 2);
			assert.equal(result.limitStops, 1);
		} finally { box.close(); }
	}
	} finally {
		restoreBuiltins(t);
	}
});

test("missing and malformed identity records are incomplete", () => {
	const box = workspace();
	try {
		const area = addArea(box.corpus, "alpha", "/keys/alpha");
		const missing = join(area.path, NAME);
		mkdirSync(missing);
		let result = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true }));
		assert.equal(result.outcome, "incomplete");
		rmSync(missing, { recursive: true });
		const malformed = addSession(area);
		writeFileSync(join(malformed, "session.json"), Buffer.from([0xff]));
		result = accepted(discoverCorpusSession({ query: NAME, root: box.corpus, isTrusted: () => true }));
		assert.equal(result.outcome, "incomplete");
	} finally { box.close(); }
});

test("the trust refusal occurs before every filesystem access", (t) => {
	let filesystemCalls = 0;
	for (const name of ["lstatSync", "realpathSync", "openSync", "opendirSync", "readFileSync", "readdirSync"] as const) {
		const original = fs[name] as (...args: never[]) => unknown;
		mockBuiltin(t, name, ((...args: never[]) => {
			filesystemCalls += 1;
			return original(...args);
		}) as (...args: never[]) => unknown);
	}
	syncBuiltinESMExports();
	try {
		let trustChecks = 0;
		const result = discoverCorpusSession({
			query: NAME,
			root: "/this/path/must/not-be-read",
			isTrusted: () => { trustChecks += 1; return false; },
		});
		assert.equal(trustChecks, 1);
		assert.equal(filesystemCalls, 0);
		assert.deepEqual(result, {
			ok: false,
			reason: "slate: project-independent session lookup requires a trusted project",
		});
	} finally {
		restoreBuiltins(t);
	}
});

test("discovery opens only identity records, enumerates no sibling content, and performs no write", (t) => {
	const box = workspace();
	const originalOpen = fs.openSync;
	const originalOpendir = fs.opendirSync;
	try {
		const area = addArea(box.corpus, "alpha", "/keys/alpha");
		addSession(area);
		const before = snapshot(box.corpus);
		const opened: string[] = [];
		const enumerated: string[] = [];
		t.mock.method(fs, "openSync", ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
			assert.equal(typeof flags, "number", "discovery must use numeric read-only open flags");
			const numericFlags = flags as number;
			const writeFlags = fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_TRUNC;
			assert.equal(numericFlags & writeFlags, 0, `discovery requested write-capable flags for ${String(path)}`);
			const directoryFlag = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
			if ((numericFlags & directoryFlag) === 0) {
				assert.equal(basename(String(path)), "session.json", `discovery opened unrelated file ${String(path)}`);
				opened.push(String(path));
			}
			return originalOpen(path, flags, mode);
		}) as typeof fs.openSync);
		t.mock.method(fs, "opendirSync", ((path: fs.PathLike, options?: fs.OpenDirOptions) => {
			if (typeof path === "string") enumerated.push(path);
			return originalOpendir(path, options);
		}) as typeof fs.opendirSync);
		for (const name of [
			"appendFileSync", "chmodSync", "chownSync", "copyFileSync", "fchmodSync", "fchownSync",
			"ftruncateSync", "linkSync", "mkdirSync", "renameSync", "rmSync", "symlinkSync",
			"truncateSync", "unlinkSync", "writeFileSync", "writeSync",
		]) {
			mockBuiltin(t, name, (() => assert.fail(`discovery called write operation ${name}`)) as (...args: never[]) => never);
		}
		syncBuiltinESMExports();
		const result = accepted(discoverCorpusSession({ query: ID, root: box.corpus, isTrusted: () => true }));
		assert.equal(result.outcome, "one match");
		assert.ok(opened.length > 0);
		assert.equal(opened.every((path) => basename(path) === "session.json"), true);
		assert.equal(enumerated.some((path) => ["episodes", "observations", "threads"].includes(basename(path))), false);
		restoreBuiltins(t);
		assert.deepEqual(snapshot(box.corpus), before);
	} finally {
		restoreBuiltins(t);
		box.close();
	}
});

test("the sessions command never loads discovery without a supplied value", async (t) => {
	let command: { handler(args: string, ctx: ExtensionContext): Promise<void> } | undefined;
	const pi = {
		registerCommand(_name: string, value: typeof command) { command = value; },
		on() {},
		getActiveTools() { return []; },
		getAllTools() { return []; },
		setActiveTools() {},
	} as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	let loads = 0;
	let query = "";
	registerSlateMode(
		pi,
		store,
		{ startHandoff: async () => {}, adoptHandoff: async () => false, effectiveContextBudget: (window: number) => window },
		() => ({}),
		() => EMPTY_WORKER_EXTENSION_SET,
		undefined,
		async () => { throw new Error("writing checker must not load"); },
		async () => {
			loads += 1;
			return {
				discoverCorpusSession(options: { query: string }) {
					query = options.query;
					return { ok: true as const, lines: ["lookup result"] };
				},
			};
		},
	);
	assert.ok(command);
	const notices: Array<[string, string]> = [];
	let trusted = true;
	const ctx = {
		cwd: "/missing-current-project",
		hasUI: true,
		isProjectTrusted: () => trusted,
		ui: { notify: (message: string, level: string) => notices.push([message, level]) },
	} as unknown as ExtensionContext;
	t.mock.method(console, "warn", () => {});
	await command.handler("sessions", ctx);
	assert.equal(loads, 0);
	assert.deepEqual(notices.at(-1), ["slate: corpus project is unavailable", "warning"]);
	await command.handler(`sessions ${ID}`, ctx);
	assert.equal(loads, 1);
	assert.equal(query, ID);
	assert.deepEqual(notices.at(-1), ["lookup result", "info"]);
	trusted = false;
	await command.handler(`sessions ${ID}`, ctx);
	assert.equal(loads, 1);
	assert.deepEqual(notices.at(-1), ["slate: project-independent session lookup requires a trusted project", "warning"]);
});

test("Track 13 discovery code stays outside every normal-startup execution path", () => {
	const forbidden = "session-discovery.ts";
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
			assert.notEqual(dependency.pathname.split("/").at(-1), forbidden, `${file.pathname} reaches ${specifier.text}`);
			pending.push(dependency);
		}
		const visit = (node: ts.Node, insideFunction: boolean): void => {
			const nowInsideFunction = insideFunction || ts.isFunctionLike(node);
			if (!nowInsideFunction && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				assert.fail(`${file.pathname} runs a top-level import expression`);
			}
			ts.forEachChild(node, (child) => visit(child, nowInsideFunction));
		};
		visit(parsed, false);
	}
	assert.equal(existsSync(new URL("../extension/session-discovery.ts", import.meta.url)), true);
	assert.equal([...visited].some((file) => file.endsWith("/mode.ts")), true);
	assert.equal([...visited].some((file) => file.endsWith(`/${forbidden}`)), false);
});
