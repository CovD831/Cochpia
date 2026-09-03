import { Router } from 'express';

export function createRouter(deps) {
  const { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, agentTaskOwner, agents, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime } = deps;
  const router = Router();
  router.get('/api/profile', (_, res) => res.json(state.profile));
  router.patch('/api/profile', async (req, res) => {
    try {
      const input = req.body || {};
      if (input.name !== undefined) {
        const name = String(input.name).trim().slice(0, 20);
        if (!name) return fail(res, 400, 'INVALID_NAME', 'Name is required');
        state.profile.name = name;
      }
      if (input.gender !== undefined) {
        const gender = String(input.gender);
        if (!['none', 'male', 'female', 'other'].includes(gender)) return fail(res, 400, 'INVALID_GENDER', 'Invalid gender');
        state.profile.gender = gender;
      }
      if (input.age !== undefined) {
        if (input.age === null) state.profile.age = null;
        else {
          const age = Number(input.age);
          if (!Number.isFinite(age) || age < 0 || age > 90) return fail(res, 400, 'INVALID_AGE', 'Age must be between 0 and 90');
          state.profile.age = age;
        }
      }
      if (input.avatar !== undefined) state.profile.avatar = String(input.avatar).slice(0, 8) || '✦';
      if (input.avatarImage !== undefined) {
        const avatarImage = String(input.avatarImage || '');
        if (avatarImage && !avatarImage.startsWith('data:image/')) return fail(res, 400, 'INVALID_AVATAR_IMAGE', 'Avatar image must be a data URL');
        if (avatarImage.length > 400000) return fail(res, 400, 'AVATAR_IMAGE_TOO_LARGE', 'Avatar image is too large');
        state.profile.avatarImage = avatarImage || null;
      }
      if (input.characterSheet !== undefined) {
        const characterSheet = String(input.characterSheet || '');
        if (characterSheet && !characterSheet.startsWith('data:image/')) return fail(res, 400, 'INVALID_CHARACTER_SHEET', 'Character sheet must be a data URL');
        if (characterSheet.length > 2000000) return fail(res, 400, 'CHARACTER_SHEET_TOO_LARGE', 'Character sheet is too large');
        state.profile.characterSheet = characterSheet || null;
      }
      if (input.characterAnimation !== undefined) {
        if (input.characterAnimation === null) state.profile.characterAnimation = null;
        else {
          const animation = input.characterAnimation;
          if (typeof animation !== 'object' || !Number.isFinite(Number(animation.frameWidth)) || !Number.isFinite(Number(animation.frameHeight))) {
            return fail(res, 400, 'INVALID_CHARACTER_ANIMATION', 'Character animation is invalid');
          }
          state.profile.characterAnimation = animation;
        }
      }
      state.profile.updatedAt = new Date().toISOString();
      await saveState(state);
      return res.json(state.profile);
    } catch (error) { return fail(res, 400, 'INVALID_PROFILE', error.message); }
  });
  return router;
}

