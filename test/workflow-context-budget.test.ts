import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, relative, resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WORKER_REMINDER_TEXT, WORKER_REMINDER_CUSTOM_TYPE } from "../extension/worker-reminder.ts";
import { WORKER_WRITING_GUIDANCE, REVIEWER_WRITING_GUIDANCE, WRITING_REMINDER_HEADER } from "../extension/writing-reminder.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import * as paths from "../extension/paths.ts";
import { trackIdentifier } from "../extension/record-names.ts";
// @ts-ignore Data-only JavaScript fixture.
import { phases, lifecycle, scenarios, reads, referenceOnly, dependencies, conditionalSets, limits, occurrences, sessionEntries, resumeReads, accumulatedReads, sessionReads, startsSession, requiresBoundary, transferReads } from "../verification/workflow-context-map.mjs";


// Literal child-start totals do not borrow the earlier placement saving.
const preservationStart: Record<string, number[]> = {
 "1 off ordinary": [
  78845,
  149284
 ],
 "1 off nested": [
  94085,
  164524
 ],
 "1 on ordinary": [
  90357,
  160796
 ],
 "1 on nested": [
  105597,
  176036
 ],
 "2 off ordinary": [
  114882,
  185321
 ],
 "2 off nested": [
  130122,
  200561
 ],
 "2 on ordinary": [
  126394,
  196833
 ],
 "2 on nested": [
  141634,
  212073
 ],
 "3 off ordinary": [
  114882,
  185321
 ],
 "3 off nested": [
  130122,
  200561
 ],
 "3 on ordinary": [
  126394,
  196833
 ],
 "3 on nested": [
  141634,
  212073
 ],
 "4 off ordinary": [
  114882,
  185321
 ],
 "4 off nested": [
  130122,
  200561
 ],
 "4 on ordinary": [
  126394,
  196833
 ],
 "4 on nested": [
  141634,
  212073
 ],
 "5 off ordinary": [
  139035,
  237350
 ],
 "5 off nested": [
  154275,
  252590
 ],
 "5 on ordinary": [
  150547,
  248862
 ],
 "5 on nested": [
  165787,
  264102
 ],
 "6 off ordinary": [
  139035,
  237350
 ],
 "6 off nested": [
  154275,
  252590
 ],
 "6 on ordinary": [
  150547,
  248862
 ],
 "6 on nested": [
  165787,
  264102
 ],
 "7 off ordinary": [
  162147,
  265054
 ],
 "7 off nested": [
  177387,
  265054
 ],
 "7 on ordinary": [
  173659,
  276566
 ],
 "7 on nested": [
  188899,
  276566
 ],
 "8 off ordinary": [
  162147,
  265054
 ],
 "8 off nested": [
  177387,
  265054
 ],
 "8 on ordinary": [
  173659,
  276566
 ],
 "8 on nested": [
  188899,
  276566
 ],
 "9 off ordinary": [
  162147,
  265054
 ],
 "9 off nested": [
  177387,
  265054
 ],
 "9 on ordinary": [
  173659,
  276566
 ],
 "9 on nested": [
  188899,
  276566
 ]
};
test("preservation share controls every phase and session coordinate", async () => {
 const doctrine = await Promise.all([render(false), render(true)]);
 let phasesChecked = 0, sessionsChecked = 0;
 const verify = (key: string, required: Read[], maximum: Read[], extra = 0) => {
  const size = bytes(doctrine[key.includes(" on ") ? 1 : 0]!.split(directory).join(""));
  const actual = [size + total(required), size + total(maximum)];
  const start = classificationStart[key]!;
  assert.deepEqual(start, preservationStart[key]!.map((n) => n - 1), `source-stage preservation proof ${key}`);
  const ceilings = [start[0] + 566, start[1] + extra + 3061];
  assert.deepEqual(actual, [phaseTotals[key]![0], phaseTotals[key]![1]! + extra]);
  actual.forEach((value, i) => {
   checkLimit(value, ceilings[i]!, key);
   checkLimit(ceilings[i]!, ceilings[i]!, key);
   assert.throws(() => checkLimit(ceilings[i]! + 1, ceilings[i]!, key));
  });
  for (const set of [required, maximum]) assert.ok(!JSON.stringify(set).includes("RECORD_WRITE_PENDING_DOC"));
 };
 for (let p = 1; p <= 9; p++) for (const scenario of scenarios) {
  verify(p + " " + scenario, accumulatedReads(p, scenario), accumulatedReads(p, scenario, true));
  phasesChecked++;
 }
 for (const entry of sessionEntries) for (const scenario of scenarios.filter((s: string) => entry.plans.includes(s.split(" ")[1])))
  for (let through = entry.phase; through <= 9; through++) {
   const extra = entry.phase === 1 && through === 1 && entry.id !== "research" && scenario.endsWith("nested") ? 29762 : 0;
   verify(through + " " + scenario, sessionReads(entry, scenario, false, through), sessionReads(entry, scenario, true, through), extra);
   sessionsChecked++;
  }
 assert.equal(phasesChecked, 36);
 assert.equal(sessionsChecked, 402);
 for (const text of doctrine) assert.doesNotMatch(text, /record-write-pending\.md|RECORD_WRITE_PENDING_DOC/);
});

