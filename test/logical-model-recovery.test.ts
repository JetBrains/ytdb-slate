import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRetryableAssistantError, retryAssistantCall } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { registerOrchestratorFailover, SAVED_DEFAULT_RESOURCE_KEY } from "../extension/failover.ts";
import type { LogicalModelDefinition } from "../extension/logical-model-definitions.ts";
import { createLogicalRuntime, type LogicalRuntime } from "../extension/logical-model-runtime.ts";
import { CompressorRetryEvidence, MainRetryEvidence, WorkerRetryEvidence, executeCompression, executeRecovery, executeWithRecoveryOwnership } from "../extension/logical-model-adapters.ts";
import { RecoveryOperation, RecoveryOwnership, RecoveryPreferences, ordinaryModelRecoveryOrder, planCompressorRecovery, planOrdinaryRecovery, type RecoveryCandidate } from "../extension/logical-model-recovery.ts";
import type { LogicalModelPolicy } from "../extension/logical-model-resolver.ts";

function model(name: string, capabilityRating: number, costRating: number, providers: Record<string, string>, preferredProvider = Object.keys(providers)[0]!): LogicalModelDefinition {
	return { model: name, capabilityRating, costRating, effort: "high", preferredProvider, providers, guidelines: [], cautions: [] };
}

function policy(): LogicalModelPolicy {
	const rows = [
		model("active", 50, 50, { a: "shared", b: "active-b", c: "active-c" }, "b"),
		model("same-expensive", 50, 80, { x: "same-expensive" }),
		model("same-cheap", 50, 10, { x: "same-cheap" }),
		model("higher-expensive", 60, 90, { h: "higher-expensive" }),
		model("higher-cheap", 60, 20, { h: "higher-cheap" }),
		model("lower", 40, 30, { l: "lower" }),
		model("higher-far", 80, 5, { z: "higher-far" }),
		model("lower-far", 20, 5, { z: "lower-far" }),
	];
	const definitions = Object.fromEntries(rows.map((row) => [row.model, row]));
	return { definitions, ordinary: rows, compressor: [{ model: "active", effort: "medium" }, { model: "same-cheap", effort: "low" }, { model: "higher-cheap", effort: "max" }] };
}

const noPreferences = { providers: Object.freeze(Object.create(null) as Record<string, string>), compressorIndex: 0, resetEpoch: 0 };

test("real Pi compressor retries produce conservative raw outcome evidence", { timeout: 2_000 }, async () => {
	const response = (stopReason: "stop" | "error" | "aborted", errorMessage?: string) => ({
		role: "assistant" as const, stopReason, errorMessage, content: stopReason === "stop" ? [{ type: "text" as const, text: "done" }] : [],
		api: "openai-responses" as const, provider: "test", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1,
	});
	const run = async (script: ReturnType<typeof response>[], policy: { enabled: boolean; maxRetries: number; baseDelayMs: number }, controller = new AbortController()) => {
		const evidence = new CompressorRetryEvidence();
		let final: unknown;
		let threw = false;
		try {
			final = await retryAssistantCall(async () => evidence.response(script.shift()!), policy, controller.signal, evidence.callbacks);
		} catch { threw = true; }
		return { evidence, final, result: evidence.classify({ final, policy, actualEffort: "medium", aborted: controller.signal.aborted, threw, retryable: typeof final === "object" && final !== null && isRetryableAssistantError(final as never) }) };
	};
	const succeeded = await run([response("error", "temporary timeout"), response("stop")], { enabled: true, maxRetries: 1, baseDelayMs: 0 });
	assert.equal(succeeded.result.kind, "success");
	assert.equal(succeeded.evidence.responses.length, 2);
	const exhausted = await run([response("error", "temporary timeout"), response("error", "temporary timeout")], { enabled: true, maxRetries: 1, baseDelayMs: 0 });
	assert.equal(exhausted.result.kind, "retry-exhausted");
	assert.equal(exhausted.evidence.responses.length, 2);
	assert.equal((await run([response("error", "temporary timeout")], { enabled: true, maxRetries: 0, baseDelayMs: 0 })).result.kind, "retry-exhausted");
	assert.equal((await run([response("error", "temporary timeout")], { enabled: false, maxRetries: 9, baseDelayMs: 0 })).result.kind, "unknown");
	const active = new AbortController(); active.abort();
	assert.equal((await run([response("aborted")], { enabled: true, maxRetries: 1, baseDelayMs: 0 }, active)).result.kind, "cancelled");
	const backoff = new AbortController();
	const evidence = new CompressorRetryEvidence();
	const first = response("error", "temporary timeout");
	const final = await retryAssistantCall(async () => evidence.response(first), { enabled: true, maxRetries: 1, baseDelayMs: 100 }, backoff.signal, {
		...evidence.callbacks,
		onRetryScheduled: (attempt, maxAttempts) => { evidence.callbacks.onRetryScheduled(attempt, maxAttempts); backoff.abort(); },
	});
	assert.equal(evidence.classify({ final, policy: { enabled: true, maxRetries: 1, baseDelayMs: 100 }, actualEffort: "medium", aborted: true, threw: false, retryable: false }).kind, "cancelled");
	assert.equal(evidence.responses.length, 1, "Pi's synthetic backoff abort is not a second physical response");
});

