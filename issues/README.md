# Tracked follow-up issues

This directory holds follow-up issues for work that was deliberately
deferred out of a change rather than dropped — so a deferral survives
the session that made it instead of decaying into folklore. Every file
answers the same four questions, in this order: **the problem**; what a
solution would look like, or what would have to change; the **open
questions** a future implementer must decide before writing anything;
and **why it was deferred**. Those four are the minimum, not the whole
file — an issue adds whatever sections it needs (001 documents the
config-key precedent it should follow, 002 argues why the gap matters
for this feature in particular), and the headings state each question in
the issue's own terms rather than repeating a fixed formula. Files are
numbered in the order they were opened and are not published with the
package (`issues` is outside the `files` whitelist in `package.json`,
alongside `research` and `verification`).

**Decision ids are per-change.** An issue cites the decision that
deferred it as, for example, "model-router decision D7". The change
name is part of the reference and is not optional: decision ids are
numbered within the change that made them, and slate's older ExecPlan
ids reuse some of the same numbers for unrelated decisions — ExecPlan
D7 is the worker depth-1 recursion guard, which has nothing to do with
model profiles. A bare `D7` in this repository is ambiguous.
