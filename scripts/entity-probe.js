// R-018 P-1 probe: extended extractor emitting per-candidate entities.
// Measures (plan v2 §7.3):
//   1. extraction hit rate for hand-annotated key entities (>=90%);
//   2. cross-turn norm consistency: the same referent in different messages
//      must normalize to the same entity string (>=90%) - THE gate;
//   3. one-hop reachability: query-named entity intersects the stored
//      message's entities (the re-scoped R-018 target scenario).
import 'dotenv/config';
import { resolveModelConfig } from '../server/model-provider.js';
import { readFileSync } from 'node:fs';

const cfg = resolveModelConfig(process.env.MODEL_PROVIDER || 'deepseek');
if (!cfg.ready) { console.error('provider not ready:', cfg.error); process.exit(2); }
console.log(`provider=${cfg.provider} model=${cfg.model}`);

const generate = async ({ message }) => {
  const response = await fetch(cfg.apiURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: message }], temperature: 0, max_tokens: 2000 }),
    signal: AbortSignal.timeout(60000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 150)}`);
  return payload.choices?.[0]?.message?.content || '';
};

// Same few-shot scaffold as createModelExtractor plus the entities field
// (plan v2: entities use the referent's in-message name, 1-5 items).
const extractWithEntities = async content => {
  const prompt = [
    '从下面的用户消息中提取 0 到 3 条值得长期记住的稳定事实，只输出 JSON。',
    '值得记住：身份、长期偏好、健康与用药、财务与证件、重要关系、关键经历。用户本人的健康/财务/证件信息属于用户自己的记忆，系统有分级治理流程保护，必须正常提取，不要因话题敏感而返回空。',
    '忽略：闲聊、天气、一次性事件、即时情绪、寒暄——这类消息返回 {"candidates":[]}。',
    '每条候选附 key：事实所属主题的简短语义标识，小写下划线（如 allergy_peanut、favorite_fruit、home_city）。同一主题不同说法、不同取值必须用同一个 key。',
    '每条候选附 entities：该事实涉及的具体实体（人、宠物、物品、地点、品牌）。实体名用消息中的原词：既要有具体名字（如 汤圆、旺财），也要有指代它的类别词（如 猫、狗），1 到 5 个，没有则空数组。',
    '格式: {"candidates":[{"content":"事实陈述","key":"主题语义键","entities":["实体1","实体2"],"memoryType":"fact","assertionType":"observed_fact"}]}',
    '示例输入「我对花生过敏」→ {"candidates":[{"content":"用户对花生过敏","key":"allergy_peanut","entities":["花生"],"memoryType":"fact","assertionType":"observed_fact"}]}',
    '示例输入「我爸爸是高中老师」→ {"candidates":[{"content":"用户的爸爸是高中老师","key":"father_occupation","entities":["爸爸"],"memoryType":"fact","assertionType":"observed_fact"}]}',
    '不要输出任何其他文字。',
    `用户消息: ${String(content || '').slice(0, 500)}`
  ].join('\n');
  const raw = await generate({ message: prompt });
  const match = String(raw || '').match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return (Array.isArray(parsed?.candidates) ? parsed.candidates : []).map(c => ({
      content: String(c.content || ''),
      key: c.key || null,
      entities: (Array.isArray(c.entities) ? c.entities : []).map(e => String(e).trim()).filter(Boolean)
    }));
  } catch { return []; }
};

const cases = JSON.parse(readFileSync(new URL('./eval/eval-cases.json', import.meta.url), 'utf8'));

// Hand-annotated key entities per message id (the entity a one-hop query
// must be able to reach). {messageId: [expected entity substrings]}
const EXPECT = {
  'B-S01': ['花生'], 'B-S04': ['React', '前端'], 'B-S13': [], 'B-S14': ['爸爸', '高中老师'],
  'B-S16': [], 'B-S22': ['尘螨', '除螨'], 'B-S26': ['鹦鹉'], 'B-S18': ['科幻'], 'B-S25': ['主持'],
  'C-A01': ['花生'], 'C-A02': ['榴莲', '西瓜'], 'C-A03': ['杭州', '上海'], 'C-A05': ['猫', '汤圆', '麻薯'],
  'C-A06': ['盗梦空间', '星际穿越'], 'C-A07': ['朝阳', '海淀'], 'C-A08': ['大黄', '旺财'],
  'C-A09': ['QQ', 'gmail'], 'C-A10': ['吉他', '尤克里里'], 'C-A13': ['乐刻', '超级猩猩']
};

// Messages to extract (store side).
const messages = [];
const push = (id, text) => messages.push({ id, text });
for (const it of cases.groupB.paraphrase) push(it.id, it.message);
for (const it of cases.groupB.lexical) push(it.id, it.message);
for (const it of cases.groupC.arbitration) { push(`${it.id}-1`, it.first); push(`${it.id}-2`, it.second); }
for (const it of cases.groupA.dedup) { push(`${it.id}-1`, it.first); push(`${it.id}-2`, it.second); }

// 1. Extraction hit rate over annotated ids.
let hitN = 0, hitTotal = 0;
const entityStore = {};
for (const m of messages) {
  const candidates = await extractWithEntities(m.text).catch(() => []);
  entityStore[m.id] = { text: m.text, entities: [...new Set(candidates.flatMap(c => c.entities))] };
  if (!(m.id in EXPECT)) continue;
  hitTotal += 1;
  const expected = EXPECT[m.id];
  const ok = expected.length === 0 || expected.some(e => entityStore[m.id].entities.some(x => x.includes(e) || e.includes(x)));
  if (ok) hitN += 1;
  else console.log(`  MISS ${m.id}: got [${entityStore[m.id].entities.join(', ')}] expected one of [${expected.join(', ')}]`);
}
console.log(`\n[1] extraction hit rate: ${hitN}/${hitTotal}`);

// 2. Cross-turn norm consistency (plan v2 §7.3: SAME referent across
// messages -> same norm). Value-change pairs (榴莲->西瓜) are DIFFERENT
// entities by design and are excluded - the first message is the older
// value; a pair counts as same-referent when the second message re-mentions
// the same fact topic (the extractor's key already links them via R-016).
// A rename pair (大黄->旺财) counts as consistent only if the category word
// (狗/猫) bridges both sides.
let pairOk = 0, pairTotal = 0;
const sameReferentPairs = [];
for (const it of cases.groupC.arbitration) {
  const a = entityStore[`${it.id}-1`]?.entities || [];
  const b = entityStore[`${it.id}-2`]?.entities || [];
  if (!a.length || !b.length) continue;
  // same-referent iff the second side kept a category/owner word from the
  // first side (猫/狗/邮箱/打印机...) - value-only pairs (榴莲->西瓜) excluded.
  const CATEGORY = ['猫', '狗', '邮箱', '打印机', '水果', '电影', '城市', '工作', '健身房', '菜', '指甲油'];
  const categoryB = b.filter(y => CATEGORY.some(c => y.includes(c)));
  const valueChanged = a.some(x => b.some(y => !y.includes(x) && !x.includes(y))) && !categoryB.length;
  if (valueChanged) continue;
  pairTotal += 1;
  sameReferentPairs.push([`${it.id}`, a, b]);
  const shared = a.filter(x => b.some(y => x.includes(y) || y.includes(x)));
  if (shared.length) pairOk += 1;
  else console.log(`  INCONSISTENT ${it.id}: [${a.join(', ')}] vs [${b.join(', ')}]`);
}
for (const it of cases.groupA.dedup) {
  const a = entityStore[`${it.id}-1`]?.entities || [];
  const b = entityStore[`${it.id}-2`]?.entities || [];
  if (!a.length || !b.length) continue;
  pairTotal += 1;
  const shared = a.filter(x => b.some(y => x.includes(y) || y.includes(x)));
  if (shared.length) pairOk += 1;
  else console.log(`  INCONSISTENT ${it.id}: [${a.join(', ')}] vs [${b.join(', ')}]`);
}
console.log(`[2] same-referent norm consistency: ${pairOk}/${pairTotal} (value-change pairs excluded by plan §7.3)`);

// 3. One-hop reachability for entity-naming queries (re-scoped scenario).
// Queries that NAME the entity + the expected target entity.
const HOP = [
  { id: 'B-S26', query: '鹦鹉现在会学舌了吗', target: '鹦鹉', messageId: 'B-S26' },
  { id: 'B-S22', query: '尘螨过敏要注意什么', target: '尘螨', messageId: 'B-S22' },
  { id: 'B-S04', query: 'React 写了五年是什么水平', target: 'React', messageId: 'B-S04' },
  { id: 'C-A08', query: '旺财最近怎么样', target: '旺财', messageId: 'C-A08-2' }
];
const tagQueryEntities = async query => {
  const prompt = [
    '从用户消息中抽出具体实体（人、宠物、物品、地点、品牌、作品），用原词，输出 JSON。',
    '格式: {"entities":["实体1"]}，没有实体输出 {"entities":[]}。不要输出其他文字。',
    `用户消息: ${query}`
  ].join('\n');
  const raw = await generate({ message: prompt });
  const match = String(raw || '').match(/\{[\s\S]*\}/);
  if (!match) return [];
  try { return (JSON.parse(match[0])?.entities || []).map(e => String(e).trim()).filter(Boolean); } catch { return []; }
};
let hopOk = 0;
for (const h of HOP) {
  const queryEntities = await tagQueryEntities(h.query).catch(() => []);
  const stored = entityStore[h.messageId]?.entities || [];
  const bridge = queryEntities.filter(q => stored.some(s => s.includes(q) || q.includes(s)));
  const ok = bridge.length > 0;
  if (ok) hopOk += 1;
  console.log(`  ${h.id} ${ok ? 'hop-ok' : 'HOP-MISS'}  query=[${queryEntities.join(', ')}] stored=[${stored.join(', ')}] bridge=[${bridge.join(', ')}]`);
}
console.log(`[3] one-hop reachability (entity-naming queries): ${hopOk}/${HOP.length}`);

console.log(`
GATE (plan v2 §7.3): norm consistency >=90% required to proceed to
implementation; hit rate >=90%; hop reachability documents the re-scoped
coverage honestly.`);
