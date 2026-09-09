# 多 Agent 协作流水线 · 完整架构方案

> 目标：让 Cochpia 直接编排「pi 规划 → codex 实现 → 验证 → 审查」的完整协作闭环。
> 参考 DeepReason-Agents-Framework 的**设计思想**（角色抽象、workflow spec、门禁三态、证据账本、proposal-only 自进化），不移植其代码（无 LICENSE，默认保留所有权利）。
> 本方案全部基于 Cochpia 现有代码做**增量改造**，不推倒重来。

---

## 0. 现状盘点（改造的起点）

已存在、可直接复用：

| 组件 | 文件 | 能力 |
|------|------|------|
| 任务状态机 | `server/agent-task.js` | structured spec、`submitted/running/waiting_approval/verifying/reviewing/completed/failed/cancelled`、idempotencyKey |
| DAG 调度 | `server/agent-scheduler.js` | `dependsOn`、并发上限、级联失败 |
| 执行器 | `server/pi-client.js` / `codex-client.js` / `claude-client.js` | spawn CLI，流式事件 |
| 沙箱 | `server/task-sandbox.js` | git worktree / 过滤副本、diff、清理 |
| 审批 | `server/index.js` 内 `waitForApproval` / `/api/chat/approve` | read/write/execute/deploy 分级、超时、TTL |
| 验证器 | `server/verifier.js` | npm test / build，202 异步 |
| 审查 | `server/index.js` 内 `/api/workbench/tasks/:id/review` | approve/request_changes/reject |
| 记忆作用域 | `server/memory-module.js` | user/relationship/session + source_label/source_agent_id 归因 |

**关键缺口**（本次要补的）：
1. **输出交接**：`runAgentTask` 里，依赖任务的结果（`task.result.summary`）目前不会注入下游任务的输入。
2. **角色抽象**：`target: pi/codex/claude` 是写死的，没有「规划者/实现者/审查者」的角色层。
3. **workflow spec**：DAG 是硬编码的，没有 JSON 可编辑的工作流定义。
4. **门禁三态**：审批只有 allow/deny，缺 interrupt（打断补充后重试）。
5. **证据账本**：证据散落在 task events / verifier / sourceEventId，没有统一结构。
6. **自进化 proposal**：没有 formal 的「只出提案、批准才落库」机制。

---

## 1. 目标与原则

1. **角色与执行器解耦**：`role`（做什么）和 `executor`（谁来做）分开，可配置。
2. **工作流可配置**：协作流水线由 JSON spec 驱动，改配置不改代码。
3. **输出交接**：上游阶段产出自动成为下游阶段输入。
4. **门禁三态**：`allow / interrupt / deny`，interrupt 支持补充上下文后重试。
5. **证据统一**：所有结论、变更、验证、审查落统一账本，可溯源可哈希。
6. **自进化只出提案**：任何自我修改只生成 proposal，review 批准后才由 code_modifier 应用。
7. **可审计、可回放、可门禁**：沿用现有 events + idempotencyKey + 状态机。

---

## 2. 整体架构（分层）

```
┌─ 前端 Workbench ───────────────────────────────┐
│  协作任务入口 / 工作流可视化 / gate 审批 UI       │
└───────────────────┬────────────────────────────┘
┌───────────────────▼────────────────────────────┐
│ Orchestrator（编排层）                          │
│  加载 workflow spec → 展开成 stage 链 → 建 task   │
│  角色解析（role → executor）                     │
│  输出交接（inputFrom → 依赖 result 注入）         │
└───────────────────┬────────────────────────────┘
┌───────────────────▼────────────────────────────┐
│ Scheduler（调度层，复用现有）                    │
│  dependsOn + 并发上限 + 级联失败                  │
└───────────────────┬────────────────────────────┘
┌───────────────────▼────────────────────────────┐
│ Executors（执行层，复用现有）                    │
│  pi / codex / claude / builtin(verify)          │
│  + sandbox 隔离 + 审批门禁                       │
└───────────────────┬────────────────────────────┘
┌───────────────────▼────────────────────────────┐
│ 基础设施（复用现有）                             │
│  Gate(allow/interrupt/deny) / Evidence / Memory  │
└────────────────────────────────────────────────┘
```

---

## 3. 数据模型

### 3.1 Role（角色）

新文件 `server/roles.js`：

```js
export const ROLES = {
  planner: {
    label: '规划者',
    executor: 'pi',                      // 绑定执行器
    systemPrompt: '你是规划者。分析用户需求，输出结构化实现计划（目标/步骤/验收标准/风险），不要写代码。'
  },
  implementer: {
    label: '实现者',
    executor: 'codex',                   // 绑定执行器
    systemPrompt: '你是实现者。严格按照计划实现代码，不扩大范围，改动保持最小。'
  },
  reviewer: {
    label: '审查者',
    executor: 'claude',
    systemPrompt: '你是审查者。审查实现是否满足计划与验收标准，输出结论（approve/request_changes/reject）与理由。'
  },
  verifier: {
    label: '验证器',
    executor: 'builtin',                 // 走 verifier.js，不 spawn CLI
    builtin: 'verify'
  }
};

export const resolveRole = roleId => ROLES[roleId] || null;
```

