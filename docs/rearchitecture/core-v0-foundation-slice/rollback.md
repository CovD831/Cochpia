# R-002 rollback and recovery boundary

## Runtime status — September 5, 2026

The target route is fail-closed when `CORE_V0_ENABLED` is false and returns a retry hint. The full in-flight drain barrier, crash recording and operator repair flow remain open under `R002-CLOSURE-F-003`; disabling the flag must not yet be described as a proven race-free rollback procedure.

This document is the rollback contract. R-002 implements the fail-closed flag and a reconciliation entry point, but does not implement the drain barrier, crash recorder or operator repair surface described below.

## Feature rollback

The target route is guarded by a feature flag. Turning it off stops new target admissions and leaves the legacy route available for the comparison fixture. This is a routing rollback, not a deletion or data rewrite.

The future rollback procedure must first close the admission gate, wait for an in-flight barrier to reach zero, and return `503 CORE_V0_DISABLED` with a retry hint to new requests. A bounded drain timeout must not cancel or rewrite existing records; timed-out turns remain `pending` and are handed to reconciliation. In R-002, the flag check is implemented, but the drain wait and timeout recording are not.

## In-flight drain barrier

The future barrier must count admitted requests and external adapter calls. It is durable at the process boundary through the admission/commit records, and it is considered drained only when no request can create a new binding, raw event or assistant commit under the target flag. A timeout must record the active turn IDs for operator repair; it is not evidence of no external effect. This barrier is not runtime-proven in R-002.

## Data rollback

Do not delete or overwrite `turn_admission`, `memory_session_binding`, raw event or message records during rollback. Records with `pending` or unknown external outcome remain repairable. The legacy path must not re-submit them under a new idempotency key.

## Adapter cutover

Only one Memory adapter is writable per process. A future in-process/PostgreSQL or HTTP cutover must:

1. stop new target admissions;
2. reconcile bindings, event IDs, source revisions and receipts;
3. make the old adapter read-only or preserve a tested recovery point;
4. switch the feature flag and adapter together;
5. replay only by the original idempotency key;
6. abort if any binding or receipt is ambiguous.

## Recovery classification

- `failed`: no durable external effect is known; a safe retry may reuse the same key.
- `pending`: external outcome is unknown; do not retry with a new key or report success.
- `completed`: durable receipt exists and exact replay returns it.
- `dead_letter`: bounded retries exhausted; operator repair is required.

“No external effect” is accepted only after the adapter's authoritative receipt lookup completes with `not_found` and the lookup contract rules out an in-flight write. A timeout, connection close or provider error is `pending`, not `failed`.

Reconciliation uses `reconcileTurn(turnId)` and is permitted even while new admissions are disabled. The future operator repair surface must record the lookup result, adapter, attempt and operator/action ID. It must never repair by creating a new binding, event ID or idempotency key.

Cross-domain deletion, cache invalidation, provider retention and backup restoration are not covered by this rollback note; they remain separate governance gates.
