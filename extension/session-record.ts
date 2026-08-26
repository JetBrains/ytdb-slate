import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	renameSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import {
	corpusDirectoryMatches,
	ensureCorpusProjectDirectory,
	fsyncHeldCorpusDirectory,
	holdCorpusDirectory,
	resolveCorpusProject,
	resolveCorpusRoot,
	resolveProjectKey,
	sameFileIdentity,
	SlateWriteRefused,
	type CorpusProject,
	type HeldCorpusDirectory,
} from "./corpus.ts";
import { isOwnerSessionDigest, isSlateSessionId } from "./session-identity.ts";
import { isSlateSessionName } from "./session-names.ts";

export const DURABLE_SESSION_POLICY = "durable-session-v1" as const;
export type DurableSessionStatus = "active" | "delivered" | "abandoned";
export type DurableTerminalOutcome = Exclude<DurableSessionStatus, "active">;

export interface DurableSessionMetadata {
	policy: typeof DURABLE_SESSION_POLICY;
	identity: string;
	name: string;
	createdAt: string;
	currentDirectory: string;
	projectKey: string;
	projectDigest: string;
	creatorOwnerDigest: string;
}

export type DurableSessionState =
	| { generation: number; status: "active" }
	| { generation: number; status: DurableTerminalOutcome; terminalAt: string };

export interface DurableSessionRecord {
	directory: string;
	metadata: DurableSessionMetadata;
	state: DurableSessionState;
}

export type DurableDirectorySyncPoint =
	| "staged-namespace"
	| "project-before-publication"
	| "project-after-publication"
	| "staged-state"
	| "published-state"
	| "project-after-state-publication";

export type DurableDirectorySyncSource = "hook" | "fsync";

export interface DurableSessionHooks {
	/** Deterministic test seams. The dormant production module has no callers that pass them. */
	beforeNamespacePublish?: (stagingDirectory: string) => void;
	beforeGenerationRecheck?: () => void;
	beforeRecordWrite?: (file: string, fd: number) => void;
	beforeRecordFsync?: (file: string, fd: number) => void;
	drawStateNonce?: () => string;
	syncDirectory?: (directory: HeldCorpusDirectory, point: DurableDirectorySyncPoint) => void;
	observeDirectorySync?: (
		directory: HeldCorpusDirectory,
		point: DurableDirectorySyncPoint,
		source: DurableDirectorySyncSource,
	) => void;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECORD_MAX_BYTES = 64 * 1024;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
const METADATA_KEYS = [
	"policy",
	"identity",
	"name",
	"createdAt",
	"currentDirectory",
	"projectKey",
	"projectDigest",
	"creatorOwnerDigest",
] as const;

function refuse(message: string, cause?: unknown): never {
	throw new SlateWriteRefused(message, cause === undefined ? undefined : { cause });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function singleNamedRecord(entry: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number } | undefined): boolean {
	return entry?.isFile() === true && !entry.isSymbolicLink() && entry.nlink === 1;
}

function syncDirectory(
	directory: HeldCorpusDirectory,
	point: DurableDirectorySyncPoint,
	hooks: DurableSessionHooks | undefined,
): void {
	let source: DurableDirectorySyncSource;
	if (hooks?.syncDirectory !== undefined) {
		hooks.syncDirectory(directory, point);
		source = "hook";
	} else source = fsyncHeldCorpusDirectory(directory);
	hooks?.observeDirectorySync?.(directory, point, source);
}

function canonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function boundedAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 4096 && isAbsolute(value);
}

