# 实现说明：2c §4.3 最小修复（/v1 两条读路由 readScope 注入）

日期：2026-09-12　实现：port-implementer（周济川）
契约：`09-l2-contracts-2c-readscope-e2e.md` §4.2 / §4.3（老板裁决 B）
基线：`codex/core-v0-foundation` @ `cbe4382`（工作区另含契约文件本身未提交的改动）

**性质**：按已冻结契约实现，不改契约。本文件不含契约修订。

## 1. 变更清单

| 路径 | 作用 | 类型 |
|---|---|---|
| `server/memory-module-api.js` | `createMemoryModuleRouter` 新增 `narrowRead`（默认 `false`）与 `readContext()`；只把 `readContext` 用于 `/retrieve`、`/context-bundles` 两行 | 修改 |
| `server/memory-module-runtime.js` | `router()`（进程内部署入口）传入 `narrowRead: true` | 修改 |
| `server/agent-scope-readscope-v1-routes.test.js` | R1~R4 四条路由级用例 | 新增 |

有效代码改动：1 个三元函数 + 1 个构造参数 + 1 行传参 + 2 行路由替换。

## 2. 「最小」体现在哪

- `run()` 是**全部路由共用**的包装器，**未改动**。注入写在 `run()` 里会同时作用于写路由
  （`/events`、`/memories`、`/sessions`、`/access-grants`）、治理路由（`/governance/*`）
  与全部变更类路由——那是裁决范围外的语义变更。
- `narrowRead` 为**显式 opt-in**，只由 `memory-module-runtime.js router()` 传入。
  独立服务（`services/memory-module/index.js:180`）自建 router、不传该参数，
  **文件与行为均未变动**（契约 §4.3 第 1 条判 A，保持原样）。
- `readContext` 只在 `callerAgentId` 为真**且**尚无 `readScope` 时新建对象，否则**原样返回**
  → 纯减法（I-12），不触碰 `actorType`（I-11）。
- **代价（已声明的残余）**：opt-in 意味着将来若有第三个 router 消费者，默认**不会**收窄。
  用 R1 直接驱动 `runtime.router()`（真实进程内入口）把这条接线钉住：删掉 `narrowRead: true`
  R1 即变红。若评审更偏好「默认安全」，可改为默认 `true` 并由独立服务显式 `false`——
  但那会修改独立服务文件，故**未采用，留给主理人决策**。

## 3. 自测证据

```
node --test server/agent-scope-readscope-v1-routes.test.js
  ok 1 - R1  进程内 /v1/retrieve + /v1/context-bundles 收窄到调用者（A 仍可见）
  ok 2 - R2  非读路由不被收窄（/v1/events 捕获到 callerAgentId='agent-a'、readScope=undefined）
  ok 3 - R3  独立服务接线不注入 readScope（保持 §4.3 第 1 条）
  ok 4 - R4  无 callerAgentId 时不注入
  # pass 4 / # fail 0

npm test                → 410 tests / 405 pass / 0 fail / 5 skipped
  （基线 406/401/0/5，Δ+4 tests / Δ+4 pass / Δ0 fail）

node --test --test-name-pattern="R-4" server/agent-scope-2a.test.js
  ok 1 - R-4: a read scope never hides the user's own memories   # pass 1 / fail 0
```

**反事实（自测，已回滚）**：把 `memory-module-runtime.js` 的 `narrowRead: true` 改为 `false` 后
→ R1 **变红**，R2/R3/R4 仍绿（各用例只钉自己那条线，无交叉污染）。已恢复为 `true`。
→ 证明 R1 测到的是目标行为，不是空洞绿灯。

**修复前复现（同一 router，HTTP 层）**：`/v1/retrieve` 与 `/v1/context-bundles`
在 `callerAgentId='agent-b'`、无 `readScope` 时都命中 agent A 的私聊断言；修复后两者均不命中，
且 agent A 仍命中。

## 4. 上报（不在本任务范围内，未修，交主理人转老板）

### 4.1 契约行号引用有一处不一致

§2.5 把「已知旁路」记为 `server/memory-module-api.js:55-57`——**原文第 55 行是
`router.get('/memories', ...)`**，即该区间覆盖**三条**路由；而 §4.3 的最小修复只写 `:56-57`
（两条）。两条表述的射程不一致。

### 4.2 实测：`GET /v1/memories` **同样泄漏**（第四处，裁决未覆盖）

用与 R1 相同的 seed 与进程内接线：

