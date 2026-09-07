// Phase 3b: bulk synthetic corpus depth measurement.
// Builds a seeded corpus (needles + distractors) through the real module API,
// indexes it with real bge-m3 embeddings, and measures retrieval precision,
// needle ranks, noise recall and latency at growing store depths.
// Deterministic: same seed -> same corpus -> comparable across code changes.
import 'dotenv/config';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { createOllamaEmbeddingGateway } from '../../server/memory-embedding.js';
import { createMemoryModule } from '../../server/memory-module.js';
import { prepareCoreV0ProductionSchema, resetCoreV0ProductionSchemaCache } from '../../server/core-v0-production.js';
import { createMemoryModulePostgresRepository } from '../../server/memory-module-postgres.js';

const DB_NAME = 'cochpia_bulk_eval';
const CONNECTION = `postgresql://localhost:5432/${DB_NAME}`;
const CONTEXT = { tenantId: 'bulk', subjectUserId: 'bulk-user', actorType: 'user', actorId: 'bulk-user', callerAgentId: 'cochpia', correlationId: 'bulk' };
const SIZES = [500, 1000, 2000];
const NEEDLE_COUNT = 100;
const NEEDLE_QUERIES = 60;
const NOISE_QUERIES = 20;
const SEED = 20260907;
const EMBED_CONCURRENCY = 2;
const EMBED_RETRIES = 3;

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = arr => arr[Math.floor(rand() * arr.length)];

// ---- corpus material ------------------------------------------------------
const needleObjects = Array.from({ length: NEEDLE_COUNT }, (_, i) => `针尖${String(i + 1).padStart(4, '0')}`);
const needleContent = obj => `用户对${obj}严格过敏，接触后需要立即就医。`;
const needleQuery = obj => `我对${obj}过敏是不是要特别小心`;

const likeItems = ['雨天读书', '深夜写代码', '老式黑胶唱片', '清晨的长跑', '手冲咖啡', '逛旧书店', '拼装模型', '看纪录片', '收集地图', '煮浓汤', '周末爬山', '写毛笔字', '整理书架', '听爵士乐', '拍街头照片', '研究菜谱', '下围棋', '擦皮鞋', '逛菜市场', '擦镜头'];
const planItems = ['换一份新工作', '学一门乐器', '搬去更安静的小区', '考一个证书', '开始晨跑', '减少加班', '学会游泳', '装修书房', '戒烟', '办健身卡', '去西北旅行', '养一只猫', '学会烘焙', '重新学英语', '写完那篇文档'];
const experienceItems = ['去年去云南旅行', '上个月换了新手机', '小时候学过画画', '大学读的是机械专业', '前年搬过一次家', '上周参加了同学婚礼', '以前在公司做过前台', '读书时拿过作文奖', '小时候在乡下住过', '去年考过了驾照'];
const peopleItems = ['表哥在深圳开餐厅', '发小在成都教书', '邻居是位退休教师', '室友在准备考研', '叔叔经营一家书店', '表妹在学护理'];
const habitItems = ['睡前刷四十分钟短视频', '每周网购两次', '午饭固定吃轻食', '开会时习惯记手写笔记', '通勤路上听播客', '睡觉必须留一盏小夜灯'];
const dislikeItems = ['香菜的味道', '过度甜的奶茶', '嘈杂的酒吧', '没完没了的加班', '堵车的早高峰'];

