import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	opendirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./model-profiles.ts";
import {
	ADOPTED_EPISODE_FIELDS,
	ADOPTED_THREAD_FIELDS,
	OWNER_SESSION_DIGEST_PATTERN,
	SLATE_SESSION_ID_PATTERN,
	sanitizeEpisodeRecord,
	sanitizeThreadRecord,
	type SlateSessionParent,
	type SlateSnapshot,
} from "./state.ts";
import {
	insideRoot,
	isContainedOrMissingFile,
	isContainedOrMissingThreadFile,
	resolveCorpusProject,
	validateCorpusSession,
	type CorpusProject,
} from "./corpus.ts";
import { isSlateSessionName } from "./session-names.ts";

const HANDOFF_MAX_BYTES = 1024 * 1024;
const HANDOFF_MAX_THREADS = 512;
const HANDOFF_MAX_EPISODES = 4096;
const HANDOFF_MAX_DEPTH = 8;
const HANDOFF_MAX_WIRE_STRING_BYTES = 8192;
const HANDOFF_MAX_PARENTS = 256;
const HANDOFF_MAX_CANDIDATES = 64;
const HANDOFF_MAX_CANDIDATE_BYTES = 4 * HANDOFF_MAX_BYTES;
const HANDOFF_MAX_SCAN_ENTRIES = 4096;
const HANDOFF_MAX_STAGING_RESIDUE = 64;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY_ONLY = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;

export interface CorpusHandoffRecord {
	version: 1;
	author: SlateSessionParent;
	authorSessionDirectory: string;
	createdAt: number;
	worktreePath: string;
	branchLabel: string;
	parentChain: SlateSessionParent[];
	brief: string;
	focus?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	snapshot: SlateSnapshot;
}

export type HandoffRecordReadResult =
	| { ok: true; record: CorpusHandoffRecord; file: string; authorSessionDirectory: string }
	| { ok: false; reason: string };

export interface HandoffCandidate {
	name: string;
	result: HandoffRecordReadResult;
}

type WireString = string | string[];
type WireObject = Record<string, unknown>;

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

export function handoffTreeWithinDepth(value: unknown, depth = 0): boolean {
	if (depth > HANDOFF_MAX_DEPTH) return false;
	if (typeof value === "string" || value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((entry) => handoffTreeWithinDepth(entry, depth + 1));
	if (!object(value)) return false;
	return Object.values(value).every((entry) => handoffTreeWithinDepth(entry, depth + 1));
}

function encodeWireString(value: string): WireString {
	if (Buffer.byteLength(value, "utf8") <= HANDOFF_MAX_WIRE_STRING_BYTES) return value;
	const chunks: string[] = [];
	let chunk = "";
	let chunkBytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (chunk !== "" && chunkBytes + characterBytes > HANDOFF_MAX_WIRE_STRING_BYTES) {
			chunks.push(chunk);
			chunk = character;
			chunkBytes = characterBytes;
		} else {
			chunk += character;
			chunkBytes += characterBytes;
		}
	}
	if (chunk !== "") chunks.push(chunk);
	return chunks;
}

function encodeWireValue(value: unknown): unknown {
	if (typeof value === "string") return encodeWireString(value);
	if (Array.isArray(value)) return value.map(encodeWireValue);
	if (!object(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeWireValue(entry)]));
}

function validWireString(value: unknown): value is WireString {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= HANDOFF_MAX_WIRE_STRING_BYTES;
	return Array.isArray(value) && value.length >= 2 && value.every((entry) =>
		typeof entry === "string" && entry !== "" && Buffer.byteLength(entry, "utf8") <= HANDOFF_MAX_WIRE_STRING_BYTES,
	);
}

const ROOT_KEYS = ["version", "author", "authorSessionDirectory", "createdAt", "worktreePath", "branchLabel", "parentChain", "brief", "focus", "model", "thinkingLevel", "snapshot"] as const;
const SNAPSHOT_KEYS = ["threads", "episodes", "threadSeq", "slateSessionId", "slateSessionName", "ownerSessionDigest", "slateSessionParentChain", "orchestratorMode", "paused", "workerCostUsd", "carriedCostUsd"] as const;
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const THREAD_STRING_KEYS = new Set(["id", "name", "sessionFile", "forkedFrom", "status", "type", "restartOf", "supersededBy", "model", "baseModel", "baseEffort"]);
const EPISODE_STRING_KEYS = new Set(["id", "threadId", "task", "status", "file", "model", "effort"]);

