import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	createProvider,
	isRetryableAssistantError,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolvePromiseValue) => { resolvePromise = resolvePromiseValue; });
	return { promise, resolve: resolvePromise };
}

async function within<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitUntil(predicate: () => boolean, label: string, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

test("real Slate factory keeps recovery ownership across Pi session replacement", { timeout: 12_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-ownership-host-"));
	const project = join(root, "project");
	const agent = join(root, "agent");
	const home = join(root, "home");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(agent, { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 0, baseDelayMs: 0 } }));
	writeFileSync(join(project, ".pi", "settings.json"), "{}\n");
	writeFileSync(join(project, ".pi", "slate.json"), JSON.stringify({
		router: {
			models: {
				replace: [{
					model: "luna-6",
					preferredProvider: "ownership-primary",
					providers: { "ownership-primary": "primary", "ownership-fallback": "fallback" },
				}],
			},
		},
	}));

	const stateKey = `slate-ownership-host:${process.pid}:${Date.now()}:${Math.random()}`;
	const authEntered = deferred();
	const authGate = deferred();
	const state = {
		blockFallbackAuth: true,
		fallbackAuthEntries: 0,
		primaryStreams: 0,
		fallbackStreams: 0,
		authEntered: authEntered.resolve,
		authGate: authGate.promise,
	};
	const symbol = Symbol.for(stateKey);
	(globalThis as Record<symbol, unknown>)[symbol] = state;

	const fixture = join(root, "ownership-provider.ts");
	writeFileSync(fixture, `
import { createAssistantMessageEventStream, createProvider } from ${JSON.stringify("@earendil-works/pi-ai")};
import type { AssistantMessage, Model } from ${JSON.stringify("@earendil-works/pi-ai")};
import type { ExtensionAPI } from ${JSON.stringify("@earendil-works/pi-coding-agent")};
const state = (globalThis as any)[Symbol.for(${JSON.stringify(stateKey)})];
function model(provider: string, id: string): Model<any> {
  return {
    provider, id, name: id, api: "slate-ownership-host-api", baseUrl: "http://127.0.0.1:9",
    reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000, maxTokens: 20, thinkingLevelMap: { max: "max" },
  } as Model<any>;
}
function message(selected: Model<any>, stopReason: "error" | "stop"): AssistantMessage {
  return {
    role: "assistant", content: stopReason === "stop" ? [{ type: "text", text: "recovered" }] : [],
    api: selected.api, provider: selected.provider, model: selected.id,
    usage: { input: 1, output: stopReason === "stop" ? 1 : 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, ...(stopReason === "error" ? { errorMessage: "Connection error." } : {}), timestamp: Date.now(),
  };
}
function stream(selected: Model<any>) {
  if (selected.provider === "ownership-primary") state.primaryStreams += 1;
  else state.fallbackStreams += 1;
  const output = message(selected, selected.provider === "ownership-primary" ? "error" : "stop");
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...output, stopReason: "pending" } });
    events.push({ type: "done", reason: output.stopReason, message: output } as never);
    events.end();
  });
  return events;
}
function provider(provider: string, id: string, block: boolean) {
  const selected = model(provider, id);
  return createProvider({
    id: provider,
    auth: { apiKey: {
      name: provider,
      async check() { return { type: "api_key", source: "closed fixture" }; },
      async resolve() {
        if (block) {
          state.fallbackAuthEntries += 1;
          state.authEntered();
          if (state.blockFallbackAuth) await state.authGate;
        }
        return { auth: { apiKey: "closed-fixture" }, source: "closed fixture" };
      },
    } },
    models: [selected],
    api: { stream, streamSimple: stream },
  });
}
export default function (pi: ExtensionAPI) {
  pi.registerProvider(provider("ownership-primary", "primary", false));
  pi.registerProvider(provider("ownership-fallback", "fallback", true));
}
`, "utf8");

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.HOME = home;
	process.env.PI_OFFLINE = "1";
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(" ")); };
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agent, "auth.json"),
			modelsPath: join(agent, "models.json"),
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory(
					{ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 0, baseDelayMs: 0 } },
					{ projectTrusted: true },
				),
				resourceLoaderOptions: {
					noExtensions: true,
					additionalExtensionPaths: [fixture, resolve("extension/index.ts")],
				},
			});
			const primary = modelRuntime.getModel("ownership-primary", "primary");
			assert.ok(primary, "the closed primary provider is registered before session creation");
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: primary,
				thinkingLevel: "max",
				noTools: "all",
			});
			await created.session.bindExtensions({ mode: "print" });
			return { ...created, services, diagnostics: services.diagnostics };
		};
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: project,
			agentDir: agent,
			sessionManager: SessionManager.inMemory(project),
		});

		const oldPrompt = runtime.session.prompt("start old recovery");
		await within(authEntered.promise, "the old factory to enter fallback credential resolution");
		assert.equal(state.fallbackAuthEntries, 1);
		assert.equal(state.fallbackStreams, 0);

		await within(runtime.newSession(), "Pi to replace the session while old recovery is parked");
		const successor = runtime.session;
		await within(successor.prompt("prove replacement overlap is refused"), "the replacement busy refusal");
		assert.equal(state.primaryStreams, 2);
		assert.equal(state.fallbackAuthEntries, 1, "the successor must not enter route validation while the old lease is active");
		assert.equal(state.fallbackStreams, 0);
		assert.ok(warnings.some((message) => message.includes("main recovery is busy on saved-default")), warnings.join("\n"));

		state.blockFallbackAuth = false;
		authGate.resolve();
		await within(oldPrompt, "the obsolete old recovery callback to finish");
		assert.equal(state.fallbackStreams, 0, "the obsolete callback cannot switch or report recovery success");
		assert.equal(successor.model?.provider, "ownership-primary", "the obsolete callback cannot adopt a model in the successor");
		assert.ok(warnings.some((message) => message.includes("session was replaced during route validation")), warnings.join("\n"));

		await within(successor.prompt("recover after actual old-operation completion"), "the successor recovery after release");
		await waitUntil(() => state.fallbackStreams === 1, "the recovery continuation on the fallback provider");
		assert.equal(state.primaryStreams, 3);
		assert.equal(state.fallbackStreams, 1);
		assert.equal(successor.model?.provider, "ownership-fallback");
	} finally {
		state.blockFallbackAuth = false;
		authGate.resolve();
		if (runtime) await runtime.dispose();
		console.warn = originalWarn;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
		delete (globalThis as Record<symbol, unknown>)[symbol];
		rmSync(root, { recursive: true, force: true });
	}
});

test("real Pi replacement runs handoff setup before successor adoption", { timeout: 12_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-handoff-host-"));
	const project = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), "{}\n");
	writeFileSync(join(project, ".pi", "settings.json"), "{}\n");
	const key = `slate-handoff-host:${process.pid}:${Date.now()}`;
	const evidence: { sawEntry: boolean; adoptedCost: number; successorId?: string } = { sawEntry: false, adoptedCost: 0 };
	(globalThis as Record<symbol, unknown>)[Symbol.for(key)] = evidence;
	const fixture = join(root, "handoff-extension.ts");
	writeFileSync(fixture, `
import { SlateStore } from ${JSON.stringify(resolve("extension/state.ts"))};
import { registerSlateHandoff } from ${JSON.stringify(resolve("extension/handoff.ts"))};
import { createBaseModelTracker } from ${JSON.stringify(resolve("extension/base-model.ts"))};
const evidence = (globalThis as any)[Symbol.for(${JSON.stringify(key)})];
export default function(pi: any) {
  const store = new SlateStore(pi);
  const hooks = registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
  pi.on("session_start", (event: any, ctx: any) => {
    if (event.reason === "new") {
      const entry = ctx.sessionManager.getBranch().find((item: any) => item.type === "custom" && item.customType === "slate-handoff");
      evidence.sawEntry = entry?.data?.sessionId === ctx.sessionManager.getSessionId();
      evidence.adoptedCost = store.workerCostUsd;
      evidence.successorId = ctx.sessionManager.getSessionId();
    } else {
      store.orchestratorMode = true;
      store.workerCostUsd = 17;
      store.save();
    }
  });
  pi.registerCommand("host-handoff", { description: "Exercise the real Pi handoff path", handler: async (_args: string, ctx: any) => {
    await hooks.startHandoff(ctx);
  } });
}
`);
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.PI_OFFLINE = "1";
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	try {
		const modelRuntime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json") });
		const state = { scenario: "preflight-model" as const, primaryCalls: 0, fallbackCalls: 0, otherCalls: 0, compactionCalls: 0, compactionHistoryCalls: 0, compactionTurnPrefixCalls: 0, toolCalls: 0, modelSwitchSucceeded: false };
		modelRuntime.registerNativeProvider(matrixProvider(state, "matrix-primary", "primary"));
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd, agentDir, modelRuntime,
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: true }),
				resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: [fixture] },
			});
			const model = modelRuntime.getModel("matrix-primary", "primary");
			assert.ok(model);
			const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "max", noTools: "all" });
			return { ...created, services, diagnostics: services.diagnostics };
		};
		runtime = await createAgentSessionRuntime(createRuntime, { cwd: project, agentDir: agent, sessionManager: SessionManager.inMemory(project) });
		const host = runtime;
		const bind = async (session: typeof host.session) => {
			const unexpected = async (): Promise<never> => { throw new Error("unexpected host session action"); };
			await session.bindExtensions({ mode: "print", commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => host.newSession(options),
				fork: unexpected, navigateTree: unexpected, switchSession: unexpected, reload: unexpected,
			} });
		};
		host.setRebindSession(bind);
		await bind(host.session);
		assert.ok(runtime.session.extensionRunner.getCommand("host-handoff"), `host command failed to load: ${JSON.stringify(runtime.diagnostics)}`);
		assert.equal((runtime.session.sessionManager.getBranch().find((item) => item.type === "custom" && item.customType === "slate-state") as any)?.data.workerCostUsd, 17, "parent state seeded");
		const parentId = runtime.session.sessionManager.getSessionId();
		await within(runtime.session.prompt("/host-handoff"), "the real handoff command and kickoff", 8_000);
		const successor = runtime.session.sessionManager;
		assert.notEqual(successor.getSessionId(), parentId);
		assert.equal(evidence.successorId, successor.getSessionId(), "successor session_start fired");
		assert.equal(evidence.sawEntry, true, "setup had bound the entry before successor session_start");
		assert.equal(evidence.adoptedCost, 17, "the adoption handler restored the parent's nonempty state");
		assert.equal((successor.getBranch().find((item) => item.type === "custom" && item.customType === "slate-state") as any)?.data.workerCostUsd, 17);
		assert.equal(state.primaryCalls, 1, "withSession delivered the handoff kickoff through the closed provider");
	} finally {
		if (runtime) await runtime.dispose();
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
		delete (globalThis as Record<symbol, unknown>)[Symbol.for(key)];
		rmSync(root, { recursive: true, force: true });
	}
});

