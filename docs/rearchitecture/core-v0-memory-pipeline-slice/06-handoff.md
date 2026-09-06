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

R-005-REVIEW-AND-IMPLEMENT: run the input adversarial review on this
package, consume findings into the ledger, then implement the projection
side effect, the drain, the recall semantics exposure and the automated
proof. The proof must close E4 and E7 without any manual extraction or
projection step.

## Promotion trigger

Unchanged from R-004: Auth/TLS and context-spoofing evidence, R-003 live
evidence, writer cutover and rollback plan. R-005 adds no production gate;
flag-off must remain a complete rollback path.

## Preserved paths

/api/chat/stream, legacy writers, R-004 route semantics and the user's
existing PRs remain unchanged. Deletion propagation is R-006's.
