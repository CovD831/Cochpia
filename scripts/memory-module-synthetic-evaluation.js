import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';
import { evaluateMemoryRetrieval } from '../server/memory-module-eval.js';

const casesPath = path.resolve(process.cwd(), process.env.MEMORY_EVAL_CASES || 'docs/memory-module-eval-v0.2.json');
const outputPath = path.resolve(process.cwd(), process.env.MEMORY_EVAL_SYNTHETIC_RESULTS || 'docs/memory-module-eval-v0.2-synthetic-results.json');
const tenantId = 'synthetic-eval-tenant';
const userId = 'synthetic-eval-user';

const userContext = (overrides = {}) => ({ tenantId, subjectUserId: userId, actorType: 'user', actorId: userId, ...overrides });
const agentContext = (agentId = 'cochpia', overrides = {}) => ({ tenantId, subjectUserId: userId, actorType: 'agent', actorId: agentId, callerAgentId: agentId, ...overrides });

async function makeMemory(caseItem) {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  const user = userContext();
  const querySignal = caseItem.query.replace(/[^\p{L}\p{N}_-]+/gu, ' ');
  // 采集 S2/S3 假阴率所需的 hold 落地状态与分类敏感度（向后兼容: 旧 600 case
  // 无 expectedSensitivity, 天然被排除在该指标分母之外）。
  let holdStatus = null;
  let sensitivity = 'S0';
  const captureHold = async (ctx, input) => {
    const held = await memory.hold(ctx, input);
    holdStatus = held.status;
    sensitivity = held.memory?.sensitivity || sensitivity;
    return held;
  };

  if (caseItem.expectedMode === 'known') {
    if (caseItem.scope === 'relationship') {
      await captureHold(user, {
        content: `${caseItem.expected} ${querySignal}`,
        memoryType: 'relationship',
        scopeType: 'relationship',
        relationshipAgentId: caseItem.agent || 'cochpia',
        canonicalKey: `synthetic:${caseItem.expected}`
      });
    } else {
      await captureHold(user, { content: `${caseItem.expected} ${querySignal}`, memoryType: caseItem.category, canonicalKey: `synthetic:${caseItem.expected}` });
    }
  } else if (caseItem.expectedMode === 'conflict') {
    const canonicalKey = `synthetic:${caseItem.expected}`;
    await memory.hold(user, { content: `${caseItem.expected}:old ${querySignal}`, canonicalKey });
    await captureHold(user, { content: `${caseItem.expected}:new ${querySignal}`, canonicalKey });
  } else if (caseItem.expectedMode === 'authorization') {
    if (caseItem.query.includes('cross_agent')) {
      await captureHold(user, { content: 'synthetic-cross_agent-secret', scopeType: 'relationship', relationshipAgentId: 'other-agent', memoryType: 'relationship' });
    } else if (caseItem.query.includes('missing_grant')) {
      await captureHold(user, { content: 'synthetic-missing_grant-secret', memoryType: 'fact' });
    } else if (caseItem.query.includes('forged_user')) {
      await captureHold(userContext({ subjectUserId: 'other-user', actorId: 'other-user' }), { content: 'synthetic-forged_user-secret', memoryType: 'fact' });
    } else {
      await captureHold(userContext({ tenantId: 'other-tenant', subjectUserId: 'other-user', actorId: 'other-user' }), { content: `synthetic-${caseItem.expected}-secret`, memoryType: 'fact' });
    }
  }

  const context = caseItem.expectedMode === 'authorization' && (caseItem.query.includes('cross_agent') || caseItem.query.includes('missing_grant'))
    ? agentContext('cochpia')
    : caseItem.scope === 'relationship' ? agentContext(caseItem.agent || 'cochpia') : userContext();
  const result = memory.retrieve(context, { query: caseItem.query, purpose: 'answer_user_query' });
  return {
    answerability: result.answerability,
    policyResult: result.policyResult,
    holdStatus,
    sensitivity,
    items: result.items.map(item => ({
      memoryId: item.memoryId,
      versionId: item.versionId,
      content: item.content,
      sourceRefs: item.sourceRefs,
      scope: item.scope
    })),
    uncertainties: result.uncertainties || []
  };
}

const cases = JSON.parse(await readFile(casesPath, 'utf8'));
if (!Array.isArray(cases) || cases.length !== 600 || cases.some(item => item.synthetic !== true)) throw new Error('Synthetic evaluation requires the versioned 600-case synthetic scaffold');

