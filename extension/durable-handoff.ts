/**
 * Namespace validation for a handoff between two Pi sessions.
 *
 * A handoff continues ONE Slate session in another Pi session, so the receiving
 * session keeps the records that its own validating read returns. This module
 * therefore takes a reference and answers with the stored record, and it accepts
 * no record set from its caller: a caller-supplied set could replace durable
 * records, which is the defect Track 14 repaired.
 *
 * It claims no ownership and grants no exclusive access. The storage layer
 * performs no ownership check, so a later save from the sending Pi session
 * remains possible and Slate reports no conflict.
 */

import { SlateWriteRefused, type CorpusProject } from "./corpus.ts";
import {
	DURABLE_SESSION_POLICY,
	readDurableSession,
	type DurableSessionRecord,
} from "./session-record.ts";
import { isSlateSessionId } from "./session-identity.ts";
import { isSlateSessionName } from "./session-names.ts";
import type { RuntimeAuthorityBinding } from "./state.ts";

/** Plain information that identifies the stable namespace receiving a handoff. */
export interface DurableHandoffReference {
	readonly policy: typeof DURABLE_SESSION_POLICY;
	readonly identity: string;
	readonly name: string;
}

/** One validated read. This result grants no write access and no exclusive access. */
export interface DurableHandoffCompletion {
	readonly kind: "complete";
	readonly record: DurableSessionRecord;
	readonly binding: RuntimeAuthorityBinding;
}

export interface DurableHandoffOptions {
	project: CorpusProject;
	cwd: string;
	reference: unknown;
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

/**
 * Validate the named namespace and return the records it stores.
 *
 * The read is the whole operation. It writes nothing, so an interruption before
 * the receiving Pi session records the namespace loses no Slate record, and a
 * repeated call validates the namespace again.
 */
function validatingRead(options: DurableHandoffOptions): DurableHandoffCompletion {
	const reference = parseDurableHandoffReference(options.reference);
	if (reference === undefined) {
		throw new DurableHandoffRefused("slate refused a malformed or unsupported durable handoff reference");
	}

	/*
	 * This read validates the selected durable-session identity and storage boundary.
	 * The writer provenance, generation, and lifecycle status do not authorize access.
	 */
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

/** Validate the namespace a handoff names, and return the records it holds. */
export function completeDurableHandoff(options: DurableHandoffOptions): DurableHandoffCompletion {
	return validatingRead(options);
}

/** Retry the same validation later. No earlier attempt changed a stored record. */
export function recoverDurableHandoff(options: DurableHandoffOptions): DurableHandoffCompletion {
	return validatingRead(options);
}
