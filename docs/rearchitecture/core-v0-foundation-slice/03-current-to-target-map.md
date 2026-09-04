# R-002 current-to-target map

| Current path | Target treatment | Preserved compatibility | Removal gate |
| --- | --- | --- | --- |
| `POST /api/chat/stream` in `server/index.js` | retain as legacy fixture; extract shared validation only after target parity | existing SSE UI remains runnable | target external-result and durable-record parity |
| direct chat `recordTurn` / `finalizeMemoryModule` | replace for the target route with `MemoryPort` + turn admission + commit coordinator | legacy route remains comparison-only | exact replay, degraded retrieval and commit-failure acceptance |
| `POST /v1/events` and other Memory mutation routes | expose only to trusted internal service identity | internal contract tests may call them | missing identity/correlation/idempotency negative tests |
| `POST /api/memories` compatibility mutation | keep as a separate authenticated Memory Governance command; it cannot append a chat raw event or impersonate Core admission | existing UI path is not target chat evidence | governance adapter and policy acceptance |
| `state.messages` and JSON/JSONB store | use only through a Companion durable-store port | legacy state can seed fixtures | target store receipt and restart evidence |
| `MemoryModule.state` direct access | remove from target code | legacy compatibility may retain it temporarily | repository search shows no target direct read |

## Public write entry enforcement

The target public mutation is the Core turn command. It derives tenant/user/relationship fields from verified request context and requires an `Idempotency-Key`. Direct `/v1` Memory writes without a verified internal service identity, `producer=companion-core`, correlation ID and idempotency context are rejected with the route policy in the L2 contract. `/api/memories` mutations remain a separate user-authenticated governance adapter: they require their own command scope and idempotency key, cannot supply Core event fields, and cannot be used as a chat-event bypass.
