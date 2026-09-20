import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	LOGICAL_MODEL_EFFORTS,
	type LogicalModelDefinition,
	type LogicalModelEffort,
} from "./logical-model-definitions.ts";
import {
	resolveLogicalModelPolicy,
	type LogicalModelPolicy,
	type LogicalPolicyResolution,
} from "./logical-model-resolver.ts";
import {
	renderEffectiveLogicalModelPolicy,
	renderLogicalModelPrompt,
	type RememberedLogicalSelections,
} from "./logical-model-render.ts";
import {
	planCompressorRecovery,
	planOrdinaryRecovery,
	RecoveryOwnership,
	RecoveryPreferences,
	type PhysicalRoute,
	type RecoveryAdmission,
	type RecoveryCandidate,
	type RecoveryPreferenceSnapshot,
} from "./logical-model-recovery.ts";
import type { SwitchValidation } from "./logical-model-adapters.ts";

/** Inputs resolved once for one trusted parent-session lifetime. */
export interface CreateLogicalRuntimeInput {
	trusted: boolean;
	projectConfig?: unknown;
	documentationDirectory?: string;
	warn?: (message: string) => void;
	/** Lifecycle-level owner shared by replacement session runtimes. */
	ownership?: RecoveryOwnership;
}

export type LogicalReverseMapping =
	| { kind: "none" }
	| { kind: "one"; logicalModel: string; source: "exact-route" | "trusted-identity" }
	| { kind: "several"; logicalModels: readonly string[] };

export interface LogicalRuntime {
	readonly resolution: Readonly<LogicalPolicyResolution>;
	readonly policy?: Readonly<LogicalModelPolicy>;
	readonly criticalErrors: readonly string[];
	readonly warnings: readonly string[];
	readonly ownership: RecoveryOwnership;
	promptText(): string | undefined;
	effectiveText(remembered?: RememberedLogicalSelections): string;
	rememberedSelections(): Readonly<RememberedLogicalSelections>;
	definition(logicalName: string): Readonly<LogicalModelDefinition> | undefined;
	effortFor(logicalName: string): LogicalModelEffort | undefined;
	admit(): RecoveryAdmission | undefined;
	planOrdinary(logicalName: string, snapshot: RecoveryPreferenceSnapshot, activeRoute?: PhysicalRoute): readonly RecoveryCandidate[];
	planCompressor(snapshot: RecoveryPreferenceSnapshot): readonly RecoveryCandidate[];
	startRoute(logicalName: string, snapshot: RecoveryPreferenceSnapshot): RecoveryCandidate | undefined;
	reverseMap(route: PhysicalRoute, trustedLogicalIdentity?: string): LogicalReverseMapping;
	publishProvider(admission: RecoveryAdmission, logicalName: string, provider: string): boolean;
	publishCompressor(admission: RecoveryAdmission, index: number): boolean;
	resetPreferences(): void;
	validateRoute(ctx: Pick<ExtensionContext, "modelRegistry">, route: RecoveryCandidate): Promise<SwitchValidation>;
}

function providerOrder(definition: Readonly<LogicalModelDefinition>, remembered: string | undefined): string[] {
	const order: string[] = [];
	const seen = new Set<string>();
	for (const provider of [remembered, definition.preferredProvider, ...Object.keys(definition.providers)]) {
		if (provider !== undefined && Object.hasOwn(definition.providers, provider) && !seen.has(provider)) {
			seen.add(provider);
			order.push(provider);
		}
	}
	return order;
}

function routeMatches(definition: Readonly<LogicalModelDefinition>, route: PhysicalRoute): boolean {
	return Object.hasOwn(definition.providers, route.provider) && definition.providers[route.provider] === route.model;
}

function frozenResolutionWithErrors(
	resolution: Readonly<LogicalPolicyResolution>,
	errors: readonly string[],
): Readonly<LogicalPolicyResolution> {
	if (errors.length === resolution.errors.length) return resolution;
	return Object.freeze({ errors: Object.freeze([...errors]), warnings: resolution.warnings });
}

