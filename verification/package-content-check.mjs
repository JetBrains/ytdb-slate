#!/usr/bin/env node
/** Verify that npm's publish file set contains every package-resolved runtime file. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
let repo = ".";
for (let i = 0; i < args.length; i += 1) {
	if (args[i] === "--repo" && args[i + 1]) {
		repo = args[++i];
	} else if (args[i] === "-h" || args[i] === "--help") {
		console.log("Usage: node verification/package-content-check.mjs [--repo <dir>]");
		process.exit(0);
	} else {
		console.error(`package-content-check: unknown or incomplete argument: ${args[i]}`);
		process.exit(2);
	}
}
repo = resolve(repo);

let pathsSource;
let modeSource;
try {
	pathsSource = readFileSync(resolve(repo, "extension/paths.ts"), "utf8");
	modeSource = readFileSync(resolve(repo, "extension/mode.ts"), "utf8");
} catch (error) {
	console.error(`package-content-check: cannot read runtime path sources: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

const checkerMatch = pathsSource.match(/export const WRITING_CHECKER\s*=\s*join\(EXTENSION_DIR,\s*"([^"]+)"\)/);
if (!checkerMatch) {
	console.error("package-content-check: cannot derive WRITING_CHECKER from extension/paths.ts");
	process.exit(2);
}

const docDefinitions = new Map();
for (const match of pathsSource.matchAll(/export const ([A-Z0-9_]+_DOC)\s*=\s*join\(DOCS_DIR,\s*"([^"]+)"\)/g)) {
	docDefinitions.set(match[1], match[2]);
}
const citedNames = new Set(modeSource.match(/\b[A-Z0-9_]+_DOC\b/g) ?? []);
if (citedNames.size === 0) {
	console.error("package-content-check: no doctrine document references found in extension/mode.ts");
	process.exit(2);
}
const unresolved = [...citedNames].filter((name) => !docDefinitions.has(name));
if (unresolved.length > 0) {
	console.error(`package-content-check: doctrine path declaration missing: ${unresolved.join(", ")}`);
	process.exit(2);
}

const expected = [
	[`WRITING_CHECKER (${checkerMatch[1]})`, `extension/${checkerMatch[1]}`],
	...[...citedNames].sort().map((name) => [`${name} (${docDefinitions.get(name)})`, `docs/${docDefinitions.get(name)}`]),
];
const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: repo,
	encoding: "utf8",
	timeout: 30_000,
});
if (packed.error || packed.status !== 0) {
	console.error(`package-content-check: npm pack failed${packed.error ? `: ${packed.error.message}` : ""}`);
	if (packed.stderr) console.error(packed.stderr.trim());
	process.exit(2);
}

let manifest;
try {
	const parsed = JSON.parse(packed.stdout);
	manifest = parsed[0];
	if (!manifest || !Array.isArray(manifest.files)) throw new Error("missing files array");
} catch (error) {
	console.error(`package-content-check: cannot parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}
const files = new Set(manifest.files.map((entry) => entry.path));
let failed = false;
for (const [name, file] of expected) {
	const present = files.has(file);
	console.log(`PACKAGE ${name} ${present ? "PASS" : "FAIL"} — ${file}`);
	if (!present) failed = true;
}
console.log(`PACKAGE roster ${failed ? "FAIL" : "PASS"} — every package-resolved runtime file is present in npm's publish file set`);
process.exitCode = failed ? 1 : 0;
