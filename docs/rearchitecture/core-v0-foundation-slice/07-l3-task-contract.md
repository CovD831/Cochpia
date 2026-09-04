# R-002 L3 task contract

## Target command

`POST /api/chat/turns`

Request body:

```json
{
  "sessionId": "app-session-01",
  "message": "你好",
  "channel": "默认"
}
```

Required header: `Idempotency-Key: <client-generated-key>`.

The body may contain `idempotencyKey` only when it exactly matches the header. `tenantId`, `userId`, `agentId`, `relationshipId`, `memorySessionId`, `eventId` and `sourceRevision` are server-owned and rejected when supplied by the client.

## Admission record

Logical record: `turn_admission`.

```json
{
  "turnId": "turn-01",
  "idempotencyKey": "client-key-01",
  "tenantId": "derived",
  "subjectUserId": "derived",
  "applicationSessionId": "app-session-01",
  "memorySessionId": "memory-session-01",
  "applicationMessageId": "msg-01",
  "eventId": "evt-01",
  "sourceRevision": "1",
  "status": "admitted",
  "rawEventReceipt": {"status": "completed", "eventId": "evt-01"},
  "createdAt": "server-time",
  "updatedAt": "server-time"
}
```

Required uniqueness:

- `(tenantId, subjectUserId, applicationSessionId, idempotencyKey)`;
- `(tenantId, subjectUserId, applicationSessionId, sourceRevision)`;
- `(tenantId, subjectUserId, applicationMessageId)`;
- `(tenantId, subjectUserId, eventId)`;
- `(tenantId, subjectUserId, applicationSessionId)` for the binding relation;
- `(tenantId, subjectUserId, memorySessionId)` for the binding relation.

Exact replay returns the original receipt and does not call Memory or the model a second time. Reusing the key with a different normalized message/session/channel is `409 IDEMPOTENCY_KEY_CONFLICT`.

## Session binding record

Logical record: `memory_session_binding`.

```json
{
  "bindingId": "binding-01",
  "tenantId": "derived",
  "subjectUserId": "derived",
  "applicationSessionId": "app-session-01",
  "memorySessionId": "memory-session-01",
  "memoryContractVersion": "v1",
  "status": "completed",
  "createdAt": "server-time"
}
```

`bindingKey` is the deterministic string `tenantId + ":" + subjectUserId + ":" + applicationSessionId`; it is stored and used for all binding retries. `ensureSessionBinding` first locks or atomically upserts by both independent unique keys. The first completed mapping wins. An existing exact pair returns the same binding receipt; an application session mapped to another Memory session, or a Memory session mapped to another application session in the same tenant/user scope, returns `409 SESSION_BINDING_CONFLICT`. A concurrent loser rereads the winner instead of creating another Memory session. The binding is immutable; cutover creates a new versioned adapter record rather than overwriting history.

The binding port exposes `getSessionBinding(bindingKey)` and `reconcileSessionBinding(bindingKey)`. If Memory session creation succeeds but its response is lost, the local record stays `pending` and reconciliation queries by the same `bindingKey`; a new Memory session is never created under a new key.

## Deterministic IDs and receipt reconciliation

The first admission allocates and persists `turnId`, `applicationMessageId`, `eventId` and `assistantMessageId` before invoking an external adapter. Their values are stable for the idempotency key; retries never call `randomUUID()` to represent the same fact. `commitId` is `"assistant:" + assistantMessageId`.

The ports expose `getRawEventReceipt(eventId, sourceRevision)`, `getAssistantCommitReceipt(commitId)` and `reconcileTurn(turnId)`. A receipt query returning `completed` is authoritative; `not_found` is only evidence of no durable effect when the adapter's read-after-write contract says the lookup is complete. Otherwise the state remains `pending`.

## State transitions

```text
received → admission_pending → admitted → context_ready
                    └────────→ pending (unknown Memory outcome)
                                      └→ failed
context_ready → generation_succeeded → commit_pending → committed
                                          └──────────→ failed
committed → superseded (only in a later regenerate slice)
```

The Foundation Slice exposes only `admitted`, `context_ready`, `generation_succeeded`, `commit_pending`, `committed` and `failed`; `pending` is the durable unknown-outcome state. Unknown Memory admission or commit outcome remains `pending`; it is never converted to success. `conversation_message.visibleAt` is set only after the corresponding assistant commit receipt is `completed`.

## Response

Success is returned only after `committed`:

```json
{
  "status": "committed",
  "turnId": "turn-01",
  "applicationMessageId": "msg-01",
  "assistantMessageId": "assistant-01",
  "memoryStatus": "available",
  "receiptId": "receipt-01"
}
```

Degraded retrieval is allowed but explicit. Admission or commit pending returns `202` with a receipt and no completed assistant message. Commit failure returns a typed failure and cannot leave a visible completed assistant message. A client retry with the same key first calls `reconcileTurn` and returns the existing result if it is already committed.

## Authorization and safety

- The request principal comes from verified Auth/service context.
- The server resolves tenant, user, agent, relationship and session ownership.
- Message content is bounded to 8,000 characters and normalized before idempotency comparison.
- Memory context is policy-filtered and budgeted before entering the model.
- The model receives no repository handle, mutable state object or unfiltered request body.

## Recovery

On process restart, the target service scans `admission_pending`, `pending` and `commit_pending` records, calls the binding/raw-event/commit receipt queries, and resumes only with the persisted IDs and original idempotency key. It does not create a new event or assistant message based on an in-process run map. `reconcileTurn` is the repair entry point and records the outcome of each lookup.
