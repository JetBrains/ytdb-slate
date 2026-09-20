import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const PROTECTED_LOGICAL_MODEL_MODULES = Object.freeze([
	"extension/logical-model-definitions",
	"extension/logical-model-resolver",
	"extension/logical-model-render",
	"extension/logical-model-recovery",
	"extension/logical-model-adapters",
	"extension/logical-model-runtime",
] as const);

/** Exact reviewed runtime edges. Duplicate entries represent distinct declarations. */
export const REVIEWED_LOGICAL_MODEL_EDGES = Object.freeze([
	"extension/base-model.ts|import|extension/logical-model-definitions",
	"extension/episodes.ts|import|extension/logical-model-adapters",
	"extension/episodes.ts|import|extension/logical-model-runtime",
	"extension/episodes.ts|import|extension/logical-model-recovery",
	"extension/episodes.ts|import|extension/logical-model-definitions",
	"extension/failover.ts|import|extension/logical-model-adapters",
	"extension/failover.ts|import|extension/logical-model-runtime",
	"extension/failover.ts|import|extension/logical-model-recovery",
	"extension/handoff.ts|import|extension/logical-model-runtime",
	"extension/index.ts|import|extension/logical-model-adapters",
	"extension/index.ts|import|extension/logical-model-recovery",
	"extension/index.ts|import|extension/logical-model-runtime",
	"extension/logical-model-adapters.ts|import|extension/logical-model-definitions",
	"extension/logical-model-adapters.ts|import|extension/logical-model-recovery",
	"extension/logical-model-recovery.ts|import|extension/logical-model-definitions",
	"extension/logical-model-recovery.ts|import|extension/logical-model-resolver",
	"extension/logical-model-render.ts|import|extension/logical-model-definitions",
	"extension/logical-model-render.ts|import|extension/logical-model-resolver",
	"extension/logical-model-resolver.ts|import|extension/logical-model-definitions",
	"extension/logical-model-runtime.ts|import|extension/logical-model-definitions",
	"extension/logical-model-runtime.ts|import|extension/logical-model-resolver",
	"extension/logical-model-runtime.ts|import|extension/logical-model-render",
	"extension/logical-model-runtime.ts|import|extension/logical-model-recovery",
	"extension/logical-model-runtime.ts|import|extension/logical-model-adapters",
	"extension/mode.ts|import|extension/logical-model-runtime",
	"extension/state.ts|import|extension/logical-model-definitions",
	"extension/threads.ts|import|extension/logical-model-adapters",
	"extension/threads.ts|import|extension/logical-model-runtime",
	"extension/threads.ts|import|extension/logical-model-recovery",
	"extension/threads.ts|import|extension/logical-model-definitions",
	"extension/threads.ts|import|extension/logical-model-runtime",
	"extension/worker.ts|import|extension/logical-model-definitions",
	"extension/worker.ts|import|extension/logical-model-recovery",
] as const);

export const REVIEWED_NON_LITERAL_MODULE_SITES = Object.freeze([
	"extension/writing.ts|import|WRITING_CHECKER_URL",
] as const);

export interface LogicalModelSource { path: string; source: string }
export interface LogicalModelImportIssue {
	kind: "forbidden-reference" | "computed-reference" | "parse-error" | "missing-reviewed-edge" | "unsafe-brand-cast";
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
	reviewedLiteralEdges: readonly string[];
	reviewedNonLiteralSites: readonly string[];
}

const SOURCE_SUFFIXES = Object.freeze([".tsx", ".mts", ".cts", ".jsx", ".mjs", ".cjs", ".ts", ".js"] as const);
const PROTECTED_TARGETS = new Set<string>(PROTECTED_LOGICAL_MODEL_MODULES);
const BRAND_CAST_CONSUMERS = new Set(["extension/threads.ts"]);
const BRAND_PRODUCER = "extension/logical-model-runtime.ts";
const PROTECTED_BRANDS = new Set(["SessionBaseline", "OpenModel"]);

