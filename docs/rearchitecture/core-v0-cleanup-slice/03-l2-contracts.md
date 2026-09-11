# R-020 L2 契约（阶段 2 实施前冻结）

> 冻结后方可实现。未冻结的字段一律不得在实现中"顺手"定义。

## C-1 agent 身份契约

### C-1.1 agent 记录

```
cochpia_agents
  id            text PK
  tenant_id     text NOT NULL
  user_id       text NOT NULL
  name          text NOT NULL
  persona       text            -- 2000 字符上限
  relationship  text            -- 朋友/恋人/家人/同事/自定义，40 字符
  role          text            -- 80 字符
  tone          text            -- 120 字符
  memory_notes  text            -- 3000 字符
  provider      text            -- 60 字符
  model         text            -- 120 字符
  avatar        text            -- 8 字符
  life_state    jsonb           -- R-021 预留，本切片恒为 {}
  seed_version  integer         -- R-021 播种器幂等，本切片恒为 0
  created_at / updated_at  timestamptz
  UNIQUE (tenant_id, user_id, name)
```

约束：
- `id` 为 UUID，由服务端生成，客户端不可指定。
- `name` 在 (tenant, user) 内唯一。改名冲突返回 409。
- 删除 agent 不级联删除其关系域记忆（记忆归 Memory Module 管，
  需显式走 `/v1/governance/delete`，`target_type: 'relationship'`）。

### C-1.2 请求上下文中的 agent 身份

```
context = {
  tenantId,              // 必填
  subjectUserId,         // 必填
  actorType,             // 'user' | 'agent' | 'system'
  actorId,               // user → subjectUserId；agent → callerAgentId
  callerAgentId,         // 必填，禁止回退常量
  sessionId,             // memory session，可空（绑定前）
  producer, correlationId, requestId
}
```

**不变量 I-1**：`callerAgentId` 为空时必须抛
`MEMORY_AGENT_CONTEXT_REQUIRED`（HTTP 400），**不得回退任何默认值**。

**不变量 I-2**：`callerAgentId` 的来源优先级
```
serviceIdentity.serviceId
  > (dev only) x-caller-agent-id header
  > applicationSession.agentId  ← 新增
```
三条都拿不到 → I-1。

### C-1.3 应用会话 ↔ agent 绑定

- 私聊会话：`session.agentId` 必填，不可为 null。
- 群聊会话：`session.agentIds[]`，可含 1-N 个；群聊内每条回复携带
  `senderId`，记忆写入时用的是**该 agent 的身份**，不是会话级身份。
- 存量会话：迁移时若 agents 表非空，绑定到首个 agent；为空则保持
  `agentId: null` 并标记 `needsAgentBinding: true`，路由层拒绝
  （400 `SESSION_AGENT_UNBOUND`）。

### C-1.4 双写期读优先级（审查 AR-207 新增）

阶段 2b 迁移期间，agents 同时存在于 `cochpia_state.agents[]` 与
`cochpia_agents` 表。

```
读优先级：cochpia_agents 表 > state.agents[]
写路径：同时写两边，以表为准
  表写成功、JSONB 写失败 → 记 degraded，不回滚表（表是权威）
  JSONB 写成功、表写失败 → 视为失败，返回错误（不能让表落后于读）
双写期结束条件：R-021 的 life_state 落表并稳定运行一个迭代
  结束后：state.agents[] 删除，所有读写走表
```

**不变量 I-9**：任一时刻读到的 agent 必须是**表**里的版本。
JSONB 只是影子副本，不得成为读路径的 fallback 之外的首选。

## C-2 会话身份契约

### C-2.1 三方会话 id 的关系

| 概念 | 载体 | 权威方 |
|---|---|---|
| 应用会话 id | `state.sessions[].id` / `cochpia_sessions` | App Runtime |
| 记忆会话 id | `memory_sessions.id` | Memory PG |
| 绑定 | `core_v0_memory_session_bindings` | Core PG |

**不变量 I-3**：绑定是**单向不可变**的：一个应用会话只对应一个记忆会话
（`core-v0.js:539 applyBindingReceipt` 已实现 SESSION_BINDING_CONFLICT）。

**不变量 I-4**：任一侧都可解析绑定——
- 应用 → 记忆：`bindingKey = tenant:user:applicationSessionId`
- 记忆 → 应用：`findBindingByMemorySession`（已实现）

**新增要求**：legacy 兼容路径（若阶段 3 前仍需）必须以**同样的 bindingKey**
调用 `createSession`，不得新建第二套绑定键。

### C-2.2 绑定解析 API（新增）

```js
// 由 memory-module-runtime 注入
resolveMemorySessionForApplicationSession({ tenantId, subjectUserId, applicationSessionId })
  → { status: 'bound', memorySessionId }
  | { status: 'unbound' }
  | { status: 'pending', code }
```

实现复用 core-v0 的绑定记录，避免重复实现。

## C-3 runtimeContext section 契约

