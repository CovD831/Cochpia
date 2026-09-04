# R-002 implementation handoff

## Preflight status

The first preflight review is complete and is `blocked`. The contract fixes are recorded in the package, but runtime evidence is still pending. R-001 remains blocked until its closure findings have evidence-backed resolution.

## Code-entry gate

Runtime code may start only after:

- this package passes its own package checker;
- an independent review consumes all blocking findings for this package;
- binding uniqueness and conflict behavior are frozen;
- target and legacy fixtures exist;
- ingress, duplicate-submit, degraded-retrieval, commit-failure and restart acceptance commands are named;
- the user has not requested an exception to the R-001 blocked gate.

The fixture/schema tests currently pass; `scripts/core-v0-foundation-acceptance.js` deliberately reports runtime rows as `pending` when no target adapter is supplied. That is an honest preflight result, not implementation evidence.

## Next task

`R-002-PREFLIGHT-REVIEW-CONSUME`: consume the first review findings, run the closure review, and only after it passes consider the target application service. Do not migrate the UI or close old PRs in the same increment.

## Definition of done for the increment

The target path produces comparable external results and durable receipts for the target fixture, exact replay is idempotent, conflicting replay is rejected, degraded Memory is explicit, commit failure cannot appear as success, and a restart can re-read pending records. Anything else remains deferred.
