/**
 * CI canary — the positive control for verification/run-load-check.sh.
 *
 * OBSERVATION CHANNEL ONLY. On session_start it prints one line to stderr:
 *
 *   CI-CANARY {"tools":[...],"cwd":"...","trusted":false}
 *
 * and nothing else. It NEVER asserts and NEVER throws: a throw inside a
 * session_start hook does not fail the process (pi reports it as an
 * extension_error event and still exits 0), so a canary that asserted by
 * throwing could not fail CI at all — the objection adversarial review raised
 * against the first design of this file (AD1 in that round; on what those tags
 * are and why they resolve nowhere else, see AGENTS.md § Overview). Every
 * assertion lives in the driver script, which reads this line.
 *
 * Pi 1.0.0 exposes no remote procedure call (RPC) command or command-line
 * interface (CLI) flag that enumerates registered tools.
 * get_commands lists commands only. Removing a dispatch-tool registration
 * leaves exit 0, empty stderr and a working /slate command. This hook observes
 * the registry inside the extension process and gives the driver tool names.
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
