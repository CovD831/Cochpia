# R-002 consumed L2 contracts

The stable L2 definitions are inherited from [`R-001 L2`](../core-v0-design/04-l2-contracts.md). This file freezes only the forms consumed by the Foundation Slice.

## MemoryPort

**Owner:** Memory Foundation adapter.

**Commands:**

- `ensureSessionBinding(context, applicationSessionId, bindingKey)`;
- `appendRawEvent(context, event)`;
- `retrieveContext(context, query)`.

**Queries/views:** bounded `MemoryContextView`, never mutable Memory records.

**Receipts:** binding receipt, raw-event receipt and retrieval status.

**Failure:** retrieval may be `available`, `degraded`, `not_found` or `uncertain`; append/binding returns `pending` or `failed` when durable admission is not known.

## Companion Durable Store

**Owner:** Companion Runtime.

**Records:** `memory_session_binding`, `turn_admission`, `conversation_message` and `assistant_commit`.

**Invariant:** a user turn is not exposed as an admitted/completed turn until the corresponding durable record and required Memory receipt exist.

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

