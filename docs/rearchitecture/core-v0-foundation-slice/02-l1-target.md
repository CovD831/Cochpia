# R-002 L1 target and ownership

This package inherits the system boundary from [`R-001 L1`](../core-v0-design/02-l1-target.md) and freezes only the owners consumed by the Foundation Slice.

| Fact or record | Sole owner | Writable path | Visible to |
| --- | --- | --- | --- |
| verified principal and relationship grant | Auth / Companion Context | verified request context | immutable context DTO |
| `application_session_id`, conversation messages and turn status | Companion Runtime | Core turn command and commit coordinator | chat read view |
| `memory_session_id` and raw Memory event | Memory Foundation | MemoryPort commands | bounded receipt/view |
| application-to-Memory session binding | MemoryPort integration adapter | `ensureSessionBinding` | immutable binding receipt |
| long-term assertions and governance | Memory Module | Memory governance commands only | policy-filtered ContextBundle |
| cache | cache adapter | rebuildable writes | never a canonical source |

## Dependency direction

```text
HTTP adapter → Companion turn application service → MemoryPort / ContextBuilder / MockModelGateway
                                         └──────→ Companion durable store
MemoryPort adapter → Memory runtime or PostgreSQL repository
```

The Core turn service never imports Memory repository tables or reads `MemoryModule.state`. The legacy route may still do so during comparison, but it is not a target dependency.

## Deployment boundary

The target remains a modular monolith. A fake MemoryPort is permitted only for unit tests; the PostgreSQL adapter is the production-shaped acceptance path. The independent Memory HTTP service is a contract fixture, not a second writable authority.

