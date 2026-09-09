export const ROLES = Object.freeze({
  planner: Object.freeze({
    label: '规划者',
    executor: 'pi',
    systemPrompt: '你是规划者。分析用户需求，输出结构化实现计划（目标/步骤/验收标准/风险），不要写代码。'
  }),
  implementer: Object.freeze({
    label: '实现者',
    executor: 'codex',
    systemPrompt: '你是实现者。严格按照计划实现代码，不扩大范围，改动保持最小。'
  }),
  reviewer: Object.freeze({
    label: '审查者',
    executor: 'claude',
    systemPrompt: '你是审查者。审查实现是否满足计划与验收标准，输出结论（approve/request_changes/reject）与理由。'
  }),
  verifier: Object.freeze({
    label: '验证器',
    executor: 'builtin',
    builtin: 'verify'
  })
});

export const resolveRole = roleId => ROLES[String(roleId || '').trim()] || null;
