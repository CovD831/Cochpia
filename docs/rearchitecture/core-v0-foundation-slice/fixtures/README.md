# R-002 fixtures

The fixtures use the same scenario so legacy and target paths can be compared without comparing unrelated inputs.

## Scenario

One authenticated user sends one message in one application session; Memory has one existing bounded context item; the model returns a deterministic response; the assistant result is committed.

## Required fixtures

- `legacy-chat-turn.json`: invokes the existing `/api/chat/stream` adapter with the current message/session shape and records the externally visible result plus the relevant state/Memory observations.
- `target-chat-turn.json`: invokes `POST /api/chat/turns` with `Idempotency-Key`, the same normalized message and the expected binding/event/turn receipts.

The fixture runner must capture request/response status, model-call count, MemoryPort-call count, durable record counts, receipt IDs, checkpoint/revision and known legacy gaps. It must not persist fixture content as real user data.

## Variants used by acceptance

- exact replay with the same key;
- conflicting replay with the same key and a different message;
- Memory retrieval unavailable;
- raw event admission pending/failed;
- assistant commit failure;
- process restart with `admission_pending` or `commit_pending`.

The fixture data contains synthetic IDs and text only; it must not contain real credentials or user conversations.
