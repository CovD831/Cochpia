# R-020 对抗性审查（双向刚人论证）

> 方法：对计划中的每一条主张，先构造**最强的反对论证**（红队），
> 再构造**对反对的反驳**（蓝队），最后给出裁决。
> 裁决为 `REVISED` 的条目，原计划必须相应修改。

审查对象：`00-scope.md` / `01-cleanup-plan.md` / `02-current-to-target-map.md` /
`03-l2-contracts.md` / `04-acceptance.md` / `rollback.md`

---

## 总览

| ID | 主张 | 裁决 | 影响 |
|---|---|---|---|
| AR-201 | 四阶段依赖链"不能跳" | **REVISED** | 阶段 1 可与阶段 2 部分并行 |
| AR-202 | 阶段 2 是 R-021 的硬前置 | **PARTIAL** | 三处预留不需要完整 agent 落地 |
| AR-203 | legacy 应降级为只读后退役 | **REVISED** | 应**直接删除**，不留兼容窗口 |
| AR-204 | `session.persona` 应废弃 | **SUSTAINED** | 但需先做迁移映射 |
| AR-205 | 31 个端点应删除 | **REVISED** | 分类错了，有 6 个是运维必需/外部调用 |
| AR-206 | 原作者模块"重叠则删" | **REVISED** | `compaction` 有独立价值，不能笼统删 |
| AR-207 | 本切片零破坏性 DDL | **SUSTAINED** | 但漏了一条：JSONB 内 agents 与表双写期的读优先级未定义 |
| AR-208 | 写入重构可以延后 | **DISPUTED** | 存在一个更早的触发点被忽略 |
| AR-209 | Episodes 已接线（记忆里的说法） | **DISPUTED** | 半真：接了，但有个 flag 把它和另一条路分开 |

---

## AR-201：四阶段依赖链不能跳？

### 红队（反对）

> 你说的"2 依赖 1，否则在错误基线上改"站不住。阶段 2 改的是
> **身份层**（agents 表、session.agentId、callerAgentId 解析），
> 阶段 1 改的是 **chat-memory.js 的 sessionId 传递**。两者代码路径
> 不重叠：阶段 1 动 `server/chat-memory.js:88`，阶段 2 动
> `server/memory-module-runtime.js:75`。
>
> 更重要的：**阶段 1 的价值可能被阶段 3 抹掉**。如果 legacy 路径
> 最终要退役（阶段 3），那么阶段 1 修 legacy 的 sessionId 就是
> 白干——修了一条要死的路。

### 蓝队（辩护）

> 阶段 1 不只是修 legacy。1.2（删除静默降级）和 1.3（闭环端到端断言）
> 是**基础设施**，不改任何链路代码，只加测试与可观测性。
> 这两个在阶段 2/3 之后做，成本更高（因为要适配两套链路）。
>
> 至于"白干"：1.1 最小改动只有几行，且**保留 legacy 窗口期**正需要它。

### 第三方案（审查结论）

**折中成立**。原计划的错误是把阶段 1 当成"修 legacy"来包装，实际上
应该拆开：

| 原编号 | 内容 | 新归属 |
|---|---|---|
| 1.2 | 删除静默降级 | **保留在阶段 1**（纯基础设施，与链路无关） |
| 1.3 | 闭环端到端断言 | **保留在阶段 1**（但目标链路写成 turns，不是 legacy） |
| 1.4 | 冒烟脚本 | 保留在阶段 1 |
| 1.1 | 修 legacy sessionId | **降级为可选**：仅在决定保留兼容窗口时做；若 AR-203 采纳（直接删），1.1 整条取消 |

**裁决：REVISED**。理由：1.3 的目标链路必须是 turns（因为是最终形态），
这反过来意味着**turns 需要先能被本地起服务跑通**——这一步目前没有任何
脚本支持（`CORE_V0_ENABLED` 默认关，且 local adapter 用 mock 模型）。

---

## AR-202：阶段 2 是 R-021 的硬前置？

### 红队（反对）

> R-021 需要的三处预留是：scope `life`、purpose `life_generation`、
> context section 化。这三处**都不需要 agent 表**：
> - `life` scope 只要 `relationshipAgentId`（已存在于 `relationship` scope）
> - `life_generation` 只加一行 `purposePermission` 分支
> - section 化是 `runtime-context.js` 纯重构
>
> 而 agent 表是为了"agent 身份正确"。但 R-021 v6.1 §13.2 明确说：
> 生命状态挂"agent 记录（JSONB 扩展）"——即计划里的
> `state.agents[]`。老板当时的设计就是接受 JSONB 的。
>
> 所以你把 agent 表当成 R-021 前置，是在**扩大范围**。

