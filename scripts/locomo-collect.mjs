// LoCoMo 公开评测采集器（R-021 之外的独立评测工具；2026-09-17）。
//
// 目的：给「我们的记忆底座到底行不行」一个**外部可比的数字**。
//
// 为什么不能用现有 synthetic 评测：`evaluate:memory-synthetic` 先 hold 写入
// 「预期内容」再 retrieve 同一 query —— recall 必然 1.0，是自洽闭环、零判别力
// （docs/memory-eval-protocol-600case.md §1 自己写明了这一点）。要拿真分数，
// 必须用**外部标注**的公开数据集。
//
// 数据集：LoCoMo（snap-research/locomo，1170 stars）
//   - 10 个长对话样本，5882 轮对话，1986 个 QA；
//   - 每个 QA 带 evidence（标注了答案出自哪几轮），category ∈ {1 多跳, 2 时间, 3 开放, 4 单跳, 5 对抗}。
//
// 与既有 harness 的对接（**不改 harness 逻辑**）：
//   `scripts/memory-module-evaluate.js` 的输入契约是
//   cases JSON（id/query/expected/expectedMode）+ results JSON（id → {items,...}）。
//   本采集器负责：灌对话进记忆 → 逐 case 检索 → 按契约落盘两个文件。
//
// 口径诚实声明（重要）：
//   本采集器测的是【检索层】——「给定 query，相关记忆能否被召回」。
//   LoCoMo 原论文还测【端到端回答质量】（把检索结果喂 LLM 生成答案再判分）。
//   我们**不测后者**，因为那受生成模型能力影响，会把检索问题和生成问题混在一起。
//   所以本分数**不能直接与论文报告的 LLM-judge 分数比较**，但可与「同一检索层」
//   的同类配置横向比（例如调参前后、换 embedding 前后）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';

const DATA = path.resolve(process.cwd(), process.env.LOCOMO_PATH || 'eval-data/locomo10.json');
const OUT_DIR = path.resolve(process.cwd(), process.env.LOCOMO_OUT_DIR || 'eval-data/out');
// 只跑前 N 个样本（10 个全跑很慢：每个样本几十到上百轮对话 + ~200 QA）
const SAMPLE_LIMIT = Math.max(1, Number(process.env.LOCOMO_SAMPLE_LIMIT || 1));
// 每个样本取前 N 个 QA（0 = 全部）
const QA_LIMIT = Math.max(0, Number(process.env.LOCOMO_QA_LIMIT || 20));
const K = Math.max(1, Number(process.env.LOCOMO_K || 10));

const TENANT = 'locomo';
const USER = 'locomo-user';
const AGENT = 'locomo-agent';

const ctx = () => ({
  tenantId: TENANT,
  subjectUserId: USER,
  actorType: 'agent',
  actorId: AGENT,
  callerAgentId: AGENT,
});

// 一个 LoCoMo 样本 → 一串可灌入记忆的「对话轮」。
// LoCoMo 的 conversation 是 {speaker_a, speaker_b, session_1: [...], session_1_date_time, ...}
// 每轮形如 {speaker, text, dia_id, ...}。我们按 session 顺序展开。
function flattenTurns(sample) {
  const conv = sample.conversation || {};
  const sessions = Object.keys(conv)
    .filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  const turns = [];
  for (const key of sessions) {
    const list = conv[key];
    const dateTime = conv[`${key}_date_time`] || '';
    if (!Array.isArray(list)) continue;
    for (const turn of list) {
      const text = String(turn.text || '').trim();
      if (!text) continue;
      turns.push({
        diaId: turn.dia_id || null,
        speaker: turn.speaker || '',
        text,
        dateTime,
      });
    }
  }
  return turns;
}

// 把一轮对话写成一条记忆。scope=relationship 绑到评测 agent：
// 这样 (a) 复用既有的关系域隔离路径，(b) 不会污染 user scope 的「用户自己的记忆」语义。
async function ingest(memory, turns) {
  let written = 0;
  for (const turn of turns) {
    await memory.hold(ctx(), {
      content: turn.text,
      memoryType: 'dialogue_turn',
      assertionType: 'observed_fact',
      scopeType: 'relationship',
      relationshipAgentId: AGENT,
      sensitivity: 'S0',
      structuredData: { locomo: { diaId: turn.diaId, speaker: turn.speaker, dateTime: turn.dateTime } },
    });
    written += 1;
  }
  return written;
}

