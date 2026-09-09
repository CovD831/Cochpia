import { createHash, randomUUID } from 'node:crypto';

const SOURCES = new Set(['agent_output', 'sandbox_diff', 'verification', 'review', 'rag']);

export function createEvidenceLedger(state) {
  state.evidence ||= [];
  return {
    record({ taskId, stageId = null, source, content, score = null }) {
      const text = String(content || '').slice(0, 4000);
      const item = {
        id: randomUUID(),
        taskId: String(taskId || '').slice(0, 100) || null,
        stageId: String(stageId || '').slice(0, 100) || null,
        source: SOURCES.has(source) ? source : 'agent_output',
        content: text,
        hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
        score: score == null ? null : Number(score),
        createdAt: new Date().toISOString()
      };
      state.evidence.push(item);
      return item;
    },
    list(taskId) { return state.evidence.filter(item => item.taskId === taskId); }
  };
}
