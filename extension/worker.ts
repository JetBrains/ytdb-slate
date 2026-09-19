/**
 * Worker sessions: in-process pi SDK AgentSessions with the recursion guard.
 *
 * A worker loads NO skills, prompt templates, or themes (DefaultResourceLoader
 * no* options), and by default no project or discovered extensions. Slate
 * supplies one internal reminder component. The structural excludeTools guard
 * keeps slate tools out (depth-1 guard). It inherits the HOST session's
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
	type ModelRegistry,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { sanitizeForNotify } from "./notify.ts";
import { loadPromptDocs } from "./prompt-docs.ts";
import type { RequestThrottle } from "./request-throttle.ts";
import { createWorkerReminderRuntime } from "./worker-reminder.ts";
import { describeSpecDefect, splitModelSpec, type ThreadType } from "./state.ts";
import { PI_BUILTIN_TOOL_NAMES, SLATE_TOOL_NAMES } from "./worker-extensions.ts";

export type WorkerSession = Awaited<ReturnType<typeof createAgentSession>>["session"] & {
	workerReminderHandledToolResult(): boolean;
	/** Emit worker session_shutdown once, then dispose even when a handler fails. */
	shutdownWorker(): Promise<void>;
};

export const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Thread types that receive the reviewer charter and require findings structure. */
export const JUDGEMENT_THREAD_TYPES = ["reviewer", "adversarial"] as const satisfies readonly ThreadType[];

export function isJudgementThreadType(type: unknown): type is (typeof JUDGEMENT_THREAD_TYPES)[number] {
	return (JUDGEMENT_THREAD_TYPES as readonly unknown[]).includes(type);
}

// pi-ai 0.85.1 declares this value in
// @earendil-works/pi-ai/dist/api/openai-prompt-cache.js. pi's extension loader
// aliases the package root to the compat.js FILE, so an extension cannot safely
// import that deep subpath. The node test pins this copy to pi-ai's declaration.
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

// Common writing guidance reaches every trusted worker configuration.
// Reviewer guidance is added only for judgement thread types.
export const WORKER_PREAMBLE = [
	"You are a worker thread executing ONE bounded action for an orchestrator.",
	"Do the action fully, then stop.",
	"Issue all independent tool calls simultaneously in one worker turn.",
	"Use separate turns only when results depend on each other or conflict.",
	"The harness runs calls issued in one turn at the same time. Cumulative token cost grows with the square of the number of turns because each turn resends the conversation history.",
	"Your final message must state: what you did, what you found, files you touched,",
	"and anything the orchestrator must know.",
].join(" ");

export const WORKER_WRITING_GUIDANCE =
	"Use short, active sentences. Write sentences a non-native reader understands on one reading. Do not use semicolons or contractions. Apply these rules to your prose. Exclude research logs, worker task text, and the project's own agent instruction file.";

