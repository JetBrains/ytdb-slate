import { SlateWriteRefused, type CorpusProject } from "./corpus.ts";
import {
	DURABLE_SESSION_POLICY,
	readDurableSession,
	updateDurableSession,
	type CanonicalSlateRuntime,
	type DurableSessionHooks,
	type DurableSessionRecord,
} from "./session-record.ts";
import { isOwnerSessionDigest, isSlateSessionId } from "./session-identity.ts";
import { isSlateSessionName } from "./session-names.ts";
import type { RuntimeAuthorityBinding } from "./state.ts";

/** Plain information that identifies the stable namespace receiving a handoff. */
export interface DurableHandoffReference {
	readonly policy: typeof DURABLE_SESSION_POLICY;
	readonly identity: string;
	readonly name: string;
}

/** A completed save and structural read-back. This result grants no write access. */
export interface DurableHandoffCompletion {
	readonly kind: "complete";
	readonly record: DurableSessionRecord;
	readonly binding: RuntimeAuthorityBinding;
}

export interface DurableHandoffOptions {
	project: CorpusProject;
	cwd: string;
	reference: unknown;
	recipientSessionDigest: string;
	recipientState: CanonicalSlateRuntime;
	hooks?: DurableSessionHooks;
}

export class DurableHandoffRefused extends SlateWriteRefused {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DurableHandoffRefused";
	}
}

const REFERENCE_KEYS = ["policy", "identity", "name"] as const;

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function clonePlainData(value: unknown): unknown {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Parse detached reference data without granting authority from that data. */
export function parseDurableHandoffReference(value: unknown): DurableHandoffReference | undefined {
	const copy = clonePlainData(value);
	if (!object(copy) || !exactKeys(copy, REFERENCE_KEYS)) return undefined;
	if (copy.policy !== DURABLE_SESSION_POLICY || !isSlateSessionId(copy.identity)
		|| !isSlateSessionName(copy.name)) return undefined;
	return { policy: DURABLE_SESSION_POLICY, identity: copy.identity, name: copy.name };
}

/** Build a reference from structurally validated saved state. */
export function durableHandoffReference(record: DurableSessionRecord): DurableHandoffReference {
	return {
		policy: record.metadata.policy,
		identity: record.metadata.identity,
		name: record.metadata.name,
	};
}

function saveAndReadBack(options: DurableHandoffOptions): DurableHandoffCompletion {
	const reference = parseDurableHandoffReference(options.reference);
	if (reference === undefined) {
		throw new DurableHandoffRefused("slate refused a malformed or unsupported durable handoff reference");
	}
	if (!isOwnerSessionDigest(options.recipientSessionDigest)) {
		throw new DurableHandoffRefused("slate refused invalid recipient session provenance");
	}

	/*
	 * This read validates the selected durable-session identity and storage boundary.
	 * The writer provenance, generation, and lifecycle status do not authorize access.
	 */
	readDurableSession({
		project: options.project,
		name: reference.name,
		identity: reference.identity,
		cwd: options.cwd,
	});

	updateDurableSession({
		project: options.project,
		name: reference.name,
		identity: reference.identity,
		cwd: options.cwd,
		writerSessionDigest: options.recipientSessionDigest,
		runtime: options.recipientState,
		...(options.hooks === undefined ? {} : { hooks: options.hooks }),
	});

	/* Completion is only this structural read-back after the save. */
	const record = readDurableSession({
		project: options.project,
		name: reference.name,
		identity: reference.identity,
		cwd: options.cwd,
	});
	return {
		kind: "complete",
		record,
		binding: {
			policy: DURABLE_SESSION_POLICY,
			identity: reference.identity,
			name: reference.name,
		},
	};
}

/** Save recipient state, read it back, and structurally validate the saved state. */
export function completeDurableHandoff(options: DurableHandoffOptions): DurableHandoffCompletion {
	return saveAndReadBack(options);
}

/** Retry later after the caller has stopped every process using this durable session. */
export function recoverDurableHandoff(options: DurableHandoffOptions): DurableHandoffCompletion {
	return saveAndReadBack(options);
}
