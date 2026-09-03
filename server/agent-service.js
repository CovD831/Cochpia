import { randomUUID } from 'node:crypto';

export function agentAvatar(agent) {
  return String(agent?.avatar || agent?.remark || agent?.name || '?').slice(0, 8);
}

export function resolveMessageAvatar(message, agent) {
  if (!message || message.role !== 'assistant') return message;
  const next = { ...message };
  if (agent) {
    next.senderAvatar = agentAvatar(agent);
    if (agent.avatarImage) next.senderAvatarImage = agent.avatarImage;
    else delete next.senderAvatarImage;
  } else {
    // A deleted agent must not leave its historical image in the chat response.
    delete next.senderAvatarImage;
    if (typeof next.senderAvatar === 'string' && next.senderAvatar.startsWith('data:image/')) {
      next.senderAvatar = '?';
    }
  }
  return next;
}

// AI Agent:可自定义人格、模型的好友/群成员。
export function createAgentService(state, persist) {
  state.agents ||= [];
  const find = id => state.agents.find(agent => agent.id === id) || null;

  return {
    list() { return state.agents.slice(); },
    get(id) { return find(id); },
    create(input = {}) {
      const name = String(input.name || '').trim().slice(0, 40);
      if (!name) throw new Error('Agent name is required');
      const now = new Date().toISOString();
      const agent = {
        id: randomUUID(),
        name,
        persona: String(input.persona || '').trim().slice(0, 2000),
        provider: String(input.provider || '').trim().slice(0, 60),
        model: String(input.model || '').trim().slice(0, 120),
        avatar: String(input.avatar || '✦').slice(0, 8),
        avatarImage: String(input.avatarImage || '').slice(0, 300000),
        remark: String(input.remark || '').trim().slice(0, 40),
        relationship: String(input.relationship || '朋友').slice(0, 40),
        role: String(input.role || input.relationship || '朋友').trim().slice(0, 80),
        tone: String(input.tone || '自然、温和').trim().slice(0, 120),
        signature: String(input.signature || '').trim().slice(0, 200),
        memoryNotes: String(input.memoryNotes || '').trim().slice(0, 3000),
        pinned: Boolean(input.pinned),
        primary: Boolean(input.primary),
        muted: Boolean(input.muted),
        tags: Array.isArray(input.tags) ? input.tags.map(tag => String(tag).trim().slice(0, 30)).filter(Boolean).slice(0, 10) : [],
        createdAt: now,
        updatedAt: now
      };
      state.agents.push(agent);
      return persist().then(() => agent);
    },
    update(id, input = {}) {
      const agent = find(id);
      if (!agent) return null;
      if (input.name !== undefined) {
        const name = String(input.name).trim().slice(0, 40);
        if (!name) throw new Error('Agent name is required');
        agent.name = name;
      }
      if (input.persona !== undefined) agent.persona = String(input.persona).trim().slice(0, 2000);
      if (input.provider !== undefined) agent.provider = String(input.provider).trim().slice(0, 60);
      if (input.model !== undefined) agent.model = String(input.model).trim().slice(0, 120);
      if (input.avatar !== undefined) agent.avatar = String(input.avatar).slice(0, 8);
      if (input.avatarImage !== undefined) agent.avatarImage = String(input.avatarImage).slice(0, 300000);
      if (input.remark !== undefined) agent.remark = String(input.remark).trim().slice(0, 40);
      if (input.relationship !== undefined) agent.relationship = String(input.relationship).trim().slice(0, 40);
      if (input.role !== undefined) agent.role = String(input.role).trim().slice(0, 80);
      if (input.tone !== undefined) agent.tone = String(input.tone).trim().slice(0, 120);
      if (input.signature !== undefined) agent.signature = String(input.signature).trim().slice(0, 200);
      if (input.memoryNotes !== undefined) agent.memoryNotes = String(input.memoryNotes).trim().slice(0, 3000);
      if (input.pinned !== undefined) agent.pinned = Boolean(input.pinned);
      if (input.primary !== undefined) agent.primary = Boolean(input.primary);
      if (input.muted !== undefined) agent.muted = Boolean(input.muted);
      if (input.tags !== undefined) agent.tags = Array.isArray(input.tags) ? input.tags.map(tag => String(tag).trim().slice(0, 30)).filter(Boolean).slice(0, 10) : [];
      agent.updatedAt = new Date().toISOString();
      return persist().then(() => agent);
    },
    remove(id) {
      const index = state.agents.findIndex(agent => agent.id === id);
      if (index === -1) return false;
      state.agents.splice(index, 1);
      return persist().then(() => true);
    }
  };
}