// Deterministic cartesian filler: frames x nouns x details guarantees 2000+
// unique contents without a retry loop (the previous pick()-and-dedup generator
// had a combination space of ~340 and looped forever at 1900 distractors).
const fillerFrames = ['最近迷上了', '顺手入手了', '研究了好一阵', '偶尔折腾一下'];
const fillerNouns = ['多肉植物', '机械键盘', '胶片相机', '手账本', '碳素鱼竿', '烤瓷杯', '蓝牙音箱', '全景相机', '电动螺丝刀', '入门显微镜', '露营帐篷', '天文望远镜', '黑胶唱机', '电子墨水屏', '潜水表', '卡式炉', '折叠露营椅', '水草鱼缸', '香薰机', '家用跑步机', '筋膜枪', '咖啡磨豆机', '数位绘图板', '编曲键盘', '训练用足球', '碳纤维羽毛球拍', '云子围棋盘', '静态模型飞机', '建筑积木', '一千片拼图', '四阶魔方', '半音阶口琴', '入门古筝', '考古盲盒', '种子收纳盒', '台式烤箱', '空气炸锅', '破壁机', '挂耳咖啡礼盒', '骑行水壶'];
const fillerDetails = ['周末研究了半天参数', '朋友推荐之后才下手的', '用了一段时间感觉不错', '还是老款更顺手', '买之前对比了很多评测', '收藏了一堆教程慢慢看', '准备安利给同事', '花了挺长时间挑选', '后来发现用得不算多', '成了生活里的小乐趣', '拆快递的时候还挺激动', '摆放位置换了三次', '说明书翻了好几遍', '配件又补了一轮', '群里晒图被点赞了', '闲置了一阵又捡起来了', '给生活加了一点仪式感', '琢磨出不少新玩法', '邻居看了也想入一个', '比想象中更实用'];

const distractorContent = index => {
  const frame = fillerFrames[index % fillerFrames.length];
  const noun = fillerNouns[Math.floor(index / fillerFrames.length) % fillerNouns.length];
  const detail = fillerDetails[Math.floor(index / (fillerFrames.length * fillerNouns.length)) % fillerDetails.length];
  return `用户${frame}${noun}，${detail}。`;
};


const noiseQueryTemplates = [
  '今天空气好不好', '帮我查个快递', '彩票中奖号码', '怎么烫头发好看', '附近有加油站吗',
  '明天会下雨吗', '热搜榜有什么', '宇宙有多大', '怎么给平板消毒', '地球离月亮多远',
  '推荐个旅游地方', '怎么煮溏心蛋', '键盘怎么清洁', '股票开户流程', '怎么报考驾校',
  '化妆品怎么选', '股票和基金区别', '帮我翻译个单词', '怎么瘦肚子', '今晚有什么比赛',
];

