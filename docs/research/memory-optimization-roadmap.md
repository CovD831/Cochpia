# 记忆系统优化路线：开源调研对照与实施建议

> 基于 `llm-memory-survey.md`（Mem0/Letta/LangMem）与 `graph-memory-survey.md`
> （Zep/Graphiti、Cognee、HippoRAG/A-MEM）两份调研，对照 cochpia 当前实现
> （R-005/R-006 后：提取 drain + 快照投影 + BM25 检索 + forget 遗忘）。
> 调研时间：2026-09。

## 一、六组件对照

| 组件 | cochpia 现状 | 业界主流做法 | 差距评估 |
|---|---|---|---|
| 提取 | 单条 prompt 产 JSON 候选，drain 批处理 | Mem0 两阶段（抽取→AUDN 决策）；LangMem 后台 ReflectionExecutor；A-MEM 结构化笔记 | **核心差距：无"写入时决策"**。候选直接激活，无与已有记忆的关系判断 |
| 去重/合并 | canonical_key 约束隐式去重（skipped） | Mem0：MD5 哈希（词形还原后）双去重 + 语义检索相似已有记忆再决策 | 我们的隐式去重过于粗糙，语义相近但措辞不同的会重复入库 |
| 分类治理 | S0-S3 敏感度规则 + tombstone forget | Letta agent 自编辑；Mem0 scope+元数据；各家普遍无敏感度分级 | **S0-S3 + 确认流领先业界**（陪伴场景特有），但 S2 规则太粗（药物未覆盖） |
| 检索 | BM25 + CJK 二元分词，纯词法 | 普遍三路融合（语义+BM25+实体/图）+ RRF + 重排 + 语义阈值 | **最大差距**：语义改述全部 miss；无融合框架；无重排 |
| 上下文装配 | recalled 摘要 + 人格 + 历史；tokenBudget 空壳 | Mem0 只返回 Top-K 交给应用层；Letta 分层记忆 + 驱逐警告 | 差距中等：token 计量未实现，但装配结构已有雏形 |
| 冲突仲裁 | answerability=conflict 检测存在，无仲裁 | Zep：双时间戳边失效（最强）；Mem0：AUDN 写入时决策；A-MEM：属性软更新 | **第二大差距**：检测了冲突却不处理，conflict 的语义对用户是黑盒 |

## 二、可直接借鉴的机制（按性价比排序）

1. **AUDN 写入时决策**（Mem0）——解决三个已知问题的同一把钥匙：
   提取候选后，检索 top-k 相似已有记忆，让 LLM function calling 选择
   ADD/UPDATE/DELETE/NOOP。闲聊（NOOP）、语义重复（UPDATE/去重）、事实
   变更（UPDATE 旧失效）一次解决。我们已有全部基础设施：检索、断言版本、
   快照通道，缺的只是 drain 里的这一个决策步骤。
2. **哈希去重门**（Mem0）：词形还原后 MD5，跨已有+批内双去重——提取前的
   零成本过滤，一行降噪音。
3. **三路检索融合 + RRF**（Zep/Mem0）：语义向量 + BM25 + 实体增强，
   `combined = Σ signal / max_possible`（按可用信号归一化），语义低于阈值
   直接淘汰。`index_documents.embedding` 与 pgvector 配置面已存在，缺
   embedding provider 接入。
4. **Memory Decay 重排**（Mem0）：检索时按访问时间戳加权（近期 1.5x，
   长期不用衰减 0.3x），只重排不删除——治"记忆库越积越脏"而不丢数据。
5. **双时间戳失效模型**（Zep，中期）：断言加 `valid_at/invalid_at`
   （事件时间）与 `created_at/expired_at`（系统时间），矛盾事实触发旧断言
   失效而非覆盖。我们的 assertion_versions 已是版本骨架，扩展是数据模型
   演进而非重写。能同时回答"现在什么为真 / 当时什么为真 / 系统何时知道"。
6. **异步 drain**（LangMem background executor 模式）：冒烟实测 p50=4.3s /
   p95=9.9s，同步 drain 在请求路径不可接受。drain 移到响应之后
   fire-and-forget，复用现有 audit + 重试语义；记忆延迟一轮生效是可接受
   的最终一致。

## 三、不建议跟进的方向

- **Letta 式 agent 自编辑记忆**：要求模型自主调用记忆工具，与我们的
  "记忆事实归 Memory Module 独有、Core/应用不越界"的权威分工冲突，且把
  记忆正确性寄托在模型自律上，陪伴场景风险高。
- **A-MEM 的 ChromaDB 独立向量库**：Cognee 已证明"单 Postgres 收敛图+向量
  +元数据"可行且运维成本最低——我们已经是单 Postgres，方向一致，不引入
  独立向量库。
- **HippoRAG 的 PPR 图传播**：多跳关联检索对陪伴对话收益存疑（对话记忆
  少有长链推理需求），且需要离线 OpenIE 管道。搁置。

## 四、建议的实施序列

| 阶段 | 内容 | 依据 | 预估 |
|---|---|---|---|
| R-007a | drain 内加 AUDN 决策 + 哈希去重门 + 提取 prompt 加"值得长期记住"过滤 | 冒烟暴露的闲聊噪音与重复断言 | 小（一个决策 prompt + 去重函数） |
| R-007b | drain 移到响应后异步（fire-and-forget + 现有 retry/audit） | 冒烟 p95=9.9s | 小 |
| R-007c | 接 embedding provider（配置面已埋），`index_documents` 写 embedding，检索加语义路 + RRF 融合 | 检索主瓶颈 | 中（需选 embedding 端点） |
| R-008 | Zep 式双时间戳失效 + conflict 仲裁语义 + token 计量实现 | 数据模型演进 | 中 |
| Phase 3 | 600-case 质量评测 + decay 重排 + Memory Alpha gate | 原计划 | 大 |

## 五、一句话结论

我们的骨架（PostgreSQL 单库、S0-S3 治理、tombstone 遗忘、版本化断言）
在治理维度**领先**调研对象；落后的是检索（纯词法）和写入决策（无
AUDN）。最高杠杆的下一步是 Mem0 的写入时决策 + 三路检索融合，两者都
能落在现有 schema 与配置面上。
