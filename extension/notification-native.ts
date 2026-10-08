import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { NotificationChannel } from "./notification-dispatcher.ts";
import { sanitizeNotificationText, truncateNotificationUtf8 } from "./notification-protocols.ts";

export const NATIVE_PREPARE_TIMEOUT_MS = 1000;
export const NATIVE_ATTEMPT_TIMEOUT_MS = 5000;
export const NATIVE_TEXT_MAX_BYTES = 1024;
type Environment = Readonly<Record<string, string | undefined>>;
export interface NativeNotificationOptions {
	readonly mode: string;
	readonly projectDirectory: string;
	readonly platform?: NodeJS.Platform;
	readonly environment?: Environment;
}
const macScript = 'display notification (system attribute "SLATE_NOTIFICATION_BODY") with title (system attribute "SLATE_NOTIFICATION_TITLE")';
// Start-menu discovery supplies a registered application identity, not an invented sender name.
// Text enters XML only through text nodes. The interpreter receives fixed source only.
const windowsScript = `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\StartLayout\\StartLayout.psd1')
$app = Get-StartApps -Name 'Windows PowerShell' | Where-Object { $_.Name -eq 'Windows PowerShell' } | Select-Object -First 1
if (-not $app -or [string]::IsNullOrWhiteSpace($app.AppID)) { exit 1 }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode($env:SLATE_NOTIFICATION_TITLE)) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode($env:SLATE_NOTIFICATION_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app.AppID).Show($toast)
`;
const within = (directory: string, candidate: string) => {
	const path = relative(directory, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};
const dependencyPath = (path: string) => path.split(sep).includes("node_modules");
interface SearchState { pending: boolean; cache?: { key: string; executable: string } }
const searchKey = Symbol.for("ytdb-slate.notification-native-search.v1");
const globalSearch = globalThis as typeof globalThis & { [searchKey]?: SearchState };
const searchState = globalSearch[searchKey] ??= { pending: false };

/** Keep one uncancellable filesystem search across reloads, even after its caller cancels. */
async function resolveHelper(candidates: readonly string[], projectDirectory: string, signal: AbortSignal): Promise<string> {
	const cwd = resolve(projectDirectory), key = JSON.stringify([cwd, candidates]);
	if (signal.aborted) throw new Error("slate: native notification cancelled");
	if (searchState.cache?.key === key) return searchState.cache.executable;
	if (searchState.pending) throw new Error("slate: native helper search pending");
	searchState.pending = true;
	try {
		const project = await fs.realpath(cwd);
		for (const candidate of candidates) {
			if (signal.aborted) break;
			if (!isAbsolute(candidate) || within(cwd, candidate) || dependencyPath(candidate)) continue;
			try {
				const directory = await fs.realpath(dirname(candidate));
				if (within(project, directory) || dependencyPath(directory)) continue;
				const executable = await fs.realpath(candidate);
				if (within(project, executable) || dependencyPath(executable) || !(await fs.stat(executable)).isFile()) continue;
				await fs.access(executable, constants.X_OK);
				if (signal.aborted) break;
				searchState.cache = { key, executable };
				return executable;
			} catch { /* Missing or untrusted helpers do not authorize a project fallback. */ }
		}
		throw new Error("slate: native helper unavailable");
	} finally { searchState.pending = false; }
}

const helpersKey = Symbol.for("ytdb-slate.notification-native-helpers.v1");
const helpersGlobal = globalThis as typeof globalThis & { [helpersKey]?: Set<() => void> };
const helperStops = helpersGlobal[helpersKey] ??= new Set<() => void>();

/** Stop helpers from all runtime copies without waiting for process exit. */
export function stopNativeNotificationHelpers(): void {
	for (const stop of helperStops) stop();
}

/** Helper startup accepts delivery. Only confirmed exit releases the delivery slot. */
function deliver(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<void> {
	return new Promise((done) => {
		let child: childProcess.ChildProcess | undefined, settled = false, accepted = false;
		const finish = () => {
			if (settled) return;
			settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
			helperStops.delete(stop); done();
		};
		const stop = () => {
			if (settled) return;
			if (!child) { finish(); return; }
			// A failed kill retains the slot until exit or close confirms termination.
			try { child.kill("SIGKILL"); } catch { /* Delivery failures stay silent. */ }
		};
		const cancel = () => { if (!accepted) stop(); };
		const timer = setTimeout(stop, NATIVE_ATTEMPT_TIMEOUT_MS);
		timer.unref(); signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) { cancel(); return; }
		try {
			child = childProcess.spawn(executable, [...args], { cwd, env, shell: false, windowsHide: true, stdio: "ignore" });
			child.on("error", () => {
				if (searchState.cache?.executable === executable) searchState.cache = undefined;
				// Spawn failure is followed by close. Kill errors do not confirm exit.
			});
			child.once("spawn", () => { if (!settled) { accepted = true; signal.removeEventListener("abort", cancel); } });
			child.once("exit", finish);
			child.once("close", finish);
			helperStops.add(stop);
			child.unref();
		} catch {
			if (searchState.cache?.executable === executable) searchState.cache = undefined;
			stop();
		}
	});
}

/** Resolve in cancellable preparation. Delivery uses absolute helpers and a minimal OS environment. */
export function createNativeNotificationChannel(options: NativeNotificationOptions): NotificationChannel {
	return { name: "native", async prepare(text, signal) {
		if (options.mode !== "tui" || signal.aborted) return () => {};
		const platform = options.platform ?? process.platform, source = options.environment ?? process.env;
		const title = truncateNotificationUtf8(sanitizeNotificationText(text.title), NATIVE_TEXT_MAX_BYTES);
		const body = truncateNotificationUtf8(sanitizeNotificationText(text.body), NATIVE_TEXT_MAX_BYTES);
		let candidates: string[], args: string[], env: NodeJS.ProcessEnv = {};
		if (platform === "linux") {
			// D-Bus identifies the user service. Display and runtime values identify the desktop session.
			for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) if (source[key]) env[key] = source[key];
			if ((!env.DISPLAY && !env.WAYLAND_DISPLAY) || (!env.DBUS_SESSION_BUS_ADDRESS && !env.XDG_RUNTIME_DIR)) return () => {};
			const path = source.PATH ?? "";
			if (path.length > 16384) return () => {};
			candidates = path.split(delimiter).slice(0, 128).filter(isAbsolute).map((directory) => resolve(directory, "notify-send"));
			args = ["--app-name=Slate", "--", title, body.replaceAll("\\", "\\\\").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")];
		} else if (platform === "darwin") {
			// HOME selects the user's notification preferences. No interpreter search or library overrides cross.
			if (source.HOME) env.HOME = source.HOME;
			candidates = ["/usr/bin/osascript"]; args = ["-e", macScript];
		} else if (platform === "win32") {
			// SystemRoot loads Windows APIs and the fixed StartLayout module. User folders locate Start-menu identity.
			for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (source[key]) env[key] = source[key];
			if (!env.SystemRoot || !isAbsolute(env.SystemRoot)) return () => {};
			candidates = [resolve(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")];
			args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")];
		} else return () => {};
		if (platform !== "linux") { env.SLATE_NOTIFICATION_TITLE = title; env.SLATE_NOTIFICATION_BODY = body; }
		const resolution = new AbortController();
		let timer!: ReturnType<typeof setTimeout>, cancel!: () => void;
		try {
			const executable = await new Promise<string | undefined>((done) => {
				cancel = () => { resolution.abort(); done(undefined); };
				timer = setTimeout(cancel, NATIVE_PREPARE_TIMEOUT_MS); timer.unref();
				signal.addEventListener("abort", cancel, { once: true });
				if (signal.aborted) { cancel(); return; }
				void resolveHelper(candidates, options.projectDirectory, resolution.signal).then(done, () => done(undefined));
			});
			return () => executable && !signal.aborted ? deliver(executable, args, env, parse(resolve(options.projectDirectory)).root, signal) : undefined;
		} finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); resolution.abort(); }
	} };
}
