import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkerNestedLifecycle, NESTED_SETTLEMENT_WARNING_MS, WORKER_NESTED_CLOSED_REASON } from "../extension/worker-nested-lifecycle.ts";

function fixture() {
  const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
  const warnings: string[] = [];
  const lifecycle = createWorkerNestedLifecycle(message => warnings.push(message));
  lifecycle.extension({ on(name: string, handler: (event: Record<string, unknown>) => unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  const emit = (type: string, toolCallId = 'same', parentToolCallId: unknown = '', toolName = 'held') =>
    handlers.get(type)!({ type, toolCallId, parentToolCallId, toolName });
  return { lifecycle, emit, warnings };
}

test('nested counters retain multiplicity and ignore unmatched and top-level ends', { timeout: 1000 }, async () => {
  const { lifecycle, emit, warnings } = fixture();
  emit('tool_execution_start'); emit('tool_call');
  emit('tool_execution_start'); emit('tool_call');
  emit('tool_execution_start', 'other'); emit('tool_call', 'other');
  lifecycle.close();
  assert.deepEqual(emit('tool_call'), { block: true, reason: WORKER_NESTED_CLOSED_REASON });
  emit('tool_execution_start');
  emit('tool_execution_end'); // Rejected repeated identifier consumes U, not A.
  emit('tool_execution_end', 'unknown');
  emit('tool_execution_end', 'same', null);
  emit('tool_execution_start', 'top', null);
  let joined = false;
  const join = lifecycle.join().then(() => { joined = true; });
  emit('tool_execution_end');
  await Promise.resolve();
  assert.equal(joined, false, 'one remaining call with the same id is still owned');
  emit('tool_execution_end');
  await Promise.resolve();
  assert.equal(joined, false, 'another identifier is still owned');
  emit('tool_execution_end', 'other');
  await join;
  assert.equal(joined, true);
  assert.deepEqual(warnings, []);
});

test('nested diagnostics use live admitted counts once and sanitize names without arguments', { timeout: 1000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { lifecycle, emit, warnings } = fixture();
  emit('tool_call', 'top');
  emit('tool_execution_start', 'x\nforged', '', 'tool\u001b[31m');
  emit('tool_call', 'x\nforged');
  emit('tool_execution_start', 'x\nforged', '', 'tool\u001b[31m');
  emit('tool_call', 'x\nforged');
  emit('tool_execution_start', 'unadmitted');
  lifecycle.close(); lifecycle.startWarning();
  t.mock.timers.tick(NESTED_SETTLEMENT_WARNING_MS - 1);
  assert.deepEqual(warnings, []);
  t.mock.timers.tick(1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /has not reported its end.*count 2/);
  assert.doesNotMatch(warnings[0]!, /\n|\u001b|unadmitted/);
  t.mock.timers.tick(NESTED_SETTLEMENT_WARNING_MS);
  assert.equal(warnings.length, 1);
  emit('tool_execution_end', 'x\nforged'); emit('tool_execution_end', 'x\nforged');
  await lifecycle.join(); lifecycle.clearWarning();
});

test('unadmitted calls do not delay join or produce a warning', { timeout: 1000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { lifecycle, emit, warnings } = fixture();
  emit('tool_execution_start');
  lifecycle.close(); lifecycle.startWarning();
  await lifecycle.join();
  t.mock.timers.tick(NESTED_SETTLEMENT_WARNING_MS);
  assert.deepEqual(warnings, []);
  emit('tool_execution_end'); lifecycle.clearWarning();
});