function validateMetadata(raw: unknown, project: CorpusProject, name: string, identity?: string): DurableSessionMetadata {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		refuse("slate refused durable session metadata that is not an object");
	}
	const value = raw as Record<string, unknown>;
	if (!exactKeys(value, METADATA_KEYS)) refuse("slate refused durable session metadata that does not match its schema");
	if (value.policy !== DURABLE_SESSION_POLICY) refuse("slate refused an unsupported durable session format or policy");
	if (!isSlateSessionId(value.identity)) refuse("slate refused an invalid durable session identity");
	if (value.name !== name || !isSlateSessionName(value.name)) refuse("slate refused durable session metadata with a mismatched name");
	if (!canonicalTimestamp(value.createdAt)) refuse("slate refused an invalid durable session creation time");
	if (!boundedAbsolutePath(value.currentDirectory)) refuse("slate refused an invalid durable session current directory");
	if (!boundedAbsolutePath(value.projectKey)) refuse("slate refused an invalid durable session project key");
	if (typeof value.projectDigest !== "string" || !/^[0-9a-f]{12}$/.test(value.projectDigest)) {
		refuse("slate refused an invalid durable session project digest");
	}
	if (!isOwnerSessionDigest(value.creatorOwnerDigest)) refuse("slate refused invalid durable session creation provenance");
	if (value.projectKey !== project.key || value.projectDigest !== project.digest) {
		refuse("slate refused durable session metadata for a different corpus project");
	}
	if (identity !== undefined && value.identity !== identity) refuse("slate refused a durable session identity mismatch");
	return value as unknown as DurableSessionMetadata;
}

function validateState(raw: unknown): DurableSessionState {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		refuse("slate refused durable session state that is not an object");
	}
	const value = raw as Record<string, unknown>;
	if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
		refuse("slate refused an invalid durable session generation");
	}
	if (value.status === "active") {
		if (!exactKeys(value, ["generation", "status"])) refuse("slate refused malformed active durable session state");
		return value as unknown as DurableSessionState;
	}
	if (value.status === "delivered" || value.status === "abandoned") {
		if (!exactKeys(value, ["generation", "status", "terminalAt"]) || !canonicalTimestamp(value.terminalAt)) {
			refuse("slate refused malformed terminal durable session state");
		}
		return value as unknown as DurableSessionState;
	}
	refuse("slate refused an unsupported durable session status");
}

function assertProjectShape(project: CorpusProject): void {
	if (project.root !== resolveCorpusRoot() || dirname(project.directory) !== project.root) {
		refuse("slate refused a durable session project outside the corpus root");
	}
	if (!/^[0-9a-f]{12}$/.test(project.digest) || !project.directory.endsWith(`-${project.digest}`)) {
		refuse("slate refused an invalid durable session project identity");
	}
	const entry = lstatSync(project.directory, { throwIfNoEntry: false });
	if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync(project.directory) !== project.directory) {
		refuse("slate refused a missing, linked, or changing durable session project");
	}
}

function assertLiveProject(project: CorpusProject, cwd: string): string {
	let currentDirectory: string;
	try {
		currentDirectory = realpathSync(cwd);
	} catch (error) {
		refuse("slate refused durable session mutation because its current directory is unavailable", error);
	}
	if (resolveProjectKey(currentDirectory) !== project.key) {
		refuse("slate refused durable session mutation from a different project");
	}
	return currentDirectory;
}

function sessionDirectory(project: CorpusProject, name: string): string {
	if (!isSlateSessionName(name)) refuse("slate refused an invalid durable session name");
	return join(project.directory, name);
}

