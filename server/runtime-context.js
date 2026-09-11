const MAX_CONTEXT_MESSAGES = 20;

// C-12 (R-020 2a): the runtime context is assembled from independently
// degradable sections rather than one all-or-nothing object literal.
//
// The external shape is deliberately unchanged -- the flat fields below are
// still what every consumer reads -- so this can land without touching call
// sites. What changes is that a section which throws now costs only itself:
// it renders empty and is named in `degraded`, instead of taking the whole
// context (and therefore the whole turn) down with it, or worse, being
// swallowed silently.
//
// `lifeTexture` is registered but unimplemented on purpose; R-021 fills it in.
// Its presence here is what makes that a one-line change later.

export const RUNTIME_CONTEXT_SECTIONS = Object.freeze([
  { key: 'memory', budget: 1800, required: false },
  { key: 'personality', budget: 200, required: false },
  { key: 'agentPersona', budget: 400, required: false },
  { key: 'profile', budget: 150, required: false },
  { key: 'history', budget: 900, required: false },
  { key: 'lifeTexture', budget: 300, required: false }
]);

const clampText = (value, max) => String(value ?? '').slice(0, max);

const buildSections = ({ messages, personality, recalled, memoryBundle, summary, persona, agentPersona, upcomingEvents, atmosphere, profile, lifeTexture }) => ({
  memory: () => ({
    recalled: (recalled || []).map(memory => ({
      id: memory.id,
      type: memory.type,
      summary: memory.summary,
      confidence: memory.confidence,
      source: memory.source
    })),
    memoryBundle: memoryBundle || null
  }),
  personality: () => (personality ? {
    version: personality.version,
    summary: personality.summary,
    traits: (personality.traits || []).map(trait => ({ key: trait.key, label: trait.label, value: trait.value }))
  } : null),
  // 2a sources this from session.persona; 2b switches the source to the agent
  // record and retires session.persona.
  agentPersona: () => (agentPersona ? { ...agentPersona } : null),
  profile: () => (profile ? { name: profile.name, gender: profile.gender, age: profile.age } : null),
  history: () => ({
    messages: (messages || [])
      .filter(message => !message.supersededAt)
      .slice(-MAX_CONTEXT_MESSAGES)
      .map(message => ({ id: message.id, role: message.role, content: message.content, createdAt: message.createdAt })),
    summary: clampText(summary, 4000),
    persona: clampText(persona, 2000),
    atmosphere: clampText(atmosphere, 500),
    upcomingEvents: (upcomingEvents || []).map(event => ({
      type: event.type,
      title: event.title,
      date: event.date,
      note: event.note
    }))
  }),
  lifeTexture: () => (lifeTexture ? { ...lifeTexture } : null)
});

export function buildRuntimeContext({
  messages = [],
  personality = null,
  recalled = [],
  memoryBundle = null,
  summary = '',
  persona = '',
  agentPersona = null,
  upcomingEvents = [],
  atmosphere = '',
  profile = null,
  mode = 'companion',
  companionIntent = 'listen',
  lifeTexture = null
} = {}) {
  const sections = buildSections({ messages, personality, recalled, memoryBundle, summary, persona, agentPersona, upcomingEvents, atmosphere, profile, lifeTexture });
  const values = {};
  const degraded = [];
  for (const definition of RUNTIME_CONTEXT_SECTIONS) {
    const produce = sections[definition.key];
    if (typeof produce !== 'function') continue;
    try {
      values[definition.key] = produce();
    } catch (error) {
      // A non-required section degrades alone; it must never take the context
      // with it, and it must never disappear without a trace (I-17).
      if (definition.required) throw error;
      values[definition.key] = null;
      degraded.push({ key: definition.key, code: error?.code || 'SECTION_FAILED' });
    }
  }

  const history = values.history || {};
  const memory = values.memory || {};
  // agentPersona falls back to the session persona so 2a keeps today's
  // behaviour while 2b changes the source.
  const resolvedPersona = values.agentPersona
    || (history.persona ? { source: 'session', persona: history.persona } : null);

  return {
    messages: history.messages || [],
    personality: values.personality || null,
    recalled: memory.recalled || [],
    memoryBundle: memory.memoryBundle || null,
    summary: history.summary || '',
    persona: history.persona || '',
    agentPersona: resolvedPersona,
    atmosphere: history.atmosphere || '',
    upcomingEvents: history.upcomingEvents || [],
    profile: values.profile || null,
    lifeTexture: values.lifeTexture || null,
    mode: String(mode || 'companion'),
    companionIntent: String(companionIntent || 'listen'),
    degraded
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