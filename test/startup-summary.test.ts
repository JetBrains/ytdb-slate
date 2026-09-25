import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { loadConfig, permitsSlateConfig } from "../extension/config.ts";
import { preferencePath, readStartupSummary, renderStartupSummary, saveStartupSummary, SUMMARY_WIDGET_KEY } from "../extension/startup-summary.ts";
import { TRACK_WORKFLOW_DOC } from "../extension/paths.ts";
import type { SlateSnapshot } from "../extension/state.ts";

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "slate-summary-"));
	const agent = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	const path = preferencePath(agent);
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, agent, project, path };
}

test("preference saves in the redirected agent folder, keeps other keys, and ignores slate.json", (t) => {
	const f = fixture(t);
	assert.deepEqual(readStartupSummary(), { enabled: true });
	assert.equal(preferencePath(), f.path);
	writeFileSync(join(f.project, ".pi", "slate.json"), '{"startupSummary":false}');
	mkdirSync(f.agent);
	writeFileSync(join(f.agent, "slate.json"), '{"startupSummary":false}');
	assert.equal(readStartupSummary().enabled, true);
	assert.match(JSON.stringify(loadConfig(f.project, true, () => {})), /"startupSummary":false/);
	assert.equal(saveStartupSummary(false).path, f.path);
	assert.deepEqual(readStartupSummary(), { enabled: false });
	assert.equal(permitsSlateConfig(loadConfig(f.project, false, () => {}), false), true);
	writeFileSync(f.path, '{"extra":{"value":3}}');
	saveStartupSummary(true);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { extra: { value: 3 }, startupSummary: true });
	assert.deepEqual(readStartupSummary(), { enabled: true });
	rmSync(join(f.agent, "slate.json"));
	assert.equal(permitsSlateConfig(loadConfig(f.project, false, () => {}), false), false);
});

test("invalid preference reads show the summary, and commands refuse to replace invalid files", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	for (const text of ["[]", "null", "9", "{broken"]) {
		writeFileSync(f.path, text);
		assert.match(readStartupSummary().warning!, new RegExp(f.path));
		assert.equal(readStartupSummary().enabled, true);
		assert.throws(() => saveStartupSummary(false));
		assert.equal(readFileSync(f.path, "utf8"), text);
	}
	writeFileSync(f.path, '{"startupSummary":"no"}');
	assert.match(readStartupSummary().warning!, /boolean startupSummary/);
	assert.equal(readStartupSummary().enabled, true);
	// A directory is unreadable as JSON even for users who can list it.
	rmSync(f.path);
	mkdirSync(f.path);
	assert.match(readStartupSummary().warning!, /Cannot read or parse/);
	assert.throws(() => saveStartupSummary(false));
	assert.equal(lstatSync(f.path).isDirectory(), true);
});

test("failure before rename keeps old bytes, mode and no temporary file", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	writeFileSync(f.path, '{"other":1,"startupSummary":true}\n', { mode: 0o640 });
	const bytes = readFileSync(f.path);
	const mode = statSync(f.path).mode & 0o777;
	assert.throws(() => saveStartupSummary(false, f.path, { beforeReplace: () => { throw new Error("before rename"); } }), /before rename/);
	assert.deepEqual(readFileSync(f.path), bytes);
	assert.equal(statSync(f.path).mode & 0o777, mode);
	assert.deepEqual(readdirSync(f.agent), ["slate-preferences.json"]);
	saveStartupSummary(false, f.path);
	assert.equal(statSync(f.path).mode & 0o777, mode);
	assert.equal(readStartupSummary(f.path).enabled, false);
});

