# R-004 Promotion 准备清单（2026-09-09 快照）

> Gate 定义（06-handoff.md）：A-01~A-12 全过 + R-003 live PostgreSQL
> 证据有效 + Auth/TLS/context-spoofing 证据齐备 + 原子 writer cutover
> 与回滚计划。R-004 不关闭生产闸门与旧 PR。

## 1. 已就绪

| 项 | 状态 | 证据 |
|---|---|---|
| A-01~A-12 验收矩阵 | **12/12 passed**（2026-09-09 快照，`npm run acceptance:core-v0-chat-turns`） | acceptance 运行输出 |
| 全套测试 | 328 项无失败（含 R-014/R-015/R-016 新增用例） | `npm test` |
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
| 用户鉴权形态 | **已拍板并实施**（AUTH_MODE=token：本机免票/跨机口令；双机 TLS+Bearer 实跑 14/14，`evidence/auth-token-2026-09-11.json`） |
| cutover / rollback 计划 | 成文 + **演练通过**（2026-09-12 隔离副本全链路：迁移→切换→窗口写入→回退→读回，窗口数据零丢失；发现 normalized 对账副本缺 agent_id 等 4 项，见 `evidence/cutover-drill-2026-09-12.json`）。**剩老板评审** |
