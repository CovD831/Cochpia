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
  → ⚠️ **此条引用有误，见 §4.2。当时写下的「P-3 刻意行为」是 claim drift，
  已由后续勘察推翻；保留原文以存历史。**
- `currentStates`、`episodes.memberEventIds` 的 provenance 归属
- 多来源断言的保守隐藏（见 2b 契约 §7 第 2 条）
- 历史回填（已于 2026-09-12 实测关闭）

## 4.2 更正：§4 中「P-3 刻意行为」属错误引用（2026-09-12，勘察后）

**错误内容**：§4 的 Scope-out 把 `/v1/*`（`/v1/retrieve`、`/v1/context-bundles`）与 `/mcp` breath
的未收窄读统一标为「P-3 刻意行为」。

**为何是错的**：P-3 的原文（`08-l2-contracts-2b-provenance.md` §5）**只声明 chat 路径**
「无 `readScope` ⇒ 不过滤」，**从未点名** `/v1/retrieve` 或 `/v1/context-bundles`。
把「chat 路径的表述」扩大到两条**通用读 API** 上，是**扩大引用**——即
`references/doc-gates.md`「Claim drift」节所描述的形态：一条声明被复述到了它并未覆盖的射程上。

**正确表述**：这三条路径当时**从未被判定**，不是「已判定为刻意」。

## 4.3 旁路读路径判定（2026-09-12，boundary-architect 勘察 + 实测）

**关键更正**：`/v1` **有两个部署**，判定随之分裂：

| # | 路径 | 部署 / actor | 判定 | 依据 |
|---|---|---|---|---|
| 1 | `/v1/retrieve`、`/v1/context-bundles` | **独立服务**（`services/memory-module/index.js:110`），`actorType` 默认 **`agent`** | **A — 设计如此** | 默认 agent actor 下 `hasGrant` 挡住；实测不泄漏。须写入契约 |
| 2 | **同上两条路由** | **进程内**（`server/index.js:187`，Dockerfile 唯一 CMD），`actorType` 默认 **`user`** | **B — 遗漏（老板 2026-09-12 裁决）** | 见下 |
| 3 | `/mcp` breath | 进程内（`server/index.js:1040` → `memory-module-runtime.js:188`），`callerAgentId` 恒 null | **A — 设计如此，但须带守卫** | 等同「用户自己全量视图」；**前提**：外部不得塞 `body.sessionId` |

**实测（4 种真实形状，seed 一条 agent-a 私聊产生的 user 域断言）**：

| 形状 | 结果 |
|---|---|
| 进程内 `/v1`（user actor, `callerAgentId=agent-b`, 无 `readScope`） | **命中 = 泄漏** |
| `/mcp` breath（user actor, `callerAgentId=null`） | 命中（＝用户自己全量视图，合 A） |
| 独立服务默认（agent actor） | 0（`hasGrant` 挡） |
| 对照 chat + `readScope` | 0（门禁生效） |

**三条路径都经 `canSee`，不绕门禁** → 注入 `readScope` 有实义。

### 第 2 条的裁决与修复方案（老板裁决 B）

**判据（boundary-architect 冻结，判 A 须四条同时成立）**：
(i) 服务对象是数据主体/治理/导出/兼容视图，非单 agent 回复装配；
(ii) 结构上无 agent 身份，或有但由**可信**调用方显式 opt-in；
(iii) 有契约/测试**具名**声明应看全；
(iv) 面对任何正常调用输入都不暴露他 agent 材料。

第 2 条 **(iii) 不成立**（无任何契约/测试具名声明它应看全）、且 (iv) 被实测推翻 → 判 B。

**最小修复**：`server/memory-module-api.js:56-57` 的处理逻辑中，
当 `context.callerAgentId` 为真且尚无 `readScope` 时补注入
`{ ...context, readScope: { agentId: context.callerAgentId } }`。

> ⚠️ **本行射程有误（2026-09-12 实现时发现）**：原文写 `:56-57`，但 §2.5 引用的是
> `:55-57`——**同一文档内两处射程不一致，漏了 `:55`**。`:55` 是 `GET /memories`
> （`memory.list`），**同为读路由且实测泄漏**。已按 §4.4 补正。保留原文以存历史。

**不会破坏 R-4**：`agent-scope-2a.test.js` 的 R-4 seed 走 `hold()` 无来源标记，
C-16「未标记不阻碍」保证 user 域仍全可见（`08-...2b-provenance.md` §6 已断言）；
注入只做减法（I-19）。

**代价**：改 `/v1` 对外语义 → **须契约修订 + 发布负责人批准**（本 §4.3 即该修订）。
**影响面低**：仓内**无任何代码**调用 `/v1`（`createMemoryModuleClient` 仅见于 smoke 与自身测试），
主链路 `/api/chat/turns` 已有 `readScope` 覆盖。

**`unknown` 且可能改判**：
1. 独立服务（第 1 条）生产是否真被激活——Dockerfile 仅 `CMD node server/index.js`，
   `02-l1-target.md:21` 称「未被 R-004 激活」。若不激活，第 1 条无生产面。
