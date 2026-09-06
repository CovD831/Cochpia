import { randomUUID } from 'node:crypto';
import { buildRuntimeContext } from './runtime-context.js';
import { memoryBundleToRecalled } from './chat-memory.js';
import { isSecretMemoryContent } from './memory-module.js';
import { createModelProvider } from './model-provider.js';

export const CORE_V0_SCHEMA_VERSION = 1;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_CHANNEL_LENGTH = 60;
const MAX_CONTEXT_MESSAGES = 20;
const MAX_RECALLED_ITEMS = 20;
const MAX_CONTEXT_MESSAGE_LENGTH = 4000;
const MAX_RECALLED_ITEM_LENGTH = 2000;
const MAX_SESSION_SUMMARY_LENGTH = 4000;
const MAX_SESSION_PERSONA_LENGTH = 2000;
const MAX_SESSION_ATMOSPHERE_LENGTH = 200;

const serverOwnedFields = new Set([
  'tenantId', 'tenant_id', 'userId', 'user_id', 'agentId', 'agent_id',
  'relationshipId', 'relationship_id', 'memorySessionId', 'memory_session_id',
  'eventId', 'event_id', 'sourceRevision', 'source_revision', 'turnId', 'turn_id',
  'applicationMessageId', 'application_message_id', 'assistantMessageId', 'assistant_message_id',
  'commitId', 'commit_id', 'bindingKey', 'binding_key', 'rawEventReceipt', 'raw_event_receipt'
]);

const nowIso = () => new Date().toISOString();
const clone = value => structuredClone(value);

export class CoreV0Error extends Error {
  constructor(code, message, { status = 500, retryable = false, unknown = false, cause, details = null } = {}) {
    super(message, { cause });
    this.name = 'CoreV0Error';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.unknown = unknown;
    this.details = details;
  }
}

function asCoreError(error, fallbackCode, fallbackMessage, options = {}) {
  if (error instanceof CoreV0Error) return error;
  const hasExplicitUnknown = error && (Object.hasOwn(error, 'unknown') || Object.hasOwn(error, 'unknownOutcome'));
  const explicitUnknown = hasExplicitUnknown
    ? Boolean(error.unknown ?? error.unknownOutcome)
    : null;
  const knownClientFailure = error?.status != null && Number(error.status) < 500;
  return new CoreV0Error(
    error?.code || fallbackCode,
    fallbackMessage,
    {
      status: error?.status || options.status || 503,
      retryable: error?.retryable ?? options.retryable ?? true,
      unknown: explicitUnknown ?? (knownClientFailure ? false : options.unknown ?? false),
      cause: error
    }
  );
}

function ensureArray(object, key) {
  if (!Array.isArray(object[key])) object[key] = [];
  return object[key];
}

export function ensureCoreV0State(state) {
  if (!state || typeof state !== 'object') throw new TypeError('Core v0 state is required');
  state.coreV0 ||= {};
  const core = state.coreV0;
  core.schemaVersion ||= CORE_V0_SCHEMA_VERSION;
  core.sequence ||= 0;
  ensureArray(core, 'memorySessionBindings');
  ensureArray(core, 'turnAdmissions');
  ensureArray(core, 'assistantCommits');
  return core;
}

function nextSequence(core) {
  core.sequence = Number(core.sequence || 0) + 1;
  return core.sequence;
}

function nextSourceRevision(core, { tenantId, subjectUserId, applicationSessionId }) {
  const revisions = core.turnAdmissions
    .filter(turn => turn.tenantId === tenantId
      && turn.subjectUserId === subjectUserId
      && turn.applicationSessionId === applicationSessionId)
    .map(turn => Number(turn.sourceRevision))
    .filter(Number.isInteger);
  return String(Math.max(0, ...revisions) + 1);
}

function requireString(value, field, { max = 200, trim = true } = {}) {
  const normalized = trim ? String(value ?? '').trim() : String(value ?? '');
  if (!normalized) throw new CoreV0Error('INVALID_REQUEST', `${field} is required`, { status: 400 });
  if (normalized.length > max) throw new CoreV0Error('INVALID_REQUEST', `${field} is too long`, { status: 400 });
  return normalized;
}

export function normalizeCoreV0TurnInput(input = {}) {
  const body = input.body && typeof input.body === 'object' ? input.body : input;
  for (const field of serverOwnedFields) {
    if (Object.hasOwn(body, field)) {
      throw new CoreV0Error('SERVER_OWNED_FIELD', `${field} is server-owned`, { status: 400 });
    }
  }

  const headerKey = input.headerIdempotencyKey ?? input.idempotencyKey ?? input.idempotency_key;
  const bodyKey = body.idempotencyKey ?? body.idempotency_key;
  const idempotencyKey = requireString(headerKey, 'Idempotency-Key', { max: 200 });
  if (bodyKey != null && String(bodyKey).trim() !== idempotencyKey) {
    throw new CoreV0Error('IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match', { status: 400 });
  }

  if (typeof body.message !== 'string') throw new CoreV0Error('INVALID_MESSAGE', 'message must be a string', { status: 400 });
  const rawMessage = body.message;
  if (!rawMessage.trim()) throw new CoreV0Error('INVALID_MESSAGE', 'message is required', { status: 400 });
  if (rawMessage.length > MAX_MESSAGE_LENGTH) throw new CoreV0Error('INVALID_MESSAGE', 'message is too long', { status: 400 });
  const message = rawMessage.trim();
  if (isSecretMemoryContent(message)) {
    throw new CoreV0Error('MESSAGE_CONTENT_BLOCKED', 'Message content is not accepted by Core v0', { status: 422 });
  }
  const sessionId = requireString(body.sessionId, 'sessionId', { max: 200 });
  const channel = String(body.channel ?? '默认').trim().slice(0, MAX_CHANNEL_LENGTH) || '默认';
  const fingerprint = JSON.stringify({ sessionId, message, channel });
  return { idempotencyKey, sessionId, message, channel, fingerprint };
}

