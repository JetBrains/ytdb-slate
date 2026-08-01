// =============================================================================
// slate — packaging guards (driver)
// =============================================================================
// Makes AGENTS.md § "Packaging rules" executable. Two layers:
//
//   1. MANIFEST SHAPE — pure assertions over the parsed package.json: the exact
//      `files` whitelist (and, separately named, that it contains docs/ — a
//      recorded adversarial finding: omitting it ships a broken doctrine), the
//      pi-package keyword that lists the package in the pi.dev gallery, every
//      pi-bundled SDK package pinned to "*" in peerDependencies and absent from
//      dependencies, and no install-time lifecycle scripts.
//   2. REAL PACK OUTPUT — `npm pack --dry-run --json` run in the repo, because
//      the manifest field alone can never be enough: npm expands a whitelisted
//      directory RECURSIVELY and makes .npmignore/.gitignore inert, so a stray
//      file under extension/ ships invisibly. Asserted: every shipped path is
//      an allowed kind, none matches a junk/secret pattern, and every doctrine
//      doc the extension references at package-resolved runtime paths (DERIVED
//      from the extension sources, never hardcoded) is actually shipped.
//
// Needs NO pi and NO network — a first for this repo's check scripts: unlike
// run-ladder.sh and run-resolver-checks.sh it loads no extension module, starts
// no session and needs no jiti, so `node` and `npm` are the whole dependency
// list. It writes nothing: the pack is a dry run and the guards assert that no
// tarball was left behind.
//
// With --self-test it instead validates the guards THEMSELVES: each manifest
// assertion is re-run against a deep clone of the REAL package.json carrying
// exactly one violating mutation, and must FAIL. Fixtures are never hand-built
// — an assertion that reads a misspelled field would not notice a mutation of
// the real field, so the self-test fails instead of silently passing. The
// pack-output assertions are not manifest-shaped, so they are self-tested the
// same way against mutated clones of the REAL pack file list (said explicitly
// in their output).
//
// Run through run-packaging-checks.sh, which supplies the repo path as argv.
// Prints one `CHECK <id> <PASS|FAIL> — <detail>` line per check plus a summary,
// and exits non-zero if any check failed. See verification/README.md.
// =============================================================================
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const [, , REPO, ...REST] = process.argv;
if (!REPO) {
	console.error("packaging-checks.mjs: expected <repo> argv (run via run-packaging-checks.sh)");
	process.exit(2);
}
const SELF_TEST = REST.includes("--self-test");
for (const a of REST) {
	if (a !== "--self-test") {
		console.error(`packaging-checks.mjs: unknown argument '${a}'`);
		process.exit(2);
	}
}

let pass = 0;
let fail = 0;
function check(id, cond, detail) {
	console.log(`CHECK ${id.padEnd(16)} ${(cond ? "PASS" : "FAIL").padEnd(4)} — ${detail}`);
	cond ? pass++ : fail++;
}

// ------------------------------------------------------------------ helpers --
const list = (a) => (a.length ? a.join(", ") : "none");
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The pi-bundled SDK packages of AGENTS.md § Packaging rules: peer-only, "*",
// never a runtime dependency. devDependencies are irrelevant here — consumers
// never install them — so nothing below reads that field.
const SDK = [
	{ short: "pi-ai", name: "@earendil-works/pi-ai" },
	{ short: "pi-agent", name: "@earendil-works/pi-coding-agent" },
	{ short: "pi-tui", name: "@earendil-works/pi-tui" },
	{ short: "typebox", name: "typebox" },
];

// Lifecycle scripts npm runs on a consumer's machine at install time.
const INSTALL_SCRIPTS = ["prepare", "postinstall", "install", "preinstall"];

// What the package is allowed to ship. `extension` and `docs` in `files` expand
// recursively, so these say what may live UNDER them, not just at the top.
const ALLOWED = [
	{ label: "package.json", test: (p) => p === "package.json" },
	{ label: "README.md", test: (p) => p === "README.md" },
	{ label: "LICENSE", test: (p) => p === "LICENSE" },
	{ label: "docs/**/*.md", test: (p) => /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(p) },
	{ label: "extension/**/*.ts", test: (p) => /^extension\/(?:[^/]+\/)*[^/]+\.ts$/.test(p) },
];

