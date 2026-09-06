# R-007c 实施计划：语义检索接入（Ollama bge-m3 + hybrid RRF）

> 依据：roadmap 借鉴项 3（三路融合）。基线：`126cbb4`。
> **关键发现**：混合检索的基础设施在 Module 里已全部实现——`options.embeddingGateway`
> 注入点、`featureFlags.hybridRetrieval` 开关、`hybridSearch`（BM25 + 向量 +
> RRF 融合 + 语义阈值淘汰）、`index_documents` 的 jsonb+pgvector 双列持久化、
> `parsePgvectorVector` 回读——缺的只是一个 embedding gateway 实现和接线。
> 模型部署：Ollama 0.30.10 已在 openpilot-air 运行（10.65.55.215，serve 监听
> 127.0.0.1:11434），bge-m3 拉取中。开发期本机经 SSH 隧道访问。

## 1. 目标与非目标

目标：
- `createOllamaEmbeddingGateway({ url, model, timeoutMs })`：OpenAI 兼容
  `/api/embeddings` 调用，text → vector，失败返回 null（永不抛出）；
- drain promote 成功后为断言生成 embedding，写入 `state.indexDocuments`
  （sourceType='assertion'，embeddingVersion 标记模型版本），随 module save
  持久化；embedding 失败仅记录 audit，不阻塞断言激活；
- production adapter 接线：`MEMORY_HYBRID_RETRIEVAL=true` 开启
  `featureFlags.hybridRetrieval`；`MEMORY_EMBEDDING_URL`/`MEMORY_EMBEDDING_MODEL`
  构造 gateway；`MEMORY_MODULE_EMBEDDING_TIMEOUT_MS` 覆盖检索超时（默认
  150ms 对冷启动模型过短）；
- 检索降级保证：无 gateway、embedding 超时或库内无向量时自动回落纯 BM25
  （既有行为，`hybridSearch` 的 mode 字段如实上报）。

非目标：pgvector 原生 SQL 检索（`nativeRetriever` 路径，留待规模需要）；
embedding 维度校验强制化（bge-m3=1024，写库时自然一致）；云端 embedding。

## 2. 设计

### 2.1 embedding gateway

`POST {url}`（默认 `http://127.0.0.1:11434/api/embeddings`），body
`{ model, prompt: text }`，Ollama 原生端点（与 OpenAI 兼容端点等价且少一层
转换）；响应 `{"embedding":[...]}`。`gateway(text) -> Promise<vector|null>`，
非 200/畸形/超时 → null。

### 2.2 写入侧（drain）

promote 成功后：`embedding = await gateway(currentVersion.content)`（带
per-call 超时）；成功 → `state.indexDocuments.push({ id, sourceType:
'assertion', sourceId: assertion.id, sourceVersion: version.id, searchText:
content, embedding, embeddingVersion: model, indexStatus: 'active', ... })`；
失败 → audit `memory_embedding_failed`，断言照常激活（BM25 兜底）。生成
调用计入 drain 时间预算。

### 2.3 读取侧（retrieve）

`moduleOptions.featureFlags = { hybridRetrieval: true }` +
`moduleOptions.embeddingGateway`，由 production adapter 按 env 组装。检索
路径：documents 带 embedding → hybridSearch（BM25 ∥ vector → RRF）→
finalizeRetrieve 语义阈值淘汰照旧。

### 2.4 涉及文件

| 文件 | 变更 |
|---|---|
| `server/memory-embedding.js`（新） | `createOllamaEmbeddingGateway` |
| `server/memory-extraction.js` | promote 后的 embedding 写入（含 audit） |
| `server/core-v0-production.js` | env 组装 featureFlags + embeddingGateway + 超时覆盖 |
| `server/core-v0-memory-pipeline.test.js` | gateway mock 测试（写入/降级/RRF 融合） |
| `scripts/extraction-smoke.js` | 语义检索对比（"忌口"等改述查询命中"过敏"断言） |

### 2.5 部署拓扑（开发期）

- Ollama 跑在 openpilot-air（已有），模型 bge-m3（arm64 本地推理）；
- 本机 cochpia + 本机 PG 不变；本机以 SSH 隧道
  `ssh -f -N -L 11434:127.0.0.1:11434 openpilot-air` 访问 Air 的 serve
  （`MEMORY_EMBEDDING_URL=http://127.0.0.1:11434`）；生产改为 Air 本地直连，
  仅配置不同。

## 3. 验收

- B-21 embedding 写入：promote 后 index_documents 有该断言的 active 文档
  且向量维度一致（1024）；
- B-22 语义召回：改述查询（"忌口"/"不能吃什么" vs "花生过敏"）经语义路
  命中，RRF 融合 mode=hybrid_rrf；
- B-23 降级：gateway 不可达时检索回落 BM25，无异常冒泡；
- B-24 真模型冒烟复跑：改述查询召回语义相关断言（原 BM25 不可达的查询）。

## 4. 风险与对策

- Ollama 冷启动首查慢（模型加载 1-2s）：drain 侧计入预算；检索侧超时回落
  BM25；预热在 drain 首次调用时自然完成；
- embedding 失败不重试（断言照常激活）：audit 可见，下次 correct/update
  会再生成；
- 手机热点 IP 变化：SSH 隧道走 mDNS 主机名（abaabadeMacBook-Air.local），
  与 IP 无关。
