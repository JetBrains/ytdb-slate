# Workflow guidance

A workflow file is one YAML 1.2 document. YAML is a text format for mappings and lists. A workflow author writes this file to declare the parts of a change process that the validator can check. A lifecycle is a state machine with a starting state. A state is a named stage in that machine.

A trigger names an event that can select a transition. A transition links one state to another. A condition names a fact that a transition can test. A guard combines conditions and other guards. A branch uses a guard or condition to choose a destination state.

A section points to a heading in a guidance document. A state can point to a section. Prompt additions also point to sections. Configuration declares keys that can control steps. A step attaches to a state and names a trigger for its completion.

A handler declaration names a source module for events. The validator checks these declarations and their references. It does not run a state machine or a handler. No command, tool, file reader, or handler execution uses this validator module.

## Complete workflow example

This example shows all required top-level fields. The document provider must return text containing `# Rules` for the document named `rules`. The handler source provider must return a matching declaration for `test-handler`. The examples below use this file as their starting point.

<!-- workflow-example: complete -->
```yaml
format: 1
workflowId: slate-track
workflowVersion: 1
description: Test workflow
useWhen: Test changes
root: change
handlers: test-handler
progressRecord: '{root:research_log}'
configuration:
  workflow.draftPRs: { id: 1, type: boolean, description: Open draft }
sections:
  rules: { id: 2, document: rules, heading: Rules, description: Step rules }
orchestrator:
  - { id: 3, section: rules, priority: 1 }
workflowArgs:
  number: { id: 4, type: integer, description: Number }
threadTypes:
  reviewer:
    id: 5
    description: Reviews work
    prompt:
      - { id: 6, section: rules, priority: 2 }
focusAreas:
  security:
    id: 7
    class: reviewer-only
    description: Reviews security
    definition: rules
    charter: { id: 8, section: rules, priority: 3 }
lifecycles:
  change:
    id: 9
    description: A change
    initialState: work
    conditions:
      done: { id: 10, description: Work done }
    guards:
      ready: { id: 11, description: Can finish, expr: done }
    triggers:
      finish: { id: 12, description: Finish }
      step_completed: { id: 13, description: Complete step }
    states:
      work:
        id: 14
        description: Work in progress
        section: rules
        on:
          finish:
            - { id: 15, to: finished, when: ready }
      finished: { id: 16, description: Finished, terminal: true }
    steps:
      draft:
        id: 17
        description: Prepare draft
        attachTo: work
        when: { key: workflow.draftPRs, equals: true }
        section: rules
        completedBy: step_completed
```

## Input and limits

The validator reads workflow text as one YAML document. It accepts the core YAML schema. It requires unique mapping keys and plain or quoted text keys. It rejects anchors, aliases, explicit tags, and merge keys. Parser warnings count as errors, even for a stream with no documents.

The workflow text limit is 131072 UTF-8 bytes. The parsed tree limit is 64 node levels. A line cannot have more than 128 leading spaces. A line also cannot have more than 64 combined opening `[` or `{` characters and compact `-` or `?` block markers. A compact marker starts line content after indentation or after a `: ` value indicator.

The run `- - - item` counts three markers. That run after `: ` also counts three markers. A hyphen between words does not count. The raw-line limits can reject a shallow document with many delimiters on one line. A parser `RESOURCE_EXHAUSTION` error asks the author to reduce nesting to at most 64 node levels.

Guard expressions have their own limit of 32 levels. Document text and handler source text each have a separate 131072 UTF-8 byte limit.

A valid first line for the complete example is:

<!-- workflow-example: format -->
```yaml
format: 1
```

## Required fields and names

The top-level mapping identifies the workflow and links its declarations. It requires `format: 1` and a positive safe integer `workflowVersion` no greater than 9007199254740991. It requires a lower-case hyphenated `workflowId`. It requires nonempty `description`, `useWhen`, and `progressRecord` text. It also requires `root`, `handlers`, `configuration`, `sections`, `orchestrator`, `workflowArgs`, `threadTypes`, `focusAreas`, and `lifecycles`.

Unknown fields are errors.

Every entity ID is a positive safe integer no greater than 9007199254740991. Each ID must be unique across the workflow. Entity names use lower-case words separated by `_`. Workflow IDs, section names, and document names use lower-case words separated by `-`. A handler name may end with a dot and another hyphenated word.

Configuration keys use dot-separated segments. Each segment starts with a lower-case letter, followed by letters or digits. The validator reserves `free`, `declare`, `override`, `__proto__`, `constructor`, and `prototype` where it checks entity names.

