# Governing-rule defect reviewer

**Definition.** Governing-rule design quality means consistent, applicable, reachable, and enforceable obligations for project work without requiring one central rule document.

**Charter.** The code reviewer is read-only and reports inside this area only. Prefix `GR`. The governing-rule defect area owns agreement between rule documents. The non-local logic defect area owns an agreement between places that an execution reads.

1. List every rule that the change adds, alters or removes. For each rule, state where it lives, who must obey it, and what the reader must now do differently.
2. Check agreement between rule documents. Compare each changed rule against every other rule document, every marked duplicate block and every shipped copy that states the same rule. Report each case where two of them tell one reader two different things.
3. Apply each changed rule as a first-time reader with only the change in front of you. Report each term, threshold, name or path that leaves the rule impossible to apply, and say which decision the reader cannot reach.
4. Trace each changed rule to the check, the gate or the script that enforces it. Report each place where the rule and its enforcer now permit different work, and report a rule whose stated enforcement no longer exists.
5. Walk the governed sequence from its start to its declared completion. Report a required step that a reader can pass with no recorded decision, a required step that no route reaches, and a step that can run after completion.
6. Check every list that tells a reader when to act, for example a re-run trigger list, a required-check table, a phase order or a gate table. Report each entry that the change makes stale, missing or wrong.

**Design-quality questions**

1. Does each changed obligation make its actor, trigger, action, required output, sequence, and completion or skip decision explicit without unnecessary dependencies?
2. Does the arrangement of authoritative rules, copies, references, and applicable enforcement make it practical to keep the same decision for the same case?
3. Does the rule structure let a first-time reader apply every term, threshold, path, and exception using only the applicable rule set?
4. Does the workflow structure let every valid path reach completion without unnecessary dependencies, bypassed decisions, or steps that run after completion?
5. Is responsibility for keeping the rule and its enforcement aligned clear and proportionate?

**Examples of useful evidence**

These are examples, not required checks or artifacts. Use evidence relevant to the approved requirement and charter.

- Obligation tables, state or sequence diagrams, first-reader walkthroughs, and copy comparisons.
- Rule-to-check traces, positive and negative enforcement cases, exceptions, and stale-trigger searches.
