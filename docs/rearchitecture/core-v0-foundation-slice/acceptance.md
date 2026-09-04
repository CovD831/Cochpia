# R-002 acceptance matrix

All rows must have a named command and a pass/fail artifact before runtime code is merged. The current package records the required oracle; it does not claim these rows have passed.

| ID | Fixture | Check | Pass condition | Failure meaning |
| --- | --- | --- | --- | --- |
| A-01 | target | first admission | one binding, one user message, one raw event, one admission receipt | duplicate canonical facts or missing correlation |
| A-02 | target replay | same idempotency key | same receipt; no second Memory/model call | Core turn idempotency is broken |
| A-03 | target conflict | same key, changed normalized input | `409 IDEMPOTENCY_KEY_CONFLICT`; no new record | conflicting replay can corrupt a turn |
| A-04 | target | session binding | both independent unique keys hold; exact pair is stable; either conflicting pair is rejected | session mapping can drift |
| A-05 | target | Memory retrieval outage | response is explicit `degraded`; no guessed memory | unavailable Memory is hidden or hallucinated |
| A-06 | target | admission unknown/failure | `pending`/`failed`; no model call and no completed assistant message | unadmitted turn can appear successful |
| A-07 | target | assistant commit failure | no completed assistant message; receipt is `failed` or `commit_pending` | commit error is swallowed |
| A-08 | target restart | restart with pending record | receipt queries/reconcile use the same IDs; same turn/event IDs are resumed or safely reported pending | restart creates duplicates or loses state |
| A-09 | public ingress | direct `/v1/events` without verified service identity | `403 MEMORY_SERVICE_IDENTITY_REQUIRED`; no Memory mutation | Collector boundary can be bypassed |
| A-10 | public ingress | direct `/v1` mutation without producer/correlation/idempotency | `400 MEMORY_WRITE_CONTEXT_REQUIRED`; no Memory mutation | internal route is publicly writable |
| A-11 | public governance | `/api/memories` chat-shaped payload or Core event fields | rejected or handled only as scoped governance; no raw chat event | governance route becomes event bypass |
| A-12 | legacy/target | same scenario parity | external result, durable message facts, Memory receipt and checkpoint are comparable; known legacy gaps are listed | “it runs” is being mistaken for parity |

## Verification commands

The implementation package must add and then run commands equivalent to:

```text
node --test server/core-v0-foundation.test.js server/core-v0-ingress.test.js
node scripts/core-v0-foundation-acceptance.js
python3 /Users/abab/.codex/skills/rearchitecture-development-workflow/scripts/check_package.py docs/rearchitecture/core-v0-foundation-slice
```

The acceptance script must emit a JSON artifact under an ignored temporary path and report each row as pass/fail/pending without including message content or credentials. Until the target runtime module is supplied, it must exit non-zero with `pending` rows; fixture/schema validation passing is not runtime evidence.

## Preflight execution status

The package-level fixture and ingress-shape tests are executable now and are expected to pass. The runtime rows are intentionally `pending` until the target application service, MemoryPort adapter and route guards exist. This distinction is part of the gate; a passing schema harness must not close the runtime findings.
