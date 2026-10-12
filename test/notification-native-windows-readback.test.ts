import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { createNativeNotificationChannel, NATIVE_ATTEMPT_TIMEOUT_MS, NATIVE_TEXT_MAX_BYTES } from "../extension/notification-native.ts";
import { sanitizeNotificationText, truncateNotificationUtf8 } from "../extension/notification-protocols.ts";
import { requiredCase } from "./required-case.ts";

const caseName = "Windows native notification retains exact unique text in operating system toast history";
const pollLimitMs = 30000;
const outputLimitBytes = 1024 * 1024;
const bounded = (value: unknown) => String(value).slice(0, 2000);
// Both scripts contain fixed source only. History access and diagnostic properties are read-only.
const diagnosticSource = String.raw`
$ErrorActionPreference = 'Stop'
$diagnostics = [ordered]@{
    sessionId = (Get-Process -Id $PID).SessionId
    userInteractive = [Environment]::UserInteractive
    windowsVersion = [Environment]::OSVersion.VersionString
}
$result = [ordered]@{ ok = $false; diagnostics = $diagnostics; appId = $null; toasts = @(); error = $null }
try {
    $diagnostics.services = @(Get-Service -Name 'WpnUserService*' | ForEach-Object { @{ name = $_.Name; status = [string]$_.Status } })
    Import-Module (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\StartLayout\StartLayout.psd1')
    $app = Get-StartApps -Name 'Windows PowerShell' | Where-Object { $_.Name -eq 'Windows PowerShell' } | Select-Object -First 1
    $diagnostics.startApp = if ($app) { @{ name = $app.Name; appId = $app.AppID } } else { $null }
    if (-not $app -or [string]::IsNullOrWhiteSpace($app.AppID)) { throw 'Windows PowerShell Start entry has no AppID' }
    $result.appId = [string]$app.AppID
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $diagnostics.notifierSetting = [string][Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app.AppID).Setting
`;
const framingSource = String.raw`
} catch { $result.error = [string]$_.Exception.Message }
$json = ConvertTo-Json -InputObject $result -Depth 8 -Compress
[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
if (-not $result.ok) { exit 1 }
`;
const historyScript = diagnosticSource + String.raw`
    $result.toasts = @(foreach ($toast in [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($app.AppID)) {
        $nodes = $toast.Content.GetElementsByTagName('text')
        $texts = @(for ($index = 0; $index -lt $nodes.Length; $index++) { [string]$nodes.Item($index).InnerText })
        @{ texts = $texts }
    })
    $result.ok = $true
` + framingSource;
const diagnosticScript = diagnosticSource + "\n    $result.ok = $true\n" + framingSource;
type History = { appId: string; toasts: { texts: string[] }[] };