function validWireObject(value: unknown, allowed: readonly string[], required: readonly string[]): value is WireObject {
	return object(value) && exactKeys(value, allowed, required);
}

function validateWireParent(value: unknown): boolean {
	return validWireObject(value, ["identity", "name"], ["identity", "name"])
		&& validWireString(value.identity) && validWireString(value.name);
}

function validateWireUsage(value: unknown): boolean {
	return validWireObject(value, USAGE_KEYS, []) && Object.values(value).every((entry) => typeof entry === "number");
}

function validateWireObservation(value: unknown): boolean {
	if (!object(value) || typeof value.stored !== "boolean") return false;
	if (value.stored) {
		return validWireObject(value, ["stored", "path", "bytes", "truncated", "grammar"], ["stored", "path", "bytes", "truncated", "grammar"])
			&& validWireString(value.path) && validWireString(value.grammar);
	}
	return validWireObject(value, ["stored", "reason", "grammar"], ["stored", "reason", "grammar"])
		&& validWireString(value.reason) && validWireString(value.grammar);
}

function validateWireThread(value: unknown): boolean {
	if (!validWireObject(value, Object.keys(ADOPTED_THREAD_FIELDS), ["id", "name", "sessionFile", "status", "episodeIds", "episodeSeq", "createdAt", "updatedAt"])) return false;
	for (const [key, entry] of Object.entries(value)) {
		if (THREAD_STRING_KEYS.has(key) && !validWireString(entry)) return false;
		if ((key === "episodeIds" || key === "tools") && (!Array.isArray(entry) || !entry.every(validWireString))) return false;
		if (!THREAD_STRING_KEYS.has(key) && key !== "episodeIds" && key !== "tools" && object(entry)) return false;
	}
	return true;
}

function validateWireEpisode(value: unknown): boolean {
	if (!validWireObject(value, Object.keys(ADOPTED_EPISODE_FIELDS), ["id", "threadId", "task", "status", "file", "createdAt"])) return false;
	for (const [key, entry] of Object.entries(value)) {
		if (EPISODE_STRING_KEYS.has(key) && !validWireString(entry)) return false;
		if ((key === "compressorUsage" || key === "compactionUsage") && !validateWireUsage(entry)) return false;
		if (key === "observations" && !validateWireObservation(entry)) return false;
		if (!EPISODE_STRING_KEYS.has(key) && key !== "compressorUsage" && key !== "compactionUsage" && key !== "observations" && object(entry)) return false;
	}
	return true;
}

function validateWireSnapshot(value: unknown): boolean {
	if (!validWireObject(value, SNAPSHOT_KEYS, ["threads", "episodes", "orchestratorMode", "paused", "workerCostUsd", "carriedCostUsd"])) return false;
	if (!Array.isArray(value.threads) || !value.threads.every(validateWireThread)) return false;
	if (!Array.isArray(value.episodes) || !value.episodes.every(validateWireEpisode)) return false;
	for (const key of ["slateSessionId", "slateSessionName", "ownerSessionDigest"] as const) {
		if (value[key] !== undefined && !validWireString(value[key])) return false;
	}
	return value.slateSessionParentChain === undefined
		|| (Array.isArray(value.slateSessionParentChain) && value.slateSessionParentChain.every(validateWireParent));
}

function validateWireRecord(value: unknown): value is WireObject {
	if (!handoffTreeWithinDepth(value) || !validWireObject(value, ROOT_KEYS, ["version", "author", "authorSessionDirectory", "createdAt", "worktreePath", "branchLabel", "parentChain", "brief", "snapshot"])) return false;
	if (value.version !== 2 || !validateWireParent(value.author) || !validateWireSnapshot(value.snapshot)) return false;
	for (const key of ["authorSessionDirectory", "worktreePath", "branchLabel", "brief", "focus", "thinkingLevel"] as const) {
		if (value[key] !== undefined && !validWireString(value[key])) return false;
	}
	if (!Array.isArray(value.parentChain) || !value.parentChain.every(validateWireParent)) return false;
	return value.model === undefined || (validWireObject(value.model, ["provider", "id"], ["provider", "id"])
		&& validWireString(value.model.provider) && validWireString(value.model.id));
}

function decodeWireString(value: WireString): string {
	return typeof value === "string" ? value : value.join("");
}