function stateSnapshot(state, sessionId) {
  const core = ensureCoreV0State(state);
  return {
    turnAdmissions: clone(core.turnAdmissions.filter(item => item?.applicationSessionId === sessionId)),
    memorySessionBindings: clone(core.memorySessionBindings.filter(item => item?.applicationSessionId === sessionId)),
    assistantCommits: clone(core.assistantCommits.filter(item => item?.applicationSessionId === sessionId)),
    messages: clone(state.messages?.[sessionId] || [])
  };
}

function restoreScopedRecords(current, sessionId, snapshot) {
  const restored = [];
  let inserted = false;
  for (const item of current) {
    if (item?.applicationSessionId === sessionId) {
      if (!inserted) {
        restored.push(...snapshot);
        inserted = true;
      }
      continue;
    }
    restored.push(item);
  }
  if (!inserted) restored.push(...snapshot);
  return restored;
}

function restoreStateSnapshot(state, sessionId, snapshot) {
  const core = ensureCoreV0State(state);
  core.turnAdmissions = restoreScopedRecords(core.turnAdmissions, sessionId, snapshot.turnAdmissions);
  core.memorySessionBindings = restoreScopedRecords(core.memorySessionBindings, sessionId, snapshot.memorySessionBindings);
  core.assistantCommits = restoreScopedRecords(core.assistantCommits, sessionId, snapshot.assistantCommits);
  state.messages ||= {};
  state.messages[sessionId] = snapshot.messages;
}

export function createCoreV0Store({ state, persist = async () => {} } = {}) {
  const core = ensureCoreV0State(state);
  state.messages ||= {};

  const messagesFor = sessionId => {
    state.messages[sessionId] ||= [];
    return state.messages[sessionId];
  };
  const findTurn = turnId => core.turnAdmissions.find(item => item.turnId === turnId) || null;
  const findTurnByKey = ({ tenantId, subjectUserId, applicationSessionId, idempotencyKey }) => core.turnAdmissions.find(item => item.tenantId === tenantId
    && item.subjectUserId === subjectUserId
    && item.applicationSessionId === applicationSessionId
    && item.idempotencyKey === idempotencyKey) || null;
  const findBindingByApplicationSession = ({ tenantId, subjectUserId, applicationSessionId }) => core.memorySessionBindings.find(item => item.tenantId === tenantId
    && item.subjectUserId === subjectUserId
    && item.applicationSessionId === applicationSessionId) || null;
  const findBindingByMemorySession = ({ tenantId, subjectUserId, memorySessionId }) => core.memorySessionBindings.find(item => item.tenantId === tenantId
    && item.subjectUserId === subjectUserId
    && item.memorySessionId === memorySessionId) || null;
  const findCommit = commitId => core.assistantCommits.find(item => item.commitId === commitId) || null;
  const findMessage = (sessionId, messageId) => messagesFor(sessionId).find(item => item.id === messageId) || null;

  const commitAssistantInMemory = ({ turn, commit, content, createdAt = nowIso() }) => {
    // A same-millisecond commit would leave the assistant row with an identical
    // created_at to the user row, which makes read ordering depend on row
    // identity instead of write order. Commit time is therefore kept strictly
    // after the turn admission time.
    const commitAt = createdAt && turn?.createdAt && String(createdAt) <= String(turn.createdAt)
      ? new Date(Date.parse(turn.createdAt) + 1).toISOString()
      : createdAt;
    const messages = messagesFor(turn.applicationSessionId);
    const existing = messages.find(item => item.id === commit.assistantMessageId);
    if (existing && (existing.role !== 'assistant'
      || existing.content !== content
      || existing.coreV0?.turnId && existing.coreV0.turnId !== turn.turnId)) {
      throw new CoreV0Error('ASSISTANT_COMMIT_CONFLICT', 'Assistant message commit payload conflicts with the existing message', { status: 409 });
    }
    const message = existing || {
      id: commit.assistantMessageId,
      role: 'assistant',
      content,
      createdAt: commitAt,
      channel: turn.channel,
      visibleAt: null,
      coreV0: {
        turnId: turn.turnId,
        commitId: commit.commitId,
        status: 'pending'
      }
    };
    if (!existing) messages.push(message);
    message.visibleAt = commitAt;
    message.coreV0 = { ...message.coreV0, status: 'committed', turnId: turn.turnId, commitId: commit.commitId };
    commit.content = content;
    commit.status = 'completed';
    commit.completedAt = commitAt;
    commit.receiptId ||= `receipt:${commit.commitId}`;
    turn.status = 'committed';
    turn.committedAt = commitAt;
    turn.result = {
      status: 'committed',
      turnId: turn.turnId,
      applicationMessageId: turn.applicationMessageId,
      assistantMessageId: commit.assistantMessageId,
      memoryStatus: turn.memoryStatus || 'available',
      receiptId: commit.receiptId
    };
    return message;
  };

  return {
    state,
    core,
    messagesFor,
    findTurn,
    findTurnByKey,
    findBindingByApplicationSession,
    findBindingByMemorySession,
    findCommit,
    findMessage,
    nextSequence: () => nextSequence(core),
    nextSourceRevision: scope => nextSourceRevision(core, scope),
    snapshot: sessionId => stateSnapshot(state, sessionId),
    restore: (sessionId, snapshot) => restoreStateSnapshot(state, sessionId, snapshot),
    getAssistantCommitReceipt: commitId => {
      const commit = findCommit(commitId);
      if (!commit) return { status: 'not_found', authoritative: true, commitId };
      return { status: commit.status, commitId: commit.commitId, receiptId: commit.receiptId || null, assistantMessageId: commit.assistantMessageId };
    },
    commitAssistantInMemory,
    persist,
    addTurn(turn) { core.turnAdmissions.push(turn); },
    addBinding(binding) { core.memorySessionBindings.push(binding); },
    addCommit(commit) { core.assistantCommits.push(commit); }
  };
}

