import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostgresIndexCandidateQuery, mapPostgresIndexCandidate } from './memory-module-postgres-retrieval.js';

test('PostgreSQL lexical candidate query applies subject, lifecycle, epoch, and policy filters', () => {
  const query = buildPostgresIndexCandidateQuery({
    tenantId: 'tenant-a',
    subjectUserId: 'user-a',
    purpose: 'answer_user_query',
    query: '红茶',
    now: '2026-08-22T00:00:00.000Z',
    limit: 12
  });
  assert.equal(query.params[0], 'tenant-a');
  assert.equal(query.params[1], 'user-a');
  assert.equal(query.params.at(-1), 12);
  assert.match(query.sql, /JOIN memory_assertions/);
  assert.match(query.sql, /JOIN assertion_versions/);
  assert.match(query.sql, /redaction\.privacy_epoch/);
  assert.match(query.sql, /d\.policy_epoch/);
  assert.match(query.sql, /v\.version_status = 'current'/);
  assert.match(query.sql, /to_tsvector\('simple', d\.search_text\)/);
  assert.match(query.sql, /ILIKE/);
});

test('PostgreSQL vector candidate query hard-filters an Agent grant and uses pgvector distance', () => {
  const query = buildPostgresIndexCandidateQuery({
    tenantId: 'tenant-a',
    subjectUserId: 'user-a',
    actorType: 'agent',
    callerAgentId: 'agent-a',
    sessionId: 'session-a',
    purpose: 'profile_view',
    query: 'preference',
    queryVector: [1, 0],
    mode: 'vector'
  });
  assert.ok(query.params.includes('agent-a'));
  assert.ok(query.params.includes('[1,0]'));
  assert.match(query.sql, /scope_grants/);
  assert.match(query.sql, /permissions @> ARRAY/);
  assert.match(query.sql, /embedding_vector <=>/);
  assert.match(query.sql, /d\.embedding_vector IS NOT NULL/);
});

test('lexical candidate query narrows index_documents before joining payload tables', () => {
  const query = buildPostgresIndexCandidateQuery({
    tenantId: 'tenant-a',
    subjectUserId: 'user-a',
    purpose: 'answer_user_query',
    query: '红茶',
    now: '2026-08-22T00:00:00.000Z',
    limit: 12
  });
  assert.match(query.sql, /WITH narrowed AS/);
  const cte = query.sql.slice(query.sql.indexOf('WITH narrowed AS'), query.sql.indexOf('FROM narrowed'));
  assert.match(cte, /ORDER BY candidate_score DESC, d\.id ASC\s+LIMIT \$\d+/s);
  assert.match(cte, /to_tsvector\('simple', d\.search_text\)/);
  assert.match(cte, /redaction\.privacy_epoch/);
  // lifecycle filters stay outside the narrowing CTE
  assert.doesNotMatch(cte, /a\.status = 'active'/);
  assert.doesNotMatch(cte, /v\.version_status = 'current'/);
  assert.match(query.sql, /FROM narrowed\s+JOIN index_documents d ON d\.tenant_id = \$1 AND d\.id = narrowed\.id/s);
  // final limit stays the last bound parameter; prefetch depth precedes it
  assert.equal(query.params.at(-1), 12);
  assert.equal(query.params.at(-2), 24);
  assert.equal(query.limit, 12);
});

test('prefetch limit is parameterizable and clamped to the 2x default when below the final limit', () => {
  const base = { tenantId: 'tenant-a', subjectUserId: 'user-a', purpose: 'answer_user_query', query: '红茶' };
  const custom = buildPostgresIndexCandidateQuery({ ...base, limit: 50, narrowLimit: 200 });
  assert.equal(custom.params.at(-2), 200);
  const clamped = buildPostgresIndexCandidateQuery({ ...base, limit: 50, narrowLimit: 20 });
  assert.equal(clamped.params.at(-2), 100);
  const capped = buildPostgresIndexCandidateQuery({ ...base, limit: 50, narrowLimit: 100_000 });
  assert.equal(capped.params.at(-2), 1000);
});

test('vector candidate query narrows by distance inside the CTE and reorders identically outside', () => {
  const query = buildPostgresIndexCandidateQuery({
    tenantId: 'tenant-a',
    subjectUserId: 'user-a',
    purpose: 'answer_user_query',
    query: 'preference',
    queryVector: [1, 0],
    mode: 'vector',
    limit: 10
  });
  const cte = query.sql.slice(query.sql.indexOf('WITH narrowed AS'), query.sql.indexOf('FROM narrowed'));
  assert.match(cte, /d\.embedding_vector IS NOT NULL/);
  assert.match(cte, /ORDER BY d\.embedding_vector <=> \$\d+::vector ASC, d\.id ASC\s+LIMIT \$\d+/s);
  assert.match(query.sql, /ORDER BY d\.embedding_vector <=> \$\d+::vector ASC, d\.id ASC\s+LIMIT \$\d+\s*$/s);
  assert.equal(query.params.at(-1), 10);
  assert.equal(query.params.at(-2), 20);
});

test('native candidate rows preserve assertion and version evidence', () => {
  const item = mapPostgresIndexCandidate({
    document_id: 'doc-a',
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    memory_id: 'memory-a',
    version_id: 'version-a',
    source_refs: ['event-a'],
    scope_type: 'user',
    assertion_status: 'active',
    memory_type: 'preference',
    assertion_type: 'observed_fact',
    canonical_key: 'drink',
    subject_type: 'user',
    subject_id: 'user-a',
    sensitivity: 'S0',
    confidence: '0.9',
    importance: '0.5',
    mention_policy: 'mentionable',
    direct_query_policy: 'allow',
    resource_revision: '2',
    content: '喜欢红茶',
    structured_data: { value: 'tea' },
    content_type: 'plain_text',
    trust_level: 'user_explicit',
    version_status: 'current',
    candidate_score: '0.8'
  });
  assert.equal(item.memoryId, 'memory-a');
  assert.equal(item.score, 0.8);
  assert.equal(item.assertion.confidence, 0.9);
  assert.equal(item.version.content, '喜欢红茶');
  assert.deepEqual(item.sourceRefs, ['event-a']);
});
