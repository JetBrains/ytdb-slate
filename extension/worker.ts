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
 * EXACTLY the resolved units and nothing else. The depth-1 guard is STRUCTURAL
 * (SE20): createAgentSession is given an excludeTools denylist of slate's
 * dispatch tools (thread/threads/episode), and the SDK re-applies that denylist
 * on every tool-registry refresh, so no worker can call them no matter when or
 * by whom they are registered — even a deferred before_agent_start registration.
 * The resolver's load-scoped barriers plus a best-effort post-load scan (RG2
 * below) additionally reject a unit that shadows a pi BUILT-IN at load time; a
 * deferred built-in shadow cannot be prevented from slate's side, exactly as it
 * cannot be for any extension in the host session.
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
import { sanitizeForNotify } from "./notify.ts";
import { loadPromptDocs } from "./prompt-docs.ts";
import { describeSpecDefect, splitModelSpec } from "./state.ts";
import { PI_BUILTIN_TOOL_NAMES, SLATE_TOOL_NAMES } from "./worker-extensions.ts";

export type WorkerSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Keep this historical feature-off preamble byte-identical. Optional guidance is
// added by workerPreamble only when its corresponding switch is on.
export const WORKER_PREAMBLE = [
	"You are a worker thread executing ONE bounded action for an orchestrator.",
	"Do the action fully, then stop.",
	"Your final message must state: what you did, what you found, files you touched,",
	"and anything the orchestrator must know.",
].join(" ");

export const WORKER_WRITING_GUIDANCE =
	"Use short, active sentences. A sentence over 25 words fails. Over 20 words warns. Do not use semicolons or contractions. Apply these rules to all your prose.";

export const REVIEWER_CHARTER = `- Trace, don't guess: cite evidence from code actually read (file:line
  or diff hunk) for every claim about behavior. Read third-party /
  library code instead of assuming its semantics.
- Enumerate the cases along the changed execution paths that are in
  scope (branches, error paths, boundary values). Mark each case as
  checked or explicitly out of scope, and state the coverage gaps. For
  prose, enumerate the affected audiences, reader tasks, claims,
  definitions, cross-references, examples, exceptions, and boundary
  conditions instead of execution paths.
- Back every defect claim (blocker or should-fix) with a concrete
  counterexample: the input, state, or interleaving that triggers the
  defect, traced through the code.
- Back every correctness claim ("no issue here") with a justification
  bounded to the scope you state, and say what the
  justification does not cover. For prose, use a bounded, reproducible
  check of the relevant set. Examples include checker output, targeted
  searches, re-resolved references, and comparison with authoritative
  sources. State explicitly what those checks cannot establish.
- Before finalizing, run an alternative-hypothesis check: "if the
  opposite verdict were true, what evidence would exist?" — then look
  for that evidence.
- When useful, log hypotheses explicitly (hypothesis → evidence sought
  → confirmed / refuted / refined) instead of wandering.
- Derive the final verdict from the evidence and claims above, not from
  overall impression.
- State the evidence that closes a finding, not only the evidence that
  opens one. A verdict that a finding is resolved carries its own
  evidence.
- Treat a fix series as a changed artifact that needs review. Verify the
  addressed finding, then review the fix diff and the cumulative result
  for new paths, claims, and regressions. Clearing the original finding
  does not clear defects introduced by its fix.
- Structured reasoning can be confidently wrong when a case is missed.
  State coverage gaps rather than implying completeness. These
  arguments carry no formal guarantee and do not replace running the
  project's checks.
`;

export function workerPreamble(writingCheck: boolean, reviewerCharter: boolean): string {
	const additions: string[] = [];
	if (writingCheck === true) additions.push(WORKER_WRITING_GUIDANCE);
	if (reviewerCharter === true) additions.push(REVIEWER_CHARTER);
	return [WORKER_PREAMBLE, ...additions].join(" ");
}

export function threadsDir(cwd: string): string {
	return resolve(cwd, CONFIG_DIR_NAME, "slate", "threads");
}

export function episodesDir(cwd: string): string {
	return resolve(cwd, CONFIG_DIR_NAME, "slate", "episodes");
}

/**
 * Resolve a "provider/id" model string against the registry; throws a clear error
 * if unknown. Validation and splitting are the shared helpers (CQ2), so the
 * message now names WHY a spec is malformed — including invisible characters,
 * which an "unknown model" error could never have explained.
 */
export function resolveModel(ctx: ExtensionContext, spec: string) {
	const parts = splitModelSpec(spec);
	if (!parts) throw new Error(`Invalid model spec "${spec}" — ${describeSpecDefect(spec)}`);
	const model = ctx.modelRegistry.find(parts.provider, parts.id);
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
	writingCheck?: boolean; // sanitized writing.check; only literal true enables worker guidance
	reviewerCharter?: boolean; // thread-role decision from ThreadManager; only literal true enables the charter
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
	// feature off, the historical no-extensions worker. Defense in depth (CQ23):
	// re-gate on project trust here even though the config that produced these
	// paths is itself only loaded for trusted projects (index.ts) — an untrusted
	// project must never load extensions into a worker, whatever a future caller
	// passes.
	const extensionPaths = ctx.isProjectTrusted() ? (opts.extensionPaths ?? []) : [];
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
		// Defense in depth: config is loaded only for a trusted project (index.ts),
		// but a future direct caller must not inject writing guidance from an
		// untrusted project's switch. The reviewer charter is not trust-gated:
		// writing guidance points at a project-configured checker, while the charter
		// is slate's own constant and contains no project input.
		appendSystemPrompt: [workerPreamble(trusted && opts.writingCheck === true, opts.reviewerCharter === true), ...promptDocs],
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
		// surface every loader error naming the path. Paths and messages are
		// extension-supplied and flow to the UI, the console and the persisted
		// episode, so sanitize them (SE22) like every other displayed string.
		for (const err of loaded.errors ?? []) {
			warn(`slate: worker extension failed to load — ${sanitizeForNotify(String(err.path))}: ${sanitizeForNotify(String(err.error))}`);
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
				// LOAD-TIME collision scan (RG2), BEST-EFFORT: it sees only what the
				// extensions registered DURING loader.reload(). A deferred registration
				// (e.g. from a before_agent_start handler on the worker's first prompt)
				// is invisible here — and is equally available to any extension the host
				// session runs, so it is outside slate's control. slate's OWN invariant
				// does NOT rely on this scan: thread/threads/episode are denied
				// structurally by the excludeTools denylist on createAgentSession below
				// (re-applied on every tool-registry refresh), so no worker can call them
				// whenever they are registered. For a pi BUILT-IN there is no such
				// gap-closer (the worker needs the real built-in), so this scan catches a
				// LOAD-TIME shadow and fails the dispatch closed; a deferred shadow cannot
				// be prevented.
				if (SLATE_TOOL_NAMES.includes(name) || PI_BUILTIN_TOOL_NAMES.includes(name)) {
					const path = typeof e.path === "string" ? e.path : "extension";
					collisions.push(`${sanitizeForNotify(path)} → "${sanitizeForNotify(name)}"`);
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
		// STRUCTURAL depth-1 guard (SE20): slate's dispatch tools are denied to EVERY
		// worker session. excludeTools applies AFTER the allowlist and the SDK
		// re-applies it on every tool-registry refresh, so a tool named
		// thread/threads/episode is filtered out no matter when it is registered
		// (including a deferred before_agent_start registration) — a worker can never
		// re-enter the orchestrator's dispatch surface (D7).
		excludeTools: SLATE_TOOL_NAMES,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
	});
	return session;
}