### 蓝队（辩护）

> 反驳无效，理由有二：
>
> **一**：`life` scope 的可见性规则是
> `relationshipAgentId === context.callerAgentId`。而 `callerAgentId`
> 现在是常量 `'cochpia'`。**如果所有 agent 的 callerAgentId 都是同一个
> 字符串，`life` scope 的隔离就是纸面的**——A 的生活事件 B 能读到。
> 这一条不修，R-021 做的"agent 有自己的生活"在数据层是假的。
>
> **二**：JSONB agents 落在 `cochpia_state`，那是**单行全量重写**的表。
> R-021 每天要写 `todayEvents`、`lastGeneratedAt`、`mood`——写进
> JSONB 意味着每次生活事件生成都触发整表重写。这是把 P0-3 的债务
> 主动恶化。

### 第三方案（审查结论）

**部分成立**：把阶段 2 拆成 2a / 2b。

- **2a（R-021 真前置，必做）**：`callerAgentId` 从会话解析（删常量）、
  session.agentId 必填、三处预留接口。
- **2b（可延后）**：agents 独立成表、prompt 接入 agent persona。

原计划把 2b 也列为 R-021 前置，属于**范围膨胀**——承认。

**裁决：PARTIAL**。2a 是前置，2b 可延后到 R-021 同期或之后。
但 2b 延后的代价是 R-021 的 `life_state` 先落 JSONB，
必须在 R-021 计划里登记"迁表"作为它的验收项。

---

## AR-203：legacy 应降级为只读后退役？

### 红队（反对）

> 你的阶段 3 是"legacy 410 + 兼容窗口一个迭代 + 前端切换"，
> 阶段 1 还要**先修 legacy 的 sessionId**。这个组合是自相矛盾的：
>
> 你要花力气修一条你计划在下一个迭代删掉的路。
>
> 而且老板已经明确表态："**以我做的为主，他做的其实很差**"，
> 并且"有些和我重复的可以删掉"。legacy stream 与 turns 是**完全重复
> 的功能**（都是聊天生成）。按老板的原则，**它应该直接删，不是降级**。
>
> 兼容窗口是典型的"不敢删"心态，会留下第三套过渡态的代码。

### 蓝队（辩护）

> 直接删有真实风险：`main.jsx:733` 是前端唯一在读的路径，
> 包括 SSE 分段渲染（`takeSegment`）、重连
> （`/api/chat/stream/:runId` 带 `Last-Event-ID`）、中断
> （`/api/chat/cancel`）。turns 目前**没有流式**，直接删就是前端全挂。
>
> 兼容窗口不是"不敢删"，是**给前端切换留出验证时间**。

### 第三方案（审查结论）

**红队更强，但要修正执行方式**。正确的顺序不是"降级 → 窗口 → 删"，
而是：

```
3.1  turns 补流式（含重连语义，对齐 legacy 的 run 概念）
3.2  前端切到 turns，跑通等价性验证（分段、重连、取消三个场景）
3.3  legacy 一次性删除（不是 410，是删代码）
```

即：**没有兼容窗口**。窗口的存在意义是"允许两套并存"，但并存本身
就是 bug 源（本轮诊断的 P1-1 正是并存导致）。一旦前端切换验证通过，
legacy 的价值归零，留着只会让下一个接手的人再困惑一次。

**裁决：REVISED**。删除 `03-l2-contracts.md` 的 C-5（兼容窗口契约），
改为"切换即删"。阶段 1 的 1.1 随之取消（见 AR-201）。

---

## AR-204：`session.persona` 应废弃？

### 红队（反对）

> `session.persona` 是**会话级**人格，agent.persona 是**agent 级**人格。
> 语义不同！一个 agent 可以在不同会话里有不同表现（例如"工作会话我
> 希望 TA 严肃，闲聊会话我希望 TA 轻松"）。废弃 session.persona 是
> **功能退化**。

### 蓝队（辩护）

> 反方把"能力"和"实现"混淆了。会话级人格如果要保留，正确做法是
> **agent 记录的会话级 override**，不是 `cochpia_state` 里的
> `session.persona` 字符串。
>
> 但红队指出了一个真实问题：**不能直接删**。前端
> `/api/sessions/:id/persona` 还在用（`main.jsx` 调用），
> 用户可能已经在用这个功能。

