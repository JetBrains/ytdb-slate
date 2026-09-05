/**
 * Worker extensions: resolving which of the HOST session's pi extensions a
 * worker thread is allowed to load.
 *
 * Workers normally load NO extensions (worker.ts, depth-1 recursion guard D7).
 * This module lets a trusted project opt SPECIFIC host extensions back in, by
 * regex, via the `workerExtensions` config. It NEVER loads anything itself —
 * it only resolves a SET of extension load units (file paths or package
 * directories) and the tool names they contribute, which part 2 hands to a
 * worker's DefaultResourceLoader/tools allowlist. The resolution is what makes
 * the feature safe; the load semantics stay pi's own.
 *
 * The mechanism, and the findings it answers:
 *
 *  - CANDIDATES come from pi.getAllTools(), keyed by each tool's sourceInfo.
 *    Only tools that are (a) NOT built-in/sdk and (b) carry a real, absolute,
 *    on-disk entry path survive (AD25) — otherwise a broad pattern such as
 *    ".*" would re-advertise pi's own built-ins (read/bash/…) as delegatable
 *    "extension" tools. The sourceInfo shape is treated defensively with a
 *    loose cast, the way state.ts tolerates malformed session entries.
 *
 *  - LOAD UNITS (RG1): a package-origin tool whose baseDir holds a parseable
 *    package.json with a `pi.extensions` array becomes a DIRECTORY unit at that
 *    baseDir — pi's own package-manifest resolution then expands the entry set
 *    (globs, override forms and all), so this module implements no manifest
 *    logic. Everything else becomes a FILE unit at the tool's own entry path.
 *    We NEVER walk parent directories looking for a manifest: in this very repo
 *    an auto-discovered project extension would walk up to the repo's own
 *    package.json and pull slate itself back into a worker.
 *
 *  - BARRIERS drop whole units before any pattern is consulted, so a broad
 *    pattern can never punch through them:
 *      · Self-exclusion: slate's package root and source-directory strings
 *        are computed ONCE from THIS module's own location. Their real paths are
 *        re-resolved for every unit, so filesystem changes cannot leave a stale
 *        boundary. A unit is withheld when its path or an entry identifies this
 *        copy. A readable matching package name also identifies any slate copy.
 *        The manifest name has exactly ONE read location: the UNIT PATH. The
 *        read occurs only when that path is a DIRECTORY. A file unit path yields
 *        nothing. The module never walks upward. It does not consult pi's
 *        reported BASE DIRECTORY as an independent name-read location. A
 *        directory unit promotes that reported base directory to the unit path,
 *        so both paths can be equal. Its manifest is then read through the unit
 *        path. For a single-file source, pi reports a CONTAINING directory that
 *        the candidate does not own. `package-manager.js:1050` covers the
 *        local-file package route. `resource-loader.js:635/640/648` also reports
 *        a directory above the entry file. For an entry file in a checkout root,
 *        that directory identifies the checkout rather than the candidate. A
 *        checkout manifest named `ytdb-slate` must not withhold that legitimate
 *        extension. Subtree containment is unsuitable for the same reason,
 *        because checkout-local packages can lie below the package root.
 *        RESIDUAL GAP: the name rule refuses a slate copy only when
 *        the candidate's own path is a directory carrying slate's manifest —
 *        that is, a package source whose manifest declares the very entries the
 *        host loaded (a DIRECTORY unit), or a candidate whose entry path IS
 *        a directory. EVERY other shape is missed by name, and the gap is wider
 *        than "a file entry with no reported base directory": a file entry that
 *        DOES report a base directory is missed too, which covers pi's
 *        `top-level` sources, its local-file package route, and slate's own
 *        published `extension/index.ts` layout. The name-collision barrier below
 *        covers every missed shape: any real slate copy registers `thread`,
 *        `threads` and `episode`, so it is refused there instead.
 *      · Name collision (AD44/RG2): a unit that registers a tool named like a
 *        slate tool or a pi built-in is withheld — pi's final tool registry
 *        lets an extension-registered tool OVERWRITE a same-named built-in, so
 *        a colliding unit could silently replace a worker's own `read`.
 *
 *  - MATCHING is unanchored `regex.test` against a unit's source spec, its
 *    path, or any of its tools' entry paths — any pattern hit selects the unit.
 *
 *  - FREEZE AT FIRST USE (AD41): createWorkerExtensionResolver memoizes the
 *    first resolution forever. The orchestrator doctrine is rebuilt every turn
 *    while a live worker keeps the tool set it was opened with, and a live
 *    session's tool allowlist cannot be widened afterwards — freezing makes the
 *    doctrine and every worker opened in that session provably the same set.
 *    First use happens AFTER the host's session_start, so extensions that
 *    register tools during session_start are still captured; a fresh resolver
 *    is created per session_start, so a restart re-resolves.
 *
 * Warnings (a withheld colliding unit) go through an injected `warn` callback,
 * never console.log — the same reporting discipline as failover.ts.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeForNotify } from "./notify.ts";

export interface WorkerExtensionTool {
	name: string;
	description: string;
}

export interface WorkerExtensionUnit {
	path: string; // absolute path of the load unit (a file, or a package directory when isDirectory)
	source: string; // recorded source spec of the unit's first tool (sourceInfo.source)
	isDirectory: boolean; // true = package-directory unit (RG1); false = single extension file
	tools: WorkerExtensionTool[];
}

export interface WorkerExtensionSet {
	units: WorkerExtensionUnit[]; // selected units, sorted by path
	paths: string[]; // selected unit paths, unit order
	toolNames: string[]; // de-duplicated tool names of the selected units, unit order
}

/**
 * The empty result — the off-by-default state. Shared so every consumer's
 * feature-off path (index.ts's initial resolver, ThreadManager's default,
 * the fast paths below) allocates nothing meaningful. DEEP-FROZEN (CQ22) so a
 * stray `.push`/reassignment from any one consumer cannot corrupt the object
 * every other feature-off consumer reads.
 */
