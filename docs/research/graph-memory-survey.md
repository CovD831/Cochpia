# 开源记忆系统实现机制调研：Zep/Graphiti、Cognee、HippoRAG/A-MEM

> 调研时间：2026 年 9 月。方法：官方文档、GitHub README/源码结构、论文（arXiv）。信息截至撰写时的最新版本（graphiti-core 0.29.x，2026-07；Cognee v1.3.x，2026 年 2 月完成 750 万美元种子轮；HippoRAG 2（ICML 2025）为当前主线；A-MEM 仓库最后更新 2025-12）。

---

## 一、Zep / Graphiti（getzep/graphiti）

Graphiti 是 Zep 的开源引擎，定位为"时序上下文图谱"（temporal context graph）。Zep 论文：arXiv 2501.13956。

### 1. 提取
- 摄入单元为 **episode**（消息、原始文本或结构化 JSON），每个 episode 落图为 Episodic 节点，作为 ground truth 保留，不做有损变换。
- 处理链条：LLM 从 episode 中抽取实体（节点）与事实（边，以"事实句子"形式存为边属性，构成 Node–Edge–Node 三元组）。节点支持 Pydantic 自定义实体/边类型（prescribed ontology），也支持学习式本体。
- **实体消歧**：对每个抽取出的实体，与图中已有相似节点做 LLM 判重（dedup），命中则复用旧节点并更新其"随时间演化的 summary"，否则新建。边同理：区分"新边"与"已有边被再次提及"。来源：https://github.com/getzep/graphiti 、https://blog.getzep.com/beyond-static-knowledge-graphs/
- 时机：episode 到达即增量处理（实时，非批量重建），无需全图重算。

### 2. 分类与治理
- 三层子图：**Episode 子图**（情景记忆/原始数据）、**语义实体子图**（实体+事实，节点带 1024D/1536D 嵌入）、**社区子图**（连通度高的实体做动态社区聚类并生成摘要，标签传播式更新）。来源：https://www.emergentmind.com/topics/zep-a-temporal-knowledge-graph-architecture
- 遗忘策略：不做物理删除，以边失效（见第 5 点）表达"不再是事实"；社区/摘要随新数据滚动更新。

### 3. 检索
- **混合检索三路并发**：① 语义向量（节点 name_embedding / 边 fact_embedding 余弦相似度）；② BM25 全文（数据库原生 Lucene/RedisSearch 索引，命中节点 name+summary、边 fact 字段）；③ BFS 图遍历（从起点节点/边按深度遍历 RELATES_TO、MENTIONS 边）。
- 融合：**RRF（Reciprocal Rank Fusion）** 或 MMR，再可选 **cross-encoder 重排**（OpenAI reranker 或 BGE reranker 客户端）；另有"以 top 结果源节点为中心的图距离重排"。检索配置化（SearchConfig + 预置 recipes，如 NODE_HYBRID_SEARCH_RRF）。来源：https://deepwiki.com/getzep/graphiti/4.3-llm-integration 、https://github.com/getzep/graphiti/blob/main/examples/quickstart/README.md
- 官方称生产环境亚 200ms 查询延迟；Zep 在 LongMemEval 上较基线准确率 +18.5%、延迟约 -90%。来源：https://www.emergentmind.com/topics/zep-a-temporal-knowledge-graph-architecture

### 4. 上下文装配
- 检索结果为结构化对象：边返回 fact、valid_at/invalid_at、source/target 节点 UUID、出处 episode；装配层（Zep 商业版的 Context Lake / 论文中的 χ 函数）把图事实格式化为带时间与溯源的上下文注入 LLM，而非扁平文档块。来源：https://www.getzep.com/ai-agents/temporal-knowledge-graph 、https://blog.getzep.com/stop-using-rag-for-agent-memory/

