/** Action-local reservations and call settlement for one parent session. */
import type { SlateStore } from "./state.ts";
import { buildRecordAssignment, type RecordAssignment } from "./record-names.ts";

export interface RecordLease {
	readonly assignment: RecordAssignment;
	readonly sourceFolder?: string;
	check(): void;
	call<T>(operation: () => Promise<T>): Promise<T>;
	close(): void;
	settle(): Promise<void>;
	release(): void;
}

export class RecordOwnership {
	private admission = true;
	private leases = new Set<RecordLease>();
	private names = new Set<string>();
	private readonly store: Pick<SlateStore, "currentChange" | "sourceChange">;
	constructor(store: Pick<SlateStore, "currentChange" | "sourceChange">) { this.store = store; }
	reserve(assignment: RecordAssignment): RecordLease {
		if (!this.admission) throw new Error("Record admission is closed. Wait for ownership transfer to finish.");
		const sourceFolder = this.store.sourceChange;
		const validated = buildRecordAssignment(assignment.writerRole === "implementer"
			? { type: "implementer", trackNumber: assignment.names[0]?.slice(6, -22) }
			: { type: "general", records: [...assignment.names] }, this.store.currentChange, sourceFolder);
		if (!validated || validated.writerRole !== assignment.writerRole || validated.currentFolder !== assignment.currentFolder ||
			JSON.stringify(validated.names) !== JSON.stringify(assignment.names)) throw new Error("The record assignment no longer matches the open change. Dispatch again with current facts.");
		const keys = validated.names.map((name) => `${validated.currentFolder}/${name}`);
		if (keys.some((name) => this.names.has(name))) throw new Error("A record already has an admitted writer. Wait for that action to settle before dispatching another writer.");
		for (const key of keys) this.names.add(key);
		let open = true;
		let released = false;
		let tail = Promise.resolve();
		const check = () => {
			if (!open || !this.admission || this.store.sourceChange !== sourceFolder ||
				`slate-changes/${this.store.currentChange}` !== validated.currentFolder) throw new Error("Record admission ended or change ownership moved. Inspect the current record before dispatching again.");
		};
		const lease: RecordLease = {
			assignment: validated, sourceFolder, check,
			call: <T>(operation: () => Promise<T>): Promise<T> => {
				const pending = tail.then(() => { check(); return operation(); });
				tail = pending.then(() => undefined, () => undefined);
				return pending;
			},
			close() { open = false; },
			settle: () => tail,
			release: () => {
				if (released) return;
				released = true;
				open = false;
				this.leases.delete(lease);
				for (const key of keys) this.names.delete(key);
			},
		};
		this.leases.add(lease);
		return lease;
	}
	/** Refuse a change action while an admitted writer can still start a call. */
	change<T>(operation: () => T): T {
		if (!this.admission || this.leases.size > 0) throw new Error("Change ownership is busy with record writers. Wait for their thread results before starting or closing a change.");
		this.admission = false;
		try { return operation(); } finally { this.admission = true; }
	}
	stop(): void { this.admission = false; for (const lease of this.leases) lease.close(); }
	async settle(): Promise<void> { await Promise.all([...this.leases].map((lease) => lease.settle())); }
	resume(): void { this.admission = true; }
}
const owners = new WeakMap<SlateStore, RecordOwnership>();
export function recordOwnership(store: SlateStore): RecordOwnership {
	let owner = owners.get(store);
	if (!owner) { owner = new RecordOwnership(store); owners.set(store, owner); }
	return owner;
}
