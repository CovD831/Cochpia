> ⚠️ **状态更新横幅（2026-09-13 对账）**：本文件 2026-08-22 原文**逐字保留未删改**，下文「NOT READY」表述留史。2026-09-12 已在真实生产 PostgreSQL（端口 5433，每次运行用隔离 schema，跑完删干净）完成 live 验收并过闸门 R-004（结论含**两条限定**：① L-01 为书面豁免，非通过；② 记忆隔离仅覆盖 `relationship`/`life` 域）。逐 gate 对账与证据来源见文末 `## 2026-09-13 状态更正（live 证据对账）`。**本横幅不替换任何原文结论。**

# Memory Module Alpha Gate

状态：**NOT READY FOR REAL USER DATA**（2026-08-22）

| Gate | 当前状态 | 证据 | 结论 |
| --- | --- | --- | --- |
| tenant/user/relationship/session 隔离 | code+unit green | `npm test` domain/API/negative tests | 通过代码基线；需真实 auth+Postgres 复验 |
| canonical subject-bound DB constraints | schema+repository wiring green | `memory-module-schema.test.js` + repository source-column test | 已加入同用户 session/source 复合外键与 current-version guard；真实 PostgreSQL 约束执行仍未运行 |
| S3 不落库/不进 outbox/model | code+unit green | ingress/extraction/model tests、fixture scan | 通过已知模式；需生产日志/WAL/proxy sampling |
| read-your-write / S2 confirmation / TTL | code+unit green | domain/API tests | 通过代码基线 |
| correct/pin/revoke/forget/delete | code+unit green | governance tests、delete API test | 通过代码基线；需真实传播计时 |
| worker lease/retry/dead-letter/fencing | code+unit green | worker/recovery/service-worker tests + PostgreSQL fenced save query | 已加入事务级 `lease_owner/status` fence；真实 PostgreSQL 多进程故障注入仍未运行 |
| profile/index/episode flags | code+unit green | service worker tests | 通过 wiring；需真实 backlog/freshness |
| proactive mention flag/cooldown | code+unit+API green | `memory-module.test.js` + `memory-module-api.test.js` + `memory-module-schema.test.js` | disabled 时 fail-closed；仅对已授权 Agent 记录 content-free cooldown；真实部署行为仍需验证 |
| versioned ContextBundle cache | code+unit green; optional Redis wiring | `memory-module-cache.test.js` + PostgreSQL repository cache test | 默认关闭；只缓存无 query 的 bounded read model，tenant/user 与 commit/grant/privacy generation 绑定；Redis 故障回退 canonical PostgreSQL |
| hybrid/vector/RRF fallback | code+unit green; optional HTTP embedding adapter + native lexical/vector/hybrid fallback wired | retrieval/domain/native retriever/HTTP adapter tests + async index embedding test + migration/helper/native SQL/native hook/read-model tests | 独立服务只在显式配置 embedding URL、feature flag 和 pgvector 后生成服务端 query vector；provider/pgvector 不可用会回退 lexical；真实 pgvector/HNSW/vector-hybrid 性能仍未验收 |
| 600-case evaluation | synthetic baseline green; real evaluation missing | v0.2 synthetic JSON + in-memory runner + metrics harness + `npm run evaluate:memory-synthetic` / `npm run evaluate:memory` | synthetic seeded baseline 全部 1.0，但真实/脱敏结果 JSON、抽取/晋升/主动提及质量指标仍未提供 |
| PostgreSQL schema/repository | smoke + acceptance ready, not run | `MEMORY_MODULE_SMOKE_APPLY_SCHEMA=true npm run test:memory-postgres`；`MEMORY_MODULE_ACCEPTANCE_APPLY_SCHEMA=true npm run test:memory-postgres-acceptance`；覆盖重复 schema、主体隔离、native lexical/vector/hybrid、Scope 和查询计划证据 | 当前无 `DATABASE_URL`；上述真实 SQL 证据未运行 |
| PITR/tombstone replay/RPO/RTO | implementation/test only | recovery replay tests | 真实 backup restore 未运行 |
| 1M-doc/20-concurrent p50/p95/p99 | local synthetic sanity complete; real PostgreSQL benchmark harness ready, not run | `MEMORY_MODULE_BENCHMARK_DB_ENABLED=true ... npm run benchmark:memory-postgres` + local synthetic benchmark | 单进程内存 BM25 结果不计入 acceptance；真实 PostgreSQL/pgvector、强 Scope、积压与降级场景仍未执行 |
| Model Gateway retention/quality | wrapper+HTTP extraction/embedding adapters+unit green, provider audit missing | gateway wrapper/HTTP adapter/native fallback tests + Model Gateway spec | 真实 structured extraction 质量、S2/S3 假阴性率和供应商审计未完成 |
| Cochpia/API SDK first external chain | SDK smoke ready, not run | `MEMORY_MODULE_URL=... MEMORY_MODULE_SDK_TENANT_ID=... MEMORY_MODULE_SDK_USER_ID=... npm run test:memory-sdk` | 当前未连接真实独立服务；本地 API/SDK contract unit tests 通过 |
| production TLS/security headers | guard implemented | independent service startup guard + headers | 需部署环境验证证书/HTTPS |

