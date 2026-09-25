/**
 * Slate orchestrator tools (ExecPlan D3): thread / threads / episode.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderThreadCall, renderThreadResult } from "./render.ts";
import { sanitizeForNotify } from "./notify.ts";
import {
	displayThreadType,
	isModelSpec,
	isThinkingLevel,
	parseThreadType,
	resolveEpisodeFile,
	renderThreadId,
	sanitizeDispatchReason,
	threadTypeMarker,
	THREAD_TYPE_GLOSSES,
	THREAD_TYPES,
	type EpisodeRecord,
	type EpisodeUsage,
	type SlateStore,
} from "./state.ts";
import { MAX_CONTEXT_EPISODES, type DispatchProgress, type ThreadManager } from "./threads.ts";
import { JUDGEMENT_THREAD_TYPES } from "./worker.ts";
import { REVIEW_PERSPECTIVES } from "./review-perspectives.ts";

const threadTypeGlosses = THREAD_TYPES.map((type) => `${type} ${THREAD_TYPE_GLOSSES[type]}`).join(", ");
const judgementThreadTypes = JUDGEMENT_THREAD_TYPES.join(" and ");

const THREAD_TYPE_PARAMETER_DESCRIPTION =
	`Required. Pick by main job: ${threadTypeGlosses}. ` +
	`Slate adds its reviewer evidence charter to ${judgementThreadTypes} threads.`;

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Render recorded costs and usage without turning an unreported quantity into zero. */
function dispatchCostLine(episode: EpisodeRecord): string {
	const usageSources: EpisodeUsage[] = [episode, episode.compressorUsage ?? {}, episode.compactionUsage ?? {}];
	const quantities = USAGE_FIELDS.map((field) => {
		let quantity = 0;
		let complete = true;
		for (const source of usageSources) {
			const value = source[field];
			if (value === undefined) complete = false;
			else quantity += value;
		}
		const label = field === "cacheRead" ? "cache read" : field === "cacheWrite" ? "cache write" : field;
		return `${label} ${complete ? "" : "≥"}${quantity.toLocaleString("en-US")}`;
	});
	const sourceCosts = [episode.workerCostUsd, episode.compressorCostUsd, episode.compactionCostUsd];
	const reportedCost = sourceCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
	const partialCost = sourceCosts.some((cost) => cost === undefined);
	const costScope = partialCost ? " across reported calls and models. Some cost was not reported" : " across all calls and models";
	const model = episode.model ?? "unknown model";
	const effort = episode.effort ? `@${episode.effort}` : "@unknown effort";
	const warm = episode.cacheRead !== undefined && episode.cacheRead > 0 ? " | warm" : "";
	return `Cost: ${partialCost ? "≥" : ""}$${reportedCost.toFixed(4)}${costScope} | tokens: ${quantities.join(", ")} | ended ${model} ${effort}${warm}`;
}

