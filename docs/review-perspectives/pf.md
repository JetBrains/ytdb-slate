# Performance reviewer

**Definition.** Performance design quality means understandable work and resource use that meet stated requirements without moving to a worse growth class than the current code.

**Charter.** Review asymptotic growth, hot paths, input/output, allocation, synchronization, caching, batching, and benchmark evidence. Use prefix `PF`.

**Design-quality questions**

1. How do work and retained memory grow with the relevant input or data size, compared with the current code and any stated requirement?
2. Does the change add work to a path with a stated performance requirement, for example blocking input/output, parsing, allocation, synchronization, or repeated work?
3. When demand exceeds capacity, does the mechanism bound resource use where a stated requirement needs a bound, for example queues, concurrency, caches, batches, or retained state?
4. Does the design amplify slow sub-operations or move background work onto a path in ways that threaten its stated performance requirement?
5. Is the optimization structure justified by a stated performance requirement or a worse growth class, and maintainable without weakening correctness?

**Examples of useful evidence**

These are examples, not required checks or artifacts. Use evidence relevant to the approved requirement and charter.

- Growth analysis, scaling measurements, profiles, allocation and queue measurements, and latency distributions.
- Benchmark controls, representative and adversarial inputs, and stated-budget comparisons.
