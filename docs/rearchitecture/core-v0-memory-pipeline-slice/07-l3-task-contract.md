# R-005 L3 task contract

## Projection

`promoteCandidate` computes the subject's active unexpired sessions and
inserts one snapshot_item per session for the promoted assertion inside the
same in-memory mutation, then persists through the existing repository save.
Re-running a promotion or promoting an already active assertion is a no-op.
The MutationResult exposes the number of projected sessions. No new tables
and no schema change.

## Drain

`drainMemoryExtraction(context, { batch })` runs before turn admission when
the flag is on. It loads the oldest unextracted raw events (user role,
plain text) for the subject, ordered by the outbox sequence, capped by batch
(default 3, ceiling 10). For each event the extractor returns candidate
contents; the Module creates candidates bound to the source event and
applies promotion policy (S0/S1 auto-promote, S2 pending confirmation, S3
reject with a record). An event with an existing assertion version source is
skipped without calling the extractor. The drain wraps its own transaction
per event, never the turn's, and returns a summary
(extracted, promoted, pending, skipped, failed).

## Failure and repair

An extractor throw, timeout or unavailable model records one repair attempt
row (operation `memory_extraction`) and leaves the event unextracted for the
next drain. The turn proceeds regardless. Consecutive failures do not grow
the batch.

## Recall semantics

`handleTurn` results add `recalledCount` and `memoryAnswerability` next to
`memoryStatus`. JSON mode mirrors the same fields. Nothing is removed from
the existing result shape.

## Flag

`CORE_V0_MEMORY_PIPELINE_ENABLED` (default off) gates the drain and the
projection side effect together. Flag off must leave baseline behavior byte
for byte, including the proof's manual path.

## Definition of done

Paired fixtures (deterministic extractor double, turn fixtures), drain
unit tests, projection idempotency tests, flag-off parity check, recall
semantics checks, the automated memory-loop proof closing E4 and E7 without
manual steps, package checker, full tests, build and secret scan all pass.
Extraction quality evaluation and deletion propagation remain deferred.
