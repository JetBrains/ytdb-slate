import { createHash } from "node:crypto";
import {
	accessSync,
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
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { drawSlateMint, isSlateSessionName, sessionNameFromBytes } from "./session-names.ts";

export class SlateWriteRefused extends Error {}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY_ONLY = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
// SE91. A FIFO or a device node blocks INSIDE openSync, so a type check that runs after
// the open never runs at all. The type check below moved before the open, and this flag is
// the second line for a path that becomes a FIFO between the two calls. It changes nothing
// for a regular file, which is the only thing this module ever accepts.
const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

function regularFile(entry: { isFile(): boolean; isSymbolicLink(): boolean } | undefined): boolean {
	return entry?.isFile() === true && !entry.isSymbolicLink();
}

/**
 * A FORK SOURCE must be the only name of its inode (SE92). That rule does not govern
 * ordinary corpus reads: a hardlink snapshot such as `cp -al` gives an episode or an
 * owned transcript a second safe name, and refusing every such read made restore erase
 * the records (RG271). The caller below selects this stronger predicate only where bytes
 * cross into a new writable transcript.
 */
function singleNamedFile(entry: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number } | undefined): boolean {
	return regularFile(entry) && entry!.nlink === 1;
}

function refuse(message: string, cause?: unknown): never {
	throw new SlateWriteRefused(message, cause === undefined ? undefined : { cause });
}

export function sameFileIdentity(a: ReturnType<typeof fstatSync>, b: NonNullable<ReturnType<typeof lstatSync>>): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/** Resolve every existing component and append an absent tail without creating it. */
function resolveProspectivePath(value: string): string {
	const absolute = resolve(value);
	const parsed = parse(absolute);
	let current = parsed.root;
	const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
	for (let index = 0; index < parts.length; index++) {
		const next = join(current, parts[index]!);
		if (lstatSync(next, { throwIfNoEntry: false }) === undefined) return join(current, ...parts.slice(index));
		current = realpathSync(next);
	}
	return current;
}

