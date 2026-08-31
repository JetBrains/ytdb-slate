import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOwnerSessionDigest, isSlateSessionId } from "./session-identity.ts";
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
	sanitizeEpisodeRecord,
	sanitizeThreadRecord,
	type EpisodeRecord,
	type RuntimeAuthorityBackend,
	type RuntimeAuthorityBinding,
	type RuntimeAuthorityContext,
	type RuntimeAuthorityExternalRecord,
	type ThreadRecord,
} from "./state.ts";

export const SLATE_BINDING_CUSTOM_TYPE = "slate-binding" as const;
export const LEGACY_SLATE_STATE_CUSTOM_TYPE = "slate-state" as const;

/** A Pi-held locator. It identifies one durable namespace and grants no write access. */
export interface SlateBindingRecord {
	readonly policy: typeof DURABLE_SESSION_POLICY;
	readonly identity: string;
	readonly name: string;
}

export type RuntimeAuthorityRefusal =
	| "malformed-binding"
	| "conflicting-bindings"
	| "mixed-authority"
	| "off-branch-binding"
	| "malformed-legacy";

export type RuntimeAuthorityClassification =
	| { readonly kind: "fresh" }
	| { readonly kind: "legacy"; readonly snapshot?: Readonly<Record<string, unknown>> }
	| { readonly kind: "durable"; readonly binding: SlateBindingRecord }
	| { readonly kind: "refused"; readonly reason: RuntimeAuthorityRefusal; readonly message: string };

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

function validLegacyGraph(threads: ThreadRecord[], episodes: EpisodeRecord[]): boolean {
	const threadById = new Map<string, ThreadRecord>();
	for (const thread of threads) {
		if (threadById.has(thread.id)) return false;
		threadById.set(thread.id, thread);
	}
	const episodeById = new Map<string, EpisodeRecord>();
	for (const episode of episodes) {
		if (episodeById.has(episode.id)) return false;
		episodeById.set(episode.id, episode);
	}
	for (const thread of threads) {
		if (thread.episodeId !== undefined && episodeById.get(thread.episodeId)?.threadId !== thread.id) return false;
	}
	return episodes.every((episode) => threadById.get(episode.threadId)?.episodeId === episode.id);
}

const LEGACY_THREAD_REQUIRED = ["id", "name", "status", "type", "createdAt", "updatedAt"] as const;

const LEGACY_EPISODE_REQUIRED = [
	"id",
	"threadId",
	"task",
	"status",
	"file",
	"createdAt",
] as const;

function decodeLegacySnapshot(value: unknown): Readonly<Record<string, unknown>> | undefined {
	const snapshot = clonePlainData(value);
	if (snapshot === INVALID_DATA || !object(snapshot)
		|| !Array.isArray(snapshot.threads) || !Array.isArray(snapshot.episodes)) return undefined;
	const legacyThreads = snapshot.threads;
	const legacyEpisodes = snapshot.episodes;
	if (legacyThreads.some((thread) => !object(thread)
		|| !LEGACY_THREAD_REQUIRED.every((key) => Object.hasOwn(thread, key)))) return undefined;
	if (legacyEpisodes.some((episode) => !object(episode)
		|| !LEGACY_EPISODE_REQUIRED.every((key) => Object.hasOwn(episode, key)))) return undefined;
	if (typeof snapshot.orchestratorMode !== "boolean") return undefined;
	if (snapshot.paused !== undefined && typeof snapshot.paused !== "boolean") return undefined;
	for (const cost of [snapshot.workerCostUsd, snapshot.carriedCostUsd]) {
		if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) return undefined;
	}
	if (snapshot.threadSeq !== undefined
		&& (!Number.isSafeInteger(snapshot.threadSeq) || (snapshot.threadSeq as number) < 0)) return undefined;
	if (snapshot.slateSessionId !== undefined && !isSlateSessionId(snapshot.slateSessionId)) return undefined;
	if (snapshot.slateSessionName !== undefined && !isSlateSessionName(snapshot.slateSessionName)) return undefined;
	if (snapshot.ownerSessionDigest !== undefined && !isOwnerSessionDigest(snapshot.ownerSessionDigest)) return undefined;
	if (snapshot.slateSessionParentChain !== undefined) {
		if (!Array.isArray(snapshot.slateSessionParentChain)) return undefined;
		for (const parent of snapshot.slateSessionParentChain) {
			if (!object(parent) || !exactKeys(parent, ["identity", "name"])
				|| !isSlateSessionId(parent.identity) || !isSlateSessionName(parent.name)) return undefined;
		}
	}
	const repairs: string[] = [];
	const threads = legacyThreads.map((thread) => sanitizeThreadRecord(thread, repairs));
	const episodes = legacyEpisodes.map((episode) => sanitizeEpisodeRecord(episode, repairs));
	if (repairs.length > 0 || threads.some((thread) => thread === undefined)
		|| episodes.some((episode) => episode === undefined)
		|| threads.some((thread, index) => !isDeepStrictEqual(clonePlainData(thread), legacyThreads[index]))
		|| episodes.some((episode, index) => !isDeepStrictEqual(clonePlainData(episode), legacyEpisodes[index]))
		|| !validLegacyGraph(threads as ThreadRecord[], episodes as EpisodeRecord[])) return undefined;
	return snapshot;
}

