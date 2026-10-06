# 阶段 1「让护城河露出来」— 并行开发计划

> 基线：`72405d7`（PR #10 合并结果）· 工作树 `wt/phase1` · 分支 `lane/phase1-sovereignty`
> 基线 measure：`npm test` = **601 tests / 596 pass / 0 fail / 5 skipped**

## 一、起点判断（先说清楚为什么这么切）

**侦察得出的关键事实**（不是猜的，是 grep 出来的）：

1. **后端能力已经齐全，缺的只是 HTTP 层和 UI。**
   `server/memory-module.js` 的返回对象里已经有：
   `correct` / `pin` / `unpin` / `revoke` / `forget` / `forgetSourceEvent` /
   `forgetSession` / `forgetRelationship` / `forgetAccount` /
   `deleteSourceEvent` / `deleteSession` / `deleteRelationship` / `deleteAccount` /
   `list`（带分页）/ `getDeletionOperation` / `listConfirmations`
   但 `server/index.js` 里**只暴露了 `/api/memory/overview` 一个只读路由**。
   ⇒ 「记忆主权」不是造能力，是**把已有能力接到用户手上**。

2. **`client/src/main.jsx` 是唯一的并行瓶颈**（1129 行）。
   所有功能都想改它 ⇒ 若两个 track 同时改，必然冲突。
   ⇒ 切分原则：**每个 track 写自己的新文件；`main.jsx` 只由「集成」这一个 track 改。**

3. **i18n 碰每一个文件**（3,771 处硬编码中文，i18n 只有 20 个 key）。
   ⇒ **i18n 不能与任何 track 并行**，否则它和所有写域重叠。
   ⇒ 本阶段**不做全量 i18n 改造**（那是独立大工程），只做「新增 UI 不产生新的硬编码债务」。

## 二、验收标准（人的部分 —— 来自既有检查，不是我为这次现写的）

| 用途 | 命令 | 为什么它够格当 measure |
|---|---|---|
| 单测 | `npm test` | **改动前就存在**，基线 601/596/0/5 |
| 闸门 | `node scripts/run-gates.mjs --tier=1` | 已有，4 道 |
| 面板 e2e | `scripts/e2e-panels.py` | 已有，13 项；**新增检查会追加，但既有 13 项必须全绿** |
| 验收 e2e | `scripts/e2e-acceptance.py` | 已有，8 项 |

**★ 纪律（来自 workbench-dev-team §一）**：
不为这次任务**新写**脚本当 measure。新增的 e2e 检查是**交付物**，不是裁判；
裁判仍是既有的四个命令，且它们的通过数不得下降。

## 三、任务切分（写域互不重叠）

| ID | 任务 | 写域（具体文件） | 依赖 |
|---|---|---|---|
| T1 | 记忆治理 HTTP 层（list/correct/pin/revoke/forget/delete） | `server/memory-governance-routes.js`（新建）、`server/index.js`（仅挂载） | — |
| T2 | 记忆主权面板组件（纯 UI，props 驱动） | `client/src/panels/MemorySovereigntyPanel.jsx`（新建） | — |
| T3 | 首次引导 + 空状态组件 | `client/src/onboarding/FirstRunGuide.jsx`（新建） | — |
| T4 | 后端治理层单测（真实模块，行为层） | `server/memory-governance.test.js`（新建） | T1 |
| T5 | 面板/引导纯函数与行为单测 | `client/src/panels/*.test.js`（新建） | T2、T3 |
| T6 | **集成**：接线进 main.jsx（导航、面板挂载、首页成长证据） | `client/src/main.jsx`、`client/src/styles.css` | T1–T3 |
| T7 | e2e 新增检查（记忆面板可打开且能删） | `scripts/e2e-panels.py` | T6 |
| T8 | 独立审计 | 只读 | T4–T7 |

**为什么 T1/T2/T3 能并行**：三者写**不同的新文件**，互不引用。
T6 是唯一的 `main.jsx` 写者，必须在 T1–T3 之后（它要 import 它们）。

## 四、明确不做（防止范围蔓延）

- **不做全量 i18n**（3,771 处，是独立工程；本阶段只保证新增 UI 不新增硬编码）。
- **不改 `repo-main`**（它停留在 `4d245d8`，有另一个会话的 11 个未提交文件）。
- **不动 `/api/memory/overview` 的既有契约**（PR #10 刚修好的 `count`/`truncated`）。
- **不做账号注销的 UI 全流程**（后端 `deleteAccount` 存在，但涉及二次确认与合规文案，
  需要单独裁决；本阶段只做记忆条目的治理）。

## 五、完成判据

1. `npm test` ≥ 基线通过数（596），且 fail=0
2. `node scripts/run-gates.mjs --tier=1` 4/4
3. `scripts/e2e-panels.py` 既有的 13 项全绿 + 新增项全绿
4. `scripts/e2e-acceptance.py` 8/8
5. 独立审计：确认「删掉的记忆真的不可读回」（这是主权的核心，必须实测而非声称）
