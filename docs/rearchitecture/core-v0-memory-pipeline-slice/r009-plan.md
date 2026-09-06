# R-009 实施计划：双时间轴失效模型（字段补全与串联）

> 依据：roadmap 的 Zep 式失效模型。基线：`1e797dd`。
> **基线核查修正（第三次）**：原判断"需要 schema migration"不成立——
> `assertion_versions` 表**已有** `observed_at NOT NULL`、`valid_from`、
> `valid_to`、`supersedes_version_id` 四个字段（R-003 schema），`addVersion`
> 已支持全部入参且自动串联取代链，`serializeAssertion` 已暴露
> `valid_from/valid_to`。**无需任何 schema 变更**。真实缺口只有三处赋值与
> 串联断点。

## 1. 目标

让"当时什么为真 / 现在什么为真 / 系统何时知道"三问具备数据基础：
- 每个断言版本的 `valid_from` = 其 source raw event 的陈述时间；
- 被 AUDN UPDATE 取代的旧版本：`valid_to` = 新版本的 `valid_from`（时间轴
  闭合），`supersedes_version_id` 指向取代者；
- 序列化暴露 `observedAt`，AUDN 决策上下文携带已有记忆的 valid 区间。

## 2. 设计

1. **drain 候选携带时间**（memory-extraction.js）：`createCandidate` 增加
   `observedAt: event.occurredAt, validFrom: event.occurredAt`——事实自用户
   陈述时刻有效；
2. **correct 闭合时间轴**（memory-module.js S0 分支）：新版本
   `validFrom = input.validFrom ?? oldVersion.validFrom`（补充型修正延续原
   起点），旧版本 `validTo = 新版本.validFrom`（矛盾型更新在此刻失效）；
3. **序列化补 `observedAt`**（serializeAssertion）；
4. **AUDN 上下文增强**：`findSimilar` 附带每条已有记忆的
   `validFrom/validTo`，auditor prompt 展示区间（时序感知仲裁）。

## 3. 验收

- D-01 时间轴闭合：AUDN UPDATE 后旧版本 `valid_to` = 新版本 `valid_from`
  且 `supersedes_version_id` 指向新版本；
- D-02 陈述时间贯穿：drain 候选的 `valid_from` 等于其 raw event 的
  `occurredAt`；
- D-03 序列化：`retrieveAsync` 的 items 暴露 `observedAt/validFrom/validTo`。

## 4. 风险

- 旧数据 `valid_from` 为 NULL：旧行为兼容（Zep 亦允许部分缺失），
  `valid_to` 闭合照常；
- 无 schema 变更、无新 flag（时间轴是数据完整性修复，不是行为开关）。
