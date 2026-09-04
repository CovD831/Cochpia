# L2 contracts consumed by Core v0

Claims in this file are marked **established**, **conditional** or **open**. The implementation package may freeze only the interfaces used by the selected slice.

## Interaction Collector — **conditional**

Responsibility: accept a source command, derive trusted actor/tenant/relationship context, validate privacy and size constraints, assign event identity and idempotency, and return an admission receipt. It does not decide long-term memory.

Non-responsibility: it does not accept client-supplied ownership fields as authority and it does not directly mutate Memory assertions.

Failure contract: return rejected when admission is not durable; return an explicit accepted/pending receipt only when the durable admission state exists. Conflicting replay is a typed idempotency conflict, not a second event.

## MemoryPort — **conditional**

Responsibility: provide the selected deployment's typed raw-event append, policy-filtered retrieval and governance commands. Memory remains the sole writer of long-term assertions, versions and deletion state.

Visible forms: typed command, bounded `ContextBundle` view and durable receipt. `MemoryModule.state` and mutable repository records are not part of the contract.

Failure contract: retrieval may return `available`, `degraded`, `not_found` or `uncertain`; explicit write, forget, delete and export operations must not claim success without a durable receipt. At-least-once consumers are idempotent by event ID.

## Turn admission idempotency

The client supplies an idempotency key for a user turn. The admission boundary durably binds that key to `application_session_id`, `application_message_id`, `event_id` and source revision before model generation. Exact replay returns the original admission receipt; a conflicting replay is rejected. A random server message ID alone is not sufficient.

## Context Builder — **conditional**

Responsibility: combine verified identity/relationship context, session/current state, policy-filtered Memory views and the token budget into a bounded runtime context. It cannot invent facts when Memory is unavailable.

## Model Gateway — **conditional**

Responsibility: hide provider details, support the mock provider and streaming lifecycle, and return typed generation outcomes. It never receives unrestricted storage access and never writes canonical application or Memory state.

## Commit Coordinator and Projection Dispatcher — **open**

The synchronous coordinator owns assistant-result admission and commit receipts. The asynchronous dispatcher owns retries and projection receipts. The exact durable record layout and restart/rollback behavior are resolved in the implementation L3 contract and acceptance matrix.

## Durable run/turn state machine

The base slice freezes only the states it can prove: `admitted`, `context_ready`, `generation_succeeded`, `commit_pending`, `committed`, `failed` and `superseded`. `provider_unknown`, `cancel_requested`, retry and regenerate recovery are follow-up states and may not be reported as implemented by the base slice. A restart must resume or safely re-read `admitted` and `commit_pending` records rather than infer success from an in-process map.

## Status mapping

Core receipts use `pending`, `processing`, `completed`, `failed` and `dead_letter` as the durable vocabulary already used by the Memory worker/schema. `applied` and `retrying` are API presentation aliases only if a contract explicitly maps them; they are not new persisted states.

## Compatibility

The existing compatibility routes remain executable during migration, but public writes must enter through the Collector and extension modules must use bounded contracts rather than direct state access.
