# R-020 阶段 2a L2 契约（冻结版）

> 冻结时间：2026-09-10
> 前置：`03-l2-contracts.md`（总体契约）
> 本文档只覆盖 **2a 的实现级契约**，是写代码前的最后一道闸。
> 冻结后未列入本文档的行为**一律不得实现**；发现缺口须先修订本文档。

---

## 0. 冻结前必须知道的一个实测结论

### 0.1 实测：`actorType: 'user'` 会绕过全部关系域隔离

在冻结契约前做了一次实测（`/tmp/scope-probe.mjs`、`/tmp/probe2.mjs`）：

```
准备：agent-a 与 agent-b 各写一条 relationship scope 记忆（S0）

检索结果：
  user actor (callerAgentId=agent-a)  -> 2 条   ← 两条都看得见
  agent-a                             -> 1 条   ← 只看自己的
  agent-b                             -> 1 条   ← 只看自己的
```

根因在 `memory-module.js:319-323`（`hasGrant`）第一行：

```js
if (context.actorType === 'user' && context.actorId === context.subjectUserId) return true;
```

以及 `:344`（`canSee`）的关系域隔离条件：

```js
if (assertion.scopeType === 'relationship' && assertion.relationshipAgentId !== context.callerAgentId
    && context.actorType === 'agent') return false;   // ← 仅对 agent 生效
```

### 0.2 这意味着什么

| 场景 | 现状 | 判定 |
|---|---|---|
| 用户查看自己的数据（治理、导出、删除） | `actorType: 'user'` 看全部 | **正确**——这是数据主体权利 |
| **聊天回复的上下文装配** | 也走 `actorType: 'user'` | **错误**——会把 agent-b 的生活/关系记忆塞进 agent-a 的回复 |
| 提取 drain 的 promotion | `actorType: 'user'` | **必要**——见 AR-210 |

**同一份 context 承担了两个不可调和的角色**：数据主体的全权视角，
和单个 agent 的受限视角。

### 0.3 对 2a 的直接约束（本契约的核心）

**2a 不得把 `actorType` 改成 `'agent'` 来解决隔离问题。** 理由：

1. 改了就触发 AR-210：`promoteCandidate` 的
   `assertUserGovernanceActor` 会拒绝 drain，提取闭环全线失效；
2. 治理面（forget/delete/export/pin/correct/confirm）共 9 处
   `assertUserGovernanceActor`（`memory-module.js:1036,1494,1551,1570,1587,1604,1625,1656,1689`）
   全部依赖 user 身份，改了会一并打断。

**正确方向：引入读侧的作用域收窄参数，而不是改变 actorType。** 见 C-7。

---

## C-6 drain 身份契约（承接 AR-210）

```
C-6.1  drain 的 actorType 恒为 'user'，actorId 恒为 subjectUserId。
C-6.2  callerAgentId 照常传递，供 scope 过滤与 relationship 判定使用。
C-6.3  不得放宽 assertUserGovernanceActor 来让 agent 自主写入。
C-6.4  R-021 的生活事件写回若需要 agent 自主性，必须走独立治理通道
       （显式声明 + 审计），不在本阶段实现。
```

**不变量 I-10**：任何情况下 `assertUserGovernanceActor` 的判定逻辑不变。

---

## C-7 读侧作用域收窄（2a 新增，核心）

### C-7.1 契约

检索与上下文装配接受一个**可选的**作用域收窄参数：

```ts
// 请求（retrieve / context-bundles）
{
  query: string,
  purpose: Purpose,
  tokenBudget?: number,
  readScope?: {                    // 新增，可选
    agentId: string                // 视角 agent
  }
}
```

### C-7.2 语义

```
readScope 未提供（undefined）
  → 行为与今天完全一致（actorType='user' 看全部）
  → 用途：治理面、导出、数据主体自查

readScope = { agentId: 'A' }
  → relationship scope 断言：仅 relationshipAgentId === 'A' 可见
  → life scope 断言：仅 relationshipAgentId === 'A' 可见（C-8）
  → user scope 断言：不变（仍可见）
  → session scope 断言：不变
  → 用途：agent 视角的回复装配
```

### C-7.3 与 actorType 的关系

**不变量 I-11**：`readScope` 只影响**读**的可见性，
**不改变** `contextOf()` 推导出的 `actorType` / `actorId`。

**不变量 I-12**：`readScope` 不得放大可见性——它只能缩小。
实现上必须表现为**追加过滤条件**，禁止作为"额外授权"。

### C-7.4 信任边界

**不变量 I-13**：`readScope` 只允许由**服务端内部**注入
（`index.js` 从 `session.agentId` 解析）。来自 HTTP 请求体的
`readScope` 必须被忽略或拒绝——否则等于让调用者自选视角。

> 注：`agentId` 本身来自 `session.agentId`（已在 2a.3 变为必填且服务端可信），
> 所以 `readScope` 的信任来源是**会话记录**，不是请求体。

### C-7.5 落地位置

