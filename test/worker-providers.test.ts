import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	AgentSession,
	ModelRegistry,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	createProvider,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager, type DispatchProgress } from "../extension/threads.ts";
import { inheritHostProviderRegistrations, openWorkerSession } from "../extension/worker.ts";
import { WORKER_PROVIDER_ID } from "./fixtures/worker-provider.ts";

const WORKER_PROVIDER_FIXTURE = fileURLToPath(new URL("./fixtures/worker-provider.ts", import.meta.url));
const MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function model(provider: string, id = "model"): Model<Api> {
	return {
		id,
		name: id,
		api: "fixture-api",
		provider,
		baseUrl: `memory://${provider}`,
		reasoning: false,
		input: ["text"],
		cost: MODEL_COST,
		contextWindow: 100_000,
		maxTokens: 1_000,
	};
}

function completedMessage(selected: Model<Api>, text = "inherited provider response"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { ...MODEL_COST, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function nativeProvider(
	id: string,
	onRequest?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => void,
): Provider {
	const run = (selected: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		onRequest?.(selected, context, options);
		const stream = createAssistantMessageEventStream();
		const message = completedMessage(selected);
		stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
		stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }], stopReason: "pending" } });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "inherited provider response", partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: "inherited provider response", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
		return stream;
	};
	return createProvider({
		id,
		name: `Fixture ${id}`,
		baseUrl: `memory://${id}`,
		auth: {
			apiKey: {
				name: "Fixture key",
				async resolve() {
					return {
						auth: { apiKey: "inherited-secret", headers: { "x-inherited": "yes" } },
						source: "fixture",
					};
				},
			},
		},
		models: [model(id)],
		api: { stream: run, streamSimple: run },
	});
}

function legacyConfig(id: string, apiKey = "fixture-key"): Parameters<ModelRuntime["registerProvider"]>[1] {
	return {
		name: `Fixture ${id}`,
		baseUrl: `memory://${id}`,
		apiKey,
		api: "fixture-api",
		models: [model(id)],
		streamSimple(selected, context, options) {
			return nativeProvider(id).streamSimple(selected, context, options);
		},
	};
}

