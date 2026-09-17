// 实验：词干归一化（stemming）能否修复多跳/单跳召回？
//
// 诊断链（2026-09-17）：
//   1. LoCoMo 多跳 0.443 短板 → 定位到「What did Caroline research?」这类 case 失败；
//   2. 探针复现：问句含 "research"，标注轮内容是 "Researching adoption agencies"，
//      BM25 完全匹配不上 —— 因为 tokenizer 不做词干归一化；
//   3. tokenizer（memory-module-retrieval.js:3）只做 lowercase + 正则切分。
//
// 本实验**不改产品代码**：在评测侧对文档与 query 做同一种轻量词干化，
// 对照「不归一化 vs 归一化」的召回差。若有效，再决定是否改进产品 tokenizer。
//
// 词干化策略（保守，只做后缀，避免过度归并）：
//   -ies → -y (studies → study)
//   -ing → 去尾 (researching → research；若结果 <3 字符则保留原词)
//   -ed  → 去尾 (researched → research)
//   -es  → 去尾 (agencies → agencie ← 不好；所以先处理 -ies)
//   -s   → 去尾 (agencies 已由 -ies 处理；dreams → dream)
// 刻意**不做**完整 Porter stemmer —— 那会引入更多边缘情况，先验证方向。

import { readFile } from 'node:fs/promises';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';
import { tokenize } from '../server/memory-module-retrieval.js';

// 本脚本的语义是「tokenize 出裸词，再由本文件的 stemToken 做一次词干化」。
// 产品 tokenizer 现已内置词干化（开关 MEMORY_TOKENIZER_STEM，**默认关**）——
// 若将来有人把默认值改成「开」，本脚本的 tokenize 会先归一化一次，
// 再 map(stemToken) 就是**双重词干化**（如 houses → hous → hou），结论会静默变味。
// 这里显式钉住开关，保持本脚本「评测侧复刻」的原始语义不变。
process.env.MEMORY_TOKENIZER_STEM = '0';

const DATA = process.env.LOCOMO_PATH || 'eval-data/locomo10.json';
const SAMPLE_LIMIT = Number(process.env.LOCOMO_SAMPLE_LIMIT || 3);
const QA_LIMIT = Number(process.env.LOCOMO_QA_LIMIT || 120);
const K = Number(process.env.LOCOMO_K || 10);

// 轻量词干化——产品 tokenize 的**同一份**输出再过一遍，保证与文档侧一致。
export function stemToken(token) {
  if (!token || token.length < 4) return token;
  if (/[^a-z]/.test(token)) return token; // 只处理纯英文 token，CJK 与数字不动
  let t = token;
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (t.endsWith('ing') && t.length > 5) t = t.slice(0, -3);
  else if (t.endsWith('ed') && t.length > 4) t = t.slice(0, -2);
  else if (t.endsWith('es') && t.length > 4) t = t.slice(0, -2);
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) t = t.slice(0, -1);
  return t;
}