function decodeWireValue(value: unknown, stringKeys: Set<string>): unknown {
	if (!object(value)) return value;
	const decoded: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (stringKeys.has(key)) decoded[key] = decodeWireString(entry as WireString);
		else if (key === "episodeIds" || key === "tools") decoded[key] = (entry as WireString[]).map(decodeWireString);
		else if (key === "threads") decoded[key] = (entry as WireObject[]).map((item) => decodeWireValue(item, THREAD_STRING_KEYS));
		else if (key === "episodes") decoded[key] = (entry as WireObject[]).map((item) => decodeWireValue(item, EPISODE_STRING_KEYS));
		else if (key === "parentChain" || key === "slateSessionParentChain") decoded[key] = (entry as WireObject[]).map((item) => decodeWireValue(item, new Set(["identity", "name"])));
		else if (key === "author") decoded[key] = decodeWireValue(entry, new Set(["identity", "name"]));
		else if (key === "model") decoded[key] = decodeWireValue(entry, new Set(["provider", "id"]));
		else if (key === "snapshot") decoded[key] = decodeWireValue(entry, new Set(["slateSessionId", "slateSessionName", "ownerSessionDigest"]));
		else if (key === "observations") decoded[key] = decodeWireValue(entry, new Set(["path", "reason", "grammar", "warning"]));
		else decoded[key] = entry;
	}
	return decoded;
}

function validParent(value: unknown): value is SlateSessionParent {
	return object(value) && exactKeys(value, ["identity", "name"], ["identity", "name"])
		&& typeof value.identity === "string" && SLATE_SESSION_ID_PATTERN.test(value.identity)
		&& isSlateSessionName(value.name);
}

function validThread(value: unknown): boolean {
	if (!object(value)) return false;
	const allowed = Object.keys(ADOPTED_THREAD_FIELDS);
	const required = ["id", "name", "sessionFile", "status", "episodeIds", "episodeSeq", "createdAt", "updatedAt"];
	if (!exactKeys(value, allowed, required)) return false;
	const repairs: string[] = [];
	const parsed = sanitizeThreadRecord(value, repairs);
	return parsed !== undefined && repairs.length === 0
		&& (value.status === "idle" || value.status === "running")
		&& Array.isArray(value.episodeIds) && value.episodeIds.every((id) => typeof id === "string");
}

function validEpisode(value: unknown): boolean {
	if (!object(value)) return false;
	const allowed = Object.keys(ADOPTED_EPISODE_FIELDS);
	const required = ["id", "threadId", "task", "status", "file", "createdAt"];
	if (!exactKeys(value, allowed, required)) return false;
	const repairs: string[] = [];
	return sanitizeEpisodeRecord(value, repairs) !== undefined && repairs.length === 0;
}

function validSnapshotGraph(value: SlateSnapshot): boolean {
	const threads = new Map(value.threads.map((thread) => [thread.id, thread]));
	let maxThreadOrdinal = 0;
	for (const thread of value.threads) {
		const ordinal = /^t([1-9]\d*)$/u.exec(thread.id);
		if (ordinal !== null) {
			const parsed = Number(ordinal[1]);
			if (!Number.isSafeInteger(parsed)) return false;
			maxThreadOrdinal = Math.max(maxThreadOrdinal, parsed);
		}
		for (const id of thread.episodeIds) {
			const prefix = `${thread.id}.e`;
			if (!id.startsWith(prefix)) return false;
			const suffix = id.slice(prefix.length);
			if (!/^[1-9]\d*$/u.test(suffix)) return false;
			const episodeOrdinal = Number(suffix);
			if (!Number.isSafeInteger(episodeOrdinal) || episodeOrdinal > thread.episodeSeq) return false;
		}
		if (thread.restartOf !== undefined) {
			const source = threads.get(thread.restartOf);
			if (source === undefined || source.supersededBy !== thread.id) return false;
			if (thread.restartGeneration !== (source.restartGeneration ?? 0) + 1) return false;
		}
		if (thread.supersededBy !== undefined) {
			const successor = threads.get(thread.supersededBy);
			if (successor?.restartOf !== thread.id) return false;
		}
		const visited = new Set<string>([thread.id]);
		let ancestor = thread.restartOf;
		while (ancestor !== undefined) {
			if (visited.has(ancestor)) return false;
			visited.add(ancestor);
			ancestor = threads.get(ancestor)?.restartOf;
		}
	}
	return (value.threadSeq ?? 0) >= maxThreadOrdinal;
}

