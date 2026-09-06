# R-005 consumed L2 contracts

## Projection side effect — established

Promoting a candidate to active MUST, within the same Memory state mutation
and the same persistence call, insert one snapshot_item per active unexpired
session of the same subject, binding (snapshotId, assertionId, currentVersionId,
scopeType). The insert is idempotent: a repeated promotion or a rebind that
would duplicate an existing (snapshotId, assertionId) pair changes nothing.
Projection covers user and relationship scope; session-scope assertions are
visible only in their own session and are not projected elsewhere.

## Extraction drain — established

At turn entry, before admission, the drain reads the oldest unextracted raw
events for the request's tenant and subject, bounded by a small batch
(default 3, ceiling 10). For each event it derives at most a small number of
candidate assertions through the extractor, then follows Module policy:
S0/S1 candidates may auto-promote, S2 becomes `pending_confirmation` and
never enters retrieval before confirmation, S3 is rejected and recorded.
Extraction is idempotent per source event: an event that already has an
assertion version source is skipped. The drain MUST NOT run inside the turn
write transaction and MUST NOT fail the turn; failures are recorded in the
existing repair/crash records and retried by a later drain.

## Extractor — established

The extractor consumes one raw event (role `user`, content type `plain_text`)
and returns zero or more candidate contents with type hints. Two
implementations share one contract: a deterministic double for tests and a
model-backed extractor that reuses the application model configuration. When
no real model is configured or the call fails, the drain records a skip or
failure and continues; it never fabricates assertions without a source.

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
