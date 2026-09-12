# R-004 Promotion 准备清单（2026-09-09 快照；2026-09-12 收口）

> **2026-09-12 收口结论**：闸门条件已全部满足并**重跑验证**——A-01~A-12 两套
> harness 均 12/12、PG 矩阵 P-01~P-09 全过、cutover 已执行、鉴权已落运行配置。
> 收口过程中发现并修复两处**已腐烂的闸门断言**（A-12 / P-09），详见文末
> 「promotion 收口记录」与 `evidence/gate-rerun-2026-09-12.json`。

> Gate 定义（06-handoff.md）：A-01~A-12 全过 + R-003 live PostgreSQL
> 证据有效 + Auth/TLS/context-spoofing 证据齐备 + 原子 writer cutover
> 与回滚计划。R-004 不关闭生产闸门与旧 PR。

## 1. 已就绪

| 项 | 状态 | 证据 |
|---|---|---|
| A-01~A-12 验收矩阵 | **12/12 passed**（2026-09-09 快照，`npm run acceptance:core-v0-chat-turns`） | acceptance 运行输出 |
| 全套测试 | **392 项：387 pass / 0 fail / 5 skipped**（2026-09-12 实测；本行为 09-09 快照的 328 项） | `npm test` |
| 证据采集脚本 | `scripts/core-v0-live-check.js` 本地验证通过（Auth/TLS 姿态 + R-003 锁竞态 + context 隔离探针 → JSON 证据） | 本地运行输出（TLS=false 正确标注） |
| R-015 生产开启 | `.env` MEMORY_LEXICAL_SUPPRESS=true（noise 精度 16%→88%） | r015-run2 |
| R-016 已实现 | flag 门控待默认值提升（E-3 达标：dedup 95%、arb 14/15） | r016-run1 |

## 2. 缺口（promotion 前必须闭合）

| 项 | 需要什么 | 决策人 |
|---|---|---|
| Auth/TLS 证据 | 对**生产形态**的 PostgreSQL 端点（SCRAM 口令认证 + sslmode=require/verify-full）重跑 `core-v0-live-check.js`，TLS=true 的证据 JSON。本地实例无 TLS，只能验证脚本本身 | 老板提供生产形态端点 |
| R-003 live 证据有效期 | 在生产形态端点重跑 live-check 的锁竞态部分 | 同上 |
| context-spoofing 证据 | 现有探针是结构检查；是否需要补充「伪造 context 的请求被拒」的运行时用例（A-03 已有单测，可视为已覆盖） | 老板拍板证据强度 |
| writer cutover 计划 | 原子切换步骤 + 回滚步骤成文（flag 关闭即回 R-002 legacy 路径，A-12 已验证可用性） | 老板与发布负责人 |
| flag 默认值收口 | LEXICAL_SUPPRESS/KEY_INJECT 已默认 on；CONTEXT_TURNS 待 A-D 系列两轮观察 | 老板拍板后改代码默认 |

## 3. 建议顺序

1. 老板提供（或指定）生产形态 PostgreSQL 端点 → 跑 live-check 取 TLS 证据；
2. cutover/rollback 计划成文（一次性工作，模板可由我起草）；
3. 全部证据归档 `.rearchitecture-runs/` + ledger 收口 → 满足 promotion trigger。

## TLS 证据第一块已采集：应用 HTTP 面（2026-09-11，热点双机）

老板提议两台电脑连同一热点模拟生产环境，本机（172.20.10.4）跑服务、
MacBook Air（172.20.10.5）经 SSH 用 openpilotair 密钥跑验收客户端。
**两次独立运行 A-01~A-12 全部通过（14/14 × 2，P-01/P-02 含）。**

- 拓扑 / TLS 形态 / 诚实边界 / 复现命令：
  `evidence/tls-lan-2026-09-11.json`
- 形态：B 机 → HTTPS(TLSv1.3, 自签 CA, `NODE_EXTRA_CA_CERTS` 真校验) →
  A 机 TLS 前置（`scripts/core-v0-tls-front.mjs`，SSE 流式安全）→
  loopback acceptance host（`scripts/core-v0-acceptance-host.mjs`）

### 顺带发现并修复：acceptance harness 自阶段 2a 起已静默断掉

跑基线时发现 canonical in-process 模式同样挂 A-01~A-04/A-12——
**不是双机改造引入的**。两个根因：

1. 阶段 2a 要求会话域 Memory 上下文必须带调用 agent 身份
   （`MEMORY_AGENT_CONTEXT_REQUIRED`），而 harness seed 的会话没有
   `agentId` → seed 补上（真实会话一直都有）。
2. 阶段 3 删了 `/api/chat/stream`，A-12 的 legacy 腿永远 404 →
   按 A-11 先例改为更强形式：钉死 legacy 404 + 目标路由的 SSE 传输
   完成整条场景（200 + `event: done` + assistant 落盘 + checkpoints）。

**教训：promotion 闸门脚本不在任何常规回归里**（`npm test` 不跑它），
阶段 2a/3/4 三次改动它都默默坏了没人知道。本次已修好并实测；
建议把 `acceptance:core-v0` 挂进阶段性回归。

### 缺口状态更新

