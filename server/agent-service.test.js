import test from 'node:test';
import assert from 'node:assert/strict';
import { agentAvatar, createAgentService, resolveMessageAvatar } from './agent-service.js';

test('agent service creates, updates, and removes agents', async () => {
  const state = {};
  const service = createAgentService(state, async () => {});
  const agent = await service.create({ name: 'Aria', persona: '温柔', role: '向导', tone: '克制、温和', memoryNotes: '喜欢记录共同经历', provider: 'deepseek', model: 'deepseek-chat', avatar: '✦' });
  assert.equal(agent.name, 'Aria');
  assert.equal(agentAvatar({ ...agent, avatarImage: 'data:image/png;base64,redacted' }), '✦');
  assert.equal(agentAvatar({ ...agent, avatar: '', avatarImage: '' }), 'Aria');
  assert.equal(agent.role, '向导');
  assert.equal(agent.tone, '克制、温和');
  assert.equal(agent.memoryNotes, '喜欢记录共同经历');
  assert.equal(service.list().length, 1);
  const updated = await service.update(agent.id, { relationship: '挚友', role: '挚友', tone: '轻松', memoryNotes: '记住共同旅行' });
  assert.equal(updated.relationship, '挚友');
  assert.equal(updated.role, '挚友');
  assert.equal(updated.tone, '轻松');
  assert.equal(await service.remove(agent.id), true);
  assert.equal(service.list().length, 0);
});

test('agent service rejects empty names', () => {
  const service = createAgentService({}, async () => {});
  assert.throws(() => service.create({ name: '' }), /name/);
});

test('message avatars follow the current agent and discard stale images', () => {
  const agent = { id: 'a-1', name: 'New name', avatar: 'N', avatarImage: '' };
  const old = { id: 'm-1', role: 'assistant', senderId: agent.id, senderAvatar: 'data:image/png;base64,old', senderAvatarImage: 'data:image/png;base64,old' };
  assert.deepEqual(resolveMessageAvatar(old, agent), { id: old.id, role: old.role, senderId: old.senderId, senderAvatar: 'N' });
  assert.equal(resolveMessageAvatar(old, { ...agent, avatarImage: 'data:image/png;base64,new' }).senderAvatarImage, 'data:image/png;base64,new');
  assert.equal(resolveMessageAvatar({ ...old, senderId: 'deleted' }, null).senderAvatar, '?');
  assert.equal(resolveMessageAvatar({ ...old, senderId: 'deleted' }, null).senderAvatarImage, undefined);
});
