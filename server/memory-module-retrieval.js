const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

// 词干归一化开关（lane B 提出，2026-09-17；默认值经老板裁决改为「关」）。
//
// **为什么默认关**：词干化的检索收益经双口径三态对照后**判定为不显著**
//   —— 多跳效应在 342 口径（n=74）与全样本口径（n=282）分别为 p=1.0000 / p=0.2272，
//   均无法与噪声区分（详见 team-runs/20260917-1646-p0-defects-route-stem/ADJUDICATION.md）。
//   故**不合入默认行为**；机制代码入库是为了保留已验证的实现与它的词法测试，
//   并让「重开此议题」有一个现成的、可开开关的实验入口。
//
// 本函数只回答「当前是否启用」这一个问题，不承载判据。启用方式：
//   MEMORY_TOKENIZER_STEM=1（或 true/on/yes）——其余任何值（含不设）都是关。
// 刻意每次调用读 env 而不是模块加载时缓存：允许同进程内对照，且切换无需改代码。
export const STEMMING_ENV_VAR = 'MEMORY_TOKENIZER_STEM';

export function stemmingEnabled() {
  const raw = process.env[STEMMING_ENV_VAR];
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  return ['1', 'true', 'on', 'yes'].includes(String(raw).trim().toLowerCase());
}

// 保守后缀词干化——只处理最有把握的复数/进行/过去形态，**不做完整 Porter**。
//   诊断（recall-experiments-20260917.json）：tokenizer 无词干归一化，导致
//   查询 "research" 与标注轮 "Researching" 在 token 层面永不相等 → 多跳漏召回。
//   规则与评测侧已验证过的实现（scripts/exp-stemming-recall.mjs:stemToken）逐条一致。
// 保护：长度 < 4 直接返回；只处理纯 a-z（CJK / 数字 / 含下划线的标识符不动）。
export function stemToken(token) {
  if (!token || token.length < 4) return token;
  if (/[^a-z]/.test(token)) return token;
  let t = token;
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (t.endsWith('ing') && t.length > 5) t = t.slice(0, -3);
  else if (t.endsWith('ed') && t.length > 4) t = t.slice(0, -2);
  // P0 (2026-09-17): -es 只在「必须靠 -es 才是复数」的词尾上砍 2 ——
  // 依据：houses→house（不是 hous）、notes→note（不是 not）。
  // 旧规则对一切以 es 结尾的长词一律砍 2，产出 hous/not/tim/dat/statu/analysi/cas：
  // 既让同一词族裂开（house/houses 归不到一起），又造成虚假归并（notes→not 撞真词 not）。
  // 条件化后其余 -es 词走下面的 -s 规则只砍 1。
  // 词尾集合必须是 ss/x/z/ch/sh（不是 s）—— 单写 `ses` 会把 houses→hous、cases→cas，
  // 与「houses→house」的目标自相矛盾；`-ses` 里 se+s 与 s+es 本来就不可判别，
  // 按语料频次取「-se 结尾名词」这一支（house/case），代价是 buses→buse（见 honest_notes）。
  else if (t.endsWith('es') && t.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) t = t.slice(0, -1);
  return t;
}

