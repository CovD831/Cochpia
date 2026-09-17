// 记忆检索质量闸门（2026-09-17 立，老板裁决 1→3→2 的第 3 步）。
//
// 为什么需要它：本次 LoCoMo 评测第一次给出真实数字（Recall@10 0.6115 / MRR 0.4077）。
// 但「一次性评测」会腐烂——下次改检索代码时没人知道分数掉了没有。这个闸门把
// **退化检测**变成自动的：跑同一套 case，比对基线阈值，掉了就红。
//
// 数据策略（两级，因为 LoCoMo 有 2.8MB 不该进仓库）：
//   1. 若 eval-data/locomo10.json 存在 → 跑真集（取前 N 样本），对照真基线；
//   2. 否则 → 跑**内置确定性小集**（本文件构造），只守住「检索链路没坏」这条底线。
// 两级都判「不低于该级基线」。数据集缺失不算失败（否则 clone 下来就红），
// 但会在输出里明确标注当前是哪一级，避免把「小集全绿」误读成「真集达标」。
//
// 命门口径：evidence 命中（与 locomo-eval-evidence.mjs 一致）——不依赖模型生成，
// 不依赖答案形态，直测「标注为相关的轮次能否进前 K」。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';

const DATASET = path.resolve(process.cwd(), 'eval-data/locomo10.json');
const SAMPLE_LIMIT = Math.max(1, Number(process.env.MEMORY_QUALITY_SAMPLES || 3));
const QA_LIMIT = Math.max(0, Number(process.env.MEMORY_QUALITY_QA || 120));
const K = Math.max(1, Number(process.env.MEMORY_QUALITY_K || 10));

// 基线阈值。**必须与运行口径一致**——不同样本数是不同题目，分数不可比。
//   口径 A：默认 3 样本 / 120 QA（342 case）→ 0.6053 / 0.394（2026-09-17 实测）
//   口径 B：全量 10 样本 / 全部 QA（1977 case）→ 0.6115 / 0.4077（同实测）
// 阈值留约 3 个百分点抖动余量：低于它说明检索真退化，不是采样噪声。
// 注意：改 MEMORY_QUALITY_SAMPLES/QA 时必须同步改这里的基线，否则闸门会误报。
const BASELINE = {
  locomo: { recallAtK: 0.575, mrr: 0.365, label: 'LoCoMo 真集（3 样本 / 120 QA / 342 case）' },
  synthetic: { recallAtK: 1.0, mrr: 1.0, label: '内置小集（数据集缺失时的底线）' },
};

const TENANT = 'quality';
const USER = 'quality-user';
const AGENT = 'quality-agent';
const ctx = () => ({
  tenantId: TENANT, subjectUserId: USER,
  actorType: 'agent', actorId: AGENT, callerAgentId: AGENT,
});

// 内置小集：每条 case 自带「答案文本」，记忆与 case 一一对应。
// 这是**确定性**的（无随机、无模型），用来守「检索链路没坏」。
// 它不是质量评测（构造上必然高分），所以单独标注、单独基线。
export const BUILTIN_CASES = [
  { id: 'b1', memory: '我住在杭州西湖区', query: '我住在哪里', expected: '杭州' },
  { id: 'b2', memory: '我的猫叫团团，三岁了', query: '我的猫叫什么', expected: '团团' },
  { id: 'b3', memory: '我每天早上七点起床跑步', query: '我的作息习惯', expected: '跑步' },
  { id: 'b4', memory: '我不吃香菜和芹菜', query: '我的饮食禁忌', expected: '香菜' },
  { id: 'b5', memory: '我在做一个叫 Cochpia 的陪伴项目', query: '我在做什么项目', expected: 'Cochpia' },
  { id: 'b6', memory: '上周我去了趟北京出差三天', query: '我最近的出差', expected: '北京' },
  { id: 'b7', memory: '我的生日是十月十二号', query: '我的生日', expected: '十月' },
  { id: 'b8', memory: '我更喜欢用深色主题', query: '我的界面偏好', expected: '深色' },
];

async function runBuiltin() {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  const idToCase = new Map();
  for (const c of BUILTIN_CASES) {
    const res = await memory.hold(ctx(), {
      content: c.memory, memoryType: 'fact', assertionType: 'observed_fact',
      scopeType: 'relationship', relationshipAgentId: AGENT, sensitivity: 'S0',
    });
    const mid = res && res.memory ? res.memory.memoryId : null;
    if (mid) idToCase.set(mid, c);
  }
  let hits = 0;
  let rankSum = 0;
  const detail = [];
  for (const c of BUILTIN_CASES) {
    const r = await memory.retrieveAsync(ctx(), { query: c.query, purpose: 'answer_user_query', limit: K });
    const items = (r.items || []).slice(0, K);
    const rank = items.findIndex(i => (i.content || '').includes(c.expected)) + 1;
    if (rank > 0) { hits += 1; rankSum += 1 / rank; }
    detail.push({ id: c.id, hit: rank > 0, rank, returned: items.length });
  }
  return {
    level: 'synthetic',
    cases: BUILTIN_CASES.length,
    recallAtK: hits / BUILTIN_CASES.length,
    mrr: rankSum / BUILTIN_CASES.length,
    detail,
  };
}

