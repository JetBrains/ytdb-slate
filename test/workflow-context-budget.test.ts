import assert from "node:assert/strict";
import { readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, relative, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import * as paths from "../extension/paths.ts";
// @ts-ignore Data-only JavaScript fixture.
import { phases, lifecycle, scenarios, reads, referenceOnly, dependencies, conditionalSets, limits, occurrences } from "../verification/workflow-context-map.mjs";

const scratch = mkdtempSync(join(tmpdir(), "slate-phase-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const directory = `${dirname(paths.TRACK_WORKFLOW_DOC)}/`;
const exported = Object.fromEntries(Object.entries(paths).filter(([id]) => id.endsWith("_DOC")));
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const tokens = (size: number) => Math.ceil(size / 4);
const source = (id: string) => readFileSync(exported[id]!, "utf8");
type Read = [string, number, string, string, string[]];
type Span = [number, number];
function sections(text: string, selectors: string[]): Span[] {
  if (!selectors.length) return [[0, text.length]];
  return selectors.map((selector) => {
    let fence: { char: string, length: number } | undefined;
    const visible = text.split(/(?<=\n)/).map((line) => {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
      const hidden = !!fence || !!delimiter;
      if (fence) {
        if (delimiter && delimiter[1]![0] === fence.char && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
      } else if (delimiter && (delimiter[1]![0] !== "`" || !delimiter[2]!.includes("`"))) {
        fence = { char: delimiter[1]![0]!, length: delimiter[1]!.length };
      }
      return hidden ? line.replace(/[^\r\n]/g, " ") : line;
    }).join("");
    const headings = [...visible.matchAll(/^(#{1,6}) (.+)\r?$/gm)];
    const matches = headings.filter((m) => m[2] === selector);
    assert.equal(matches.length, 1, `section ${selector}`);
    const start = matches[0]!;
    const end = headings.find((m) => m.index! > start.index! && m[1]!.length <= start[1]!.length);
    return [start.index!, end?.index ?? text.length];
  });
}
function union(spans: Span[]): Span[] {
  const result: Span[] = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
function total(entries: Read[]): number {
  const grouped = new Map<string, Span[]>();
  for (const [id, , , , selectors] of entries) grouped.set(id, [...(grouped.get(id) ?? []), ...sections(source(id), selectors)]);
  return [...grouped].reduce((sum, [id, spans]) => sum + union(spans).reduce((n, [a, b]) => n + bytes(source(id).slice(a, b)), 0), 0);
}
async function render(publishing: boolean): Promise<string> {
  const handlers = new Map<string, any>();
  const api = { on: (name: string, handler: any) => handlers.set(name, handler), registerCommand() {}, registerTool() {}, getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [] };
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  store.currentChange = "change-20261016T000000Z-00000000000000000000000000000000";
  registerSlateMode(api as unknown as ExtensionAPI, store, { startHandoff: async () => {}, effectiveContextBudget: () => undefined } as any,
    () => ({ workflow: { draftPRs: publishing, followUpIssues: false, routingRecommendations: false } }),
    () => EMPTY_WORKER_EXTENSION_SET, () => createLogicalRuntime({ trusted: true, documentationDirectory: directory }));
  const result = await handlers.get("before_agent_start")({ systemPrompt: "" }, { cwd: scratch, isProjectTrusted: () => true } as unknown as ExtensionContext);
  return result.systemPrompt;
}
function membership(ids: Record<string, string>): void {
  assert.equal(new Set(Object.values(ids)).size, Object.keys(ids).length, "duplicate exported identity");
  for (const id of new Set((reads as Read[]).map((r) => r[0]))) {
    assert.ok(ids[id], `missing export ${id}`);
    assert.ok(!relative(directory, ids[id]!).startsWith(".."), `escaped export ${id}`);
    assert.ok(statSync(ids[id]!).isFile(), `missing file ${id}`);
  }
  for (const id of Object.keys(ids)) assert.ok(reads.some((r: Read) => r[0] === id) || referenceOnly[id], `unclassified export ${id}`);
}
function checkLimit(value: number, limit: number, label: string): void {
  assert.ok(Number.isInteger(limit) && value <= limit, `${label}: total ${value}, limit ${limit}, excess ${value - limit}`);
}
// Reference candidates include inline, reference-style, angle, bare, and absolute paths.
// Exact line hashes retain reviewed occurrence context without copying prose.
function references(text: string, origin: string, installedPrefix = directory): any[] {
  const result: any[] = [];
  const normalized = text.split(installedPrefix).join("");
  const label = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const definitions = new Map([...normalized.matchAll(/^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?.*$/gm)]
    .map((m) => [label(m[1]!), m[2]!]));
  for (const line of normalized.split("\n")) {
    const inline = line.replace(/\[([^\]]+)\]\(([^)]+\.md(?:#[^)]*)?)\)/g, "($2)");
    const candidates = /^ {0,3}\[[^\]]+\]:/.test(line) ? inline : inline.replace(
      /\[([^\]]+)\](?:\[([^\]]*)\])?/g,
      (use, text: string, alias: string | undefined) => {
        const target = definitions.get(label(alias || text));
        return target ? `(${target})` : use;
      });
    const found = [...candidates.matchAll(/(?:[\w./<>`*{}-]+\/)?[\w*{}-]+\.md\b/g)];
    for (const match of found) {
      const raw = match[0].replace(/^[<`]+/, "");
      let target: string;
      if (raw.startsWith(directory)) target = relative(directory, raw);
      else if (raw.startsWith("/") || /[*{}]|slate-changes\//.test(raw) || /(?:research-log|implementer-report|design|vN|observation)\.md$/.test(raw)) target = `variable:${raw}`;
      else target = relative(directory, resolve(origin.startsWith("doctrine") ? directory : dirname(join(directory, origin)), raw));
      result.push({ source: origin, target, context: createHash("sha256").update(line).digest("hex") });
    }
  }
  return result;
}
function scan(sources: Record<string, string>): any[] {
  return Object.entries(sources).flatMap(([id, text]) => references(text, id));
}
function coverage(actual: any[], roster = occurrences): void {
  const unique = roster.map((r: any) => JSON.stringify([r.source, r.target, r.context]));
  assert.equal(new Set(unique).size, unique.length, "duplicate classification");
  const expanded = roster.flatMap((r: any) => Array.from({ length: r.count }, () => r));
  const keys = (items: any[]) => items.map(({ source, target, context }) => JSON.stringify([source, target, context])).sort();
  assert.deepEqual(keys(actual), keys(expanded), "unknown reference or stale context count");
  for (const item of roster) {
    assert.ok(item.reason || (item.recipient === "orchestrator" && item.condition && item.phase >= 1 && item.phase <= 9), `missing classification ${JSON.stringify(item)}`);
    if (!item.reason) assert.ok(reads.some((r: Read) => exported[r[0]] === join(directory, item.target) && r[1] === item.phase && r[2] === item.condition));
  }
  for (const [id, phase, condition, recipient] of reads as Read[]) assert.ok(roster.some((r: any) =>
    !r.reason && join(directory, r.target) === exported[id] && r.phase === phase && r.condition === condition && r.recipient === recipient),
    `unbacked read ${id} phase ${phase} condition ${condition}`);
  for (const [from, to] of dependencies) assert.ok(roster.some((r: any) => r.source === relative(directory, exported[from]!) && r.target === relative(directory, exported[to]!) && !r.reason), `unclassified dependency ${from} -> ${to}`);
}
const expectedKeys = phases.flatMap((_: string, i: number) => scenarios.map((scenario: string) => `${i + 1} ${scenario}`));
function validateLimitKeys(values: Record<string, number[]>): void {
  assert.equal(expectedKeys.length, 36);
  assert.equal(new Set(expectedKeys).size, 36);
  assert.deepEqual(Object.keys(values).sort(), [...expectedKeys].sort(), "limit key set");
}
function validatePublication(text: string, expected: string): void {
  const blocks = [...text.matchAll(/<!-- workflow-phase:start -->[\s\S]*?<!-- workflow-phase:end -->/g)];
  assert.equal(blocks.length, 1, "publication block count");
  assert.equal(blocks[0]![0], expected, "publication content");
}
function table(rows: string[], costs: string[]): string {
  return ["<!-- workflow-phase:start -->", "## Workflow context by phase", "",
    "The doctrine is the workflow guidance rendered for the orchestrator. Each row",
    "adds cumulative required document reads to that guidance. Earlier reads stay",
    "in later rows. A later whole-file read replaces section ranges. Overlapping",
    "ranges count once. Section ranges include headings, subsections, separators,",
    "and final line feeds up to the next heading of the same or higher level. These rows describe one session from research to delivery. A change with more than one track hands off before each track, and the user runs each handoff. A session after a handoff holds less context than the rows for phases 7 to 9.", "",
    "Each fixture uses trusted shipped policy, no worker extensions, and one open",
    "change with a 56-character name. It has no source change. Deferred issues and",
    "routing recommendations are off. Ordinary plans have no nested trigger.",
    "Nested plans read the recursive workflow during research. Publishing adds",
    "the publishing document during research. These are allowed compositions,",
    "not maximum configurations. The 36 rows follow the lifecycle order, with four scenarios for each phase.", "",
    "UTF-8 means Unicode Transformation Format, 8-bit. Bytes use UTF-8 source text.",
    "Only the installed documentation-directory prefix is removed from doctrine.",
    "Filenames and all other text remain. Estimated tokens equal ceil(bytes / 4)",
    "for each complete total. This estimate is not a tokenizer result.",
    "The excluded installed path cost is 5 times the prefix byte length with",
    "publishing off and 6 times that length with publishing on. Tests measure",
    "this cost separately. It depends on the installation path.", "",
    "The user approved these limits on 2026-10-16. Each initial byte limit",
    "is ceil(baseline bytes * 1.05). Tests enforce total <= stored literal limit.",
    "The token limit is ceil(byte limit / 4). Reserve is checked at approval,",
    "not recalculated as text grows. A maximum includes all applicable optional",
    "reads. Any subset fits because removing ranges cannot increase union size.", "",
    "| Phase | Publishing | Plan | Required bytes | Estimated tokens | Byte limit | Token limit | Conditional maximum bytes | Estimated tokens | Byte limit | Token limit |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |", ...rows, "",
    "Conditional sets have the following whole-document costs. Early notes cost",
    "zero extra after required notes enter phase 7. Unusual prose costs zero extra",
    "when manual review already includes writing guidance. Nested plans already",
    "include the recursive workflow. Ordinary plans add it to their maximum from",
    "phase 7 before a split proposal. Manual review includes common policy, writing",
    "guidance, and all twelve charters from phase 5. Built-in review loads its",
    "implementation input for workers only. It adds no orchestrator read.",
    "| Conditional set | Bytes | Estimated tokens |", "| --- | ---: | ---: |", ...costs, "",
    "Private evidence, designs, reports, source chains, project additions, configured",
    "prompt documents, provider framing, tools, results, message wrappers, repeated",
    "reads, and the incoming system prompt are excluded. These variable costs can",
    "exceed every total. Compaction can reduce retained text but not this metric.",
    "The reference scanner checks filenames and reviewed contexts, not read semantics.",
    "A reviewer checks recipients, conditions, dependencies, and first-read phases.",
    "<!-- workflow-phase:end -->"].join("\n");
}

test("workflow phase budgets, reference coverage, and exact publication", { timeout: 10000 }, async () => {
  membership(exported);
  const spine = source("TRACK_WORKFLOW_DOC").split("The mandatory phases run in this order:\n\n")[1]!.split("\n\n")[0]!.replace(/\n   /g, " ").split("\n").map((line) => line.replace(/^\d+\. /, ""));
  assert.deepEqual(spine, lifecycle);
  const sources: Record<string, string> = {};
  for (const id of new Set((reads as Read[]).map((r) => r[0]))) {
    const entries = (reads as Read[]).filter((r) => r[0] === id);
    sources[relative(directory, exported[id]!)] = union(entries.flatMap((r) => sections(source(id), r[4]))).map(([a, b]) => source(id).slice(a, b)).join("");
  }
  const doctrines = await Promise.all([render(false), render(true)]);
  doctrines.forEach((text, i) => { sources[`doctrine-${i}`] = text; });
  validateLimitKeys(limits);
  const rows: string[] = [], measured: any[] = [], emittedKeys: string[] = [];
  for (let phase = 1; phase <= 9; phase++) for (const scenario of scenarios) {
    const [publishing, nesting] = scenario.split(" ");
    const required = (reads as Read[]).filter((r) => r[1] <= phase && (r[2] === "always" || r[2] === "nested" && nesting === "nested" || r[2] === "publishing" && publishing === "on"));
    const maximum = (reads as Read[]).filter((r) => r[1] <= phase && (r[2] !== "publishing" || publishing === "on") && (r[2] !== "nested" || nesting === "nested"));
    const has = (set: Read[], id: string) => set.some((r) => r[0] === id);
    assert.equal(has(required, "PR_PUBLISHING_DOC"), publishing === "on");
    assert.equal(has(required, "RECURSIVE_WORKFLOW_DOC"), nesting === "nested");
    assert.equal(has(maximum, "RECURSIVE_WORKFLOW_DOC"), nesting === "nested" || phase >= 7);
    assert.equal(has(maximum, "REVIEW_COMMON_POLICY_DOC"), phase >= 5);
    assert.equal(has(required, "USER_NOTES_DOC"), phase >= 7);
    assert.ok(has(maximum, "USER_NOTES_DOC"));
    assert.equal(has(maximum, "REVIEW_IMPLEMENTATION_INPUT_DOC"), false);
    const doctrine = bytes(doctrines[publishing === "on" ? 1 : 0]!.split(directory).join(""));
    const requiredBytes = doctrine + total(required), maximumBytes = doctrine + total(maximum);
    const key = `${phase} ${scenario}`, pair = limits[key];
    measured.push({ key, requiredBytes, maximumBytes, proposed: [Math.ceil(requiredBytes * 1.05), Math.ceil(maximumBytes * 1.05)] });
    assert.ok(pair, `missing limit pair ${key}`);
    const label = `${key} sources ${required.map((r) => `${r[0]}:${r[4].join(",") || "whole"}`).join(" ")}`;
    checkLimit(requiredBytes, pair[0], label);
    checkLimit(maximumBytes, pair[1], `${key} maximum sources ${maximum.map((r) => r[0]).join(" ")}`);
    rows.push(`| ${phase}. ${phases[phase - 1]} | ${publishing} | ${nesting} | ${requiredBytes} | ${tokens(requiredBytes)} | ${pair[0]} | ${tokens(pair[0])} | ${maximumBytes} | ${tokens(maximumBytes)} | ${pair[1]} | ${tokens(pair[1])} |`);
    emittedKeys.push(key);
    assert.ok(required.every((r) => maximum.includes(r)), key);
    for (const optional of maximum) assert.ok(total([...required, optional]) <= total(maximum), key);
  }
  const costs = conditionalSets.map(([label, ids, selectors = []]: [string, string[], string[]?]) => {
    const size = total(ids.map((id) => [id, 1, "cost", "orchestrator", selectors]));
    return `| ${label} | ${size} | ${tokens(size)} |`;
  });
  const excluded = doctrines.map((text) => bytes(text) - bytes(text.split(directory).join("")));
  assert.deepEqual(excluded, [5 * bytes(directory), 6 * bytes(directory)]);
  const publication = table(rows, costs);
  if (process.env.SLATE_PHASE_INSPECT === "1") console.log(JSON.stringify({ measured, references: scan(sources), publication, excluded, costs }));
  assert.equal(Object.keys(limits).length, 36);
  assert.equal(rows.length, 36);
  assert.equal(new Set(emittedKeys).size, 36);
  assert.deepEqual(emittedKeys, expectedKeys);
  const renamed = { ...limits, "unknown scenario": limits[expectedKeys[0]!] };
  delete renamed[expectedKeys[0]!];
  assert.throws(() => validateLimitKeys(renamed), /limit key set/);
  coverage(scan(sources));
  const published = source("CONTEXT_BUDGET_DOC");
  validatePublication(published, publication);
  for (const mutated of [publication.replace(/\| \d+ \|/, "| 0 |"), publication.replace(rows[0]!, rows[0]!.replace("off", "on")), publication.replace("Research", "Unknown"), publication.replace(rows[0]!, ""), publication.replace(rows[0]!, `${rows[0]}\n${rows[0]}`), publication.replace(costs[0]!, "| Rationale | 0 | 0 |"), "", `${publication}\n${publication}`]) assert.throws(() => validatePublication(mutated, publication), /publication/);
  for (const origin of ["doctrine-0", "review-rules.md", "user-notes.md"]) for (const added of ["Read new-duty.md.", "Read [x](new-duty.md).", "Read [x][alias].\n[alias]: new-duty.md", `Read <${paths.MODEL_ROUTING_DOC}>.`]) assert.throws(() => coverage(scan({ ...sources, [origin]: `${sources[origin]}\n${added}` })), /unknown reference/);
  for (const use of ["[guide]", "[guide][guide]", "[guide][]", "[x][alias]"]) {
    const origin = "review-rules.md", definition = "\n[guide]: track-workflow.md\n[alias]: track-workflow.md";
    const first = { ...sources, [origin]: `${sources[origin]}\nRead ${use} now.${definition}` };
    const firstScan = scan(first);
    const baselineKeys = new Set(scan(sources).map((r) => JSON.stringify(r)));
    const controlRoster = [...occurrences, ...firstScan.filter((r) => !baselineKeys.has(JSON.stringify(r))).map((r) => ({ ...r, count: 1, reason: "Control reference." }))];
    coverage(firstScan, controlRoster);
    const second = { ...first, [origin]: `${first[origin]}\nRead ${use} before continuing.` };
    assert.throws(() => coverage(scan(second), controlRoster), /unknown reference/);
    assert.equal(references(`Read ${use}.\n${definition}`, origin).length, 3);
  }
  const spacedPrefix = "/tmp/slate checkout/docs/";
  assert.deepEqual(references(`Read <${spacedPrefix}track-workflow.md>.`, "doctrine-0", spacedPrefix), references(`Read <${directory}track-workflow.md>.`, "doctrine-0"));
  for (const condition of ["ordinary split proposal", "early note or owner triage"]) {
    const withoutBacking = occurrences.map((r: any) => r.condition === condition ? { ...r, reason: "Control exclusion." } : r);
    assert.throws(() => coverage(scan(sources), withoutBacking), /unbacked read/);
  }
  assert.throws(() => coverage(scan(sources), [...occurrences, occurrences[0]]), /duplicate classification/);
  assert.throws(() => coverage(scan(sources), occurrences.slice(1)), /unknown reference/);
  const missing = { ...exported }; delete missing.TRACK_WORKFLOW_DOC;
  assert.throws(() => membership(missing), /missing export/);
  assert.throws(() => membership({ ...exported, TRACK_WORKFLOW_DOC: join(directory, "missing.md") }));
  assert.throws(() => membership({ ...exported, UNKNOWN_DOC: join(directory, "unknown.md") }), /unclassified export/);
  assert.throws(() => sections(source("CHANGE_RECORDS_DOC"), ["missing"]), /section/);
  assert.throws(() => sections("## Duplicate\n\n## Duplicate\n", ["Duplicate"]), /section/);
  assert.deepEqual(sections("## Owner\n### Child\ntext\n## Next\n", ["Owner"]), [[0, 24]]);
  for (const fence of ["```", "~~~~"]) {
    const example = `## Owner\n${fence}markdown\n## Example\n${fence}\n## Next\n`;
    assert.deepEqual(sections(example, ["Owner"]), [[0, example.indexOf("## Next")]]);
  }
  const fallback = source("PR_PUBLISHING_DOC");
  const [fallbackSpan] = sections(fallback, ["Default template"]);
  const fallbackText = fallback.slice(...fallbackSpan!);
  assert.ok(fallbackText.includes("## Why\n") && fallbackText.includes("## What changed\n"));
  assert.ok(!fallbackText.includes("## Tracks table"));
  assert.ok(fallbackText.includes("At creation, describe why the change is needed and the planned change."));
  assert.ok(fallbackText.includes("For the final description at change completion, describe delivered results."));
  assert.ok(fallbackText.includes("This form adds no workflow accounting or progress table."));
  assert.throws(() => coverage(scan(sources), occurrences.map((r: any, i: number) => i === 0 ? { ...r, recipient: "worker", reason: undefined } : r)), /missing classification/);
  assert.deepEqual(union([[0, 5], [3, 9], [1, 2]]), [[0, 9]]);
  assert.equal(bytes("é"), 2); assert.equal(tokens(5), 2);
  assert.equal(total([reads[0], reads[0]]), total([reads[0]]));
  assert.ok(total([reads[0], reads[1]]) > total([reads[1]]));
  assert.notDeepEqual(spine.slice(1), lifecycle);
  checkLimit(100, 100, "equality");
  assert.throws(() => checkLimit(101, 100, "overflow"), /excess 1/);
});

test("both original-base Git helpers isolate German parent settings", { timeout: 10000 }, () => {
  assert.equal(spawnSync("git", ["init", scratch], { encoding: "utf8" }).status, 0);
  for (const file of ["test/doctrine-contract.test.ts", "verification/resolver-checks.mjs"]) {
    const text = readFileSync(file, "utf8");
    const helper = text.match(/const git = \(\.\.\.args(?:: string\[\])?\)(?:: string)? => \{[\s\S]*?\n\s*\};/)![0].replaceAll(": string[]", "").replaceAll(": string", "");
    const exercise = (code: string) => {
      let environment: NodeJS.ProcessEnv = {};
      const spawn = (command: string, args: string[], options: any) => {
        environment = options.env ?? {};
        return spawnSync(command, args, options);
      };
      const parent = { ...process, env: { ...process.env, LANG: "de_DE.UTF-8", LANGUAGE: "de" } };
      const git = new Function("spawnSync", "process", "assert", "REPO", "original", `${code}; return git;`)(spawn, parent, assert, process.cwd(), "d8bca25ef8947e370a92a68a4d98d0e2ec9f1a53");
      assert.throws(() => git("-C", scratch, "rev-parse", "HEAD"), /fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree\./);
      assert.equal(environment.LC_ALL, "C"); assert.equal(environment.LANGUAGE, "C");
      assert.equal(environment.LANG, "de_DE.UTF-8");
    };
    exercise(helper);
    for (const setting of ['LC_ALL: "C", ', ', LANGUAGE: "C"']) assert.throws(() => exercise(helper.replace(setting, "")));
  }
});
