# R-004 implementation handoff

> **状态提示（2026-09-12）**：本文档的 "Current state" 与 "Promotion trigger" 仍然准确
> （后者是当前生效的闸门定义）；"Next task" 与 "Preserved paths" 两节已过时，
> 见文末「已更新」一节。闸门结论文档为 `promotion-statement.md`。

## Current state

R-004-REPAIR-AND-IMPLEMENT is complete. The target chat route constructs the
PostgreSQL production adapter from the shared application pool, schema
readiness inspects tables and required columns for both owners, the session
message view is a bounded session-scoped Core query merged with legacy rows,
request context fails closed on tenant, subject, actor or correlation
identity gaps, and all Core v0 routes share one error shape. The closure
adversarial review verified all seven input findings repaired and recorded
five advisories (R4-CR-001..005) with no blocking findings.

## Evidence

- npm test: 291 checks green
- npm run test:core-v0-production: readiness structure, context tightening,
  bounded view, commit-time monotonicity
- npm run acceptance:core-v0-chat-turns: A-01 through A-12 pass
- scripts/check-core-v0-provenance.js: ok
- Commits: 1d8053a (baseline), e348b0a, e352f84, 561c968, 4f0f4ac

## Next task

R-004-PROMOTION-PREPARE: gather the Auth/TLS and context-spoofing evidence,
keep R-003 live PostgreSQL evidence valid, and prepare the atomic writer
cutover and rollback plan. The rollback rehearsal and legacy stream path
remain available (A-12).

## Promotion trigger

Promote only when A-01 through A-12 pass, R-003 live PostgreSQL evidence
remains valid, required Auth/TLS/context-spoofing evidence exists and the
release owner has an atomic writer cutover and rollback plan. R-004 does not
close production gates or old PRs.

*本触发条件是**当前生效的定义**，未改动。四条条件与对应证据的逐项对照见
`promotion-statement.md`。*

## Preserved paths

/api/chat/stream, legacy writers and the user's existing PRs remain unchanged.

## 已更新（2026-09-12；以上原文保留为历史快照）

"Next task" 与 "Preserved paths" 写于 R-004 实施完成时。此后 R-020 改变了链路结构，
其中两条已不成立，**以本节为准**：

- ~~Next task：R-004-PROMOTION-PREPARE~~ → **已完成**。Auth / TLS /
  context-spoofing 证据齐备，cutover 与回滚计划不仅成文、且**已执行真实切换**
  （2026-09-12，方案 B 全量迁移）。闸门逐条结论见 `promotion-statement.md`。
- ~~Preserved paths：`/api/chat/stream` … remain unchanged~~ → **该路径已被删除**。
  R-020 stage 3 退役了整条 legacy companion 流（`/api/chat/stream`、
  `/api/chat/regenerate`、`/api/chat/retry`、`/api/chat/stream/:runId`），
  companion 对话改由 `/api/chat/turns` 承载。A-12 的语义随之改为
  「钉死 legacy 404 + 目标路由完成整条场景（JSON 与 SSE 各一次）」。
  路由契约的单一真源是 `server/chat-route-contract.js`。
- 本节成文时的「npm test: 291 checks green」亦已过时 —— 2026-09-12 为
  **394 tests / 389 pass / 0 fail / 5 skipped**。
- 最后一条（用户的既有 PR 未合并）**未变**，仍然成立。