function validSnapshot(value: unknown): value is SlateSnapshot {
	if (!object(value)) return false;
	const allowed = [
		"threads", "episodes", "threadSeq", "slateSessionId", "slateSessionName", "ownerSessionDigest", "slateSessionParentChain",
		"orchestratorMode", "paused", "workerCostUsd", "carriedCostUsd",
	];
	const required = ["threads", "episodes", "orchestratorMode", "paused", "workerCostUsd", "carriedCostUsd"];
	if (!exactKeys(value, allowed, required) || !Array.isArray(value.threads) || !Array.isArray(value.episodes)) return false;
	if (value.threads.length > HANDOFF_MAX_THREADS || value.episodes.length > HANDOFF_MAX_EPISODES) return false;
	if (!value.threads.every(validThread) || !value.episodes.every(validEpisode)) return false;
	const threadIds = new Set(value.threads.map((thread) => thread.id));
	const episodeIds = new Set(value.episodes.map((episode) => episode.id));
	if (threadIds.size !== value.threads.length || episodeIds.size !== value.episodes.length) return false;
	if (value.episodes.some((episode) => !threadIds.has(episode.threadId))) return false;
	for (const thread of value.threads) {
		if (new Set(thread.episodeIds).size !== thread.episodeIds.length) return false;
		if (thread.episodeIds.some((id: string) => !episodeIds.has(id))) return false;
		if (value.episodes.some((episode) => episode.threadId === thread.id && !thread.episodeIds.includes(episode.id))) return false;
	}
	if (!validSnapshotGraph(value as unknown as SlateSnapshot)) return false;
	if (typeof value.orchestratorMode !== "boolean" || typeof value.paused !== "boolean") return false;
	if (typeof value.workerCostUsd !== "number" || !Number.isFinite(value.workerCostUsd) || value.workerCostUsd < 0) return false;
	if (typeof value.carriedCostUsd !== "number" || !Number.isFinite(value.carriedCostUsd) || value.carriedCostUsd < 0) return false;
	if (value.threadSeq !== undefined && !(typeof value.threadSeq === "number" && Number.isSafeInteger(value.threadSeq) && value.threadSeq >= 0)) return false;
	if (value.slateSessionId !== undefined && !(typeof value.slateSessionId === "string" && SLATE_SESSION_ID_PATTERN.test(value.slateSessionId))) return false;
	if (value.slateSessionName !== undefined && !isSlateSessionName(value.slateSessionName)) return false;
	if (value.ownerSessionDigest !== undefined && !(typeof value.ownerSessionDigest === "string" && OWNER_SESSION_DIGEST_PATTERN.test(value.ownerSessionDigest))) return false;
	if (value.slateSessionParentChain !== undefined && (!Array.isArray(value.slateSessionParentChain) || !value.slateSessionParentChain.every(validParent))) return false;
	return true;
}

function validateRecord(value: unknown): CorpusHandoffRecord | undefined {
	if (!handoffTreeWithinDepth(value) || !object(value)) return undefined;
	const allowed = [
		"version", "author", "authorSessionDirectory", "createdAt", "worktreePath", "branchLabel",
		"parentChain", "brief", "focus", "model", "thinkingLevel", "snapshot",
	];
	const required = [
		"version", "author", "authorSessionDirectory", "createdAt", "worktreePath", "branchLabel",
		"parentChain", "brief", "snapshot",
	];
	if (!exactKeys(value, allowed, required) || value.version !== 1 || !validParent(value.author)) return undefined;
	if (typeof value.authorSessionDirectory !== "string" || typeof value.worktreePath !== "string") return undefined;
	if (typeof value.branchLabel !== "string" || typeof value.brief !== "string") return undefined;
	if (value.focus !== undefined && typeof value.focus !== "string") return undefined;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
	if (!Array.isArray(value.parentChain) || value.parentChain.length > HANDOFF_MAX_PARENTS || !value.parentChain.every(validParent)) return undefined;
	if (value.model !== undefined) {
		if (!object(value.model) || !exactKeys(value.model, ["provider", "id"], ["provider", "id"])) return undefined;
		if (typeof value.model.provider !== "string" || value.model.provider === "") return undefined;
		if (typeof value.model.id !== "string" || value.model.id === "") return undefined;
	}
	if (value.thinkingLevel !== undefined && typeof value.thinkingLevel !== "string") return undefined;
	if (!validSnapshot(value.snapshot)) return undefined;
	if (value.snapshot.slateSessionId !== value.author.identity || value.snapshot.slateSessionName !== value.author.name) return undefined;
	if (JSON.stringify(value.snapshot.slateSessionParentChain ?? []) !== JSON.stringify(value.parentChain)) return undefined;
	return value as unknown as CorpusHandoffRecord;
}

