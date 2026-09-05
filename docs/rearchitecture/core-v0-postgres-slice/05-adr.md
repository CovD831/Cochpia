# R-003 implementation decisions

## ADR-003-01: relational Core operational records are separate from Memory facts

**Decision:** store turn admissions, bindings, assistant commits and application messages in dedicated PostgreSQL tables. Store only opaque Memory IDs/receipts in Core records.

**Reason:** Core and Memory have different owners; a JSONB aggregate cannot provide the required uniqueness and cross-process conflict semantics.

**Alternative rejected:** make the Core service read/write `MemoryModule.state` or duplicate Memory assertions in the application table.

## ADR-003-02: subject-scoped optimistic concurrency before destructive replacement

**Decision:** each loaded subject snapshot carries a database persistence sequence. A save locks the subject sequence, rejects a changed base sequence, advances the persistence sequence even for status-only updates, and only then replaces the subject's Core rows in one transaction. The Core turn `sequenceNo` allocator remains a separate field.

**Consequence:** a worker must reload and replay the original idempotency key after a conflict. It may not merge unknown external effects by inventing new IDs.

## ADR-003-03: lifecycle close is a gate, not cancellation

**Decision:** disabling Core closes admission synchronously, drains existing leases within a bound and records timeout work; it does not cancel a provider/Memory call or delete data.

**Consequence:** the legacy path can remain available while pending turns are repaired. Full traffic cutover still requires a live rollback drill.

## ADR-003-04: durable close epoch and database lease fence

**Decision:** use one `core_v0_admission_gates` row as the cross-process close point. Admission locks that row, checks `enabled`, inserts a lease with the observed `close_epoch`, and commits. Disable locks the same row, increments the epoch and commits `enabled=false` before draining prior leases.

**Alternative rejected:** process-local `CORE_V0_ENABLED` checks or a best-effort in-memory counter; either can admit a new turn in another worker after the operator believes the close completed.

## ADR-003-05: deterministic repair identity is append-only

**Decision:** repair attempts use a stable `repair_attempt_id` derived from the original turn/operation/attempt/close epoch, and crash observations use a stable process/operation identity. Inserts are idempotent and contain status/error/lease metadata only.

**Consequence:** a restart can distinguish a repeated recorder call from a new attempt, and `pending`/`dead_letter` remain visible without guessing an external outcome.

## ADR-003-06: bounded R-003 mechanisms only

**Decision:** implement exactly the CompanionStore, MemoryPort, AdmissionGate and RepairRecorder consumed by P-01 through P-08. Keep the route, UI, legacy JSON/JSONB writer, independent Memory service and general event bus unchanged.

**Smallest alternative considered:** keep the local store and add only a PostgreSQL health check. It cannot prove cross-process uniqueness, CAS loss or a race-free close, so it is insufficient for this increment.
