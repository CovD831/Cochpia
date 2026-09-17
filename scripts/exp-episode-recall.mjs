// 实验：episodes（时间窗口分组）能否改善多跳/长对话召回？
//
// 背景（2026-09-17 诊断）：LoCoMo 多跳短板 0.443，根因是单轮对话太短 +
// BM25 词频被高频闲聊轮（What/Cool/Wow）主导，真正相关的轮不进前 10。
//
// 本实验**不改产品代码**，只在评测侧构造 episodes 并加入候选集，测「加大检索单元」
// 是否能提升召回。若有效，再决定是否把 episodes 真正接进 retrieve 召回路径。
//
// 做法：用 rebuildEpisodes 的同一套分组规则（30 分钟时间窗口）在评测数据上重建
// episodes，把 episode 当作额外的检索文档加入，与 assertion 一起参与 BM25/RRF。

import { readFile } from 'node:fs/promises';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';
import { bm25Search } from '../server/memory-module-retrieval.js';

const DATA = process.env.LOCOMO_PATH || 'eval-data/locomo10.json';
const SAMPLE_LIMIT = Number(process.env.LOCOMO_SAMPLE_LIMIT || 3);
const QA_LIMIT = Number(process.env.LOCOMO_QA_LIMIT || 120);
const K = Number(process.env.LOCOMO_K || 10);
const WINDOW_MS = Number(process.env.EPISODE_WINDOW_MS || 30 * 60 * 1000);

const ctx = () => ({
  tenantId: 'ep', subjectUserId: 'ep-user',
  actorType: 'agent', actorId: 'ep-agent', callerAgentId: 'ep-agent',
});

function flattenTurns(sample) {
  const conv = sample.conversation || {};
  const sessions = Object.keys(conv).filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => +a.split('_')[1] - +b.split('_')[1]);
  const turns = [];
  for (const key of sessions) {
    const dateTime = conv[`${key}_date_time`] || '';
    const parsed = Date.parse(dateTime);
    const base = Number.isFinite(parsed) ? parsed : null;
    const list = conv[key];
    if (!Array.isArray(list)) continue;
    let idx = 0;
    for (const turn of list) {
      const text = String(turn.text || '').trim();
      idx += 1;
      if (!text) continue;
      turns.push({
        diaId: turn.dia_id || null,
        speaker: turn.speaker || '',
        text,
        // 时间戳：会话起始 + 轮次偏移（每轮 1 分钟）。LoCoMo 只在会话级给时间，
        // 这里做**确定性**的近似——同一会话内的轮次保持先后顺序，跨会话按日期分开。
        occurredAt: base !== null ? new Date(base + idx * 60_000).toISOString() : new Date(idx * 60_000).toISOString(),
        sessionKey: key,
      });
    }
  }
  return turns;
}

// 按 rebuildEpisodes 的同一规则分组（时间窗口 windowMs）。
function groupEpisodes(turns) {
  const sorted = [...turns].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const groups = [];
  for (const turn of sorted) {
    const prev = groups.at(-1);
    if (!prev || Date.parse(turn.occurredAt) - Date.parse(prev.at(-1).occurredAt) > WINDOW_MS) groups.push([turn]);
    else prev.push(turn);
  }
  return groups.map(members => ({
    id: `ep-${members[0].diaId}`,
    // 与生产实现一致：title = 首条前 80 字，summary = 前 3 条拼接
    title: String(members[0].text).slice(0, 80),
    summary: members.slice(0, 3).map(t => String(t.text).slice(0, 240)).join('；'),
    memberDiaIds: members.map(t => t.diaId).filter(Boolean),
    size: members.length,
  }));
}