// Other platforms register no native case. The required roster selects win32 only.
if (process.platform === "win32") requiredCase(caseName, { timeout: 60000 }, async (t, complete) => {
	const childErrors: string[] = [];
	let executable: string | undefined, diagnostics: unknown, candidate: string[] | undefined;
	let polls = 0, deliveryMs: number | undefined;
	const environment: NodeJS.ProcessEnv = {};
	for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
		if (process.env[key]) environment[key] = process.env[key];
	}
	function read(script: string, timeout: number): History {
		assert.ok(executable, "the reading child requires an absolute PowerShell path");
		const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64")], {
			env: environment, cwd: parse(executable).root, encoding: "utf8", timeout, killSignal: "SIGKILL",
			maxBuffer: outputLimitBytes, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			// ASCII framing avoids Windows PowerShell 5.1 console code-page loss.
			const framed = result.stdout.trim();
			assert.ok(framed.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(framed), "history output must be one base64 frame");
			const bytes = Buffer.from(framed, "base64");
			assert.equal(bytes.toString("base64"), framed, "history frame must be canonical base64");
			const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), "history frame must contain an object");
			diagnostics = payload.diagnostics;
			assert.equal(result.error, undefined, `history child error: ${bounded(result.error)}`);
			assert.equal(result.status, 0, `history child status=${result.status} signal=${result.signal} error=${bounded(payload.error)}`);
			assert.equal(payload.ok, true, `history read failed: ${bounded(payload.error)}`);
			assert.ok(typeof payload.appId === "string" && payload.appId.trim().length > 0, "history read requires a Start-menu AppID");
			assert.ok(Array.isArray(payload.toasts), "history read requires a toast array");
			for (const toast of payload.toasts) assert.ok(toast && Array.isArray(toast.texts) &&
				toast.texts.every((text: unknown) => typeof text === "string"), "each history toast requires string text nodes");
			return payload;
		} catch (error) {
			const message = `history child: status=${result.status} signal=${result.signal} error=${bounded(result.error ?? error)} stderr=${bounded(result.stderr)}`;
			childErrors.push(message);
			throw new Error(message, { cause: error });
		}
	}
	try {
		const systemRoot = process.env.SystemRoot;
		assert.ok(systemRoot && isAbsolute(systemRoot), "Windows native read-back requires an absolute SystemRoot");
		executable = resolve(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
		assert.ok((await stat(executable)).isFile(), "Windows native read-back requires powershell.exe");
		await access(executable, constants.X_OK);
		const titleMarker = randomUUID(), bodyMarker = randomUUID();
		const text = { title: `-e Slate ${titleMarker}; "quoted": \\ <&> café 中文 😀`,
			body: `-- Read-back ${bodyMarker}; "body": \\ <&> café 中文 😀` };
		for (const value of [text.title, text.body]) {
			assert.ok(Buffer.byteLength(value, "utf8") <= NATIVE_TEXT_MAX_BYTES, "test text must fit the native byte cap");
			assert.equal(truncateNotificationUtf8(sanitizeNotificationText(value), NATIVE_TEXT_MAX_BYTES), value,
				"expected text must equal the exact product-sanitized text");
		}
		const hasMarker = (texts: string[]) => texts.some((value) => value.includes(titleMarker) || value.includes(bodyMarker));
		const baseline = read(historyScript, 10000);
		assert.ok(baseline.toasts.every((toast) => !hasMarker(toast.texts)), "both unique markers must be absent before sending");
		const controller = new AbortController();
		// The product does not keep its delivery child referenced. The case owns this timer.
		const keepAlive = setInterval(() => {}, 1000);
		t.after(() => { clearInterval(keepAlive); controller.abort(); });
		// Default environment handling is the exact production path, including its minimal child environment.
		const channel = createNativeNotificationChannel({ mode: "tui", platform: "win32", projectDirectory: process.cwd() });
		const deliver = await channel.prepare(text, controller.signal);
		const start = performance.now();
		try { await deliver(); } finally { deliveryMs = performance.now() - start; }
		const deadline = performance.now() + pollLimitMs;
		let found = false;
		while (performance.now() < deadline && !found) {
			polls++;
			const remaining = Math.floor(deadline - performance.now());
			assert.ok(remaining > 0, "the polling allowance must remain positive");
			const history = read(historyScript, Math.min(2000, remaining));
			assert.ok(performance.now() <= deadline, "the history read must finish within the polling allowance");
			assert.equal(history.appId, baseline.appId, "the read-back AppID must match the baseline identity");
			for (const toast of history.toasts) {
				if (!hasMarker(toast.texts)) continue;
				candidate = toast.texts;
				assert.equal(candidate.length, 2, "the candidate must retain exactly two text nodes");
				assert.equal(candidate[0], text.title, "toast history must retain the exact title");
				assert.equal(candidate[1], text.body, "toast history must retain the exact body");
				found = true;
				break;
			}
			if (!found) await delay(Math.min(500, Math.max(0, deadline - performance.now())));
		}
		assert.ok(found, `no toast retained the exact title and body within ${pollLimitMs} ms`);
		t.diagnostic(`Windows native history read-back: AppID=${JSON.stringify(baseline.appId)} polls=${polls} productDeliveryMs=${deliveryMs.toFixed(1)} nativeAttemptTimeoutMs=${NATIVE_ATTEMPT_TIMEOUT_MS}`);
		complete();
	} catch (error) {
		// One bounded diagnostic child can recover metadata after a failed or timed-out history read.
		if (executable && !diagnostics) {
			try { read(diagnosticScript, 2000); } catch { /* Child errors remain in the bounded diagnostics below. */ }
		}
		t.diagnostic(`Windows native read-back failure: ${bounded(error)}`);
		t.diagnostic(`reading child: ${bounded(JSON.stringify(diagnostics ?? "unavailable"))}`);
		t.diagnostic(`ImageOS=${bounded(process.env.ImageOS ?? "absent")} ImageVersion=${bounded(process.env.ImageVersion ?? "absent")}`);
		t.diagnostic(`polls=${polls} productDeliveryMs=${deliveryMs === undefined ? "not called" : deliveryMs.toFixed(1)} nativeAttemptTimeoutMs=${NATIVE_ATTEMPT_TIMEOUT_MS}`);
		if (candidate) {
			t.diagnostic(`decoded title: ${bounded(JSON.stringify(candidate[0]))}`);
			t.diagnostic(`decoded body: ${bounded(JSON.stringify(candidate[1]))}`);
		}
		t.diagnostic(`child errors: ${bounded(childErrors.join("\n"))}`);
		throw error;
	}
});
