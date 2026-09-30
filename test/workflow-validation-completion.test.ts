import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findWorkflowSection, MAX_GUARD_EXPRESSION_DEPTH, MAX_WORKFLOW_BYTES, validateWorkflow, workflowProblemRule, workflowRuleDescriptions } from "../extension/workflow-validation.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/workflow/${name}`, import.meta.url)), "utf8");
const valid = fixture("valid.yaml");
const source = readFileSync(fileURLToPath(new URL("../extension/workflow-validation.ts", import.meta.url)), "utf8");
const providers = { document: () => fixture("rules.md"), handlerSource: () => fixture("handler.ts.txt") };
const change = (from: string, to: string, input = valid) => {
  assert.equal(input.split(from).length, 2, `single mutation: ${from}`);
  return input.replace(from, to);
};
const observed = new Map<string, Set<string>>();
let activeTest: string | undefined;
const test = (name: string, run: () => void | Promise<void>) => nodeTest(name, async () => {
  activeTest = name;
  try { await run(); } finally { activeTest = undefined; }
});
const capture = (result: ReturnType<typeof validateWorkflow>["problems"], ruleOf = workflowProblemRule) => {
  if (activeTest) for (const problem of result) {
    const id = ruleOf(problem);
    if (id) {
      if (!observed.has(activeTest)) observed.set(activeTest, new Set());
      observed.get(activeTest)!.add(id);
    }
  }
  return result;
};
const problems = (text: string, provider = providers) => capture(validateWorkflow(text, provider).problems);
const one = (text: string, path: string, message: string, severity: "error" | "warning" = "error", provider = providers) => {
  assert.deepEqual(problems(text, provider), [{ path, message, severity }]);
};