// ---------------------------------------------------------------------------
// 胶水探针: 用真实 memory module 走 S2/S3 假阴率 与 proactive mention(含 cooldown)
// 的"正例 + 负例 + 边界"路径, 让 evaluateMemoryRetrieval 能算出这两族协议指标。
// 这些探针不计入 600-case 基线(基线契约 600 条不变), 仅用于 CI 通路验证 —— 它们
// 不是真实评测数字, 仅证明 harness 全链路能产出新指标键。
// ---------------------------------------------------------------------------
async function buildGlueProbes() {
  const tenantId = 'synthetic-glue-tenant';
  const userId = 'synthetic-glue-user';
  const userCtx = () => ({ tenantId, subjectUserId: userId, actorType: 'user', actorId: userId });
  const agentCtx = () => ({ tenantId, subjectUserId: userId, actorType: 'agent', actorId: 'cochpia', callerAgentId: 'cochpia' });
  const probeCases = [];
  const probeResults = {};

  const holdCapture = async (ctx, input) => {
    const state = createMemoryModuleState();
    const memory = createMemoryModule(state);
    // proactive mention 需要 agent 对用户 scope 持有 'mention' 授权(见
    // memory-module.js hasGrant); 这里为探针授予, 否则 canSee 在
    // purpose='proactive_mention' 下直接拒绝, 与"授权规则一致"的度量前提不符。
    try {
      await memory.grantUserScope(userCtx(), { agentId: 'cochpia', permissions: ['mention'] });
    } catch {
      // 某些状态/上下文下 grant 可能不可达, 探针仅用于通路验证, 忽略即可。
    }
    try {
      const held = await memory.hold(ctx, input);
      return { memory, state, holdStatus: held.status, sensitivity: held.memory?.sensitivity || 'S0', error: null, memoryId: held.memory?.memoryId };
    } catch (err) {
      return { memory, state, holdStatus: 'rejected', sensitivity: 'S3', error: { code: err?.code || 'REJECTED', message: err?.message }, memoryId: null };
    }
  };

  const mentionOf = (memory, state, id, topicKey, query) => {
    const out = memory.retrieve(agentCtx(), { query, purpose: 'proactive_mention', topicKey });
    const mentioned = out.items.some(item => item.memoryId === id);
    const cooldownActive = (state.mentionCooldowns || []).some(record => record.memoryId === id
      && (!record.topicKey || !topicKey || record.topicKey === topicKey)
      && record.cooldownUntil && new Date(record.cooldownUntil).getTime() > Date.now());
    return { mentioned, cooldownActive, authorized: true };
  };

  // --- S2: 正确路径(健康词命中 -> pending_confirmation) ---
  {
    const id = 'glue-s2-confirm-ok';
    const held = await holdCapture(userCtx(), { content: '我最近在服用华法林抗凝治疗, 医生说每周验血', memoryType: 'fact', canonicalKey: 'glue:s2-ok' });
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedSensitivity: 'S2', expectedMode: 'known', query: '华法林', expected: '华法林抗凝' });
    probeResults[id] = { holdStatus: held.holdStatus, sensitivity: held.sensitivity, items: [], answerability: held.holdStatus };
  }
  // --- S2: 负例/边界(标注为 S2 但无触发词 -> 被错误放行 active) ---
  // 注: 内容刻意不含 detectS2 关键词, 模拟"标注敏感但分类器欠分档"的真实
  // 假阴场景; 若分类器正确识别为 S2, 该探针会自动转为正确项, 不影响指标定义。
  {
    const id = 'glue-s2-fn-released';
    const held = await holdCapture(userCtx(), { content: '用户透露了一个不便对外公开的私人安排, 没有用明确敏感词', memoryType: 'fact', canonicalKey: 'glue:s2-fn' });
    const out = held.memory.retrieve(userCtx(), { query: '不便公开的私人安排', purpose: 'answer_user_query' });
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedSensitivity: 'S2', expectedMode: 'known', query: '不便公开的私人安排', expected: '不便公开的私人安排' });
    probeResults[id] = { holdStatus: held.holdStatus, sensitivity: held.sensitivity, items: out.items.map(item => ({ memoryId: item.memoryId, content: item.content })), answerability: out.answerability };
  }
  // --- S3: 正确路径(secret 模式 -> 入口拒绝) ---
  {
    const id = 'glue-s3-reject-ok';
    const held = await holdCapture(userCtx(), { content: 'my api key is sk-abcdefghijklmnopqrstuvw', memoryType: 'fact', canonicalKey: 'glue:s3-ok' });
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedSensitivity: 'S3', expectedMode: 'known', query: 'sk key', expected: 'sk secret' });
    probeResults[id] = { holdStatus: held.holdStatus, sensitivity: held.sensitivity, error: held.error, items: [], answerability: 'not_found' };
  }
  // --- S3: 负例(标注 S3 但无 secret 模式 -> 被错误落库 active) ---
  {
    const id = 'glue-s3-fn-released';
    const held = await holdCapture(userCtx(), { content: 'this is a sensitive credential phrase with no digit pattern', memoryType: 'fact', canonicalKey: 'glue:s3-fn' });
    const out = held.memory.retrieve(userCtx(), { query: 'credential phrase', purpose: 'answer_user_query' });
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedSensitivity: 'S3', expectedMode: 'known', query: 'credential phrase', expected: 'credential' });
    probeResults[id] = { holdStatus: held.holdStatus, sensitivity: held.sensitivity, items: out.items.map(item => ({ memoryId: item.memoryId, content: item.content })), answerability: out.answerability };
  }
  // --- proactive mention: 正确(可提及, 非冷却) ---
  {
    const id = 'glue-mention-ok';
    const held = await holdCapture(userCtx(), { content: '用户喜欢红茶', memoryType: 'preference', canonicalKey: 'glue:tea' });
    const m = mentionOf(held.memory, held.state, held.memoryId, 'preference:tea', '用户喜欢红茶');
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedMention: true, mentionTopicKey: 'preference:tea', expectedMode: 'known', query: '喜欢红茶', expected: '喜欢红茶' });
    probeResults[id] = { items: [], answerability: 'not_found', mention: { ...m, mentionable: true } };
  }
  // --- proactive mention: 冷却期内正确抑制 ---
  {
    const id = 'glue-mention-cooldown-ok';
    const held = await holdCapture(userCtx(), { content: '用户喜欢咖啡', memoryType: 'preference', canonicalKey: 'glue:coffee' });
    await held.memory.recordMention(agentCtx(), { memory_ids: [held.memoryId], topic_key: 'preference:coffee', cooldown_ms: 3600 * 1000 });
    const m = mentionOf(held.memory, held.state, held.memoryId, 'preference:coffee', '用户喜欢咖啡');
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedMention: true, mentionTopicKey: 'preference:coffee', cooldownMs: 3600 * 1000, expectedMode: 'known', query: '喜欢咖啡', expected: '喜欢咖啡' });
    probeResults[id] = { items: [], answerability: 'not_found', mention: { ...m, mentionable: true } };
  }
  // --- proactive mention: 冷却边界(cooldownUntil == now, 严格 > 故不激活) ---
  {
    const id = 'glue-mention-cooldown-boundary';
    const held = await holdCapture(userCtx(), { content: '用户喜欢绿茶', memoryType: 'preference', canonicalKey: 'glue:green-tea' });
    await held.memory.recordMention(agentCtx(), { memory_ids: [held.memoryId], topic_key: 'preference:green-tea', cooldown_ms: 1 });
    held.state.mentionCooldowns[held.state.mentionCooldowns.length - 1].cooldownUntil = new Date(Date.now()).toISOString();
    const m = mentionOf(held.memory, held.state, held.memoryId, 'preference:green-tea', '用户喜欢绿茶');
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedMention: true, mentionTopicKey: 'preference:green-tea', cooldownMs: 1, expectedMode: 'known', query: '喜欢绿茶', expected: '喜欢绿茶' });
    probeResults[id] = { items: [], answerability: 'not_found', mention: { ...m, mentionable: true } };
  }
  // --- proactive mention: do_not_mention(期望不提及 -> 正确抑制) ---
  {
    const id = 'glue-mention-dnm';
    const held = await holdCapture(userCtx(), { content: '一个不应主动提及的偏好', sensitivity: 'S0', mentionPolicy: 'do_not_mention', memoryType: 'preference', canonicalKey: 'glue:dnm' });
    const m = mentionOf(held.memory, held.state, held.memoryId, 'preference:hidden', '一个不应主动提及的偏好');
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedMention: false, expectedMode: 'known', query: '不应主动提及', expected: '不应主动提及' });
    probeResults[id] = { items: [], answerability: 'not_found', mention: { ...m, mentionable: false } };
  }
  // --- proactive mention: 负例(期望提及却被 do_not_mention 压制 -> 假阴) ---
  {
    const id = 'glue-mention-fn';
    const held = await holdCapture(userCtx(), { content: '本应主动提及的偏好', sensitivity: 'S0', mentionPolicy: 'do_not_mention', memoryType: 'preference', canonicalKey: 'glue:mention-fn' });
    const m = mentionOf(held.memory, held.state, held.memoryId, 'preference:lost', '本应主动提及的偏好');
    probeCases.push({ id, version: 'v0.2', synthetic: true, split: 'acceptance', expectedMention: true, expectedMode: 'known', query: '应主动提及却被压制', expected: '应主动提及' });
    probeResults[id] = { items: [], answerability: 'not_found', mention: { ...m, mentionable: false } };
  }
  return { probeCases, probeResults };
}

const results = {};
for (const caseItem of cases) results[caseItem.id] = await makeMemory(caseItem);

const { probeCases, probeResults } = await buildGlueProbes();
const evalCases = [...cases, ...probeCases];
const evalResults = { ...results, ...probeResults };

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ version: 'v0.2', synthetic: true, acceptanceReady: false, results }, null, 2)}\n`);

const metrics = evaluateMemoryRetrieval(evalCases, evalResults, { k: 5 });
console.log(JSON.stringify({
  event: 'memory_module_synthetic_evaluation',
  casesPath,
  resultsPath: outputPath,
  synthetic: true,
  acceptanceReady: false,
  glueProbe: true,
  glueProbeNote: 'S2/S3 假阴率与 proactive mention(含 cooldown)为合成通路探针, 非真实评测数字',
  metrics
}));
