# 上游集成决策备忘录（工作分支 × upstream/main）

日期：2026-09-13
作者：lane/l5-merge-memo 研究任务
对象分支：`lane/l5-merge-memo`（基线 `f793c4d`，即 `codex/core-v0-foundation` 同根）
上游：`upstream/main` = `fd0a7d5`（领先本仓 `main` 的 `7e86878` 共 17 提交，纯线性后代）
配套文档：`docs/upstream-sync-assessment-2026-09-12.md`

---

## 0. 实测方法与终态验证（必做项）

**冲突预演（真实、一次性、已中止）**

```
cd <worktree>
git checkout -b tmp/merge-rehearsal
git merge --no-commit --no-ff upstream/main      # 真实冲突，未提交
# 逐文件抽取冲突块（见第 1 节）
git merge --abort                                 # 中止，不落合并提交
git checkout lane/l5-merge-memo
git branch -D tmp/merge-rehearsal                 # 清理临时分支
git status --porcelain                           # 应为空
```

**终态（本报告产出前已复核）**

| 项 | 值 |
|---|---|
| 当前分支 | `lane/l5-merge-memo` |
| HEAD | `f793c4de77900a39bbd74c8106f46812fbcb5318` |
| `git status --porcelain` | 空（worktree 干净） |
| 未合并文件数（`git diff --name-only --diff-filter=U`） | 0 |
| 临时分支 `tmp/merge-rehearsal` | 已删除 |

> 预演结果 **15 处冲突**，与 `upstream-sync-assessment-2026-09-12.md` 第 2 节 `git merge-tree` 预演完全一致；本次用真实 `--no-commit --no-ff` 复核，冲突文件清单、分类、语义均逐项实测，无编造。

---

## 1. 逐文件冲突清单（自己实测）

冲突计数口径：**按文件计 15 处**（其中 `server/model-provider.js` 含 11 个冲突块、`client/src/main.jsx` 含 10 个冲突块、`server/index.js` 与 `server/runtime-context.js` 各为整文件 1 个巨型冲突块）。

| # | 文件 | 类型 | 语义域 | 实测冲突内容语义 |
|---|---|---|---|---|
| 1 | `.gitignore` | content | 其他（忽略规则） | 我方补 `artifacts/*.log`/`.workbuddy/`/`__pycache__/`；上游补 `*.log`/`_*.tmp.mjs`。两段互不重叠，机械合并即可。 |
| 2 | `client/src/life/LifeCalendar.jsx` | modify/delete | 其他（client life 模块） | 我方删除、上游继续修改。冲突区无标记，上游版本整文件留在树中。 |
| 3 | `client/src/life/LifeGame.jsx` | modify/delete | 其他（client life 模块） | 同上，我方删除、上游继续修改。 |
| 4 | `client/src/main.jsx` | content | 客户端 UI 装配（含 chat 接线） | 10 块：import 区（我方 `./chat/message-utils.js`+`panels/`；上游 `./lib/utils`+`./components/panels`）、`companionIntent`、wakeup 设置块、chat 面板接线等。 |
| 5 | `client/src/styles.css` | content | 客户端样式 | 响应式 CSS 一处差异：上游多出 `.task-launcher`/`.task-form`/`.task-list`（agent workbench 相关）。机械合并。 |
| 6 | `client/src/workspace/SettingsWindow.jsx` | content | 客户端设置面板 | 我方导出 `SettingsBody({onClose})`；上游改为 `SettingsWindow({onClose,onExport,onImport})`（重命名 + 加导入/导出）。 |
| 7 | `package.json` | content | 构建/测试脚本 | 我方 `test` 含 `client/src/chat/*.test.js`；上游加 `pretest: refresh-test-tokens` 且 `test` 仅 `server/*.test.js`。 |
| 8 | `server/chat-memory.js` | content | **chat runtime / 记忆检索（agent 域）** | `retrieve()` 一处：`readScope = {agentId: callerAgentId}`（我方 2a 服务端注入）vs `retrieve(query, agentId)` 参数透传（上游）。agent 域隔离语义直接碰撞。 |
| 9 | `server/index.js` | content | **chat runtime / routes（整体入口重写）** | 整文件 1 巨型块（L1–L1317）。我方：`createTurnStreamHandler`/`core-v0-production`/`memory-service-boundary`/`chat-route-contract`/`resolveAgentIdForRequest`（turns/work 拆分）；上游：`runtime/chat-runtime.js`+`runtime/agent-runner.js`+`routes/*.js`（misc/music/sessions/agents/memories/profile/workflows/workbench/wake）模块化。**核心结构冲突**。 |
| 10 | `server/mcp-client.js` | modify/delete | 其他（server MCP 工具） | 我方删除、上游继续修改。 |
| 11 | `server/memory-module.js` | content | **memory / 写入侧溯源（agent 域）** | `sanitizeMetadata` 白名单：我方含 `producer`/`correlation_id`/`context_snapshot`；上游含 `source_agent_id`（即 `92225a6` 的写入侧标记）。与 §3 吸收点直接对应。 |
| 12 | `server/model-provider.js` | content | **agent runner / 系统提示（身份）** | 11 块。`DEFAULT_SYSTEM_PROMPT`：我方"你是 Cochpia，一个重视共同经历…的 AI 伴侣"；上游"你是一个独立的 AI Agent…"+`SAFETY_BOUNDARIES`+`COMPANION_INTENT_LABELS`（去除硬编码 Cochpia 身份）。 |
| 13 | `server/runtime-context.js` | content | **chat runtime / 上下文装配** | 整文件 1 块（L1–L204）。我方 R-020 2a 的 **degradable sections**（`RUNTIME_CONTEXT_SECTIONS`：memory/personality/agentPersona/profile/history/lifeTexture，单段失败只降级自身）；上游单体 `buildRuntimeContext`（含 `innerState`/`dynamicRouting`/`groupContext`/`dynamic`/`findRegenerationTarget`）。 |
| 14 | `server/sync-service.js` | modify/delete | 其他（server 同步服务） | 我方删除、上游继续修改（且 `index.js` 上游侧 `import {collectSyncChanges} from './sync-service.js'`）。 |
| 15 | `server/sync-service.test.js` | modify/delete | 其他（server 同步服务测试） | 同上，我方删除、上游继续修改。 |

