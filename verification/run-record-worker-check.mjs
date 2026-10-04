import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const facts = (value) => value.slice(value.lastIndexOf("## Record call outcomes") + "## Record call outcomes\n".length).trim().split("\n").map((line) => JSON.parse(line));
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repo = realpathSync(resolve(process.argv[2] ?? dirname(fileURLToPath(new URL("../package.json", import.meta.url)))));
const lab = realpathSync(mkdtempSync(join(tmpdir(), "slate-record-worker-live-")));
if (lab === repo || lab.startsWith(repo + "/")) throw new Error("Scratch directory must be outside the checkout.");
const project = join(lab, "project"), agent = join(lab, "agent"), home = join(lab, "home");
for (const folder of [join(project, ".pi"), agent, home]) mkdirSync(folder, { recursive: true });
const model = { id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 };
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "record-fake": { api: "record-test-api", baseUrl: "http://127.0.0.1:9", apiKey: "offline-key", models: [model] } } }));
writeFileSync(join(project, ".pi", "slate.json"), JSON.stringify({ workerExtensions: [], cacheKeyEnabled: false, router: {
  models: { include: [], add: [{ model: "fixture", capabilityRating: 50, costRating: 50, effort: "off", preferredProvider: "record-fake", providers: { "record-fake": "offline" }, guidelines: [], cautions: [] }], replace: [{ model: "claude-sonnet-5.5", preferredProvider: "record-fake", providers: { "record-fake": "offline" } }] }, compressor: { models: [{ model: "claude-sonnet-5.5", effort: "off" }] }
} }));
const child = spawn(join(repo, "node_modules/.bin/pi"), ["--no-extensions", "-e", repo, "-e", join(repo, "verification/record-worker-canary.ts"), "--mode", "rpc", "-a", "--provider", "record-fake", "--model", "offline"], { cwd: project,
  env: { HOME: home, PATH: process.env.PATH, TMPDIR: lab, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", SLATE_RECORD_EVIDENCE: join(lab, "evidence.json"), SLATE_RECORD_PROJECT: project, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9" }, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "", buffer = "", started = false, done = false;
child.stdout.on("data", (data) => {
  stdout += data; buffer += data;
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (!started && event.type === "response" && event.id === "mode") {
      started = true; child.stdin.write(JSON.stringify({ id: "run", type: "prompt", message: "Run the record worker integration." }) + "\n");
    }
    if (event.type === "message_end" && event.message?.role === "assistant" && JSON.stringify(event.message.content).includes("RECORD_WORKER_HOST_DONE")) done = true;
    if (done && event.type === "agent_settled") child.stdin.end();
  }
});
child.stderr.on("data", (data) => { stderr += data; });
child.stdin.write(JSON.stringify({ id: "mode", type: "prompt", message: "/slate on" }) + "\n");
const timer = setTimeout(() => { child.kill("SIGKILL"); }, 60000);
const exit = await new Promise((resolve) => child.on("close", resolve)); clearTimeout(timer);
writeFileSync(join(lab, "stdout"), stdout); writeFileSync(join(lab, "stderr"), stderr);
const EXPECTED = ["pi-exit", "assignment-activation", "guard", "invalid-call", "session-isolation", "stale-serialization", "durable-facts", "visible-factory-failure", "host-completion"];
const seen = [];
function check(name, action) { seen.push(name); action(); console.log(`CHECK ${name} PASS`); }
try {
  check("pi-exit", () => { assert.equal(exit, 0); assert.equal(/Failed to load extension/.test(stderr), false); });
  const evidence = JSON.parse(readFileSync(join(lab, "evidence.json"), "utf8"));
  const workers = evidence.filter((call) => ["A", "B"].includes(call.kind));
  check("assignment-activation", () => { assert.ok(workers.length >= 4); assert.ok(workers.every((call) => call.tools.includes("slate_record"))); assert.ok(workers.every((call) => !call.tools.includes("thread"))); });
  const folder = readdirSync(join(project, "slate-changes"))[0];
  const destination = join(project, "slate-changes", folder);
  const messages = [];
  function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (file.endsWith(".jsonl")) for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) { const value = JSON.parse(line); if (value.type === "message") messages.push(value.message); } } }
  walk(join(project, ".pi/slate"));
  check("guard", () => { for (const id of ["guard-A", "guard-B"]) { const result = messages.find((message) => message.toolCallId === id); assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /slate_record/); }
    const unresolved = messages.find((message) => message.toolCallId === "guard-unresolved");
    assert.equal(unresolved.isError, true); assert.match(JSON.stringify(unresolved.content), /cannot establish/);
    assert.doesNotMatch(JSON.stringify(unresolved.content), /assignment|slate_record/);
  });
  check("invalid-call", () => {
    const result = messages.find((message) => message.toolCallId === "invalid-A");
    assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result.content), /PRIVATE_INVALID_PAYLOAD|Received arguments/);
  });
  check("session-isolation", () => { assert.equal(readFileSync(join(destination, "track-2.4-implementer-report.md"), "utf8"), "REPORT_A+ONE"); assert.equal(readFileSync(join(destination, "status.md"), "utf8"), "STATUS_B"); for (const id of ["wrong-A", "wrong-B"]) assert.match(JSON.stringify(messages.find((message) => message.toolCallId === id)), /not assigned/); });
  check("stale-serialization", () => { assert.match(JSON.stringify(messages.find((message) => message.toolCallId === "append-two")), /stale/); assert.equal(statSync(join(destination, "track-2.4-implementer-report.md")).nlink, 1); });
  const episodes = [];
  function episodeWalk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (entry.isDirectory()) episodeWalk(file); else if (file.endsWith(".md")) episodes.push(readFileSync(file, "utf8")); } }
  episodeWalk(join(project, ".pi/slate"));
  const expected = [
    { record: "track-2.4-implementer-report.md", mode: "invalid", state: "refused before publication" },
    { record: "track-2.4-implementer-report.md", mode: "create", state: "published and synced", observedAfterHash: hash("REPORT_A") },
    { record: "unassigned", mode: "create", state: "refused before publication" },
    { record: "track-2.4-implementer-report.md", mode: "append", state: "published and synced", observedBeforeHash: hash("REPORT_A"), observedAfterHash: hash("REPORT_A+ONE") },
    { record: "track-2.4-implementer-report.md", mode: "append", state: "refused before publication", observedBeforeHash: hash("REPORT_A+ONE") },
    { record: "status.md", mode: "create", state: "published and synced", observedAfterHash: hash("STATUS_B") },
    { record: "unassigned", mode: "create", state: "refused before publication" },
  ];
  const projection = (fact) => Object.fromEntries(["record", "mode", "state", "observedBeforeHash", "observedAfterHash"].filter((key) => fact[key] !== undefined).map((key) => [key, fact[key]]));
  check("durable-facts", () => {
    const reports = episodes.filter((value) => value.includes("## Record call outcomes")); assert.equal(reports.length, 2);
    const actual = reports.flatMap(facts).map(projection);
    assert.deepEqual(actual.map(JSON.stringify).sort(), expected.map(JSON.stringify).sort());
    for (const id of ["create-A", "create-B", "append-one"]) {
      const result = messages.find((message) => message.toolCallId === id);
      const detail = JSON.parse(result.content.find((part) => part.type === "text").text);
      const expectedFact = expected.find((fact) => fact.record === detail.record && fact.mode === detail.mode && fact.state === detail.state);
      assert.deepEqual(projection(detail), expectedFact);
    }
  });
  walk(join(agent, "sessions"));
  const callerFacts = ["thread-A", "thread-B"].flatMap((id) => facts(messages.find((message) => message.toolCallId === id).content.filter((part) => part.type === "text").map((part) => part.text).join("\n"))).map(projection);
  assert.deepEqual(callerFacts.map(JSON.stringify).sort(), expected.map(JSON.stringify).sort());
  check("visible-factory-failure", () => { const result = messages.find((message) => message.toolCallId === "missing-factory"); assert.equal(result.details.status, "failed"); assert.match(JSON.stringify(result.content), /internal record factory is missing/); });
  check("host-completion", () => assert.equal(done, true));
  assert.deepEqual(seen, EXPECTED); console.log("CHECK roster PASS"); console.log(`SUMMARY ${seen.length + 1} pass, 0 fail`);
  rmSync(lab, { recursive: true });
} catch (error) { console.error(error); console.error(`artifacts: ${lab}`); process.exitCode = 1; }
