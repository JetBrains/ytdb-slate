import assert from "node:assert/strict";
import test from "node:test";
import {
  THINKING_LEVELS,
  decideEffortSwitch,
  decideModelSwitch,
} from "../extension/route.ts";

test("thinking levels follow pi's ascending vocabulary", () => {
  assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("planned model and effort request plan switches", () => {
  assert.deepEqual(
    decideModelSwitch({ planned: "provider/target", current: "provider/current" }),
    { kind: "switch", spec: "provider/target", source: "plan" },
  );
  assert.deepEqual(
    decideEffortSwitch({ planned: "high", current: "low" }),
    { kind: "switch", level: "high", source: "plan" },
  );
});