test("cleanup failure reports the original write failure and the stranded temporary path", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	writeFileSync(f.path, '{"startupSummary":true}\n');
	let stranded = "";
	assert.throws(() => saveStartupSummary(false, f.path, { beforeReplace: () => {
		const temp = readdirSync(f.agent).find((name) => name.endsWith(".tmp"))!;
		stranded = join(f.agent, temp);
		renameSync(stranded, `${stranded}.saved`);
		mkdirSync(stranded); // unlinkSync cannot remove a directory, including as root.
		throw new Error("write failed first");
	} }), (error: unknown) => {
		assert.match(String(error), /^Error: write failed first\. The temporary file /);
		assert.doesNotMatch(String(error), /Error: Error:/);
		assert.match(String(error), /temporary file .* could not be removed/);
		assert.ok(String(error).includes(stranded));
		assert.match(String(error), /EISDIR|EPERM/);
		assert.match(String((error as Error).cause), /write failed first/);
		return true;
	});
	assert.equal(readStartupSummary(f.path).enabled, true);
	assert.equal(lstatSync(stranded).isDirectory(), true);
});

test("new files use umask rights, and symlinks keep their link and target mode", (t) => {
	const f = fixture(t);
	const result = saveStartupSummary(false);
	assert.equal(result.path, f.path);
	assert.equal(existsSync(f.path), true);
	assert.equal(statSync(f.path).mode & 0o777, 0o666 & ~process.umask());
	const target = join(f.agent, "actual.json");
	writeFileSync(target, '{"other":1}', { mode: 0o600 });
	chmodSync(target, 0o600);
	rmSync(f.path);
	symlinkSync(target, f.path);
	saveStartupSummary(true);
	assert.equal(lstatSync(f.path).isSymbolicLink(), true);
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { other: 1, startupSummary: true });
	assert.equal(statSync(target).mode & 0o777, 0o600);
	assert.equal(readdirSync(f.agent).filter((entry) => entry.endsWith(".tmp")).length, 0);
});

test("failure flushing the folder after replacement reports saved but uncertain durability", (t) => {
	const f = fixture(t);
	const result = saveStartupSummary(false, f.path, { syncFolder: () => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); } });
	if (process.platform === "win32") assert.equal(result.durabilityWarning, undefined);
	else assert.match(result.durabilityWarning!, /saved.*may not survive a crash/);
	assert.equal(readStartupSummary(f.path).enabled, false);
});

test("a linked target failure never replaces the link", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	symlinkSync(join(f.agent, "missing.json"), f.path);
	assert.throws(() => saveStartupSummary(false));
	assert.equal(lstatSync(f.path).isSymbolicLink(), true);
	assert.deepEqual(readdirSync(f.agent), ["slate-preferences.json"]);
});

