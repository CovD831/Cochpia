# R-005 acceptance matrix

| ID | Scenario | Expected evidence |
|---|---|---|
| B-01 | projection side effect | promotion projects into every active unexpired session of the subject, inside the same mutation |
| B-02 | projection idempotency | re-promotion or rebind duplicates no snapshot_items row |
| B-03 | drain wiring | a committed turn's raw event becomes an active assertion through the production path with no manual step |
| B-04 | drain idempotency | an already-extracted source event is skipped without an extractor call |
| B-05 | sensitive policy | an S2 fact lands in `pending_confirmation`, is invisible to retrieval, and enters retrieval after user confirmation through the same projection path |
| B-06 | extraction failure | model unavailable or throwing: turn stays committed, audit record exists, next drain retries |
| B-07 | loop closure | the automated proof passes E4 and E7 with the injected deterministic extractor and no manual extraction or projection step |
| B-08 | recall semantics | turn result exposes `recalledCount` and `memoryAnswerability`; zero-recall success is distinguishable from a contributing recall |
| B-09 | flag parity | flag off reproduces baseline 5fa81cf behavior including the manual proof path |
| B-10 | drain concurrency | two concurrent drains on one subject serialize on the advisory lock; no assertion or snapshot row is lost |
| B-11 | drain budget | a slow extractor cannot exceed the drain time budget, and the circuit breaker pauses after consecutive failures |
| B-12 | confirmation route | deciding an S2 confirmation projects the activated assertion like any other activation route |

Executable checks are `npm run test:core-v0-memory-pipeline`,
`npm run proof:memory-loop`, `npm test`, and the rearchitecture package
checker. Local acceptance uses paired fixtures and controlled database
doubles; B-10 concurrency serialization and the live-database variant of the
proof stay manual commands against a real PostgreSQL.

## Phase 3c acceptance (R-012c, closed 2026-09-08)

| ID | Scenario | Expected evidence | Status |
|---|---|---|---|
| 3C-E1 | unit tests | lexical floor trims long tail and keeps strong hits; decay flag off = identity, on = recency re-order; extraction budget knob effective | pass (326/326) |
| 3C-E2 | full suite | `npm test` + `test:core-v0-production` green | pass (326/326, 21/21) |
| 3C-E3 | 220-case x 3 runs, live vector channel, preflight-guarded | dedup 20%->95%, paraphrase 62%->79%, lexical 63%->93%, fact_recall 87.5%->95.8%; precision_noise/arbitration deltas attributed to metric design + R-014 (see phase3c-plan.md 8.2/8.3) | pass (phase3c-v4-run1..3) |

Evidence artifacts: `.rearchitecture-runs/phase3c-{v3,v4}-run*.json`,
probes `scripts/{audn-arbitration,extraction-keyword}-probe.js`,
`scripts/arbitration-repro.js`, harness guards in commits `070a735`,
`9268149`, final attribution `67ce77f`.
