# R-002 consumed L2 contracts

The stable L2 definitions are inherited from [`R-001 L2`](../core-v0-design/04-l2-contracts.md). This file freezes only the forms consumed by the Foundation Slice.

## MemoryPort

**Owner:** Memory Foundation adapter.

**Commands:**

- `ensureSessionBinding(context, applicationSessionId, bindingKey)`;
- `appendRawEvent(context, event)`;
- `retrieveContext(context, query)`.

**Queries/views:** bounded `MemoryContextView`, never mutable Memory records.

**Receipts and reconciliation:** binding receipt, raw-event receipt, `getSessionBinding(bindingKey)`, `getRawEventReceipt(eventId, sourceRevision)` and a bounded reconciliation result. The same binding key and event IDs are used for every retry.

**Failure:** retrieval may be `available`, `degraded`, `not_found` or `uncertain`; append/binding returns `pending` or `failed` when durable admission is not known. A missing response is not treated as `not_found` unless the adapter's read-after-write lookup completed.

## Companion Durable Store

**Owner:** Companion Runtime.

**Records:** `memory_session_binding`, `turn_admission`, `conversation_message` and `assistant_commit`.

**Invariant:** a user turn is not exposed as an admitted/completed turn until the corresponding durable record and required Memory receipt exist.

**Idempotent writes/queries:** `upsertTurnAdmission`, `getTurnAdmission`, `upsertAssistantCommit`, `getAssistantCommitReceipt` and `reconcileTurn` use the persisted turn/commit IDs. An already-completed assistant commit is returned, never inserted again.

## Context Builder

**Owner:** Companion Runtime.

**Input:** verified context DTO, session view, recent messages, MemoryContextView and an explicit token budget.

**Output:** bounded `RuntimeContext` with a status for Memory availability. It may omit Memory items when degraded but may not invent them.

## Mock Model Gateway

**Owner:** Companion Runtime test/provider boundary.

**Input:** bounded RuntimeContext and user content.

**Output:** deterministic `generation_succeeded` or typed `failed` result. It has no storage access and does not stream in this slice.

## Status mapping

Durable receipts use `pending`, `processing`, `completed`, `failed` and `dead_letter`; the target API may present `admitted`, `commit_pending` and `degraded` as domain statuses with an explicit mapping. `applied` and `retrying` are not new persisted states.

## Ingress policy

`POST /v1/events`, `/v1/sessions` and `/v1/memories` mutations require a verified internal service identity with configured issuer/audience, unexpired bearer credentials (or an equivalent mTLS-authenticated identity), producer `companion-core`, correlation ID and idempotency key. Missing/invalid service identity is `403 MEMORY_SERVICE_IDENTITY_REQUIRED`; missing mutation context is `400 MEMORY_WRITE_CONTEXT_REQUIRED`. A trusted header alone is never sufficient.
