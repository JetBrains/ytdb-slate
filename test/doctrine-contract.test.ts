import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test as nodeTest } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { PROFILES_AS_OF, MODEL_PROFILES, ladderFor } from "../extension/model-profiles.ts";
import { ROUTER_OFF, type ModelRouterResolution, type RouterCandidate } from "../extension/model-router.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { PR_PUBLISHING_DOC, REVIEW_RULES_DOC, TRACK_WORKFLOW_DOC } from "../extension/paths.ts";
import { SlateStore, type SlateConfig } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-doctrine-contract-"));

const EXPECTED_TESTS = [
  "paused doctrine names both handoff steps",
  "routing doctrine renders dated prices and truthful candidate ordering",
  "single-action doctrine requires new threads and episode references",
  "doctrine reads workflow only for changes and enforces size-focus confirmation",
  "design gates state validation, adversarial review, and final approval as one ordered contract",
  "doctrine states research-log, packet, acceptance, and reviewer rules",
  "rule 8 renders the exact research-log and draft-publishing tails",
  "retired archive state changes neither doctrine nor visible or headless warnings",
  "follow-up issue doctrine renders after review only when enabled",
  "untrusted follow-up issue configuration leaves doctrine byte-identical",
  "routing off adds no doctrine bytes",
  "entry configuration accepts valid cache shards and rejects invalid counts",
] as const;
const registeredTests: string[] = [];

function test(name: string, options: { timeout: number }, run: () => void | Promise<void>): void {
  registeredTests.push(name);
  nodeTest(name, options, run);
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
  assert.deepEqual(registeredTests, [...EXPECTED_TESTS], "the independent doctrine-test roster must match every registered test in order");
});

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

function extensionContext(
  cwd: string,
  warnings: string[] = [],
  trusted = true,
  hasUI = true,
): ExtensionContext {
  return {
    cwd,
    hasUI,
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

interface RetiredArchiveState {
  project?: SlateStore["corpusProject"];
  sessionName?: string;
}

async function captureConsoleWarnings<T>(warnings: string[], run: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
    originalWarn(...args);
  };
  try {
    return await run();
  } finally {
    console.warn = originalWarn;
  }
}

async function renderDoctrine(
  router?: ModelRouterResolution,
  config: SlateConfig = {},
  trusted = true,
  paused = false,
  retiredState: RetiredArchiveState = {},
  warnings: string[] = [],
  hasUI = true,
): Promise<string> {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  store.paused = paused;
  store.corpusProject = retiredState.project;
  store.slateSessionName = retiredState.sessionName;
  registerSlateMode(
    api as unknown as ExtensionAPI,
    store,
    {
      startHandoff: async () => {},
      adoptHandoff: async () => false,
      effectiveContextBudget: () => undefined,
    } as any,
    () => config,
    () => EMPTY_WORKER_EXTENSION_SET,
    router === undefined ? undefined : () => router,
  );
  const context = extensionContext(scratch, warnings, trusted, hasUI);
  return captureConsoleWarnings(warnings, async () => {
    await api.emit("session_start", {}, context);
    const handler = api.handlers.get("before_agent_start")?.[0];
    assert.ok(handler);
    const result = await handler({ systemPrompt: "BASE" }, context) as { systemPrompt: string };
    assert.ok(result.systemPrompt.startsWith("BASE"));
    return result.systemPrompt.slice("BASE".length);
  });
}

test("paused doctrine names both handoff steps", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(undefined, {}, true, true);
  assert.match(doctrine, /\/slate handoff \[optional focus\][\s\S]*\/slate adopt <name>/);
});

test("routing doctrine renders dated prices and truthful candidate ordering", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(routedResolution());
  const priceDate = /Prices include dated updates after (\d{4}-\d{2}-\d{2}) research\./.exec(doctrine)?.[1];
  assert.equal(priceDate, PROFILES_AS_OF);
  assert.match(doctrine, /Candidates\s+follow preference, tier sourcing, tier, price, then specification\./);
  assert.doesNotMatch(doctrine, /Route every action to the cheapest model and effort that clears it\./);
  assert.doesNotMatch(doctrine, /Prices as of \d{4}-\d{2}-\d{2} are base rates:/);
  assert.match(doctrine, /A model or effort change empties the prompt cache\. Rewrites cost 12\.5 times cache reads\./);
});

test("single-action doctrine requires new threads and episode references", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(routedResolution());
  assert.match(doctrine, /Every `thread` call creates a new thread for one action\./);
  assert.match(doctrine, /A follow-up action\s+must use another new thread\./);
  assert.match(doctrine, /No worker conversation crosses that boundary\./);
  assert.match(doctrine, /Slate loads those episodes into the new worker prompt\./);
  assert.doesNotMatch(doctrine, /freshContext|threadChoice|restart/);
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
  const currentTail = "Durable workflow records anchor in the retained worktree-root research log per the workflow doc.";
  const formerTail = "Durable workflow records anchor in the retained repo-root research log per the workflow doc.";
  assert.ok(local.includes(currentTail));
  assert.equal(local.includes(formerTail), false);
  assert.equal(local.includes(PR_PUBLISHING_DOC), false);

  const published = (await renderDoctrine(undefined, { workflow: { draftPRs: true } })).replace(/\s+/g, " ");
  assert.ok(published.includes("An umbrella draft PR is part of the pre-implementation gates;"));
  assert.ok(published.includes(`PR publishing mechanics are in ${PR_PUBLISHING_DOC}.`));
  assert.equal(published.includes("Durable workflow records anchor"), false);
});

test("retired archive state changes neither doctrine nor visible or headless warnings", { timeout: 5000 }, async () => {
  const project = {
    root: join(scratch, "corpus"),
    key: "doctrine-project",
    label: "doctrine-project",
    digest: "0123456789ab",
    directory: join(scratch, "corpus", "doctrine-project-0123456789ab"),
    matchingDirectories: [],
  } as NonNullable<SlateStore["corpusProject"]>;
  const states: RetiredArchiveState[] = [
    {},
    { project },
    { sessionName: "calm-otter-7f3a" },
    { project, sessionName: "calm-otter-7f3a" },
    { project, sessionName: "renamed-session" },
  ];
  for (const hasUI of [true, false]) {
    for (const draftPRs of [false, true]) {
      for (const trusted of [false, true]) {
        const config = { workflow: { draftPRs } };
        const baselineWarnings: string[] = [];
        const baseline = await renderDoctrine(undefined, config, trusted, false, {}, baselineWarnings, hasUI);
        assert.deepEqual(baselineWarnings, [], `baseline hasUI=${hasUI}`);
        for (const state of states) {
          const warnings: string[] = [];
          const rendered = await renderDoctrine(undefined, config, trusted, false, state, warnings, hasUI);
          assert.equal(rendered, baseline, `hasUI=${hasUI}`);
          assert.deepEqual(warnings, [], `hasUI=${hasUI}`);
          assert.doesNotMatch(rendered, /archive the research log|archive waiver|Corpus session:/i);
        }
      }
    }
  }
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
