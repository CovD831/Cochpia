# R-019 设计冻结（候选）：主动提及调度器（2026-09-09）

> 老板要求：设计冻结前多调研。调研综合见 §1；基建盘点见 §2。

## 1. 调研综合（外部 + 内部）

### 外部研究

| 来源 | 核心机制 | 对本设计的启示 |
|---|---|---|
| **CHI'25 Inner Thoughts**（arXiv 2501.00383，UCLA/东大/Salesforce） | ①双触发器：`on_new_message` + `on_pause`（静默 10s）；②记忆显著性 = 相关度 × 重要性权重 × 时间衰减；③思考候选 + **内在动机评分**（1-5）决定是否开口 | 触发器形态与"先选候选再决定说不说"的两段式，直接可借 |
| **ProAct**（arXiv 2605.25971） | 空闲时间计算 + future-state prediction + **delivery policy 权衡收益与打断成本**；turn −14.8%、幻觉 −28.1%；**诚实声明：疲劳效应未研究、用户控制是部署必需** | "guided 预测优于无方向空闲计算"；打断成本必须显式建模；交付侧需要用户开关与频控 |
| 产品/伦理线（2026 companion 行业综述） | "thoughtful 与 intrusive 的界线极薄"；**agency not dependency**；session health（凌晨 3 点连续会话 = 强迫信号）；危机信号处理；EU AI Act 与美国 14+ 州立法（透明度、未成年人） | 主动提及的失败模式（骚扰/依赖加深）有行业共识；治理不是可选项 |

### 内部基建（已实现，生产空转）

| 组件 | 现状 |
|---|---|
| `purpose: 'proactive_mention'` 检索模式 | **完整实现**：独立检索路由 + policy 过滤 + flag 开关 |
| `mentionCooldowns` | 按 memoryId + topicKey 的冷却记录，`recordMention` 写入 |
| `mentionPolicy` 三档 | 断言级提及策略（direct_query_policy/mention_policy），R-012 方案 A 确认后自动放权 |
| `relevantEpisodes` / ContextBundle | R-017b 已接线，情节可作触发素材 |
| **缺失** | **没有任何调用方**——没有触发器决定"此刻该不该主动提" |

## 2. 设计（三阶段，每阶段独立闸门）

### Phase 1：记忆地基式开场（零打扰，先建价值）

会话开始/间隔归来后，**第一条回复**自然编织一条记忆（"上周你说在学
尤克里里，进展如何？"）。这不是推送——不需要通知通道、零打断成本，
但立刻让记忆"被看见"。

- 触发：会话首条用户消息（间隔 ≥4h）；
- 候选：`retrieveAsync({ purpose: 'proactive_mention', query: <最近
  episodes/assertions 摘要> })`，显著性 = 最近未提及 × 重要性 × 治理
  权重（借用 Inner Thoughts 公式，decay 用 observedAt）；
- 门：仅 active 的 S0/S1 + mentionPolicy 允许 + 冷却未激活；
- 交付：作为回复的上下文素材（persona prompt 注入），不是独立消息——
  用户无感知增量，风险最低。

### Phase 2：in-session on_pause 主动接话

静默 ≥N 秒且对话有未完话题/高显著性记忆时，助手主动接一句。
- 借 Inner Thoughts：候选思考 → 内在动机评分（LLM 自评 relevance/
  coherence/时机）→ 过阈值才说；
- 频控：每会话 ≤2 次 + 全局冷却。

### Phase 3：out-of-band 推送（明确缓行）

需要通知通道、quiet hours、日预算、危机信号检测（危机 → 温和转介，
**绝不**主动提及健康记忆）与合规审查——单独立项，不在本条目。

## 3. Trade-off

| 维度 | 分析 |
|---|---|
| 收益 | Phase 1 让"记得你"首次可见——调研共识这是 companion 差异化核心 |
| 风险 | 每次回复都翻旧账 = 新型骚扰；缓解：Phase 1 频率上限（如每 3 次会话最多 1 次编织）+ 冷却复用 |
| 治理 | S2 未确认不提、S3 不提、crisis 不提；mentionPolicy 是用户已有控制面 |
| 成本 | Phase 1 一次检索 + 无新模型调用；Phase 2 每触发 1-2 次调用 |
| 依赖 | Phase 1/2 无新基础设施；Phase 3 需要推送通道（未建） |

## 4. 低成本验证路径

- P-1：eval 语料上模拟 Phase 1——间隔归来后检索 proactive_mention，
  人工核对候选合理性与冷却抑制（复用 220 语料，零新增标注）；
- E-2 单测：purpose 路由、冷却抑制、S2 排除、flag off 行为；
- E-3 220-case 回归 + 手工产品评审（Phase 1 语义自然度，老板亲测）。

## 5. 待老板拍板

1. Phase 1 编织频率上限（建议：间隔 ≥4h 且每 3 会话 ≤1 次）；
2. Phase 2 是否随首版一起做（建议：先 Phase 1，Phase 2 观察后再说）；
3. proactiveMention flag 默认值（基建默认 on，但触发器实现前无效果）。

## 6. 状态

- [x] 调研（外部 3 源 + 内部基建盘点）
- [x] 设计冻结（三阶段，Phase 1 先行）
- [ ] 老板确认 → P-1
- [ ] 实现 + E-2/E-3
