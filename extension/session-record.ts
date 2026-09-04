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
import { dirname, isAbsolute, join, relative } from "node:path";
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
import { RESEARCH_LOG_FILENAME } from "./research-log.ts";
import { isOwnerSessionDigest, isSlateSessionId } from "./session-identity.ts";
import { isSlateSessionName } from "./session-names.ts";
import {
	CanonicalRuntimeDecodeError,
	decodeCanonicalRuntime,
	type CanonicalRuntimeState,
} from "./state.ts";

export const DURABLE_SESSION_POLICY = "durable-session-v1" as const;
export type DurableSessionStatus = "active" | "delivered" | "abandoned";
export type DurableTerminalOutcome = Exclude<DurableSessionStatus, "active">;

/** Complete Slate-owned runtime data stored only in the external namespace. */
export interface CanonicalSlateRuntime extends CanonicalRuntimeState {}

export interface DurableSessionMetadata {
	policy: typeof DURABLE_SESSION_POLICY;
	identity: string;
	name: string;
	createdAt: string;
	currentDirectory: string;
	projectKey: string;
	projectDigest: string;
	creatorSessionDigest: string;
}

interface DurableSessionStateBase {
	/** Informational write sequence. It does not reject or authorize a writer. */
	generation: number;
	/** Provenance for the last saved state. It grants no ownership. */
	lastWriterSessionDigest: string;
	runtime: CanonicalSlateRuntime;
}

export type DurableSessionState =
	| (DurableSessionStateBase & { status: "active" })
	| (DurableSessionStateBase & { status: DurableTerminalOutcome; terminalAt: string });

export interface DurableSessionRecord {
	directory: string;
	metadata: DurableSessionMetadata;
	state: DurableSessionState;
}

/** A rename became visible, but final directory durability could not be established. */
export class DurableCommitUncertain extends SlateWriteRefused {
	readonly operation: "create" | "update";
	readonly record: DurableSessionRecord | undefined;

	constructor(operation: "create" | "update", record: DurableSessionRecord | undefined, cause: unknown) {
		super(
			`slate published a durable session ${operation}, but directory synchronization is uncertain`,
			{ cause },
		);
		this.name = "DurableCommitUncertain";
		this.operation = operation;
		this.record = record;
	}
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
	beforeStatePublish?: () => void;
	afterStatePublish?: () => void;
	beforeRecordWrite?: (file: string, fd: number) => void;
	/** Fires before the staged research log write, so a test can occupy that name. */
	beforeResearchLogWrite?: (file: string) => void;
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
const METADATA_MAX_BYTES = 64 * 1024;
const STATE_MAX_BYTES = 1024 * 1024;
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
	"creatorSessionDigest",
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
	if (!isOwnerSessionDigest(value.creatorSessionDigest)) refuse("slate refused invalid durable session creation provenance");
	if (value.projectKey !== project.key || value.projectDigest !== project.digest) {
		refuse("slate refused durable session metadata for a different corpus project");
	}
	if (identity !== undefined && value.identity !== identity) refuse("slate refused a durable session identity mismatch");
	return value as unknown as DurableSessionMetadata;
}

interface RuntimeDecodeContext {
	metadata: DurableSessionMetadata;
	directory: HeldCorpusDirectory;
	canonicalDirectory: string;
}

function existingCanonicalArtifact(context: RuntimeDecodeContext, absolutePath: string): boolean {
	try {
		const suffix = relative(context.canonicalDirectory, absolutePath);
		const actualPath = join(context.directory.path, suffix);
		const entry = lstatSync(actualPath, { throwIfNoEntry: false });
		return singleNamedRecord(entry) && realpathSync(actualPath) === actualPath
			&& corpusDirectoryMatches(context.directory);
	} catch {
		return false;
	}
}