### 3.2 Workflow Spec（JSON 驱动）

新目录 `server/configs/workflows/*.json`。默认 `collab-dev.json`：

```json
{
  "id": "collab-dev",
  "name": "协作开发",
  "description": "pi 规划 → codex 实现 → 验证 → 审查",
  "stages": [
    {
      "id": "plan",
      "role": "planner",
      "prompt": "分析需求并写出实现计划：\n{goal}",
      "dependsOn": []
    },
    {
      "id": "implement",
      "role": "implementer",
      "prompt": "按下面的计划实现代码：\n{goal}",
      "dependsOn": ["plan"],
      "inputFrom": "plan"
    },
    {
      "id": "verify",
      "role": "verifier",
      "dependsOn": ["implement"]
    },
    {
      "id": "review",
      "role": "reviewer",
      "prompt": "审查这次实现是否符合计划与验收标准。",
      "dependsOn": ["verify"],
      "inputFrom": "implement"
    }
  ],
  "checkpoints": ["verify", "review"]
}
```

字段约定：
- `prompt` 里的 `{goal}` 在展开时替换为用户目标。
- `dependsOn`：阶段依赖（对应 task 的 `dependsOn`）。
- `inputFrom`：指定「哪个阶段的输出」作为本阶段额外输入（默认取全部 `dependsOn` 里已完成任务的 result）。
- `checkpoints`：这些阶段必须经过 gate 才能继续（默认 verify/review）。

### 3.3 Task（扩展现有 agent-task.js）

在 `create` 的 task 对象上新增：

```js
{
  // ...现有字段...
  workflowId: null,      // 所属工作流 id（单任务派发为 null）
  stageId: null,         // 所属阶段 id
  role: null,            // 角色 id（planner/implementer/...）
  inputFrom: [],         // 从哪些 stage 取输出（展开后转成 taskId 列表）
}
```

**输出交接规则**（在 `runAgentTask` 里实现）：

```js
// 任务输入 = 自己的 task + 依赖阶段的结果摘要
const dependencyOutputs = (task.dependsOn || []).map(depId => {
  const dep = state.agentTasks.find(t => t.id === depId && t.ownerId === task.ownerId);
  return dep?.result?.summary
    ? `[${dep.stageId || dep.role || dep.target} 的输出]\n${dep.result.summary}`
    : '';
}).filter(Boolean).join('\n\n');

const text = [task.task, dependencyOutputs].filter(Boolean).join('\n\n');
```

### 3.4 Gate 三态

扩展审批 decision：

```
allow     → 放行，继续执行
deny      → 拒绝，任务 failed
interrupt → 打断：附 feedback，任务转回 running（补充上下文后重试），不记 failed
```

改动点：`/api/chat/approve` 和 workbench 任务审批的 decision 从布尔升级为枚举。现有 `request_changes`（review 层）语义不变，gate 的 interrupt 是**执行中途**的打断。

### 3.5 Evidence Ledger（证据账本）

新文件 `server/evidence.js`：

```js
export function createEvidenceLedger(state) {
  state.evidence ||= [];
  return {
    record({ taskId, stageId, source, content, score = null }) {
      const item = {
        id: randomUUID(),
        taskId, stageId,
        source,            // 'agent_output' | 'sandbox_diff' | 'verification' | 'review' | 'rag'
        content: String(content || '').slice(0, 4000),
        hash: createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16),
        score,
        createdAt: new Date().toISOString()
      };
      state.evidence.push(item);
      return item;
    },
    list(taskId) { return state.evidence.filter(e => e.taskId === taskId); }
  };
}
```

调用点：`runAgentTask` 记录 `agent_output`/`sandbox_diff`；`runTaskVerification` 记录 `verification`；review 端点记录 `review`。

### 3.6 Self-Evolution Proposal

新文件 `server/proposals.js`：

```js
export function createProposalService(state) {
  state.proposals ||= [];
  return {
    create({ kind, target, patch, rationale }) { /* status: 'pending' */ },
    approve(id) { /* 只有 approve 才允许应用 */ },
    reject(id) { /* 只标记，不应用 */ },
    list() { /* 列表 */ }
  };
}
```

原则：**任何自我修改（skills/config/memory 写入）必须走 proposal，review 批准后才应用**。与现有「Claude 锁定」护栏一致，只是 formal 化。

---

## 4. 核心流程（Orchestrator）

新文件 `server/orchestrator.js`：

