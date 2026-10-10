import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { NotificationProtocol } from "./notification-config.ts";

export type NotificationEnvironment = Readonly<Record<string, string | undefined>>;
export const TMUX_QUERY_TIMEOUT_MS = 1000;
export const TMUX_QUERY_MAX_BYTES = 16 * 1024;
const preference = ["osc777", "osc99", "osc9"] as const;
const terminals = {
	iTerm2: { automatic: "osc9", support: ["osc9"] },
	WezTerm: { automatic: "osc777", support: ["osc777", "osc9"] },
	ghostty: { automatic: "osc777", support: ["osc777", "osc9"] },
	kitty: { automatic: "osc99", support: ["osc777", "osc99", "osc9"] },
	foot: { automatic: "osc99", support: ["osc777", "osc99", "osc9"] },
	Konsole: { automatic: "osc777", support: ["osc777", "osc99"] },
	vscode: { automatic: "osc99", support: ["osc99"] },
} satisfies Record<string, { automatic: NotificationProtocol; support: NotificationProtocol[] }>;
export type NotificationTerminal = keyof typeof terminals;
const terminalNames = Object.keys(terminals) as NotificationTerminal[];
const versionPattern = "( [0123456789][abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+_-]*|[(][0123456789][abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+_-]*[)])?";
// tmux 3.3a, 3.4 and 3.5a format_match use REG_EXTENDED|REG_NOSUB, without REG_NEWLINE.
// Explicit character lists keep version matching independent of locale collation.
// Only match bits leave the server. A terminal name is data, never a format to expand again.
export const TMUX_CLIENT_FORMAT = "#{client_pid}\t" + terminalNames.map((name) =>
	`#{m/r:^${name}${versionPattern}$,#{client_termtype}}`).join("");

/** Match names only. Generic TERM values and generic xterm.js replies identify no application. */
export function identifyNotificationTerminal(name: string): NotificationTerminal | undefined {
	const match = /^(iTerm2|WezTerm|ghostty|kitty|foot|Konsole|vscode)(?: [0-9][a-zA-Z0-9.+_-]*|\([0-9][a-zA-Z0-9.+_-]*\))?$/.exec(name);
	return match?.[0] === name ? match[1] as NotificationTerminal : undefined;
}

/** Parse a pid and seven fixed match bits. No terminal-controlled bytes occur in a row. */
export function parseTmuxClients(reply: Buffer): readonly NotificationTerminal[] {
	if (reply.length > TMUX_QUERY_MAX_BYTES) throw new Error("slate: oversized tmux client reply");
	const identified: NotificationTerminal[] = [];
	let offset = 0;
	while (offset < reply.length) {
		const end = reply.indexOf(10, offset);
		if (end < 0) throw new Error("slate: invalid tmux client reply");
		const row = reply.toString("latin1", offset, end);
		const match = /^([0-9]{1,10})\t([01]{7})$/.exec(row);
		if (!match || match[0] !== row) throw new Error("slate: invalid tmux client reply");
		const bits = match[2]!;
		if (bits.indexOf("1") !== bits.lastIndexOf("1")) throw new Error("slate: invalid tmux client reply");
		const terminal = terminalNames[bits.indexOf("1")];
		if (terminal) identified.push(terminal);
		offset = end + 1;
	}
	return identified;
}

/** Enumerate the eight sets. Earlier preference bits win only after coverage and set size. */
export function selectTmuxNotificationProtocols(clients: readonly NotificationTerminal[]): readonly NotificationProtocol[] | undefined {
	if (clients.length === 0) return undefined;
	if (clients.length === 1) return [terminals[clients[0]!].automatic];
	let best: NotificationProtocol[] = [], bestCoverage = -1;
	for (let mask = 0; mask < 8; mask++) {
		const chosen = preference.filter((_protocol, index) => (mask & (4 >> index)) !== 0);
		const counts = clients.map((client) => chosen.filter((protocol) => (terminals[client].support as readonly NotificationProtocol[]).includes(protocol)).length);
		if (counts.some((count) => count > 1)) continue;
		const coverage = counts.filter((count) => count === 1).length;
		if (coverage > bestCoverage || (coverage === bestCoverage && chosen.length <= best.length)) {
			best = chosen; bestCoverage = coverage;
		}
	}
	return best;
}