function memoryReceiptStatus(value) {
  if (!value) return 'pending';
  if (value.status === 'pending' || value.result === 'pending') return 'pending';
  return 'completed';
}

export function createInProcessMemoryPort({ memoryModule, context } = {}) {
  if (!memoryModule || typeof memoryModule.createSession !== 'function' || typeof memoryModule.recordEvent !== 'function') {
    throw new TypeError('Core v0 MemoryPort requires a Memory Module');
  }
  const baseContext = { ...(context || {}), sessionId: null };
  const memoryState = memoryModule.state || null;
  const bindingMutationKey = bindingKey => `core-v0:binding:${bindingKey}`;

  const findMutationRecord = (namespace, key) => memoryState?.idempotencyRecords?.find(record => record.tenantId === baseContext.tenantId
    && record.userId === baseContext.subjectUserId
    && (record.mutationNamespace || record.namespace || 'event') === namespace
    && record.key === key) || null;

  return {
    async getSessionBinding({ bindingKey }) {
      const record = findMutationRecord('session.create', bindingMutationKey(bindingKey));
      const session = record?.response?.id ? record.response : null;
      if (!session) return { status: 'not_found', authoritative: true, bindingKey };
      return { status: 'completed', memorySessionId: session.id, receipt: { status: 'completed', memorySessionId: session.id } };
    },

    async reconcileSessionBinding({ bindingKey }) {
      return this.getSessionBinding({ bindingKey });
    },

    async ensureSessionBinding({ bindingKey }) {
      try {
        const result = await memoryModule.createSession(baseContext, {
          idempotency_key: `core-v0:binding:${bindingKey}`,
          callerAgentId: baseContext.callerAgentId || 'cochpia'
        });
        const session = result?.session || result;
        if (!session?.id) throw new Error('Memory session receipt did not contain a session id');
        return { status: 'completed', memorySessionId: session.id, receipt: { status: 'completed', memorySessionId: session.id } };
      } catch (error) {
        throw asCoreError(error, 'MEMORY_SESSION_BINDING_FAILED', 'Memory session binding failed', { status: 503, unknown: true });
      }
    },

    async appendRawEvent({ event, memorySessionId }) {
      try {
        const result = await memoryModule.recordEvent({ ...baseContext, sessionId: memorySessionId }, {
          ...event,
          sessionId: memorySessionId,
          contentType: event.contentType || 'plain_text',
          eventRole: event.eventRole || 'user',
          isStreamFinal: true
        });
        if (result?.result === 'accepted_no_store') {
          return {
            status: 'failed',
            code: 'MEMORY_CONTENT_NOT_ADMITTED',
            httpStatus: 422,
            retryable: false,
            unknown: false,
            receipt: { status: 'not_stored', eventId: event.eventId, sourceRevision: event.sourceRevision, result: result.result }
          };
        }
        const status = memoryReceiptStatus(result);
        return { status, receipt: { status, eventId: event.eventId, sourceRevision: event.sourceRevision, rawEventId: result?.rawEventId || null, result: result?.result || null } };
      } catch (error) {
        throw asCoreError(error, 'MEMORY_RAW_EVENT_FAILED', 'Memory raw event append failed', { status: 503, unknown: true });
      }
    },

    async getRawEventReceipt({ eventId, sourceRevision }) {
      const rawEvent = memoryState?.rawEvents?.find(item => item.tenantId === baseContext.tenantId
        && item.userId === baseContext.subjectUserId
        && item.eventId === eventId
        && item.sourceRevision === sourceRevision);
      if (rawEvent) return { status: 'completed', receipt: { status: 'completed', eventId, sourceRevision, rawEventId: rawEvent.id, result: 'accepted_stored' } };
      const record = findMutationRecord('event', `${eventId}:${sourceRevision}`);
      if (record?.result === 'accepted_no_store' || record?.result === 'accepted_stored') {
        return { status: 'completed', receipt: { status: 'completed', eventId, sourceRevision, rawEventId: null, result: record.result } };
      }
      return { status: 'not_found', authoritative: true, eventId, sourceRevision };
    },

    async reconcileRawEvent({ eventId, sourceRevision }) {
      return this.getRawEventReceipt({ eventId, sourceRevision });
    },

    async retrieveContext({ query, memorySessionId, tokenBudget = 1800 }) {
      try {
        const bundle = await memoryModule.contextBundleAsync({ ...baseContext, sessionId: memorySessionId }, {
          query: String(query || '').slice(0, 1000),
          purpose: 'answer_user_query',
          tokenBudget
        });
        return {
          status: 'available',
          bundle,
          recalled: memoryBundleToRecalled(bundle).slice(0, MAX_RECALLED_ITEMS),
          answerability: bundle?.answerability || 'not_found'
        };
      } catch (error) {
        throw asCoreError(error, 'MEMORY_RETRIEVE_FAILED', 'Memory retrieval failed', { status: 503, unknown: false });
      }
    }
  };
}

