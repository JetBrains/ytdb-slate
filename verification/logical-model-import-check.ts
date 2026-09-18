import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const DORMANT_LOGICAL_MODEL_MODULES = Object.freeze([
	"extension/logical-model-definitions",
	"extension/logical-model-resolver",
	"extension/logical-model-render",
	"extension/logical-model-recovery",
	"extension/logical-model-adapters",
] as const);

export const REVIEWED_NON_LITERAL_MODULE_SITES = Object.freeze([
	"extension/writing.ts|import|WRITING_CHECKER_URL",
] as const);

export interface LogicalModelSource {
	path: string;
	source: string;
}

export interface LogicalModelImportIssue {
	kind: "forbidden-reference" | "computed-reference" | "parse-error";
	path: string;
	line: number;
	column: number;
	syntax?: "import" | "export" | "import-equals" | "require";
	specifier?: string;
	target?: string;
	expression?: string;
	message?: string;
}

export interface LogicalModelImportResult {
	files: readonly string[];
	issues: readonly LogicalModelImportIssue[];
	reviewedNonLiteralSites: readonly string[];
}

const SOURCE_SUFFIXES = Object.freeze([".tsx", ".mts", ".cts", ".jsx", ".mjs", ".cjs", ".ts", ".js"] as const);
const DORMANT_TARGETS = new Set<string>(DORMANT_LOGICAL_MODEL_MODULES);
const DORMANT_SOURCE_PATHS = new Set<string>(DORMANT_LOGICAL_MODEL_MODULES.map((path) => `${path}.ts`));

function portablePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function withoutSourceSuffix(path: string): string {
	const lower = path.toLowerCase();
	for (const suffix of SOURCE_SUFFIXES) {
		if (lower.endsWith(suffix)) return path.slice(0, -suffix.length);
	}
	return path;
}

function withoutJitiDecoration(specifier: string): string {
	const decoration = (specifier.startsWith("file:") ? /[?#]|%(?:3f|23)/i : /[?#]/).exec(specifier);
	return decoration ? specifier.slice(0, decoration.index) : specifier;
}

function resolvedDormantTarget(repositoryRoot: string, importer: string, specifier: string): string | undefined {
	const undecorated = withoutJitiDecoration(specifier);
	let candidate: string;
	try {
		if (undecorated.startsWith("file:")) candidate = fileURLToPath(undecorated);
		else if (isAbsolute(undecorated)) candidate = undecorated;
		else if (undecorated.startsWith(".")) candidate = resolve(repositoryRoot, dirname(importer), undecorated);
		else return undefined;
	} catch {
		return undefined;
	}
	const resolvedCandidate = withoutSourceSuffix(normalize(candidate));
	for (const target of DORMANT_TARGETS) {
		const dormantPath = withoutSourceSuffix(resolve(repositoryRoot, `${target}.ts`));
		if (resolvedCandidate === dormantPath) return target;
	}
	return undefined;
}

function sourceKind(path: string): ts.ScriptKind {
	return path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function location(sourceFile: ts.SourceFile, start: number): { line: number; column: number } {
	const point = sourceFile.getLineAndCharacterOfPosition(start);
	return { line: point.line + 1, column: point.character + 1 };
}

function reference(
	syntax: "import" | "export" | "import-equals" | "require",
	expression: ts.Expression | undefined,
): { syntax: "import" | "export" | "import-equals" | "require"; expression: ts.Expression | undefined } {
	return { syntax, expression };
}

export function analyzeLogicalModelSources(
	sources: readonly LogicalModelSource[],
	repositoryRoot: string,
	reviewedSites: readonly string[] = REVIEWED_NON_LITERAL_MODULE_SITES,
): LogicalModelImportResult {
	const issues: LogicalModelImportIssue[] = [];
	const reviewedNonLiteralSites: string[] = [];
	const remainingReviewedSites = new Map<string, number>();
	for (const site of reviewedSites) remainingReviewedSites.set(site, (remainingReviewedSites.get(site) ?? 0) + 1);

	for (const input of sources) {
		const path = portablePath(input.path);
		const sourceFile = ts.createSourceFile(path, input.source, ts.ScriptTarget.Latest, true, sourceKind(path));
		const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
		if (diagnostics.length > 0) {
			for (const diagnostic of diagnostics) {
				const start = diagnostic.start ?? 0;
				issues.push({
					kind: "parse-error",
					path,
					...location(sourceFile, start),
					message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
				});
			}
			continue;
		}

		const visit = (node: ts.Node): void => {
			let found: ReturnType<typeof reference> | undefined;
			if (ts.isImportDeclaration(node)) found = reference("import", node.moduleSpecifier);
			else if (ts.isExportDeclaration(node) && node.moduleSpecifier) found = reference("export", node.moduleSpecifier);
			else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
				found = reference("import-equals", node.moduleReference.expression);
			} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				found = reference("import", node.arguments[0]);
			} else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
				found = reference("require", node.arguments[0]);
			}

			if (found) {
				const start = found.expression?.getStart(sourceFile) ?? node.getStart(sourceFile);
				const point = location(sourceFile, start);
				if (found.expression && ts.isStringLiteralLike(found.expression)) {
					const target = resolvedDormantTarget(repositoryRoot, path, found.expression.text);
					if (target) issues.push({ kind: "forbidden-reference", path, ...point, syntax: found.syntax, specifier: found.expression.text, target });
				} else {
					const expression = found.expression?.getText(sourceFile) ?? "<missing>";
					const site = `${path}|${found.syntax}|${expression}`;
					const remaining = remainingReviewedSites.get(site) ?? 0;
					if (remaining > 0) {
						remainingReviewedSites.set(site, remaining - 1);
						reviewedNonLiteralSites.push(site);
					} else {
						issues.push({ kind: "computed-reference", path, ...point, syntax: found.syntax, expression });
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}

	return Object.freeze({
		files: Object.freeze(sources.map((source) => portablePath(source.path))),
		issues: Object.freeze(issues),
		reviewedNonLiteralSites: Object.freeze(reviewedNonLiteralSites),
	});
}

function isRuntimeSource(path: string): boolean {
	return path.endsWith(".ts") || path.endsWith(".mjs");
}

export function scanLogicalModelImports(extensionDirectory: string): LogicalModelImportResult {
	const absoluteExtensionDirectory = resolve(extensionDirectory);
	const repositoryRoot = dirname(absoluteExtensionDirectory);
	const sources: LogicalModelSource[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const absolute = `${directory}/${entry.name}`;
			if (entry.isDirectory()) walk(absolute);
			else if (entry.isFile() && isRuntimeSource(entry.name)) {
				const path = `extension/${portablePath(relative(extensionDirectory, absolute))}`;
				if (!DORMANT_SOURCE_PATHS.has(path)) sources.push({ path, source: readFileSync(absolute, "utf8") });
			}
		}
	};
	walk(absoluteExtensionDirectory);
	return analyzeLogicalModelSources(sources, repositoryRoot);
}
