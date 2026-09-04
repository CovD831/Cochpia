# R-002 Core v0 Foundation Slice implementation preflight

## Frozen design input

- Package: `R-002-core-v0-foundation-slice`
- Size: `implementation`
- Baseline revision: `7327e672da36079c2f2ce37dd4ba6f9f0c6f07c2`
- Design authority: [`R-001 Core v0 design`](../core-v0-design/00-scope.md)
- Product plan: [`companion-core-foundation-plan.md`](../../companion-core-foundation-plan.md)

## Package revision provenance

The manifest keeps `7327e672da36079c2f2ce37dd4ba6f9f0c6f07c2` as the design baseline. `current_revision` denotes the immutable package content revision that was reviewed; the review report and ledger may be committed afterward, but their `input_revision` must equal that frozen value. [`check-core-v0-provenance.js`](../../../scripts/check-core-v0-provenance.js) enforces this convention.

## Objective

Freeze the smallest implementable Memory-first chat slice and its evidence gates:

```text
turn admission → bounded context → mock result → assistant commit
```

This package is the implementation preflight. It defines the L3 contract, durable records, fixtures, acceptance matrix and rollback boundary before runtime code is changed.

## In scope

- `MemoryPort` boundary for session binding, raw-event append and policy-filtered retrieval;
- public Core v0 turn admission with client idempotency;
- durable application-session/Memory-session binding and message/event correlation;
- bounded Context Builder and Mock Model Gateway contract;
- assistant commit receipt and minimal restart-safe turn status;
- negative/failure acceptance for bypass, duplicate submit, degraded retrieval and commit failure;
- one legacy fixture and one target fixture for the same chat scenario.

## Out of scope

- real provider streaming, regenerate/cancel/provider-unknown recovery;
- Memory candidate promotion, forget/delete/export propagation;
- projection workers and a general Event Log;
- games, LifeState, tasks, calendar, music, Electron or extension registry;
- closing GitHub PRs or making production-readiness claims.

Runtime code is not authorized by this preflight until its own review gate is satisfied and the R-001 blocking findings have evidence-backed closure.
