export const DEFAULT_MAX_CONCURRENT = 8;

export function sanitizeMaxConcurrent(
	value: unknown,
	warn: (message: string) => void = console.warn,
): number {
	if (value === undefined) return DEFAULT_MAX_CONCURRENT;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	warn("slate: maxConcurrent must be a positive safe integer. Using 8.");
	return DEFAULT_MAX_CONCURRENT;
}

const limitKey = Symbol.for("ytdb-slate.codemode-limit.v1");
type LimitRecord = { lastWritten?: string };

/** Commit the validated process default without yielding before manager publication. */
export function commitCodemodeLimit(limit: number): void {
	const shared = globalThis as typeof globalThis & { [limitKey]?: LimitRecord };
	const record = shared[limitKey] ??= {};
	const current = process.env.PI_CODEMODE_MAX_WORKERS;
	if (current !== undefined && current !== record.lastWritten) {
		delete record.lastWritten;
		return;
	}
	const next = String(limit);
	process.env.PI_CODEMODE_MAX_WORKERS = next;
	record.lastWritten = next;
}
