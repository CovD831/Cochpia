# R-002 acceptance matrix

## Runtime result — September 5, 2026

`npm run acceptance:core-v0` runs the target route against the local modular-monolith runtime and combines it with fault-injection cases for degraded retrieval, pending admission, commit failure and restart reconciliation. A-01 through A-12 passed on September 5, 2026. This command does not claim PostgreSQL or multi-process evidence.

Each row has a named command and a pass/fail artifact in the ignored temporary acceptance output. The result is local runtime evidence only.

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

The implementation package runs:

```text
npm run test:core-v0
npm run acceptance:core-v0
python3 /Users/abab/.codex/skills/rearchitecture-development-workflow/scripts/check_package.py docs/rearchitecture/core-v0-foundation-slice
```

The acceptance script emits a JSON artifact under an ignored temporary path and reports each row as pass/fail/pending without including message content or credentials. A run with no target adapter remains a preflight-only run and exits non-zero with `pending` rows; the configured runtime adapter is the evidence used here.

## Preflight execution status (historical)

The package-level fixture and ingress-shape tests were executable before the target application service, MemoryPort adapter and route guards existed. The runtime rows were intentionally `pending` during that stage; a passing schema harness alone did not close the runtime findings.

## Runtime status

The configured adapter now exercises the target route and the fault-injection cases. All A-01 through A-12 pass. Secret-like message rejection and session-scoped rollback are covered by `server/core-v0.test.js`; they are safety checks in addition to the twelve-row acceptance matrix.

## Acceptance adapter result validation

When `CORE_V0_ACCEPTANCE_MODULE` is supplied, the harness requires exactly one result for each of A-01 through A-12. Unknown IDs, duplicate IDs, omitted rows, invalid statuses, an empty result, a missing adapter function or an adapter exception are failures. The harness accepts only `passed`, `fail` or `pending`, and a pending row keeps the process non-zero.
