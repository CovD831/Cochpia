// 记忆治理 HTTP 层（阶段 1「让护城河露出来」）。
//
// 为什么需要这一层：memory-module.js 早就具备完整的治理能力
// （correct / pin / unpin / revoke / forget / remove / list 分页 / 删除台账 …），
// 但它们只挂在 `/v1`（memory-module-api.js，面向 Memory 服务的机器接口）。
// 用户在 Sanctum 里只能看到 `GET /api/memory/overview` 这一条**只读**视图 ——
// 「看得见」有了，「改得动 / 删得掉 / 说了算」没有。本文件把那批能力接到
// `/api/memory/*` 上，让记忆主权面板有后端可用。
//
// 三条不可退让的约束（都是本项目付过代价的）：
//
// 1. **请求级 context，绝不硬编码 tenantId。** 项目曾出现写入侧硬编码 'default'、
//    读取侧 'local-tenant' 的 P0：canSee() 第一行就是 tenantId 比对，不等即 100%
//    读不到，而且**不报错**。因此这里所有动作都经 `contextFromRequest(req)` 取
//    tenantId / subjectUserId，与 `/api/memory/overview`、`/api/memory/life` 同源。
//
// 2. **治理动作要求 user actor。** memory-module.js 的 assertUserGovernanceActor()
//    要求 actorType==='user' 且 actorId===subjectUserId，否则 403
//    GOVERNANCE_FORBIDDEN。contextFromRequest() 在无 Memory 服务身份时正好给出
//    actorType='user'、actorId=subjectUserId，所以这里**必须**把 `chat` 关掉：
//    带 session 提示的 chat 上下文会在缺 agent 身份时抛 400，而治理是用户级视图，
//    与 overview/life 一样是 agent 无关的。
//
// 3. **白名单序列化。** 只返回渲染必需字段。memory-module 的 serializeAssertion()
//    在 purpose='governance' 下会给出 sensitivity / trustLevel / sourceRefs /
//    validFrom / validTo / mentionPolicy / directQueryPolicy / scope 等内部治理字段，
//    其中 scope 会带 relationshipAgentId、sourceRefs 会带原始事件 id —— 都属于
//    「用户面板不需要、也不该经 HTTP 外泄」的东西。参考 chat-memory.js 的 life()。

import express from 'express';
import { randomUUID } from 'node:crypto';
import { MemoryModuleError } from './memory-module.js';

export const GOVERNANCE_LIST_LIMIT_DEFAULT = 20;
export const GOVERNANCE_LIST_LIMIT_MAX = 100;

const clampLimit = (value, { fallback = GOVERNANCE_LIST_LIMIT_DEFAULT, max = GOVERNANCE_LIST_LIMIT_MAX } = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
};

const asCursor = value => (typeof value === 'string' && value ? value : null);

// ---------------------------------------------------------------------------
// 白名单序列化
// ---------------------------------------------------------------------------
// 字段来源：memory-module.js serializeAssertion() 的返回体（见该函数 return 块）。
// 保留的是「用户要拿来做主权判断」所需的最小集合：我看见什么、它是什么类型、
// 我信不信它、它现在是什么状态、我钉没钉住、什么时候写的。
//
// 明确剔除（并说明为什么，避免以后有人「顺手加回来」）：
//   - scope / relationshipAgentId / sessionId：内部作用域路由字段，暴露 agent id
//     属于跨主体信息，且面板不需要。
//   - sourceRefs：原始事件 id 列表，能把记忆反查回具体哪句话、哪个会话。
//   - mentionPolicy / directQueryPolicy / autoRecallAllowed / retentionPolicy：
//     内部策略位，改动它们有专门的动作（revoke/forget），不经读视图泄漏。
//   - trustLevel / versionId / pinnedVersionId / validFrom / validTo：版本与溯源
//     内部概念，面板用不上。
//   - 任何 embedding / 向量 / 内部 sequence：本就不在 serializeAssertion 里，
//     这里显式列出以免将来被「原样透传 module 返回体」的做法带进来。
const listItem = item => {
  if (!item) return null;
  return {
    id: item.memoryId || item.id,
    summary: String(item.content ?? item.value ?? item.summary ?? ''),
    memoryType: item.memoryType || null,
    assertionType: item.assertionType || null,
    status: item.status || null,
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
    importance: Number.isFinite(Number(item.importance)) ? Number(item.importance) : null,
    sensitivity: item.sensitivity || null,
    pinned: Boolean(item.pinned),
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
    // 乐观锁版本号。所有写动作（correct/pin/unpin/revoke/forget/remove）
    // 都**必填** resource_revision，否则 400 / 过期 409。不给出口的话，
    // 前端每次写之前得先故意失败一次、从错误体的 current_resource_revision
    // 里把版本捞回来 —— 那是把内部一致性机制泄漏成客户端工作量。
    // 由列表直接带回则写动作一次成功。它不是敏感字段（只是个整数计数器），
    // 且模块层 serializeAssertion 本就返回它。
    resourceRevision: Number.isFinite(Number(item.resourceRevision)) ? Number(item.resourceRevision) : null,
    // 面板要把这行渲染成「N% 确信 · {source}」。模块返回体里没有等价的
    // 「来源」字段（来源信息在 sourceRefs 里，而那正是必须剔除的内部字段），
    // 所以这里给一个**常量**：经这条路由出去的记忆，来源就是 memory-module。
    // 常量不携带任何可泄漏信息 —— 它不是从内部数据推导出来的。
    source: 'memory-module'
  };
};

