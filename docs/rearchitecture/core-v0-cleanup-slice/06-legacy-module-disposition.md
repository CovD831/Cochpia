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
