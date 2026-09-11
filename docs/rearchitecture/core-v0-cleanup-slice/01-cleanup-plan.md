# R-020 执行计划：四阶段重构

> **修订版**（经 `05-adversarial-review.md` 对抗性审查，AR-201 ~ AR-209）。
> 修订点见每节的「审查修订」标注。

## 总览

```
阶段 1  可观测性 + 不变量       ← 半天，纯基础设施，与链路无关
   ↓
阶段 2a agent 身份收口（R-021 硬前置）
   ↓
阶段 2b agent 独立成表 + prompt 接入（可延后同 R-021）
   ↓
阶段 3  单链路收口（turns 补流式 → 切前端 → 删 legacy，无兼容窗口）
   ↓
阶段 4  清理（含原作者模块处置）
```

依赖关系（修订后）：
- 阶段 1 **不依赖任何链路**（1.2/1.3/1.4 是纯基础设施）。
- 阶段 2a 依赖 1.3 的测试骨架。
- 阶段 2b 可与 R-021 同期，非硬前置。
- 阶段 3 依赖 2a（否则新链路无 agent 身份）。
- 阶段 4 依赖 3（否则不知道哪些端点还被兼容路径使用）。

**审查修订（AR-201）**：原计划把"修 legacy sessionId"列为阶段 1 的
第一步——取消。理由：AR-203 决定直接删除 legacy，修它等于白干。

**审查修订（AR-202）**：原阶段 2 拆为 2a/2b。`callerAgentId` 解析与
三处预留接口是 R-021 真前置（2a）；agents 独立成表可延后（2b）。

**每阶段独立验收、独立回滚。前阶段未过闸，不进下一阶段。**

---

## 阶段 1：可观测性 + 不变量

### 目标

让"记忆检索"这条路**失败时立刻可见**，并建立"记忆闭环"的自动化断言。
**本阶段不修任何链路代码**（修订后），只加基础设施。

### 任务

**1.0 turns 本地可跑脚本（新增，必须先做）**

现状：`CORE_V0_ENABLED` 默认 false，前端零调用 turns，local adapter 用
mock 模型。**没有任何脚本能本地起 turns 跑一轮**。

新增 `scripts/turns-local-smoke.js`：起 local adapter（mock 模型）、
跑一轮 turn、输出 JSON。这是 1.3 的前置——因为闭环断言的目标链路是
turns（最终形态），不是 legacy。

**1.2 删除静默降级**

`index.js:891` 与 `core-v0.js:775` 的 catch 必须：
- 保留降级行为（对话不阻塞，这是正确的产品决策）；
- **在返回值里带结构化标记**：`memoryStatus: 'degraded'` +
  `degradedReason: <code>`；
- 写 `observability` 计数器 `memory_degraded_total`。

**1.3 记忆闭环端到端断言（基座底线）**

现状：`core-v0-memory-pipeline.test.js` 覆盖 turn + drain + 检索，
但**没有任何测试断言"说过一件事，下一次能检索到"这个用户可见语义**。

新增 `server/chat-memory-loop.test.js`（目标链路 = turns）：
```
1. 建会话（绑定 agentId，阶段 2a 前可先用占位）
2. turn 1：用户说"我在学尤克里里"
3. drain 提取（确定性 extractor）
4. turn 2：用户问"我最近在学什么"
5. 断言：turn 2 的 recalled 非空，且包含尤克里里相关条目
```
另加负向断言：未 drain 前 turn 2 的 recalled 为空（防假绿）。

**1.4 冒烟脚本**

`scripts/chat-memory-smoke.js`：复用 `scripts/memory-loop-proof.js` 形态，
输出 `artifacts/chat-memory-smoke.json`。

### 闸门

- [ ] 1.0 turns 本地脚本可用（一轮 turn 跑通）
- [ ] 1.3 端到端测试通过，负向断言也通过
- [ ] 1.2 降级标记测试通过 + 指标可见
- [ ] `npm test` 全绿，无回归

### 回滚

纯新增（测试 + 脚本 + 计数器），无既有行为变更。revert 即回滚。

---

## 阶段 2a：agent 身份收口（R-021 硬前置）

> **审查修订（AR-202）**：本节是原阶段 2 拆出的**真前置部分**。
> 理由：`life` scope 的可见性判据是
> `relationshipAgentId === context.callerAgentId`，而 `callerAgentId`
> 现在是常量 `'cochpia'` —— 不修则**所有 agent 的关系域/生活域记忆
> 是同一份**，R-021 在数据层就是假的。

### 目标

