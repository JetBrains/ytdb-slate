import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyDispatchOutcome,
	decideDispatchDelivery,
	isDispatchTicket,
	mintDispatchTicket,
	parseDispatchTicket,
	transitionDispatchState,
	type DispatchRegistryEvent,
	type DispatchRegistryState,
} from "../extension/dispatch-plan.ts";

test("dispatch tickets use only d<N> and mint from the persisted high-water mark", () => {
	for (const ticket of ["d1", "d7", `d${Number.MAX_SAFE_INTEGER}`]) {
		assert.equal(isDispatchTicket(ticket), true, ticket);
		assert.equal(parseDispatchTicket(ticket), ticket);
	}
	for (const invalid of [undefined, null, 1, "", "d0", "d01", "d-1", "d1 ", " d1", "D1", "t1.e1", "t1#3", `d${Number.MAX_SAFE_INTEGER + 1}`]) {
		assert.equal(isDispatchTicket(invalid), false, String(invalid));
		assert.equal(parseDispatchTicket(invalid), undefined);
	}

	assert.deepEqual(mintDispatchTicket(0), { ticket: "d1", sequence: 1 });
	// Persistence canary: restoring 41 must continue at 42, never silently reset to d1.
	assert.deepEqual(mintDispatchTicket(41), { ticket: "d42", sequence: 42 });
	for (const invalid of [undefined, null, "41", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
		assert.throws(() => mintDispatchTicket(invalid), /dispatchSeq|sequence is exhausted/);
	}
});

test("dispatch registry permits exactly its four declared edges and refuses every other transition", () => {
	const states: DispatchRegistryState[] = ["pending", "settled", "joined", "abandoned"];
	const events: DispatchRegistryEvent[] = ["settle", "join", "abandon"];
	const allowed = new Map<string, DispatchRegistryState>([
		["pending:settle", "settled"],
		["pending:abandon", "abandoned"],
		["settled:join", "joined"],
		["settled:abandon", "abandoned"],
	]);

	for (const state of states) {
		for (const event of events) {
			const expected = allowed.get(`${state}:${event}`);
			if (expected) assert.equal(transitionDispatchState(state, event), expected);
			else assert.throws(() => transitionDispatchState(state, event), /illegal dispatch registry transition/);
		}
	}
});

test("dispatch outcome classification distinguishes clean, failed, rejected and explicitly aborted work", () => {
	const clean = { episode: { status: "ok" as const }, report: "task says it could not complete" };
	const failed = { episode: { status: "failed" as const }, report: "provider stopped" };
	const rejection = new Error("prelude failed");

	assert.deepEqual(classifyDispatchOutcome({ status: "fulfilled", value: clean }, false), { kind: "ok", value: clean });
	assert.deepEqual(classifyDispatchOutcome({ status: "fulfilled", value: failed }, false), { kind: "failed", value: failed });
	assert.deepEqual(classifyDispatchOutcome({ status: "rejected", reason: rejection }, false), { kind: "rejected", reason: rejection });
	assert.deepEqual(classifyDispatchOutcome({ status: "fulfilled", value: clean }, true), { kind: "aborted" });
	assert.deepEqual(classifyDispatchOutcome({ status: "rejected", reason: rejection }, true), { kind: "aborted", reason: rejection });
	// I20: the worker's clean stop remains mechanically "ok" even when its prose reports task failure.
	assert.equal(classifyDispatchOutcome({ status: "fulfilled", value: clean }, false).kind, "ok");
});

test("delivery is per-run idempotent, re-armable, abort-gated, non-empty and followUp-only", () => {
	const run1 = {};
	const run2 = {};
	assert.deepEqual(decideDispatchDelivery({ aborted: false, settledCount: 2, runIdentity: run1 }), {
		kind: "deliver",
		mode: "followUp",
	});
	assert.deepEqual(decideDispatchDelivery({ aborted: false, settledCount: 2, runIdentity: run1, alreadyJoined: run1 }), {
		kind: "skip",
		reason: "already-joined",
	});
	assert.deepEqual(decideDispatchDelivery({ aborted: false, settledCount: 2, runIdentity: run2, alreadyJoined: run1 }), {
		kind: "deliver",
		mode: "followUp",
	});
	assert.deepEqual(decideDispatchDelivery({ aborted: true, settledCount: 2, runIdentity: run2 }), {
		kind: "skip",
		reason: "aborted",
	});
	for (const settledCount of [0, -1, 1.5, NaN, Infinity]) {
		assert.deepEqual(decideDispatchDelivery({ aborted: false, settledCount, runIdentity: run2 }), {
			kind: "skip",
			reason: "empty",
		});
	}
});