export function tokenize(value) {
  const normalized = String(value || '').toLowerCase().replace(/[-/]/g, '_');
  const tokens = normalized.match(/[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) || [];
  const result = [];
  for (const token of tokens) {
    if (cjkPattern.test(token) && token.length > 1) {
      const chars = [...token];
      result.push(...chars);
      for (let index = 0; index < chars.length - 1; index += 1) result.push(chars.slice(index, index + 2).join(''));
    } else result.push(token);
  }
  // 词干化在切分/二元组展开**之后**做：CJK 二元组与含下划线的标识符会被
  // stemToken 的保护条件原样放行，所以顺序不影响它们，只影响纯英文单词。
  return stemmingEnabled() ? result.map(stemToken) : result;
}

export function bm25Search(documents, query, { k1 = 1.2, b = 0.75, limit = 50, floorRatio = 0 } = {}) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !documents.length) return [];
  const prepared = documents.map(document => ({ ...document, tokens: tokenize(document.text) }));
  const documentFrequency = new Map();
  for (const document of prepared) for (const token of new Set(document.tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  const averageLength = prepared.reduce((sum, document) => sum + document.tokens.length, 0) / prepared.length || 1;
  const queryFrequency = new Map();
  for (const token of queryTokens) queryFrequency.set(token, (queryFrequency.get(token) || 0) + 1);
  const ranked = prepared.map(document => {
    const frequencies = new Map();
    for (const token of document.tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    let score = 0;
    for (const [token, queryCount] of queryFrequency) {
      const frequency = frequencies.get(token) || 0;
      if (!frequency) continue;
      const df = documentFrequency.get(token) || 0;
      const idf = Math.log(1 + (prepared.length - df + 0.5) / (df + 0.5));
      const normalizedLength = 1 - b + b * document.tokens.length / averageLength;
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * normalizedLength)) * (1 + Math.log1p(queryCount));
    }
    return { ...document, score };
  }).filter(document => document.score > 0).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  // R-012c lexical relative floor: at depth the lexical channel fills the
  // fused ranking with long-tail bigram coincidences (phase3b: a noise query
  // pulled ~37 filler memories). Scores are unbounded, so the floor is
  // RELATIVE to the top hit - long-tail matches below floorRatio of the best
  // are dropped before fusion.
  const topScore = ranked.length ? ranked[0].score : 0;
  const kept = topScore > 0 && floorRatio > 0 ? ranked.filter(document => document.score >= topScore * floorRatio) : ranked;
  return kept.slice(0, limit);
}

export function reciprocalRankFusion(rankedLists, { k = 60, limit = 50 } = {}) {
  const scores = new Map();
  const documents = new Map();
  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const id = item.id;
      documents.set(id, item);
      scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ ...documents.get(id), score }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export async function vectorSearch(documents, query, embed, { limit = 50, timeoutMs = 150, minScore = 0 } = {}) {
  if (typeof embed !== 'function' || !documents.length) return { mode: 'disabled', items: [] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const queryVector = await embed(query, { signal: controller.signal, purpose: 'memory_retrieval' });
    const items = [];
    for (const document of documents) {
      if (!Array.isArray(document.embedding)) continue;
      items.push({ ...document, score: cosineSimilarity(queryVector, document.embedding) });
    }
    // R-011 precision floor: unrelated-pair cosines still score 0.3-0.55 with
    // bge-m3, so a positive score alone is not evidence of relevance. Hits
    // below minScore are eliminated outright (Mem0-aligned) instead of
    // reaching the fused ranking.
    return { mode: 'vector', items: items.filter(item => item.score >= minScore).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, limit) };
  } catch (error) {
    return { mode: error?.name === 'AbortError' ? 'embedding_timeout' : 'embedding_error', items: [], errorCode: error?.code || 'EMBEDDING_UNAVAILABLE' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function hybridSearch(documents, query, { embed = null, limit = 50, timeoutMs = 150, minScore = 0, floorRatio = 0, suppressLexicalFallback = false } = {}) {
  const lexical = bm25Search(documents, query, { limit, floorRatio });
  const vector = await vectorSearch(documents, query, embed, { limit, timeoutMs, minScore });
  // R-015: when the embedding channel ran healthy and found NOTHING above
  // minScore, the lexical fallback is an uncorroborated bigram coincidence -
  // suppress it instead of surfacing high-scored junk for unrelated queries.
  // Disabled/timeout/error modes keep the lexical fallback (graceful
  // degradation beats going blind).
  if (suppressLexicalFallback && vector.mode === 'vector' && !vector.items.length) {
    return { mode: 'lexical_suppressed', items: [] };
  }
  const fused = vector.items.length ? reciprocalRankFusion([lexical, vector.items], { limit }) : lexical;
  return { mode: vector.items.length ? 'hybrid_rrf' : `bm25_${vector.mode}`, items: fused };
}

export function detectConflicts(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.canonicalKey) continue;
    const values = groups.get(item.canonicalKey) || new Map();
    const value = item.content || JSON.stringify(item.structuredData || {});
    values.set(value, (values.get(value) || 0) + 1);
    groups.set(item.canonicalKey, values);
  }
  return [...groups.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([canonicalKey, values]) => ({ canonicalKey, values: [...values.keys()] }));
}