type MatrixScenario =
	| "preflight-effort"
	| "preflight-model"
	| "preflight-provider"
	| "later-effort"
	| "recovery-effort"
	| "compaction"
	| "compaction-refusal"
	| "startup-refusal"
	| "startup-accepted-then-refused"
	| "startup-rejected-open"
	| "startup-teardown-completed-tool"
	| "startup-caller-cancel-completed-tool"
	| "startup-caller-cancel-no-fact"
	| "startup-caller-cancel-fact-and-failure"
	| "startup-assistant-then-command-error"
	| "startup-assistant-then-ordinary-success"
	| "compaction-then-cancel"
	| "recovery-compaction-refusal";

interface MatrixState {
	scenario: MatrixScenario;
	/** Set when the refused startup run of the startup-refusal scenario ended. */
	startupRunEnded?: boolean;
	/** Set when the startup handler of that scenario returned. */
	startupRequestSettled?: boolean;
	/** Set when an accepted startup request completed its own tool call. */
	startupWorkCompleted?: boolean;
	/** Set when the independent startup handler of the rejected open ran. */
	independentStartupFailure?: boolean;
	/** Entered the startup failure barrier used by cancellation-order scenarios. */
	startupFailureEntered?: () => void;
	/** Event barriers for teardown during an admitted startup continuation. */
	secondRequestEntered?: () => void;
	secondRequestGate?: Promise<void>;
	startupOpenGate?: Promise<void>;
	startupToolEventEntered?: () => void;
	startupToolEventGate?: Promise<void>;
	/** Event barriers that hold the ordinary response after startup completes. */
	ordinaryRequestEntered?: () => void;
	ordinaryRequestGate?: Promise<void>;
	/** Event barriers for the continuation that follows a successful history rewrite. */
	postCompactionEntered?: () => void;
	postCompactionGate?: Promise<void>;
	recursiveAttempts?: number;
	shutdowns?: number;
	primaryCalls: number;
	fallbackCalls: number;
	otherCalls: number;
	compactionCalls: number;
	compactionHistoryCalls: number;
	compactionTurnPrefixCalls: number;
	compactionEvents?: Array<{ phase: "start" | "success"; reason: string; willRetry: boolean }>;
	toolCalls: number;
	modelSwitchSucceeded: boolean;
}

function extractContextText(context: unknown): string {
	if (!context || typeof context !== "object" || !("messages" in context) || !Array.isArray((context as { messages?: unknown[] }).messages)) {
		return "";
	}
	let text = "";
	for (const msg of (context as { messages: Array<{ content?: unknown }> }).messages) {
		if (typeof msg.content === "string") {
			text += msg.content;
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block && typeof block === "object" && "text" in block && typeof (block as { text?: unknown }).text === "string") {
					text += (block as { text: string }).text;
				}
			}
		}
	}
	return text;
}

function matrixModel(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: id,
		api: "slate-worker-matrix-api",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 100,
		thinkingLevelMap: { low: "low", max: "max" },
	} as Model<any>;
}

