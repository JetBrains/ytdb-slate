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
import { PR_PUBLISHING_DOC, REVIEW_RULES_DOC, THREAD_CACHE_COST_DOC, TRACK_WORKFLOW_DOC } from "../extension/paths.ts";
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

function extensionContext(cwd: string, warnings: string[] = [], trusted = true): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getSessionId: () => "doctrine-test-session",
      getSessionFile: () => join(cwd, "doctrine-test-session.jsonl"),
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

async function renderDoctrine(router?: ModelRouterResolution, config: SlateConfig = {}, trusted = true): Promise<string> {
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
  const result = await handler({ systemPrompt: "BASE" }, extensionContext(scratch, [], trusted)) as { systemPrompt: string };
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
  // Behavioural coverage lives in dispatch-choice.test.ts's rejection tests, not these text guards.
  assert.doesNotMatch(doctrine, /Omission while required fails\./);
  assert.doesNotMatch(doctrine, /Any supplied malformed value or unknown id fails before state changes\./);
  assert.doesNotMatch(doctrine, /A valid creation value is accepted but unused\./);
  assert.doesNotMatch(doctrine, /Treat a different model or effort as cold,\s+with no prefix reuse\./);
  const citation = /Details:\s+([^\n]+)$/m.exec(doctrine)?.[1]?.trim();
  assert.equal(citation, THREAD_CACHE_COST_DOC);
  assert.equal(existsSync(THREAD_CACHE_COST_DOC), true);
});

test("doctrine reads workflow only for changes and enforces size-focus confirmation", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Scale change gates by size grade: SMALL, MEDIUM, or LARGE."));
  assert.ok(doctrine.includes("Predict focus areas separately."));
  assert.ok(doctrine.includes(`For repository changes, read ${TRACK_WORKFLOW_DOC} (skip the read if it is already in your context).`));
  assert.ok(doctrine.includes("Before the first file-modifying dispatch, confirm the user confirmed the predicted grade and focus set, and every required pre-implementation gate ran."));
});

test("design gates state validation, adversarial review, and final approval as one ordered contract", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Validate each required design before adversarial design review, then obtain final user approval."));
  assert.doesNotMatch(doctrine, /final user approval before adversarial design review/);
});

test("doctrine states research-log, packet, acceptance, and reviewer rules", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("MEDIUM and LARGE always keep a research log; SMALL opens one on a listed trigger."));
  assert.ok(doctrine.includes("Track packets are non-blocking, but final change acceptance is blocking."));
  assert.ok(doctrine.includes("Review every track with the set required by its grade and engaged focus areas."));
  assert.ok(doctrine.includes("Verification or gate machinery receives the general implementation reviewer even at SMALL."));
  assert.ok(doctrine.includes(`Before dispatching review threads, read ${REVIEW_RULES_DOC}`));
});

test("rule 8 renders the exact research-log and draft-publishing tails", { timeout: 5000 }, async () => {
  const local = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(local.includes("Durable workflow records anchor in the retained repo-root research log per the workflow doc."));
  assert.doesNotMatch(local, /repo-root workflow log/);
  assert.equal(local.includes(PR_PUBLISHING_DOC), false);

  const published = (await renderDoctrine(undefined, { workflow: { draftPRs: true } })).replace(/\s+/g, " ");
  assert.ok(published.includes("An umbrella draft PR is part of the pre-implementation gates;"));
  assert.ok(published.includes(`PR publishing mechanics are in ${PR_PUBLISHING_DOC}.`));
  assert.doesNotMatch(published, /repo-root (?:workflow|research) log/);
});

test("doctrine states the exact restart-refusal test", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("A blanket refusal of a thread restart has a price. Refuse only when the next action depends on context from the previous action that the thread's episodes do not carry."));
});

test("follow-up issue doctrine renders after review only when enabled", { timeout: 5000 }, async () => {
  const sentence = "After review, ask the user which review suggestions become tracker issues.";
  assert.ok((await renderDoctrine(undefined, { workflow: { followUpIssues: true } })).includes(sentence));
  assert.equal((await renderDoctrine(undefined, { workflow: { followUpIssues: false } })).includes(sentence), false);
  assert.equal((await renderDoctrine()).includes(sentence), false);
});

test("untrusted follow-up issue configuration leaves doctrine byte-identical", { timeout: 5000 }, async () => {
  const enabled = await renderDoctrine(undefined, { workflow: { followUpIssues: true } }, false);
  const absent = await renderDoctrine(undefined, {}, false);
  assert.equal(enabled, absent);
  assert.doesNotMatch(enabled, /After review, ask the user which review suggestions become tracker issues\./);
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
