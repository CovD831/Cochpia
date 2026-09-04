import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = resolve(repoRoot, 'docs/rearchitecture/core-v0-foundation-slice');
const manifest = JSON.parse(await readFile(resolve(packageDir, '.rearchitecture-package.json'), 'utf8'));
const report = JSON.parse(await readFile(resolve(packageDir, 'review-report.json'), 'utf8'));

const current = String(manifest.current_revision || '');
const input = String(report.input_revision || '');
if (!current || current !== input) {
  console.error(JSON.stringify({ ok: false, code: 'CORE_V0_PROVENANCE_MISMATCH', currentRevision: current || null, reviewInputRevision: input || null }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, frozenRevision: current }));
