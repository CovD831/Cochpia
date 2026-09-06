# R-005 acceptance matrix

| ID | Scenario | Expected evidence |
|---|---|---|
| B-01 | projection side effect | promotion projects into every active unexpired session of the subject, inside the same mutation |
| B-02 | projection idempotency | re-promotion or rebind duplicates no snapshot_items row |
| B-03 | drain wiring | a committed turn's raw event becomes an active assertion through the production path with no manual step |
| B-04 | drain idempotency | an already-extracted source event is skipped without an extractor call |
| B-05 | sensitive policy | an S2 fact lands in `pending_confirmation`, is invisible to retrieval, and enters after confirmation |
| B-06 | extraction failure | model unavailable or throwing: turn stays committed, repair record exists, next drain retries |
| B-07 | loop closure | the automated proof passes E4 and E7 with no manual extraction or projection; the reply branch is the memory branch |
| B-08 | recall semantics | turn result exposes `recalledCount` and `memoryAnswerability`; zero-recall success is distinguishable from a contributing recall |
| B-09 | flag parity | flag off reproduces baseline 5fa81cf behavior including the manual proof path |

Executable checks are `npm run test:core-v0-memory-pipeline`,
`npm run proof:memory-loop`, `npm test`, and the rearchitecture package
checker. Local acceptance uses paired fixtures and controlled database
doubles; the live-database variant of the proof stays a manual command.