function ensureRealDirectory(path: string): void {
	let entry = lstatSync(path, { throwIfNoEntry: false });
	if (entry === undefined) {
		try {
			mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
		entry = lstatSync(path, { throwIfNoEntry: false });
	}
	if (entry?.isSymbolicLink()) refuse("slate refused a corpus directory because that path is a symbolic link");
	if (!entry?.isDirectory()) refuse("slate refused a corpus directory because that path is not a directory");
}

function fsyncDirectory(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY);
		fsyncSync(fd);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export interface HeldCorpusDirectory {
	fd: number;
	stat: ReturnType<typeof fstatSync>;
	path: string;
}

export function corpusDirectoryMatches(held: HeldCorpusDirectory, path = held.path): boolean {
	try {
		const current = lstatSync(path, { throwIfNoEntry: false });
		return held.stat.isDirectory() && current?.isDirectory() === true && !current.isSymbolicLink()
			&& sameFileIdentity(held.stat, current) && realpathSync(path) === path;
	} catch {
		return false;
	}
}

export function holdCorpusDirectory(path: string): HeldCorpusDirectory {
	const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | DIRECTORY_ONLY);
	try {
		const held = { fd, stat: fstatSync(fd), path };
		if (!corpusDirectoryMatches(held)) refuse("slate refused a linked or changing corpus directory");
		return held;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

export function fsyncHeldCorpusDirectory(held: HeldCorpusDirectory): "fsync" {
	try {
		fsyncSync(held.fd);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
	}
	return "fsync";
}

export function resolveCorpusRoot(): string {
	return join(resolveProspectivePath(getAgentDir()), "ytdb-slate", "projects");
}

export function ensureCorpusRoot(): string {
	try {
		const agent = resolveProspectivePath(getAgentDir());
		mkdirSync(agent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		if (!statSync(agent).isDirectory()) refuse("slate refused the pi agent path because it is not a directory");
		let current = agent;
		for (const component of ["ytdb-slate", "projects"]) {
			current = join(current, component);
			ensureRealDirectory(current);
		}
		if (realpathSync(current) !== current) refuse("slate refused the corpus root because its path changed");
		accessSync(current, constants.W_OK);
		return current;
	} catch (error) {
		if (error instanceof SlateWriteRefused) throw error;
		refuse("slate could not create or write its corpus root", error);
	}
}

export function gitEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_COMMON_DIR;
	delete env.GIT_WORK_TREE;
	return env;
}

function git(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, { cwd, env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	if (result.status !== 0) return undefined;
	const output = result.stdout.replace(/\r?\n$/u, "");
	return output === "" ? undefined : output;
}

export function resolveProjectKey(cwd: string): string {
	const resolvedCwd = realpathSync(cwd);
	const common = git(resolvedCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return common === undefined ? resolvedCwd : resolve(common);
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeCorpusLabel(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "" || value === "." || value === "..") return undefined;
	if (/[/\\]/.test(value) || value.startsWith("-") || /^\s*$/u.test(value)) return undefined;
	const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().replace(/\s+/g, "-");
	if (clean === "" || clean === "." || clean === ".." || clean.startsWith("-") || WINDOWS_RESERVED.test(clean)) return undefined;
	const safe = clean.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[._]+|[._-]+$/g, "");
	return safe === "" || WINDOWS_RESERVED.test(safe) ? undefined : safe.slice(0, 48);
}

export interface CorpusProject {
	root: string;
	key: string;
	label: string;
	digest: string;
	directory: string;
	matchingDirectories: string[];
}

function existingDigestDirectories(root: string, digest: string): string[] {
	try {
		return readdirSync(root)
			.filter((name) => name.endsWith(`-${digest}`))
			.map((name) => join(root, name))
			.filter((path) => {
				const entry = lstatSync(path, { throwIfNoEntry: false });
				return entry?.isDirectory() === true && !entry.isSymbolicLink();
			})
			.sort();
	} catch {
		return [];
	}
}

export function resolveCorpusProject(cwd: string, corpusName?: unknown): CorpusProject {
	const root = resolveCorpusRoot();
	const key = resolveProjectKey(cwd);
	const origin = git(cwd, ["remote", "get-url", "origin"]);
	const originLeaf = origin === undefined
		? undefined
		: origin.replace(/[\\/]$/, "").split(/[\\/:]/).at(-1)?.replace(/\.git$/i, "");
	const keyLeaf = basename(key).replace(/\.git$/i, "") || basename(dirname(key));
	const label = [corpusName, originLeaf, keyLeaf, "project"].map(sanitizeCorpusLabel).find((item) => item !== undefined) ?? "project";
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
	const preferred = join(root, `${label}-${digest}`);
	const matchingDirectories = existingDigestDirectories(root, digest);
	if (matchingDirectories.length > 1) {
		refuse(`slate found several corpus project directories for digest ${digest}: ${matchingDirectories.join(", ")}`);
	}
	return { root, key, label, digest, directory: matchingDirectories[0] ?? preferred, matchingDirectories };
}

export function ensureCorpusProjectDirectory(project: CorpusProject): void {
	const root = ensureCorpusRoot();
	if (root !== project.root) refuse("slate refused a corpus project because its root changed");
	if (dirname(project.directory) !== root || !project.directory.endsWith(`-${project.digest}`)) {
		refuse("slate refused a corpus project outside its direct digest path");
	}
	ensureRealDirectory(project.directory);
	if (realpathSync(project.directory) !== project.directory) refuse("slate refused a corpus project because its path changed");
}

export interface SessionMetadata {
	identity: string;
	name: string;
	createdAt: string;
	worktreePath: string;
	branchLabel: string;
	piSessionName?: string;
}

function durableJson(file: string, value: unknown): void {
	const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
	try {
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncDirectory(resolve(file, ".."));
}

function readJsonNoFollow(file: string): unknown {
	const fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
	try {
		const held = fstatSync(fd);
		const current = lstatSync(file, { throwIfNoEntry: false });
		if (!held.isFile() || !current?.isFile() || current.isSymbolicLink() || !sameFileIdentity(held, current)) {
			refuse("slate refused linked or changing session metadata");
		}
		const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
		const after = lstatSync(file, { throwIfNoEntry: false });
		if (!after?.isFile() || after.isSymbolicLink() || !sameFileIdentity(held, after)) refuse("slate refused changing session metadata");
		return parsed;
	} finally {
		closeSync(fd);
	}
}

export function currentBranchLabel(cwd: string): string {
	return git(cwd, ["branch", "--show-current"]) ?? "";
}

function metadataAt(directory: string, expectedName: string): SessionMetadata | undefined {
	try {
		const entry = lstatSync(directory, { throwIfNoEntry: false });
		if (!entry?.isDirectory() || entry.isSymbolicLink()) return undefined;
		const raw = readJsonNoFollow(join(directory, "session.json"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
		const metadata = raw as Partial<SessionMetadata> & { policy?: unknown };
		if (metadata.policy !== undefined) return undefined;
		return metadata.name === expectedName && typeof metadata.identity === "string" ? metadata as SessionMetadata : undefined;
	} catch {
		return undefined;
	}
}

export function validateCorpusSession(project: CorpusProject, name: string, identity: string | undefined): boolean {
	if (!isSlateSessionName(name)) return false;
	const metadata = metadataAt(join(project.directory, name), name);
	return metadata !== undefined && (identity === undefined || metadata.identity === identity);
}

export interface IdentityScan {
	match?: { name: string; directory: string };
	duplicates: string[];
}

export function scanCorpusSessionsByIdentity(project: CorpusProject, identity: string): IdentityScan {
	const matches: Array<{ name: string; directory: string }> = [];
	let entries: string[];
	try { entries = readdirSync(project.directory); } catch { return { duplicates: [] }; }
	for (const name of entries) {
		if (!isSlateSessionName(name)) continue;
		const directory = join(project.directory, name);
		const metadata = metadataAt(directory, name);
		if (metadata?.identity === identity) matches.push({ name, directory });
	}
	matches.sort((a, b) => a.name.localeCompare(b.name));
	return matches.length === 1
		? { match: matches[0], duplicates: [] }
		: { duplicates: matches.map((item) => item.directory) };
}

export function findCorpusSessionByIdentity(project: CorpusProject, identity: string): { name: string; directory: string } | undefined {
	return scanCorpusSessionsByIdentity(project, identity).match;
}

function nameCandidate(bytes: Uint8Array): string {
	const name = sessionNameFromBytes(bytes);
	if (!isSlateSessionName(name)) refuse("slate refused an invalid generated session name");
	return name;
}

function publishSessionDirectory(directory: string, metadata: SessionMetadata, attempt: number): boolean {
	const parent = resolve(directory, "..");
	const staging = join(parent, `.creating-${metadata.name}-${process.pid}-${attempt}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { mode: PRIVATE_DIRECTORY_MODE });
	try {
		for (const category of ["episodes", "observations", "threads"]) mkdirSync(join(staging, category), { mode: PRIVATE_DIRECTORY_MODE });
		durableJson(join(staging, "session.json"), metadata);
		fsyncDirectory(staging);
		fsyncDirectory(parent);
		try {
			renameSync(staging, directory);
			fsyncDirectory(parent);
			return true;
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST" && (error as { code?: string }).code !== "ENOTEMPTY") throw error;
			return false;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

export function createCorpusSession(opts: {
	cwd: string;
	project?: CorpusProject;
	corpusName?: unknown;
	identity: string;
	initialNameBytes?: Uint8Array;
	piSessionName?: string;
	now?: Date;
	drawRetry?: () => Uint8Array;
}): { project: CorpusProject; name: string; directory: string; created: true } {
	const project = opts.project ?? resolveCorpusProject(opts.cwd, opts.corpusName);
	try {
		ensureCorpusProjectDirectory(project);
		for (let attempt = 0; attempt < 8; attempt++) {
			const name = nameCandidate(
				attempt === 0 && opts.initialNameBytes !== undefined
					? opts.initialNameBytes
					: opts.drawRetry?.() ?? drawSlateMint(4).nameBytes,
			);
			const directory = join(project.directory, name);
			const metadata: SessionMetadata = {
				identity: opts.identity,
				name,
				createdAt: (opts.now ?? new Date()).toISOString(),
				worktreePath: realpathSync(opts.cwd),
				branchLabel: currentBranchLabel(opts.cwd),
				...(opts.piSessionName === undefined ? {} : { piSessionName: opts.piSessionName }),
			};
			if (publishSessionDirectory(directory, metadata, attempt)) return { project, name, directory, created: true };
		}
		refuse("slate could not mint a unique session name after eight attempts");
	} catch (error) {
		if (error instanceof SlateWriteRefused) throw error;
		refuse("slate could not create its session directory", error);
	}
}

export function removeCorpusSession(project: CorpusProject, identity: string, name: string): void {
	const directory = join(project.directory, name);
	const metadata = metadataAt(directory, name);
	if (metadata?.identity !== identity) return;
	rmSync(directory, { recursive: true, force: true });
	fsyncDirectory(project.directory);
}

function rootsFor(cwd: string, projectDirectory?: string): string[] {
	const legacy = join(realpathSync(cwd), CONFIG_DIR_NAME, "slate");
	return [...(projectDirectory === undefined ? [] : [projectDirectory]), ...["episodes", "observations", "threads"].map((kind) => join(legacy, kind))];
}

export function insideRoot(root: string, file: string): boolean {
	const rel = relative(root, file);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function withContainedRoots<T>(
	value: unknown,
	roots: string[],
	use: (fd: number, path: string) => T,
	requireSingleName = false,
	afterOpen?: (fd: number) => void,
): T | undefined {
	if (typeof value !== "string" || value === "" || !isAbsolute(value)) return undefined;
	const acceptable = requireSingleName ? singleNamedFile : regularFile;
	// BEFORE any open: reject FIFOs, devices and links. lstat follows nothing and blocks
	// on nothing (SE91). Fork sources additionally reject hardlinks (SE92).
	if (!acceptable(lstatSync(value, { throwIfNoEntry: false }) ?? undefined)) return undefined;
	for (const expected of roots) {
		let root: string;
		try {
			root = realpathSync(expected);
			if (root !== expected || !statSync(root).isDirectory() || !insideRoot(root, value)) continue;
		} catch {
			continue;
		}
		let fd: number | undefined;
		let opened: { fd: number; held: ReturnType<typeof fstatSync>; canonical: string } | undefined;
		try {
			fd = openSync(value, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
			afterOpen?.(fd);
			const held = fstatSync(fd);
			const current = lstatSync(value, { throwIfNoEntry: false });
			if (!acceptable(held) || !acceptable(current ?? undefined) || !sameFileIdentity(held, current!)) return undefined;
			const canonical = realpathSync(value);
			if (canonical !== value || !insideRoot(root, canonical)) return undefined;
			opened = { fd, held, canonical };
		} catch {
			return undefined;
		} finally {
			// BG9. Every return or throw after open and before callback ownership closes here.
			// All public containment helpers delegate to this acquisition path.
			if (opened === undefined && fd !== undefined) closeSync(fd);
		}
		try {
			const result = use(opened.fd, opened.canonical);
			const after = lstatSync(value, { throwIfNoEntry: false });
			if (!acceptable(after ?? undefined) || !sameFileIdentity(opened.held, after!)) return undefined;
			return result;
		} finally {
			closeSync(opened.fd);
		}
	}
	return undefined;
}

export function withContainedFile<T>(
	cwd: string,
	value: unknown,
	projectDirectory: string | undefined,
	use: (fd: number, path: string) => T,
): T | undefined {
	let roots: string[];
	try { roots = rootsFor(cwd, projectDirectory); } catch { return undefined; }
	return withContainedRoots(value, roots, use);
}

/**
 * Accept an absent artifact only when its prospective canonical path remains under an
 * approved root. Existing artifacts still pass through the descriptor-backed reader.
 */
function containedOrMissing(value: unknown, roots: string[], resolveExisting: () => string | undefined): boolean {
	if (typeof value !== "string" || value === "" || !isAbsolute(value)) return false;
	if (lstatSync(value, { throwIfNoEntry: false }) !== undefined) return resolveExisting() !== undefined;
	try {
		const prospective = resolveProspectivePath(value);
		if (prospective !== resolve(value)) return false;
		return roots.some((expected) => {
			try {
				const root = realpathSync(expected);
				return root === expected && statSync(root).isDirectory() && insideRoot(root, prospective);
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

export function isContainedOrMissingFile(cwd: string, value: unknown, projectDirectory?: string): boolean {
	let roots: string[];
	try { roots = rootsFor(cwd, projectDirectory); } catch { return false; }
	return containedOrMissing(value, roots, () => resolveContainedFile(cwd, value, projectDirectory));
}

function threadRoots(cwd: string, projectDirectory: string | undefined): string[] | undefined {
	try {
		const legacy = join(realpathSync(cwd), CONFIG_DIR_NAME, "slate", "threads");
		return [...(projectDirectory === undefined ? [] : [projectDirectory]), legacy];
	} catch {
		return undefined;
	}
}

export function withContainedThreadFile<T>(
	cwd: string,
	value: unknown,
	projectDirectory: string | undefined,
	use: (fd: number, path: string) => T,
	afterOpen?: (fd: number) => void,
): T | undefined {
	const roots = threadRoots(cwd, projectDirectory);
	return roots === undefined ? undefined : withContainedRoots(value, roots, use, false, afterOpen);
}

export function isContainedOrMissingThreadFile(cwd: string, value: unknown, projectDirectory?: string): boolean {
	const roots = threadRoots(cwd, projectDirectory);
	return roots !== undefined && containedOrMissing(value, roots, () => resolveContainedThreadFile(cwd, value, projectDirectory));
}

/** Strict source boundary for bytes that SessionManager.forkFrom copies (SE92, RG271). */
export function withContainedForkSource<T>(
	cwd: string,
	value: unknown,
	projectDirectory: string | undefined,
	use: (fd: number, path: string) => T,
): T | undefined {
	const roots = threadRoots(cwd, projectDirectory);
	return roots === undefined ? undefined : withContainedRoots(value, roots, use, true);
}

export function readContainedFile(cwd: string, value: unknown, projectDirectory?: string): Buffer | undefined {
	return withContainedFile(cwd, value, projectDirectory, (fd) => readFileSync(fd));
}

export function resolveContainedFile(cwd: string, value: unknown, projectDirectory?: string): string | undefined {
	return withContainedFile(cwd, value, projectDirectory, (_fd, path) => path);
}

export function resolveContainedThreadFile(cwd: string, value: unknown, projectDirectory?: string): string | undefined {
	return withContainedThreadFile(cwd, value, projectDirectory, (_fd, path) => path);
}

/**
 * D121 asks for a best-effort fsync. A kernel or filesystem that refuses one on a
 * read-only descriptor must not fail a publication that is otherwise verified.
 */
function bestEffortFsync(fd: number): void {
	try {
		fsyncSync(fd);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EACCES" && code !== "EBADF") throw error;
	}
}

/**
 * Verify and publish one staged file without exposing a partial or unverified
 * destination.
 *
 * SE93 rewrote this. The staged inode is PINNED for the whole sequence: the caller's
 * verification reads the pinned descriptor, the fsync uses that descriptor, and the
 * identity is re-checked immediately before and after publication, so a staged name that
 * is replaced mid-flight cannot publish unverified bytes. D107's rename stays the
 * publication step, but the destination NAME is reserved first by an exclusive create,
 * because a rename on its own replaces a file created after any check this function could
 * make. After that reservation the rename can replace this call's own placeholder only.
 */
export function publishStagedFile(stagingFile: string, finalFile: string, verify: (fd: number, path: string) => void): void {
	const stagingDirectory = dirname(stagingFile);
	const finalDirectory = dirname(finalFile);
	const staging = lstatSync(stagingFile, { throwIfNoEntry: false }) ?? undefined;
	if (!singleNamedFile(staging)) refuse("slate refused a missing or linked staged file");
	if (lstatSync(finalFile, { throwIfNoEntry: false }) !== undefined) refuse("slate refused to replace an existing published file");
	if (realpathSync(stagingDirectory) !== stagingDirectory || realpathSync(finalDirectory) !== finalDirectory) {
		refuse("slate refused a staging directory because its path changed");
	}
	if (resolveProspectivePath(finalFile) !== finalFile) refuse("slate refused a destination because its path changed");
	const fd = openSync(stagingFile, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
	try {
		const held = fstatSync(fd);
		if (!singleNamedFile(held) || !sameFileIdentity(held, staging!)) refuse("slate refused a staged file because it changed");
		verify(fd, stagingFile);
		bestEffortFsync(fd);
		fsyncDirectory(stagingDirectory);
		const before = lstatSync(stagingFile, { throwIfNoEntry: false }) ?? undefined;
		if (!singleNamedFile(before) || !sameFileIdentity(held, before!)) refuse("slate refused a staged file because it changed");
		try {
			closeSync(openSync(finalFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE));
		} catch (error) {
			if ((error as { code?: string }).code === "EEXIST") refuse("slate refused to replace an existing published file", error);
			throw error;
		}
		try {
			renameSync(stagingFile, finalFile);
		} catch (error) {
			try { unlinkSync(finalFile); } catch { /* the staged name still holds the only copy */ }
			refuse("slate could not publish the staged file", error);
		}
		const published = lstatSync(finalFile, { throwIfNoEntry: false }) ?? undefined;
		if (!singleNamedFile(published) || !sameFileIdentity(held, published!)) refuse("slate refused a published file because it changed");
		fsyncDirectory(stagingDirectory);
		fsyncDirectory(finalDirectory);
	} finally {
		closeSync(fd);
	}
}
