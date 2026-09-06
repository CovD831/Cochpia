# R-005 implementation handoff

## Current state

R-005-IMPLEMENT is complete behind CORE_V0_MEMORY_PIPELINE_ENABLED (default
off). Projection is a transactional side effect shared by every activation
route (promotion and user confirmation) through the projectionEnabled Module
option. The extraction drain runs at turn entry with a per-subject advisory
lock, a hard 2s budget, a 5-failure circuit breaker and Memory-audit failure
records. The extractor is an explicit injection point with a deterministic
double and a model-backed implementation demanding a fixed JSON schema. Turn
results expose recalledCount and memoryAnswerability.

## Evidence

- npm test: 299 checks green
- npm run test:core-v0-memory-pipeline: 8 checks green (B-01..B-09 fixture
  coverage: projection, idempotency, drain wiring, S2 policy, failure audit,
  budget, circuit breaker, lock SQL, flag parity, extractor schema)
- npm run proof:memory-loop (live): 7/8 - E4 closed-loop passes with no
  manual step (recalledCount=1, answerability=known, memory reply branch);
  the only FAIL is E5 deletion propagation, the recorded R-006 gap
- R-004 acceptance remains 12/12

## Next task

R-006-DELETION-PROPAGATION: Core message deletion API, raw-event tombstone
fan-out, snapshot cleanup and the no-resurrection checks (proof E5).

## Promotion trigger

Unchanged. Flag-off remains a complete rollback path to baseline 5fa81cf.
