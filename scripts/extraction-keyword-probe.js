// Extraction probe: for each arbitration pair's SECOND message, dump the
// candidates the real extractor produces and check whether the eval's
// targetKeyword survives the extraction phrasing.
import 'dotenv/config';
import { resolveModelConfig } from '../server/model-provider.js';
import { createModelExtractor } from '../server/memory-extraction.js';
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

const extract = createModelExtractor({ generate });
const cases = JSON.parse(readFileSync(new URL('./eval/eval-cases.json', import.meta.url), 'utf8'));
let ok = 0;
for (const item of cases.groupC.arbitration) {
  const candidates = await extract({ id: item.id, content: item.second }).catch(e => [{ content: `ERR ${e.message.slice(0, 50)}`, key: '-' }]);
  const hit = candidates.some(c => String(c.content).includes(item.targetKeyword));
  if (hit) ok += 1;
  console.log(`${item.id} ${hit ? 'kw-ok' : 'KW-MISS'}  key=${candidates.map(c => c.key).join(',')}  "${candidates.map(c => c.content.slice(0, 30)).join(' | ')}"  (target="${item.targetKeyword}")`);
}
console.log(`\nkeyword survives extraction: ${ok}/${cases.groupC.arbitration.length}`);
