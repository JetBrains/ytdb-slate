/**
 * Unexposed record writes with version retention and publication settlement.
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
import { matchesReadOnlyEarlierLogLine, recordNameRule, type RecordAssignment, type RecordMode } from "./record-names.ts";

export const RECORD_PAYLOAD_MAX = 1_048_576;
export function recordHash(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export interface RecordFileSystem {
	lstat(path: string): Promise<Stats>;
	open(path: string, flags: number, mode?: number): Promise<FileHandle>;
	realpath(path: string): Promise<string>;
	readdir(path: string): Promise<string[]>;
	mkdir(path: string, options: { mode: number }): Promise<unknown>;
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
	signal?: AbortSignal;
}
export interface RecordCleanup { leftover?: string; reason?: string }
export type RecordOutcomeState = "refused before publication" | "failed before publication" |
	"published and synced" | "published with uncertain durability" | "unknown outcome";
export interface RecordArtifact { path: string; kind: "temporary" | "version"; complete: boolean; reason: string }
export interface RecordWriteOutcome {
	record: string;
	mode: RecordMode;
	state: RecordOutcomeState;
	reason: string;
	abortObserved: boolean;
	observedBeforeHash?: string;
	observedAfterHash?: string;
	intendedHash?: string;
	publication: "not attempted" | "not published" | "returned" | "observed" | "unknown";
	sync: { candidate: boolean; version: boolean; record: boolean; folders: boolean; cleanup: boolean };
	artifacts: RecordArtifact[];
	replacement?: { version: string; oldHash: string; newHash: string };
}
export class RecordPrepublicationError extends Error {
	outcome?: RecordWriteOutcome;
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
	readonly mode: RecordMode;
	readonly temporaryPath: string;
	readonly candidateHash: string;
	/** Await settlement even when the signal aborts. Pre-publication errors carry outcome evidence. */
	publish(): Promise<RecordWriteOutcome>;
	/** A pending publication settles first. Cleanup before publication closes this prepared write. */
	cleanup(): Promise<RecordCleanup>;
}

async function syncDirectory(io: RecordFileSystem, path: string, basis: Stats): Promise<void> {
	await directory(io, path, basis);
	const handle = await io.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		if (!same(await handle.stat(), basis)) refuse("A sync folder changed identity. Inspect the folder before retrying.");
		await handle.sync();
		await directory(io, path, basis);
	} finally { await handle.close(); }
}

/** Observation permits the create's own second link, but never follows a symbolic link. */
async function observeRecord(io: RecordFileSystem, path: string): Promise<{ bytes: Buffer; identity: Stats } | undefined> {
	const entry = await optionalStat(io, path);
	if (!entry) return undefined;
	if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe observation");
	const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const identity = await handle.stat();
		if (!identity.isFile() || !same(entry, identity)) throw new Error("Changed observation");
		const bytes = await handle.readFile();
		const after = await io.lstat(path);
		if (!same(identity, after) || !after.isFile()) throw new Error("Changed observation");
		return { bytes, identity: after };
	} finally { await handle.close(); }
}

