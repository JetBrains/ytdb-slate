import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH as PLATFORM_OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { RoutePlanProceed } from "../extension/route.ts";
import {
  DEFAULT_CACHE_KEY_SHARDS,
  MAX_CACHE_KEY_SHARDS,
  sanitizeCacheKeyEnabled,
  sanitizeCacheKeyShards,
  SlateStore,
  type ThreadRecord,
} from "../extension/state.ts";
import { ThreadManager, workerPromptCacheKey, type DispatchOptions } from "../extension/threads.ts";
import {
  OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
  openWorkerSession,
  type WorkerSession,
} from "../extension/worker.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-cache-key-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";

const sessions: WorkerSession[] = [];

after(() => {
  for (const session of sessions) session.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  rmSync(scratch, { recursive: true, force: true });
});

function context(name: string): ExtensionContext {
  return {
    cwd: join(scratch, name),
    hasUI: false,
    isProjectTrusted: () => false,
    model: undefined,
  } as unknown as ExtensionContext;
}

async function open(name: string, promptCacheKey?: string): Promise<WorkerSession> {
  const session = await openWorkerSession({ ctx: context(name), promptCacheKey });
  sessions.push(session);
  return session;
}

function model(api: Api): Model<Api> {
  return { api, provider: "test", id: "test" } as unknown as Model<Api>;
}

async function applyPayload(session: WorkerSession, payload: unknown, api: Api = "openai-responses"): Promise<unknown> {
  const callback = session.agent.onPayload;
  assert.ok(callback, "worker session must install an onPayload callback");
  return callback(payload, model(api));
}

interface RunnerView {
  hasHandlers(event: string): boolean;
  emitBeforeProviderRequest(payload: unknown): Promise<unknown>;
}

function runner(session: WorkerSession): RunnerView {
  return session.extensionRunner as unknown as RunnerView;
}

const OTHER_INTERFACES: Api[] = [
  "openai-completions",
  "mistral-conversations",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
  "unrecognized-provider-interface",
];

test("worker cache wrapper changes only OpenAI Responses payloads and preserves headers and agent identity", { timeout: 5000 }, async () => {
  const session = await open("interfaces", "stable-shard");
  const headers = { authorization: "unchanged", "x-test": "same-object" };
  const payload: Record<string, unknown> & { headers: typeof headers } = { model: "test", input: [], headers };
  const sessionId = session.agent.sessionId;

  const changed = await applyPayload(session, payload);
  assert.strictEqual(changed, payload);
  assert.equal(payload.prompt_cache_key, "stable-shard");
  assert.strictEqual(payload.headers, headers);
  assert.deepEqual(headers, { authorization: "unchanged", "x-test": "same-object" });
  assert.equal(session.agent.sessionId, sessionId);

  for (const api of OTHER_INTERFACES) {
    const untouched = { model: "test", input: [], headers: { "x-interface": api } };
    const snapshot = structuredClone(untouched);
    const result = await applyPayload(session, untouched, api);
    assert.strictEqual(result, untouched, `${api} must preserve payload identity`);
    assert.deepEqual(untouched, snapshot, `${api} must preserve every payload field`);
  }
});

test("worker cache wrapper preserves the OpenAI Responses retention opt-out", { timeout: 5000 }, async () => {
  const session = await open("retention-none", "stable-shard");
  let capturedPayload: unknown;
  let releaseCapture: ((payload: unknown) => void) | undefined;
  const captured = new Promise<unknown>((resolve) => {
    releaseCapture = resolve;
  });
  const providerStream = streamOpenAIResponses(
    {
      api: "openai-responses",
      provider: "openai",
      id: "test-model",
      name: "test-model",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    },
    { systemPrompt: "", messages: [], tools: [] },
    {
      apiKey: "test-key",
      cacheRetention: "none",
      sessionId: "platform-session-id",
      onPayload: async (payload, payloadModel) => {
        capturedPayload = await session.agent.onPayload?.(payload, payloadModel);
        releaseCapture?.(capturedPayload);
        return capturedPayload;
      },
      fetch: async () => { throw new Error("stop after payload capture"); },
    },
  );
  const drain = (async () => {
    for await (const _event of providerStream) {
      // Consume the expected provider error after payload capture.
    }
  })();

  const result = await captured;
  await drain;
  assert.strictEqual(result, capturedPayload);
  assert.equal(typeof result, "object");
  assert.notEqual(result, null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "prompt_cache_key"), true);
  assert.equal((result as Record<string, unknown>).prompt_cache_key, undefined);
});

