# R-003 fixtures

The fixtures reuse the R-002 target scenario and add a two-worker/lifecycle variant.

## Required fixtures

- `target-chat-turn.json`: same target request and checkpoint identities as R-002;
- `postgres-worker-conflict.json`: two workers load one subject snapshot, one wins the CAS save, the other reloads and replays the original idempotency key;
- `drain-timeout.json`: one in-flight lease blocks close until the bounded timeout, producing a repairable active identifier without cancellation.
- `rollback-drain-rehearsal.json`: the bounded cutover policy closes admission before any target traffic switch, reconciles the original repair identity, and leaves the legacy writer available in the explicit policy state for rollback.
- `live-postgres-acceptance.json`: expected evidence for the explicit live harness, which creates an isolated generated schema and coordinates two real Node workers against PostgreSQL.

Fixtures contain synthetic IDs only. Acceptance output must be content-free.

The worker fixture also includes a changed-fingerprint replay and a simulated external Memory success followed by Core CAS loss. The drain fixture includes the close epoch observed by the admitted lease and the fact that a post-close admission is rejected.

The rollback/drain rehearsal is synthetic and content-free. It is evidence for the local ordering, reconciliation proof and policy-state semantics only; it is not a runtime observation of deployed writers and is not a live PostgreSQL, Auth or TLS promotion run.

The live fixture is also content-free. The live harness requires both `CORE_V0_LIVE_ACCEPTANCE=true` and `CORE_V0_LIVE_ENV=isolated`; it creates only `core_v0_live_*` objects, runs the Core and Memory migrations twice, starts bounded worker processes, and drops the generated schema after cleanup. Its output records IDs, statuses and error codes only—never the database URL, credentials or synthetic message body. The live receipt evidence comes from the PostgreSQL-backed MemoryPort; rollback remains deployment-level evidence covered by the local P-10 rehearsal.
