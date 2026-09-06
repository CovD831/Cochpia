# R-003 consumed L2 contracts

## CompanionStore — implemented for the shaped fixture; live PostgreSQL conditional

**Owner:** Companion Runtime.

**Responsibility:** load and atomically persist Core operational records for one `(tenant_id, subject_user_id)` scope, enforce unique identity pairs and reject stale snapshots with a typed retryable conflict.

**Non-responsibility:** it does not write Memory tables, derive long-term assertions or decide model content.

**Visible forms:** bounded turn state, immutable binding/commit receipts, repair/crash records. SQL rows are not passed to the model or extensions.

**Identity protocol:** `turn_admissions` stores the normalized `session_id`, `message`, `channel` and exact request `fingerprint`. Composite uniqueness covers `(tenant, subject, application_session, idempotency_key)`, `(tenant, subject, application_session, source_revision)`, `application_message_id` and `event_id`. A stale subject sequence maps to `CORE_STORAGE_CONFLICT`; a unique violation maps to the same retryable conflict and never to success.

## PostgreSQL-shaped MemoryPort — implemented for the shaped fixture; live PostgreSQL conditional

**Owner:** Memory Foundation adapter.

**Responsibility:** run the existing Memory Module operations through the PostgreSQL repository, retry only safe CAS conflicts with the original event/idempotency identity, and classify lost responses as `pending` until a receipt lookup is authoritative.

**Non-responsibility:** it does not create application turn IDs or mutate Core messages.

**Retry protocol:** a repository CAS conflict reloads the subject and replays the exact original binding key or `(event_id, source_revision)` at most `retryAttempts` times. A transport/commit-unknown error returns a `pending` receipt with `unknown=true`; it is not retried with a new identity. Receipt lookup is authoritative for restart reconciliation.

## AdmissionGate — implemented for the shaped fixture; live PostgreSQL conditional

**Owner:** Companion Runtime lifecycle coordinator.

**Responsibility:** atomically reject new admissions after close, count in-flight leases, wait for zero, and return a bounded timeout result with active work identifiers.

**Non-responsibility:** it does not cancel external work or rewrite pending records.

**Cross-process fence:** `enter` and `disable` serialize on the gate row. `disable` increments `close_epoch` while setting `enabled=false`; active leases retain the prior epoch and are drained or returned as a bounded timeout. A new lease cannot be inserted after the close transaction commits.

## Repair/Crash recorder — implemented for the shaped fixture; live PostgreSQL conditional

**Owner:** Companion Runtime operations.

**Responsibility:** append content-free, subject-bound records for reconciliation attempts, drain timeouts and process crashes; records are append-only, operator-scoped and may retain opaque receipt/commit proof IDs without retaining content.

**Deterministic identity/state:** `repair_attempt_id` is stable for `(turn, operation, attempt, close_epoch)` and `crash_record_id` is stable for the observed process/turn operation. Duplicate recorder calls are idempotent inserts. States are `pending → processing → pending|completed|failed|dead_letter`; an exhausted attempt is never silently promoted to completed. Direct `record`/`transition` calls cannot create a completed repair: only `reconcile` may complete it after an authoritative receipt lookup and an authoritative completed Core commit lookup that both match the original turn identity. Receipt and Core commit identities are persisted with the completion evidence.

**Failure:** inability to record an operator safety fact blocks a claimed successful repair and is surfaced as an operational failure. The AdmissionGate must be constructed with the durable recorder instance produced by this boundary; a no-op or unbound recorder is rejected, and every timeout record must return a repair identity before the gate reports `timed_out`.

All four boundaries use commands, bounded views or receipts; no generic event bus is introduced by this increment.

## Live Auth/TLS and context-spoofing promotion gate

R-003 does not close the production security gate. L-01 must run with `AUTH_MODE=required`, `STORAGE_PROVIDER=postgres`, verified database TLS (`rejectUnauthorized=true` with a configured CA or equivalent verify-full mode), content-free logs and a negative context-spoofing test before promotion.