### 第三方案（审查结论）

**维持废弃，但加迁移步骤**：
1. 阶段 2b 时，`session.persona` 内容**复制**到 agent 的
   `personaOverride`（新增字段，会话级）。
2. API 保留 `/api/sessions/:id/persona`，但写入落到 agent 记录。
3. 观察一个迭代后删除 `session.persona` 字段。

**裁决：SUSTAINED**（原计划方向对），但补迁移步骤与字段。

---

## AR-205：31 个端点应删除？

### 红队（反对）

> 你用"前端零调用"作为删除依据，但这个判据**不完整**：
>
> 1. **外部调用者**：`/mcp` 是 MCP 协议端点，调用方是外部 AI 客户端，
>    不是这个前端。删掉等于砍掉集成能力。
> 2. **运维依赖**：`/api/health`、`/api/ready`、`/api/metrics` 是
>    Railway 部署的健康检查（`deploy/` 目录里配置的）。删了部署会挂。
> 3. **被你自己的计划使用**：`/api/models/:provider/test` 是模型连接
>    测试，`README.md` 明确写了它是产品功能（设置面板）。
> 4. `/api/profile` 与 `/api/preferences`：前端可能通过其他方式调用
>    （`apiBase` 拼接、动态路径），你的 grep 可能漏了。

### 蓝队（辩护）

> grep 的范围是 `client/src/main.jsx` 全文的 `/api/` 字面量，
> 动态拼接的路径会以模板字符串形式出现（`${apiBase}/api/...`），
> 我的正则 `[a-zA-Z0-9/:{}\$_-]+` 覆盖了 `$`，所以漏检可能性低。
>
> 但红队对 `/mcp`、`/api/health`、`/api/ready`、`/api/metrics` 的
> 质疑**完全成立**——我在 `01-cleanup-plan.md` 里其实已经把
> `/api/health` 等列入了"保留"，但 `00-scope.md` 的 P1-2 清单
> 把它们也列进去了，**两个文档自相矛盾**。

### 第三方案（审查结论）

**红队胜**。修正分类：

| 类别 | 端点 | 处置 |
|---|---|---|
| **运维必需** | `/api/health`、`/api/ready`、`/api/version`、`/api/metrics` | 保留 |
| **外部集成** | `/mcp` | 保留（需确认是否真在用） |
| **产品功能** | `/api/models`、`/api/models/:provider/test`、`/api/profile`、`/api/preferences` | 保留（前端应改用，不是删） |
| **确认可删** | `/api/memories*`（5 个）、`/api/memory/dream` | 删（Memory `/v1` 是权威） |
| **确认可删** | `/api/music/*`（9 个）、`/api/personality/audit`、`/api/personality/rollback` | 删（前端零调用） |
| **需人工确认** | `/api/export`、`/api/import`、`/api/sync`、`/api/sessions/:id/messages/:messageId` | 逐个确认后定 |

**裁决：REVISED**。原 P1-2 的"31 个"数字含误判，真实可删约 16 个，
需确认 4 个。

---

## AR-206：原作者模块"重叠则删"？

### 红队（反对）

> 你说 `auto-memory.js`、`compaction.js` 与 Memory 重叠，可以删。
> 但实际检查：
>
> **`compaction.js` 不与 Memory 重叠**。它做的是**会话内**的
> 对话摘要（30 条超限 → 压缩成 `session.summary`），进入 prompt 的
> 「对话摘要」段。Memory 的 episodes 是**跨会话**的 30 分钟时间窗
> 分组。两者粒度不同、用途不同。
>
> 删掉 compaction 会导致长对话（>30 条）的上下文丢失——
> 这是**功能退化**，不是清理。

### 蓝队（辩护）

> 反方对 compaction 的分析成立，我承认判断粗糙。
>
> 但 `auto-memory.js` 的判断仍然成立：它的 `shouldRemember` 是
> 关键词启发式（`/记住|记得|喜欢|.../`），而 Memory Module 的提取器
> 是 LLM few-shot（`memory-extraction.js`，R-013c 已调优到 30s 预算）。
> **启发式是 LLM 提取器的劣化版**。且 `auto-memory.js` 只在
> `finalizeMemoryModule`（legacy 路径）被调用，随 legacy 删除自然消亡。

### 第三方案（审查结论）

**修正模块处置表**：

