import { createHash } from "node:crypto";
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
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import {
	corpusDirectoryMatches,
	holdCorpusDirectory,
	resolveCorpusRoot,
	sameFileIdentity,
	type HeldCorpusDirectory,
} from "./corpus.ts";
import { corpusListCell, corpusListPath } from "./corpus-list.ts";
import { isSlateSessionId, isOwnerSessionDigest } from "./session-identity.ts";
import { isSlateSessionName } from "./session-names.ts";

export const DISCOVERY_ROOT_ENTRIES = 4096;
export const DISCOVERY_PROJECT_ENTRIES = 4096;
export const DISCOVERY_CANDIDATES = 65_536;
export const DISCOVERY_FILE_BYTES = 64 * 1024;
export const DISCOVERY_AGGREGATE_BYTES = 4 * 1024 * 1024;

const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
const PROJECT_AREA_PATTERN = /^(.+)-([0-9a-f]{12})$/;
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

export type SessionDiscoveryOutcome = "no match" | "one match" | "ambiguous" | "incomplete";

export interface SessionDiscoveryLimits {
	rootEntries: number;
	projectEntries: number;
	candidates: number;
	fileBytes: number;
	aggregateBytes: number;
}

const DEFAULT_LIMITS: Readonly<SessionDiscoveryLimits> = Object.freeze({
	rootEntries: DISCOVERY_ROOT_ENTRIES,
	projectEntries: DISCOVERY_PROJECT_ENTRIES,
	candidates: DISCOVERY_CANDIDATES,
	fileBytes: DISCOVERY_FILE_BYTES,
	aggregateBytes: DISCOVERY_AGGREGATE_BYTES,
});

export interface DiscoveredSession {
	name: string;
	identity: string;
	createdAt: string;
	/** The directory that holds the records of this Slate session (Track 15 goal 5). */
	sessionDirectory: string;
	currentDirectory: string;
	projectLabel: string;
	projectDigest: string;
}

export interface SessionDiscoveryWork {
	rootEntries: number;
	projectEntries: number;
	candidates: number;
	bytes: number;
}

export type SessionDiscoveryResult =
	| {
		ok: true;
		outcome: SessionDiscoveryOutcome;
		matches: DiscoveredSession[];
		lines: string[];
		examined: number;
		unreadable: number;
		limitStops: number;
		storageErrors: number;
		work: SessionDiscoveryWork;
	}
	| { ok: false; reason: string };

interface DurableIdentityRecord {
	policy: "durable-session-v1";
	identity: string;
	name: string;
	createdAt: string;
	currentDirectory: string;
	projectKey: string;
	projectDigest: string;
	creatorSessionDigest: string;
}

interface ProjectArea {
	name: string;
	label: string;
	digest: string;
	path: string;
}

interface IdentityRead {
	metadata?: DurableIdentityRecord;
	fileLimited?: boolean;
	aggregateLimited?: boolean;
	closeFailed?: boolean;
	bytes: number;
}

function exactKeys(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return keys.length === METADATA_KEYS.length && keys.every((key) => METADATA_KEYS.includes(key as typeof METADATA_KEYS[number]));
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
	return typeof value === "string" && value.length > 0
		&& Buffer.byteLength(value, "utf8") <= 4096 && isAbsolute(value);
}

function projectArea(name: string, root: string): ProjectArea | undefined {
	const match = PROJECT_AREA_PATTERN.exec(name);
	if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
	return { name, label: match[1], digest: match[2], path: join(root, name) };
}

function validateIdentity(raw: unknown, area: ProjectArea, expectedName: string): DurableIdentityRecord | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (!exactKeys(value) || value.policy !== "durable-session-v1") return undefined;
	if (!isSlateSessionId(value.identity) || value.name !== expectedName || !isSlateSessionName(value.name)) return undefined;
	if (!canonicalTimestamp(value.createdAt) || !boundedAbsolutePath(value.currentDirectory)) return undefined;
	if (!boundedAbsolutePath(value.projectKey) || value.projectDigest !== area.digest) return undefined;
	if (createHash("sha256").update(value.projectKey).digest("hex").slice(0, 12) !== area.digest) return undefined;
	if (!isOwnerSessionDigest(value.creatorSessionDigest)) return undefined;
	return value as unknown as DurableIdentityRecord;
}

function singleNamedFile(entry: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number } | undefined): boolean {
	return entry?.isFile() === true && !entry.isSymbolicLink() && entry.nlink === 1;
}

