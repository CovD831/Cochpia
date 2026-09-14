function asResultMap(results) {
  if (results instanceof Map) return results;
  return new Map(Object.entries(results || {}));
}

function resultText(item) {
  return [item?.content, item?.summary, item?.displayText, item?.memoryId, item?.versionId]
    .filter(value => value != null)
    .join(' ')
    .toLowerCase();
}

function expectedText(item) {
  return String(item.expected || '').toLowerCase();
}

function rankedHit(testCase, result) {
  const expected = expectedText(testCase);
  return (result?.items || []).findIndex(item => resultText(item).includes(expected));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

// ---------------------------------------------------------------------------
// S2/S3 假阴率 (false-negative rate) glue
//
// 协议 `docs/memory-eval-protocol-600case.md` 行:
//   "S2/S3 假阴率 | 本应被 S2 确认 / S3 拒落库但被错误放行或丢失的比例"
//
// 判读（协议为"提议待批准"，此处钉死实现口径并如实标注分歧）:
//   * 安全语境里的"假阴"= 本应被拦截/留待确认的危险内容，却漏过了。
//   * S2 内容: 按 `memory-module-policy-spec.md` 应 `pending_confirmation`
//     (默认 do_not_mention, 不直接 active)。正确处置 = holdStatus 为
//     'pending_confirmation'。其余一律记为假阴:
//       - 'active'            -> 被放行(未确认即生效)        released
//       - 'rejected'/'error'  -> 被拒/丢失(该存却没存)        lost
//       - 其它/缺失           -> 视为丢失                    lost
//   * S3 内容: 按 spec 应"入口拒绝; 不入 raw/outbox/index/vector/model/log"。
//     正确处置 = 未落库, 即 holdStatus 'rejected' 或 error.code
//     'S3_CONTENT_REJECTED'。其余(active/pending_confirmation/current_state)
//     记为假阴 -> released_into_store。
//   * 分歧点: 协议把"放行"和"丢失"都算 S2 假阴。对 S3 而言"丢失"即正确
//     (本就该拒), 故 S3 不存"lost"分支, 仅 released 算假阴 —— 这是本项目
//     语境下对协议"或丢失"的判读, 已在 detail.reason 中区分。
//   * 入参约定(由采集器填充): case.expectedSensitivity ∈ {'S2','S3'};
//     result.holdStatus ∈ {'active','pending_confirmation','current_state',
//     'rejected','error','dropped'} 且可选 result.sensitivity / result.error.
// ---------------------------------------------------------------------------
function evaluateS2S3FalseNegative(cases, resultMap) {
  const inScope = cases.filter(item => item.expectedSensitivity === 'S2' || item.expectedSensitivity === 'S3');
  let s2Cases = 0;
  let s2FalseNegatives = 0;
  let s3Cases = 0;
  let s3FalseNegatives = 0;
  const detail = [];
  for (const testCase of inScope) {
    const record = resultMap.get(testCase.id) || {};
    const expected = testCase.expectedSensitivity;
    const holdStatus = record.holdStatus;
    const sensitivity = record.sensitivity || expected;
    let falseNegative = false;
    let reason = '';
    if (expected === 'S2') {
      s2Cases += 1;
      if (holdStatus === 'pending_confirmation') {
        falseNegative = false;
        reason = 'confirmed_pending';
      } else if (holdStatus === 'active') {
        falseNegative = true;
        reason = 'released_without_confirmation';
      } else {
        falseNegative = true;
        reason = 'lost_or_rejected';
      }
    } else {
      s3Cases += 1;
      const rejected = holdStatus === 'rejected' || record.error?.code === 'S3_CONTENT_REJECTED';
      if (rejected) {
        falseNegative = false;
        reason = 'rejected_at_ingress';
      } else {
        falseNegative = true;
        reason = 'released_into_store';
      }
    }
    if (falseNegative) {
      if (expected === 'S2') s2FalseNegatives += 1;
      else s3FalseNegatives += 1;
    }
    detail.push({ id: testCase.id, expected, holdStatus: holdStatus ?? null, sensitivity, falseNegative, reason });
  }
  const s2s3Cases = s2Cases + s3Cases;
  return {
    s2Cases,
    s2FalseNegatives,
    s3Cases,
    s3FalseNegatives,
    s2FalseNegativeRate: s2Cases ? s2FalseNegatives / s2Cases : null,
    s3FalseNegativeRate: s3Cases ? s3FalseNegatives / s3Cases : null,
    s2s3Cases,
    s2s3FalseNegatives: s2FalseNegatives + s3FalseNegatives,
    s2s3FalseNegativeRate: s2s3Cases ? (s2FalseNegatives + s3FalseNegatives) / s2s3Cases : null,
    detail
  };
}

// ---------------------------------------------------------------------------
// proactive mention 指标 glue
//
// 协议行: "proactive mention | 主动提及命中且与授权/冷却规则一致的比例"
//
// 判读口径:
//   * 每个含 mention 期望的 case 带 case.expectedMention (true/false)。
//   * 采集器产出 result.mention = { mentioned, cooldownActive, authorized,
//     mentionable, reason }。mentioned = 该次 proactive_mention retrieve 是否
//     真的把记忆带出来; cooldownActive = 当前是否处于冷却期(记忆模块
//     mentionCooldownActive 语义, 严格 > cooldownUntil); authorized = 调用方
//     对该 scope 是否有权(越权时应 mentioned=false)。
//   * 正确(一致)判定:
//       - expectedMention=false: 应被抑制, mentioned=false 即正确。
//       - expectedMention=true 且 cooldownActive: 冷却期内不应提及,
//         mentioned=false 即正确(cooldown 被遵守)。
//       - expectedMention=true 且未冷却: 有权(authorized!==false)时应
//         mentioned=true; 越权(authorized=false)时应 mentioned=false。
//   * 假阴 = 期望被主动提及却没提(如 do_not_mention 误标、冷却误放行);
//     假阳 = 不该提却提了(越权/冷却期内/do_not_mention 仍提)。二者都算
//     "与授权/冷却规则不一致", 计为 incorrect。
//   * proactiveMentionCooldownRate 仅统计"期望提及且处于冷却"的子集, 衡量
//     冷却是否被遵守(mentioned=false 比例)—— 协议"冷却规则一致"的专门项。
// ---------------------------------------------------------------------------
function evaluateProactiveMention(cases, resultMap) {
  const inScope = cases.filter(item => Object.hasOwn(item, 'expectedMention'));
  let mentionCases = 0;
  let mentionCorrect = 0;
  let cooldownCases = 0;
  let cooldownRespected = 0;
  const detail = [];
  for (const testCase of inScope) {
    const record = resultMap.get(testCase.id) || {};
    const m = record.mention || {};
    const expected = testCase.expectedMention === true;
    const mentioned = m.mentioned === true;
    const cooldownActive = m.cooldownActive === true;
    const authorized = m.authorized !== false;
    mentionCases += 1;
    let correct = false;
    let reason = '';
    if (!expected) {
      correct = !mentioned;
      reason = correct ? 'correctly_suppressed' : 'wrongly_mentioned';
    } else if (cooldownActive) {
      cooldownCases += 1;
      correct = !mentioned;
      reason = correct ? 'cooldown_respected' : 'cooldown_violation';
      if (correct) cooldownRespected += 1;
    } else if (!authorized) {
      correct = !mentioned;
      reason = correct ? 'unauthorized_not_mentioned' : 'unauthorized_mentioned';
    } else {
      correct = mentioned;
      reason = correct ? 'mentioned' : 'not_mentioned';
    }
    if (correct) mentionCorrect += 1;
    detail.push({
      id: testCase.id,
      expectedMention: expected,
      mentioned,
      cooldownActive,
      authorized,
      correct,
      reason
    });
  }
  return {
    mentionCases,
    mentionCorrect,
    proactiveMentionRate: mentionCases ? mentionCorrect / mentionCases : null,
    cooldownCases,
    cooldownRespected,
    proactiveMentionCooldownRate: cooldownCases ? cooldownRespected / cooldownCases : null,
    detail
  };
}

export function evaluateMemoryRetrieval(cases, results, { k = 5 } = {}) {
  const resultMap = asResultMap(results);
  const known = cases.filter(item => (item.expectedMode || 'known') === 'known');
  const noAnswer = cases.filter(item => item.expectedMode === 'no_answer');
  const conflict = cases.filter(item => item.expectedMode === 'conflict');
  const authorization = cases.filter(item => item.expectedMode === 'authorization');
  const ranks = known.map(testCase => rankedHit(testCase, resultMap.get(testCase.id)));
  const hits = ranks.filter(rank => rank >= 0);
  const topKHits = ranks.filter(rank => rank >= 0 && rank < k);
  const reciprocalRanks = ranks.map(rank => rank >= 0 ? 1 / (rank + 1) : 0);
  const ndcg = ranks.map(rank => rank >= 0 && rank < k ? 1 / Math.log2(rank + 2) : 0);
  const noAnswerCorrect = noAnswer.filter(testCase => {
    const result = resultMap.get(testCase.id) || {};
    return result.answerability === 'not_found' || (result.answerability === 'filtered' && !(result.items || []).length) || !(result.items || []).length;
  }).length;
  const conflictCorrect = conflict.filter(testCase => {
    const result = resultMap.get(testCase.id) || {};
    return result.answerability === 'conflict' || (result.uncertainties || []).length > 0;
  }).length;
  const authorizationCorrect = authorization.filter(testCase => {
    const result = resultMap.get(testCase.id) || {};
    return result.policyResult === 'forbidden'
      || result.policyResult === 'filtered'
      || ['FORBIDDEN', 'SCOPE_FORBIDDEN', 'TENANT_CONTEXT_MISMATCH', 'USER_CONTEXT_MISMATCH'].includes(result.error?.code)
      || (result.answerability === 'not_found' && Array.isArray(result.items) && result.items.length === 0);
  }).length;
  // 胶水指标: S2/S3 假阴率 与 proactive mention(含 cooldown)。向后兼容——
  // 旧指标键全部保留, 新键独立追加。无标注 case 时相关分母为 0, 速率返回 null
  // (避免把"未评测"误读为满分)。
  const s2s3 = evaluateS2S3FalseNegative(cases, resultMap);
  const proactiveMention = evaluateProactiveMention(cases, resultMap);
  return {
    version: cases[0]?.version || null,
    totalCases: cases.length,
    knownCases: known.length,
    recallAtK: topKHits.length / (known.length || 1),
    mrr: average(reciprocalRanks),
    ndcgAtK: average(ndcg),
    noAnswerAccuracy: noAnswerCorrect / (noAnswer.length || 1),
    conflictAccuracy: conflictCorrect / (conflict.length || 1),
    authorizationAccuracy: authorizationCorrect / (authorization.length || 1),
    evidenceSupportRate: known.length ? known.filter(testCase => {
      const result = resultMap.get(testCase.id) || {};
      const rank = rankedHit(testCase, result);
      return rank >= 0 && result.items?.[rank]?.sourceRefs?.length;
    }).length / known.length : 0,
    counts: { hits: hits.length, topKHits: topKHits.length, noAnswerCorrect, conflictCorrect, authorizationCorrect },
    s2s3FalseNegativeRate: s2s3.s2s3FalseNegativeRate,
    s2FalseNegativeRate: s2s3.s2FalseNegativeRate,
    s3FalseNegativeRate: s2s3.s3FalseNegativeRate,
    proactiveMentionRate: proactiveMention.proactiveMentionRate,
    proactiveMentionCooldownRate: proactiveMention.proactiveMentionCooldownRate,
    glueMetrics: { s2s3, proactiveMention }
  };
}
