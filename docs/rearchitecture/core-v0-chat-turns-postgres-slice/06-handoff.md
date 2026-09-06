# R-004 implementation handoff

## Current state

R-004-REPAIR-AND-IMPLEMENT is complete. The target chat route constructs the
PostgreSQL production adapter from the shared application pool, schema
readiness inspects tables and required columns for both owners, the session
message view is a bounded session-scoped Core query merged with legacy rows,
request context fails closed on tenant, subject, actor or correlation
identity gaps, and all Core v0 routes share one error shape. The closure
adversarial review verified all seven input findings repaired and recorded
five advisories (R4-CR-001..005) with no blocking findings.

## Evidence

- npm test: 291 checks green
- npm run test:core-v0-production: readiness structure, context tightening,
  bounded view, commit-time monotonicity
- npm run acceptance:core-v0-chat-turns: A-01 through A-12 pass
- scripts/check-core-v0-provenance.js: ok
- Commits: 1d8053a (baseline), e348b0a, e352f84, 561c968, 4f0f4ac

## Next task

R-004-PROMOTION-PREPARE: gather the Auth/TLS and context-spoofing evidence,
keep R-003 live PostgreSQL evidence valid, and prepare the atomic writer
cutover and rollback plan. The rollback rehearsal and legacy stream path
remain available (A-12).

## Promotion trigger

Promote only when A-01 through A-12 pass, R-003 live PostgreSQL evidence
remains valid, required Auth/TLS/context-spoofing evidence exists and the
release owner has an atomic writer cutover and rollback plan. R-004 does not
close production gates or old PRs.

## Preserved paths

/api/chat/stream, legacy writers and the user's existing PRs remain unchanged.