export const EMPTY_WORKER_EXTENSION_SET: WorkerExtensionSet = Object.freeze({
	units: Object.freeze([]),
	paths: Object.freeze([]),
	toolNames: Object.freeze([]),
}) as unknown as WorkerExtensionSet;

/** Slate's own model-facing tools — a unit registering any of these is withheld (AD44/RG2). */
export const SLATE_TOOL_NAMES = ["thread", "threads", "episode"];

/** pi's built-in tools — a unit registering any of these would overwrite a worker's own (AD44/RG2). */
export const PI_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Union of the two lists above, as a set, for the collision barrier. */
const COLLISION_NAMES = new Set([...SLATE_TOOL_NAMES, ...PI_BUILTIN_TOOL_NAMES]);

/** Slate's package identity. A unit test pins this constant to package.json. */
export const SLATE_PACKAGE_NAME = "ytdb-slate";

/**
 * Slate's own source directory and package root, computed ONCE from this module's
 * location. Never derive either boundary from the registered `thread`
 * tool. First-wins registration can identify another loaded slate copy.
 */
export const SLATE_SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const SLATE_PACKAGE_ROOT = dirname(SLATE_SOURCE_DIRECTORY);

/** Remove trailing separators without turning a filesystem root into an empty path. */
function stripTrailingSeparators(path: string): string {
	const root = parse(path).root;
	while (path.length > root.length && path.endsWith(sep)) path = path.slice(0, -sep.length);
	return path;
}

/** Resolve symlinks when possible. Missing or fabricated paths retain plain resolution. */
function comparisonPath(path: string): string {
	const resolved = resolve(stripTrailingSeparators(path));
	try {
		return stripTrailingSeparators(realpathSync(resolved));
	} catch {
		return stripTrailingSeparators(resolved);
	}
}

/**
 * Separator-aware, case-sensitive containment. This matches pi's containment
 * semantics and keeps "/a/bc" from counting as inside "/a/b".
 */
function pathContains(parent: string, child: string): boolean {
	if (parent === child) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(prefix);
}

/**
 * Self-load barrier. The rule rejects this package root, entries in this source
 * directory, ancestors that could load slate, and packages carrying slate's
 * name. It accepts unrelated checkout-local packages under .pi/npm/node_modules.
 */
export function isSlateSelfPath(candidate: string, packageRoot: string, sourceDirectory: string): boolean {
	return candidate === packageRoot || pathContains(sourceDirectory, candidate) || pathContains(candidate, packageRoot);
}

