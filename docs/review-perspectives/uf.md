# Unreported failure reviewer

**Definition.** Unreported-failure design quality means clear reporting responsibility and maintainable paths that give each in-scope product failure an observable signal.

**Charter.** The code reviewer is read-only. It reports inside this area only. Prefix `UF`.

1. Enumerate every in-scope failure mode of the changed behaviour, and name the exact signal that detects each one. Record a mode with no signal as a defect.
2. For each failure mode, name the place that owes the report and the observable form of that report, for example the exit status, the stream, the stated rejection reason, the failing check or the recorded event.
3. Check every caught error, every discarded error, every ignored return status and every empty handler on the changed paths. Report a discarded failure that produces no other signal.
4. Check every effect the change performs and does not verify, for example a write, a delete, a send or a settings update. State what proceeds when the effect fails.
5. Check every fallback, default, retry and partial result the change adds. Report a case where the substitute result is indistinguishable from success.
6. Check every report the change removes, narrows, hides or downgrades. Require evidence that the failure it reported can no longer happen.

**Design-quality questions**

1. Is responsibility clear between the component that detects each product failure, the boundary that owes its report, and the caller or operator that can observe it?
2. Does the way components pass a failure signal preserve an observable report, for example through returns, wrapping, logs, records, or streams?
3. Can a fallback, retry, default, partial result, ignored status, or unchecked effect appear to be full success?
4. Is the reporting path consistent and maintainable without hidden transfers that can leave a product failure with no observable signal?
5. Does signal delivery depend on unrelated work or another fallible reporting step that can suppress the only report?

**Examples of useful evidence**

These are examples, not required checks or artifacts. Use evidence relevant to the approved requirement and charter.

- Failure-mode and signal tables, negative tests, injected effect failures, and exit and stream checks.
- Caller traces, event or log inspection, fallback tests, and discarded-status or unchecked-effect traces.