// This scan protects the registry boundary as well as the declared rule roster.
function escapedMessages(text: string): string[] {
  const tree = ts.createSourceFile("workflow-validation.ts", text, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["error", "warn"].includes(node.expression.text)) {
      const arg = node.arguments[1];
      const allowed = (value: ts.Node | undefined): boolean => !!value && (ts.isStringLiteral(value) && /^(M(?:[1-9]|[1-5][0-9])|T(?:[1-9]|1[0-3]))$/.test(value.text) ||
        ts.isConditionalExpression(value) && allowed(value.whenTrue) && allowed(value.whenFalse));
      if (!allowed(arg)) violations.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const accesses: string[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "problems") {
      const parent = node.parent;
      const allowed = (ts.isVariableDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node ||
        ts.isShorthandPropertyAssignment(parent) && parent.name === node ||
        ts.isPropertyAccessExpression(parent) && parent.name.text === "length" ||
        ts.isPropertyAccessExpression(parent) && parent.name.text === "push" &&
          ts.isCallExpression(parent.parent) && parent.parent.expression === parent && parent.parent.arguments.length === 1 && parent.parent.arguments[0]?.getText(tree) === "problem";
      if (!allowed) violations.push(`unreviewed problem access: ${parent.getText(tree)}`);
      accesses.push(parent.getText(tree));
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.some(p => p.name?.getText(tree) === "message") &&
        node.properties.some(p => p.name?.getText(tree) === "severity") &&
        !node.getText(tree).includes("safe(renderRule(rule, echo(a), echo(b)))")) violations.push(`direct problem construction: ${node.getText(tree)}`);
    ts.forEachChild(node, inspect);
  };
  inspect(tree);
  if (accesses.filter(a => a === "problems.push").length !== 1) violations.push("single problem writer required");
  if ([...text.matchAll(/issue\.message/g)].length !== 1) violations.push("raw parser message outside adapter");
  return violations;
}

test("workflow guidance examples stay valid and wrong examples retain their stated problems", () => {
  const guide = readFileSync(fileURLToPath(new URL("../docs/workflow-guidance.md", import.meta.url)), "utf8");
  const examples = new Map([...guide.matchAll(/<!-- workflow-example: ([a-z-]+) -->\s*```yaml\n([\s\S]*?)\n```/g)].map(match => [match[1]!, match[2]!]));
  const expected = ["complete", "format", "wrong-placeholder", "correct-placeholder", "identity", "declarations", "enum", "sections", "prompts", "guard", "transition", "wrong-else", "correct-else", "step", "wrong-step", "handler", "usage"];
  assert.deepEqual([...examples.keys()], expected);
  const handler = guide.match(/## Handler declaration[\s\S]*?```typescript\n([\s\S]*?)\n```/);
  assert.ok(handler, "handler source example");
  const guideProviders = { document: (name: string) => { assert.equal(name, "rules"); return "# Rules\nStep rules\n"; },
    handlerSource: (name: string) => { assert.equal(name, "test-handler"); return handler[1]! + "\n"; } };
  const sample = (name: string) => { const text = examples.get(name); assert.ok(text, name); return text; };
  const indent = (text: string, spaces: number) => text.split("\n").map(line => " ".repeat(spaces) + line).join("\n");
  const replace = (base: string, oldText: string, newText: string) => {
    assert.equal(base.split(oldText).length, 2, `unique replacement: ${oldText}`);
    return base.replace(oldText, newText);
  };
  const validExample = sample("complete") + "\n";
  assert.equal(validExample, valid, "the complete guide example matches the valid test fixture");
  assert.deepEqual(validateWorkflow(validExample, guideProviders).problems, []);
  const cases: [string, string, string, number][] = [
    ["format", "format: 1", "format: 1", 0],
    ["identity", "workflowId: slate-track\nworkflowVersion: 1", "workflowId: slate-track\nworkflowVersion: 1", 0],
    ["correct-placeholder", "description: Test workflow", sample("correct-placeholder"), 0],
    ["enum", "workflow.draftPRs: { id: 1, type: boolean, description: Open draft }", sample("enum"), 2],
    ["sections", sample("sections"), sample("sections"), 0],
    ["prompts", sample("prompts"), sample("prompts"), 0],
    ["transition", "on:\n  finish:\n    - { id: 15, to: finished, when: ready }", sample("transition"), 8],
    ["guard", sample("guard"), sample("guard"), 4],
    ["correct-else", "- { id: 15, to: finished, when: ready }", sample("correct-else"), 12],
    ["step", sample("step"), sample("step"), 8],
    ["handler", sample("handler"), sample("handler"), 0],
    ["usage", sample("usage"), sample("usage"), 10],
  ];
  // The declarations example contains two separate top-level mappings.
  const [config, args] = sample("declarations").split("\nworkflowArgs:\n");
  assert.ok(config && args);
  cases.push(["declarations configuration", config, config, 0], ["declarations arguments", "workflowArgs:\n" + args, "workflowArgs:\n" + args, 0]);
  for (const [label, before, after, spaces] of cases) {
    let input = replace(validExample, indent(before, spaces), indent(after, spaces));
    if (label === "enum") input = replace(input, "equals: true", "equals: red");
    assert.deepEqual(validateWorkflow(input, guideProviders).problems, [], label);
  }
  const wrong: [string, string, string, number, string, string][] = [
    ["wrong-placeholder", "description: Test workflow", sample("wrong-placeholder"), 0, "$.description", 'Placeholder {config:workflow.absent} must name a declared configuration key. Declared keys: "workflow.draftPRs".'],
    ["wrong-else", "- { id: 15, to: finished, when: ready }", sample("wrong-else"), 12, '$.lifecycles["change"].states["work"].on["finish"][0]', "else must be last after a guarded branch"],
    ["wrong-step", "when: { key: workflow.draftPRs, equals: true }", sample("wrong-step"), 8, '$.lifecycles["change"].steps["draft"].when', "Boolean step condition must use { key, equals: true or false }."],
  ];
  for (const [label, before, after, spaces, path, message] of wrong) {
    const input = replace(validExample, indent(before, spaces), indent(after, spaces));
    assert.deepEqual(validateWorkflow(input, guideProviders).problems, [{ path, message, severity: "error" }], label);
    assert.ok(guide.includes(`The error at \`${path}\` is \`${message}\``), `guide must show ${label} result`);
  }
});

test("each rule has a stable ID, an allowed form, a rendered sample, and a closed emission path", () => {
  const rules = workflowRuleDescriptions();
  const expected = [...Array.from({ length: 58 }, (_, i) => `M${i + 1}`), ...Array.from({ length: 13 }, (_, i) => `T${i + 1}`)];
  assert.deepEqual(rules.map(r => r.id), expected);
  for (const rule of rules) {
    assert.ok(rule.allowed.trim(), rule.id);
    if (!["M6", "M14", "M22"].includes(rule.id)) assert.ok(rule.sample.toLowerCase().includes(rule.allowed.toLowerCase()), rule.id);
    else {
      assert.match(rule.allowed, /without|not reserved/);
      assert.doesNotMatch(rule.allowed, /^(aliases|free, declare)/);
    }
  }
  assert.deepEqual(escapedMessages(source), []);
  assert.notDeepEqual(escapedMessages(source.replace('error("$", "M1")', 'error("$", "bypass")')), []);
  for (const write of ['problems.push({ path: "$", message: "bypass", severity: "error" })',
    'problems.unshift({ path: "$", message: "bypass", severity: "error" })',
    'problems.splice(0, 0, { path: "$", message: "bypass", severity: "error" })',
    'problems[0] = { path: "$", message: "bypass", severity: "error" }'])
    assert.notDeepEqual(escapedMessages(source.replace('error("$", "M1")', write)), [], write);
  assert.notDeepEqual(escapedMessages(source.replace('error("$", "M1")', 'const bypass = { path: "$", message: "bypass", severity: "error" }')), []);
  assert.notDeepEqual(escapedMessages(source.replace('issue.message', 'issue.message + issue.message')), []);
});

test("one document includes leading comments and directives but never ignores a second document", () => {
  for (const prefix of ["", "# comment\n---\n", "%YAML 1.2\n---\n"]) {
    assert.deepEqual(problems(prefix + valid), []);
    for (const marker of ["---\n", "...\n", "...\n---\n"]) one(prefix + valid + "\n" + marker + "format: 2\n", "$", "workflow must contain exactly one YAML document");
  }
  assert.deepEqual(problems(valid + "\n...\n"), []);
});

test("placeholders check configuration references and root entity-name form", () => {
  one(change("description: Test workflow", "description: '{config:workflow.absent}'"), "$.description", 'Placeholder {config:workflow.absent} must name a declared configuration key. Declared keys: "workflow.draftPRs".');
  for (const rootName of ["wrong-name", "Upper", "free", ""]) one(change("progressRecord: '{root:research_log}'", `progressRecord: '{root:${rootName}}'`), "$.progressRecord", `Root placeholder {root:${rootName}} must use an entity name using lower-case words separated by _. Reserved names: free, declare, override, __proto__, constructor, prototype.`);
  assert.deepEqual(problems(change("description: Test workflow", "description: '{config:workflow.draftPRs} {root:other_name}'")), []);
  const doc = { ...providers, document: () => "# Rules\n{config:workflow.absent}\n" };
  assert.deepEqual(problems(valid, doc), [
    { path: '$.sections["rules"].heading', message: 'Placeholder {config:workflow.absent} in document "rules" must name a declared configuration key. Declared keys: "workflow.draftPRs".', severity: "error" },
  ]);
  one(change("description: Test workflow", "description: '{root:research_log'"), "$.description", "Close placeholder {root:research_log with } to use {config:key} or {root:name}.");
  one(change("description: Test workflow", "description: '{config:workflow.draftPRs'"), "$.description", "Close placeholder {config:workflow.draftPRs with } to use {config:key} or {root:name}.");
  one(change("description: Test workflow", "description: |-\n  {root:x\n  next line with text"), "$.description", "Close placeholder {root:x with } to use {config:key} or {root:name}.");
});

test("enum definitions and workflow arguments check unique and nonempty values", () => {
  const config = change("type: boolean, description: Open draft", "type: enum, values: [red, blue], description: Open draft");
  const enumInput = change("equals: true", "equals: red", config);
  assert.deepEqual(problems(enumInput), []);
  one(change("values: [red, blue]", "values: [red, red]", enumInput), '$.configuration["workflow.draftPRs"].values', "Enum values must be nonempty, unique text values.");
  one(change("values: [red, blue]", "values: ['', red]", enumInput), '$.configuration["workflow.draftPRs"].values', "Enum values must be nonempty, unique text values.");
  one(change("type: integer, description: Number", "type: enum, description: Number"), '$.workflowArgs["number"].values', "Enum argument requires a nonempty list of text values.");
  one(change("type: integer, description: Number", "type: integer, values: [red], description: Number"), '$.workflowArgs["number"].values', "Values are allowed only for enum arguments.");
  assert.deepEqual(problems(change("type: integer, description: Number", "type: enum, values: [red], description: Number")), []);
});

test("step conditions enforce configuration type, value membership, and exact predicate shape", () => {
  const p = '$.lifecycles["change"].steps["draft"].when';
  one(change("equals: true", "equals: red"), p + ".equals", "Boolean step equals must be true or false.");
  one(change("equals: true", "present: true"), p, "Boolean step condition must use { key, equals: true or false }.");
  const text = change("type: boolean, description: Open draft", "type: text, description: Open draft");
  one(text, p, "Text step condition must use { key, present: true }.");
  assert.deepEqual(problems(change("equals: true", "present: true", text)), []);
  const enumInput = change("type: boolean, description: Open draft", "type: enum, values: [red, blue], description: Open draft");
  one(enumInput, p + ".equals", 'Enum step equals must be a declared enum value. Declared values: "red", "blue".');
  one(change("equals: true", "in: [red, green]", enumInput), p + ".in", 'Enum step in must be a nonempty list of declared enum values. Declared values: "red", "blue".');
  one(change("equals: true", "in: []", enumInput), p + ".in", 'Enum step in must be a nonempty list of declared enum values. Declared values: "red", "blue".');
  one(change("equals: true", "present: true", enumInput), p, "Enum step condition must use { key, equals: value } or { key, in: [values] }.");
  assert.deepEqual(problems(change("equals: true", "in: [red, blue]", enumInput)), []);
  one(change("equals: true", "equals: true, in: [red]"), p, "step condition must be { key, equals: value }, { key, in: [values] } or { key, present: true }");
});

test("long declared keys, placeholders, and provider causes stay bounded in each problem", () => {
  const names = Array.from({ length: 8 }, (_, i) => `a.${String.fromCharCode(97 + i)}${"a".repeat(14000)}`);
  const declarations = names.map((key, i) => `  ? ${key}\n  : { id: ${i + 18}, type: boolean, description: Extra }`).join("\n");
  const input = change("configuration:\n", `configuration:\n${declarations}\n`);
  const output = problems(change("description: Test workflow", "description: '{config:missing}'", input));
  assert.equal(output.length, 1);
  assert.ok(output[0]!.message.length < 1100);
  assert.match(output[0]!.message, /\.\.\.\[truncated\]/);
  assert.ok(output.every(item => item.path.length < 1100));
  const values = Array.from({ length: 8 }, (_, i) => `v${i}${"v".repeat(14000)}`);
  const withEnum = change("type: boolean, description: Open draft", `type: enum, values: [${values.join(", ")}], description: Open draft`);
  const enumOutput = problems(withEnum);
  assert.equal(enumOutput.length, 1);
  assert.ok(enumOutput[0]!.message.length < 1100);
  assert.match(enumOutput[0]!.message, /\.\.\.\[truncated\]/);
  const huge = "a".repeat(MAX_WORKFLOW_BYTES);
  const incomplete = problems(valid, { ...providers, document: () => `# Rules\n{root:${huge.slice(0, 120000)}\nnext line ${huge.slice(0, 8000)}` });
  assert.equal(incomplete.length, 1);
  assert.ok(incomplete[0]!.message.length < 1200);
  assert.doesNotMatch(incomplete[0]!.message, /next line/);
  assert.match(incomplete[0]!.message, /\.\.\.\[truncated\]/);
  const cause = problems(valid, { ...providers, document: () => { throw Error(huge); } });
  assert.ok(cause[0]!.message.length < 1300);
  assert.match(cause[0]!.message, /\.\.\.\[truncated\]/);
  const longPath = problems(change("  rules: { id: 2", `  ? A${"a".repeat(2000)}\n  : { id: 2`));
  assert.ok(longPath.some(item => item.path.includes("...[truncated]")));
  assert.ok(longPath.every(item => item.path.length < 1100));
  const pair = "\u{1f642}";
  const boundary = problems(valid, { ...providers, document: () => { throw Error("a".repeat(1016) + pair + "b"); } });
  assert.equal(boundary.length, 1);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(boundary[0]!.message));
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(boundary[0]!.message));
  assert.match(boundary[0]!.message, /\.\.\.\[truncated\]/);
});