export function isSlateSelfLoad(
	unitPath: string,
	toolPaths: readonly string[],
	packageNames: readonly string[] = [],
): boolean {
	if (packageNames.includes(SLATE_PACKAGE_NAME)) return true;
	const packageRoot = comparisonPath(SLATE_PACKAGE_ROOT);
	const sourceDirectory = comparisonPath(SLATE_SOURCE_DIRECTORY);
	return [unitPath, ...toolPaths].some((path) => isSlateSelfPath(comparisonPath(path), packageRoot, sourceDirectory));
}

/** Loose views of the getAllTools() shape — tolerated defensively (state.ts pattern). */
interface LooseSourceInfo {
	path?: unknown;
	source?: unknown;
	origin?: unknown;
	baseDir?: unknown;
}
interface LooseTool {
	name?: unknown;
	description?: unknown;
	sourceInfo?: LooseSourceInfo;
}

/** A surviving candidate tool with its resolved on-disk entry path and unit membership. */
interface Candidate {
	name: string;
	description: string;
	source: string;
	path: string; // the tool's own sourceInfo.path (absolute, exists on disk)
	baseDir?: string; // package directory when this tool qualifies for a directory unit (RG1)
}

/** Working unit accumulated during grouping. Tool paths also feed the self-load barrier. */
interface WorkingUnit {
	path: string;
	source: string;
	isDirectory: boolean;
	tools: WorkerExtensionTool[];
	toolPaths: string[];
}

/** The relevant fields from a package.json, or undefined when unreadable or invalid. */
interface PackageManifest {
	name?: unknown;
	pi?: { extensions?: unknown };
}
type ManifestValue = PackageManifest | undefined;
type ManifestEntries = string[] | undefined;

/**
 * Read and parse <baseDir>/package.json, returning the whole manifest object.
 * Cache each directory for the whole resolution, so each manifest is read and
 * parsed at most once. Return undefined when the file is missing, unreadable,
 * invalid JSON, or not an object.
 */
function readPackageManifest(baseDir: string, cache: Map<string, ManifestValue>): ManifestValue {
	if (cache.has(baseDir)) return cache.get(baseDir);
	let parsed: ManifestValue;
	const manifest = join(baseDir, "package.json");
	if (existsSync(manifest)) {
		try {
			const value = JSON.parse(readFileSync(manifest, "utf8")) as PackageManifest | null;
			if (value && typeof value === "object") parsed = value;
		} catch {
			/* unreadable/invalid manifest → undefined */
		}
	}
	cache.set(baseDir, parsed);
	return parsed;
}

/** Return the manifest's `pi.extensions` array when it has that exact shape. */
function readPackageExtensions(baseDir: string, cache: Map<string, ManifestValue>): ManifestEntries {
	const ext = readPackageManifest(baseDir, cache)?.pi?.extensions;
	return Array.isArray(ext) ? ext as string[] : undefined;
}

/**
 * Read a manifest `name` at exactly ONE location: the unit path, and only when
 * that path is a directory. Never walk upward. Do not consult pi's reported base
 * directory as an independent read location. A directory unit promotes that
 * reported base directory to the unit path, so the paths can be equal. Its
 * manifest is then read through the unit path. A file unit path yields no
 * manifest name.
 */
function readPackageNameAt(directory: string, cache: Map<string, ManifestValue>): string | undefined {
	const name = readPackageManifest(directory, cache)?.name;
	return typeof name === "string" ? name : undefined;
}

/**
 * RG1: is `info` a package-origin tool whose baseDir carries a valid extension
 * manifest? Returns that baseDir (a directory-unit CANDIDATE) or undefined (a
 * file unit). Whether the directory form is actually USED is decided later by
 * the BG20 equivalence check, once all candidates are known. Anything short of
 * a package origin with a `pi.extensions` manifest — wrong origin, no baseDir,
 * missing/unreadable/invalid manifest — is a file unit. Parents are never
 * consulted.
 */
function packageBaseDir(info: LooseSourceInfo, cache: Map<string, ManifestValue>): string | undefined {
	if (info.origin !== "package") return undefined;
	const baseDir = info.baseDir;
	if (typeof baseDir !== "string" || baseDir === "") return undefined;
	return readPackageExtensions(baseDir, cache) !== undefined ? baseDir : undefined;
}

/**
 * BG20: a manifest entry is safe to hand to pi via the DIRECTORY form only if it
 * is a plain literal relative path — no glob metacharacters and none of the
 * !/+/- override prefixes pi's manifest matcher understands. A glob can expand
 * differently in the worker than it did in the host, and an override prefix
 * changes which declared entries load; either way the directory form risks
 * loading a SUPERSET of what the host runs, so such a unit falls back to
 * explicit file units.
 */
