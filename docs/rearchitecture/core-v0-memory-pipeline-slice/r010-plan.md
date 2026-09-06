# R-010 实施计划：记忆质量评测基线（100-case，Phase 3 的缩小版）

> 依据：R-007a..R-009 的所有质量改动均无量化数字，需要一个可复现的评测
> 标尺；同时是 Phase 3（600-case / Memory Alpha gate）的方法学验证。
> 基线：`291dc43`。

## 1. 目标

建立三维度共 100+ case 的自动化评测，产出当前质量基线数字与失败 case
清单。评测方法本身（case 设计是否稳定、判定是否可复现）也是本 slice 的
验证对象——方法可靠后 Phase 3 再扩量。

## 2. 评测设计

### 2.1 判定原则

**规则判定，不用 LLM judge**：每个 case 携带结构化期望（expected keywords /
expect_none / expected_sensitivity / expected_decision），由脚本对断言库与
drain summary 做确定性比对。零主观性、可复现、零额外模型成本。代价是
判定粒度粗（关键词命中 ≠ 语义正确）——接受，Phase 3 再引入人工校验样本。

### 2.2 三组 case

| 组 | 数量 | 内容 | 指标 |
|---|---|---|---|
| A 提取质量 | ~33 | 15 条事实陈述（应 active）、10 条闲聊（应 0 候选）、8 条重复变体（应去重/UPDATE） | fact_recall、chit_chat_leak_rate、dedup_effective |
| B 检索召回 | ~33 | 20 条事实入库 + 改述查询（无词面重叠）、10 条词法查询对照、3 条无关查询 | paraphrase_hit_rate（hybrid）、lexical_hit_rate（BM25 对照）、precision_noise |
| C 治理正确性 | ~34 | 12 条健康/财务（应 S2 pending）、4 条 S3（应拒绝）、8 条遗忘（不复活）、5 对矛盾（latest-wins）、5 条确认后可见 | s2_accuracy、s3_rejection、forget_no_resurrection、arbitration_single_value、confirm_visibility |

case 集为手工构造的 JSON（`scripts/eval/eval-cases.json`），消息全部中文、
贴近真实陪伴对话。

### 2.3 执行环境

真实 PostgreSQL（专用库跑完即删）+ DeepSeek v4 flash（提取/AUDN/回复生成）
+ Ollama bge-m3（hybrid embedding，经 SSH 隧道）。B 组的词法对照用同一库
在关闭 hybrid 的第二个 adapter 上跑同查询。

### 2.4 涉及文件

| 文件 | 内容 |
|---|---|
| `scripts/eval/eval-cases.json` | 100+ case 集（手工） |
| `scripts/memory-eval.js` | 评测执行器（建库→逐组跑→规则判定→报告→清库） |
| `.rearchitecture-runs/memory-eval.json` | 评测证据（指标 + 失败 case 明细） |

## 3. 产出与验收

- E-1 评测器可复现：同 case 集两次跑，规则判定结果结构一致（模型输出
  波动允许体现在指标数字上，不体现在判定逻辑）；
- E-2 三组指标全部产出且附失败 case 明细；
- E-3 基线报告：数字本身**不设通过阈值**（这是基线，不是门禁）——失败
  case 即下一轮调优的输入清单。

## 4. 风险与对策

- 模型输出波动导致指标抖动：评测报告附每次 drain summary 原始数据，可
  复盘；Phase 3 扩量后方差自然收敛；
- 关键词判定误判（命中关键词但语义跑偏）：失败 case 人工复核清单随报告
  输出；
- 热点流量：约 200 次模型调用（生成+提取+AUDN）+ ~40 次 embedding，文本
  量级在几十 KB，可控。
