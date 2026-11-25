import { lexer, walkTokens, type Tokens } from "marked";

// Independent expectations for the prose in the assigned form contract.
export const assignedDutyGroups = {
  "design-readers": [
    ["author-only", "Read this when assigned to write a high-level design."],
    ["map-only", "A map-only assignment does not require it."],
    ["author-no-orchestrator", "The orchestrator never reads it."],
  ],
  "design-purpose": [
    ["design-opening", "Start with Intention and summary."],
    ["no-opening-cap", "It has no separate limit."],
    ["form-fields", "State goals, non-goals, approach, key decisions, risks, scope and open questions."],
    ["alternatives", "Include an alternative only if the user needs it to decide."],
    ["design-terms-history", "Explain terms at first use."],
    ["design-no-terms-section", "No terms section or version history."],
    ["baseline-authority", "Use the baseline map as source evidence, not design authority."],
  ],
  "design-reminder": [
    ["author-fewest author-approved-goals author-product-and-implementation-quality author-required-gates", "Choose the fewest changes that keep all approved goals, product and implementation quality, and required gates."],
    ["author-off-goal-disclosure", "Show the user each item outside the goals."],
    ["author-no-goal-edit", "Never add or remove goals yourself."],
    ["author-regressions", "Propose repeated regressions as non-goal candidates."],
    ["author-show-changes", "Show design changes."],
    ["author-reader", "Assume the user knows software, not this project."],
    ["author-abstraction", "State what must hold and why."],
    ["author-abstraction-counterfactual", "Ask whether a different reasonable implementation would preserve the statement."],
    ["behavior limits compatibility", "Keep observable behavior, binding limits, compatibility and all decision-relevant guarantees and constraints."],
    ["author-detail", "Put paths, lines, function names, signatures, internal literals, renames and internal calculations in task notes, not designs."],
    ["design-equal-forms", "Give text, tables, diagrams and pseudocode equal value."],
    ["design-clearest-forms", "Choose the clearest forms."],
    ["design-helpful-diagram", "Use component or data-flow diagrams if helpful."],
    ["design-diagram-explain", "Explain diagrams and pseudocode in text."],
    ["design-diagram-arrows", "Title diagrams and explain arrows."],
    ["design-diagram-placement", "Use top-level Mermaid blocks for components, data flow, sequences, state changes, pipelines and argument structure."],
    ["design-diagram-types", "Allow only flowchart (prefer TD), sequenceDiagram, stateDiagram-v2, classDiagram and erDiagram."],
    ["design-diagram-size", "Use under 40 nodes and labels under 28 characters."],
    ["design-diagram-style", "No classDef, style or linkStyle."],
  ],
  "shared-model": [
    ["model-both-definition", "A model is a concept, abstraction, representation or rule set that describes the system."],
    ["model-both-reuse", "Reuse models first."],
    ["model-both-one-model", "Use one model per concept."],
    ["model-both-fitness", "Each model fits all its uses."],
    ["model-both-special-cases", "List special cases."],
    ["model-both-coexistence model-both-translation model-both-retirement", "If two models coexist for one concept, state their boundary, how to translate and when the older one ends."],
    ["model-both-specialized-model", "Explain why the shared model cannot serve a use before adding a specialized model."],
  ],
  "design-credit": [
    ["model-credit", "Design model guidance draws on Kristen Maevyn, [The Decoherence Trap](https://maevyn.codes/decoherence), [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)."],
  ],
  "design-handoff": [
    ["design-size", "Aim for about 2,500 words of prose and tables, not diagrams."],
    ["design-detail-bound", "Coarsen detail only."],
    ["design-preserve-form", "Keep form, writing rules and guarantees."],
    ["design-omissions", "Tell the orchestrator of inadequate code-track detail and all map omissions."],
    ["author-narrow-first", "Narrow or split scope to resolve baseline omissions."],
    ["author-conversion-proposal", "Propose conversion when unanswered baseline questions need deeper planning."],
    ["direct-children", "Design tracks govern direct children only."],
    ["component-fields", "State component contracts, invariants and funding."],
    ["interaction-text interaction-diagram", "Explain interaction in text and a diagram."],
    ["one-table identifier title scope activation differences prerequisites funding", "Give one table: child identifier, title, scope boundary, what it activates, differences open at its marker, logical prerequisites and funding share."],
    ["child-mechanism-ownership child-split-ownership", "Each child owns its mechanisms and internal splits."],
    ["mechanisms", "Put mechanisms in child designs."],
    ["decision-review-evidence", "Keep decision and review evidence in the design or authorized inputs."],
    ["private-notes", "Put extra detail and other alternatives in separate task notes before implementation."],
    ["notes-no-soft-limit", "Notes have no soft limit."],
    ["notes-metadata", "Link relevant notes in designs and maps only as metadata."],
    ["author-note-copy", "Implementers copy notes into the report on entry."],
    ["author-review-pointer", "Follow the review contract."],
    ["author-no-follow", "Reviewers never follow note paths."],
  ],
  "workflow-abstraction": [
    ["shared-test", "Use the abstraction test in design assessment and triage."],
    ["high-level", "High-level statements say what must hold and why under any reasonable implementation."],
    ["low-level", "Low-level statements say how the chosen implementation works."],
    ["report-route", "Keep low-level material in the implementer report."],
    ["exclude-detail", "Designs name no paths, method signatures or lines."],
  ],
  "workflow-form": [
    ["presentation-equal-forms", "In presentations, plans, packages and decision questions, give text, tables, diagrams and neutral pseudocode equal value."],
    ["presentation-clearest-set", "Choose the clearest set."],
    ["pseudocode-definition", "Pseudocode describes a procedure without executable syntax."],
    ["presentation-explanation", "Explain diagrams and pseudocode in text."],
    ["presentation-arrows", "Title diagrams and explain arrows."],
    ["presentation-placement", "Use top-level Mermaid for components, data flow, sequences, states, pipelines and argument structure."],
    ["presentation-types", "Allow only flowchart (prefer TD), sequenceDiagram, stateDiagram-v2, classDiagram and erDiagram."],
    ["presentation-size", "Use under 40 nodes and labels under 28 characters."],
    ["presentation-style", "No classDef, style or linkStyle."],
  ],
  "workflow-omissions": [
    ["omissions", "Report every omitted map question and inadequate code-track detail."],
    ["baseline-omissions", "Treat omitted baseline questions as unanswered."],
    ["workflow-narrow-first", "Narrow or split scope to resolve them where possible."],
    ["conversion-reason", "Record a reason if you reject the design author's conversion proposal."],
    ["split-detail", "Judge if insufficient detail warrants a split."],
    ["no-length-split", "Never split for implementation-map length."],
    ["preserve-gates", "Keep gates."],
    ["parent-detail", "Guide design-track authors on goal and component detail as needed."],
  ],
  "workflow-notes": [
    ["notes-handoff", "Authors supply task notes before implementation."],
    ["workflow-note-links", "Designs and maps link to them."],
    ["notes-copy", "Implementers copy them into the report on entry."],
    ["workflow-review-pointer", "Follow the review contract."],
    ["no-follow", "Never follow note paths in review."],
  ],
  "review-private": [
    ["common-separate-notes", "Reviewers never receive, read or seek status files, leftover record temporary files, research logs (early, ordinary or design-track), their references or extracts, implementer reports, task notes or extracts, separate note references, private triage or implementer reasoning."],
    ["common-metadata", "Note paths in authorized whole designs or maps are metadata."],
    ["common-metadata-no-follow", "Never follow them."],
    ["common-private-triage", "Private triage means orchestrator deliberation and rationale for implementation."],
    ["common-implementer-reasoning", "Implementer reasoning is an implementer's private reasoning."],
  ],
  "review-adversary-input": [
    ["adversary-input", "A design adversary receives the whole validated candidate, applicable designs, approved context, track intention, risk record, area proofs, tracked source evidence, charter and output contract."],
    ["adversary-risk-records", "Only this role receives risk records and area proofs separately."],
    ["adversary-review-order", "It reviews independently before checking baseline facts."],
  ],
  "review-map": [
    ["review-map-authorization", "Without map authorization, do not read or seek an implementation map, including its question list."],
    ["review-map-question-content", "A map's question list is map content, not implementer reasoning."],
    ["review-map-question-access", "Questions follow authorized map inputs."],
    ["review-map-partial-questions", "Partial recipients receive only questions tied to supplied statements."],
    ["review-map-no-separate-list", "No separate list expands access."],
  ],
  "review-episode-exception": [
    ["review-episodes-only-stuck", "Only stuck-fix consultation may receive implementer episodes under § Stuck-fix consultation."],
    ["review-episode-no-separate-access", "Whole episodes permit no separate private input or direct private read."],
  ],
  "review-parent": [
    ["parent-simplest-solution", "A design adversary tests the whole approved high-level design, not each track separately, for the simplest solution: the fewest changes that keep all approved goals, product and implementation quality, and required gates."],
    ["parent-no-new-gate", "This duty adds no artifact, phase or gate."],
    ["parent-review-boundary", "Judge parent component contracts and boundaries, not every descendant's mechanism."],
  ],
  "review-episode-selection": [
    ["stuck-fresh-consultation", "Dispatch one fresh `adversarial` consultation."],
    ["stuck-diagnosis", "Its job is diagnosis, not a gate verdict."],
    ["stuck-applicable-designs", "Supply applicable approved designs under § Reviewer input contract."],
    ["stuck-smallest-whole-set", "Pass only the smallest set of whole implementer episodes needed for evidence."],
    ["stuck-episode-reasons", "Name each episode and reason."],
    ["stuck-only-implementer", "Only an implementer episode is eligible."],
    ["stuck-no-reviewer-episodes", "A design-review, implementation-review, fix-gate, or other reviewer episode is not eligible."],
  ],
  "review-episode-integrity": [
    ["stuck-whole-intact", "Pass every selected episode whole and intact."],
    ["stuck-embedded-retention", "Embedded material remains present regardless of its type, source, or amount."],
    ["stuck-embedded-examples", "It can include a risk record, area proof, research-log text, private triage, or implementer reasoning."],
    ["stuck-no-screening", "Do not screen content for eligibility."],
    ["stuck-no-filtering", "Do not filter, drop, rewrite, or sanitize a needed episode because of embedded content."],
    ["stuck-sole-exception", "This is the sole reviewer episode exception and the user accepts its indirect exposure risk."],
    ["stuck-no-direct-input", "The exception does not permit a direct read or separate delivery of a log, log reference, log extract, risk record, area proof, implementer report, private triage, or implementer reasoning."],
  ],
  "implementation-private": [
    ["implementation-no-notes implementation-denies-read", "Never receive, read or seek risk records, area proofs, implementer episodes or reports, task notes or extracts, separate note references, private triage or implementer reasoning."],
    ["implementation-metadata", "Note paths in authorized whole designs or maps are metadata."],
    ["implementation-metadata-no-follow", "Never follow them."],
    ["implementation-no-research-logs", "Never receive, read or seek research logs (early, ordinary or design-track), their references or extracts."],
    ["implementation-no-log-design", "Supply no log-held design or extract."],
    ["implementation-approved-context", "An orchestrator-written statement of an approved decision is approved context, not a log extract."],
    ["implementation-private-triage", "Private triage is the orchestrator's deliberation and implementation rationale."],
    ["implementation-private-reasoning", "Implementer reasoning is an implementer's private reasoning."],
    ["implementation-distinct-sources", "These sources are distinct."],
  ],
  "map-readers": [
    ["map-authorized-read", "Read this reference only when assigned to write or compose a map or to check authorized map content."],
    ["map-baseline-review-order", "Design adversaries check baseline facts after independent review."],
    ["map-implementation-review-order", "Reviewer I checks supplied implementation facts after independent range review."],
    ["map-fixer-selected-check", "Agentic fix gates check only fixer-selected statements and related questions."],
    ["map-excluded-reviewers", "Specialists and user-review fix-range gates get no implementation map."],
    ["map-no-stuck-fix-input", "Stuck-fix consultations get no separate map input."],
    ["map-input-contract", "Follow the input contract in [review-rules.md](review-rules.md)."],
  ],
  "map-form": [
    ["map-size", "Aim for about 1,500 words."],
    ["map-counted-forms", "Count prose and tables, not diagrams."],
    ["map-detail-limit", "Reduce only detail, never required form or meaning."],
    ["map-explain-excess", "Explain an excess."],
    ["map-omissions", "Report omitted questions and inadequate code-track detail."],
    ["map-notes", "Link to applicable task notes."],
    ["map-reader-order", "Use topic headings in reader order."],
    ["map-no-terms-section", "No terms section."],
    ["map-explain-terms", "Explain terms at first use."],
    ["map-connected-text", "Use one idea per sentence."],
    ["map-linked-ideas", "Link ideas by cause, order or condition."],
    ["map-equal-forms", "Choose among text, tables, diagrams and pseudocode on equal terms."],
    ["map-pseudocode", "Explain diagrams and pseudocode."],
    ["map-arrows", "Title diagrams and explain arrows."],
    ["map-diagram-placement map-diagram-types", "Use top-level Mermaid blocks: flowchart (prefer TD), sequenceDiagram, stateDiagram-v2, classDiagram or erDiagram."],
    ["map-diagram-purposes", "Use them for components, data flow, sequences, states, pipelines or arguments."],
    ["map-diagram-size", "Use under 40 nodes and labels under 28 characters."],
    ["map-diagram-style", "No classDef, style or linkStyle."],
    ["map-pointer", "See [track-workflow.md](track-workflow.md#lifecycle-and-phases) for shared forms."],
  ],
  "map-questions": [
    ["map-no-private-reasoning", "Keep private reasoning out of the map."],
    ["map-ends-with-questions", "End every map with a private question list."],
    ["map-empty-questions", "The list may say none."],
    ["map-question-content", "Questions are map content, not implementer reasoning."],
    ["map-question-access", "They follow the map's access rules."],
    ["map-partial-questions", "Partial recipients receive only questions tied to supplied statements."],
    ["map-no-wider-access", "A separate question list grants no wider access."],
  ],
} satisfies Record<string, [string, string][]>;