const scratch = mkdtempSync(join(tmpdir(), "slate-phase-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const directory = `${dirname(paths.TRACK_WORKFLOW_DOC)}${sep}`;
// Published sizes and hashes use tracked LF text, not checkout line endings.
const trackedText = (text: string) => text.replace(/\r\n/g, "\n");
const readText = (path: string | URL) => trackedText(readFileSync(path, "utf8"));
const documentName = (path: string) => relative(directory, path).split(sep).join("/");
const exported = Object.fromEntries(Object.entries(paths).filter(([id]) => id.endsWith("_DOC")));
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const tokens = (size: number) => Math.ceil(size / 4);
const documentTexts = new Map<string, string>();
function source(id: string): string {
  if (!documentTexts.has(id)) documentTexts.set(id, readText(exported[id]!));
  return documentTexts.get(id)!;
}
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
  for (const id of new Set([...(reads as Read[]).map((r) => r[0]), "MAPS_DOC", "SAFE_RECORD_WRITE_DOC", "DESIGN_FORMAT_DOC"])) {
    assert.ok(ids[id], `missing export ${id}`);
    assert.ok(!relative(directory, ids[id]!).startsWith(".."), `escaped export ${id}`);
    assert.ok(statSync(ids[id]!).isFile(), `missing file ${id}`);
  }
  for (const id of Object.keys(ids)) assert.ok(reads.some((r: Read) => r[0] === id) || referenceOnly[id], `unclassified export ${id}`);
}
// Exact accumulated totals also anchor session-entry and continuation measurements.
const acceptedStartTotals: Record<string, [number, number]> = {
  "1 off ordinary": [77646, 146610],
  "1 off nested": [92880, 161844],
  "1 on ordinary": [89158, 158122],
  "1 on nested": [104392, 173356],
  "2 off ordinary": [113683, 182647],
  "2 off nested": [128917, 197881],
  "2 on ordinary": [125195, 194159],
  "2 on nested": [140429, 209393],
  "3 off ordinary": [113683, 182647],
  "3 off nested": [128917, 197881],
  "3 on ordinary": [125195, 194159],
  "3 on nested": [140429, 209393],
  "4 off ordinary": [113683, 182647],
  "4 off nested": [128917, 197881],
  "4 on ordinary": [125195, 194159],
  "4 on nested": [140429, 209393],
  "5 off ordinary": [137836, 234676],
  "5 off nested": [153070, 249910],
  "5 on ordinary": [149348, 246188],
  "5 on nested": [164582, 261422],
  "6 off ordinary": [137836, 234676],
  "6 off nested": [153070, 249910],
  "6 on ordinary": [149348, 246188],
  "6 on nested": [164582, 261422],
  "7 off ordinary": [160948, 262374],
  "7 off nested": [176182, 262374],
  "7 on ordinary": [172460, 273886],
  "7 on nested": [187694, 273886],
  "8 off ordinary": [160948, 262374],
  "8 off nested": [176182, 262374],
  "8 on ordinary": [172460, 273886],
  "8 on nested": [187694, 273886],
  "9 off ordinary": [160948, 262374],
  "9 off nested": [176182, 262374],
  "9 on ordinary": [172460, 273886],
  "9 on nested": [187694, 273886],
};
// Approved limit literals, independent of the current data map.
const acceptedStartLimits: Record<string, [number, number]> = {
  "1 off ordinary": [76071, 144707],
  "1 off nested": [129352, 227750],
  "1 on ordinary": [92915, 161551],
  "1 on nested": [146196, 244594],
  "2 off ordinary": [114616, 183253],
  "2 off nested": [167897, 236534],
  "2 on ordinary": [131460, 200097],
  "2 on nested": [184741, 253378],
  "3 off ordinary": [114616, 183253],
  "3 off nested": [167897, 236534],
  "3 on ordinary": [131460, 200097],
  "3 on nested": [184741, 253378],
  "4 off ordinary": [114616, 183253],
  "4 off nested": [167897, 236534],
  "4 on ordinary": [131460, 200097],
  "4 on nested": [184741, 253378],
  "5 off ordinary": [138968, 236777],
  "5 off nested": [192249, 290059],
  "5 on ordinary": [155812, 253621],
  "5 on nested": [209093, 306903],
  "6 off ordinary": [138968, 236777],
  "6 off nested": [192249, 290059],
  "6 on ordinary": [155812, 253621],
  "6 on nested": [209093, 306903],
  "7 off ordinary": [163599, 303139],
  "7 off nested": [216880, 303139],
  "7 on ordinary": [180443, 319984],
  "7 on nested": [233724, 319984],
  "8 off ordinary": [163599, 303139],
  "8 off nested": [216880, 303139],
  "8 on ordinary": [180443, 319984],
  "8 on nested": [233724, 319984],
  "9 off ordinary": [163599, 303139],
  "9 off nested": [216880, 303139],
  "9 on ordinary": [180443, 319984],
  "9 on nested": [233724, 319984],
};
const deliveredGrowth = 2593;
const placementDelta = [-1395, 80];
const placementTotals = Object.fromEntries(Object.entries(acceptedStartTotals)
  .map(([key, pair]) => [key, pair.map((value, side) => value + deliveredGrowth
    + placementDelta[side]!
    + (key.endsWith("nested") || Number(key.split(" ")[0]) >= 7 && side === 1 ? 6 : 0))]));

// Independent classification starts exclude savings from earlier stages.
const classificationStart: Record<string, [number, number]> = {
  "1 off ordinary": [78844, 149283], "1 off nested": [94084, 164523],
  "1 on ordinary": [90356, 160795], "1 on nested": [105596, 176035],
  "2 off ordinary": [114881, 185320], "2 off nested": [130121, 200560],
  "2 on ordinary": [126393, 196832], "2 on nested": [141633, 212072],
  "3 off ordinary": [114881, 185320], "3 off nested": [130121, 200560],
  "3 on ordinary": [126393, 196832], "3 on nested": [141633, 212072],
  "4 off ordinary": [114881, 185320], "4 off nested": [130121, 200560],
  "4 on ordinary": [126393, 196832], "4 on nested": [141633, 212072],
  "5 off ordinary": [139034, 237349], "5 off nested": [154274, 252589],
  "5 on ordinary": [150546, 248861], "5 on nested": [165786, 264101],
  "6 off ordinary": [139034, 237349], "6 off nested": [154274, 252589],
  "6 on ordinary": [150546, 248861], "6 on nested": [165786, 264101],
  "7 off ordinary": [162146, 265053], "7 off nested": [177386, 265053],
  "7 on ordinary": [173658, 276565], "7 on nested": [188898, 276565],
  "8 off ordinary": [162146, 265053], "8 off nested": [177386, 265053],
  "8 on ordinary": [173658, 276565], "8 on nested": [188898, 276565],
  "9 off ordinary": [162146, 265053], "9 off nested": [177386, 265053],
  "9 on ordinary": [173658, 276565], "9 on nested": [188898, 276565],
};
// Compare the four-model doctrine with the doctrine in the fixed classification inputs.
const workflowDoctrineDelta = -772;
const formDelta = (key: string, side: number) => {
  const [phase, , nesting] = key.split(" ");
  return 799 + (Number(phase) >= 5 ? 27 : 0) - (side === 1 ? 68 : 0)
    + (nesting === "nested" || side === 1 && Number(phase) >= 7 ? 4 : 0);
};
const phaseTotals = Object.fromEntries(Object.entries(classificationStart)
  .map(([key, pair]) => [key, pair.map((value, side) => value + [342, 3058][side]! + workflowDoctrineDelta + formDelta(key, side))]));

test("placement keeps exception membership, phase shares and literal worker ceilings", async () => {
  const has = (set: Read[]) => set.some(([id]) => id === "RECORD_WRITE_RECOVERY_DOC");
  const checkMembership = (entries: Read[]) => {
    for (let phase = 1; phase <= 9; phase++) for (const scenario of scenarios) {
      const [publishing, nesting] = scenario.split(" ");
      const applicable = entries.filter((r) => r[1] <= phase && (r[2] !== "publishing" || publishing === "on") && (r[2] !== "nested" || nesting === "nested"));
      assert.ok(has(applicable), `maximum exception from phase one: ${phase} ${scenario}`);
      assert.equal(has(applicable.filter((r) => ["always", "publishing", "nested"].includes(r[2]))), false);
    }
  };
  checkMembership(reads);
  assert.throws(() => checkMembership(reads.filter(([id]: Read) => id !== "RECORD_WRITE_RECOVERY_DOC")));
  assert.throws(() => checkMembership(reads.map((r: Read) => r[0] === "RECORD_WRITE_RECOVERY_DOC" ? [r[0], 2, ...r.slice(2)] as Read : r)));
  const doctrine = await Promise.all([render(false), render(true)]);
  for (let phase = 1; phase <= 9; phase++) for (const scenario of scenarios) {
    const size = bytes(doctrine[scenario.startsWith("on") ? 1 : 0]!.split(directory).join(""));
    const pair = [size + total(accumulatedReads(phase, scenario)), size + total(accumulatedReads(phase, scenario, true))];
    const key = `${phase} ${scenario}`, start = classificationStart[key]!;
    assert.deepEqual(start, placementTotals[key], `source-stage placement proof ${key}`);
    assert.deepEqual(pair, phaseTotals[key]);
    assert.ok(pair[0]! <= start[0] + 566 && pair[1]! <= start[1] + 3061, key);
    pair.forEach((n, side) => checkLimit(n, limits[key][side], key));
  }
  for (const entry of sessionEntries) for (const scenario of scenarios.filter((s: string) => entry.plans.includes(s.split(" ")[1]))) {
    for (let through = entry.phase; through <= 9; through++) {
      const required = sessionReads(entry, scenario, false, through), maximum = sessionReads(entry, scenario, true, through);
      assert.equal(has(required), false);
      assert.ok(has(maximum));
    }
  }
  const common = total([["CHANGE_RECORDS_DOC", 1, "worker", "worker", ["Manual records and safe writes"]]]);
  const worker = source("SAFE_RECORD_WRITE_DOC"), introEnd = worker.indexOf("## Command contract");
  const narrow = bytes(worker.slice(0, introEnd)) + total([["SAFE_RECORD_WRITE_DOC", 1, "worker", "worker", ["Record preparation and recovery execution"]]]);
  assert.equal(common, 12085);
  assert.equal(bytes(worker), 14480);
  assert.equal(narrow, 5200);
  assert.equal(bytes(source("RECORD_WRITE_RECOVERY_DOC")), 4191);
  const ceiling = (value: number, limit: number) => assert.ok(value <= limit);
  const map = bytes(source("MAPS_DOC")), design = bytes(source("DESIGN_FORMAT_DOC"));
  const combined = [common + narrow + map, common + bytes(worker) + map];
  assert.equal(design, 3369);
  assert.equal(map, 3726);
  assert.deepEqual(combined, [21011, 30291]);
  const cases = [[common, 12088], [narrow, 5200], [bytes(worker), 14500], [common + narrow, 17287],
    [combined[0], 21053], [common + bytes(worker), 26587], [combined[1], 30353], [design, 3369],
    [combined[0]! + 1925, 22979], [combined[1]! + 1925, 32279],
    [combined[0]! + 2479, 23533], [combined[1]! + 2479, 32833]];
  for (const [value, limit] of cases) {
    ceiling(value!, limit!);
    ceiling(limit! - 1, limit!);
    ceiling(limit!, limit!);
    assert.throws(() => ceiling(limit! + 1, limit!));
  }
});

const checkChildCeiling = (required: number, maximum: number) => {
  checkLimit(required, 79410, "child required reservation");
  checkLimit(maximum, 152344, "child maximum reservation");
};
function exactLimits(key: string, pair: number[]): void {
  const maximums: Record<string, number> = {
    "1 off ordinary": 152344, "1 on ordinary": 163856,
    "2 off ordinary": 188381, "3 off ordinary": 188381, "4 off ordinary": 188381,
    "5 off ordinary": 240410, "6 off ordinary": 240410,
  };
  assert.deepEqual(pair, acceptedStartLimits[key]!.map((n, side) => side === 1 ? maximums[key] ?? n
    : n + (key === "1 off ordinary" ? deliveredGrowth : 0)
      + (/^[1-6] off ordinary$/.test(key) ? 725 : 0)), `exact approved raise ${key}`);
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
    const found = [...candidates.matchAll(/(?:[\w./<>`*{}-]+\/)?[\w*{}<>.-]+\.md\b/g)];
    if (found.length === 0) continue;
    const context = createHash("sha256").update(line).digest("hex");
    for (const match of found) {
      const raw = match[0].replace(/^[<`]+/, "");
      let target: string;
      if (raw.startsWith(directory)) target = relative(directory, raw);
      else if (isMapName(raw)) target = `variable:${raw}`;
      else if (raw.startsWith("/") || /[*{}]|slate-changes\//.test(raw) || /(?:research-log|implementer-report|design|vN|observation)\.md$/.test(raw)) target = `variable:${raw}`;
      else target = relative(directory, resolve(origin.startsWith("doctrine") ? directory : dirname(join(directory, origin)), raw));
      result.push({ source: origin, target, context });
    }
  }
  return result;
}
function isMapName(raw: string): boolean {
  if (raw === "root-baseline-map.md") return true;
  const match = /^track-(<number>|[0-9.]+)-(?:baseline|implementation)-map\.md$/.exec(raw);
  if (!match) return false;
  if (match[1] === "<number>") return true;
  try { return trackIdentifier(match[1]) === match[1]; } catch { return false; }
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
  for (const [from, to] of dependencies) assert.ok(roster.some((r: any) => r.source === documentName(exported[from]!) && r.target === documentName(exported[to]!) && !r.reason), `unclassified dependency ${from} -> ${to}`);
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
function table(rows: string[], costs: string[], entries: string[]): string {
  return [
    "<!-- workflow-phase:start -->",
    "## Workflow context by phase",
    "",
    "The doctrine is the workflow guidance rendered for the orchestrator. Each row",
    "adds cumulative required document reads to that guidance. Earlier reads stay",
    "in later rows. A later whole-file read replaces section ranges. Overlapping",
    "ranges count once. Section ranges include headings, subsections, separators,",
    "and final line feeds up to the next heading of the same or higher level.",
    "The phase rows preserve accumulation for single-track work without a handoff.",
    "",
    "Each fixture uses trusted shipped policy, no worker extensions, and one open",
    "change with a 56-character name. It has no source change. Deferred issues and",
    "routing recommendations are off. Ordinary plans have no nested trigger.",
    "Nested plans read the recursive workflow during research. Publishing adds",
    "the publishing document during research. These are allowed compositions,",
    "not maximum configurations. The 36 rows follow the lifecycle order, with four scenarios for each phase.",
    "",
    "UTF-8 means Unicode Transformation Format, 8-bit. Bytes use UTF-8 source text.",
    "Only the installed documentation-directory prefix is removed from doctrine.",
    "Filenames and all other text remain. Estimated tokens equal ceil(bytes / 4)",
    "for each complete total. This estimate is not a tokenizer result.",
    "The excluded installed path cost is 5 times the prefix byte length with",
    "publishing off and 6 times that length with publishing on. Tests measure",
    "this cost separately. It depends on the installation path.",
    "",
    "The user approved these limits on 2026-10-16. Each initial byte limit",
    "is ceil(baseline bytes * 1.05). Tests enforce total <= stored literal limit.",
    "The token limit is ceil(byte limit / 4). Reserve is checked at approval,",
    "not recalculated as text grows. A maximum includes all applicable optional",
    "reads. Any subset fits because removing ranges cannot increase union size.",
    "The user approved the two nested research maximum limits on 2026-10-25.",
    "They are 227,750 bytes / 56,938 estimated tokens with publishing off and",
    "244,594 bytes / 61,149 estimated tokens with publishing on.",
    "The fixed historical safe-write raise G is 2,593 bytes.",
    "The approval of 2026-11-26 assigns 410 bytes of shipped model policy text to each comparison start.",
    "The same approval assigns 410 bytes to the seven funded ordinary maximum limits.",
    "Each reservation equals its row start plus its approved share.",
    "The five percent reserve does not apply to these seven increases. All other phase limits stay fixed.",
    "The classification and recovery allowance applies independently to each required and maximum row.",
    "Research candidate ceilings are 79,410 required and 152,344 maximum bytes.",
    "Actual research totals are 79,213 required and 152,300 maximum bytes.",
    "Each phase and session row permits at most 566 required and 3,061 maximum bytes above the classification and recovery start. No sibling saving transfers.",
    "The protected pool owns 211 bytes (187 + 5 + 17 + 2). This ownership adds no measured headroom. Unused share moves only by recorded user decision.",
    "",
    "| Phase | Publishing | Plan | Required bytes | Estimated tokens | Byte limit | Token limit | Conditional maximum bytes | Estimated tokens | Byte limit | Token limit |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "### Session starts",
    "",
    "A session runs between actual handoff transfers. A failed or cancelled transfer",
    "and resume without transfer keep the current session. Single-track work has",
    "no mandatory handoff. Reads continue accumulating inside each session.",
    "",
    "Each start rereads the accumulated fixed-document set for its phase and plan.",
    "Nested phase-1 resume starts include design-track entry and optional handoffs.",
    "Their required sets cover unchanged-record reconciliation without added definitions.",
    "Their conditional maxima add focus and coverage definitions for renewed focus judgment.",
    "These two ranges in [blast-radius.md](blast-radius.md) add 29,762 bytes.",
    "Root research starts add neither range, including with a nested plan.",
    "From phase 2, the whole [blast-radius.md](blast-radius.md) already contains both ranges.",
    "",
    "| Session start | Entry phase | Plan | Added required reads | Added conditional reads |",
    "| --- | --- | --- | --- | --- |",
    "| Root research | 1 | ordinary or nested | none | none |",
    "| Optional handoff | 1 | ordinary | none | none |",
    "| Design track or optional handoff | 1 | nested | none | [Focus areas and their gates](blast-radius.md#focus-areas-and-their-gates), including Judged proof and risk record, plus [Review coverage and the coverage register](blast-radius.md#review-coverage-and-the-coverage-register) |",
    "| Code track, including the second boundary | 7 | ordinary or nested | none | none |",
    "| Parent return | continuing phase 2–9 | ordinary or nested | none | none |",
    "| Optional handoff | continuing phase 2–9 | ordinary or nested | none | none |",
    "",
    "All starts use the corresponding phase limits. Only nested phase-1 resume maxima",
    "differ from the phase totals. Their measured entry totals follow.",
    "",
    "| Publishing | Required bytes | Estimated tokens | Conditional maximum bytes | Estimated tokens | Byte limit | Token limit |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...entries,
    "",
    "The doctrine requires common change records at every start. Nested planning",
    "and resume load recursive workflow. Fresh sessions cannot reuse prior context",
    "to skip review rules, rationale, or unusual-prose guidance when applicable.",
    "Resume reconciles records, accepted history, focus, coverage, and the live difference.",
    "Variable records remain required evidence but are outside fixed-document bytes.",
    "Tests compare document identities, conditions, and selected range unions.",
    "Current source rules release no fixed-document read at a handoff.",
    "",
    "A handoff saves retained conversation content, including messages, episodes,",
    "and variable records. It does not save required fixed-document reads.",
    "These tables exclude that conversation content and repeated reads.",
    "They do not measure the total context saving from a handoff.",
    "",
    "Conditional sets have the following whole-document costs. Early notes cost",
    "zero extra after required notes enter phase 7. Unusual prose costs zero extra",
    "when manual review already includes writing guidance. Nested plans already",
    "include the recursive workflow. Ordinary plans add it to their maximum from",
    "phase 7 before a split proposal. Manual review includes common policy, writing",
    "guidance, and all twelve charters from phase 5. Built-in review loads its",
    "implementation input for workers only. It adds no orchestrator read.",
    "| Conditional set | Bytes | Estimated tokens |",
    "| --- | ---: | ---: |",
    ...costs,
    "",
    "Maps and designs have soft guidelines of about 1,500 and 2,500 words.",
    "Diagrams do not count. The map reference is 3726 bytes per full read.",
    "See [maps.md](maps.md) for its worker readers. The design reference is 3369 bytes",
    "per full read by a design author, with a 3,369-byte bound. Name",
    "[design-format.md](design-format.md) in design-writing tasks without reading it.",
    "The orchestrator never reads it, including on worker failure. Count worker",
    "reads again on each repeat. Worker reads, record text and composed drafts",
    "are separate costs outside the fixed orchestrator rows.",
    "The safe-write section is 12,085 bytes and includes privacy rules.",
    "Only its worker read is a separate excluded cost. Its orchestrator read enters phase totals.",
    "Whole applicable designs supplied to reviewers are excluded costs that repeat across reviewers and fix-gate rounds.",
    "Several maps can exceed fixed-row headroom. These totals do not bound the whole conversation.",
    "",
    "Private evidence, designs, reports, source chains, project additions, configured",
    "prompt documents, provider framing, tools, results, message wrappers, repeated",
    "reads, and the incoming system prompt are excluded. These variable costs can",
    "exceed every total. Compaction can reduce retained text but not this metric.",
    "The reference scanner checks filenames and reviewed contexts, not read semantics.",
    "A reviewer checks recipients, conditions, dependencies, and first-read phases.",
    "After any resume, handoff, or reread duty changes, reconcile session-entry",
    "assignments against source duties even when tests pass. Follow",
    "[Workflow-phase context maintenance](../verification/README.md#workflow-phase-context-maintenance)",
    "and record either the updated assignments, expectations, and publication or a no-change decision.",
    "<!-- workflow-phase:end -->"
  ].join("\n");
}
test("both worker reminder publications match the measured representations", () => {
  const timestamp = 1730000000000;
  const rows = [
    ["Tools only", "", 0, 0, 330, 383, 409, 499],
    ["Tools with full writing guidance", WORKER_WRITING_GUIDANCE, 1180, 1163, 1493, 1563, 1589, 1679],
    ["Tools with short writing guidance", REVIEWER_WRITING_GUIDANCE, 562, 545, 875, 930, 956, 1046],
  ] as const;
  const docs = [paths.CONTEXT_BUDGET_DOC, join(directory, "../verification/README.md")].map((file) => readFileSync(file, "utf8"));
  for (const [form, body, standaloneBytes, addedBytes, ...expected] of rows) {
    const standalone = body && `${WRITING_REMINDER_HEADER}\n\n${body}`;
    const increment = body && `\n\n${body}`;
    const content = WORKER_REMINDER_TEXT + increment;
    const [converted] = convertToLlm([{ role: "custom", content, customType: WORKER_REMINDER_CUSTOM_TYPE, display: false, timestamp }]);
    assert.ok(converted);
    const { timestamp: convertedTimestamp, ...withoutTimestamp } = converted;
    assert.equal(convertedTimestamp, timestamp);
    const record = { type: "custom_message", id: "12345678", parentId: "abcdefgh", timestamp: new Date(timestamp).toISOString(),
      customType: WORKER_REMINDER_CUSTOM_TYPE, content, display: false };
    const actual = [bytes(content), bytes(JSON.stringify(withoutTimestamp)), bytes(JSON.stringify(converted)), bytes(JSON.stringify(record) + "\n")];
    assert.deepEqual([bytes(standalone), bytes(increment), ...actual], [standaloneBytes, addedBytes, ...expected], form);
    const row = `| ${form} | ${expected.map((count) => count.toLocaleString("en-US")).join(" | ")} |`;
    for (const doc of docs) assert.equal(doc.split("\n").filter((line) => line === row).length, 1, form);
  }
});

test("workflow phase budgets, reference coverage, and exact publication", { timeout: 10000 }, async () => {
  membership(exported);
  const spine = source("TRACK_WORKFLOW_DOC").split("The mandatory phases run in this order:\n\n")[1]!.split("\n\n")[0]!.replace(/\n   /g, " ").split("\n").map((line) => line.replace(/^\d+\. /, ""));
  assert.deepEqual(spine, lifecycle);
  const sources: Record<string, string> = {};
  for (const id of new Set((reads as Read[]).map((r) => r[0]))) {
    const entries = (reads as Read[]).filter((r) => r[0] === id);
    sources[documentName(exported[id]!)] = union(entries.flatMap((r) => sections(source(id), r[4]))).map(([a, b]) => source(id).slice(a, b)).join("");
  }
  const doctrines = await Promise.all([render(false), render(true)]);
  assert.deepEqual(doctrines.map((text) => bytes(text.split(directory).join(""))), [9937, 10007]);
  doctrines.forEach((text, i) => { sources[`doctrine-${i}`] = text; });
  sources["maps.md"] = source("MAPS_DOC").split("\n").find((line) => line.includes("for shared forms."))!;
  sources["context-budget.md"] = source("CONTEXT_BUDGET_DOC").split("\n").filter((line) =>
    line.includes("for its worker readers.") || line.includes("in design-writing tasks")).join("\n");
  validateLimitKeys(limits);
  for (const key of expectedKeys) {
    exactLimits(key, limits[key]);
    for (const side of [0, 1]) for (const delta of [-1, 1]) {
      const changed = [...limits[key]]; changed[side] += delta;
      assert.throws(() => exactLimits(key, changed), /exact approved raise/);
    }
  }
  const fundedMaximums: Record<string, number> = {
    "1 off ordinary": 152344, "1 on ordinary": 163856,
    "2 off ordinary": 188381, "3 off ordinary": 188381,
    "4 off ordinary": 188381, "5 off ordinary": 240410, "6 off ordinary": 240410,
  };
  for (const [key, approved] of Object.entries(fundedMaximums)) {
    assert.equal(limits[key][1], approved, key);
    checkLimit(approved - 1, limits[key][1], key);
    checkLimit(approved, limits[key][1], key);
    assert.throws(() => checkLimit(approved + 1, limits[key][1], key));
  }
  assert.deepEqual(limits["1 off ordinary"], [79389, 152344]);
  assert.deepEqual([79389 - 78844, 152344 - 149283], [545, 3061]);
  for (const delta of [-1, 1]) for (const side of [0, 1]) {
    const pair = [...limits["1 off ordinary"]];
    pair[side] += delta;
    assert.throws(() => exactLimits("1 off ordinary", pair), /exact approved raise/);
  }
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
    assert.equal(has(required, "MAPS_DOC"), false);
    assert.equal(has(maximum, "MAPS_DOC"), false);
    noDesignRead(required, maximum);
    assert.equal(has(required, "SAFE_RECORD_WRITE_DOC"), false);
    assert.equal(has(maximum, "SAFE_RECORD_WRITE_DOC"), false);
    const doctrine = bytes(doctrines[publishing === "on" ? 1 : 0]!.split(directory).join(""));
    const requiredBytes = doctrine + total(required), maximumBytes = doctrine + total(maximum);
    const key = `${phase} ${scenario}`, pair = limits[key];
    assert.deepEqual([requiredBytes, maximumBytes], phaseTotals[key], `measured phase totals ${key}`);
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
  const entries = scenarios.filter((s: string) => s.endsWith("nested")).map((scenario: string) => {
    const entry = sessionEntries.find((e: Entry) => e.id === "design-track");
    const publishing = scenario.split(" ")[0];
    const doctrine = bytes(doctrines[publishing === "on" ? 1 : 0]!.split(directory).join(""));
    const required = doctrine + total(sessionReads(entry, scenario));
    const maximum = doctrine + total(sessionReads(entry, scenario, true));
    const pair = limits[`1 ${scenario}`];
    checkLimit(required, pair[0], `design-track ${scenario}`);
    checkLimit(maximum, pair[1], `design-track maximum ${scenario}`);
    return `| ${publishing} | ${required} | ${tokens(required)} | ${maximum} | ${tokens(maximum)} | ${pair[1]} | ${tokens(pair[1])} |`;
  });
  assert.deepEqual(measured[0], { key: "1 off ordinary", requiredBytes: 79213, maximumBytes: 152300, proposed: [83174, 159915] });
  checkChildCeiling(measured[0].requiredBytes, measured[0].maximumBytes);
  checkLimit(bytes(source("REVIEW_RULES_DOC")), 24203, "review rules child ceiling");
  assert.throws(() => checkLimit(24204, 24203, "review rules child ceiling"), /excess 1/);
  checkChildCeiling(79409, 152343);
  checkChildCeiling(79410, 152344);
  assert.ok(source("CONTEXT_BUDGET_DOC").includes("ceilings are 79,410 required and 152,344 maximum bytes."));
  assert.ok(source("CONTEXT_BUDGET_DOC").includes("G is 2,593 bytes."));
  const budget = source("CONTEXT_BUDGET_DOC");
  const ownership = "The protected pool owns 211 bytes (187 + 5 + 17 + 2). This ownership adds no measured headroom.";
  assert.equal(budget.split(ownership).length - 1, 2);
  assert.match(budget, /reserved for later workflow documentation\.\nThe protected pool owns/);
  assert.doesNotMatch(budget, /retains 187 bytes|allocates 15 of 202 bytes/);
  assert.throws(() => checkChildCeiling(79411, 144496), /child required reservation/);
  assert.throws(() => checkChildCeiling(75532, 152345), /child maximum reservation/);
  checkLimit(75856, limits["1 off ordinary"][0], "wider required control");
  checkLimit(144492, limits["1 off ordinary"][1], "wider maximum control");
  assert.throws(() => checkChildCeiling(79411, 152344), /child required reservation/);
  assert.throws(() => checkChildCeiling(79410, 152345), /child maximum reservation/);
  const publication = table(rows, costs, entries);
  assert.equal(bytes(publication), 12507, "measured publication bytes");
  if (process.env.SLATE_PHASE_INSPECT === "1") console.log(JSON.stringify({ measured, references: scan(sources), publication, excluded, costs }));
  assert.equal(Object.keys(limits).length, 36);
  assert.equal(rows.length, 36);
  assert.equal(new Set(emittedKeys).size, 36);
  assert.deepEqual(emittedKeys, expectedKeys);
  const renamed = { ...limits, "unknown scenario": limits[expectedKeys[0]!] };
  delete renamed[expectedKeys[0]!];
  assert.throws(() => validateLimitKeys(renamed), /limit key set/);
  const pending = occurrences.filter((r: any) => r.source === "track-workflow.md" && r.target === "maps.md");
  assert.equal(pending.length, 2);
  for (const item of pending) {
    assert.equal(item.reason, "Published worker-only map reference, no orchestrator read duty.");
    assert.equal(item.recipient, undefined);
  }
  assert.equal(dirname(paths.MAPS_DOC), dirname(paths.TRACK_WORKFLOW_DOC));
  const safeWriteSection = sections(source("CHANGE_RECORDS_DOC"), ["Manual records and safe writes"]);
  assert.equal(bytes(source("CHANGE_RECORDS_DOC").slice(...safeWriteSection[0]!)), 12085);
  assert.ok(source("CONTEXT_BUDGET_DOC").includes("Only its worker read is a separate excluded cost. Its orchestrator read enters phase totals."));
  const protectedHashes: Record<string, string> = {
    "MAPS_DOC": "d99c8f7c89106038dafecb7c75f53d3a46d97bd9348bef2f15d41f19e000cfbd",
    "REVIEW_RULES_DOC": "e77019cac879c9fb6049d4fdea2418721add6e082af66291074fd6c75194c0ce"
  };
  for (const [id, expected] of Object.entries(protectedHashes)) {
    assert.equal(createHash("sha256").update(source(id)).digest("hex"), expected, `${id} remains byte-identical`);
  }
  assert.equal(referenceOnly.MAPS_DOC, pending[0].reason);
  assert.match(source("MAPS_DOC"), /about 1,500 words/);
  assert.match(source("MAPS_DOC"), /under 40\s+nodes/);
  for (const entry of sessionEntries) for (const scenario of scenarios.filter((s: string) => entry.plans.includes(s.split(" ")[1]))) {
    assert.ok(sessionReads(entry, scenario, true).every((r: Read) => r[0] !== "MAPS_DOC"));
  }
  const checking = occurrences.filter((r: any) => r.source === "review-rules.md" && r.target === "maps.md");
  assert.equal(checking.length, 1);
  assert.equal(checking[0].reason, referenceOnly.MAPS_DOC);
  const publishedWorker = (roster: any[]) => roster.filter((r) => r.target === "maps.md").every((r) => r.reason === referenceOnly.MAPS_DOC && !r.recipient);
  assert.ok(publishedWorker(occurrences));
  for (const reason of ["Pending worker-only reference. Child 1.3 publishes the document.", undefined]) {
    assert.equal(publishedWorker(occurrences.map((r: any) => r.target === "maps.md" ? { ...r, reason } : r)), false);
  }
  assert.equal(publishedWorker(occurrences.map((r: any) => r.target === "maps.md" ? { ...r, recipient: "orchestrator" } : r)), false);
  assert.throws(() => membership({ ...exported, MAPS_DOC: paths.TRACK_WORKFLOW_DOC }), /duplicate/);
  const noWorker = { ...exported }; delete noWorker.SAFE_RECORD_WRITE_DOC;
  assert.throws(() => membership(noWorker), /missing export/);
  assert.equal(referenceOnly.SAFE_RECORD_WRITE_DOC, "Worker-only command reference, no orchestrator read duty.");
  const mapSource = readText(new URL("../verification/workflow-context-map.mjs", import.meta.url));
  const classification = '  SAFE_RECORD_WRITE_DOC: "Worker-only command reference, no orchestrator read duty.",';
  const checkClassification = (text: string) => {
    const block = /export const referenceOnly = \{([\s\S]*?)\n\};/.exec(text)![1]!;
    assert.equal((text.match(/^\s*SAFE_RECORD_WRITE_DOC:/gm) ?? []).length, 1, "unique source classification");
    assert.equal(block.split(classification).length, 2, "worker-only classification");
  };
  for (const newline of ["\n", "\r\n"]) checkClassification(trackedText(mapSource.replace(/\n/g, newline)));
  assert.throws(() => checkClassification(mapSource.replace(classification, "")));
  assert.throws(() => checkClassification(mapSource.replace(classification, classification + "\n" + classification)));
  assert.throws(() => checkClassification(mapSource.replace(classification, classification.replace("no orchestrator", "required orchestrator"))));
  assert.throws(() => checkClassification(mapSource.replace(classification, "").replace("export const reads = [", "export const reads = [\n" + classification)));
  const commandSource = readText(paths.SAFE_RECORD_WRITE);
  const help = spawnSync(process.execPath, [paths.SAFE_RECORD_WRITE, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  const bounds = /help (\d+) bytes, report (\d+) bytes,\n \* standard error (\d+) bytes/.exec(commandSource)!;
  const format = (n: number) => n.toLocaleString("en-US");
  const checkExcluded = (published: string, worker: string, helpText: string, report: number, stderr: number) => {
    for (const sentence of [
      `The worker-only safe-record-write.md reference measures ${format(bytes(worker))} bytes.`,
      `Command help measures ${bytes(helpText)} bytes within its ${format(Number(bounds[1]))}-byte bound.`,
      `Each non-help command call has a ${format(report + stderr)}-byte output bound.`,
      `The preservation route allows two ordinary attempts and two recovery attempts per record operation across dispatches.`,
      `Those four attempts have a ${format(4 * (report + stderr))}-byte output bound.`,
      `Accepted occupied fresh checks consume no attempt and each adds at most ${format(report + stderr)} output bytes.`,
      `Repeated fresh checks have no cumulative output bound.`,
    ]) assert.equal(published.split(sentence).length, 2, sentence);
  };
  const publicationSource = source("CONTEXT_BUDGET_DOC");
  const workerSource = source("SAFE_RECORD_WRITE_DOC");
  const reportBound = Number(bounds[2]), stderrBound = Number(bounds[3]);
  for (const newline of ["\n", "\r\n"]) {
    checkExcluded(trackedText(publicationSource.replace(/\n/g, newline)), trackedText(workerSource.replace(/\n/g, newline)), help.stdout, reportBound, stderrBound);
  }
  assert.throws(() => checkExcluded(publicationSource, workerSource + "extra", help.stdout, reportBound, stderrBound));
  assert.throws(() => checkExcluded(publicationSource, workerSource, help.stdout + "extra", reportBound, stderrBound));
  assert.throws(() => checkExcluded(publicationSource, workerSource, help.stdout, reportBound + 1, stderrBound));
  assert.throws(() => checkExcluded(publicationSource, workerSource, help.stdout, reportBound, stderrBound + 1));
  const noMap = { ...exported }; delete noMap.MAPS_DOC;
  assert.throws(() => membership(noMap), /missing export/);
  for (const name of ["root-baseline-map.md", "track-1-baseline-map.md", "track-1.2-implementation-map.md", "track-<number>-baseline-map.md", "track-<number>-implementation-map.md", "track-9007199254740991-baseline-map.md", `track-${"1.".repeat(63)}1-baseline-map.md`, `track-${"1.".repeat(63)}11-implementation-map.md`]) {
    for (const spelling of [name, `\`${name}\``, `[map](${name})`]) {
      assert.equal(references(spelling, "track-workflow.md")[0]?.target, `variable:${name}`, spelling);
    }
  }
  for (const name of ["maps.md", "roadmap.md", "baselinemap.md", "track-map.md", "root-implementation-map.md", "track-1-baseline-maps.md", "track-0-baseline-map.md", "track-01-implementation-map.md", "track-1.0-baseline-map.md", "track-1-implementation-maps.md", "track-9007199254740992-baseline-map.md", `track-${"1.".repeat(64)}1-baseline-map.md`]) {
    assert.equal(references(name, "track-workflow.md")[0]?.target, name, name);
    assert.throws(() => coverage(scan({ ...sources, "track-workflow.md": sources["track-workflow.md"] + "\nRead " + name })), /unknown reference/);
  }
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
  for (const prefix of ["/tmp/slate checkout/docs/", "C:\\slate checkout\\docs\\"]) {
    assert.deepEqual(references(`Read <${prefix}track-workflow.md>.`, "doctrine-0", prefix), references(`Read <${directory}track-workflow.md>.`, "doctrine-0"));
  }
  for (const condition of ["ordinary split proposal", "early note or owner triage"]) {
    const withoutBacking = occurrences.map((r: any) => r.condition === condition ? { ...r, reason: "Control exclusion." } : r);
    assert.throws(() => coverage(scan(sources), withoutBacking), /unbacked read/);
  }
  const staleMapContext = occurrences.map((r: any) => r.context === "cf9dbb7f52b8b3df82a0440ca5c7560eceb6e7d3ad445282524dd63bcc5aa489" ? { ...r, context: "0".repeat(64) } : r);
  assert.throws(() => coverage(scan(sources), staleMapContext), /unknown reference|stale/);
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

type Entry = { id: string, phase: number, plans: string[] };
// Conditions remain part of identity even when two conditions select the same bytes.
function readSet(entries: Read[]): unknown[] {
  const grouped = new Map<string, Span[]>();
  for (const [id, , condition, recipient, selectors] of entries) {
    const key = JSON.stringify([id, condition, recipient]);
    grouped.set(key, [...(grouped.get(key) ?? []), ...sections(source(id), selectors)]);
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([key, spans]) => [key, union(spans)]);
}
function expectedAccumulation(phase: number, scenario: string, maximum: boolean): Read[] {
  const [publishing, plan] = scenario.split(" ");
  return (reads as Read[]).filter((r) => r[1] <= phase &&
    (r[2] === "always" || r[2] === "publishing" && publishing === "on" ||
     r[2] === "nested" && plan === "nested" ||
     maximum && !["always", "publishing", "nested"].includes(r[2])));
}
function noDesignRead(...sets: Read[][]): void {
  for (const set of sets) assert.ok(set.every(([id]) => id !== "DESIGN_FORMAT_DOC"), "worker reference in orchestrator reads");
}

test("design-reference permissions do not follow occurrence registration", () => {
  const assignment = "Give design authors the summary, action type, decision inputs and task read limits.\nName [design-format.md](design-format.md) for design writing, [maps.md](maps.md)\nfor map writing or composition. Never read either, even on worker failure.";
  const publication = "Maps and designs have soft guidelines of about 1,500 and 2,500 words.\nDiagrams do not count. The map reference is 3726 bytes per full read.\nSee [maps.md](maps.md) for its worker readers. The design reference is 3369 bytes\nper full read by a design author, with a 3,369-byte bound. Name\n[design-format.md](design-format.md) in design-writing tasks without reading it.\nThe orchestrator never reads it, including on worker failure. Count worker\nreads again on each repeat. Worker reads, record text and composed drafts\nare separate costs outside the fixed orchestrator rows.";
  const authorized = scan({ "track-workflow.md": assignment, "context-budget.md": publication })
    .filter((entry) => entry.target === "design-format.md");
  const onlyDesign = (inputs: Record<string, string>, roster = occurrences) => {
    const selected = roster.filter((r: any) => r.target === "design-format.md");
    assert.equal(referenceOnly.DESIGN_FORMAT_DOC, "Worker-only design reference, no orchestrator read duty.");
    assert.ok(selected.every((entry: any) => entry.reason === referenceOnly.DESIGN_FORMAT_DOC && !entry.recipient));
    const keys = (items: any[]) => items.map(({ source, context }) => JSON.stringify([source, context])).sort();
    assert.deepEqual(keys(selected), keys(authorized), "authorized design reference classification");
    assert.deepEqual(keys(scan(inputs).filter((r) => r.target === "design-format.md")), keys(authorized), "authorized design reference contexts");
    for (const [file, expected] of [["track-workflow.md", assignment], ["context-budget.md", publication]] as const)
      assert.equal(inputs[file]?.split(expected).length, 2, "complete authorized instruction");
  };
  const inputs = Object.fromEntries(readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md")).map((file) => [file, readText(join(directory, file))]));
  onlyDesign(inputs);
  const repeated = "[first](design-format.md) [second](design-format.md)";
  const sameLine = references(repeated, "track-workflow.md");
  const context = createHash("sha256").update(repeated).digest("hex");
  assert.deepEqual(sameLine, Array(2).fill({ source: "track-workflow.md", target: "design-format.md", context }));
  for (const sentence of [
    "Read design-format.md.",
    "Read [the reference][author].\n[author]: design-format.md",
    "Read the reference\n[here](design-format.md).",
    "On worker failure, read design-format.md.",
    "On resume, read design-format.md.",
    "The adversary reads design-format.md.",
  ]) {
    const extra = { "track-workflow.md": sentence };
    const updated = { ...inputs, "track-workflow.md": inputs["track-workflow.md"] + "\n" + sentence };
    assert.throws(() => onlyDesign(updated), /authorized design reference contexts/);
    const added = scan(extra).filter((r) => r.target === "design-format.md")
      .map((r) => ({ ...r, count: 1, reason: referenceOnly.DESIGN_FORMAT_DOC }));
    assert.ok(added.length > 0);
    assert.throws(() => onlyDesign(updated, [...occurrences, ...added]), /authorized design reference classification/);
  }
  assert.throws(() => onlyDesign({ ...inputs, "review-rules.md": "Read design-format.md." }));
  assert.throws(() => onlyDesign(inputs, occurrences.map((r: any) =>
    r.target === "design-format.md" ? { ...r, recipient: "orchestrator" } : r)));
  for (const condition of ["always", "worker failure", "resume"])
    assert.throws(() => noDesignRead([...reads, ["DESIGN_FORMAT_DOC", 1, condition, "orchestrator", []]]), /worker reference/);
  const withoutExport = { ...exported };
  delete withoutExport.DESIGN_FORMAT_DOC;
  assert.throws(() => membership(withoutExport), /missing export/);
});

function assertEntry(actual: Read[], entry: Entry, scenario: string, maximum: boolean, through = entry.phase): void {
  // mode.ts doctrine rules require fresh-session rereads and nested resume loading.
  // track-workflow.md § Resume order and reconciliation steps 4 and 7 and
  // recursive-workflow.md § Resume and folder forks reconcile inherited focus records.
  // blast-radius.md § Focus areas and their gates and § Review coverage and the
  // coverage register supply the definitions for renewed focus judgment.
  // Every nested phase-1 resume can reconcile parent records, including optional handoffs.
  // Unchanged records need no new definitions. Root research has no focus record.
  const extra: Read[] = entry.phase === 1 && entry.id !== "research" && scenario.endsWith("nested") && maximum ? [
    ["BLAST_RADIUS_DOC", 1, "renewed focus judgment", "orchestrator",
      ["Focus areas and their gates", "Review coverage and the coverage register"]],
  ] : [];
  noDesignRead(actual);
  assert.deepEqual(readSet(actual), readSet([...expectedAccumulation(through, scenario, maximum), ...extra]),
    `entry set ${entry.id} ${entry.phase} ${scenario} maximum=${maximum} through=${through}`);
}

test("session entry sets, continuation, and transfer controls", { timeout: 10000 }, async () => {
  const expected = [
    ["research", 1, ["ordinary", "nested"]], ["design-track", 1, ["nested"]],
    ["code-track", 7, ["ordinary", "nested"]], ["second-code-boundary", 7, ["ordinary", "nested"]],
    ...Array.from({ length: 8 }, (_, i) => ["parent-return", i + 2, ["ordinary", "nested"]]),
    ...Array.from({ length: 9 }, (_, i) => ["optional-handoff", i + 1, ["ordinary", "nested"]]),
  ];
  assert.deepEqual(sessionEntries.map((e: Entry) => [e.id, e.phase, e.plans]), expected);
  assert.equal(total(resumeReads), 29762);
  const doctrines = await Promise.all([render(false), render(true)]);
  for (const entry of sessionEntries as Entry[]) for (const scenario of scenarios as string[]) {
    if (!entry.plans.includes(scenario.split(" ")[1]!)) continue;
    for (const maximum of [false, true]) {
      const actual = sessionReads(entry, scenario, maximum) as Read[];
      assertEntry(actual, entry, scenario, maximum);
      const doctrine = bytes(doctrines[scenario.startsWith("on") ? 1 : 0]!.split(directory).join(""));
      assert.equal(doctrine + total(actual), phaseTotals[`${entry.phase} ${scenario}`]![maximum ? 1 : 0]!
        + (entry.phase === 1 && entry.id !== "research" && scenario.endsWith("nested") && maximum ? 29762 : 0));
      checkLimit(doctrine + total(actual), limits[`${entry.phase} ${scenario}`][maximum ? 1 : 0], entry.id);
      // Required successor reread and conditional-read omissions must fail independently of bytes.
      assert.throws(() => assertEntry(actual.filter((r) => r[0] !== "TRACK_WORKFLOW_DOC"), entry, scenario, maximum), /entry set/);
      if (maximum) assert.throws(() => assertEntry(actual.filter((r) => r[2] !== "rationale"), entry, scenario, maximum), /entry set/);
      const released = actual.map((r): Read => r[0] === "CHANGE_RECORDS_DOC" ?
        [r[0], r[1], r[2], r[3], ["Manual records and safe writes"]] : r);
      assert.throws(() => assertEntry(released, entry, scenario, maximum), /entry set/);
      for (let through = entry.phase; through <= 9; through++) {
        const continued = sessionReads(entry, scenario, maximum, through) as Read[];
        assertEntry(continued, entry, scenario, maximum, through);
        const resumeExtra = entry.phase === 1 && through === 1 && entry.id !== "research" && scenario.endsWith("nested") && maximum ? 29762 : 0;
        assert.equal(doctrine + total(continued), phaseTotals[`${through} ${scenario}`]![maximum ? 1 : 0]! + resumeExtra,
          `measured session total ${entry.id} ${through} ${scenario} maximum=${maximum}`);
        assert.deepEqual(readSet(continued), readSet([...actual, ...expectedAccumulation(through, scenario, maximum)]));
        checkLimit(doctrine + total(continued), limits[`${through} ${scenario}`][maximum ? 1 : 0], `continued ${entry.id}`);
      }
      if (entry.phase === 1 && entry.id !== "research" && scenario.endsWith("nested") && maximum) {
        for (const selector of ["Focus areas and their gates", "Review coverage and the coverage register"]) {
          const omitted = actual.map((r): Read => r[2] === "renewed focus judgment" ?
            [r[0], r[1], r[2], r[3], r[4].filter((s) => s !== selector)] : r);
          assert.throws(() => assertEntry(omitted, entry, scenario, maximum), /entry set/);
        }
        assert.throws(() => assertEntry(actual.filter((r) => r[2] !== "renewed focus judgment"), entry, scenario, maximum), /entry set/);
      }
    }
  }
  const research = sessionEntries[0] as Entry;
  const continued = sessionReads(research, "off ordinary", true, 5) as Read[];
  assert.ok(total(continued) > total(sessionReads(research, "off ordinary", true)));
  assert.throws(() => assertEntry(continued.filter((r) => r[1] >= 5), research, "off ordinary", true, 5), /entry set/);
  assert.throws(() => sessionReads(research, "off ordinary", false, 0), /invalid session/);
  assert.throws(() => sessionReads(sessionEntries[1], "off ordinary"), /invalid session/);
  assert.throws(() => sessionReads(research, "off ordinary", false, 10), /invalid session/);
  const optional = (sessionEntries as Entry[]).find((e) => e.id === "optional-handoff" && e.phase === 1)!;
  const current = sessionReads(research, "off nested", true) as Read[];
  const successor = sessionReads(optional, "off nested", true) as Read[];
  assert.notDeepEqual(readSet(current), readSet(successor), "resume definitions distinguish a fresh session");
  for (const outcome of ["failed", "cancelled", "resume"]) {
    assert.equal(startsSession(outcome), false);
    const retained = transferReads(outcome, current, optional, "off nested", true) as Read[];
    assert.strictEqual(retained, current, `${outcome} retains the current session reads`);
    assert.deepEqual(readSet(retained), readSet(current));
    assert.notDeepEqual(readSet(retained), readSet(successor));
  }
  for (const multiTrack of [false, true]) {
    assert.equal(requiresBoundary(multiTrack), multiTrack, "only multi-track work requires a boundary");
    assert.equal(startsSession("transferred"), true, "any completed transfer starts a session");
    assert.deepEqual(readSet(transferReads("transferred", current, optional, "off nested", true)), readSet(successor));
  }
  // Doctrine reuse exceptions apply only to text already in this session.
  for (const publishing of [false, true]) {
    const doctrine = doctrines[publishing ? 1 : 0]!;
    assert.match(doctrine, /Read change-records\.md for every change/);
    assert.match(doctrine, /At planning\/resume, load recursive-workflow\.md/);
    assert.match(doctrine, /Before review dispatch[^]*Read unless in context/);
    assert.match(doctrine, /Design rationale:[^]*Skip if in context/);
    assert.match(doctrine, /already in context/);
  }
  const workflow = source("TRACK_WORKFLOW_DOC");
  assert.match(workflow, /successor performs Resume reconciliation/);
  assert.match(workflow, /second handoff before implementation/);
  assert.match(workflow, /Single-track changes are exempt/);
  assert.match(workflow, /Cancellation, failure, and .*resume.* do not satisfy the boundary/);
  assert.match(workflow, /coverage register, proved\n   focus areas, risk record, and live diff/);
  assert.match(source("RECURSIVE_WORKFLOW_DOC"), /Reconcile the tree, reports, ranges, review coverage, focus records, and live difference/);
});

test("approved research limits reject further growth", () => {
  assert.deepEqual(limits["1 off ordinary"], [79389, 152344]);
  assert.doesNotThrow(() => checkLimit(79389, 79389, "required boundary"));
  assert.doesNotThrow(() => checkLimit(152344, 152344, "maximum boundary"));
  assert.throws(() => checkLimit(79390, 79389, "required overflow"), /excess 1/);
  assert.throws(() => checkLimit(152345, 152344, "maximum overflow"), /excess 1/);
});

test("both original-base Git helpers isolate German parent settings", { timeout: 10000 }, () => {
  assert.equal(spawnSync("git", ["init", scratch], { encoding: "utf8" }).status, 0);
  for (const file of ["test/doctrine-contract.test.ts", "verification/resolver-checks.mjs"]) {
    const text = readText(file);
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