export function corpusHandoffFile(project: CorpusProject, name: string): string {
	return join(project.directory, "pending", `${name}.json`);
}

function sameFile(a: ReturnType<typeof fstatSync>, b: NonNullable<ReturnType<typeof lstatSync>>): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/**
 * D215: pin the directory identity and compare its pathname before and after every
 * child operation. This rejects static links and one-way replacement. Node exposes
 * no portable openat-style child open, so a same-inode replace-and-restore ABA race
 * remains accepted. Do not remove these checks on the grounds that ABA remains.
 */
type HeldDirectory = { fd: number; stat: ReturnType<typeof fstatSync>; path: string };

function directoryMatches(held: HeldDirectory): boolean {
	try {
		const current = lstatSync(held.path, { throwIfNoEntry: false });
		return held.stat.isDirectory() && current?.isDirectory() === true && !current.isSymbolicLink()
			&& sameFile(held.stat, current) && realpathSync(held.path) === held.path;
	} catch {
		return false;
	}
}

function holdDirectory(path: string): HeldDirectory {
	const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | DIRECTORY_ONLY);
	const held = { fd, stat: fstatSync(fd), path };
	if (!directoryMatches(held)) {
		closeSync(fd);
		throw new Error("slate refused a linked or changing handoff directory");
	}
	return held;
}

function holdDirectoryPair(firstPath: string, secondPath: string): [HeldDirectory, HeldDirectory] {
	const first = holdDirectory(firstPath);
	try {
		return [first, holdDirectory(secondPath)];
	} catch (error) {
		closeSync(first.fd);
		throw error;
	}
}

export function fsyncHeldDirectory(held: HeldDirectory): void {
	try { fsyncSync(held.fd); }
	catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
	}
}

export interface HandoffDurabilityOperations {
	fsyncFile: typeof fsyncSync;
	fsyncDirectory: typeof fsyncHeldDirectory;
}

export const DEFAULT_HANDOFF_DURABILITY_OPERATIONS: Readonly<HandoffDurabilityOperations> = Object.freeze({
	fsyncFile: fsyncSync,
	fsyncDirectory: fsyncHeldDirectory,
});

interface HandoffWriteHooks {
	afterPendingOpen?: () => void;
}

function validLineage(record: CorpusHandoffRecord): boolean {
	const identities = new Set<string>();
	const names = new Set<string>();
	for (const parent of record.parentChain) {
		if (parent.identity === record.author.identity || parent.name === record.author.name) return false;
		if (identities.has(parent.identity) || names.has(parent.name)) return false;
		identities.add(parent.identity);
		names.add(parent.name);
	}
	return true;
}

