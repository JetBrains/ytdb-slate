import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, sep } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isSlateSelfLoad,
	isSlateSelfPath,
	resolveWorkerExtensions,
	SLATE_PACKAGE_NAME,
	SLATE_PACKAGE_ROOT,
	SLATE_SOURCE_DIRECTORY,
	SLATE_TOOL_NAMES,
} from "../extension/worker-extensions.ts";

function fakePi(path: string, baseDir?: string, names: readonly string[] = ["fixture_tool"]): ExtensionAPI {
	return {
		getAllTools: () => names.map((name) => ({
			name,
			description: "fixture",
			sourceInfo: { source: "npm:fixture", origin: "package", path, baseDir },
		})),
	} as unknown as ExtensionAPI;
}

function fakeOrigin(source: string, origin: string, path: string, baseDir: string | undefined): ExtensionAPI {
	return {
		getAllTools: () => [{ name: "fixture_tool", description: "fixture", sourceInfo: { source, origin, path, baseDir } }],
	} as unknown as ExtensionAPI;
}

test("the self-load barrier rejects slate path identities", () => {
	assert.equal(isSlateSelfLoad(SLATE_PACKAGE_ROOT, []), true, "the package root must be rejected");
	assert.equal(
		isSlateSelfLoad(join(SLATE_PACKAGE_ROOT, ".pi", "npm", "node_modules", "safe-package"), [join(SLATE_SOURCE_DIRECTORY, "second-entry.ts")]),
		true,
		"any tool entry inside slate's source directory must reject its unit",
	);
	assert.equal(isSlateSelfLoad(dirname(SLATE_PACKAGE_ROOT), []), true, "an ancestor of the package root must be rejected");
	assert.equal(isSlateSelfLoad(join(tmpdir(), "unrelated-slate-copy"), [], [SLATE_PACKAGE_NAME]), true, "slate's package name must be rejected");
});

test("a package under the checkout-local project package store remains accepted", () => {
	const installed = join(SLATE_PACKAGE_ROOT, ".pi", "npm", "node_modules", "safe-package");
	assert.equal(isSlateSelfLoad(installed, [join(installed, "extension", "index.ts")], ["safe-package"]), false);
});

test("split layout accepts project extensions and refuses slate identities", () => {
	const lab = mkdtempSync(join(tmpdir(), "slate-worker-extension-split."));
	try {
		const project = join(lab, "project");
		const safeRoot = join(project, ".pi", "npm", "node_modules", "safe-package");
		const staleRoot = join(project, ".pi", "npm", "node_modules", SLATE_PACKAGE_NAME);
		const safeEntry = join(safeRoot, "index.ts");
		const staleEntry = join(staleRoot, "index.ts");
		for (const [root, entry, name] of [
			[safeRoot, safeEntry, "safe-package"],
			[staleRoot, staleEntry, SLATE_PACKAGE_NAME],
		] as const) {
			mkdirSync(root, { recursive: true });
			writeFileSync(entry, "// fixture\n");
			writeFileSync(join(root, "package.json"), JSON.stringify({ name, pi: { extensions: ["index.ts"] } }));
		}
		assert.equal(project.startsWith(SLATE_PACKAGE_ROOT + sep), false, "the project must differ from the slate source tree");
		assert.deepEqual(resolveWorkerExtensions(fakePi(safeEntry, safeRoot), [".*"]).toolNames, ["fixture_tool"]);
		assert.deepEqual(resolveWorkerExtensions(fakePi(staleEntry, staleRoot), [".*"]).units, [], "the slate package name must be refused");
		assert.deepEqual(resolveWorkerExtensions(fakePi(join(SLATE_SOURCE_DIRECTORY, "worker-extensions.ts")), [".*"]).units, [], "the slate source must be refused");
	} finally {
		rmSync(lab, { recursive: true, force: true });
	}
});

