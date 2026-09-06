# R-005 current to target map

## Current (baseline 5fa81cf)

- `handleTurn` commits turn, application message, assistant commit, binding
  and one raw event; retrieval runs with the bound memory session.
- `loadContextBundleState` builds the retrieval view from the active memory
  session's profile snapshot; snapshot items exist only if they were written
  at binding time from then-active assertions.
- `createCandidate` / `promoteCandidate` exist as Memory Module APIs but are
  called by nobody on the production path.
- Snapshot items are written once at `ensureSessionBinding` from
  then-active assertions; never rebuilt afterwards.
- `memoryStatus` is `available` whenever the retrieval call succeeds, even
  with zero recalled items.
- The proof emulates extraction and projection by hand (E6) to close the
  loop (E7).

## Target

- `promoteCandidate` writes snapshot_items rows for every active, unexpired
  session of the same subject inside the same state mutation and persistence.
- A bounded extraction drain runs at turn entry (before admission), reads
  unextracted raw events via the memory outbox ordering, and produces zero or
  more candidates; policy-driven promotion stays inside the Module.
- The drain is invoked with the request context, is bounded (small batch),
  idempotent per source event, and records failures into the existing repair
  records instead of failing the turn.
- `handleTurn` results expose `recalledCount` and `memoryAnswerability`
  alongside `memoryStatus`.
- The automated proof drives the loop end to end without manual steps; the
  manual E6 emulation is removed from the automated variant and kept only as
  a fallback diagnostic.
