import {
	LOGICAL_MODEL_EFFORTS,
	SHIPPED_COMPRESSOR_MODELS,
	SHIPPED_LOGICAL_MODELS,
	isLogicalModelName,
	type LogicalCompressorEntry,
	type LogicalFieldSource,
	type LogicalModelDefinition,
	type LogicalModelEffort,
	type LogicalModelSource,
} from "./logical-model-definitions.ts";

export interface LogicalModelPolicy {
	definitions: Readonly<Record<string, Readonly<LogicalModelDefinition>>>;
	ordinary: readonly Readonly<LogicalModelDefinition>[];
	compressor: readonly Readonly<LogicalCompressorEntry>[];
}
export interface LogicalPolicyResolution {
	policy?: Readonly<LogicalModelPolicy>;
	errors: readonly string[];
	warnings: readonly string[];
}
export interface ResolveLogicalPolicyInput {
	trusted: boolean;
	projectConfig?: unknown;
}

type UnknownRecord = Record<string, unknown>;
const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const EXACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const LEGACY_ROUTER_KEYS = ["allowUnmeasuredEffort", "showWarnings"] as const;
const ROUTER_KEYS = new Set(["models", "compressor", ...LEGACY_ROUTER_KEYS]);

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) deepFreeze(inner);
	}
	return value;
}
function own(record: UnknownRecord, key: string): boolean { return Object.prototype.hasOwnProperty.call(record, key); }
function keys(value: UnknownRecord, path: string, errors: string[]): string[] {
	try { return Object.keys(value); } catch { errors.push(`${path} fields could not be read.`); return []; }
}
function record(value: unknown): UnknownRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}
function read(value: UnknownRecord, key: string, errors: string[], path: string): unknown {
	try { return value[key]; } catch { errors.push(`${path}.${key} could not be read.`); return undefined; }
}
function rating(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100;
}
function effort(value: unknown): value is LogicalModelEffort {
	return typeof value === "string" && (LOGICAL_MODEL_EFFORTS as readonly string[]).includes(value);
}
function textList(value: unknown, path: string, errors: string[]): string[] | undefined {
	if (!Array.isArray(value)) { errors.push(`${path} must be an array of strings.`); return undefined; }
	const result: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = value[index];
		if (typeof item !== "string" || item.trim() === "") errors.push(`${path}[${index}] must be a non-empty string.`);
		else result.push(item);
	}
	return result;
}
function providerMap(value: unknown, path: string, errors: string[]): Record<string, string> | undefined {
	const input = record(value);
	if (!input) { errors.push(`${path} must be an object with exact provider-to-model bindings.`); return undefined; }
	const result = Object.create(null) as Record<string, string>;
	for (const key of keys(input, path, errors)) {
		const model = read(input, key, errors, path);
		if (!PROVIDER_NAME.test(key) || key === "__proto__" || key === "prototype" || key === "constructor") errors.push(`${path} has invalid provider ${JSON.stringify(key)}.`);
		else if (typeof model !== "string" || !EXACT_ID.test(model)) errors.push(`${path}.${key} must be one exact Pi model identifier.`);
		else result[key] = model;
	}
	if (Object.keys(result).length === 0) errors.push(`${path} must permit at least one exact provider route.`);
	return result;
}
function definition(value: unknown, path: string, errors: string[]): LogicalModelDefinition | undefined {
	const input = record(value);
	if (!input) { errors.push(`${path} must be an object.`); return undefined; }
	const allowed = new Set(["model", "capabilityRating", "effort", "costRating", "preferredProvider", "providers", "guidelines", "cautions"]);
	for (const key of keys(input, path, errors)) if (!allowed.has(key)) errors.push(`${path} has unknown field ${JSON.stringify(key)}.`);
	const model = read(input, "model", errors, path);
	const capabilityRating = read(input, "capabilityRating", errors, path);
	const selectedEffort = read(input, "effort", errors, path);
	const costRating = read(input, "costRating", errors, path);
	const preferredProvider = read(input, "preferredProvider", errors, path);
	const providers = providerMap(read(input, "providers", errors, path), `${path}.providers`, errors);
	const guidelines = textList(read(input, "guidelines", errors, path), `${path}.guidelines`, errors);
	const cautions = textList(read(input, "cautions", errors, path), `${path}.cautions`, errors);
	if (!isLogicalModelName(model)) errors.push(`${path}.model must be one provider-free logical name.`);
	if (!rating(capabilityRating)) errors.push(`${path}.capabilityRating must be an integer from 1 through 100.`);
	if (!effort(selectedEffort)) errors.push(`${path}.effort must be one of: ${LOGICAL_MODEL_EFFORTS.join(", ")}.`);
	if (!rating(costRating)) errors.push(`${path}.costRating must be an integer from 1 through 100.`);
	if (typeof preferredProvider !== "string" || !PROVIDER_NAME.test(preferredProvider)) errors.push(`${path}.preferredProvider must be one exact provider name.`);
	else if (providers && !own(providers, preferredProvider)) errors.push(`${path}.preferredProvider must be present in ${path}.providers.`);
	if (!isLogicalModelName(model) || !rating(capabilityRating) || !effort(selectedEffort) || !rating(costRating) || typeof preferredProvider !== "string" || !PROVIDER_NAME.test(preferredProvider) || !providers || !own(providers, preferredProvider) || !guidelines || !cautions) return undefined;
	return { model, capabilityRating, effort: selectedEffort, costRating, preferredProvider, providers, guidelines, cautions };
}
function stringArray(value: unknown, path: string, errors: string[]): string[] | undefined {
	if (!Array.isArray(value)) { errors.push(`${path} must be an array of logical model names.`); return undefined; }
	const result: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index++) {
		const item = value[index];
		if (!isLogicalModelName(item)) errors.push(`${path}[${index}] must be one provider-free logical name.`);
		else if (seen.has(item)) errors.push(`${path} contains duplicate model ${JSON.stringify(item)}.`);
		else { seen.add(item); result.push(item); }
	}
	return result;
}
function objectArray(value: unknown, path: string, errors: string[]): UnknownRecord[] | undefined {
	if (!Array.isArray(value)) { errors.push(`${path} must be an array.`); return undefined; }
	const result: UnknownRecord[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index++) {
		const item = record(value[index]);
		if (!item) { errors.push(`${path}[${index}] must be an object with an explicit model field.`); continue; }
		const model = read(item, "model", errors, `${path}[${index}]`);
		if (!isLogicalModelName(model)) {
			errors.push(`${path}[${index}].model must be one provider-free logical name.`);
			result.push(item);
		} else if (seen.has(model)) errors.push(`${path} contains duplicate model ${JSON.stringify(model)}.`);
		else { seen.add(model); result.push(item); }
	}
	return result;
}
function cloneFieldSource(value: LogicalFieldSource): LogicalFieldSource { return { ...value }; }
function cloneSource(value: LogicalModelSource): LogicalModelSource {
	return {
		...(value.capabilityRating ? { capabilityRating: cloneFieldSource(value.capabilityRating) } : {}),
		...(value.costRating ? { costRating: cloneFieldSource(value.costRating) } : {}),
		...(value.guidelines ? { guidelines: cloneFieldSource(value.guidelines) } : {}),
	};
}
function cloneProviders(value: Readonly<Record<string, string>>): Record<string, string> {
	const result = Object.create(null) as Record<string, string>;
	for (const [provider, model] of Object.entries(value)) result[provider] = model;
	return result;
}
function cloneDefinition(value: LogicalModelDefinition): LogicalModelDefinition {
	return { ...value, providers: cloneProviders(value.providers), guidelines: [...value.guidelines], cautions: [...value.cautions], ...(value.source ? { source: cloneSource(value.source) } : {}) };
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
function readCurrentConfig(projectConfig: unknown, errors: string[], warnings: string[]): UnknownRecord | undefined {
	const root = record(projectConfig);
	if (!root) { if (projectConfig !== undefined) errors.push("slate configuration must be an object."); return undefined; }
	keys(root, "slate", errors);
	for (const key of ["modelFailover", "episodeModel"]) if (own(root, key)) warnings.push(`Legacy key ${key} is ignored. Use router.models or router.compressor.models. No automatic migration is performed.`);
	const routerValue = own(root, "router") ? read(root, "router", errors, "slate") : undefined;
	if (routerValue === undefined) return undefined;
	const router = record(routerValue);
	if (!router) { errors.push("router must be an object."); return undefined; }
	for (const key of keys(router, "router", errors)) if (!ROUTER_KEYS.has(key)) errors.push(`router has unknown field ${JSON.stringify(key)}.`);
	for (const key of LEGACY_ROUTER_KEYS) if (own(router, key)) warnings.push(`Legacy key router.${key} is ignored. No automatic migration is performed.`);
	return router;
}

export function resolveLogicalModelPolicy(input: ResolveLogicalPolicyInput): Readonly<LogicalPolicyResolution> {
	const errors: string[] = [];
	const warnings: string[] = [];
	let router: UnknownRecord | undefined;
	if (input.trusted) router = readCurrentConfig(input.projectConfig, errors, warnings);
	const definitions = new Map<string, LogicalModelDefinition>(SHIPPED_LOGICAL_MODELS.map((item) => [item.model, cloneDefinition(item)]));
	const modelsValue = router && own(router, "models") ? read(router, "models", errors, "router") : undefined;
	let models: UnknownRecord | undefined;
	if (modelsValue !== undefined) {
		models = record(modelsValue);
		if (!models) {
			warnings.push("Legacy key router.models is ignored because its array form is not migrated. Use the router.models object grammar.");
			if (!Array.isArray(modelsValue)) errors.push("router.models must be an object.");
		}
	}
	const allowedModelKeys = new Set(["include", "add", "replace", "exclude"]);
	if (models) for (const key of keys(models, "router.models", errors)) if (!allowedModelKeys.has(key)) errors.push(`router.models has unknown field ${JSON.stringify(key)}.`);
	const add = models && own(models, "add") ? objectArray(read(models, "add", errors, "router.models"), "router.models.add", errors) : [];
	const replace = models && own(models, "replace") ? objectArray(read(models, "replace", errors, "router.models"), "router.models.replace", errors) : [];
	const include = models && own(models, "include") ? stringArray(read(models, "include", errors, "router.models"), "router.models.include", errors) : undefined;
	const exclude = models && own(models, "exclude") ? stringArray(read(models, "exclude", errors, "router.models"), "router.models.exclude", errors) : [];
	const addedNames: string[] = [];
	for (let index = 0; index < (add?.length ?? 0); index++) {
		const item = add![index]!;
		const name = read(item, "model", errors, `router.models.add[${index}]`);
		if (typeof name === "string" && definitions.has(name)) { errors.push(`router.models.add cannot replace existing model ${JSON.stringify(name)}. Use replace.`); continue; }
		const parsed = definition(item, `router.models.add[${index}]`, errors);
		if (parsed) { definitions.set(parsed.model, parsed); addedNames.push(parsed.model); }
	}
	for (let index = 0; index < (replace?.length ?? 0); index++) {
		const item = replace![index]!;
		const path = `router.models.replace[${index}]`;
		const name = read(item, "model", errors, path);
		if (!isLogicalModelName(name)) continue;
		if (addedNames.includes(name)) { errors.push(`Model ${JSON.stringify(name)} cannot appear in both add and replace.`); continue; }
		const base = definitions.get(name);
		if (!base) { errors.push(`router.models.replace targets unknown model ${JSON.stringify(name)}.`); continue; }
		const allowed = new Set(["model", "capabilityRating", "effort", "costRating", "preferredProvider", "providers", "guidelines", "cautions"]);
		const itemKeys = keys(item, path, errors);
		for (const key of itemKeys) if (!allowed.has(key)) errors.push(`${path} has unknown field ${JSON.stringify(key)}.`);
		const suppliedEffort = own(item, "effort") ? read(item, "effort", errors, path) : undefined;
		const effortChanged = effort(suppliedEffort) && suppliedEffort !== base.effort;
		if (effortChanged && (!own(item, "capabilityRating") || !own(item, "costRating"))) errors.push(`${path} changes effort and must also supply capabilityRating and costRating.`);
		const merged: UnknownRecord = { ...base, model: name };
		for (const key of itemKeys) if (allowed.has(key) && key !== "model") merged[key] = read(item, key, errors, path);
		delete merged.source;
		const parsed = definition(merged, path, errors);
		if (!parsed) continue;
		const inherited = base.source ? cloneSource(base.source) : undefined;
		if (inherited) {
			if (effortChanged || parsed.capabilityRating !== base.capabilityRating) delete inherited.capabilityRating;
			if (effortChanged || parsed.costRating !== base.costRating) delete inherited.costRating;
			if (!sameStrings(parsed.guidelines, base.guidelines)) delete inherited.guidelines;
		}
		definitions.set(name, { ...parsed, ...(inherited && Object.keys(inherited).length > 0 ? { source: inherited } : {}) });
	}
	const initial = include ?? SHIPPED_LOGICAL_MODELS.map((item) => item.model);
	for (const name of initial) if (!definitions.has(name)) errors.push(`router.models.include references unknown model ${JSON.stringify(name)}.`);
	const excluded = new Set(exclude ?? []);
	for (const name of excluded) if (!definitions.has(name)) errors.push(`router.models.exclude references unknown model ${JSON.stringify(name)}.`);
	const ordinaryNames = [...initial, ...addedNames].filter((name, index, all) => all.indexOf(name) === index && !excluded.has(name));
	const compressorValue = router && own(router, "compressor") ? read(router, "compressor", errors, "router") : undefined;
	let compressor = SHIPPED_COMPRESSOR_MODELS.map((item) => ({ ...item }));
	if (compressorValue !== undefined) {
		const compressorObject = record(compressorValue);
		if (!compressorObject) errors.push("router.compressor must be an object.");
		else {
			for (const key of keys(compressorObject, "router.compressor", errors)) if (key !== "models") errors.push(`router.compressor has unknown field ${JSON.stringify(key)}.`);
			if (own(compressorObject, "models")) {
				const rawEntries = read(compressorObject, "models", errors, "router.compressor");
				const entries = objectArray(rawEntries, "router.compressor.models", errors);
				compressor = [];
				for (let index = 0; index < (entries?.length ?? 0); index++) {
					const entry = entries![index]!;
					for (const key of keys(entry, `router.compressor.models[${index}]`, errors)) if (key !== "model" && key !== "effort") errors.push(`router.compressor.models[${index}] has unknown field ${JSON.stringify(key)}.`);
					const model = read(entry, "model", errors, `router.compressor.models[${index}]`);
					const selectedEffort = read(entry, "effort", errors, `router.compressor.models[${index}]`);
					if (typeof model !== "string" || !definitions.has(model)) errors.push(`router.compressor.models[${index}] references unknown model ${JSON.stringify(model)}.`);
					if (!effort(selectedEffort)) errors.push(`router.compressor.models[${index}].effort must be one of: ${LOGICAL_MODEL_EFFORTS.join(", ")}.`);
					if (typeof model === "string" && definitions.has(model) && effort(selectedEffort)) compressor.push({ model, effort: selectedEffort });
				}
				if (Array.isArray(rawEntries) && rawEntries.length === 0) errors.push("router.compressor.models must not be empty. No hidden compressor fallback is approved.");
			}
		}
	}
	if (compressor.length === 0 && !errors.some((message) => message.includes("compressor.models must not be empty"))) errors.push("No usable compressor entry remains.");
	if (errors.length > 0) return deepFreeze({ errors, warnings });
	const ordinary = ordinaryNames.map((name) => cloneDefinition(definitions.get(name)!));
	const definitionObject = Object.create(null) as Record<string, LogicalModelDefinition>;
	for (const [name, item] of definitions) definitionObject[name] = cloneDefinition(item);
	return deepFreeze({ policy: { definitions: definitionObject, ordinary, compressor }, errors, warnings });
}