export function createLogicalRuntime(input: CreateLogicalRuntimeInput): Readonly<LogicalRuntime> {
	const resolution = resolveLogicalModelPolicy({ trusted: input.trusted, projectConfig: input.projectConfig });
	const rendered = resolution.policy
		? renderLogicalModelPrompt(resolution.policy, input.documentationDirectory)
		: undefined;
	const criticalErrors = Object.freeze([
		...resolution.errors,
		...(rendered?.error === undefined ? [] : [rendered.error]),
	]);
	const warnings = resolution.warnings;
	for (const warning of warnings) input.warn?.(warning);
	const policy = criticalErrors.length === 0 ? resolution.policy : undefined;
	const preferences = policy ? new RecoveryPreferences(policy) : undefined;
	const ownership = input.ownership ?? new RecoveryOwnership();
	const effectiveResolution = frozenResolutionWithErrors(resolution, criticalErrors);

	const runtime: LogicalRuntime = {
		resolution,
		...(policy ? { policy } : {}),
		criticalErrors,
		warnings,
		ownership,
		promptText: () => policy ? rendered?.text : undefined,
		effectiveText: (remembered = {}) => renderEffectiveLogicalModelPolicy(effectiveResolution, remembered),
		rememberedSelections: () => {
			const remembered = preferences?.remembered();
			const compressorModel = remembered?.compressorIndex === undefined ? undefined : policy?.compressor[remembered.compressorIndex]?.model;
			return Object.freeze({
				...(remembered === undefined ? {} : { providers: remembered.providers }),
				...(compressorModel === undefined ? {} : { compressorModel }),
			});
		},
		definition: (logicalName) => policy?.definitions[logicalName],
		effortFor: (logicalName) => policy?.definitions[logicalName]?.effort,
		admit: () => preferences?.admit(),
		planOrdinary: (logicalName, snapshot, activeRoute) => policy
			? planOrdinaryRecovery(policy, logicalName, snapshot, activeRoute)
			: Object.freeze([]),
		planCompressor: (snapshot) => policy ? planCompressorRecovery(policy, snapshot) : Object.freeze([]),
		startRoute: (logicalName, snapshot) => {
			const definition = policy?.ordinary.find((item) => item.model === logicalName);
			if (!definition) return undefined;
			const provider = providerOrder(definition, snapshot.providers[logicalName])[0];
			if (provider === undefined) return undefined;
			return Object.freeze({
				kind: "ordinary",
				logicalModel: logicalName,
				effort: definition.effort,
				provider,
				model: definition.providers[provider]!,
			});
		},
		reverseMap: (route, trustedLogicalIdentity) => {
			if (!policy) return { kind: "none" };
			const matches = policy.ordinary.filter((definition) => routeMatches(definition, route)).map((definition) => definition.model);
			if (matches.length === 0) return { kind: "none" };
			if (matches.length === 1) return { kind: "one", logicalModel: matches[0]!, source: "exact-route" };
			if (trustedLogicalIdentity !== undefined && matches.includes(trustedLogicalIdentity)) {
				return { kind: "one", logicalModel: trustedLogicalIdentity, source: "trusted-identity" };
			}
			return { kind: "several", logicalModels: Object.freeze(matches) };
		},
		publishProvider: (admission, logicalName, provider) => preferences?.publishProvider(admission, logicalName, provider) ?? false,
		publishCompressor: (admission, index) => preferences?.publishCompressor(admission, index) ?? false,
		resetPreferences: () => preferences?.reset(),
		validateRoute: async (ctx, route) => {
			const definition = policy?.definitions[route.logicalModel];
			if (!definition || definition.providers[route.provider] !== route.model) {
				return { ok: false, kind: "unavailable", reason: "The physical route is not permitted by the active logical model definition." };
			}
			let model: Model<any> | undefined;
			try {
				model = ctx.modelRegistry.find(route.provider, route.model);
			} catch {
				model = undefined;
			}
			if (!model) return { ok: false, kind: "unavailable", reason: "The permitted physical route is absent from Pi's model registry." };
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (auth.ok !== true) return { ok: false, kind: "unavailable", reason: "Pi could not resolve credentials for the permitted physical route." };
			} catch {
				return { ok: false, kind: "unavailable", reason: "Pi could not resolve credentials for the permitted physical route." };
			}
			let supported: readonly string[];
			try {
				supported = getSupportedThinkingLevels(model);
			} catch {
				return { ok: false, kind: "unsupported", reason: "Pi could not determine the route's supported effort levels." };
			}
			if (!supported.includes(route.effort)) {
				return { ok: false, kind: "unsupported", reason: `Pi does not support effort ${route.effort} on the permitted physical route.` };
			}
			return { ok: true };
		},
	};
	return Object.freeze(runtime);
}

