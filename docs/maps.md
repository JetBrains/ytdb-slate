# Baseline and implementation maps

A map explains source facts without requiring the user to read source.
An approved design states required behavior.
A map does not replace that authority.
A baseline map describes current behavior at a named source commit.
An implementation map describes delivered behavior at a named source commit.

## Worker readers and access

Map-writing and map-composition workers read this reference.
These workers include design authors, researchers, implementers, fixers and combined-map workers.
Map access follows the current Reviewer input contract in [review-rules.md](review-rules.md).
Use [track-workflow.md](track-workflow.md) for general design and presentation forms.

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

Change-level and design-track maps describe component contracts.
A component contract states inputs, outputs and constraints at a component boundary.
Code-track maps describe changed mechanisms.
A single-track root map uses code-track detail.
Describe unchanged direct dependencies by contract only.
This keeps the explanation focused on behavior that affects the decision.

## Baseline evidence

Name the source commit before describing current behavior.
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

Use a soft guideline of about 1,500 words for every map.
State the reason when a map exceeds that guideline.
Prose and tables count toward the guideline.
Mermaid diagrams do not count toward it.
Keep each Mermaid diagram under 40 nodes.
Mermaid is an optional diagram notation.

Use topic headings rather than question headings.
Follow the mechanism in reader order.
Keep one idea per sentence.
Connect ideas by cause, order or condition.
Tables and diagrams support connected text rather than replace it.
Give every map diagram a topic title and state what its arrows mean.
No explanation is needed when a map omits a diagram.

## Private questions

Keep private reasoning out of the map.
End every map with a private question list.
The list may say none.