test("worker cache wrapper is inert without a key and pins the platform length boundary", { timeout: 5000 }, async () => {
  const inertSession = await open("no-key");
  const inertPayload = { input: ["unchanged"] };
  assert.strictEqual(await applyPayload(inertSession, inertPayload), inertPayload);
  assert.deepEqual(inertPayload, { input: ["unchanged"] });

  assert.equal(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, PLATFORM_OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
  assert.equal(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, 64);
  const limitKey = "k".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
  const limitSession = await open("at-limit", limitKey);
  const limitPayload: Record<string, unknown> = {};
  assert.strictEqual(await applyPayload(limitSession, limitPayload), limitPayload);
  assert.equal(limitPayload.prompt_cache_key, limitKey);

  const longSession = await open("over-limit", `${limitKey}x`);
  const longPayload: Record<string, unknown> = {};
  assert.strictEqual(await applyPayload(longSession, longPayload), longPayload);
  assert.equal("prompt_cache_key" in longPayload, false);
});

test("worker cache wrapper chains platform results and contains platform and wrapper failures", { timeout: 5000 }, async () => {
  const session = await open("chain", "stable-shard");
  const platformRunner = runner(session);
  platformRunner.hasHandlers = () => true;

  let platformCalled = false;
  platformRunner.emitBeforeProviderRequest = async (payload) => {
    platformCalled = true;
    return { ...(payload as object), platform: "result" };
  };
  const original = { original: true };
  const transformed = await applyPayload(session, original);
  assert.equal(platformCalled, true);
  assert.notStrictEqual(transformed, original);
  assert.deepEqual(transformed, { original: true, platform: "result", prompt_cache_key: "stable-shard" });
  assert.deepEqual(original, { original: true });

  platformRunner.emitBeforeProviderRequest = async () => undefined;
  const undefinedOriginal: Record<string, unknown> = { survives: "undefined result" };
  assert.strictEqual(await applyPayload(session, undefinedOriginal), undefinedOriginal);
  assert.equal(undefinedOriginal.prompt_cache_key, "stable-shard");

  platformRunner.emitBeforeProviderRequest = async () => null;
  const nullOriginal: Record<string, unknown> = { survives: "null result" };
  const nullResult = await applyPayload(session, nullOriginal);
  assert.strictEqual(nullResult, nullOriginal);
  assert.notEqual(nullResult, undefined);
  assert.notEqual(nullResult, null);

  platformRunner.emitBeforeProviderRequest = async () => {
    throw new Error("platform callback failed");
  };
  const thrownOriginal = { survives: "throw" };
  const thrownResult = await applyPayload(session, thrownOriginal);
  assert.strictEqual(thrownResult, thrownOriginal);
  assert.deepEqual(thrownOriginal, { survives: "throw" });

  platformRunner.emitBeforeProviderRequest = async (payload) => payload;
  const wrapperFailure = new Proxy<Record<string, unknown>>(
    { survives: "wrapper failure" },
    { set: () => { throw new Error("payload is read-only"); } },
  );
  const failureResult = await applyPayload(session, wrapperFailure);
  assert.strictEqual(failureResult, wrapperFailure);
  assert.notEqual(failureResult, undefined);
  assert.notEqual(failureResult, null);

  const primitiveResult = await applyPayload(session, "non-object payload");
  assert.equal(primitiveResult, "non-object payload");
});

interface ManagerAccess {
  createThread(opts: DispatchOptions, plan: RoutePlanProceed): ThreadRecord;
}

function store(): SlateStore {
  return new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
}

function access(manager: ThreadManager): ManagerAccess {
  return manager as unknown as ManagerAccess;
}

const PROCEED = { kind: "proceed" } as unknown as RoutePlanProceed;

test("project namespaces isolate shard keys while preserving within-project grouping", () => {
  const firstProject = join(scratch, "first-project");
  const secondProject = join(scratch, "second-project");
  const sharedA = workerPromptCacheKey(firstProject, 1);
  const sharedB = workerPromptCacheKey(firstProject, 1);
  const isolated = workerPromptCacheKey(secondProject, 1);

  assert.equal(sharedA, sharedB);
  assert.notEqual(sharedA, isolated);
  assert.equal(sharedA.includes(firstProject), false);
  assert.match(sharedA, /^slate-worker-[0-9a-f]{16}-1$/);

  const worstCase = workerPromptCacheKey(firstProject, MAX_CACHE_KEY_SHARDS - 1);
  assert.equal(worstCase.length, 32);
  assert.ok(worstCase.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
});

test("new threads receive stable round-robin shards with a two-shard default", () => {
  const slateStore = store();
  const manager = new ThreadManager(slateStore, {});
  const internal = access(manager);

  const first = internal.createThread({ task: "first", type: "general" }, PROCEED);
  const second = internal.createThread({ task: "second", type: "general" }, PROCEED);
  const third = internal.createThread({ task: "third", type: "general" }, PROCEED);

  assert.deepEqual([first.cacheKeyShard, second.cacheKeyShard, third.cacheKeyShard], [0, 1, 0]);
  assert.equal(first.cacheKeyShard, 0);
  assert.strictEqual(slateStore.threads.get(first.id), first);
  assert.equal(first.cacheKeyShard, 0);
});

test("the dedicated cache-key switch disables shard assignment while the default stays on", () => {
  const disabledStore = store();
  const disabled = access(new ThreadManager(disabledStore, { cacheKeyEnabled: false, cacheKeyShards: 3 }));
  const thread = disabled.createThread({ task: "disabled", type: "general" }, PROCEED);
  assert.equal(thread.cacheKeyShard, undefined);
  assert.equal("cacheKeyShard" in thread, false);

  const defaultStore = store();
  const defaulted = access(new ThreadManager(defaultStore, {}));
  assert.deepEqual(
    [defaulted.createThread({ task: "first", type: "general" }, PROCEED).cacheKeyShard,
      defaulted.createThread({ task: "second", type: "general" }, PROCEED).cacheKeyShard],
    [0, 1],
  );

  const warnings: string[] = [];
  assert.equal(sanitizeCacheKeyEnabled(false, (warning) => warnings.push(warning)), false);
  assert.equal(sanitizeCacheKeyEnabled(undefined, (warning) => warnings.push(warning)), true);
  assert.deepEqual(warnings, []);

  const malformedWarnings: string[] = [];
  assert.equal(sanitizeCacheKeyEnabled("false", (warning) => malformedWarnings.push(warning)), true);
  assert.equal(malformedWarnings[0], "slate: ignoring cacheKeyEnabled false — expected a boolean. Using true.");
});

test("configured shard counts are honored and invalid counts warn before defaulting", () => {
  const configuredStore = store();
  const configured = access(new ThreadManager(configuredStore, { cacheKeyShards: 3 }));
  const shards = [0, 1, 2, 3].map((index) => configured.createThread({ task: `task ${index}`, type: "general" }, PROCEED).cacheKeyShard);
  assert.deepEqual(shards, [0, 1, 2, 0]);

  for (const invalid of [0, MAX_CACHE_KEY_SHARDS + 1, 1.5]) {
    const warnings: string[] = [];
    const sanitized = sanitizeCacheKeyShards(invalid, (warning) => warnings.push(warning));
    assert.equal(sanitized, DEFAULT_CACHE_KEY_SHARDS);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], `slate: ignoring cacheKeyShards ${invalid} — expected an integer from 1 to 64. Using 2.`);
  }

  const validWarnings: string[] = [];
  assert.equal(sanitizeCacheKeyShards(undefined, (warning) => validWarnings.push(warning)), DEFAULT_CACHE_KEY_SHARDS);
  assert.equal(sanitizeCacheKeyShards(1, (warning) => validWarnings.push(warning)), 1);
  assert.equal(sanitizeCacheKeyShards(MAX_CACHE_KEY_SHARDS, (warning) => validWarnings.push(warning)), MAX_CACHE_KEY_SHARDS);
  assert.deepEqual(validWarnings, []);
});
