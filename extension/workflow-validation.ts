// Workflow input is YAML text. Handler inspection accepts a literal, column-zero
// `export const handlers = {` block with two-space-indented quoted event keys,
// identifier values, and `};` on its own line. LF and CRLF are accepted.
// A column-zero `function name(` line is required for each value. This
// check reads the declared form only. It does not prove JavaScript meaning or
// export binding, so a crafted file can pass it. No handler code is run here.
import { createHash } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node as YAMLNode } from "yaml";

export const REQUIRED_WORKFLOW_EVENTS = ["root.start", "root.ownerChanged", "root.close", "dispatch.validate", "dispatch.prepare", "episode.received"] as const;
export const MAX_WORKFLOW_BYTES = 131_072;
export const MAX_WORKFLOW_DEPTH = 64;
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
const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

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
function indexWorkflowSections(source: string): (heading: string, includeText?: boolean) => { text: string } | { error: string } {
  const lines = source.split(/\r?\n/);
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
    const m = headingLine.match(/^(#{1,6})(?:[ \t]+(.+?)\s*|[ \t]*)$/);
    if (m) headings.push({ name: (m[2] ?? "").replace(/[ \t]+#+[ \t]*$/, ""), level: m[1]!.length, line: i });
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
    return !found ? { error: "heading is missing" } : "error" in found ? found : { text: includeText ? lines.slice(found.start, found.end).join("\n") : "" };
  };
}

export function findWorkflowSection(source: string, heading: string): { text: string } | { error: string } {
  return indexWorkflowSections(source)(heading);
}

export function validateWorkflow(text: string, providers: WorkflowProviders): WorkflowValidation {
  const problems: WorkflowProblem[] = [];
  let errorCount = 0;
  const error = (path: string, message: string) => { errorCount++; problems.push({ path: safe(path), message: safe(message), severity: "error" }); };
  const warn = (path: string, message: string) => problems.push({ path: safe(path), message: safe(message), severity: "warning" });
  if (Buffer.byteLength(text, "utf8") > MAX_WORKFLOW_BYTES) { error("$", "workflow exceeds byte limit"); return { value: null, problems }; }
  // Bound parser work before construction. Conservative raw-source rejection is intentional.
  for (const line of text.split(/\r?\n/)) {
    if ((line.match(/^ */)?.[0].length ?? 0) > MAX_WORKFLOW_DEPTH * 2 || (line.match(/[\[{]/g)?.length ?? 0) > MAX_WORKFLOW_DEPTH) {
      error("$", "workflow exceeds nesting limit"); return { value: null, problems };
    }
  }
  let doc: ReturnType<typeof parseDocument>;
  try { doc = parseDocument(text, { version: "1.2", schema: "core", strict: true, uniqueKeys: true, merge: false, logLevel: "silent" }); }
  catch (cause) { error("$", `YAML parser refused input: ${String(cause)}`); return { value: null, problems }; }
  for (const issue of [...doc.errors, ...doc.warnings]) error("$", issue.message);
  const markers = [...text.matchAll(/^---(?:[ \t]|$)/gm)];
  const firstMarker = markers[0];
  const prelude = firstMarker && text.slice(0, firstMarker.index).split(/\r?\n/).every(line => /^\s*(?:#.*|%YAML\s+1\.2\s*)?$/.test(line));
  if (markers.length > (prelude ? 1 : 0)) error("$", "workflow must contain exactly one YAML document");
  if (problems.length) return { value: null, problems };
  let depthError = false;
  const scan = (node: YAMLNode | null | undefined, path: string, depth: number): void => {
    if (!node || depthError) return;
    if (depth > MAX_WORKFLOW_DEPTH) { depthError = true; error(path, "workflow exceeds nesting limit"); return; }
    if (isAlias(node) || node.anchor || node.tag) error(path, "aliases, anchors and tags are forbidden");
    if (isMap(node)) for (const item of node.items) {
      const key = isScalar(item.key) && typeof item.key.value === "string" ? item.key.value : "?";
      if (!isScalar(item.key) || typeof item.key.value !== "string") error(path, "mapping keys must be string scalars (plain or quoted)");
      scan(item.key as YAMLNode, sub(path, key), depth + 1);
      scan(item.value as YAMLNode, sub(path, key), depth + 1);
    }
    if (isSeq(node)) node.items.forEach((item, i) => scan(item as YAMLNode, `${path}[${i}]`, depth + 1));
  };
  scan(doc.contents, "$", 0);
  if (problems.length) return { value: null, problems };
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 0, mapAsMap: false }); }
  catch (cause) { error("$", `YAML conversion refused input: ${String(cause)}`); return { value: null, problems }; }
  if (!record(value)) { error("$", "workflow must be a mapping"); return { value: null, problems }; }
  const root = value;
  const ids = new Map<number, string>();
  const used = new Set<string>();
  const shape = (v: unknown, path: string, required: string[], optional: string[] = []): v is Record<string, unknown> => {
    if (!record(v)) { error(path, "must be a mapping"); return false; }
    for (const k of required) if (!Object.hasOwn(v, k)) error(field(path, k), "required field is missing");
    for (const k of Object.keys(v)) if (![...required, ...optional].includes(k)) error(field(path, k), `unknown field; allowed fields: ${[...required, ...optional].join(", ")}`);
    return true;
  };
  const string = (v: unknown, p: string) => { if (typeof v !== "string" || !v.trim()) error(p, "must be nonempty text"); };
  const name = (k: unknown, p: string, pattern = word) => { if (typeof k !== "string" || !pattern.test(k) || forbidden.has(k)) error(p, `name must match ${pattern.source} and cannot be free, declare, override, __proto__, constructor or prototype`); };
  const id = (v: unknown, p: string) => {
    if (!Number.isSafeInteger(v) || (v as number) < 1) { error(p, "id must be a positive integer"); return; }
    const prior = ids.get(v as number);
    if (prior) error(p, `id must be unique; first used at ${prior}`);
    else ids.set(v as number, p);
  };
  const entity = (v: unknown, p: string, required: string[], optional: string[] = []): v is Record<string, unknown> => {
    if (!shape(v, p, ["id", ...required], optional)) return false;
    id(own(v, "id"), field(p, "id"));
    return true;
  };
  const ref = (key: unknown, table: unknown, p: string, kind: string) => {
    if (typeof key !== "string" || !record(table) || !Object.hasOwn(table, key)) error(p, `must name a declared ${kind}`);
    else used.add(p + ":" + key);
  };
  const section = (key: unknown, p: string) => ref(key, root.sections, p, "section");
  const addition = (v: unknown, p: string) => {
    if (!entity(v, p, ["section", "priority"])) return;
    section(v.section, field(p, "section"));
    if (!Number.isSafeInteger(v.priority)) error(field(p, "priority"), "priority must be an integer");
  };
  shape(root, "$", ["format", "workflowId", "workflowVersion", "description", "useWhen", "root", "handlers", "progressRecord", "configuration", "sections", "orchestrator", "workflowArgs", "threadTypes", "focusAreas", "lifecycles"]);
  if (root.format !== 1) error("$.format", "format must be 1");
  if (!Number.isSafeInteger(root.workflowVersion) || (root.workflowVersion as number) < 1) error("$.workflowVersion", "version must be a positive integer");
  name(root.workflowId, "$.workflowId", kebab);
  for (const k of ["description", "useWhen", "progressRecord"]) if (Object.hasOwn(root, k)) string(root[k], field("$", k));
  if (Object.hasOwn(root, "handlers")) name(root.handlers, "$.handlers", /^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)?$/);
  const maps = ["configuration", "sections", "workflowArgs", "threadTypes", "focusAreas", "lifecycles"];
  for (const k of maps) if (!record(root[k])) error(field("$", k), "must be a mapping");
  if (!Array.isArray(root.orchestrator)) error("$.orchestrator", "must be a list");
  else root.orchestrator.forEach((v, i) => addition(v, `$.orchestrator[${i}]`));
  for (const [k, v] of entries(root.configuration)) {
    const p = sub("$.configuration", k);
    if (!configKey.test(k) || forbidden.has(k)) error(p, `configuration key must match ${configKey.source} and cannot be free, declare, override, __proto__, constructor or prototype`);
    if (entity(v, p, ["type", "description"], ["values"])) {
      if (typeof v.type !== "string" || !["boolean", "enum", "text"].includes(v.type)) error(field(p, "type"), "configuration type must be boolean, enum or text");
      string(v.description, field(p, "description"));
      if (v.type === "enum" && (!Array.isArray(v.values) || !v.values.length || !v.values.every(x => typeof x === "string"))) error(field(p, "values"), "enum requires a nonempty list of text values");
      if (v.type !== "enum" && v.values !== undefined) error(field(p, "values"), "values are allowed only for enum configuration");
    }
  }
  const documentIndexes = new Map<string, ReturnType<typeof indexWorkflowSections> | Error>();
  for (const [k, v] of entries(root.sections)) {
    const p = sub("$.sections", k);
    name(k, p, kebab);
    if (!entity(v, p, ["document", "heading", "description"])) continue;
    for (const f of ["document", "heading", "description"]) string(v[f], field(p, f));
    if (typeof v.document !== "string" || !kebab.test(v.document)) { error(field(p, "document"), `document name must match ${kebab.source}`); continue; }
    try {
      let index = documentIndexes.get(v.document);
      if (!index) {
        try {
          const source = providers.document(v.document);
          if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) throw Error("document must be text within the byte limit");
          index = indexWorkflowSections(source);
        } catch (cause) { index = cause instanceof Error ? cause : Error(String(cause)); }
        documentIndexes.set(v.document, index);
      }
      if (index instanceof Error) throw index;
      const found = index(String(v.heading), false);
      if ("error" in found) error(field(p, "heading"), `section heading must occur exactly once: ${found.error}`);
    } catch (cause) { error(field(p, "document"), `document must be available as text from the provider: ${String(cause)}`); }
  }
  for (const [k, v] of entries(root.workflowArgs)) {
    const p = sub("$.workflowArgs", k); name(k, p);
    if (entity(v, p, ["type", "description"], ["values"])) {
      if (typeof v.type !== "string" || !["integer", "text", "enum", "list"].includes(v.type)) error(field(p, "type"), "argument type must be integer, text, enum or list");
      string(v.description, field(p, "description"));
    }
  }
  for (const [k, v] of entries(root.threadTypes)) {
    const p = sub("$.threadTypes", k); name(k, p);
    if (entity(v, p, ["description", "prompt"])) {
      string(v.description, field(p, "description"));
      if (!Array.isArray(v.prompt)) error(field(p, "prompt"), "must be a list");
      else v.prompt.forEach((a, i) => addition(a, `${p}.prompt[${i}]`));
    }
  }
  for (const [k, v] of entries(root.focusAreas)) {
    const p = sub("$.focusAreas", k); name(k, p);
    if (entity(v, p, ["class", "description", "definition", "charter"])) {
      if (typeof v.class !== "string" || !["design-triggering", "reviewer-only"].includes(v.class)) error(field(p, "class"), "focus class must be design-triggering or reviewer-only");
      string(v.description, field(p, "description")); section(v.definition, field(p, "definition")); addition(v.charter, field(p, "charter"));
    }
  }
  const lifecycles = root.lifecycles;
  ref(root.root, lifecycles, "$.root", "lifecycle");
  if (!entries(lifecycles).length) error("$.lifecycles", "one root lifecycle is required");
  const calls = new Map<string, string[]>();
  for (const [lk, lv] of entries(lifecycles)) {
    const initialErrors = errorCount;
    const lp = sub("$.lifecycles", lk); name(lk, lp);
    if (!entity(lv, lp, ["description", "initialState", "conditions", "guards", "triggers", "states"], ["anyState", "steps"])) continue;
    string(lv.description, field(lp, "description"));
    for (const k of ["conditions", "guards", "triggers", "states"]) if (!record(lv[k])) error(field(lp, k), "must be a mapping");
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
      if (depth > MAX_WORKFLOW_DEPTH) { error(p, "expression exceeds nesting limit"); return; }
      if (typeof v === "string") {
        if (!conditionNames.has(v) && !guardNames.has(v)) error(p, "expression must name a declared condition or guard");
        else { usedLocal.add(v); if (guardNames.has(v)) refs.push(v); }
      } else if (record(v) && Object.keys(v).length === 1) {
        const op = Object.keys(v)[0]!; const part = v[op];
        if (op === "not") expr(part, field(p, op), refs, depth + 1);
        else if ((op === "and" || op === "or") && Array.isArray(part) && part.length >= 2) part.forEach((e, i) => expr(e, `${p}.${op}[${i}]`, refs, depth + 1));
        else error(p, "guard expression must name a declared condition or guard, or use { not: expr }, { and: [expr, expr, ...] } or { or: [expr, expr, ...] }");
      } else error(p, "guard expression must name a declared condition or guard, or use { not: expr }, { and: [expr, expr, ...] } or { or: [expr, expr, ...] }");
    };
    for (const [n, v] of entries(lv.guards)) {
      const p = sub(field(lp, "guards"), n); name(n, p);
      if (conditionNames.has(n)) error(p, "guard and condition share a name");
      if (entity(v, p, ["description", "expr"])) {
        string(v.description, field(p, "description")); const refs: string[] = [];
        expr(v.expr, field(p, "expr"), refs, 0); guardEdges.set(n, refs);
      }
    }
    const cyclic = (graph: Map<string, string[]>, label: string) => {
      const visited = new Set<string>(), active = new Set<string>();
      const walk = (k: string): void => {
        if (active.has(k)) { error(label, `guard expressions must not contain a cycle at ${k}`); return; }
        if (visited.has(k)) return;
        visited.add(k); active.add(k);
        for (const next of graph.get(k) ?? []) walk(next);
        active.delete(k);
      };
      for (const k of graph.keys()) walk(k);
    };
    cyclic(guardEdges, field(lp, "guards"));
    const completed = new Set<string>();
    if (lv.steps !== undefined && !record(lv.steps)) error(field(lp, "steps"), "must be a mapping");
    for (const [n, v] of entries(lv.steps)) {
      const p = sub(field(lp, "steps"), n); name(n, p);
      if (!entity(v, p, ["description", "attachTo", "when", "section", "completedBy"])) continue;
      string(v.description, field(p, "description")); section(v.section, field(p, "section"));
      ref(v.attachTo, lv.states, field(p, "attachTo"), "state"); ref(v.completedBy, lv.triggers, field(p, "completedBy"), "trigger");
      if (typeof v.completedBy === "string") completed.add(v.completedBy);
      if (!record(v.when) || typeof v.when.key !== "string") error(field(p, "when"), "step condition must be { key, equals: value }, { key, in: [values] } or { key, present: true }");
      else {
        ref(v.when.key, root.configuration, field(p, "when.key"), "configuration key");
        if (!(Object.keys(v.when).length === 2 && (Object.hasOwn(v.when, "equals") || Array.isArray(v.when.in) || v.when.present === true))) error(field(p, "when"), "step condition must be { key, equals: value }, { key, in: [values] } or { key, present: true }");
      }
    }
    const transitions = (on: unknown, p: string, from: string[]) => {
      if (!record(on)) { error(p, "on must be a mapping"); return; }
      for (const [trigger, branches] of entries(on)) {
        const tp = sub(p, trigger); name(trigger, tp); ref(trigger, lv.triggers, tp, "trigger"); usedTriggers.add(trigger);
        if (completed.has(trigger)) error(tp, "completion trigger cannot appear in on");
        if (!Array.isArray(branches) || !branches.length) { error(tp, "branches must be a nonempty list"); continue; }
        branches.forEach((branch, i) => {
          const bp = `${tp}[${i}]`;
          if (!record(branch)) { error(bp, "branch must be a mapping"); return; }
          const isElse = Object.hasOwn(branch, "else");
          if (!entity(branch, bp, isElse ? ["else"] : ["to"], isElse ? [] : ["when"])) return;
          if (isElse) {
            if (i !== branches.length - 1 || branches.length === 1) error(bp, "else must be last after a guarded branch");
            ref(branch.else, lv.states, field(bp, "else"), "state");
          } else {
            ref(branch.to, lv.states, field(bp, "to"), "state");
            if (branches.length > 1 && !Object.hasOwn(branch, "when")) error(field(bp, "when"), "multiple branches require when naming a declared guard or condition, except a final else");
            if (branch.when !== undefined) {
              if (typeof branch.when !== "string" || (!guardNames.has(branch.when) && !conditionNames.has(branch.when))) error(field(bp, "when"), "when must name a declared guard or condition");
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
      if (v.terminal !== undefined && typeof v.terminal !== "boolean") error(field(p, "terminal"), "must be boolean");
      if (v.terminal === true && (v.on !== undefined || v.call !== undefined)) error(p, "terminal state cannot have on or call");
      if (v.call !== undefined) {
        if (typeof v.call !== "string") error(field(p, "call"), "call must be a lifecycle name as text");
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
        if (!forward.has(n)) error(sub(field(lp, "states"), n), "state must be reachable from initialState by ordinary transitions");
        if (!terminal.has(n) && !backward.has(n)) error(sub(field(lp, "states"), n), "non-terminal state needs an ordinary transition path to a terminal state");
      }
    }
    if (errorCount === initialErrors)
      for (const k of ["triggers", "conditions", "guards"]) for (const [n] of entries(lv[k])) if (!(k === "triggers" ? usedTriggers.has(n) || completed.has(n) : usedLocal.has(n))) warn(sub(field(lp, k), n), k === "triggers" ? "trigger is unused; reference it in a transition or step" : `${k.slice(0, -1)} is unused; reference it in a guard or transition`);
  }
  const graph = new Map(entries(lifecycles).map(([k]) => [k, calls.get(k) ?? []]));
  const reachable = new Set<string>(), active = new Set<string>();
  const visitCall = (k: string) => {
    if (active.has(k)) { error("$.lifecycles", `lifecycle calls must not contain a cycle at ${k}`); return; }
    if (reachable.has(k)) return;
    reachable.add(k); active.add(k);
    for (const next of graph.get(k) ?? []) if (graph.has(next)) visitCall(next);
    active.delete(k);
  };
  if (typeof root.root === "string" && graph.has(root.root)) {
    visitCall(root.root);
    for (const k of graph.keys()) if (!reachable.has(k)) error(sub("$.lifecycles", k), "lifecycle is not called from root");
  }
  if (typeof root.handlers === "string" && /^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)?$/.test(root.handlers)) {
    try { for (const missing of checkHandlerExports(providers.handlerSource(root.handlers))) error("$.handlers", `declared handler export form missing or unsupported for ${missing}. This check reads the declared form only, so a crafted file can pass it`); }
    catch (cause) { error("$.handlers", `handler source must be available as text from the provider: ${String(cause)}`); }
  }
  return { value: errorCount ? null : root, problems };
}