export function createCoreV0ContextBuilder({ maxMessages = MAX_CONTEXT_MESSAGES, maxRecalled = MAX_RECALLED_ITEMS } = {}) {
  const messageLimit = Number.isFinite(Number(maxMessages))
    ? Math.max(0, Math.min(50, Math.floor(Number(maxMessages))))
    : MAX_CONTEXT_MESSAGES;
  const recalledLimit = Number.isFinite(Number(maxRecalled))
    ? Math.max(0, Math.min(50, Math.floor(Number(maxRecalled))))
    : MAX_RECALLED_ITEMS;
  const clip = (value, max) => String(value ?? '').slice(0, max);
  return ({ state, session, messages = [], memoryView = {}, recalled = [] } = {}) => {
    const boundedMessages = messages
      .filter(item => item && !item.supersededAt && item.content)
      .slice(-messageLimit)
      .map(item => ({ ...item, content: clip(item.content, MAX_CONTEXT_MESSAGE_LENGTH) }));
    const boundedRecalled = recalled.slice(0, recalledLimit)
      .map(item => ({ ...item, summary: clip(item?.summary, MAX_RECALLED_ITEM_LENGTH) }));
    return {
      ...buildRuntimeContext({
        messages: boundedMessages,
        personality: state.personality || null,
        recalled: boundedRecalled,
        memoryBundle: memoryView.bundle || null,
        summary: clip(session?.summary || '', MAX_SESSION_SUMMARY_LENGTH),
        persona: clip(session?.persona || '', MAX_SESSION_PERSONA_LENGTH),
        atmosphere: clip(session?.atmosphere || '', MAX_SESSION_ATMOSPHERE_LENGTH),
        profile: state.profile || null,
        mode: 'companion',
        companionIntent: session?.companionIntent || 'listen'
      }),
      memoryStatus: memoryView.status || 'degraded',
      memoryAnswerability: memoryView.answerability || 'not_found'
    };
  };
}

export function createCoreV0MockModelGateway({ provider = createModelProvider('mock') } = {}) {
  if (!provider || typeof provider.generate !== 'function') throw new TypeError('Core v0 model gateway requires generate');
  return {
    async generate({ message, recalled = [], runtimeContext = null } = {}) {
      const content = await provider.generate({ message, recalled, runtimeContext });
      if (!String(content || '').trim()) throw new CoreV0Error('MODEL_EMPTY_RESULT', 'Model returned an empty result', { status: 502, retryable: true });
      return { status: 'generation_succeeded', content: String(content).trim() };
    }
  };
}

const lockRegistry = new WeakMap();
function withTurnLock(state, key, callback) {
  let locks = lockRegistry.get(state);
  if (!locks) {
    locks = new Map();
    lockRegistry.set(state, locks);
  }
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(key, current);
  return previous.then(callback).finally(() => {
    release();
    if (locks.get(key) === current) locks.delete(key);
  });
}

function identityFromContext(context = {}) {
  const tenantId = requireString(context.tenantId ?? context.tenant_id ?? 'local-tenant', 'tenantId', { max: 200 });
  const subjectUserId = requireString(context.subjectUserId ?? context.userId ?? context.user_id ?? 'local-user', 'subjectUserId', { max: 200 });
  return { tenantId, subjectUserId };
}

function bindingKeyFor(tenantId, subjectUserId, applicationSessionId) {
  return `${tenantId}:${subjectUserId}:${applicationSessionId}`;
}

function pendingResult(turn, memoryStatus = 'pending') {
  return {
    status: 'pending',
    turnId: turn.turnId,
    applicationMessageId: turn.applicationMessageId,
    assistantMessageId: turn.assistantMessageId,
    memoryStatus,
    receiptId: turn.pendingReceiptId || turn.admissionReceiptId || `admission:${turn.turnId}`,
    retryable: true
  };
}

