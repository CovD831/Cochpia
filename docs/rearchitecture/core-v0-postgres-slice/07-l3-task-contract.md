# R-003 L3 task contract

## Selected vertical slice

Run the R-002 target scenario with a PostgreSQL-shaped MemoryPort and relational Core store, then inject a concurrent worker conflict and a drain timeout. The slice proves durable identity, one-winner uniqueness, safe replay, no false success and repair visibility.

## Core operational schema

The implementation adds tables equivalent to:

- `core_v0_subjects(tenant_id, subject_user_id, sequence, updated_at)`;
- `core_v0_turn_admissions` with normalized `message`, `channel`, `fingerprint`, all stable turn/event/message/commit identities, status/failure receipts, and unique `(tenant_id,subject_user_id,application_session_id,idempotency_key)`, `(tenant_id,subject_user_id,application_session_id,source_revision)`, `(tenant_id,subject_user_id,application_message_id)` and `(tenant_id,subject_user_id,event_id)`;
- `core_v0_memory_session_bindings` with unique application-session and Memory-session pairs;
- `core_v0_assistant_commits` keyed by `commit_id` and subject;
- `core_v0_messages` keyed by subject and application message ID;
- `core_v0_admission_gates` and `core_v0_admission_leases` for a durable close epoch and atomic cross-process admission fence;
- `core_v0_repair_attempts` and `core_v0_crash_records` containing stable identities, status/error codes, attempt, close epoch, lease owner and observed receipt state but no message content.

All subject IDs are server-derived. Foreign keys and `CHECK` constraints are applied before a destructive replacement transaction.

## Immutable fingerprint and conflict protocol

The stored fingerprint is the exact normalized JSON tuple `{sessionId,message,channel}` already produced by `normalizeCoreV0TurnInput`. A same-key replay must return the stored turn and its receipts; a changed tuple is `IDEMPOTENCY_KEY_CONFLICT` with HTTP 409. SQLSTATE `23505` and a stale subject sequence both map to retryable `CORE_STORAGE_CONFLICT` at the store boundary unless the loaded row proves a same-key replay or a conflicting immutable payload. During an in-flight Core operation, the service maps that CAS loss to an unknown `STORAGE_WRITE_FAILED` outcome so an already successful external Memory write remains `pending` rather than becoming false success. No conflict path creates replacement IDs.

The external Memory path uses the original `core-v0:binding:<bindingKey>` or `eventId:sourceRevision` identity. It retries only `MEMORY_STORAGE_CONFLICT` and returns `pending/unknown` for commit-uncertain transport failures.

## Durable close epoch and admission fence

`enter` performs `BEGIN → INSERT gate if absent → SELECT gate FOR UPDATE → reject disabled or INSERT active lease with the observed epoch → COMMIT`. `disable` performs the same row lock, sets `enabled=false` and `close_epoch=close_epoch+1`, commits, then waits for active leases until `drainTimeoutMs`. A timeout returns active lease/turn IDs and records each one; it does not cancel external calls. `reconcileTurn` remains allowed after close because it does not acquire a new lease.

## Deterministic repair identity and transitions

Repair identity is stable for the original turn, operation, attempt and close epoch. Recorder calls are idempotent inserts. The only allowed repair statuses are `pending`, `processing`, `completed`, `failed` and `dead_letter`; `dead_letter` requires explicit operator action. Crash records capture process/lease/turn identifiers and error code only. A recorder failure is an operational failure, never evidence of completed repair.

## Candidate interfaces

```text
createPostgresCoreV0Store({ pool, context, baseState }) → Promise<CoreV0Store>
  load(): hydrated state/store
  persist(): transactionally save the current subject snapshot or throw CORE_STORAGE_CONFLICT

createPostgresMemoryPort({ repository, context, retryAttempts }) → MemoryPort
  ensureSessionBinding({ bindingKey })
  appendRawEvent({ memorySessionId, event })
  retrieveContext({ memorySessionId, query, tokenBudget })
  getSessionBinding({ bindingKey }) / getRawEventReceipt({ eventId, sourceRevision })

createCoreV0AdmissionGate({ enabled, drainTimeoutMs, crashRecorder })
  enter({ key, turnId? }) → lease
  disable({ timeoutMs? }) → drained | timed_out(activeIds)
  enable() / snapshot()

createCoreV0RepairRecorder({ store, operatorId })
  record({ turnId, operation, adapter, status, errorCode? })
```

The existing Core turn service consumes the store shape; the target route is not switched in this increment.

## State, idempotency and failure

- A stale subject sequence is `CORE_STORAGE_CONFLICT`, retryable, and never success.
- A duplicate turn key with the same fingerprint returns the original turn; a changed fingerprint is `409 IDEMPOTENCY_KEY_CONFLICT`.
- A duplicate binding or commit returns the existing receipt; a conflicting mapping is `409`.
- Memory repository conflict retries reload state and replays the original event/binding key only within a bounded attempt count.
- Connection close or commit uncertainty remains `pending`; a receipt lookup can change it to `completed`.
- Gate timeout records active turn/lease IDs and never cancels or rewrites their records.

## Authorization and privacy

Only verified server context supplies tenant/user IDs. Repair records contain no message body, prompt, token, or database URL. The PostgreSQL pool must use the repository's existing TLS configuration and parameterized SQL.

## Definition of done

The package SQL/fixture tests pass; the shaped acceptance adapter reports the R-002 scenario and lifecycle rows as passed; compatibility remains explicitly deferred; live Auth/TLS and two-process PostgreSQL rows remain `pending` when no `DATABASE_URL` exists rather than being claimed as passed. No traffic cutover occurs.