/** Prepare private bytes without registering a tool or granting worker authority. */
export async function prepareRecordWrite(context: RecordWriteContext, args: RecordWriteArguments, options: RecordWriteOptions = {}): Promise<PreparedRecordWrite> {
	try { return await prepare(context, args, options); } catch (error) {
		const failure = error instanceof RecordPrepublicationError ? error : new RecordPrepublicationError("failed before publication", "Record preparation failed. Inspect the record before retrying.", "preparation");
		failure.outcome ??= {
			record: typeof args.record === "string" && context.assignment.names.includes(args.record) ? args.record : "unassigned",
			mode: args.mode === "append" || args.mode === "replace" ? args.mode : "create",
			state: failure.state, reason: failure.message, abortObserved: options.signal?.aborted ?? false,
			publication: "not attempted", sync: { candidate: false, version: false, record: false, folders: false, cleanup: !failure.cleanup.leftover },
			artifacts: failure.cleanup.leftover ? [{ path: failure.cleanup.leftover, kind: "temporary", complete: false, reason: failure.cleanup.reason! }] : [],
		};
		throw failure;
	}
}
async function prepare(context: RecordWriteContext, args: RecordWriteArguments, options: RecordWriteOptions): Promise<PreparedRecordWrite> {
	// This gate precedes every filesystem call, including the facts provider.
	supported(options.platform ?? process.platform);
	if (options.signal?.aborted) refuse("The call was aborted before work. Inspect the record before retrying.");
	const io = options.fs ?? fs;
	const assignment = context.assignment;
	const folder = assignment.currentFolder.split("/");
	if (folder.length !== 2 || folder[0] !== "slate-changes" || !isChangeFolder(folder[1])) refuse("The current change folder is invalid. Open a valid change before retrying.");
	const current = folder[1];
	if (context.sourceFolder !== undefined && (!isChangeFolder(context.sourceFolder) || context.sourceFolder === current)) refuse("The read-only source conflicts with the current folder. Correct the trusted change facts before retrying.");
	const rule = recordNameRule(args.record);
	if (!rule || !assignment.names.includes(args.record as string) || rule.writerRole !== assignment.writerRole) refuse("The record is not assigned to this writer. Request the correct record assignment.");
	if ((args.mode !== "create" && args.mode !== "append" && args.mode !== "replace") || !rule.modes.includes(args.mode)) refuse(`This record mode is not allowed. Use ${rule.modes.join(" or ")} for this record.`);
	const record = args.record as string;
	const mode = args.mode;
	if (typeof args.payload !== "string" || Buffer.from(args.payload, "utf8").toString("utf8") !== args.payload) refuse("The payload is not valid Unicode text. Supply text without unpaired surrogate characters.");
	const payload = Buffer.from(args.payload, "utf8");
	if (payload.length > RECORD_PAYLOAD_MAX) refuse(`The payload exceeds 1,048,576 bytes. ${rule.modes.includes("append") ? "Split it into smaller append calls." : "Supply a smaller complete record."}`);
	if (mode === "create" ? args.expectedHash !== undefined : typeof args.expectedHash !== "string" || (args.expectedHash.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(args.expectedHash))) refuse(`The expected hash does not match the mode. ${mode === "create" ? "Omit it for create." : `Supply the current sha256 hash for ${mode}.`}`);
	let stage = "folder checks";
	let temporaryPath: string | undefined;
	let identity: Stats | undefined;
	let held: FileHandle | undefined;
	let cleanupFolder: { path: string; identity: Stats } | undefined;
	const evidence: RecordWriteOutcome = { record, mode, state: "failed before publication", reason: "Record preparation is incomplete.", abortObserved: false,
		publication: "not attempted", sync: { candidate: false, version: false, record: false, folders: false, cleanup: false }, artifacts: [] };
	try {
		const root = await io.realpath(context.projectRoot);
		const parent = join(root, "slate-changes");
		const destination = join(parent, current);
		const chain = await Promise.all([root, parent, destination].map(async (path) => ({ path, identity: await directory(io, path) })));
		cleanupFolder = chain[2];
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
		const earlier = mode !== "create" ? await readRecord(io, finalPath) : undefined;
		if (mode === "create") {
			const existing = await optionalStat(io, finalPath);
			if (existing?.isFile() && existing.nlink !== 1) refuse("The record already exists with extra hard links. Stop writers and inspect both names before retrying.");
			if (existing) refuse(`The record name already exists. Inspect it and use ${rule.modes.filter((allowed) => allowed !== "create").join(" or ")} with its current hash.`);
		}
		if (earlier) evidence.observedBeforeHash = recordHash(earlier.bytes);
		if (earlier && evidence.observedBeforeHash !== args.expectedHash) refuse("The expected hash is stale. Read the safe current record and use its fresh hash.");
		const candidate = mode === "append" ? Buffer.concat([earlier!.bytes, payload]) : payload;
		evidence.intendedHash = recordHash(candidate);
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
		await held.sync();
		evidence.sync.candidate = true;
		await held.close();
		held = undefined;
		let used = false;
		let pending: Promise<RecordWriteOutcome> | undefined;
		let cleanupResult: RecordCleanup = {};
		const clean = async () => {
			try { await recheck(); cleanupResult = await cleanupRecordTemporary(io, temporaryPath!, identity!); }
			catch { cleanupResult = { leftover: temporaryPath!, reason: "The folder changed during cleanup. Leave the temporary name untouched and inspect it." }; }
			evidence.sync.cleanup = !cleanupResult.leftover;
			if (cleanupResult.leftover) evidence.artifacts.push({ path: cleanupResult.leftover, kind: "temporary", complete: true, reason: cleanupResult.reason! });
			return cleanupResult;
		};
		const fail = async (error: unknown, at: string): Promise<never> => {
			const unavailable = ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code(error) ?? "");
			const failure = error instanceof RecordPrepublicationError ? error : new RecordPrepublicationError(unavailable ? "refused before publication" : "failed before publication", unavailable ? "The filesystem lacks a required write operation. Use a filesystem that supports hard links and sync." : `Record write failed during ${at}. Inspect the record and artifacts before retrying.`, at);
			failure.cleanup = await clean();
			try {
				for (const entry of chain.slice(2).reverse()) await syncDirectory(io, entry.path, entry.identity);
				evidence.sync.folders = true;
			} catch { failure.secondaryFailures.push("Cleanup folder sync failed. Inspect the record and artifacts before retrying."); }
			evidence.state = failure.state;
			evidence.reason = failure.message;
			evidence.abortObserved = options.signal?.aborted ?? false;
			failure.outcome = structuredClone(evidence);
			throw failure;
		};
		const retain = async () => {
			const versions = join(destination, "versions");
			await recheck();
			let basis = await optionalStat(io, versions);
			if (!basis) {
				await io.mkdir(versions, { mode: 0o700 });
				basis = await directory(io, versions);
				if ((basis.mode & 0o777) !== 0o700) refuse("The version folder is not private. Use a filesystem that supports owner-only folders.");
			}
			basis = await directory(io, versions, basis);
			chain.push({ path: versions, identity: basis });
			let greatest = 0;
			const stagingPrefix = `.slate-record-version-${record}.v`;
			for (const entry of await io.readdir(versions)) {
				if (entry.startsWith(stagingPrefix)) {
					const match = /^([1-9][0-9]*)\.[0-9a-f]{32}\.tmp$/.exec(entry.slice(stagingPrefix.length));
					if (!match || !Number.isSafeInteger(Number(match[1]))) refuse("A version staging entry has an invalid sequence. Inspect the version folder before retrying.");
					const staged = await readRecord(io, join(versions, entry));
					if ((staged.identity.mode & 0o777) !== 0o600) refuse("A version staging entry is not private. Inspect the version folder before retrying.");
					greatest = Math.max(greatest, Number(match[1]));
					evidence.artifacts.push({ path: join(versions, entry), kind: "temporary", complete: false, reason: "Earlier incomplete version evidence. Leave this private staging name untouched for inspection." });
					continue;
				}
				if (!entry.startsWith(record + ".v")) continue;
				const match = /^([1-9][0-9]*)\.([0-9a-f]{64})$/.exec(entry.slice(record.length + 2));
				if (!match || !Number.isSafeInteger(Number(match[1]))) refuse("A version entry has an invalid sequence or hash. Inspect the version folder before retrying.");
				const retained = await readRecord(io, join(versions, entry));
				if (recordHash(retained.bytes).slice(7) !== match[2] || (retained.identity.mode & 0o777) !== 0o600) refuse("A version entry has unsafe permissions or different bytes. Inspect the version folder before retrying.");
				greatest = Math.max(greatest, Number(match[1]));
			}
			const next = greatest + 1;
			const versionName = `${record}.v${next}.${evidence.observedBeforeHash!.slice(7)}`;
			if (!Number.isSafeInteger(next) || Buffer.byteLength(versionName) > 255) refuse("The next version name exceeds supported bounds. Inspect the version folder before retrying.");
			const versionPath = join(versions, versionName);
			const privatePath = join(versions, `${stagingPrefix}${next}.${randomBytes(16).toString("hex")}.tmp`);
			let privateIdentity: Stats | undefined;
			let privateHandle: FileHandle | undefined;
			let complete = false;
			let linked = false;
			let versionVerified = false;
			let retentionFailure: unknown;
			let cleanupFailure = false;
			try {
				await recheck();
				privateHandle = await io.open(privatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
				privateIdentity = await privateHandle.stat();
				if (!privateIdentity.isFile() || privateIdentity.nlink !== 1 || (privateIdentity.mode & 0o777) !== 0o600 || !same(privateIdentity, await io.lstat(privatePath))) refuse("The version staging file is not private or changed identity. Inspect it before retrying.");
				await privateHandle.writeFile(earlier!.bytes);
				await privateHandle.sync();
				await privateHandle.close();
				privateHandle = undefined;
				const verified = await readRecord(io, privatePath);
				if (!same(verified.identity, privateIdentity) || !verified.bytes.equals(earlier!.bytes) || (verified.identity.mode & 0o777) !== 0o600) refuse("The staged version changed. Inspect its identity and bytes before retrying.");
				complete = true;
				await recheck();
				try { await io.link(privatePath, versionPath); linked = true; }
				catch (error) {
					const entry = await optionalStat(io, versionPath);
					linked = !!entry && same(entry, privateIdentity);
					if (code(error) === "EEXIST") {
						if (entry && !linked) evidence.artifacts.push({ path: versionPath, kind: "version", complete: false, reason: "A different file occupies the version name. Leave it untouched and inspect the collision." });
						refuse("The version name already exists. Inspect the collision before retrying.");
					}
					throw error;
				}
				const copy = await observeRecord(io, versionPath);
				if (!copy || !same(copy.identity, privateIdentity) || !copy.bytes.equals(earlier!.bytes) || (copy.identity.mode & 0o777) !== 0o600) refuse("The retained version changed identity or bytes. Inspect it before retrying.");
				versionVerified = true;
				const versionHandle = await io.open(versionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					if (!same(await versionHandle.stat(), privateIdentity)) refuse("The version sync identity changed. Inspect it before retrying.");
					await versionHandle.sync();
				} finally { await versionHandle.close(); }
			} catch (error) { retentionFailure = error; } finally {
				try { await privateHandle?.close(); } catch { evidence.artifacts.push({ path: privatePath, kind: "temporary", complete: false, reason: "The version handle did not close. Inspect open handles." }); }
				if (linked) evidence.artifacts.push({ path: versionPath, kind: "version", complete: versionVerified, reason: versionVerified ? "Retained earlier bytes. Keep this version unchanged." : "Version verification is incomplete. Inspect this name before relying on it." });
				if (!privateIdentity && privateHandle) evidence.artifacts.push({ path: privatePath, kind: "temporary", complete: false, reason: "The version temporary identity is unknown. Leave this name untouched and inspect it." });
				if (privateIdentity) {
					const result = await cleanupRecordTemporary(io, privatePath, privateIdentity);
					if (result.leftover) {
						evidence.artifacts.push({ path: privatePath, kind: "temporary", complete, reason: complete ? result.reason! : "Incomplete version evidence. Inspect this private partial copy." });
						cleanupFailure = true;
					}
				}
			}
			if (retentionFailure) {
				if (cleanupFailure && retentionFailure instanceof RecordPrepublicationError) retentionFailure.secondaryFailures.push("Version temporary cleanup failed. Inspect the remaining artifact.");
				throw retentionFailure;
			}
			if (cleanupFailure) refuse("Version temporary cleanup failed. Inspect the retained copy and temporary name before retrying.");
			const retained = await readRecord(io, versionPath);
			if (!retained.bytes.equals(earlier!.bytes)) refuse("The retained version bytes changed. Inspect the version before retrying.");
			await syncDirectory(io, versions, basis);
			await syncDirectory(io, destination, chain[2]!.identity);
			evidence.sync.version = true;
			evidence.replacement = { version: versionPath, oldHash: evidence.observedBeforeHash!, newHash: evidence.intendedHash! };
		};
		const publish = async (): Promise<RecordWriteOutcome> => {
			let publicationStage = "version retention";
			try {
				if (options.signal?.aborted) refuse("The call was aborted before publication. Inspect the record before retrying.");
				if (mode === "replace") await retain();
				publicationStage = "final safety check";
				await options.beforeFinalCheck?.();
				await recheck();
				await readOnly();
				const temp = await readRecord(io, temporaryPath!);
				if (!same(temp.identity, identity!) || (temp.identity.mode & 0o777) !== 0o600 || !temp.bytes.equals(candidate)) refuse("The private candidate changed identity, permissions, or bytes. Inspect the temporary file before retrying.");
				if (earlier) {
					const now = await readRecord(io, finalPath);
					if (!same(now.identity, earlier.identity) || !now.bytes.equals(earlier.bytes)) {
						evidence.observedAfterHash = recordHash(now.bytes);
						refuse("The record changed before publication. Read the safe current record and use its fresh hash.");
					}
				} else if (await optionalStat(io, finalPath)) refuse("The record name appeared before publication. Inspect it before retrying.");
				await recheck();
				if (options.signal?.aborted) refuse("The call was aborted before publication. Inspect the record before retrying.");
			} catch (error) { return fail(error, publicationStage); }
			let publicationError: unknown;
			try {
				if (mode === "create") await io.link(temporaryPath!, finalPath);
				else await io.rename(temporaryPath!, finalPath);
				evidence.publication = "returned";
			} catch (error) { publicationError = error; evidence.publication = "unknown"; }
			let observed: Awaited<ReturnType<typeof observeRecord>>;
			let observationFailed = false;
			try { await recheck(); observed = await observeRecord(io, finalPath); }
			catch { observationFailed = true; }
			if (observed) evidence.observedAfterHash = recordHash(observed.bytes);
			const landed = observed && same(observed.identity, identity!) && observed.bytes.equals(candidate);
			if (publicationError && !landed) {
				if (mode === "create" && code(publicationError) === "EEXIST" && observed && !same(observed.identity, identity!)) {
					evidence.publication = "not published";
					return fail(new RecordPrepublicationError("refused before publication", "The record name already exists. Inspect it before retrying.", "exclusive publication"), "publication");
				}
				if (!observationFailed && (!observed || earlier && same(observed.identity, earlier.identity) && observed.bytes.equals(earlier.bytes))) {
					evidence.publication = "not published";
					return fail(publicationError, "publication");
				}
			}
			const known = evidence.publication === "returned" || !!landed;
			if (landed && publicationError) evidence.publication = "observed";
			let settlementFailure = false;
			try {
				if (!landed) throw new Error("Candidate observation is missing");
				await recheck();
				const finalHandle = await io.open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					const finalIdentity = await finalHandle.stat();
					if (!same(finalIdentity, identity!) || !finalIdentity.isFile() || (finalIdentity.mode & 0o777) !== 0o600) throw new Error("Published identity changed");
					await finalHandle.sync();
					evidence.sync.record = true;
				} finally { await finalHandle.close(); }
			} catch { settlementFailure = true; }
			await clean();
			try {
				await recheck();
				await syncDirectory(io, destination, chain[2]!.identity);
				evidence.sync.folders = true;
				const final = await readRecord(io, finalPath);
				evidence.observedAfterHash = recordHash(final.bytes);
				if (!same(final.identity, identity!) || !final.bytes.equals(candidate) || (final.identity.mode & 0o777) !== 0o600) throw new Error("Final candidate changed");
			} catch { settlementFailure = true; }
			evidence.abortObserved = options.signal?.aborted ?? false;
			evidence.state = !known ? "unknown outcome" : settlementFailure || publicationError || !evidence.sync.cleanup ? "published with uncertain durability" : "published and synced";
			evidence.reason = evidence.state === "published and synced" ? "The record is published and synced. Do not repeat this write." :
				evidence.state === "unknown outcome" ? "Publication could not be established. Pause dependent work and inspect the record and artifacts before retrying." :
				"Publication occurred but settlement is uncertain. Pause dependent work and inspect the record and artifacts before retrying.";
			return structuredClone(evidence);
		};
		return {
			record, mode, temporaryPath, candidateHash: evidence.intendedHash,
			publish() {
				if (used) {
					const failure = new RecordPrepublicationError("refused before publication", "This prepared write was already used. Inspect the current record before preparing another call.", "admission");
					failure.outcome = { ...structuredClone(evidence), state: failure.state, reason: failure.message, publication: "not attempted", abortObserved: options.signal?.aborted ?? false };
					return Promise.reject(failure);
				}
				used = true;
				pending = publish();
				return pending;
			},
			async cleanup() {
				if (pending) { await pending.catch(() => undefined); return cleanupResult; }
				used = true;
				const result = await clean();
				try { await syncDirectory(io, destination, chain[2]!.identity); evidence.sync.folders = true; }
				catch { return { ...result, reason: result.reason ?? "Cleanup folder sync failed. Inspect the temporary name before retrying." }; }
				return result;
			},
		};
	} catch (error) {
		const unavailable = ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code(error) ?? "");
		const failure = error instanceof RecordPrepublicationError ? error : new RecordPrepublicationError(unavailable ? "refused before publication" : "failed before publication", unavailable ? "The filesystem lacks a required write operation. Use a filesystem that supports private files and sync." : `Record preparation failed during ${stage}. Inspect the record and artifacts before retrying.`, stage);
		try { await held?.close(); } catch { failure.secondaryFailures.push("The staging handle did not close. Inspect open handles before retrying."); }
		if (temporaryPath && identity) failure.cleanup = await cleanupRecordTemporary(io, temporaryPath, identity);
		else if (temporaryPath && held) failure.cleanup = { leftover: temporaryPath, reason: "The temporary identity is unknown. Leave the name untouched and inspect it." };
		if (temporaryPath && cleanupFolder) {
			try { await syncDirectory(io, cleanupFolder.path, cleanupFolder.identity); evidence.sync.folders = true; }
			catch { failure.secondaryFailures.push("Cleanup folder sync failed. Inspect the record and artifacts before retrying."); }
		}
		evidence.state = failure.state;
		evidence.reason = failure.message;
		evidence.abortObserved = options.signal?.aborted ?? false;
		evidence.sync.cleanup = !failure.cleanup.leftover;
		if (failure.cleanup.leftover) evidence.artifacts.push({ path: failure.cleanup.leftover, kind: "temporary", complete: evidence.sync.candidate, reason: failure.cleanup.reason! });
		failure.outcome = structuredClone(evidence);
		throw failure;
	}
}
