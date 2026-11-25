# Design format

## Readers

Read this when assigned to write a high-level design.
A map-only assignment does not require it. The orchestrator never reads it.

## Purpose and form

Start with Intention and summary. It has no separate limit.
State goals, non-goals, approach, key decisions, risks, scope and open questions.
Include an alternative only if the user needs it to decide.
Explain terms at first use. No terms section or version history.
Use the baseline map as source evidence, not design authority.

## Design reminder

Choose the fewest changes that keep all approved goals, product and implementation quality, and required gates.
Show the user each item outside the goals. Never add or remove goals yourself.
Propose repeated regressions as non-goal candidates. Show design changes.
Assume the user knows software, not this project.

State what must hold and why. Ask whether a different reasonable implementation
would preserve the statement. Keep observable behavior, binding limits,
compatibility and all decision-relevant guarantees and constraints. Put
paths, lines, function names, signatures, internal literals, renames and internal
calculations in task notes, not designs.

Give text, tables, diagrams and pseudocode equal value. Choose the clearest forms.
Use component or data-flow diagrams if helpful. Explain diagrams and pseudocode in text.
Title diagrams and explain arrows. Use top-level Mermaid blocks for components,
data flow, sequences, state changes, pipelines and argument structure.
Allow only flowchart (prefer TD), sequenceDiagram, stateDiagram-v2, classDiagram and erDiagram.
Use under 40 nodes and labels under 28 characters. No classDef, style or linkStyle.

## Coherent design models

A model is a concept, abstraction, representation or rule set that describes the system. Reuse models first. Use one model per concept. Each model fits all its uses. List special cases. If two models coexist for one concept, state their boundary, how to translate and when the older one ends. Explain why the shared model cannot serve a use before adding a specialized model.

Design model guidance draws on Kristen Maevyn, [The Decoherence Trap](https://maevyn.codes/decoherence), [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

## Detail and handoff

Aim for about 2,500 words of prose and tables, not diagrams.
Coarsen detail only. Keep form, writing rules and guarantees.
Tell the orchestrator of inadequate code-track detail and all map omissions.
Narrow or split scope to resolve baseline omissions.
Propose conversion when unanswered baseline questions need deeper planning.
Design tracks govern direct children only. State component contracts, invariants and funding.
Explain interaction in text and a diagram. Give one table: child identifier, title, scope boundary, what it activates,
differences open at its marker, logical prerequisites and funding share.
Each child owns its mechanisms and internal splits. Put mechanisms in child designs.

Keep decision and review evidence in the design or authorized inputs.
Put extra detail and other alternatives in separate task notes before implementation.
Notes have no soft limit. Link relevant notes in designs and maps only as metadata.
Implementers copy notes into the report on entry. Follow the review contract.
Reviewers never follow note paths.