function harness(t: test.TestContext) {
	const f = fixture(t);
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const widgets = new Map<string, string[]>();
	const notices: Array<{ text: string; type: string }> = [];
	let chatStatus: string | undefined;
	let active = ["read", "thread", "slate_change"];
	let branch: Array<{ type: string; customType: string; data: unknown }> = [];
	let successorEntry: Record<string, unknown> | undefined;
	let failNextSave = false;
	let mode = "tui";
	let hasUI = true;
	let brokenWidget = false;
	let brokenClear = false;
	let brokenTheme = false;
	let missingTheme = false;
	let brokenFg = false;
	let sessionId = "successor";
	const api = {
		on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(name, [...(events.get(name) ?? []), fn]); },
		registerTool() {}, registerCommand(name: string, command: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, command); },
		getActiveTools: () => active, setActiveTools(names: string[]) { active = names; },
		getAllTools: () => [{ name: "read" }, { name: "thread" }, { name: "slate_change" }],
		getThinkingLevel: () => undefined, sendMessage() {},
		appendEntry(name: string, data: SlateSnapshot) {
			if (name === "slate-state" && failNextSave) {
				failNextSave = false;
				throw new Error("injected handoff save failure");
			}
			branch.push({ type: "custom", customType: name, data: structuredClone(data) });
		},
	};
	const ctx = {
		cwd: f.project, get mode() { return mode; }, get hasUI() { return hasUI; }, model: undefined, modelRegistry: {},
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => sessionId, getSessionFile: () => undefined },
		waitForIdle: async () => {},
		newSession: async (options: { setup: (successor: { getSessionId: () => string; appendCustomEntry: (name: string, data: Record<string, unknown>) => void }) => Promise<void> }) => {
			await options.setup({ getSessionId: () => "successor", appendCustomEntry(name, data) {
				assert.equal(name, "slate-handoff");
				successorEntry = structuredClone(data);
			} });
			return { cancelled: false };
		},
		ui: {
			get theme() {
				if (brokenTheme) throw new Error("theme failed");
				if (missingTheme) return undefined;
				return {
					fg(color: string, text: string) {
						if (brokenFg) throw new Error("color failed");
						return `<${color}>${text}</${color}>`;
					},
					bold: (text: string) => `<b>${text}</b>`,
				};
			},
			notify(text: string, type: string) { notices.push({ text, type }); chatStatus = text; },
			setWidget(key: string, lines: string[] | undefined) {
				if (brokenWidget && key === SUMMARY_WIDGET_KEY && lines) throw new Error("render failed");
				if (brokenClear && key === SUMMARY_WIDGET_KEY && !lines) throw new Error("clear failed");
				if (lines) widgets.set(key, lines);
				else widgets.delete(key);
			},
			setStatus() {},
		},
	} as unknown as ExtensionContext;
	slateExtension(api as unknown as ExtensionAPI);
	return { ...f, ctx, widgets, notices, active: () => active, commands,
		// Pi's status replaces the last chat status. Widgets render in another
		// part of the same frame, and reload clears them before session_start.
		frame: () => [...widgets.values()].flat().concat(chatStatus === undefined ? [] : [chatStatus]),
		reloadStatus() { chatStatus = "Reloaded keybindings, extensions, skills, prompts, themes, and context files"; },
		async start(reason = "startup") { for (const fn of events.get("session_start") ?? []) await fn({ reason }, ctx); },
		async command(args: string) { await commands.get("slate")!.handler(args, ctx); },
		async submit(text: string, source = "interactive") {
			// AgentSession.prompt handles registered commands before it emits input.
			if (text === "/slate" || text.startsWith("/slate ")) {
				await commands.get("slate")!.handler(text.slice("/slate".length).trim(), ctx);
				return { command: true };
			}
			const event = { type: "input", text, source };
			let result: unknown = { action: "continue" };
			for (const fn of events.get("input") ?? []) {
				result = (await fn(event, ctx)) ?? { action: "continue" };
				if ((result as { action: string }).action === "handled") return { event, result };
			}
			const prompt = { systemPrompt: "Base model context" };
			for (const fn of events.get("before_agent_start") ?? []) {
				const change = await fn(prompt, ctx) as { systemPrompt?: string } | undefined;
				if (change?.systemPrompt) prompt.systemPrompt = change.systemPrompt;
			}
			return { event, result, prompt: prompt.systemPrompt };
		},
		snapshot(data: SlateSnapshot) { branch = [{ type: "custom", customType: "slate-state", data }]; },
		handoff(data: Record<string, unknown>, savedState?: SlateSnapshot) {
			branch = [{ type: "custom", customType: "slate-handoff", data },
				...(savedState ? [{ type: "custom", customType: "slate-state", data: savedState }] : [])];
		},
		successorEntry: () => successorEntry,
		mode(value: string, ui = true) { mode = value; hasUI = ui; },
		session(value: string) { sessionId = value; },
		failNextSave() { failNextSave = true; },
		breakWidget(value: boolean) { brokenWidget = value; },
		breakClear(value: boolean) { brokenClear = value; },
		breakTheme(value: boolean) { brokenTheme = value; },
		missTheme(value: boolean) { missingTheme = value; },
		breakFg(value: boolean) { brokenFg = value; },
		resetUI() { widgets.clear(); chatStatus = undefined; },
	};
}

const snapshot = (currentChange?: string, owner?: string, orchestratorMode = true): SlateSnapshot => ({
	format: "single-action-v1", threads: [], episodes: [], orchestratorMode, paused: false,
	workerCostUsd: 0, carriedCostUsd: 0, currentChange, changeOwnerSessionId: owner,
});

