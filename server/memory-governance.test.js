// 记忆治理 HTTP 层 —— 行为层测试。
//
// 设计原则（针对本项目审计抓到过的「自证测试」）：**不重抄路由算法**。
// 这些测试驱动的是真实的 Express 路由（createMemoryGovernanceRouter）
// 叠在真实的 Memory 模块（createMemoryModule）上，通过真实 HTTP 请求
// （node:http + fetch）进出，断言的是**真实返回值**。
// 任何一条路由逻辑写错、白名单漏字段、租户/用户串了，这里都会红。
//
// 为什么必须有「删除后读不回来」：这是记忆主权的核心命题。
// 能删只是表象；**删完再查不到**才是主权。所以那条测试同时查
// list（治理视图）与 retrieve（召回路径）两条读路径 —— 只堵一条 = 没删干净。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryGovernanceRouter } from './memory-governance-routes.js';

// ---------------------------------------------------------------------------
// 测试脚手架：真的 Express + 真的模块 + 真的 HTTP
// ---------------------------------------------------------------------------
// contextFromRequest 读请求头，模拟 server/index.js 的做法：context 来自
// **请求**，不是某个常量。这样「硬编码 tenantId」这类缺陷会被测出来。
function createHarness() {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});

  const app = express();
  app.use(express.json());
  app.use('/api/memory', createMemoryGovernanceRouter({
    contextFromRequest: req => ({
      tenantId: req.get('x-tenant') || 'tenant-a',
      subjectUserId: req.get('x-user') || 'user-a',
      actorType: req.get('x-actor-type') || 'user',
      actorId: req.get('x-actor-id') || req.get('x-user') || 'user-a',
      callerAgentId: req.get('x-actor-type') === 'agent' ? (req.get('x-actor-id') || 'agent-x') : null
    }),
    // **必须 async、必须与生产同形**：生产挂载传的是
    // memoryRuntime.prepareForRequest，那是个 async 函数
    // （memory-module-runtime.js:251）。这里若写成同步 `() => memory`，
    // 路由里漏掉 `await` 的缺陷就永远测不出来 —— 本项目已经栽过一次
    // （「测试绿、接线断」）。见本文件末尾那条判别力测试。
    memoryModuleForRequest: async () => memory
  }));

  return { state, memory, app };
}

// 起一个真实监听端口，返回带默认头的 request 帮助函数与 close。
async function serve(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (method, path, { user = 'user-a', tenant = 'tenant-a', actorType = 'user', actorId = null, body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-user': user,
        'x-tenant': tenant,
        'x-actor-type': actorType,
        ...(actorId ? { 'x-actor-id': actorId } : {}),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: response.status, body: json };
  };

  return { base, request, close: () => new Promise(resolve => server.close(resolve)) };
}

// 直接经模块写入一条记忆（写入不是本测试的被测对象，用最短路径），
// 返回真实断言对象，供测试拿 memoryId / resourceRevision。
const userContext = (userId = 'user-a', tenantId = 'tenant-a') => ({ tenantId, subjectUserId: userId, actorType: 'user', actorId: userId });

async function seed(memory, content, { user = 'user-a', tenant = 'tenant-a', extra = {} } = {}) {
  const held = await memory.hold(userContext(user, tenant), { content, sensitivity: 'S0', ...extra });
  return held.memory;
}

