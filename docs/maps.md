# Baseline and implementation maps

A map explains source facts without requiring the user to read source.
An approved design states required behavior.
A map does not replace that authority.
A baseline map describes current behavior at a named source commit.
An implementation map describes delivered behavior at a named source commit.

## Worker readers and access

Read this reference only when assigned to write or compose a map or to check authorized map content.
Design adversaries check baseline facts after independent review.
Reviewer I checks supplied implementation facts after independent range review.
Agentic fix gates check only fixer-selected statements and related questions.
Specialists and user-review fix-range gates get no implementation map.
Stuck-fix consultations get no separate map input.
Follow the input contract in [review-rules.md](review-rules.md).

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

Aim for about 1,500 words. Count prose and tables, not diagrams.
Reduce only detail, never required form or meaning. Explain an excess.
Report omitted questions and inadequate code-track detail. Link to applicable task notes.
Use topic headings in reader order. No terms section. Explain terms at first use.
Use one idea per sentence. Link ideas by cause, order or condition.
Choose among text, tables, diagrams and pseudocode on equal terms.
Explain diagrams and pseudocode. Title diagrams and explain arrows.
Use top-level Mermaid blocks: flowchart (prefer TD), sequenceDiagram,
stateDiagram-v2, classDiagram or erDiagram. Use them for components,
data flow, sequences, states, pipelines or arguments. Use under 40
nodes and labels under 28 characters. No classDef, style or linkStyle.
See [track-workflow.md](track-workflow.md#lifecycle-and-phases) for shared forms.

## Private questions

Keep private reasoning out of the map.
End every map with a private question list.
The list may say none.
Questions are map content, not implementer reasoning.
They follow the map's access rules.
Partial recipients receive only questions tied to supplied statements.
A separate question list grants no wider access.