test("long configuration and enum lists stay bounded in problems", () => {
  const keys = Array.from({ length: 12 }, (_, i) => `workflow.key${i}`);
  const additions = keys.map((key, i) => `  ${key}: { id: ${i + 18}, type: boolean, description: Extra }`).join("\n");
  const withKeys = change("configuration:\n", `configuration:\n${additions}\n`);
  const output = problems(change("description: Test workflow", "description: '{config:workflow.missing}'", withKeys));
  assert.equal(output.length, 1);
  assert.match(output[0]!.message, /"workflow\.key7" \(and 5 more\)/);
  assert.doesNotMatch(output[0]!.message, /workflow\.key8/);
  const values = Array.from({ length: 12 }, (_, i) => `value${i}`);
  const withEnum = change("type: boolean, description: Open draft", `type: enum, values: [${values.join(", ")}], description: Open draft`);
  const enumOutput = problems(change("equals: true", "equals: absent", withEnum));
  assert.equal(enumOutput.length, 1);
  assert.match(enumOutput[0]!.message, /"value7" \(and 4 more\)/);
  assert.doesNotMatch(enumOutput[0]!.message, /value8/);
  const escaped = Array.from({ length: 12 }, (_, i) => `${i}${'"\\\u0001'.repeat(80)}`);
  const quoted = change("type: boolean, description: Open draft", `type: enum, values: [${escaped.map(value => JSON.stringify(value)).join(", ")}], description: Open draft`);
  const escapedResult = problems(change("equals: true", "equals: absent", quoted));
  const first = JSON.stringify(escaped[0]).slice(0, 96);
  assert.deepEqual(escapedResult, [{ path: '$.lifecycles["change"].steps["draft"].when.equals',
    message: `Enum step equals must be a declared enum value. Declared values: ${first}...[truncated] (and 11 more).`, severity: "error" }]);
  assert.equal(escapedResult[0]!.message.match(/\.\.\.\[truncated\]/g)?.length, 1);
});

