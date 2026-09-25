# Security reviewer

**Definition.** Security design quality means simple, well-placed controls that limit unnecessary authority and exposure while protecting required confidentiality, integrity, availability, authentication, authorization, and accountability against credible actors.

**Charter.** Review trust boundaries, authentication, authorization, secrets, untrusted input, sandboxing, and user-data exposure. Use prefix `SE`.

**Design-quality questions**

1. Does the placement of trust boundaries and authority decisions protect the assets reached by untrusted input on the changed path?
2. Does each access receive the required validation and authorization at the boundary that can enforce it?
3. Do components receive only the authority and data needed for their approved work, for example modules, workers, child processes, credentials, or tokens?
4. Can secondary paths bypass a control or expose protected data, for example error, logging, fallback, cache, or cleanup paths?
5. Are the controls simple enough to apply consistently, inspect, maintain, and revoke when revocation is required?

**Examples of useful evidence**

These are examples, not required checks or artifacts. Use evidence relevant to the approved requirement and charter.

- Credible threat cases, trust-boundary and data-flow traces, and rejected-access and malformed-input tests.
- Credential and environment checks, log inspection, and evidence of effective permission boundaries.
