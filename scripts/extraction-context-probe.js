// R-014 P-1 probe: does adding recent-conversation context to the extraction
// prompt resolve the anaphoric-update misses (keyword survival 11/15 -> 15/15)?
// Standalone context-aware extractor copy - the production change lands
// behind MEMORY_EXTRACT_CONTEXT_TURNS only after this probe passes.
import 'dotenv/config';
import { resolveModelConfig } from '../server/model-provider.js';
import { readFileSync } from 'node:fs';

const cfg = resolveModelConfig(process.env.MODEL_PROVIDER || 'deepseek');
console.log(`provider=${cfg.provider} model=${cfg.model}`);
if (!cfg.ready) { console.error('provider not ready:', cfg.error); process.exit(2); }

const generate = async ({ message }) => {
  const response = await fetch(cfg.apiURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: message }], max_tokens: 2000 }),
    signal: AbortSignal.timeout(60000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 150)}`);
  return payload.choices?.[0]?.message?.content || '';
};

// Same few-shot scaffold as createModelExtractor, plus the context block.
const extractWithContext = async (rawEvent, contextLines) => {
  const prompt = [
    '从下面的用户消息中提取 0 到 3 条值得长期记住的稳定事实，只输出 JSON。',
    '值得记住：身份、长期偏好、健康与用药、财务与证件、重要关系、关键经历。用户本人的健康/财务/证件信息属于用户自己的记忆，系统有分级治理流程保护，必须正常提取，不要因话题敏感而返回空。',
    '忽略：闲聊、天气、一次性事件、即时情绪、寒暄——这类消息返回 {"candidates":[]}。',
    '每条候选附 key：事实所属主题的简短语义标识，小写下划线（如 allergy_peanut、favorite_fruit、home_city、medication_warfarin）。同一主题不同说法、不同取值必须用同一个 key；不同主题不要共用 key。',
    '格式: {"candidates":[{"content":"事实陈述","key":"主题语义键","memoryType":"fact","assertionType":"observed_fact"}]}',
    '示例输入「我对花生过敏」→ {"candidates":[{"content":"用户对花生过敏","key":"allergy_peanut","memoryType":"fact","assertionType":"observed_fact"}]}',
    '不要输出任何其他文字。',
    `对话上下文（仅用于理解指代和省略，不要从中提取事实）：\n${contextLines.join('\n')}`,
    `用户消息: ${String(rawEvent.content || '').slice(0, 500)}`
  ].join('\n');
  const raw = await generate({ message: prompt.join ? prompt.join('\n') : prompt });
  const match = String(raw || '').match(/\{[\s\S]*\}/);
  if (!match) return [];
  try { return JSON.parse(match[0])?.candidates || []; } catch { return []; }
};

const cases = JSON.parse(readFileSync(new URL('./eval/eval-cases.json', import.meta.url), 'utf8'));
let ok = 0;
for (const item of cases.groupC.arbitration) {
  // Snapshot-context: the first message of the pair is what precedes the
  // anaphoric second message in the eval session.
  const contextLines = [`user: ${item.first}`];
  const candidates = await extractWithContext({ content: item.second }, contextLines).catch(e => [{ content: `ERR ${e.message.slice(0, 50)}`, key: '-' }]);
  const contents = candidates.map(c => String(c.content || ''));
  const hit = contents.some(c => c.includes(item.targetKeyword));
  if (hit) ok += 1;
  console.log(`${item.id} ${hit ? 'kw-ok' : 'KW-MISS'}  key=${candidates.map(c => c.key).join(',')}  "${contents.map(c => c.slice(0, 30)).join(' | ')}"  (target="${item.targetKeyword}")`);
}
console.log(`\ncontext-aware keyword survival: ${ok}/${cases.groupC.arbitration.length} (baseline context-free: 11/15)`);