## Required final evidence before completion

1. 配置真实 PostgreSQL，执行 schema、repository smoke、并发冲突和 leased worker test。
2. 恢复删除前 PITR/backup，重放 deletion ledger，验证 retrieve、snapshot、index、outbox 不复活。
3. 执行真实分布的 600-case 脱敏评测，生成 Recall@5/10、MRR、nDCG、no-answer、conflict、Scope、S2/S3 和 mention 报告。
4. 执行 1M index documents、20 concurrent、强 Scope 过滤和积压场景压测，记录 p50/p95/p99 和降级率。
5. 接入正式结构化 Model Gateway，完成模型输入/输出脱敏、保留策略和质量审计。
6. 所有 P0/P1 安全与治理问题关闭或由明确负责人签署风险接受。

## 2026-09-13 状态更正（live 证据对账）

> 方法：保留 2026-08-22 原文；以下仅新增对账，不修改上文。证据以 `repo-main/docs/rearchitecture/core-v0-chat-turns-postgres-slice/evidence/` 下 JSON 为准（live-acceptance-2026-09-12.json 等），闸门结论引 promotion-statement.md §6/§7/§8（已写入 handoff-2026-09-12.md）。诚实口径：**部分覆盖不得写作已达成**；不确定标 unknown。

### 两条全局限定（必须先读）

- **L-01 = 豁免，非通过**：其定义要求 `AUTH_MODE=required` + `SUPABASE_URL`，本部署为单用户 token 姿态，机器输出恒 `pending`。证据：`live-gate-l01-waiver-2026-09-12.json`（老板「可以」认可，含残余风险与复核触发条件）。
- **记忆隔离仅覆盖 `relationship`/`life` 域**：`user` 域历史数据未按来源隔离（§7）。2b 来源溯源已实现并回归（`leak: false`），且实测历史 assertion 表为空、历史 raw event 无 agent 维度来源 → 回填无对象（`provenance-backfill-window-closed-2026-09-12.json`）。机制尚未被历史数据考验。

### 逐 gate 对账表

