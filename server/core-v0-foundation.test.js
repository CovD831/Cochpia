import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const targetFixture = JSON.parse(await readFile(resolve(here, '../docs/rearchitecture/core-v0-foundation-slice/fixtures/target-chat-turn.json'), 'utf8'));

test('Core v0 target fixture freezes the four-transition contract', () => {
  assert.equal(targetFixture.path, '/api/chat/turns');
  assert.equal(targetFixture.expected.status, 'committed');
  assert.equal(targetFixture.request.headers['Idempotency-Key'], 'fixture-turn-key-01');
  assert.deepEqual(targetFixture.expected.memoryPortCalls, {
    ensureBinding: 1,
    appendRawEvent: 1,
    retrieveContext: 1
  });
  assert.equal(targetFixture.expected.modelCalls, 1);
});

test('Core v0 target fixture carries stable correlation checkpoints', () => {
  assert.deepEqual(targetFixture.expected.checkpointKeys, [
    'turnId',
    'applicationMessageId',
    'eventId',
    'sourceRevision'
  ]);
  assert.equal(targetFixture.expected.applicationSessionId, targetFixture.request.sessionId);
  assert.match(targetFixture.request.headers['Idempotency-Key'], /^[A-Za-z0-9._:-]+$/);
});

