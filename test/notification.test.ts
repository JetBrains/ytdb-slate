import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../extension/config.ts";
import { NOTIFICATION_DEFAULTS, notificationSettings, resolveNotificationSettings, type NotificationProtocol } from "../extension/notification-config.ts";
import { notificationSequences, notificationText, sanitizeNotificationText, truncateNotificationUtf8, wrapNotificationSequence } from "../extension/notification-protocols.ts";

const destination = { enabled: true, server: "https://private.example", topic: "private-topic", token: "secret-token" };
function resolve(home: unknown = undefined, project: unknown = undefined) {
	const warnings: string[] = [];
	return { settings: resolveNotificationSettings(home, project, (message) => warnings.push(message)), warnings };
}
test("defaults are immutable and every invalid notification setting warns without echoing values", () => {
	assert.deepEqual(resolve().settings, NOTIFICATION_DEFAULTS);
	assert.equal(resolve().settings.minimumDelayMs, 30000);
	assert.equal(resolve().settings.cooldownMs, 60000);
	assert.deepEqual(resolve().warnings, []);
	for (const group of [null, [], 4, "secret"]) assert.equal(resolve(group).warnings.length, 1);
	for (const key of ["terminal", "native", "bell", "detail", "pushDetail", "minimumDelayMs", "cooldownMs", "sequences"]) {
		const result = resolve({ [key]: "private-value" });
		assert.equal(result.warnings.length, 1, key);
		assert.equal(result.settings[key as keyof typeof result.settings], NOTIFICATION_DEFAULTS[key as keyof typeof NOTIFICATION_DEFAULTS]);
		assert.doesNotMatch(result.warnings.join(), /private-value/);
	}
	for (const push of [null, [], "secret"]) assert.equal(resolve({ push }).warnings.length, 1);
	assert.equal(resolve({ push: { enabled: "secret" } }).settings.push.enabled, false);
	assert.equal(resolve({ terminal: false, push: { enabled: false } }, { terminal: "secret", push: { enabled: "secret" } }).warnings.length, 2);
	const policy = resolve({ sequences: ["osc99"], push: destination }).settings;
	assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.push) && Object.isFrozen(policy.sequences));
});
test("warnings name the invalid notification group or setting and its source", () => {
	for (const source of ["home", "project"] as const) {
		const fromSource = (value: unknown) => source === "home" ? resolve(value) : resolve(undefined, value);
		for (const value of [null, [], 4, "private-value"]) {
			assert.deepEqual(fromSource(value).warnings, [`slate: invalid notifications in ${source} configuration. Using a safe default.`]);
		}
		for (const key of ["terminal", "native", "bell", "detail", "pushDetail", "minimumDelayMs", "cooldownMs", "sequences", "push"]) {
			assert.deepEqual(fromSource({ [key]: "private-value" }).warnings,
				[`slate: invalid notifications.${key} in ${source} configuration. Using a safe default.`]);
		}
		assert.deepEqual(fromSource({ push: { enabled: "private-value" } }).warnings,
			[`slate: invalid notifications.push.enabled in ${source} configuration. Using a safe default.`]);
	}
	assert.deepEqual(resolve({ push: { ...destination, topic: "private/value" } }).warnings,
		["slate: invalid notifications.push.topic in home configuration. Using a safe default."]);
});
test("invalid project channel values combine documented defaults with home permission", () => {
	for (const invalid of ["false", null, 0, [], {}]) {
		const result = resolve({ push: destination, terminal: true }, { push: { enabled: invalid }, terminal: invalid });
		assert.equal(result.settings.push.enabled, false);
		assert.equal(result.settings.terminal, true);
		assert.deepEqual(result.warnings, [
			"slate: invalid notifications.push.enabled in project configuration. Using a safe default.",
			"slate: invalid notifications.terminal in project configuration. Using a safe default.",
		]);
		assert.equal(resolve({ terminal: false }, { terminal: invalid }).settings.terminal, false);
	}
	assert.equal(resolve({ push: destination }, { push: {} }).settings.push.enabled, true);
});
test("project push destinations and credentials produce one warning without supplied values", () => {
	const fields = { server: "https://attacker.example", topic: "attacker-topic", token: "attacker-token", username: "attacker-user", password: "attacker-password" };
	for (const supplied of [fields, ...Object.entries(fields).map(([key, value]) => ({ [key]: value })), { server: null }]) {
		const result = resolve({ push: destination }, { push: { enabled: true, ...supplied } });
		assert.deepEqual(result.settings.push, destination);
		assert.deepEqual(result.warnings, ["slate: ignoring home-only notification push fields in project configuration."]);
		for (const value of Object.values(fields)) assert.ok(!result.warnings.join().includes(value));
	}
	assert.deepEqual(resolve({ push: destination }, { push: { enabled: false } }).warnings, []);
});
test("projects only lower all channel and detail permissions and cannot replace push authority", () => {
	const h = { terminal: false, native: false, bell: false, detail: "project", pushDetail: "generic", push: destination };
	const p = { terminal: true, native: true, bell: true, detail: "message", pushDetail: "message", push: { enabled: true, server: "http://attacker.example", topic: "attacker", token: "attacker", username: "attacker", password: "attacker" } };
	const result = resolve(h, p).settings;
	assert.equal(result.terminal || result.native || result.bell, false);
	assert.equal(result.detail, "project");
	assert.equal(result.pushDetail, "generic");
	assert.deepEqual(result.push, destination);
	assert.equal(resolve({}, p).settings.push.enabled, false);
	const lower = resolve({ detail: "message", pushDetail: "message", push: destination }, { terminal: false, native: false, bell: false, detail: "generic", pushDetail: "project", push: { enabled: false } }).settings;
	assert.equal(lower.terminal || lower.native || lower.bell || lower.push.enabled, false);
	assert.equal(lower.detail, "generic");
	assert.equal(lower.pushDetail, "project");
	assert.equal(resolve({ detail: "message" }).settings.pushDetail, "generic");
	assert.equal(resolve(Object.create({ push: destination })).settings.push.enabled, false);
});
test("separate detail permissions compose monotonically for every home and project level", () => {
	const levels = ["generic", "project", "message"] as const;
	for (const general of levels) for (const push of levels) for (const project of levels) {
		const policy = resolve({ detail: general, pushDetail: push }, { detail: project, pushDetail: project }).settings;
		assert.equal(policy.detail, levels[Math.min(levels.indexOf(general), levels.indexOf(project))]);
		assert.equal(policy.pushDetail, levels[Math.min(levels.indexOf(push), levels.indexOf(project))]);
		assert.equal(notificationText("input-needed", policy.pushDetail, "/private/folder", "agent").body,
			policy.pushDetail === "generic" ? "" : policy.pushDetail === "project" ? "folder" : "folder: …agent");
	}
	for (const project of [null, { push: null }, { push: [] }]) {
		assert.deepEqual(resolve({ push: destination }, project).settings.push, destination);
		assert.equal(resolve({ push: destination }, project).warnings.length, 1);
	}
});
test("trusted project timing and sequence values replace home settings with exact validation", () => {
	assert.deepEqual(resolve({ minimumDelayMs: 10, cooldownMs: 20, sequences: ["osc9"] }, { minimumDelayMs: 0, cooldownMs: 1, sequences: ["osc99", "osc777"] }).settings.sequences, ["osc99", "osc777"]);
	assert.equal(resolve({ minimumDelayMs: 10 }, { minimumDelayMs: 0 }).settings.minimumDelayMs, 0);
	assert.equal(resolve({ cooldownMs: 20 }, { cooldownMs: 1 }).settings.cooldownMs, 1);
	for (const key of ["minimumDelayMs", "cooldownMs"] as const) {
		for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null, false]) {
			const result = resolve({}, { [key]: value });
			assert.equal(result.settings[key], NOTIFICATION_DEFAULTS[key]);
			assert.equal(result.warnings.length, 1);
		}
		assert.equal(resolve({ [key]: Number.MAX_SAFE_INTEGER }).settings[key], Number.MAX_SAFE_INTEGER);
	}
	for (const value of [[], ["osc9", "osc9"], ["escape"], [9], null, "osc9"]) {
		const result = resolve({ sequences: ["osc99"] }, { sequences: value });
		assert.equal(result.settings.sequences, "auto");
		assert.equal(result.warnings.length, 1);
	}
});
test("push validates addresses and authentication without disclosing private values", () => {
	for (const server of ["https://private.example/base", "http://localhost:8080", "http://127.0.0.1", "http://127.255.1.2", "http://[::1]"]) {
		assert.equal(resolve({ push: { ...destination, server } }).settings.push.enabled, true, server);
	}
	for (const server of ["http://private.example", "http://localhost.private.example", "http://[::2]", "ftp://localhost", "https://user:secret@private.example", "https://private.example/?secret", "https://private.example/#secret", "not-a-url"]) {
		const result = resolve({ push: { ...destination, server } });
		assert.equal(result.settings.push.enabled, false, server);
		assert.equal(result.warnings.length, 1);
		assert.doesNotMatch(result.warnings.join(), /private\.example|secret|private-topic|secret-token/);
	}
	for (const key of ["server", "topic", "token", "username", "password"]) {
		for (const value of [4, "", "secret\x1b"]) assert.equal(resolve({ push: { ...destination, [key]: value } }).settings.push.enabled, false);
	}
	for (const push of [{ enabled: true }, { ...destination, topic: "../private" }, { ...destination, username: "u" }, { ...destination, password: "p" }, { ...destination, username: "u", password: "p" }]) {
		assert.equal(resolve({ push }).settings.push.enabled, false);
	}
	assert.equal(resolve({ push: { enabled: true, server: destination.server, topic: destination.topic, username: "u", password: "p" } }).settings.push.enabled, true);
});
test("loader ignores untrusted projects and replacement cannot manufacture home-only authority", (t) => {
	const root = mkdtempSync(join(tmpdir(), "slate-notification-")), agent = join(root, "agent"), cwd = join(root, "project");
	mkdirSync(agent); mkdirSync(join(cwd, ".pi"), { recursive: true });
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(root, { recursive: true, force: true }); });
	writeFileSync(join(agent, "slate.json"), JSON.stringify({ notifications: { push: destination, detail: "message" } }));
	const project = join(cwd, ".pi", "slate.json");
	symlinkSync(project, project);
	const warnings: string[] = [], warn = (message: string) => warnings.push(message);
	const config = loadConfig(cwd, false, warn);
	assert.deepEqual(warnings, []);
	assert.deepEqual(notificationSettings(config).push, destination);
	assert.equal(notificationSettings(config).detail, "message");
	config.notifications = { push: { ...destination, server: "https://attacker.example" } };
	assert.deepEqual(notificationSettings(config).push, destination);
	assert.equal(notificationSettings({ ...config }).push.enabled, false);
	assert.equal(notificationSettings(Object.create(config)).push.enabled, false);
	assert.equal(notificationSettings(undefined), NOTIFICATION_DEFAULTS);
	rmSync(project);
	writeFileSync(project, JSON.stringify({ notifications: { push: { enabled: true, server: "https://attacker.example" }, minimumDelayMs: 1 } }));
	const reloaded = loadConfig(cwd, true, warn);
	assert.deepEqual(notificationSettings(reloaded).push, destination);
	assert.equal(notificationSettings(reloaded).minimumDelayMs, 1);
	assert.deepEqual(reloaded.notifications, notificationSettings(reloaded));
	assert.deepEqual(warnings, ["slate: ignoring home-only notification push fields in project configuration."]);
});
const hostile = String.fromCodePoint(...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 127 + i), 0x61c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069);
test("all text detail levels remove controls, limit bytes and expose only permitted information", () => {
	assert.equal(sanitizeNotificationText(`before${hostile}after`), "beforeafter");
	assert.equal(truncateNotificationUtf8("😀éX", 5), "😀");
	assert.equal(truncateNotificationUtf8("😀éX", 6), "😀é");
	assert.deepEqual(notificationText("input-needed", "generic", "/private/project", "secret"), { title: "Input needed", body: "", folder: "", copied: "" });
	assert.deepEqual(notificationText("input-needed", "project", `/private/pro${hostile}ject`, "secret"), { title: "Input needed", body: "project", folder: "project", copied: "" });
	assert.deepEqual(notificationText("error", "message", "/private/project", `message${hostile}`), { title: "Error", body: "project: …message", folder: "project", copied: "message" });
	assert.equal(notificationText("error", "message", "/", "literal").body, "…literal");
	assert.equal(notificationText("error", "message", "/project", "head" + "😀".repeat(50)).body, "project: …" + "😀".repeat(50));
	assert.equal(notificationText("error", "message", "/", "head😀" + "é".repeat(99)).body, "…" + "é".repeat(99));
});
test("exact protocol bytes, OSC 9 prefix, OSC 99 metadata and identifiers", () => {
	const text = { title: `1;title${hostile}`, body: `body;:= ${hostile}` };
	assert.equal(notificationSequences("osc9", text)[0]!.toString(), "\x1b]9;Slate: 1title: body:= \x07");
	assert.equal(notificationSequences("osc777", text)[0]!.toString(), "\x1b]777;notify;1title;body:= \x07");
	assert.deepEqual(notificationSequences("osc99", text, "a_+.-1").map(String), ["\x1b]99;i=a_+.-1:d=0;1;title\x1b\\", "\x1b]99;i=a_+.-1:p=body:d=1;body;:= \x1b\\"]);
	for (const id of ["0", "", "a:b", "a;b", "a=b", "a b", "a\x1b", "a".repeat(37), "é"]) assert.throws(() => notificationSequences("osc99", text, id), /identifier/);
	assert.equal(notificationSequences("osc99", { title: "T", body: "" }, "a".repeat(36)).length, 2);
	const first = notificationSequences("osc99", text), second = notificationSequences("osc99", text);
	const extractId = (buffer: Buffer) => buffer.toString().match(/i=([^:]+):/)![1]!;
	assert.equal(extractId(first[0]!), extractId(first[1]!));
	assert.notEqual(extractId(first[0]!), extractId(second[0]!));
	assert.ok(extractId(first[0]!).length <= 36);
});
test("long Unicode sequences preserve headers, terminators and valid UTF-8 within 252 bytes", () => {
	for (const protocol of ["osc9", "osc777", "osc99"] as const) {
		for (const sequence of notificationSequences(protocol, { title: "😀".repeat(300), body: "é😀".repeat(300) }, "a".repeat(36))) {
			assert.ok(sequence.length <= 252);
			assert.equal(new TextDecoder("utf8", { fatal: true }).decode(sequence), sequence.toString());
			assert.ok(sequence.toString().endsWith(protocol === "osc99" ? "\x1b\\" : "\x07"));
			assert.ok(sequence.toString().startsWith(`\x1b]${protocol.slice(3)};`));
		}
	}
});
test("ordered explicit protocols preserve complete requests through tmux, screen and Zellij", () => {
	const order: NotificationProtocol[] = ["osc99", "osc9", "osc777"];
	const text = { title: "title;:=", body: "😀".repeat(100) };
	const sequences = order.flatMap((protocol) => notificationSequences(protocol, text, "id"));
	for (const sequence of sequences) {
		assert.equal(wrapNotificationSequence(sequence, {}), sequence);
		assert.equal(wrapNotificationSequence(sequence, { TMUX: "", STY: "", ZELLIJ: "" }), sequence);
		assert.equal(wrapNotificationSequence(sequence, { ZELLIJ: "1" }), sequence);
		const wrappedTmux = wrapNotificationSequence(sequence, { TMUX: "1" })!;
		assert.deepEqual(wrappedTmux, Buffer.from(`\x1bPtmux;${sequence.toString().replaceAll("\x1b", "\x1b\x1b")}\x1b\\`));
		const tmux = wrappedTmux.toString();
		assert.equal(tmux.slice(7, -2).replaceAll("\x1b\x1b", "\x1b"), sequence.toString());
		const screen = wrapNotificationSequence(sequence, { STY: "1" })!;
		const chunks: Buffer[] = [];
		let start = 0;
		while (start < screen.length) {
			assert.deepEqual(screen.subarray(start, start + 2), Buffer.from("\x1bP"));
			const end = screen.indexOf(Buffer.from("\x1b\\"), start + 2);
			assert.ok(end >= 0 && end + 2 - start <= 256);
			chunks.push(screen.subarray(start + 2, end)); start = end + 2;
		}
		assert.deepEqual(Buffer.concat(chunks), sequence);
		if (sequence.toString().startsWith("\x1b]99;")) {
			assert.equal(chunks.at(-2)!.at(-1), 0x1b);
			assert.equal(chunks.at(-1)![0], 0x5c);
		}
		for (const environment of [{ TMUX: "1", STY: "1" }, { TMUX: "1", ZELLIJ: "1" }, { STY: "1", ZELLIJ: "1" }]) assert.equal(wrapNotificationSequence(sequence, environment), undefined);
	}
});
