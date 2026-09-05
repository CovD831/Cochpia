# R-002 implementation handoff

## Preflight status (historical)

The preflight review and closure reviews completed before runtime work. At that point runtime evidence was intentionally pending; the current implementation result below supersedes that pending state. The package-level provenance and acceptance gates remain recorded mechanically, while R-001 remains blocked until its closure findings have evidence-backed resolution.

## Code-entry gate (historical)

Runtime code may start only after:

- this package passes its own package checker;
- an independent review consumes all blocking findings for this package;
- binding uniqueness and conflict behavior are frozen;
- target and legacy fixtures exist;
- ingress, duplicate-submit, degraded-retrieval, commit-failure and restart acceptance commands are named;
- the user has not requested an exception to the R-001 blocked gate.

The fixture/schema tests passed during preflight; `scripts/core-v0-foundation-acceptance.js` deliberately reported runtime rows as `pending` when no target adapter was supplied. That was an honest preflight result, not implementation evidence.

## Next task from preflight (superseded)

`R-002-PREFLIGHT-REVIEW-CONSUME`: consume the first review findings, run the closure review, and only after it passes consider the target application service. Do not migrate the UI or close old PRs in the same increment.

The final closure review found two package-level defects: provenance was not aligned to the reviewed commit, and an injected acceptance adapter could omit required rows without failing. The harness defect is fixed and the provenance convention is now checked mechanically. This closes the preflight package gate; it does not remove R-001's runtime-evidence gate.

## Definition of done for the increment

The target path produces comparable external results and durable receipts for the target fixture, exact replay is idempotent, conflicting replay is rejected, degraded Memory is explicit, commit failure cannot appear as success, and a restart can re-read pending records. Anything else remains deferred.

## Runtime implementation result — September 5, 2026

The user explicitly authorized implementation after the preflight gate. Core v0 is now implemented as a feature-flagged, non-streaming target route in the modular monolith. The route uses the in-process Memory Module through `MemoryPort`, keeps `/api/chat/stream` as the legacy comparison path, and does not migrate the UI.

The implementation checkpoint is commit `4ff2803` on branch `codex/core-v0-foundation`.

The runtime acceptance adapter passes A-01 through A-12. The implementation also scopes failure rollback to the affected session, permits reconciliation while new admissions are disabled, and blocks secret-like content before durable admission. The implementation review is recorded in [`08-implementation-review.md`](08-implementation-review.md). The result is local modular-monolith evidence only; it is not evidence for PostgreSQL horizontal scaling or the independent Memory service.

## Next task

`R-003-POSTGRES-MEMORYPORT`: add the PostgreSQL-shaped durable adapter and prove the same receipts, ownership boundaries, and recovery behavior before changing client traffic.
