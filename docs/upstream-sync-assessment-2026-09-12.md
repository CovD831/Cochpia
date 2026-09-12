# 上游仓库同步评估（ksys404/Cochpia → 本 fork）

日期：2026-09-12
评估对象：`https://github.com/ksys404/Cochpia.git`（原仓库，下称 upstream）
本仓库：`https://github.com/CovD831/Cochpia.git`（fork，origin）

## 1. 拓扑事实

| 项 | 值 |
|---|---|
| 本仓 `main` | `7e86878`（2026-08-24）feat: update workspace UI and memory infrastructure |
| upstream `main` | `fd0a7d5`（2026-09-10）feat: agent workbench, voice auto-read, and cross-agent isolation |
| 关系 | `7e86878` **就是 merge-base** → upstream/main 是它的**纯线性后代**，无分叉 |
| upstream 领先 | **17 个提交**（2026-09-03 ~ 09-10） |
| 本仓 main 独占 | **0 个提交** |
| 工作分支 | `codex/core-v0-foundation` 同样以 `7e86878` 为根（main 是其祖先） |

结论：**本 fork 的 main 已经 2.5 周没同步上游，且同步是干净的快进（fast-forward），没有历史分叉。**

### 上游 17 个提交

```
2026-09-03  1508f90 refactor(server): extract chat runtime (Phase 1, zero behavior change)
2026-09-03  f76b2dd refactor(server): extract routes and agent runner (Phase 2, zero behavior change)
2026-09-03  7064667 feat(work-mode): prioritize native tools with approval
2026-09-03  abfe3c7 feat(agents): add primary/sub role
2026-09-03  7ba0c2b refactor(ui): remove hardcoded Cochpia identity
2026-09-03  20d837b fix(ui): primary toggle in agent profile + chat session-list empty state
2026-09-03  4b93ff7 chore(model): commit pending prompt & context refactor
2026-09-03  64a274f feat(inner): subjective continuity across runs
2026-09-03  fea35e6 fix(inner): lazy-init per-user state + normalize tool contract
2026-09-04  f4ff477 feat(wakeup): spontaneous activation engine
2026-09-04  cf08405 feat(wakeup): per-user preference + frontend toggle
2026-09-04  d1f41ee docs: runtime refactor & identity & inner/wakeup specs
2026-09-04  59c5ece feat(agents): one-click persona import with auto-parse
2026-09-04  7dabae0 style(ui): uiverse chat refinements + agent import panel
2026-09-04  181580e fix(model): strengthen persona injection for imported characters
2026-09-04  92225a6 fix(memory): scope retrieval by agent to stop cross-agent persona leak
2026-09-10  fd0a7d5 feat: agent workbench, voice auto-read, and cross-agent isolation
```

`fd0a7d5` 是 73 文件的大提交：新增 agent scheduler/task、code modifier、claude/codex clients、
dynamic alpha router、evidence、orchestrator、proposals、roles、task sandbox、verifier、
workflows、music MCP、xiaohongshu tools；客户端新增 WorkbenchPage。
**同时删除 `server/personality.js` / `server/personality.test.js` / `server/psychology.js` /
`server/psychology.test.js`（标注 superseded）。**

## 2. 与工作分支的合并预演（`git merge-tree`，无副作用）

上游 17 提交改动 112 个文件，本分支改动 220 个文件，**交集 22 个**。

预演结果：**15 处冲突**

- 内容冲突（10）：`.gitignore`、`client/src/main.jsx`、`client/src/styles.css`、
  `client/src/workspace/SettingsWindow.jsx`、`package.json`、`server/chat-memory.js`、
  `server/index.js`、`server/memory-module.js`、`server/model-provider.js`、
  `server/runtime-context.js`
- modify/delete（5）：`client/src/life/LifeCalendar.jsx`、`client/src/life/LifeGame.jsx`、
  `server/mcp-client.js`、`server/sync-service.js`、`server/sync-service.test.js`
  （本分支删除、上游继续修改）

**语义冲突比文本冲突更麻烦**：上游就地重构 chat runtime / routes / agent runner
（Phase 1 & 2），本分支则删掉 legacy chat stream 并把链路拆成 `/api/chat/turns` 与
`/api/chat/work`。两边都在动同一块结构的骨架，冲突不能靠"取一边"解决，必须重新决策。

## 3. 最值得吸收的一条：上游的记忆按 agent 隔离

**`92225a6`（2026-09-04）与我们 R-020 阶段 2a（2026-09-10）是同一个跨 agent 泄漏的
两次独立修复。** 上游的实现：

