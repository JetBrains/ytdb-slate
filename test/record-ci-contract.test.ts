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
    assert.doesNotMatch(block, /secrets\.|npm test|id-token:/);
  }
}
test("record-ci-jobs keep pinned systems, actions, selections, and the Linux check interface", () => {
  const text = readFileSync(".github/workflows/ci.yml", "utf8");
  checkRecordJobs(text);
  for (const [from, to] of [["runs-on: macos-latest", "runs-on: ubuntu-latest"],
    ["--run windows", "--run all"], ["node: ['22.23.1', '24.18.0']", "node: ['22', '24']"],
    ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - name: Set up Node", "actions/checkout@v7\n      - name: Set up Node"],
  ]) {
    assert.ok(text.includes(from!));
    assert.throws(() => checkRecordJobs(text.replace(from!, to!)));
  }
});