**冲突块统计**：15 文件 = 10 content + 5 modify/delete；content 类内部合计 **23 个冲突块**（index.js 1 + runtime-context.js 1 + model-provider.js 11 + main.jsx 10 + 其余单块）。

---

## 2. 冲突分类

### 2a. 上游重写了我方已删除的 legacy（modify/delete，5 处）
`LifeCalendar.jsx`、`LifeGame.jsx`、`mcp-client.js`、`sync-service.js`、`sync-service.test.js`。
**性质**：我方在 core-v0/R-020 中已删除这些模块（life 模块、旧 MCP 客户端、旧同步服务），上游在其 17 提交中继续演进它们。
**处理**：对我方是**零信息损失**——直接 `git rm` 丢弃上游版本（保留我方删除），无需语义仲裁。这是 15 处里成本最低、风险最低的一类。

### 2b. 上游重构 vs 我方 turns/work 拆分（content，结构性碰撞）
核心三处：`server/index.js`（路由装配入口）、`server/runtime-context.js`（上下文构造）、`server/chat-memory.js`（检索期 agent 域）。
外围绕：`server/model-provider.js`（agent 身份/系统提示）、`server/memory-module.js`（写入侧溯源白名单）。
**性质**：两边都在重写同一结构骨架——我方把链路拆成 `/api/chat/turns` 与 `/api/chat/work`（单一真源 `chat-route-contract.js`，App Runtime 管 session、Core PG 管 turn 准入/commit/receipt、Memory PG 管 raw events/assertions），上游则就地抽出 `runtime/chat-runtime` + `runtime/agent-runner` + `routes/*`。不能"取一边"，必须重新决策"chat runtime 语义归谁"。

### 2c. 低语义 content（非结构，机械合并即可，4 处）
`.gitignore`、`client/src/styles.css`、`package.json`、`client/src/workspace/SettingsWindow.jsx`。
**性质**：忽略规则、响应式样式、测试脚本、设置面板导出入口——与 chat runtime 骨架无关，逐文件取并集/小改即可，无架构风险。

**分类摘要**：结构性碰撞（2b）= 5–6 文件才是真正难点；legacy 删除（2a）= 5 文件零成本；机械合并（2c）= 4 文件低成本。

---

## 3. 三个集成方案对比

### 方案 A：把我方工作移植到 upstream/main 之上
新开集成分支，把"我方独占提交"cherry-pick / rebase 到 `upstream/main`（`fd0a7d5`）之上。

- **工作量**：高。我方自 `7e86878` 起改动约 220 文件、大量提交；rebase 会逐提交重放并触发同样的 15+ 冲突（且因逐提交更碎）。实质等于**用上游 runtime 骨架重写 core-v0**——把 `index.js`/`turn-stream`/`core-v0-production` 改为适配 `runtime/chat-runtime`+`routes/*`。提交量级：数十~上百次冲突仲裁。
- **风险**：高且不可逆地牺牲证据。我方 A-01~A-12 闸门与 core-v0 acceptance 基于现有结构；移植后这些测试须重写，已冻结的 promotion 证据失效。
- **未来同步成本**：低（直接跟 `upstream/main`，后续快进顺）。
- **chat runtime 语义归谁**：归**上游**（我方 adopting 其 `runtime/chat-runtime`+`routes`）。我方 `chat-route-contract.js` 单一真源被上游骨架取代。

