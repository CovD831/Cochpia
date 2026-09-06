# R-006 L3 task contract

## Core deletion

`createPostgresCoreV0Store` gains `deleteApplicationMessage({ sessionId,
messageId })`: removes the message from the in-memory application messages,
persists through the existing full-state save, and returns the deleted
message plus the owning turn's `eventId` (resolved from the turn admissions
by `applicationMessageId`) or null. Unknown messages throw a 404-shaped
CoreV0Error. Turn admissions and other messages are untouched.

## Fan-out

`createCoreV0ProductionAdapter` gains `deleteApplicationMessage({ sessionId,
messageId })`: resolves the owning turn's eventId, looks up the Memory raw
event row by `event_id` within the same tenant and subject, builds a Module
from `repository.load` and calls `forgetSourceEvent(row.id, {
resourceRevision: row.resourceRevision || 1 })`, then deletes the Core
message. Unknown raw events (message never extracted or already forgotten)
skip the fan-out silently. Memory failures throw a retryable 503-shaped
CoreV0Error before the Core deletion runs.

## Route

The DELETE route's Core guard changes from the 501 refusal to the adapter
deletion; the response is 204. Legacy JSON messages keep the existing path.
The reply/error shapes reuse the unified Core error helpers.

## Proof

The automated proof gains E6: after the successful probe (E4), delete the
stating turn's user message through the adapter, then run a second probe
turn in another fresh session - `recalledCount=0`,
`memoryAnswerability=not_found`, no memory branch, and the drain reports
nothing new to extract from the tombstoned event. E5 inverts from FAIL to
PASS (facts removed from the corpus).