A description or prompt addition can contain `{config:key}`. The key must be declared in `configuration`. A `{root:name}` placeholder needs a lower-case entity name separated by `_`. The six reserved names above are not root names.

The validator checks the form of a root name, not whether handler data contains it. Run-time code owns name resolution. The validator reports an incomplete `{config:` or `{root:` placeholder up to the end of its line. The message requests a closing brace.

The validator checks text fields and each occurrence in used document ranges. Overlapping sections do not repeat a placeholder problem. A document placeholder problem names one covering section heading path, the document, and the placeholder. The validator does not substitute values.

This wrong description names a key that the complete example does not declare:

<!-- workflow-example: wrong-placeholder -->
```yaml
description: '{config:workflow.absent}'
```

The error at `$.description` is `Placeholder {config:workflow.absent} must name a declared configuration key. Declared keys: "workflow.draftPRs".` The complete example corrects the description by using text without an unknown key. A declared key also works:

<!-- workflow-example: correct-placeholder -->
```yaml
description: '{config:workflow.draftPRs}'
```

Each variable part of a problem message, including a name, path, placeholder, or provider error, shows at most 1024 source characters before `...[truncated]`. A list of declared configuration keys or enum values shows at most eight names. Each name uses at most 96 characters after JSON escaping. A truncated list has one marker and counts all omitted names.

The complete example identifies its workflow with these fields:

<!-- workflow-example: identity -->
```yaml
workflowId: slate-track
workflowVersion: 1
```

## Configuration and arguments

Configuration describes named settings. A step can test one setting. An argument declaration describes a workflow input type, but validation does not inspect argument values supplied at run time.

Each configuration entry has an ID, type, and description. The types are `boolean`, `enum`, and `text`. An enum requires a nonempty list of unique, nonempty text `values`. Other types cannot have `values`.

Arguments use `integer`, `text`, `enum`, or `list`. An enum argument needs the same values list. Other argument types cannot have `values`.

The complete example uses these declarations:

<!-- workflow-example: declarations -->
```yaml
configuration:
  workflow.draftPRs: { id: 1, type: boolean, description: Open draft }
workflowArgs:
  number: { id: 4, type: integer, description: Number }
```

This enum declaration can replace the boolean declaration in the example when its step uses `equals: red`:

<!-- workflow-example: enum -->
```yaml
workflow.draftPRs: { id: 1, type: enum, values: [red, blue], description: Open draft }
```

## Documents, additions, and focus areas

A section links a name in the workflow to a heading in supplied document text. A prompt addition links a section to a prompt declaration. A focus area links a definition section and a charter addition.

Each section has `{ id, document, heading, description }`. A document provider supplies the named document as text. The heading must occur exactly once. It starts with one to six `#` characters at the start of its line. A heading inside fenced code or a multiline HTML comment does not count. The section ends at the next heading of the same or a higher level, or at the end of the document.

The validator does not select files or confine document paths. The caller supplies the provider.

`orchestrator` is a list of prompt additions. An addition has `{ id, section, priority }`. The section must exist. The priority is a safe integer no greater than 9007199254740991. It can be zero or negative. Each `threadTypes` entry has an ID, description, and list of additions under `prompt`.

A `focusAreas` entry has an ID, a `design-triggering` or `reviewer-only` class, a description, a definition section, and a charter addition. The validator checks section references. It does not assemble prompts.

The complete example contains this valid section and addition:

<!-- workflow-example: sections -->
```yaml
sections:
  rules: { id: 2, document: rules, heading: Rules, description: Step rules }
orchestrator:
  - { id: 3, section: rules, priority: 1 }
```

This thread type and focus area use the section above:

<!-- workflow-example: prompts -->
```yaml
threadTypes:
  reviewer:
    id: 5
    description: Reviews work
    prompt:
      - { id: 6, section: rules, priority: 2 }
focusAreas:
  security:
    id: 7
    class: reviewer-only
    description: Reviews security
    definition: rules
    charter: { id: 8, section: rules, priority: 3 }
```

## Lifecycles and states

`root` names a declared lifecycle. A lifecycle starts at `initialState` and declares its conditions, guards, triggers, and states. It can also declare `anyState` transitions and `steps`.

Each lifecycle has an ID and description. Each condition and trigger has an ID and description. A guard has an ID, description, and expression under `expr`. An expression can name a declared condition or guard. It can also use `{ not: expr }`, `{ and: [expr, expr, ...] }`, or `{ or: [expr, expr, ...] }`. The `and` and `or` forms need at least two expressions.