| 模块 | 归属 | 处置 | 理由 |
|---|---|---|---|
| `auto-memory.js` | 原作者 | **删**（随 legacy） | 启发式被 LLM 提取器取代 |
| `compaction.js` | 原作者 | **保留并接入 turns** | 会话内摘要，与 Memory 不重叠 |
| `personality.js` | 原作者 | **保留** | 人格版本管理，Memory 没有 |
| `growth-evidence.js` | 原作者 | **保留**（但需接线到 agent） | 成长证据，R-021 的 L3 叙事身份需要 |
| `psychology.js` | 原作者 | **保留** | atmosphere 预设，已在用 |
| `music-service.js` + `netease-music-adapter.js` | 原作者 | **删** | 与核心无关，前端零调用 |
| `pi-client.js` + `tools.js` | 原作者 | **保留** | 工作模式引擎 |
| `sync-service.js` | 原作者 | 需确认 | 多端同步，前端调用 `/api/sync` |
| `mcp-client.js` + `stdio-mcp-client.js` | 原作者 | **删** | 零引用 |
| `collection-query.js` | 原作者 | **保留** | 分页/搜索，被多处使用 |
| `workspace-preferences.js` | 原作者 | **保留** | 前端设置面板在用 |

**裁决：REVISED**。新增一节"原作者模块处置表"到 `02-current-to-target-map.md`。

---

## AR-207：本切片零破坏性 DDL？

### 红队（反对）

> 你的 `rollback.md` 声称"不存在数据层不可逆变更"，但漏了一个：
> **双写期（阶段 2b）的读优先级未定义**。
>
> 具体：迁移后 agents 同时在 `cochpia_state.agents[]` 和
> `cochpia_agents` 表里。如果两边不一致（一边被写另一边没写），
> 读哪边？你的计划没说，实现时会各写各的，产生静默数据分歧。

### 蓝队（辩护）

> 计划里写了"迁移是复制不是移动（观察期内双写）"，确实没写
> 读优先级。但这是实现细节，可以在 `03-l2-contracts.md` 补。

### 第三方案（审查结论）

**成立，补契约**：

```
读优先级（双写期）：cochpia_agents 表 > state.agents[]
写路径：同时写两边，以表为准；表写成功而 JSONB 写失败 → 记 degraded，
        不回滚表（因为表是权威）
双写期结束条件：R-021 的 life_state 落表并稳定运行一个迭代
```

**裁决：SUSTAINED**（零破坏性 DDL 成立），但补一条契约 C-1.4。

---

## AR-208：写入重构可以延后？

### 红队（反对）

> 你给的触发条件是"并发用户 > 5，或单用户记忆 > 5000 条，
> 或 turn p95 > 3s"。但这个条件**漏了最可能先到的一个**：
>
> **R-021 自己就会触发它**。生活模块每天为每个 agent 生成 1-2 条
> 事件，每次生成要写回 Memory（走治理面 → 触发
> `repository.save` → 27 表全量重写）。加上 `lastGeneratedAt` 的状态
> 更新，**每个活跃 agent 每天固定产生 2-3 次全量重写**。
>
> 并发用户 5 个 × 3 个 agent × 3 次/天 = 45 次全量重写/天，
> 每次重写 27 张表。这已经不是"能不能撑住"的问题，是会不会把
> PG 的 WAL 写爆。

### 蓝队（辩护）

> 反驳夸大了一处：`save` 是全量重写**该 subject 的数据**，不是全库。
> 单用户数据量小时（几千条），重写成本可控。
>
> 但红队的核心论点成立：**R-021 的写入频率远高于聊天**。
> 聊天是用户驱动的（一天几十轮），生活模块是**每天必然发生**的。

### 第三方案（审查结论）

**红队胜**。修正触发条件：

```
债务偿还触发条件（OR 关系）：
1. 并发用户 > 5
2. 单用户记忆条目 > 5000
3. turn p95 > 3s
4. 【新增】R-021 生活模块进入实现阶段 ← 这是最早会到的
```

并且：**建议把写入重构的立项提前到 R-021 之前或同期**，
或至少在 R-021 计划里把"Memory 写路径优化"列为它的并发项。

**裁决：DISPUTED → 修改触发条件**。

---

## AR-209：Episodes 已接线？

### 红队（反对）