2. 是否真有人向 `/mcp` 塞 `body.sessionId`（这决定第 3 条的守卫是否必要）。
3. `server/index.js:95-105 resolveAgentIdForRequest` 全仓无覆盖（§4.1 已录），其行为变化会改判第 2 条。

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

## 4.4 实现期发现：第四处泄漏点 + 独立服务的 user-actor 输入面（2026-09-12）

实现 §4.3 修复时由 port-implementer 上报两项**超出当次裁决范围**的发现。
**均未擅自扩大修复范围**，转为上报——处置正确。

### A. `GET /v1/memories` 同为读路由且泄漏（裁决未覆盖）

**成因是契约自身的射程错误**：§2.5 引用 `memory-module-api.js:55-57`（覆盖三条路由），
而 §4.3 的修复方案只写 `:56-57` —— **同一文档内两处射程不一致，漏掉 `:55`**。
`:55` 是 `GET /memories`（`memory.list`），结构上与 `:56`/`:57` 同类，**同为读路由**。

**实测**（同一 seed 与接线）：`GET /v1/memories?session_id=s-b` → 200、`LEAK=true`。
按 §4.3 自订判据 (iii)（无契约/测试具名声明应看全）与 (iv)（实测暴露他 agent 材料），
它也应为 **B（遗漏）**。

> ⚠️ **上述复现 URL 归因有误（2026-09-12 实现期由 port-implementer 更正）**：
> `server/index.js:98` 的 `resolveAgentIdForRequest` 对 **query 只认驼峰 `sessionId`**：
> `req?.body?.sessionId ?? req?.body?.session_id ?? req?.query?.sessionId ?? null`。
> 因此 `?session_id=s-b`（下划线）**解析不出 `callerAgentId`**，它触发的是
> **null-caller fail-open（即 V-4）**，**不是「B 读到 A」**。
> 真正属于 `GET /v1/memories` 缺陷的复现是 **`?sessionId=s-b`（驼峰）**。
> **结论方向未变**（该路由仍应修，且已修），但**机理标注错了**。
> 这是同一份契约内第三次「引用/复现不精确」——前两次见 §4.2 与 §4.3 的更正注。

**状态：已裁决（老板 2026-09-12）—— 判 B，与另两条同类路由**一并修****。
修复方式与其两条同类路由一致（同一 `narrowRead` 门）。

### B. 独立服务仍有同一 user-actor 输入面

`services/memory-module/index.js:110`：

```js
const actorType = String(req.get('x-memory-actor-type') || 'agent').trim();
```

`actorType` **由请求头决定**，仅**默认值**为 `agent`。持 service token 者发送
`x-memory-actor-type: user` + `x-memory-agent-id: agent-b` 即复现同一泄漏（实测 `LEAK=true`）。

**与 §4.3 第 1 条的关系**：默认形状确实不泄漏（这是判 A 的依据），但**该依据有前提**——
调用方受信且不会显式请求 user actor。**此前提未被任何契约或测试声明过**（判据 (iii) 存疑）。

**状态：已裁决（老板 2026-09-12）—— 加固：独立服务不接受外部指定 user actor。**

> ⚠️ **本节在被裁决后又被修订过一次，见 §4.4.B-2**。原文保留以存历史；
> 其「固定为 `'agent'`」的表述**已不是最终实现**。

**加固要求**：`services/memory-module/index.js:110` 的 `actorType` **不再由请求头决定**；
外部无法通过 `x-memory-actor-type: user` 把服务降级为 user actor。
实现方式由 port-implementer 定（拒绝该头、或固定为 `agent`），但**必须保证：
默认形状与显式指定形状都不泄漏**——即原判 A 的依据从「未声明的受信前提」变为
「结构上不可能」。

**原判 A 的依据就此修正**：不再是「默认不泄漏」（那是未声明前提），而是
「外部无法构造出 user actor」。加固后 (iii)+(iv) 两条判据均成立。

### 4.4.B-2 修订：加固改为「显式 opt-in 双重门」（老板 2026-09-12 第二次裁决）

**为何修订**：第一版加固（固定为字面量 `'agent'`）落地后，实测发现它**断开了一个既有脚本**：
`scripts/memory-module-sdk-smoke.js:25` 主动发送 `x-memory-actor-type: 'user'` 以实现
read-your-write。探针实测澄清：

| 场景 | read-your-write |
|---|---|
| agent actor，**无** scopeGrant | ❌ 读不回 |
| agent actor，**有** scopeGrant（含 `retrieve` permission） | ✅ 能读回 |
| user actor（smoke 当前做法） | ✅ 能读回，**且无需任何 grant** |

→ 「指定 user actor」是**被实际使用的便捷路径**，不是理论可能。

**最终实现（`services/memory-module/index.js`）**：

