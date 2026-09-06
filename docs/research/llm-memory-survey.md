# 开源 LLM 记忆系统实现机制调研

> 调研对象：Mem0（mem0ai/mem0）、Letta（letta-ai/letta，前身 MemGPT）、LangMem（langchain-ai/langmem）
> 调研时间：2026-09。标注约定：**[文档]** = 官方文档/博客明确说明；**[源码]** = 源码或第三方源码分析推断。

## 一、Mem0（mem0ai/mem0）

### 1. 提取
两阶段流水线。Phase 1 用 `MEMORY_DEDUCTION_PROMPT` 从「最近 10 条消息 + 异步更新的对话摘要」中提取事实候选（bullet list）[源码：https://virtuslab.com/blog/ai/git-hub-all-stars-2/]；Phase 2 对每个候选做 AUDN 决策。平台版 V3 已改为**单遍 ADD-only**（一次 LLM 调用，延迟减半，agent 产出的事实也一等公民存储）[文档：https://docs.mem0.ai/migration/platform-v2-to-v3]。开源版 `add()` 是 8 阶段流水线：上下文收集（SQLite 取最近 10 条消息做代词消解）→ 向量检索已有记忆（top_k=10）→ 单次 LLM 抽取 → 批量 embed → MD5 哈希去重（文本先词形还原再哈希，跨已有+批内双去重）→ 批量写入 → 实体链接 → 存 SQLite 历史。非阻塞容错：核心写入必成功，实体链接/历史允许降级 [源码：mem0/memory/main.py]。

### 2. 分类与治理
无显式记忆类型分类，靠 scope（user_id/agent_id/run_id）+ 元数据过滤（支持 AND/OR/NOT 操作符）治理。遗忘机制三层 [文档：https://mem0.ai/blog/memory-eviction-and-forgetting-in-ai-agents]：
- API 级删除：`client.delete()` / `batch_delete()` / filter 删除（无 filter 拒绝全删的安全检查）；
- 矛盾时 supersession（见冲突仲裁）；
- **Memory Decay**：检索时重排而非删除——最近访问最高 1.5x 加权、长期不用衰减至 0.3x，每条记忆追踪最多 20 个访问时间戳，`client.project.update(decay=True)` 开启。

### 3. 检索
混合多信号 [源码：mem0/memory/search.py，经第三方源码分析交叉验证]：
- 语义向量：超取 4x、≥60 条候选池；
- BM25 关键词：词形还原、分数归一化到 [0,1]；
- 实体增强：实体向量搜索→关联记忆→衰减权重 `1/(1+0.001·(n-1)²)`，增强上限 0.5。

融合公式 `combined=(semantic+bm25+entity)/max_possible`，`max_possible` 按可用信号动态取 1.0/1.5/2.0/2.5 保证不同配置下分数可比；semantic score 低于 threshold 直接淘汰（关键词碰中也不放行）。可选重排（rerank）。

### 4. 上下文装配
Mem0 不管理 prompt，只返回 `search()` 的 Top-K MemoryItem（id/memory/score/metadata/timestamps），装配完全交给应用层 [文档：https://github.com/mem0ai/mem0]。

### 5. 冲突仲裁
AUDN [文档+源码：UPDATE_MEMORY_PROMPT；https://terencecho.github.io/research-explained/mem0]：
先对候选做语义检索取 top-k（默认 10）相似已有记忆，已有记忆映射为整数索引（0,1,2…防 UUID 幻觉），LLM 通过 function calling 输出四选一：
- **ADD**：无语义等价记忆，新建；
- **UPDATE**：新信息补充/修正/刷新既有记忆，合并；
- **DELETE**：新事实与既有记忆矛盾，删旧的；
- **NOOP**：重复或无价值，不动。

决策在**写入时**完成而非检索时。注意：平台 V3 反向演进为不覆盖——新旧事实都保留+时间上下文（"used to live in NY" vs "now in SF"），冲突下沉到检索期用时间信号排序 [文档：https://docs.mem0.ai/migration/platform-v2-to-v3]。

### 6. 存储
Provider 插件式：向量库可选 Qdrant/FAISS/pgvector/LanceDB 等 20+（不绑死企业既有基础设施）；图变体 Mem0g 用 Neo4j 存实体三元组（LLM 抽实体→LLM 生成关系→embedding 相似度复用节点）；SQLite 存历史/审计支持回放 [文档：https://github.com/mem0ai/mem0]。

## 二、Letta（letta-ai/letta，前身 MemGPT）

### 1. 提取
**Agent 自主发起**，无独立提取流水线。agent 在正常 ReAct 循环中通过工具调用决定记什么：`core_memory_append` / `core_memory_replace` 写核心块，`archival_memory_insert` 存长期知识。「忘记记忆」需要刻意不调工具——提取即 agent 的本职推理 [文档：https://docs.letta.com/memory/concepts]。可选 **sleep-time compute**：空闲期由独立 sleep-time agent 异步重组主 agent 的记忆（抽象模式、解矛盾、预计算关联），可用更强模型 [文档：https://docs.letta.com/guides/agents/sleep-time-agents]。

### 2. 分类与治理
三层记忆即分类 [文档：https://docs.letta.com/memory/concepts]：
- **core memory**：常驻上下文的记忆块（默认 human/persona 两块，每块字符上限约 2000）；
- **recall memory**：全部对话历史的可搜索外部库；
- **archival memory**：无限长期库。

无敏感信息处理机制（文档未提及）。遗忘是隐式的：agent 主动 replace/覆写块内容即「遗忘」。

### 3. 检索
Agentic 检索——agent 决定何时搜、搜哪层、用什么 query：`archival_memory_search`（语义/向量，支持 tag 过滤）、`conversation_search` / `conversation_search_date`（按内容或时间范围查 recall）。可链式多次检索并自我精化。无时间衰减/重要性打分，排序交给向量库 [文档：https://docs.letta.com/memory/archival]。

### 4. 上下文装配
核心创新（OS 类比：context=RAM、recall=SSD、archival=磁盘）[源码推断自 MemGPT 论文机制；https://aiwiki.ai/wiki/letta]：
core memory 块直接注入 system prompt 常驻可见；消息缓冲区满时系统发 "you are running out of context" 警告，agent 必须自主决定驱逐什么到 recall、摘要什么进 core、归档什么；被驱逐消息经**递归摘要**（旧摘要+新驱逐消息再摘要）压缩驻留。分页进出由模型自己控制。

### 5. 冲突仲裁
主要靠 agent 自己 `core_memory_replace` 覆写旧事实；sleep-time agent 会在后台解决存储事实间的矛盾 [文档：同上 sleep-time]。无版本化机制，块就是当前态字符串。第三方分析提到有记忆编辑校验（另一 LLM 验证合理性）但增加成本 [第三方推断：https://ima.qq.com/wiki/?shareId=b11371ad891c7566684cba3c3dbb1b624a0624fd64396b992bf40417d762c59a，非官方]。

### 6. 存储
Letta Server 默认 PostgreSQL 持久化（agent 状态、消息、passages），archival 用 pgvector 类向量索引。原因：agent 即长驻进程，需要进程级持久化而非函数级 [文档：https://docs.letta.com]。

## 三、LangMem（langchain-ai/langmem）

### 1. 提取
LLM 判断。`create_memory_manager(instructions, schemas, enable_inserts)` 接收 `{messages, existing}`，LLM 输出更新后的记忆状态（ExtractedMemory 列表，Pydantic schema 结构化）[文档：https://www.langchain.com/blog/langmem-sdk-launch]。双模式可叠加：
- **hot path**：agent 调 `create_manage_memory_tool` / `create_search_memory_tool` 实时存取；
- **background memory formation**：`ReflectionExecutor` + `create_thread_extractor` 在对话结束后异步提取整合，零延迟影响。

[文档：https://langchain-ai.github.io/langmem/]

### 2. 分类与治理
显式三类 [文档：https://deepwiki.com/langchain-ai/langmem/1.2-key-concepts]：
- **semantic**（事实）：两种 pattern——Collection 无限累积 vs Profile 单文档 in-place 更新表当前态；
- **episodic**（经历）：Episode schema（observation/thoughts/action/result），存成功交互做 few-shot；
- **procedural**（行为）：`create_prompt_optimizer` 迭代优化系统提示词。

另有短期记忆（summarize_messages）。隐私治理靠 namespace 层级隔离（`("memories", "{user_id}")`，模板变量）。无内建遗忘/删除策略（靠 store 的 delete API）。

### 3. 检索
仅向量相似度（LangGraph Store 内建 index 配置：`{"dims": 1536, "embed": ...}`）+ metadata 过滤 + namespace 隔离。无词法/图检索。文档明确指出理想召回应融合 similarity + importance + strength（strength = 最近使用/频率的函数），但这是设计原则而非内建实现 [文档：https://langchain-ai.github.io/langmem/concepts/conceptual_guide/]。

### 4. 上下文装配
两种：显式（agent 调 search 工具）+ 隐式注入（不经检索直接把记忆放进 prompt，如 profile）。无 token 预算管理器。

### 5. 冲突仲裁
由 memory manager 的 LLM 决策——文档描述为对既有 beliefs 做 reconcile：**删除/失效（delete/invalidate）或 更新/整合（update/consolidate）**；Profile 模式天然无冲突（单文档覆写）。`memory enrichment process` 在「新建」与「整合」间平衡，instructions 可调倾向，防过度提取（精度降）与提取不足（召回降）两种失败 [文档：conceptual_guide]。无显式 ADD/UPDATE/DELETE 枚举、无 confidence 字段（conceptual guide 未披露；API Reference 层面存在 patch/create 决策但属源码细节）。

### 6. 存储
存储无关（Core API 无副作用、可接任意后端），有状态层基于 LangGraph BaseStore：InMemoryStore（开发）/ AsyncPostgresStore（生产）/ Platform Store（云）。原因：轻量组件定位，嵌入既有 LangGraph 基础设施 [文档：https://github.com/langchain-ai/langmem]。

## 四、对 cochpia 的可借鉴点

cochpia 现状：提取用单条 LLM prompt 产 JSON 候选（无 ADD/UPDATE/DELETE 决策、闲聊过滤缺失）；检索是 BM25 中文二元分词纯词法（无向量）；上下文装配无 token 预算计量；冲突时 answerability=conflict 但无仲裁；治理有 S0-S3 敏感度 + tombstone 遗忘。

1. **补 AUDN 决策层（优先级最高）**：Mem0 的「检索 top-k 相似已有记忆→映射整数索引→LLM function calling 选 ADD/UPDATE/DELETE/NOOP」模式可直接套在现有单条 prompt 产 JSON 候选之后，把决策从提取中分离；闲聊过滤可借 MEMORY_DEDUCTION_PROMPT 思路在提取 prompt 中加「只输出 facts/preferences」约束 + V3 的 agent 事实一等公民原则。
2. **去重加哈希门**：Mem0 的「词形还原→MD5→跨已有+批内双比对」是零成本去重，比纯 LLM 便宜；中文场景可换成二元分词后哈希。
3. **检索信号融合参考**：BM25 纯词法可保留，仿 Mem0 的归一化+多信号 `max_possible` 动态融合，后续加向量一路即可平滑升级；threshold 守门（语义不相关直接淘汰）值得抄。
4. **时间衰减重排**：Memory Decay（访问时间戳→1.5x/0.3x 重排，不删除）与现有 tombstone 正交，可低成本叠加。
5. **冲突仲裁二选一路线**：短期学 OSS Mem0 写入时 LLM 仲裁（复用 AUDN）；长期可学 V3 平台版——不覆盖、新旧共存+时间上下文，把冲突从 answerability=conflict 的标记态变成可检索的时间版本化。现有 S0-S3+tombstone 治理比 LangMem/Letta 都完善，可保持。
6. **token 预算**：Letta 的 core memory 字符上限 + 驱逐警告机制提示：装配层至少要有硬预算计量和超限时的摘要降级路径。
7. **后台记忆形成**：LangMem 的 ReflectionExecutor 模式（对话结束后异步跑提取+整合）适合避免同步提取延迟，与现有单 prompt 架构兼容。

## 参考来源

- Mem0 遗忘与 Decay：https://mem0.ai/blog/memory-eviction-and-forgetting-in-ai-agents
- Mem0 平台 V3 迁移（单遍 ADD-only、混合检索）：https://docs.mem0.ai/migration/platform-v2-to-v3
- Mem0 两阶段与 AUDN 解析：https://virtuslab.com/blog/ai/git-hub-all-stars-2/ 、https://terencecho.github.io/research-explained/mem0
- Mem0 GitHub：https://github.com/mem0ai/mem0
- Letta 记忆概念：https://docs.letta.com/memory/concepts 、https://docs.letta.com/memory/archival
- Letta 架构解析：https://aiwiki.ai/wiki/letta 、https://sureprompts.com/blog/letta-memgpt-walkthrough
- LangMem 官方文档：https://langchain-ai.github.io/langmem/ 、https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- LangMem 发布博客：https://www.langchain.com/blog/langmem-sdk-launch
- LangMem 源码结构（DeepWiki）：https://deepwiki.com/langchain-ai/langmem/1.2-key-concepts
- Letta vs LangChain Memory 对比：https://vectorize.io/articles/letta-vs-langchain-memory