test("main retry evidence accepts completed tool turns before one exact matching retry suffix", () => {
	const policy = { enabled: true, maxRetries: 1, baseDelayMs: 0 };
	const error = { stopReason: "error", errorMessage: "temporary timeout" };
	const classify = (evidence: MainRetryEvidence, overrides: Partial<Parameters<MainRetryEvidence["settle"]>[0]> = {}) => evidence.settle({
		route: "p/m", effort: "high", policy,
		isRetryable: (message) => message.errorMessage === "temporary timeout",
		isContextOverflow: () => false, ...overrides,
	});
	const complete = new MainRetryEvidence();
	complete.observe({ stopReason: "toolUse" }, "p/m", "high");
	complete.observe(error, "p/m", "high");
	complete.observe(error, "p/m", "high");
	assert.equal(classify(complete).kind, "retry-exhausted");
	const tooMany = new MainRetryEvidence();
	tooMany.observe(error, "p/m", "high");
	tooMany.observe(error, "p/m", "high");
	tooMany.observe(error, "p/m", "high");
	assert.equal(classify(tooMany).kind, "unknown");
	for (const mutate of [
		(e: MainRetryEvidence) => e.observe(error, "p/m", "high"),
		(e: MainRetryEvidence) => { e.observe(error, "p/m", "high"); e.observe(error, "p/other", "high"); },
		(e: MainRetryEvidence) => { e.observe(error, "p/m", "high"); e.observe(error, "p/m", "medium"); },
	]) {
		const incomplete = new MainRetryEvidence(); mutate(incomplete);
		assert.equal(classify(incomplete).kind, "unknown");
	}
	const disabled = new MainRetryEvidence(); disabled.observe(error, "p/m", "high");
	assert.equal(classify(disabled, { policy: { enabled: false, maxRetries: 0, baseDelayMs: 0 } }).kind, "unknown");
	const zero = new MainRetryEvidence(); zero.observe(error, "p/m", "high");
	assert.equal(classify(zero, { policy: { enabled: true, maxRetries: 0, baseDelayMs: 0 } }).kind, "retry-exhausted");
	const cancelled = new MainRetryEvidence(); cancelled.observe({ stopReason: "aborted" }, "p/m", "high");
	assert.equal(classify(cancelled).kind, "cancelled");
	const terminal = new MainRetryEvidence(); terminal.observe({ stopReason: "error", errorMessage: "billing" }, "p/m", "high");
	assert.equal(classify(terminal, { isRetryable: () => false }).kind, "terminal-fault");
	assert.equal(classify(new MainRetryEvidence()).kind, "unknown");
});

test("direct worker retry evidence requires ordered exhaustion and stops on terminal outcomes", () => {
	const evidence = new WorkerRetryEvidence();
	const failed = { stopReason: "error", errorMessage: "temporary timeout" };
	assert.equal(evidence.classify({ final: failed, value: failed, actualEffort: "high", aborted: false }).kind, "unknown");
	evidence.observe({ type: "agent_end", willRetry: true });
	evidence.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: "temporary timeout" });
	evidence.observe({ type: "agent_end", willRetry: false });
	evidence.observe({ type: "auto_retry_end", success: false, attempt: 1 });
	assert.equal(evidence.classify({ final: failed, value: failed, actualEffort: "high", aborted: false }).kind, "retry-exhausted");
	assert.equal(evidence.classify({ final: failed, value: failed, actualEffort: "high", aborted: true }).kind, "cancelled");

	evidence.reset();
	for (const attempt of [1, 2]) {
		evidence.observe({ type: "agent_end", willRetry: true });
		evidence.observe({ type: "auto_retry_start", attempt, maxAttempts: 2, delayMs: 0, errorMessage: "temporary timeout" });
	}
	evidence.observe({ type: "agent_end", willRetry: false });
	evidence.observe({ type: "auto_retry_end", success: false, attempt: 2 });
	assert.equal(
		evidence.classify({ final: failed, value: failed, actualEffort: "high", aborted: false }).kind,
		"retry-exhausted",
		"complete ordered evidence accepts more than one Pi retry",
	);

	for (const errorMessage of ["billing account exhausted", "authentication failed", "maximum context length exceeded"]) {
		evidence.reset();
		evidence.observe({ type: "agent_end", willRetry: true });
		evidence.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 2 });
		evidence.observe({ type: "agent_end", willRetry: false });
		evidence.observe({ type: "auto_retry_end", success: false, attempt: 1 });
		assert.equal(evidence.classify({ final: { stopReason: "error", errorMessage }, value: errorMessage, actualEffort: "high", aborted: false, contextWindow: 1_000 }).kind, "terminal-fault");
	}

	evidence.reset();
	evidence.observe({ type: "agent_end", willRetry: true });
	evidence.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 2 });
	evidence.observe({ type: "agent_end", willRetry: false });
	evidence.observe({ type: "auto_retry_end", success: false, attempt: 1 });
	assert.equal(evidence.classify({ final: failed, value: failed, actualEffort: "high", aborted: false }).kind, "unknown");
	evidence.reset();
	evidence.observe({ type: "auto_retry_start", attempt: "bad", maxAttempts: 1 });
	assert.equal(evidence.classify({ final: failed, value: failed, actualEffort: "high", aborted: false }).kind, "unknown");
	assert.equal(evidence.classify({ final: { stopReason: "invented" }, value: "wrong", actualEffort: "medium", aborted: false }).kind, "unknown");
	const succeeded = { stopReason: "stop" };
	assert.equal(evidence.classify({ final: succeeded, value: "done", actualEffort: "medium", aborted: false }).kind, "success");
});

