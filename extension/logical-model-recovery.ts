import type { LogicalModelDefinition, LogicalModelEffort } from "./logical-model-definitions.ts";
import type { LogicalModelPolicy } from "./logical-model-resolver.ts";

export interface PhysicalRoute {
	provider: string;
	model: string;
}

export interface RecoveryCandidate extends PhysicalRoute {
	logicalModel: string;
	effort: LogicalModelEffort;
	kind: "ordinary" | "compressor";
	compressorIndex?: number;
}

export interface RecoveryPreferenceSnapshot {
	providers: Readonly<Record<string, string>>;
	compressorIndex: number;
	resetEpoch: number;
}

export interface RecoveryAdmission {
	sequence: number;
	snapshot: RecoveryPreferenceSnapshot;
}

interface ProviderPreference {
	provider: string;
	sequence: number;
}

interface CompressorPreference {
	index: number;
	sequence: number;
}

function physicalKey(route: PhysicalRoute): string {
	return `${route.provider.length}:${route.provider}${route.model}`;
}

function providerOrder(definition: Readonly<LogicalModelDefinition>, remembered: string | undefined, active: string | undefined = undefined): string[] {
	const order: string[] = [];
	for (const provider of [active, remembered, definition.preferredProvider, ...Object.keys(definition.providers)]) {
		if (provider !== undefined && Object.hasOwn(definition.providers, provider) && !order.includes(provider)) order.push(provider);
	}
	return order;
}

function configuredIndex(policy: Readonly<LogicalModelPolicy>, model: string): number {
	return policy.ordinary.findIndex((candidate) => candidate.model === model);
}

function costOrder(policy: Readonly<LogicalModelPolicy>, models: readonly Readonly<LogicalModelDefinition>[]): Readonly<LogicalModelDefinition>[] {
	return [...models].sort((left, right) => left.costRating - right.costRating || configuredIndex(policy, left.model) - configuredIndex(policy, right.model));
}

export function ordinaryModelRecoveryOrder(
	policy: Readonly<LogicalModelPolicy>,
	activeLogicalModel: string,
): readonly Readonly<LogicalModelDefinition>[] {
	const active = policy.ordinary.find((candidate) => candidate.model === activeLogicalModel);
	if (!active) return Object.freeze([]);
	const byRating = new Map<number, Readonly<LogicalModelDefinition>[]>();
	for (const model of policy.ordinary) {
		const group = byRating.get(model.capabilityRating) ?? [];
		group.push(model);
		byRating.set(model.capabilityRating, group);
	}
	const order: Readonly<LogicalModelDefinition>[] = [active];
	order.push(...costOrder(policy, (byRating.get(active.capabilityRating) ?? []).filter((model) => model.model !== active.model)));
	const higher = [...byRating.keys()].filter((rating) => rating > active.capabilityRating).sort((a, b) => a - b);
	const lower = [...byRating.keys()].filter((rating) => rating < active.capabilityRating).sort((a, b) => b - a);
	for (let index = 0; index < Math.max(higher.length, lower.length); index++) {
		const high = higher[index];
		if (high !== undefined) order.push(...costOrder(policy, byRating.get(high) ?? []));
		const low = lower[index];
		if (low !== undefined) order.push(...costOrder(policy, byRating.get(low) ?? []));
	}
	return Object.freeze(order);
}

export function planOrdinaryRecovery(
	policy: Readonly<LogicalModelPolicy>,
	activeLogicalModel: string,
	snapshot: RecoveryPreferenceSnapshot,
	activeRoute?: PhysicalRoute,
): readonly RecoveryCandidate[] {
	const candidates: RecoveryCandidate[] = [];
	for (const definition of ordinaryModelRecoveryOrder(policy, activeLogicalModel)) {
		for (const provider of providerOrder(definition, snapshot.providers[definition.model])) {
			const route = { provider, model: definition.providers[provider]! };
			if (activeRoute !== undefined && physicalKey(route) === physicalKey(activeRoute)) continue;
			candidates.push(Object.freeze({
				kind: "ordinary",
				logicalModel: definition.model,
				effort: definition.effort,
				...route,
			}));
		}
	}
	return Object.freeze(candidates);
}