const main = async () => {
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME}`]);
  const pool = new pg.Pool({ connectionString: CONNECTION });
  resetCoreV0ProductionSchemaCache();
  console.log('schema prep start', new Date().toISOString());
  await prepareCoreV0ProductionSchema(pool, { production: false, autoMigrate: true });
  console.log('schema ready', new Date().toISOString());
  const repository = createMemoryModulePostgresRepository(pool, { pgvector: false });
  const gateway = createOllamaEmbeddingGateway({ url: process.env.MEMORY_EMBEDDING_URL, model: process.env.MEMORY_EMBEDDING_MODEL || 'bge-m3' });

  console.log('load start', new Date().toISOString());
  let state = await repository.load(CONTEXT);
  console.log('load done', new Date().toISOString());
    // Production-parity retrieval options: the precision floor and hybrid flag
  // are part of what we are measuring at depth - without them the raw channel
  // recalls ~40 items per query and tells us nothing about production.
  const memory = createMemoryModule(state, async () => {}, {
    projectionEnabled: false,
    featureFlags: { hybridRetrieval: true, conflictLatestWins: true },
    embeddingGateway: gateway,
    embeddingTimeoutMs: 2000,
    vectorMinScore: Number(process.env.MEMORY_VECTOR_MIN_SCORE) || 0.55
  });

  // ---- corpus build -------------------------------------------------------
  let eventSeq = 0;
  const needleIds = new Map(); // needle object -> assertion id
  const added = [];
  const addAssertion = async content => {
    eventSeq += 1;
    const event = await memory.recordEvent(CONTEXT, {
      eventId: `bulk-evt-${eventSeq}`, content, eventRole: 'user', contentType: 'plain_text',
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, eventSeq % 86400)).toISOString()
    });
    const rawEvent = state.rawEvents.find(item => item.eventId === `bulk-evt-${eventSeq}`);
    const candidate = await memory.createCandidate(CONTEXT, {
      sourceEventId: rawEvent.id, content, memoryType: 'fact', assertionType: 'observed_fact', scopeType: 'user',
      observedAt: rawEvent.occurredAt, validFrom: rawEvent.occurredAt
    });
    if (!['candidate', 'pending_confirmation'].includes(candidate.status)) throw new Error(`unexpected candidate status ${candidate.status} for: ${content}`);
    if (candidate.memory) {
      await memory.promoteCandidate(CONTEXT, candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision });
    }
    added.push({ content, needle: null });
    return candidate;
  };

  console.log(`构建 ${NEEDLE_COUNT} 根针 + 干扰记忆 ...`);
  const needles = needleObjects.map(obj => ({ obj, content: needleContent(obj) }));
  // Interleave needles and distractors so store depth affects both evenly.
  const distractorCount = SIZES[SIZES.length - 1] - NEEDLE_COUNT;
  const distractors = Array.from({ length: distractorCount }, (_, i) => distractorContent(i));
  const needleEvery = Math.floor((SIZES[SIZES.length - 1] + NEEDLE_COUNT - 1) / NEEDLE_COUNT);
  let needleIndex = 0;
  let distractorIndex = 0;
  const buildQueue = [];
  for (let i = 0; i < SIZES[SIZES.length - 1]; i += 1) {
    if ((i + 1) % needleEvery === 0 && needleIndex < needles.length) buildQueue.push({ needle: needles[needleIndex++] });
    else if (distractorIndex < distractors.length) buildQueue.push({ content: distractors[distractorIndex++] });
  }
  while (needleIndex < needles.length) buildQueue.push({ needle: needles[needleIndex++] });
  while (distractorIndex < distractors.length) buildQueue.push({ content: distractors[distractorIndex++] });

  console.log('build queue:', buildQueue.length, new Date().toISOString());
  let built = 0;
  const indexedContent = new Set();
  const indexPending = async () => {
    const contents = added.map(entry => entry.content).filter(content => !indexedContent.has(content));
    const versionByContent = new Map(state.assertionVersions.filter(v => v.content).map(v => [v.content, v]));
    for (let i = 0; i < contents.length; i += EMBED_CONCURRENCY) {
      const batch = contents.slice(i, i + EMBED_CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop
      const vectors = await Promise.all(batch.map(async content => {
        for (let attempt = 1; attempt <= EMBED_RETRIES; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          const vector = await gateway(content);
          if (Array.isArray(vector) && vector.length) return vector;
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
        throw new Error(`embedding failed after ${EMBED_RETRIES} attempts: ${content}`);
      }));
      batch.forEach((content, j) => {
        const vector = vectors[j];
        if (!Array.isArray(vector) || !vector.length) throw new Error(`embedding failed: ${content}`);
        const version = versionByContent.get(content);
        const assertion = version && state.assertions.find(item => item.currentVersionId === version.id);
        if (!assertion) throw new Error(`no assertion for: ${content}`);
        indexedContent.add(content);
        state.indexDocuments.push({
          id: `idx-bulk-${assertion.id}`, tenantId: CONTEXT.tenantId, sourceType: 'assertion', sourceId: assertion.id,
          sourceVersion: assertion.currentVersionId, userId: CONTEXT.subjectUserId, scopeType: assertion.scopeType,
          searchText: content, sensitivity: assertion.sensitivity, contextualizable: true, mentionable: true,
          redactionEpoch: 0, policyEpoch: 0, grantVersion: 0, embedding: vector, embeddingVersion: 'bge-m3',
          lexicalVersion: 'bm25-v1', indexStatus: 'active', sourceRefs: [], createdAt: new Date().toISOString()
        });
        if (content.startsWith('用户对针尖')) {
          const obj = content.replace('用户对', '').replace('严格过敏，接触后需要立即就医。', '');
          needleIds.set(obj, assertion.id);
        }
      });
    }
  };

  const checkpoints = [];
  for (const item of buildQueue) {
    if (item.needle) await addAssertion(item.needle.content);
    else await addAssertion(item.content);
    built += 1;
    if (built % 100 === 0) console.log(`built ${built}`, new Date().toISOString());
    if (SIZES.includes(built)) {
      console.log(`checkpoint ${built}: embedding...`, new Date().toISOString());
      await indexPending();
      console.log(`checkpoint ${built}: saving...`, new Date().toISOString());
      await repository.save(CONTEXT, memory.state);
      console.log(`checkpoint ${built}: saved`, new Date().toISOString());
      checkpoints.push({ size: built, assertions: state.assertions.length });
      console.log(`检查点 ${built}：断言 ${state.assertions.length}，索引文档 ${state.indexDocuments.length}`);
    }
  }

  // ---- measurement --------------------------------------------------------
  const measure = async size => {
    const needleSample = [];
    const step = needles.length / NEEDLE_QUERIES;
    for (let i = 0; i < NEEDLE_QUERIES; i += 1) needleSample.push(needles[Math.floor(i * step)].obj);
    const latencies = [];
    const hits = { 1: 0, 3: 0, 5: 0 };
    const ranks = [];
    for (const obj of needleSample) {
      const query = needleQuery(obj);
      const t0 = Date.now();
      const result = await memory.retrieveAsync(CONTEXT, { query, purpose: 'answer_user_query' });
      latencies.push(Date.now() - t0);
      const items = result.items || [];
      const targetId = needleIds.get(obj);
      let rank = -1;
      items.forEach((item, index) => { if (rank === -1 && String(item.memoryId || item.id) === targetId) rank = index + 1; });
      if (rank > 0) {
        ranks.push(rank);
        if (rank <= 1) hits[1] += 1;
        if (rank <= 3) hits[3] += 1;
        if (rank <= 5) hits[5] += 1;
      }
    }
    const noiseRecall = [];
    let debugDumped = false;
    for (const query of noiseQueryTemplates.slice(0, NOISE_QUERIES)) {
      const result = await memory.retrieveAsync(CONTEXT, { query, purpose: 'answer_user_query' });
      noiseRecall.push((result.items || []).length);
      if (!debugDumped) {
        debugDumped = true;
        console.log(`[debug] mode=${result.retrievalMode} query="${query}" items=${(result.items || []).length}`);
        for (const item of (result.items || []).slice(0, 5)) console.log(`[debug]   score=${Number(item.score ?? 0).toFixed(4)} content=${String(item.content || '').slice(0, 40)}`);
      }
    }
    latencies.sort((a, b) => a - b);
    const percentile = p => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
    return {
      size,
      needleQueries: needleSample.length,
      hitAt1: hits[1], hitAt3: hits[3], hitAt5: hits[5],
      needleRankMedian: ranks.length ? ranks.slice().sort((a, b) => a - b)[Math.floor(ranks.length / 2)] : null,
      needleRankMax: ranks.length ? Math.max(...ranks) : null,
      needleMiss: needleSample.length - ranks.length,
      noiseMeanRecall: Number((noiseRecall.reduce((a, b) => a + b, 0) / Math.max(1, noiseRecall.length)).toFixed(2)),
      noiseNonZero: noiseRecall.filter(n => n > 0).length,
      latencyP50: percentile(0.5), latencyP95: percentile(0.95), latencyMax: latencies[latencies.length - 1]
    };
  };

  const results = [];
  for (const size of SIZES) {
    const checkpoint = checkpoints.find(entry => entry.size === size);
    const m = await measure(size);
    results.push({ ...checkpoint, ...m });
    console.log(`[depth ${size}] hit@1=${m.hitAt1}/${m.needleQueries} hit@3=${m.hitAt3} hit@5=${m.hitAt5} rankMed=${m.needleRankMedian} noiseMean=${m.noiseMeanRecall} p50=${m.latencyP50}ms p95=${m.latencyP95}ms`);
  }

  const out = { phase: '3b', seed: SEED, corpus: { total: SIZES[SIZES.length - 1], needles: NEEDLE_COUNT, distractors: distractorCount }, results, generatedAt: new Date().toISOString() };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(new URL('../../.rearchitecture-runs/phase3b-depth.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log('证据已写入 .rearchitecture-runs/phase3b-depth.json');
  await pool.end();
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  process.exit(0);
};

main().catch(error => { console.error(error); process.exit(1); });
