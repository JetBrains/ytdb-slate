import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAssistantMessageEventStream,
	createProvider,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compressEpisode } from "../extension/episodes.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";

const PROVIDER = "slate-compressor-registry-only";
const API = "slate-compressor-registry-only-api";
const BODY = "## Intent\nRegistry-only compressor produced this episode.";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MODEL: Model<Api> = {
	id: "registry-only-model", name: "Registry-only model", provider: PROVIDER, api: API,
	baseUrl: "memory://registry-only", reasoning: true, thinkingLevelMap: { medium: "medium" },
	input: ["text"], cost: COST, contextWindow: 100_000, maxTokens: 8_192,
};

test("compression calls a provider registered only in Pi's model registry", { timeout: 5_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "slate-compressor-registry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		authPath: join(root, "auth.json"), modelsPath: null,
		modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
	});
	const requests: Array<{ model: Model<Api>; context: TranscriptContext; options?: SimpleStreamOptions }> = [];
	const run = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
		requests.push({ model, context, options });
		const stream = createAssistantMessageEventStream();
		const response: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [{ type: "text", text: BODY }], stopReason: "stop", timestamp: Date.now(),
			usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { ...COST, total: 0.125 } },
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...response, stopReason: "pending", content: [] } });
			stream.push({ type: "done", reason: "stop", message: response });
			stream.end();
		});
		return stream;
	};
	// No compat registration. The real ModelRegistry owns this provider and its auth.
	const registry = new ModelRegistry(runtime);
	registry.registerProvider(createProvider({
		id: PROVIDER, models: [MODEL],
		auth: { apiKey: { name: "Fixture key", async resolve() {
			return { auth: { apiKey: "fixture-secret", headers: { "x-fixture": "header" } }, source: "fixture" };
		} } },
		api: { stream: run, streamSimple: run },
	}));
	assert.strictEqual(registry.find(PROVIDER, MODEL.id)?.api, API);
	const logicalRuntime = createLogicalRuntime({ trusted: true, projectConfig: { router: {
		models: { replace: [{ model: "claude-sonnet-5", preferredProvider: PROVIDER, providers: { [PROVIDER]: MODEL.id } }] },
		compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }] },
	} } });
	const admission = logicalRuntime.admit();
	assert.ok(admission);
	const ctx = { cwd: root, hasUI: false, modelRegistry: registry } as ExtensionContext;
	const result = await compressEpisode({
		ctx, episodeId: "t1.e1", threadId: "t1", threadName: "registry-only", task: "compress completed work",
		status: "ok", messages: [{ role: "assistant", content: [{ type: "text", text: "RAW COMPLETED RESULT" }] }],
		observations: { stored: false, reason: "no-final-message", grammar: "absent" },
		logicalRuntime, admission, retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
	});
	assert.equal(requests.length, 1, "the registered provider received the compression request");
	assert.strictEqual(requests[0]?.model, registry.find(PROVIDER, MODEL.id));
	assert.match(JSON.stringify(requests[0]?.context), /RAW COMPLETED RESULT/);
	assert.equal(requests[0]?.options?.apiKey, "fixture-secret");
	assert.equal(requests[0]?.options?.headers?.["x-fixture"], "header");
	assert.equal(requests[0]?.options?.reasoning, "medium");
	assert.equal(requests[0]?.options?.maxTokens, 4096);
	assert.equal(result.compressor, `${PROVIDER}/${MODEL.id}`);
	assert.match(result.text, /Registry-only compressor produced this episode/);
	assert.doesNotMatch(result.text, /bounded completed result was retained/i);
	assert.equal(readFileSync(result.file, "utf8"), result.text);
	assert.deepEqual(result.compressorUsage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
	assert.equal(result.costUsd, 0.125);
});

function providerResponse(model: Model<Api>, stopReason: "stop" | "aborted", text = BODY): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: stopReason === "stop" ? [{ type: "text", text }] : [], stopReason, timestamp: Date.now(),
		usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { ...COST, total: 0.125 } },
	};
}

