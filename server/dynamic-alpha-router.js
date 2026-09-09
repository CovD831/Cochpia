const DEFAULT_CONFIG = Object.freeze({
  theta: 0.55,
  lambdaPerMinute: 0.01,
  beta: 0.15,
  workBias: -0.05,
  loveBias: 0.1,
});

const WORK_VERBS = ["计算", "排期", "分析", "提取"];
const LOVE_WORDS = ["觉得", "感觉", "喜欢", "讨厌", "气死"];
const WORK_LEXICON = ["综上", "因此", "分别"];
const LOVE_LEXICON = ["棒", "可爱", "扎心"];
const ANCHOR_PATTERN = /deadline|生日/i;

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function countOccurrences(input, term) {
  return input.split(term).length - 1;
}

function hasRepeatedCharacter(input) {
  return /(.)\1{2,}/u.test(input);
}

function includesAny(input, terms) {
  return terms.some((term) => input.includes(term));
}

/** Score intent without sending user content to logs or external services. */
export function scoreIntent(userInput) {
  const input = String(userInput ?? "");
  const hasSelf = input.includes("我");
  const hasObjectOnly = includesAny(input, ["它", "数据", "这个"]) && !hasSelf;
  const selfCount = countOccurrences(input, "我");
  const expressive = /[!！?？]/u.test(input) || hasRepeatedCharacter(input);
  const structured = /[。:：]|\r?\n/u.test(input);

  let work = 0;
  let love = 0;
  if (includesAny(input, WORK_VERBS)) {
    work += 40;
    love -= 10;
  }
  if (includesAny(input, LOVE_WORDS)) {
    work -= 10;
    love += 40;
  }
  if (selfCount >= 2) {
    work += 5;
    love += 30;
  }
  if (hasObjectOnly) {
    work += 30;
    love += 5;
  }
  if (expressive) {
    work -= 5;
    love += 20;
  }
  if (structured) {
    work += 20;
    love -= 5;
  }
  if (includesAny(input, WORK_LEXICON)) work += 10;
  if (includesAny(input, LOVE_LEXICON)) love += 10;

  return {
    work: clamp(work, 0, 100),
    love: clamp(love, 0, 100),
  };
}

function minutesBetween(timestamp, lastLogTimestamp) {
  const current = new Date(timestamp).getTime();
  const previous = new Date(lastLogTimestamp).getTime();
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    throw new TypeError("timestamp and lastLogTimestamp must be valid dates");
  }
  return Math.max(0, (current - previous) / 60000);
}

export function calculateAlpha({ scores, timestamp, lastLogTimestamp, config = {} }) {
  const options = { ...DEFAULT_CONFIG, ...config };
  const confAbs = Math.max(scores.work, scores.love) / 100;
  const confMargin = Math.abs(scores.work - scores.love) / 100;
  const alphaRaw = Math.sqrt(confAbs * confMargin);
  const deltaMinutes = minutesBetween(timestamp, lastLogTimestamp);
  const alphaDecayed = alphaRaw * Math.exp(-options.lambdaPerMinute * deltaMinutes);

  return {
    confAbs,
    confMargin,
    alphaRaw,
    deltaMinutes,
    alphaDecayed,
    alphaWork: clamp(alphaDecayed + options.beta * options.workBias),
    alphaLove: clamp(alphaDecayed + options.beta * options.loveBias),
  };
}

export function isAnchorMessage(userInput, pinned = false) {
  return Boolean(pinned) || ANCHOR_PATTERN.test(String(userInput ?? ""));
}

export function routeMessage({ userInput, timestamp, lastLogTimestamp, pinned = false, config = {} }) {
  const scores = scoreIntent(userInput);
  if (isAnchorMessage(userInput, pinned)) {
    return {
      scores,
      isAnchor: true,
      alphaWork: 1,
      alphaLove: 1,
      decision: "anchor",
      placements: { work: "anchor", love: "anchor" },
    };
  }

  const alpha = calculateAlpha({ scores, timestamp, lastLogTimestamp, config });
  const options = { ...DEFAULT_CONFIG, ...config };
  const workHigh = alpha.alphaWork >= options.theta;
  const loveHigh = alpha.alphaLove >= options.theta;
  let decision;
  let placements;
  if (workHigh && loveHigh) {
    decision = "parallel-high-fidelity";
    placements = { work: "high", love: "high" };
  } else if (workHigh) {
    decision = "work-high-love-summary";
    placements = { work: "high", love: "summary" };
  } else if (loveHigh) {
    decision = "love-high-work-summary";
    placements = { work: "summary", love: "high" };
  } else {
    decision = "shared-summary";
    placements = { work: "shared-summary", love: "shared-summary" };
  }

  return { scores, isAnchor: false, ...alpha, decision, placements };
}

export { DEFAULT_CONFIG };