async function runSample(sample, useEpisodes) {
  const turns = flattenTurns(sample);
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  const diaToMemory = new Map();
  for (const turn of turns) {
    const res = await memory.hold(ctx(), {
      content: turn.text, memoryType: 'dialogue_turn', assertionType: 'observed_fact',
      scopeType: 'relationship', relationshipAgentId: 'ep-agent', sensitivity: 'S0',
      structuredData: { locomo: { diaId: turn.diaId, speaker: turn.speaker, dateTime: '' } },
    });
    const mid = res?.memory?.memoryId;
    if (mid && turn.diaId) diaToMemory.set(turn.diaId, mid);
  }

  const episodes = useEpisodes ? groupEpisodes(turns) : [];
  // episode 文档（title + summary），用于 BM25
  const episodeDocs = episodes.map(ep => ({ id: ep.id, text: `${ep.title} ${ep.summary}`, ep }));

  const qaList = QA_LIMIT > 0 ? (sample.qa || []).slice(0, QA_LIMIT) : (sample.qa || []);
  const rows = [];
  for (const qa of qaList) {
    const query = String(qa.question || '').trim();
    const expectedDia = (qa.evidence || []).map(e => String(e).trim()).filter(Boolean);
    const expectedMem = expectedDia.map(d => diaToMemory.get(d)).filter(Boolean);

    const r = await memory.retrieveAsync(ctx(), { query, purpose: 'answer_user_query', limit: K });
    let topKMem = (r.items || []).slice(0, K).map(i => i.memoryId);

    if (useEpisodes && episodeDocs.length) {
      // 修正版（v2）：episode 只作为**加分信号**，不整体前置。
      // v1 的失败教训：一个 episode 平均含 ~22 轮，若命中就把整组前置，
      // 10 个名额被一组占满 → recall 从 0.55 掉到 0.225。
      // 现在：命中 episode 的成员获得一个「组内位置权重」——组内越靠前权重越高，
      // 但整体仍与原有 BM25 分数竞争，不无条件抢占名额。
      const epHits = bm25Search(episodeDocs, query.toLowerCase(), { limit: 3 });
      const promoteScore = new Map();
      for (const hit of epHits) {
        const members = hit.ep.memberDiaIds;
        members.forEach((dia, i) => {
          const mid = diaToMemory.get(dia);
          if (!mid) return;
          // 组内位置衰减：第 0 位 1.0，线性降到 ~0.3；再乘 episode 自身的 BM25 分
          const positionWeight = 1 - (i / Math.max(1, members.length)) * 0.7;
          const score = (hit.score || 1) * positionWeight;
          promoteScore.set(mid, Math.max(promoteScore.get(mid) || 0, score));
        });
      }
      // 与原结果做加权融合：原有结果按名次给基础分，episode 加分参与竞争
      const base = topKMem.map((mid, i) => ({ mid, score: 1 / (i + 1) }));
      const seen = new Set(base.map(b => b.mid));
      for (const [mid, score] of promoteScore.entries()) {
        if (!seen.has(mid)) base.push({ mid, score: score * 0.5 }); // 新条目以半权重进入
      }
      for (const b of base) {
        if (promoteScore.has(b.mid)) b.score += promoteScore.get(b.mid);
      }
      base.sort((a, b) => b.score - a.score);
      topKMem = base.slice(0, K).map(b => b.mid);
    }

    const rank = topKMem.findIndex(id => expectedMem.includes(id)) + 1;
    rows.push({ category: Number(qa.category || 0), hit: rank > 0, rank: rank > 0 ? rank : 0 });
  }
  return rows;
}

async function main() {
  const raw = JSON.parse(await readFile(DATA, 'utf8'));
  const samples = raw.slice(0, SAMPLE_LIMIT);

  const out = {};
  for (const useEpisodes of [false, true]) {
    let total = 0; let hits = 0; let rankSum = 0;
    const byCat = new Map();
    for (const sample of samples) {
      const rows = await runSample(sample, useEpisodes);
      for (const row of rows) {
        total += 1;
        if (row.hit) { hits += 1; rankSum += 1 / row.rank; }
        if (!byCat.has(row.category)) byCat.set(row.category, { t: 0, h: 0 });
        const b = byCat.get(row.category); b.t += 1; if (row.hit) b.h += 1;
      }
    }
    const label = useEpisodes ? 'with_episodes' : 'baseline';
    out[label] = {
      cases: total,
      recallAtK: Number((hits / total).toFixed(4)),
      mrr: Number((rankSum / total).toFixed(4)),
      byCategory: Object.fromEntries([...byCat.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, Number((v.h / v.t).toFixed(4))])),
    };
    console.log(JSON.stringify({ event: 'episode_ab', variant: label, ...out[label] }));
  }
  console.log(JSON.stringify({ event: 'episode_ab_summary', k: K, windowMs: WINDOW_MS, result: out }, null, 2));
}

main().catch(e => { console.error(JSON.stringify({ event: 'episode_ab_failed', message: e.message, code: e.code })); process.exit(1); });
