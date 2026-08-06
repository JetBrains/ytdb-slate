import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { MODEL_PROFILES, type ModelProfile } from "../extension/model-profiles.ts";
import {
  createModelRouterResolver,
  resolveModelRouter,
  sanitizeRouterConfig,
  type RouterProfileSource,
  type RouterWarningClass,
} from "../extension/model-router.ts";

interface RegisteredCommand {
  handler(args: string, ctx: ExtensionContext): Promise<void>;
}

interface SlateHarness {
  cwd: string;
  notifications: string[];
  start(): Promise<void>;
  consult(): Promise<void>;
  close(): void;
}

function makeHarness(router: unknown, options: { throwingRegistry?: boolean } = {}): SlateHarness {
  const cwd = mkdtempSync(join(tmpdir(), "slate-router-test-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "slate.json"), JSON.stringify({
    router,
    modelFailover: { "openai/gpt-5.6-luna": "openai/gpt-5.6-luna" },
  }));

  const notifications: string[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
  const commands = new Map<string, RegisteredCommand>();
  const tools: Array<{ name: string }> = [];
  let activeTools: string[] = [];
  const registry = {
    find(provider: string, id: string) {
      if (provider === "openai" && id === "gpt-5.6-luna") return { contextWindow: 1_050_000 };
      return undefined;
    },
    hasConfiguredAuth() {
      return true;
    },
  };

  const concrete = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool);
      activeTools.push(tool.name);
    },
    getAllTools() {
      return tools;
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
    appendEntry() {},
    getThinkingLevel() {
      return "high";
    },
    setWidget() {},
    sendMessage() {},
  };
  const pi = new Proxy(concrete, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return () => undefined;
    },
  }) as unknown as ExtensionAPI;
  slateExtension(pi);

  const contextBase = {
    cwd,
    hasUI: true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setWidget() {},
      setStatus() {},
    },
    isProjectTrusted() {
      return true;
    },
    sessionManager: {
      getBranch() {
        return [];
      },
      getEntries() {
        return [];
      },
    },
    model: undefined,
  };
  const ctx = new Proxy(contextBase, {
    get(target, property, receiver) {
      if (property === "modelRegistry" && options.throwingRegistry) throw new Error("registry unavailable");
      if (property === "modelRegistry") return registry;
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return undefined;
    },
  }) as unknown as ExtensionContext;

  return {
    cwd,
    notifications,
    async start() {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
      await commands.get("slate")?.handler("on", ctx);
      notifications.length = 0;
    },
    async consult() {
      for (const handler of handlers.get("before_agent_start") ?? []) {
        await handler({ systemPrompt: "base" }, ctx);
      }
    },
    close() {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

async function withHarness(
  router: unknown,
  run: (harness: SlateHarness) => Promise<void>,
  options?: { throwingRegistry?: boolean },
): Promise<void> {
  const harness = makeHarness(router, options);
  try {
    await harness.start();
    await run(harness);
  } finally {
    harness.close();
  }
}

function discoverability(notifications: string[]): string[] {
  return notifications.filter((message) => message.startsWith("slate: there "));
}

test("router notes stay hidden and produce one plural discoverability notice across repeated consultations", async () => {
  await withHarness({ models: ["openai/gpt-5.6-luna"] }, async (harness) => {
    await harness.consult();
    await harness.consult();

    assert.deepEqual(discoverability(harness.notifications), [
      'slate: there are 2 warnings in the model router. Set "router.showWarnings" to true in .pi/slate.json to read them. A hidden warning can affect which model runs an action.',
    ]);
    assert.equal(harness.notifications.some((message) => message.includes("research table shipped inside slate")), false);
    assert.equal(harness.notifications.some((message) => message.includes("model facts that slate could not trace")), false);
  });
});

test("showWarnings reveals every model data note without a discoverability notice", async () => {
  await withHarness({ models: ["openai/gpt-5.6-luna"], showWarnings: true }, async (harness) => {
    await harness.consult();

    assert.equal(harness.notifications.filter((message) => message.includes("research table shipped inside slate")).length, 1);
    assert.equal(harness.notifications.filter((message) => message.includes("model facts that slate could not trace")).length, 1);
    assert.deepEqual(discoverability(harness.notifications), []);
  });
});

test("configuration faults remain visible while model data notes are hidden", async () => {
  await withHarness({ models: ["openai/gpt-5.6-luna", "missing/model"] }, async (harness) => {
    await harness.consult();

    assert.equal(harness.notifications.some((message) => message.includes("has no entry in slate's model profile table")), true);
    assert.equal(harness.notifications.some((message) => message.includes("research table shipped inside slate")), false);
    assert.equal(discoverability(harness.notifications).length, 1);
  });
});

test("router off and an all-dropped list emit no hidden-warning notice", async () => {
  await withHarness({ models: [] }, async (harness) => {
    await harness.consult();
    assert.deepEqual(harness.notifications, []);
  });
  await withHarness({ models: ["missing/model"] }, async (harness) => {
    await harness.consult();
    assert.equal(harness.notifications.some((message) => message.includes("routing is disabled")), true);
    assert.deepEqual(discoverability(harness.notifications), []);
  });
});

test("resolver catch-all remains visible and does not invent a hidden-warning notice", async () => {
  await withHarness(
    { models: ["openai/gpt-5.6-luna"] },
    async (harness) => {
      await harness.consult();
      assert.equal(harness.notifications.some((message) => message.includes("router could not resolve its model list")), true);
      assert.deepEqual(discoverability(harness.notifications), []);
    },
    { throwingRegistry: true },
  );
});

function profileFixture(overrides: Partial<ModelProfile>): ModelProfile {
  const base = MODEL_PROFILES[0];
  assert.ok(base);
  return { ...base, ...overrides };
}

function resolveFixture(profile: ModelProfile): Array<{ message: string; warningClass: RouterWarningClass }> {
  const warnings: Array<{ message: string; warningClass: RouterWarningClass }> = [];
  const profiles: RouterProfileSource = {
    findProfile: () => profile,
    ladderFor: () => ["low"],
  };
  resolveModelRouter({
    registry: {
      find: () => ({ contextWindow: profile.contextWindow ?? 100_000 }),
      hasConfiguredAuth: () => true,
    },
    models: [profile.id],
    profiles,
    failover: { [profile.id]: profile.id },
    today: "2026-08-06",
  }, (message, warningClass) => warnings.push({ message, warningClass }));
  return warnings;
}

test("profile warning text strips research tags, keeps separators, and caps each field", () => {
  const long = `field ${"x".repeat(240)} [RI36],`;
  const warnings = resolveFixture(profileFixture({
    unknownRoutingCriticalFields: ["first fact [G1e]", long],
  }));
  const detail = warnings.find(({ message }) => message.includes("model facts"));

  assert.ok(detail);
  assert.equal(detail.warningClass, "model-data-note");
  assert.match(detail.message, /first fact · field x+/);
  assert.doesNotMatch(detail.message, /\[(?:G1e|RI36)\]/);
  assert.equal(detail.message.includes("x".repeat(200)), false);
  assert.ok(detail.message.length < 799);
});

test("whole router warnings are capped and an omitted class defaults to configuration fault", () => {
  const warnings = resolveFixture(profileFixture({
    nonPreferred: `NEVER AUTO-SELECT [arb] ${"reason ".repeat(250)}`,
    unknownRoutingCriticalFields: [],
  }));
  const fallback = warnings.find(({ message }) => message.includes("default base model"));

  assert.ok(fallback);
  assert.equal(fallback.warningClass, "configuration-fault");
  assert.ok(fallback.message.length <= 799);
  assert.doesNotMatch(fallback.message, /\[arb\]/);
});

test("router entry faults explain malformed, unprofiled, unknown, and unauthenticated models", () => {
  const profile = profileFixture({ unknownRoutingCriticalFields: [] });
  const classes: RouterWarningClass[] = [];
  const messages: string[] = [];
  const warn = (message: string, warningClass: RouterWarningClass) => {
    messages.push(message);
    classes.push(warningClass);
  };
  const noProfiles: RouterProfileSource = { findProfile: () => undefined, ladderFor: () => [] };
  resolveModelRouter({
    registry: { find: () => undefined, hasConfiguredAuth: () => true },
    models: ["malformed", "missing/model"],
    profiles: noProfiles,
  }, warn);
  const profiles: RouterProfileSource = { findProfile: () => profile, ladderFor: () => ["low"] };
  resolveModelRouter({
    registry: { find: () => undefined, hasConfiguredAuth: () => true },
    models: [profile.id],
    profiles,
  }, warn);
  resolveModelRouter({
    registry: { find: () => ({ contextWindow: 100_000 }), hasConfiguredAuth: () => false },
    models: [profile.id],
    profiles,
  }, warn);

  assert.equal(messages.some((message) => message.includes('not a canonical "provider/id" model spec')), true);
  assert.equal(messages.some((message) => message.includes("has no entry in slate's model profile table")), true);
  assert.equal(messages.some((message) => message.includes("is not in pi's model registry")), true);
  assert.equal(messages.some((message) => message.includes("has no usable credentials configured in pi")), true);
  assert.equal(classes.every((warningClass) => warningClass === "configuration-fault"), true);
});

test("a throwing warning sink cannot abort model resolution", () => {
  const profile = profileFixture({ unknownRoutingCriticalFields: ["missing fact"] });
  const profiles: RouterProfileSource = { findProfile: () => profile, ladderFor: () => ["low"] };
  const resolution = resolveModelRouter({
    registry: { find: () => ({ contextWindow: profile.contextWindow ?? 100_000 }), hasConfiguredAuth: () => true },
    models: [profile.id],
    profiles,
  }, () => {
    throw new Error("closed UI");
  });

  assert.equal(resolution.on, true);
  assert.equal(resolution.candidates[0]?.spec, profile.id);
  assert.ok(resolution.warnings.length >= 2);
});

test("context-window notes cover an unknown profile date without a billing-threshold match", () => {
  const base = profileFixture({ contextWindow: 100_000, unknownRoutingCriticalFields: [] });
  const profile = { ...base, asOf: undefined } as unknown as ModelProfile;
  const profiles: RouterProfileSource = { findProfile: () => profile, ladderFor: () => ["low"] };
  const messages: string[] = [];
  resolveModelRouter({
    registry: { find: () => ({ contextWindow: 150_000 }), hasConfiguredAuth: () => true },
    models: [profile.id],
    profiles,
  }, (message) => messages.push(message));

  const mismatch = messages.find((message) => message.includes("differs between two sources"));
  assert.ok(mismatch);
  assert.match(mismatch, /profile was recorded as of "unknown"/);
  assert.equal(mismatch.includes("separate note below"), false);
});

test("resolver catch-all renders non-Error throws and survives a second throwing sink", () => {
  const delivered: string[] = [];
  const resolve = createModelRouterResolver(() => {
    throw "plain failure";
  }, (message) => {
    delivered.push(message);
    throw new Error("closed UI");
  });

  const resolution = resolve();
  assert.equal(resolution.on, false);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0] ?? "", /plain failure/);
  assert.strictEqual(resolve(), resolution);
  assert.equal(delivered.length, 1);
});