test("registered main hooks refuse busy overlap and recover only after proved exhaustion", { timeout: 2_000 }, async () => {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
	const sent: unknown[] = [];
	const warnings: string[] = [];
	let thinking: any = "max";
	let switches = 0;
	const sdkModel = (provider: string, id: string): Model<any> => ({
		provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
		maxTokens: 100, thinkingLevelMap: { max: "max" },
	} as Model<any>);
	const primary = sdkModel("p1", "m1");
	const fallback = sdkModel("p2", "m2");
	const ctx = {
		model: primary, cwd: "/tmp", hasUI: false,
		modelRegistry: {
			find(provider: string, id: string) { return provider === "p1" && id === "m1" ? primary : provider === "p2" && id === "m2" ? fallback : undefined; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(event: string, handler: (event: any, ctx: ExtensionContext) => Promise<unknown>) { handlers.set(event, handler); },
		async setModel(next: Model<any>) { switches++; (ctx as any).model = next; return true; },
		setThinkingLevel(level: string) { thinking = level; }, getThinkingLevel() { return thinking; },
		sendMessage(message: unknown) { sent.push(message); },
	} as unknown as ExtensionAPI;
	const runtime = createLogicalRuntime({
		trusted: true,
		projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "p1", providers: { p1: "m1", p2: "m2" } }] } } },
	});
	const base = createBaseModelTracker({ warn: (message) => warnings.push(message) });
	base.seed(primary, "max"); base.adoptLogicalIdentity("luna-6");
	registerOrchestratorFailover(pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime, () => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }));
	const turn = handlers.get("turn_end")!;
	const settle = handlers.get("agent_settled")!;
	await turn({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx);
	await settle({}, ctx);
	assert.equal(switches, 0, "a healthy settle never switches");
	const held = runtime.ownership.acquire("handoff", SAVED_DEFAULT_RESOURCE_KEY);
	assert.equal(held.kind, "acquired");
	await turn({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
	await settle({}, ctx);
	assert.equal(switches, 0);
	assert.equal(sent.length, 0);
	if (held.kind === "acquired") held.lease.release();
	await turn({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
	await settle({}, ctx);
	assert.equal(switches, 1);
	assert.equal(sent.length, 1);
	assert.match((sent[0] as any).content, /Do not replay a completed call/);
	assert.deepEqual(runtime.ownership.acquire("other", SAVED_DEFAULT_RESOURCE_KEY), { kind: "busy", resource: "saved-default", key: SAVED_DEFAULT_RESOURCE_KEY });
	await turn({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] } }, ctx);
	await settle({}, ctx);
	assert.equal(runtime.ownership.acquire("other", SAVED_DEFAULT_RESOURCE_KEY).kind, "acquired");
	assert.equal(base.currentLogicalIdentity(), "luna-6");
	assert.equal(warnings.some((message) => message.includes("main recovery stopped")), false);
});

test("main success publication preserves an external route or effort choice", { timeout: 2_000 }, async () => {
	for (const changed of ["route", "effort"] as const) {
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
		const warnings: string[] = [];
		const sdkModel = (provider: string, id: string): Model<any> => ({
			provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
			maxTokens: 100, thinkingLevelMap: { max: "max", low: "low" },
		} as Model<any>);
		const primary = sdkModel("p1", "m1");
		const fallback = sdkModel("p2", "m2");
		const external = sdkModel("outside", "chosen");
		const ctx = {
			model: primary, cwd: "/tmp", hasUI: false,
			modelRegistry: {
				find(provider: string, id: string) { return [primary, fallback, external].find((item) => item.provider === provider && item.id === id); },
				async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
			},
		} as unknown as ExtensionContext;
		let thinking: any = "max";
		const pi = {
			on(event: string, handler: any) { handlers.set(event, handler); },
			async setModel(next: Model<any>) { (ctx as any).model = next; return true; },
			setThinkingLevel(level: string) { thinking = level; }, getThinkingLevel() { return thinking; }, sendMessage() {},
		} as unknown as ExtensionAPI;
		const runtime = createLogicalRuntime({
			trusted: true,
			projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "p1", providers: { p1: "m1", p2: "m2" } }] } } },
		});
		const base = createBaseModelTracker({ warn: (message) => warnings.push(message) });
		base.seed(primary, "max");
		base.adoptLogicalIdentity("luna-6");
		registerOrchestratorFailover(pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime, () => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }));
		const turn = handlers.get("turn_end")!;
		const settle = handlers.get("agent_settled")!;
		await turn({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
		await settle({}, ctx);
		assert.equal((ctx as any).model, fallback, changed);
		if (changed === "route") (ctx as any).model = external;
		else thinking = "low";
		base.adoptLogicalIdentity(undefined);
		await turn({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "external choice" }] } }, ctx);
		const reports: string[] = [];
		const oldWarn = console.warn;
		console.warn = (message?: unknown) => reports.push(String(message));
		try { await settle({}, ctx); } finally { console.warn = oldWarn; }
		assert.deepEqual({ ...runtime.rememberedSelections().providers }, {}, changed);
		assert.equal(base.currentLogicalIdentity(), undefined, changed);
		assert.equal((ctx as any).model, changed === "route" ? external : fallback, changed);
		assert.equal(thinking, changed === "effort" ? "low" : "max", changed);
		assert.match(reports.join("\n"), /external choice was preserved/, changed);
		assert.deepEqual(warnings, [], changed);
	}
});

