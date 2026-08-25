# Cochpia

Ai的人生谁来定义？

Cochpia 是一个围绕共同经历、外部记忆、SSE 流式交互和可验证人格成长构建的 AI 陪伴应用骨架。

## Run

```powershell
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8787
- Health: http://localhost:8787/api/health
- Model catalog: http://localhost:8787/api/models
- MCP endpoint: POST http://localhost:8787/mcp

MCP 的 `breath`、`dream`、`trace` 是主体认证读取工具；`hold`、`grow` 写工具还要求服务端 `x-mcp-service-token`，未配置或不匹配时 fail-closed。

## Model configuration

默认使用 `MODEL_PROVIDER=mock`，不会产生云端费用。服务端通过 `GET /api/models` 提供供应商、协议、推荐模型、生产场景注释和 `ready` 状态；前端设置面板可查看目录、测试真实连接并按会话保存模型选择。

API Key 只放在服务端环境变量中：

```text
MODEL_PROVIDER=mock
STORAGE_PROVIDER=json
MODEL_<PROVIDER>_API_KEY=server-only-secret
MODEL_<PROVIDER>_NAME=provider-model-name
MODEL_<PROVIDER>_API_URL=optional-endpoint-override
MODEL_TIMEOUT_MS=30000
```

`ready=true` 只表示环境变量配置完整，不代表真实云端调用已经成功。没有 API Key 时，连接测试会返回真实的 `MODEL_NOT_CONFIGURED`，不会伪造成功。

本地默认使用 JSON 存储。部署 PostgreSQL 或 Supabase 时，将 `STORAGE_PROVIDER` 改为 `postgres`，并配置 `DATABASE_URL`；可选设置 `DATABASE_SSL=true`。后端会自动创建 `cochpia_state` 表。当前阶段使用 JSONB 聚合状态，后续再按用户、会话、消息和记忆拆分为规范化表。

支持的适配族包括 OpenAI-compatible、Anthropic Claude 和 Google Gemini。当前目录包含 OpenAI、DeepSeek、通义千问、智谱 GLM、Kimi、MiniMax、SiliconFlow、Claude、Gemini 和本地 Mock。

## Structure

- `client/`: React/Vite 聊天工作区、模型选择器和设置面板
- `server/index.js`: 会话 API、模型目录、连接测试、SSE 和 MCP JSON-RPC
- `server/model-provider.js`: 模型注册表与协议适配器
- `server/memory-module-runtime.js`: Memory Module 运行时、对外接口和旧数据一次性迁移边界
- `server/data/state.json`: JSON 本地开发持久化
- `server/schema.sql`: PostgreSQL 初始状态表

## Verification

```powershell
npm test
npm run build
```

Memory Module 验证入口：

```sh
npm run test:memory-postgres
MEMORY_MODULE_ACCEPTANCE_APPLY_SCHEMA=true npm run test:memory-postgres-acceptance
MEMORY_MODULE_BENCHMARK_DB_ENABLED=true MEMORY_BENCHMARK_DOCUMENTS=1000000 MEMORY_BENCHMARK_REQUESTS=20 MEMORY_BENCHMARK_CONCURRENCY=20 npm run benchmark:memory-postgres
DATABASE_URL=postgresql://... MEMORY_MODULE_BENCHMARK_DB_ENABLED=true MEMORY_MODULE_BENCHMARK_PGVECTOR=true MEMORY_MODULE_BENCHMARK_REBUILD_HNSW=true MEMORY_MODULE_BENCHMARK_FAST_SEED=true MEMORY_MODULE_BENCHMARK_LEAN_INDEX=true MEMORY_MODULE_BENCHMARK_VACUUM_CLEANUP=true MEMORY_BENCHMARK_DOCUMENTS=1000000 MEMORY_BENCHMARK_ASSERTIONS=10000 MEMORY_BENCHMARK_REQUESTS=20 MEMORY_BENCHMARK_CONCURRENCY=20 npm run benchmark:memory-postgres
DATABASE_URL=postgresql://... npm run check:companion-outage-backlog
DATABASE_URL=postgresql://... npm run check:memory-model-gateway
MEMORY_MODULE_URL=http://localhost:8791 MEMORY_MODULE_SDK_TENANT_ID=tenant-a MEMORY_MODULE_SDK_USER_ID=user-a npm run test:memory-sdk
DATABASE_URL=postgresql://... npm run test:memory-multiprocess
npm run test:companion-core-chat-concurrency
npm run test:companion-core-life-outbox
npm run test:companion-core-account-delete-recovery
MEMORY_RECOVERY_STATE=./artifacts/restored-state.json MEMORY_RECOVERY_LEDGER=./artifacts/deletion-ledger.json npm run check:memory-recovery
MEMORY_MODULE_SMOKE_APPLY_SCHEMA=true npm run test:memory-postgres
MEMORY_MODULE_EMBEDDING_DIMENSIONS=1536 npm run migrate:memory-pgvector -- --dry-run
MEMORY_MODULE_NATIVE_RETRIEVAL=true MEMORY_HYBRID_RETRIEVAL=true MEMORY_MODULE_PGVECTOR_ENABLED=true npm run start:memory-module
npm run benchmark:memory
MEMORY_BENCHMARK_DOCUMENTS=1000000 MEMORY_BENCHMARK_REQUESTS=20 MEMORY_BENCHMARK_CONCURRENCY=20 npm run benchmark:memory
MEMORY_EVAL_CASES=./artifacts/memory-eval-real-cases.json MEMORY_EVAL_RESULTS=./artifacts/memory-eval-real-results.json npm run evaluate:memory
npm run evaluate:memory-synthetic
npm run check:companion-alpha-gate
```

PostgreSQL smoke 需要 `DATABASE_URL`，缺少时只会安全跳过；设置 `MEMORY_MODULE_SMOKE_APPLY_SCHEMA=true` 会在随机隔离 tenant 上重复应用 canonical schema，并验证主体隔离、租约 fencing 和并发冲突。`npm run test:memory-multiprocess` 会在同一 PostgreSQL 上启动两个独立 worker 进程，验证单次消费、lease 清理、过期 lease 接管和旧 worker fencing；缺少 `DATABASE_URL` 时安全跳过。`migrate:memory-pgvector` 需要明确的 `MEMORY_MODULE_EMBEDDING_DIMENSIONS`，会创建 pgvector 列、回填 JSONB embedding 并建立 HNSW cosine 索引；`--dry-run` 不连接数据库。设置 `MEMORY_MODULE_NATIVE_RETRIEVAL=true` 后，retrieve 使用轻量 metadata + PostgreSQL native candidate 查询，context-bundle 使用 bounded profile/current-state/episode read model，并继续经过内存层的 policy/confirmation finalization。可选 `MEMORY_MODULE_REDIS_URL` 只缓存带 tenant/user、grant/privacy/commit 版本的无 query bounded ContextBundle read model；Redis 不可用时服务继续走 PostgreSQL canonical 路径，治理/写入会推进 subject generation 使旧缓存失效。`POST /v1/export-operations` + `GET /v1/export-operations/{id}/data` 提供 Memory Module 固定快照；主应用新增 `POST /api/export-operations`、`GET /api/export-operations/{id}`、`GET /api/export-operations/{id}/data`，manifest 组合消息、Memory、人格/关系、LifeState、任务、事件、偏好和 reconciliation，并明确缓存、日志、备份/PITR 与外部模型供应商的责任边界。产品本地 data revision 或 Memory commit sequence 变化时导出 fail-closed，不会隐式混合新旧数据。LifeState 事件的 forget/delete 通过 `/api/life/events/{id}/forget`、`DELETE /api/life/events/{id}` 进入可恢复治理账本；可用 `GET /api/life/events/{id}/governance` 查看 reconciliation，或 `POST /api/life/governance/{operationId}/repair` 重试本地投影。`npm run evaluate:memory-synthetic` 会用真实 in-memory domain 跑完 600 条 synthetic scaffold 并生成标注为 `synthetic`、不计入 Alpha acceptance 的结果。真实 `npm run evaluate:memory` 必须显式提供 cases 和 results 两个 JSON envelope：两者都要声明相同的 `version`、`datasetKind`（`real` 或 `deidentified`）、`synthetic: false` 和非空 `provenance`；cases 必须完整包含 600 条且每条带 `id`、`version`、`synthetic: false`，results 必须一一覆盖这 600 个 case。入口默认使用 `MEMORY_EVAL_SPLIT=all`，显式选择子 split、缺失元数据、synthetic scaffold、结果缺失或多余 case 都会 fail-closed，不生成指标。PostgreSQL benchmark 需要显式 `MEMORY_MODULE_BENCHMARK_DB_ENABLED=true`；`MEMORY_MODULE_BENCHMARK_LEAN_INDEX=true` 会报告 1M index-document 规模，但只使用较少 canonical assertion/version，不能替代完整生产容量验收。`npm run check:companion-outage-backlog` 是虚拟时钟退避/恢复演练，不替代生产 RPO/RTO。

发布前进度、隐私/密钥审计和 GitHub 推送阻断项见：[`docs/开发进度与GitHub发布前审计.md`](docs/开发进度与GitHub发布前审计.md)。

## Production modes

Local development uses `AUTH_MODE=off` and can use `MODEL_PROVIDER=mock`.
Public deployment must use `AUTH_MODE=required`, `STORAGE_PROVIDER=postgres`, certificate-verifying `DATABASE_SSL=true`/`require`/`verify-full`, one or more HTTPS `CLIENT_ORIGIN` values, a real model provider, and server-only secrets. Production startup fails closed when Auth is off, storage is not PostgreSQL, database TLS verification is not enabled, or the CORS origin is missing/non-HTTPS. The browser receives only the Supabase URL, anon key, model catalog, and non-secret connection status.

Supabase Auth users are isolated through request-scoped PostgreSQL state. The first authenticated user can claim the existing `local-user` state once; later users start with an empty state.

The independent Memory Module is in `services/memory-module/` and exposes the canonical versioned `/v1` contract backed by PostgreSQL. Apply `server/memory-module-schema.sql`, then configure its service token and trusted tenant/user/agent context headers behind the API boundary. Cochpia's `/api` compatibility routes are backed by the same Memory Module and do not maintain a second memory store.

Railway deployment templates are in `deploy/`. Use the API service health check at `/api/health` and set `VITE_API_BASE_URL` on the separate web service.

真实供应商测试只有在对应服务端环境变量存在时才执行；本地协议夹具和 Mock 流式链路可在无密钥环境验证。
