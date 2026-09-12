# PROJECT_STATE

阶段 | 结论 | 关键决策 | 待办
2026-09-12 | R-004 闸门已批准宣布；历史记忆回填待办实测**关闭**（两处 assertion 表为 0，无对象可回填；"只有一个 agent"假定双向皆伪） | 取证对象更正：以 PG 运行时面为准，`state.json` 是切流前冻结快照 | 上游网关恢复后验 UI 聊天；双机 TLS 验收
2026-09-12 | `readScope` 端到端验证**通过**（契约 2c）：三处注入点推导均正确，反事实成立（6 变异全检出）；`npm test` 406/401/0/5 | 注入点实为**三处**（文档原称两处，第三处 `core-v0.js:363`）；V-4 为 characterization pin 非正确性确认 | 上游 `resolveAgentIdForRequest` 仍无覆盖（已声明为证据边界）
2026-09-13 | **/v1 旁路判定 + 修复完成**（契约 2c §4.3~§4.5）：进程内三条读路由注入 `readScope`；独立服务 actor 加固为 env 双重门；反事实 11 组变异无空洞用例 | 独立服务判 **A**（默认 agent），进程内判 **B** 已修；`get /v1/memories` 一并修（主理人契约射程写漏） | `narrowRead` 默认 false 的第三消费者隐患（已声明无守卫）；R5b 是 characterization pin
2026-09-13 | **UI 真实端到端跑通**（真实 PG + `Z-deepseek-v4.1-flash`）：e2e-acceptance 8/8、e2e-panels 9/9、UI 对话通过（console errors 0）；回复同时证明模型 + 跨 session 记忆 + 时间感知 | 模型「故障」实为**模型 ID 过时**（`deepseek-v4-flash` 已下线）；修 `.env` 的 `MODEL_DEEPSEEK_NAME`（env 覆盖机制早已存在，无需改码） | 生产 PG 遗留 `livecheck-*` agent + session 待清理；`index.js:267` 的 json 分支硬编码 mock 待决策
2026-09-13 | 全部已提交推送（`15511e9`），`HEAD...origin` = 0/0，工作树干净 | 按老板指令，其他无关改动不自动 commit | skill 仓库 0.31.2 已推送（`24b4f21`，0/0）
