import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function checkRecordJobs(text: string) {
  assert.match(text, /permissions:\n  contents: read/);
  assert.match(text, /check_name: Node 22/);
  assert.match(text, /check_name: Node 24/);
  const jobs = text.split("\n  record-macos:");
  assert.equal(jobs.length, 2);
  assert.match(jobs[0]!, /runs-on: ubuntu-latest/);
  assert.match(jobs[0]!, /name: Unit tests and patch coverage/);
  const selections = jobs[1]!.split("\n  record-windows:");
  assert.equal(selections.length, 2);
  for (const [index, os, selection] of [[0, "macos-latest", "all"], [1, "windows-latest", "windows"]] as const) {
    const block = selections[index]!;
    assert.match(block, new RegExp(`runs-on: ${os}`));
    assert.match(block, /timeout-minutes: 15/);
    assert.match(block, /node: \['22\.23\.1', '24\.18\.0'\]/);
    assert.match(block, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
    assert.match(block, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
    assert.match(block, /run: npm ci --ignore-scripts/);
    assert.match(block, /run: node verification\/record-test-roster\.mjs\n/);
    assert.match(block, new RegExp(`run: node verification/record-test-roster.mjs --run ${selection}`));
    assert.doesNotMatch(block, /secrets\.|npm test|id-token:|^\s+permissions:/m);
  }
}
function checkRecordCiDescriptions(agents: string, reference: string, workflow: string) {
  assert.match(agents, /CI runs five Linux checks and two record-tool job matrices/);
  assert.match(agents, /A manual dispatch runs the same checks and job matrices/);
  assert.match(agents, /Record-tool tests create disposable folders.*mkdtemp.*os\.tmpdir\(\)/);
  for (const text of [agents, reference]) {
    assert.match(text, /canonical Windows marker is `\/\/ record-tool-test: windows`/);
    assert.match(text, /allow an empty suffix/);
    assert.match(text, /at least one non-skipped test/);
    assert.match(text, /That test must run on Windows/);
  }
  const header = workflow.split("\nname: CI")[0]!;
  assert.match(header, /node verification\/record-test-roster\.mjs --run all.*record-macos/);
  assert.match(header, /node verification\/record-test-roster\.mjs --run windows.*record-windows/);
}

test("record-ci-descriptions agree with job scope, temporary folders, markers and execution rules", () => {
  const agents = readFileSync("AGENTS.md", "utf8");
  const reference = readFileSync("verification/README.md", "utf8");
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  checkRecordCiDescriptions(agents, reference, workflow);
  for (const [from, to] of [
    ["CI runs five Linux checks and two record-tool job matrices", "CI runs five checks"],
    ["A manual dispatch runs the same checks and job matrices", "A manual dispatch runs the same five"],
    ["Record-tool tests create disposable folders", "Other tests create disposable folders"],
    ["canonical Windows marker is", "Windows marker is"],
    ["allow an empty suffix", "require a non-empty suffix"],
    ["at least one non-skipped test", "at least one file"],
    ["That test must run on Windows", "That test may skip on Windows"],
  ]) {
    assert.ok(agents.includes(from!));
    assert.throws(() => checkRecordCiDescriptions(agents.replace(from!, to!), reference, workflow));
  }
  assert.throws(() => checkRecordCiDescriptions(agents, reference, workflow.replace("#   node verification/record-test-roster.mjs --run all", "#   omitted macOS command")));
  assert.throws(() => checkRecordCiDescriptions(agents, reference, workflow.replace("#   node verification/record-test-roster.mjs --run windows", "#   omitted Windows command")));
  checkRecordCiDescriptions(agents + "\nUnrelated prose.\n", reference, workflow);
});

test("record-ci-jobs keep pinned systems, actions, selections, and the Linux check interface", () => {
  const text = readFileSync(".github/workflows/ci.yml", "utf8");
  checkRecordJobs(text);
  for (const [from, to] of [["runs-on: macos-latest", "runs-on: ubuntu-latest"],
    ["--run windows", "--run all"], ["  record-macos:\n", "  record-macos:\n    permissions:\n      contents: write\n"], ["node: ['22.23.1', '24.18.0']", "node: ['22', '24']"],
    ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - name: Set up Node", "actions/checkout@v7\n      - name: Set up Node"],
  ]) {
    const boundary = text.indexOf("\njobs:");
    const jobs = text.slice(boundary);
    assert.ok(jobs.includes(from!));
    assert.throws(() => checkRecordJobs(text.slice(0, boundary) + jobs.replace(from!, to!)));
  }
});