function within(directory: string, candidate: string): boolean {
	const path = relative(directory, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

let resolving = false;
let cached: { path: string; project: string; executable: string } | undefined;
const dependencyPath = (path: string) => path.split(sep).includes("node_modules");
const invalidateExecutable = (executable: string) => { if (cached?.executable === executable) cached = undefined; };

/** One process-wide search may use the shared filesystem pool. Cache one successful search. */
export async function resolveTmuxExecutable(environment: NotificationEnvironment, signal: AbortSignal, projectDirectory = process.cwd()): Promise<string> {
	const cwd = resolve(projectDirectory), path = environment.PATH ?? "";
	if (signal.aborted) throw new Error("slate: cancelled tmux client query");
	if (path.length > TMUX_QUERY_MAX_BYTES) throw new Error("slate: invalid tmux helper search path");
	if (cached?.path === path && cached.project === cwd) return cached.executable;
	if (resolving) throw new Error("slate: tmux helper search pending");
	resolving = true;
	try {
		const executable = await searchTmuxExecutable(path, cwd, signal);
		if (signal.aborted) throw new Error("slate: cancelled tmux client query");
		cached = { path, project: cwd, executable };
		return executable;
	} finally { resolving = false; }
}

async function searchTmuxExecutable(path: string, cwd: string, signal: AbortSignal): Promise<string> {
	const project = await fs.realpath(cwd);
	for (const directory of path.split(delimiter).slice(0, 128)) {
		if (signal.aborted) throw new Error("slate: cancelled tmux client query");
		if (!isAbsolute(directory) || dependencyPath(directory)) continue;
		const candidate = resolve(directory, "tmux");
		if (within(cwd, candidate) || within(project, candidate)) continue;
		try {
			const realDirectory = await fs.realpath(directory);
			if (within(project, realDirectory) || dependencyPath(realDirectory)) continue;
			const executable = await fs.realpath(candidate);
			if (within(project, executable) || dependencyPath(executable) || !(await fs.stat(executable)).isFile()) continue;
			await fs.access(executable, constants.X_OK);
			return executable;
		} catch { /* An unavailable helper does not authorize a project-local fallback. */ }
	}
	throw new Error("slate: tmux helper unavailable");
}

/** Bound resolution and execution together. Query completion does not accept notification delivery. */
export function queryTmuxClients(environment: NotificationEnvironment, signal: AbortSignal, projectDirectory = process.cwd()): Promise<readonly NotificationTerminal[]> {
	const tmux = environment.TMUX, pane = environment.TMUX_PANE, path = environment.PATH;
	return new Promise((done, reject) => {
		let child: childProcess.ChildProcess | undefined, settled = false;
		const resolution = new AbortController();
		const finish = (error?: Error, clients?: readonly NotificationTerminal[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer); signal.removeEventListener("abort", cancel); resolution.abort();
			if (error) {
				reject(error);
				try { child?.kill("SIGKILL"); } catch { /* Termination failure cannot prevent settlement. */ }
			}
			else done(clients!);
		};
		const cancel = () => finish(new Error("slate: cancelled tmux client query"));
		const timer = setTimeout(() => finish(new Error("slate: tmux client query timed out")), TMUX_QUERY_TIMEOUT_MS);
		timer.unref();
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) { cancel(); return; }
		if (!tmux || tmux.length > 4096 || !/^%[0-9]+$/.test(pane ?? "")) {
			finish(new Error("slate: invalid tmux pane target")); return;
		}
		void (async () => {
			let executable: string | undefined;
			try {
				executable = await resolveTmuxExecutable({ PATH: path }, resolution.signal, projectDirectory);
				if (settled || signal.aborted) return;
				const cwd = parse(resolve(projectDirectory)).root;
				child = childProcess.execFile(executable, ["list-clients", "-t", pane!, "-F", TMUX_CLIENT_FORMAT], {
					cwd, env: { TMUX: tmux, TMUX_PANE: pane, LC_ALL: "C" },
					encoding: "buffer", maxBuffer: TMUX_QUERY_MAX_BYTES, killSignal: "SIGKILL", shell: false, windowsHide: true,
				}, (error, stdout) => {
					if (settled) return;
					if (error) { finish(new Error("slate: tmux client query failed")); return; }
					try { finish(undefined, parseTmuxClients(stdout)); }
					catch { finish(new Error("slate: invalid tmux client reply")); }
				});
				const helper = executable;
				child.on("error", () => { invalidateExecutable(helper); finish(new Error("slate: tmux client query failed")); });
				child.unref(); child.stdin?.destroy();
				for (const stream of [child.stdout, child.stderr]) (stream as typeof stream & { unref?: () => void })?.unref?.();
			} catch {
				if (executable) invalidateExecutable(executable);
				finish(new Error("slate: tmux client query failed"));
			}
		})();
	});
}