`callerAgentId` 从会话解析，删除所有常量回退。三处 R-021 预留接口落地。

### 任务

**2a.1 会话解析提前到 context 构造之前**

现状：`index.js:139-163` 的请求中间件只注入 user + state，
`memoryRuntime.contextFromRequest`（`memory-module-runtime.js:69`）
在建 context 时拿不到 session。

方案：在 `contextFromRequest` 内注入一个 `resolveAgentId` 回调，
由 index.js 提供（它能看到 `req.body.sessionId` + `state.sessions`）。
```js
// memory-module-runtime.js
createMemoryModuleRuntime({ getState, persistState, getUser, resolveAgentId })
// contextFromRequest 内
const callerAgentId = serviceIdentity?.serviceId
  || (allowDevelopmentAgentHeaders ? req.get('x-caller-agent-id') : null)
  || resolveAgentId?.(req) || null;
if (!callerAgentId) throw new MemoryModuleError('MEMORY_AGENT_CONTEXT_REQUIRED', ...);
```

**2a.2 删除三处常量回退**

- `memory-module-runtime.js:75`
- `core-v0.js:298`
- `core-v0-postgres.js:578`

验收：`grep -rn "|| 'cochpia'" server/` 结果为空。

**2a.3 session.agentId 必填**

- `POST /api/sessions` 增加 `agentId`；
- 私聊会话缺失 → 400 `SESSION_AGENT_UNBOUND`；
- 存量会话：agents 表非空则绑首个；为空则标记 `needsAgentBinding`。

**2a.4 三处 R-021 预留接口**（形状定死，不实现业务）

- `MEMORY_SCOPES` 加 `life` + `canSee` 规则（`03-l2-contracts.md` C-4.1）
- `purposePermission` 加 `life_generation` → `'retrieve'`（C-4.2）
- `buildRuntimeContext` section 化（内部实现，输出保持扁平 + 兼容）（C-3）

**2a.5 关系域隔离负向测试**

```
agent A / agent B 各与同一用户有关系记忆
断言：以 A 检索看不到 B 的；以 A 检索能看到自己的 + user scope 的
```

### 闸门

- [ ] `'cochpia'` 常量回退零出现（grep 验证）
- [ ] session.agentId 必填生效
- [ ] 隔离负向测试通过
- [ ] `life` scope / `life_generation` / section 化契约测试通过
- [ ] `npm test` 全绿

### 回滚

纯代码 revert。无 schema 变更（agents 表在 2b）。
回滚后 agent 身份失效但系统可运行。

---

## 阶段 2b：agent 独立成表 + prompt 接入（可延后）

> **审查修订（AR-202）**：本节**不是** R-021 的硬前置，可与 R-021 同期。
> 但若延后，R-021 的 `life_state` 会先落 `state.agents[]` JSONB，
> 必须在 R-021 计划里登记"迁表"为验收项。

### 任务

**2b.1 `cochpia_agents` 表**（DDL 见 `03-l2-contracts.md` C-1.1）
**2b.2 双写迁移**（读优先级见 C-1.4，审查后新增）
**2b.3 prompt 接入 agent persona/tone/relationship**
**2b.4 `session.persona` 迁移**（AR-204：复制到 agent 的
`personaOverride`，API 保留但落到 agent 记录）

---

## 阶段 3：单链路收口

### 目标

一条链路。**无兼容窗口**（审查修订 AR-203）。

> **审查修订（AR-203）**：原计划的"legacy 降级 410 + 兼容窗口一个迭代"
> 被否决。理由：老板已明确"以我做的为主"，legacy stream 与 turns 是
> 完全重复功能，按"重复则删"原则应直接删。兼容窗口会留下第三套过渡态
> 代码，而且本轮 P1-1 诊断的病根正是"并存"。
>
> 正确顺序：**补流式 → 切前端 → 删 legacy**（不是 降级 → 窗口 → 删）。

### 任务

**3.1 turns 补流式（含 legacy 的三个语义）**

`/api/chat/turns` 增加 `Accept: text/event-stream` 分支。必须对齐
legacy 已有的三个能力（否则前端切不过去）：
- **分段渲染**：`main.jsx:707 takeSegment` 依赖 delta 流
- **重连**：`/api/chat/stream/:runId` + `Last-Event-ID`（`sse.js` 的
  `replaySseEvents`）
- **取消**：`/api/chat/cancel` + `run.controller.abort()`

内部仍是 turn 语义（幂等准入 → 检索 → 生成 → commit），
commit 在流结束后完成。

**3.2 前端切换**