- **写入侧打标**：raw event metadata 增加 `source_agent_id`（加进 metadata 白名单）
- **读取侧过滤**：
  - `scopeType === 'relationship'` → 必须等于 `relationshipAgentId`
  - 其余 → 取该断言版本所有 `sourceType === 'raw_event'` 的来源，
    要求 `every(sourceAgentId => !sourceAgentId || sourceAgentId === agentId)`
- **向后兼容规则**：**没有 `source_agent_id` 的旧记忆对全部 agent 可见**
- agent 自述归入 relationship 作用域
- 新增回归测试：Cody 可见、其它 Agent 不可见
- 作用面：`list()` / `retrievalDocuments()` / 断言 / 原生检索 / 当前状态 / episodes

我们的实现：读侧收窄 `readScope = { agentId }`（服务端注入，源自 `session.agentId`），
`callerAgentId` 三级解析（serviceIdentity > dev header > `session.agentId`），**不改 actorType**。

### 差异与真实的差距

| 维度 | 上游 | 本仓 R-020 | 判断 |
|---|---|---|---|
| 写入侧溯源标记 | 有（`source_agent_id`） | 无 | **上游更强** |
| 读取侧过滤 | 按来源标记严格过滤 | 按 readScope 收窄可见性 | 各有所长 |
| 旧记忆兼容 | 显式规则（未标记 = 全局可见） | 未在契约中显式定义 | 需我们补 |
| 治理面 | 不涉及 `hasGrant`/actorType | 已定位 `actorType='user'` 绕过全部关系域隔离 | **我们发现了他们大概率仍有的隐患** |

**可吸收点（不需合并即可做）**：把「写入侧 `source_agent_id` 溯源 + 检索期按来源过滤」
作为 R-020 记忆隔离的补强。理由：**单靠读侧 scope 收窄，一条本属 A agent 的断言若
在 topic 上被 B 命中，仍可能进入 B 的上下文**；有来源标记才能从数据面把这条路堵死。

### 已验证：假设成立，缺口是真的（2026-09-12）

对照用例已落地并可复跑：`scripts/probe-agent-scope-leak.mjs`。走 drain 的真实路径
（raw event → candidate → user actor promote），断言落成 `scopeType='user'`，然后让
agent B 带 `readScope = { agentId: 'agent-b' }` 检索：

```json
{ "rawEventMetadata": {}, "provenanceFieldPresent": false,
  "agentA_sees": true, "agentB_sees": true, "leak": true }
```

- **B 检索到了 A 私聊产生的断言**，readScope 没有挡住。
- **写入侧无任何来源标记**：`rawEventMetadata` 为空，`sanitizeMetadata` 的白名单里
  没有 `source_agent_id` —— 今天连「打标」这个动作都做不到。
- 机制：`readScope` 只收窄 `relationship` / `life` 域；`user` 域按设计对任何 scope 可见
  （`agent-scope-2a.test.js` R-4 明确要求如此，因为治理/导出视图需要看全）。
  **作用域与来源是两个维度**，2a 只处理了前者。

结论：这不是 2a 的实现 bug，而是**范围缺口**——写入侧溯源需要单独立项，不能算作
promotion 的收尾项。在补上之前，任何「记忆已按 agent 隔离」的表述都应限定为
「relationship / life 域已隔离，user 域未按来源隔离」。

## 4. 结论与建议路径

1. **现在不要 merge 上游进 `codex/core-v0-foundation`**。15 处冲突 + chat runtime 重构的
   语义冲突，会把 promotion 收尾变成一次集成项目，污染已冻结的闸门证据。
2. **推荐顺序**：promotion 在当前已验证状态上收尾 → 之后在 `main` 上
   **fast-forward 到 `upstream/main`**（我们的 main 正是其祖先，零冲突）→
   再单独立项做「R-020 链路拆分 × 上游 chat runtime 重构」的集成决策。
3. **立即可做**：上面第 3 节的可吸收点——先跑对照用例验证差距是否真实存在，
   再决定是否把来源标记纳入 R-020 范围。
4. **不进 promotion 范围**：wakeup 自发激活引擎、inner 主观连续性、agent workbench /
   orchestrator / verifier 等属于产品能力，与 Core v0 的存储与链路收口正交。

## 5. 复现命令

```bash
cd repo-main
git remote add upstream https://github.com/ksys404/Cochpia.git   # 已添加
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy git fetch upstream

git log --oneline origin/main..upstream/main          # 上游领先的 17 个提交
git diff --name-only 7e86878 upstream/main | sort     # 上游改动面
git diff --name-only 7e86878 HEAD | sort              # 本分支改动面
git merge-tree --write-tree --name-only HEAD upstream/main   # 冲突预演（无副作用）
```
