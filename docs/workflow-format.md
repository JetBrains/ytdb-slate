# Workflow file format and validation

A workflow is one YAML 1.2 document. YAML is a text format for mappings and lists. The validator accepts the core YAML schema. It requires unique mapping keys and plain or quoted text keys. It rejects anchors, aliases, explicit tags, and merge keys.

It turns parser warnings into errors, including warnings in a stream with no documents. It reports each problem with a field path, message, and severity. Problem paths and messages escape control, bidirectional formatting, and Unicode line-separator characters.

An unused trigger, condition, or guard produces a warning. The validator accepts text up to 131072 UTF-8 bytes. It checks no more than 64 parsed node levels.

It rejects a line with more than 128 leading spaces. It also rejects a line with more than 64 combined opening `[` or `{` characters and compact `-` or `?` block markers. A compact block marker starts the line content after indentation or a `: ` value indicator. A run such as `- - - item` counts three markers. The same run after `: ` also counts three markers. A hyphen between words does not count. A parser `RESOURCE_EXHAUSTION` error tells authors to reduce nesting to at most 64 node levels. The validator also limits guard expression depth to 32 levels. Document and handler source text each have a separate 131072 UTF-8 byte limit. The raw-line limits can reject shallow documents that use many delimiters on one line.

## Required fields

The top-level mapping requires `format: 1`, a positive safe integer `workflowVersion` (at most 9007199254740991), and a lower-case hyphenated `workflowId`. It also requires nonempty `description`, `useWhen`, and `progressRecord` text. The remaining required fields are `root`, `handlers`, `configuration`, `sections`, `orchestrator`, `workflowArgs`, `threadTypes`, `focusAreas`, and `lifecycles`. The validator refuses unknown fields. It requires each entity ID to be a positive safe integer at most 9007199254740991 that no other entity in the workflow uses.

Entity names use lower-case words separated by `_`. Workflow IDs, section names, and document names use lower-case words separated by `-`. A handler name may also end in a dot and another hyphenated word. Configuration keys use dot-separated segments. Each segment starts with a lower-case letter, followed by letters or digits. The names `free`, `declare`, `override`, `__proto__`, `constructor`, and `prototype` are reserved where the validator checks entity names.

`configuration` maps each key to an ID, a type, and a description. Its types are `boolean`, `enum`, and `text`. An enum requires a nonempty list of unique, nonempty text `values`. Other configuration types cannot have `values`.

`workflowArgs` uses the types `integer`, `text`, `enum`, and `list`. Enum arguments require the same `values` list. Other argument types cannot have `values`. An argument declaration checks the type and the values list. It does not check an argument value supplied at run time.

Every description and prompt addition may contain `{config:key}`. The key must appear in `configuration`. A `{root:name}` placeholder requires an entity name made of lower-case words separated by `_`. The validator rejects `free`, `declare`, `override`, `__proto__`, `constructor`, and `prototype` as root names. It reports an incomplete `{config:` or `{root:` placeholder up to the end of its line with its required closing brace. For an unknown configuration key, it reports up to eight declared keys and counts the rest. The validator checks only the form of a root name. Run-time code owns name resolution. Each variable part of a problem message, including names, paths, placeholders and provider errors, shows at most 1024 source characters before the `...[truncated]` marker. Declared-key and enum-value lists show at most eight names. Each name uses at most 96 characters after JSON escaping. A truncated list has one marker and counts every name it omits.

The validator checks these placeholders in text fields and once per occurrence in used document ranges. Overlapping sections do not repeat a placeholder problem. For a section, a problem names one covering section heading path, document and placeholder. It does not substitute values.

## Documents, additions, and focus areas

`sections` maps each section name to `{ id, document, heading, description }`. A document provider supplies the named document as text. The heading must occur exactly once. A heading begins with one to six `#` characters at the start of its line. Headings inside fenced code or multiline HTML comments do not count. A section ends at the next heading of the same or a higher level, or at the end of the document.

The validator does not select files or confine document paths. The caller supplies the document provider.

`orchestrator` is a list of prompt additions. An addition has `{ id, section, priority }`. The safe integer priority (at most 9007199254740991) and the section name are checked. Each `threadTypes` entry has an ID, a description, and a list of prompt additions under `prompt`.

Each `focusAreas` entry has an ID, a `design-triggering` or `reviewer-only` class, a description, a definition section, and a charter addition. The validator checks section references. It does not assemble prompts.

## Lifecycles and states

`root` names a declared lifecycle. Each lifecycle has an ID, description, initial state, and mappings for `conditions`, `guards`, `triggers`, and `states`. It may also have `anyState` transitions and a `steps` mapping. Conditions and triggers have an ID and description.

A guard has an ID, description, and expression. An expression names a declared condition or guard, uses `{ not: expr }`, or uses `{ and: [expr, expr, ...] }` or `{ or: [expr, expr, ...] }`. The last two forms need at least two expressions.

Guards and conditions cannot share a name. Guard references cannot form a cycle.

A state has an ID and description. It may have a section, a boolean `terminal` flag, a called lifecycle under `call`, and transitions under `on`. A terminal state cannot have `call` or `on`.

Each transition maps a trigger to a nonempty branch list. A branch has `{ id, to, when }` or `{ id, else }`. A single branch can omit `when`. In a longer list, each non-`else` branch needs a declared guard or condition under `when`. An `else` branch comes last, after guarded branches. `anyState` has the same branch format and contributes transitions from every non-terminal state.

A step has an ID, description, attach state, section, and completion trigger. It has one configuration condition in `when`. Boolean configuration uses `{ key, equals: true }` or `{ key, equals: false }`. Enum configuration uses `{ key, equals: value }` or `{ key, in: [values] }`, where each value is declared. An invalid enum condition reports up to eight declared values and counts the rest. Text configuration uses `{ key, present: true }`. A completion trigger cannot also occur in `on` or `anyState`.

Every state must be reachable from its initial state through `on` or `anyState`. Every non-terminal state must have such a path to a terminal state. Every other lifecycle must be on a call path from `root`, and calls cannot form a cycle. The validator does not count a call or step completion as a state transition. These checks validate declarations. They do not execute a workflow.

## Handler declaration

The handler source provider supplies text. The static check looks for a column-zero `export const handlers = {` line, followed by two-space-indented double-quoted event keys with identifier values. Every entry ends with a comma, including the last. The block closes with `};` on its own line. Each value needs a column-zero `function name(` declaration. The required keys are `root.start`, `root.ownerChanged`, `root.close`, `dispatch.validate`, `dispatch.prepare`, and `episode.received`.

LF and CRLF line endings work. A block comment, backtick, lone carriage return, or additional column-zero export is unsupported. The check reads text only and does not execute handlers or prove JavaScript meaning. A crafted file can pass the text check without usable exports.

Workflow authors can rely on the validator's declared forms, limits, paths, and problem severities. No command, tool, file reader, or handler execution is provided by this module. Runtime transitions, handler inputs, and handler results have no stable contract here.
