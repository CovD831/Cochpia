# R-020 原作者模块处置表

> 依据：老板指令"有些和我重复或功能差不多的可以删掉，有些可以保留的
> 就加入我们的链路当中"。
> 每个模块逐个定性：**删 / 保留 / 保留并接线**，附证据与理由。

## 判定标准

| 判定 | 含义 |
|---|---|
| **删** | 功能被老板的链路覆盖，或零引用，或有更优替代 |
| **保留** | 独立价值，与老板链路不重叠，但需要接线到新路径 |
| **保留并接线** | 有独立价值，但当前只接在 legacy 路径上，必须迁到 turns |

## 处置表

### 服务端

| 模块 | 行数 | 当前接线 | 判定 | 理由 |
|---|---|---|---|---|
| `auto-memory.js` | 28 | legacy `finalizeMemoryModule` | **删** | `shouldRemember` 是关键词启发式（`/记住\|记得\|喜欢\|…/`），被 Memory 的 LLM few-shot 提取器（`memory-extraction.js`）完全覆盖。随 legacy 删除自然消亡 |
| `compaction.js` | 40 | legacy `handleChatStream` | **保留并接线** | 做**会话内**摘要（30 条超限 → `session.summary` → prompt「对话摘要」段）。与 Memory episodes（跨会话 30 分钟时间窗）粒度不同、用途不同。**删了长对话上下文会丢** |
| `personality.js` | 34 | 前端 `/api/personality` | **保留并接线** | 人格版本管理（`applyPersonalityChange` + rollback audit），Memory Module 没有这个能力。需明确归属：人格是 agent 的属性（见 AR-204 遗留决策） |
| `growth-evidence.js` | 42 | legacy `finalizeMemoryModule` | **保留并接线** | 成长证据（claim/evidence/proposedChange/确认链）。**R-021 的 L3 叙事身份需要它**——McAdams 三层里 L3 是"长出来的"，这就是生长机制 |
| `psychology.js` | 96 | 前端 `/api/psychology/presets` | **保留** | atmosphere 预设，前端在用，无冲突 |
| `workspace-preferences.js` | 74 | 前端 `/api/preferences` | **保留** | 工作区 UI 偏好，属 App Runtime 的正当职责 |
| `collection-query.js` | 22 | 多处分页/搜索 | **保留** | 通用工具，被 sessions/messages/memories 分页使用 |
| `observability.js` | 118 | 全局中间件 | **保留** | 限流 + 指标，**阶段 1 的降级计数要用它** |
| `music-service.js` + `netease-music-adapter.js` | 107 | `/api/music/*` 9 个端点 | **删** | 与核心产品无关，前端零调用 |
| `pi-client.js` | 83 | 工作模式 | **保留** | 工作模式引擎（Pi RPC），不属伴侣链路但功能完整 |
| `tools.js` | 240 | 工作模式工具调用 | **保留** | 同上，含审批流 |
| `mcp-client.js` | 105 | 零引用 | **删** | 全局 grep 零 import |
| `stdio-mcp-client.js` | 118 | 零引用 | **删** | 同上 |
| `sync-service.js` | 92 | 前端 `/api/sync` | **待确认** | 多端增量同步，前端在调用；需确认是否仍有价值 |
| `agent-service.js` | 74 | 前端 `/api/agents` | **保留并改造** | 阶段 2a/2b 的核心改造对象（JSONB → 表） |
| `state-merge.js` | 152 | `/api/import` | **保留** | 导入合并逻辑，配合 `/api/import` |
| `chat-memory.js` | 129 | legacy 聊天 | **保留并改造** | 适配器，其 `retrieve` 是 P0-1 断链点 |

### 前端

