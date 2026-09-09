import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteCache = path.join(projectRoot, 'node_modules', '.vite');

try {
  await rm(viteCache, { recursive: true, force: true });
  console.log(JSON.stringify({ event: 'vite_cache_cleaned', path: 'node_modules/.vite' }));
} catch (error) {
  console.error(JSON.stringify({ event: 'vite_cache_clean_failed', message: error.message }));
  process.exitCode = 1;
}
