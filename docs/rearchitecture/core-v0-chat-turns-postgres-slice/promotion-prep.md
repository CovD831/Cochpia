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
