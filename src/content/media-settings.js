function mediaSettings(product) {
  const input = product.content_media || {};
  const settings = { enabled: false, max_attempts: 3, retry_minutes: 5, text_only_fallback: false, width: 1080, height: 1080, provider: 'card', image_fallback: 'card', image_timeout_seconds: 240, max_requests_per_day: 24, ...input };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('content_media must be an object');
  for (const key of ['enabled', 'text_only_fallback']) if (typeof settings[key] !== 'boolean') throw new Error(`content_media.${key} must be boolean`);
  if (!['card', 'antigravity'].includes(settings.provider)) throw new Error('content_media.provider must be card or antigravity');
  if (!['card', 'hold'].includes(settings.image_fallback)) throw new Error('content_media.image_fallback must be card or hold');
  for (const [key, min, max] of [['max_attempts', 1, 5], ['retry_minutes', 1, 60], ['width', 600, 2048], ['height', 600, 2048], ['image_timeout_seconds', 30, 600], ['max_requests_per_day', 1, 100]]) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`content_media.${key} must be an integer from ${min} to ${max}`);
  }
  return settings;
}
function rollingSettings(product) {
  const input = product.rolling_content || {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('rolling_content.enabled must be boolean');
  if (input.enabled && product.schedule?.mode !== 'interval') throw new Error('rolling_content requires schedule.mode interval');
  return { enabled: false, ...input };
}
module.exports = { mediaSettings, rollingSettings };