| 目录/文件 | 行数 | 引用 | 判定 | 理由 |
|---|---|---|---|---|
| `client/src/main.jsx` | 972 | 主入口 | **保留**（拆分另立项） | 阶段 3 需改 fetch 目标 |
| `client/src/styles.css` | 916 | 全局 | **保留** | — |
| `client/src/pipoya/` | — | 0 引用 | **删** | manifest + test adapter，无消费者 |
| `client/src/characters/` | — | 0 直接引用 | **待确认** | 可能被 profile 间接引用，需核实后删 |
| `client/src/material/` | — | 2 引用 | **保留** | 材质预览，在用的 UI 功能 |
| `client/src/time/` | — | 1 引用 | **保留** | 时钟 provider |
| `client/src/windows/` | — | 1 引用 | **保留** | 窗口管理 |
| `client/src/audio/` | — | 4 引用 | **保留** | 音频 provider 组 |
| `client/src/icons/` | — | 1 引用 | **保留** | 图标 |
| `client/src/profile/` | — | 3 引用 | **保留** | 资料面板 |
| `client/src/workspace/` | — | 3 引用 | **保留** | 设置面板 |
| `client/src/i18n/` | — | 1 引用 | **保留** | 国际化 |

### 文档

| 文件 | 判定 | 理由 |
|---|---|---|
| `docs/研究`/`companion-core-foundation-plan.md`（39KB） | **保留** | 老板的 Core v0 设计前置 |
| `docs/记忆与性格机制.md` | **保留** | 机制说明 |
| `docs/rearchitecture/*` | **保留** | 重构程序主线 |
| `docs/memory-module-*.md`（11 个） | **保留** | Memory Module 契约文档 |
| 原作者的《共生人生》游戏方案 | 已删（R-019 v6 决议） | — |

## 汇总

- **删**：7 项（`auto-memory`、`music-service` + `netease-music-adapter`、
  `mcp-client`、`stdio-mcp-client`、`client/src/pipoya/`，以及随 legacy
  消亡的 legacy 处理代码段）
- **保留并接线**：7 项（`compaction`、`personality`、`growth-evidence`、
  `agent-service`、`chat-memory`、`observability` 的降级计数、
  `client/src/main.jsx` 的 fetch 目标）
- **保留**：12 项
- **待确认**：2 项（`sync-service`、`client/src/characters/`）

## 接线任务清单（"加入我们的链路"）

| 模块 | 接线目标 | 阶段 |
|---|---|---|
| `compaction` | turns 的上下文字段（session.summary → history section） | 3 |
| `personality` | 归属明确：agent 属性还是 user 属性（AR-204 遗留） | 2b |
| `growth-evidence` | 从 legacy 的 `finalizeMemoryModule` 迁到 turns 的 commit 后 | 3 |
| `observability` | 新增 `memory_degraded_total` 计数器 | 1 |
| `agent-service` | JSONB → `cochpia_agents` 表，prompt 接入 persona | 2b |
| `chat-memory` | 修 retrieve 的 sessionId（若保留窗口）或随 legacy 删 | 3 |

---

## 修正案（2026-09-11，阶段 4 实施前实测复核）

> **触发原因**：阶段 4 动删之前逐条复核引用，发现上表多处以
> 「零引用 / 前端零调用」为依据的 **删除判定是错的**——被判定为死代码的
> 模块实际上都还接在活链路上。以下为实测结果与修正。

### 判定错误清单（依据反了）

| 模块 | 原判定 | 实测 | 证据 |
|---|---|---|---|
| `music-service.js` + `netease-music-adapter.js` + `/api/music/*` | 删（"前端零调用"） | **活功能，不能删** | `client/src/audio/MusicProvider.jsx` 调用全部 `/api/music/*`；`MusicProvider` 挂在 app 根（`main.jsx:1041`），`MusicWindow` 用 `useMusic` |
| `stdio-mcp-client.js` | 删（"零引用"） | **不能删** | 被 `netease-music-adapter.js` import；音乐保留则它保留 |
| `client/src/pipoya/` | 删（"0 引用"） | **活功能，不能删** | `characters/characterProvider.js` import `pipoyaTestAdapter`；`client/public/pipoya/` 有真实精灵资源 |
| `client/src/characters/` | 待确认 | **活功能，不能删** | `profile/CharacterProfile.jsx` import `CharacterComposer` + `activeCharacterProvider`；`CharacterProfile` 由 `main.jsx` 渲染 |
| `/api/export`、`/api/import` | 待确认 | **活功能** | `main.jsx` 的 `exportData`/`importData` 绑定了「导出数据 / 导出」按钮 |

