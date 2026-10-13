# ytdb-slate 0.14.0

This release adds notifications for interactive sessions. It also adds support for nested design and implementation tracks. Slate needs no configuration change from 0.13.0. Notifications are on by default, so read the compatibility section before you upgrade.

## Highlights

- **Notifications for interactive sessions.** Slate now alerts you when a session needs your input or ends with an error. Slate can send each alert through four channels:
  - a desktop notification from the operating system
  - a terminal notification through an operating system command (OSC) escape sequence: OSC 9, OSC 777 or OSC 99
  - the terminal bell
  - a push message to your phone through an ntfy server. ntfy is an open-source push notification service.

  Terminal, desktop and bell notifications are on by default. Push is off by default. Notifications work with orchestrator mode on or off. Slate sends an alert only after 30 seconds without activity. It sends the same kind of alert at most once every 60 seconds. Print mode and remote procedure call (RPC) mode send no notifications. The new `notifications` group in `slate.json` controls the channels. `docs/configuration.md` describes each key.
- **Nested tracks.** Slate divides a large change into tracks. A track is one part of the planned work. A code track changes code. A design track plans a part of the change and divides that part into child tracks. A child track can also be a design track, so the work can have several nested parts. Slate numbers child tracks with dotted numbers. For example, track `1.2` is the second child of track `1`. Every track uses the same review and acceptance steps. The orchestrator follows these rules for nested tracks:
  - Some tracks need code from another track. Slate finishes the code track first. The dependent tracks then start from the Git branch of that code track. You merge the pull requests in that order.
  - Slate keeps every reviewed state of the work in a separate Git branch. The reviewed commits then stay available when a squash merge or a branch deletion removes them from the pull request branch. When draft pull requests are on, Slate pushes these branches to the remote repository.
  - Slate deletes these kept branches only after you accept and merge all of the work. Slate deletes no other branch or file. Slate reports the result before the change closes.

  Slate does not start tracks or check these rules automatically.
- **One draft pull request for each group of child tracks.** This item applies only when `workflow.draftPRs` is on. Slate now opens one draft pull request for each group of child tracks of the same design track. A pull request contains only the code tracks of its group. A group that has only design tracks gets no pull request of its own. Each child design track gets its own pull requests for its own child tracks. For example, design track `1` has the code tracks `1.1` and `1.2` and the design track `1.3`. Slate opens one pull request for `1.1` and `1.2`. The child tracks of `1.3` get their own pull request. A change without design tracks still uses one pull request. The default of `workflow.draftPRs` is still `false`.

## Fixes

- Slate now reports tool errors from completed worker sessions in the result that the orchestrator receives. Before this fix, these errors could stay hidden in the worker summary.

## Compatibility

This release adds the optional `notifications` group to `slate.json`. It removes and renames no key. No existing default changes. Router configuration, the shipped logical models and the default compressor do not change.

To turn off notifications, set `notifications.terminal`, `notifications.native` and `notifications.bell` to `false`. Push stays off unless you turn it on.

Push settings are allowed only in the `slate.json` file in your home directory. A project `slate.json` can turn push off, but it cannot turn push on. Slate ignores the push server, topic and credentials in a project file, and it shows one warning. To use push, set `notifications.push.enabled`, `notifications.push.server` and `notifications.push.topic` in your home file. Then subscribe to the topic in an ntfy phone app.

Some channels need setup:

- Desktop notifications on Linux need `notify-send` with support for `--app-name`.
- Notifications from an inactive tmux window need `allow-passthrough all` on tmux 3.4 or later.
- Windows Terminal needs the sequence list `["osc777"]` and `compatibility.allowOSC777: true`.

Slate does not report a failed notification. Slate has not tested terminal notifications when pi runs directly on Windows.

A change that is already in progress keeps its recorded workflow. Slate moves it to the new workflow only when you approve that. A new change with more than one track needs a high-level design.

Start a new pi session after you change `slate.json`.

## SDK compatibility

The pi software development kit (SDK) development pins do not change. Slate 0.14.0 was developed and tested against pi 1.0.0 and TypeBox 1.3.27. The SDK packages are still peer dependencies with the range `*`. This release states no minimum pi version, because no test establishes one.
