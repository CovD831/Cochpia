# R-007a 实施计划：AUDN 写入时决策 + 去重门 + 提取过滤

> 依据：`docs/research/memory-optimization-roadmap.md` 借鉴项 1、2 与冒烟暴露的
> 三个质量问题（闲聊噪音、语义重复、事实变更无仲裁）。
> 基线：`c94bed9`。旗标不变：`CORE_V0_MEMORY_PIPELINE_ENABLED`。

## 1. 目标与非目标

目标：
- 提取候选入库前经过 AUDN 决策（ADD/UPDATE/DELETE/NOOP），与已有 active
  断言建立关系判断；
- 哈希去重门：批内 + 与已有 active 断言的零成本去重；
- 模型提取 prompt 加"值得长期记住"过滤（闲聊/一次性事件不产候选）；
- UPDATE/DELETE 路径的快照投影保持一致（versionId 同步与清理）。

非目标：
- 语义向量检索（R-007c）；
- 双时间戳失效模型（R-008）；
- drain 异步化（R-007b，独立小改）；
- 提取质量的量化评测（Phase 3）。

## 2. 设计

### 2.1 AUDN 决策器（新概念：auditor）

drain 内、每个候选入库前：
1. 用候选内容在 Module 内检索已有 active 断言（`memory.retrieve`，
   top-k=5，同主体可见性规则）；
2. 组装决策 prompt：候选事实 + 编号后的已有记忆（整数索引，防 UUID 幻觉，
   Mem0 同款做法）→ 模型输出 JSON：
   `{"decision":"ADD|UPDATE|DELETE|NOOP","target":<索引|null>,"reason":"..."}`;
3. 行为映射：
   - `NOOP` → 跳过该候选（闲聊/无长期价值）；
   - `ADD`（或检索为空）→ 现路径 createCandidate + promote；
   - `UPDATE(target)` → `correct(target, { content })` 版本化更新：
     旧版本 superseded、新版本 current、`currentVersionId` 前移，并同步
     该断言在所有 snapshot_items 的 versionId（新增
     `syncProjectionVersions` helper）；
   - `DELETE(target)` → `forget(target)`（既有治理路径，tombstone 生效），
     随后仍 ADD 新候选（"不再 X"通常伴随新事实）；
4. 降级语义：决策 JSON 解析失败或模型失败 → **默认 ADD**（宁可存噪音，
   不丢用户明确陈述的事实）；解析出的 target 索引越界 → 降级 ADD；
5. **注入点**：auditor 与 extractor 同构，是 adapter/Module 的显式构造
   参数。测试与 proof 注入确定性 auditor 或 null（null = 跳过决策 = 现行
   为，保证 B-03/B-07 与 flag-off parity 不变）；生产未注入时由
   `createModelAuditor(model)` 自动构建；mock provider → null。

### 2.2 哈希去重门

- 归一化：小写 + 去全部空白与 CJK/ASCII 标点（中文无需词形还原）；
- `hash = md5(normalized)`；
- 批内：同一 drain 批次内候选互相去重（Set）；
- 对已有：load state 时预计算全部 `status='active'` 断言的
  `current_version.content` hash 集合，命中即 skip；
- 哈希集合随每次 createCandidate/promote/correct 增量更新。

### 2.3 提取 prompt 过滤

`createModelExtractor` 的 prompt 追加判定规则：只提取值得长期记住的
稳定事实（身份、偏好、健康、重要关系、关键经历）；明确忽略闲聊、天气、
一次性事件、即时情绪。deterministic double 不变（测试锚点）。

### 2.4 涉及文件

| 文件 | 变更 |
|---|---|
| `server/memory-extraction.js` | `createModelAuditor`、drain 的 AUDN 分派、哈希去重门、prompt 过滤 |
| `server/memory-module.js` | `syncProjectionVersions` helper（correct 路径的快照 versionId 同步） |
| `server/core-v0-production.js` | auditor 注入点（构造参数 + mock 跳过 + 自动构建） |
| `server/core-v0-memory-pipeline.test.js` | AUDN 四行为 + 哈希去重 + 降级路径测试 |
| `scripts/extraction-smoke.js` | 不改（自动获得生产 auditor），复跑对比 T2/T3 |

## 3. 验收（并入 B 系列）

- B-13 哈希去重：同一事实换措辞重复陈述，第二次候选被 skip；
- B-14 NOOP：确定性 auditor 判 NOOP 的候选不入库；
- B-15 UPDATE：auditor 判 UPDATE 时目标断言内容更新、旧版本 superseded、
  所有 snapshot_items 的 versionId 前移；
- B-16 DELETE：auditor 判 DELETE 时目标断言 forgotten、快照行清理；
- B-17 降级：auditor 抛错/输出畸形 → 候选按 ADD 落库，不丢事实；
- B-18 smoke 对比：T2（天气）不再产生 active 断言；T3 的重复候选减少。

## 4. 风险与对策

- 决策调用增加延迟（+1 次模型调用/候选）：与预算共用 2s/12s 上限，
  决策失败快速降级 ADD；R-007b 异步化后不再影响用户可感延迟；
- correct 语义与 AUDN UPDATE 的适配：correct 的 input 校验（resourceRevision）
  需从检索到的断言快照读取，索引越界或断言已失效时降级 ADD；
- 审计：AUDN 决策记录进 Memory audit（action=`memory_audn`，含 decision
  与 reason），保证仲裁可解释。

## 5. 执行顺序

1. 本计划提交（契约冻结）；
2. `syncProjectionVersions` + Module 正确路径接线；
3. `createModelAuditor` + drain AUDN 分派 + 哈希去重门 + prompt 过滤；
4. adapter auditor 注入点；
5. 测试 B-13..B-17 + 全量回归 + smoke 复跑对比（B-18）；
6. 提交，更新 handoff 与 roadmap 勾选。