// 治理动作返回体同样白名单化：memory-module 的 correct/pin/unpin 会回
// serializeAssertion()，那里带着上面剔除的一整包内部字段。
const mutationResult = result => {
  if (!result || typeof result !== 'object') return {};
  const output = {};
  if (result.memoryId || result.id) output.id = result.memoryId || result.id;
  if (result.memory) output.memory = listItem(result.memory);
  if (result.confirmation) {
    output.confirmation = {
      id: result.confirmation.id,
      status: result.confirmation.status || null,
      candidateAssertionId: result.confirmation.candidateAssertionId || null,
      proposedContent: String(result.confirmation.proposedContent ?? ''),
      sensitivity: result.confirmation.sensitivity || null,
      expiresAt: result.confirmation.expiresAt || null,
      createdAt: result.confirmation.createdAt || null
    };
  }
  if (result.status) output.status = result.status;
  if (result.deletionOperationId) output.deletionOperationId = result.deletionOperationId;
  if (Number.isFinite(Number(result.redactionEpoch))) output.redactionEpoch = Number(result.redactionEpoch);
  if (result.consistencyToken) output.consistencyToken = result.consistencyToken;
  return output;
};

const deletionOperationBody = operation => {
  if (!operation) return null;
  return {
    id: operation.id,
    targetType: operation.targetType || null,
    targetId: operation.targetId || null,
    action: operation.action || null,
    status: operation.status || null,
    requestedAt: operation.requestedAt || null,
    completedAt: operation.completedAt || null,
    redactionEpoch: Number.isFinite(Number(operation.redactionEpoch)) ? Number(operation.redactionEpoch) : null
  };
};

function sendError(res, error, requestId) {
  const isMemoryError = error instanceof MemoryModuleError;
  const status = isMemoryError ? error.status : error.status || 500;
  const code = isMemoryError ? error.code : error.code || 'MEMORY_MODULE_UNAVAILABLE';
  // 非 MemoryModuleError 的 message 不直接回给调用方（可能含内部路径/参数）；
  // MemoryModuleError 的 message 是给调用方的契约文案，保留。
  const message = isMemoryError ? error.message : 'Memory Module unavailable';
  res.status(status).json({
    error: {
      code,
      message,
      request_id: requestId,
      retryable: Boolean(error.retryable),
      current_resource_revision: isMemoryError ? error.currentResourceRevision : null
    }
  });
}

// 与 memory-module-api.js 的 mutationInput() 保持同一契约：
// header 与 body 同时给且不一致 → 400 IDEMPOTENCY_KEY_CONFLICT。
// 治理动作都是可重试的写操作，没有幂等键时由 memory-module 自己生成语义键
// （见 runtime 的 legacy-* 前缀做法），这里不强行编一个 —— 编错了会让
// 「改两次内容」被当成重复请求吞掉。
function mutationInput(req) {
  const body = req.body || {};
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = body.idempotencyKey ?? body.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) {
    throw new MemoryModuleError('IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match', { status: 400 });
  }
  const key = headerKey || bodyKey;
  return key ? { ...body, idempotency_key: key } : body;
}

/**
 * 治理路由工厂。
 *
 * @param {object} deps
 * @param {(req: object) => object} deps.contextFromRequest 请求级上下文（tenantId/subjectUserId/actor）
 * @param {(req: object) => object} deps.memoryModuleForRequest 请求级 Memory 模块实例
 */
