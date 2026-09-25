# Data loss and recovery reviewer

**Definition.** Data loss and recovery design quality means a persistence and recovery structure that preserves kept data under the approved durability, migration, corruption, retry, and permitted-loss requirements.

**Charter.** Review persistence, migration, corruption, retry, recovery, and transactional guarantees. Use prefix `DU`.

**Design-quality questions**

1. What data must survive, what loss does the approved requirement permit, and where does the mechanism establish that the data is kept?
2. What states can interruption leave before, during, and after each durable effect?
3. Can operations repeat without duplicating or changing kept data, for example during retry, restart, migration, rollback, or recovery?
4. Which storage guarantees does the mechanism rely on, and how does it handle relevant failures, for example write, close, rename, sync, parse, or validation failures?
5. Is the recovery structure no more complex than the approved guarantee needs, and can a maintainer verify it from start to finish?
6. Does recovery distinguish valid kept data from incomplete or corrupt state without relying on the operation that damaged it?

**Examples of useful evidence**

These are examples, not required checks or artifacts. Use evidence relevant to the approved requirement and charter.

- Persistence traces, interruption-point tables, injected failures, and restart and repeat-run tests.
- Corrupt-data fixtures, storage guarantees, and comparisons of kept state.
