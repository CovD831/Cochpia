# R-004 implementation decisions

## ADR-004-01: reuse the application PostgreSQL pool

Decision: store.js remains the sole pool constructor and the production
adapter receives its accessor. A second pool or an independent Memory process
would add lifecycle ownership without helping this modular-monolith slice.

## ADR-004-02: explicit schema readiness and opt-in migration

Development may set CORE_V0_AUTO_MIGRATE=true. Normal and production paths
require pre-applied schemas and fail closed when absent. Migration locking is
owned by the adapter so multiple processes do not run DDL concurrently.

## ADR-004-03: retain session metadata in the compatibility owner

R-004 does not add a Core session table. cochpia_user_states remains the owner
of session title, persona, mode and other metadata until a later package
explicitly migrates that authority.

## ADR-004-04: hydrate reads instead of copying Core messages

Message and channel reads use a subject and session scoped Core hydration view
in PostgreSQL mode. No JSON projection is written by the target route.
