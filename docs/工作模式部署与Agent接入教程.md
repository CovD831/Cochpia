# Cochpia 工作模式部署与 Agent 接入教程

本文说明如何在本机运行 Cochpia，并配置工作模式使用 Pi Agent。文末说明 Codex 的官方接入路径以及当前项目的实现边界。

## 1. 运行前准备

需要安装：

- Node.js 20 或更高版本
- npm
- Git
- 一个已经完成鉴权的模型提供商，或先使用本地 Mock 模式

在项目根目录执行：

```powershell
npm install
```

不要提交根目录 `.env`。真实密钥只放在本机环境变量或被 `.gitignore` 忽略的 `.env` 中。

## 2. 本地启动 Cochpia

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

本地开发可以先保持以下配置：

```dotenv
PORT=8787
CLIENT_ORIGIN=http://localhost:5173
STORAGE_PROVIDER=json
MODEL_PROVIDER=mock
AUTH_MODE=off
```

启动前端和后端：

```powershell
npm run dev
```

默认地址：

- 前端：<http://localhost:5173>
- 后端健康检查：<http://localhost:8787/api/health>
- 模型目录：<http://localhost:8787/api/models>
- MCP：`POST http://localhost:8787/mcp`

如果 5173 已被占用，Vite 会自动使用 5174 或其他端口。此时浏览器访问终端输出的前端地址，后端仍然默认使用 8787。

单独启动时可以使用：

```powershell
npm run server
npm run build
npm run start:web
```

## 3. 开启工作模式

在聊天中发送：

```text
切换到工作模式
```

或者直接发送：

```text
工作模式
```

切换成功后，后续消息会按工作任务处理。切回陪伴模式：

```text
切换到陪伴模式
```

当前服务端的工作模式执行顺序是：

```text
收到任务
  -> 尝试启动 Pi RPC
  -> 接收 Pi 的文本和工具事件
  -> 写入聊天记录与记忆模块
  -> 返回完成事件
  -> Pi 不可用时回退到本地模型工具链
```

相关实现：

- `server/pi-client.js`：启动 `pi --mode rpc --no-session` 并解析 JSONL 事件
- `server/index.js`：工作模式路由、Pi 优先和本地工具回退
- `AGENTS.md`：项目修改、隐私和提交规则

## 4. 安装和配置 Pi Agent

官方 npm 安装方式：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

确认命令可用：

```powershell
pi --version
```

先在项目目录手动启动一次 Pi：

```powershell
pi
```

在 Pi 中使用 `/login` 进行订阅账户登录，或者按照 Pi 的 Provider 文档配置模型 API Key。鉴权完成后退出 Pi，再启动 Cochpia。

验证 RPC 是否可用：

```powershell
pi --mode rpc --no-session
```

该命令会等待 JSONL 指令输入，直接关闭终端即可退出。Cochpia 后端会自动启动同样的 RPC 进程，不需要在前端填写 Pi 的 HTTP 地址。

Pi RPC 使用 stdin/stdout JSONL，不是浏览器可直接访问的 HTTP 服务。官方说明见：<https://pi.dev/docs/latest/rpc>。

## 5. 在 Cochpia 中测试 Pi

1. 启动 Pi 并完成 `/login`。
2. 启动 Cochpia：`npm run dev`。
3. 打开聊天页面。
4. 发送“切换到工作模式”。
5. 发送一个低风险测试任务：

```text
读取 README.md，告诉我项目的启动命令，不要修改任何文件。
```

6. 查看回复中的工作事件。

如果 Pi 不可用，服务端会记录脱敏错误码并回退本地工作模式模型。终端中不应出现完整 API Key 或用户对话正文。

## 6. Codex 的接入途径

Codex 有三种不同层级，不能混用：

### 6.1 Codex CLI

安装：

```powershell
npm install -g @openai/codex
codex --login
```

CLI 是本机 Agent，拥有本地工作区、审批和沙箱能力。它不是一个默认监听 HTTP 端口的服务。

### 6.2 Codex App Server

官方 App Server 用于给 IDE 或自定义界面提供线程、turn、事件流和审批能力：

```powershell
codex app-server
```

默认使用 JSONL/stdio，也支持实验性的 WebSocket 传输。正式接入 Cochpia 时，应由 Cochpia 后端启动并管理 App Server，再向前端暴露经过鉴权的 `/api/workbench/codex/*` 接口。

官方文档：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>。

### 6.3 Codex Python SDK

官方 SDK 安装：

```powershell
python -m pip install openai-codex
```

它可以创建 thread、运行 turn、读取流式事件和控制沙箱权限。适合单独的 Python Agent 网关，不建议在浏览器中直接调用。

官方文档：<https://github.com/openai/codex/tree/main/sdk/python>。

## 7. 当前工作区的接入边界

当前“工作区”页面里的 Codex、Pi、MCP 接口地址是通用任务网关配置，使用浏览器 `fetch` 发送 POST 请求。它们目前不是 Codex App Server 或 Pi RPC 的直接客户端。

因此：

- Pi：聊天工作模式已经由后端直接接入 Pi RPC；工作区卡片暂时适合作为未来网关配置入口。
- Codex：当前还没有 Codex App Server 适配器，不能直接填写 `codex` 命令或 stdio 地址。
- MCP：当前后端已有 `/mcp` JSON-RPC 入口，但具体外部 MCP 服务仍需在服务端配置。

推荐的生产结构：

```text
Cochpia 前端
  -> Cochpia 后端 /api/workbench
     -> Codex Adapter -> codex app-server
     -> Pi Adapter    -> pi --mode rpc
     -> MCP Adapter   -> 外部 MCP 服务
```

## 8. 安全要求

不要把以下内容放进前端输入框、Git 仓库或日志：

- OpenAI、Anthropic、DeepSeek 等 API Key
- Pi `auth.json` 内容
- Codex 登录凭据
- Supabase Service Role Key
- 数据库连接串
- 用户对话和个人信息

Agent 接入必须满足：

1. 只允许后端启动 Agent，浏览器不能直接启动进程。
2. 限制 Agent 的工作目录，只允许项目目录和明确的可写目录。
3. 写文件、执行命令、推送 GitHub 前保留审批节点。
4. 只把摘要、步骤状态和脱敏错误发送到前端。
5. 公网部署使用 `AUTH_MODE=required`、`STORAGE_PROVIDER=postgres` 和 HTTPS。
6. Codex/Pi 的本地桥接端口只监听 `127.0.0.1`，不要直接暴露到局域网。

## 9. 部署前检查

```powershell
npm test
npm run build
git status --short
git -c core.whitespace=cr-at-eol diff --check
```

提交前还要确认：

- `.env` 没有被 Git 追踪
- 没有硬编码 API Key、Token 或数据库连接串
- 没有把用户对话、运行日志或 Pi/Codex 凭据写入仓库
- 真实模型连接测试通过
- Pi RPC 不可用时，界面能显示失败或回退状态
- 工作模式中的修改、测试和 GitHub 推送经过人工确认

## 参考资料

- [OpenAI Codex CLI](https://github.com/openai/codex)
- [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex Python SDK](https://github.com/openai/codex/tree/main/sdk/python)
- [Pi Quickstart](https://pi.dev/docs/latest/quickstart)
- [Pi RPC](https://pi.dev/docs/latest/rpc)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
