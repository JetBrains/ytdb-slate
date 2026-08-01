/**
 * Tier-1 CI canary — the positive control for verification/run-load-check.sh.
 *
 * OBSERVATION CHANNEL ONLY. On session_start it prints one line to stderr:
 *
 *   CI-CANARY {"tools":[...],"cwd":"...","trusted":false}
 *
 * and nothing else. It NEVER asserts and NEVER throws: a throw inside a
 * session_start hook does not fail the process (pi reports it as an
 * extension_error event and still exits 0), so a canary that asserted by
 * throwing could not fail CI at all (finding AD1). Every assertion lives in the
 * driver script, which reads this line.
 *
 * Why it exists: pi 0.83.0 exposes no rpc command and no CLI flag that
 * enumerates the registered tools, so silently removing slate's dispatch-tool
 * registration is undetectable from outside the extension process — it exits 0
 * with an empty stderr and a fully working /slate command (finding AD4). Loaded
 * alongside the checkout under test, this hook observes the registry from the
 * inside and hands the driver the tool names to check.
 *
 * NOT part of the shipped package: package.json's `files` whitelist excludes
 * verification/, and nothing in extension/ imports this.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		try {
			const tools = pi.getAllTools().map((t) => t.name);
			console.error("CI-CANARY " + JSON.stringify({ tools, cwd: process.cwd(), trusted: ctx.isProjectTrusted() }));
		} catch (e) {
			// Report, never rethrow: the driver fails on a missing or malformed line.
			console.error("CI-CANARY " + JSON.stringify({ error: String(e) }));
		}
	});
}