export function readCorpusHandoffRecord(options: {
	cwd: string;
	name: string;
	isTrusted: () => boolean;
	project?: CorpusProject;
	/** Deterministic race-injection seam. Production callers omit it. */
	afterPendingOpen?: () => void;
}): HandoffRecordReadResult {
	// D104 and D214: trust is consulted before path resolution, file metadata, or parsing.
	if (!options.isTrusted()) return { ok: false, reason: "slate refused handoff adoption because this project is not trusted" };
	if (!isSlateSessionName(options.name)) return { ok: false, reason: "slate refused an invalid handoff session name" };
	let fd: number | undefined;
	let pendingHeld: HeldDirectory | undefined;
	try {
		const project = options.project ?? resolveCorpusProject(options.cwd);
		const pendingDirectory = join(project.directory, "pending");
		const pendingEntry = lstatSync(pendingDirectory, { throwIfNoEntry: false });
		if (pendingEntry === undefined) return { ok: false, reason: `slate found no handoff record named ${options.name}` };
		if (!pendingEntry.isDirectory() || pendingEntry.isSymbolicLink() || realpathSync(pendingDirectory) !== pendingDirectory) {
			return { ok: false, reason: "slate refused a linked or invalid handoff directory" };
		}
		pendingHeld = holdDirectory(pendingDirectory);
		options.afterPendingOpen?.();
		if (!directoryMatches(pendingHeld)) return { ok: false, reason: "slate refused a changing handoff directory" };
		const file = corpusHandoffFile(project, options.name);
		fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
		if (!directoryMatches(pendingHeld)) return { ok: false, reason: "slate refused a changing handoff directory" };
		const held = fstatSync(fd);
		const current = lstatSync(file, { throwIfNoEntry: false });
		if (!held.isFile() || !current?.isFile() || current.isSymbolicLink() || !sameFile(held, current)) {
			return { ok: false, reason: "slate refused a linked or changing handoff record" };
		}
		// D133 and D214: reject the byte count before JSON parsing.
		if (held.size > HANDOFF_MAX_BYTES) return { ok: false, reason: "slate refused a handoff record larger than 1 MiB" };
		const bytes = readFileSync(fd);
		if (bytes.byteLength > HANDOFF_MAX_BYTES) return { ok: false, reason: "slate refused a handoff record larger than 1 MiB" };
		let text: string;
		try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
		catch { return { ok: false, reason: "slate refused handoff bytes that are not valid UTF-8" }; }
		let raw: unknown;
		try { raw = JSON.parse(text); }
		catch { return { ok: false, reason: "slate refused malformed handoff JSON" }; }
		let runtimeRaw = raw;
		if (object(raw) && raw.version === 2) {
			if (!validateWireRecord(raw)) return { ok: false, reason: "slate refused a version 2 handoff record that does not match its wire schema or bounds" };
			runtimeRaw = decodeWireValue(raw, new Set(["authorSessionDirectory", "worktreePath", "branchLabel", "brief", "focus", "thinkingLevel"]));
			(runtimeRaw as Record<string, unknown>).version = 1;
		}
		const record = validateRecord(runtimeRaw);
		if (record === undefined) return { ok: false, reason: "slate refused a handoff record that does not match its schema or bounds" };

		// D126 and D133: only validated names form followed paths. The recorded path must equal the derived path.
		const expectedDirectory = join(project.directory, record.author.name);
		if (record.authorSessionDirectory !== expectedDirectory) return { ok: false, reason: "slate refused an unexpected author session directory" };
		const projectEntry = lstatSync(project.directory, { throwIfNoEntry: false });
		const authorEntry = lstatSync(expectedDirectory, { throwIfNoEntry: false });
		if (!projectEntry?.isDirectory() || projectEntry.isSymbolicLink() || !authorEntry?.isDirectory() || authorEntry.isSymbolicLink()) {
			return { ok: false, reason: "slate refused a missing or linked author session directory" };
		}
		const projectReal = realpathSync(project.directory);
		const authorReal = realpathSync(expectedDirectory);
		if (projectReal !== project.directory || authorReal !== expectedDirectory || !insideRoot(projectReal, authorReal)) {
			return { ok: false, reason: "slate refused an author session directory outside the corpus project" };
		}
		if (!validateCorpusSession(project, record.author.name, record.author.identity)) {
			return { ok: false, reason: "slate refused author session metadata that does not match the handoff record" };
		}
		if (!validLineage(record)) {
			return { ok: false, reason: "slate refused duplicated or cyclic parent lineage" };
		}
		for (const thread of record.snapshot.threads) {
			if (thread.sessionFile !== "" && !isContainedOrMissingThreadFile(options.cwd, thread.sessionFile, project.directory)) {
				return { ok: false, reason: `slate refused thread ${thread.id} because its session file is linked or outside slate storage` };
			}
			if (thread.forkedFrom !== undefined && !isContainedOrMissingThreadFile(options.cwd, thread.forkedFrom, project.directory)) {
				return { ok: false, reason: `slate refused thread ${thread.id} because its fork source is linked or outside slate storage` };
			}
		}
		for (const episode of record.snapshot.episodes) {
			if (!isContainedOrMissingFile(options.cwd, episode.file, project.directory)) {
				return { ok: false, reason: `slate refused episode ${episode.id} because its file is linked or outside slate storage` };
			}
			if (episode.observations?.stored === true) {
				const reference = episode.observations.path;
				const sessionPrefix = `${CONFIG_DIR_NAME}/slate/sessions/`;
				const observationFile = reference.startsWith(sessionPrefix)
					? join(project.directory, reference.slice(sessionPrefix.length))
					: join(options.cwd, reference);
				if (!isContainedOrMissingFile(options.cwd, observationFile, project.directory)) {
					return { ok: false, reason: `slate refused episode ${episode.id} because its observation file is linked or outside slate storage` };
				}
			}
		}
		const after = lstatSync(file, { throwIfNoEntry: false });
		if (!after?.isFile() || after.isSymbolicLink() || !sameFile(held, after)) {
			return { ok: false, reason: "slate refused a handoff record modified during read" };
		}
		if (!directoryMatches(pendingHeld)) return { ok: false, reason: "slate refused a handoff directory modified during read" };
		return { ok: true, record, file, authorSessionDirectory: authorReal };
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") {
			return { ok: false, reason: `slate found no handoff record named ${options.name}` };
		}
		return { ok: false, reason: `slate refused the handoff record: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (pendingHeld !== undefined) closeSync(pendingHeld.fd);
	}
}

export function listCorpusHandoffCandidates(options: {
	cwd: string;
	isTrusted: () => boolean;
	project?: CorpusProject;
	/** Deterministic close-observation seam. Production callers omit it. */
	afterDirectoryClose?: (directory: ReturnType<typeof opendirSync>) => void;
}): { ok: true; candidates: HandoffCandidate[] } | { ok: false; reason: string } {
	if (!options.isTrusted()) return { ok: false, reason: "slate refused handoff listing because this project is not trusted" };
	let pendingHeld: HeldDirectory | undefined;
	let pendingDir: ReturnType<typeof opendirSync> | undefined;
	try {
		const project = options.project ?? resolveCorpusProject(options.cwd);
		const pending = join(project.directory, "pending");
		const entry = lstatSync(pending, { throwIfNoEntry: false });
		if (entry === undefined) return { ok: true, candidates: [] };
		if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(pending) !== pending) {
			return { ok: false, reason: "slate refused a linked or invalid handoff directory" };
		}
		pendingHeld = holdDirectory(pending);
		pendingDir = opendirSync(pending);
		const names: string[] = [];
		let aggregateBytes = 0;
		let scanned = 0;
		for (;;) {
			const item = pendingDir.readSync();
			if (item === null) break;
			scanned++;
			if (scanned > HANDOFF_MAX_SCAN_ENTRIES) {
				return { ok: false, reason: `slate refused handoff listing after more than ${HANDOFF_MAX_SCAN_ENTRIES} directory entries` };
			}
			if (/^\.[a-z]+-[a-z]+-[0-9a-f]{4}\.\d+\.\d+\.tmp$/u.test(item.name)) continue;
			if (!item.name.endsWith(".json")) continue;
			const name = item.name.slice(0, -5);
			if (!isSlateSessionName(name)) continue;
			names.push(name);
			if (names.length > HANDOFF_MAX_CANDIDATES) {
				return { ok: false, reason: `slate refused to list more than ${HANDOFF_MAX_CANDIDATES} handoff records` };
			}
			const entryStat = lstatSync(corpusHandoffFile(project, name), { throwIfNoEntry: false });
			aggregateBytes += entryStat?.isFile() ? entryStat.size : 0;
			if (aggregateBytes > HANDOFF_MAX_CANDIDATE_BYTES) {
				return { ok: false, reason: "slate refused handoff listing because candidate records exceed 4 MiB in aggregate" };
			}
		}
		names.sort();
		if (!directoryMatches(pendingHeld)) return { ok: false, reason: "slate refused a changing handoff directory" };
		const candidates = names.map((name) => ({
			name,
			result: readCorpusHandoffRecord({ cwd: options.cwd, name, isTrusted: () => true, project }),
		}));
		if (!directoryMatches(pendingHeld)) return { ok: false, reason: "slate refused a handoff directory modified during listing" };
		return { ok: true, candidates };
	} catch (error) {
		return { ok: false, reason: `slate could not list handoff records: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		try {
			if (pendingDir !== undefined) {
				pendingDir.closeSync();
				options.afterDirectoryClose?.(pendingDir);
			}
		} finally {
			if (pendingHeld !== undefined) closeSync(pendingHeld.fd);
		}
	}
}

