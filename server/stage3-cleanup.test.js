// R-020 stage 3 acceptance: single chat path, work mode preserved.
//
// Stage 3 removed the legacy companion chat stream and moved companion chat to
// /api/chat/turns. Work mode (Pi RPC + local tools + approval) was going to be
// deleted with it, which contradicted the module disposition that keeps
// pi-client.js and tools.js as complete functionality. The resolution was to
// give work mode its own route. These tests pin both halves:
//
//   M-*  mode-switch detection is shared, and the two sides cannot disagree
//   W-*  a companion-mode message cannot be served by the work route
//   C-*  the legacy companion endpoints are gone from the repository
//   P-*  the surviving routes still exist

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { detectModeSwitch, isWorkRouteMessage, MODE_SWITCH_SAMPLES } from './mode-switch.js';

const serverSource = () => readFile(new URL('./index.js', import.meta.url), 'utf8');

// --- M: mode switching ----------------------------------------------------

test('M-1: every declared work sample is detected as a work switch', () => {
  for (const text of MODE_SWITCH_SAMPLES.work) {
    assert.equal(detectModeSwitch(text), 'work', `expected a work switch for ${JSON.stringify(text)}`);
  }
});

test('M-2: every declared companion sample is detected as a companion switch', () => {
  for (const text of MODE_SWITCH_SAMPLES.companion) {
    assert.equal(detectModeSwitch(text), 'companion', `expected a companion switch for ${JSON.stringify(text)}`);
  }
});

test('M-3: ordinary chat is not mistaken for a mode switch', () => {
  for (const text of MODE_SWITCH_SAMPLES.neither) {
    assert.equal(detectModeSwitch(text), null, `expected no switch for ${JSON.stringify(text)}`);
  }
});

test('M-4: the detector tolerates missing or odd input', () => {
  assert.equal(detectModeSwitch(undefined), null);
  assert.equal(detectModeSwitch(null), null);
  assert.equal(detectModeSwitch(0), null);
  assert.equal(detectModeSwitch('  '), null);
});

test('M-5: routing sends a switch command to the work route even in companion mode', () => {
  // This is the case that would silently break the switch: the session is still
  // in companion mode when the user asks to switch, so a mode-only check would
  // route the command to the companion path, where nothing handles it.
  assert.equal(isWorkRouteMessage({ mode: 'companion', text: '切换到工作模式' }), true);
  assert.equal(isWorkRouteMessage({ mode: 'companion', text: '切换到陪伴模式' }), true);
  assert.equal(isWorkRouteMessage({ mode: 'companion', text: '今天天气不错' }), false);
});

test('M-6: routing sends every message to the work route once the session is in work mode', () => {
  assert.equal(isWorkRouteMessage({ mode: 'work', text: '帮我重构这个文件' }), true);
  assert.equal(isWorkRouteMessage({ mode: 'work', text: '好的' }), true);
});

// --- C: the legacy companion path is gone ---------------------------------

