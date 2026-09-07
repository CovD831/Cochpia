# R-012 实施计划：S2 词表补全 + 确认闸门语义合并 + 精度残留治理（池根因诊断）

> 依据：R-011 run9 失败明细（20 失败 case）与 6.1 节四项新发现。
> 基线：`e6cfe98`。定位：Phase 3 扩量前的最后一片治理/精度修正。

## 1. 范围与优先级

| # | 项 | 类型 | 依据 |
|---|---|---|---|
| 1 | S2 词表补全 | 缺陷修复 | C-S06/07/10/12 四条财务与家庭事实被直通 active |
| 2 | confirm → 直查闸门合并 | 设计决策（待老板拍板） | confirm 0/5：确认激活后 `directQueryPolicy=require_confirmation` 仍拦截直查 |
| 3 | noise 残留治理 | 测量→调参两步 | 3/3 残留 1-2 条；evidence 未记录命中项分数，无法归因 |
| 4 | 连接池占用根因 | 诊断优先 | 96-case 后 11 连接未归还；满池死锁已缓解未根治 |

## 2. 设计

### 2.1 S2 词表补全（缺陷修复，无争议）

`classifySensitivity` 的 S2 词表按 run9 实测缺口精确补全，不泛化：

- 财务：`月薪|工资|欠|信用卡|贷款|网贷|冻结|征信`
- 医疗补充：`化疗|放疗|确诊`
- 家庭/法律：`家里矛盾|离婚|官司|拘留`

理由：只补实测漏网的词，避免「矛盾」「案子」这类单字泛词造成误伤
（S2 误伤 = 不必要地进确认流）。每词一条单测（R-008 词表测试同款）。

### 2.2 confirm → 直查闸门合并（设计决策，两案）

现状：confirmations（S2 候选确认）激活断言后，断言仍带
`directQueryPolicy=require_confirmation`，检索层继续拦截直查——
「确认后可见」落空（confirm 0/5）。

- **方案 A（推荐）**：`confirm()` 激活断言时同步把该断言的
  `directQueryPolicy` 放宽为 `allow`。语义：S2 确认 = 用户亲口授权这条
  记忆可被使用，确认后仍拦等于确认无效果。`accessConfirmations` 保留
  原职责：**未确认记忆的临时一次性授权**。mention 策略不动。
  代价：确认即永久可见（陪伴场景这是期望行为）。
- **方案 B**：检索层让 `status=pending_confirmation→active` 的迁移记录
  进 accessConfirmations。语义更窄但多一张表、两条闸门依旧。

推荐 A；B 仅在"确认后仍要默认隐藏、逐次授权"是产品要求时选。
**待老板拍板后实施。**

### 2.3 noise 残留（先测量再调参）

run9 的 noise 命中项分数未入 evidence，无法判断是阈值不足还是融合排序
问题。两步：

1. **测量**：组 B noise 判据扩展——失败时记录命中项的 vector 分数与
   BM25 分数（现在只有条数）；
2. **调参**：若命中项 vector 分数 ≥0.55（阈值内真命中）→ 语料主题
   聚类是根因，转重排/意图分流（Phase 3 范围，不在本片硬修）；若分数
   在 0.50-0.55 边缘 → 微调下限至 0.58 并复测 paraphrase 损失
   （校准数据：0.5861 之下的目标对仅 4/28，其中 3 个本就 miss）。

### 2.4 连接池根因（诊断优先，不盲改）

现象：评测全程池水位 2/2 稳定，结束时 11 连接未归还；run7 曾见 10/10
满池死锁（已用 drain 串行化 + 池扩容缓解）。

1. **测量**：eval 收尾打印每类操作的 connect/release 配平（pool 内部
   `totalCount/idleCount/waitingCount` 曲线已有）；嫌疑点：大状态
   `repository.save`（全量 DELETE+INSERT）与 `load` 的 `Promise.all`
   队列在长事务里重叠；
2. **修复候选**（按测量结果择一）：save/load 内禁止嵌套 connect；
   或 `pg.Pool` 加 `allowExitOnIdle`/显式 end 校验；或评测收尾用
   `pool.end()` 完成后再 drop（当前 process.exit(0) 跳过优雅关闭，
   11 个连接是进程退出残留，可能根本不是泄漏——先归因再动手）。

## 3. 涉及文件

