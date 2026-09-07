# R-011 实施计划：canonical_key 粒度 + 相似度阈值（修复 + 重跑基线）

> 依据：R-010 首跑暴露的三个系统缺陷 + 两份探针证据。基线 `892e90b`。
> 目标是让 R-010 的评测数字第一次变得**可解释**，产出第一份可信质量基线。

## 1. 根因与证据

### 1.1 缺陷一：canonical_key 缺省粒度是 scope+memoryType

`makeAssertion` 的缺省 canonicalKey 是 `${scopeKey}:${memoryType}`。
提取器不产出 key 时，同一 scope 下所有 fact 断言共享 `user:fact` 一个键，
`detectConflicts` 把任何内容差异都判为 conflict：

- B 组 8 个 paraphrase miss 的 answerability 全是 conflict（冲突洪水淹没召回）；
- C 组 arbitration 全部 stuck at conflict；
- latest-wins 压制按 canonical_key 分组，一键一组意味着压掉同键下全部旧事实。

### 1.2 缺陷二：AUDN findSimilar 无相似度阈值

findSimilar 走同步 BM25 retrieve，任一 token 重叠（CJK 二元分词下
「用户」「喜欢」级别）即返回 top-5。auditor 面对的是**词法碰巧重叠的无关
记忆**，会错误 UPDATE 覆盖无关断言内容。对齐 Mem0：低于阈值直接淘汰，
不进决策。

### 1.3 缺陷三：无关查询无精度阈值

vectorSearch 只过滤 score>0。bge-m3 对无关中文对也有 0.35-0.55 的余弦，
3 条 noise 查询全部召回 8 条。

### 1.4 探针证据（`.rearchitecture-runs/probes/`，2026-09-06）

**提取探针**（19 条 C 组消息直打 DeepSeek v4 flash）：
14/19 能提取；5 条返回空（1 条空响应 + 4 条显式 `{"candidates":[]}`），
全部是健康/财务/PII 内容——模型侧随机拒答，不是管线阻断。R-010 的 17/17
全零应理解为「拒答率在那次运行中偏高」+ 后续缺陷的复合结果。结论：提取
prompt 需要显式声明健康/财务事实属于提取范围（有 S2 治理保护），归入
本 slice 的 prompt 加固。

**余弦校准探针**（bge-m3，28 个查询对 × 18 条事实 + 10 个 AUDN 对）：

| 分布 | min | median | max |
|---|---|---|---|
| 查询↔目标事实（28 对） | 0.487 | 0.716 | 0.902 |
| 查询↔非目标事实 | — | 0.415 | 0.787 |
| noise 查询↔全部事实 | 0.356 | — | **0.546** |
| AUDN 同事实改述 | 0.908 | — | 0.928 |
| AUDN 同主题换值 | **0.664** | — | 0.880 |
| AUDN 无关事实对 | 0.521 | — | **0.575** |

阈值落点（探针实测的分离间隙）：

- **AUDN findSimilar 阈值 = 0.60**：无关对 max 0.575 < 0.60 < 同主题 min 0.664；
- **检索向量下限 = 0.55**：noise max 0.546 < 0.55 < 最低存留目标 0.555。
  代价：28 个目标对中 3 个（0.487/0.525/0.525）失去向量通道——这 3 个在
  R-010 本就 miss，属于拿已丢失的边际召回换精度，净收益为正。

### 1.5 评测器两处 harness 缺陷

- `failuresFor` 按 **caseId 前缀**过滤（应为 check），s2/forget/
  arbitration/confirm 四个指标全部虚高（R-010 报 12/12，实际 0/12）；
- 未设 `MEMORY_CONFLICT_LATEST_WINS=true`，被测的 R-008 仲裁特性被
  flag 关在门外。

### 1.6 缺陷六（重跑中发现，组 C 全零的真正主因）：零候选事件永不消费

R-011 中途重跑显示组 C 仍全零、且 A 组多个事实的断言"迟到"（即时检查
失败、组末重数通过）。根因：drain 判定事件已处理的依据是「存在
raw_event 类型的 version source」。提取返回 0 条候选（闲聊）、候选全被
去重门 skip、AUDN 判 NOOP/UPDATE 的事件都没有 source 行——它们永远
留在 pendingEvents 里，且 batch 按 commitSeq 取最老的 3 条，**闲聊事件
永久占据队头**：每个 drain 都把同一批死事件重发给模型，后面所有事件被
饿死。这同时解释 R-010 与 R-011 两次运行组 C 的全零 drain 摘要。

