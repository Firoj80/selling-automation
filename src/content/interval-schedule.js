const HOUR = 3600000;
const { publishingEnabled } = require('./publishing-settings');
const isInterval = product => product.schedule?.mode === 'interval';
const intervalMs = product => product.strategy.post_frequency_hours * HOUR;
function lastPublished(state, platform) {
  const posts = state.posts.filter(p => p.platform === platform && p.status === 'published' && p.result?.verified && !p.result.simulated);
  if (posts.some(p => !Number.isFinite(p.publishedAt))) throw new Error(`Missing actual publication time for ${platform}; review publication history before interval posting.`);
  return posts.length ? Math.max(...posts.map(p => p.publishedAt)) : null;
}
function candidates(state, product) {
  const seen = new Set();
  return state.posts.filter(p => p.status === 'pending' && publishingEnabled(product, p.platform, state)).sort((a,b) => (a.scheduledAt || 0) - (b.scheduledAt || 0)).flatMap(post => {
    if (seen.has(post.platform)) return [];
    seen.add(post.platform);
    const last = lastPublished(state, post.platform);
    return [{ post, due: Math.max(last === null ? state.createdAt || 0 : last + intervalMs(product), post.notBefore || 0) }];
  }).sort((a,b) => a.due - b.due);
}
function projectQueue(state, product, now) {
  const next = {};
  const pending = state.posts.filter(p => p.status === 'pending' && publishingEnabled(product, p.platform, state)).sort((a,b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
  for (const post of pending) {
    if (next[post.platform] === undefined) {
      const last = lastPublished(state, post.platform);
      next[post.platform] = Math.max(now, last === null ? now : last + intervalMs(product));
    }
    post.scheduledAt = Math.max(next[post.platform], post.notBefore || 0);
    next[post.platform] = post.scheduledAt + intervalMs(product);
  }
  state.nextPostAt = pending.length ? Math.min(...pending.map(p => p.scheduledAt)) : now;
}
function campaignEnd(product, state) {
  if (!isInterval(product) || product.schedule?.end_date) return state.learning?.endAt ?? Infinity;
  return Infinity;
}
function intervalSlots(product, now, plan, state = { posts: [] }) {
  const next = {};
  return plan.map(a => {
    if (next[a.platform] === undefined) {
      const last = lastPublished(state, a.platform);
      next[a.platform] = Math.max(now, last === null ? now : last + intervalMs(product));
    }
    const time = next[a.platform]; next[a.platform] += intervalMs(product); return time;
  });
}
function resumeIntervalQueue(state, product, now) {
  if (!isInterval(product)) return { status: 'unchanged', duePlatforms: [] };
  const duePlatforms = candidates(state, product).filter(c => c.due <= now).map(c => c.post.platform);
  projectQueue(state, product, now);
  return { status: duePlatforms.length ? 'catch_up' : 'on_schedule', duePlatforms, resumedAt: now, intervalHours: product.strategy.post_frequency_hours };
}
function hasDuePosts(state, product, now) {
  return isInterval(product) && candidates(state, product).some(c => c.due <= now);
}
module.exports = { isInterval, intervalMs, lastPublished, candidates, projectQueue, campaignEnd, intervalSlots, resumeIntervalQueue, hasDuePosts };
