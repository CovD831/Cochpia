import { randomUUID } from 'node:crypto';

const clean = (value, limit) => String(value ?? '').trim().slice(0, limit);

export function createProposalService(state, { apply = async () => {} } = {}) {
  state.proposals ||= [];
  const owned = (id, ownerId) => state.proposals.find(item => item.id === id && item.ownerId === (clean(ownerId, 200) || 'local-user')) || null;
  return {
    async create(input = {}, ownerId = 'local-user') {
      const proposal = {
        id: randomUUID(), ownerId: clean(ownerId, 200) || 'local-user',
        kind: clean(input.kind, 100), target: clean(input.target, 500),
        patch: input.patch && typeof input.patch === 'object' ? structuredClone(input.patch) : null,
        rationale: clean(input.rationale, 4000), status: 'pending',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      if (!proposal.kind || !proposal.target || !proposal.rationale) throw Object.assign(new Error('Proposal kind, target and rationale are required'), { code: 'PROPOSAL_INVALID' });
      state.proposals.push(proposal);
      return proposal;
    },
    async approve(id, ownerId = 'local-user') {
      const proposal = owned(id, ownerId);
      if (!proposal) return null;
      if (proposal.status !== 'pending') return proposal;
      await apply(structuredClone(proposal.patch), proposal);
      proposal.status = 'approved'; proposal.appliedAt = new Date().toISOString(); proposal.updatedAt = proposal.appliedAt;
      return proposal;
    },
    reject(id, ownerId = 'local-user') {
      const proposal = owned(id, ownerId);
      if (!proposal) return null;
      if (proposal.status === 'pending') { proposal.status = 'rejected'; proposal.updatedAt = new Date().toISOString(); }
      return proposal;
    },
    list(ownerId = 'local-user') { return state.proposals.filter(item => item.ownerId === (clean(ownerId, 200) || 'local-user')).map(item => structuredClone(item)); }
  };
}