修复：事件处理完且无 source 行 → 写 `memory_extraction_exhausted`
audit 事件（repository 已全量回读 audit_events，零 schema 变更），
pendingEvents 过滤已耗尽事件；全零 drain 也要显式 save（否则标记丢失）。

## 1.7 计划外调整（重跑证据驱动）

- 提取 prompt 加固引入副作用（天气闲聊被提取，A-C01 泄漏 1/10），
  已补负例 few-shot「今天天气真不错啊 → {"candidates":[]}」；
- 组 B 判据从 `recalled` 改为 bundle.evidence（检索通道）——`recalled`
  含整份 profile 快照，与查询无关，noise 判据在其上永远为脏。

## 2. 设计

### 2.1 canonical_key 事实级语义键

- `createModelExtractor` 让模型为每条候选产出 `key`：主题级短语义标识
  （如 `allergy_peanut`、`favorite_fruit`），**同一主题不同取值共用同一
  key**（这是 latest-wins 仲裁能工作的前提）；
- prompt 附 few-shot 示例（含健康事实示例，同时压制 1.4 的拒答）；
- 模型未产出 key 时回退内容指纹：`${scopeKey}:hash:${md5(归一化内容)}`，
  不同措辞各自成键——丢仲裁收益但不产生假冲突（保底语义）；
- 贯通链：extractor → proposal.key → drain addCandidate → createCandidate
  → makeAssertion。

### 2.2 AUDN findSimilar 向量化 + 阈值

- findSimilar 改为向量路径：对 proposal 内容调 embedding gateway，与
  state 内 active 断言的 indexDocuments embedding 算余弦，≥0.60 才进
  similar 列表（top 5）；
- embedding 不可用/超时 → similar=[]（Mem0 语义：无相似 → ADD），audit
  记录 `similar_mode=unavailable`；
- 替换原 BM25 路径，不做词法回退（词法回退就是缺陷本身）。

### 2.3 检索向量下限

- `vectorSearch`/`hybridSearch` 增加 `minScore` 透传，低于下限的向量
  命中直接淘汰；
- 经 moduleOptions 的 `vectorMinScore` 注入（生产装配默认 0.55，
  env `MEMORY_VECTOR_MIN_SCORE` 可调）；未配置时保持 0（现有测试
  行为不变，与 hybridRetrieval flag 同一模式）。

### 2.4 提取 prompt 加固（拒答治理）

- 显式声明：健康、用药、财务、证件等**用户本人的事实**属于值得记住的
  范围（系统有 S0-S3 分级治理，S2 会走确认流）；不要因主题敏感而返回空。

### 2.5 评测器修复

- `failuresFor` 改为按 check 前缀统计失败 caseId 去重数；
- 评测进程内设 `MEMORY_CONFLICT_LATEST_WINS=true`；
- evidence 记录阈值配置，保证数字可解释。

## 3. 涉及文件

| 文件 | 改动 |
|---|---|
| `server/memory-extraction.js` | 提取 prompt（key + 拒答加固）；findSimilar 向量化 + 0.60 阈值；proposal.key 传递 |
| `server/memory-module.js` | makeAssertion hash 回退；hybrid minScore 接线 |
| `server/memory-module-retrieval.js` | vectorSearch/hybridSearch minScore；导出 cosineSimilarity |
| `server/core-v0-production.js` | 阈值 env 接线（MEMORY_VECTOR_MIN_SCORE / MEMORY_AUDN_SIMILAR_MIN_SCORE） |
| `scripts/memory-eval.js` | failuresFor 修复 + latest-wins flag + 阈值入 evidence |

## 4. 验收

- E-1 单测：canonical key 三路（模型 key / hash 回退 / 同 key 换值仲裁）、
  findSimilar 阈值上下界、vectorSearch minScore 过滤全部有对应用例；
- E-2 重跑 96-case：四个治理指标不再虚高，数字与失败明细自洽；
- E-3 noise 查询召回 0 条（精度阈值生效的直接证据）；
- E-4 基线对比报告：R-010 vs R-011 各指标 delta，负向结果如实记录
  （预期 fact_recall 可能因提取重述变化而波动）；
- E-5 提取拒答率复测：S2 消息探针重跑，空返回比例显著低于 5/19。

## 5. 风险与对策

- 模型 key 不稳定（同主题两次提取产出不同 key）→ few-shot + key 规范
  （小写、下划线）；hash 回退保底无假冲突；
