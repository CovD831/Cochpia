# R-004 L3 task contract

## Construction

createCoreV0ProductionAdapter owns a cached shared-pool accessor and one schema
preparation promise. Its request method calls createPostgresCoreV0Store,
createMemoryModulePostgresRepository and createPostgresMemoryPort, then
constructs createCoreV0TurnService with the request state and selected model
gateway. No user or message state is cached across requests.

## Route and persistence

POST /api/chat/turns requires Idempotency-Key and a body containing sessionId,
message and optional channel. Identity derives from the authenticated request.
PostgreSQL mode uses the production adapter; JSON mode uses the existing local
adapter. The production target rejects mock generation.

Core writes turn and message rows with subject CAS. Memory writes preserve the
original binding and event identities. Retrieval failure is degraded; unknown
Memory or Core outcomes are pending and unknown. A completed assistant result
requires a durable Core commit receipt.

Session message and channel reads hydrate a fresh Core view in PostgreSQL mode
and never write it to JSON. Core message edit and delete are unsupported here.

## Schema policy and definition of done

Default is readiness-only. CORE_V0_AUTO_MIGRATE=true is controlled development
and acceptance behavior. A configured but unreachable or incomplete database is
not converted into JSON success.

Done means paired fixtures, shared-pool and context tests, exact replay,
restart read parity, Memory receipt checks, degraded retrieval, assistant
commit failure, schema policy, production model boundary, package checker,
tests, build, diff checks and secret scan all pass. Production Auth/TLS and
traffic promotion remain pending.
