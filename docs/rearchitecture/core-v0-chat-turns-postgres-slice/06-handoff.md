# R-004 implementation handoff

## Current state

Implementation is authorized by the user's ongoing Core v0 instruction. The
slice is frozen around the target chat endpoint, shared PostgreSQL pool,
canonical Memory repository and Core-backed message read view. The independent
review identified seven high-confidence risks and they are recorded as repair
work before this package can close.

## Next task

R-004-REPAIR-AND-IMPLEMENT: repair the first-write Memory CAS race, add
transactional hydration, move assistant receipt lookup to Core ownership,
expose the shared pool, add schema readiness and migration policy, then wire
the target route and read view. Run package tests and acceptance followed by
one closure adversarial review.

## Promotion trigger

Promote only when A-01 through A-12 pass, R-003 live PostgreSQL evidence
remains valid, required Auth/TLS/context-spoofing evidence exists and the
release owner has an atomic writer cutover and rollback plan. R-004 does not
close production gates or old PRs.

## Preserved paths

/api/chat/stream, legacy writers and the user's existing PRs remain unchanged.