export function createMemoryGovernanceRouter({ contextFromRequest, memoryModuleForRequest } = {}) {
  if (typeof contextFromRequest !== 'function' || typeof memoryModuleForRequest !== 'function') {
    throw new TypeError('Memory governance router requires contextFromRequest and memoryModuleForRequest');
  }
  const router = express.Router();

  const run = handler => async (req, res) => {
    const requestId = req.requestId || randomUUID();
    try {
      // 治理是**用户级**动作：不传 chat:true。原因见文件头第 2 条 ——
      // chat 上下文在有 session 提示而缺 agent 身份时会抛 400，而治理动作
      // 本来就不该按 agent 收窄（那是「我自己的记忆」这一层的事）。
      const context = { ...(contextFromRequest(req) || {}), requestId };
      // 必须 await：生产挂载传进来的是 memoryRuntime.prepareForRequest，
      // 那是个 **async** 函数（memory-module-runtime.js:251）。漏掉 await 会
      // 拿到一个 Promise，之后每个 memory.<method>() 都是
      // "is not a function"，全路由 500。测试如果注入同步 stub 就永远抓不到
      // —— 这正是本项目「测试绿、接线断」的经典形态，所以测试里的 stub
      // 必须与生产同形（async）。
      const memory = await memoryModuleForRequest(req);
      const result = await handler(memory, context, req);
      return res.json(result);
    } catch (error) {
      return sendError(res, error, requestId);
    }
  };

  // 每条路由都先取 module（prepareForRequest 会顺带完成 legacy 导入），
  // 保证「刚导入进来的老记忆」也能立刻出现在列表里 —— 与 overview 一致。

  // --- 读：列表（带 cursor 分页） -------------------------------------------
  // purpose='governance' 是**必需**的：只有它才带 allowGovernance，
  // 让已 revoked / forgotten 的记忆仍然可见（用户要能看见「我删过什么」的
  // 状态痕迹）；同时 list 的 cursor 绑定也含 purpose，两边必须一致。
  router.get('/memories', run(async (memory, context, req) => {
    const limit = clampLimit(req.query.limit);
    const cursor = asCursor(req.query.cursor);
    const scopeType = typeof req.query.scopeType === 'string' && req.query.scopeType ? req.query.scopeType : null;
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
    const page = memory.list(context, { purpose: 'governance', limit, cursor, scopeType, status, returnPage: true });
    const items = (Array.isArray(page) ? page : page?.items || []).map(listItem).filter(Boolean);
    return {
      count: items.length,
      items,
      nextCursor: Array.isArray(page) ? null : page?.nextCursor || null,
      memorySystem: 'memory-module'
    };
  }));

  // --- 读：待确认的改写（S2 敏感内容走确认流）--------------------------------
  router.get('/confirmations', run(async (memory, context, req) => {
    const limit = clampLimit(req.query.limit);
    const cursor = asCursor(req.query.cursor);
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : 'pending';
    const page = memory.listConfirmations(context, { status, limit, cursor, returnPage: true });
    const items = (Array.isArray(page) ? page : page?.items || []).map(confirmation => ({
      id: confirmation.id,
      status: confirmation.status || null,
      candidateAssertionId: confirmation.candidateAssertionId || null,
      proposedContent: String(confirmation.proposedContent ?? ''),
      sensitivity: confirmation.sensitivity || null,
      resourceRevision: confirmation.resourceRevision,
      createdAt: confirmation.createdAt || null,
      expiresAt: confirmation.expiresAt || null
    }));
    return { count: items.length, items, nextCursor: Array.isArray(page) ? null : page?.nextCursor || null };
  }));

  // --- 读：删除台账（「我说了删，到底删没删」的凭据）--------------------------
  router.get('/deletion-operations/:id', run(async (memory, context, req) => {
    const operation = memory.getDeletionOperation(context, req.params.id);
    if (!operation) throw new MemoryModuleError('DELETION_OPERATION_NOT_FOUND', 'Deletion operation not found', { status: 404 });
    return { operation: deletionOperationBody(operation) };
  }));

  // --- 写：改写（correct）--------------------------------------------------
  // resourceRevision 必填（assertRevision 会抛 RESOURCE_REVISION_REQUIRED），
  // 这是防覆盖的乐观锁：面板读到 revised 后必须先拿新 revision 再来。
  router.post('/memories/:id/correct', run(async (memory, context, req) => {
    const result = await memory.correct(context, req.params.id, mutationInput(req));
    return mutationResult(result);
  }));

  router.post('/memories/:id/pin', run(async (memory, context, req) => {
    const result = await memory.pin(context, req.params.id, mutationInput(req));
    return mutationResult(result);
  }));

  router.post('/memories/:id/unpin', run(async (memory, context, req) => {
    const result = await memory.unpin(context, req.params.id, mutationInput(req));
    return mutationResult(result);
  }));

  // --- 写：撤销（revoke，保守：保留记录、标记失效、退出召回）-------------------
  router.post('/memories/:id/revoke', run(async (memory, context, req) => {
    const result = await memory.revoke(context, req.params.id, mutationInput(req));
    return mutationResult(result);
  }));

  // --- 写：遗忘（forget，激进：清派生数据、写墓碑、抬 redactionEpoch）----------
  router.post('/memories/:id/forget', run(async (memory, context, req) => {
    const result = await memory.forget(context, req.params.id, mutationInput(req));
    return mutationResult(result);
  }));

  // --- 写：删除（remove，物理删除，返回可查的删除台账）------------------------
  router.delete('/memories/:id', run(async (memory, context, req) => {
    const result = await memory.remove(context, req.params.id, mutationInput(req));
    return mutationResult(result);
  }));

  // --- 写：确认 / 驳回待确认改写 --------------------------------------------
  router.post('/confirmations/:id/confirm', run(async (memory, context, req) => {
    const result = await memory.confirm(context, req.params.id, mutationInput(req));
    return mutationResult(result);
  }));

  router.post('/confirmations/:id/reject', run(async (memory, context, req) => {
    const result = await memory.reject(context, req.params.id, mutationInput(req));
    return mutationResult(result);
  }));

  return router;
}

export default createMemoryGovernanceRouter;