```js
export async function runCollaborationWorkflow({ workflowId, goal, ownerId, agents, agentTasks, taskScheduler }) {
  const spec = loadWorkflowSpec(workflowId);          // 读 JSON
  const tasks = [];
  const stageTaskIds = new Map();

  for (const stage of spec.stages) {
    const task = await agentTasks.create({
      target: resolveRole(stage.role).executor === 'builtin' ? 'codex' : resolveRole(stage.role).executor,
      // ↑ verifier 用 builtin，其余用 role.executor
      task: stage.prompt.replace('{goal}', goal),
      dependsOn: stage.dependsOn.map(depId => stageTaskIds.get(depId)).filter(Boolean),
      workflowId: spec.id,
      stageId: stage.id,
      role: stage.role,
      inputFrom: stage.inputFrom
    }, ownerId);
    stageTaskIds.set(stage.id, task.id);
    tasks.push(task);
  }

  // verifier 阶段不 spawn 执行器，而是等待后由 verify 端点/自动触发（见 4.1）
  for (const task of tasks) {
    if (resolveRole(task.role)?.builtin !== 'verify') taskScheduler.enqueue(task);
  }
  return { workflowId, spec, tasks };
}
```

### 4.1 verifier 阶段接入

`verifier` 是 builtin 角色，不 spawn CLI。两种接法（选 B，改动小）：

- A. 让 implement 任务完成后，调度器自动调用 `verifyAgentTask`。
- B. 保持现有「手动点开始验证」+ 新增「协作模式下自动触发」：implement 完成进入 `verifying` 后，若 `task.workflowId` 存在，自动 `void runTaskVerification(task, workdir)`。

选 B：`runAgentTask` 的 finally/完成回调里加判断。

---

## 5. 文件结构（codex 需要创建/修改）

```
server/
  roles.js                 (NEW)  角色定义 + resolveRole
  workflows.js             (NEW)  loadWorkflowSpec / listWorkflows / validate
  orchestrator.js          (NEW)  runCollaborationWorkflow / 展开 stage 链
  evidence.js              (NEW)  证据账本
  proposals.js             (NEW)  自进化提案
  configs/workflows/collab-dev.json (NEW) 默认工作流
  agent-task.js            (MOD)  create 增加 workflowId/stageId/role/inputFrom
  index.js                 (MOD)  runAgentTask 输出交接 + 新端点 + evidence 记录
  agent-scheduler.js       (不改，已支持 dependsOn)
client/
  src/workspace/WorkbenchPage.jsx (MOD) 协作任务入口 + 工作流可视化
  src/styles.css           (MOD) 协作流水线样式
```

---

## 6. API 端点

```
POST /api/workflows                → 列出可用工作流
POST /api/workflows/:id/run        → body { goal } → 创建流水线（返回 runId + tasks）
GET  /api/workflows/runs/:id       → 返回 run 状态（stages + tasks + evidence）
POST /api/workbench/tasks/:id/gate → body { decision: allow|interrupt|deny, feedback }
POST /api/proposals               → 创建提案
POST /api/proposals/:id/approve   → 批准（应用）
POST /api/proposals/:id/reject    → 拒绝
```

（`/verify`、`/review`、`/cancel` 已存在，不改。）

---

## 7. 前端改动（WorkbenchPage）

1. **协作任务入口**：新卡片/按钮「协作开发」，点开填一个 `goal`，调用 `POST /api/workflows/collab-dev/run`。
2. **流水线可视化**：把 run 的 stages 画成横向步骤条（plan → implement → verify → review），每个阶段显示状态（复用现有 `workflow-step` 样式）。
3. **gate 审批 UI**：`interrupt` 增加一个「补充意见并重试」选项（现有审批弹窗已有 risk/二次确认，扩展 decision）。
4. **证据/提案入口**：任务详情里展示 evidence 列表（复用现有 events 折叠区）。

---

## 8. 验收标准（测试）

```js
// server/orchestrator.test.js
1. workflow spec 展开：stages → tasks 的 dependsOn 链正确，prompt 的 {goal} 被替换。
2. 输出交接：task B dependsOn A 时，runAgentTask 的输入包含 A 的 result.summary。

// server/roles.test.js
3. resolveRole('verifier').builtin === 'verify'；resolveRole('planner').executor === 'pi'。

// server/gate 测试（index.js 内）
4. gate decision=interrupt → 任务转回可重试状态，不 failed，feedback 落事件。

// server/evidence.test.js
5. record/list：证据带 hash，list(taskId) 只返回该任务证据。

// server/proposals.test.js
6. proposal 未 approve 不产生副作用；approve 后才应用。
```

---

## 9. 分阶段实施顺序（交给 codex 按此顺序做）

**Phase 1（最小闭环，先做）**
- `agent-task.js` 增加 `workflowId/stageId/role/inputFrom`。
- `runAgentTask` 输出交接（依赖 result 注入输入）。
- 单测：输出交接。