| 位置 | 改动 |
|---|---|
| `memory-module.js` `canSee` | 增加 `readScope` 判定（读取 `context.readScope`） |
| `memory-module.js` `contextOf` | 透传 `readScope`（规范化，不参与 actor 推导） |
| `memory-module.js` `retrievalDocuments` | 沿用 `canSee`，无需单独改 |
| `memory-module.js` `contextBundle` | `userProfile` / `relationshipProfile` 分区沿用现有过滤 |
| `core-v0.js` `retrieveContext` | 透传 `readScope` 到 memory port |
| `core-v0-postgres.js` `retrieveContext` | 同上（PostgreSQL 路径） |

### C-7.6 验收

```
R-1  readScope 未提供 → 与今天行为一致（回归不变）
R-2  readScope={A}   → 看不到 B 的 relationship 断言
R-3  readScope={A}   → 看得到自己的 relationship 断言
R-4  readScope={A}   → user scope 断言仍全部可见
R-5  readScope 来自请求体 → 被忽略（I-13）
R-6  readScope 不改变 actorType（I-11）
```

---

## C-8 `life` scope 契约

### C-8.1 枚举

```js
MEMORY_SCOPES = ['user', 'relationship', 'session', 'life']
```

### C-8.2 归属约束

```
life scope 必须携带 relationshipAgentId，否则 INVALID_SCOPE。
life scope 不允许携带 sessionId。
life scope 与 relationship scope 的可见性规则完全一致。
```

### C-8.3 与 relationship 的分工（本阶段只定形状）

| scope | 语义 | Bundle 分区 |
|---|---|---|
| `relationship` | 关于**这段关系**的记忆（共同经历、称呼、约定） | `relationshipProfile` |
| `life` | agent **自己的生活**（事件、心情、日常） | `agentLife`（新增分区） |

> **实施修正（2026-09-10）**：原契约把 `bundle.agentLife` 分区留给 R-021，
> 实施中发现这是错的——`contextBundle` 只把 scope 过滤进
> `userProfile` 与 `relationshipProfile` 两个分区，`life` scope 落在
> 两者之外，**记忆写进去永远读不出来**。若不补分区，"预留 life scope"
> 是个空壳。故 `agentLife` 分区随 2a 一并落地：
> `contextBundle` 分区 + token 截断循环 + `memoryBundleToRecalled` 映射。

### C-8.4 验收

```
L-1  scopeType='life' 且有 relationshipAgentId → 接受
L-2  scopeType='life' 无 relationshipAgentId → INVALID_SCOPE
L-3  readScope={A} 时 life scope 仅 A 可见
L-4  未提供 readScope 时 life scope 全部可见（治理视角）
L-5  life scope 记忆出现在 bundle.agentLife，不出现在 relationshipProfile
```

---

## C-9 `life_generation` purpose 契约

### C-9.1 白名单

```js
allowedPurposes = ['answer_user_query', 'proactive_mention', 'profile_view', 'governance', 'life_generation']
```

### C-9.2 权限映射

```js
purposePermission('life_generation') === 'retrieve'
```

**不变量 I-14**：`life_generation` **不授予** `mention` 权限。
生活事件生成不得直接触发主动提及（主动提及有独立门控，见 R-019）。

### C-9.3 可见范围

```
life_generation 与 answer_user_query 的可见范围一致，
但实现上必须由调用方显式传 readScope={agentId}。
不提供"默认全可见"的 life_generation 调用路径。
```

### C-9.4 验收

```
G-1  purpose='life_generation' → 不抛 INVALID_PURPOSE
G-2  purposePermission 返回 'retrieve'
G-3  life_generation 下 mentionable 断言不自动获得 mention 权限
```

---

## C-10 会话 ↔ agent 绑定契约

### C-10.1 应用会话

```js
session.agentId           // 必填（私聊）；群聊为 null 且用 agentIds[]
session.needsAgentBinding  // 存量迁移标记（true 时路由层拒绝）
```

### C-10.2 拒绝规则

```
私聊会话（kind !== 'group'）且 agentId 为空且 needsAgentBinding !== true
  → 创建时 400 SESSION_AGENT_UNBOUND

已存在的会话 needsAgentBinding === true
  → 聊天请求 400 SESSION_AGENT_UNBOUND（并在响应中提示需先绑定）
```

### C-10.3 群聊（本阶段不改）

群聊继续用 `agentIds[]`；**群聊的记忆写入仍用会话级 context**
（现状 `recalled: []` 的问题不在 2a 范围，登记为债务）。

### C-10.4 验收

```
B-1  创建私聊会话缺 agentId → 400 SESSION_AGENT_UNBOUND
B-2  创建私聊会话带 agentId → 201 且 session.agentId 正确
B-3  存量 needsAgentBinding 会话发消息 → 400 且 code 正确
B-4  群聊会话不受影响（向后兼容）
```

---

## C-11 callerAgentId 解析契约

### C-11.1 优先级（不变）

```
1. serviceIdentity.serviceId            （/v1 边界，生产服务身份）
2. (仅非生产) x-caller-agent-id header
3. session.agentId                      （新增，普通 chat 路径）
```

