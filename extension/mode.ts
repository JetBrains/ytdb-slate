/**
 * Orchestrator mode (ExecPlan M2, D4).
 *
 * `/slate` toggles orchestrator mode:
 *   - active tools restricted to read-only + slate tools (no bash/edit/write):
 *     delegation becomes the natural behavior;
 *   - the thread-weaving doctrine is appended to the system prompt each turn;
 *   - a status line shows orchestrator spend and pause state;
 *   - the mode persists in slate state and is re-applied on session restore;
 *   - with config `orchestratorModeDefault` (slate.json), genuinely fresh
 *     interactive sessions are seeded with the mode ON (unsaved until the
 *     first real state mutation).
 *
 * `/slate handoff [focus]` / `/slate resume` interact with the auto-pause
 * machinery in handoff.ts (context budget → paused → fresh-session handoff).
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { createChangeFolder } from "./artifact-names.ts";
import { createChangeDirectory } from "./slate-files.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SlateHandoffHooks } from "./handoff.ts";
import type { LogicalRuntime } from "./logical-model-runtime.ts";
import {
	BLAST_RADIUS_DOC,
	DESIGN_PRINCIPLES_DOC,
	PR_PUBLISHING_DOC,
	REVIEW_RULES_DOC,
	TRACK_WORKFLOW_DOC,
	WRITING_GUIDANCE_DOC,
} from "./paths.ts";
import { permitsSlateConfig } from "./config.ts";
import { loadPromptDocs } from "./prompt-docs.ts";
import {
	orchestratorCostUsd,
	type SlateConfig,
	type SlateStore,
} from "./state.ts";
import {
	advanceWritingReminderTurn,
	claimWritingReminder,
	renderDesignDoctrineRequirements,
	commitWritingReminder,
	decideWritingReminder,
	rearmWritingReminder,
	renderWritingDoctrineRequirements,
	renderWritingDoctrineStyleRules,
	renderWritingReminderMessage,
	renderWritingScopeExclusion,
	WRITING_REQUIREMENTS_TITLE,
	resetWritingReminderSession,
	WRITING_REMINDER_CUSTOM_TYPE,
	writingReminderDeliveryDetails,
	writingReminderDeliveryMode,
	writingReminderGateOpen,
} from "./writing-reminder.ts";
import {
	createWritingCounters,
	DEFAULT_REMIND_ON_FINDING,
	DEFAULT_REMIND_TURNS,
	DEFAULT_SENTENCE_WORD_LIMIT,
	DEFAULT_STATUS_WINDOW_TURNS,
	loadWritingChecker as loadWritingCheckerModule,
	measureWritingTurn,
	resetWritingCounters,
	resizeWritingWindow,
	type WritingChecker,
} from "./writing.ts";
import type { WorkerExtensionSet, WorkerExtensionUnit } from "./worker-extensions.ts";
import { preferencePath, readStartupSummary, renderStartupSummary, saveStartupSummary, SUMMARY_WIDGET_KEY } from "./startup-summary.ts";

const ORCHESTRATOR_TOOLS = ["read", "grep", "find", "ls", "thread", "threads", "episode", "slate_change"];

/**
 * Build the orchestrator doctrine. Rules 8–10 reference the package-shipped
 * workflow/review/design docs by ABSOLUTE path (paths.ts) so they resolve
 * wherever the package is installed. Rules 8 and 9 carry config-dependent
 * tails (workflow.draftPRs, reviewPerspectivesPath), so the doctrine is
 * assembled per prompt rather than kept as a constant. Project-derived
 * additions (rule 9's perspectives pointer) apply only when `trusted` and
 * the file exists (cwd-resolved) — missing files are skipped silently like
 * every other project doc.
 */
// A source spec that names WHICH extension (e.g. "npm:foo") is worth showing;
// the generic scope-ish sources are not, so rule 11 falls back to the unit path.
const UNINFORMATIVE_SOURCES = new Set(["", "auto", "local", "cli", "project", "user", "temporary", "builtin", "sdk"]);

function unitLabel(unit: WorkerExtensionUnit): string {
	return UNINFORMATIVE_SOURCES.has(unit.source) ? unit.path : unit.source;
}

// Per-field caps for the doctrine interpolations (WB21): a tool name is an
// identifier, a unit label is a package spec or path, a description is a
// sentence. Caps keep a pathological 2000-char value from bloating every turn.
const DOCTRINE_NAME_MAX = 64;
const DOCTRINE_LABEL_MAX = 128;
const DOCTRINE_DESC_MAX = 140;

