# R-005 fixtures

Paired fixtures follow the R-004 pattern: every acceptance check runs
against both a controlled in-process double and the relational fixture.

- `target-memory-turn.json` — the stating turn: a user message containing one
  durable fact, with an Idempotency-Key header.
- `probe-memory-turn.json` — the probing turn in a different session id,
  asking a question lexically distant but semantically dependent on the fact
  (no shared content words beyond unavoidable single characters), asserting
  the recall is earned by extraction rather than by lexical echo.
- `extractor-double.json` — the deterministic extractor contract: input raw
  event shape, expected candidate list (content, memoryType, assertionType),
  and the sensitive variant that must land in `pending_confirmation`.

The drain tests use the extraction double; the automated proof uses the
model-backed extractor path with mock-provider skip semantics verified
separately.
