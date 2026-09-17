# Defect note: `life` scope 的 owner agent 读不回自己的记忆（2026-09-17）

## 一句话

`life` scope 的记忆**用户能读、拥有它的 agent 读不到**——`hasGrant()` 没有为
`life` 提供 owner-agent 放行分支，落进了 `scopeGrants` 兜底（需要一条用户签发的
user-scope grant），而 `grantUserScope` 又强制 `actorType='user'`，agent 无法自授。
**R-021 的读取链路因此是断的**：写进去的生活事件，生成它的 agent 自己也读不回来。

## 证据（三组对照，同一内存 state，无外部依赖）

| 场景 | 写入 | 读取者 | 结果 |
| --- | --- | --- | --- |
| A（对照） | `relationship` scope, rel=agent-x | agent-x（`answer_user_query`） | **1 条（可读）** |
| B | `life` scope, rel=agent-x | agent-x（`life_generation`） | **0 条（读不到）** |
| C | `life` scope, rel=agent-x | user（`answer_user_query`） | **1 条（可读）** |

B 与 C 的差异排除了「写入失败」「索引缺失」「purpose 非法」等解释——写入
（`status: active`）与 user 读取都正常，唯独 owner agent 被挡。

复现脚本要点（`createMemoryModule` + `createMemoryModuleState`，无需 PG）：

```js
await memory.hold(agentCtx, { content:'生活记忆', memoryType:'life_event',
  scopeType:'life', relationshipAgentId:'agent-x', sensitivity:'S0' });
const r = await memory.retrieveAsync(agentCtx,
  { query:'生活', purpose:'life_generation', limit:20 });
// 期望 1，实际 0
```

## 根因

`server/memory-module.js` 的 `hasGrant()`（约 352-368 行）：

```js
if (context.actorType === 'user' && context.actorId === context.subjectUserId) return true;
if (context.actorType !== 'agent' || !context.callerAgentId) return false;
if (assertion.scopeType === 'relationship') return assertion.relationshipAgentId === context.callerAgentId;
if (assertion.scopeType === 'session') return assertion.relationshipAgentId === context.callerAgentId && assertion.sessionId === context.sessionId;
// ← 没有 life 分支，life 落到下面的 scopeGrants 兜底
return state.scopeGrants.some(grant => ... grant.scopeType === 'user' ...);
```

`life` 的语义与 `relationship` 同族（都是「按 agent 归属」），`scopeOf()` 也已强制
`life` 必须带 `relationshipAgentId`（`INVALID_SCOPE`），可见性意图显然是
「owner agent 可见」。但放行分支漏了。

次要一环：`grantUserScope()`（约 972 行）第一行硬校验
`context.actorType !== 'user' → GOVERNANCE_FORBIDDEN`，所以即便走 grant 路线，
agent 也无法为自己取得 user-scope grant——这条兜底路径对 agent 是关闭的。

## 与既有契约的关系

- 计划 `docs/companion-life-tick-plan.md` §2.2 已**预判**这会暴露真缺陷（原文：
  「这将是记忆隔离机制第一次被 agent 主动写入真实考验……可能暴露真缺陷，属预期收益」）。
- `07-l2-contracts-2a.md` 的 **C-6.4** 写明：「R-021 的生活事件写回若需要 agent
  自主性，必须走**独立治理通道**（显式声明 + 审计），**不在本阶段实现**」。
  → 本缺陷正是「该通道至今未实现」的直接后果。
- `05-adversarial-review.md` 的 AR-202 讨论过 life scope 的可见性规则是
  `relationshipAgentId === context.callerAgentId` —— 与 `hasGrant` 现状不符，
  说明这是**实现未跟上契约**，不是设计分歧。

## 影响面

- **阻塞**：R-021 / L18 life tick 的「读回」验收（V0 验收语义第 1 条）。
- **不阻塞**：写入路径、治理闸（cooldown/预算/间隔）、模板生成、flag 开关
  ——这些均已实现并通过测试（见 `server/life-tick.test.js`，19 例中 14 例通过，
  失败的 5 例全部源于本缺陷或依赖它的计数）。
- **生产现状**：life scope 目前无任何生产写入方（R-021 是第一个），
  所以该缺陷在现状下不造成数据泄漏或丢失，只造成「新功能读不回」。

## 建议修法（未实施——属隔离语义变更，需 owner 裁决）

在 `hasGrant()` 的 relationship 分支旁补 life 分支，与 AR-202 所述规则一致：

```js
if (assertion.scopeType === 'life') return assertion.relationshipAgentId === context.callerAgentId;
```

**风险与理由**：
- `life` 与 `relationship` 的归属语义完全相同（都由 `relationshipAgentId` 定），
  复用同一规则不扩大任何 agent 的可见范围。
- 只影响 `life` scope——而该 scope 目前只有 R-021 会写，blast radius 极小。
- 需要配套：`canSee` 的 readScope 收窄逻辑已覆盖 life（第 391 行），无需改动；
  但应补测试钉住「life scope owner agent 可读 / 非 owner 不可读 / user 可读」三向。

## 状态

**已修（2026-09-17，老板裁决 A）**。修法即上文建议的那一行，落在
`hasGrant()` 的 relationship 分支之后、session 分支之前，附注释指向 AR-202 与本笔记。

**验证**（三向 + 回归）：

| 项 | 结果 |
| --- | --- |
| owner agent 可读回自己的 life 记忆 | ✅ 1 条 |
| 非 owner agent 读不到（隔离未放宽） | ✅ 0 条 |
| user 仍可读（既有可见性未缩小） | ✅ 1 条 |
| 非 owner 换 purpose（含 `life_generation`/`proactive_mention`）仍读不到 | ✅ 0 条 |
| `server/life-tick.test.js`（含 LS1–LS4 四向回归钉） | ✅ 23/23 |
| `npm test` 全量 | ✅ 491/486/0/5 |
| `run-gates --tier=2`（含 leak-probe 隔离守卫） | ✅ 6/6 |

**顺带修正的实现问题**（同批修复，非缺陷）：原 tick 用
`retrieveAsync({ query: 'recent' })` 读「最近记忆」是错的——`retrieve` 按 query
与内容做 BM25 匹配，一个不命中内容的 query 会返回 0 条。tick 要的是「这个 agent
现在能看到哪些记忆」的全集视图，正确接口是 `memory.list()`（同样经 `canSee`
过滤，隔离不打折；且它是同步函数）。测试里也据此改用 `list` 做可见性断言，
避免把可见性问题伪装成检索问题。

**另一处实现修正**：proactive 的预算/间隔判定原按「日历日 + 绝对时间戳」比较，
但 `memory.hold()` 用的是模块内部真实时钟（不可注入），注入时钟的测试会永久
错配。改为**相对 24h 窗口**（以判定时刻为锚），并调整测试用回填 `createdAt`
模拟时间流逝。
