# R-004 positioning and delivery horizon

This increment delivers one target request path: an authenticated request
enters /api/chat/turns, derives identity from existing request context, opens
the shared PostgreSQL Core and Memory boundaries, completes one bounded Core
turn, and can read the same committed messages from a fresh request.

The increment defers stream migration and the session-metadata authority
decision. Advancement requires the R-004 acceptance matrix, cross-request
hydration, explicit schema and failure behavior, and an independent review with
no open blocking finding. Production Auth/TLS and writer cutover evidence are
separate release gates.

The complexity budget is one production adapter, one shared-pool accessor, one
schema-readiness policy and one Core-backed message read view. No bus,
scheduler, cache, session table or plugin registry is introduced.

The route returns pending for unknown durable outcomes, degraded Memory status
when retrieval fails but the turn can continue, and a non-success error for
schema or model configuration failures. It never reports an assistant commit
before that commit receipt is durable.
