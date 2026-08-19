import { createHash } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { drawSlateMint, isSlateSessionName, sessionNameFromBytes } from "./session-names.ts";

export class SlateWriteRefused extends Error {}

function refuse(message: string, cause?: unknown): never {
	throw new SlateWriteRefused(message, cause === undefined ? undefined : { cause });
}

function ensureRealDirectory(path: string): void {
	let entry = lstatSync(path, { throwIfNoEntry: false });
	if (entry === undefined) {
		try {
			mkdirSync(path);
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
		entry = lstatSync(path, { throwIfNoEntry: false });
	}
	if (entry?.isSymbolicLink()) refuse("slate refused a corpus directory because that path is a symbolic link");
	if (!entry?.isDirectory()) refuse("slate refused a corpus directory because that path is not a directory");
}

export function resolveCorpusRoot(): string {
	return join(resolve(getAgentDir()), "ytdb-slate", "projects");
}

export function ensureCorpusRoot(): string {
	try {
		const agent = resolve(getAgentDir());
		mkdirSync(agent, { recursive: true });
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

function git(cwd: string, args: string[]): string | undefined {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_COMMON_DIR;
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined;
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
	return { root, key, label, digest, directory: join(root, `${label}-${digest}`) };
}

function ensureProjectDirectory(project: CorpusProject): void {
	const root = ensureCorpusRoot();
	if (root !== project.root) refuse("slate refused a corpus project because its root changed");
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

function durableJson(file: string, value: SessionMetadata): void {
	const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const dirFd = openSync(dirname(file), constants.O_RDONLY);
	try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

export function currentBranchLabel(cwd: string): string {
	return git(cwd, ["branch", "--show-current"]) ?? "";
}

export function createCorpusSession(opts: {
	cwd: string;
	corpusName?: unknown;
	identity: string;
	initialNameBytes?: Uint8Array;
	piSessionName?: string;
	now?: Date;
	drawRetry?: () => Uint8Array;
}): { project: CorpusProject; name: string; directory: string } {
	const project = resolveCorpusProject(opts.cwd, opts.corpusName);
	try {
		ensureProjectDirectory(project);
		for (let attempt = 0; attempt < 8; attempt++) {
			const bytes = attempt === 0 && opts.initialNameBytes !== undefined
				? opts.initialNameBytes
				: opts.drawRetry?.() ?? drawSlateMint(4).nameBytes;
			const name = sessionNameFromBytes(bytes);
			if (!isSlateSessionName(name)) refuse("slate refused an invalid generated session name");
			const directory = join(project.directory, name);
			try {
				mkdirSync(directory);
			} catch (error) {
				if ((error as { code?: string }).code === "EEXIST") continue;
				throw error;
			}
			for (const category of ["episodes", "observations", "threads"]) ensureRealDirectory(join(directory, category));
			const metadata: SessionMetadata = {
				identity: opts.identity,
				name,
				createdAt: (opts.now ?? new Date()).toISOString(),
				worktreePath: realpathSync(opts.cwd),
				branchLabel: currentBranchLabel(opts.cwd),
				...(opts.piSessionName === undefined ? {} : { piSessionName: opts.piSessionName }),
			};
			durableJson(join(directory, "session.json"), metadata);
			return { project, name, directory };
		}
		refuse("slate could not mint a unique session name after eight attempts");
	} catch (error) {
		if (error instanceof SlateWriteRefused) throw error;
		refuse("slate could not create its session directory", error);
	}
}

export function findCorpusSessionByIdentity(project: CorpusProject, identity: string): { name: string; directory: string } | undefined {
	try {
		const matches: Array<{ name: string; directory: string }> = [];
		for (const name of readdirSync(project.directory)) {
			if (!isSlateSessionName(name)) continue;
			const directory = join(project.directory, name);
			const entry = lstatSync(directory, { throwIfNoEntry: false });
			if (!entry?.isDirectory() || entry.isSymbolicLink()) continue;
			const parsed = JSON.parse(readFileSync(join(directory, "session.json"), "utf8")) as { identity?: unknown; name?: unknown };
			if (parsed.identity === identity && parsed.name === name) matches.push({ name, directory });
		}
		return matches.sort((a, b) => a.name.localeCompare(b.name))[0];
	} catch {
		return undefined;
	}
}

function hasSymlinkFrom(root: string, file: string): boolean {
	const rel = relative(root, file);
	let current = root;
	for (const component of rel.split(sep)) {
		current = join(current, component);
		if (lstatSync(current).isSymbolicLink()) return true;
	}
	return false;
}

export function resolveContainedFile(cwd: string, value: unknown, corpusName?: unknown): string | undefined {
	if (typeof value !== "string" || value === "" || !isAbsolute(value)) return undefined;
	try {
		const project = resolveCorpusProject(cwd, corpusName);
		const legacy = join(realpathSync(cwd), ".pi", "slate");
		const roots = [project.directory, ...["episodes", "observations", "threads"].map((kind) => join(legacy, kind))];
		for (const expected of roots) {
			const root = realpathSync(expected);
			if (root !== expected || !statSync(root).isDirectory()) continue;
			const rel = relative(root, value);
			if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
			if (hasSymlinkFrom(root, value)) return undefined;
			const file = realpathSync(value);
			if (file !== value || !statSync(file).isFile()) return undefined;
			return file;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