`client/src/main.jsx:733` 改到 `/api/chat/turns`。

**3.3 等价性验证（切换前必须过）**

三个场景逐个人工验证：分段渲染、断线重连、生成中取消。

**3.4 一次性删除 legacy**

> **实施修正（AR-211，2026-09-11 老板裁决）**：原指令「删 `handleChatStream`
> 全函数」与 `06-legacy-module-disposition.md`「保留 `pi-client.js` + `tools.js`」
> 直接冲突——工作模式的唯一入口就在 `handleChatStream` 内部（113 行）。
>
> 裁决：**工作模式抽出为独立路由 `/api/chat/work`**，只删伴侣部分。
> 另：`auto-memory.js` 从「删」改为**保留**（工作模式仍用 `shouldRemember`）；
> `/api/chat/cancel`、`/api/chat/stream/:runId` 改为**改名**
> `/api/chat/work/cancel`、`/api/chat/work/:runId`（工作模式仍需取消与重连）。

- 删伴侣链路：`handleChatStream` 的伴侣分支、`/api/chat/stream`、
  `/api/chat/regenerate`、`/api/chat/retry`
- **保留**：`handleWorkStream`（`/api/chat/work`）、`/api/chat/approve`、
  `/api/upload`、`pi-client.js`、`tools.js`、`auto-memory.js`
- `chat-memory.js` 的 `retrieve` 保留（工作模式仍用）

**审查修订（AR-206）**：`compaction.js` **不删**——它是会话内摘要，
与 Memory episodes（跨会话）粒度不同。需**接线到 turns** 的
history section。
（已实施：`createTurnCompaction`，接在 `createCoreV0TurnService` 的
`compact` 钩子，于 generate 前执行，见 `core-v0.js`。）

### 闸门

- [x] turns 流式端到端可用（`test:turn-stream` 8/8）
- [x] 等价性三场景验证通过（`npm run test:e2e` **8/8**：
      分段渲染 / 断线恢复 / 生成中取消，真实浏览器实跑，老板可复跑）
- [x] legacy 代码从仓库消失（`test:stage3` C-1/C-2；`check:routes` 真实路由表）
- [x] `compaction` 已接入 turns（`test:stage3` C-7）
- [x] 无双重生成（`test:turn-stream` T7）
- [x] `npm test` + `npm run build` 全绿（385 / 0 fail；build ✓）
- [x] 工作模式保留且可用（AR-211；`test:stage3` C-3~C-6）

### 3.5 前端补取消控件（老板裁决并入阶段 3）

原闸门第 3 项默认了一个**并不存在**的控件（AR-215，既有缺口）。
已在本阶段补齐：`.stop-button`（流式中替换发送按钮）+
`cancelGeneration`（companion 走 `DELETE /api/chat/turns/:runId`，
工作模式走 `/api/chat/work/cancel`）。锁定于 `test:stage3` C-8 与端到端 S3-a/b/c
（其中 S3-c **查服务端**，确认没有半截回复落盘）。

### 回滚

切换即删，回滚 = revert 删除提交 + 前端 revert。**因为 legacy 代码
完整保留在 git 历史里，回滚成本低**（这是"直接删"可行的前提）。

---

## 阶段 4：清理

### 目标

删掉没人用的东西。**分批，每批独立验收。**

### 批次

> **审查修订（AR-205）**：原分类有误判（把运维端点列入删除）。
> 以下是修正后的分类。真实可删约 **16 个**，非原计划的 31 个。

**4.1 后端端点**

| 批次 | 端点 | 风险 | 依据 |
|---|---|---|---|
| **保留（运维必需）** | `/api/health`、`/api/ready`、`/api/version`、`/api/metrics` | — | Railway 健康检查（`deploy/`） |
| **保留（外部集成）** | `/mcp` | — | MCP 协议端点，外部 AI 客户端 |
| **保留（产品功能）** | `/api/models`、`/api/models/:provider/test`、`/api/profile`、`/api/preferences`、`/api/agents`、`/api/psychology/presets` | — | README 明确的产品功能 |
| **a（可删）** | `/api/memories`、`/api/memories/:id`、`/api/memories/:id/revoke`、`/api/memories/batch`、`/api/memories/export`、`/api/memory/dream` | 低 | Memory `/v1` 是权威入口 |
| **b（可删）** | `/api/music/*`（9 个）、`/api/personality/audit`、`/api/personality/rollback` | 低 | 前端零调用 |
| **c（需人工确认）** | `/api/export`、`/api/import`、`/api/sync`、`/api/sessions/:id/messages/:messageId` | 中 | 逐个确认后定 |