### 5. 冲突仲裁（核心：边失效机制）
- **双时间轴（bi-temporal）四时间戳**，每条边携带：
  - `valid_at` / `invalid_at`：现实世界时间（事实何时开始/停止为真），由 LLM 日期抽取 prompt 从 episode 内容推断（支持相对时间表达，用 episode 的 reference_time 锚定）；
  - `created_at` / `expired_at`：数据库事务时间（系统何时学到该事实/何时得知其失效）。
- **失效而非删除**：新 episode 抽取出新边后，对每条新边并发运行"失效判定 prompt"，以相似旧边为上下文，让 LLM 判断哪些旧边与之矛盾；命中的旧边设置 `invalid_at`（真实时间）与 `expired_at`（系统时间），保留完整历史。示例：先用 Adidas→后改口 Puma，"loves Adidas" 边被置 invalid_at 而非删除，并建立因果边。
- 由此可回答三类问题："现在什么为真"（过滤窗口开放的边）、"某日期什么为真"（point-in-time 查询，SearchFilters 按时间过滤）、"系统在 X 日知道什么"（事务时间查询）。迟到信息（2025 年才得知 2020 年的事）也自然处理。来源：https://mintlify.wiki/getzep/graphiti/concepts/temporal-model 、https://blog.getzep.com/beyond-static-knowledge-graphs/
- 对旧边的重新提及也会触发日期修正（如"哦不对，我是 8 月买的 iPhone"→ 更新 valid_at）。

### 6. 存储
- 图数据库抽象层 GraphDriver：**Neo4j（原默认）、FalkorDB、Kuzu（嵌入式）、Amazon Neptune（向量走 OpenSearch/AOSS）**。选型原因：图库原生同时提供图遍历、向量索引、全文索引三类能力，一次查询覆盖混合检索；FalkorDB/Kuzu 降低运维门槛。
- 与 PostgreSQL 的关系：Graphiti 本体不依赖 Postgres；Postgres 主要出现在 Zep 商业托管侧与社区部署方案中承担元数据/业务数据接入。来源：https://github.com/getzep/graphiti

---

## 二、Cognee（topoteretes/cognee）

开源（Apache-2.0）AI 记忆引擎，Python 3.10–3.14，v1.3.x。论文：arXiv 2505.24478；自建 BEAM 基准。

### 1. 提取
- **ECL 管道**（对标 ETL）：**E**xtract——从 38+ 数据源（PDF/DOCX/CSV/图片/音频/网页/数据库）抽取原始数据进入 Dataset；**C**ognify——文档分类→分块→LLM（经 Instructor 强制结构化输出 Pydantic 模型）抽取实体/关系→生成摘要→**本体锚定**（可加载 OWL 本体，模糊匹配把实体对齐到标准语义框架）；**L**oad——写入图库+向量库。来源：https://docs.cognee.ai 、https://github.com/topoteretes/cognee
- V2 记忆 API 把管道收敛为四个动词：`remember()`（= add+cognify+improve 一次跑完）、`recall()`（智能路由选检索策略）、`forget()`、`improve()`（用反馈/规则丰富图谱，即 memify 层）。
- 核心数据模型：DataPoint（一切节点基类，带版本与元数据）、Edge、Triplet（主谓宾）、KnowledgeGraph（节点+边容器）。

### 2. 分类与治理
- 三级层次 **User → Dataset → Data**，配 ACL 权限模型（读写删分享），开启 ENABLE_BACKEND_ACCESS_CONTROL 后每个"用户+数据集"拥有隔离的图/向量库——治理重心在多租户隔离而非记忆类型学。
- 遗忘：`forget()` 显式清理；记忆"从哪来"经 provenance 可视化 + OpenTelemetry 追溯。

### 3. 检索
- **14 种可插拔检索策略**（SearchType 枚举）：GRAPH_COMPLETION（默认，图遍历+LLM 补全）、GRAPH_COMPLETION_COT、TRIPLET_COMPLETION、RAG_COMPLETION、CHUNKS（向量）/CHUNKS_LEXICAL（词法）、CYPHER（直接执行图查询）、NATURAL_LANGUAGE（NL→结构化查询）、TEMPORAL（时序图检索）、FEELING_LUCKY（自动选策略）等。
- 融合方式：`recall()` 做策略路由（而非单次多路融合排序），向量负责"找得到"、图负责"想得通"。来源：https://onegen.ai/project/unlocking-the-potential-of-cognee-a-comprehensive-guide-to-logging-and-community-contributions/