function isLiteralManifestEntry(entry: string): boolean {
	if (entry === "" || /^[!+\-]/.test(entry)) return false;
	return !/[*?[\]{}()!]/.test(entry);
}

/**
 * Validate the raw `workerExtensions` config value into a list of regex source
 * strings. undefined → [] (feature off, silently). A non-array warns and
 * yields []. Per element: non-strings, empty strings, and patterns that fail
 * `new RegExp` are dropped with a warning; the rest are kept in order.
 */
export function sanitizeWorkerExtensions(value: unknown, warn: (msg: string) => void): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		warn("slate: workerExtensions must be an array of regex strings — ignoring");
		return [];
	}
	const patterns: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry === "") {
			warn(`slate: ignoring workerExtensions entry ${sanitizeForNotify(JSON.stringify(entry))} — expected a non-empty regex string`);
			continue;
		}
		try {
			new RegExp(entry);
		} catch {
			warn(`slate: ignoring workerExtensions pattern ${sanitizeForNotify(JSON.stringify(entry))} — not a valid regular expression`);
			continue;
		}
		patterns.push(entry);
	}
	return patterns;
}

/**
 * Resolve the set of worker-loadable extension units for `patterns`.
 *
 * An empty pattern list returns an empty set WITHOUT walking the registry —
 * the fast path, since the feature is off by default. `warn` receives the
 * collision-barrier notices (AD44/RG2); it defaults to a no-op so a bare
 * `resolveWorkerExtensions(pi, patterns)` still type-checks and runs.
 */
