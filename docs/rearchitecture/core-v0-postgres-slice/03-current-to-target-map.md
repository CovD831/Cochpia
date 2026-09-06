# R-003 current-to-target map

| Current hotspot | Treatment | Current authority | Target authority | Promotion/removal gate |
| --- | --- | --- | --- | --- |
| `server/core-v0.js` array-backed `createCoreV0Store` | retain as local fixture; adapt behind the same store shape | process memory plus JSON persistence | CompanionStore contract with relational implementation in `server/core-v0-postgres.js` | shaped adapter parity and restart acceptance |
| `server/memory-module-postgres.js` full subject repository | expose through MemoryPort adapter | Memory PostgreSQL repository | typed MemoryPort commands/receipts | conflict retry and receipt reconciliation |
| `server/store.js` JSON/JSONB user state | retain for legacy and non-Core routes | main application state | Core operational records in dedicated tables | live traffic cutover and migration evidence |
| `CORE_V0_ENABLED` request check | split into gate plus compatibility flag | per-request environment read | database-backed AdmissionGate close epoch and lease fence | two-worker close race and operator repair evidence |
| in-process pending turn state | adapt | Core arrays | durable repair/crash attempt records | restart fixture and no-false-success check |
| legacy `/api/chat/stream` and independent `/v1` writers | retain as comparison/compatibility paths | legacy route/runtime | unchanged until explicit cutover | equivalent evidence and separate GitHub decision |

No new global bus or second Memory authority is introduced. The package adds only the storage/lifecycle mechanisms consumed by the R-003 scenario.

## Compatibility fence before promotion

Before any route switch, the target store, admission gate and legacy writer policy must be changed as one deployment decision. R-003 leaves the old route and JSON/JSONB state writer executable; its acceptance command records this as deferred rather than counting the new adapter's isolated success as a cutover.

The rerunnable local fence rehearsal is `scripts/core-v0-postgres-rollback-rehearsal.js` with fixture `fixtures/rollback-drain-rehearsal.json`. It closes the target admission gate before a switch, records timed-out work, reconciles the same repair identity through authoritative receipt/Core-commit lookups, and exercises an explicit policy state that leaves the legacy writer active. This establishes local ordering and policy semantics only; the deployed writer fence remains a promotion gate.

The explicit live evidence path is `scripts/core-v0-postgres-live-acceptance.js` with `fixtures/live-postgres-acceptance.json` and `scripts/core-v0-postgres-live-worker.js`. It is isolated by a generated PostgreSQL schema and two real worker processes; it proves database-backed CAS and lifecycle ordering without making the new adapter the application traffic writer.
