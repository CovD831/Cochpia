# 记忆模块真实 600-case 评测协议

> 目的：补齐 `docs/memory-module-alpha-gate.md` 中「600-case evaluation」行——synthetic 基线全 1.0（无判别力），真实评测缺失。本文档为协议设计，不含代码改动。阈值为**提议值，待老板批准**。

## 1. 数据来源

- **单一真实用户**：项目老板本人的日常真实对话（伴侣对话走 `/api/chat/turns`）。
- **为什么 synthetic 不行**：`evaluate:memory-synthetic` 先 `memory.hold` 写入「预期内容」再 `retrieve` 同一 query，recall 必然 1.0——这是自洽闭环，零判别力，无法暴露真实抽取/检索/隔离缺陷。
- **最小采集量**：建议覆盖**两轮真实使用周期**（如连续 2 周 × 2 轮），累积 ≥ 600 条带记忆写入/召回的真实交互；每轮之间保留模型/抽取链路不变以控制变量。
- **case 构成**：从真实对话中脱敏抽取 600 条（query + expected + expectedMode：known / no_answer / conflict / authorization），写入 `MEMORY_EVAL_CASES` 指向的 JSON（沿用 v0.2 字段 schema）。

## 2. 指标与通过阈值（提议，待批准）

| 指标 | 一句话定义 | 提议阈值 |
| --- | --- | --- |
| Recall@5 / @10 | 预期记忆进入前 5 / 前 10 召回的比例 | ≥ 0.85 / ≥ 0.92 |
| MRR | 首条命中排名的倒数均值 | ≥ 0.80 |
| nDCG@10 | 前 10 命中位置的质量加权 | ≥ 0.85 |
| no-answer | 应返回"无记忆"时正确 abstain 的比例 | ≥ 0.95 |
| conflict | 触发冲突/uncertainty 时正确标记的比例 | ≥ 0.90 |
| Scope | 跨租户/用户/agent 越权访问被正确拒绝的比例 | = 1.0（提议 ≥ 0.99） |
| S2/S3 假阴率 | 本应被 S2 确认 / S3 拒落库但被错误放行或丢失的比例 | ≤ 0.05 |
| proactive mention | 主动提及命中且与授权/冷却规则一致的比例 | ≥ 0.90 |
| evidenceSupportRate | 命中项带 sourceRefs 的比例（harness 已有） | ≥ 0.90 |

> 注：`Recall/MRR/nDCG/no-answer/conflict/Scope/evidenceSupportRate` 已由 `server/memory-module-eval.js` 的 `evaluateMemoryRetrieval` 直接计算；**S2/S3 假阴率、proactive mention 当前 harness 未实现，需补胶水**（见 §4）。

## 3. 脱敏规则（入库评测前）

1. **替名**：人名/地名/账号/URL 用稳定伪名映射（同一实体全局一致哈希），禁止明文进评测集。
2. **剔除凭证**：token、API key、密码、银行卡号正则剥离。
3. **范围最小化**：仅保留记忆召回必需的 query + expected + mode 三元组，原始对话原文不入库。
4. **可撤销**：脱敏映射表单独存放、不随评测 JSON 提交；评测结果只含伪名与记忆 id。
5. **审计**：脱敏后由第二人抽检 5% 确认无可还原 PII，再进 `evaluate:memory`。

## 4. 执行路径（映射到现有命令）

- **结果采集胶水**：复用 `scripts/memory-module-evaluate.js` 的输入契约——它对每个 case 读取 `MEMORY_EVAL_RESULTS`（JSON：id → `{items, answerability, policyResult, uncertainties, error}`）。需补一段脚本：用真实对话驱动线上 `memory.hold`/`retrieve`，把每 case 的检索结果落盘为该 results JSON。**不改 `evaluate.js` 既有逻辑，只补采集器。**
- **指标计算**：`MEMORY_EVAL_CASES=<脱敏cases>.json MEMORY_EVAL_RESULTS=<results>.json MEMORY_EVAL_K=10 npm run evaluate:memory` → 输出 Recall@K/MRR/nDCG/accuracy。
- **回归基线**：`npm run evaluate:memory-synthetic` 仍用于 CI 不回归，但**不作为 alpha gate 的判别证据**（已知全 1.0）。
- **需补胶水**：① S2/S3 假阴率探针（校验 S2 确认落库、S3 不进 outbox/db）；② proactive mention 判定（对照授权/冷却状态）；二者需扩展 `memory-module-eval.js` 的返回结构。

## 5. 与 Alpha 门的闭环关系

本协议执行完（600 真实脱敏 case 跑通 + 阈值达提议值 + 老板批准）后，alpha gate 表中 **「600-case evaluation」行**可由「仍缺 / synthetic 全 1.0」翻绿为「真实 600-case 通过」。

> 注意：翻绿**仅限该行**。PITR、压测、pgvector 性能、Model Gateway 审计、双机 TLS 仍各自独立，不随本评测自动闭合。