- 阈值过紧误杀召回 → 两个阈值均 env 可调，评测 evidence 记录当时值；
  探针数字已给出分离间隙，不盲调；
- 提取拒答无法根除（模型侧行为）→ 诚实计入 s2/confirm 指标，不粉饰；
- 96-case 重跑约 200+ 次模型调用，波动属预期 → 指标解读以失败明细为准。

## 6. 实施结果（run 9，2026-09-07，DeepSeek v4 flash + 本地 bge-m3）

| 指标 | R-010 报告值 | R-010 真实值* | R-011 run9 | 说明 |
|---|---|---|---|---|
| fact_recall | 12/15 | 12/15 | **13/15** | F02「28+杭州」被拆成两条断言、F05/F07 提取改述丢关键词 |
| chit_chat_leak | 10/10 | 10/10 | **10/10** | prompt 负例 few-shot 压住了加固副作用 |
| dedup_effective | 8/8 | 8/8（假象） | **8/8** | R-010 与中途跑的 8/8 是 drain 堵塞的假象；本轮 dedup 路径真实执行且通过 |
| paraphrase_hit | 12/20 | 12/20（快照口径） | **18/20** | 向量检索真正生效后 +6 |
| lexical_hit | 5/10 | 5/10 | **9/10** | 同上 |
| precision_noise | 3/3 | 3/3 | **3/3（部分改善）** | 每条 noise 查询的召回从 8 条降到 1-2 条；财务类 noise 查询仍命中财务事实——全局余弦阈值在主题聚类语料上无法完全分离（诚实负结果） |
| s2_accuracy | 12/12 | 0/12 | **9/12** | 「月薪/信用卡/化疗/家庭矛盾」不在 R-008 S2 词表（词表缺口，R-012 输入） |
| forget | 8/8 | 0/8 | **6/8** | 2 个 setup miss 为提取改述（戚风蛋糕被判一次性事件、Keychron） |
| arbitration | 5/5 | 0/5 | **4/5** | 事实级 key + latest-wins 生效；1 个 variance（C-A03 改述） |
| confirm | 5/5 | 0/5 | **0/5** | 新发现（见 6.1） |

\* R-010 报告值因评测器 `failuresFor` bug 与 drain 堵塞普遍虚高；"真实值"
按失败明细重算。

### 6.1 run9 新发现（R-012 输入）

1. **S2 确认后仍不可直查**：confirm 流程激活断言后，其
   `directQueryPolicy=require_confirmation` 依旧在检索层拦截——确认
   （confirmations）与访问确认（accessConfirmations）是两条独立闸门，
   「确认后可见」的语义在 R-008 治理模型下存在缺口；
2. **连接池压力**：长跑中池连接被逐步占满（评测进程结束时 11 个连接未
   归还；中途曾出现 10/10 满池死锁，已用进程内 drain 串行化 + 池扩容
   缓解）。根因未完全定位，`scripts/eval-progress.log` 的池水位曲线
   留给 R-012 继续追；
3. **评测判据口径**：`recalled` 含整份 profile 快照、bundle.evidence 受
   压缩裁剪（R-010 发现 3 被量化）——组 B 最终改为模块级
   `retrieveAsync` 直测检索通道；
4. **noise 残留**：全局向量下限对主题相邻查询（股票 vs 薪资）失效，
   需要重排或按意图分流的阈值。

### 6.2 本 slice 修复的缺陷清单（相对 R-010）

1. canonical_key 事实级语义键（模型产出 key，hash 回退）；
2. AUDN findSimilar 向量化 + 0.60 余弦阈值（替换 BM25 无阈值）；
3. 检索向量下限 0.55（`MEMORY_VECTOR_MIN_SCORE`）；
4. 提取 prompt：S2 内容拒答治理 + 闲聊负例 + 语义 key few-shot；
5. 零候选事件消费标记（`memory_extraction_exhausted`）——drain 堵塞根因；
6. 索引文档持久化两连雷：jsonb 序列化 + `lexical_version NOT NULL`
   ——R-007c 的语义检索从未在真实管线落库，本 slice 修复；
7. drain 进程内串行化（连接池死锁防护）；
8. 评测器八项：failuresFor 指标修复、latest-wins 开启、组 B 检索通道
   直测、forget/confirm 持久化回调修复、资源版本重试、池扩容、
   看门狗与进度日志。

探针证据：`.rearchitecture-runs/probes/`（提取拒答探针 ×2、bge-m3 余弦
校准、索引 roundtrip）；历次评测证据：`.rearchitecture-runs/memory-eval*.json`。