test("completion call reference type", () => {
  one(change("section: rules\n        on:", "section: rules\n        call: [change]\n        on:"),
    '$.lifecycles["change"].states["work"].call', "call must be a lifecycle name as text");
});

test("branch ordering requires guarded branches before one final else", () => {
  const base = "- { id: 15, to: finished, when: ready }";
  const path = '$.lifecycles["change"].states["work"].on["finish"]';
  const good = change(base, base + "\n            - { id: 18, else: finished }");
  assert.deepEqual(problems(good), []);
  one(change(base, "- { id: 15, else: finished }"), `${path}[0]`, "else must be last after a guarded branch");
  one(change(base, "- { id: 15, else: finished }\n            - { id: 18, to: finished, when: ready }"), `${path}[0]`, "else must be last after a guarded branch");
  one(change(base, base + "\n            - { id: 18, to: finished }"), `${path}[1].when`, "multiple branches require when naming a declared guard or condition, except a final else");
});

test("unused conditions and guards report the exact warning path and allowed use", () => {
  one(change("done: { id: 10, description: Work done }", "done: { id: 10, description: Work done }\n      extra: { id: 18, description: Not used }"), '$.lifecycles["change"].conditions["extra"]', "Use this condition in a guard expression or branch when.", "warning");
  const other = change("when: ready }", "when: done }");
  one(other, '$.lifecycles["change"].guards["ready"]', "Use this guard in another guard expression or branch when.", "warning");
});