test("realpath rejects a symlink into slate's source directory", () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-extension-link."));
	try {
		const link = join(root, "entry.ts");
		symlinkSync(join(SLATE_SOURCE_DIRECTORY, "worker-extensions.ts"), link);
		assert.equal(isSlateSelfLoad(link, []), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing paths use resolved-path fallback", () => {
	const missingSourceEntry = join(SLATE_SOURCE_DIRECTORY, `missing-self-load-fixture-${process.pid}`);
	assert.equal(existsSync(missingSourceEntry), false, "the fixture must force realpathSync to throw");
	assert.equal(isSlateSelfLoad(missingSourceEntry, []), true, "plain resolution must retain source-directory containment");
});

test("trailing separators do not change classification", () => {
	assert.equal(isSlateSelfLoad(SLATE_PACKAGE_ROOT, []), true);
	assert.equal(isSlateSelfLoad(SLATE_PACKAGE_ROOT + sep, []), true);
	assert.equal(isSlateSelfLoad(parse(SLATE_PACKAGE_ROOT).root, []), true, "the filesystem root is a slate-root ancestor");
	const nested = join(SLATE_PACKAGE_ROOT, ".pi", "npm", "node_modules", "safe-package");
	assert.equal(isSlateSelfLoad(nested, []), false);
	assert.equal(isSlateSelfLoad(nested + sep, []), false);
});

test("non-slate manifest shapes remain worker-loadable", () => {
	const lab = mkdtempSync(join(tmpdir(), "slate-worker-extension-manifests."));
	try {
		const manifests: Array<[string, string | undefined]> = [
			["missing", undefined],
			["invalid", "{"],
			["null", "null"],
			["unnamed", JSON.stringify({ pi: { extensions: ["index.ts"] } })],
			["non-string-name", JSON.stringify({ name: 7, pi: { extensions: ["index.ts"] } })],
			["safe-name", JSON.stringify({ name: "safe-package", pi: { extensions: ["index.ts"] } })],
		];
		for (const [label, manifest] of manifests) {
			const root = join(lab, label);
			const entry = join(root, "index.ts");
			mkdirSync(root, { recursive: true });
			writeFileSync(entry, "// fixture\n");
			if (manifest !== undefined) writeFileSync(join(root, "package.json"), manifest);
			const resolved = resolveWorkerExtensions(fakePi(entry, root), [".*"]);
			assert.equal(resolved.toolNames[0], "fixture_tool", `${label} must not look like slate`);
		}
	} finally {
		rmSync(lab, { recursive: true, force: true });
	}
});

test("a package candidate without baseDir remains loadable", () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-extension-no-base."));
	try {
		const entry = join(root, "index.ts");
		writeFileSync(entry, "// fixture\n");
		const resolved = resolveWorkerExtensions(fakePi(entry), [".*"]);
		assert.deepEqual(resolved.toolNames, ["fixture_tool"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reserved tools protect a slate copy whose package name is unreadable", () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-extension-local-copy."));
	try {
		const entry = join(root, "index.ts");
		writeFileSync(entry, "// fixture\n");
		assert.equal(existsSync(join(root, "package.json")), false, "the candidate-owned directories must expose no manifest");
		const warnings: string[] = [];
		const resolved = resolveWorkerExtensions(fakePi(entry, root, SLATE_TOOL_NAMES), [".*"], (message) => warnings.push(message));
		assert.deepEqual(resolved.units, [], "reserved slate tool names must withhold the local-file copy");
		assert.equal(warnings.length, 1);
		for (const name of SLATE_TOOL_NAMES) assert.match(warnings[0] ?? "", new RegExp(`"${name}"`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("case-sensitive path classification is independent from the filesystem", () => {
	const lowerRoot = join(parse(SLATE_PACKAGE_ROOT).root, "case-fixture", "slate-checkout");
	const source = join(lowerRoot, "extension");
	const upperRoot = join(parse(SLATE_PACKAGE_ROOT).root, "case-fixture", "SLATE-CHECKOUT");
	assert.equal(isSlateSelfPath(upperRoot, lowerRoot, source), false);
});

test("the candidate-path name read refuses every directory-owned slate shape", () => {
	// This is the load-bearing proof for the one remaining name read. The rule
	// refuses a slate copy exactly when the candidate's own path
	// is a directory carrying slate's manifest. Deleting the candidate-path read
	// in resolveWorkerExtensions makes this test fail.
	const lab = mkdtempSync(join(tmpdir(), "slate-worker-extension-owned."));
	try {
		// A package source whose manifest declares the entry the host loaded. The
		// unit is the package directory, so the candidate path owns the read.
		const pkgRoot = join(lab, "package-source");
		const pkgEntry = join(pkgRoot, "extension", "index.ts");
		mkdirSync(dirname(pkgEntry), { recursive: true });
		writeFileSync(pkgEntry, "// fixture\n");
		writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({
			name: SLATE_PACKAGE_NAME,
			pi: { extensions: ["extension/index.ts"] },
		}));
		assert.deepEqual(
			resolveWorkerExtensions(fakePi(pkgEntry, pkgRoot), [".*"]).units,
			[],
			"a package source must be refused at its own package root",
		);
		// A candidate whose entry path IS a directory, for both pi origins.
		for (const [label, origin] of [
			["package", "package"],
			["top-level", "top-level"],
		] as const) {
			const dirRoot = join(lab, `directory-${label}`);
			mkdirSync(dirRoot, { recursive: true });
			writeFileSync(join(dirRoot, "package.json"), JSON.stringify({ name: SLATE_PACKAGE_NAME }));
			assert.deepEqual(
				resolveWorkerExtensions(fakeOrigin("local", origin, dirRoot, dirRoot), [".*"]).units,
				[],
				`${label}: a directory entry must be refused by its own manifest`,
			);
		}
	} finally {
		rmSync(lab, { recursive: true, force: true });
	}
});

test("a checkout root manifest never supplies a candidate's identity", () => {
	// Every candidate sits inside a fake checkout whose root manifest must not
	// supply its identity. The root manifest is named ytdb-slate, but no candidate
	// owns that manifest, so every one of the four shapes must be accepted.
	const lab = mkdtempSync(join(tmpdir(), "slate-worker-extension-checkout."));
	try {
		const checkout = join(lab, "fake-checkout");
		const store = join(checkout, ".pi", "npm", "node_modules");
		mkdirSync(store, { recursive: true });
		writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: SLATE_PACKAGE_NAME }));

		// C1: a store candidate with no manifest of its own.
		const plainRoot = join(store, "plain-package");
		const plainEntry = join(plainRoot, "index.ts");
		mkdirSync(plainRoot, { recursive: true });
		writeFileSync(plainEntry, "// fixture\n");
		assert.deepEqual(
			resolveWorkerExtensions(fakePi(plainEntry, plainRoot), [".*"]).toolNames,
			["fixture_tool"],
			"C1: a manifest-less store candidate must be accepted",
		);

		// C2: a store candidate whose own manifest carries an unrelated name.
		const namedRoot = join(store, "named-package");
		const namedEntry = join(namedRoot, "index.ts");
		mkdirSync(namedRoot, { recursive: true });
		writeFileSync(namedEntry, "// fixture\n");
		writeFileSync(join(namedRoot, "package.json"), JSON.stringify({ name: "named-package", pi: { extensions: ["index.ts"] } }));
		assert.deepEqual(
			resolveWorkerExtensions(fakePi(namedEntry, namedRoot), [".*"]).toolNames,
			["fixture_tool"],
			"C2: an unrelated store manifest must be accepted",
		);

		// C3: a top-level entry FILE sitting directly in the checkout root.
		const rootEntry = join(checkout, "project-extension.ts");
		writeFileSync(rootEntry, "// fixture\n");
		assert.deepEqual(
			resolveWorkerExtensions(fakeOrigin("local", "top-level", rootEntry, undefined), [".*"]).toolNames,
			["fixture_tool"],
			"C3: a checkout-root entry file must be accepted",
		);

		// C3b: the same root entry file WITH a reported base directory equal to the
		// checkout root. Candidate identity still comes only from the file unit path.
		assert.deepEqual(
			resolveWorkerExtensions(fakeOrigin("local", "top-level", rootEntry, checkout), [".*"]).toolNames,
			["fixture_tool"],
			"C3b: a checkout-root entry file with a checkout-root base directory must be accepted",
		);

		// C3c: the same shape through pi's local-file package route, which reports
		// the containing directory as the base directory (package-manager.js:1050).
		assert.deepEqual(
			resolveWorkerExtensions(fakeOrigin("local:./project-extension.ts", "package", rootEntry, checkout), [".*"]).toolNames,
			["fixture_tool"],
			"C3c: the local-file package route must be accepted",
		);

		// C4: a candidate whose entry path IS a directory with an unrelated name.
		const dirEntry = join(checkout, "directory-extension");
		mkdirSync(dirEntry, { recursive: true });
		writeFileSync(join(dirEntry, "package.json"), JSON.stringify({ name: "directory-extension" }));
		assert.deepEqual(
			resolveWorkerExtensions(fakeOrigin("local", "package", dirEntry, dirEntry), [".*"]).toolNames,
			["fixture_tool"],
			"C4: a directory entry with an unrelated manifest must be accepted",
		);

		// C5: a candidate two directory levels below the checkout root.
		const deepRoot = join(checkout, "one", "two");
		const deepEntry = join(deepRoot, "index.ts");
		mkdirSync(deepRoot, { recursive: true });
		writeFileSync(deepEntry, "// fixture\n");
		assert.deepEqual(
			resolveWorkerExtensions(fakeOrigin("local", "top-level", deepEntry, deepRoot), [".*"]).toolNames,
			["fixture_tool"],
			"C5: a candidate two levels below the checkout root must be accepted",
		);

		// C6: a candidate reached through a symbolic link into an outside tree.
		const outsideEntry = join(lab, "outside-entry.ts");
		writeFileSync(outsideEntry, "// fixture\n");
		const linkEntry = join(checkout, "linked-entry.ts");
		symlinkSync(outsideEntry, linkEntry);
		assert.deepEqual(
			resolveWorkerExtensions(fakeOrigin("local", "top-level", linkEntry, checkout), [".*"]).toolNames,
			["fixture_tool"],
			"C6: a symbolically linked candidate must be accepted",
		);

		// C7: an unreadable manifest and a malformed manifest at the candidate.
		for (const [label, write] of [
			["unreadable", (target: string) => {
				writeFileSync(target, JSON.stringify({ name: "unreadable-package", pi: { extensions: ["index.ts"] } }));
				chmodSync(target, 0o000);
			}],
			["malformed", (target: string) => writeFileSync(target, "{ not json")],
		] as const) {
			const defectiveRoot = join(store, `${label}-package`);
			const defectiveEntry = join(defectiveRoot, "index.ts");
			mkdirSync(defectiveRoot, { recursive: true });
			writeFileSync(defectiveEntry, "// fixture\n");
			write(join(defectiveRoot, "package.json"));
			assert.deepEqual(
				resolveWorkerExtensions(fakePi(defectiveEntry, defectiveRoot), [".*"]).toolNames,
				["fixture_tool"],
				`C7: a ${label} candidate manifest must be accepted`,
			);
		}
	} finally {
		rmSync(lab, { recursive: true, force: true });
	}
});

test("the collision barrier covers every shape the candidate-path name read misses", () => {
	// The residual gap is wider than "a file entry with no reported base
	// directory". A file entry that DOES report a base directory is missed too,
	// and slate's own published `extension/index.ts` layout is one such shape.
	// Each missed shape must return zero units and exactly one warning.
	const lab = mkdtempSync(join(tmpdir(), "slate-worker-extension-residual."));
	try {
		const root = join(lab, "slate-copy");
		const entry = join(root, "extension", "index.ts");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "// fixture\n");
		writeFileSync(join(root, "package.json"), JSON.stringify({
			name: SLATE_PACKAGE_NAME,
			pi: { extensions: ["extension/index.ts"] },
		}));
		const shapes: Array<[string, string, string | undefined]> = [
			["file entry with no reported base directory", "top-level", undefined],
			["file entry whose base directory is the package root", "top-level", root],
			["local-file package route reporting the entry parent", "package", dirname(entry)],
		];
		for (const [label, origin, baseDir] of shapes) {
			const byName = resolveWorkerExtensions(fakeOrigin("local", origin, entry, baseDir), [".*"]);
			assert.deepEqual(byName.toolNames, ["fixture_tool"], `${label}: the name rule cannot reach an unowned manifest`);
			const warnings: string[] = [];
			const piSlate = {
				getAllTools: () => SLATE_TOOL_NAMES.map((name) => ({
					name,
					description: "fixture",
					sourceInfo: { source: "local", origin, path: entry, baseDir },
				})),
			} as unknown as ExtensionAPI;
			const covered = resolveWorkerExtensions(piSlate, [".*"], (message) => warnings.push(message));
			assert.equal(covered.units.length, 0, `${label}: the collision barrier must return zero units`);
			assert.equal(warnings.length, 1, `${label}: the collision barrier must warn exactly once`);
		}
	} finally {
		rmSync(lab, { recursive: true, force: true });
	}
});

test("the resolver reads a candidate package name from its own package root", () => {
	// The E1 shape: a package source whose manifest declares the loaded entry
	// becomes a DIRECTORY unit, so the candidate path is the package root.
	const root = mkdtempSync(join(tmpdir(), "slate-worker-extension-name."));
	try {
		const entry = join(root, "extension", "index.ts");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "// fixture\n");
		writeFileSync(join(root, "package.json"), JSON.stringify({
			name: SLATE_PACKAGE_NAME,
			pi: { extensions: ["extension/index.ts"] },
		}));
		const resolved = resolveWorkerExtensions(fakePi(entry, root), [".*"]);
		assert.deepEqual(resolved.units, [], "a duplicate installed slate package must be rejected by name");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the slate package-name constant matches the package manifest", () => {
	const manifest = JSON.parse(readFileSync(join(SLATE_PACKAGE_ROOT, "package.json"), "utf8")) as { name?: unknown };
	assert.equal(SLATE_PACKAGE_NAME, manifest.name);
});

test("the collision fallback pins slate's complete tool-name set", () => {
	// pi keeps the first tool registration. Every current slate tool must collide
	// so an unreadable duplicate contributes no worker candidate through that rule.
	assert.deepEqual(SLATE_TOOL_NAMES, ["thread", "threads", "episode"]);
});
