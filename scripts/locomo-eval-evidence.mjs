// LoCoMo 检索层评测（第二版采集器，2026-09-17）。
//
// 第一版（locomo-collect.mjs）用「答案字符串」做子串匹配，结论不可信，原因：
//   1. LoCoMo 的答案常是**推理产物**而非原文（Q:"When did X go" A:"7 May 2023"，
//      而原文说的是 "yesterday"）——子串匹配必然 0 分；
//   2. 我们的 retrieveAsync 忽略调用方 limit（硬编码 50），Recall@10 实际是
//      「在 50 条里找」。
//
// 本版改测**检索层本身**，用数据集自带的 evidence 标注：
//   - 每个 QA 的 `evidence` 形如 ["D1:3","D2:7"] —— 指向对话轮次（dia_id）；
//   - 我们把每轮对话写入记忆时，把 dia_id 存进 structuredData；
//   - 判定：检索结果的**最近 K 条里，是否包含该 case 的任一 evidence 轮**。
//
// 这个口径的好处：不依赖模型生成、不依赖答案形态，直测「相关记忆能否被召回」，
// 且与 LoCoMo 论文的 retrieval 评估口径一致（论文也报 evidence 命中）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';

const DATA = path.resolve(process.cwd(), process.env.LOCOMO_PATH || 'eval-data/locomo10.json');
const OUT_DIR = path.resolve(process.cwd(), process.env.LOCOMO_OUT_DIR || 'eval-data/out2');
const SAMPLE_LIMIT = Math.max(1, Number(process.env.LOCOMO_SAMPLE_LIMIT || 10));
const QA_LIMIT = Math.max(0, Number(process.env.LOCOMO_QA_LIMIT || 0));
const K = Math.max(1, Number(process.env.LOCOMO_K || 10));

const TENANT = 'locomo';
const USER = 'locomo-user';
const AGENT = 'locomo-agent';

const ctx = () => ({
  tenantId: TENANT, subjectUserId: USER,
  actorType: 'agent', actorId: AGENT, callerAgentId: AGENT,
});

function flattenTurns(sample) {
  const conv = sample.conversation || {};
  const sessions = Object.keys(conv)
    .filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  const turns = [];
  for (const key of sessions) {
    const list = conv[key];
    const dateTime = conv[`${key}_date_time`] || '';
    if (!Array.isArray(list)) continue;
    for (const turn of list) {
      const text = String(turn.text || '').trim();
      if (!text) continue;
      turns.push({ diaId: turn.dia_id || null, speaker: turn.speaker || '', text, dateTime });
    }
  }
  return turns;
}

// evidence 形如 "D1:3" —— 归一化成 dia_id 的形态以便比对。
// LoCoMo 的 dia_id 就是 "D1:3" 这种（我们在 flattenTurns 里原样保留）。
function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.map(e => String(e).trim()).filter(Boolean);
}