function decodeRuntime(raw: unknown, context: RuntimeDecodeContext): CanonicalSlateRuntime {
	try {
		return decodeCanonicalRuntime({
			runtime: raw,
			externalIdentity: context.metadata.identity,
			expectedIdentity: context.metadata.identity,
			namespaceName: context.metadata.name,
			namespaceDirectory: context.canonicalDirectory,
			artifactPathAllowed: (_kind, path) => existingCanonicalArtifact(context, path),
		});
	} catch (error) {
		if (error instanceof CanonicalRuntimeDecodeError) refuse(error.message, error);
		throw error;
	}
}

function validateState(raw: unknown, context: RuntimeDecodeContext): DurableSessionState {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		refuse("slate refused durable session state that is not an object");
	}
	const value = raw as Record<string, unknown>;
	if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
		refuse("slate refused an invalid durable session generation");
	}
	if (!isOwnerSessionDigest(value.lastWriterSessionDigest)) {
		refuse("slate refused durable session state with invalid writer provenance");
	}
	let status: DurableSessionStatus;
	let terminalAt: string | undefined;
	if (value.status === "active") {
		if (!exactKeys(value, ["generation", "status", "lastWriterSessionDigest", "runtime"])) {
			refuse("slate refused malformed active durable session state");
		}
		status = "active";
	} else if (value.status === "delivered" || value.status === "abandoned") {
		if (!exactKeys(value, ["generation", "status", "terminalAt", "lastWriterSessionDigest", "runtime"])
			|| !canonicalTimestamp(value.terminalAt)) {
			refuse("slate refused malformed terminal durable session state");
		}
		status = value.status;
		terminalAt = value.terminalAt;
	} else {
		refuse("slate refused an unsupported durable session status");
	}
	const runtime = decodeRuntime(value.runtime, context);
	const base = {
		generation: value.generation as number,
		lastWriterSessionDigest: value.lastWriterSessionDigest,
		runtime,
	};
	return status === "active"
		? { ...base, status }
		: { ...base, status, terminalAt: terminalAt! };
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

