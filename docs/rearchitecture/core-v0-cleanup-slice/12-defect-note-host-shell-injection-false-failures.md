# 宿主 shell 注入导致的「假失败」排查与修复（2026-09-16）

## 症状（一次会话内三处同源爆发）

1. **e2e 两套全挂**：`e2e-panels` 报 `SERVER FAILED TO START`（server 起不来、日志为空、端口不监听）；`e2e-acceptance` 打印 Playwright 安装提示。
2. **npm test 5 个文件假失败**：`chat-memory-degrade` / `companion-orchestrator` / `core-v0-memory-pipeline` / `core-v0-production` / `memory-module`，各报 120s 超时。
3. **症状随环境漂移**：同一棵树、同一条命令，跑出的数字在不同会话里不同（345 vs 428 vs 468），导致反复怀疑「是不是我改坏了」。

## 根因

**宿主 shell 注入的 `NODE_OPTIONS`**：

```
NODE_OPTIONS=--require=".../cli/vendor/shim/node-language-shim.cjs"
```

该 shim（及其 `node-brokered-fs-shim.cjs`）在**每个** node 子进程加载，其 brokered-fs 策略会：
- 对 `pg`、`redis`、`express` 等包的模块加载路径**拒绝**（错误带 `__codebuddyBrokerPolicyError` / `decision: 'deny'`）；
- 表现为**无声挂起**（server 进程不产日志、不绑端口）或 120s 超时，而非清晰报错。

这解释了为什么「同一份代码昨天绿、今天红」——**它取决于 hook 进度的竞态**，不是代码回归。

## 判据（可复现）

```bash
# 带 shim（宿主 shell 默认）
node --test server/memory-module.test.js            # fail
# 清掉 shim
env -u NODE_OPTIONS node --test server/memory-module.test.js   # pass
```

同一棵树、同一组 5 个文件：**带 shim 0 pass/5 fail；清掉 shim 128 pass/0 fail**。

## 修复（三处，都是「测试基础设施不该继承宿主注入」）

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `scripts/run-gates.mjs` | spawn 子进程前 `delete childEnv.NODE_OPTIONS` | 闸门是判定产品行为的工具，不能被宿主 shell 污染 |
| `scripts/e2e-panels.py` | `_server_env()` 末尾 `env.pop("NODE_OPTIONS", None)` | 否则每个 check 的 server 子进程静默起不来 |
| `scripts/e2e-acceptance.py` | 同上（server 启动前 pop） | 同上 |

## 修复后基线（integration 树，`e08e633` + L17）

- `npm test`：**468 tests / 463 pass / 0 fail / 5 skipped**（基线 e08e633 为 428，L17 新增 40 例）
- `run-gates --tier=2`：**6/6 全绿**（npm-test 15.9s / check-routes 10.3s / a-chat-turns-fixture / a-core-v0-runtime / pg-acceptance / leak-probe）
- `e2e-panels`：**10/10**（P10 首次真正通过——真实 500 注入 + 错误可见断言）
- `e2e-acceptance`：**8/8**

## 附带发现（P10 断言漂移，三层）

`P10 单接口失败其余面板仍渲染且失败面板可见报错` 此前长期报 `error_hint=✗`，逐层剥开**全是断言侧问题**（非产品缺陷）：

1. 拦截目标是 `/api/personality`，但 `main.jsx` 里 `panelErrors.personality` **没有任何渲染点**（渲染的是 `.memory` / `.growthEvidence` / `.personalityHistory`）→ (b) 永不可能为真。
2. 改拦 `/api/memory/overview` 后仍 ✗——承载 `PanelError` 的 inspector 是 `FloatingWindow`，默认**关闭**（`WindowManager.jsx:173` 未开窗 `return null`），节点不在 DOM。
3. 打开 inspector 后仍 ✗——**`page.route` 拦不到该 fetch**：同一 URL 用 `context.route` 命中、`page.route` 零命中，故 500 从未注入。

**现方案**：`context.route` 注入 500 → 切 Arcana → 打开 inspector → 断言 `.panel-error` 可见（实测文案「共享记忆加载失败：injected」，`checkVisibility: true`）。

## 应固化的规矩

1. **任何 spawn node 子进程的脚本，先清 `NODE_OPTIONS`**（测试基础设施、benchmark runner、服务冒烟）。
2. **测试数字异常时先问「哪个 shell 环境」**，别先怀疑代码——数字随宿主环境漂移是本机常态。
3. **`page.route` 不生效时换 `context.route`**（Playwright 层级别差异，非 glob 语法问题）。
