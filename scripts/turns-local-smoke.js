// Turns local smoke (R-020 stage 1.0).
//
// Core v0 is disabled by default (CORE_V0_ENABLED=false) and the product
// frontend never calls /api/chat/turns, so before this script there was no
// way to run a turn locally without PostgreSQL. Every later stage-1 check
// (the memory-loop assertion, the degrade marker) targets the turns path
// because that is the final shape, so it has to be runnable first.
//
// This script wires the in-process local adapter directly:
//   Memory Module (in-memory state)  +  Mock model gateway  +  Core v0 turn service
//
// Checks:
//   S0  the turn service constructs and the session exists in local state
//   S1  a turn commits and returns committed status with a receipt
//   S2  the assistant message lands in the local message store
//   S3  the raw event is durable in the Memory Module state
//   S4  the same idempotency key replays instead of generating twice
//   S5  a changed payload under the same key is rejected (conflict)
//   S6  a second, different message commits with its own turn id
//
// Usage: node scripts/turns-local-smoke.js
// Writes: artifacts/turns-local-smoke.json
// No PostgreSQL, no network, no model API key required.

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';
import { createCoreV0LocalAdapter } from '../server/core-v0-production.js';
import { ensureCoreV0State } from '../server/core-v0.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'artifacts', 'turns-local-smoke.json');

const tenantId = 'smoke-tenant';
const subjectUserId = 'smoke-user';
const applicationSessionId = 'smoke-session';

const evidence = {
  startedAt: new Date().toISOString(),
  mode: 'local-in-process-mock-model',
  database: null,
  checks: []
};

const record = (id, ok, detail, data = null) => {
  evidence.checks.push({ id, ok: Boolean(ok), detail, data });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

const buildHarness = () => {
  // Local application state: the same shape store.js seeds, minus everything
  // the turns path does not need. The Memory Module owns its own slice.
  const state = {
    sessions: [{
      id: applicationSessionId,
      title: 'smoke',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }],
    messages: { [applicationSessionId]: [] },
    memoryModule: createMemoryModuleState(),
    personality: {
      version: 1,
      traits: [{ key: 'curiosity', label: '好奇心', value: 0.7 }],
      summary: 'smoke summary',
      updatedAt: new Date().toISOString()
    },
    profile: { name: 'smoke', gender: 'none', age: null },
    evidence: []
  };
  ensureCoreV0State(state);

  const memoryModule = createMemoryModule(state.memoryModule, async () => {});
  const context = {
    tenantId,
    subjectUserId,
    actorType: 'agent',
    actorId: 'smoke-agent',
    callerAgentId: 'smoke-agent',
    producer: 'companion-core',
    correlationId: 'turns-local-smoke'
  };
  const adapter = createCoreV0LocalAdapter({ state, context, memoryModule, modelProvider: 'mock' });
  return { state, adapter };
};

const main = async () => {
  const { state, adapter } = buildHarness();

  // S0: construction
  try {
    const ok = Boolean(adapter.service) && Array.isArray(state.sessions) && state.sessions.length === 1;
    record('S0', ok, ok ? 'turn service constructed with a bound session' : 'local adapter did not construct');
    if (!ok) throw new Error('harness did not construct');
  } catch (error) {
    record('S0', false, `construction threw: ${error.message}`);
    return finish();
  }

  const message1 = '我在学尤克里里，今天练了半小时';
  let turn1 = null;

  // S1: the stating turn commits
  try {
    turn1 = await adapter.service.handleTurn({
      body: { sessionId: applicationSessionId, message: message1 },
      headerIdempotencyKey: 'smoke-turn-1'
    });
    const ok = turn1?.status === 'committed' && Boolean(turn1?.turnId) && Boolean(turn1?.assistantMessageId);
    record('S1', ok, ok ? `turn committed (${turn1.turnId})` : `unexpected turn result: ${JSON.stringify(turn1)}`, {
      status: turn1?.status,
      memoryStatus: turn1?.memoryStatus,
      recalledCount: turn1?.recalledCount,
      memoryAnswerability: turn1?.memoryAnswerability
    });
  } catch (error) {
    record('S1', false, `handleTurn threw: ${error.message}`);
    return finish();
  }

  // S2: the assistant message is readable in the local store
  const stored = state.messages[applicationSessionId] || [];
  const assistantRow = stored.find(item => item.id === turn1.assistantMessageId);
  record('S2', Boolean(assistantRow) && Boolean(String(assistantRow?.content || '').trim()),
    assistantRow ? `assistant message stored (${String(assistantRow.content).slice(0, 40)}...)` : 'assistant message missing from local messages',
    { role: assistantRow?.role });

  // S3: the raw event is durable in the Memory Module slice
  const rawEvents = state.memoryModule.rawEvents || [];
  const stated = rawEvents.find(event => String(event.content || '').includes('尤克里里'));
  record('S3', Boolean(stated), stated ? `raw event durable (${stated.id})` : 'raw event not found in Memory Module state',
    { rawEventCount: rawEvents.length, eventRole: stated?.eventRole });

  // S4: idempotent replay must not generate a second assistant message
  try {
    const replay = await adapter.service.handleTurn({
      body: { sessionId: applicationSessionId, message: message1 },
      headerIdempotencyKey: 'smoke-turn-1'
    });
    const messagesAfter = (state.messages[applicationSessionId] || []).length;
    const ok = replay?.status === 'committed'
      && replay?.turnId === turn1.turnId
      && replay?.replay === true
      && messagesAfter === stored.length;
    record('S4', ok, ok ? 'same key replayed without a second write' : `replay mismatch (${JSON.stringify(replay)})`,
      { replayFlag: replay?.replay, messagesAfter, messagesBefore: stored.length });
  } catch (error) {
    record('S4', false, `replay threw: ${error.message}`);
  }

  // S5: the same key with a different payload must be rejected
  try {
    await adapter.service.handleTurn({
      body: { sessionId: applicationSessionId, message: '这句话不一样' },
      headerIdempotencyKey: 'smoke-turn-1'
    });
    record('S5', false, 'conflicting payload under the same key was accepted');
  } catch (error) {
    const ok = error?.code === 'IDEMPOTENCY_KEY_CONFLICT';
    record('S5', ok, ok ? 'conflicting payload rejected' : `unexpected error code: ${error?.code || error?.message}`);
  }

  // S6: a distinct message commits as its own turn
  try {
    const turn2 = await adapter.service.handleTurn({
      body: { sessionId: applicationSessionId, message: '我最近在学什么？' },
      headerIdempotencyKey: 'smoke-turn-2'
    });
    const ok = turn2?.status === 'committed' && turn2?.turnId !== turn1.turnId;
    record('S6', ok, ok ? `second turn committed (${turn2.turnId})` : `unexpected second turn: ${JSON.stringify(turn2)}`, {
      status: turn2?.status,
      memoryStatus: turn2?.memoryStatus,
      recalledCount: turn2?.recalledCount
    });
  } catch (error) {
    record('S6', false, `second turn threw: ${error.message}`);
  }

  return finish();
};

const finish = async () => {
  const passed = evidence.checks.filter(item => item.ok).length;
  const total = evidence.checks.length;
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = { passed, total, ok: passed === total && total > 0 };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`\n${evidence.summary.ok ? 'OK' : 'NOT OK'}  ${passed}/${total} checks passed`);
  console.log(`evidence: ${path.relative(root, outputPath)}`);
  process.exitCode = evidence.summary.ok ? 0 : 1;
};

await main();