export function planCompressorRecovery(
	policy: Readonly<LogicalModelPolicy>,
	snapshot: RecoveryPreferenceSnapshot,
): readonly RecoveryCandidate[] {
	const candidates: RecoveryCandidate[] = [];
	for (let index = snapshot.compressorIndex; index < policy.compressor.length; index++) {
		const entry = policy.compressor[index]!;
		const definition = policy.definitions[entry.model];
		if (!definition) continue;
		for (const provider of providerOrder(definition, snapshot.providers[definition.model])) {
			candidates.push(Object.freeze({
				kind: "compressor",
				logicalModel: definition.model,
				effort: entry.effort,
				provider,
				model: definition.providers[provider]!,
				compressorIndex: index,
			}));
		}
	}
	return Object.freeze(candidates);
}

export class RecoveryOperation {
	readonly #visited = new Set<string>();

	enter(route: PhysicalRoute): boolean {
		const key = physicalKey(route);
		if (this.#visited.has(key)) return false;
		this.#visited.add(key);
		return true;
	}

	hasVisited(route: PhysicalRoute): boolean {
		return this.#visited.has(physicalKey(route));
	}

	get visitedCount(): number {
		return this.#visited.size;
	}
}

export class RecoveryPreferences {
	readonly #policy: Readonly<LogicalModelPolicy>;
	readonly #providers = new Map<string, ProviderPreference>();
	#compressor: CompressorPreference | undefined;
	#nextSequence = 0;
	#resetEpoch = 0;

	constructor(policy: Readonly<LogicalModelPolicy>) {
		this.#policy = policy;
	}

	admit(): RecoveryAdmission {
		const providers = Object.create(null) as Record<string, string>;
		for (const [model, preference] of this.#providers) providers[model] = preference.provider;
		return Object.freeze({
			sequence: ++this.#nextSequence,
			snapshot: Object.freeze({ providers: Object.freeze(providers), compressorIndex: this.#compressor?.index ?? 0, resetEpoch: this.#resetEpoch }),
		});
	}

	publishProvider(admission: RecoveryAdmission, logicalModel: string, provider: string): boolean {
		if (admission.snapshot.resetEpoch !== this.#resetEpoch) return false;
		const definition = this.#policy.definitions[logicalModel];
		if (!definition || !Object.hasOwn(definition.providers, provider)) return false;
		const current = this.#providers.get(logicalModel);
		if (current && current.sequence > admission.sequence) return false;
		this.#providers.set(logicalModel, { provider, sequence: admission.sequence });
		return true;
	}

	publishCompressor(admission: RecoveryAdmission, index: number): boolean {
		if (admission.snapshot.resetEpoch !== this.#resetEpoch || !Number.isInteger(index) || index < 0 || index >= this.#policy.compressor.length) return false;
		if (this.#compressor && index < this.#compressor.index) return false;
		if (this.#compressor && this.#compressor.sequence > admission.sequence) return false;
		this.#compressor = { index, sequence: admission.sequence };
		return true;
	}

	reset(): void {
		this.#resetEpoch++;
		this.#providers.clear();
		this.#compressor = undefined;
	}
}

interface OwnershipToken {
	readonly identity: symbol;
	readonly sessionKey: string;
	readonly savedDefaultKey?: string;
}

export interface RecoveryLease {
	release(): void;
}

export type RecoveryOwnershipResult =
	| { kind: "acquired"; lease: RecoveryLease }
	| { kind: "busy"; resource: "execution-session" | "saved-default"; key: string };

export class RecoveryOwnership {
	readonly #sessions = new Map<string, OwnershipToken>();
	readonly #defaults = new Map<string, OwnershipToken>();

	acquire(sessionKey: string, savedDefaultKey?: string): RecoveryOwnershipResult {
		if (this.#sessions.has(sessionKey)) return { kind: "busy", resource: "execution-session", key: sessionKey };
		if (savedDefaultKey !== undefined && this.#defaults.has(savedDefaultKey)) return { kind: "busy", resource: "saved-default", key: savedDefaultKey };
		const token: OwnershipToken = Object.freeze({ identity: Symbol("recovery-owner"), sessionKey, ...(savedDefaultKey === undefined ? {} : { savedDefaultKey }) });
		this.#sessions.set(sessionKey, token);
		if (savedDefaultKey !== undefined) this.#defaults.set(savedDefaultKey, token);
		let released = false;
		return {
			kind: "acquired",
			lease: Object.freeze({
				release: () => {
					if (released) return;
					released = true;
					if (this.#sessions.get(sessionKey) === token) this.#sessions.delete(sessionKey);
					if (savedDefaultKey !== undefined && this.#defaults.get(savedDefaultKey) === token) this.#defaults.delete(savedDefaultKey);
				},
			}),
		};
	}

	replaceSession(sessionKey: string): void {
		this.#sessions.delete(sessionKey);
	}

	replaceLifecycle(): void {
		this.#sessions.clear();
	}
}
