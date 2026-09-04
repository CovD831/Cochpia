# R-002 acceptance matrix

All rows must have a named command and a pass/fail artifact before runtime code is merged. The current package records the required oracle; it does not claim these rows have passed.

| ID | Fixture | Check | Pass condition | Failure meaning |
| --- | --- | --- | --- | --- |
| A-01 | target | first admission | one binding, one user message, one raw event, one admission receipt | duplicate canonical facts or missing correlation |
| A-02 | target replay | same idempotency key | same receipt; no second Memory/model call | Core turn idempotency is broken |
| A-03 | target conflict | same key, changed normalized input | `409 IDEMPOTENCY_KEY_CONFLICT`; no new record | conflicting replay can corrupt a turn |
| A-04 | target | session binding | exact pair is stable; conflicting pair is rejected | session mapping can drift |
| A-05 | target | Memory retrieval outage | response is explicit `degraded`; no guessed memory | unavailable Memory is hidden or hallucinated |
| A-06 | target | admission unknown/failure | `pending`/`failed`; no model call and no completed assistant message | unadmitted turn can appear successful |
| A-07 | target | assistant commit failure | no completed assistant message; receipt is `failed` or `commit_pending` | commit error is swallowed |
| A-08 | target restart | restart with pending record | same turn/event IDs are resumed or safely reported pending | restart creates duplicates or loses state |
| A-09 | public ingress | direct `/v1/events` without service identity/context | request rejected; no Memory mutation | Collector boundary can be bypassed |
| A-10 | public ingress | direct Memory mutation without producer/correlation/idempotency | request rejected or routed to scoped governance adapter | internal route is publicly writable |
| A-11 | legacy/target | same scenario parity | external result, durable message facts, Memory receipt and checkpoint are comparable; known legacy gaps are listed | “it runs” is being mistaken for parity |

## Verification commands

The implementation package must add and then run commands equivalent to:

```text
npm test -- server/core-v0-foundation.test.js server/core-v0-ingress.test.js
node scripts/core-v0-foundation-acceptance.js
python3 /Users/abab/.codex/skills/rearchitecture-development-workflow/scripts/check_package.py docs/rearchitecture/core-v0-foundation-slice
```

The acceptance script must emit a JSON artifact under an ignored temporary path and report each row as pass/fail/pending without including message content or credentials.

