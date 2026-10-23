# Configuration

The [How Slate works](../README.md#how-slate-works) section defines orchestrator mode, worker thread, and main session.

## Configuration files and merging

Slate reads two optional configuration files at session start:

- Home: `<getAgentDir()>/slate.json`, normally `~/.pi/agent/slate.json`. Pi's `PI_CODING_AGENT_DIR` environment variable can select another agent directory.
- Project: `<cwd>/.pi/slate.json`, read **only when the project is trusted**.

Project values override home values. Objects merge recursively. Arrays, scalar values, and explicit `null` replace the home value. Arrays never append. Slate applies its setting validators after the merge.

The `notifications` group has a separate source rule. Only home settings can permit channels and text detail. A trusted project can turn channels off and lower detail. Push destinations and credentials come only from home settings.

A missing file is valid. An unreadable file, invalid JSON, or a root that is not an object produces a warning naming that file. Any such error in a permitted file blocks model routing, even when the other file is valid.

Home preferences also apply in untrusted projects. Without a home file, existing project behavior and defaults stay unchanged. Configuration edits require a new session.

Paths in `orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`, and `reviewPerspectivesPath` belong to the file that supplies the value. Relative home paths start at the agent directory. Relative project paths start at the project root, not `.pi`. Absolute paths stay absolute. See [Safety and trust](safety-and-trust.md) for the security boundary.

Pi can refresh a prompt cache by sending background requests. Slate disables those requests in every worker because they bypass its request limits. This does not disable prompt caching for ordinary worker requests. The main session and saved pi settings stay unchanged.

## Startup workflow summary

The short workflow summary is off by default. Run `/slate summary on` to save an opt-in. This command does not show the panel immediately. Slate shows it at the next interactive terminal startup with orchestrator mode on, or when you next turn that mode on. A saved `startupSummary: false` choice stops both automatic displays. The summary explains the workflow steps. It disappears when you send your first prompt to the model. A handoff successor keeps the current panel visibility instead of using the saved choice.

`/slate off` and `/slate summary off` remove a visible summary. Toggling orchestrator mode off with `/slate` also removes it. Other slash commands leave it visible unless they reload or replace the session. `/reload`, `/new`, `/resume`, and `/fork` clear the panel when they reload or replace the session. Slate then shows it only when orchestrator mode is on and the saved choice allows automatic display. Run `/slate summary` to show it on demand in any mode, even when automatic display is off. Run `/slate summary off` to stop automatic display. Run `/slate summary on` to save automatic display for the next opportunity.

Slate stores this choice as the boolean `startupSummary` key in `<getAgentDir()>/slate-preferences.json`. Pi uses `PI_CODING_AGENT_DIR` when that environment variable sets the agent directory. A missing file or key means the summary is off. Invalid values and read errors warn and enable the summary. This file does not grant home configuration permission in untrusted projects. A `startupSummary` key in either `slate.json` has no effect.

## Common starting point

Create `.pi/slate.json` when you want new interactive sessions to start in orchestrator mode:

```json
{
  "orchestratorModeDefault": true
}
```

The project must be trusted before Slate reads this file. Start a new session after any configuration change.

## Complete option reference

| Key | Type | Default | Semantics |
| --- | --- | --- | --- |
| `orchestratorModeDefault` | boolean | `false` | Start fresh interactive sessions with orchestrator mode ON. |
| `notifications.terminal`, `notifications.native`, `notifications.bell` | boolean | `true` | Channel permissions. A trusted project can turn a channel off but cannot enable a home-disabled channel. Configuration validation does not send notifications. |
| `notifications.push.enabled` | boolean | `false` | Home permission for phone push. A trusted project can disable it but cannot enable it. Configuration validation does not contact a server. |
| `notifications.detail` | `generic` \| `project` \| `message` | `generic` | Text permission for terminal and native channels. `generic` permits event text. `project` also permits the folder name. `message` also permits the agent message. A trusted project can only lower the home permission. |
| `notifications.pushDetail` | `generic` \| `project` \| `message` | `generic` | Independent text permission for push, with the same levels. Only home can raise it. A trusted project can lower it. General detail does not raise push detail. |
| `notifications.minimumDelayMs` | number | `30000` | Minimum interval since input, in milliseconds. Accept a nonnegative safe integer. A trusted project value wins. |
| `notifications.cooldownMs` | number | `60000` | Minimum interval between events of the same type, in milliseconds. Accept a nonnegative safe integer. A trusted project value wins. |
| `notifications.sequences` | `auto` \| string[] | `auto` | An explicit list must contain distinct values from `osc9`, `osc777`, and `osc99`. The list must not be empty. List order is preserved. A trusted project value wins. |
| `notifications.push.server` | string | — | Accept HTTPS (Hypertext Transfer Protocol Secure) addresses from home configuration for encrypted web traffic. Accept HTTP (Hypertext Transfer Protocol) only for loopback addresses, which refer to this computer. Allow `localhost`, IPv4 (Internet Protocol version 4) addresses starting with `127.`, or `::1`. HTTP connections also require a resolved loopback address. Reject embedded credentials, query strings, and fragments. The request path ends with `/`. An invalid address disables push with a generic warning. Slate ignores project destination and credential fields with one generic warning. |
| `notifications.push.topic` | string | — | Home-only topic name of 1 to 64 characters. Accept ASCII (American Standard Code for Information Interchange) letters `A-Z` and `a-z`, digits `0-9`, `_`, or `-`. Enabled push requires both server and topic. An invalid or missing destination disables push. |
| `notifications.push.token` | string | — | Home-only authentication token. Accept only characters allowed in HTTP headers, without control characters. Do not combine it with username and password. Invalid credentials disable push. |
| `notifications.push.username`, `notifications.push.password` | string | — | Home-only authentication pair. Supply both values or neither. Credentials must be nonempty and contain no control characters. A username cannot contain `:`. Invalid credentials disable push. |
| `workerTools` | string[] | `["read", "bash", "edit", "write", "grep", "find", "ls"]` | Select built-in worker tools only, as does the dispatch `tools` list. An empty list uses the default. Slate always adds worker-extension tools and its owned `codemode` tool. Codemode is a pi tool that runs JavaScript that calls other tools. Lists accept names, `*` patterns, or only `+name`/`-name` modifiers. Slate adds extension tools and owned codemode in the same form. Entries `codemode`, `+codemode`, and `-codemode` cannot control owned codemode. If codemode cannot load, the worker excludes it even from patterns and reports a warning. |
| `workerExtensions` | string[] | `[]` | Regex patterns (matched **unanchored**) selecting which of the host session's already-loaded extensions also load into every worker thread. Each matched extension's tools are added **on top of** `workerTools`. A worker extension that registers `codemode` is withheld as a whole, with a warning. Empty (default) means workers load no project or discovered extensions. Slate supplies three internal worker components: reminder, nested-call lifecycle, and codemode. The orchestrator keeps its restricted tool set but its doctrine is told what was whitelisted. Invalid patterns are dropped with a warning at session start. |
| `cacheKeyEnabled` | boolean | `true` | Add one OpenAI Responses prompt cache key to all workers in the current main Slate session. Another main session receives another key. `false` disables key injection. It does not disable request throttling. Provider requests with `cacheRetention: "none"`, including worker summaries, keep that opt-out and receive no forced key. |
| `cacheKeyShards` | number | ignored | This removed partitioning key has no effect. Slate reports it once at session start. Remove it from `slate.json`. |
| `requestThrottle.enabled` | boolean | `true` | Pace OpenAI Responses worker requests. `false` disables pacing. It does not disable cache-key injection. The scope includes worker turns, failover requests, history compaction, and branch summaries. It excludes orchestrator requests, episode compression, other provider interfaces, other sessions and processes, and direct tool requests. |
| `requestThrottle.maxRequestsPerMinute` | number | `12` | Maximum logical SDK requests admitted for one actual `provider/id` in the preceding 60 seconds. The value must be a whole number from 1 through 1000. Provider network retries inside one SDK request do not consume another admission. Different models have independent counters. This threshold is request pacing, not a cache-hit or provider-rate-limit guarantee. |
| `requestThrottle.baseWaitMs` | number | `1000` | Base delay before a blocked request rechecks capacity. The value must be a whole number from 1 through 60000. A positive minimum prevents a repeated zero-delay loop. |
| `requestThrottle.jitterMs` | number | `1000` | Uniform random extra delay from zero through this inclusive bound before a blocked request rechecks. The value must be a whole number from 0 through 60000. Admission is approximately fair. It is not first-in-first-out and does not promise a bounded wait. |
| `maxConcurrent` | number | `8` | Maximum concurrent worker actions per manager. Accepts positive safe integers only. Invalid input warns and selects 8. Excess actions wait for a slot. Every action has its own thread. See the worker-limit guidance below and `docs/design-principles.md` §5. |
| `contextBudget` | number \| object | `256000` (Anthropic models: `400000`) | Absolute orchestrator context budget (tokens) at which Slate auto-pauses and prepares a fresh-session handoff — semantics, defaults, per-model overrides, and rationale in [`docs/context-budget.md`](context-budget.md). |
| `orchestratorPromptDocs` | string[] | `[]` | Markdown files whose paths follow the source rules above and whose **contents** are appended to the orchestrator system prompt. |
| `workerPromptDocs` | string[] | `[]` | Markdown files whose **contents** are appended to every worker-thread system prompt. |
| `workflow.draftPRs` | boolean | `false` | Enable one draft pull request per level with code tracks. A change without design tracks keeps one pull request. See [pr-publishing.md](pr-publishing.md) § One draft pull request and § Creation. |
| `workflow.followUpIssues` | boolean | `false` | When true, the orchestrator asks which deferred items become tracked issues. Deferred items are always reported whatever the value. |
| `workflow.routingRecommendations` | boolean | `false` | Before final acceptance, add an evidence-bounded model-routing field for logical models dispatched during the current change. Show the field only when records support advice. Keep no-advice results in the research log. Never edit routing files. |
| `writing.check` | boolean | ignored | This ignored writing key remains accepted for compatibility. Remove it from `slate.json`. Guidance is automatic during orchestrator mode when the project is trusted or a home file exists. See [`docs/writing-guidance.md`](writing-guidance.md). |
| `writing.remind` | boolean | ignored | This ignored writing key remains accepted for compatibility. Remove it from `slate.json`. Reminder gates require orchestrator mode, permitted Slate settings, no pause, and a ready trigger. Delivery is limited to one reminder per response round. See [`docs/writing-guidance.md`](writing-guidance.md). |
| `writing.remindPercent` | number | ignored | This retired key remains accepted and ignored. Slate emits a notice. Replace it with `writing.remindTurns`, which counts completed turns instead of a token-budget share. |
| `writing.remindTurns` | number | `4` | Set the reminder cadence in completed turns. The value must be a whole number from 1 through 20. An invalid value warns and falls back to `4`. See [`docs/writing-guidance.md`](writing-guidance.md). |
| `writing.remindOnFinding` | boolean | `true` | Send a reminder on the turn after a measured turn with a model-visible finding. An invalid value warns and falls back to `true`. `writing.findings: false` disables this trigger. |
| `writing.sentenceWordLimit` | number \| boolean | `25` | Set the sentence-length house-style limit in words. The value must be a whole number from 10 through 200, inclusive, or `false` to turn the rule off. See [`docs/writing-guidance.md`](writing-guidance.md). |
| `writing.statusWindowTurns` | number | `10` | Set the whole-number status window from 3 through 100 measured turns. An invalid value warns and falls back to `10`. When `writing.showStatus` is true, the status line reports model-visible fail and style counts in this window. |
| `writing.showStatus` | boolean | `false` | Show the writing part of the status line. An invalid value warns and falls back to `false`. Measurement and reminders continue when it is `false`. |
| `writing.findings` | boolean | `true` | Include the latest model-visible writing findings in the hidden reminder. An invalid value warns and falls back to `true`. Measurement continues when this value is `false`. The status line follows `writing.showStatus`. |
| `doctrineExtraPath` | string | — | Markdown whose **content** is appended to the orchestrator doctrine (project-specific workflow additions). |
| `reviewPerspectivesPath` | string | — | Review charters, each declaring its own finding-ID prefix. The doctrine references this **path**; the orchestrator reads the file alongside the shipped review rules. |
| `router.models` | object | shipped six-model pool | Ordinary membership and definitions. `include` replaces the starting membership, including with an empty list. `add` accepts complete new definitions. `replace` changes selected fields. `exclude` applies last. Within each model definition, lists and provider maps replace shipped fields. The home and project configuration files merge first. |
| `router.compressor.models` | array of `{ model, effort }` | `[{"model":"claude-sonnet-5.5","effort":"medium"}]` | Independent ordered compressor list. An explicit empty list blocks work. |

Notification settings define permissions and text policy. Slate validates these settings at session start. Slate registers terminal, bell, native and push delivery channels. A channel is one delivery route. Slate registers no notification tool. See [Notifications](#notifications) for automatic delivery and setup.

Invalid values produce generic warnings that name the setting and its home or project source without showing supplied values. Invalid channel values use the channel defaults, combined with home permission for project values. Invalid detail falls back to `generic`. Invalid intervals use their defaults. Invalid sequence selection uses `auto`. Invalid or incomplete push destinations disable push.

## Action concurrency and script workers

A positive safe integer is a whole number from 1 through `Number.MAX_SAFE_INTEGER`.
Missing `maxConcurrent` selects 8 without warning.
Other invalid values produce one fixed warning:

> slate: maxConcurrent must be a positive safe integer. Using 8.

Slate does not convert strings or round fractions.
Both action admission and the derived script-worker limit use the validated value.
A script worker executes one codemode script.
Slate sets `PI_CODEMODE_MAX_WORKERS` from action concurrency at session startup
when the variable is absent or still holds Slate's last written string.
A present external value remains exact, including empty and invalid strings.
Pi interprets those overrides and applies its own fallback.

Configuration reload takes effect at the next session startup.
The latest committed startup updates the Slate-owned process default.
Earlier managers keep their action limits, but scripts use the current process pool.
An external change revokes Slate ownership. Deletion permits a fresh default.
An external rewrite to exactly Slate's current string cannot be detected.
A later startup may replace that same string. Shutdown does not restore a value.

The worker-limit variable is per process.
Child processes inherit it, including bash tool commands and nested pi sessions.
Each nested pi has its own pool of the inherited size.
Users can set the variable explicitly for children, for example
`PI_CODEMODE_MAX_WORKERS=2 pi`.
Separate pools multiply possible script workers across processes.
They do not share one capacity limit.

A decrease does not stop running scripts.
An increase does not itself wake pi waiters.
Pi reevaluates capacity on its next admission or release.
Eight concurrent actions do not guarantee eight available script slots.

## Notifications

Slate automatically attempts delivery when the main session needs attention.
Channel settings control automatic delivery. There is no separate enable setting.
Notifications work with orchestrator mode on or off.
Worker threads do not trigger their own Slate notifications.

Slate sends notifications only in pi's interactive terminal mode.
Print mode and Remote Procedure Call mode, abbreviated RPC, send none.
Terminal sequences and bells also require standard output to be a real terminal.
Captured or redirected output receives no notification controls.

### Automatic waits and timing

A run wait starts after pi reports that the main run has settled.
Settlement means the run has ended, including retries and queued continuations.
Slate also waits for its own model recovery to finish.
A normal outcome sends **Input needed**. A final error sends **Error**.
Successful recovery does not send the intermediate error.

An open extension dialog can also start an **Input needed** wait.
Slate observes extension dialog start and end events.
A blocking dialog waits for your answer before work can continue.
Closing the dialog cancels its pending wait.
These events can also describe nonblocking overlays.
An event proves an outstanding interaction, not that the agent has stopped.

The default minimum delay is 30,000 milliseconds, or 30 seconds.
The delay starts at settlement or dialog opening, whichever wait applies.
Observed activity restarts the delay for a pending wait.

The default cooldown is 60,000 milliseconds, or 60 seconds, between attempts of the same event type.
Input-needed and error events have separate cooldowns.
A wait that fails the cooldown check sends nothing.
Slate does not repeatedly notify about the same wait.

Before delivery, Slate checks that the wait still belongs to the current session.
A run wait also requires an idle agent, no queued message and no active Slate recovery.
A dialog wait requires an open observed dialog.
Each channel permits at most one attempt at a time.
A busy channel does not block the other channels.

Change the delay and cooldown in home or trusted project configuration:

```json
{
  "notifications": {
    "minimumDelayMs": 30000,
    "cooldownMs": 60000
  }
}
```

### Observed activity and stop limits

Slate restarts pending waits for these observed actions:

- Terminal input that reaches Slate's listener, including typing and navigation keys.
- An interactive prompt submission or a `!` shell command.
- Session tree navigation, which selects another point in conversation history.
- Model selection or a change to the model's thinking effort.
- A session information change, such as renaming the session.
- Manual compaction, which shortens conversation history.

Model requests do not count as user activity.
Activity alone never sends a notification.
After Slate admits delivery, later activity does not recall that attempt.

The listener cannot observe every human action.
Earlier extension listeners and full-screen input consumers can hide keys.
Built-in pi dialogs may emit no extension dialog events.
Reading output without keys can outlast the delay and cause a notification.
Rare terminal replies and extension-caused activity events can postpone a notification.
Slate does not detect terminal focus or replace the editor.

A final response marked as aborted suppresses the run notification.
An observed aborted run signal also suppresses it.
Slate cannot detect a stop when pi supplies neither form of evidence.

A stop before an automatic retry can leave the earlier error visible to Slate.
Slate can then send **Error**.
A stop during another extension's end-of-run handler can leave a normal outcome.
Slate can then send **Input needed**.
Slate does not infer a stop from Esc, which also closes dialogs and menus.

### Session replacement and reload limits

A handler is an extension callback that pi calls for an event.
Slate observes replacement requests through its `session_before_switch` and `session_before_fork` handlers.
Outgoing-session notifications stop when Slate's handler observes the request.

The built-in commands include `/new`, `/fork`, `/resume`, `/import` and `/clone`.
Other extensions can also request replacement.
An extension can delay or cancel a request.
Pi supplies no final cancellation result for requests that Slate did not start.

Pi calls these handlers in extension order and waits for each to finish.
An earlier handler can delay or cancel `/new` or a fork before Slate observes the request.
An existing outgoing-session wait can still deliver while that earlier handler runs.
No new prompt is needed.
If the earlier handler cancels the request, Slate's handler does not run.

Slate tracks its own `/slate handoff` until it finishes, including its wait for the agent to stop.
A pending Slate handoff keeps outgoing notifications off.
After cancellation, Slate restores notifications only when no other replacement request remains pending.

For other replacement requests, the next interactive prompt submitted while the agent is idle clears Slate's pending state.
Notifications resume only when no Slate handoff remains pending.
A `!` shell command alone does not restore them.

After Slate observes a request, one outgoing notification can still occur during a delayed replacement when all these conditions hold:

1. Slate did not start the replacement request.
2. Another extension delays it without a pi dialog.
3. You submit a prompt while the agent is idle during that delay.
4. The new run settles or a dialog opens before replacement finishes.
5. No Slate handoff is pending.

A replacement that proceeds aborts any run started during that delay.
Running `/reload` during a pending replacement creates a Slate instance that does not know about that request.
The new instance can send one outgoing notification before replacement finishes.

Slate cannot recall a notification that a channel has already accepted.
A started native helper or sent push request can finish after replacement or reload.
Native and push attempts retain their time limits.
A crash or emergency exit can skip cleanup and leave a started helper to finish.

### Text detail and permissions

Terminal and native text follow `notifications.detail`.
Push text follows the independent `notifications.pushDetail` setting.
Both default to `generic`.
Raising general detail does not raise push detail.
Only home configuration can permit higher detail.
A trusted project can only lower either home permission.

| Detail | Permitted text |
| --- | --- |
| `generic` | Only the event type, **Input needed** or **Error**. |
| `project` | The event type and current folder name. |
| `message` | The event type, folder name and end of the latest agent text. |

Message detail copies at most 200 bytes of UTF-8, the Unicode text encoding, with a leading `…`.
Slate copies text, not thinking or tool data.
For an error without agent text, message detail can copy provider error text instead.
Provider error text reaches push only at a home-authorized `message` level.
Slate removes terminal controls and text direction controls.
Channel size limits can shorten text further.

Home configuration permits terminal, native and bell channels by default.
Push defaults to off. A trusted project can disable any channel but cannot grant home-denied permission.
To turn all delivery off, set these home or trusted project values:

```json
{
  "notifications": {
    "terminal": false,
    "native": false,
    "bell": false,
    "push": { "enabled": false }
  }
}
```

### Terminal client delivery and the bell

Native delivery uses the operating system on the host that runs pi.
Terminal delivery sends control sequences to the terminal client that displays pi.
A control sequence is a fixed byte request that a terminal can interpret.
Over Secure Shell, abbreviated SSH, the host and terminal client can be different computers.
Native delivery on a remote host does not notify the client desktop.
Terminal delivery depends on the client terminal's support and permissions.

Slate supports three Operating System Command protocols, abbreviated OSC: `osc9`, `osc777` and `osc99`.
The default `sequences: "auto"` selects protocols from terminal identity hints.
Outside tmux, a terminal program that manages multiple windows and panes, Slate chooses at most one protocol:

| Identified terminal | Automatic choice |
| --- | --- |
| iTerm2 | `osc9` |
| WezTerm or Ghostty | `osc777` |
| kitty or foot | `osc99` |
| Konsole | `osc777` |
| Visual Studio Code terminal | `osc99` |
| Windows Terminal, GNOME Terminal, Alacritty, macOS Terminal.app or an unknown terminal | No sequence. The independent bell remains available. |

Windows Terminal Preview 1.26.2734.0 or later can show OSC 777 notifications as Windows toasts, which are desktop notifications.
Set the profile setting `compatibility.allowOSC777` to `true`.
The Settings path is Profiles → Terminal Emulation → **Allow OSC 777 (Desktop Notification) to show toast notifications**.
Automatic selection sends no sequence to Windows Terminal, so select `["osc777"]` explicitly.

Windows Terminal can hide the toast while its window is active and the sending tab and pane are selected.
Selecting another Windows Terminal tab while waiting avoids this.
Windows Terminal shows at most one notification every 5 seconds.
Terminal delivery works for remote pi sessions reached through SSH, including from a Windows Subsystem for Linux (WSL) shell.

Automatic selection uses environment variables and cannot prove every connection arrangement.
Hints inherited across SSH can describe a different terminal.
Slate queries attached tmux clients when possible.
For several identified clients, automatic selection reaches as many as possible without duplicate sequence notifications to any identified client.
Some clients can receive no sequence notification.
A failed query or no identified client causes a fallback to environment hints.

Tmux requires your `allow-passthrough` permission to forward notification sequences.
On tmux 3.4, `allow-passthrough on` delivers no notification sequence from an inactive window.
Use `all` on tmux 3.4 or later to permit sequences from invisible panes too:

```sh
tmux set-option -g allow-passthrough all
```

An attached client must belong to a session containing the producing window.
Slate does not change this permission.
In tmux automatic mode, the bell can wait up to one second for the client query.
The query and other channel preparation finish before delivery starts.

An explicit list bypasses automatic selection and sends every listed protocol in order:

```json
{
  "notifications": { "sequences": ["osc777"] }
}
```

Choose only protocols your client supports.
Several entries can cause duplicate notifications.
An explicit list cannot override an ambiguous route with multiple multiplexer hints.

A multiplexer is a program such as tmux, GNU screen or Zellij that manages terminal sessions.
Slate suppresses sequences for multiple such hints and warns once per session.
The bell stays independent.
Slate wraps sequences for tmux and GNU screen.
Zellij receives unwrapped requests and controls their forwarding through its own settings.

The bell is a separate alert byte, not a notification sequence.
An unsupported terminal receives no automatic sequence but can still handle the bell.
Your terminal or tmux bell settings can mute it or turn it into a visual alert.
Terminal notification permissions and focus rules can suppress display despite correct bytes.
Slate does not detect focus or override those rules.

When pi runs directly on Windows, its standard output is the Windows console.
Write order in that console has not been validated by hand.
Slate therefore makes no terminal compatibility claim for pi running directly on Windows.

### Native host delivery

Native delivery needs the host's desktop notification service and permission to show notifications.
A remote host without a desktop service can provide no native display.
Missing helpers, denied permission and delivery failures show no warning.
A native failure does not stop other channels.

| Host | Native route and prerequisites | Delivery attempt limit |
| --- | --- | --- |
| Linux | `notify-send` from an absolute search-path directory outside the project and `node_modules`. A desktop display and a user notification service must be available in pi's environment. | 5,000 milliseconds |
| macOS | `/usr/bin/osascript` uses the user's notification service. Check the notification permission for the sender on your machine. | 5,000 milliseconds |
| Windows | Windows PowerShell 5.1 at the system path. Slate uses the first case-insensitive exact-name Windows PowerShell entry in the Start applications folder for its registered application identity. | 10,000 milliseconds |

Windows uses the system's Start entry, not a universal application identifier.
The Start applications folder is the application list that `Get-StartApps` enumerates.
The production helper reads that folder directly and disables PowerShell module auto-loading.

A toast is a Windows desktop notification.
Hosted Windows checks read back toast history through the operating system.
History read-back proves retention, not visible presentation.

Libnotify is the library that supplies `notify-send` on Linux.
Linux native delivery requires a helper that supports `--app-name`.
Slate passes `--app-name=Slate` on every Linux native attempt.
Older stock `notify-send` helpers without `--app-name` reject Slate's `--app-name=Slate` argument before creating a notification.
Native delivery then fails without a warning.

A desktop entry is a file that identifies an application to the desktop environment.
On KDE Plasma, notifications use the application name `Slate` without a desktop entry, so Plasma applies its **Other Applications** notification settings.
The **Show in history** setting controls whether notifications stay in history, not whether visible banners appear.

Slate doubles body backslashes before the helper parses escape sequences.
Use [Check delivery by hand](#check-delivery-by-hand) to check local helper support and visible delivery.

### Phone push through ntfy

Ntfy is a notification server with phone applications that subscribe to topics.
A topic is a named destination that receives messages for its subscribers.
Put push destinations and credentials in the home file, normally `~/.pi/agent/slate.json`.
A trusted project cannot supply or replace them.

For a public-server check, choose a long random topic name and keep text generic:

```json
{
  "notifications": {
    "pushDetail": "generic",
    "push": {
      "enabled": true,
      "server": "https://ntfy.sh",
      "topic": "replace-with-random-topic"
    }
  }
}
```

Replace the topic placeholder before starting pi.
Install an ntfy phone application and subscribe to the same server and topic.
Allow phone notifications and follow the application's background-delivery instructions.
Start a new interactive pi session after saving the home file.

Follow [Check delivery by hand](#check-delivery-by-hand) to isolate push and check the effective settings.
The effective settings are the values Slate uses after resolving home and trusted project configuration.
Send a short prompt.
After the response settles, leave the session untouched for the effective `notifications.minimumDelayMs`, then allow time for delivery.
The default delay is 30 seconds.
Check actual phone receipt, not just a successful subscription.

A public topic is not private storage.
Anyone who knows its name may subscribe unless the server enforces access control.
A random name reduces accidental discovery but is not authentication.
The server can read and retain notification text.
HTTPS encrypts the network connection, not the message from the server.
Slate provides no end-to-end encryption between pi and your phone.

For private text, use an authenticated server that you host and control.
Configure the server to deny unauthenticated topic access.
Grant your account publish and subscribe access only to the required topic.
For example, use a server-issued access token in the home file:

```json
{
  "notifications": {
    "push": {
      "enabled": true,
      "server": "https://ntfy.example.com",
      "topic": "slate-alerts",
      "token": "replace-with-server-issued-token"
    }
  }
}
```

Configure the phone subscription with credentials that permit reading that topic.
Follow your server's mobile-delivery setup instructions.
Slate also accepts `username` and `password` instead of a token.
Supply both values. Do not combine the pair with a token.
Keep credentials out of project configuration and version control.

Push detail defaults to `generic` independently of `notifications.detail`.
Only a home-authorized higher `pushDetail` can disclose the folder name or agent message text.
At `message`, an error without agent text can also disclose provider error text.
On a public server, the server and other topic subscribers can read the added text.
A trusted project can lower push detail but cannot raise it.

#### Push validation and connection limits

- Topic names contain 1 to 64 ASCII letters, digits, underscores or hyphens.
- Credentials must be nonempty and contain no control characters.
- Tokens must also use characters allowed in HTTP headers.
- A username cannot contain `:`.
- A server address cannot contain embedded credentials, a query string or a fragment.
- Slate adds a trailing `/` to the server request path when needed.
- HTTPS supports remote servers. HTTP accepts only configured loopback names or addresses.
- An HTTP connection starts only when its selected resolved address is loopback.
- Slate tries one address per attempt, with no alternate-address retry or redirect.
- The push attempt limit is 5,000 milliseconds, including name lookup and connection work.
- Slate ignores proxy environment variables. Push does not work where a proxy is required.

Ordinary Node uses a child process for system lookup, which preserves hosts-file entries.
Bun and Node single executable applications use Domain Name System lookup, abbreviated DNS, instead.
A single executable application bundles Node and application code into one executable.
Those runtimes read no hosts file for push lookup.
They supply loopback answers for `localhost` and names below it without reading a hosts file or querying DNS.
Other names require DNS answers.

Invalid configuration warns at startup. Push delivery failures show no warning.

### Check delivery by hand

Sending, retention and visible presentation are different results:

- **Sending:** Slate writes terminal bytes, starts a native helper or sends a push request.
- **Retention:** A service keeps the notification in its history or store.
- **Visible presentation:** The user's desktop or phone shows the notification.

Correct terminal bytes do not prove that the terminal interpreted them.
Native history read-back does not prove a visible banner.
A server accepting push does not prove phone receipt.
Slate shows no warning for native or push delivery failure.
No failure warning does not mean delivery succeeded.
Configuration warnings still identify invalid settings.

Use the effective settings for each check, not just the defaults.
Slate resolves these values from home and trusted project configuration.

1. Enable the channel under test in home configuration. Turn the other channels off.
   Use `notifications.terminal`, `notifications.native`, `notifications.bell` and `notifications.push.enabled` to select channels.
   For push, also supply the home destination described in [Phone push through ntfy](#phone-push-through-ntfy).
2. Check trusted project configuration for settings that disable the selected channel.
   Check `notifications.minimumDelayMs` and `notifications.cooldownMs` for timing overrides.
3. On Linux, check that `notify-send --help` lists `--app-name` before a native check.
   A helper without that option cannot deliver Slate's native notification.
4. Start a new interactive session in a terminal with the required permissions.
   Send a short prompt, such as `Reply with OK`.
5. After the response settles, leave the session untouched for the effective `notifications.minimumDelayMs`, then allow time for delivery.
   The default delay is 30 seconds.
   Check the intended desktop or phone for **Input needed**.
   For a bell-only check, check the terminal's audible or visual bell instead.
6. Before checking a blocking extension dialog, wait for the effective `notifications.cooldownMs` to end after the previous input-needed attempt.
   The default cooldown is 60 seconds.
   If the attempt time is unknown, wait the full cooldown after step 5.
   Open the dialog if one is available.
   Leave it untouched for the effective `notifications.minimumDelayMs`, then allow time for delivery.
   Check the selected channel, then answer the dialog.

A dialog wait that expires during the cooldown sends nothing.
Slate does not deliver that expired wait after the cooldown ends.
Timing or channel settings can cause silence even when delivery works.

Check operating system and terminal notification permissions if nothing appears.
Check Focus or Do Not Disturb settings, which can suppress visible alerts.
Check history separately from visible display.
For SSH, check the client desktop for terminal delivery and the host desktop for native delivery.
Repeat from an inactive tmux window with the documented passthrough permission.

Record the host, client, versions, settings and observed result.
Do not report unavailable checks as successful delivery.

## Extended example

The `docs/agents/...` values below are placeholders. Point them at Markdown files that exist in your project.

```json
{
  "orchestratorModeDefault": true,
  "cacheKeyEnabled": true,
  "requestThrottle": { "enabled": true, "maxRequestsPerMinute": 12, "baseWaitMs": 1000, "jitterMs": 1000 },
  "maxConcurrent": 8,
  "orchestratorPromptDocs": ["docs/agents/orchestrator-guidelines.md"],
  "workerPromptDocs": ["docs/agents/thread-guidelines.md"],
  "workflow": { "draftPRs": true, "followUpIssues": false, "routingRecommendations": false },
  "writing": { "remindTurns": 4, "remindOnFinding": true, "sentenceWordLimit": 25, "statusWindowTurns": 10, "findings": true },
  "doctrineExtraPath": "docs/agents/workflow-additions.md",
  "reviewPerspectivesPath": "docs/agents/review-perspectives.md",
  "router": {
    "models": { "include": ["luna-6", "claude-opus-5.5"] },
    "compressor": { "models": [{ "model": "claude-sonnet-5.5", "effort": "medium" }] }
  }
}
```

Remove `writing.check` and `writing.remind` when copying an older configuration. Current Slate reports these ignored writing keys.

## Built-in implementation review

Pass the optional `reviewPerspectives` list to `thread` with type `reviewer` for a built-in implementation review. Use the perspective names in [review-rules.md](review-rules.md) § Built-in implementation perspectives. The list must be nonempty and contain distinct names. Reviewer I and Test-quality and structure reviewer each run alone. Other specialists may share a list only when their code scope and required evidence match.

Slate loads the shared policy, implementation inputs, and selected charters before opening a worker. An invalid list or a missing, unreadable, or blank required file refuses dispatch before worker creation. An omitted list keeps the manual review route. The list does not enter saved thread state. Prefixes identify findings and do not select perspectives.

## Document path warning

> **Silent skip:** document-path errors produce no warning. Slate skips missing, unreadable, or empty files selected by `orchestratorPromptDocs`, `workerPromptDocs`, and `doctrineExtraPath`. For `reviewPerspectivesPath`, Slate omits the pointer only when the file is missing. Slate does not read that file at injection time, so an unreadable or empty file is still cited. Verify your paths after copying the example.