```
GET /v1/memories?session_id=s-a  → 200  LEAK=true   count=1
GET /v1/memories?session_id=s-b  → 200  LEAK=true   count=1   ← agent B 读到 agent A 的私聊断言
```

`memory.list` 同样经 `canSee`，user actor 下 `readScope` 缺失即整段 provenance 过滤被跳过。
按 §4.3 自订的四条判据（(iii) 无契约/测试具名声明应看全；(iv) 被实测推翻）它也应判 B。
**未修**：裁决只点名两条路由。请裁决是否纳入同一修订。

### 4.3 独立服务仍存在同一 user-actor 输入面（§4.3 第 1 条的边界）

`services/memory-module/index.js:118` 的 `x-memory-actor-type` **由请求头决定**，只把默认值设为
`'agent'`。持有 service token 的调用方发 `x-memory-actor-type: user` + `x-memory-agent-id: agent-b`
即可复现同一泄漏（实测 `LEAK=true`）。默认形状（agent actor）不泄漏，与 §4.3 第 1 条一致；
但该条判 A 的前提「结构上无 agent 身份 / 由可信调用方显式 opt-in」中的显式 opt-in 未被
契约具名声明。**未修**，交主理人转老板。

## 5. 已知边界

- 证据边界仍是 `callerAgentId → readScope`：`server/index.js:95-105 resolveAgentIdForRequest`
  在本文件里是桩（`resolveAgentId: req => sessions.find(...)`），全仓仍无覆盖。
- `agent actor + readScope` 组合未在 R1~R4 覆盖（仍由 2a 套件覆盖）。
- R3 钉的是「独立服务不注入」这一**当前判定**；若老板改判第 1 条，R3 需同步知情修改。
- 未提交、未推送。

## 6. 续做：§4.4 两项裁决（2026-09-12，同一实现者，同一工作区）

老板已就 §4.4 的两项发现裁决：**A 判 B 一并修**（走同一 `narrowRead` 门）、
**B 加固**（独立服务不接受外部指定 user actor）。本节记录实现。

### 6.1 变更清单（本轮）

| 路径 | 作用 | 类型 |
|---|---|---|
| `server/memory-module-api.js` | `GET /memories` 改走 `readContext`（第 3 条被收窄的读路由）；注释同步 §4.4.A | 修改 |
| `services/memory-module/index.js` | `actorType` 由「读请求头，默认 agent」改为**固定字面量 `'agent'`** | 修改 |
| `server/agent-scope-readscope-v1-routes.test.js` | 新增 R5 / R5b / R6a / R6b；`inProcessRuntime` 的 `resolveAgentId` 桩改为**逐字对齐** `server/index.js:95-105` 的 query 读取 | 修改 |

有效代码改动：1 行路由 + 1 行常量（+ 注释）。测试文件是本轮唯一被新增/扩写的文件。

### 6.2 B 的加固形态：**固定为 `'agent'`**（而非拒绝该头）

选固定 literal 的理由：
1. `actorType` 变为**常量**后，`actorId = actorType === 'user' ? subjectUserId : callerAgentId`
   恒取 `callerAgentId`（该头链上 `callerAgentId` 已由 `:127` 强制非空）→ 权限**只减不增**。
2. **默认形状字节不变**：原默认值本就是 `'agent'`，故「不指定该头」的既有调用零变化。
3. 与仓内既有的**不信任外部身份头**姿态一致：进程内 runtime 对 `x-memory-actor-type`
   在非 dev 下同样只是**忽略**（`memory-module-runtime.js:78-80`），并不报错；
   `core-v0-postgres-live-acceptance.js:419-439` 的伪造头负向测试同此姿态。
   「拒绝」会引入一条契约未定义的新错误语义（拒绝哪些值？仅 `user` 还是任何非 `agent`？）。
4. 结构性：任何请求形状（默认 / `agent` / `user` / 伪造值）都落为 agent actor →
   判 A 的依据从「未声明的受信前提」变为「结构上不可能」，正是 §4.4 要求的口径。

> ⚠️ **代价（真实、需老板知情）**：`scripts/memory-module-sdk-smoke.js` 主动发送
> `x-memory-actor-type: user`（`:25`），依赖 user actor 走 `hasGrant` 首行放行来读回自己刚写的
> user 域记忆。加固后该头被忽略 → 该 smoke 的 read-your-write 断开会失败。
> 实测（见 6.3）`retrieve items` 由 1 变 0。该脚本**不在 `npm test` 内**（`npm run test:memory-sdk`，
> 需活服务 + DB），故**未改动它**，按「行为变更信号」上报。