### 4. 上下文装配
- GRAPH_COMPLETION 系列策略在图上取相关子图/三元组后拼装为 LLM 上下文；SUMMARIES 策略返回摘要节点。无显式 token 预算机制的公开文档，装配粒度由检索策略决定。

### 5. 冲突仲裁
- 相对薄弱：主要靠本体锚定减少实体幻觉、图谱随新数据增量丰富（同一实体聚合新关系），没有 Zep 式的显式边失效/双时间戳机制（TEMPORAL 检索依赖其时序图模块 temporal_graph，仍属探索性）。事实矛盾处理未见官方专述。

### 6. 存储
- 接口化四类后端可插拔：图（默认 **Ladybug，基于 KuzuDB 嵌入式**；另有 Neo4j/Neptune/FalkorDB）、向量（默认 LanceDB；PGVector/Chroma/Qdrant/Weaviate/Milvus）、关系库（SQLite/Postgres，存元数据与状态）、会话缓存（SQLite/Postgres/Redis）。
- 亮点：**一套 Postgres 跑满整层**——图（关系表化）、pgvector 嵌入、会话、元数据全部进同一实例，官方 CI 基准显示比"独立图库+独立向量库"快约 10%，把记忆层运维压到最低。来源：https://rywalker.com/research/cognee 、https://aibars.net/en/projects/724990972701839360

---

## 三、HippoRAG（OSU-NLP-Group）与 A-MEM（agiresearch）

### HippoRAG / HippoRAG 2
论文：NeurIPS 2024（arXiv 2405.14831）、HippoRAG 2 ICML 2025（arXiv 2502.14802）。

**1. 提取**：离线索引两阶段——LLM 对每段做 **NER + OpenIE** 抽取开放三元组（无 schema），主宾为**短语节点**、关系为**关系边**；检索编码器（ColBERTv2/DPR/Contriever）做**同义词检测**，相似短语间加**同义词边**提升连通性；建立"文档-事实-短语"两级 CSR 稀疏映射矩阵。时机：离线批量（新增语料追加索引）。来源：https://arxiv.org/pdf/2405.14831 、https://www.agentpatternscatalog.org/compositions/hipporag

**2. 分类与治理**：无记忆类型分层、无敏感处理——它是 RAG 框架而非记忆服务；HippoRAG 2 自称"非参数持续学习"系统（知识进图谱即持续学习，无需改模型参数）。遗忘=不写入/不检索，无主动遗忘机制。

**3. 检索（核心：PPR）**：在线时 LLM 对查询抽实体（v1）或做 **query-to-triple 匹配**（v2，整体查询与三元组对齐，召回@5 平均 +12.5%）；v2 增加**识别记忆**：LLM 过滤 top-k 检索三元组去噪后作种子；**Personalized PageRank**（igraph 实现，阻尼≈0.85，重置概率=实体链接得分，v2 段落节点权重因子 0.05）在图上传播概率，"节点权重→事实权重→文档权重"两级矩阵映射出文档分；v1 按实体链接置信度决定图谱分与稠密检索分融合比例（高置信只用图谱分，低置信 0.5:0.5）。**v2 密集-稀疏集成**：段落本身作为段落节点以 context edge（"contains"）挂到短语节点上，同时具备概念骨架与上下文血肉。单步多跳检索比 IRCoT 便宜 10–30 倍、快 6–13 倍；v2 七个基准平均 F1 59.8（NV-Embed-v2 为 57.0）。来源：https://arxiv.org/pdf/2502.14802 、https://memorypapers.org/papers/hipporag-2-rag-to-memory 、https://bdtechtalks.com/2024/06/17/hipporag-llm-retrieval/

