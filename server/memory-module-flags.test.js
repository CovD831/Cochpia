import test from 'node:test';
import assert from 'node:assert/strict';
import { featureEnabled, resolveMemoryFeatureFlags } from './memory-module-flags.js';

test('memory features are independently disabled by default and can be enabled per flag', () => {
  const flags = resolveMemoryFeatureFlags({}, { autoExtract: true, vectorRetrieval: true });
  assert.equal(flags.autoExtract, true);
  assert.equal(flags.vectorRetrieval, true);
  assert.equal(flags.hybridRetrieval, false);
  assert.equal(featureEnabled(flags, 'autoExtract'), true);
});

test('episodeGrouping is not a feature flag: the extraction pipeline owns its default', () => {
  // AR-209 resolution. This key used to exist here with a default of false,
  // while memory-extraction.js defaulted the same option to true. No live code
  // read the flag (memory-module.js never consults episodeGrouping), so the
  // only thing the second definition could do was mislead a reader into
  // believing episode grouping was off. The option is resolved in exactly one
  // place now, and this pins that.
  const flags = resolveMemoryFeatureFlags({ MEMORY_EPISODE_GROUPING: 'true' });
  assert.equal(
    Object.hasOwn(flags, 'episodeGrouping'),
    false,
    'the flags module must not define episodeGrouping; memory-extraction.js does'
  );
});

test('environment flag names are stable and do not turn unrelated features on', () => {
  const flags = resolveMemoryFeatureFlags({ MEMORY_AUTO_EXTRACT: 'true', MEMORY_VECTOR_RETRIEVAL: '1' });
  assert.equal(flags.autoExtract, true);
  assert.equal(flags.vectorRetrieval, true);
  assert.equal(flags.autoProfileUpdate, false);
});