function readJsonFile(file: string, directory: HeldCorpusDirectory): unknown {
	if (dirname(file) !== directory.path || !corpusDirectoryMatches(directory)) {
		refuse("slate refused a durable session record outside its namespace");
	}
	const before = lstatSync(file, { throwIfNoEntry: false });
	if (!singleNamedRecord(before)) refuse("slate refused a linked or non-regular durable session record");
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
		const held = fstatSync(fd);
		const current = lstatSync(file, { throwIfNoEntry: false });
		if (!singleNamedRecord(held) || held.size > RECORD_MAX_BYTES || !singleNamedRecord(current)
			|| !sameFileIdentity(held, current!) || !corpusDirectoryMatches(directory)) {
			refuse("slate refused a linked, oversized, or changing durable session record");
		}
		const bytes = Buffer.alloc(RECORD_MAX_BYTES + 1);
		let used = 0;
		while (used < bytes.byteLength) {
			const count = readSync(fd, bytes, used, bytes.byteLength - used, null);
			if (count === 0) break;
			used += count;
		}
		if (used > RECORD_MAX_BYTES) refuse("slate refused an oversized durable session record");
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used));
		} catch (error) {
			refuse("slate refused durable session bytes that are not valid UTF-8", error);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			refuse("slate refused malformed durable session JSON", error);
		}
		const after = lstatSync(file, { throwIfNoEntry: false });
		if (!singleNamedRecord(after) || !sameFileIdentity(held, after!)
			|| !corpusDirectoryMatches(directory)) {
			refuse("slate refused a durable session record modified during read");
		}
		return parsed;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeExclusiveJson(
	file: string,
	value: unknown,
	directory: HeldCorpusDirectory,
	hooks?: DurableSessionHooks,
): Stats {
	if (dirname(file) !== directory.path || !corpusDirectoryMatches(directory)) {
		refuse("slate refused a durable session write outside its namespace");
	}
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(content, "utf8") > RECORD_MAX_BYTES) refuse("slate refused an oversized durable session record");
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
		const held = fstatSync(fd);
		const current = lstatSync(file, { throwIfNoEntry: false });
		if (!singleNamedRecord(held) || !singleNamedRecord(current)
			|| !sameFileIdentity(held, current!) || !corpusDirectoryMatches(directory)) {
			refuse("slate refused a linked or changing staged durable session record");
		}
		hooks?.beforeRecordWrite?.(file, fd);
		writeFileSync(fd, content, "utf8");
		hooks?.beforeRecordFsync?.(file, fd);
		fsyncSync(fd);
		const after = lstatSync(file, { throwIfNoEntry: false });
		if (!singleNamedRecord(after) || !sameFileIdentity(held, after!)
			|| !corpusDirectoryMatches(directory)) {
			refuse("slate refused a staged durable session record modified during write");
		}
		return held;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function sameMetadata(left: DurableSessionMetadata, right: DurableSessionMetadata): boolean {
	return METADATA_KEYS.every((key) => left[key] === right[key]);
}

function sameState(left: DurableSessionState, right: DurableSessionState): boolean {
	return left.generation === right.generation && left.status === right.status
		&& (left.status === "active" || (right.status !== "active" && left.terminalAt === right.terminalAt));
}

function assertRequiredDirectories(directory: HeldCorpusDirectory): void {
	for (const category of ["episodes", "observations", "threads"]) {
		const path = join(directory.path, category);
		const entry = lstatSync(path, { throwIfNoEntry: false });
		if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path
			|| !corpusDirectoryMatches(directory)) {
			refuse("slate refused an incomplete or linked durable session namespace");
		}
	}
}

function validateNamespace(
	project: CorpusProject,
	name: string,
	directory: HeldCorpusDirectory,
	expectedMetadata?: DurableSessionMetadata,
	expectedState?: DurableSessionState,
): { metadata: DurableSessionMetadata; state: DurableSessionState } {
	if (!corpusDirectoryMatches(directory)) refuse("slate refused a changing durable session namespace");
	assertRequiredDirectories(directory);
	const metadata = validateMetadata(readJsonFile(join(directory.path, "session.json"), directory), project, name);
	const state = validateState(readJsonFile(join(directory.path, "state.json"), directory));
	if (expectedMetadata !== undefined && !sameMetadata(metadata, expectedMetadata)) {
		refuse("slate refused durable session metadata modified before publication");
	}
	if (expectedState !== undefined && !sameState(state, expectedState)) {
		refuse("slate refused durable session state modified before publication");
	}
	return { metadata, state };
}

function validLegacyMetadata(raw: unknown, name: string): boolean {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
	const value = raw as Record<string, unknown>;
	const keys = Object.keys(value);
	const expected = ["identity", "name", "createdAt", "worktreePath", "branchLabel"];
	if (!(exactKeys(value, expected) || exactKeys(value, [...expected, "piSessionName"]))) return false;
	return typeof value.identity === "string" && value.name === name && canonicalTimestamp(value.createdAt)
		&& boundedAbsolutePath(value.worktreePath) && typeof value.branchLabel === "string"
		&& (value.piSessionName === undefined || typeof value.piSessionName === "string")
		&& keys.length >= expected.length;
}