function readJsonFile(file: string, directory: HeldCorpusDirectory, maxBytes: number): unknown {
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
		if (!singleNamedRecord(held) || held.size > maxBytes || !singleNamedRecord(current)
			|| !sameFileIdentity(held, current!) || !corpusDirectoryMatches(directory)) {
			refuse("slate refused a linked, oversized, or changing durable session record");
		}
		const bytes = Buffer.alloc(maxBytes + 1);
		let used = 0;
		while (used < bytes.byteLength) {
			const count = readSync(fd, bytes, used, bytes.byteLength - used, null);
			if (count === 0) break;
			used += count;
		}
		if (used > maxBytes) refuse("slate refused an oversized durable session record");
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

/**
 * Create one staged record file exclusively and make its bytes durable.
 *
 * It is the ONE exclusive-create path of this module. `writeExclusiveJson` uses
 * it for the two JSON records, and the research log of a new Slate session uses
 * it with empty content (Track 15 goal 1). One shared path keeps the link, the
 * symbolic link and the replacement refusals identical for every staged record.
 */
function writeExclusiveContent(
	file: string,
	content: string,
	directory: HeldCorpusDirectory,
	maxBytes: number,
	hooks?: DurableSessionHooks,
): Stats {
	if (dirname(file) !== directory.path || !corpusDirectoryMatches(directory)) {
		refuse("slate refused a durable session write outside its namespace");
	}
	if (Buffer.byteLength(content, "utf8") > maxBytes) refuse("slate refused an oversized durable session record");
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

/** One staged JSON record, through the shared exclusive-create path above. */
function writeExclusiveJson(
	file: string,
	value: unknown,
	directory: HeldCorpusDirectory,
	maxBytes: number,
	hooks?: DurableSessionHooks,
): Stats {
	return writeExclusiveContent(file, `${JSON.stringify(value, null, 2)}\n`, directory, maxBytes, hooks);
}

function sameMetadata(left: DurableSessionMetadata, right: DurableSessionMetadata): boolean {
	return METADATA_KEYS.every((key) => left[key] === right[key]);
}

function sameState(left: DurableSessionState, right: DurableSessionState): boolean {
	return left.generation === right.generation && left.status === right.status
		&& left.lastWriterSessionDigest === right.lastWriterSessionDigest
		&& JSON.stringify(left.runtime) === JSON.stringify(right.runtime)
		&& (left.status === "active" || (right.status !== "active" && left.terminalAt === right.terminalAt));
}

/**
 * The staged research log must be one plain, unshared, unlinked file.
 *
 * CREATION TIME ONLY. A staged research log can be replaced between its write
 * and the publishing rename, and a symbolic link there would send a worker's
 * write outside the session directory, because Pi's write tool follows a link.
 * This check refuses a symbolic link, a hard link, a directory and a missing
 * file at that moment.
 *
 * READ TIME NEVER USES IT. A user is invited to read the research log, and many
 * editors replace a file instead of rewriting it. A read-time requirement or a
 * read-time identity check would turn ordinary editing into an unreadable Slate
 * session. A missing research log at read time is acceptable, because a worker
 * recreates the file at the path Slate gives.
 */
function assertRequiredResearchLog(directory: HeldCorpusDirectory): void {
	const path = join(directory.path, RESEARCH_LOG_FILENAME);
	const entry = lstatSync(path, { throwIfNoEntry: false });
	if (!singleNamedRecord(entry) || realpathSync(path) !== path || !corpusDirectoryMatches(directory)) {
		refuse("slate refused a missing, linked, or non-regular durable session research log");
	}
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
	/** Creation only. A sibling scan and a state replacement leave it "ignored". */
	researchLog: "required" | "ignored" = "ignored",
): { metadata: DurableSessionMetadata; state: DurableSessionState } {
	if (!corpusDirectoryMatches(directory)) refuse("slate refused a changing durable session namespace");
	assertRequiredDirectories(directory);
	if (researchLog === "required") assertRequiredResearchLog(directory);
	const metadata = validateMetadata(
		readJsonFile(join(directory.path, "session.json"), directory, METADATA_MAX_BYTES),
		project,
		name,
	);
	const state = validateState(
		readJsonFile(join(directory.path, "state.json"), directory, STATE_MAX_BYTES),
		{ metadata, directory, canonicalDirectory: sessionDirectory(project, name) },
	);
	if (expectedMetadata !== undefined && !sameMetadata(metadata, expectedMetadata)) {
		refuse("slate refused durable session metadata modified before publication");
	}
	if (expectedState !== undefined && !sameState(state, expectedState)) {
		refuse("slate refused durable session state modified before publication");
	}
	return { metadata, state };
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
			readJsonFile(join(directory, "session.json"), held, METADATA_MAX_BYTES),
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
		const state = validateState(
			readJsonFile(join(directory, "state.json"), held, STATE_MAX_BYTES),
			{ metadata, directory: held, canonicalDirectory: directory },
		);
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
	creatorSessionDigest: string;
	runtime: CanonicalSlateRuntime;
	project?: CorpusProject;
	corpusName?: unknown;
	now?: Date;
	hooks?: DurableSessionHooks;
}): DurableSessionRecord {
	if (!isSlateSessionId(options.identity)) refuse("slate refused an invalid durable session identity");
	if (!isSlateSessionName(options.name)) refuse("slate refused an invalid durable session name");
	if (!isOwnerSessionDigest(options.creatorSessionDigest)) refuse("slate refused invalid durable session creation provenance");
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
		creatorSessionDigest: options.creatorSessionDigest,
	};
	validateMetadata(metadata, project, options.name, options.identity);
	const directory = sessionDirectory(project, options.name);
	const projectHeld = holdCorpusDirectory(project.directory);
	let stagingHeld: HeldCorpusDirectory | undefined;
	let stagedState: DurableSessionState | undefined;
	let publicationVisible = false;
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
		const stagedRuntime = decodeRuntime(options.runtime, {
			metadata,
			directory: stagingHeld,
			canonicalDirectory: directory,
		});
		// Track 15 goal 1: EVERY session directory holds one research log, and Slate
		// creates it here. No worker has a reliable path before this transition.
		// No hooks are passed. The research log carries no JSON record, so the record
		// seams of the two JSON writes keep their existing call counts.
		const researchLogFile = join(staging, RESEARCH_LOG_FILENAME);
		options.hooks?.beforeResearchLogWrite?.(researchLogFile);
		writeExclusiveContent(researchLogFile, "", stagingHeld, 0);
		stagedState = {
			generation: 0,
			status: "active",
			lastWriterSessionDigest: options.creatorSessionDigest,
			runtime: stagedRuntime,
		};
		writeExclusiveJson(join(staging, "session.json"), metadata, stagingHeld, METADATA_MAX_BYTES, options.hooks);
		writeExclusiveJson(join(staging, "state.json"), stagedState, stagingHeld, STATE_MAX_BYTES, options.hooks);
		syncDirectory(stagingHeld, "staged-namespace", options.hooks);
		syncDirectory(projectHeld, "project-before-publication", options.hooks);
		options.hooks?.beforeNamespacePublish?.(staging);
		if (!corpusDirectoryMatches(stagingHeld) || !corpusDirectoryMatches(projectHeld)) {
			refuse("slate refused a changing staged durable session namespace");
		}
		// "required" here is the guard against a staged research log replaced after its
		// write: the check runs after the last test seam and before the rename.
		validateNamespace(project, options.name, stagingHeld, metadata, stagedState, "required");
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
		publicationVisible = true;
		stagingHeld.path = directory;
		if (!corpusDirectoryMatches(stagingHeld) || !corpusDirectoryMatches(projectHeld)) {
			refuse("slate refused a durable session namespace modified during publication");
		}
		const committed = validateNamespace(project, options.name, stagingHeld, metadata, stagedState, "required");
		syncDirectory(projectHeld, "project-after-publication", options.hooks);
		return { directory, metadata: committed.metadata, state: committed.state };
	} catch (error) {
		if (publicationVisible && stagingHeld !== undefined) {
			let record: DurableSessionRecord | undefined;
			let cause = error;
			try {
				const reconciled = validateNamespace(project, options.name, stagingHeld, metadata, undefined, "required");
				record = { directory, metadata: reconciled.metadata, state: reconciled.state };
			} catch (reconcileError) {
				cause = new AggregateError([error, reconcileError], "visible durable session publication could not be reconciled");
			}
			throw new DurableCommitUncertain("create", record, cause);
		}
		throw error instanceof SlateWriteRefused
			? error
			: new SlateWriteRefused("slate could not publish its durable session namespace", { cause: error });
	} finally {
		/* Hostile replacement makes pathname cleanup unsafe. Private failed staging remains ignored. */
		if (stagingHeld !== undefined) closeSync(stagingHeld.fd);
		closeSync(projectHeld.fd);
	}
}

