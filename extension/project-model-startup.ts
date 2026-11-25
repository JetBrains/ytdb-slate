import * as piSdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { currentModelSpec } from "./base-model.ts";
import { sanitizeForNotify } from "./notify.ts";
import { readProjectModel } from "./startup-summary.ts";
import { splitModelSpec } from "./state.ts";

const readWarnings = {
	"key-unavailable": "Slate cannot determine the project key.",
	"store-unreadable": "Slate cannot read the private store.",
	"invalid-entry": "The private project model entry is invalid.",
} as const;

export function reportPrivateProjectModel(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	message: string,
	level: "warning" | "info",
): void {
	try {
		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
			return;
		}
	} catch {
		// Send the same message to the console if the notice fails.
	}
	try {
		if (level === "warning") console.warn(message);
		else console.info(message);
	} catch {
		// A reporting failure must not stop session startup.
	}
}

export async function applyPrivateProjectModel(
	pi: Pick<ExtensionAPI, "setModel" | "getThinkingLevel" | "setThinkingLevel">,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") return;

	if (event.reason === "resume" || event.reason === "fork" || event.reason === "reload") return;
	const session = ctx.sessionManager;
	// The file header identifies a fork child even when Pi reopens it.
	if (event.reason === "startup" && session.getSessionFile() && session.getHeader()?.parentSession) return;
	const entries = session.getEntries();
	if (entries.some((entry) => entry?.type === "custom" && entry.customType === "slate-handoff" &&
		(entry.data as { sessionId?: unknown } | null)?.sessionId === session.getSessionId())) return;
	// A damaged message still counts because the session is not provably empty.
	if (entries.some((entry) => entry?.type === "message" || entry?.type === "custom_message" ||
		entry?.type === "compaction" || (entry?.type === "branch_summary" && entry.summary))) return;

	const args = piSdk.parseArgs(process.argv.slice(2));
	if (args.model) return;
	const result = readProjectModel(ctx.cwd);
	if (result.kind === "none") return;

	const report = (message: string, level: "warning" | "info") => reportPrivateProjectModel(ctx, message, level);
	const warn = (reason: string) => report(`slate: Private project model not applied. ${reason}`, "warning");
	if (result.kind !== "entry") return warn(readWarnings[result.kind]);

	const { model: spec, thinkingLevel } = result.entry;
	const label = sanitizeForNotify(spec);
	const target = splitModelSpec(spec)!; // The private store reader validates the model.
	const model = ctx.model;
	const previousLevel = pi.getThinkingLevel();
	const requested = args.thinking ?? thinkingLevel;
	const isTarget = (candidate: ExtensionContext["model"]) =>
		candidate?.provider === target.provider && candidate.id === target.id;
	const switchModel = !isTarget(model);
	if (!switchModel && previousLevel === requested) return;

	const selected = ctx.modelRegistry.find(target.provider, target.id);
	if (!selected) return warn(`Pi does not know model ${label}.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(selected)) return warn(`No credentials are configured for ${label}.`);

	const warnLiveState = (liveLevel: typeof previousLevel) => {
		const liveModel = sanitizeForNotify(currentModelSpec(ctx) ?? "none");
		report(`slate: Private project model switch failed. The session now uses ${liveModel} with thinking level ${liveLevel}. The requested thinking level was ${requested}.`, "warning");
	};
	try {
		if (switchModel) {
			if (!(await pi.setModel(selected))) return warn(`Pi refused to switch to ${label}.`);
			if (!isTarget(ctx.model)) return warnLiveState(pi.getThinkingLevel());
		}
		if (pi.getThinkingLevel() !== requested) pi.setThinkingLevel(requested);
	} catch {
		const liveLevel = pi.getThinkingLevel();
		if (ctx.model === model && liveLevel === previousLevel) {
			return warn(`Pi could not apply ${label} before changing the session model or thinking level.`);
		}
		return warnLiveState(liveLevel);
	}

	const effective = pi.getThinkingLevel();
	report(`slate: Applied private project model ${label} with thinking level ${effective}.`, "info");
	if (effective !== requested) {
		report(`slate: Requested thinking level ${requested} differs from the effective thinking level ${effective}.`, "warning");
	}
}
