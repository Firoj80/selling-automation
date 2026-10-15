const DEFAULT_TIMES = ['10:30', '13:00', '17:00', '19:00'];
function learningSettings(product) {
  const input = product.learning ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('learning must be an object');
  const platforms = product.strategy.platforms.length;
  const { pilotCounts, scheduleSettings } = require('./campaign-settings');
  const counts = pilotCounts(product), schedule = scheduleSettings(product);
  const settings = { enabled: true, pilot_posts: 20 * platforms, pilot_days: 5, pilot_posts_per_day: 4 * platforms,
    pilot_timezone: 'Asia/Kolkata', pilot_local_times: DEFAULT_TIMES, observation_age_hours: 24,
    observation_window_hours: 6, minimum_mature_posts_per_platform: 6, next_batch_size: 5 * platforms,
    exploration_fraction: 0.2, max_campaign_posts: 180, slot_grace_minutes: 30, ...input };
  const allowed = new Set([...Object.keys(settings).filter(k => !Object.keys(input).includes(k)),
    'enabled', 'pilot_posts', 'pilot_days', 'pilot_posts_per_day', 'pilot_timezone', 'pilot_local_times', 'observation_age_hours',
    'observation_window_hours', 'minimum_mature_posts_per_platform', 'next_batch_size', 'exploration_fraction', 'max_campaign_posts',
    'slot_grace_minutes', 'start_date', 'end_date']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown learning setting: ${key}`);
  if (typeof settings.enabled !== 'boolean') throw new Error('learning.enabled must be boolean');
  if (schedule.timezone !== undefined) settings.pilot_timezone = schedule.timezone;
  if (schedule.local_times !== undefined) settings.pilot_local_times = schedule.local_times;
  for (const key of ['start_date', 'end_date']) if (schedule[key] !== undefined) settings[key] = schedule[key];
  settings.minimum_gap_minutes = schedule.minimum_gap_minutes ?? 30;
  if (settings.next_batch_size !== 5 * platforms || settings.exploration_fraction !== 0.2) throw new Error('Adaptive batches contain 5 posts per platform with 20% exploration');
  for (const [key, min, max] of [['observation_age_hours', 1, 168], ['observation_window_hours', 1, 24], ['minimum_mature_posts_per_platform', 2, 60], ['max_campaign_posts', 20, 500], ['slot_grace_minutes', 1, 60]]) {
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`learning.${key} must be an integer from ${min} to ${max}`);
  }
  try { new Intl.DateTimeFormat('en', { timeZone: settings.pilot_timezone }).format(); } catch { throw new Error('Invalid learning.pilot_timezone'); }
  if (!Array.isArray(settings.pilot_local_times) || !settings.pilot_local_times.length || settings.pilot_local_times.length > 24 || settings.pilot_local_times.some(t => typeof t !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) || new Set(settings.pilot_local_times).size !== settings.pilot_local_times.length) throw new Error('Provide 1 to 24 distinct HH:MM pilot_local_times');
  settings.pilot_local_times = [...settings.pilot_local_times].sort();
  const minutes = settings.pilot_local_times.map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
  if (minutes.some((m, i) => (i ? m - minutes[i - 1] : m + 1440 - minutes.at(-1)) < settings.minimum_gap_minutes)) throw new Error('Posting times violate minimum_gap_minutes');
  const derived = { pilot_posts: Object.values(counts).reduce((a, b) => a + b, 0), pilot_days: Math.ceil(Math.max(...Object.values(counts)) / minutes.length), pilot_posts_per_day: minutes.length * platforms };
  for (const [key, value] of Object.entries(derived)) if (input[key] !== undefined && input[key] !== value && !product.pilot && !product.schedule) throw new Error(`Configure pilot.posts_per_platform and schedule.local_times instead of ${key}`);
  Object.assign(settings, derived, { pilot_counts: counts });
  if (settings.max_campaign_posts < settings.pilot_posts) throw new Error('Campaign cap must include the full pilot');
  for (const key of ['start_date', 'end_date']) if (settings[key] !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(settings[key]) || new Date(settings[key]).toISOString().slice(0, 10) !== settings[key])) throw new Error(`learning.${key} must be a calendar date YYYY-MM-DD`);
  return settings;
}
function writingSettings(product) {
  const input = product.writing ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('writing must be an object');
  for (const key of Object.keys(input)) if (!['humanizer_enabled', 'voice_examples_file', 'preserve_facts', 'forbid_em_dash', 'fallback_policy', 'target_accounts'].includes(key)) throw new Error(`Unknown writing setting: ${key}`);
  const settings = { humanizer_enabled: true, voice_examples_file: 'knowledge/voice.md', preserve_facts: true, forbid_em_dash: true, fallback_policy: 'hold_for_review', ...input };
  if (typeof settings.humanizer_enabled !== 'boolean' || settings.preserve_facts !== true || typeof settings.voice_examples_file !== 'string' || !settings.voice_examples_file.trim()) throw new Error('Invalid writing settings; preserve_facts must remain true');
  if (typeof settings.forbid_em_dash !== 'boolean' || !['hold_for_review', 'validated_original'].includes(settings.fallback_policy)) throw new Error('Invalid Humanizer punctuation or fallback setting');
  return settings;
}
module.exports = { learningSettings, writingSettings };