async function runtime(root: string, name: string): Promise<ModelRuntime> {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(dir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

function context(root: string, registry: ModelRegistry, selected?: Model<Api>, trusted = false): ExtensionContext {
	return {
		cwd: join(root, "project"),
		hasUI: false,
		isProjectTrusted: () => trusted,
		modelRegistry: registry,
		model: selected,
	} as unknown as ExtensionContext;
}

test("empty host registration roster leaves the worker unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-empty-"));
	try {
		const host = await runtime(root, "host");
		const worker = await runtime(root, "worker");
		inheritHostProviderRegistrations(new ModelRegistry(host), worker);
		assert.deepEqual(worker.getRegisteredProviderIds(), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("config and native registrations copy when absent without changing the host", async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-copy-"));
	try {
		const host = await runtime(root, "host");
		const worker = await runtime(root, "worker");
		const config = legacyConfig("config-provider");
		const native = nativeProvider("native-provider");
		host.registerProvider("config-provider", config);
		host.registerNativeProvider(native);
		const hostIds = [...host.getRegisteredProviderIds()];
		const hostConfig = host.getRegisteredProviderConfig("config-provider");
		const hostNative = host.getRegisteredNativeProvider("native-provider");
		const hostConfigProvider = host.getProvider("config-provider");

		inheritHostProviderRegistrations(new ModelRegistry(host), worker);

		assert.deepEqual(new Set(worker.getRegisteredProviderIds()), new Set(["config-provider", "native-provider"]));
		assert.ok(worker.getRegisteredProviderConfig("config-provider"));
		assert.strictEqual(worker.getRegisteredNativeProvider("native-provider"), native);
		assert.deepEqual(host.getRegisteredProviderIds(), hostIds);
		assert.strictEqual(host.getRegisteredProviderConfig("config-provider"), hostConfig);
		assert.strictEqual(host.getRegisteredNativeProvider("native-provider"), hostNative);
		assert.strictEqual(host.getProvider("config-provider"), hostConfigProvider);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker registration wins across config and native forms", async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-precedence-"));
	try {
		const host = await runtime(root, "host");
		const worker = await runtime(root, "worker");
		const workerNative = nativeProvider("host-config-worker-native");
		const hostNative = nativeProvider("host-native-worker-config");
		host.registerProvider("host-config-worker-native", legacyConfig("host-config-worker-native", "host-key"));
		host.registerNativeProvider(hostNative);
		worker.registerNativeProvider(workerNative);
		const workerConfig = legacyConfig("host-native-worker-config", "worker-key");
		worker.registerProvider("host-native-worker-config", workerConfig);

		inheritHostProviderRegistrations(new ModelRegistry(host), worker);

		assert.strictEqual(worker.getRegisteredNativeProvider("host-config-worker-native"), workerNative);
		assert.equal(worker.getRegisteredProviderConfig("host-config-worker-native"), undefined);
		assert.equal(worker.getRegisteredNativeProvider("host-native-worker-config"), undefined);
		assert.equal(worker.getRegisteredProviderConfig("host-native-worker-config")?.apiKey, "worker-key");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a realized worker config registration wins over a host native registration", { timeout: 5000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-realized-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_OFFLINE = "1";
	let session: Awaited<ReturnType<typeof openWorkerSession>> | undefined;
	try {
		const host = await runtime(root, "host");
		const hostNative = nativeProvider(WORKER_PROVIDER_ID);
		host.registerNativeProvider(hostNative);
		session = await openWorkerSession({
			ctx: context(root, new ModelRegistry(host), undefined, true),
			extensionPaths: [WORKER_PROVIDER_FIXTURE],
		});
		assert.equal(session.modelRuntime.getRegisteredNativeProvider(WORKER_PROVIDER_ID), undefined);
		assert.equal(session.modelRuntime.getRegisteredProviderConfig(WORKER_PROVIDER_ID)?.apiKey, "worker-owned-key");
		assert.equal(session.modelRuntime.getProvider(WORKER_PROVIDER_ID)?.baseUrl, "memory://worker-owned");
		assert.strictEqual(host.getRegisteredNativeProvider(WORKER_PROVIDER_ID), hostNative);
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		rmSync(root, { recursive: true, force: true });
	}
});

test("native form wins without reading config when a malformed host reports both forms", async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-native-first-"));
	try {
		const worker = await runtime(root, "worker");
		const native = nativeProvider("both-forms");
		inheritHostProviderRegistrations({
			getRegisteredProviderIds: () => ["both-forms"],
			getRegisteredNativeProvider: () => native,
			getRegisteredProviderConfig: () => { throw new Error("config form must not be read"); },
		}, worker);
		assert.strictEqual(worker.getRegisteredNativeProvider("both-forms"), native);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a host extension override of a built-in provider is inherited", async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-builtin-"));
	try {
		const host = await runtime(root, "host");
		const worker = await runtime(root, "worker");
		host.registerProvider("anthropic", { baseUrl: "https://proxy.invalid" });
		assert.equal(worker.getRegisteredProviderIds().includes("anthropic"), false);

		inheritHostProviderRegistrations(new ModelRegistry(host), worker);

		assert.equal(worker.getRegisteredProviderConfig("anthropic")?.baseUrl, "https://proxy.invalid");
		assert.equal(worker.getProvider("anthropic")?.baseUrl, "https://proxy.invalid");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a later partial worker registration retains inherited credentials under accepted pi merge rules", async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-late-merge-"));
	try {
		const host = await runtime(root, "host");
		const worker = await runtime(root, "worker");
		host.registerProvider("late-merge", legacyConfig("late-merge", "inherited-key"));
		inheritHostProviderRegistrations(new ModelRegistry(host), worker);

		worker.registerProvider("late-merge", { baseUrl: "memory://later-worker-endpoint" });

		assert.equal(worker.getRegisteredProviderConfig("late-merge")?.apiKey, "inherited-key");
		assert.equal(worker.getRegisteredProviderConfig("late-merge")?.baseUrl, "memory://later-worker-endpoint");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing, throwing, and uncomposable registrations fail without exposing source errors", async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-failure-"));
	try {
		const worker = await runtime(root, "worker");
		const missing = {
			getRegisteredProviderIds: () => ["missing"],
			getRegisteredNativeProvider: () => undefined,
			getRegisteredProviderConfig: () => undefined,
		};
		assert.throws(
			() => inheritHostProviderRegistrations(missing, worker),
			(error: Error) => error.message.includes("missing") && !error.message.includes("secret"),
		);
		const throwing = {
			getRegisteredProviderIds: () => { throw new Error("secret roster contents"); },
			getRegisteredNativeProvider: () => undefined,
			getRegisteredProviderConfig: () => undefined,
		};
		assert.throws(
			() => inheritHostProviderRegistrations(throwing, worker),
			(error: Error) => !error.message.includes("secret roster contents"),
		);
		const modelsPath = join(root, "broken-models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { broken: { baseUrl: "memory://override" } } }));
		const compositionWorker = await ModelRuntime.create({
			authPath: join(root, "broken-auth.json"),
			modelsPath,
			modelsStorePath: join(root, "broken-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const broken = {
			id: "broken",
			name: "Broken",
			auth: {},
			getModels() { throw new Error("secret composition detail"); },
			stream() { throw new Error("must not request"); },
			streamSimple() { throw new Error("must not request"); },
		} as unknown as Provider;
		const malformed = {
			getRegisteredProviderIds: () => ["broken"],
			getRegisteredNativeProvider: () => broken,
			getRegisteredProviderConfig: () => undefined,
		};
		assert.throws(
			() => inheritHostProviderRegistrations(malformed, compositionWorker),
			(error: Error) => error.message.includes("broken") && !error.message.includes("secret composition detail"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unconfigured unused inherited provider does not block an unrelated usable provider", { timeout: 5000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-unconfigured-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	const previousUnusedKey = process.env.SLATE_TEST_UNSET_PROVIDER_KEY;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_OFFLINE = "1";
	delete process.env.SLATE_TEST_UNSET_PROVIDER_KEY;
	let session: Awaited<ReturnType<typeof openWorkerSession>> | undefined;
	let requests = 0;
	try {
		const host = await runtime(root, "host");
		host.registerProvider("unused", legacyConfig("unused", "$SLATE_TEST_UNSET_PROVIDER_KEY"));
		host.registerNativeProvider(nativeProvider("usable", () => { requests += 1; }));
		const hostRegistry = new ModelRegistry(host);
		const selected = host.getModel("usable", "model");
		assert.ok(selected);
		assert.deepEqual(hostRegistry.getProviderAuthStatus("unused"), { configured: false });
		assert.equal(host.hasConfiguredAuth("unused"), false);

		session = await openWorkerSession({ ctx: context(root, hostRegistry, selected) });
		assert.equal(session.modelRuntime.getRegisteredProviderIds().includes("unused"), true);
		assert.deepEqual(session.modelRuntime.getProviderAuthStatus("unused"), { configured: false });
		assert.equal(session.modelRuntime.hasConfiguredAuth("unused"), false);

		await session.prompt("use the unrelated configured provider");
		assert.equal(requests, 1);
		assert.equal(session.messages.at(-1)?.role, "assistant");
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		if (previousUnusedKey === undefined) delete process.env.SLATE_TEST_UNSET_PROVIDER_KEY;
		else process.env.SLATE_TEST_UNSET_PROVIDER_KEY = previousUnusedKey;
		rmSync(root, { recursive: true, force: true });
	}
});

test("provider inheritance failure shuts down loaded extensions before disposal without starting them", { timeout: 5000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-dispose-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	const originalDispose = AgentSession.prototype.dispose;
	const marker = join(root, "inheritance-lifecycle.txt");
	const extensionPath = join(root, "inheritance-lifecycle.mjs");
	const order: string[] = [];
	let disposals = 0;
	let requests = 0;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_OFFLINE = "1";
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(
		join(process.env.PI_CODING_AGENT_DIR, "models.json"),
		JSON.stringify({ providers: { "broken-startup": { baseUrl: "memory://override" } } }),
	);
	writeFileSync(extensionPath, `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => { appendFileSync(${JSON.stringify(marker)}, "startup\\n"); });
  pi.on("session_shutdown", () => {
    appendFileSync(${JSON.stringify(marker)}, "shutdown\\n");
    throw new Error("cleanup detail");
  });
}`);
	AgentSession.prototype.dispose = function dispose() {
		disposals += 1;
		order.push(readFileSync(marker, "utf8"));
		return originalDispose.call(this);
	};
	try {
		const broken = {
			id: "broken-startup",
			name: "Broken startup",
			auth: {},
			getModels() { throw new Error("secret composition failure"); },
			stream() { requests += 1; throw new Error("request must not run"); },
			streamSimple() { requests += 1; throw new Error("request must not run"); },
		} as unknown as Provider;
		const registry = {
			getRegisteredProviderIds: () => ["broken-startup"],
			getRegisteredNativeProvider: () => broken,
			getRegisteredProviderConfig: () => undefined,
		};
		const reports: string[] = [];
		await assert.rejects(
			openWorkerSession({
				ctx: context(root, registry as unknown as ModelRegistry, undefined, true),
				extensionPaths: [extensionPath],
				report: (message) => reports.push(message),
			}),
			(error: Error) => error.message.includes('provider inheritance failed for provider "broken-startup"')
				&& !error.message.includes("secret composition failure")
				&& !error.message.includes("cleanup detail"),
		);
		assert.equal(readFileSync(marker, "utf8"), "shutdown\n");
		assert.deepEqual(order, ["shutdown\n"]);
		assert.equal(disposals, 1);
		assert.equal(requests, 0);
		assert.equal(reports.filter((message) => /extension shutdown failed.*cleanup detail/.test(message)).length, 1);
	} finally {
		AgentSession.prototype.dispose = originalDispose;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		rmSync(root, { recursive: true, force: true });
	}
});

test("public dispatch records a failed episode when provider inheritance fails", { timeout: 5000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-dispatch-failure-"));
	const project = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	const originalDispose = AgentSession.prototype.dispose;
	let disposals = 0;
	let requests = 0;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_OFFLINE = "1";
	mkdirSync(project, { recursive: true });
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(
		join(process.env.PI_CODING_AGENT_DIR, "models.json"),
		JSON.stringify({ providers: { "broken-dispatch": { baseUrl: "memory://override" } } }),
	);
	AgentSession.prototype.dispose = function dispose() {
		disposals += 1;
		return originalDispose.call(this);
	};
	try {
		const broken = {
			id: "broken-dispatch",
			name: "Broken dispatch",
			auth: {},
			getModels() { throw new Error("secret composition detail"); },
			stream() { requests += 1; throw new Error("request must not run"); },
			streamSimple() { requests += 1; throw new Error("request must not run"); },
		} as unknown as Provider;
		const registry = {
			find(provider: string, id: string) { return provider === "broken-dispatch" && id === "model" ? model(provider, id) : undefined; },
			hasConfiguredAuth: () => true,
			async getAvailable() { return []; },
			getRegisteredProviderIds: () => ["broken-dispatch"],
			getRegisteredNativeProvider: () => broken,
			getRegisteredProviderConfig: () => undefined,
		};
		const persistedEntries: Array<{ type: "custom"; customType: string; data: Record<string, unknown> }> = [];
		const store = new SlateStore({
			appendEntry(customType: string, data: Record<string, unknown>) {
				persistedEntries.push({ type: "custom", customType, data: structuredClone(data) });
			},
		} as unknown as ExtensionAPI);
		const logicalRuntime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, costRating: 50, effort: "off", preferredProvider: "broken-dispatch", providers: { "broken-dispatch": "model" }, guidelines: [], cautions: [] }] } } } });
		const manager = new ThreadManager(store, {}, undefined, Object.freeze({ ...logicalRuntime, validateRoute: async () => ({ ok: true } as const) }));
		const progress: DispatchProgress[] = [];

		const result = await manager.dispatch(
			{ model: "fixture", reason: "provider inheritance fixture", name: "inheritance failure", type: "general", task: "do not issue a provider request" },
			context(root, registry as unknown as ModelRegistry),
			undefined,
			(update) => progress.push({ ...update, lines: [...update.lines], usage: { ...update.usage } }),
		);

		assert.equal(result.episode.status, "failed");
		assert.equal(result.thread.status, "failed");
		assert.equal(result.thread.episodeId, result.episode.id);
		assert.strictEqual(store.episodes.get(result.episode.id), result.episode);
		assert.strictEqual(store.threads.get(result.thread.id), result.thread);
		const lastPersistedEntry = persistedEntries.at(-1);
		assert.equal(lastPersistedEntry?.customType, "slate-state");
		const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
		restored.restore({
			cwd: project,
			hasUI: false,
			sessionManager: {
				getBranch: () => persistedEntries,
				getEntries: () => persistedEntries,
			},
		} as unknown as ExtensionContext);
		const restoredEpisode = restored.episodes.get(result.episode.id);
		const restoredThread = restored.threads.get(result.thread.id);
		assert.notStrictEqual(restoredEpisode, result.episode);
		assert.notStrictEqual(restoredThread, result.thread);
		assert.deepEqual(restoredEpisode, result.episode);
		assert.equal(restoredEpisode?.status, "failed");
		assert.equal(restoredThread?.status, "failed");
		assert.equal(restoredThread?.episodeId, restoredEpisode?.id);
		assert.match(result.episodeText, /STATUS: FAILED/);
		assert.match(result.episodeText, /worker provider inheritance failed for provider "broken-dispatch"/);
		assert.doesNotMatch(result.episodeText, /secret composition detail|request must not run/);
		assert.equal(readFileSync(result.episode.file, "utf8"), result.episodeText);
		assert.equal(requests, 0);
		assert.equal(disposals, 1);
		assert.equal(progress.at(-1)?.done, true);
		assert.equal(progress.at(-1)?.status, "failed");
		assert.equal(progress.filter((update) => update.done).length, 1);
	} finally {
		AgentSession.prototype.dispose = originalDispose;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		rmSync(root, { recursive: true, force: true });
	}
});

