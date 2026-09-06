# R-005 L1 target and ownership

| Boundary | Sole authority and writer | Reads | Does not own |
|---|---|---|---|
| App Runtime | session metadata in cochpia_user_states | authenticated context | extraction, projection, Memory facts |
| Core v0 PostgreSQL Store | turns, bindings, commits, application messages | one tenant and subject snapshot | extraction decisions, Memory writes |
| Memory Module (in-process) | raw events, assertions, versions, snapshots, snapshot items | one tenant and subject Memory state | Core tables, turn status |
| Extraction drain | candidate creation and promotion from raw events | memory outbox and raw events for one subject | Core writes, snapshot rebuild for foreign assertions |
| Projection side effect | snapshot_items rows for the promoting subject's active sessions | active assertions of the same subject | assertions themselves, Core tables |
| Model Gateway | extraction generations | bounded raw event content | persistence, retrieval |

The dependency direction stays: turn entry path to drain to Memory Module
internals. The drain never calls Core and never blocks a committed turn.
