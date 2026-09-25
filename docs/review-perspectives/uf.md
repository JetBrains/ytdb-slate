# Unreported failure reviewer

**Definition.** Unreported-failure design quality means clear reporting responsibility and maintainable paths that give each in-scope product failure an observable signal.

**Charter.** The code reviewer is read-only. It reports inside this area only. Prefix `UF`.

1. Enumerate every in-scope failure mode of the changed behaviour, and name the exact signal that detects each one. Record a mode with no signal as a defect.
2. For each failure mode, name the place that owes the report and the observable form of that report, for example the exit status, the stream, the stated rejection reason, the failing check or the recorded event.
3. Check every caught error, every discarded error, every ignored return status and every empty handler on the changed paths. Report a discarded failure that produces no other signal.
4. Check every effect the change performs and does not verify, for example a write, a delete, a send or a settings update. State what proceeds when the effect fails.
5. Check every fallback, default, retry and partial result the change adds. Report a case where the substitute result is indistinguishable from success.
6. Check every report the change removes, narrows, hides or downgrades. Require evidence that the failure it reported can no longer happen.
