import test from 'node:test';
import assert from 'node:assert/strict';

const apiBase = process.env.COCHPIA_TEST_API || 'http://localhost:8787';
const userAToken = process.env.TEST_USER_A_TOKEN;
const userBToken = process.env.TEST_USER_B_TOKEN;
const canRun = Boolean(userAToken && userBToken && process.env.AUTH_MODE === 'required' && process.env.STORAGE_PROVIDER === 'postgres');

async function request(path, token, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test('two-user isolation acceptance', { skip: !canRun && 'requires a running PostgreSQL API and TEST_USER_A_TOKEN/TEST_USER_B_TOKEN' }, async () => {
  const created = await request('/api/sessions', userAToken, {
    method: 'POST',
    body: JSON.stringify({ title: `isolation-${Date.now()}` })
  });
  assert.equal(created.response.status, 201);
  const sessionId = created.body.id;

  const userAList = await request('/api/sessions', userAToken);
  assert.equal(userAList.response.status, 200);
  assert.ok(userAList.body.some(session => session.id === sessionId));

  const userBSession = await request(`/api/sessions/${sessionId}/messages`, userBToken);
  assert.ok([403, 404].includes(userBSession.response.status));

  // R-020 stage 4 removed the `/api/memories` probe that used to sit here.
  //
  // Two reasons, and the first is the honest one: the assertion was vacuous.
  // This test creates a session but never sends a chat turn, so no memory
  // sourced from that session (`chat:<sessionId>`) can exist for *anyone* --
  // asserting user B cannot see it passed without testing anything.
  //
  // Second, the endpoint it called no longer exists: /api/memories was the
  // original author's public governance surface, and stage 4 deleted it (the
  // UI never called it, and it bypassed the Collector/admission boundary that
  // the target architecture wants as the single write path).
  //
  // Memory-scope isolation is covered where it can actually be exercised --
  // at the module level, with real contexts: memory-module.test.js drives
  // userContext()/agentContext() across two users, and agent-scope-2a.test.js
  // pins the read-scope narrowing. Re-pointing this probe at
  // /api/memory/overview would not restore coverage: that route is a
  // budget-capped retrieval view (1200 tokens, 8 items), so the same negative
  // assertion would stay vacuous in a different place.

  const userBPersonality = await request('/api/personality', userBToken);
  assert.equal(userBPersonality.response.status, 200);
  assert.notEqual(userBPersonality.body.evidenceCount, undefined);

  const deletedByB = await request(`/api/sessions/${sessionId}`, userBToken, { method: 'DELETE' });
  assert.ok([403, 404].includes(deletedByB.response.status));

  const userAStillOwns = await request(`/api/sessions/${sessionId}/messages`, userAToken);
  assert.equal(userAStillOwns.response.status, 200);
});
