# R-020 现状 → 目标映射

## 一、聊天链路

| 维度 | 现状 | 目标 | 阶段 |
|---|---|---|---|
| 生成入口 | 两个（stream / turns） | 一个（turns） | 3 |
| 流式 | legacy SSE（`index.js:790 attachStreamResponse`） | turns 内 SSE 分支 | 3 |
| 幂等 | legacy 无；turns 有 Idempotency-Key | 统一 turns 语义 | 3 |
| 记忆检索 | legacy 断（sessionId=null） | 两链路均通，最终只剩 turns | 1 |
| 失败处理 | catch 静默吞（`index.js:891`） | 显式 degraded 标记 + 指标 | 1 |
| agent 身份 | `'cochpia'` 常量 | session.agentId 解析 | 2 |
| prompt 装配 | `session.persona` 单字段 | agent persona/tone/relationship 接入 | 2 |
| 上下文字段 | `buildRuntimeContext` 固定对象 | section 数组 + 独立降级 | 2 |

## 二、身份与绑定

| 实体 | 现状 | 目标 |
|---|---|---|
| 应用会话 | `state.sessions[].id`，无 agent 归属（私聊） | `session.agentId` 必填 |
| 记忆会话 | `memory_sessions.id`，仅能反查 | 与应用会话显式绑定，可从任一侧解析 |
| turn 准入 | `core_v0_turn_admissions` | 不变 |
| agent 记录 | `state.agents[]`（JSONB 内） | `cochpia_agents` 表 |
| agent 身份传递 | 硬编码 `'cochpia'` | 从 session 解析，禁止回退 |

## 三、存储写入

| 存储 | 现状 | 目标（本切片） | 目标（R-021+） |
|---|---|---|---|
| `cochpia_state` | 单行 JSONB 全量重写 | 不变（记录债务） | 差量写或废表 |
| `memory_*`（27 表） | DELETE + INSERT 全量 | 不变（记录债务） | 热路径差量写 |
| `core_v0_*`（9 表） | 一轮 turn 4-5 次全量 persist | 不变（记录债务） | 减少 persist 次数 + 差量 |
| `cochpia_agents` | 不存在 | 新增，按行读写 | 加 life_state 列 |

**债务登记**：写入重构单独立项。触发条件见 `04-acceptance.md`。

## 四、端点与前端

| 类别 | 现状 | 目标 | 阶段 |
|---|---|---|---|
| 后端端点 | 72 个声明（56 个 `/api` 前缀） | 保留 ~25 个 | 4 |
| 前端调用 | 32 个 | 与后端保留集一致 | 4 |
| 前端目录 | 10 个，2 个零引用 | 删零引用，其余按需 | 4 |
| main.jsx | 972 行单文件 | 保持（拆分另立项） | — |

## 五、为 R-021 预留的接口

| 接口 | 现状 | 本切片交付 | R-021 接入 |
|---|---|---|---|
| scope 类型 | `user/relationship/session` | 增加 `life` 枚举 + `canSee` 规则 | 生活事件写入 |
| purpose | 4 个 | 增加 `life_generation` | 每日事件生成读自己的记忆 |
| context section | 固定字段对象 | section 数组 + 预算 + 独立降级 | `lifeTexture` 注册实现 |
| agent 记录 | JSONB，无 life 字段 | 表含 `life_state jsonb` + `seed_version` | 存 mood/dailyRoutine/todayEvents |
| 触发时机 | — | turns 内写回可 await（阶段 3） | 当天首次交互懒触发 |

## 六、明确不改的

- Memory Module 的 `/v1` 契约（`memory-module-api.js`）——它是权威入口，
  不动。
- `core-v0` 的 turn 状态机与 receipt 语义（R-004 已收敛）。
- 权威分工原则：App Runtime / Core PG / Memory PG 各管各的。
- Memory 的治理语义（sensitivity / promotion / mention policy / bi-temporal）。
- R-014~R-017 的提取与检索机制（flag 与默认值保持）。
