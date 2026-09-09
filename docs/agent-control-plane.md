# Cochpia Agent Control Plane

## Scope

Codex, Pi, and Claude Code are server-managed execution engines. The browser never starts a
process, stores credentials, or sends a task to an arbitrary endpoint.

## Task contract

`POST /api/workbench/tasks` accepts only `target=codex|pi|claude`, task text, and
optional repository/branch metadata. The server assigns an owner-scoped task
ID and persists this lifecycle:

`submitted -> running -> waiting_approval -> running -> completed|failed|cancelled`

Illegal transitions are rejected. Each task keeps a bounded event history with
state changes, approval decisions, execution summaries, and error codes. Task
responses never include credentials or full process stderr.

## Execution boundary

- Pi uses `pi --mode rpc --no-session` in the server workspace.
- Codex uses `codex app-server --stdio`, performs `initialize`, then
  `thread/start` and `turn/start`.
- Claude Code uses `claude -p ... --output-format stream-json` with a bounded
  default permission mode and maximum turn count. The server parses JSONL and
  stores only bounded event summaries.
- `CODEX_BIN` can point to an explicitly managed Codex binary.
- File tools are restricted to `process.cwd()` and configured
  `COCHPIA_WORKSPACE_ROOTS`.
- Destructive shell patterns, network download commands, and Git publication
  commands are rejected by the local tool policy.
- Production PostgreSQL requires `DATABASE_SSL=true` or `verify-full`.

## Acceptance checks

1. An unauthenticated production request cannot create a task.
2. A user cannot read, cancel, or approve another user's task.
3. A task cannot target an arbitrary browser-supplied endpoint.
4. A task cancellation closes its server-side runner.
5. A production PostgreSQL startup without certificate verification fails closed.
6. `npm test` and `npm run build` pass; PostgreSQL, HTTPS, backup/restore, and
   Pi/Codex live smoke tests must run in their real deployment environment.
