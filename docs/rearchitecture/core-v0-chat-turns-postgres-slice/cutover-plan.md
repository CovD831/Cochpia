# R-004 Writer Cutover 与回滚计划（草案 v1，2026-09-09）

> 前置：本计划是 promotion gate 的最后一块成文物。Gate 其余项见
> `promotion-prep.md`。**当前阶段为本地开发，本计划仅在 promotion
> 触发时执行，不安排任何生产部署动作。**

## 1. 切换对象（代码事实）

| 项 | 事实 |
|---|---|
| 切换开关 | `STORAGE_PROVIDER=json（默认）|postgres`（store.js） |
| 生产路径 | `storageProvider==='postgres'` → 每请求构造 `createCoreV0ProductionAdapter`（Core v0 PostgreSQL + Memory pipeline + drain） |
| 生产硬约束 | `NODE_ENV=production` 且非 postgres → Core v0 路由直接 503（`CORE_V0_PRODUCTION_STORAGE_REQUIRED`） |
| 回滚路径 | flag 关回 json → legacy 本地路径与 `/api/chat/stream` 原样可用（A-12 已验证） |
| schema 策略 | 生产默认 readiness-only；`CORE_V0_AUTO_MIGRATE=true` 是显式 opt-in（A-10） |

## 2. 切换前置条件（全部满足才允许步骤 3）

1. promotion gate 全绿：A-01~A-12（当前 12/12）+ R-003 live 证据 +
   Auth/TLS 证据（`core-v0-live-check.js` 对生产形态端点，TLS 必须为
   true）+ 本计划评审通过；
2. 发布负责人指定切换窗口与观察人；
3. PostgreSQL 侧：备份策略就绪（pg_basebackup/PITR 或等价物）；
4. **历史数据决策（二选一，默认 A）**：
   - **A 冷启动（推荐首发）**：PG 只承载切换后的新会话，legacy JSON
     数据原地保留、经 legacy 路径继续只读。零迁移脚本、零数据丢失面；
   - B 全量迁移：需要单独的 JSON→PG 迁移脚本与对账方案——**不在
     R-004 范围**，另行立项。

## 3. 切换步骤（每步有可执行验证）

| 步 | 动作 | 验证 |
|---|---|---|
| S1 | 生产端点跑 `core-v0-live-check.js`（TLS/SCRAM/R-003 锁竞态） | 证据 JSON：tlsEnabled=true，锁互斥成立 |
| S2 | readiness-only schema 检查（production=true，禁 AUTO_MIGRATE） | `prepareCoreV0ProductionSchema` 21 项全过 |
| S3 | 配置 `STORAGE_PROVIDER=postgres` + `DATABASE_URL`（含 sslmode=require），重启服务 | `/api/storage/status`（getStorageStatus）provider=postgres 且 ready |
| S4 | 冒烟：一个真实 turn 走 Core v0（准入→回复→assistant commit→drain 提取） | turn receipt completed；assertion 出现；audit 有痕 |
| S5 | 冒烟：Memory 治理路径（S2 消息 → pending → confirm → active） | 确认后投影与检索可见 |
| S6 | 进入观察窗（建议 ≥72h）：错误率、drain 统计、retention 清扫审计、池水位 | observability 指标与 audit 抽查 |
| S7 | 收尾：ledger 记录切换时间戳与证据 ID；legacy 路径保持不动 | — |

## 4. 回滚

**触发条件**（任一）：turn 失败率异常升高、drain 连续 failed、Memory
服务不可用且影响对话主链路、数据完整性疑点。

**动作**：`STORAGE_PROVIDER=json` + 重启。legacy 路径立即可用（A-12），
PG 不动。

**数据分叉的诚实声明**：回滚后新对话写入 JSON，PG 窗口内的对话留在
PG——**两边从此分叉**。再次切换（re-promote）时 PG 数据完整保留
（bi-temporal 历史），但 JSON 窗口期数据不会自动合并（merge 需要
state-merge 级别的对账，另行评估）。回滚接受度由发布负责人确认。

## 5. 与 R-015/R-016/R-017 的关系

三个 Memory flag（LEXICAL_SUPPRESS、AUDN_KEY_INJECT、RETENTION_SWEEP）
已默认 on 且经 eval 验证；cutover 不引入额外 flag 变更。
CONTEXT_TURNS 保持 0（A-D 两轮观察后再议）。

## 6. 状态

- [x] 切换对象与开关核实（代码事实）
- [ ] 老板评审本计划
- [ ] 生产形态端点就绪 → S1 证据
- [ ] promotion trigger 满足 → 执行