export function writeCorpusHandoffRecord(
	project: CorpusProject,
	record: CorpusHandoffRecord,
	hooks: HandoffWriteHooks = {},
	durability: HandoffDurabilityOperations = DEFAULT_HANDOFF_DURABILITY_OPERATIONS,
): string {
	const validated = validateRecord(record);
	if (validated === undefined) throw new Error("slate refused to write an invalid handoff record");
	const projectEntry = lstatSync(project.directory, { throwIfNoEntry: false });
	if (!projectEntry?.isDirectory() || projectEntry.isSymbolicLink() || realpathSync(project.directory) !== project.directory) {
		throw new Error("slate refused an invalid corpus project directory");
	}
	const expectedAuthorDirectory = join(project.directory, record.author.name);
	if (record.authorSessionDirectory !== expectedAuthorDirectory || !validateCorpusSession(project, record.author.name, record.author.identity)) {
		throw new Error("slate refused handoff author metadata that does not match its corpus session");
	}
	if (!validLineage(record)) throw new Error("slate refused duplicated or cyclic handoff parent lineage");
	const projectHeld = holdDirectory(project.directory);
	const pending = join(project.directory, "pending");
	const stagingDirectory = join(project.directory, "handoff-staging");
	let createdDirectory = false;
	try {
		for (const directory of [pending, stagingDirectory]) {
			try { mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE }); createdDirectory = true; }
			catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
		}
		if (!directoryMatches(projectHeld)) throw new Error("slate refused a changing corpus project directory");
		if (createdDirectory) durability.fsyncDirectory(projectHeld);
	} finally {
		closeSync(projectHeld.fd);
	}
	const [pendingHeld, stagingDirectoryHeld] = holdDirectoryPair(pending, stagingDirectory);
	const file = corpusHandoffFile(project, record.author.name);
	const staging = join(stagingDirectory, `.${record.author.name}.${process.pid}.${Date.now()}.tmp`);
	let fd: number | undefined;
	let stagingHeld: ReturnType<typeof fstatSync> | undefined;
	try {
		hooks.afterPendingOpen?.();
		if (!directoryMatches(pendingHeld) || !directoryMatches(stagingDirectoryHeld)) throw new Error("slate refused a changing handoff directory");
		let residue = 0;
		const residueDir = opendirSync(stagingDirectory);
		try {
			for (;;) {
				const entry = residueDir.readSync();
				if (entry === null) break;
				residue++;
				if (residue > HANDOFF_MAX_STAGING_RESIDUE) throw new Error(`slate refused more than ${HANDOFF_MAX_STAGING_RESIDUE} staged handoff files`);
			}
		} finally { residueDir.closeSync(); }
		const wire = { ...(encodeWireValue(validated) as WireObject), version: 2 };
		if (!validateWireRecord(wire)) throw new Error("slate refused to encode an invalid version 2 handoff record");
		const content = `${JSON.stringify(wire)}\n`;
		if (Buffer.byteLength(content, "utf8") > HANDOFF_MAX_BYTES) throw new Error("slate refused to write a handoff record larger than 1 MiB");
		fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
		stagingHeld = fstatSync(fd);
		const stagingEntry = lstatSync(staging, { throwIfNoEntry: false });
		if (!stagingHeld.isFile() || !stagingEntry?.isFile() || !sameFile(stagingHeld, stagingEntry)
			|| !directoryMatches(stagingDirectoryHeld) || !directoryMatches(pendingHeld)) {
			throw new Error("slate refused a linked or changing staged handoff record");
		}
		writeFileSync(fd, content, "utf8");
		durability.fsyncFile(fd);
		durability.fsyncDirectory(stagingDirectoryHeld);
		const beforeRename = lstatSync(staging, { throwIfNoEntry: false });
		if (!beforeRename?.isFile() || !sameFile(stagingHeld, beforeRename)
			|| !directoryMatches(stagingDirectoryHeld) || !directoryMatches(pendingHeld)) {
			throw new Error("slate refused a staged handoff record modified during write");
		}
		closeSync(fd);
		fd = undefined;
		renameSync(staging, file);
		const published = lstatSync(file, { throwIfNoEntry: false });
		if (!published?.isFile() || published.isSymbolicLink() || !sameFile(stagingHeld, published)
			|| !directoryMatches(stagingDirectoryHeld) || !directoryMatches(pendingHeld)) {
			throw new Error("slate refused a handoff record or directory modified during publication");
		}
		durability.fsyncDirectory(stagingDirectoryHeld);
		durability.fsyncDirectory(pendingHeld);
		if (!directoryMatches(stagingDirectoryHeld) || !directoryMatches(pendingHeld)) {
			throw new Error("slate refused a handoff directory modified after publication");
		}
		return file;
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (stagingHeld !== undefined && directoryMatches(stagingDirectoryHeld)) {
			const current = lstatSync(staging, { throwIfNoEntry: false });
			if (current?.isFile() && sameFile(stagingHeld, current)) rmSync(staging, { force: true });
		}
		closeSync(stagingDirectoryHeld.fd);
		closeSync(pendingHeld.fd);
	}
}