const PANEL = [
	"What Slate does, step by step:",
	"1. Research: Slate studies your request and the code through worker threads.",
	"2. Risk approval: Slate lists the risks of the change, and you approve or reject each one.",
	"3. Design: a proved design risk or a track estimated above 100 counted lines needs a design before work. You validate and approve it. Only proved design risks add adversarial design reviewers.",
	"4. Tracks: workers implement and report approximate size. A proved risk adds reviewers. More than 100 counted lines adds a general reviewer unless the track changes only documents that neither ship as code nor run.",
	"5. Final acceptance: you review the whole change and accept it.",
	"6. Delivery: Slate prepares the final commit, or a pull request that only you merge.",
	"Run /slate summary off or /slate summary on to hide or show this summary when orchestrator mode starts.",
];

const STYLED_PANEL = [
	"<b><accent>What Slate does, step by step:</accent></b>",
	"<b><accent>1. Research:</accent></b> Slate studies your request and the code through worker threads.",
	"<b><accent>2. Risk approval:</accent></b> Slate lists the risks of the change, and <b><warning>you approve or reject</warning></b> each one.",
	"<b><accent>3. Design:</accent></b> a proved design risk or a track estimated above 100 counted lines needs a design before work. <b><warning>You validate and approve it</warning></b>. Only proved design risks add adversarial design reviewers.",
	"<b><accent>4. Tracks:</accent></b> workers implement and report approximate size. A proved risk adds reviewers. More than 100 counted lines adds a general reviewer unless the track changes only documents that neither ship as code nor run.",
	"<b><accent>5. Final acceptance:</accent></b> you review the whole change and <b><warning>accept it</warning></b>.",
	"<b><accent>6. Delivery:</accent></b> Slate prepares the final commit, or a pull request that <b><warning>only you merge</warning></b>.",
	"<dim>Run </dim><mdCode>/slate summary off</mdCode><dim> or </dim><mdCode>/slate summary on</mdCode><dim> to hide or show this summary when orchestrator mode starts.</dim>",
];

test("reload keeps the summary panel and restores the mode status", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot("change-20260924T105757Z-ab29a0b2cdd1cdc0fa26d66bc4718dc9", "parent"));
	await f.start();
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	assert.equal(f.widgets.has("slate"), false, "orchestrator status needs no widget");
	f.resetUI(); // Pi resetExtensionUI clears widgets before session_start on reload.
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.start("reload");
	f.reloadStatus(); // Pi's status replaces a chat notice after session_start.
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	assert.ok(f.frame().includes(STYLED_PANEL[0]!));
	assert.ok(f.frame().some((line) => line.startsWith("Reloaded keybindings")));
	assert.equal(f.frame().length >= PANEL.length, true);
	assert.match(f.commands.get("slate")!.description, /summary/);
});