test("main transition guard retains ownership across overlapped settles and stale session replacement", { timeout: 2_000 }, async () => {
	const deferred = <T>() => {
		let resolve!: (value: T | PromiseLike<T>) => void;
		const promise = new Promise<T>((accept) => { resolve = accept; });
		return { promise, resolve };
	};
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
	const validation = deferred<void>();
	const setter = deferred<void>();
	const validationStarted = deferred<void>();
	const setterStarted = deferred<void>();
	const sent: unknown[] = [];
	const sdkModel = (provider: string, id: string): Model<any> => ({
		provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
		maxTokens: 100, thinkingLevelMap: { max: "max" },
	} as Model<any>);
	const primary = sdkModel("p1", "m1");
	const fallback = sdkModel("p2", "m2");
	const ctx = {
		model: primary, cwd: "/tmp", hasUI: false,
		modelRegistry: {
			find(provider: string, id: string) { return provider === primary.provider && id === primary.id ? primary : provider === fallback.provider && id === fallback.id ? fallback : undefined; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
		},
	} as unknown as ExtensionContext;
	let thinking: any = "max";
	const pi = {
		on(event: string, handler: (event: any, hookCtx: ExtensionContext) => Promise<unknown>) { handlers.set(event, handler); },
		async setModel(next: Model<any>) { setterStarted.resolve(); await setter.promise; (ctx as any).model = next; return true; },
		setThinkingLevel(level: string) { thinking = level; }, getThinkingLevel() { return thinking; },
		sendMessage(message: unknown) { sent.push(message); },
	} as unknown as ExtensionAPI;
	const ownershipScope = `test-settings:${Date.now()}:${Math.random()}`;
	const original = createLogicalRuntime({
		trusted: true,
		ownership: new RecoveryOwnership(ownershipScope),
		projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "p1", providers: { p1: "m1", p2: "m2" } }] } } },
	});
	const guarded = {
		...original,
		async validateRoute(hookCtx: Pick<ExtensionContext, "modelRegistry">, candidate: RecoveryCandidate) {
			validationStarted.resolve();
			await validation.promise;
			return original.validateRoute(hookCtx, candidate);
		},
	} as Readonly<LogicalRuntime>;
	let runtime: Readonly<LogicalRuntime> = guarded;
	let epoch = 1;
	let base = createBaseModelTracker({ warn() {} });
	base.seed(primary, "max");
	base.adoptLogicalIdentity("luna-6");
	registerOrchestratorFailover(
		pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime,
		() => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }), () => epoch,
	);
	const turn = handlers.get("turn_end")!;
	const settle = handlers.get("agent_settled")!;
	await turn({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
	const first = settle({}, ctx);
	await validationStarted.promise;
	assert.equal((await Promise.race([settle({}, ctx).then(() => "returned"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))])), "returned");
	assert.equal(original.ownership.acquire("handoff", SAVED_DEFAULT_RESOURCE_KEY).kind, "busy");
	validation.resolve();
	await setterStarted.promise;
	assert.equal((await Promise.race([settle({}, ctx).then(() => "returned"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))])), "returned");
	assert.equal(original.ownership.acquire("handoff", SAVED_DEFAULT_RESOURCE_KEY).kind, "busy");

	// The old factory keeps its local runtime and epoch. Real host shutdown retires
	// that factory owner, while the replacement factory gets a new scoped owner.
	original.ownership.retireLifecycle();
	const replacement = createLogicalRuntime({ trusted: true, ownership: new RecoveryOwnership(ownershipScope) });
	const replacementBase = createBaseModelTracker({ warn() {} });
	replacementBase.seed(primary, "max");
	assert.equal(replacement.ownership.acquire("handoff", SAVED_DEFAULT_RESOURCE_KEY).kind, "busy");
	setter.resolve();
	await first;
	assert.equal(sent.length, 0, "a stale switch cannot deliver a continuation");
	assert.equal(base.currentLogicalIdentity(), "luna-6", "the obsolete callback cannot alter its prior identity");
	assert.equal(replacementBase.currentLogicalIdentity(), undefined, "a stale completion cannot adopt identity in the replacement tracker");
	assert.equal(original.admit()?.snapshot.providers["luna-6"], undefined, "a stale completion cannot publish a provider preference");
	const after = replacement.ownership.acquire("handoff", SAVED_DEFAULT_RESOURCE_KEY);
	assert.equal(after.kind, "acquired", "only the completed original transition releases ownership");
	if (after.kind === "acquired") after.lease.release();
});

test("main recovery releases ownership after a thrown model switch", { timeout: 2_000 }, async () => {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
	const sdkModel = (provider: string, id: string): Model<any> => ({
		provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
		maxTokens: 100, thinkingLevelMap: { max: "max" },
	} as Model<any>);
	const primary = sdkModel("p1", "m1");
	const fallback = sdkModel("p2", "m2");
	const ctx = {
		model: primary, cwd: "/tmp", hasUI: false,
		modelRegistry: { find: (provider: string) => provider === "p2" ? fallback : primary, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) },
	} as unknown as ExtensionContext;
	const pi = {
		on(event: string, handler: any) { handlers.set(event, handler); }, getThinkingLevel: () => "max",
		setModel: async () => { throw new Error("setter fixture failure"); }, setThinkingLevel() {},
	} as unknown as ExtensionAPI;
	const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "p1", providers: { p1: "m1", p2: "m2" } }] } } } });
	const base = createBaseModelTracker({ warn() {} }); base.seed(primary, "max"); base.adoptLogicalIdentity("luna-6");
	registerOrchestratorFailover(pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime, () => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }));
	await handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
	await handlers.get("agent_settled")!({}, ctx);
	const next = runtime.ownership.acquire("handoff", SAVED_DEFAULT_RESOURCE_KEY);
	assert.equal(next.kind, "acquired");
	if (next.kind === "acquired") next.lease.release();
});

