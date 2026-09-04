# Positioning and delivery horizon

## Problem

Cochpia has a usable chat path and substantial Memory work, but the current application still couples chat orchestration, aggregate application state, projections and Memory integration. The user needs a maintainable base that can support a real conversational loop first and accept game/task/calendar modules later without allowing each module to invent a second memory or identity authority.

## Target

The target is a Memory-first Companion Core: Memory supplies durable experience and governance; Companion Runtime owns conversation/session/current state and assembles bounded context; extension modules own their domain state and use explicit commands, events, views and receipts.

The first deployment boundary is a modular monolith with PostgreSQL and one explicit `MemoryPort`. The independent Memory HTTP service remains a compatibility and contract-test boundary until parity, migration and recovery evidence exist.

## Deliver / defer

Deliver in this package: a reviewable design boundary and the smallest chat slice that can falsify it.

Defer: game/world state, complex vector infrastructure, independent service cutover, multi-agent/community features and production-readiness claims.

## Core v0 base slice is intentionally four transitions

The first implementation is limited to `turn admission → bounded context → mock result → assistant commit`. Memory governance, projection workers, real provider streaming, regenerate/cancel recovery and cross-domain deletion are follow-up slices. This keeps the Memory-first direction while making the first proof small enough to fail honestly.

## Cross-domain deletion is a follow-up gate

The base slice does not claim that deleting a Companion Runtime message deletes every Memory-derived artifact. Cross-domain forget/delete/export must pass a separate propagation and tombstone/epoch acceptance gate before real user data is admitted.

## Extension host contract is deferred

The module contract is target intent, not an existing executable extension surface. No current code may claim plugin discovery, version negotiation or lifecycle isolation until the first real extension module is implemented and tested.

## Advancement trigger

Advance to an implementation package only when the frozen plan has an independent review report, every finding has a consumer and evidence, all blocking findings are closed, and the L3 task contract plus legacy/target fixtures are frozen.

## Stop rule

Revise the target if review evidence shows duplicate canonical writers, an unbounded Core v0, or a failure path that can return a successful chat result without a durable receipt. Preserve the existing path and keep old PRs open if the replacement boundary cannot be proven incrementally.

See the canonical plan for the full route and gates: [`companion-core-foundation-plan.md`](../../companion-core-foundation-plan.md#5-分阶段路线).