// 本地实现的 BM25（与产品同算法、同参数），唯一差别是 token 先过 stemToken。
function bm25Stemmed(documents, query, { k1 = 1.2, b = 0.75, limit = 50, noStem = false } = {}) {
  const tokenizeStemmed = text => (noStem ? tokenize(text) : tokenize(text).map(stemToken));
  const queryTokens = tokenizeStemmed(query);
  if (!queryTokens.length || !documents.length) return [];
  const prepared = documents.map(d => ({ ...d, tokens: tokenizeStemmed(d.text) }));
  const df = new Map();
  for (const d of prepared) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = prepared.reduce((s, d) => s + d.tokens.length, 0) / prepared.length || 1;
  const qf = new Map();
  for (const t of queryTokens) qf.set(t, (qf.get(t) || 0) + 1);
  return prepared.map(d => {
    const f = new Map();
    for (const t of d.tokens) f.set(t, (f.get(t) || 0) + 1);
    let score = 0;
    for (const [t, qc] of qf) {
      const fr = f.get(t) || 0;
      if (!fr) continue;
      const idf = Math.log(1 + (prepared.length - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      const norm = 1 - b + b * d.tokens.length / avgLen;
      score += idf * ((fr * (k1 + 1)) / (fr + k1 * norm)) * (1 + Math.log1p(qc));
    }
    return { ...d, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, limit);
}

const ctx = () => ({
  tenantId: 'st', subjectUserId: 'st-user',
  actorType: 'agent', actorId: 'st-agent', callerAgentId: 'st-agent',
});

function flattenTurns(sample) {
  const conv = sample.conversation || {};
  const sessions = Object.keys(conv).filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => +a.split('_')[1] - +b.split('_')[1]);
  const turns = [];
  for (const key of sessions) {
    const list = conv[key];
    if (!Array.isArray(list)) continue;
    for (const turn of list) {
      const text = String(turn.text || '').trim();
      if (text) turns.push({ diaId: turn.dia_id || null, speaker: turn.speaker || '', text });
    }
  }
  return turns;
}

async function runSample(sample, mode) {
  const turns = flattenTurns(sample);
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  const diaToMem = new Map();
  const docs = [];
  for (const turn of turns) {
    const res = await memory.hold(ctx(), {
      content: turn.text, memoryType: 'dialogue_turn', assertionType: 'observed_fact',
      scopeType: 'relationship', relationshipAgentId: 'st-agent', sensitivity: 'S0',
      structuredData: { locomo: { diaId: turn.diaId, speaker: turn.speaker } },
    });
    const mid = res?.memory?.memoryId;
    if (mid) {
      if (turn.diaId) diaToMem.set(turn.diaId, mid);
      docs.push({ id: mid, text: turn.text });
    }
  }
  const qaList = QA_LIMIT > 0 ? (sample.qa || []).slice(0, QA_LIMIT) : (sample.qa || []);
  const rows = [];
  for (const qa of qaList) {
    const query = String(qa.question || '').trim();
    const expected = (qa.evidence || []).map(e => diaToMem.get(String(e).trim())).filter(Boolean);
    if (!expected.length) continue; // 与评测口径一致：无标注的 case 不计分
    let topK;
    if (mode === 'stemmed') {
      topK = bm25Stemmed(docs, query, { limit: K }).map(d => d.id);
    } else if (mode === 'bm25_plain') {
      // 对照必须同一条路径——否则「纯BM25+词干」比「产品hybrid」，
      // 变量不止一个（实测过：这样比会得出词干化变差的错误结论）。
      topK = bm25Stemmed(docs, query, { limit: K, noStem: true }).map(d => d.id);
    } else {
      const r = await memory.retrieveAsync(ctx(), { query, purpose: 'answer_user_query', limit: K });
      topK = (r.items || []).slice(0, K).map(i => i.memoryId);
    }
    const rank = topK.findIndex(id => expected.includes(id)) + 1;
    rows.push({ category: Number(qa.category || 0), hit: rank > 0, rank: rank > 0 ? rank : 0 });
  }
  return rows;
}

async function main() {
  const raw = JSON.parse(await readFile(DATA, 'utf8'));
  const samples = raw.slice(0, SAMPLE_LIMIT);
  const out = {};
  for (const mode of ['product_hybrid', 'bm25_plain', 'stemmed']) {
    let total = 0; let hits = 0; let rankSum = 0;
    const byCat = new Map();
    for (const sample of samples) {
      for (const row of await runSample(sample, mode)) {
        total += 1;
        if (row.hit) { hits += 1; rankSum += 1 / row.rank; }
        if (!byCat.has(row.category)) byCat.set(row.category, { t: 0, h: 0 });
        const b = byCat.get(row.category); b.t += 1; if (row.hit) b.h += 1;
      }
    }
    out[mode] = {
      cases: total,
      recallAtK: Number((hits / total).toFixed(4)),
      mrr: Number((rankSum / total).toFixed(4)),
      byCategory: Object.fromEntries([...byCat.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, Number((v.h / v.t).toFixed(4))])),
    };
    console.log(JSON.stringify({ event: 'stem_ab', variant: mode, ...out[mode] }));
  }
  // 只报「同路径」的 delta：stemmed vs bm25_plain。
  // 不要拿 stemmed 比 product_hybrid —— 那混淆了两个变量（词干 + hybrid）。
  const delta = {
    vs_plain_bm25: {
      recallAtK: Number((out.stemmed.recallAtK - out.bm25_plain.recallAtK).toFixed(4)),
      mrr: Number((out.stemmed.mrr - out.bm25_plain.mrr).toFixed(4)),
    },
    reference_product_hybrid_minus_plain: {
      recallAtK: Number((out.product_hybrid.recallAtK - out.bm25_plain.recallAtK).toFixed(4)),
      mrr: Number((out.product_hybrid.mrr - out.bm25_plain.mrr).toFixed(4)),
    },
  };
  console.log(JSON.stringify({ event: 'stem_ab_summary', k: K, samples: SAMPLE_LIMIT, result: out, delta }, null, 2));
}

main().catch(e => { console.error(JSON.stringify({ event: 'stem_ab_failed', message: e.message, code: e.code })); process.exit(1); });