> 你的记忆文件写"R-017b：rebuildEpisodes 接入 drain（episodes 在
> ContextBundle 恒空的空转终结）"，也就是 epispodes 已经工作了。
> 但代码显示：
>
> - `memory-extraction.js:211` 的 `episodeGrouping` 默认值来自
>   `process.env.MEMORY_EPISODE_GROUPING !== 'false'`（默认 true）
> - `memory-module-flags.js:6` 的 `episodeGrouping: false`（默认 false！）
> - `core-v0-production.js:363` 构造 drain 时**没有传** `episodeGrouping`
>
> 所以：drain 路径上是 on（因为没传，用默认 true），但
> **`memory-module-flags.js` 的默认值 false 是给 service-worker
> 用的另一条路**。两条路的默认值相反。

### 蓝队（辩护）

> 这在生产路径上确实是 on（drain 用默认 true）。service-worker
> 那条路已确认退役（R-017b 决议）。所以实际行为是对的，
> 只是**默认值定义处不一致**，是代码卫生问题，不是 bug。

### 第三方案（审查结论）

**红队发现成立，但影响轻微**。两条路径默认值相反是真实的不一致，
属于**清理项**（阶段 4），不影响功能。

新增清理任务：统一 `episodeGrouping` 默认值定义处，
消除 `memory-module-flags.js` 的影子 flag。

**裁决：DISPUTED → 记为清理项**。

---

## AR-210：`promoteCandidate` 只认 user 身份，agent 身份落地会打断提取闭环

**发现时机**：阶段 1.3 实施时（写闭环测试第一次用了 `actorType: 'agent'`，
drain 报 `GOVERNANCE_FORBIDDEN`）。

### 事实

`memory-module.js:1036` 的 `promoteCandidate` 第一行是
`assertUserGovernanceActor(context)`，而该断言（`:426-427`）要求：

```js
context.actorType === 'user' && context.actorId === context.subjectUserId
```

提取 drain 的 promotion 步骤正是走这条路（`memory-extraction.js:494`）：

```js
const promoted = await memory.promoteCandidate(context, created.memory.memoryId, {...});
```

**所以：drain 的 context 必须是 user 身份，否则提取出来的候选永远停在
`candidate` 状态，进不了检索语料。**

### 今天为什么没炸

`/api/chat/*` 挂在 `/api` 前缀，不经过 `/v1` 的 service boundary
（`index.js:138`），所以 `memoryServiceIdentity` 不被设置，
`memory-module-runtime.js:74` 落到 `actorType = 'user'`，
`actorId = subjectUserId`。drain 继承了同一份 context（`index.js:192`
的 `coreV0ContextForRequest` → `core-v0-production.js:363` 传入），
所以 promotion 能过。

### 为什么它是 R-021 的阻断项

阶段 2a 要把 `callerAgentId` 从常量改为**从会话解析**，并要求
`context = { tenant, subject, agent }`。一旦 agent 身份生效：

1. 如果 actorType 跟着变成 `agent` → **drain 立刻失效**，所有提取出的
   记忆停在 candidate，检索语料空转——R-021 的"生活事件写回记忆"
   直接写不进去；
2. 如果 actorType 保持 `user` 但 `callerAgentId` 是 agentId →
   `hasGrant`（`memory-module.js:319-323`）对 `relationship` scope 的
   判定会要求 `assertion.relationshipAgentId === context.callerAgentId`，
   而 drain 建的是 user scope 断言，这条暂时不受影响——**但
   `assertUserGovernanceActor` 仍然会过，因为 actorType 还是 user**。

也就是说：**方案 2 可行，方案 1 会炸。** 但这不该靠"正好没踩到"来保证。

### 裁决：追加到阶段 2a 的实现约束

阶段 2a 必须显式回答"drain 用什么身份"这个问题，并在契约里写死：

```
C-6 drain 身份契约（阶段 2a 新增）

- drain 是系统行为，不代表某个 agent 的意志：它的 actorType 恒为 'user'，
  actorId 恒为 subjectUserId。
- callerAgentId 仍然传递（供 scope 过滤与 relationship 判定使用），
  但不得改变 assertUserGovernanceActor 的判定结果。
- 若将来需要 agent 自主写入（R-021 的"agent 的生活就是它的记忆"），
  必须走独立的 governance 通道，而不是放宽 assertUserGovernanceActor。
  R-021 的生活事件写回应显式声明使用哪条通道。
```

**并新增验收项 2a-A10**：以 agent 身份构造的 context 调用 drain 时，
promotion 行为必须与 user 身份一致（证明 2a 没有悄悄改变 drain 的身份
语义）。

### 影响面

| 项 | 影响 |
|---|---|
| 阶段 1.3 测试 | 已按 `actorType: 'user'` 编写（与生产一致），并在文件头注明原因 |
| 阶段 2a 范围 | 新增 C-6 契约 + 验收项 2a-A10 |
| R-021 设计 | 生活事件写回必须显式选择 governance 通道（新增决策点） |

