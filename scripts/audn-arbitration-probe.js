// R-012c arbitration probe: does the AUDN auditor correctly choose UPDATE
// for value changes (vs NOOP-as-restatement) on the ACTIVE model provider?
// Runs the real createModelAuditor against the real provider config (.env),
// mirroring what the pipeline does at write time. 15 arbitration pairs from
// eval-cases.json + 3 restatement controls.
import 'dotenv/config';
import { resolveModelConfig, MODEL_PRESETS } from '../server/model-provider.js';
import { createModelAuditor } from '../server/memory-extraction.js';
import { readFileSync } from 'node:fs';

const cfg = resolveModelConfig(process.env.MODEL_PROVIDER || 'deepseek');
console.log(`provider=${cfg.provider} model=${cfg.model} apiURL=${cfg.apiURL}`);
if (!cfg.ready) { console.error('provider not ready:', cfg.error); process.exit(2); }

// Minimal OpenAI-compatible generate() matching the production client shape.
const generate = async ({ message }) => {
  const response = await fetch(cfg.apiURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: message }], max_tokens: 2000 }),
    signal: AbortSignal.timeout(60000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 200)}`);
  return payload.choices?.[0]?.message?.content || '';
};

const audit = createModelAuditor({ generate });
const cases = JSON.parse(readFileSync(new URL('./eval/eval-cases.json', import.meta.url), 'utf8'));

// Value-change pairs must be UPDATE (not NOOP/ADD); restatements must be NOOP.
const valueChanges = cases.groupC.arbitration.map(item => ({
  id: item.id,
  existing: item.first,
  candidate: item.second
}));
const restatements = cases.groupA.dedup.slice(0, 3).map(item => ({
  id: `${item.id}-restatement`,
  existing: item.first,
  candidate: item.second
}));

let updateOk = 0, noopOk = 0;
// Eval-realistic: the pipeline's similar lookup returns several near misses
// alongside the true target. Test with distractors to expose context
// sensitivity the single-target probe hides.
const distractors = [
  '我最爱吃的菜是红烧肉。', '我每天喝三杯水。', '我的健身卡在乐刻。',
  '我周末宁愿自己待着。', '我爸爸是高中老师。'
];
for (const c of valueChanges) {
  const similar = [...distractors.map(d => ({ content: d })), { content: c.existing }];
  const decision = await audit({ content: c.candidate }, similar).catch(e => ({ decision: `ERR:${e.message.slice(0, 60)}` }));
  const ok = decision.decision === 'UPDATE';
  if (ok) updateOk += 1;
  console.log(`${c.id.padEnd(6)} ${decision.decision.padEnd(8)} target=${String(decision.target)} ${ok ? 'ok' : 'BAD'}  (${c.existing.slice(0, 12)} => ${c.candidate.slice(0, 16)})`);
}
for (const c of restatements) {
  const decision = await audit({ content: c.candidate }, [{ content: c.existing }]).catch(e => ({ decision: `ERR:${e.message.slice(0, 60)}` }));
  const ok = decision.decision === 'NOOP';
  if (ok) noopOk += 1;
  console.log(`${c.id.padEnd(10)} ${decision.decision.padEnd(8)} ${ok ? 'ok' : 'BAD'}  (${c.existing.slice(0, 14)} => ${c.candidate.slice(0, 18)})`);
}
console.log(`\nvalue-change UPDATE: ${updateOk}/${valueChanges.length}   restatement NOOP: ${noopOk}/${restatements.length}`);