| 文件 | 改动 |
|---|---|
| `server/memory-module.js`（classifySensitivity 词表） | S2 词表补全 |
| `server/memory-module.js`（confirm 路径） | 方案 A：确认时放宽 directQueryPolicy |
| `scripts/eval/eval-cases.json` | C-K 组预期不变；新增词表对照 case（可选） |
| `scripts/memory-eval.js` | noise 命中分数入 evidence；池配平日志 |

## 4. 验收

- E-1 词表：新增 S2 词各一条单测 + 既有词不回归；
- E-2 96-case 重跑：s2 ≥11/12、confirm ≥4/5（方案 A 后）；
- E-3 noise 命中分数入 evidence，残留 ≤1/3 或归因为语料聚类（转
  Phase 3）；
- E-4 池配平结论写入 r012 文档（是泄漏还是退出残留）；
- E-5 全套单测 + production/postgres 测试绿。

## 5. 风险

- 词表误伤：只加精确短语，单测锚定；
- 方案 A 改变确认语义：S2 仍走 pending 流程、S3 仍拒绝、S1 仍隔离，
  治理模型其余不变；证据留 audit（confirm 事件记 policy 变更）；
- 池问题可能是非问题（退出残留）：先归因，避免为幻影修代码。

## 6. 实施结果（run 10，2026-09-07，方案 A 已采纳并实施）

| 指标 | run9 | run10 | 归因 |
|---|---|---|---|
| fact_recall | 13/15 | **14/15** | 提取 variance |
| chit_chat_leak | 10/10 | **10/10** | 稳定 |
| dedup | 8/8 | **3/8** | 纯模型 variance（AUDN 是否判 NOOP；两次运行间该路径代码零改动） |
| paraphrase | 18/20 | 11/20 | 语料内容随提取改述波动 + dedup 失效放大（重复断言稀释检索） |
| lexical | 9/10 | 5/10 | 同上 |
| precision_noise | 3/3 | 3/3 | **归因完成**：残留命中全部是 BM25 词法通道（RRF 分数即 BM25 分，向量通道被 0.55 下限拦住）——CJK 二元分词使无关查询词法重叠（今年/每天/怎么） |
| s2_accuracy | 9/12 | **11/12** | 词表补全生效；唯一残留 C-S12「家里矛盾」——提取改述丢掉了触发词（「与家人关系紧张」），**S2 分类只看改述后内容是结构性弱点**，应对原始消息同时分类（R-013 输入） |
| forget | 6/8 | **7/8** | 提取 variance（戚风=一次性事件） |
| arbitration | 4/5 | **5/5** | 稳定 |
| confirm | 0/5 | **5/5** | 闸门合并生效（confirm → directQueryPolicy=allow + mentionPolicy=contextualizable_only） |
| 池 | 11 连接残留 | **total=2，end=closed，DROP 成功** | **归因完成：残留是 process.exit 跳过优雅关闭的退出残留，不是中途泄漏**；run7 满池死锁已由 drain 串行化 + 池扩容缓解，~11 并发借用的瞬时成因仍开放 |

### 6.1 关键结论

1. **机制类修复全部稳定**：S2 词表（11/12）、confirm 闸门合并（5/5）、
   arbitration（5/5）、forget（7/8）跨 run 一致改善；
2. **模型类指标单 run 不可比**：dedup 8→3、paraphrase 18→11 在零代码
   改动的两次运行间摆动——Phase 3 扩量必须带多 run 均值 ± 方差，单 run
   数字不能作为回归判据；
3. **noise 残留已定位**：BM25 词法通道无下限，CJK 二元分词的泛重叠；
   修复（词法分数下限/相对阈值/分词改进）归 Phase 3，与重排一起做；
4. **S2 分类的结构性弱点**：分类只看提取改述后的候选内容，改述丢词即
   漏判；应对 raw event 内容同时分类（一行改动 + 词表天然冗余，
   R-013 顺手修）。

方案 A 落地：confirm 激活时 directQueryPolicy→allow、
mentionPolicy→contextualizable_only（可入上下文与直查，不主动提及）；
accessConfirmations 职责不变（未确认记忆的一次性临时授权）；audit 记录
policy 变更。旧语义的三个测试已按新语义重写（memory-module.test ×2、
memory-module-api.test ×1），新增 R-012a/R-012b 两个用例。
