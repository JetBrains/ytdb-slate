import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../extension/config.ts";
import { notificationSettings } from "../extension/notification-config.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { writeFailedEpisode } from "../extension/episodes.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";

test("resolved notification credentials never enter config JSON, snapshots, episodes, doctrine, diagnostics or slate output", { timeout: 2000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "slate-notification-privacy-")), agent = join(root, "agent");
	mkdirSync(agent); const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(root, { recursive: true, force: true }); });
	const secrets = ["PRIVATE_SERVER", "PRIVATE_TOPIC", "PRIVATE_TOKEN", "PRIVATE_USERNAME", "PRIVATE_PASSWORD"];
	const output: unknown[] = [], warnings: string[] = [];
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const api = {
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, handler),
		registerCommand: (_name: string, value: { handler: typeof command }) => { command = value.handler; },
		registerTool: () => {}, getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {},
		appendEntry: (_name: string, value: unknown) => output.push(value),
	} as unknown as ExtensionAPI;
	const store = new SlateStore(api), ctx = { cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true, sessionManager: { getEntries: () => [] }, ui: { notify: (text: string) => output.push(text), setStatus: () => {}, setWidget: (_name: string, text: unknown) => output.push(text) } } as unknown as ExtensionContext;
	for (const credentials of [{ token: secrets[2] }, { username: secrets[3], password: secrets[4] }]) {
		writeFileSync(join(agent, "slate.json"), JSON.stringify({ notifications: { native: false, detail: "message", push: { enabled: true, server: `https://${secrets[0]}.example`, topic: secrets[1], ...credentials } } }));
		const config = loadConfig(root, true, (warning) => warnings.push(warning));
		assert.deepEqual(notificationSettings(config).push, { enabled: true, server: `https://${secrets[0]}.example`, topic: secrets[1], ...credentials });
		assert.deepEqual((config.notifications as { push: unknown }).push, { enabled: true });
		output.push(config, { ...config }, JSON.parse(JSON.stringify(config)), store.snapshot()); store.save();
		const episode = writeFailedEpisode({ ctx, episodeId: "t1.e1", threadId: "t1", threadName: "safe", task: "safe", diagnostics: "safe", workerCostUsd: 0 });
		output.push(episode);
		store.orchestratorMode = true;
		registerSlateMode(api, store, { startHandoff: async () => {}, effectiveContextBudget: () => undefined } as any, () => config, () => EMPTY_WORKER_EXTENSION_SET);
		output.push(await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctx));
		for (const args of ["effective", "summary", "on", "resume", "off"]) await command(args, ctx);
		output.push(readFileSync(episode.file, "utf8"));
	}
	// An invalid notification group exercises the diagnostic route without echoing credentials.
	writeFileSync(join(agent, "slate.json"), JSON.stringify({ notifications: { native: secrets[2], push: { token: secrets[2], username: secrets[3] } } }));
	output.push(loadConfig(root, true, (warning) => warnings.push(warning)), warnings);
	assert.ok(warnings.length > 0);
	for (const secret of secrets) assert.ok(!JSON.stringify(output).includes(secret), secret);
});