Guards and conditions cannot share a name. Guard references cannot form a cycle. For example, the complete example declares a condition and uses it in a guard:

<!-- workflow-example: guard -->
```yaml
conditions:
  done: { id: 10, description: Work done }
guards:
  ready: { id: 11, description: Can finish, expr: done }
```

A state has an ID and description. It may name a section, set a boolean `terminal` flag, call another lifecycle under `call`, or declare transitions under `on`. A terminal state cannot have `call` or `on`. Each transition maps a trigger to a nonempty branch list. A branch has `{ id, to, when }` or `{ id, else }`. A single branch can omit `when`.

In a longer list, every non-`else` branch needs `when` naming a declared guard or condition. An `else` branch must come last, after guarded branches. `anyState` uses the same branch form and contributes transitions from every non-terminal state.

The complete example declares a transition from `work` to `finished`:

<!-- workflow-example: transition -->
```yaml
on:
  finish:
    - { id: 15, to: finished, when: ready }
```

A single `else` branch is wrong:

<!-- workflow-example: wrong-else -->
```yaml
- { id: 15, else: finished }
```

The error at `$.lifecycles["change"].states["work"].on["finish"][0]` is `else must be last after a guarded branch`. A guarded branch followed by `else` is valid:

<!-- workflow-example: correct-else -->
```yaml
- { id: 15, to: finished, when: ready }
- { id: 18, else: finished }
```

Every state must be reachable from its initial state through `on` or `anyState`. Every non-terminal state needs such a path to a terminal state. Every other lifecycle must have a call path from `root`. Calls cannot form a cycle.

A call and a step completion do not count as state transitions. These checks validate declarations. They do not execute a workflow.

## Steps

A step attaches to a state and points to a section and a completion trigger. Its `when` field tests one configuration key.

Each step has an ID, description, `attachTo` state, `section`, and `completedBy` trigger. Boolean configuration needs `{ key, equals: true }` or `{ key, equals: false }`. Enum configuration needs `{ key, equals: value }` or `{ key, in: [values] }`, with declared values. An invalid enum condition reports at most eight declared values and counts the rest. Text configuration needs `{ key, present: true }`. A completion trigger cannot also appear in `on` or `anyState`.

The complete example defines a boolean step:

<!-- workflow-example: step -->
```yaml
when: { key: workflow.draftPRs, equals: true }
```

This wrong boolean step uses a text condition:

<!-- workflow-example: wrong-step -->
```yaml
when: { key: workflow.draftPRs, present: true }
```

The error at `$.lifecycles["change"].steps["draft"].when` is `Boolean step condition must use { key, equals: true or false }.` The boolean step above is the corrected form.

## Handler declaration

The `handlers` field names source text supplied by the handler source provider. The static check looks for one column-zero `export const handlers = {` line. It requires two-space-indented double-quoted event keys with identifier values. Every entry ends with a comma, including the last. The block closes with `};` on its own line. Each value needs a column-zero `function name(` declaration.

The provider for the complete example can return this source text:

```typescript
export const handlers = {
  "root.start": rootStart,
  "root.ownerChanged": rootOwnerChanged,
  "root.close": rootClose,
  "dispatch.validate": dispatchValidate,
  "dispatch.prepare": dispatchPrepare,
  "episode.received": episodeReceived,
};
function rootStart() {}
function rootOwnerChanged() {}
function rootClose() {}
function dispatchValidate() {}
function dispatchPrepare() {}
function episodeReceived() {}
```

The six event keys above are required. LF and CRLF line endings work. A block comment, backtick, lone carriage return, or extra column-zero export is unsupported. The check reads text only. It does not execute handlers or prove JavaScript meaning. A crafted file can pass the text check without usable exports.

This field in the complete example selects the provider source:

<!-- workflow-example: handler -->
```yaml
handlers: test-handler
```

## Problems and scope

Validation reports a field path, message, and severity for each problem. An unused trigger, condition, or guard produces a warning. Other invalid declarations produce errors. Paths and messages escape control characters, bidirectional formatting characters, and Unicode line separators. The complete example uses its `finish` trigger and `ready` guard, so it has no unused-declaration warning:

<!-- workflow-example: usage -->
```yaml
finish:
  - { id: 15, to: finished, when: ready }
```

Workflow authors can rely on the declared forms, limits, paths, and problem severities in this validator. The validator module supplies no command, tool, file reader, or handler execution. Runtime transitions, handler inputs, and handler results have no stable contract here.