test("unreachable lifecycle and unsupported handler exports give actionable paths", () => {
  const added = valid + "  unused:\n    id: 18\n    description: Uncalled lifecycle\n    initialState: finish\n    conditions: {}\n    guards: {}\n    triggers: {}\n    states:\n      finish: { id: 19, description: Done, terminal: true }\n";
  one(added, '$.lifecycles["unused"]', "Add a call-state path from the root lifecycle to this lifecycle, or remove it.");
  const errors = problems(valid, { ...providers, handlerSource: () => "export default {}" });
  assert.deepEqual(errors.map(e => e.path), Array(6).fill("$.handlers"));
  for (const [index, event] of ["root.start", "root.ownerChanged", "root.close", "dispatch.validate", "dispatch.prepare", "episode.received"].entries()) {
    assert.equal(errors[index]!.message, `Declare ${event} in export const handlers = { with a two-space-indented quoted key and a function name. End every entry, including the last, with a comma. Close with a closing brace and semicolon on its own line and define function name( at column zero. Use LF or CRLF and at most 131072 UTF-8 bytes. This text check cannot prove JavaScript meaning.`);
    assert.equal(errors[index]!.severity, "error");
  }
});

test("empty YAML streams retain parser diagnostics", () => {
  const output = problems("%BOGUS flag\n");
  assert.equal(output.length, 2);
  assert.deepEqual(output.map(workflowProblemRule), ["M4", "M5"]);
  assert.match(output[0]!.message, /Parser BAD_DIRECTIVE: Use a valid YAML 1.2 directive. Unknown directive %BOGUS/);
});

test("parser diagnostics include cause, code and an allowed YAML form", () => {
  const cases = [
    ["format: 1", "format: 1\nformat: 1", "DUPLICATE_KEY"],
    ["description: Test workflow", "description: !wrong Test workflow", "TAG_RESOLVE_FAILED"],
    ["description: Test workflow", "description:\n\twrong", "TAB_AS_INDENT"],
    ["format: 1", "%BOGUS flag\n---\nformat: 1", "BAD_DIRECTIVE"],
  ];
  for (const [from, to, code] of cases) {
    const result = problems(change(from!, to!));
    assert.ok(result.length, code);
    assert.equal(result[0]?.path, "$", code);
    assert.equal(result[0]?.severity, "error", code);
    assert.match(result[0]!.message, /Use one valid YAML 1\.2 document with unique keys, no aliases, anchors or tags/);
    assert.ok(result[0]!.message.includes(`Parser ${code}:`), `${code}: ${result[0]!.message}`);
  }
  one(change("description: Test workflow", "description: { <<: { key: value } }"), '$["description"]["<<"]', "Write this mapping without the merge key <<.");
});

test("provider refusal, non-text result and byte overflow are reported at their fields", () => {
  const path = '$.sections["rules"].document';
  one(valid, path, "Document provider must return readable text for rules. Check the document name and read access. Provider error: Error: denied.", "error", { ...providers, document: () => { throw Error("denied"); } });
  for (const value of [42, "a".repeat(MAX_WORKFLOW_BYTES + 1)]) one(valid, path, "Document provider must return text of at most 131072 UTF-8 bytes for rules.", "error", { ...providers, document: () => value as string });
  one(valid, "$.handlers", "Handler provider must return readable text for test-handler. Check the handler name and read access. Provider error: Error: denied.", "error", { ...providers, handlerSource: () => { throw Error("denied"); } });
  one(valid, path, "Document provider must return readable text for rules. Check the document name and read access. Provider error: Error: unprintable provider error.", "error", { ...providers, document: () => { throw Object.create(null); } });
  one(valid, "$.handlers", "Handler provider must return readable text for test-handler. Check the handler name and read access. Provider error: unprintable provider error.", "error", { ...providers, handlerSource: () => { throw Object.create(null); } });
  const repeated = { ...providers, document: () => "# Rules\nFirst\n# Rules\nAgain" };
  one(valid, '$.sections["rules"].heading', "section heading must occur exactly once: heading appears more than once", "error", repeated);
});

test("handler source byte boundary reports the full declaration message", () => {
  const exact = fixture("handler.ts.txt") + " ".repeat(MAX_WORKFLOW_BYTES - Buffer.byteLength(fixture("handler.ts.txt")) - 2) + "é";
  assert.equal(Buffer.byteLength(exact), MAX_WORKFLOW_BYTES);
  assert.equal(exact.length, MAX_WORKFLOW_BYTES - 1);
  assert.deepEqual(problems(valid, { ...providers, handlerSource: () => exact }), []);
  const output = problems(valid, { ...providers, handlerSource: () => exact + "é" });
  assert.equal(output.length, 6);
  assert.deepEqual(output.map(workflowProblemRule), Array(6).fill("M57"));
  for (const [index, event] of ["root.start", "root.ownerChanged", "root.close", "dispatch.validate", "dispatch.prepare", "episode.received"].entries())
    assert.deepEqual(output[index], { path: "$.handlers", message: `Declare ${event} in export const handlers = { with a two-space-indented quoted key and a function name. End every entry, including the last, with a comma. Close with a closing brace and semicolon on its own line and define function name( at column zero. Use LF or CRLF and at most 131072 UTF-8 bytes. This text check cannot prove JavaScript meaning.`, severity: "error" });
});

