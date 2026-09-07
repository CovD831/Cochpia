# Phase 3a 实施计划：评测扩量 + 多 run 统计协议

> 依据：R-012 的方差发现（dedup 8↔3、paraphrase 18↔11 在零代码改动下摆动）
> 与老板拍板的 Phase 3 修订版——600 手写题降级为「~200 case × 3 runs」，
> 大数字只保留给 bulk 语料的库深测量（3b）。

## 1. 设计

### 1.1 case 扩量：96 → 220（每指标 ≥20）

| 组 | 原 | 新 | 扩充原则 |
|---|---|---|---|
| facts | 15 | 24 | 品牌名/数字/爱好等改述稳留 token |
| chitChat | 10 | 24 | 纯闲聊，无可持续事实 |
| dedup | 8 | 20 | 同事实换述对 |
| paraphrase | 20 | 30 | 摄入新主题事实 + 换述查询 |
| lexical | 10 | 25 | 关键词式查询，target ⊆ paraphrase 的 targetKeyword |
| noise | 3 | 25 | 与语料零词法/语义重叠的通用查询（纯检索判据，零模型调用） |
| s2 | 12 | 24 | 原始消息含词表触发词（R-013 后分类面含原始消息） |
| forget | 8 | 18 | 邮箱/WiFi 名/工号/平台等独占 token |
| arbitration | 5 | 15 | 换值对，新值 token 必须改述稳留 |
| confirm | 5 | 15 | S2 消息 + 确认后直查可见 |

生成时做了词表误伤扫描：非 S2 组的新 case 均不含 S2 词表触发词
（S2 误伤 = 不必要进确认流）。总共 220 case、约 250 事件/跑。

### 1.2 多 run 协议

- 同一 case 集**连续跑 3 次**（每次全新评测库），各自落盘
  `phase3a-run{i}.json`；
- 聚合：每指标 mean + min/max（`scripts/eval/aggregate-runs.py`），
  输出 `phase3a-baseline.json`；
- 判读规则：**机制类指标**（leak/s2/confirm/arbitration/forget/noise）
  跨 run 稳定可作回归判据；**模型类指标**（facts/dedup/paraphrase/
  lexical）以 3-run 均值 ± 极差报告，任何后续改动用同样协议对比。

## 2. 验收

- E-1 三次 run 全部完成、无 harness 崩溃；
- E-2 聚合基线落盘，每指标有 mean/min/max；
- E-3 方差带与 R-012 的发现一致（模型类宽、机制类窄），否则归因。

## 3. 不在本片

- 3b bulk 合成语料（500-2000 断言的库深测量）；
- 3c decay 重排、词法下限、AUDN 稳定性实现；
- promotion 准备（老板拍板压后）。

## 4. 实施结果（3 × 220 case，2026-09-07）

| 指标 | 3-run 均值 | run 间范围 | 稳定性 |
|---|---|---|---|
| chit_chat_leak | 100% | 24/24 ×3 | 稳定 |
| confirm | 97.8% | 93-100% | 稳定 |
| noise 精度 | 94.7% | 92-96% | 稳定（残留 1-2 条/跑） |
| s2 | 88.9% | 83-96% | 稳定 |
| fact_recall | 87.5% | 21/24 ×3 | 稳定 |
| arbitration | 80% | 12/15 ×3 | 稳定 |
| lexical | 62.7% | 60-68% | 中等方差 |
| paraphrase | 62.2% | 60-63.3% | 稳定 |
| forget | 63.0% | 56-67% | 中等方差（setup miss 主导） |
| dedup | **20%** | **10-30%** | 最差且方差最宽——AUDN NOOP 不稳定是当前最大质量缺口 |

结论：

1. 统计基线落盘（`.rearchitecture-runs/phase3a-baseline.json`），后续任何
   改动按同协议对比；
2. **dedup（AUDN NOOP）是量化后的第一优先修复项**——20% 且宽方差，
   3c 的 few-shot/结构化决策直接针对它；
3. forget 的 63% 主要由提取改述丢失独占 token（setup miss）造成，
   需看失败明细分离「提取没提取出」vs「改述丢关键词」；
4. noise 精度 94.7% 优于 96-case 时期的 0%，扩量后残留更清晰可归因。
