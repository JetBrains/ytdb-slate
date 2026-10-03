/**
 * Unexposed create and append primitives. Publication evidence is not a durability outcome.
 * Node path checks assume serialized writers. A folder swap and restore between checks
 * can redirect a write. Cleanup has a separate check-and-removal window.
 */
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { release } from "node:os";
import { join, resolve, sep } from "node:path";
import { isChangeFolder } from "./artifact-names.ts";
import { matchesReadOnlyEarlierLogLine, recordNameRule, type RecordAssignment } from "./record-names.ts";

export const RECORD_PAYLOAD_MAX = 1_048_576;
export function recordHash(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export interface RecordFileSystem {
	lstat(path: string): Promise<Stats>;
	open(path: string, flags: number, mode?: number): Promise<FileHandle>;
	realpath(path: string): Promise<string>;
	readdir(path: string): Promise<string[]>;
	link(from: string, to: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
}
export interface RecordPlatformFacts {
	platform: string;
	wsl: boolean;
	windowsMounts: readonly string[];
	windowsFileSystem: boolean;
}
export interface RecordWriteContext {
	projectRoot: string;
	assignment: RecordAssignment;
	sourceFolder?: string;
}
export interface RecordWriteArguments { record: unknown; mode: unknown; payload: unknown; expectedHash?: unknown }
export interface RecordWriteOptions {
	fs?: RecordFileSystem;
	platform?: string;
	/** Called only on supported systems, after resolving the destination and before changes. */
	platformFacts?: (destination: string) => Promise<RecordPlatformFacts>;
	/** Inputs for the default platform facts provider. */
	platformProbe?: RecordPlatformProbe;
	temporaryName?: () => string;
	/** Operation boundary for deterministic fault and interleaving checks. */
	beforeFinalCheck?: () => Promise<void>;
}
export interface RecordCleanup { leftover?: string; reason?: string }
export class RecordPrepublicationError extends Error {
	readonly state: "refused before publication" | "failed before publication";
	readonly stage: string;
	cleanup: RecordCleanup = {};
	secondaryFailures: string[] = [];
	constructor(state: RecordPrepublicationError["state"], reason: string, stage: string) {
		super(reason);
		this.state = state;
		this.stage = stage;
	}
}
function refuse(reason: string): never { throw new RecordPrepublicationError("refused before publication", reason, "validation"); }
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
async function optionalStat(io: RecordFileSystem, path: string): Promise<Stats | undefined> {
	try { return await io.lstat(path); } catch (error) { if (code(error) === "ENOENT") return undefined; throw error; }
}
async function directory(io: RecordFileSystem, path: string, basis?: Stats): Promise<Stats> {
	const entry = await io.lstat(path);
	if (!entry.isDirectory() || entry.isSymbolicLink()) refuse("A record folder is not a real directory. Restore the folder before retrying.");
	if (basis && !same(entry, basis)) refuse("A record folder changed identity. Inspect the folder before retrying.");
	return entry;
}
async function readRecord(io: RecordFileSystem, path: string): Promise<{ bytes: Buffer; identity: Stats }> {
	const entry = await io.lstat(path);
	if (!entry.isFile() || entry.isSymbolicLink()) refuse("The record is not a regular file. Inspect its name before retrying.");
	if (entry.nlink !== 1) refuse("The record has extra hard links. Stop writers and inspect the links before retrying.");
	const held = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let failure: RecordPrepublicationError | undefined;
	try {
		const identity = await held.stat();
		if (!identity.isFile() || identity.nlink !== 1 || !same(entry, identity)) refuse("The record changed identity. Read the safe current record again.");
		const bytes = await held.readFile();
		const after = await io.lstat(path);
		const final = await held.stat();
		if (!after.isFile() || after.nlink !== 1 || final.nlink !== 1 || !same(identity, after)) refuse("The record changed identity or links. Read the safe current record again.");
		return { bytes, identity };
	} catch (error) {
		failure = error instanceof RecordPrepublicationError ? error : new RecordPrepublicationError("failed before publication", "Record preparation failed during record read. Inspect the record before retrying.", "record read");
		throw failure;
	} finally {
		try { await held.close(); } catch {
			const reason = "The record read handle did not close. Inspect open handles before retrying.";
			if (failure) failure.secondaryFailures.push(reason);
			else throw new RecordPrepublicationError("failed before publication", reason, "record read close");
		}
	}
}

export interface RecordPlatformProbe {
	platform: string;
	releaseText: string;
	environment: Readonly<Record<string, string | undefined>>;
	readMountInfo(): Promise<string>;
	fileSystemType(destination: string): Promise<number>;
}
/** Available mount and filesystem facts detect Windows drives without assuming a mount location. */
export async function recordPlatformFacts(destination: string, probe: RecordPlatformProbe = {
	platform: process.platform,
	releaseText: release(),
	environment: process.env,
	readMountInfo: () => fs.readFile("/proc/self/mountinfo", "utf8"),
	fileSystemType: async (path) => (await fs.statfs(path)).type,
}): Promise<RecordPlatformFacts> {
	const wsl = probe.platform === "linux" && (/microsoft/i.test(probe.releaseText) || !!probe.environment.WSL_INTEROP || !!probe.environment.WSL_DISTRO_NAME);
	const windowsMounts: string[] = [];
	let windowsFileSystem = false;
	if (wsl) {
		const mounts = await probe.readMountInfo();
		for (const line of mounts.split("\n")) {
			const [left, right] = line.split(" - ");
			const fields = right?.split(" ");
			if (!fields) continue;
			if (fields[0] === "drvfs" || fields[0] === "ntfs" || fields[0] === "ntfs3" ||
				(fields[0] === "9p" && /(?:^|[,;])(?:aname=)?drvfs(?:[,;]|$)/i.test(fields.slice(2).join(" ")))) {
				const mount = left?.split(" ")[4];
				if (mount) windowsMounts.push(mount.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8))));
			}
		}
		windowsFileSystem = [0x5346544e, 0x4d44].includes(await probe.fileSystemType(destination));
	}
	return { platform: probe.platform, wsl, windowsMounts, windowsFileSystem };
}
function supported(platform: string): void {
	if (platform === "win32") refuse("Native Windows cannot write records safely. Use Windows Subsystem for Linux (WSL) on its own Linux filesystem.");
	if (platform !== "linux" && platform !== "darwin") refuse("This system cannot write records safely. Use Linux, macOS, or Windows Subsystem for Linux (WSL) on its own Linux filesystem.");
	if (typeof constants.O_NOFOLLOW !== "number") refuse("This system cannot protect record opens. Use a supported Linux or macOS filesystem.");
}

