# L2 契约 2b：来源溯源（provenance）

日期：2026-09-12　上游参照：`ksys404/Cochpia` `92225a6`
前置：`07-l2-contracts-2a.md`（C-7 读侧作用域收窄）
实测证据：`scripts/probe-agent-scope-leak.mjs`（修复前 `leak: true`，修复后 `leak: false`）
回归：`server/agent-provenance.test.js`（P-0 ~ P-5，在 `npm test` 内）

## 1. 问题（实测，不是推演）

2a 的 C-7 用 `readScope` 收窄**可见性**，但它只覆盖 `relationship` / `life` 两个
**按拥有者划分**的域。而**作用域与来源是两个维度**：

- 一条由 agent A 私聊产生、经 drain（raw event → candidate → user actor promote）
  落成 `scopeType='user'` 的断言，**不是** A 的私有财产（user 域没有拥有者概念），
  所以 `readScope` 对它的判定是"可见"。
- 结果是 **agent B 能原样检索到用户只跟 A 说过的话**。
- 且写入侧当时**没有任何来源标记**：`sanitizeMetadata` 白名单不含
  `source_agent_id`，raw event metadata 为空。

修复前探针输出：

```json
{ "rawEventMetadata": {}, "provenanceFieldPresent": false,
  "agentA_sees": true, "agentB_sees": true, "leak": true }
```

定性：**范围缺口**，不是 2a 的实现缺陷。2a 完成了它承诺的（按拥有者收窄），
但"按来源收窄"是另一条轴。

## 2. 契约

### C-13 写入侧打标（server-derived）

`recordEvent` 在 raw event 的 metadata 上写入 `source_agent_id`，取值来自
**服务端解析出的 `context.callerAgentId`**。无 `callerAgentId` 的上下文不打标。

### C-14 不可伪造

`source_agent_id` **不加入** metadata 白名单：请求体携带该字段仍按
`INVALID_METADATA` 拒绝（P-5）。调用方无法为自己伪造来源。

> 这是与上游的一处**刻意差异**。上游把 `source_agent_id` 放进了白名单以便
> harness 传值；我们不开放输入面，因为该字段的安全意义恰好在于"只能由服务端写"。

### C-15 读侧按来源过滤

在**收窄读**（`context.readScope` 存在）中，若某断言的**当前版本**有一个已标记来源
属于其他 agent，则该断言不可见：

```
hide  ⟺  ∃ source ∈ sources(assertion) :  source ≠ readerAgentId
```

等价写法（上游 92225a6 的形式，二者是同一命题的否定）：

```
visible  ⟺  ∀ source ∈ sources(assertion) :  ¬tagged(source) ∨ source = readerAgentId
```

`sources()` = 该断言**当前版本**的 `assertionVersionSources` 中
`sourceType === 'raw_event'` 的那些，映射到对应 raw event 的
`metadata.source_agent_id`。

### C-16 兼容规则：未标记不构成阻碍

**未标记的来源永远不影响可见性。** 理由：2026-09-12 之前写入的全部记忆都没有标记，
若按"未标记即不可见"处理，用户自己的历史记忆会**集体消失**，属于破坏性变更。
此规则与上游一致。

## 3. 两条轴的关系（本次修复的核心认知）

| 轴 | 含义 | 载体 | 移植范围 |
|---|---|---|---|
| **作用域** | 这条记忆**可以**用在什么场合 | `scopeType` + `relationshipAgentId` | `relationship` / `life`（C-7 收窄） |
| **来源** | 这条记忆的材料**是谁**产出的 | raw event `metadata.source_agent_id` | 全部作用域（C-15 过滤） |

两者互补：C-7 解决"看得到不该看的域的资产"，C-15 解决"看得到不该看的内容"。
**任一单独都不足以闭合**。

## 4. 不变量

- **I-18**：来源标记只能由服务端写入，且取自解析后的 `callerAgentId`（C-14）。
- **I-19**：C-15 只做减法——它只在 `readScope` 存在时生效，且只可能隐藏、不可能放行。
  与 I-12（readScope 只收窄）同向。
- **I-20**：未标记来源不得成为隐藏理由（C-16）。**违反此不变量等价于抹掉历史数据。**

## 5. 影响面

过滤集中在**单一门禁** `canSee()`（`server/memory-module.js`），所有读路径共用
（`list` / `retrieveAsync` / `contextBundleAsync` / episodes / 当前状态）。

生产读路径的 `readScope` 注入点（两处，均由服务端从会话解析）：
- `server/chat-memory.js:100`
- `server/core-v0-postgres.js:646`

因此本契约对 chat 路径生效，对治理/导出视图（无 `readScope`）**不生效**——这是
刻意的（P-3）。

## 6. 验证

| 项 | 结果 |
|---|---|
| `scripts/probe-agent-scope-leak.mjs` | `leak: false`，exit 0；含 4 条反向断言（打标存在 / A 仍可见 / 治理视图不受影响 / 无泄漏） |
| `server/agent-provenance.test.js` | P-0 ~ P-5 全过（打标、双向可见性、治理视图、兼容规则、不可伪造） |
| 既有 `server/agent-scope-2a.test.js` | 全过——尤其 R-4（user 域在收窄下仍可见）未被误伤，因为其 seed 走 `hold()`，无来源标记 |

## 7. 残余风险（明确列出，不隐瞒）

1. **历史数据窗口**：2026-09-12 之前写入的记忆无标记，仍对全部 agent 可见。
   要完全闭合需一次性回填（`source_agent_id` 在语义上不可事后推导——除非假定
   "当时只会有一个 agent"）。**未做回填。**
2. **多来源断言保守处理**：同时源自 A 与 B 的断言会对 A、B **都**隐藏。
   更细的做法是逐来源归属，但会显著提高复杂度，暂不做。
3. **只看当前版本**：若断言的当前版本无 `raw_event` 来源（例如纯手工修正版本），
   而其历史版本来自 A，则不会因此隐藏。选择"看当前版本"是因为它对应"这条内容
   现在是什么"，与检索语义一致。
4. **`relationship` / `life` 域叠加**：这两域已有 C-7 的拥有者判定，C-15 会再叠一层。
   正常情况下不会触发（拥有者与来源一致），但二者不一致时以更严格者为准。

## 8. 被拒绝的方案

| 方案 | 为何不做 |
|---|---|
| 把 chat 的 `actorType` 改成 `agent` 来借用 agent 守卫 | 治理与 drain 依赖 user actor（AR-210），改了会让抽取静默停止 |
| 让 `user` 作用域在收窄读下默认不可见 | 违反 R-4：治理/导出需要看全；且会隐藏**用户自己的**记忆 |
| 把 `source_agent_id` 放进 metadata 白名单 | 给请求体开了伪造来源的口子（见 C-14） |
| 用 `relationshipAgentId` 给所有断言补一个"隐性归属" | 改变 scope 语义，且 user 域本无拥有者概念，会造成语义污染 |
| 只在 `chat-memory.js` 一处加过滤 | 另一条读路径（`core-v0-postgres.js` 的 context bundle）会绕过；过滤必须落在 `canSee` 这个共用门禁上 |
