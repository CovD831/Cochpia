import test from 'node:test';
import assert from 'node:assert/strict';
import { bm25Search, detectConflicts, hybridSearch, reciprocalRankFusion, stemmingEnabled, tokenize, vectorSearch } from './memory-module-retrieval.js';

test('tokenizer supports CJK bigrams and mixed English identifiers', () => {
  const tokens = tokenize('喜欢红茶 with OpenAI-Key');
  assert.ok(tokens.includes('红茶'));
  assert.ok(tokens.includes('红'));
  assert.ok(tokens.includes('openai_key'));
});

test('BM25 ranks exact lexical evidence above unrelated documents', () => {
  const results = bm25Search([
    { id: 'tea', text: '我喜欢红茶和乌龙茶' },
    { id: 'music', text: '最近在听爵士乐' },
    { id: 'tea-weak', text: '茶' }
  ], '红茶', { limit: 5 });
  assert.equal(results[0].id, 'tea');
  assert.equal(results.some(item => item.id === 'music'), false);
});

test('RRF fuses lexical and vector rankings without summing incomparable raw scores', () => {
  const results = reciprocalRankFusion([
    [{ id: 'a', lexical: 100 }, { id: 'b', lexical: 1 }],
    [{ id: 'b', vector: 0.99 }, { id: 'c', vector: 0.98 }]
  ]);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].score < 1, true);
});

test('conflict detection groups different values under the same canonical key', () => {
  const conflicts = detectConflicts([
    { canonicalKey: 'user:drink', content: '喜欢红茶' },
    { canonicalKey: 'user:drink', content: '喜欢咖啡' },
    { canonicalKey: 'user:color', content: '蓝色' }
  ]);
  assert.deepEqual(conflicts, [{ canonicalKey: 'user:drink', values: ['喜欢红茶', '喜欢咖啡'] }]);
});

test('vector timeout falls back to BM25 and hybrid mode uses RRF when embeddings are available', async () => {
  const documents = [
    { id: 'a', text: '红茶', embedding: [1, 0] },
    { id: 'b', text: '咖啡', embedding: [0, 1] }
  ];
  const fallback = await hybridSearch(documents, '红茶', { embed: async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); } });
  assert.equal(fallback.mode, 'bm25_embedding_timeout');
  assert.equal(fallback.items[0].id, 'a');
  const vector = await vectorSearch(documents, 'query', async () => [0, 1]);
  assert.equal(vector.mode, 'vector');
  assert.equal(vector.items[0].id, 'b');
  const hybrid = await hybridSearch(documents, '红茶', { embed: async () => [0, 1] });
  assert.equal(hybrid.mode, 'hybrid_rrf');
});

// 词干归一化（2026-09-17）。开关 `MEMORY_TOKENIZER_STEM` **默认关**（老板裁决：
// 检索收益经双口径三态对照判定不显著，故不改变默认行为）；机制代码与其词法规则入库，
// 为「重开此议题」保留现成的实验入口与测试守卫。
//
// 因为 stemmingEnabled() 每次调用读 env（不做模块级缓存），这些测试可以在
// **同一进程内**切换开关，从而把「关=旧行为 / 开=新行为」都钉住。
// 这比只测一侧强：只测开态的话，默认值被误改回「开」不会有任何测试报警。
const withStemming = (value, fn) => {
  const previous = process.env.MEMORY_TOKENIZER_STEM;
  if (value === null) delete process.env.MEMORY_TOKENIZER_STEM;
  else process.env.MEMORY_TOKENIZER_STEM = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.MEMORY_TOKENIZER_STEM;
    else process.env.MEMORY_TOKENIZER_STEM = previous;
  }
};

test('stemming is OFF by default, so existing callers see unchanged tokens', () => {
  // 默认行为守卫：不设 env 时 tokenize 必须与词干化之前完全一致。
  // 若有人把默认值改回「开」，这条会红。
  withStemming(null, () => {
    assert.equal(stemmingEnabled(), false);
    assert.deepEqual(tokenize('houses'), ['houses']);
    assert.deepEqual(tokenize('research'), ['research']);
    assert.deepEqual(tokenize('Researching'), ['researching']);
  });
});

test('stemming unifies inflected forms so "research" matches "researching"', () => {
  withStemming('1', () => {
    // 核心收益：查询 research 与原文 Researching 落到同一个 token（多跳召回依赖它）。
    assert.deepEqual(tokenize('research'), tokenize('Researching'));
    // 复数/进行时/过去式归并
    assert.deepEqual(tokenize('houses'), tokenize('house'));
    assert.deepEqual(tokenize('notes'), tokenize('note'));
    assert.deepEqual(tokenize('times'), tokenize('time'));
    assert.deepEqual(tokenize('cases'), tokenize('case'));
    assert.deepEqual(tokenize('studies'), tokenize('study'));
  });
});

test('stemming does not over-merge: -es only stripped after sibilant stems', () => {
  withStemming('1', () => {
    // 旧规则对一切 -es 结尾的长词砍 2 字符，产出 hous/not/tim/dat/statu/analysi/cas。
    // 条件化后只有 ss/x/z/ch/sh + es 才砍 2；其余走 -s 砍 1。
    assert.deepEqual(tokenize('boxes'), tokenize('box'));
    assert.deepEqual(tokenize('churches'), tokenize('church'));
    assert.deepEqual(tokenize('dishes'), tokenize('dish'));
    assert.deepEqual(tokenize('glasses'), tokenize('glass'));
    // 这些词不参与 -es 归并，不应被砍成残词。
    assert.equal(tokenize('universal')[0], 'universal');
    assert.equal(tokenize('universe')[0], 'universe');
    // -es 条件化不得把 notes 砍成 not（撞上真词）、houses 砍成 hous（与 house 裂开）。
    assert.notEqual(tokenize('notes')[0], 'not');
    assert.notEqual(tokenize('houses')[0], 'hous');
  });
});

test('stemming switch honours only explicit truthy values', () => {
  for (const value of ['1', 'true', 'on', 'yes', 'TRUE']) {
    withStemming(value, () => assert.equal(stemmingEnabled(), true, `"${value}" should enable`));
  }
  for (const value of ['0', 'false', 'off', 'no', '', 'maybe']) {
    withStemming(value, () => assert.equal(stemmingEnabled(), false, `"${value}" should not enable`));
  }
});
