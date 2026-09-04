# Current-to-target map for the first chat slice

The full target route is maintained in [`companion-core-foundation-plan.md`](../../companion-core-foundation-plan.md#7-迁移与兼容策略). This map limits the first implementation to the call family that turns a user message into a committed assistant result.

| Current hotspot | Treatment | Current authority | Target authority | Removal / promotion gate |
| --- | --- | --- | --- | --- |
| `server/index.js` chat assembly | split / expose | application entrypoint and mixed orchestration | `CompanionOrchestrator` with explicit ports | target and legacy acceptance parity |
| chat `recordTurn` and assistant finalize path | adapt | chat route plus Memory runtime calls | Collector → Context Builder → Model Gateway → Commit Coordinator | duplicate-submit, failure and recovery tests |
| Memory raw event and outbox | retain behind port | Memory runtime | `MemoryPort` for Core v0 | in-process/HTTP parity and receipt evidence |
| primary JSON/JSONB aggregate state | constrain / deprecate per field | main application state | session/current-state owner by explicit record | field-level owner and CAS/reconciliation evidence |
| compatibility `/api` and `/v1` routes | expose / adapt | public and internal mixed boundaries | public adapter enters Collector; `/v1` write path is service-only | auth/context negative tests and replacement route |
| direct `module.state` reads | remove from extension surface | compatibility layer and services | bounded view/receipt or typed command | no extension reads of Memory internals |
| game/LifeState adapters | defer | existing product modules | future Extension Module | Core v0 chat acceptance complete |

The legacy path remains executable as the comparison fixture. A lower dependency count alone is not considered evidence of decoupling.

## Public write entry enforcement

The first target change is an ingress rule, not a new global bus: public chat and memory writes enter one Collector/admission boundary; the existing `/v1` Memory route is internal-only and must reject missing service identity, correlation and idempotency context. The compatibility path remains available for comparison until the replacement acceptance matrix passes.
