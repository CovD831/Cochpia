# R-003 L1 target and ownership

| Fact or record | Sole owner | Writable path | Visible to |
| --- | --- | --- | --- |
| Core turn, binding, commit and application message facts | Companion Runtime PostgreSQL store | Core turn service transaction | bounded Core receipts and chat read view |
| Memory session, raw event and Memory receipts | Memory Foundation PostgreSQL adapter | MemoryPort commands | opaque receipt/context view |
| gate state, close epoch and in-flight admission leases | Companion Runtime lifecycle coordinator | database-backed lifecycle command | operator status/repair view |
| crash and repair attempts | Companion Runtime operations record | reconciliation/lifecycle recorder | operator audit, never user context |
| long-term assertions and Memory governance | Memory Module | existing Memory commands/repository | policy-filtered ContextBundle |

## Dependency direction

```text
Core HTTP adapter → Core turn service → AdmissionGate + CompanionStore
                                  └──→ PostgreSQL-shaped MemoryPort → Memory repository
Lifecycle operator → AdmissionGate → Crash/Repair recorder
```

The Core store may persist opaque Memory IDs and receipts but never writes Memory tables. The MemoryPort may call the Memory repository but never owns application messages or turn status.

The admission gate is a cross-process fence. `enter` locks the single gate row, rejects a disabled row, and inserts a lease carrying the observed `close_epoch` in the same transaction. `disable` takes the same row lock, advances the epoch and commits the closed state before waiting for leases that were already admitted. No process-local environment flag is evidence of a close.

Repair/crash records are append-only operational facts. Their stable identities, attempt numbers, close epoch, lease owner and observed external receipt state are owned by the operations recorder; they are never projected into user ContextBundles.

## Deployment boundary

The first target remains a modular monolith with one PostgreSQL database boundary exposed through typed repositories. The adapter and lifecycle code are independently testable; traffic cutover is explicitly deferred until live database and rollback evidence exists.

The first gate scope is process-wide for the Core deployment (`gate_id = core-v0`). Subject and tenant identifiers are carried on leases and repair rows when available, while the gate itself prevents any worker from admitting after the global close point.
