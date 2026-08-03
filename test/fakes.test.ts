// =============================================================================
// slate — smoke tests for the Track 01 shared test fakes (test/fakes.ts)
// =============================================================================
// These are not Track 01 behaviour tests: they are the "the fake actually
// works" assertion A0 owes, so a later action's "the handler never fired"
// failure can be trusted to mean the code under test, not a fake that
// silently captured nothing.
// =============================================================================
import assert from "node:assert/strict";
import test from "node:test";
import {
	createFakeExtensionAPI,
	createFakeExtensionContext,
	createFakeWorkerSession,
} from "./fakes.ts";

test("createFakeExtensionAPI.handler throws before anything registers, and captures a handler pi.on receives", () => {
	const fake = createFakeExtensionAPI();

	// The smoke assertion: an unregistered event must fail loudly, not return
	// undefined a caller could mistake for "handler ran and did nothing".
	assert.throws(() => fake.handler("agent_end"), /no handler registered for "agent_end"/);

	const seen: unknown[][] = [];
	fake.api.on("agent_end", (event, ctx) => {
		seen.push([event, ctx]);
	});

	const captured = fake.handler<(event: unknown, ctx: unknown) => void>("agent_end");
	captured("EVENT", "CTX");

	// Proves the captured function is the SAME one pi.on received, not a stub:
	// invoking it through the fake's lookup produced the side effect the real
	// handler was written to produce.
	assert.deepEqual(seen, [["EVENT", "CTX"]]);
});

test("createFakeExtensionAPI preserves multiple handlers for one event in registration order", () => {
	const fake = createFakeExtensionAPI();
	const seen: string[] = [];
	fake.api.on("agent_end", () => {
		seen.push("first");
	});
	fake.api.on("agent_end", () => {
		seen.push("second");
	});

	const captured = fake.handlersFor<() => void>("agent_end");
	assert.equal(captured.length, 2);
	for (const handler of captured) handler();
	assert.deepEqual(seen, ["first", "second"]);
	assert.throws(
		() => fake.handler("agent_end"),
		/expected exactly one handler for "agent_end", found 2; use handlersFor/,
	);
});

test("createFakeExtensionAPI records sendMessage and appendEntry calls, interleaved, in observed order", () => {
	const fake = createFakeExtensionAPI();

	fake.api.appendEntry("a", { n: 1 });
	fake.api.sendMessage({ customType: "b", content: "x", display: true }, { deliverAs: "nextTurn" });
	fake.api.appendEntry("c", { n: 2 });
	fake.api.sendMessage({ customType: "d", content: "y", display: false }, { deliverAs: "steer", triggerTurn: true });

	// Order across BOTH kinds, not just per-kind counts — the distinction the
	// invariant table requires (I8's "invoked twice ⇒ one delivery" needs order,
	// a count alone cannot tell two single-call runs from one two-call run).
	assert.deepEqual(
		fake.calls.map((call) => call.kind),
		["appendEntry", "sendMessage", "appendEntry", "sendMessage"],
	);
	assert.deepEqual(
		fake.calls.map((call) => call.seq),
		[0, 1, 2, 3],
	);
	// Pin arguments at each position too. Checking only the kind sequence would
	// miss a recorder that swapped two calls of the same kind.
	assert.deepEqual(
		fake.calls.map((call) =>
			call.kind === "appendEntry"
				? `${call.kind}:${call.customType}`
				: `${call.kind}:${call.message.customType}`,
		),
		["appendEntry:a", "sendMessage:b", "appendEntry:c", "sendMessage:d"],
	);

	assert.equal(fake.appendEntryCalls.length, 2);
	assert.deepEqual(
		fake.appendEntryCalls.map((call) => call.customType),
		["a", "c"],
	);
	assert.equal(fake.sendMessageCalls.length, 2);
	assert.equal(fake.sendMessageCalls[0]?.options?.deliverAs, "nextTurn");
	assert.equal(fake.sendMessageCalls[1]?.options?.triggerTurn, true);
});

type TestSnapshot<T> =
	| { status: "captured"; value: T }
	| { status: "unavailable"; reason: string };

function captured<T>(snapshot: TestSnapshot<T>): T {
	assert.equal(snapshot.status, "captured", snapshot.status === "unavailable" ? snapshot.reason : undefined);
	return snapshot.value;
}