---

### 必须修改

1. **阶段 1 拆解**（AR-201）：1.1（修 legacy sessionId）取消或降级为可选；
   1.2/1.3/1.4 保留，但 1.3 的目标链路写成 turns。
2. **阶段 2 拆 2a/2b**（AR-202）：2a 是 R-021 真前置，2b 可延后。
3. **取消兼容窗口**（AR-203）：`03-l2-contracts.md` 的 C-5 删除，
   改为"切换即删"。
4. **端点分类重做**（AR-205）：真实可删 16 个，非 31 个；补
   "/api/profile、/api/preferences 应保留"。
5. **新增原作者模块处置表**（AR-206）：11 个模块逐个定性。
6. **补 C-1.4 双写读优先级**（AR-207）。
7. **债务触发条件加第 4 条**（AR-208）：R-021 进入实现阶段。
8. **新增清理项**（AR-209）：统一 `episodeGrouping` 默认值。
9. **新增 C-6 drain 身份契约 + 验收 2a-A10**（AR-210，实施时发现）。

### 新增"必须验证"的前置

- **turns 的本地可跑性**：目前 `CORE_V0_ENABLED` 默认关，local adapter
  用 mock 模型。1.3 的闭环断言必须在 turns 上跑，因此需要一个
  **turns 本地启动脚本**（`scripts/turns-local-smoke.js`），
  这是阶段 1 的第一个交付物。
  **状态：已交付，7/7 通过（2026-09-10）。**

### 实施进度（阶段 1）

| 项 | 状态 | 证据 |
|---|---|---|
| 1.0 turns 本地冒烟 | 完成 | `scripts/turns-local-smoke.js` 7/7；`artifacts/turns-local-smoke.json` |
| 1.2 降级显式标记 | 完成 | `server/chat-memory-degrade.test.js` 6/6；`observability.recordMemoryDegrade` |
| 1.3 闭环端到端断言 | 完成 | `server/chat-memory-loop.test.js` 6/6（含负向守卫 L4） |
| 1.4 冒烟脚本 + 全量回归 | 进行中 | 见下方验收记录 |

### 实施期发现（值得单列）

- **AR-210**：`promoteCandidate` 的 user-only 治理断言与 agent 身份落地
  冲突。今天不炸是因为 chat 路径的 actorType 恰好是 `user`；阶段 2a
  必须显式定契约，不能靠巧合。
- **两个实现陷阱（已修）**：
  1. `turn.result` 在 `core-v0.js` 有**两处**构造点
     （`responseForCommitted` 的兜底 + `commitAssistantInMemory` 的写入），
     只改一处会导致降级标记丢失；两处已同步。
  2. 闭环测试的 `mockRepository` 必须交**Memory 切片**
     （`state.memoryModule`），交应用 state 会让 drain 读到 0 条 raw event
     并静默报 `idle`——正是"假绿"的典型形态。
- **环境约束**：本机沙箱内 `import('pg')` 会触发 SIGTERM，
  运行任何加载 `store.js`/`core-v0-production.js` 的脚本都需要
  在沙箱外执行（`dangerouslyDisableSandbox`）。这**不是代码问题**。

---

## AR-211：阶段 3.4「删 handleChatStream」与 disposition「保留工作模式」直接冲突

**发现时机**：阶段 3.4 实施前（准备动删之前）。

### 事实

`01-cleanup-plan.md` 3.4 的冻结指令是：

> 删 `handleChatStream` 全函数、`/api/chat/stream`、`/api/chat/regenerate`、
> `/api/chat/retry`、`/api/chat/cancel`、`/api/chat/stream/:runId`

而 `06-legacy-module-disposition.md` 写的是：

| 模块 | 处置 |
|---|---|
| `pi-client.js` | **保留**「工作模式引擎（Pi RPC），不属伴侣链路但功能完整」 |
| `tools.js` | **保留**「同上，含审批流」 |

**问题**：工作模式的唯一入口就在 `handleChatStream` 内部
（模式切换 + Pi RPC + 本地工具回退，共 **113 行**，原 963-1075）。
删掉它，`pi-client.js` 与 `tools.js` 立刻变成死代码——两份文档直接打架。

### 附带发现：3.2 已经造成回归

3.2 把前端 fetch 从 `/api/chat/stream` 改到 `/api/chat/turns`。
而工作模式靠**服务端在 legacy 里做关键词检测**触发（`detectModeSwitch`），
turns 完全没有这套逻辑（已 grep 验证零命中）。

