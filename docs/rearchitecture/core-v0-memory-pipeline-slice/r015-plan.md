# R-015 实施计划：词法回退抑制（设计冻结 2026-09-09）

> 依据：Phase 3c erratum（phase3c-plan.md §9.3）——无关查询的裸检索
> 通道真精度仅 4-20%：向量通道在 minScore 0.55 下零命中（正确的沉默）
> 之后，词法回退把 BM25 二元巧合当高分结果返回。

## 1. 设计（零成本，利用已有的负信号）

- `hybridSearch` 中，当向量通道**健康运行**（mode === 'vector'，即
  embedding 正常计算、无超时错误）且**零命中**（无 item ≥ minScore）
  时：语义通道明确说"没有相关记忆"，此时词法回退的命中是未证实的
  二元巧合 → 抑制（返回空集，mode 标 `lexical_suppressed`）；
- 向量通道 disabled（未配置）/ timeout / error 时：**保留**词法回退
  （优雅降级优于全盲）；
- flag：`MEMORY_LEXICAL_SUPPRESS`，默认关。

## 2. Trade-off

| 维度 | 分析 |
|---|---|
| 收益 | 无关查询从"返回高分垃圾"变为"正确地一无所获"；noise_any_rate 直接受益 |
| 风险 | 若某真命中只被词法通道看见（向量分 < 0.55），抑制会丢它——但该命中本就低于校准过的语义噪声线，属于 minScore 0.55 校准决策的既定语义 |
| 降级 | embedding 不可用时行为不变（timeout/error/disable 三个 mode 都保留词法） |
| 成本 | 零新增调用、零 DDL；一个布尔分支 |

## 3. 验证

- E-1 单测：向量健康零命中 → 抑制；超时/禁用 → 保留词法；
- E-2 220-case 单跑（flag on）：precision_noise 显著抬升（基线 8%），
  paraphrase/lexical 不下降（命中应有向量佐证）。

## 4. 状态

- [x] 设计冻结
- [x] 实现（flag 门控）
- [x] E-1 单测
- [ ] E-2 验收（R-014 n=3 跑完后执行）
