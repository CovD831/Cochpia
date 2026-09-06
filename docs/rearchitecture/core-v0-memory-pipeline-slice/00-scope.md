# R-005 scope: memory extraction and snapshot projection pipeline

## Position in the program

- Package: `R-005-memory-extraction-pipeline`
- Baseline: `5fa81cf` (R-004 closed; memory-loop proof committed)
- Design authority: `../core-v0-design/00-scope.md`
- Evidence input: `.rearchitecture-runs/memory-loop-proof.json` and
  `scripts/memory-loop-proof.js` (7/9, two precise breaks identified)

## Problem

The memory-loop proof proved the chat-with-memory MVP loop closes only when
two missing steps are emulated by hand. On the production turn path today:

1. No worker turns raw events into active assertions (extraction). Raw events
   are durable but never enter the retrieval corpus, which is built from
   active assertions surfaced through session profile snapshots.
2. No worker projects newly activated assertions into session profile
   snapshots. Snapshots are built once at session binding and never rebuilt,
   so a new assertion is invisible to retrieval in every session.

The proof also showed `memoryStatus=available` only means the retrieval call
succeeded, not that anything was recalled. Callers cannot distinguish
"memory healthy but empty" from "memory contributed context".

## In scope

- Snapshot projection as a transactional side effect of candidate promotion
  inside the Memory Module (no async worker needed).
- An extraction drain driven by the memory outbox: raw events from committed
  turns are extracted into candidates, promoted when policy allows, with a
  bounded batch invoked from the turn entry path (no new process).
- A deterministic extractor double for tests plus a model-backed extractor
  that skips and records when no real model is configured.
- Turn result recall semantics: expose recall count and answerability so
  callers can tell an empty memory from a contributing one.
- A single feature flag gating projection and extraction together.
- Automated memory-loop proof as an acceptance check without manual injection.
- Paired fixtures, tests, acceptance output and rollback policy.

## Explicitly deferred

- Deletion propagation (the E5 gap): Core message deletion API, tombstone
  fan-out and snapshot cleanup move to R-006.
- Episodic aggregation, index documents with embeddings, profile projections
  beyond snapshot items, and proactive mention.
- Real-provider extraction quality evaluation (Phase 3 / 600-case).
- /api/chat/stream migration, regeneration, group chat and the UI.

## Sole authority

Unchanged from R-004. The extraction drain is Memory Module domain logic: it
reads raw events, creates Memory assertions and never writes Core tables.
Projection touches only Memory tables. Core remains the sole owner of turns,
application messages, assistant commits and receipts.

## Sole authority of this slice

The drain may only start from an outbox or raw-event scan scoped to one
tenant and subject, and only after the owning turn is committed. It must not
run inside the turn write transaction.