/** A real registry, native provider, stored source credential, and production compressor. */
async function registryScenario(
	t: test.TestContext,
	script: (call: number, options: SimpleStreamOptions | undefined, abort: () => void) => "success" | "abort" | Error,
	policy: { enabled: boolean; maxRetries: number; baseDelayMs: number },
) {
	const root = mkdtempSync(join(tmpdir(), "slate-compressor-sdk-error-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const authPath = join(root, "auth.json");
	writeFileSync(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: "stored-source" } }));
	const runtime = await ModelRuntime.create({
		authPath, modelsPath: null, modelsStorePath: join(root, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	const registry = new ModelRegistry(runtime);
	const credentials: Array<string | undefined> = [];
	const sourceKeys: Array<string | undefined> = [];
	const controller = new AbortController();
	let calls = 0;
	registry.registerProvider(createProvider({
		id: PROVIDER, models: [MODEL],
		auth: { apiKey: { name: "Source credential", async resolve({ credential }) {
			sourceKeys.push(credential?.key);
			if (credential?.key !== "stored-source") throw new Error("wire key is not a source credential");
			return { auth: { apiKey: "wire-request-key", headers: { "x-fixture": "runtime-header" } }, source: "stored credential" };
		} } },
		api: {
			stream: run, streamSimple: run,
		},
	}));
	function run(model: Model<Api>, _context: TranscriptContext, options?: SimpleStreamOptions) {
		calls++;
		credentials.push(options?.apiKey);
		if (options?.apiKey !== "wire-request-key") throw new Error("transport requires the resolved request key");
		const outcome = script(calls, options, () => controller.abort());
		if (outcome instanceof Error) throw outcome;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const response = providerResponse(model, outcome === "abort" ? "aborted" : "stop");
			stream.push({ type: "start", partial: { ...response, stopReason: "pending", content: [] } });
			if (outcome === "abort") stream.push({ type: "error", reason: "aborted", error: response });
			else stream.push({ type: "done", reason: "stop", message: response });
			stream.end();
		});
		return stream;
	}
	const logicalRuntime = createLogicalRuntime({ trusted: true, projectConfig: { router: {
		models: { replace: [{ model: "claude-sonnet-5", preferredProvider: PROVIDER, providers: { [PROVIDER]: MODEL.id } }] },
		compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }] },
	} } });
	const admission = logicalRuntime.admit();
	assert.ok(admission);
	const ctx = { cwd: root, hasUI: false, modelRegistry: registry } as ExtensionContext;
	const result = await compressEpisode({
		ctx, episodeId: "t1.e1", threadId: "t1", threadName: "sdk-path", task: "compress completed work",
		status: "ok", messages: [{ role: "assistant", content: [{ type: "text", text: "RAW COMPLETED RESULT" }] }],
		observations: { stored: false, reason: "no-final-message", grammar: "absent" },
		logicalRuntime, admission, retryPolicy: policy, signal: controller.signal,
	});
	assert.equal(readFileSync(result.file, "utf8"), result.text);
	return { result, calls, credentials, sourceKeys };
}

test("Pi resolves a stored source credential into the wire key for registry-only compression", { timeout: 5_000 }, async (t) => {
	const { result, calls, credentials, sourceKeys } = await registryScenario(t, () => "success", { enabled: false, maxRetries: 0, baseDelayMs: 0 });
	assert.equal(calls, 1);
	assert.deepEqual(credentials, ["wire-request-key"]);
	assert.ok(sourceKeys.length >= 2, "the pre-check and request each resolve the stored credential");
	assert.ok(sourceKeys.every((key) => key === "stored-source"), "the wire key is never reused as a source credential");
	assert.equal(result.compressor, `${PROVIDER}/${MODEL.id}`);
	assert.match(result.text, /Registry-only compressor produced this episode/);
	assert.deepEqual(result.compressorUsage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
	assert.equal(result.costUsd, 0.125);
});

for (const scenario of [
	{ name: "transient throw exhausts one retry", script: () => new Error("503 service unavailable"), policy: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, calls: 2, notice: "Compression failed. The bounded completed result was retained." },
	{ name: "terminal throw stops without retry", script: () => new Error("invalid request"), policy: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, calls: 1, notice: "The compressor returned a terminal provider error. The bounded completed result was retained." },
	{ name: "disabled retries preserve unknown classification", script: () => new Error("503 service unavailable"), policy: { enabled: false, maxRetries: 1, baseDelayMs: 0 }, calls: 1, notice: "Compressor retries were disabled, so exhaustion is not proved. The bounded completed result was retained." },
] as const) {
	test(`Pi registry provider ${scenario.name}`, { timeout: 5_000 }, async (t) => {
		const { result, calls, credentials } = await registryScenario(t, scenario.script, scenario.policy);
		assert.equal(calls, scenario.calls);
		assert.deepEqual(credentials, Array(scenario.calls).fill("wire-request-key"));
		assert.equal(result.compressor, "(uncompressed fallback)");
		assert.ok(result.text.includes(`(${scenario.notice} Raw final worker output follows.)`));
		assert.deepEqual(result.compressorUsage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(result.costUsd, 0);
	});
}

test("Pi registry provider succeeds after one normalized transient throw", { timeout: 5_000 }, async (t) => {
	const { result, calls, credentials } = await registryScenario(t, (call) => call === 1 ? new Error("503 service unavailable") : "success", { enabled: true, maxRetries: 1, baseDelayMs: 0 });
	assert.equal(calls, 2);
	assert.deepEqual(credentials, ["wire-request-key", "wire-request-key"]);
	assert.equal(result.compressor, `${PROVIDER}/${MODEL.id}`);
	assert.match(result.text, /Registry-only compressor produced this episode/);
	assert.doesNotMatch(result.text, /bounded completed result was retained/i);
	assert.deepEqual(result.compressorUsage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
	assert.equal(result.costUsd, 0.125);
});

test("Pi registry provider aborted response retains the cancellation fallback", { timeout: 5_000 }, async (t) => {
	const { result, calls, credentials } = await registryScenario(t, (_call, options, abort) => {
		assert.equal(options?.signal?.aborted, false);
		abort();
		assert.equal(options?.signal?.aborted, true);
		return "abort";
	}, { enabled: true, maxRetries: 1, baseDelayMs: 0 });
	assert.equal(calls, 1);
	assert.deepEqual(credentials, ["wire-request-key"]);
	assert.equal(result.compressor, "(uncompressed fallback)");
	assert.match(result.text, /\(Compression was cancelled\. The bounded completed result was retained\. Raw final worker output follows\.\)/);
	assert.deepEqual(result.compressorUsage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
	assert.equal(result.costUsd, 0.125);
});