test('C-1: the legacy chat stream handler no longer exists', async () => {
  const source = await serverSource();
  // The name may only appear in the comment that documents the removed
  // function, never as a declaration or a call.
  const declarations = source.split('\n').filter(line => /handleChatStream/.test(line) && !/^\s*\/\//.test(line));
  assert.deepEqual(declarations, [], `handleChatStream must be fully removed, found: ${declarations.join(' | ')}`);
});

test('C-2: the legacy companion endpoints are not registered', async () => {
  const source = await serverSource();
  for (const route of [
    "app.post('/api/chat/stream'",
    "app.post('/api/chat/regenerate'",
    "app.post('/api/chat/retry'",
    "app.post('/api/chat/cancel'",
    "app.get('/api/chat/stream/:runId'"
  ]) {
    assert.equal(source.includes(route), false, `${route} must be gone`);
  }
});

test('C-3: the returning endpoints exist', async () => {
  const source = await serverSource();
  for (const route of [
    "app.post('/api/chat/turns'",
    "app.post('/api/chat/work'",
    "app.post('/api/chat/work/cancel'",
    "app.get('/api/chat/work/:runId'",
    "app.get('/api/chat/turns/:runId'",
    "app.delete('/api/chat/turns/:runId'"
  ]) {
    assert.ok(source.includes(route), `${route} must be registered`);
  }
});

test('C-4: work mode keeps its engine and approval flow', async () => {
  const source = await serverSource();
  assert.ok(source.includes("app.post('/api/chat/approve'"), 'the tool approval route must survive');
  assert.ok(source.includes('runPiWorkMode'), 'the Pi engine branch must survive');
  assert.ok(source.includes('waitForApproval'), 'the approval wait must survive');
});

test('C-5: the work route refuses companion traffic instead of reviving a second chat path', async () => {
  const source = await serverSource();
  assert.ok(
    source.includes('USE_TURNS_FOR_COMPANION'),
    'the work route must reject companion-mode messages rather than answer them'
  );
  // And the guard must precede the work-mode branch, so a companion-mode
  // message can never fall through into the tool loop.
  const guardIndex = source.indexOf('USE_TURNS_FOR_COMPANION');
  const workBranchIndex = source.indexOf('工作模式：优先 Pi RPC');
  assert.ok(guardIndex > 0 && workBranchIndex > guardIndex, 'the guard must come before the work execution branch');
});

test('C-6: the client and server share one mode-switch detector', async () => {
  const client = await readFile(new URL('../client/src/main.jsx', import.meta.url), 'utf8');
  assert.ok(
    client.includes("from '../../server/mode-switch.js'"),
    'the client must import the shared detector, not redefine the pattern'
  );
  // No second copy of the Chinese pattern in the client.
  assert.equal(
    /工作模式\/|切换\)\.\{0,4\}工作模式/.test(client),
    false,
    'the client must not carry its own copy of the mode-switch regex'
  );
});

test('C-7: in-session summarisation is reachable from the turn service', async () => {
  const production = await readFile(new URL('./core-v0-production.js', import.meta.url), 'utf8');
  assert.ok(production.includes('createTurnCompaction'), 'the turn service must receive the compaction hook');
  const core = await readFile(new URL('./core-v0.js', import.meta.url), 'utf8');
  assert.ok(core.includes('compact'), 'the turn service must accept a compaction hook');
  const index = await serverSource();
  assert.equal(
    index.includes('maybeCompactConversation'),
    false,
    'index.js must no longer own summarisation; the turn does'
  );
});

test('C-8: the client offers a stop control wired to the cancel endpoints', async () => {
  // Cancellation was reachable at the protocol level but had no UI, which made
  // gate item 3-A11#3 untestable by a user. This pins the control in place so
  // it cannot silently disappear again.
  const client = await readFile(new URL('../client/src/main.jsx', import.meta.url), 'utf8');
  assert.ok(client.includes('stop-button'), 'the composer must render a stop control while streaming');
  assert.ok(client.includes('cancelGeneration'), 'the stop control must have a handler');
  assert.ok(
    client.includes('/api/chat/turns/${encodeURIComponent(run.runId)}'),
    'companion cancellation must call DELETE /api/chat/turns/:runId'
  );
  assert.ok(client.includes('/api/chat/work/cancel'), 'work-mode cancellation must call its own route');
  assert.ok(client.includes('method: \'DELETE\''), 'the companion cancel must be a DELETE');
  // The stop must be a deliberate act, not an accidental repeat of send.
  const styles = await readFile(new URL('../client/src/styles.css', import.meta.url), 'utf8');
  assert.ok(/\.stop-button\s*\{/.test(styles), 'the stop control must be visually distinct from send');
});

test('C-9: a disabled Core v0 reports why, rather than a generic failure', async () => {
  // With turns as the only companion path, a missing CORE_V0_ENABLED is the
  // most likely misconfiguration. It must say so.
  const index = await serverSource();
  const turnsRoute = index.slice(index.indexOf("app.post('/api/chat/turns'"));
  const guardIndex = turnsRoute.indexOf('coreV0Enabled()');
  const streamIndex = turnsRoute.indexOf('turnStream.wantsStream(req)');
  assert.ok(guardIndex > 0, 'the turns route must check whether Core v0 is enabled');
  assert.ok(
    guardIndex < streamIndex,
    'the enabled check must come first, so a disabled backend is reported clearly instead of degrading into a generic 500'
  );
  assert.ok(turnsRoute.includes('set CORE_V0_ENABLED=true'), 'the error must be actionable');
});
