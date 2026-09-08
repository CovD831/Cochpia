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
import { cosineSimilarity } from './memory-module-retrieval.js';

const DEFAULT_BATCH = 3;
const MAX_BATCH = 10;
const DEFAULT_TIME_BUDGET_MS = 2_000;
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 5 * 60_000;
const MAX_CANDIDATES_PER_EVENT = 3;
const AUDN_SIMILAR_LIMIT = 5;
const DEFAULT_AUDN_SIMILAR_MIN_SCORE = 0.6;

// Threshold parsing that survives "0" (meaning: disabled) unlike `||`.
const parseThreshold = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

// Cheap dedup gate (R-007a): normalize away case, whitespace and punctuation,
// then hash. CJK needs no stemming; this catches restated duplicates.
const normalizeForHash = value => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const hashContent = value => createHash('md5').update(normalizeForHash(value)).digest('hex');

// R-011 semantic topic key: the model names the *topic* of a fact
// (allergy_peanut, favorite_fruit) so restatements and value changes share one
// canonical_key and arbitration can group them. Same topic across different
// phrasings is what makes latest-wins meaningful at fact granularity.
const normalizeSemanticKey = value => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 80);

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
// R-011: every candidate carries a fact-level semantic key (topic identity)
// so canonical_key grouping stops collapsing all facts onto one key, and
// health/finance facts about the user themself are explicitly in scope -
// the R-010 probe showed the model sporadically refuses those (returns
// {"candidates":[]}) when the prompt leaves their memorability ambiguous.
export function createModelExtractor(model, { contextTurns = 0 } = {}) {
  return async function extract(rawEvent) {
    // R-014: anaphoric updates ("现在涂的是蓝色的") carry no stable fact
    // without their antecedent. When enabled and the event carries a
    // turn-time context snapshot, let the model see it for reference ONLY -
    // candidates still come from the message itself.
    const snapshot = contextTurns > 0
      ? (Array.isArray(rawEvent?.metadata?.context_snapshot) ? rawEvent.metadata.context_snapshot : []).slice(-contextTurns).filter(line => typeof line === 'string' && line.trim())
      : [];
    const prompt = [
      '从下面的用户消息中提取 0 到 3 条值得长期记住的稳定事实，只输出 JSON。',
      '值得记住：身份、长期偏好、健康与用药、财务与证件、重要关系、关键经历。用户本人的健康/财务/证件信息属于用户自己的记忆，系统有分级治理流程保护，必须正常提取，不要因话题敏感而返回空。',
      '忽略：闲聊、天气、一次性事件、即时情绪、寒暄——这类消息返回 {"candidates":[]}。',
      '每条候选附 key：事实所属主题的简短语义标识，小写下划线（如 allergy_peanut、favorite_fruit、home_city、medication_warfarin）。同一主题不同说法、不同取值必须用同一个 key；不同主题不要共用 key。',
      '格式: {"candidates":[{"content":"事实陈述","key":"主题语义键","memoryType":"fact","assertionType":"observed_fact"}]}',
      '示例输入「我对花生过敏」→ {"candidates":[{"content":"用户对花生过敏","key":"allergy_peanut","memoryType":"fact","assertionType":"observed_fact"}]}',
      '示例输入「我最近确诊了中度抑郁，在服药」→ {"candidates":[{"content":"用户确诊中度抑郁，正在服药","key":"health_depression","memoryType":"fact","assertionType":"observed_fact"}]}',
      '示例输入「今天天气真不错啊」→ {"candidates":[]}',
      ...(snapshot.length ? ['对话上下文（仅用于理解指代和省略，不要从中提取事实）：', ...snapshot] : []),
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
      .map(item => {
        const key = normalizeSemanticKey(item.key);
        return {
          content: item.content.trim(),
          ...(key ? { key } : {}),
          memoryType: typeof item.memoryType === 'string' ? item.memoryType : 'fact',
          assertionType: item.assertionType === 'inferred_fact' ? 'inferred_fact' : 'observed_fact',
          scopeType: 'user'
        };
      });
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
      '规则：NOOP=无长期价值，或与某条已有记忆语义相同——仅措辞不同也算重复，不要因为说法更新就 ADD；ADD=与已有记忆都不相关的全新事实；UPDATE=修正/补充编号指向的已有记忆，同一事实发生变化时优先 UPDATE 而不是 ADD；DELETE=新候选表明该已有记忆作废。',
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
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  audnSimilarMinScore = parseThreshold(process.env.MEMORY_AUDN_SIMILAR_MIN_SCORE, DEFAULT_AUDN_SIMILAR_MIN_SCORE)
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Memory extraction drain requires a pool');
  if (!repository || typeof repository.load !== 'function' || typeof repository.save !== 'function') {
    throw new TypeError('Memory extraction drain requires a repository');
  }
  const subjectKey = `cochpia:memory-extract:${context.tenantId}:${context.subjectUserId}`;
  const effectiveBatch = Math.max(1, Math.min(Number(batch) || DEFAULT_BATCH, MAX_BATCH));
  let consecutiveFailures = 0;
  let pausedUntil = 0;
  // R-011 deadlock guard: the drain holds one pool connection for the whole
  // body (the advisory-lock session) and its saves need additional connections
  // from the same pool. Let enough drain invocations queue up - the
  // fire-and-forget drain plus explicit callers make that routine - and the
  // pool saturates with lock-session clients while the in-lock drain waits
  // forever for a save connection. Serializing invocations in-process keeps at
  // most one lock session alive per subject; the advisory lock still protects
  // against cross-process overlap.
  let drainChain = Promise.resolve({});

  return async function drain(now = Date.now()) {
    if (!extractor) return { status: 'skipped', reason: 'no_extractor' };
    if (now < pausedUntil) return { status: 'paused', reason: 'circuit_breaker', pausedUntil };
    const result = drainChain.then(() => runDrain(now), () => runDrain(now));
    drainChain = result.then(() => {}, () => {});
    return result;
  };

  async function runDrain(now) {
    const started = Date.now();
    const remaining = () => timeBudgetMs - (Date.now() - started);
    const summary = { status: 'drained', extracted: 0, promoted: 0, pending: 0, skipped: 0, updated: 0, noop: 0, failed: 0, exhausted: 0 };

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
      // R-011 drain-liveness fix: an event whose extraction completed without
      // producing a version (zero candidates, all-deduped, NOOP or UPDATE-only)
      // has no source row, so the source-based exclusion above never matched it.
      // Those events stayed pending forever, occupied the head of every batch,
      // and starved every later event - chit-chat alone blocked the whole queue
      // while still being re-sent to the model on each drain. Exhaustion is
      // recorded as an audit event (round-trips through the repository without
      // a schema change) and excluded from future batches.
      const exhaustedEventIds = new Set((state.auditEvents || [])
        .filter(entry => entry.action === 'memory_extraction_exhausted')
        .map(entry => entry.details?.sourceEventId)
        .filter(Boolean));
      const pendingEvents = (state.rawEvents || [])
        .filter(event => event.eventRole === 'user' && event.contentType === 'plain_text' && event.content)
        .filter(event => !extractedSourceIds.has(event.id) && !exhaustedEventIds.has(event.id))
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

      // R-011: AUDN similar lookup goes through the embedding gateway with a
      // cosine floor instead of the old lexical retrieve. bge-m3 calibration
      // (probes/r011-cosine-probe.json): unrelated fact pairs score <= 0.575,
      // same-topic value changes >= 0.664, restatements >= 0.908. The 0.6
      // floor sits in that gap, so the auditor only ever sees memories that
      // genuinely compete with the candidate (Mem0-aligned: below threshold
      // is eliminated outright). No lexical fallback - the fallback IS the
      // defect it replaces (any CJK bigram overlap used to qualify).
      const findSimilar = async proposal => {
        if (typeof embeddingGateway !== 'function') return [];
        try {
          const docs = (state.assertions || [])
            .filter(assertion => assertion.status === 'active'
              && assertion.tenantId === context.tenantId
              && assertion.userId === context.subjectUserId)
            .map(assertion => {
              const version = (state.assertionVersions || []).find(entry => entry.id === assertion.currentVersionId);
              const indexDocument = (state.indexDocuments || []).find(entry => entry.sourceId === assertion.id
                && entry.indexStatus === 'active'
                && Array.isArray(entry.embedding));
              return version && indexDocument
                ? {
                  id: assertion.id,
                  embedding: indexDocument.embedding,
                  content: version.content,
                  resourceRevision: assertion.resourceRevision,
                  // R-009: give the auditor the bi-temporal context so it can
                  // reason about "what was true when" before choosing UPDATE.
                  validFrom: version.validFrom || null,
                  validTo: version.validTo || null,
                  observedAt: version.observedAt || null
                }
                : null;
            })
            .filter(Boolean);
          if (!docs.length) return [];
          const vector = await withTimeout(
            embeddingGateway(proposal.content),
            Math.max(200, Math.min(remaining(), 10_000))
          );
          if (!Array.isArray(vector) || !vector.length) return [];
          return docs
            .map(doc => ({ ...doc, similarity: cosineSimilarity(vector, doc.embedding) }))
            .filter(doc => doc.similarity >= audnSimilarMinScore)
            .sort((left, right) => right.similarity - left.similarity)
            .slice(0, AUDN_SIMILAR_LIMIT)
            .map(doc => ({
              id: doc.id,
              content: doc.content,
              resourceRevision: doc.resourceRevision,
              validFrom: doc.validFrom,
              validTo: doc.validTo,
              observedAt: doc.observedAt
            }));
        } catch {
          // Embedding unavailable: no similar memories rather than junk -
          // the candidate degrades to ADD, which never loses a stated fact.
          return [];
        }
      };

      // R-011 (run-4 finding): index documents were only ever mutated in the
      // drain's in-memory state - nothing saved them afterwards, so embeddings
      // never reached the repository (the frozen eval database showed an empty
      // index_documents table). Hybrid retrieval and the AUDN similar lookup
      // were silently running lexical-only. Any successful (re)index marks the
      // drain dirty; the drain persists once at the end.
      let indexStateDirty = false;
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
            // The column is NOT NULL (schema parity with the index rebuild).
            // 'null' here aborted every save that carried an index document.
            lexicalVersion: 'bm25-v1',
            indexStatus: 'active',
            sourceRefs: [],
            createdAt: new Date().toISOString()
          });
          indexStateDirty = true;
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
          // R-013: S2 classification also sees the raw message - the extractor
          // routinely drops the trigger word when rephrasing ("我家里矛盾挺
          // 严重" became a candidate with no trigger vocabulary).
          sourceContent: event.content,
          // R-011: the fact-level semantic topic key from the extractor.
          // createCandidate passes it through to makeAssertion, where it
          // becomes the canonical_key; a missing key falls back to a content
          // fingerprint there.
          ...(proposal.key ? { key: proposal.key } : {}),
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
              similar = await findSimilar(proposal);
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
                reason: decision.reason || '',
                similarCount: similar.length,
                similarMinScore: audnSimilarMinScore
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
          // R-011: the event completed extraction without an exception. If it
          // still has no source row (zero candidates, all deduped, NOOP- or
          // UPDATE-only), record its exhaustion so later drains stop re-sending
          // it to the model and stop letting it clog the batch head.
          if (!state.assertionVersionSources.some(source => source.sourceType === 'raw_event' && source.sourceId === event.id)) {
            auditEvent(memory.state, context, 'memory_extraction_exhausted', { sourceEventId: event.id });
            summary.exhausted += 1;
          }
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
      // Persist drain-local state mutations that no Module mutation saved:
      // exhaustion markers (audit-only) and index documents. Without this,
      // zero-yield drains re-sent dead events forever and embeddings never
      // reached the repository at all.
      if (summary.exhausted > 0 || indexStateDirty) {
        try {
          await repository.save(context, memory.state);
        } catch {
          // Lost markers/index docs mean reprocessed events or a lexical-only
          // corpus next drain; correctness is unaffected and the audit loss is
          // acceptable against corrupting a canonical save.
        }
      }
      return summary;
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [subjectKey]).catch(() => {});
      lockClient.release();
    }
  }
}
