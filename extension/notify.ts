/**
 * Shared notify-string sanitizer (CQ20).
 *
 * Strings that reach ctx.ui.notify / the console can carry user- or
 * extension-supplied content: config values, regex patterns, extension load
 * paths, loader error messages, pending-handoff fields. pi-tui renders
 * control/ANSI codes verbatim, so a raw value could inject terminal escapes —
 * strip control characters and cap the length before display.
 *
 * Imported across failover.ts, handoff.ts, worker.ts, worker-extensions.ts,
 * writing.ts, state.ts, episodes.ts, threads.ts, route.ts, base-model.ts and
 * model-router.ts. This shared change therefore affects every notify or console
 * warning those modules emit. model-default.ts deliberately does NOT import this:
 * it also needs the bare control-char strip as a standalone primitive (for its
 * word-boundary report truncation, which this helper does not do), so it keeps
 * that primitive and its own fragment cap together locally — see the note there.
 */
export function sanitizeForNotify(s: string, max = 120): string {
	// Remove all C0 and C1 controls, DEL, and Unicode bidirectional formatting
	// controls. A directional override can reorder visible warning text even when
	// it is not a terminal escape, and truncation can otherwise separate its pair.
	const clean = s.replace(/[\u0000-\u001f\u007f\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