test("used sections scan a document once across repeated and nested headings", () => {
  const name = (i: number) => `s-${String.fromCharCode(97 + Math.floor(i / 676), 97 + Math.floor(i / 26) % 26, 97 + i % 26)}`;
  const count = 1000;
  const sections = Array.from({ length: count }, (_, i) => `  ${name(i)}: { id: ${i + 100}, document: rules, heading: Rules, description: Extra }`).join("\n");
  const additions = Array.from({ length: count }, (_, i) => `  - { id: ${i + count + 100}, section: ${name(i)}, priority: 1 }`).join("\n");
  const input = change("  rules: { id: 2, document: rules, heading: Rules, description: Step rules }", `  rules: { id: 2, document: rules, heading: Rules, description: Step rules }\n${sections}`);
  const withAdditions = change("  - { id: 3, section: rules, priority: 1 }", `  - { id: 3, section: rules, priority: 1 }\n${additions}`, input);
  const doc = "# Rules\n" + "{config:absent}\n".repeat(7500);
  const output = problems(withAdditions, { ...providers, document: () => doc });
  assert.equal(output.length, 7500);
  assert.ok(output.every(item => item.path === '$.sections["rules"].heading'));
  const nested = change("  rules: { id: 2, document: rules, heading: Rules, description: Step rules }", "  rules: { id: 2, document: rules, heading: Rules, description: Step rules }\n  child: { id: 18, document: rules, heading: Child, description: Child rules }");
  const used = change("  - { id: 3, section: rules, priority: 1 }", "  - { id: 3, section: rules, priority: 1 }\n  - { id: 19, section: child, priority: 1 }", nested);
  const overlapping = problems(used, { ...providers, document: () => "# Rules\n{config:before}\n## Child\n{config:inside}\n# After\n{config:outside}\n" });
  assert.deepEqual(overlapping.map(item => item.message.match(/\{config:[^}]+\}/)?.[0]), ["{config:before}", "{config:inside}"]);
  assert.equal(overlapping.length, 2);
});

test("section placeholders scan once for many additions", () => {
  const additions = Array.from({ length: 1000 }, (_, i) => `  - { id: ${i + 18}, section: rules, priority: 1 }`).join("\n");
  const input = change("  - { id: 3, section: rules, priority: 1 }", `  - { id: 3, section: rules, priority: 1 }\n${additions}`);
  const result = problems(input, { ...providers, document: () => "# Rules\n" + "{config:absent}\n".repeat(32) });
  assert.equal(result.length, 32);
  assert.ok(result.every(p => p.path === '$.sections["rules"].heading'));
});

test("unused sections do not copy full document text", () => {
  const extra = Array.from({ length: 500 }, (_, i) => `  unused-${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}: { id: ${i + 18}, document: rules, heading: Rules, description: Extra }`).join("\n");
  const input = change("  rules: { id: 2, document: rules, heading: Rules, description: Step rules }", `  rules: { id: 2, document: rules, heading: Rules, description: Step rules }\n${extra}`);
  assert.deepEqual(problems(input, { ...providers, document: () => "# Rules\n" + "x".repeat(125000) }), []);
});

test("long spaced heading is indexed without repeated backtracking", () => {
  assert.match(source, /while \(level < headingLine\.length && headingLine\[level\] === "#"\) level\+\+/);
  const start = performance.now();
  const found = findWorkflowSection("# a" + " ".repeat(100000) + "b\nbody", "a" + " ".repeat(100000) + "b");
  assert.deepEqual(found, { text: "body" });
  assert.ok(performance.now() - start < 2000, "heading scan must stay bounded");
});

test("prose hyphens do not count as compact block markers", () => {
  const prose = Array.from({ length: 66 }, (_, i) => `${i}`).join(" - ");
  assert.deepEqual(problems(change("description: Test workflow", `description: ${prose}`)), []);
  assert.notEqual(problems(`  - ${prose}`)[0]?.message, workflowRuleDescriptions()[1]!.sample);
});

test("compact block nesting stops at the raw validator limit", () => {
  for (const marker of ["- ", "? "]) {
    one(marker.repeat(65) + "x", "$", workflowRuleDescriptions()[1]!.sample);
    assert.notEqual(problems(marker.repeat(64) + "x")[0]?.message, workflowRuleDescriptions()[1]!.sample);
  }
});

test("compact markers after a value indicator report the exact M2 message", () => {
  const allowed = "64 node levels, 128 leading spaces per line, or 64 opening [ or { characters and compact - or ? block markers combined per line (compact markers start the line content after indentation or a `: ` value indicator)";
  assert.equal(workflowRuleDescriptions()[1]!.allowed, allowed);
  const message = `Workflow nesting must not exceed ${allowed}.`;
  for (const marker of ["- ", "? "]) one("? k\n: " + marker.repeat(1000) + "x", "$", message);
});