export function registerSlateTools(pi: ExtensionAPI, store: SlateStore, getManager: () => ThreadManager): void {
	pi.registerTool({
		name: "thread",
		label: "Thread",
		description: [
			"Dispatch one bounded action in a new worker thread and receive an episode",
			"(a compressed, structured record of its work).",
			"Every call creates a new thread. Use a short `name` to describe the action.",
			"See the `type` parameter for the thread-type choices and their meanings.",
			"Every new thread requires a type.",
			"Use `context` to inject episodes by id from any thread.",
			"Independent calls can run in parallel within the global concurrency limit.",
			"Every call must name a logical `model` and a short `reason` for that selection.",
			"The active logical policy fixes effort and the permitted physical routes for this action.",
			"`tools` sets the new thread's worker tool allowlist.",
			"Slate validates each permitted physical route, its credentials, and the fixed effort before execution.",
			"A failed action produces one failed episode. Slate compresses any worker response and uses a fixed episode when no response exists.",
			"File-changing tasks require the track workflow's pre-implementation gates first.",
		].join(" "),
		promptSnippet: "Dispatch one bounded action to a new worker thread and return a compressed episode",
		promptGuidelines: [
			"Use the thread tool to delegate bounded tactical actions to worker threads; dispatch independent actions to different threads in the same message to run them in parallel.",
			"Pass prior episode ids in the thread tool's context parameter instead of restating their content.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Short name for a NEW thread (e.g. \"recon\")" })),
			trackNumber: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Required for an implementer on an open change. The exact report track number." })),
			type: Type.Union(THREAD_TYPES.map((value) => Type.Literal(value)), {
				description: THREAD_TYPE_PARAMETER_DESCRIPTION,
			}),
			task: Type.String({ description: "The single bounded action to execute" }),
			context: Type.Optional(
				Type.Array(Type.String(), { description: "Earlier episode ids to load in caller order", maxItems: MAX_CONTEXT_EPISODES }),
			),
			model: Type.String({
				description: "Required logical model name from the active Slate policy.",
			}),
			reason: Type.String({
				description: "Required short reason for this logical model choice.",
				maxLength: 200,
			}),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Worker tool allowlist (new threads only)" })),
			reviewPerspectives: Type.Optional(Type.Array(
				Type.String({ description: `Names: ${REVIEW_PERSPECTIVES.map((role) => role.name).join(", ")}` }),
				{ description: "Built-in implementation review only, type reviewer. Reviewer I and Test-quality and structure reviewer each run alone. Other specialists may merge only with matching scope and evidence." },
			)),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const raw = params as unknown as Record<string, unknown>;
			if (Object.prototype.hasOwnProperty.call(raw, "thread")) {
				throw new Error('The "thread" field was removed. Create a new thread and pass earlier episode ids through "context".');
			}
			if (Object.prototype.hasOwnProperty.call(raw, "freshContext")) {
				throw new Error('The "freshContext" field was removed. Pass earlier episode ids through "context".');
			}
			if (Object.prototype.hasOwnProperty.call(raw, "effort")) {
				throw new Error('The "effort" field was removed. Select a logical model. Its policy fixes the effort.');
			}
			const type = parseThreadType(params.type, true);
			if (type === "implementer" && store.currentChange &&
				(!Number.isSafeInteger(params.trackNumber) || (params.trackNumber ?? 0) < 1)) {
				throw new Error("An implementer on an open change requires a positive safe trackNumber for its report.");
			}
			const displayedType = (threadId: string) => displayThreadType(store.threads.get(threadId)?.type ?? type);
			const onProgress = (p: DispatchProgress) => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `[${p.threadName}] ${p.done ? (p.status ?? "done") : "running"}\n${p.lines.slice(-8).join("\n")}`,
						},
					],
					details: {
						threadId: p.threadId,
						threadName: p.threadName,
						type: displayedType(p.threadId),
						lines: p.lines,
						usage: p.usage,
						done: p.done,
					},
				});
			};

			const reportTask = params.type === "implementer" && store.currentChange
				? `${params.task}\n\nImplementer report: slate-changes/${store.currentChange}/track-${params.trackNumber}-implementer-report.md. Create without following a symbolic link.` +
					(store.sourceChange
						? ` If the source folder has this track's report, continue it in this new report and name slate-changes/${store.sourceChange}/track-${params.trackNumber}-implementer-report.md as read-only in the new report's first entry. Do not edit the source report.`
						: "")
				: params.task;
			const result = await getManager().dispatch(
				{
					name: params.name,
					type,
					task: reportTask,
					contextEpisodeIds: params.context,
					model: params.model,
					reason: params.reason,
					tools: params.tools,
					reviewPerspectives: raw.reviewPerspectives,
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
			const threadId = renderThreadId(result.thread.id) ?? "(unknown)";
			const resultStatus = result.episode.status === "failed" ? "FAILED" : "OK";
			const headline = `[episode ${result.episode.id} | thread ${threadId} "${result.thread.name}" | STATUS: ${resultStatus}]`;
			// Routing notices reach the orchestrator in the tool result.
			const notices = result.warnings.length > 0 ? `${result.warnings.map((w) => `⚠ ${w}`).join("\n")}\n\n` : "";
			const cost = dispatchCostLine(result.episode);
			return {
				content: [{ type: "text", text: `${headline}\n${cost}\n\n${notices}${result.episodeText}` }],
				details: {
					threadId: result.thread.id,
					threadName: result.thread.name,
					type: displayThreadType(result.thread.type),
					episodeId: result.episode.id,
					status: result.episode.status,
					episodeFile: result.episode.file,
					// `ran*` keeps the established renderer detail names. The values are the
					// latest post-clamp physical pair accepted for local Pi handoff, not remote
					// execution proof and not the logical model argument shown on the call line.
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
			return renderThreadCall({ ...args, type: displayThreadType(args.type) } as never, theme as never);
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
			"type=<type> marks a non-general thread. " +
			"logical=<name> and reason= show the action selection. " +
			"requested=<physical-model>@<effort> and last=<physical-model>@<effort> preserve execution facts.",
		promptSnippet: "List worker threads and their episodes",
		parameters: Type.Object({}),
		async execute() {
			const threads = [...store.threads.values()];
			if (threads.length === 0) {
				return { content: [{ type: "text", text: "No threads yet. Use the thread tool to create one." }], details: { count: 0 } };
			}
			const lines = threads.map((t) => {
				const episode = t.episodeId ?? "(none)";
				const typeMarker = threadTypeMarker(displayThreadType(t.type));
				const marks: string[] = [];
				// The action's model may differ from the base after an explicit route or failover.
				const lastEpisode = t.episodeId === undefined ? undefined : store.episodes.get(t.episodeId);
				const logicalModel = typeof lastEpisode?.logicalModel === "string" ? lastEpisode.logicalModel : undefined;
				if (logicalModel) marks.push(`logical=${sanitizeForNotify(logicalModel, 80)}`);
				const requestedModel = isModelSpec(lastEpisode?.requestedModel) ? lastEpisode.requestedModel : undefined;
				const requestedEffort = isThinkingLevel(lastEpisode?.requestedEffort) ? lastEpisode.requestedEffort : undefined;
				if (requestedModel) {
					marks.push(`requested=${sanitizeForNotify(requestedModel, 80)}${requestedEffort ? `@${requestedEffort}` : ""}`);
				}
				const requestReason = sanitizeDispatchReason(lastEpisode?.reason);
				if (requestReason) marks.push(`reason=${JSON.stringify(requestReason)}`);
				if (lastEpisode?.model) {
					const differs = requestedModel !== undefined && requestedModel !== lastEpisode.model ? " (different from requested)" : "";
					marks.push(
						`last=${sanitizeForNotify(lastEpisode.model, 80)}${lastEpisode.effort ? `@${lastEpisode.effort}` : ""}${
							lastEpisode.effortUnmeasured ? "(unmeasured)" : ""
						}${differs}`,
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
				return `${renderThreadId(t.id)} "${t.name}" [${t.status}]${typeMarker}${models} — episode: ${episode} — updated ${new Date(t.updatedAt).toISOString()}`;
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const episode = store.episodes.get(params.id);
			if (!episode) {
				const known = [...store.episodes.keys()].join(", ") || "none";
				throw new Error(`Unknown episode "${params.id}". Known episodes: ${known}`);
			}
			const file = resolveEpisodeFile(ctx.cwd, episode.file);
			if (file === undefined) throw new Error(`Episode "${params.id}" is no longer a safe readable slate episode file.`);
			return {
				content: [{ type: "text", text: readFileSync(file, "utf8") }],
				details: { id: episode.id, threadId: episode.threadId, status: episode.status },
			};
		},
	});
}
