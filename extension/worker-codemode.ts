import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { SLATE_TOOL_NAMES } from "./worker-extensions.ts";

export const WORKER_CODEMODE_COMPONENT_NAME = "slate-worker-codemode";
const OWNED_SOURCE = `<inline:${WORKER_CODEMODE_COMPONENT_NAME}>`;

/** Internal worker component. It uses Pi's executor and public tool hooks. */
export function createWorkerCodemodeComponent(warn: (message: string) => void): ExtensionFactory {
	return (pi) => {
		createCodemodeExtension({ mode: "on", models: false })(pi);
		pi.on("tool_call", (event) => {
			const nested = event.parentToolCallId !== undefined || event.toolCallId.startsWith("/");
			if (event.toolName === "codemode") {
				if (nested) return { block: true, reason: "Slate blocks nested codemode calls. Call tools from the current script." };
				const source = pi.getAllTools().find((tool) => tool.name === "codemode")?.sourceInfo.path;
				if (source !== OWNED_SOURCE) {
					const reason = "Slate blocked codemode because its registered tool is not owned by the worker component.";
					warn(`slate: ${reason}`);
					return { block: true, reason };
				}
			}
			if (!nested) return;
			if (SLATE_TOOL_NAMES.includes(event.toolName)) {
				return { block: true, reason: `Slate scripts cannot call the Slate tool "${event.toolName}".` };
			}
			if (!pi.getActiveTools().includes(event.toolName)) {
				return { block: true, reason: `Slate scripts cannot call inactive tool "${event.toolName}".` };
			}
			return undefined;
		});
	};
}
