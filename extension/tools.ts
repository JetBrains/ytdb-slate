/**
 * Slate orchestrator tools (ExecPlan D3): thread / threads / episode.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderThreadCall, renderThreadResult } from "./render.ts";
import type { SlateStore } from "./state.ts";
import type { DispatchProgress, ThreadManager } from "./threads.ts";

export function registerSlateTools(pi: ExtensionAPI, store: SlateStore, getManager: () => ThreadManager): void {
	pi.registerTool({
		name: "thread",
		label: "Thread",
		description: [
			"Dispatch ONE bounded action to a persistent worker thread; receive an episode",
			"(a compressed, structured record of its work).",
			"Omit `thread` and give a short `name` to create one; pass its id to continue with all prior-action context.",
			"Use `context` to inject episodes by id from any thread.",
			"Each thread is serial; use DIFFERENT threads in one message for parallel work.",
			"`model` (\"provider/id\") and `effort` (pi thinking level) route THIS ACTION ONLY on new or continued threads.",
			"With routing on, omission plans for the thread's base pair. With routing off, an omitted model",
			"plans for its pre-router pin; no pin gives no target. Omitted effort resolves no level. The session",
			"then returns to what it opened on. See docs/model-routing.md § Known cases where the model or level",
			"differs for what can run instead.",
			"`tools` applies only when creating a thread.",
			"Slate rejects a level the model does not offer and, when configured, a model outside the routable list.",
			"⚠ advisory notices before the episode report evidence gaps, cost cliffs, or window substitution.",
			"STATUS: FAILED means the action failed — read the episode and adapt.",
			"File-changing tasks require the track workflow's pre-implementation gates first.",
		].join(" "),
		promptSnippet: "Dispatch one bounded action to a persistent worker thread; returns a compressed episode",
		promptGuidelines: [
			"Use the thread tool to delegate bounded tactical actions to worker threads; dispatch independent actions to different threads in the same message to run them in parallel.",
			"Pass prior episode ids in the thread tool's context parameter instead of restating their content.",
		],
		parameters: Type.Object({
			thread: Type.Optional(Type.String({ description: "Existing thread id to continue (e.g. \"t1\")" })),
			name: Type.Optional(Type.String({ description: "Short name for a NEW thread (e.g. \"recon\")" })),
			task: Type.String({ description: "The single bounded action to execute" }),
			context: Type.Optional(
				Type.Array(Type.String(), { description: "Episode ids to inject as context (e.g. [\"t1.e2\"])" }),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Worker model \"provider/id\" for THIS action. Omit it to plan for the thread's base model with " +
						"routing on, or for its pre-router pin with routing off. With no pin the worker session returns to " +
						"the model it opened on. Cases M1, M3 and M7 in docs/model-routing.md § Known cases where the model " +
						"or level differs are when it does not.",
				}),
			),
			effort: Type.Optional(
				Type.String({
					description:
						"Thinking level for THIS action: off, minimal, low, medium, high, xhigh or max. " +
						"Slate refuses a level the routed model's known ladder lacks, outside case E2 in " +
						"docs/model-routing.md. Omit it to plan for the thread's default or a measured level with routing " +
						"on, or for the level the worker session opened on with routing off.",
				}),
			),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Worker tool allowlist (new threads only)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const onProgress = (p: DispatchProgress) => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `[${p.threadName}] ${p.done ? (p.status ?? "done") : "running"}\n${p.lines.slice(-8).join("\n")}`,
						},
					],
					details: { threadId: p.threadId, threadName: p.threadName, lines: p.lines, usage: p.usage, done: p.done },
				});
			};

			const result = await getManager().dispatch(
				{
					threadId: params.thread,
					name: params.name,
					task: params.task,
					contextEpisodeIds: params.context,
					model: params.model,
					effort: params.effort,
					tools: params.tools,
				},
				ctx,
				signal,
				onProgress,
			);

			// What the action RAN ON is reported ONCE, by the episode header itself
			// (episodes.ts's `ran:` field, two lines below this headline in the same result).
			// This headline used to repeat it, which was worse than redundant: the two were
			// built from different code, sanitized differently, and could disagree — and a
			// reader had no way to tell which one to believe. The episode header wins because
			// it is the DURABLE copy: it is written into the episode file, comes back through
			// the `episode` tool, and travels into every later prompt that cites the episode,
			// while this line is framing that exists only for this one tool result.
			const headline = `[episode ${result.episode.id} | thread ${result.thread.id} "${result.thread.name}" | STATUS: ${result.episode.status === "ok" ? "OK" : "FAILED"}]`;
			// Routing notices reach the ORCHESTRATOR, not just the TUI: an evidence gap,
			// a window substitution or a long-context billing cliff changes what the next
			// dispatch should ask for, so they ride in the tool result above the episode.
			const notices = result.warnings.length > 0 ? `${result.warnings.map((w) => `⚠ ${w}`).join("\n")}\n\n` : "";
			return {
				content: [{ type: "text", text: `${headline}\n\n${notices}${result.episodeText}` }],
				details: {
					threadId: result.thread.id,
					threadName: result.thread.name,
					episodeId: result.episode.id,
					status: result.episode.status,
					episodeFile: result.episode.file,
					// `ran*` and not `model`/`effort`: these are what the action ACTUALLY ran on,
					// post-clamp, post-substitution and post-failover — NOT the `model`/`effort`
					// arguments the call was made with, which a renderer shows on the call line and
					// which can differ from these. The names say which of the two a reader has.
					ranModel: result.episode.model,
					ranEffort: result.episode.effort,
					ranEffortUnmeasured: result.episode.effortUnmeasured,
					warnings: result.warnings,
					usage: result.usage,
					done: true,
				},
			};
		},

		renderCall(args, theme) {
			return renderThreadCall(args as never, theme as never);
		},
		renderResult(result, options, theme) {
			return renderThreadResult(result as never, options as never, theme as never);
		},
	});

	pi.registerTool({
		name: "threads",
		label: "Threads",
		description:
			"List worker threads, their status, episodes, activity, and models. " +
			"base=<model>@<effort>? is the nominal plan target when `model` is omitted. " +
			"The ? marks effort as provisional because Slate re-checks and may re-derive it. " +
			"last=<model>@<effort> records the last action. live=<model> (failover) shows a held fallback " +
			"that currently overrides the nominal base.",
		promptSnippet: "List worker threads and their episodes",
		parameters: Type.Object({}),
		async execute() {
			const threads = [...store.threads.values()];
			if (threads.length === 0) {
				return { content: [{ type: "text", text: "No threads yet. Use the thread tool to create one." }], details: { count: 0 } };
			}
			const lines = threads.map((t) => {
				const episodes = t.episodeIds.length > 0 ? t.episodeIds.join(", ") : "(none)";
				const marks: string[] = [];
				// The thread's NOMINAL model — the planner target for a dispatch that omits
				// `model` (?? t.model: an older thread carries only the pre-router pin).
				// Absent means the plan has no model: a NEW session then opens on the host
				// model and a reused one is reverted to the model it opened on. A separate
				// `live=` marker below overrides this display while failover holds the session.
				const base = t.baseModel ?? t.model;
				// CQ19: the MODEL half is authoritative as nominal planning state (an unroutable
				// base is re-seeded, so this is what an omitted `model` resolves to), but the
				// LEVEL half is only a STORED default: every dispatch re-checks it against the
				// model's current capability data and silently derives a fresh one if the table has moved
				// under it (BG23). Reporting it bare would present a value that may not survive
				// contact with the next action as fact — the `?` says so, and the tool description
				// says what it means. `last=` below carries no such caveat: that one is what ran.
				if (base) marks.push(`base=${base}${t.baseEffort ? `@${t.baseEffort}?` : ""}`);
				// The LAST ACTION's model — which may differ from the base on every axis:
				// an explicit per-action route, a window substitution, or a failover.
				const lastEpisodeId = t.episodeIds.at(-1);
				const lastEpisode = lastEpisodeId === undefined ? undefined : store.episodes.get(lastEpisodeId);
				if (lastEpisode?.model) {
					marks.push(
						`last=${lastEpisode.model}${lastEpisode.effort ? `@${lastEpisode.effort}` : ""}${
							lastEpisode.effortUnmeasured ? "(unmeasured)" : ""
						}`,
					);
				}
				// AF12: after a model failover the LIVE cached session runs a different model
				// than the thread's base. The marker disappears when the session is disposed, or
				// when a dispatch's own ROUTING moves that session — an explicit `model`, or the
				// thread's base with the router on — since the marker describes the model the
				// session is ACTUALLY on (CQ20, the same correction CQ14 made in threads.ts; the
				// one switch that never clears it is the revert, which stands down while the
				// marker is held). Failover is never persisted to the thread record.
				const live = getManager().liveFailoverModel(t.id);
				if (live) marks.push(`live=${live} (failover)`);
				const models = marks.length > 0 ? ` ${marks.join(" ")}` : "";
				return `${t.id} "${t.name}" [${t.status}]${models} — episodes: ${episodes} — updated ${new Date(t.updatedAt).toISOString()}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: { count: threads.length } };
		},
	});

	pi.registerTool({
		name: "episode",
		label: "Episode",
		description: "Fetch the full text of a stored episode by id (e.g. \"t1.e2\").",
		promptSnippet: "Fetch a stored episode's full text by id",
		parameters: Type.Object({
			id: Type.String({ description: "Episode id, e.g. \"t1.e2\"" }),
		}),
		async execute(_toolCallId, params) {
			const episode = store.episodes.get(params.id);
			if (!episode) {
				const known = [...store.episodes.keys()].join(", ") || "none";
				throw new Error(`Unknown episode "${params.id}". Known episodes: ${known}`);
			}
			return {
				content: [{ type: "text", text: readFileSync(episode.file, "utf8") }],
				details: { id: episode.id, threadId: episode.threadId, status: episode.status },
			};
		},
	});
}