test("router data notes explain missing prices and a billing-threshold window mismatch", () => {
  const profile = profileFixture({
    contextWindow: 100_000,
    longContextThreshold: 200_000,
    price: [],
    unknownRoutingCriticalFields: [],
  });
  const profiles: RouterProfileSource = { findProfile: () => profile, ladderFor: () => ["low"] };
  const warnings: Array<{ message: string; warningClass: RouterWarningClass }> = [];
  resolveModelRouter({
    registry: { find: () => ({ contextWindow: 200_000 }), hasConfiguredAuth: () => true },
    models: [profile.id],
    profiles,
    failover: { [profile.id]: profile.id },
  }, (message, warningClass) => warnings.push({ message, warningClass }));

  assert.equal(warnings.some(({ message }) => message.includes("has no usable input price")), true);
  assert.equal(warnings.some(({ message }) => message.includes("differs between two sources")), true);
  assert.equal(warnings.some(({ message }) => message.includes("separate note below names that pattern")), true);
  assert.equal(warnings.every(({ warningClass }) => warningClass === "model-data-note"), true);
});

test("showWarnings sanitizer accepts its two booleans and defaults absent values", () => {
  const warnings: Array<{ message: string; warningClass: RouterWarningClass }> = [];
  const warn = (message: string, warningClass: RouterWarningClass) => warnings.push({ message, warningClass });

  assert.equal(sanitizeRouterConfig(undefined, warn).showWarnings, false);
  assert.equal(sanitizeRouterConfig({}, warn).showWarnings, false);
  assert.equal(sanitizeRouterConfig({ showWarnings: true }, warn).showWarnings, true);
  assert.equal(sanitizeRouterConfig({ showWarnings: false }, warn).showWarnings, false);
  assert.deepEqual(warnings, []);
});

