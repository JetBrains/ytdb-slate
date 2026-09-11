import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { MODEL_PROFILES, ladderFor } from "../extension/model-profiles.ts";
import { ROUTER_OFF, resolveModelRouter, type ModelRouterResolution, type RouterCandidate } from "../extension/model-router.ts";
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
  const candidate: RouterCandidate = {
    spec: profile.id,
    provider: profile.id.split("/")[0] ?? "",
    id: profile.id.split("/")[1] ?? "",
    profile,
    tier: profile.tier,
    registryCost: { input: 0, output: 1.25, cacheRead: 99, cacheWrite: 88 },
    contextWindow: profile.contextWindow ?? undefined,
    ladder: ladderFor(profile),
    hasFailover: true,
    tierUnsourced: profile.tierUnsourced === true,
    ladderAssumed: profile.ladderAssumed === true,
  };
  return {
    on: true,
    candidates: [candidate],
    warnings: [],
  };
}

async function renderDoctrine(router?: ModelRouterResolution, config: SlateConfig = {}, trusted = true, model?: { provider: string; id: string }): Promise<string> {
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
  const context = extensionContext(scratch, [], trusted);
  context.model = model as never;
  const result = await handler({ systemPrompt: "BASE" }, context) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("BASE"));
  return result.systemPrompt.slice("BASE".length);
}

test("routing doctrine renders registry prices, configured order, and full tier words", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(routedResolution());
  assert.match(doctrine, /Candidate rows preserve\s+configured order after validation\./);
  assert.match(doctrine, /openai\/gpt-5\.6-luna\|0\/1\.25\|/);
  assert.match(doctrine, /\|tier 1\|/);
  assert.match(doctrine, /Prices are base input\/output rates from each exact pi registry entry\./);
  assert.doesNotMatch(doctrine, /cheapest|preference, tier sourcing|dated updates|never a default pick/);
  assert.match(doctrine, /Slate's model switch or top-level effort switch starts a cold prompt-cache path\./);
  assert.doesNotMatch(doctrine, /12\.5 times|cache reads/);
});

test("Fable authorization exception survives production doctrine rendering", { timeout: 5000 }, async () => {
  const profile = MODEL_PROFILES.find((entry) => entry.id === "anthropic/claude-fable-5");
  assert.ok(profile);
  const resolution = resolveModelRouter({
    models: [profile.id],
    registry: {
      find: () => ({ cost: { input: 1, output: 5 }, contextWindow: profile.contextWindow ?? undefined }),
      hasConfiguredAuth: () => true,
    },
    failover: { [profile.id]: profile.id },
  });
  assert.equal(resolution.on, true);

  const doctrine = await renderDoctrine(resolution);
  const row = doctrine.split("\n").find((line) => line.includes(profile.id));
  assert.ok(row, "the production renderer must include the Fable row");
  assert.ok(row.length <= 300, "the Fable row must remain within the enforced model-row bound");
  assert.match(row, /ZDR-required without confirmed express authorization and configuration \(REFUSE\)/);
  assert.doesNotMatch(row, /ZDR-obligated actions \(REFUSE\)/);
});

test("registry rates flow through production resolution into doctrine rows", { timeout: 5000 }, async () => {
  const specs = MODEL_PROFILES.slice(0, 3).map((profile) => profile.id);
  assert.equal(specs.length, 3);
  const registry = new Map([
    [specs[0], { cost: { input: 7, output: 8 } }],
    [specs[1], { cost: { input: 0 } }],
    [specs[2], { cost: { output: 9 } }],
  ]);
  const resolution = resolveModelRouter({
    models: specs,
    registry: {
      find: (provider, id) => registry.get(`${provider}/${id}`),
      hasConfiguredAuth: () => true,
    },
    failover: Object.fromEntries(specs.map((spec) => [spec, spec])),
  });
  assert.equal(resolution.on, true);
  assert.deepEqual(resolution.candidates.map((candidate) => candidate.spec), specs);

  const doctrine = await renderDoctrine(resolution);
  assert.match(doctrine, new RegExp(`   ${specs[0]?.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\|7/8\\|`));
  assert.match(doctrine, new RegExp(`   ${specs[1]?.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\|0/unknown\\|`));
  assert.match(doctrine, new RegExp(`   ${specs[2]?.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\|unknown/9\\|`));
});

test("single-action doctrine requires new threads and episode references", { timeout: 5000 }, async () => {
  const doctrine = await renderDoctrine(routedResolution());
  assert.match(doctrine, /Every `thread` call creates a new thread for one action\./);
  assert.match(doctrine, /A follow-up action\s+must use another new thread\./);
  assert.match(doctrine, /No worker conversation crosses that boundary\./);
  assert.match(doctrine, /Slate loads those episodes into the new worker prompt\./);
  assert.doesNotMatch(doctrine, /freshContext|threadChoice|restart/);
});