test("createFakeExtensionAPI preserves Error subclass and argument identity", () => {
	class BilledOutcomeUnknown extends Error {}
	const fake = createFakeExtensionAPI();
	const reason = new BilledOutcomeUnknown("worker was abandoned in flight");
	const message = { customType: "joined", content: "result", display: true, details: { reason } };

	fake.api.sendMessage(message);

	const call = fake.sendMessageCalls[0] as unknown as {
		message: typeof message;
		messageSnapshot: TestSnapshot<typeof message>;
	};
	assert.strictEqual(call.message, message);
	assert.strictEqual(call.message.details.reason, reason);
	assert.equal(call.message.details.reason instanceof BilledOutcomeUnknown, true);
	assert.equal(call.messageSnapshot.status, "unavailable");
	assert.match(
		call.messageSnapshot.status === "unavailable" ? call.messageSnapshot.reason : "",
		/lose prototype or property fidelity/,
	);
});

test("createFakeExtensionAPI records function and symbol payloads without throwing and exposes snapshot degradation", () => {
	const fake = createFakeExtensionAPI();
	const marker = Symbol("marker");
	const callback = () => "called";
	const data = { callback, marker };

	assert.doesNotThrow(() => fake.api.appendEntry("edge", data));

	const call = fake.appendEntryCalls[0] as unknown as {
		data: typeof data;
		dataSnapshot: TestSnapshot<typeof data>;
	};
	assert.strictEqual(call.data, data);
	assert.strictEqual(call.data.callback, callback);
	assert.strictEqual(call.data.marker, marker);
	assert.equal(call.dataSnapshot.status, "unavailable");
	assert.match(call.dataSnapshot.status === "unavailable" ? call.dataSnapshot.reason : "", /not structured-cloneable/);
});

test("createFakeExtensionAPI preserves argument identity and snapshots call-time values against later mutation", () => {
	const fake = createFakeExtensionAPI();
	const message = { customType: "first", content: "one", display: true, details: { step: 1 } };
	const options: { deliverAs: "steer" | "followUp" } = { deliverAs: "steer" };
	const data = { nested: { step: 1 } };

	fake.api.sendMessage(message, options);
	fake.api.appendEntry("state", data);
	const firstMessageCall = fake.sendMessageCalls[0] as unknown as {
		message: typeof message;
		options: typeof options;
		messageSnapshot: TestSnapshot<typeof message>;
		optionsSnapshot: TestSnapshot<typeof options>;
	};
	const firstEntryCall = fake.appendEntryCalls[0] as unknown as {
		data: typeof data;
		dataSnapshot: TestSnapshot<typeof data>;
	};
	assert.strictEqual(firstMessageCall.message, message);
	assert.strictEqual(firstMessageCall.options, options);
	assert.strictEqual(firstEntryCall.data, data);

	message.customType = "second";
	message.details.step = 2;
	options.deliverAs = "followUp";
	data.nested.step = 2;
	fake.api.sendMessage(message, options);
	fake.api.appendEntry("state", data);

	assert.deepEqual(
		[
			captured(firstMessageCall.messageSnapshot),
			captured((fake.sendMessageCalls[1] as unknown as typeof firstMessageCall).messageSnapshot),
		].map((value) => ({ customType: value.customType, step: value.details.step })),
		[
			{ customType: "first", step: 1 },
			{ customType: "second", step: 2 },
		],
	);
	assert.deepEqual(
		[
			captured(firstMessageCall.optionsSnapshot),
			captured((fake.sendMessageCalls[1] as unknown as typeof firstMessageCall).optionsSnapshot),
		].map((value) => value.deliverAs),
		["steer", "followUp"],
	);
	assert.deepEqual(
		[
			captured(firstEntryCall.dataSnapshot),
			captured((fake.appendEntryCalls[1] as unknown as typeof firstEntryCall).dataSnapshot),
		],
		[{ nested: { step: 1 } }, { nested: { step: 2 } }],
	);
});

test("createFakeExtensionContext's signal starts live and flips only when the test drives it", () => {
	const fake = createFakeExtensionContext();

	assert.equal(fake.isAborted(), false);
	assert.equal(fake.ctx.signal?.aborted, false);

	fake.abort("stopped by test");

	assert.equal(fake.isAborted(), true);
	assert.equal(fake.ctx.signal?.aborted, true);
});

test("createFakeExtensionContext rejects a supplied signal instead of returning an abort() that cannot control it", () => {
	const external = new AbortController();

	assert.throws(
		() => createFakeExtensionContext({ signal: external.signal }),
		/a supplied AbortSignal is not controllable; omit signal and drive the returned abort\(\) instead/,
	);
	assert.equal(external.signal.aborted, false);
});

