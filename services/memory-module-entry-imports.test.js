import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Regression for the d3a6d81 deletion defect: the standalone service entry
// (services/memory-module/index.js) must not import a module that does not
// exist. The deletion removed server/memory-module-service-worker.js while
// this entry still imported it, so `node services/memory-module/index.js`
// crashed at module-load with ERR_MODULE_NOT_FOUND.
//
// This test only *resolves* the entry's import specifiers -- it never executes
// the entry (which would open a PostgreSQL pool), so it is safe in any sandbox.

const entryUrl = new URL('./memory-module/index.js', import.meta.url);
const entryPath = fileURLToPath(entryUrl);
const require = createRequire(entryUrl);

function resolveSpecifier(specifier) {
  if (specifier.startsWith('.')) {
    // Relative import: resolve to an on-disk module ('.js' or '/index.js').
    const base = resolve(dirname(entryPath), specifier);
    const candidates = [
      base,
      `${base}.js`,
      `${base}.mjs`,
      `${base}/index.js`,
      `${base}/index.mjs`
    ];
    const found = candidates.find(target => {
      try {
        require.resolve(target);
        return true;
      } catch {
        return false;
      }
    });
    if (!found) throw new Error(`Unresolved relative import: ${specifier}`);
    return found;
  }
  // Bare specifier (package): must resolve from node_modules.
  return require.resolve(specifier);
}

const importSpecifierPattern = /(?:import\s|import\(|export\s+\*\s+from\s|export\s+\{[^}]*\}\s+from\s)(?:[\s\S]*?from\s)?['"]([^'"]+)['"]/g;
const dynamicImportPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

test('standalone memory-module service entry imports resolve to existing modules', async () => {
  const source = await readFile(entryPath, 'utf8');
  const specifiers = new Set();
  for (const match of source.matchAll(importSpecifierPattern)) {
    if (match[1]) specifiers.add(match[1]);
  }
  for (const match of source.matchAll(dynamicImportPattern)) {
    specifiers.add(match[1]);
  }
  assert.ok(specifiers.size > 0, 'entry should declare imports');
  const unresolved = [];
  for (const specifier of specifiers) {
    try {
      resolveSpecifier(specifier);
    } catch {
      unresolved.push(specifier);
    }
  }
  assert.deepEqual(unresolved, [], `entry imports a non-existent module: ${unresolved.join(', ')}`);
});

test('createMemoryModuleServiceWorker import target exists (the deleted-then-restored module)', async () => {
  // The specific regression: this module must exist again.
  const resolved = resolveSpecifier('../../server/memory-module-service-worker.js');
  assert.ok(resolved.endsWith('memory-module-service-worker.js'), `unexpected resolution: ${resolved}`);
});
