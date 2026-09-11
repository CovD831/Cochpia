# R-020 scope: 聊天基座收口（Cleanup & Groundwork）

## 定位

- Package: `R-020-chat-base-cleanup`
- 基线: `d8dfdd7`（R-019 v6.1 文档定稿，代码未动）
- 上游：R-001 ~ R-019 是在**接手他人项目**的前提下增量叠加的链路；
  本切片是第一次**回头整理地基**。
- 下游：R-021（Agent 自我生活模块）依赖本切片的三处预留接口。

## 背景：项目的真实来历

项目由他人（TPR 作者）搭建初版，老板接手后以"增加一条 memory 链路 +
core-v0 重构"的方式推进。结果是**两套世界观在同一进程里并存**：

- **原作者的世界观**：`state.json` 单文件状态机 + 72 个 HTTP 端点 +
  内联 chat 处理 + 前沿时间戳。特征：全量重写、无幂等、无并发模型。
- **老板的世界观**：Memory Module 独立服务 + PostgreSQL 规范表 +
  core-v0 turn 幂等准入 + 证据驱动验收。特征：契约化、可审计、可回归。

问题在于：老板的新链路**建在了原作者的地基上**（`createCoreV0LocalAdapter`
复用 `state`，`chatMemoryForRequest` 复用 `memoryRuntime`），且新链路默认
关闭。于是**两套并存、各断一半**，没有一套是完整的。

## 问题清单（按证据）

### P0-1 记忆检索在产品路径上从未工作

链路：`index.js:835 handleChatStream` → `chatMemoryForRequest`
（`memory-module-runtime.js:220`）→ `contextFromRequest(req, {chat:true})`
（同文件 `:225`）→ 产出 `sessionId: null` → `chat-memory.js:88`
`contextBundleAsync(context, {...})` 未补 sessionId →
`services/memory-module/index.js:118` 从 `req.body.session_id` 取值也为 null
→ `memory-module.js:1375 activeSessionForContext` 返回 null →
`contextBundle` 中 `coreMemory/userProfile/relationshipProfile/currentState`
全空。

失败被 `index.js:891` 的 catch 吞掉，降级为 `recalled=[]` 继续生成。

**这是"伴侣路径零使用"的真正根因**，此前被误判为"孤儿能力"。

### P0-2 agent 不是一等公民，身份是硬编码常量

- `memory-module-runtime.js:75`：`callerAgentId = ... : 'cochpia'` 常量。
- `core-v0.js:298` / `core-v0-postgres.js:578`：
  `callerAgentId: baseContext.callerAgentId || 'cochpia'` 同样的回退。
- `state.agents[]`（`agent-service.js`）存了
  `persona/tone/relationship/role/memoryNotes`，但主聊天路径**完全没读
  agent**：`index.js` 全文 `persona` 只出现于 `session.persona`；agent 字段
  仅在群聊 `index.js:1049` 使用；`memoryNotes` 无任何消费者。
- 会话不绑定 agentId：session 只有群聊用的 `agentIds[]`，私聊会话无归属。

后果：`relationship` scope 的可见性判定依赖 `context.callerAgentId`
（`memory-module.js:344`），而它恒为 `'cochpia'` → **关系域记忆对所有
agent 是同一份**。这直接阻塞 R-021。

### P0-3 三套全量重写，无差量写

| 存储 | 表 | 写入方式 | 证据 |
|---|---|---|---|
| App Runtime | `cochpia_state` / `cochpia_user_states` | 单行 JSONB 全量重写 | `store.js:147` |
| Memory Module | 27 张 `memory_*` | DELETE 全表 + INSERT 全量 | `memory-module-postgres.js:733-780` |
| Core v0 | 9 张 `core_v0_*` | DELETE + INSERT 全量 | `core-v0-postgres.js:322-337` |

core-v0 一轮 turn 内 `persist()` 调用 4-5 次（admission / binding /
context_ready / generation_succeeded / commit），每次重写 6 张表全部行。

单机单用户测不出（数据量小），多用户并发 = PG row lock 排队 + O(n²) 写放大。

### P0-4 三套会话身份，无权威

`state.sessions[].id`（应用会话）、`memory_sessions.id`（记忆会话，仅能
通过 `core_v0_memory_session_bindings` 或 idempotency record 反查）、
`core_v0_turn_admissions.application_session_id`。

legacy 路径上 `recordEvent` 的 `sessionId` 来自 context 的 null
（`memory-module.js:816`），**事件未写入任何 memory session**。

### P1-1 双轨聊天链路

- `/api/chat/stream`（SSE）：前端唯一在用（`main.jsx:733`），记忆断。
- `/api/chat/turns`（core-v0）：记忆完整，`CORE_V0_ENABLED` 默认 false，
  前端零调用。

### P1-2 端点残留：前端从未调用的端点（审查修正后清单）

