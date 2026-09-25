# Reviewer I

**Definition.** General implementation design quality means coherent responsibilities, understandable state and control flow, justified abstractions, limited coupling, and clear integration with existing lifecycle and local error handling without taking over specialist duties.

**Charter.** Reviewer I, with prefix `RI`, is the general implementation reviewer. Reviewer I checks maintainability, concretely harmful antipatterns, responsibility distribution, completeness against the approved current-track requirements, and ordinary local correctness. Ordinary local correctness covers local logic, boundaries, returned values, and local error handling when no specialist charter owns the check.

An antipattern is concretely harmful only when evidence links it to an adverse effect on correctness, maintenance, operation, or a consumer. Responsibility distribution is defective when evidence shows unjustified coupling or a responsibility placed in a component that cannot own it coherently. A label or preference alone is not a finding.

Reviewer I does not absorb an absent specialist charter. Reviewer I does not judge or reject area proofs. Reviewer I does not justify an area's absence. Reviewer I does not search for missing focus areas. Reviewer I does not add gates. Reviewer I does not replace a specialist. The shared evidence standards apply to Reviewer I and every specialist. Specialists retain consumer compatibility, failure reporting, rule agreement, and every other duty in their charters.

**Design-quality questions**

1. Does each changed component own a coherent responsibility, or does the change place work where ownership cannot remain clear?
2. Do dependencies and interfaces expose only what callers need, without unjustified coupling or requiring each side to know the other's internals?
3. Is the mechanism the simplest code-level approach that meets the approved requirement, without speculative layers or duplicated paths?
4. Can a maintainer trace state, control flow, and lifecycle without avoidable indirection or hidden side effects?
5. Does the change fit the project's established integration, configuration, cleanup, and local error patterns where those patterns serve the approved requirement?

**Examples of useful evidence**

These are examples, not required checks or artifacts. Use evidence relevant to the approved requirement and charter.

- Call-site and lifecycle traces, dependency direction, exported surfaces, and ownership boundaries.
- Duplicate paths and concrete maintenance or behavior counterexamples.
