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
| P-10 | rollback/drain rehearsal | local cutover policy | gate closes before a target switch, timeout is recorded, the original repair identity reaches an authoritative receipt and matching Core commit through `reconcile`, no lease remains, and the policy state stays on the legacy writer |
| L-01 | live PostgreSQL | required Auth/TLS | `passed` only after real configured run; otherwise `pending` |
| L-02 | live PostgreSQL | two processes | same subject conflict and receipt replay pass across separate processes |

## Commands

```text
npm run test:core-v0-postgres
npm run acceptance:core-v0-postgres
npm run acceptance:core-v0-postgres-rollback
npm run acceptance:core-v0-postgres-live
python3 /Users/abab/.codex/skills/rearchitecture-development-workflow/scripts/check_package.py docs/rearchitecture/core-v0-postgres-slice
```

`npm run acceptance:core-v0-postgres` runs the shaped matrix and then the rollback rehearsal; the standalone rollback command is provided for focused reruns. Both write ignored temporary JSON artifacts without message content, secrets or connection strings. Missing `DATABASE_URL` is a pending live-environment result, not a pass.

`npm run acceptance:core-v0-postgres-live` is an explicit opt-in live harness. It requires `CORE_V0_LIVE_ACCEPTANCE=true`, `CORE_V0_LIVE_ENV=isolated` and `DATABASE_URL`; it creates a generated `core_v0_live_*` schema, runs the Core schema migration twice, starts two real Node workers against that schema, and drops the schema during cleanup. The output is code/status/identity evidence only and never includes the connection string, credentials or message body. Without the opt-in or an isolated database, the command exits with a pending result and performs no database work.

The live harness verifies real PostgreSQL Core and Memory persistence, two-process subject CAS, original-key replay and changed-fingerprint rejection, a cross-process admission close/drain, and a durable repair record reconciled through the PostgreSQL-backed `MemoryPort` receipt lookup plus the Core commit row. Rollback remains deployment-level evidence and is covered only by P-10's local synthetic rehearsal; the live harness does not switch application traffic or prove production route rollback. L-02 may pass against a real PostgreSQL instance without TLS; L-01 remains pending until required Auth/storage configuration, active certificate-verified TLS and the context-spoofing negative test all pass.

## Live Auth/TLS and context-spoofing promotion gate

L-01 additionally requires `AUTH_MODE=required`, `STORAGE_PROVIDER=postgres`, a configured `SUPABASE_URL`, verified database TLS (`rejectUnauthorized=true` plus a configured CA/verify-full equivalent), sanitized logs and a negative test that forged tenant/subject headers cannot change the server-derived context. The current harness's context test is helper/service-boundary evidence, not evidence that the production `server/index.js` Auth/context route has been exercised. L-01 must remain `pending` until that production route is run with the required Auth, storage and TLS configuration. R-003's local fixture cannot close this gate.

## Complexity traceability

| New mechanism or durable surface | Required consumer/evidence | Decision |
| --- | --- | --- |
| `core_v0_subjects` sequence | P-01, P-02, P-08 | retained: fresh-worker hydration and subject CAS require one persistence revision |
| turn admissions, fingerprints and identity uniques | P-01, P-02, P-03, P-08 | retained: replay, changed-payload rejection and one-winner identity require immutable rows |
| Memory session bindings | P-04, P-08 | retained: MemoryPort binding receipt is separate from Core turn identity |
| assistant commits and application messages | P-01, P-08 | retained: Core commit/checkpoint parity requires durable visible-message and commit records |
| admission gate and active leases | P-06, P-08, P-10 | retained: cross-process close, bounded drain and rollback ordering require a durable fence |
| repair attempts and crash records | P-05, P-06, P-07, P-08, P-10 | retained: unknown outcomes and drain/crash work need content-free, idempotent operator records |
| generic event bus, scheduler, cache, plugin registry | no P-row consumer | deferred: not required by the selected Core v0 slice |

Any field not exercised by these rows is deferred rather than treated as an MVP requirement.
