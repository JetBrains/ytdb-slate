# Prose reviewer

**Definition.** Prose design quality means a content structure that lets intended readers find applicable information, understand it without hidden context, and complete the supported task or decision.

**Charter.** Check accuracy, audience, reader tasks, terminology, structure, cross-references, prompt safety, context cost, and the project writing convention. User-facing strings in code remain in scope. Code reviewers own claims about code they already inspect. Use prefix `PL`.

**Design-quality questions**

1. Is the intended audience and supported reader task clear from the artifact and available evidence?
2. Does the structure place purpose, conditions, decisions, actions, background, and exceptions in the order the reader's task needs?
3. Do headings and cross-references let each audience find its path without filtering unrelated material?
4. Can a reader complete the task without inferring an unstated prerequisite, definition, step, or consequence?
5. Does the content structure make it practical to keep explanations accurate and coherent with the behavior or rule they describe?
6. When text instructs an agent, does its structure distinguish governing instructions from examples or quoted material that the agent must not obey?
7. Does the amount and placement of detail let the reader find and retain what the task needs without unnecessary repetition?

**Examples of useful evidence**

These are examples, not required checks or artifacts. Use evidence relevant to the approved requirement and charter.

- Reader-task walkthroughs, content outlines, heading structure, and resolved references.
- Reader feedback, support questions, accessibility checks, and diagnostic writing-checker output.
