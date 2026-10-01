import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;
export const apiBase = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

// 一次性 service worker（client/public/sw.js）对 /api/ 做了 network-first +
// cache-fallback：后端不可达时它会回一份**缓存的 200**。原实现不带任何标记，
// 前端无法与真实响应区分 ⇒ 9 路探测全部 fulfilled ⇒ 顶栏在后端已死时仍显示
// 「已连接」（2026-09-30 阶段 0 修）。SW 现在会给回退响应打
// `X-Cochpia-From-Cache: 1`，这里把它转成一个显式信号。
//
// 语义选择：**不抛错**（离线时仍让 UI 显示上次的内容，这是缓存的本意），
// 但把它记为「这次响应来自缓存」。调用方（refresh 的 serverReachable 推导）
// 据此判定后端不可达。
export const FROM_CACHE_HEADER = 'x-cochpia-from-cache';

// 每次请求的结果都会喂给这里（成功 / 失败 / 来自缓存），供顶栏显示**真实**连接状态。
// 为什么不是「启动时探测一次」：refresh() 只在启动与导入后各跑一次，没有轮询
// （实测：后端死后切页只触发 /api/preferences，refresh 不再执行）。所以顶栏
// 拿到的其实是「打开页面那一刻的快照」，之后无论如何都不会变 —— 这不是 SW 缓存
// 造成的，是**根本没有持续探测**。以最近的请求结果为准，才能反映当下。
let reachabilityListener = null;
export const onReachability = fn => { reachabilityListener = typeof fn === 'function' ? fn : null; };
// state 语义：
//   'up'    收到真实响应（含 4xx/5xx —— 服务答复了就算活着）
//   'down'  网络层失败（fetch 抛错，且没有缓存可回）
//   'cache' 网络层失败但 SW 回了一份缓存 ⇒ **后端没有答复**
//          （SW 只在 fetch reject 时走 cache 分支：`.catch(() => caches.match(...))`，
//           所以这个标记不等价于「弱网」，就是没答复）
const report = state => { try { reachabilityListener?.(state); } catch { /* 观察者不得影响请求 */ } };

// 主动探活（2026-09-30 阶段 0）。
//
// 为什么被动上报还不够：清理发现，后端死掉后**根本不会再有 api() 调用**
// （实测：杀掉后端后点「新的相遇」只触发 /api/preferences，而它命中 SW 缓存；
//  其它入口在当前页不可达）。被动监听因此永远等不到信号，顶栏一直停在旧值。
// 这与「R-020 移除 30s 轮询」的教训不冲突：那次是**重负载**轮询（重新序列化
// 全部 session/message/memory 再把结果丢掉）；这里只打一个轻量 GET /api/health，
// 不传业务数据，且结果只用来更新一个布尔状态。
export const REACHABILITY_PROBE_MS = 30000;
let probeTimer = null;

const probeOnce = async () => {
  if (!reachabilityListener) return; // 没人订阅就不打
  try {
    // 刻意绕开 SW 缓存：探活问的是「后端现在答不答」，缓存的答案没有意义。
    // cache: 'no-store' + SW 对 /api/ 是 network-first，故失败即真失败。
    const response = await fetch(`${apiBase}/api/health`, { cache: 'no-store' });
    report(response.ok || response.status < 500 ? 'up' : 'down');
  } catch {
    report('down');
  }
};

export const startReachabilityProbe = (intervalMs = REACHABILITY_PROBE_MS) => {
  if (probeTimer) return;
  probeTimer = setInterval(probeOnce, intervalMs);
  // 不阻止进程/页面生命周期
  if (typeof probeTimer?.unref === 'function') probeTimer.unref();
};

export const stopReachabilityProbe = () => {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
};

// 统一 API 请求：附带 Supabase 会话 token，统一错误结构。
export async function api(url, options = {}) {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const headers = new Headers(options.headers || {});
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  let response;
  try {
    response = await fetch(`${apiBase}${url}`, { ...options, headers });
  } catch (error) {
    report('down');
    throw error;
  }
  const fromCache = response.headers.get(FROM_CACHE_HEADER) === '1';
  const payload = await response.json().catch(() => null);
  if (fromCache && payload && typeof payload === 'object') {
    // 非侵入：只在对象响应上挂一个只读标记，不改变既有字段。
    Object.defineProperty(payload, '__fromCache', { value: true, enumerable: false });
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error || 'Request failed');
    error.code = payload?.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    // 4xx 说明服务是活的（它答复了）；5xx 同理。只有网络层失败才算不可达。
    report('up');
    throw error;
  }
  report(fromCache ? 'cache' : 'up');
  return payload;
}