function readIdentityRecord(
	area: ProjectArea,
	name: string,
	directory: HeldCorpusDirectory,
	fileMaximum: number,
	aggregateRemaining: number,
): IdentityRead {
	const file = join(directory.path, "session.json");
	let fd: number | undefined;
	let used = 0;
	const read = (): IdentityRead => {
		try {
			const before = lstatSync(file, { throwIfNoEntry: false });
			if (!singleNamedFile(before) || !corpusDirectoryMatches(directory)) return { bytes: used };
			fd = openSync(file, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
			const held = fstatSync(fd);
			const current = lstatSync(file, { throwIfNoEntry: false });
			if (!singleNamedFile(held) || !singleNamedFile(current)
				|| !sameFileIdentity(held, current!) || !corpusDirectoryMatches(directory)) {
				return { bytes: used };
			}
			if (held.size > fileMaximum) return { fileLimited: true, bytes: used };
			if (held.size > aggregateRemaining) return { aggregateLimited: true, bytes: used };
			const maximum = Math.min(fileMaximum, aggregateRemaining);
			const buffer = Buffer.alloc(maximum);
			while (used < buffer.byteLength) {
				const count = readSync(fd, buffer, used, buffer.byteLength - used, null);
				if (count === 0) break;
				used += count;
			}
			const finalHeld = fstatSync(fd);
			if (finalHeld.size > fileMaximum || used > fileMaximum) return { fileLimited: true, bytes: used };
			if (finalHeld.size > aggregateRemaining || used > aggregateRemaining) return { aggregateLimited: true, bytes: used };
			const after = lstatSync(file, { throwIfNoEntry: false });
			if (!singleNamedFile(after) || !sameFileIdentity(held, after!) || !corpusDirectoryMatches(directory)) {
				return { bytes: used };
			}
			let raw: unknown;
			try {
				const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used));
				raw = JSON.parse(text);
			} catch {
				return { bytes: used };
			}
			const metadata = validateIdentity(raw, area, name);
			return { metadata, bytes: used };
		} catch {
			return { bytes: used };
		}
	};
	const result = read();
	try {
		if (fd !== undefined) closeSync(fd);
	} catch {
		result.closeFailed = true;
	}
	return result;
}

function renderMatch(match: DiscoveredSession): string {
	// The query form uses the same separate exact-path lines as the no-argument
	// form. A legal vertical bar therefore remains path data, not a separator.
	return [
		`- ${corpusListCell(match.name)} | identity ${corpusListCell(match.identity)} | project ${corpusListCell(match.projectLabel)}-${corpusListCell(match.projectDigest)} | created ${corpusListCell(match.createdAt)}`,
		`  session directory: ${corpusListPath(match.sessionDirectory) || "(invalid)"}`,
		`  project directory: ${corpusListPath(match.currentDirectory) || "(invalid)"}`,
	].join("\n");
}

function render(
	outcome: SessionDiscoveryOutcome,
	matches: DiscoveredSession[],
	unreadable: number,
	limitStops: number,
	storageErrors: number,
): string[] {
	const matchNoun = matches.length === 1 ? "match" : "matches";
	const lines = [
		`slate: project-independent session lookup — outcome: ${outcome}`,
		"Discovery metadata is advisory and can become stale immediately.",
		`Lookup found ${matches.length} ${matchNoun}. The printed list contains ${matches.length} ${matchNoun}.`,
		...matches.map(renderMatch),
	];
	if (outcome === "no match") lines.push("No matching durable session was found.");
	if (unreadable > 0) lines.push(`${unreadable} examined candidate${unreadable === 1 ? "" : "s"} could not be read or validated safely.`);
	if (limitStops > 0) lines.push(`${limitStops} resource limit${limitStops === 1 ? "" : "s"} stopped scan work before completion.`);
	if (storageErrors > 0) lines.push(`${storageErrors} storage boundary operation${storageErrors === 1 ? "" : "s"} failed outside candidate validation.`);
	return lines;
}

