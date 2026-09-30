import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkHandlerExports, checkWorkflowVersion, findWorkflowSection, MAX_WORKFLOW_BYTES, REQUIRED_WORKFLOW_EVENTS, validateWorkflow, workflowFingerprint } from "../extension/workflow-validation.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/workflow/${name}`, import.meta.url)), "utf8");
const good = fixture("valid.yaml");
const handler = fixture("handler.ts.txt");
const providers = {
  document: (name: string) => { if (name !== "rules") throw Error(name); return fixture("rules.md"); },
  handlerSource: (name: string) => { if (name !== "test-handler") throw Error(name); return handler; },
};

test("one valid file resolves all definitions without executing its handler", () => {
  assert.match(handler, /throw new Error/);
  const result = validateWorkflow(good, providers);
  assert.equal(result.value?.workflowVersion, 1);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(checkHandlerExports(handler), []);
  assert.equal(REQUIRED_WORKFLOW_EVENTS.length, 6);
});

type Broken = { rule: string; from: string; to: string; path: string };
const cases = JSON.parse(fixture("invalid-cases.json")) as Broken[];
const expectedMessages = JSON.parse(fixture("expected-messages.json")) as Record<string, string>;
assert.deepEqual(Object.keys(expectedMessages).sort(), cases.map(c => c.rule).sort());
for (const example of cases) test(`${example.rule}: exact full problem list`, () => {
  assert.equal(good.split(example.from).length, 2, `${example.rule}: mutation must hit once`);
  const result = validateWorkflow(good.replace(example.from, example.to), providers);
  const severity = example.rule === "trigger unused" ? "warning" : "error";
  assert.deepEqual(result.problems, [{ path: example.path, message: expectedMessages[example.rule], severity }]);
  assert.equal(result.value === null, severity === "error");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("handler export inspection accepts only literal export and never imports code", () => {
  for (const event of REQUIRED_WORKFLOW_EVENTS) {
    const changed = handler.replace(`"${event}"`, '"missing.event"');
    assert.ok(checkHandlerExports(changed).includes(event));
  }
  assert.deepEqual(checkHandlerExports(`/*\n${handler}\n*/`), [...REQUIRED_WORKFLOW_EVENTS]);
  assert.deepEqual(checkHandlerExports("export default {}"), [...REQUIRED_WORKFLOW_EVENTS]);
  assert.ok(checkHandlerExports(handler.replace("function rootStart()", "function other()")).includes("root.start"));
  assert.deepEqual(checkHandlerExports(handler.replace(/\n/g, "\r\n")), []);
  assert.deepEqual(checkHandlerExports(handler.replace('"root.start": rootStart,', '"root.start": rootStart,\n  "extra.event": extra,')), [...REQUIRED_WORKFLOW_EVENTS]);
  // The declared-form check does not prove JavaScript scope or meaning.
  assert.deepEqual(checkHandlerExports(handler.replace("function rootStart() {}", "if (false) {\nfunction rootStart() {}\n}")), []);
  const result = validateWorkflow(good, { ...providers, handlerSource: () => "export default {}" });
  assert.equal(result.problems.length, REQUIRED_WORKFLOW_EVENTS.length);
  assert.match(result.problems[0]!.message, /Declare root.start in export const handlers = \{.*text check cannot prove JavaScript meaning/);
});

test("section lookup skips fenced headings and stops at same-level heading", () => {
  const source = fixture("rules.md");
  const found = findWorkflowSection(source, "Rules");
  assert.ok("text" in found);
  assert.match(found.text, /Child rules/);
  assert.doesNotMatch(found.text, /Not part of Rules/);
  assert.deepEqual(findWorkflowSection(source, "Hidden"), { error: "heading is missing" });
  assert.deepEqual(findWorkflowSection(`${source}\n# Rules`, "Rules"), { error: "heading appears more than once" });
  assert.deepEqual(findWorkflowSection("<!--\n# Hidden\n-->\n# Rules\nActual", "Hidden"), { error: "heading is missing" });
  assert.deepEqual(findWorkflowSection(fixture("commented-rules.md"), "Rules"), { text: "Actual rules." });
  assert.deepEqual(findWorkflowSection(fixture("commented-rules.md"), "Inline"), { text: "A paragraph <!-- inline --> stays visible.\n<!--\n# Hidden\n-->\n" });
  assert.deepEqual(findWorkflowSection(fixture("commented-rules.md"), "Hidden"), { error: "heading is missing" });
  assert.deepEqual(findWorkflowSection("# Open <!--\n# Hidden\n-->\nText", "Open"), { text: "# Hidden\n-->\nText" });
});

test("repeated section references read and index each document once", () => {
  let reads = 0;
  const duplicate = good.replace("  rules: { id: 2, document: rules, heading: Rules, description: Step rules }", "  rules: { id: 2, document: rules, heading: Rules, description: Step rules }\n  more: { id: 18, document: rules, heading: Subrules, description: More rules }");
  const result = validateWorkflow(duplicate, { ...providers, document: name => { reads++; return providers.document(name); } });
  assert.deepEqual(result.problems, []);
  assert.equal(reads, 1);
});

test("anyState leaves a call state for a terminal state", () => {
  const input = good
    .replace("        section: rules\n        on:", "        section: rules\n        call: child\n        on:")
    .replace("    steps:\n", "    anyState:\n      finish:\n        - { id: 20, to: orphan }\n    steps:\n")
    .replace("      finished: { id: 16, description: Finished, terminal: true }", "      finished: { id: 16, description: Finished, terminal: true }\n      orphan: { id: 21, description: Orphan, terminal: true }")
    + "  child:\n    id: 18\n    description: Called lifecycle\n    initialState: complete\n    conditions: {}\n    guards: {}\n    triggers: {}\n    states:\n      complete: { id: 19, description: Complete, terminal: true }\n";
  assert.deepEqual(validateWorkflow(input, providers).problems, []);
  const callOnly = validateWorkflow(fixture("call-any-state.yaml"), providers);
  assert.equal(callOnly.value?.root, "change");
  assert.deepEqual(callOnly.problems, []);
});

test("YAML key types are checked before object conversion without library warnings", () => {
  const probes = [
    good.replace("  number: { id: 4", "  true: { id: 4"),
    good.replace("  number: { id: 4", "  ? [a]\n  : { id: 4"),
    good.replace("  number: { id: 4", '  true: { id: 4, type: integer, description: Number }\n  "true": { id: 18'),
  ];
  assert.deepEqual(validateWorkflow(probes[0]!, providers).problems, [{ path: '$["workflowArgs"]', message: "mapping keys must be string scalars (plain or quoted)", severity: "error" }]);
  assert.deepEqual(validateWorkflow(probes[1]!, providers).problems, [{ path: '$["workflowArgs"]', message: "mapping keys must be string scalars (plain or quoted)", severity: "error" }]);
  assert.deepEqual(validateWorkflow(probes[2]!, providers).problems, [{ path: '$["workflowArgs"]', message: "mapping keys must be string scalars (plain or quoted)", severity: "error" }]);
  const quoted = good.replace("  number: { id: 4", '  "number": { id: 4');
  assert.deepEqual(validateWorkflow(quoted, providers).problems, []);
});

test("wrong scalar types and unsafe handler path are refused before provider calls", () => {
  const variations = [
    ["workflowId: slate-track", "workflowId: [slate-track]", "$.workflowId"],
    ["type: boolean", "type: [boolean]", '$.configuration["workflow.draftPRs"].type'],
    ["class: reviewer-only", "class: [reviewer-only]", '$.focusAreas["security"].class'],
    ["handlers: test-handler", "handlers: ../outside", "$.handlers"],
  ];
  for (const [from, to, path] of variations) {
    let calls = 0;
    const result = validateWorkflow(good.replace(from!, to!), { ...providers, handlerSource: name => { calls++; return providers.handlerSource(name); } });
    assert.deepEqual(result.problems, [{ path: path!, message: path === "$.workflowId" ? "name must match ^[a-z]+(?:-[a-z]+)*$ and cannot be free, declare, override, __proto__, constructor or prototype" : path === "$.handlers" ? "name must match ^[a-z]+(?:-[a-z]+)*(?:\\.[a-z]+(?:-[a-z]+)*)?$ and cannot be free, declare, override, __proto__, constructor or prototype" : path!.endsWith(".type") ? "configuration type must be boolean, enum or text" : "focus class must be design-triggering or reviewer-only", severity: "error" }]);
    assert.equal(calls, path === "$.handlers" ? 0 : 1);
  }
});

test("call references keep their original scalar type", () => {
  const input = good.replace("section: rules\n        on:", "section: rules\n        call: [change]\n        on:");
  assert.deepEqual(validateWorkflow(input, providers).problems, [{ path: '$.lifecycles["change"].states["work"].call', message: "call must be a lifecycle name as text", severity: "error" }]);
});

test("a single YAML document accepts comments and a YAML directive before its start", () => {
  for (const prefix of ["# comment\n---\n", "%YAML 1.2\n---\n", "# comment\n%YAML 1.2\n---\n"]) {
    assert.deepEqual(validateWorkflow(prefix + good, providers).problems, []);
    assert.deepEqual(validateWorkflow(prefix + good + "\n---\nformat: 1", providers).problems.map(p => p.message.includes("exactly one YAML document")), [true]);
  }
});

test("trigger usage is independent of guard and condition usage", () => {
  const input = good.replace("      step_completed: { id: 13, description: Complete step }", "      step_completed: { id: 13, description: Complete step }\n      ready: { id: 18, description: Unused trigger }");
  assert.deepEqual(validateWorkflow(input, providers).problems, [{ path: '$.lifecycles["change"].triggers["ready"]', message: "Use this trigger in on, anyState, or a step completedBy.", severity: "warning" }]);
});

test("control characters from input and provider failures are escaped in every problem", () => {
  const result = validateWorkflow(good.replace("heading: Rules", "heading: Wrong\u001b"), { ...providers, document: () => { throw Error("bad\u001b\ninput"); } });
  assert.ok(result.problems.length);
  for (const p of result.problems) {
    assert.doesNotMatch(p.path + p.message, /[\x00-\x1f\x7f-\x9f]/);
    assert.match(p.message, /\\u001b/);
  }
});

test("size and nesting limits reject hostile YAML before conversion", () => {
  assert.match(validateWorkflow(" ".repeat(MAX_WORKFLOW_BYTES + 1), providers).problems[0]!.message, /131072 UTF-8 bytes/);
  assert.match(validateWorkflow("[".repeat(70) + "]".repeat(70), providers).problems[0]!.message, /64 opening/);
  assert.ok(validateWorkflow("a: &a [*a]", providers).problems.some(p => /anchors/.test(p.message)));
});

test("version check binds the exact file text and number", () => {
  const pin = { version: 1, fingerprint: "e68e8a55658098191cac3ad70bf3777ee0543ffde17ed4d0a01ce2eff1fb9856" };
  assert.equal(workflowFingerprint(good), pin.fingerprint);
  assert.equal(checkWorkflowVersion(good, 1, pin), true);
  assert.equal(checkWorkflowVersion(good + "\n", 1, pin), false);
  assert.equal(checkWorkflowVersion(good, 2, pin), false);
});