// Junk/secret shapes that must never ship. A pattern containing "/" is matched
// against the whole path, one without it against the basename (a dotfile like
// extension/.env is junk wherever it sits). Case-insensitive throughout.
const JUNK = [".env*", "*.log", "*.pem", "*.key", "*.p12", "*secret*", "*credential*", "node_modules/**", "*.tgz", ".git*", "*.local.*"];
function isJunk(path) {
	return JUNK.some((pat) => {
		const body = pat.split("**").map((seg) => seg.split("*").map(rx).join("[^/]*")).join(".*");
		const re = new RegExp(`^${body}$`, "i");
		return pat.includes("/") ? re.test(path) : re.test(basename(path));
	});
}

// The doctrine docs the extension points at, DERIVED from the real sources so
// that adding a reference automatically extends the guard. Two passes: find the
// identifiers bound to the package's own docs directory (paths.ts resolves it
// from import.meta.url), then collect every *.md literal joined onto one of
// them. Deliberately narrow: doc names in prose comments, project-local
// templates (handoff's slate-handoff.md) and runtime-computed episode names are
// NOT package-resolved doctrine docs and must not leak into the derived set.
function deriveDoctrineDocs(repo) {
	const dir = join(repo, "extension");
	const sources = readdirSync(dir)
		.filter((f) => f.endsWith(".ts"))
		.map((f) => readFileSync(join(dir, f), "utf8"));
	const vars = new Set();
	for (const src of sources) {
		for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*join\([^;]*?["']docs["']\s*\)/g)) vars.add(m[1]);
	}
	const docs = new Set();
	for (const src of sources) {
		for (const v of vars) {
			for (const m of src.matchAll(new RegExp(`join\\(\\s*${rx(v)}\\s*,\\s*["']([^"'\\n]+\\.md)["']`, "g"))) docs.add(m[1]);
		}
	}
	return { vars: [...vars].sort(), docs: [...docs].sort() };
}

// The real shipped file list. --ignore-scripts matters: npm pack otherwise runs
// prepack/prepare, and a repo under test may carry exactly the install-time
// script this driver is here to catch. --dry-run writes no tarball; the
// pack-no-tarball guard proves it.
function packOutput(repo) {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: repo,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		maxBuffer: 32 * 1024 * 1024,
	});
	// npm prints an array of one pack report; older/newer npm has been known to
	// prepend notices, so parse from the first JSON opener and accept either an
	// array or a bare object.
	const starts = [out.indexOf("["), out.indexOf("{")].filter((i) => i >= 0);
	const parsed = starts.length ? JSON.parse(out.slice(Math.min(...starts))) : null;
	const report = Array.isArray(parsed) ? parsed[0] : parsed;
	const files = (report?.files ?? []).map((f) => f?.path).filter((p) => typeof p === "string").sort();
	// An empty list would make pack-allowed/pack-no-junk pass vacuously, so treat
	// an unreadable pack report as "refused to start" rather than as a green run.
	if (files.length === 0) {
		console.error("packaging-checks.mjs: `npm pack --dry-run --json` reported no files — cannot verify the pack output");
		process.exit(2);
	}
	return files;
}

// Every *.tgz in the checkout, so "the dry run wrote nothing" is checkable.
// node_modules and .git are skipped: tarballs cached in there are not ours.
function findTarballs(dir, rel = "") {
	const found = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === ".git") continue;
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) found.push(...findTarballs(join(dir, e.name), r));
		else if (e.name.endsWith(".tgz")) found.push(r);
	}
	return found;
}

// ------------------------------------------------------- manifest assertions --
// Pure functions over a parsed package.json object → { ok, detail }. Purity is
// what makes --self-test possible: the same function runs against the real
// manifest and against a mutated clone of it.
const MANIFEST = new Map();

