# R-002 rollback and recovery boundary

## Feature rollback

The target route is guarded by a feature flag. Turning it off stops new target admissions and leaves the legacy route available for the comparison fixture. This is a routing rollback, not a deletion or data rewrite.

When disabling the flag, the process first closes the admission gate, waits for an in-flight barrier to reach zero, and returns `503 CORE_V0_DISABLED` with a retry hint to new requests. A bounded drain timeout does not cancel or rewrite existing records; timed-out turns remain `pending` and are handed to reconciliation.

## In-flight drain barrier

The barrier counts admitted requests and external adapter calls. It is durable at the process boundary through the admission/commit records, and it is considered drained only when no request can create a new binding, raw event or assistant commit under the target flag. A timeout records the active turn IDs for operator repair; it is not evidence of no external effect.

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

Operator repair uses `reconcileTurn(turnId)` and records the lookup result, adapter, attempt and operator/action ID. It never repairs by creating a new binding, event ID or idempotency key.

Cross-domain deletion, cache invalidation, provider retention and backup restoration are not covered by this rollback note; they remain separate governance gates.
