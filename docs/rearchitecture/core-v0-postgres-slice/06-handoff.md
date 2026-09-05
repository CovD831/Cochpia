# R-003 implementation handoff

## Current outcome

This increment is implementation-authorized by the user's ongoing Core v0 instruction. The independent adversarial review was consumed: four blocking findings were resolved in the row-level contract and executable shaped implementation, while three non-blocking findings remain explicit promotion backlog. The target route remains on the R-002 in-process adapter until R-003 acceptance and live-environment promotion evidence exist.

## Review and implementation sequence

1. Review this package's scope, ownership, SQL identity constraints and lifecycle race assumptions.
2. Consume every review finding into the package ledger.
3. Implement and test `server/core-v0-postgres.js`, `server/core-v0-schema.sql`, the shaped relational fixture, and the package acceptance command.
4. Run shaped fixtures and leave live PostgreSQL rows pending when no database is configured.

## Next task

`R-003-VERIFY-AND-PROMOTE`: run package checker, unit/fixture tests and acceptance; keep live Auth/TLS/two-process rows pending without a configured database.

## Promotion trigger

Promote only after P-01 through P-08 pass, L-01/L-02 pass in a real required-Auth/TLS PostgreSQL environment, and a bounded rollback/drain drill leaves no ambiguous external outcome. Do not migrate the UI or close old PRs in this increment.

## Implementation evidence is now present

The shaped implementation and its executable evidence are `server/core-v0-postgres.js`, `server/core-v0-schema.sql`, `server/core-v0-postgres-fixture.js`, `server/core-v0-postgres.test.js`, `scripts/core-v0-postgres-acceptance.js`, and the two JSON fixtures under `fixtures/`. These prove only the isolated R-003 slice; they do not authorize route cutover.

## Live promotion backlog

The remaining open review items are the live Auth/TLS/context-spoofing gate, the explicit old-writer cutover fence, and the per-field complexity traceability check. Each has a named promotion trigger in the package documents.
