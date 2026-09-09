# R-018 设计冻结（候选）：实体/关系记忆 + SAG 评估（2026-09-09）

> 老板提问：实体/关系怎么做的；之前提过的 Zleap-AI 的 SAG 能否使用。

## 1. 现状：实体/关系的"半成品"地基

| 已有 | 内容 | 缺什么 |
|---|---|---|
| `canonicalKey` | 事实主题键（favorite_movie、home_city）——**一维实体原型**：同 key = 同主题，R-016 已用它做换值仲裁 | 只有"事实主题"一维；没有"人/物/关系"实体节点，跨主题无法关联 |
| `subject_type/subject_id` | 断言归属主体（user/…），schema 预留 | 提取器从不产出非 user 的 subject；没有实体解析 |
| `relationshipAgentId` / relationship scope | 断言可归属关系代理 | 同上，未使用 |
| `projectStableProfile` | 按 user/relationship scope 投影稳定画像（孤儿工具） | 无实体维度可用 |

典型失败案例（eval B-S14，历史常败）：「我爸爸是高中老师。」↔
「家里人都是做什么的？」——查询与断言无词法重叠、语义相似度低于
0.55，两类通道都够不着。**这不是排序问题，是数据组织问题**：系统里
没有"爸爸"这个实体节点把两条信息连起来。

## 2. SAG 评估（Zleap-AI，开源 github.com/Zleap-AI/SAG，论文 arXiv 2606.15973）

SAG 是什么：RAG 的替代数据底座。chunk → event（完整事项）+ entities
（实体节点），event-entity 构成超边；SQL 扩展 + 向量 + 全文三路检索；
**查询时只激活局部超边邻域**（"顺藤摸瓜"），不预建全图。多跳问答
SOTA（8/9 指标最佳，Recall@2 79.3%），生产 5 亿级数据、秒级延迟。

**与我们的契合点（结论：借数据模型，不引依赖）**：

- SAG 的「event + entity + 时间 + 关系」四元组织，与我们的
  assertion + canonicalKey + bi-temporal + provenance **同构**——我们
  已经有 3/4，缺的恰是 entity 节点与关联索引这一块；
- SAG 论文自己承认：面向长期 Agent Memory 的**版本化与时间感知是
  future work**——而这是我们已有的强项（correction 版本区间、
  latest-wins 仲裁、治理分级）。两者的互补面正对上。

**不直接引入依赖的理由**：① 新运行时/技术栈 + 外部服务，违背零成本
最少依赖路线；② SAG 无治理语义（敏感性分级、确认门、授权、遗忘
墓碑），记忆类数据过它的索引等于治理旁路；③ 我们的规模（伴侣单人
千级记忆）用不到它为 5 亿文档设计的多跳机器，一跳扩展即可覆盖残余
失败模式。

## 3. R-018 设计（native SAG-lite：一跳实体扩展）

- **写入侧**：提取候选增加 `entities` 字段（人/宠物/物品/地点，1-5 个，
  few-shot 扩展 prompt；复用现有一次调用，不新增请求）；
  新表 `memory_assertion_entities`（assertion_id, entity_text,
  entity_norm, created_at）——S3/红action 时随 assertion 级联清理；
- **检索侧**：`retrieveAsync` 命中候选后做**一跳扩展**——查询自身抽取
  的实体（轻量：与现有 indexDocuments 的实体列做 SQL 交集）命中的
  实体所关联的断言，以低权重并入融合排名（不挤占双通道原序）；
- **flag**：`MEMORY_ENTITY_HOPS`，默认关；
- 边界：只做一跳（query→entity→assertion），不做多跳遍历——残余失败
  模式（B-S14/B-S22 类）全是单跳可达，多跳是过度设计。

## 4. Trade-off

| 维度 | 分析 |
|---|---|
| 收益 | B-S14 类"称谓/关系代词查询"从结构性失败变为可达；关系记忆有了实体骨架 |
| 风险 | 实体抽取质量差 → 错误关联进上下文；缓解：扩展项只做低权重补充、治理面不变、flag 可退 |
| 成本 | 提取 prompt +~150 token；一跳扩展是纯 SQL；无新模型调用 |

## 5. 低成本验证路径

- P-1 探针：对 eval 的 30 条 groupB 消息跑实体抽取，人工核对抽取质量
  （预期 ≥90% 关键实体命中）；对 B-S14/B-S22 验证一跳可达；
- E-2 实现 + 单测（写入/清理/扩展三面）；
- E-3 220-case：B-S14 类结构性失败消除，其余指标带内。

## 6. 状态

- [x] SAG 评估与选型（借模型不引依赖）
- [x] 设计冻结（待老板确认后实现）
- [ ] P-1 探针
- [ ] 实现 + E-2/E-3