function assertIdentityAvailable(project: CorpusProject, identity: string): void {
	let names: string[];
	try {
		names = readdirSync(project.directory);
	} catch (error) {
		refuse("slate refused to scan durable session identities", error);
	}
	for (const name of names) {
		if (!isSlateSessionName(name)) continue;
		const path = join(project.directory, name);
		const entry = lstatSync(path, { throwIfNoEntry: false });
		if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path) {
			refuse("slate refused a hostile sibling durable session namespace");
		}
		const held = holdCorpusDirectory(path);
		try {
			const raw = readJsonFile(join(path, "session.json"), held);
			if (typeof raw === "object" && raw !== null && !Array.isArray(raw)
				&& !("policy" in raw) && validLegacyMetadata(raw, name)) {
				continue;
			}
			const records = validateNamespace(project, name, held);
			if (records.metadata.identity === identity) {
				refuse("slate refused duplicate durable session identity publication");
			}
		} finally {
			closeSync(held.fd);
		}
	}
}

interface OpenedDurableSession extends DurableSessionRecord {
	held: HeldCorpusDirectory;
}

function openDurableSession(options: {
	project: CorpusProject;
	name: string;
	identity?: string;
	cwd?: string;
}): OpenedDurableSession {
	assertProjectShape(options.project);
	const directory = sessionDirectory(options.project, options.name);
	const entry = lstatSync(directory, { throwIfNoEntry: false });
	if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory) {
		refuse("slate refused a missing, linked, or changing durable session namespace");
	}
	const held = holdCorpusDirectory(directory);
	try {
		assertRequiredDirectories(held);
		const metadata = validateMetadata(
			readJsonFile(join(directory, "session.json"), held),
			options.project,
			options.name,
			options.identity,
		);
		if (options.cwd !== undefined) {
			const currentDirectory = assertLiveProject(options.project, options.cwd);
			if (metadata.currentDirectory !== currentDirectory) {
				refuse("slate refused durable session mutation from a different current directory");
			}
		}
		const state = validateState(readJsonFile(join(directory, "state.json"), held));
		return { directory, metadata, state, held };
	} catch (error) {
		closeSync(held.fd);
		throw error;
	}
}