/** Search durable identity records without selecting a project from the current directory. */
export function discoverCorpusSession(options: {
	query: string;
	isTrusted: () => boolean;
	root?: string;
	limits?: Partial<SessionDiscoveryLimits>;
}): SessionDiscoveryResult {
	if (!options.isTrusted()) return { ok: false, reason: "slate: project-independent session lookup requires a trusted project" };
	const byName = isSlateSessionName(options.query);
	const byIdentity = isSlateSessionId(options.query);
	if (!byName && !byIdentity) {
		return { ok: false, reason: "slate: sessions lookup requires one complete stable session name or session identifier" };
	}
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	const matches: DiscoveredSession[] = [];
	const work: SessionDiscoveryWork = { rootEntries: 0, projectEntries: 0, candidates: 0, bytes: 0 };
	let unreadable = 0;
	let limitStops = 0;
	let storageErrors = 0;
	const finish = (outcome: SessionDiscoveryOutcome): SessionDiscoveryResult => ({
		ok: true,
		outcome,
		matches,
		lines: render(outcome, matches, unreadable, limitStops, storageErrors),
		examined: work.candidates,
		unreadable,
		limitStops,
		storageErrors,
		work,
	});
	let rootPath: string;
	try {
		rootPath = options.root ?? resolveCorpusRoot();
	} catch {
		storageErrors += 1;
		return finish("incomplete");
	}
	let stopped = false;
	let root: HeldCorpusDirectory | undefined;
	let rootStream: ReturnType<typeof opendirSync> | undefined;
	const areas: ProjectArea[] = [];

	try {
		const entry = lstatSync(rootPath, { throwIfNoEntry: false });
		if (entry === undefined) return finish("no match");
		if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(rootPath) !== rootPath) storageErrors += 1;
		else {
			root = holdCorpusDirectory(rootPath);
			rootStream = opendirSync(rootPath);
			for (;;) {
				const item = rootStream.readSync();
				if (item === null) break;
				work.rootEntries += 1;
				if (work.rootEntries > limits.rootEntries) {
					limitStops += 1;
					stopped = true;
					break;
				}
				const area = projectArea(item.name, rootPath);
				if (area !== undefined) areas.push(area);
			}
		}
	} catch {
		storageErrors += 1;
	} finally {
		try { rootStream?.closeSync(); } catch { storageErrors += 1; }
	}

	for (const area of areas) {
		if (stopped) break;
		let project: HeldCorpusDirectory | undefined;
		let stream: ReturnType<typeof opendirSync> | undefined;
		try {
			const entry = lstatSync(area.path, { throwIfNoEntry: false });
			if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync(area.path) !== area.path) {
				storageErrors += 1;
				continue;
			}
			project = holdCorpusDirectory(area.path);
			const names: string[] = [];
			if (byName) {
				if (lstatSync(join(area.path, options.query), { throwIfNoEntry: false }) !== undefined) names.push(options.query);
			} else {
				stream = opendirSync(area.path);
				for (;;) {
					const item = stream.readSync();
					if (item === null) break;
					work.projectEntries += 1;
					if (work.projectEntries > limits.projectEntries) {
						limitStops += 1;
						stopped = true;
						break;
					}
					if (isSlateSessionName(item.name)) names.push(item.name);
				}
			}
			for (const name of names) {
				if (stopped) break;
				if (work.candidates >= limits.candidates) {
					limitStops += 1;
					stopped = true;
					break;
				}
				work.candidates += 1;
				const path = join(area.path, name);
				let candidate: HeldCorpusDirectory | undefined;
				try {
					const entry = lstatSync(path, { throwIfNoEntry: false });
					if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path) {
						unreadable += 1;
						continue;
					}
					candidate = holdCorpusDirectory(path);
					const read = readIdentityRecord(
						area,
						name,
						candidate,
						limits.fileBytes,
						Math.max(0, limits.aggregateBytes - work.bytes),
					);
					work.bytes += read.bytes;
					if (read.closeFailed === true) storageErrors += 1;
					if (read.aggregateLimited === true) {
						limitStops += 1;
						stopped = true;
						continue;
					}
					if (read.fileLimited === true) {
						unreadable += 1;
						continue;
					}
					const metadata = read.metadata;
					if (metadata === undefined || !corpusDirectoryMatches(candidate)
						|| !corpusDirectoryMatches(project) || (root !== undefined && !corpusDirectoryMatches(root))) {
						unreadable += 1;
						continue;
					}
					if ((byName && metadata.name === options.query) || (byIdentity && metadata.identity === options.query)) {
						matches.push({
							name: metadata.name,
							identity: metadata.identity,
							createdAt: metadata.createdAt,
							sessionDirectory: path,
							currentDirectory: metadata.currentDirectory,
							projectLabel: area.label,
							projectDigest: area.digest,
						});
					}
				} catch {
					unreadable += 1;
				} finally {
					try {
						if (candidate !== undefined) closeSync(candidate.fd);
					} catch {
						storageErrors += 1;
					}
				}
			}
			if (!corpusDirectoryMatches(project)) storageErrors += 1;
		} catch {
			storageErrors += 1;
		} finally {
			try { stream?.closeSync(); } catch { storageErrors += 1; }
			try {
				if (project !== undefined) closeSync(project.fd);
			} catch {
				storageErrors += 1;
			}
		}
	}
	if (root !== undefined) {
		if (!corpusDirectoryMatches(root)) storageErrors += 1;
		try { closeSync(root.fd); } catch { storageErrors += 1; }
	}
	matches.sort((left, right) => left.projectLabel.localeCompare(right.projectLabel)
		|| left.projectDigest.localeCompare(right.projectDigest)
		|| left.name.localeCompare(right.name)
		|| left.identity.localeCompare(right.identity));
	const incomplete = unreadable > 0 || limitStops > 0 || storageErrors > 0;
	const outcome: SessionDiscoveryOutcome = incomplete
		? "incomplete"
		: matches.length === 0 ? "no match" : matches.length === 1 ? "one match" : "ambiguous";
	return finish(outcome);
}