type DutyGroup = keyof typeof assignedDutyGroups;

const dutiesById = new Map(Object.values(assignedDutyGroups).flatMap((rows) =>
  rows.flatMap(([names, sentence]) => names.split(" ").map((name) => [name, sentence]))));

export function dutySentence(id: string) {
  const sentence = dutiesById.get(id);
  if (!sentence) throw new Error(`Unknown assigned form duty: ${id}`);
  return sentence;
}

export function dutyParagraph(group: DutyGroup) {
  return assignedDutyGroups[group].map(([, sentence]) => sentence).join(" ");
}

export function splitDutySentences(text: string) {
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

export function sentenceDutyProblems(group: DutyGroup, prose: string) {
  const actual = new Set(splitDutySentences(prose).map((sentence) => sentence.replace(/\s+/g, " ")));
  return assignedDutyGroups[group].flatMap(([names, sentence]) => actual.has(sentence) ? [] : names.split(" "));
}

function dutyRange(group: DutyGroup, first: number, end?: number) {
  return assignedDutyGroups[group].slice(first, end).map(([, sentence]) => sentence).join(" ");
}

// Reviewed templates for both full worker reads and the mixed implementation input.
export const workerFormReferences = {
  design: `# Design format

## Readers

${dutyParagraph("design-readers")}

## Purpose and form

${dutyParagraph("design-purpose")}

## Design reminder

${dutyRange("design-reminder", 0, 6)}

${dutyRange("design-reminder", 6, 10)}

${dutyRange("design-reminder", 10)}

## Coherent design models

${dutyParagraph("shared-model")}

${dutyParagraph("design-credit")}

## Detail and handoff

${dutyRange("design-handoff", 0, 12)}

${dutyRange("design-handoff", 12)}`,
  map: `# Baseline and implementation maps

A map explains source facts without requiring the user to read source.
An approved design states required behavior.
A map does not replace that authority.
A baseline map describes current behavior at a named source commit.
An implementation map describes delivered behavior at a named source commit.

## Worker readers and access

${dutyParagraph("map-readers")}

## Reading depth

Start with decision-dependent questions.
Limit source reading to affected components and direct dependencies.
Read further only for open or reopened questions.
Stop reading when no questions remain.
These reading rules apply to every map writer, including implementers and fixers.
Before relying on a baseline fact, check current source when that source changed after the map commit.
Check every map fact against source evidence.
Cite source paths and line numbers for baseline facts.

## Detail by track

Put only the source commit in the scope paragraph.
Change-level and design-track maps describe component contracts.
A component contract states inputs, outputs and constraints at a component boundary.
Code-track maps describe changed mechanisms.
A single-track root map uses code-track detail.
Describe unchanged direct dependencies by contract only.
This keeps the explanation focused on behavior that affects the decision.

## Baseline evidence

Explain the affected components and how their contracts connect.
Describe the relevant state, ordering, failures and limits.
Use source citations to support the explanation rather than replace it.

## Implementation evidence

Name the delivered source commit.
Describe delivered mechanisms, relevant failures, limits, state and ordering.
Connect goals and decisions to delivered behavior.
Identify changed and unchanged baseline parts.
Explain deviations from the approved design.
Identify mechanisms that no goal requests.
For documentation-only maps, explain how changed rules interact.
A map is neither a test report nor a low-level design.

## Length and form

${dutyParagraph("map-form")}

## Private questions

${dutyParagraph("map-questions")}`,
};

export const implementationOwner = "## Implementation-review inputs";
const implementationFixture = `## Implementation-review inputs

Review the approved range against applicable whole approved standalone designs, track intention, selected charter, output contract and ordinary evidence. Designs provide context, not correctness proof or a duty to repeat whole-design review. Recorded changes with log-held approved designs keep current reviewer inputs until user-authorized migration. The track intention states the target, scope boundary, deferred work, acceptance condition, and declared file list. Implementation findings do not record a design-stage level.

${dutyParagraph("implementation-private")}

Without map authorization, do not read or seek an implementation map, including its question list.

Ordinary repository and library evidence needed for the assigned work remains available. This permission is not a closed changed-file allowlist. The selected perspectives do not expand your authority or change the approved review scope.

### Implementation design quality

Implementation design quality means how well the code-level structure and mechanism serve an approved requirement. It covers responsibility placement, state, control flow, interfaces, lifecycle, and failure paths. Judge their simplicity, ease of maintenance, and fit with the surrounding system within your existing scope. For tests, prose, licensing material, and governing rules, judge the structure that serves your existing charter.

Correctness asks whether the implementation produces the required result. Approval fidelity asks whether the result matches the approved requirement and track intention. Implementation design quality asks whether the chosen mechanism fits that requirement without unnecessary complexity. A style preference favors a form without showing an adverse effect.

A design concern is a finding only when evidence links it to a concrete adverse effect. The effect must concern correctness, maintenance, operation, a consumer, or another approved requirement. A preference alone is not a finding. Apply the existing evidence standards to every finding. Named techniques can supply evidence. These questions never make a technique mandatory merely by suggesting that you examine it.

Each implementation reviewer judges design quality only within its existing scope. The current focus definitions and their boundaries remain authoritative. Reviewer I cannot absorb or replace a specialist. These questions add design guidance to the existing charters. They do not replace or merely restate their explicit duties.

Apply the questions using the approved review range, track intention, charter, output contract, and ordinary evidence. Judge the approved requirement, not an imagined future requirement. The questions require no additional review artifact. The design-stage simplest-solution check remains separate and unchanged. These questions change no trigger, boundary, reviewer count, merge rule, gate, or user authority.`;

type Block = { type: string; text: string; raw: string; depth?: number };
type Form = { blocks: Block[]; headings: Map<string, number> };
type FormProblem = "lexer" | "plain-heading";

// Marked retains the source line in raw. Its token can include final newlines.
const plainHeading = /^(#{1,6}) ([A-Za-z0-9,-]+(?: [A-Za-z0-9,-]+)*)\n*$/;

const foldWraps = (text: string) => text.trim().replace(/[ \t]*\n[ \t]*/g, " ");

function proseBlock(token: Tokens.Paragraph | Tokens.Text): Block {
  let hardBreak = false;
  walkTokens(token.tokens ?? [], ({ type }) => { if (type === "br") hardBreak = true; });
  return hardBreak
    ? { type: "hard-break", text: token.raw.trimEnd(), raw: token.raw }
    : { type: token.type, text: foldWraps(token.raw), raw: token.raw };
}

function blockContent(token: Tokens.Generic): Block {
  const { type, raw } = token;
  if (type === "heading") {
    const { depth, text } = token as Tokens.Heading;
    return { type, text: `${"#".repeat(depth)} ${text}`, raw, depth };
  }
  if (type === "paragraph" || type === "text") return proseBlock(token as Tokens.Paragraph | Tokens.Text);
  const children = (tokens: Tokens.Generic[]) => tokens.map(blockContent).map(({ type, text }) => [type, text]);
  if (type === "list") {
    const list = token as Tokens.List;
    const items = list.items.map((item) => [
      item.raw.match(/^ *(\d+[.)]|[-+*])(?=\s|$)/)?.[1],
      item.task, item.checked, item.loose, children(item.tokens),
    ]);
    return { type, raw, text: JSON.stringify([list.ordered, list.start, list.loose, items]) };
  }
  if (type === "blockquote") return { type, raw, text: JSON.stringify(children(token.tokens ?? [])) };
  return { type, text: raw.trimEnd(), raw };
}
const knownTokens = new Set([
  "space", "heading", "paragraph", "text", "list", "list_item", "blockquote", "html",
  "code", "hr", "table", "escape", "tag", "link", "image", "strong", "em", "codespan", "br", "del",
]);
const blockCache = new Map<string, Form | FormProblem>();

function lexForm(source: string): Form | FormProblem {
  const tokens = lexer(source);
  const root = new Set(tokens);
  const headings = new Map<string, number>();
  let unknown = false;
  let nonPlain = false;
  walkTokens(tokens, (token) => {
    if (!knownTokens.has(token.type)) unknown = true;
    if (token.type !== "heading") return;
    const { raw, depth, text } = token as Tokens.Heading;
    const match = plainHeading.exec(raw);
    if (!root.has(token) || match?.[1]?.length !== depth || match[2] !== text) nonPlain = true;
    const key = `${"#".repeat(depth)} ${text}`;
    headings.set(key, (headings.get(key) ?? 0) + 1);
  });
  if (nonPlain) return "plain-heading";
  // Reference definitions can change meaning without leaving a root block.
  if (unknown || Object.keys(tokens.links).length) return "lexer";
  return { headings, blocks: tokens.filter(({ type }) => type !== "space").map(blockContent) };
}

function form(source: string) {
  const cached = blockCache.get(source);
  if (cached !== undefined) return cached;
  const parsed = lexForm(source);
  if (blockCache.size >= 32) blockCache.delete(blockCache.keys().next().value!);
  if (source.length <= 128 * 1024) blockCache.set(source, parsed);
  return parsed;
}

export function hasNonPlainHeading(source: string) {
  return form(source) === "plain-heading";
}

export function formBlocks(source: string) {
  const parsed = form(source);
  return typeof parsed === "string" ? null : parsed.blocks;
}

export function formSection(source: string, owner: string) {
  const parsed = form(source);
  if (typeof parsed === "string") return null;
  const { blocks, headings } = parsed;
  const level = owner.indexOf(" ");
  if (headings.get(owner) !== 1) return null;
  const index = blocks.findIndex(({ type, text }) => type === "heading" && text === owner);
  if (index < 0) return null;
  const end = blocks.findIndex(({ depth }, at) => at > index && depth !== undefined && depth <= level);
  return blocks.slice(index + 1, end < 0 ? undefined : end);
}

export function sameBlocks(left: Block[] | null, right: Block[] | null) {
  return left !== null && right !== null && left.length === right.length &&
    left.every(({ type, text }, index) => right[index]?.type === type && right[index]?.text === text);
}

export function ownedFormProblems(source: string, owner: string, expected: Block[] | null, groups: DutyGroup[]) {
  if (!expected) throw new Error(`Invalid assigned form fixture: ${owner}`);
  const actual = formSection(source, owner);
  if (sameBlocks(actual, expected)) return [];
  const prose = actual?.filter(({ type }) => type === "paragraph").map(({ text }) => text).join("\n\n") ?? "";
  const duties = groups.flatMap((group) => sentenceDutyProblems(group, prose));
  const parsed = form(source);
  const reason = typeof parsed === "string" ? parsed : !actual ? "owner" :
    actual.map(({ type }) => type).join() !== expected.map(({ type }) => type).join() ? "blocks" : "prose";
  return [`${owner}: ${reason}`, ...duties];
}

export function implementationInputProblems(delivered: string) {
  return ownedFormProblems(delivered, implementationOwner, formSection(implementationFixture, implementationOwner),
    ["implementation-private"]);
}

export function wholeImplementationInputProblems(input: string) {
  const expected = formBlocks(implementationFixture);
  if (!expected) throw new Error("Invalid whole implementation input fixture");
  return sameBlocks(formBlocks(input), expected) ? [] : ["implementation-whole-input"];
}
