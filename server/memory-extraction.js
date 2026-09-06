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

import { randomUUID, createHash } from 'node:crypto';

import { createMemoryModule } from './memory-module.js';

const DEFAULT_BATCH = 3;
const MAX_BATCH = 10;
const DEFAULT_TIME_BUDGET_MS = 2_000;
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 5 * 60_000;
const MAX_CANDIDATES_PER_EVENT = 3;
const AUDN_SIMILAR_LIMIT = 5;

// Cheap dedup gate (R-007a): normalize away case, whitespace and punctuation,
// then hash. CJK needs no stemming; this catches restated duplicates.
const normalizeForHash = value => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const hashContent = value => createHash('md5').update(normalizeForHash(value)).digest('hex');

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
// R-007a: only durable facts are worth remembering - chit-chat, weather,
// one-off events and transient emotions produce zero candidates.
export function createModelExtractor(model) {
  return async function extract(rawEvent) {
    const prompt = [
      '从下面的用户消息中提取 0 到 3 条值得长期记住的稳定事实，只输出 JSON。',
      '值得记住：身份、长期偏好、健康、重要关系、关键经历。',
      '忽略：闲聊、天气、一次性事件、即时情绪、寒暄——这类消息返回 {"candidates":[]}。',
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

// AUDN decision maker (R-007a, after Mem0's write-time arbitration): given a
// candidate and the numbered similar memories, choose ADD / UPDATE / DELETE /
// NOOP. Malformed output degrades to ADD so a stated fact is never lost.
export function createModelAuditor(model) {
  return async function audit(proposal, similarMemories) {
    if (!similarMemories.length) return { decision: 'ADD' };
    const listing = similarMemories
      .map((item, index) => `${index}: ${item.content}`)
      .join('\n');
    const prompt = [
      '新候选事实需要决定如何并入已有记忆，只输出 JSON。',
      '已有记忆（编号）：',
      listing,
      `新候选事实：${proposal.content}`,
      '规则：NOOP=无长期价值或完全重复；ADD=全新事实；UPDATE=修正/补充编号指向的已有记忆；DELETE=新候选表明该已有记忆作废。',
      '格式: {"decision":"ADD|UPDATE|DELETE|NOOP","target":<编号或null>,"reason":"一句话"}'
    ].join('\n');
    const raw = await model.generate({ message: prompt });
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('MEMORY_AUDIT_MALFORMED_OUTPUT');
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error('MEMORY_AUDIT_MALFORMED_OUTPUT');
    }
    const decision = ['ADD', 'UPDATE', 'DELETE', 'NOOP'].includes(parsed?.decision) ? parsed.decision : 'ADD';
    const target = Number.isInteger(parsed?.target) ? parsed.target : null;
    if ((decision === 'UPDATE' || decision === 'DELETE') && (target === null || !similarMemories[target])) {
      return { decision: 'ADD' };
    }
    return { decision, target, reason: typeof parsed?.reason === 'string' ? parsed.reason : '' };
  };
}

export function createMemoryExtractionDrain({
  pool,
  repository,
  extractor = null,
  auditor = null,
  embeddingGateway = null,
  embeddingModel = 'bge-m3',
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
    const summary = { status: 'drained', extracted: 0, promoted: 0, pending: 0, skipped: 0, updated: 0, noop: 0, failed: 0 };

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

      // Dedup gate seeds: every active assertion's current content hash.
      const seenHashes = new Set();
      for (const assertion of state.assertions.filter(item => item.status === 'active')) {
        const version = (state.assertionVersions || []).find(item => item.id === assertion.currentVersionId);
        if (version?.content) seenHashes.add(hashContent(version.content));
      }

      const findSimilar = proposal => {
        try {
          const retrieved = memory.retrieve(context, { query: proposal.content, purpose: 'answer_user_query' });
          return (retrieved.items || []).slice(0, AUDN_SIMILAR_LIMIT).map(item => {
            const assertion = (state.assertions || []).find(entry => entry.id === (item.memoryId || item.id));
            const version = assertion
              ? (state.assertionVersions || []).find(entry => entry.id === assertion.currentVersionId)
              : null;
            return assertion && version
              ? {
                id: assertion.id,
                content: version.content,
                resourceRevision: assertion.resourceRevision,
                // R-009: give the auditor the bi-temporal context so it can
                // reason about "what was true when" before choosing UPDATE.
                validFrom: version.validFrom || null,
                validTo: version.validTo || null,
                observedAt: version.observedAt || null
              }
              : null;
          }).filter(Boolean);
        } catch {
          return [];
        }
      };

      const indexAssertionForRetrieval = async (assertion, content) => {
        // R-007c/R-009: index (or re-index after a correction) the active
        // assertion for semantic retrieval. An embedding failure never blocks
        // activation - BM25 still covers the assertion and the audit trail
        // records the gap.
        if (typeof embeddingGateway !== 'function') return;
        try {
          const vector = await withTimeout(
            embeddingGateway(content),
            Math.max(200, Math.min(remaining(), 10_000))
          );
          if (!Array.isArray(vector)) return;
          state.indexDocuments = state.indexDocuments.filter(doc => doc.sourceId !== assertion.id);
          state.indexDocuments.push({
            id: `idx:${randomUUID()}`,
            tenantId: context.tenantId,
            sourceType: 'assertion',
            sourceId: assertion.id,
            sourceVersion: assertion.currentVersionId,
            userId: context.subjectUserId,
            scopeType: assertion.scopeType,
            relationshipAgentId: assertion.relationshipAgentId || null,
            sessionId: assertion.sessionId || null,
            searchText: content,
            sensitivity: assertion.sensitivity,
            contextualizable: true,
            mentionable: true,
            redactionEpoch: 0,
            policyEpoch: 0,
            grantVersion: 0,
            embedding: vector,
            embeddingVersion: embeddingModel,
            lexicalVersion: null,
            indexStatus: 'active',
            sourceRefs: [],
            createdAt: new Date().toISOString()
          });
        } catch (error) {
          auditEvent(memory.state, context, 'memory_embedding_failed', {
            memoryId: assertion.id,
            errorCode: error?.message || 'MEMORY_EMBEDDING_FAILED'
          });
        }
      };

      const addCandidate = async (event, proposal) => {
        const created = await memory.createCandidate(context, {
          sourceEventId: event.id,
          content: proposal.content,
          memoryType: proposal.memoryType || 'fact',
          assertionType: proposal.assertionType || 'observed_fact',
          scopeType: proposal.scopeType || 'user',
          // R-009 bi-temporal wiring: the fact is valid from the moment the
          // user stated it (the raw event's occurrence time).
          observedAt: event.occurredAt,
          validFrom: event.occurredAt,
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
          if (promoted.status === 'active') {
            summary.promoted += 1;
            const assertion = state.assertions.find(item => item.id === created.memory.memoryId);
            if (assertion) await indexAssertionForRetrieval(assertion, promoted.memory.content || proposal.content);
          }
        }
        seenHashes.add(hashContent(proposal.content));
      };

      for (const event of pendingEvents) {
        if (remaining() <= 0) break;
        try {
          const proposals = await withTimeout(extractor(event), remaining());
          for (const proposal of proposals.slice(0, MAX_CANDIDATES_PER_EVENT)) {
            // Dedup gate: exact restatement of an existing or in-batch fact.
            const contentHash = hashContent(proposal.content);
            if (seenHashes.has(contentHash)) {
              summary.skipped += 1;
              continue;
            }

            // AUDN write-time arbitration against similar active memories.
            let similar = [];
            if (auditor) {
              similar = findSimilar(proposal);
              let decision;
              try {
                decision = await withTimeout(auditor(proposal, similar), remaining());
              } catch (error) {
                // Degrade to ADD: a stated fact is never lost to an audit
                // failure. The reason is still auditable.
                auditEvent(memory.state, context, 'memory_audn_failed', {
                  sourceEventId: event.id,
                  errorCode: error?.code || error?.message || 'MEMORY_AUDIT_FAILED'
                });
                decision = { decision: 'ADD' };
              }
              auditEvent(memory.state, context, 'memory_audn', {
                sourceEventId: event.id,
                decision: decision.decision,
                target: decision.target ?? null,
                reason: decision.reason || ''
              });
              if (decision.decision === 'NOOP') {
                summary.noop += 1;
                continue;
              }
              if (decision.decision === 'UPDATE') {
                const target = similar[decision.target];
                await memory.correct(context, target.id, {
                  content: proposal.content,
                  resourceRevision: target.resourceRevision,
                  // R-009: the restatement closes the superseded version's
                  // interval and starts the new one at this occurrence.
                  observedAt: event.occurredAt,
                  validFrom: event.occurredAt
                });
                summary.updated += 1;
                seenHashes.add(contentHash);
                // The correction drops the old index document inside the
                // Module; re-index the corrected assertion for semantic
                // retrieval.
                const correctedAssertion = state.assertions.find(item => item.id === target.id);
                if (correctedAssertion) await indexAssertionForRetrieval(correctedAssertion, proposal.content);
                continue;
              }
              if (decision.decision === 'DELETE') {
                const target = similar[decision.target];
                await memory.forget(context, target.id, {
                  resourceRevision: target.resourceRevision
                });
                // Fall through to ADD: "I no longer X" usually carries a new
                // fact that replaces the forgotten one.
              }
            }

            await addCandidate(event, proposal);
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
