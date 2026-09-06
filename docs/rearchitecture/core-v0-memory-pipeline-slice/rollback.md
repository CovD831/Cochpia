# R-005 rollback

## Flag off

`CORE_V0_MEMORY_PIPELINE_ENABLED=false` disables the drain and the projection
side effect together. Behavior returns to baseline 5fa81cf: raw events
accumulate unextracted, snapshots stay binding-time only, and the manual
proof path remains the only way to close the loop. No data is lost; already
extracted assertions stay active and are simply not projected further.

## Data

Projection and drain add rows to existing tables only (snapshot_items,
assertions, versions, sources, repair records). Rolling back does not delete
them; a re-enable resumes from the durable state, and idempotency prevents
duplicates. No schema migration exists in this slice, so rollback involves
no DDL.

## Reconciliation

If a crash interrupts a drain mid-batch, already persisted assertions remain
valid (each event is its own transaction) and unprocessed events are retried
by the next drain. `operation='memory_extraction'` repair rows are the
reconciliation surface; a cleanup of dead-letter rows is an operator task
using the existing repair tooling.

## Stop rule

If extraction is observed writing Core tables, projection escaping the
promote transaction, the drain spawning a process, or an extraction failure
failing a committed turn, stop, flag off, and reopen the review ledger.
