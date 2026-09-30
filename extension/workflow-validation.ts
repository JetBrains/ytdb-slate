// Workflow input is YAML text. Handler inspection accepts a literal, column-zero
// `export const handlers = {` block with two-space-indented quoted event keys,
// identifier values, and `};` on its own line. LF and CRLF are accepted.
// A column-zero `function name(` line is required for each value. This
// check reads the declared form only. It does not prove JavaScript meaning or
// export binding, so a crafted file can pass it. No handler code is run here.
import { createHash } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node as YAMLNode } from "yaml";

export const REQUIRED_WORKFLOW_EVENTS = ["root.start", "root.ownerChanged", "root.close", "dispatch.validate", "dispatch.prepare", "episode.received"] as const;
export const MAX_WORKFLOW_BYTES = 131_072;
export const MAX_WORKFLOW_DEPTH = 64;
export const MAX_GUARD_EXPRESSION_DEPTH = 32;
export type WorkflowProblem = { path: string; message: string; severity: "error" | "warning" };
export type WorkflowProviders = {
  document: (name: string) => string;
  handlerSource: (name: string) => string;
};
export type WorkflowValidation = { value: Record<string, unknown> | null; problems: WorkflowProblem[] };

// Fingerprint the exact UTF-8 file bytes. The pin is a test of the shipped file, not a runtime override.
export function workflowFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export function checkWorkflowVersion(text: string, version: number, pin: { version: number; fingerprint: string }): boolean {
  return version === pin.version && workflowFingerprint(text) === pin.fingerprint;
}

const word = /^[a-z]+(?:_[a-z]+)*$/;
const kebab = /^[a-z]+(?:-[a-z]+)*$/;
const configKey = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const forbidden = new Set(["free", "declare", "override", "__proto__", "constructor", "prototype"]);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (v: Record<string, unknown>, k: string): unknown => Object.hasOwn(v, k) ? v[k] : undefined;
const entries = (v: unknown): [string, unknown][] => record(v) ? Object.entries(v) : [];
const field = (p: string, k: string) => `${p}.${k}`;
const sub = (p: string, k: string) => `${p}[${JSON.stringify(k)}]`;
const echo = (text: string, limit = 1024): string => {
  if (text.length <= limit) return text;
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1]!) && /[\uDC00-\uDFFF]/.test(text[limit]!) ? limit - 1 : limit;
  return `${text.slice(0, end)}...[truncated]`;
};
const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const causeText = (cause: unknown): string => {
  try { return String(cause); }
  catch { return "unprintable provider error"; }
};
const limitedNames = (names: string[]): string => {
  if (!names.length) return "none";
  const first: string[] = [];
  for (const name of names.slice(0, 8)) {
    const escaped = JSON.stringify(name);
    first.push(echo(escaped, 96));
    if (escaped.length > 96) break;
  }
  const rest = names.length - first.length;
  return first.join(", ") + (rest ? ` (and ${rest} more)` : "");
};