### 6.3 自测证据

```
node --test server/agent-scope-readscope-v1-routes.test.js
  ok R1 / R2 / R3 / R4 / R5 / R5b / R6a / R6b      # tests 8 / pass 8 / fail 0

npm test  → 414 tests / 409 pass / 0 fail / 5 skipped
  （本轮基线 410/405/0/5，Δ+4 tests / Δ+4 pass / Δ0 fail）

npm run check:routes  → LEGACY (none) / CLIENT CALLS NOT IN ROUTE TABLE (none)

修复前复现（同一进程内 router，HTTP 层，探针已删）：
  GET /v1/memories?sessionId=s-b  LEAK=true  caller=agent-b  readScope=null   ← A 的真实泄漏面
  GET /v1/memories?session_id=s-b LEAK=true  caller=null     readScope=null   ← 见 6.4
```

**反事实（探针在 `narrowRead` / builder 两个形态间切换，未改动仓库文件）**：

| 变异 | 结果 |
|---|---|
| A：`narrowRead=OFF`（≡ 修复前） → `narrowRead=ON` | `LEAK=true` → `LEAK=false` ⇒ R5 可检出 |
| B：builder 读头（≡ 加固前） → 固定 `'agent'` | `LEAK=true` → `LEAK=false` ⇒ R6b 可检出 |
| R6a 源码钉：`git show HEAD:services/.../index.js` → 工作区 | `readsHeader=true/fixedLiteral=false` → `false/true` ⇒ R6a 非空洞 |

**B 的附带影响实测**（SDK smoke 流，entity 同上）：
`[header]` create=ok / items=1 / readYourWrite=true　→　`[fixed]` create=ok / items=0 / readYourWrite=false。

### 6.4 本轮新发现（**已上报，未修**，不扩大范围）

**契约 §4.4.A 引用的复现 URL 与实际成因不符。** §4.4.A 写「`GET /v1/memories?session_id=s-b` →
`LEAK=true`」并归因「agent B 读到 agent A 的私聊断言」。但 `resolveAgentIdForRequest`
（`server/index.js:95-105`）**只读 `query.sessionId`（驼峰）**，**不读 `session_id`**。
实测：`?session_id=s-b` 的 `callerAgentId` 为 **null** —— 该 URL 的泄漏是
**null-caller fail-open（V-4）**，不是「B 读到 A」。真正属「B 读到 A」的是 `?sessionId=s-b`（驼峰）。

→ 故本轮 A 修复后：
- `?sessionId=s-b` 已收窄（B 不再可见，A 仍可见）——这是 R5 断言的目标行为；
- `?session_id=s-b` 与无参调用**仍泄漏**，因其解析不出 agent，**没有可收窄的 `callerAgentId`**
  （与 R4 同形）。R5b 以 characterization pin 固定该现状并注明「非修复」，
  将来若解析器补读 snake_case 会变红、强制知情更新。

此残余属两处**契约已知边界**的交叉：V-4 的 fail-open（§5 已固化）与 §4.1 声明的
「`session → callerAgentId` 链路不在本契约证据边界内、全仓无覆盖」。**未修**（修它 = 改
`resolveAgentIdForRequest` 的 query 键，属契约射程外）。

**`scripts/memory-module-sdk-smoke.js` 依赖被加固行为**：见 6.2 的 ⚠️。**未修**（按指示上报）。

### 6.5 已知边界（本轮新增）

- A 的收窄**仅**在解析出 `callerAgentId` 时生效；无 caller 的读仍 fail-open（R5b 已钉）。
- R6a 是**源码级**断言（独立服务不可 import：`pg` 触发 SIGTERM、要求 `DATABASE_URL`、
  启动 worker + 监听），与 `agent-scope-2a.test.js:246` 钉 `'cochpia'` fallback 同法。
  R6b 的行为用例跑的是**镜像**该加固 builder 的真实 router，由 R6a 把镜像绑回真文件。
- 独立服务进程本身、SDK smoke 端到端均未在本沙箱跑（需 DB + 活服务）。
- 未提交、未推送。

## 7. 续做：§4.4.B 修订 —— 改为「显式 opt-in 双重门」（方案 ③，2026-09-12）

老板改判：§4.4.B 的加固由「固定字面量 `'agent'`」**修订**为**同构于进程内 runtime 的双重门**。