**所以 3.2 落地的瞬间，工作模式就不可达了**——打字「切换到工作模式」
只会被当普通聊天回一句。这是实施中引入的回归，不是既有问题。

### 裁决（老板 2026-09-11）

**工作模式保留为独立路由。**

1. 抽出 `handleWorkStream`，挂 `/api/chat/work`。
   工作模式与伴侣链路本就是两条业务线，turns 的 turn 管线没有
   工具循环、没有审批流、没有 Pi 引擎，硬塞进去会污染 turn 语义。
2. 模式切换归工作路由独占。老板明确 **turns 不读写 `session.mode`**，
   所以「切换到工作模式」这类指令必须由工作路由应答。
3. 工作模式自己的运行控制：`/api/chat/work/cancel`（POST）、
   `/api/chat/work/:runId`（GET 重连）。
4. 工作路由加**守卫**：处于 companion 模式且不是切换指令时返回
   `USE_TURNS_FOR_COMPANION` 错误，而不是顺手作答——否则等于复活了
   本阶段要删掉的第二条聊天链路。

### 契约修正

| 原条款 | 修正 |
|---|---|
| 3.4 删 `handleChatStream` 全函数 | 改为：**抽出**工作模式为 `/api/chat/work`，只删伴侣部分 |
| disposition 删 `auto-memory.js` | **保留**——工作模式的 `finalizeMemoryModule` 仍用 `shouldRemember`；该模块的「随 legacy 消亡」前提不成立了 |
| 3.4 删 `/api/chat/cancel`、`/api/chat/stream/:runId` | 改为**改名**为 `/api/chat/work/cancel`、`/api/chat/work/:runId`（工作模式仍需取消与重连） |
| 3.4 删 `/api/chat/stream` 等三条 | 保持删除（伴侣链路，已由 turns 承接） |

`/api/chat/approve`（工具审批）与 `/api/upload` 一并保留，属工作模式。

### 附带修复：模式检测单点化

模式切换正则原本只存在于 `index.js`。现在前端也需要它来决定
消息该发往 turns 还是 work——**两份正则必然漂移**，而失败模式是静默的
（用户说了切换，消息却落到伴侣链路，什么也没发生）。

已抽成 `server/mode-switch.js`，**服务端与前端 import 同一个实现**，
并提供 `MODE_SWITCH_SAMPLES` 样本集供两端测试共用。

### 影响面

| 项 | 影响 |
|---|---|
| 阶段 3.4 范围 | 删减（伴侣部分），新增工作路由抽取 |
| `auto-memory.js` | 从「删」改为「保留」 |
| 新增文件 | `server/work-mode` 逻辑内联于 `index.js`（`handleWorkStream`）、`server/mode-switch.js` |
| 验收 | 新增 `test:stage3`（13 项）+ `check:routes`（真实路由表） |

---

## AR-212 ~ AR-215：端到端验收（浏览器实跑）发现的四个问题

**发现方式**：阶段 3 的闸门要求人工验证三个场景。为免占用老板时间，
先写了浏览器端到端验收（`scripts/e2e-acceptance.py`，`npm run test:e2e`），
真实驱动 UI、真实断流。**四个问题全部只有跑起来才会暴露**——
单元测试、路由表检查、`npm test` 全绿时它们都潜伏着。

### AR-212（我方引入，严重）：无条件要求 agent 身份，打空整个首页

**现象**：浏览器里首页**一个会话、一个 Agent 都不显示**，且不报错。

**根因链**：阶段 2a 的 C-11 把 `MEMORY_AGENT_CONTEXT_REQUIRED` 做成**无条件**抛错。
`/api/memory/overview` 是 GET、无 session，解析不出 agent → 400。
而前端启动时的 `refresh()` 用 `Promise.all` 拉 8 个接口——
**一个 400 就让整批 reject，`setSessions`/`setAgents` 全不执行**，
于是首页空白且无任何错误提示。

**为什么没被测试拦住**：阶段 2a 的测试只覆盖了「有 session 时」的路径，
没有覆盖「无 session 的用户级视图」。`npm test` 全绿，因为没人测真实 HTTP 路由。

**修正**：把 agent 要求限定在**会话作用域**的上下文。用户级视图
（overview / dream）本就该是 agent-agnostic 的——它是"用户拥有的一切"的
展示/治理视图，不按 agent 过滤。`requiresAgent = chat && Boolean(sessionHint)`。

