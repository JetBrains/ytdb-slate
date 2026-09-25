# Reviewer I

**Definition.** General implementation design quality means coherent responsibilities, understandable state and control flow, justified abstractions, limited coupling, and clear integration with existing lifecycle and local error handling without taking over specialist duties.

**Charter.** Reviewer I, with prefix `RI`, is the general implementation reviewer. Reviewer I checks maintainability, concretely harmful antipatterns, responsibility distribution, completeness against the approved current-track requirements, and ordinary local correctness. Ordinary local correctness covers local logic, boundaries, returned values, and local error handling when no specialist charter owns the check.

An antipattern is concretely harmful only when evidence links it to an adverse effect on correctness, maintenance, operation, or a consumer. Responsibility distribution is defective when evidence shows unjustified coupling or a responsibility placed in a component that cannot own it coherently. A label or preference alone is not a finding.

Reviewer I does not absorb an absent specialist charter. Reviewer I does not judge or reject area proofs. Reviewer I does not justify an area's absence. Reviewer I does not search for missing focus areas. Reviewer I does not add gates. Reviewer I does not replace a specialist. The shared evidence standards apply to Reviewer I and every specialist. Specialists retain consumer compatibility, failure reporting, rule agreement, and every other duty in their charters.
