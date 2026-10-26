/**
 * Compact displays for orchestration tools. Expanded views show protected plain
 * text and full arguments. Display protection does not alter tool evidence.
 */

import { Text } from "@earendil-works/pi-tui";

type ThemeLike = {
	fg: (color: "error" | "toolTitle" | "warning" | "success", text: string) => string;
	bold: (text: string) => string;
};
type DisplayContext = { expanded?: boolean; isPartial?: boolean; isError?: boolean };
type DisplayOptions = { expanded: boolean; isPartial?: boolean; threadDevMode?: boolean };

// These helpers and presentation fields are internal display metadata, not a supported consumer contract.
export interface DisplayDetails {
	[key: string]: unknown;
	done?: boolean;
	status?: "ok" | "failed";
	lines?: string[];
	warnings?: readonly string[];
	displayActivity?: string;
	displayFailure?: string;
	displayFailureReason?: string;
	displayWarning?: boolean;
	displayWarningSummary?: string;
	displayOtherWarning?: boolean;
	displayOtherWarningSummary?: string;
	count?: number;
	failedCount?: number;
}

function validDetails(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value !== "object" || Array.isArray(value)) return false;
	const d = object(value);
	return ["done", "displayWarning", "displayOtherWarning"].every((key) => d[key] === undefined || typeof d[key] === "boolean")
		&& ["threadName", "displayActivity", "displayFailure", "displayFailureReason", "displayWarningSummary", "displayOtherWarningSummary"].every((key) => d[key] === undefined || typeof d[key] === "string")
		&& (d.status === undefined || d.status === "ok" || d.status === "failed")
		&& (d.lines === undefined || Array.isArray(d.lines))
		&& (d.warnings === undefined || (Array.isArray(d.warnings) && d.warnings.every((item) => typeof item === "string")))
		&& ["count", "failedCount"].every((key) => d[key] === undefined || (typeof d[key] === "number" && Number.isSafeInteger(d[key]) && d[key] >= 0));
}

/** Remove control characters individually so removal cannot assemble an escape. */
export function protectDisplay(value: string, oneLine = false): string {
	const input = oneLine ? value.replace(/[\r\n\t\u2028\u2029]/g, " ") : value;
	const clean = input.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufff9-\ufffb]/g, "");
	return oneLine ? clean.replace(/[\n\t\u2028\u2029]/g, " ") : clean;
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}
function short(value: unknown, limit = 160): string {
	return typeof value === "string" ? protectDisplay(value, true).slice(0, limit) : "";
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [];
}
function contentText(value: unknown): string {
	const content = object(value).content;
	return Array.isArray(content) ? content.map((part) => {
		const item = object(part);
		return item.type === "text" && typeof item.text === "string" ? item.text : "";
	}).join("\n") : "";
}
function inspection(value: unknown): string {
	return protectDisplay(JSON.stringify(value, null, 2) ?? "(none)");
}
function failedDisplay(tool: string, theme: ThemeLike): Text {
	return new Text(theme.fg("error", `✗ ${tool}: invalid display data`), 0, 0);
}

export function renderCompactCall(tool: string, args: unknown, theme: ThemeLike, context?: DisplayContext) {
	try {
		const data = object(args);
		if (args === null || typeof args !== "object" || Array.isArray(args) ||
			["name", "task", "action"].some((key) => data[key] !== undefined && typeof data[key] !== "string") ||
			(data.context !== undefined && (!Array.isArray(data.context) || data.context.some((item) => typeof item !== "string")))) {
			return failedDisplay(tool, theme);
		}
		const label = tool === "thread" ? short(data.name, 60) : tool === "slate_change" ? short(data.action, 20) : "";
		let text = theme.fg("toolTitle", theme.bold(tool)) + (label ? ` ${label}` : "");
		if (context?.expanded) text += `\n${inspection(args)}`;
		return new Text(text, 0, 0);
	} catch {
		return failedDisplay(tool, theme);
	}
}