export function createDurableSession(options: {
	cwd: string;
	identity: string;
	name: string;
	creatorOwnerDigest: string;
	project?: CorpusProject;
	corpusName?: unknown;
	now?: Date;
	hooks?: DurableSessionHooks;
}): DurableSessionRecord {
	if (!isSlateSessionId(options.identity)) refuse("slate refused an invalid durable session identity");
	if (!isSlateSessionName(options.name)) refuse("slate refused an invalid durable session name");
	if (!isOwnerSessionDigest(options.creatorOwnerDigest)) refuse("slate refused invalid durable session creation provenance");
	const project = options.project ?? resolveCorpusProject(options.cwd, options.corpusName);
	const liveProject = resolveCorpusProject(options.cwd, project.label);
	if (project.root !== liveProject.root || project.key !== liveProject.key || project.digest !== liveProject.digest
		|| project.directory !== liveProject.directory) {
		refuse("slate refused durable session creation for a different corpus project");
	}
	ensureCorpusProjectDirectory(project);
	const currentDirectory = assertLiveProject(project, options.cwd);
	let createdAt: string;
	try {
		createdAt = (options.now ?? new Date()).toISOString();
	} catch (error) {
		refuse("slate refused an invalid durable session creation time", error);
	}
	const metadata: DurableSessionMetadata = {
		policy: DURABLE_SESSION_POLICY,
		identity: options.identity,
		name: options.name,
		createdAt,
		currentDirectory,
		projectKey: project.key,
		projectDigest: project.digest,
		creatorOwnerDigest: options.creatorOwnerDigest,
	};
	const state: DurableSessionState = { generation: 0, status: "active" };
	validateMetadata(metadata, project, options.name, options.identity);
	validateState(state);
	const directory = sessionDirectory(project, options.name);
	const projectHeld = holdCorpusDirectory(project.directory);
	let stagingHeld: HeldCorpusDirectory | undefined;
	let staging = "";
	try {
		if (lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
			refuse("slate refused duplicate durable session publication");
		}
		assertIdentityAvailable(project, options.identity);
		staging = mkdtempSync(join(project.directory, `.creating-durable-${options.name}-`));
		stagingHeld = holdCorpusDirectory(staging);
		if (!corpusDirectoryMatches(projectHeld)) refuse("slate refused a changing durable session project");
		for (const category of ["episodes", "observations", "threads"]) {
			mkdirSync(join(staging, category), { mode: PRIVATE_DIRECTORY_MODE });
		}
		writeExclusiveJson(join(staging, "session.json"), metadata, stagingHeld, options.hooks);
		writeExclusiveJson(join(staging, "state.json"), state, stagingHeld, options.hooks);
		syncDirectory(stagingHeld, "staged-namespace", options.hooks);
		syncDirectory(projectHeld, "project-before-publication", options.hooks);
		options.hooks?.beforeNamespacePublish?.(staging);
		if (!corpusDirectoryMatches(stagingHeld) || !corpusDirectoryMatches(projectHeld)) {
			refuse("slate refused a changing staged durable session namespace");
		}
		validateNamespace(project, options.name, stagingHeld, metadata, state);
		if (lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
			refuse("slate refused duplicate durable session publication");
		}
		assertIdentityAvailable(project, options.identity);
		try {
			renameSync(staging, directory);
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
				refuse("slate refused duplicate durable session publication", error);
			}
			throw error;
		}
		if (!corpusDirectoryMatches(stagingHeld, directory) || !corpusDirectoryMatches(projectHeld)) {
			refuse("slate refused a durable session namespace modified during publication");
		}
		stagingHeld.path = directory;
		validateNamespace(project, options.name, stagingHeld, metadata, state);
		syncDirectory(projectHeld, "project-after-publication", options.hooks);
		return { directory, metadata, state };
	} catch (error) {
		throw error instanceof SlateWriteRefused
			? error
			: new SlateWriteRefused("slate could not publish its durable session namespace", { cause: error });
	} finally {
		/* Hostile replacement makes pathname cleanup unsafe. Private failed staging remains ignored. */
		if (stagingHeld !== undefined) closeSync(stagingHeld.fd);
		closeSync(projectHeld.fd);
	}
}

export function readDurableSession(options: {
	project: CorpusProject;
	name: string;
	identity?: string;
	cwd?: string;
}): DurableSessionRecord {
	const opened = openDurableSession(options);
	try {
		return { directory: opened.directory, metadata: opened.metadata, state: opened.state };
	} finally {
		closeSync(opened.held.fd);
	}
}

