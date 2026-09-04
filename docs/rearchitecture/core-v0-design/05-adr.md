# Architecture decision records

## ADR-001: start as a modular monolith with PostgreSQL

**Status:** proposed pending consumed review.

**Decision:** run Core v0 and Memory behind one process boundary with one explicit MemoryPort and a clear PostgreSQL persistence authority.

`MemoryPort` is a target boundary, not an existing implementation claim. The current JSON/JSONB and independent-service paths remain baseline fixtures until an adapter, migration and rollback evidence exist.

**Alternatives:** make the independent Memory HTTP service the immediate source of truth; keep both in-process and HTTP paths writable; postpone ownership decisions.

**Consequences:** the first slice is easier to replay and debug, but the service boundary is not proven by deployment alone. Cutover is deferred until parity, migration, reconciliation and recovery evidence exist.

## ADR-002: reuse Memory raw events for the first slice

**Status:** proposed pending consumed review.

**Decision:** use the existing Memory raw-event/outbox capability behind MemoryPort before deciding whether a general Event Log is warranted.

**Alternatives:** introduce a new global bus/event database immediately; let each module write its own event stream.

**Consequences:** Core v0 avoids a third fact source. The extraction decision remains open until ownership, ordering and recovery evidence from the chat slice exists.

## ADR-003: keep legacy PRs until a replacement is reviewable

**Status:** proposed.

**Decision:** do not close PR1–PR7 while the replacement implementation is only a local design branch. After a replacement PR exists, mark superseded, preserve review links, and close in dependency reverse order only when the replacement has equivalent or better evidence.

**Consequences:** review history and fallback paths remain available. Closing is an explicit GitHub mutation and is outside this package's scope.