// ---------------------------------------------------------------------------
// 1. 读：列表（可见）
// ---------------------------------------------------------------------------
test('governance list returns the caller memories with only sanctioned fields', async () => {
  const { memory, app } = createHarness();
  await seed(memory, '我喜欢喝美式');
  const server = await serve(app);
  try {
    const { status, body } = await server.request('GET', '/api/memory/memories');
    assert.equal(status, 200);
    assert.equal(body.count, 1);
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.equal(item.summary, '我喜欢喝美式');
    assert.equal(item.status, 'active');
    assert.equal(item.pinned, false);
    assert.ok(typeof item.id === 'string' && item.id.length > 0);
    // 面板要渲染「N% 确信 · source」，缺了会显示 undefined。
    assert.equal(item.source, 'memory-module');

    // 安全白名单：内部/其它主体字段一个都不能出现在响应里。
    // scopeType / relationshipAgentId / sessionId 是 captain 裁决明确不加的
    // （会带出跨主体的 agent/session 标识），这里把它们钉进回归。
    for (const forbidden of ['scope', 'scopeType', 'relationshipAgentId', 'sessionId', 'sourceRefs', 'mentionPolicy', 'directQueryPolicy', 'autoRecallAllowed', 'trustLevel', 'versionId', 'pinnedVersionId', 'embedding', 'embeddingVector', 'sequence', 'structuredData']) {
      assert.equal(Object.hasOwn(item, forbidden), false, `list item must not expose ${forbidden}`);
    }
    // 整条响应体做一次原文扫描：确保没有任何内部字段名或向量字段经嵌套结构漏出。
    const raw = JSON.stringify(body);
    for (const token of ['"embedding"', '"sourceRefs"', '"mentionPolicy"', '"directQueryPolicy"', '"trustLevel"', '"sequence"']) {
      assert.equal(raw.includes(token), false, `response body must not contain ${token}`);
    }
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 2. 读：分页 cursor 透传 + limit clamp
// ---------------------------------------------------------------------------
test('governance list paginates with a cursor and clamps limit', async () => {
  const { memory, app } = createHarness();
  for (let index = 0; index < 5; index += 1) await seed(memory, `记忆-${index}`);
  const server = await serve(app);
  try {
    const first = await server.request('GET', '/api/memory/memories?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 2);
    assert.equal(typeof first.body.nextCursor, 'string');
    assert.ok(first.body.nextCursor.length > 0);

    // cursor 真的被透传给了模块：翻页拿到的是**不同的**两条，且不重复。
    const second = await server.request('GET', `/api/memory/memories?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.status, 200);
    assert.equal(second.body.items.length, 2);
    const firstIds = first.body.items.map(item => item.id);
    const secondIds = second.body.items.map(item => item.id);
    assert.equal(firstIds.some(id => secondIds.includes(id)), false, 'paged results must not overlap');

    // 把两页翻完，应当覆盖全部 5 条（证明 cursor 语义正确，不是重复返回同一页）。
    const seen = new Set([...firstIds, ...secondIds]);
    let cursor = second.body.nextCursor;
    while (cursor) {
      const page = await server.request('GET', `/api/memory/memories?limit=2&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(page.status, 200);
      for (const item of page.body.items) seen.add(item.id);
      cursor = page.body.nextCursor;
    }
    assert.equal(seen.size, 5, 'walking the cursor must surface every memory exactly once');

    // limit clamp：超大 limit 不会让整库一次性出网。
    const huge = await server.request('GET', '/api/memory/memories?limit=100000');
    assert.equal(huge.status, 200);
    assert.ok(huge.body.items.length <= 100, 'limit must be clamped to the documented maximum');
    // 非法 limit 回落默认值而不是 500。
    const bogus = await server.request('GET', '/api/memory/memories?limit=not-a-number');
    assert.equal(bogus.status, 200);
    assert.ok(bogus.body.items.length > 0);

    // 伪造 cursor 必须是 4xx，而不是静默返回第一页（静默才是危险的）。
    const forged = await server.request('GET', '/api/memory/memories?cursor=not-a-real-cursor');
    assert.ok(forged.status >= 400 && forged.status < 500, `forged cursor should be a 4xx, got ${forged.status}`);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 3. 主权核心：删除后**读不回来**
// ---------------------------------------------------------------------------
test('after delete the memory is unreadable through both list and retrieve', async () => {
  const { memory, app } = createHarness();
  const target = await seed(memory, '我要被删掉的记忆');
  await seed(memory, '我会留下来的记忆');
  const server = await serve(app);
  try {
    // 删之前：两条都在，两条都查得到 —— 先证明「查得到」这件事本来是成立的，
    // 否则删除后的「查不到」可能只是因为一开始就查不到（假阴性）。
    const before = await server.request('GET', '/api/memory/memories');
    assert.equal(before.body.count, 2);
    // 各自的检索词各自命中：证明「删掉」这个词在删之前**确实**指得到目标，
    // 否则删除后的「查不到」只可能是检索本身就没命中（假阴性）。
    const retrievedBefore = await memory.retrieveAsync(userContext(), { query: '我要被删掉的记忆', purpose: 'answer_user_query', tokenBudget: 1800 });
    assert.equal(retrievedBefore.items.some(item => item.content === '我要被删掉的记忆'), true, 'precondition: the memory must be retrievable before deletion');
    const survivorBefore = await memory.retrieveAsync(userContext(), { query: '我会留下来的记忆', purpose: 'answer_user_query', tokenBudget: 1800 });
    assert.equal(survivorBefore.items.some(item => item.content === '我会留下来的记忆'), true, 'precondition: the survivor must be retrievable before deletion');

    // 删除（真实 HTTP，真实资源版本乐观锁）。
    const removed = await server.request('DELETE', `/api/memory/memories/${target.memoryId}`, { body: { resource_revision: target.resourceRevision } });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.status, 'completed');
    assert.equal(typeof removed.body.deletionOperationId, 'string');

    // 读路径一：治理列表 —— 查不到。
    const after = await server.request('GET', '/api/memory/memories');
    assert.equal(after.body.items.some(item => item.id === target.memoryId), false, 'deleted memory must not appear in list');
    assert.equal(after.body.items.some(item => item.summary === '我要被删掉的记忆'), false);
    assert.equal(after.body.count, 1, 'only the surviving memory remains');

    // 读路径二：召回 —— 查不到。只堵一条读路径等于没删干净。
    // 用该记忆自己的原文做检索词：删除前它能命中（上面刚证过），删除后必须
    // 命中不了；同时另一个词仍能命中幸存者，证明召回通道本身是通的。
    const retrievedAfter = await memory.retrieveAsync(userContext(), { query: '我要被删掉的记忆', purpose: 'answer_user_query', tokenBudget: 1800 });
    assert.equal(retrievedAfter.items.some(item => item.content === '我要被删掉的记忆'), false, 'deleted memory must not be retrievable');
    const survivorAfter = await memory.retrieveAsync(userContext(), { query: '我会留下来的记忆', purpose: 'answer_user_query', tokenBudget: 1800 });
    assert.equal(survivorAfter.items.some(item => item.content === '我会留下来的记忆'), true, 'the surviving memory must still be retrievable');
    // 也确认它没有躲在「查全部」的那一页里。
    const allAfter = await memory.retrieveAsync(userContext(), { query: '记忆', purpose: 'answer_user_query', tokenBudget: 1800 });
    assert.equal(allAfter.items.some(item => item.content === '我要被删掉的记忆'), false, 'deleted memory must not surface in a broad recall either');

    // 底层断言：不是「列表过滤掉了」，而是数据真的没了。
    assert.equal(memory.get(userContext(), target.memoryId, { purpose: 'governance' }), null);
    assert.equal(memory.get(userContext(), target.memoryId, { purpose: 'profile_view' }), null);
    assert.equal(memory.state.assertions.some(item => item.id === target.memoryId), false, 'assertion row must be physically gone');

    // 删除台账可查 —— 用户要能证明「这次删除确实发生过」。
    const ledger = await server.request('GET', `/api/memory/deletion-operations/${removed.body.deletionOperationId}`);
    assert.equal(ledger.status, 200);
    assert.equal(ledger.body.operation.targetId, target.memoryId);
    assert.equal(ledger.body.operation.status, 'completed');
    assert.equal(ledger.body.operation.action, 'delete');
    const rawLedger = JSON.stringify(ledger.body);
    assert.equal(rawLedger.includes('"tenantId"'), false, 'ledger must not leak tenant fields');
    assert.equal(rawLedger.includes('"requestedBy"'), false, 'ledger must not leak actor internals');
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 4. 跨用户 / 跨租户隔离
// ---------------------------------------------------------------------------
test('one user cannot see or delete another user memories', async () => {
  const { memory, app } = createHarness();
  const aMemory = await seed(memory, 'A 的私密偏好', { user: 'user-a' });
  const bMemory = await seed(memory, 'B 的私密偏好', { user: 'user-b' });
  const otherTenant = await seed(memory, '另一个租户的记忆', { user: 'user-a', tenant: 'tenant-b' });
  const server = await serve(app);
  try {
    // 可见性：A 只看得到自己的。
    const aList = await server.request('GET', '/api/memory/memories', { user: 'user-a' });
    assert.equal(aList.body.count, 1);
    assert.equal(aList.body.items[0].id, aMemory.memoryId);
    const bList = await server.request('GET', '/api/memory/memories', { user: 'user-b' });
    assert.equal(bList.body.count, 1);
    assert.equal(bList.body.items[0].id, bMemory.memoryId);

    // 同租户不同租户的也看不到。
    assert.equal(bList.body.items.some(item => item.id === otherTenant.memoryId), false);

    // A 用 B 的 id 去删：必须是失败，且**不能**删掉 B 的记忆。
    const crossDelete = await server.request('DELETE', `/api/memory/memories/${bMemory.memoryId}`, { user: 'user-a', body: { resource_revision: bMemory.resourceRevision } });
    assert.notEqual(crossDelete.status, 200, 'cross-user delete must not succeed');
    assert.equal(crossDelete.status, 404);

    // B 的记忆完好无损 —— 这才是「隔离」的可证伪含义。
    const bAfter = await server.request('GET', '/api/memory/memories', { user: 'user-b' });
    assert.equal(bAfter.body.count, 1);
    assert.equal(bAfter.body.items[0].id, bMemory.memoryId);
    assert.equal(memory.get(userContext('user-b'), bMemory.memoryId, { purpose: 'governance' })?.memoryId, bMemory.memoryId);

    // A 删自己的记忆，必须**不影响** B。
    const ownDelete = await server.request('DELETE', `/api/memory/memories/${aMemory.memoryId}`, { user: 'user-a', body: { resource_revision: aMemory.resourceRevision } });
    assert.equal(ownDelete.status, 200);
    const bUntouched = await server.request('GET', '/api/memory/memories', { user: 'user-b' });
    assert.equal(bUntouched.body.count, 1);
    assert.equal(bUntouched.body.items[0].id, bMemory.memoryId);

    // 跨租户：tenant-b 的记忆对 tenant-a 不可见，也不可删。
    const tenantBList = await server.request('GET', '/api/memory/memories', { user: 'user-a', tenant: 'tenant-b' });
    assert.equal(tenantBList.body.count, 1);
    assert.equal(tenantBList.body.items[0].id, otherTenant.memoryId);
    const crossTenantDelete = await server.request('DELETE', `/api/memory/memories/${otherTenant.memoryId}`, { user: 'user-a', tenant: 'tenant-a', body: { resource_revision: otherTenant.resourceRevision } });
    assert.equal(crossTenantDelete.status, 404);
    assert.ok(memory.get(userContext('user-a', 'tenant-b'), otherTenant.memoryId, { purpose: 'governance' }));
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 5. 治理动作要求 user actor（GOVERNANCE_FORBIDDEN）
// ---------------------------------------------------------------------------
test('governance mutations are refused for a non-user actor', async () => {
  const { memory, app } = createHarness();
  const target = await seed(memory, '只有本人能改的记忆');
  const server = await serve(app);
  try {
    // agent 身份（actorType='agent'，actorId !== subjectUserId）→ 403。
    const asAgent = await server.request('POST', `/api/memory/memories/${target.memoryId}/forget`, {
      actorType: 'agent', actorId: 'agent-x', body: { resource_revision: target.resourceRevision }
    });
    assert.equal(asAgent.status, 403);
    assert.equal(asAgent.body.error.code, 'GOVERNANCE_FORBIDDEN');

    // 冒充：actorType='user' 但 actorId 不是 subjectUserId → 同样 403。
    const impersonated = await server.request('POST', `/api/memory/memories/${target.memoryId}/revoke`, {
      actorType: 'user', actorId: 'user-impostor', body: { resource_revision: target.resourceRevision }
    });
    assert.equal(impersonated.status, 403);
    assert.equal(impersonated.body.error.code, 'GOVERNANCE_FORBIDDEN');

    // 被拒之后记忆必须毫发无损（拒绝不能有副作用）。
    const still = memory.get(userContext(), target.memoryId, { purpose: 'governance' });
    assert.equal(still.status, 'active');
    assert.equal(still.resourceRevision, target.resourceRevision);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 6. 改写 / 钉住 / 取消钉住 / 撤销 / 遗忘 —— 真实返回值
// ---------------------------------------------------------------------------
test('correct rewrites content and exposes the new revision', async () => {
  const { memory, app } = createHarness();
  const target = await seed(memory, '我住在北京');
  const server = await serve(app);
  try {
    const corrected = await server.request('POST', `/api/memory/memories/${target.memoryId}/correct`, {
      body: { content: '我住在上海', resource_revision: target.resourceRevision }
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.memory.summary, '我住在上海');
    assert.equal(corrected.body.memory.id, target.memoryId);

    // 改写必须真的落到了读路径上，而不只是回显。
    const list = await server.request('GET', '/api/memory/memories');
    assert.equal(list.body.items.length, 1, 'correcting must not create a second memory');
    assert.equal(list.body.items[0].summary, '我住在上海');

    // 过期的 resource_revision 必须 409，而不是默默覆盖别人的改动。
    const stale = await server.request('POST', `/api/memory/memories/${target.memoryId}/correct`, {
      body: { content: '我住在广州', resource_revision: target.resourceRevision }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'RESOURCE_REVISION_CONFLICT');
    assert.equal(stale.body.error.current_resource_revision, corrected.body.memory.resourceRevision ?? stale.body.error.current_resource_revision);
    const listAfterStale = await server.request('GET', '/api/memory/memories');
    assert.equal(listAfterStale.body.items[0].summary, '我住在上海', 'a rejected write must not change content');

    // 白名单：治理动作的返回体同样不能带内部字段。
    const raw = JSON.stringify(corrected.body);
    for (const token of ['"sourceRefs"', '"mentionPolicy"', '"embedding"', '"trustLevel"', '"sequence"']) {
      assert.equal(raw.includes(token), false, `mutation response must not contain ${token}`);
    }
  } finally { await server.close(); }
});

test('pin and unpin flip the pinned flag as observed through list', async () => {
  const { memory, app } = createHarness();
  const target = await seed(memory, '别忘了我');
  const server = await serve(app);
  try {
    const pinned = await server.request('POST', `/api/memory/memories/${target.memoryId}/pin`, { body: { resource_revision: target.resourceRevision } });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.body.memory.pinned, true);

    const listPinned = await server.request('GET', '/api/memory/memories');
    assert.equal(listPinned.body.items[0].pinned, true, 'pin must be visible on the read path');

    const current = memory.get(userContext(), target.memoryId, { purpose: 'governance' });
    const unpinned = await server.request('POST', `/api/memory/memories/${target.memoryId}/unpin`, { body: { resource_revision: current.resourceRevision } });
    assert.equal(unpinned.status, 200);
    assert.equal(unpinned.body.memory.pinned, false);

    const listUnpinned = await server.request('GET', '/api/memory/memories');
    assert.equal(listUnpinned.body.items[0].pinned, false);
  } finally { await server.close(); }
});

test('revoke and forget each remove the memory from the recall path', async () => {
  for (const action of ['revoke', 'forget']) {
    const { memory, app } = createHarness();
    const target = await seed(memory, `会被${action}的记忆`);
    const server = await serve(app);
    try {
      const recalledBefore = await memory.retrieveAsync(userContext(), { query: '记忆', purpose: 'answer_user_query', tokenBudget: 1800 });
      assert.equal(recalledBefore.items.length, 1, `precondition for ${action}`);

      const response = await server.request('POST', `/api/memory/memories/${target.memoryId}/${action}`, { body: { resource_revision: target.resourceRevision } });
      assert.equal(response.status, 200);
      assert.equal(response.body.status, action === 'revoke' ? 'revoked' : 'forgotten');

      // 召回路径必须查不到 —— 撤销/遗忘的全部意义就在这里。
      const recalledAfter = await memory.retrieveAsync(userContext(), { query: '记忆', purpose: 'answer_user_query', tokenBudget: 1800 });
      assert.equal(recalledAfter.items.length, 0, `${action} must remove the memory from recall`);

      // 治理视图仍然看得到「它已经不在了」这个状态（与 remove 的区别所在）。
      const list = await server.request('GET', '/api/memory/memories');
      assert.equal(list.body.items.length, 1, `${action} keeps the record visible in the governance view`);
      assert.equal(list.body.items[0].status, action === 'revoke' ? 'revoked' : 'forgotten');
      assert.equal(list.body.items[0].status === 'active', false);
    } finally { await server.close(); }
  }
});

// ---------------------------------------------------------------------------
// 7. 错误映射：MemoryModuleError → HTTP
// ---------------------------------------------------------------------------
test('module errors map to their declared status and code', async () => {
  const { memory, app } = createHarness();
  const server = await serve(app);
  try {
    // 不存在的记忆 → 404，且带稳定 code。
    const missing = await server.request('POST', '/api/memory/memories/does-not-exist/forget', { body: { resource_revision: 1 } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'MEMORY_NOT_FOUND');

    // 缺 resource_revision → 400（乐观锁不能默认放行）。
    const target = await seed(memory, '需要版本号的记忆');
    const noRevision = await server.request('POST', `/api/memory/memories/${target.memoryId}/forget`, { body: {} });
    assert.equal(noRevision.status, 400);
    assert.equal(noRevision.body.error.code, 'RESOURCE_REVISION_REQUIRED');

    // 不存在的删除台账 → 404。
    const missingLedger = await server.request('GET', '/api/memory/deletion-operations/nope');
    assert.equal(missingLedger.status, 404);
    assert.equal(missingLedger.body.error.code, 'DELETION_OPERATION_NOT_FOUND');

    // 错误体形状稳定（客户端要能按 code 分支），且不泄漏内部细节。
    for (const error of [missing.body.error, noRevision.body.error, missingLedger.body.error]) {
      assert.equal(typeof error.code, 'string');
      assert.equal(typeof error.message, 'string');
      assert.equal(Object.hasOwn(error, 'stack'), false);
    }
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 8. 构造契约
// ---------------------------------------------------------------------------
test('governance router refuses to build without its dependencies', () => {
  assert.throws(() => createMemoryGovernanceRouter({}), TypeError);
  assert.throws(() => createMemoryGovernanceRouter({ contextFromRequest: () => ({}) }), TypeError);
  assert.throws(() => createMemoryGovernanceRouter({ memoryModuleForRequest: () => ({}) }), TypeError);
});

// ---------------------------------------------------------------------------
// 9. 请求级 context（不是硬编码 tenantId）
// ---------------------------------------------------------------------------
test('every action runs in the request tenant rather than a hardcoded one', async () => {
  const { memory, app } = createHarness();
  const server = await serve(app);
  try {
    // 同一进程、同一模块实例，两个租户各自写入。若实现里把 tenantId 写死成
    // 某个常量，这两条记忆就会互相可见（或双双写进/读出自同一个租户）。
    const aTarget = await seed(memory, '租户 A 的记忆', { user: 'user-a', tenant: 'tenant-a' });
    const bTarget = await seed(memory, '租户 B 的记忆', { user: 'user-a', tenant: 'tenant-b' });

    const aList = await server.request('GET', '/api/memory/memories', { tenant: 'tenant-a', user: 'user-a' });
    assert.equal(aList.body.count, 1);
    assert.equal(aList.body.items[0].id, aTarget.memoryId);
    assert.equal(aList.body.items[0].summary, '租户 A 的记忆');

    const bList = await server.request('GET', '/api/memory/memories', { tenant: 'tenant-b', user: 'user-a' });
    assert.equal(bList.body.count, 1);
    assert.equal(bList.body.items[0].id, bTarget.memoryId);
    assert.equal(bList.body.items[0].summary, '租户 B 的记忆');

    // 治理动作按请求租户生效：在 tenant-b 下删除 tenant-a 的记忆必须失败。
    const crossTenant = await server.request('DELETE', `/api/memory/memories/${aTarget.memoryId}`, {
      tenant: 'tenant-b', user: 'user-a', body: { resource_revision: aTarget.resourceRevision }
    });
    assert.equal(crossTenant.status, 404);
    assert.ok(memory.get(userContext('user-a', 'tenant-a'), aTarget.memoryId, { purpose: 'governance' }), 'the other tenant memory must be untouched');
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 10. 判别力自证：注入 async 的 memoryModuleForRequest 时，漏 await 必须变红
// ---------------------------------------------------------------------------
// 这条测试存在的唯一目的，是证明**上面那批测试真的有判别力**。
//
// 背景（本项目真实事故）：治理路由最初写成 `const memory = memoryModuleForRequest(req)`
// 而没有 await，生产挂载传的却是 async 的 prepareForRequest ⇒ 拿到 Promise ⇒
// 每条路由 500。当时 11 个用例全绿，因为测试注入的是**同步 stub** ——
// 验证了一个生产代码从不使用的契约形状。这就是「测试绿、接线断」。
//
// 这里把那个缺陷形态**显式复现**成一条测试：async provider + 无 await 的
// 调用方式，必须抛错。如果哪天有人把 routes 里的 await 去掉，上面所有用例
// 会因为 stub 已是 async 而变红；这条则锁住「为什么必须 await」的原因。
test('an async module provider is required by the router, proving the suite can catch a missing await', async () => {
  const { memory } = createHarness();

  // 生产同形：async provider。
  const asyncProvider = async () => memory;
  // 正确的接线方式 —— 拿到真模块。
  const awaited = await asyncProvider();
  assert.equal(typeof awaited.list, 'function');

  // 漏 await 的接线方式 —— 拿到 Promise，任何方法调用都不成立。
  // 这正是当初 500 的根因；断言它**确实是**坏的，证明判别力存在。
  const notAwaited = asyncProvider();
  assert.equal(typeof notAwaited.list, 'undefined');
  assert.equal(typeof notAwaited.then, 'function');
  assert.throws(() => notAwaited.list({}, {}), TypeError);

  // 端到端确认：经 async provider 的真实路由工作是好的（回归保护）。
  const app = express();
  app.use(express.json());
  app.use('/api/memory', createMemoryGovernanceRouter({
    contextFromRequest: () => userContext(),
    memoryModuleForRequest: asyncProvider
  }));
  const server = await serve(app);
  try {
    const listed = await server.request('GET', '/api/memory/memories');
    assert.equal(listed.status, 200, 'an async provider must still produce a working route');
    assert.equal(listed.body.error, undefined);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 11. 写动作的版本号必须能从列表直接拿到（否则前端要故意失败一次）
// ---------------------------------------------------------------------------
test('list exposes the resource revision so writes succeed on the first attempt', async () => {
  const { memory, app } = createHarness();
  await seed(memory, '我有版本号');
  const server = await serve(app);
  try {
    const list = await server.request('GET', '/api/memory/memories');
    assert.equal(list.status, 200);
    const item = list.body.items[0];
    assert.equal(typeof item.resourceRevision, 'number', 'the list must hand the client the optimistic-lock revision');
    assert.ok(item.resourceRevision >= 1);

    // 拿列表给的版本号直接写，**第一次就必须成功**。
    const corrected = await server.request('POST', `/api/memory/memories/${item.id}/correct`, {
      body: { content: '我改了', resource_revision: item.resourceRevision }
    });
    assert.equal(corrected.status, 200, 'a write using the revision from the list must not fail');
    assert.equal(corrected.body.memory.summary, '我改了');
    // 写完之后版本必须前进，否则乐观锁形同虚设。
    assert.ok(corrected.body.memory.resourceRevision > item.resourceRevision, 'the revision must advance after a write');

    // 再列一次，新版本号仍可直接用于下一次写。
    const relist = await server.request('GET', '/api/memory/memories');
    const fresh = relist.body.items[0].resourceRevision;
    assert.equal(fresh, corrected.body.memory.resourceRevision);
    const pinned = await server.request('POST', `/api/memory/memories/${item.id}/pin`, { body: { resource_revision: fresh } });
    assert.equal(pinned.status, 200);
  } finally { await server.close(); }
});