### C-3.1 section 定义

```js
{
  key: string,                    // 唯一标识
  source: () => Promise<any>|any, // 取值函数，可抛错
  budget: number,                 // token 预算（近似，按字符/4 估算）
  required: boolean,              // true = 失败则整个上下文失败
  render: (value, budget) => string  // 渲染为 prompt 片段
}
```

### C-3.2 内置 section（本切片）

| key | 来源 | budget | required | 说明 |
|---|---|---|---|---|
| `memory` | ContextBundle | 1800 | false | 相关记忆 + 治理状态 |
| `personality` | `state.personality` | 200 | false | 人格版本/特质 |
| `agentPersona` | agent 记录 | 400 | false | **新增**：persona+tone+relationship+role |
| `profile` | `state.profile` | 150 | false | 用户侧资料 |
| `history` | 消息列表 | 按条数 | false | 近期对话 |
| `lifeTexture` | agent.life_state | 300 | false | **R-021 实现，本切片返回 null** |

### C-3.3 降级语义

**不变量 I-5**：任一非 required section 取值失败 →
- 该 section 渲染为空字符串；
- 上下文中记录 `degraded: [{ key, code }]`；
- 其余 section 不受影响；
- **不抛错，不静默**（必须出现在返回结构与指标里）。

**不变量 I-6**：`required: true` 的 section 失败 → 整个 turn 失败，
错误码透传。

**不变量 I-7**：所有 section 的渲染总和不得超过
`runtimeContext.tokenBudget`（默认 3000）；超出时按 `budget` 比例截断，
优先保证 `memory` 与 `agentPersona`。

### C-3.4 兼容性

**本切片保持扁平输出**：`buildRuntimeContext` 内部用 sections 实现，
但返回结构与此前一致（扁平字段），只**新增** `degraded` 与
`agentPersona` 两个字段。消费方（`model-provider.js`）逐步迁移。

## C-4 预留接口契约（R-021 使用）

### C-4.1 scope: `life`

```js
MEMORY_SCOPES = ['user', 'relationship', 'session', 'life']
```
可见性规则（`canSee`）：
- `life` scope 必须携带 `relationshipAgentId`；
- 仅 `relationshipAgentId === context.callerAgentId` 的 agent 可见；
- `life` scope **不出现在** `bundle.userProfile`；
- `life` scope 出现在新增的 `bundle.agentLife`（本切片不实现，
  但 scope 枚举与校验先落地）。

### C-4.2 purpose: `life_generation`

```js
purposePermission('life_generation') === 'retrieve'
```
- 只读，不可写；
- **不授予** `mention` 权限（生活生成不主动提及）；
- `life_generation` 下 `life` scope 可见性放宽为
  "自己 agent 的 + user scope 中 `autoRecallAllowed` 的"。

### C-4.3 agent life_state 形状（预留，本切片不写入）

```jsonc
{
  "mood": 0.6,                          // -1..1
  "dailyRoutine": "commute_worker",     // 枚举
  "todayEvents": [                      // 当日生成
    { "id": "...", "text": "...", "at": "ISO", "memoryId": "..." }
  ],
  "lastGeneratedAt": "ISO"              // 懒触发锚点，0 值合法（用 Number.isFinite）
}
```
**不变量 I-8**：`lastGeneratedAt` 为 null/false 时都视为"从未生成"，
判定一律用显式 null 检查，禁止直接 falsy 判断（历史踩坑三次）。

## C-5 链路切换契约（审查 AR-203 修订）

> **原 C-5"兼容窗口契约"已删除**。理由：老板决策"以我做的为主，
> 重复的删掉"，legacy stream 与 turns 是完全重复功能，兼容窗口会留下
> 第三套过渡态代码（而本轮 P1-1 的病根正是并存）。

### C-5.1 切换即删

```
顺序（不可调换）：
3.1  turns 补流式（含分段/重连/取消三个 legacy 语义）
3.2  前端切到 turns
3.3  等价性三场景人工验证（分段渲染、断线重连、生成中取消）
3.4  一次性删除 legacy 全部代码
```

### C-5.2 等价性验收（切换的唯一闸门）

| 场景 | legacy 行为 | turns 必须等价 |
|---|---|---|
| 分段渲染 | `main.jsx:707 takeSegment` 按标点/长度切段，段间 420-800ms 随机延迟 | 事件形态一致，前端不改渲染逻辑 |
| 断线重连 | `/api/chat/stream/:runId` + `Last-Event-ID`，`replaySseEvents` 重放 | 同一 run 可重连，事件不丢不重 |
| 生成中取消 | `/api/chat/cancel` → `run.controller.abort()` | 取消后不 commit，无残留消息 |

### C-5.3 回滚依赖

"直接删"可行性的前提是：**legacy 代码完整保留在 git 历史里**。
回滚 = revert 删除提交 + 前端 revert。因此删除必须是**单个提交**，
不得混入其他改动。
