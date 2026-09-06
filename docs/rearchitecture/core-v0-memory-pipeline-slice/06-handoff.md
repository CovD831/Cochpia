# R-005 implementation handoff

## Current state

The package is frozen around the two breaks isolated by the memory-loop
proof: extraction (raw events to active assertions) and snapshot projection
(active assertions into retrieval-visible snapshots). The L2 contracts fix
projection as a transactional side effect of promotion, extraction as an
outbox-ordered drain at turn entry with bounded batch and repair-recorded
failures, one extractor contract with two implementations, recall semantics
on the turn result, and a single feature flag.

## Next task

R-005-CONSUME-REVIEW: the input adversarial review found three blocking
findings (R5-AR-001 concurrent drain serialization, R5-AR-002 drain time
budget and circuit breaker, R5-AR-003 extractor injection point required by
acceptance B-07), two major findings (confirmation-route projection, flag
plumbing into the Module) and two advisories. Consume all of them into the
L2/L3 contracts first; implementation starts only when the ledger shows
every blocking finding consumed.

## Promotion trigger

Unchanged from R-004: Auth/TLS and context-spoofing evidence, R-003 live
evidence, writer cutover and rollback plan. R-005 adds no production gate;
flag-off must remain a complete rollback path.

## Preserved paths

/api/chat/stream, legacy writers, R-004 route semantics and the user's
existing PRs remain unchanged. Deletion propagation is R-006's.
