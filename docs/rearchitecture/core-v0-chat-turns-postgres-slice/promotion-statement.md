# R-004 Promotion Statement（2026-09-12）

> 本文件是 R-004 的**闸门结论文档**。闸门定义来自 `06-handoff.md` 的
> Promotion trigger。逐条对照见下；**两条限定**（§3）必须随结论一起引用，
> 否则构成过度声明。
>
> 状态：**已批准并宣布 —— 2026-09-12，发布负责人：老板**（批准记录见 §6）。

## 1. 闸门条件逐条对照

| # | 条件（06-handoff.md Promotion trigger） | 状态 | 证据 |
|---|---|---|---|
| 1 | A-01 ~ A-12 全部通过 | **满足** — fixture 版 12/12；实跑版（含 P-01/P-02）14/14 | `evidence/gate-rerun-2026-09-12.json` |
| 2 | R-003 live PostgreSQL 证据仍然有效 | **满足（带限定）** — live 实跑 **L-02 passed**：真 PG schema（core 9 表 / 34 约束 / 22 索引 + memory 4 表）、双进程 CAS、重放、闸门与 repair 全通过 | `evidence/live-acceptance-2026-09-12.json` |
| 3 | Auth / TLS / context-spoofing 证据齐备 | **满足** — 鉴权：双机 TLS+Bearer 14/14，并于 09-12 落入生产 `.env`；TLS：应用 HTTP 面 LAN 双机 14/14 ×2 + PG 端点 TLSv1.3/SCRAM/verify-full；context-spoofing：`contextSpoofingPassed: true` | `auth-token-2026-09-11` `auth-token-enabled-2026-09-12` `tls-lan-2026-09-11` `pg-tls-2026-09-11` `live-acceptance-2026-09-12` |
| 4 | 发布负责人持有原子 writer cutover 与回滚计划 | **满足** — 计划成文 + 隔离副本演练（窗口数据零丢失）+ **已执行真实切换**（方案 B 全量迁移，134 会话 / 170 消息零失败） | `cutover-plan.md` `rollback.md` `evidence/cutover-drill-2026-09-12.json` `evidence/cutover-executed-2026-09-12.json` |

## 2. 生产运行姿态（切换后实际状态）

- 存储：PostgreSQL 17.11，`pg-data/`，端口 5433，TLSv1.3 + SCRAM-SHA-256 + hostssl-only
- 鉴权：`AUTH_MODE=token`（本机 loopback 免票；跨机需 `Authorization: Bearer`）
- 回滚：删除 `.env` 存储段 + 重启；jsonb 备份 `server/data/state.json.bak-20260912`
- 权威分工未变：`cochpia_state` 单行 jsonb 是运行时读写面，规范化表为对账副本

## 3. 两条限定（必须随结论引用）

**限定 A — L-01 为书面豁免，不是通过。**
L-01 的定义要求 `AUTH_MODE=required` + `SUPABASE_URL`（多用户姿态）。本部署是按发布负责人
裁决的单用户 `AUTH_MODE=token` 姿态，因此 L-01 在机器输出中**恒为 `pending`**。
其安全意图由等价控制覆盖（跨机必须携带共享口令、sha256 + timingSafeEqual 比对；
双机 TLS+Bearer 14/14 实测）。豁免的覆盖范围、残余风险与复核触发条件见
`evidence/live-gate-l01-waiver-2026-09-12.json`（已含发布负责人认可记录）。
> **不得表述为「L-01 通过」。**

**限定 B — 记忆隔离只覆盖 `relationship` / `life` 域。**
R-020 阶段 2a 的 `readScope` 收窄只作用于 `relationship` / `life`；`user` 域按设计对
任何 scope 可见（`agent-scope-2a.test.js` R-4，治理/导出视图需要看全）。**作用域与来源是
两个维度**：一条由 agent A 私聊产生、落成 `scopeType='user'` 的断言，agent B 带
`readScope` 仍可检索到；写入侧没有任何来源标记（`sanitizeMetadata` 白名单无
`source_agent_id`）。已实测复现：`scripts/probe-agent-scope-leak.mjs`。
> **不得表述为「记忆已按 agent 完整隔离」。** 正确表述为「relationship / life 域已按
> agent 隔离；user 域尚未按来源隔离」。
> 这是**范围缺口**，不是 2a 的实现缺陷；写入侧溯源需单独立项。

## 4. Promotion 不覆盖的内容（沿用 06-handoff.md）

- R-004 **不关闭生产闸门，也不合并既有 PR**。
- UI 聊天端到端未验证：上游 henryai 网关 `deepseek-v4-flash` 无健康账号
  （`400 model_unavailable`），属上游故障，与本切片无关。
- 双机 TLS 验收未在 09-12 重跑（需第二台机器接同一热点）；沿用 09-11 证据。

## 5. 后续项（不阻塞本结论）

1. **写入侧来源溯源**（限定 B 的正解）：需要单独立项。
2. **上游同步**：本仓 `main` 可零冲突 fast-forward 到上游 `main`（领先 17 提交）。
   建议在本结论宣布**之后**执行，以保持结论指向明确的 commit。
3. `CONTEXT_TURNS` 默认 0，等 A-D 两轮真实流量观察后再升 4（依赖上游网关恢复）。

## 6. 批准

| 角色 | 人 | 结论 | 日期 |
|---|---|---|---|
| 发布负责人 | 老板 | **批准** | 2026-09-12 |

自 2026-09-12 起，闸门陈述的规范表述为（**必须原样包含两条限定**）：

> **R-004 闸门满足：A-01~A-12 全过；R-003 live PostgreSQL L-02 passed；
> Auth/TLS/context-spoofing 证据齐备；原子 writer cutover 与回滚计划已执行。
> 其中 L-01 为书面豁免（单用户 token 姿态），记忆隔离限于 relationship / life 域。**

## 7. 追加：限定 B 的变更（2026-09-12 同日，批准后）

§3 的限定 B 在本文档获批后**当天即被部分解除**，特此追加，避免本文件过期：

- **已闭合**：写入侧来源溯源（契约 `core-v0-cleanup-slice/08-l2-contracts-2b-provenance.md`）。
  新写入的 raw event 由服务端打 `source_agent_id`（不可由请求体伪造），收窄读中按来源
  过滤——agent B 不再能检索到用户只跟 agent A 说过的内容。实测：`scripts/probe-agent-scope-leak.mjs`
  由 `leak: true` 转为 `leak: false`；回归 `server/agent-provenance.test.js`（P-0~P-5）。
- **仍然存在的窗口**：**2026-09-12 之前**写入的记忆没有标记，按 C-16 兼容规则
  仍对全部 agent 可见。**未做回填。** 因此"记忆已完整按 agent 隔离"的表述**仍然不成立**。

修正后的规范表述（替代 §6 末段）：

> ……其中 L-01 为书面豁免（单用户 token 姿态）；记忆隔离：`relationship` / `life` 域按
> 拥有者隔离，**新数据**另按来源隔离（2b），**2026-09-12 之前的历史数据未按来源隔离**。

本条为**收紧**变更（可见性只会减少），不需要重新批准；若日后要放宽，则必须重新批准。