test("resource exhaustion parser errors name the nesting correction", async () => {
  const input = "[\n".repeat(1100) + "x\n" + "]\n".repeat(1100);
  const actual = problems(input);
  assert.equal(actual.length, 1);
  assert.equal(actual[0]!.path, "$");
  assert.equal(actual[0]!.severity, "error");
  assert.match(actual[0]!.message, /^Use one valid YAML 1\.2 document with unique keys, no aliases, anchors or tags\. Parser RESOURCE_EXHAUSTION: Reduce workflow nesting to at most 64 node levels\. Maximum call stack size exceeded/);
  const target = "const diagnostics = 'empty' in docs ? [...docs.errors, ...docs.warnings] : docs.flatMap(parsed => [...parsed.errors, ...parsed.warnings]);";
  assert.equal(source.split(target).length, 2);
  const rewritten = source.replace(target, 'const diagnostics = [{ code: "RESOURCE_EXHAUSTION", message: "synthetic stack exhaustion" }];')
    .replace('from "yaml"', `from "${import.meta.resolve("yaml")}"`);
  const js = ts.transpileModule(rewritten, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`) as { validateWorkflow: typeof validateWorkflow };
  assert.deepEqual(module.validateWorkflow(valid, providers).problems, [{ path: "$", message: "Use one valid YAML 1.2 document with unique keys, no aliases, anchors or tags. Parser RESOURCE_EXHAUSTION: Reduce workflow nesting to at most 64 node levels. synthetic stack exhaustion", severity: "error" }]);
});

test("error paths and causes escape formatting and line separators", () => {
  const unsafe = "\u061c\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
  const output = problems(change("heading: Rules", `heading: 'Wrong${unsafe}'`), { ...providers, document: () => { throw Error(unsafe); } });
  assert.ok(output.length);
  for (const item of output) {
    assert.doesNotMatch(item.path + item.message, /[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    assert.match(item.message, /\\u061c/);
    for (const char of unsafe) assert.match(item.message, new RegExp(`\\\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
  }
});

test("safe integer limits apply to versions and priorities", () => {
  one(change("workflowVersion: 1", "workflowVersion: 9007199254740992"), "$.workflowVersion", "version must be a positive safe integer at most 9007199254740991");
  one(change("priority: 1", "priority: 9007199254740992"), "$.orchestrator[0].priority", "priority must be a safe integer at most 9007199254740991");
});

test("guard expression depth accepts 32 levels and rejects 33", () => {
  assert.equal(MAX_GUARD_EXPRESSION_DEPTH, 32);
  const nested = (count: number) => "{ not: ".repeat(count) + "done" + " }".repeat(count);
  assert.deepEqual(problems(change("expr: done", `expr: ${nested(32)}`)), []);
  one(change("expr: done", `expr: ${nested(33)}`), '$.lifecycles["change"].guards["ready"].expr' + ".not".repeat(33), "Guard expression depth must be at most 32 levels.");
});

