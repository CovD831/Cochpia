import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMemoryRetrieval } from './memory-module-eval.js';

// 胶水指标单测: S2/S3 假阴率 与 proactive mention(含 cooldown)。
// 风格随相邻测试(server/memory-module-eval.test.js): node:test + assert/strict,
// 直接用已知答案的 case/result 喂 evaluateMemoryRetrieval 并断言新键。

test('S2 hold 为 pending_confirmation 不计入假阴, active 视为放行假阴', () => {
  const cases = [
    { id: 's2-ok', expectedSensitivity: 'S2', expectedMode: 'known' },
    { id: 's2-released', expectedSensitivity: 'S2', expectedMode: 'known' }
  ];
  const results = {
    's2-ok': { holdStatus: 'pending_confirmation', sensitivity: 'S2', items: [] },
    's2-released': { holdStatus: 'active', sensitivity: 'S0', items: [] }
  };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  assert.equal(m.s2FalseNegativeRate, 0.5);
  assert.equal(m.s2s3FalseNegativeRate, 0.5);
  const detail = m.glueMetrics.s2s3.detail.find(item => item.id === 's2-released');
  assert.equal(detail.falseNegative, true);
  assert.equal(detail.reason, 'released_without_confirmation');
});

test('S2 被拒/丢失(非 pending_confirmation)也计入假阴', () => {
  const cases = [{ id: 's2-lost', expectedSensitivity: 'S2', expectedMode: 'known' }];
  const results = { 's2-lost': { holdStatus: 'rejected', sensitivity: 'S3', error: { code: 'S3_CONTENT_REJECTED' }, items: [] } };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  assert.equal(m.s2FalseNegativeRate, 1);
  assert.equal(m.glueMetrics.s2s3.detail[0].reason, 'lost_or_rejected');
});

test('S3 入口拒绝不计入假阴, 错误落库(active)视为放行假阴', () => {
  const cases = [
    { id: 's3-ok', expectedSensitivity: 'S3', expectedMode: 'known' },
    { id: 's3-released', expectedSensitivity: 'S3', expectedMode: 'known' }
  ];
  const results = {
    's3-ok': { holdStatus: 'rejected', sensitivity: 'S3', error: { code: 'S3_CONTENT_REJECTED' }, items: [] },
    's3-released': { holdStatus: 'active', sensitivity: 'S0', items: [{ memoryId: 'x' }] }
  };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  assert.equal(m.s3FalseNegativeRate, 0.5);
  assert.equal(m.glueMetrics.s2s3.detail.find(item => item.id === 's3-released').reason, 'released_into_store');
});

test('无 S2/S3 标注 case 时假阴率返回 null 且不干扰旧指标(向后兼容)', () => {
  const cases = [
    { id: 'k1', expected: 'red tea', expectedMode: 'known' },
    { id: 'n1', expected: 'missing', expectedMode: 'no_answer' }
  ];
  const results = {
    'k1': { items: [{ content: 'red tea', sourceRefs: ['s1'] }] },
    'n1': { answerability: 'not_found', items: [] }
  };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  assert.equal(m.s2s3FalseNegativeRate, null);
  assert.equal(m.s2FalseNegativeRate, null);
  assert.equal(m.s3FalseNegativeRate, null);
  assert.equal(m.recallAtK, 1);
  assert.equal(m.noAnswerAccuracy, 1);
  assert.ok(!Object.hasOwn(m.glueMetrics.s2s3.detail));
});

test('proactive mention 正例(可提及/非冷却/授权)计为正确', () => {
  const cases = [{ id: 'm-ok', expectedMention: true, expectedMode: 'known' }];
  const results = { 'm-ok': { items: [], mention: { mentioned: true, cooldownActive: false, authorized: true, mentionable: true } } };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  assert.equal(m.proactiveMentionRate, 1);
  assert.equal(m.glueMetrics.proactiveMention.detail[0].reason, 'mentioned');
});

test('proactive mention 冷却期内不提及计为 cooldown 遵守, 冷却期内仍提及计为假阴', () => {
  const cases = [
    { id: 'm-cool-ok', expectedMention: true, expectedMode: 'known' },
    { id: 'm-cool-viol', expectedMention: true, expectedMode: 'known' }
  ];
  const results = {
    'm-cool-ok': { items: [], mention: { mentioned: false, cooldownActive: true, authorized: true, mentionable: true } },
    'm-cool-viol': { items: [], mention: { mentioned: true, cooldownActive: true, authorized: true, mentionable: true } }
  };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  assert.equal(m.proactiveMentionRate, 0.5);
  assert.equal(m.proactiveMentionCooldownRate, 0.5);
  assert.equal(m.glueMetrics.proactiveMention.detail.find(item => item.id === 'm-cool-viol').reason, 'cooldown_violation');
});

test('proactive mention 冷却边界: cooldownActive=false 时提及正确, true 时提及为违规', () => {
  const cases = [
    { id: 'm-b-equal', expectedMention: true, expectedMode: 'known' },
    { id: 'm-b-active', expectedMention: true, expectedMode: 'known' }
  ];
  const results = {
    'm-b-equal': { items: [], mention: { mentioned: true, cooldownActive: false, authorized: true, mentionable: true } },
    'm-b-active': { items: [], mention: { mentioned: true, cooldownActive: true, authorized: true, mentionable: true } }
  };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  const equal = m.glueMetrics.proactiveMention.detail.find(item => item.id === 'm-b-equal');
  const active = m.glueMetrics.proactiveMention.detail.find(item => item.id === 'm-b-active');
  assert.equal(equal.correct, true);
  assert.equal(active.correct, false);
  assert.equal(active.reason, 'cooldown_violation');
});

test('proactive mention 期望不提却被提为假阳; 越权场景不提即正确', () => {
  const cases = [
    { id: 'm-suppress', expectedMention: false, expectedMode: 'known' },
    { id: 'm-wrongly', expectedMention: false, expectedMode: 'known' },
    { id: 'm-unauth', expectedMention: true, expectedMode: 'known' }
  ];
  const results = {
    'm-suppress': { items: [], mention: { mentioned: false, cooldownActive: false, authorized: true, mentionable: false } },
    'm-wrongly': { items: [], mention: { mentioned: true, cooldownActive: false, authorized: true, mentionable: false } },
    'm-unauth': { items: [], mention: { mentioned: false, cooldownActive: false, authorized: false, mentionable: true } }
  };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  assert.equal(m.proactiveMentionRate, 2 / 3);
  const wrongly = m.glueMetrics.proactiveMention.detail.find(item => item.id === 'm-wrongly');
  const unauth = m.glueMetrics.proactiveMention.detail.find(item => item.id === 'm-unauth');
  assert.equal(wrongly.reason, 'wrongly_mentioned');
  assert.equal(unauth.reason, 'unauthorized_not_mentioned');
  assert.equal(unauth.correct, true);
});

test('proactive mention 无标注 case 时速率返回 null(向后兼容)', () => {
  const cases = [{ id: 'k1', expected: 'tea', expectedMode: 'known' }];
  const results = { 'k1': { items: [{ content: 'tea' }] } };
  const m = evaluateMemoryRetrieval(cases, results, { k: 5 });
  assert.equal(m.proactiveMentionRate, null);
  assert.equal(m.proactiveMentionCooldownRate, null);
  assert.equal(m.recallAtK, 1);
});
