# R-004 acceptance matrix

| ID | Scenario | Expected evidence |
|---|---|---|
| A-01 | JSON legacy construction | R-002 adapter remains executable |
| A-02 | PostgreSQL target construction | one shared pool plus Core and Memory adapters |
| A-03 | request identity | tenant and subject come from context |
| A-04 | exact replay | fresh store returns same turn and no model call |
| A-05 | changed replay | changed fingerprint is rejected |
| A-06 | read parity | Core messages and legacy messages are visible after restart |
| A-07 | Memory receipts | binding and raw event identities are preserved |
| A-08 | degraded retrieval | turn can commit with degraded Memory status |
| A-09 | commit failure | no assistant success is exposed |
| A-10 | schema policy | readiness-only and explicit migration are distinguishable |
| A-11 | production model | mock provider is rejected in production |
| A-12 | rollback | flag-off local path and legacy stream remain available |

Executable checks are npm run test:core-v0-production, npm run
acceptance:core-v0-chat-turns, and the rearchitecture package checker. Local
acceptance uses paired fixtures and controlled database doubles. Real database
locking remains evidenced by R-003 live acceptance.