function matrixMessage(
	selected: Model<any>,
	kind: "tool" | "error" | "overflow" | "text" | "summary",
	text?: string,
): AssistantMessage {
	const content = kind === "tool"
		? [{ type: "toolCall" as const, id: "host-call-1", name: "host_probe", arguments: {} }]
		: kind === "error" || kind === "overflow" ? [] : [{ type: "text" as const, text: text ?? (kind === "summary" ? "matrix summary" : "matrix done") }];
	const stopReason = kind === "tool" ? "toolUse" : kind === "error" || kind === "overflow" ? "error" : "stop";
	return {
		role: "assistant",
		content,
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: {
			// Only the scripted overflow should trigger compaction, not this tool turn.
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(kind === "error" ? { errorMessage: "Connection error." } : kind === "overflow" ? { errorMessage: "context_length_exceeded" } : {}),
		timestamp: Date.now(),
	};
}

function matrixProvider(state: MatrixState, provider: string, id: string) {
	const selected = matrixModel(provider, id);
	const streamSimple = (requestModel: Model<any>, _context: unknown, options?: SimpleStreamOptions) => {
		if (requestModel.id === "other") state.otherCalls++;
		else if (provider === "matrix-primary") state.primaryCalls++;
		else if (provider === "matrix-fallback") state.fallbackCalls++;
		else state.otherCalls++;
		const summarizing = options?.cacheRetention === "none";
		let summaryKind: "history" | "turn-prefix" | undefined;
		if (summarizing) {
			state.compactionCalls++;
			const prompt = extractContextText(_context);
			if (prompt.includes("# Instructions\nThe messages above are earlier context from an ongoing conversation.")) {
				summaryKind = "turn-prefix";
				state.compactionTurnPrefixCalls++;
			} else {
				summaryKind = "history";
				state.compactionHistoryCalls++;
			}
		}
		let kind: "tool" | "error" | "overflow" | "text" | "summary" = summarizing ? "summary" : "text";
		if (!summarizing && state.scenario === "recovery-effort" && provider === "matrix-primary") kind = "error";
		if (!summarizing && state.scenario === "recovery-compaction-refusal") {
			// The primary route exhausts its retries. The accepted fallback answers once,
			// and its follow-up request overflows the window, so Pi starts compaction.
			if (provider === "matrix-primary") kind = "error";
			else if (provider === "matrix-fallback") kind = state.fallbackCalls === 1 ? "tool" : "overflow";
		}
		if (!summarizing && (state.scenario === "startup-accepted-then-refused" || state.scenario === "startup-rejected-open") && provider === "matrix-primary") {
			// The accepted startup request runs one tool. Its accepted continuation answers.
			kind = state.primaryCalls === 1 ? "tool" : "text";
		}
		if (!summarizing && (state.scenario === "startup-teardown-completed-tool" || state.scenario === "startup-caller-cancel-completed-tool" || state.scenario === "startup-caller-cancel-fact-and-failure") && provider === "matrix-primary") {
			kind = state.primaryCalls === 1 ? "tool" : "text";
		}
		if (!summarizing && (state.scenario === "later-effort" || state.scenario === "compaction" || state.scenario === "compaction-refusal") && provider === "matrix-primary" && state.primaryCalls === 1) kind = "tool";
		else if (!summarizing && (state.scenario === "compaction" || state.scenario === "compaction-refusal") && provider === "matrix-primary" && state.primaryCalls === 2) kind = "overflow";
		if (!summarizing && state.scenario === "compaction-then-cancel" && provider === "matrix-primary") {
			// One tool turn, one overflow that starts a real rewrite, then the
			// continuation the caller cancels.
			kind = state.primaryCalls === 1 ? "tool" : state.primaryCalls === 2 ? "overflow" : "text";
		}
		const responseText = summarizing
			? summaryKind === "turn-prefix" ? "matrix turn prefix summary" : "matrix history summary"
			: !summarizing && state.scenario === "startup-assistant-then-ordinary-success" && provider === "matrix-primary"
				? state.primaryCalls === 1 ? "startup completed fact" : "ordinary action success"
				: undefined;
		const output = matrixMessage(requestModel, kind, responseText);
		const events = createAssistantMessageEventStream();
		const publish = () => {
			events.push({ type: "start", partial: { ...output, stopReason: "pending" } });
			events.push({ type: "done", reason: output.stopReason, message: output } as never);
			events.end();
		};
		if (!summarizing && state.scenario === "startup-teardown-completed-tool" && provider === "matrix-primary" && state.primaryCalls === 2) {
			state.secondRequestEntered?.();
			void state.secondRequestGate?.then(() => queueMicrotask(publish));
		} else if (!summarizing && state.scenario === "startup-assistant-then-ordinary-success" && provider === "matrix-primary" && state.primaryCalls === 2) {
			state.ordinaryRequestEntered?.();
			void state.ordinaryRequestGate?.then(() => queueMicrotask(publish));
		} else if (!summarizing && state.scenario === "compaction-then-cancel" && provider === "matrix-primary" && state.primaryCalls >= 4) {
			state.postCompactionEntered?.();
			void state.postCompactionGate?.then(() => queueMicrotask(publish));
		} else {
			queueMicrotask(publish);
		}
		return events;
	};
	return createProvider({
		id: provider,
		auth: { apiKey: {
			name: provider,
			async check() { return { type: "api_key", source: "closed matrix fixture" }; },
			async resolve() { return { auth: { apiKey: "closed-matrix" }, source: "closed matrix fixture" }; },
		} },
		models: provider === "matrix-primary" ? [selected, matrixModel(provider, "other")] : [selected],
		api: { stream: streamSimple as never, streamSimple: streamSimple as never },
	});
}

test("manager teardown invalidates a request owner before paused worker startup and waits for paused shutdown", { timeout: 15_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-opening-contract-"));
	const project = join(root, "project");
	const agent = join(root, "agent");
	const home = join(root, "home");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(agent, { recursive: true });
	mkdirSync(home, { recursive: true });
	const settings = { defaultThinkingLevel: "max", retry: { enabled: true, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false } };
	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify(settings));
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));

	const startupEntered = deferred();
	const startupGate = deferred();
	const shutdownEntered = deferred();
	const shutdownGate = deferred();
	const state: MatrixState & {
		startupEntered(): void;
		startupGate: Promise<void>;
		shutdownEntered(): void;
		shutdownGate: Promise<void>;
		requestSettled: boolean;
	} = {
		scenario: "preflight-model",
		primaryCalls: 0,
		fallbackCalls: 0,
		otherCalls: 0,
		compactionCalls: 0,
		compactionHistoryCalls: 0,
		compactionTurnPrefixCalls: 0,
		toolCalls: 0,
		modelSwitchSucceeded: false,
		startupEntered: startupEntered.resolve,
		startupGate: startupGate.promise,
		shutdownEntered: shutdownEntered.resolve,
		shutdownGate: shutdownGate.promise,
		requestSettled: false,
	};
	const stateKey = `slate-worker-opening-contract:${process.pid}:${Date.now()}:${Math.random()}`;
	const symbol = Symbol.for(stateKey);
	(globalThis as Record<symbol, unknown>)[symbol] = state;
	const extension = join(root, "paused-worker-extension.ts");
	writeFileSync(extension, `
import type { ExtensionAPI } from ${JSON.stringify("@earendil-works/pi-coding-agent")};
const state = (globalThis as any)[Symbol.for(${JSON.stringify(stateKey)})];
state.startupEntered();
await state.startupGate;
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    pi.setThinkingLevel("max");
    try { await pi.sendUserMessage("startup request must be refused after teardown"); }
    finally { state.requestSettled = true; }
  });
  pi.on("session_shutdown", async () => {
    state.shutdownEntered();
    await state.shutdownGate;
  });
}
`, "utf8");

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.HOME = home;
	process.env.PI_OFFLINE = "1";
	let manager: ThreadManager | undefined;
	try {
		const modelRuntime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json") });
		modelRuntime.registerNativeProvider(matrixProvider(state, "matrix-primary", "primary"));
		const ctx = {
			cwd: project,
			hasUI: false,
			isProjectTrusted: () => true,
			model: undefined,
			modelRegistry: new ModelRegistry(modelRuntime),
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
		const runtime = createLogicalRuntime({
			trusted: true,
			projectConfig: { router: { models: { include: [], add: [{
				model: "matrix",
				capabilityRating: 50,
				costRating: 50,
				effort: "max",
				preferredProvider: "matrix-primary",
				providers: { "matrix-primary": "primary" },
				guidelines: [],
				cautions: [],
			}] } } },
		});
		manager = new ThreadManager(
			new SlateStore({ appendEntry() {} } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI),
			{},
			() => ({ units: [], paths: [extension], toolNames: [] }),
			runtime,
			{ enabled: true, maxRetries: 0, baseDelayMs: 0 },
		);
		const dispatch = manager.dispatch({ model: "matrix", reason: "opening contract teardown", type: "general", task: "startup race" }, ctx, undefined);
		const dispatchOutcome = dispatch.then(
			() => undefined,
			(error: unknown) => error,
		);
		await within(startupEntered.promise, "the worker extension load to pause");
		const view = manager as unknown as { requestContracts: Map<string, { invalidationSignal: AbortSignal }> };
		assert.equal(view.requestContracts.size, 1, "the request owner is teardown-visible before extension loading finishes");
		const openingContract = [...view.requestContracts.values()][0];
		assert.ok(openingContract);
		let disposeSettled = false;
		const disposal = manager.disposeAll().then(() => { disposeSettled = true; });
		await Promise.resolve();
		assert.equal(openingContract.invalidationSignal.aborted, true, "teardown synchronously invalidates the opening action");
		assert.equal(disposeSettled, false, "teardown waits for the opening worker");
		startupGate.resolve();
		await within(shutdownEntered.promise, "worker shutdown after startup settles", 5_000);
		assert.equal(state.requestSettled, true, "the startup request reaches the installed invalidated contract");
		assert.equal(state.primaryCalls, 0, "the startup request cannot reach the provider after teardown starts");
		assert.equal(disposeSettled, false, "teardown waits for the paused shutdown handler");
		shutdownGate.resolve();
		await within(disposal, "manager teardown to finish", 5_000);
		const dispatchError = await within(dispatchOutcome, "the cancelled dispatch to settle", 5_000);
		assert.ok(dispatchError instanceof Error);
		assert.match(dispatchError.message, /cancelled during session teardown/);
		assert.equal(view.requestContracts.size, 0, "the exact opening request handle is removed");
	} finally {
		startupGate.resolve();
		shutdownGate.resolve();
		if (manager) await manager.disposeAll();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
		delete (globalThis as Record<symbol, unknown>)[symbol];
		rmSync(root, { recursive: true, force: true });
	}
});

