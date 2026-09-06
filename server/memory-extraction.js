// R-005 extraction drain: turns committed raw events into active Memory
// assertions through an injected extractor, then lets Module policy decide
// promotion. The drain never writes Core tables and never fails a turn.
//
// Concurrency (R5-AR-001): a session-level advisory lock scoped to the
// (tenant, subject) pair serializes concurrent drains before any full-state
// save. Budget (R5-AR-002): a hard time budget bounds the whole drain, each
// extractor call is capped by the remaining budget, and a per-subject circuit
// breaker pauses the drain after consecutive failures. Injection (R5-AR-003):
// the extractor is an explicit constructor parameter; tests and the proof
// inject the deterministic double, and a missing extractor is a silent no-op.

import { randomUUID } from 'node:crypto';

import { createMemoryModule } from './memory-module.js';

const DEFAULT_BATCH = 3;
const MAX_BATCH = 10;
const DEFAULT_TIME_BUDGET_MS = 2_000;
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 5 * 60_000;
const MAX_CANDIDATES_PER_EVENT = 3;

function auditEvent(state, context, action, details = {}) {
  const entry = {
    id: crypto.randomUUID(),
    tenantId: context.tenantId,
    subjectUserId: context.subjectUserId,
    actorId: context.actorId,
    action,
    details: { ...details, requestId: context.requestId || null },
    createdAt: new Date().toISOString()
  };
  state.auditEvents.unshift(entry);
  return entry;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MEMORY_EXTRACTION_TIMEOUT')), Math.max(1, ms));
    })
  ]).finally(() => clearTimeout(timer));
}

// Deterministic extractor: the test and proof authority. Emits one candidate
// for user messages that state a durable fact; the Module classifies
// sensitivity and decides promotion.
export function createDeterministicExtractor({ keywords = ['过敏', '记住', '不能吃', '不喜欢'] } = {}) {
  return async function extract(rawEvent) {
    const content = String(rawEvent.content || '');
    if (!keywords.some(keyword => content.includes(keyword))) return [];
    const fact = content.replace(/^请记住[:：]?/, '').trim();
    return [{
      content: fact,
      memoryType: 'fact',
      assertionType: 'observed_fact',
      scopeType: 'user'
    }];
  };
}

// Model-backed extractor: reuses the application model configuration and
// demands a fixed JSON schema. Malformed output is an extraction failure.
export function createModelExtractor(model) {
  return async function extract(rawEvent) {
    const prompt = [
      '从下面的用户消息中提取 0 到 3 条可长期保留的事实，只输出 JSON。',
      '格式: {"candidates":[{"content":"事实陈述","memoryType":"fact","assertionType":"observed_fact"}]}',
      '不要输出任何其他文字。',
      `用户消息: ${String(rawEvent.content || '').slice(0, 500)}`
    ].join('\n');
    const raw = await model.generate({ message: prompt });
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('MEMORY_EXTRACTION_MALFORMED_OUTPUT');
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error('MEMORY_EXTRACTION_MALFORMED_OUTPUT');
    }
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    return candidates
      .filter(item => item && typeof item.content === 'string' && item.content.trim())
      .slice(0, MAX_CANDIDATES_PER_EVENT)
      .map(item => ({
        content: item.content.trim(),
        memoryType: typeof item.memoryType === 'string' ? item.memoryType : 'fact',
        assertionType: item.assertionType === 'inferred_fact' ? 'inferred_fact' : 'observed_fact',
        scopeType: 'user'
      }));
  };
}

export function createMemoryExtractionDrain({
  pool,
  repository,
  extractor = null,
  context,
  moduleOptions = {},
  batch = DEFAULT_BATCH,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Memory extraction drain requires a pool');
  if (!repository || typeof repository.load !== 'function' || typeof repository.save !== 'function') {
    throw new TypeError('Memory extraction drain requires a repository');
  }
  const subjectKey = `cochpia:memory-extract:${context.tenantId}:${context.subjectUserId}`;
  const effectiveBatch = Math.max(1, Math.min(Number(batch) || DEFAULT_BATCH, MAX_BATCH));
  let consecutiveFailures = 0;
  let pausedUntil = 0;

  return async function drain(now = Date.now()) {
    if (!extractor) return { status: 'skipped', reason: 'no_extractor' };
    if (now < pausedUntil) return { status: 'paused', reason: 'circuit_breaker', pausedUntil };

    const started = Date.now();
    const remaining = () => timeBudgetMs - (Date.now() - started);
    const summary = { status: 'drained', extracted: 0, promoted: 0, pending: 0, skipped: 0, failed: 0 };

    const lockClient = await pool.connect();
    try {
      await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [subjectKey]);
      let state;
      try {
        state = await repository.load(context);
      } catch (error) {
        return { ...summary, status: 'failed', reason: 'load_failed' };
      }

      const extractedSourceIds = new Set(
        (state.assertionVersionSources || [])
          .filter(source => source.sourceType === 'raw_event')
          .map(source => source.sourceId)
      );
      const pendingEvents = (state.rawEvents || [])
        .filter(event => event.eventRole === 'user' && event.contentType === 'plain_text' && event.content)
        .filter(event => !extractedSourceIds.has(event.id))
        .sort((left, right) => Number(left.commitSeq || 0) - Number(right.commitSeq || 0)
          || String(left.occurredAt || '').localeCompare(String(right.occurredAt || '')))
        .slice(0, effectiveBatch);

      if (!pendingEvents.length) {
        return { ...summary, status: 'idle' };
      }

      const memory = createMemoryModule(state, () => repository.save(context, state), moduleOptions);

      for (const event of pendingEvents) {
        if (remaining() <= 0) break;
        try {
          const proposals = await withTimeout(extractor(event), remaining());
          for (const proposal of proposals.slice(0, MAX_CANDIDATES_PER_EVENT)) {
            const created = await memory.createCandidate(context, {
              sourceEventId: event.id,
              content: proposal.content,
              memoryType: proposal.memoryType || 'fact',
              assertionType: proposal.assertionType || 'observed_fact',
              scopeType: proposal.scopeType || 'user',
              ...(proposal.sensitivity ? { sensitivity: proposal.sensitivity } : {})
            });
            summary.extracted += 1;
            if (created.status === 'pending_confirmation') {
              summary.pending += 1;
            } else if (created.status === 'quarantined_current_state' || !created.memory) {
              summary.skipped += 1;
            } else {
              const promoted = await memory.promoteCandidate(context, created.memory.memoryId, {
                resourceRevision: created.memory.resourceRevision
              });
              if (promoted.status === 'active') summary.promoted += 1;
            }
          }
          consecutiveFailures = 0;
        } catch (error) {
          summary.failed += 1;
          consecutiveFailures += 1;
          auditEvent(memory.state, context, 'memory_extraction_failed', {
            sourceEventId: event.id,
            errorCode: error?.code || error?.message || 'MEMORY_EXTRACTION_FAILED'
          });
          try {
            await repository.save(context, memory.state);
          } catch {
            // The next drain retries the event; the audit loss is acceptable
            // against corrupting a canonical save.
          }
          if (consecutiveFailures >= FAILURE_THRESHOLD) {
            pausedUntil = Date.now() + COOLDOWN_MS;
          }
        }
      }
      return summary;
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [subjectKey]).catch(() => {});
      lockClient.release();
    }
  };
}
