# R-002 implementation decisions

## ADR-002-01: target command is a non-streaming turn endpoint

**Decision:** implement the first target path as a non-streaming application command (`POST /api/chat/turns`) and retain `/api/chat/stream` as the legacy fixture.

**Reason:** it isolates admission, context, model result and commit semantics. Streaming and resume can be added after the durable turn record is proven.

**Reversal:** replace the adapter with the existing SSE route only after the same receipt and recovery matrix passes for partial/final/failed chunks.

## ADR-002-02: binding is an immutable integration record

**Decision:** persist one binding record per `(tenant_id, subject_user_id, application_session_id)` and reject a conflicting mapping to another `memory_session_id`. The reverse pair is also unique within the tenant/user scope.

**Reason:** it prevents a retry or service cutover from silently attaching a conversation to another Memory session.

## ADR-002-03: no dual writable Memory authority

**Decision:** target code calls MemoryPort only. In-process and PostgreSQL adapters are interchangeable fixtures; the independent HTTP service is never enabled as a second writer in the same run.

**Reason:** a successful chat result must have one explainable Memory receipt and one recovery path.

## ADR-002-04: old PRs remain open during replacement

**Decision:** PR1–PR7 remain open while this package is local and unmerged. A future replacement PR may mark them superseded; closure is a separate explicit GitHub operation after evidence review.

