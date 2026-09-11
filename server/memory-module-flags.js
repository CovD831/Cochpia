// Feature flags that gate the *retired* extraction service worker and the
// extraction worker. Deliberately does NOT carry `episodeGrouping`: that option
// belongs to the extraction pipeline, which owns its default
// (memory-extraction.js: MEMORY_EPISODE_GROUPING !== 'false', i.e. on). Keeping
// a second, opposite default here (false) was a shadow definition that no live
// code read -- memory-module.js never consults episodeGrouping -- so it could
// only ever mislead. One option, one default.
export const MEMORY_FEATURE_DEFAULTS = Object.freeze({
  autoExtract: false,
  autoProfileUpdate: false,
  hybridRetrieval: false,
  vectorRetrieval: false,
  proactiveMention: false
});

const flagNames = Object.keys(MEMORY_FEATURE_DEFAULTS);

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function resolveMemoryFeatureFlags(source = process.env, overrides = {}) {
  return Object.fromEntries(flagNames.map(name => {
    const envName = `MEMORY_${name.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
    return [name, parseBoolean(overrides[name] ?? source[envName], MEMORY_FEATURE_DEFAULTS[name])];
  }));
}

export function featureEnabled(flags, name) {
  return Boolean(flags && Object.hasOwn(flags, name) && flags[name] === true);
}