**4.2 后端死代码**

| 文件 | 处置 |
|---|---|
| `mcp-client.js`、`stdio-mcp-client.js` | 删（零引用） |
| `music-service.js`、`netease-music-adapter.js` | 删（随端点） |
| `auto-memory.js` | 删（随 legacy，阶段 3 已处理） |
| `sync-service.js` | 待确认 |

详细定性见 `06-legacy-module-disposition.md`。

**4.3 前端残留**

- `client/src/pipoya/`（0 引用）→ 删
- `client/src/characters/`（待确认间接引用）→ 核实后定
- `main.jsx` 内未使用的 state/handler → 清理

**4.4 代码卫生（审查 AR-209 新增）**

- 统一 `episodeGrouping` 默认值定义处：
  `memory-extraction.js:211`（默认 true）与 `memory-module-flags.js:6`
  （默认 false）**相反**。service-worker 已退役，应删除
  `memory-module-flags.js` 的影子 flag。
- 检查其他 flag 是否有同类双定义。

**4.5 main.jsx 拆分（可选，独立立项）**

972 行单文件拆为 `chat/`、`memory/`、`settings/` 模块。
**不属于本切片必要项**，除非阶段 3 的改动已让它更难维护。

### 闸门

- [x] 每批删除后全量冒烟通过（377 / 372 pass / 0 fail）
- [x] `client/src/main.jsx` 中所有 api 调用都能在路由表找到
      （`npm run check:routes` 新增交叉校验：**零失配**）
- [x] `npm test` + `npm run build` 全绿
- [x] `episodeGrouping` 双定义消除（见下方修正）

### 实施记录（2026-09-11）

> 动删之前逐条复核引用，**发现本节多处以「零引用 / 前端零调用」为依据的
> 删除判定是错的**——被判为死代码的模块实际都接在活链路上。
> 完整证据见 `06-legacy-module-disposition.md` 的「修正案」。
> 老板裁决：**只删无对外承诺的端点**；退役 service-worker **全删**。

**批次 A（死代码，已执行）**

| 项 | 依据 |
|---|---|
| `server/mcp-client.js` + 测试 | `/mcp` 端点是**内联实现**，此文件只被自己的测试引用 |
| `server/memory-module-service-worker.js` + 测试 | 非测试代码零引用（已退役） |
| `memory-module-flags.js` 的 `episodeGrouping` 影子键 | 见下 |

**批次 B（无对外承诺的端点，已执行）**

| 端点 | 依据 |
|---|---|
| `GET /api/memory/dream` | 前端 0 引用、0 测试、无文档承诺 |
| `GET /api/personality/audit` | 同上 |
| `POST /api/personality/rollback` | 同上（连带删除死 import `createPersonalityRollbackAudit`） |

路由总数 96 → 93。

**不改动（前提有误，均为活功能）**：`/api/music/*` + music 两个模块、
`stdio-mcp-client.js`、`client/src/pipoya/`、`client/src/characters/`、
`/api/export`、`/api/import`、`/api/sync` + `sync-service.js`、
`/api/memories*`（README 有承诺）、`auto-memory.js`（AR-211）。

**AR-209 的正确解法**（与原计划相反）：`memory-module-flags.js` **是活的**
（`memory-module-runtime.js` / `memory-module-extraction-worker.js` 在用），
不能删。真正死的是 `memory-module-service-worker.js`。
`episodeGrouping` 的唯一生效默认值在 `memory-extraction.js`（**true**）；
flags 里那个 `false` 是喂给死代码的影子键，已删。现由
`memory-module-flags.test.js` 断言「flags 不得定义 episodeGrouping」钉住。

### 回滚

每批独立 revert。删除提交的 revert 即恢复。

---

## 预留接口的冻结（阶段 2 交付物之一）

这三处**不是现在实现功能，而是现在把形状定死**，R-021 直接接入：

### 5.1 scope 扩展

```js
// memory-module.js MEMORY_SCOPES
const MEMORY_SCOPES = ['user', 'relationship', 'session', 'life'];
```
`life` scope 的可见性规则（`canSee`）：
- 归属：`relationshipAgentId === context.callerAgentId`（与 relationship 同）
- 差异：`life` scope **不进入** `userProfile`，只进 `relationshipProfile`
  的一个子分区（将来区分「关于你」与「关于我」）

### 5.2 purpose 扩展

```js
// memory-module.js purposePermission
if (purpose === 'life_generation') return 'retrieve';   // 只读自己的
```
语义：生活事件生成时读 agent 自己的近期记忆，**读不到 user scope 的私密
内容**（除非有 grant）。

