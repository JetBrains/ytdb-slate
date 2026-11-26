# Changelog

Approved update notes for Slate releases appear here.

## [0.22.0]

You can now save a private model and thinking level for each project. Run `/slate model save` in the main session. Slate applies the saved choice when a new interactive session starts. `/slate model` shows the choice, and `/slate model clear` removes it. Use pi 1.6.0 or later.

https://github.com/JetBrains/ytdb-slate/releases/tag/v0.22.0

## [0.21.0]

The `threads` tool now lists the worker threads of the current session by default. The new `parentSession` parameter lists the threads of the newest earlier session. After a Slate handoff, `pi --continue` now opens the new session instead of the earlier session. Use pi 1.6.0 or later.

https://github.com/JetBrains/ytdb-slate/releases/tag/v0.21.0

## [0.20.0]

Slate now uses a default `contextBudget` of 400,000 tokens for every provider. Sessions with a provider other than Anthropic can run longer before a handoff to a new session. The `threads` tool now returns short pages and uses less context. Native notifications on Windows now find Windows PowerShell under a different Start menu name. Use pi 1.6.0 or later.

https://github.com/JetBrains/ytdb-slate/releases/tag/v0.20.0

## [0.19.0]

Slate now recommends Sol 6.2 for most worker tasks, Astra 6.2 for design reviews, and Fable 5.2 to diagnose repeated implementation failures. Use pi 1.5.2 or later. Check your model list before updating. Slate now sends worker output to OpenAI for summaries by default. You can keep Anthropic Sonnet 5.5 in `router.compressor.models`.

https://github.com/JetBrains/ytdb-slate/releases/tag/v0.19.0