test("the first real worker request uses inherited native auth and behavior with no provider tool", { timeout: 5000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "slate-worker-providers-request-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	const calls: Array<{ apiKey: string | undefined; header: string | null | undefined; prompt: string }> = [];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_OFFLINE = "1";
	let session: Awaited<ReturnType<typeof openWorkerSession>> | undefined;
	try {
		const host = await runtime(root, "host");
		const provider = nativeProvider("provider-only", (_selected, requestContext, options) => {
			const prompt = requestContext.messages
				.flatMap((message) => {
					if (typeof message.content === "string") return [message.content];
					if (!Array.isArray(message.content)) return [];
					return message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
				})
				.join("\n");
			calls.push({ apiKey: options?.apiKey, header: options?.headers?.["x-inherited"], prompt });
		});
		host.registerNativeProvider(provider);
		const selected = host.getModel("provider-only", "model");
		assert.ok(selected);
		session = await openWorkerSession({
			ctx: context(root, new ModelRegistry(host), selected),
			extensionPaths: [],
		});
		assert.deepEqual(
			session.getAllTools().map((tool) => tool.name).sort(),
			["bash", "edit", "find", "grep", "ls", "read", "write"],
			"the provider-only host registration adds no worker tool",
		);

		await session.prompt("exercise inherited provider");

		assert.deepEqual(calls, [{ apiKey: "inherited-secret", header: "yes", prompt: "exercise inherited provider" }]);
		assert.equal(session.messages.at(-1)?.role, "assistant");
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		rmSync(root, { recursive: true, force: true });
	}
});
