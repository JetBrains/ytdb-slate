/**
 * Shared notify-string sanitizer (CQ20).
 *
 * Strings that reach ctx.ui.notify / the console can carry user- or
 * extension-supplied content: config values, regex patterns, extension load
 * paths, loader error messages, pending-handoff fields. pi-tui renders
 * control/ANSI codes verbatim, so a raw value could inject terminal escapes —
 * strip control characters and cap the length before display.
 *
 * Imported by failover.ts, handoff.ts, worker.ts and worker-extensions.ts, which
 * previously each carried a verbatim copy. model-default.ts deliberately does
 * NOT import this: it also needs the bare control-char strip as a standalone
 * primitive (for its word-boundary report truncation, which this helper does
 * not do), so it keeps that primitive and its own fragment cap together locally
 * — see the note there.
 */
export function sanitizeForNotify(s: string, max = 120): string {
	const clean = s.replace(/[\u0000-\u001f\u007f\u009b]/g, "");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
