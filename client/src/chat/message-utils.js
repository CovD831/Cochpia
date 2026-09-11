// Pure message helpers, extracted from main.jsx (R-020 stage 4 split).
//
// These have no React dependency and no module state, which is exactly why they
// were safe to move first: the component tree could not be affected by the
// extraction. `takeSegment`/`splitSegments` encode the per-line segment
// rendering that stage 3 introduced, so they now carry unit tests instead of
// being covered only by the browser acceptance run.

export const asArray = value => Array.isArray(value) ? value : [];

export const providerModelOptions = provider => {
  if (!provider) return [];
  return [...new Set([...(provider.model ? [provider.model] : []), ...(provider.suggestedModels || [])])];
};

export const modelErrorLabels = {
  MODEL_NOT_CONFIGURED: '服务端尚未配置密钥',
  MODEL_AUTH_FAILED: '鉴权失败，请检查服务端密钥',
  MODEL_INSUFFICIENT_BALANCE: '模型账户余额不足，请充值或切换模型',
  MODEL_NOT_FOUND: '模型不存在或当前账号无权访问',
  MODEL_TIMEOUT: '请求超时，请稍后重试',
  MODEL_CONNECTION_FAILED: '服务暂时不可达'
};

export const describeModelError = error => (
  modelErrorLabels[error.code] ? `${modelErrorLabels[error.code]}：${error.message}` : error.message
);

// Pulls the next line-delimited segment out of the streaming buffer. Returns
// null when there is no line break yet, which is the signal for the caller to
// keep accumulating instead of finalising a bubble.
export function takeSegment(buffer) {
  const text = String(buffer || '');
  if (!text.trim()) return null;
  const match = text.match(/\r?\n+/);
  if (match) {
    return { segment: text.slice(0, match.index).trim(), rest: text.slice(match.index + match[0].length).trimStart() };
  }
  return null;
}

export function dateLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return '今天';
  if (same(d, yest)) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// Splits a complete message into the same segments the streaming path would
// have produced, so a reloaded conversation renders identically to a live one.
export function splitSegments(text) {
  const segments = [];
  let rest = String(text || '');
  let guard = 0;
  while (rest.trim() && guard < 200) {
    const taken = takeSegment(rest);
    if (!taken) { segments.push(rest.trim()); break; }
    if (taken.segment) segments.push(taken.segment);
    rest = taken.rest;
    guard += 1;
  }
  return segments.length ? segments : [String(text || '').trim()].filter(Boolean);
}
