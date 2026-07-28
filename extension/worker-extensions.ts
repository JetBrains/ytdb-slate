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
 *      · Self-exclusion (AD24): slate's own package root is computed ONCE from
 *        THIS module's own location, never by asking who registered the
 *        `thread` tool — registration is first-wins, so with two slate copies
 *        loaded that lookup can resolve to a copy other than the one running.
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
 * the fast paths below) allocates nothing meaningful. Read-only by contract.
 */
export const EMPTY_WORKER_EXTENSION_SET: WorkerExtensionSet = { units: [], paths: [], toolNames: [] };

/** Slate's own model-facing tools — a unit registering any of these is withheld (AD44/RG2). */
export const SLATE_TOOL_NAMES = ["thread", "threads", "episode"];

/** pi's built-in tools — a unit registering any of these would overwrite a worker's own (AD44/RG2). */
export const PI_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Union of the two lists above, as a set, for the collision barrier. */
const COLLISION_NAMES = new Set([...SLATE_TOOL_NAMES, ...PI_BUILTIN_TOOL_NAMES]);

/**
 * Slate's own package root, computed ONCE from this module's location (AD24):
 * fileURLToPath(import.meta.url) → .../extension/worker-extensions.ts, its
 * directory → .../extension, its parent → the package root. Never derived by
 * looking up who registered the `thread` tool (first-wins registration can
 * resolve to a different slate copy than the one executing).
 */
const SLATE_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Warnings can carry user-authored regex strings and reach ctx.ui.notify, and
// pi-tui renders control/ANSI codes verbatim — strip control characters and cap
// length before display (same pattern as failover.ts's sanitizeForNotify).
function sanitizeForNotify(s: string, max = 120): string {
	const clean = s.replace(/[\u0000-\u001f\u007f\u009b]/g, "");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Separator-aware containment: true iff `child` is `parent` or lies under it.
 * The trailing separator is what keeps "/a/bc" from counting as inside "/a/b".
 */
function pathContains(parent: string, child: string): boolean {
	if (parent === child) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(prefix);
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

/** Working unit accumulated during grouping; toolPaths is kept for matching only. */
interface WorkingUnit {
	path: string;
	source: string;
	isDirectory: boolean;
	tools: WorkerExtensionTool[];
	toolPaths: string[];
}

/**
 * RG1: the DIRECTORY load unit for a candidate, or undefined for a file unit.
 * Requires a package-origin sourceInfo whose baseDir holds a package.json that
 * parses and declares a `pi.extensions` ARRAY. Anything short of that — wrong
 * origin, no baseDir, missing/unreadable/invalid manifest, no extensions array
 * — falls back to the file unit. Parent directories are never consulted.
 */
function packageBaseDir(info: LooseSourceInfo): string | undefined {
	if (info.origin !== "package") return undefined;
	const baseDir = info.baseDir;
	if (typeof baseDir !== "string" || baseDir === "") return undefined;
	const manifest = join(baseDir, "package.json");
	if (!existsSync(manifest)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { pi?: { extensions?: unknown } } | null;
		if (Array.isArray(parsed?.pi?.extensions)) return baseDir;
	} catch {
		/* unreadable/invalid manifest → fall back to the file unit */
	}
	return undefined;
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
		candidates.push({ name, description, source, path, baseDir: packageBaseDir(info) });
	}
	if (candidates.length === 0) return EMPTY_WORKER_EXTENSION_SET;

	// 2/3. GROUP candidates into units. Directory units (RG1) come first; a
	// candidate whose entry path lies inside a directory unit joins it (most
	// specific wins), everything else becomes a file unit keyed by its own path.
	const dirUnits: string[] = [];
	for (const c of candidates) {
		if (c.baseDir && !dirUnits.includes(c.baseDir)) dirUnits.push(c.baseDir);
	}
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
		// (a) Self-exclusion (AD24): drop when the unit equals slate's root, sits
		// inside it, or contains it.
		if (pathContains(SLATE_PACKAGE_ROOT, unit.path) || pathContains(unit.path, SLATE_PACKAGE_ROOT)) continue;
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