function portablePath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, ""); }
function withoutSourceSuffix(path: string): string {
	const lower = path.toLowerCase();
	for (const suffix of SOURCE_SUFFIXES) if (lower.endsWith(suffix)) return path.slice(0, -suffix.length);
	return path;
}
function withoutJitiDecoration(specifier: string): string {
	const decoration = (specifier.startsWith("file:") ? /[?#]|%(?:3f|23)/i : /[?#]/).exec(specifier);
	return decoration ? specifier.slice(0, decoration.index) : specifier;
}
function resolvedProtectedTarget(repositoryRoot: string, importer: string, specifier: string): string | undefined {
	const undecorated = withoutJitiDecoration(specifier);
	let candidate: string;
	try {
		if (undecorated.startsWith("file:")) candidate = fileURLToPath(undecorated);
		else if (isAbsolute(undecorated)) candidate = undecorated;
		else if (undecorated.startsWith(".")) candidate = resolve(repositoryRoot, dirname(importer), undecorated);
		else return undefined;
	} catch { return undefined; }
	const resolvedCandidate = withoutSourceSuffix(normalize(candidate));
	for (const target of PROTECTED_TARGETS) {
		if (resolvedCandidate === withoutSourceSuffix(resolve(repositoryRoot, `${target}.ts`))) return target;
	}
	return undefined;
}
function sourceKind(path: string): ts.ScriptKind { return path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS; }
function location(sourceFile: ts.SourceFile, start: number): { line: number; column: number } {
	const point = sourceFile.getLineAndCharacterOfPosition(start);
	return { line: point.line + 1, column: point.character + 1 };
}
function protectedBrand(type: ts.TypeNode): string | undefined {
	return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && PROTECTED_BRANDS.has(type.typeName.text)
		? type.typeName.text
		: undefined;
}
type Syntax = "import" | "export" | "import-equals" | "require";
function reference(syntax: Syntax, expression: ts.Expression | undefined): { syntax: Syntax; expression: ts.Expression | undefined } { return { syntax, expression }; }

export function analyzeLogicalModelSources(
	sources: readonly LogicalModelSource[],
	repositoryRoot: string,
	reviewedNonLiteralSites: readonly string[] = REVIEWED_NON_LITERAL_MODULE_SITES,
	reviewedLiteralEdges: readonly string[] = [],
): LogicalModelImportResult {
	const issues: LogicalModelImportIssue[] = [];
	const acceptedLiteral: string[] = [];
	const acceptedNonLiteral: string[] = [];
	const remainingLiteral = new Map<string, number>();
	const remainingNonLiteral = new Map<string, number>();
	for (const edge of reviewedLiteralEdges) remainingLiteral.set(edge, (remainingLiteral.get(edge) ?? 0) + 1);
	for (const site of reviewedNonLiteralSites) remainingNonLiteral.set(site, (remainingNonLiteral.get(site) ?? 0) + 1);

	for (const input of sources) {
		const path = portablePath(input.path);
		const sourceFile = ts.createSourceFile(path, input.source, ts.ScriptTarget.Latest, true, sourceKind(path));
		const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
		if (diagnostics.length > 0) {
			for (const diagnostic of diagnostics) issues.push({ kind: "parse-error", path, ...location(sourceFile, diagnostic.start ?? 0), message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") });
			continue;
		}
		const visit = (node: ts.Node): void => {
			const asAssertion = ts.isAsExpression(node);
			const angleAssertion = ts.isTypeAssertionExpression(node);
			const assertedType = asAssertion || angleAssertion ? node.type : undefined;
			const brand = assertedType === undefined ? undefined : protectedBrand(assertedType);
			const boundedConsumer = BRAND_CAST_CONSUMERS.has(path);
			const unsafeNamedAs = path !== BRAND_PRODUCER && asAssertion && brand !== undefined;
			const unsafeBoundedAngle = boundedConsumer && angleAssertion && brand !== undefined;
			const unsafeBoundedNever = boundedConsumer && asAssertion && node.type.kind === ts.SyntaxKind.NeverKeyword;
			if (unsafeNamedAs || unsafeBoundedAngle || unsafeBoundedNever) {
				issues.push({
					kind: "unsafe-brand-cast",
					path,
					...location(sourceFile, node.getStart(sourceFile)),
					expression: node.getText(sourceFile),
				});
			}
			let found: ReturnType<typeof reference> | undefined;
			if (ts.isImportDeclaration(node)) found = reference("import", node.moduleSpecifier);
			else if (ts.isExportDeclaration(node) && node.moduleSpecifier) found = reference("export", node.moduleSpecifier);
			else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) found = reference("import-equals", node.moduleReference.expression);
			else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found = reference("import", node.arguments[0]);
			else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") found = reference("require", node.arguments[0]);
			if (found) {
				const start = found.expression?.getStart(sourceFile) ?? node.getStart(sourceFile);
				const point = location(sourceFile, start);
				if (found.expression && ts.isStringLiteralLike(found.expression)) {
					const target = resolvedProtectedTarget(repositoryRoot, path, found.expression.text);
					if (target) {
						const edge = `${path}|${found.syntax}|${target}`;
						const remaining = remainingLiteral.get(edge) ?? 0;
						if (remaining > 0) { remainingLiteral.set(edge, remaining - 1); acceptedLiteral.push(edge); }
						else issues.push({ kind: "forbidden-reference", path, ...point, syntax: found.syntax, specifier: found.expression.text, target });
					}
				} else {
					const expression = found.expression?.getText(sourceFile) ?? "<missing>";
					const site = `${path}|${found.syntax}|${expression}`;
					const remaining = remainingNonLiteral.get(site) ?? 0;
					if (remaining > 0) { remainingNonLiteral.set(site, remaining - 1); acceptedNonLiteral.push(site); }
					else issues.push({ kind: "computed-reference", path, ...point, syntax: found.syntax, expression });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	for (const [edge, count] of remainingLiteral) {
		for (let index = 0; index < count; index++) issues.push({ kind: "missing-reviewed-edge", path: edge.split("|", 1)[0]!, line: 1, column: 1, target: edge.split("|")[2], message: edge });
	}
	return Object.freeze({ files: Object.freeze(sources.map((source) => portablePath(source.path))), issues: Object.freeze(issues), reviewedLiteralEdges: Object.freeze(acceptedLiteral), reviewedNonLiteralSites: Object.freeze(acceptedNonLiteral) });
}

function isRuntimeSource(path: string): boolean { return path.endsWith(".ts") || path.endsWith(".mjs"); }
export function scanLogicalModelImports(
	extensionDirectory: string,
	reviewedLiteralEdges: readonly string[] = REVIEWED_LOGICAL_MODEL_EDGES,
): LogicalModelImportResult {
	const absoluteExtensionDirectory = resolve(extensionDirectory);
	const repositoryRoot = dirname(absoluteExtensionDirectory);
	const sources: LogicalModelSource[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const absolute = `${directory}/${entry.name}`;
			if (entry.isDirectory()) walk(absolute);
			else if (entry.isFile() && isRuntimeSource(entry.name)) sources.push({ path: `extension/${portablePath(relative(extensionDirectory, absolute))}`, source: readFileSync(absolute, "utf8") });
		}
	};
	walk(absoluteExtensionDirectory);
	return analyzeLogicalModelSources(sources, repositoryRoot, REVIEWED_NON_LITERAL_MODULE_SITES, reviewedLiteralEdges);
}
