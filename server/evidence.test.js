import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceLedger } from './evidence.js';

test('evidence ledger records hashed evidence and scopes list by task', () => {
  const ledger = createEvidenceLedger({ evidence: [] });
  const first = ledger.record({ taskId: 'task-a', stageId: 'plan', source: 'agent_output', content: 'plan output' });
  ledger.record({ taskId: 'task-b', source: 'verification', content: 'test output' });
  assert.equal(first.hash.length, 16);
  assert.equal(ledger.list('task-a').length, 1);
  assert.equal(ledger.list('task-a')[0].hash, first.hash);
});