**回归测试**：`agent-scope-2a.test.js` A-4（无 session 不得要求 agent；
有 session 仍必须报错）。

### AR-213（既有 bug）：mock 流式分块会**删除**换行

**现象**：浏览器里整条回复挤在一个气泡，分段渲染完全没发生。

**根因**：`full.match(/.{1,12}/gu)` —— **`.` 在无 `s` flag 时不匹配 `\n`**，
于是 `match()` 把每一行单独取出、**换行符被丢弃**。
流式文本与非流式文本因此**不一致**（换行消失）。

**为什么没被拦住**：`turn-stream.test.js` 的 T8 断言"两条路径内容一致"，
但用的是**单行**夹具——单行没有换行，正好绕过这个 bug。

**修正**：改用 `/[\s\S]{1,12}/gu`；T8 夹具改成多行，并显式断言
`split('\n').length === 3`。测试夹具的分块器同步修正。

### AR-214（配置缺口）：`CORE_V0_ENABLED` 未设置，聊天直接不可用

**现象**：`.env` 里没有 `CORE_V0_ENABLED`，而 `coreV0Enabled()` 默认 `false`。

**影响**：阶段 3 把前端切到 `/api/chat/turns` 之后，**这是唯一伴侣链路**。
开关为 false 时该路由返回 503 → 前端报「流式连接失败」→ **聊天完全不能用**。

**修正**：
1. 把开关检查提到路由最前，返回明确的 `503 CORE_V0_DISABLED`
   且消息带可执行指引（`set CORE_V0_ENABLED=true`）；
   此前走流式分支会退化成含糊的 500 `CORE_V0_FAILED`。
2. **待老板决定**：是否在 `.env` 写入 `CORE_V0_ENABLED=true`。
   因为已无回退链路，这个开关事实上不能再关。

### AR-215（UI 缺口，已在本阶段修复）：前端没有取消控件

**现象**：全前端搜索 `停止 / 取消 / abort` **零命中**。
流式期间输入框与按钮反而被 `disabled={streaming}` 锁住。

**影响**：闸门第 3 项「生成中取消（老板亲测）」**用户无法触发**。
协议层是好的（`DELETE /api/chat/turns/:runId`，T5 已锁定："取消后断言数为 0"），
但产品里没有入口。

**性质**：**既有缺口，非本次引入**——legacy 时代前端也从未调用过
`/api/chat/cancel`。原闸门条目默认了一个并不存在的控件。

**处置（老板裁决：并进阶段 3）**：已补
- 前端：`cancelGeneration` + `.stop-button`（流式中替换发送按钮），
  companion 走 `DELETE /api/chat/turns/:runId`，工作模式走 `/api/chat/work/cancel`；
  本地 `AbortController` 中断流，停止后与服务端重新对齐（`loadSessionMessages`）。
- 取消是**刻意行为**，故：AbortError 不当作错误上报；停止按钮视觉上
  与发送按钮明显区分（避免误点杀掉回复）。
- 锁定：`test:stage3` C-8（控件 + 接线 + 视觉区分）；
  端到端 S3-a/b/c，其中 **S3-c 查服务端**而非 DOM——
  「不落地半截回复」是服务端事实，DOM 可能掩盖已提交的消息。

### 端到端实测结论（`npm run test:e2e`，**8/8**）

| 检查 | 结果 |
|---|---|
| S1-a 分段渲染：逐段出现 | **通过**（最多同时 4 段） |
| S1-b 分段渲染：内容正确 | **通过**（四段逐字一致） |
| S2-a 断线恢复：无丢失 | **通过**（真实断网后完整） |
| S2-b 断线恢复：无重复 | **通过** |
| S3-a 取消控件可用 | **通过** |
| S3-b 取消后回到可发送态 | **通过** |
| S3-c 服务端未落地半截回复 | **通过**（查服务端，非 DOM） |
| S4 全程无异常响应 | **通过** |

**断网模拟方法**：不需要按进程断网（macOS 需 sudo 且会误伤页面其他资源）。
用浏览器层 `context.set_offline(True/False)` 精确切断该连接的 SSE——
比切系统网络更忠实，因为它只影响被测的那条流。

### 阶段 3 收尾时的配置变更

**AR-214 已处置**：`CORE_V0_ENABLED=true` 写入 `repo-main/.env`（老板批准，
2026-09-11）。`.env` 被 git 忽略，不进版本库；此处记录以免后人不知
这个开关已事实上不可关闭。
