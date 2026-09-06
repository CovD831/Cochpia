# R-006 L2 contracts

## Core message deletion — established

`deleteApplicationMessage({ sessionId, messageId })` on the production
adapter removes the message from the Core store's application messages and
persists; the turn admission stays (history and audit). Deleting an unknown
message is a 404, deleting twice is safe (second is a 404 at the route).

## Fan-out — established

After a successful Core deletion, the adapter resolves the owning turn's
`eventId`, maps it to the Memory raw event row, and invokes
`forgetSourceEvent` with the same-subject governance context. The Memory
side is idempotent and tombstone-guarded: a repeated forget is a safe no-op
effect, a tombstoned source can never produce new candidates
(`SOURCE_EVENT_REDACTED`).

## Ordering and failure — established (consumes review)

Memory forget runs FIRST, Core deletion second. If the Core deletion then
fails, the caller gets an error but the memory is already forgotten - the
safe direction is to remember less, never more. A Memory-side failure never
loses the message: the fan-out returns the error and the Core deletion is
not attempted; the route surfaces 503 with a retryable code.

## No resurrection — established

After deletion: the forgotten assertion is invisible to retrieval
(`answerability=not_found`, `recalledCount=0`), snapshot_items no longer
reference it, the tombstoned source is skipped by the extraction drain
forever, and a re-stated fact creates a fresh assertion (new source event).

## Review record

Self-review during drafting consumed two findings before freezing:
(R6-AR-1) forget-before-delete ordering fixed as above instead of the
draft's delete-first ordering; (R6-AR-2) the drain's tombstone skip must be
covered by a check, not assumed - acceptance C-04. Both are folded into the
contracts above and the acceptance matrix.
