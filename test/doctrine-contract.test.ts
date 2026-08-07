import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { PROFILES_AS_OF, MODEL_PROFILES, ladderFor } from "../extension/model-profiles.ts";
import { ROUTER_OFF, type ModelRouterResolution, type RouterCandidate } from "../extension/model-router.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { THREAD_CACHE_COST_DOC } from "../extension/paths.ts";
import { SlateStore, type SlateConfig } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-doctrine-contract-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

type Handler = (event: any, context: ExtensionContext) => unknown;

class FakeExtensionApi {
  readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(): void {}
  registerTool(): void {}
  getActiveTools(): string[] { return []; }
  setActiveTools(): void {}
  getAllTools(): Array<{ name: string }> { return []; }
  appendEntry(): void {}
  sendMessage(): void {}
  getThinkingLevel(): undefined { return undefined; }

  async emit(event: string, payload: unknown, context: ExtensionContext): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, context));
    return results;
  }
}

function extensionContext(cwd: string, warnings: string[] = []): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
    },
    ui: {
      notify: (message: string) => warnings.push(message),
      setWidget: () => {},
      setStatus: () => {},
    },
  } as unknown as ExtensionContext;
}

function routedResolution(): ModelRouterResolution {
  const profile = MODEL_PROFILES[0];
  assert.ok(profile);
  const price = profile.price.at(-1);
  assert.ok(price);
  const candidate: RouterCandidate = {
    spec: profile.id,
    provider: profile.id.split("/")[0] ?? "",
    id: profile.id.split("/")[1] ?? "",
    profile,
    tier: profile.tier,
    inUsdPerMTok: price.inUsdPerMTok,
    outUsdPerMTok: price.outUsdPerMTok,
    registryCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow ?? undefined,
    ladder: ladderFor(profile),
    hasFailover: true,
    nonPreferred: profile.nonPreferred,
    tierUnsourced: profile.tierUnsourced === true,
    ladderAssumed: profile.ladderAssumed === true,
  };
  return {
    on: true,
    candidates: [candidate],
    cheapest: candidate.spec,
    cheapestNonPreferred: false,
    warnings: [],
  };
}

async function renderDoctrine(router?: ModelRouterResolution, config: SlateConfig = {}): Promise<string> {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  registerSlateMode(
    api as unknown as ExtensionAPI,
    store,
    {
      startHandoff: async () => {},
      effectiveContextBudget: () => undefined,
    } as any,
    () => config,
    () => EMPTY_WORKER_EXTENSION_SET,
    router === undefined ? undefined : () => router,
  );
  const handler = api.handlers.get("before_agent_start")?.[0];
  assert.ok(handler);
  const result = await handler({ systemPrompt: "BASE" }, extensionContext(scratch)) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("BASE"));
  return result.systemPrompt.slice("BASE".length);
}

test("routing doctrine renders dated prices and truthful candidate ordering", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(routedResolution());
  const priceDate = /Prices include dated updates after (\d{4}-\d{2}-\d{2}) research\./.exec(doctrine)?.[1];
  assert.equal(priceDate, PROFILES_AS_OF);
  assert.match(doctrine, /Candidates\s+follow preference, tier sourcing, tier, price, then specification\./);
  assert.doesNotMatch(doctrine, /Route every action to the cheapest model and effort that clears it\./);
  assert.doesNotMatch(doctrine, /Prices as of \d{4}-\d{2}-\d{2} are base rates:/);
  assert.match(doctrine, /A model or effort change empties the prompt cache\. Rewrites cost 12\.5 times cache reads\./);
});

test("thread-choice doctrine defines work streams, consent, restart limits, and its shipped reference", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(routedResolution());
  assert.match(doctrine, /3\. Keep each work stream in one thread\./);
  assert.match(doctrine, /Omit `freshContext` on creation\./);
  assert.match(doctrine, /On\s+continuations, it is required with `threadChoice\.act: true`\s+and optional otherwise\./);
  assert.match(doctrine, /With acting off, omit it for no permission or supply it for a reported choice\./);
  assert.match(doctrine, /`\[\]`\s+refuses a restart and preserves the live transcript\./);
  assert.match(doctrine, /A non-empty list of existing\s+episode ids permits a restart and seeds the new thread\./);
  assert.doesNotMatch(doctrine, /Omission while required fails\./);
  assert.doesNotMatch(doctrine, /Any supplied malformed value or unknown id fails before state changes\./);
  assert.doesNotMatch(doctrine, /A valid creation value is accepted but unused\./);
  assert.doesNotMatch(doctrine, /Treat a different model or effort as cold,\s+with no prefix reuse\./);
  const citation = /Details:\s+([^\n]+)$/m.exec(doctrine)?.[1]?.trim();
  assert.equal(citation, THREAD_CACHE_COST_DOC);
  assert.equal(existsSync(THREAD_CACHE_COST_DOC), true);
});

test("routing off adds no doctrine bytes", { timeout: 5000 }, async () => {
  const defaultOff = await renderDoctrine();
  const explicitOff = await renderDoctrine(ROUTER_OFF);
  assert.equal(explicitOff, defaultOff);
  assert.doesNotMatch(explicitOff, /Routable this session/);
  assert.doesNotMatch(explicitOff, /Prices include dated updates/);
  assert.doesNotMatch(explicitOff, /Prices as of/);
});

test("entry configuration accepts valid cache shards and rejects invalid counts", { timeout: 5000 }, async () => {
  const run = async (name: string, cacheKeyShards: number): Promise<string[]> => {
    const cwd = join(scratch, name);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify({ cacheKeyShards }));
    const api = new FakeExtensionApi();
    slateExtension(api as unknown as ExtensionAPI);
    const warnings: string[] = [];
    await api.emit("session_start", {}, extensionContext(cwd, warnings));
    return warnings;
  };

  const validWarnings = await run("valid", 3);
  assert.equal(validWarnings.some((warning) => warning.includes("cacheKeyShards")), false);

  const invalidWarnings = await run("invalid", 0);
  assert.equal(invalidWarnings.length, 1);
  assert.match(invalidWarnings[0] ?? "", /cacheKeyShards.*expected an integer from 1 to 64/);
});
