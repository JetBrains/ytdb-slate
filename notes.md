# ytdb-slate 0.22.0

This release adds a private model choice for each project. It also extends the shipped guidance for the `luna-6` logical model.

## Highlights

- You can now save a private model for a project. Run `/slate model save` to save the current model and thinking level of the main session. The main session is the session that you start and type into. The thinking level is the pi setting for the amount of reasoning of the model. Slate stores the choice in `slate-preferences.json` in the pi agent directory, outside the repository. Other developers of the project do not receive your choice.
- Slate applies the saved choice when an interactive main session starts with no conversation messages. This rule covers a new launch and `/new`. The rule applies with orchestrator mode on or off. In orchestrator mode, the main session plans the work and worker threads perform it.
- `/slate model` shows the saved choice and the project key. The project key identifies the project in `slate-preferences.json`. `/slate model clear` removes the choice.
- An explicit `--model` option has priority over the saved model and the saved thinking level. With `--thinking` alone, Slate uses that thinking level with the saved model.
- Slate does not apply the choice in a worker thread or in the session that follows a handoff. A handoff transfers the work to a new session. Slate also does not apply the choice in a session opened with `/resume`, `/fork` or `--fork`, or on `/reload`. The same holds for print mode, JSON mode and remote procedure call (RPC) mode.
- The shipped guidance for the logical model `luna-6` has three more cautions. A logical model is a model name in Slate routing, and `luna-6` serves auxiliary tasks. The cautions cover long file paths, text that must stay exact, and check commands that write to a record file. The model list, the ratings and the routing rules did not change.

## Compatibility

No configuration keys or defaults in `slate.json` changed. Existing users need no action. Without a saved choice, Slate keeps the model that pi selected and shows no notice.

The project key is the real path of the Git common directory. Worktrees of one clone share one choice. Separate clones do not share a choice. If you move a clone, save the choice again.

Slate now treats any `/slate` input whose first word starts with `model` as a model command. For an invalid form, Slate shows the valid forms and leaves orchestrator mode unchanged.

## SDK compatibility

Slate was tested with the pi software development kit (SDK) at version 1.6.0. Pi 1.6.0 remains the minimum supported version.