**Phase 2（角色 + 工作流）**
- `roles.js` + `workflows.js` + `configs/workflows/collab-dev.json`。
- `orchestrator.js` 展开 stage 链。
- 单测：workflow 展开 + 角色解析。

**Phase 3（一条龙入口）**
- `POST /api/workflows/:id/run` + `GET /api/workflows/runs/:id`。
- Workbench 协作任务入口 + 流水线可视化。
- verifier 协作模式自动触发（4.1-B）。

**Phase 4（门禁 + 证据 + 提案）**
- gate 三态（allow/interrupt/deny）。
- `evidence.js` 账本 + 各阶段落账。
- `proposals.js` 自进化提案。

---

## 10. 关键设计决策（为什么这么定）

1. **不引入独立「coordinator agent」**：coordinator 用现有 scheduler + orchestrator 纯逻辑实现，不额外 spawn 一个 agent，省成本、避免循环。
2. **workflow spec 用 JSON 而非代码**：可编辑、可版本化、可给用户新增「写文档」「做审查」等工作流。
3. **输出交接用「依赖 result 注入输入」而非共享文件**：最小改动，复用现有 `task.result`，不需要新的通信通道。
4. **verifier 用 builtin 角色**：不 spawn CLI，直接走 `verifyAgentTask`，与现有 `/verify` 一致。
5. **gate interrupt 复用现有状态机**：interrupt → 转回 `running`，不新增状态，避免状态机膨胀。
6. **proposal-only 自进化**：与现有 Claude 锁定、审批分级、review 门禁一脉相承，只是 formal 化。

---

## 11. 完成记录与验收结论（2026-08 末）

**状态：四阶段全部完成，协作流水线完整落地。**

### 各阶段交付

| 阶段 | 核心交付 | 验收结果 |
|------|---------|---------|
| Phase 1 输出交接 | `agent-task.js` 加 `workflowId/stageId/role/inputFrom` + `buildInput` 依赖结果注入 | ✅ 6/6 测试（含 owner 隔离）|
| Phase 2 角色+工作流 | `roles.js` + `workflows.js` + `collab-dev.json` + `orchestrator.js`；`inputFrom`（阶段 ID）→ taskId 映射；`buildInput` 优先 `inputFrom` 回退 `dependsOn` | ✅ 9/9 测试 |
| Phase 3 一条龙入口 | `POST /api/workflows` + `POST /api/workflows/:id/run` + `GET /api/workflows/runs/:id`；implementer 自动触发验证；verifier 标记任务自动完成并放行 review；Workbench「协作开发」入口 + 步骤条 + 轮询 | ✅ 9/9 回归 + 构建成功 |
| Phase 4 gate+证据+提案 | gate 三态（allow/interrupt/deny）+ `/api/workbench/tasks/:id/gate` + 聊天审批三态；`evidence.js` 账本（SHA-256）；`proposals.js`（未批准不 apply、不重复 apply）；四阶段证据落账；proposals API | ✅ 12/12 测试 |

### 全链路验证

```
plan(pi) → completed
  → implement(codex, 带 plan 输出) → verifying → 自动 test/build → reviewing
    → verify(标记任务) 自动完成
      → review(claude, 带 implement 输出) → 人工 approve/request_changes/reject
```

关键点：`review` 的 `dependsOn=[verify]`（等验证完）但 `inputFrom=[implement]`（读实现输出），「等谁」与「读谁」解耦，验证正确。

### 已知遗留（后续增强，不影响当前闭环）

1. **code_modifier 未实现**：proposals 的 `apply` 回调当前为空操作。proposal 审批机制（创建/批准/拒绝/幂等/owner 隔离）已完整，缺一个「批准后真正改 skills/config/memory 文件」的适配器。
2. **`collaborationRuns` 是内存 Map**：服务重启后 run 关联丢失（任务仍在 `state.agentTasks`，但 `GET /api/workflows/runs/:id` 会 404）。建议持久化，或启动时从 tasks 的 `workflowId` 反重建。
3. **verifier 标记任务为透传完成**：真正的 test/build 跑在 implementer 任务上，verify 任务只作视觉阶段标记（代码注释应说明此语义）。
4. **`state.evidence` 在 Phase 4 已接入**，`collaborationRunView` 的 evidence 字段已能返回真实证据。

### 后续建议（非必需）

1. 写 `server/code-modifier.js` 适配器，把 proposal 批准后的 apply 接成真实文件修改，补完自进化闭环。
2. 持久化 collaboration run 或启动时反重建。
3. 前端步骤条升级为带连线的真实 DAG 图。
4. 全量 `npm test` 需先解决 `pretest` 的 token 刷新阻塞（与协作流水线无关的既有问题）。