test("showWarnings sanitizer rejects a non-boolean as a visible configuration fault", () => {
  const warnings: Array<{ message: string; warningClass: RouterWarningClass }> = [];
  const result = sanitizeRouterConfig({ showWarnings: "yes" }, (message, warningClass) => {
    warnings.push({ message, warningClass });
  });

  assert.equal(result.showWarnings, false);
  assert.deepEqual(warnings, [{
    message: 'slate: ignoring router.showWarnings "yes". Expected true or false. Slate uses false.',
    warningClass: "configuration-fault",
  }]);
});

test("router sanitizer reports malformed objects, keys, model lists, entries, and effort policy", () => {
  const warnings: Array<{ message: string; warningClass: RouterWarningClass }> = [];
  const warn = (message: string, warningClass: RouterWarningClass) => warnings.push({ message, warningClass });

  assert.deepEqual(sanitizeRouterConfig("wrong", warn), {
    models: [],
    allowUnmeasuredEffort: true,
    showWarnings: false,
  });
  assert.deepEqual(sanitizeRouterConfig({ models: "wrong" }, warn).models, []);
  assert.deepEqual(sanitizeRouterConfig({
    models: ["openai/gpt-5.6-luna", ["nested"]],
    allowUnmeasuredEffort: "yes",
    misspelled: true,
  }, warn), {
    models: ["openai/gpt-5.6-luna"],
    allowUnmeasuredEffort: true,
    showWarnings: false,
  });

  assert.equal(warnings.length, 5);
  assert.equal(warnings.every(({ warningClass }) => warningClass === "configuration-fault"), true);
  assert.equal(warnings.some(({ message }) => message.includes("router config. It must be an object")), true);
  assert.equal(warnings.some(({ message }) => message.includes("unknown router key(s): misspelled")), true);
  assert.equal(warnings.some(({ message }) => message.includes("router.models must be an array")), true);
  assert.equal(warnings.some(({ message }) => message.includes('["nested"]')), true);
  assert.equal(warnings.some(({ message }) => message.includes("router.allowUnmeasuredEffort")), true);
});
