# ytdb-slate 0.16.0

This release fixes an unnecessary pause after moving work to a fresh pi session. It requires no configuration changes.

## Highlights

- **Work continues after a successful handoff.** A handoff moves work to a fresh pi session. The assistant no longer asks you to run `/slate resume` when Slate has already restored the saved model successfully.

## Fixes

- Slate now sends the hidden pause instruction only when model restoration leaves the new session paused. Previously, the instruction could remain after successful restoration and make the assistant wait instead of starting work. Tests cover successful restoration and failure paths.

## Compatibility

No `slate.json` key is added, removed, renamed, or newly ignored. Configuration defaults remain unchanged.

Failed model restoration still pauses the session. The `/slate resume` command keeps its existing behavior.

No configuration migration or change to saved workflow records is required.

## SDK compatibility

The supported and tested integration remains pi software development kit (SDK) 1.4.0 with TypeBox 1.3.27. TypeBox is the schema library used by the SDK.

The repository pins `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to 1.4.0. It pins `typebox` to 1.3.27.

Repository checks use these versions for type checking, extension loading, and tests with real pi sessions. This release also adds tests for successful model restoration and failure paths during handoff.

The SDK peer dependency ranges remain `*`. These ranges do not establish compatibility with every pi version. The available tests do not establish the lowest working pi version.
