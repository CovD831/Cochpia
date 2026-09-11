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
console.log('--- END ---');
