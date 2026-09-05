# R-002 implementation review

## Review date

September 5, 2026.

## Verdict

Comment only for this Foundation Slice. No blocking correctness or security finding remains within the local modular-monolith scope.

The implementation establishes the target route and its failure semantics. It does not claim production readiness for PostgreSQL, horizontal scaling, an independent Memory service, or the full rollback drain protocol.

## State and effects

| Trigger | State/effect | Recovery | Evidence |
| --- | --- | --- | --- |
| `POST /api/chat/turns` | Persists one `turnAdmission`, one application/Memory binding, a Memory raw event receipt and an assistant commit | Exact replay uses the same turn/event/commit IDs | [`server/core-v0.js`](../../../server/core-v0.js), [`server/core-v0.test.js`](../../../server/core-v0.test.js) |
| Memory admission or commit response is unknown | Persists `pending`; does not expose a completed assistant result | Retry or `reconcileTurn` performs receipt lookup | [`server/core-v0.js`](../../../server/core-v0.js), [`scripts/core-v0-runtime-acceptance.js`](../../../scripts/core-v0-runtime-acceptance.js) |
| Application persistence fails after Memory admission | Restores the visible-message snapshot and leaves the turn pending | Reconciliation reuses the original event ID | [`server/core-v0.test.js`](../../../server/core-v0.test.js) |
| Secret-like message content or `accepted_no_store` admission | Rejects before durable turn creation; never forwards the content to the model | Caller must remove the unsafe content and submit a new turn | [`server/core-v0.js`](../../../server/core-v0.js), [`server/core-v0.test.js`](../../../server/core-v0.test.js) |

## Resource and boundary checks

- Request JSON remains bounded by the existing 1 MB Express limit; turn text is capped at 8,000 characters.
- Context history is capped at 20 messages, 4,000 characters per message, 20 recalled items and 2,000 characters per recalled summary; Memory retrieval uses the existing 1,800-token bundle budget.
- Same-session turns are serialized so `sourceRevision` allocation is unique in the current process.
- Failure rollback replaces only records belonging to the affected application session; reconciliation remains available while new admissions are disabled.
- `/v1` mutations require a service credential plus producer, correlation ID and idempotency context. Production service credentials require a JWT secret, issuer, audience, matching service subject and expiry.
- `/api/memories` rejects Core chat/event fields; it remains a separate governance adapter.

## Verified commands

- `npm test` — 246 passed, 0 failed, 5 intentionally skipped integration tests.
- `npm run build` — passed.
- `npm run test:core-v0` — 16 passed, 0 failed.
- `npm run acceptance:core-v0` — A-01 through A-12 passed.
- `python3 /Users/abab/.codex/skills/rearchitecture-development-workflow/scripts/check_package.py docs/rearchitecture/core-v0-foundation-slice` — passed.
- Secret-pattern scan from `AGENTS.md` — no hit.

## Residual risk and next increment

`R002-CLOSURE-F-003` remains open: the feature-flag rollback path still needs a race-free in-flight drain, crash recording and operator-repair evidence. The next increment should add the PostgreSQL-shaped MemoryPort/Companion Store boundary and run the same acceptance matrix against it before any UI migration or PR replacement.
