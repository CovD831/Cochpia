# Memory 模块全景图（生命周期视角，2026-09-09）

> 覆盖写入 → 结构化 → 检索 → 运用 → 修改 → 删除全链。核心文件：
> `memory-module.js`（2246 行，状态与全部变更操作）、
> `memory-extraction.js`（异步提取 drain）、`memory-module-retrieval.js`、
> `memory-module-postgres.js`（仓储映射）。

## 1. 状态集合（memory state，一 subject 一份，PostgreSQL 持久化）

| 集合 | 内容 | 生命周期相关字段 |
|---|---|---|
| rawEvents | 原始对话事件 | `deleteAfter`（创建时 +35 天）、`retentionPolicy` |
| sessions | Memory 会话 | `expiresAt`、`status`（active/expired） |
| assertions | 规范断言（记忆主体） | `status`（candidate/pending_confirmation/active/forgotten/expired）、`expiresAt`、`canonicalKey`、`sensitivity`、`subjectType/subjectId`、`relationshipAgentId` |
| assertionVersions | bi-temporal 版本 | `validFrom/validTo`（事实有效期）、`observedAt`、`versionStatus`（current/invalidated） |
| assertionVersionSources | 版本 ← 事件溯源 | — |
| indexDocuments | 向量索引 | `indexStatus`（active/…） |
| currentStates | 结构化当前状态 | — |
| confirmations | S2 确认请求 | `expiresAt`、`status`（pending/…） |
| accessConfirmations | 未确认记忆的一次性授权 | `expiresAt`、`status: consumed` |
| mentionCooldowns | 主动提及冷却 | — |
| pins | 用户置顶 | — |
| scopeGrants | 授权范围 | — |
| tombstones | 遗忘墓碑（redactionEpoch） | — |
| deletionOperations | 异步删除操作跟踪 | — |
| idempotencyRecords | 幂等记录 | — |
| outboxEvents | 派生事件（生产路径未启用） | — |
| auditEvents | 全程审计 | — |

## 2. 写入链（生产路径全通）

```
turn 提交（core-v0）
  → recordEvent（幂等校验、S3/do_not_store 拦截 → accepted_no_store、
    context_snapshot 快照 [R-014]、+35 天 deleteAfter）
  → 异步 drain（memory-extraction.js，advisory 锁按 subject 串行）
      → 逐事件提取（few-shot，raw 模式 [R-014 配套]，预算 30s）
      → AUDN 仲裁（cos ≥0.6 相似查找 + 同 key 注入 [R-016] →
        ADD/UPDATE/NOOP/DELETE，raw 模式温度 0）
      → S2 敏感分类（content + sourceContent [R-013]）→ pending_confirmation
      → promote（S0/S1）/ hold（S2）→ indexDocument 向量化
      → source 溯源 + exhausted 簿记
```

## 3. 检索与运用链（生产路径全通）

```
retrieveAsync（purpose: answer_user_query 等）
  → 混合检索：BM25（词法下限 [3c]）+ 向量（minScore 0.55）→ RRF 融合；
    向量健康零命中 → 词法回退抑制 [R-015]
  → finalizeRetrieve：proactive mention 过滤、access 授权过滤、
    冲突仲裁（latest-wins，被压值转 uncertainties）
  → contextBundle（token 预算多级压缩：pop/trim/halving/fail-closed）
```

运用侧消费：会话回复、`relevantEpisodes`（情节检索）、
`recordMention`（提及冷却）、pins 置顶。

## 4. 修改链（生产路径全通）

- `correct`（UPDATE）：闭旧版本区间 + 开新区间（bi-temporal 正统更新）；
- `decideConfirmation`（S2 确认/拒绝）：确认 → directQueryPolicy=allow +
  mentionPolicy=contextualizable_only（R-012 方案 A）→ 走 promotion 投影；
- `pin/unpin`、`grantUserScope/revoke`（授权）、`hold`（S2 手动挂起）。

## 5. 删除链（生产路径全通，用户发起）

- `forget`（单条记忆）：status=forgotten + indexDocument 清除 + 墓碑
  （redactionEpoch）+ 派生清理 + 幂等失效；
- `forgetSourceEvent / forgetSession / forgetRelationship / forgetAccount`：
  按范围红action（account = 全量）；
- `remove / deleteSourceEvent / deleteSession / deleteRelationship /
  deleteAccount`：物理删除 + `deletionOperations` 异步跟踪；
- **语义分层**：forget 是"用户撤销授权"（红action + 墓碑），expired 是
  "生命周期到期"（可审计降级），物理删除只走 deletionOperations。

## 6. 孤儿模块（存在、已实现、生产路径未接线）

| 模块 | 位置 | 现状 |
|---|---|---|
| **sweepRetention** | memory-module.js:1829 | 完整实现：rawEvents 过期物理清、sessions 过期降级、断言 expiresAt/会话过期 → expired + 版本 invalidated、确认/冷却/幂等记录清理。**生产无人调用** |
| createMemoryModuleServiceWorker | memory-module-service-worker.js | 含 outbox worker + 定期 retention sweep（60s）+ episodes 重建 + 稳定画像投影（projectStableProfile）。**生产未实例化**（drain 取代了它的提取职责，其余职责悬空） |
| projectStableProfile（稳定画像投影） | memory-module-projection.js | 按 scope（user/relationship）投影画像——生产未运行 |
| rebuildEpisodes（情节分组） | memory-module-episodes.js | flag episodeGrouping 控制——生产未运行 |

## 7. 缺口 → R-017

数据在无限累积：rawEvents（35 天字段存在但无人执行）、过期会话/断言
（expiresAt 无人检查）、consumed 授权/冷却/幂等记录只增不减。

**R-017：把 sweepRetention 接进生产 drain**（时间门控，每 subject 至多
每小时一次），语义沿用既有"先降级不删除"（断言→expired、版本→
invalidated；仅 rawEvents 按既定 35 天策略物理清除）。详见 r017-plan.md。
EOF
marker
echo written