test("parser and conversion exceptions report separate rule forms", async () => {
  const yamlUrl = import.meta.resolve("yaml");
  const injected = async (location: string, cause: string) => {
    const before = location === "parser" ? "try { docs = parseAllDocuments(" : "try { value = doc.toJS(";
    assert.equal(source.split(before).length, 2);
    const rewritten = source.replace(before, `try { throw Error("${cause}"); ${before.slice(6)}`)
      .replace('from "yaml"', `from "${yamlUrl}"`);
    const js = ts.transpileModule(rewritten, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`) as { validateWorkflow: typeof validateWorkflow; workflowProblemRule: typeof workflowProblemRule };
    return capture(module.validateWorkflow(valid, providers).problems, module.workflowProblemRule);
  };
  assert.deepEqual(await injected("parser", "synthetic parser refusal"), [{ path: "$", message: "Use one valid YAML 1.2 document. Parser refused input: Error: synthetic parser refusal.", severity: "error" }]);
  assert.deepEqual(await injected("conversion", "synthetic conversion refusal"), [{ path: "$", message: "Use one YAML 1.2 mapping without aliases, anchors or tags. Conversion failed: Error: synthetic conversion refusal.", severity: "error" }]);
});

test("empty lifecycles has one dedicated root-lifecycle error", () => {
  one(valid.slice(0, valid.indexOf("lifecycles:")) + "lifecycles: {}\n", "$.lifecycles", "one root lifecycle is required");
});

test("byte, indentation, opening delimiter and parsed-depth boundaries", () => {
  const limit = "Workflow text must be at most 131072 UTF-8 bytes.";
  assert.notEqual(problems("x".repeat(MAX_WORKFLOW_BYTES))[0]?.message, limit);
  one("x".repeat(MAX_WORKFLOW_BYTES + 1), "$", limit);
  assert.notEqual(problems(" ".repeat(128) + "x")[0]?.message, workflowRuleDescriptions()[1]?.sample);
  one(" ".repeat(129) + "x", "$", workflowRuleDescriptions()[1]!.sample);
  assert.notEqual(problems("[".repeat(64) + "]".repeat(64))[0]?.message, workflowRuleDescriptions()[1]?.sample);
  one("[".repeat(65) + "]".repeat(65), "$", workflowRuleDescriptions()[1]!.sample);
  const nested = (count: number) => "[\n".repeat(count) + "x\n" + "]\n".repeat(count);
  one(nested(64), "$", "workflow must be a mapping");
  one(nested(65), "$" + "[0]".repeat(65), workflowRuleDescriptions()[1]!.sample);
});

// Each table entry points to a single-rule mutation or an injected exception fixture.
// The roster rejects missing fixture names as well as missing or extra rule IDs.
const fixtureByRule: Record<string, string> = {
  M1: "test:byte, indentation, opening delimiter and parsed-depth boundaries",
  M2: "test:byte, indentation, opening delimiter and parsed-depth boundaries",
  M3: "test:parser and conversion exceptions report separate rule forms",
  M4: "case:repeated YAML key", M5: "case:multiple documents", M6: "case:YAML anchor",
  M7: "case:non-string mapping key", M8: "test:parser and conversion exceptions report separate rule forms",
  M9: "test:byte, indentation, opening delimiter and parsed-depth boundaries",
  M10: "case:steps mapping", M11: "case:missing field", M12: "case:unknown field",
  M13: "case:empty description", M14: "case:reserved name", M15: "case:id range",
  M16: "case:duplicate ID", M17: "case:root reference", M18: "case:priority",
  M19: "case:format", M20: "case:version", M21: "case:prompt shape",
  M22: "case:configuration key", M23: "case:bad configuration type",
  M24: "case:enum values missing", M25: "case:values on boolean",
  M26: "case:bad document name",
  M27: "test:provider refusal, non-text result and byte overflow are reported at their fields",
  M28: "case:heading missing",
  M29: "test:provider refusal, non-text result and byte overflow are reported at their fields",
  M30: "case:unknown document", M31: "case:argument type", M32: "case:focus class",
  M33: "test:empty lifecycles has one dedicated root-lifecycle error",
  M34: "test:guard expression depth accepts 32 levels and rejects 33",
  M35: "case:guard unknown", M36: "case:guard expression shape",
  M37: "case:condition guard namespace", M38: "case:guard cycle",
  M39: "case:step predicate", M40: "case:on mapping", M41: "case:step completion in on",
  M42: "case:branches empty", M43: "case:branch shape", M44: "case:else order",
  M45: "case:branch condition", M46: "case:guard reference",
  M47: "case:terminal flag", M48: "case:terminal on",
  M49: "test:completion call reference type",
  M50: "case:initial reachability", M51: "case:terminal path",
  M52: "case:trigger unused",
  M53: "test:unused conditions and guards report the exact warning path and allowed use",
  M54: "test:unused conditions and guards report the exact warning path and allowed use",
  M55: "case:call cycle",
  M56: "test:unreachable lifecycle and unsupported handler exports give actionable paths",
  M57: "test:unreachable lifecycle and unsupported handler exports give actionable paths",
  M58: "case:handler source",
  T1: "test:placeholders check configuration references and root entity-name form",
  T2: "test:placeholders check configuration references and root entity-name form",
  T3: "test:enum definitions and workflow arguments check unique and nonempty values",
  T4: "test:enum definitions and workflow arguments check unique and nonempty values",
  T5: "test:enum definitions and workflow arguments check unique and nonempty values",
  T6: "test:step conditions enforce configuration type, value membership, and exact predicate shape",
  T7: "test:step conditions enforce configuration type, value membership, and exact predicate shape",
  T8: "test:step conditions enforce configuration type, value membership, and exact predicate shape",
  T9: "test:step conditions enforce configuration type, value membership, and exact predicate shape",
  T10: "test:step conditions enforce configuration type, value membership, and exact predicate shape",
  T11: "test:step conditions enforce configuration type, value membership, and exact predicate shape",
  T12: "test:parser diagnostics include cause, code and an allowed YAML form",
  T13: "test:placeholders check configuration references and root entity-name form",
};

test("every validation rule has a named invalid fixture", () => {
  const cases = JSON.parse(fixture("invalid-cases.json")) as { rule: string; from: string; to: string; path: string }[];
  const legacy = new Map(cases.map(c => [c.rule, c]));
  const actualLegacy = new Map(cases.map(c => {
    const input = change(c.from, c.to);
    const output = validateWorkflow(input, {
      document: name => { if (name !== "rules") throw Error(name); return fixture("rules.md"); },
      handlerSource: name => { if (name !== "test-handler") throw Error(name); return fixture("handler.ts.txt"); },
    }).problems;
    assert.equal(output.length, 1, c.rule);
    assert.equal(output[0]?.path, c.path, c.rule);
    return [c.rule, workflowProblemRule(output[0]!)] as const;
  }));
  const legacyNames = new Set(cases.map(c => c.rule));
  const completionNames = new Set([...sourceOfThisTest().matchAll(/test\("([^"]+)"/g)].map(m => m[1]));
  assert.deepEqual(Object.keys(fixtureByRule).sort(), workflowRuleDescriptions().map(r => r.id).sort());
  for (const [rule, fixtureName] of Object.entries(fixtureByRule)) {
    const [kind, name] = fixtureName.split(":", 2);
    assert.ok(kind === "case" ? legacyNames.has(name!) && legacy.has(name!) && actualLegacy.get(name!) === rule :
      completionNames.has(name!) && observed.get(name!)?.has(rule), `${rule}: ${fixtureName} must emit ${rule}`);
  }
});

function sourceOfThisTest(): string {
  return readFileSync(fileURLToPath(import.meta.url), "utf8");
}
