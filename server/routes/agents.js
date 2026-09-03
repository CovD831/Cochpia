import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, agentTaskOwner, agents, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime } = deps;
  const router = Router();
  router.get('/api/agents', (_, res) => res.json(agents.list()));
  router.post('/api/agents', async (req, res) => { try { res.status(201).json(await agents.create(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
  router.patch('/api/agents/:id', async (req, res) => { try { const agent = await agents.update(req.params.id, req.body || {}); agent ? res.json(agent) : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
  router.delete('/api/agents/:id', async (req, res) => { const removed = await agents.remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); });

  const stripFences = value => String(value || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const cleanText = (value, limit) => String(value ?? '').trim().slice(0, limit);
  const parseAgentDraft = raw => {
    const text = stripFences(raw);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('模型未返回可解析的 JSON');
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      name: cleanText(parsed.name, 40),
      remark: cleanText(parsed.remark, 40),
      role: cleanText(parsed.role, 80),
      relationship: cleanText(parsed.relationship, 40),
      tone: cleanText(parsed.tone, 120),
      signature: cleanText(parsed.signature, 200),
      persona: cleanText(parsed.persona, 2000),
      memoryNotes: cleanText(parsed.memoryNotes, 3000),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(tag => cleanText(tag, 30)).filter(Boolean).slice(0, 10) : []
    };
  };
  router.post('/api/agents/parse', async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 10000);
    if (!text) return fail(res, 400, 'INVALID_AGENT_TEXT', 'Role setting text is required');
    try {
      const system = '你是角色设定解析器。把用户提供的角色设定文本解析成严格 JSON，字段：name（名字）、remark（备注名）、role（角色定位）、relationship（关系）、tone（说话语气）、signature（个性签名）、persona（人格设定全文）、memoryNotes（记忆备注）、tags（标签数组，字符串数组）。规则：只输出一个 JSON 对象，不要任何解释或代码围栏；字段缺失时 name 给空字符串、tags 给空数组；保留人格设定的原始语气与细节，不擅自扩写。';
      const raw = await model.generate({ message: text, system });
      return res.json({ draft: parseAgentDraft(raw) });
    } catch (error) { return fail(res, 502, 'AGENT_PARSE_FAILED', error.message || 'Failed to parse agent setting'); }
  });
  return router;
}

