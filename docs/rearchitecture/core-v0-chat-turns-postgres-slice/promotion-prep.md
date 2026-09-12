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
| 双机 TLS 验收（`tls-lan`） | 需要第二台机器接同一热点 |
| UI 聊天端到端 | 上游 henryai 网关 deepseek-v4-flash 无健康账号（`400 model_unavailable`），非本仓问题 |

### 4.1 live 验收已重跑：**未通过**，两处失败均已定位（2026-09-12）

老板点头后执行了两次（生产 `DATABASE_URL` @5433，隔离 schema，跑完自动 DROP；
事后核实：无残留 `core_v0_live_*` schema，`public` 表数仍为 44，生产数据未被触碰）。
完整记录见 `evidence/live-acceptance-attempt-2026-09-12.json`。

1. **第一次 `42704`**——PG 日志：`operator class "gin_trgm_ops" does not exist for
   access method "gin"`。root cause：`server/memory-module-schema.sql` 的
   `CREATE EXTENSION IF NOT EXISTS pg_trgm` 在扩展**已存在于 `public`** 时被跳过，
   而 `gin_trgm_ops` 未加 schema 限定，隔离 schema 里解析不到。**已修复**（扩展目标与
   operator class 均加 `public.` 限定）。文件内同时注明**禁止**改用放宽 `search_path`
   的绕法：`public` 有 44 张生产表（含 `core_v0_*`、`memory_*`），放宽后
   `CREATE TABLE IF NOT EXISTS` 会解析到生产表，「隔离」运行将静默读写生产数据且报通过。
2. **第二次 `REPAIR_METADATA_INVALID`**（说明第 1 处修复生效，前进到 repair 阶段）。
   已定位为语义不一致：`scripts/core-v0-postgres-live-acceptance.js:667` 的
   `receiptLookup` 查不到时返回 `status: 'not_found'`，而
   `server/core-v0-postgres.js:686-690` 的 `validateReceiptStatus` 只接受
   `unknown|pending|completed|failed`。**未修**——「receipt 状态域是否包含
   `not_found`」属语义决策，留老板拍板。

**同两次运行暴露的两处配置不一致（未修）**：

- **L-01 在当前姿态下结构上不可达**：`live-acceptance.js:698` 要求
  `authRequired && storagePostgres && supabaseConfigured`（即 `AUTH_MODE=required`
  + `SUPABASE_URL`）。本部署**刻意**选 `AUTH_MODE=token` 单用户姿态 → L-01 恒为
  `pending`（`AUTH_STORAGE_CONFIGURATION_REQUIRED`）。需要么给 L-01 写书面豁免
  （说明 token 姿态已覆盖其意图），要么部署 Supabase。
- **TLS 严格性检测看不见 URL 形式的配置**：`server/db-ssl.js` 只读 `DATABASE_SSL`
  / `DATABASE_CA`，**不解析** `DATABASE_URL` 的 `sslmode`。本部署用
  `sslmode=verify-full&sslrootcert=...`（实际连接确实严格校验），但检测器报
  `sslConfiguration: configured_incomplete_or_non_strict` → 即便 AUTH 条件满足，
  L-01 仍会卡在 `STRICT_TLS_CONFIGURATION_REQUIRED`。修法二选一：`.env` 补
  `DATABASE_SSL=true` + `DATABASE_CA=<repo>/.certs/prod-pg-ca.pem`，或让检测器解析 URL。

**对闸门结论的影响**：09-12 已重跑转绿的四组矩阵（fixture A-01~A-12、runtime
14/14、PG P-01~P-09、回滚演练 P-10）不受影响；**L-01/L-02 这一对仍未取得有效证据**，
原因是上述开放决策与姿态差异，**不以「pending」冒充通过**。

### 5. 剩余动作

1. 老板确认后提交本批改动。
2. **L-01/L-02 待决三项**：receipt 状态域是否纳入 `not_found`；L-01 的
   `AUTH_MODE=required` + Supabase 要求是否书面豁免（本部署为 token 姿态）；
   TLS 严格性检测是否改为解析 `DATABASE_URL` 的 `sslmode`。三项定完才能取得
   live 证据，在此之前 L-01/L-02 不得标通过。
3. **路由契约已抽成单一真源**：`server/chat-route-contract.js`，由
   `server/stage3-cleanup.test.js` C-2/C-3（在 `npm test` 内，因此已纳入回归）、
   A-12、P-09 三处共同引用，消除「三份手抄字面量」这一漂移源。
   **两套 A-01~A-12 矩阵保持独立**——它们覆盖不同层（fixture 纯构造 vs 真 HTTP /
   真 PG + worker），合并只会丢覆盖。
4. 上游同步：见 `docs/upstream-sync-assessment-2026-09-12.md`（上游领先 17 提交，
   建议 promotion 收尾后在 `main` 上 fast-forward）。

