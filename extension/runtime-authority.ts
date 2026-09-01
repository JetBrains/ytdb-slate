import { readFileSync, realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSlateSessionId } from "./session-identity.ts";
import { isSlateSessionName, sessionNameFromBytes } from "./session-names.ts";
import {
	createDurableSession,
	DURABLE_SESSION_POLICY,
	DurableCommitUncertain,
	readDurableSession,
	updateDurableSession,
	type DurableSessionHooks,
} from "./session-record.ts";
import {
	mintSlateSession,
	type RuntimeAuthorityBackend,
	type RuntimeAuthorityBinding,
	type RuntimeAuthorityContext,
	type RuntimeAuthorityExternalRecord,
	type RuntimeAuthoritySelection,
	type SlateStore,
} from "./state.ts";

export const SLATE_BINDING_CUSTOM_TYPE = "slate-binding" as const;

/** A Pi-held locator. It identifies one durable namespace and grants no write access. */
export interface SlateBindingRecord {
	readonly policy: typeof DURABLE_SESSION_POLICY;
	readonly identity: string;
	readonly name: string;
}

export type RuntimeAuthorityRefusal =
	| "malformed-binding"
	| "conflicting-bindings"
	| "off-branch-binding";

const BINDING_KEYS = ["policy", "identity", "name"] as const;
const INVALID_DATA = Symbol("invalid-data");

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

/** Detach persisted plain data before authority classification. */
function clonePlainData(value: unknown): unknown | typeof INVALID_DATA {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? INVALID_DATA : JSON.parse(text);
	} catch {
		return INVALID_DATA;
	}
}

/** Parse one exact binding payload from detached persisted data. */
export function parseSlateBindingRecord(value: unknown): SlateBindingRecord | undefined {
	const snapshot = clonePlainData(value);
	if (snapshot === INVALID_DATA || !object(snapshot) || !exactKeys(snapshot, BINDING_KEYS)) return undefined;
	const { policy, identity, name } = snapshot;
	if (policy !== DURABLE_SESSION_POLICY || !isSlateSessionId(identity) || !isSlateSessionName(name)) {
		return undefined;
	}
	return { policy, identity, name };
}

interface CollectedEvidence {
	values: unknown[];
	malformed: boolean;
}

function collect(entries: readonly unknown[], customType: string): CollectedEvidence {
	const values: unknown[] = [];
	if (!Array.isArray(entries)) return { values, malformed: true };
	for (const entry of entries) {
		if (!object(entry) || entry.customType !== customType) continue;
		if (entry.type !== "custom" || !Object.hasOwn(entry, "data")) return { values, malformed: true };
		values.push(entry.data);
	}
	return { values, malformed: false };
}

function sameRelationship(left: SlateBindingRecord, right: SlateBindingRecord): boolean {
	return left.policy === right.policy && left.identity === right.identity && left.name === right.name;
}

/**
 * The entries Pi has already WRITTEN to its conversation file.
 *
 * Pi adds an entry to its own memory before it writes that entry, and it keeps
 * the memory entry when the write throws. A locator note left by a failed append
 * is therefore visible in memory and absent from the file, and only the file
 * proves durability (CN1504). An unreadable or unparsable file proves nothing,
 * which reads here as undefined and makes the caller write the note again.
 */
export function readPersistedSessionEntries(file: string | undefined): readonly unknown[] | undefined {
	if (file === undefined || file === "") return undefined;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const entries: unknown[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			entries.push(JSON.parse(trimmed) as unknown);
		} catch {
			return undefined;
		}
	}
	return entries;
}

/** Build the canonical action context after lifecycle code selects one Pi branch. */
export function createRuntimeAuthorityContext(options: {
	key: string;
	cwd: string;
	sessionDigest: string;
	project: RuntimeAuthorityContext["project"];
	report?: (message: string) => void;
}): RuntimeAuthorityContext {
	return {
		...options,
		cwd: realpathSync(options.cwd),
		project: {
			...options.project,
			matchingDirectories: [...options.project.matchingDirectories],
		},
	};
}

/**
 * Production durable I/O adapter. Merely creating it performs no storage operation.
 *
 * `branch` reads the entries of the CURRENT conversation branch. It decides
 * whether a completed save still needs a locator note: exactly one note per
 * branch names the external namespace, so every later save of the same session
 * adds nothing (Track 14 goals 3 and 11). A caller that supplies no `branch`
 * gets the unconditional append, which is why production always supplies one.
 *
 * `persisted` reads the entries of the conversation FILE. It answers one question
 * only, and only after an append of this backend threw: is the note that memory
 * shows also on disk? Pi keeps a memory entry whose write failed, so memory alone
 * would report a completed save over a conversation file without a note (CN1504).
 */
