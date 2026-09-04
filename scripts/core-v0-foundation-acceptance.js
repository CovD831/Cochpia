import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const fixtureDir = resolve(repoRoot, 'docs/rearchitecture/core-v0-foundation-slice/fixtures');

const loadJson = async name => JSON.parse(await readFile(resolve(fixtureDir, name), 'utf8'));
const results = [];
const record = (id, status, detail) => results.push({ id, status, detail });

const legacy = await loadJson('legacy-chat-turn.json');
const target = await loadJson('target-chat-turn.json');

if (legacy.scenario !== target.scenario) record('P-01', 'fail', 'legacy and target fixtures describe different scenarios');
else record('P-01', 'passed', 'legacy and target fixtures share one scenario');

if (target.path !== '/api/chat/turns' || !target.request.headers?.['Idempotency-Key']) {
  record('P-02', 'fail', 'target fixture lacks the target route or Idempotency-Key');
} else {
  record('P-02', 'passed', 'target route and idempotency header are present');
}

const adapterSpecifier = process.env.CORE_V0_ACCEPTANCE_MODULE;
const runtimeRowIds = ['A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'A-07', 'A-08', 'A-09', 'A-10', 'A-11', 'A-12'];
if (!adapterSpecifier) {
  for (const id of runtimeRowIds) {
    record(id, 'pending', 'target runtime adapter is not supplied; preflight is not runtime evidence');
  }
} else {
  try {
    const moduleUrl = adapterSpecifier.startsWith('file:') ? adapterSpecifier : pathToFileURL(resolve(repoRoot, adapterSpecifier)).href;
    const adapter = await import(moduleUrl);
    if (typeof adapter.runCoreV0Acceptance !== 'function') {
      record('A-00', 'fail', 'CORE_V0_ACCEPTANCE_MODULE does not export runCoreV0Acceptance');
    } else {
      const runtimeResults = await adapter.runCoreV0Acceptance({ legacy, target });
      if (!Array.isArray(runtimeResults)) {
        record('A-00', 'fail', 'acceptance adapter must return an array of A-01..A-12 results');
      } else {
        const seen = new Set();
        const allowedStatuses = new Set(['passed', 'fail', 'pending']);
        for (const result of runtimeResults) {
          const id = result && String(result.id || '');
          if (!runtimeRowIds.includes(id)) {
            record('A-00', 'fail', `acceptance adapter returned unknown row ${id || '<missing>'}`);
            continue;
          }
          if (seen.has(id)) {
            record('A-00', 'fail', `acceptance adapter returned duplicate row ${id}`);
            continue;
          }
          seen.add(id);
          if (!allowedStatuses.has(result.status)) {
            record('A-00', 'fail', `acceptance adapter returned invalid status for ${id}`);
            continue;
          }
          record(id, result.status, String(result.detail || ''));
        }
        for (const id of runtimeRowIds) {
          if (!seen.has(id)) record(id, 'fail', `acceptance adapter omitted required row ${id}`);
        }
      }
    }
  } catch (error) {
    record('A-00', 'fail', `acceptance adapter failed to load or run: ${error.code || error.name || 'ERROR'}`);
  }
}

const outputDir = await mkdtemp(resolve(os.tmpdir(), 'cochpia-core-v0-'));
const outputPath = resolve(outputDir, 'acceptance.json');
await writeFile(outputPath, JSON.stringify({
  package: 'R-002-core-v0-foundation-slice',
  fixtureNames: [basename(resolve(fixtureDir, 'legacy-chat-turn.json')), basename(resolve(fixtureDir, 'target-chat-turn.json'))],
  results
}, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({ outputPath, results }));

if (results.some(item => item.status === 'fail')) process.exitCode = 1;
else if (results.some(item => item.status === 'pending')) process.exitCode = 2;
