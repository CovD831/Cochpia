# L2 契约 2c：readScope 端到端注入验证

日期：2026-09-12　基线：`codex/core-v0-foundation` @ `4c67144`
前置：`07-l2-contracts-2a.md`（C-7 读侧作用域收窄）、`08-l2-contracts-2b-provenance.md`（C-13~C-16 来源溯源）
勘察人：boundary-architect（沈之衡）
性质：**证据缺口补验**，不是新功能。R-004 闸门已含「记忆按来源隔离」的表述，但该表述
在真实链路上**从未被端到端证明**。

## 1. 问题（实测，不是推演）

2a / 2b 的既有测试全部**手工传入或省略 `readScope`**：

- `server/agent-provenance.test.js:36-38` 的 `userCtx(callerAgentId, readScope)` helper
- `scripts/probe-agent-scope-leak.mjs:41-42`
- `server/chat-memory-loop.test.js:133`（自建 mock）

因此：

> **已验证**：给定一个正确的 `readScope`，`canSee` 的过滤行为正确。
> **未验证**：生产路径上从 `context.callerAgentId` **推导**出 `readScope` 的那几行代码，
> 在真实上下文构造下是否真的得到非空且正确的 `agentId`。

这正是「单元测试全绿 ≠ 能跑」（AR-212 / AR-213 同类）。缺口由 evidence-auditor 在独立
复核时发现，非主理人识别。

## 2. 影响面（boundary-architect 勘察结论，已逐条核实）

### 2.1 注入点实为**三处**（文档与先前任务描述均漏列第三处）

| # | 位置 | 代码 | 旧文档 |
|---|---|---|---|
| 1 | `server/chat-memory.js:100-101` | `const readScope = context?.callerAgentId ? { agentId: context.callerAgentId } : undefined;` | 已列 |
| 2 | `server/core-v0-postgres.js:646` | `const scopedContext = context.callerAgentId ? { ...readContext, readScope: { agentId: context.callerAgentId } } : readContext;` | 已列 |
| 3 | **`server/core-v0.js:363-364`** | `const readScope = baseContext.callerAgentId ? { agentId: baseContext.callerAgentId } : undefined;` | **漏列** |

第 3 处属 `createInProcessMemoryPort`（local adapter，`server/index.js:263`）。
按 `server/index.js:249` 的判定，它仅在**非 postgres 且非 production** 时命中，**但 dev 下即生效**。

> **注意**：一处关于「两处 vs 三处」的计数声明已经漂移过一次。这正是
> `references/doc-gates.md`「Claim drift」节所描述的形态——**计数是声明，不是装饰**。

### 2.2 `callerAgentId` 的构造链（`observed`）

`server/memory-module-runtime.js:89-92`，三级优先级：

```
serviceIdentity.serviceId
  > dev header (x-caller-agent-id | x-agent-id)
    — 仅当 NODE_ENV !== 'production' 且 MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS=true (:86-88)
  > resolveAgentId(req)  → server/index.js:95-105 resolveAgentIdForRequest（同步、不抛、取 session.agentId）
```

经 `server/index.js:110` 注入。**三处注入点的 context 均过它。**
门：`chat && sessionHint && 无 agent → 抛 400`（`server/index.js:104-109`）。

### 2.3 context 同源

`contextFromRequest(req, { chat: true })` 是共同来源：
- chat-memory ← `runtime.chatForRequest()`（`memory-module-runtime.js:259`）← `server/index.js:209/874`
- core-v0-postgres ← `server/index.js:212-218` → `createCoreV0ProductionAdapter`（`:303/359`）

`chat-memory.js` 用 `?.` 而 `core-v0-postgres.js` 不用，**不构成行为分叉**（`inferred`）：
前者的 context 在 `:60` 已被强制非空，后者在 `:515` 有 `requireContext` 校验，
两者语义等价（`callerAgentId` 为真值才注入，否则都不注入）。

### 2.4 fail-open 行为（**本轮最重要的发现**）