/** A worker session's immutable state immediately after it opens. */
declare const SESSION_BASELINE_BRAND: unique symbol;
export interface SessionBaseline {
	readonly [SESSION_BASELINE_BRAND]: true;
	readonly model?: string;
	readonly effort?: LogicalModelEffort;
}
export const NO_SESSION_BASELINE = {} as SessionBaseline;

function effort(value: unknown): LogicalModelEffort | undefined {
	return typeof value === "string" && (LOGICAL_MODEL_EFFORTS as readonly string[]).includes(value)
		? value as LogicalModelEffort
		: undefined;
}
function modelSpec(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

export function captureSessionBaseline(session: { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: unknown }): SessionBaseline {
	const provider = session.model?.provider;
	const id = session.model?.id;
	const model = typeof provider === "string" && typeof id === "string" ? modelSpec(`${provider}/${id}`) : undefined;
	const selectedEffort = effort(session.thinkingLevel);
	return {
		...(model === undefined ? {} : { model }),
		...(selectedEffort === undefined ? {} : { effort: selectedEffort }),
	} as SessionBaseline;
}

export type ModelSwitchDecision =
	| { kind: "switch"; spec: string; source: "plan" | "revert" }
	| { kind: "keep"; reason: "no-baseline" | "failover-held" | "already-current" };
export function decideModelSwitch(input: { planned?: string; current?: string; baseline?: SessionBaseline; failoverHeld?: boolean }): ModelSwitchDecision {
	const planned = modelSpec(input.planned);
	const baseline = modelSpec(input.baseline?.model);
	const current = modelSpec(input.current);
	if (planned !== undefined) return planned === current ? { kind: "keep", reason: "already-current" } : { kind: "switch", spec: planned, source: "plan" };
	if (baseline === undefined) return { kind: "keep", reason: "no-baseline" };
	if (input.failoverHeld === true) return { kind: "keep", reason: "failover-held" };
	return baseline === current ? { kind: "keep", reason: "already-current" } : { kind: "switch", spec: baseline, source: "revert" };
}

export type EffortSwitchDecision =
	| { kind: "switch"; level: LogicalModelEffort; source: "plan" | "revert" }
	| { kind: "keep"; reason: "no-baseline" | "already-current" };
export function decideEffortSwitch(input: { planned?: LogicalModelEffort; current?: LogicalModelEffort; baseline?: SessionBaseline }): EffortSwitchDecision {
	const planned = effort(input.planned);
	const baseline = effort(input.baseline?.effort);
	const current = effort(input.current);
	const target = planned ?? baseline;
	if (target === undefined) return { kind: "keep", reason: "no-baseline" };
	if (target === current) return { kind: "keep", reason: "already-current" };
	return { kind: "switch", level: target, source: planned === undefined ? "revert" : "plan" };
}

declare const OPEN_MODEL_BRAND: unique symbol;
export type OpenModel = string & { readonly [OPEN_MODEL_BRAND]: true };
export interface SessionOpenDecision { readonly model?: OpenModel; readonly unplanned?: string }
export function planSessionOpen(route: PhysicalRoute | undefined): SessionOpenDecision {
	if (route === undefined) return {};
	const spec = modelSpec(`${route.provider}/${route.model}`);
	return spec === undefined ? { unplanned: "No physical route was resolved for the worker session." } : { model: spec as OpenModel };
}
