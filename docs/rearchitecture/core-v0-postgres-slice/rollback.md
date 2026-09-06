# R-003 rollback and recovery boundary

## Implemented in this increment

The AdmissionGate can reject new Core admissions, wait for active leases and return a bounded timeout result. Existing turn, Memory and repair records are not deleted or rewritten. `reconcileTurn` continues to use the original turn/event/idempotency identities even when new admissions are disabled.

## Local rollback/drain rehearsal

`npm run acceptance:core-v0-postgres-rollback` runs the synthetic fixture `fixtures/rollback-drain-rehearsal.json` and writes `.rearchitecture-runs/core-v0-postgres-rollback-rehearsal.json`. The rehearsal observes this order: legacy writer active and target writer standby; target admission lease acquired; durable gate closed before any switch; timeout recorded as pending; post-close admission rejected; lease released; the original repair identity reconciled through the recorder's authoritative receipt/Core-commit path; target traffic remains unswitched and the policy state rolls back to the legacy writer.

This artifact is content-free and proves the local SQL-shaped gate/reconciliation ordering and the explicit policy-state transition only. It does not observe a deployed writer or prove atomic production route rollback, and it does not close the live PostgreSQL/Auth/TLS or multi-process promotion gates.

## Not yet a production rollback claim

This package does not switch traffic, change the legacy route or prove a live multi-process drain. A real cutover must first stop new writes, reconcile all bindings/receipts, make the old adapter read-only or recoverable, switch gate and adapter together, and run the acceptance matrix against the deployed database.

The cutover fence is a single operator decision: the database-backed gate closes first, legacy and target writer status is recorded, pending turns are reconciled by original identity, and only then may the route/adapter pair change. If any old writer remains mutable or a lease is unaccounted for, preserve R-002 and reopen the gate only after an explicit restart/rollback decision.

## Timeout and crash semantics

- `drained`: no active Core lease remains;
- `timed_out`: active identifiers are recorded for operator repair; no cancellation or success is inferred;
- `pending`: external outcome is unknown and may only be reconciled by the original identity;
- `completed`: an authoritative receipt and Core commit are both present;
- `dead_letter`: bounded repair attempts are exhausted and require an explicit operator action.

Repair/crash rows contain turn/lease identity, operation, adapter, status, error code, attempt, operator ID, close epoch and opaque receipt/commit proof IDs. They never contain message content, prompts or credentials.

## Deterministic repair boundary

`repair_attempt_id` is stable across recorder retries for the same original turn, operation, attempt and close epoch. `pending` and `dead_letter` are observable states; neither is converted to `completed` without an authoritative receipt and Core commit. A recorder/database failure keeps the gate closed and is reported as an operational failure.