`server/memory-module.js:406`：

```js
if (context.readScope) {
  const sources = sourceAgentIdsForAssertion(state, assertion);
  if (sources.some(agentId => agentId && agentId !== context.readScope.agentId)) return false;
}
```

`readScope` 缺失（`normalizeReadScope` 在 `:230-237` 返回 null）→ **整段过滤被跳过 → 静默不过滤**。

实测（`/tmp`，未落盘）：

```
A_sees_own              = true
B_sees_A_private        = false   ← 当前守住
nullCaller_sees_A_private = true  ← fail-open 确认
（去掉 readScope 后 B_sees_A_private = true）
```

### 2.5 已知旁路（无 `readScope`）

带 `callerAgentId` 但**不注入 `readScope`**：

- `/v1/retrieve`、`/v1/context-bundles`（`server/memory-module-api.js:55-57`）
- `/mcp` 的 breath（`server/index.js:1040` → `memory-module-runtime.js:188`）

`currentStates`（`memory-module.js:1228`）对 user actor 不做 provenance 过滤。

## 3. 验证判据（冻结）

| ID | 命题 | 输入 / 上下文 | 通过条件 | 失败条件 | 停止条件 | 证据位置 |
|---|---|---|---|---|---|---|
| **V-1** | `chat-memory.js:100` 路径注入的 `readScope.agentId` = 各自 `session.agentId`（非空、未串位） | 两个 agent 经 `chatForRequest` 的真实 context | 捕获 `contextBundleAsync` 实参，`readScope.agentId` 分别为 `agent-a` / `agent-b` | `undefined` 或串位 | 捕获到实参即止 | `chat-memory.js:100` |
| **V-2** | `core-v0-postgres.js:646` 同上 | 经 `port.retrieveContext` | `scopedContext.readScope.agentId` = `callerAgentId` | 缺失或错误 | 拿到 `scopedContext` 即止 | `:646` |
| **V-3** | **端到端**：真实链路（非手工 `readScope`）下，agent B 检索不到 agent A 私聊产生的断言 | 三注入点各一例：A 私聊 → candidate → user promote；B 走对应 adapter/port 检索 | B 的 bundle 无该断言；A 有 | B 命中 | 三路径各 1 例 | 三注入点 |
| **V-4** | `callerAgentId` 缺失时不静默放行 | chat 且无 sessionHint（不触发 400） | **显式判定并固化当前 fail-open 行为**，由 e2e 断言当前语义 | 未记录 / 未断言 | 行为被固定即止 | `:100`；`memory-module.js:406` |
| **V-5** | **反事实**：任一注入行改为返回 `undefined` → V-3 必须**失败** | V-3 + 变异 | 变异后 V-3 变红 | 变异后仍绿 = 用例测不到目标行为 | 变异 → 跑 → 回滚 | 同 V-3 |
| **V-6** | `core-v0.js:363` 第三处注入同等覆盖 | 同 V-1 / V-3 | 同 V-1 / V-3 | 同 | 同 | `core-v0.js:363` |
| **V-7** | 旁路（`/v1/*`、`/mcp` breath）无 `readScope` 时的放行是**已知**而非默认安全 | 真实路由 | 显式记录「无 `readScope` ⇒ 不过滤」为已知放行 | 默认其安全 | 归 Scope-out | `memory-module-api.js:55-57`；`index.js:1040` |

**必做**：V-1 / V-2 / V-3。
**门**：V-4（fail-open 固化）、V-5（反事实）。
**覆盖第三注入点**：V-6。
**显式排除**：V-7。

## 4. 判据下限（本轮不验）

**排除**：
- 需 postgres 真库的 acceptance（沙箱 `import('pg')` 触发 SIGTERM）
- 跨进程 memory-module 服务
- 双机场景
- loopback 路由（改用 `npm run check:routes`）