test("a visible parent panel stays visible through handoff even with the saved preference off", { timeout: 10000 }, async (t) => {
	const parent = harness(t);
	parent.snapshot(snapshot());
	await parent.start();
	assert.deepEqual(parent.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await parent.command("summary off");
	await parent.command("summary");
	assert.deepEqual(parent.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await parent.command("handoff");
	const entry = parent.successorEntry()!;
	assert.equal(entry.summaryVisible, true);
	assert.equal((entry.snapshot as SlateSnapshot).format, snapshot().format);
	assert.equal("summaryVisible" in (entry.snapshot as SlateSnapshot), false);
	const successor = harness(t);
	saveStartupSummary(false);
	successor.handoff(entry);
	await successor.start("new");
	assert.deepEqual(successor.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	assert.equal(readStartupSummary().enabled, false, "handoff does not change the preference");
});

test("an interactive prompt hides the panel in the successor despite automatic display being on", { timeout: 10000 }, async (t) => {
	const parent = harness(t);
	parent.snapshot(snapshot());
	await parent.start();
	await parent.submit("Hide this panel.");
	assert.equal(parent.widgets.has(SUMMARY_WIDGET_KEY), false);
	await parent.command("handoff");
	const entry = parent.successorEntry()!;
	assert.equal(entry.summaryVisible, false);
	const successor = harness(t);
	successor.handoff(entry);
	await successor.start("new");
	assert.equal(readStartupSummary().enabled, true);
	assert.equal(successor.active().includes("slate_change"), true, "the successor has orchestrator tools");
	assert.equal(successor.widgets.has(SUMMARY_WIDGET_KEY), false);
	successor.resetUI();
	await successor.start("reload");
	assert.deepEqual(successor.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "reload uses the automatic rule");
});

test("handoff entries without visibility retain the automatic display rule", { timeout: 10000 }, async (t) => {
	for (const enabled of [false, true]) {
		await t.test(`startup preference ${enabled ? "on" : "off"}`, async (caseT) => {
			const f = harness(caseT);
			saveStartupSummary(enabled);
			f.handoff({ sessionId: "successor", snapshot: snapshot() });
			await f.start("new");
			assert.equal(readStartupSummary().enabled, enabled);
			if (enabled) assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
			else assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
		});
	}
});

test("invalid handoff snapshot does not carry a visible panel", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.handoff({ sessionId: "successor", summaryVisible: true, snapshot: { format: "invalid" } });
	await f.start("new");
	assert.match(f.notices.at(-1)!.text, /invalid successor handoff state/);
	assert.equal(readStartupSummary().enabled, true);
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "no mode was adopted, so automatic display stays off");
});

test("failed handoff save does not carry a hidden panel", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.handoff({ sessionId: "successor", summaryVisible: false, snapshot: snapshot() });
	f.failNextSave();
	await f.start("new");
	assert.match(f.notices.at(-1)!.text, /could not persist restored handoff state.*injected handoff save failure/);
	assert.equal(readStartupSummary().enabled, true);
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "adopted mode uses the automatic display rule after a failed save");
});

test("copied and already restored handoff entries do not change automatic display", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	writeFileSync(join(f.project, ".pi", "slate.json"), '{"orchestratorModeDefault":true}');
	f.handoff({ sessionId: "original", summaryVisible: false, snapshot: snapshot() });
	await f.start("fork");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "a copied entry belongs to the original session");
	f.resetUI();
	f.handoff({ sessionId: "successor", summaryVisible: false, snapshot: snapshot() }, snapshot());
	await f.start("reload");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "saved slate state prevents readoption");
});

test("a failed carried panel update warns through the summary channel", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.handoff({ sessionId: "successor", summaryVisible: true, snapshot: snapshot() });
	f.breakWidget(true);
	await f.start("new");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.match(f.notices.at(-1)!.text, /could not show the workflow summary: Error: render failed/);
	assert.equal(f.notices.at(-1)!.type, "warning");
});

test("fresh terminal mode seeding displays the panel after restore, but an explicit off state does not", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	await f.start();
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "fresh normal mode has no panel");
	writeFileSync(join(f.project, ".pi", "slate.json"), '{"orchestratorModeDefault":true}');
	await f.start("reload");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "fresh mode seed precedes display");
	f.snapshot(snapshot(undefined, undefined, false));
	f.resetUI();
	await f.start("reload");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "saved off prevents seeding");
});

test("normal mode stays clear through reload status, while toggles and repeat on restore the panel", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot(undefined, undefined, false));
	await f.start();
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	f.resetUI();
	await f.start("reload");
	f.reloadStatus();
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.frame().some((line) => line === STYLED_PANEL[0]), false);
	await f.submit("/slate on");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await f.submit("/slate off");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.submit("/slate on");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "each on shows it again");
	await f.submit("/slate");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "toggle off clears it");
	await f.submit("/slate");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "toggle on shows it");
	await f.submit("/slate on");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "explicit on shows it again");
});

test("the saved off choice suppresses automatic display, not manual display in either mode", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot(undefined, undefined, false));
	await f.start();
	await f.command("summary off");
	await f.command("on");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await f.command("off");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await f.command("summary off");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary on");
	await f.command("on");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
});

