# R-006 scope: deletion propagation

## Problem

The memory-loop proof records the last open gap (E5): Core message deletion
is refused by design (501) and no cascade exists, so a user asking to forget
something cannot get it out of the Memory corpus. The Memory Module already
implements the full governance side (`forgetSourceEvent`: assertions
forgotten, snapshot and index cleanup, tombstone, redaction epoch,
no-resurrection guard in candidate creation). What is missing is the Core
side and the trigger chain.

## In scope

- Core application message deletion through the production adapter, with the
  turn admission retained as history.
- A fan-out chain: deleted message -> owning turn's event id -> raw event
  -> `forgetSourceEvent` (same-subject governance context).
- No-resurrection checks: the automated proof's E5 reverses from FAIL to
  PASS, and the drain never re-extracts a tombstoned event.

## Explicitly deferred

- Legacy JSON message semantics (unchanged), deletion of assistant messages
  without their user turn, episode-level deletion UX, and the deletion API's
  admin/governance surface beyond the subject user.

## Sole authority

Unchanged. The Core store deletes only Core rows; the fan-out only invokes
Memory governance APIs for the same subject. Physical erasure of canonical
raw events stays out of scope: forget means tombstone plus redaction epoch,
never `DELETE FROM raw_events`.
