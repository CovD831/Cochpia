# 修复设计笔记：独立 Memory Module 服务入口因被删 worker 无法启动

## 1. 考古结论

**删除提交**：`d3a6d81`（`refactor(core-v0): R-020 stage 4 - delete unused endpoints and dead modules`）。

**删除上下文**：该提交逐条复核引用后，把 `server/memory-module-service-worker.js` 判为「已退役、非测试代码零引用」而删除，并断言「真正死的是退役的 service-worker，抽取职责已由 drain 承担」。同期删除的还有 `server/mcp-client.js`、`server/sync-service.js`、若干无对外承诺的端点与测试。

**删除审计的漏洞（根因）**：审计只覆盖了 `server/` 树。它**漏掉了 `services/memory-module/index.js` 第 13、232 行对 `createMemoryModuleServiceWorker` 的静态 import**。因此从 `d3a6d81` 起，独立服务在模块加载阶段（`import`）就抛 `ERR_MODULE_NOT_FOUND`，**从 HEAD 直接起不来**——这正是 L11 实测确认的「真实基线缺陷」。

**被删 worker 的全部依赖现状（全部仍存活）**：
- `createMemoryModule`（memory-module.js）
- `createMemoryModuleWorker`（memory-module-worker.js，租户内 lease/fencing 引擎）
- `processExtractionEvent`（memory-module-extraction-worker.js，抽取）
- `rebuildIndexDocumentsAsync`（memory-module-index.js，索引重建，embedding 可选、BM25 兜底）
- `rebuildEpisodes`（memory-module-episodes.js）
- `resolveMemoryFeatureFlags` / `featureEnabled`（memory-module-flags.js）
- `projectStableProfile`（memory-module-projection.js）
- `isSupersededSourceEvent`（memory-module-event-order.js）

**意图判断**：上游意图是把「抽取」收口进 in-process 的 `createMemoryExtractionDrain`（memory-extraction.js，已存活并被 `core-v0-production.js` 接线）。但**该 drain 是单租户、按 (tenant,subject) 串行、且索引需 embeddingGateway 才能落 `index_documents` 行**；而独立服务是多租户、靠 PostgreSQL outbox 多进程 lease 驱动。删除审计误判「零引用」，把独立服务依赖的多租户 outbox worker 一起删掉了——对独立服务而言这是**误删**，不是「已退役」。

## 2. 方案裁决：选 A（重建最小 worker）

| 维度 | A：重建 service-worker（多租户 outbox 轮询） | B：独立服务改走 in-process drain |
|---|---|---|
| 入口文件改动 | `services/memory-module/index.js` **零改动**（import 重新解析） | 需重构 router/写入流以按租户调 drain，改动大 |
| 索引落库（无 embedding 时） | `rebuildIndexDocumentsAsync` embedding 可选，BM25 兜底→**必有 index_documents 行** | drain 的 `indexAssertionForRetrieval` 在无 embedding 时直接 return→**无行** |
| 多租户 | 天然支持（outbox claim 跨租户） | drain 构造即绑定单一 context，需额外调度层 |
| 语义正确性 | 与删除前完全等价，复用全部存活构件 | 偏离独立服务既有部署模型 |
| 改动量 | 重建被删文件（约 220 行，与删除前等价） | 大 |

**选 A**。理由：改动最小、语义最正确，且只复用存活构件（不引入死代码）。B 不适合独立服务——drain 的单租户+需 embedding 特性会让「index_documents 永远为 0 / lexical 检索地基坏」的问题即便接线后仍在无 embedding 配置下复现。

## 3. 实现要点

- 重建 `server/memory-module-service-worker.js`，导出 `createMemoryModuleServiceWorker`，签名/行为与删除前**等价**（返回 `{ workerId, eventTypes, runOnce, runRetentionSweep, start, stop, running }`），所有 import 指向上述存活模块。
- 独立服务默认 feature flag 全关（`memory-module-flags.js` 默认值 `autoExtract/autoProfileUpdate/hybridRetrieval/vectorRetrieval` 均为 false）。要让索引器真正落 `index_documents` 行，验证运行时需开启 `MEMORY_HYBRID_RETRIEVAL=true`（或 `MEMORY_VECTOR_RETRIEVAL=true`），使 `derivedEventTypes` 包含 `assertion.active` 且 `rebuildDerivedState` 触发 `rebuildIndexDocumentsAsync`。这是独立服务的预期配置，并非本次修复引入。
- `hold` 直接创建 active assertion（memory-module.js:1022）并推 `assertion.active` outbox 事件；worker 处理该事件时重建索引 → `index_documents` 出现行。
- retrieve 的 lexical/BM25 路径（memory-module.js:1231）直接在 `state.assertions` 上做，不依赖 `index_documents`；但任务明确要求索引器活（有行），故必须让 worker 跑起来。

## 4. 验证（一次性 PG，端口 5495，不留盘）

参考 `scripts/pitr-drill.mjs` 姿势：`initdb --encoding=UTF8 --locale=C` 于 `/tmp`，`pg_ctl -o "-p 5495 -k /tmp -c listen_addresses='127.0.0.1'"`，env `LC_ALL=C LANG=C`。建 schema → 启动服务（无垫片）→ 造记忆 → 查 `index_documents` 有行 → retrieve 命中 → `npm run test:memory-sdk` 5/5。跑完 `pg_ctl stop` 并 `rm -rf` 集群。

## 5. 回归测试

- 重建 `server/memory-module-service-worker.test.js`：钉住 `createMemoryModuleServiceWorker` 可解析、各 flag 下的抽取/索引/retention/fencing 行为（与删除前等价）。
- 新增 `services/memory-module-entry-imports.test.js`：静态解析 `services/memory-module/index.js` 的每个 import specifier，确保不再指向不存在的模块（沙箱内可跑，不连 DB）。
