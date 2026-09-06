# R-007b 实施计划：异步 drain（fire-and-forget after response）

> 依据：真模型冒烟实测 drain p50=4.3s / p95=10.2s（AUDN 增加决策调用后仍在
> 10s 级），同步 drain 挂在 turn 响应路径上不可接受（roadmap 借鉴项 6，
> LangMem background executor 模式）。基线：`3b294c7`。

## 1. 目标与非目标

目标：drain 从"turn 入口同步 await"改为"turn 响应写出后 fire-and-forget"，
turn 响应不再承担提取延迟；语义从"同请求强一致"改为"最终一致（至多延迟
一轮）"。

非目标：不改 drain 内部逻辑（锁/预算/熔断/AUDN 全部复用）；不引入 worker
进程；不改 legacy/local 路径。

## 2. 设计

- 路由改动：`/api/chat/turns` 在 `service.handleTurn` 返回后、写出响应前，
  以 `setImmediate(() => coreV0DrainExtraction(drain))` 触发 drain——响应
  先写，drain 在同一进程后台执行；不 await。
- 安全性：`coreV0DrainExtraction` 已有 catch-all（drain 错误永不冒泡）；
  drain 内部已有 per-subject advisory lock（并发 fire 自动串行）、时间预算、
  熔断与 Memory audit。进程崩溃丢失的批次由 durable outbox + 下次 drain
  重试兜底。
- 语义契约：一次 turn 提交的事实，**至多延迟一轮对话**后进入检索语料；
  `recalledCount=0` 与"尚未提取"不可区分是接受的最终一致行为（B-08 的
  语义照旧）。
- proof 语义更新（E4/E-timing）：陈述 turn 的响应必须在 drain 完成前返回
  （fire-and-forget 生效的直接证据）；随后有界轮询等待断言 active（异步
  消化），再以全新会话提问断言必然召回——这是异步语义下的闭环验收。

## 3. 验收

- B-19 响应不被 drain 阻塞：proof 中陈述 turn 的 handleTurn 返回早于
  drain 完成；
- B-20 最终一致闭环：轮询消化后，全新会话提问必然召回（E4 语义保留）；
- 既有 B-01..B-18 全部保持（AUDN/投影/幂等逻辑未动）。

## 4. 风险与对策

- 并发 fire 两个 drain：advisory lock 串行 + save 的 commit_seq CAS 双保险
  （R5-AR-001 已覆盖）；
- drain 与 turn 的 Memory 写入竞争：turn 的 appendRawEvent 走独立重试
  （retryAttempts），冲突为 409 retryable；
- 消化延迟造成"用户刚说完就没记住"的观感：接受（业界同款最终一致），
  R-007c 语义检索上线后无影响。
