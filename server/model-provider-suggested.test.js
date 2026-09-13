import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRESETS, resolveModelConfig } from './model-provider.js';

test('deepseek suggestedModels lists the live gateway model and drops the retired one', () => {
  const suggested = MODEL_PRESETS.deepseek.suggestedModels;
  assert.ok(suggested.includes('Z-deepseek-v4.1-flash'), 'live model must be offered in the UI list');
  assert.ok(!suggested.includes('deepseek-v4-flash'), 'retired model must not be offered (would 400)');
  assert.ok(suggested.includes('deepseek-v4-pro'), 'other entries must be left untouched');
});

test('resolveModelConfig(deepseek) falls back unchanged with no env override', () => {
  const keys = ['MODEL_PROVIDER', 'MODEL_NAME', 'MODEL_API_KEY', 'MODEL_DEEPSEEK_NAME', 'MODEL_DEEPSEEK_API_KEY'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    const config = resolveModelConfig('deepseek');
    assert.equal(config.provider, 'deepseek');
    // No MODEL_DEEPSEEK_NAME override and not the active provider -> empty model, not ready.
    assert.equal(config.model, '');
    assert.equal(config.ready, false);
    assert.match(config.error, /MODEL_DEEPSEEK_API_KEY and MODEL_DEEPSEEK_NAME/);
    // The display list is independent of env and still reflects the live model.
    assert.ok(config.suggestedModels.includes('Z-deepseek-v4.1-flash'));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
