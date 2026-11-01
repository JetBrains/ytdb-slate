# ytdb-slate 0.18.0

This release changes notification timing and improves the guide to feature development with Slate.

## Highlights

- **Two-minute notification delay.** Slate now waits two minutes by default before notifying you that a completed response or an open dialog needs attention.
- **Clearer introduction.** The main guide explains how you direct research, judge designs and accept results. It also explains when plain pi is enough.
- **Stronger test coverage checks for contributors.** Test coverage measures how much code tests exercise. Small changes now have an enforced minimum for alternative code paths.

## Fixes

- A previous notification no longer suppresses a later notification of the same type. Each separate wait can notify after its delay if the other delivery checks pass.
- The repository test coverage check no longer treats changes with 1–19 measured changed branches as advisory. A branch is an alternative code path. Tests must exercise at least 70% of those branches.

## Breaking changes

1. **The notification cooldown setting has no effect.** A cooldown was the minimum interval between notifications of the same type. Slate removes that limit and ignores `notifications.cooldownMs`. It warns at session start for each home or trusted project configuration file that contains the key. Action: Remove `notifications.cooldownMs` from those `slate.json` files.

2. **The default notification delay increases from 30 seconds to two minutes.** The `notifications.minimumDelayMs` setting controls this delay in milliseconds. The new default is `120000`. It applies to completed responses and open dialogs. Action: Set `"minimumDelayMs": 30000` inside `notifications` in home or trusted project `slate.json` if you need the previous delay. Otherwise, allow two minutes when checking delivery.

## Compatibility

Explicit `notifications.minimumDelayMs` values keep their meaning. A trusted project value still takes precedence over the home value. Start a new session after changing configuration.

No configuration key is added or renamed. Notification permissions and delivery channels do not change. Slate still avoids repeated notifications for the same wait.

For contributors, the default branch coverage minimum remains 85% for changes with at least 20 measured changed branches. The line coverage minimum remains 85%. Changes with zero measured changed branches still require manual review. These checks belong to this repository, not to the installed extension.

The guide describes planned design tools as future work. This release does not add those tools.

## SDK compatibility

The tested integration remains pi software development kit (SDK) 1.4.0 with TypeBox 1.3.27. TypeBox is the schema library used by the SDK.

The repository pins `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` to 1.4.0. It pins `typebox` to 1.3.27. These pins are unchanged from 0.17.0.

Successful continuous integration checks at the reviewed commit used these pins. Continuous integration runs automated repository checks.

The SDK peer dependency ranges remain `*`. A peer dependency uses a package supplied by the host installation. These ranges do not prove compatibility with every pi version. The available evidence does not establish the lowest working pi version.

