# R-003 positioning and delivery horizon

## User problem

R-002 proves the Memory-first turn semantics only inside one process. Its arrays and process-local lock cannot establish uniqueness or recovery when two workers share PostgreSQL, and its feature flag has no durable drain/crash repair boundary.

## Deliver

One production-shaped persistence boundary that keeps Core operational facts relational and subject-scoped, reuses Memory's existing PostgreSQL repository, exposes typed conflict/unknown outcomes, and provides a lifecycle gate plus repair record for interrupted turns. The gate is a database fence: a close epoch is advanced while holding the gate row lock, and every new lease is admitted only after checking that locked row.

## Defer

- live traffic cutover and UI migration;
- real provider streaming and client resume;
- a general event bus or projection scheduler;
- deletion/export propagation and the independent Memory service;
- performance or availability claims beyond SQL-shape and deterministic fixture evidence.

The slice also defers enabling the new store in `server/index.js`; the executable target is an isolated adapter/fixture until compatibility and live-environment gates pass.

## Advancement trigger

The package may advance to live-environment acceptance only after:

1. all relational uniqueness and CAS tests pass;
2. the same R-002 target/failure fixtures run through the PostgreSQL-shaped MemoryPort;
3. a two-worker conflict fixture proves one winner and safe replay;
4. gate close/drain timeout and crash repair records are observable;
5. no legacy or independent Memory writer is enabled by this package.

The compatibility check additionally records that the legacy `/api/chat/stream`, JSON/JSONB state store and independent `/v1` service remain unchanged and are not silently treated as target writers.

## Stop rule

Keep R-002 as the active target if PostgreSQL persistence requires a second canonical Core state, if a failed CAS is surfaced as a completed turn, or if lifecycle shutdown can race with a new admission.

## Complexity traceability

Each new mechanism has a named consumer: the relational Core tables prove P-01 through P-03/P-08, the MemoryPort retry loop proves P-04/P-05, the admission gate proves P-06, and the repair recorder proves P-07. No generic bus, scheduler, cache or plugin registry is introduced by R-003.
