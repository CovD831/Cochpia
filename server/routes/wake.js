import { Router } from 'express';

const DEFAULT_PREFERENCES = { enabled: false, lambda0PerHour: 1.5 };
const preferencesFor = state => (state.wakePreferences ||= { ...DEFAULT_PREFERENCES });
const normalize = preferences => ({
  enabled: Boolean(preferences.enabled),
  lambda0PerHour: Number.isFinite(Number(preferences.lambda0PerHour))
    ? Math.max(0.1, Math.min(8, Number(preferences.lambda0PerHour)))
    : DEFAULT_PREFERENCES.lambda0PerHour
});

export function createRouter({ state, saveState }) {
  const router = Router();
  router.get('/api/wake', (_, res) => res.json({ wake: normalize(preferencesFor(state)) }));
  router.patch('/api/wake', async (req, res) => {
    const current = preferencesFor(state);
    const next = normalize({
      enabled: req.body?.enabled === undefined ? current.enabled : req.body.enabled,
      lambda0PerHour: req.body?.lambda0PerHour === undefined ? current.lambda0PerHour : req.body.lambda0PerHour
    });
    state.wakePreferences = next;
    await saveState(state);
    res.json({ wake: next });
  });
  return router;
}
