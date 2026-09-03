import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { PROFILES_AS_OF, MODEL_PROFILES, ladderFor } from "../extension/model-profiles.ts";
import { ROUTER_OFF, type ModelRouterResolution, type RouterCandidate } from "../extension/model-router.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { PR_PUBLISHING_DOC, REVIEW_RULES_DOC, TRACK_WORKFLOW_DOC, WRITING_GUIDANCE_DOC } from "../extension/paths.ts";
import { SlateStore, type SlateConfig } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { DESIGN_REQUIREMENTS, WRITING_REQUIREMENTS } from "../extension/writing-reminder.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-doctrine-contract-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

type Handler = (event: any, context: ExtensionContext) => unknown;

class FakeExtensionApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly sentMessages: Array<{ message: unknown; options: unknown }> = [];

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
  sendMessage(message: unknown, options: unknown): void { this.sentMessages.push({ message, options }); }
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
  assert.ok(local.includes("Durable workflow records anchor in the retained repo-root research log per the workflow doc."));
  assert.doesNotMatch(local, /repo-root workflow log/);
  assert.equal(local.includes(PR_PUBLISHING_DOC), false);

  const published = (await renderDoctrine(undefined, { workflow: { draftPRs: true } })).replace(/\s+/g, " ");
  assert.ok(published.includes("An umbrella draft PR is part of the pre-implementation gates;"));
  assert.ok(published.includes(`PR publishing mechanics are in ${PR_PUBLISHING_DOC}.`));
  assert.doesNotMatch(published, /repo-root (?:workflow|research) log/);
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

test("writing doctrine is active for trusted projects regardless of ignored writing keys", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(ROUTER_OFF, { writing: { check: false, remind: false } });
  const absent = await renderDoctrine(ROUTER_OFF);
  const untrusted = await renderDoctrine(ROUTER_OFF, { writing: { check: true, remind: true } }, false);
  assert.match(absent, /Check user-facing prose before delivery\./);
  assert.equal(absent, doctrine);
  assert.doesNotMatch(untrusted, /Check user-facing prose before delivery\./);
  const normalized = doctrine.replace(/\s+/g, " ");
  const requiredClauses = [
    "Check user-facing prose before delivery.",
    "Write sentences a non-native reader understands on one reading.",
    "Use short, active, plain language.",
    "Keep exact technical terms.",
    "Do not use semicolons or contractions.",
    "The checker does not test vocabulary.",
    "Follow these requirements:",
    "Avoid idioms.",
    "Replace bare-reference openers with the subject they reference.",
    "Explain each project-specific term at first use.",
    "Define each abbreviation at first use.",
    "Express one idea in each sentence.",
    "Use one term for each concept.",
    "Do not explain an idea with a metaphor.",
    "Do not invent a term when the project already has one.",
    "Use plain words that appear in standard libraries and textbooks.",
    "Keep a design statement only if a different reasonable implementation keeps it true.",
    "Present to the user any item the approved goals do not list.",
    "Never add or remove an approved goal yourself.",
    "Propose a repeated regression as a non-goal candidate.",
    "Present what changed when you update a design.",
    "Assume the user knows software but not this project.",
    "Apply them to README and documentation text, code comments, pull request text, commit bodies, issues, review comments, release notes, and user messages.",
    "Exclude research logs, worker task text, and the project's own agent instruction file.",
    "Read it only for an unusual prose decision.",
    "Skip it if already in context.",
  ];
  for (const clause of requiredClauses) assert.ok(normalized.includes(clause), `missing doctrine clause: ${clause}`);
  assert.ok(
    normalized.includes(DESIGN_REQUIREMENTS.map((entry) => entry.text).join(" ")),
    "design doctrine must match the reminder roster word for word",
  );
  assert.ok(normalized.includes(`Rules, limits, and checker: ${WRITING_GUIDANCE_DOC}.`));
  assert.doesNotMatch(normalized, /20 words|25 words|SENT20|SENT25/);
});

