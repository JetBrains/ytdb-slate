# ytdb-slate 0.13.0

This release updates two shipped logical models to newer provider models: Sol 6.1 and Claude Sonnet 5.5. It also changes the model routing guidance for reviews. Development checks now use pi 1.0.0. Read the breaking change below before you upgrade, because two shipped logical model names change.

## Highlights

- **Sol 6.1 replaces Sol 6.** A logical model is a provider-free name that the orchestrator selects for a `thread` action. The shipped logical model `sol-6` is now `sol-6.1`, and it uses the physical model `openai/gpt-6.1-sol`. Its capability rating changes from 58 to 85. Its cost rating stays at 20. Its effort stays `high`.
- **Claude Sonnet 5.5 replaces Claude Sonnet 5.** The shipped logical model `claude-sonnet-5` is now `claude-sonnet-5.5`, and it uses the physical model `anthropic/claude-sonnet-5-5`. Its capability rating changes from 40 to 45. Its cost rating changes from 90 to 54. Its effort stays `high`.
- **New default compressor.** The compressor is the model that turns a worker result into an episode. The default `router.compressor.models` list is now `[{"model":"claude-sonnet-5.5","effort":"medium"}]`.
- **Opus 5.5 guidance for design-triggering reviews.** A design-triggering focus area is a proved risk area that needs a high-level design, for example concurrency or security. The shipped guidance now recommends `claude-opus-5.5` as the reviewer for each proved design-triggering focus area. This guidance applies in adversarial design review and in implementation area review. It does not apply to Reviewer I, the general reviewer.
- **New Astra guidance.** The shipped guidance for `gpt-6-astra` now says to prefer Sol 6.1 over Astra. Astra is still not the default implementer. Astra no longer has its earlier review preferences.

The capability ratings and cost ratings are fixed project judgments. They are not benchmark measurements or prices. Model guidance directs model selection. Slate does not enforce it at runtime.

## Fixes

- The context budget documentation now describes pi 1.0.0 correctly. In pi 1.0.0, input from the remote procedure call (RPC) commands `steer` and `follow_up` passes through the pi input hook. Input that pi holds during compaction also passes through that hook. Slate therefore applies its paused-input rule to these inputs. This is a documentation correction, and Slate behavior does not change.

## Breaking changes

1. **The shipped logical model names `sol-6` and `claude-sonnet-5` are withdrawn.** Slate provides no alias for the old names. A configuration that still uses an old name gets an unknown-model error, and that error blocks dispatch. Action: In `slate.json`, replace `sol-6` with `sol-6.1` and `claude-sonnet-5` with `claude-sonnet-5.5`. Check `router.models.include`, `router.models.replace`, `router.models.exclude` and `router.compressor.models`. If a `replace` entry has a custom provider map, also check its physical model identifiers. Then start a new pi session.

## Compatibility

This release does not add, remove or rename any key in `slate.json`. The configuration shape of the router does not change.

Users who use only the shipped defaults need no configuration change. Confirm that your providers give access to `openai/gpt-6.1-sol` and `anthropic/claude-sonnet-5-5`.

A complete custom model in `router.models.add` can still use an old name. That entry creates a custom model. It does not restore the old shipped definition.

Slate still ignores `cacheKeyShards`, `writing.check`, `writing.remind` and `writing.remindPercent`. Remove them from your configuration. Use `writing.remindTurns` in place of `writing.remindPercent`.

Start a new pi session after you change `slate.json`.

## SDK compatibility

The pi software development kit (SDK) development pins change from pi 0.87.1 to pi 1.0.0. Slate 0.13.0 was developed and tested against pi 1.0.0 and TypeBox 1.3.27. The SDK packages are still peer dependencies with the range `*`. This release states no minimum pi version, because no test establishes one.
