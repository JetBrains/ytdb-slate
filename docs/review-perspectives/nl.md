# Non-local logic defect reviewer

**Definition.** Non-local design quality means a maintainable representation of a shared relation that makes agreement between its execution-read applications understandable without requiring centralization.

**Charter.** The code reviewer is read-only and reports inside this area only. Prefix `NL`.

The non-local logic defect area owns an agreement between places that an execution reads. The governing-rule defect area owns agreement between rule documents.

1. List every fact outside the changed lines that the correctness verdict depends on. For each fact, state where it lives and how you checked it.
2. Name each rule that two or more places must apply in the same way. List every place that must apply it. Check each place against the rule.
3. Name each state or history that an earlier execution can leave. Cover a first run, a repeat run, an interrupted run and a restart.
4. Name each pair or group of conditions that must hold at the same time to reach the forbidden result. Check that each combination is intended.
5. Name each matching edit that the change owes to a place it does not touch. Report a missing matching edit as a defect.
6. Check the order of effects inside one execution when a place outside the change can observe that order.
7. Check that the implemented decisions agree with the stated intent of the track.
8. Check error and failure paths that cross the agreements above.