```js
const allowUntrustedActorHeader =
  process.env.NODE_ENV !== 'production'
  && process.env.MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER === 'true';
let actorType = 'agent';
if (allowUntrustedActorHeader) {
  const requested = String(req.get('x-memory-actor-type') || '').trim();
  if (requested) {
    if (!['user','agent','system'].includes(requested)) throw new MemoryModuleError('INVALID_ACTOR_TYPE', ...);
    actorType = requested;
  }
}
```

**性质变化**：不再是「不接受外部指定」（那会断开 smoke），而是
「**外部无法单凭请求头触发**」——需要**部署方显式设置 env**（且非 production）。
这与主仓既有姿态同构（`server/memory-module-runtime.js:78` 的
`MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS` 双重门）。

**env 命名**：`MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER`。**不复用** `..._AGENT_HEADERS`
（那个管 agent id 头，威胁面不同）。

**安全核实（两条）**：
1. **默认形状字节不变**：env 未开或 production → `actorType = 'agent'`，不读头。
2. **非法值不可注入**：边界处补了枚举校验；且下游 `server/memory-module.js:243` 的
   `contextOf()` 对每个进入模块的 context 都执行 `assertEnum(..., ['user','agent','system'])`
   → 防御纵深，非法值两条路都是 400。

**残余假设（已声明，非代码绕过）**：双重门第一条件依赖部署方正确设置 `NODE_ENV`
（与 `runtime.js:78` **同源假设**）。若生产误设 `NODE_ENV≠production` **且** env=true，
门才会打开。属**配置完整性假设**。

**smoke 脚本**：未改（仓外门禁）。重跑需在服务进程设
`MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER=true` 且 `NODE_ENV !== 'production'`。

**测试**：R6a（源码钉双重门 + 枚举校验）、R6b（默认形状，头不生效）、
R6c（env 开+非 prod，头生效）、R6d（env 开+非法值 → 400）、
R6e（production + env=true → 仍 agent）。反事实：去掉门或去掉枚举 → R6a 变红。

## 4.5 独立审计结论（2026-09-12，evidence-auditor）

**反事实核验：11 组定向变异，逐条用例均有变异可使其红 → 无空洞用例。**
关键确认：删除 `GET /v1/memories` 那一行 `readContext` → **仅 R5 变红**（说明该路由的
修复确实被独立验证到，而非搭了另两条的便车）；把注入移进 `run()` → 仅 R2 变红
（证明写路由/治理路由确实未被波及）。

**审计发现一处证据缺口（实现者未自报，比其自报的局限更严重）**：

> **R3 是裸镜像，完全无源级绑定。** 实测（M8）：把**真实**的
> `services/memory-module/index.js` 接线改成 `narrowRead: true`——这是对 §4.3 第 1 条
> 的**真实回归**——**整个文件 11/11 仍全绿**。即「独立服务接线不变」这条证据**不成立**。

**处置：已补 R3b**（源码级钉，仿 R6a 用 `readFile` 读真实源）：
断言独立服务**不含** `narrowRead`（既不传 `true` 也不出现该标识符），
且仍读 `x-memory-agent-id`、仍经 `createMemoryModuleRouter` 构建。
**反事实已验证**：在 `/tmp` 副本上注入 `narrowRead: true` → **R3b 精确变红
（12/12 → 11 pass / 1 fail），其余 11 条仍绿**，无交叉污染。项目文件未被变异影响。

**审计接受的三项残余（已声明，非阻断）**：
1. **R6d 的 status/code 断言被下游影子覆盖**：本地枚举校验删掉后，下游
   `memory-module.js:243` 的 `assertEnum` 仍以**完全相同的 400 `INVALID_ACTOR_TYPE`** 拒绝
   → 兜得住（防御纵深成立），但该用例的信号比表面弱。
2. **`narrowRead` 默认 `false` 的第三消费者隐患**：已确认另有两个消费者
   （`services/memory-module/index.js:211`、`server/memory-module-api.test.js:14`）吃默认值。
   未来新增的第三个 router 消费者会**自动落入不收窄**。已在 `api.js` 注释与 impl note 声明，
   **但无守卫**。审计核实「默认 true + 独立服务显式 false」的代价**大于**实现者所述
   （该方案下 R3/R6c 也会变红，并非"只改一个文件"）→ **原取舍成立**，记为已知边界。
3. **R5b 是 characterization pin**：`?session_id=`（下划线）解析不出 callerAgentId，
   触发的是 null-caller fail-open（V-4），非「B 读到 A」；生产可达性未验。

**审计结论**：测试**可信**；但 §4.3 第 1 条的证据在补 R3b 前**不成立**，现已补齐。

### 影响评估（供裁决参考）

- 两条发现均**未在仓内产生实际调用方**：`createMemoryModuleClient` 仅见于 smoke 与自身测试；
  独立服务的生产激活状态本身仍是 §4.3 的 `unknown` 之一（`02-l1-target.md:21`）。
- 若一并修复：`GET /memories` 属同一 `narrowRead` 门，改动约 1 行；
  独立服务需决定「拒绝 user actor」还是「要求显式 opt-in」，属**语义决策**，非纯实现。
