/**
 * Shared notify-string sanitizer (CQ20).
 *
 * Strings that reach ctx.ui.notify / the console can carry user- or
 * extension-supplied content: config values, regex patterns, extension load
 * paths, loader error messages, pending-handoff fields. pi-tui renders
 * control/ANSI codes verbatim, so a raw value could inject terminal escapes —
 * strip control characters and cap the length before display. Extracted here
 * so failover.ts, handoff.ts, worker.ts and worker-extensions.ts share ONE
 * implementation instead of three verbatim copies.
 */
export function sanitizeForNotify(s: string, max = 120): string {
	const clean = s.replace(/[\u0000-\u001f\u007f\u009b]/g, "");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