// 组装 case：harness 用「result.items[].content 是否包含 expected 文本」判命中
// （server/memory-module-eval.js:13-19），所以 expected 必须是**答案字符串本身**，
// 而不是 evidence 的 dia_id。我们取 LoCoMo 的 answer 字段；答案为空/无法匹配的
// 类别（如对抗类）单独处理。
function buildCases(sample, qaList, sampleIndex) {
  const cases = [];
  for (let i = 0; i < qaList.length; i += 1) {
    const qa = qaList[i];
    const answer = String(qa.answer ?? '').trim();
    const category = Number(qa.category || 0);
    // 对抗类（category 5）标准答案是「无法回答」，检索层不该召回具体事实。
    // 记为 no_answer 模式，交给 harness 的 noAnswerAccuracy 统计。
    const isAdversarial = category === 5;
    cases.push({
      id: `locomo-${sample.sample_id ?? sampleIndex}-${i}`,
      split: 'acceptance',
      query: String(qa.question || '').trim(),
      expected: isAdversarial ? '' : answer,
      expectedMode: isAdversarial ? 'no_answer' : 'known',
      category,
      evidence: qa.evidence || [],
      answer,
    });
  }
  return cases;
}

async function main() {
  const raw = JSON.parse(await readFile(DATA, 'utf8'));
  const samples = raw.slice(0, SAMPLE_LIMIT);
  await mkdir(OUT_DIR, { recursive: true });

  const allCases = [];
  const allResults = {};
  const stats = { samples: 0, turnsTotal: 0, casesTotal: 0, rowsPerSample: [] };

  for (let si = 0; si < samples.length; si += 1) {
    const sample = samples[si];
    const turns = flattenTurns(sample);
    const qaList = QA_LIMIT > 0 ? (sample.qa || []).slice(0, QA_LIMIT) : (sample.qa || []);

    // 每个样本用**全新的 memory state** —— 模拟「一个新用户的记忆库」，
    // 避免样本之间互相污染（这也是 LoCoMo 的评测口径）。
    const state = createMemoryModuleState();
    const memory = createMemoryModule(state, async () => {});

    const written = await ingest(memory, turns);
    stats.turnsTotal += written;

    const cases = buildCases(sample, qaList, si);
    for (const testCase of cases) {
      allCases.push(testCase);
      try {
        const retrieved = await memory.retrieveAsync(ctx(), {
          query: testCase.query,
          purpose: 'answer_user_query',
          limit: K,
        });
        allResults[testCase.id] = {
          items: (retrieved.items || []).map(item => ({
            memoryId: item.memoryId,
            versionId: item.versionId,
            content: item.content || '',
            sourceRefs: item.sourceRefs || [],
            scope: item.scope || null,
          })),
          answerability: retrieved.answerability,
          policyResult: retrieved.policyResult,
          uncertainties: retrieved.uncertainties || [],
        };
      } catch (error) {
        allResults[testCase.id] = { items: [], error: { code: error.code, message: error.message } };
      }
    }
    stats.samples += 1;
    stats.casesTotal += cases.length;
    stats.rowsPerSample.push({ sample: sample.sample_id ?? si, turns: written, cases: cases.length });
    console.log(JSON.stringify({ event: 'locomo_sample_done', sample: sample.sample_id ?? si, turns: written, cases: cases.length }));
  }

  const casesPath = path.join(OUT_DIR, 'locomo-cases.json');
  const resultsPath = path.join(OUT_DIR, 'locomo-results.json');
  await writeFile(casesPath, JSON.stringify(allCases, null, 2));
  await writeFile(resultsPath, JSON.stringify({ results: allResults }, null, 2));
  await writeFile(path.join(OUT_DIR, 'locomo-collect-stats.json'), JSON.stringify(stats, null, 2));

  console.log(JSON.stringify({ event: 'locomo_collect_done', casesPath, resultsPath, ...stats }));
}

main().catch(error => {
  console.error(JSON.stringify({ event: 'locomo_collect_failed', code: error.code || 'UNEXPECTED', message: error.message }));
  process.exit(1);
});
