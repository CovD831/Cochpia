# R-003 rollback and recovery boundary

## Implemented in this increment

The AdmissionGate can reject new Core admissions, wait for active leases and return a bounded timeout result. Existing turn, Memory and repair records are not deleted or rewritten. `reconcileTurn` continues to use the original turn/event/idempotency identities even when new admissions are disabled.

## Not yet a production rollback claim

This package does not switch traffic, change the legacy route or prove a live multi-process drain. A real cutover must first stop new writes, reconcile all bindings/receipts, make the old adapter read-only or recoverable, switch gate and adapter together, and run the acceptance matrix against the deployed database.

The cutover fence is a single operator decision: the database-backed gate closes first, legacy and target writer status is recorded, pending turns are reconciled by original identity, and only then may the route/adapter pair change. If any old writer remains mutable or a lease is unaccounted for, preserve R-002 and reopen the gate only after an explicit restart/rollback decision.

## Timeout and crash semantics

- `drained`: no active Core lease remains;
- `timed_out`: active identifiers are recorded for operator repair; no cancellation or success is inferred;
- `pending`: external outcome is unknown and may only be reconciled by the original identity;
- `completed`: an authoritative receipt and Core commit are both present;
- `dead_letter`: bounded repair attempts are exhausted and require an explicit operator action.

Repair/crash rows contain turn ID, operation, adapter, status, error code, attempt and operator ID only. They never contain message content, prompts or credentials.

## Deterministic repair boundary

`repair_attempt_id` is stable across recorder retries for the same original turn, operation, attempt and close epoch. `pending` and `dead_letter` are observable states; neither is converted to `completed` without an authoritative receipt and Core commit. A recorder/database failure keeps the gate closed and is reported as an operational failure.