// ONE sanitizer for every extension-supplied string interpolated into the
// orchestrator doctrine — tool names, unit labels and descriptions (WB20/WB21/
// WB22). The doctrine is a numbered, indented plain-text block inside the
// system prompt, so a raw value must not be able to: (WB20) inject a newline
// that forges a new numbered directive; (WB21) run on for thousands of
// characters; or (WB22) carry backticks/markdown that break the block's
// structure or read as an instruction. Control characters and newlines collapse
// to spaces, backticks and markdown structural markers are dropped, remaining
// whitespace is collapsed, and the result is capped with an ellipsis.
function sanitizeForDoctrine(value: string, max: number): string {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f\u009b]/g, " ") // control chars + newlines → space (WB20)
		.replace(/[`*_~#>|]/g, " ") // code fences / markdown structure → space (WB22)
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}\u2026` : cleaned;
}

/**
 * Rules 1–10 are unconditional and carry literal numbers; every rule after them
 * is CONDITIONAL and takes its number from its POSITION among the tail rules
 * that actually rendered (numberedTail below).
 *
 * What that guarantees is narrower than "renumbering is safe", and the
 * difference matters to whoever adds the next rule (CQ28): APPENDING a builder
 * cannot renumber the rules before it, and a rule that does not render consumes
 * no number, so the sequence never gains a gap. INSERTING one ahead of an
 * existing builder renumbers everything after it — nothing here prevents that.
 * Worker extensions are rule 11 only because they are listed FIRST at the call
 * site in buildDoctrine, not because this module pins them to that slot.
 */
const FIXED_DOCTRINE_RULES = 10;

// Real assistant messages measured 296 characters at the median, 2,348 at p90,
// and 6,140 at the maximum in the review sample. Keep headroom for normal prose,
// while preventing an unknown checker slowdown from freezing the TUI.
const WRITING_TURN_MAX_BYTES = 16 * 1024;

type WritingStatus = "fresh" | "ready" | "skipped" | "unavailable";

function assistantTextBytes(message: unknown): number | undefined {
	if (!message || typeof message !== "object") return undefined;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return Buffer.byteLength(content, "utf8");
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
	return Buffer.byteLength(text, "utf8");
}

/**
 * Number the conditional tail rules by position. Each builder is handed the
 * number it would take and returns "" when its feature is off; only a rendered
 * rule consumes a number, so a doctrine with no tail rules is byte-identical to
 * the pre-feature output and one with a single tail rule numbers it 11.
 */
function numberedTail(builders: readonly ((n: number) => string)[]): string {
	let last = FIXED_DOCTRINE_RULES;
	let out = "";
	for (const build of builders) {
		const rule = build(last + 1);
		if (rule === "") continue;
		last += 1;
		out += rule;
	}
	return out;
}

/**
 * Rule 11 (worker-extension awareness): appended ONLY when workers load extra
 * pi extensions. With no units it returns "" so the doctrine is byte-identical
 * to the pre-feature output (feature-off is unchanged). Phrased to match the
 * imperative register of rules 1–10 (WS20/WS21/WS22): it LEADS with the action
 * (delegate to a thread), states the constraint in the doctrine's own "cannot"
 * voice, and CLOSES with an instruction. The extension/tool listing in the
 * middle is data and renders verbatim.
 */
function buildWorkerExtensionsRule(extensions: WorkerExtensionSet, n: number): string {
	if (extensions.units.length === 0) return "";
	const lines = [
		`${n}. Delegate any action that needs one of these worker-loaded pi extensions to a`,
		"   thread; you cannot call their tools yourself:",
	];
	for (const unit of extensions.units) {
		lines.push(`   - ${sanitizeForDoctrine(unitLabel(unit), DOCTRINE_LABEL_MAX)}`);
		for (const tool of unit.tools) {
			lines.push(`     ${sanitizeForDoctrine(tool.name, DOCTRINE_NAME_MAX)}: ${sanitizeForDoctrine(tool.description, DOCTRINE_DESC_MAX)}`);
		}
	}
	lines.push(
		"   Assume every worker already has them — you need not pass them in a thread's",
		"   `tools` allowlist.",
	);
	return `\n${lines.join("\n")}`;
}

// ----------------------------------------------- the logical-model rule --

function buildLogicalModelRule(runtime: Readonly<LogicalRuntime> | undefined, n: number): string {
	const prompt = runtime?.promptText();
	if (prompt === undefined) {
		const reason = runtime?.criticalErrors.join(" ") || "The logical model policy is unavailable.";
		return `\n${n}. Logical model work is blocked: ${sanitizeForDoctrine(reason, 600)}`;
	}
	return `\n${n}. Every \`thread\` call must name logical \`model\` and a short \`reason\`. Effort is fixed by policy. The orchestrator selects the model for a no-area track under the same ordinary guidance.\n${prompt}`;
}

/**
 * The writing rule — the THIRD tail rule, so 13 when the worker-extension and
 * routing rules both render above it. Appended only for trusted projects.
 *
 * WHOLLY STATIC except for `n` and the package-resolved doc path. Nothing derived
 * from project config, project files, the model registry or any extension reaches
 * this text. The rule therefore needs no sanitizer of its own. The moment a value
 * from outside this module is interpolated here, this becomes an injection surface
 * and needs the treatment rule 11 gives its fields (see sanitizeForDoctrine) or
 * the routing rule gives its cells (see `cell()`).
 *
 * The doc citation is an ABSOLUTE path resolved inside the installed package
 * (paths.ts), like rules 8-10 and the routing rule. It is therefore paid for at
 * the length of the reader's own install directory: every character of the
 * installed docs directory costs one more character here, on every turn of every
 * trusted orchestrator session. That is the whole reason the citation is one
 * line of prose plus one path rather than a summary of the document —
 * writing-guidance.md carries the rules, the caps and the command line, and the
 * rule tells the orchestrator when reading it is worth the tokens.
 */
function buildWritingRule(n: number): string {
	return `
${n}. Check user-facing prose before delivery. Write sentences a reader understands
   on one reading. ${renderWritingDoctrineStyleRules("   ")} The checker does not
   test vocabulary. Follow these ${WRITING_REQUIREMENTS_TITLE.toLowerCase()}:
${renderWritingDoctrineRequirements("   ")}

   Apply these requirements to README and documentation text, code comments and
   pull request text. Apply these requirements also to commit bodies, issues,
   review comments, release notes and user messages.
${renderWritingScopeExclusion("   ")}
   Rules, limits, and checker: ${WRITING_GUIDANCE_DOC}. Read it only for an unusual
   prose decision. Skip it if already in context.`;
}

/** Render the final trusted doctrine rule for design discipline. */
function buildDesignRule(n: number): string {
	return `
${n}. Follow these design requirements:
${renderDesignDoctrineRequirements("   ")}`;
}

function buildDoctrine(
	cwd: string,
	config: SlateConfig,
	trusted: boolean,
	extensions: WorkerExtensionSet,
	runtime: Readonly<LogicalRuntime> | undefined,
	currentChange?: string,
	sourceChange?: string,
	legacyLog = false,
): string {
	// Rule 8 tail: draft publishing creates one umbrella pull request.
	// Otherwise durable records live in the research log. The completion
	// pointer is trusted and opt-in. Its combined publishing form cites the full
	// publishing rules so the fixed whole-doctrine boundary keeps its headroom.
	const routingRecommendations = trusted && config.workflow?.routingRecommendations === true;
	const rule8Tail =
		config.workflow?.draftPRs === true
			? routingRecommendations
				? `Publish one umbrella draft PR for the change. Keep tracks mergeable.
   Only users merge. Follow ${PR_PUBLISHING_DOC}.`
				: `Publish one umbrella draft PR for the change. Keep tracks mergeable.
   Only users merge. Mechanics: ${PR_PUBLISHING_DOC}.`
			: `Keep workflow records in the change folder.`;
	const routingRecommendationTail = routingRecommendations
		? "\n   At change completion, follow Lifecycle's routing-recommendation rule before final acceptance."
		: "";
	const followUpTail = trusted && config.workflow?.followUpIssues === true
		? "\n   After review, ask the user which deferred items become tracked issues."
		: "";
	const perspectives = config.reviewPerspectivesPath;
	const rule9Tail =
		trusted && typeof perspectives === "string" && perspectives && existsSync(resolve(cwd, perspectives))
			? `
   Project-specific review perspectives are defined in ${perspectives} —
   load them alongside the review rules when composing reviewers.`
			: "";
	const changePaths = currentChange
		? `\n\nCurrent research log: slate-changes/${currentChange}/research-log.md\nImplementer report: slate-changes/${currentChange}/track-<number>-implementer-report.md.`
		: "\n\nNo change open. Use slate_change start.";
	const earlierLogs = sourceChange ? `\nRead-only source log: slate-changes/${sourceChange}/research-log.md. Follow each log's first entry to read the full source chain and accounting.` : "";
	const legacyPath = legacyLog ? "\nRead-only legacy root log: research-log.md." : "";
	return `

# Slate orchestrator mode

You orchestrate thread weaving. You strategize; workers execute. Rules:

1. Do tactical work ONLY through bounded \`thread\` actions. You cannot edit files
   or run commands yourself.
2. Dispatch independent actions in PARALLEL in one turn. Never serialize work
   that can run concurrently.
3. Every \`thread\` call creates a new thread for one action. A follow-up action
   must use another new thread. No worker conversation crosses that boundary.
4. Compose context by reference. Pass prior episode ids in \`context\` instead
   of restating their content. Slate loads those episodes into the new worker prompt.
5. Use read-only tools for orientation. Delegate substantial work.
6. Update strategy after every episode. Partial responses become failed episodes.
   A failure without a response uses a fixed episode. STATUS: FAILED requires
   adaptation, not blind retry.
7. Keep your messages strategic: goals, routing, synthesis.
8. Keep separate change/track records. NAMED: defect, place,
   consequence, review contribution. User approval proves it. Rejection is
   SKIPPED. Proved areas add specialists and one Reviewer I. Estimate each track
   first. Above 100 counted lines requires design before work, even
   documentation-only. Implementer reports approximate size in response and
   report. Above 100 adds Reviewer I except documentation-only.
   Size adds no specialist, design adversary or track acceptance. If size crosses 100
   late, add Reviewer I unless documentation-only. No late design. Use larger size later.
   Late areas add only specialists if Reviewer I ran. Definitions: ${BLAST_RADIUS_DOC}.
   Lifecycle: ${TRACK_WORKFLOW_DOC}. User judges proofs and simplicity.
   Approve proofs before edits. Apply evidence and prior answers before asking.
   Evidence cannot authorize. Reuse approvals only
   for covered decisions with current conditions and prerequisites complete
   when answered. Ask only unresolved parts. Explain changes. Preserve
   gates and reviews. Each proved DESIGN-TRIGGERING area requires design, user
   validation, focus reconfirmation, adversarial design review, final approval,
   and blocking track acceptance.
   REVIEWER-ONLY or no-area tracks need no track acceptance.
   Final acceptance always blocks.
   ${rule8Tail}${routingRecommendationTail}
9. Before review dispatch, follow ${REVIEW_RULES_DOC}. Read unless in context.
   Implementation review: pass built-in perspectives and data.
   No-area model choice follows Lifecycle.${rule9Tail}${followUpTail}
10. Design rationale: ${DESIGN_PRINCIPLES_DOC}. Read it only to explain or change
   slate, or for an unusual routing or compaction decision.
   Never read it for routine dispatching. Skip the read if it is already in your context.${changePaths}${earlierLogs}${legacyPath}${numberedTail([
		(n) => buildWorkerExtensionsRule(extensions, n),
		(n) => (trusted ? buildLogicalModelRule(runtime, n) : ""),
		// Append-only conditional tail. Writing guidance is active for every trusted
		// project in orchestrator mode, independent of the ignored writing keys.
		(n) => (trusted ? buildWritingRule(n) : ""),
		(n) => (trusted ? buildDesignRule(n) : ""),
	])}`;
}

/**
 * Project doctrine extension (config doctrineExtraPath): read at prompt-
 * assembly time so edits are picked up live, appended AFTER the numbered
 * rules under a labeled section, headed by the source-resolved
 * path as given in config. Missing/unreadable/empty file or a non-string
 * path → no block, silently (matches the malformed-config behavior of
 * prompt-docs.ts). Requires permitted Slate configuration. Blocks carry NO
 * separators — the call site prefixes them, like the prompt-doc blocks.
 */
function loadDoctrineExtra(cwd: string, config: SlateConfig, trusted: boolean): string[] {
	const path = config.doctrineExtraPath;
	if (!trusted || typeof path !== "string" || !path) return [];
	try {
		const content = readFileSync(resolve(cwd, path), "utf8").trim();
		if (!content) return [];
		return [`# Project doctrine (injected from ${path})\n\n${content}`];
	} catch {
		return [];
	}
}

const PAUSED_ADDENDUM = `

# PAUSED — context budget exceeded

Slate is paused for handoff. Orchestrator worker dispatches remain available.
Save the project state in the research log through exactly one worker at a time.
Wait for that worker result and verify that it reports success before writing the
final handoff brief. If preparation fails or is incomplete, report that fact and
do not claim that the state was saved. Do not start other user work. Reply with
a concise handoff brief (overall goal, per-thread state with episode ids,
immediate next actions) and direct the user to run /slate handoff [optional
focus].`;

const PAUSED_INPUT_REFUSAL =
	"slate: paused for handoff — input rejected. Run /slate resume or /slate handoff [focus].";

/**
 * Report one refused prompt on exactly ONE channel, and never throw.
 *
 * RI1: a session with a terminal user interface gets the notification only. An
 * unconditional stderr write would scribble pi-tui's differentially rendered
 * frame, and this notice fires on every refused prompt, not only on a failure.
 * The stderr line is therefore the FALLBACK: no user interface, a throwing
 * `hasUI` getter on a stale context, or a throwing `notify`.
 *
 * CN7: pi's emitInput catches a throwing input handler and CONTINUES, which
 * admits the very prompt this handler refuses. Reporting is best effort for
 * that reason: every channel is wrapped, and a session whose console also
 * throws still gets the refusal, only without a visible notice.
 *
 * It sends no message and starts no turn.
 */
function reportPausedInput(ctx: ExtensionContext): void {
	try {
		if (ctx.hasUI) {
			ctx.ui.notify(PAUSED_INPUT_REFUSAL, "warning");
			return;
		}
	} catch {
		/* fall through to the console report */
	}
	try {
		console.warn(PAUSED_INPUT_REFUSAL);
	} catch {
		/* every channel failed; the refusal below still holds */
	}
}

export function registerSlateMode(
	pi: ExtensionAPI,
	store: SlateStore,
	hooks: SlateHandoffHooks,
	getConfig: () => SlateConfig,
	getExtensions: () => WorkerExtensionSet,
	getRuntime: () => Readonly<LogicalRuntime> | undefined = () => undefined,
	// Injected only by the pure harness so it can exercise both dynamic-import
	// failure and checker failure through the real turn hook.
	loadWritingChecker: () => Promise<WritingChecker> = loadWritingCheckerModule,
	saveSummary: typeof saveStartupSummary = saveStartupSummary,
): void {
	let savedTools: string[] | undefined;
	let uiCtx: ExtensionContext | undefined;
	const writingCounters = createWritingCounters();
	let writingStatus: WritingStatus = "fresh";
	let writingCheckerPromise: Promise<WritingChecker> | undefined;
	let latestTurnHasFinding = false;
	let pendingErrorTurn = false;
	let previousTurnHadTools = false;
	let summaryVisible = false;
	let statusStyleWarningShown = false;

	const warnSummary = (ctx: ExtensionContext, message: string) => {
		try {
			if (ctx.hasUI) { ctx.ui.notify(message, "warning"); return; }
		} catch { /* stale UI: use the console */ }
		console.warn(message);
	};

	const writingIsActive = (ctx: ExtensionContext): boolean => store.orchestratorMode && permitsSlateConfig(getConfig(), ctx.isProjectTrusted());
	const writingIsVisible = (ctx: ExtensionContext): boolean => ctx.hasUI && writingIsActive(ctx) && getConfig().writing?.showStatus === true;

	const updateStatus = () => {
		if (!uiCtx?.hasUI) return;
		if (!store.orchestratorMode) {
			uiCtx.ui.setStatus("slate", undefined);
			return;
		}
		// Orchestrator's own spend: summed over ALL entries (billed reality —
		// abandoned branches still cost money), plus spend carried across handoffs.
		const orchestratorCost = orchestratorCostUsd(uiCtx);
		const total = orchestratorCost + store.workerCostUsd + store.carriedCostUsd;
		// Keep the line short in the common no-handoff case.
		const carried = store.carriedCostUsd > 0 ? ` + carried $${store.carriedCostUsd.toFixed(4)}` : "";
		const costLine = `total $${total.toFixed(4)} (me $${orchestratorCost.toFixed(4)} + workers $${store.workerCostUsd.toFixed(4)}${carried})`;
		const statusWindowTurns = getConfig().writing?.statusWindowTurns ?? DEFAULT_STATUS_WINDOW_TURNS;
		const writingLine = writingIsVisible(uiCtx)
			? writingStatus === "ready"
				? `writing ${writingCounters.failCount} fail, ${writingCounters.styleCount} style / ${statusWindowTurns} turns`
				: writingStatus === "skipped"
					? "writing skipped (message too large)"
					: writingStatus === "unavailable"
						? "writing unavailable"
						: `writing 0 fail, 0 style / ${statusWindowTurns} turns`
			: "";
		let statusLine = `slate: orchestrator${store.paused ? " ⋅ ⛔ PAUSED — run /slate handoff" : ""} ⋅ ${costLine}${writingLine ? ` ⋅ ${writingLine}` : ""}`;
		if (uiCtx.mode === "tui") {
			try {
				const theme = uiCtx.ui.theme;
				if (theme) {
					const segments = [theme.bold(theme.fg("accent", "◆ slate orchestrator"))];
					if (store.paused) segments.push(`${theme.bold(theme.fg("error", "⛔ PAUSED"))} — ${theme.fg("warning", "run /slate handoff")}`);
					segments.push(theme.fg("muted", costLine));
					if (writingLine) segments.push(theme.fg("dim", writingLine));
					statusLine = segments.join(" ⋅ ");
				}
			} catch (error) {
				if (!statusStyleWarningShown) {
					statusStyleWarningShown = true;
					try { warnSummary(uiCtx, `slate: could not style the status line: ${String(error)}. Slate shows plain text.`); }
					catch { /* A failed warning cannot block the plain status line. */ }
				}
			}
		}
		uiCtx.ui.setStatus("slate", statusLine);
	};

	pi.registerTool({
		name: "slate_change",
		label: "Slate change",
		description: "Start or close the current workflow change. Slate generates the folder name. Close deletes nothing. Orchestrator mode only.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("close")]) }),
		async execute(_id, params, _signal, _update, ctx) {
			if (!store.orchestratorMode) throw new Error("slate: change action requires orchestrator mode");
			if (params.action === "close") {
				if (!store.currentChange) throw new Error("slate: no change is open");
				const old = store.currentChange;
				const source = store.sourceChange;
				const owner = store.changeOwnerSessionId;
				store.currentChange = undefined;
				store.sourceChange = undefined;
				store.changeOwnerSessionId = undefined;
				try { store.save(); } catch (error) {
					store.currentChange = old;
					store.sourceChange = source;
					store.changeOwnerSessionId = owner;
					throw error;
				}
				return { content: [{ type: "text" as const, text: `Closed ${old}. Files remain on disk.` }], details: { folder: old, action: "close" } };
			}
			if (store.currentChange) throw new Error("slate: close the current change before starting another");
			const folder = createChangeFolder();
			createChangeDirectory(ctx.cwd, folder);
			store.currentChange = folder;
			store.sourceChange = undefined;
			store.changeOwnerSessionId = ctx.sessionManager.getSessionId();
			try { store.save(); } catch (error) {
				store.currentChange = undefined;
				store.changeOwnerSessionId = undefined;
				throw error;
			}
			return { content: [{ type: "text" as const, text: `Started change. Research log: slate-changes/${folder}/research-log.md` }], details: { folder, action: "start" } };
		},
	});

	const enforceToolLimit = () => {
		const active = pi.getActiveTools();
		if (savedTools) {
			const seen = new Set(savedTools);
			for (const name of active) {
				if (name !== "slate_change" && !ORCHESTRATOR_TOOLS.includes(name) && !seen.has(name)) {
					savedTools.push(name);
					seen.add(name);
				}
			}
		}
		if (active.length !== ORCHESTRATOR_TOOLS.length || ORCHESTRATOR_TOOLS.some((name) => !active.includes(name))) {
			pi.setActiveTools(ORCHESTRATOR_TOOLS);
		}
	};

	const setMode = (on: boolean, persist: boolean) => {
		if (on && !store.orchestratorMode) {
			savedTools = pi.getActiveTools().filter((name) => name !== "slate_change");
			enforceToolLimit();
		} else if (!on && store.orchestratorMode) {
			const baseline = savedTools ?? pi.getAllTools().map((tool) => tool.name);
			const extras = pi.getActiveTools().filter((name) => !ORCHESTRATOR_TOOLS.includes(name));
			pi.setActiveTools([...new Set([...baseline, ...extras])].filter((name) => name !== "slate_change"));
			savedTools = undefined;
		}
		if (!on) store.paused = false; // a pause is meaningless outside orchestrator mode
		store.orchestratorMode = on;
		if (persist) store.save();
		updateStatus();
	};

	// Refresh the status line whenever slate state changes (dispatch start/end, new threads).
	store.onDidChange = updateStatus;

	const showSummary = (ctx: ExtensionContext) => {
		if (ctx.mode === "tui") {
			const theme = ctx.ui.theme;
			const lines = theme ? renderStartupSummary((kind, text) => {
				if (kind === "heading") return theme.bold(theme.fg("accent", text));
				if (kind === "action") return theme.bold(theme.fg("warning", text));
				return theme.fg(kind === "command" ? "mdCode" : "dim", text);
			}) : renderStartupSummary();
			ctx.ui.setWidget(SUMMARY_WIDGET_KEY, lines);
			summaryVisible = true;
		} else {
			const lines = renderStartupSummary();
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
			else console.log(lines.join("\n"));
		}
	};
	const displaySummary = (ctx: ExtensionContext) => {
		try { showSummary(ctx); }
		catch (error) { warnSummary(ctx, `slate: could not show the workflow summary: ${String(error)}`); }
	};
	const clearSummary = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		try { ctx.ui.setWidget(SUMMARY_WIDGET_KEY, undefined); summaryVisible = false; }
		catch (error) { warnSummary(ctx, `slate: could not clear the workflow summary: ${String(error)}`); }
	};
	const showAutomaticSummary = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const choice = readStartupSummary();
		if (choice.warning) warnSummary(ctx, choice.warning);
		if (store.orchestratorMode && choice.enabled) displaySummary(ctx);
	};

	// pi runs a REGISTERED extension command before it emits the input event: in
	// the pinned pi 0.83.0, AgentSession.prompt() calls
	// _tryExecuteExtensionCommand(text) first and returns when a command claims
	// the text, and it emits the input event only for text that no command
	// claimed. /slate resume and /slate handoff therefore never reach this
	// handler, so it needs no command exemption. Text that only LOOKS like a
	// command — a different letter case, or a sendUserMessage() call, which skips
	// command handling — is ordinary user input and is refused like any other.
	pi.on("input", async (event, ctx) => {
		if (store.orchestratorMode && store.paused) {
			reportPausedInput(ctx);
			return { action: "handled" };
		}
		// Registered slash commands return before pi emits input. Extension and
		// RPC messages are not prompts submitted in this terminal session.
		if (summaryVisible && ctx.mode === "tui" && event.source === "interactive") {
			try {
				ctx.ui.setWidget(SUMMARY_WIDGET_KEY, undefined);
				summaryVisible = false;
			} catch (error) {
				try { warnSummary(ctx, `slate: could not clear the workflow summary: ${String(error)}`); }
				catch { /* A warning failure must not block the prompt. */ }
			}
		}
		return { action: "continue" };
	});

	pi.registerCommand("slate", {
		description: "Slate orchestrator mode: on | off | summary [on | off] | handoff [focus] | resume | effective (no arg toggles)",
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const trimmed = args?.trim() ?? "";
			const [verb, ...rest] = trimmed.split(/\s+/);
			const arg = verb?.toLowerCase();
			if (arg === "summary") {
				const choice = rest[0]?.toLowerCase();
				if (rest.length === 0) { displaySummary(ctx); return; }
				if (rest.length !== 1 || (choice !== "on" && choice !== "off")) {
					warnSummary(ctx, "Usage: /slate summary [on | off].");
					return;
				}
				let result;
				try { result = saveSummary(choice === "on"); }
				catch (error) {
					warnSummary(ctx, `slate: could not save the startup summary in ${preferencePath()}: ${String(error)}`);
					return;
				}
				if (result.durabilityWarning) warnSummary(ctx, result.durabilityWarning);
				if (choice === "off" && ctx.mode === "tui") {
					try { ctx.ui.setWidget(SUMMARY_WIDGET_KEY, undefined); summaryVisible = false; }
					catch (error) { warnSummary(ctx, `slate: saved in ${result.path}, but could not update the summary: ${String(error)}`); return; }
				}
				if (result.durabilityWarning) return;
				const reply = `Startup summary is ${choice}. Saved in ${result.path}. Run /slate summary ${choice === "on" ? "off to hide" : "on to allow"} automatic display.`;
				try {
					if (ctx.hasUI) ctx.ui.notify(reply, "info");
					else console.log(reply);
				} catch (error) { warnSummary(ctx, `slate: saved in ${result.path}, but could not show the reply: ${String(error)}`); }
				return;
			}
			if (arg === "handoff") {
				if (!store.orchestratorMode) {
					if (ctx.hasUI) ctx.ui.notify("slate: orchestrator mode is not active — nothing to hand off.", "warning");
					return;
				}
				await hooks.startHandoff(ctx, rest.join(" ") || undefined);
				return;
			}
			if (arg === "effective") {
				const runtime = getRuntime();
				const text = runtime?.effectiveText(runtime.rememberedSelections()) ?? "Effective logical model policy\nStatus: blocked. No parent-session runtime is available.";
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else console.log(text);
				return;
			}
			if (arg === "resume") {
				store.paused = false;
				store.save();
				if (ctx.hasUI) ctx.ui.notify("slate: pause cleared — user prompts are accepted again.", "info");
				return;
			}
			const target = arg === "on" ? true : arg === "off" ? false : !store.orchestratorMode;
			setMode(target, true);
			if (ctx.hasUI) {
				ctx.ui.notify(
					target
						? "Slate orchestrator mode ON — tactical tools removed; delegate via the thread tool."
						: "Slate orchestrator mode OFF — full toolset restored.",
					"info",
				);
			}
			if (target) showAutomaticSummary(ctx);
			else clearSummary(ctx);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!store.orchestratorMode) return;
		enforceToolLimit();
		const config = getConfig();
		// Untrusted callers need the loader's home-only view, not a JSON flag.
		const trusted = permitsSlateConfig(config, ctx.isProjectTrusted());
		// Doc CONTENTS are re-read from disk on every agent start, so edits are
		// picked up live; the doc PATH LIST comes from config, which reloads
		// only on session_start (index.ts).
		const docs = trusted ? loadPromptDocs(ctx.cwd, config.orchestratorPromptDocs ?? []) : [];
		// Blocks carry no separators — prefix each here. When paused, the
		// addendum goes LAST so the pause directive is the final word in the
		// prompt, undiluted by the role guidelines.
		const parts = [
			buildDoctrine(ctx.cwd, config, trusted, getExtensions(), getRuntime(), store.currentChange, store.sourceChange, (() => {
				try { const entry = lstatSync(join(ctx.cwd, "research-log.md")); return entry.isFile() && !entry.isSymbolicLink(); }
				catch { return false; }
			})()),
			...loadDoctrineExtra(ctx.cwd, config, trusted).map((d) => `\n\n${d}`),
			...docs.map((d) => `\n\n${d}`),
		];
		if (store.paused) parts.push(PAUSED_ADDENDUM);
		return { systemPrompt: event.systemPrompt + parts.join("") };
	});

	pi.on("tool_call", (event) => {
		if (store.orchestratorMode && !ORCHESTRATOR_TOOLS.includes(event.toolName)) {
			return { block: true, reason: "slate: orchestrator mode does not allow this tool." };
		}
		return undefined;
	});

	// message_end is awaited before pi executes this response's tools. Measure here
	// so the completed-turn claim can only quote this response, never an older turn.
	// Each assistant response also opens one reminder slot.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!(event.message.stopReason === "aborted" && previousTurnHadTools)) {
			Object.assign(store.writingReminder, rearmWritingReminder(store.writingReminder));
		}
		previousTurnHadTools = false;
		latestTurnHasFinding = false;
		uiCtx = ctx;
		if (!writingIsActive(ctx)) return;
		const bytes = assistantTextBytes(event.message);
		if (bytes !== undefined && bytes > WRITING_TURN_MAX_BYTES) {
			writingCounters.latest = undefined;
			writingStatus = "skipped";
			updateStatus();
			return;
		}
		let checker: WritingChecker;
		try {
			writingCheckerPromise ??= loadWritingChecker();
			checker = await writingCheckerPromise;
		} catch {
			writingCheckerPromise = undefined;
			writingCounters.latest = undefined;
			writingStatus = "unavailable";
			updateStatus();
			return;
		}
		const writingConfig = getConfig().writing;
		resizeWritingWindow(writingCounters, writingConfig?.statusWindowTurns ?? DEFAULT_STATUS_WINDOW_TURNS);
		const outcome = measureWritingTurn(
			event.message,
			checker,
			writingCounters,
			writingConfig?.sentenceWordLimit ?? DEFAULT_SENTENCE_WORD_LIMIT,
		);
		// A turn with no prose leaves the prior status and counters unchanged.
		if (outcome === "measured") {
			writingStatus = "ready";
			latestTurnHasFinding =
				(writingCounters.latest?.failCount ?? 0) + (writingCounters.latest?.styleCount ?? 0) > 0;
		} else if (outcome === "failed") {
			writingStatus = "unavailable";
		}
		updateStatus();
	});

	// Gate and claim stay synchronous. The claim is the cadence delivery.
	const completeWritingTurn = (ctx: ExtensionContext, hasToolResult: boolean) => {
		const config = getConfig().writing;
		const runtime = store.writingReminder;
		const triggerEnabled = (config?.findings ?? true) && (config?.remindOnFinding ?? DEFAULT_REMIND_ON_FINDING);
		Object.assign(runtime, advanceWritingReminderTurn(runtime, triggerEnabled && latestTurnHasFinding));
		if (
			!writingReminderGateOpen(
				{
					orchestratorMode: store.orchestratorMode,
					trusted: permitsSlateConfig(getConfig(), ctx.isProjectTrusted()),
					paused: store.paused,
				},
				runtime.sentThisRound,
			)
		) return;
		const decision = decideWritingReminder(
			runtime.turnsSinceDelivery,
			config?.remindTurns ?? DEFAULT_REMIND_TURNS,
			runtime.findingPending,
			triggerEnabled,
			runtime.forceNext,
		);
		const reminderContent = renderWritingReminderMessage(writingCounters.latest, config?.findings ?? true);
		Object.assign(runtime, claimWritingReminder(runtime, decision, reminderContent));
		if (!decision.send) return;
		const deliveryId = runtime.pending?.deliveryId;
		if (deliveryId === undefined) return;
		try {
			pi.sendMessage(
				{
					customType: WRITING_REMINDER_CUSTOM_TYPE,
					content: reminderContent,
					display: false,
					details: writingReminderDeliveryDetails(deliveryId),
				},
				{ deliverAs: writingReminderDeliveryMode(hasToolResult) },
			);
		} catch {
			// The claim already completed cadence delivery. Release only the round slot.
			Object.assign(runtime, rearmWritingReminder(runtime));
		}
	};

	// A retryable provider error is not countable yet. A later successful turn
	// replaces it. agent_settled confirms an error was the final attempt.
	pi.on("turn_end", (event, ctx) => {
		const failedAttempt =
			event.message.role === "assistant" && event.message.stopReason === "error";
		if (failedAttempt) {
			pendingErrorTurn = true;
			return;
		}
		pendingErrorTurn = false;
		previousTurnHadTools = event.toolResults.length > 0;
		completeWritingTurn(ctx, previousTurnHadTools);
	});

	// message_start proves that pi began delivering our custom message.
	pi.on("message_start", (event) => {
		if (event.message.role === "custom" && event.message.customType === WRITING_REMINDER_CUSTOM_TYPE) {
			Object.assign(
				store.writingReminder,
				commitWritingReminder(store.writingReminder, event.message.details, event.message.content),
			);
		}
	});

	// Refresh cost after the final attempt. A final provider error counts once.
	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingErrorTurn) {
			completeWritingTurn(ctx, false);
			pendingErrorTurn = false;
		}
		uiCtx = ctx;
		updateStatus();
	});

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		resetWritingCounters(
			writingCounters,
			getConfig().writing?.statusWindowTurns ?? DEFAULT_STATUS_WINDOW_TURNS,
		);
		writingCheckerPromise = undefined;
		writingStatus = "fresh";
		statusStyleWarningShown = false;
		latestTurnHasFinding = false;
		pendingErrorTurn = false;
		previousTurnHadTools = false;
		Object.assign(store.writingReminder, resetWritingReminderSession(store.writingReminder));
		// Preserve force only when the earlier handoff handler marked this cycle.
		// The reset consumes that marker, so a later generic session_start clears
		// stale force. Registration order remains index restore, handoff, then mode.
		// Re-apply the persisted mode to the fresh runtime.
		//
		// Config-driven default: seed orchestrator mode ON for a genuinely FRESH
		// interactive session. Running AFTER restore and handoff adoption means
		// the seed can neither clobber persisted state nor trip the adoption
		// guard. "Fresh" = no message entries and no recorded slate state on the
		// branch: metadata-only entries (e.g., session naming) don't suppress the
		// seed, while resumed/forked real sessions and explicit /slate off
		// decisions stay untouched. Deliberately NOT saved — persisting would
		// lock the default into old sessions even after the config flag is later
		// turned off; the first real mutation persists it. The mode === "tui"
		// gate limits the seed to interactive terminal sessions — hasUI would not
		// do: it is also true in RPC mode, and scripted/automated runs
		// (print/JSON/RPC) must not silently lose tactical tools.
		let seededMode = false;
		if (!store.orchestratorMode && ctx.mode === "tui" && getConfig().orchestratorModeDefault === true) {
			const fresh = !ctx.sessionManager.getBranch().some((entry) => {
				// Loose cast like state.ts restore(): tolerate malformed/legacy entries.
				const e = entry as { type: string; customType?: string };
				return e.type === "message" || (e.type === "custom" && e.customType === "slate-state");
			});
			if (fresh) {
				store.orchestratorMode = true;
				seededMode = true;
			}
		}
		if (!store.orchestratorMode) {
			const active = pi.getActiveTools();
			if (active.includes("slate_change")) pi.setActiveTools(active.filter((name) => name !== "slate_change"));
		} else {
			if (!savedTools) {
				const active = pi.getActiveTools();
				// A restricted restored set can include new tools. It is not a pre-mode baseline.
				if (seededMode || ORCHESTRATOR_TOOLS.some((name) => !active.includes(name))) {
					savedTools = active.filter((name) => name !== "slate_change");
				}
			}
			enforceToolLimit();
		}
		updateStatus();
		// Restore, handoff adoption, and mode seeding run before the display choice.
		summaryVisible = false;
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.setWidget(SUMMARY_WIDGET_KEY, undefined);
			showAutomaticSummary(ctx);
		} catch (error) { warnSummary(ctx, `slate: could not show the workflow summary: ${String(error)}`); }
	});
}