test("registered main recovery enters a duplicated physical pair only once", { timeout: 2_000 }, async () => {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
	const sdkModel = (provider: string, id: string): Model<any> => ({
		provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
		maxTokens: 100, thinkingLevelMap: { max: "max" },
	} as Model<any>);
	const models = [sdkModel("p1", "start"), sdkModel("p2", "duplicate"), sdkModel("p3", "final")];
	const ctx = {
		model: models[0], cwd: "/tmp", hasUI: false,
		modelRegistry: {
			find(provider: string, id: string) { return models.find((item) => item.provider === provider && item.id === id); },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
		},
	} as unknown as ExtensionContext;
	let thinking: any = "max";
	const switched: string[] = [];
	const pi = {
		on(event: string, handler: any) { handlers.set(event, handler); },
		async setModel(next: Model<any>) { switched.push(`${next.provider}/${next.id}`); (ctx as any).model = next; return true; },
		setThinkingLevel(level: string) { thinking = level; }, getThinkingLevel() { return thinking; }, sendMessage() {},
	} as unknown as ExtensionAPI;
	const runtime = createLogicalRuntime({
		trusted: true,
		projectConfig: { router: { models: {
			replace: [{ model: "luna-6", preferredProvider: "p1", providers: { p1: "start", p2: "duplicate" } }],
			add: [{ model: "duplicate-alias", capabilityRating: 45, costRating: 99, effort: "max", preferredProvider: "p2", providers: { p2: "duplicate", p3: "final" }, guidelines: [], cautions: [] }],
		} } },
	});
	const base = createBaseModelTracker({ warn() {} }); base.seed(models[0], "max"); base.adoptLogicalIdentity("luna-6");
	registerOrchestratorFailover(pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime, () => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }));
	const turn = handlers.get("turn_end")!;
	const settle = handlers.get("agent_settled")!;
	await turn({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
	await settle({}, ctx);
	await turn({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
	await settle({}, ctx);
	assert.deepEqual(switched, ["p2/duplicate", "p3/final"]);
});

test("registered main hooks stop on unmapped and ambiguous physical identity", { timeout: 2_000 }, async () => {
	for (const kind of ["none", "several"] as const) {
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
		let switches = 0;
		const model = { provider: "openai", id: kind === "none" ? "not-allowed" : "gpt-6-luna", contextWindow: 10_000 };
		const ctx = { model, cwd: "/tmp", hasUI: false, modelRegistry: {} } as unknown as ExtensionContext;
		const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, getThinkingLevel: () => "max", setModel: async () => { switches++; return true; } } as unknown as ExtensionAPI;
		const runtime = createLogicalRuntime({ trusted: true, projectConfig: kind === "several" ? { router: { models: { add: [{ model: "alias", capabilityRating: 45, costRating: 11, effort: "max", preferredProvider: "openai", providers: { openai: "gpt-6-luna" }, guidelines: [], cautions: [] }] } } } : undefined });
		const base = createBaseModelTracker({ warn() {} }); base.seed(model, "max");
		registerOrchestratorFailover(pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime, () => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }));
		await handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
		await handlers.get("agent_settled")!({}, ctx);
		assert.equal(switches, 0);
	}
});

test("registered main recovery reports each refusal and terminal operation outcome", { timeout: 2_000 }, async () => {
	const sdkModel = (provider: string, id: string): Model<any> => ({
		provider, id, name: id, api: "openai-responses", baseUrl: "https://invalid.example", reasoning: true,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
		maxTokens: 100, thinkingLevelMap: { max: "max" },
	} as Model<any>);
	const primary = sdkModel("p1", "m1");
	const fallback = sdkModel("p2", "m2");
	const run = async (mode: string) => {
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => warnings.push(String(message));
		let thinking: any = mode === "clamp" ? "low" : "max";
		let epoch = 1;
		let findCalls = 0;
		const ctx = {
			cwd: "/tmp", hasUI: false, model: primary,
			modelRegistry: {
				find(provider: string, id: string) {
					findCalls++;
					if (mode === "missing-after-validation" && provider === "p2" && findCalls > 1) return undefined;
					return provider === "p1" && id === "m1" ? primary : provider === "p2" && id === "m2" ? fallback : undefined;
				},
				async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
			},
		} as unknown as ExtensionContext;
		const pi = {
			on(event: string, handler: any) { handlers.set(event, handler); },
			getThinkingLevel: () => thinking,
			async setModel(next: Model<any>) { if (mode === "setter-false") return false; (ctx as any).model = next; return true; },
			setThinkingLevel(level: string) { if (mode !== "clamp") thinking = level; },
			sendMessage() { if (mode === "send-throw") throw new Error("send failed"); },
		} as unknown as ExtensionAPI;
		const original = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "p1", providers: { p1: "m1", p2: "m2" } }] } } } });
		let runtime: Readonly<LogicalRuntime> | undefined = original;
		if (mode === "blocked") runtime = undefined;
		if (mode === "critical") runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { compressor: { models: [] } } } });
		if (mode === "unsupported") runtime = { ...original, validateRoute: async () => ({ ok: false, kind: "unsupported", reason: "fixed effort unavailable" }) } as Readonly<LogicalRuntime>;
		if (mode === "unavailable") runtime = { ...original, validateRoute: async () => ({ ok: false, kind: "unavailable", reason: "credential unavailable" }) } as Readonly<LogicalRuntime>;
		if (mode === "empty-plan") runtime = { ...original, planOrdinary: () => [] } as Readonly<LogicalRuntime>;
		if (mode === "validation-throw") runtime = { ...original, validateRoute: async () => { throw new Error("validation failed"); } } as Readonly<LogicalRuntime>;
		const base = createBaseModelTracker({ warn() {} }); base.seed(primary, "max"); base.adoptLogicalIdentity("luna-6");
		registerOrchestratorFailover(pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime, () => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }), () => epoch);
		const turn = handlers.get("turn_end")!;
		const settle = handlers.get("agent_settled")!;
		try {
			await turn({ message: { role: "user", content: "ignored" } }, ctx);
			await handlers.get("input")!({}, ctx);
			await turn({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
			await settle({}, ctx);
			if (["cancelled", "terminal", "unknown", "stale"].includes(mode)) {
				if (mode === "stale") epoch++;
				else if (mode !== "unknown") await turn({ message: { role: "assistant", stopReason: mode === "cancelled" ? "aborted" : "error", errorMessage: mode === "terminal" ? "billing" : undefined } }, ctx);
				await settle({}, ctx);
			}
			return warnings.join("\n");
		} finally { console.warn = originalWarn; }
	};
	for (const [mode, expected] of [
		["blocked", /blocked by the logical model policy/], ["critical", /blocked by the logical model policy/],
		["unsupported", /fixed effort unavailable/], ["unavailable", /exhausted every permitted route/], ["missing-after-validation", /exhausted every permitted route/],
		["empty-plan", /exhausted every permitted route/], ["setter-false", /exhausted every permitted route/], ["clamp", /clamped effort/],
		["send-throw", /could not continue/], ["validation-throw", /main recovery failed/], ["cancelled", /main recovery stopped.*cancelled/s],
		["terminal", /main recovery stopped.*not an eligible transient provider fault/s], ["unknown", /main recovery stopped.*complete final assistant response/s], ["stale", /session was replaced/],
	] as const) assert.match(await run(mode), expected, mode);
});

