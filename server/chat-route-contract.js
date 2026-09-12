// Single source of truth for the companion chat route surface (R-020 stage 3).
//
// Why this file exists: the route literals used to be hand-copied into three
// places -- server/stage3-cleanup.test.js (the canonical one), the A-12 case in
// scripts/core-v0-chat-turns-acceptance.js, and the P-09 case in
// scripts/core-v0-postgres-acceptance.js. When stage 3 deleted the legacy
// companion surface, the test was updated and the two script copies were not,
// so both gate cases rotted into guaranteed failures and nobody noticed,
// because the gate scripts are not part of `npm test`.
//
// Nothing here should ever be re-typed elsewhere. Import it.

// Retired by stage 3: these must NOT be registered anywhere in server/index.js.
// (Same set the canonical C-2 case in stage3-cleanup.test.js has always pinned.)
export const RETIRED_COMPANION_ROUTES = [
  "app.post('/api/chat/stream'",
  "app.post('/api/chat/regenerate'",
  "app.post('/api/chat/retry'",
  "app.post('/api/chat/cancel'",
  "app.get('/api/chat/stream/:runId'"
];

// The replacement surface: both business lines and their reconnect/cancel legs.
export const REQUIRED_CHAT_ROUTES = [
  "app.post('/api/chat/turns'",
  "app.post('/api/chat/work'",
  "app.post('/api/chat/work/cancel'",
  "app.get('/api/chat/work/:runId'",
  "app.get('/api/chat/turns/:runId'",
  "app.delete('/api/chat/turns/:runId'"
];

// Surfaces that must survive because they are still live features, not part of
// the retired companion stream.
export const SURVIVING_CHAT_ROUTES = [
  "app.post('/api/chat/approve'"
];

/**
 * Compare a server entrypoint source against the contract.
 * Returns plain data so each caller can assert in its own style (node:assert in
 * tests, a local check() in the acceptance scripts).
 */
export function routeSurfaceViolations(source) {
  const text = String(source || '');
  return {
    missing: REQUIRED_CHAT_ROUTES.filter(route => !text.includes(route)),
    resurrected: RETIRED_COMPANION_ROUTES.filter(route => text.includes(route)),
    lostSurvivors: SURVIVING_CHAT_ROUTES.filter(route => !text.includes(route))
  };
}

export function formatRouteViolations(violations) {
  const parts = [];
  if (violations.missing.length) parts.push(`missing: ${violations.missing.join(' | ')}`);
  if (violations.resurrected.length) parts.push(`must be gone but present: ${violations.resurrected.join(' | ')}`);
  if (violations.lostSurvivors.length) parts.push(`surviving route lost: ${violations.lostSurvivors.join(' | ')}`);
  return parts.join('; ');
}