test("the first terminal prompt clears only the summary widget without changing model input", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot());
	await f.start();
	const lines = f.widgets.get(SUMMARY_WIDGET_KEY)!;
	assert.deepEqual(lines, STYLED_PANEL);
	assert.deepEqual(await f.submit("/slate effective"), { command: true });
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), lines, "slash commands keep the panel");
	const injected = await f.submit("extension message", "extension");
	assert.deepEqual(injected.result, { action: "continue" });
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), lines, "extension input keeps the panel");
	const entries = structuredClone(f.ctx.sessionManager.getEntries());
	const submitted = await f.submit("Please check this file.");
	assert.deepEqual(submitted.event, { type: "input", text: "Please check this file.", source: "interactive" });
	assert.deepEqual(submitted.result, { action: "continue" });
	assert.match(submitted.prompt!, /^Base model context/);
	assert.doesNotMatch(submitted.prompt!, /What Slate does, step by step:|Run \/slate summary off or/);
	assert.deepEqual(f.ctx.sessionManager.getEntries(), entries, "clearing writes no session or model message");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.widgets.has("slate"), false, "clearing the panel needs no mode widget");
	await f.submit("/slate summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), lines, "on demand restores the panel");
	await f.submit("Next prompt.");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "the next prompt clears a re-shown panel");
	await f.start("reload");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), lines, "reload restores the panel");
	await f.submit("First prompt after reload.");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
});

test("a failed summary clear warns and leaves the prompt untouched", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot());
	await f.start();
	f.breakClear(true);
	const submitted = await f.submit("Keep my prompt.");
	assert.deepEqual(submitted.result, { action: "continue" });
	assert.equal(submitted.event!.text, "Keep my prompt.");
	assert.doesNotMatch(submitted.prompt!, /What Slate does, step by step:/);
	assert.ok(f.widgets.has(SUMMARY_WIDGET_KEY));
	assert.match(f.notices.at(-1)!.text, /could not clear the workflow summary: Error: clear failed/);
	assert.equal(f.notices.at(-1)!.type, "warning");
	f.breakClear(false);
	await f.submit("Try again.");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.notices.filter((notice) => notice.type === "warning").length, 1);
});

test("command validation and mode gating do not toggle orchestrator mode", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	await f.start();
	assert.equal(f.active().includes("slate_change"), false);
	await f.command("summary unknown");
	assert.match(f.notices.at(-1)!.text, /Usage: \/slate summary/);
	assert.equal(f.active().includes("slate_change"), false);
	await f.command("summary off");
	assert.equal(f.active().includes("slate_change"), false);
	assert.equal(f.notices.at(-1)!.type, "info");
	writeFileSync(f.path, "[]");
	await f.command("summary on");
	assert.equal(readFileSync(f.path, "utf8"), "[]");
	assert.match(f.notices.at(-1)!.text, /could not save/);
	f.mode("rpc", true);
	f.resetUI();
	await f.start("reload");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary");
	assert.equal(f.notices.at(-1)!.text, PANEL.join("\n"));
	assert.equal(f.notices.at(-1)!.type, "info");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	writeFileSync(f.path, '{"startupSummary":true}');
	await f.command("on");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "RPC on never creates a panel");
	f.mode("print", false);
	await f.start("reload");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("off");
	await f.command("on");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "print on never creates a panel");
	const printed: string[] = [];
	const originalLog = console.log;
	try {
		console.log = (text: string) => { printed.push(text); };
		await f.command("summary");
	} finally {
		console.log = originalLog;
	}
	assert.deepEqual(printed, [PANEL.join("\n")]);
});

test("folder-flush failure gives a command warning instead of plain success", { timeout: 10000 }, async (t) => {
	const f = fixture(t);
	const notices: Array<{ text: string; type: string }> = [];
	let command: ((arg: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const pi = {
		on() {}, registerTool() {}, registerCommand(_name: string, c: { handler: typeof command }) { command = c.handler; },
		getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [], appendEntry() {},
	} as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	registerSlateMode(pi, store, { startHandoff: async () => {} } as any, () => ({}), () => EMPTY_WORKER_EXTENSION_SET,
		() => undefined, undefined,
		(enabled, path) => saveStartupSummary(enabled, path, {
			syncFolder: () => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); },
		}));
	const ctx = { mode: "tui", hasUI: true, ui: {
		notify: (text: string, type: string) => notices.push({ text, type }), setWidget() {}, setStatus() {},
	} } as unknown as ExtensionContext;
	assert.ok(command);
	await command!("summary off", ctx);
	assert.equal(readStartupSummary(f.path).enabled, false);
	if (process.platform !== "win32") {
		assert.equal(notices.at(-1)!.type, "warning");
		assert.match(notices.at(-1)!.text, /saved.*may not survive a crash/);
		assert.equal(notices.some((n) => n.type === "info"), false);
	}
});

