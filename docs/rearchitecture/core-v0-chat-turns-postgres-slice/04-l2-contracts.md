# R-004 consumed L2 contracts

## Production adapter — established

The adapter receives request-scoped tenant, subject, actor and correlation
context plus App Runtime base state. It obtains the existing pool from
store.js, applies or checks the two canonical schemas according to policy,
constructs the PostgreSQL Core Store and PostgreSQL MemoryPort, and returns the
existing Core turn service shape. It owns construction only.

## Schema readiness — established

CORE_V0_AUTO_MIGRATE=true is an explicit development and acceptance opt-in.
Without it, the adapter performs readiness checks and returns retryable
CORE_V0_SCHEMA_NOT_READY when the reviewed schemas are absent. It does not run
DDL on every request.

## Target route — established

The route accepts sessionId, message and bounded channel plus the
Idempotency-Key header. Identity fields and Core identities remain server
owned. PostgreSQL mode uses durable adapters. JSON mode uses the R-002 adapter.
Production cannot select or fall back to the mock model.

## Core message read view — established

PostgreSQL mode reads the authenticated subject's Core Store hydration view.
The view is a query, not a write-through cache, and Core messages are never
re-saved into cochpia_user_states.

## Compatibility and failure — conditional

Legacy non-Core messages remain visible in the compatibility view. Core-owned
message edit and delete are outside this slice and must fail explicitly rather
than mutating JSON state. Production promotion remains conditional on
Auth/TLS and old-writer evidence.
