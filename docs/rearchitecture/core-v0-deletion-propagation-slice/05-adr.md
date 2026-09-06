# R-006 ADRs

## ADR-006-01: Forget, not physical delete

Decision. Deletion propagation uses the existing `forgetSourceEvent`
governance path: assertions become `forgotten`, snapshot and index rows are
removed, a tombstone and a redaction epoch are recorded, and the canonical
raw event row stays.

Rationale. Erasing canonical rows would break the audit trail, the redaction
epoch semantics and the durability guarantees R-003 built, for no user-visible
gain: forgotten content is invisible to retrieval and blocked from
re-extraction by the tombstone guard.

Trade-offs. Raw event rows remain in the database and are visible to
operators with direct DB access. True erasure (GDPR-style) needs a separate
physical redaction pass and is out of scope.

## ADR-006-02: Forget before delete

Decision. The fan-out order is Memory forget first, Core deletion second.

Rationale. The two operations cannot share a transaction (different owners,
per the L1 boundary). Of the two partial-failure directions, "message still
exists but its memory is gone" is recoverable and safe; "message is gone but
its memory persists" is the resurrection bug this slice exists to kill.

Trade-offs. A Core deletion failure after a successful forget leaves the
message without its memory until deletion is retried; the route returns a
retryable error and the next attempt is idempotent on the Memory side.

## ADR-006-03: Turn admissions survive message deletion

Decision. Deleting an application message never deletes its turn admission.

Rationale. Turn admissions carry identity, idempotency and audit facts. A
deleted message with its admission retained stays replay-safe (a replay
returns the committed result without regenerating content) and keeps the
audit trail intact.
