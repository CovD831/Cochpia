# R-017 实施计划：记忆生命周期调度（设计冻结 2026-09-09）

> 依据：memory-lifecycle-map.md §6/§7——`sweepRetention` 完整实现但
> 生产路径无人调用，retention 数据（35 天 rawEvents、expiresAt 断言、
> 过期会话/确认/冷却/幂等记录）无限累积。基线 `0385879`。

## 1. 设计

- **接线点**：提取 drain（已按 subject advisory 锁串行、异步、有预算
  控制）——在提取完成后执行生命周期清扫，不新增并发面；
- **时间门控**：每 subject 至多每小时一次（进程内 Map 记录上次清扫时间，
  重启后至多多跑一次，无 schema 变更）；
- **flag**：`MEMORY_RETENTION_SWEEP`，默认**开**（清扫是"先降级不删除"
  的既定语义：断言→expired、版本→invalidated，仅 rawEvents 按既定
  35 天策略物理清除；opt-out 语义 = 显式 `false`）；
- 清扫结果计入 drain summary（`retention: {rawEvents, sessions,
  assertions, ...}`）并写审计事件，非零变更才额外 persist。

## 2. Trade-off

| 维度 | 分析 |
|---|---|
| 收益 | retention 语义真正生效；状态集合有界；审计链完整 |
| 风险 | 过期断言被错误 expired → 检索少一条；缓解：expiresAt 由写入侧策略决定（默认多数断言无 expiresAt，仅会话级联过期受影响） |
| 频率 | 1 小时/subject：清扫是 O(状态大小) 的内存过滤，无模型调用，成本可忽略 |
| 兼容 | flag off = 完全不调用（旧行为）；service worker 保持不动（未来替代方案另行评估） |

## 3. 验证

- E-1 单测：过期 rawEvent 被 sweep 物理清除；过期断言降级 expired 且
  版本 invalidated；1 小时门控（同 drain 内第二次不触发）；
- E-2 复现：构造 deleteAfter 已过期的 raw event + expiresAt 已过的
  断言 → 一次 drain 后被清扫，审计有痕；
- E-3 220-case 回归跑（flag 默认开）：全部指标与 defaults-run1 一致带内。

## 4. 状态

- [x] 设计冻结
- [x] 实现 + E-1（新增 2 用例；全套 330 项绿）
- [x] E-2 复现（live PG：过期 raw event 1→0，审计 memory_retention_swept
  有痕；两次失败复现换来两个真缺陷修复，见 ee615d4）
- [x] E-3 回归（r017-run1）：26 失败与 defaults-run1 持平，dedup 20/20、
  precision_noise 22/25、noise_any 3/25 全部保持；arb 12/15、lexical
  22/25、s2 21/24 为 ±1 case 方差带内波动。**无回归，验收通过。**

## 5. 遗留

- 孤儿模块中稳定画像投影（projectStableProfile）与情节分组
  （episodeGrouping）仍未接线——前者建议随实体记忆模块（R-018 候选）
  一起设计，后者等产品需要情节叙事时再评估；
- service worker 整体保持退役状态，若未来需要多 worker 竞争消费再评估。
