# R-004 scope: production Core v0 chat-turn adapter

## Position in the program

- Package: R-004-core-v0-chat-turns-postgres
- Baseline: 1800ff8 plus the existing working-tree R-003 verification changes.
- Design authority: ../core-v0-design/00-scope.md
- Previous implementation slice: ../core-v0-postgres-slice/00-scope.md

## Problem

R-003 proves the relational Core store and PostgreSQL-shaped MemoryPort in
isolated fixtures, but /api/chat/turns still constructs an in-process Memory
Port and the JSON message view is stale after a restart. This slice makes the
existing target route use the shared application PostgreSQL pool and makes the
session message read view hydrate from Core-owned rows.

## In scope

- A request-scoped production adapter reusing the pool owned by store.js.
- Explicit Core and Memory schema readiness plus opt-in development migration.
- PostgreSQL Core Store and PostgreSQL MemoryPort construction for the target route.
- The JSON and in-process adapter as a bounded local fallback.
- Real model selection for the target route and production mock prohibition.
- Core-backed reads for session messages and channel counts.
- Paired fixtures, tests, acceptance output and rollback policy.

## Explicitly deferred

- /api/chat/stream, regeneration, group chat, tools, Pi RPC and the UI.
- Moving session metadata out of cochpia_user_states.
- A new Core session table, independent Memory process, generic bus or cache.
- Production Auth/TLS proof, traffic promotion, writer disablement and deployment rollback.

## Sole authority

App Runtime owns session metadata. Core PostgreSQL owns turn admissions, Core
application messages, assistant commits and receipts. The Memory PostgreSQL
schema owns Memory sessions, raw events, canonical assertions and ContextBundle
inputs. The adapter composes these authorities and never copies Memory facts
into Core state.
