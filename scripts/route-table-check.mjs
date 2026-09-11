// R-020 stage 3 route-table check.
//
// Verifies the real route table of the assembled app, without opening a socket
// (the dev sandbox blocks loopback connections, so curl and fetch both fail
// here even though the app is fine).
//
// Usage: node scripts/route-table-check.mjs
import { app } from '../server/index.js';

const routes = [];
const walk = (stack, prefix) => {
  const p = prefix || '';
  for (const layer of stack || []) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) routes.push(m.toUpperCase() + ' ' + p + layer.route.path);
    } else if (layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, p);
    }
  }
};
const root = app._router || app.router;
walk(root && root.stack, '');
routes.sort();

const chat = routes.filter(r => /\/api\/chat|\/api\/mode/.test(r));
const legacy = routes.filter(r => /\/api\/chat\/(stream|regenerate|retry|cancel)$/.test(r));

console.log('TOTAL_ROUTES=' + routes.length);
console.log('--- CHAT ROUTES ---');
for (const r of chat) console.log('  ' + r);
console.log('--- LEGACY (should be empty) ---');
console.log(legacy.length ? legacy.map(r => '  ' + r).join('\n') : '  (none)');
// R-020 stage 4 gate 4-A2: every /api/... the client calls must exist in the
// real route table. This is the check that catches a deleted endpoint still
// being called -- the failure otherwise shows up only as a 404 in the browser,
// and because the client's startup refresh uses Promise.all, a single 404 can
// blank the whole page (AR-212).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client', 'src', 'main.jsx'), 'utf8');
const clientCalls = new Set();
for (const match of clientSource.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/${}.?:]*)/g)) {
  // Normalise template interpolations and query strings down to the path shape
  // the router matches on.
  const path = match[1].split('?')[0].replace(/\$\{[^}]*\}/g, ':param').replace(/\/$/, '');
  if (path.startsWith('/api/')) clientCalls.add(path);
}

const routeShapes = routes.map(r => r.split(' ')[1]);
const matches = path => routeShapes.some(shape =>
  shape === path ||
  shape.replace(/:[A-Za-z0-9_]+/g, ':param').replace(/\/$/, '') === path
);
const missing = [...clientCalls].filter(path => !matches(path)).sort();

console.log('--- CLIENT CALLS NOT IN ROUTE TABLE (should be empty) ---');
console.log(missing.length ? missing.map(p => '  ' + p).join('\n') : '  (none)');
console.log('--- END ---');