test("registered main recovery fails closed before ownership on cancellation, terminal faults, and unknown evidence", { timeout: 2_000 }, async () => {
	for (const [message, expected] of [
		[{ role: "assistant", stopReason: "aborted" }, /run was cancelled/],
		[{ role: "assistant", stopReason: "error", errorMessage: "billing" }, /not an eligible transient provider fault/],
		[{ role: "assistant", stopReason: "error", errorMessage: "temporary timeout" }, /retries were disabled or unreadable/],
	] as const) {
		const handlers = new Map<string, any>();
		const warnings: string[] = [];
		const old = console.warn; console.warn = (value?: unknown) => warnings.push(String(value));
		const ctx = { model: { provider: "p", id: "m", contextWindow: 1000 }, hasUI: false } as unknown as ExtensionContext;
		const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, getThinkingLevel: () => "max" } as unknown as ExtensionAPI;
		registerOrchestratorFailover(pi, () => ({}), () => createBaseModelTracker({ warn() {} }), () => createLogicalRuntime({ trusted: true }), () => ({ enabled: message.errorMessage === "temporary timeout" ? false : true, maxRetries: 0, baseDelayMs: 0 }));
		try { await handlers.get("turn_end")({ message }, ctx); await handlers.get("agent_settled")({}, ctx); } finally { console.warn = old; }
		assert.match(warnings.join("\n"), expected);
	}
});

test("ordinary recovery uses provider-first exact-rating cost order and sparse alternation", () => {
	const value = policy();
	assert.deepEqual(ordinaryModelRecoveryOrder(value, "active").map((row) => row.model), [
		"active", "same-cheap", "same-expensive", "higher-cheap", "higher-expensive", "lower", "higher-far", "lower-far",
	]);
	const initial = planOrdinaryRecovery(value, "active", noPreferences);
	assert.deepEqual(initial.slice(0, 3).map((route) => route.provider), ["b", "a", "c"]);
	const rememberedUnavailable = planOrdinaryRecovery(value, "active", { ...noPreferences, providers: Object.freeze({ active: "missing" }) });
	assert.deepEqual(rememberedUnavailable.slice(0, 3).map((route) => route.provider), ["b", "a", "c"]);
	const plan = planOrdinaryRecovery(value, "active", { ...noPreferences, providers: Object.freeze({ active: "c" }) }, { provider: "a", model: "shared" });
	assert.deepEqual(plan.slice(0, 2).map((route) => `${route.provider}/${route.model}@${route.effort}`), ["c/active-c@high", "b/active-b@high"]);
	assert.equal(plan.some((route) => route.provider === "a" && route.model === "shared"), false);
	assert.equal(plan.every((route) => value.definitions[route.logicalModel]?.providers[route.provider] === route.model), true);
});