export function resolveWorkerExtensions(
	pi: ExtensionAPI,
	patterns: string[],
	warn: (msg: string) => void = () => {},
): WorkerExtensionSet {
	if (patterns.length === 0) return EMPTY_WORKER_EXTENSION_SET;

	// One manifest read per package directory for this whole resolution (CQ21).
	const manifestCache = new Map<string, ManifestValue>();

	// 1. CANDIDATES (AD25): extension-owned tools with a real on-disk entry path.
	const candidates: Candidate[] = [];
	for (const raw of pi.getAllTools()) {
		const tool = raw as unknown as LooseTool;
		const info = tool.sourceInfo;
		if (!info) continue;
		const source = typeof info.source === "string" ? info.source : "";
		if (source === "builtin" || source === "sdk") continue;
		const path = typeof info.path === "string" ? info.path : "";
		if (path === "" || !isAbsolute(path) || !existsSync(path)) continue;
		const name = typeof tool.name === "string" ? tool.name : "";
		if (name === "") continue;
		const description = typeof tool.description === "string" ? tool.description : "";
		candidates.push({
			name,
			description,
			source,
			path,
			baseDir: packageBaseDir(info, manifestCache),
		});
	}
	if (candidates.length === 0) return EMPTY_WORKER_EXTENSION_SET;

	// 2. DIRECTORY UNITS (RG1 + BG20): a package baseDir becomes a directory unit
	// — handed to pi WHOLE so pi's own manifest resolution expands the entries —
	// ONLY when that is provably equivalent to what the host loaded: every manifest
	// entry is a literal relative path AND every one of them is an entry the host
	// actually loaded (a tool we saw). Otherwise the host may be running a filtered
	// subset (a settings package entry can carry its own extensions filter) or a
	// glob could expand differently in the worker, so the unit falls back to file
	// units below. TRADE-OFF: the fallback drops a package's no-tool companion
	// entries — correct, because an entry that registered no tool is one we cannot
	// prove the host is running.
	const dirUnits: string[] = [];
	const seenDirs = new Set<string>();
	for (const c of candidates) {
		if (!c.baseDir || seenDirs.has(c.baseDir)) continue;
		seenDirs.add(c.baseDir);
		const baseDir = c.baseDir;
		const entries = readPackageExtensions(baseDir, manifestCache);
		if (!entries || entries.length === 0) continue;
		const loadedEntryPaths = new Set(candidates.filter((o) => pathContains(baseDir, o.path)).map((o) => resolve(o.path)));
		const equivalent = entries.every(
			(e) => typeof e === "string" && isLiteralManifestEntry(e) && loadedEntryPaths.has(resolve(baseDir, e)),
		);
		if (equivalent) dirUnits.push(baseDir);
	}

	// 3. GROUP candidates into units. A candidate whose entry path lies inside a
	// validated directory unit joins it (most specific wins); everything else
	// (including candidates whose package failed the BG20 check) becomes a file
	// unit keyed by its own path.
	const working = new Map<string, WorkingUnit>();
	for (const c of candidates) {
		let unitPath: string | undefined;
		for (const d of dirUnits) {
			if (pathContains(d, c.path) && (unitPath === undefined || d.length > unitPath.length)) unitPath = d;
		}
		const isDirectory = unitPath !== undefined;
		const key = unitPath ?? c.path;
		let unit = working.get(key);
		if (!unit) {
			// unit.source is the source spec of the unit's FIRST tool.
			unit = { path: key, source: c.source, isDirectory, tools: [], toolPaths: [] };
			working.set(key, unit);
		}
		unit.tools.push({ name: c.name, description: c.description });
		unit.toolPaths.push(c.path);
	}

	// Deterministic order (needed for stable doctrine/allowlist output).
	const units = [...working.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	// 4. BARRIERS — applied to EVERY unit before matching, regardless of patterns.
	const surviving: WorkingUnit[] = [];
	for (const unit of units) {
		// (a) Self-exclusion uses precise path and package-identity rules.
		// Read a manifest name only at a directory unit path. Never search parents
		// or consult pi's reported base directory as a separate read location.
		// A directory unit promotes that reported base directory to the unit path,
		// so both paths can be equal and its manifest is read through the unit path.
		// A file unit path yields nothing. A subtree rule is also invalid because
		// slate can load from a checkout. Shapes this rule misses fall to barrier (b).
		const unitName = readPackageNameAt(unit.path, manifestCache);
		if (isSlateSelfLoad(unit.path, unit.toolPaths, unitName === undefined ? [] : [unitName])) continue;
		// (b) Name collision (AD44/RG2): checked across the WHOLE unit, not just a
		// matched tool — any collision withholds the unit and warns.
		const collisions = unit.tools.map((t) => t.name).filter((n) => COLLISION_NAMES.has(n));
		if (collisions.length > 0) {
			warn(
				`slate: worker extension ${sanitizeForNotify(unit.path)} withheld from workers — it registers ` +
					`${collisions.map((n) => `"${n}"`).join(", ")}, which would overwrite a slate or pi built-in tool`,
			);
			continue;
		}
		surviving.push(unit);
	}

	// 5. MATCH: compile each pattern once; a unit is selected on ANY hit against
	// its source spec, its path, or any of its tools' entry paths. Patterns are
	// pre-validated by sanitizeWorkerExtensions; a stray invalid one is dropped.
	const regexes: RegExp[] = [];
	for (const p of patterns) {
		try {
			regexes.push(new RegExp(p));
		} catch {
			/* pre-validated upstream; tolerate a raw invalid pattern */
		}
	}
	const selected = surviving.filter((unit) =>
		regexes.some((re) => re.test(unit.source) || re.test(unit.path) || unit.toolPaths.some((tp) => re.test(tp))),
	);

	// 6. RESULT: de-duplicate tool names across selected units, in unit order.
	const seen = new Set<string>();
	const toolNames: string[] = [];
	for (const unit of selected) {
		for (const t of unit.tools) {
			if (seen.has(t.name)) continue;
			seen.add(t.name);
			toolNames.push(t.name);
		}
	}
	return {
		units: selected.map((u) => ({ path: u.path, source: u.source, isDirectory: u.isDirectory, tools: u.tools })),
		paths: selected.map((u) => u.path),
		toolNames,
	};
}

/**
 * Wrap resolveWorkerExtensions so it runs at most ONCE per session (AD41): the
 * first call resolves and caches; every later call returns that same frozen
 * set. `getPatterns` is read lazily at first use — after session_start, so
 * tools registered during session_start are captured. A new resolver is
 * created per session_start, so a restart re-resolves from scratch.
 */
export function createWorkerExtensionResolver(
	pi: ExtensionAPI,
	getPatterns: () => string[],
	warn: (msg: string) => void = () => {},
): () => WorkerExtensionSet {
	let cached: WorkerExtensionSet | undefined;
	return () => {
		if (cached === undefined) cached = resolveWorkerExtensions(pi, getPatterns(), warn);
		return cached;
	};
}