### 一处判定前提不成立（结论要改）

**AR-209 的正解不是「删 `memory-module-flags.js` 的影子 flag」。**

实测：`memory-module-flags.js` **是活的**——被 `memory-module-runtime.js`
（`index.js` 在用）与 `memory-module-extraction-worker.js` import。
真正死的是 `memory-module-service-worker.js`（非测试代码零引用）。

`episodeGrouping` 的实际生效路径也与原判断相反：

| 位置 | 默认 | 是否生效 |
|---|---|---|
| `memory-extraction.js:211` | `true` | **唯一生效**（生产走这条） |
| `memory-module-flags.js:6` | `false` | 惰性——`memory-module.js` 根本不读 `episodeGrouping`，只喂给已退役的 service-worker |

即：**生产一直是 true**，那个 `false` 是喂给死代码的影子键。
正解 = 删退役的 service-worker + 删该影子键（并同步其测试），
**而非删整个 flags 模块**。

### 修正后的阶段 4 可删清单

**可安全删（已实测零引用）**
1. `server/mcp-client.js` + `server/mcp-client.test.js`
   —— `/mcp` 端点是**内联实现**，此文件只被自己的测试引用
2. `server/memory-module-service-worker.js` + 其测试（已退役）
3. `memory-module-flags.js` 的 `episodeGrouping` 影子键 + 同步 `memory-module-flags.test.js` 断言

**需老板决策（后端独有、前端不用，但有对外承诺）**
4. `/api/memories*`（7 条）——README/docs 有承诺，1 个测试覆盖
5. `/api/personality/audit`、`/api/personality/rollback`——1 文档提及
6. `/api/memory/dream`——0 引用 0 测试；注意 `/mcp` 的 `dream` 工具走同一能力（**不同路径**，删 HTTP 路由不影响它）
7. `/api/sync` + `sync-service.js`——前端有 `syncWorkspace`

**顺带发现（文档过期）**
- `README.md:20` 写「旧的 `/api/chat/stream` 暂时保留用于兼容和对照」，
  但阶段 3 已删除该端点 → README 需更新。

### 待裁决项的实测细节（2026-09-11 补充）

**`/api/memories*`（8 条路由）**

| 事实 | 证据 |
|---|---|
| 前端 0 引用 | `grep -r "api/memories" client/src` → 0 |
| 保留理由**已经失效** | `docs/memory-module-v1-contract.md:7` 写「remain temporarily available **for the current Cochpia UI**」——但当前 UI 已不再调用 |
| 是目标架构里的**已知缺口** | `docs/companion-core-foundation-plan.md:440` 把 `/api/memories` 列为「公共写入口」，绕过 Collector/admission 边界；目标状态是 `/v1` 仅 internal service identity |
| 被两个测试当**探针**用 | `server/isolation.test.js:33` 租户隔离断言（B 看不到 A 的记忆）；`scripts/core-v0-runtime-acceptance.js:201` 旁路写测试（确认无法从该路径注入聊天） |

删 = 关闭一个架构缺口，但失去两个安全断言（可改指向 `/v1`，需一并改）。

**`/api/sync` + `sync-service.js`：不是死代码，是「活的空转」**

| 事实 | 证据 |
|---|---|
| 每 30 秒轮询 | `client/src/main.jsx:491-495` 的 `setInterval` |
| **返回值被丢弃** | `syncWorkspace()` 的返回值无人使用，只 `setSyncCursor(result.nextCursor)`；payload 不进入任何 UI state |
| 定时器会被重建 | `syncCursor` 在 effect deps 里，每次 cursor 变化即 `clearInterval` + 重新 `setInterval` |
| 服务端有实际开销 | `collectSyncChanges` 每次序列化全部 session / message / memory / evidence / personalityAudit，再排序过滤 |