export function createRuntimeAuthorityBackend(
	pi: ExtensionAPI,
	hooks: {
		durable?: DurableSessionHooks;
		mint?: () => { identity: string; name: string };
		branch?: () => readonly unknown[];
		persisted?: () => readonly unknown[] | undefined;
	} = {},
): RuntimeAuthorityBackend {
	const mint = hooks.mint ?? (() => {
		const value = mintSlateSession();
		return { identity: value.identity, name: sessionNameFromBytes(value.nameBytes) };
	});
	/** The locator note of one failed append, and nothing else. */
	let unwritten: SlateBindingRecord | undefined;
	/** Whether the conversation FILE already carries this exact locator note. */
	const notePersisted = (binding: RuntimeAuthorityBinding): boolean => {
		const entries = hooks.persisted?.();
		if (entries === undefined) return false;
		const present = collect(entries, SLATE_BINDING_CUSTOM_TYPE);
		if (present.malformed) return false;
		return present.values.some((value) => {
			const note = parseSlateBindingRecord(value);
			return note !== undefined && sameRelationship(note, binding);
		});
	};
	return {
		mint,
		create(options): RuntimeAuthorityExternalRecord {
			return createDurableSession({
				cwd: options.context.cwd,
				project: options.context.project,
				identity: options.identity,
				name: options.name,
				creatorSessionDigest: options.context.sessionDigest,
				runtime: options.runtime,
				...(hooks.durable !== undefined ? { hooks: hooks.durable } : {}),
			});
		},
		read(options): RuntimeAuthorityExternalRecord {
			return readDurableSession({
				project: options.context.project,
				name: options.binding.name,
				identity: options.binding.identity,
				cwd: options.context.cwd,
			});
		},
		update(options): RuntimeAuthorityExternalRecord {
			return updateDurableSession({
				project: options.context.project,
				name: options.binding.name,
				identity: options.binding.identity,
				cwd: options.context.cwd,
				writerSessionDigest: options.context.sessionDigest,
				runtime: options.runtime,
				...(hooks.durable !== undefined ? { hooks: hooks.durable } : {}),
			});
		},
		writeBinding(binding: RuntimeAuthorityBinding): void {
			const branch = hooks.branch?.();
			let memoryHasNote = false;
			if (branch !== undefined) {
				const present = collect(branch, SLATE_BINDING_CUSTOM_TYPE);
				if (present.malformed) throw new Error("slate refused to write a locator note beside malformed Pi binding evidence");
				const notes = present.values.map(parseSlateBindingRecord);
				if (notes.some((note) => note === undefined)) {
					throw new Error("slate refused to write a locator note beside a malformed locator note");
				}
				const other = notes.find((note) => note !== undefined && !sameRelationship(note, binding));
				if (other !== undefined) {
					throw new Error(`slate refused a second locator note: this conversation branch already names session ${other.name}`);
				}
				memoryHasNote = notes.length > 0;
			}
			// A previous append of THIS note threw, so the note memory shows may be the
			// entry Pi kept after its own write failed. Memory is then no proof, and the
			// conversation file decides.
			const suspect = unwritten !== undefined && sameRelationship(unwritten, binding);
			if (memoryHasNote && !suspect) return;
			if (suspect && notePersisted(binding)) {
				unwritten = undefined;
				return;
			}
			try {
				pi.appendEntry(SLATE_BINDING_CUSTOM_TYPE, binding as unknown as Record<string, unknown>);
			} catch (error) {
				unwritten = { policy: binding.policy, identity: binding.identity, name: binding.name };
				throw error;
			}
			unwritten = undefined;
		},
		isCommitUncertain(error: unknown): boolean {
			return error instanceof DurableCommitUncertain;
		},
	};
}

/** One locator-note verdict, plus whether any note exists at all. */
type BindingClassification =
	| { readonly kind: "fresh"; readonly present: false }
	| { readonly kind: "durable"; readonly present: true; readonly binding: SlateBindingRecord }
	| {
		readonly kind: "refused";
		readonly present: true;
		readonly reason: RuntimeAuthorityRefusal;
		readonly message: string;
	};

/**
 * Read the locator notes of one Pi session and its active branch.
 *
 * This is the whole storage question under Track 14: one valid note on the
 * active branch selects that external namespace, no note at all prepares a new
 * one, and anything else refuses. It reads no file and changes nothing.
 */
