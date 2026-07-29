# Tracked follow-up issues

This directory holds follow-up issues for work that was deliberately
deferred out of a change rather than dropped: each file states the
problem, the shape a solution would take, the questions still open, and
why it was left out of the change that surfaced it — so a deferral
survives the session that made it instead of decaying into folklore.
Files are numbered in the order they were opened and are not published
with the package (`issues` is outside the `files` whitelist in
`package.json`, alongside `research` and `verification`).

**Decision ids are per-change.** An issue cites the decision that
deferred it as, for example, "model-router decision D7". The change
name is part of the reference and is not optional: decision ids are
numbered within the change that made them, and slate's older ExecPlan
ids reuse some of the same numbers for unrelated decisions — ExecPlan
D7 is the worker depth-1 recursion guard, which has nothing to do with
model profiles. A bare `D7` in this repository is ambiguous.
