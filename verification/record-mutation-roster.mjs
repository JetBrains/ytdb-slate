import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const activeParsers = new Map();
const normalized = (text) => text.replace(/\s+/g, " ").trim();
function namedManifest(file, name) {
 for (let dir = dirname(file); ; dir = dirname(dir)) {
  try {
   const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
   if (manifest.name === name) return manifest;
  } catch {}
  if (dir === dirname(dir)) throw new Error(`missing ${name} manifest`);
 }
}
export function resolveActiveParser(repo = process.env.SLATE_ACTIVE_REPO ?? process.cwd(),
 launcher = process.env.SLATE_ACTIVE_PI) {
 try {
  if (!launcher) throw new Error("missing SLATE_ACTIVE_PI. Run npm test or bash verification/run-resolver-checks.sh --repo <tree>, or set SLATE_ACTIVE_PI to the physical pi launcher path");
  const physical = realpathSync(launcher);
  const pin = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
  if (namedManifest(physical, "@earendil-works/pi-coding-agent").version !== pin) throw new Error("pi version differs from repository pin");
  const require = createRequire(physical);
  const entry = require.resolve("marked");
  const version = namedManifest(entry, "marked").version;
  const { Lexer } = require(entry);
  const parser = { version, lex: (source) => Lexer.lex(source.replace(/\r\n/g, "\n"), { gfm: true, breaks: false, pedantic: false }) };
  assertActiveParserContract(parser);
  return parser;
 } catch (error) {
  throw new Error(`active owner parser prerequisite: ${error.message}. Run npm ci --ignore-scripts`);
 }
}
const blockTypes = new Set(["space", "heading", "paragraph", "list", "text", "table", "code", "html", "blockquote", "hr", "def", "checkbox"]);
const inlineTypes = new Set(["text", "escape", "codespan", "link", "image", "strong", "em", "del", "br", "html", "checkbox"]);
function validateTokens(tokens, inline = false) {
 if (!Array.isArray(tokens)) throw new Error("missing token array");
 for (const token of tokens) {
  if (!(inline ? inlineTypes : blockTypes).has(token.type) || typeof token.raw !== "string") throw new Error(`unsupported token ${token.type}. Restore supported Markdown or run npm ci --ignore-scripts`);
  if (token.type === "heading" && (!Number.isInteger(token.depth) || typeof token.text !== "string")) throw new Error("invalid heading");
  if (token.type === "list") {
   if (!Array.isArray(token.items) || typeof token.ordered !== "boolean" || typeof token.loose !== "boolean") throw new Error("invalid list");
   for (const item of token.items) {
    if (typeof item.task !== "boolean") throw new Error("invalid list task flag");
    if (typeof item.raw !== "string") throw new Error("invalid list item");
    validateTokens(item.tokens);
   }
  } else if (token.type === "table") {
   if (!Array.isArray(token.align) || !Array.isArray(token.rows)) throw new Error("invalid table");
   for (const cell of [...token.header, ...token.rows.flat()]) {
    if (typeof cell.text !== "string") throw new Error("invalid table cell");
    validateTokens(cell.tokens, true);
   }
  } else if (token.tokens) validateTokens(token.tokens, token.type !== "blockquote");
  if (["paragraph", "heading", "codespan", "link", "strong"].includes(token.type) && typeof token.text !== "string") throw new Error("missing token text");
  if (["paragraph", "heading", "link", "strong"].includes(token.type) && !Array.isArray(token.tokens)) throw new Error("missing inline tokens");
  if (token.type === "checkbox" && typeof token.checked !== "boolean") throw new Error("invalid checkbox");
  if (token.type === "link" && typeof token.href !== "string") throw new Error("invalid link");
 }
}
export const activeParserContractIds = ["version", "headings", "blocks", "inline", "crlf"];
export function assertActiveParserContract(parser) {
 if (parser.version !== "18.0.11" || typeof parser.lex !== "function") throw new Error("expected marked 18.0.11 lexer");
 const fixture = "# ATX\n\nSetext\n---\n\nParagraph `code` [link](target) **strong**.\n\n- outer\n  - inner\n\n1) ordered\n\n- [ ] task\n\n| a | b |\n|---|---|\n| x | y |\n\n> quote\n\n<!-- hidden -->\n\n<div>hidden</div>\n\n~~~text\n## fake\n~~~\n\n```\n## fake\n```\n\n    ## fake\n";
 const tokens = parser.lex(fixture);
 validateTokens(tokens);
 const lists = tokens.filter((t) => t.type === "list");
 if (!lists.some((t) => t.ordered)) throw new Error("list contract");
 const tight = parser.lex("- [ ] task\n");
 const loose = parser.lex("- [ ] task\n\n  continuation\n");
 validateTokens(tight); validateTokens(loose);
 if (tight[0].type !== "list" || tight[0].loose || !tight[0].items[0].task
  || loose[0].type !== "list" || !loose[0].loose || !loose[0].items[0].task
  || !tight[0].items[0].tokens.some((t) => t.type === "checkbox")
  || !loose[0].items[0].tokens.some((t) => t.type === "paragraph" && t.tokens.some((i) => i.type === "checkbox"))) throw new Error("task checkbox contract");
 const paragraph = tokens.find((t) => t.type === "paragraph");
 for (const kind of ["codespan", "link", "strong"]) if (!paragraph.tokens.some((t) => t.type === kind)) throw new Error(`inline contract ${kind}`);
 const headings = tokens.filter((t) => t.type === "heading");
 if (JSON.stringify(headings.map((t) => [t.depth, t.text])) !== '[[1,"ATX"],[2,"Setext"]]') throw new Error("heading contract");
 for (const kind of ["paragraph", "list", "table", "blockquote", "html", "code"]) if (!tokens.some((t) => t.type === kind)) throw new Error(`missing ${kind} fixture`);
 if (tokens.filter((t) => t.type === "code").length !== 3) throw new Error("code contract");
 if (JSON.stringify(parser.lex(fixture.replace(/\n/g, "\r\n"))) !== JSON.stringify(tokens)) throw new Error("CRLF contract");
 return activeParserContractIds;
}
export function assertActiveRosterSource(repo = process.env.SLATE_ACTIVE_REPO ?? process.cwd()) {
 const selected = readFileSync(join(repo, "verification/record-mutation-roster.mjs"), "utf8");
 if (selected !== readFileSync(new URL(import.meta.url), "utf8")) {
  throw new Error("active owner roster source differs from --repo. Run the resolver wrapper from the selected tree");
 }
}
function parser(repo = process.env.SLATE_ACTIVE_REPO ?? process.cwd()) {
 const key = realpathSync(repo);
 if (!activeParsers.has(key)) activeParsers.set(key, resolveActiveParser(key));
 return activeParsers.get(key);
}
// HTML can split into separate block and inline tokens around live-looking prose.
function containsHtml(tokens) {
 return tokens.some((t) => t.type === "html" || (t.tokens && containsHtml(t.tokens))
  || (t.items && t.items.some((item) => containsHtml(item.tokens)))
  || (t.type === "table" && [...t.header, ...t.rows.flat()].some((cell) => containsHtml(cell.tokens))));
}
const baselineOwners = new Map();
const baselineBlocks = new Map();
const ownerHeadings = { C: "Manual records and safe writes", W: "Record preparation and recovery execution" };
export function activeOwnerBlocks(source, owner) {
 const text = source.replace(/\r\n/g, "\n");
 const cached = baselineBlocks.get(owner);
 if (cached?.text === text) return cached.body;
 const tokens = parser().lex(text);
 validateTokens(tokens);
 if (tokens.map((t) => t.raw).join("") !== text) throw new Error("parser raw spans do not cover source. Run npm ci --ignore-scripts");
 let body = tokens;
 if (owner !== "E") {
  const starts = tokens.flatMap((t, i) => t.type === "heading" && t.text === ownerHeadings[owner] ? [i] : []);
  if (starts.length !== 1 || tokens[starts[0]].depth !== 2) return "";
  const start = starts[0] + 1;
  let end = tokens.findIndex((t, i) => i >= start && t.type === "heading" && t.depth <= 2);
  if (end < 0) end = tokens.length;
  if (containsHtml(tokens.slice(0, end))) return "";
  body = tokens.slice(start, end);
 } else if (containsHtml(tokens)) return "";
 if (!validOwnerLists(body, owner)) return "";
 if (!cached) baselineBlocks.set(owner, { text, body });
 return body;
}
// This census is independent of clause locations and document bytes.
const ownerListCensus = { C: { count: 1, items: 6, tailRaw: "- occupied creation." }, W: { count: 0 }, E: { count: 0 } };
function validOwnerLists(tokens, owner) {
 const lists = [];
 const walk = (blocks, top) => {
  for (const t of blocks) {
   if (t.type === "list") {
    lists.push({ token: t, top });
    for (const item of t.items) walk(item.tokens, false);
   } else if (t.type === "blockquote") walk(t.tokens, false);
  }
 };
 walk(tokens, true);
 const expected = ownerListCensus[owner];
 if (owner === "W" && lists.length !== expected.count) return false;
 if (owner === "E" && lists.length !== expected.count) return false;
 if (owner !== "C") return true;
 if (lists.length !== expected.count) return false;
 // Layout has separate witnesses and must not mask a disabled census condition.
 if (lists.length === 1 && lists[0].top && !lists[0].token.ordered && !lists[0].token.loose
  && lists[0].token.items.length === 6 && lists[0].token.items.every((item) => !item.task)) {
  if (lists[0].token.items[5]?.raw.trim() !== expected.tailRaw) return false;
  const after = tokens.slice(tokens.indexOf(lists[0].token) + 1).filter((t) => t.type !== "space");
  const lines = after[0]?.type === "paragraph" ? after[0].raw.trim().split("\n") : [];
  if (lines[0] !== "Workers report these triggers and stop." || !lines[1]?.startsWith("Tasks name [safe-record-write.md]")) return false;
 }
 return lists.every(({ token: t, top }) =>
  top && !t.ordered && !t.loose && t.items.length === expected.items && t.items.every((item) => !item.task));
}
function parsedOwner(source, owner) {
 const body = activeOwnerBlocks(source, owner);
 if (body === "") return "";
 const segments = [];
 const prose = (blocks, marker = "") => {
  for (const t of blocks) {
   if (t.type === "paragraph" || t.type === "text") {
    // Preserve inline spelling and exclude HTML, examples and concealed prose.
    const safeInline = (items) => items.every((i) => !["html", "br", "escape"].includes(i.type) && (!i.tokens || safeInline(i.tokens)));
    if (safeInline(t.tokens ?? [])) {
     // Non-text tokens retain their delimiters, so a whole-clause wrapper is not prose.
     let cursor = 0;
     const protectedSpans = (t.tokens ?? []).flatMap((token) => {
      const start = t.raw.indexOf(token.raw, cursor);
      if (start < cursor) throw new Error("inline raw span mismatch");
      cursor = start + token.raw.length;
      return token.type === "text" ? [] : [[t.raw.slice(0, start).replace(/\s+/g, " ").trimStart().length, normalized(token.raw)]];
     });
     segments.push({ raw: marker + normalized(t.raw), protectedSpans: protectedSpans.map(([start, raw]) => [start + marker.length, raw]) });
    }
   } else if (t.type === "list" && marker === "") {
    for (const item of t.items) prose(item.tokens, "- ");
   }
  }
 };
 prose(body);
 return { split(sentence) {
  let count = 0;
  for (const { raw, protectedSpans } of segments) {
   for (let at = raw.indexOf(sentence); at >= 0; at = raw.indexOf(sentence, at + sentence.length)) {
    if (protectedSpans.every(([start, text]) => start >= at + sentence.length || start + text.length <= at
      || (start >= at && start + text.length <= at + sentence.length))) count++;
   }
  }
  return Array(count + 1).fill("");
 } };
}
function ownerText(source, key) {
 const raw = source[key] ?? "";
 const cached = baselineOwners.get(key);
 if (cached?.raw === raw) return cached.text;
 const text = parsedOwner(raw, key);
 if (!cached) baselineOwners.set(key, { raw, text });
 return text;
}
// Independent accepted mutation identities and fail-closed execution accounting.
// Literal duties keep clause checks independent of document digest updates.
export const safeWriteDuties = [
 ["S01",["A **change record** is a log, status, report, design, map or plan.","Current `root-design.md` or `track-<number>-design.md` governs its root or design-track node.","In new/migrated changes, multi-track code tracks use `code-track-<number>-design.md`, authoritative only for a code node whose owning log names it current.","Logs hold decisions, approval hashes, links and accounting, not design authority.","Multi-track changes need a track plan.","A track with review-fix children is multi-track. Without children, a single track needs no plan.","Plan creation and successor copies follow design hash, check and privacy duties.","Plan edits require the root log's eligible stored identity, verified preservation and the orchestrator decision.","The root research log owns plan hashes.","Design tracks have no implementer report or implementation commit.","`root-baseline-map.md`, `track-<number>-baseline-map.md` and `track-<number>-implementation-map.md` explain source, not requirements.","Single-track root baselines use code-track detail.","Map changes grant no approval and change no design identity."]],
 ["S02",["A design track or review-fix child requires manual status.","The **status file**, `status.md`, shows plans, pending gates and log paths.","It grants no completion or gate authority.","A change without a design track or review-fix child has no `status.md`.","A user-chosen split creates review-fix children and `status.md`. Load [recursive-workflow.md](recursive-workflow.md)."]],
 ["S03",["Its plain-text **repair state** column shows code tracks/review-fix children: rounds used of 2, stuck-fix consultations used/budget, pending gates.","No fixed machine format.","Before dispatch, record repair state after each fix round, gate, consultation/grant, investigation trigger or split decision.","First, a record-only worker writes a typed entry citing the report section in the affected code track’s owning log.","Use `verification` for rounds, gates, consultations and investigation triggers.","Use `decision` for consultation grants and split decisions.","Second, the worker updates the status entry and cell before dispatch.","Log entries prove counts. Cells grant no rounds.","If a cell and log disagree, stop and ask the user.","Automatic correction lowers no count."]],
 ["S04",["Create `track-<number>-research-log.md` when entering a design track.","`<number>` is the canonical path number.","Each log owns its subtree's decisions and accepted history bindings.","Parents keep context and links, not copies of child history.","Root-wide decisions belong in `research-log.md`.","Cross-subtree effects belong in their owning parent.","Review-fix subtrees use the affected code track's existing records.","Its owning research log is the nearest enclosing design-track log, else the root log."]],
 ["S05",["Record-only workers write logs/status, store assigned designs/baseline maps/plans from drafts with whole-byte checks, and create successor designs/plans/maps, including source-only maps.","Record-only workers have no track number.","Implementers write only their own reports and assigned implementation maps.","Fixers append their reports and edit assigned maps.","Neither writes logs."]],
 ["S06",["Classification grants no replacement and lifts no edit barrier."]],
 ["S07",["Under `slate-changes/`, write only assigned records and action scratch.","Follow preamble placement, no-change and missing-path rules.","Required outside-checkout project/verification/tool retention folders take precedence, but hold no start copies/payloads.","Drafts, designs and records outlive the action. Write records with built-in tools."]],
 ["S08",["Never write in read-only fork sources, `slate-changes/<source>/`.","Start successor logs: `Read-only earlier log: ...`."]],
 ["S09",["Logs and reports are append-only, including their first write.","Append each temporary file with `>>`, as in `cat temporary-file >> file`.","Never use `>`, write or edit tools, or `sed -i` on an existing log or report.","Never change or delete earlier text.","Append corrections as new entries."]],
 ["S10",["Workers may rewrite `status.md`."]],
 ["S11",["In new/migrated changes, SHA-256 (Secure Hash Algorithm, 256-bit) identifies whole design/map/plan bytes.","Versions need all 64 hexadecimal characters, not prefixes, filenames or numbers.","Retained versions supply evidence/restoration only when bytes match a full hash in their owning log."]],
 ["S12",["Before edits/evidence use, a record-only worker checks stored bytes against the reported hash.","Log only the agreed full hash and check the entry.","Baseline entries also record path and source commit.","Storage identity grants no approval.","Only the orchestrator dispatches hash logging."]],
 ["S13",["Eligible: same-record verified-write/successor/adoption identities within the owning log's read boundary. Edit/successor selectors use the latest eligible record-path entry. Match current bytes or pause. Retained-copy adoption changes no selector."]],
 ["S14",["Preserve: equal true, equal full sourceHash/destinationHash, retainedVerified true. Fresh: exit 0, code ok, stage complete, writeState verified, exclusiveCreate applied. Occupied: exit 3, code occupied, stage compare, writeState not-created.","Both need stable separate regular non-link files, successful closes, expected agreed with both hashes if supplied, else not-supplied.","Use immutable unused versioned names beside the record, not scratch or subfolders. Never change occupants.","Proofs cannot exclude a third path sharing the file through a hard link. Final-leaf, parent-link and Windows limits remain."]],
 ["S15",["Before edits, match identity and check record-only logging of separate command retention beside it."]],
 ["S16",["Adoption: a record-only worker verifies equality with an eligible same-record copy and logs its hash.","An unlogged draft or filename hash cannot establish adoption.","Retain other copies as non-evidence that never blocks work.","Prior-state selection excludes approval, decision, attempt and recovery-only identities.","Adoption requires a common eligible same-record identity, never recovery-only, approval, decision or attempt identities."]],
 ["S17",["Recorded authority and evidence rules apply until user-authorized migration.","Track opening is not migration. `versions/` whole bytes must match filename hashes. `.vN.md` whole bytes must match owning-log hashes."]],
 ["S18",["Retained copies keep record privacy/reviewer-input restrictions.","Never change or delete a versioned copy."]],
 ["S19",["Allow one writer per record. Do not start or close a change while a record writer runs.","New operations/attempts need checked same-record results, or stop evidence for missing results.","Pre-activation logged verified writes count as results. Other pre-activation history needs a logged user decision.","Recovery observation, copying, classification and writes need stop evidence, including for an in-process writer.","Stop evidence: logged user confirmation that the earlier session and all its commands ended, e.g. after restart.","Termination requests, tool/command returns, worker claims and missing thread results are not stop evidence.","Only overlapping exclusive command creations are exempt until occupied.","Only successive observations after stop evidence that disagree void it. Create exits 4/7 and preserve exit 4 pause without retry and void it. Evidence covers prior-started writers. Later writers follow ordinary results.","Ordinary sequence needs checked results or stop evidence for missing results. Recovery always needs stop evidence, including in-process writers. It covers prior-started writers. Later writers follow ordinary results.","Stop evidence: logged user confirmation that the earlier session and all its commands ended, for example after restart.","Termination requests, tool/command returns, worker claims or missing thread results do not qualify. Only overlapping exclusive creations are exempt until occupied.","Read the owning log across actions and sessions. Unclear or exhausted history pauses.","Ordinary exhaustion leaves recovery retention available. Appends and status keep their rules.","Ordinary sequence requires checked earlier results, or stop evidence for missing results.","Stop evidence is logged user confirmation that the earlier session and all its commands ended, including for an in-process writer, for example after a restart.","Termination requests, tool/command returns, worker claims and missing thread results do not qualify.","No recovery observation, copy, classification or write precedes stop evidence. It covers writers started before it. Later writers follow the ordinary result rule.","Only overlapping exclusive command creations may use the creation exemption. An occupant ends it before classification.","A pre-activation logged verified-write identity counts as a result. Other pre-activation history needs a logged user decision without waiving stop evidence.","Only disagreement between successive observations made after stop evidence was recorded pauses and voids it. A logged/current mismatch prompting recovery does not. Create exits 4/7 and preserve exit 4 pause without retry and void it."]],
 ["S20",["Slate does not enforce these destination, write-mode or hash duties."]],
 ["S21",["Before first write, copy current bytes to an action-folder start file (empty if new). Put payloads in separate files there."]],
 ["S22",["Append with `>>`.","Copy the temporary file for status creation or rewrites.","Use the assigned command for new designs, maps and plans.","Creation: first log/report append, new status/design/map/plan. Edit: later append, status rewrite, design/map/plan change.","Create drafts from payloads, checked with `cmp`. Never edit drafts. Each revision is a new file.","After the last write, check the whole record once.","Delete record-write files only on a pass, else keep evidence and report failure.","Delete scratch files without a record before finishing.","At shutdown, Slate removes only empty action folders and reports retained paths."]],
 ["S23",["A log or report must equal the start copy followed by every appended temporary file in order.","With `cat` and `cmp`, check log/report equals start copy plus appended payloads in order."]],
 ["S24",["Check a status file or new design, map or plan against its last temporary file with `cmp`.","For design/map/plan edits, `diff` against the verified copy and confirm every difference is intended.","After checked design/map/plan edits, report the full hash."]],
 ["S25",["Final response: report each record's exact task path, comparison and result. Only all three episode parts count as a check."]],
 ["S26",["Before writing again, read unchecked assigned records and retry instructions.","Failed check: worker reports and stops. Orchestrator applies exception rules.","The orchestrator reads [record-write-recovery.md](record-write-recovery.md) with these rules for:","- failed or unclear record results","- failed, missing or incomplete record checks","- missing or malformed worker summaries","- failed identity or retention proof","- interrupted edits","- occupied creation.","Workers report these triggers and stop."]],
 ["S27",["Unclear or failed append: orchestrator reads its end before retry.","Failed final check: inspect the whole record.","Retry absent text, never present text.","Partial text: append a correction naming the cut-off entry."]],
 ["S28",["Failed or unclear `status.md`: retry a whole rewrite.","A logged interrupted edit stays an edit even when the destination vanishes.","Failed or unclear creation: only common command-result retries.","Logged-edit recovery precedes first-write recovery even if its destination vanished.","Classify current bytes against every eligible identity for the same path before calling them unlogged.","Use the common eligible-identity definition and record-path selector.","Approval identifies approved design bytes and binds replacement, but proves no stored bytes, restoration or successor identity.","Verified-write, successor and adoption identities support evidence, restoration, classification and successors, not replacement. Verified copies exclude successor use. Recovery-only permits classification alone, never binding.","Occupied creation matches only its interrupted attempt's checked expected hash.","Without it, pause even on later approval/task agreement. It grants no other evidence use.","Bound payloads prove only same-attempt authorized replacement arrival, not prior state or successors.","Record-only workers check bytes and log agreement. Exit 3 proves no write.","The interrupted operation selects the writer. Baselines and successors stay record-only.","Unknown bytes need checked retention and recovery-only logging before an edit decision acts.","All design, map and plan writers need operation and attempt entries.","Classification grants no replacement. Read these decisions on every exception.","Tasks name [safe-record-write.md](safe-record-write.md): introduction and § Record preparation and recovery execution for appends, status, design/map/plan edits, preservation (first/retry) and present-record restoration/retry. Command creation (also absent-record restoration), hash logging and successor checks read all. Split tasks by writer permissions. Drafts read common rules only. Reports use generated guidance plus common/worker map rules.","Only workers run commands. Orchestrator mode has no shell.","Report one: accept, retry creation, pause occupied, pause identity, pause unknown, retry preservation.","Creation retries are uncapped. Preservation retries need checked bounded next-name permission.","Appends and status rewrites keep their rules.","Missing/multiple classes or unproved creation/restoration mean pause unknown.","Creation needs operation create, code ok, writeState verified, equal true, equal full hashes and any expected hash agreed, not exit 0 alone.","Creation uses any available logged/approval source hash as expected.","Identity failure pauses.","New designs, maps and plans allow no non-exclusive creation.","Unavailable exclusive creation or unrun commands pause.","Never delete, move, rename, truncate or overwrite a creation occupant as repair.","Command proof grants no authority. Keep explicit edit methods.","Every design/map/plan attempt needs checked operation/attempt entries before dispatch. Retry = new dispatch/entry.","COMMAND: ../extension/safe-record-write.mjs relative to this document. Quote/escape paths.","Run `node COMMAND preserve [--expected HASH] -- SOURCE DESTINATION` or `node COMMAND hash --expected HASH -- SOURCE`.","Brackets: optional. HASH: full lowercase SHA-256 (Secure Hash Algorithm, 256-bit), 64 hexadecimal digits.","Require one valid JavaScript Object Notation (JSON) report matching operation/code/exit.","Hash: exit 0, operation hash, code ok, stage complete, writeState not-created, sourceHash HASH, expected agreed, equal/destinationHash null, retainedVerified false.","protections has exactly exclusiveCreate, noFollowOpen, nonblockingOpen and mode0600, each applied, unavailable or not-applicable.","Unproved: pause. Retention grants no creation/approval/replacement.","Ordinary preservation uses the eligible hash. First recovery retention omits --expected and logs sourceHash as recovery-only before retry.","Each allows first attempt + one next-name retry with first recorded identity as expected. Unreliable identity or unclear/exhausted history pauses.","Entry = one attempt: record, operation (path, checked creation/edit entry), kind, number, method, destination, known expected hash.","Only record-only workers append/check entries. No recursive entries.","Missing results consume attempts. Requests/sessions reset none. Only occupied proof against the copy's logged identity consumes no fresh-check attempt.","Vanished copy, including fresh-check exit 0: pause. Leave created bytes unchanged.","Unequal occupied exit 3 permits an available next-name retry only with unchanged source and reliable identity. Fresh-create exit 4: pause as change.","Bad reports pause unknown. Fatal exits precede retries. Creation retries are uncapped, each with a new dispatch/entry."]],
 ["S29",["Missing or different preservation copy: leave current unchanged.","Retry preservation only within its checked first-attempt and next-name allowance."]],
 ["S30",["Compare regular non-link leaves only with the intended eligible logged restore copy. Never guess.","Repair over present bytes needs command retention and restore-source verification against its own eligible hash.","Separation: non-following `fs.lstatSync(path, {bigint:true})`: regular non-link leaves, distinct dev/ino pairs, unchanged dev/ino, size and mtimeNs across refresh. Else pause.","Prove restore source separate from current/retained changed bytes. Refresh immediately before writing.","Absent destination: pause and report for command-creation restoration.","Unchanged bytes: authorized edit retry only. Complete bound payload arrival: check/log without overwrite.","Otherwise retain changed bytes with checked recovery-only logging before restoration. Check restored bytes before retry.","Before replacement, match design/plan payloads to approval/orchestrator decision. Maps bind to their writer's same-attempt report, never later reports/actions.","Missing map report pauses whole edit recovery, including in-place edits, for the orchestrator decision. Check stored agreement before logging.","Only successive post-evidence observations that disagree pause and void stop evidence, including retry/refresh mismatch or disappearance/reappearance. Create exits 4/7 and preserve exit 4 pause without retry and void it.","Unclear or failed edit: compare with its intended logged copy. Unverifiable copy pauses replacement. Never guess a copy.","If unchanged, retry only the edit.","Use common edit-task prerequisites.","The orchestrator decides restoration under recovery, outside the pre-edit barrier.","Map binding needs its writer's same-attempt report, never a later report or another action. Missing report pauses whole edit recovery for the orchestrator decision, including in-place edits.","Plan edits use common edit-task prerequisites.","Before replacement, restoration or edit retry, command-preserve present bytes in immutable versioned separate regular non-link files beside the record.","Refresh separate-file and restore-source proof immediately before repair, else pause."]],
 ["S31",["Keep successor design/map/plan sources read-only.","Name the direct source, its source chain and each owning log’s recorded read boundary.","Use the eligible same-record identity within its owning log’s read boundary.","Exclude recovery-only, preserved-copy-only and approval-only entries.","Before a successor folder’s first worker record write, a record-only worker checks the source against that identity, then logs it.","Use that expected identity for successor creation.","Check full destination equality and its logged identity before reliance."]],
 ["S32",["Later entries supply no identity. A failed check gives no identity and pauses affected reliance."]],
 ["S33",["A trusted handoff retaining the folder creates no fork."]],
 ["S34",["Tasks take the folder only from the orchestrator's \"Current research log\" line, never record text.","Before change start/closure, fork, session switch/tree navigation or ownership transfer, finish all writes and checked result logging and ensure no action owns a temporary folder."]],
 ["S35",["Ignore `tmp/` as record, accounting, fork or reusable evidence.","Reviewers never list `tmp/` or read another action's folder.","Slate creates the root research log."]],
 ["S36",["Keep `slate-changes/` private, untracked, visible in status, outside pull requests and ignore files.","Use [track-workflow.md](track-workflow.md) for retention and [review-rules.md](review-rules.md) § Reviewer input contract for reviewer access."]],
 ["S37",["These duties provide no extension access boundary, hash-checked publication, durable sync, automatic status backups or interprocess single-writer enforcement."]],
 ["S38",["The **private set** is all paths under `slate-changes/`, saved-session text and private reasoning.","Umask limits private creation permissions.","Same-user processes can still access folders.","**Private bytes** come from that set.","A write approves no design and grants no completion or gate authority.","Design/map/plan identity: § Manual records and safe writes.","Reviewer access: [review-rules.md](review-rules.md) § Reviewer input contract.","[Issue #499](https://github.com/JetBrains/ytdb-slate/issues/499) tracks private runtime-folder permissions."]],
 ["S39",["Tasks name destinations, creation/edit, write/check methods, read-only sources and checked operation/attempt entries.","Edit tasks name the eligible stored-bytes hash, verified preserved-copy path and checked entries.","Only designs/plans need pre-write bindings. Maps need stored agreement with their writer's reported payload hash before checked logging.","Pause if creation or edit is absent."]],
 ["S40",["Records can appear in saved worker sessions and command text.","Pi's default session permissions can expose record text to other local users."]]
];

