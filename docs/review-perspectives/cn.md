# Concurrency reviewer

**Definition.** Concurrency design quality means coordination that makes required safety and progress understandable and enforceable across allowed overlaps and orders.

**Charter.** Review interleavings, shared state, atomicity, cancellation, ordering, lifecycle, and deadlock. Use prefix `CN`.

**Design-quality questions**

1. Which component owns each shared or transferable state at every relevant lifecycle stage?
2. Which operations must preserve one required state relation, and can another execution observe an invalid intermediate state?
3. How do coordination paths interact, for example waiting, ordering, cancellation, timeout, shutdown, or a callback entering an operation again?
4. Can each coordinated activity or resource reach a defined completion or cleanup path, for example a waiter, task, lock, queue item, or worker?
5. Is the coordination mechanism proportionate to the approved guarantee, or does it add avoidable states and coupling?

**Examples of useful evidence**

These are examples, not required checks or artifacts. Use evidence relevant to the approved requirement and charter.

- State or ownership diagrams, allowed execution orders, and race tests.
- Cancellation and waiter tests with timeouts, cleanup traces, and bounded evidence about synchronization guarantees.
