# R-020 回滚方案

## 原则

- 每阶段独立可回滚，不对后续阶段产生依赖。
- schema 变更全部 additive（新表/新列），不做破坏性 DDL。
- 回滚后系统必须处于**可运行**状态，不是"半残"。

## 阶段 1 回滚

**改动面**：`scripts/turns-local-smoke.js`（新增）、
`index.js:891` 降级标记、`observability` 计数器、新增测试。

```
git revert <1.2 commit> <1.3 commit> <1.4 commit>
```

- 无 schema 变更。
- 纯新增 + 一处 catch 的标记增强，回滚后行为退回原状。
- **注意**：原计划的 1.1（修 legacy sessionId）已按 AR-201/AR-203 取消。

## 阶段 2a 回滚

**改动面**：`memory-module-runtime.js:75`、`core-v0.js:298`、
`core-v0-postgres.js:578`、`runtime-context.js`、`memory-module.js`
（scope 枚举 + purpose 权限）、`index.js`（session 创建校验）。

```
git revert <阶段 2a 全部提交>
```

- 无 schema 变更。
- 回滚后 agent 身份回退到 `'cochpia'` 常量 → 关系域隔离失效
  （但系统可运行，不影响单 agent 场景）。

## 阶段 2b 回滚

**改动面**：`cochpia_agents` 表、`agent-service.js` 实现替换、
prompt 装配、`session.persona` 迁移。

```
git revert <阶段 2b 全部提交>
```

- `cochpia_agents` 表**保留**（additive，不删）。
- **双写期设计使回滚变简单**：观察期内 `state.agents[]` 未删除，
  所以代码 revert 后 JSONB 里的数据完好，无需反向迁移。
- 这正是 C-1.4 双写策略的价值：让 2b 的回滚成本趋近于零。

## 阶段 3 回滚（审查 AR-203 修订：无兼容窗口）

**改动面**：turns 流式分支、前端 fetch 目标、legacy 一次性删除。

删除必须拆成**三个独立提交**，保证回滚粒度：

| 提交 | 内容 | 回滚方式 |
|---|---|---|
| C1 | turns 补流式 | revert C1（legacy 仍在） |
| C2 | 前端切到 turns | revert C2（回到 legacy fetch） |
| C3 | 删除 legacy 全部代码 | revert C3（恢复 legacy） |

**回滚点分析**：
- 若 C1/C2 有问题 → revert 到 C1 或 C2，legacy 完好。
- 若 C3 之后发现问题 → revert C3。**这是"直接删"可行性的前提**：
  legacy 代码完整保留在 git 历史，恢复成本 = 一次 revert。
- 最坏情况（三个阶段全要退）→ revert C3 + C2 + C1。

**关键约束**：C3 必须是纯删除提交，不得混入其他改动。否则 revert 会
连带回退无关内容。

## 阶段 4 回滚

**改动面**：删除端点、删除文件、删除前端目录。

每批一个提交，`git revert <批次 commit>` 即可恢复。

**风险**：若删除后发现外部消费者（非前端）在调用，revert 后需要
重新部署。建议每批之间间隔至少一次完整冒烟。

## 灾难恢复：数据层

**本切片不修改任何既有数据的语义**：
- `cochpia_agents` 是新增表，删除即回滚。
- 存量迁移是**复制**不是**移动**（观察期内双写）。
- Memory Module 与 Core v0 的表结构完全不动。

因此**不存在数据层不可逆变更**。这是本切片刻意的设计约束。

## 回滚演练脚本

`scripts/cleanup-rollback-rehearsal.js`（阶段 2 交付）：

```
1. 记录当前 git HEAD
2. 跑 stages-2 验收（应全绿）
3. git revert 阶段 2 提交
4. 跑冒烟（应通过，功能退化但不崩）
5. 恢复 HEAD
6. 跑阶段 2 验收（应全绿）
7. 输出 JSON 证据
```

参照 `scripts/core-v0-postgres-rollback-rehearsal.js` 的形态。