// Every emitted validation message has one rule ID and an explicit allowed form.
// The adapters M3, M4, M8, M27, M30 and M58 retain external diagnostic detail.
const rules = {
  M1: { allowed: "131072 UTF-8 bytes", message: () => "Workflow text must be at most 131072 UTF-8 bytes." },
  M2: { allowed: "64 node levels, 128 leading spaces per line, or 64 opening [ or { characters and compact - or ? block markers combined per line (compact markers start the line content)", message: () => "Workflow nesting must not exceed 64 node levels, 128 leading spaces per line, or 64 opening [ or { characters and compact - or ? block markers combined per line (compact markers start the line content)." },
  M3: { allowed: "one valid YAML 1.2 document", message: (a: string) => `Use one valid YAML 1.2 document. Parser refused input: ${a}.` },
  M4: { allowed: "one valid YAML 1.2 document with unique keys, no aliases, anchors or tags", message: (a: string, b: string) => `Use one valid YAML 1.2 document with unique keys, no aliases, anchors or tags. Parser ${a}: ${b}` },
  M5: { allowed: "exactly one YAML document", message: () => "workflow must contain exactly one YAML document" },
  M6: { allowed: "YAML without aliases, anchors or tags", message: () => "aliases, anchors and tags are forbidden" },
  M7: { allowed: "string scalars (plain or quoted)", message: () => "mapping keys must be string scalars (plain or quoted)" },
  M8: { allowed: "one YAML 1.2 mapping without aliases, anchors or tags", message: (a: string) => `Use one YAML 1.2 mapping without aliases, anchors or tags. Conversion failed: ${a}.` },
  M9: { allowed: "a mapping", message: () => "workflow must be a mapping" },
  M10: { allowed: "a mapping", message: () => "must be a mapping" },
  M11: { allowed: "required field", message: () => "required field is missing" },
  M12: { allowed: "only these fields", message: (a: string) => `Use only these fields: ${a}.` },
  M13: { allowed: "nonempty text", message: () => "must be nonempty text" },
  M14: { allowed: "a name matching the stated pattern and not reserved", message: (a: string) => `name must match ${a} and cannot be free, declare, override, __proto__, constructor or prototype` },
  M15: { allowed: "positive safe integer at most 9007199254740991", message: () => "id must be a positive safe integer at most 9007199254740991" },
  M16: { allowed: "unused workflow ID", message: (a: string) => `Choose an unused workflow ID. This ID first appears at ${a}.` },
  M17: { allowed: "declared", message: (a: string) => `must name a declared ${a}` },
  M18: { allowed: "safe integer at most 9007199254740991", message: () => "priority must be a safe integer at most 9007199254740991" },
  M19: { allowed: "1", message: () => "format must be 1" },
  M20: { allowed: "positive safe integer at most 9007199254740991", message: () => "version must be a positive safe integer at most 9007199254740991" },
  M21: { allowed: "a list", message: () => "must be a list" },
  M22: { allowed: "a configuration key matching the stated pattern and not reserved", message: (a: string) => `configuration key must match ${a} and cannot be free, declare, override, __proto__, constructor or prototype` },
  M23: { allowed: "boolean, enum or text", message: () => "configuration type must be boolean, enum or text" },
  M24: { allowed: "nonempty list of text values", message: () => "enum requires a nonempty list of text values" },
  M25: { allowed: "only for enum configuration", message: () => "values are allowed only for enum configuration" },
  M26: { allowed: "document name must match", message: (a: string) => `document name must match ${a}` },
  M27: { allowed: "text of at most 131072 UTF-8 bytes", message: (a: string) => `Document provider must return text of at most 131072 UTF-8 bytes for ${a}.` },
  M28: { allowed: "exactly once", message: (a: string) => `section heading must occur exactly once: ${a}` },
  M29: { allowed: "exactly once", message: (a: string) => `section heading must occur exactly once: ${a}` },
  M30: { allowed: "readable text", message: (a: string, b: string) => `Document provider must return readable text for ${a}. Check the document name and read access. Provider error: ${b}.` },
  M31: { allowed: "integer, text, enum or list", message: () => "argument type must be integer, text, enum or list" },
  M32: { allowed: "design-triggering or reviewer-only", message: () => "focus class must be design-triggering or reviewer-only" },
  M33: { allowed: "one root lifecycle", message: () => "one root lifecycle is required" },
  M34: { allowed: "at most 32 levels", message: () => "Guard expression depth must be at most 32 levels." },
  M35: { allowed: "declared condition or guard", message: () => "expression must name a declared condition or guard" },
  M36: { allowed: "{ not: expr }, { and: [expr, expr, ...] } or { or: [expr, expr, ...] }", message: () => "guard expression must name a declared condition or guard, or use { not: expr }, { and: [expr, expr, ...] } or { or: [expr, expr, ...] }" },
  M37: { allowed: "a name that no condition in this lifecycle uses", message: () => "Give this guard a name that no condition in this lifecycle uses." },
  M38: { allowed: "not contain a cycle", message: (a: string) => `guard expressions must not contain a cycle at ${a}` },
  M39: { allowed: "{ key, equals: value }, { key, in: [values] } or { key, present: true }", message: () => "step condition must be { key, equals: value }, { key, in: [values] } or { key, present: true }" },
  M40: { allowed: "a mapping", message: () => "on must be a mapping" },
  M41: { allowed: "cannot appear in on", message: () => "completion trigger cannot appear in on" },
  M42: { allowed: "nonempty list", message: () => "branches must be a nonempty list" },
  M43: { allowed: "a mapping", message: () => "branch must be a mapping" },
  M44: { allowed: "last after a guarded branch", message: () => "else must be last after a guarded branch" },
  M45: { allowed: "when naming a declared guard or condition, except a final else", message: () => "multiple branches require when naming a declared guard or condition, except a final else" },
  M46: { allowed: "declared guard or condition", message: () => "when must name a declared guard or condition" },
  M47: { allowed: "boolean", message: () => "must be boolean" },
  M48: { allowed: "terminal state cannot have on or call", message: () => "terminal state cannot have on or call" },
  M49: { allowed: "a lifecycle name as text", message: () => "call must be a lifecycle name as text" },
  M50: { allowed: "reachable from initialState by ordinary transitions", message: () => "state must be reachable from initialState by ordinary transitions" },
  M51: { allowed: "an ordinary transition path to a terminal state", message: () => "non-terminal state needs an ordinary transition path to a terminal state" },
  M52: { allowed: "this trigger in on, anyState, or a step completedBy", message: () => "Use this trigger in on, anyState, or a step completedBy." },
  M53: { allowed: "this condition in a guard expression or branch when", message: () => "Use this condition in a guard expression or branch when." },
  M54: { allowed: "this guard in another guard expression or branch when", message: () => "Use this guard in another guard expression or branch when." },
  M55: { allowed: "not contain a cycle", message: (a: string) => `lifecycle calls must not contain a cycle at ${a}` },
  M56: { allowed: "a call-state path from the root lifecycle", message: () => "Add a call-state path from the root lifecycle to this lifecycle, or remove it." },
  M57: { allowed: "export const handlers = {", message: (a: string) => `Declare ${a} in export const handlers = { with a two-space-indented quoted key and a function name. End every entry, including the last, with a comma. Close with a closing brace and semicolon on its own line and define function name( at column zero. Use LF or CRLF and at most 131072 UTF-8 bytes. This text check cannot prove JavaScript meaning.` },
  M58: { allowed: "readable text", message: (a: string, b: string) => `Handler provider must return readable text for ${a}. Check the handler name and read access. Provider error: ${b}.` },
  T1: { allowed: "a declared configuration key", message: (a: string, b: string) => `Placeholder ${a} must name a declared configuration key. Declared keys: ${b}.` },
  T2: { allowed: "an entity name using lower-case words separated by _", message: (a: string) => `Root placeholder ${a} must use an entity name using lower-case words separated by _. Reserved names: free, declare, override, __proto__, constructor, prototype.` },
  T3: { allowed: "nonempty, unique text values", message: () => "Enum values must be nonempty, unique text values." },
  T4: { allowed: "only for enum arguments", message: () => "Values are allowed only for enum arguments." },
  T5: { allowed: "nonempty list of text values", message: () => "Enum argument requires a nonempty list of text values." },
  T6: { allowed: "true or false", message: () => "Boolean step equals must be true or false." },
  T7: { allowed: "a declared enum value", message: (a: string) => `Enum step equals must be a declared enum value. Declared values: ${a}.` },
  T8: { allowed: "a nonempty list of declared enum values", message: (a: string) => `Enum step in must be a nonempty list of declared enum values. Declared values: ${a}.` },
  T9: { allowed: "{ key, present: true }", message: () => "Text step condition must use { key, present: true }." },
  T10: { allowed: "{ key, equals: true or false }", message: () => "Boolean step condition must use { key, equals: true or false }." },
  T11: { allowed: "{ key, equals: value } or { key, in: [values] }", message: () => "Enum step condition must use { key, equals: value } or { key, in: [values] }." },
  T12: { allowed: "without the merge key <<", message: () => "Write this mapping without the merge key <<." },
  T13: { allowed: "use {config:key} or {root:name}", message: (a: string) => `Close placeholder ${a} with } to use {config:key} or {root:name}.` },
} satisfies Record<string, { allowed: string; message: (...args: string[]) => string }>;
type RuleId = keyof typeof rules;
const problemRules = new WeakMap<WorkflowProblem, RuleId>();
// Tests inspect rule identity without changing the problem fields.
export function workflowProblemRule(problem: WorkflowProblem): string | undefined { return problemRules.get(problem); }
// Read-only descriptions support tests and the human-written format reference.
export function workflowRuleDescriptions(): ReadonlyArray<Readonly<{ id: RuleId; allowed: string; sample: string }>> {
  return Object.freeze(Object.entries(rules).map(([id, rule]) => Object.freeze({
    id: id as RuleId, allowed: rule.allowed,
    sample: renderRule(id as RuleId, id === "M26" ? kebab.source : "allowed fields", "sample cause"),
  })));
}
const renderRule = (id: RuleId, a = "", b = ""): string => (rules[id].message as (a: string, b: string) => string)(a, b);

