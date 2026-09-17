# Companion Life Tick —— Agent 自生活切片计划（v1 草案，待老板审定）

> 状态：**草案**。批准后 L18 V0 才开工。写作纪律：切片推进，每片独立可验收、可回滚；治理闸先于功能。

## 0. 目标与明确不做

**目标**：让 agent 在用户不说话时也有可观测的「生活」——产生生活事件（写入记忆）、偶尔主动发起对话（受治理）、近况状态随时间演化。

**V0 明确不做**：人格成长曲线、多 agent 交互、游戏接入、情感状态机、拟人化活动叙事（「散步」「做饭」级别的调性决策后置）、真实定时器挂载（V0 手工触发）。

## 1. 三个切片

| 切片 | 内容 | 成本 | 验收 |
| --- | --- | --- | --- |
| **V0 内在面打通**（半天–1 天） | 手工触发一次 life tick：读最近记忆+人格投影 → 规则模板生成生活事件 → **写进记忆（不进会话消息流）**；连续触发第二次被 cooldown 拦；每日预算耗尽后 proactive 不发；feature flag 默认关 | **零模型调用** | 4 条自动化测试（见 §4） |
> **V1.5 模型生成（2026-09-17 老板裁决）**：
> - 模型来源 = 与本项目主模型**同一配置**（workbuddy2api 网关 / `MODEL_DEEPSEEK_*`）；
> - 模型 = `Z-deepseek-v4.1-flash`；**关闭思考模式**（`thinking:{type:'disabled'}`，实测网关接受且 `completion_thinking_tokens=0`）；
> - 成本很低，故**不做硬性成本节流**（每日预算闸保留，但那是「打扰闸」不是成本闸）；
> - **降级链**：模型不可用/超时/输出不可用 → 自动回落规则模板。生活事件是「有比好重要」的内在产品，不能因网关抖动就整天没有生活线。
> - **防泄露设计**：喂给模型的**只有元信息**（条数 + 类型分布），不含任何记忆原文——模型没有原文可抄，也就没有泄露通道。有测试钉住。
> - 开关：`MEMORY_LIFE_TICK_MODEL_ENABLED`（默认 false）。
>
> **V1.5 实现落点**：`server/life-event-model.js` + `.test.js`（17 例）；
> `model-provider.js` 新增 `lifeEventText()`；`life-tick.js` 加模型优先 + 降级；
> `structuredData.lifeTick.generator` 记录实际生成路径（`model`/`rule`/`rule_fallback`，可审计）。
>
> **真实网关端到端已验证**：`provider=deepseek | model=Z-deepseek-v4.1-flash`，
> `generator=model`，耗时 1216ms，产出「重新翻看今天留下的三件事，很有意思。」

| **V1 真实节奏**（1 周观察） | ~~挂真实定时器（每日 N 次）~~ → **作息窗口内随机触发**（老板 2026-09-17 定：不做固定定时器）；生成器**已接模型**（见上 V1.5）；life tick 产生的记忆进入正常记忆管线（抽取→断言→索引，走 L13 修好的 worker） | 模型调用×每日预算 | 跑一周后用 S2/S3 + proactive mention 指标族出首份真实评测报告 |

> **V1 口径修正（2026-09-17 老板裁决）**：
> - **不做固定定时器**，改「标准作息窗口（08:00–22:00 本地时）内的随机时刻」；
> - 明确留口：真实人类会有非作息的突发消息、不同人作息也不同——**这些都后置**，
>   先只做标准作息窗口内的随机事件消息（`SCHEDULER_DEFAULTS` 的窗口可配，
>   跨夜窗口已实现并有测试，为将来留的是一处配置而非一个洞）；
> - 仍不接模型生成（保持零模型调用）；
> - 主动消息仍不进会话消息流（只记记忆 + 登记 mention cooldown）。
>
> **V1 实现落点**：`server/life-tick-scheduler.js` + `server/life-tick-scheduler.test.js`
> （16 例全绿）；接线在 `server/index.js` 的 `app.listen` 处，双 flag 控制
> （`MEMORY_LIFE_TICK_ENABLED` + `MEMORY_LIFE_TICK_SCHEDULER_ENABLED`，均默认 false）。
| **V2 对话面呈现**（视 V1） | 前端「agent 近况」面板（消费生活事件记忆）；主动消息进会话消息流（用户可见、可回） | 前端 | e2e + 面板测试 |

## 2. 架构契约（写码前定死）