| Gate | 2026-08-22 原文结论 | 2026-09-13 新状态 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| tenant/user/relationship/session 隔离 | 需真实 auth+Postgres 复验 | 部分覆盖 | `live-acceptance-2026-09-12.json`（contextSpoofing.passed）、`auth-token-enabled-2026-09-12.json`、`provenance-backfill-window-closed-2026-09-12.json` | 真实 token 鉴权启用 + context-spoofing 通过 + 记忆按来源隔离机制活；多租户真实 PG 隔离未逐项复验 |
| canonical subject-bound DB constraints | 真实 PG 约束执行仍未运行 | 已覆盖 | `live-acceptance-2026-09-12.json` schemaEvidence.constraints（34 约束 / 22 索引, passed） | 真实 PG 建约束并校验通过 |
| S3 不落库/不进 outbox/model | 需生产日志/WAL/proxy sampling | 仍缺 | — | live 仅验证 outbox/receipt 完成（externalReceiptStatus=completed）；生产 WAL/proxy sampling 未做 |
| read-your-write / S2 confirmation / TTL | 通过代码基线 | 部分覆盖 | `live-acceptance-2026-09-12.json`（cas.replayPass, changedReplayPass, coreCommitId, memoryWritePass） | 真实 PG 重放/commit/写入已验证；TTL 真实传播计时未单独测 |
| correct/pin/revoke/forget/delete | 需真实传播计时 | 仍缺 | — | 真实传播计时未做 |
| worker lease/retry/dead-letter/fencing | 真实 PG 多进程故障注入仍未运行 | 部分覆盖 | `live-acceptance-2026-09-12.json`（workers a/b, cas.loserError=CORE_STORAGE_CONFLICT, gate.repairStatus=completed, activeLeasesAfterDrill=0） | 真实 PG 双进程 CAS + 闸门 drain + repair 已验证；经典 dead-letter/故障注入未单独枚举 |
| profile/index/episode flags | 需真实 backlog/freshness | 仍缺 | — | 真实 backlog/freshness 未验 |
| proactive mention flag/cooldown | 真实部署行为仍需验证 | 仍缺 | — | 真实部署行为未验 |
| versioned ContextBundle cache | 默认关闭 | 仍缺（已知默认，非回归） | — | Redis 回退未真实验证；属设计默认 |
| hybrid/vector/RRF fallback | 真实 pgvector/HNSW 性能仍未验收 | 仍缺 | — | 真实 pgvector/HNSW 性能未验收 |
| 600-case evaluation | synthetic 全 1.0 / 真实缺失 | 仍缺 | — | synthetic 无判别力；真实 600-case 协议见 `docs/memory-eval-protocol-600case.md`（待执行） |
| PostgreSQL schema/repository | 真实 SQL 证据未运行 | 已覆盖 | `live-acceptance-2026-09-12.json`（schemaCreated, 9 core 表 / 34 约束 / 22 索引 / memory 4 表, migrationRerun=true, 跑完删除） | 真实 PG 隔离 schema 建成并清理；public 始终 44 表 |
| PITR/tombstone replay/RPO/RTO | 真实 backup restore 未运行 | 仍缺（另一 lane L6 演练进行中 2026-09-13） | — | 恢复/墓碑重放演练未做 |
| 1M-doc/20-concurrent p50/p95/p99 | 真实 PG 未执行 | 仍缺 | — | 真实压测未执行 |
| Model Gateway retention/quality | 供应商审计未完成 | 仍缺 | — | 结构化提取质量/供应商审计未完成 |
| Cochpia/API SDK first external chain | 未连接真实独立服务 | 仍缺 | — | 真实独立服务未连 |
| production TLS/security headers | 需部署环境验证证书/HTTPS | 部分覆盖 | `live-acceptance-2026-09-12.json`（databaseTls.active=true, TLSv1.3）、`tls-lan-2026-09-11.json`、`gate-rerun-2026-09-12.json` | DB TLS strict 已验证；双机生产 TLS + security headers 未重跑（需第二台机） |

### 计数

- **已覆盖：2**（canonical constraints、PostgreSQL schema/repository）
- **部分覆盖：4**（隔离、read-your-write/TTL、worker fencing、production TLS）
- **仍缺：11**（S3 WAL、correct/delete 计时、profile flags、proactive mention、cache、vector 性能、600-case、PITR、压测、Model Gateway、SDK 链）

### 总状态判语（诚实）

原文「NOT READY FOR REAL USER DATA（2026-08-22）」**仍成立**。真实用户数据闸门仅被 live 验收的 persistence/lifecycle 切片部分覆盖：L-02 passed 但 L-01 为豁免非通过；记忆隔离仅 `relationship`/`life` 域；600-case 真实评测、压测、PITR、pgvector 性能、Model Gateway 审计、双机 TLS 均仍缺。R-004 闸门结论（L-02 passed + L-01 waived）有效，但**不等同于 alpha gate 全绿**。
