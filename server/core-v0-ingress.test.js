import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const targetFixture = JSON.parse(await readFile(resolve(here, '../docs/rearchitecture/core-v0-foundation-slice/fixtures/target-chat-turn.json'), 'utf8'));

test('target chat request does not carry server-owned identity fields', () => {
  const forbidden = [
    'tenantId',
    'userId',
    'agentId',
    'relationshipId',
    'memorySessionId',
    'eventId',
    'sourceRevision'
  ];
  for (const field of forbidden) assert.equal(field in targetFixture.request, false, field);
});

test('target chat request has an explicit idempotency boundary', () => {
  assert.ok(targetFixture.request.headers);
  assert.ok(targetFixture.request.headers['Idempotency-Key']);
  assert.notEqual(targetFixture.path, '/v1/events');
});

