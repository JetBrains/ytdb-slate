/**
 * Worker sessions: in-process pi SDK AgentSessions with the recursion guard.
 *
 * A worker loads NO extensions, skills, prompt templates, or themes
 * (DefaultResourceLoader no* options) — so a worker can never see slate tools
 * (ExecPlan D7, depth-1 guard) — and inherits the HOST session's project-trust
 * state via an explicit SettingsManager, so untrusted projects get neither
 * project-local settings nor the project SYSTEM.md override in workers.
 * Worker conversations persist under
 * <config dir>/slate/threads/*.jsonl (CONFIG_DIR_NAME, ".pi" by default)
 * and are reopened via SessionManager.open.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadPromptDocs } from "./prompt-docs.ts";

export type WorkerSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const WORKER_PREAMBLE = [
	"You are a worker thread executing ONE bounded action for an orchestrator.",
	"Do the action fully, then stop.",
	"Your final message must state: what you did, what you found, files you touched,",
	"and anything the orchestrator must know.",
].join(" ");

function readFileOr(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function threadsDir(cwd: string): string {
	return resolve(cwd, CONFIG_DIR_NAME, "slate", "threads");
}

export function episodesDir(cwd: string): string {
	return resolve(cwd, CONFIG_DIR_NAME, "slate", "episodes");
}

/** Resolve a "provider/id" model string against the registry; throws a clear error if unknown. */
export function resolveModel(ctx: ExtensionContext, spec: string) {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`Invalid model spec "${spec}" — expected "provider/id"`);
	const model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
	if (!model) throw new Error(`Unknown model "${spec}" — not found in the model registry`);
	return model;
}

export async function openWorkerSession(opts: {
	ctx: ExtensionContext;
	sessionFile?: string; // resume when provided, else create new under <config dir>/slate/threads/
	model?: string; // "provider/id"
	tools?: string[];
	promptDocs?: string[]; // role-guideline doc paths, cwd-relative (default none)
}): Promise<WorkerSession> {
	const { ctx } = opts;
	const dir = threadsDir(ctx.cwd);
	mkdirSync(dir, { recursive: true });

	const agentDir = getAgentDir();

	// Trust propagation (mirrors vanilla pi's runtime SettingsManager): when no
	// settingsManager is passed, the SDK default-constructs one with
	// projectTrusted=true, which would make workers honor project-local
	// settings and the <config dir>/SYSTEM.md override even in projects the
	// user has NOT trusted. Carry the host session's actual trust decision into
	// both the resource loader and the session.
	//
	// READ-ONLY view (AF8/AF9): model failover may call session.setModel on a
	// live worker, and setModel persists the new model as the default via
	// SettingsManager (setThinkingLevel likewise). A file-backed manager would
	// write a worker's failover model into the USER'S global settings.json.
	// Instead, serve the same two files SettingsManager.create would read
	// (FileSettingsStorage paths: <agentDir>/settings.json and
	// <cwd>/<CONFIG_DIR_NAME>/settings.json), captured once here, through a
	// custom SettingsStorage whose withLock discards the callback's return
	// value — the supported no-op write path (persistScopedSettings only hands
	// the new JSON back as that return value; there is no error path). Reads,
	// merge semantics, and trust gating are identical to a file-backed manager.
	const globalJson = readFileOr(join(agentDir, "settings.json"));
	const projectJson = readFileOr(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
	const settingsManager = SettingsManager.fromStorage(
		{
			withLock(scope, fn) {
				fn(scope === "global" ? globalJson : projectJson); // return discarded → writes dropped
			},
		},
		{ projectTrusted: ctx.isProjectTrusted() },
	);

	// Role-guideline doc content is captured when this session object is
	// created: a live session keeps its system prompt until disposed; a
	// thread reopened later (e.g. after a pi restart) re-reads the docs at
	// their then-current content. Blocks go in separator-free — pi core
	// joins appendSystemPrompt entries with "\n\n". Trust gate: project files
	// are never injected into worker prompts for untrusted projects.
	const promptDocs = ctx.isProjectTrusted() ? loadPromptDocs(ctx.cwd, opts.promptDocs ?? []) : [];
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		noExtensions: true, // recursion guard (D7)
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPrompt: [WORKER_PREAMBLE, ...promptDocs],
	});
	await loader.reload();

	const model = opts.model ? resolveModel(ctx, opts.model) : ctx.model;

	const sessionManager = opts.sessionFile
		? SessionManager.open(opts.sessionFile)
		: SessionManager.create(ctx.cwd, dir);

	// No modelRuntime passed: createAgentSession (pi >= 0.80.8) defaults to a
	// ModelRuntime replacing the AuthStorage + ModelRegistry setup this code
	// hand-built before those SDK options were removed. Credential/config
	// sources are unchanged — global agentDir auth.json + models.json, never
	// project-local — but the default is a superset: it also reads/writes
	// agentDir/models-store.json and may run a throttled (~4h-cached)
	// create-time network catalog refresh (disabled by PI_OFFLINE).
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		model: model ?? undefined,
		// Explicit thinkingLevel (AF9): a live failover to a weaker model
		// re-clamps the thinking level and appends thinking_level_change to the
		// worker's session file; on reopen the SDK restores that clamped value
		// (resolution: explicit option > session file > settings default), which
		// would permanently downgrade the thread after the mapped model is
		// abandoned. Passing the settings default explicitly on every open makes
		// the SDK re-clamp against the CURRENT model instead. "medium" mirrors
		// the SDK's DEFAULT_THINKING_LEVEL (not exported).
		thinkingLevel: settingsManager.getDefaultThinkingLevel() ?? "medium",
		tools: opts.tools && opts.tools.length > 0 ? opts.tools : DEFAULT_WORKER_TOOLS,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
	});
	return session;
}
