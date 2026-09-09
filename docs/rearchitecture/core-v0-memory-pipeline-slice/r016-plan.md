# R-016 实施计划：同 key 注入（设计冻结 2026-09-09）

> 依据：R-014 n=3 判定（ledger R3C-007）——dedup 95%→86.7%，且换值候选
> 的 embedding 相似度常低于 AUDN 阈值 0.6（值不同 → 句向量不同），同 key
> 记忆被 findSimilar 过滤掉 → similar 为空 → ADD（丢更新 + 旧值滞留）。

## 1. 设计

- 核心命题：**key 匹配是比 embedding 相似度更强的同主题信号**。R-011 的
  提取契约保证「同一主题不同取值必须用同一个 key」——key 相等即同事实
  主题，按构造成立，不需要 embedding 背书；
- `injectKeyMatches`（纯函数，可单测）：proposal.key 与活跃断言的
  canonical_key 相等时，将该断言的相似度抬到阈值（不排序、不改其他项），
  使其必然进入 `similar` 供审计器裁决；
- 审计器无需改动：探针已证（15/15 UPDATE，含 5 干扰项）——它缺的只是
  看到那条同 key 记忆的机会；
- flag：`MEMORY_AUDN_KEY_INJECT`，默认关。

## 2. Trade-off

| 维度 | 分析 |
|---|---|
| 收益 | 换值更新不再因 embedding 阈值丢失；dedup 与 arbitration 同时受益 |
| 风险 | 提取器 key 打错（把不同事实打到同 key）会把无关记忆塞给审计器——但审计器仍按内容裁决，最坏是 NOOP/ADD，不丢事实 |
| 成本 | 零新增调用、零 DDL；一个 map + max |

## 3. 验证

- E-1 单测：flag off 保持过滤；flag on 同 key 抬到阈值存活；无 key 不注入；
- E-2 复现：C-A06/C-A09 在 key 注入下 UPDATE 落库（2026-09-09 实测通过）；
- E-3 220-case 验收跑（flag on + R-014/R-015 同开）：dedup 回到 ≥90%，
  arbitration ≥ 12/15，precision_noise 保持高位。

## 4. 状态

- [x] 设计冻结
- [x] 实现（flag 门控）+ E-1 单测（38 项全绿）
- [x] E-2 复现验证
- [x] E-3 验收跑（r016-run1，2026-09-09）：见 §5

## 5. E-3 结果（三 flag 同开：CONTEXT_TURNS=4 + LEXICAL_SUPPRESS + KEY_INJECT）

| 指标 | R-014 n=3 均值 | R-016 | 目标 | 判定 |
|---|---|---|---|---|
| dedup_effective | 86.7% | **19/20（95%）** | ≥90% | **达标**（回到 R-012c 水位） |
| arbitration_latest | 73.3% | **14/15** | ≥12/15 | **达标** |
| precision_noise（新口径） | 16% | **22/25（88%）** | 保持高位 | **保持**（R-015 未受影响） |
| noise_any_rate | 21/25 | 3/25 | — | R-015 生效确认 |
| fact_recall / chit_chat | 88.9% / 100% | 22/24 / 24/24 | — | 持平 |
| s2 / confirm / forget | — | 20/24 / 14/15 / 15/18 | — | 单发方差带内 |

- dedup 唯一失败 A-D12（轮换方差 case，三次不同运行从未重复同一 case）；
- arbitration 唯一失败 C-A15（已知残差：提取器对"现在涂的是蓝色的"
  判定不值得记，与 key 注入无关）；
- **总失败 26 条，为全部配置历史最优**（v4 42 / r014-run2 34 / r015b 27）。

## 6. 遗留决策（待老板拍板）

1. 三个 flag 的代码默认值：建议 MEMORY_LEXICAL_SUPPRESS=true（收益确定、
   代价实测为零）、MEMORY_AUDN_KEY_INJECT=true（风险被审计器兜底）、
   MEMORY_EXTRACT_CONTEXT_TURNS 保持 0（dedup 代价已由 R-016 对冲，可
   升 4，但建议先观察 A-D 系列 dedup case 两轮再定）；
2. C-A15 类残差：修正类消息的提取提示增强（"修正/更新类消息优先提取"），
   归 R-014 后续迭代。