function refused(reason: RuntimeAuthorityRefusal, message: string): RuntimeAuthorityClassification {
	return { kind: "refused", reason, message };
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

/** Production durable I/O adapter. Merely creating it performs no storage operation. */
export function createRuntimeAuthorityBackend(
	pi: ExtensionAPI,
	hooks: { durable?: DurableSessionHooks; mint?: () => { identity: string; name: string } } = {},
): RuntimeAuthorityBackend {
	const mint = hooks.mint ?? (() => {
		const value = mintSlateSession();
		return { identity: value.identity, name: sessionNameFromBytes(value.nameBytes) };
	});
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
			pi.appendEntry(SLATE_BINDING_CUSTOM_TYPE, binding as unknown as Record<string, unknown>);
		},
		isCommitUncertain(error: unknown): boolean {
			return error instanceof DurableCommitUncertain;
		},
	};
}

/** Classify one Pi session and active branch without reading or changing external state. */
export function classifyRuntimeAuthority(
	sessionEntries: readonly unknown[],
	activeBranch: readonly unknown[],
): RuntimeAuthorityClassification {
	const sessionBinding = collect(sessionEntries, SLATE_BINDING_CUSTOM_TYPE);
	const branchBinding = collect(activeBranch, SLATE_BINDING_CUSTOM_TYPE);
	if (sessionBinding.malformed || branchBinding.malformed) {
		return refused("malformed-binding", "slate refused malformed Pi binding evidence");
	}
	const bindingData = [...sessionBinding.values, ...branchBinding.values];
	const bindings: SlateBindingRecord[] = [];
	for (const value of bindingData) {
		const binding = parseSlateBindingRecord(value);
		if (binding === undefined) return refused("malformed-binding", "slate refused malformed Pi binding evidence");
		bindings.push(binding);
	}
	const relationship = bindings[0];
	if (relationship !== undefined && bindings.some((binding) => !sameRelationship(binding, relationship))) {
		return refused("conflicting-bindings", "slate refused conflicting Pi binding relationships");
	}

	const sessionLegacy = collect(sessionEntries, LEGACY_SLATE_STATE_CUSTOM_TYPE);
	const branchLegacy = collect(activeBranch, LEGACY_SLATE_STATE_CUSTOM_TYPE);
	if (sessionLegacy.malformed || branchLegacy.malformed) {
		return refused("malformed-legacy", "slate refused malformed Pi legacy evidence");
	}
	const legacyData = [...sessionLegacy.values, ...branchLegacy.values];
	const decodedLegacy = legacyData.map(decodeLegacySnapshot);
	if (decodedLegacy.some((snapshot) => snapshot === undefined)) {
		return refused("malformed-legacy", "slate refused malformed Pi legacy evidence without fallback");
	}
	const hasBinding = bindingData.length > 0;
	const hasLegacy = legacyData.length > 0;
	if (hasBinding && hasLegacy) {
		return refused("mixed-authority", "slate refused mixed legacy and durable Pi authority evidence");
	}
	if (hasBinding) {
		if (branchBinding.values.length === 0) {
			return refused("off-branch-binding", "slate refused a Pi binding that exists only outside the active branch");
		}
		const selected = parseSlateBindingRecord(branchBinding.values.at(-1));
		if (selected === undefined) return refused("malformed-binding", "slate refused malformed active Pi binding evidence");
		return { kind: "durable", binding: selected };
	}
	if (hasLegacy) {
		if (branchLegacy.values.length === 0) return { kind: "legacy" };
		const selected = decodeLegacySnapshot(branchLegacy.values.at(-1));
		if (selected === undefined) {
			return refused("malformed-legacy", "slate refused the malformed latest active legacy snapshot");
		}
		return { kind: "legacy", snapshot: selected };
	}
	return { kind: "fresh" };
}
