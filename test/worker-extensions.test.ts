import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("reserved tools protect a local-file slate copy without a manifest", () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-extension-local-copy."));
	try {
		const entry = join(root, "index.ts");
		writeFileSync(entry, "// fixture\n");
		assert.equal(existsSync(join(root, "package.json")), false, "the local-file baseDir must expose no manifest");
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

test("the resolver reads a candidate package name from its package root", () => {
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