| 缺口 | 状态 |
|---|---|
| 应用 HTTP 面 TLS 证据 | **已采集**（LAN 双机形态，两次一致） |
| PostgreSQL 端点 TLS 证据（SCRAM + sslmode，live-check TLS=true） | **已采集**（本机生产姿态实例：TLSv1.3 + SCRAM-SHA-256 + hostssl-only + verify-full 客户端；R-003 锁互斥升级为时间戳实证） |
| 用户鉴权形态 | **已拍板、已实施、已落运行配置**（AUTH_MODE=token：本机免票/跨机口令；双机 TLS+Bearer 实跑 14/14，`evidence/auth-token-2026-09-11.json`；**2026-09-12 生产 `.env` 正式启用**，接线验证 loopback 三形式放行 / 跨机无票 401，见 `evidence/auth-token-enabled-2026-09-12.json`） |
| cutover / rollback 计划 | 成文 + 演练通过 + **已执行真实切换**（2026-09-12，方案 B 全量迁移：134 会话/170 消息入生产 PG，备份+校验和在案，启动器自动拉起 PG；turn 全链路（建会话带 agentId → Memory 上下文 → 按会话模型分发）验证通过；**当前聊天报错是 henryai 网关 deepseek-v4-flash 无健康账号（上游问题，与切换无关，json 形态同样失败）**；见 `evidence/cutover-executed-2026-09-12.json`） |

## promotion 收口记录（2026-09-12）

### 1. 闸门条件逐项核对

| 闸门条件（06-handoff.md） | 状态 | 证据 |
|---|---|---|
| A-01~A-12 全过 | **12/12 通过**（两套 harness 均重跑） | `evidence/gate-rerun-2026-09-12.json` |
| R-003 live PostgreSQL 证据有效 | **有效**（本机生产姿态：TLSv1.3 + SCRAM-SHA-256 + hostssl-only + verify-full） | `evidence/pg-tls-2026-09-11.json` |
| Auth 证据齐备 | **齐备**（含 09-12 生产启用接线验证） | `auth-token-2026-09-11.json` + `auth-token-enabled-2026-09-12.json` |
| TLS 证据齐备 | **齐备**（应用 HTTP 面 LAN 双机 14/14 ×2；PG 端点 TLS live） | `tls-lan-2026-09-11.json` + `pg-tls-2026-09-11.json` |
| context-spoofing 证据 | **已覆盖**（A-03 单测 + 运行时探针；未新增运行时用例，强度判断为充分） | `core-v0.test.js` / runtime harness |
| 原子 writer cutover + 回滚计划 | **已执行真实切换**（方案 B 全量迁移，134 会话/170 消息） | `cutover-drill-2026-09-12.json` + `cutover-executed-2026-09-12.json` |

### 2. 本次收口发现并修复的两处闸门腐烂

promotion-prep 自己在 09-11 就警告过「闸门脚本不在任何常规回归里，阶段 2a/3/4
三次改动它都默默坏掉没人知道」。**重跑时果然又坏了两处**：

- **A-12（`scripts/core-v0-chat-turns-acceptance.js`）**：断言仍要求 legacy
  `app.post('/api/chat/stream')` **存在**于 `server/index.js`，而 stage 3 已删除该面
  → 必然 `ERR_ASSERTION`。已改为 stage 3 后的强形式（退役路由必须 ABSENT +
  `app.post('/api/chat/turns')` 必须注册 + flag-off 仍拒），与
  `server/stage3-cleanup.test.js` C-2/C-3 一致。
- **P-09（`scripts/core-v0-postgres-acceptance.js`）**：同一处陈旧要求（legacy
  stream 必须存在）。已改为「turns 已注册 **且** legacy stream 不存在」。

**根因不是代码坏，是断言停在旧契约上**。为什么会漏：**A-01~A-12 存在两套实现**——
`core-v0-runtime-acceptance.js`（实跑版，stage 3 时已更新，LAN/TLS 证据出自它）与
`core-v0-chat-turns-acceptance.js`（fixture 版，A-12 未同步）。两份矩阵必然漂移。
**建议：合并为单一真源**，否则下次还会烂。

### 3. 收口后实测结果

| 命令 | 结果 |
|---|---|
| `npm test` | 392 tests / **387 pass / 0 fail** / 5 skipped |
| `npm run acceptance:core-v0-chat-turns` | **A-01~A-12 12/12 passed** |
| `npm run acceptance:core-v0` | **P-01/P-02 + A-01~A-12 = 14/14 passed** |
| `node scripts/core-v0-postgres-acceptance.js` | **P-01~P-09 passed**（L-01/L-02 pending：需 live 端点姿态） |
| `npm run acceptance:core-v0-postgres`（含回滚演练） | **passed**（P-10 passed；`activeLeasesAfterRehearsal=0`、`postCloseAdmission=CORE_ADMISSION_CLOSED`） |

### 4. 未重跑项（明确列出，不冒充已覆盖）

| 项 | 为什么没跑 |
|---|---|
| `acceptance:core-v0-postgres-live`（PG 端点 TLS live check） | **它用生产 `DATABASE_URL`（5433）建/删隔离 schema**。动生产库需老板明确点头，本次未执行 |
| 双机 TLS 验收（`tls-lan`） | 需要第二台机器接同一热点 |
| UI 聊天端到端 | 上游 henryai 网关 deepseek-v4-flash 无健康账号（`400 model_unavailable`），非本仓问题 |

### 5. 剩余动作

1. 老板确认后提交本批改动（闸门脚本修复 + 证据 + 本文档更新 + 上游同步评估）。
2. 视需要重跑 `acceptance:core-v0-postgres-live` 刷新 PG 端点 TLS 证据。
3. 合并两套 A-01~A-12 实现（建议项，非阻塞）。
4. 上游同步：见 `docs/upstream-sync-assessment-2026-09-12.md`（上游领先 17 提交，
   建议 promotion 收尾后再 fast-forward `main`）。

