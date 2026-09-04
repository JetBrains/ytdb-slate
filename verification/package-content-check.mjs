#!/usr/bin/env node
/** Verify the complete package-resolved runtime-file roster. */
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const args = process.argv.slice(2);
let repo = ".";
let selfTest = false;
for (let i = 0; i < args.length; i += 1) {
	if (args[i] === "--repo" && args[i + 1]) repo = args[++i];
	else if (args[i] === "--self-test") selfTest = true;
	else if (args[i] === "-h" || args[i] === "--help") {
		console.log("Usage: node verification/package-content-check.mjs [--repo <dir>] [--self-test]");
		console.log("  --self-test  prove command, document, packed-file, and dependency guards detect their mutations");
		process.exit(0);
	} else {
		console.error(`package-content-check: unknown or incomplete argument: ${args[i]}`);
		process.exit(2);
	}
}
repo = resolve(repo);

let ts;
try {
	const loaded = await import("typescript");
	ts = loaded.default ?? loaded;
} catch (error) {
	console.error(`package-content-check: refused to start — TypeScript dependency unavailable: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

function parse(source, file) {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	if (tree.parseDiagnostics.length > 0) {
		const detail = tree.parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ");
		throw new Error(`cannot parse ${file}: ${detail}`);
	}
	return tree;
}

function callName(expression) {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return "";
}

function runtimeRegistry(pathsSource, modeSource) {
	const pathsTree = parse(pathsSource, "extension/paths.ts");
	const modeTree = parse(modeSource, "extension/mode.ts");
	const declarations = new Map();
	const exported = new Set();
	for (const statement of pathsTree.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
			declarations.set(declaration.name.text, declaration.initializer);
			if (isExported) exported.add(declaration.name.text);
		}
	}
	const memo = new Map();
	function derive(name, stack = []) {
		if (memo.has(name)) return memo.get(name);
		if (stack.includes(name)) throw new Error(`cyclic runtime path declaration: ${[...stack, name].join(" -> ")}`);
		if (name === "EXTENSION_DIR") return { root: "extension", file: "" };
		if (name === "DOCS_DIR") return { root: "docs", file: "" };
		const expression = declarations.get(name);
		if (!expression) return null;
		let result = null;
		if (ts.isIdentifier(expression)) result = derive(expression.text, [...stack, name]);
		else if (ts.isCallExpression(expression) && ["join", "resolve"].includes(callName(expression.expression))) {
			const [baseExpression, ...rest] = expression.arguments;
			if (baseExpression && ts.isIdentifier(baseExpression) && rest.every((arg) => ts.isStringLiteralLike(arg))) {
				const base = derive(baseExpression.text, [...stack, name]);
				if (base) result = { root: base.root, file: join(base.file, ...rest.map((arg) => arg.text)) };
			}
		} else if (
			ts.isPropertyAccessExpression(expression) && expression.name.text === "href" &&
			ts.isCallExpression(expression.expression) && callName(expression.expression.expression) === "pathToFileURL"
		) {
			const [target] = expression.expression.arguments;
			if (target && ts.isIdentifier(target)) {
				const base = derive(target.text, [...stack, name]);
				if (base?.root === "extension") result = { root: "extension-url", file: base.file };
			}
		}
		memo.set(name, result);
		return result;
	}

	const importedPathNames = new Set();
	for (const statement of modeTree.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "./paths.ts") continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) throw new Error("extension/mode.ts must use named imports for package runtime paths");
		for (const element of bindings.elements) importedPathNames.add((element.propertyName ?? element.name).text);
	}
	return { exported, importedPathNames, derive };
}

function slash(path) {
	return path.split(sep).join("/");
}

function inspectRoster({ pathsSource, modeSource, docsFiles, commandFiles, packedFiles }) {
	const registry = runtimeRegistry(pathsSource, modeSource);
	const findings = [];
	const commands = [];
	const documents = [];
	for (const name of [...registry.exported].sort()) {
		const path = registry.derive(name);
		if (path?.root === "extension" && path.file !== "") commands.push([name, slash(path.file)]);
		else if (path?.root === "docs" && path.file !== "") documents.push([name, slash(path.file)]);
		else if (path?.root !== "extension-url") findings.push(`unclassified exported runtime path: ${name}`);
	}
	for (const name of registry.importedPathNames) {
		if (!registry.exported.has(name)) findings.push(`mode imports a path that paths.ts does not export: ${name}`);
		else if (registry.derive(name) === null) findings.push(`mode imports an unresolved runtime path: ${name}`);
	}
	const commandByFile = new Map(commandFiles.map((file) => [file, commands.filter(([, exportedFile]) => exportedFile === file).map(([name]) => name)]));
	for (const [file, names] of commandByFile) {
		if (names.length === 0) findings.push(`missing command export for extension/${file}`);
		else if (names.length > 1) findings.push(`multiple command exports for extension/${file}: ${names.join(", ")}`);
	}
	const documentByFile = new Map(docsFiles.map((file) => [file, documents.filter(([, exportedFile]) => exportedFile === file).map(([name]) => name)]));
	for (const [file, names] of documentByFile) {
		if (names.length === 0) findings.push(`missing document export for docs/${file}`);
		else if (names.length > 1) findings.push(`multiple document exports for docs/${file}: ${names.join(", ")}`);
	}
	for (const [name, file] of commands) {
		if (!commandFiles.includes(file)) findings.push(`command export ${name} names no shipped command: extension/${file}`);
	}
	for (const [name, file] of documents) {
		if (!docsFiles.includes(file)) findings.push(`document export ${name} names no shipped Markdown file: docs/${file}`);
	}
	const expected = [
		...commands.map(([name, file]) => [`${name} (${file})`, `extension/${file}`]),
		...documents.map(([name, file]) => [`${name} (${file})`, `docs/${file}`]),
	];
	for (const [name, file] of expected) {
		if (!packedFiles.has(file)) findings.push(`missing packed runtime file ${name}: ${file}`);
	}
	return { findings, expected };
}

function walkMarkdown(dir, prefix = "") {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : join(prefix, entry.name);
		if (entry.isDirectory()) files.push(...walkMarkdown(join(dir, entry.name), rel));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(slash(rel));
	}
	return files.sort();
}

function isCommandEntry(path, source) {
	return path.endsWith(".mjs") && source.split(/\r?\n/, 1)[0] === "#!/usr/bin/env node";
}

function walkCommands(dir, prefix = "") {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : join(prefix, entry.name);
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkCommands(abs, rel));
		else if (entry.isFile() && entry.name.endsWith(".mjs") && isCommandEntry(rel, readFileSync(abs, "utf8"))) files.push(slash(rel));
	}
	return files.sort();
}

function realInputs() {
	let pathsSource;
	let modeSource;
	let docsFiles;
	let commandFiles;
	try {
		pathsSource = readFileSync(resolve(repo, "extension/paths.ts"), "utf8");
		modeSource = readFileSync(resolve(repo, "extension/mode.ts"), "utf8");
		docsFiles = walkMarkdown(resolve(repo, "docs"));
		commandFiles = walkCommands(resolve(repo, "extension"));
		if (!statSync(resolve(repo, "package.json")).isFile()) throw new Error("package.json is not a regular file");
	} catch (error) {
		throw new Error(`cannot read runtime roster inputs: ${error instanceof Error ? error.message : String(error)}`);
	}
	const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: repo,
		encoding: "utf8",
		timeout: 30_000,
	});
	if (packed.error || packed.status !== 0) throw new Error(`npm pack failed${packed.error ? `: ${packed.error.message}` : packed.stderr ? `: ${packed.stderr.trim()}` : ""}`);
	let manifest;
	try {
		const parsed = JSON.parse(packed.stdout);
		manifest = parsed[0];
		if (!manifest || !Array.isArray(manifest.files)) throw new Error("missing files array");
	} catch (error) {
		throw new Error(`cannot parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { pathsSource, modeSource, docsFiles, commandFiles, packedFiles: new Set(manifest.files.map((entry) => entry.path)) };
}

const EXPECTED_SELF_TEST_CASES = [
	"baseline",
	"nested-command-helper",
	"missing-nested-command-export",
	"missing-document-export",
	"missing-packed-runtime",
	"help-without-typescript",
	"missing-typescript",
];

function runSelfTest() {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "slate-package-content-self-"));
	try {
		const extensionDir = join(fixtureRoot, "extension");
		mkdirSync(join(extensionDir, "commands"), { recursive: true });
		mkdirSync(join(extensionDir, "helpers"), { recursive: true });
		writeFileSync(join(extensionDir, "commands", "command.mjs"), "#!/usr/bin/env node\n");
		writeFileSync(join(extensionDir, "helpers", "helper.mjs"), "export const helper = true;\n");
		const commandFiles = walkCommands(extensionDir);
		const pathsSource = [
			'const EXTENSION_DIR = "/extension";',
			'const DOCS_DIR = "/docs";',
			'export const COMMAND = join(EXTENSION_DIR, "commands", "command.mjs");',
			'export const DOC_A = join(DOCS_DIR, "a.md");',
		].join("\n");
		const modeSource = 'import { DOC_A } from "./paths.ts";\nvoid DOC_A;';
		const base = { pathsSource, modeSource, docsFiles: ["a.md"], commandFiles, packedFiles: new Set(["extension/commands/command.mjs", "extension/helpers/helper.mjs", "docs/a.md"]) };
		const mutations = [
			["missing-nested-command-export", { ...base, pathsSource: pathsSource.replace("export const COMMAND", "const COMMAND") }, /missing command export/],
			["missing-document-export", { ...base, pathsSource: pathsSource.replace("export const DOC_A", "const DOC_A"), modeSource: "" }, /missing document export/],
			["missing-packed-runtime", { ...base, packedFiles: new Set(["docs/a.md"]) }, /missing packed runtime file/],
		];
		let failed = false;
		const reported = [];
		const report = (name, ok, detail) => {
			reported.push(name);
			console.log(`SELF ${name} ${ok ? "PASS" : "FAIL"} — ${detail}`);
			if (!ok) failed = true;
		};
		const clean = inspectRoster(base);
		report("baseline", clean.findings.length === 0, clean.findings.length === 0 ? "fabricated complete roster passes" : clean.findings.join(" | "));
		const recursionOk = commandFiles.join() === "commands/command.mjs";
		report("nested-command-helper", recursionOk, "recursive shebang command included, helper without shebang excluded");
		for (const [name, fixture, expected] of mutations) {
			const result = inspectRoster(fixture);
			const caught = result.findings.some((finding) => expected.test(finding));
			report(name, caught, caught ? result.findings.find((finding) => expected.test(finding)) : "mutation escaped detection");
		}

		const isolatedScript = join(fixtureRoot, "package-content-check.mjs");
		copyFileSync(fileURLToPath(import.meta.url), isolatedScript);
		const help = spawnSync(process.execPath, [isolatedScript, "--help"], { encoding: "utf8" });
		const missingDependency = spawnSync(process.execPath, [isolatedScript, "--repo", fixtureRoot], { encoding: "utf8" });
		const helpOk = help.status === 0 && /Usage:/.test(help.stdout);
		const dependencyOk = missingDependency.status === 2 && /refused to start — TypeScript dependency unavailable/.test(missingDependency.stderr);
		report("help-without-typescript", helpOk, "help is parsed before optional analyzer loading");
		report("missing-typescript", dependencyOk, "real analysis refuses with exit 2 and a bounded diagnostic");
		const missing = EXPECTED_SELF_TEST_CASES.filter((name) => !reported.includes(name));
		const duplicated = reported.filter((name, index) => reported.indexOf(name) !== index);
		const unexpected = reported.filter((name) => !EXPECTED_SELF_TEST_CASES.includes(name));
		const rosterOk = missing.length === 0 && duplicated.length === 0 && unexpected.length === 0;
		console.log(`SELF roster ${rosterOk ? "PASS" : "FAIL"} — independent expected cases reconcile; missing: ${missing.join(", ") || "none"}; duplicated: ${duplicated.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
		if (!rosterOk) failed = true;
		return failed ? 1 : 0;
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
}

try {
	if (selfTest) {
		process.exitCode = runSelfTest();
	} else {
		const result = inspectRoster(realInputs());
		const failedFiles = new Set(result.findings.filter((finding) => finding.startsWith("missing packed runtime file ")).map((finding) => finding.slice(finding.lastIndexOf(": ") + 2)));
		for (const [name, file] of result.expected) {
			console.log(`PACKAGE ${name} ${failedFiles.has(file) ? "FAIL" : "PASS"} — ${file}`);
		}
		for (const finding of result.findings) console.error(`PACKAGE ROSTER FAIL — ${finding}`);
		console.log(`PACKAGE roster ${result.findings.length === 0 ? "PASS" : "FAIL"} — every command and shipped Markdown file has one exported runtime path, and every runtime path is packed`);
		process.exitCode = result.findings.length === 0 ? 0 : 1;
	}
} catch (error) {
	console.error(`package-content-check: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 2;
}
