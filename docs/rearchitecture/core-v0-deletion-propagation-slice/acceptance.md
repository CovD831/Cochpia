# R-006 acceptance matrix

| ID | Scenario | Expected evidence |
|---|---|---|
| C-01 | Core deletion persistence | the deleted application message is gone after a fresh hydration |
| C-02 | fan-out | the forgotten assertion leaves snapshot_items and retrieval |
| C-03 | no resurrection | a fresh-session probe after deletion reads recalledCount=0, answerability=not_found, no memory branch |
| C-04 | tombstone guard | the drain never re-extracts a tombstoned source event |
| C-05 | idempotency | repeated deletion is a 404 at the route, a safe no-op in Memory |
| C-06 | history retained | the turn admission remains after message deletion |

Executable checks are `npm run test:core-v0-memory-pipeline` (extended),
`npm run proof:memory-loop` (E5 reversal), `npm test`, and the rearchitecture
package checker.