async function runWorkerRequestMatrixScenario(scenario: MatrixScenario) {
	const root = mkdtempSync(join(tmpdir(), `slate-worker-matrix-${scenario}-`));
	const project = join(root, "project");
	const agent = join(root, "agent");
	const home = join(root, "home");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(agent, { recursive: true });
	mkdirSync(home, { recursive: true });
	const settings = {
		retry: { enabled: true, maxRetries: scenario === "recovery-effort" || scenario === "recovery-compaction-refusal" ? 1 : 0, baseDelayMs: 0 },
		compaction: scenario === "compaction" || scenario === "compaction-refusal" || scenario === "recovery-compaction-refusal" || scenario === "compaction-then-cancel"
			? { enabled: true, reserveTokens: 50, keepRecentTokens: 20 }
			: { enabled: false },
	};
	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify(settings));
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
	const secondRequestEntered = deferred();
	const secondRequestGate = deferred();
	const startupOpenGate = deferred();
	const startupFailureEntered = deferred();
	const startupToolEventEntered = deferred();
	const startupToolEventGate = deferred();
	const ordinaryRequestEntered = deferred();
	const ordinaryRequestGate = deferred();
	const postCompactionEntered = deferred();
	const postCompactionGate = deferred();
	const cancelController = new AbortController();
	const state: MatrixState = {
		scenario,
		compactionEvents: [],
		startupRunEnded: false,
		startupRequestSettled: false,
		startupWorkCompleted: false,
		independentStartupFailure: false,
		...(scenario === "startup-teardown-completed-tool" ? {
			secondRequestEntered: secondRequestEntered.resolve,
			secondRequestGate: secondRequestGate.promise,
			startupOpenGate: startupOpenGate.promise,
			recursiveAttempts: 0,
			shutdowns: 0,
		} : {}),
		...(scenario === "startup-caller-cancel-completed-tool" ? {
			startupOpenGate: startupOpenGate.promise,
			startupToolEventEntered: startupToolEventEntered.resolve,
			startupToolEventGate: startupToolEventGate.promise,
		} : {}),
		...(scenario === "startup-caller-cancel-no-fact" || scenario === "startup-caller-cancel-fact-and-failure" ? {
			startupFailureEntered: startupFailureEntered.resolve,
			startupOpenGate: startupOpenGate.promise,
			shutdowns: 0,
			...(scenario === "startup-caller-cancel-fact-and-failure" ? {
				startupToolEventEntered: startupToolEventEntered.resolve,
				startupToolEventGate: startupToolEventGate.promise,
			} : {}),
		} : {}),
		...(scenario === "startup-assistant-then-ordinary-success" ? {
			ordinaryRequestEntered: ordinaryRequestEntered.resolve,
			ordinaryRequestGate: ordinaryRequestGate.promise,
		} : {}),
		...(scenario === "compaction-then-cancel" ? {
			postCompactionEntered: postCompactionEntered.resolve,
			postCompactionGate: postCompactionGate.promise,
		} : {}),
		primaryCalls: 0,
		fallbackCalls: 0,
		otherCalls: 0,
		compactionCalls: 0,
		compactionHistoryCalls: 0,
		compactionTurnPrefixCalls: 0,
		toolCalls: 0,
		modelSwitchSucceeded: false,
	};
	const stateKey = `slate-worker-matrix:${process.pid}:${Date.now()}:${Math.random()}`;
	const symbol = Symbol.for(stateKey);
	(globalThis as Record<symbol, unknown>)[symbol] = state;
	const hostile = join(root, "matrix-worker-extension.ts");
	writeFileSync(hostile, `
import type { ExtensionAPI } from ${JSON.stringify("@earendil-works/pi-coding-agent")};
const state = (globalThis as any)[Symbol.for(${JSON.stringify(stateKey)})];
export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", (event) => {
    state.compactionEvents.push({ phase: "start", reason: event.reason, willRetry: event.willRetry });
  });
  pi.on("session_compact", (event) => {
    state.compactionEvents.push({ phase: "success", reason: event.reason, willRetry: event.willRetry });
  });
  if (state.scenario === "startup-assistant-then-command-error") {
    pi.registerCommand("boom", {
      description: "Throw one attributed command failure.",
      handler() { throw new Error("matrix command exploded"); },
    });
  }
  pi.registerTool({
    name: "host_probe", label: "host_probe", description: "Return one retained matrix marker.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      state.toolCalls += 1;
      const text = state.scenario === "compaction" || state.scenario === "compaction-refusal" || state.scenario === "recovery-compaction-refusal" || state.scenario === "compaction-then-cancel" ? "retained ".repeat(12000) : "retained matrix tool result";
      return { content: [{ type: "text", text }], details: {} };
    },
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (state.scenario === "preflight-effort") pi.setThinkingLevel("low");
    if (state.scenario === "preflight-model" || state.scenario === "preflight-provider") {
      if (!ctx.model) throw new Error("matrix live model is missing");
      const provider = state.scenario === "preflight-provider" ? "matrix-other" : "matrix-primary";
      Object.assign(ctx.model, { provider, id: "other", name: "other" });
      state.modelSwitchSucceeded = ctx.model.provider === provider && ctx.model.id === "other";
    }
    if (state.scenario === "recovery-effort" && event.prompt.includes("previous attempt was interrupted")) pi.setThinkingLevel("low");
  });
  pi.on("tool_result", () => {
    if (state.scenario === "later-effort") pi.setThinkingLevel("low");
  });
  // PF-T9R6-1 and TQ-T9R6-1: keep the original 4000 ms deadline, and clear the
  // losing timer so that it cannot hold this process open after the race settles.
  async function settleStartupRun(send: () => void) {
    const ended = new Promise((resolve) => { state.resolveStartupRun = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      send();
      await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, 4000); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  pi.on("session_start", async () => {
    if (state.scenario === "startup-assistant-then-command-error" || state.scenario === "startup-assistant-then-ordinary-success") {
      pi.setThinkingLevel("max");
      await settleStartupRun(() => { pi.sendUserMessage("accepted startup assistant fact"); });
      return;
    }
    if (state.scenario === "startup-teardown-completed-tool" || state.scenario === "startup-caller-cancel-completed-tool") {
      pi.setThinkingLevel("max");
      pi.sendUserMessage("startup work that teardown must settle");
      await state.startupOpenGate;
      return;
    }
    if (state.scenario === "startup-caller-cancel-no-fact") {
      state.startupFailureEntered();
      await state.startupOpenGate;
      throw new Error("later startup failure");
    }
    if (state.scenario === "startup-caller-cancel-fact-and-failure") {
      state.startupFailureEntered();
      pi.setThinkingLevel("max");
      pi.sendUserMessage("startup work before later failure");
      await state.startupOpenGate;
      throw new Error("later startup failure");
    }
    if (state.scenario === "startup-refusal") {
      // A trusted worker extension sends a drifted request from session_start. The
      // manager has no event subscriber yet, so only the request owner observes it.
      pi.setThinkingLevel("low");
      await settleStartupRun(() => { pi.sendUserMessage("this startup request must be refused"); });
      state.startupRequestSettled = true;
      return;
    }
    if (state.scenario !== "startup-accepted-then-refused" && state.scenario !== "startup-rejected-open") return;
    // The same trusted extension first completes one accepted startup request. It
    // runs one tool and answers, and only then sends a drifted second request.
    pi.setThinkingLevel("max");
    await settleStartupRun(() => { pi.sendUserMessage("accepted startup work"); });
    state.startupWorkCompleted = state.toolCalls === 1;
    pi.setThinkingLevel("low");
    await settleStartupRun(() => { pi.sendUserMessage("this drifted startup request must be refused"); });
    state.startupRequestSettled = true;
  });
  pi.on("session_start", async () => {
    if (state.scenario !== "startup-rejected-open") return;
    // An independent startup handler fails after the refusal. Pi reports each
    // handler error separately, so worker opening rejects with this error.
    state.independentStartupFailure = true;
    throw new Error("independent startup handler failed");
  });
  pi.on("tool_execution_end", async () => {
    if (state.scenario !== "startup-caller-cancel-completed-tool" && state.scenario !== "startup-caller-cancel-fact-and-failure") return;
    state.startupWorkCompleted = true;
    state.startupToolEventEntered();
    await state.startupToolEventGate;
  });
  pi.on("agent_settled", () => {
    if (state.scenario !== "startup-teardown-completed-tool") return;
    state.recursiveAttempts += 1;
    pi.sendUserMessage("post-closure recursive request must not reach Pi");
  });
  pi.on("session_shutdown", () => {
    if (state.scenario !== "startup-teardown-completed-tool" && state.scenario !== "startup-caller-cancel-no-fact" && state.scenario !== "startup-caller-cancel-fact-and-failure") return;
    state.shutdowns += 1;
    throw new Error("independent shutdown cleanup failed");
  });
  pi.on("agent_end", () => {
    if (state.scenario === "startup-refusal" || state.scenario === "startup-accepted-then-refused" || state.scenario === "startup-rejected-open" || state.scenario === "startup-assistant-then-command-error" || state.scenario === "startup-assistant-then-ordinary-success") {
      if (state.resolveStartupRun) {
        state.startupRunEnded = true;
        state.resolveStartupRun();
        state.resolveStartupRun = undefined;
      }
      return;
    }
    if (state.scenario === "compaction-refusal") pi.setThinkingLevel("low");
    // Lower the effort only after the accepted fallback answer, so Pi's own retry
    // on the primary route and the recovery request itself stay correct.
    if (state.scenario === "recovery-compaction-refusal" && state.fallbackCalls > 0) pi.setThinkingLevel("low");
  });
}
`, "utf8");

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.HOME = home;
	process.env.PI_OFFLINE = "1";
	// TQ-T9R5-2: the manager must be reachable from the cleanup block, so a rejected
	// or timed-out dispatch also releases its worker before the fixture disappears.
	let manager: ThreadManager | undefined;
	try {
		const modelRuntime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json") });
		modelRuntime.registerNativeProvider(matrixProvider(state, "matrix-primary", "primary"));
		modelRuntime.registerNativeProvider(matrixProvider(state, "matrix-fallback", "fallback"));
		modelRuntime.registerNativeProvider(matrixProvider(state, "matrix-other", "other"));
		const modelRegistry = new ModelRegistry(modelRuntime);
		const ctx = {
			cwd: project,
			hasUI: false,
			isProjectTrusted: () => true,
			model: undefined,
			modelRegistry,
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
		const runtime = createLogicalRuntime({
			trusted: true,
			projectConfig: { router: { models: { include: [], add: [{
				model: "matrix",
				capabilityRating: 50,
				costRating: 50,
				effort: "max",
				preferredProvider: "matrix-primary",
				providers: { "matrix-primary": "primary", "matrix-fallback": "fallback" },
				guidelines: [],
				cautions: [],
			}] } } },
		});
		const snapshots: unknown[] = [];
		const store = new SlateStore({
			appendEntry(_customType: string, data: unknown) { snapshots.push(structuredClone(data)); },
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
		manager = new ThreadManager(
			store,
			{},
			() => ({ units: [], paths: [hostile], toolNames: ["host_probe"] }),
			runtime,
			{ enabled: true, maxRetries: 0, baseDelayMs: 0 },
		);
		const dispatch = manager.dispatch(
			{
				model: "matrix",
				reason: `real Pi ${scenario}`,
				type: "general",
				task: scenario === "startup-assistant-then-command-error"
					? "/boom"
					: scenario === "startup-assistant-then-ordinary-success"
						? "ordinary action after startup"
						: `run ${scenario}`,
			},
			ctx,
			scenario === "compaction-then-cancel" || scenario === "startup-caller-cancel-completed-tool" || scenario === "startup-caller-cancel-no-fact" || scenario === "startup-caller-cancel-fact-and-failure"
				? cancelController.signal
				: undefined,
		);
		let dispatchSettled = false;
		void dispatch.then(
			() => { dispatchSettled = true; },
			() => { dispatchSettled = true; },
		);
		let result;
		const installDisposalFailure = async () => {
			await waitUntil(() => (manager as unknown as { live: Map<string, { dispose?: () => void }> }).live.size === 1, "the live worker before disposal injection");
			const live = [...(manager as unknown as { live: Map<string, { dispose?: () => void }> }).live.values()][0];
			assert.ok(live);
			live.dispose = () => { throw new Error("independent disposal cleanup failed"); };
		};
		if (scenario === "startup-teardown-completed-tool") {
			await within(secondRequestEntered.promise, "the admitted startup continuation after its completed tool", 5_000);
			let teardownSettled = false;
			const teardown = manager.disposeAll().then(() => { teardownSettled = true; });
			await Promise.resolve();
			assert.equal(teardownSettled, false, "manager teardown waits for admitted startup work and persistence");
			secondRequestGate.resolve();
			startupOpenGate.resolve();
			result = await within(dispatch, `${scenario} production ThreadManager dispatch`, 8_000);
			await within(teardown, "manager teardown after durable startup retention", 5_000);
		} else if (scenario === "startup-assistant-then-ordinary-success") {
			await within(ordinaryRequestEntered.promise, "the ordinary provider request after startup completion", 5_000);
			assert.equal(state.startupRunEnded, true, "the startup operation ends before the ordinary provider request starts");
			await Promise.resolve();
			assert.equal(dispatchSettled, false, "completed startup output cannot settle the action while the ordinary response is gated");
			ordinaryRequestGate.resolve();
			result = await within(dispatch, `${scenario} production ThreadManager dispatch`, 8_000);
			await manager.disposeAll();
		} else if (scenario === "startup-caller-cancel-completed-tool") {
			await within(startupToolEventEntered.promise, "the completed startup tool event before caller cancellation", 5_000);
			cancelController.abort();
			startupToolEventGate.resolve();
			startupOpenGate.resolve();
			result = await within(dispatch, `${scenario} production ThreadManager dispatch`, 8_000);
			await manager.disposeAll();
		} else if (scenario === "startup-caller-cancel-no-fact") {
			await within(startupFailureEntered.promise, "the no-fact startup failure barrier", 5_000);
			await installDisposalFailure();
			cancelController.abort();
			startupOpenGate.resolve();
			let rejectedError: unknown;
			try {
				await within(dispatch, `${scenario} production ThreadManager dispatch`, 8_000);
			} catch (error) {
				rejectedError = error;
			}
			assert.ok(rejectedError instanceof Error, "the no-fact cancellation must reject the caller");
			await manager.disposeAll();
			const episodeDir = join(project, ".pi", "slate", store.runtimeFolder, "episodes");
			const episodeFileCount = existsSync(episodeDir)
				? readdirSync(episodeDir).filter((name) => name.endsWith(".md")).length
				: 0;
			const restored = new SlateStore({ appendEntry() {} } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const durableSnapshot = snapshots.at(-1);
			assert.ok(durableSnapshot, `${scenario}: a final durable snapshot exists`);
			restored.adoptSnapshot(durableSnapshot as Parameters<SlateStore["adoptSnapshot"]>[0], ctx);
			const transcriptDir = join(project, ".pi", "slate", store.runtimeFolder, "threads");
			const transcript = readdirSync(transcriptDir)
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => readFileSync(join(transcriptDir, name), "utf8"))
				.join("\n");
			return {
				result: undefined as never,
				rejectedError: rejectedError as Error,
				state,
				restored,
				transcript,
				snapshotCount: snapshots.length,
				episodeFileCount,
				episodeBytes: undefined as never,
				laterPrompt: undefined as never,
			};
		} else if (scenario === "startup-caller-cancel-fact-and-failure") {
			await within(startupToolEventEntered.promise, "the completed startup tool before the later startup failure", 5_000);
			await installDisposalFailure();
			cancelController.abort();
			startupToolEventGate.resolve();
			startupOpenGate.resolve();
			result = await within(dispatch, `${scenario} production ThreadManager dispatch`, 8_000);
			await manager.disposeAll();
		} else if (scenario === "compaction-then-cancel") {
			await within(postCompactionEntered.promise, "the continuation that follows a successful history rewrite", 6_000);
			assert.equal(state.compactionCalls, 2, "history and turn-prefix rewrites must both succeed before the cancellation");
			assert.equal(state.compactionHistoryCalls, 1, "exactly one history rewrite request must precede the cancellation");
			assert.equal(state.compactionTurnPrefixCalls, 1, "exactly one turn-prefix rewrite request must precede the cancellation");
			assert.deepEqual(state.compactionEvents, [
				{ phase: "start", reason: "overflow", willRetry: true },
				{ phase: "success", reason: "overflow", willRetry: true },
			], "Pi must finish overflow compaction before the caller cancels its continuation");
			cancelController.abort();
			postCompactionGate.resolve();
			result = await within(dispatch, `${scenario} production ThreadManager dispatch`, 8_000);
			await manager.disposeAll();
		} else {
			result = await within(dispatch, `${scenario} production ThreadManager dispatch`, 8_000);
			await manager.disposeAll();
		}

		assert.ok(result, `${scenario}: a resolved matrix result exists`);
		if (scenario === "compaction" || scenario === "compaction-then-cancel") {
			assert.deepEqual(state.compactionEvents, [
				{ phase: "start", reason: "overflow", willRetry: true },
				{ phase: "success", reason: "overflow", willRetry: true },
			], `${scenario}: only the scripted overflow causes a successful retrying compaction`);
		} else if (scenario === "compaction-refusal" || scenario === "recovery-compaction-refusal") {
			assert.deepEqual(state.compactionEvents, [
				{ phase: "start", reason: "overflow", willRetry: true },
			], `${scenario}: overflow compaction starts but the contract prevents its completion`);
		}

		const episodeBytes = readFileSync(result.episode.file, "utf8");
		assert.equal(episodeBytes, result.episodeText, `${scenario}: D1 exact episode bytes`);
		const episodeFileCount = readdirSync(join(project, ".pi", "slate", store.runtimeFolder, "episodes")).filter((name) => name.endsWith(".md")).length;
		const restored = new SlateStore({ appendEntry() {} } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
		const durableSnapshot = snapshots.at(-1);
		assert.ok(durableSnapshot, `${scenario}: a final durable snapshot exists`);
		restored.adoptSnapshot(durableSnapshot as Parameters<SlateStore["adoptSnapshot"]>[0], ctx);
		assert.equal(restored.threads.get(result.thread.id)?.episodeId, result.episode.id, `${scenario}: D2 restored thread reference`);
		assert.equal(restored.episodes.get(result.episode.id)?.file, result.episode.file, `${scenario}: D2 restored file identity`);
		let episodeTool: { execute(...args: unknown[]): Promise<{ content: Array<{ type: string; text?: string }> }> } | undefined;
		registerSlateTools(
			{ registerTool(tool: { name: string }) { if (tool.name === "episode") episodeTool = tool as unknown as typeof episodeTool; } } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
			restored,
			() => manager!,
		);
		assert.ok(episodeTool, `${scenario}: production episode tool registered`);
		const fetched = await episodeTool.execute("call", { id: result.episode.id }, undefined, undefined, ctx);
		assert.equal(fetched.content[0]?.text, episodeBytes, `${scenario}: D3 episode tool bytes`);
		const later = new ThreadManager(restored, {}, undefined, runtime);
		const laterPrompt = (later as unknown as { buildPrompt(opts: { task: string; contextEpisodeIds: string[] }, cwd: string): string })
			.buildPrompt({ task: "later durable consumer", contextEpisodeIds: [result.episode.id] }, project);
		assert.match(laterPrompt, new RegExp(result.episode.id.replace(".", "\\.")), `${scenario}: D4 later context episode identity`);
		assert.match(laterPrompt, /later durable consumer/, `${scenario}: D4 later action text`);

		const transcriptDir = join(project, ".pi", "slate", store.runtimeFolder, "threads");
		const transcript = readdirSync(transcriptDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => readFileSync(join(transcriptDir, name), "utf8"))
			.join("\n");
		return { result, rejectedError: undefined as Error | undefined, state, transcript, episodeBytes, laterPrompt, restored, snapshotCount: snapshots.length, episodeFileCount };
	} finally {
		secondRequestGate.resolve();
		startupOpenGate.resolve();
		startupToolEventGate.resolve();
		ordinaryRequestGate.resolve();
		postCompactionGate.resolve();
		if (manager) await manager.disposeAll();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
		delete (globalThis as Record<symbol, unknown>)[symbol];
		rmSync(root, { recursive: true, force: true });
	}
}

test("production ThreadManager and real Pi workers guard preflight, later-turn, recovery, and compaction requests", { timeout: 60_000 }, async (t) => {
	await t.test("hostile before_agent_start effort drift blocks the initial provider call and leaves final attribution absent", { timeout: 10_000 }, async () => {
		const { result, state } = await runWorkerRequestMatrixScenario("preflight-effort");
		assert.equal(state.primaryCalls, 0);
		assert.equal(state.otherCalls, 0);
		assert.equal(result.episode.requestedModel, "matrix-primary/primary");
		assert.equal(result.episode.model, undefined);
		assert.equal(result.episode.effort, undefined);
		assert.match(result.episodeText, /Slate route contract violation/);
		assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: "Slate route contract violation." } as never), false);
	});

	await t.test("a real same-provider model switch after capture is rejected with no final attribution", { timeout: 10_000 }, async () => {
		const { result, state } = await runWorkerRequestMatrixScenario("preflight-model");
		assert.equal(state.modelSwitchSucceeded, true, "the real Pi hook must mutate the live physical model before this test can prove the guard");
		assert.equal(state.primaryCalls, 0);
		assert.equal(state.otherCalls, 0, "the switched model must not reach its provider adapter");
		assert.equal(result.episode.requestedModel, "matrix-primary/primary");
		assert.equal(result.episode.model, undefined);
		assert.equal(result.episode.effort, undefined);
		assert.match(result.episodeText, /Slate route contract violation/);
		assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: "Slate route contract violation." } as never), false);
	});

	await t.test("a real cross-provider model switch after capture is rejected with no final attribution", { timeout: 10_000 }, async () => {
		const { result, state } = await runWorkerRequestMatrixScenario("preflight-provider");
		assert.equal(state.modelSwitchSucceeded, true, "the real Pi hook must mutate the live physical provider before this test can prove the guard");
		assert.equal(state.primaryCalls, 0);
		assert.equal(state.otherCalls, 0, "the switched provider must not receive a request");
		assert.equal(result.episode.model, undefined);
		assert.equal(result.episode.effort, undefined);
		assert.match(result.episodeText, /Slate route contract violation/);
	});

	await t.test("tool-result effort drift blocks the later turn and retains the completed tool result", { timeout: 10_000 }, async () => {
		const { result, state, transcript, episodeBytes, laterPrompt, restored } = await runWorkerRequestMatrixScenario("later-effort");
		assert.equal(state.primaryCalls, 1, "the blocked later request must not reach the provider");
		assert.equal(state.toolCalls, 1);
		assert.match(transcript, /retained matrix tool result/);
		assert.match(transcript, /Slate route contract violation/);
		assert.equal(result.episode.model, "matrix-primary/primary");
		assert.equal(result.episode.effort, "max");
		assert.notEqual(result.episode.model, "matrix-other/other");
		// T12: the retained tool fact and the accepted pair reach the durable bytes,
		// the restored snapshot and one later action's prompt.
		assert.equal(
			episodeBytes.match(/\[completed tool result: host_probe\]/g)?.length,
			1,
			"the stable record supplies the retained tool fact once",
		);
		assert.match(episodeBytes, /retained matrix tool result/);
		assert.match(episodeBytes, /Slate route contract violation/);
		assert.match(episodeBytes, /ran: matrix-primary\/primary @ max/);
		assert.match(laterPrompt, /retained matrix tool result/);
		assert.match(laterPrompt, /Slate route contract violation/);
		assert.match(laterPrompt, /ran: matrix-primary\/primary @ max/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredEpisode?.logicalModel, "matrix");
		assert.equal(restoredEpisode?.requestedModel, "matrix-primary/primary");
		assert.equal(restoredEpisode?.requestedEffort, "max");
		assert.equal(restoredEpisode?.model, "matrix-primary/primary");
		assert.equal(restoredEpisode?.effort, "max");
		assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /Slate route contract violation/);
	});

	await t.test("recovery-nudge effort drift blocks fallback transport and preserves initial accepted attribution", { timeout: 10_000 }, async () => {
		const { result, state, transcript } = await runWorkerRequestMatrixScenario("recovery-effort");
		assert.equal(state.primaryCalls, 2, "Pi performs its configured same-route retry before Slate recovery");
		assert.equal(state.fallbackCalls, 0, "the mismatched recovery request must not reach the fallback provider");
		assert.match(transcript, /Slate route contract violation/);
		assert.equal(result.episode.requestedModel, "matrix-primary/primary");
		assert.equal(result.episode.model, "matrix-primary/primary");
		assert.equal(result.episode.effort, "max");
	});

	await t.test("actual Pi worker auto-compaction crosses the request contract and keeps accepted identity", { timeout: 10_000 }, async () => {
		const { result, state, transcript, episodeBytes, restored } = await runWorkerRequestMatrixScenario("compaction");
		assert.equal(state.compactionCalls, 2, "history and turn-prefix summarization requests must reach the fake provider");
		assert.equal(state.compactionHistoryCalls, 1, "exactly one history summarization request must reach the fake provider");
		assert.equal(state.compactionTurnPrefixCalls, 1, "exactly one turn-prefix summarization request must reach the fake provider");
		assert.equal(state.primaryCalls, 5, "tool turn, overflow, two compaction summaries, and retry are distinct accepted provider calls");
		assert.match(transcript, /\"type\":\"compaction\"/);
		assert.match(transcript, /matrix history summary/);
		assert.match(transcript, /matrix turn prefix summary/);
		assert.equal(result.episode.model, "matrix-primary/primary");
		assert.equal(result.episode.effort, "max");
		// T8: the ordinary successful outcome and its successful format are unchanged,
		// and every durable consumer reports the same success.
		assert.equal(result.episode.status, "ok");
		assert.equal(result.thread.status, "successful");
		assert.equal(result.thread.outcomeReason, undefined);
		assert.match(episodeBytes, /STATUS: OK/);
		assert.doesNotMatch(episodeBytes, /> failure:/);
		assert.doesNotMatch(episodeBytes, /Slate route contract violation/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "ok");
		assert.equal(restoredEpisode?.model, "matrix-primary/primary");
		assert.equal(restoredEpisode?.effort, "max");
		assert.equal(restored.threads.get(result.thread.id)?.status, "successful");
	});

	await t.test("a successful history rewrite keeps the pre-rewrite fact durable when the caller cancels afterwards", { timeout: 15_000 }, async () => {
		const { result, state, transcript, episodeBytes, laterPrompt, restored, episodeFileCount } =
			await runWorkerRequestMatrixScenario("compaction-then-cancel");
		// T13: the rewrite really happened, and only then did the caller cancel.
		assert.equal(state.compactionCalls, 2, "history and turn-prefix rewrites must reach the fake provider");
		assert.equal(state.compactionHistoryCalls, 1, "exactly one history rewrite request must reach the fake provider");
		assert.equal(state.compactionTurnPrefixCalls, 1, "exactly one turn-prefix rewrite request must reach the fake provider");
		assert.equal(state.primaryCalls, 5, "tool turn, overflow, two compaction rewrites, and the cancelled continuation");
		assert.equal(state.toolCalls, 1);
		assert.equal(state.fallbackCalls, 0, "a cancellation starts no recovery and no replay");
		assert.equal(state.otherCalls, 0);
		assert.match(transcript, /\"type\":\"compaction\"/);
		assert.match(transcript, /matrix history summary/);
		assert.match(transcript, /matrix turn prefix summary/);
		assert.equal(episodeFileCount, 1);
		assert.equal(result.episode.status, "failed");
		assert.equal(result.thread.status, "failed");
		// The pre-rewrite tool fact survives in the stable record, and the terminal
		// cause is the cancellation.
		assert.equal(
			episodeBytes.match(/\[completed tool result: host_probe\]/g)?.length,
			1,
			"the pre-rewrite fact is retained once after the history rewrite",
		);
		assert.match(episodeBytes, /retained retained/);
		assert.match(episodeBytes, /worker action was cancelled/);
		assert.doesNotMatch(episodeBytes, /Slate route contract violation/);
		assert.match(laterPrompt, /retained retained/);
		assert.match(laterPrompt, /worker action was cancelled/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredEpisode?.logicalModel, "matrix");
		assert.equal(restoredEpisode?.requestedModel, "matrix-primary/primary");
		assert.equal(restoredEpisode?.requestedEffort, "max");
		assert.equal(restoredEpisode?.model, "matrix-primary/primary");
		assert.equal(restoredEpisode?.effort, "max");
		assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /worker action was cancelled/);
	});

	await t.test("a contract-refused automatic compaction is a visible failure with retained work and attribution", { timeout: 10_000 }, async () => {
		const { result, state, transcript } = await runWorkerRequestMatrixScenario("compaction-refusal");
		assert.equal(state.primaryCalls, 2, "the tool turn and overflow happen before the refused compaction");
		assert.equal(state.compactionCalls, 0, "the refused compaction cannot reach the provider");
		assert.equal(state.fallbackCalls, 0, "the refusal cannot start logical recovery or replay");
		assert.equal(state.toolCalls, 1);
		assert.match(transcript, /retained retained/);
		assert.equal(result.episode.status, "failed");
		assert.equal(result.episode.model, "matrix-primary/primary");
		assert.equal(result.episode.effort, "max");
		assert.ok(result.warnings.some((warning) => warning.includes("Slate route contract violation.")), result.warnings.join("\n"));
		assert.match(result.episodeText, /Slate route contract violation/);
	});

	await t.test("ordinary success after startup assistant output owns the action result", { timeout: 15_000 }, async () => {
		const { result, state, transcript, episodeBytes, laterPrompt, restored } =
			await runWorkerRequestMatrixScenario("startup-assistant-then-ordinary-success");
		assert.equal(state.startupRunEnded, true);
		assert.equal(state.primaryCalls, 2, "the completed startup request and later ordinary request each reach Pi once");
		assert.equal(state.fallbackCalls, 0);
		assert.equal(state.otherCalls, 0);
		assert.equal(result.episode.status, "ok", "the ordinary assistant response classifies the action");
		assert.equal(result.thread.status, "successful");
		assert.equal(result.thread.outcomeReason, undefined);
		assert.match(transcript, /startup completed fact/);
		assert.match(transcript, /ordinary action success/);
		assert.match(episodeBytes, /STATUS: OK/);
		assert.match(episodeBytes, /startup completed fact/, "startup output remains a completed fact");
		assert.match(episodeBytes, /ordinary action success/, "the ordinary success remains the action response");
		assert.doesNotMatch(episodeBytes, /> failure:/);
		assert.match(laterPrompt, /startup completed fact/);
		assert.match(laterPrompt, /ordinary action success/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "ok");
		assert.equal(restored.threads.get(result.thread.id)?.status, "successful");
	});

	await t.test("startup assistant output cannot turn a throwing no-response slash command into success", { timeout: 15_000 }, async () => {
		const { result, state, episodeBytes, laterPrompt, restored } =
			await runWorkerRequestMatrixScenario("startup-assistant-then-command-error");
		assert.equal(state.primaryCalls, 1, "only the accepted startup assistant request reaches Pi");
		assert.equal(state.fallbackCalls, 0);
		assert.equal(state.otherCalls, 0);
		assert.equal(result.episode.status, "failed");
		assert.equal(result.thread.status, "failed");
		assert.match(result.thread.outcomeReason ?? "", /worker produced no assistant message/);
		assert.match(result.thread.outcomeReason ?? "", /command:boom.*command.*matrix command exploded/);
		assert.match(episodeBytes, /\[final assistant text, stop reason=stop\]/);
		assert.match(episodeBytes, /matrix done/);
		assert.match(episodeBytes, /matrix command exploded/);
		assert.match(episodeBytes, /ran: matrix-primary\/primary @ max/);
		assert.doesNotMatch(episodeBytes, /STATUS: OK/);
		assert.match(laterPrompt, /matrix done/);
		assert.match(laterPrompt, /matrix command exploded/);
		assert.match(laterPrompt, /ran: matrix-primary\/primary @ max/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredEpisode?.logicalModel, "matrix");
		assert.equal(restoredEpisode?.requestedModel, "matrix-primary/primary");
		assert.equal(restoredEpisode?.requestedEffort, "max");
		assert.equal(restoredEpisode?.model, "matrix-primary/primary");
		assert.equal(restoredEpisode?.effort, "max");
		assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /matrix command exploded/);
	});

	await t.test("caller cancellation during startup retains the completed tool and stops the next request", { timeout: 15_000 }, async () => {
		const { result, state, episodeBytes, laterPrompt, restored, snapshotCount, episodeFileCount } =
			await runWorkerRequestMatrixScenario("startup-caller-cancel-completed-tool");
		assert.equal(state.startupWorkCompleted, true);
		assert.equal(state.primaryCalls, 1, "caller cancellation prevents the post-tool provider request");
		assert.equal(state.toolCalls, 1);
		assert.equal(state.fallbackCalls, 0);
		assert.equal(state.otherCalls, 0);
		assert.equal(snapshotCount, 3, "queued creation, running admission, and final durable outcome each save once");
		assert.equal(episodeFileCount, 1);
		assert.equal(result.episode.status, "failed");
		assert.equal(result.thread.status, "failed");
		assert.match(result.thread.outcomeReason ?? "", /cancelled by the caller/);
		assert.match(episodeBytes, /retained matrix tool result/);
		assert.match(episodeBytes, /cancelled by the caller/);
		assert.doesNotMatch(episodeBytes, /Slate route contract violation/);
		assert.match(laterPrompt, /retained matrix tool result/);
		assert.match(laterPrompt, /cancelled by the caller/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredEpisode?.logicalModel, "matrix");
		assert.equal(restoredEpisode?.requestedModel, "matrix-primary/primary");
		assert.equal(restoredEpisode?.requestedEffort, "max");
		assert.equal(restoredEpisode?.model, "matrix-primary/primary");
		assert.equal(restoredEpisode?.effort, "max");
		assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /cancelled by the caller/);
	});

	await t.test("caller cancellation before later startup failure rejects with every cleanup cause and no episode", { timeout: 15_000 }, async () => {
		const { rejectedError, state, restored, snapshotCount, episodeFileCount } =
			await runWorkerRequestMatrixScenario("startup-caller-cancel-no-fact");
		assert.ok(rejectedError instanceof Error);
		assert.equal(state.primaryCalls, 0, "cancellation prevents the startup failure handler from reaching a provider");
		assert.equal(state.toolCalls, 0);
		assert.equal(state.shutdowns, 1, "shutdown runs once after the rejected no-fact result");
		assert.equal(snapshotCount, 3, "queued creation, running admission, and cancelled terminal state each save once");
		assert.equal(episodeFileCount, 0, "no episode file is written without a completed fact");
		assert.equal(restored.episodes.size, 0);
		assert.equal(restored.threads.get("t1")?.status, "cancelled");
		assert.equal(restored.threads.get("t1")?.episodeId, undefined);
		assert.match(rejectedError.message, /cancelled by the caller/);
		for (const detail of ["later startup failure", "independent shutdown cleanup failed", "independent disposal cleanup failed"]) {
			assert.equal(rejectedError.message.match(new RegExp(detail, "g"))?.length, 1, detail);
		}
	});

	await t.test("caller cancellation before later startup failure retains real startup facts and separate cleanup warnings", { timeout: 15_000 }, async () => {
		const { result, state, episodeBytes, laterPrompt, restored, episodeFileCount } =
			await runWorkerRequestMatrixScenario("startup-caller-cancel-fact-and-failure");
		assert.equal(state.startupWorkCompleted, true);
		assert.equal(state.primaryCalls, 1, "the completed startup tool is the only provider request");
		assert.equal(state.toolCalls, 1);
		assert.equal(state.shutdowns, 1);
		assert.equal(episodeFileCount, 1);
		assert.equal(result.episode.status, "failed");
		assert.match(result.thread.outcomeReason ?? "", /cancelled by the caller/);
		assert.match(episodeBytes, /retained matrix tool result/);
		assert.match(episodeBytes, /cancelled by the caller/);
		assert.doesNotMatch(episodeBytes, /later startup failure|independent shutdown cleanup failed|independent disposal cleanup failed/);
		for (const detail of ["later startup failure", "independent shutdown cleanup failed", "independent disposal cleanup failed"]) {
			assert.equal(result.warnings.join("\n").match(new RegExp(detail, "g"))?.length, 1, detail);
		}
		assert.match(laterPrompt, /retained matrix tool result/);
		assert.match(laterPrompt, /cancelled by the caller/);
		assert.equal(restored.episodes.get(result.episode.id)?.status, "failed");
		assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /cancelled by the caller/);
	});

	await t.test("a refused session_start request ends the action before any ordinary request", { timeout: 15_000 }, async () => {
		const { result, state, transcript } = await runWorkerRequestMatrixScenario("startup-refusal");
		assert.equal(state.startupRunEnded, true, "the refused startup run must end before the action prompt would start");
		assert.equal(state.startupRequestSettled, true);
		assert.equal(state.primaryCalls, 0, "no ordinary request follows the refused startup request");
		assert.equal(state.otherCalls, 0, "no substitute provider receives a request");
		assert.equal(state.fallbackCalls, 0, "a startup refusal starts no logical recovery and no replay");
		assert.equal(state.compactionCalls, 0);
		assert.equal(result.episode.status, "failed", "the refusal is a visible failure");
		assert.equal(result.thread.status, "failed");
		assert.ok(result.warnings.some((warning) => warning.includes("Slate route contract violation.")), result.warnings.join("\n"));
		assert.match(result.episodeText, /Slate route contract violation/);
		assert.match(transcript, /Slate route contract violation/);
		assert.equal(result.episode.requestedModel, "matrix-primary/primary");
		assert.equal(result.episode.requestedEffort, "max");
		assert.equal(result.episode.model, undefined, "a refused startup request records no final pair");
		assert.equal(result.episode.effort, undefined);
	});

	await t.test("a refused compaction inside a recovery prompt is a visible failure with no replay", { timeout: 15_000 }, async () => {
		const { result, state, transcript, episodeBytes, laterPrompt, restored } = await runWorkerRequestMatrixScenario("recovery-compaction-refusal");
		assert.equal(state.primaryCalls, 2, "Pi performs its configured same-route retry before Slate recovery");
		assert.equal(state.fallbackCalls, 2, "the approved fallback answers once and its follow-up request overflows");
		assert.equal(state.compactionCalls, 0, "the refused recovery compaction cannot reach the provider");
		assert.equal(state.otherCalls, 0);
		assert.equal(state.toolCalls, 1);
		assert.match(transcript, /retained retained/);
		// Pi catches a refused compaction inside its own compaction path, so the worker
		// transcript holds no error message. Slate's own report is the only evidence.
		assert.equal(result.episode.status, "failed", "the successful fallback response cannot overwrite the refusal");
		assert.equal(result.thread.status, "failed");
		assert.ok(result.warnings.some((warning) => warning.includes("Slate route contract violation.")), result.warnings.join("\n"));
		assert.match(result.episodeText, /Slate route contract violation/);
		assert.equal(result.episode.requestedModel, "matrix-primary/primary");
		assert.equal(result.episode.model, "matrix-fallback/fallback", "the accepted recovery request keeps its true attribution");
		assert.equal(result.episode.effort, "max");
		// T12: the retained tool fact and the accepted recovery pair reach the durable
		// bytes, the restored snapshot and one later action's prompt.
		assert.equal(
			episodeBytes.match(/\[completed tool result: host_probe\]/g)?.length,
			1,
			"the stable record supplies the retained tool fact once",
		);
		assert.match(episodeBytes, /retained retained/);
		assert.match(episodeBytes, /ran: matrix-fallback\/fallback @ max/);
		assert.match(laterPrompt, /retained retained/);
		assert.match(laterPrompt, /Slate route contract violation/);
		assert.match(laterPrompt, /ran: matrix-fallback\/fallback @ max/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredEpisode?.requestedModel, "matrix-primary/primary");
		assert.equal(restoredEpisode?.requestedEffort, "max");
		assert.equal(restoredEpisode?.model, "matrix-fallback/fallback");
		assert.equal(restoredEpisode?.effort, "max");
		assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /Slate route contract violation/);
	});

	await t.test("manager teardown during admitted startup work retains the completed tool and rejects recursive post-closure work", { timeout: 15_000 }, async () => {
		const { result, state, episodeBytes, laterPrompt, restored, snapshotCount, episodeFileCount } = await runWorkerRequestMatrixScenario("startup-teardown-completed-tool");
		assert.equal(state.primaryCalls, 2, "only the admitted tool turn and its admitted continuation reach Pi");
		assert.equal(state.toolCalls, 1);
		assert.equal(state.otherCalls, 0);
		assert.equal(state.fallbackCalls, 0);
		assert.ok((state.recursiveAttempts ?? 0) >= 1, "agent_settled attempts one post-closure recursive submission");
		assert.equal(state.shutdowns, 1, "overlapping terminal owners emit shutdown once");
		assert.equal(snapshotCount, 3, "queued creation, running admission, and final durable outcome each save once");
		assert.equal(episodeFileCount, 1, "terminal overlap writes one episode file");
		assert.equal(episodeBytes.match(/bounded completed result was retained/gi)?.length, 1, "one bounded fallback is persisted");
		assert.equal(episodeBytes.match(/retained matrix tool result/g)?.length, 1, "one frozen tool fact is persisted");
		assert.ok(result.warnings.some((warning) => warning.includes("shutdown failed") && warning.includes("independent shutdown cleanup failed")), result.warnings.join("\n"));
		assert.equal(result.episode.status, "failed");
		assert.equal(result.thread.status, "failed");
		assert.match(result.thread.outcomeReason ?? "", /cancelled during session teardown/);
		assert.match(episodeBytes, /retained matrix tool result/);
		assert.match(episodeBytes, /cancelled during session teardown/);
		assert.doesNotMatch(episodeBytes, /Slate route contract violation/);
		assert.match(laterPrompt, /retained matrix tool result/);
		assert.match(laterPrompt, /cancelled during session teardown/);
		// T6: the restored durable snapshot keeps the requested pair, the accepted
		// pair, the logical identity and the terminal cause of that teardown.
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredEpisode?.logicalModel, "matrix");
		assert.equal(restoredEpisode?.requestedModel, "matrix-primary/primary");
		assert.equal(restoredEpisode?.requestedEffort, "max");
		assert.equal(restoredEpisode?.model, "matrix-primary/primary");
		assert.equal(restoredEpisode?.effort, "max");
		assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /cancelled during session teardown/);
		assert.equal(
			episodeBytes.match(/\[completed tool result: host_probe\]/g)?.length,
			1,
			"the stable record supplies the retained startup fact once",
		);
		assert.match(laterPrompt, /ran: matrix-primary\/primary @ max/);
	});

	await t.test("completed startup work and the accepted pair survive a refused later startup request", { timeout: 15_000 }, async () => {
		const { result, state, transcript, episodeBytes, laterPrompt, restored } = await runWorkerRequestMatrixScenario("startup-accepted-then-refused");
		assert.equal(state.startupWorkCompleted, true, "the accepted startup request must complete one real tool call");
		assert.equal(state.startupRunEnded, true);
		assert.equal(state.startupRequestSettled, true);
		assert.equal(state.primaryCalls, 2, "the accepted startup turn and its accepted continuation are the only provider requests");
		assert.equal(state.toolCalls, 1);
		assert.equal(state.otherCalls, 0, "no substitute provider receives a request");
		assert.equal(state.fallbackCalls, 0, "a startup refusal starts no logical recovery and no replay");
		assert.equal(state.compactionCalls, 0);
		assert.equal(result.episode.status, "failed", "the refusal is a visible failure");
		assert.equal(result.thread.status, "failed");
		assert.ok(result.warnings.some((warning) => warning.includes("Slate route contract violation.")), result.warnings.join("\n"));
		assert.match(result.episodeText, /Slate route contract violation/);
		assert.match(result.episodeText, /matrix done/, "the completed startup response stays in the failed episode");
		assert.match(transcript, /retained matrix tool result/);
		assert.equal(result.episode.requestedModel, "matrix-primary/primary");
		assert.equal(result.episode.requestedEffort, "max");
		assert.equal(result.episode.model, "matrix-primary/primary", "the accepted startup request keeps its true attribution");
		assert.equal(result.episode.effort, "max");
		// T10: the completed startup fact, the refusal and the accepted pair reach the
		// durable bytes, the restored snapshot and one later action's prompt.
		assert.equal(
			episodeBytes.match(/\[completed tool result: host_probe\]/g)?.length,
			1,
			"the stable record supplies the retained startup fact once",
		);
		assert.match(episodeBytes, /retained matrix tool result/);
		assert.match(episodeBytes, /ran: matrix-primary\/primary @ max/);
		assert.match(laterPrompt, /retained matrix tool result/);
		assert.match(laterPrompt, /matrix done/);
		assert.match(laterPrompt, /Slate route contract violation/);
		assert.match(laterPrompt, /ran: matrix-primary\/primary @ max/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredEpisode?.logicalModel, "matrix");
		assert.equal(restoredEpisode?.requestedModel, "matrix-primary/primary");
		assert.equal(restoredEpisode?.requestedEffort, "max");
		assert.equal(restoredEpisode?.model, "matrix-primary/primary");
		assert.equal(restoredEpisode?.effort, "max");
		assert.match(restored.threads.get(result.thread.id)?.outcomeReason ?? "", /Slate route contract violation/);
	});

	await t.test("a rejected worker opening reports the refusal, the startup error, and the accepted pair", { timeout: 15_000 }, async () => {
		const { result, state, transcript, episodeBytes, laterPrompt, restored } = await runWorkerRequestMatrixScenario("startup-rejected-open");
		assert.equal(state.startupWorkCompleted, true, "the accepted startup request must complete one real tool call");
		assert.equal(state.independentStartupFailure, true, "the independent startup handler must run after the refusal");
		assert.equal(state.primaryCalls, 2, "the accepted startup turn and its accepted continuation are the only provider requests");
		assert.equal(state.toolCalls, 1);
		assert.equal(state.otherCalls, 0);
		assert.equal(state.fallbackCalls, 0, "a failed opening starts no logical recovery and no replay");
		assert.equal(state.compactionCalls, 0);
		assert.equal(result.episode.status, "failed");
		assert.equal(result.thread.status, "failed");
		assert.match(result.thread.outcomeReason ?? "", /independent startup handler failed/);
		assert.match(result.thread.outcomeReason ?? "", /Slate route contract violation/);
		assert.ok(result.warnings.some((warning) => warning.includes("Slate route contract violation.")), result.warnings.join("\n"));
		assert.match(result.episodeText, /Slate route contract violation/);
		assert.match(result.episodeText, /independent startup handler failed/);
		assert.match(result.episodeText, /matrix done/, "the completed startup response stays in the failed result");
		assert.match(transcript, /retained matrix tool result/);
		assert.equal(result.episode.requestedModel, "matrix-primary/primary");
		assert.equal(result.episode.model, "matrix-primary/primary", "the accepted startup request keeps its true attribution");
		assert.equal(result.episode.effort, "max");
		// T11: both independent causes and the accepted pair reach the durable bytes,
		// the restored snapshot and one later action's prompt.
		assert.equal(
			episodeBytes.match(/\[completed tool result: host_probe\]/g)?.length,
			1,
			"the stable record supplies the retained startup fact once",
		);
		assert.match(episodeBytes, /retained matrix tool result/);
		assert.match(laterPrompt, /retained matrix tool result/);
		assert.match(laterPrompt, /Slate route contract violation/);
		assert.match(laterPrompt, /independent startup handler failed/);
		assert.match(laterPrompt, /ran: matrix-primary\/primary @ max/);
		const restoredThread = restored.threads.get(result.thread.id);
		assert.match(restoredThread?.outcomeReason ?? "", /independent startup handler failed/);
		assert.match(restoredThread?.outcomeReason ?? "", /Slate route contract violation/);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredEpisode?.logicalModel, "matrix");
		assert.equal(restoredEpisode?.requestedModel, "matrix-primary/primary");
		assert.equal(restoredEpisode?.model, "matrix-primary/primary");
		assert.equal(restoredEpisode?.effort, "max");
	});
});