> **审查修订（AR-205）**：原始清单把运维端点（`/api/health` 等）与
> 外部集成端点（`/mcp`）误列为删除对象。以下为核实后的分类。

**确认可删（16 个）**
```
/api/memories  /api/memories/:id  /api/memories/:id/revoke
/api/memories/batch  /api/memories/export  /api/memory/dream
/api/music/environment  /api/music/status  /api/music/context
/api/music/search  /api/music/play  /api/music/pause
/api/music/resume  /api/music/next  /api/music/stop
/api/personality/audit  /api/personality/rollback
```

**需人工确认（4 个）**
```
/api/export  /api/import  /api/sync
/api/sessions/:id/messages/:messageId
```

**必须保留（前端零调用但不可删）**
```
运维必需：/api/health  /api/ready  /api/version  /api/metrics
外部集成：/mcp
产品功能：/api/models  /api/models/:provider/test  /api/profile
          /api/preferences  /api/agents  /api/psychology/presets
```

其中 `/api/memories*` 是直连 legacy memory 面的兼容路由，
`memory-module-api.js` 的 `/v1` 契约才是权威入口。

### P1-3 前端残留

- `client/src/main.jsx` 972 行单文件，chat 逻辑内联，无组件边界。
- `client/src/styles.css` 916 行。
- 目录引用统计：`pipoya`（0 次）、`characters`（0 次）；
  `material`/`time`/`windows`/`audio`/`icons` 各 1-4 次。
- `client/src/life` 已在 R-019 v6 决策删除（未提交的删除在执行范围外）。

## 本切片范围

### 收口（Make one stack authoritative）

1. **单一聊天链路**：`/api/chat/turns` 为唯一生成路径，补 SSE 流式；
   legacy 相关代码**一次性删除**（无兼容窗口，见 AR-203）。
2. **agent 成为一等主体**：`session.agentId` 必填；`callerAgentId` 从会话
   解析；删除 `'cochpia'` 常量回退；agent 的 persona/tone/relationship 接入
   prompt 装配（拆 2a/2b，见 AR-202）。
3. **会话身份统一**：一个应用会话 ↔ 一个 memory session 的绑定成为
   显式契约，可从任一侧解析。
4. **可观测性**：记忆降级必须显式可见（`memory_degraded_total`），
   禁止静默吞错。

### 预留（Groundwork for R-021）

5. **scope 扩展点**：`MEMORY_SCOPES` 增加 `life`，`canSee` 给出规则。
6. **purpose 扩展点**：`purposePermission` 增加 `life_generation`。
7. **context section 化**：`buildRuntimeContext` 改为 section 数组 +
   预算 + 独立降级语义，`lifeTexture` 注册为空实现。

### 清理（Remove dead weight）

8. 删除 16 个确认无用的端点 + 4 个待确认端点（分批、可回滚）。
9. 删除作者遗留模块（详见 `06-legacy-module-disposition.md`）：
   删 7 项、保留并接线 7 项、保留 12 项。
10. 不变量测试：禁止静默降级；记忆闭环端到端断言。
11. 代码卫生：消除 `episodeGrouping` 的双重默认值定义（AR-209）。

### 原作者模块处置原则（老板指令）

- 与老板链路**功能重复或劣化**的 → 删（`auto-memory` 启发式 vs
  LLM 提取器；`music-service` 与核心无关）。
- **有独立价值**的 → 保留并接线到 turns（`compaction` 会话内摘要、
  `growth-evidence` 成长证据、`personality` 版本管理）。
- 判据不是"谁写的"，是"是否被覆盖 / 是否有独立价值"。
  详细定性见 `06-legacy-module-disposition.md`。

## 明确排除

- **写入重构（P0-3 差量写）**：单独立项 `R-021-write-path`（或后续编号）。
  理由：工作量最大，且与功能闭环耦合度低。但**必须在本切片记录为已知
  债务并给出触发条件**（见 acceptance.md 的债务条目）。
- Agent 自我生活模块本体（R-021）。
- 多 agent 群聊的产品化。
- 前端 UI 重设计（仅在必要处改动以接单链路）。
- TLS/Auth 生产证据（属 R-004 promotion）。

## 权威分工（不变）

- App Runtime 独有 session 元数据与用户偏好。
- Core PostgreSQL 独有 turn 准入、应用消息、assistant commit 与 receipt。
- Memory PostgreSQL 独有 Memory session、raw events、canonical assertions、
  ContextBundle 输入。
- 适配器只做组合，**禁止把 Memory 事实复制进 Core state**（R-004 原则）。

## 本切片独有的权威约束

- 收口期间的**兼容窗口**必须有明确起止：旧链路只读、不生成，且窗口
  结束条件写死在 acceptance。
- 删除端点前必须有一次全量前端冒烟，确认无隐藏调用（含 devtools 动态
  拼接路径）。
- agent 身份落地后，`relationship` scope 的可见性测试必须覆盖
  "agent A 看不到 agent B 的关系记忆"这一负向断言。