// This check reads the declared form only. A crafted file can pass it because
// this check cannot establish JavaScript scope or meaning.
export function checkHandlerExports(source: string): string[] {
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES || /\/\*|`|\r(?!\n)/.test(source)) return [...REQUIRED_WORKFLOW_EVENTS];
  const normalized = source.replace(/\r\n/g, "\n");
  const match = normalized.match(/^export const handlers = \{\n((?:  "[a-zA-Z.]+": [a-zA-Z_$][\w$]*,\n)+)\};(?:\n|$)/);
  if (!match || /^export\s/m.test(normalized.slice(match[0].length))) return [...REQUIRED_WORKFLOW_EVENTS];
  const declarations = [...match[1]!.matchAll(/^  "([a-zA-Z.]+)": ([a-zA-Z_$][\w$]*),?$/gm)];
  const bindings = new Map(declarations.map(m => [m[1], m[2]]));
  if (bindings.size !== declarations.length || [...bindings.keys()].some(k => !REQUIRED_WORKFLOW_EVENTS.includes(k as typeof REQUIRED_WORKFLOW_EVENTS[number]))) return [...REQUIRED_WORKFLOW_EVENTS];
  return REQUIRED_WORKFLOW_EVENTS.filter(event => {
    const binding = bindings.get(event);
    return !binding || !new RegExp(`^function ${binding}\\(`, "m").test(normalized);
  });
}

// Index headings once. A fence or multiline HTML comment hides headings inside it.
function indexWorkflowSections(source: string): (heading: string, includeText?: boolean) => { start: number; end: number; text?: string } | { error: string } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1]! + line.length + 1);
  let fence: { marker: string; width: number } | undefined;
  let comment = false;
  const headings: { name: string; level: number; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (comment) { if (line.includes("-->")) comment = false; continue; }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.width && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined;
      continue;
    }
    if (marker) { fence = { marker: marker[1]![0]!, width: marker[1]!.length }; continue; }
    const opener = line.indexOf("<!--");
    if (opener !== -1 && !line.slice(opener + 4).includes("-->")) comment = true;
    if (/^\s*<!--/.test(line)) continue;
    let headingLine = line;
    if (opener !== -1 && /^#{1,6}(?:[ \t]|$)/.test(line)) {
      let visible = "";
      let pos = 0;
      while (pos < line.length) {
        const start = line.indexOf("<!--", pos);
        if (start === -1) { visible += line.slice(pos); break; }
        visible += line.slice(pos, start);
        const end = line.indexOf("-->", start + 4);
        pos = end === -1 ? line.length : end + 3;
      }
      headingLine = visible;
    }
    let level = 0;
    while (level < headingLine.length && headingLine[level] === "#") level++;
    if (level < 1 || level > 6 || (headingLine[level] !== undefined && headingLine[level] !== " " && headingLine[level] !== "\t")) continue;
    let name = headingLine.slice(level).trim();
    let end = name.length;
    while (end > 0 && name[end - 1] === "#") end--;
    if (end < name.length && end > 0 && (name[end - 1] === " " || name[end - 1] === "\t")) name = name.slice(0, end).trimEnd();
    headings.push({ name, level, line: i });
  }
  const byName = new Map<string, { start: number; end: number } | { error: string }>();
  const stack: typeof headings = [];
  for (let i = headings.length - 1; i >= 0; i--) {
    const start = headings[i]!;
    while (stack.length && stack[stack.length - 1]!.level > start.level) stack.pop();
    const end = stack[stack.length - 1]?.line ?? lines.length;
    if (byName.has(start.name)) byName.set(start.name, { error: "heading appears more than once" });
    else byName.set(start.name, { start: start.line + 1, end });
    stack.push(start);
  }
  return (heading, includeText = true) => {
    const found = byName.get(heading);
    return !found ? { error: "heading is missing" } : "error" in found ? found : {
      start: offsets[found.start]!, end: found.start === found.end ? offsets[found.start]! : offsets[found.end - 1]! + lines[found.end - 1]!.length,
      ...(includeText ? { text: lines.slice(found.start, found.end).join("\n") } : {}),
    };
  };
}

export function findWorkflowSection(source: string, heading: string): { text: string } | { error: string } {
  const found = indexWorkflowSections(source)(heading, true);
  return "error" in found ? found : { text: found.text! };
}

export function validateWorkflow(text: string, providers: WorkflowProviders): WorkflowValidation {
  const problems: WorkflowProblem[] = [];
  let errorCount = 0;
  const emit = (path: string, rule: RuleId, severity: WorkflowProblem["severity"], a = "", b = "") => {
    const problem: WorkflowProblem = { path: safe(echo(path)), message: safe(renderRule(rule, echo(a), echo(b))), severity };
    problemRules.set(problem, rule);
    problems.push(problem);
  };
  const error = (path: string, rule: RuleId, a = "", b = "") => { errorCount++; emit(path, rule, "error", a, b); };
  const warn = (path: string, rule: RuleId) => emit(path, rule, "warning");
  if (Buffer.byteLength(text, "utf8") > MAX_WORKFLOW_BYTES) { error("$", "M1"); return { value: null, problems }; }
  // Bound parser work before construction. Conservative raw-source rejection is intentional.
  for (const line of text.split(/\r?\n/)) {
    const compact = line.match(/^[ \t]*(?::[ \t]+)?(?:[-?][ \t]+)+/)?.[0].match(/[-?]/g)?.length ?? 0;
    const openings = line.match(/[\[{]/g)?.length ?? 0;
    if ((line.match(/^ */)?.[0].length ?? 0) > MAX_WORKFLOW_DEPTH * 2 || compact + openings > MAX_WORKFLOW_DEPTH) {
      error("$", "M2"); return { value: null, problems };
    }
  }
  let docs: ReturnType<typeof parseAllDocuments>;
  try { docs = parseAllDocuments(text, { version: "1.2", schema: "core", strict: true, uniqueKeys: true, merge: false, logLevel: "silent" }); }
  catch (cause) { error("$", "M3", causeText(cause)); return { value: null, problems }; }
  const diagnostics = 'empty' in docs ? [...docs.errors, ...docs.warnings] : docs.flatMap(parsed => [...parsed.errors, ...parsed.warnings]);
  for (const issue of diagnostics) {
    const correction = issue.code === "DUPLICATE_KEY" ? "Use unique mapping keys. "
      : issue.code === "TAG_RESOLVE_FAILED" ? "Remove the unsupported tag. "
      : issue.code === "BAD_INDENT" || issue.code === "TAB_AS_INDENT" ? "Use valid space indentation. "
      : issue.code === "BAD_DIRECTIVE" ? "Use a valid YAML 1.2 directive. "
      : issue.code === "RESOURCE_EXHAUSTION" ? "Reduce workflow nesting to at most 64 node levels. " : "";
    error("$", "M4", issue.code, correction + issue.message);
  }
  if (docs.length !== 1) error("$", "M5");
  if (problems.length) return { value: null, problems };
  const doc = docs[0]!;
  let depthError = false;
  const scan = (node: YAMLNode | null | undefined, path: string, depth: number): void => {
    if (!node || depthError) return;
    if (depth > MAX_WORKFLOW_DEPTH) { depthError = true; error(path, "M2"); return; }
    if (isAlias(node) || node.anchor || node.tag) error(path, "M6");
    if (isMap(node)) for (const item of node.items) {
      const key = isScalar(item.key) && typeof item.key.value === "string" ? item.key.value : "?";
      if (!isScalar(item.key) || typeof item.key.value !== "string") error(path, "M7");
      if (key === "<<") error(sub(path, key), "T12");
      scan(item.key as YAMLNode, sub(path, key), depth + 1);
      scan(item.value as YAMLNode, sub(path, key), depth + 1);
    }
    if (isSeq(node)) node.items.forEach((item, i) => scan(item as YAMLNode, `${path}[${i}]`, depth + 1));
  };
  scan(doc.contents, "$", 0);
  if (problems.length) return { value: null, problems };
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 0, mapAsMap: false }); }
  catch (cause) { error("$", "M8", causeText(cause)); return { value: null, problems }; }
  if (!record(value)) { error("$", "M9"); return { value: null, problems }; }
  const root = value;
  const declaredKeys = limitedNames(entries(root.configuration).map(([key]) => key));
  const placeholders = (textValue: string, p: string, documentName?: string) => {
    const located = (token: string) => documentName ? `${token} in document ${JSON.stringify(documentName)}` : token;
    for (const match of textValue.matchAll(/\{(config|root):([^{}\r\n]*)(\}|(?=\{|\r|\n|$))/g)) {
      const token = match[0];
      if (!token.endsWith("}")) { error(p, "T13", located(token)); continue; }
      if (match[1] === "config" && (!record(root.configuration) || !Object.hasOwn(root.configuration, match[2]!)))
        error(p, "T1", located(token), declaredKeys);
      if (match[1] === "root" && (!word.test(match[2]!) || forbidden.has(match[2]!))) error(p, "T2", located(token));
    }
  };
  const ids = new Map<number, string>();
  const used = new Set<string>();
  const enumCache = new WeakMap<object, { members: Set<string>; display: string }>();
  const shape = (v: unknown, path: string, required: string[], optional: string[] = []): v is Record<string, unknown> => {
    if (!record(v)) { error(path, "M10"); return false; }
    for (const k of required) if (!Object.hasOwn(v, k)) error(field(path, k), "M11");
    for (const k of Object.keys(v)) if (![...required, ...optional].includes(k)) error(field(path, k), "M12", [...required, ...optional].join(", "));
    return true;
  };
  const string = (v: unknown, p: string) => { if (typeof v !== "string" || !v.trim()) error(p, "M13"); else placeholders(v, p); };
  const name = (k: unknown, p: string, pattern = word) => { if (typeof k !== "string" || !pattern.test(k) || forbidden.has(k)) error(p, "M14", pattern.source); };
  const id = (v: unknown, p: string) => {
    if (!Number.isSafeInteger(v) || (v as number) < 1) { error(p, "M15"); return; }
    const prior = ids.get(v as number);
    if (prior) error(p, "M16", prior);
    else ids.set(v as number, p);
  };
  const entity = (v: unknown, p: string, required: string[], optional: string[] = []): v is Record<string, unknown> => {
    if (!shape(v, p, ["id", ...required], optional)) return false;
    id(own(v, "id"), field(p, "id"));
    return true;
  };
  const ref = (key: unknown, table: unknown, p: string, kind: string) => {
    if (typeof key !== "string" || !record(table) || !Object.hasOwn(table, key)) error(p, "M17", kind);
    else used.add(p + ":" + key);
  };
  const section = (key: unknown, p: string) => ref(key, root.sections, p, "section");
  const addition = (v: unknown, p: string) => {
    if (!entity(v, p, ["section", "priority"])) return;
    section(v.section, field(p, "section"));
    if (!Number.isSafeInteger(v.priority)) error(field(p, "priority"), "M18");
  };
  shape(root, "$", ["format", "workflowId", "workflowVersion", "description", "useWhen", "root", "handlers", "progressRecord", "configuration", "sections", "orchestrator", "workflowArgs", "threadTypes", "focusAreas", "lifecycles"]);
  if (root.format !== 1) error("$.format", "M19");
  if (!Number.isSafeInteger(root.workflowVersion) || (root.workflowVersion as number) < 1) error("$.workflowVersion", "M20");
  name(root.workflowId, "$.workflowId", kebab);
  for (const k of ["description", "useWhen", "progressRecord"]) if (Object.hasOwn(root, k)) string(root[k], field("$", k));
  if (Object.hasOwn(root, "handlers")) name(root.handlers, "$.handlers", /^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)?$/);
  const maps = ["configuration", "sections", "workflowArgs", "threadTypes", "focusAreas", "lifecycles"];
  for (const k of maps) if (!record(root[k])) error(field("$", k), "M10");
  if (!Array.isArray(root.orchestrator)) error("$.orchestrator", "M21");
  else root.orchestrator.forEach((v, i) => addition(v, `$.orchestrator[${i}]`));
  for (const [k, v] of entries(root.configuration)) {
    const p = sub("$.configuration", k);
    if (!configKey.test(k) || forbidden.has(k)) error(p, "M22", configKey.source);
    if (entity(v, p, ["type", "description"], ["values"])) {
      if (typeof v.type !== "string" || !["boolean", "enum", "text"].includes(v.type)) error(field(p, "type"), "M23");
      string(v.description, field(p, "description"));
      if (v.type === "enum") {
        if (!Array.isArray(v.values) || !v.values.length || !v.values.every(x => typeof x === "string")) error(field(p, "values"), "M24");
        else if (v.values.some(x => !x.trim()) || new Set(v.values).size !== v.values.length) error(field(p, "values"), "T3");
      }
      if (v.type !== "enum" && v.values !== undefined) error(field(p, "values"), "M25");
    }
  }
  const documentIndexes = new Map<string, { index: ReturnType<typeof indexWorkflowSections>; source: string; ranges: { start: number; end: number; path: string }[] } | Error>();
  const usedSections = new Set<string>();
  if (Array.isArray(root.orchestrator)) for (const item of root.orchestrator) if (record(item) && typeof item.section === "string") usedSections.add(item.section);
  for (const [, data] of entries(root.threadTypes)) if (record(data) && Array.isArray(data.prompt))
    for (const item of data.prompt) if (record(item) && typeof item.section === "string") usedSections.add(item.section);
  for (const [, data] of entries(root.focusAreas)) if (record(data) && record(data.charter) && typeof data.charter.section === "string") usedSections.add(data.charter.section);
  for (const [k, v] of entries(root.sections)) {
    const p = sub("$.sections", k);
    name(k, p, kebab);
    if (!entity(v, p, ["document", "heading", "description"])) continue;
    for (const f of ["document", "heading", "description"]) string(v[f], field(p, f));
    if (typeof v.document !== "string" || !kebab.test(v.document)) { error(field(p, "document"), "M26", kebab.source); continue; }
    try {
      let index = documentIndexes.get(v.document);
      if (!index) {
        try {
          const source = providers.document(v.document);
          if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
            error(field(p, "document"), "M27", v.document);
            continue;
          }
          index = { index: indexWorkflowSections(source), source: source.replace(/\r\n/g, "\n"), ranges: [] };
        } catch (cause) { index = cause instanceof Error ? cause : Error(causeText(cause)); }
        documentIndexes.set(v.document, index);
      }
      if (index instanceof Error) throw index;
      const found = index.index(String(v.heading));
      if ("error" in found) error(field(p, "heading"), found.error === "heading is missing" ? "M28" : "M29", found.error);
      else if (usedSections.has(k)) index.ranges.push({ start: found.start, end: found.end, path: field(p, "heading") });
    } catch (cause) { error(field(p, "document"), "M30", v.document, causeText(cause)); }
  }
  // Scan each covered character at most once, even when used sections nest or share a heading.
  for (const [documentName, index] of documentIndexes) {
    if (index instanceof Error) continue;
    let scannedTo = 0;
    index.ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    for (const range of index.ranges) {
      const start = Math.max(range.start, scannedTo);
      if (start < range.end) placeholders(index.source.slice(start, range.end), range.path, documentName);
      scannedTo = Math.max(scannedTo, range.end);
    }
  }
  for (const [k, v] of entries(root.workflowArgs)) {
    const p = sub("$.workflowArgs", k); name(k, p);
    if (entity(v, p, ["type", "description"], ["values"])) {
      if (typeof v.type !== "string" || !["integer", "text", "enum", "list"].includes(v.type)) error(field(p, "type"), "M31");
      string(v.description, field(p, "description"));
      if (v.type === "enum") {
        if (!Array.isArray(v.values) || !v.values.length || !v.values.every(x => typeof x === "string")) error(field(p, "values"), "T5");
        else if (v.values.some(x => !x.trim()) || new Set(v.values).size !== v.values.length) error(field(p, "values"), "T3");
      } else if (v.values !== undefined) error(field(p, "values"), "T4");
    }
  }
  for (const [k, v] of entries(root.threadTypes)) {
    const p = sub("$.threadTypes", k); name(k, p);
    if (entity(v, p, ["description", "prompt"])) {
      string(v.description, field(p, "description"));
      if (!Array.isArray(v.prompt)) error(field(p, "prompt"), "M21");
      else v.prompt.forEach((a, i) => addition(a, `${p}.prompt[${i}]`));
    }
  }
  for (const [k, v] of entries(root.focusAreas)) {
    const p = sub("$.focusAreas", k); name(k, p);
    if (entity(v, p, ["class", "description", "definition", "charter"])) {
      if (typeof v.class !== "string" || !["design-triggering", "reviewer-only"].includes(v.class)) error(field(p, "class"), "M32");
      string(v.description, field(p, "description")); section(v.definition, field(p, "definition")); addition(v.charter, field(p, "charter"));
    }
  }
  const lifecycles = root.lifecycles;
  if (!entries(lifecycles).length) error("$.lifecycles", "M33");
  else ref(root.root, lifecycles, "$.root", "lifecycle");
  const calls = new Map<string, string[]>();
  for (const [lk, lv] of entries(lifecycles)) {
    const initialErrors = errorCount;
    const lp = sub("$.lifecycles", lk); name(lk, lp);
    if (!entity(lv, lp, ["description", "initialState", "conditions", "guards", "triggers", "states"], ["anyState", "steps"])) continue;
    string(lv.description, field(lp, "description"));
    for (const k of ["conditions", "guards", "triggers", "states"]) if (!record(lv[k])) error(field(lp, k), "M10");
    ref(lv.initialState, lv.states, field(lp, "initialState"), "state");
    const edges = new Map<string, Set<string>>();
    const guardEdges = new Map<string, string[]>();
    const usedLocal = new Set<string>();
    const usedTriggers = new Set<string>();
    for (const k of ["conditions", "triggers"]) for (const [n, v] of entries(lv[k])) {
      const p = sub(field(lp, k), n); name(n, p);
      if (entity(v, p, ["description"])) string(v.description, field(p, "description"));
    }
    const conditionNames = new Set(entries(lv.conditions).map(([k]) => k));
    const guardNames = new Set(entries(lv.guards).map(([k]) => k));
    const expr = (v: unknown, p: string, refs: string[], depth: number): void => {
      if (depth > MAX_GUARD_EXPRESSION_DEPTH) { error(p, "M34"); return; }
      if (typeof v === "string") {
        if (!conditionNames.has(v) && !guardNames.has(v)) error(p, "M35");
        else { usedLocal.add(v); if (guardNames.has(v)) refs.push(v); }
      } else if (record(v) && Object.keys(v).length === 1) {
        const op = Object.keys(v)[0]!; const part = v[op];
        if (op === "not") expr(part, field(p, op), refs, depth + 1);
        else if ((op === "and" || op === "or") && Array.isArray(part) && part.length >= 2) part.forEach((e, i) => expr(e, `${p}.${op}[${i}]`, refs, depth + 1));
        else error(p, "M36");
      } else error(p, "M36");
    };
    for (const [n, v] of entries(lv.guards)) {
      const p = sub(field(lp, "guards"), n); name(n, p);
      if (conditionNames.has(n)) error(p, "M37");
      if (entity(v, p, ["description", "expr"])) {
        string(v.description, field(p, "description")); const refs: string[] = [];
        expr(v.expr, field(p, "expr"), refs, 0); guardEdges.set(n, refs);
      }
    }
    const cyclic = (graph: Map<string, string[]>, label: string) => {
      const visited = new Set<string>(), active = new Set<string>();
      const walk = (k: string): void => {
        if (active.has(k)) { error(label, "M38", k); return; }
        if (visited.has(k)) return;
        visited.add(k); active.add(k);
        for (const next of graph.get(k) ?? []) walk(next);
        active.delete(k);
      };
      for (const k of graph.keys()) walk(k);
    };
    cyclic(guardEdges, field(lp, "guards"));
    const completed = new Set<string>();
    if (lv.steps !== undefined && !record(lv.steps)) error(field(lp, "steps"), "M10");
    for (const [n, v] of entries(lv.steps)) {
      const p = sub(field(lp, "steps"), n); name(n, p);
      if (!entity(v, p, ["description", "attachTo", "when", "section", "completedBy"])) continue;
      string(v.description, field(p, "description")); section(v.section, field(p, "section"));
      ref(v.attachTo, lv.states, field(p, "attachTo"), "state"); ref(v.completedBy, lv.triggers, field(p, "completedBy"), "trigger");
      if (typeof v.completedBy === "string") completed.add(v.completedBy);
      if (!record(v.when) || typeof v.when.key !== "string") error(field(p, "when"), "M39");
      else {
        ref(v.when.key, root.configuration, field(p, "when.key"), "configuration key");
        const predicates = ["equals", "in", "present"].filter(key => Object.hasOwn(v.when as Record<string, unknown>, key));
        if (Object.keys(v.when).length !== 2 || predicates.length !== 1 ||
            (predicates[0] === "in" && !Array.isArray(v.when.in)) ||
            (predicates[0] === "present" && v.when.present !== true)) error(field(p, "when"), "M39");
        else {
          const config = record(root.configuration) ? own(root.configuration, v.when.key) : undefined;
          if (record(config)) {
            if (config.type === "boolean") {
              if (predicates[0] !== "equals") error(field(p, "when"), "T10");
              else if (typeof v.when.equals !== "boolean") error(field(p, "when.equals"), "T6");
            } else if (config.type === "text") {
              if (predicates[0] !== "present") error(field(p, "when"), "T9");
            } else if (config.type === "enum") {
              if (predicates[0] === "present") error(field(p, "when"), "T11");
              else if (Array.isArray(config.values) && config.values.every(x => typeof x === "string")) {
                let allowed = enumCache.get(config);
                if (!allowed) {
                  allowed = { members: new Set(config.values as string[]), display: limitedNames(config.values as string[]) };
                  enumCache.set(config, allowed);
                }
                if (predicates[0] === "equals" && (typeof v.when.equals !== "string" || !allowed.members.has(v.when.equals))) error(field(p, "when.equals"), "T7", allowed.display);
                if (predicates[0] === "in" && (!Array.isArray(v.when.in) || !v.when.in.length || v.when.in.some(x => typeof x !== "string" || !allowed.members.has(x)))) error(field(p, "when.in"), "T8", allowed.display);
              }
            }
          }
        }
      }
    }
    const transitions = (on: unknown, p: string, from: string[]) => {
      if (!record(on)) { error(p, "M40"); return; }
      for (const [trigger, branches] of entries(on)) {
        const tp = sub(p, trigger); name(trigger, tp); ref(trigger, lv.triggers, tp, "trigger"); usedTriggers.add(trigger);
        if (completed.has(trigger)) error(tp, "M41");
        if (!Array.isArray(branches) || !branches.length) { error(tp, "M42"); continue; }
        branches.forEach((branch, i) => {
          const bp = `${tp}[${i}]`;
          if (!record(branch)) { error(bp, "M43"); return; }
          const isElse = Object.hasOwn(branch, "else");
          if (!entity(branch, bp, isElse ? ["else"] : ["to"], isElse ? [] : ["when"])) return;
          if (isElse) {
            if (i !== branches.length - 1 || branches.length === 1) error(bp, "M44");
            ref(branch.else, lv.states, field(bp, "else"), "state");
          } else {
            ref(branch.to, lv.states, field(bp, "to"), "state");
            if (branches.length > 1 && !Object.hasOwn(branch, "when")) error(field(bp, "when"), "M45");
            if (branch.when !== undefined) {
              if (typeof branch.when !== "string" || (!guardNames.has(branch.when) && !conditionNames.has(branch.when))) error(field(bp, "when"), "M46");
              else usedLocal.add(branch.when);
            }
          }
          const dest = isElse ? branch.else : branch.to;
          if (typeof dest === "string") for (const s of from) edges.get(s)?.add(dest);
        });
      }
    };
    const stateNames = entries(lv.states).map(([k]) => k);
    for (const n of stateNames) edges.set(n, new Set());
    for (const [n, v] of entries(lv.states)) {
      const p = sub(field(lp, "states"), n); name(n, p);
      if (!entity(v, p, ["description"], ["section", "terminal", "call", "on"])) continue;
      string(v.description, field(p, "description"));
      if (v.section !== undefined) section(v.section, field(p, "section"));
      if (v.terminal !== undefined && typeof v.terminal !== "boolean") error(field(p, "terminal"), "M47");
      if (v.terminal === true && (v.on !== undefined || v.call !== undefined)) error(p, "M48");
      if (v.call !== undefined) {
        if (typeof v.call !== "string") error(field(p, "call"), "M49");
        else {
          ref(v.call, lifecycles, field(p, "call"), "lifecycle");
          if (record(lifecycles) && Object.hasOwn(lifecycles, v.call)) calls.set(lk, [...(calls.get(lk) ?? []), v.call]);
        }
      }
      if (v.on !== undefined) transitions(v.on, field(p, "on"), [n]);
    }
    if (lv.anyState !== undefined) transitions(lv.anyState, field(lp, "anyState"), stateNames.filter(n => { const state = own(lv.states as Record<string, unknown>, n); return record(state) && state.terminal !== true; }));
    // Only ordinary transitions contribute edges. Calls and step completion
    // preserve the current state. Built-in free/declare/override do not count.
    const terminal = new Set(entries(lv.states).filter(([, v]) => record(v) && v.terminal === true).map(([n]) => n));
    const walk = (starts: Iterable<string>, graph: Map<string, Set<string>>) => {
      const seen = new Set<string>();
      const pending = [...starts];
      while (pending.length) {
        const current = pending.pop()!;
        if (seen.has(current) || !graph.has(current)) continue;
        seen.add(current);
        for (const next of graph.get(current)!) if (!seen.has(next)) pending.push(next);
      }
      return seen;
    };
    if (errorCount === initialErrors) {
      const forward = walk(typeof lv.initialState === "string" ? [lv.initialState] : [], edges);
      const reverse = new Map(stateNames.map(n => [n, new Set<string>()]));
      for (const [from, destinations] of edges) for (const to of destinations) reverse.get(to)?.add(from);
      const backward = walk(terminal, reverse);
      for (const n of stateNames) {
        if (!forward.has(n)) error(sub(field(lp, "states"), n), "M50");
        if (!terminal.has(n) && !backward.has(n)) error(sub(field(lp, "states"), n), "M51");
      }
    }
    if (errorCount === initialErrors)
      for (const k of ["triggers", "conditions", "guards"]) for (const [n] of entries(lv[k])) if (!(k === "triggers" ? usedTriggers.has(n) || completed.has(n) : usedLocal.has(n))) warn(sub(field(lp, k), n), k === "triggers" ? "M52" : k === "conditions" ? "M53" : "M54");
  }
  const graph = new Map(entries(lifecycles).map(([k]) => [k, calls.get(k) ?? []]));
  const reachable = new Set<string>(), active = new Set<string>();
  const visitCall = (k: string) => {
    if (active.has(k)) { error("$.lifecycles", "M55", k); return; }
    if (reachable.has(k)) return;
    reachable.add(k); active.add(k);
    for (const next of graph.get(k) ?? []) if (graph.has(next)) visitCall(next);
    active.delete(k);
  };
  if (typeof root.root === "string" && graph.has(root.root)) {
    visitCall(root.root);
    for (const k of graph.keys()) if (!reachable.has(k)) error(sub("$.lifecycles", k), "M56");
  }
  if (typeof root.handlers === "string" && /^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)?$/.test(root.handlers)) {
    try { for (const missing of checkHandlerExports(providers.handlerSource(root.handlers))) error("$.handlers", "M57", missing); }
    catch (cause) { error("$.handlers", "M58", root.handlers, causeText(cause)); }
  }
  return { value: errorCount ? null : root, problems };
}
