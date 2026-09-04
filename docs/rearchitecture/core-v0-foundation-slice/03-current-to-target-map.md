# R-002 current-to-target map

| Current path | Target treatment | Preserved compatibility | Removal gate |
| --- | --- | --- | --- |
| `POST /api/chat/stream` in `server/index.js` | retain as legacy fixture; extract shared validation only after target parity | existing SSE UI remains runnable | target external-result and durable-record parity |
| direct chat `recordTurn` / `finalizeMemoryModule` | replace for the target route with `MemoryPort` + turn admission + commit coordinator | legacy route remains comparison-only | exact replay, degraded retrieval and commit-failure acceptance |
| `POST /v1/events` and other Memory mutation routes | expose only to trusted internal service identity | internal contract tests may call them | missing identity/correlation/idempotency negative tests |
| `POST /api/memories` compatibility mutation | keep outside Foundation Slice; route future user governance through a scoped adapter | existing UI path is not target evidence | governance adapter and policy acceptance |
| `state.messages` and JSON/JSONB store | use only through a Companion durable-store port | legacy state can seed fixtures | target store receipt and restart evidence |
| `MemoryModule.state` direct access | remove from target code | legacy compatibility may retain it temporarily | repository search shows no target direct read |

## Public write entry enforcement

The target public mutation is the Core turn command. It derives tenant/user/relationship fields from verified request context and requires an `Idempotency-Key`. Direct `/v1` Memory writes without trusted service identity, correlation and idempotency context are rejected; explicit Memory governance is a separate scoped command and is not silently treated as a chat event.