test("startup errors warn once and do not stop the session", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot());
	mkdirSync(f.agent);
	writeFileSync(f.path, '{"startupSummary":1}');
	await f.start();
	assert.equal(f.notices.filter((n) => n.type === "warning").length, 1);
	assert.ok(f.widgets.has(SUMMARY_WIDGET_KEY));
	writeFileSync(f.path, "{}");
	f.breakWidget(true);
	f.notices.length = 0;
	await f.start("reload");
	assert.match(f.notices.at(-1)!.text, /could not show the workflow summary/);
	assert.equal(f.notices.at(-1)!.type, "warning");
});

test("a terminal fixture without a theme keeps its plain widget", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot());
	f.missTheme(true);
	await f.start();
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), PANEL);
	assert.equal(f.notices.filter((notice) => notice.type === "warning").length, 0);
	f.missTheme(false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
});

test("theme failures warn without breaking terminal startup", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot());
	f.breakTheme(true);
	await f.start();
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.notices.at(-1)!.type, "warning");
	assert.match(f.notices.at(-1)!.text, /could not show the workflow summary: Error: theme failed/);
	f.breakTheme(false);
	f.breakFg(true);
	f.notices.length = 0;
	await f.command("summary");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.notices.at(-1)!.type, "warning");
	assert.match(f.notices.at(-1)!.text, /could not show the workflow summary: Error: color failed/);
	f.breakFg(false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
});

test("the short phase list follows all nine lifecycle phases in the shipped document", () => {
	const section = readFileSync(TRACK_WORKFLOW_DOC, "utf8").split("## Lifecycle and phases\n")[1]!.split("\nThe cumulative implementation")[0]!;
	const phases = [...section.matchAll(/^\d+\. (.*(?:\n(?!\d+\.|\n)[ \t]+.*)*)/gm)].map((match) => match[1]!.replace(/\s+/g, " ").trim());
	assert.deepEqual(phases, [
		"research.",
		"propose the eleven-line risk record and obtain user approval.",
		"design and validate when a proved DESIGN-TRIGGERING area or a per-track size estimate above 100 counted lines requires a design.",
		"when a design exists, reconfirm the focus list against the validated design.",
		"when a design exists, run one adversarial design review for each proved DESIGN-TRIGGERING area that has not reviewed the applicable design.",
		"when a design exists, obtain final design approval.",
		"run the track loop.",
		"obtain blocking final acceptance.",
		"deliver.",
	]);
	assert.deepEqual(renderStartupSummary(), PANEL);
	const labels = PANEL.slice(1, 7).map((line, index) => {
		const match = /^(\d+)\. ([^:]+):/.exec(line);
		assert.ok(match);
		assert.equal(Number(match[1]), index + 1);
		return match[2];
	});
	// Each panel step is tied to its governing phase or contiguous phase group.
	assert.deepEqual([
		[labels[0], phases.slice(0, 1)],
		[labels[1], phases.slice(1, 2)],
		[labels[2], phases.slice(2, 6)],
		[labels[3], phases.slice(6, 7)],
		[labels[4], phases.slice(7, 8)],
		[labels[5], phases.slice(8, 9)],
	], [
		["Research", ["research."]],
		["Risk approval", ["propose the eleven-line risk record and obtain user approval."]],
		["Design", phases.slice(2, 6)],
		["Tracks", ["run the track loop."]],
		["Final acceptance", ["obtain blocking final acceptance."]],
		["Delivery", ["deliver."]],
	]);
});
