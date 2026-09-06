# R-008 实施计划：冲突仲裁语义 + token 预算 + S2 规则稳定化

> 依据：roadmap 借鉴项与冒烟暴露的三个缺口（conflict 黑盒、tokenBudget 空壳、
> S2 分类依赖模型措辞）。基线：`c2cda88`。旗标：`MEMORY_CONFLICT_LATEST_WINS`。

## 1. 范围调整声明

原 roadmap 的"Zep 式双时间戳失效数据模型"**挪至 R-009**：它需要
`valid_at/invalid_at` schema migration，应安排在 promotion gate 之后、与
真实部署数据一起演进。R-008 聚焦三个不依赖 schema 变更的语义修复。

## 2. 设计

### 2.1 冲突仲裁（latest-wins，flag `MEMORY_CONFLICT_LATEST_WINS`）

现状：`finalizeRetrieve` 检出同 canonical_key 多值 → `answerability=conflict`
→ 全部 items 照常进 prompt，矛盾并存，用户视角是黑盒。

目标行为（flag on）：
1. 对每个冲突组（同 canonicalKey），只保留**版本最新**的 item 进 prompt
   （按 version.createdAt 降序；"用户改口以最新为准"）；
2. 被压制的旧值移入 `uncertainties`（附摘要），模型可感知"曾有不同说法"
   但不会同时采信两个矛盾值；
3. 压制后若仍有 items → `answerability=known`（不再卡在 conflict）；
   整组都无法保留时才维持 conflict/not_found；
4. flag off = 现行为（parity）。

### 2.2 token 预算（**实施时撤回**）

**实施时发现调研误判**：`contextBundle` 已有完整的多级 token 压缩机制（evidence 逐条弹出 → 集合裁剪 → 内容减半 → 超限 fail-closed，`TOKEN_BUDGET_TOO_SMALL` 兜底），比计划中的 items 截断更完善。原判断只看到 bundle 构建处的 `tokenCount: 0` 占位，未核查 compaction 逻辑——调研结论已修正：tokenBudget 并非空壳。该部分代码已回退，避免双重截断与既有行为冲突。


### 2.3 S2 词表稳定化

`detectS2` 词表追加：服用、抗凝、华法林、胰岛素、血糖、血压、用药、剂量、
停药、复诊、复查、确诊、处方、手术、住院、symptom、surgery、hospitalized、
dose、insulin。动机：冒烟两轮华法林分别被判 S2/S0——模型措辞绕过单关键词
（"药物"）。规则化后由内容分类兜底，与模型措辞解耦。

### 2.4 涉及文件

| 文件 | 变更 |
|---|---|
| `server/memory-module.js` | finalizeRetrieve 仲裁与预算；detectS2 词表 |
| `server/core-v0-production.js` | flag 透传（moduleOptions.featureFlags.conflictLatestWins） |
| `server/core-v0-memory-pipeline.test.js` | C-07..C-10 测试 |

## 3. 验收

- C-07 仲裁：同 canonical_key 两个矛盾 active 值，flag on 时 prompt 只见
  最新值，旧值在 uncertainties；
- C-08 flag parity：flag off 时 conflict 行为与基线一致；
- C-10 S2 稳定化：含"服用华法林抗凝治疗"（无"药物"字样）的候选判 S2 进
  确认流。

## 4. 风险与对策

- latest-wins 误杀（旧值其实是正确事实）：uncertainties 保留完整痕迹 +
  AUDN 的 UPDATE 路径可以再次纠正；确认流（S2）不受影响；
- 截断误伤高价值记忆：截断按 score 序保头部，且 uncertainties 可追溯；
- detectS2 扩词表的误伤面：S2 的后果是确认一次（非拒绝），误伤可接受。