### 7.1 变更清单（本轮）

| 路径 | 作用 | 类型 |
|---|---|---|
| `services/memory-module/index.js` | `actorType` 默认仍**字面量 `'agent'`**；仅当 `NODE_ENV !== 'production'` **且** `MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER === 'true'` 时读 `x-memory-actor-type`，取值须 ∈ {user,agent,system}，否则抛 400 `INVALID_ACTOR_TYPE` | 修改 |
| `server/agent-scope-readscope-v1-routes.test.js` | R6a 重写（源码钉新姿态）；R6b 改用镜像新 builder（env 关）；新增 R6c（env 开 + 非 prod 生效）、R6d（非法值 400）、R6e（production 硬封） | 修改 |

有效代码改动：`contextFromRequest` 内 1 处双层判定（约 8 行）；默认形状（env 关）**字节不变**。
测试文件是本轮唯一被扩写的文件。**未改** smoke（`scripts/memory-module-sdk-smoke.js`）。

### 7.2 env 命名与理由

`MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER`。沿用 `MEMORY_ALLOW_UNTRUSTED_*` 家族；**不复用**
`MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS`（后者管 agent id 头，**威胁面不同**：那个管身份，这个管 actor 类型）。
用单数 `HEADER`，因其只控一个 `x-memory-actor-type` 头。

### 7.3 「非法 actorType 注入」核实（deliverable 2）

- 独立服务 `contextFromRequest` **自身原本没有** actorType 取值校验。
- **但下游有**：`memory-module.js:239-243` 的 `contextOf()` 对**每一个**进入模块的 context 都执行
  `assertEnum(actorType, new Set(['user','agent','system']), 'INVALID_ACTOR_TYPE')`，且**所有**模块方法
  都先经 `contextOf`。故即使放宽为「读头」，非法值（如 `forged-actor`）**不会**产生可用的非法 actorType ——
  请求在下游被 400 `INVALID_ACTOR_TYPE` 拒绝（无泄漏）。
- **处置**：仍在**边界处**补本地枚举校验（防御纵深，且使 R6a 能以源码钉住）。二者行为等价（均 400）。

### 7.4 自测证据

```
node --test server/agent-scope-readscope-v1-routes.test.js
  ok R1 R2 R3 R4 R5 R5b R6a R6b R6c R6d R6e      # tests 11 / pass 11 / fail 0

npm test → 417 tests / 412 pass / 0 fail / 5 skipped
  （本轮基线 414/409/0/5，Δ+3 tests / Δ+3 pass / Δ0 fail —— 新增 R6c/R6d/R6e）
```

**反事实（临时改 `services/.../index.js` 两形态，均已还原）**：

| 变异 | 结果 |
|---|---|
| A：去掉双重门（回到无条件读头） | **R6a 变红**；R6b..e 仍绿（它们跑测试侧镜像，不受源改动影响） |
| B：保留门、删本地枚举校验 | **R6a 变红**（枚举 token 缺失）；R6d 仍绿（镜像自带校验） |

→ R6a 非空洞；但 R6b..e 是**镜像行为**用例，自身不检测源变异，靠 R6a 绑定（已知局限，见 7.6）。

### 7.5 续做 follow-up（**未改，上报**）

- **smoke 需设的 env**：`scripts/memory-module-sdk-smoke.js:25` 要恢复 read-your-write，
  需在服务进程设 `MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER=true`（且 `NODE_ENV !== 'production'`）。
  **未改该脚本**（按指示）。
- **契约 §4.4.B 已过期**：`09-...md` §4.4.B 仍写旧裁决「`actorType` 不再由请求头决定」，
  与本轮方案 ③ 矛盾 → 属契约 owner（沈之衡）职责，**未改，上报**。
- `services/memory-module/README.md` 未记录该 env → 建议补一行（**未改**，避免扩大范围）。

### 7.6 已知边界（本轮新增）

- 独立服务进程**未**在本沙箱跑（`pg` → SIGTERM）；R6b..e 为镜像行为、R6a 源码钉绑定，二者配合覆盖。
- 双重门第一条件 `NODE_ENV !== 'production'` 依赖部署方正确设置 `NODE_ENV` —— 与
  `memory-module-runtime.js:78` **同源假设**；若生产误设 `NODE_ENV`，门会打开。属**配置完整性假设**，非代码缺陷。
- 未提交、未推送。