即：**每 30 秒做一次真实服务端工作，然后把结果扔掉。**
留 = 保留"多端增量同步"的接入点；删 = 去掉一个空转轮询。

**`client/src/main.jsx`：现为 1067 行**（计划里记的是 972，阶段 3.5 又增长了）。
计划中标注「可选，独立立项」。

### 第一批裁决的执行结果（2026-09-11）

老板裁决：**第一项（`/api/memories*`）与第二项（`/api/sync`）都删。**

**作者溯源**（`git log`，回答"这是我做的还是原作者做的"）：

| 组件 | 引入提交 | 作者 |
|---|---|---|
| `/api/sync` + `sync-service.js` | `a37c534` 2026-08-13「初始提交:AI 陪伴应用 Cochpia」 | **ksys404（原作者）** |
| `/api/memories*`（8 条） | `a37c534` | **原作者** |
| `isolation.test.js`（多用户隔离测试） | `a37c534` | **原作者** |
| `auth.js`、`store.js`（多用户/租户层） | `a37c534` | **原作者** |

即：**多用户隔离那一层整体是原作者的设计**，不是老板链路的一部分。
（注：老板的 Core v0 工作后来把 tenant/subjectUserId 作用域带进了 Memory
模块，但 auth/sync/隔离测试这层是原作者的。）

**已删除**

| 项 | 说明 |
|---|---|
| `GET/POST /api/memories`、`GET /api/memories/export`、`POST /api/memories/batch`、`POST /api/memories/:id/revoke`、`GET/PATCH/DELETE /api/memories/:id` | 8 条公开治理路由 |
| `GET /api/sync` + `server/sync-service.js` + 其测试 | 端点为原作者所有 |
| 前端 `syncWorkspace` / `syncCursor` / 30 秒轮询 effect | 见下 |
| `rejectCoreChatBypass` + `coreEventFields` | 只服务于被删的治理路由，随之变死代码 |
| `compatibilityMemoryForRequest` 的 8 处调用 | **兼容层本体保留**——`/mcp` 仍在用（共 10 处，剩 2 处：定义 + `/mcp`） |

路由总数 **93 → 84**。

**未删除但载荷被丢弃的轮询已一并清掉**：前端那个每 30 秒调 `/api/sync`
的 effect 只更新 cursor、把返回的变更全部丢弃，且 `syncCursor` 在 deps 里
会反复重建定时器。删除时在前端留了注释：将来若真要多端同步，
**需要的是消费者，而不是一个轮询器**。

**连带修正的两处测试**

1. `scripts/core-v0-runtime-acceptance.js` 的 **A-11**（promotion 闸门 A-01~A-12）：
   原断言「治理路由拒绝 Core chat 事件旁路载荷」（400 `MEMORY_CHAT_BYPASS_FORBIDDEN`）。
   路由删除后旁路**不再可能**（而非仅被拒绝）——是同一性质的更强形式。
   改为断言 404 `API_ROUTE_NOT_FOUND`，并更新描述文案。

2. `server/isolation.test.js` 的 memory 探针：**删掉**。
   原断言是**空的**——该测试只建会话、从不发聊天消息，
   所以「来自该会话的记忆」对任何人都还不存在，断言必然通过。
   改指向 `/api/memory/overview` 不会恢复覆盖（该路由是 1200 token /
   8 条的预算截断视图，同样会空）。记忆作用域隔离在能真正验证它的地方覆盖：
   `memory-module.test.js`（userContext/agentContext 双用户）与
   `agent-scope-2a.test.js`（读侧作用域收窄）。

**同时更新的文档**：`docs/memory-module-v1-contract.md` 原写
「`/api/memories` remain temporarily available for the current Cochpia UI」——
保留理由已失效且端点已删，改为记录删除事实与 `/v1` 为唯一 Memory API。
