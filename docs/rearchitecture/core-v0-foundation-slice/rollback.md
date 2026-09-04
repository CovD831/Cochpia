# R-002 rollback and recovery boundary

## Feature rollback

The target route is guarded by a feature flag. Turning it off stops new target admissions and leaves the legacy route available for the comparison fixture. This is a routing rollback, not a deletion or data rewrite.

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

Cross-domain deletion, cache invalidation, provider retention and backup restoration are not covered by this rollback note; they remain separate governance gates.

