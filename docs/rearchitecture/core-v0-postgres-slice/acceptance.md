# R-003 acceptance matrix

## Scope

This matrix distinguishes SQL-shaped fixture evidence from live PostgreSQL evidence. The former may pass in the repository tests; the latter stays `pending` when no configured database exists.

| ID | Fixture | Check | Pass condition |
| --- | --- | --- | --- |
| P-01 | target | R-002 target parity | same turn/event/message/commit checkpoints and response semantics |
| P-02 | worker conflict | subject CAS | exactly one save wins; loser receives retryable conflict and does not delete the winner |
| P-03 | worker conflict | unique identity | duplicate key returns original receipt; conflicting payload is rejected |
| P-04 | MemoryPort | external conflict | original event/binding key is replayed; no new event/session identity |
| P-05 | restart | unknown response | receipt lookup changes pending to completed or leaves it pending; never guessed success |
| P-06 | drain timeout | close gate | no admission crosses the close point; timeout returns active identifiers |
| P-07 | crash repair | operator record | crash/reconcile record is durable, bounded and content-free |
| P-08 | schema | SQL constraints | all required uniqueness, subject scope, status and foreign-key checks are present |
| P-09 | compatibility | active writers | legacy stream, JSON/JSONB store and independent `/v1` service remain unchanged and are not counted as target writers |
| L-01 | live PostgreSQL | required Auth/TLS | `passed` only after real configured run; otherwise `pending` |
| L-02 | live PostgreSQL | two processes | same subject conflict and receipt replay pass across separate processes |

## Commands

```text
npm run test:core-v0-postgres
npm run acceptance:core-v0-postgres
python3 /Users/abab/.codex/skills/rearchitecture-development-workflow/scripts/check_package.py docs/rearchitecture/core-v0-postgres-slice
```

The acceptance command writes an ignored temporary JSON artifact without message content, secrets or connection strings. Missing `DATABASE_URL` is a pending live-environment result, not a pass.

## Live Auth/TLS and context-spoofing promotion gate

L-01 additionally requires `AUTH_MODE=required`, `STORAGE_PROVIDER=postgres`, verified database TLS (`rejectUnauthorized=true` plus a configured CA/verify-full equivalent), sanitized logs and a negative test that forged tenant/subject headers cannot change the server-derived context. R-003's local fixture cannot close this gate.

## Complexity traceability

P-01/P-08 consume the CompanionStore tables and constraints; P-04/P-05 consume the MemoryPort; P-06 consumes the durable gate; P-07 consumes repair/crash rows; P-09 consumes the compatibility fence. Any field not exercised by these rows is deferred rather than treated as an MVP requirement.
