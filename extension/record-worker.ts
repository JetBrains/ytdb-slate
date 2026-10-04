/** One internal record component per worker session. Authority lasts one action. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recordNameRule } from "./record-names.ts";
import { RECORD_GUARD_REASON, recordGuardBlocks } from "./record-guard.ts";
import type { RecordLease } from "./record-ownership.ts";
import { prepareRecordWrite, RecordPrepublicationError, type RecordWriteArguments, type RecordWriteOutcome, type RecordWriteOptions } from "./record-write.ts";

export const RECORD_TOOL_NAME = "slate_record";
export const RECORD_FACTORY_NAME = "slate-worker-record";
export const RECORD_TOOL_DESCRIPTION = "Write one assigned change record. Use create for initial bytes, append for added log or report bytes, and replace for complete status or design bytes. Every append or replace needs the current sha256 hash. Payload text is unchanged. The limit is 1,048,576 UTF-8 bytes. Inspect the current record after an aborted, failed, uncertain, or unknown call before retrying. A write grants no workflow approval.";
export const RECORD_TOOL_PARAMETERS = Type.Object({
	record: Type.String({ description: "One exact assigned record name, not a path." }),
	mode: Type.Union([Type.Literal("create"), Type.Literal("append"), Type.Literal("replace")]),
	payload: Type.String({ description: "Complete create or replace text, or only the added append text." }),
	expectedHash: Type.Optional(Type.String({ description: "Current sha256:<64 lowercase hexadecimal digits>. Omit for create." })),
});
export interface RecordCallFact {
	record: string;
	mode: "create" | "append" | "replace" | "invalid";
	state: RecordWriteOutcome["state"];
	reason: string;
	observedBeforeHash?: string;
	observedAfterHash?: string;
}
export function renderRecordFacts(facts: readonly RecordCallFact[]): string {
	return facts.length === 0 ? "" : "## Record call outcomes\n" + facts.map((fact) => JSON.stringify(fact)).join("\n") + "\n";
}
export function recordWorkerGuidance(lease: RecordLease | undefined): string {
	return lease === undefined ? "" : "Use slate_record only for these assigned records: " + lease.assignment.names.map((name) => `${name} (${recordNameRule(name)!.modes.join(", ")})`).join(". ") + ". Read the current record and obtain its sha256 hash before each update. Do not repeat an uncertain write without inspection.";
}
export function createRecordWorkerRuntime(projectRoot: string, lease?: RecordLease, options: RecordWriteOptions = {}, prepare = prepareRecordWrite) {
	let installed = false;
	const facts: RecordCallFact[] = [];
	let tail = Promise.resolve();
	let open = true;
	const execute = async (args: RecordWriteArguments, signal?: AbortSignal) => {
		const validMode = args.mode === "create" || args.mode === "append" || args.mode === "replace";
		let outcome: RecordWriteOutcome | undefined;
		let reason: string;
		let state: RecordWriteOutcome["state"];
		let admitted = false;
		try {
			if (!open || !lease) throw new Error("Record authority is not live. Request a new assigned action.");
			outcome = await lease.call(async () => {
				admitted = true;
				const prepared = await prepare({ projectRoot, assignment: lease.assignment, sourceFolder: lease.sourceFolder }, args, { ...options, signal });
				return prepared.publish();
			});
			reason = outcome.reason;
			state = outcome.state;
		} catch (error) {
			if (error instanceof RecordPrepublicationError) {
				outcome = error.outcome;
				// NL-4: reused preparation and invalid modes grant no current-write evidence.
				if (!validMode || error.stage === "admission") outcome = undefined;
				state = error.state;
				reason = error.message;
			} else {
				state = admitted ? "unknown outcome" : "refused before publication";
				reason = admitted ? "The record call lost its outcome. Inspect the current record before retrying." :
					error instanceof Error ? error.message : "Record admission failed. Inspect the record before retrying.";
			}
		}
		const fact: RecordCallFact = {
			record: typeof args.record === "string" && lease?.assignment.names.includes(args.record) ? args.record : "unassigned",
			mode: validMode ? args.mode as RecordCallFact["mode"] : "invalid", state, reason,
			...(outcome?.observedBeforeHash ? { observedBeforeHash: outcome.observedBeforeHash } : {}),
			...(outcome?.observedAfterHash ? { observedAfterHash: outcome.observedAfterHash } : {}),
		};
		facts.push(fact);
		return { content: [{ type: "text" as const, text: JSON.stringify(outcome ?? fact) }], details: outcome ?? fact, isError: state !== "published and synced" };
	};
	return {
		extension(pi: ExtensionAPI) {
			pi.on("tool_call", async (event, ctx) => {
				if ((event.toolName === "write" || event.toolName === "edit") && await recordGuardBlocks(event.input.path, ctx.cwd, projectRoot)) return { block: true, reason: RECORD_GUARD_REASON };
				return undefined;
			});
			if (lease) pi.registerTool({ name: RECORD_TOOL_NAME, label: "Slate record", description: RECORD_TOOL_DESCRIPTION, parameters: RECORD_TOOL_PARAMETERS,
				async execute(_id, args, signal) {
					const pending = tail.then(() => execute(args, signal));
					tail = pending.then(() => undefined, () => undefined);
					return pending;
				},
			});
			installed = true;
		},
		installed: () => installed,
		facts: () => structuredClone(facts),
		close() { open = false; lease?.close(); },
		settle: () => tail,
	};
}
