# ytdb-slate 0.17.0

This release simplifies delivery to one branch per change. It also reduces thread display noise and fixes worker access to forwarded tools.

## Highlights

- **One optional pull request for the whole change.** A change is the whole user request. Nested planning and implementation now share one branch. With `workflow.draftPRs` enabled, Slate creates one draft pull request for that change.
- **Quieter thread results.** The collapsed `thread` view hides warnings and failed tool calls while an action runs or after it succeeds. Failed actions still show their diagnostics. Expand a result to inspect all details.
- **Clearer track presentations.** A track is a bounded part of approved work. Slate now presents it as `Track <number> <title> (<position> of <count>)`. The stable track number no longer appears to be its current execution position.

## Fixes

- Workers can now call Model Context Protocol (MCP) tools through forwarding tools such as the pi-mcp-adapter gateway. The gateway can reach a deferred tool, which is registered but not active. The `directTools` workaround is no longer needed for this path.
- Collapsed successful actions no longer show warnings about retained temporary folders by default. Expanded results and the information sent to the orchestrator retain those warnings.
- Track presentations update their position and count after a split, reorder, or dropped track. A stable track number no longer implies that earlier work has already run.

## Compatibility

No configuration file migration is required.

The new top-level `threadDevMode` option defaults to `false`. Set `"threadDevMode": true` in `slate.json` and start a new session to show warnings and failed tool calls for every collapsed action. A non-boolean value produces a warning and uses `false`.

The `workflow.draftPRs` option keeps its default of `false`. When enabled, it now applies to the whole change.

No configuration key is removed, renamed, or newly ignored. Existing key defaults remain unchanged.

Expanded thread results and model-facing results retain all diagnostic details. The `threads` and `episode` views do not change.

Slate's own scripts still cannot call inactive tools directly. Forwarding tools may reach deferred tools. An adapter's separate script executor is outside this restriction.

Only the user merges a change pull request. Final acceptance must come first. Slate then verifies that the host merged the exact accepted branch commit.

## SDK compatibility

The tested integration remains pi software development kit (SDK) 1.4.0 with TypeBox 1.3.27. TypeBox is the schema library used by the SDK.

The repository pins `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to 1.4.0. It pins `typebox` to 1.3.27. These pins are unchanged from 0.16.0.

Continuous integration passed at the reviewed commit with these pins. The checks include type checking, extension loading, resolver checks, and tests with real pi sessions.

The SDK peer dependency ranges remain `*`. These ranges do not prove compatibility with every pi version. The available evidence does not establish the lowest working pi version.