function replaceState(options: {
	project: CorpusProject;
	name: string;
	identity: string;
	cwd: string;
	expectedGeneration: number;
	nextStatus: DurableSessionStatus;
	terminalAt?: string;
	hooks?: DurableSessionHooks;
}): DurableSessionRecord {
	if (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 0) {
		refuse("slate refused an invalid expected durable session generation");
	}
	let nonce: string;
	try {
		nonce = options.hooks?.drawStateNonce?.() ?? randomBytes(8).toString("hex");
		if (!/^[0-9a-f]{16}$/.test(nonce)) refuse("slate refused an invalid staged state nonce");
	} catch (error) {
		throw error instanceof SlateWriteRefused
			? error
			: new SlateWriteRefused("slate could not prepare a durable session state replacement", { cause: error });
	}
	const opened = openDurableSession(options);
	let projectHeld: HeldCorpusDirectory;
	try {
		projectHeld = holdCorpusDirectory(options.project.directory);
	} catch (error) {
		closeSync(opened.held.fd);
		throw error;
	}
	const stateFile = join(opened.directory, "state.json");
	const staging = join(options.project.directory, `.staging-durable-state-${options.name}-${process.pid}-${nonce}.tmp`);
	let stagingStat: Stats | undefined;
	try {
		if (opened.state.status !== "active") refuse("slate refused mutation of a terminal durable session");
		if (opened.state.generation !== options.expectedGeneration) {
			refuse(`slate refused durable session generation mismatch: expected ${options.expectedGeneration}, found ${opened.state.generation}`);
		}
		const nextGeneration = options.expectedGeneration + 1;
		if (!Number.isSafeInteger(nextGeneration)) refuse("slate refused durable session generation exhaustion");
		const candidate: DurableSessionState = options.nextStatus === "active"
			? { generation: nextGeneration, status: "active" }
			: { generation: nextGeneration, status: options.nextStatus, terminalAt: options.terminalAt! };
		validateState(candidate);
		stagingStat = writeExclusiveJson(staging, candidate, projectHeld, options.hooks);
		syncDirectory(projectHeld, "staged-state", options.hooks);
		options.hooks?.beforeGenerationRecheck?.();
		const currentMetadata = validateMetadata(
			readJsonFile(join(opened.directory, "session.json"), opened.held),
			options.project,
			options.name,
			options.identity,
		);
		if (!sameMetadata(currentMetadata, opened.metadata)) {
			refuse("slate refused durable session metadata modified during state replacement");
		}
		const current = validateState(readJsonFile(stateFile, opened.held));
		if (current.status !== "active") refuse("slate refused mutation of a terminal durable session");
		if (current.generation !== options.expectedGeneration) {
			refuse(`slate refused durable session generation mismatch: expected ${options.expectedGeneration}, found ${current.generation}`);
		}
		const stagedBeforeRename = lstatSync(staging, { throwIfNoEntry: false });
		if (!singleNamedRecord(stagedBeforeRename) || !sameFileIdentity(stagingStat, stagedBeforeRename!)
			|| !corpusDirectoryMatches(projectHeld) || !corpusDirectoryMatches(opened.held)) {
			refuse("slate refused a linked or changing staged durable session state");
		}
		/*
		 * The generation recheck closes every observed stale-writer race before this point.
		 * Two single-writer violations can still pass it and rename in sequence. Slate accepts
		 * that final race window. This layer adds no lock, lease, or writer coordinator.
		 */
		renameSync(staging, stateFile);
		const published = lstatSync(stateFile, { throwIfNoEntry: false });
		if (!singleNamedRecord(published) || !sameFileIdentity(stagingStat, published!)
			|| !corpusDirectoryMatches(opened.held) || !corpusDirectoryMatches(projectHeld)) {
			refuse("slate refused durable session state modified during replacement");
		}
		syncDirectory(opened.held, "published-state", options.hooks);
		syncDirectory(projectHeld, "project-after-state-publication", options.hooks);
		const committed = validateState(readJsonFile(stateFile, opened.held));
		if (committed.generation !== nextGeneration || committed.status !== candidate.status) {
			refuse("slate refused an unexpected durable session state after replacement");
		}
		return { directory: opened.directory, metadata: opened.metadata, state: committed };
	} catch (error) {
		throw error instanceof SlateWriteRefused
			? error
			: new SlateWriteRefused("slate could not replace durable session state", { cause: error });
	} finally {
		/* Failed staging remains outside the authoritative namespace. Never unlink a replaceable pathname. */
		closeSync(projectHeld.fd);
		closeSync(opened.held.fd);
	}
}

export function updateDurableSession(options: {
	project: CorpusProject;
	name: string;
	identity: string;
	cwd: string;
	expectedGeneration: number;
	hooks?: DurableSessionHooks;
}): DurableSessionRecord {
	return replaceState({ ...options, nextStatus: "active" });
}

export function closeDurableSession(options: {
	project: CorpusProject;
	name: string;
	identity: string;
	cwd: string;
	expectedGeneration: number;
	outcome: DurableTerminalOutcome;
	now?: Date;
	hooks?: DurableSessionHooks;
}): DurableSessionRecord {
	if (options.outcome !== "delivered" && options.outcome !== "abandoned") {
		refuse("slate refused an unsupported durable session terminal outcome");
	}
	let terminalAt: string;
	try {
		terminalAt = (options.now ?? new Date()).toISOString();
	} catch (error) {
		refuse("slate refused an invalid durable session terminal time", error);
	}
	return replaceState({ ...options, nextStatus: options.outcome, terminalAt });
}