function classifyBindingAuthority(
	sessionEntries: readonly unknown[],
	activeBranch: readonly unknown[],
): BindingClassification {
	const refusedBinding = (reason: RuntimeAuthorityRefusal, message: string): BindingClassification =>
		({ kind: "refused", present: true, reason, message });
	const sessionBinding = collect(sessionEntries, SLATE_BINDING_CUSTOM_TYPE);
	const branchBinding = collect(activeBranch, SLATE_BINDING_CUSTOM_TYPE);
	if (sessionBinding.malformed || branchBinding.malformed) {
		return refusedBinding("malformed-binding", "slate refused malformed Pi binding evidence");
	}
	const bindings: SlateBindingRecord[] = [];
	const branchBindings: SlateBindingRecord[] = [];
	for (const [source, values] of [["session", sessionBinding.values], ["branch", branchBinding.values]] as const) {
		for (const value of values) {
			const binding = parseSlateBindingRecord(value);
			if (binding === undefined) return refusedBinding("malformed-binding", "slate refused malformed Pi binding evidence");
			bindings.push(binding);
			if (source === "branch") branchBindings.push(binding);
		}
	}
	const relationship = bindings[0];
	if (relationship !== undefined && bindings.some((binding) => !sameRelationship(binding, relationship))) {
		return refusedBinding("conflicting-bindings", "slate refused conflicting Pi binding relationships");
	}
	if (bindings.length === 0) return { kind: "fresh", present: false };
	// The latest note on the ACTIVE branch selects the namespace. Every note above
	// parsed, so an empty branch list is the off-branch case and nothing else.
	const selected = branchBindings.at(-1);
	if (selected === undefined) {
		return refusedBinding("off-branch-binding", "slate refused a Pi binding that exists only outside the active branch");
	}
	return { kind: "durable", present: true, binding: selected };
}

/**
 * The startup storage report: locator notes decide, and nothing else.
 *
 * It never searches for a full record copy in the Pi conversation, so a resumed
 * conversation that holds only such copies reports a fresh selection and starts a
 * new Slate session (Track 14 goals 2 and 9).
 */
export function selectStartupAuthority(
	sessionEntries: readonly unknown[],
	activeBranch: readonly unknown[],
): RuntimeAuthoritySelection {
	const classified = classifyBindingAuthority(sessionEntries, activeBranch);
	if (classified.kind === "durable") return { kind: "durable", binding: classified.binding };
	if (classified.kind === "refused") return { kind: "refused", reason: classified.reason, message: classified.message };
	return { kind: "fresh" };
}

/** Everything the startup report needs from one Pi session. */
export interface SlateStartupSession {
	/** Stable identity of the Pi session whose evidence this report reads. */
	readonly key: string;
	readonly cwd: string;
	readonly sessionDigest: string;
	readonly project: RuntimeAuthorityContext["project"];
	/** Every entry of the Pi session file. */
	readonly entries: readonly unknown[];
	/** The entries of the active conversation branch. */
	readonly branch: readonly unknown[];
}

/** The message a session carries while its storage report has not finished. */
export const STARTUP_PENDING_REFUSAL =
	"slate has not finished selecting storage for this Pi session, so it refuses every state change.";

function refusalDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * ASK THE RUNTIME AUTHORITY CHECK FOR ONE REPORT, THEN MAKE THE STORE FOLLOW IT.
 *
 * The store enters the refusing state first, so no save can succeed before the
 * report installs storage. One valid locator note on the active branch restores
 * every record from the named external namespace. No locator note prepares a new
 * external namespace and creates no directory. Anything else leaves the store
 * refusing, and every later save then reports that refusal (Track 14 goals 1 to
 * 5).
 *
 * It reports to the user itself only for a report it could not finish. A refusing
 * selection carries its own message, which the store reports through the context.
 */
export function activateSlateStorage(options: {
	store: SlateStore;
	session: SlateStartupSession;
	backend: RuntimeAuthorityBackend;
	report: (message: string) => void;
}): void {
	const { store, session, backend, report } = options;
	store.refuseRuntimeAuthority(STARTUP_PENDING_REFUSAL);
	const refuse = (detail: string): void => {
		const message = `slate could not select storage for this Pi session: ${detail}. `
			+ "Slate refuses every state change until you start another Pi session.";
		store.refuseRuntimeAuthority(message);
		report(message);
	};
	let context: RuntimeAuthorityContext;
	let selection: RuntimeAuthoritySelection;
	try {
		context = createRuntimeAuthorityContext({
			key: session.key,
			cwd: session.cwd,
			sessionDigest: session.sessionDigest,
			project: session.project,
			report,
		});
		selection = selectStartupAuthority(session.entries, session.branch);
	} catch (error) {
		refuse(refusalDetail(error));
		return;
	}
	try {
		store.configureRuntimeAuthority(selection, context, backend);
	} catch (error) {
		refuse(refusalDetail(error));
	}
}
