import test from 'node:test';
import assert from 'node:assert/strict';
import { createProposalService } from './proposals.js';

test('proposal has no side effect before approval and applies once after approval', async () => {
  const state = { proposals: [] };
  let applied = 0;
  const service = createProposalService(state, { apply: async () => { applied += 1; } });
  const proposal = await service.create({ kind: 'config', target: 'workflow', patch: { enabled: true }, rationale: 'Enable workflow' }, 'user-a');
  assert.equal(applied, 0);
  assert.equal(proposal.status, 'pending');
  await service.approve(proposal.id, 'user-b');
  assert.equal(applied, 0);
  await service.approve(proposal.id, 'user-a');
  assert.equal(applied, 1);
  assert.equal(service.list('user-a')[0].status, 'approved');
  await service.approve(proposal.id, 'user-a');
  assert.equal(applied, 1);
});