test("provider ordering keeps first-seen semantics with a large declaration and uses Set membership", () => {
	const providerCount = 12_000;
	const providers = Object.fromEntries(Array.from({ length: providerCount }, (_, index) => [`p${index}`, `model-${index}`]));
	const row = model("large", 50, 10, providers, "p1");
	const value: LogicalModelPolicy = { definitions: { large: row }, ordinary: [row], compressor: [{ model: "large", effort: "medium" }] };
	const plan = planOrdinaryRecovery(value, "large", { ...noPreferences, providers: Object.freeze({ large: "p11999" }) });
	assert.equal(plan.length, providerCount);
	assert.deepEqual(plan.slice(0, 4).map((candidate) => candidate.provider), ["p11999", "p1", "p0", "p2"]);
	assert.equal(new Set(plan.map((candidate) => candidate.provider)).size, providerCount);

	for (const path of ["extension/logical-model-runtime.ts", "extension/logical-model-recovery.ts"]) {
		const source = readFileSync(path, "utf8");
		const start = source.indexOf("function providerOrder(");
		const end = source.indexOf("\n}\n", start);
		assert.notEqual(start, -1, path);
		assert.notEqual(end, -1, path);
		const body = source.slice(start, end + 2);
		assert.match(body, /new Set<string>\(\)/, path);
		assert.match(body, /!seen\.has\(provider\)/, path);
		assert.match(body, /seen\.add\(provider\)/, path);
		assert.doesNotMatch(body, /order\.includes\(/, path);
	}
});

test("post-exhaustion planning excludes the active physical pair across logical identities", () => {
	const rows = [
		model("active", 50, 10, { p: "shared", q: "next" }, "p"),
		model("alias-identity", 50, 20, { p: "shared", r: "other" }, "p"),
	];
	const value: LogicalModelPolicy = { definitions: Object.fromEntries(rows.map((row) => [row.model, row])), ordinary: rows, compressor: [{ model: "active", effort: "medium" }] };
	const plan = planOrdinaryRecovery(value, "active", noPreferences, { provider: "p", model: "shared" });
	assert.deepEqual(plan.map((candidate) => `${candidate.logicalModel}:${candidate.provider}/${candidate.model}@${candidate.effort}`), ["active:q/next@high", "alias-identity:r/other@high"]);
});

test("one-sided ordinary recovery exhausts each entered rating by cost and configured ties", () => {
	const rows = [model("start", 10, 10, { p: "start" }), model("far-b", 30, 20, { p: "far-b" }), model("far-a", 30, 20, { p: "far-a" }), model("near", 20, 90, { p: "near" })];
	const value: LogicalModelPolicy = { definitions: Object.fromEntries(rows.map((row) => [row.model, row])), ordinary: rows, compressor: [{ model: "start", effort: "medium" }] };
	assert.deepEqual(ordinaryModelRecoveryOrder(value, "start").map((row) => row.model), ["start", "near", "far-b", "far-a"]);
});

test("operation-local visitation prevents repeated physical pairs across logical and compressor entries", { timeout: 2_000 }, async () => {
	const operation = new RecoveryOperation();
	assert.equal(operation.enter({ provider: "p", model: "m" }), true);
	assert.equal(operation.enter({ provider: "p", model: "m" }), false);
	assert.equal(operation.enter({ provider: "p2", model: "m" }), true);
	assert.equal(operation.visitedCount, 2);
	assert.equal(new RecoveryOperation().enter({ provider: "p", model: "m" }), true);

	let calls = 0;
	const duplicate = Object.freeze([
		{ kind: "ordinary", logicalModel: "one", effort: "high", provider: "p", model: "m" },
		{ kind: "ordinary", logicalModel: "two", effort: "low", provider: "p", model: "m" },
	] as const);
	const result = await executeRecovery({
		candidates: duplicate,
		retainedToolResults: [],
		validateSwitch: () => ({ ok: true }),
		attempt: () => { calls++; return { kind: "retry-exhausted" }; },
	});
	assert.equal(result.kind, "exhausted");
	assert.equal(calls, 1);
	assert.equal(result.attempted.length, 1);
});

test("preferences use admission freshness, reset invalidation, and no-backward compressor precedence", () => {
	const state = new RecoveryPreferences(policy());
	const earlier = state.admit();
	const later = state.admit();
	assert.equal(state.publishProvider(later, "active", "c"), true);
	assert.equal(state.publishProvider(earlier, "active", "a"), false);
	assert.equal(state.publishCompressor(earlier, 2), true);
	assert.equal(state.publishCompressor(later, 1), false);
	const after = state.admit();
	assert.equal(after.snapshot.providers.active, "c");
	assert.equal(after.snapshot.compressorIndex, 2);
	state.reset();
	assert.equal(state.publishProvider(after, "active", "b"), false);
	assert.equal(state.publishCompressor(after, 2), false);
	const reset = state.admit();
	assert.equal(reset.snapshot.providers.active, undefined);
	assert.equal(reset.snapshot.compressorIndex, 0);
});

test("compressor progression starts at remembered entry, moves only forward, and keeps entry effort", () => {
	const plan = planCompressorRecovery(policy(), { ...noPreferences, compressorIndex: 1 });
	assert.deepEqual(plan.map((entry) => [entry.compressorIndex, entry.logicalModel, entry.effort]), [[1, "same-cheap", "low"], [2, "higher-cheap", "max"]]);
});

test("execution advances only on known retry exhaustion and records actual effort", { timeout: 2_000 }, async () => {
	const candidates = planOrdinaryRecovery(policy(), "active", noPreferences).slice(0, 3);
	const seen: string[] = [];
	const retained = Object.freeze([{ id: "tool-1", value: "done" }]);
	const result = await executeRecovery({
		candidates,
		retainedToolResults: retained,
		validateSwitch: () => ({ ok: true }),
		attempt: ({ candidate, retainedToolResults }) => {
			assert.equal(retainedToolResults, retained);
			seen.push(candidate.model);
			return seen.length < 3 ? { kind: "retry-exhausted" } : { kind: "success", value: "ok", actualEffort: "medium" };
		},
	});
	assert.equal(result.kind, "success");
	if (result.kind === "success") assert.equal(result.actualEffort, "medium");
	assert.deepEqual(seen, candidates.map((candidate) => candidate.model));
});

test("cancellation, unknown evidence, terminal faults, and validation refusal stop without fallback", { timeout: 2_000 }, async () => {
	const candidates = planOrdinaryRecovery(policy(), "active", noPreferences).slice(0, 3);
	for (const terminal of [{ kind: "cancelled" }, { kind: "unknown", reason: "no retry evidence" }, { kind: "terminal-fault", reason: "authentication" }] as const) {
		let calls = 0;
		const result = await executeRecovery({ candidates, retainedToolResults: [], validateSwitch: () => ({ ok: true }), attempt: () => { calls++; return terminal; } });
		assert.equal(result.kind, terminal.kind);
		assert.equal(calls, 1);
	}
	let calls = 0;
	const refused = await executeRecovery({ candidates, retainedToolResults: [], validateSwitch: () => ({ ok: false, kind: "unsupported", reason: "unsupported effort" }), attempt: () => { calls++; return { kind: "retry-exhausted" }; } });
	assert.equal(refused.kind, "terminal-fault");
	assert.equal(calls, 0);
	let validations = 0;
	const unavailable = await executeRecovery({ candidates, retainedToolResults: [], validateSwitch: () => ++validations < 3 ? ({ ok: false, kind: "unavailable", reason: "not available" }) : ({ ok: true }), attempt: () => ({ kind: "success", value: "later", actualEffort: "high" }) });
	assert.equal(unavailable.kind, "success");
	assert.equal(validations, 3);
	const thrown = await executeRecovery({ candidates, retainedToolResults: [], validateSwitch: () => ({ ok: true }), attempt: () => { throw new Error("lost evidence"); } });
	assert.equal(thrown.kind, "unknown");
	assert.equal(thrown.kind === "unknown" ? thrown.reason : "", "Execution adapter threw before producing evidence.");
});

test("compression success and failure preserve completed identity and actual execution facts", { timeout: 2_000 }, async () => {
	const completed = Object.freeze({ text: "bounded completed output" });
	const compressed = Object.freeze({ text: "compressed output from the later candidate" });
	const retainedTools = Object.freeze([{ call: "already-completed" }]);
	const candidates = planCompressorRecovery(policy(), noPreferences);
	const attempted: typeof candidates[number][] = [];
	const success = await executeCompression(completed, {
		candidates, retainedToolResults: retainedTools, validateSwitch: () => ({ ok: true }),
		attempt: ({ candidate, retainedToolResults }) => {
			assert.equal(retainedToolResults, retainedTools);
			attempted.push(candidate);
			if (candidate === candidates[0]) return { kind: "retry-exhausted" };
			assert.equal(candidate, candidates[1]);
			return { kind: "success", value: compressed, actualEffort: "low" };
		},
	});
	assert.equal(success.completed, completed);
	assert.equal(success.compressed, compressed);
	assert.deepEqual(attempted, candidates.slice(0, 2));
	assert.equal(attempted.length, 2);
	assert.deepEqual(success.compression, { kind: "compressed", candidate: candidates[1], actualEffort: "low" });

	let calls = 0;
	const exhausted = await executeCompression(completed, {
		candidates, retainedToolResults: retainedTools, validateSwitch: () => ({ ok: true }),
		attempt: ({ retainedToolResults }) => { calls++; assert.equal(retainedToolResults, retainedTools); return { kind: "retry-exhausted" }; },
	});
	assert.equal(exhausted.completed, completed);
	assert.equal(exhausted.compression.kind, "failed");
	assert.equal(calls, new Set(candidates.map((item) => `${item.provider}/${item.model}`)).size);
	const cancelled = await executeCompression(completed, { candidates, retainedToolResults: retainedTools, validateSwitch: () => ({ ok: true }), attempt: () => ({ kind: "cancelled" }) });
	assert.equal(cancelled.completed, completed);
	assert.match(cancelled.compression.kind === "failed" ? cancelled.compression.notice : "", /cancelled/);
});

test("ownership refuses overlap promptly but permits independent sessions and saved-default resources", () => {
	const ownership = new RecoveryOwnership();
	const first = ownership.acquire("s1", "global");
	assert.equal(first.kind, "acquired");
	assert.deepEqual(ownership.acquire("s1", "other"), { kind: "busy", resource: "execution-session", key: "s1" });
	assert.deepEqual(ownership.acquire("s2", "global"), { kind: "busy", resource: "saved-default", key: "global" });
	const independent = ownership.acquire("worker-2");
	assert.equal(independent.kind, "acquired");
	if (independent.kind === "acquired") independent.lease.release();
	if (first.kind === "acquired") first.lease.release();
	assert.equal(ownership.acquire("s2", "global").kind, "acquired");

	const scoped = new RecoveryOwnership("settings-a").acquire("a", "global");
	assert.equal(scoped.kind, "acquired");
	const unrelated = new RecoveryOwnership("settings-b").acquire("b", "global");
	assert.equal(unrelated.kind, "acquired");
	if (scoped.kind === "acquired") scoped.lease.release();
	if (unrelated.kind === "acquired") unrelated.lease.release();
});

test("ownership releases after success, cancellation outcome, failure outcome, and exception", { timeout: 2_000 }, async () => {
	const ownership = new RecoveryOwnership();
	for (const value of ["success", "cancelled", "failure"] as const) {
		const result = await executeWithRecoveryOwnership(ownership, "session", "global", () => value);
		assert.deepEqual(result, { kind: "completed", value });
		const next = ownership.acquire("session", "global");
		assert.equal(next.kind, "acquired");
		if (next.kind === "acquired") next.lease.release();
	}
	const thrown = await executeWithRecoveryOwnership(ownership, "session", "global", () => { throw new Error("boom"); });
	assert.equal(thrown.kind, "exception");
	assert.equal(ownership.acquire("session", "global").kind, "acquired");
});

test("replacement retains live ownership until the original callback settles", { timeout: 2_000 }, async () => {
	for (const replace of [
		(ownership: RecoveryOwnership) => ownership.replaceSession("session"),
		(ownership: RecoveryOwnership) => ownership.replaceLifecycle(),
	]) {
		const ownership = new RecoveryOwnership();
		let releaseExecution!: () => void;
		const suspended = new Promise<void>((resolve) => { releaseExecution = resolve; });
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => { started = resolve; });
		const first = executeWithRecoveryOwnership(ownership, "session", "global", async () => {
			started();
			await suspended;
			return "first";
		});
		await didStart;
		replace(ownership);
		let conflictingCalls = 0;
		const conflict = await executeWithRecoveryOwnership(ownership, "replacement", "global", () => { conflictingCalls++; return "wrong"; });
		assert.deepEqual(conflict, { kind: "busy", resource: "saved-default", key: "global" });
		assert.equal(conflictingCalls, 0);
		const independentReplacement = ownership.acquire("session", "other");
		assert.equal(independentReplacement.kind, "acquired");
		if (independentReplacement.kind === "acquired") independentReplacement.lease.release();
		releaseExecution();
		assert.deepEqual(await first, { kind: "completed", value: "first" });
		const replacement = ownership.acquire("replacement", "global");
		assert.equal(replacement.kind, "acquired");
		if (replacement.kind === "acquired") replacement.lease.release();
	}
});
