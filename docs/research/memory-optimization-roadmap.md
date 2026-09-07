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
| R-007a | ✅ 完成（3b294c7）：AUDN + 哈希去重门 + 提取过滤，真模型对比验证 | 冒烟暴露的闲聊噪音与重复断言 | 小 |
| R-007b | ✅ 完成（126cbb4）：setImmediate fire-and-forget，E-timing 验证 | 冒烟 p95=9.9s | 小 |
| R-007c | ✅ 完成（c2cda88）：Ollama bge-m3 @ openpilot-air + hybrid RRF，真模型验证 | 检索主瓶颈 | 中 |
| R-008 | ✅ 完成：conflict latest-wins 仲裁 + S2 词表稳定化；token 计量撤回（既有 compaction 已实现）；双时间戳挪 R-009 | 数据模型演进 | 中 |
| R-009 | ✅ 完成（291dc43）：双时间戳字段端到端贯通 | 数据模型演进 | 中 |
| R-010 | ✅ 完成（892e90b）：96-case 评测基线；首跑暴露 canonical_key 粒度、AUDN 无阈值、精度阈值三大缺陷 | 质量标尺 | 中 |
| R-011 | ✅ 完成：canonical_key 事实级语义键 + AUDN findSimilar 0.60 阈值 + 检索向量下限 0.55 + 零候选事件消费标记 + 索引落库修复（jsonb/lexical_version）+ 评测器八项修复；run9 基线：paraphrase 12→18、lexical 5→9、arbitration 0→4、dedup 真实 8/8；诚实负结果：noise 全局阈值无法完全分离（3/3 残留 1-2 条）、S2 词表缺口（9/12）、confirm 后不可直查（设计缺口） | R-010 首跑证据 + 探针校准 | 中 |
| R-012 | ✅ 完成（889085d）：S2 词表补全（s2 9→11/12）+ confirm 闸门合并方案 A（confirm 0→5/5，确认=授权直查+可入上下文，不主动提及）+ noise 归因（残留全是 BM25 词法通道命中）+ 池归因（退出残留非泄漏）。诚实负结果：模型类指标单 run 摆动大（dedup 8→3、paraphrase 18→11），Phase 3 必须多 run 均值 ± 方差 | R-011 run9 失败明细 | 中 |
| R-013 | ✅ 完成：S2 分类同时看 raw event 内容（run11 S2 12/12，C-S12 不再依赖改述措辞）；词法下限与 AUDN 稳定性按 R-012 计划移交 Phase 3 | R-012 run10 归因 | 小 |
| Phase 3a | ✅ 完成（e0912be 后续提交）：220 case × 3 runs 统计基线——机制类稳定（leak 100%、confirm 97.8%、s2 88.9%、noise 94.7%），dedup 20% 为量化后第一优先缺口（AUDN NOOP 不稳定）；词法下限与 AUDN 稳定性按 R-012 计划移交 Phase 3 | 修订版：600 手写题 → 220 case × 3 runs | 中 |
| Phase 3b | 待做：bulk 合成语料（500-2000 断言）→ 库深下的 precision@k / 延迟 / decay 测量 | Phase 3 修订 | 中 |
| Phase 3c | 待做：decay 重排实现 + AUDN NOOP 稳定性（针对 dedup 20%）+ 词法下限，用 3a/3b 数字验收 | Phase 3 修订 | 中 |
| promotion | 压后（老板拍板）：R-004-PROMOTION-PREPARE（Auth/TLS + context-spoofing 证据、cutover/rollback 演练）→ A-01~A-12 核对 | 主线收官 | 中 |

## 五、一句话结论

我们的骨架（PostgreSQL 单库、S0-S3 治理、tombstone 遗忘、版本化断言）
在治理维度**领先**调研对象；落后的是检索（纯词法）和写入决策（无
AUDN）。最高杠杆的下一步是 Mem0 的写入时决策 + 三路检索融合，两者都
能落在现有 schema 与配置面上。
