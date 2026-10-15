function researchSettings(product) {
  const input = product.research === undefined ? {} : product.research;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('research must be an object');
  const settings = { enabled: false, allow_partial: false, minimum_records_per_platform: 8, minimum_authors_per_platform: 3,
    minimum_discussions_per_platform: 1, max_searches_per_platform_per_run: 6, max_discussions_per_search: 2,
    max_relevance_checks_per_search: 12, freshness_days: 14, ...input };
  const limits = { minimum_records_per_platform: [8, 100], minimum_authors_per_platform: [3, 50], minimum_discussions_per_platform: [0, 50], max_searches_per_platform_per_run: [1, 20], max_discussions_per_search: [0, 5], max_relevance_checks_per_search: [1, 30], freshness_days: [1, 30] };
  for (const key of Object.keys(input)) if (!['enabled', 'allow_partial', ...Object.keys(limits)].includes(key)) throw new Error(`Unknown research setting: ${key}`);
  for (const field of ['enabled', 'allow_partial']) if (typeof settings[field] !== 'boolean') throw new Error(`research.${field} must be boolean`);
  for (const [key, [min, max]] of Object.entries(limits)) if (!Number.isSafeInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`research.${key} must be an integer from ${min} to ${max}`);
  if (settings.minimum_discussions_per_platform > settings.minimum_records_per_platform || settings.minimum_authors_per_platform > settings.minimum_records_per_platform) throw new Error('Research authors/discussions targets cannot exceed the record target');
  return settings;
}
module.exports = { researchSettings };
