# Safety and trust

The [How Slate works](../README.md#how-slate-works) section defines orchestrator mode, worker thread, and main session.

## Worker extensions (`workerExtensions`)

By default worker threads load no project or discovered extensions. Slate supplies one internal reminder component to every worker session. After tool results reach its handler, the component tells the worker to issue independent tool calls in one turn. It sends the reminder once for each such turn. The reminder persists in the worker transcript and stays hidden from the user in the normal terminal interface. The component is not gated on project trust.

This key is a list of regex patterns that select extensions the **host session has already loaded** and load them into every worker too. Each pattern is matched **unanchored** (unlike `contextBudget.overrides`, which is anchored) against a load unit's recorded source spec (e.g. `npm:pi-web-search@1.3.1`), its load-unit path, or the entry path of any tool that unit contributes, so a bare package name matches:

```json
{
  "workerExtensions": ["pi-smart-fetch", "pi-web-search"]
}
```

Every worker then gets the fetch and web-search tools **on top of** `workerTools` (and on top of the per-dispatch `tools` argument of the `thread` tool — those two govern the built-in tools only). The orchestrator itself does **not** gain these tools — orchestrator mode keeps its restricted set — but its doctrine gains a rule naming each whitelisted extension and its tools, so it knows what it can delegate.

For project and discovered extensions, pi's discovery, project-trust gating, and dedup remain the only ingress. A worker cannot load a whitelisted extension that the host is not running. An extension that registers no tools cannot be whitelisted. A host started with extensions disabled offers nothing to whitelist. Slate's internal reminder component is the separate always-loaded input described above.

**What to know before whitelisting** — it reaches past Slate's isolation, so it is an operator decision:

- **Delegation is unbounded.** Slate guarantees only that no worker obtains Slate's own `thread`/`threads`/`episode` tools. A whitelisted extension that ships its own sub-agent or delegation tool under any other name gives workers delegation Slate can neither detect, bound, nor account for.
- **Credential and filesystem reach.** Inside a worker the extension has the same filesystem and credential access it has in the host. Slate's read-only settings snapshot blocks pi-settings writes and nothing else.
- **Worker lifecycle.** Slate completes each selected extension's `session_start` before the worker action begins. A startup failure blocks the action. Slate emits one `session_shutdown` before it disposes the worker, including after startup or action failure and during host shutdown.
- **Abort.** A third-party extension may ignore the abort signal, so its network activity can outlive an abort or a context-budget pause. During a pause, Slate still allows orchestrator state-save workers while it refuses new user prompts.
- **Cost.** Provider-native tool billing can escape Slate's worker cost accounting.
- **Pathological patterns.** The patterns are regexes from your own trusted config — the same file that already steers models, prompts, and tool lists — matched with no time bound while the extension set is resolved once per session. A pattern with catastrophic backtracking can stall that resolution. Avoid such patterns. They are not a privilege boundary.

The load-time recursion guard behind this — and the risks it does and does not cover — is in [`docs/design-principles.md`](design-principles.md).

## Worker provider registrations

Every worker inherits host extension provider registrations that are absent after the worker session is constructed. This behavior is independent of `workerExtensions`. It supports provider-only extensions that register no tools. The worker's own registration wins by provider id, even when one side uses a native provider and the other uses the config form. A built-in provider is not an extension registration, so a host extension override of a built-in is inherited.

Inheritance happens after worker session construction and before route authentication or the first model request. Slate copies current registrations and reuses their provider functions. Nested config values and native provider objects can remain shared by reference. A worker uses its own pi credential resolution, but inherited provider authentication callbacks and configured keys can read or update the same credential files and third-party state that the host uses. Slate does not copy host event handlers such as `before_provider_headers`, `before_provider_request`, or `after_provider_response`. Provider extensions that depend on those handlers will not behave the same in a worker.

A worker extension can register the same provider id during construction. Its registration takes precedence. Slate does not synchronize later host changes or intercept later worker registrations. Pi can merge a later partial worker registration with inherited config. That merge can retain inherited credentials while changing the endpoint. This accepted startup-only boundary requires extension authors to replace provider configuration carefully. Compatibility with specific third-party provider extensions has not been verified.

## Project trust boundary

Slate excludes untrusted project Slate configuration and content selected through that configuration. Home preferences remain active, including documents and host extensions selected by those preferences. A home document path can point into a working tree, so select those paths carefully.

Home preferences do not change pi's project-trust decision. Pi's independent instruction loading stays unchanged. In particular, this feature does not filter pi's `AGENTS.md` context files. Slate restores a handoff entry from the successor session using the same record validation as saved Slate state. The entry does not use project trust. Slate ignores old `.pi/slate/pending-handoff.json` files and leaves them untouched. Worker pi settings remain nonpersistent.

The stable `slate-handoff` custom session entry contains `sessionId`, `snapshot`, and optional `model`, `thinkingLevel`, and `logicalModel`. Only a session whose identifier equals `sessionId` can adopt it. A saved `slate-state` entry takes precedence. Older Slate versions do not understand `slate-handoff`. They cannot adopt a handoff that has no saved state. An older Slate version can drop scoped records from a saved state when it restores them. The files remain on disk.