/** Validate one durable namespace name and identity without claiming access. */
export function validateSessionNamespace(
	project: CorpusProject,
	name: string,
	identity: string | undefined,
): boolean {
	try {
		readDurableSession({ project, name, ...(identity === undefined ? {} : { identity }) });
		return true;
	} catch {
		return false;
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
	writerSessionDigest: string;
	nextStatus?: DurableSessionStatus;
	runtime?: CanonicalSlateRuntime;
	terminalAt?: string;
	hooks?: DurableSessionHooks;
}): DurableSessionRecord {
	if (!isOwnerSessionDigest(options.writerSessionDigest)) {
		refuse("slate refused invalid durable writer provenance");
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
	let publicationVisible = false;
	try {
		const nextGeneration = opened.state.generation === Number.MAX_SAFE_INTEGER
			? opened.state.generation
			: opened.state.generation + 1;
		const nextStatus = options.nextStatus ?? opened.state.status;
		const runtime = options.runtime === undefined
			? opened.state.runtime
			: decodeRuntime(options.runtime, {
				metadata: opened.metadata,
				directory: opened.held,
				canonicalDirectory: opened.directory,
			});
		let candidate: DurableSessionState;
		if (nextStatus === "active") {
			candidate = {
				generation: nextGeneration,
				status: "active",
				lastWriterSessionDigest: options.writerSessionDigest,
				runtime,
			};
		} else {
			const terminalAt = options.terminalAt
				?? (opened.state.status === "active" ? undefined : opened.state.terminalAt);
			if (terminalAt === undefined || !canonicalTimestamp(terminalAt)) {
				refuse("slate refused terminal history without a valid time");
			}
			candidate = {
				generation: nextGeneration,
				status: nextStatus,
				terminalAt,
				lastWriterSessionDigest: options.writerSessionDigest,
				runtime,
			};
		}
		stagingStat = writeExclusiveJson(staging, candidate, projectHeld, STATE_MAX_BYTES, options.hooks);
		syncDirectory(projectHeld, "staged-state", options.hooks);
		options.hooks?.beforeStatePublish?.();
		const currentMetadata = validateMetadata(
			readJsonFile(join(opened.directory, "session.json"), opened.held, METADATA_MAX_BYTES),
			options.project,
			options.name,
			options.identity,
		);
		if (!sameMetadata(currentMetadata, opened.metadata)) {
			refuse("slate refused durable session metadata modified during state replacement");
		}
		const stagedBeforeRename = lstatSync(staging, { throwIfNoEntry: false });
		if (!singleNamedRecord(stagedBeforeRename) || !sameFileIdentity(stagingStat, stagedBeforeRename!)
			|| !corpusDirectoryMatches(projectHeld) || !corpusDirectoryMatches(opened.held)) {
			refuse("slate refused a linked or changing staged durable session state");
		}
		/* Caller-controlled exclusive access is the only same-session sequencing rule. */
		renameSync(staging, stateFile);
		publicationVisible = true;
		options.hooks?.afterStatePublish?.();
		const published = lstatSync(stateFile, { throwIfNoEntry: false });
		if (!singleNamedRecord(published) || !corpusDirectoryMatches(opened.held)
			|| !corpusDirectoryMatches(projectHeld)) {
			refuse("slate refused durable session state modified during replacement");
		}
		syncDirectory(opened.held, "published-state", options.hooks);
		syncDirectory(projectHeld, "project-after-state-publication", options.hooks);
		const committed = validateNamespace(
			options.project,
			options.name,
			opened.held,
			opened.metadata,
		);
		return { directory: opened.directory, metadata: committed.metadata, state: committed.state };
	} catch (error) {
		if (publicationVisible) {
			let record: DurableSessionRecord | undefined;
			let cause = error;
			try {
				const reconciled = validateNamespace(
					options.project,
					options.name,
					opened.held,
					opened.metadata,
				);
				record = { directory: opened.directory, metadata: reconciled.metadata, state: reconciled.state };
			} catch (reconcileError) {
				cause = new AggregateError([error, reconcileError], "visible durable state replacement could not be reconciled");
			}
			throw new DurableCommitUncertain("update", record, cause);
		}
		throw error instanceof SlateWriteRefused
			? error
			: new SlateWriteRefused("slate could not replace durable session state", { cause: error });
	} finally {
		/* Failed staging remains ignored. Recovery does not treat it as authority. */
		closeSync(projectHeld.fd);
		closeSync(opened.held.fd);
	}
}

export function updateDurableSession(options: {
	project: CorpusProject;
	name: string;
	identity: string;
	cwd: string;
	writerSessionDigest: string;
	runtime: CanonicalSlateRuntime;
	hooks?: DurableSessionHooks;
}): DurableSessionRecord {
	return replaceState(options);
}

export function closeDurableSession(options: {
	project: CorpusProject;
	name: string;
	identity: string;
	cwd: string;
	writerSessionDigest: string;
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
	return replaceState({
		project: options.project,
		name: options.name,
		identity: options.identity,
		cwd: options.cwd,
		writerSessionDigest: options.writerSessionDigest,
		nextStatus: options.outcome,
		terminalAt,
		...(options.hooks === undefined ? {} : { hooks: options.hooks }),
	});
}
