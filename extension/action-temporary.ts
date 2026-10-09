import { lstatSync, mkdirSync, mkdtempSync, promises, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { isChangeFolder } from "./artifact-names.ts";

/** One action's directory. Checked identities stay local to this process. */
export interface ActionTemporary {
	readonly change: string;
	readonly path: string;
}
type Identity = { path: string; dev: number; ino: number };
const identities = new WeakMap<ActionTemporary, readonly Identity[]>();
const completions = new WeakMap<ActionTemporary, Promise<string | undefined>>();

function directory(path: string): Stats {
	const entry = lstatSync(path);
	if (entry.isSymbolicLink()) throw new Error(`Action temporary component is a symbolic link: ${path}`);
	if (!entry.isDirectory()) throw new Error(`Action temporary component is not a directory: ${path}`);
	if (realpathSync(path) !== path) throw new Error(`Action temporary component changed: ${path}`);
	return entry;
}
function identity(path: string): Identity {
	const entry = directory(path);
	return { path, dev: entry.dev, ino: entry.ino };
}
function recheck(chain: readonly Identity[]): void {
	for (const held of chain) {
		const current = directory(held.path);
		if (current.dev !== held.dev || current.ino !== held.ino) {
			throw new Error(`Action temporary component was replaced: ${held.path}`);
		}
	}
}
export function retainedActionTemporary(path: string, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return `Slate kept action temporary folder ${path}. Reason: ${detail}`;
}

/** Allocate without yielding between admission checks and owner registration. */
export function allocateActionTemporary(cwd: string, change: string): ActionTemporary {
	if (!isChangeFolder(change)) throw new Error("Invalid action temporary change folder name.");
	const root = realpathSync(cwd);
	const parent = join(root, "slate-changes");
	const folder = join(parent, change);
	const chain = [root, parent, folder].map(identity);
	const tmp = join(folder, "tmp");
	let createdTmp = false;
	if (lstatSync(tmp, { throwIfNoEntry: false }) === undefined) {
		try {
			mkdirSync(tmp, { mode: 0o700 });
			createdTmp = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const tmpEntry = directory(tmp);
	if (createdTmp && process.platform !== "win32" && (tmpEntry.mode & 0o077) !== 0) {
		throw new Error(retainedActionTemporary(tmp, "New temporary root is not private."));
	}
	chain.push({ path: tmp, dev: tmpEntry.dev, ino: tmpEntry.ino });
	recheck(chain);
	const path = mkdtempSync(join(tmp, "action."));
	try {
		const action = identity(path);
		if (process.platform !== "win32" && (directory(path).mode & 0o077) !== 0) {
			throw new Error("New action temporary folder is not private.");
		}
		chain.push(action);
		recheck(chain);
		const handle = Object.freeze({ change, path });
		identities.set(handle, chain);
		return handle;
	} catch (error) {
		throw new Error(retainedActionTemporary(path, error), { cause: error });
	}
}

/** Remove only the exact empty directory. Never list or remove its contents. */
export function finishActionTemporary(handle: ActionTemporary): Promise<string | undefined> {
	const previous = completions.get(handle);
	if (previous !== undefined) return previous;
	const completion = (async () => {
		try {
			const chain = identities.get(handle);
			if (chain === undefined) throw new Error("Action temporary handle is not owned by this process.");
			recheck(chain);
			await promises.rmdir(handle.path);
			return undefined;
		} catch (error) {
			return retainedActionTemporary(handle.path, error);
		}
	})();
	completions.set(handle, completion);
	return completion;
}