export const REVIEWER_CHARTER = `- Trace, don't guess: cite evidence from code actually read (file:line
  or diff hunk) for every claim about behavior. Read third-party /
  library code instead of assuming its semantics.
- Enumerate the cases along the changed execution paths that are in
  scope (branches, error paths, boundary values). Mark each case as
  checked or explicitly out of scope, and state the coverage gaps. For
  prose, enumerate the affected audiences, reader tasks, claims,
  definitions, cross-references, examples, exceptions, and boundary
  conditions instead of execution paths.
- Back every defect claim (blocker or major) with a concrete
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

export function workerPreamble(trusted: boolean, reviewerCharter: boolean): string {
	const prose = trusted ? `${WORKER_PREAMBLE} ${WORKER_WRITING_GUIDANCE}` : WORKER_PREAMBLE;
	return reviewerCharter === true ? `${prose}\n${REVIEWER_CHARTER}` : prose;
}

export function threadsDir(cwd: string): string {
	return resolve(cwd, CONFIG_DIR_NAME, "slate", "threads");
}

function installPromptCacheKey(session: WorkerSession, promptCacheKey?: string): void {
	const previous = session.agent.onPayload;
	session.agent.onPayload = async (payload, model) => {
		let chainedPayload = payload;
		try {
			const result = await previous?.(payload, model);
			if (result !== undefined && result !== null) chainedPayload = result;
		} catch {
			return payload;
		}

		try {
			// pi-ai 0.85.1's api/openai-responses.js buildParams always creates
			// prompt_cache_key and assigns undefined when resolved cacheRetention is
			// "none". Own-property presence therefore distinguishes that deliberate
			// opt-out from a payload shape that never considered this field.
			const platformDisabledCache =
				typeof payload === "object" &&
				payload !== null &&
				Object.prototype.hasOwnProperty.call(payload, "prompt_cache_key") &&
				(payload as Record<string, unknown>).prompt_cache_key === undefined;
			const chainedDisabledCache =
				typeof chainedPayload === "object" &&
				chainedPayload !== null &&
				Object.prototype.hasOwnProperty.call(chainedPayload, "prompt_cache_key") &&
				(chainedPayload as Record<string, unknown>).prompt_cache_key === undefined;
			if (
				promptCacheKey === undefined ||
				model.api !== "openai-responses" ||
				platformDisabledCache ||
				chainedDisabledCache ||
				Array.from(promptCacheKey).length > OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH ||
				typeof chainedPayload !== "object" ||
				chainedPayload === null
			) {
				return chainedPayload;
			}
			(chainedPayload as Record<string, unknown>).prompt_cache_key = promptCacheKey;
			return chainedPayload;
		} catch {
			return chainedPayload;
		}
	};
}

/** The SDK's own stream-function type, read off the session so slate cannot drift from it. */
type WorkerStreamFunction = WorkerSession["agent"]["streamFunction"];

/**
 * Put the session's request throttle in front of every provider request.
 *
 * WHY THE STREAM FUNCTION, and not `onPayload`:
 *  · the stream function receives the run's ABORT SIGNAL in its options, so the
 *    wait can be cancelled; `onPayload` receives only a payload and a model
 *    (pi-ai types.d.ts), so a wait there could not be cancelled;
 *  · pi's history compaction and branch summarization call
 *    `this.agent.streamFunction` directly (pi-coding-agent
 *    dist/core/agent-session.js lines 1453 and 2551) and their options are built
 *    WITHOUT `onPayload` (dist/core/compaction/compaction.js
 *    createSummarizationOptions), so a throttle on `onPayload` would miss every
 *    worker history summary, which the approved design includes;
 *  · the wait happens BEFORE the SDK converts the conversation into a provider
 *    payload, so a waiting request holds no converted copy (PF5).
 *
 * THE AUTHENTICATION CONTRACT IS UNCHANGED by this wrapper.
 * `AgentSession._getSummarizationRequestAuth` (agent-session.js:195) takes its
 * STRICT branch only while `agent.streamFunction === streamSimple`. A session
 * built by `createAgentSession` never satisfies that test: the SDK installs its
 * own stream function on the Agent (dist/core/sdk.js, `streamFn:` in the agent
 * runtime options), so the lenient branch is already the branch every slate
 * worker session used before this wrapper existed. A measured probe on the
 * pinned pi 0.85.1 confirmed `streamFunction === streamSimple` is false for a
 * fresh worker session, and test/request-throttle-worker.test.ts pins it.
 *
 * A THROWN admission error is NOT swallowed. A cancelled wait rejects, pi turns
 * the rejection into the same aborted or errored assistant outcome it produces
 * for a provider failure (pi-agent-core dist/agent.js handleRunFailure), and no
 * request is sent.
 */
export function installRequestThrottle(session: WorkerSession, throttle: RequestThrottle): void {
	const previous: WorkerStreamFunction = session.agent.streamFunction;
	session.agent.streamFunction = async (model, context, options) => {
		await throttle.admit(model, options?.signal);
		return previous(model, context, options);
	};
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

function providerInheritanceError(providerId?: string): Error {
	const suffix = providerId === undefined ? "" : ` for provider "${sanitizeForNotify(providerId, 80)}"`;
	return new Error(`slate: worker provider inheritance failed${suffix}. No provider configuration details were reported.`);
}

/**
 * Copy host extension provider registrations that the constructed worker did
 * not realize itself. The registered-provider roster is the public union of
 * native and config registrations. Built-in providers are outside that roster,
 * so a host extension override of a built-in still crosses this boundary.
 *
 * @internal
 * Internal helper. Direct imports are not a supported interface.
 */
export function inheritHostProviderRegistrations(
	host: Pick<
		ModelRegistry,
		"getRegisteredProviderIds" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider"
	>,
	worker: ModelRuntime,
): void {
	let hostIds: readonly string[];
	try {
		hostIds = host.getRegisteredProviderIds();
	} catch {
		throw providerInheritanceError();
	}

	let workerIds: Set<string>;
	let providerIds: string[];
	try {
		workerIds = new Set(worker.getRegisteredProviderIds());
		providerIds = [...new Set(hostIds)];
		if (providerIds.some((providerId) => typeof providerId !== "string" || providerId.trim() === "")) {
			throw providerInheritanceError();
		}
		providerIds.sort();
	} catch {
		throw providerInheritanceError();
	}

	for (const providerId of providerIds) {
		if (workerIds.has(providerId)) continue;

		try {
			const native = host.getRegisteredNativeProvider(providerId);
			const config = native === undefined ? host.getRegisteredProviderConfig(providerId) : undefined;
			if (native !== undefined) worker.registerNativeProvider(native);
			else if (config !== undefined) worker.registerProvider(providerId, config);
			else throw providerInheritanceError(providerId);

			const registered = new Set(worker.getRegisteredProviderIds());
			const copiedFormIsPresent = native !== undefined
				? worker.getRegisteredNativeProvider(providerId) === native
				: worker.getRegisteredProviderConfig(providerId) !== undefined;
			const compositionError = worker.getError()?.includes(`Provider "${providerId}":`) === true;
			if (!registered.has(providerId) || !copiedFormIsPresent || worker.getProvider(providerId) === undefined || compositionError) {
				throw providerInheritanceError(providerId);
			}
			workerIds.add(providerId);
		} catch {
			throw providerInheritanceError(providerId);
		}
	}
}

export async function openWorkerSession(opts: {
	ctx: ExtensionContext;
	sessionFile?: string; // resume when provided, else create new under <config dir>/slate/threads/
	// Episode and observation paths do not belong here. Their shared artifact writer owns persistence.
	model?: string; // "provider/id"
	tools?: string[];
	promptDocs?: string[]; // role-guideline doc paths, cwd-relative (default none)
	extensionPaths?: string[]; // absolute worker-extension load units (package dirs or entry files); default none
	extensionToolNames?: string[]; // host-selected names, including tools registered during host session_start
	reviewerCharter?: boolean; // thread-role decision from ThreadManager; only literal true enables the charter
	promptCacheKey?: string; // the main session's shared OpenAI Responses cache-routing key
	requestThrottle?: RequestThrottle; // the main session's shared per-model request throttle
	report?: (message: string) => void; // lifecycle failures visible to the dispatch and host
	onCreated?: (session: WorkerSession) => void; // publish startup-in-flight ownership before session_start awaits
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
	const workerReminder = createWorkerReminderRuntime();
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
		extensionFactories: [
			{
				name: "slate-worker-reminder",
				factory: workerReminder.extension,
				hidden: true,
			},
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		// Writing guidance is always active for trusted projects. The reviewer
		// charter is not trust-gated because it is slate's own constant.
		appendSystemPrompt: [workerPreamble(trusted, opts.reviewerCharter === true), ...promptDocs],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	const warn = (msg: string) => {
		try {
			if (opts.report) opts.report(msg);
			else if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else console.warn(msg);
		} catch {
			// A reporting sink must never turn a fail-soft extension error into an
			// unobserved lifecycle interruption.
			try { console.warn(msg); } catch { /* no remaining reporting channel */ }
		}
	};
	// A worker extension or the internal reminder component must not vanish
	// silently. Surface every loader error naming the path. Paths and messages
	// are extension-supplied and flow to the UI, the console and the persisted
	// episode, so sanitize them like every other displayed string.
	for (const err of loaded.errors ?? []) {
		warn(`slate: worker extension failed to load — ${sanitizeForNotify(String(err.path))}: ${sanitizeForNotify(String(err.error))}`);
	}

	// Extension tool names actually registered by the whitelisted units — needed
	// both for the collision re-check and for the tools allowlist below. Stays
	// empty (and this whole block is skipped) unless a whitelist was resolved.
	const extensionToolNames: string[] = [];
	if (extensionPaths.length > 0) {
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
			...new Set([
				...(opts.tools && opts.tools.length > 0 ? opts.tools : DEFAULT_WORKER_TOOLS),
				...extensionToolNames,
				...(extensionPaths.length > 0 ? (opts.extensionToolNames ?? []) : []),
			]),
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
	let lifecyclePhase: "startup" | "running" | "shutdown" = "startup";
	const startupErrors: string[] = [];
	let startupPromise: Promise<void> | undefined;
	let shutdownPromise: Promise<void> | undefined;
	const extensionError = (error: { extensionPath: string; event: string; error: string }) => {
		const detail = `${sanitizeForNotify(error.extensionPath)} (${sanitizeForNotify(error.event)}): ${sanitizeForNotify(error.error)}`;
		// Attribute an error to the event that produced it. Host teardown can change
		// lifecyclePhase while an async session_start handler is still running.
		const phase = error.event === "session_start" ? "startup" : lifecyclePhase;
		if (phase === "startup") startupErrors.push(detail);
		warn(`slate: worker extension ${phase} failed — ${detail}`);
	};
	const workerSession = Object.assign(session, {
		workerReminderHandledToolResult: workerReminder.handledToolResult,
		shutdownWorker(): Promise<void> {
			if (shutdownPromise !== undefined) return shutdownPromise;
			lifecyclePhase = "shutdown";
			shutdownPromise = (async () => {
				// Host teardown can arrive while session_start is still running. Preserve
				// pi's lifecycle order by waiting for that startup attempt to settle.
				try { await startupPromise; } catch { /* failed startup still receives shutdown */ }
				try {
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} catch (error) {
					warn(`slate: worker extension shutdown failed — ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}`);
				} finally {
					try {
						session.dispose();
					} catch (error) {
						warn(`slate: worker session disposal failed — ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}`);
					}
				}
			})();
			return shutdownPromise;
		},
	});
	if (opts.promptCacheKey !== undefined) installPromptCacheKey(workerSession, opts.promptCacheKey);
	// Installed INDEPENDENTLY of the cache key above: the two switches are
	// separate, so a project may keep either one without the other.
	if (opts.requestThrottle !== undefined) installRequestThrottle(workerSession, opts.requestThrottle);

	// bindExtensions has not installed its listener yet. Keep cleanup errors
	// visible if provider inheritance fails in this partial-startup window.
	const stopEarlyExtensionErrors = typeof session.extensionRunner.onError === "function"
		? session.extensionRunner.onError(extensionError)
		: () => {};
	try {
		// Worker extension registrations flush during AgentSession construction.
		// Compare the realized union only after createAgentSession returns and
		// before extension startup can select a route or issue the first request.
		inheritHostProviderRegistrations(ctx.modelRegistry, session.modelRuntime);
	} catch (error) {
		await workerSession.shutdownWorker();
		throw error;
	}
	stopEarlyExtensionErrors();

	startupPromise = (async () => {
		// createAgentSession loads extension factories but does not emit session_start.
		// Binding completes startup and refreshes tools registered by those handlers.
		await session.bindExtensions({ mode: "print", onError: extensionError });
		if (startupErrors.length > 0) {
			throw new Error(`slate: worker extension startup did not complete: ${startupErrors.join("; ")}`);
		}

		// The selected unit maps are live. Re-scan after session_start so a deferred
		// registration cannot replace a Slate or pi built-in before the first prompt.
		const startupCollisions: string[] = [];
		for (const ext of loaded.extensions ?? []) {
			const candidate = ext as unknown as { path?: unknown; tools?: unknown };
			if (!(candidate.tools instanceof Map)) continue;
			for (const name of candidate.tools.keys()) {
				if (typeof name !== "string" || (!SLATE_TOOL_NAMES.includes(name) && !PI_BUILTIN_TOOL_NAMES.includes(name))) continue;
				const path = typeof candidate.path === "string" ? candidate.path : "extension";
				startupCollisions.push(`${sanitizeForNotify(path)} → "${sanitizeForNotify(name)}"`);
			}
		}
		if (startupCollisions.length > 0) {
			throw new Error(
				`slate: refusing to start worker — selected extension(s) registered tool(s) during startup that overwrite a slate or pi built-in tool: ${startupCollisions.join(", ")}`,
			);
		}
		if (shutdownPromise === undefined) lifecyclePhase = "running";
	})();
	opts.onCreated?.(workerSession);
	try {
		await startupPromise;
		return workerSession;
	} catch (error) {
		await workerSession.shutdownWorker();
		throw error;
	}
}
