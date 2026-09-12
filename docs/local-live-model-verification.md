# 本地真实模型端到端验证

> 2026-09-13 实测通过。用于在本机把「真实模型 → Core v0 → PG → 前端 UI」整条链路跑起来并验证。

## 前置

- PostgreSQL 17.11 已在 `5433` 运行（`pg-data/`）
- `.env` 配好 `MODEL_PROVIDER=deepseek` + `MODEL_DEEPSEEK_API_URL` + `MODEL_DEEPSEEK_API_KEY` + `MODEL_DEEPSEEK_NAME`
- Playwright 浏览器已安装：`python -m playwright install chromium`（**缺失时 e2e 会以「浏览器不存在」失败，容易被误判为功能缺陷**）

## 起服务

后端（**必须在 8787** —— vite 的 `/api` 代理写死指向它）：

```bash
AUTH_MODE=off NODE_ENV=development node --env-file=.env server/index.js
```

前端：

```bash
npx vite --host 127.0.0.1 --port 5173
```

就绪检查：

```bash
curl -s --noproxy '*' http://127.0.0.1:8787/api/health
# 期望：storageProvider=postgres, storageReady=true, modelName=<你的模型>, modelReady=true
```

## ⚠️ 两条必须知道的约束

### 1. `STORAGE_PROVIDER=json` 时走的是 mock，不是真实模型

`server/index.js:262-270`：只有 `storageProvider === 'postgres'` 分支读 session / env 的模型配置
（`:254-255`）。非 postgres 分支走 `createCoreV0LocalAdapter({ ..., modelProvider: 'mock' })`——
**硬编码，且没有注释说明这是有意的**。

后果：用 json 存储做本地开发时，**看不到真实模型行为**。回复会是一条固定 mock 文案
（「我听见了：…」，约 40ms 返回），而真实模型约 1.5–1.7s。

**判别真假模型的三个信号**：耗时（~40ms vs 1500ms+）、内容（固定模板 vs 个性化文本）、
以及 mock 文案在 `server/model-provider.js:100-106` 可逐字比对。

### 2. e2e 脚本会写 `server/data/state.json`

`scripts/e2e-acceptance.py` 与 `scripts/e2e-panels.py` 都用 `STORAGE_PROVIDER=json`，
但**都不设 `COCHPIA_DATA_DIR`**。`server/store.js:9-10` 的默认落点是
`<repo>/server/data/state.json` —— 那是切流前的**回滚 / 对账副本**。

**跑之前必须隔离**：

```bash
COCHPIA_DATA_DIR=/tmp/cochpia-e2e python scripts/e2e-panels.py
```

跑完核对 `md5 server/data/state.json` 未变。

## 直连 API 的调用姿势

```bash
# 1. 建 agent
curl -X POST /api/agents -d '{"name":"...","persona":"温和","relationship":"朋友"}'
# 2. 建 session（agentId 在这层传）
curl -X POST /api/sessions -d '{"agentId":"<agent-id>"}'
# 3. 发消息 —— 必带 Idempotency-Key 头，否则 400
curl -X POST /api/chat/turns \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <uuid>' \
  -d '{"sessionId":"<session-id>","message":"..."}'
```

- `agentId` 是 **server-owned**，不能放进 `/api/chat/turns` 请求体（会返回 `SERVER_OWNED_FIELD`）
- 缺 `Idempotency-Key` 返回 `INVALID_REQUEST`

## 浏览器侧

进入路径：首页 →「轻触进入」→ 左侧 **Chat** 导航 → 输入框才可见（启动页与 Sanctum 页上输入框不可见）。

## 2026-09-13 实测结果

环境：真实 PG @5433 + `Z-deepseek-v4.1-flash` + vite dev + Playwright chromium。

| 项 | 结果 |
|---|---|
| `e2e-acceptance.py` | **8/8 passed** |
| `e2e-panels.py` | **9/9 passed**（P8 导出由 red 转 greens，见下） |
| UI 真实对话 | 通过，console errors 0 |

**UI 真实回复样例**（证明模型 + 跨 session 记忆 + 时间感知同时生效）：

> 「小林，你上次说累的时候还在准备演讲，现在这个点了还醒着——是演讲的事还没忙完，还是只是单纯睡不着？」

同期证据：session 存有「我叫小林，最近在准备一个重要的演讲」（另一个 session）、
以及 `currentTimeText()` 注入的当前时间。

### P8「导出」的更正

`scripts/e2e-panels.py` 文件头记着一处 `KNOWN FAILURE: P8 导出`，并注明「不要为了让套件变绿而删掉这个检查」。
**该判断已不成立于 2026-09-13**：装上 Playwright chromium 后 P8 直接通过，
`cochpia-export.json` 正常下载。原因是**缺浏览器二进制**，不是导出功能缺陷。
文件头该段尚未更新（保留历史）。

## 未覆盖

- 跨机 / 双机场景（需第二台机器）
- 独立服务 `services/memory-module/` 的完整链路（本次只覆盖进程内 `/v1` 与主应用）
