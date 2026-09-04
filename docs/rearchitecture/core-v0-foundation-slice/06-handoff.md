# R-002 implementation handoff

## Preflight status

This package freezes the implementation contract but does not yet claim runtime evidence. R-001 remains blocked until its closure findings have evidence-backed resolution.

## Code-entry gate

Runtime code may start only after:

- this package passes its own package checker;
- an independent review consumes all blocking findings for this package;
- binding uniqueness and conflict behavior are frozen;
- target and legacy fixtures exist;
- ingress, duplicate-submit, degraded-retrieval, commit-failure and restart acceptance commands are named;
- the user has not requested an exception to the R-001 blocked gate.

## Next task

`R-002-PREFLIGHT-REVIEW`: review the L3 contract, fixtures, acceptance matrix and rollback note. If the review passes, implement only the target application service and its tests; do not migrate the UI or close old PRs in the same increment.

## Definition of done for the increment

The target path produces comparable external results and durable receipts for the target fixture, exact replay is idempotent, conflicting replay is rejected, degraded Memory is explicit, commit failure cannot appear as success, and a restart can re-read pending records. Anything else remains deferred.

