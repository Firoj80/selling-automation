const PLATFORMS = ['threads', 'facebook', 'x', 'instagram'];
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}
function keys(value, allowed, name) {
  object(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${name} setting: ${key}`);
}
function sellingSettings(product, platform) {
  const input = product.selling === undefined ? {} : product.selling;
  keys(input, ['defaults', 'platforms'], 'selling');
  const fields = ['minimum_value_posts', 'minimum_views', 'one_product_post_every'];
  const defaults = input.defaults === undefined ? {} : input.defaults;
  const overrides = input.platforms === undefined ? {} : input.platforms;
  keys(overrides, PLATFORMS, 'selling.platforms');
  for (const value of [defaults, ...Object.values(overrides)]) {
    keys(value, fields, 'selling criteria');
    for (const [key, n] of Object.entries(value)) if (!Number.isSafeInteger(n) || n < (key === 'one_product_post_every' ? 2 : 0)) throw new Error(`Invalid selling.${key}`);
  }
  return { minimum_value_posts: product.strategy.value_posts_before_selling,
    minimum_views: product.strategy.view_thresholds_per_platform?.[platform] ?? product.strategy.view_threshold_to_sell,
    one_product_post_every: Number(product.strategy.product_mention_ratio.match(/^1 in (\d+)/)[1]),
    ...input.defaults, ...input.platforms?.[platform] };
}
function pilotCounts(product) {
  const pilot = product.pilot === undefined ? {} : product.pilot;
  keys(pilot, ['posts_per_platform'], 'pilot');
  const counts = pilot.posts_per_platform === undefined ? {} : pilot.posts_per_platform;
  keys(counts, PLATFORMS, 'pilot.posts_per_platform');
  for (const n of Object.values(counts)) if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new Error('Pilot counts must be integers from 1 to 500');
  return Object.fromEntries(product.strategy.platforms.map(p => [p, counts[p] ?? 20]));
}
function scheduleSettings(product) {
  const input = product.schedule === undefined ? {} : product.schedule;
  keys(input, ['mode', 'timezone', 'local_times', 'start_date', 'end_date', 'minimum_gap_minutes', 'overdue_policy'], 'schedule');
  if (input.mode !== undefined && !['calendar', 'interval'].includes(input.mode)) throw new Error('schedule.mode must be calendar or interval');
  if (input.minimum_gap_minutes !== undefined && (!Number.isSafeInteger(input.minimum_gap_minutes) || input.minimum_gap_minutes < 1 || input.minimum_gap_minutes > 1440)) throw new Error('schedule.minimum_gap_minutes must be between 1 and 1440');
  if (input.overdue_policy !== undefined && input.overdue_policy !== 'next_available_slot') throw new Error('Unsupported overdue policy');
  return input;
}
function accountUsername(product, platform) { return product.seller.usernames?.[platform] || product.seller.username; }
module.exports = { sellingSettings, pilotCounts, scheduleSettings, accountUsername };
