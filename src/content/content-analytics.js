const { HOUR } = require('./content-calendar');
const { canonicalPostUrl } = require('./post-metrics');
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
function analyzeContent(state, settings, now = Date.now()) {
  const seen = new Set();
  const eligible = [];
  for (const post of state.posts) {
    const url = canonicalPostUrl(post.result?.postUrl, post.platform);
    if (!url || seen.has(url) || post.status !== 'published' || !post.result.verified || post.result.simulated || !post.experimentId || !Number.isFinite(post.publishedAt)) continue;
    seen.add(url);
    const from = post.publishedAt + settings.observation_age_hours * HOUR;
    const to = from + settings.observation_window_hours * HOUR;
    const observation = (post.observations || []).filter(o => o.source === 'browser' && o.postUrl === url && o.observedAt >= from && o.observedAt <= Math.min(to, now) && Number.isSafeInteger(o.views) && o.views >= 0).sort((a, b) => a.observedAt - b.observedAt)[0];
    if (!observation) continue;
    const full = ['likes', 'comments', 'shares'].every(k => Number.isSafeInteger(observation[k]) && observation[k] >= 0);
    eligible.push({ id: post.id, platform: post.platform, type: post.type, topicIndex: post.topicIndex, hookId: post.hookId,
      views: observation.views, observedAt: observation.observedAt, ageHours: (observation.observedAt - post.publishedAt) / HOUR,
      interactionRate: full && observation.views > 0 ? (observation.likes + observation.comments + observation.shares) / observation.views : null });
  }
  const platforms = {};
  for (const platform of new Set(state.posts.map(p => p.platform))) {
    const rows = eligible.filter(p => p.platform === platform && p.type === 'value');
    const topics = [...new Set(rows.map(p => p.topicIndex))].filter(Number.isInteger).map(topicIndex => {
      const topicRows = rows.filter(p => p.topicIndex === topicIndex);
      return { topicIndex, count: topicRows.length, medianViews: median(topicRows.map(p => p.views)),
        medianInteractionRate: median(topicRows.map(p => p.interactionRate).filter(n => n !== null)), evidenceIds: topicRows.map(p => p.id) };
    });
    const candidates = topics.filter(t => t.count >= 2 && t.medianViews > 0).sort((a, b) => b.medianViews - a.medianViews);
    const enough = rows.length >= settings.minimum_mature_posts_per_platform;
    // No declared winner when repeated alternatives have not been observed or are tied.
    const winner = enough && candidates.length >= 2 && candidates[0].medianViews > candidates[1].medianViews ? candidates[0] : null;
    platforms[platform] = { count: rows.length, provisional: true, topics, preferredTopic: winner?.topicIndex ?? null,
      reason: !enough ? 'Insufficient age-matched observations' : !winner ? 'No supported difference between repeated topics' : 'Highest observed median reach among repeated topics; provisional' };
  }
  return { version: 1, generatedAt: now, objective: 'reach', eligible, platforms,
    pilotPublished: state.posts.filter(p => p.batch === 0 && p.status === 'published').length,
    missedSlots: state.posts.filter(p => p.status === 'missed').map(p => p.id) };
}
module.exports = { analyzeContent, median };
