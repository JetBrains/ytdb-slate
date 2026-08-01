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
			"Dispatch ONE bounded action to a persistent worker thread and receive back an episode",
			"(a compressed, structured record of what the thread did).",
			"Omit `thread` to create a new thread (give it a short `name`); pass an existing thread id",
			"to continue that thread — it retains the context of all its previous actions.",
			"Use `context` to inject prior episodes (by id, from any thread) into the action.",
			"Threads are serial; to parallelize, dispatch to DIFFERENT threads in one message.",
			"`model` (\"provider/id\") and `effort` (pi thinking level) route THIS ACTION ONLY — new thread",
			"or continuation alike; the next action reverts to the thread's defaults, which is also what",
			"an omitted argument runs on.",
			"`tools` applies only when creating a new thread.",
			"Guarded: an unroutable model, or a level that model lacks, is a tool error naming what is",
			"allowed; advisory notices (evidence gaps, cost cliffs, window substitution) are prefixed to",
			"the episode as ⚠ lines.",
			"An episode header of STATUS: FAILED means the action failed — read it and adapt.",
			"Tasks that modify repository files require the track workflow's pre-implementation gates to have run first.",
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
				Type.String({ description: "Worker model \"provider/id\" for THIS action; omit to use the thread's base model" }),
			),
			effort: Type.Optional(
				Type.String({
					description:
						"Thinking level for THIS action: off, minimal, low, medium, high, xhigh or max " +
						"(only levels the target model offers); omit for the thread's default, or a level " +
						"derived for the model that runs",
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
			"List all worker threads: id, name, status, episodes so far, last activity, and models — " +
			"base=<the thread's default model>@<effort>? (what a dispatch that omits `model` runs on; " +
			"the trailing ? marks the LEVEL as provisional — it is the stored default, re-checked against " +
			"the model's current capability data on every dispatch and silently re-derived if it no longer " +
			"holds) and last=<the model its last action actually ran on>@<effort>, which is fact. " +
			"Use this to decide whether to continue an existing thread or create a new one.",
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
				// The thread's DEFAULT model — what a dispatch that omits `model` runs on
				// (?? t.model: a thread created before per-action routing existed carries
				// only the pre-router pin). Absent for a thread whose base could not be
				// resolved: it then runs on the host's current model, as it always did.
				const base = t.baseModel ?? t.model;
				// CQ19: the MODEL half is authoritative (an unroutable base is re-seeded, so this
				// is what a dispatch that omits `model` will use), but the LEVEL half is only a
				// STORED default: every dispatch re-checks it against the model's current
				// capability data and silently derives a fresh one if the profile table has moved
				// under it (BG23). Reporting it bare would present a value that may not survive
				// contact with the next action as fact — the `?` says so, and the tool description
				// says what it means. `last=` below carries no such caveat: that one is what ran.
				if (base) marks.push(`base=${base}${t.baseEffort ? `@${t.baseEffort}?` : ""}`);
				// The LAST ACTION's model — which may differ from the base on every axis:
				// an explicit per-action route, a window substitution, or a failover.
				const lastEpisode = t.episodeIds.length > 0 ? store.episodes.get(t.episodeIds[t.episodeIds.length - 1]) : undefined;
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
