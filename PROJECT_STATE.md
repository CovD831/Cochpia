RUN-ARCHIVE: /Users/abab/Documents/ChatGPT/cochpia/.workbuddy/team-runs/20260917-1646-p0-defects-route-stem
# PROJECT_STATE

阶段 | 结论 | 关键决策 | 待办
2026-09-12 | R-004 闸门已批准宣布；历史记忆回填待办实测**关闭**（两处 assertion 表为 0，无对象可回填；"只有一个 agent"假定双向皆伪） | 取证对象更正：以 PG 运行时面为准，`state.json` 是切流前冻结快照 | 上游网关恢复后验 UI 聊天；双机 TLS 验收
2026-09-12 | `readScope` 端到端验证**通过**（契约 2c）：三处注入点推导均正确，反事实成立（6 变异全检出）；`npm test` 406/401/0/5 | 注入点实为**三处**（文档原称两处，第三处 `core-v0.js:363`）；V-4 为 characterization pin 非正确性确认 | 上游 `resolveAgentIdForRequest` 仍无覆盖（已声明为证据边界）
2026-09-13 | **/v1 旁路判定 + 修复完成**（契约 2c §4.3~§4.5）：进程内三条读路由注入 `readScope`；独立服务 actor 加固为 env 双重门；反事实 11 组变异无空洞用例 | 独立服务判 **A**（默认 agent），进程内判 **B** 已修；`get /v1/memories` 一并修（主理人契约射程写漏） | `narrowRead` 默认 false 的第三消费者隐患（已声明无守卫）；R5b 是 characterization pin
2026-09-13 | **UI 真实端到端跑通**（真实 PG + `Z-deepseek-v4.1-flash`）：e2e-acceptance 8/8、e2e-panels 9/9、UI 对话通过（console errors 0）；回复同时证明模型 + 跨 session 记忆 + 时间感知 | 模型「故障」实为**模型 ID 过时**（`deepseek-v4-flash` 已下线）；修 `.env` 的 `MODEL_DEEPSEEK_NAME`（env 覆盖机制早已存在，无需改码） | 生产 PG 遗留 `livecheck-*` agent + session 待清理；`index.js:267` 的 json 分支硬编码 mock 待决策
2026-09-13 | 全部已提交推送（`15511e9`），`HEAD...origin` = 0/0，工作树干净 | 按老板指令，其他无关改动不自动 commit | skill 仓库 0.31.2 已推送（`24b4f21`，0/0）
2026-09-17 | **积压改动三段切分提交**（`3e8b17b` limit 修复 / `13cb4d1` LoCoMo 评测闸门+证据 / `473c89a` life-tick 独立线），三中间态逐个 checkout 实跑验证为绿 | `package.json` 与 `gate-registry.json` 内两条工作线混写，做 hunk 级分离（格式重排归 ②段，`memory-quality` gate 属召回线） | 未 push，等老板确认
2026-09-17 | **4 条召回机制实验线并行完成**（P1 轻量并行，未建团）：A 实体邻接 INCONCLUSIVE/NO-GO、B 词干化 FAIL@342口径、C 长度降权 INCONCLUSIVE、D 旁路摘要 PASS | **病灶定位（本批最高价值）**：旗舰 case `D2:8` 失败根因是**词形不匹配**（`research` vs `researching`），非实体缺失/长度/粒度——A/C/D 三线独立收敛，D 直接证伪主理人任务卡前提 | D 的摘要来自数据集自带，**产品自生成能力未验证**（D 落地唯一前提）
2026-09-17 | **独立审计完成**（`AUDIT.md`）：4 条 verdict 全部独立复现；**证伪 2 处过宽声明**（A 留出集非逐位可复现、B 全口径记账分母不符），均不改 verdict；测量污染**无** | 发现官方脚本 `locomo-eval-evidence.mjs` **分类分母与总指标分母不一致**（line 162 vs 176），已统一为可计分分母；B 线分类数字用全QA分母（已反解证实） | 合入 B 前须给 C/D 脚本钉 `MEMORY_TOKENIZER_STEM='0'`；`state_current` 路由致 3 个 case 结构性空返回（产品既有缺陷，建议独立立项）
2026-09-17 | **P0 修复批次（路线 A）**：A2 修 `state_current` 误路由（删「现在/当前」，保留「正在/英文段」）——既有断言 9/9 保住、判别力改前红改后绿、全量 533/528/0/5；A3 词干化 -es 条件化修好虚假归并（notes→not 等）、并补 2 条入库测试（判别力实测：未修版 2 失败） | **执行者纠正主理人 2 处派单错误**：① `stemToken` 不在 life-tick（只在 lane B 未提交工作区），② 删「正在」会破 `memory-module.test.js:448`（该断言正验证 state_current 链路）。**审计证伪主理人裁决书论据**：我误把修后分类当基线说「五分类无变化」 | A3 机制不合入默认行为（见下）
2026-09-17 | **口径分歧已收敛（推翻主理人自己的论据）**：跑全 10 样本分类三态对照后确认，两口径「靶心符号相反」的真因是**口径 A 分辨率不足**（多跳仅 74 条，±1 case = 0.0135），**非机制行为差异**。显著性检验：A `p=1.0000`、B `p=0.2272`，**两口径均不显著** | **新增判据纪律**：报告任何 delta 前先算该口径的 ±1 case 值；delta 低于该值 2~3 倍时**不得作机制性判断**（本批两次自我更正均踩此坑） | 若重开词干化议题：正确下一步是**扩大样本**，非在 342 口径继续调参
2026-09-17 | **A2 + A3 已提交并推送**：`fffadce`（state_current 误路由修复）、`c5467f3`（词干化入库**默认关** + -es 词法修复 + 双向测试）；分支 `lane/life-tick-v0` 已推 origin，远端 sha 验证一致 | A3 采「入库但默认关」——默认行为严格不变（全口径仍 0.6115/0.4077 = pristine），机制代码与测试入库仅为保留实验入口；开关 `MEMORY_TOKENIZER_STEM=1` 启用 | 已推送 5 提交；下一步可选：建 PR / 处理 D 的摘要产品化前提 / 独立立项修 `state_current` 空返回残留

