# R-005 consumed L2 contracts

## Projection side effect — established (consumes R5-AR-004, R5-AR-005, R5-AR-007)

Every activation route shares one projection implementation: drain
auto-promotion AND user confirmation decisions (decideConfirmation) MUST
project through the same code path. Projection is part of the promotion
mutation: within the same Memory state mutation and the same persistence
call, insert one snapshot_item per active unexpired session of the same
subject, binding (snapshotId, assertionId, currentVersionId, scopeType).
The insert is idempotent: a repeated promotion or a rebind that would
duplicate an existing (snapshotId, assertionId) pair changes nothing.
Projection covers user and relationship scope; session-scope assertions are
visible only in their own session and are not projected elsewhere.

The feature flag reaches the Module as a construction option
(`projectionEnabled` on the Memory Module options); it is never read from
the environment inside routes. Projection and extraction write audit events
consistent with Module conventions: one audit row per projection batch (per
subject, not per row) and one per extraction skip or failure.

## Extraction drain — established (consumes R5-AR-001, R5-AR-002)

At turn entry, before admission, the drain reads the oldest unextracted raw
events for the request's tenant and subject, bounded by a small batch
(default 3, ceiling 10). For each event it derives at most a small number of
candidate assertions through the extractor, then follows Module policy:
S0/S1 candidates may auto-promote, S2 becomes `pending_confirmation` and
never enters retrieval before confirmation, S3 is rejected and recorded.
Extraction is idempotent per source event: an event that already has an
assertion version source is skipped. The drain MUST NOT run inside the turn
write transaction and MUST NOT fail the turn.

Concurrency: each drained event is one transaction that first acquires a
PostgreSQL advisory transaction lock scoped to (tenant, subject), so two
concurrent drains serialize and no full-state save can overwrite another.
Time budget: the whole drain carries a hard budget (default 2s); each
extractor call is bounded by the remaining budget. Circuit breaker: after a
consecutive-failure threshold the drain pauses for a cooled-down window and
skips without calling the model. Failure records go to the Memory audit
trail (the drain never writes Core tables); their retention is capped and
dead rows are an operator cleanup task.

## Extractor — established (consumes R5-AR-003, R5-AR-006)

The extractor consumes one raw event (role `user`, content type `plain_text`)
and returns zero or more candidate contents with type hints, capped per
event. The output is a fixed JSON schema; malformed output counts as an
extraction failure and follows the repair path. Two implementations share
one contract and one injection point: the adapter and Module accept an
explicit extractor (the deterministic double for tests and the automated
proof); when none is injected and the provider is mock or unconfigured, the
drain is a no-op skip (silent, no per-turn audit spam). The model-backed
extractor reuses the application model configuration and never fabricates
assertions without a source.

## Recall semantics — established

`handleTurn` results expose `recalledCount` (number of items contributing to
generation) and `memoryAnswerability` (the bundle answerability). A
successful retrieval with zero items is `available` with `recalledCount: 0`;
callers and acceptance checks must distinguish that from a contributing
recall.

## Feature flag — established

`CORE_V0_MEMORY_PIPELINE_ENABLED` gates projection and extraction together.
Flag off reproduces baseline 5fa81cf behavior exactly: no projection rows, no
drain, proof E6 stays manual. Flag default is off until acceptance passes.
