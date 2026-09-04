# L1 target: Memory-first Companion Core

This package adopts the L1 target in [`companion-core-foundation-plan.md`](../../companion-core-foundation-plan.md#2-目标架构). This file records the boundary facts needed by the review; detailed method signatures remain deferred to the implementation package.

## Subsystems and sole authorities

| Subsystem | Sole authority | Direction |
| --- | --- | --- |
| Auth / Companion Context | verified identity, tenant, relationship and grant context | supplies immutable context DTOs |
| Companion Runtime | session, conversation messages and short-lived current state | calls MemoryPort and policy; never writes Memory tables directly |
| Memory Foundation | raw interaction event receipt, long-term assertions, governance and derived memory indexes | accepts typed commands and returns bounded views/receipts |
| Relationship / Personality projections | versioned projection state and provenance | consume events; expose bounded read views |
| Extension Modules | their own commands, events and domain state | depend on Core contracts, not Memory internals |
| PostgreSQL repository | durable persistence for the selected modular-monolith deployment | one explicit persistence authority per canonical record |

## Controlled communication

Cross-boundary calls are one of: typed command, immutable query/view, bounded context transfer, or durable receipt/evidence. Internal domain events are emitted by trusted dispatchers and never re-enter public ingress as if they were user commands.

## Deployment boundary

Core v0 runs in one application process boundary with PostgreSQL. The in-process Memory runtime and the independent Memory service must not be simultaneous writable canonical sources. A service cutover requires contract parity, migration, reconciliation and restart/recovery evidence.

## Open L1 questions

The timing of extracting a general Event Log from Memory raw events remains conditional. It is resolved by the first-slice ownership and recovery evidence, not by adding a second event store in advance.

## application_session_id ↔ memory_session_id mapping

`application_session_id` is owned by Companion Runtime. `memory_session_id` is owned by Memory Foundation. The MemoryPort adapter owns one durable, immutable binding record that relates the two; it is a link, not a second owner for either session. Every raw event and message correlation carries `application_message_id`, `application_session_id`, `memory_session_id` and `source_revision` when the corresponding value exists; `null` is not used as a substitute for an unresolved mapping.
