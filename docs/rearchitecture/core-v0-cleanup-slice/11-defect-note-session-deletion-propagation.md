# 缺陷修复笔记：session 删除传播缺口（messages 孤儿键）

日期：2026-09-14（缺陷生产实锤 2026-09-13 深夜）
分支：`lane/fix-session-propagation`（基线 36f1066）

## 发现

生产库 `cochpia_state`（jsonb 单行运行时面）的 `messages` 对象里发现两个孤儿键
（`82072925…`、`b7a3ecd4…`，均为空数组），对应的 session 已不存在。两键已在生产
清理。归类：删除传播图覆盖不全——「session → messages 键」这条边在部分路径上丢失。

## 根因

删除传播图核对结论（基线 36f1066）：

1. **直接路径无缺口**：`DELETE /api/sessions/:id`（`server/index.js:511`）自初始提交
   起就带 `delete state.messages[id]`。孤儿不是这条直路留下的。
2. **缺口 A（回滚复活，本次修复）**：Core v0 turn 的失败回滚
   `restoreStateSnapshot`（`server/core-v0.js`）无条件执行
   `state.messages[sessionId] = snapshot.messages`。会话在 turn 进行中被并发删除后，
   一次空快照回滚会把空数组键重新写进 jsonb，下一次任意 `saveState` 即落库——
   与生产孤儿键「空数组」形态吻合。
3. **缺口 B（同面遗漏，本次修复）**：删除路由只清 `messages` 键，不清同一 jsonb
   里 `state.coreV0` 中以 `applicationSessionId` 挂在被删会话上的
   `turnAdmissions` / `memorySessionBindings` / `assistantCommits`。这些记录在会话
   删除后不可达（`execute()` 的 `sessionFor` 门先于 `findTurnByKey` 重放查找，且
   session id 为 randomUUID 不复用），属确定性孤儿。

## 修复

- 新增 `server/session-deletion.js`：`propagateSessionDeletion(state, sessionId)`
  统一清理 `messages[sessionId]` + coreV0 三个会话域记录，返回清理计数；
  `index.js` 删除路由改调它。
- `server/core-v0.js` `restoreStateSnapshot`：快照为空且键已不存在时不再写回
  （回滚只还原回滚前已存在的键）。

**核对后未动（拿不准，列出待裁决）**：

- `memoryModule.sessions`：memory session 与被删 chat session 经 binding 关联，
  但其删除属 Memory 治理面（墓碑/审计/`deletionOperations`），静默级联会绕过
  治理语义，应走 `memory.deleteSession` 流程，另行立项。
- PG provider 下 `core_v0_*` 表：jsonb 里的 coreV0 是镜像/对账面（权威行在
  `core_v0_messages` 等表，`resetHydratedState` 会重建镜像）。清理 PG 权威行
  涉及 ADR-006-03「turn admission 活过 message」的审计语义取舍，未动。
- 删除会话时其消息对应的 Memory raw events/assertions 的遗忘传播（跨模块，
  R-006 只覆盖单条消息删除），未动。

## 验证

- 新增 `server/session-deletion.test.js` 4 例：D1 负例（agent+session+消息+
  coreV0 记录 → 删除后无孤儿、无误伤）；D2/D2b 幂等 characterization（不存在
  key / 旧状态面零效果、状态不变）；D3 回滚不复活空键。
- `npm test` 全量：fail=0，与基线持平（本 worktree 无 .env，pg 套件按预期降级）。
