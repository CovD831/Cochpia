# R-005 ADRs

## ADR-005-01: Projection is a transactional side effect, not a worker

Decision. Projection runs inside `promoteCandidate`'s state mutation and the
following persistence call.

Rationale. Projection is deterministic, cheap (one row per active session)
and required for the promoting subject's own next retrieval. Making it
asynchronous would reintroduce the exact staleness this slice removes, add a
worker lifecycle for no benefit, and create a window where retrieval misses a
just-promoted assertion.

Trade-offs. `promoteCandidate` gains write scope over snapshot_items. The
batch size is unbounded in the number of active sessions; bounded in practice
by sessions per subject. If a future subject has thousands of sessions, this
moves to a background job with the same contract; the L2 contract does not
change.

## ADR-005-02: Extraction is outbox-ordered, drain-on-entry, no new process

Decision. The drain runs at turn entry, before admission, in the request
context. It reads unextracted raw events in outbox/sequence order, bounded to
a small batch, and stops cleanly on time or error.

Alternatives rejected. A dedicated worker process violates the single-process
deployment boundary. A post-commit in-request extraction adds model latency
to every turn. A timer loop needs a scheduler. Drain-on-entry gives eventual
consistency with bounded lag (at most one turn of delay) using only existing
infrastructure: the outbox ordering already persisted by the Module.

Trade-offs. Memory becomes visible one turn later than the fact was stated
when the drain budget is exhausted; the first turn after a cold start pays
the drain cost. Failure semantics stay explicit through Memory audit events.
Consumed review hardening (R5-AR-001/002): per-subject advisory locks
serialize concurrent drains, a hard time budget bounds request latency, and a
circuit breaker prevents retry storms against a failing model.

## ADR-005-03: One extractor contract, two implementations, injected explicitly

Decision. The deterministic double is the test authority; the model-backed
extractor reuses the application model configuration and is skipped when
unavailable (mock provider, missing key, or error). The adapter and Module
accept an explicit extractor override; tests and the automated proof inject
the deterministic double, so the loop-closure acceptance (B-07) is verifiable
offline.

Rationale. Extraction quality is a Phase 3 concern; this slice owns wiring
and failure semantics. Making the model mandatory would make the loop
untestable offline and would couple chat availability to extraction.

Trade-offs. A skip leaves raw events unextracted until a real model is
configured; the audit trail makes the backlog visible instead of silent.
Consumed review hardening (R5-AR-003/006): the injection point is a named
construction parameter, the output is a fixed JSON schema with a per-event
candidate cap, and malformed output follows the failure path.

## ADR-005-04: Deletion propagation moves to R-006

Decision. The E5 gap (Core message deletion refused, no Memory cascade) is
real but independent: it needs a Core deletion API first, and its fan-out
(raw event tombstone, version source removal, snapshot cleanup) has its own
race surface. Mixing it into the extraction slice would blur both rollback
stories. R-006 will own it with the tombstone mechanisms that already exist
in the Module.