const FILES_EXACT = ["extension", "docs", "README.md", "LICENSE"];
MANIFEST.set("files-exact", (m) => {
	const got = m.files;
	const ok = Array.isArray(got) && got.length === FILES_EXACT.length && got.every((v, i) => v === FILES_EXACT[i]);
	return { ok, detail: `files is exactly ${JSON.stringify(FILES_EXACT)} (order included), got ${JSON.stringify(got ?? null)}${ok ? "" : " — a whitelist change must consciously update this guard"}` };
});

MANIFEST.set("files-docs", (m) => {
	const ok = Array.isArray(m.files) && m.files.includes("docs");
	return { ok, detail: `files includes "docs" — ${ok ? "the doctrine's package-resolved docs ship" : "WITHOUT IT THE SHIPPED DOCTRINE IS BROKEN (recorded adversarial finding)"}` };
});

MANIFEST.set("keywords-pi-package", (m) => {
	const ok = Array.isArray(m.keywords) && m.keywords.includes("pi-package");
	return { ok, detail: `keywords contains "pi-package" (what lists the package in the pi.dev gallery), got ${JSON.stringify(m.keywords ?? null)}` };
});

for (const { short, name } of SDK) {
	MANIFEST.set(`peer-${short}`, (m) => {
		const v = (m.peerDependencies ?? {})[name];
		const ok = v === "*";
		return { ok, detail: `peerDependencies["${name}"] is exactly "*", got ${JSON.stringify(v ?? null)}` };
	});
	MANIFEST.set(`nodep-${short}`, (m) => {
		const deps = m.dependencies ?? {};
		const ok = !(name in deps);
		return { ok, detail: `"${name}" is absent from dependencies (never bundled; devDependencies are fine and not read here)${ok ? "" : ` — found ${JSON.stringify(deps[name])}`}` };
	});
}

MANIFEST.set("no-install-scripts", (m) => {
	const scripts = m.scripts ?? {};
	const offenders = INSTALL_SCRIPTS.filter((s) => s in scripts);
	return { ok: offenders.length === 0, detail: `scripts declares none of ${INSTALL_SCRIPTS.join("/")} (they would execute on every consumer install), offenders: ${list(offenders)}` };
});

// One violating mutation per manifest assertion, applied to a deep clone of the
// REAL manifest. Each returns a human description of what it changed.
const MUTATE = new Map();
MUTATE.set("files-exact", (m) => ((m.files = [...(m.files ?? []), "verification"]), 'pushed "verification" onto files'));
MUTATE.set("files-docs", (m) => ((m.files = (m.files ?? []).filter((f) => f !== "docs")), 'removed "docs" from files'));
MUTATE.set("keywords-pi-package", (m) => ((m.keywords = (m.keywords ?? []).filter((k) => k !== "pi-package")), 'removed "pi-package" from keywords'));
for (const { short, name } of SDK) {
	MUTATE.set(`peer-${short}`, (m) => ((m.peerDependencies = { ...(m.peerDependencies ?? {}), [name]: "^1.0.0" }), `set peerDependencies["${name}"] to "^1.0.0"`));
	MUTATE.set(`nodep-${short}`, (m) => ((m.dependencies = { ...(m.dependencies ?? {}), [name]: "^1.0.0" }), `added "${name}" to dependencies`));
}
MUTATE.set("no-install-scripts", (m) => ((m.scripts = { ...(m.scripts ?? {}), prepare: "echo pwned" }), 'added a "prepare" script'));

// ---------------------------------------------------- pack-output assertions --
// Pure functions over a pack context { files, docs, vars, tarballs } → the same
// { ok, detail } shape, so these are self-testable too: the mutation clones the
// REAL context instead of the real manifest.
const PACK = new Map();

PACK.set("pack-allowed", (ctx) => {
	const bad = ctx.files.filter((p) => !ALLOWED.some((a) => a.test(p)));
	return { ok: bad.length === 0, detail: `all ${ctx.files.length} shipped paths are one of ${ALLOWED.map((a) => a.label).join(" | ")} — offenders: ${list(bad)}` };
});