### C-11.2 失败语义

**不变量 I-15**：三条都取不到 → 抛
`MEMORY_AGENT_CONTEXT_REQUIRED`（HTTP 400），**不得回退常量**。

**不变量 I-16**：`'cochpia'` 作为字符串字面量在 `server/` 下的
context 构造路径中零出现（grep 可验）。

### C-11.3 实现约束（最容易踩坑处）

现状：`contextFromRequest`（`memory-module-runtime.js:69`）在建 context 时
**无法访问会话记录**，而 `coreV0ContextForRequest`（`index.js:192`）
是同步函数。

契约要求：
```
- 解析会话 agentId 通过**注入的 resolver** 完成：
  createMemoryModuleRuntime({ resolveAgentId })
- resolver 由 index.js 提供，签名：
    resolveAgentId(req) -> string | null
- resolver 必须是**同步**的（context 构造在同步路径上），
  数据来源为 requestContext.getStore().state.sessions
- resolver 内部不得抛错；拿不到返回 null，由 C-11.2 统一处理
```

### C-11.4 验收

```
A-1  三条优先级各自生效
A-2  三条都缺 → 400 MEMORY_AGENT_CONTEXT_REQUIRED
A-3  grep "\|\| 'cochpia'" server/ → 空
A-4  resolver 同步可用，不引入异步 context 构造
```

---

## C-12 runtimeContext section 契约（承接 03 的 C-3，收窄）

### C-12.1 本阶段范围

**只做内部结构重构，不改外部形状。**

```
buildRuntimeContext({ sections })  ← 内部实现
返回结构 = 现有扁平字段 + 新增两个：
  degraded: [{ key, code }]        // 新增
  agentPersona: {...} | null       // 新增
```

### C-12.2 内置 section

| key | 来源 | budget | required |
|---|---|---|---|
| `memory` | ContextBundle | 1800 | false |
| `personality` | `state.personality` | 200 | false |
| `agentPersona` | agent 记录（2b 前为 `session.persona`） | 400 | false |
| `profile` | `state.profile` | 150 | false |
| `history` | 消息列表 | — | false |
| `lifeTexture` | 注册为空实现，返回 null | 300 | false |

### C-12.3 不变量

**I-17**：任一非 required section 失败 → 该 section 为空 +
记入 `degraded` + 计数，**不抛错、不静默**。

**I-18**：全部 section 渲染总和不超过 tokenBudget；
超出时优先保证 `memory` 与 `agentPersona`。

### C-12.4 验收

```
S-1  单个 section 失败 → 其余正常 + degraded 有记录
S-2  输出包含原有全部扁平字段（无破坏）
S-3  agentPersona 在 2a 阶段取自 session.persona（2b 再换源）
S-4  lifeTexture 返回 null 且不报错
```

---

## 冻结清单：2a 不得做的事

1. 不得把 chat 路径的 `actorType` 改成 `'agent'`（会打断 drain 与 9 处治理断言）。
2. 不得放宽 `assertUserGovernanceActor`。
3. 不得接受来自请求体的 `readScope`。
4. 不得让 `readScope` 放大可见性。
5. 不得在 2a 实现 `bundle.agentLife` 分区（R-021 范围）。
   —— **已作废**（见 C-8.3 实施修正：分区必须随 2a 落地，否则 life scope 是空壳）
6. 不得实现 `agent-life.js` 的任何业务逻辑。
7. 不得修改 `03-l2-contracts.md` 中已冻结的 C-1.4 双写读优先级。

## 实施期契约修正汇总（2026-09-10）

| # | 修正 | 原因 |
|---|---|---|
| 1 | `agentLife` 分区提前到 2a | `life` scope 本会落在所有分区之外，写进去读不出来 |
| 2 | 常量回退从 3 处扩到 5 处 | 实施中发现 `memory-module.js:844`（createSession）与 `memory-module-extraction-worker.js:15` |
| 3 | extraction-worker `actorType` 由 `'system'` 改 `'user'` | C-6 要求；原实现与 `assertUserGovernanceActor` 不一致（潜在暗雷） |
| 4 | `createSession` 无 agentId 时抛错 | 原为 `?? 'cochpia'` 静默默认，属于同一类问题 |

## 验收总表（2a）

| ID | 断言 | 来源 |
|---|---|---|
| 2a-A1 | 私聊会话 agentId 必填 | C-10 |
| 2a-A2 | `'cochpia'` 常量零出现 | C-11 |
| 2a-A3 | callerAgentId 从 session 解析 | C-11 |
| 2a-A4 | 关系域隔离负向（readScope） | C-7 |
| 2a-A5 | 关系域正向（readScope） | C-7 |
| 2a-A6 | life scope 枚举与校验 | C-8 |
| 2a-A7 | life_generation 权限 | C-9 |
| 2a-A8 | section 独立降级 | C-12 |
| 2a-A9 | 全量回归无破坏 | — |
| 2a-A10 | drain 身份未被改变（I-10） | C-6 |

**闸门：以上 10 项全绿才可进阶段 3。**
