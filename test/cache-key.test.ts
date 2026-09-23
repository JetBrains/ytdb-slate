import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH as PLATFORM_OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import {
  sanitizeCacheKeyEnabled,
} from "../extension/state.ts";
import { createSessionPromptCacheKey } from "../extension/threads.ts";
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
  mkdirSync(join(scratch, name), { recursive: true });
  return {
    cwd: join(scratch, name),
    hasUI: false,
    isProjectTrusted: () => false,
    model: undefined,
    modelRegistry: {
      getRegisteredProviderIds: () => [],
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    },
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
    normalizeContext({ systemPrompt: "", messages: [], tools: [] }),
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


test("one main-session key can be shared across worker sessions and models", { timeout: 5000 }, async () => {
  const key = createSessionPromptCacheKey();
  const first = await open("shared-first", key);
  const second = await open("shared-second", key);
  const firstPayload: Record<string, unknown> = {};
  const secondPayload: Record<string, unknown> = {};
  await first.agent.onPayload?.(firstPayload, { ...model("openai-responses"), provider: "openai", id: "a" });
  await second.agent.onPayload?.(secondPayload, { ...model("openai-responses"), provider: "openai", id: "b" });
  assert.equal(firstPayload.prompt_cache_key, key);
  assert.equal(secondPayload.prompt_cache_key, key);
  assert.match(key, /^slate-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(key.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
});

test("different main sessions receive different path-free keys", () => {
  const first = createSessionPromptCacheKey();
  const second = createSessionPromptCacheKey();
  assert.notEqual(first, second);
  assert.equal(first.includes(scratch), false);
});

test("cache-key validation keeps its independent opt-out", () => {
  const warnings: string[] = [];
  assert.equal(sanitizeCacheKeyEnabled(false, (warning) => warnings.push(warning)), false);
  assert.equal(sanitizeCacheKeyEnabled(undefined, (warning) => warnings.push(warning)), true);
  assert.equal(warnings.length, 0);
  assert.equal(sanitizeCacheKeyEnabled("false", (warning) => warnings.push(warning)), true);
  assert.match(warnings[0] ?? "", /cacheKeyEnabled.*expected a boolean/);
});
