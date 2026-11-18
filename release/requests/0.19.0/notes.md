# ytdb-slate 0.19.0

Slate now recommends Sol 6.2 for most worker tasks. This release also changes which provider receives completed worker output for summarization.

## Highlights

- Slate recommends Astra 6.2 for reviews that require a high-level design. It recommends Fable 5.2 to diagnose repeated implementation failures before another repair attempt.
- Slate now ships update notes in `CHANGELOG.md`. After an update, pi shows the notes in the next new interactive session.

## Fixes

- Slate now gives OpenAI GPT-6 and later models a larger context window when they summarize long worker results. This preserves room for up to 4,096 output tokens without changing the model settings for worker or main sessions.

## Breaking changes

1. **Pi 1.5.2 is the minimum supported version.** Action: Upgrade pi before updating Slate if you use an older version. Older versions can load Slate without a warning.
2. **The default worker models are now `luna-6`, `sol-6.2`, `astra-6.2`, and `fable-5-2`.** Action: Check that pi lists `openai/gpt-6.2-sol` and `openai/gpt-6.2-astra` before selecting them. Pi 1.5.2 can discover both GPT-6.2 models from its online model list. If they do not appear in `pi --list-models gpt-6.2`, run `pi update --models` and check again. Using the models requires OpenAI access. To keep using an older model, set `router.models.include` to the **complete** list of models you want. A `replace` entry alone does not enable a model.
3. **Slate now sends completed worker output to OpenAI by default.** It uses Sol 6.2 at `low` effort instead of Anthropic Sonnet 5.5 at `medium`. Action: Check that OpenAI is an approved provider for your worker output and that pi has access to Sol 6.2. To keep using Sonnet, set `router.compressor.models` to `[{"model":"claude-sonnet-5.5","effort":"medium"}]`. If the configured model is unavailable, Slate returns a size-limited result without a summary and reports the failure.

## Compatibility

No configuration keys changed. If your main session uses a model outside the configured list, recovery asks you to choose a model. Transfer to a new session pauses until a configured model is available.

Slate also revised its built-in capability and cost ratings. If you assign ratings to custom models, check how they compare with the new values.

## SDK compatibility

Slate was tested with the pi software development kit (SDK) at version 1.5.2.
