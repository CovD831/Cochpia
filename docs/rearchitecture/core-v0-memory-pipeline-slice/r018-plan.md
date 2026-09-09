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


## 7. 对抗性审查修订（2026-09-09，R018-AR-001..007，3 blocking）

审查结论：**SAG 选型结论维持，设计按以下修订后方可实现**。

### 7.1 修订一：收益重新划界（AR-003，最重的一刀）

原设计的动机案例 B-S14 **不成立**：「家里人都是做什么的」→「爸爸是
高中老师」需要 家里人→爸爸 的**类别语义桥**，一跳词法实体匹配提供
不了（爸爸与家里人无共同表面实体）——即使真 SAG 也需要这条边先存在。
B-S26（养了什么→鹦鹉）同理。三 case 推演：仅 B-S22 部分可达
（家里/家里 共面）。

**重新划界**：R-018 的目标场景 = **查询点名实体**（"鹦鹉会学舌吗"→
鹦鹉、"尘螨怎么除"→尘螨）。类别代词查询（B-S14/B-S26 类）保持开放，
归 future work（实体层级或语义实体链接，需另立项）。诚实预期：本条
目**不会**消除 B-S14。

### 7.2 修订二：存储唯一化（AR-001）

实体唯一存放于 **indexDocuments.entity_norms（text[] 新列）**，随索引
重建写入；废弃"新表"方案。需要：schema SQL 增列 +
MEMORY_PRODUCTION_REQUIRED_COLUMNS 同步（readiness 结构校验会拒绝缺列
的库）+ forget/forgetSession/forgetAccount 级联（indexDocument 生命
周期已覆盖，无独立授权面）。列含 tenant/user 隔离（indexDocuments
已有）。

### 7.3 修订三：norm 一致性成为 P-1 的核心指标（AR-002）

P-1 除抽取命中率外，必须测量**跨轮 norm 一致率**：同一指称在不同
消息中 → 同一 norm ≥90%（few-shot 指定"用消息中对该实体的称呼"作为
norm，不做同义词合并——那是语义链接的活，本条目不做）。不达标则
本条目止损，不进实现。

### 7.4 修订四：扩展触发与注入规则（AR-004）

仅当 (a) 基础检索结果 < 5 条（稀疏）或 (b) 查询实体与 indexDocuments
的 entity_norms **精确匹配**时触发扩展；注入项排在双通道结果之后补
limit 空隙（不参与 RRF 排序），单次扩展 ≤10 条。

### 7.5 修订五：治理规则（AR-005）

仅 **active** 断言的实体进入 entity_norms（S2-pending/S3 不入）；
cleanDerivedForDeletion 的现有级联天然覆盖（entity_norms 在
indexDocument 行上）；无新增授权面。

### 7.6 修订六：评测与解读（AR-006/007）

- 新增 **10 条实体点名补充 case**（独立 supplement 文件单独跑，不动
  220 基线）；
- E-3 解读注意：提取 prompt 变更会整体移动模型类指标，对照基线是
  defaults-run1，允许带内漂移，但 entities 解析必须健壮（非数组/
  超长 → 忽略该字段，不报错不丢候选）。

### 7.7 状态

- [x] 对抗性审查（7 findings 全部 consumed）
- [x] 设计修订 v2（本节）
- [ ] P-1 探针（含 norm 一致率测量）
- [ ] 实现 + E-2/E-3（含 supplement case）