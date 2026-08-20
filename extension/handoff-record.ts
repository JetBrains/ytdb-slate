import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
	resolveContainedFile,
	resolveContainedThreadFile,
	resolveCorpusProject,
	validateCorpusSession,
	type CorpusProject,
} from "./corpus.ts";
import { isSlateSessionName } from "./session-names.ts";

const HANDOFF_MAX_BYTES = 1024 * 1024;
const HANDOFF_MAX_THREADS = 512;
const HANDOFF_MAX_EPISODES = 4096;
const HANDOFF_MAX_STRING_BYTES = 8192;
const HANDOFF_MAX_DEPTH = 8;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

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

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function boundedTree(value: unknown, depth = 0): boolean {
	if (depth > HANDOFF_MAX_DEPTH) return false;
	if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= HANDOFF_MAX_STRING_BYTES;
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((entry) => boundedTree(entry, depth + 1));
	if (!object(value)) return false;
	return Object.entries(value).every(([key, entry]) =>
		Buffer.byteLength(key, "utf8") <= HANDOFF_MAX_STRING_BYTES && boundedTree(entry, depth + 1),
	);
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
	if (!boundedTree(value) || !object(value)) return undefined;
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
	if (!Array.isArray(value.parentChain) || !value.parentChain.every(validParent)) return undefined;
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

export function readCorpusHandoffRecord(options: {
	cwd: string;
	name: string;
	isTrusted: () => boolean;
	project?: CorpusProject;
}): HandoffRecordReadResult {
	// D104 and D214: trust is consulted before path resolution, file metadata, or parsing.
	if (!options.isTrusted()) return { ok: false, reason: "slate refused handoff adoption because this project is not trusted" };
	if (!isSlateSessionName(options.name)) return { ok: false, reason: "slate refused an invalid handoff session name" };
	let fd: number | undefined;
	try {
		const project = options.project ?? resolveCorpusProject(options.cwd);
		const pendingDirectory = join(project.directory, "pending");
		const pendingEntry = lstatSync(pendingDirectory, { throwIfNoEntry: false });
		if (pendingEntry === undefined) return { ok: false, reason: `slate found no handoff record named ${options.name}` };
		if (!pendingEntry.isDirectory() || pendingEntry.isSymbolicLink() || realpathSync(pendingDirectory) !== pendingDirectory) {
			return { ok: false, reason: "slate refused a linked or invalid handoff directory" };
		}
		const file = corpusHandoffFile(project, options.name);
		fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
		const held = fstatSync(fd);
		const current = lstatSync(file, { throwIfNoEntry: false });
		if (!held.isFile() || !current?.isFile() || current.isSymbolicLink() || !sameFile(held, current)) {
			return { ok: false, reason: "slate refused a linked or changing handoff record" };
		}
		// D133 and D214: reject the byte count before JSON parsing.
		if (held.size > HANDOFF_MAX_BYTES) return { ok: false, reason: "slate refused a handoff record larger than 1 MiB" };
		const bytes = readFileSync(fd);
		if (bytes.byteLength > HANDOFF_MAX_BYTES) return { ok: false, reason: "slate refused a handoff record larger than 1 MiB" };
		let raw: unknown;
		try { raw = JSON.parse(bytes.toString("utf8")); }
		catch { return { ok: false, reason: "slate refused malformed handoff JSON" }; }
		const record = validateRecord(raw);
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
		for (const thread of record.snapshot.threads) {
			if (thread.sessionFile !== "" && resolveContainedThreadFile(options.cwd, thread.sessionFile, project.directory) === undefined) {
				return { ok: false, reason: `slate refused thread ${thread.id} because its session file is missing, linked, or outside slate storage` };
			}
			if (thread.forkedFrom !== undefined && resolveContainedThreadFile(options.cwd, thread.forkedFrom, project.directory) === undefined) {
				return { ok: false, reason: `slate refused thread ${thread.id} because its fork source is missing, linked, or outside slate storage` };
			}
		}
		for (const episode of record.snapshot.episodes) {
			if (resolveContainedFile(options.cwd, episode.file, project.directory) === undefined) {
				return { ok: false, reason: `slate refused episode ${episode.id} because its file is missing, linked, or outside slate storage` };
			}
			if (episode.observations?.stored === true) {
				const reference = episode.observations.path;
				const sessionPrefix = ".pi/slate/sessions/";
				const observationFile = reference.startsWith(sessionPrefix)
					? join(project.directory, reference.slice(sessionPrefix.length))
					: join(options.cwd, reference);
				if (resolveContainedFile(options.cwd, observationFile, project.directory) === undefined) {
					return { ok: false, reason: `slate refused episode ${episode.id} because its observation file is missing, linked, or outside slate storage` };
				}
			}
		}
		const after = lstatSync(file, { throwIfNoEntry: false });
		if (!after?.isFile() || after.isSymbolicLink() || !sameFile(held, after)) {
			return { ok: false, reason: "slate refused a handoff record modified during read" };
		}
		return { ok: true, record, file, authorSessionDirectory: authorReal };
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") {
			return { ok: false, reason: `slate found no handoff record named ${options.name}` };
		}
		return { ok: false, reason: `slate refused the handoff record: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function listCorpusHandoffCandidates(options: {
	cwd: string;
	isTrusted: () => boolean;
	project?: CorpusProject;
}): { ok: true; candidates: HandoffCandidate[] } | { ok: false; reason: string } {
	if (!options.isTrusted()) return { ok: false, reason: "slate refused handoff listing because this project is not trusted" };
	try {
		const project = options.project ?? resolveCorpusProject(options.cwd);
		const pending = join(project.directory, "pending");
		const entry = lstatSync(pending, { throwIfNoEntry: false });
		if (entry === undefined) return { ok: true, candidates: [] };
		if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(pending) !== pending) {
			return { ok: false, reason: "slate refused a linked or invalid handoff directory" };
		}
		const names = readdirSync(pending)
			.filter((file) => file.endsWith(".json"))
			.map((file) => file.slice(0, -5))
			.filter(isSlateSessionName)
			.sort();
		return {
			ok: true,
			candidates: names.map((name) => ({
				name,
				result: readCorpusHandoffRecord({ cwd: options.cwd, name, isTrusted: () => true, project }),
			})),
		};
	} catch (error) {
		return { ok: false, reason: `slate could not list handoff records: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function writeCorpusHandoffRecord(project: CorpusProject, record: CorpusHandoffRecord): string {
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
	const pending = join(project.directory, "pending");
	try { mkdirSync(pending, { mode: PRIVATE_DIRECTORY_MODE }); }
	catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
	const pendingEntry = lstatSync(pending, { throwIfNoEntry: false });
	if (!pendingEntry?.isDirectory() || pendingEntry.isSymbolicLink() || realpathSync(pending) !== pending) {
		throw new Error("slate refused a linked handoff directory");
	}
	const file = corpusHandoffFile(project, record.author.name);
	const staging = join(pending, `.${record.author.name}.${process.pid}.${Date.now()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
		const content = `${JSON.stringify(validated, null, 2)}\n`;
		if (Buffer.byteLength(content, "utf8") > HANDOFF_MAX_BYTES) throw new Error("slate refused to write a handoff record larger than 1 MiB");
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(staging, file);
		const directoryFd = openSync(dirname(file), constants.O_RDONLY);
		try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
		return file;
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(staging, { force: true });
	}
}
