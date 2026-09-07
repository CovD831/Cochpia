# R-013 实施计划：S2 分类覆盖原始消息（微片）

> 依据：R-012 run10 唯一 S2 残留 C-S12——「我家里矛盾挺严重」被提取改述成
> 无触发词的候选内容，分类只看改述后内容即漏判。基线 `138429e`。

## 1. 设计

- `classifySensitivity` 的 S2 检测面从「候选 content」扩展为
  「候选 content + sourceContent（原始消息）」；
- 提取 drain 在 `createCandidate` 时携带 `sourceContent: event.content`；
- **S3 检测面不变**（仍只看候选 content）：S3 是硬拒绝，原始消息已经过
  Core ingress 的 S3 政策，不在此处二次扩大否决面；
- API 路径（hold/correct）无 sourceContent，行为不变。

## 2. 验收

- E-1 单测：改述后无触发词 + 原始消息含触发词 → S2 pending；
- E-2 96-case 重跑：s2 ≥ 11/12 且 C-S12 不再依赖改述措辞。

## 3. 明确不做（归 Phase 3）

- 词法通道下限 / 分词改进（noise 残留）；
- AUDN NOOP 稳定性（few-shot / 结构化决策）；
- 多 run 均值 ± 方差的评测协议（Phase 3 扩量时一并建立）。

## 4. 实施结果（run 11，2026-09-07）

- 单测：R-013 用例（改述丢词 + 原始消息含触发词 → S2 pending）通过；
  全套 324/324 绿。
- 96-case run11：**S2 pending 12/12**（C-S12 首次落 pending，不再依赖
  改述措辞）；机制类指标稳定（leak 10/10、arbitration 5/5、confirm 5/5、
  forget 6/8）；模型类指标继续按预期摆动（dedup 2/8、paraphrase 11/20），
  佐证 R-012 结论：评测判据必须走多 run 均值 ± 方差。
- 池归因复核：total=2、end=closed、DROP 成功。