### 方案 B：把 upstream/main merge 进我方分支（就地解 15 处）
在当前 `lane/l5-merge-memo` 上 `git merge upstream/main`，手工解 15 处冲突。

- **工作量**：高。15 文件、23 冲突块，其中 `index.js`/`runtime-context.js` 为整文件重写需手工缝合；`model-provider` 11 块、`main.jsx` 10 块逐块仲裁；解完须重跑全部闸门。一次大合并。
- **风险**：高，且**污染已冻结的 promotion 闸门证据**（与 `upstream-sync-assessment-2026-09-12.md` §4.1 结论一致：现在不要 merge）。把"集成"变成"项目"，打断 core-v0 收尾。
- **未来同步成本**：中（产生 merge commit；在架构收敛前，后续同步仍需反复解同类冲突）。
- **chat runtime 语义归谁**：需重新决策。若保留我方 core-v0 turn 准入/commit 模型，则须用上游 `routes/*` 替换我方 `index.js` 路由装配——两者契约不兼容，缝合点即隐患点。

### 方案 C：维持双线，只 cherry-pick 需要的上游增量
不合并、不移植；仅把上游中**与我方 core-v0 存储/链路收口正交、且能独立落地**的增量吸收进来。

- **工作量**：极低。最值得拿的 `92225a6`（写入侧 `source_agent_id` 溯源）我方已用 2b 独立实现且发现 `actorType='user'` 绕过关系域的隐患（上游大概率仍有）；可落地的补强是给 `sanitizeMetadata` 白名单加 `source_agent_id` 并在写入路径打标——纯新增，不碰合并。其余上游增量（wakeup 引擎、inner 主观连续性、agent workbench/orchestrator/verifier）属产品能力，与 Core v0 收口正交，本期不拿。
- **风险**：低。不碰已冻结证据、不引入架构碰撞；`92225a6` 思路的吸收以独立提交 + 重跑闸门完成，可复跑对照用例 `scripts/probe-agent-scope-leak.mjs` 验证。
- **未来同步成本**：零合并负担；但两条线长期分叉，正式集成仍需在收尾后单独立项（只是推迟，非放弃）。
- **chat runtime 语义归谁**：明确归**我方**（core-v0 turns/work 是我方单一真源；上游 runtime 暂不引入）。

---

## 4. 推荐

**推荐方案 C（维持双线 + 仅吸收可独立落地的上游增量）**，正式集成推迟到 core-v0 promotion 收尾之后单独立项。

**Rationale（技术判断，不和水泥）**：

1. 15 处冲突里 **5 处是我方已删除的 legacy**（modify/delete，零信息损失，直接丢弃），**4 处是低语义机械合并**（.gitignore/styles/css/package.json/SettingsWindow），真正结构性碰撞只有 `index.js`+`runtime-context.js`+`chat-memory.js` 三处——而这三者正是"我方已冻结的 core-v0 收口" vs "上游未落在我们 promotion 窗口内、且与我们语义冲突的重构"。
2. 在 promotion 收尾前做方案 B（merge）会**污染已冻结的 A-01~A-12 闸门证据**，把收尾变成集成项目；做方案 A（移植）等于**放弃已验证的 core-v0 架构与 `chat-route-contract.js` 单一真源**，用上游骨架重写 turn 准入/commit——代价远超收益，因为上游重构与本仓"删 legacy + 拆 turns/work"是**语义冲突**而非单纯文本冲突。
3. 方案 C 把"集成"与"收口"**解耦**：先在双线下把 `92225a6` 的写入侧溯源作为 R-020 补强独立落地（不依赖合并、可复跑对照用例验证 `leak=false`），保住已验证证据；待收尾后再开新分支评估 A vs B 做正式集成。这是唯一**既不牺牲已验证证据、又不丢弃上游价值**的路径。
4. `92225a6` 的"写入侧 `source_agent_id` + 检索期按来源过滤"恰补我方 R-020 2a 的已知缺口（作用域 ≠ 来源，`user` 域未按来源隔离）；该补强可**不合并即做**，是 C 优于"完全不动"的关键动作。

---

## 5. 集成检查单（选中方案 C 的执行顺序 + 每步闸门）

> 闸门提醒：**本项目闸门脚本不在 `npm test` 里**；任何结构性改动后必须重跑；**两套 A-01~A-12 都要跑**；`npm run check:routes` 验路由契约（即 `server/chat-route-contract.js` 单一真源）。

