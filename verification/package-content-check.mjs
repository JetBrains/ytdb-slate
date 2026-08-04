#!/usr/bin/env node
/** Verify that npm's publish file set contains every package-resolved runtime file. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

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

function parse(source, file) {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	if (tree.parseDiagnostics.length > 0) {
		const detail = tree.parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ");
		throw new Error(`cannot parse ${file}: ${detail}`);
	}
	return tree;
}

let pathsTree;
let modeTree;
try {
	pathsTree = parse(pathsSource, "extension/paths.ts");
	modeTree = parse(modeSource, "extension/mode.ts");
} catch (error) {
	console.error(`package-content-check: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

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

function callName(expression) {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return "";
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
	if (ts.isIdentifier(expression)) {
		result = derive(expression.text, [...stack, name]);
	} else if (ts.isCallExpression(expression) && ["join", "resolve"].includes(callName(expression.expression))) {
		const [baseExpression, ...rest] = expression.arguments;
		if (baseExpression && ts.isIdentifier(baseExpression) && rest.every((arg) => ts.isStringLiteralLike(arg))) {
			const base = derive(baseExpression.text, [...stack, name]);
			if (base) result = { root: base.root, file: join(base.file, ...rest.map((arg) => arg.text)) };
		}
	} else if (ts.isPropertyAccessExpression(expression) && expression.name.text === "href" && ts.isCallExpression(expression.expression) && callName(expression.expression.expression) === "pathToFileURL") {
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
	if (!bindings || !ts.isNamedImports(bindings)) {
		console.error("package-content-check: extension/mode.ts must use named imports for package runtime paths");
		process.exit(2);
	}
	for (const element of bindings.elements) importedPathNames.add((element.propertyName ?? element.name).text);
}

let checker;
try {
	checker = derive("WRITING_CHECKER");
	if (!exported.has("WRITING_CHECKER") || checker?.root !== "extension" || checker.file === "") {
		throw new Error("cannot derive exported WRITING_CHECKER from extension/paths.ts");
	}
} catch (error) {
	console.error(`package-content-check: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

const citedDocs = [];
try {
	for (const name of importedPathNames) {
		if (!exported.has(name)) throw new Error(`mode imports a path that paths.ts does not export: ${name}`);
		const path = derive(name);
		if (path?.root === "docs") citedDocs.push([name, path.file]);
		else if (path?.root !== "extension-url") throw new Error(`cannot classify imported runtime path ${name}; doctrine document references must resolve statically under DOCS_DIR`);
	}
	if (citedDocs.length === 0) throw new Error("no doctrine document references found in extension/mode.ts");
} catch (error) {
	console.error(`package-content-check: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

const expected = [
	[`WRITING_CHECKER (${checker.file})`, `extension/${checker.file}`],
	...citedDocs.sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => [`${name} (${file})`, `docs/${file}`]),
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
