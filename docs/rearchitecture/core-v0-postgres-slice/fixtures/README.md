# R-003 fixtures

The fixtures reuse the R-002 target scenario and add a two-worker/lifecycle variant.

## Required fixtures

- `target-chat-turn.json`: same target request and checkpoint identities as R-002;
- `postgres-worker-conflict.json`: two workers load one subject snapshot, one wins the CAS save, the other reloads and replays the original idempotency key;
- `drain-timeout.json`: one in-flight lease blocks close until the bounded timeout, producing a repairable active identifier without cancellation.

Fixtures contain synthetic IDs only. Acceptance output must be content-free.

The worker fixture also includes a changed-fingerprint replay and a simulated external Memory success followed by Core CAS loss. The drain fixture includes the close epoch observed by the admitted lease and the fact that a post-close admission is rejected.