**4. 上下文装配**：PPR 排序后取 top 段落（默认 5）原文喂给 QA 阅读器 LLM；图谱只作检索辅助、不直接生成，减少 LLM 噪声。

**5. 冲突仲裁**：无显式机制。新知识即新三元组入图，不失效旧边（同义边只能缓解表述差异，不能仲裁矛盾）——这是与 Zep 的本质差距。

**6. 存储**：自研轻量方案——v1 内存中 numpy 稀疏矩阵 + igraph + ColBERTv2/DPR 索引；不依赖 Neo4j/图数据库（HippoRAG 2 支持外部图库存三元组但非必需）。选型原因：研究导向，PPR 只需可迭代图结构，避免重库依赖。来源：https://github.com/OSU-NLP-Group/HippoRAG

### A-MEM
论文：arXiv 2502.12110（Rutgers/AIOS Foundation）；生产仓库 agiresearch/A-mem（MIT，已并入 AIOS）。

**1. 提取**：每条新记忆生成一张**结构化笔记**：LLM 自动生成 context（上下文描述）、keywords、tags（未提供则自动抽取）；用"内容+元数据"共同生成增强嵌入。时机：写入时逐条处理。来源：https://arxiv.org/pdf/2502.12110v7 、https://github.com/agiresearch/a-mem

**2. 分类与治理**：Zettelkasten 卡片盒原则——记忆即笔记，靠 tags/category 弱分类；治理核心是**记忆演化**而非遗忘：新笔记加入（或更新）时自动分析历史笔记，触发旧记忆的 **metadata 与 context 更新**并建立新链接，网络持续自我精炼。

**3. 检索**：ChromaDB 向量相似搜索（`search_agentic`，embedding 用 all-MiniLM-L6-v2 等），链接的笔记网络提供关联扩展；无词法/图算法检索，也无多路融合——检索信号只有"增强嵌入相似度 + 链接结构"。

**4. 上下文装配**：以笔记为单位返回（content + tags + context + keywords），k 参数控制数量；无复杂预算机制。

**5. 冲突仲裁**：无失效/删除机制；`update()` 手动改写笔记，演化机制靠"旧记忆被新记忆触发后属性更新"来软性吸收变化——更新的是旧记忆的描述与标签，不是事实的真伪状态。

**6. 存储**：**ChromaDB**（向量持久化）+ 内存中的链接结构，LLM 后端 OpenAI/Ollama/SGLang/OpenRouter。选型原因：轻量、可本地部署、把复杂度留给 LLM 决策（agentic）而非数据库 schema——论文明确反对 Mem0 式"预定义 schema 的图库"限制适应性。来源：https://github.com/agiresearch/a-mem

---

## 四、横向小结（对齐我们记忆系统组件）

| 维度 | Zep/Graphiti | Cognee | HippoRAG 2 | A-MEM |
|---|---|---|---|---|
| 提取 | episode 增量→实体+事实+消歧 | ECL 管道，Instructor 结构化抽取 | 离线 OpenIE 三元组 | LLM 生成结构化笔记 |
| 治理 | 三层子图+社区 | 多租户 ACL | 无 | Zettelkasten 演化 |
| 检索 | 向量+BM25+BFS，RRF+重排 | 14 策略路由 | PPR+识别记忆 | 向量+链接 |
| 冲突 | 双时间戳边失效（最强） | 无显式机制 | 无 | 属性软更新 |
| 存储 | Neo4j/FalkorDB/Kuzu/Neptune | 可单 Postgres 收敛 | 自研矩阵+igraph | ChromaDB |

**对我们系统的三点启示**：① 冲突仲裁值得抄 Zep 的"失效不删除 + 双时间戳"数据模型，它是唯一能同时回答"现在/当时/系统何时知道"三问的设计；② 检索融合上，Zep 的"三路并发+RRF+cross-encoder"与 HippoRAG 的"PPR 图传播"可互补——前者覆盖召回面，后者强化多跳关联；③ Cognee 的"单 Postgres 收敛图+向量+元数据"大幅降低运维成本，是中小规模部署的务实参照。