// Owners name the authoritative common, worker and exception regions.
const dutyOwners = {
 "S14": [
  "W",
  "W",
  "W",
  "W"
 ],
 "S16": [
  "C",
  "C",
  "C",
  "C",
  "E"
 ],
 "S19": [
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "W",
  "W",
  "W",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E"
 ],
 "S21": [
  "W"
 ],
 "S22": [
  "W",
  "W",
  "W",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C"
 ],
 "S23": [
  "C",
  "W"
 ],
 "S27": [
  "E",
  "E",
  "E",
  "E"
 ],
 "S28": [
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "C",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W"
 ],
 "S29": [
  "E",
  "E"
 ],
 "S30": [
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "W",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E"
 ]
};
export function safeWriteRegion(source) {
 const heading = "## Manual records and safe writes";
 if (source.split(heading).length !== 2) return "";
 return source.split(heading)[1].split(/\n## /)[0].replace(/\s+/g, " ").trim();
}
function ownedRegions(source) {
 return Object.fromEntries(["C", "W", "E"].map((key) => {
  let text;
  return [key, { split(sentence) { text ??= ownerText(source, key); return text.split(sentence); } }];
 }));
}
// Each outside section has separate single-copy and double-copy controls.
const outsideParts = [
 ["C-introduction", "C", ""],
 ["C-before", "C", "## Identifiers, code ranges, and design markers\n"],
 ["C-after", "C", null],
 ["W-introduction", "W", ""],
 ["W-command-contract", "W", "## Command contract\n"],
 ["W-invocation", "W", "## Invocation\n"],
 ["W-reports", "W", "## Reports and proof\n"],
 ["W-routes", "W", "## Operation and exit routes\n"],
 ["W-bounds", "W", "## Protection observations and bounds\n"],
 ["W-after", "W", null],
 ["E-whole", "E", ""],
];
// Accepted identities do not depend on the insertion targets.
const outsideKinds = [
 "copy-C-introduction", "duplicate-C-introduction",
 "copy-C-before", "duplicate-C-before", "copy-C-after", "duplicate-C-after",
 "copy-W-introduction", "duplicate-W-introduction", "copy-W-command-contract", "duplicate-W-command-contract",
 "copy-W-invocation", "duplicate-W-invocation", "copy-W-reports", "duplicate-W-reports",
 "copy-W-routes", "duplicate-W-routes", "copy-W-bounds", "duplicate-W-bounds",
 "copy-W-after", "duplicate-W-after", "copy-E-whole", "duplicate-E-whole",
];
export function acceptsSafeWriteDuty(source, sentences) {
 const owners = ownedRegions(source);
 const regions = Object.fromEntries(["C", "W", "E"].map((key) => [key, (source[key] ?? "").replace(/\s+/g, " ").trim()]));
 const id = safeWriteDuties.find(([, clauses]) => clauses === sentences)?.[0];
 return !!id && sentences.every((sentence, clause) => {
  const owner = dutyOwners[id]?.[clause] ?? "C";
  return Object.entries(regions).every(([key, text]) => text.split(sentence).length - 1 === (key === owner ? 1 : 0));
 }) && sentences.every((sentence, clause) => {
  const owner = dutyOwners[id]?.[clause] ?? "C";
  if (owners[owner].split(sentence).length - 1 !== 1) return false;
  return true;
 });
}
// This bounded family has an independent accepted roster and never retains tokens.
const activeAcceptedKinds = ["fence", "tilde", "indent", "comment", "html", "quote", "table", "inline", "link", "escape", "entity", "break", "reference", "unrelated-list", "html-blank", "inline-html", "comment-blank", "ordered-dot", "ordered-paren", "ordered-nested", "ordered-loose", "task-list", "nested-list", "loose-list", "prefixed-continuation"];
// Successor witnesses use clause acceptance only, without complete-byte checks.
const successorWitnesses = [
 ["eligible-adoption", "S16", "E", "never recovery-only, approval, decision or attempt identities.", "including recovery-only, approval, decision or attempt identities."],
 ["third-path-hard-link", "S14", "W", "cannot exclude a third path", "exclude every third path"],
 ["in-process-writer", "S19", "E", "including for an in-process writer,", "except for an in-process writer,"],
 ["restart-all-commands", "S19", "E", "and all its commands ended", "ended"],
 ["ordinary-results", "S19", "E", "checked earlier results, or stop evidence for missing results.", "a tool return."],
 ["recovery-stop", "S19", "E", "No recovery observation, copy, classification or write precedes stop evidence.", "Recovery may precede stop evidence."],
 ["missing-map-report", "S30", "E", "Missing report pauses whole edit recovery for the orchestrator decision, including in-place edits.", "Missing report permits in-place edits."],
 ["same-attempt-binding", "S30", "E", "same-attempt report, never a later report or another action.", "later report from another action."],
 ["stored-map-agreement", "S30", "W", "Check stored agreement before logging.", "Log reported agreement without checking stored bytes."],
 ["restoration-decision", "S30", "E", "The orchestrator decides restoration under recovery", "The worker decides restoration"],
 ["restoration-exemption", "S30", "E", "outside the pre-edit barrier.", "under the ordinary pre-edit barrier."],
];
function successorAttacks(source) {
 return successorWitnesses.map(([id, duty, owner, operand, replacement]) => {
  const changed = { ...source, [owner]: source[owner].replace(operand, replacement) };
  return { id: "successor/" + id, changed: changed[owner] !== source[owner],
   rejected: !acceptsSafeWriteDuty(changed, safeWriteDuties.find(([key]) => key === duty)[1]) };
 });
}
export const activeOwnerMutationIds = [
 ...["C", "W", "E"].flatMap((owner) => [
  ...activeAcceptedKinds.map((kind) => `${owner}/${kind}`),
  ...(owner === "E" ? [] : ["intro", "earlier", "later", "h1", "setext", "indented-heading", "heading-html-blank", "heading-comment-blank", "heading-inline-html"].map((kind) => `${owner}/${kind}`)),
 ]),
 "C/census-ordered", "C/census-loose", "C/census-seventh", "C/census-removed", "C/census-quoted", "C/census-task", "C/census-second",
 "C/census-lazy-worker", "C/census-lazy-routing", "C/census-lazy-extra", "C/census-following-before",
 "successor/eligible-adoption", "successor/third-path-hard-link", "successor/in-process-writer",
 "successor/restart-all-commands", "successor/ordinary-results", "successor/recovery-stop",
 "successor/missing-map-report", "successor/same-attempt-binding", "successor/stored-map-agreement",
 "successor/restoration-decision", "successor/restoration-exemption",
];
const activeSubjects = [["C", "S01"], ["W", "S21"], ["E", "S27"]];
function commonListVariants(source) {
 const list = activeOwnerBlocks(source.C, "C").find((t) => t.type === "list").raw;
 return Object.entries({
  "census-ordered": list.replace(/^- /gm, "1. "),
  "census-loose": list.replace(/\n- /g, "\n\n- "),
  "census-seventh": "- Extra item\n" + list,
  "census-removed": list.slice(list.indexOf("\n") + 1),
  "census-quoted": list.split("\n").map((line) => "> " + line).join("\n"),
  "census-task": list.replace("- ", "- [ ] "),
  "census-second": "- One\n- Two\n- Three\n- Four\n- Five\n- Six\n\nParagraph separator.\n\n" + list,
  "census-lazy-worker": list.trimEnd() + "\nWorkers report these triggers and stop.\n\n",
  "census-lazy-routing": list.trimEnd() + "\nTasks name [safe-record-write.md](safe-record-write.md): unrelated continuation.\n\n",
  "census-lazy-extra": list.trimEnd() + "\nExample continuation.\n\n",
  "census-following-before": list,
 }).map(([kind, replacement]) => {
  let text = source.C.replace(list, replacement);
  if (kind === "census-lazy-worker") text = source.C.replace("\n\nWorkers report", "\nWorkers report");
  if (kind === "census-following-before") {
   const following = source.C.match(/Workers report these triggers and stop\.\nTasks name [^\n]+\n/)[0];
   text = source.C.replace(following, "").replace(list, following + "\n" + list);
  }
  return [kind, { ...source, C: text }];
 });
}
export function activeOwnerAttacks(source, kinds = ["fence", "tilde", "indent", "comment", "html", "quote", "table", "inline", "link", "escape", "entity", "break", "reference", "unrelated-list", "html-blank", "inline-html", "comment-blank", "ordered-dot", "ordered-paren", "ordered-nested", "ordered-loose", "task-list", "nested-list", "loose-list", "prefixed-continuation"]) {
 for (const owner of ["C", "W", "E"]) ownerText(source, owner);
 return activeSubjects.flatMap(([owner, id]) => {
  const clauses = safeWriteDuties.find(([key]) => key === id)[1], clause = clauses[0];
  const wrappers = {
   fence: `\n\n\`\`\`text\n${clause}\n\`\`\`\n\n`, tilde: `\n\n~~~\n${clause}\n~~~\n\n`,
   indent: "\n\n    " + clause + "\n\n", comment: "\n\n<!--\n" + clause + "\n-->\n\n",
   html: "\n\n<div>\n" + clause + "\n</div>\n\n", quote: "\n\n> " + clause + "\n\n",
   table: "\n\n| rule |\n|---|\n| " + clause + " |\n\n", inline: "`" + clause + "`",
   link: "[" + clause + "](unrelated)", escape: clause.replace(".", "\\."),
   entity: clause.replace(" ", "&#32;"), break: clause.replace(" ", "  \n"),
   reference: "\n\n[hidden]: https://example.invalid \"" + clause + "\"\n\n", "unrelated-list": "\n\n- " + clause + "\n\n",
  };
  Object.assign(wrappers, {
   "html-blank": "\n\n<div hidden>\n\n" + clause + "\n\n</div>\n\n",
   "inline-html": "<span hidden>" + clause + "</span>",
   "comment-blank": "\n\n<!--\n\n" + clause + "\n\n-->\n\n",
   "ordered-dot": "\n\n1. Unrelated examples:\n\n   " + clause + "\n\n",
   "ordered-paren": "\n\n1) Unrelated examples:\n\n   " + clause + "\n\n",
   "ordered-nested": "\n\n- Examples:\n  1. " + clause + "\n\n",
   "ordered-loose": "\n\n1. Example\n\n2. " + clause + "\n\n",
   "task-list": "\n\n- [ ] " + clause + "\n\n",
   "nested-list": "\n\n- Examples:\n  - " + clause + "\n\n",
   "loose-list": "\n\n- Unrelated examples:\n\n  " + clause + "\n\n",
   "prefixed-continuation": "\n\n- Unrelated examples:\n\n  Example: " + clause + "\n\n",
  });
  const rows = kinds.map((kind) => [kind, { ...source, [owner]: source[owner].replace(clause, wrappers[kind]) }]);
  if (owner !== "E") for (const kind of ["intro", "earlier", "later", "h1", "setext", "indented-heading"]) {
   const removed = source[owner].replace(clause, "");
   const boundary = { later: "## Outside owner", h1: "# Outside owner", setext: "Outside owner\n---", "indented-heading": "   ## Outside owner   " }[kind];
   const raw = kind === "intro" ? clause + "\n\n" + removed : kind === "earlier"
    ? removed.replace(owner === "C" ? "## Identifiers, code ranges, and design markers" : "## Command contract", (heading) => heading + "\n\n" + clause + "\n")
    : removed + "\n\n" + boundary + "\n\n" + clause;
   rows.push([kind, { ...source, [owner]: raw }]);
  }
  if (owner !== "E") for (const [kind, wrap] of [
   ["heading-html-blank", (title) => "<div hidden>\n\n" + title + "\n\n</div>"],
   ["heading-comment-blank", (title) => "<!--\n\n" + title + "\n\n-->"],
   ["heading-inline-html", (title) => "## <span hidden>" + title.slice(3) + "</span>"],
  ]) {
   const title = "## " + ownerHeadings[owner];
   rows.push([kind, { ...source, [owner]: source[owner].replace(title, wrap(title)) }]);
  }
  return rows.map(([kind, changed]) => ({ id: `${owner}/${kind}`, changed: changed[owner] !== source[owner],
   rejected: !acceptsSafeWriteDuty(changed, clauses) }));
 }).concat(commonListVariants(source).map(([kind, changed]) => ({ id: "C/" + kind,
  changed: changed.C !== source.C, rejected: !acceptsSafeWriteDuty(changed, safeWriteDuties[0][1]) }))).concat(successorAttacks(source));
}
export const activeOwnerControlIds = [
 "parser", "attacks", "successor-without-byte", "heading-shapes-C", "heading-shapes-W", "wrong-version", "unknown-token", "parse-failure",
 "omitted-kind", "short-expected", "missing", "duplicate", "unexpected", "unchanged", "accepted", "crashed",
 "omitted-word", "byte-C", "byte-W", "byte-E", "contradiction-byte", "contradiction-clause",
 "occurrence-mutant", "boundary-mutant", "html-mutant",
 "list-tail-mutant", "list-following-mutant",
 "list-count-mutant", "list-top-mutant", "list-unordered-mutant", "list-tight-mutant", "list-items-mutant", "list-task-mutant", "list-W-mutant", "list-E-mutant",
 "html-after-C", "html-before-C", "html-after-W", "html-before-W", "list-residual", "list-residual-byte", "list-added", "list-added-byte", "benign-C", "benign-W", "legacy-boundary", "legacy-writer-search",
];
export async function activeOwnerControls(source, repo = process.env.SLATE_ACTIVE_REPO ?? process.cwd()) {
 assertActiveRosterSource(repo);
 if (realpathSync(repo) !== realpathSync(process.env.SLATE_ACTIVE_REPO ?? process.cwd())) throw new Error("active owner repository differs from SLATE_ACTIVE_REPO. Set SLATE_ACTIVE_REPO to --repo");
 const results = [];
 const record = (id, passed) => results.push({ id, passed });
 record("parser", JSON.stringify(assertActiveParserContract(parser())) === JSON.stringify(activeParserContractIds));
 const rows = activeOwnerAttacks(source);
 const audit = (entries, ids = activeOwnerMutationIds) => {
  const a = createMutationAudit({ active: ids }); a.record("active", entries); return a.inspect().ok;
 };
 record("attacks", audit(rows));
 record("successor-without-byte", successorAttacks(source).every((r) => r.changed && r.rejected));
 for (const owner of ["C", "W"]) {
  const title = "## " + ownerHeadings[owner];
  const clauses = safeWriteDuties.find(([id]) => id === (owner === "C" ? "S01" : "S21"))[1];
  const fake = [
   "", "#" + title, title + "\n\n" + title,
   "\`\`\`\n" + title + "\n\`\`\`", "~~~\n" + title + "\n~~~", "    " + title,
   "> " + title, "<!--\n" + title + "\n-->", "<div>\n" + title + "\n</div>",
   "- nested\n  " + title, "| " + title + " |\n|---|",
  ];
  record("heading-shapes-" + owner, fake.every((replacement) => !acceptsSafeWriteDuty({ ...source, [owner]: source[owner].replace(title, replacement) }, clauses)));
 }
 for (const [id, fake] of [
  ["wrong-version", { ...parser(), version: "wrong" }],
  ["unknown-token", { ...parser(), lex: () => [{ type: "unknown", raw: "" }] }],
  ["parse-failure", { ...parser(), lex: () => { throw new Error("fixture parse failure"); } }],
 ]) {
  let failed = false;
  try { assertActiveParserContract(fake); } catch { failed = true; }
  record(id, failed);
 }
 record("omitted-kind", !audit(activeOwnerAttacks(source, activeAcceptedKinds.slice(1))));
 record("short-expected", !audit(rows, activeOwnerMutationIds.slice(1)));
 for (const [id, entries] of Object.entries({
  missing: rows.slice(1), duplicate: [...rows, rows[0]], unexpected: [...rows, { ...rows[0], id: "unknown" }],
  unchanged: rows.map((r, i) => i ? r : { ...r, changed: false }),
  accepted: rows.map((r, i) => i ? r : { ...r, rejected: false }), crashed: [undefined, ...rows.slice(1)],
 })) record(id, !audit(entries));
 const wordAudit = createMutationAudit({ words: safeWriteMutationIds.filter((id) => id.startsWith("S06/")) });
 wordAudit.record("words", safeWriteAttacks(source, safeWriteDuties.filter(([id]) => id === "S06"), (word) => word !== 0));
 record("omitted-word", !wordAudit.inspect().ok);
 const { digest } = await import(pathToFileURL(join(repo, "verification/markdown-hashes.ts")).href);
 // Approved owner bytes have an independent pin from the repository Markdown inventory.
 const hashes = new Map([
  ["docs/change-records.md", "9b4eed71e1a4ad24ec19d386643ce45614874ad112deddd0d9763873317a21f3"],
  ["docs/safe-record-write.md", "a89484d5df1e20c93feb5fb14ad0af1e971db01f4327d1ea78073a95fff617ca"],
  ["docs/record-write-recovery.md", "88fedd25e9fb660e23ddbcb8133be7b4501b524567db8968bdab721312741cb8"],
 ]);
 for (const [owner, file] of [["C", "change-records"], ["W", "safe-record-write"], ["E", "record-write-recovery"]]) {
  record("byte-" + owner, digest(Buffer.from(source[owner])) === hashes.get("docs/" + file + ".md"));
 }
 const contradiction = { ...source, E: source.E + "\nAll exceptions are optional.\n" };
 record("contradiction-byte", digest(Buffer.from(contradiction.E)) !== hashes.get("docs/record-write-recovery.md"));
 record("contradiction-clause", safeWriteDuties.every(([, clauses]) => acceptsSafeWriteDuty(contradiction, clauses)));
 const code = readFileSync(join(repo, "verification/record-mutation-roster.mjs"), "utf8");
 for (const [id, target, replacement] of [
  ["occurrence-mutant", "if (owners[owner].split(sentence)" + ".length - 1 !== 1) return false;", ""],
  ["boundary-mutant", 'if (end < 0) ' + 'end = tokens.length;', 'end = tokens.length;'],
  ["html-mutant", 'if (containsHtml(tokens.slice(0, end))) ' + 'return "";', ""],
  ["list-tail-mutant", 'if (lists[0].token.items[5]?.raw.trim() !== expected.tailRaw) ' + 'return false;', ""],
  ["list-following-mutant", 'if (lines[0] !== "Workers report these triggers and stop." || !lines[1]?.startsWith("Tasks name [safe-record-write.md]")) ' + 'return false;', ""],
  ["list-count-mutant", 'if (lists.length !== expected.count) ' + 'return false;', ""],
  ["list-top-mutant", 'top && ' + '!t.ordered', '!t.ordered'],
  ["list-unordered-mutant", '!t.ordered && ' + '!t.loose', '!t.loose'],
  ["list-tight-mutant", '!t.loose && ' + 't.items.length', 't.items.length'],
  ["list-items-mutant", 't.items.length === ' + 'expected.items && ', ""],
  ["list-task-mutant", 't.items.every((item) => ' + '!item.task)', "true"],
  ["list-W-mutant", 'if (owner === "W" && lists.length !== expected.count) ' + 'return false;', ""],
  ["list-E-mutant", 'if (owner === "E" && lists.length !== expected.count) ' + 'return false;', ""],
 ]) {
  if (code.split(target).length !== 2) throw new Error(`nonunique active mutant ${id}`);
  const mutant = await import("data:text/javascript;base64," + Buffer.from(code.replace(target, replacement)).toString("base64"));
  const attacks = mutant.activeOwnerAttacks(source);
  const witness = { "occurrence-mutant": "C/later", "boundary-mutant": "C/later", "html-mutant": "C/html-blank",
   "list-tail-mutant": "C/census-lazy-extra", "list-following-mutant": "C/census-following-before",
   "list-count-mutant": "C/census-second", "list-top-mutant": "C/census-quoted",
   "list-unordered-mutant": "C/census-ordered", "list-tight-mutant": "C/census-loose",
   "list-items-mutant": "C/census-seventh", "list-task-mutant": "C/census-task",
   "list-W-mutant": "W/unrelated-list", "list-E-mutant": "E/unrelated-list" }[id];
  record(id, attacks.some((r) => r.id === witness && !r.rejected) && !audit(attacks));
 }
 for (const owner of ["C", "W"]) {
  const title = "## " + ownerHeadings[owner];
  const html = "\n<div>Harmless text.</div>\n";
  const ending = "\n## Harmless appendix <span>outside</span>\n" + html;
  const after = { ...source, [owner]: source[owner] + ending };
  record("html-after-" + owner, safeWriteDuties.every(([, clauses]) => acceptsSafeWriteDuty(after, clauses)));
  const before = { ...source, [owner]: source[owner].replace(title, html + "\n" + title) };
  const enclosing = { ...source, [owner]: "<div hidden>\n\n" + source[owner] + "\n\n</div>\n" };
  record("html-before-" + owner, safeWriteDuties.filter(([id, clauses]) =>
   clauses.some((_, index) => (dutyOwners[id]?.[index] ?? "C") === owner))
   .every(([, clauses]) => !acceptsSafeWriteDuty(before, clauses) && !acceptsSafeWriteDuty(enclosing, clauses)));
 }
 const residualClause = safeWriteDuties[0][1][0];
 const residual = { ...source, C: source.C.replace(residualClause, "").replace("- failed or unclear record results",
  "- failed or unclear record results\n  " + residualClause) };
 record("list-residual", acceptsSafeWriteDuty(residual, safeWriteDuties[0][1]));
 record("list-residual-byte", digest(Buffer.from(residual.C)) !== hashes.get("docs/change-records.md"));
 const addedItem = { ...source, C: source.C.replace("- failed or unclear record results",
  "- failed or unclear record results and additional item text") };
 record("list-added", safeWriteDuties.every(([, clauses]) => acceptsSafeWriteDuty(addedItem, clauses)));
 record("list-added-byte", digest(Buffer.from(addedItem.C)) !== hashes.get("docs/change-records.md"));
 for (const owner of ["C", "W"]) {
  const benign = { ...source, [owner]: source[owner] + "\n## Harmless appendix\nNo duty here.\n" };
  record("benign-" + owner, safeWriteDuties.every(([, clauses]) => acceptsSafeWriteDuty(benign, clauses)));
 }
 record("legacy-boundary", normalized(activeOwnerBlocks(source.C, "C").map((t) => t.raw).join("")) === safeWriteRegion(source.C));
 record("legacy-writer-search", writerFieldAttacks(source.C).every((r) => r.changed && r.rejected && r.isolated));
 return results;
}
export function acceptsDutyRoster(duties = safeWriteDuties) {
 return createHash("sha256").update(JSON.stringify(duties)).digest("hex") === acceptedDutyHash;
}
const acceptedDutyWords = [["S01",[12,10,20,11,6,15,12,15,7,9,8,6,10]],["S02",[9,11,7,12,10]],["S03",[18,4,16,19,9,8,11,8,11,5]],["S04",[7,6,10,10,5,7,9,14]],["S05",[20,6,10,8,3]],["S06",[9]],["S07",[9,7,12,12]],["S08",[7,7]],["S09",[9,12,16,6,5]],["S10",[4]],["S11",[12,11,15]],["S12",[13,10,8,5,6]],["S13",[28]],["S14",[28,18,15,19]],["S15",[14]],["S16",[15,9,9,9,14]],["S17",[9,19]],["S18",[6,7]],["S19",[17,12,15,14,17,14,9,32,28,18,21,13,12,12,25,13,23,16,21,35]],["S20",[10]],["S21",[20]],["S22",[3,9,10,13,16,9,13,8,12]],["S23",[17,14]],["S24",[17,14,8]],["S25",[20]],["S26",[10,10,8,6,7,6,6,3,3,6]],["S27",[10,7,6,9]],["S28",[8,12,8,10,15,8,17,24,10,14,13,12,11,13,11,10,51,9,13,11,7,8,22,9,3,9,7,12,9,13,8,17,13,10,19,13,6,18,20,17,8,19,11,22,17]],["S29",[8,10]],["S30",[14,15,19,12,8,13,15,18,19,29,18,6,4,10,27,6,19,10]],["S31",[5,14,11,6,20,7,10]],["S32",[15]],["S33",[9]],["S34",[15,25]],["S35",[9,9,6]],["S36",[13,13]],["S37",[18]],["S38",[13,5,6,6,12,8,7,6]],["S39",[12,13,18,7]],["S40",[10,12]]];
const acceptedDutyHash = "6adf48174e218c07b0f77203467c80a8719e0990fb3254d0fd9d32ba30256249";
export const safeWriteMutationIds = acceptedDutyWords.flatMap(([id, counts]) =>
 counts.flatMap((count, clause) => [...outsideKinds.map((kind) => `${id}/${clause}/${kind}`),
  ...Array.from({ length: count }, (_, word) => `${id}/${clause}/${word}`),
  ...["remove", "duplicate", ...["C", "W", "E"].filter((owner) => owner !== (dutyOwners[id]?.[clause] ?? "C")).flatMap((owner) => ["owner-" + owner, "copy-" + owner])].map((kind) => `${id}/${clause}/${kind}`)]));
export function safeWriteAttacks(source, duties = safeWriteDuties, includeWord = () => true) {
 for (const owner of ["C", "W", "E"]) ownerText(source, owner);
 return duties.flatMap(([id, sentences]) => sentences.flatMap((sentence, clause) => {
  const owner = dutyOwners[id]?.[clause] ?? "C";
  const attacks = [...sentence.matchAll(/\S+/g)].flatMap((match, word) => includeWord(word) ? [[
   String(word), sentence.slice(0, match.index) + sentence.slice(match.index + match[0].length)]] : []);
  attacks.push(["remove", ""], ["duplicate", sentence + " " + sentence],
   ...["C", "W", "E"].filter((key) => key !== owner).flatMap((key) => [["owner-" + key, ""], ["copy-" + key, sentence]]));
  const outside = outsideParts.flatMap(([part, key, heading]) => ["copy", "duplicate"].map((kind) => {
   const payload = "\n" + (kind === "copy" ? sentence : sentence + "\n" + sentence) + "\n";
   const raw = source[key];
   const changed = { ...source, [key]: heading === null ? raw + "\n## Outside owner\n" + payload :
    heading === "" ? payload + raw : raw.replace(heading, heading + payload) };
   return { id: `${id}/${clause}/${kind}-${part}`, changed: changed[key] !== raw,
    rejected: !acceptsSafeWriteDuty(changed, sentences) };
  }));
  return [...outside, ...attacks.map(([kind, replacement]) => {
   const raw = source[owner];
   const offset = owner === "W" ? raw.indexOf("## Record preparation and recovery execution\n") : 0;
   const pattern = new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
   const changed = { ...source, [owner]: raw.slice(0, offset) + raw.slice(offset).replace(pattern, replacement) };
   if (kind.startsWith("owner-") || kind.startsWith("copy-")) changed[kind.split("-")[1]] += "\n" + sentence;
   return { id: `${id}/${clause}/${kind}`, changed: Object.keys(source).some((key) => changed[key] !== source[key]),
    rejected: !acceptsSafeWriteDuty(changed, sentences) };
  })];
 }));
}



const numbered = (id, count) => Array.from({ length: count }, (_, index) => `${id}/${index}`);
const combinations = (ids, kinds) => ids.flatMap((id) => kinds.map((kind) => `${id}/${kind}`));
const headingCounts = {"identifiers-ranges": 26, "manual-records": 171, "resume-forks": 21, "handoff-pointer": 3, "resume-order": 19, "general-handoff": 3, "closed-range-feedback": 18, "repairs": 58, "aggregate": 21, "sources": 73, "workflow-accounting": 73, "notes-accounting": 23, "publishing-sync": 7, "public-roadmap": 21, "repair-escalation": 49, "repair-rounds-owner": 52, "repair-consultations-owner": 27, "child-fix-title-owner": 12, "P13-authoring": 28};

export const recordWriterApplications = [
 "researcher/draft", "design-author/draft", "record-only/log", "record-only/status",
 "record-only/design", "record-only/baseline-map", "implementer/report",
 "implementer/implementation-map", "fixer/report", "fixer/map-edit"
];
export const recordTaskFields = ["destinations", "creation or edit", "write method", "check method", "read-only sources"];
// Accepted application/field pairs do not depend on either generation input.
const acceptedWriterFields = [
 ["researcher/draft","destinations"],
 ["researcher/draft","creation or edit"],
 ["researcher/draft","write method"],
 ["researcher/draft","check method"],
 ["researcher/draft","read-only sources"],
 ["design-author/draft","destinations"],
 ["design-author/draft","creation or edit"],
 ["design-author/draft","write method"],
 ["design-author/draft","check method"],
 ["design-author/draft","read-only sources"],
 ["record-only/log","destinations"],
 ["record-only/log","creation or edit"],
 ["record-only/log","write method"],
 ["record-only/log","check method"],
 ["record-only/log","read-only sources"],
 ["record-only/status","destinations"],
 ["record-only/status","creation or edit"],
 ["record-only/status","write method"],
 ["record-only/status","check method"],
 ["record-only/status","read-only sources"],
 ["record-only/design","destinations"],
 ["record-only/design","creation or edit"],
 ["record-only/design","write method"],
 ["record-only/design","check method"],
 ["record-only/design","read-only sources"],
 ["record-only/baseline-map","destinations"],
 ["record-only/baseline-map","creation or edit"],
 ["record-only/baseline-map","write method"],
 ["record-only/baseline-map","check method"],
 ["record-only/baseline-map","read-only sources"],
 ["implementer/report","destinations"],
 ["implementer/report","creation or edit"],
 ["implementer/report","write method"],
 ["implementer/report","check method"],
 ["implementer/report","read-only sources"],
 ["implementer/implementation-map","destinations"],
 ["implementer/implementation-map","creation or edit"],
 ["implementer/implementation-map","write method"],
 ["implementer/implementation-map","check method"],
 ["implementer/implementation-map","read-only sources"],
 ["fixer/report","destinations"],
 ["fixer/report","creation or edit"],
 ["fixer/report","write method"],
 ["fixer/report","check method"],
 ["fixer/report","read-only sources"],
 ["fixer/map-edit","destinations"],
 ["fixer/map-edit","creation or edit"],
 ["fixer/map-edit","write method"],
 ["fixer/map-edit","check method"],
 ["fixer/map-edit","read-only sources"]
];
export const writerFieldIds = acceptedWriterFields.map(([writer, field]) => `S39/${writer}/${field}`);
export function acceptsWriterFields(source, writer) {
 const clauses = safeWriteDuties.find(([id]) => id === "S39")[1];
 const exception = new RegExp(`Task exception for ${writer}: omit (?:${recordTaskFields.join("|")})\\.`);
 return acceptsSafeWriteDuty({ C: source }, clauses) && !exception.test(safeWriteRegion(source));
}
export function writerFieldAttacks(source, writers = recordWriterApplications) {
 return writers.flatMap((writer) => recordTaskFields.map((field) => {
  const changed = source.replace("## Manual records and safe writes",
   `## Manual records and safe writes\nTask exception for ${writer}: omit ${field}.`);
  return { id: `S39/${writer}/${field}`, changed: changed !== source,
   rejected: !acceptsWriterFields(changed, writer),
   isolated: writers.filter((other) => other !== writer).every((other) => acceptsWriterFields(changed, other)) };
 }));
}

export const EXPECTED_MUTATIONS = {
 "review-history": ["design-body", "architecture-body", "review-collapse", "review-combine", "routine-rewrite", "ordinary-rebase", "approved-design-body", "prior-review-combine", "review-before-user", "permitted-rebase", "forbidden-separate-fixes", "body-before-commit", "present-single-commit", "consolidate-corrections", "rebase-until-review", "forbidden-individual-fixes", "fold-corrections"],
 "surviving-safeguards": [
  "reviewed-state", "aggregate-no-authority", "preserve-before-rewrite", "reconcile-references",
  "original-marker-evidence", "missing-history-pause", "exact-recovery", "no-substitute",
  "no-invented-marker", "recovery-choice", "waiver-limit", "linear-history",
  "contiguous-owner", "pause-no-commits", "no-interleaving", "pause-preserves-evidence",
  "branch-lifetime", "exact-reviewed-head", "reviewed-binding-immutable", "rewrite-condition-pause",
  "conflict-keeps-reference", "privacy-history", "privacy-untracked", "privacy-pause",
  "privacy-choice", "privacy-preservation", "waiver-no-permission", "explicit-branch",
  "private-accounting", "local-own-head", "local-all-markers", "local-not-earlier",
  "accept-before-merge", "accept-owning-log", "accept-order", "ready-no-bypass",
  "local-keep-branches", "local-verification-resume", "local-history-privacy", "local-match-pause",
  "local-user-choice", "local-renew-acceptance", "local-marker-order", "local-no-rewrite",
  "local-records", "local-user-deletes", "handoff-exact-head", "handoff-fresh-check",
  "host-merged-head", "host-no-inference", "merge-record-evidence", "remaining-differences",
  "final-agreement"
 ],
 "boundary-regression": [
  "G1-mandatory-section/restored-rule", "G1-mandatory-section/benign-control", "G1-mandatory-section/wrapped-restored-rule", "G3-tracks-table/restored-rule",
  "G3-tracks-table/benign-control", "G3-tracks-table/wrapped-restored-rule", "G4-root-only/restored-rule", "G4-root-only/benign-control",
  "G4-root-only/wrapped-restored-rule", "G4-after-flip/restored-rule", "G4-after-flip/benign-control", "G4-after-flip/wrapped-restored-rule",
  "G8-description-target/restored-rule", "G8-description-target/benign-control", "G8-description-target/wrapped-restored-rule", "G8-delivery-target/restored-rule",
  "G8-delivery-target/benign-control", "G8-delivery-target/wrapped-restored-rule", "G8-measured-exception/restored-rule", "G8-measured-exception/benign-control",
  "G8-measured-exception/wrapped-restored-rule", "G9-untracked-closure/restored-rule", "G9-untracked-closure/benign-control", "G9-untracked-closure/wrapped-restored-rule",
  "normalization-weakening"
 ],
 "delivery-boundaries": [
  "local-delivery/final-squash", "local-delivery/delivery-authority", "first-deferred/suppress-concerns", "first-deferred/redirect-record",
  "scope-outcome/redirect-record", "scope-outcome/omit-record", "note-route/redirect-record", "note-route/omit-record",
  "template-applicability/disabled-exemption", "template-applicability/disabled-template", "template-applicability/publishing-duty", "commit-discipline/design-body-restoration"
 ],
 "delivery-rules": [
  ...numbered("repairs", 58), ...numbered("aggregate", 21), ...numbered("issues", 15), ...numbered("sources", 73),
  ...numbered("workflow-accounting", 73), ...numbered("notes-accounting", 23), ...numbered("publishing-sync", 7),
  ...numbered("public-roadmap", 21)
 ],
 "transfer": [
  ...numbered("transfer", 5)
 ],
 "sequential-acceptance": [
  "subtree-merged-before-root-without-marker-distinction", "root-recreates-earlier-subtree-marker", "root-adds-marker-for-every-accepted-subtree"
 ],
 "level-rules": [
  ...numbered("level-publishing", 20), ...numbered("publishing-creation", 19), ...numbered("publishing-after-merge", 19), ...numbered("sync", 7),
  ...numbered("ready", 31), ...numbered("post-flip", 18), ...numbered("merge-advice", 12), ...numbered("description-scope", 15),
  ...numbered("default-template", 4), ...numbered("migration", 16), ...numbered("accepted-history", 22), ...numbered("history", 25),
  ...numbered("disabled-preservation", 23), ...numbered("private-set", 10), ...numbered("workflow-accounting", 73)
 ],
 "safety-removals": [
  ...numbered("level-publishing", 20), ...numbered("publishing-creation", 19), ...numbered("publishing-after-merge", 19), ...numbered("sync", 7),
  ...numbered("ready", 31), ...numbered("post-flip", 18), ...numbered("merge-advice", 12), ...numbered("description-scope", 15),
  ...numbered("default-template", 4), ...numbered("migration", 16), ...numbered("accepted-history", 22), ...numbered("history", 25),
  ...numbered("disabled-preservation", 23), ...numbered("private-set", 10), ...numbered("workflow-accounting", 73)
 ],
 "ordering": [
  "before-first-range", "after-descendant-ranges", "resume-completed-dependency", "open-range-interleaving"
 ],
 "peer-pins": [
  "level-publishing/exception", "publishing-creation/exception", "publishing-after-merge/exception", "sync/exception",
  "ready/exception", "post-flip/exception", "merge-advice/exception", "description-scope/exception",
  "default-template/exception", "migration/exception", "accepted-history/exception", "history/exception",
  "disabled-preservation/exception", "private-set/exception", "workflow-accounting/exception", "pr-publishing/document-addition",
  "track-workflow/document-addition", "delivery-packages/document-addition"
 ],
 "heading-policy": Object.entries(headingCounts).flatMap(([id, count]) => combinations([id], ["missing", "duplicate", "empty", "empty-duplicate", "closed-heading-duplicate", "peer-truncation", ...[1, 2, 3, 4, 5].map((index) => `higher-truncation-${index}`), ...Array.from({ length: count }, (_, index) => `sentence-${index}`)])),
 "common-guidance": [
  "worker-supplied-folder-removed", "action-scratch-scope-narrowed", "lasting-file-in-action-folder", "temporary-owner-transfer-rule-removed",
  "temporary-content-authority", "folder-privacy-or-publishing-weakened"
 ],
 "common-temporary-rules": [
  "common-verification-folder-precedence-removed", "common-verification-folder-retention-overridden", "common-worker-delete-before-check", "common-worker-delete-without-passed-check"
 ],
 "reviewer-destinations": [
  "reviewer-owned-diff-exception-removed", "reviewer-no-change-fallback-removed", "reviewer-no-change-deletion-removed", "reviewer-design-bytes-denied",
  "reviewer-manual-fallback-removed", "reviewer-extra-write-limit-removed", "reviewer-action-path-private-reference"
 ],
 "reviewer-inputs": [
  "reviewer-contract-design-grant", "reviewer-contract-folder-restriction", "reviewer-contract-outside-range-grant", "reviewer-reads-other-action",
  ...numbered("reviewer-contract-stage-paragraph-changed", 10), "reviewer-contract-sibling-heading-grant", "reviewer-write-scope-weakened"
 ],
 "worker-guidance": [
  "worker-change-preamble-removed", "worker-change-preamble-rules-weakened", "reviewer-preamble-extra-write", "worker-delete-before-check",
  "worker-delete-without-passed-check", "verification-folder-precedence-removed", "verification-folder-retention-overridden", "alternate-payload-destination",
  "reviewer-owned-diff-exception-removed"
 ],
 "map-production": ["production", "maintenance", "assignment", "applicability", "edit-classification", "edit-hash", "preserved-copy"],
 "report-guidance": [
  "failed-record-check-report-removed"
 ],
 "record-contract": [
  ...safeWriteMutationIds, ...writerFieldIds,
  "append-only-operator-removed", "permit-truncating-redirection", "permit-write-tool", "permit-edit-tool",
  "permit-sed-in-place", "design-copy-cp-n-removed", "design-copy-cmp-removed", "design-copy-exit-status-authority",
  "direct-write-block-missing", "direct-write-block-contradictory", "direct-write-block-duplicate", "omit-transcript-limit",
  "record-only-task-record-names-removed", "record-only-task-assigned-method-removed", "record-only-task-source-rule-removed", "start-copy-removed",
  "start-copy-location-inside-records", "start-copy-after-first-write", "new-record-empty-start-copy-removed", "new-text-temporary-file-removed",
  "new-text-temporary-file-shared", "new-text-temporary-file-inside-records", "new-text-temporary-file-after-write", "new-log-first-temporary-append-removed",
  "new-report-first-temporary-append-removed", "append-temporary-file-removed", "append-temporary-file-operator-removed", "status-rewrite-temporary-copy-removed",
  "new-design-temporary-copy-removed", "final-check-before-last-write", "final-check-whole-record-removed", "final-check-once-per-record-removed",
  "append-equality-start-copy-removed", "append-equality-every-temporary-file-removed", "append-equality-temporary-order-removed", "append-equality-cat-removed",
  "append-equality-cmp-removed", "status-final-temporary-equality-removed", "new-design-final-temporary-equality-removed", "status-final-cmp-removed",
  "new-design-final-cmp-removed", "changed-design-diff-removed", "changed-design-verified-copy-removed", "changed-design-intended-differences-removed",
  "check-report-per-record-removed", "check-report-final-response-removed", "check-report-exact-task-path-removed", "check-report-comparison-description-removed",
  "check-report-result-removed", "count-incomplete-check-report", "unreported-written-record-read-removed", "unreported-read-extended-to-read-only-records",
  "unreported-read-depends-on-tool-warning", "unreported-read-after-another-write", "failed-check-retry-route-removed", "failed-final-check-end-only-inspection",
  "required-retry-reads-addition-removed", "required-retry-reads-replacement-permitted", "status-retry-complete-rewrite-removed", "unequal-versioned-copy-refusal-removed",
  "missing-versioned-copy-refusal-removed", "invalid-versioned-copy-existing-file-protection-removed", "versioned-copy-retry-next-unused-name-removed", "versioned-copy-retry-cmp-before-design-change-removed",
  "failed-design-edit-comparison-removed", "unclear-design-edit-comparison-removed", "design-retry-verified-copy-comparison-removed", "design-retry-before-orchestrator-cmp",
  "unchanged-design-edit-only-retry-removed", "partial-design-restore-removed", "partial-design-restore-cp-removed", "partial-design-restore-cmp-removed",
  "partial-design-retry-before-restoration-comparison", "change-start-while-record-writer-permitted", "change-close-while-record-writer-permitted", "log-report-retry-missing-text-not-resent",
  "log-report-retry-present-text-resent", "log-report-retry-partial-text-resent", "log-report-retry-before-inspection", "log-report-partial-correction-without-entry-name"
 ],
 "named-rules": [
  "record-only-task-record-names-removed", "record-only-task-assigned-method-removed", "record-only-task-source-rule-removed", "start-copy-removed",
  "start-copy-location-inside-records", "start-copy-after-first-write", "new-record-empty-start-copy-removed", "new-text-temporary-file-removed",
  "new-text-temporary-file-shared", "new-text-temporary-file-inside-records", "new-text-temporary-file-after-write", "new-log-first-temporary-append-removed",
  "new-report-first-temporary-append-removed", "append-temporary-file-removed", "append-temporary-file-operator-removed", "status-rewrite-temporary-copy-removed",
  "new-design-temporary-copy-removed", "final-check-before-last-write", "final-check-whole-record-removed", "final-check-once-per-record-removed",
  "append-equality-start-copy-removed", "append-equality-every-temporary-file-removed", "append-equality-temporary-order-removed", "append-equality-cat-removed",
  "append-equality-cmp-removed", "status-final-temporary-equality-removed", "new-design-final-temporary-equality-removed", "status-final-cmp-removed",
  "new-design-final-cmp-removed", "changed-design-diff-removed", "changed-design-verified-copy-removed", "changed-design-intended-differences-removed",
  "check-report-per-record-removed", "check-report-final-response-removed", "check-report-exact-task-path-removed", "check-report-comparison-description-removed",
  "check-report-result-removed", "count-incomplete-check-report", "unreported-written-record-read-removed", "unreported-read-extended-to-read-only-records",
  "unreported-read-depends-on-tool-warning", "unreported-read-after-another-write", "failed-check-retry-route-removed", "failed-final-check-end-only-inspection",
  "required-retry-reads-addition-removed", "required-retry-reads-replacement-permitted", "status-retry-complete-rewrite-removed", "unequal-versioned-copy-refusal-removed",
  "missing-versioned-copy-refusal-removed", "invalid-versioned-copy-existing-file-protection-removed", "versioned-copy-retry-next-unused-name-removed", "versioned-copy-retry-cmp-before-design-change-removed",
  "failed-design-edit-comparison-removed", "unclear-design-edit-comparison-removed", "design-retry-verified-copy-comparison-removed", "design-retry-before-orchestrator-cmp",
  "unchanged-design-edit-only-retry-removed", "partial-design-restore-removed", "partial-design-restore-cp-removed", "partial-design-restore-cmp-removed",
  "partial-design-retry-before-restoration-comparison", "change-start-while-record-writer-permitted", "change-close-while-record-writer-permitted", "log-report-retry-missing-text-not-resent",
  "log-report-retry-present-text-resent", "log-report-retry-partial-text-resent", "log-report-retry-before-inspection", "log-report-partial-correction-without-entry-name"
 ],
 "record-units": [
  "identifiers-ranges/contradiction", "identifiers-ranges/missing", "identifiers-ranges/duplicate", "tool-records-and-recovery/contradiction",
  "tool-records-and-recovery/missing", "tool-records-and-recovery/duplicate", "resume-forks/contradiction", "resume-forks/missing",
  "resume-forks/duplicate", "handoff-pointer/contradiction", "handoff-pointer/missing", "handoff-pointer/duplicate",
  "marker-identity/contradiction", "marker-identity/missing", "marker-identity/duplicate", "resume-order/contradiction",
  "resume-order/missing", "resume-order/duplicate", "general-handoff/contradiction", "general-handoff/missing",
  "general-handoff/duplicate", "closed-range-feedback/contradiction", "closed-range-feedback/missing", "closed-range-feedback/duplicate"
 ],
 "relations": [
  "loading/0/summary", "loading/0/owner", "loading/1/summary", "loading/1/owner",
  "loading/2/summary", "loading/2/owner", "loading/3/summary", "loading/3/owner",
  "loading/4/summary", "loading/4/owner", "nested/0/summary", "nested/0/owner",
  "nested/1/summary", "nested/1/owner", "nested/2/summary", "nested/2/owner",
  "nested/3/summary", "nested/3/owner", "nested/4/summary", "nested/4/owner",
  "nested/5/summary", "nested/5/owner", "nested/6/summary", "nested/6/owner",
  "records/0/summary", "records/0/owner", "records/1/summary", "records/1/owner",
  "records/2/summary", "records/2/owner", "status-trigger/0/summary", "status-trigger/0/owner",
  "canonical-grammar/0/summary", "canonical-grammar/0/owner", "repair-records/0/summary", "repair-records/0/owner",
  "append-only/0/summary", "append-only/0/owner", "append-only/1/summary", "append-only/1/owner",
  "resume-entry/0/summary", "resume-entry/0/owner", "repair-rounds/0/summary", "repair-rounds/0/owner",
  "repair-consultations/0/summary", "repair-consultations/0/owner", "child-fix-title/0/summary", "child-fix-title/0/owner",
  "child-fix-title/1/summary", "child-fix-title/1/owner", "child-attribution/0/summary", "child-attribution/0/owner"
 ],
 "readers": [
  "root-authority", "publishing-authority", "delivery-authority", "version-bytes"
 ],
 "markers": [
  "NN", "padded-integer", "padded-dotted", "multiline-hidden",
  "hidden", "duplicate", "missing-title", "misplaced-title",
  "double-quoted"
 ],
 "change-identity": [
  "0/missing-title-rule", "0/misplaced-title-rule", "0/mutable-title", "1/base-merge-exemption",
  "body-0/missing", "body-0/misplaced", "body-0/dropped", "body-0/changed",
  "body-1/missing", "body-1/misplaced", "body-1/dropped", "body-1/changed",
  "body-2/missing", "body-2/misplaced"
 ],
 "recipes": [
  "common", "nested", "lifecycle", "dispatch"
 ],
 "repairs": [
  "grant", "override-grant-event", "inheritance", "common-inheritance",
  "requirement-count", "sibling-identity", "log-before-cell", "automatic-lowering",
  "investigation-trigger-record", "leftover-repairs", "budget-disclosure"
 ],
 "warnings": [
  "warning-session", "warning-perms", "warning-issue"
 ],
 "common-complete": [
  "title", "authority", "scope", "section",
  "hidden-policy", "before-body", "after-body", "harmless-outside"
 ],
 "nested-pointers": [
  "identifiers/missing", "identifiers/duplicate", "identifiers/empty", "identifiers/contradictory",
  "identifiers/wrong-document", "identifiers/wrong-section", "identifiers/added-policy", "records/missing",
  "records/duplicate", "records/empty", "records/contradictory", "records/wrong-document",
  "records/wrong-section", "records/added-policy", "privacy/missing", "privacy/duplicate",
  "privacy/empty", "privacy/contradictory", "privacy/wrong-document", "privacy/wrong-section",
  "privacy/added-policy"
 ],
 "pointer-comparisons": [
  "identifiers", "records", "privacy"
 ],
 "nested-complete": [
  "weaker-record-rule", "privacy-permission"
 ],
 "audit-repairs": [
  "configuration-draft-row", "recursive-publishing-pointer", "delivery-host-accepted-head", "delivery-every-method",
  "delivery-result-before-closure", "delivery-later-push", "publishing-merge-advice", "publishing-squash-loss",
  "publishing-rebase-loss", "publishing-accepted-loss"
 ],
 "one-branch-rules": [
  "accepted-head-before-handoff", "every-merge-method", "source-not-target", "host-unavailable-pause",
  "later-push-new-acceptance-head", "branch-lifetime", "local-verification-resume", "migration-evidence",
  "migration-no-automatic-delete", "migration-stacked-rewrite-pause", "migration-leftovers", "every-push-and-delivery-privacy",
  "explicit-branch", "forbidden-push-forms", "private-match-pause", "rewrite-or-waiver",
  "base-merge-between-ranges", "base-merge-no-owner-title", "no-rebase-after-review", "pause-between-ranges",
  "pause-after-descendants", "no-open-range-interleaving", "late-dependency-replan", "merge-advice",
  "accepted-loss", "no-required-method-settings", "no-target-marker-or-map", "remaining-differences",
  "later-owner", "final-agreement", "root-acceptance-before-merge", "one-draft-change-branch"
 ],
 "history-moves": [
  "no-open-range-interleaving", "late-dependency-replan", "base-merge-between-ranges", "base-merge-no-owner-title",
  "no-rebase-after-review"
 ],
 "ordering-wrapped": [
  "pause-between-ranges", "pause-after-descendants", "no-open-range-interleaving"
 ],

};
export function createMutationAudit(expected = EXPECTED_MUTATIONS) {
 const executed = new Map();
 const crashes = [];
 const record = (family, rows, identity = (row) => row.id) => {
  const entries = executed.get(family) ?? [];
  executed.set(family, entries);
  for (const [index, row] of rows.entries()) {
   try {
    entries.push({ id: identity(row, index), complete: row.changed === true && row.rejected === true
     && row.intended !== false && row.retained !== false
     && (row.originalRuleCount === undefined || row.originalRuleCount === 1)
     && (row.mutatedRuleCount === undefined || row.mutatedRuleCount === 0) });
   } catch { entries.push({ id: "<crashed>", complete: false }); }
  }
 };
 const crash = (error) => crashes.push(String(error));
 const inspect = () => {
  const problems = [...crashes.map((error) => ({ crash: error }))];
  for (const [family, ids] of Object.entries(expected)) {
   const rows = executed.get(family) ?? [];
   const actual = rows.map((row) => row.id);
   if (new Set(ids).size !== ids.length || JSON.stringify(actual) !== JSON.stringify(ids)
    || new Set(actual).size !== actual.length || rows.some((row) => !row.complete))
    problems.push({ family, expected: ids.length, executed: rows.length,
     missing: ids.filter((id) => !actual.includes(id)), failed: rows.filter((row) => !row.complete), actual });
  }
  for (const family of executed.keys()) if (!Object.hasOwn(expected, family)) problems.push({ unexpected: family });
  return { ok: problems.length === 0, problems,
   counts: Object.fromEntries([...executed].map(([family, rows]) => [family, rows.length])) };
 };
 return { record, crash, inspect };
}
export async function loadWithMutationAudit(audit, load) {
 try { return { module: await load() }; }
 catch (error) { audit.crash(error); return { error }; }
}
export async function mutationAuditControls() {
 const good = { id: "a", changed: true, rejected: true };
 return Object.entries({ valid: [good], missing: [], duplicate: [good, good], skipped: [{ id: "a" }], crashed: [undefined], "wrong-protection": [{ ...good, intended: false }] })
  .map(([id, rows]) => {
   const audit = createMutationAudit({ fixture: ["a"] });
   audit.record("fixture", rows);
   return { id, discriminates: audit.inspect().ok === (id === "valid") };
  }).concat(await (async () => {
   const audit = createMutationAudit({ fixture: ["a"] });
   const result = await loadWithMutationAudit(audit, () => import('data:text/javascript,throw new Error("production import control")'));
   audit.record("fixture", [good]);
   return [{ id: "production-throw", discriminates: result.error?.message === "production import control"
    && result.module === undefined && audit.inspect().problems.some(({ crash }) => crash?.includes("production import control")) }];
  })());
}
