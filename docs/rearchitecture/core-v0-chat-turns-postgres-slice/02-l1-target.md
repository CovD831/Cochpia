# R-004 L1 target and ownership

| Boundary | Sole authority and writer | Reads | Does not own |
|---|---|---|---|
| App Runtime | session metadata in cochpia_user_states | authenticated context and session metadata | Core turns or Memory facts |
| Core v0 PostgreSQL Store | core_v0 turns, bindings, commits and application messages | one tenant and subject snapshot | Memory content and session metadata |
| Memory Module PostgreSQL Repository | Memory sessions, raw events, assertions and ContextBundle inputs | one tenant and subject Memory state | Core turn status or assistant visibility |
| Production adapter | construction and read composition | shared pool and request context | durable domain facts |
| Model Gateway | generation result | bounded Context Builder output | persistence and Memory writes |

The dependency direction is HTTP route to production adapter to Core service;
Core service calls MemoryPort and ModelGateway. store.js owns the application
PostgreSQL pool and no other module constructs a pool for this path.

Session metadata deliberately remains in cochpia_user_states for this
increment. Core validates the session using the request-scoped App Runtime
state, while Core-owned messages are read from core_v0_messages. This is a
compatibility boundary, not two owners for the same message fact.

The deployment boundary remains one Node process plus one PostgreSQL database.
The independent services/memory-module process is not activated by R-004.