PACK.set("pack-no-junk", (ctx) => {
	const bad = ctx.files.filter((p) => isJunk(p));
	return { ok: bad.length === 0, detail: `no shipped path matches ${JUNK.join(" ")} (case-insensitive) — offenders: ${list(bad)}` };
});

PACK.set("pack-doctrine-docs", (ctx) => {
	const shipped = new Set(ctx.files);
	const missing = ctx.docs.filter((d) => !shipped.has(`docs/${d}`));
	const ok = ctx.docs.length > 0 && missing.length === 0;
	return {
		ok,
		detail: ctx.docs.length === 0
			? `DERIVED NO doctrine docs from extension/*.ts (docs-dir identifiers: ${list(ctx.vars)}) — the guard would be vacuous, so this fails`
			: `every doctrine doc derived from extension/*.ts via ${list(ctx.vars)} ships: ${ctx.docs.join(", ")} — missing: ${list(missing)}`,
	};
});

PACK.set("pack-no-tarball", (ctx) => ({
	ok: ctx.tarballs.length === 0,
	detail: `the --dry-run pack left no *.tgz in the checkout (node_modules/.git excluded) — found: ${list(ctx.tarballs)}`,
}));

const MUTATE_PACK = new Map();
MUTATE_PACK.set("pack-allowed", (c) => (c.files.push("verification/ci-canary.ts"), 'added shipped path "verification/ci-canary.ts"'));
MUTATE_PACK.set("pack-no-junk", (c) => (c.files.push("extension/.env"), 'added shipped path "extension/.env"'));
MUTATE_PACK.set("pack-doctrine-docs", (c) => {
	const gone = `docs/${c.docs[0]}`;
	c.files = c.files.filter((p) => p !== gone);
	return `dropped ${gone} from the shipped paths`;
});
MUTATE_PACK.set("pack-no-tarball", (c) => (c.tarballs.push("ytdb-slate-0.0.0.tgz"), 'added a stray "ytdb-slate-0.0.0.tgz"'));

// -------------------------------------------------------------------- inputs --
const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const derived = deriveDoctrineDocs(REPO);
const packFiles = packOutput(REPO);
const packCtx = { files: packFiles, docs: derived.docs, vars: derived.vars, tarballs: findTarballs(REPO) };

// --------------------------------------------------------------------- runs ---
if (!SELF_TEST) {
	for (const [id, assertion] of MANIFEST) {
		const r = assertion(manifest);
		check(id, r.ok, r.detail);
	}
	for (const [id, assertion] of PACK) {
		const r = assertion(packCtx);
		check(id, r.ok, r.detail);
	}
} else {
	// A mutation that changes nothing would make its self-test vacuous, so each
	// clone is compared against its source as well.
	console.log("-- self-test: every guard must FAIL on a real input carrying exactly one violating mutation --");
	for (const [id, assertion] of MANIFEST) {
		const clone = structuredClone(manifest);
		const what = MUTATE.get(id)(clone);
		const changed = JSON.stringify(clone) !== JSON.stringify(manifest);
		const r = assertion(clone);
		check(`self-${id}`, changed && !r.ok, `real manifest, ${what} → ${changed ? (r.ok ? "assertion still PASSED (the guard reads the wrong field)" : "assertion failed as required") : "mutation was a no-op (fixture void)"}`);
	}
	for (const [id, assertion] of PACK) {
		const clone = structuredClone(packCtx);
		const what = MUTATE_PACK.get(id)(clone);
		const changed = JSON.stringify(clone) !== JSON.stringify(packCtx);
		const r = assertion(clone);
		check(`self-${id}`, changed && !r.ok, `not manifest-shaped, so mutated the REAL pack list instead: ${what} → ${changed ? (r.ok ? "assertion still PASSED (the guard reads the wrong input)" : "assertion failed as required") : "mutation was a no-op (fixture void)"}`);
	}
}

console.log(`== summary: ${pass} pass, ${fail} fail ==`);
process.exit(fail > 0 ? 1 : 0);
