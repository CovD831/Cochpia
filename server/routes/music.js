import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, agentTaskOwner, agents, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime } = deps;
  const router = Router();
  router.get('/api/music/environment', async (_, res) => res.json(await music.environment()));
  router.get('/api/music/status', async (_, res) => res.json(await music.status()));
  router.get('/api/music/context', async (_, res) => res.json(await music.listeningContext()));
  router.get('/api/music/search', async (req, res) => { try { res.json({ items: await music.search(req.query.q) }); } catch (error) { fail(res, error.code === 'INVALID_MUSIC_QUERY' ? 400 : 503, error.code || 'MUSIC_SEARCH_FAILED', error.message); } });
  router.post('/api/music/play', async (req, res) => { try { res.json(await music.play(req.body?.track)); } catch (error) { fail(res, 503, error.code || 'MUSIC_PLAY_FAILED', error.message); } });
  router.post('/api/music/pause', async (_, res) => { try { res.json(await music.pause()); } catch (error) { fail(res, 503, error.code || 'MUSIC_PAUSE_FAILED', error.message); } });
  router.post('/api/music/resume', async (_, res) => { try { res.json(await music.resume()); } catch (error) { fail(res, 503, error.code || 'MUSIC_RESUME_FAILED', error.message); } });
  router.post('/api/music/next', async (_, res) => { try { res.json(await music.next()); } catch (error) { fail(res, 503, error.code || 'MUSIC_NEXT_FAILED', error.message); } });
  router.post('/api/music/stop', async (_, res) => { try { res.json(await music.stop()); } catch (error) { fail(res, 503, error.code || 'MUSIC_STOP_FAILED', error.message); } });
  return router;
}

