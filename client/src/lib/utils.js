// 纯工具函数：无 JSX、无副作用（除 localStorage 读写），供 main.jsx 与各组件复用。

export const asArray = value => Array.isArray(value) ? value : [];
// Agent 默认头像：名字/备注首字符（不再用符号占位）
export const agentInitial = agent => (agent?.remark || agent?.name || '?').charAt(0).toUpperCase();

// 账号切换：本地记录最近登录过的账号（只存邮箱+名字，不存密码/token）
const ACCOUNTS_KEY = 'cochpia.accounts';
export const readAccounts = () => { try { return JSON.parse(window.localStorage.getItem(ACCOUNTS_KEY) || '[]'); } catch { return []; } };
export const writeAccounts = list => { try { window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch { /* localStorage 可选 */ } };

const modelErrorLabels = {
  MODEL_NOT_CONFIGURED: '服务端尚未配置密钥',
  MODEL_AUTH_FAILED: '鉴权失败，请检查服务端密钥',
  MODEL_INSUFFICIENT_BALANCE: '模型账户余额不足，请充值或切换模型',
  MODEL_NOT_FOUND: '模型不存在或当前账号无权访问',
  MODEL_TIMEOUT: '请求超时，请稍后重试',
  MODEL_CONNECTION_FAILED: '服务暂时不可达'
};
export const describeModelError = error => modelErrorLabels[error.code] ? `${modelErrorLabels[error.code]}：${error.message}` : error.message;
export const isAuthenticationError = error => error?.status === 401 || error?.code === 'AUTH_REQUIRED' || error?.code === 'AUTH_INVALID';

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

export const companionIntents = [
  { id: 'listen', label: '听我说' },
  { id: 'comfort', label: '安慰我' },
  { id: 'advice', label: '给建议' },
  { id: 'accompany', label: '陪我做' },
  { id: 'quiet', label: '安静陪伴' }
];
