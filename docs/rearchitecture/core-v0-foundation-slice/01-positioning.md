# R-002 positioning and delivery horizon

## User problem

The current chat route mixes message persistence, Memory calls, model generation, SSE state and finalization in `server/index.js`. The first replacement must make the Memory-first boundary executable without requiring the game or the rest of the product to migrate at the same time.

## Deliverable

One reviewable target path that admits a user turn exactly once, records its Memory event with a stable correlation, builds bounded context, produces a deterministic mock result and commits the assistant result with a durable receipt.

## Explicit deferrals

- Existing `/api/chat/stream` remains a legacy comparison path; the target preflight uses a non-streaming application command so streaming recovery is not hidden inside the first proof.
- Cross-domain deletion/export, real provider behavior, projection workers, personality evolution and extension hosting remain separate packages.
- The existing JSON/JSONB store may be a legacy or test fixture, but it is not evidence for the production PostgreSQL boundary.

## Advancement trigger

Advance to runtime implementation only when:

1. this L3 contract is independently reviewed;
2. the binding, admission and commit records have a chosen durable adapter;
3. legacy/target fixtures and the acceptance matrix are executable;
4. public ingress negative tests are defined for `/v1` and direct Memory writes;
5. R-001 CR-001 through CR-003 are closed with evidence or an explicitly approved exception.

## Stop rule

Stop and preserve the legacy path if the target requires dual writable Memory authorities, cannot return a stable receipt for exact replay, or would expose a successful assistant message before admission and commit are durable.

