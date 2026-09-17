const ROUTES = Object.freeze(['profile_exact', 'state_current', 'episode_recall', 'relationship_recall', 'bridge_candidate', 'unknown']);

const patterns = {
  bridge_candidate: /一跳|关联|桥接|bridge|link|relate/i,
  relationship_recall: /我们|共同|关系|一起|你和我|relationship|shared|between\s+us/i,
  // P0 (2026-09-17): 「现在/当前」是泛时间副词（可挂在偏好/画像上，不指向状态通道），
  // 曾把「我现在喜欢吃什么」误路由到 state_current —— 而无活跃会话时 state_current
  // 的检索域（state.currentStates）是空集且不回落检索断言，用户拿到空结果。
  // 只收窄这两个泛时间词。「正在」是进行体标记，指向「正在进行中的动作」，
  // 且产品自身把 currentState 的值写成「正在…」（memory-module.test.js:451/468），
  // 删掉会让「我正在发布什么」改走 episode_recall（memory-module.test.js:448 断言由此挂掉）。
  // 英文那组边界断言故意用来排除 current_plan 这类标识符，勿动。
  state_current: /情绪|心情|目标|进展|正在|(?:^|[^A-Za-z0-9_])(?:current|currently|mood|state|goal)(?:$|[^A-Za-z0-9_])/i,
  episode_recall: /经历|那次|当时|对话|发布|回忆|episode|during|release|what\s+happened/i,
  profile_exact: /偏好|喜欢|不喜欢|背景|姓名|叫什么|画像|profile|preference|like|dislike/i
};

export function routeMemoryQuery(query) {
  const normalized = String(query || '').trim();
  if (!normalized) return 'unknown';
  for (const route of ['bridge_candidate', 'relationship_recall', 'state_current', 'episode_recall', 'profile_exact']) {
    if (patterns[route].test(normalized)) return route;
  }
  return 'unknown';
}

export { ROUTES as MEMORY_QUERY_ROUTES };