export function createCoreV0TurnService({
  state,
  context = {},
  persist = async () => {},
  memoryPort,
  modelGateway = createCoreV0MockModelGateway(),
  contextBuilder = createCoreV0ContextBuilder(),
  enabled = true,
  store = null,
  commitWriter = null,
  now = nowIso
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Core v0 turn service requires state');
  if (!memoryPort) throw new TypeError('Core v0 turn service requires MemoryPort');
  if (!modelGateway || typeof modelGateway.generate !== 'function') throw new TypeError('Core v0 turn service requires Model Gateway');
  const runtimeStore = store || createCoreV0Store({ state, persist });
  const { tenantId, subjectUserId } = identityFromContext(context);

  const persistOrThrow = async () => {
    try {
      await runtimeStore.persist();
    } catch (error) {
      if (error?.code === 'CORE_STORAGE_CONFLICT') {
        throw new CoreV0Error('STORAGE_WRITE_FAILED', 'Core v0 durable state changed during this operation', { status: 503, retryable: true, unknown: true, cause: error });
      }
      throw asCoreError(error, 'STORAGE_WRITE_FAILED', 'Core v0 durable state could not be saved', { status: 503, unknown: true });
    }
  };

  const sessionFor = sessionId => {
    const session = (state.sessions || []).find(item => item.id === sessionId);
    if (!session) throw new CoreV0Error('SESSION_NOT_FOUND', 'Session not found', { status: 404 });
    return session;
  };

  const responseForCommitted = (turn, { replay = false } = {}) => ({
    ...(turn.result || {
      status: 'committed',
      turnId: turn.turnId,
      applicationMessageId: turn.applicationMessageId,
      assistantMessageId: turn.assistantMessageId,
      memoryStatus: turn.memoryStatus || 'available',
      receiptId: runtimeStore.findCommit(turn.commitId)?.receiptId || null
    }),
    replay
  });

  const markFailed = async (turn, error) => {
    turn.status = 'failed';
    turn.updatedAt = now();
    turn.failure = { code: error.code || 'CORE_V0_FAILED', at: turn.updatedAt };
    try { await runtimeStore.persist(); } catch { /* preserve the original failure; the caller receives no success */ }
  };

  const markPending = async (turn, memoryStatus = turn.memoryStatus || 'pending') => {
    turn.status = 'pending';
    turn.memoryStatus = memoryStatus;
    turn.updatedAt = now();
    await persistOrThrow();
    return pendingResult(turn, memoryStatus);
  };

  const applyBindingReceipt = async (turn, binding, result) => {
    const memorySessionId = result?.memorySessionId || result?.session?.id;
    if (!memorySessionId) return false;
    if (binding.memorySessionId && binding.memorySessionId !== memorySessionId) {
      throw new CoreV0Error('SESSION_BINDING_CONFLICT', 'Memory session binding is immutable and conflicts with the existing mapping', { status: 409 });
    }
    const conflicting = runtimeStore.findBindingByMemorySession({ tenantId, subjectUserId, memorySessionId });
    if (conflicting && conflicting.applicationSessionId !== turn.applicationSessionId) {
      throw new CoreV0Error('SESSION_BINDING_CONFLICT', 'Memory session is already bound to another application session', { status: 409 });
    }
    binding.memorySessionId = memorySessionId;
    binding.status = 'completed';
    binding.receipt = result.receipt || { status: 'completed', memorySessionId };
    binding.updatedAt = now();
    turn.memorySessionId = memorySessionId;
    turn.updatedAt = binding.updatedAt;
    return true;
  };

  const lookupBinding = async turn => {
    const lookup = memoryPort.reconcileSessionBinding || memoryPort.getSessionBinding;
    if (typeof lookup !== 'function') return null;
    try {
      return await lookup.call(memoryPort, {
        context,
        applicationSessionId: turn.applicationSessionId,
        bindingKey: turn.bindingKey
      });
    } catch (error) {
      const normalized = asCoreError(error, 'MEMORY_SESSION_BINDING_LOOKUP_FAILED', 'Memory session binding lookup failed', { status: 503, unknown: true });
      if (normalized.unknown) return { status: 'pending', errorCode: normalized.code };
      throw normalized;
    }
  };

  const ensureBinding = async (turn) => {
    const existing = runtimeStore.findBindingByApplicationSession({ tenantId, subjectUserId, applicationSessionId: turn.applicationSessionId });
    const binding = existing || {
      bindingId: `binding:${randomUUID()}`,
      bindingKey: turn.bindingKey,
      tenantId,
      subjectUserId,
      applicationSessionId: turn.applicationSessionId,
      memorySessionId: null,
      memoryContractVersion: 'v1',
      status: 'pending',
      createdAt: now(),
      updatedAt: now()
    };
    if (!existing) {
      runtimeStore.addBinding(binding);
      await persistOrThrow();
    }
    if (binding.status === 'completed' && binding.memorySessionId) {
      turn.memorySessionId = binding.memorySessionId;
      return { status: 'completed', binding };
    }

    try {
      const reconciled = await lookupBinding(turn);
      if (reconciled?.status === 'pending' || reconciled?.status === 'processing' || reconciled?.status === 'uncertain') {
        binding.status = 'pending';
        binding.updatedAt = now();
        turn.status = 'pending';
        turn.updatedAt = binding.updatedAt;
        await persistOrThrow();
        return { status: 'pending', binding };
      }
      if (reconciled?.status === 'completed') {
        await applyBindingReceipt(turn, binding, reconciled);
        await persistOrThrow();
        return { status: 'completed', binding };
      }
      if (reconciled?.status === 'not_found' && reconciled.authoritative === false) {
        binding.status = 'pending';
        binding.updatedAt = now();
        turn.status = 'pending';
        turn.updatedAt = binding.updatedAt;
        await persistOrThrow();
        return { status: 'pending', binding };
      }
      if (reconciled?.status === 'failed') {
        throw new CoreV0Error(reconciled.code || 'MEMORY_SESSION_BINDING_FAILED', 'Memory session binding failed', { status: reconciled.httpStatus || 503, retryable: true, unknown: Boolean(reconciled.unknown) });
      }
      const result = await memoryPort.ensureSessionBinding({
        context,
        applicationSessionId: turn.applicationSessionId,
        bindingKey: turn.bindingKey
      });
      if (result?.status === 'failed') {
        throw new CoreV0Error(result.code || 'MEMORY_SESSION_BINDING_FAILED', 'Memory session binding failed', { status: result.httpStatus || 503, retryable: true, unknown: Boolean(result.unknown) });
      }
      if (result?.status === 'pending' || result?.status === 'processing' || result?.status === 'uncertain' || !result?.memorySessionId) {
        binding.status = 'pending';
        binding.updatedAt = now();
        turn.status = 'pending';
        turn.updatedAt = binding.updatedAt;
        await persistOrThrow();
        return { status: 'pending', binding };
      }
      await applyBindingReceipt(turn, binding, result);
      await persistOrThrow();
      return { status: 'completed', binding };
    } catch (error) {
      const normalized = asCoreError(error, 'MEMORY_SESSION_BINDING_FAILED', 'Memory session binding failed', { status: 503, unknown: true });
      binding.status = normalized.unknown ? 'pending' : 'failed';
      binding.lastErrorCode = normalized.code;
      binding.updatedAt = now();
      turn.status = normalized.unknown ? 'pending' : 'failed';
      turn.updatedAt = binding.updatedAt;
      try { await runtimeStore.persist(); } catch { /* the request remains non-successful */ }
      if (normalized.unknown) return { status: 'pending', binding };
      throw normalized;
    }
  };

  const addAdmittedMessage = async turn => {
    const messages = runtimeStore.messagesFor(turn.applicationSessionId);
    const existing = messages.find(item => item.id === turn.applicationMessageId);
    if (existing) {
      if (existing.role !== 'user' || existing.content !== turn.message || existing.coreV0?.turnId && existing.coreV0.turnId !== turn.turnId) {
        throw new CoreV0Error('TURN_MESSAGE_CONFLICT', 'Application message conflicts with the existing admitted message', { status: 409 });
      }
      return existing;
    }
    const message = {
      id: turn.applicationMessageId,
      role: 'user',
      content: turn.message,
      createdAt: turn.createdAt,
      channel: turn.channel,
      visibleAt: turn.createdAt,
      coreV0: {
        turnId: turn.turnId,
        eventId: turn.eventId,
        sourceRevision: turn.sourceRevision,
        status: 'admitted'
      }
    };
    messages.push(message);
    return message;
  };

  const applyRawEventReceipt = async (turn, result) => {
    if (!result || result.status === 'pending' || result.status === 'processing' || result.status === 'uncertain') return false;
    if (result.status === 'failed') {
      throw new CoreV0Error(result.code || 'MEMORY_RAW_EVENT_FAILED', 'Memory raw event append failed', { status: result.httpStatus || 503, retryable: result.retryable ?? true, unknown: Boolean(result.unknown) });
    }
    if (result.result === 'accepted_no_store' || result.receipt?.result === 'accepted_no_store' || result.receipt?.status === 'not_stored') {
      throw new CoreV0Error('MEMORY_CONTENT_NOT_ADMITTED', 'Memory did not admit the message content', { status: 422, retryable: false });
    }
    if (result.status === 'not_found' && result.authoritative === false) return false;
    if (result.status !== 'completed' && !result.receipt) return false;
    turn.rawEventReceipt = result.receipt || { status: 'completed', eventId: turn.eventId, sourceRevision: turn.sourceRevision };
    turn.status = 'admitted';
    turn.updatedAt = now();
    await addAdmittedMessage(turn);
    return true;
  };

  const lookupRawEvent = async turn => {
    const lookup = memoryPort.reconcileRawEvent || memoryPort.getRawEventReceipt;
    if (typeof lookup !== 'function') return null;
    try {
      return await lookup.call(memoryPort, {
        context,
        eventId: turn.eventId,
        sourceRevision: turn.sourceRevision,
        memorySessionId: turn.memorySessionId
      });
    } catch (error) {
      const normalized = asCoreError(error, 'MEMORY_RAW_EVENT_LOOKUP_FAILED', 'Memory raw event lookup failed', { status: 503, unknown: true });
      if (normalized.unknown) return { status: 'pending', errorCode: normalized.code };
      throw normalized;
    }
  };

  const appendEvent = async turn => {
    if (turn.rawEventReceipt?.status === 'completed') return { status: 'completed', receipt: turn.rawEventReceipt };
    const snapshot = runtimeStore.snapshot(turn.applicationSessionId);
    try {
      const reconciled = await lookupRawEvent(turn);
      if (reconciled?.status === 'pending' || reconciled?.status === 'processing' || reconciled?.status === 'uncertain') {
        turn.status = 'pending';
        turn.updatedAt = now();
        await persistOrThrow();
        return { status: 'pending' };
      }
      if (reconciled?.status === 'completed') {
        await applyRawEventReceipt(turn, reconciled);
        await persistOrThrow();
        return { status: 'completed', receipt: turn.rawEventReceipt };
      }
      if (reconciled?.status === 'not_found' && reconciled.authoritative === false) {
        turn.status = 'pending';
        turn.updatedAt = now();
        await persistOrThrow();
        return { status: 'pending' };
      }
      if (reconciled?.status === 'failed') {
        throw new CoreV0Error(reconciled.code || 'MEMORY_RAW_EVENT_FAILED', 'Memory raw event append failed', { status: reconciled.httpStatus || 503, retryable: true, unknown: Boolean(reconciled.unknown) });
      }
      const result = await memoryPort.appendRawEvent({
        context,
        memorySessionId: turn.memorySessionId,
        event: {
          eventId: turn.eventId,
          sourceRevision: turn.sourceRevision,
          turnId: turn.turnId,
          applicationSessionId: turn.applicationSessionId,
          applicationMessageId: turn.applicationMessageId,
          content: turn.message,
          eventRole: 'user',
          contentType: 'plain_text',
          occurredAt: turn.createdAt,
          metadata: {
            producer: 'companion-core',
            correlation_id: context.correlationId || turn.turnId,
            turn_id: turn.turnId,
            channel: turn.channel
          }
        }
      });
      if (result?.status === 'pending' || result?.status === 'processing' || result?.status === 'uncertain') {
        turn.status = 'pending';
        turn.updatedAt = now();
        await persistOrThrow();
        return { status: 'pending' };
      }
      const applied = await applyRawEventReceipt(turn, result);
      if (!applied) {
        turn.status = 'pending';
        turn.updatedAt = now();
        await persistOrThrow();
        return { status: 'pending' };
      }
      await persistOrThrow();
      return { status: 'completed', receipt: turn.rawEventReceipt };
    } catch (error) {
      const normalized = asCoreError(error, 'MEMORY_RAW_EVENT_FAILED', 'Memory raw event append failed', { status: 503, unknown: true });
      runtimeStore.restore(turn.applicationSessionId, snapshot);
      const restoredTurn = runtimeStore.findTurn(turn.turnId) || turn;
      restoredTurn.status = normalized.unknown ? 'pending' : 'failed';
      restoredTurn.updatedAt = now();
      restoredTurn.failure = { code: normalized.code, at: restoredTurn.updatedAt };
      try { await runtimeStore.persist(); } catch { /* preserve non-success */ }
      if (normalized.unknown) return { status: 'pending' };
      throw normalized;
    }
  };

  const retrieve = async turn => {
    try {
      const result = await memoryPort.retrieveContext({ context, memorySessionId: turn.memorySessionId, query: turn.message, tokenBudget: 1800 });
      turn.memoryStatus = result?.status || 'available';
      turn.memoryAnswerability = result?.answerability || 'not_found';
      return result || { status: 'available', recalled: [], bundle: null };
    } catch (error) {
      turn.memoryStatus = 'degraded';
      turn.memoryAnswerability = 'degraded';
      return { status: 'degraded', recalled: [], bundle: null, errorCode: error.code || 'MEMORY_RETRIEVE_FAILED' };
    }
  };

  const generate = async (turn, session, memoryView) => {
    if (turn.generatedContent) return { status: 'generation_succeeded', content: turn.generatedContent };
    const previousMessages = runtimeStore.messagesFor(turn.applicationSessionId)
      .filter(item => item.id !== turn.applicationMessageId && item.visibleAt !== null)
      .slice(-MAX_CONTEXT_MESSAGES);
    turn.status = 'context_ready';
    turn.updatedAt = now();
    await persistOrThrow();
    try {
      const runtimeContext = contextBuilder({
        state,
        session,
        messages: previousMessages,
        memoryView,
        recalled: memoryView.recalled || []
      });
      const result = await modelGateway.generate({ message: turn.message, recalled: memoryView.recalled || [], runtimeContext });
      if (result?.status === 'failed') throw new CoreV0Error(result.code || 'MODEL_GENERATION_FAILED', 'Model generation failed', { status: result.httpStatus || 502, retryable: true });
      const content = String(typeof result === 'string' ? result : result?.content || '').trim();
      if (!content) throw new CoreV0Error('MODEL_EMPTY_RESULT', 'Model returned an empty result', { status: 502, retryable: true });
      turn.generatedContent = content;
      turn.status = 'generation_succeeded';
      turn.updatedAt = now();
      await persistOrThrow();
      return { status: 'generation_succeeded', content };
    } catch (error) {
      const normalized = asCoreError(error, 'MODEL_GENERATION_FAILED', 'Model generation failed', { status: 502, retryable: true });
      await markFailed(turn, normalized);
      throw normalized;
    }
  };

  const commit = async turn => {
    let commitRecord = runtimeStore.findCommit(turn.commitId);
    if (!commitRecord) {
      commitRecord = {
        commitId: turn.commitId,
        turnId: turn.turnId,
        tenantId,
        subjectUserId,
        applicationSessionId: turn.applicationSessionId,
        assistantMessageId: turn.assistantMessageId,
        status: 'pending',
        content: turn.generatedContent,
        createdAt: now(),
        completedAt: null,
        receiptId: null
      };
      runtimeStore.addCommit(commitRecord);
    } else if (commitRecord.content && turn.generatedContent && commitRecord.content !== turn.generatedContent) {
      throw new CoreV0Error('ASSISTANT_COMMIT_CONFLICT', 'Assistant commit payload conflicts with the existing commit', { status: 409 });
    }
    if (!turn.generatedContent && commitRecord.content) turn.generatedContent = commitRecord.content;
    if (commitRecord.status === 'completed') {
      const snapshot = runtimeStore.snapshot(turn.applicationSessionId);
      try {
        runtimeStore.commitAssistantInMemory({ turn, commit: commitRecord, content: commitRecord.content || turn.generatedContent, createdAt: commitRecord.completedAt || now() });
        await persistOrThrow();
        return responseForCommitted(turn);
      } catch (error) {
        const normalized = asCoreError(error, 'ASSISTANT_COMMIT_FAILED', 'Assistant result could not be committed', { status: 503, retryable: true });
        runtimeStore.restore(turn.applicationSessionId, snapshot);
        throw normalized;
      }
    }
    turn.status = 'commit_pending';
    turn.pendingReceiptId ||= `commit:${turn.commitId}`;
    turn.updatedAt = now();
    await persistOrThrow();
    const snapshot = runtimeStore.snapshot(turn.applicationSessionId);
    try {
      const writerResult = commitWriter ? await commitWriter({ store: runtimeStore, turn, commit: commitRecord }) : null;
      if (writerResult?.status === 'pending' || writerResult?.status === 'processing' || writerResult?.status === 'uncertain') {
        runtimeStore.restore(turn.applicationSessionId, snapshot);
        const restoredTurn = runtimeStore.findTurn(turn.turnId) || turn;
        return markPending(restoredTurn, turn.memoryStatus || 'available');
      }
      if (writerResult?.status === 'failed') {
        throw new CoreV0Error(writerResult.code || 'ASSISTANT_COMMIT_FAILED', 'Assistant result could not be committed', { status: writerResult.httpStatus || 503, retryable: true, unknown: Boolean(writerResult.unknown) });
      }
      if (writerResult?.receiptId) commitRecord.receiptId = writerResult.receiptId;
      runtimeStore.commitAssistantInMemory({ turn, commit: commitRecord, content: turn.generatedContent, createdAt: now() });
      await persistOrThrow();
      return responseForCommitted(turn);
    } catch (error) {
      const normalized = asCoreError(error, 'ASSISTANT_COMMIT_FAILED', 'Assistant result could not be committed', { status: 503, retryable: true, unknown: Boolean(commitWriter) });
      runtimeStore.restore(turn.applicationSessionId, snapshot);
      const restoredTurn = runtimeStore.findTurn(turn.turnId);
      if (normalized.unknown || normalized.code === 'STORAGE_WRITE_FAILED') {
        if (restoredTurn) {
          restoredTurn.status = 'pending';
          restoredTurn.pendingReceiptId ||= `commit:${turn.commitId}`;
          restoredTurn.updatedAt = now();
        }
        try { await runtimeStore.persist(); } catch { /* leave the request non-successful */ }
        return pendingResult(restoredTurn || turn, turn.memoryStatus || 'available');
      }
      if (restoredTurn) {
        restoredTurn.status = 'failed';
        restoredTurn.updatedAt = now();
        restoredTurn.failure = { code: normalized.code, at: restoredTurn.updatedAt };
        try { await runtimeStore.persist(); } catch { /* preserve the original failure */ }
      }
      throw normalized;
    }
  };

  const execute = async (normalizedInput, { allowDisabled = false } = {}) => {
    if (!enabled && !allowDisabled) throw new CoreV0Error('CORE_V0_DISABLED', 'Core v0 is disabled', { status: 503, retryable: true });
    const session = sessionFor(normalizedInput.sessionId);
    const applicationSessionId = normalizedInput.sessionId;
    const existing = runtimeStore.findTurnByKey({ tenantId, subjectUserId, applicationSessionId, idempotencyKey: normalizedInput.idempotencyKey });
    if (existing) {
      if (existing.fingerprint !== normalizedInput.fingerprint) {
        throw new CoreV0Error('IDEMPOTENCY_KEY_CONFLICT', 'The same idempotency key was already used with a different turn', { status: 409 });
      }
      if (existing.status === 'committed') {
        if (!existing.result) {
          const commitReceipt = runtimeStore.getAssistantCommitReceipt(existing.commitId);
          if (commitReceipt.status !== 'completed') return pendingResult(existing, existing.memoryStatus || 'available');
          existing.result = {
            status: 'committed',
            turnId: existing.turnId,
            applicationMessageId: existing.applicationMessageId,
            assistantMessageId: existing.assistantMessageId,
            memoryStatus: existing.memoryStatus || 'available',
            receiptId: commitReceipt.receiptId
          };
          await persistOrThrow();
        }
        return responseForCommitted(existing, { replay: true });
      }
    }

    const turn = existing || {
      turnId: `turn:${randomUUID()}`,
      tenantId,
      subjectUserId,
      applicationSessionId,
      idempotencyKey: normalizedInput.idempotencyKey,
      fingerprint: normalizedInput.fingerprint,
      message: normalizedInput.message,
      channel: normalizedInput.channel,
      bindingKey: bindingKeyFor(tenantId, subjectUserId, applicationSessionId),
      memorySessionId: null,
      applicationMessageId: `message:${randomUUID()}`,
      assistantMessageId: randomUUID(),
      eventId: `event:${randomUUID()}`,
      sequenceNo: runtimeStore.nextSequence(),
      sourceRevision: runtimeStore.nextSourceRevision({ tenantId, subjectUserId, applicationSessionId }),
      commitId: null,
      admissionReceiptId: null,
      pendingReceiptId: null,
      status: 'admission_pending',
      memoryStatus: 'pending',
      memoryAnswerability: 'not_found',
      rawEventReceipt: null,
      generatedContent: null,
      result: null,
      createdAt: now(),
      updatedAt: now()
    };
    turn.commitId = `assistant:${turn.assistantMessageId}`;
    turn.admissionReceiptId = `admission:${turn.turnId}`;
    if (!existing) {
      runtimeStore.addTurn(turn);
      try {
        await persistOrThrow();
      } catch (error) {
        const index = runtimeStore.core.turnAdmissions.indexOf(turn);
        if (index >= 0) runtimeStore.core.turnAdmissions.splice(index, 1);
        throw error;
      }
    }

    const bindingResult = await ensureBinding(turn);
    if (bindingResult.status === 'pending') return pendingResult(turn, 'pending');

    const eventResult = await appendEvent(turn);
    if (eventResult.status === 'pending') return pendingResult(turn, 'pending');

    const memoryView = await retrieve(turn);
    turn.updatedAt = now();
    await persistOrThrow();

    await generate(turn, session, memoryView);
    return commit(turn);
  };

  return {
    normalize: normalizeCoreV0TurnInput,
    async handleTurn(input = {}) {
      const normalized = normalizeCoreV0TurnInput(input);
      const lockKey = `${tenantId}:${subjectUserId}:${normalized.sessionId}`;
      return withTurnLock(state, lockKey, () => execute(normalized));
    },
    async reconcileTurn(turnId) {
      const turn = runtimeStore.findTurn(turnId);
      if (!turn || turn.tenantId !== tenantId || turn.subjectUserId !== subjectUserId) {
        throw new CoreV0Error('TURN_NOT_FOUND', 'Turn not found', { status: 404 });
      }
      const lockKey = `${tenantId}:${subjectUserId}:${turn.applicationSessionId}`;
      return withTurnLock(state, lockKey, () => execute({
        idempotencyKey: turn.idempotencyKey,
        sessionId: turn.applicationSessionId,
        message: turn.message,
        channel: turn.channel,
        fingerprint: turn.fingerprint
      }, { allowDisabled: true }));
    },
    getTurn: turnId => {
      const turn = runtimeStore.findTurn(turnId);
      return turn && turn.tenantId === tenantId && turn.subjectUserId === subjectUserId ? turn : null;
    },
    store: runtimeStore,
    identity: { tenantId, subjectUserId }
  };
}

export function coreV0ErrorResponse(error) {
  const normalized = error instanceof CoreV0Error
    ? error
    : new CoreV0Error('CORE_V0_FAILED', 'Core v0 request failed', { status: 500, cause: error });
  return {
    status: normalized.status,
    body: {
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        unknown: normalized.unknown
      }
    }
  };
}
