import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	opendirSync,
	readSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { spawnSync } from "node:child_process";
import { directoryMatches, holdDirectory, parseCorpusHandoffRecord } from "./handoff-record.ts";
import { isSlateSessionName } from "./session-names.ts";
import { SLATE_SESSION_ID_PATTERN } from "./state.ts";
import { gitEnvironment, type CorpusProject } from "./corpus.ts";

export const CORPUS_LIST_ROOT_ENTRIES = 4096;
export const CORPUS_LIST_ROW_ENTRIES = 4096;
export const CORPUS_LIST_COUNT_ENTRIES = 65536;
export const CORPUS_LIST_FILE_BYTES = 65536;
export const CORPUS_LIST_AGGREGATE_BYTES = 4 * 1024 * 1024;
export const CORPUS_LIST_SESSION_ENTRIES = 64;
export const CORPUS_LIST_CELL_CHARS = 240;

const CORPUS_LIST_OUTPUT_CHARS = 16_384;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

export interface CorpusListLimits {
	rootEntries: number;
	rowEntries: number;
	countEntries: number;
	fileBytes: number;
	aggregateBytes: number;
	sessionEntries: number;
}

const DEFAULT_LIMITS: Readonly<CorpusListLimits> = Object.freeze({
	rootEntries: CORPUS_LIST_ROOT_ENTRIES,
	rowEntries: CORPUS_LIST_ROW_ENTRIES,
	countEntries: CORPUS_LIST_COUNT_ENTRIES,
	fileBytes: CORPUS_LIST_FILE_BYTES,
	aggregateBytes: CORPUS_LIST_AGGREGATE_BYTES,
	sessionEntries: CORPUS_LIST_SESSION_ENTRIES,
});

export type CorpusSessionListResult =
	| { ok: true; lines: string[]; rows: number; truncated: boolean }
	| { ok: false; reason: string };

/** One strict terminal cell. Session names and identities are shorter than this cap. */
export function corpusListCell(value: unknown): string {
	if (typeof value !== "string") return "";
	const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}|]+/gu, " ").trim();
	const characters = Array.from(clean);
	return characters.length <= CORPUS_LIST_CELL_CHARS ? clean : `${characters.slice(0, CORPUS_LIST_CELL_CHARS - 1).join("")}…`;
}

function errorText(error: unknown): string {
	return corpusListCell(error instanceof Error ? error.message : String(error)) || "read failed";
}

function sameFile(a: ReturnType<typeof fstatSync>, b: NonNullable<ReturnType<typeof lstatSync>>): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

interface BoundedRead {
	ok: boolean;
	bytes?: Buffer;
	reason?: string;
}

