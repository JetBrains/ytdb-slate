/**
 * Worker sessions: in-process pi SDK AgentSessions with the recursion guard.
 *
 * A worker loads NO skills, prompt templates, or themes (DefaultResourceLoader
 * no* options), and by default NO extensions either — so a worker can never see
 * slate tools (ExecPlan D7, depth-1 guard). It inherits the HOST session's
 * project-trust state via an explicit SettingsManager, so untrusted projects get
 * neither project-local settings nor the project SYSTEM.md override in workers.
 *
 * When the host resolved a `workerExtensions` whitelist (worker-extensions.ts),
 * the loader runs in ALLOWLIST mode: noExtensions STAYS true — so auto-discovery
 * (slate itself included) never runs — while additionalExtensionPaths adds back
 * EXACTLY the resolved units and nothing else. The depth-1 guard survives because
 * the resolver's load-scoped barriers already excluded slate's own package and
 * any name-colliding unit; this file re-checks collisions post-load (RG2 below).
 * Load units are ABSOLUTE paths (package directories or entry files), NEVER npm/
 * git specs (AD20): a spec resolves at temporary scope against a separate install
 * root, which would not reuse the host's installed copy and would attempt a
 * network install.
 *
 * Worker conversations persist under
 * <config dir>/slate/threads/*.jsonl (CONFIG_DIR_NAME, ".pi" by default)
 * and are reopened via SessionManager.open.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
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
import { PI_BUILTIN_TOOL_NAMES, SLATE_TOOL_NAMES } from "./worker-extensions.ts";

export type WorkerSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const WORKER_PREAMBLE = [
	"You are a worker thread executing ONE bounded action for an orchestrator.",
	"Do the action fully, then stop.",
	"Your final message must state: what you did, what you found, files you touched,",
	"and anything the orchestrator must know.",
].join(" ");

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
	extensionPaths?: string[]; // absolute worker-extension load units (package dirs or entry files); default none
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
	// Instead, snapshot the settings once here and serve them through a custom
	// SettingsStorage whose withLock discards the callback's return value —
	// the supported no-op write path (persistScopedSettings only hands the new
	// JSON back as that return value; there is no error path). Reads, merge
	// semantics, and trust gating are identical to a file-backed manager.
	//
	// CN4: the snapshot is taken via a throwaway file-backed SettingsManager,
	// NOT a raw readFileSync — pi's settings writer holds a lockfile during
	// its non-atomic writes (e.g. the orchestrator's own failover setModel
	// persisting a new global default), so an unlocked read could tear. The
	// throwaway does the locked, error-tolerant read; its per-scope snapshots
	// are re-serialized for the storage below (fromStorage re-parses and
	// re-migrates them — idempotent), and it never writes: no setter is ever
	// called on it.
	const trusted = ctx.isProjectTrusted();
	const snapshot = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: trusted });
	const globalJson = JSON.stringify(snapshot.getGlobalSettings());
	const projectJson = JSON.stringify(snapshot.getProjectSettings());
	const settingsManager = SettingsManager.fromStorage(
		{
			withLock(scope, fn) {
				fn(scope === "global" ? globalJson : projectJson); // return discarded → writes dropped
			},
		},
		{ projectTrusted: trusted },
	);

	// Role-guideline doc content is captured when this session object is
	// created: a live session keeps its system prompt until disposed; a
	// thread reopened later (e.g. after a pi restart) re-reads the docs at
	// their then-current content. Blocks go in separator-free — pi core
	// joins appendSystemPrompt entries with "\n\n". Trust gate: project files
	// are never injected into worker prompts for untrusted projects.
	const promptDocs = ctx.isProjectTrusted() ? loadPromptDocs(ctx.cwd, opts.promptDocs ?? []) : [];
	// Absolute load units resolved by the host (worker-extensions.ts); empty =
	// feature off, the historical no-extensions worker.
	const extensionPaths = opts.extensionPaths ?? [];
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		// Recursion guard (D7): auto-discovery stays OFF. additionalExtensionPaths
		// runs the loader in allowlist mode — noExtensions keeps every
		// auto-discovered extension out (slate included) while these absolute units
		// are the only ones added back (AD20 — see the module header on why paths,
		// never specs). undefined when empty so the default worker is untouched.
		noExtensions: true,
		additionalExtensionPaths: extensionPaths.length > 0 ? extensionPaths : undefined,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPrompt: [WORKER_PREAMBLE, ...promptDocs],
	});
	await loader.reload();

	// Extension tool names actually registered by the whitelisted units — needed
	// both for the collision re-check and for the tools allowlist below. Stays
	// empty (and this whole block is skipped) unless a whitelist was resolved.
	const extensionToolNames: string[] = [];
	if (extensionPaths.length > 0) {
		const warn = (msg: string) => (ctx.hasUI ? ctx.ui.notify(msg, "warning") : console.warn(msg));
		const loaded = loader.getExtensions();
		// A whitelisted extension that failed to load must not vanish silently —
		// surface every loader error naming the path (missing path, parse/throw, …).
		for (const err of loaded.errors ?? []) {
			warn(`slate: worker extension failed to load — ${err.path}: ${err.error}`);
		}
		// Collect the tool names each loaded extension actually registered. Loose
		// cast + Map guard: tolerate a malformed extensions/tools shape (state.ts
		// pattern).
		const collisions: string[] = [];
		for (const ext of loaded.extensions ?? []) {
			const e = ext as unknown as { path?: unknown; tools?: unknown };
			if (!(e.tools instanceof Map)) continue;
			for (const name of e.tools.keys()) {
				if (typeof name !== "string" || name === "") continue;
				extensionToolNames.push(name);
				// POST-LOAD COLLISION RE-CHECK (RG2): the host registry the resolver saw
				// cannot reveal a tool an extension registers only CONDITIONALLY, and
				// pi's tool registry lets an extension tool OVERWRITE a same-named
				// built-in — so a worker's `read` could silently become someone else's.
				// Fail the dispatch CLOSED rather than run that worker.
				if (SLATE_TOOL_NAMES.includes(name) || PI_BUILTIN_TOOL_NAMES.includes(name)) {
					const path = typeof e.path === "string" ? e.path : "extension";
					collisions.push(`${path} → "${name}"`);
				}
			}
		}
		if (collisions.length > 0) {
			// Thrown BEFORE createAgentSession below, so no worker session is leaked.
			throw new Error(
				`slate: refusing to open worker — whitelisted extension(s) register tool(s) that would overwrite a slate or pi built-in tool: ${collisions.join(", ")}`,
			);
		}
	}

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
		// workerTools / the per-dispatch `tools` argument govern the BUILT-IN tools
		// only; pi's allowlist gates extension tools too, so the whitelisted
		// extensions' registered tool names are unioned in (de-duplicated) — without
		// this the extensions would load but stay inert (present in the registry,
		// absent from the active set). A colliding built-in name was rejected above.
		tools: [
			...new Set([...(opts.tools && opts.tools.length > 0 ? opts.tools : DEFAULT_WORKER_TOOLS), ...extensionToolNames]),
		],
		resourceLoader: loader,
		sessionManager,
		settingsManager,
	});
	return session;
}