/** Cleanup assumes serialized writers during the identity check and removal. */
export async function cleanupRecordTemporary(io: RecordFileSystem, path: string, identity: Stats): Promise<RecordCleanup> {
	try {
		const entry = await optionalStat(io, path);
		if (!entry) return {};
		if (!entry.isFile() || !same(entry, identity)) return { leftover: path, reason: "The temporary name identifies a different file. Leave it untouched and inspect it." };
		await io.unlink(path);
		return {};
	} catch { return { leftover: path, reason: "Temporary cleanup failed. Inspect the named file before retrying." }; }
}
export interface PreparedRecordWrite {
	readonly record: string;
	readonly mode: "create" | "append";
	readonly temporaryPath: string;
	readonly candidateHash: string;
	/** Raw publication evidence only. The caller owns post-publication verification and settlement. */
	publish(): Promise<{ publicationReturned: true; candidateHash: string }>;
	cleanup(): Promise<RecordCleanup>;
}

/** Prepare private bytes without registering a tool or granting worker authority. */
export async function prepareRecordWrite(context: RecordWriteContext, args: RecordWriteArguments, options: RecordWriteOptions = {}): Promise<PreparedRecordWrite> {
	// This gate precedes every filesystem call, including the facts provider.
	supported(options.platform ?? process.platform);
	const io = options.fs ?? fs;
	const assignment = context.assignment;
	const folder = assignment.currentFolder.split("/");
	if (folder.length !== 2 || folder[0] !== "slate-changes" || !isChangeFolder(folder[1])) refuse("The current change folder is invalid. Open a valid change before retrying.");
	const current = folder[1];
	if (context.sourceFolder !== undefined && (!isChangeFolder(context.sourceFolder) || context.sourceFolder === current)) refuse("The read-only source conflicts with the current folder. Correct the trusted change facts before retrying.");
	const rule = recordNameRule(args.record);
	if (!rule || !assignment.names.includes(args.record as string) || rule.writerRole !== assignment.writerRole) refuse("The record is not assigned to this writer. Request the correct record assignment.");
	if ((args.mode !== "create" && args.mode !== "append") || !rule.modes.includes(args.mode)) refuse("This record mode is not available in the core. Select an allowed create or append mode.");
	const record = args.record as string;
	const mode = args.mode;
	if (typeof args.payload !== "string" || Buffer.from(args.payload, "utf8").toString("utf8") !== args.payload) refuse("The payload is not valid Unicode text. Supply text without unpaired surrogate characters.");
	const payload = Buffer.from(args.payload, "utf8");
	if (payload.length > RECORD_PAYLOAD_MAX) refuse("The payload exceeds 1,048,576 bytes. Split it into smaller calls.");
	if (mode === "create" ? args.expectedHash !== undefined : typeof args.expectedHash !== "string" || (args.expectedHash.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(args.expectedHash))) refuse("The expected hash does not match the mode. Omit it for create or supply the current sha256 hash for append.");
	let stage = "folder checks";
	let temporaryPath: string | undefined;
	let identity: Stats | undefined;
	let held: FileHandle | undefined;
	try {
		const root = await io.realpath(context.projectRoot);
		const parent = join(root, "slate-changes");
		const destination = join(parent, current);
		const chain = await Promise.all([root, parent, destination].map(async (path) => ({ path, identity: await directory(io, path) })));
		const resolved = await io.realpath(destination);
		if (resolved !== destination) refuse("The record folder resolves to another path. Restore the real folder before retrying.");
		const facts = await (options.platformFacts ?? ((path) => recordPlatformFacts(path, options.platformProbe)))(resolved);
		supported(facts.platform);
		if (facts.wsl && (facts.windowsFileSystem || facts.windowsMounts.some((mount) => {
			const base = resolve(mount);
			return resolved === base || resolved.startsWith(base.endsWith(sep) ? base : base + sep);
		}))) refuse("This destination is a Windows drive inside Windows Subsystem for Linux (WSL). Move the change to WSL on its own Linux filesystem.");
		const recheck = async () => { for (const entry of chain) await directory(io, entry.path, entry.identity); };
		const readOnly = async () => {
			for (const sibling of await io.readdir(parent)) {
				if (sibling === current || !isChangeFolder(sibling)) continue;
				try {
					const siblingPath = join(parent, sibling);
					const basis = await directory(io, siblingPath);
					const log = join(siblingPath, "research-log.md");
					if (!(await optionalStat(io, log))) continue;
					const { bytes } = await readRecord(io, log);
					await directory(io, siblingPath, basis);
					const newline = bytes.indexOf(10);
					if (matchesReadOnlyEarlierLogLine(bytes.subarray(0, newline < 0 ? bytes.length : newline), current)) refuse(`Change folder ${sibling} marks this change read-only. Write in the active successor folder instead.`);
				} catch (error) {
					if (error instanceof RecordPrepublicationError && error.message.startsWith("Change folder ")) throw error;
					const failure = new RecordPrepublicationError("refused before publication", `Cannot safely read sibling folder ${sibling}. Inspect its root log before retrying.`, "sibling read");
					if (error instanceof RecordPrepublicationError) failure.secondaryFailures.push(...error.secondaryFailures);
					throw failure;
				}
			}
		};
		await readOnly();
		const finalPath = join(destination, record);
		stage = "record read";
		const earlier = mode === "append" ? await readRecord(io, finalPath) : undefined;
		if (mode === "create" && await optionalStat(io, finalPath)) refuse("The record name already exists. Inspect it or select append with its current hash.");
		if (earlier && recordHash(earlier.bytes) !== args.expectedHash) refuse("The expected hash is stale. Read the safe current record and use its fresh hash.");
		const candidate = earlier ? Buffer.concat([earlier.bytes, payload]) : payload;
		stage = "private staging";
		const name = options.temporaryName?.() ?? `.slate-record-${randomBytes(16).toString("hex")}.tmp`;
		if (!/^\.slate-record-[0-9a-f]{32}\.tmp$/.test(name)) refuse("The temporary name is invalid. Correct the writer before retrying.");
		await recheck();
		temporaryPath = join(destination, name);
		held = await io.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		identity = await held.stat();
		if (!identity.isFile() || identity.nlink !== 1 || (identity.mode & 0o777) !== 0o600 || !same(identity, await io.lstat(temporaryPath))) {
			refuse("The filesystem did not create a private regular candidate. Use a filesystem that supports owner-only files.");
		}
		await held.writeFile(candidate);
		await held.close();
		held = undefined;
		const cleanup = () => cleanupRecordTemporary(io, temporaryPath!, identity!);
		let used = false;
		return {
			record, mode, temporaryPath, candidateHash: recordHash(candidate), cleanup,
			async publish() {
				if (used) refuse("This prepared write was already used. Inspect the current record before preparing another call.");
				used = true;
				try {
					await options.beforeFinalCheck?.();
					await recheck();
					await readOnly();
					const temp = await readRecord(io, temporaryPath!);
					if (!same(temp.identity, identity!) || (temp.identity.mode & 0o777) !== 0o600 || !temp.bytes.equals(candidate)) refuse("The private candidate changed identity, permissions, or bytes. Inspect the temporary file before retrying.");
					if (earlier) {
						const now = await readRecord(io, finalPath);
						if (!same(now.identity, earlier.identity) || !now.bytes.equals(earlier.bytes)) refuse("The record changed before publication. Read the safe current record and use its fresh hash.");
					} else if (await optionalStat(io, finalPath)) refuse("The record name appeared before publication. Inspect it before retrying.");
					await recheck();
				} catch (error) {
					const failure = error instanceof RecordPrepublicationError ? error : new RecordPrepublicationError("failed before publication", "The final safety check failed. Inspect the record and temporary file before retrying.", "final checks");
					failure.cleanup = await cleanup();
					throw failure;
				}
				// Errors from publication require settlement by the caller, not a pre-publication claim.
				try {
					if (mode === "create") await io.link(temporaryPath!, finalPath);
					else await io.rename(temporaryPath!, finalPath);
				} catch (error) {
					if (mode === "create" && code(error) === "EEXIST") {
						const failure = new RecordPrepublicationError("refused before publication", "The record name already exists. Inspect it before retrying.", "exclusive publication");
						failure.cleanup = await cleanup();
						throw failure;
					}
					throw error;
				}
				return { publicationReturned: true, candidateHash: recordHash(candidate) };
			},
		};
	} catch (error) {
		const failure = error instanceof RecordPrepublicationError ? error : new RecordPrepublicationError("failed before publication", `Record preparation failed during ${stage}. Inspect the record and artifacts before retrying.`, stage);
		try { await held?.close(); } catch { failure.secondaryFailures.push("The staging handle did not close. Inspect open handles before retrying."); }
		if (temporaryPath && identity) failure.cleanup = await cleanupRecordTemporary(io, temporaryPath, identity);
		else if (temporaryPath && held) failure.cleanup = { leftover: temporaryPath, reason: "The temporary identity is unknown. Leave the name untouched and inspect it." };
		throw failure;
	}
}