function flattenTurns(sample) {
  const conv = sample.conversation || {};
  const sessions = Object.keys(conv).filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  const turns = [];
  for (const key of sessions) {
    const list = conv[key];
    const dateTime = conv[`${key}_date_time`] || '';
    if (!Array.isArray(list)) continue;
    for (const turn of list) {
      const text = String(turn.text || '').trim();
      if (text) turns.push({ diaId: turn.dia_id || null, speaker: turn.speaker || '', text, dateTime });
    }
  }
  return turns;
}

async function runLocomo() {
  const raw = JSON.parse(await readFile(DATASET, 'utf8'));
  const samples = raw.slice(0, SAMPLE_LIMIT);
  let total = 0; let hits = 0; let rankSum = 0;
  for (let si = 0; si < samples.length; si += 1) {
    const sample = samples[si];
    const turns = flattenTurns(sample);
    const qaList = QA_LIMIT > 0 ? (sample.qa || []).slice(0, QA_LIMIT) : (sample.qa || []);
    const state = createMemoryModuleState();
    const memory = createMemoryModule(state, async () => {});
    const diaToMemory = new Map();
    for (const turn of turns) {
      // 注意：structuredData 会进检索文本（retrievalDocuments 用
      // `content + JSON.stringify(structuredData)`），所以这里必须和
      // scripts/locomo-eval-evidence.mjs 写**完全相同的字段**——
      // 少写 speaker/dateTime 会让文档变短、检索结果偏移，导致同配置下
      // 分数不同（实测过：只写 diaId 得 0.5409，写全得 0.6053）。
      const res = await memory.hold(ctx(), {
        content: turn.text, memoryType: 'dialogue_turn', assertionType: 'observed_fact',
        scopeType: 'relationship', relationshipAgentId: AGENT, sensitivity: 'S0',
        structuredData: { locomo: { diaId: turn.diaId, speaker: turn.speaker, dateTime: turn.dateTime } },
      });
      const mid = res && res.memory ? res.memory.memoryId : null;
      if (mid && turn.diaId) diaToMemory.set(turn.diaId, mid);
    }
    for (const qa of qaList) {
      const expected = (qa.evidence || []).map(d => diaToMemory.get(String(d).trim())).filter(Boolean);
      if (!expected.length) continue;
      const r = await memory.retrieveAsync(ctx(), {
        query: String(qa.question || '').trim(), purpose: 'answer_user_query', limit: K,
      });
      const topK = (r.items || []).slice(0, K).map(i => i.memoryId);
      const rank = topK.findIndex(id => expected.includes(id)) + 1;
      total += 1;
      if (rank > 0) { hits += 1; rankSum += 1 / rank; }
    }
  }
  return {
    level: 'locomo',
    cases: total,
    recallAtK: total ? hits / total : 0,
    mrr: total ? rankSum / total : 0,
  };
}

async function main() {
  const useLocomo = existsSync(DATASET);
  const result = useLocomo ? await runLocomo() : await runBuiltin();
  const baseline = BASELINE[result.level];
  const recallDelta = Number((result.recallAtK - baseline.recallAtK).toFixed(4));
  const mrrDelta = Number((result.mrr - baseline.mrr).toFixed(4));
  const pass = result.recallAtK + 1e-9 >= baseline.recallAtK && result.mrr + 1e-9 >= baseline.mrr;

  const report = {
    event: 'memory_quality_gate',
    level: result.level,
    levelLabel: baseline.label,
    dataset: useLocomo ? DATASET : null,
    k: K,
    cases: result.cases,
    recallAtK: Number(result.recallAtK.toFixed(4)),
    mrr: Number(result.mrr.toFixed(4)),
    baseline: { recallAtK: baseline.recallAtK, mrr: baseline.mrr },
    delta: { recallAtK: recallDelta, mrr: mrrDelta },
    pass,
    note: useLocomo
      ? `真集评测（口径：${SAMPLE_LIMIT} 样本 / ${QA_LIMIT || '全部'} QA），对照同口径基线 ${baseline.recallAtK}/${baseline.mrr}`
      : '数据集缺失，跑内置小集（只守「链路没坏」，不代表真实检索质量）',
  };
  console.log(JSON.stringify(report, null, 2));
  if (!pass) {
    console.error(`\n✗ 记忆检索质量退化：Recall@${K} ${report.recallAtK} < 基线 ${baseline.recallAtK}，或 MRR ${report.mrr} < ${baseline.mrr}`);
    console.error('  先定位是哪类退化（多跳/时间/单跳/对抗），再决定改检索还是调基线。');
    console.error('  不要把基线调低来"修好"它——那是把腐烂洗白。');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(JSON.stringify({ event: 'memory_quality_gate_failed', code: error.code || 'UNEXPECTED', message: error.message }));
  process.exit(1);
});