### 5.3 context section 化

```js
// runtime-context.js 目标形态
buildRuntimeContext({ sections })
// sections: [
//   { key: 'memory',      source: () => bundle,  budget: 1800, required: false },
//   { key: 'personality', source: () => state.personality, budget: 200 },
//   { key: 'agentPersona',source: () => agent,   budget: 400 },
//   { key: 'lifeTexture', source: () => null,    budget: 300 },  // R-021 实现
// ]
```
每 section 独立降级：某一节失败 → 该节为空 + 标记 degraded，
其余节正常。

**迁移策略**：先保持现有 flat 输出兼容（`buildRuntimeContext` 内部用
sections 实现，但输出仍是扁平对象），避免一次性改动所有消费方。

---

## 交付物清单

| 文件 | 阶段 | 说明 |
|---|---|---|
| `00-scope.md` | — | 问题 + 范围 |
| `01-cleanup-plan.md` | — | 执行计划（本文件，含审查修订） |
| `02-current-to-target-map.md` | — | 现状→目标映射 |
| `03-l2-contracts.md` | 2a 前 | 契约冻结（含 C-1.4 双写优先级） |
| `04-acceptance.md` | — | 验收清单 + 债务登记 |
| `05-adversarial-review.md` | — | **对抗性审查（AR-201~209）** |
| `06-legacy-module-disposition.md` | — | **原作者模块处置表** |
| `rollback.md` | — | 各阶段回滚 |
| `scripts/turns-local-smoke.js` | 1.0 | **turns 本地可跑（新增，前置）** |
| `server/chat-memory-loop.test.js` | 1.3 | 闭环断言 |
| `scripts/chat-memory-smoke.js` | 1.4 | 闭环冒烟 |
| `server/agent-schema.sql` | 2b | agents 表 |
| `server/agent-life.js` | （R-021） | 不在本切片 |

### 4.3 / 4.5 卫生清扫与拆分（2026-09-11，老板指令）

**卫生清扫（已完成）**

| 项 | 依据 |
|---|---|
| 删除 `WorkspaceOverflow` 组件（33 行） | 定义后**从未被渲染**；其"更多聊天操作"菜单的三个动作没有入口 |
| 删除 `quickActionsOpen` state | 全文件只出现在声明处 |
| 删除 `.workspace-overflow*` 12 条 CSS | 唯一引用者是刚删的组件 |
| 删除 `.life-*` 死样式 146 条 | R-019 删掉游戏模块后遗留；JSX 零引用、无动态拼接 |

CSS：**1037 → 879 条规则（−15.7KB）**。

`life-*` 的移除只处理「选择器组每一段都含 `.life-`」的规则，
与其他类共享的 2 条（`.event-launcher, ...` / `.life-need, .life-...`）**保留**，
避免误伤同组里仍在用的类。

**拆分（第一阶段已完成）**

`client/src/main.jsx` **1060 → 979 行**。

抽出 `client/src/chat/message-utils.js`：`asArray`、`providerModelOptions`、
`modelErrorLabels`、`describeModelError`、`takeSegment`、`dateLabel`、
`splitSegments`。这些是纯函数、无 React 依赖、无模块状态——**组件树不可能
因这次搬动而改变**，所以是风险最低的第一步。

**顺带补上缺失的单元测试**：`client/src/chat/message-utils.test.js`（9 项）。
`takeSegment`/`splitSegments` 是阶段 3 分段渲染的核心，此前**只有浏览器端到端
覆盖**——一个纯逻辑回归会表现为"没人断言的外观变化"。
`npm test` 的 glob 扩展为 `node --test server/*.test.js client/src/chat/*.test.js`，
并新增 `npm run test:client`。

**尚未完成：`App()` 的分解**

`App()` 仍是约 790 行的单函数（全部 state + handler + 一整段 JSX）。
把它拆成 `chat/` / `settings/` 需要将 JSX 段落改造为显式 props 的组件，
是真正意义上的重构，不是搬文件。**建议独立立项**，理由：

1. 拆分本身不改行为，但改动面覆盖整个组件树——出错面远大于收益面
2. 现有自动化（379 单测 + 8 项端到端）**覆盖不到设置面板、音乐、
   角色编辑器等区域**，对这次重构给不出足够的安全网
3. 阶段 4 的目标是"删掉没人用的东西"，这与"重组在用的东西"是两类风险

建议的前置条件：先给设置面板/资料面板补端到端覆盖，再动。