export function renderCompactResult(
	tool: string, result: unknown, options: DisplayOptions, theme: ThemeLike, context?: DisplayContext,
) {
	try {
		const data = object(result);
		if (!validDetails(data.details)) return failedDisplay(tool, theme);
		const details = object(data.details);
		const failed = context?.isError === true || data.isError === true || (tool !== "episode" && details.status === "failed");
		const partial = !failed && details.done !== true && (context?.isPartial ?? options.isPartial) === true;
		const expanded = context?.expanded ?? options.expanded;
		const name = tool === "thread" ? short(details.threadName, 60) || tool : tool;
		const status = failed ? "failed" : partial ? "running" : "done";
		let text = theme.fg(failed ? "error" : partial ? "warning" : "success", `${failed ? "✗" : partial ? "⏳" : "✓"} ${name} ${status}`);
		if (tool === "episode" && !failed && !partial) text = theme.fg("success", "✓ Episode loaded");
		if (expanded) {
			// Text does not interpret Markdown or create terminal hyperlinks.
			const lines = details.lines;
			const streaming = (context?.isPartial ?? options.isPartial) === true && details.done !== true;
			const tail = streaming && Array.isArray(lines) ? lines.slice(-50) : undefined;
			if (tail?.some((line) => typeof line !== "string")) return failedDisplay(tool, theme);
			const inspected = tail
				? { ...details, lines: tail, earlierLines: Math.max(0, (lines as unknown[]).length - 50) } : data.details;
			text += `\n${protectDisplay(contentText(result))}\nDetails:\n${inspection(inspected)}`;
		} else {
			if (partial && typeof details.displayActivity === "string") text += `\n  ${short(details.displayActivity)}`;
			const hideToolFailures = tool === "thread" && options.threadDevMode !== true;
			const failure = hideToolFailures ? "" : short(details.displayFailure);
			if (failure) text += `\n  ${failure}`;
			const reason = short(details.displayFailureReason);
			if (failed && reason) text += `\n  ${reason}`;
			if (failed && !failure && !reason) {
				const summary = details.status === "failed" ? "" : short(contentText(result));
				text += `\n  ${summary || "Action failed. Expand for details."}`;
			}
			if (tool === "episode" && !failed && details.status === "failed") text += "\n  Stored action failed. Expand for details.";
			if (tool === "threads" && typeof details.count === "number") {
				text += `\n  ${details.count} ${details.count === 1 ? "thread" : "threads"}`;
				if (typeof details.failedCount === "number" && details.failedCount > 0) text += `, ${details.failedCount} failed`;
			}
			const separateWarnings = hideToolFailures && typeof details.displayOtherWarning === "boolean";
			const warning = separateWarnings ? details.displayOtherWarning
				: details.displayWarning === true || strings(details.warnings).length > 0;
			const warningSummary = separateWarnings ? details.displayOtherWarningSummary : details.displayWarningSummary;
			if (warning) {
				text += `\n  ⚠ ${short(warningSummary) || "Action warning. Expand for details."}`;
			}
		}
		return new Text(text, 0, 0);
	} catch {
		return failedDisplay(tool, theme);
	}
}

export function renderThreadCall(args: unknown, theme: ThemeLike, context?: DisplayContext) {
	return renderCompactCall("thread", args, theme, context);
}
export function renderThreadResult(result: unknown, options: DisplayOptions, theme: ThemeLike, context?: DisplayContext) {
	return renderCompactResult("thread", result, options, theme, context);
}

/** Constant-size display state, independent of the retained evidence list. */
export class ActionDisplayProgress {
	activity = "";
	failure = "";
	warning = false;
	failureReason = "";
	warningSummary = "";
	private warningPriority = 0;
	private otherWarning = false;
	private otherWarningSummary = "";
	private otherWarningPriority = 0;
	toolStarted(name: unknown): void { this.activity = `Tool: ${short(name, 80)}`; }
	toolFailed(name: unknown): void { this.failure = `Tool failed: ${short(name, 80)}`; }
	response(): void { this.activity = "Worker response received"; }
	failed(reason?: string, episodeText?: string): void {
		this.failureReason = short(reason).trim();
		if (this.failureReason || this.failure) return;
		const issues = episodeText?.match(/^## Open Issues[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
		const first = issues?.split("\n").map((line) => protectDisplay(line, true).trim())
			.find((line) => line && !/^(?:none\.?|n\/a|-)$/i.test(line));
		this.failureReason = short(first);
	}
	warn(summary = "", priority = 1, failedTool = false): void {
		if (!failedTool) {
			this.otherWarning = true;
			if (summary && priority >= this.otherWarningPriority) {
				this.otherWarningSummary = short(summary);
				this.otherWarningPriority = priority;
			}
		}
		this.warning = true;
		if (summary && priority >= this.warningPriority) {
			this.warningSummary = short(summary);
			this.warningPriority = priority;
		}
	}
	details(): DisplayDetails {
		return { displayActivity: this.activity, displayFailure: this.failure,
			displayFailureReason: this.failureReason, displayWarning: this.warning,
			displayWarningSummary: this.warningSummary,
			displayOtherWarning: this.otherWarning, displayOtherWarningSummary: this.otherWarningSummary };
	}
}
