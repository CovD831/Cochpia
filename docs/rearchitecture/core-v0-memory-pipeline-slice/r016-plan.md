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
- [x] 实现（flag 门控）+ E-1 单测（37/37）
- [x] E-2 复现验证
- [ ] E-3 验收跑