test("doctrine reads workflow only for changes and enforces size confirmation", { timeout: 5000 }, async () => {
  const doctrine = (await renderDoctrine()).replace(/\s+/g, " ");
  assert.ok(doctrine.includes("Scale change gates by size grade: SMALL, MEDIUM, or LARGE."));
  assert.ok(doctrine.includes("You own focus-area planning."));
  assert.ok(doctrine.includes("Write a seven-line risk record and give a concrete three-part proof for each named area."));
  assert.ok(doctrine.includes("No rule mechanically decides whether a proof holds."));
  assert.ok(doctrine.includes("Obtain user approval of the record at every confirmation gate."));
  assert.doesNotMatch(doctrine, /The implementer declares focus|validated declaration/);
  assert.doesNotMatch(doctrine, /Concurrency defect|Data loss|Security weakness|Licensing exposure/);
  assert.ok(doctrine.includes(`For repository changes, read ${TRACK_WORKFLOW_DOC} (skip the read if it is already in your context).`));
  assert.ok(doctrine.includes("Before the first file-modifying dispatch, confirm the user confirmed the predicted grade and every required pre-implementation gate ran."));
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
  assert.ok(doctrine.includes("Review every track with Reviewer I and one area reviewer for each proved focus area."));
  assert.doesNotMatch(doctrine, /Verification or gate machinery receives the general implementation reviewer|engaged focus areas/);
  assert.ok(doctrine.includes(`Before dispatching review threads, read ${REVIEW_RULES_DOC} and follow it. Skip the read when that file is already in your context.`));
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
  const sentence = "After review, ask the user which deferred items become tracked issues.";
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
    "Write sentences a reader understands on one reading.",
    "Use short, active language.",
    "Keep exact technical terms.",
    "Do not use semicolons or contractions.",
    "The checker does not test vocabulary.",
    "Follow these writing and conversation requirements:",
    "Write for a reader whose first language is not English.",
    "Use plain words that appear in standard libraries and textbooks. Treat any other term as new. A multi-word noun phrase, an abbreviation and a CamelCase name are terms.",
    "Avoid idioms.",
    "Replace bare-reference openers with the subject they reference.",
    "Explain each term, including project-specific, at first use.",
    "Define each abbreviation at first use.",
    "Express one idea in each sentence.",
    "Use one term for each concept.",
    "Do not explain an idea with a metaphor.",
    "Do not invent a term when the project already has one.",
    "Follow these design requirements:",
    "Choose the simplest solution with the fewest changes that keeps every approved goal, the product and implementation quality, and every required gate.",
    "Keep a design statement only if a different reasonable implementation keeps it true.",
    "Present to the user any item the approved goals do not list.",
    "Never add or remove an approved goal yourself.",
    "Propose a repeated regression as a non-goal candidate.",
    "Present what changed when you update a design.",
    "Assume the user knows software but not this project.",
    "Apply these requirements to README and documentation text, code comments and pull request text.",
    "Apply these requirements also to commit bodies, issues, review comments, release notes and user messages.",
    "Exclude research logs, worker task text, and the project's own agent instruction file.",
    "Read it only for an unusual prose decision.",
    "Skip it if already in context.",
  ];
  for (const clause of requiredClauses) assert.ok(normalized.includes(clause), `missing doctrine clause: ${clause}`);
  assert.ok(
    normalized.includes(DESIGN_REQUIREMENTS.map((entry) => `- ${entry.text}`).join(" ")),
    "design doctrine must match the reminder roster word for word",
  );
  assert.ok(normalized.includes(`Rules, limits, and checker: ${WRITING_GUIDANCE_DOC}.`));
  assert.doesNotMatch(normalized, /\b\d+\s+words\b/i);
  assert.doesNotMatch(normalized, /\bSENT\d+\b/);
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
    bullets("The doctrine includes these ten requirements in this order:", "The doctrine also renders"),
    WRITING_REQUIREMENTS.map((entry) => entry.text),
    "writing roster changed; update docs/writing-guidance.md in the same commit",
  );
  assert.deepEqual(
    bullets("seven-line design requirement block:", "The reminder then includes this exact scope guard:"),
    DESIGN_REQUIREMENTS.map((entry) => entry.text),
    "design roster changed; update docs/writing-guidance.md in the same commit",
  );
});

test("mode uses the four-turn reminder fallback when writing config is absent", { timeout: 5000 }, async () => {
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
  const context = extensionContext(scratch);
  const turn = { message: { role: "assistant", content: [], stopReason: "stop" }, toolResults: [] };
  for (let index = 0; index < 3; index++) await api.emit("turn_end", turn, context);
  assert.deepEqual(api.sentMessages, []);
  assert.equal(store.writingReminder.turnsSinceDelivery, 3);
  await api.emit("turn_end", turn, context);
  assert.equal(api.sentMessages.length, 1, "the default interval must fire on turn four");
  assert.equal(store.writingReminder.turnsSinceDelivery, 0, "the claim restarts cadence");

  const configuredApi = new FakeExtensionApi();
  const configuredStore = new SlateStore(configuredApi as unknown as ExtensionAPI);
  configuredStore.orchestratorMode = true;
  registerSlateMode(
    configuredApi as unknown as ExtensionAPI,
    configuredStore,
    { startHandoff: async () => {}, effectiveContextBudget: () => undefined } as any,
    () => ({ writing: { remindTurns: 5 } }),
    () => EMPTY_WORKER_EXTENSION_SET,
    () => ROUTER_OFF,
  );
  for (let index = 0; index < 4; index++) await configuredApi.emit("turn_end", turn, context);
  assert.deepEqual(configuredApi.sentMessages, [], "a configured five-turn interval must stay silent through turn four");
});

test("routing off gives the explicit dispatch vocabulary without a candidate table", { timeout: 5000 }, async () => {
  const defaultOff = await renderDoctrine();
  const explicitOff = await renderDoctrine(ROUTER_OFF);
  assert.equal(explicitOff, defaultOff);
  assert.match(explicitOff, /Every `thread` call must name `model`, `effort` .* and `reason`\. Session base model: unknown\./);
  assert.doesNotMatch(explicitOff, /Routable this session/);
  assert.doesNotMatch(explicitOff, /Prices include dated updates/);

  const withBase = await renderDoctrine(ROUTER_OFF, {}, true, { provider: "p", id: "base" });
  assert.match(withBase, /Session base model: p\/base\./);
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
  assert.match((await run("writing-percent-retired", { remindPercent: 10 }))[0] ?? "", /token share to a turn count/);
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