async function main() {
  const raw = JSON.parse(await readFile(DATA, 'utf8'));
  const samples = raw.slice(0, SAMPLE_LIMIT);
  await mkdir(OUT_DIR, { recursive: true });

  const perCase = [];
  const perCategory = new Map();
  const stats = { samples: 0, turnsTotal: 0, casesTotal: 0, k: K };

  for (let si = 0; si < samples.length; si += 1) {
    const sample = samples[si];
    const turns = flattenTurns(sample);
    const qaList = QA_LIMIT > 0 ? (sample.qa || []).slice(0, QA_LIMIT) : (sample.qa || []);

    const state = createMemoryModuleState();
    const memory = createMemoryModule(state, async () => {});
    // 灌入：dia_id → memoryId 的映射（判定命中用）
    const diaToMemory = new Map();
    for (const turn of turns) {
      const res = await memory.hold(ctx(), {
        content: turn.text,
        memoryType: 'dialogue_turn',
        assertionType: 'observed_fact',
        scopeType: 'relationship',
        relationshipAgentId: AGENT,
        sensitivity: 'S0',
        structuredData: { locomo: { diaId: turn.diaId, speaker: turn.speaker, dateTime: turn.dateTime } },
      });
      const mid = res && res.memory ? res.memory.memoryId : null;
      if (mid && turn.diaId) diaToMemory.set(turn.diaId, mid);
    }
    stats.turnsTotal += turns.length;

    for (let qi = 0; qi < qaList.length; qi += 1) {
      const qa = qaList[qi];
      const evidence = normalizeEvidence(qa.evidence);
      const category = Number(qa.category || 0);
      const expectedIds = evidence.map(d => diaToMemory.get(d)).filter(Boolean);

      let retrievedIds = [];
      let error = null;
      try {
        const r = await memory.retrieveAsync(ctx(), {
          query: String(qa.question || '').trim(),
          purpose: 'answer_user_query',
          limit: K,
        });
        retrievedIds = (r.items || []).map(i => i.memoryId);
      } catch (e) {
        error = { code: e.code, message: e.message };
      }

      // 评测口径：前 K 条里是否命中任一 evidence 轮。
      // 注意——retrieve 忽略 limit（缺陷，另报），故这里**显式截断到 K**，
      // 保证 Recall@K 的分子分母口径一致。
      const topK = retrievedIds.slice(0, K);
      const hit = expectedIds.length > 0 && expectedIds.some(id => topK.includes(id));
      const firstHitRank = (() => {
        for (let i = 0; i < topK.length; i += 1) if (expectedIds.includes(topK[i])) return i + 1;
        return 0;
      })();

      perCase.push({
        id: `locomo-${sample.sample_id ?? si}-${qi}`,
        category,
        question: qa.question,
        evidenceCount: evidence.length,
        expectedFound: expectedIds.length > 0,
        hit,
        firstHitRank,
        retrievedCount: retrievedIds.length,
        error,
      });
      if (!perCategory.has(category)) perCategory.set(category, { total: 0, hit: 0, reciprocalRankSum: 0, rankSum: 0, hitRanked: 0 });
      const bucket = perCategory.get(category);
      bucket.total += 1;
      if (hit) {
        bucket.hit += 1;
        bucket.rankSum += firstHitRank;
        bucket.hitRanked += 1;
        // MRR 的分子是 1/rank（不是 rank 本身）——累加倒数，不是累加名次。
        bucket.reciprocalRankSum += 1 / firstHitRank;
      }
    }
    stats.samples += 1;
    console.log(JSON.stringify({ event: 'locomo2_sample_done', sample: sample.sample_id ?? si, turns: turns.length, cases: qaList.length }));
  }

  const scorable = perCase.filter(c => c.expectedFound);
  const hits = scorable.filter(c => c.hit).length;
  const mrr = scorable.length
    ? scorable.reduce((acc, c) => acc + (c.hit ? 1 / c.firstHitRank : 0), 0) / scorable.length
    : 0;

  const byCategory = {};
  for (const [cat, b] of [...perCategory.entries()].sort((a, b) => a[0] - b[0])) {
    // MRR 按标准定义：对所有 case 求 1/rank 的均值（未命中记 0）。
    // 注意分母是 total 而非 hit 数——否则「只命中 1 条且排第 1」会算出 >1 的假高分。
    byCategory[cat] = {
      total: b.total,
      recallAtK: b.total ? Number((b.hit / b.total).toFixed(4)) : 0,
      mrr: b.total ? Number((b.reciprocalRankSum / b.total).toFixed(4)) : 0,
      avgRankAmongHits: b.hitRanked ? Number((b.rankSum / b.hitRanked).toFixed(2)) : null,
    };
  }

  const summary = {
    methodology: 'evidence-hit retrieval (dia_id match), top-K truncated client-side',
    k: K,
    samples: stats.samples,
    turns: stats.turnsTotal,
    casesTotal: perCase.length,
    scorableCases: scorable.length,
    unscorableCases: perCase.length - scorable.length,
    recallAtK: scorable.length ? Number((hits / scorable.length).toFixed(4)) : 0,
    mrr: Number(mrr.toFixed(4)),
    byCategory,
  };

  await writeFile(path.join(OUT_DIR, 'locomo-eval-summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, 'locomo-eval-percase.json'), JSON.stringify(perCase, null, 2));
  console.log(JSON.stringify({ event: 'locomo2_done', summary }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ event: 'locomo2_failed', code: error.code || 'UNEXPECTED', message: error.message }));
  process.exit(1);
});