function boundedRegularFile(file: string, ceiling: number, afterSizeCheck?: (file: string) => void): BoundedRead {
	let fd: number | undefined;
	try {
		const before = lstatSync(file, { throwIfNoEntry: false });
		if (!before?.isFile() || before.isSymbolicLink()) return { ok: false, reason: "not a regular file" };
		fd = openSync(file, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
		const held = fstatSync(fd);
		const current = lstatSync(file, { throwIfNoEntry: false });
		if (!held.isFile() || !current?.isFile() || current.isSymbolicLink() || !sameFile(held, current)) {
			return { ok: false, reason: "linked or changing file" };
		}
		if (held.size > ceiling) return { ok: false, reason: `file is larger than ${ceiling} bytes` };
		afterSizeCheck?.(file);
		const buffer = Buffer.alloc(ceiling + 1);
		let used = 0;
		while (used < buffer.length) {
			const count = readSync(fd, buffer, used, buffer.length - used, null);
			if (count === 0) break;
			used += count;
		}
		if (used > ceiling) return { ok: false, reason: `file is larger than ${ceiling} bytes` };
		const after = lstatSync(file, { throwIfNoEntry: false });
		if (!after?.isFile() || after.isSymbolicLink() || !sameFile(held, after)) {
			return { ok: false, reason: "linked or changing file" };
		}
		return { ok: true, bytes: buffer.subarray(0, used) };
	} catch (error) {
		return { ok: false, reason: errorText(error) };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function parseJson(bytes: Buffer): unknown {
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	return JSON.parse(text);
}

function exactWriterTimestamp(value: string): boolean {
	if (!/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
	try { return new Date(value).toISOString() === value; } catch { return false; }
}

function insideOrEqual(root: string, value: string): boolean {
	if (!isAbsolute(value)) return false;
	const rel = relative(root, value);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function countSessionEntries(directory: string, maximum: number): string | undefined {
	let stream: ReturnType<typeof opendirSync> | undefined;
	try {
		stream = opendirSync(directory);
		let count = 0;
		while (stream.readSync() !== null) {
			count += 1;
			if (count > maximum) return `session directory has more than ${maximum} entries`;
		}
		return undefined;
	} catch (error) {
		return `session directory is unreadable: ${errorText(error)}`;
	} finally {
		try { stream?.closeSync(); } catch { /* read result already classifies the entry */ }
	}
}

interface DraftRow {
	name: string;
	identity?: string;
	createdAt?: string;
	worktreePath?: string;
	branchLabel?: string;
	pending: "absent" | "present" | "unreadable";
	markers: string[];
	notes: string[];
}

interface PendingState extends Pick<DraftRow, "pending" | "notes"> {
	bytes: number;
}

function pendingState(project: CorpusProject, name: string, ceiling: number): PendingState {
	const pendingDirectory = join(project.directory, "pending");
	const directoryEntry = lstatSync(pendingDirectory, { throwIfNoEntry: false });
	if (directoryEntry === undefined) return { pending: "absent", notes: [], bytes: 0 };
	try {
		if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() || realpathSync(pendingDirectory) !== pendingDirectory) {
			return { pending: "unreadable", notes: ["pending record is unreadable: pending path is not a real directory"], bytes: 0 };
		}
	} catch (error) {
		return { pending: "unreadable", notes: [`pending record is unreadable: ${errorText(error)}`], bytes: 0 };
	}
	const file = join(pendingDirectory, `${name}.json`);
	const entry = lstatSync(file, { throwIfNoEntry: false });
	if (entry === undefined) return { pending: "absent", notes: [], bytes: 0 };
	const read = boundedRegularFile(file, ceiling);
	if (!read.ok || read.bytes === undefined) return { pending: "unreadable", notes: [`pending record is unreadable: ${read.reason}`], bytes: 0 };
	try {
		const record = parseCorpusHandoffRecord(parseJson(read.bytes));
		if (record === undefined || record.author.name !== name) throw new Error("record does not match its schema or session name");
		return { pending: "present", notes: [], bytes: read.bytes.byteLength };
	} catch (error) {
		return { pending: "unreadable", notes: [`pending record is unreadable: ${errorText(error)}`], bytes: read.bytes.byteLength };
	}
}

function readRow(
	project: CorpusProject,
	name: string,
	worktreeRoot: string,
	limits: CorpusListLimits,
	afterMetadataSizeCheck?: (file: string) => void,
): { row: DraftRow; readBytes: number } {
	const row: DraftRow = { name, pending: "absent", markers: [], notes: [] };
	const directory = join(project.directory, name);
	let readBytes = 0;
	try {
		const pending = pendingState(project, name, limits.fileBytes);
		row.pending = pending.pending;
		row.notes.push(...pending.notes);
		readBytes += pending.bytes;
		const entry = lstatSync(directory, { throwIfNoEntry: false });
		if (!entry?.isDirectory() || entry.isSymbolicLink()) {
			row.notes.push(entry?.isSymbolicLink() ? "session directory is a symbolic link" : "session directory is unreadable");
			return { row, readBytes };
		}
		const countDefect = countSessionEntries(directory, limits.sessionEntries);
		if (countDefect !== undefined) row.notes.push(countDefect);
		const read = boundedRegularFile(join(directory, "session.json"), limits.fileBytes, afterMetadataSizeCheck);
		if (!read.ok || read.bytes === undefined) {
			row.notes.push(`session metadata is unreadable: ${read.reason}`);
			return { row, readBytes };
		}
		let raw: unknown;
		try { raw = parseJson(read.bytes); }
		catch (error) {
			row.notes.push(`session metadata is malformed: ${errorText(error)}`);
			return { row, readBytes: readBytes + read.bytes.byteLength };
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			row.notes.push("session metadata is not an object");
			return { row, readBytes: readBytes + read.bytes.byteLength };
		}
		const value = raw as Record<string, unknown>;
		for (const field of ["identity", "name", "createdAt", "worktreePath", "branchLabel"] as const) {
			if (typeof value[field] !== "string") row.notes.push(`${field} has the wrong type`);
		}
		if (value.piSessionName !== undefined && typeof value.piSessionName !== "string") row.notes.push("piSessionName has the wrong type");
		if (typeof value.identity === "string") {
			row.identity = value.identity;
			if (!SLATE_SESSION_ID_PATTERN.test(value.identity)) row.notes.push(value.identity === "" ? "identity is empty" : "identity is invalid");
		} else row.notes.push("identity is absent");
		if (typeof value.name === "string" && value.name !== name) row.notes.push("metadata name does not match the directory name");
		if (typeof value.createdAt === "string") {
			row.createdAt = value.createdAt;
			if (!exactWriterTimestamp(value.createdAt)) row.notes.push("creation time is invalid");
		}
		if (typeof value.worktreePath === "string") {
			row.worktreePath = value.worktreePath;
			if (!insideOrEqual(worktreeRoot, value.worktreePath)) row.markers.push("session started outside this working tree");
		}
		if (typeof value.branchLabel === "string") row.branchLabel = value.branchLabel;
		return { row, readBytes: readBytes + read.bytes.byteLength };
	} catch (error) {
		row.notes.push(`session entry read failed: ${errorText(error)}`);
		return { row, readBytes };
	}
}

function renderRow(row: DraftRow): string {
	const markers = row.markers.length === 0 ? "none" : row.markers.map(corpusListCell).join(", ");
	const notes = row.notes.length === 0 ? "none" : row.notes.map(corpusListCell).join(", ");
	return `- ${corpusListCell(row.name)} | identity ${corpusListCell(row.identity) || "(invalid)"} | branch ${corpusListCell(row.branchLabel) || "(unknown)"} | worktree ${corpusListCell(row.worktreePath) || "(invalid)"} | created ${corpusListCell(row.createdAt) || "(invalid)"} | pending ${corpusListCell(row.pending)} | marker ${corpusListCell(markers)} | defect ${corpusListCell(notes)}`;
}

/** Read and render the current project's corpus without creating any path. */
export function listCorpusSessions(options: {
	cwd: string;
	isTrusted: () => boolean;
	project?: CorpusProject;
	limits?: Partial<CorpusListLimits>;
	/** Deterministic race-injection seams. Production callers omit them. */
	afterProjectDirectoryOpen?: () => void;
	beforeProjectDirectoryFinalCheck?: () => void;
	afterMetadataSizeCheck?: (file: string) => void;
}): CorpusSessionListResult {
	if (!options.isTrusted()) return { ok: false, reason: "slate: corpus session listing requires a trusted project" };
	const project = options.project;
	if (project === undefined) return { ok: false, reason: "slate: corpus project is unavailable" };
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	let root: ReturnType<typeof opendirSync> | undefined;
	const matches: string[] = [];
	try {
		root = opendirSync(project.root);
		let count = 0;
		for (;;) {
			const entry = root.readSync();
			if (entry === null) break;
			count += 1;
			if (count > limits.rootEntries) return { ok: false, reason: `slate: corpus root has more than ${limits.rootEntries} entries` };
			if (!entry.name.endsWith(`-${project.digest}`)) continue;
			const path = join(project.root, entry.name);
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (stat?.isDirectory() && !stat.isSymbolicLink()) matches.push(path);
		}
	} catch (error) {
		return { ok: false, reason: `slate: could not read the corpus root: ${errorText(error)}` };
	} finally {
		try { root?.closeSync(); } catch { /* the refusal above remains authoritative */ }
	}
	if (matches.length !== 1 || matches[0] !== project.directory) {
		return { ok: false, reason: matches.length > 1 ? "slate: several corpus project directories match this project" : "slate: corpus project directory could not be resolved" };
	}
	let worktreeRoot: string;
	try {
		worktreeRoot = realpathSync(options.cwd);
	} catch (error) {
		return { ok: false, reason: `slate: working tree root could not be resolved: ${errorText(error)}` };
	}
	// The project key is the Git common directory. Git's top-level directory is needed
	// only for the display marker and never comes from metadata.
	try {
		const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: options.cwd, env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		if (result.status === 0 && result.stdout.trim() !== "") worktreeRoot = realpathSync(result.stdout.trim());
	} catch { /* a non-Git directory uses its own canonical root */ }
	let directory: ReturnType<typeof opendirSync> | undefined;
	let projectHeld: ReturnType<typeof holdDirectory> | undefined;
	const rows: DraftRow[] = [];
	let aggregate = 0;
	let omitted = 0;
	let countExhausted = false;
	try {
		projectHeld = holdDirectory(project.directory);
		options.afterProjectDirectoryOpen?.();
		if (!directoryMatches(projectHeld)) return { ok: false, reason: "slate: corpus project directory identity changed during listing" };
		// The runtime offers no directory-relative child open. A same-inode
		// replace-and-restore race remains. This matches the accepted risk that the
		// project already records for the handoff record path.
		directory = opendirSync(project.directory);
		let seen = 0;
		for (;;) {
			const entry = directory.readSync();
			if (entry === null) break;
			seen += 1;
			if (seen > limits.rowEntries) {
				omitted += 1;
				if (omitted >= limits.countEntries) { countExhausted = directory.readSync() !== null; break; }
				continue;
			}
			if (!isSlateSessionName(entry.name)) continue;
			const read = readRow(project, entry.name, worktreeRoot, limits, options.afterMetadataSizeCheck);
			aggregate += read.readBytes;
			if (aggregate > limits.aggregateBytes) return { ok: false, reason: `slate: session metadata exceeds ${limits.aggregateBytes} aggregate bytes` };
			rows.push(read.row);
		}
		options.beforeProjectDirectoryFinalCheck?.();
		if (!directoryMatches(projectHeld)) return { ok: false, reason: "slate: corpus project directory identity changed during listing" };
	} catch (error) {
		return { ok: false, reason: `slate: could not read the corpus project directory: ${errorText(error)}` };
	} finally {
		try { directory?.closeSync(); } catch { /* the refusal above remains authoritative */ }
		if (projectHeld !== undefined) closeSync(projectHeld.fd);
	}
	const identities = new Map<string, DraftRow[]>();
	for (const row of rows) {
		if (row.identity !== undefined && SLATE_SESSION_ID_PATTERN.test(row.identity)) {
			const group = identities.get(row.identity) ?? [];
			group.push(row);
			identities.set(row.identity, group);
		}
	}
	for (const group of identities.values()) if (group.length > 1) for (const row of group) row.notes.push("duplicate session identity");
	const lines = [
		`slate: corpus sessions for ${corpusListCell(project.label)}`,
		...rows.map(renderRow),
	];
	if (omitted > 0) {
		const readNoun = limits.rowEntries === 1 ? "entry" : "entries";
		const omittedNoun = omitted === 1 && !countExhausted ? "entry" : "entries";
		lines.push(`listing truncated: read ${limits.rowEntries} ${readNoun}. Did not read ${countExhausted ? "at least " : ""}${omitted} ${omittedNoun}`);
	}
	lines.push("Sequential best-effort reading: each row was read at a different moment. Another process may have changed the corpus. No line describes a single instant.");
	return { ok: true, lines, rows: rows.length, truncated: omitted > 0 };
}

/** Keep the command channel bounded and state when rows were omitted from it. */
export function capCorpusSessionOutput(rendered: string): string {
	const notice = "\n[output truncated at 16384 characters]";
	if (rendered.length <= CORPUS_LIST_OUTPUT_CHARS) return rendered;
	const bodyLimit = CORPUS_LIST_OUTPUT_CHARS - notice.length;
	const summary = /^Lookup found (\d+) matches?\. The printed list contains \d+ matches?\.$/mu;
	if (!summary.test(rendered)) return `${rendered.slice(0, bodyLimit)}${notice}`;
	const sliced = rendered.slice(0, bodyLimit);
	const lastLineBreak = sliced.lastIndexOf("\n");
	const completeLines = lastLineBreak < 0 ? "" : sliced.slice(0, lastLineBreak);
	const printed = completeLines.match(/^- /gmu)?.length ?? 0;
	const body = completeLines.replace(summary, (_line, foundText: string) => {
		const found = Number(foundText);
		return `Lookup found ${found} ${found === 1 ? "match" : "matches"}. The printed list contains ${printed} ${printed === 1 ? "match" : "matches"}.`;
	});
	return `${body}${notice}`;
}