test("createFakeExtensionContext supports a chosen mid-flight abort point, not just start-aborted", { timeout: 1000 }, async () => {
	const fake = createFakeExtensionContext();
	const observedBeforeAwait = fake.isAborted();

	// Simulate "code under test does some async work, then checks the signal" —
	// abort happens strictly BETWEEN those two points, precisely, not at
	// construction time.
	await Promise.resolve();
	assert.equal(fake.isAborted(), false, "must still be live right before the chosen abort point");
	fake.abort();
	const observedAfterAbort = fake.isAborted();

	assert.equal(observedBeforeAwait, false);
	assert.equal(observedAfterAbort, true);
});

test("createFakeWorkerSession queues prompt() calls FIFO and settles only on explicit resolve/reject", { timeout: 1000 }, async () => {
	const fake = createFakeWorkerSession();

	const first = fake.session.prompt("first");
	const second = fake.session.prompt("second");
	assert.equal(fake.pendingPromptCount(), 2);

	fake.resolvePrompt("first-reply");
	assert.equal(await first, "first-reply");
	assert.equal(fake.pendingPromptCount(), 1);

	fake.rejectPrompt(new Error("boom"));
	await assert.rejects(second, /boom/);
	assert.equal(fake.pendingPromptCount(), 0);

	assert.deepEqual(
		fake.calls.map((call) => call.kind),
		["prompt", "prompt"],
	);
});

test("createFakeWorkerSession can leave a prompt() deliberately unsettled without hanging the test", { timeout: 1000 }, async () => {
	const fake = createFakeWorkerSession();
	const hanging = fake.session.prompt("never answered");

	// Never call resolvePrompt/rejectPrompt for this one. Prove it stays
	// pending by racing it against a short timer instead of awaiting it
	// directly — the pattern a mid-flight-abort test needs, kept inside this
	// test's own explicit timeout rather than the ambient node:test default
	// (there is none).
	const winner = await Promise.race([
		hanging.then(() => "settled" as const),
		new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
	]);

	assert.equal(winner, "timed-out");
	assert.equal(fake.pendingPromptCount(), 1);

	// Clean up so the still-pending promise cannot become an unhandled
	// rejection if something later attaches a .catch to it and this test's
	// process is still alive.
	fake.resolvePrompt("late-answer");
	await hanging;
});

test("createFakeWorkerSession preserves argument identity and snapshots call-time values", { timeout: 1000 }, async () => {
	const fake = createFakeWorkerSession();
	const prompt = { text: "first" };
	const model = { provider: "p", id: "m1", metadata: { revision: 1 } };

	const pending = fake.session.prompt(prompt as never);
	await fake.session.setModel(model as never);
	const promptCall = fake.calls[0];
	const modelCall = fake.calls[1];
	assert.equal(promptCall?.kind, "prompt");
	assert.equal(modelCall?.kind, "setModel");
	if (promptCall?.kind !== "prompt" || modelCall?.kind !== "setModel") {
		assert.fail("worker call recorder lost prompt/setModel order");
	}
	assert.strictEqual(promptCall.text, prompt);
	assert.strictEqual(modelCall.model, model);

	prompt.text = "second";
	model.metadata.revision = 2;
	assert.deepEqual(captured(promptCall.textSnapshot), { text: "first" });
	assert.deepEqual(captured(modelCall.modelSnapshot), {
		provider: "p",
		id: "m1",
		metadata: { revision: 1 },
	});

	fake.resolvePrompt();
	await pending;
});

test("createFakeWorkerSession records dispose(), setModel(), setThinkingLevel(), and delivers subscribe() events in order", async () => {
	const fake = createFakeWorkerSession({ model: { provider: "p", id: "m1" } });
	const received: string[] = [];
	fake.session.subscribe((event) => {
		received.push(`first:${event.type}`);
	});
	fake.session.subscribe((event) => {
		received.push(`second:${event.type}`);
	});

	fake.emit({ type: "message_end" });
	assert.deepEqual(received, ["first:message_end", "second:message_end"]);

	assert.equal(fake.session.model?.id, "m1");
	await fake.session.setModel({ provider: "p", id: "m2" } as never);
	assert.equal(fake.session.model?.id, "m2");

	fake.session.setThinkingLevel("high" as never);

	assert.equal(fake.disposed, false);
	fake.session.dispose();
	assert.equal(fake.disposed, true);

	assert.deepEqual(
		fake.calls.map((call) => call.kind),
		["setModel", "setThinkingLevel", "dispose"],
	);
});
