# R-001 Core v0 design scope

## Frozen baseline

- Package: `R-001-core-v0-design`
- Size: `design`
- Frozen input revision: `6923833`
- Architecture authority: [`companion-core-foundation-plan.md`](../../companion-core-foundation-plan.md)
- Review input: the plan at revision `6923833`, including its Core v0 supplement.

## In scope

This package reviews and stabilizes the design for a Memory-first Companion Core:

- Core v0 scope and non-goals;
- canonical ownership for identity, session/current state, raw events, Memory and projections;
- the modular-monolith plus PostgreSQL first deployment boundary;
- the first chat vertical slice and its failure/recovery semantics;
- the extension-module contract and the migration boundary around the existing Memory runtime;
- an independent adversarial review, its consumption ledger and the handoff gate.

## Out of scope

- implementing the Core v0 slice;
- introducing an independent global event service;
- migrating LifeState, games, Electron, tasks, calendar or music;
- closing or mutating GitHub pull requests;
- declaring the Memory Module production-ready.

The implementation package must be created only after this design package has a consumed review with no open blocking finding.

## AR-007 current-state audit correction

The frozen plan contained an implementation-style audit that did not match baseline `7e86878`. This package treats `server/index.js`, the current Memory runtime and the existing Memory service as baseline evidence; names such as `InteractionCollector`, `CompanionOrchestrator` and `ContextBuilder` are target design terms until code and tests prove them.
