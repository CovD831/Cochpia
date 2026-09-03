const MAX_CONTEXT_MESSAGES = 20;

export function buildRuntimeContext({ messages = [], recalled = [], memoryBundle = null, summary = '', persona = '', upcomingEvents = [], profile = null, mode = 'companion', companionIntent = 'listen', dynamicRouting = null, groupContext = null, innerState = null } = {}) {
  return {
    messages: messages.filter(message => !message.supersededAt).slice(-MAX_CONTEXT_MESSAGES).map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    })),
    recalled: recalled.map(memory => ({
      id: memory.id,
      type: memory.type,
      summary: memory.summary,
      confidence: memory.confidence,
      source: memory.source
    })),
    memoryBundle: memoryBundle || null,
    summary: String(summary || ''),
    persona: String(persona || ''),
    upcomingEvents: (upcomingEvents || []).map(event => ({
      type: event.type,
      title: event.title,
      date: event.date,
      note: event.note
    })),
    profile: profile ? { name: profile.name, gender: profile.gender, age: profile.age } : null,
    mode: String(mode || 'companion'),
    companionIntent: String(companionIntent || 'listen'),
    groupContext: groupContext ? {
      name: String(groupContext.name || '').slice(0, 80),
      description: String(groupContext.description || '').slice(0, 300),
      currentAgent: String(groupContext.currentAgent || '').slice(0, 80),
      members: Array.isArray(groupContext.members) ? groupContext.members.map(member => String(member).slice(0, 80)).filter(Boolean).slice(0, 20) : []
    } : null,
    innerState: innerState ? {
      agentId: String(innerState.agentId || ''),
      version: Number(innerState.version || 1),
      anchorAt: innerState.anchorAt || null,
      updatedAt: innerState.updatedAt || null,
      items: Array.isArray(innerState.items) ? innerState.items.map(item => ({
        id: String(item.id || ''),
        kind: String(item.kind || ''),
        level: Number(item.level || 0),
        direction: String(item.direction || 'uncertain'),
        freshness: Number(item.freshness == null ? 0 : item.freshness)
      })) : []
    } : null,
    dynamicRouting: dynamicRouting ? {
      decision: String(dynamicRouting.decision || ''),
      isAnchor: Boolean(dynamicRouting.isAnchor),
      alphaWork: Number(dynamicRouting.alphaWork || 0),
      alphaLove: Number(dynamicRouting.alphaLove || 0),
      placement: String(dynamicRouting.placement || '')
    } : null
  };
}

export function findRegenerationTarget(messages = [], messageId) {
  const index = messages.findIndex(message => message.id === messageId);
  if (index === -1 || messages[index].role !== 'assistant') return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'user') return { assistant: messages[index], user: messages[cursor], index };
  }
  return null;
}
