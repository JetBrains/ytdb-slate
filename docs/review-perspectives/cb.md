# Consumer contract break reviewer

**Definition.** Consumer-contract design quality means clear consumer boundaries and proportionate mechanisms for preserving permitted base use across declared review endpoints and stating reliance on new surfaces.

**Charter.** The code reviewer is read-only and reports inside this area only. Prefix `CB`.

1. List every consumer-reachable surface the change touches: an exported name, a command argument or option, an exit status, a machine-readable output shape, a configuration key together with the value used when that key is absent, a written or read record, and a shipped statement about accepted input or produced output.
2. For each listed surface, state what an unchanged consumer gets from the review base and what it gets from the candidate. Name the concrete invocation, configuration file or stored record that you used as the example.
3. Check every default that the change adds, moves or withdraws. Report a default whose candidate value changes the result for a consumer that set nothing in the review base.
4. Check the records the change writes or reads in both directions: a record written by the review base and read by the candidate, and a record written by the candidate and read by the review base.
5. Report every withdrawal, rename or narrowing that ships no route for the base use. State which route exists, from an accepted base form, a default, an alias, a reserved identifier, a reader for the base format or a warning window, and state whether the change shows that the route works.
6. Check that shipped documents state the same accepted input, produced output, exit statuses and defaults as the code. Report a newly published surface that ships with no statement of which parts a consumer may rely on.