**Scope-out（明确不属本轮）**：
- `/v1/*` 与 `/mcp` 治理/兼容视图的未收窄读（P-3 刻意行为）
- `currentStates`、`episodes.memberEventIds` 的 provenance 归属
- 多来源断言的保守隐藏（见 2b 契约 §7 第 2 条）
- 历史回填（已于 2026-09-12 实测关闭）

**`unknown` 且可能改变结论**：
1. `core-v0.js:363` 是否算「生产」——dev 下即生效，语义上是否需与 postgres 路径同等对待
2. `/mcp` 的 `callerAgentId` 常为 null（无 sessionId），该旁路能否真构造「另一 agent 读到」待定
3. core-v0 route 在**有** sessionId 时先被 `requiresAgent` 拦住，**无** sessionId 时静默放行——直接决定 V-4 的触发面

## 4.1 验证执行结果与审计结论（2026-09-12 落盘）

**实现**：`server/agent-scope-readscope-injection.test.js`（唯一新增文件，**无生产代码改动**）。
7 test 全过；全量 `npm test` = **406 tests / 401 pass / 0 fail / 5 skipped**（基线 399/394/0/5，Δ+7 无回归）。

**V-5 反事实结果（evidence-auditor 执行，`/tmp` 副本，6 个定向变异）**：

| 变异 | 变红 |
|---|---|
| `chat-memory.js:100` → `undefined` / → `{agentId:'wrong-agent'}` | V-1, V-3a |
| `core-v0.js:363` → `undefined` / → `wrong-agent` | V-3b, V-6 |
| `core-v0-postgres.js:646` → 原样传 / → `wrong-agent` | V-2, V-3c |

**无任何变异后仍全绿**；每个 V-3 变体只随自己那行变红，**无交叉污染** → 三条注入线各自独立被检出。
`COUNTERFACTUAL: ESTABLISHED`。项目文件未被改动（hash 前后一致）。

**审计确认**：
- `core-v0-postgres.js` **确不 import pg**（仅 `store.js` 才 import）→ V-2 / V-3c 跑的是真代码，非桩。
- 生产 chat 路径解析为 `actorType='user'`（`memory-module-runtime.js:80`，service identity 才成 'agent'），
  与测试一致。user actor 下 `hasGrant` 首行即放行，**readScope 是唯一收窄手段**——正是被测场景。
- V-1 / V-2 / V-6 断言的是捕获实参的**值**（= 请求 agent、两值不等、非 undefined），
  变异能让其变红 → 验证的是「推导正确」而非「函数被调用过」，**无空洞用例**。

**审计指出的两处缺口（已收口，但机制未变）**：

1. **上游漏覆盖（真实缺口，未在本轮补）**：测试中的
   `resolveAgentId: req => req.sessionAgentId` 是**桩**，替代 `server/index.js:95-105
   resolveAgentIdForRequest`。该函数在契约 §2.2 被列为构造链一环，但**全仓无任何测试覆盖**；
   它若回归，本文件仍全绿。→ **本契约的证据边界是 `callerAgentId → readScope`，
   不含 `session → callerAgentId`。** 已在测试文件头 §"WHERE END-TO-END STOPS" 显式声明。
2. **V-4 是 characterization pin，不是正确性确认**：它断言 fail-open 的**当前行为**
   （`readScope === undefined` 且可见），原测试名 "does not silently pass" 与行为相反，
   **已改名并加风险注释**。钉住的价值：将来若改 fail-closed 会变红，强制知情变更。
   另：该行为仅在 guard 的 sessionHint 缺失时可达（主路由带 sessionId 时先 400），
   **在主管线是否可达本轮未验**。

## 5. 待办与后果

- 若 V-1~V-6 全过：R-004 §7 的表述**获得端到端证据支撑**，可将「未端到端实测」的保留项移除。
- **若任一失败**：`promotion-statement.md` §7/§8 需要**再更正一版**——这属于可能推翻已宣布结论的动作，
  **须回报老板**。
- `08-l2-contracts-2b-provenance.md` §7 第 5 条（「chat 路径未端到端实测」）在本契约验证完成后应更新。