1. **内外分离**：生活事件只进 **memory**（agent 内在面），**不进** `cochpia_messages`（会话对话面）；只有「主动消息」才进对话面。防止生活流污染用户的会话记录。
2. **身份与隔离**：life tick 写入走 `actorType='agent'` + 显式 `callerAgentId`。这将是**记忆隔离机制第一次被 agent 主动写入真实考验**（此前隔离机制从未被历史数据考验过）——可能暴露真缺陷，属预期收益。契约测试钉住：agent 写的 life 事件在 readScope 各维度下的可读性。
3. **生成器接口先行**：`LifeEventGenerator` 接口（输入：最近记忆摘要+人格投影；输出：结构化生活事件），V0 实现=规则模板，V1 实现=模型调用。**接口稳定，实现可替换**，评测对两者同口径。
4. **触发协议**：V0 = 内部触发函数（脚本/测试直调，不做 HTTP 端点不做 cron）；V1 = 定时器挂载，入口幂等（防重入：同一 tick 窗口内重复触发只生效一次）。
5. **feature flag**：`MEMORY_LIFE_TICK_ENABLED`，**默认 false**（同 json 分支 provider 的姿势）；关闭时 tick 完全无操作。

## 3. 三道治理闸（V0 就立，不是 V1）

| 闸 | 机制 | 默认值 |
| --- | --- | --- |
| **打扰闸** | 主动消息复用既有 `cooldownUntil` 语义 + 新增每日计数（按天从记忆查询，不加新表）；**发送时刻在唤醒窗口内随机抖动，不固定时刻**（避免机械感 + 可预测性） | cooldown 语义不变；**每日预算 2 条**（老板定，2026-09-16），两次发送间隔 ≥3h |
| **记忆质量闸** | 生活事件 sensitivity 一律 S0（agent 自身元活动，不涉用户信息）；任何涉用户的情感推断**禁止在 V0 生成**（留 V1+ 且必须走 S2 确认语义） | S0，模板白名单内容 |
| **成本闸** | V0 规则模板零模型调用；V1 模型调用受每日预算硬顶 | V0 = 0 |

## 4. V0 验收语义（全自动化，可判定）

1. 触发一次 → `memory_assertions` 出现 life 事件（来源标记 agent、S0、source_refs 带 `life-tick`）且读回命中。
2. 冷却内连续触发 → 第二次**不产生**生活事件、不发主动消息（cooldown 生效）。
3. 每日预算耗尽 → 当日后续 tick 的 proactive 全部不发（生活事件仍可写——内在活动与主动打扰是两回事）。
4. flag 关闭 → tick 无操作（零写入）。
5. 既有闸门全绿（npm test + tier-2 runner + e2e ×2）——行为不变性兜底。

## 5. 与现有战略的咬合

- **解数据冷启动**：life tick 持续产生记忆/行为流 → 真实 600-case 评测、CONTEXT_TURNS 观察、隔离机制考验三件等数据的事全部被喂养。
- **依赖已就位**：proactive mention/cooldown 治理语义（L9 胶水）、人格投影表、ProjectionDispatcher 异步管线、独立服务 worker（L13）、boot-smoke 闸门。
- **不阻塞项**：与 L17（检索 SQL 预收缩）无冲突，可并行。

## 6. 开放问题裁决（2026-09-16 00:38 老板拍板）

1. **主动消息默认频率**：✅ **每日 2 条，不固定时间**——两次发送间隔 ≥3h，发送时刻在唤醒窗口内随机抖动（V0 测试用注入时钟驱动，不做 wall-clock 依赖）。
2. **拟人化程度**：✅ 按草案——轻度拟人（一条模板带记忆引用）。
3. **生活事件保留策略**：✅ 按草案——走默认 S0 retention，不特设。
4. **agent 身份粒度**：✅ 按草案——life tick 的 callerAgentId 复用会话 agent。

**裁决后状态：V0 已实现（2026-09-17）**。

实现落点：`server/life-tick.js` + `server/life-tick.test.js`（23 例全绿）。四问裁决
全部落进代码：每日 2 条 + ≥3h 间隔 + 窗口内随机抖动（`LIFE_TICK_DEFAULTS`）、
轻度拟人模板（`LIFE_EVENT_TEMPLATES`）、默认 S0 retention、callerAgentId 复用会话 agent。

**V0 实施中发现并修复了一个阻塞性缺陷**：`life` scope 的记忆「user 能读、owner
agent 读不到」——`hasGrant()` 漏了 life 分支。这是 §2.2 预判的缺陷、C-6.4
「独立治理通道未实现」的直接后果。修法与验证见
`core-v0-cleanup-slice/13-defect-note-life-scope-owner-agent-cannot-read.md`。

**两处实现修正（非缺陷）**：① 读「最近记忆」改用 `memory.list()`——`retrieve` 按
query 做 BM25 匹配，不适合「全集视图」语义；② proactive 判定改相对 24h 窗口——
`hold()` 用不可注入的真实时钟，绝对日期会与注入时钟错配。

**V0 闸门**：life-tick 23/23；npm test 491/486/0/5；run-gates --tier=2 6/6。
