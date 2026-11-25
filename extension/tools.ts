/**
 * Slate orchestrator tools (ExecPlan D3): thread / threads / episode.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { renderCompactCall, renderCompactResult, renderThreadCall, renderThreadResult, type DisplayDetails } from "./render.ts";
import {
	displayThreadType,
	isModelSpec,
	isThinkingLevel,
	parseThreadType,
	resolveEpisodeFile,
	renderThreadId,
	sanitizeDispatchReason,
	THREAD_TYPE_GLOSSES,
	THREAD_TYPES,
	type EpisodeRecord,
	type EpisodeUsage,
	type SlateStore,
	type ThreadRecord,
} from "./state.ts";
import { MAX_CONTEXT_EPISODES, type DispatchProgress, type ThreadManager } from "./threads.ts";
import { JUDGEMENT_THREAD_TYPES } from "./worker.ts";
import { REVIEW_PERSPECTIVES } from "./review-perspectives.ts";
import { CHANGE_RECORDS_DOC, SAFE_RECORD_WRITE_DOC } from "./paths.ts";
import { implementerReportName, trackIdentifier, TRACK_IDENTIFIER_MAX, TRACK_IDENTIFIER_PATTERN } from "./record-names.ts";

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

const THREAD_PAGE_ROWS = 20;
const MAX_THREAD_CURSOR = "t9007199254740992";

function compareThreadIds(a: string, b: string): number {
	// Canonical decimal IDs sort by digit count and then by digit value.
	return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function validateThreadCursor(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length > MAX_THREAD_CURSOR.length
		|| !/^t[1-9][0-9]*$/u.test(value) || compareThreadIds(value, MAX_THREAD_CURSOR) > 0) {
		throw new Error('Invalid before value. Use a thread ID such as "t9". Omit both before and parentSession to list the current session.');
	}
}

function inspectThreadArguments(args: unknown) {
	try {
		if (typeof args === "object" && args !== null && !Array.isArray(args)) {
			const before = Object.getOwnPropertyDescriptor(args, "before");
			const detail = Object.getOwnPropertyDescriptor(args, "detail");
			const parentSession = Object.getOwnPropertyDescriptor(args, "parentSession");
			if ([before, detail, parentSession].every((entry) => !entry || Object.hasOwn(entry, "value"))) {
				return { before, detail, parentSession };
			}
		}
	} catch {
		// Proxy inspection can throw. Do not return the proxy's error text.
	}
	throw new Error("Invalid threads arguments. Use an object such as {}.");
}

function threadLabel(value: string, limit: number, quoted = false): string {
	let text = "";
	let bytes = 0;
	let scanned = 0;
	for (const point of value) {
		// Bound the work even when the label contains only characters we omit.
		if (++scanned > limit * 4) return text + "…";
		if (/[\p{Cc}\p{Bidi_Control}]/u.test(point)) continue;
		const char = point.replace(/[\p{Zl}\p{Zp}]/u, " ").replace(/\p{Cs}/u, "�");
		const escaped = quoted && (char === '"' || char === "\\") ? "\\" + char : char;
		bytes += Buffer.byteLength(escaped, "utf8");
		if (bytes > limit - 3) return text + "…";
		text += escaped;
	}
	return text;
}

const ROUTING_LABEL_ESCAPE = /[\s\p{White_Space}\p{Cc}\p{Bidi_Control}\p{Cs}"\\]/u;

function routingLabel(value: string, limit: number): string {
	if (!ROUTING_LABEL_ESCAPE.test(value)) return threadLabel(value, limit);

	let text = "";
	let bytes = 0;
	for (const point of value) {
		const encoded = JSON.stringify(point).slice(1, -1);
		const escaped = encoded === point && point !== " " && ROUTING_LABEL_ESCAPE.test(point)
			? "\\u" + point.charCodeAt(0).toString(16).padStart(4, "0")
			: encoded;
		bytes += Buffer.byteLength(escaped, "utf8");
		if (bytes > limit - 3) return `"${text}…"`;
		text += escaped;
	}
	return `"${text}"`;
}

function threadPageRow(thread: ThreadRecord, store: SlateStore, getManager: () => ThreadManager, detail: boolean): string {
	const row = `${thread.id} "${threadLabel(thread.name, 200, true)}" [${thread.status}] type=${displayThreadType(thread.type)}`;
	const episode = ` — episode: ${thread.episodeId ?? "(none)"}`;
	if (!detail) return row + episode;

	const last = thread.episodeId === undefined ? undefined : store.episodes.get(thread.episodeId);
	const marks: string[] = [];
	if (last?.logicalModel) marks.push(`logical=${routingLabel(last.logicalModel, 80)}`);
	const requestedModel = isModelSpec(last?.requestedModel) ? last.requestedModel : undefined;
	if (requestedModel) {
		const effort = isThinkingLevel(last?.requestedEffort) ? `@${last.requestedEffort}` : "";
		marks.push(`requested=${routingLabel(requestedModel, 120)}${effort}`);
	}
	const reason = sanitizeDispatchReason(last?.reason);
	if (reason) marks.push(`reason=${JSON.stringify(reason)}`);
	if (last?.model) {
		const effort = last.effort ? `@${routingLabel(last.effort, 48)}` : "";
		const unmeasured = last.effortUnmeasured ? "(unmeasured)" : "";
		const differs = requestedModel !== undefined && requestedModel !== last.model ? " (different from requested)" : "";
		marks.push(`last=${routingLabel(last.model, 120)}${effort}${unmeasured}${differs}`);
	}
	const live = getManager().liveFailoverModel(thread.id);
	if (live) marks.push(`live=${routingLabel(live, 120)} (failover)`);
	const date = new Date(thread.updatedAt);
	const updated = Number.isNaN(date.getTime()) ? "unavailable" : date.toISOString();
	const models = marks.length > 0 ? ` ${marks.join(" ")}` : "";
	return `${row}${models}${episode} — updated ${updated}`;
}

function validateThreadMode(hasBefore: boolean, parentSession: boolean | undefined): void {
	if (hasBefore && parentSession === true) {
		throw new Error("Use either before or parentSession: true, not both.");
	}
}

function listThreads(
	store: SlateStore,
	getManager: () => ThreadManager,
	ctx: ExtensionToolContext,
	{ before, detail, parentSession }: { before?: string; detail?: boolean; parentSession?: boolean },
) {
	const count = store.threads.size;
	if (count === 0) {
		return { text: "No threads yet. Use the thread tool to create one.", details: { count, failedCount: 0 } };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const totals = { queued: 0, running: 0, successful: 0, failed: 0, cancelled: 0 };
	const all = [...store.threads.values()].sort((a, b) => compareThreadIds(b.id, a.id));
	const current = all.filter((thread) => thread.sessionId === sessionId);
	for (const thread of all) totals[thread.status]++;

	let rows = current;
	let mode = "current session";
	let limit = rows.length;
	if (before !== undefined) {
		rows = all.filter((thread) => compareThreadIds(thread.id, before) < 0);
		limit = THREAD_PAGE_ROWS;
	} else if (parentSession === true) {
		const parent = all.find((thread) => thread.sessionId !== sessionId);
		rows = parent ? all.filter((thread) => thread.sessionId === parent.sessionId) : [];
		mode = "parent session";
		limit = parent?.sessionId === undefined ? THREAD_PAGE_ROWS : rows.length;
	}

	const summary = `Threads: ${count}. Queued: ${totals.queued}. Running: ${totals.running}. Successful: ${totals.successful}. Failed: ${totals.failed}. Cancelled: ${totals.cancelled}. Current session: ${current.length}.`;
	const page = rows.slice(0, limit);
	const listing = before === undefined
		? `${mode}, ${page.length} ${page.length === 1 ? "thread" : "threads"}`
		: `all sessions, threads older than ${before}${page.length === 0 ? ", 0 threads" : ""}`;
	const lines = [summary, `Listing: ${listing}.`];
	for (const thread of page) lines.push(threadPageRow(thread, store, getManager, detail === true));
	if (before !== undefined && page.length === 0) lines.push("No older threads.");
	if (page.length < rows.length) {
		const last = page.at(-1)!;
		const remaining = all.length - all.indexOf(last) - 1;
		const nextArgs = JSON.stringify({ before: last.id, detail });
		lines.push(`Remaining threads: ${remaining}. Next call: threads(${nextArgs})`);
	}
	return { text: lines.join("\n"), details: { count, failedCount: totals.failed } };
}

export function registerSlateTools(pi: ExtensionAPI, store: SlateStore, getManager: () => ThreadManager): void {
	const parameters = Type.Object({
		name: Type.Optional(Type.String({ description: "Short name for a NEW thread (e.g. \"recon\")" })),
		trackNumber: Type.Optional(Type.Union([
			Type.String({ pattern: TRACK_IDENTIFIER_PATTERN, maxLength: TRACK_IDENTIFIER_MAX }),
			Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		], { description: "Required for an implementer on an open change. A positive safe integer or canonical dotted path number. At most 128 ASCII characters. Each component is 1 through 9007199254740991, without leading zeros." })),
		type: Type.Union(THREAD_TYPES.map((value) => Type.Literal(value)), {
			description: THREAD_TYPE_PARAMETER_DESCRIPTION,
		}),
		task: Type.String({ description: "The single bounded action to execute" }),
		context: Type.Optional(
			Type.Array(Type.String(), { description: "Earlier episode ids to load in caller order", maxItems: MAX_CONTEXT_EPISODES }),
		),
		model: Type.String({ description: "Required logical model name from the active Slate policy." }),
		reason: Type.String({ description: "Required short reason for this logical model choice.", maxLength: 200 }),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Worker tool allowlist (new threads only)" })),
		reviewPerspectives: Type.Optional(Type.Array(
			Type.String({ description: `Names: ${REVIEW_PERSPECTIVES.map((role) => role.name).join(", ")}` }),
			{ description: "Built-in implementation review only, type reviewer. Reviewer I and Test-quality and structure reviewer each run alone. Other specialists may merge only with matching scope and evidence." },
		)),
	});
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
		parameters,
		prepareArguments(args) {
			// Pi calls this before optional-null normalization and Value.Convert.
			if (args && typeof args === "object") {
				const original = args as Record<string, unknown>;
				if (Object.prototype.hasOwnProperty.call(original, "trackNumber")) trackIdentifier(original.trackNumber);
			}
			return args as Static<typeof parameters>;
		},

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
			if (Object.prototype.hasOwnProperty.call(raw, "trackNumber")) trackIdentifier(raw.trackNumber);
			const type = parseThreadType(params.type, true);
			if (type === "implementer" && store.currentChange && params.trackNumber === undefined) {
				throw new Error("An implementer on an open change requires trackNumber for its report.");
			}
			const displayedType = (threadId: string) => displayThreadType(store.threads.get(threadId)?.type ?? type);
			// Presentation fields are internal display metadata, not a supported consumer contract.
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
						status: p.status,
						displayActivity: p.displayActivity,
						displayFailure: p.displayFailure,
						displayWarning: p.displayWarning,
						displayFailureReason: p.displayFailureReason,
						displayWarningSummary: p.displayWarningSummary,
					} satisfies DisplayDetails,
				});
			};

			// Validate the final identifier at report-name construction.
			const reportName = type === "implementer" && store.currentChange
				? implementerReportName(params.trackNumber) : undefined;
			const reportTask = reportName !== undefined
				? `${params.task}\n\nImplementer report: slate-changes/${store.currentChange}/${reportName}. ` +
					"Start reports with `>>`. Later appends use only `>>`. " +
					"Never use `>`, write, edit or `sed -i` on an existing report. " +
					"Under `slate-changes/`, write only this report, assigned implementation maps and action scratch. " +
					"Before each action’s first report write, copy the report to a temporary file. " +
					"For a new report, use an empty copy. " +
					"Write each new text to its own temporary file. " +
					"Create reports with the first `>>` append. " +
					"Append each temporary file with `>>`. " +
					"After its last write, the implementer checks the whole report once with `cat` and `cmp`. " +
					"The report must equal the start copy followed by every appended temporary file in order. " +
					"Report the path, comparison and result in the final response. " +
					"Report a failed or unclear append or check and stop. Never retry that append. " +
					"Map duties apply in new or migrated changes. " +
					`For assigned maps, read <${CHANGE_RECORDS_DOC}> § Manual records and safe writes before writing. ` +
					"Maps explain committed source at implementation end. " +
					"For each delivered source commit, fixers update affected statements and the named commit, even if no statement changes. " +
					`Create assigned new maps only with the installed safe-record-write command. Read <${SAFE_RECORD_WRITE_DOC}>: introduction and § Record preparation and recovery execution for edits, preservation and present-record repair, all for command creation (also absent-record restoration). Hash logging and successor checks: record-only. ` +
					"Keep interrupted edits as edits even when their destinations vanish. " +
					"Pause map writes unless the task names the destination, creation or edit, write and check methods, read-only sources and, for edits, the eligible stored-bytes hash and verified preserved-copy path." +
					" Tasks name checked map-attempt entries. Record-only: match stored bytes to the writer's same-attempt report before logging." +
					(store.sourceChange
						? ` If the source folder has this track's report, continue it in this new report and name slate-changes/${store.sourceChange}/${reportName} as read-only in the new report's first entry. Do not edit the source report. If an assigned map exists only in the source folder, pause map writing until a record-only worker creates its successor copy. Do not create a replacement map from scratch. Never write in the read-only source folder \`slate-changes/${store.sourceChange}/\`.`
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
					...result.display,
					warnings: result.warnings,
					usage: result.usage,
					done: true,
				} satisfies DisplayDetails,
			};
		},

		renderCall(args, theme, context) {
			return renderThreadCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderThreadResult(result, { ...options, threadDevMode: getManager().getConfig().threadDevMode === true }, theme, context);
		},
	});

	const threadsParameters = Type.Object({
		before: Type.Optional(Type.String({ description: "List up to 20 threads from all sessions that are older than this thread ID." })),
		parentSession: Type.Optional(Type.Union([Type.Literal(true), Type.Literal(false)], {
			description: "List threads from the newest earlier session with threads. Do not combine true with before.",
		})),
		detail: Type.Optional(Type.Union([Type.Literal(true), Type.Literal(false)], {
			description: "Show model choices, effort, the reason for the choice, and update times.",
		})),
	});
	const prepareThreadsArguments = (args: unknown): Static<typeof threadsParameters> => {
		const { before, detail, parentSession } = inspectThreadArguments(args);
		const prepared: Static<typeof threadsParameters> = {};
		if (parentSession) {
			const value: unknown = parentSession.value;
			if (typeof value !== "boolean") {
				throw new Error("Invalid parentSession value. Use true or false.");
			}
			prepared.parentSession = value;
		}
		validateThreadMode(before !== undefined, prepared.parentSession);
		if (before) {
			const value: unknown = before.value;
			validateThreadCursor(value);
			prepared.before = value;
		}
		if (detail) {
			const value: unknown = detail.value;
			if (typeof value !== "boolean") {
				throw new Error("Invalid detail value. Use true or false.");
			}
			prepared.detail = value;
		}
		return prepared;
	};
	pi.registerTool({
		name: "threads",
		label: "Threads",
		renderCall: (args, theme, context) => renderCompactCall("threads", args, theme, context),
		renderResult: (result, options, theme, context) => renderCompactResult("threads", result, options, theme, context),
		description:
			"List worker threads and their episode IDs, newest thread first. " +
			"By default, list the current session. " +
			"Set parentSession to true to list the newest earlier session with threads. Slate skips sessions without threads. " +
			"Slate groups threads without a saved session ID together and lists up to 20 when that group is the parent. " +
			"Set before to a thread ID to list up to 20 older threads from all sessions. " +
			"Use only one of before or parentSession: true. Follow the next call to list older threads. " +
			"Lists and totals use only the thread records available in this session. The totals include the current session count. " +
			"Set detail to true to see model choices, effort, the reason for the choice, and update times.",
		promptSnippet: "List worker threads and their episodes",
		parameters: threadsParameters,
		prepareArguments: prepareThreadsArguments,
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const { text, details } = listThreads(store, getManager, ctx, prepareThreadsArguments(args));
			return { content: [{ type: "text", text }], details };
		},
	});

	pi.registerTool({
		name: "episode",
		label: "Episode",
		renderCall: (args, theme, context) => renderCompactCall("episode", args, theme, context),
		renderResult: (result, options, theme, context) => renderCompactResult("episode", result, options, theme, context),
		description: "Fetch the full text of a stored episode by id (e.g. \"t1.e2\").",
		promptSnippet: "Fetch a stored episode's full text by id",
		parameters: Type.Object({
			id: Type.String({ description: "Episode id, e.g. \"t1.e2\"" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const episode = store.episodes.get(params.id);
			if (!episode) {
				throw new Error("Unknown episode. Use threads to find episode IDs.");
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