### 阶段一：立即执行（双线吸收，不合并）

- [ ] **C-1** 确认 worktree 干净、分支正确：`git status --porcelain` 为空、当前 `lane/l5-merge-memo`、HEAD `f793c4d`（本报告 §0 已验证）。
- [ ] **C-2** 在 `server/memory-module.js` 的 `sanitizeMetadata` 白名单加入 `source_agent_id`（吸收 `92225a6` 写入侧标记）；在 `server/chat-memory.js` 写入路径打标。**闸门**：跑两套 A-01~A-12；`npm run check:routes`；`node --test server/*.test.js`。
- [ ] **C-3** 跑对照用例 `scripts/probe-agent-scope-leak.mjs`（真实 drain 路径：raw event→candidate→user actor promote，再让 agent B 带 `readScope={agentId:'agent-b'}` 检索）。**闸门**：断言 `agentB_sees === false` 且 `provenanceFieldPresent === true`；旧记忆兼容规则明确写入契约（未标记 = 全局可见，沿用上游 `92225a6` 语义）。
- [ ] **C-4** 若 C-3 未过，回退 C-2 并定位（缺口即 R-020 写入侧溯源补强立项，不进 promotion 范围）。**闸门**：两套 A-01~A-12 复绿。

### 阶段二：core-v0 promotion 收尾（先于任何集成）

- [ ] **C-5** 在已验证状态上完成 promotion 收尾；**闸门**：两套 A-01~A-12 全绿 + `npm run check:routes` + 全量 `node --test server/*.test.js client/src/chat/*.test.js`。
- [ ] **C-6** 在 `origin/main` 上 fast-forward 到 `upstream/main`（`fd0a7d5`，本仓 main 是其祖先，零冲突）。**闸门**：`git merge --ff-only upstream/main` 成功、worktree 干净。

### 阶段三（推迟）：正式集成立项（A vs B 二选一，不在本期）

- [ ] **C-7** 新开集成分支（如 `lane/integrate-upstream-runtime`），**不**在 `lane/l5-merge-memo` 上直接 merge。
- [ ] **C-8** 若选 B：真实预演 `git merge --no-commit --no-ff upstream/main` → 解 `index.js`/`runtime-context.js`/`chat-memory.js` 三处结构冲突时，**先裁定 chat runtime 语义归属**（保留我方 core-v0 turn 准入/commit，还是 adopting 上游 `runtime/chat-runtime`）。**闸门**：解完须两套 A-01~A-12 + `npm run check:routes` + 全量测试；`git merge --abort` 兜底可随时回退。
- [ ] **C-9** 若选 A：在 `upstream/main` 之上 rebase 我方独占提交，逐提交解冲突并重写受影响的 core-v0 测试。**闸门**：同 C-8，且须重跑 core-v0 acceptance（`npm run acceptance:core-v0*`）。
- [ ] **C-10** 无论 A/B，结构性改动后**两套 A-01~A-12 必跑、`npm run check:routes` 必跑**；任一闸门红即中止并回退临时合并。

---

## 6. 一句话结论

15 处冲突中 5 处为可零成本丢弃的我方已删 legacy、4 处机械合并、仅 3 处结构性碰撞——在 core-v0 promotion 收尾前**不要 merge（B）也不要移植（A）**，先用方案 C 把 `92225a6` 写入侧溯源独立吸收，收尾后再单独立项做正式集成决策。

---

## 7. 裁决（2026-09-14 00:35，老板拍板）

**方案 C 定案：走双线，本仓库（`CovD831/Cochpia` fork）作为独立项目运营。**

- **不 merge（B 永久出局，除非未来重新立项）**：§6 所述「promotion 收尾后单独立项做正式集成决策」**不再排期**——独立项目姿态下，上游 `runtime/chat-runtime` / `routes/*` / agent runner 的就地重构**不跟进**。
- **吸收协议**：上游有价值提交逐个评估——语义兼容直接 cherry-pick；不兼容按 `92225a6` 先例在我方架构内重实现（2b 已是该先例的落地）。
- **本仓 `main` 分支的角色**（开放项，不紧急）：现状仍是 `upstream/main` 的镜像（`fd0a7d5`）。独立项目姿态下，将来要么维持「上游镜像」语义（低频同步、永不并入产品线），要么某次里程碑时把产品线扶正为 trunk。届时单独立项。
- **§5 阶段三（推迟）整节作废**：C-7~C-10 不再执行；A/B 对比保留原文作历史记录。
- 决策背景：并行波次 L5 lane 实测 15 处冲突（10 内容 + 5 modify/delete，仅 3 处结构碰撞）+ 本备忘录 §1–§6 分析；裁决由老板在波次收口后作出。
