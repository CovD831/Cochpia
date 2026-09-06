# R-003 implementation handoff

## Current outcome

This increment is implementation-authorized by the user's ongoing Core v0 instruction. The independent adversarial review was consumed: four blocking findings were resolved in the row-level contract and executable shaped implementation. The local verification now also includes a bounded rollback/drain rehearsal; the target route remains on the R-002 in-process adapter until live-environment promotion evidence exists.

The second independent review of the rollback/drain addition found five required defects and one optional weakness. The defects were consumed by the receipt/Core-commit reconciliation path, completion-proof guard, required repair recorder, stateful policy rehearsal and strict fixture comparison. The optional source-text scan was removed. The final independent closure review passed with no blocking findings; the live Auth/TLS/context-spoofing finding remains open by design.

## Review and implementation sequence

1. Review this package's scope, ownership, SQL identity constraints and lifecycle race assumptions.
2. Consume every review finding into the package ledger.
3. Implement and test `server/core-v0-postgres.js`, `server/core-v0-schema.sql`, the shaped relational fixture, and the package acceptance commands.
4. Run shaped fixtures and the rollback/drain rehearsal; leave live PostgreSQL rows pending when no database is configured.

## Next task

`R-003-LIVE-PROMOTION-GATE`: run `npm run acceptance:core-v0-postgres-live` against an isolated real PostgreSQL environment, inspect its L-01/L-02 artifact, and then decide whether to promote the adapter and gate together or preserve the legacy route.

## Promotion trigger

Promote only after P-01 through P-10 pass, L-01/L-02 pass in a real required-Auth/TLS PostgreSQL environment, and a live bounded rollback/drain drill leaves no ambiguous external outcome. Do not migrate the UI or close old PRs in this increment.

The live harness is now present but does not itself close the promotion gate. It requires the caller to opt in with `CORE_V0_LIVE_ACCEPTANCE=true` and `CORE_V0_LIVE_ENV=isolated`; it creates and removes only a generated `core_v0_live_*` schema and records no connection string or message content. A local PostgreSQL run with TLS disabled can produce L-02 evidence while leaving L-01 pending. The live run proves PostgreSQL Core/MemoryPort persistence, CAS, gate and repair-receipt evidence; rollback remains a deployment promotion gate, and the helper context test does not substitute for production Auth/context-route evidence.

## Implementation evidence is now present

The shaped implementation and its executable evidence are `server/core-v0-postgres.js`, `server/core-v0-schema.sql`, `server/core-v0-postgres-fixture.js`, `server/core-v0-postgres.test.js`, `scripts/core-v0-postgres-acceptance.js`, `scripts/core-v0-postgres-rollback-rehearsal.js`, and the JSON fixtures under `fixtures/`. These prove only the isolated R-003 slice; they do not authorize route cutover.

## Live promotion backlog

The remaining open promotion item is the production Auth/TLS/context-route gate and deployment rollback evidence. The two-process and live Memory receipt evidence path is executable, but production route validation and the old-writer cutover decision are still required before promotion.
