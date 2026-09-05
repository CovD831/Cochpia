# R-003 PostgreSQL-shaped Core v0 boundary

## Baseline and authority

- Package: `R-003-postgres-memoryport`
- Size: `implementation`
- Baseline revision: `410f770`
- Previous increment: [`R-002 Foundation Slice`](../core-v0-foundation-slice/06-handoff.md)
- Architecture authority: [`companion-core-foundation-plan.md`](../../companion-core-foundation-plan.md)

## Objective

Extend the proven local Core v0 turn path with a PostgreSQL-shaped durable boundary for Core operational records and MemoryPort calls. The slice targets the failure modes that the in-process implementation intentionally deferred: cross-process uniqueness, optimistic concurrency, race-free admission drain, crash recording and repair evidence.

## In scope

- Relational schema and repository for `turn_admission`, `memory_session_binding`, `assistant_commit`, application messages and repair/crash records;
- unique constraints and transactional compare-and-swap for one tenant/user subject;
- PostgreSQL-shaped MemoryPort adapter over the existing Memory repository;
- bounded retry using the original turn/event/idempotency identities;
- a database-backed admission gate with a durable close epoch, atomic lease acquisition, in-flight drain and timeout records;
- durable repair-attempt recording and a restart/reconciliation fixture;
- SQL-shape, failure, concurrency and acceptance tests.

## Out of scope

- switching production traffic or changing the existing legacy `/api/chat/stream` route;
- claiming a live PostgreSQL/Auth/TLS run when `DATABASE_URL` is unavailable;
- a general cross-domain Event Log, projection worker, real model streaming or UI migration;
- deleting, rewriting or auto-closing the existing GitHub PRs;
- cross-domain forget/delete/export propagation.

The independent Memory HTTP service remains a contract fixture. This package never makes it a second writable authority beside the PostgreSQL-shaped adapter.

## Review disposition and evidence boundary

The initial independent review found the package contract sound in direction but blocked on missing executable evidence and underspecified identity, fencing and repair details. This increment consumes those findings by freezing the row-level protocol below and adding the implementation/fixture files named in the handoff. The live database, authentication and TLS checks remain promotion evidence, not claims made by this package.

## Advancement and stop conditions

Advance only when the same Core v0 acceptance scenario passes against the shaped adapter and the lifecycle fixture proves that no new admission can cross the close point. Promote to live traffic only after a real PostgreSQL/Auth/TLS run, multi-process test and rollback drill produce artifacts.

Stop and preserve the current target path if the repository must delete-and-reinsert another process's records, if an unknown external outcome is retried with a new identity, or if a drain timeout cannot identify repairable work.