test("writing guide rosters match the frozen production rosters", () => {
  const guide = readFileSync(WRITING_GUIDANCE_DOC, "utf8");
  const bullets = (start: string, end: string): string[] => {
    const from = guide.indexOf(start);
    const to = guide.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, "roster markers missing; update docs/writing-guidance.md in the same commit");
    const lines = guide.slice(from + start.length, to).split("\n");
    while (lines[0] === "") lines.shift();
    while (lines.at(-1) === "") lines.pop();
    assert.ok(lines.every((line) => /^- .+$/.test(line)), "invalid roster line; update docs/writing-guidance.md in the same commit");
    return lines.map((line) => line.slice(2));
  };
  assert.ok(Object.isFrozen(WRITING_REQUIREMENTS) && Object.isFrozen(DESIGN_REQUIREMENTS));
  assert.deepEqual(
    bullets("The doctrine includes these nine requirements in this order:", "The first six project-authored summaries"),
    WRITING_REQUIREMENTS.map((entry) => entry.text),
    "writing roster changed; update docs/writing-guidance.md in the same commit",
  );
  assert.deepEqual(
    bullets("six-line design requirement block:", "The reminder then includes this exact scope guard:"),
    DESIGN_REQUIREMENTS.map((entry) => entry.text),
    "design roster changed; update docs/writing-guidance.md in the same commit",
  );
});

test("mode skips reminder cadence when no effective budget exists", { timeout: 5000 }, async () => {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  registerSlateMode(
    api as unknown as ExtensionAPI,
    store,
    { startHandoff: async () => {}, effectiveContextBudget: () => undefined } as any,
    () => ({}),
    () => EMPTY_WORKER_EXTENSION_SET,
    () => ROUTER_OFF,
  );
  const context = {
    ...extensionContext(scratch),
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000 }),
  } as ExtensionContext;
  await api.emit("tool_result", {}, context);
  assert.deepEqual(api.sentMessages, []);
  assert.equal(store.writingReminder.sentThisRound, false);
  assert.equal(store.writingReminder.pending, undefined);
});

test("mode uses the five-percent reminder fallback when writing config is absent", { timeout: 5000 }, async () => {
  const api = new FakeExtensionApi();
  const store = new SlateStore(api as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  registerSlateMode(
    api as unknown as ExtensionAPI,
    store,
    { startHandoff: async () => {}, effectiveContextBudget: () => 200_000 } as any,
    () => ({}),
    () => EMPTY_WORKER_EXTENSION_SET,
    () => ROUTER_OFF,
  );
  const context = {
    ...extensionContext(scratch),
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000 }),
  } as ExtensionContext;
  await api.emit("tool_result", {}, context);
  assert.equal(api.sentMessages.length, 1, "the default 5 percent interval must fire at 10,000 of 200,000 tokens");
  assert.equal(store.writingReminder.markTokens, 0, "cadence stays uncommitted before delivery");
  assert.equal(store.writingReminder.pending?.nextMarkTokens, 10_000, "the fallback interval records the reached usage");

  const configuredApi = new FakeExtensionApi();
  const configuredStore = new SlateStore(configuredApi as unknown as ExtensionAPI);
  configuredStore.orchestratorMode = true;
  registerSlateMode(
    configuredApi as unknown as ExtensionAPI,
    configuredStore,
    { startHandoff: async () => {}, effectiveContextBudget: () => 200_000 } as any,
    () => ({ writing: { remindPercent: 10 } }),
    () => EMPTY_WORKER_EXTENSION_SET,
    () => ROUTER_OFF,
  );
  await configuredApi.emit("tool_result", {}, context);
  assert.deepEqual(configuredApi.sentMessages, [], "a configured 10 percent interval must not fire at 10,000 tokens");
  assert.equal(configuredStore.writingReminder.pending, undefined);
});

test("routing off adds no doctrine bytes", { timeout: 5000 }, async () => {
  const defaultOff = await renderDoctrine();
  const explicitOff = await renderDoctrine(ROUTER_OFF);
  assert.equal(explicitOff, defaultOff);
  assert.doesNotMatch(explicitOff, /Routable this session/);
  assert.doesNotMatch(explicitOff, /Prices include dated updates/);
  assert.doesNotMatch(explicitOff, /Prices as of/);
});

test("entry configuration reports either ignored writing key through the shared warning sink", { timeout: 5000 }, async () => {
  const run = async (name: string, writing: Record<string, unknown> | undefined): Promise<string[]> => {
    const cwd = join(scratch, name);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify(writing === undefined ? {} : { writing }));
    const api = new FakeExtensionApi();
    slateExtension(api as unknown as ExtensionAPI);
    const warnings: string[] = [];
    await api.emit("session_start", {}, extensionContext(cwd, warnings));
    return warnings;
  };
  const notice = "slate: writing.check and writing.remind are ignored writing keys. Remove them from slate.json. Slate controls writing checks and reminders automatically for trusted projects in orchestrator mode.";

  assert.deepEqual(await run("writing-check-true", { check: true }), [notice]);
  assert.deepEqual(await run("writing-remind-false", { remind: false }), [notice]);
  assert.deepEqual(await run("writing-keys-absent", { remindPercent: 10 }), []);
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
